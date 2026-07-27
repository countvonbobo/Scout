export function parseScanRuns(text) {
  const runs = [];
  const errors = [];
  for (const [index, raw] of String(text || '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      runs.push(JSON.parse(line));
    } catch (e) {
      errors.push({ line: index + 1, error: e.message });
    }
  }
  return { runs, errors };
}

function sourceKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function normaliseSourceHealth(run = {}) {
  const errors = Array.isArray(run.errors) ? run.errors.map(String) : [];
  const recorded = run.source_health || run.sourceHealth;
  if (recorded && typeof recorded === 'object' && !Array.isArray(recorded)) {
    return Object.entries(recorded).map(([name, value]) => ({
      name,
      status: ['healthy', 'degraded', 'unavailable'].includes(value?.status) ? value.status : 'degraded',
      count: Number.isFinite(Number(value?.count)) ? Number(value.count) : null,
      reason: value?.reason ? String(value.reason) : null,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const api = run.api_sources || run.apiSources || {};
  const entries = [];
  for (const [name, rawCount] of Object.entries(api)) {
    const count = Number.isFinite(Number(rawCount)) ? Number(rawCount) : null;
    const related = errors.filter((error) => sourceKey(error).includes(sourceKey(name)));
    const status = related.length ? (count > 0 ? 'degraded' : 'unavailable') : 'healthy';
    entries.push({ name, status, count, reason: related[0] || null });
  }
  const seen = new Set(entries.map((entry) => sourceKey(entry.name)));
  for (const name of run.sources_checked || run.sourcesChecked || []) {
    if (seen.has(sourceKey(name))) continue;
    const related = errors.filter((error) => sourceKey(error).includes(sourceKey(name)));
    entries.push({ name, status: related.length ? 'unavailable' : 'healthy', count: null, reason: related[0] || null });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function scanHealthFromText(text, today) {
  const parsed = parseScanRuns(text);
  const last = parsed.runs.at(-1) || null;
  if (!last) {
    return {
      lastRunAt: null,
      healthy: false,
      stale: true,
      degraded: false,
      reason: parsed.errors.length ? 'scan log contains invalid JSON' : 'no scan runs recorded yet',
      runs: 0,
      parseErrors: parsed.errors,
    };
  }

  const lastDate = String(last.timestamp || '').slice(0, 10);
  const stale = lastDate !== today;
  const runErrors = Array.isArray(last.errors) ? last.errors : [];
  const degraded = Boolean(last.search_degraded || last.degraded || last.degradation?.degraded);
  const healthy = !stale && !degraded && runErrors.length === 0 && parsed.errors.length === 0;
  let reason = null;
  if (stale) reason = `no run recorded for ${today}`;
  else if (degraded) reason = 'last scan was degraded';
  else if (runErrors.length) reason = runErrors.join('; ');
  else if (parsed.errors.length) reason = 'scan log contains invalid JSON';

  return {
    lastRunAt: last.timestamp || null,
    healthy,
    stale,
    degraded,
    reason,
    sourcesChecked: last.sources_checked || last.sourcesChecked || last.checked_sources || [],
    atsPortalsChecked: last.ats_portals_checked || last.atsPortalsChecked || 0,
    candidatesFound: last.candidates_found ?? last.candidatesFound ?? last.candidate_count ?? null,
    keepersAdded: last.keepers_added ?? last.keepersAdded ?? last.keeper_count ?? null,
    discarded: last.discarded || last.discarded_reasons || {},
    funnel: publicFunnel(last.funnel),
    reviewedAvailable: Array.isArray(last.reviewed) && last.reviewed.length > 0,
    errors: runErrors,
    sourceHealth: normaliseSourceHealth(last),
    runs: parsed.runs.length,
    parseErrors: parsed.errors,
  };
}

function publicFunnel(value) {
  if (!value || typeof value !== 'object') return null;
  const names = [
    'sourceRecords', 'sourceErrors', 'failedSourceRecords', 'uniqueVacancies',
    'deterministicallyExcluded', 'eligible', 'ranked', 'selected', 'assessed', 'assessmentFailed',
  ];
  return Object.fromEntries(names.filter((name) => Number.isFinite(Number(value[name]))).map((name) => [name, Number(value[name])]));
}
