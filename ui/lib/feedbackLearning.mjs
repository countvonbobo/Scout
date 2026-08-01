import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { atomicWriteFile } from './atomicWrite.mjs';
import { workspacePaths } from './workspace.mjs';

export const FEEDBACK_DECISIONS = Object.freeze([
  'applied', 'interview', 'promising', 'saved', 'rejected',
  'not-interested', 'duplicate', 'already-seen',
]);
export const FEEDBACK_REASONS = Object.freeze([
  'location', 'salary', 'seniority', 'responsibilities', 'employer',
  'role-family', 'other', 'positive', 'duplicate', 'already-seen',
]);
export const LEARNING_SCOPES = Object.freeze(['role-family', 'employer', 'profile-wide']);
export const LEARNING_FIELDS = Object.freeze([
  'title', 'employer', 'location', 'seniority', 'responsibilities',
]);
const MAX_EVENTS = 2_000;
const MAX_PROPOSALS = 512;
const MAX_VERSIONS = 256;
const MAX_CHANGES = 64;

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function text(value, maximum = 500) {
  const result = String(value ?? '').trim();
  if (result.length > maximum) throw new TypeError('feedback learning text is too long');
  return result;
}

function requiredText(value, label, maximum = 500) {
  const result = text(value, maximum);
  if (!result) throw new TypeError(`${label} is required`);
  return result;
}

function timestamp(value, label) {
  const result = requiredText(value, label, 40);
  if (Number.isNaN(Date.parse(result))) throw new TypeError(`${label} is invalid`);
  return result;
}

function stableId(prefix, value) {
  return `${prefix}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
}

function normalise(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value')
    ? value.value
    : value;
}

function feedbackEvent(value) {
  if (!plain(value)) throw new TypeError('feedback event is invalid');
  if (!FEEDBACK_DECISIONS.includes(value.decision)) throw new TypeError('feedback decision is invalid');
  if (!FEEDBACK_REASONS.includes(value.reason)) throw new TypeError('feedback reason is invalid');
  if (value.scope !== 'job') throw new TypeError('feedback event scope must be job');
  return {
    id: requiredText(value.id, 'feedback event ID', 80),
    opportunityId: requiredText(value.opportunityId, 'feedback opportunity ID', 160),
    vacancyId: requiredText(value.vacancyId, 'feedback vacancy ID', 200),
    decision: value.decision,
    reason: value.reason,
    explanation: requiredText(value.explanation, 'feedback explanation', 1_000),
    scope: 'job',
    recordedAt: timestamp(value.recordedAt, 'feedback time'),
    profileId: requiredText(value.profileId, 'feedback profile ID', 80),
    learningVersionId: requiredText(value.learningVersionId, 'feedback learning version ID', 80),
  };
}

function learningChange(value) {
  if (!plain(value) || !['rank-adjustment', 'reconsider-rule'].includes(value.kind)) {
    throw new TypeError('learning change is invalid');
  }
  if (!LEARNING_SCOPES.includes(value.scope)) throw new TypeError('learning scope is invalid');
  if (value.kind === 'rank-adjustment') {
    if (!LEARNING_FIELDS.includes(value.field)) throw new TypeError('learning field is invalid');
    const weight = Number(value.weight);
    if (!Number.isInteger(weight) || weight < -10 || weight > 10 || weight === 0) {
      throw new TypeError('learning weight must be a non-zero integer between -10 and 10');
    }
    return {
      kind: value.kind,
      field: value.field,
      value: requiredText(value.value, 'learning match value', 160),
      weight,
      scope: value.scope,
      scopeValue: value.scope === 'profile-wide'
        ? null
        : requiredText(value.scopeValue, 'learning scope value', 160),
      ...(value.proposalId ? {
        proposalId: requiredText(value.proposalId, 'learning change proposal ID', 80),
      } : {}),
    };
  }
  return {
    kind: value.kind,
    profileRuleId: requiredText(value.profileRuleId, 'learning profile rule ID', 160),
    scope: value.scope,
    value: value.scope === 'profile-wide'
      ? text(value.value, 160)
      : requiredText(value.value, 'learning scope value', 160),
    ...(value.proposalId ? {
      proposalId: requiredText(value.proposalId, 'learning change proposal ID', 80),
    } : {}),
  };
}

function proposal(value) {
  if (!plain(value) || !['pending', 'published', 'rejected'].includes(value.status)) {
    throw new TypeError('learning proposal is invalid');
  }
  if (!Array.isArray(value.sourceEventIds) || !value.sourceEventIds.length || value.sourceEventIds.length > 32) {
    throw new TypeError('learning proposal source events are invalid');
  }
  if (new Set(value.sourceEventIds).size !== value.sourceEventIds.length) {
    throw new TypeError('learning proposal source events are duplicated');
  }
  return {
    id: requiredText(value.id, 'learning proposal ID', 80),
    status: value.status,
    createdAt: timestamp(value.createdAt, 'learning proposal time'),
    sourceEventIds: value.sourceEventIds.map((id) => requiredText(id, 'learning source event ID', 80)),
    explanation: requiredText(value.explanation, 'learning proposal explanation', 1_000),
    change: learningChange(value.change),
    publishedVersionId: value.publishedVersionId === null
      ? null : requiredText(value.publishedVersionId, 'published learning version ID', 80),
  };
}

function version(value) {
  if (!plain(value) || !Array.isArray(value.changes) || value.changes.length > MAX_CHANGES
    || !Array.isArray(value.sourceProposalIds) || value.sourceProposalIds.length > 32) {
    throw new TypeError('learning version is invalid');
  }
  if (new Set(value.sourceProposalIds).size !== value.sourceProposalIds.length) {
    throw new TypeError('learning version proposals are duplicated');
  }
  return {
    id: requiredText(value.id, 'learning version ID', 80),
    parentId: value.parentId === null ? null : requiredText(value.parentId, 'learning parent ID', 80),
    version: Number(value.version),
    publishedAt: timestamp(value.publishedAt, 'learning version time'),
    explanation: requiredText(value.explanation, 'learning version explanation', 1_000),
    sourceProposalIds: value.sourceProposalIds
      .map((id) => requiredText(id, 'learning version proposal ID', 80)),
    changes: value.changes.map(learningChange),
    undoOf: value.undoOf === null || value.undoOf === undefined
      ? null : requiredText(value.undoOf, 'undone learning version ID', 80),
  };
}

export function validateLearningLedger(value) {
  if (!plain(value) || value.schemaVersion !== 1) throw new TypeError('feedback learning schema is unsupported');
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) throw new TypeError('feedback learning generation is invalid');
  timestamp(value.updatedAt, 'feedback learning update time');
  if (!Array.isArray(value.feedbackEvents) || value.feedbackEvents.length > MAX_EVENTS
    || !Array.isArray(value.proposals) || value.proposals.length > MAX_PROPOSALS
    || !Array.isArray(value.versions) || !value.versions.length || value.versions.length > MAX_VERSIONS) {
    throw new TypeError('feedback learning collections are invalid');
  }
  const result = {
    schemaVersion: 1,
    generation: value.generation,
    updatedAt: value.updatedAt,
    activeVersionId: requiredText(value.activeVersionId, 'active learning version ID', 80),
    feedbackEvents: value.feedbackEvents.map(feedbackEvent),
    proposals: value.proposals.map(proposal),
    versions: value.versions.map(version),
  };
  for (const [label, values] of [
    ['feedback event', result.feedbackEvents],
    ['learning proposal', result.proposals],
    ['learning version', result.versions],
  ]) {
    const ids = new Set();
    for (const item of values) {
      if (ids.has(item.id)) throw new TypeError(`${label} ID is duplicated`);
      ids.add(item.id);
    }
  }
  const versionIds = new Set(result.versions.map(({ id }) => id));
  if (!versionIds.has(result.activeVersionId)) throw new TypeError('active learning version is unavailable');
  const rootVersions = result.versions.filter(({ parentId }) => parentId === null);
  for (const [index, item] of result.versions.entries()) {
    if (item.version !== index) throw new TypeError('learning version ancestry is invalid');
    const expectedParent = index === 0 ? null : result.versions[index - 1].id;
    if (item.parentId !== expectedParent) throw new TypeError('learning version ancestry is invalid');
  }
  if (rootVersions.length !== 1 || rootVersions[0].id !== 'learning-baseline'
    || rootVersions[0].version !== 0 || rootVersions[0].changes.length !== 0) {
    throw new TypeError('learning baseline version is invalid');
  }
  const active = result.versions.at(-1);
  if (active.id !== result.activeVersionId) {
    throw new TypeError('active learning version is stale');
  }
  const eventIds = new Set(result.feedbackEvents.map(({ id }) => id));
  const proposalIds = new Set(result.proposals.map(({ id }) => id));
  for (const item of result.proposals) {
    if (item.sourceEventIds.some((id) => !eventIds.has(id))) throw new TypeError('learning proposal source event is unavailable');
    if (item.publishedVersionId !== null && !versionIds.has(item.publishedVersionId)) {
      throw new TypeError('published learning version is unavailable');
    }
    if ((item.status === 'published') !== (item.publishedVersionId !== null)) {
      throw new TypeError('learning proposal publication state is inconsistent');
    }
  }
  for (const item of result.versions) {
    if (item.sourceProposalIds.some((id) => !proposalIds.has(id))) {
      throw new TypeError('learning version proposal is unavailable');
    }
    for (const id of item.sourceProposalIds) {
      const source = result.proposals.find((proposalItem) => proposalItem.id === id);
      if (source.status !== 'published' || source.publishedVersionId !== item.id
        || !item.changes.some(({ proposalId }) => proposalId === id)) {
        throw new TypeError('learning version proposal provenance is inconsistent');
      }
    }
    if (item.changes.some(({ proposalId }) => proposalId && !proposalIds.has(proposalId))) {
      throw new TypeError('learning change proposal is unavailable');
    }
  }
  for (const item of result.proposals.filter(({ status }) => status === 'published')) {
    const published = result.versions.filter(({ sourceProposalIds }) => sourceProposalIds.includes(item.id));
    if (published.length !== 1 || published[0].id !== item.publishedVersionId) {
      throw new TypeError('learning proposal publication provenance is inconsistent');
    }
  }
  return result;
}

export function createLearningLedger({
  now = () => new Date().toISOString(),
} = {}) {
  const updatedAt = now();
  const baseline = {
    id: 'learning-baseline',
    parentId: null,
    version: 0,
    publishedAt: updatedAt,
    explanation: 'No learned preferences are published.',
    sourceProposalIds: [],
    changes: [],
    undoOf: null,
  };
  return validateLearningLedger({
    schemaVersion: 1,
    generation: 0,
    updatedAt,
    activeVersionId: baseline.id,
    feedbackEvents: [],
    proposals: [],
    versions: [baseline],
  });
}

export function learningLedgerRevision(ledger) {
  return createHash('sha256').update(JSON.stringify(validateLearningLedger(ledger))).digest('hex');
}

export function recordFeedback(ledger, value, {
  now = () => new Date().toISOString(),
} = {}) {
  const current = validateLearningLedger(ledger);
  if (!plain(value)) throw new TypeError('feedback event is invalid');
  if (current.feedbackEvents.length >= MAX_EVENTS) {
    throw new TypeError('feedback event history is full; archive it before recording more feedback');
  }
  const recordedAt = now();
  const event = feedbackEvent({
    ...value,
    scope: 'job',
    recordedAt,
    id: stableId('feedback', {
      generation: current.generation + 1,
      opportunityId: value.opportunityId,
      vacancyId: value.vacancyId,
      decision: value.decision,
      recordedAt,
    }),
  });
  return validateLearningLedger({
    ...current,
    generation: current.generation + 1,
    updatedAt: recordedAt,
    feedbackEvents: [...current.feedbackEvents, event],
  });
}

export function proposeLearningChange(ledger, value, {
  now = () => new Date().toISOString(),
} = {}) {
  const current = validateLearningLedger(ledger);
  if (!plain(value)) throw new TypeError('learning proposal is invalid');
  if (current.proposals.length >= MAX_PROPOSALS) {
    throw new TypeError('learning proposal history is full; archive it before creating more proposals');
  }
  const createdAt = now();
  const sourceEventIds = [...new Set(value.sourceEventIds || [])];
  const item = proposal({
    id: stableId('proposal', {
      generation: current.generation + 1,
      sourceEventIds,
      change: value.change,
      createdAt,
    }),
    status: 'pending',
    createdAt,
    sourceEventIds,
    explanation: value.explanation,
    change: value.change,
    publishedVersionId: null,
  });
  return validateLearningLedger({
    ...current,
    generation: current.generation + 1,
    updatedAt: createdAt,
    proposals: [...current.proposals, item],
  });
}

export function publishLearningProposal(ledger, value, {
  now = () => new Date().toISOString(),
} = {}) {
  const current = validateLearningLedger(ledger);
  if (value?.confirmed !== true) throw new TypeError('explicit confirmation is required');
  if (current.versions.length >= MAX_VERSIONS) {
    throw new TypeError('learning version history is full; archive it before publishing another version');
  }
  const index = current.proposals.findIndex(({ id }) => id === value.proposalId);
  if (index < 0 || current.proposals[index].status !== 'pending') {
    throw new TypeError('pending learning proposal is unavailable');
  }
  const publishedAt = now();
  const active = current.versions.find(({ id }) => id === current.activeVersionId);
  const selected = current.proposals[index];
  const next = version({
    id: stableId('learning', {
      parentId: active.id,
      proposalId: selected.id,
      publishedAt,
    }),
    parentId: active.id,
    version: Math.max(...current.versions.map(({ version: number }) => number)) + 1,
    publishedAt,
    explanation: selected.explanation,
    sourceProposalIds: [selected.id],
    changes: [...active.changes, { ...selected.change, proposalId: selected.id }],
    undoOf: null,
  });
  const proposals = structuredClone(current.proposals);
  proposals[index] = { ...proposals[index], status: 'published', publishedVersionId: next.id };
  return validateLearningLedger({
    ...current,
    generation: current.generation + 1,
    updatedAt: publishedAt,
    activeVersionId: next.id,
    proposals,
    versions: [...current.versions, next],
  });
}

export function undoLearningVersion(ledger, value, {
  now = () => new Date().toISOString(),
} = {}) {
  const current = validateLearningLedger(ledger);
  if (value?.confirmed !== true) throw new TypeError('explicit confirmation is required');
  if (current.versions.length >= MAX_VERSIONS) {
    throw new TypeError('learning version history is full; archive it before undoing another version');
  }
  if (value.versionId !== current.activeVersionId) throw new TypeError('only the active learning version can be undone');
  const active = current.versions.find(({ id }) => id === current.activeVersionId);
  if (!active?.parentId) throw new TypeError('baseline learning behavior cannot be undone');
  const parent = current.versions.find(({ id }) => id === active.parentId);
  const publishedAt = now();
  const next = version({
    id: stableId('learning', { undoOf: active.id, parentId: active.id, publishedAt }),
    parentId: active.id,
    version: Math.max(...current.versions.map(({ version: number }) => number)) + 1,
    publishedAt,
    explanation: requiredText(value.explanation, 'learning undo explanation', 1_000),
    sourceProposalIds: [],
    changes: parent.changes,
    undoOf: active.id,
  });
  return validateLearningLedger({
    ...current,
    generation: current.generation + 1,
    updatedAt: publishedAt,
    activeVersionId: next.id,
    versions: [...current.versions, next],
  });
}

export function activeLearningPolicy(ledger) {
  const current = validateLearningLedger(ledger);
  const active = current.versions.find(({ id }) => id === current.activeVersionId);
  return {
    id: active.id,
    version: active.version,
    publishedAt: active.publishedAt,
    changes: structuredClone(active.changes),
    reconsiderRuleIds: [...new Set(active.changes
      .filter(({ kind }) => kind === 'reconsider-rule')
      .map(({ profileRuleId }) => profileRuleId))].sort(),
  };
}

function vacancyField(vacancy, field) {
  const aliases = {
    title: ['title', 'role'],
    employer: ['employer', 'company'],
    responsibilities: ['responsibilities', 'description'],
  };
  return (aliases[field] || [field])
    .map((key) => valueOf(vacancy?.[key]))
    .find((value) => value !== undefined && value !== null);
}

function vacancyRoleFamilies(vacancy) {
  const values = [
    ...(Array.isArray(vacancy?.roleFamilies) ? vacancy.roleFamilies : []),
    vacancy?.roleFamilyId,
    vacancy?.roleFamily,
    vacancy?.targetRoleFamily,
  ].map(valueOf).map(normalise).filter(Boolean);
  return [...new Set(values)];
}

function matchesChange(vacancy, change) {
  if (change.scope !== 'profile-wide') {
    const expectedScope = normalise(change.scopeValue);
    if (change.scope === 'role-family') {
      if (!vacancyRoleFamilies(vacancy).includes(expectedScope)) return false;
    } else if (normalise(vacancyField(vacancy, 'employer')) !== expectedScope) return false;
  }
  const actual = vacancyField(vacancy, change.field);
  const values = Array.isArray(actual) ? actual : [actual];
  const expected = normalise(change.value);
  return Boolean(expected) && values.some((value) => {
    const haystack = normalise(value);
    if (change.field === 'seniority') return haystack === expected;
    const tokens = new Set(haystack.split(' '));
    return expected.split(' ').every((token) => tokens.has(token));
  });
}

function rankedTieBreak(left, right) {
  if (right.preRankScore !== left.preRankScore) return right.preRankScore - left.preRankScore;
  if (right.preRankConfidence !== left.preRankConfidence) {
    return Number(right.preRankConfidence || 0) - Number(left.preRankConfidence || 0);
  }
  const leftPosted = Date.parse(left.stableTieBreak?.postedAt || '');
  const rightPosted = Date.parse(right.stableTieBreak?.postedAt || '');
  const dateDifference = (Number.isNaN(rightPosted) ? Number.NEGATIVE_INFINITY : rightPosted)
    - (Number.isNaN(leftPosted) ? Number.NEGATIVE_INFINITY : leftPosted);
  if (dateDifference) return dateDifference;
  for (const key of ['employer', 'title', 'vacancyId']) {
    const leftValue = String(left.stableTieBreak?.[key] || left[key] || '');
    const rightValue = String(right.stableTieBreak?.[key] || right[key] || '');
    const comparison = leftValue.localeCompare(rightValue);
    if (comparison) return comparison;
  }
  return 0;
}

export function applyLearningToRankedVacancies(vacancies, policy) {
  const active = policy || { id: 'learning-baseline', changes: [] };
  const changes = (active.changes || []).filter(({ kind }) => kind === 'rank-adjustment');
  return (vacancies || []).map((vacancy) => {
    const priorAdjustment = Number(vacancy.learningAdjustment || 0);
    const basePreRankScore = Number(vacancy.basePreRankScore
      ?? Number(vacancy.preRankScore || 0) - priorAdjustment);
    const learningContributions = changes.filter((change) => matchesChange(vacancy, change))
      .map((change) => ({
        kind: change.kind,
        field: change.field,
        value: change.value,
        weight: change.weight,
        scope: change.scope,
        scopeValue: change.scopeValue,
        proposalId: change.proposalId || null,
      }));
    if (!learningContributions.length) {
      const {
        basePreRankScore: _basePreRankScore,
        learningVersionId: _learningVersionId,
        learningAdjustment: _learningAdjustment,
        learningContributions: _learningContributions,
        ...baseVacancy
      } = vacancy;
      return { ...baseVacancy, preRankScore: basePreRankScore };
    }
    const learningAdjustment = Math.max(-20, Math.min(20,
      learningContributions.reduce((sum, { weight }) => sum + weight, 0)));
    return {
      ...vacancy,
      basePreRankScore,
      preRankScore: Math.max(0, Math.min(100, basePreRankScore + learningAdjustment)),
      learningVersionId: active.id,
      learningAdjustment,
      learningContributions,
    };
  }).sort(rankedTieBreak);
}

export function loadLearningLedger(root) {
  const file = workspacePaths(root).feedbackLearning;
  if (!fs.existsSync(file)) return null;
  return validateLearningLedger(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function writeLearningLedger(root, ledger) {
  const checked = validateLearningLedger(ledger);
  atomicWriteFile(workspacePaths(root).feedbackLearning, `${JSON.stringify(checked, null, 2)}\n`);
  return checked;
}
