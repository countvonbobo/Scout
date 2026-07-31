import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectEmployer, collectEmployers, parseJobPostingData,
} from './careersAdapters.mjs';
import { createEmployerRegistry } from './employerRegistry.mjs';

const AT = '2026-07-30T12:00:00.000Z';
const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];

function response(body, { status = 200, type = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? type : null },
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function employer(overrides = {}) {
  return createEmployerRegistry([{
    canonicalName: 'Example Systems',
    careersUrl: 'https://careers.example.test/jobs',
    origin: { kind: 'manual', recordedAt: AT, reference: 'test' },
    access: {
      terms: 'allowed',
      robots: 'allowed',
      genericEnabled: false,
      minIntervalMinutes: 60,
    },
    ...overrides,
  }], { now: () => AT }).employers[0];
}

test('public ATS adapters share one bounded employer-monitoring result contract', async () => {
  for (const [adapter, boardId, payload] of [
    ['greenhouse', 'example-greenhouse', {
      jobs: [{
        id: 1, title: 'Research coordinator', content: '<p>Coordinate research</p>',
        absolute_url: 'https://boards.example.test/jobs/1',
        location: { name: 'Remote' }, updated_at: '2026-07-29T10:00:00Z',
      }],
    }],
    ['lever', 'example-lever', [{
      id: 'two', text: 'Operations lead', descriptionPlain: 'Lead operations',
      hostedUrl: 'https://jobs.example.test/two',
      categories: { location: 'London', commitment: 'Full-time' },
    }]],
    ['ashby', 'example-ashby', {
      jobs: [{
        id: 'three', title: 'Service manager', descriptionPlain: 'Manage services',
        jobUrl: 'https://jobs.example.test/three', location: 'Leeds',
      }],
    }],
  ]) {
    const target = employer({ board: { adapter, boardId } });
    const result = await collectEmployer(target, {
      fetchImpl: async () => response(payload),
      lookupFn: publicLookup,
      now: () => AT,
    });
    assert.deepEqual(Object.keys(result).sort(), [
      'adapter', 'checkedAt', 'employerId', 'jobs', 'parsed', 'returned', 'status',
    ]);
    assert.equal(result.adapter, adapter);
    assert.equal(result.status, 'healthy');
    assert.equal(result.returned, 1);
    assert.equal(result.parsed, 1);
    assert.equal(result.jobs[0].employerId, target.id);
  }
});

test('validated JobPosting JSON-LD becomes a structured careers result', async () => {
  const html = `<!doctype html><html><head>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Programme manager',
      description: '<p>Lead a public programme.</p>',
      url: 'https://careers.example.test/jobs/programme-manager',
      datePosted: '2026-07-29',
      employmentType: 'FULL_TIME',
      jobLocation: { address: { addressLocality: 'Manchester' } },
      hiringOrganization: { name: 'Example Systems' },
    })}</script>
  </head><body>Careers</body></html>`;
  const target = employer();
  const result = await collectEmployer(target, {
    fetchImpl: async () => response(html, { type: 'text/html' }),
    lookupFn: publicLookup,
    now: () => AT,
  });

  assert.equal(result.adapter, 'structured-data');
  assert.equal(result.status, 'healthy');
  assert.equal(result.returned, 1);
  assert.equal(result.parsed, 1);
  assert.equal(result.jobs[0].title, 'Programme manager');
  assert.equal(result.jobs[0].location, 'Manchester');
  assert.equal(result.jobs[0].description, 'Lead a public programme.');
});

test('JobPosting parsing rejects malformed and unsafe objects without guessing', () => {
  assert.deepEqual(parseJobPostingData('<script type="application/ld+json">{bad</script>', {
    pageUrl: 'https://example.test/careers', employerName: 'Example',
  }), []);
  assert.deepEqual(parseJobPostingData(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Unsafe', url: 'file:///private/role',
  })}</script>`, {
    pageUrl: 'https://example.test/careers', employerName: 'Example',
  }), []);
  assert.deepEqual(parseJobPostingData(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', title: 'Internal', url: 'http://127.0.0.1/admin',
    hiringOrganization: { name: 'Example' },
  })}</script>`, {
    pageUrl: 'https://example.test/careers', employerName: 'Example',
  }), []);
});

test('expired and malformed structured adverts are stale evidence, not current vacancies', async () => {
  for (const [posting, failureCode] of [
    [{
      '@type': 'JobPosting',
      title: 'Expired role',
      url: 'https://careers.example.test/jobs/expired',
      hiringOrganization: { name: 'Example Systems' },
      validThrough: '2026-07-29',
    }, 'structured-data-stale'],
    [{
      '@type': 'JobPosting',
      title: 'Malformed date',
      url: 'https://careers.example.test/jobs/malformed',
      hiringOrganization: { name: 'Example Systems' },
      datePosted: 'yesterday',
    }, 'structured-data-invalid'],
    [{
      '@type': 'JobPosting',
      title: 'Impossible date',
      url: 'https://careers.example.test/jobs/impossible-date',
      hiringOrganization: { name: 'Example Systems' },
      datePosted: '2026-02-30',
    }, 'structured-data-invalid'],
    [{
      '@type': 'JobPosting',
      title: '',
      url: 'https://careers.example.test/jobs/minimal',
    }, 'structured-data-invalid'],
  ]) {
    const result = await collectEmployer(employer(), {
      fetchImpl: async () => response(
        `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
        { type: 'text/html' },
      ),
      lookupFn: publicLookup,
      now: () => AT,
    });
    assert.equal(result.jobs.length, 0);
    assert.equal(result.failureCode, failureCode);
    assert.equal(result.parsed, 0);
  }
});

test('a legitimate JobPosting without validThrough remains current when its fields validate', async () => {
  const posting = {
    '@type': 'JobPosting',
    title: 'Open role',
    url: 'https://careers.example.test/jobs/open',
    hiringOrganization: { name: 'Example Systems' },
    datePosted: '2026-07-20T09:00:00Z',
  };
  const result = await collectEmployer(employer(), {
    fetchImpl: async () => response(
      `<script type="application/ld+json">${JSON.stringify(posting)}</script>`,
      { type: 'text/html' },
    ),
    lookupFn: publicLookup,
    now: () => AT,
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].validThrough, null);
});

test('hostname and redirect validation blocks private careers and structured advert targets', async () => {
  let requests = 0;
  const privateCareers = await collectEmployer(employer(), {
    fetchImpl: async () => { requests += 1; return response('', { type: 'text/html' }); },
    lookupFn: async () => [{ address: '10.0.0.7', family: 4 }],
    now: () => AT,
  });
  assert.equal(privateCareers.status, 'blocked');
  assert.equal(privateCareers.failureCode, 'unsafe-destination');
  assert.equal(requests, 0);

  const privateAdvert = await collectEmployer(employer(), {
    fetchImpl: async (url) => response(
      `<script type="application/ld+json">${JSON.stringify({
        '@type': 'JobPosting',
        title: 'Internal advert',
        url: 'https://internal.example.test/jobs/1',
        hiringOrganization: { name: 'Example Systems' },
      })}</script>`,
      { type: 'text/html' },
    ),
    lookupFn: async (hostname) => [{
      address: hostname === 'internal.example.test' ? '192.168.1.9' : '1.1.1.1',
      family: 4,
    }],
    now: () => AT,
  });
  assert.equal(privateAdvert.jobs.length, 0);
  assert.equal(privateAdvert.failureCode, 'structured-data-invalid');
});

test('generic monitoring is opt-in, same-site and bounded', async () => {
  const target = employer({
    access: {
      terms: 'allowed', robots: 'allowed', genericEnabled: true, minIntervalMinutes: 60,
    },
  });
  const html = `<html><body>
    <a href="/jobs/operations-lead">Operations lead vacancy</a>
    <a href="https://external.example/jobs/other">External vacancy</a>
    <a href="/about">About us</a>
  </body></html>`;
  const result = await collectEmployer(target, {
    fetchImpl: async () => response(html, { type: 'text/html' }),
    lookupFn: publicLookup,
    now: () => AT,
  });

  assert.equal(result.adapter, 'generic');
  assert.equal(result.status, 'healthy');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].url, 'https://careers.example.test/jobs/operations-lead');
});

test('generic monitoring reports capacity overflow instead of silently truncating links', async () => {
  const target = employer({
    access: {
      terms: 'allowed', robots: 'allowed', genericEnabled: true, minIntervalMinutes: 60,
    },
  });
  const links = Array.from(
    { length: 101 },
    (_, index) => `<a href="/jobs/capacity-${index + 1}">Capacity role ${index + 1}</a>`,
  ).join('\n');
  const result = await collectEmployer(target, {
    fetchImpl: async () => response(`<html><body>${links}</body></html>`, { type: 'text/html' }),
    lookupFn: publicLookup,
    now: () => AT,
  });

  assert.equal(result.status, 'degraded');
  assert.equal(result.failureCode, 'generic-capacity');
  assert.equal(result.returned, 101);
  assert.equal(result.parsed, 100);
  assert.equal(result.jobs.length, 100);
});

test('generic monitoring fingerprints query-bearing provider identities before persistence', async () => {
  const target = employer({
    access: {
      terms: 'allowed', robots: 'allowed', genericEnabled: true, minIntervalMinutes: 60,
    },
  });
  const result = await collectEmployer(target, {
    fetchImpl: async () => response(
      '<a href="/jobs/platform-engineer?sig=PRIVATE123">Platform engineer vacancy</a>',
      { type: 'text/html' },
    ),
    lookupFn: publicLookup,
    now: () => AT,
  });
  assert.equal(result.jobs.length, 1);
  assert.match(result.jobs[0].providerId, /^careers-generic-[a-f0-9]{32}$/);
  assert.equal(result.jobs[0].sourceRecordId, result.jobs[0].providerId);
  assert.equal(JSON.stringify({
    providerId: result.jobs[0].providerId,
    sourceRecordId: result.jobs[0].sourceRecordId,
  }).includes('PRIVATE123'), false);
});

test('deep JSON-LD graphs degrade with a fixed structural limit instead of aborting collection', async () => {
  let graph = { '@type': 'JobPosting', title: 'Too deep' };
  for (let depth = 0; depth < 80; depth += 1) graph = { '@graph': [graph] };
  const monitored = await collectEmployer(employer(), {
    fetchImpl: async () => response(
      `<script type="application/ld+json">${JSON.stringify(graph)}</script>`,
      { type: 'text/html' },
    ),
    lookupFn: publicLookup,
    now: () => AT,
  });
  assert.equal(monitored.status, 'degraded');
  assert.equal(monitored.failureCode, 'structured-data-too-complex');
  assert.deepEqual(monitored.jobs, []);
});

test('more structured postings than the bounded payload reports degraded capacity', async () => {
  const postings = Array.from({ length: 101 }, (_, index) => ({
    '@type': 'JobPosting',
    title: `Capacity role ${index + 1}`,
    url: `https://careers.example.test/jobs/capacity-${index + 1}`,
    hiringOrganization: { name: 'Example Systems' },
  }));
  const target = employer({
    access: {
      terms: 'allowed',
      robots: 'allowed',
      genericEnabled: true,
      minIntervalMinutes: 60,
    },
  });
  const result = await collectEmployer(target, {
    fetchImpl: async () => response(
      `<script type="application/ld+json">${JSON.stringify({ '@graph': postings })}</script>`,
      { type: 'text/html' },
    ),
    lookupFn: publicLookup,
    now: () => AT,
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.failureCode, 'structured-data-capacity');
  assert.equal(result.returned, 101);
  assert.equal(result.parsed, 100);
  assert.equal(result.jobs.length, 100);
});

test('terms, robots, authentication, anti-bot, rate limits and JavaScript shells fail safely', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response(''); };
  for (const [access, failureCode] of [
    [{ terms: 'unreviewed', robots: 'allowed', genericEnabled: true, minIntervalMinutes: 60 }, 'terms-unreviewed'],
    [{ terms: 'disallowed', robots: 'allowed', genericEnabled: true, minIntervalMinutes: 60 }, 'terms-disallowed'],
    [{ terms: 'allowed', robots: 'unknown', genericEnabled: true, minIntervalMinutes: 60 }, 'robots-unreviewed'],
    [{ terms: 'allowed', robots: 'disallowed', genericEnabled: true, minIntervalMinutes: 60 }, 'robots-disallowed'],
  ]) {
    const result = await collectEmployer(employer({ access }), {
      fetchImpl, lookupFn: publicLookup, now: () => AT,
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.failureCode, failureCode);
  }
  assert.equal(calls, 0, 'policy blocks must happen before a request');

  for (const [page, options, status, failureCode] of [
    ['Sign in to view jobs', { status: 401, type: 'text/html' }, 'blocked', 'authentication-required'],
    ['Checking your browser CAPTCHA challenge', { type: 'text/html' }, 'blocked', 'anti-bot'],
    ['Too many requests', { status: 429, type: 'text/html' }, 'degraded', 'rate-limited'],
    ['<html><script src="/app.js"></script><div id="app"></div></html>', { type: 'text/html' }, 'unsupported', 'javascript-required'],
  ]) {
    const result = await collectEmployer(employer({
      access: {
        terms: 'allowed', robots: 'allowed', genericEnabled: true, minIntervalMinutes: 60,
      },
    }), {
      fetchImpl: async () => response(page, options),
      lookupFn: publicLookup,
      now: () => AT,
    });
    assert.equal(result.status, status);
    assert.equal(result.failureCode, failureCode);
  }
});

test('a generic careers request cannot follow monitoring onto another origin', async () => {
  const result = await collectEmployer(employer(), {
    fetchImpl: async () => ({
      ...response('<html>external</html>', { type: 'text/html' }),
      url: 'https://authentication.example.test/login',
    }),
    lookupFn: publicLookup,
    now: () => AT,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.failureCode, 'external-redirect');
  assert.equal(result.jobs.length, 0);
});

test('one employer failure cannot discard healthy siblings', async () => {
  const healthy = employer({ canonicalName: 'Healthy Example' });
  const blocked = employer({
    canonicalName: 'Blocked Example',
    access: {
      terms: 'allowed', robots: 'disallowed', genericEnabled: true, minIntervalMinutes: 60,
    },
  });
  const result = await collectEmployers([healthy, blocked], {
    fetchImpl: async () => response(`<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Healthy role',
      url: 'https://careers.example.test/jobs/healthy',
      hiringOrganization: { name: 'Healthy Example' },
    })}</script>`, { type: 'text/html' }),
    lookupFn: publicLookup,
    now: () => AT,
  });

  assert.equal(result.jobs.length, 1);
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks.find(({ employerId }) => employerId === healthy.id).status, 'healthy');
  assert.equal(result.checks.find(({ employerId }) => employerId === blocked.id).status, 'blocked');
});
