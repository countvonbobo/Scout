import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBuildId, buildSearchState, fetchHiringCafe, DEFAULT_HIRING_CAFE_QUERIES } from './hiringCafe.mjs';

const hit = {
  objectID: 'hiring-cafe-123',
  is_expired: false, apply_url: 'https://apply/x', job_information: { title: 'Product Designer' },
  v5_processed_job_data: {
    company_name: 'ExampleCo', requirements_summary: 'Research and prototyping', job_category: 'Design',
    yearly_min_compensation: 60000, yearly_max_compensation: 75000, listed_compensation_currency: 'GBP',
    estimated_publish_date: '2026-07-08T00:00:00Z', formatted_workplace_location: 'Remote', workplace_type: 'Remote',
  },
};
const homepage = (id) => ({ ok: true, text: async () => `<script>{"buildId":"${id}"}</script>` });
const dataResponse = (hits) => ({ ok: true, json: async () => ({ pageProps: { ssrHits: hits } }) });

test('extractBuildId finds the Next.js build id', () => {
  assert.equal(extractBuildId('{"buildId":"abc123"}'), 'abc123');
  assert.equal(extractBuildId('none'), null);
});

test('buildSearchState does not impose a personal location', () => {
  assert.deepEqual(buildSearchState('designer'), { searchQuery: 'designer', locations: [] });
  assert.equal(buildSearchState('designer', { location: { formatted_address: 'Berlin' } }).locations[0].formatted_address, 'Berlin');
});

test('fetchHiringCafe normalises hits and skips expired ones', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['product designer'], async (url) => {
    call += 1;
    if (call === 1) return homepage('bld1');
    assert.match(String(url), /_next\/data\/bld1\/index\.json/);
    return dataResponse([hit, { ...hit, is_expired: true }]);
  });
  assert.equal(result.available, true);
  assert.equal(result.status, 'healthy');
  assert.equal(result.count, 1);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].salary, 'GBP 60,000-75,000');
  assert.equal(result.jobs[0].salaryRateType, 'salary');
  assert.equal(result.jobs[0].providerId, 'hiring-cafe-123');
  assert.equal(result.jobs[0].sourceRecordId, 'hiring-cafe-123');
  assert.deepEqual(result.sources, { 'product designer': 1 });
});

test('fetchHiringCafe keeps distinct openings with the same company and title', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['product designer'], async () => {
    call += 1;
    return call === 1 ? homepage('bld1') : dataResponse([
      hit, { ...hit, objectID: 'hiring-cafe-456', apply_url: 'https://apply/y', v5_processed_job_data: { ...hit.v5_processed_job_data, formatted_workplace_location: 'Leeds' } },
    ]);
  });
  assert.equal(result.jobs.length, 2);
});

test('fetchHiringCafe retains every query that found a deduplicated opening', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['designer', 'researcher'], async () => {
    call += 1;
    return call === 1 ? homepage('bld1') : dataResponse([hit]);
  });
  assert.equal(result.jobs.length, 1);
  assert.deepEqual(result.jobs[0].searchQueries, ['designer', 'researcher']);
});

test('fetchHiringCafe fingerprints the canonical apply URL when the provider omits an identifier', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['product designer'], async () => {
    call += 1;
    return call === 1 ? homepage('bld1') : dataResponse([{ ...hit, objectID: '', apply_url: 'https://apply/x?utm_source=board' }]);
  });
  assert.match(result.jobs[0].sourceRecordId, /^url-[a-f0-9]{64}$/);
  assert.notEqual(result.jobs[0].sourceRecordId, result.jobs[0].url);
});

test('fetchHiringCafe leaves sourceRecordId absent when a hit has neither ID nor apply URL', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['product designer'], async () => {
    call += 1;
    return call === 1 ? homepage('bld1') : dataResponse([{ ...hit, objectID: '', apply_url: '' }]);
  });
  assert.equal(result.jobs[0].sourceRecordId, '');
});

test('fetchHiringCafe fails soft and records bounded retry recovery', async () => {
  const missing = await fetchHiringCafe(['x'], async () => ({ ok: true, text: async () => 'not next.js' }));
  assert.equal(missing.available, false);
  assert.equal(missing.status, 'unavailable');
  let call = 0;
  const partial = await fetchHiringCafe(['a', 'b'], async () => {
    call += 1;
    if (call === 1) return homepage('bld1');
    if (call === 2) throw new Error('boom');
    return dataResponse([hit]);
  });
  assert.equal(partial.jobs.length, 1);
  assert.deepEqual(partial.errors, []);
  assert.equal(partial.status, 'healthy');
  assert.equal(partial.recovery.recovered, true);
  assert.equal(partial.recovery.retries, 1);

  call = 0;
  const exhausted = await fetchHiringCafe(['a'], async () => {
    call += 1;
    if (call === 1) return homepage('bld1');
    throw new Error('still down');
  }, { attempts: 1, sleepFn: async () => {} });
  assert.equal(exhausted.errors.length, 1);
  assert.equal(exhausted.status, 'degraded');
});

test('fetchHiringCafe treats a successful empty search as healthy', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['rare role'], async () => {
    call += 1;
    return call === 1 ? homepage('bld1') : dataResponse([]);
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.count, 0);
  assert.deepEqual(result.errors, []);
});

test('fetchHiringCafe uses the canonical origin returned after a homepage redirect', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['engineer'], async (url) => {
    call += 1;
    if (call === 1) return { ...homepage('redirected'), url: 'https://hiringcafe.com/' };
    assert.match(String(url), /^https:\/\/hiringcafe\.com\/_next\/data\/redirected\/index\.json/);
    return dataResponse([hit]);
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.jobs.length, 1);
});

test('fetchHiringCafe refreshes the build once when the data endpoint shape changes', async () => {
  let call = 0;
  const result = await fetchHiringCafe(['engineer'], async () => {
    call += 1;
    if (call === 1) return homepage('old');
    if (call === 2) return { ok: true, json: async () => ({ pageProps: {} }) };
    if (call === 3) return homepage('new');
    return dataResponse([hit]);
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.recovery.recovered, true);
});

test('default queries are empty until onboarding configures the search', async () => {
  assert.deepEqual(DEFAULT_HIRING_CAFE_QUERIES, []);
  const result = await fetchHiringCafe();
  assert.equal(result.available, false);
});
