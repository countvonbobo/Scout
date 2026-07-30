import { fetchPortal } from './ats.mjs';

const MAX_PAGE_BYTES = 1_000_000;
const MAX_PAGE_JOBS = 100;

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
    const url = new URL(String(value), base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
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
  if (Array.isArray(value)) return value.flatMap(postingObjects);
  if (!value || typeof value !== 'object') return [];
  const type = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  const self = type.includes('JobPosting') ? [value] : [];
  return [...self, ...postingObjects(value['@graph'])];
}

export function parseJobPostingData(html, {
  pageUrl,
  employerName,
  employerId = null,
} = {}) {
  const postings = [];
  const scripts = String(html || '').matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const match of scripts) {
    let value;
    try { value = JSON.parse(match[1]); } catch { continue; }
    for (const posting of postingObjects(value)) {
      const title = text(posting.title, 240);
      const url = safeUrl(posting.url, pageUrl);
      if (!title || !url) continue;
      const company = text(posting.hiringOrganization?.name, 240)
        || text(employerName, 240);
      postings.push({
        providerId: text(posting.identifier?.value || posting.identifier || url, 300),
        sourceRecordId: `careers-structured:${text(posting.identifier?.value || posting.identifier || url, 300)}`,
        title,
        company,
        description: stripHtml(posting.description),
        url,
        location: addressText(posting.jobLocation),
        employmentType: text(Array.isArray(posting.employmentType)
          ? posting.employmentType.join(', ') : posting.employmentType, 120),
        postedDate: /^\d{4}-\d{2}-\d{2}/.test(String(posting.datePosted || ''))
          ? String(posting.datePosted).slice(0, 10) : null,
        source: 'careers-structured',
        ...(employerId ? { employerId } : {}),
      });
      if (postings.length >= MAX_PAGE_JOBS) return postings;
    }
  }
  return postings;
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

async function collectBoard(employer, fetchImpl, checkedAt) {
  if (employer.access.terms === 'disallowed') {
    return result(employer, employer.board.adapter, 'blocked', checkedAt, {
      failureCode: 'terms-disallowed',
    });
  }
  try {
    const jobs = (await fetchPortal({
      name: employer.canonicalName,
      ats: employer.board.adapter,
      token: employer.board.boardId,
      careersUrl: employer.careersUrl || '',
      enabled: true,
      tags: employer.industries,
    }, fetchImpl)).map((job) => ({ ...job, employerId: employer.id }));
    return result(employer, employer.board.adapter, 'healthy', checkedAt, { jobs });
  } catch {
    return result(employer, employer.board.adapter, 'degraded', checkedAt, {
      failureCode: 'request-failed',
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

async function collectCareersPage(employer, fetchImpl, checkedAt) {
  const policyFailure = careersPolicyFailure(employer, checkedAt);
  if (policyFailure) return policyFailure;
  if (!employer.careersUrl) {
    return result(employer, 'structured-data', 'unsupported', checkedAt, {
      failureCode: 'careers-url-missing',
    });
  }
  let response;
  try {
    response = await fetchImpl(employer.careersUrl, {
      headers: { accept: 'text/html, application/xhtml+xml' },
      redirect: 'follow',
    });
  } catch {
    return result(employer, 'structured-data', 'degraded', checkedAt, {
      failureCode: 'request-failed',
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
  const postings = parseJobPostingData(html, {
    pageUrl: employer.careersUrl,
    employerName: employer.canonicalName,
    employerId: employer.id,
  });
  if (postings.length) {
    return result(employer, 'structured-data', 'healthy', checkedAt, { jobs: postings });
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
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  const checkedAt = now();
  if (employer?.board) return collectBoard(employer, fetchImpl, checkedAt);
  return collectCareersPage(employer, fetchImpl, checkedAt);
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
