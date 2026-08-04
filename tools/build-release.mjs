#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import {
  auditStagedRelease, loadMarkers, verifiedAuditTreeDigest, verifiedAuditTreeState,
} from './release-audit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

export const RELEASE_FILES = Object.freeze([
  { source: 'ui', target: 'ui', tree: true },
  { source: 'tools/scout.mjs', target: 'tools/scout.mjs' },
  { source: 'tools/remote-access.mjs', target: 'tools/remote-access.mjs' },
  { source: 'tools/remote-hosting-preflight.mjs', target: 'tools/remote-hosting-preflight.mjs' },
  { source: 'tools/typst-runtime.mjs', target: 'tools/typst-runtime.mjs' },
  { source: 'tools/scan-lock.mjs', target: 'tools/scan-lock.mjs' },
  { source: 'tools/fetch-adzuna.mjs', target: 'tools/fetch-adzuna.mjs' },
  { source: 'tools/fetch-ats.mjs', target: 'tools/fetch-ats.mjs' },
  { source: 'tools/fetch-hiring-cafe.mjs', target: 'tools/fetch-hiring-cafe.mjs' },
  { source: 'tools/deploy-vps.sh', target: 'tools/deploy-vps.sh' },
  { source: 'templates', target: 'templates', tree: true },
  { source: 'skills', target: 'skills', tree: true },
  { source: 'README.md', target: 'README.md' },
  { source: 'CONTRIBUTING.md', target: 'CONTRIBUTING.md' },
  { source: 'SECURITY.md', target: 'SECURITY.md' },
  { source: 'docs/README.md', target: 'docs/README.md' },
  { source: 'docs/DOCUMENTATION.md', target: 'docs/DOCUMENTATION.md' },
  { source: 'docs/OPERATIONS.md', target: 'docs/OPERATIONS.md' },
  { source: 'docs/QUICK_START.md', target: 'docs/QUICK_START.md' },
  { source: 'docs/INSTALL_WINDOWS.md', target: 'docs/INSTALL_WINDOWS.md' },
  { source: 'docs/INSTALL_MACOS.md', target: 'docs/INSTALL_MACOS.md' },
  { source: 'docs/INSTALL_LINUX.md', target: 'docs/INSTALL_LINUX.md' },
  { source: 'docs/INSTALL_VPS.md', target: 'docs/INSTALL_VPS.md' },
  { source: 'docs/VPS_BACKUP_AND_STATE.md', target: 'docs/VPS_BACKUP_AND_STATE.md' },
  { source: 'docs/AI_SETUP.md', target: 'docs/AI_SETUP.md' },
  { source: 'docs/CONFIGURATION.md', target: 'docs/CONFIGURATION.md' },
  { source: 'docs/PRIVACY.md', target: 'docs/PRIVACY.md' },
  { source: 'docs/PRIVATE_REMOTE_ACCESS.md', target: 'docs/PRIVATE_REMOTE_ACCESS.md' },
  { source: 'docs/CV_QUALITY.md', target: 'docs/CV_QUALITY.md' },
  { source: 'docs/PROVIDERS.md', target: 'docs/PROVIDERS.md' },
  { source: 'docs/ADZUNA_AND_SOURCES.md', target: 'docs/ADZUNA_AND_SOURCES.md' },
  { source: 'docs/AUTOMATION.md', target: 'docs/AUTOMATION.md' },
  { source: 'docs/UPGRADES.md', target: 'docs/UPGRADES.md' },
  { source: 'docs/TROUBLESHOOTING.md', target: 'docs/TROUBLESHOOTING.md' },
  { source: 'docs/KNOWN_ISSUES.md', target: 'docs/KNOWN_ISSUES.md' },
  { source: 'docs/REPOSITORY_LAYOUT.md', target: 'docs/REPOSITORY_LAYOUT.md' },
  { source: 'docs/RELEASE.md', target: 'docs/RELEASE.md' },
  { source: 'docs/SUPPLY_CHAIN_SECURITY.md', target: 'docs/SUPPLY_CHAIN_SECURITY.md' },
  { source: 'docs/releases', target: 'docs/releases', tree: true },
  { source: 'docs/diagnostics', target: 'docs/diagnostics', tree: true },
  { source: 'docs/SCOUT_SCAN_PROTOCOL.md', target: 'docs/SCOUT_SCAN_PROTOCOL.md' },
  { source: 'package.json', target: 'package.json' },
  { source: 'package-lock.json', target: 'package-lock.json' },
  { source: 'LICENSE', target: 'LICENSE' },
  { source: 'THIRD_PARTY_NOTICES.md', target: 'THIRD_PARTY_NOTICES.md' },
]);

const PUBLIC_DOCS = RELEASE_FILES.filter((entry) => entry.source.startsWith('docs/'));

export const PUBLIC_SOURCE_FILES = Object.freeze([
  { source: 'ui', target: 'ui', tree: true },
  { source: '.agents/skills', target: '.agents/skills', tree: true },
  { source: '.claude/skills', target: '.claude/skills', tree: true },
  { source: '.github', target: '.github', tree: true },
  { source: 'installer', target: 'installer', tree: true, publicFilter: true },
  { source: 'templates', target: 'templates', tree: true },
  { source: 'skills', target: 'skills', tree: true },
  ...[
    'tools/build-release.mjs', 'tools/build-release.test.mjs',
    'tools/build-platform.mjs', 'tools/build-platform.test.mjs',
    'tools/release-audit.mjs', 'tools/release-audit.test.mjs',
    'tools/fetch-adzuna.mjs', 'tools/fetch-ats.mjs', 'tools/fetch-hiring-cafe.mjs',
    'tools/scan-lock.mjs', 'tools/scan-lock.test.mjs', 'tools/scan-skill-parity.test.mjs',
    'tools/scout.mjs', 'tools/scout.test.mjs',
    'tools/remote-access.mjs', 'tools/remote-hosting-preflight.mjs', 'tools/remote-hosting-preflight.test.mjs', 'tools/remote-hosting-docs.test.mjs', 'tools/documentation.test.mjs', 'tools/typst-runtime.mjs', 'tools/typst-runtime.test.mjs', 'tools/deploy-vps.sh', 'tools/windows-host.test.mjs',
  ].map((source) => ({ source, target: source })),
  ...PUBLIC_DOCS,
  ...['.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']
    .map((source) => ({ source, target: source })),
]);

function normalise(relative) {
  return String(relative).replaceAll('\\', '/').replace(/^\.\/+/, '');
}

export function includeCopiedTreePath(relative) {
  const value = normalise(relative);
  const lower = value.toLocaleLowerCase('en-US');
  const base = path.posix.basename(lower);
  const parts = lower.split('/').filter(Boolean);
  if (parts.includes('.git')) return false;
  if (
    base === 'workspace.json'
    && lower !== 'templates/workspace/workspace.json'
  ) return false;
  if (base === '.env' || base.startsWith('.env.')) return false;
  if (/\.(?:bak|backup|log(?:\.\d+)?|swp|swo|temp|tmp)$/i.test(base)) return false;
  if (base.endsWith('~') || base.startsWith('.#')) return false;
  return true;
}

export function includeReleasePath(relative) {
  const value = normalise(relative);
  if (!includeCopiedTreePath(value)) return false;
  const lower = value.toLocaleLowerCase('en-US');
  const base = path.posix.basename(lower);
  const parts = lower.split('/').filter(Boolean);
  const root = parts[0] === 'app' ? parts[1] : parts[0];
  if (['.scout', 'applications', 'chats', 'cv', 'data', 'profile', 'reports'].includes(root)) return false;
  if (parts.some((part) => ['.bin', 'fixtures', 'test', 'tests', 'test-data', '__tests__', '__snapshots__'].includes(part))) return false;
  if (base === '.ds_store' || base === 'thumbs.db') return false;
  if (/\.(?:doc|docx|odt|pdf|rtf)$/i.test(base)) return false;
  if (/\.test\.mjs$/i.test(base)) return false;
  return true;
}

export function includePublicSourcePath(relative) {
  const value = normalise(relative);
  if (!includeCopiedTreePath(value)) return false;
  const lower = value.toLocaleLowerCase('en-US');
  if (
    lower === 'output'
    || lower.startsWith('output/')
    || lower === 'installer/output'
    || lower.startsWith('installer/output/')
  ) return false;
  return true;
}

export function productionDependencyFilter(lock) {
  const productionPackages = Object.entries(lock.packages || {})
    .filter(([key, metadata]) => key.startsWith('node_modules/') && metadata.dev !== true)
    .map(([key]) => normalise(key.slice('node_modules/'.length)));
  return (relative) => {
    const value = normalise(relative);
    return productionPackages.some((packagePath) =>
      value === packagePath || value.startsWith(`${packagePath}/`) || packagePath.startsWith(`${value}/`));
  };
}

export function productionPackageManifest(manifest) {
  const production = structuredClone(manifest);
  delete production.devDependencies;
  if (production.scripts) {
    for (const [name, command] of Object.entries(production.scripts)) {
      if (/\bplaywright\b/i.test(command) || name === 'test:browser') delete production.scripts[name];
    }
  }
  return production;
}

export function productionLockfile(lock) {
  const production = structuredClone(lock);
  if (production.packages) {
    production.packages = Object.fromEntries(
      Object.entries(production.packages).filter(([, metadata]) => metadata.dev !== true),
    );
    if (production.packages['']) delete production.packages[''].devDependencies;
  }
  if (production.dependencies) {
    production.dependencies = Object.fromEntries(
      Object.entries(production.dependencies).filter(([, metadata]) => metadata.dev !== true),
    );
  }
  return production;
}

function writeProductionManifests(root, appDir) {
  const manifest = JSON.parse(readRegularFile(required(root, 'package.json'), root).toString('utf8'));
  const lock = JSON.parse(readRegularFile(required(root, 'package-lock.json'), root).toString('utf8'));
  fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(productionPackageManifest(manifest), null, 2)}\n`);
  fs.writeFileSync(path.join(appDir, 'package-lock.json'), `${JSON.stringify(productionLockfile(lock), null, 2)}\n`);
  return lock;
}

function samePathRecord(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readRegularFileRecord(source, verifiedRoot = path.dirname(source), expected = null) {
  const ancestorsBefore = releasePathIdentity(verifiedRoot, source);
  const before = fs.lstatSync(source, { bigint: true });
  if (expected && !samePathRecord(before, expected)) {
    throw new Error(`release input changed after directory enumeration: ${source}`);
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`release input must be a regular file: ${source}`);
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const content = fs.readFileSync(descriptor);
    const openedAfterRead = fs.fstatSync(descriptor, { bigint: true });
    const ancestorsAfter = releasePathIdentity(verifiedRoot, source);
    const after = fs.lstatSync(source, { bigint: true });
    if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()
      || opened.dev !== before.dev || opened.ino !== before.ino
      || after.dev !== opened.dev || after.ino !== opened.ino
      || openedAfterRead.dev !== opened.dev || openedAfterRead.ino !== opened.ino
      || openedAfterRead.size !== opened.size
      || openedAfterRead.mtimeNs !== opened.mtimeNs
      || openedAfterRead.ctimeNs !== opened.ctimeNs
      || after.size !== openedAfterRead.size
      || after.mtimeNs !== openedAfterRead.mtimeNs
      || after.ctimeNs !== openedAfterRead.ctimeNs
      || ancestorsAfter !== ancestorsBefore) {
      throw new Error(`release input identity changed while reading: ${source}`);
    }
    return {
      content,
      mode: Number(openedAfterRead.mode & 0o777n),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRegularFile(source, verifiedRoot = path.dirname(source)) {
  return readRegularFileRecord(source, verifiedRoot).content;
}

function copyRegularFile(source, target, verifiedRoot = path.dirname(source), expected = null) {
  const { content, mode } = readRegularFileRecord(source, verifiedRoot, expected);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, { flag: 'wx', mode });
}

export function copyVerifiedReleaseFile(source, target, {
  verifiedRoot = path.dirname(source),
} = {}) {
  copyRegularFile(path.resolve(source), path.resolve(target), path.resolve(verifiedRoot));
  return target;
}

function copyTree(
  source,
  target,
  relative = '',
  include = includeReleasePath,
  verifiedRoot = source,
  expected = null,
) {
  const ancestorsBefore = releasePathIdentity(verifiedRoot, source);
  const stat = fs.lstatSync(source, { bigint: true });
  if (expected && !samePathRecord(stat, expected)) {
    throw new Error(`release input changed after directory enumeration: ${source}`);
  }
  if (stat.isSymbolicLink()) throw new Error(`release input may not be a symbolic link: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    const entries = fs.readdirSync(source).sort().map((name) => ({
      name,
      stat: fs.lstatSync(path.join(source, name), { bigint: true }),
    }));
    for (const { name, stat: childStat } of entries) {
      const childRelative = relative ? path.join(relative, name) : name;
      if (!include(childRelative)) continue;
      copyTree(
        path.join(source, name),
        path.join(target, name),
        childRelative,
        include,
        verifiedRoot,
        childStat,
      );
    }
    const after = fs.lstatSync(source, { bigint: true });
    const ancestorsAfter = releasePathIdentity(verifiedRoot, source);
    if (!after.isDirectory() || after.isSymbolicLink()
      || after.dev !== stat.dev || after.ino !== stat.ino
      || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
      || ancestorsAfter !== ancestorsBefore) {
      throw new Error(`release input directory changed while reading: ${source}`);
    }
    return;
  }
  copyRegularFile(source, target, verifiedRoot, stat);
}

function auditedAncestorIdentityDigest(entry, authorityRoot) {
  const boundary = path.resolve(authorityRoot);
  let current = path.dirname(path.resolve(entry));
  const relative = path.relative(boundary, current);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('audited release payload is outside its authorization root');
  }
  const hash = crypto.createHash('sha256');
  while (true) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('audited release payload ancestor is not a real directory');
    }
    hash.update(JSON.stringify({
      path: path.relative(boundary, current).split(path.sep).join('/'),
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: Number(stat.mode & 0o777n),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
    }));
    hash.update('\0');
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('audited release payload authorization root is unreachable');
    current = parent;
  }
  return hash.digest('hex');
}

export function auditStageBeforePackaging(stageDir, {
  env = process.env,
  requireMarkers = true,
  sealedState = verifiedAuditTreeState,
  removeAuditedSnapshot = removeAuditedStage,
  authorizationRoot = null,
  sealedDirectoryModes = {},
} = {}) {
  const source = path.resolve(stageDir);
  const authorityRoot = path.resolve(authorizationRoot || path.dirname(source));
  const markerFile = env.SCOUT_RELEASE_MARKERS_FILE
    ? path.resolve(DEFAULT_ROOT, env.SCOUT_RELEASE_MARKERS_FILE) : null;
  const markers = loadMarkers({ markerFile, envMarkers: env.SCOUT_RELEASE_MARKERS });
  if (requireMarkers && markers.length === 0) {
    throw new Error('pre-package release audit failed: release audit requires at least one configured personal marker');
  }
  const snapshot = `${source}.audited-${crypto.randomUUID()}`;
  try {
    const result = auditStagedRelease({ root: source, markers, snapshotRoot: snapshot });
    if (!result.ok) {
      const findings = result.findings.map(({ file, line, rule }) => `${file}:${line} ${rule}`).join('\n');
      throw new Error(`pre-package release audit failed:\n${findings}`);
    }
    if (verifiedAuditTreeDigest(snapshot) !== result.treeDigest) {
      throw new Error('pre-package release audit snapshot differs from inspected bytes');
    }
    const seal = (entry) => {
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(entry)) seal(path.join(entry, name));
        const relative = path.relative(snapshot, entry).split(path.sep).join('/');
        const requiredMode = Object.hasOwn(sealedDirectoryModes, relative)
          ? sealedDirectoryModes[relative] : 0o555;
        if (requiredMode !== 0o555 && requiredMode !== 0o755) {
          throw new Error('unsupported sealed release directory mode');
        }
        fs.chmodSync(entry, requiredMode);
      } else if (stat.isFile()) {
        fs.chmodSync(entry, stat.mode & ~0o222);
      }
    };
    seal(snapshot);
    const sealedAuthorization = sealedState(snapshot);
    const ancestorIdentityDigest = auditedAncestorIdentityDigest(snapshot, authorityRoot);
    const output = [
      `Release audit scanned ${result.filesScanned} files with ${result.markerCount} configured personal markers.`,
      `Release audit tree digest: ${sealedAuthorization.treeDigest}`,
      'Release audit passed.',
      '',
    ].join('\n');
    return {
      output,
      ...sealedAuthorization,
      ancestorIdentityDigest,
      authorityRoot,
      stageDir: snapshot,
    };
  } catch (error) {
    const primaryError = error instanceof Error
      ? error : new Error('pre-package release preparation failed');
    finishAuditedStageCleanup(snapshot, {
      primaryError,
      remove: removeAuditedSnapshot,
      retainedState: 'release-audit payload',
    });
    throw primaryError;
  }
}

export function removeAuditedStage(stageDir) {
  const root = path.resolve(stageDir);
  if (!path.basename(root).includes('.audited-') || !fs.existsSync(root)) return;
  const restore = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isDirectory()) {
      fs.chmodSync(entry, 0o755);
      for (const name of fs.readdirSync(entry)) restore(path.join(entry, name));
    } else if (!stat.isSymbolicLink()) fs.chmodSync(entry, stat.mode | 0o200);
  };
  restore(root);
  fs.rmSync(root, { recursive: true, force: true });
}

export function finishAuditedStageCleanup(stageDir, {
  primaryError = null,
  remove = removeAuditedStage,
  retainedState = 'sealed payload',
} = {}) {
  try {
    remove(stageDir);
    return { removed: true };
  } catch {
    const message = `Audited release payload cleanup failed; the ${retainedState} was retained for runner cleanup.`;
    if (primaryError instanceof Error) {
      primaryError.message = `${primaryError.message}\n${message}`;
      return { removed: false };
    }
    throw new Error(message);
  }
}

export function assertAuditedStage(audit) {
  if (!audit?.stageDir || !/^[a-f0-9]{64}$/.test(String(audit.treeDigest || ''))
    || !/^[a-f0-9]{64}$/.test(String(audit.identityDigest || ''))
    || !/^[a-f0-9]{64}$/.test(String(audit.ancestorIdentityDigest || ''))
    || !audit.authorityRoot) {
    throw new Error('audited release payload differs from the privacy-authorized snapshot');
  }
  let current;
  let ancestorIdentityDigest;
  try {
    current = verifiedAuditTreeState(audit.stageDir);
    ancestorIdentityDigest = auditedAncestorIdentityDigest(audit.stageDir, audit.authorityRoot);
  } catch {
    throw new Error('audited release payload differs from the privacy-authorized snapshot');
  }
  if (current.treeDigest !== audit.treeDigest
    || current.identityDigest !== audit.identityDigest
    || ancestorIdentityDigest !== audit.ancestorIdentityDigest) {
    throw new Error('audited release payload differs from the privacy-authorized snapshot');
  }
}

const ARTIFACT_PUBLICATION_LOCK = '.scout-release-publication.lock';
const ARTIFACT_PENDING_PREFIX = '.scout-release-pending-';

function publicationError(message) {
  return new Error(message);
}

function publicationDirectoryRecord(entry) {
  const stat = fs.lstatSync(entry, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw publicationError('release artifact publication output is not a trusted directory');
  }
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode & 0o777n),
  };
}

function samePublicationDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

const WINDOWS_PRIVATE_DIRECTORY_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$entry=$args[0]',
  '$operation=$args[1]',
  '$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()',
  "if($operation -eq 'create') {",
  '  $privateAcl=[System.Security.AccessControl.DirectorySecurity]::new()',
  '  $privateAcl.SetAccessRuleProtection($true,$false)',
  '  $inheritance=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit',
  '  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity.User,[System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)',
  '  [void]$privateAcl.AddAccessRule($rule)',
  '  Set-Acl -LiteralPath $entry -AclObject $privateAcl',
  '}',
  '$acl=Get-Acl -LiteralPath $entry',
  'if(-not $acl.AreAccessRulesProtected) { exit 41 }',
  '$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))',
  '$hasFullControl=$false',
  'foreach($candidate in $rules) {',
  '  if($candidate.IdentityReference.Value -ne $identity.User.Value -or $candidate.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 42 }',
  '  if(($candidate.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl) { $hasFullControl=$true }',
  '}',
  'if(-not $hasFullControl) { exit 43 }',
  '$acl.Sddl',
].join('\n');

function privatePublicationSecurityRecord(entry, { create = false } = {}) {
  if (process.platform !== 'win32') {
    if (create) fs.chmodSync(entry, 0o700);
    const stat = fs.lstatSync(entry, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || Number(stat.mode & 0o777n) !== 0o700) {
      throw publicationError('release artifact temporary output is not private');
    }
    return 'posix:0700';
  }
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    WINDOWS_PRIVATE_DIRECTORY_SCRIPT, entry, create ? 'create' : 'verify',
  ], { encoding: 'utf8', windowsHide: true });
  const descriptor = String(result.stdout || '').trim();
  if (result.status !== 0 || !descriptor) {
    const reason = Number.isInteger(result.status) ? result.status : 90;
    throw publicationError(`release artifact temporary output is not private (bounded reason ACL-${reason})`);
  }
  return `windows:${descriptor}`;
}

function validateArtifactNames(artifactNames) {
  if (!Array.isArray(artifactNames) || artifactNames.length === 0) {
    throw publicationError('release artifact publication requires at least one output');
  }
  const unique = new Set();
  for (const name of artifactNames) {
    if (typeof name !== 'string' || !name || name !== path.basename(name)
      || name === '.' || name === '..' || name.includes('\0')
      || name === ARTIFACT_PUBLICATION_LOCK || name.startsWith(ARTIFACT_PENDING_PREFIX)
      || unique.has(name)) {
      throw publicationError('release artifact publication contains an invalid output name');
    }
    unique.add(name);
  }
  return [...unique];
}

function ensureArtifactOutputDirectory(outputDir, authorityRoot) {
  const output = path.resolve(outputDir);
  const boundary = path.resolve(authorityRoot);
  const relative = path.relative(boundary, output);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw publicationError('release artifact publication output is outside its authority root');
  }
  const parent = path.dirname(output);
  try {
    auditedAncestorIdentityDigest(path.join(parent, '.publication-parent'), boundary);
    try {
      fs.mkdirSync(output, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    publicationDirectoryRecord(output);
    auditedAncestorIdentityDigest(path.join(output, '.publication-output'), boundary);
  } catch (error) {
    if (error?.message?.startsWith('release artifact publication')) throw error;
    throw publicationError('release artifact publication output is not a trusted directory');
  }
  return { output, boundary };
}

function createPrivatePublicationDirectory(outputDir, name) {
  const entry = path.join(outputDir, name);
  let created = false;
  try {
    fs.mkdirSync(entry, { mode: 0o700 });
    created = true;
    const securityRecord = privatePublicationSecurityRecord(entry, { create: true });
    const record = publicationDirectoryRecord(entry);
    return { entry, record, securityRecord };
  } catch (error) {
    if (created) {
      try {
        fs.rmSync(entry, { recursive: true, force: true });
      } catch {
        const primary = error?.message?.startsWith('release artifact')
          ? error : publicationError('release artifact temporary output could not be created');
        primary.message = `${primary.message}\nRelease artifact temporary cleanup failed; temporary artifacts were retained for runner cleanup.`;
        throw primary;
      }
    }
    throw error;
  }
}

export function createArtifactPublication({
  outputDir,
  authorityRoot,
  artifactNames,
  randomUUID = crypto.randomUUID,
} = {}) {
  const names = validateArtifactNames(artifactNames);
  const { output, boundary } = ensureArtifactOutputDirectory(outputDir, authorityRoot);
  for (const name of names) {
    try {
      fs.lstatSync(path.join(output, name));
      throw publicationError('release artifact destination already exists');
    } catch (error) {
      if (error?.message === 'release artifact destination already exists') throw error;
      if (error?.code !== 'ENOENT') {
        throw publicationError('release artifact destination cannot be validated');
      }
    }
  }

  let lock = null;
  let pending = null;
  try {
    try {
      lock = createPrivatePublicationDirectory(output, ARTIFACT_PUBLICATION_LOCK);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw publicationError('release artifact publication is already active');
      }
      throw error;
    }
    const id = randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(id))) {
      throw publicationError('release artifact publication could not create a unique output');
    }
    pending = createPrivatePublicationDirectory(output, `${ARTIFACT_PENDING_PREFIX}${id}`);
    const outputRecord = publicationDirectoryRecord(output);
    if (pending.record.dev !== outputRecord.dev) {
      throw publicationError('release artifact temporary output is not on the destination filesystem');
    }
    const outputFence = auditedAncestorIdentityDigest(
      path.join(output, '.publication-fence'),
      boundary,
    );
    const temporaryPaths = Object.fromEntries(names.map((name) => [name, path.join(pending.entry, name)]));
    return {
      id,
      artifactNames: names,
      authorityRoot: boundary,
      outputDir: output,
      outputRecord,
      outputFence,
      lockDir: lock.entry,
      lockRecord: lock.record,
      lockSecurityRecord: lock.securityRecord,
      pendingDir: pending.entry,
      pendingRecord: pending.record,
      pendingSecurityRecord: pending.securityRecord,
      temporaryPaths,
      published: false,
      cleaned: false,
    };
  } catch (error) {
    let cleanupFailed = false;
    try { if (pending?.entry) fs.rmSync(pending.entry, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    try { if (lock?.entry) fs.rmSync(lock.entry, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    const primary = error?.message?.startsWith('release artifact')
      ? error : publicationError('release artifact publication setup failed');
    if (cleanupFailed) {
      primary.message = `${primary.message}\nRelease artifact temporary cleanup failed; temporary artifacts were retained for runner cleanup.`;
    }
    throw primary;
  }
}

function assertPublicationContainer(publication, { strictFence = true } = {}) {
  try {
    const outputRecord = publicationDirectoryRecord(publication.outputDir);
    const lockRecord = publicationDirectoryRecord(publication.lockDir);
    const pendingRecord = publicationDirectoryRecord(publication.pendingDir);
    if (!samePublicationDirectory(outputRecord, publication.outputRecord)
      || !samePublicationDirectory(lockRecord, publication.lockRecord)
      || !samePublicationDirectory(pendingRecord, publication.pendingRecord)
      || privatePublicationSecurityRecord(publication.lockDir) !== publication.lockSecurityRecord
      || privatePublicationSecurityRecord(publication.pendingDir) !== publication.pendingSecurityRecord) {
      throw new Error('identity mismatch');
    }
    if (strictFence) {
      const currentFence = auditedAncestorIdentityDigest(
        path.join(publication.outputDir, '.publication-fence'),
        publication.authorityRoot,
      );
      if (currentFence !== publication.outputFence) throw new Error('fence mismatch');
    }
  } catch {
    throw publicationError('release artifact publication authorization changed');
  }
}

function publicationArtifactState(file, publication) {
  let before;
  let digest;
  let after;
  try {
    before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('not regular');
    if (String(before.dev) !== publication.pendingRecord.dev) throw new Error('different filesystem');
    digest = verifiedReleaseFileDigest(file, { verifiedRoot: publication.pendingDir });
    after = fs.lstatSync(file, { bigint: true });
    if (!samePathRecord(before, after)) throw new Error('changed');
  } catch {
    throw publicationError('release artifact temporary output is not authorized');
  }
  return {
    dev: String(after.dev),
    ino: String(after.ino),
    mode: Number(after.mode & 0o777n),
    size: String(after.size),
    mtimeNs: String(after.mtimeNs),
    ctimeNs: String(after.ctimeNs),
    digest,
  };
}

function sameArtifactState(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.digest === right.digest;
}

export function authorizeArtifactPublication(publication) {
  assertPublicationContainer(publication);
  let entries;
  try {
    entries = fs.readdirSync(publication.pendingDir).sort();
  } catch {
    throw publicationError('release artifact temporary output is not authorized');
  }
  if (entries.join('\0') !== [...publication.artifactNames].sort().join('\0')) {
    throw publicationError('release artifact temporary output is not authorized');
  }
  const artifacts = Object.fromEntries(publication.artifactNames.map((name) => [
    name,
    publicationArtifactState(publication.temporaryPaths[name], publication),
  ]));
  return {
    publicationId: publication.id,
    outputFence: publication.outputFence,
    artifacts,
  };
}

export function writeArtifactChecksums(publication, {
  manifestName = 'checksums.txt',
} = {}) {
  if (!publication.artifactNames.includes(manifestName)) {
    throw publicationError('release artifact publication does not authorize a checksum manifest');
  }
  const artifacts = publication.artifactNames.filter((name) => name !== manifestName).sort();
  if (!artifacts.length) throw publicationError('release artifact checksum manifest has no subjects');
  const content = artifacts.map((name) => (
    `${verifiedReleaseFileDigest(publication.temporaryPaths[name], { verifiedRoot: publication.pendingDir })}  ${name}`
  )).join('\n') + '\n';
  try {
    fs.writeFileSync(publication.temporaryPaths[manifestName], content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    throw publicationError('release artifact checksum manifest could not be created');
  }
  return publication.temporaryPaths[manifestName];
}

function safeUnlinkPublished(finalPath, expected) {
  try {
    const stat = fs.lstatSync(finalPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()
      || String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino) return false;
    fs.unlinkSync(finalPath);
    return true;
  } catch {
    return false;
  }
}

function removeArtifactPublication(publication) {
  if (publication.cleaned) return { removed: true };
  assertPublicationContainer(publication, { strictFence: false });
  fs.rmSync(publication.pendingDir, { recursive: true, force: false });
  fs.rmSync(publication.lockDir, { recursive: true, force: false });
  publication.cleaned = true;
  return { removed: true };
}

export function finishArtifactPublication(publication, {
  primaryError = null,
  remove = removeArtifactPublication,
} = {}) {
  if (!publication || publication.cleaned) return { removed: true };
  try {
    return remove(publication);
  } catch {
    const message = 'Release artifact temporary cleanup failed; temporary artifacts were retained for runner cleanup.';
    if (primaryError instanceof Error) {
      if (!primaryError.message.includes(message)) primaryError.message = `${primaryError.message}\n${message}`;
      return { removed: false };
    }
    throw publicationError(message);
  }
}

export function promoteArtifactPublication(publication, authorization, {
  remove = removeArtifactPublication,
} = {}) {
  if (!authorization || authorization.publicationId !== publication.id
    || authorization.outputFence !== publication.outputFence) {
    throw publicationError('release artifact publication authorization changed');
  }
  for (const name of publication.artifactNames) {
    try {
      fs.lstatSync(path.join(publication.outputDir, name));
      throw publicationError('release artifact destination already exists');
    } catch (error) {
      if (error?.message === 'release artifact destination already exists') throw error;
      if (error?.code !== 'ENOENT') {
        throw publicationError('release artifact destination cannot be validated');
      }
    }
  }
  assertPublicationContainer(publication);
  for (const name of publication.artifactNames) {
    const current = publicationArtifactState(publication.temporaryPaths[name], publication);
    if (!sameArtifactState(current, authorization.artifacts[name])) {
      throw publicationError('release artifact publication authorization changed');
    }
  }

  const linked = [];
  try {
    for (const name of publication.artifactNames) {
      const temporary = publication.temporaryPaths[name];
      const finalPath = path.join(publication.outputDir, name);
      try {
        fs.linkSync(temporary, finalPath);
      } catch (error) {
        if (error?.code === 'EEXIST') throw publicationError('release artifact destination already exists');
        throw publicationError('release artifact atomic publication failed');
      }
      const expected = authorization.artifacts[name];
      const finalStat = fs.lstatSync(finalPath, { bigint: true });
      if (!finalStat.isFile() || finalStat.isSymbolicLink()
        || String(finalStat.dev) !== expected.dev || String(finalStat.ino) !== expected.ino) {
        throw publicationError('release artifact publication authorization changed');
      }
      linked.push({ finalPath, expected });
    }
    publication.published = true;
    publication.outputFence = auditedAncestorIdentityDigest(
      path.join(publication.outputDir, '.publication-fence'),
      publication.authorityRoot,
    );
    try {
      remove(publication);
    } catch {
      throw publicationError('Authorized final artifact exists, but temporary cleanup failed; temporary artifacts were retained for runner cleanup.');
    }
    return {
      finalPaths: Object.fromEntries(publication.artifactNames.map((name) => [
        name,
        path.join(publication.outputDir, name),
      ])),
    };
  } catch (error) {
    if (!publication.published) {
      for (const { finalPath, expected } of linked.reverse()) safeUnlinkPublished(finalPath, expected);
      try {
        publication.outputFence = auditedAncestorIdentityDigest(
          path.join(publication.outputDir, '.publication-fence'),
          publication.authorityRoot,
        );
      } catch {}
    }
    if (/^(?:release artifact|Authorized final artifact)/.test(String(error?.message || ''))) throw error;
    throw publicationError('release artifact publication authorization changed');
  }
}

export function stagePublicSource({
  root = DEFAULT_ROOT,
  stageDir = path.join(root, 'dist', 'release', 'public-source'),
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedStage = path.resolve(stageDir);
  fs.rmSync(resolvedStage, { recursive: true, force: true });
  for (const entry of PUBLIC_SOURCE_FILES) {
    const source = required(resolvedRoot, entry.source);
    const target = path.join(resolvedStage, entry.target);
    if (entry.tree) copyTree(source, target, normalise(entry.target), includePublicSourcePath, resolvedRoot);
    else copyRegularFile(source, target, resolvedRoot);
  }
  return { root: resolvedRoot, stageDir: resolvedStage };
}

export function auditPublicSourceStage({
  root = DEFAULT_ROOT,
  stageDir,
  markers = process.env.SCOUT_RELEASE_MARKERS || '',
} = {}) {
  const result = spawnSync(process.execPath, [
    path.join(path.resolve(root), 'tools', 'release-audit.mjs'),
    '--root',
    path.resolve(stageDir),
    '--stage',
    '--require-markers',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SCOUT_RELEASE_MARKERS: markers },
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`public source privacy audit failed:\n${String(result.stdout || '')}\n${String(result.stderr || '')}`.trim());
  }
  return { status: result.status, output: String(result.stdout || '') };
}

function releasePathIdentity(root, file) {
  const resolvedRoot = path.resolve(root);
  const value = path.resolve(file);
  const fromRoot = path.relative(resolvedRoot, value);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    if (value !== resolvedRoot) throw new Error('required release input escapes its root');
  }
  const identities = [];
  let component = resolvedRoot;
  for (const segment of fromRoot ? fromRoot.split(path.sep) : []) {
    const rootStat = fs.lstatSync(component);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(`release input ancestor must be a real directory: ${component}`);
    }
    identities.push(`${rootStat.dev}:${rootStat.ino}`);
    component = path.join(component, segment);
  }
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`release input root must be a real directory: ${resolvedRoot}`);
  }
  if (!identities.length) identities.push(`${rootStat.dev}:${rootStat.ino}`);
  return identities.join('|');
}

function required(root, relative) {
  const resolvedRoot = path.resolve(root);
  const value = path.resolve(resolvedRoot, relative);
  if (!fs.existsSync(value)) throw new Error(`required release input is missing: ${relative}`);
  releasePathIdentity(resolvedRoot, value);
  return value;
}

export function stageRelease({
  root = DEFAULT_ROOT,
  stageDir = path.join(root, 'dist', 'release', 'stage'),
  nodeExecutable = process.execPath,
  includeDependencies = true,
  platform = process.platform,
  typstExecutable,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedStage = path.resolve(stageDir);
  fs.rmSync(resolvedStage, { recursive: true, force: true });
  const appDir = path.join(resolvedStage, 'app');

  for (const entry of RELEASE_FILES) {
    const source = required(resolvedRoot, entry.source);
    const target = path.join(appDir, entry.target);
    if (entry.tree) copyTree(source, target, normalise(entry.target), includeReleasePath, resolvedRoot);
    else copyRegularFile(source, target, resolvedRoot);
  }

  const lock = writeProductionManifests(resolvedRoot, appDir);
  if (includeDependencies) {
    const includeProductionDependency = productionDependencyFilter(lock);
    copyTree(
      required(resolvedRoot, 'node_modules'),
      path.join(appDir, 'node_modules'),
      '',
      (relative) => includeReleasePath(relative) && includeProductionDependency(relative),
      resolvedRoot,
    );
  }
  const runtimeDir = path.join(resolvedStage, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeName = platform === 'win32' ? 'ScoutRuntime.exe' : 'node';
  const nodeRoot = path.dirname(nodeExecutable);
  copyRegularFile(
    required(nodeRoot, path.basename(nodeExecutable)),
    path.join(runtimeDir, runtimeName),
    nodeRoot,
  );
  if (platform !== 'win32') fs.chmodSync(path.join(runtimeDir, runtimeName), 0o755);
  const typstName = platform === 'win32' ? 'typst.exe' : 'typst';
  const typstSource = typstExecutable || path.join(resolvedRoot, '.scout-runtime', typstName);
  const typstRoot = path.dirname(typstSource);
  copyRegularFile(
    required(typstRoot, path.basename(typstSource)),
    path.join(runtimeDir, typstName),
    typstRoot,
  );
  if (platform !== 'win32') fs.chmodSync(path.join(runtimeDir, typstName), 0o755);

  return { root: resolvedRoot, stageDir: resolvedStage, appDir };
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function verifiedReleaseFileDigest(file, {
  verifiedRoot = path.dirname(file),
} = {}) {
  return crypto.createHash('sha256')
    .update(readRegularFile(path.resolve(file), path.resolve(verifiedRoot)))
    .digest('hex');
}

export function verifiedReleaseTreeDigest(root) {
  const verifiedRoot = path.resolve(root);
  const digest = crypto.createHash('sha256');
  const visit = (source, relative = '', expected = null) => {
    const before = fs.lstatSync(source, { bigint: true });
    if (expected && !samePathRecord(before, expected)) {
      throw new Error(`release payload changed after directory enumeration: ${source}`);
    }
    if (before.isSymbolicLink()) throw new Error(`release payload may not contain a symbolic link: ${source}`);
    if (before.isFile()) {
      const { content, mode } = readRegularFileRecord(source, verifiedRoot, before);
      digest.update('file\0').update(normalise(relative)).update('\0')
        .update(String(mode)).update('\0').update(content).update('\0');
      return;
    }
    if (!before.isDirectory()) throw new Error(`release payload entry must be a regular file or directory: ${source}`);
    digest.update('directory\0').update(normalise(relative)).update('\0');
    const entries = fs.readdirSync(source).sort().map((name) => ({
      name,
      stat: fs.lstatSync(path.join(source, name), { bigint: true }),
    }));
    for (const { name, stat } of entries) {
      visit(path.join(source, name), relative ? path.join(relative, name) : name, stat);
    }
    const after = fs.lstatSync(source, { bigint: true });
    if (!samePathRecord(after, before)) {
      throw new Error(`release payload directory changed while hashing: ${source}`);
    }
  };
  visit(verifiedRoot);
  return digest.digest('hex');
}

export function writeChecksums(outputDir) {
  const files = fs.readdirSync(outputDir)
    .filter((name) => name !== 'checksums.txt' && fs.statSync(path.join(outputDir, name)).isFile())
    .sort();
  if (!files.length) throw new Error(`no release artifacts found in ${outputDir}`);
  const content = files.map((name) => `${sha256(path.join(outputDir, name))}  ${name}`).join('\n') + '\n';
  const target = path.join(outputDir, 'checksums.txt');
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

function findIscc(env = process.env) {
  const candidates = [
    env.ISCC_PATH,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe') : null,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function packageVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function checkedVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) throw new Error(`invalid release version: ${value}`);
  return value;
}

export function buildInstaller({ root = DEFAULT_ROOT, stageDir, version, isccPath } = {}) {
  const staged = stageRelease({ root, stageDir });
  const packageInputs = path.join(staged.stageDir, 'package-inputs');
  const hostSource = path.join(packageInputs, 'ScoutHost.cs');
  const installerSource = path.join(packageInputs, 'Scout.iss');
  copyVerifiedReleaseFile(
    required(root, 'installer/windows/ScoutHost.cs'),
    hostSource,
    { verifiedRoot: root },
  );
  copyVerifiedReleaseFile(
    required(root, 'installer/Scout.iss'),
    installerSource,
    { verifiedRoot: root },
  );
  const hostSourceDigest = verifiedReleaseFileDigest(hostSource, { verifiedRoot: staged.stageDir });
  const installerSourceDigest = verifiedReleaseFileDigest(installerSource, { verifiedRoot: staged.stageDir });
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error('Windows C# compiler was not found');
  const stagedIcon = path.join(staged.appDir, 'ui', 'assets', 'scout-icon.ico');
  const host = spawnSync(csc, ['/nologo', '/target:winexe', `/win32icon:${stagedIcon}`, `/out:${path.join(staged.stageDir, 'Scout.exe')}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', hostSource], { cwd: staged.stageDir, encoding: 'utf8', windowsHide: true });
  if (host.status !== 0) throw new Error(`Scout host build failed:\n${host.stdout}\n${host.stderr}`);
  if (
    verifiedReleaseFileDigest(hostSource, { verifiedRoot: staged.stageDir }) !== hostSourceDigest
    || verifiedReleaseFileDigest(installerSource, { verifiedRoot: staged.stageDir }) !== installerSourceDigest
  ) {
    throw new Error('verified Windows package input changed during compilation');
  }
  const audit = auditStageBeforePackaging(staged.stageDir, { authorizationRoot: root });
  const auditedStage = audit.stageDir;
  let primaryError = null;
  let publication = null;
  try {
    assertAuditedStage(audit);
    const auditedPayloadDigest = verifiedReleaseTreeDigest(auditedStage);
    const outputDir = path.join(root, 'installer', 'output');
    const iscc = isccPath || findIscc();
    if (!iscc) throw new Error('Inno Setup 6 was not found; install it or set ISCC_PATH');
    const selectedVersion = checkedVersion(version || process.env.SCOUT_VERSION || packageVersion(root));
    const installerName = `Scout-${selectedVersion}-windows-x64.exe`;
    publication = createArtifactPublication({
      outputDir,
      authorityRoot: root,
      artifactNames: [installerName, 'checksums.txt'],
    });
    const result = spawnSync(iscc, [
      `/DMyAppVersion=${selectedVersion}`,
      `/DStageDir=${auditedStage}`,
      `/DIconFile=${path.join(auditedStage, path.relative(staged.stageDir, stagedIcon))}`,
      `/DOutputDir=${publication.pendingDir}`,
      path.join(auditedStage, path.relative(staged.stageDir, installerSource)),
    ], { cwd: auditedStage, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`Inno Setup failed:\n${String(result.stdout || '')}\n${String(result.stderr || '')}`.trim());
    if (verifiedReleaseTreeDigest(auditedStage) !== auditedPayloadDigest) {
      throw new Error('audited Windows release payload changed during packaging');
    }
    assertAuditedStage(audit);
    writeArtifactChecksums(publication);
    const authorization = authorizeArtifactPublication(publication);
    const promoted = promoteArtifactPublication(publication, authorization);
    return {
      ...staged,
      outputDir,
      checksums: promoted.finalPaths['checksums.txt'],
      version: selectedVersion,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (publication) finishArtifactPublication(publication, { primaryError });
    finishAuditedStageCleanup(auditedStage, { primaryError });
  }
}

function valueAfter(flag, argv) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  if (!argv[index + 1]) throw new Error(`${flag} requires a value`);
  return argv[index + 1];
}

async function main(argv = process.argv.slice(2)) {
  const installer = argv.includes('--installer');
  const publicSource = argv.includes('--public-source');
  if ([installer, argv.includes('--stage-only'), publicSource].filter(Boolean).length > 1) throw new Error('choose one release output mode');
  const root = DEFAULT_ROOT;
  const stageDir = valueAfter('--stage-dir', argv) || undefined;
  const result = publicSource
    ? stagePublicSource({ root, stageDir })
    : installer
    ? buildInstaller({ root, stageDir, version: valueAfter('--version', argv) || undefined })
    : stageRelease({ root, stageDir });
  if (publicSource) auditPublicSourceStage({ root, stageDir: result.stageDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = isMainModule(import.meta.url);
if (isMain) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
