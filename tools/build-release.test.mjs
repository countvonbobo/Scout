import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  auditPublicSourceStage,
  includePublicSourcePath, includeReleasePath, productionDependencyFilter, productionLockfile,
  productionPackageManifest, PUBLIC_SOURCE_FILES, RELEASE_FILES,
  sha256, stagePublicSource, stageRelease, writeChecksums,
} from './build-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  assert.ok(sources.includes('tools/remote-hosting-preflight.mjs'));
  assert.ok(!sources.includes('docs/CODEX_HANDOFF.md'));
  assert.ok(!sources.includes('docs/PLAN.md'));
});

test('release tree filter omits tests and snapshots', () => {
  assert.equal(includeReleasePath('ui/lib/workspace.mjs'), true);
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
  assert.equal(fs.existsSync(path.join(staged.stageDir, 'profile')), false);
});

test('the generated public source tree passes the real privacy audit', () => {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-public-audited-stage-'));
  const staged = stagePublicSource({ root: ROOT, stageDir });
  const audit = auditPublicSourceStage({ root: ROOT, stageDir: staged.stageDir });
  assert.equal(audit.status, 0);
  assert.match(audit.output, /Release audit passed/);
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
