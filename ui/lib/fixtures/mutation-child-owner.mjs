import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { atomicWriteFile } from '../atomicWrite.mjs';
import { withMutationCoordinator } from '../mutationCoordinator.mjs';
import { acquireScanLease, currentLeaseOwner } from '../scanLease.mjs';

const [root, phase, marker] = process.argv.slice(2);
const lease = acquireScanLease(
  root,
  currentLeaseOwner(),
  { kind: 'backup', runId: `owner-${phase}`, phase: 'checkpoint' },
  { leaseDurationMs: 10_000, takeoverMarginMs: 0 },
);
if (!lease) throw new Error('fixture could not acquire its scan lease');

await withMutationCoordinator(root, lease, async (coordinator) => {
  const operationId = coordinator.beginChild(phase);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  coordinator.attachChild(operationId, child.pid);
  child.unref();
  atomicWriteFile(marker, JSON.stringify({
    childPid: child.pid,
    generation: lease.generation,
    leaseId: lease.leaseId,
    operationId,
    ownerPid: process.pid,
    leaseExpiresAt: lease.expiresAt,
  }), { mode: 0o600 });
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await new Promise(() => {});
  } finally {
    clearInterval(keepAlive);
  }
});
