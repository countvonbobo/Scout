import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertAuditedStage,
  auditStageBeforePackaging,
  auditPublicSourceStage,
  finishAuditedStageCleanup,
  includePublicSourcePath, includeReleasePath, productionDependencyFilter, productionLockfile,
  productionPackageManifest, PUBLIC_SOURCE_FILES, RELEASE_FILES,
  removeAuditedStage, sha256, stagePublicSource, stageRelease, verifiedReleaseTreeDigest, writeChecksums,
} from './build-release.mjs';
import { verifiedAuditTreeDigest } from './release-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_COPY_FIXTURES = Object.freeze([
  ['nested/.ENV', 'Synthetic Nested Private Marker'],
  ['nested/config/Workspace.JSON', 'Synthetic Nested Private Marker'],
  ['nested/logs/provider.LOG', 'Synthetic Nested Private Marker'],
  ['nested/cache/session.TMP', 'Synthetic Nested Private Marker'],
  ['nested/backups/report.BAK', 'Synthetic Nested Private Marker'],
  ['nested/backups/report.json~', 'Synthetic Nested Private Marker'],
]);

function writePrivateCopyFixtures(root) {
  for (const [relative, content] of PRIVATE_COPY_FIXTURES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function assertPrivateCopyFixturesAbsent(root) {
  for (const [relative] of PRIVATE_COPY_FIXTURES) {
    assert.equal(fs.existsSync(path.join(root, relative)), false, relative);
  }
}

test('release manifest is allowlisted and excludes private workspace roots', () => {
  const sources = RELEASE_FILES.map((entry) => entry.source);
  for (const privateRoot of ['profile', 'cv', 'data', 'reports', 'applications', '.env', 'workspace.json']) {
    assert.ok(!sources.some((source) => source === privateRoot || source.startsWith(`${privateRoot}/`)));
  }
  assert.ok(sources.includes('LICENSE'));
  assert.ok(sources.includes('README.md'));
  assert.ok(sources.includes('tools/deploy-vps.sh'));
  assert.ok(sources.includes('docs/QUICK_START.md'));
  assert.ok(sources.includes('docs/README.md'));
  assert.ok(sources.includes('docs/DOCUMENTATION.md'));
  assert.ok(sources.includes('docs/OPERATIONS.md'));
  assert.ok(sources.includes('docs/KNOWN_ISSUES.md'));
  assert.ok(sources.includes('docs/REPOSITORY_LAYOUT.md'));
  assert.ok(sources.includes('docs/INSTALL_WINDOWS.md'));
  assert.ok(sources.includes('docs/INSTALL_MACOS.md'));
  assert.ok(sources.includes('docs/INSTALL_LINUX.md'));
  assert.ok(sources.includes('docs/INSTALL_VPS.md'));
  assert.ok(sources.includes('docs/VPS_BACKUP_AND_STATE.md'));
  assert.ok(sources.includes('docs/CV_QUALITY.md'));
  assert.ok(sources.includes('docs/releases'));
  assert.ok(sources.includes('docs/diagnostics'));
  assert.ok(sources.includes('docs/RELEASE.md'));
  assert.ok(sources.includes('docs/SUPPLY_CHAIN_SECURITY.md'));
  assert.ok(sources.includes('tools/remote-hosting-preflight.mjs'));
  assert.ok(!sources.includes('docs/CODEX_HANDOFF.md'));
  assert.ok(!sources.includes('docs/PLAN.md'));
});

test('release tree filter omits tests and snapshots', () => {
  assert.equal(includeReleasePath('ui/lib/workspace.mjs'), true);
  assert.equal(includeReleasePath('ui/.git/private.txt'), false);
  assert.equal(includeReleasePath('templates/workspace/workspace.json'), true);
  assert.equal(includeReleasePath('ui/lib/workspace.test.mjs'), false);
  assert.equal(includeReleasePath('ui/lib/fixtures/fake-cli.mjs'), false);
  assert.equal(includeReleasePath('ui/__snapshots__/screen.txt'), false);
  assert.equal(includeReleasePath('node_modules/.bin/mammoth'), false);
  assert.equal(includeReleasePath('node_modules/mammoth/test/test-data/sample.docx'), false);
  assert.equal(includeReleasePath('ui/assets/master-cv.pdf'), false);
  assert.equal(includeReleasePath('assets/private-resume.docx'), false);
  for (const privateRuntimePath of [
    'data/scan-runs.jsonl',
    '.scout/runs/run-synthetic/journal.jsonl',
    '.scout/provider-health/codex.json',
    'profile/context.md',
    'cv/master-cv.md',
    'applications/synthetic-role/cv.typ',
    'reports/2026-07-29.md',
    'chats/synthetic.json',
  ]) {
    assert.equal(includeReleasePath(privateRuntimePath), false);
  }
  for (const bypass of [
    'Data/private.json',
    '.SCOUT/runs/private.json',
    'app/Profile/context.md',
    'ui/Tests/private.mjs',
    'ui/Fixtures/private.json',
    'ui/nested/.ENV',
    'ui/nested/config/Workspace.JSON',
    'ui/nested/logs/provider.LOG',
    'ui/nested/cache/session.TMP',
    'ui/nested/backups/report.BAK',
    'ui/nested/backups/report.json~',
    'node_modules/runtime/nested/.env.local',
  ]) {
    assert.equal(includeReleasePath(bypass), false);
  }
});

test('production dependency filter excludes development-only browser tooling', () => {
  const include = productionDependencyFilter({
    packages: {
      'node_modules/runtime': { version: '1.0.0' },
      'node_modules/runtime/node_modules/transitive': { version: '1.0.0' },
      'node_modules/@playwright/test': { version: '1.0.0', dev: true },
      'node_modules/playwright': { version: '1.0.0', dev: true },
    },
  });
  assert.equal(include('runtime/index.js'), true);
  assert.equal(include('runtime/node_modules/transitive/index.js'), true);
  assert.equal(include('@playwright'), false);
  assert.equal(include('playwright/index.js'), false);
});

test('production manifests remove development-only browser tooling', () => {
  const manifest = productionPackageManifest({
    dependencies: { runtime: '1.0.0' },
    devDependencies: { '@playwright/test': '1.0.0' },
    scripts: { start: 'node app.js', 'test:browser': 'playwright test' },
  });
  assert.deepEqual(manifest.dependencies, { runtime: '1.0.0' });
  assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual(manifest.scripts, { start: 'node app.js' });

  const lock = productionLockfile({
    packages: {
      '': { dependencies: { runtime: '1.0.0' }, devDependencies: { '@playwright/test': '1.0.0' } },
      'node_modules/runtime': { version: '1.0.0' },
      'node_modules/@playwright/test': { version: '1.0.0', dev: true },
    },
  });
  assert.equal(lock.packages[''].devDependencies, undefined);
  assert.ok(lock.packages['node_modules/runtime']);
  assert.equal(lock.packages['node_modules/@playwright/test'], undefined);
});

test('public source manifest includes tests and workflows but excludes private roots and installer output', () => {
  const sources = PUBLIC_SOURCE_FILES.map((entry) => entry.source);
  assert.ok(sources.includes('ui'));
  assert.ok(sources.includes('.github'));
  assert.ok(sources.includes('tools/build-release.test.mjs'));
  assert.ok(sources.includes('tools/remote-hosting-preflight.test.mjs'));
  assert.ok(sources.includes('tools/documentation.test.mjs'));
  assert.ok(!sources.includes('REMOTE_HOSTING_TODO.md'));
  assert.ok(!sources.includes('docs/CODEX_HANDOFF.md'));
  assert.ok(!sources.includes('tools/commute-data.test.mjs'));
  assert.equal(includePublicSourcePath('output/Scout.exe'), false);
  assert.equal(includePublicSourcePath('Scout.iss'), true);
  assert.equal(includePublicSourcePath('templates/workspace/workspace.json'), true);
});

test('public source staging contains contributor inputs without private workspace or built artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-public-root-'));
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-public-stage-'));
  for (const entry of PUBLIC_SOURCE_FILES) {
    const target = path.join(root, entry.source);
    if (entry.tree) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'source.txt'), 'ok');
      if (entry.source === 'installer') {
        fs.mkdirSync(path.join(target, 'output'), { recursive: true });
        fs.writeFileSync(path.join(target, 'output', 'Scout.exe'), 'built');
      }
      if (entry.source === 'templates') {
        fs.mkdirSync(path.join(target, 'workspace'), { recursive: true });
        fs.writeFileSync(path.join(target, 'workspace', 'workspace.json'), '{}');
      }
      if (entry.source === 'ui') writePrivateCopyFixtures(target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const content = entry.source === 'package.json'
        ? '{"version":"1.0.0","devDependencies":{"@playwright/test":"1.0.0"}}'
        : entry.source === 'package-lock.json'
        ? '{"lockfileVersion":3,"packages":{"":{"devDependencies":{"@playwright/test":"1.0.0"}},"node_modules/@playwright/test":{"version":"1.0.0","dev":true}}}'
        : 'ok';
      fs.writeFileSync(target, content);
    }
  }
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'private');
  const staged = stagePublicSource({ root, stageDir });
  assert.equal(fs.existsSync(path.join(staged.stageDir, 'ui', 'source.txt')), true);
  assert.equal(fs.existsSync(path.join(staged.stageDir, '.github', 'source.txt')), true);
  assert.equal(fs.existsSync(path.join(staged.stageDir, 'installer', 'output')), false);
  assert.equal(
    fs.existsSync(path.join(staged.stageDir, 'templates', 'workspace', 'workspace.json')),
    true,
  );
  assert.equal(fs.existsSync(path.join(staged.stageDir, 'profile')), false);
  assertPrivateCopyFixturesAbsent(path.join(staged.stageDir, 'ui'));
});

test('the generated public source tree passes the real privacy audit', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-public-audited-stage-'));
  const staged = stagePublicSource({ root: ROOT, stageDir });
  const audit = auditPublicSourceStage({
    root: ROOT,
    stageDir: staged.stageDir,
    markers: ['Synthetic', 'Personal', 'Marker'].join(' '),
  });
  assert.equal(audit.status, 0);
  assert.match(audit.output, /Release audit passed/);
});

test('public source publication refuses to audit without configured personal markers', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-public-marker-stage-'));
  fs.writeFileSync(path.join(stageDir, 'README.md'), '# public source\n');
  assert.throws(
    () => auditPublicSourceStage({ root: ROOT, stageDir, markers: '' }),
    /requires at least one configured personal marker/,
  );
});

test('stage audit inspects unexpected nested git metadata', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-git-audit-stage-'));
  fs.mkdirSync(path.join(stageDir, 'app', 'ui', '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(stageDir, 'app', 'ui', '.git', 'private.txt'),
    ['-----BEGIN PRIVATE', ' KEY-----', 'SyntheticGitAuditMarker'].join(''),
  );
  assert.throws(
    () => auditStageBeforePackaging(stageDir, {
      env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticGitAuditMarker' },
    }),
    /privacy audit failed|private-key|personal-marker/,
  );
});

test('packaging consumes the audit-created read-only content snapshot', () => {
  const authorizationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-audited-root-'));
  const stageDir = path.join(authorizationRoot, 'stage');
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, 'a.txt'), 'audited-a');
  fs.writeFileSync(path.join(stageDir, 'b.txt'), 'audited-b');
  const audit = auditStageBeforePackaging(stageDir, {
    env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticPackagingMarker' },
    authorizationRoot,
  });
  assert.doesNotThrow(() => assertAuditedStage(audit));
  fs.writeFileSync(path.join(stageDir, 'a.txt'), 'changed-after-audit');
  assert.equal(fs.readFileSync(path.join(audit.stageDir, 'a.txt'), 'utf8'), 'audited-a');
  assert.throws(
    () => fs.writeFileSync(path.join(audit.stageDir, 'a.txt'), 'mutation'),
    /EACCES|EPERM|permission denied/i,
  );
  fs.chmodSync(audit.stageDir, 0o755);
  fs.chmodSync(path.join(audit.stageDir, 'a.txt'), 0o644);
  fs.writeFileSync(path.join(audit.stageDir, 'a.txt'), 'SyntheticPackagingMarker');
  assert.throws(() => assertAuditedStage(audit), /privacy-authorized snapshot/);
  removeAuditedStage(audit.stageDir, { expectedRecord: audit.stageRecord });
  fs.rmSync(authorizationRoot, { recursive: true, force: true });
});

test('sealed release authorization rejects the complete tamper matrix', () => {
  const cases = [
    ['content', ({ file }) => {
      fs.chmodSync(file, 0o644);
      fs.writeFileSync(file, 'changed-content');
      fs.chmodSync(file, 0o444);
    }],
    ['mode', ({ file }) => fs.chmodSync(file, 0o644)],
    ['path', ({ root, file }) => {
      fs.chmodSync(root, 0o755);
      fs.renameSync(file, path.join(root, 'renamed.txt'));
      fs.chmodSync(root, 0o555);
    }],
    ['link', ({ root, file }) => {
      fs.chmodSync(root, 0o755);
      fs.unlinkSync(file);
      fs.symlinkSync('b.txt', file, process.platform === 'win32' ? 'file' : undefined);
      fs.chmodSync(root, 0o555);
    }],
    ['addition', ({ root }) => {
      const added = path.join(root, 'added.txt');
      fs.chmodSync(root, 0o755);
      fs.writeFileSync(added, 'added');
      fs.chmodSync(added, 0o444);
      fs.chmodSync(root, 0o555);
    }],
    ['deletion', ({ root, file }) => {
      fs.chmodSync(root, 0o755);
      fs.unlinkSync(file);
      fs.chmodSync(root, 0o555);
    }],
    ['replacement', ({ root, file, outside }) => {
      const content = fs.readFileSync(file);
      fs.chmodSync(root, 0o755);
      fs.renameSync(file, path.join(outside, 'displaced.txt'));
      fs.writeFileSync(file, content, { mode: 0o444 });
      fs.chmodSync(file, 0o444);
      fs.chmodSync(root, 0o555);
    }],
  ];

  for (const [name, tamper] of cases) {
    const authorizationRoot = fs.mkdtempSync(path.join(os.tmpdir(), `scout-audit-${name}-root-`));
    const stageDir = path.join(authorizationRoot, 'stage');
    fs.mkdirSync(stageDir);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `scout-audit-${name}-outside-`));
    fs.writeFileSync(path.join(stageDir, 'a.txt'), 'audited-a');
    fs.writeFileSync(path.join(stageDir, 'b.txt'), 'audited-b');
    const audit = auditStageBeforePackaging(stageDir, {
      env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticPackagingMarker' },
      authorizationRoot,
    });
    try {
      assert.doesNotThrow(() => assertAuditedStage(audit), `${name}: clean stage`);
      tamper({ root: audit.stageDir, file: path.join(audit.stageDir, 'a.txt'), outside });
      if (name === 'replacement') {
        assert.equal(verifiedAuditTreeDigest(audit.stageDir), audit.treeDigest);
      }
      assert.throws(
        () => assertAuditedStage(audit),
        /privacy-authorized snapshot/,
        `${name}: tampered stage`,
      );
    } finally {
      removeAuditedStage(audit.stageDir, { expectedRecord: audit.stageRecord });
      fs.rmSync(authorizationRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('sealed release authorization rejects an active ancestor substitution', () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-audit-ancestor-'));
  const releaseDir = path.join(top, 'release');
  const heldDir = path.join(top, 'release-held');
  const stageDir = path.join(releaseDir, 'stage');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'a.txt'), 'audited-a');
  const audit = auditStageBeforePackaging(stageDir, {
    env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticPackagingMarker' },
  });
  try {
    assert.doesNotThrow(() => assertAuditedStage(audit));
    fs.renameSync(releaseDir, heldDir);
    fs.mkdirSync(releaseDir);
    assert.throws(() => assertAuditedStage(audit), /privacy-authorized snapshot/);
    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.renameSync(heldDir, releaseDir);
  } finally {
    removeAuditedStage(audit.stageDir, { expectedRecord: audit.stageRecord });
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test('a required packager directory mode keeps its files sealed and remains tamper-evident', {
  skip: process.platform === 'win32' ? 'Debian directory modes are exercised on Linux release runners' : false,
}, () => {
  const authorizationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-audit-directory-mode-root-'));
  const stageDir = path.join(authorizationRoot, 'stage');
  fs.mkdirSync(stageDir);
  const controlDir = path.join(stageDir, 'deb', 'DEBIAN');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'control'), 'Package: scout\n');
  const audit = auditStageBeforePackaging(stageDir, {
    env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticPackagingMarker' },
    authorizationRoot,
    sealedDirectoryModes: { 'deb/DEBIAN': 0o755 },
  });
  try {
    const sealedControlDir = path.join(audit.stageDir, 'deb', 'DEBIAN');
    const sealedControl = path.join(sealedControlDir, 'control');
    assert.equal(fs.statSync(sealedControlDir).mode & 0o777, 0o755);
    assert.equal(fs.statSync(sealedControl).mode & 0o777, 0o444);
    assert.doesNotThrow(() => assertAuditedStage(audit));
    fs.renameSync(sealedControl, path.join(sealedControlDir, 'control-held'));
    fs.renameSync(path.join(sealedControlDir, 'control-held'), sealedControl);
    assert.throws(() => assertAuditedStage(audit), /privacy-authorized snapshot/);
  } finally {
    removeAuditedStage(audit.stageDir, { expectedRecord: audit.stageRecord });
    fs.rmSync(authorizationRoot, { recursive: true, force: true });
  }
});

test('audited stage cleanup preserves the primary error and reports retained payload safely', () => {
  const primary = new Error('primary packaging failure');
  assert.doesNotThrow(() => finishAuditedStageCleanup('/synthetic/audited-stage', {
    primaryError: primary,
    remove: () => { throw new Error('/private/path must not escape'); },
  }));
  assert.match(primary.message, /^primary packaging failure\nAudited release payload cleanup failed;/);
  assert.doesNotMatch(primary.message, /private\/path/);

  assert.throws(
    () => finishAuditedStageCleanup('/synthetic/audited-stage', {
      remove: () => { throw new Error('/private/path must not escape'); },
    }),
    (error) => error.message
      === 'Audited release payload cleanup failed; the sealed payload was retained for runner cleanup.',
  );
});

test('audit preparation cleanup preserves its primary error and reports retained payload safely', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-audit-cleanup-'));
  fs.writeFileSync(path.join(stageDir, 'a.txt'), 'audited-a');
  try {
    assert.throws(
      () => auditStageBeforePackaging(stageDir, {
        env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticPackagingMarker' },
        sealedState: () => { throw new Error('primary authorization failure'); },
        removeAuditedSnapshot: () => { throw new Error('/private/path must not escape'); },
      }),
      (error) => {
        assert.equal(
          error.message,
          'primary authorization failure\nAudited release payload cleanup failed; the release-audit payload was retained for runner cleanup.',
        );
        assert.doesNotMatch(error.message, /private\/path/);
        return true;
      },
    );
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
});

test('audit preparation never removes a pre-existing snapshot collision', () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-audit-collision-root-'));
  const stageDir = path.join(top, 'stage');
  const collisionId = '11111111-1111-4111-8111-111111111111';
  const collision = `${stageDir}.audited-${collisionId}`;
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, 'a.txt'), 'audited-a');
  fs.mkdirSync(collision);
  fs.writeFileSync(path.join(collision, 'sentinel'), 'pre-existing');
  try {
    assert.throws(() => auditStageBeforePackaging(stageDir, {
      env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticPackagingMarker' },
      authorizationRoot: top,
      randomUUID: () => collisionId,
    }));
    assert.equal(fs.readFileSync(path.join(collision, 'sentinel'), 'utf8'), 'pre-existing');
  } finally {
    try {
      const cleanupAudit = fs.readdirSync(top).find((name) => name.includes('.audited-'));
      if (cleanupAudit) fs.chmodSync(path.join(top, cleanupAudit), 0o700);
    } catch {}
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test('audited-stage cleanup quarantines before identity validation and preserves a substitute', () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-audit-cleanup-identity-root-'));
  const stageDir = path.join(top, 'stage');
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, 'a.txt'), 'audited-a');
  const audit = auditStageBeforePackaging(stageDir, {
    env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticPackagingMarker' },
    authorizationRoot: top,
  });
  const held = `${audit.stageDir}-held`;
  const primary = new Error('packager failed');
  try {
    finishAuditedStageCleanup(audit.stageDir, {
      primaryError: primary,
      expectedRecord: audit.stageRecord,
      remove: (entry, options) => removeAuditedStage(entry, {
        ...options,
        rename: (source, target) => {
          fs.renameSync(source, held);
          fs.mkdirSync(source);
          fs.writeFileSync(path.join(source, 'sentinel'), 'replacement must survive');
          fs.renameSync(source, target);
        },
      }),
    });
    assert.match(primary.message, /Audited release payload cleanup failed/);
    const replacement = fs.readdirSync(top)
      .find((name) => name.includes('.audited-') && name.includes('.cleanup-'));
    assert.ok(replacement);
    assert.equal(
      fs.readFileSync(path.join(top, replacement, 'sentinel'), 'utf8'),
      'replacement must survive',
    );
    assert.equal(fs.existsSync(held), true);
  } finally {
    if (fs.existsSync(held)) removeAuditedStage(held, { expectedRecord: audit.stageRecord });
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test('audited-stage cleanup rechecks quarantine identity before recursive deletion', () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-audit-cleanup-quarantine-root-'));
  const stageDir = path.join(top, 'stage');
  fs.mkdirSync(stageDir);
  fs.writeFileSync(path.join(stageDir, 'a.txt'), 'audited-a');
  const audit = auditStageBeforePackaging(stageDir, {
    env: { ...process.env, SCOUT_RELEASE_MARKERS: 'SyntheticPackagingMarker' },
    authorizationRoot: top,
  });
  const primary = new Error('packager failed');
  let held = null;
  let replacement = null;
  try {
    finishAuditedStageCleanup(audit.stageDir, {
      primaryError: primary,
      expectedRecord: audit.stageRecord,
      remove: (entry, options) => removeAuditedStage(entry, {
        ...options,
        empty: (quarantine) => {
          held = `${quarantine}-held`;
          fs.renameSync(quarantine, held);
          fs.mkdirSync(quarantine);
          fs.writeFileSync(path.join(quarantine, 'sentinel'), 'replacement must survive');
          replacement = quarantine;
        },
      }),
    });
    assert.match(primary.message, /Audited release payload cleanup failed/);
    assert.equal(fs.readFileSync(path.join(replacement, 'sentinel'), 'utf8'), 'replacement must survive');
    assert.equal(fs.existsSync(held), true);
  } finally {
    if (held && fs.existsSync(held)) removeAuditedStage(held, { expectedRecord: audit.stageRecord });
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test('public and release staging refuse allowlisted leaf symlinks', () => {
  if (process.platform === 'win32') return;
  const privateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-private-leaf-')), 'private.txt');
  fs.writeFileSync(privateFile, 'Synthetic private content');
  for (const stage of [stagePublicSource, stageRelease]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-symlink-root-'));
    const stageDir = path.join(root, 'stage');
    const entries = stage === stagePublicSource ? PUBLIC_SOURCE_FILES : RELEASE_FILES;
    for (const entry of entries) {
      const target = path.join(root, entry.source);
      if (entry.tree) {
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'source.mjs'), 'export {};');
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.source.endsWith('.json') ? '{}' : 'public');
      }
    }
    const leaf = path.join(root, 'README.md');
    fs.rmSync(leaf);
    fs.symlinkSync(privateFile, leaf);
    assert.throws(
      () => stage === stageRelease
        ? stage({ root, stageDir, includeDependencies: false, typstExecutable: process.execPath })
        : stage({ root, stageDir }),
      /regular file|symbolic link/,
    );
  }
});

test('public and release staging refuse symlinked allowlisted ancestors', () => {
  if (process.platform === 'win32') return;
  for (const stage of [stagePublicSource, stageRelease]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-symlink-ancestor-root-'));
    const stageDir = path.join(root, 'stage');
    const entries = stage === stagePublicSource ? PUBLIC_SOURCE_FILES : RELEASE_FILES;
    for (const entry of entries) {
      const target = path.join(root, entry.source);
      if (entry.tree) {
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'source.mjs'), 'export {};');
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.source.endsWith('.json') ? '{}' : 'public');
      }
    }
    const ancestorName = stage === stagePublicSource ? 'docs' : 'tools';
    const ancestor = path.join(root, ancestorName);
    const external = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scout-external-ancestor-')), ancestorName);
    fs.cpSync(ancestor, external, { recursive: true });
    fs.rmSync(ancestor, { recursive: true });
    fs.symlinkSync(external, ancestor);

    assert.throws(
      () => stage === stageRelease
        ? stage({ root, stageDir, includeDependencies: false, typstExecutable: process.execPath })
        : stage({ root, stageDir }),
      /ancestor|symbolic link/,
    );
  }
});

test('staging copies only manifest content and bundled runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-root-'));
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-stage-'));
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-node-'));
  const nodeExecutable = path.join(nodeDir, 'node.exe');
  const typstExecutable = path.join(nodeDir, 'typst.exe');
  fs.writeFileSync(nodeExecutable, 'runtime');
  fs.writeFileSync(typstExecutable, 'typst-runtime');
  for (const entry of RELEASE_FILES) {
    const target = path.join(root, entry.source);
    if (entry.tree) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'runtime.mjs'), 'ok');
      fs.writeFileSync(path.join(target, 'runtime.test.mjs'), 'private fixture');
      if (entry.source === 'templates') {
        fs.mkdirSync(path.join(target, 'workspace'), { recursive: true });
        fs.writeFileSync(path.join(target, 'workspace', 'workspace.json'), '{}');
      }
      if (entry.source === 'ui') writePrivateCopyFixtures(target);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const content = entry.source === 'package.json'
        ? '{"version":"1.0.0","devDependencies":{"@playwright/test":"1.0.0"}}'
        : entry.source === 'package-lock.json'
        ? '{"lockfileVersion":3,"packages":{"":{"devDependencies":{"@playwright/test":"1.0.0"}},"node_modules/@playwright/test":{"version":"1.0.0","dev":true}}}'
        : 'ok';
      fs.writeFileSync(target, content);
    }
  }
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'context.md'), 'private');

  const staged = stageRelease({ root, stageDir, nodeExecutable, typstExecutable, includeDependencies: false, platform: 'win32' });
  assert.equal(fs.existsSync(path.join(staged.appDir, 'ui', 'runtime.mjs')), true);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'ui', 'runtime.test.mjs')), false);
  assertPrivateCopyFixturesAbsent(path.join(staged.appDir, 'ui'));
  assert.equal(
    fs.existsSync(path.join(staged.appDir, 'templates', 'workspace', 'workspace.json')),
    true,
  );
  assert.equal(fs.existsSync(path.join(staged.appDir, 'profile')), false);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'docs', 'QUICK_START.md')), true);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'docs', 'INSTALL_VPS.md')), true);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'docs', 'KNOWN_ISSUES.md')), true);
  assert.equal(fs.existsSync(path.join(staged.appDir, 'docs', 'REPOSITORY_LAYOUT.md')), true);
  assert.doesNotMatch(fs.readFileSync(path.join(staged.appDir, 'package.json'), 'utf8'), /playwright/i);
  assert.doesNotMatch(fs.readFileSync(path.join(staged.appDir, 'package-lock.json'), 'utf8'), /playwright/i);
  assert.equal(fs.readFileSync(path.join(stageDir, 'runtime', 'ScoutRuntime.exe'), 'utf8'), 'runtime');
  assert.equal(fs.readFileSync(path.join(stageDir, 'runtime', 'typst.exe'), 'utf8'), 'typst-runtime');
  const audit = auditPublicSourceStage({
    root: ROOT,
    stageDir,
    markers: ['Synthetic', 'Nested', 'Private', 'Marker'].join(' '),
  });
  assert.equal(audit.status, 0);
});

test('the real staged production dependency payload cannot bypass the privacy audit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-dependency-root-'));
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-dependency-stage-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-dependency-runtime-'));
  const nodeExecutable = path.join(runtimeDir, 'node');
  const typstExecutable = path.join(runtimeDir, 'typst');
  const marker = 'Synthetic Dependency Private Marker';
  fs.writeFileSync(nodeExecutable, 'runtime');
  fs.writeFileSync(typstExecutable, 'typst-runtime');

  for (const entry of RELEASE_FILES) {
    const target = path.join(root, entry.source);
    if (entry.tree) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'runtime.mjs'), 'ok');
      if (entry.source === 'templates') {
        fs.mkdirSync(path.join(target, 'workspace'), { recursive: true });
        fs.writeFileSync(path.join(target, 'workspace', 'workspace.json'), '{}');
      }
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = entry.source === 'package.json'
      ? '{"version":"1.0.0","dependencies":{"selected-package":"1.0.0"}}'
      : entry.source === 'package-lock.json'
      ? '{"lockfileVersion":3,"packages":{"":{"dependencies":{"selected-package":"1.0.0"}},"node_modules/selected-package":{"version":"1.0.0"}}}'
      : 'ok';
    fs.writeFileSync(target, content);
  }

  const dependency = path.join(root, 'node_modules', 'selected-package');
  fs.mkdirSync(path.join(dependency, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(dependency, 'index.js'), 'export default true;\n');
  fs.writeFileSync(path.join(dependency, 'private.json'), JSON.stringify({
    prompt: 'Synthetic private provider prompt.',
  }));
  fs.writeFileSync(path.join(dependency, 'private.txt'), `${marker}\n`);
  fs.writeFileSync(
    path.join(dependency, 'nested', 'runtime-state.jsonl'),
    `${JSON.stringify({ events: [{ stage: 'synthetic-private-stage' }] })}\n`,
  );

  const staged = stageRelease({
    root,
    stageDir,
    nodeExecutable,
    typstExecutable,
    platform: process.platform,
  });
  assert.equal(
    fs.existsSync(path.join(staged.appDir, 'node_modules', 'selected-package', 'private.json')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(staged.appDir, 'node_modules', 'selected-package', 'private.txt')),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(
      staged.appDir,
      'node_modules',
      'selected-package',
      'nested',
      'runtime-state.jsonl',
    )),
    true,
  );
  assert.throws(
    () => auditPublicSourceStage({ root: ROOT, stageDir, markers: marker }),
    /public source privacy audit failed/,
  );
});

test('checksums use SHA-256 and do not hash the manifest into itself', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-release-output-'));
  const artifact = path.join(output, 'Scout.exe');
  fs.writeFileSync(artifact, 'installer');
  const manifest = writeChecksums(output);
  assert.equal(fs.readFileSync(manifest, 'utf8'), `${sha256(artifact)}  Scout.exe\n`);
  writeChecksums(output);
  assert.equal(fs.readFileSync(manifest, 'utf8'), `${sha256(artifact)}  Scout.exe\n`);
});

test('Windows packaging publishes only authorized private temporary output without overwrite', () => {
  const source = fs.readFileSync(new URL('./build-release.mjs', import.meta.url), 'utf8');
  const body = source.match(/export function buildInstaller[\s\S]*?\n\}/)?.[0] || '';
  assert.match(body, /createArtifactPublication/);
  assert.match(body, /`\/DOutputDir=\$\{publication\.pendingDir\}`/);
  assert.match(body, /writeArtifactChecksums[\s\S]*authorizeArtifactPublication[\s\S]*promoteArtifactPublication/);
  assert.match(body, /finishArtifactPublication/);
  assert.doesNotMatch(body, /rmSync\(outputDir/);
});

test('verified payload digests bind file paths, modes and bytes and reject links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-payload-digest-'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'payload.txt'), 'first');
  const first = verifiedReleaseTreeDigest(root);
  fs.writeFileSync(path.join(root, 'nested', 'payload.txt'), 'second');
  assert.notEqual(verifiedReleaseTreeDigest(root), first);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'nested', 'payload.txt'), path.join(root, 'linked.txt'));
    assert.throws(() => verifiedReleaseTreeDigest(root), /symbolic link/);
  }
});
