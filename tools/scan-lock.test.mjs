import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { acquireScanLock, readScanLock, releaseScanLock } from './scan-lock.mjs';

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
