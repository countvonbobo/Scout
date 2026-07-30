import crypto from 'node:crypto';
import { mergeSourceReferences, sameUnderlyingJob } from './jobIdentity.mjs';

const DISPLAY_FIELDS = [
  'employer', 'employerReference', 'title', 'location', 'workingPattern',
  'employmentType', 'seniority', 'compensation', 'industry',
];
const LIST_FIELDS = ['responsibilities', 'skills', 'qualifications', 'eligibility'];
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

function compareStable(left, right) {
  const a = String(left); const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function observationKey(observation) {
  return observation?.observationId || stableJson(observation);
}

function sortObservations(observations) {
  return [...observations].sort((left, right) => compareStable(observationKey(left), observationKey(right)));
}

function groupKey(group) {
  return sortObservations(group).map(observationKey).join('|');
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
    employerReference: normaliseText(valueOf(vacancy?.employerReference)),
    responsibilities: valueOf(vacancy?.responsibilities) || null,
    skills: valueOf(vacancy?.skills) || null,
    qualifications: valueOf(vacancy?.qualifications) || null,
    eligibility: valueOf(vacancy?.eligibility) || null,
    industry: normaliseText(valueOf(vacancy?.industry)),
    compensation: valueOf(vacancy?.compensation) || null,
    description: vacancy?.semanticEvidence?.descriptionDigest
      || (includeBoilerplate ? normaliseText(vacancy?.description) : responsibilityDescription(vacancy)),
  };
}

function isClosed(vacancy) {
  return ['closed', 'gone', 'inactive'].includes(normaliseText(vacancy?.status || vacancy?.state || vacancy?.liveness));
}

function compareDisplayValues(left, right) {
  const rank = (value) => PROVENANCE_RANK[value?.provenance] || 0;
  const rankDifference = rank(right) - rank(left);
  if (rankDifference) return rankDifference;
  const lengthDifference = String(valueOf(right) || '').length - String(valueOf(left) || '').length;
  if (lengthDifference) return lengthDifference;
  return compareStable(stableJson(left), stableJson(right));
}

function displayField(observations, name) {
  return observations.map((observation) => observation?.[name]).filter(Boolean).sort(compareDisplayValues)[0]
    || { value: null, provenance: 'unknown' };
}

function listDisplayField(observations, name) {
  const candidates = observations.map((observation) => observation?.[name]).filter(Boolean);
  const values = [...new Set(candidates.flatMap((candidate) => (
    Array.isArray(valueOf(candidate)) ? valueOf(candidate) : []
  )))].sort(compareStable);
  const provenance = candidates.some((candidate) => candidate.provenance === 'explicit-source')
    ? 'explicit-source'
    : values.length ? 'deterministic-extraction' : 'unknown';
  return { value: values.length ? values : null, provenance };
}

function dateBound(observations, name, direction) {
  const values = observations.map((observation) => observation?.[name]).filter(Boolean);
  if (!values.length) return null;
  return [...values].sort((left, right) => direction * compareStable(left, right))[0];
}

function canonicalVacancy(observations) {
  const orderedObservations = sortObservations(observations);
  const semanticObservation = [...orderedObservations]
    .filter((observation) => observation?.semanticEvidence)
    .sort((left, right) => (
      Number(right.semanticEvidence.descriptionLength || 0) - Number(left.semanticEvidence.descriptionLength || 0)
      || compareStable(left.semanticEvidence.descriptionDigest, right.semanticEvidence.descriptionDigest)
    ))[0];
  const description = semanticObservation
    ? ''
    : orderedObservations.map((observation) => String(observation?.description || '').trim())
      .sort((left, right) => right.length - left.length || compareStable(left, right))[0] || '';
  const fields = Object.fromEntries(DISPLAY_FIELDS.map((name) => [name, displayField(orderedObservations, name)]));
  const canonicalUrl = orderedObservations.map((observation) => observation?.canonicalUrl).find(Boolean) || null;
  const sourceReferences = mergeSourceReferences(...orderedObservations);
  return {
    observations: orderedObservations,
    canonicalUrl,
    sourceReferences,
    description,
    postedAt: dateBound(orderedObservations, 'postedAt', 1),
    closingAt: dateBound(orderedObservations, 'closingAt', 1),
    firstSeenAt: dateBound(orderedObservations, 'firstSeenAt', 1),
    lastSeenAt: dateBound(orderedObservations, 'lastSeenAt', -1),
    ...(semanticObservation ? { semanticEvidence: semanticObservation.semanticEvidence } : {}),
    ...fields,
    ...Object.fromEntries(LIST_FIELDS.map((name) => [name, listDisplayField(orderedObservations, name)])),
  };
}

export function canonicaliseObservations(observations) {
  const groups = [];
  const orderedObservations = sortObservations(observations || []);
  for (const observation of orderedObservations) {
    const group = groups.find((candidate) => candidate.every((existing) => sameUnderlyingJob(existing, observation)));
    if (group) group.push(observation);
    else groups.push([observation]);
  }
  return {
    vacancies: groups.sort((left, right) => compareStable(groupKey(left), groupKey(right))).map(canonicalVacancy),
    duplicateObservations: orderedObservations.length - groups.length,
  };
}

export function vacancyContentFingerprint(vacancy) {
  return crypto.createHash('sha256').update(stableJson(fingerprintShape(vacancy))).digest('hex');
}

export function classifyVacancyChange(previous, current) {
  if (isClosed(previous) && !isClosed(current)) return 'reopened';
  const currentFingerprint = vacancyContentFingerprint(current);
  if (previous?.contentFingerprint) {
    return previous.contentFingerprint === currentFingerprint ? 'unchanged' : 'material';
  }
  if (vacancyContentFingerprint(previous) !== currentFingerprint) return 'material';
  return stableJson(fingerprintShape(previous, { includeBoilerplate: true })) === stableJson(fingerprintShape(current, { includeBoilerplate: true }))
    ? 'unchanged'
    : 'minor';
}
