const STAGES = Object.freeze([
  'sourceRecords', 'failedSourceRecords', 'parsed', 'normalised',
  'duplicateObservations', 'uniqueVacancies', 'deterministicallyExcluded',
  'eligible', 'ranked', 'aboveThreshold', 'selected', 'assessed',
  'assessmentFailed', 'added', 'updated', 'unchanged', 'closed',
]);
const SOURCE_DERIVED_STAGES = new Set(['sourceRecords', 'failedSourceRecords']);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function sourceCount(result) {
  return Number(result?.count ?? 0);
}

function failedRecordCount(result) {
  return Array.isArray(result?.errors) ? result.errors.length : 0;
}

export function createDiscoveryFunnel(sourceResults = {}) {
  const bySource = Object.fromEntries(Object.entries(sourceResults).map(([source, result]) => [source, {
    count: sourceCount(result),
    failedRecords: failedRecordCount(result),
  }]));
  const funnel = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  funnel.sourceRecords = Object.values(bySource).reduce((total, source) => total + source.count, 0);
  funnel.failedSourceRecords = Object.values(bySource).reduce((total, source) => total + source.failedRecords, 0);
  funnel.bySource = bySource;
  return freeze(funnel);
}

export function advanceDiscoveryFunnel(funnel, _stage, counts = {}) {
  const next = structuredClone(funnel);
  for (const key of STAGES) {
    if (!SOURCE_DERIVED_STAGES.has(key) && counts[key] !== undefined) next[key] = Number(counts[key]);
  }
  return freeze(next);
}

export function assertDiscoveryFunnel(value) {
  const sources = Object.values(value.bySource);
  const sourceRecords = sources.reduce((total, source) => total + Number(source.count), 0);
  const failedSourceRecords = sources.reduce((total, source) => total + Number(source.failedRecords), 0);
  if (value.sourceRecords !== sourceRecords || value.failedSourceRecords !== failedSourceRecords) {
    throw new Error('source record totals must equal the source-level counts');
  }
  if (value.parsed !== value.sourceRecords - value.failedSourceRecords) {
    throw new Error('parsed must equal source records minus failed source records');
  }
  if (value.normalised !== value.duplicateObservations + value.uniqueVacancies) {
    throw new Error('normalised must equal duplicate observations plus unique vacancies');
  }
  if (value.uniqueVacancies !== value.deterministicallyExcluded + value.eligible) {
    throw new Error('unique vacancies must equal excluded plus eligible');
  }
  if (value.ranked !== value.eligible) throw new Error('every eligible vacancy must be ranked');
  if (value.selected > value.aboveThreshold || value.assessed > value.selected) {
    throw new Error('assessment funnel is inconsistent');
  }
  return value;
}
