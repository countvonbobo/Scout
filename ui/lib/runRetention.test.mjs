import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  archiveSelectedRuns, assertRunStorageWritable, compactScanQueue, measureRunStorage,
  planRunCleanup,
} from './runRetention.mjs';
import { acquireScanLease, currentLeaseOwner, releaseScanLease } from './scanLease.mjs';
import { enqueueScanRequest, projectScanQueue } from './scanQueue.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-run-retention-'));
  roots.push(root);
  return root;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function terminalRun(root, runId, recordedAt, outcome = 'complete', artifact = 'artifact') {
  const directory = path.join(root, '.scout', 'runs', runId);
  fs.mkdirSync(path.join(directory, 'artifacts'), { recursive: true });
  const payload = { schemaVersion: 1, outcome };
  const event = {
    schemaVersion: 1,
    runId,
    sequence: 1,
    eventId: crypto.randomUUID(),
    type: 'run.completed',
    recordedAt,
    leaseId: 'lease-retention',
    fencingGeneration: 1,
    stageId: 'finalise',
    idempotencyKey: `complete-${runId}`,
    previousHash: null,
    payloadHash: sha256(payload),
    payload,
  };
  event.eventHash = sha256(event);
  fs.writeFileSync(path.join(directory, 'journal.jsonl'), `${stableJson(event)}\n`);
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify({ runId, outcome })}\n`);
  fs.writeFileSync(path.join(directory, 'artifacts', 'result.json'), artifact);
  return directory;
}

function manualRequest(id, requestedAt, expiresAt) {
  return {
    id,
    key: `manual-${id}`,
    requester: 'manual',
    purpose: 'job-discovery',
    requestedAt,
    expiresAt,
    windowAt: null,
    compatibility: {
      schemaVersion: 1,
      profileFingerprint: 'a'.repeat(64),
      configFingerprint: 'b'.repeat(64),
    },
  };
}

test('measures journals, derived artifacts and the queue independently', () => {
  const root = temp();
  terminalRun(root, 'run-one', '2026-01-01T00:00:00.000Z', 'complete', '12345');
  fs.mkdirSync(path.join(root, '.scout'), { recursive: true });
  fs.writeFileSync(path.join(root, '.scout', 'scan-queue.jsonl'), 'queue-bytes\n');

  const measured = measureRunStorage(root);

  assert.equal(measured.runs.count, 1);
  assert.equal(measured.runs.bytes, fs.statSync(path.join(root, '.scout', 'runs', 'run-one', 'journal.jsonl')).size
    + fs.statSync(path.join(root, '.scout', 'runs', 'run-one', 'manifest.json')).size);
  assert.equal(measured.artifacts.bytes, 5);
  assert.equal(measured.queue.bytes, 12);
  assert.equal(measured.totalBytes, measured.runs.bytes + measured.artifacts.bytes + measured.queue.bytes);
});

test('cleanup policy keeps newest twenty, thirty-day history and every recovery-critical run', () => {
  const root = temp();
  for (let index = 0; index < 24; index += 1) {
    terminalRun(root, `complete-${String(index).padStart(2, '0')}`, `2025-03-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`);
  }
  terminalRun(root, 'recent-complete', '2026-01-20T00:00:00.000Z');
  terminalRun(root, 'old-partial', '2024-01-01T00:00:00.000Z', 'partial');
  terminalRun(root, 'old-failed', '2024-01-02T00:00:00.000Z', 'failed');
  fs.mkdirSync(path.join(root, '.scout'), { recursive: true });
  fs.writeFileSync(path.join(root, '.scout', 'recovery-selections.jsonl'), `${JSON.stringify({
    selectedRunId: null,
    skipped: [{ runId: 'complete-02', outcome: 'complete' }],
  })}\n`);

  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'),
    selectedRunIds: ['complete-00', 'complete-02', 'old-partial'],
  });

  assert.equal(plan.candidates.some((candidate) => candidate.runId === 'complete-00'), true);
  assert.equal(plan.candidates.some((candidate) => candidate.runId === 'recent-complete'), false);
  assert.equal(plan.candidates.some((candidate) => candidate.runId === 'old-partial'), false);
  assert.equal(plan.candidates.some((candidate) => candidate.runId === 'old-failed'), false);
  assert.deepEqual(plan.selected.map((candidate) => candidate.runId), ['complete-00']);
  assert.deepEqual(plan.refusedSelections, [
    { runId: 'complete-02', reason: 'recovery-referenced' },
    { runId: 'old-partial', reason: 'recovery-critical' },
  ]);
  assert.equal(plan.compactSummaries.some((summary) => summary.runId === 'complete-00'), true);
  assert.equal(measureRunStorage(root).recoveryCritical.runIds.includes('complete-02'), true);
});

test('unsafe journal pressure fails closed and identifies protected storage', () => {
  const root = temp();
  terminalRun(root, 'partial-private-id', '2024-01-01T00:00:00.000Z', 'partial', 'x'.repeat(64));

  assert.throws(
    () => assertRunStorageWritable(root, {
      maximumBytes: { runs: 1, artifacts: 1, queue: 1 },
      reserveBytes: 1,
    }),
    (error) => error?.code === 'SCOUT_STORAGE_PRESSURE'
      && error.measurement.recoveryCritical.runIds.includes('partial-private-id'),
  );
});

test('reviewed cleanup encrypts and verifies the selected source before fenced deletion', () => {
  const root = temp();
  terminalRun(root, 'old-complete', '2025-03-01T00:00:00.000Z', 'complete', 'PRIVATE-RUN-BODY');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const recoveryDataKey = crypto.randomBytes(32);
  fs.mkdirSync(path.join(root, '.scout'), { recursive: true });
  fs.writeFileSync(path.join(root, '.scout', 'run-retention-index.json'), `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2025-01-01T00:00:00.000Z',
    summaries: [{
      schemaVersion: 1,
      runId: 'expired-summary',
      updatedAt: '2024-01-01T00:00:00.000Z',
      outcome: 'complete',
      completedStages: [],
      recoveryCount: 0,
    }],
  })}\n`);
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'),
    keepNewest: 0,
    selectedRunIds: ['old-complete'],
    recoveryDataKey,
  });

  const result = archiveSelectedRuns(plan, lease);

  assert.equal(fs.existsSync(path.join(root, '.scout', 'runs', 'old-complete')), false);
  assert.equal(fs.existsSync(result.archiveFile), true);
  assert.doesNotMatch(fs.readFileSync(result.archiveFile, 'utf8'), /PRIVATE-RUN-BODY|old-complete/);
  assert.equal(result.archivedRuns, 1);
  assert.equal(JSON.stringify(plan).includes(recoveryDataKey.toString('hex')), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(result.indexFile, 'utf8')).summaries.map((summary) => summary.runId),
    ['old-complete'],
  );
});

test('cleanup without the protected recovery key or with a stale fence deletes nothing', () => {
  const root = temp();
  const directory = terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0, selectedRunIds: ['old-complete'],
  });
  assert.throws(() => archiveSelectedRuns(plan, lease), /protected archive sink/i);
  assert.equal(fs.existsSync(directory), true);

  const keyed = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: crypto.randomBytes(32),
  });
  fs.writeFileSync(path.join(directory, 'artifacts', 'changed.json'), 'changed-after-review');
  assert.throws(() => archiveSelectedRuns(keyed, lease), /changed after review/i);
  assert.equal(fs.existsSync(directory), true);
});

test('cleanup rejects a released stale lease before writing or deleting', () => {
  const root = temp();
  const directory = terminalRun(root, 'old-complete', '2024-01-01T00:00:00.000Z');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-complete'], recoveryDataKey: crypto.randomBytes(32),
  });
  releaseScanLease(lease);

  assert.throws(() => archiveSelectedRuns(plan, lease), /lease/i);
  assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.existsSync(path.join(root, '.scout-backup')), false);
});

test('cleanup rejects selection changes made after operator review', () => {
  const root = temp();
  const first = terminalRun(root, 'old-first', '2024-01-01T00:00:00.000Z');
  const second = terminalRun(root, 'old-second', '2024-01-02T00:00:00.000Z');
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  const plan = planRunCleanup(root, {
    now: new Date('2026-02-01T00:00:00.000Z'), keepNewest: 0,
    selectedRunIds: ['old-first'], recoveryDataKey: crypto.randomBytes(32),
  });
  plan.selected.push(plan.candidates.find((candidate) => candidate.runId === 'old-second'));

  assert.throws(() => archiveSelectedRuns(plan, lease), /reviewed selection changed/i);
  assert.equal(fs.existsSync(first), true);
  assert.equal(fs.existsSync(second), true);
});

test('queue compaction preserves live work and recent terminal evidence idempotently', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'retention-cleanup', provider: 'codex', mode: 'primary', phase: 'finalise',
  });
  enqueueScanRequest(root, {
    ...manualRequest('old-terminal', '2024-01-01T00:00:00.000Z', '2024-01-02T00:00:00.000Z'),
    lease,
  });
  enqueueScanRequest(root, {
    ...manualRequest('live-request', '2026-07-29T00:00:00.000Z', '2026-07-30T00:00:00.000Z'),
    lease,
  });

  const first = compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });
  const bytes = fs.readFileSync(path.join(root, '.scout', 'scan-queue.jsonl'));
  const second = compactScanQueue(root, lease, { now: new Date('2026-07-29T12:00:00.000Z') });

  assert.equal(first.removedEvents > 0, true);
  assert.deepEqual(projectScanQueue(root, new Date('2026-07-29T12:00:00.000Z')).requests.map((item) => item.id), ['live-request']);
  assert.deepEqual(fs.readFileSync(path.join(root, '.scout', 'scan-queue.jsonl')), bytes);
  assert.equal(second.changed, false);
});
