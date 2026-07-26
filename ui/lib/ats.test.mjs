import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchGreenhouse, fetchLever, fetchAshby, parsePortalConfig, fetchPortal, fetchPortals, portalSummary,
} from './ats.mjs';

function response(body) {
  return { ok: true, json: async () => body };
}

const portal = { name: 'HardwareCo', ats: 'greenhouse', token: ['hardware', 'co'].join(''), enabled: true, tags: ['Space'] };

test('fetchGreenhouse maps public board jobs', async () => {
  const jobs = await fetchGreenhouse(portal, async () => response({
    jobs: [{ id: 123, title: 'Senior Hardware Engineer', content: '<p>PCB and test rigs</p>', absolute_url: 'https://x', location: { name: 'Oxford' }, updated_at: '2026-07-08T10:00:00Z' }],
  }));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, 'HardwareCo');
  assert.equal(jobs[0].source, 'ats-greenhouse');
  assert.equal(jobs[0].description, 'PCB and test rigs');
  assert.equal(jobs[0].postedDate, '2026-07-08');
  assert.equal(jobs[0].providerId, '123');
  assert.equal(jobs[0].sourceRecordId, '123');
});

test('fetchLever maps public postings', async () => {
  const jobs = await fetchLever({ ...portal, ats: 'lever' }, async () => response([
    { text: 'Electronics Engineer', descriptionPlain: 'Bring-up', hostedUrl: 'https://x', categories: { location: 'London', commitment: 'Full-time' } },
  ]));
  assert.equal(jobs[0].source, 'ats-lever');
  assert.equal(jobs[0].location, 'London');
  assert.equal(jobs[0].sourceRecordId, jobs[0].providerId);
});

test('fetchAshby maps public postings', async () => {
  const jobs = await fetchAshby({ ...portal, ats: 'ashby' }, async () => response({
    jobs: [{ title: 'Avionics Engineer', descriptionPlain: 'Flight hardware', jobUrl: 'https://x', location: 'Harwell', employmentType: 'Full-time', publishedDate: '2026-07-07T00:00:00Z' }],
  }));
  assert.equal(jobs[0].source, 'ats-ashby');
  assert.equal(jobs[0].postedDate, '2026-07-07');
  assert.equal(jobs[0].sourceRecordId, jobs[0].providerId);
});

test('parsePortalConfig validates shape and summary hides tokens', () => {
  const portals = parsePortalConfig(JSON.stringify({ portals: [
    { name: 'A', ats: 'greenhouse', token: 'secret', enabled: true, careersUrl: 'https://a', tags: ['Robotics'] },
    { name: '', ats: 'lever', token: 'x' },
  ] }));
  assert.equal(portals.length, 1);
  const summary = portalSummary(portals);
  assert.deepEqual(Object.keys(summary[0]).sort(), ['ats', 'careersUrl', 'enabled', 'name', 'supported', 'tags']);
  assert.equal(summary[0].supported, true);
});

test('fetchPortal skips disabled and unsupported portals', async () => {
  assert.deepEqual(await fetchPortal({ ...portal, enabled: false }, async () => { throw new Error('no'); }), []);
  assert.deepEqual(await fetchPortal({ ...portal, ats: 'manual' }, async () => { throw new Error('no'); }), []);
});

test('fetchAllPortals reports partial portal failures as degraded', async () => {
  const result = await fetchPortals([
    portal,
    { ...portal, name: 'BrokenCo', token: 'broken' },
  ], async (url) => {
    if (String(url).includes('broken')) return { ok: false, status: 503 };
    return response({ jobs: [] });
  });
  assert.equal(result.status, 'degraded');
  assert.equal(result.count, 0);
  assert.equal(result.errors.length, 1);
});

test('fetchPortals reports unavailable when no supported portals are enabled', async () => {
  const result = await fetchPortals([{ ...portal, enabled: false }]);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.count, 0);
  assert.match(result.reason, /no supported ATS portals/);
});
