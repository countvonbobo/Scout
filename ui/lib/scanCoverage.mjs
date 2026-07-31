import { createHash } from 'node:crypto';
import { sourceReferencesOf } from './jobIdentity.mjs';

const MAX_EXPLANATIONS = 10_000;
const RECONCILED_STAGES = Object.freeze([
  'sourceRecords', 'sourceErrors', 'failedSourceRecords', 'parsed', 'normalised',
  'duplicateObservations', 'uniqueVacancies', 'deterministicallyExcluded',
  'eligible', 'ranked', 'aboveThreshold', 'selected', 'assessed', 'assessmentFailed',
  'added', 'updated', 'unchanged', 'closed',
]);
const ROLLUP_COUNTERS = Object.freeze([
  'found', 'ranked', 'selected', 'excluded', 'assessed', 'assessmentFailed',
]);

function text(value, maximum = 160) {
  const result = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return result ? result.slice(0, maximum) : null;
}

function code(value, fallback = null) {
  const result = String(value ?? '').trim().toLowerCase().replace(/_/g, '-')
    .replace(/[^a-z0-9:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return result || fallback;
}

function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
}

function idOf(value) {
  const identity = text(
    value?.vacancyId ?? value?.vacancy_id ?? value?.candidateId
      ?? value?._rankedVacancy?.vacancyId ?? value?.canonicalUrl ?? value?.url,
    2_048,
  );
  if (!identity) return null;
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/.test(identity)) return identity;
  return `vacancy-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
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

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceOf(value) {
  return text(
    value?.collectionSource ?? value?.collectionSources?.[0]
      ?? value?._rankedVacancy?.collectionSource
      ?? value?._rankedVacancy?.collectionSources?.[0]
      ?? value?.source ?? value?.sourceName
      ?? value?.observations?.[0]?.collectionSource
      ?? value?.observations?.[0]?.source
      ?? value?.sourceReferences?.[0]?.source,
    80,
  ) || 'unknown-source';
}

function durableSourceReferences(value) {
  return [...new Map(sourceReferencesOf(value).map((reference) => {
    const safe = {
      source: reference.source,
      providerId: reference.providerId,
      url: canonicalUrl(reference.url),
    };
    return [`${safe.source}|${safe.providerId}|${safe.url || ''}`, safe];
  })).values()].slice(0, 8);
}

function labelOf(value, names, fallback, maximum = 160) {
  for (const name of names) {
    const found = valueOf(value?.[name]);
    if (found !== undefined && found !== null && found !== '') return text(found, maximum);
  }
  return fallback;
}

function scoreOf(value) {
  const score = Number(value?.preRank?.score ?? value?.preRankScore ?? value?.score);
  return Number.isFinite(score) ? score : null;
}

function compactContributions(value, positive) {
  const supplied = value?.preRank?.[positive ? 'positive' : 'negative'];
  const values = Array.isArray(supplied)
    ? supplied
    : (value?.contributions || []).filter((item) => (
      positive ? Number(item?.score) > 0 : Number(item?.score) < 0
    )).sort((left, right) => Math.abs(Number(right?.score)) - Math.abs(Number(left?.score)));
  return values.slice(0, 3).map((item) => (
    typeof item === 'string'
      ? code(item)
      : { code: code(item?.code ?? item?.profileRuleId, 'contribution'), score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null }
  )).filter((item) => typeof item === 'string' ? item : item.code);
}

function dimensionsOf(value) {
  return {
    source: sourceOf(value),
    employer: labelOf(value, ['company', 'employerId', 'employer'], 'unknown-employer', 120),
    lane: labelOf(value, ['laneId', 'lane', 'sourceLane'], 'unknown-lane', 120),
    role_family: labelOf(value, ['roleFamilyId', 'roleFamily', 'targetRoleFamily'], 'unknown-role-family', 120),
    location: labelOf(value, ['locationId', 'location'], 'unknown-location', 120),
  };
}

function keyed(values) {
  return new Map((values || []).map((value) => [idOf(value), value]).filter(([id]) => id));
}

function explanationInput(value) {
  return value?._rankedVacancy || value;
}

export function buildVacancyExplanations({
  ranked = [],
  exclusions = [],
  candidates = [],
  assessmentResult = null,
  reviewed = [],
  selectionDecision = null,
  deterministicExclusions = exclusions,
  closedAdverts = [],
  verificationScoped = false,
} = {}) {
  const records = new Map();
  for (const value of exclusions) {
    const id = idOf(value);
    if (id && !records.has(id)) records.set(id, { value: explanationInput(value), excluded: true });
  }
  for (const value of ranked) {
    const id = idOf(value);
    if (id && !records.has(id)) records.set(id, { value: explanationInput(value), excluded: false });
  }
  for (const value of candidates) {
    const id = idOf(value);
    if (id && !records.has(id)) records.set(id, { value: explanationInput(value), excluded: false });
  }
  if (records.size > MAX_EXPLANATIONS) {
    throw new Error(`vacancy explanation capacity exceeded (${records.size} > ${MAX_EXPLANATIONS})`);
  }

  const finalSelected = keyed(candidates);
  const originallySelected = keyed(selectionDecision?.selected);
  const assessedCandidates = new Set((assessmentResult?.assessments || []).map((item) => (
    text(item?.candidateId, 160)
  )).filter(Boolean));
  const reviewedByVacancy = keyed(reviewed);
  const reviewedByUrl = new Map((reviewed || []).map((item) => [
    canonicalUrl(item?.sourceUrl), item,
  ]).filter(([url]) => url));
  const selectionReasons = new Map((selectionDecision?.reasons || []).map((item) => [
    idOf(item), code(item?.reason),
  ]).filter(([id]) => id));
  const notSelected = new Map((selectionDecision?.notSelected || []).map((item) => [
    idOf(item), code(item?.reason, 'not-selected'),
  ]).filter(([id]) => id));
  const skipped = new Map((selectionDecision?.assessmentSkipped || []).map((item) => [
    idOf(item), code(item?.lifecycle?.reason, 'unchanged-prior-assessment'),
  ]).filter(([id]) => id));
  const exclusionCodes = new Map();
  for (const item of deterministicExclusions || []) {
    const id = idOf(item);
    if (!id) continue;
    const exclusionCode = code(item?.code ?? item?.exclusionCode, 'deterministic-exclusion');
    const codes = exclusionCodes.get(id) || [];
    if (!codes.includes(exclusionCode)) codes.push(exclusionCode);
    exclusionCodes.set(id, codes);
  }
  const closed = new Set((closedAdverts || []).map(idOf).filter(Boolean));
  const threshold = Number(selectionDecision?.threshold);

  return [...records.entries()].map(([vacancyId, record]) => {
    const value = record.value;
    const candidate = finalSelected.get(vacancyId);
    const selected = Boolean(candidate);
    const assessed = Boolean(candidate && assessedCandidates.has(text(candidate.candidateId, 160)));
    const excluded = record.excluded || exclusionCodes.has(vacancyId);
    const wasSelected = originallySelected.has(vacancyId);
    const reviewedItem = reviewedByVacancy.get(vacancyId)
      || reviewedByUrl.get(canonicalUrl(candidate?.url ?? value?.url ?? value?.canonicalUrl));
    const deterministicExclusionsForVacancy = excluded
      ? exclusionCodes.get(vacancyId) || [code(value?.code ?? value?.exclusionCode, 'deterministic-exclusion')]
      : [];
    const deterministicExclusion = excluded
      ? deterministicExclusionsForVacancy[0]
      : null;
    const selectionReason = selectionReasons.get(vacancyId)
      || (selected ? code(candidate?.selectionReason, 'selected') : null);
    let reasonCode;
    if (deterministicExclusion) reasonCode = deterministicExclusion;
    else if (closed.has(vacancyId)) reasonCode = 'advert-closed';
    else if (skipped.has(vacancyId)) reasonCode = skipped.get(vacancyId);
    else if (selected && !assessed) reasonCode = 'assessment-failed';
    else if (selected) reasonCode = code(reviewedItem?.outcome, 'selected-assessed');
    else if (verificationScoped && wasSelected) reasonCode = 'verification-scope';
    else reasonCode = notSelected.get(vacancyId) || 'not-selected';
    const score = scoreOf(value);
    return {
      vacancy_id: vacancyId,
      company: labelOf(value, ['company', 'employer'], 'Unknown employer', 120),
      role: labelOf(value, ['role', 'title'], 'Unknown role', 160),
      dimensions: dimensionsOf(value),
      stages: {
        found: true,
        ranked: !excluded && (ranked.length > 0 || Boolean(selectionDecision)),
        selected,
        excluded,
        assessed,
      },
      above_threshold: !excluded && Number.isFinite(threshold) && score !== null
        ? score >= threshold
        : !excluded && reasonCode !== 'below-relevance-threshold',
      pre_rank: {
        score,
        positive: compactContributions(value, true),
        negative: compactContributions(value, false),
      },
      reason_code: reasonCode,
      selection_reason: selectionReason,
      deterministic_exclusion: deterministicExclusion,
      deterministic_exclusions: deterministicExclusionsForVacancy,
      assessment_status: assessed ? 'assessed' : selected ? 'assessment-failed' : 'not-selected',
      outcome: reviewedItem?.outcome ? code(reviewedItem.outcome) : null,
      tracker_outcome: reviewedItem?.trackerOutcome ? code(reviewedItem.trackerOutcome) : null,
      source: sourceOf(value),
      sourceUrl: canonicalUrl(value?.url ?? value?.canonicalUrl ?? value?.sourceUrl),
      sourceReferences: durableSourceReferences(value),
    };
  });
}

function exactCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`coverage funnel has invalid ${label}`);
  }
  return count;
}

function stageTotal(bySource, stage) {
  return Object.values(bySource).reduce((total, row) => total + Number(
    stage === 'sourceErrors' ? row.sourceErrors
      : stage === 'failedSourceRecords' ? row.failedRecords
        : row[stage],
  ), 0);
}

export function reconcileCoverageFunnel(funnel, explanations = []) {
  if (!funnel || typeof funnel !== 'object' || !funnel.bySource
    || RECONCILED_STAGES.some((stage) => !Number.isFinite(Number(funnel[stage])))) {
    return funnel;
  }
  const bySource = Object.fromEntries(Object.entries(funnel.bySource).map(([source, supplied]) => {
    const count = exactCount(supplied?.count, `${source}.count`);
    const failedRecords = exactCount(supplied?.failedRecords, `${source}.failedRecords`);
    const sourceErrors = exactCount(supplied?.sourceErrors, `${source}.sourceErrors`);
    if (failedRecords > count) throw new Error(`coverage funnel has more failed than source records for ${source}`);
    return [source, {
      count,
      failedRecords,
      sourceErrors,
      sourceRecords: count,
      parsed: count,
      normalised: count - failedRecords,
      duplicateObservations: 0,
      uniqueVacancies: 0,
      deterministicallyExcluded: 0,
      eligible: 0,
      ranked: 0,
      aboveThreshold: 0,
      selected: 0,
      assessed: 0,
      assessmentFailed: 0,
      added: 0,
      updated: 0,
      unchanged: 0,
      closed: 0,
    }];
  }));
  for (const item of explanations || []) {
    const source = item?.dimensions?.source ?? item?.source;
    const row = bySource[source];
    if (!row) throw new Error(`coverage funnel cannot attribute vacancy to source: ${source || 'unknown'}`);
    row.uniqueVacancies += 1;
    row.deterministicallyExcluded += Number(item?.stages?.excluded === true);
    row.eligible += Number(item?.stages?.excluded !== true);
    row.ranked += Number(item?.stages?.ranked === true);
    row.aboveThreshold += Number(item?.above_threshold === true);
    row.selected += Number(item?.stages?.selected === true);
    row.assessed += Number(item?.stages?.assessed === true);
    row.assessmentFailed += Number(item?.stages?.selected === true && item?.stages?.assessed !== true);
    row.added += Number(item?.tracker_outcome === 'added');
    row.updated += Number(item?.tracker_outcome === 'updated');
    row.unchanged += Number(item?.tracker_outcome === 'unchanged');
    row.closed += Number(item?.reason_code === 'advert-closed');
  }
  for (const [source, row] of Object.entries(bySource)) {
    row.duplicateObservations = row.normalised - row.uniqueVacancies;
    if (row.duplicateObservations < 0) {
      throw new Error(`coverage funnel has more unique vacancies than normalised records for ${source}`);
    }
  }
  for (const stage of RECONCILED_STAGES) {
    const expected = exactCount(funnel[stage], stage);
    const actual = stageTotal(bySource, stage);
    if (actual !== expected) {
      throw new Error(`coverage funnel ${stage} does not reconcile (${actual} != ${expected})`);
    }
  }
  return { ...funnel, bySource };
}

function rollupRows(explanations, valueOfDimension) {
  const rows = new Map();
  for (const explanation of explanations || []) {
    const value = text(valueOfDimension(explanation), 160) || 'unknown';
    const row = rows.get(value) || Object.fromEntries([
      ['value', value], ...ROLLUP_COUNTERS.map((counter) => [counter, 0]),
    ]);
    row.found += Number(explanation?.stages?.found === true);
    row.ranked += Number(explanation?.stages?.ranked === true);
    row.selected += Number(explanation?.stages?.selected === true);
    row.excluded += Number(explanation?.stages?.excluded === true);
    row.assessed += Number(explanation?.stages?.assessed === true);
    row.assessmentFailed += Number(
      explanation?.stages?.selected === true && explanation?.stages?.assessed !== true,
    );
    rows.set(value, row);
  }
  return [...rows.values()].sort((left, right) => (
    right.found - left.found || compareText(left.value, right.value)
  ));
}

export function buildCoverageRollups({
  explanations = [], provider = 'unknown-provider', runId = 'unknown-run',
  date = 'unknown-date', sourceHealth = {},
} = {}) {
  const failures = new Map();
  for (const item of explanations) {
    if (item?.stages?.assessed === true && item?.outcome === 'kept') continue;
    const reason = code(item?.reason_code, 'unknown-failure');
    failures.set(reason, (failures.get(reason) || 0) + 1);
  }
  for (const health of Object.values(sourceHealth || {})) {
    if (health?.configured === false || health?.status === 'healthy') continue;
    const reason = code(health?.reasonCode ?? health?.reason ?? health?.status, 'source-unavailable');
    failures.set(reason, (failures.get(reason) || 0) + 1);
  }
  return {
    schemaVersion: 1,
    source: rollupRows(explanations, (item) => item?.dimensions?.source),
    employer: rollupRows(explanations, (item) => item?.dimensions?.employer),
    lane: rollupRows(explanations, (item) => item?.dimensions?.lane),
    roleFamily: rollupRows(explanations, (item) => item?.dimensions?.role_family),
    location: rollupRows(explanations, (item) => item?.dimensions?.location),
    provider: rollupRows(explanations, () => provider),
    run: rollupRows(explanations, () => runId),
    date: rollupRows(explanations, () => date),
    failureReasons: [...failures.entries()].map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || compareText(left.value, right.value)),
  };
}
