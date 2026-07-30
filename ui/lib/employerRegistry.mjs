import crypto from 'node:crypto';
import fs from 'node:fs';
import { atomicWriteFile } from './atomicWrite.mjs';
import { workspacePaths } from './workspace.mjs';

export const EMPLOYER_REGISTRY_SCHEMA_VERSION = 1;
export const MAX_EMPLOYERS = 256;
export const MAX_EMPLOYER_HISTORY = 20;
export const MAX_MONITORED_EMPLOYERS = 32;

const ORIGINS = Object.freeze([
  'named-profile', 'advert-discovered', 'research-discovered', 'manual',
]);
const PRIORITIES = Object.freeze([
  'priority', 'relevant', 'normal', 'inactive', 'irrelevant',
]);
const ADAPTERS = Object.freeze([
  'greenhouse', 'lever', 'ashby', 'structured-data', 'generic',
]);
const HEALTH = Object.freeze([
  'unknown', 'healthy', 'degraded', 'blocked', 'unsupported',
]);
const TERMS = Object.freeze(['unreviewed', 'allowed', 'disallowed']);
const ROBOTS = Object.freeze(['unknown', 'allowed', 'disallowed']);

function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('employer registry numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('employer registry values must be plain JSON');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function boundedText(value, maximum = 160) {
  return String(value ?? '').normalize('NFKC').replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ').trim().slice(0, maximum);
}

function normalizedName(value) {
  return boundedText(value).toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function compareText(left, right) {
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function timestamp(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError(`employer ${name} must be an ISO timestamp`);
  }
  return value;
}

function optionalTimestamp(value, name) {
  return value === null ? null : timestamp(value, name);
}

function counter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`employer ${name} must be a non-negative integer`);
  }
  return value;
}

function stringList(value, name, maximum = 32) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`employer ${name} must be a bounded array`);
  }
  const result = value.map((item) => boundedText(item));
  if (result.some((item) => !item) || new Set(result.map(normalizedName)).size !== result.length) {
    throw new TypeError(`employer ${name} must contain unique non-empty values`);
  }
  return result;
}

function uniqueTexts(values, maximum = 32) {
  const byNormalized = new Map();
  for (const value of values.map((item) => boundedText(item)).filter(Boolean).sort(compareText)) {
    const key = normalizedName(value);
    if (!byNormalized.has(key)) byNormalized.set(key, value);
  }
  return [...byNormalized.values()].slice(0, maximum);
}

function canonicalUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(String(value)); } catch { throw new TypeError('employer careers URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError('employer careers URL is invalid');
  }
  url.hash = '';
  return url.toString();
}

export function canonicalEmployerId(name) {
  const normalized = normalizedName(name);
  if (!normalized) throw new TypeError('employer canonical name is required');
  return `employer-${digest(`name:${normalized}`).slice(0, 16)}`;
}

function origin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !ORIGINS.includes(value.kind)) {
    throw new TypeError('employer origin is invalid');
  }
  const reference = boundedText(value.reference, 160);
  if (!reference) throw new TypeError('employer origin reference is required');
  return {
    kind: value.kind,
    recordedAt: timestamp(value.recordedAt, 'origin time'),
    reference,
  };
}

function defaultAccess(value = {}) {
  return {
    terms: value.terms || 'unreviewed',
    robots: value.robots || 'unknown',
    genericEnabled: value.genericEnabled === true,
    minIntervalMinutes: value.minIntervalMinutes ?? 60,
  };
}

function defaultDecision(priority) {
  return {
    state: priority === 'inactive' ? 'inactive'
      : priority === 'irrelevant' ? 'irrelevant' : 'active',
    reason: null,
    decidedAt: null,
  };
}

function makeEmployer(value, now) {
  const canonicalName = boundedText(value?.canonicalName);
  const normalized = normalizedName(canonicalName);
  if (!normalized) throw new TypeError('employer canonical name is required');
  const userPriority = PRIORITIES.includes(value?.userPriority) ? value.userPriority : 'normal';
  const aliases = uniqueTexts(value?.aliases || [])
    .filter((item) => normalizedName(item) !== normalized)
    .slice(0, 32);
  const industries = uniqueTexts(value?.industries || []);
  const locations = uniqueTexts(value?.locations || []);
  const board = value?.board ? {
    adapter: boundedText(value.board.adapter, 40).toLowerCase(),
    boardId: boundedText(value.board.boardId, 160),
  } : null;
  return {
    id: canonicalEmployerId(canonicalName),
    canonicalName,
    normalizedName: normalized,
    aliases,
    origins: [origin(value.origin)],
    careersUrl: canonicalUrl(value?.careersUrl),
    board,
    industries,
    locations,
    userPriority,
    decision: defaultDecision(userPriority),
    access: defaultAccess(value?.access),
    health: {
      status: 'unknown',
      reasonCode: null,
      consecutiveFailures: 0,
      lastCheckedAt: null,
      lastSuccessAt: null,
    },
    monitoring: {
      runCount: 0,
      lastCheckedAt: null,
      nextEligibleAt: null,
    },
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

function validateDecision(value, priority) {
  if (!value || !['active', 'inactive', 'irrelevant'].includes(value.state)
    || ![null, 'string'].includes(value.reason === null ? null : typeof value.reason)
    || (value.reason !== null && (!boundedText(value.reason) || value.reason.length > 160))) {
    throw new TypeError('employer decision is invalid');
  }
  optionalTimestamp(value.decidedAt, 'decision time');
  if ((priority === 'inactive' && value.state !== 'inactive')
    || (priority === 'irrelevant' && value.state !== 'irrelevant')
    || (!['inactive', 'irrelevant'].includes(priority) && value.state !== 'active')) {
    throw new TypeError('employer priority and decision are inconsistent');
  }
}

function validateAccess(value) {
  if (!value || !TERMS.includes(value.terms) || !ROBOTS.includes(value.robots)
    || typeof value.genericEnabled !== 'boolean'
    || !Number.isSafeInteger(value.minIntervalMinutes)
    || value.minIntervalMinutes < 15 || value.minIntervalMinutes > 43_200) {
    throw new TypeError('employer access policy is invalid');
  }
}

function validateHealth(value) {
  if (!value || !HEALTH.includes(value.status)
    || (value.reasonCode !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.reasonCode))) {
    throw new TypeError('employer health is invalid');
  }
  counter(value.consecutiveFailures, 'health failure count');
  optionalTimestamp(value.lastCheckedAt, 'health check time');
  optionalTimestamp(value.lastSuccessAt, 'health success time');
}

function validateHistory(employer) {
  if (!Array.isArray(employer.history) || employer.history.length > MAX_EMPLOYER_HISTORY) {
    throw new TypeError('employer history is invalid');
  }
  const runIds = new Set();
  for (const event of employer.history) {
    if (!event || event.employerId !== employer.id
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.runId || '')
      || !ADAPTERS.includes(event.adapter) || !HEALTH.includes(event.status)) {
      throw new TypeError('employer history event is invalid');
    }
    if (runIds.has(event.runId)) throw new TypeError('employer history run ID is duplicated');
    runIds.add(event.runId);
    timestamp(event.recordedAt, 'history time');
    counter(event.returned, 'history returned');
    counter(event.parsed, 'history parsed');
    if (event.parsed > event.returned) throw new TypeError('employer history counts are inconsistent');
    if (event.failureCode !== undefined
      && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.failureCode)) {
      throw new TypeError('employer history failure code is invalid');
    }
  }
}

function validateEmployer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('employer record is invalid');
  }
  const normalized = normalizedName(value.canonicalName);
  if (!normalized || value.normalizedName !== normalized
    || value.id !== canonicalEmployerId(value.canonicalName)) {
    throw new TypeError('employer identity is invalid');
  }
  stringList(value.aliases, 'aliases');
  stringList(value.industries, 'industries');
  stringList(value.locations, 'locations');
  if (!Array.isArray(value.origins) || !value.origins.length || value.origins.length > 64) {
    throw new TypeError('employer origins are invalid');
  }
  value.origins.forEach(origin);
  if (value.careersUrl !== null && canonicalUrl(value.careersUrl) !== value.careersUrl) {
    throw new TypeError('employer careers URL is invalid');
  }
  if (value.board !== null && (
    !ADAPTERS.slice(0, 3).includes(value.board?.adapter)
    || !boundedText(value.board?.boardId)
    || value.board.boardId.length > 160
  )) {
    throw new TypeError('employer board is invalid');
  }
  if (!PRIORITIES.includes(value.userPriority)) throw new TypeError('employer priority is invalid');
  validateDecision(value.decision, value.userPriority);
  validateAccess(value.access);
  validateHealth(value.health);
  if (!value.monitoring || counter(value.monitoring.runCount, 'monitoring run count') < 0) {
    throw new TypeError('employer monitoring state is invalid');
  }
  optionalTimestamp(value.monitoring.lastCheckedAt, 'monitoring check time');
  optionalTimestamp(value.monitoring.nextEligibleAt, 'monitoring eligibility time');
  validateHistory(value);
  timestamp(value.createdAt, 'creation time');
  timestamp(value.updatedAt, 'update time');
  return value;
}

export function validateEmployerRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)
    || registry.schemaVersion !== EMPLOYER_REGISTRY_SCHEMA_VERSION) {
    throw new TypeError('employer registry schema is unsupported');
  }
  timestamp(registry.generatedAt, 'registry generation time');
  timestamp(registry.updatedAt, 'registry update time');
  counter(registry.generation, 'registry generation');
  if (registry.generation < 1
    || !Array.isArray(registry.employers) || registry.employers.length > MAX_EMPLOYERS
    || !Array.isArray(registry.archivedEmployers) || registry.archivedEmployers.length > MAX_EMPLOYERS) {
    throw new TypeError('employer registry capacity is invalid');
  }
  const ids = new Set();
  for (const employer of registry.employers) {
    validateEmployer(employer);
    if (ids.has(employer.id)) throw new TypeError('employer ID is duplicated');
    ids.add(employer.id);
  }
  for (const employer of registry.archivedEmployers) {
    validateEmployer(employer);
    if (ids.has(employer.id)) throw new TypeError('employer ID is duplicated');
    ids.add(employer.id);
  }
  return registry;
}

export function createEmployerRegistry(discoveries = [], {
  now = () => new Date().toISOString(),
} = {}) {
  const generatedAt = now();
  const empty = {
    schemaVersion: EMPLOYER_REGISTRY_SCHEMA_VERSION,
    generatedAt,
    updatedAt: generatedAt,
    generation: 1,
    employers: [],
    archivedEmployers: [],
  };
  return reconcileEmployerDiscoveries(empty, discoveries, { now: () => generatedAt, increment: false });
}

function originKey(value) {
  return `${value.kind}:${value.reference}:${value.recordedAt}`;
}

function mergeEmployer(current, incoming, now) {
  const aliases = uniqueTexts([...current.aliases, ...incoming.aliases])
    .filter((item) => normalizedName(item) !== current.normalizedName)
    .slice(0, 32);
  const origins = [...new Map([...current.origins, ...incoming.origins]
    .map((item) => [originKey(item), item])).values()]
    .sort((left, right) => compareText(left.kind, right.kind)
      || compareText(left.recordedAt, right.recordedAt)
      || compareText(left.reference, right.reference))
    .slice(-64);
  return {
    ...current,
    aliases,
    origins,
    careersUrl: current.careersUrl || incoming.careersUrl,
    board: current.board || incoming.board,
    industries: uniqueTexts([...current.industries, ...incoming.industries]),
    locations: uniqueTexts([...current.locations, ...incoming.locations]),
    updatedAt: now,
  };
}

function matchingEmployer(employers, incoming) {
  const names = new Set([incoming.normalizedName, ...incoming.aliases.map(normalizedName)]);
  const matches = employers.filter((employer) => (
    names.has(employer.normalizedName)
    || employer.aliases.some((alias) => names.has(normalizedName(alias)))
  ));
  if (matches.length > 1) throw new Error('employer identity is ambiguous and requires review');
  return matches[0] || null;
}

export function reconcileEmployerDiscoveries(registry, discoveries = [], {
  now = () => new Date().toISOString(),
  increment = true,
} = {}) {
  validateEmployerRegistry(registry);
  if (!Array.isArray(discoveries) || discoveries.length > MAX_EMPLOYERS) {
    throw new TypeError('employer discoveries must be a bounded array');
  }
  const updatedAt = now();
  const employers = registry.employers.map((value) => structuredClone(value));
  for (const discovery of discoveries) {
    const incoming = makeEmployer(discovery, updatedAt);
    const existing = matchingEmployer(employers, incoming);
    if (existing) {
      const index = employers.indexOf(existing);
      employers[index] = mergeEmployer(existing, incoming, updatedAt);
    } else {
      if (employers.length >= MAX_EMPLOYERS) throw new RangeError('employer registry exceeds capacity');
      employers.push(incoming);
    }
  }
  employers.sort((left, right) => compareText(left.id, right.id));
  return validateEmployerRegistry({
    ...structuredClone(registry),
    updatedAt,
    generation: registry.generation + (increment && discoveries.length ? 1 : 0),
    employers,
  });
}

function eligibleAt(employer, now) {
  if (employer.userPriority === 'irrelevant') return false;
  const next = employer.monitoring.nextEligibleAt;
  if (next && new Date(next).getTime() > new Date(now).getTime()) return false;
  if (employer.userPriority !== 'inactive' || !employer.monitoring.lastCheckedAt) return true;
  return new Date(now).getTime() - new Date(employer.monitoring.lastCheckedAt).getTime()
    >= 30 * 24 * 60 * 60 * 1000;
}

function monitoringOrder(left, right) {
  return compareText(left.monitoring.lastCheckedAt || '', right.monitoring.lastCheckedAt || '')
    || left.monitoring.runCount - right.monitoring.runCount
    || compareText(left.id, right.id);
}

export function selectEmployersForMonitoring(registry, {
  limit = 12,
  now = () => new Date().toISOString(),
} = {}) {
  validateEmployerRegistry(registry);
  const at = now();
  timestamp(at, 'monitoring selection time');
  const capacity = Math.max(0, Math.min(MAX_MONITORED_EMPLOYERS, Math.floor(Number(limit))));
  if (!capacity) return [];
  const eligible = registry.employers.filter((employer) => eligibleAt(employer, at));
  const priority = eligible.filter(({ userPriority }) => userPriority === 'priority').sort(monitoringOrder);
  const selected = priority.slice(0, MAX_MONITORED_EMPLOYERS);
  const bands = ['relevant', 'normal', 'inactive'].map((band) => [
    band,
    eligible.filter(({ userPriority }) => userPriority === band).sort(monitoringOrder),
  ]);
  for (const [, employers] of bands) {
    if (selected.length >= capacity) break;
    const employer = employers.shift();
    if (employer) selected.push(employer);
  }
  const remaining = bands.flatMap(([, employers]) => employers).sort(monitoringOrder);
  for (const employer of remaining) {
    if (selected.length >= capacity) break;
    selected.push(employer);
  }
  return selected.slice(0, MAX_MONITORED_EMPLOYERS).map((value) => structuredClone(value));
}

function checkResult(value) {
  if (!value || !/^employer-[a-f0-9]{16}$/.test(value.employerId || '')
    || !ADAPTERS.includes(value.adapter) || !HEALTH.slice(1).includes(value.status)) {
    throw new TypeError('employer check result is invalid');
  }
  const returned = counter(value.returned, 'check returned');
  const parsed = counter(value.parsed, 'check parsed');
  if (parsed > returned) throw new TypeError('employer check counts are inconsistent');
  const result = {
    employerId: value.employerId,
    adapter: value.adapter,
    status: value.status,
    returned,
    parsed,
  };
  if (value.failureCode !== undefined) {
    const failureCode = boundedText(value.failureCode, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!failureCode) throw new TypeError('employer check failure code is invalid');
    result.failureCode = failureCode;
  }
  if (value.status !== 'healthy' && !result.failureCode) {
    throw new TypeError('non-healthy employer check requires a failure code');
  }
  return result;
}

function nextEligibleAt(employer, recordedAt) {
  const minutes = employer.userPriority === 'inactive'
    ? Math.max(employer.access.minIntervalMinutes, 30 * 24 * 60)
    : employer.access.minIntervalMinutes;
  return new Date(new Date(recordedAt).getTime() + minutes * 60_000).toISOString();
}

export function recordEmployerChecks(registry, {
  runId, recordedAt, checks,
} = {}) {
  validateEmployerRegistry(registry);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId || '')) {
    throw new TypeError('employer check run ID is invalid');
  }
  timestamp(recordedAt, 'check time');
  if (!Array.isArray(checks) || checks.length > MAX_MONITORED_EMPLOYERS) {
    throw new TypeError('employer check results must be bounded');
  }
  const byId = new Map();
  for (const check of checks) {
    const result = checkResult(check);
    if (byId.has(result.employerId)) throw new TypeError('employer check result is duplicated');
    byId.set(result.employerId, result);
  }
  let changed = false;
  const employers = registry.employers.map((employer) => {
    const result = byId.get(employer.id);
    if (!result || employer.history.some((event) => event.runId === runId)) return employer;
    changed = true;
    const successful = result.status === 'healthy';
    const event = { runId, recordedAt, ...result };
    return {
      ...employer,
      updatedAt: recordedAt,
      health: {
        status: result.status,
        reasonCode: result.failureCode || null,
        consecutiveFailures: successful ? 0 : employer.health.consecutiveFailures + 1,
        lastCheckedAt: recordedAt,
        lastSuccessAt: successful ? recordedAt : employer.health.lastSuccessAt,
      },
      monitoring: {
        runCount: employer.monitoring.runCount + 1,
        lastCheckedAt: recordedAt,
        nextEligibleAt: nextEligibleAt(employer, recordedAt),
      },
      history: [...employer.history, event].slice(-MAX_EMPLOYER_HISTORY),
    };
  });
  if (!changed) return registry;
  return validateEmployerRegistry({
    ...structuredClone(registry),
    updatedAt: recordedAt,
    employers,
  });
}

export function updateEmployerRegistryEntry(registry, value, {
  now = () => new Date().toISOString(),
} = {}) {
  validateEmployerRegistry(registry);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('employer registry update is invalid');
  }
  const updatedAt = now();
  timestamp(updatedAt, 'registry update time');
  let working = structuredClone(registry);
  let created = false;
  let id = boundedText(value.id, 80);
  if (!id) {
    const canonicalName = boundedText(value.canonicalName);
    if (!canonicalName) throw new TypeError('new employer canonical name is required');
    working = reconcileEmployerDiscoveries(working, [{
      canonicalName,
      origin: {
        kind: 'manual',
        recordedAt: updatedAt,
        reference: 'settings',
      },
    }], { now: () => updatedAt });
    id = canonicalEmployerId(canonicalName);
    created = true;
  }
  const index = working.employers.findIndex((employer) => employer.id === id);
  if (index < 0) throw new TypeError('employer registry entry is unavailable');
  const current = working.employers[index];
  if (value.canonicalName !== undefined
    && canonicalEmployerId(value.canonicalName) !== current.id) {
    throw new TypeError('employer canonical identity cannot be changed');
  }
  const userPriority = value.userPriority ?? current.userPriority;
  if (!PRIORITIES.includes(userPriority)) throw new TypeError('employer priority is invalid');
  const careersUrl = value.careersUrl === undefined
    ? current.careersUrl
    : canonicalUrl(value.careersUrl);
  const board = value.board === undefined
    ? current.board
    : value.board === null ? null : {
      adapter: boundedText(value.board.adapter, 40).toLowerCase(),
      boardId: boundedText(value.board.boardId, 160),
    };
  const access = value.access === undefined
    ? current.access
    : {
      terms: value.access.terms,
      robots: value.access.robots,
      genericEnabled: value.access.genericEnabled === true,
      minIntervalMinutes: Number(value.access.minIntervalMinutes),
    };
  const reason = value.reason === undefined || value.reason === null
    ? null : boundedText(value.reason);
  const state = userPriority === 'inactive'
    ? 'inactive' : userPriority === 'irrelevant' ? 'irrelevant' : 'active';
  working.employers[index] = {
    ...current,
    careersUrl,
    board,
    userPriority,
    decision: {
      state,
      reason: state === 'active' ? null : reason,
      decidedAt: updatedAt,
    },
    access,
    updatedAt,
  };
  return validateEmployerRegistry({
    ...working,
    updatedAt,
    generation: working.generation + (created ? 0 : 1),
  });
}

export function migrateLegacyPortals(registry, portals = [], {
  now = () => new Date().toISOString(),
} = {}) {
  if (!Array.isArray(portals)) throw new TypeError('legacy ATS portals must be an array');
  const recordedAt = now();
  const existingBoards = new Set([
    ...(registry?.employers || []),
    ...(registry?.archivedEmployers || []),
  ].filter(({ board }) => board).map(({ board }) => `${board.adapter}:${board.boardId}`));
  const discoveries = portals.filter(({ enabled, ats, token }) => (
    enabled !== false && !existingBoards.has(`${String(ats).toLowerCase()}:${token}`)
  )).map((portal) => ({
    canonicalName: portal.name,
    careersUrl: portal.careersUrl || null,
    board: portal.ats && portal.token ? {
      adapter: String(portal.ats).toLowerCase(),
      boardId: portal.token,
    } : null,
    industries: Array.isArray(portal.tags) ? portal.tags : [],
    origin: {
      kind: 'manual',
      recordedAt,
      reference: 'legacy-ats-portal',
    },
  }));
  if (registry && discoveries.length === 0) return registry;
  return registry
    ? reconcileEmployerDiscoveries(registry, discoveries, { now: () => recordedAt })
    : createEmployerRegistry(discoveries, { now: () => recordedAt });
}

export function employerRegistryRevision(registry) {
  const value = structuredClone(validateEmployerRegistry(registry));
  delete value._scoutMutation;
  return digest(value);
}

export function loadEmployerRegistry(root) {
  const file = workspacePaths(root).employers;
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schemaVersion === undefined
    && Array.isArray(value?.employers) && value.employers.length === 0
    && Object.keys(value).every((key) => ['_note', 'employers'].includes(key))) {
    return null;
  }
  delete value._scoutMutation;
  return validateEmployerRegistry(value);
}

export function writeEmployerRegistry(root, registry) {
  const value = structuredClone(validateEmployerRegistry(registry));
  delete value._scoutMutation;
  atomicWriteFile(workspacePaths(root).employers, `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
