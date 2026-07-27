import { withSourceStatus } from './sourceHealth.mjs';
import crypto from 'node:crypto';
import { canonicaliseUrl } from './vacancyObservation.mjs';

const HOME_URL = 'https://hiringcafe.com/';

export const DEFAULT_HIRING_CAFE_QUERIES = [];

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function wait(ms, sleepFn) {
  if (ms > 0) await sleepFn(ms);
}

async function fetchWithRetry(url, fetchImpl, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 3));
  const sleepFn = options.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const baseDelayMs = Math.max(0, Number(options.baseDelayMs ?? 250));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (response?.ok || !retryableStatus(Number(response?.status || 0)) || attempt === attempts) {
        return { response, attempts: attempt };
      }
      lastError = new Error(`fetch failed ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await wait(baseDelayMs * attempt, sleepFn);
  }
  throw lastError || new Error('fetch failed');
}

async function loadBuildId(fetchImpl, options) {
  const { response, attempts } = await fetchWithRetry(HOME_URL, fetchImpl, options);
  if (!response?.ok) throw new Error(`homepage fetch failed ${response?.status || ''}`.trim());
  const buildId = extractBuildId(await response.text());
  if (!buildId) throw new Error('buildId not found in homepage (endpoint shape may have changed)');
  let origin = new URL(HOME_URL).origin;
  try { if (response.url) origin = new URL(response.url).origin; } catch { /* retain the canonical origin */ }
  return { buildId, attempts, origin };
}

function dataUrl(origin, buildId, state) {
  return `${origin}/_next/data/${buildId}/index.json?searchState=${state}`;
}

export function extractBuildId(html) {
  const m = String(html || '').match(/"buildId":"([^"]+)"/);
  return m ? m[1] : null;
}

export function buildSearchState(query, options = {}) {
  return {
    searchQuery: query,
    locations: options.location && typeof options.location === 'object' ? [options.location] : [],
  };
}

function salaryText(min, max, currency, locale = 'en-GB') {
  const fmt = (n) => Math.round(n).toLocaleString(locale);
  const cur = currency || '';
  if (min && max && min !== max) return `${cur} ${fmt(min)}-${fmt(max)}`.trim();
  if (min) return `${cur} ${fmt(min)}`.trim();
  return null;
}

function normalise(hit, options) {
  const v5 = hit.v5_processed_job_data || {};
  const description = [
    v5.requirements_summary || '', v5.job_category || '', (v5.role_activities || []).join(', '),
    v5.company_tagline || '', v5.company_sector_and_industry || '', (v5.company_activities || []).join(', '),
  ].filter(Boolean).join(' ');
  const providerId = String(hit.objectID || hit.id || hit.job_information?.id || '');
  return {
    providerId,
    sourceRecordId: providerId || (canonicaliseUrl(hit.apply_url) ? `url-${crypto.createHash('sha256').update(canonicaliseUrl(hit.apply_url)).digest('hex')}` : ''),
    title: hit.job_information?.title || '',
    company: v5.company_name || '',
    description,
    requirements: String(v5.requirements_summary || '').trim(),
    url: hit.apply_url || '',
    salary: salaryText(v5.yearly_min_compensation, v5.yearly_max_compensation, v5.listed_compensation_currency, options.locale),
    salaryMin: v5.yearly_min_compensation ?? null,
    salaryMax: v5.yearly_max_compensation ?? null,
    salaryCurrency: v5.listed_compensation_currency || null,
    salaryPeriod: 'year',
    salaryRateType: 'salary',
    location: v5.formatted_workplace_location || '',
    workingType: v5.workplace_type || '',
    postedDate: (v5.estimated_publish_date || '').slice(0, 10) || null,
    source: 'hiring_cafe',
    tags: [],
  };
}

export async function fetchHiringCafe(queries = DEFAULT_HIRING_CAFE_QUERIES, fetchImpl = globalThis.fetch, options = {}) {
  const jobs = [];
  const sources = {};
  const errors = [];
  const seen = new Set();
  if (!queries.length) return withSourceStatus({
    jobs, sources, errors, available: false, status: 'unavailable', count: 0,
    reason: 'no hiring.cafe queries configured', note: 'no hiring.cafe queries configured',
  });

  let buildId = null;
  let origin = new URL(HOME_URL).origin;
  let retryCount = 0;
  let recovered = false;
  try {
    const loaded = await loadBuildId(fetchImpl, options);
    buildId = loaded.buildId;
    origin = loaded.origin;
    retryCount += loaded.attempts - 1;
    recovered ||= loaded.attempts > 1;
  } catch (e) {
    return withSourceStatus({
      jobs: [], sources: {}, errors: [`hiring.cafe: ${e.message}`], available: false,
      status: 'unavailable', count: 0, reason: e.message,
    });
  }

  for (const query of queries) {
    try {
      const state = encodeURIComponent(JSON.stringify(buildSearchState(query, options)));
      let result = await fetchWithRetry(dataUrl(origin, buildId, state), fetchImpl, options);
      let refreshedBuild = false;
      retryCount += result.attempts - 1;
      recovered ||= result.attempts > 1;
      if (result.response?.status === 404) {
        const refreshed = await loadBuildId(fetchImpl, options);
        buildId = refreshed.buildId;
        origin = refreshed.origin;
        retryCount += refreshed.attempts;
        result = await fetchWithRetry(dataUrl(origin, buildId, state), fetchImpl, options);
        retryCount += result.attempts - 1;
        recovered = true;
        refreshedBuild = true;
      }
      let response = result.response;
      if (!response || !response.ok) throw new Error(`fetch failed ${response?.status || ''}`.trim());
      let data;
      try { data = await response.json(); }
      catch (error) {
        if (refreshedBuild) throw error;
        const refreshed = await loadBuildId(fetchImpl, options);
        buildId = refreshed.buildId;
        origin = refreshed.origin;
        retryCount += refreshed.attempts;
        result = await fetchWithRetry(dataUrl(origin, buildId, state), fetchImpl, options);
        retryCount += result.attempts - 1;
        response = result.response;
        if (!response || !response.ok) throw new Error(`fetch failed ${response?.status || ''}`.trim());
        data = await response.json();
        recovered = true;
        refreshedBuild = true;
      }
      if (!Array.isArray(data?.pageProps?.ssrHits) && !refreshedBuild) {
        const refreshed = await loadBuildId(fetchImpl, options);
        buildId = refreshed.buildId;
        origin = refreshed.origin;
        retryCount += refreshed.attempts;
        result = await fetchWithRetry(dataUrl(origin, buildId, state), fetchImpl, options);
        retryCount += result.attempts - 1;
        response = result.response;
        if (!response || !response.ok) throw new Error(`fetch failed ${response?.status || ''}`.trim());
        data = await response.json();
        recovered = true;
        refreshedBuild = true;
      }
      if (!Array.isArray(data?.pageProps?.ssrHits)) throw new Error('endpoint shape changed (ssrHits missing)');
      const hits = data.pageProps.ssrHits;
      let count = 0;
      for (const hit of hits) {
        if (hit.is_expired) continue;
        const job = normalise(hit, options);
        count += 1;
        const key = job.providerId || job.url || `${job.company.toLowerCase().trim()}|${job.title.toLowerCase().trim()}|${job.location.toLowerCase().trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        jobs.push(job);
      }
      sources[query] = count;
    } catch (e) {
      sources[query] = 0;
      errors.push(`hiring.cafe "${query}": ${e.message}`);
    }
  }
  return withSourceStatus({
    jobs, sources, errors, available: true,
    recovery: { recovered, retries: retryCount },
    reason: errors.length ? `${errors.length} of ${queries.length} queries failed` : null,
  });
}
