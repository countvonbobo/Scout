import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { acquireScanLease, currentLeaseOwner, releaseScanLease } from './scanLease.mjs';
import {
  claimNextScanRequest, completeScanRequest, enqueueScanRequest, projectScanQueue,
} from './scanQueue.mjs';

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scout-scan-queue-'));
}

function lease(root, runId = 'queue-control') {
  return acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId, provider: 'codex', mode: 'primary', phase: 'queue',
  });
}

const profile = 'a'.repeat(64);
const config = 'b'.repeat(64);
const compatibility = Object.freeze({
  profileFingerprint: profile, configFingerprint: config, purpose: 'daily-scan', schemaVersion: 1,
});

function request({
  id, key = id, requester = 'manual', requestedAt = '2026-07-27T08:00:00.000Z',
  expiresAt = '2026-07-28T08:00:00.000Z', windowAt = null, purpose = 'daily-scan', requestCompatibility = null, lease: activeLease,
} = {}) {
  return {
    id, key, requester, purpose,
    compatibility: requestCompatibility || { profileFingerprint: profile, configFingerprint: config, schemaVersion: 1 },
    requestedAt, expiresAt, windowAt, lease: activeLease,
  };
}

test('manual requests retain FIFO order and expire exactly 24 hours after request time', () => {
  const root = workspace();
  const activeLease = lease(root);
  try {
    enqueueScanRequest(root, request({ id: 'manual-first', requestedAt: '2026-07-27T08:00:00.000Z', expiresAt: '2026-07-28T08:00:00.000Z', lease: activeLease }));
    enqueueScanRequest(root, request({ id: 'manual-second', requestedAt: '2026-07-27T08:01:00.000Z', expiresAt: '2026-07-28T08:01:00.000Z', lease: activeLease }));
    assert.deepEqual(projectScanQueue(root, new Date('2026-07-27T10:00:00.000Z')).ready.map((item) => item.id), ['manual-first', 'manual-second']);
    assert.throws(() => enqueueScanRequest(root, request({ id: 'bad-manual-expiry', expiresAt: '2026-07-28T08:00:01.000Z', lease: activeLease })), /24 hours/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('equivalent manual requests append an auditable deduplication event without another queue entry', () => {
  const root = workspace();
  const activeLease = lease(root);
  try {
    enqueueScanRequest(root, request({ id: 'manual-original', key: 'same-work', lease: activeLease }));
    const result = enqueueScanRequest(root, request({ id: 'manual-duplicate', key: 'same-work', lease: activeLease }));
    assert.equal(result.status, 'deduplicated');
    assert.equal(enqueueScanRequest(root, request({ id: 'manual-duplicate', key: 'same-work', lease: activeLease })).status, 'deduplicated');
    assert.deepEqual(projectScanQueue(root, new Date('2026-07-27T09:00:00.000Z')).ready.map((item) => item.id), ['manual-original']);
    const events = fs.readFileSync(path.join(root, '.scout', 'scan-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map((event) => event.type), ['enqueue', 'deduplicated']);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('newest equivalent scheduled request supersedes the older request and expires at the earlier next window or 12-hour limit', () => {
  const root = workspace();
  const activeLease = lease(root);
  try {
    enqueueScanRequest(root, request({ id: 'manual-same-key', key: 'morning-primary', lease: activeLease }));
    enqueueScanRequest(root, request({
      id: 'scheduled-old', key: 'morning-primary', requester: 'scheduled', windowAt: '2026-07-27T09:00:00.000Z',
      expiresAt: '2026-07-27T09:00:00.000Z', lease: activeLease,
    }));
    enqueueScanRequest(root, request({
      id: 'scheduled-new', key: 'morning-primary', requester: 'scheduled', requestedAt: '2026-07-27T08:30:00.000Z',
      windowAt: '2026-07-27T10:00:00.000Z', expiresAt: '2026-07-27T10:00:00.000Z', lease: activeLease,
    }));
    assert.equal(enqueueScanRequest(root, request({
      id: 'scheduled-new', key: 'morning-primary', requester: 'scheduled', requestedAt: '2026-07-27T08:30:00.000Z',
      windowAt: '2026-07-27T10:00:00.000Z', expiresAt: '2026-07-27T10:00:00.000Z', lease: activeLease,
    })).status, 'existing');
    assert.deepEqual(projectScanQueue(root, new Date('2026-07-27T08:45:00.000Z')).ready.map((item) => item.id), ['manual-same-key', 'scheduled-new']);
    const events = fs.readFileSync(path.join(root, '.scout', 'scan-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'scheduled-replaced');
    assert.equal(enqueueScanRequest(root, request({
      id: 'scheduled-delayed-old', key: 'morning-primary', requester: 'scheduled', requestedAt: '2026-07-27T08:00:00.000Z',
      windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z', lease: activeLease,
    })).status, 'deduplicated');
    assert.deepEqual(projectScanQueue(root, new Date('2026-07-27T08:45:00.000Z')).ready.map((item) => item.id), ['manual-same-key', 'scheduled-new']);
    assert.throws(() => enqueueScanRequest(root, request({
      id: 'scheduled-too-late', requester: 'scheduled', windowAt: '2026-07-28T21:00:00.000Z',
      expiresAt: '2026-07-28T21:00:00.000Z', lease: activeLease,
    })), /12 hours/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('claim rejects expired or stale profile, configuration, purpose and schema requests with durable terminal events', () => {
  const cases = [
    ['expired', request({ id: 'expired', requestedAt: '2026-07-26T08:00:00.000Z', expiresAt: '2026-07-27T08:00:00.000Z' }), compatibility, 'expired'],
    ['profile', request({ id: 'stale-profile', requestCompatibility: { profileFingerprint: 'c'.repeat(64), configFingerprint: config, schemaVersion: 1 } }), compatibility, 'stale'],
    ['config', request({ id: 'stale-config', requestCompatibility: { profileFingerprint: profile, configFingerprint: 'c'.repeat(64), schemaVersion: 1 } }), compatibility, 'stale'],
    ['purpose', request({ id: 'stale-purpose', purpose: 'different-purpose' }), compatibility, 'stale'],
    ['schema', request({ id: 'stale-schema', requestCompatibility: { profileFingerprint: profile, configFingerprint: config, schemaVersion: 2 } }), compatibility, 'stale'],
  ];
  for (const [label, queued, current, terminal] of cases) {
    const root = workspace();
    const enqueueLease = lease(root, `enqueue-${label}`);
    try { enqueueScanRequest(root, { ...queued, lease: enqueueLease }); }
    finally { releaseScanLease(enqueueLease); }
    const claimLease = lease(root, `claim-${label}`);
    try {
      assert.equal(claimNextScanRequest(root, current, claimLease, new Date('2026-07-27T09:00:00.000Z')), null);
      const events = fs.readFileSync(path.join(root, '.scout', 'scan-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).type, terminal);
    } finally {
      releaseScanLease(claimLease);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('completed scheduling window is skipped and terminal release drains the next manual request under a new fence', () => {
  const root = workspace();
  const enqueueLease = lease(root);
  try {
    enqueueScanRequest(root, request({ id: 'scheduled-covered', key: 'covered', requester: 'scheduled', windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z', lease: enqueueLease }));
    enqueueScanRequest(root, request({ id: 'manual-first', key: 'manual-first', lease: enqueueLease }));
    enqueueScanRequest(root, request({ id: 'manual-second', key: 'manual-second', requestedAt: '2026-07-27T08:01:00.000Z', expiresAt: '2026-07-28T08:01:00.000Z', lease: enqueueLease }));
  } finally { releaseScanLease(enqueueLease); }

  const firstLease = lease(root, 'first-run');
  try {
    const claimed = claimNextScanRequest(root, compatibility, firstLease, new Date('2026-07-27T08:30:00.000Z'));
    assert.equal(claimed.id, 'manual-first');
    completeScanRequest(root, claimed.id, 'succeeded', firstLease);
  } finally { releaseScanLease(firstLease); }

  const secondLease = lease(root, 'second-run');
  try {
    const claimed = claimNextScanRequest(root, compatibility, secondLease, new Date('2026-07-27T08:31:00.000Z'));
    assert.equal(claimed.id, 'manual-second');
    completeScanRequest(root, claimed.id, 'succeeded', secondLease);
  } finally { releaseScanLease(secondLease); }

  const scheduledLease = lease(root, 'scheduled-run');
  try {
    const claimed = claimNextScanRequest(root, compatibility, scheduledLease, new Date('2026-07-27T08:32:00.000Z'));
    assert.equal(claimed.id, 'scheduled-covered');
    completeScanRequest(root, claimed.id, 'succeeded', scheduledLease);
  } finally { releaseScanLease(scheduledLease); }

  const duplicateLease = lease(root, 'duplicate-window');
  try {
    enqueueScanRequest(root, request({ id: 'scheduled-duplicate-window', key: 'different-key', requester: 'scheduled', windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z', lease: duplicateLease }));
    assert.equal(claimNextScanRequest(root, compatibility, duplicateLease, new Date('2026-07-27T08:40:00.000Z')), null);
    assert.equal(projectScanQueue(root, new Date('2026-07-27T08:40:00.000Z')).requests.find((item) => item.id === 'scheduled-duplicate-window').status, 'skipped');
  } finally {
    releaseScanLease(duplicateLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('queue writes require the genuine lease for the same workspace and reject stale fences', () => {
  const root = workspace();
  const other = workspace();
  const activeLease = lease(root);
  try {
    assert.throws(() => enqueueScanRequest(other, request({ id: 'cross-workspace', lease: activeLease })), /workspace|lease/i);
    assert.throws(() => enqueueScanRequest(root, request({ id: 'plain-lease', lease: { ...activeLease } })), /acquired in this process|lease/i);
    releaseScanLease(activeLease);
    const successor = lease(root, 'queue-successor');
    try {
      assert.throws(() => enqueueScanRequest(root, request({ id: 'stale-fence', lease: activeLease })), /current|lease/i);
    } finally { releaseScanLease(successor); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
