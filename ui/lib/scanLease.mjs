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
const MIGRATION_FILE = 'scan-lease-migration.json';
const MIGRATED_LEGACY_LOCK_FILE = 'legacy-scan-lock.migrated.json';
const GUARD_DIRECTORY = 'scan-lease.guard';
const RECOVERY_CLAIM_DIRECTORY = 'scan-lease.recovery-claim';
const LEGACY_LOCK_FILE = '.scout-scan.lock';
const LEGACY_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const CLEANUP_RETRY_LIMIT = 4;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const runtime = Symbol('scanLeaseRuntime');
const synchronousFenceCallbacks = new WeakSet();
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const backgroundCleanups = new Map();
let cachedCurrentOwner;

export class LeaseLostError extends Error {
  constructor(message = 'scan lease is no longer current') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export class LeaseMigrationError extends LeaseLostError {
  constructor(message) {
    super(message);
    this.name = 'LeaseMigrationError';
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

function migrationFile(root) {
  return path.join(scoutDirectory(root), MIGRATION_FILE);
}

function migratedLegacyLockFile(root) {
  return path.join(scoutDirectory(root), MIGRATED_LEGACY_LOCK_FILE);
}

function guardDirectory(root) {
  return path.join(scoutDirectory(root), GUARD_DIRECTORY);
}

function recoveryDirectory(root) {
  return `${guardDirectory(root)}.recovery`;
}

function recoveryClaimDirectory(root) {
  return path.join(scoutDirectory(root), RECOVERY_CLAIM_DIRECTORY);
}

function recoveryClaimCandidateDirectory(root, claimId) {
  return `${recoveryClaimDirectory(root)}.candidate.${claimId}`;
}

function legacyLockFile(root) {
  return path.join(path.resolve(root), LEGACY_LOCK_FILE);
}

function canonicalPath(value, fileSystem = fs) {
  const resolved = path.resolve(value);
  const missing = [];
  let candidate = resolved;
  while (true) {
    try {
      const physical = fileSystem.realpathSync.native?.(candidate)
        ?? fileSystem.realpathSync(candidate);
      return path.join(physical, ...missing);
    } catch (error) {
      if (error?.code !== 'ENOENT') return resolved;
      try {
        // ENOENT from realpath can also mean a broken symlink. Never walk
        // through an existing unresolved component when checking containment.
        fileSystem.lstatSync(candidate);
        return resolved;
      } catch (statError) {
        if (statError?.code !== 'ENOENT') return resolved;
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) return resolved;
      missing.unshift(path.basename(candidate));
      candidate = parent;
    }
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

export function darwinProcessStartIdentity(pid, formattedStart, {
  spawn = spawnSync,
  instanceStart = null,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const seconds = Math.floor(Date.parse(formattedStart) / 1000);
  if (!Number.isSafeInteger(seconds)) return null;
  const boot = spawn('sysctl', ['-n', 'kern.boottime'], {
    encoding: 'utf8', timeout: 2_000, maxBuffer: 16 * 1024,
  });
  if (boot.status !== 0 || typeof boot.stdout !== 'string' || !boot.stdout.trim()) return null;
  const processInfo = spawn('sysctl', ['-b', `kern.proc.pid.${pid}`], {
    encoding: null, timeout: 2_000, maxBuffer: 1024 * 1024,
  });
  const matches = [];
  if (processInfo.status === 0 && Buffer.isBuffer(processInfo.stdout)) {
    for (let offset = 0; offset <= processInfo.stdout.length - 16; offset += 1) {
      if (Number(processInfo.stdout.readBigInt64LE(offset)) !== seconds) continue;
      const microseconds = Number(processInfo.stdout.readBigInt64LE(offset + 8));
      if (Number.isSafeInteger(microseconds) && microseconds >= 0 && microseconds < 1_000_000) {
        matches.push(microseconds);
      }
    }
  }
  if (matches.length === 1) {
    const session = createHash('sha256')
      .update(`${boot.stdout.trim()}\0${seconds}.${String(matches[0]).padStart(6, '0')}`)
      .digest('hex');
    return requireToken(`darwin-${session}`, 'process-start identity');
  }
  const coarse = createHash('sha256')
    .update(`${boot.stdout.trim()}\0${pid}\0${seconds}`)
    .digest('hex')
    .slice(0, 32);
  if (!Number.isFinite(instanceStart)) {
    return requireToken(`darwin-fallback-${coarse}`, 'process-start identity');
  }
  const instance = createHash('sha256')
    .update(`${coarse}\0${instanceStart}`)
    .digest('hex')
    .slice(0, 32);
  return requireToken(`darwin-fallback-${coarse}-${instance}`, 'process-start identity');
}

function darwinIdentity(identity) {
  const fallback = /^darwin-fallback-([a-f0-9]{32})(?:-[a-f0-9]{32})?$/.exec(identity || '');
  if (fallback) return { precision: 'fallback', coarse: fallback[1] };
  if (/^darwin-[a-f0-9]{64}$/.test(identity || '')) return { precision: 'kernel' };
  return null;
}

export function windowsProcessStartIdentity(pid, {
  spawn = spawnSync,
  currentPid = process.pid,
  instanceStart = pid === currentPid ? performance.timeOrigin : null,
  hostname = os.hostname(),
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
  for (const executable of ['pwsh.exe', 'powershell.exe']) {
    try {
      const result = spawn(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
      const ticks = result.status === 0 && typeof result.stdout === 'string'
        ? result.stdout.trim()
        : '';
      if (/^\d+$/.test(ticks)) return `windows-${ticks}`;
    } catch {
      // Try the other installed shell before using the current-process fallback.
    }
  }
  if (pid !== currentPid || !Number.isFinite(instanceStart)) return null;
  const instance = createHash('sha256')
    .update(`${hostname}\0${pid}\0${instanceStart}`)
    .digest('hex');
  return requireToken(`windows-fallback-${instance}`, 'process-start identity');
}

function windowsIdentity(identity) {
  if (/^windows-\d+$/.test(identity || '')) return { precision: 'kernel' };
  if (/^windows-fallback-[a-f0-9]{64}$/.test(identity || '')) {
    return { precision: 'fallback' };
  }
  return null;
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
      return windowsProcessStartIdentity(pid);
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C' },
    });
    const started = result.status === 0 ? result.stdout.trim() : '';
    if (!started) return null;
    if (process.platform === 'darwin') {
      return darwinProcessStartIdentity(pid, started, {
        instanceStart: pid === process.pid ? performance.timeOrigin : null,
      });
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
  if (currentStart) {
    const recordedDarwin = darwinIdentity(owner.processStart);
    const currentDarwin = darwinIdentity(currentStart);
    // Kernel process metadata can become temporarily unavailable. A precision
    // change is uncertainty, not proof that the live PID was reused.
    if (recordedDarwin && currentDarwin
      && recordedDarwin.precision !== currentDarwin.precision) return true;
    // Other processes cannot observe Node's high-resolution time origin. The
    // coarse component is used only to preserve a possibly-live stale guard;
    // the full persisted identity still fences same-second PID reuse.
    if (recordedDarwin?.precision === 'fallback' && currentDarwin?.precision === 'fallback') {
      return recordedDarwin.coarse === currentDarwin.coarse;
    }
    const recordedWindows = windowsIdentity(owner.processStart);
    const currentWindows = windowsIdentity(currentStart);
    // A shell-derived process start cannot be compared to the local Node
    // fallback. Preserve a live PID when the observation precision changes.
    if (recordedWindows && currentWindows
      && recordedWindows.precision !== currentWindows.precision) return true;
    return currentStart === owner.processStart;
  }
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

export function isFencedLeaseActivated(root) {
  return readGeneration(root) > 0;
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

function guardMetadataFile(directory, guardId) {
  return path.join(directory, `${guardId}.json`);
}

function guardCandidateDirectory(root, guardId) {
  return `${guardDirectory(root)}.candidate.${guardId}`;
}

function guardLinkTarget(link, fileSystem = fs) {
  try {
    if (!fileSystem.lstatSync(link).isSymbolicLink()) return null;
    const target = fileSystem.readlinkSync(link);
    return canonicalPath(path.resolve(path.dirname(link), target), fileSystem);
  } catch {
    return null;
  }
}

function writeGuardMetadata(directory, record, fileSystem = fs) {
  writeJsonAtomic(guardMetadataFile(directory, record.guardId), record, fileSystem);
}

function readGuardMetadataStrict(guard, fileSystem = fs) {
  const entries = fileSystem.readdirSync(guard, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isFile() || !entries[0].name.endsWith('.json')) {
    throw new Error('scan lease guard metadata is invalid');
  }
  const record = validateGuardMetadata(readJson(path.join(guard, entries[0].name), fileSystem));
  if (entries[0].name !== `${record.guardId}.json` && entries[0].name !== 'owner.json') {
    throw new Error('scan lease guard metadata filename does not match its guard ID');
  }
  return record;
}

function readGuardMetadata(guard, fileSystem = fs) {
  try {
    return readGuardMetadataStrict(guard, fileSystem);
  } catch {
    return null;
  }
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

function sameGuardMetadata(left, right) {
  return Boolean(left && right)
    && left.schemaVersion === right.schemaVersion
    && left.guardId === right.guardId
    && left.acquiredAt === right.acquiredAt
    && sameOwner(left.owner, right.owner);
}

function staleAndRecoverable(guard, metadata, now, options) {
  if (!metadata) return false;
  const fileSystem = options.fileSystem;
  if (guardAge(guard, metadata, now, fileSystem) < GUARD_STALE_AFTER_MS) return false;
  const live = typeof options.hooks.ownerIsLive === 'function'
    ? options.hooks.ownerIsLive(metadata.owner)
    : ownerIsLive(metadata.owner);
  // Missing or malformed metadata cannot prove who owns the path. Preserve it
  // rather than allowing a delayed previous-version initializer to be moved
  // and later write through a successor's canonical guard.
  return !live;
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

function cleanupIdentityDirectory(directory, identity, options) {
  const fileSystem = options.fileSystem;
  try {
    retrySync(
      () => fileSystem.unlinkSync(guardMetadataFile(directory, identity)),
      (error) => ['EBUSY', 'EPERM', 'EACCES', 'EIO'].includes(error?.code),
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    retrySync(
      () => fileSystem.rmdirSync(directory),
      (error) => ['EBUSY', 'EPERM', 'EACCES', 'EIO'].includes(error?.code),
    );
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (['ENOTEMPTY', 'EEXIST'].includes(error?.code)) return false;
    throw error;
  }
}

function cleanupOwnedGuard(root, guardId, options) {
  const fileSystem = options.fileSystem;
  const candidate = guardCandidateDirectory(root, guardId);
  const expectedTarget = canonicalPath(candidate, fileSystem);
  for (const link of [guardDirectory(root), recoveryDirectory(root)]) {
    const target = guardLinkTarget(link, fileSystem);
    if (target === expectedTarget) {
      retrySync(
        () => fileSystem.unlinkSync(link),
        (error) => ['EBUSY', 'EPERM', 'EACCES', 'EIO'].includes(error?.code),
      );
      return cleanupIdentityDirectory(candidate, guardId, options);
    }
    // Read compatibility for guards created before identity-bound link
    // publication was introduced.
    if (target === null && fileSystem.existsSync(guardMetadataFile(link, guardId))) {
      return cleanupIdentityDirectory(link, guardId, options);
    }
  }
  if (fileSystem.existsSync(guardMetadataFile(candidate, guardId))) {
    return cleanupIdentityDirectory(candidate, guardId, options);
  }
  // A prior attempt may already have removed the identity marker and failed
  // only at rmdir. Removing an empty directory is safe: a successor with a
  // complete identity marker is non-empty and cannot be displaced.
  for (const directory of [candidate, guardDirectory(root), recoveryDirectory(root)]) {
    if (directory !== candidate && guardLinkTarget(directory, fileSystem) !== null) continue;
    try {
      fileSystem.rmdirSync(directory);
      return true;
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
    }
  }
  return true;
}

function scheduleBackgroundCleanup(root, identity, options, kind) {
  const key = `${canonicalPath(root, options.fileSystem)}\0${kind}\0${identity}`;
  if (backgroundCleanups.has(key)) return;
  const attempt = () => {
    try {
      const done = kind === 'guard'
        ? cleanupOwnedGuard(root, identity, options)
        : cleanupRecoveryArbitration(root, identity, options);
      if (done) {
        backgroundCleanups.delete(key);
        return;
      }
    } catch {}
    const timer = setTimeout(attempt, 25);
    timer.unref?.();
    backgroundCleanups.set(key, timer);
  };
  const timer = setTimeout(attempt, 0);
  timer.unref?.();
  backgroundCleanups.set(key, timer);
}

function recoveryArbitrationState(root, options) {
  const fileSystem = options.fileSystem;
  const claim = recoveryClaimDirectory(root);
  if (!fileSystem.existsSync(claim)) return 'none';
  const metadata = readGuardMetadata(claim, fileSystem);
  if (!staleAndRecoverable(claim, metadata, wallMilliseconds(options), options)) return 'wait';
  if (metadata) {
    if (cleanupRecoveryArbitration(root, metadata.guardId, options)) return 'retry';
    return 'wait';
  }
  try {
    fileSystem.rmdirSync(claim);
    return 'retry';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'retry';
    return 'wait';
  }
}

function cleanupRecoveryArbitration(root, claimId, options) {
  const fileSystem = options.fileSystem;
  const claim = recoveryClaimDirectory(root);
  const candidate = recoveryClaimCandidateDirectory(root, claimId);
  const expectedTarget = canonicalPath(candidate, fileSystem);
  const target = guardLinkTarget(claim, fileSystem);
  if (target === expectedTarget) {
    retrySync(
      () => fileSystem.unlinkSync(claim),
      (error) => ['EBUSY', 'EPERM', 'EACCES', 'EIO'].includes(error?.code),
    );
    return cleanupIdentityDirectory(candidate, claimId, options);
  }
  if (target === null && fileSystem.existsSync(guardMetadataFile(claim, claimId))) {
    return cleanupIdentityDirectory(claim, claimId, options);
  }
  if (fileSystem.existsSync(guardMetadataFile(candidate, claimId))) {
    return cleanupIdentityDirectory(candidate, claimId, options);
  }
  try {
    fileSystem.rmdirSync(candidate);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
  }
  return true;
}

function withRecoveryArbitration(root, owner, options, action) {
  const fileSystem = options.fileSystem;
  const claim = recoveryClaimDirectory(root);
  const state = recoveryArbitrationState(root, options);
  if (state !== 'none') return { acquired: false, retry: state === 'retry' };
  const claimId = randomUUID();
  const candidate = recoveryClaimCandidateDirectory(root, claimId);
  try {
    fileSystem.mkdirSync(candidate);
    writeGuardMetadata(candidate, {
      schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
      guardId: claimId,
      owner,
      acquiredAt: new Date(wallMilliseconds(options)).toISOString(),
    }, fileSystem);
    fileSystem.symlinkSync(
      candidate,
      claim,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    try { fileSystem.rmSync(candidate, { recursive: true, force: true }); } catch {}
    if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error?.code)) {
      return { acquired: false, retry: true };
    }
    throw error;
  }
  let result;
  let actionError;
  try {
    result = action();
  } catch (error) {
    actionError = error;
  }
  let cleanupError;
  try {
    if (!cleanupRecoveryArbitration(root, claimId, options)) {
      throw new Error('scan lease recovery arbitration cleanup is incomplete');
    }
  } catch (error) {
    cleanupError = error;
    scheduleBackgroundCleanup(root, claimId, options, 'arbitration');
  }
  if (actionError) throw actionError;
  if (cleanupError) throw cleanupError;
  return { acquired: true, result };
}

function recoverClaims(root, options, revalidatedMetadata = null) {
  const fileSystem = options.fileSystem;
  const guard = guardDirectory(root);
  const recovery = recoveryDirectory(root);
  const now = wallMilliseconds(options);

  if (!fileSystem.existsSync(recovery)) return 'none';
  const metadata = readGuardMetadata(recovery, fileSystem);
  const revalidated = sameGuardMetadata(metadata, revalidatedMetadata);
  if (fileSystem.existsSync(guard)) {
    // A canonical guard may have been created in the instant after a stale
    // observer moved a live successor here. Never discard that moved guard:
    // the new canonical creator must notice the recovery claim and withdraw.
    if (revalidated || staleAndRecoverable(recovery, metadata, now, options)) {
      try {
        fileSystem.renameSync(recovery, quarantinePath(guard, now));
        return 'retry';
      } catch (error) {
        if (error?.code === 'ENOENT') return 'retry';
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      }
      return 'wait';
    }
    return 'wait';
  }
  if (revalidated || staleAndRecoverable(recovery, metadata, now, options)) {
    try {
      fileSystem.renameSync(recovery, quarantinePath(guard, now));
      return 'retry';
    } catch (error) {
      if (error?.code === 'ENOENT') return 'retry';
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    }
    return 'wait';
  }
  try {
    fileSystem.renameSync(recovery, guard);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'retry';
    if (['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return 'wait';
    throw error;
  }
  return 'wait';
}

function withGuard(root, owner, options, action, behavior = {}) {
  const directory = scoutDirectory(root);
  const guard = guardDirectory(root);
  const recovery = recoveryDirectory(root);
  const fileSystem = options.fileSystem;
  fileSystem.mkdirSync(directory, { recursive: true });
  if (options.cleanupPending?.guardId) {
    cleanupOwnedGuard(root, options.cleanupPending.guardId, options);
    delete options.cleanupPending;
  }
  const deadline = options.monotonicNow() + options.guardAcquireTimeoutMs;
  const guardId = randomUUID();
  const acquiredAt = new Date(wallMilliseconds(options)).toISOString();
  const candidate = guardCandidateDirectory(root, guardId);
  let candidateReady = false;
  let guardAcquired = false;
  let revalidatedRecoveryMetadata = null;
  const prepareCandidate = () => {
    if (candidateReady) return;
    fileSystem.mkdirSync(candidate);
    try {
      writeGuardMetadata(candidate, {
        schemaVersion: SCAN_LEASE_SCHEMA_VERSION, guardId, owner, acquiredAt,
      }, fileSystem);
      candidateReady = true;
    } catch (error) {
      try { fileSystem.rmSync(candidate, { recursive: true, force: true }); } catch {}
      throw error;
    }
  };

  try {
    while (true) {
      const arbitration = recoveryArbitrationState(root, options);
      if (arbitration === 'retry') continue;
      if (arbitration === 'wait') {
        const remaining = deadline - options.monotonicNow();
        if (remaining <= 0) throw new GuardBusyError();
        Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
        continue;
      }
      const claim = recoverClaims(root, options, revalidatedRecoveryMetadata);
      if (!fileSystem.existsSync(recovery)) revalidatedRecoveryMetadata = null;
      if (claim === 'retry') continue;
      if (claim === 'wait') {
        const remaining = deadline - options.monotonicNow();
        if (remaining <= 0) throw new GuardBusyError();
        Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
        continue;
      }
      options.hooks.afterRecoveryCheck?.();
      prepareCandidate();
      try {
        fileSystem.symlinkSync(
          candidate,
          guard,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
        const metadata = readGuardMetadata(guard, fileSystem);
        if (staleAndRecoverable(guard, metadata, wallMilliseconds(options), options)) {
          options.hooks.afterGuardObservation?.();
          const recoveryAttempt = withRecoveryArbitration(root, owner, options, () => {
            const currentMetadata = readGuardMetadata(guard, fileSystem);
            if (!staleAndRecoverable(
              guard, currentMetadata, wallMilliseconds(options), options,
            )) return false;
            try {
              fileSystem.renameSync(guard, recovery);
            } catch (renameError) {
              if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(renameError?.code)) return false;
              throw renameError;
            }
            options.hooks.afterGuardRecoveryRename?.();
            revalidatedRecoveryMetadata = currentMetadata;
            return true;
          });
          if (recoveryAttempt.acquired && recoveryAttempt.result) {
            continue;
          }
        }
        const remaining = deadline - options.monotonicNow();
        if (remaining <= 0) throw new GuardBusyError();
        Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
        continue;
      }
      candidateReady = false;
      // Recovery is a visible hand-off marker. A contender that checked just
      // before another process moved a live guard must withdraw its newly
      // published canonical guard instead of entering the protected action.
      if (fileSystem.existsSync(recovery)
        || fileSystem.existsSync(recoveryClaimDirectory(root))) {
        try {
          if (!cleanupOwnedGuard(root, guardId, options)) {
            throw new Error('scan lease guard withdrawal cleanup is incomplete');
          }
        } catch (error) {
          scheduleBackgroundCleanup(root, guardId, options, 'guard');
          throw error;
        }
        const remaining = deadline - options.monotonicNow();
        if (remaining <= 0) throw new GuardBusyError();
        Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
        continue;
      }
      guardAcquired = true;
      break;
    }
  } finally {
    if (!guardAcquired && candidateReady) {
      try { cleanupIdentityDirectory(candidate, guardId, options); } catch {}
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
    if (!cleanupOwnedGuard(root, guardId, options)) {
      throw new Error('scan lease guard cleanup is incomplete');
    }
  } catch (cleanupError) {
    options.hooks.onCleanupFailure?.(cleanupError);
    const cleanupPending = { guardId, error: cleanupError };
    options.cleanupPending = cleanupPending;
    scheduleBackgroundCleanup(root, guardId, options, 'guard');
    if (!actionError && result?.[runtime]) result[runtime].cleanupPending = cleanupPending;
    if (behavior.requireCleanupBeforeReturn) {
      const terminalCleanupError = new Error('scan lease cleanup failed after terminal operation', {
        cause: cleanupError,
      });
      terminalCleanupError.name = 'GuardCleanupError';
      if (!actionError) actionError = terminalCleanupError;
    }
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

export function synchronousFenceCallback(commit) {
  if (typeof commit !== 'function' || commit.constructor?.name === 'AsyncFunction') {
    throw new TypeError('fenced commit callback must be explicitly synchronous');
  }
  synchronousFenceCallbacks.add(commit);
  return commit;
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
  runtimeFor(lease).hooks.beforeCurrentOwnerObservation?.();
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

function removeLeaseFile(root, _leaseId) {
  fs.rmSync(leaseFile(root), { force: true });
  try {
    const descriptor = fs.openSync(scoutDirectory(root), 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EISDIR'].includes(error?.code)) throw error;
  }
}

function validateLegacyLockRecord(record) {
  const keys = Object.keys(record || {}).sort().join(',');
  const ownerShape = keys === 'agent,mode,owner,startedAt,token';
  const sentinelShape = keys === 'agent,fencedLease,mode,startedAt,token';
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !['agent,mode,startedAt,token'].includes(keys) && !ownerShape && !sentinelShape
    || !SAFE_TOKEN.test(record.agent || '') || !SAFE_TOKEN.test(record.mode || '')
    || !SAFE_TOKEN.test(record.token || '') || Number.isNaN(Date.parse(record.startedAt || ''))
    || (record.fencedLease !== undefined && record.fencedLease !== true)) {
    return { invalid: true };
  }
  if (ownerShape) {
    try {
      checkedOwner(record.owner);
    } catch {
      return { invalid: true };
    }
  }
  return record;
}

function readLegacyLockFile(file) {
  try {
    return validateLegacyLockRecord(readJson(file));
  } catch {
    return { invalid: true };
  }
}

function readLegacyLock(root) {
  const file = legacyLockFile(root);
  if (!fs.existsSync(file)) return null;
  return readLegacyLockFile(file);
}

function restoreMovedLegacyLock(moved, file) {
  try {
    fs.linkSync(moved, file);
    fs.rmSync(moved, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}

function sameLegacyLock(left, right) {
  return left?.agent === right?.agent
    && left?.mode === right?.mode
    && left?.token === right?.token
    && left?.startedAt === right?.startedAt
    && left?.fencedLease === right?.fencedLease
    && sameOwner(left?.owner, right?.owner);
}

function unverifiableLegacyMessage() {
  return 'Cannot verify that the legacy lock owner stopped. Stop old Scout, remove '
    + '.scout-scan.lock only after confirming it stopped, and retry.';
}

function activeLegacyMessage() {
  return 'The legacy lock may still be active. Stop old Scout, wait for its existing '
    + 'lock expiry, and retry.';
}

function coexistenceMessage() {
  return 'Legacy Scout downgrade/coexistence detected after fenced lease activation. '
    + 'Stop old Scout, remove .scout-scan.lock only after confirming it stopped, and retry.';
}

function assertMigratableLegacyLock(record, now) {
  if (!record || record.invalid || record.fencedLease === true || !record.owner) {
    throw new LeaseMigrationError(unverifiableLegacyMessage());
  }
  const age = now - Date.parse(record.startedAt);
  if (!Number.isFinite(age) || age < LEGACY_STALE_AFTER_MS || ownerIsLive(record.owner)) {
    throw new LeaseMigrationError(activeLegacyMessage());
  }
  return record;
}

function migrationDecisionRecord(decision, legacyLock, now) {
  return {
    schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
    decision,
    decidedAt: new Date(now).toISOString(),
    firstGeneration: 1,
    legacyLock,
  };
}

function validateMigrationDecision(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',')
      !== 'decidedAt,decision,firstGeneration,legacyLock,schemaVersion'
    || record.schemaVersion !== SCAN_LEASE_SCHEMA_VERSION
    || !['fresh-workspace', 'expired-stopped-owner'].includes(record.decision)
    || record.firstGeneration !== 1) {
    throw new Error('scan lease migration decision is invalid');
  }
  requireTimestamp(record.decidedAt, 'scan lease migration decision time');
  if (record.decision === 'fresh-workspace') {
    if (record.legacyLock !== null) throw new Error('scan lease migration decision is invalid');
    return record;
  }
  const legacyLock = validateLegacyLockRecord(record.legacyLock);
  if (legacyLock.invalid || !legacyLock.owner || legacyLock.fencedLease === true) {
    throw new Error('scan lease migration decision is invalid');
  }
  return record;
}

function readMigrationDecision(root) {
  const file = migrationFile(root);
  if (!fs.existsSync(file)) return null;
  return validateMigrationDecision(readJson(file));
}

function assertNoLegacyCoexistence(root) {
  if (fs.existsSync(legacyLockFile(root))) {
    throw new LeaseMigrationError(coexistenceMessage());
  }
}

function prepareFirstFencedActivation(root, now, options) {
  const file = legacyLockFile(root);
  const archived = migratedLegacyLockFile(root);
  let decision = readMigrationDecision(root);
  let archivedLock = fs.existsSync(archived) ? readLegacyLockFile(archived) : null;
  const visibleLock = readLegacyLock(root);

  if (decision) {
    if (decision.decision === 'expired-stopped-owner') {
      if (!archivedLock || archivedLock.invalid
        || !sameLegacyLock(archivedLock, decision.legacyLock)) {
        throw new Error('migrated legacy lock evidence does not match its decision');
      }
      assertMigratableLegacyLock(archivedLock, now);
      if (!visibleLock || visibleLock.invalid
        || !sameLegacyLock(visibleLock, decision.legacyLock)) {
        throw new LeaseMigrationError(
          'Legacy lock changed while fenced migration was pending. Stop old Scout and retry.',
        );
      }
    } else {
      if (archivedLock) throw new Error('unexpected migrated legacy lock evidence');
      if (visibleLock) throw new LeaseMigrationError(unverifiableLegacyMessage());
    }
    return decision;
  }

  if (archivedLock) {
    assertMigratableLegacyLock(archivedLock, now);
    if (!visibleLock || visibleLock.invalid || !sameLegacyLock(visibleLock, archivedLock)) {
      throw new LeaseMigrationError(
        'Legacy lock changed while fenced migration was pending. Stop old Scout and retry.',
      );
    }
    decision = migrationDecisionRecord('expired-stopped-owner', archivedLock, now);
  } else if (!visibleLock) {
    decision = migrationDecisionRecord('fresh-workspace', null, now);
  } else {
    assertMigratableLegacyLock(visibleLock, now);
    try {
      fs.linkSync(file, archived);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) {
        throw new LeaseMigrationError(
          'Legacy lock changed during migration. Stop old Scout and retry.',
        );
      }
      throw error;
    }
    archivedLock = readLegacyLockFile(archived);
    if (archivedLock.invalid || !sameLegacyLock(archivedLock, visibleLock)) {
      fs.rmSync(archived, { force: true });
      throw new LeaseMigrationError('Legacy lock changed during migration. Stop old Scout and retry.');
    }
    decision = migrationDecisionRecord('expired-stopped-owner', archivedLock, now);
  }

  writeJsonAtomic(migrationFile(root), decision);
  options.hooks.afterMigrationDecision?.();
  return decision;
}

function finalizeRecordedLegacyMigration(root, decision = readMigrationDecision(root)) {
  if (!decision || decision.decision !== 'expired-stopped-owner') return;
  const archived = readLegacyLockFile(migratedLegacyLockFile(root));
  if (archived.invalid || !sameLegacyLock(archived, decision.legacyLock)) {
    throw new Error('migrated legacy lock evidence does not match its decision');
  }
  const visible = readLegacyLock(root);
  if (!visible) return;
  if (visible.invalid || !sameLegacyLock(visible, decision.legacyLock)) {
    throw new LeaseMigrationError(coexistenceMessage());
  }
  const file = legacyLockFile(root);
  const claimedPath = `${file}.migration-finalize.${randomUUID()}`;
  try {
    fs.renameSync(file, claimedPath);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) {
      throw new LeaseMigrationError(coexistenceMessage());
    }
    throw error;
  }
  const claimed = readLegacyLockFile(claimedPath);
  if (claimed.invalid || !sameLegacyLock(claimed, decision.legacyLock)) {
    restoreMovedLegacyLock(claimedPath, file);
    throw new LeaseMigrationError(coexistenceMessage());
  }
  fs.rmSync(claimedPath, { force: true });
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
      const authoritativeGeneration = readGeneration(root);
      let migrationDecision;
      if (authoritativeGeneration > 0) {
        finalizeRecordedLegacyMigration(root);
        assertNoLegacyCoexistence(root);
      } else {
        if (current) throw new Error('scan lease exists without an authoritative generation');
        migrationDecision = prepareFirstFencedActivation(root, now, options);
      }
      if (current) {
        const takeoverAt = Date.parse(current.expiresAt) + current.takeoverMarginMs;
        if (now < takeoverAt) return null;
      }
      const leaseId = options.leaseId ?? randomUUID();
      if (authoritativeGeneration > 0 || migrationDecision.decision === 'fresh-workspace') {
        assertNoLegacyCoexistence(root);
      }
      const generation = Math.max(authoritativeGeneration, current?.generation ?? 0) + 1;
      writeJsonAtomic(generationFile(root), {
        schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
        generation,
      });
      finalizeRecordedLegacyMigration(root, migrationDecision);
      assertNoLegacyCoexistence(root);
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
      assertNoLegacyCoexistence(root);
      writeJsonAtomic(leaseFile(root), record);
      try {
        assertNoLegacyCoexistence(root);
      } catch (error) {
        fs.rmSync(leaseFile(root), { force: true });
        throw error;
      }
      return hydrateLease(root, record, options);
    });
  } catch (error) {
    if (error instanceof GuardBusyError) return null;
    throw error;
  }
}

/**
 * Atomically retarget an owned provisional lease to a selected recoverable run.
 *
 * The shared guard never exposes an idle workspace between identities. A new
 * generation deliberately invalidates every callback holding the provisional
 * fence before the recovered run can commit.
 */
export function handoffScanLease(lease, operation) {
  const settings = runtimeFor(lease);
  operation = checkedOperation(operation);
  if (!currentProcessOwns(lease) || locallyExpired(settings)) throw new LeaseLostError();
  try {
    return withGuard(settings.root, lease.owner, settings, () => {
      assertNoLegacyCoexistence(settings.root);
      const current = readScanLease(settings.root);
      if (!sameFence(current, lease) || locallyExpired(settings)) throw new LeaseLostError();
      const generation = current.generation + 1;
      writeJsonAtomic(generationFile(settings.root), {
        schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
        generation,
      });
      const now = wallMilliseconds(settings);
      const timestamp = new Date(now).toISOString();
      const record = {
        ...current,
        leaseId: randomUUID(),
        generation,
        runId: operation.runId,
        operation,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt: new Date(now + settings.leaseDurationMs).toISOString(),
        heartbeatSequence: 0,
      };
      writeJsonAtomic(leaseFile(settings.root), record);
      assertNoLegacyCoexistence(settings.root);
      return hydrateLease(settings.root, record, settings);
    });
  } catch (error) {
    if (error instanceof GuardBusyError) throw new LeaseLostError();
    throw error;
  }
}

export function assertCurrentFence(lease, commit) {
  if (typeof commit !== 'function') throw new TypeError('fenced commit callback is required');
  if (!synchronousFenceCallbacks.has(commit)) {
    throw new TypeError('fenced commit callback must be explicitly synchronous');
  }
  const settings = runtimeFor(lease);
  if (!currentProcessOwns(lease) || locallyExpired(settings)) throw new LeaseLostError();
  try {
    return withGuard(settings.root, lease.owner, settings, () => {
      assertNoLegacyCoexistence(settings.root);
      const current = readScanLease(settings.root);
      if (!sameFence(current, lease) || locallyExpired(settings)) throw new LeaseLostError();
      assertNoLegacyCoexistence(settings.root);
      const result = commit();
      if (result && typeof result.then === 'function') {
        throw new TypeError('fenced commit must complete synchronously');
      }
      assertNoLegacyCoexistence(settings.root);
      return result;
    });
  } catch (error) {
    if (error instanceof GuardBusyError) throw new LeaseLostError();
    throw error;
  }
}

/**
 * Serialize a request-submission append through the lease workspace guard
 * without granting the contender ownership of the active scan fence.
 *
 * This deliberately exposes only a synchronous callback after the exact lease
 * and operation observed by the contender have been revalidated. It is for
 * durable overlap submission only; run, claim, completion and mutation writes
 * must continue to use assertCurrentFence().
 */
function checkedObservedActiveLease(observed) {
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)
    || Object.keys(observed).sort().join(',') !== 'generation,leaseId,operation,runId'
    || !Number.isSafeInteger(observed.generation) || observed.generation < 1
    || typeof observed.leaseId !== 'string' || !SAFE_TOKEN.test(observed.leaseId)
    || typeof observed.runId !== 'string' || !SAFE_RUN_ID.test(observed.runId)) {
    throw new TypeError('observed active scan lease is invalid');
  }
  const operation = checkedOperation(observed.operation);
  if (operation.runId !== observed.runId) throw new TypeError('observed scan operation does not match its run');
  return operation;
}

/**
 * Append one already-validated queue event while the exact observed scan is
 * still active. The expected journal digest makes projection plus append an
 * optimistic atomic transition without exposing a non-owner callback.
 */
export function appendObservedScanQueueEvent(root, observed, input, inputOptions = {}) {
  const operation = checkedObservedActiveLease(observed);
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'expectedDigest,record'
    || typeof input.expectedDigest !== 'string' || !SHA256.test(input.expectedDigest)
    || !input.record || typeof input.record !== 'object' || Array.isArray(input.record)
    || !Number.isSafeInteger(input.record.schemaVersion) || input.record.schemaVersion < 2
    || !['enqueue', 'deduplicated', 'scheduled-replaced'].includes(input.record.type)
    || typeof input.record.eventId !== 'string' || !SAFE_TOKEN.test(input.record.eventId)) {
    throw new TypeError('observed scan queue append is invalid');
  }
  const line = `${JSON.stringify(input.record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > 1024 * 1024) {
    throw new TypeError('observed scan queue event exceeds its bound');
  }
  const options = timingOptions(inputOptions);
  const expectedOperation = JSON.stringify(operation);
  try {
    return withGuard(root, currentLeaseOwner(), options, () => {
      const current = readScanLease(root);
      const activeUntil = current
        ? Date.parse(current.expiresAt) + current.takeoverMarginMs
        : Number.NEGATIVE_INFINITY;
      const sameObservedLease = current?.leaseId === observed.leaseId
        && current?.generation === observed.generation
        && current?.runId === observed.runId
        && JSON.stringify(current.operation) === expectedOperation;
      if (!sameObservedLease || wallMilliseconds(options) >= activeUntil) {
        return Object.freeze({ active: false, appended: false });
      }
      const file = path.join(path.resolve(root), '.scout', 'scan-queue.jsonl');
      const contents = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
      const digest = createHash('sha256').update(contents).digest('hex');
      if (digest !== input.expectedDigest) {
        return Object.freeze({ active: true, appended: false });
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const descriptor = fs.openSync(file, 'a');
      try {
        fs.writeSync(descriptor, line, undefined, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      return Object.freeze({ active: true, appended: true });
    });
  } catch (error) {
    if (error instanceof GuardBusyError) {
      throw new LeaseLostError('scan lease guard remained busy during overlap enqueue');
    }
    throw error;
  }
}

function renewScanLeaseCapability(lease, { observeCurrentOwner = true } = {}) {
  const settings = runtimeFor(lease);
  // A hydrated lease is an opaque in-process capability: its private runtime
  // metadata cannot be reconstructed from the durable JSON record. Direct
  // callers still prove process identity, while the heartbeat that already
  // owns this capability avoids a redundant platform process-start probe.
  if ((observeCurrentOwner && !currentProcessOwns(lease)) || locallyExpired(settings)) {
    throw new LeaseLostError();
  }
  try {
    return withGuard(settings.root, lease.owner, settings, () => {
      assertNoLegacyCoexistence(settings.root);
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
      assertNoLegacyCoexistence(settings.root);
      writeJsonAtomic(leaseFile(settings.root), next);
      assertNoLegacyCoexistence(settings.root);
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

export function renewScanLease(lease) {
  return renewScanLeaseCapability(lease);
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
    }, { requireCleanupBeforeReturn: true });
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
      const generation = readGeneration(root);
      if (generation > 0) {
        assertNoLegacyCoexistence(root);
      } else if (legacy) {
        throw new LeaseMigrationError(
          'A legacy lock cannot be released by new Scout because its owner state is not '
          + 'fenced. Stop old Scout and retry the upgrade workflow.',
        );
      }
      if (!current || current.leaseId !== token || current.operation.phase !== 'legacy') return false;
      removeLeaseFile(root, token);
      return true;
    }, { requireCleanupBeforeReturn: true });
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
        renewScanLeaseCapability(lease, { observeCurrentOwner: false });
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
