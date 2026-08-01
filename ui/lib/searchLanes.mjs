import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { profileRuleId, PROVENANCE } from './searchProfile.mjs';
import { workspacePaths } from './workspace.mjs';

export const SEARCH_LANE_SCHEMA_VERSION = 1;
export const MAX_SEARCH_LANES = 32;
export const MAX_LANE_HISTORY = 20;

const KIND_CAPS = Object.freeze({
  title: 8,
  location: 4,
  industry: 4,
  skill: 6,
  'remote-policy': 2,
  employer: 4,
  exploration: 4,
});

const STRENGTH_PRIORITY = Object.freeze({
  mandatory: 20,
  'strong-preference': 10,
  'nice-to-have': 0,
  neutral: -10,
});

const KIND_PRIORITY = Object.freeze({
  title: 90,
  employer: 80,
  location: 70,
  'remote-policy': 65,
  industry: 62,
  skill: 58,
  exploration: 40,
});

const COUNTERS = Object.freeze([
  'returned', 'parsed', 'new', 'eligible', 'selected', 'promising',
]);

function stableJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('lane values must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('lane values must be plain JSON values');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

function text(value, maximum = 160) {
  return String(value ?? '').normalize('NFKC').replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ').trim().slice(0, maximum);
}

function canonicalQuery(value) {
  return text(value, 240).toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function compareText(left, right) {
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function profileField(path, rule) {
  const [section, field] = path.split('.');
  return Object.freeze({
    path,
    ruleId: profileRuleId(section, field, rule),
    value: text(rule?.value),
    strength: rule?.strength || 'neutral',
    provenance: rule?.provenance || 'unconfirmed-inference',
  });
}

function usableRules(profile, paths) {
  return paths.flatMap((path) => {
    const [section, field] = path.split('.');
    return (profile?.[section]?.[field] || [])
      .filter((rule) => text(rule?.value)
        && !['strong-negative', 'hard-exclusion'].includes(rule?.strength))
      .map((rule) => ({ path, rule }));
  });
}

function priorityBand(priority) {
  if (priority >= 80) return 'core';
  if (priority >= 50) return 'relevant';
  return 'exploration';
}

function candidate(kind, query, fields, now, priorityAdjustment = 0) {
  const normalized = canonicalQuery(query);
  if (!normalized) return null;
  const priority = Math.max(0, Math.min(120, Math.round(
    KIND_PRIORITY[kind]
    + Math.max(...fields.map(({ strength }) => STRENGTH_PRIORITY[strength] ?? -10))
    + priorityAdjustment,
  )));
  const sortedFields = [...fields].sort((left, right) => (
    compareText(left.path, right.path) || compareText(left.ruleId, right.ruleId)
  ));
  const id = `lane-${digest(`query:${normalized}`).slice(0, 16)}`;
  const definitionFingerprint = digest({
    kind, normalized, priority, profileFields: sortedFields,
  });
  return {
    schemaVersion: SEARCH_LANE_SCHEMA_VERSION,
    id,
    definitionFingerprint,
    state: 'active',
    kind,
    source: 'query-sources',
    query: text(query, 240),
    canonicalQuery: normalized,
    priority,
    priorityBand: priorityBand(priority),
    profileFields: sortedFields,
    overlaps: [],
    createdAt: now,
    updatedAt: now,
    aggregate: Object.fromEntries(COUNTERS.map((name) => [name, 0])),
    runCount: 0,
    failureCount: 0,
    consecutiveUnproductiveRuns: 0,
    history: [],
    retirement: null,
  };
}

function addCandidate(list, omissions, kind, query, fields, now, priorityAdjustment = 0) {
  const lane = candidate(kind, query, fields, now, priorityAdjustment);
  if (!lane) {
    omissions.push({
      kind, profileFields: fields, reason: 'empty-query',
    });
    return;
  }
  list.push(lane);
}

function mergeExact(candidates) {
  const byQuery = new Map();
  for (const lane of candidates) {
    const current = byQuery.get(lane.canonicalQuery);
    if (!current) {
      byQuery.set(lane.canonicalQuery, lane);
      continue;
    }
    const preferred = current.priority >= lane.priority ? current : lane;
    const fields = [...new Map(
      [...current.profileFields, ...lane.profileFields].map((field) => [field.ruleId, field]),
    ).values()].sort((left, right) => compareText(left.ruleId, right.ruleId));
    const merged = candidate(preferred.kind, preferred.query, fields, preferred.createdAt);
    byQuery.set(lane.canonicalQuery, {
      ...merged,
      createdAt: preferred.createdAt,
      updatedAt: preferred.updatedAt,
    });
  }
  return [...byQuery.values()];
}

function capCandidates(candidates, omissions) {
  const perKind = new Map();
  const accepted = [];
  for (const lane of [...candidates].sort((left, right) => (
    right.priority - left.priority || compareText(left.id, right.id)
  ))) {
    const count = perKind.get(lane.kind) || 0;
    if (count >= KIND_CAPS[lane.kind]) {
      omissions.push({
        kind: lane.kind,
        profileFields: lane.profileFields,
        reason: 'bounded-kind-capacity',
      });
      continue;
    }
    perKind.set(lane.kind, count + 1);
    accepted.push(lane);
  }
  if (accepted.length <= MAX_SEARCH_LANES) return accepted;
  for (const lane of accepted.slice(MAX_SEARCH_LANES)) {
    omissions.push({
      kind: lane.kind,
      profileFields: lane.profileFields,
      reason: 'bounded-global-capacity',
    });
  }
  return accepted.slice(0, MAX_SEARCH_LANES);
}

function tokenSet(query) {
  return new Set(canonicalQuery(query).split(' ').filter(Boolean));
}

function jaccard(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  return [...a].filter((token) => b.has(token)).length / union.size;
}

function withOverlaps(lanes) {
  const overlapMap = new Map(lanes.map(({ id }) => [id, []]));
  for (let leftIndex = 0; leftIndex < lanes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < lanes.length; rightIndex += 1) {
      const left = lanes[leftIndex];
      const right = lanes[rightIndex];
      const similarity = jaccard(left.query, right.query);
      if (similarity < 0.8) continue;
      overlapMap.get(left.id).push({
        laneId: right.id, reason: 'query-token-overlap', similarity: Number(similarity.toFixed(3)),
      });
      overlapMap.get(right.id).push({
        laneId: left.id, reason: 'query-token-overlap', similarity: Number(similarity.toFixed(3)),
      });
    }
  }
  return lanes.map((lane) => ({
    ...lane,
    overlaps: overlapMap.get(lane.id).sort((left, right) => compareText(left.laneId, right.laneId)),
  }));
}

function anchorRule(profile) {
  return usableRules(profile, ['target.primaryTitles', 'target.adjacentTitles', 'target.titles'])[0] || null;
}

function createCandidates(profile, now) {
  const candidates = [];
  const omissions = [];
  const anchor = anchorRule(profile);
  const anchorValue = text(anchor?.rule?.value);
  const anchorField = anchor ? profileField(anchor.path, anchor.rule) : null;

  for (const item of usableRules(profile, ['target.primaryTitles'])) {
    addCandidate(candidates, omissions, 'title', item.rule.value, [profileField(item.path, item.rule)], now);
  }
  const exploration = Number(profile?.selection?.exploration || 0);
  for (const item of usableRules(profile, ['target.adjacentTitles', 'target.titles'])) {
    const fields = [profileField(item.path, item.rule)];
    if (exploration > 0) {
      fields.push({
        path: 'selection.exploration',
        ruleId: `selection-exploration-${String(exploration).replace('.', '-')}`,
        value: String(exploration),
        strength: 'neutral',
        provenance: 'explicit',
      });
    }
    addCandidate(
      candidates,
      omissions,
      exploration > 0 ? 'exploration' : 'title',
      item.rule.value,
      fields,
      now,
    );
  }
  const paired = [
    ['location', ['target.locations']],
    ['industry', ['target.industries', 'target.sectors']],
    ['skill', ['target.skills']],
    ['remote-policy', ['target.workingPatterns']],
    ['employer', ['target.employers']],
  ];
  for (const [kind, paths] of paired) {
    for (const item of usableRules(profile, paths)) {
      const fields = [
        ...(anchorField ? [anchorField] : []),
        profileField(item.path, item.rule),
      ];
      const query = kind === 'employer'
        ? [item.rule.value, anchorValue].filter(Boolean).join(' ')
        : [anchorValue, item.rule.value].filter(Boolean).join(' ');
      addCandidate(candidates, omissions, kind, query, fields, now);
    }
  }
  if (exploration > 0 && !usableRules(profile, ['target.adjacentTitles', 'target.titles']).length) {
    omissions.push({
      kind: 'exploration',
      profileFields: [{
        path: 'selection.exploration',
        ruleId: `selection-exploration-${String(exploration).replace('.', '-')}`,
        value: String(exploration),
        strength: 'neutral',
        provenance: 'explicit',
      }],
      reason: 'no-adjacent-title',
    });
  }
  return { candidates, omissions };
}

export function generateSearchLanePlan(profile, { now = () => new Date().toISOString() } = {}) {
  if (!profile || profile.status !== 'published' || !/^profile-[a-f0-9]{12}$/.test(profile.id || '')) {
    throw new TypeError('search lanes require an immutable published profile');
  }
  const generatedAt = now();
  const generated = createCandidates(profile, generatedAt);
  const lanes = withOverlaps(capCandidates(mergeExact(generated.candidates), generated.omissions));
  return validateSearchLanePlan({
    schemaVersion: SEARCH_LANE_SCHEMA_VERSION,
    profileId: profile.id,
    generatedAt,
    updatedAt: generatedAt,
    generation: 1,
    lanes,
    archivedLanes: [],
    omissions: generated.omissions,
  });
}

function requireCounter(value, name) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new TypeError(`lane ${name} must be a non-negative integer`);
  return count;
}

function requireTimestamp(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError(`lane ${name} must be an ISO timestamp`);
  }
  return value;
}

function validateProfileField(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^[A-Za-z][A-Za-z0-9.-]{0,127}$/.test(value.path || '')
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.ruleId || '')
    || !text(value.value)
    || !Object.hasOwn(STRENGTH_PRIORITY, value.strength)
    || !PROVENANCE.includes(value.provenance)) {
    throw new TypeError('lane profile-field provenance is invalid');
  }
  return value;
}

function validateLaneHistory(lane) {
  const runIds = new Set();
  for (const event of lane.history) {
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.runId || '')
      || event.laneId !== lane.id) {
      throw new TypeError('lane history event is invalid');
    }
    if (runIds.has(event.runId)) throw new TypeError('lane history run ID is duplicated');
    runIds.add(event.runId);
    requireTimestamp(event.recordedAt, 'history time');
    for (const name of COUNTERS) requireCounter(event[name], `history ${name}`);
    if (event.failures !== undefined && (!Array.isArray(event.failures) || event.failures.length > 16)) {
      throw new TypeError('lane history failures are invalid');
    }
    for (const failure of event.failures || []) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(failure?.source || '')
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(failure?.code || '')) {
        throw new TypeError('lane history failure evidence is invalid');
      }
    }
  }
}

function validateLane(lane, states = ['active', 'retired']) {
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) throw new TypeError('lane must be an object');
  if (!/^lane-[a-f0-9]{16}$/.test(lane.id || '')) throw new TypeError('lane ID is invalid');
  if (!states.includes(lane.state)) throw new TypeError(`lane state must be: ${states.join(', ')}`);
  if (!Object.hasOwn(KIND_CAPS, lane.kind)) throw new TypeError('lane kind is invalid');
  if (!text(lane.query) || lane.canonicalQuery !== canonicalQuery(lane.query)) throw new TypeError('lane query is invalid');
  if (lane.id !== `lane-${digest(`query:${lane.canonicalQuery}`).slice(0, 16)}`) {
    throw new TypeError('lane identity does not match its query');
  }
  if (lane.source !== 'query-sources') throw new TypeError('lane source contract is invalid');
  if (!Number.isSafeInteger(lane.priority) || lane.priority < 0 || lane.priority > 120
    || lane.priorityBand !== priorityBand(lane.priority)) {
    throw new TypeError('lane priority is invalid');
  }
  if (!Array.isArray(lane.profileFields) || !lane.profileFields.length || lane.profileFields.length > 32) {
    throw new TypeError('lane profile fields are required');
  }
  lane.profileFields.forEach(validateProfileField);
  const expectedDefinition = digest({
    kind: lane.kind,
    normalized: lane.canonicalQuery,
    priority: lane.priority,
    profileFields: lane.profileFields,
  });
  if (lane.definitionFingerprint !== expectedDefinition) {
    throw new TypeError('lane definition fingerprint is invalid');
  }
  if (!Array.isArray(lane.overlaps) || lane.overlaps.length > MAX_SEARCH_LANES - 1) {
    throw new TypeError('lane overlaps are invalid');
  }
  for (const overlap of lane.overlaps) {
    if (!/^lane-[a-f0-9]{16}$/.test(overlap?.laneId || '')
      || overlap.laneId === lane.id
      || overlap.reason !== 'query-token-overlap'
      || !Number.isFinite(overlap.similarity)
      || overlap.similarity < 0.8 || overlap.similarity > 1) {
      throw new TypeError('lane overlap evidence is invalid');
    }
  }
  requireTimestamp(lane.createdAt, 'creation time');
  requireTimestamp(lane.updatedAt, 'update time');
  if (!Array.isArray(lane.history) || lane.history.length > MAX_LANE_HISTORY) throw new TypeError('lane history is invalid');
  for (const name of COUNTERS) requireCounter(lane.aggregate?.[name], `aggregate ${name}`);
  for (const name of ['runCount', 'failureCount', 'consecutiveUnproductiveRuns']) {
    requireCounter(lane[name], name);
  }
  if (lane.failureCount > lane.runCount || lane.consecutiveUnproductiveRuns > lane.runCount) {
    throw new TypeError('lane run counters are inconsistent');
  }
  validateLaneHistory(lane);
  if (lane.state === 'active' && lane.retirement !== null) {
    throw new TypeError('active lane retirement metadata is invalid');
  }
  if (lane.state === 'retired' && (
    lane.retirement?.reason !== 'consistently-unproductive'
    || lane.retirement?.reversible !== true
    || !Number.isSafeInteger(lane.retirement?.minimumRuns)
    || lane.retirement.minimumRuns < 3
    || lane.consecutiveUnproductiveRuns < lane.retirement.minimumRuns
  )) {
    throw new TypeError('retired lane metadata is invalid');
  }
  if (lane.state === 'archived' && (
    lane.retirement?.reason !== 'profile-rule-removed'
    || lane.retirement?.reversible !== false
  )) {
    throw new TypeError('archived lane metadata is invalid');
  }
  if (lane.retirement) requireTimestamp(lane.retirement.retiredAt, 'retirement time');
  return lane;
}

export function validateSearchLanePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new TypeError('search lane plan must be an object');
  if (plan.schemaVersion !== SEARCH_LANE_SCHEMA_VERSION) throw new TypeError('search lane plan schema is unsupported');
  if (!/^profile-[a-f0-9]{12}$/.test(plan.profileId || '')) throw new TypeError('search lane profile ID is invalid');
  requireTimestamp(plan.generatedAt, 'generation time');
  requireTimestamp(plan.updatedAt, 'plan update time');
  if (!Number.isSafeInteger(plan.generation) || plan.generation < 1) {
    throw new TypeError('search lane generation is invalid');
  }
  if (!Array.isArray(plan.lanes) || plan.lanes.length > MAX_SEARCH_LANES) throw new TypeError('search lane plan exceeds capacity');
  if (!Array.isArray(plan.archivedLanes) || plan.archivedLanes.length > 256
    || !Array.isArray(plan.omissions) || plan.omissions.length > 256) {
    throw new TypeError('search lane archives and omissions are required');
  }
  const ids = new Set();
  for (const lane of plan.lanes) {
    validateLane(lane);
    if (ids.has(lane.id)) throw new TypeError(`search lane ID is duplicated: ${lane.id}`);
    ids.add(lane.id);
  }
  for (const lane of plan.archivedLanes) validateLane(lane, ['archived']);
  return plan;
}

export function searchLanePlanRevision(plan) {
  const value = structuredClone(validateSearchLanePlan(plan));
  delete value._scoutMutation;
  return digest(value);
}

function runtimeFields(previous, desired) {
  return {
    ...desired,
    state: previous.state,
    createdAt: previous.createdAt,
    aggregate: structuredClone(previous.aggregate),
    runCount: previous.runCount,
    failureCount: previous.failureCount,
    consecutiveUnproductiveRuns: previous.consecutiveUnproductiveRuns,
    history: structuredClone(previous.history),
    retirement: structuredClone(previous.retirement),
  };
}

export function reconcileSearchLanePlan(existing, profile, { now = () => new Date().toISOString() } = {}) {
  if (!existing) return generateSearchLanePlan(profile, { now });
  validateSearchLanePlan(existing);
  const generated = generateSearchLanePlan(profile, { now });
  const prior = new Map(existing.lanes.map((lane) => [lane.id, lane]));
  const lanes = generated.lanes.map((lane) => {
    const previous = prior.get(lane.id);
    return previous?.definitionFingerprint === lane.definitionFingerprint
      ? runtimeFields(previous, lane)
      : lane;
  });
  const currentIds = new Set(generated.lanes.map(({ id }) => id));
  const archived = [
    ...existing.archivedLanes,
    ...existing.lanes.filter(({ id }) => !currentIds.has(id)).map((lane) => ({
      ...structuredClone(lane),
      state: 'archived',
      updatedAt: generated.generatedAt,
      retirement: {
        reason: 'profile-rule-removed',
        retiredAt: generated.generatedAt,
        reversible: false,
      },
    })),
  ];
  const uniqueArchived = [...new Map(archived.map((lane) => [
    `${lane.id}:${lane.definitionFingerprint}`, lane,
  ])).values()];
  return validateSearchLanePlan({
    ...generated,
    generation: Number(existing.generation || 0) + 1,
    lanes,
    archivedLanes: uniqueArchived,
  });
}

function laneFairness(left, right) {
  const leftLast = left.history.at(-1)?.recordedAt || '';
  const rightLast = right.history.at(-1)?.recordedAt || '';
  return compareText(leftLast, rightLast)
    || Number(left.runCount || 0) - Number(right.runCount || 0)
    || right.priority - left.priority
    || compareText(left.id, right.id);
}

function bandFairness([leftName, left], [rightName, right]) {
  const leftRuns = Math.min(...left.map((lane) => Number(lane.runCount || 0)));
  const rightRuns = Math.min(...right.map((lane) => Number(lane.runCount || 0)));
  const order = { core: 0, relevant: 1, exploration: 2 };
  return leftRuns - rightRuns || order[leftName] - order[rightName];
}

export function selectSearchLanes(plan, { limit = MAX_SEARCH_LANES } = {}) {
  validateSearchLanePlan(plan);
  const capacity = Math.max(0, Math.min(MAX_SEARCH_LANES, Math.floor(Number(limit))));
  if (!capacity) return [];
  const active = plan.lanes.filter(({ state }) => state === 'active');
  const groups = new Map();
  for (const lane of active) {
    const values = groups.get(lane.priorityBand) || [];
    values.push(lane);
    groups.set(lane.priorityBand, values);
  }
  for (const values of groups.values()) values.sort(laneFairness);
  const selected = [];
  const bandEntries = [...groups.entries()].sort(bandFairness);
  for (const [, values] of bandEntries.slice(0, capacity)) selected.push(values.shift());
  const remaining = [...groups.values()].flat().sort(laneFairness);
  for (const lane of remaining) {
    if (selected.length >= capacity) break;
    selected.push(lane);
  }
  return selected.filter(Boolean).map((lane) => structuredClone(lane));
}

function eventResult(result) {
  const value = {
    laneId: result?.laneId,
    ...Object.fromEntries(COUNTERS.map((name) => [name, requireCounter(result?.[name] || 0, name)])),
  };
  if (result?.failures !== undefined && !Array.isArray(result.failures)) {
    throw new TypeError('lane failures must be an array');
  }
  const failures = (result?.failures || []).map((failure) => {
    const source = text(failure?.source, 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const code = text(failure?.code, 100).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!source || !code) throw new TypeError('lane failure evidence is invalid');
    return { source, code };
  });
  if (failures.length > 16) throw new TypeError('lane failure evidence exceeds capacity');
  const uniqueFailures = [...new Map(failures.map((failure) => [
    `${failure.source}:${failure.code}`, failure,
  ])).values()].sort((left, right) => (
    compareText(left.source, right.source) || compareText(left.code, right.code)
  ));
  if (uniqueFailures.length) value.failures = uniqueFailures;
  if (result?.failureCode) {
    const code = text(result.failureCode, 100).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!code) throw new TypeError('lane failure code is invalid');
    value.failures = [...(value.failures || []), { source: 'scan', code }];
  }
  return value;
}

export function recordSearchLaneRun(plan, { runId, recordedAt, results } = {}) {
  validateSearchLanePlan(plan);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId || '')) throw new TypeError('lane run ID is invalid');
  if (Number.isNaN(Date.parse(recordedAt))) throw new TypeError('lane run time is invalid');
  if (!Array.isArray(results)) throw new TypeError('lane run results are required');
  const byId = new Map();
  for (const result of results) {
    const value = eventResult(result);
    if (!/^lane-[a-f0-9]{16}$/.test(value.laneId || '')) throw new TypeError('lane result ID is invalid');
    if (byId.has(value.laneId)) throw new TypeError(`lane result ID is duplicated: ${value.laneId}`);
    byId.set(value.laneId, value);
  }
  let changed = false;
  const lanes = plan.lanes.map((lane) => {
    const result = byId.get(lane.id);
    if (!result || lane.history.some((event) => event.runId === runId)) return lane;
    changed = true;
    const productive = ['new', 'eligible', 'selected', 'promising']
      .some((name) => result[name] > 0);
    const history = [...lane.history, { runId, recordedAt, ...result }]
      .slice(-MAX_LANE_HISTORY);
    return {
      ...lane,
      updatedAt: recordedAt,
      aggregate: Object.fromEntries(COUNTERS.map((name) => [
        name, lane.aggregate[name] + result[name],
      ])),
      runCount: lane.runCount + 1,
      failureCount: lane.failureCount + (result.failures?.length ? 1 : 0),
      consecutiveUnproductiveRuns: result.failures?.length
        ? lane.consecutiveUnproductiveRuns
        : productive ? 0 : lane.consecutiveUnproductiveRuns + 1,
      history,
    };
  });
  if (!changed) return plan;
  return validateSearchLanePlan({ ...plan, updatedAt: recordedAt, lanes });
}

function laneIdsOf(value) {
  return [...new Set([
    ...(Array.isArray(value?.laneIds) ? value.laneIds : []),
    value?.laneId,
  ].map((item) => text(item, 80)).filter((item) => /^lane-[a-f0-9]{16}$/.test(item)))];
}

function uniqueLaneCount(values, laneId, identity) {
  return new Set((values || [])
    .filter((value) => laneIdsOf(value).includes(laneId))
    .map(identity)
    .filter(Boolean)).size;
}

function noveltyIsUnseen(vacancy) {
  return (vacancy?.dimensions || []).some((dimension) => (
    dimension?.name === 'novelty'
    && (dimension.evidence || []).some(({ comparison }) => comparison === 'unseen')
  ));
}

export function deriveSearchLaneResults({
  lanes = [], sources = {}, discoveryCounts = null, discovered = null, ranked = [],
  candidates = [], reviewed = [],
  scanFailureCode = null,
} = {}) {
  if (!Array.isArray(lanes) || lanes.length > MAX_SEARCH_LANES) {
    throw new TypeError('selected search lanes are invalid');
  }
  const reviewedById = new Map((reviewed || []).map((item) => [String(item?.vacancyId || ''), item]));
  return lanes.map((lane) => {
    if (!/^lane-[a-f0-9]{16}$/.test(lane?.id || '') || !canonicalQuery(lane?.query)) {
      throw new TypeError('selected search lane is invalid');
    }
    let returned = 0;
    const parsed = new Set();
    const failures = [];
    for (const [sourceName, source] of Object.entries(sources || {})) {
      for (const [query, count] of Object.entries(source?.queryCounts || source?.sources || {})) {
        if (canonicalQuery(query) === canonicalQuery(lane.query)) {
          returned += requireCounter(count, 'returned');
        }
      }
      for (const [query, code] of Object.entries(source?.queryFailures || {})) {
        if (canonicalQuery(query) !== canonicalQuery(lane.query)) continue;
        failures.push({
          source: text(sourceName, 80).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
          code: text(code, 100).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        });
      }
      const records = Array.isArray(source?.observations)
        ? source.observations : Array.isArray(source?.jobs) ? source.jobs : [];
      records.forEach((record, index) => {
        if (!laneIdsOf(record).includes(lane.id)) return;
        parsed.add(`${sourceName}:${record?.observationId || record?.sourceRecordId || record?.providerId || record?.url || index}`);
      });
    }
    const selectedIds = new Set((candidates || [])
      .filter((candidate) => laneIdsOf(candidate).includes(lane.id))
      .map((candidate) => String(candidate?.vacancyId || candidate?.candidateId || ''))
      .filter(Boolean));
    const promising = [...selectedIds].filter((id) => reviewedById.get(id)?.outcome === 'kept').length;
    if (scanFailureCode) {
      failures.push({ source: 'scan', code: scanFailureCode });
    }
    const precomputedNew = Array.isArray(discoveryCounts)
      ? discoveryCounts.find((item) => item?.laneId === lane.id)?.new
      : undefined;
    const result = eventResult({
      laneId: lane.id,
      returned,
      parsed: parsed.size,
      new: precomputedNew === undefined
        ? uniqueLaneCount((discovered ?? ranked).filter((item) => (
          item?.novelty === 'unseen' || noveltyIsUnseen(item)
        )), lane.id, (item) => (
          String(item?.vacancyId || item?.canonicalUrl || '')
        ))
        : requireCounter(precomputedNew, 'new'),
      eligible: uniqueLaneCount(ranked, lane.id, (item) => (
        String(item?.vacancyId || item?.canonicalUrl || '')
      )),
      selected: selectedIds.size,
      promising,
      failures,
    });
    const equations = [
      ['parsed', 'returned'],
      ['new', 'parsed'],
      ['eligible', 'parsed'],
      ['selected', 'eligible'],
      ['promising', 'selected'],
    ];
    const invalid = equations.find(([left, right]) => result[left] > result[right]);
    if (invalid) {
      throw new TypeError(`lane metric equation is invalid: ${invalid[0]} cannot exceed ${invalid[1]}`);
    }
    return result;
  });
}

export function retireUnproductiveSearchLanes(plan, {
  minimumRuns = 3,
  now = () => new Date().toISOString(),
} = {}) {
  validateSearchLanePlan(plan);
  if (!Number.isSafeInteger(minimumRuns) || minimumRuns < 3) throw new TypeError('lane retirement minimum must be at least three runs');
  const retiredAt = now();
  let changed = false;
  const lanes = plan.lanes.map((lane) => {
    if (lane.state === 'active' && lane.consecutiveUnproductiveRuns >= minimumRuns) {
      changed = true;
      return {
        ...lane,
        state: 'retired',
        updatedAt: retiredAt,
        retirement: {
          reason: 'consistently-unproductive',
          retiredAt,
          minimumRuns,
          reversible: true,
        },
      };
    }
    return lane;
  });
  if (!changed) return plan;
  return validateSearchLanePlan({ ...plan, updatedAt: retiredAt, lanes });
}

export function restoreSearchLane(plan, laneId, { now = () => new Date().toISOString() } = {}) {
  validateSearchLanePlan(plan);
  const restoredAt = now();
  let restored = false;
  const lanes = plan.lanes.map((lane) => {
    if (lane.id !== laneId) return lane;
    if (lane.state !== 'retired' || lane.retirement?.reversible !== true) {
      throw new TypeError('only a reversibly retired search lane can be restored');
    }
    restored = true;
    return {
      ...lane,
      state: 'active',
      updatedAt: restoredAt,
      retirement: null,
    };
  });
  if (!restored) throw new TypeError('search lane is not available for restoration');
  return validateSearchLanePlan({ ...plan, updatedAt: restoredAt, lanes });
}

export function loadSearchLanePlan(root) {
  const file = workspacePaths(root).searchLanes;
  if (!fs.existsSync(file)) return null;
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete plan._scoutMutation;
  return validateSearchLanePlan(plan);
}

export function writeSearchLanePlan(root, plan) {
  validateSearchLanePlan(plan);
  const file = workspacePaths(root).searchLanes;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}
