import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './atomicWrite.mjs';

const PROVIDERS = new Set(['codex', 'claude']);
const PHASES = new Set(['login', 'logout']);
const SCHEMA_VERSION = 1;
const DEFAULT_DURATION_MS = 11 * 60 * 1000;
const GUARD_STALE_MS = 15_000;

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

function withGuard(root, provider, now, callback) {
  const target = paths(root, provider, true);
  try {
    fs.mkdirSync(target.guard, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(target.guard);
    if (!stat.isDirectory() || checkedNow(now) - Math.floor(stat.mtimeMs) <= GUARD_STALE_MS) return null;
    const quarantine = `${target.guard}.stale-${randomUUID()}`;
    try {
      fs.renameSync(target.guard, quarantine);
      fs.rmSync(quarantine, { recursive: true, force: true });
      fs.mkdirSync(target.guard, { mode: 0o700 });
    } catch {
      return null;
    }
  }
  try {
    return callback(target);
  } finally {
    fs.rmSync(target.guard, { recursive: true, force: true });
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
  return withGuard(root, provider, at, ({ file }) => {
    const current = readProviderAuthMutation(root, provider, { now: at });
    if (current) return null;
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
