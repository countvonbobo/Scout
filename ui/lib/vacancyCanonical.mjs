import crypto from 'node:crypto';
import { mergeSourceReferences, sameUnderlyingJob } from './jobIdentity.mjs';

const DISPLAY_FIELDS = ['employer', 'title', 'location', 'workingPattern', 'employmentType', 'seniority', 'compensation'];
const PROVENANCE_RANK = { 'explicit-source': 2, 'deterministic-extraction': 1, unknown: 0 };
const APPLICATION_BOILERPLATE = /(?:\bapply now\.?|\bclick here to apply\.?|\bsubmit your application\.?)/gi;

function valueOf(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

function normaliseText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function responsibilityDescription(vacancy) {
  return normaliseText(vacancy?.description).replace(APPLICATION_BOILERPLATE, '').replace(/\s+/g, ' ').trim();
}

function fingerprintShape(vacancy, { includeBoilerplate = false } = {}) {
  return {
    title: normaliseText(valueOf(vacancy?.title) || vacancy?.role),
    employer: normaliseText(valueOf(vacancy?.employer) || vacancy?.company),
    location: normaliseText(valueOf(vacancy?.location)),
    workingPattern: normaliseText(valueOf(vacancy?.workingPattern)),
    employmentType: normaliseText(valueOf(vacancy?.employmentType)),
    compensation: valueOf(vacancy?.compensation) || null,
    description: includeBoilerplate ? normaliseText(vacancy?.description) : responsibilityDescription(vacancy),
  };
}

function isClosed(vacancy) {
  return ['closed', 'gone', 'inactive'].includes(normaliseText(vacancy?.status || vacancy?.state || vacancy?.liveness));
}

function compareDisplayValues(left, right) {
  const rank = (value) => PROVENANCE_RANK[value?.provenance] || 0;
  const rankDifference = rank(right) - rank(left);
  if (rankDifference) return rankDifference;
  return String(valueOf(right) || '').length - String(valueOf(left) || '').length;
}

function displayField(observations, name) {
  return observations.map((observation) => observation?.[name]).filter(Boolean).sort(compareDisplayValues)[0]
    || { value: null, provenance: 'unknown' };
}

function canonicalVacancy(observations) {
  const description = observations.map((observation) => String(observation?.description || '').trim())
    .sort((left, right) => right.length - left.length)[0] || '';
  return {
    observations: [...observations],
    canonicalUrl: observations.map((observation) => observation?.canonicalUrl).find(Boolean) || null,
    sourceReferences: mergeSourceReferences(...observations),
    description,
    ...Object.fromEntries(DISPLAY_FIELDS.map((name) => [name, displayField(observations, name)])),
  };
}

export function canonicaliseObservations(observations) {
  const groups = [];
  for (const observation of observations || []) {
    const group = groups.find((candidate) => candidate.every((existing) => sameUnderlyingJob(existing, observation)));
    if (group) group.push(observation);
    else groups.push([observation]);
  }
  return {
    vacancies: groups.map(canonicalVacancy),
    duplicateObservations: (observations || []).length - groups.length,
  };
}

export function vacancyContentFingerprint(vacancy) {
  return crypto.createHash('sha256').update(stableJson(fingerprintShape(vacancy))).digest('hex');
}

export function classifyVacancyChange(previous, current) {
  if (isClosed(previous) && !isClosed(current)) return 'reopened';
  if (vacancyContentFingerprint(previous) !== vacancyContentFingerprint(current)) return 'material';
  return stableJson(fingerprintShape(previous, { includeBoilerplate: true })) === stableJson(fingerprintShape(current, { includeBoilerplate: true }))
    ? 'unchanged'
    : 'minor';
}
