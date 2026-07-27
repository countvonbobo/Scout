import { randomUUID } from 'node:crypto';
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
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const runtime = Symbol('scanLeaseRuntime');
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
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

function processStartIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      return requireToken(`linux-${fields[19]}`, 'process-start identity');
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
      encoding: 'utf8', timeout: 2_000,
    });
    const started = result.status === 0 ? result.stdout.trim() : '';
    return started ? `posix-${Buffer.from(started).toString('base64url')}` : null;
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
  if (owner?.host !== os.hostname()) return false;
  const currentStart = processStartIdentity(owner.pid);
  if (currentStart) return currentStart === owner.processStart;
  try {
    process.kill(owner.pid, 0);
    // If the platform cannot inspect another live process safely, preserve the
    // guard. A false live result delays recovery; a false dead result permits
    // simultaneous writers.
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateLeaseRecord(record) {
  const expectedKeys = [
    'acquiredAt', 'expiresAt', 'generation', 'heartbeatAt', 'heartbeatSequence',
    'lastTerminalSequence', 'leaseId', 'operation', 'owner', 'recoveryCount',
    'runId', 'schemaVersion',
  ];
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== expectedKeys.sort().join(',')) {
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
  if (record.lastTerminalSequence !== null
    && (!Number.isSafeInteger(record.lastTerminalSequence) || record.lastTerminalSequence < 1)) {
    throw new Error('scan lease terminal sequence is invalid');
  }
  return record;
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

function writeJsonAtomic(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function readGuardMetadata(guard) {
  try {
    const record = readJson(path.join(guard, 'owner.json'));
    if (!record || record.schemaVersion !== SCAN_LEASE_SCHEMA_VERSION
      || typeof record.guardId !== 'string') return null;
    checkedOwner(record.owner);
    requireTimestamp(record.acquiredAt, 'scan lease guard acquisition time');
    return record;
  } catch {
    return null;
  }
}

function guardAge(guard, metadata, now) {
  const acquired = Date.parse(metadata?.acquiredAt || '');
  if (Number.isFinite(acquired)) return now - acquired;
  try {
    return now - fs.statSync(guard).mtimeMs;
  } catch {
    return 0;
  }
}

function quarantineStaleGuard(guard, metadata, now) {
  if (guardAge(guard, metadata, now) < GUARD_STALE_AFTER_MS) return false;
  if (metadata && ownerIsLive(metadata.owner)) return false;
  const quarantine = `${guard}.quarantine.${new Date(now).toISOString().replace(/[:.]/g, '-')}.${randomUUID()}`;
  try {
    fs.renameSync(guard, quarantine);
    return true;
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) return false;
    throw error;
  }
}

function withGuard(root, owner, options, action) {
  const directory = scoutDirectory(root);
  const guard = guardDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  const deadline = performance.now() + options.guardAcquireTimeoutMs;
  const guardId = randomUUID();

  while (true) {
    try {
      fs.mkdirSync(guard);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const metadata = readGuardMetadata(guard);
      if (quarantineStaleGuard(guard, metadata, wallMilliseconds(options))) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new GuardBusyError();
      Atomics.wait(sleepArray, 0, 0, Math.min(10, remaining));
      continue;
    }

    const acquiredAt = new Date(wallMilliseconds(options)).toISOString();
    try {
      writeJsonAtomic(path.join(guard, 'owner.json'), {
        schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
        guardId,
        owner,
        acquiredAt,
      });
      return action();
    } finally {
      const metadata = readGuardMetadata(guard);
      if (metadata?.guardId === guardId) fs.rmSync(guard, { recursive: true, force: true });
    }
  }
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
      root: path.resolve(root),
      leaseDurationMs: options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      takeoverMarginMs: options.takeoverMarginMs ?? DEFAULT_TAKEOVER_MARGIN_MS,
      guardAcquireTimeoutMs: options.guardAcquireTimeoutMs ?? 2_000,
      wallNow: options.wallNow,
      monotonicNow: options.monotonicNow ?? (() => performance.now()),
      now: options.now,
      monotonicDeadline: (options.monotonicNow ?? (() => performance.now()))()
        + (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS),
      heartbeatSequence: record.heartbeatSequence,
    },
  });
  return lease;
}

function runtimeFor(lease) {
  if (lease?.[runtime]) return lease[runtime];
  if (typeof lease?.root === 'string') {
    return {
      root: path.resolve(lease.root),
      leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
      takeoverMarginMs: DEFAULT_TAKEOVER_MARGIN_MS,
      guardAcquireTimeoutMs: 2_000,
      monotonicNow: () => performance.now(),
      monotonicDeadline: null,
    };
  }
  throw new TypeError('scan lease was not acquired in this process');
}

export function isScanLease(lease) {
  return Boolean(lease?.[runtime]);
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

function locallyExpired(lease, settings) {
  const wallExpired = wallMilliseconds(settings) >= Date.parse(lease.expiresAt);
  const monotonicExpired = settings.monotonicDeadline !== null
    && settings.monotonicNow() >= settings.monotonicDeadline;
  return wallExpired || monotonicExpired;
}

function removeLeaseFile(root) {
  fs.rmSync(leaseFile(root), { force: true });
  try {
    const descriptor = fs.openSync(scoutDirectory(root), 'r');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EISDIR'].includes(error?.code)) throw error;
  }
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
      if (current) {
        const takeoverAt = Date.parse(current.expiresAt) + options.takeoverMarginMs;
        if (now < takeoverAt) return null;
      }
      const generation = Math.max(readGeneration(root), current?.generation ?? 0) + 1;
      writeJsonAtomic(generationFile(root), {
        schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
        generation,
      });
      const timestamp = new Date(now).toISOString();
      const record = {
        schemaVersion: SCAN_LEASE_SCHEMA_VERSION,
        leaseId: options.leaseId ?? randomUUID(),
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
      };
      writeJsonAtomic(leaseFile(root), record);
      return hydrateLease(root, record, options);
    });
  } catch (error) {
    if (error instanceof GuardBusyError) return null;
    throw error;
  }
}

export function assertCurrentFence(lease, commit) {
  const settings = runtimeFor(lease);
  if (!currentProcessOwns(lease) || locallyExpired(lease, settings)) throw new LeaseLostError();
  try {
    return withGuard(settings.root, lease.owner, settings, () => {
      const current = readScanLease(settings.root);
      if (!sameFence(current, lease) || locallyExpired(lease, settings)) throw new LeaseLostError();
      if (commit === undefined) return true;
      if (typeof commit !== 'function') throw new TypeError('fenced commit must be a function');
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
  if (!currentProcessOwns(lease) || locallyExpired(lease, settings)) throw new LeaseLostError();
  try {
    return withGuard(settings.root, lease.owner, settings, () => {
      const current = readScanLease(settings.root);
      if (!sameFence(current, lease) || locallyExpired(lease, settings)) throw new LeaseLostError();
      const now = wallMilliseconds(settings);
      const next = {
        ...current,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(now + settings.leaseDurationMs).toISOString(),
        heartbeatSequence: current.heartbeatSequence + 1,
      };
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
      removeLeaseFile(settings.root);
      return true;
    });
  } catch (error) {
    if (error instanceof GuardBusyError) throw new LeaseLostError();
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
        if (error instanceof LeaseLostError || Date.now() >= Date.parse(lease.expiresAt)) {
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
