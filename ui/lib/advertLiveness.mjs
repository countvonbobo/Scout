// Job boards and aggregator indexes keep serving adverts after the employer
// has closed them, so a scan can score, report and rank a role that no longer
// exists. Checking before the assessment turn removes those candidates from the
// prompt entirely, which costs no provider tokens and saves the ones a dead
// advert would have consumed.
//
// The check is deliberately conservative: only clear evidence closes an advert.
// A timeout, DNS failure, block page or unexpected status is `unverified` and
// the candidate is kept, because an offline host must never mass-close a
// tracker.
import { fetchPublicResource, PublicHttpError } from './publicHttp.mjs';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_BUDGET_MS = 90_000;
const DEFAULT_HOST_DELAY_MS = 250;
const MAX_BODY_CHARS = 200_000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Phrases boards use on a closed advert that still returns HTTP 200.
const CLOSED_PHRASES = [
  'no longer accepting applications',
  'no longer available',
  'no longer active',
  'this job is closed',
  'this position is closed',
  'position has been filled',
  'this role has been filled',
  'job posting has expired',
  'this listing has expired',
  'applications are closed',
  'vacancy is closed',
  'we are no longer hiring for this',
];

// A redirect that lands on a board's generic index rather than an advert.
const GENERIC_INDEX_PATHS = new Set([
  '', '/', '/jobs', '/jobs/', '/careers', '/careers/', '/search', '/search/',
  '/vacancies', '/vacancies/', '/positions', '/positions/', '/opportunities', '/opportunities/',
]);

export function isGenericIndexUrl(value) {
  try {
    const path = new URL(value).pathname.toLowerCase();
    if (GENERIC_INDEX_PATHS.has(path)) return true;
    const last = path.replace(/\/+$/, '').split('/').at(-1) || '';
    return /^(?:jobs-in-[a-z0-9-]+|open-(?:jobs|positions|roles|vacancies))$/.test(last);
  } catch {
    return false;
  }
}

export function classifyStatus(status) {
  if (status === 404 || status === 410) return 'gone';
  if (status >= 200 && status < 300) return 'live';
  // 401/403/429 and 5xx say nothing about the advert itself.
  return 'unverified';
}

export function looksClosed(text) {
  const value = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  return CLOSED_PHRASES.some((phrase) => value.includes(phrase));
}

export function redirectedToIndex(requestedUrl, finalUrl) {
  if (!finalUrl || finalUrl === requestedUrl) return false;
  try {
    const requested = new URL(requestedUrl);
    const landed = new URL(finalUrl);
    if (landed.host !== requested.host) return false;
    if (!isGenericIndexUrl(landed.href)) return false;
    // Only meaningful when the request actually asked for a specific advert.
    return !isGenericIndexUrl(requested.href);
  } catch { return false; }
}

function publicFailureReason(error) {
  if (!(error instanceof PublicHttpError)) return 'request failed';
  if (error.reasonCode === 'request-timeout') return 'timed out';
  if (['unsafe-destination', 'url-invalid'].includes(error.reasonCode)) {
    return 'destination is not public';
  }
  if (error.reasonCode === 'dns-failed') return 'destination could not be verified';
  if (error.reasonCode === 'response-too-large') return 'response was too large';
  if (error.reasonCode === 'content-type-invalid') return 'response was not an advert page';
  if (error.reasonCode === 'redirect-limit') return 'too many redirects';
  return 'request failed';
}

export async function checkAdvert(url, {
  fetchFn = null, lookupFn, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now(),
} = {}) {
  const headers = { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
  const checkedAt = new Date(now()).toISOString();
  if (isGenericIndexUrl(url)) {
    return { url, state: 'gone', reason: 'URL is a job-board index, not an individual advert', checkedAt };
  }
  let head;
  try {
    head = await fetchPublicResource(url, {
      method: 'HEAD', headers, timeoutMs, lookupFn, requestImpl: fetchFn,
      maxBytes: 1_024, maxRedirects: 4,
    });
  } catch {
    head = null;
  }
  if (head) {
    const state = classifyStatus(head.status);
    if (state === 'gone') return { url, state, reason: `HTTP ${head.status}`, checkedAt };
    if (state === 'live' && redirectedToIndex(url, head.url)) {
      return { url, state: 'gone', reason: 'redirected to the board index', checkedAt };
    }
  }
  // HEAD is widely unsupported or lies, and a 200 can still be a closed advert,
  // so confirm with a GET whenever HEAD did not prove the advert is gone.
  let response;
  try {
    response = await fetchPublicResource(url, {
      method: 'GET', headers, timeoutMs, lookupFn, requestImpl: fetchFn,
      maxBytes: MAX_BODY_CHARS, maxRedirects: 4,
      allowedContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain'],
    });
  } catch (error) {
    return {
      url, state: 'unverified', reason: publicFailureReason(error), checkedAt,
    };
  }
  const state = classifyStatus(response.status);
  if (state !== 'live') {
    return { url, state, reason: `HTTP ${response.status}`, checkedAt };
  }
  if (redirectedToIndex(url, response.url)) {
    return { url, state: 'gone', reason: 'redirected to the board index', checkedAt };
  }
  let body = '';
  try { body = await response.text(); }
  catch { return { url, state: 'unverified', reason: 'response body could not be read', checkedAt }; }
  if (looksClosed(body)) return { url, state: 'gone', reason: 'advert says it is closed', checkedAt };
  return { url, state: 'live', reason: null, checkedAt };
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// Checks many adverts under a bounded concurrency, a per-host delay and a hard
// overall budget. Anything not reached before the budget expires is
// `unverified`, so a slow board delays a scan by a known amount instead of
// stalling it.
export async function checkAdverts(urls, {
  fetchFn = null, lookupFn, timeoutMs = DEFAULT_TIMEOUT_MS, concurrency = DEFAULT_CONCURRENCY,
  budgetMs = DEFAULT_BUDGET_MS, hostDelayMs = DEFAULT_HOST_DELAY_MS, now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const unique = [...new Set((urls || []).filter(Boolean))];
  const startedAt = now();
  const lastRequestByHost = new Map();
  const results = await runWithConcurrency(unique, concurrency, async (url) => {
    if (now() - startedAt >= budgetMs) {
      return { url, state: 'unverified', reason: 'liveness budget exhausted', checkedAt: new Date(now()).toISOString() };
    }
    let host = '';
    try { host = new URL(url).host; } catch { /* checkAdvert reports the failure */ }
    if (host && hostDelayMs > 0) {
      const wait = (lastRequestByHost.get(host) || 0) + hostDelayMs - now();
      if (wait > 0) await sleep(wait);
      lastRequestByHost.set(host, now());
    }
    return checkAdvert(url, {
      fetchFn, lookupFn, timeoutMs, now,
    });
  });
  return new Map(results.map((result) => [result.url, result]));
}

// Splits candidates using their primary advert URL. Only a definite `gone`
// removes a candidate.
export async function partitionLiveCandidates(candidates, options = {}) {
  const list = candidates || [];
  const checks = await checkAdverts(list.map((candidate) => candidate.url), options);
  const live = [];
  const removed = [];
  for (const candidate of list) {
    const result = checks.get(candidate.url);
    if (result?.state === 'gone') removed.push({ ...candidate, liveness: result });
    else live.push(candidate);
  }
  return {
    live,
    removed,
    summary: {
      checked: checks.size,
      gone: removed.length,
      unverified: [...checks.values()].filter((result) => result.state === 'unverified').length,
    },
  };
}
