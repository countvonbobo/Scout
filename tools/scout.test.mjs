import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { broadenSearchQueries, collectScanSources, migrateLegacyWorkspace, runScanWith, shouldAutoBroaden } from './scout.mjs';
import { DEFAULT_WORKSPACE_CONFIG, writeWorkspaceConfig } from '../ui/lib/workspace.mjs';
import { publishSearchProfile } from '../ui/lib/searchProfile.mjs';

function scanRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-runtime-scan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"updated":"2026-07-14","opportunities":[]}\n');
  writeWorkspaceConfig(root, { ...structuredClone(DEFAULT_WORKSPACE_CONFIG), ai: { provider: 'codex', model: null } });
  return root;
}

const authenticated = () => ({ installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } });

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
  assert.equal(providerCalls, 0);
  assert.equal(released, true);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
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
  assert.equal(result.ok, true);
  assert.equal(result.scan.candidates_found, 0);
  assert.equal(result.scan.discarded.hard_exclusion, 1);
  assert.equal(providerCalls, 0);
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
  assert.match(fs.readFileSync(path.join(root, 'data', 'scan-runs.jsonl'), 'utf8'), /bounded provider failed/);
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
