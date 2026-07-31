import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { artifactNames } from './build-platform.mjs';
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
  assert.match(build, /auditStageBeforePackaging\(stage\)/);
  assert.doesNotMatch(build, /copy\(path\.join\(ROOT, 'installer\/unix\/ScoutLauncher\.sh'/);
  assert.match(
    build.match(/export function buildMac[\s\S]*?return \{ output/)?.[0] || '',
    /auditStageBeforePackaging\(stage\)[\s\S]*fs\.symlinkSync\('\/Applications'/,
  );
});
