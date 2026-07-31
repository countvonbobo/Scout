import crypto from 'node:crypto';
import { jobIdentity, mergeSourceReferences, sameUnderlyingJob } from './jobIdentity.mjs';

const DISPLAY_FIELDS = [
  'employer', 'employerReference', 'title', 'location', 'workingPattern',
  'employmentType', 'seniority', 'compensation', 'industry',
];
const LIST_FIELDS = ['responsibilities', 'skills', 'qualifications', 'eligibility'];
const PROVENANCE_RANK = { 'explicit-source': 2, 'deterministic-extraction': 1, unknown: 0 };
const APPLICATION_BOILERPLATE = /(?:\bapply now\.?|\bclick here to apply\.?|\bsubmit your application\.?)/gi;
const MAX_SEMANTIC_RULE_MATCHES = 64;
const MAX_SEMANTIC_MATCH_SOURCES = 8;
const MAX_RESPONSIBILITY_FACTS = 64;

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

function metadataValues(observations, name) {
  return [...new Set(observations.flatMap((observation) => {
    const value = observation?.[name];
    return Array.isArray(value) ? value : [value];
  }).map((value) => String(value || '').trim().slice(0, 120))
    .filter(Boolean))].sort(compareStable);
}

function canonicalVacancyId(canonicalUrl, identity, sourceReferences) {
  if (canonicalUrl) return canonicalUrl;
  const reference = [...sourceReferences].sort((left, right) => (
    -compareStable(
      `${left.source || ''}\n${left.providerId || ''}\n${left.url || ''}`,
      `${right.source || ''}\n${right.providerId || ''}\n${right.url || ''}`,
    )
  ))[0] || null;
  return `vacancy-ref-${crypto.createHash('sha256')
    .update(stableJson({ identity, reference }))
    .digest('hex').slice(0, 24)}`;
}

function boundedSemanticText(value, maximum) {
  return String(value || '').normalize('NFKC').replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ').trim().slice(0, maximum);
}

function semanticMatchEvidence(observation, match) {
  const semantic = observation.semanticEvidence;
  const fallback = {
    source: boundedSemanticText(observation.source, 80),
    providerId: boundedSemanticText(observation.sourceRecordId, 160),
    descriptionDigest: /^[a-f0-9]{64}$/.test(semantic.descriptionDigest || '')
      ? semantic.descriptionDigest
      : '',
    provenance: 'deterministic-extraction',
  };
  const supplied = Array.isArray(match?.evidence) && match.evidence.length
    ? match.evidence
    : [fallback];
  return supplied.map((item) => ({
    source: boundedSemanticText(item?.source || fallback.source, 80),
    providerId: boundedSemanticText(item?.providerId || fallback.providerId, 160),
    descriptionDigest: /^[a-f0-9]{64}$/.test(item?.descriptionDigest || '')
      ? item.descriptionDigest
      : fallback.descriptionDigest,
    provenance: ['explicit-source', 'deterministic-extraction'].includes(item?.provenance)
      ? item.provenance
      : fallback.provenance,
    status: match?.status === 'unknown' ? 'unknown' : 'matched',
  })).filter(({ source, providerId, descriptionDigest }) => (
    source || providerId || descriptionDigest
  ));
}

function mergedSemanticEvidence(observations) {
  const semanticObservations = observations.filter((observation) => observation?.semanticEvidence);
  if (!semanticObservations.length) return null;
  const selected = [...semanticObservations].sort((left, right) => (
    Number(right.semanticEvidence.descriptionLength || 0) - Number(left.semanticEvidence.descriptionLength || 0)
    || compareStable(left.semanticEvidence.descriptionDigest, right.semanticEvidence.descriptionDigest)
  ))[0];
  const ruleEvidence = new Map();
  for (const observation of semanticObservations) {
    const entries = observation.semanticEvidence.profileRuleEvidence
      || (observation.semanticEvidence.profileRuleMatches || []).map((match) => (
        typeof match === 'string' ? { id: match, status: 'matched' } : { ...match, status: 'matched' }
      ));
    for (const rawEntry of entries) {
      const entry = typeof rawEntry === 'string'
        ? { id: rawEntry, fact: '', status: 'matched' }
        : rawEntry;
      const id = boundedSemanticText(entry?.id, 160);
      if (!id) continue;
      const current = ruleEvidence.get(id) || {
        id, fact: '', status: 'unknown', evidence: [],
      };
      const fact = boundedSemanticText(entry?.fact, 160);
      if (fact && (!current.fact || compareStable(fact, current.fact) < 0)) current.fact = fact;
      if (entry?.status === 'matched') current.status = 'matched';
      const evidence = [...current.evidence, ...semanticMatchEvidence(observation, entry)];
      current.evidence = [...new Map(evidence.map((item) => [stableJson(item), item])).values()]
        .sort((left, right) => compareStable(stableJson(left), stableJson(right)))
        .slice(0, MAX_SEMANTIC_MATCH_SOURCES);
      ruleEvidence.set(id, current);
    }
  }
  const responsibilityFacts = [...new Set(semanticObservations.flatMap(({ semanticEvidence }) => (
    (semanticEvidence.responsibilityFacts || [])
      .map((fact) => boundedSemanticText(fact, 160))
      .filter(Boolean)
  )))].sort(compareStable);
  if (responsibilityFacts.length > MAX_RESPONSIBILITY_FACTS) {
    throw new Error('canonical advert responsibility evidence exceeds the supported limit');
  }
  return {
    ...selected.semanticEvidence,
    descriptionPresent: semanticObservations.some(({ semanticEvidence }) => (
      semanticEvidence.descriptionPresent === true
    )),
    profileRuleEvidence: [...ruleEvidence.values()]
      .sort((left, right) => compareStable(left.id, right.id))
      .slice(0, MAX_SEMANTIC_RULE_MATCHES),
    profileRuleMatches: [...ruleEvidence.values()]
      .filter(({ status }) => status === 'matched')
      .map(({ status, ...match }) => ({
        ...match,
        evidence: match.evidence
          .filter((item) => item.status === 'matched')
          .map(({ status: evidenceStatus, ...item }) => item),
      }))
      .sort((left, right) => compareStable(left.id, right.id))
      .slice(0, MAX_SEMANTIC_RULE_MATCHES),
    responsibilityFacts,
  };
}

function canonicalVacancy(observations) {
  const orderedObservations = sortObservations(observations);
  const semanticEvidence = mergedSemanticEvidence(orderedObservations);
  const description = semanticEvidence
    ? ''
    : orderedObservations.map((observation) => String(observation?.description || '').trim())
      .sort((left, right) => right.length - left.length || compareStable(left, right))[0] || '';
  const fields = Object.fromEntries(DISPLAY_FIELDS.map((name) => [name, displayField(orderedObservations, name)]));
  const canonicalUrl = orderedObservations.map((observation) => observation?.canonicalUrl).find(Boolean) || null;
  const sourceReferences = mergeSourceReferences(...orderedObservations);
  const identity = jobIdentity({
    company: fields.employer,
    title: fields.title,
    location: fields.location,
    seniority: fields.seniority,
  });
  const fallbackIdentity = {
    company: identity.company,
    title: identity.title,
    location: identity.location,
    seniority: identity.seniority,
  };
  const vacancyId = canonicalVacancyId(canonicalUrl, fallbackIdentity, sourceReferences);
  const collectionSources = metadataValues(orderedObservations, 'collectionSource');
  const laneIds = [...new Set([
    ...metadataValues(orderedObservations, 'laneId'),
    ...metadataValues(orderedObservations, 'laneIds'),
  ])].sort(compareStable);
  const roleFamilies = metadataValues(orderedObservations, 'roleFamily');
  return {
    observations: orderedObservations,
    vacancyId,
    canonicalUrl,
    sourceReferences,
    collectionSources,
    collectionSource: collectionSources[0] || null,
    description,
    postedAt: dateBound(orderedObservations, 'postedAt', 1),
    closingAt: dateBound(orderedObservations, 'closingAt', 1),
    firstSeenAt: dateBound(orderedObservations, 'firstSeenAt', 1),
    lastSeenAt: dateBound(orderedObservations, 'lastSeenAt', -1),
    laneIds,
    laneId: laneIds[0] || null,
    roleFamilies,
    roleFamily: roleFamilies[0] || null,
    ...(semanticEvidence ? { semanticEvidence } : {}),
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
  const vacancies = groups.sort((left, right) => compareStable(groupKey(left), groupKey(right))).map(canonicalVacancy);
  return {
    vacancies,
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
