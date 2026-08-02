import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import {
  LeaseMigrationError,
  acquireScanLease,
  currentLeaseOwner,
  isFencedLeaseActivated,
  readScanLease,
  releaseScanLeaseByToken,
} from '../ui/lib/scanLease.mjs';
import { resolveWorkspaceRoot } from '../ui/lib/workspace.mjs';

export const LOCK_FILE = '.scout-scan.lock';
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

export function scanLockPath(repoRoot) {
  return path.join(repoRoot, LOCK_FILE);
}

export function readScanLock(repoRoot) {
  try {
    const legacyFile = scanLockPath(repoRoot);
    const lease = readScanLease(repoRoot);
    if (fs.existsSync(legacyFile)) {
      if (isFencedLeaseActivated(repoRoot)) {
        return {
          invalid: true,
          reason: 'downgrade-coexistence',
          message: 'Legacy Scout downgrade/coexistence detected after fenced lease activation. '
            + 'Stop old Scout, remove .scout-scan.lock only after confirming it stopped, and retry.',
        };
      }
      const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      return {
        agent: legacy.agent,
        mode: legacy.mode,
        token: legacy.token,
        startedAt: legacy.startedAt,
      };
    }
    if (!lease) return null;
    return {
      agent: lease.operation.provider ?? lease.operation.kind,
      mode: lease.operation.mode ?? lease.operation.kind,
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
  const previous = readScanLock(repoRoot);
  let lease;
  try {
    lease = acquireScanLease(repoRoot, currentLeaseOwner(), {
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
  } catch (error) {
    if (error instanceof LeaseMigrationError) {
      return {
        ok: false,
        reason: 'migration-blocked',
        message: error.message,
        lock: readScanLock(repoRoot),
      };
    }
    throw error;
  }
  if (!lease) return { ok: false, reason: 'active', lock: readScanLock(repoRoot) };
  return {
    ok: true,
    lock: { agent, mode, token: lease.leaseId, startedAt: now.toISOString() },
    recoveredStale: Boolean(previous),
  };
}

export function releaseScanLock(repoRoot, token) {
  const current = readScanLock(repoRoot);
  if (!current) return { ok: true, released: false };
  if (current.reason === 'downgrade-coexistence') {
    return {
      ok: false,
      reason: 'migration-blocked',
      message: current.message,
      lock: current,
    };
  }
  if (!token || current.token !== token) return { ok: false, reason: 'token-mismatch', lock: current };
  try {
    if (!releaseScanLeaseByToken(repoRoot, token)) {
      return { ok: false, reason: 'token-mismatch', lock: readScanLock(repoRoot) };
    }
    return { ok: true, released: true };
  } catch (error) {
    if (error instanceof LeaseMigrationError) {
      return {
        ok: false,
        reason: 'migration-blocked',
        message: error.message,
        lock: readScanLock(repoRoot),
      };
    }
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
