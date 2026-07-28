import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertScanReady, broadenSearchQueries, collectScanSources, migrateLegacyWorkspace, runScan, runScanWith, shouldAutoBroaden,
} from './scout.mjs';
import { DEFAULT_WORKSPACE_CONFIG, loadWorkspaceConfig, writeWorkspaceConfig } from '../ui/lib/workspace.mjs';
import { publishSearchProfile } from '../ui/lib/searchProfile.mjs';
import { replayRunJournal } from '../ui/lib/runJournal.mjs';
import { projectScanQueue } from '../ui/lib/scanQueue.mjs';
import { acquireScanLease, currentLeaseOwner, readScanLease, releaseScanLease } from '../ui/lib/scanLease.mjs';

function scanRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-runtime-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-14","opportunities":[]}\n');
  writeWorkspaceConfig(root, { ...structuredClone(DEFAULT_WORKSPACE_CONFIG), ai: { provider: 'codex', model: null } });
  return root;
}

const authenticated = () => ({ installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } });

function publishedRankingProfile() {
  return publishSearchProfile({
    version: 1, status: 'draft',
    target: { primaryTitles: [{ value: 'Ideal Role', strength: 'strong-preference', provenance: 'explicit' }] },
    negative: {},
    compensation: { currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include' },
  }, { publishedAt: '2026-07-26T20:00:00.000Z' });
}

function readyScanRoot({ opportunities = [] } = {}) {
  const root = scanRoot();
  const config = structuredClone(DEFAULT_WORKSPACE_CONFIG);
  config.ai.provider = 'codex';
  config.profile.displayName = 'Synthetic Person';
  config.search = {
    ...config.search,
    roleFamilies: ['Synthetic Engineer'],
    locations: ['Remote'],
    exclusions: [],
    salaryMinimum: null,
  };
  writeWorkspaceConfig(root, config);
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cv'), { recursive: true });
  fs.mkdirSync(path.join(root, '.scout', 'onboarding'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'Synthetic profile evidence. '.repeat(12));
  fs.writeFileSync(path.join(root, 'profile', 'calibration.md'), 'Synthetic calibration evidence. '.repeat(8));
  fs.writeFileSync(path.join(root, 'cv', 'master-cv.md'), 'Synthetic CV evidence. '.repeat(30));
  fs.writeFileSync(path.join(root, '.scout', 'onboarding', 'activated.json'), '{"approved":true}\n');
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), `${JSON.stringify({ updated: '2026-07-27', opportunities })}\n`);
  return root;
}

function enableRankedDiscovery(root) {
  const profile = publishedRankingProfile();
  fs.mkdirSync(path.join(root, 'profile', 'search'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'search', 'published.json'), `${JSON.stringify(profile)}\n`);
}

function assessmentFor(candidates) {
  return {
    assessments: candidates.map((candidate) => ({
      candidateId: candidate.candidateId, categoryId: null, summary: 'Synthetic assessment', hardExclusionMatches: [],
      mandatoryRequirements: [], dimensions: [{ name: 'fit', score: 80, maximum: 100, evidence: 'Synthetic evidence' }], recommendation: 'keep',
    })),
  };
}

function scanHarness(sources, seenCandidates) {
  return {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({ generatedAt: '2026-07-26T20:00:00Z', queries: [], sources }),
    runStructuredTurnFn: async ({ validate }) => {
      const candidates = seenCandidates();
      const value = assessmentFor(candidates);
      validate(value);
      return { value, usage: {} };
    },
    acquireLockFn: () => ({ ok: true, lock: { token: 'ranked-discovery-test' } }),
    releaseLockFn: () => ({ ok: true }),
    checkLivenessFn: async (candidates) => ({ live: candidates, removed: [], summary: { checked: candidates.length, gone: 0, unverified: 0 } }),
  };
}

test('safe broadening adds adjacent discovery queries without changing approved gates', () => {
  const config = {
    search: {
      roleFamilies: ['Account Manager'], sectors: ['Private networks', 'Telecommunications'],
      locations: ['Example City'], salaryMinimum: 95000, exclusions: ['Commission only'],
    },
    commute: { maxMinutes: 90, includeUnknown: false },
  };
  const queries = broadenSearchQueries(config, ['Account Manager']);
  assert.ok(queries.includes('key account manager'));
  assert.ok(queries.includes('Private networks Example City'));
  assert.equal(config.search.salaryMinimum, 95000);
  assert.deepEqual(config.search.exclusions, ['Commission only']);
  assert.equal(config.commute.maxMinutes, 90);
});

test('automatic broadening runs once only after a successful empty primary scan', () => {
  const empty = { ok: true, scan: { reviewed: [{ outcome: 'mandatory-gate' }] } };
  const keeper = { ok: true, scan: { reviewed: [{ outcome: 'kept' }] } };
  assert.equal(shouldAutoBroaden(empty, 'primary', true), true);
  assert.equal(shouldAutoBroaden(keeper, 'primary', true), false);
  assert.equal(shouldAutoBroaden(empty, 'broadened', true), false);
  assert.equal(shouldAutoBroaden(empty, 'primary', false), false);
  assert.equal(shouldAutoBroaden({ ok: false, scan: { reviewed: [] } }, 'primary', true), false);
});

test('an absent ATS configuration does not degrade a healthy configured source', async () => {
  const root = scanRoot();
  const config = { ...structuredClone(DEFAULT_WORKSPACE_CONFIG), search: { ...DEFAULT_WORKSPACE_CONFIG.search, roleFamilies: ['engineer'] } };
  writeWorkspaceConfig(root, config);
  const collected = await collectScanSources(root, config, {
    fetchAts: async () => ({ status: 'unavailable', available: false, count: 0, reason: 'no supported ATS portals enabled', jobs: [] }),
    fetchCafe: async () => ({ status: 'healthy', available: true, count: 1, jobs: [{ title: 'Engineer', company: 'Example', url: 'https://example.test/job' }] }),
    fetchAdzunaFn: async () => { throw new Error('Adzuna must be skipped without credentials'); },
  });
  assert.equal(collected.sources.ats.configured, false);
  assert.equal(collected.sources.hiring_cafe.configured, true);
  assert.equal(collected.sources.hiring_cafe.status, 'healthy');
  assert.equal(collected.sources.adzuna.configured, false);
});

test('legacy migration overwrites generic seed placeholders and preserves user trees', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-migrate-'));
  const source = path.join(root, 'legacy');
  const target = path.join(root, 'workspace');
  try {
    fs.mkdirSync(path.join(source, 'profile'), { recursive: true });
    fs.mkdirSync(path.join(source, 'cv'), { recursive: true });
    fs.mkdirSync(path.join(source, 'data'), { recursive: true });
    fs.mkdirSync(path.join(source, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(source, 'applications', 'example'), { recursive: true });
    fs.writeFileSync(path.join(source, 'profile', 'context.md'), '# Private legacy profile\n', 'utf8');
    fs.writeFileSync(path.join(source, 'cv', 'master-cv.md'), '# Example Person — Engineer\n', 'utf8');
    fs.writeFileSync(path.join(source, 'data', 'opportunities.json'), '{"opportunities":[{"id":"kept"}]}\n', 'utf8');
    fs.writeFileSync(path.join(source, 'reports', '2026-01-01.md'), '# Kept report\n', 'utf8');
    fs.writeFileSync(path.join(source, 'applications', 'example', 'outreach.md'), 'Kept draft\n', 'utf8');
    fs.writeFileSync(path.join(source, '.env'), 'ADZUNA_APP_ID=secret\n', 'utf8');

    const result = migrateLegacyWorkspace(source, target);

    assert.equal(fs.readFileSync(path.join(target, 'profile', 'context.md'), 'utf8'), '# Private legacy profile\n');
    assert.match(fs.readFileSync(path.join(target, 'cv', 'master-cv.md'), 'utf8'), /Example Person/);
    assert.match(fs.readFileSync(path.join(target, 'data', 'opportunities.json'), 'utf8'), /"kept"/);
    assert.equal(fs.readFileSync(path.join(target, 'reports', '2026-01-01.md'), 'utf8'), '# Kept report\n');
    assert.equal(fs.readFileSync(path.join(target, 'applications', 'example', 'outreach.md'), 'utf8'), 'Kept draft\n');
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'ADZUNA_APP_ID=secret\n');
    assert.equal(result.verifiedFiles, 6);
    assert.equal(result.targetRoot, target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime scan skips AI for a healthy empty source result and needs no Git repository', async () => {
  const root = scanRoot();
  let providerCalls = 0;
  let released = false;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({
      generatedAt: '2026-07-14T10:00:00Z', queries: ['rare role'],
      sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
    }),
    runStructuredTurnFn: async () => { providerCalls += 1; throw new Error('must not run'); },
    acquireLockFn: () => ({ ok: true, lock: { token: 'lock-1' } }),
    releaseLockFn: () => { released = true; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'healthy-empty');
  assert.equal(result.scan.candidates_found, 0);
  assert.equal(result.scan.discovery_engine, 'legacy-discovery');
  assert.equal(result.scan.funnel, undefined);
  assert.equal(providerCalls, 0);
  assert.equal(released, true);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('fresh scan readiness stages a reviewable search-profile draft and requires publication', () => {
  const root = readyScanRoot();

  assert.throws(
    () => assertScanReady(root, 'codex', { providerStatusFn: authenticated }),
    /publish.*search profile/i,
  );
  const draft = JSON.parse(fs.readFileSync(path.join(root, 'profile', 'search', 'draft.json'), 'utf8'));
  assert.equal(draft.status, 'draft');
  assert.equal(draft.target.primaryTitles[0].value, 'Synthetic Engineer');
  assert.equal(fs.existsSync(path.join(root, 'profile', 'search', 'published.json')), false);
});

test('incomplete scan readiness does not freeze a premature migration draft', () => {
  const root = scanRoot();
  const config = structuredClone(DEFAULT_WORKSPACE_CONFIG);
  config.ai.provider = 'codex';
  config.profile.displayName = 'Synthetic Person';
  config.search = {
    ...config.search,
    roleFamilies: ['Synthetic Engineer'],
    locations: ['Remote'],
    exclusions: [],
    salaryMinimum: null,
  };
  writeWorkspaceConfig(root, config);

  assert.throws(
    () => assertScanReady(root, 'codex', { providerStatusFn: authenticated }),
    /complete approved evidence/i,
  );
  assert.equal(fs.existsSync(path.join(root, 'profile', 'search', 'draft.json')), false);
});

test('grandfathered established workspaces stage migration but retain legacy discovery compatibility', () => {
  const root = readyScanRoot({
    opportunities: [{ id: 'existing-role', company: 'Synthetic Co', role: 'Synthetic Engineer', status: 'watch' }],
  });

  const readiness = assertScanReady(root, 'codex', { providerStatusFn: authenticated });

  assert.equal(readiness.established, true);
  assert.equal(fs.existsSync(path.join(root, 'profile', 'search', 'draft.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'profile', 'search', 'published.json')), false);
});

test('runtime scan filters from the published profile before provider assessment', async () => {
  const root = scanRoot();
  const published = publishSearchProfile({
    version: 1, status: 'draft', target: {},
    negative: { excludedTitles: [], excludedResponsibilities: [{ value: 'coding', strength: 'hard-exclusion', provenance: 'confirmed-inference' }] },
    compensation: { currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include' },
  }, { publishedAt: '2026-07-26T20:00:00.000Z' });
  fs.mkdirSync(path.join(root, 'profile', 'search'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'search', 'published.json'), `${JSON.stringify(published)}\n`);
  let providerCalls = 0;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({ generatedAt: '2026-07-26T20:00:00Z', queries: [], sources: {
      hiring_cafe: { configured: true, status: 'healthy', count: 1, jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://example.test/job', description: 'Perform coding.' }] },
    } }),
    runStructuredTurnFn: async () => { providerCalls += 1; throw new Error('excluded vacancy must not be assessed'); },
    acquireLockFn: () => ({ ok: true, lock: { token: 'filter-test' } }), releaseLockFn: () => ({ ok: true }),
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.scan.candidates_found, 0);
  assert.equal(result.scan.discarded.hard_exclusion, 1);
  assert.equal(providerCalls, 0);
});

test('runtime selection is independent of source and portal order', async () => {
  const source = (name, jobs) => ({ configured: true, status: 'healthy', count: jobs.length, jobs: jobs.map((job) => ({ ...job, source: name })) });
  const jobs = [
    { company: 'Able', title: 'Ideal Role', url: 'https://example.test/able', providerId: 'able' },
    { company: 'Baker', title: 'Ideal Role', url: 'https://example.test/baker', providerId: 'baker' },
  ];
  const selectedUrls = [];
  for (const sources of [
    { 'ats-a': source('ats-a', [jobs[0]]), 'ats-b': source('ats-b', [jobs[1]]) },
    { 'ats-b': source('ats-b', [jobs[1]]), 'ats-a': source('ats-a', [jobs[0]]) },
  ]) {
    const root = scanRoot();
    enableRankedDiscovery(root);
    let candidates = [];
    const result = await runScanWith(root, 'codex', 'primary', {
      ...scanHarness(sources, () => candidates),
      checkLivenessFn: async (items) => { candidates = items; return { live: items, removed: [], summary: { checked: items.length, gone: 0, unverified: 0 } }; },
    });
    assert.equal(result.ok, true);
    selectedUrls.push(candidates.map((item) => item.url));
  }
  assert.deepEqual(selectedUrls[0], selectedUrls[1]);
});

test('runtime ranks every unique job but does not pad assessment with zero-score jobs', async () => {
  const root = scanRoot();
  enableRankedDiscovery(root);
  const lateStrongUrl = 'https://example.test/jobs/late-strong';
  const jobs = Array.from({ length: 2500 }, (_, index) => ({
    company: `Company ${index}`, title: index === 2499 ? 'Ideal Role' : 'Other Role',
    url: index === 2499 ? lateStrongUrl : `https://example.test/jobs/${index}`,
    providerId: `job-${index}`,
  }));
  let candidates = [];
  const result = await runScanWith(root, 'codex', 'primary', {
    ...scanHarness({ ats: { configured: true, status: 'healthy', count: jobs.length, jobs } }, () => candidates),
    checkLivenessFn: async (items) => { candidates = items; return { live: items, removed: [], summary: { checked: items.length, gone: 0, unverified: 0 } }; },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.scan.funnel.uniqueVacancies, 2500);
  assert.equal(result.scan.funnel.ranked, result.scan.funnel.eligible);
  assert.equal(result.scan.funnel.selected, 1);
  assert.deepEqual(candidates.map((item) => item.url), [lateStrongUrl]);
});

test('closed selected adverts are replaced by the next ranked eligible vacancy', async () => {
  const root = scanRoot();
  enableRankedDiscovery(root);
  const jobs = Array.from({ length: 61 }, (_, index) => ({
    company: `Company ${String(index).padStart(2, '0')}`, title: 'Ideal Role',
    url: `https://example.test/backfill/${index}`, providerId: `backfill-${index}`,
  }));
  let assessed = [];
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({ generatedAt: '2026-07-26T20:00:00Z', queries: [], sources: {
      ats: { configured: true, status: 'healthy', count: jobs.length, jobs },
    } }),
    checkLivenessFn: async (items) => ({
      live: items.filter((item) => item.url !== 'https://example.test/backfill/0'),
      removed: items.filter((item) => item.url === 'https://example.test/backfill/0').map((item) => ({ ...item, liveness: { reason: 'closed' } })),
      summary: { checked: items.length, gone: items.some((item) => item.url.endsWith('/0')) ? 1 : 0, unverified: 0 },
    }),
    runStructuredTurnFn: async ({ prompt, validate }) => {
      assessed = JSON.parse(prompt.split('\n\n').at(-1)).candidates;
      const value = assessmentFor(assessed);
      validate(value);
      return { value, usage: {} };
    },
    acquireLockFn: () => ({ ok: true, lock: { token: 'liveness-backfill-test' } }),
    releaseLockFn: () => ({ ok: true }),
    onProgress: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(assessed.length, 60);
  assert.ok(assessed.some((item) => item.url === 'https://example.test/backfill/60'));
  assert.ok(!assessed.some((item) => item.url === 'https://example.test/backfill/0'));
  assert.equal(result.scan.funnel.selected, 60);
  assert.equal(result.scan.funnel.assessed, 60);
});

test('a failed ranked scan retains its discovery engine and available orchestration state', async () => {
  const root = scanRoot();
  const published = publishSearchProfile({
    version: 1,
    status: 'draft',
    target: { primaryTitles: [{ value: 'Ideal Role', strength: 'strong-preference', provenance: 'explicit' }] },
    negative: {
      excludedTitles: [{ value: 'Blocked Role', strength: 'hard-exclusion', provenance: 'explicit' }],
      excludedEmployers: [{ value: 'Blocked Co', strength: 'hard-exclusion', provenance: 'explicit' }],
    },
    compensation: {
      currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include',
    },
  }, { publishedAt: '2026-07-26T20:00:00.000Z' });
  fs.mkdirSync(path.join(root, 'profile', 'search'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'search', 'published.json'), `${JSON.stringify(published)}\n`);
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({ generatedAt: '2026-07-26T20:00:00Z', queries: [], sources: {
      ats: { configured: true, status: 'healthy', count: 2, jobs: [
        { company: 'Able', title: 'Ideal Role', url: 'https://example.test/failed-ranked', providerId: 'failed-ranked' },
        { company: 'Blocked Co', title: 'Blocked Role', url: 'https://example.test/blocked-ranked', providerId: 'blocked-ranked' },
      ] },
    } }),
    checkLivenessFn: async (items) => ({ live: items, removed: [], summary: { checked: items.length, gone: 0, unverified: 0 } }),
    runStructuredTurnFn: async () => { throw new Error('ranked provider failure'); },
    acquireLockFn: () => ({ ok: true, lock: { token: 'failed-ranked-test' } }),
    releaseLockFn: () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.scan.discovery_engine, 'ranked-discovery');
  assert.equal(result.scan.funnel.selected, 1);
  assert.deepEqual(result.scan.selection.map((item) => item.url), ['https://example.test/failed-ranked']);
  assert.equal(result.scan.profile_id, published.id);
  assert.equal(result.scan.discarded.hard_exclusion, 1);
  assert.deepEqual(
    result.scan.explanations.filter((item) => item.deterministic_exclusion).map((item) => item.deterministic_exclusion).sort(),
    ['excluded-employer', 'excluded-title'],
  );
  assert.equal(result.scan.adverts_checked, 1);
});

test('ranked second-pass candidates are renumbered and match persisted selection', async () => {
  const root = scanRoot();
  enableRankedDiscovery(root);
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), `${JSON.stringify({
    updated: '2026-07-26', opportunities: [{
      id: 'baker', company: 'Baker', role: 'Ideal Role', status: 'shortlist', score: 80,
      lastChecked: new Date().toISOString().slice(0, 10), sources: ['https://example.test/baker'], tags: [], contacts: [], log: [],
    }],
  })}\n`);
  let prompted = [];
  const result = await runScanWith(root, 'codex', 'second-pass', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({ generatedAt: '2026-07-26T20:00:00Z', queries: [], sources: {
      ats: { configured: true, status: 'healthy', count: 2, jobs: [
        { company: 'Able', title: 'Ideal Role', url: 'https://example.test/able', providerId: 'able' },
        { company: 'Baker', title: 'Ideal Role', url: 'https://example.test/baker', providerId: 'baker' },
      ] },
    } }),
    checkLivenessFn: async (items) => ({ live: items, removed: [], summary: { checked: items.length, gone: 0, unverified: 0 } }),
    runStructuredTurnFn: async ({ prompt, validate }) => {
      prompted = JSON.parse(prompt.split('\n\n').at(-1)).candidates;
      const value = assessmentFor(prompted);
      validate(value);
      return { value, usage: {} };
    },
    acquireLockFn: () => ({ ok: true, lock: { token: 'second-pass-ranked-test' } }),
    releaseLockFn: () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(prompted.map((item) => item.candidateId), ['candidate-001']);
  assert.deepEqual(prompted.map((item) => item.url), ['https://example.test/baker']);
  assert.deepEqual(result.scan.selection.map((item) => item.url), prompted.map((item) => item.url));
  assert.equal(result.scan.funnel.selected, prompted.length);
  assert.equal(result.scan.funnel.assessed, prompted.length);
});

test('runtime scan model is independent from the job-work model', async () => {
  const root = scanRoot();
  writeWorkspaceConfig(root, {
    ...structuredClone(DEFAULT_WORKSPACE_CONFIG),
    ai: { provider: 'codex', model: null, models: { codex: 'gpt-job', claude: null } },
  });
  const seen = [];
  const run = (model) => runScanWith(root, 'codex', 'primary', {
    model,
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({
      generatedAt: '2026-07-21T10:00:00Z', queries: ['engineer'],
      sources: { hiring_cafe: { configured: true, status: 'healthy', count: 1, jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://example.test/job' }] } },
    }),
    runStructuredTurnFn: async ({ model: selected }) => {
      seen.push(selected);
      return { value: { assessments: [{
        candidateId: 'candidate-001', categoryId: null, summary: 'Match', hardExclusionMatches: [], mandatoryRequirements: [],
        dimensions: [{ name: 'fit', score: 80, maximum: 100, evidence: 'Evidence' }], recommendation: 'keep',
      }] }, usage: {} };
    },
    acquireLockFn: () => ({ ok: true, lock: { token: `lock-${seen.length}` } }),
    releaseLockFn: () => ({ ok: true }),
  });
  assert.equal((await run(null)).ok, true);
  assert.equal((await run('gpt-scan')).ok, true);
  assert.deepEqual(seen, [null, 'gpt-scan']);
});

test('runtime scan refuses lock contention before collecting sources', async () => {
  const root = scanRoot();
  let collected = false;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => { collected = true; return {}; },
    acquireLockFn: () => ({ ok: false, lock: { agent: 'claude' } }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /already running/);
  assert.equal(collected, false);
});

test('runtime scan records provider failure truthfully and always releases its lock', async () => {
  const root = scanRoot();
  let released = false;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({
      generatedAt: '2026-07-14T10:00:00Z', queries: ['engineer'],
      sources: { hiring_cafe: { configured: true, status: 'healthy', count: 1, jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://example.test/job' }] } },
    }),
    runStructuredTurnFn: async () => { throw new Error('bounded provider failed'); },
    acquireLockFn: () => ({ ok: true, lock: { token: 'lock-2' } }),
    releaseLockFn: () => { released = true; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.scan.degraded, true);
  assert.deepEqual(result.scan.errors, ['bounded provider failed']);
  assert.equal(released, true);
  const events = replayRunJournal(path.join(root, '.scout', 'runs', result.runId, 'journal.jsonl'));
  assert.equal(events.at(-1).type, 'run.completed');
  assert.equal(events.at(-1).payload.outcome, 'failed');
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.json')), false);
  assert.match(fs.readFileSync(path.join(root, 'data', 'scan-runs.jsonl'), 'utf8'), /bounded provider failed/);
});

test('runtime records a canonical failure when collection fails before finalization', async () => {
  const root = scanRoot();
  try {
    const result = await runScanWith(root, 'codex', 'primary', {
      providerStatusFn: authenticated,
      collectSourcesFn: async () => {
        throw new Error('synthetic collection failure');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.scan.errors[0], 'synthetic collection failure');
    const events = replayRunJournal(path.join(root, '.scout', 'runs', result.runId, 'journal.jsonl'));
    assert.equal(events.at(-1).type, 'run.completed');
    assert.equal(events.at(-1).payload.outcome, 'failed');
    assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime allocates and journals a genuine durable run before source collection', async () => {
  const root = scanRoot();
  let observedRunId = null;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => {
      const lease = JSON.parse(fs.readFileSync(path.join(root, '.scout', 'scan-lease.json'), 'utf8'));
      observedRunId = lease.runId;
      const journal = path.join(root, '.scout', 'runs', observedRunId, 'journal.jsonl');
      assert.equal(replayRunJournal(journal).at(-1).type, 'run.started');
      return {
        generatedAt: '2026-07-27T10:00:00.000Z',
        queries: ['synthetic engineer'],
        sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.runId, observedRunId);
  assert.equal(result.durable.outcome, 'complete');
  assert.deepEqual(
    result.durable.manifest.completedWork.map((work) => work.stageId),
    ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'],
  );
  assert.equal(fs.existsSync(path.join(root, '.scout', 'scan-lease.json')), false);
});

test('an overlap loser only appends its queue request and performs no managed or log mutation', async () => {
  const root = scanRoot();
  const ignore = path.join(root, '.gitignore');
  const agents = path.join(root, 'AGENTS.md');
  fs.writeFileSync(ignore, 'synthetic-ignore\n', 'utf8');
  fs.writeFileSync(agents, 'synthetic managed instructions sentinel\n', 'utf8');
  const active = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan',
    runId: 'active-overlap-owner',
    provider: 'claude',
    mode: 'primary',
    phase: 'collect',
  });
  try {
    const result = await runScanWith(root, 'codex', 'primary', {
      providerStatusFn: authenticated,
      collectSourcesFn: async () => {
        throw new Error('overlap loser must not collect');
      },
    });

    assert.equal(result.status, 'queued');
    assert.equal(fs.readFileSync(ignore, 'utf8'), 'synthetic-ignore\n');
    assert.equal(fs.readFileSync(agents, 'utf8'), 'synthetic managed instructions sentinel\n');
    assert.equal(fs.existsSync(path.join(root, 'logs')), false);
    assert.equal(projectScanQueue(root).ready.length, 1);
  } finally {
    releaseScanLease(active);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runScan delegates backup authority to the fenced runtime and never backs up a queued result itself', async () => {
  const root = readyScanRoot();
  enableRankedDiscovery(root);
  const reasons = [];
  let delegatedBackup = null;
  const queueWorkspaceSyncFn = async (_root, reason) => {
    reasons.push(reason);
  };
  const queued = await runScan(root, 'codex', 'primary', {
    assertScanReadyFn: () => {},
    runScanWithFn: async (_root, _provider, _mode, options) => {
      delegatedBackup = options.queueWorkspaceSyncFn;
      return { ok: false, status: 'queued', durable: { outcome: 'queued' } };
    },
    queueWorkspaceSyncFn,
  });
  assert.equal(queued.status, 'queued');
  assert.equal(delegatedBackup, queueWorkspaceSyncFn);
  assert.deepEqual(reasons, []);

  const complete = await runScan(root, 'codex', 'primary', {
    assertScanReadyFn: () => {},
    runScanWithFn: async () => ({
      ok: true,
      status: 'healthy-empty',
      scan: { funnel: { selected: 0 }, degraded: false },
      durable: { outcome: 'complete' },
    }),
    queueWorkspaceSyncFn,
  });
  assert.equal(complete.ok, true);
  assert.deepEqual(reasons, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('runtime backup consumes a mutation receipt while the successful scan fence is current', async () => {
  const root = scanRoot();
  let backupCalls = 0;
  try {
    const result = await runScanWith(root, 'codex', 'primary', {
      providerStatusFn: authenticated,
      collectSourcesFn: async () => ({
        generatedAt: '2026-07-28T09:00:00.000Z',
        queries: [],
        sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
      }),
      async queueWorkspaceSyncFn(_root, reason) {
        backupCalls += 1;
        const lease = readScanLease(root);
        assert.ok(lease);
        const events = replayRunJournal(path.join(root, '.scout', 'runs', lease.runId, 'journal.jsonl'));
        assert.equal(events.at(-2).type, 'mutation.receipted');
        assert.equal(events.at(-1).type, 'run.completed');
        assert.equal(events.at(-1).payload.outcome, 'complete');
        assert.equal(reason, 'complete primary scan');
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.durable.outcome, 'complete');
    assert.deepEqual(result.durable.failures, []);
    assert.equal(backupCalls, 1);
    assert.equal(readScanLease(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime backup failure leaves the receipted scan successful with pending backup state', async () => {
  const root = scanRoot();
  try {
    const result = await runScanWith(root, 'codex', 'primary', {
      providerStatusFn: authenticated,
      collectSourcesFn: async () => ({
        generatedAt: '2026-07-28T09:00:00.000Z',
        queries: [],
        sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
      }),
      queueWorkspaceSyncFn: async () => {
        throw new Error('PRIVATE_BACKUP_FAILURE');
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.durable.outcome, 'complete');
    assert.deepEqual(result.durable.failures, [{
      code: 'backup-pending',
      stage: 'post-success',
      reason: 'backup-failed',
    }]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_BACKUP_FAILURE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('each terminally successful manual overlap run receives its own fenced backup', async () => {
  const root = scanRoot();
  let collectionCalls = 0;
  let overlap;
  const backedUpRuns = [];
  const options = {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => {
      collectionCalls += 1;
      if (collectionCalls === 1) overlap = await runScanWith(root, 'codex', 'primary', options);
      return {
        generatedAt: '2026-07-28T09:00:00.000Z',
        queries: [],
        sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
      };
    },
    async queueWorkspaceSyncFn() {
      const lease = readScanLease(root);
      assert.ok(lease);
      backedUpRuns.push(lease.runId);
    },
  };
  try {
    const primary = await runScanWith(root, 'codex', 'primary', options);

    assert.equal(primary.ok, true);
    assert.equal(overlap.status, 'queued');
    assert.equal(collectionCalls, 2);
    assert.equal(new Set(backedUpRuns).size, 2);
    assert.equal(projectScanQueue(root).requests[0].status, 'succeeded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('startup-drained success is backed up even when the following direct run fails', async () => {
  const root = scanRoot();
  const active = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan',
    runId: 'startup-backup-seed',
    provider: 'claude',
    mode: 'primary',
    phase: 'collect',
  });
  try {
    const queued = await runScanWith(root, 'codex', 'primary', {
      providerStatusFn: authenticated,
      collectSourcesFn: async () => {
        throw new Error('overlap loser must not collect');
      },
    });
    assert.equal(queued.status, 'queued');
  } finally {
    releaseScanLease(active);
  }

  let collectionCalls = 0;
  const backedUpRuns = [];
  try {
    const result = await runScanWith(root, 'codex', 'primary', {
      providerStatusFn: authenticated,
      collectSourcesFn: async () => {
        collectionCalls += 1;
        if (collectionCalls === 2) throw new Error('direct collection failed');
        return {
          generatedAt: '2026-07-28T09:00:00.000Z',
          queries: [],
          sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
        };
      },
      async queueWorkspaceSyncFn() {
        const lease = readScanLease(root);
        assert.ok(lease);
        backedUpRuns.push(lease.runId);
      },
    });

    assert.equal(result.ok, false);
    assert.equal(collectionCalls, 2);
    assert.equal(backedUpRuns.length, 1);
    assert.equal(projectScanQueue(root).requests[0].status, 'succeeded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a real scheduled success durably covers its same-window overlap without rerunning it', async () => {
  const root = scanRoot();
  let collectionCalls = 0;
  let overlap;
  const options = {
    requester: 'scheduled',
    windowAt: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
    scheduleId: 'codex-primary',
    logicalWindowId: new Date(Date.now() - 60 * 1000).toISOString(),
    providerStatusFn: authenticated,
    collectSourcesFn: async () => {
      collectionCalls += 1;
      if (collectionCalls === 1) {
        overlap = await runScanWith(root, 'codex', 'primary', options);
      }
      return {
        generatedAt: '2026-07-28T09:00:00.000Z',
        queries: [],
        sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
      };
    },
    runStructuredTurnFn: async () => {
      throw new Error('empty queued scans must not call the provider');
    },
    checkLivenessFn: async (candidates) => ({
      live: candidates,
      removed: [],
      summary: { checked: candidates.length, gone: 0, unverified: 0 },
    }),
  };

  try {
    const primary = await runScanWith(root, 'codex', 'primary', options);

    assert.equal(overlap.status, 'queued');
    assert.equal(primary.ok, true);
    assert.equal(collectionCalls, 1);
    const queued = projectScanQueue(root).requests[0];
    assert.equal(queued.status, 'skipped');
    assert.equal(queued.requester, 'scheduled');
    assert.equal(queued.execution.scheduleId, 'codex-primary');
    assert.equal(queued.execution.logicalWindowId, options.logicalWindowId);
    assert.equal(
      Date.parse(queued.expiresAt),
      Math.min(Date.parse(queued.requestedAt) + 12 * 60 * 60 * 1000, Date.parse(queued.windowAt)),
    );
    const runs = fs.readdirSync(path.join(root, '.scout', 'runs'));
    assert.equal(runs.length, 1);
    for (const runId of runs) {
      const events = replayRunJournal(path.join(root, '.scout', 'runs', runId, 'journal.jsonl'));
      assert.equal(events[0].type, 'run.started');
      assert.equal(events[0].payload.compatibility.scheduleJobId, 'codex-primary');
      assert.equal(events[0].payload.compatibility.logicalWindowId, options.logicalWindowId);
      assert.equal(events.at(-1).type, 'run.completed');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a scheduled queued run remains bound to its claimed inputs when workspace config changes during execution', async () => {
  const root = scanRoot();
  let collectionCalls = 0;
  let overlap;
  const options = {
    requester: 'scheduled',
    windowAt: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
    scheduleId: 'codex-primary',
    logicalWindowId: new Date(Date.now() - 60 * 1000).toISOString(),
    providerStatusFn: authenticated,
    collectSourcesFn: async () => {
      collectionCalls += 1;
      if (collectionCalls === 1) {
        overlap = await runScanWith(root, 'codex', 'primary', {
          ...options,
          logicalWindowId: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        });
      } else {
        const config = loadWorkspaceConfig(root);
        writeWorkspaceConfig(root, {
          ...config,
          triage: { ...config.triage, checkScore: Number(config.triage.checkScore) + 1 },
        });
      }
      return {
        generatedAt: '2026-07-28T09:00:00.000Z',
        queries: [],
        sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
      };
    },
    runStructuredTurnFn: async () => {
      throw new Error('empty queued scans must not call the provider');
    },
    checkLivenessFn: async (candidates) => ({
      live: candidates,
      removed: [],
      summary: { checked: candidates.length, gone: 0, unverified: 0 },
    }),
  };

  try {
    const primary = await runScanWith(root, 'codex', 'primary', options);

    assert.equal(overlap.status, 'queued');
    assert.equal(primary.ok, true);
    assert.equal(collectionCalls, 2);
    assert.equal(projectScanQueue(root).requests[0].status, 'succeeded');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a queued keeper run completes against its claim-time tracker input instead of staling on its own mutation', async () => {
  const root = scanRoot();
  enableRankedDiscovery(root);
  let collectionCalls = 0;
  let overlap;
  const options = {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => {
      collectionCalls += 1;
      if (collectionCalls === 1) {
        overlap = await runScanWith(root, 'codex', 'primary', options);
        return {
          generatedAt: '2026-07-28T09:00:00.000Z',
          queries: [],
          sources: { hiring_cafe: { configured: true, status: 'healthy', count: 0, jobs: [] } },
        };
      }
      return {
        generatedAt: '2026-07-28T09:01:00.000Z',
        queries: [],
        sources: {
          hiring_cafe: {
            configured: true,
            status: 'healthy',
            count: 1,
            jobs: [{
              company: 'Keeper Co',
              title: 'Ideal Role',
              url: 'https://PRIVATE_USER:PRIVATE_PASSWORD@example.test/jobs/keeper'
                + '?session=PRIVATE_SESSION&redirect=https%3A%2F%2Fnested-user%3Anested-pass%40private.test%2Fpath'
                + '#PRIVATE_FRAGMENT',
            }],
          },
        },
      };
    },
    runStructuredTurnFn: async ({ prompt, validate }) => {
      const context = JSON.parse(prompt.split('\n\n').at(-1));
      const value = assessmentFor(context.candidates);
      validate(value);
      return { value, usage: {} };
    },
    checkLivenessFn: async (candidates) => ({
      live: candidates,
      removed: [],
      summary: { checked: candidates.length, gone: 0, unverified: 0 },
    }),
    queueWorkspaceSyncFn: async () => {},
  };
  try {
    const primary = await runScanWith(root, 'codex', 'primary', options);

    assert.equal(primary.ok, true);
    assert.equal(overlap.status, 'queued');
    assert.equal(collectionCalls, 2);
    assert.equal(projectScanQueue(root).requests[0].status, 'succeeded');
    const tracker = JSON.parse(fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8'));
    assert.equal(tracker.opportunities[0].company, 'Keeper Co');
    const scanInput = fs.readdirSync(path.join(root, '.scout', 'scan-input'))
      .map((name) => fs.readFileSync(path.join(root, '.scout', 'scan-input', name), 'utf8'))
      .join('\n');
    assert.match(scanInput, /https:\/\/example\.test\/jobs\/keeper/);
    assert.doesNotMatch(
      scanInput,
      /PRIVATE_USER|PRIVATE_PASSWORD|PRIVATE_SESSION|PRIVATE_FRAGMENT|nested-user|nested-pass|[?#]session=/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime scan preserves an evidence-rich profile larger than the former per-file limit', async () => {
  const root = scanRoot();
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cv'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'p'.repeat(41_154));
  fs.writeFileSync(path.join(root, 'profile', 'calibration.md'), 'calibration');
  fs.writeFileSync(path.join(root, 'cv', 'master-cv.md'), 'master CV');
  let profileLength = 0;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({
      generatedAt: '2026-07-17T10:00:00Z', queries: ['engineer'],
      sources: { hiring_cafe: { configured: true, status: 'healthy', count: 1, jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://example.test/job' }] } },
    }),
    runStructuredTurnFn: async ({ prompt }) => {
      const context = JSON.parse(prompt.split('\n\n').at(-1));
      profileLength = context.profile.length;
      return {
        value: { assessments: [{
          candidateId: 'candidate-001', categoryId: null, summary: 'Evidence-backed match',
          hardExclusionMatches: [], mandatoryRequirements: [],
          dimensions: [{ name: 'fit', score: 80, maximum: 100, evidence: 'Profile evidence' }], recommendation: 'keep',
        }] },
        usage: { input_tokens: 12_000 },
      };
    },
    acquireLockFn: () => ({ ok: true, lock: { token: 'test' } }),
    releaseLockFn: () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(profileLength, 41_154);
});

test('runtime scan bounds the complete assembled context before calling a provider', async () => {
  const root = scanRoot();
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'cv'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'p'.repeat(100_000));
  fs.writeFileSync(path.join(root, 'profile', 'calibration.md'), 'c'.repeat(90_000));
  fs.writeFileSync(path.join(root, 'cv', 'master-cv.md'), 'v'.repeat(90_000));
  let providerCalls = 0;
  const result = await runScanWith(root, 'codex', 'primary', {
    providerStatusFn: authenticated,
    collectSourcesFn: async () => ({
      generatedAt: '2026-07-17T10:00:00Z', queries: ['engineer'],
      sources: { hiring_cafe: { configured: true, status: 'healthy', count: 1, jobs: [{ company: 'Acme', title: 'Engineer', url: 'https://example.test/job' }] } },
    }),
    runStructuredTurnFn: async () => { providerCalls += 1; throw new Error('provider must not run'); },
    acquireLockFn: () => ({ ok: true, lock: { token: 'test' } }),
    releaseLockFn: () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /assembled scan context exceeds Scout's 280,000-character limit/);
  assert.equal(providerCalls, 0);
});
