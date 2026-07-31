import { fetchPortal } from './ats.mjs';
import {
  fetchPublicResource, PublicHttpError, publicUrl, resolvePublicDestination,
} from './publicHttp.mjs';

const MAX_PAGE_BYTES = 1_000_000;
const MAX_PAGE_JOBS = 100;
const MAX_JSON_LD_DEPTH = 32;
const MAX_JSON_LD_NODES = 2_000;

function text(value, maximum = 4000) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function stripHtml(value, maximum = 4000) {
  return text(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'"), maximum);
}

function safeUrl(value, base) {
  if (!value) return null;
  try {
    const result = publicUrl(String(value), base).toString();
    return result.length <= 4_096 ? result : null;
  } catch {
    return null;
  }
}

function postingDate(value, { endOfDay = false } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const source = String(value);
  if (source.length > 40 || !(
    /^\d{4}-\d{2}-\d{2}$/.test(source)
    || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(source)
  )) return undefined;
  const [year, month, day] = source.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year
    || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day) return undefined;
  const parsed = new Date(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(source)
    ? `${source}T23:59:59.999Z` : source);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function addressText(value) {
  const address = Array.isArray(value) ? value[0]?.address : value?.address;
  if (!address || typeof address !== 'object') return '';
  return [
    address.addressLocality,
    address.addressRegion,
    typeof address.addressCountry === 'object'
      ? address.addressCountry.name : address.addressCountry,
  ].map((part) => text(part, 120)).filter(Boolean).join(', ');
}

function postingObjects(value) {
  const postings = [];
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    visited += 1;
    if (visited > MAX_JSON_LD_NODES || current.depth > MAX_JSON_LD_DEPTH) {
      const error = new Error('structured data exceeds traversal limits');
      error.code = 'structured-data-too-complex';
      throw error;
    }
    if (Array.isArray(current.value)) {
      if (visited + pending.length + current.value.length > MAX_JSON_LD_NODES) {
        const error = new Error('structured data exceeds traversal limits');
        error.code = 'structured-data-too-complex';
        throw error;
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    const type = Array.isArray(current.value['@type'])
      ? current.value['@type']
      : [current.value['@type']];
    if (type.includes('JobPosting')) postings.push(current.value);
    if (current.value['@graph'] !== undefined) {
      pending.push({ value: current.value['@graph'], depth: current.depth + 1 });
    }
  }
  return postings;
}

function parseJobPostingRecords(html, {
  pageUrl,
  employerName,
  employerId = null,
  now = () => new Date(),
} = {}) {
  const postings = [];
  let found = 0;
  let invalid = 0;
  let stale = 0;
  const scripts = String(html || '').matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const match of scripts) {
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    let records;
    try { records = postingObjects(value); } catch (error) {
      if (error?.code === 'structured-data-too-complex') {
        return {
          postings, found, invalid, stale, failureCode: 'structured-data-too-complex',
        };
      }
      throw error;
    }
    for (const posting of records) {
      found += 1;
      const rawTitle = text(posting.title, 4_000);
      const title = rawTitle.length <= 240 ? rawTitle : '';
      const url = safeUrl(posting.url, pageUrl);
      const posted = postingDate(posting.datePosted);
      const validThrough = postingDate(posting.validThrough, { endOfDay: true });
      const rawCompany = text(posting.hiringOrganization?.name || employerName, 4_000);
      const company = rawCompany.length <= 240 ? rawCompany : '';
      if (!title || !url || !company || posted === undefined || validThrough === undefined) {
        invalid += 1;
        continue;
      }
      const clock = now();
      const currentTime = clock instanceof Date ? clock : new Date(clock);
      if (validThrough && validThrough.getTime() < currentTime.getTime()) {
        stale += 1;
        continue;
      }
      const candidate = {
        providerId: text(posting.identifier?.value || posting.identifier || url, 300),
        sourceRecordId: `careers-structured:${text(posting.identifier?.value || posting.identifier || url, 300)}`,
        title,
        company,
        description: stripHtml(posting.description),
        url,
        location: addressText(posting.jobLocation),
        employmentType: text(Array.isArray(posting.employmentType)
          ? posting.employmentType.join(', ') : posting.employmentType, 120),
        postedDate: posted ? String(posting.datePosted).slice(0, 10) : null,
        validThrough: validThrough ? validThrough.toISOString() : null,
        source: 'careers-structured',
        ...(employerId ? { employerId } : {}),
      };
      if (postings.length < MAX_PAGE_JOBS) postings.push(candidate);
    }
  }
  return {
    postings,
    found,
    invalid,
    stale,
    capacityExceeded: found - invalid - stale > postings.length,
  };
}

export function parseJobPostingData(html, options = {}) {
  return parseJobPostingRecords(html, options).postings;
}

function genericLinks(html, {
  pageUrl,
  employerName,
  employerId,
} = {}) {
  const page = new URL(pageUrl);
  const jobs = [];
  const seen = new Set();
  const anchors = String(html || '').matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  );
  for (const match of anchors) {
    const label = stripHtml(match[2], 240);
    const url = safeUrl(match[1], pageUrl);
    if (!url) continue;
    const parsed = new URL(url);
    if (parsed.origin !== page.origin) continue;
    if (!/(?:job|career|vacan|position|opening|role|apply)/i.test(`${label} ${parsed.pathname}`)) continue;
    if (!label || seen.has(url)) continue;
    seen.add(url);
    jobs.push({
      providerId: url,
      sourceRecordId: `careers-generic:${url}`,
      title: label,
      company: employerName,
      description: '',
      url,
      location: '',
      employmentType: '',
      postedDate: null,
      source: 'careers-generic',
      employerId,
    });
    if (jobs.length >= MAX_PAGE_JOBS) break;
  }
  return jobs;
}

function result(employer, adapter, status, checkedAt, {
  jobs = [],
  returned = jobs.length,
  parsed = jobs.length,
  failureCode,
} = {}) {
  return {
    employerId: employer.id,
    adapter,
    status,
    returned,
    parsed,
    ...(failureCode ? { failureCode } : {}),
    jobs,
    checkedAt,
  };
}

function careersPolicyFailure(employer, checkedAt) {
  if (employer.access.terms === 'disallowed') {
    return result(employer, 'structured-data', 'blocked', checkedAt, {
      failureCode: 'terms-disallowed',
    });
  }
  if (employer.access.terms !== 'allowed') {
    return result(employer, 'structured-data', 'blocked', checkedAt, {
      failureCode: 'terms-unreviewed',
    });
  }
  if (employer.access.robots === 'disallowed') {
    return result(employer, 'structured-data', 'blocked', checkedAt, {
      failureCode: 'robots-disallowed',
    });
  }
  if (employer.access.robots !== 'allowed') {
    return result(employer, 'structured-data', 'blocked', checkedAt, {
      failureCode: 'robots-unreviewed',
    });
  }
  return null;
}

function publicFailureCode(error) {
  if (!(error instanceof PublicHttpError)) return 'request-failed';
  if (['unsafe-destination', 'url-invalid'].includes(error.reasonCode)) return 'unsafe-destination';
  if (error.reasonCode === 'external-redirect') return 'external-redirect';
  if (error.reasonCode === 'response-too-large') return 'response-too-large';
  if (error.reasonCode === 'content-type-invalid') return 'content-type-invalid';
  if (error.reasonCode === 'request-timeout') return 'request-timeout';
  if (error.reasonCode === 'dns-failed') return 'dns-failed';
  return 'request-failed';
}

async function publicJobs(jobs, { lookupFn }) {
  const accepted = [];
  for (const job of jobs.slice(0, MAX_PAGE_JOBS)) {
    try {
      await resolvePublicDestination(job.url, { lookupFn });
      accepted.push(job);
    } catch { /* unsafe advert URLs are not published */ }
  }
  return accepted;
}

async function collectBoard(employer, fetchImpl, checkedAt, { lookupFn }) {
  if (employer.access.terms === 'disallowed') {
    return result(employer, employer.board.adapter, 'blocked', checkedAt, {
      failureCode: 'terms-disallowed',
    });
  }
  try {
    const boardFetch = (url, options = {}) => fetchPublicResource(url, {
      ...options,
      lookupFn,
      requestImpl: fetchImpl,
      maxBytes: MAX_PAGE_BYTES,
      maxRedirects: 4,
      allowedContentTypes: ['application/json', 'application/*+json'],
    });
    const returnedJobs = (await fetchPortal({
      name: employer.canonicalName,
      ats: employer.board.adapter,
      token: employer.board.boardId,
      careersUrl: employer.careersUrl || '',
      enabled: true,
      tags: employer.industries,
    }, boardFetch)).map((job) => ({ ...job, employerId: employer.id }));
    const jobs = await publicJobs(returnedJobs, { lookupFn });
    const unsafeOnly = returnedJobs.length && !jobs.length;
    return result(employer, employer.board.adapter, unsafeOnly ? 'blocked' : 'healthy', checkedAt, {
      jobs,
      returned: returnedJobs.length,
      parsed: jobs.length,
      ...(unsafeOnly ? { failureCode: 'unsafe-advert-url' } : {}),
    });
  } catch (error) {
    return result(employer, employer.board.adapter, 'degraded', checkedAt, {
      failureCode: publicFailureCode(error),
    });
  }
}

function responseFailure(employer, checkedAt, status) {
  if ([401, 403].includes(status)) {
    return result(employer, 'structured-data', 'blocked', checkedAt, {
      failureCode: 'authentication-required',
    });
  }
  if (status === 429) {
    return result(employer, 'structured-data', 'degraded', checkedAt, {
      failureCode: 'rate-limited',
    });
  }
  return result(employer, 'structured-data', 'degraded', checkedAt, {
    failureCode: 'http-failed',
  });
}

async function collectCareersPage(employer, fetchImpl, checkedAt, {
  lookupFn,
  now,
}) {
  const policyFailure = careersPolicyFailure(employer, checkedAt);
  if (policyFailure) return policyFailure;
  if (!employer.careersUrl) {
    return result(employer, 'structured-data', 'unsupported', checkedAt, {
      failureCode: 'careers-url-missing',
    });
  }
  let response;
  try {
    response = await fetchPublicResource(employer.careersUrl, {
      headers: { accept: 'text/html, application/xhtml+xml' },
      lookupFn,
      requestImpl: fetchImpl,
      maxBytes: MAX_PAGE_BYTES,
      maxRedirects: 4,
      allowedOrigin: employer.careersUrl,
      allowedContentTypes: ['text/html', 'application/xhtml+xml'],
    });
  } catch (error) {
    const failureCode = publicFailureCode(error);
    return result(employer, 'structured-data',
      ['unsafe-destination', 'external-redirect'].includes(failureCode) ? 'blocked' : 'degraded',
      checkedAt, {
        failureCode,
      });
  }
  if (!response?.ok) return responseFailure(employer, checkedAt, Number(response?.status || 0));
  if (response.url) {
    const requestedOrigin = new URL(employer.careersUrl).origin;
    const finalUrl = safeUrl(response.url, employer.careersUrl);
    if (!finalUrl || new URL(finalUrl).origin !== requestedOrigin) {
      return result(employer, 'structured-data', 'blocked', checkedAt, {
        failureCode: 'external-redirect',
      });
    }
  }
  let html;
  try { html = await response.text(); } catch {
    return result(employer, 'structured-data', 'degraded', checkedAt, {
      failureCode: 'response-unreadable',
    });
  }
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) {
    return result(employer, 'structured-data', 'degraded', checkedAt, {
      failureCode: 'response-too-large',
    });
  }
  if (/(?:captcha|checking your browser|access denied|cloudflare challenge)/i.test(html)) {
    return result(employer, 'structured-data', 'blocked', checkedAt, {
      failureCode: 'anti-bot',
    });
  }
  const structured = parseJobPostingRecords(html, {
    pageUrl: employer.careersUrl,
    employerName: employer.canonicalName,
    employerId: employer.id,
    now,
  });
  if (structured.failureCode) {
    return result(employer, 'structured-data', 'degraded', checkedAt, {
      failureCode: structured.failureCode,
    });
  }
  const postings = await publicJobs(structured.postings, { lookupFn });
  if (postings.length) {
    return result(
      employer,
      'structured-data',
      structured.capacityExceeded ? 'degraded' : 'healthy',
      checkedAt,
      {
        jobs: postings,
        returned: structured.found,
        parsed: postings.length,
        ...(structured.capacityExceeded ? { failureCode: 'structured-data-capacity' } : {}),
      },
    );
  }
  if (structured.found) {
    return result(employer, 'structured-data',
      structured.stale === structured.found
        ? 'healthy' : 'degraded',
      checkedAt, {
        returned: structured.found,
        parsed: 0,
        failureCode: structured.stale === structured.found
          ? 'structured-data-stale' : 'structured-data-invalid',
      });
  }
  if (!employer.access.genericEnabled) {
    return result(employer, 'structured-data', 'unsupported', checkedAt, {
      failureCode: 'structured-data-missing',
    });
  }
  const visible = stripHtml(html, 1000);
  if (!visible && /<script\b[^>]*src=/i.test(html)) {
    return result(employer, 'generic', 'unsupported', checkedAt, {
      failureCode: 'javascript-required',
    });
  }
  const jobs = genericLinks(html, {
    pageUrl: employer.careersUrl,
    employerName: employer.canonicalName,
    employerId: employer.id,
  });
  return result(employer, 'generic', 'healthy', checkedAt, { jobs });
}

export async function collectEmployer(employer, {
  fetchImpl = null,
  now = () => new Date().toISOString(),
  lookupFn,
} = {}) {
  const checkedAt = now();
  if (employer?.board) return collectBoard(employer, fetchImpl, checkedAt, { lookupFn });
  return collectCareersPage(employer, fetchImpl, checkedAt, { lookupFn, now });
}

export async function collectEmployers(employers, options = {}) {
  if (!Array.isArray(employers) || employers.length > 32) {
    throw new TypeError('employer monitoring targets must be bounded');
  }
  const results = [];
  for (const employer of employers) results.push(await collectEmployer(employer, options));
  return {
    jobs: results.flatMap(({ jobs }) => jobs),
    checks: results.map(({ jobs, checkedAt, ...check }) => check),
    results,
  };
}
