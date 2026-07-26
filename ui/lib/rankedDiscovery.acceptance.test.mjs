import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  commercialSolicitorProfile,
  hospitalAdministratorProfile,
  hospitalityWorkerProfile,
  mechanicalGraduateProfile,
  retailManagerProfile,
  softwareDeveloperProfile,
} from './fixtures/searchProfiles.mjs';
import { prepareRankedDiscovery } from './scanPipeline.mjs';
import { migrateSearchProfile } from './searchProfile.mjs';
import { workspacePaths } from './workspace.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-ranked-discovery-'));
  roots.push(root);
  return root;
}

function sourceJob({ vacancyId, title, arrangement, compensation = null }) {
  const job = {
    company: `${vacancyId} employer`,
    title,
    location: `${vacancyId} location`,
    workingPattern: arrangement,
    employmentType: 'permanent',
    providerId: vacancyId,
    url: `https://jobs.example.test/${vacancyId}`,
    description: `${title} position with ${arrangement} work.`,
  };
  if (compensation) Object.assign(job, {
    salaryMin: compensation.minimum,
    salaryMax: compensation.minimum + 10,
    salaryCurrency: compensation.currency,
    salaryPeriod: compensation.period,
  });
  return job;
}

function profileCases() {
  return [
    ['software-developer', softwareDeveloperProfile],
    ['hospital-administrator', hospitalAdministratorProfile],
    ['hospitality-worker', hospitalityWorkerProfile],
    ['commercial-solicitor', commercialSolicitorProfile],
    ['mechanical-graduate', mechanicalGraduateProfile],
    ['retail-manager', retailManagerProfile],
  ].map(([vacancyId, buildProfile]) => {
    const profile = buildProfile();
    const title = profile.target.primaryTitles[0].value;
    const arrangement = profile.target.workingPatterns[0].value;
    const compensation = profile.compensation;
    return {
      profile,
      expectedFirst: `https://jobs.example.test/${vacancyId}`,
      jobs: [
        sourceJob({ vacancyId: 'unrelated-role', title: 'Unrelated Role', arrangement: 'unspecified', compensation }),
        sourceJob({ vacancyId, title, arrangement, compensation }),
      ],
    };
  });
}

function discover(jobs, profile) {
  return prepareRankedDiscovery({
    sources: { acceptance: { count: jobs.length, jobs } },
    profile,
    tracker: { opportunities: [] },
    runId: 'acceptance-run',
    limit: 60,
  });
}

test('one generic engine produces different justified rankings for six profiles', () => {
  for (const fixture of profileCases()) {
    const result = discover(fixture.jobs, fixture.profile);
    assert.equal(result.ranked[0].vacancyId, fixture.expectedFirst);
    assert.ok(result.ranked.every((item) => item.dimensions.length > 0));
    assert.equal(result.funnel.ranked, result.funnel.eligible);
  }
});

test('published unknown-compensation policies change end-to-end discovery decisions', () => {
  const excludeProfile = hospitalityWorkerProfile();
  const excluded = discover([sourceJob({
    vacancyId: 'hospitality-worker',
    title: excludeProfile.target.primaryTitles[0].value,
    arrangement: excludeProfile.target.workingPatterns[0].value,
  })], excludeProfile);
  assert.equal(excluded.exclusions[0].code, 'compensation-unknown');
  assert.equal(excluded.funnel.eligible, 0);

  const penaliseProfile = hospitalAdministratorProfile();
  const job = sourceJob({
    vacancyId: 'hospital-administrator',
    title: penaliseProfile.target.primaryTitles[0].value,
    arrangement: penaliseProfile.target.workingPatterns[0].value,
  });
  const penalised = discover([job], penaliseProfile);
  const included = discover([job], {
    ...penaliseProfile,
    compensation: { ...penaliseProfile.compensation, unknownPolicy: 'include' },
  });
  const compensation = penalised.ranked[0].dimensions.find((dimension) => dimension.name === 'compensation');

  assert.ok(compensation.score < 0);
  assert.ok(penalised.ranked[0].preRankScore < included.ranked[0].preRankScore);
});

test('production-shaped legacy migration preserves unrelated private artifacts byte-for-byte', () => {
  const root = temporaryWorkspace();
  const workspaceJson = '{\r\n  "schemaVersion": 2,\r\n  "locale": "en-GB",\r\n  "currency": "GBP",\r\n  "search": { "roleFamilies": ["Research Engineer"], "locations": ["Example City"], "exclusions": ["Night shifts"], "salaryMinimum": 54000 }\r\n}\r\n';
  const artifacts = new Map([
    ['data/opportunities.json', Buffer.from('{"opportunities":[{"id":"existing-role-2026-07"}]}\r\n')],
    ['reports/2026-07-26.md', Buffer.from('# Existing report\r\n\r\nPrivate evidence stays unchanged.\r\n')],
    ['applications/example-role/cv.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])],
    ['applications/example-role/outreach.md', Buffer.from('Existing human-reviewed draft\n')],
  ]);
  fs.writeFileSync(path.join(root, 'workspace.json'), workspaceJson);
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'Exact legacy context\r\n');
  for (const [relative, bytes] of artifacts) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }

  const result = migrateSearchProfile(root);
  const paths = workspacePaths(root);

  assert.equal(result.migrated, true);
  assert.equal(JSON.parse(fs.readFileSync(paths.searchProfileDraft, 'utf8')).status, 'draft');
  assert.equal(JSON.parse(fs.readFileSync(paths.searchProfileRaw, 'utf8')).workspaceJson, workspaceJson);
  for (const [relative, bytes] of artifacts) assert.ok(fs.readFileSync(path.join(root, relative)).equals(bytes), relative);
});
