import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  LeaseLostError, acquireScanLease, assertCurrentFence, currentLeaseOwner, readScanLease,
  releaseScanLease, renewScanLease, startLeaseHeartbeat,
} from './scanLease.mjs';
import { appendRunEvent, openRunJournal } from './runJournal.mjs';
import {
  commitRunArtifact, projectRunManifest, replaceRunManifest,
} from './runArtifacts.mjs';
import { acquireScanLock } from '../../tools/scan-lock.mjs';

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

function operation(runId) {
  return { kind: 'scan', runId, provider: 'codex', mode: 'primary', phase: 'collect' };
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

test('recovery arbitration cleans its exact claim when a stale observer already moved it', () => {
  const root = temp();
  const scout = path.join(root, '.scout');
  const guard = path.join(scout, 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'dead-arbitration-guard',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-arbitration-moved'), {
    _testHooks: {
      afterGuardRecoveryRename() {
        fs.renameSync(
          path.join(scout, 'scan-lease.recovery-claim'),
          path.join(scout, 'scan-lease.recovery-claim.cleanup'),
        );
      },
    },
  });
  assert.equal(lease?.runId, 'run-arbitration-moved');
  assert.equal(fs.existsSync(path.join(scout, 'scan-lease.recovery-claim.cleanup')), false);
  releaseScanLease(lease);
});

test('same-owner retry recovers exhausted recovery-arbitration cleanup removal', () => {
  const root = temp();
  const scout = path.join(root, '.scout');
  const guard = path.join(scout, 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'dead-arbitration-cleanup',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');
  const injected = injectedGuardFileSystem({ failRecoveryRemove: 4 });
  assert.throws(() => acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-arbitration-cleanup-failure'),
    { fileSystem: injected.fileSystem },
  ), /injected recovery cleanup removal failure/);
  assert.equal(injected.state.recoveryRemoves, 4);
  assert.equal(fs.existsSync(path.join(scout, 'scan-lease.recovery-claim.cleanup')), true);
  const recovered = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-arbitration-cleanup-recovered'),
    { fileSystem: injected.fileSystem },
  );
  assert.equal(recovered?.runId, 'run-arbitration-cleanup-recovered');
  releaseScanLease(recovered);
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

test('a delayed stale recoverer and a third gap contender cannot overlap a live successor', async () => {
  const root = temp();
  const scout = path.join(root, '.scout');
  const guard = path.join(scout, 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'dead-guard',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');
  const observed = path.join(root, 'observed');
  const proceed = path.join(root, 'proceed');
  const active = path.join(root, 'active');
  const release = path.join(root, 'release');
  const entered = path.join(root, 'entered');
  const overlap = path.join(root, 'overlap');
  const moved = path.join(root, 'moved');
  const gapChecked = path.join(root, 'gap-checked');
  const gapProceed = path.join(root, 'gap-proceed');
  const delayed = child([
    'adversarial-recover', root, observed, proceed, active, release, overlap, 'run-delayed',
    moved,
  ]);
  await waitUntil(() => fs.existsSync(observed), 'delayed recoverer did not observe the dead guard');
  const winner = child([
    'recover-and-hold', root, entered, release, active, overlap, 'run-winner',
  ]);
  await waitUntil(() => fs.existsSync(entered), 'winning recoverer did not enter its guarded action');

  const gap = child([
    'gap-contender', root, gapChecked, gapProceed, active, overlap, 'run-gap',
  ]);
  await waitUntil(() => fs.existsSync(gapChecked), 'gap contender did not finish its recovery check');
  fs.writeFileSync(proceed, '', 'utf8');
  fs.writeFileSync(gapProceed, '', 'utf8');
  const [delayedResult, gapResult] = await Promise.all([delayed.result, gap.result]);
  assert.equal(delayedResult.acquired, false);
  assert.equal(gapResult.acquired, false);
  assert.equal(fs.existsSync(moved), false);
  assert.equal(fs.existsSync(overlap), false);
  assert.equal(fs.existsSync(active), true);

  fs.writeFileSync(release, '', 'utf8');
  await winner.result;
});

test('journal, artifact and manifest writes require a genuine current lease', () => {
  const root = temp();
  const run = openRunJournal(root, 'run-plain');
  const plain = { leaseId: 'plain-lease', generation: 1, runId: 'run-plain' };
  const event = {
    type: 'stage.completed', stageId: 'collect', idempotencyKey: 'collect-v1',
    payload: { schemaVersion: 1, count: 0 },
  };
  assert.throws(() => appendRunEvent(run, event, plain), LeaseLostError);
  assert.throws(() => commitRunArtifact(
    run, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: [] }, plain,
  ), LeaseLostError);
  assert.throws(() => replaceRunManifest(run, projectRunManifest([]), plain), LeaseLostError);
});

test('a released plain stale lease cannot commit after its successor is gone', () => {
  const root = temp();
  const owner = currentLeaseOwner();
  const lease = acquireScanLease(root, owner, operation('run-stale-plain'), {
    leaseDurationMs: 50, takeoverMarginMs: 0,
  });
  const plain = JSON.parse(JSON.stringify(lease));
  releaseScanLease(lease);
  const successor = acquireScanLease(root, owner, operation('run-successor'), {
    leaseDurationMs: 1_000, takeoverMarginMs: 0,
  });
  let run = openRunJournal(root, 'run-stale-plain');
  assert.throws(() => appendRunEvent(run, {
    type: 'stage.completed', stageId: 'collect', idempotencyKey: 'during-successor-v1',
    payload: { schemaVersion: 1, count: 0 },
  }, plain), LeaseLostError);
  releaseScanLease(successor);
  run = openRunJournal(root, 'run-stale-plain');
  assert.throws(() => appendRunEvent(run, {
    type: 'stage.completed', stageId: 'collect', idempotencyKey: 'collect-v1',
    payload: { schemaVersion: 1, count: 0 },
  }, plain), LeaseLostError);
});

test('an unfenced child paused before commit cannot race a later lease acquisition', async () => {
  const root = temp();
  const ready = path.join(root, 'plain-ready');
  const proceed = path.join(root, 'plain-proceed');
  const writer = child(['plain-write-after-signal', root, ready, proceed, 'run-plain-child']);
  await waitUntil(() => fs.existsSync(ready), 'plain writer did not reach its pause');
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-owner'));
  fs.writeFileSync(proceed, '', 'utf8');
  assert.deepEqual(await writer.result, { appended: false, leaseLost: true });
  releaseScanLease(lease);
});

test('a lease cannot fence journal, artifact or manifest writes in another workspace', () => {
  const rootA = temp();
  const rootB = temp();
  const owner = currentLeaseOwner();
  const leaseA = acquireScanLease(rootA, owner, operation('same-run'));
  const leaseB = acquireScanLease(rootB, owner, operation('same-run'));
  const runB = openRunJournal(rootB, 'same-run');
  assert.throws(() => appendRunEvent(runB, {
    type: 'stage.completed', stageId: 'collect', idempotencyKey: 'collect-v1',
    payload: { schemaVersion: 1, count: 0 },
  }, leaseA), LeaseLostError);
  assert.throws(() => commitRunArtifact(
    runB, { id: 'collect-v1', schemaVersion: 1 }, { schemaVersion: 1, stableIds: [] }, leaseA,
  ), LeaseLostError);
  assert.throws(() => replaceRunManifest(runB, projectRunManifest([]), leaseA), LeaseLostError);
  releaseScanLease(leaseB);
  releaseScanLease(leaseA);
});

test('a fenced run handle cannot redirect its journal file outside the canonical run directory', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-canonical'));
  const run = openRunJournal(root, 'run-canonical');
  const outside = path.join(root, 'outside.jsonl');
  const forged = { ...run, file: outside };
  assert.throws(() => appendRunEvent(forged, {
    type: 'stage.completed', stageId: 'collect', idempotencyKey: 'collect-v1',
    payload: { schemaVersion: 1, count: 0 },
  }, lease), LeaseLostError);
  assert.equal(fs.existsSync(outside), false);
  releaseScanLease(lease);
});

test('legacy acquisition and token-authorised release work in distinct processes', async () => {
  const root = temp();
  const acquired = await child(['legacy-acquire', root, 'legacy-cross-process']).result;
  assert.equal(acquired.ok, true);
  const released = await child(['legacy-release', root, 'legacy-cross-process']).result;
  assert.deepEqual(released, { ok: true, released: true });
  assert.equal(readScanLease(root), null);
});

test('an active old lock blocks direct lease acquisition during upgrade', () => {
  const root = temp();
  fs.writeFileSync(path.join(root, '.scout-scan.lock'), `${JSON.stringify({
    agent: 'codex', mode: 'primary', token: 'old-token', startedAt: new Date().toISOString(),
  })}\n`, 'utf8');
  assert.equal(acquireScanLease(root, currentLeaseOwner(), operation('run-upgrade')), null);
});

test('the legacy adapter cannot bypass a direct lease takeover margin', () => {
  const root = temp();
  const start = new Date('2026-07-27T10:00:00.000Z');
  acquireScanLease(root, currentLeaseOwner(), operation('run-direct'), {
    now: start, leaseDurationMs: 90_000, takeoverMarginMs: 15_000,
  });
  const tooEarly = acquireScanLock(root, {
    agent: 'codex', mode: 'primary', token: 'legacy-early',
    now: new Date(start.getTime() + 90_001),
  });
  assert.equal(tooEarly.ok, false);
});

test('an exact prior-v1 lease shape is migrated with the safe direct takeover margin', () => {
  const root = temp();
  const start = Date.parse('2026-07-27T10:00:00.000Z');
  const priorLease = acquireScanLease(root, currentLeaseOwner(), operation('run-prior-v1'), {
    wallNow: () => start, leaseDurationMs: 90_000, takeoverMarginMs: 15_000,
  });
  const file = path.join(root, '.scout', 'scan-lease.json');
  const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete prior.takeoverMarginMs;
  fs.writeFileSync(file, `${JSON.stringify(prior)}\n`, 'utf8');
  fs.rmSync(path.join(root, '.scout-scan.lock'), { force: true });

  assert.equal(readScanLease(root).takeoverMarginMs, 15_000);
  assert.equal(acquireScanLease(root, currentLeaseOwner(), operation('run-prior-too-early'), {
    wallNow: () => start + 104_999, leaseDurationMs: 90_000,
  }), null);
  const rebuiltSentinel = JSON.parse(
    fs.readFileSync(path.join(root, '.scout-scan.lock'), 'utf8'),
  );
  assert.equal(rebuiltSentinel.token, priorLease.leaseId);
  assert.equal(rebuiltSentinel.fencedLease, true);
  assert.throws(
    () => fs.openSync(path.join(root, '.scout-scan.lock'), 'wx'),
    (error) => error?.code === 'EEXIST',
  );
  const recovered = acquireScanLease(root, currentLeaseOwner(), operation('run-prior-recovered'), {
    wallNow: () => start + 105_000, leaseDurationMs: 90_000,
  });
  assert.equal(recovered?.runId, 'run-prior-recovered');
  releaseScanLease(recovered);
});

test('renewal refreshes the legacy sentinel seen by pre-upgrade binaries', () => {
  const root = temp();
  let wall = Date.parse('2026-07-27T10:00:00.000Z');
  let monotonic = 0;
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-long-direct'), {
    wallNow: () => wall, monotonicNow: () => monotonic, leaseDurationMs: 3 * 60 * 60 * 1000,
  });
  const sentinel = path.join(root, '.scout-scan.lock');
  assert.equal(JSON.parse(fs.readFileSync(sentinel, 'utf8')).startedAt, new Date(wall).toISOString());
  wall += 90 * 60 * 1000;
  monotonic += 90 * 60 * 1000;
  renewScanLease(lease);
  assert.equal(JSON.parse(fs.readFileSync(sentinel, 'utf8')).startedAt, new Date(wall).toISOString());
  releaseScanLease(lease);
});

test('a takeover crash after sentinel replacement is reconciled to the durable fence', () => {
  const root = temp();
  const start = Date.parse('2026-07-27T10:00:00.000Z');
  const original = acquireScanLease(root, currentLeaseOwner(), operation('run-original'), {
    wallNow: () => start, leaseDurationMs: 1_000, takeoverMarginMs: 0,
    leaseId: 'original-token',
  });
  const crash = new Error('injected crash before successor lease replacement');
  assert.throws(() => acquireScanLease(root, currentLeaseOwner(), operation('run-crashed-successor'), {
    wallNow: () => start + 1_001, leaseDurationMs: 1_000, takeoverMarginMs: 0,
    leaseId: 'crashed-successor-token',
    _testHooks: {
      beforeLeaseReplace(kind) {
        if (kind === 'acquire') throw crash;
      },
    },
  }), (error) => error === crash);
  assert.equal(readScanLease(root).leaseId, original.leaseId);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, '.scout-scan.lock'), 'utf8')).token,
    'crashed-successor-token',
  );

  const recovered = acquireScanLease(root, currentLeaseOwner(), operation('run-recovered-successor'), {
    wallNow: () => start + 1_001, leaseDurationMs: 1_000, takeoverMarginMs: 0,
    leaseId: 'recovered-successor-token',
  });
  assert.equal(recovered?.leaseId, 'recovered-successor-token');
  releaseScanLease(recovered);
});

test('a forward wall jump triggers heartbeat renewal while monotonic time remains active', () => {
  const root = temp();
  let wall = Date.parse('2026-07-27T10:00:00.000Z');
  let monotonic = 0;
  const timers = [];
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-forward'), {
    wallNow: () => wall, monotonicNow: () => monotonic,
  });
  const heartbeat = startLeaseHeartbeat(lease, {
    intervalMs: 15_000,
    wallNow: () => wall,
    monotonicNow: () => monotonic,
    setTimeoutFn: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
  });
  wall += 200_000;
  monotonic += 1_000;
  timers.shift()();
  assert.equal(readScanLease(root).heartbeatSequence, 1);
  assert.equal(heartbeat.lost, false);
  heartbeat.stop();
  releaseScanLease(lease);
});

test('a backward wall jump cannot postpone the monotonic renewal deadline', () => {
  const root = temp();
  let wall = Date.parse('2026-07-27T10:00:00.000Z');
  let monotonic = 0;
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-backward'), {
    wallNow: () => wall, monotonicNow: () => monotonic, leaseDurationMs: 90_000,
  });
  wall -= 3_600_000;
  monotonic = 89_999;
  assert.doesNotThrow(() => assertCurrentFence(lease, () => true));
  monotonic = 90_000;
  assert.throws(() => assertCurrentFence(lease, () => true), LeaseLostError);
});

test('heartbeat rebases the active deadline when its monotonic clock has a distinct origin', () => {
  const root = temp();
  const acquisitionMonotonic = 0;
  let heartbeatMonotonic = 1_000_000;
  const timers = [];
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-clock-origin'), {
    monotonicNow: () => acquisitionMonotonic,
  });
  const heartbeat = startLeaseHeartbeat(lease, {
    intervalMs: 15_000,
    monotonicNow: () => heartbeatMonotonic,
    setTimeoutFn: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
  });
  assert.doesNotThrow(() => assertCurrentFence(lease, () => true));
  heartbeatMonotonic += 89_999;
  assert.doesNotThrow(() => assertCurrentFence(lease, () => true));
  heartbeatMonotonic += 1;
  assert.throws(() => assertCurrentFence(lease, () => true), LeaseLostError);
  heartbeat.stop();
});

test('heartbeat renewal follows monotonic time across a backward wall jump', () => {
  const root = temp();
  let wall = Date.parse('2026-07-27T10:00:00.000Z');
  let monotonic = 0;
  const timers = [];
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-backward-heartbeat'), {
    wallNow: () => wall, monotonicNow: () => monotonic,
  });
  const heartbeat = startLeaseHeartbeat(lease, {
    intervalMs: 15_000, wallNow: () => wall, monotonicNow: () => monotonic,
    setTimeoutFn: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
  });
  wall -= 3_600_000;
  monotonic = 15_000;
  timers.shift()();
  assert.equal(readScanLease(root).heartbeatSequence, 1);
  assert.equal(heartbeat.lost, false);
  heartbeat.stop();
  releaseScanLease(lease);
});

test('heartbeat retries a transient renewal write failure before monotonic expiry', () => {
  const root = temp();
  let wall = Date.parse('2026-07-27T10:00:00.000Z');
  let monotonic = 0;
  let failures = 1;
  const timers = [];
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-renew-retry'), {
    wallNow: () => wall,
    monotonicNow: () => monotonic,
    _testHooks: {
      beforeLeaseReplace(kind) {
        if (kind === 'renew' && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('injected renewal I/O failure'), { code: 'EIO' });
        }
      },
    },
  });
  const heartbeat = startLeaseHeartbeat(lease, {
    intervalMs: 15_000, wallNow: () => wall, monotonicNow: () => monotonic,
    setTimeoutFn: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
  });
  monotonic = 15_000;
  wall += 15_000;
  timers.shift()();
  assert.equal(heartbeat.lost, false);
  assert.equal(failures, 0);
  monotonic = 16_000;
  wall += 1_000;
  timers.shift()();
  assert.equal(readScanLease(root).heartbeatSequence, 1);
  heartbeat.stop();
  releaseScanLease(lease);
});

test('heartbeat retries a transient guard-acquisition failure before monotonic expiry', () => {
  const root = temp();
  let wall = Date.parse('2026-07-27T10:00:00.000Z');
  let monotonic = 0;
  let armed = false;
  let failures = 1;
  const timers = [];
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') return (directory, ...args) => {
        if (armed && String(directory).endsWith('scan-lease.guard') && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('injected guard failure'), { code: 'EBUSY' });
        }
        return target.mkdirSync(directory, ...args);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-guard-retry'), {
    wallNow: () => wall, monotonicNow: () => monotonic, fileSystem,
  });
  const heartbeat = startLeaseHeartbeat(lease, {
    intervalMs: 15_000, wallNow: () => wall, monotonicNow: () => monotonic,
    setTimeoutFn: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutFn: () => {},
  });
  armed = true;
  monotonic = 15_000;
  wall += 15_000;
  timers.shift()();
  assert.equal(heartbeat.lost, false);
  assert.equal(failures, 0);
  monotonic = 16_000;
  wall += 1_000;
  timers.shift()();
  assert.equal(readScanLease(root).heartbeatSequence, 1);
  heartbeat.stop();
  releaseScanLease(lease);
});

test('takeover loses at expiry and wins at expiry plus the persisted margin', () => {
  const start = Date.parse('2026-07-27T10:00:00.000Z');
  const rootBefore = temp();
  const owner = currentLeaseOwner();
  acquireScanLease(rootBefore, owner, operation('run-boundary-old'), {
    now: start, leaseDurationMs: 100, takeoverMarginMs: 50,
  });
  assert.equal(acquireScanLease(rootBefore, owner, operation('run-boundary-early'), {
    now: start + 100, leaseDurationMs: 100, takeoverMarginMs: 0,
  }), null);

  const rootAt = temp();
  acquireScanLease(rootAt, owner, operation('run-margin-old'), {
    now: start, leaseDurationMs: 100, takeoverMarginMs: 50,
  });
  const takeover = acquireScanLease(rootAt, owner, operation('run-margin-winner'), {
    now: start + 150, leaseDurationMs: 100, takeoverMarginMs: 0,
  });
  assert.equal(takeover.generation, 2);
});

test('process-start identities include the platform boot or session boundary', () => {
  const identity = currentLeaseOwner().processStart;
  if (process.platform === 'linux') assert.match(identity, /^linux-[0-9a-f-]{36}-\d+$/);
  else if (process.platform === 'darwin') assert.match(identity, /^darwin-[A-Za-z0-9_-]+$/);
  else if (process.platform === 'win32') assert.match(identity, /^windows-\d+$/);
  else assert.match(identity, /^posix-[A-Za-z0-9_-]+$/);
});

test('remote-host stale ownership is preserved when liveness cannot be verified', async () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'remote-live-unknown',
    owner: { host: 'REMOTE-HOST', pid: 999_999_999, processStart: 'remote-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');
  const contender = await child(['acquire', root, 'run-remote', '1000', '0', '100']).result;
  assert.equal(contender.acquired, false);
  assert.equal(fs.existsSync(guard), true);
});

function injectedGuardFileSystem({
  failCleanupRead = 0, failCleanupRemove = 0, failCleanupRename = 0,
  failRecoveryRemove = 0,
} = {}) {
  const state = {
    reads: 0, removes: 0, renames: 0, recoveryRemoves: 0,
  };
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'readFileSync') return (file, ...args) => {
        if (String(file).includes('scan-lease.guard.cleanup') && state.reads < failCleanupRead) {
          state.reads += 1;
          throw Object.assign(new Error('injected cleanup read failure'), { code: 'EIO' });
        }
        return target.readFileSync(file, ...args);
      };
      if (property === 'rmSync') return (file, ...args) => {
        if (String(file).includes('scan-lease.recovery-claim.cleanup')
          && state.recoveryRemoves < failRecoveryRemove) {
          state.recoveryRemoves += 1;
          throw Object.assign(new Error('injected recovery cleanup removal failure'), { code: 'EBUSY' });
        }
        if (String(file).includes('scan-lease.guard.cleanup') && state.removes < failCleanupRemove) {
          state.removes += 1;
          throw Object.assign(new Error('injected cleanup remove failure'), { code: 'EBUSY' });
        }
        return target.rmSync(file, ...args);
      };
      if (property === 'renameSync') return (source, destination) => {
        if (String(source).endsWith('scan-lease.guard')
          && String(destination).endsWith('scan-lease.guard.cleanup')
          && state.renames < failCleanupRename) {
          state.renames += 1;
          throw Object.assign(new Error('injected cleanup rename failure'), { code: 'EBUSY' });
        }
        return target.renameSync(source, destination);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fileSystem, state };
}

test('bounded same-owner cleanup recovers transient metadata and removal failures', () => {
  const root = temp();
  const injected = injectedGuardFileSystem({ failCleanupRead: 1, failCleanupRemove: 1 });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-cleanup'), {
    fileSystem: injected.fileSystem,
  });
  assert.equal(injected.state.reads, 1);
  assert.equal(injected.state.removes, 1);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), false);
  releaseScanLease(lease);
});

test('cleanup preserves the original guarded-action error after a transient failure', () => {
  const root = temp();
  const injected = injectedGuardFileSystem({ failCleanupRemove: 1 });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-cleanup-error'), {
    fileSystem: injected.fileSystem,
  });
  const expected = new Error('guarded action failed');
  assert.throws(() => assertCurrentFence(lease, () => { throw expected; }), (error) => error === expected);
  assert.equal(injected.state.removes, 1);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), false);
  releaseScanLease(lease);
});

test('a committed action retains its result and the same owner recovers an exhausted cleanup claim', () => {
  const root = temp();
  const injected = injectedGuardFileSystem({ failCleanupRemove: 4 });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-cleanup-recovery'), {
    fileSystem: injected.fileSystem,
  });
  assert.equal(lease.runId, 'run-cleanup-recovery');
  assert.equal(injected.state.removes, 4);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard.cleanup')), true);
  assert.doesNotThrow(() => assertCurrentFence(lease, () => true));
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard.cleanup')), false);
  releaseScanLease(lease);
});

test('the same lease runtime recovers after cleanup rename retries are exhausted', () => {
  const root = temp();
  const injected = injectedGuardFileSystem({ failCleanupRename: 4 });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-cleanup-rename'), {
    fileSystem: injected.fileSystem,
  });
  assert.equal(lease.runId, 'run-cleanup-rename');
  assert.equal(injected.state.renames, 4);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), true);
  assert.doesNotThrow(() => assertCurrentFence(lease, () => true));
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), false);
  releaseScanLease(lease);
});

test('cleanup rename exhaustion preserves a throwing action and remains recoverable', () => {
  const injected = injectedGuardFileSystem({ failCleanupRename: 4 });
  const expected = new Error('guarded action failed before rename cleanup');
  const failingRoot = temp();
  assert.throws(() => acquireScanLease(
    failingRoot,
    currentLeaseOwner(),
    operation('run-cleanup-rename-error-inner'),
    {
      fileSystem: injected.fileSystem,
      _testHooks: { beforeGuardedAction() { throw expected; } },
    },
  ), (error) => error === expected);
  assert.equal(injected.state.renames, 4);
  const recovered = acquireScanLease(
    failingRoot,
    currentLeaseOwner(),
    operation('run-cleanup-rename-error-recovery'),
    { fileSystem: injected.fileSystem },
  );
  assert.equal(recovered?.runId, 'run-cleanup-rename-error-recovery');
  releaseScanLease(recovered);
});

test('guard metadata with unknown fields is not trusted for stale quarantine', async () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'guard-extra-field',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
    secret: 'must-not-be-accepted',
  })}\n`, 'utf8');
  const contender = await child(['acquire', root, 'run-extra', '1000', '0', '100']).result;
  assert.equal(contender.acquired, false);
  assert.equal(fs.existsSync(guard), true);
});

test('fenced commit requires a callback and rejects async callbacks before side effects', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-callback'));
  assert.throws(() => assertCurrentFence(lease), /callback/i);
  let sideEffect = false;
  assert.throws(() => assertCurrentFence(lease, async () => {
    sideEffect = true;
  }), /synchronous/i);
  assert.equal(sideEffect, false);
  releaseScanLease(lease);
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
