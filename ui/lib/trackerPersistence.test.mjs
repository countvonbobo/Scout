import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { serializeTracker } from './tracker.mjs';
import {
  acquireTrackerMutationLock, atomicReplaceTracker, mutateTrackerSnapshot,
  embedTrackerMutationMarker, readTrackerMutationMarker, readTrackerSnapshot,
  releaseTrackerMutationLock, TrackerRevisionConflictError,
} from './trackerPersistence.mjs';

const temporaryDirectories = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-tracker-persistence-'));
  temporaryDirectories.push(root);
  const file = path.join(root, 'opportunities.json');
  fs.writeFileSync(file, serializeTracker({
    updated: '2026-07-22',
    opportunities: [{ id: 'example-role-2026-07', company: 'Example', role: 'Role', status: 'new' }],
  }));
  return { root, file };
}

afterEach(() => {
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

test('tracker snapshots expose revisions and atomically replace complete JSON', () => {
  const { file } = fixture();
  const first = readTrackerSnapshot(file);
  const next = structuredClone(first.data);
  next.opportunities[0].score = 91;
  atomicReplaceTracker(file, serializeTracker(next));
  const second = readTrackerSnapshot(file);
  assert.notEqual(second.revision, first.revision);
  assert.equal(second.data.opportunities[0].score, 91);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['opportunities.json']);
});

test('tracker mutations reject a stale revision without changing the file', () => {
  const { file } = fixture();
  const first = readTrackerSnapshot(file);
  const scanned = structuredClone(first.data);
  scanned.opportunities[0].score = 88;
  atomicReplaceTracker(file, serializeTracker(scanned));
  assert.throws(
    () => mutateTrackerSnapshot(file, (data) => data, serializeTracker, { expectedRevision: first.revision }),
    TrackerRevisionConflictError,
  );
  assert.equal(readTrackerSnapshot(file).data.opportunities[0].score, 88);
});

test('UI tracker lock waits for and then shares the scan coordination lock', async () => {
  const { root } = fixture();
  const first = await acquireTrackerMutationLock(root, { token: 'first' });
  assert.equal(first.token, 'first');
  const waiting = acquireTrackerMutationLock(root, { token: 'second', timeoutMs: 500, pollMs: 5 });
  setTimeout(() => releaseTrackerMutationLock(root, first.token), 25);
  const second = await waiting;
  assert.equal(second.token, 'second');
  assert.deepEqual(releaseTrackerMutationLock(root, second.token), { ok: true, released: true });
});

test('mutateTrackerSnapshot refuses to write unparseable content and leaves the existing file byte-identical', () => {
  const { file } = fixture();
  const initialBytes = fs.readFileSync(file);
  assert.throws(
    () => mutateTrackerSnapshot(file, (data) => data, () => '{ bad json', {}),
    SyntaxError
  );
  assert.deepEqual(fs.readFileSync(file), initialBytes);
});

test('end-to-end regression: mutating a tracker with missing updated field preserves data', () => {
  const { file } = fixture();
  // Write a tracker with missing updated field but valid JSON (as the agent-driven scan might produce)
  const validButMissingUpdated = `{ "opportunities": [{ "id": "incident-test", "company": "Missing Updated", "role": "Role", "status": "new" }] }`;
  atomicReplaceTracker(file, validButMissingUpdated);
  
  mutateTrackerSnapshot(file, (data) => {
    data.opportunities[0].status = 'ignore';
    return data;
  }, serializeTracker);
  
  const finalState = readTrackerSnapshot(file);
  assert.equal(finalState.data.opportunities[0].status, 'ignore');
  assert.equal(finalState.data.opportunities[0].id, 'incident-test');
});

test('tracker mutation markers remain verifiable but are hidden from tracker consumers', () => {
  const { file } = fixture();
  const marker = {
    schemaVersion: 1,
    mutationId: 'mutation-123',
    mutationKey: 'a'.repeat(64),
    runKey: 'b'.repeat(64),
    intendedDigest: 'c'.repeat(64),
  };
  const marked = embedTrackerMutationMarker(fs.readFileSync(file, 'utf8'), marker);
  fs.writeFileSync(file, marked);

  assert.deepEqual(readTrackerMutationMarker(marked), marker);
  assert.equal(Object.hasOwn(readTrackerSnapshot(file).data, '_scoutMutation'), false);
  assert.equal(readTrackerSnapshot(file).data.opportunities[0].id, 'example-role-2026-07');
});
