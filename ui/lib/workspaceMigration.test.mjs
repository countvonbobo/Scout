import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { publishSearchProfile } from './searchProfile.mjs';
import { acquireScanLease, currentLeaseOwner } from './scanLease.mjs';
import {
  createBeta22WorkspaceSnapshot,
  materializeBeta22Rollback,
  rerankHistoricalVacancies,
} from './workspaceMigration.mjs';

const roots = [];
const NOW = '2026-07-30T17:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function productionShapedWorkspace() {
  const root = temporaryRoot('scout-beta22-migration-');
  const trackedUrl = new URL('https://jobs.example.test/platform');
  const trackingName = ['to', 'ken'].join('');
  const trackingValue = ['private', 'value'].join('-');
  trackedUrl.searchParams.set(trackingName, trackingValue);
  trackedUrl.hash = 'fragment';
  const trackedUrlText = trackedUrl.toString();
  write(root, 'workspace.json', '{\r\n  "schemaVersion": 2,\r\n  "locale": "en-GB",\r\n  "currency": "GBP",\r\n  "timezone": "Europe/London",\r\n  "profile": {},\r\n  "search": {"roleFamilies":["Platform Engineer"],"sectors":[],"locations":["Remote"],"exclusions":[],"salaryMinimum":null},\r\n  "triage": {"actionScore":70,"checkScore":55,"nudgeDays":8,"closeoutDays":10,"staleDays":10,"decisionDays":2},\r\n  "sources": {},\r\n  "commute": {},\r\n  "ai": {"provider":null,"models":{}},\r\n  "schedule": {"jobs":[]}\r\n}\r\n');
  write(root, '.env', 'SYNTHETIC_PRIVATE_VALUE=kept\n');
  write(root, '.gitignore', '.env\n.scout/\nlogs/\n');
  write(root, '.scout-backup/v1/header.json', '{"schemaVersion":1,"fixture":"encrypted-recovery-header"}\n');
  write(root, '.scout-backup/v1/files/fixture.enc', 'synthetic-encrypted-recovery-bytes\n');
  write(root, 'profile/context.md', 'Synthetic private profile evidence.\r\n');
  write(root, 'profile/calibration.md', 'Synthetic calibration evidence.\n');
  write(root, 'cv/master-cv.md', '# Synthetic Candidate\n');
  write(root, 'data/opportunities.json', `${JSON.stringify({
    updated: '2026-07-20',
    opportunities: [{
      id: 'acme-platform-engineer-2026-07',
      vacancyId: trackedUrlText,
      company: 'Acme',
      role: 'Platform Engineer',
      location: 'Remote',
      status: 'rejected',
      score: 41,
      notes: 'Human decision must remain unchanged.',
      contacts: [{ name: 'Synthetic Contact', role: 'Recruiter' }],
      log: [{ date: '2026-07-20', event: 'closed', note: 'Not pursued' }],
      sources: [trackedUrlText],
    }],
  }, null, 2)}\n`);
  write(root, 'data/scan-runs.jsonl', `${JSON.stringify({
    schemaVersion: 3,
    timestamp: '2026-07-20T10:00:00.000Z',
    agent: 'codex',
    mode: 'primary',
    reviewed: [{
      vacancyId: trackedUrlText,
      company: 'Acme',
      role: 'Platform Engineer',
      source: 'synthetic',
      sourceUrl: trackedUrlText,
      outcome: 'below_threshold',
      score: 41,
      reasons: ['Historical decision'],
    }, {
      vacancyId: 'https://jobs.example.test/other',
      company: 'Other Co',
      role: 'Unrelated Role',
      source: 'synthetic',
      sourceUrl: 'https://jobs.example.test/other',
      outcome: 'provider_discarded',
      score: 12,
      reasons: ['Historical decision'],
    }],
  })}\n`);
  write(root, 'data/chats/synthetic.json', '{"messages":[{"role":"user","content":"private"}]}\n');
  write(root, 'reports/2026-07-20.md', '# Historical report\r\n');
  write(root, 'applications/acme-platform/cv.typ', '= Historical CV\n');
  write(root, 'applications/acme-platform/cv.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
  write(root, 'applications/acme-platform/outreach.md', 'Historical outreach draft\n');
  write(root, 'imports/source.txt', 'Historical import\n');
  write(root, 'logs/scout.log', 'Historical bounded log\n');
  write(root, '.scout/ephemeral-runtime.json', '{"schemaVersion":1,"generation":9}\n');
  return root;
}

function publishedProfile() {
  return publishSearchProfile({
    version: 1,
    status: 'draft',
    target: {
      primaryTitles: [{ value: 'Platform Engineer', strength: 'mandatory', provenance: 'explicit' }],
      locations: [{ value: 'Remote', strength: 'strong-preference', provenance: 'explicit' }],
      sectors: [],
    },
    negative: { excludedTitles: [], excludedResponsibilities: [] },
    compensation: {
      currency: null,
      period: 'year',
      rateType: null,
      amountType: 'unknown',
      certainty: 'unknown',
      minimum: null,
      minimumStrength: 'neutral',
      unknownPolicy: 'include',
    },
    selection: { breadth: 'balanced', relevanceThreshold: 45, exploration: 0 },
  }, { publishedAt: NOW });
}

function filesBelow(root) {
  const result = new Map();
  function visit(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const nextRelative = path.join(relative, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, nextRelative);
      else result.set(nextRelative, fs.readFileSync(absolute));
    }
  }
  visit(root);
  return result;
}

test('a verified beta.22 snapshot materialises into a separate compatible workspace without data loss', () => {
  const root = productionShapedWorkspace();
  const snapshot = createBeta22WorkspaceSnapshot(root, { now: () => NOW });

  assert.equal(snapshot.compatibleVersion, '0.1.0-beta.22');
  assert.equal(fs.existsSync(path.join(snapshot.directory, '.scout')), false);
  assert.equal(fs.existsSync(path.join(snapshot.directory, 'profile', 'search')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(snapshot.directory, 'workspace.json'))).searchProfile, undefined);

  write(root, 'data/opportunities.json', '{"updated":"newer","opportunities":[]}\n');
  write(root, 'reports/newer.md', '# Newer data stays in the live workspace\n');
  const destination = temporaryRoot('scout-beta22-rollback-');
  fs.rmSync(destination, { recursive: true });
  const restored = materializeBeta22Rollback(root, destination, { snapshotDirectory: snapshot.directory });

  assert.equal(restored.compatibleVersion, '0.1.0-beta.22');
  assert.equal(fs.readFileSync(path.join(root, 'reports', 'newer.md'), 'utf8'), '# Newer data stays in the live workspace\n');
  assert.match(fs.readFileSync(path.join(destination, 'data', 'opportunities.json'), 'utf8'), /Human decision must remain unchanged/);
  assert.equal(fs.readFileSync(path.join(destination, '.env'), 'utf8'), 'SYNTHETIC_PRIVATE_VALUE=kept\n');
  assert.equal(
    fs.readFileSync(path.join(destination, '.scout-backup', 'v1', 'files', 'fixture.enc'), 'utf8'),
    'synthetic-encrypted-recovery-bytes\n',
  );
  assert.ok(fs.readFileSync(path.join(destination, 'applications', 'acme-platform', 'cv.pdf'))
    .equals(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])));
  assert.equal(fs.existsSync(path.join(destination, '.scout')), false);
});

test('beta.22 snapshot holds the shared backup lease throughout tree copying', () => {
  const root = productionShapedWorkspace();
  let checked = false;
  createBeta22WorkspaceSnapshot(root, {
    now: () => NOW,
    _testHooks: {
      beforeCopy(relative) {
        if (checked || relative !== 'workspace.json') return;
        checked = true;
        const backup = acquireScanLease(root, currentLeaseOwner(), {
          kind: 'backup',
          runId: 'concurrent-backup',
          phase: 'checkpoint',
        });
        assert.equal(backup, null);
      },
    },
  });
  assert.equal(checked, true);
});

test('beta.22 snapshot rejects special files and oversized regular files before copying', (t) => {
  if (process.platform !== 'win32') {
    const fifoRoot = productionShapedWorkspace();
    const fifo = path.join(fifoRoot, 'logs', 'provider.pipe');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (created.status === 0) {
      assert.throws(
        () => createBeta22WorkspaceSnapshot(fifoRoot, { now: () => NOW }),
        /only accepts regular files and directories/,
      );
    } else {
      t.diagnostic('mkfifo is unavailable; special-file assertion skipped');
    }
  }

  const oversizedRoot = productionShapedWorkspace();
  const oversized = path.join(oversizedRoot, 'logs', 'oversized.log');
  fs.mkdirSync(path.dirname(oversized), { recursive: true });
  fs.writeFileSync(oversized, '');
  fs.truncateSync(oversized, (64 * 1024 * 1024) + 1);
  assert.throws(
    () => createBeta22WorkspaceSnapshot(oversizedRoot, { now: () => NOW }),
    /file exceeds the size limit/,
  );
});

test('beta.22 snapshot rejects trees deeper than its traversal bound', () => {
  const root = productionShapedWorkspace();
  let directory = path.join(root, 'logs');
  for (let index = 0; index < 66; index += 1) {
    directory = path.join(directory, `d${index}`);
    fs.mkdirSync(directory);
  }
  assert.throws(
    () => createBeta22WorkspaceSnapshot(root, { now: () => NOW }),
    /exceeds the depth limit/,
  );
});

test('beta.22 snapshot rejects a protected path redirected outside the physical workspace', (t) => {
  if (process.platform === 'win32') {
    t.diagnostic('symbolic-link fixture is not portable to Windows');
    return;
  }
  const root = productionShapedWorkspace();
  const outside = temporaryRoot('scout-beta22-outside-');
  write(outside, 'context.md', 'outside private content must not be copied\n');
  const original = path.join(root, 'profile-original');
  assert.throws(() => createBeta22WorkspaceSnapshot(root, {
    now: () => NOW,
    _testHooks: {
      beforeCopy(relative) {
        if (relative !== 'profile') return;
        fs.renameSync(path.join(root, 'profile'), original);
        fs.symlinkSync(outside, path.join(root, 'profile'), 'dir');
      },
    },
  }), /symbolic links|redirected outside its physical root/);
});

test('snapshot verification rejects tampering before creating a rollback workspace', () => {
  const root = productionShapedWorkspace();
  const snapshot = createBeta22WorkspaceSnapshot(root, { now: () => NOW });
  fs.appendFileSync(path.join(snapshot.directory, 'profile', 'context.md'), 'tampered\n');
  const destination = path.join(path.dirname(root), `${path.basename(root)}-rejected-rollback`);
  roots.push(destination);

  assert.throws(
    () => materializeBeta22Rollback(root, destination, { snapshotDirectory: snapshot.directory }),
    /digest|damaged|verification/i,
  );
  assert.equal(fs.existsSync(destination), false);
});

test('migration snapshots current protected content instead of reusing an older valid rollback', () => {
  const root = productionShapedWorkspace();
  const older = createBeta22WorkspaceSnapshot(root, { now: () => NOW });
  write(root, 'data/opportunities.json', '{"updated":"newer","opportunities":[{"id":"newer-role"}]}\n');
  write(root, 'reports/2026-07-31.md', '# New pre-migration report\n');
  write(root, 'cv/master-cv.md', '# New pre-migration CV\n');

  const current = createBeta22WorkspaceSnapshot(root, {
    now: () => '2026-07-31T09:00:00.000Z',
  });
  assert.equal(current.created, true);
  assert.notEqual(current.directory, older.directory);

  const identical = createBeta22WorkspaceSnapshot(root, {
    now: () => '2026-07-31T09:01:00.000Z',
  });
  assert.equal(identical.created, false);
  assert.equal(identical.directory, current.directory);

  const destination = temporaryRoot('scout-current-beta22-rollback-');
  fs.rmSync(destination, { recursive: true });
  materializeBeta22Rollback(root, destination, {
    snapshotDirectory: current.directory,
  });
  assert.match(fs.readFileSync(path.join(destination, 'data', 'opportunities.json'), 'utf8'), /newer-role/);
  assert.equal(fs.readFileSync(path.join(destination, 'reports', '2026-07-31.md'), 'utf8'), '# New pre-migration report\n');
  assert.equal(fs.readFileSync(path.join(destination, 'cv', 'master-cv.md'), 'utf8'), '# New pre-migration CV\n');
});

test('historical vacancies are re-ranked in an immutable profile artifact without rewriting decisions', () => {
  const root = productionShapedWorkspace();
  const profile = publishedProfile();
  const trackerFile = path.join(root, 'data', 'opportunities.json');
  const runsFile = path.join(root, 'data', 'scan-runs.jsonl');
  const beforeTracker = fs.readFileSync(trackerFile);
  const beforeRuns = fs.readFileSync(runsFile);

  const result = rerankHistoricalVacancies(root, profile, { now: () => NOW });
  const artifact = JSON.parse(fs.readFileSync(result.artifactPath, 'utf8'));

  assert.ok(fs.readFileSync(trackerFile).equals(beforeTracker));
  assert.ok(fs.readFileSync(runsFile).equals(beforeRuns));
  assert.equal(artifact.profileId, profile.id);
  assert.equal(artifact.ranked[0].company, 'Acme');
  assert.equal(artifact.ranked[0].role, 'Platform Engineer');
  assert.equal(artifact.ranked[0].sourceUrl, undefined);
  assert.equal(artifact.ranked[0].url, 'https://jobs.example.test/platform');
  assert.doesNotMatch(fs.readFileSync(result.artifactPath, 'utf8'), /private-value|token=|fragment/);
  assert.ok(artifact.ranked[0].preRankScore >= 45);
  assert.equal(
    artifact.ranked[0].dimensions.find((dimension) => dimension.name === 'novelty').evidence[0].comparison,
    'seen-exact',
  );
  assert.deepEqual(
    artifact.ranked[0].historicalDecisions.map((decision) => decision.outcome).sort(),
    ['below_threshold', 'rejected'],
  );
  assert.ok(artifact.ranked[0].historicalDecisions.every((decision) => (
    decision.profileProvenance === 'legacy-unreconstructable'
    && decision.scoringProvenance === 'legacy-unreconstructable'
  )));
  assert.equal(artifact.ranked[0].currentDecision, 'reranked-only');
  assert.equal(artifact.ranked[0].assessmentRequested, false);
  assert.equal(filesBelow(path.dirname(result.artifactPath)).size, 1);

  const repeated = rerankHistoricalVacancies(root, profile, { now: () => '2026-07-30T18:00:00.000Z' });
  assert.equal(repeated.artifactPath, result.artifactPath);
  assert.equal(repeated.created, false);
  assert.ok(fs.readFileSync(trackerFile).equals(beforeTracker));
  assert.ok(fs.readFileSync(runsFile).equals(beforeRuns));
});

test('the public CLI creates and materialises the verified beta.22 rollback path', () => {
  const root = productionShapedWorkspace();
  const cli = fileURLToPath(new URL('../../tools/scout.mjs', import.meta.url));
  const snapshotRun = spawnSync(process.execPath, [
    cli, 'workspace', 'snapshot-beta22', '--workspace', root,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(snapshotRun.status, 0, snapshotRun.stderr);
  const snapshot = JSON.parse(snapshotRun.stdout);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.compatibleVersion, '0.1.0-beta.22');
  assert.ok(snapshot.fileCount > 0);

  const destination = path.join(path.dirname(root), `${path.basename(root)}-cli-rollback`);
  roots.push(destination);
  const rollbackRun = spawnSync(process.execPath, [
    cli, 'workspace', 'rollback-beta22', '--workspace', root, '--to', destination,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(rollbackRun.status, 0, rollbackRun.stderr);
  const rollback = JSON.parse(rollbackRun.stdout);
  assert.equal(rollback.ok, true);
  assert.equal(rollback.fileCount, snapshot.fileCount);
  assert.equal(rollback.treeDigest, snapshot.treeDigest);
  assert.match(fs.readFileSync(path.join(destination, 'data', 'opportunities.json'), 'utf8'), /Human decision/);
  assert.equal(fs.existsSync(path.join(destination, '.scout')), false);
});
