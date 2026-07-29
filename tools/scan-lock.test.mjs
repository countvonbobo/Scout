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

test('scan lock refuses an expired ownerless legacy lock with migration instructions', () => {
  const repo = tempRepo();
  const file = path.join(repo, '.scout-scan.lock');
  fs.writeFileSync(file, `${JSON.stringify({
    agent: 'codex',
    mode: 'primary',
    token: 'old',
    startedAt: '2026-07-10T03:00:00.000Z',
  })}\n`, 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  const next = acquireScanLock(repo, {
    agent: 'claude', mode: 'second-pass', token: 'new', now: new Date('2026-07-10T06:00:01Z'),
  });
  assert.equal(next.ok, false);
  assert.equal(next.reason, 'migration-blocked');
  assert.match(next.message, /cannot verify.*stop old Scout.*remove.*retry/i);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('legacy status reads the durable fenced acquisition without a sentinel', () => {
  const repo = tempRepo();
  let wall = Date.parse('2026-07-27T10:00:00.000Z');
  let monotonic = 0;
  const lease = acquireScanLease(repo, currentLeaseOwner(), {
    kind: 'scan', runId: 'run-status', provider: 'codex', mode: 'primary', phase: 'collect',
  }, {
    wallNow: () => wall, monotonicNow: () => monotonic, leaseDurationMs: 3 * 60 * 60 * 1000,
  });
  assert.equal(fs.existsSync(path.join(repo, '.scout-scan.lock')), false);
  wall += 60 * 60 * 1000;
  monotonic += 60 * 60 * 1000;
  renewScanLease(lease);
  assert.equal(fs.existsSync(path.join(repo, '.scout-scan.lock')), false);
  assert.equal(readScanLock(repo).startedAt, '2026-07-27T10:00:00.000Z');
  releaseScanLease(lease);
});

test('legacy adapter reports downgrade/coexistence after fenced activation', () => {
  const repo = tempRepo();
  const lease = acquireScanLease(repo, currentLeaseOwner(), {
    kind: 'scan', runId: 'run-activate', provider: 'codex', mode: 'primary', phase: 'collect',
  });
  releaseScanLease(lease);
  fs.writeFileSync(path.join(repo, '.scout-scan.lock'), `${JSON.stringify({
    agent: 'old-codex',
    mode: 'primary',
    token: ['down', 'grade'].join(''),
    startedAt: new Date().toISOString(),
  })}\n`, 'utf8');
  const status = readScanLock(repo);
  assert.equal(status.invalid, true);
  assert.equal(status.reason, 'downgrade-coexistence');
  assert.match(status.message, /downgrade.*coexistence|coexistence.*downgrade/i);
  const result = acquireScanLock(repo, {
    agent: 'codex', mode: 'primary', token: ['new', 'fenced'].join('-'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'migration-blocked');
  assert.match(result.message, /downgrade.*coexistence|coexistence.*downgrade/i);
  const released = releaseScanLock(repo, 'downgrade');
  assert.equal(released.ok, false);
  assert.equal(released.reason, 'migration-blocked');
  assert.match(released.message, /downgrade.*coexistence|coexistence.*downgrade/i);
});

test('malformed legacy evidence still reports coexistence after fenced activation', () => {
  const repo = tempRepo();
  const lease = acquireScanLease(repo, currentLeaseOwner(), {
    kind: 'scan', runId: 'run-malformed-downgrade',
    provider: 'codex', mode: 'primary', phase: 'collect',
  });
  releaseScanLease(lease);
  fs.writeFileSync(path.join(repo, '.scout-scan.lock'), '{incomplete', 'utf8');
  const status = readScanLock(repo);
  assert.equal(status.invalid, true);
  assert.equal(status.reason, 'downgrade-coexistence');
  assert.match(status.message, /downgrade.*coexistence|coexistence.*downgrade/i);
});
