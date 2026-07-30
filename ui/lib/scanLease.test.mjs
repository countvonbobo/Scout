import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import * as scanLeaseModule from './scanLease.mjs';
import {
  LeaseLostError, acquireScanLease, assertCurrentFence, currentLeaseOwner,
  darwinProcessStartIdentity, readScanLease, handoffScanLease, releaseScanLease,
  releaseScanLeaseByToken, renewScanLease, startLeaseHeartbeat, synchronousFenceCallback,
  windowsProcessStartIdentity,
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
  const leaseDurationMs = 350;
  const heartbeatIntervalMs = 40;
  const takeoverMarginMs = 50;
  const owner = child([
    'heartbeat-owner', root, ready, stop, 'run-heartbeat',
    String(leaseDurationMs), String(heartbeatIntervalMs), String(takeoverMarginMs),
  ]);
  await waitUntil(() => fs.existsSync(ready), 'heartbeat owner did not acquire');
  const initial = JSON.parse(fs.readFileSync(ready, 'utf8'));
  let contender;
  let ownerResult;
  try {
    await waitUntil(() => {
      const current = readScanLease(root);
      return current?.leaseId === initial.leaseId
        && current.heartbeatSequence >= 2
        && Date.now() >= Date.parse(initial.expiresAt) + takeoverMarginMs
        && Date.parse(current.expiresAt) - Date.now() >= leaseDurationMs / 2;
    }, 'heartbeat did not renew beyond the original takeover window');
    contender = await child([
      'acquire', root, 'run-contender', String(leaseDurationMs), String(takeoverMarginMs),
    ]).result;
  } finally {
    fs.writeFileSync(stop, '', 'utf8');
    ownerResult = await owner.result;
  }

  assert.equal(contender.acquired, false);
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
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(guard, old, old);
  const actual = currentLeaseOwner();
  fs.writeFileSync(path.join(guard, 'guard-reused-pid.json'), `${JSON.stringify({
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
  fs.writeFileSync(path.join(guard, 'guard-dead-process.json'), `${JSON.stringify({
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

test('recovery arbitration removes its identity marker and leaves no fixed cleanup target', () => {
  const root = temp();
  const scout = path.join(root, '.scout');
  const guard = path.join(scout, 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'dead-arbitration-guard.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'dead-arbitration-guard',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-arbitration-identity'));
  assert.equal(lease?.runId, 'run-arbitration-identity');
  assert.equal(fs.existsSync(path.join(scout, 'scan-lease.recovery-claim')), false);
  assert.equal(fs.existsSync(path.join(scout, 'scan-lease.recovery-claim.cleanup')), false);
  releaseScanLease(lease);
});

test('recovery-arbitration cleanup failure is recovered in the background', async () => {
  const root = temp();
  const scout = path.join(root, '.scout');
  const guard = path.join(scout, 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'dead-arbitration-cleanup.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'dead-arbitration-cleanup',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');
  const injected = injectedGuardFileSystem({ failRecoveryMarkerUnlink: 4 });
  assert.throws(() => acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-arbitration-cleanup-failure'),
    { fileSystem: injected.fileSystem },
  ), /injected recovery marker cleanup failure/);
  assert.equal(injected.state.recoveryMarkerUnlinks, 4);
  await waitUntil(
    () => !fs.existsSync(path.join(scout, 'scan-lease.recovery-claim')),
    'recovery-arbitration cleanup did not recover in the background',
  );
  const recovered = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-arbitration-cleanup-recovered'),
    { fileSystem: injected.fileSystem },
  );
  assert.equal(recovered?.runId, 'run-arbitration-cleanup-recovered');
  releaseScanLease(recovered);
});

test('failed recovery-arbitration publication leaves no visible or private claim', () => {
  const root = temp();
  const scout = path.join(root, '.scout');
  const guard = path.join(scout, 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'dead-arbitration-publication.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'dead-arbitration-publication',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');
  let failed = false;
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'symlinkSync') return (source, destination, type) => {
        if (!failed && String(destination).endsWith('scan-lease.recovery-claim')) {
          failed = true;
          throw Object.assign(new Error('injected arbitration publication failure'), { code: 'EIO' });
        }
        return target.symlinkSync(source, destination, type);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.throws(() => acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-arbitration-publication-failure'),
    { fileSystem },
  ), /injected arbitration publication failure/);
  assert.equal(fs.existsSync(path.join(scout, 'scan-lease.recovery-claim')), false);
  assert.deepEqual(
    fs.readdirSync(scout).filter((entry) => entry.startsWith('scan-lease.recovery-claim.candidate.')),
    [],
  );
  const recovered = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-after-arbitration-publication-failure'),
  );
  assert.equal(recovered?.runId, 'run-after-arbitration-publication-failure');
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

test('a live previous-version owner.json guard remains protected during upgrade', () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'previous-version-live-guard',
    owner: currentLeaseOwner(),
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
  })}\n`, 'utf8');
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(guard, old, old);

  const contender = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-during-guard-upgrade'),
    { guardAcquireTimeoutMs: 50 },
  );
  assert.equal(contender, null);
  assert.equal(fs.existsSync(guard), true);
  assert.equal(fs.existsSync(path.join(guard, 'owner.json')), true);
});

test('a delayed guard creator cannot publish into a live successor directory', () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  const successorId = 'initialization-race-successor';
  let injected = false;
  const installSuccessor = () => {
    fs.mkdirSync(guard);
    fs.writeFileSync(path.join(guard, `${successorId}.json`), `${JSON.stringify({
      schemaVersion: 1,
      guardId: successorId,
      owner: currentLeaseOwner(),
      acquiredAt: new Date().toISOString(),
    })}\n`, 'utf8');
    injected = true;
  };
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') return (directory, options) => {
        const result = target.mkdirSync(directory, options);
        if (!injected && path.resolve(String(directory)) === path.resolve(guard)) {
          const displaced = `${guard}.displaced-initializer`;
          target.renameSync(guard, displaced);
          installSuccessor();
        }
        return result;
      };
      if (property === 'symlinkSync') return (source, destination, type) => {
        if (!injected && path.resolve(String(destination)) === path.resolve(guard)) {
          installSuccessor();
        }
        return target.symlinkSync(source, destination, type);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const contender = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-delayed-initializer'),
    { fileSystem, guardAcquireTimeoutMs: 50 },
  );
  assert.equal(injected, true);
  assert.equal(contender, null);
  assert.deepEqual(fs.readdirSync(guard), [`${successorId}.json`]);
  assert.equal(readScanLease(root), null);
});

test('guard publication never replaces an empty previous-version initializer', () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(guard, old, old);
  let simulatedPosixReplacement = false;
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') return (source, destination) => {
        if (String(source).includes('scan-lease.guard.candidate.')
          && path.resolve(String(destination)) === path.resolve(guard)) {
          target.rmdirSync(guard);
          simulatedPosixReplacement = true;
        }
        return target.renameSync(source, destination);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const contender = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-empty-initializer-race'),
    { fileSystem, guardAcquireTimeoutMs: 50 },
  );
  assert.equal(contender, null);
  assert.equal(simulatedPosixReplacement, false);
  assert.deepEqual(fs.readdirSync(guard), []);
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'resumed-previous-version-initializer',
    owner: currentLeaseOwner(),
    acquiredAt: new Date().toISOString(),
  })}\n`, 'utf8');
  assert.equal(readScanLease(root), null);
});

test('a delayed stale recoverer and a third gap contender cannot overlap a live successor', async () => {
  const root = temp();
  const scout = path.join(root, '.scout');
  const guard = path.join(scout, 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'dead-guard.json'), `${JSON.stringify({
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

test('a not-yet-created journal remains contained through a symlinked workspace root', () => {
  const physicalRoot = temp();
  const linkedRoot = `${physicalRoot}-linked`;
  fs.symlinkSync(physicalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  roots.push(linkedRoot);
  const lease = acquireScanLease(
    linkedRoot,
    currentLeaseOwner(),
    operation('run-linked-workspace'),
  );
  const run = openRunJournal(linkedRoot, 'run-linked-workspace');

  const event = appendRunEvent(run, {
    type: 'stage.completed',
    stageId: 'collect',
    idempotencyKey: 'collect-linked-v1',
    payload: { schemaVersion: 1, count: 0 },
  }, lease);

  assert.equal(event.runId, 'run-linked-workspace');
  assert.equal(fs.realpathSync(run.file), path.join(
    fs.realpathSync(physicalRoot),
    '.scout',
    'runs',
    'run-linked-workspace',
    'journal.jsonl',
  ));
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

test('fenced activation never creates a cross-version legacy sentinel', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-no-sentinel'));
  assert.ok(lease);
  assert.equal(fs.existsSync(path.join(root, '.scout-scan.lock')), false);
  renewScanLease(lease);
  assert.equal(fs.existsSync(path.join(root, '.scout-scan.lock')), false);
  releaseScanLease(lease);
});

test('an unexpired legacy lock blocks migration without changing its bytes', async () => {
  const root = temp();
  const ready = path.join(root, 'legacy-ready');
  const stop = path.join(root, 'legacy-stop');
  const startedAt = '2026-07-27T10:00:00.000Z';
  const legacy = child([
    'legacy-lock-owner', root, ready, stop, startedAt, 'legacy-active',
  ]);
  await waitUntil(() => fs.existsSync(ready), 'legacy owner did not publish its lock');
  const file = path.join(root, '.scout-scan.lock');
  const before = fs.readFileSync(file, 'utf8');
  try {
    assert.throws(() => acquireScanLease(root, currentLeaseOwner(), operation('run-upgrade'), {
      wallNow: () => Date.parse('2026-07-27T10:30:00.000Z'),
    }), /stop old Scout.*retry/i);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease-generation.json')), false);
  } finally {
    fs.writeFileSync(stop, '', 'utf8');
    await legacy.result;
  }
});

test('an expired legacy lock still blocks while its exact owner is live', async () => {
  const root = temp();
  const ready = path.join(root, 'legacy-ready');
  const stop = path.join(root, 'legacy-stop');
  const legacy = child([
    'legacy-lock-owner', root, ready, stop,
    '2026-07-27T07:00:00.000Z', 'legacy-live-expired',
  ]);
  await waitUntil(() => fs.existsSync(ready), 'legacy owner did not publish its lock');
  try {
    assert.throws(() => acquireScanLease(root, currentLeaseOwner(), operation('run-live-upgrade'), {
      wallNow: () => Date.parse('2026-07-27T10:00:01.000Z'),
    }), /stop old Scout.*retry/i);
  } finally {
    fs.writeFileSync(stop, '', 'utf8');
    await legacy.result;
  }
});

test('an expired legacy lock with a stopped exact owner migrates once and records the decision', async () => {
  const root = temp();
  const ready = path.join(root, 'legacy-ready');
  const stopped = await child([
    'legacy-lock-owner', root, ready, '-',
    '2026-07-27T07:00:00.000Z', 'legacy-stopped-expired',
  ]).result;
  assert.equal(stopped.created, true);

  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-migrated'), {
    wallNow: () => Date.parse('2026-07-27T10:00:01.000Z'),
  });
  assert.equal(lease?.generation, 1);
  assert.equal(fs.existsSync(path.join(root, '.scout-scan.lock')), false);
  const migration = JSON.parse(fs.readFileSync(
    path.join(root, '.scout', 'scan-lease-migration.json'),
    'utf8',
  ));
  assert.equal(migration.decision, 'expired-stopped-owner');
  assert.equal(migration.firstGeneration, 1);
  assert.equal(migration.legacyLock.token, 'legacy-stopped-expired');
  assert.deepEqual(migration.legacyLock.owner, stopped.owner);
  releaseScanLease(lease);
});

test('a pre-activation failure keeps the legacy lock unchanged and resumes its recorded decision', async () => {
  const root = temp();
  const ready = path.join(root, 'legacy-ready');
  await child([
    'legacy-lock-owner', root, ready, '-',
    '2026-07-27T07:00:00.000Z', 'legacy-resumable',
  ]).result;
  const legacyFile = path.join(root, '.scout-scan.lock');
  const generationFile = path.join(root, '.scout', 'scan-lease-generation.json');
  const migrationFile = path.join(root, '.scout', 'scan-lease-migration.json');
  const before = fs.readFileSync(legacyFile, 'utf8');
  const injected = new Error('injected pre-activation failure');

  assert.throws(() => acquireScanLease(root, currentLeaseOwner(), operation('run-interrupted'), {
    wallNow: () => Date.parse('2026-07-27T10:00:01.000Z'),
    _testHooks: {
      afterMigrationDecision() {
        assert.equal(fs.existsSync(migrationFile), true);
        assert.equal(fs.existsSync(generationFile), false);
        throw injected;
      },
    },
  }), (error) => error === injected);
  assert.equal(fs.readFileSync(legacyFile, 'utf8'), before);

  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-resumed'), {
    wallNow: () => Date.parse('2026-07-27T10:00:02.000Z'),
  });
  assert.equal(lease?.generation, 1);
  assert.equal(fs.existsSync(legacyFile), false);
  releaseScanLease(lease);
});

test('legacy evidence appearing after an interrupted fresh decision blocks with operator guidance', () => {
  const root = temp();
  const injected = new Error('injected fresh pre-activation failure');
  assert.throws(() => acquireScanLease(root, currentLeaseOwner(), operation('run-fresh-interrupted'), {
    _testHooks: {
      afterMigrationDecision() {
        throw injected;
      },
    },
  }), (error) => error === injected);
  assert.equal(
    fs.existsSync(path.join(root, '.scout', 'scan-lease-generation.json')),
    false,
  );
  fs.writeFileSync(path.join(root, '.scout-scan.lock'), `${JSON.stringify({
    agent: 'old-codex',
    mode: 'primary',
    token: ['legacy', 'after', 'fresh', 'decision'].join('-'),
    startedAt: new Date().toISOString(),
  })}\n`, 'utf8');
  assert.throws(
    () => acquireScanLease(root, currentLeaseOwner(), operation('run-fresh-conflict')),
    /cannot verify.*stop old Scout.*remove.*retry/i,
  );
});

test('an expired ownerless legacy lock is unverifiable and fails closed', () => {
  const root = temp();
  const file = path.join(root, '.scout-scan.lock');
  fs.writeFileSync(file, `${JSON.stringify({
    agent: 'codex',
    mode: 'primary',
    token: ['legacy', 'ownerless'].join('-'),
    startedAt: '2026-07-27T07:00:00.000Z',
  })}\n`, 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => acquireScanLease(root, currentLeaseOwner(), operation('run-unverifiable'), {
    wallNow: () => Date.parse('2026-07-27T10:00:01.000Z'),
  }), /cannot verify.*stop old Scout.*remove.*retry/i);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('the legacy adapter cannot bypass a direct lease takeover margin', () => {
  const root = temp();
  const start = new Date('2026-07-27T10:00:00.000Z');
  acquireScanLease(root, currentLeaseOwner(), operation('run-direct'), {
    now: start, leaseDurationMs: 90_000, takeoverMarginMs: 15_000,
  });
  const tooEarly = acquireScanLock(root, {
    agent: 'codex', mode: 'primary', token: ['legacy', 'early'].join('-'),
    now: new Date(start.getTime() + 90_001),
  });
  assert.equal(tooEarly.ok, false);
});

test('an exact prior-v1 lease shape retains the safe direct takeover margin without a sentinel', () => {
  const root = temp();
  const start = Date.parse('2026-07-27T10:00:00.000Z');
  acquireScanLease(root, currentLeaseOwner(), operation('run-prior-v1'), {
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
  assert.equal(fs.existsSync(path.join(root, '.scout-scan.lock')), false);
  const recovered = acquireScanLease(root, currentLeaseOwner(), operation('run-prior-recovered'), {
    wallNow: () => start + 105_000, leaseDurationMs: 90_000,
  });
  assert.equal(recovered?.runId, 'run-prior-recovered');
  releaseScanLease(recovered);
});

test('a legacy lock created after fenced activation is rejected as a downgrade', async () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-activate'));
  releaseScanLease(lease);
  await child([
    'legacy-lock-create', root, new Date().toISOString(), 'legacy-downgrade',
  ]).result;
  assert.throws(
    () => acquireScanLease(root, currentLeaseOwner(), operation('run-after-downgrade')),
    /downgrade.*coexistence|coexistence.*downgrade/i,
  );
  assert.equal(readScanLease(root), null);
});

test('a legacy lock appearing beside an active fenced lease stops commits and renewal', async () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-coexistence'));
  fs.rmSync(path.join(root, '.scout-scan.lock'), { force: true });
  await child([
    'legacy-lock-create', root, new Date().toISOString(), 'legacy-coexistence',
  ]).result;
  let committed = false;
  assert.throws(() => assertCurrentFence(lease, synchronousFenceCallback(() => {
    committed = true;
  })), /coexistence/i);
  assert.equal(committed, false);
  assert.throws(() => renewScanLease(lease), /coexistence/i);
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
  assert.doesNotThrow(() => assertCurrentFence(lease, synchronousFenceCallback(() => true)));
  monotonic = 90_000;
  assert.throws(() => assertCurrentFence(
    lease, synchronousFenceCallback(() => true),
  ), LeaseLostError);
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
  assert.doesNotThrow(() => assertCurrentFence(lease, synchronousFenceCallback(() => true)));
  heartbeatMonotonic += 89_999;
  assert.doesNotThrow(() => assertCurrentFence(lease, synchronousFenceCallback(() => true)));
  heartbeatMonotonic += 1;
  assert.throws(() => assertCurrentFence(
    lease, synchronousFenceCallback(() => true),
  ), LeaseLostError);
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
      if (property === 'symlinkSync') return (source, destination, type) => {
        if (armed && String(destination).endsWith('scan-lease.guard') && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('injected guard failure'), { code: 'EBUSY' });
        }
        return target.symlinkSync(source, destination, type);
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
  else if (process.platform === 'win32') {
    assert.match(identity, /^windows-(?:\d+|fallback-[a-f0-9]{64})$/);
  }
  else assert.match(identity, /^posix-[A-Za-z0-9_-]+$/);
});

test('Windows process identity tries both shells and safely falls back only for this process', () => {
  const calls = [];
  const powershellFallback = windowsProcessStartIdentity(1234, {
    currentPid: 9999,
    spawn(command) {
      calls.push(command);
      if (command === 'pwsh.exe') return { status: null, stdout: '', error: new Error('timeout') };
      return { status: 0, stdout: '638892241234567890\r\n' };
    },
  });
  assert.equal(powershellFallback, 'windows-638892241234567890');
  assert.deepEqual(calls, ['pwsh.exe', 'powershell.exe']);

  const ownFallback = windowsProcessStartIdentity(9999, {
    currentPid: 9999,
    instanceStart: 1785312345678.125,
    hostname: 'WIN-RUNNER',
    spawn: () => ({ status: null, stdout: '', error: new Error('timeout') }),
  });
  assert.match(ownFallback, /^windows-fallback-[a-f0-9]{64}$/);
  assert.equal(ownFallback, windowsProcessStartIdentity(9999, {
    currentPid: 9999,
    instanceStart: 1785312345678.125,
    hostname: 'WIN-RUNNER',
    spawn: () => ({ status: 1, stdout: '' }),
  }));
  assert.notEqual(ownFallback, windowsProcessStartIdentity(9999, {
    currentPid: 9999,
    instanceStart: 1785312345678.5,
    hostname: 'WIN-RUNNER',
    spawn: () => ({ status: 1, stdout: '' }),
  }));
  assert.equal(windowsProcessStartIdentity(1234, {
    currentPid: 9999,
    instanceStart: 1785312345678.125,
    hostname: 'WIN-RUNNER',
    spawn: () => ({ status: 1, stdout: '' }),
  }), null, 'another process must never receive this process instance fallback');
});

test('Darwin process identity remains boot-bound when private kernel process data is unavailable', () => {
  const spawn = (command, args) => {
    assert.equal(command, 'sysctl');
    if (args.join(' ') === '-n kern.boottime') {
      return { status: 0, stdout: '{ sec = 1785142800, usec = 123456 } Tue Jul 28 09:00:00 2026\n' };
    }
    assert.equal(args[0], '-b');
    assert.match(args[1], /^kern\.proc\.pid\.\d+$/);
    return { status: 1, stdout: Buffer.alloc(0) };
  };
  const start = 'Tue Jul 28 10:11:12 2026';
  const identity = darwinProcessStartIdentity(1234, start, {
    spawn,
    instanceStart: 1785143472123.456,
  });

  assert.match(identity, /^darwin-fallback-[a-f0-9]{32}-[a-f0-9]{32}$/);
  assert.equal(identity, darwinProcessStartIdentity(1234, start, {
    spawn,
    instanceStart: 1785143472123.456,
  }));
  assert.notEqual(identity, darwinProcessStartIdentity(1234, start, {
    spawn,
    instanceStart: 1785143472123.789,
  }), 'same-second PID reuse must receive a distinct owner identity');
  assert.notEqual(identity, darwinProcessStartIdentity(1235, start, {
    spawn,
    instanceStart: 1785143472123.456,
  }));
  assert.notEqual(identity, darwinProcessStartIdentity(1234, 'Tue Jul 28 10:11:13 2026', {
    spawn,
    instanceStart: 1785143472123.456,
  }));
  assert.doesNotMatch(identity, /1785142800|1234|Jul|2026/);
});

test('remote-host stale ownership is preserved when liveness cannot be verified', async () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'remote-live-unknown.json'), `${JSON.stringify({
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
  failMarkerUnlink = 0,
  failDirectoryRemove = 0,
  failRecoveryMarkerUnlink = 0,
} = {}) {
  const state = {
    markerUnlinks: 0,
    directoryRemoves: 0,
    recoveryMarkerUnlinks: 0,
    markerFailuresRemaining: failMarkerUnlink,
    directoryFailuresRemaining: failDirectoryRemove,
    recoveryMarkerFailuresRemaining: failRecoveryMarkerUnlink,
  };
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'unlinkSync') return (file) => {
        if (String(file).includes('scan-lease.recovery-claim')
          && state.recoveryMarkerFailuresRemaining > 0) {
          state.recoveryMarkerUnlinks += 1;
          state.recoveryMarkerFailuresRemaining -= 1;
          throw Object.assign(new Error('injected recovery marker cleanup failure'), { code: 'EBUSY' });
        }
        if (String(file).includes('scan-lease.guard')
          && state.markerFailuresRemaining > 0) {
          state.markerUnlinks += 1;
          state.markerFailuresRemaining -= 1;
          throw Object.assign(new Error('injected guard marker cleanup failure'), { code: 'EBUSY' });
        }
        return target.unlinkSync(file);
      };
      if (property === 'rmdirSync') return (directory) => {
        if (String(directory).includes('scan-lease.guard')
          && state.directoryFailuresRemaining > 0) {
          state.directoryRemoves += 1;
          state.directoryFailuresRemaining -= 1;
          throw Object.assign(new Error('injected guard directory cleanup failure'), { code: 'EBUSY' });
        }
        return target.rmdirSync(directory);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fileSystem, state };
}

function stalePendingCleanupFileSystem(root) {
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  const successorId = 'live-successor-guard';
  const state = {
    failedOwnMarkerUnlinks: 0,
    successorMoved: false,
    successorRemoved: false,
  };
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'unlinkSync') return (file) => {
        if (String(file).includes('scan-lease.guard.candidate.')
          && !String(file).endsWith(`${successorId}.json`)
          && state.failedOwnMarkerUnlinks < 4) {
          state.failedOwnMarkerUnlinks += 1;
          throw Object.assign(new Error('injected identity-marker cleanup failure'), { code: 'EBUSY' });
        }
        return target.unlinkSync(file);
      };
      if (property === 'renameSync') return (source, destination) => {
        if (path.resolve(String(source)) === path.resolve(guard)) {
          state.successorMoved = true;
        }
        return target.renameSync(source, destination);
      };
      if (property === 'rmSync') return (directory, options) => {
        if (path.resolve(String(directory)) === path.resolve(guard)
          && target.existsSync(path.join(guard, `${successorId}.json`))) {
          state.successorRemoved = true;
        }
        return target.rmSync(directory, options);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { fileSystem, state, successorId };
}

test('failed post-publication withdrawal is recovered in the background', async () => {
  const root = temp();
  const scout = path.join(root, '.scout');
  const guard = path.join(scout, 'scan-lease.guard');
  const recovery = `${guard}.recovery`;
  let recoveryInjected = false;
  let unlinkFailures = 0;
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'symlinkSync') return (source, destination, type) => {
        const result = target.symlinkSync(source, destination, type);
        if (!recoveryInjected && path.resolve(String(destination)) === path.resolve(guard)) {
          target.mkdirSync(recovery);
          recoveryInjected = true;
        }
        return result;
      };
      if (property === 'unlinkSync') return (file) => {
        if (path.resolve(String(file)) === path.resolve(guard) && unlinkFailures < 4) {
          unlinkFailures += 1;
          throw Object.assign(new Error('injected withdrawal unlink failure'), { code: 'EBUSY' });
        }
        return target.unlinkSync(file);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  assert.throws(() => acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-withdrawal-cleanup-failure'),
    { fileSystem },
  ), /injected withdrawal unlink failure/);
  assert.equal(unlinkFailures, 4);
  fs.rmdirSync(recovery);
  await waitUntil(
    () => !fs.existsSync(guard)
      && fs.readdirSync(scout)
        .every((entry) => !entry.startsWith('scan-lease.guard.candidate.')),
    'post-publication withdrawal did not recover in the background',
  );
});

test('a stale pending cleanup ID never moves or exposes a live successor guard', () => {
  const root = temp();
  const injected = stalePendingCleanupFileSystem(root);
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-stale-cleanup'), {
    fileSystem: injected.fileSystem, guardAcquireTimeoutMs: 100,
  });
  assert.equal(injected.state.failedOwnMarkerUnlinks, 4);
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.rmSync(guard, { recursive: true, force: true });
  fs.mkdirSync(guard);
  fs.writeFileSync(path.join(guard, `${injected.successorId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    guardId: injected.successorId,
    owner: currentLeaseOwner(),
    acquiredAt: new Date().toISOString(),
  })}\n`, 'utf8');
  assert.throws(() => assertCurrentFence(
    lease, synchronousFenceCallback(() => true),
  ), LeaseLostError);
  assert.equal(injected.state.successorMoved, false);
  assert.equal(injected.state.successorRemoved, false);
  assert.equal(fs.existsSync(path.join(guard, `${injected.successorId}.json`)), true);
});

test('bounded same-owner cleanup recovers transient metadata and removal failures', () => {
  const root = temp();
  const injected = injectedGuardFileSystem({
    failMarkerUnlink: 1,
    failDirectoryRemove: 1,
  });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-cleanup'), {
    fileSystem: injected.fileSystem,
  });
  assert.equal(injected.state.markerUnlinks, 1);
  assert.equal(injected.state.directoryRemoves, 1);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), false);
  releaseScanLease(lease);
});

test('cleanup preserves the original guarded-action error after a transient failure', () => {
  const root = temp();
  const injected = injectedGuardFileSystem({ failDirectoryRemove: 1 });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-cleanup-error'), {
    fileSystem: injected.fileSystem,
  });
  const expected = new Error('guarded action failed');
  assert.throws(() => assertCurrentFence(
    lease,
    synchronousFenceCallback(() => { throw expected; }),
  ), (error) => error === expected);
  assert.equal(injected.state.directoryRemoves, 1);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), false);
  releaseScanLease(lease);
});

test('a committed action retains its result and the same owner recovers an exhausted cleanup claim', () => {
  const root = temp();
  const injected = injectedGuardFileSystem({ failDirectoryRemove: 4 });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-cleanup-recovery'), {
    fileSystem: injected.fileSystem,
  });
  assert.equal(lease.runId, 'run-cleanup-recovery');
  assert.equal(injected.state.directoryRemoves, 4);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), false);
  assert.equal(
    fs.readdirSync(path.join(root, '.scout'))
      .filter((entry) => entry.startsWith('scan-lease.guard.candidate.')).length,
    1,
  );
  assert.doesNotThrow(() => assertCurrentFence(lease, synchronousFenceCallback(() => true)));
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), false);
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.scout'))
      .filter((entry) => entry.startsWith('scan-lease.guard.candidate.')),
    [],
  );
  releaseScanLease(lease);
});

test('the same lease runtime recovers after marker-unlink retries are exhausted', () => {
  const root = temp();
  const injected = injectedGuardFileSystem({ failMarkerUnlink: 4 });
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-cleanup-rename'), {
    fileSystem: injected.fileSystem,
  });
  assert.equal(lease.runId, 'run-cleanup-rename');
  assert.equal(injected.state.markerUnlinks, 4);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), true);
  assert.doesNotThrow(() => assertCurrentFence(lease, synchronousFenceCallback(() => true)));
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')), false);
  releaseScanLease(lease);
});

test('marker-unlink exhaustion preserves a throwing action and remains recoverable', async () => {
  const injected = injectedGuardFileSystem({ failMarkerUnlink: 4 });
  const expected = new Error('guarded action failed before marker cleanup');
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
  assert.equal(injected.state.markerUnlinks, 4);
  await waitUntil(
    () => !fs.existsSync(path.join(failingRoot, '.scout', 'scan-lease.guard')),
    'failed action guard cleanup did not recover in the background',
  );
  const recovered = acquireScanLease(
    failingRoot,
    currentLeaseOwner(),
    operation('run-cleanup-rename-error-recovery'),
    { fileSystem: injected.fileSystem },
  );
  assert.equal(recovered?.runId, 'run-cleanup-rename-error-recovery');
  releaseScanLease(recovered);
});

test('terminal release reports cleanup failure and recovers without another lease operation', async () => {
  const root = temp();
  const injected = injectedGuardFileSystem();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-terminal-cleanup'), {
    fileSystem: injected.fileSystem,
  });
  injected.state.markerFailuresRemaining = 4;
  assert.throws(() => releaseScanLease(lease), /cleanup/i);
  await waitUntil(
    () => !fs.existsSync(path.join(root, '.scout', 'scan-lease.guard')),
    'terminal cleanup did not recover without another lease operation',
  );
  const successor = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation('run-after-terminal-cleanup'),
    { fileSystem: injected.fileSystem },
  );
  assert.equal(successor?.runId, 'run-after-terminal-cleanup');
  releaseScanLease(successor);
});

test('guard metadata with unknown fields is not trusted for stale quarantine', async () => {
  const root = temp();
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'guard-extra-field.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: 'guard-extra-field',
    owner: { host: os.hostname(), pid: 999_999_999, processStart: 'dead-process' },
    acquiredAt: new Date(Date.now() - 31_000).toISOString(),
    secret: ['must', 'not', 'be', 'accepted'].join('-'),
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

test('a promise-returning normal callback is rejected before its side effect starts', async () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('run-promise-callback'));
  const output = path.join(root, 'async-side-effect');
  let started = false;
  let pending;
  assert.throws(() => assertCurrentFence(lease, () => {
    started = true;
    pending = fs.promises.writeFile(output, 'must-not-run', 'utf8');
    return pending;
  }), /synchronous/i);
  if (pending) await pending;
  assert.equal(started, false);
  assert.equal(fs.existsSync(output), false);
  releaseScanLease(lease);
});

test('a fenced commit propagates its own EEXIST error without retrying the commit', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'run-error', provider: 'codex', mode: 'primary',
  });
  let calls = 0;
  const expected = Object.assign(new Error('target already exists'), { code: 'EEXIST' });

  assert.throws(() => assertCurrentFence(lease, synchronousFenceCallback(() => {
    calls += 1;
    throw expected;
  })), (error) => error === expected);
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

test('lease handoff atomically changes run scope and invalidates the provisional fence', () => {
  const root = temp();
  const provisional = acquireScanLease(root, currentLeaseOwner(), operation('provisional-run'));
  const recovered = handoffScanLease(provisional, operation('recoverable-run'));

  assert.equal(recovered.runId, 'recoverable-run');
  assert.equal(recovered.generation, provisional.generation + 1);
  assert.equal(readScanLease(root).runId, 'recoverable-run');
  assert.throws(
    () => assertCurrentFence(provisional, synchronousFenceCallback(() => true)),
    LeaseLostError,
  );
  assert.doesNotThrow(() => assertCurrentFence(recovered, synchronousFenceCallback(() => true)));
  releaseScanLease(recovered);
});

test('lease module exposes no generic observed-non-owner mutation callback', () => {
  assert.equal(scanLeaseModule.withObservedActiveScanLease, undefined);
  assert.equal(typeof scanLeaseModule.appendObservedScanQueueEvent, 'function');
});
