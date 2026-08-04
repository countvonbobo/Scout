import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { artifactNames, verifiedMacDmgRootDigest } from './build-platform.mjs';
test('cross-platform artifacts are versioned and architecture-specific', () => {
  assert.deepEqual(artifactNames('1.2.3-beta.1'), {
    macArm: 'Scout-1.2.3-beta.1-macos-arm64.dmg', macIntel: 'Scout-1.2.3-beta.1-macos-x64.dmg',
    linuxDeb: 'Scout-1.2.3-beta.1-linux-x64.deb', linuxTar: 'Scout-1.2.3-beta.1-linux-x64.tar.gz',
  });
});

test('macOS packaging compiles a native AppKit launcher instead of bundling a shell executable', () => {
  const build = fs.readFileSync(new URL('./build-platform.mjs', import.meta.url), 'utf8');
  const launcher = fs.readFileSync(new URL('../installer/macos/ScoutLauncher.swift', import.meta.url), 'utf8');
  assert.match(build, /xcrun.*swiftc/);
  assert.doesNotMatch(build.match(/export function buildMac[\s\S]*?return \{ output/)?.[0] || '', /ScoutLauncher\.sh/);
  assert.match(launcher, /applicationShouldHandleReopen/);
  assert.match(launcher, /static func main\(\)/);
  assert.match(launcher, /application\.delegate = delegate/);
  assert.match(launcher, /Scout could not open/);
  assert.match(launcher, /Diagnostic log/);
});

test('platform packaging consumes verified staged inputs and audits payloads before archive creation', () => {
  const build = fs.readFileSync(new URL('./build-platform.mjs', import.meta.url), 'utf8');
  assert.match(build, /copyVerifiedReleaseFile/);
  assert.match(build, /auditStageBeforePackaging\(stage, \{ authorizationRoot: ROOT \}\)/);
  assert.doesNotMatch(build, /copy\(path\.join\(ROOT, 'installer\/unix\/ScoutLauncher\.sh'/);
  assert.doesNotMatch(build, /copy\(path\.join\(ROOT, 'ui\/assets\/scout-icon\.png'/);
  assert.match(build, /path\.join\(stage, 'app\/ui\/assets\/scout-icon\.png'\)/);
  assert.match(
    build.match(/export function buildMac[\s\S]*?return \{ output/)?.[0] || '',
    /fs\.symlinkSync\('\/Applications'[\s\S]*auditStageBeforePackaging\(stage, \{ authorizationRoot: ROOT \}\)/,
  );
  for (const body of [
    build.match(/export function buildMac[\s\S]*?^\}/m)?.[0] || '',
    build.match(/export function buildLinux[\s\S]*?^\}/m)?.[0] || '',
  ]) {
    assert.match(body, /createArtifactPublication/);
    assert.match(body, /authorizeArtifactPublication/);
    assert.match(body, /promoteArtifactPublication/);
    assert.match(body, /finishArtifactPublication/);
    assert.match(body, /publication\.temporaryPaths/);
  }
});

test('macOS package-root verification covers the exact app and Applications link', () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mac-root-'));
  fs.mkdirSync(path.join(root, 'Scout.app'));
  fs.writeFileSync(path.join(root, 'Scout.app', 'payload'), 'reviewed');
  fs.symlinkSync('/Applications', path.join(root, 'Applications'));
  assert.match(verifiedMacDmgRootDigest(root), /Applications=\/Applications/);

  fs.writeFileSync(path.join(root, 'unexpected.txt'), 'private');
  assert.throws(() => verifiedMacDmgRootDigest(root), /unexpected entry/);
  fs.rmSync(path.join(root, 'unexpected.txt'));
  fs.rmSync(path.join(root, 'Applications'));
  fs.symlinkSync('/tmp', path.join(root, 'Applications'));
  assert.throws(() => verifiedMacDmgRootDigest(root), /link is invalid/);
});
