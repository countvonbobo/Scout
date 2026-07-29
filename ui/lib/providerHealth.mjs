import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import {
  LeaseLostError,
  assertCurrentFence,
  assertScanLeaseScope,
  isScanLease,
  synchronousFenceCallback,
} from './scanLease.mjs';

export const PROVIDER_HEALTH_STATES = Object.freeze({
  CHECKING: 'checking',
  READY: 'ready',
  CREDENTIALS_PRESENT_UNVERIFIED: 'credentials-present-unverified',
  SIGN_IN_REQUIRED: 'sign-in-required',
  LOGIN_IN_PROGRESS: 'login-in-progress',
  NETWORK_UNAVAILABLE: 'network-unavailable',
  RATE_LIMITED: 'rate-limited',
  CLI_UPDATE_REQUIRED: 'cli-update-required',
  PROVIDER_ERROR: 'provider-error',
});

const SCHEMA_VERSION = 1;
const HISTORY_LIMIT = 32;
const FILE_LIMIT_BYTES = 16 * 1024;
const PROVIDERS = new Set(['codex', 'claude']);
const STATES = new Set(Object.values(PROVIDER_HEALTH_STATES));
const USABLE_STATES = new Set([
  PROVIDER_HEALTH_STATES.READY,
  PROVIDER_HEALTH_STATES.CREDENTIALS_PRESENT_UNVERIFIED,
]);
const SOURCES = new Set([
  'startup',
  'manual-preflight',
  'scheduled-preflight',
  'periodic',
  'post-auth',
  'provider-operation',
]);
const PURPOSES = new Set([
  'startup',
  'manual-run',
  'manual-discovery',
  'scheduled-job',
  'periodic',
  'post-auth',
  'post-auth-failure',
  'retry',
]);
const SIGNAL_FIELDS = new Set(['checkedAt', 'kind', 'reasonCode', 'source']);
const SIGNAL_DEFINITIONS = Object.freeze({
  'check-started': Object.freeze({
    state: PROVIDER_HEALTH_STATES.CHECKING,
    reasonCode: 'checking',
  }),
  'remote-success': Object.freeze({
    state: PROVIDER_HEALTH_STATES.READY,
    reasonCode: 'remote-ok',
  }),
  'local-credentials-present': Object.freeze({
    state: PROVIDER_HEALTH_STATES.CREDENTIALS_PRESENT_UNVERIFIED,
    reasonCode: 'credentials-found',
  }),
  'local-signed-out': Object.freeze({
    state: PROVIDER_HEALTH_STATES.SIGN_IN_REQUIRED,
    reasonCode: 'signed-out',
  }),
  'login-started': Object.freeze({
    state: PROVIDER_HEALTH_STATES.LOGIN_IN_PROGRESS,
    reasonCode: 'login-started',
  }),
  'remote-auth-failure': Object.freeze({
    state: PROVIDER_HEALTH_STATES.SIGN_IN_REQUIRED,
    reasonCode: 'authentication-required',
  }),
  'network-failure': Object.freeze({
    state: PROVIDER_HEALTH_STATES.NETWORK_UNAVAILABLE,
    reasonCode: 'network-unavailable',
  }),
  'rate-limit': Object.freeze({
    state: PROVIDER_HEALTH_STATES.RATE_LIMITED,
    reasonCode: 'rate-limited',
  }),
  'cli-update': Object.freeze({
    state: PROVIDER_HEALTH_STATES.CLI_UPDATE_REQUIRED,
    reasonCode: 'cli-update-required',
  }),
  'provider-failure': Object.freeze({
    state: PROVIDER_HEALTH_STATES.PROVIDER_ERROR,
    reasonCode: 'provider-error',
  }),
});
const REASON_CODES = new Set(
  Object.values(SIGNAL_DEFINITIONS).map(({ reasonCode }) => reasonCode),
);
const RECORD_KEYS = Object.freeze([
  'alert',
  'checkedAt',
  'history',
  'provider',
  'reasonCode',
  'remoteAuthBarrier',
  'schemaVersion',
  'state',
  'verified',
]);
const HISTORY_KEYS = Object.freeze(['at', 'purpose', 'reasonCode', 'source', 'state']);
const ALERT_KEYS = Object.freeze(['acknowledgedAt', 'createdAt', 'id', 'state']);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} has an unsupported schema`);
  }
  return value;
}

function providerName(provider) {
  if (!PROVIDERS.has(provider)) throw new TypeError('provider health provider is unsupported');
  return provider;
}

function sourceName(source) {
  if (!SOURCES.has(source)) throw new TypeError('provider health evidence source is unsupported');
  return source;
}

function purposeName(purpose) {
  if (!PURPOSES.has(purpose)) throw new TypeError('provider health purpose is unsupported');
  return purpose;
}

function timestamp(value, label = 'provider health timestamp') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== (value instanceof Date ? date.toISOString() : value)) {
    throw new TypeError(`${label} must be an exact ISO timestamp`);
  }
  return date.toISOString();
}

function nowTimestamp(now) {
  const value = typeof now === 'function' ? now() : (now ?? new Date());
  return timestamp(value);
}

function checkedSignal(signal, fallbackSource, now) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal)
    || Object.getPrototypeOf(signal) !== Object.prototype) {
    throw new TypeError('provider health signal must be a plain object');
  }
  for (const key of Object.keys(signal)) {
    if (!SIGNAL_FIELDS.has(key)) {
      throw new TypeError(`provider health signal contains unsupported field: ${key}`);
    }
  }
  const definition = SIGNAL_DEFINITIONS[signal.kind];
  if (!definition) throw new TypeError('provider health signal kind is unsupported');
  const source = sourceName(signal.source ?? fallbackSource);
  const checkedAt = signal.checkedAt === undefined
    ? nowTimestamp(now)
    : timestamp(signal.checkedAt);
  if (signal.reasonCode !== undefined
    && (!REASON_CODES.has(signal.reasonCode) || signal.reasonCode !== definition.reasonCode)) {
    throw new TypeError('provider health reason code is unsupported for this signal');
  }
  return {
    kind: signal.kind,
    state: definition.state,
    reasonCode: definition.reasonCode,
    source,
    checkedAt,
  };
}

export function classifyProviderHealth(signal) {
  return checkedSignal(signal, signal?.source ?? 'startup').state;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function rejectRedirect(component, root) {
  const stat = fs.lstatSync(component);
  if (stat.isSymbolicLink()) {
    throw new TypeError('provider health path traverses a symlink or junction');
  }
  const physical = fs.realpathSync.native(component);
  if (!isInside(root, physical)) {
    throw new TypeError('provider health path resolves outside its workspace');
  }
}

function providerFile(root, provider, { create = false } = {}) {
  providerName(provider);
  const lexicalRoot = path.resolve(root);
  if (!fs.existsSync(lexicalRoot) || !fs.statSync(lexicalRoot).isDirectory()) {
    throw new TypeError('provider health workspace root must be an existing directory');
  }
  const physicalRoot = fs.realpathSync.native(lexicalRoot);
  const components = [
    path.join(lexicalRoot, '.scout'),
    path.join(lexicalRoot, '.scout', 'provider-health'),
    path.join(lexicalRoot, '.scout', 'provider-health', `v${SCHEMA_VERSION}`),
  ];
  for (const component of components) {
    if (!fs.existsSync(component)) {
      if (!create) break;
      try {
        fs.mkdirSync(component, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (fs.existsSync(component)) rejectRedirect(component, physicalRoot);
  }
  const file = path.join(components.at(-1), `${provider}.json`);
  if (!isInside(lexicalRoot, file)) throw new TypeError('provider health path escapes its workspace');
  if (fs.existsSync(file)) rejectRedirect(file, physicalRoot);
  if (create) rejectRedirect(path.dirname(file), physicalRoot);
  return file;
}

function validateHistory(item) {
  exactKeys(item, HISTORY_KEYS, 'provider health history item');
  if (!STATES.has(item.state)) throw new Error('provider health history state is invalid');
  if (!REASON_CODES.has(item.reasonCode)) throw new Error('provider health history reason code is invalid');
  sourceName(item.source);
  purposeName(item.purpose);
  timestamp(item.at);
  return item;
}

function expectedAlertId(provider, state) {
  return `provider-health:${provider}:${state}`;
}

function validateAlert(alert, provider) {
  if (alert === null) return null;
  exactKeys(alert, ALERT_KEYS, 'provider health alert');
  if (!STATES.has(alert.state) || USABLE_STATES.has(alert.state)
    || alert.id !== expectedAlertId(provider, alert.state)) {
    throw new Error('provider health alert is invalid');
  }
  timestamp(alert.createdAt);
  if (alert.acknowledgedAt !== null) timestamp(alert.acknowledgedAt);
  return alert;
}

function validateRecord(value, provider) {
  exactKeys(value, RECORD_KEYS, 'provider health record');
  if (value.schemaVersion !== SCHEMA_VERSION || value.provider !== provider) {
    throw new Error('provider health record has an unsupported schema');
  }
  if (!STATES.has(value.state) || !REASON_CODES.has(value.reasonCode)
    || typeof value.remoteAuthBarrier !== 'boolean'
    || typeof value.verified !== 'boolean'
    || value.verified !== (value.state === PROVIDER_HEALTH_STATES.READY)
    || !Array.isArray(value.history)
    || value.history.length < 1
    || value.history.length > HISTORY_LIMIT) {
    throw new Error('provider health record is invalid');
  }
  timestamp(value.checkedAt);
  value.history.forEach(validateHistory);
  const last = value.history.at(-1);
  if (last.state !== value.state || last.reasonCode !== value.reasonCode
    || last.at !== value.checkedAt) {
    throw new Error('provider health record does not match its latest evidence');
  }
  validateAlert(value.alert, provider);
  if (USABLE_STATES.has(value.state) !== (value.alert === null)) {
    throw new Error('provider health record alert does not match its state');
  }
  return value;
}

function missingRecord(provider) {
  return {
    schemaVersion: SCHEMA_VERSION,
    provider,
    state: PROVIDER_HEALTH_STATES.CHECKING,
    reasonCode: 'checking',
    checkedAt: null,
    verified: false,
    remoteAuthBarrier: false,
    history: [],
    alert: null,
  };
}

export function readProviderHealth(root, provider) {
  providerName(provider);
  const file = providerFile(root, provider);
  if (!fs.existsSync(file)) return missingRecord(provider);
  const contents = fs.readFileSync(file);
  if (contents.length > FILE_LIMIT_BYTES) {
    throw new Error('provider health record exceeds its size limit');
  }
  let parsed;
  try {
    parsed = JSON.parse(contents.toString('utf8'));
  } catch {
    throw new Error('provider health record is invalid JSON');
  }
  return structuredClone(validateRecord(parsed, provider));
}

function inferredSource(purpose) {
  return {
    startup: 'startup',
    'manual-run': 'manual-preflight',
    'manual-discovery': 'manual-preflight',
    'scheduled-job': 'scheduled-preflight',
    periodic: 'periodic',
    'post-auth': 'post-auth',
    'post-auth-failure': 'post-auth',
    retry: 'manual-preflight',
  }[purpose];
}

function nextRecord(current, provider, evidence) {
  let { state, reasonCode } = evidence;
  let remoteAuthBarrier = current.remoteAuthBarrier;
  if (evidence.kind === 'remote-auth-failure') remoteAuthBarrier = true;
  if (evidence.kind === 'remote-success') remoteAuthBarrier = false;
  if (evidence.kind === 'local-credentials-present' && remoteAuthBarrier) {
    state = PROVIDER_HEALTH_STATES.SIGN_IN_REQUIRED;
    reasonCode = 'authentication-required';
  }
  const item = {
    state,
    reasonCode,
    source: evidence.source,
    purpose: evidence.purpose,
    at: evidence.checkedAt,
  };
  const alertId = USABLE_STATES.has(state) ? null : expectedAlertId(provider, state);
  const sameAlert = alertId !== null && current.alert?.id === alertId;
  const alert = alertId === null ? null : (sameAlert ? current.alert : {
    id: alertId,
    state,
    createdAt: evidence.checkedAt,
    acknowledgedAt: null,
  });
  const record = {
    schemaVersion: SCHEMA_VERSION,
    provider,
    state,
    reasonCode,
    checkedAt: evidence.checkedAt,
    verified: state === PROVIDER_HEALTH_STATES.READY,
    remoteAuthBarrier,
    history: [...current.history, item].slice(-HISTORY_LIMIT),
    alert,
  };
  return { record: validateRecord(record, provider), shouldNotify: alert !== null && !sameAlert };
}

function persistRecord(root, provider, evidence) {
  const current = readProviderHealth(root, provider);
  const { record, shouldNotify } = nextRecord(current, provider, evidence);
  const encoded = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(encoded) > FILE_LIMIT_BYTES) {
    throw new Error('provider health record exceeds its size limit');
  }
  const file = providerFile(root, provider, { create: true });
  atomicWriteFile(file, encoded, { mode: 0o600 });
  return { ...structuredClone(record), shouldNotify };
}

export function recordProviderHealth(root, provider, signal, {
  lease,
  now,
  purpose = 'startup',
  source,
} = {}) {
  providerName(provider);
  const checkedPurpose = purposeName(purpose);
  const evidence = {
    ...checkedSignal(signal, source ?? inferredSource(checkedPurpose), now),
    purpose: checkedPurpose,
  };
  if (lease === undefined && evidence.source !== 'provider-operation') {
    return persistRecord(root, provider, evidence);
  }
  if (!isScanLease(lease)) {
    throw new LeaseLostError('a genuine current scan lease is required for fenced provider health evidence');
  }
  assertScanLeaseScope(lease, root, lease.runId);
  return assertCurrentFence(lease, synchronousFenceCallback(
    () => persistRecord(root, provider, evidence),
  ));
}

export function acknowledgeProviderAlert(root, provider, alertId, { now } = {}) {
  providerName(provider);
  const current = readProviderHealth(root, provider);
  if (current.alert === null || current.alert.id !== alertId) {
    throw new Error('provider health alert is not active');
  }
  if (current.alert.acknowledgedAt !== null) return current;
  const record = {
    ...current,
    alert: { ...current.alert, acknowledgedAt: nowTimestamp(now) },
  };
  validateRecord(record, provider);
  const encoded = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(encoded) > FILE_LIMIT_BYTES) {
    throw new Error('provider health record exceeds its size limit');
  }
  const file = providerFile(root, provider, { create: true });
  atomicWriteFile(file, encoded, { mode: 0o600 });
  return structuredClone(record);
}

function preflightView(record, purpose, shouldNotify = false) {
  const ok = USABLE_STATES.has(record.state);
  return {
    ok,
    provider: record.provider,
    purpose,
    state: record.state,
    reasonCode: record.reasonCode,
    checkedAt: record.checkedAt,
    verified: record.verified,
    alertId: record.alert?.id ?? null,
    shouldNotify: ok ? false : shouldNotify,
  };
}

export async function providerPreflight(root, provider, purpose, {
  lease,
  now,
  probe,
  source,
} = {}) {
  providerName(provider);
  const checkedPurpose = purposeName(purpose);
  let record;
  let shouldNotify = false;
  if (probe !== undefined) {
    if (typeof probe !== 'function') throw new TypeError('provider health probe must be a function');
    const nextSignal = await probe({
      provider,
      purpose: checkedPurpose,
      previous: readProviderHealth(root, provider),
    });
    const result = recordProviderHealth(root, provider, nextSignal, {
      lease,
      now,
      purpose: checkedPurpose,
      source,
    });
    ({ shouldNotify, ...record } = result);
  } else {
    record = readProviderHealth(root, provider);
    if (record.checkedAt === null) {
      const result = recordProviderHealth(root, provider, {
        kind: 'check-started',
        source: source ?? inferredSource(checkedPurpose),
      }, { lease, now, purpose: checkedPurpose });
      ({ shouldNotify, ...record } = result);
    }
  }
  return preflightView(record, checkedPurpose, shouldNotify);
}
