import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './atomicWrite.mjs';
import {
  currentLeaseOwner, observeProcessOwner, processOwnerIsLiveOrAmbiguous,
} from './scanLease.mjs';

const PROVIDERS = new Set(['codex', 'claude']);
const PHASES = new Set(['login', 'logout']);
const SCHEMA_VERSION = 1;
const DEFAULT_DURATION_MS = 11 * 60 * 1000;
const DEFAULT_WORK_DURATION_MS = 30 * 60 * 1000;
const GUARD_STALE_MS = 15_000;
const GUARD_ACQUIRE_TIMEOUT_MS = 2_000;
const GUARD_HARD_TIMEOUT_MS = 6_000;
const WORK_GUARD_ACQUIRE_ATTEMPTS = 3;
const GUARD_RECORD = 'owner.json';
const guardSleep = new Int32Array(new SharedArrayBuffer(4));

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
  if (![
    'acquiredAt,expiresAt,mutationId,owner,phase,provider,schemaVersion',
    'acquiredAt,childOperation,expiresAt,mutationId,owner,phase,provider,schemaVersion',
  ].includes(keys)
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
  const childOperation = record.childOperation ?? null;
  if (childOperation !== null) {
    const childKeys = Object.keys(childOperation || {}).sort().join(',');
    if (childKeys !== 'operationId,owner,phase,state'
      || !/^[A-Za-z0-9_-]{16,128}$/.test(childOperation.operationId)
      || !PHASES.has(childOperation.phase)
      || !['starting', 'running'].includes(childOperation.state)
      || (childOperation.state === 'starting' && childOperation.owner !== null)) {
      throw new Error('provider authentication mutation record is invalid');
    }
    if (childOperation.state === 'running') {
      const childOwner = childOperation.owner;
      if (!childOwner
        || Object.keys(childOwner).sort().join(',') !== 'host,pid,processStart'
        || typeof childOwner.host !== 'string'
        || !Number.isSafeInteger(childOwner.pid)
        || (childOwner.processStart !== null && typeof childOwner.processStart !== 'string')) {
        throw new Error('provider authentication mutation record is invalid');
      }
    }
  }
  return Object.hasOwn(record, 'childOperation') ? record : { ...record, childOperation: null };
}

function mutationMayStillRun(record, at) {
  if (record.expiresAt > at || processOwnerIsLiveOrAmbiguous(record.owner)) return true;
  if (record.childOperation === null) return false;
  if (record.childOperation.state === 'starting' || record.childOperation.owner === null) return true;
  return processOwnerIsLiveOrAmbiguous(record.childOperation.owner);
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
    if (record.expiresAt > at || processOwnerIsLiveOrAmbiguous(record.owner)) active.push(record);
    else if (prune) fs.rmSync(file);
  }
  if (prune && fs.existsSync(target.work) && fs.readdirSync(target.work).length === 0) {
    fs.rmdirSync(target.work);
  }
  return active;
}

function inspectGuardRecord(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { state: 'ambiguous', record: null };
    const file = path.join(directory, GUARD_RECORD);
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > 4_096) {
      return { state: 'ambiguous', record: null };
    }
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || Object.keys(record).sort().join(',') !== 'acquiredAt,owner,token'
      || !Number.isSafeInteger(record.acquiredAt)
      || !/^[A-Za-z0-9-]{16,128}$/.test(record.token)
      || !record.owner
      || Object.keys(record.owner).sort().join(',') !== 'host,pid,processStart'
      || typeof record.owner.host !== 'string'
      || !Number.isSafeInteger(record.owner.pid)
      || typeof record.owner.processStart !== 'string') return { state: 'ambiguous', record: null };
    return { state: 'record', record };
  } catch (error) {
    return {
      state: error?.code === 'ENOENT' ? 'absent' : 'ambiguous',
      record: null,
    };
  }
}

function readGuardRecord(directory) {
  return inspectGuardRecord(directory).record;
}

function removeOwnedGuard(directory, token, scheduler = setTimeout) {
  const current = readGuardRecord(directory);
  if (!current || current.token !== token) return false;
  // Detach the still-verifiable identity before recursive deletion. Windows
  // may partially delete a directory and then report EPERM/EBUSY; doing that
  // at the canonical path could erase owner.json and leave an unrecoverable
  // guard. A detached quarantine can be retried without blocking successors.
  const quarantine = `${directory}.cleanup-${token}`;
  try {
    fs.renameSync(directory, quarantine);
  } catch (error) {
    if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    return false;
  }
  const moved = readGuardRecord(quarantine);
  if (!moved || moved.token !== token) {
    if (!fs.existsSync(directory)) fs.renameSync(quarantine, directory);
    return false;
  }
  try {
    fs.rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    scheduleQuarantineCleanup(quarantine, token, scheduler);
  }
  return true;
}

function scheduleQuarantineCleanup(directory, token, scheduler = setTimeout) {
  let delay = 25;
  const retry = () => {
    try {
      if (!fs.existsSync(directory)) return;
      const observed = inspectGuardRecord(directory);
      const pending = observed.record;
      if (pending?.token === token) {
        fs.rmSync(directory, { recursive: true, force: true });
        return;
      }
      if (pending) return;
      if (observed.state === 'ambiguous') throw new Error('guard cleanup identity is temporarily unreadable');
      // A prior verified recursive delete may have removed owner.json before
      // Windows refused the final directory removal. Only an empty, ordinary
      // quarantine at this unguessable identity path is safe to finish.
      const stat = fs.lstatSync(directory);
      if (!stat.isSymbolicLink() && stat.isDirectory() && fs.readdirSync(directory).length === 0) {
        fs.rmdirSync(directory);
      }
      return;
    } catch {}
    delay = Math.min(delay * 2, 1_000);
    const timer = scheduler(retry, delay);
    timer.unref?.();
  };
  const timer = scheduler(retry, 25);
  timer.unref?.();
}

function scheduleOwnedGuardCleanup(directory, token, scheduler = setTimeout) {
  let delay = 25;
  const retry = () => {
    const observed = inspectGuardRecord(directory);
    const current = observed.record;
    if (observed.state === 'absent' || (current && current.token !== token)) return;
    if (observed.state === 'ambiguous') {
      delay = Math.min(delay * 2, 1_000);
      const timer = scheduler(retry, delay);
      timer.unref?.();
      return;
    }
    let removed = false;
    try { removed = removeOwnedGuard(directory, token, scheduler); } catch {}
    if (removed || !fs.existsSync(directory)) return;
    delay = Math.min(delay * 2, 1_000);
    const timer = scheduler(retry, delay);
    timer.unref?.();
  };
  const timer = scheduler(retry, 25);
  timer.unref?.();
}

function cleanupOrphanCandidates(guard, now) {
  const parent = path.dirname(guard);
  const prefix = `${path.basename(guard)}.candidate-`;
  let names;
  try { names = fs.readdirSync(parent); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const candidate = path.join(parent, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory() || now - stat.mtimeMs <= GUARD_STALE_MS) continue;
      const record = readGuardRecord(candidate);
      if (record && processOwnerIsLiveOrAmbiguous(record.owner)) continue;
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {}
  }
}

function createOwnedGuard(directory, acquiredAt) {
  const token = randomUUID();
  const candidate = `${directory}.candidate-${token}`;
  fs.mkdirSync(candidate, { mode: 0o700 });
  try {
    atomicWriteFile(path.join(candidate, GUARD_RECORD), `${JSON.stringify({
      token,
      owner: currentLeaseOwner(),
      acquiredAt,
    })}\n`, { mode: 0o600 });
  } catch (error) {
    fs.rmSync(candidate, { recursive: true, force: true });
    throw error;
  }
  return { candidate, token };
}

function ownerPidIsDefinitelyAbsent(owner) {
  if (owner?.host !== currentLeaseOwner().host || !Number.isSafeInteger(owner?.pid)) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function withGuard(root, provider, now, callback, scheduler = setTimeout, timing = {}) {
  const inactivityMs = timing.inactivityMs ?? GUARD_ACQUIRE_TIMEOUT_MS;
  const hardTimeoutMs = timing.hardTimeoutMs ?? GUARD_HARD_TIMEOUT_MS;
  if (!Number.isSafeInteger(inactivityMs) || inactivityMs <= 0
    || !Number.isSafeInteger(hardTimeoutMs) || hardTimeoutMs < inactivityMs) {
    throw new TypeError('provider authentication guard timing is invalid');
  }
  const target = paths(root, provider, true);
  const acquiredAt = checkedNow(now);
  cleanupOrphanCandidates(target.guard, Date.now());
  const prepared = createOwnedGuard(target.guard, acquiredAt);
  const budget = timing.budget || {};
  if (!Number.isFinite(budget.hardDeadline)) {
    budget.hardDeadline = performance.now() + hardTimeoutMs;
  }
  const { hardDeadline } = budget;
  // Platform process-identity probes and orphan housekeeping are setup work,
  // not lock contention. Give every prepared candidate the full retry budget.
  let deadline = Math.min(hardDeadline, performance.now() + inactivityMs);
  let observedToken = null;
  let published = false;
  try {
    while (!published) {
      if (performance.now() >= hardDeadline) return null;
      try {
        fs.renameSync(prepared.candidate, target.guard);
        published = true;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
        const observed = readGuardRecord(target.guard);
        if (observed) {
          let reclaim = false;
          if (observed.token !== observedToken) {
            observedToken = observed.token;
            // A new verified owner means contenders are making progress.
            // Bound only inactivity so several short critical sections can
            // serialize without later contenders being misreported as busy.
            deadline = Math.min(hardDeadline, performance.now() + inactivityMs);
            reclaim = ownerPidIsDefinitelyAbsent(observed.owner)
              || (acquiredAt - observed.acquiredAt > GUARD_STALE_MS
                && !processOwnerIsLiveOrAmbiguous(observed.owner));
          }
          if (reclaim) {
            const quarantine = `${target.guard}.stale-${randomUUID()}`;
            try {
              fs.renameSync(target.guard, quarantine);
              const moved = readGuardRecord(quarantine);
              if (!moved || moved.token !== observed.token) {
                if (!fs.existsSync(target.guard)) fs.renameSync(quarantine, target.guard);
              } else {
                try {
                  fs.rmSync(quarantine, { recursive: true, force: true });
                } catch (cleanupError) {
                  if (!['EBUSY', 'EPERM', 'EACCES'].includes(cleanupError?.code)) throw cleanupError;
                  scheduleQuarantineCleanup(quarantine, observed.token);
                }
                continue;
              }
            } catch {}
          }
          const remaining = deadline - performance.now();
          if (remaining <= 0) return null;
          Atomics.wait(guardSleep, 0, 0, Math.min(5, remaining));
          continue;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) return null;
        Atomics.wait(guardSleep, 0, 0, Math.min(5, remaining));
      }
    }
    return callback(target);
  } finally {
    if (published) {
      let removed = false;
      try { removed = removeOwnedGuard(target.guard, prepared.token, scheduler); } catch {}
      if (!removed) scheduleOwnedGuardCleanup(target.guard, prepared.token, scheduler);
    }
    else {
      try { fs.rmSync(prepared.candidate, { recursive: true, force: true }); } catch {}
    }
  }
}

export function readProviderAuthMutation(root, provider, { now } = {}) {
  const at = checkedNow(now);
  const { file } = paths(root, provider);
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  if (bytes.length > 4_096) throw new Error('provider authentication mutation record is oversized');
  const record = validate(JSON.parse(bytes.toString('utf8')), provider);
  return mutationMayStillRun(record, at)
    ? structuredClone(record)
    : null;
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
  owner = currentLeaseOwner(),
  phase = 'login',
  _testHooks = {},
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
      childOperation: null,
      acquiredAt: at,
      expiresAt: at + durationMs,
    }, provider);
    atomicWriteFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return structuredClone(record);
  }, _testHooks.cleanupScheduler || setTimeout, {
    inactivityMs: _testHooks.guardInactivityMs,
    hardTimeoutMs: _testHooks.guardHardTimeoutMs,
  });
}

function updateProviderAuthMutationChild(root, capability, update, { now } = {}) {
  const provider = checkedProvider(capability?.provider);
  const at = checkedNow(now);
  const changed = withGuard(root, provider, at, (target) => {
    if (!fs.existsSync(target.file)) throw new Error('provider authentication mutation capability was lost');
    const current = validate(JSON.parse(fs.readFileSync(target.file, 'utf8')), provider);
    if (current.mutationId !== capability.mutationId) {
      throw new Error('provider authentication mutation capability was lost');
    }
    const record = validate(update(current), provider);
    atomicWriteFile(target.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return structuredClone(record);
  });
  if (!changed) throw new Error('provider authentication mutation authority could not be updated');
  return changed;
}

export function beginProviderAuthMutationChild(root, capability, phase, options = {}) {
  if (!PHASES.has(phase)) throw new TypeError('provider authentication child phase is invalid');
  const operationId = randomUUID();
  updateProviderAuthMutationChild(root, capability, (current) => {
    if (current.childOperation !== null) {
      throw new Error('provider authentication mutation child is already active');
    }
    return {
      ...current,
      childOperation: { operationId, phase, state: 'starting', owner: null },
    };
  }, options);
  return operationId;
}

export function attachProviderAuthMutationChild(root, capability, operationId, pid, options = {}) {
  return updateProviderAuthMutationChild(root, capability, (current) => {
    if (current.childOperation?.operationId !== operationId
      || current.childOperation.state !== 'starting') {
      throw new Error('provider authentication mutation child ownership changed');
    }
    return {
      ...current,
      childOperation: {
        ...current.childOperation,
        state: 'running',
        owner: observeProcessOwner(pid),
      },
    };
  }, options);
}

export function finishProviderAuthMutationChild(root, capability, operationId, options = {}) {
  return updateProviderAuthMutationChild(root, capability, (current) => {
    if (current.childOperation?.operationId !== operationId) {
      throw new Error('provider authentication mutation child ownership changed');
    }
    return { ...current, childOperation: null };
  }, options);
}

export function acquireProviderWork(root, provider, {
  durationMs = DEFAULT_WORK_DURATION_MS,
  workId = randomUUID(),
  now,
  owner = currentLeaseOwner(),
} = {}) {
  const at = checkedNow(now);
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > DEFAULT_WORK_DURATION_MS) {
    throw new TypeError('provider work authority settings are invalid');
  }
  let capability = null;
  const budget = {};
  for (let attempt = 0; attempt < WORK_GUARD_ACQUIRE_ATTEMPTS && !capability; attempt += 1) {
    capability = withGuard(root, provider, at, (target) => {
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
    }, setTimeout, { budget });
  }
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
    if (current.workId !== capability.workId) {
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
    if (current.mutationId !== capability.mutationId) {
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
  const released = withGuard(root, provider, at, ({ file }) => {
    if (!fs.existsSync(file)) return false;
    const current = validate(JSON.parse(fs.readFileSync(file, 'utf8')), provider);
    if (current.mutationId !== capability.mutationId) {
      throw new Error('provider authentication mutation capability was lost');
    }
    if (current.childOperation !== null
      && (current.childOperation.state === 'starting'
        || processOwnerIsLiveOrAmbiguous(current.childOperation.owner))) {
      throw new Error('provider authentication mutation child has not closed');
    }
    fs.rmSync(file);
    return true;
  });
  if (released === null) throw new Error('provider authentication mutation authority could not be released');
  return released;
}
