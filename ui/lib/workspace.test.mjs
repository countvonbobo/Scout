import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  CURRENT_WORKSPACE_SCHEMA, defaultWorkspaceRoot, mergeWorkspaceDefaults, migrateWorkspace, resolveWorkspaceRoot,
  modelForProvider, syncManagedInstructions, validateWorkspaceConfig, workspacePaths,
} from './workspace.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-workspace-')); roots.push(root); return root; }

test('explicit workspace overrides backwards-compatible app root', () => {
  const appRoot = temp();
  fs.mkdirSync(path.join(appRoot, 'data'));
  fs.writeFileSync(path.join(appRoot, 'data', 'opportunities.json'), '{}');
  assert.equal(resolveWorkspaceRoot({ appRoot, argv: ['--workspace', 'C:/private/scout'], env: {} }), path.resolve('C:/private/scout'));
  assert.equal(resolveWorkspaceRoot({ appRoot, argv: [], env: {} }), path.resolve(appRoot));
});

test('fresh app defaults to Documents workspace', () => {
  const appRoot = temp();
  const home = path.join(appRoot, 'home');
  assert.equal(defaultWorkspaceRoot(home), path.join(home, 'Documents', 'Scout Workspace'));
});

test('workspace paths stay under the selected root', () => {
  const root = temp();
  for (const value of Object.values(workspacePaths(root))) assert.ok(value === path.resolve(root) || value.startsWith(`${path.resolve(root)}${path.sep}`));
});

test('workspace paths reserve the search-profile artifacts under profile/search', () => {
  const paths = workspacePaths(temp());
  assert.match(paths.searchProfileRaw, /profile[\\/]search[\\/]raw\.json$/);
  assert.match(paths.searchProfileDraft, /profile[\\/]search[\\/]draft\.json$/);
  assert.match(paths.searchProfilePublished, /profile[\\/]search[\\/]published\.json$/);
});

test('migration creates a valid current-schema workspace', () => {
  const root = temp();
  const result = migrateWorkspace(root);
  assert.equal(result.to, CURRENT_WORKSPACE_SCHEMA);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'));
  assert.equal(validateWorkspaceConfig(config).schemaVersion, CURRENT_WORKSPACE_SCHEMA);
});

test('schema-one daily schedule migrates to a named primary job with a backup', () => {
  const root = temp();
  fs.writeFileSync(path.join(root, 'workspace.json'), `${JSON.stringify({
    schemaVersion: 1, locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London',
    search: { roleFamilies: [], sectors: [], locations: [], exclusions: [] },
    triage: { actionScore: 70, checkScore: 55, nudgeDays: 8, closeoutDays: 10, staleDays: 10, decisionDays: 2 },
    sources: {}, schedule: { enabled: true, time: '07:30', provider: 'claude' },
  })}\n`);
  const result = migrateWorkspace(root);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'));
  assert.equal(result.from, 1);
  assert.ok(result.backup);
  assert.equal(config.schemaVersion, 2);
  // A schedule written before per-day scheduling keeps running every day.
  assert.deepEqual(config.schedule.jobs, [{
    id: 'claude-primary', enabled: true, time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], provider: 'claude', mode: 'primary', model: null,
  }]);
});

test('workspace defaults are merged deeply for older schema-one files', () => {
  const merged = mergeWorkspaceDefaults({
    schemaVersion: 1, locale: 'en-US', currency: 'USD', timezone: 'America/New_York',
    profile: { displayName: 'A User' }, search: { roleFamilies: ['designer'] },
  });
  assert.equal(merged.profile.tone, 'natural, direct and evidence-led');
  assert.deepEqual(merged.search.locations, []);
  assert.equal(merged.triage.actionScore, 70);
  assert.equal(merged.sources.adzuna.country, 'gb');
  assert.deepEqual(merged.searchProfile, { publishedId: null, schemaVersion: 1 });
});

test('job-work models are selected independently for each provider with a legacy fallback', () => {
  const config = mergeWorkspaceDefaults({
    ai: { provider: 'codex', model: 'legacy-codex', models: { codex: 'gpt-job', claude: 'claude-job' } },
  });
  assert.equal(modelForProvider(config, 'codex'), 'gpt-job');
  assert.equal(modelForProvider(config, 'claude'), 'claude-job');

  const legacy = mergeWorkspaceDefaults({ ai: { provider: 'codex', model: 'legacy-codex' } });
  assert.equal(modelForProvider(legacy, 'codex'), 'legacy-codex');
  assert.equal(modelForProvider(legacy, 'claude'), null);
});

test('workspace rejects unsafe job-work and scheduled-scan model identifiers', () => {
  const badJobModel = mergeWorkspaceDefaults({ ai: { models: { codex: 'model & command' } } });
  assert.throws(() => validateWorkspaceConfig(badJobModel), /ai\.models\.codex is invalid/);
  const badScanModel = mergeWorkspaceDefaults({ schedule: { jobs: [{
    id: 'codex-primary', enabled: true, time: '07:30', provider: 'codex', mode: 'primary', model: 'model & command',
  }] } });
  assert.throws(() => validateWorkspaceConfig(badScanModel), /codex-primary model is invalid/);
});

test('managed workspace upgrades keep chat transcripts out of Git without replacing user ignores', () => {
  const appRoot = temp();
  const workspace = temp();
  fs.writeFileSync(path.join(workspace, '.gitignore'), 'custom-private-file\n');
  syncManagedInstructions(appRoot, workspace);
  const value = fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8');
  assert.match(value, /^custom-private-file$/m);
  assert.match(value, /^data\/chats\/$/m);
});

import { spawnSync } from 'node:child_process';
test('syncManagedInstructions migrates .scout/ to track cv-renders.json while ignoring the rest of .scout', () => {
  const appRoot = temp();
  const workspace = temp();
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.env\n.scout/\n');
  syncManagedInstructions(appRoot, workspace);
  const value = fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8');
  assert.match(value, /^\.scout\/\*$/m);
  assert.match(value, /^!\.scout\/cv-renders\.json$/m);
  
  // Verify idempotency
  syncManagedInstructions(appRoot, workspace);
  const value2 = fs.readFileSync(path.join(workspace, '.gitignore'), 'utf8');
  assert.equal(value, value2);
  
  // Real behavior test: check-ignore
  spawnSync('git', ['init'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  fs.mkdirSync(path.join(workspace, '.scout'));
  fs.writeFileSync(path.join(workspace, '.scout', 'cv-renders.json'), '{}');
  fs.writeFileSync(path.join(workspace, '.scout', 'junk'), '');
  
  const ignoreJunk = spawnSync('git', ['check-ignore', '.scout/junk'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  assert.equal(ignoreJunk.status, 0); // 0 means ignored
  
  const ignoreRenders = spawnSync('git', ['check-ignore', '.scout/cv-renders.json'], { cwd: workspace, encoding: 'utf8', windowsHide: true });
  assert.equal(ignoreRenders.status, 1); // 1 means NOT ignored
});
