import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  acquireScanLease, assertCurrentFence, currentLeaseOwner, releaseScanLease,
} from './scanLease.mjs';

const fixture = fileURLToPath(new URL('./fixtures/lease-contender.mjs', import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-scan-lease-'));
  roots.push(root);
  return root;
}

function child(args) {
  const processHandle = spawn(process.execPath, [fixture, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  processHandle.stdout.setEncoding('utf8');
  processHandle.stderr.setEncoding('utf8');
  processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
  processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('exit', (code) => {
      if (code !== 0) reject(new Error(`lease contender exited ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout.trim()));
    });
  });
  return { process: processHandle, result };
}

async function waitUntil(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('separate processes racing for one workspace produce exactly one winner', async () => {
  const root = temp();
  const gate = path.join(root, 'start');
  const first = child(['race-acquire', root, gate, 'run-a', '2000', '0']);
  const second = child(['race-acquire', root, gate, 'run-b', '2000', '0']);
  await waitUntil(
    () => fs.readdirSync(root).filter((name) => name.endsWith('.ready')).length === 2,
    'contenders did not become ready',
  );
  fs.writeFileSync(gate, '', 'utf8');

  const results = await Promise.all([first.result, second.result]);
  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.find((result) => result.acquired).lease.generation, 1);
});

test('an independent heartbeat prevents a competing process from taking over', async () => {
  const root = temp();
  const ready = path.join(root, 'heartbeat-ready');
  const stop = path.join(root, 'heartbeat-stop');
  const owner = child(['heartbeat-owner', root, ready, stop, 'run-heartbeat', '350', '40', '50']);
  await waitUntil(() => fs.existsSync(ready), 'heartbeat owner did not acquire');
  await new Promise((resolve) => setTimeout(resolve, 475));

  const contender = await child(['acquire', root, 'run-contender', '350', '50']).result;
  assert.equal(contender.acquired, false);

  fs.writeFileSync(stop, '', 'utf8');
  const ownerResult = await owner.result;
  assert.equal(ownerResult.lost, false);
});

test('takeover after expiry and its margin allocates generation plus one', async () => {
  const root = temp();
  const first = await child(['acquire', root, 'run-old', '80', '40']).result;
  assert.equal(first.lease.generation, 1);
  await new Promise((resolve) => setTimeout(resolve, 180));

  const second = await child(['acquire', root, 'run-new', '80', '40']).result;
  assert.equal(second.acquired, true);
  assert.equal(second.lease.generation, 2);
  assert.notEqual(second.lease.leaseId, first.lease.leaseId);
});

test('a process holding a stale generation cannot append after takeover', async () => {
  const root = temp();
  const ready = path.join(root, 'stale-ready');
  const proceed = path.join(root, 'stale-proceed');
  const stale = child(['stale-append-owner', root, ready, proceed, 'run-stale', '80', '30']);
  await waitUntil(() => fs.existsSync(ready), 'stale owner did not acquire');
  await new Promise((resolve) => setTimeout(resolve, 160));
  const takeover = await child(['acquire', root, 'run-takeover', '1000', '30']).result;
  assert.equal(takeover.lease.generation, 2);

  fs.writeFileSync(proceed, '', 'utf8');
  const staleResult = await stale.result;
  assert.deepEqual(staleResult, {
    journalAppended: false,
    artifactCommitted: false,
    leaseLost: 2,
  });
  const runDirectory = path.join(root, '.scout', 'runs', 'run-stale');
  assert.equal(fs.existsSync(path.join(runDirectory, 'journal.jsonl')), false);
  assert.equal(fs.existsSync(path.join(runDirectory, 'artifacts')), false);
});

test('a reused PID with a different process-start identity cannot preserve a dead guard', async () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  const actual = currentLeaseOwner();
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'guard-reused-pid',
    owner: { ...actual, processStart: `${actual.processStart}-reused` },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');

  const result = await child(['acquire', root, 'run-after-reuse', '1000', '0']).result;
  assert.equal(result.acquired, true);
  const quarantines = fs.readdirSync(path.join(root, '.scout'))
    .filter((name) => name.startsWith('scan-lease.guard.quarantine.'));
  assert.equal(quarantines.length, 1);
});

test('a dead guard older than 30 seconds is atomically quarantined', async () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'guard-dead-process',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');

  const result = await child(['acquire', root, 'run-after-dead-guard', '1000', '0']).result;
  assert.equal(result.acquired, true);
  const scoutEntries = fs.readdirSync(path.join(root, '.scout'));
  assert.equal(scoutEntries.some((name) => name.startsWith('scan-lease.guard.quarantine.')), true);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.json')), true);
});

test('a live guard is never quarantined even when its wall-clock timestamp is old', async () => {
  const root = temp();
  const ready = path.join(root, 'guard-ready');
  const stop = path.join(root, 'guard-stop');
  const holder = child([
    'hold-guard', root, ready, stop, new Date(Date.now() - 31_000).toISOString(),
  ]);
  await waitUntil(() => fs.existsSync(ready), 'guard holder did not become ready');

  const contender = await child(['acquire', root, 'run-blocked', '1000', '0', '100']).result;
  assert.equal(contender.acquired, false);
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.scout')).filter((name) => name.includes('.quarantine.')),
    [],
  );

  fs.writeFileSync(stop, '', 'utf8');
  await holder.result;
});

test('a fenced commit propagates its own EEXIST error without retrying the commit', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'run-error', provider: 'codex', mode: 'primary',
  });
  let calls = 0;
  const expected = Object.assign(new Error('target already exists'), { code: 'EEXIST' });

  assert.throws(() => assertCurrentFence(lease, () => {
    calls += 1;
    throw expected;
  }), (error) => error === expected);
  assert.equal(calls, 1);
  releaseScanLease(lease);
});

test('acquisition rejects an owner identity that does not belong to the calling process', () => {
  const root = temp();
  const owner = currentLeaseOwner();
  assert.throws(() => acquireScanLease(root, {
    ...owner,
    processStart: `${owner.processStart}-forged`,
  }, {
    kind: 'scan', runId: 'run-forged', provider: 'codex', mode: 'primary',
  }), /calling process/i);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.json')), false);
});
