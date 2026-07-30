import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectEmployer, collectEmployers, parseJobPostingData,
} from './careersAdapters.mjs';
import { createEmployerRegistry } from './employerRegistry.mjs';

const AT = '2026-07-30T12:00:00.000Z';

function response(body, { status = 200, type = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? type : null },
    json: async () => body,
    text: async () => String(body),
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
    now: () => AT,
  });

  assert.equal(result.adapter, 'generic');
  assert.equal(result.status, 'healthy');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].url, 'https://careers.example.test/jobs/operations-lead');
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
    const result = await collectEmployer(employer({ access }), { fetchImpl, now: () => AT });
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
    })}</script>`, { type: 'text/html' }),
    now: () => AT,
  });

  assert.equal(result.jobs.length, 1);
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks.find(({ employerId }) => employerId === healthy.id).status, 'healthy');
  assert.equal(result.checks.find(({ employerId }) => employerId === blocked.id).status, 'blocked');
});
