#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import {
  assertAuditedStage, auditStageBeforePackaging, authorizeArtifactPublication, copyVerifiedReleaseFile,
  createArtifactPublication, finishArtifactPublication, finishAuditedStageCleanup,
  promoteArtifactPublication, sha256, stageRelease, verifiedReleaseFileDigest,
  verifiedReleaseTreeDigest, writeArtifactChecksums,
} from './build-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
function run(command, args, cwd = ROOT) { const r = spawnSync(command, args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${command} failed: ${r.stderr || r.stdout}`); }
function reset(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
function copy(source, target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(source, target, { recursive: true }); }
function executable(file) { fs.chmodSync(file, 0o755); }

export function artifactNames(version = VERSION) {
  return {
    macArm: `Scout-${version}-macos-arm64.dmg`, macIntel: `Scout-${version}-macos-x64.dmg`,
    linuxDeb: `Scout-${version}-linux-x64.deb`, linuxTar: `Scout-${version}-linux-x64.tar.gz`,
  };
}

export function buildMac({ arch = process.arch, nodeExecutable = process.execPath } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS packages must be built on macOS');
  const stage = path.join(ROOT, 'dist', 'release', `macos-${arch}`); stageRelease({ root: ROOT, stageDir: stage, nodeExecutable, platform: 'darwin' });
  const packageInputs = path.join(stage, 'package-inputs');
  const launcherSource = path.join(packageInputs, 'ScoutLauncher.swift');
  copyVerifiedReleaseFile(path.join(ROOT, 'installer', 'macos', 'ScoutLauncher.swift'), launcherSource, { verifiedRoot: ROOT });
  const launcherSourceDigest = verifiedReleaseFileDigest(launcherSource, { verifiedRoot: stage });
  const bundle = path.join(stage, 'dmg-root', 'Scout.app'); const contents = path.join(bundle, 'Contents');
  copy(path.join(stage, 'app'), path.join(contents, 'Resources', 'app')); copy(path.join(stage, 'runtime'), path.join(contents, 'Resources', 'runtime'));
  const launcher = path.join(contents, 'MacOS', 'Scout');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  run('xcrun', ['swiftc', '-parse-as-library', launcherSource, '-framework', 'AppKit', '-o', launcher], stage);
  if (verifiedReleaseFileDigest(launcherSource, { verifiedRoot: stage }) !== launcherSourceDigest) {
    throw new Error('verified macOS package input changed during compilation');
  }
  executable(launcher);
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Scout</string><key>CFBundleDisplayName</key><string>Scout</string><key>CFBundleIdentifier</key><string>app.scout.local</string><key>CFBundleVersion</key><string>${VERSION}</string><key>CFBundleShortVersionString</key><string>${VERSION}</string><key>CFBundleExecutable</key><string>Scout</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>`;
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  fs.symlinkSync('/Applications', path.join(stage, 'dmg-root', 'Applications'));
  const audit = auditStageBeforePackaging(stage, { authorizationRoot: ROOT });
  const auditedStage = audit.stageDir;
  let primaryError = null;
  let publication = null;
  try {
    assertAuditedStage(audit);
    const auditedPayloadDigest = verifiedMacDmgRootDigest(path.join(auditedStage, 'dmg-root'));
    const output = path.join(ROOT, 'installer', 'output'); const name = arch === 'arm64' ? artifactNames().macArm : artifactNames().macIntel;
    publication = createArtifactPublication({
      outputDir: output,
      authorityRoot: ROOT,
      artifactNames: [name],
    });
    run('hdiutil', ['create', '-volname', 'Scout', '-srcfolder', path.join(auditedStage, 'dmg-root'), '-ov', '-format', 'UDZO', publication.temporaryPaths[name]]);
    if (verifiedMacDmgRootDigest(path.join(auditedStage, 'dmg-root')) !== auditedPayloadDigest) {
      throw new Error('audited macOS package root changed during packaging');
    }
    assertAuditedStage(audit);
    const authorization = authorizeArtifactPublication(publication);
    const promoted = promoteArtifactPublication(publication, authorization);
    const finalOutput = promoted.finalPaths[name];
    return { output: finalOutput, sha256: sha256(finalOutput) };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (publication) finishArtifactPublication(publication, { primaryError });
    finishAuditedStageCleanup(auditedStage, { primaryError, expectedRecord: audit.stageRecord });
  }
}

function launcher(rootExpression) {
  return `#!/bin/sh\nSCOUT_ROOT=${rootExpression}\nexport SCOUT_ROOT\nexec "$SCOUT_ROOT/launcher/ScoutLauncher.sh" "$@"\n`;
}

export function verifiedMacDmgRootDigest(root) {
  const entries = fs.readdirSync(root).sort();
  if (entries.join('\0') !== ['Applications', 'Scout.app'].join('\0')) {
    throw new Error('macOS package root contains an unexpected entry');
  }
  const applications = path.join(root, 'Applications');
  const stat = fs.lstatSync(applications);
  if (!stat.isSymbolicLink() || fs.readlinkSync(applications) !== '/Applications') {
    throw new Error('macOS Applications link is invalid');
  }
  return `${verifiedReleaseTreeDigest(path.join(root, 'Scout.app'))}:Applications=/Applications`;
}
export function buildLinux({ nodeExecutable = process.execPath } = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Linux x64 packages must be built on Linux x64');
  const stage = path.join(ROOT, 'dist', 'release', 'linux-x64'); stageRelease({ root: ROOT, stageDir: stage, nodeExecutable, platform: 'linux' });
  const packageInputs = path.join(stage, 'package-inputs');
  const launcherSource = path.join(packageInputs, 'ScoutLauncher.sh');
  copyVerifiedReleaseFile(path.join(ROOT, 'installer/unix/ScoutLauncher.sh'), launcherSource, { verifiedRoot: ROOT });
  const launcherSourceDigest = verifiedReleaseFileDigest(launcherSource, { verifiedRoot: stage });
  const output = path.join(ROOT, 'installer', 'output');
  const pkg = path.join(stage, 'deb'); reset(pkg); copy(path.join(stage, 'app'), path.join(pkg, 'opt/scout/app')); copy(path.join(stage, 'runtime'), path.join(pkg, 'opt/scout/runtime'));
  copy(launcherSource, path.join(pkg, 'opt/scout/launcher/ScoutLauncher.sh')); executable(path.join(pkg, 'opt/scout/launcher/ScoutLauncher.sh'));
  fs.mkdirSync(path.join(pkg, 'usr/bin'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'usr/bin/scout-dashboard'), launcher('/opt/scout')); executable(path.join(pkg, 'usr/bin/scout-dashboard'));
  fs.writeFileSync(path.join(pkg, 'usr/bin/scout'), '#!/bin/sh\nexec /opt/scout/runtime/node /opt/scout/app/tools/scout.mjs "$@"\n'); executable(path.join(pkg, 'usr/bin/scout'));
  fs.mkdirSync(path.join(pkg, 'usr/share/applications'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'usr/share/applications/scout.desktop'), '[Desktop Entry]\nName=Scout\nExec=scout-dashboard\nIcon=scout\nType=Application\nCategories=Office;\n');
  copyVerifiedReleaseFile(
    path.join(stage, 'app/ui/assets/scout-icon.png'),
    path.join(pkg, 'usr/share/icons/hicolor/512x512/apps/scout.png'),
    { verifiedRoot: stage },
  );
  fs.mkdirSync(path.join(pkg, 'DEBIAN'), { recursive: true }); fs.writeFileSync(path.join(pkg, 'DEBIAN/control'), `Package: scout\nVersion: ${VERSION.replace(/-/g, '~')}\nArchitecture: amd64\nMaintainer: Scout contributors\nDescription: Local-first AI-assisted opportunity finder\n`);
  const deb = path.join(output, artifactNames().linuxDeb);
  const portable = path.join(stage, `Scout-${VERSION}-linux-x64`); reset(portable); copy(path.join(stage, 'app'), path.join(portable, 'app')); copy(path.join(stage, 'runtime'), path.join(portable, 'runtime')); copy(launcherSource, path.join(portable, 'launcher/ScoutLauncher.sh')); executable(path.join(portable, 'launcher/ScoutLauncher.sh')); fs.writeFileSync(path.join(portable, 'scout-dashboard'), launcher('"$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"')); executable(path.join(portable, 'scout-dashboard'));
  if (verifiedReleaseFileDigest(launcherSource, { verifiedRoot: stage }) !== launcherSourceDigest) {
    throw new Error('verified Linux package input changed during staging');
  }
  const audit = auditStageBeforePackaging(stage, {
    authorizationRoot: ROOT,
    sealedDirectoryModes: { 'deb/DEBIAN': 0o755 },
  });
  const auditedStage = audit.stageDir;
  let primaryError = null;
  let publication = null;
  try {
    assertAuditedStage(audit);
    const auditedPayloadDigest = verifiedReleaseTreeDigest(auditedStage);
    const tar = path.join(output, artifactNames().linuxTar);
    publication = createArtifactPublication({
      outputDir: output,
      authorityRoot: ROOT,
      artifactNames: [path.basename(deb), path.basename(tar), 'checksums.txt'],
    });
    run('dpkg-deb', ['--build', '--root-owner-group', path.join(auditedStage, path.relative(stage, pkg)), publication.temporaryPaths[path.basename(deb)]]);
    run('tar', ['-czf', publication.temporaryPaths[path.basename(tar)], '-C', auditedStage, path.basename(portable)]);
    if (verifiedReleaseTreeDigest(auditedStage) !== auditedPayloadDigest) {
      throw new Error('audited Linux release payload changed during packaging');
    }
    assertAuditedStage(audit);
    writeArtifactChecksums(publication);
    const authorization = authorizeArtifactPublication(publication);
    const promoted = promoteArtifactPublication(publication, authorization);
    return {
      deb: promoted.finalPaths[path.basename(deb)],
      tar: promoted.finalPaths[path.basename(tar)],
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (publication) finishArtifactPublication(publication, { primaryError });
    finishAuditedStageCleanup(auditedStage, { primaryError, expectedRecord: audit.stageRecord });
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const kind = process.argv[2];
  if (kind === 'mac') console.log(JSON.stringify(buildMac(), null, 2));
  else if (kind === 'linux') console.log(JSON.stringify(buildLinux(), null, 2));
  else throw new Error('usage: node tools/build-platform.mjs mac|linux');
}
