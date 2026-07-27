import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { atomicWriteFile } from './atomicWrite.mjs';

export const SCAN_LEASE_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_DURATION_MS = 90_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_TAKEOVER_MARGIN_MS = 15_000;
export const GUARD_STALE_AFTER_MS = 30_000;

const LEASE_FILE = 'scan-lease.json';
const GENERATION_FILE = 'scan-lease-generation.json';
const GUARD_DIRECTORY = 'scan-lease.guard';
const RECOVERY_CLAIM_DIRECTORY = 'scan-lease.recovery-claim';
const LEGACY_LOCK_FILE = '.scout-scan.lock';
const LEGACY_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const CLEANUP_RETRY_LIMIT = 4;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const runtime = Symbol('scanLeaseRuntime');
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const pendingGuardCleanup = new Map();
const pendingRecoveryCleanup = new Map();
let cachedCurrentOwner;

export class LeaseLostError extends Error {
  constructor(message = 'scan lease is no longer current') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

class GuardBusyError extends Error {
  constructor() {
    super('scan lease guard is busy');
    this.name = 'GuardBusyError';
  }
}

function scoutDirectory(root) {
  return path.join(path.resolve(root), '.scout');
}

function leaseFile(root) {
  return path.join(scoutDirectory(root), LEASE_FILE);
}

function generationFile(root) {
  return path.join(scoutDirectory(root), GENERATION_FILE);
}

function guardDirectory(root) {
  return path.join(scoutDirectory(root), GUARD_DIRECTORY);
}

function recoveryDirectory(root) {
  return `${guardDirectory(root)}.recovery`;
}

function cleanupDirectory(root) {
  return `${guardDirectory(root)}.cleanup`;
}

function recoveryClaimDirectory(root) {
  return path.join(scoutDirectory(root), RECOVERY_CLAIM_DIRECTORY);
}

function recoveryClaimCleanupDirectory(root) {
  return `${recoveryClaimDirectory(root)}.cleanup`;
}

function legacyLockFile(root) {
  return path.join(path.resolve(root), LEGACY_LOCK_FILE);
}

function canonicalPath(value, fileSystem = fs) {
  const resolved = path.resolve(value);
  try {
    return fileSystem.realpathSync.native?.(resolved) ?? fileSystem.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function requireToken(value, name) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) {
    throw new TypeError(`${name} must be a bounded identifier`);
  }
  return value;
}

function requireTimestamp(value, name) {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be a UTC timestamp`);
  }
  return value;
}

function checkedOwner(owner) {
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)
    || Object.keys(owner).sort().join(',') !== 'host,pid,processStart') {
    throw new TypeError('scan lease owner must contain host, pid and processStart');
  }
  if (typeof owner.host !== 'string' || !owner.host || owner.host.length > 255 || /[\0\r\n]/.test(owner.host)) {
    throw new TypeError('scan lease owner host is invalid');
  }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new TypeError('scan lease owner PID is invalid');
  requireToken(owner.processStart, 'scan lease owner process-start identity');
  return { host: owner.host, pid: owner.pid, processStart: owner.processStart };
}

function checkedOperation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new TypeError('scan lease operation is required');
  }
  const allowed = new Set(['kind', 'runId', 'provider', 'model', 'mode', 'phase']);
  for (const key of Object.keys(operation)) {
    if (!allowed.has(key)) throw new TypeError(`scan lease operation property is not allowed: ${key}`);
  }
  if (typeof operation.runId !== 'string' || !SAFE_RUN_ID.test(operation.runId)) {
    throw new TypeError('scan lease run ID must be a bounded filesystem-safe identifier');
  }
  const result = { kind: requireToken(operation.kind, 'scan lease operation kind'), runId: operation.runId };
  for (const key of ['provider', 'model', 'mode', 'phase']) {
    if (operation[key] !== undefined && operation[key] !== null) {
      result[key] = requireToken(operation[key], `scan lease operation ${key}`);
    }
  }
  return result;
}

function sameOwner(left, right) {
  return left?.host === right?.host
    && left?.pid === right?.pid
    && left?.processStart === right?.processStart;
}

function darwinProcessStartIdentity(pid, formattedStart) {
  const boot = spawnSync('sysctl', ['-n', 'kern.boottime'], {
    encoding: 'utf8', timeout: 2_000,
  });
  const processInfo = spawnSync('sysctl', ['-b', `kern.proc.pid.${pid}`], {
    encoding: null, timeout: 2_000, maxBuffer: 1024 * 1024,
  });
  if (boot.status !== 0 || !boot.stdout.trim()
    || processInfo.status !== 0 || !Buffer.isBuffer(processInfo.stdout)) return null;
  const seconds = Math.floor(Date.parse(formattedStart) / 1000);
  if (!Number.isSafeInteger(seconds)) return null;
  const matches = [];
  for (let offset = 0; offset <= processInfo.stdout.length - 16; offset += 1) {
    if (Number(processInfo.stdout.readBigInt64LE(offset)) !== seconds) continue;
    const microseconds = Number(processInfo.stdout.readBigInt64LE(offset + 8));
    if (Number.isSafeInteger(microseconds) && microseconds >= 0 && microseconds < 1_000_000) {
      matches.push(microseconds);
    }
  }
  if (matches.length !== 1) return null;
  const session = createHash('sha256')
    .update(`${boot.stdout.trim()}\0${seconds}.${String(matches[0]).padStart(6, '0')}`)
    .digest('hex');
  return requireToken(`darwin-${session}`, 'process-start identity');
}

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      return requireToken(`linux-${bootId}-${fields[19]}`, 'process-start identity');
    }
    if (process.platform === 'win32') {
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const result = spawnSync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
      ], { encoding: 'utf8', timeout: 2_000, windowsHide: true });
      const ticks = result.status === 0 ? result.stdout.trim() : '';
      return /^\d+$/.test(ticks) ? `windows-${ticks}` : null;
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C' },
    });
    const started = result.status === 0 ? result.stdout.trim() : '';
    if (!started) return null;
    if (process.platform === 'darwin') {
      return darwinProcessStartIdentity(pid, started);
    }
    return requireToken(`posix-${Buffer.from(started).toString('base64url')}`, 'process-start identity');
  } catch {
    return null;
  }
}

export function currentLeaseOwner() {
  if (!cachedCurrentOwner) {
    const processStart = processStartIdentity(process.pid);
    if (!processStart) throw new Error('cannot determine the current process-start identity');
    cachedCurrentOwner = Object.freeze({ host: os.hostname(), pid: process.pid, processStart });
  }
  return cachedCurrentOwner;
}

function ownerIsLive(owner) {
  // A different host is unverifiable, not dead. Preserving its guard is the
  // only safe choice for a workspace unexpectedly shared across hosts.
  if (owner?.host !== os.hostname()) return true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return error?.code === 'EPERM';
  }
  const currentStart = processStartIdentity(owner.pid);
  if (currentStart) return currentStart === owner.processStart;
  // If the platform cannot inspect another live process safely, preserve the
  // guard. A false live result delays recovery; a false dead result permits
  // simultaneous writers.
  return true;
}

function wallMilliseconds(options) {
  if (typeof options.wallNow === 'function') return Number(options.wallNow());
  if (options.now instanceof Date) return options.now.getTime();
  if (typeof options.now === 'number') return options.now;
  return Date.now();
}

function timingOptions(options = {}) {
  const checked = {
    leaseDurationMs: options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    takeoverMarginMs: options.takeoverMarginMs ?? DEFAULT_TAKEOVER_MARGIN_MS,
    guardAcquireTimeoutMs: options.guardAcquireTimeoutMs ?? 2_000,
    wallNow: options.wallNow,
    monotonicNow: options.monotonicNow ?? (() => performance.now()),
    now: options.now,
    leaseId: options.leaseId,
    fileSystem: options.fileSystem ?? fs,
    hooks: options._testHooks ?? {},
  };
  if (!Number.isFinite(checked.leaseDurationMs) || checked.leaseDurationMs <= 0) {
    throw new TypeError('scan lease duration must be positive');
  }
  if (!Number.isFinite(checked.takeoverMarginMs) || checked.takeoverMarginMs < 0) {
    throw new TypeError('scan lease takeover margin must be non-negative');
  }
  if (!Number.isFinite(checked.guardAcquireTimeoutMs) || checked.guardAcquireTimeoutMs < 0) {
    throw new TypeError('scan lease guard timeout must be non-negative');
  }
  if (checked.leaseId !== undefined) requireToken(checked.leaseId, 'scan lease ID');
  return checked;
}

function readJson(file, fileSystem = fs) {
  return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
}

function validateLeaseRecord(record) {
  const expectedKeys = [
    'acquiredAt', 'expiresAt', 'generation', 'heartbeatAt', 'heartbeatSequence',
    'lastTerminalSequence', 'leaseId', 'operation', 'owner', 'recoveryCount',
    'runId', 'schemaVersion', 'takeoverMarginMs',
  ];
  const previousV1Keys = expectedKeys.filter((key) => key !== 'takeoverMarginMs');
  const actualKeys = Object.keys(record || {}).sort().join(',');
  const currentShape = expectedKeys.sort().join(',');
  const previousV1Shape = previousV1Keys.sort().join(',');
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || (actualKeys !== currentShape && actualKeys !== previousV1Shape)) {
    throw new Error('scan lease record is invalid');
  }
  if (record.schemaVersion !== SCAN_LEASE_SCHEMA_VERSION) {
    throw new Error(`unsupported scan lease schema version: ${record.schemaVersion}`);
  }
  requireToken(record.leaseId, 'scan lease ID');
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw new Error('scan lease generation is invalid');
  }
  const operation = checkedOperation(record.operation);
  if (record.runId !== operation.runId) throw new Error('scan lease run ID does not match its operation');
  checkedOwner(record.owner);
  requireTimestamp(record.acquiredAt, 'scan lease acquisition time');
  requireTimestamp(record.heartbeatAt, 'scan lease heartbeat time');
  requireTimestamp(record.expiresAt, 'scan lease expiry time');
  if (!Number.isSafeInteger(record.heartbeatSequence) || record.heartbeatSequence < 0) {
    throw new Error('scan lease heartbeat sequence is invalid');
  }
  if (!Number.isSafeInteger(record.recoveryCount) || record.recoveryCount < 0) {
    throw new Error('scan lease recovery count is invalid');
  }
  const takeoverMarginMs = actualKeys === previousV1Shape
    ? (operation.phase === 'legacy' ? 0 : DEFAULT_TAKEOVER_MARGIN_MS)
    : record.takeoverMarginMs;
  if (!Number.isFinite(takeoverMarginMs) || takeoverMarginMs < 0) {
    throw new Error('scan lease takeover margin is invalid');
  }
  if (record.lastTerminalSequence !== null
    && (!Number.isSafeInteger(record.lastTerminalSequence) || record.lastTerminalSequence < 1)) {
    throw new Error('scan lease terminal sequence is invalid');
  }
  return takeoverMarginMs === record.takeoverMarginMs
    ? record
    : { ...record, takeoverMarginMs };
}

export function readScanLease(root) {
  const file = leaseFile(root);
  if (!fs.existsSync(file)) return null;
  return validateLeaseRecord(readJson(file));
}

function readGeneration(root) {
  const file = generationFile(root);
  if (!fs.existsSync(file)) return 0;
  const record = readJson(file);
  if (!record || Object.keys(record).sort().join(',') !== 'generation,schemaVersion'
    || record.schemaVersion !== SCAN_LEASE_SCHEMA_VERSION
    || !Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw new Error('scan lease generation record is invalid');
  }
  return record.generation;
}

function writeJsonAtomic(file, value, fileSystem = fs) {
  atomicWriteFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600, fileSystem });
}

function validateGuardMetadata(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== 'acquiredAt,guardId,owner,schemaVersion'
    || record.schemaVersion !== SCAN_LEASE_SCHEMA_VERSION) {
    throw new Error('scan lease guard metadata is invalid');
  }
  requireToken(record.guardId, 'scan lease guard ID');
  checkedOwner(record.owner);
  requireTimestamp(record.acquiredAt, 'scan lease guard acquisition time');
  return record;
}

function readGuardMetadata(guard, fileSystem = fs) {
  try {
    return validateGuardMetadata(readJson(path.join(guard, 'owner.json'), fileSystem));
  } catch {
    return null;
  }
}

function readGuardMetadataStrict(guard, fileSystem = fs) {
  return validateGuardMetadata(readJson(path.join(guard, 'owner.json'), fileSystem));
}

function guardAge(guard, metadata, now, fileSystem = fs) {
  const acquired = Date.parse(metadata?.acquiredAt || '');
  if (Number.isFinite(acquired)) return now - acquired;
  try {
    return now - fileSystem.statSync(guard).mtimeMs;
  } catch {
    return 0;
  }
}

function staleAndRecoverable(guard, metadata, now, fileSystem = fs) {
  return guardAge(guard, metadata, now, fileSystem) >= GUARD_STALE_AFTER_MS
    && (!metadata || !ownerIsLive(metadata.owner));
}

function quarantinePath(guard, now) {
  return `${guard}.quarantine.${new Date(now).toISOString().replace(/[:.]/g, '-')}.${randomUUID()}`;
}

function retrySync(action, retryable = () => true) {
  let lastError;
  for (let attempt = 0; attempt < CLEANUP_RETRY_LIMIT; attempt += 1) {
    try {
      return action();
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === CLEANUP_RETRY_LIMIT - 1) throw error;
      Atomics.wait(sleepArray, 0, 0, 5);
    }
  }
  throw lastError;
}

function removeClaim(directory, fileSystem) {
  retrySync(
    () => fileSystem.rmSync(directory, { recursive: true, force: true }),
    (error) => ['EBUSY', 'EPERM', 'EACCES', 'EIO', 'ENOENT'].includes(error?.code),
  );
}

function cleanupOwnedGuard(root, guardId, options) {
  const fileSystem = options.fileSystem;
  const guard = guardDirectory(root);
  const cleanup = cleanupDirectory(root);
  retrySync(() => {
    try {
      fileSystem.renameSync(guard, cleanup);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (fileSystem.existsSync(cleanup)) return;
      // A stale contender may have moved this live guard to the fixed
      // recovery claim. Moving that exact directory to cleanup is safe; the
      // contender's attempted restore will then fail without touching a
      // successor.
      try {
        fileSystem.renameSync(recoveryDirectory(root), cleanup);
        return;
      } catch (recoveryError) {
        if (!['ENOENT', 'EEXIST'].includes(recoveryError?.code)) throw recoveryError;
        throw error;
      }
    }
  }, (error) => ['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code));
  let metadata;
  try {
    metadata = retrySync(
      () => readGuardMetadataStrict(cleanup, fileSystem),
      (error) => ['EBUSY', 'EPERM', 'EACCES', 'EIO'].includes(error?.code),
    );
  } catch (error) {
    // The moved directory is stable behind the fixed cleanup claim. Leave it
    // for bounded same-owner recovery rather than deleting an unverified path.
    throw error;
  }
  if (metadata.guardId !== guardId) {
    try {
      fileSystem.renameSync(cleanup, guard);
    } catch {}
    throw new Error('scan lease guard ownership changed before cleanup');
  }
  removeClaim(cleanup, fileSystem);
}

function recoveryArbitrationState(root, options) {
  const fileSystem = options.fileSystem;
  const claim = recoveryClaimDirectory(root);
  const cleanup = recoveryClaimCleanupDirectory(root);
  const now = wallMilliseconds(options);
  for (const directory of [cleanup, claim]) {
    if (!fileSystem.existsSync(directory)) continue;
    const metadata = readGuardMetadata(directory, fileSystem);
    if (!staleAndRecoverable(directory, metadata, now, fileSystem)) return 'wait';
    if (directory === cleanup) {
      removeClaim(cleanup, fileSystem);
      return 'retry';
    }
    try {
      fileSystem.renameSync(claim, cleanup);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return 'retry';
      throw error;
    }
    const moved = readGuardMetadata(cleanup, fileSystem);
    if (!moved || moved.guardId !== metadata?.guardId
      || !staleAndRecoverable(cleanup, moved, now, fileSystem)) {
      try { fileSystem.renameSync(cleanup, claim); } catch {}
      return 'wait';
    }
    removeClaim(cleanup, fileSystem);
    return 'retry';
  }
  return 'none';
}

function cleanupRecoveryArbitration(root, claimId, options) {
  const fileSystem = options.fileSystem;
  const claim = recoveryClaimDirectory(root);
  const cleanup = recoveryClaimCleanupDirectory(root);
  if (!fileSystem.existsSync(cleanup)) {
    retrySync(
      () => fileSystem.renameSync(claim, cleanup),
      (error) => ['EBUSY', 'EPERM', 'EACCES'].includes(error?.code),
    );
  }
  const metadata = readGuardMetadataStrict(cleanup, fileSystem);
  if (metadata.guardId !== claimId) {
    try { fileSystem.renameSync(cleanup, claim); } catch {}
    throw new Error('scan lease recovery arbitration ownership changed');
  }
  removeClaim(cleanup, fileSystem);
}

function withRecoveryArbitration(root, owner, options, action) {
  const fileSystem = options.fileSystem;
  const claim = recoveryClaimDirectory(root);
  const state = recoveryArbitrationState(root, options);
  if (state !== 'none') return { acquired: false, retry: state === 'retry' };
  const claimId = randomUUID();
  try {
    fileSystem.mkdirSync(claim);
  } catch (error) {
    if (error?.code === 'EEXIST') return { acquired: false, retry: true };
    throw error;
  }
  let initialized = false;
  let result;
  let actionError;
  try {
    writeJsonAtomic(path.join(claim, 'owner.json'), {
      schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
      guardId: claimId,
      owner,
      acquiredAt: new Date(wallMilliseconds(options)).toISOString(),
    }, fileSystem);
    initialized = true;
    result = action();
  } catch (error) {
    actionError = error;
  }
  let cleanupError;
  if (!initialized) {
    try { fileSystem.rmSync(claim, { recursive: true, force: true }); } catch {}
  } else {
    try {
      cleanupRecoveryArbitration(root, claimId, options);
    } catch (error) {
      cleanupError = error;
      pendingRecoveryCleanup.set(canonicalPath(root, fileSystem), claimId);
    }
  }
  if (actionError) throw actionError;
  if (cleanupError) throw cleanupError;
  return { acquired: true, result };
}

function recoverClaims(root, options) {
  const fileSystem = options.fileSystem;
  const guard = guardDirectory(root);
  const recovery = recoveryDirectory(root);
  const cleanup = cleanupDirectory(root);
  const now = wallMilliseconds(options);

  if (fileSystem.existsSync(cleanup)) {
    // A cleanup claim is created only after its guarded action has finished.
    // Removing the moved directory cannot target a canonical successor.
    removeClaim(cleanup, fileSystem);
    return 'retry';
  }

  if (!fileSystem.existsSync(recovery)) return 'none';
  const metadata = readGuardMetadata(recovery, fileSystem);
  if (fileSystem.existsSync(guard)) {
    // A canonical guard may have been created in the instant after a stale
    // observer moved a live successor here. Never discard that moved guard:
    // the new canonical creator must notice the recovery claim and withdraw.
    if (staleAndRecoverable(recovery, metadata, now, fileSystem)) {
      try { fileSystem.renameSync(recovery, quarantinePath(guard, now)); } catch {}
      return 'retry';
    }
    return 'wait';
  }
  if (staleAndRecoverable(recovery, metadata, now, fileSystem)) {
    try {
      fileSystem.renameSync(recovery, quarantinePath(guard, now));
    } catch (error) {
      if (!['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    }
    return 'retry';
  }
  try {
    fileSystem.renameSync(recovery, guard);
  } catch (error) {
    if (['EEXIST', 'ENOENT', 'EPERM', 'EACCES'].includes(error?.code)) return 'retry';
    throw error;
  }
  return 'wait';
}

function withGuard(root, owner, options, action) {
  const directory = scoutDirectory(root);
  const guard = guardDirectory(root);
  const recovery = recoveryDirectory(root);
  const fileSystem = options.fileSystem;
  fileSystem.mkdirSync(directory, { recursive: true });
  const cleanupKey = canonicalPath(root, fileSystem);
  const pendingRecoveryClaimId = pendingRecoveryCleanup.get(cleanupKey);
  if (pendingRecoveryClaimId) {
    cleanupRecoveryArbitration(root, pendingRecoveryClaimId, options);
    pendingRecoveryCleanup.delete(cleanupKey);
  }
  const pendingGuardId = options.cleanupPending?.guardId ?? pendingGuardCleanup.get(cleanupKey);
  if (pendingGuardId) {
    cleanupOwnedGuard(root, pendingGuardId, options);
    pendingGuardCleanup.delete(cleanupKey);
    delete options.cleanupPending;
  }
  const deadline = performance.now() + options.guardAcquireTimeoutMs;
  const guardId = randomUUID();
  const acquiredAt = new Date(wallMilliseconds(options)).toISOString();

  while (true) {
    const arbitration = recoveryArbitrationState(root, options);
    if (arbitration !== 'none') {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new GuardBusyError();
      Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
      continue;
    }
    const claim = recoverClaims(root, options);
    if (claim === 'wait' || claim === 'retry') {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new GuardBusyError();
      Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
      continue;
    }
    options.hooks.afterRecoveryCheck?.();
    try {
      fileSystem.mkdirSync(guard);
      try {
        writeJsonAtomic(path.join(guard, 'owner.json'), {
          schemaVersion: SCAN_LEASE_SCHEMA_VERSION, guardId, owner, acquiredAt,
        }, fileSystem);
      } catch (metadataError) {
        try { fileSystem.rmSync(guard, { recursive: true, force: true }); } catch {}
        throw metadataError;
      }
      // Recovery is a visible hand-off marker. A contender that checked just
      // before another process moved a live guard must withdraw its newly
      // created canonical guard instead of entering the protected action.
      if (fileSystem.existsSync(recovery)
        || fileSystem.existsSync(recoveryClaimDirectory(root))
        || fileSystem.existsSync(recoveryClaimCleanupDirectory(root))) {
        cleanupOwnedGuard(root, guardId, options);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new GuardBusyError();
        Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
        continue;
      }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const metadata = readGuardMetadata(guard, fileSystem);
      if (staleAndRecoverable(guard, metadata, wallMilliseconds(options), fileSystem)) {
        options.hooks.afterGuardObservation?.();
        const recoveryAttempt = withRecoveryArbitration(root, owner, options, () => {
          const currentMetadata = readGuardMetadata(guard, fileSystem);
          if (!staleAndRecoverable(
            guard, currentMetadata, wallMilliseconds(options), fileSystem,
          )) return false;
          try {
            fileSystem.renameSync(guard, recovery);
          } catch (renameError) {
            if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(renameError?.code)) return false;
            throw renameError;
          }
          options.hooks.afterGuardRecoveryRename?.();
          return true;
        });
        if (recoveryAttempt.acquired && recoveryAttempt.result) {
          continue;
        }
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new GuardBusyError();
      Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
    }
  }

  let result;
  let actionError;
  try {
    options.hooks.beforeGuardedAction?.();
    result = action();
  } catch (error) {
    actionError = error;
  }
  try {
    cleanupOwnedGuard(root, guardId, options);
  } catch (cleanupError) {
    options.hooks.onCleanupFailure?.(cleanupError);
    const cleanupPending = { guardId, error: cleanupError };
    options.cleanupPending = cleanupPending;
    pendingGuardCleanup.set(cleanupKey, guardId);
    if (!actionError && result?.[runtime]) result[runtime].cleanupPending = cleanupPending;
  }
  if (actionError) throw actionError;
  return result;
}

function hydrateLease(root, record, options = {}) {
  const lease = {
    leaseId: record.leaseId,
    runId: record.runId,
    generation: record.generation,
    owner: { ...record.owner },
    expiresAt: record.expiresAt,
  };
  Object.defineProperty(lease, runtime, {
    enumerable: false,
    value: {
      root: canonicalPath(root, options.fileSystem ?? fs),
      leaseDurationMs: options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      takeoverMarginMs: record.takeoverMarginMs,
      guardAcquireTimeoutMs: options.guardAcquireTimeoutMs ?? 2_000,
      wallNow: options.wallNow,
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
      now: options.now,
      fileSystem: options.fileSystem ?? fs,
      hooks: options.hooks ?? options._testHooks ?? {},
      monotonicDeadline: (options.monotonicNow ?? (() => performance.now()))()
        + (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS),
      heartbeatSequence: record.heartbeatSequence,
    },
  });
  return lease;
}

function runtimeFor(lease) {
  if (lease?.[runtime]) return lease[runtime];
  throw new TypeError('scan lease was not acquired in this process');
}

export function isScanLease(lease) {
  return Boolean(lease?.[runtime]);
}

export function assertScanLeaseScope(lease, root, runId, directory, journalFile) {
  const settings = runtimeFor(lease);
  const canonicalRoot = canonicalPath(root, settings.fileSystem);
  if (canonicalRoot !== settings.root || lease.runId !== runId) {
    throw new LeaseLostError('scan lease does not own this workspace run');
  }
  const expectedDirectory = canonicalPath(path.join(
    settings.root, '.scout', 'runs', runId,
  ), settings.fileSystem);
  if (directory !== undefined && canonicalPath(directory, settings.fileSystem) !== expectedDirectory) {
    throw new LeaseLostError('scan lease run directory is outside its workspace');
  }
  if (journalFile !== undefined
    && canonicalPath(journalFile, settings.fileSystem) !== path.join(expectedDirectory, 'journal.jsonl')) {
    throw new LeaseLostError('scan lease journal file is outside its workspace run');
  }
  return true;
}

function currentProcessOwns(lease) {
  return sameOwner(lease.owner, currentLeaseOwner());
}

function sameFence(record, lease) {
  return record?.leaseId === lease?.leaseId
    && record?.generation === lease?.generation
    && record?.runId === lease?.runId
    && sameOwner(record?.owner, lease?.owner);
}

function locallyExpired(settings) {
  return settings.monotonicNow() >= settings.monotonicDeadline;
}

function removeLeaseFile(root, leaseId) {
  fs.rmSync(leaseFile(root), { force: true });
  const legacy = readLegacyLock(root);
  if (legacy?.fencedLease === true && legacy.token === leaseId) {
    fs.rmSync(legacyLockFile(root), { force: true });
  }
  try {
    const descriptor = fs.openSync(scoutDirectory(root), 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EISDIR'].includes(error?.code)) throw error;
  }
}

function readLegacyLock(root) {
  const file = legacyLockFile(root);
  if (!fs.existsSync(file)) return null;
  let record;
  try {
    record = readJson(file);
  } catch {
    return { invalid: true };
  }
  const keys = Object.keys(record || {}).sort().join(',');
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !['agent,mode,startedAt,token', 'agent,fencedLease,mode,startedAt,token'].includes(keys)
    || !SAFE_TOKEN.test(record.agent || '') || !SAFE_TOKEN.test(record.mode || '')
    || !SAFE_TOKEN.test(record.token || '') || Number.isNaN(Date.parse(record.startedAt || ''))
    || (record.fencedLease !== undefined && record.fencedLease !== true)) {
    return { invalid: true };
  }
  return record;
}

function legacyLockBlocksAcquisition(root, now, current) {
  const record = readLegacyLock(root);
  if (!record) {
    if (current) {
      writeLegacySentinel(
        root,
        current.operation,
        current.leaseId,
        Date.parse(current.heartbeatAt),
      );
    }
    return false;
  }
  if (record.fencedLease === true) {
    if (current) {
      if (current.leaseId !== record.token) {
        // Acquisition persists the compatibility sentinel before the lease so
        // an old binary never sees an unlocked window. Reconcile a crash in
        // that interval back to the still-current durable fence.
        writeLegacySentinel(
          root,
          current.operation,
          current.leaseId,
          Date.parse(current.heartbeatAt),
        );
      }
      return false;
    }
    if (!current) {
      fs.rmSync(legacyLockFile(root), { force: true });
      return false;
    }
  }
  const age = now - Date.parse(record.startedAt || '');
  if (record.invalid || !Number.isFinite(age) || age < LEGACY_STALE_AFTER_MS) return true;
  return false;
}

function writeLegacySentinel(root, operation, leaseId, now) {
  const file = legacyLockFile(root);
  const record = {
    agent: operation.provider ?? operation.kind,
    mode: operation.mode ?? operation.kind,
    token: leaseId,
    startedAt: new Date(now).toISOString(),
    fencedLease: true,
  };
  if (fs.existsSync(file)) {
    writeJsonAtomic(file, record);
    return true;
  }
  try {
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

function refreshLegacySentinel(root, operation, leaseId, now) {
  const current = readLegacyLock(root);
  if (!current || current.invalid || current.fencedLease !== true || current.token !== leaseId) {
    throw new LeaseLostError('legacy compatibility sentinel is no longer current');
  }
  writeJsonAtomic(legacyLockFile(root), {
    agent: operation.provider ?? operation.kind,
    mode: operation.mode ?? operation.kind,
    token: leaseId,
    startedAt: new Date(now).toISOString(),
    fencedLease: true,
  });
}

export function acquireScanLease(root, owner, operation, inputOptions = {}) {
  owner = checkedOwner(owner);
  if (!sameOwner(owner, currentLeaseOwner())) {
    throw new TypeError('scan lease owner does not identify the calling process');
  }
  operation = checkedOperation(operation);
  const options = timingOptions(inputOptions);
  try {
    return withGuard(root, owner, options, () => {
      const current = readScanLease(root);
      const now = wallMilliseconds(options);
      if (legacyLockBlocksAcquisition(root, now, current)) return null;
      if (current) {
        const takeoverAt = Date.parse(current.expiresAt) + current.takeoverMarginMs;
        if (now < takeoverAt) return null;
      }
      const leaseId = options.leaseId ?? randomUUID();
      if (!writeLegacySentinel(root, operation, leaseId, now)) return null;
      const generation = Math.max(readGeneration(root), current?.generation ?? 0) + 1;
      writeJsonAtomic(generationFile(root), {
        schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
        generation,
      });
      const timestamp = new Date(now).toISOString();
      const record = {
        schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
        leaseId,
        generation,
        runId: operation.runId,
        operation,
        owner,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt: new Date(now + options.leaseDurationMs).toISOString(),
        heartbeatSequence: 0,
        recoveryCount: current ? current.recoveryCount + 1 : 0,
        lastTerminalSequence: current?.lastTerminalSequence ?? null,
        takeoverMarginMs: options.takeoverMarginMs,
      };
      options.hooks.beforeLeaseReplace?.('acquire');
      writeJsonAtomic(leaseFile(root), record);
      return hydrateLease(root, record, options);
    });
  } catch (error) {
    if (error instanceof GuardBusyError) return null;
    throw error;
  }
}

export function assertCurrentFence(lease, commit) {
  if (typeof commit !== 'function') throw new TypeError('fenced commit callback is required');
  if (commit.constructor?.name === 'AsyncFunction') {
    throw new TypeError('fenced commit callback must be synchronous');
  }
  const settings = runtimeFor(lease);
  if (!currentProcessOwns(lease) || locallyExpired(settings)) throw new LeaseLostError();
  try {
    return withGuard(settings.root, lease.owner, settings, () => {
      const current = readScanLease(settings.root);
      if (!sameFence(current, lease) || locallyExpired(settings)) throw new LeaseLostError();
      const result = commit();
      if (result && typeof result.then === 'function') {
        throw new TypeError('fenced commit must complete synchronously');
      }
      return result;
    });
  } catch (error) {
    if (error instanceof GuardBusyError) throw new LeaseLostError();
    throw error;
  }
}

export function renewScanLease(lease) {
  const settings = runtimeFor(lease);
  if (!currentProcessOwns(lease) || locallyExpired(settings)) throw new LeaseLostError();
  try {
    return withGuard(settings.root, lease.owner, settings, () => {
      const current = readScanLease(settings.root);
      if (!sameFence(current, lease) || locallyExpired(settings)) throw new LeaseLostError();
      const now = wallMilliseconds(settings);
      const next = {
        ...current,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + settings.leaseDurationMs).toISOString(),
        heartbeatSequence: current.heartbeatSequence + 1,
      };
      settings.hooks.beforeLeaseReplace?.('renew');
      refreshLegacySentinel(settings.root, current.operation, lease.leaseId, now);
      writeJsonAtomic(leaseFile(settings.root), next);
      lease.expiresAt = next.expiresAt;
      settings.heartbeatSequence = next.heartbeatSequence;
      settings.monotonicDeadline = settings.monotonicNow() + settings.leaseDurationMs;
      return lease;
    });
  } catch (error) {
    if (error instanceof GuardBusyError) throw error;
    throw error;
  }
}

export function releaseScanLease(lease) {
  const settings = runtimeFor(lease);
  if (!currentProcessOwns(lease)) throw new LeaseLostError();
  try {
    return withGuard(settings.root, lease.owner, settings, () => {
      const current = readScanLease(settings.root);
      if (!sameFence(current, lease)) throw new LeaseLostError();
      removeLeaseFile(settings.root, lease.leaseId);
      return true;
    });
  } catch (error) {
    if (error instanceof GuardBusyError) throw new LeaseLostError();
    throw error;
  }
}

export function releaseScanLeaseByToken(root, token) {
  requireToken(token, 'legacy scan lock token');
  const owner = currentLeaseOwner();
  const options = timingOptions();
  try {
    return withGuard(root, owner, options, () => {
      const legacy = readLegacyLock(root);
      const current = readScanLease(root);
      if (legacy && !legacy.invalid && legacy.token === token && legacy.fencedLease !== true) {
        fs.rmSync(legacyLockFile(root), { force: true });
        return true;
      }
      if (!current || current.leaseId !== token || current.operation.phase !== 'legacy') return false;
      removeLeaseFile(root, token);
      return true;
    });
  } catch (error) {
    if (error instanceof GuardBusyError) return false;
    throw error;
  }
}

export function startLeaseHeartbeat(lease, options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('scan lease heartbeat interval must be positive');
  }
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const settings = runtimeFor(lease);
  const remainingLeaseMs = Math.max(0, settings.monotonicDeadline - settings.monotonicNow());
  settings.monotonicNow = monotonicNow;
  settings.monotonicDeadline = monotonicNow() + remainingLeaseMs;
  settings.wallNow = wallNow;
  const setTimer = options.setTimeoutFn ?? setTimeout;
  const clearTimer = options.clearTimeoutFn ?? clearTimeout;
  const pollMs = Math.min(intervalMs, 1_000);
  let stopped = false;
  let lost = false;
  let timer;
  let lastWall = wallNow();
  let lastMonotonic = monotonicNow();
  let renewalDue = lastMonotonic + intervalMs;

  const lose = (error) => {
    lost = true;
    stopped = true;
    if (typeof options.onLeaseLost === 'function') options.onLeaseLost(error);
  };

  const tick = () => {
    if (stopped) return;
    const wall = wallNow();
    const monotonic = monotonicNow();
    const wallAdvance = wall - lastWall;
    const monotonicAdvance = monotonic - lastMonotonic;
    const forwardJump = wallAdvance - monotonicAdvance > intervalMs;
    if (monotonic >= renewalDue || forwardJump) {
      try {
        renewScanLease(lease);
        renewalDue = monotonicNow() + intervalMs;
      } catch (error) {
        if (error instanceof LeaseLostError || monotonicNow() >= settings.monotonicDeadline) {
          lose(error instanceof LeaseLostError ? error : new LeaseLostError());
          return;
        }
      }
    }
    lastWall = wall;
    lastMonotonic = monotonic;
    timer = setTimer(tick, pollMs);
    timer?.unref?.();
  };

  timer = setTimer(tick, pollMs);
  timer?.unref?.();
  return {
    get lost() { return lost; },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
    },
  };
}
