import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { acquireScanLease, currentLeaseOwner, readScanLease, releaseScanLease } from './scanLease.mjs';
import {
  claimNextScanRequest, completeScanRequest, enqueueOverlappingScanRequest, enqueueScanRequest,
  projectScanQueue, recoverOrphanedScanRequest,
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }

test('an overlap enqueue requires the same still-active observed scan and is idempotent after a lost response', () => {
  const root = workspace();
  const activeLease = lease(root, 'active-overlap');
  const { lease: ignored, ...overlap } = request({ id: 'overlap-request', lease: activeLease });
  let observed;
  void ignored;
  try {
    const current = readScanLease(root);
    observed = {
      leaseId: current.leaseId,
      generation: current.generation,
      runId: current.runId,
      operation: current.operation,
    };
    assert.equal(enqueueOverlappingScanRequest(root, { ...overlap, observedLease: observed }).status, 'enqueued');
    assert.equal(enqueueOverlappingScanRequest(root, { ...overlap, observedLease: observed }).status, 'existing');
    assert.deepEqual(projectScanQueue(root).requests.map((item) => [item.id, item.status]), [
      ['overlap-request', 'queued'],
    ]);
  } finally {
    releaseScanLease(activeLease);
  }

  assert.equal(enqueueOverlappingScanRequest(root, {
    ...overlap,
    id: 'too-late',
    key: 'too-late',
    observedLease: {
      leaseId: activeLease.leaseId,
      generation: activeLease.generation,
      runId: activeLease.runId,
      operation: observed.operation,
    },
  }).status, 'not-active');
  fs.rmSync(root, { recursive: true, force: true });
});

test('competing processes serialize overlap enqueues through the workspace guard', async () => {
  const root = workspace();
  const activeLease = lease(root, 'active-process-overlap');
  const current = readScanLease(root);
  const observedLease = {
    leaseId: current.leaseId,
    generation: current.generation,
    runId: current.runId,
    operation: current.operation,
  };
  const moduleUrl = new URL('./scanQueue.mjs', import.meta.url).href;
  const contender = `
    import { enqueueOverlappingScanRequest } from ${JSON.stringify(moduleUrl)};
    const result = enqueueOverlappingScanRequest(
      process.env.SCOUT_QUEUE_ROOT,
      JSON.parse(process.env.SCOUT_QUEUE_REQUEST)
    );
    process.stdout.write(result.status);
  `;
  try {
    const statuses = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const { lease: ignored, ...base } = request({
        id: `process-overlap-${index}`,
        key: `process-overlap-${index}`,
        lease: activeLease,
      });
      void ignored;
      const child = spawn(process.execPath, ['--input-type=module', '--eval', contender], {
        env: {
          ...process.env,
          SCOUT_QUEUE_ROOT: root,
          SCOUT_QUEUE_REQUEST: JSON.stringify({ ...base, observedLease }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`overlap contender failed (${code}): ${stderr}`));
      });
    })));

    assert.deepEqual(statuses, ['enqueued', 'enqueued', 'enqueued', 'enqueued']);
    assert.deepEqual(
      projectScanQueue(root).requests.map((item) => item.id).sort(),
      ['process-overlap-0', 'process-overlap-1', 'process-overlap-2', 'process-overlap-3'],
    );
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    completeScanRequest(root, claimed.id, 'succeeded', firstLease, claimed.claim);
  } finally { releaseScanLease(firstLease); }

  const secondLease = lease(root, 'second-run');
  try {
    const claimed = claimNextScanRequest(root, compatibility, secondLease, new Date('2026-07-27T08:31:00.000Z'));
    assert.equal(claimed.id, 'manual-second');
    completeScanRequest(root, claimed.id, 'succeeded', secondLease, claimed.claim);
  } finally { releaseScanLease(secondLease); }

  const scheduledLease = lease(root, 'scheduled-run');
  try {
    const claimed = claimNextScanRequest(root, compatibility, scheduledLease, new Date('2026-07-27T08:32:00.000Z'));
    assert.equal(claimed.id, 'scheduled-covered');
    completeScanRequest(root, claimed.id, 'succeeded', scheduledLease, claimed.claim);
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

test('claim retries return one durable lease-bound claim and completion retries acknowledge only its outcome', () => {
  const root = workspace();
  const enqueueLease = lease(root, 'enqueue-claims');
  try {
    enqueueScanRequest(root, request({ id: 'claim-first', lease: enqueueLease }));
    enqueueScanRequest(root, request({ id: 'claim-second', requestedAt: '2026-07-27T08:01:00.000Z', expiresAt: '2026-07-28T08:01:00.000Z', lease: enqueueLease }));
  } finally { releaseScanLease(enqueueLease); }
  const activeLease = lease(root, 'claim-owner');
  try {
    const first = claimNextScanRequest(root, compatibility, activeLease, new Date('2026-07-27T08:30:00.000Z'));
    const retry = claimNextScanRequest(root, compatibility, activeLease, new Date('2026-07-27T08:31:00.000Z'));
    assert.equal(first.id, 'claim-first');
    assert.equal(retry.claim.claimId, first.claim.claimId);
    assert.equal(projectScanQueue(root).requests.find((item) => item.id === 'claim-second').status, 'queued');
    assert.equal(completeScanRequest(root, first.id, 'succeeded', activeLease, first.claim).status, 'succeeded');
    assert.equal(completeScanRequest(root, first.id, 'succeeded', activeLease, first.claim).status, 'succeeded');
    assert.throws(() => completeScanRequest(root, first.id, 'failed', activeLease, first.claim), /conflict|outcome/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a successor cannot complete an orphaned claim and must recover it under its own fence', () => {
  const root = workspace();
  const enqueueLease = lease(root, 'enqueue-orphan');
  try { enqueueScanRequest(root, request({ id: 'orphaned', lease: enqueueLease })); }
  finally { releaseScanLease(enqueueLease); }
  const firstLease = lease(root, 'orphan-owner');
  const first = claimNextScanRequest(root, compatibility, firstLease, new Date('2026-07-27T08:30:00.000Z'));
  releaseScanLease(firstLease);
  const successor = lease(root, 'orphan-successor');
  try {
    assert.throws(() => completeScanRequest(root, first.id, 'succeeded', successor, first.claim), /claim|owner|fence/i);
    assert.throws(() => claimNextScanRequest(root, compatibility, successor, new Date('2026-07-27T08:31:00.000Z')), /recover/i);
    assert.equal(recoverOrphanedScanRequest(root, first.id, first.claim, successor).status, 'queued');
    const recovered = claimNextScanRequest(root, compatibility, successor, new Date('2026-07-27T08:32:00.000Z'));
    assert.equal(recovered.id, first.id);
  } finally {
    releaseScanLease(successor);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful-window coverage requires the full compatibility contract', () => {
  const root = workspace();
  const firstLease = lease(root, 'window-old');
  const oldCompatibility = { ...compatibility, profileFingerprint: 'c'.repeat(64) };
  try {
    enqueueScanRequest(root, request({ id: 'old-window', requester: 'scheduled', key: 'old-window', windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z', requestCompatibility: { profileFingerprint: oldCompatibility.profileFingerprint, configFingerprint: config, schemaVersion: 1 }, lease: firstLease }));
    const claimed = claimNextScanRequest(root, oldCompatibility, firstLease, new Date('2026-07-27T08:30:00.000Z'));
    completeScanRequest(root, claimed.id, 'succeeded', firstLease, claimed.claim);
  } finally { releaseScanLease(firstLease); }
  const nextLease = lease(root, 'window-new');
  try {
    enqueueScanRequest(root, request({ id: 'new-window', requester: 'scheduled', key: 'new-window', windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z', lease: nextLease }));
    assert.equal(claimNextScanRequest(root, compatibility, nextLease, new Date('2026-07-27T08:31:00.000Z')).id, 'new-window');
  } finally {
    releaseScanLease(nextLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stable request IDs reject conflicting retries and replay rejects duplicate event IDs or invalid equivalence transitions', () => {
  const root = workspace();
  const activeLease = lease(root, 'replay-invariants');
  try {
    enqueueScanRequest(root, request({ id: 'canonical', key: 'same-work', lease: activeLease }));
    assert.throws(() => enqueueScanRequest(root, request({ id: 'canonical', key: 'changed-work', lease: activeLease })), /conflict/i);
    enqueueScanRequest(root, request({ id: 'deduped', key: 'same-work', lease: activeLease }));
    assert.throws(() => enqueueScanRequest(root, request({ id: 'deduped', key: 'changed-work', lease: activeLease })), /conflict/i);
    const file = path.join(root, '.scout', 'scan-queue.jsonl');
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    fs.appendFileSync(file, `${JSON.stringify({ ...events[0], type: 'enqueue', request: { ...events[0].request, id: 'reused-event' } })}\n`, 'utf8');
    assert.throws(() => projectScanQueue(root), /event ID|invalid/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replay rejects an older scheduled replacement and a deduplication into a terminal request', () => {
  const root = workspace();
  const activeLease = lease(root, 'replay-transitions');
  try {
    enqueueScanRequest(root, request({ id: 'scheduled-first', requester: 'scheduled', key: 'same-schedule', windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z', lease: activeLease }));
    enqueueScanRequest(root, request({ id: 'scheduled-newer', requester: 'scheduled', key: 'same-schedule', requestedAt: '2026-07-27T08:30:00.000Z', windowAt: '2026-07-27T10:00:00.000Z', expiresAt: '2026-07-27T10:00:00.000Z', lease: activeLease }));
    const file = path.join(root, '.scout', 'scan-queue.jsonl');
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const replacement = events.find((event) => event.type === 'scheduled-replaced');
    replacement.request = { ...replacement.request, requestedAt: '2026-07-27T07:59:00.000Z', windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z' };
    replacement.requestDigest = digest(replacement.request);
    fs.writeFileSync(file, `${events.map(JSON.stringify).join('\n')}\n`, 'utf8');
    assert.throws(() => projectScanQueue(root), /scheduled replacement/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }

  const secondRoot = workspace();
  const secondLease = lease(secondRoot, 'terminal-dedup');
  try {
    enqueueScanRequest(secondRoot, request({ id: 'terminal-target', key: 'dedup-key', lease: secondLease }));
    const claimed = claimNextScanRequest(secondRoot, compatibility, secondLease, new Date('2026-07-27T08:30:00.000Z'));
    completeScanRequest(secondRoot, claimed.id, 'succeeded', secondLease, claimed.claim);
    const file = path.join(secondRoot, '.scout', 'scan-queue.jsonl');
    const incoming = request({ id: 'terminal-alias', key: 'dedup-key', lease: secondLease });
    const { lease: ignored, ...requestOnly } = incoming;
    void ignored;
    fs.appendFileSync(file, `${JSON.stringify({ schemaVersion: 2, eventId: '11111111-1111-4111-8111-111111111111', type: 'deduplicated', at: '2026-07-27T08:31:00.000Z', request: requestOnly, requestDigest: digest(requestOnly), requestId: 'terminal-target' })}\n`, 'utf8');
    assert.throws(() => projectScanQueue(secondRoot), /deduplication/i);
  } finally {
    releaseScanLease(secondLease);
    fs.rmSync(secondRoot, { recursive: true, force: true });
  }
});

test('equivalence never aliases a request with a changed compatibility contract', () => {
  const root = workspace();
  const activeLease = lease(root, 'compatibility-equivalence');
  const changed = { profileFingerprint: 'c'.repeat(64), configFingerprint: config, schemaVersion: 1 };
  try {
    enqueueScanRequest(root, request({ id: 'old-contract', key: 'same-key', lease: activeLease }));
    assert.equal(enqueueScanRequest(root, request({ id: 'new-contract', key: 'same-key', requestCompatibility: changed, lease: activeLease })).status, 'enqueued');
    const current = { ...compatibility, profileFingerprint: changed.profileFingerprint };
    assert.equal(claimNextScanRequest(root, current, activeLease, new Date('2026-07-27T08:30:00.000Z')).id, 'new-contract');
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replays a version-one journal and preserves queued work when version-two events are appended', () => {
  const root = workspace();
  const activeLease = lease(root, 'queue-v1-compat');
  try {
    const { lease: ignored, ...legacyRequest } = request({ id: 'legacy-queued', lease: activeLease });
    void ignored;
    const file = path.join(root, '.scout', 'scan-queue.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, eventId: '11111111-1111-4111-8111-111111111111', type: 'enqueue', at: '2026-07-27T08:00:00.000Z', request: legacyRequest })}\n`, 'utf8');
    assert.deepEqual(projectScanQueue(root).ready.map((item) => item.id), ['legacy-queued']);
    enqueueScanRequest(root, request({ id: 'version-two-queued', key: 'next-key', lease: activeLease }));
    assert.deepEqual(projectScanQueue(root).ready.map((item) => item.id), ['legacy-queued', 'version-two-queued']);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('version-one replay rejects schema-three execution metadata', () => {
  const root = workspace();
  const activeLease = lease(root, 'v1-execution-rejection');
  try {
    const { lease: ignored, ...legacyRequest } = request({ id: 'v1-hostile-execution', lease: activeLease });
    void ignored;
    legacyRequest.execution = {
      schemaVersion: 1,
      provider: 'codex',
      mode: 'primary',
      model: null,
    };
    const file = path.join(root, '.scout', 'scan-queue.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      type: 'enqueue',
      at: '2026-07-27T08:00:00.000Z',
      request: legacyRequest,
    })}\n`, 'utf8');
    assert.throws(() => projectScanQueue(root), /legacy.*execution|unsupported execution/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replays a valid cross-compatibility version-one scheduled replacement before v2 append and claim', () => {
  const root = workspace();
  const activeLease = lease(root, 'queue-v1-replacement');
  const oldProfile = 'c'.repeat(64);
  try {
    const { lease: firstLease, ...first } = request({ id: 'v1-scheduled-old', requester: 'scheduled', key: 'v1-schedule', windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z', requestCompatibility: { profileFingerprint: oldProfile, configFingerprint: config, schemaVersion: 1 }, lease: activeLease });
    const { lease: secondLease, ...second } = request({ id: 'v1-scheduled-new', requester: 'scheduled', key: 'v1-schedule', requestedAt: '2026-07-27T08:30:00.000Z', windowAt: '2026-07-27T10:00:00.000Z', expiresAt: '2026-07-27T10:00:00.000Z', lease: activeLease });
    void firstLease; void secondLease;
    const file = path.join(root, '.scout', 'scan-queue.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, eventId: '11111111-1111-4111-8111-111111111111', type: 'enqueue', at: '2026-07-27T08:00:00.000Z', request: first })}\n${JSON.stringify({ schemaVersion: 1, eventId: '22222222-2222-4222-8222-222222222222', type: 'scheduled-replaced', at: '2026-07-27T08:30:00.000Z', request: second, supersededRequestId: first.id })}\n`, 'utf8');
    assert.deepEqual(projectScanQueue(root).ready.map((item) => item.id), ['v1-scheduled-new']);
    enqueueScanRequest(root, request({ id: 'v2-manual', key: 'v2-manual', lease: activeLease }));
    assert.equal(claimNextScanRequest(root, compatibility, activeLease, new Date('2026-07-27T08:31:00.000Z')).id, 'v2-manual');
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('claims accept the reviewed scan-lease token grammar for lease IDs', () => {
  const root = workspace();
  const activeLease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'token-lease', provider: 'codex', mode: 'primary', phase: 'queue',
  }, { leaseId: 'queue.lease:1' });
  try {
    enqueueScanRequest(root, request({ id: 'token-request', lease: activeLease }));
    assert.equal(claimNextScanRequest(root, compatibility, activeLease, new Date('2026-07-27T08:30:00.000Z')).claim.leaseId, 'queue.lease:1');
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replay rejects a claim ID reused by a successor after recovery', () => {
  const root = workspace();
  const activeLease = lease(root, 'claim-id-replay');
  try {
    enqueueScanRequest(root, request({ id: 'claim-id-target', lease: activeLease }));
    const claimed = claimNextScanRequest(root, compatibility, activeLease, new Date('2026-07-27T08:30:00.000Z'));
    const file = path.join(root, '.scout', 'scan-queue.jsonl');
    fs.appendFileSync(file, `${JSON.stringify({ schemaVersion: 2, eventId: '11111111-1111-4111-8111-111111111111', type: 'claim-recovered', at: '2026-07-27T08:31:00.000Z', requestId: claimed.id, claimId: claimed.claim.claimId })}\n`, 'utf8');
    fs.appendFileSync(file, `${JSON.stringify({ schemaVersion: 2, eventId: '22222222-2222-4222-8222-222222222222', type: 'claimed', at: '2026-07-27T08:32:00.000Z', requestId: claimed.id, claim: claimed.claim })}\n`, 'utf8');
    assert.throws(() => projectScanQueue(root), /claim ID/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a legacy claimed request blocks automatic draining until an operator resolves the legacy claim', () => {
  const root = workspace();
  const activeLease = lease(root, 'legacy-claim-block');
  try {
    const { lease: ignored, ...legacyRequest } = request({ id: 'legacy-active', lease: activeLease });
    void ignored;
    const file = path.join(root, '.scout', 'scan-queue.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, eventId: '11111111-1111-4111-8111-111111111111', type: 'enqueue', at: '2026-07-27T08:00:00.000Z', request: legacyRequest })}\n${JSON.stringify({ schemaVersion: 1, eventId: '22222222-2222-4222-8222-222222222222', type: 'claimed', at: '2026-07-27T08:01:00.000Z', requestId: 'legacy-active' })}\n`, 'utf8');
    assert.throws(() => claimNextScanRequest(root, compatibility, activeLease, new Date('2026-07-27T08:30:00.000Z')), /legacy.*claim|operator/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replay rejects a scheduled replacement whose newer request changes the execution contract', () => {
  const root = workspace();
  const activeLease = lease(root, 'replacement-contract');
  try {
    enqueueScanRequest(root, request({ id: 'scheduled-contract-old', requester: 'scheduled', key: 'contract-key', windowAt: '2026-07-27T09:00:00.000Z', expiresAt: '2026-07-27T09:00:00.000Z', lease: activeLease }));
    enqueueScanRequest(root, request({ id: 'scheduled-contract-new', requester: 'scheduled', key: 'contract-key', requestedAt: '2026-07-27T08:30:00.000Z', windowAt: '2026-07-27T10:00:00.000Z', expiresAt: '2026-07-27T10:00:00.000Z', lease: activeLease }));
    const file = path.join(root, '.scout', 'scan-queue.jsonl');
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const replacement = events.find((event) => event.type === 'scheduled-replaced');
    replacement.request = { ...replacement.request, purpose: 'different-purpose' };
    replacement.requestDigest = digest(replacement.request);
    fs.writeFileSync(file, `${events.map(JSON.stringify).join('\n')}\n`, 'utf8');
    assert.throws(() => projectScanQueue(root), /scheduled replacement/i);
  } finally {
    releaseScanLease(activeLease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
