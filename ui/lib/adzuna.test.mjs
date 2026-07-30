import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adzunaUrl, fetchAdzuna, resolveAdzunaCredentials, DEFAULT_ADZUNA_QUERIES } from './adzuna.mjs';

const creds = { appId: 'id1', apiKey: 'key1' };
const item = {
  id: 'adzuna-123',
  title: 'Senior Designer', company: { display_name: 'Example Studio' }, description: 'Research and prototyping',
  redirect_url: 'https://adzuna/x', salary_min: 60000, salary_max: 70000,
  created: '2026-07-09T08:00:00Z', location: { display_name: 'Manchester' },
};
const response = (body) => ({ ok: true, json: async () => body });

test('adzunaUrl encodes configurable country, credentials, query, and optional filters', () => {
  const url = adzunaUrl('product designer', { ...creds, country: 'gb', where: 'Manchester', distanceKm: 40, salaryMin: 55000, resultsPerPage: 25 });
  assert.ok(url.startsWith('https://api.adzuna.com/v1/api/jobs/gb/search/1?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('app_id'), 'id1');
  assert.equal(params.get('what'), 'product designer');
  assert.equal(params.get('where'), 'Manchester');
  assert.equal(params.get('distance'), '40');
  assert.equal(params.get('salary_min'), '55000');
  assert.equal(params.get('results_per_page'), '25');
  assert.throws(() => adzunaUrl('x', { ...creds, country: '../' }), /country/);
});

test('adzunaUrl omits unset personal filters', () => {
  const params = new URL(adzunaUrl('designer', creds)).searchParams;
  assert.equal(params.has('where'), false);
  assert.equal(params.has('distance'), false);
  assert.equal(params.has('salary_min'), false);
});

test('fetchAdzuna normalises jobs, locale/currency, and per-query counts', async () => {
  const result = await fetchAdzuna({ ...creds, queries: ['product designer'], locale: 'en-GB', currency: 'GBP' }, async () => response({ results: [item] }));
  assert.equal(result.available, true);
  assert.equal(result.status, 'healthy');
  assert.equal(result.count, 1);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].company, 'Example Studio');
  assert.equal(result.jobs[0].salary, '\u00a360,000-\u00a370,000');
  assert.equal(result.jobs[0].salaryRateType, 'salary');
  assert.equal(result.jobs[0].postedDate, '2026-07-09');
  assert.equal(result.jobs[0].providerId, 'adzuna-123');
  assert.equal(result.jobs[0].sourceRecordId, 'adzuna-123');
  assert.deepEqual(result.sources, { 'product designer': 1 });
});

test('fetchAdzuna dedupes and fails soft per query', async () => {
  let call = 0;
  const result = await fetchAdzuna({ ...creds, queries: ['bad', 'good', 'again'] }, async () => {
    call += 1;
    if (call === 1) return { ok: false, status: 500, json: async () => ({}) };
    return response({ results: [item] });
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.status, 'degraded');
  assert.match(result.errors[0], /bad/);
  assert.deepEqual(result.jobs[0].searchQueries, ['good', 'again']);
});

test('fetchAdzuna keeps distinct provider openings with the same title', async () => {
  const result = await fetchAdzuna({ ...creds, queries: ['designer'] }, async () => response({ results: [
    item, { ...item, id: 'adzuna-456', redirect_url: 'https://adzuna/y', location: { display_name: 'Leeds' } },
  ] }));
  assert.equal(result.jobs.length, 2);
});

test('fetchAdzuna reports unavailable without credentials or configured queries', async () => {
  const missing = await fetchAdzuna({ appId: '', apiKey: '', queries: ['x'] });
  assert.equal(missing.available, false);
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.count, 0);
  const empty = await fetchAdzuna({ ...creds, queries: [] });
  assert.equal(empty.available, false);
  assert.match(empty.note, /no Adzuna queries/);
});

test('resolveAdzunaCredentials reads the env object', () => {
  assert.deepEqual(resolveAdzunaCredentials({ ADZUNA_APP_ID: 'a', ADZUNA_API_KEY: 'b' }), { appId: 'a', apiKey: 'b' });
  assert.equal(resolveAdzunaCredentials({ ADZUNA_APP_ID: 'a' }), null);
});

test('default queries are empty until onboarding configures the search', () => {
  assert.deepEqual(DEFAULT_ADZUNA_QUERIES, []);
});
