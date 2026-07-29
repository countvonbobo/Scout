#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';

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

export function includeReleasePath(relative) {
  const value = normalise(relative);
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
  if (!includeReleasePath(value) && !/\.test\.mjs$/i.test(path.posix.basename(value))) return false;
  if (value === 'output' || value.startsWith('output/')) return false;
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
  const manifest = JSON.parse(fs.readFileSync(required(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(required(root, 'package-lock.json'), 'utf8'));
  fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(productionPackageManifest(manifest), null, 2)}\n`);
  fs.writeFileSync(path.join(appDir, 'package-lock.json'), `${JSON.stringify(productionLockfile(lock), null, 2)}\n`);
  return lock;
}

function copyTree(source, target, relative = '', include = includeReleasePath) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`release input may not be a symbolic link: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) {
      const childRelative = relative ? path.join(relative, name) : name;
      if (!include(childRelative)) continue;
      copyTree(path.join(source, name), path.join(target, name), childRelative, include);
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
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
    if (entry.tree) copyTree(source, target, '', entry.publicFilter ? includePublicSourcePath : () => true);
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  return { root: resolvedRoot, stageDir: resolvedStage };
}

function required(root, relative) {
  const value = path.join(root, relative);
  if (!fs.existsSync(value)) throw new Error(`required release input is missing: ${relative}`);
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
    if (entry.tree) copyTree(source, target);
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }

  const lock = writeProductionManifests(resolvedRoot, appDir);
  if (includeDependencies) {
    const includeProductionDependency = productionDependencyFilter(lock);
    copyTree(
      required(resolvedRoot, 'node_modules'),
      path.join(appDir, 'node_modules'),
      '',
      (relative) => includeReleasePath(relative) && includeProductionDependency(relative),
    );
  }
  const runtimeDir = path.join(resolvedStage, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeName = platform === 'win32' ? 'ScoutRuntime.exe' : 'node';
  fs.copyFileSync(required(path.dirname(nodeExecutable), path.basename(nodeExecutable)), path.join(runtimeDir, runtimeName));
  if (platform !== 'win32') fs.chmodSync(path.join(runtimeDir, runtimeName), 0o755);
  const typstName = platform === 'win32' ? 'typst.exe' : 'typst';
  const typstSource = typstExecutable || path.join(resolvedRoot, '.scout-runtime', typstName);
  fs.copyFileSync(required(path.dirname(typstSource), path.basename(typstSource)), path.join(runtimeDir, typstName));
  if (platform !== 'win32') fs.chmodSync(path.join(runtimeDir, typstName), 0o755);

  return { root: resolvedRoot, stageDir: resolvedStage, appDir };
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) throw new Error('Windows C# compiler was not found');
  const host = spawnSync(csc, ['/nologo', '/target:winexe', `/win32icon:${path.join(root, 'ui', 'assets', 'scout-icon.ico')}`, `/out:${path.join(staged.stageDir, 'Scout.exe')}`, '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', path.join(root, 'installer', 'windows', 'ScoutHost.cs')], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (host.status !== 0) throw new Error(`Scout host build failed:\n${host.stdout}\n${host.stderr}`);
  const outputDir = path.join(root, 'installer', 'output');
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  const iscc = isccPath || findIscc();
  if (!iscc) throw new Error('Inno Setup 6 was not found; install it or set ISCC_PATH');
  const selectedVersion = checkedVersion(version || process.env.SCOUT_VERSION || packageVersion(root));
  const result = spawnSync(iscc, [
    `/DMyAppVersion=${selectedVersion}`,
    `/DStageDir=${staged.stageDir}`,
    path.join(root, 'installer', 'Scout.iss'),
  ], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Inno Setup failed:\n${String(result.stdout || '')}\n${String(result.stderr || '')}`.trim());
  const checksums = writeChecksums(outputDir);
  return { ...staged, outputDir, checksums, version: selectedVersion };
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
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain = isMainModule(import.meta.url);
if (isMain) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
