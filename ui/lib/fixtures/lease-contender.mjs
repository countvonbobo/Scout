import fs from 'node:fs';
import path from 'node:path';
import {
  LeaseLostError,
  acquireScanLease,
  assertCurrentFence,
  currentLeaseOwner,
  releaseScanLease,
  startLeaseHeartbeat,
} from '../scanLease.mjs';
import { commitRunArtifact } from '../runArtifacts.mjs';
import { appendRunEvent, openRunJournal } from '../runJournal.mjs';
import { acquireScanLock, releaseScanLock } from '../../../tools/scan-lock.mjs';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path.basename(file)}`);
    await pause(5);
  }
}

function timing(duration, margin, guardAcquireTimeoutMs = 2_000) {
  return {
    leaseDurationMs: Number(duration),
    takeoverMarginMs: Number(margin),
    guardAcquireTimeoutMs: Number(guardAcquireTimeoutMs),
  };
}

function operation(runId) {
  return { kind: 'scan', runId, provider: 'codex', mode: 'primary', phase: 'collect' };
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const [command, root, ...args] = process.argv.slice(2);

if (command === 'race-acquire') {
  const [gate, runId, duration, margin] = args;
  fs.writeFileSync(`${gate}.${process.pid}.ready`, '', 'utf8');
  await waitFor(gate);
  const lease = acquireScanLease(root, currentLeaseOwner(), operation(runId), timing(duration, margin));
  write({ acquired: Boolean(lease), lease });
} else if (command === 'acquire') {
  const [runId, duration, margin, guardTimeout] = args;
  const lease = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation(runId),
    timing(duration, margin, guardTimeout),
  );
  write({ acquired: Boolean(lease), lease });
} else if (command === 'heartbeat-owner') {
  const [ready, stop, runId, duration, interval, margin] = args;
  const options = timing(duration, margin);
  const lease = acquireScanLease(root, currentLeaseOwner(), operation(runId), options);
  if (!lease) throw new Error('heartbeat owner could not acquire the lease');
  const heartbeat = startLeaseHeartbeat(lease, { intervalMs: Number(interval) });
  fs.writeFileSync(ready, JSON.stringify(lease), 'utf8');
  await waitFor(stop);
  heartbeat.stop();
  releaseScanLease(lease);
  write({ acquired: true, lost: heartbeat.lost, lease });
} else if (command === 'stale-append-owner') {
  const [ready, proceed, runId, duration, margin] = args;
  const lease = acquireScanLease(
    root,
    currentLeaseOwner(),
    operation(runId),
    timing(duration, margin),
  );
  if (!lease) throw new Error('stale append owner could not acquire the lease');
  const run = openRunJournal(root, runId);
  fs.writeFileSync(ready, JSON.stringify(lease), 'utf8');
  await waitFor(proceed);
  const result = { journalAppended: false, artifactCommitted: false, leaseLost: 0 };
  try {
    appendRunEvent(run, {
      type: 'stage.completed',
      stageId: 'collect',
      idempotencyKey: 'collect-v1',
      payload: { schemaVersion: 1, count: 0 },
    }, lease);
    result.journalAppended = true;
  } catch (error) {
    if (error instanceof LeaseLostError) result.leaseLost += 1;
    else throw error;
  }
  try {
    commitRunArtifact(
      run,
      { id: 'collect-v1', schemaVersion: 1 },
      { schemaVersion: 1, stableIds: [] },
      lease,
    );
    result.artifactCommitted = true;
  } catch (error) {
    if (error instanceof LeaseLostError) result.leaseLost += 1;
    else throw error;
  }
  write(result);
} else if (command === 'hold-guard') {
  const [ready, stop, acquiredAt] = args;
  const guard = path.join(root, '.scout', 'scan-lease.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1,
    guardId: `guard-${process.pid}`,
    owner: currentLeaseOwner(),
    acquiredAt,
  })}\n`, 'utf8');
  fs.writeFileSync(ready, '', 'utf8');
  await waitFor(stop);
  fs.rmSync(guard, { recursive: true, force: true });
  write({ held: true });
} else if (command === 'adversarial-recover') {
  const [observed, proceed, active, release, overlap, runId, moved, resumeAfterMove] = args;
  const lease = acquireScanLease(root, currentLeaseOwner(), operation(runId), {
    leaseDurationMs: 5_000,
    takeoverMarginMs: 0,
    _testHooks: {
      afterGuardObservation() {
        fs.writeFileSync(observed, '', 'utf8');
        while (!fs.existsSync(proceed)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      },
      afterGuardRecoveryRename() {
        if (!moved) return;
        fs.writeFileSync(moved, '', 'utf8');
        if (!resumeAfterMove) return;
        while (!fs.existsSync(resumeAfterMove)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      },
      beforeGuardedAction() {
        if (fs.existsSync(active)) fs.writeFileSync(overlap, '', 'utf8');
      },
    },
  });
  write({ acquired: Boolean(lease) });
} else if (command === 'gap-contender') {
  const [checked, proceed, active, overlap, runId] = args;
  const lease = acquireScanLease(root, currentLeaseOwner(), operation(runId), {
    leaseDurationMs: 5_000,
    takeoverMarginMs: 0,
    _testHooks: {
      afterRecoveryCheck() {
        fs.writeFileSync(checked, '', 'utf8');
        while (!fs.existsSync(proceed)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      },
      beforeGuardedAction() {
        if (fs.existsSync(active)) fs.writeFileSync(overlap, '', 'utf8');
      },
    },
  });
  write({ acquired: Boolean(lease) });
} else if (command === 'recover-and-hold') {
  const [entered, release, active, overlap, runId] = args;
  const lease = acquireScanLease(root, currentLeaseOwner(), operation(runId), {
    leaseDurationMs: 5_000,
    takeoverMarginMs: 0,
    _testHooks: {
      beforeGuardedAction() {
        if (fs.existsSync(active)) fs.writeFileSync(overlap, '', 'utf8');
      },
    },
  });
  if (!lease) throw new Error('recovery holder could not acquire');
  assertCurrentFence(lease, () => {
    if (fs.existsSync(active)) fs.writeFileSync(overlap, '', 'utf8');
    fs.writeFileSync(active, '', 'utf8');
    fs.writeFileSync(entered, '', 'utf8');
    while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    fs.rmSync(active, { force: true });
  });
  releaseScanLease(lease);
  write({ acquired: true });
} else if (command === 'legacy-acquire') {
  const [token] = args;
  write(acquireScanLock(root, { agent: 'codex', mode: 'primary', token }));
} else if (command === 'legacy-release') {
  const [token] = args;
  write(releaseScanLock(root, token));
} else if (command === 'plain-write-after-signal') {
  const [ready, proceed, runId] = args;
  const run = openRunJournal(root, runId);
  const plain = { leaseId: 'plain-worker', generation: 1, runId };
  fs.writeFileSync(ready, '', 'utf8');
  await waitFor(proceed);
  try {
    appendRunEvent(run, {
      type: 'stage.completed', stageId: 'collect', idempotencyKey: 'plain-v1',
      payload: { schemaVersion: 1, count: 0 },
    }, plain);
    write({ appended: true });
  } catch (error) {
    write({ appended: false, leaseLost: error instanceof LeaseLostError });
  }
} else if (command === 'owner') {
  write(currentLeaseOwner());
} else {
  throw new Error(`unknown lease contender command: ${command}`);
}
