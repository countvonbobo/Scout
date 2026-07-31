import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './atomicWrite.mjs';
import { currentLeaseOwner, processOwnerIsLiveOrAmbiguous } from './scanLease.mjs';

const PROVIDERS = new Set(['codex', 'claude']);
const PHASES = new Set(['login', 'logout']);
const SCHEMA_VERSION = 1;
const DEFAULT_DURATION_MS = 11 * 60 * 1000;
const DEFAULT_WORK_DURATION_MS = 30 * 60 * 1000;
const GUARD_STALE_MS = 15_000;
const GUARD_RECORD = 'owner.json';

export class ProviderAuthMutationActiveError extends Error {
  constructor(provider, phase) {
    super(`${provider} authentication is being updated`);
    this.name = 'ProviderAuthMutationActiveError';
    this.reasonCode = 'provider-auth-in-progress';
    this.provider = provider;
    this.phase = phase;
  }
}

function checkedProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new TypeError('provider authentication mutation provider is unsupported');
  return provider;
}

function checkedNow(now) {
  const value = typeof now === 'function' ? Number(now()) : Number(now ?? Date.now());
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('provider authentication mutation time is invalid');
  return value;
}

function createDirectory(directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

function paths(root, provider, create = false) {
  checkedProvider(provider);
  const workspace = path.resolve(root);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new TypeError('provider authentication mutation workspace must exist');
  }
  const physical = fs.realpathSync.native(workspace);
  let directory = path.join(workspace, '.scout');
  for (const part of ['provider-auth', `v${SCHEMA_VERSION}`]) {
    if (create) createDirectory(directory);
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()
        || !fs.realpathSync.native(directory).startsWith(`${physical}${path.sep}`)) {
        throw new TypeError('provider authentication mutation path is redirected');
      }
    }
    directory = path.join(directory, part);
  }
  if (create) createDirectory(directory);
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new TypeError('provider authentication mutation path is redirected');
    }
  }
  return {
    file: path.join(directory, `${provider}.json`),
    guard: path.join(directory, `${provider}.guard`),
    work: path.join(directory, `${provider}.work`),
  };
}

function validate(record, provider) {
  const keys = Object.keys(record || {}).sort().join(',');
  if (keys !== 'acquiredAt,expiresAt,mutationId,owner,phase,provider,schemaVersion'
    || record.schemaVersion !== SCHEMA_VERSION
    || record.provider !== provider
    || !PHASES.has(record.phase)
    || !/^[A-Za-z0-9_-]{16,128}$/.test(record.mutationId)
    || !record.owner
    || Object.keys(record.owner).sort().join(',') !== 'host,pid,processStart'
    || typeof record.owner.host !== 'string'
    || !Number.isSafeInteger(record.owner.pid)
    || typeof record.owner.processStart !== 'string'
    || !Number.isSafeInteger(record.acquiredAt)
    || !Number.isSafeInteger(record.expiresAt)
    || record.expiresAt <= record.acquiredAt) {
    throw new Error('provider authentication mutation record is invalid');
  }
  return record;
}

function validateWork(record, provider) {
  const keys = Object.keys(record || {}).sort().join(',');
  if (keys !== 'acquiredAt,expiresAt,owner,provider,schemaVersion,workId'
    || record.schemaVersion !== SCHEMA_VERSION
    || record.provider !== provider
    || !/^[A-Za-z0-9_-]{16,128}$/.test(record.workId)
    || !record.owner
    || Object.keys(record.owner).sort().join(',') !== 'host,pid,processStart'
    || typeof record.owner.host !== 'string'
    || !Number.isSafeInteger(record.owner.pid)
    || typeof record.owner.processStart !== 'string'
    || !Number.isSafeInteger(record.acquiredAt)
    || !Number.isSafeInteger(record.expiresAt)
    || record.expiresAt <= record.acquiredAt) {
    throw new Error('provider work record is invalid');
  }
  return record;
}

function activeWorkRecords(target, provider, at, { prune = false } = {}) {
  if (!fs.existsSync(target.work)) return [];
  const stat = fs.lstatSync(target.work);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('provider work authority path is redirected');
  }
  const active = [];
  for (const name of fs.readdirSync(target.work)) {
    if (!/^[A-Za-z0-9_-]{16,128}\.json$/.test(name)) {
      throw new Error('provider work authority directory is invalid');
    }
    const file = path.join(target.work, name);
    const bytes = fs.readFileSync(file);
    if (bytes.length > 4_096) throw new Error('provider work record is oversized');
    const record = validateWork(JSON.parse(bytes.toString('utf8')), provider);
    if (record.expiresAt > at) active.push(record);
    else if (prune) fs.rmSync(file);
  }
  if (prune && fs.existsSync(target.work) && fs.readdirSync(target.work).length === 0) {
    fs.rmdirSync(target.work);
  }
  return active;
}

function readGuardRecord(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const file = path.join(directory, GUARD_RECORD);
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > 4_096) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || Object.keys(record).sort().join(',') !== 'acquiredAt,owner,token'
      || !Number.isSafeInteger(record.acquiredAt)
      || !/^[A-Za-z0-9-]{16,128}$/.test(record.token)
      || !record.owner
      || Object.keys(record.owner).sort().join(',') !== 'host,pid,processStart'
      || typeof record.owner.host !== 'string'
      || !Number.isSafeInteger(record.owner.pid)
      || typeof record.owner.processStart !== 'string') return null;
    return record;
  } catch {
    return null;
  }
}

function removeOwnedGuard(directory, token) {
  const current = readGuardRecord(directory);
  if (!current || current.token !== token) return false;
  fs.rmSync(directory, { recursive: true, force: true });
  return true;
}

function createOwnedGuard(directory, acquiredAt) {
  const token = randomUUID();
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    atomicWriteFile(path.join(directory, GUARD_RECORD), `${JSON.stringify({
      token,
      owner: currentLeaseOwner(),
      acquiredAt,
    })}\n`, { mode: 0o600 });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return token;
}

function withGuard(root, provider, now, callback) {
  const target = paths(root, provider, true);
  let token;
  try {
    token = createOwnedGuard(target.guard, checkedNow(now));
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const observed = readGuardRecord(target.guard);
    if (!observed
      || checkedNow(now) - observed.acquiredAt <= GUARD_STALE_MS
      || processOwnerIsLiveOrAmbiguous(observed.owner)) return null;
    const quarantine = `${target.guard}.stale-${randomUUID()}`;
    try {
      fs.renameSync(target.guard, quarantine);
      const moved = readGuardRecord(quarantine);
      if (!moved || moved.token !== observed.token) {
        if (!fs.existsSync(target.guard)) fs.renameSync(quarantine, target.guard);
        return null;
      }
      fs.rmSync(quarantine, { recursive: true, force: true });
      token = createOwnedGuard(target.guard, checkedNow(now));
    } catch {
      return null;
    }
  }
  try {
    return callback(target);
  } finally {
    removeOwnedGuard(target.guard, token);
  }
}

export function readProviderAuthMutation(root, provider, { now } = {}) {
  const at = checkedNow(now);
  const { file } = paths(root, provider);
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  if (bytes.length > 4_096) throw new Error('provider authentication mutation record is oversized');
  const record = validate(JSON.parse(bytes.toString('utf8')), provider);
  return record.expiresAt > at ? structuredClone(record) : null;
}

export function assertProviderAuthIdle(root, provider, options = {}) {
  const mutation = readProviderAuthMutation(root, provider, options);
  if (mutation) throw new ProviderAuthMutationActiveError(provider, mutation.phase);
  return true;
}

export function acquireProviderAuthMutation(root, provider, {
  durationMs = DEFAULT_DURATION_MS,
  mutationId = randomUUID(),
  now,
  owner = {
    host: os.hostname(),
    pid: process.pid,
    processStart: `${process.pid}-${Math.floor(process.uptime() * 1000)}`,
  },
  phase = 'login',
} = {}) {
  const at = checkedNow(now);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > DEFAULT_DURATION_MS
    || !PHASES.has(phase)) {
    throw new TypeError('provider authentication mutation settings are invalid');
  }
  return withGuard(root, provider, at, (target) => {
    const { file } = target;
    const current = readProviderAuthMutation(root, provider, { now: at });
    if (current) return null;
    if (activeWorkRecords(target, provider, at, { prune: true }).length) return null;
    const record = validate({
      schemaVersion: SCHEMA_VERSION,
      provider,
      mutationId,
      phase,
      owner: {
        host: String(owner.host),
        pid: Number(owner.pid),
        processStart: String(owner.processStart),
      },
      acquiredAt: at,
      expiresAt: at + durationMs,
    }, provider);
    atomicWriteFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return structuredClone(record);
  });
}

export function acquireProviderWork(root, provider, {
  durationMs = DEFAULT_WORK_DURATION_MS,
  workId = randomUUID(),
  now,
  owner = {
    host: os.hostname(),
    pid: process.pid,
    processStart: `${process.pid}-${Math.floor(process.uptime() * 1000)}`,
  },
} = {}) {
  const at = checkedNow(now);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > DEFAULT_WORK_DURATION_MS) {
    throw new TypeError('provider work authority settings are invalid');
  }
  const capability = withGuard(root, provider, at, (target) => {
    const current = readProviderAuthMutation(root, provider, { now: at });
    if (current) throw new ProviderAuthMutationActiveError(provider, current.phase);
    activeWorkRecords(target, provider, at, { prune: true });
    if (!fs.existsSync(target.work)) fs.mkdirSync(target.work, { mode: 0o700 });
    const record = validateWork({
      schemaVersion: SCHEMA_VERSION,
      provider,
      workId,
      owner: {
        host: String(owner.host),
        pid: Number(owner.pid),
        processStart: String(owner.processStart),
      },
      acquiredAt: at,
      expiresAt: at + durationMs,
    }, provider);
    atomicWriteFile(path.join(target.work, `${workId}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return structuredClone(record);
  });
  if (!capability) throw new ProviderAuthMutationActiveError(provider, 'unknown');
  return capability;
}

export function renewProviderWork(root, capability, {
  durationMs = DEFAULT_WORK_DURATION_MS,
  now,
} = {}) {
  const provider = checkedProvider(capability?.provider);
  const at = checkedNow(now);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > DEFAULT_WORK_DURATION_MS) {
    throw new TypeError('provider work renewal settings are invalid');
  }
  const renewed = withGuard(root, provider, at, (target) => {
    const file = path.join(target.work, `${capability.workId}.json`);
    if (!fs.existsSync(file)) throw new Error('provider work capability was lost');
    const current = validateWork(JSON.parse(fs.readFileSync(file, 'utf8')), provider);
    if (current.workId !== capability.workId || current.expiresAt <= at) {
      throw new Error('provider work capability was lost');
    }
    const mutation = readProviderAuthMutation(root, provider, { now: at });
    if (mutation) throw new ProviderAuthMutationActiveError(provider, mutation.phase);
    const record = validateWork({ ...current, expiresAt: at + durationMs }, provider);
    atomicWriteFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return structuredClone(record);
  });
  if (!renewed) throw new Error('provider work authority could not be renewed');
  return renewed;
}

export function renewProviderAuthMutation(root, capability, {
  durationMs = DEFAULT_DURATION_MS,
  now,
} = {}) {
  const provider = checkedProvider(capability?.provider);
  const at = checkedNow(now);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > DEFAULT_DURATION_MS) {
    throw new TypeError('provider authentication mutation renewal settings are invalid');
  }
  const renewed = withGuard(root, provider, at, (target) => {
    if (!fs.existsSync(target.file)) {
      throw new Error('provider authentication mutation capability was lost');
    }
    const current = validate(JSON.parse(fs.readFileSync(target.file, 'utf8')), provider);
    if (current.mutationId !== capability.mutationId || current.expiresAt <= at) {
      throw new Error('provider authentication mutation capability was lost');
    }
    if (activeWorkRecords(target, provider, at, { prune: true }).length) {
      throw new Error('provider authentication mutation authority is inconsistent');
    }
    const record = validate({ ...current, expiresAt: at + durationMs }, provider);
    atomicWriteFile(target.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return structuredClone(record);
  });
  if (!renewed) throw new Error('provider authentication mutation authority could not be renewed');
  return renewed;
}

export function createProviderWorkSupervisor(root, provider, {
  acquire = acquireProviderWork,
  renew = renewProviderWork,
  release = releaseProviderWork,
  intervalMs = 5 * 60 * 1000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof acquire !== 'function' || typeof renew !== 'function' || typeof release !== 'function'
    || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError('provider work supervisor settings are invalid');
  }
  let capability = acquire(root, provider);
  let renewalError = null;
  let renewalPending = false;
  let renewalPromise = null;
  let releasePromise = null;
  let finished = false;
  let failureHandler = null;
  const timer = setIntervalFn(() => {
    if (renewalPending || finished) return;
    renewalPending = true;
    renewalPromise = Promise.resolve()
      .then(() => renew(root, capability))
      .then((value) => {
        if (value) capability = value;
      })
      .catch(async (error) => {
        try {
          const retried = await renew(root, capability);
          if (!retried) throw error;
          capability = retried;
          renewalError = null;
        } catch {
          renewalError = error;
          try { failureHandler?.(error); } catch {}
        }
      })
      .finally(() => {
        renewalPending = false;
        renewalPromise = null;
      });
  }, intervalMs);
  timer?.unref?.();

  const finish = async () => {
    finished = true;
    clearIntervalFn(timer);
    if (renewalPromise) await renewalPromise.catch(() => {});
    return release(root, capability);
  };
  return {
    setFailureHandler(handler) {
      if (handler !== null && typeof handler !== 'function') {
        throw new TypeError('provider work failure handler must be a function');
      }
      failureHandler = handler;
      if (renewalError && failureHandler) failureHandler(renewalError);
    },
    assertCurrent() {
      if (renewalError) throw renewalError;
      return true;
    },
    release(error = null) {
      const closure = error?.closure;
      if (releasePromise) {
        return closure && typeof closure.then === 'function'
          ? Promise.resolve(false)
          : releasePromise;
      }
      const transferred = closure && typeof closure.then === 'function';
      releasePromise = transferred
        ? Promise.resolve(closure).catch(() => {}).then(finish)
        : Promise.resolve().then(finish);
      releasePromise.catch(() => {});
      return transferred ? Promise.resolve(false) : releasePromise;
    },
  };
}

export function releaseProviderWork(root, capability, { now } = {}) {
  const provider = checkedProvider(capability?.provider);
  const at = checkedNow(now);
  const released = withGuard(root, provider, at, (target) => {
    const file = path.join(target.work, `${capability.workId}.json`);
    if (!fs.existsSync(file)) return false;
    const current = validateWork(JSON.parse(fs.readFileSync(file, 'utf8')), provider);
    if (current.workId !== capability.workId) throw new Error('provider work capability was lost');
    fs.rmSync(file);
    if (fs.readdirSync(target.work).length === 0) fs.rmdirSync(target.work);
    return true;
  });
  if (released === null) throw new Error('provider work authority could not be released');
  return released;
}

export function releaseProviderAuthMutation(root, capability, { now } = {}) {
  const provider = checkedProvider(capability?.provider);
  const at = checkedNow(now);
  return withGuard(root, provider, at, ({ file }) => {
    if (!fs.existsSync(file)) return false;
    const current = validate(JSON.parse(fs.readFileSync(file, 'utf8')), provider);
    if (current.mutationId !== capability.mutationId) {
      throw new Error('provider authentication mutation capability was lost');
    }
    fs.rmSync(file);
    return true;
  });
}
