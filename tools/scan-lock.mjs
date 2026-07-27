import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import {
  acquireScanLease,
  currentLeaseOwner,
  readScanLease,
  releaseScanLease,
} from '../ui/lib/scanLease.mjs';
import { resolveWorkspaceRoot } from '../ui/lib/workspace.mjs';

export const LOCK_FILE = path.join('.scout', 'scan-lease.json');
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function scanLockPath(repoRoot) {
  return path.join(repoRoot, LOCK_FILE);
}

export function readScanLock(repoRoot) {
  try {
    const lease = readScanLease(repoRoot);
    if (!lease) return null;
    return {
      agent: lease.operation.provider,
      mode: lease.operation.mode,
      token: lease.leaseId,
      startedAt: lease.acquiredAt,
    };
  } catch {
    return { invalid: true };
  }
}

export function acquireScanLock(repoRoot, {
  agent,
  mode,
  now = new Date(),
  staleAfterMs = STALE_AFTER_MS,
  token = crypto.randomUUID(),
} = {}) {
  if (!agent || !mode) throw new Error('agent and mode are required');
  const previous = readScanLease(repoRoot);
  const lease = acquireScanLease(repoRoot, currentLeaseOwner(), {
    kind: 'scan',
    runId: `legacy-${crypto.randomUUID()}`,
    provider: agent,
    mode,
    phase: 'legacy',
  }, {
    now,
    leaseDurationMs: staleAfterMs,
    takeoverMarginMs: 0,
    leaseId: token,
  });
  if (!lease) return { ok: false, reason: 'active', lock: readScanLock(repoRoot) };
  return {
    ok: true,
    lock: { agent, mode, token: lease.leaseId, startedAt: now.toISOString() },
    recoveredStale: Boolean(previous),
  };
}

export function releaseScanLock(repoRoot, token) {
  const current = readScanLease(repoRoot);
  if (!current) return { ok: true, released: false };
  if (!token || current.leaseId !== token) return { ok: false, reason: 'token-mismatch', lock: readScanLock(repoRoot) };
  try {
    releaseScanLease({ ...current, root: path.resolve(repoRoot) });
    return { ok: true, released: true };
  } catch {
    return { ok: false, reason: 'token-mismatch', lock: readScanLock(repoRoot) };
  }
}

function cli() {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = resolveWorkspaceRoot({ appRoot });
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'acquire') result = acquireScanLock(repoRoot, { agent: args[0], mode: args[1] });
  else if (command === 'release') result = releaseScanLock(repoRoot, args[0]);
  else if (command === 'status') result = { ok: true, lock: readScanLock(repoRoot) };
  else throw new Error('usage: scan-lock.mjs acquire <agent> <mode> | release <token> | status');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const isMain = isMainModule(import.meta.url);
if (isMain) cli();
