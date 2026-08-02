import { createHash } from 'node:crypto';
import { normaliseIdentityText } from './jobIdentity.mjs';
import { serializeTracker } from './tracker.mjs';
import { queryAddressedUrlIdentityDigest } from './vacancyObservation.mjs';

const RECIPE_VERSION = 1;
const SAFE_CODE = /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_STATUS = new Set([
  'new', 'shortlist', 'watch', 'outreach', 'applied', 'interviewing',
  'accepted', 'rejected', 'ignore',
]);
const SAFE_OUTCOME = new Set([
  'kept', 'hard_exclusion', 'mandatory_unmet', 'below_threshold',
  'provider_discarded', 'advert_closed',
]);
const DISCARDED_COUNTERS = [
  'hard_exclusion', 'mandatory_unmet', 'below_threshold',
  'provider_discarded', 'advert_closed',
];
const SCAN_TAGS = new Set([
  'Advert unavailable',
  'Check mandatory requirement',
  'Updated advert — review',
]);
const FUNNEL_COUNTERS = [
  'sourceRecords', 'sourceErrors', 'failedSourceRecords', 'parsed', 'normalised',
  'duplicateObservations', 'uniqueVacancies', 'deterministicallyExcluded',
  'eligible', 'ranked', 'aboveThreshold', 'selected', 'assessed',
  'assessmentFailed', 'added', 'updated', 'unchanged', 'closed',
];
const SELECTION_COUNTERS = ['selected', 'assessed', 'assessmentFailed'];
const COVERAGE_COUNTERS = ['found', 'ranked', 'selected', 'excluded', 'assessed', 'assessmentFailed'];
const COVERAGE_DIMENSIONS = ['source', 'employer', 'lane', 'roleFamily', 'location', 'provider', 'run', 'date'];
const MAX_EXPLANATIONS = 10_000;
const PRIVATE_SOURCE_TOKEN = /^(?:access|api|auth|authorization|bearer|code|cookie|credential|jwt|key|password|secret|session|signature|state|token)$/;
const PRIVATE_IDENTIFIER_VALUE = /(?:\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\bbearer\s+[A-Za-z0-9._~+/-]{8,}|(?:token|secret|password|key)\s*[:=]\s*\S+)/i;

function boundedLabel(value, maximum) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!text || text.length > maximum || text.split(/\s+/).length > 16) return null;
  return text;
}

function code(value, fallback = null) {
  const text = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  return SAFE_CODE.test(text) && text.length <= 100 ? text : fallback;
}

function identifier(value) {
  const text = String(value || '').trim();
  return SAFE_IDENTIFIER.test(text) ? text : null;
}

function providerIdentifier(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (SAFE_PROVIDER_IDENTIFIER.test(text) && !PRIVATE_IDENTIFIER_VALUE.test(text)) return text;
  return `provider-${digest(text).slice(0, 32)}`;
}

function sourceIdentityLabel(value) {
  const raw = String(value || '').trim();
  if (PRIVATE_IDENTIFIER_VALUE.test(raw)) return `source-${digest(raw).slice(0, 32)}`;
  const label = boundedLabel(normaliseIdentityText(raw), 80);
  const words = label?.split(' ') || [];
  if (!label || words.length > 4 || words.some((word) => PRIVATE_SOURCE_TOKEN.test(word))) return null;
  return label;
}

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function isoTimestamp(value) {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) ? text : '';
}

function safeFunnel(value) {
  const projected = {};
  for (const key of FUNNEL_COUNTERS) {
    if (value?.[key] !== undefined) projected[key] = number(value[key]);
  }
  if (value?.bySource && typeof value.bySource === 'object' && !Array.isArray(value.bySource)) {
    projected.bySource = Object.fromEntries(Object.entries(value.bySource).map(([source, counts]) => [
      code(source, 'source'),
      {
        count: number(counts?.count),
        failedRecords: number(counts?.failedRecords),
        sourceErrors: number(counts?.sourceErrors),
        ...Object.fromEntries(FUNNEL_COUNTERS
          .filter((key) => !['sourceErrors', 'failedSourceRecords'].includes(key) && counts?.[key] !== undefined)
          .map((key) => [key, number(counts[key])])),
      },
    ]));
  }
  return projected;
}

function safeCoverage(value) {
  return {
    schemaVersion: number(value?.schemaVersion, 1),
    ...Object.fromEntries(COVERAGE_DIMENSIONS.map((dimension) => [
      dimension,
      (value?.[dimension] || []).map((row) => ({
        value: dimension === 'source' || dimension === 'provider'
          ? code(row?.value, 'unknown')
          : dimension === 'run'
            ? identifier(row?.value) || 'unknown-run'
            : boundedLabel(row?.value, 160) || 'unknown',
        ...Object.fromEntries(COVERAGE_COUNTERS.map((counter) => [counter, number(row?.[counter])])),
      })),
    ])),
    failureReasons: (value?.failureReasons || []).map((row) => ({
      value: code(row?.value, 'unknown-failure'),
      count: number(row?.count),
    })),
  };
}

function safeSelectionSummary(value) {
  return Object.fromEntries(SELECTION_COUNTERS
    .filter((key) => value?.[key] !== undefined)
    .map((key) => [key, number(value[key])]));
}

function safeDiscarded(value) {
  return Object.fromEntries(DISCARDED_COUNTERS.map((key) => [key, number(value?.[key])]));
}

function canonicalUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '').slice(0, 2_048);
  } catch {
    return null;
  }
}

function durableVacancyId(value) {
  const urlIdentityDigest = queryAddressedUrlIdentityDigest(value);
  if (urlIdentityDigest) return `vacancy-url-${urlIdentityDigest.slice(0, 24)}`;
  return canonicalUrl(value) || identifier(value);
}

function safeRankingHistory(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    rankedAt: /^\d{4}-\d{2}-\d{2}$/.test(item?.rankedAt || '') ? item.rankedAt : null,
    profileId: identifier(item?.profileId),
    learningVersionId: identifier(item?.learningVersionId),
    preRankScore: number(item?.preRankScore),
  })).filter((item) => item.rankedAt && item.profileId && item.learningVersionId).slice(-32);
}

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function plainJson(value) {
  if (value === null || ['boolean', 'string'].includes(typeof value)) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON replacement values must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(plainJson);
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('JSON replacement values must be plain JSON');
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainJson(item)]));
}

export function jsonReplaceRecipe(value) {
  const replacement = plainJson(value);
  if (!replacement || Array.isArray(replacement)) {
    throw new TypeError('JSON replacement root must be an object');
  }
  delete replacement._scoutMutation;
  return {
    schemaVersion: RECIPE_VERSION,
    operation: 'json-replace',
    value: replacement,
  };
}

function safeReferences(entry) {
  const values = Array.isArray(entry?.sourceReferences)
    ? entry.sourceReferences
    : (entry?.sources || []).map((url) => ({ url }));
  return values.map((reference) => ({
    source: sourceIdentityLabel(reference?.source),
    providerId: providerIdentifier(reference?.providerId),
    url: canonicalUrl(reference?.url),
  })).filter((reference) => reference.source || reference.providerId || reference.url).slice(0, 8);
}

function safeIdentity(entry) {
  const identity = entry?.jobIdentity || {};
  const evidence = Array.isArray(identity.evidenceTokenDigests)
    ? identity.evidenceTokenDigests
    : Array.isArray(identity.evidenceTokens)
      ? identity.evidenceTokens.map(digest)
      : [];
  return {
    company: boundedLabel(identity.company, 120),
    title: boundedLabel(identity.title, 160),
    location: boundedLabel(identity.location, 160),
    seniority: boundedLabel(identity.seniority, 80),
    evidenceTokenDigests: evidence.filter((value) => /^[a-f0-9]{64}$/.test(value)).slice(0, 32),
  };
}

function safeOpportunity(entry, existed, prior = null) {
  const id = identifier(entry?.id);
  if (!id) throw new TypeError('tracker mutation upsert requires a bounded ID');
  const scoreBreakdown = Object.fromEntries(Object.entries(entry?.scoreBreakdown || {})
    .map(([name, value]) => [code(name), number(value, null)])
    .filter(([name, value]) => name && value !== null)
    .slice(0, 16));
  const requirementChecks = (entry?.mandatoryRequirements || []).map((requirement) => ({
    id: identifier(requirement?.advertEvidenceId),
    status: code(requirement?.status, 'unknown'),
  })).filter((requirement) => requirement.id).slice(0, 24);
  const eligibility = code(entry?.eligibility?.status, 'below-threshold');
  return {
    id,
    company: boundedLabel(entry?.company, 120),
    role: boundedLabel(entry?.role, 160),
    location: boundedLabel(entry?.location, 160) || '',
    score: number(entry?.score, 0),
    scoreBreakdown,
    eligibility: {
      status: eligibility,
      reasonCodes: requirementChecks
        .filter((item) => item.status !== 'met')
        .map((item) => `mandatory-${item.status}`)
        .slice(0, 8),
    },
    requirementChecks,
    status: SAFE_STATUS.has(entry?.status) ? entry.status : 'new',
    category: code(entry?.category),
    scanTags: (entry?.tags || []).filter((tag) => SCAN_TAGS.has(tag)),
    sources: (entry?.sources || []).map(canonicalUrl).filter(Boolean).slice(0, 8),
    sourceReferences: safeReferences(entry),
    jobIdentity: safeIdentity(entry),
    vacancyId: durableVacancyId(entry?.vacancyId),
    profileId: identifier(entry?.profileId),
    learningVersionId: identifier(entry?.learningVersionId),
    rankingHistory: safeRankingHistory(entry?.rankingHistory),
    lastChecked: /^\d{4}-\d{2}-\d{2}$/.test(entry?.lastChecked || '') ? entry.lastChecked : null,
    foundVia: code(entry?.foundVia),
    ...(entry?.advertUpdate ? {
      advertUpdate: {
        detectedAt: /^\d{4}-\d{2}-\d{2}$/.test(entry.advertUpdate.detectedAt || '')
          ? entry.advertUpdate.detectedAt : null,
        previousDigest: digest(entry.advertUpdate.previousFingerprint),
        currentDigest: digest(entry.advertUpdate.currentFingerprint),
      },
    } : {}),
    noteCode: !existed ? 'scan-assessed'
      : entry?.status === 'ignore'
        && (entry?.tags || []).includes('Advert unavailable')
        && (prior?.status !== 'ignore' || !(prior?.tags || []).includes('Advert unavailable'))
        ? 'advert-unavailable' : null,
  };
}

export function trackerMergeRecipe(currentContent, intendedContent) {
  const current = JSON.parse(currentContent || '{"opportunities":[]}');
  const intended = JSON.parse(intendedContent);
  delete current._scoutMutation;
  delete intended._scoutMutation;
  const existing = new Map((current.opportunities || []).map((entry) => [entry.id, entry]));
  return {
    schemaVersion: RECIPE_VERSION,
    operation: 'tracker-merge',
    updated: /^\d{4}-\d{2}-\d{2}$/.test(intended.updated || '') ? intended.updated : null,
    upserts: (intended.opportunities || []).map((entry) => (
      safeOpportunity(entry, existing.has(entry.id), existing.get(entry.id))
    )),
  };
}

function safeRunRecord(record) {
  if ((record?.explanations || []).length > MAX_EXPLANATIONS) {
    throw new Error(`scan explanation capacity exceeded (${record.explanations.length} > ${MAX_EXPLANATIONS})`);
  }
  const sourceHealth = Object.fromEntries(Object.entries(record?.source_health || {}).map(([name, value]) => [
    code(name, 'source'),
    {
      status: code(value?.status, 'unavailable'),
      count: Number.isFinite(Number(value?.count)) ? Number(value.count) : null,
      reasonCode: code(
        value?.reasonCode ?? value?.reason,
        value?.reasonCode || value?.reason ? 'redacted-diagnostic' : null,
      ),
      configured: value?.configured !== false,
    },
  ]));
  return {
    schemaVersion: number(record?.schemaVersion, 5),
    timestamp: isoTimestamp(record?.timestamp),
    started_at: isoTimestamp(record?.started_at),
    agent: code(record?.agent, 'unknown'),
    mode: code(record?.mode, 'primary'),
    degraded: Boolean(record?.degraded),
    skipped: Boolean(record?.skipped),
    sources_checked: (record?.sources_checked || []).map((value) => code(value)).filter(Boolean),
    queries_checked: [],
    candidates_found: number(record?.candidates_found),
    keepers_added: number(record?.keepers_added),
    duplicates_collapsed: number(record?.duplicates_collapsed),
    keepers_updated: number(record?.keepers_updated),
    discarded: safeDiscarded(record?.discarded),
    candidates_dropped: number(record?.candidates_dropped),
    candidates_dropped_by_source: Object.fromEntries(Object.entries(record?.candidates_dropped_by_source || {})
      .map(([key, value]) => [code(key, 'source'), number(value)])),
    adverts_checked: number(record?.adverts_checked),
    adverts_closed: number(record?.adverts_closed),
    adverts_unverified: number(record?.adverts_unverified),
    verification_scoped: Boolean(record?.verification_scoped),
    inbox_rechecked: number(record?.inbox_rechecked),
    inbox_archived: number(record?.inbox_archived),
    profile_id: identifier(record?.profile_id),
    learning_version_id: identifier(record?.learning_version_id),
    discovery_engine: code(record?.discovery_engine, 'legacy-discovery'),
    ...(record?.funnel ? { funnel: safeFunnel(record.funnel) } : {}),
    ...(record?.selection_summary ? { selection_summary: safeSelectionSummary(record.selection_summary) } : {}),
    ...(record?.coverage ? { coverage: safeCoverage(record.coverage) } : {}),
    assessment_failures: (record?.assessment_failures || []).map((failure) => ({
      jobId: identifier(failure?.jobId),
      code: code(failure?.code, 'assessment-failed'),
      attempts: number(failure?.attempts),
      validationFailures: (failure?.validationFailures || []).map((value) => code(value, 'validation-failed')).slice(0, 8),
    })),
    explanations: (record?.explanations || []).map((item) => ({
      vacancy_id: durableVacancyId(item?.vacancy_id),
      company: boundedLabel(item?.company, 120),
      role: boundedLabel(item?.role, 160),
      dimensions: {
        source: code(item?.dimensions?.source, 'unknown-source'),
        employer: boundedLabel(item?.dimensions?.employer, 120) || 'unknown-employer',
        lane: boundedLabel(item?.dimensions?.lane, 120) || 'unknown-lane',
        role_family: boundedLabel(item?.dimensions?.role_family, 120) || 'unknown-role-family',
        location: boundedLabel(item?.dimensions?.location, 120) || 'unknown-location',
      },
      stages: {
        found: Boolean(item?.stages?.found),
        ranked: Boolean(item?.stages?.ranked),
        selected: Boolean(item?.stages?.selected),
        excluded: Boolean(item?.stages?.excluded),
        assessed: Boolean(item?.stages?.assessed),
      },
      above_threshold: Boolean(item?.above_threshold),
      pre_rank: {
        score: Number.isFinite(Number(item?.pre_rank?.score)) ? Number(item.pre_rank.score) : null,
        positive: (item?.pre_rank?.positive || []).map((value) => code(value?.code ?? value)).filter(Boolean).slice(0, 3),
        negative: (item?.pre_rank?.negative || []).map((value) => code(value?.code ?? value)).filter(Boolean).slice(0, 3),
      },
      selection_reason: code(item?.selection_reason),
      deterministic_exclusion: code(item?.deterministic_exclusion),
      deterministic_exclusions: (item?.deterministic_exclusions || []).map((value) => code(value)).filter(Boolean).slice(0, 8),
      reason_code: code(item?.reason_code, 'unknown'),
      assessment_status: code(item?.assessment_status, 'unknown'),
      outcome: code(item?.outcome),
      source: sourceIdentityLabel(item?.source),
      sourceUrl: canonicalUrl(item?.sourceUrl),
      sourceReferences: safeReferences({ sourceReferences: item?.sourceReferences }),
    })),
    reviewed: (record?.reviewed || []).map((item) => ({
      vacancyId: durableVacancyId(item?.vacancyId),
      company: boundedLabel(item?.company, 120),
      role: boundedLabel(item?.role, 160),
      source: sourceIdentityLabel(item?.source),
      sourceUrl: canonicalUrl(item?.sourceUrl),
      sourceReferences: safeReferences({ sourceReferences: item?.sourceReferences }),
      contentFingerprint: /^[a-f0-9]{64}$/.test(String(item?.contentFingerprint || ''))
        ? item.contentFingerprint
        : null,
      profileId: identifier(item?.profileId),
      learningVersionId: identifier(item?.learningVersionId),
      categoryId: code(item?.categoryId),
      outcome: SAFE_OUTCOME.has(item?.outcome) ? item.outcome : 'below_threshold',
      score: number(item?.score),
      reasonCodes: item?.outcome === 'provider_discarded'
        ? ['provider-discarded']
        : item?.outcome === 'below_threshold' ? ['below-threshold'] : [],
    })).slice(0, 180),
    errors: (record?.errors || []).map((value) => code(value, 'redacted-diagnostic')).slice(0, 16),
    source_health: sourceHealth,
  };
}

export function runLogAppendRecipe(record) {
  return {
    schemaVersion: RECIPE_VERSION,
    operation: 'run-log-append',
    record: safeRunRecord(record),
  };
}

export function scanReportRecipe(model) {
  return {
    schemaVersion: RECIPE_VERSION,
    operation: 'scan-report',
    model: {
      date: String(model.date || ''),
      degraded: Boolean(model.degraded),
      coverage: (model.coverage || []).map((item) => ({
        source: code(item?.source, 'source'),
        status: code(item?.status, 'unavailable'),
        count: Number.isFinite(Number(item?.count)) ? Number(item.count) : null,
        reasonCode: code(item?.reasonCode, item?.reasonCode ? 'redacted-diagnostic' : null),
        configured: item?.configured !== false,
      })),
      actions: (model.actions || []).map((item) => ({
        company: boundedLabel(item?.company, 120),
        role: boundedLabel(item?.role, 160),
        score: number(item?.score),
        url: canonicalUrl(item?.url),
      })),
      checks: (model.checks || []).map((item) => ({
        company: boundedLabel(item?.company, 120),
        role: boundedLabel(item?.role, 160),
        score: number(item?.score),
        reasonCodes: (item?.reasonCodes || []).map((value) => code(value, 'check-required')).slice(0, 8),
      })),
      keeperCount: number(model.keeperCount),
      discarded: safeDiscarded(model.discarded),
      nearMisses: (model.nearMisses || []).map((item) => ({
        company: boundedLabel(item?.company, 120),
        role: boundedLabel(item?.role, 160),
        score: number(item?.score),
        reasonCodes: (item?.reasonCodes || []).map((value) => code(value, 'not-kept')).slice(0, 8),
        sourceUrl: canonicalUrl(item?.sourceUrl),
      })).slice(0, 5),
      errors: (model.errors || []).map((value) => code(value, 'redacted-diagnostic')).slice(0, 16),
      runs: (model.runs || []).map((item) => ({
        agent: code(item?.agent, 'unknown'),
        mode: code(item?.mode, 'primary'),
        timestamp: isoTimestamp(item?.timestamp),
        skipped: Boolean(item?.skipped),
        degraded: Boolean(item?.degraded),
        candidatesFound: number(item?.candidatesFound),
        keepersAdded: number(item?.keepersAdded),
        keepersUpdated: number(item?.keepersUpdated),
        sources: (item?.sources || []).map((source) => ({
          name: code(source?.name, 'source'),
          status: code(source?.status, 'unavailable'),
        })),
      })),
    },
  };
}

function canonicalTrackerRecipe(recipe) {
  return {
    schemaVersion: RECIPE_VERSION,
    operation: 'tracker-merge',
    updated: /^\d{4}-\d{2}-\d{2}$/.test(recipe?.updated || '') ? recipe.updated : null,
    upserts: (recipe?.upserts || []).map((item) => ({
      id: identifier(item?.id),
      company: boundedLabel(item?.company, 120),
      role: boundedLabel(item?.role, 160),
      location: boundedLabel(item?.location, 160) || '',
      score: number(item?.score),
      scoreBreakdown: Object.fromEntries(Object.entries(item?.scoreBreakdown || {})
        .map(([key, value]) => [code(key), number(value, null)])
        .filter(([key, value]) => key && value !== null)),
      eligibility: {
        status: code(item?.eligibility?.status, 'below-threshold'),
        reasonCodes: (item?.eligibility?.reasonCodes || []).map((value) => code(value)).filter(Boolean).slice(0, 8),
      },
      requirementChecks: (item?.requirementChecks || []).map((check) => ({
        id: identifier(check?.id),
        status: code(check?.status, 'unknown'),
      })).filter((check) => check.id).slice(0, 24),
      status: SAFE_STATUS.has(item?.status) ? item.status : 'new',
      category: code(item?.category),
      scanTags: (item?.scanTags || []).filter((tag) => SCAN_TAGS.has(tag)),
      sources: (item?.sources || []).map(canonicalUrl).filter(Boolean).slice(0, 8),
      sourceReferences: safeReferences({ sourceReferences: item?.sourceReferences }),
      jobIdentity: safeIdentity({ jobIdentity: item?.jobIdentity }),
      vacancyId: durableVacancyId(item?.vacancyId),
      profileId: identifier(item?.profileId),
      learningVersionId: identifier(item?.learningVersionId),
      rankingHistory: safeRankingHistory(item?.rankingHistory),
      lastChecked: /^\d{4}-\d{2}-\d{2}$/.test(item?.lastChecked || '') ? item.lastChecked : null,
      foundVia: code(item?.foundVia),
      ...(item?.advertUpdate ? {
        advertUpdate: {
          detectedAt: /^\d{4}-\d{2}-\d{2}$/.test(item.advertUpdate.detectedAt || '')
            ? item.advertUpdate.detectedAt : null,
          previousDigest: /^[a-f0-9]{64}$/.test(item.advertUpdate.previousDigest || '')
            ? item.advertUpdate.previousDigest : digest(''),
          currentDigest: /^[a-f0-9]{64}$/.test(item.advertUpdate.currentDigest || '')
            ? item.advertUpdate.currentDigest : digest(''),
        },
      } : {}),
      noteCode: ['scan-assessed', 'advert-unavailable'].includes(item?.noteCode) ? item.noteCode : null,
    })),
  };
}

export function canonicalMutationRecipe(kind, recipe) {
  if (!recipe || recipe.schemaVersion !== RECIPE_VERSION) throw new TypeError('mutation recipe is invalid');
  if (kind === 'tracker' && recipe.operation === 'tracker-merge') return canonicalTrackerRecipe(recipe);
  if (kind === 'report' && recipe.operation === 'scan-report') return scanReportRecipe(recipe.model || {});
  if (kind === 'run-log' && recipe.operation === 'run-log-append') return runLogAppendRecipe(recipe.record || {});
  if (kind === 'json' && recipe.operation === 'json-replace') return jsonReplaceRecipe(recipe.value);
  throw new TypeError(`mutation recipe does not match target kind: ${kind}`);
}

function renderTracker(currentContent, recipe) {
  const tracker = JSON.parse(currentContent || '{"opportunities":[]}');
  delete tracker._scoutMutation;
  const byId = new Map((tracker.opportunities || []).map((entry) => [entry.id, entry]));
  for (const upsert of recipe.upserts) {
    const existing = byId.get(upsert.id);
    const requirementChecks = upsert.requirementChecks.map((item) => ({
      advertEvidenceId: item.id,
      status: item.status,
    }));
    const projected = {
      id: upsert.id,
      company: upsert.company,
      role: upsert.role,
      location: upsert.location,
      score: upsert.score,
      scoreBreakdown: upsert.scoreBreakdown,
      eligibility: { status: upsert.eligibility.status, reasons: upsert.eligibility.reasonCodes },
      mandatoryRequirements: requirementChecks,
      status: upsert.status,
      category: upsert.category,
      sources: upsert.sources,
      sourceReferences: upsert.sourceReferences,
      jobIdentity: upsert.jobIdentity,
      vacancyId: upsert.vacancyId,
      profileId: upsert.profileId,
      learningVersionId: upsert.learningVersionId,
      rankingHistory: upsert.rankingHistory,
      lastChecked: upsert.lastChecked,
      foundVia: upsert.foundVia,
      ...(upsert.advertUpdate ? { advertUpdate: upsert.advertUpdate } : {}),
    };
    if (existing) {
      existing.tags = [...new Set([...(existing.tags || []), ...upsert.scanTags])];
      Object.assign(existing, projected);
      if (upsert.noteCode === 'advert-unavailable') {
        const note = `[${upsert.lastChecked}] Removed from Jobs automatically: advert-unavailable.`;
        if (!String(existing.notes || '').includes(note)) {
          existing.notes = existing.notes ? `${existing.notes}\n${note}` : note;
        }
      }
    } else {
      const created = {
        ...projected,
        tags: upsert.scanTags,
        notes: upsert.noteCode === 'scan-assessed'
          ? 'Assessed by Scout against the published profile.' : '',
        contacts: [],
        log: [],
      };
      tracker.opportunities = [...(tracker.opportunities || []), created];
      byId.set(created.id, created);
    }
  }
  tracker.updated = recipe.updated || tracker.updated;
  return serializeTracker(tracker);
}

function renderReport(recipe) {
  const model = recipe.model;
  const coverage = model.coverage.map((item) => (
    `- ${item.source}: ${item.configured === false ? 'not configured' : item.status} `
    + `(${item.count ?? 'unknown'})${item.reasonCode ? ` — ${item.reasonCode}` : ''}`
  )).join('\n');
  const actions = model.actions.map((item) => (
    `- **${item.company} — ${item.role}** (${item.score})${item.url ? ` — ${item.url}` : ''}`
  )).join('\n') || '- None.';
  const checks = model.checks.map((item) => (
    `- **${item.company} — ${item.role}** (${item.score}) — ${item.reasonCodes.join('; ') || 'check-required'}`
  )).join('\n') || '- None.';
  const nearMisses = model.nearMisses.map((item) => (
    `- **${item.company} — ${item.role}** (${item.score}) — ${item.reasonCodes.join('; ') || 'not-kept'}`
    + `${item.sourceUrl ? ` — ${item.sourceUrl}` : ''}`
  )).join('\n') || '- None.';
  const runs = model.runs.map((item) => {
    const sources = item.sources.map((source) => `${source.name}: ${source.status}`).join(', ') || 'no sources';
    const state = item.skipped ? 'skipped because another scan was running' : item.degraded ? 'degraded' : 'healthy';
    return `- **${item.agent} ${item.mode}** at ${item.timestamp.slice(11, 16) || 'unknown time'} UTC - ${state}; `
      + `${item.candidatesFound} candidate(s), ${item.keepersAdded} added, ${item.keepersUpdated} updated; ${sources}.`;
  }).join('\n');
  return `# Scout report — ${model.date}\n\n## Headline\n\n`
    + `${model.degraded ? 'Coverage was degraded; this is not evidence that no suitable roles exist.' : 'Configured sources completed successfully.'}\n\n`
    + `${coverage}\n\n## Scan runs\n\n${runs}\n\n## Action today\n\n${actions}\n\n`
    + `## One check from unlocking\n\n${checks}\n\n## Follow-ups due\n\n`
    + `- Review existing tracker follow-ups in Scout.\n\n## Changes since last scan\n\n`
    + `- ${model.keeperCount} current keeper(s) in the tracker.\n\n## Discarded\n\n`
    + `${Object.entries(model.discarded).map(([name, count]) => `- ${name}: ${count}`).join('\n')}\n\n`
    + `### Closest reviewed roles not kept\n\n${nearMisses}\n\n`
    + `The full sanitised review is available from Scout's latest scan result.\n\n## Verdicts\n\n`
    + `${model.errors.length ? model.errors.map((error) => `- Error: ${error}`).join('\n') : '- No applications or outreach were sent.'}\n`;
}

function renderRunLog(currentContent, recipe) {
  const lines = String(currentContent || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const record = JSON.parse(line);
    delete record._scoutMutation;
    return JSON.stringify(record);
  });
  return `${lines.length ? `${lines.join('\n')}\n` : ''}${JSON.stringify(recipe.record)}\n`;
}

export function renderMutationRecipe(kind, currentContent, recipe) {
  recipe = canonicalMutationRecipe(kind, recipe);
  if (kind === 'tracker' && recipe.operation === 'tracker-merge') return renderTracker(currentContent, recipe);
  if (kind === 'report' && recipe.operation === 'scan-report') return renderReport(recipe);
  if (kind === 'run-log' && recipe.operation === 'run-log-append') return renderRunLog(currentContent, recipe);
  if (kind === 'json' && recipe.operation === 'json-replace') return `${JSON.stringify(recipe.value, null, 2)}\n`;
  throw new TypeError(`mutation recipe does not match target kind: ${kind}`);
}
