import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  draftProfileFromLegacy,
  loadPublishedSearchProfile,
  migrateSearchProfile,
  profileFingerprint,
  publishSearchProfile,
} from './searchProfile.mjs';
import { workspacePaths } from './workspace.mjs';

const NOW = '2026-07-26T20:00:00.000Z';
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-search-profile-'));
  roots.push(root);
  return root;
}

function genericProfileDraft({ primaryTitles = [], excludedTitles = [], compensation = {} } = {}) {
  return {
    version: 1,
    status: 'draft',
    target: {
      primaryTitles,
      locations: [],
      sectors: [],
    },
    negative: {
      excludedTitles,
      excludedResponsibilities: [],
    },
    compensation: {
      currency: null,
      period: 'year',
      minimum: null,
      minimumStrength: 'neutral',
      unknownPolicy: 'include',
      ...compensation,
    },
  };
}

test('published profile preserves strengths, provenance and unknown policies', () => {
  const draft = genericProfileDraft({
    primaryTitles: [{ value: 'Commercial solicitor', strength: 'mandatory', provenance: 'explicit' }],
    compensation: { currency: 'EUR', period: 'day', minimum: 450, minimumStrength: 'strong-preference', unknownPolicy: 'include' },
  });
  const profile = publishSearchProfile(draft, { publishedAt: NOW });
  assert.equal(profile.version, 1);
  assert.equal(profile.target.primaryTitles[0].provenance, 'explicit');
  assert.equal(profile.compensation.period, 'day');
  assert.equal(profile.compensation.unknownPolicy, 'include');
  assert.match(profile.id, /^profile-[a-f0-9]{12}$/);
});

test('unconfirmed inference cannot publish as a hard exclusion', () => {
  const draft = genericProfileDraft({
    excludedTitles: [{ value: 'Manager', strength: 'hard-exclusion', provenance: 'unconfirmed-inference' }],
  });
  assert.throws(() => publishSearchProfile(draft, { publishedAt: NOW }), /hard exclusion.*confirmation/i);
});

test('legacy preferences become a conservative, reviewable draft', () => {
  const draft = draftProfileFromLegacy({
    locale: 'en-GB',
    currency: 'GBP',
    search: {
      roleFamilies: ['Hardware Engineer'],
      locations: ['Reading'],
      exclusions: ['Pure software roles'],
      salaryMinimum: 60000,
    },
  }, 'user-authored profile prose');

  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.target.primaryTitles[0], {
    value: 'Hardware Engineer', strength: 'strong-preference', provenance: 'deterministic-derivation',
  });
  assert.deepEqual(draft.target.locations[0], {
    value: 'Reading', strength: 'strong-preference', provenance: 'deterministic-derivation',
  });
  assert.equal(draft.negative.excludedResponsibilities[0].strength, 'strong-negative');
  assert.notEqual(draft.negative.excludedResponsibilities[0].strength, 'hard-exclusion');
  assert.equal(draft.compensation.minimumStrength, 'strong-preference');
  assert.equal(draft.compensation.unknownPolicy, 'include');
});

test('compensation cannot publish as a hard exclusion without confirmation provenance', () => {
  const draft = genericProfileDraft({
    compensation: { minimum: 450, minimumStrength: 'hard-exclusion' },
  });
  assert.throws(() => publishSearchProfile(draft, { publishedAt: NOW }), /compensation.*hard exclusion/i);
});

test('published profiles recursively freeze nested arrays and plain objects', () => {
  const profile = publishSearchProfile(genericProfileDraft({
    primaryTitles: [{ value: 'Researcher', strength: 'mandatory', provenance: 'explicit' }],
  }), { publishedAt: NOW });

  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.target));
  assert.ok(Object.isFrozen(profile.target.primaryTitles));
  assert.ok(Object.isFrozen(profile.target.primaryTitles[0]));
  assert.throws(() => { profile.target.primaryTitles[0].value = 'Changed'; }, TypeError);
});

test('profile fingerprints use canonical JSON key ordering', () => {
  const one = { target: { primaryTitles: [] }, version: 1 };
  const two = { version: 1, target: { primaryTitles: [] } };
  const expected = crypto.createHash('sha256').update('{"target":{"primaryTitles":[]},"version":1}').digest('hex');
  assert.equal(profileFingerprint(one), expected);
  assert.equal(profileFingerprint(two), expected);
});

test('loadPublishedSearchProfile returns an immutable published artifact when present', () => {
  const root = temp();
  const profile = publishSearchProfile(genericProfileDraft(), { publishedAt: NOW });
  const file = workspacePaths(root).searchProfilePublished;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(profile)}\n`);

  const loaded = loadPublishedSearchProfile(root);
  assert.equal(loaded.id, profile.id);
  assert.ok(Object.isFrozen(loaded.compensation));
});

test('loadPublishedSearchProfile rejects a syntactically valid but tampered profile id', () => {
  const root = temp();
  const profile = publishSearchProfile(genericProfileDraft(), { publishedAt: NOW });
  const file = workspacePaths(root).searchProfilePublished;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...profile, id: 'profile-000000000000' })}\n`);

  assert.throws(() => loadPublishedSearchProfile(root), /fingerprint/i);
});

test('loadPublishedSearchProfile returns null when no artifact is present', () => {
  assert.equal(loadPublishedSearchProfile(temp()), null);
});

test('migration stages byte-preserved legacy evidence in an unpublished draft', () => {
  const root = temp();
  const workspaceJson = '{\n  "schemaVersion": 2,\n  "locale": "en-GB",\n  "currency": "GBP",\n  "search": { "roleFamilies": ["Hardware Engineer"], "locations": ["Reading"], "exclusions": ["Pure software roles"], "salaryMinimum": 60000 }\n}\n';
  const context = 'User-authored profile prose\r\nKeep this exact.\r\n';
  fs.writeFileSync(path.join(root, 'workspace.json'), workspaceJson);
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), context);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(root, 'applications', 'example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"existing":true}\n');
  fs.writeFileSync(path.join(root, 'reports', '2026-07-26.md'), 'Existing report\n');
  fs.writeFileSync(path.join(root, 'applications', 'example', 'outreach.md'), 'Existing application\n');

  const result = migrateSearchProfile(root);
  const paths = workspacePaths(root);
  const raw = JSON.parse(fs.readFileSync(paths.searchProfileRaw, 'utf8'));
  const draft = JSON.parse(fs.readFileSync(paths.searchProfileDraft, 'utf8'));

  assert.equal(result.migrated, true);
  assert.equal(result.draftPath, paths.searchProfileDraft);
  assert.match(result.backupPath, /search-profile-v1\.json$/);
  assert.equal(raw.workspaceJson, workspaceJson);
  assert.equal(raw.context, context);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.target.primaryTitles[0].provenance, 'deterministic-derivation');
  assert.equal(draft.negative.excludedResponsibilities[0].strength, 'strong-negative');
  assert.equal(draft.compensation.minimumStrength, 'strong-preference');
  assert.equal(draft.compensation.unknownPolicy, 'include');
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.config, 'utf8')).searchProfile, {
    publishedId: null,
  });
  assert.equal(fs.readFileSync(paths.tracker, 'utf8'), '{"existing":true}\n');
  assert.equal(fs.readFileSync(path.join(paths.reports, '2026-07-26.md'), 'utf8'), 'Existing report\n');
  assert.equal(fs.readFileSync(path.join(paths.applications, 'example', 'outreach.md'), 'utf8'), 'Existing application\n');
  assert.equal(fs.readFileSync(paths.profileContext, 'utf8'), context);
  assert.deepEqual(migrateSearchProfile(root), {
    migrated: false, draftPath: paths.searchProfileDraft, backupPath: null,
  });
});

test('migration is idempotent when a draft or published profile already exists', () => {
  const root = temp();
  fs.writeFileSync(path.join(root, 'workspace.json'), '{"locale":"en-GB","search":{}}\n');
  const paths = workspacePaths(root);
  fs.mkdirSync(path.dirname(paths.searchProfileDraft), { recursive: true });
  fs.writeFileSync(paths.searchProfileDraft, '{"status":"draft"}\n');

  const result = migrateSearchProfile(root);

  assert.deepEqual(result, { migrated: false, draftPath: paths.searchProfileDraft, backupPath: null });
  assert.equal(fs.existsSync(paths.searchProfileRaw), false);
});

test('migration leaves the legacy config untouched when its paired artifact swap fails', () => {
  const root = temp();
  const workspaceJson = '{"locale":"en-GB","search":{}}\n';
  fs.writeFileSync(path.join(root, 'workspace.json'), workspaceJson);
  const searchDirectory = path.dirname(workspacePaths(root).searchProfileRaw);
  const fileSystem = {
    ...fs,
    renameSync(source, destination) {
      if (destination === searchDirectory) throw new Error('simulated directory swap failure');
      return fs.renameSync(source, destination);
    },
  };

  assert.throws(() => migrateSearchProfile(root, { fileSystem }), /simulated directory swap failure/);
  assert.equal(fs.readFileSync(path.join(root, 'workspace.json'), 'utf8'), workspaceJson);
  assert.equal(fs.existsSync(searchDirectory), false);
});
