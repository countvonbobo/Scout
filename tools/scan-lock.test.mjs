import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { acquireScanLock, readScanLock, releaseScanLock } from './scan-lock.mjs';
import {
  acquireScanLease, currentLeaseOwner, releaseScanLease, renewScanLease,
} from '../ui/lib/scanLease.mjs';

const dirs = [];
function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-lock-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

test('scan lock acquires atomically and requires its token to release', () => {
  const repo = tempRepo();
  const first = acquireScanLock(repo, { agent: 'codex', mode: 'primary', token: 'one' });
  assert.equal(first.ok, true);
  assert.equal(fs.existsSync(path.join(repo, '.scout', 'scan-lease.json')), true);
  assert.equal(acquireScanLock(repo, { agent: 'claude', mode: 'second-pass', token: 'two' }).ok, false);
  assert.equal(releaseScanLock(repo, 'wrong').ok, false);
  assert.deepEqual(releaseScanLock(repo, 'one'), { ok: true, released: true });
  assert.equal(readScanLock(repo), null);
});

test('scan lock recovers a lock older than two hours', () => {
  const repo = tempRepo();
  acquireScanLock(repo, {
    agent: 'codex', mode: 'primary', token: 'old', now: new Date('2026-07-10T03:00:00Z'),
  });
  const next = acquireScanLock(repo, {
    agent: 'claude', mode: 'second-pass', token: 'new', now: new Date('2026-07-10T06:00:01Z'),
  });
  assert.equal(next.ok, true);
  assert.equal(next.recoveredStale, true);
  assert.equal(readScanLock(repo).token, 'new');
});

test('legacy status preserves durable acquisition time after sentinel refresh', () => {
  const repo = tempRepo();
  let wall = Date.parse('2026-07-27T10:00:00.000Z');
  let monotonic = 0;
  const lease = acquireScanLease(repo, currentLeaseOwner(), {
    kind: 'scan', runId: 'run-status', provider: 'codex', mode: 'primary', phase: 'collect',
  }, {
    wallNow: () => wall, monotonicNow: () => monotonic, leaseDurationMs: 3 * 60 * 60 * 1000,
  });
  wall += 60 * 60 * 1000;
  monotonic += 60 * 60 * 1000;
  renewScanLease(lease);
  assert.equal(readScanLock(repo).startedAt, '2026-07-27T10:00:00.000Z');
  releaseScanLease(lease);
});
