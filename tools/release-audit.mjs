#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';

const DEFAULT_BUILD_DIRS = ['dist', path.join('installer', 'output')];
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);
const PLACEHOLDER = /^(?:change-?me|dummy|example|fake|not-?set|placeholder|redacted|replace-?me|test|todo|your[-_].*|<.*>|\$\{.*\})$/i;

const SECRET_RULES = Object.freeze([
  { id: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { id: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api-key', regex: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
]);

function normaliseRelative(root, file) {
  const relative = path.relative(root, file);
  return relative.split(path.sep).join('/');
}

function testOnlySource(relative) {
  const value = String(relative).split(path.sep).join('/');
  const base = path.posix.basename(value);
  return /\.test\.mjs$/i.test(base)
    || value.split('/').some((part) => ['fixtures', 'test', 'tests', 'test-data', '__tests__', '__snapshots__'].includes(part));
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function isPlaceholder(value) {
  return PLACEHOLDER.test(String(value).trim().replace(/^['"]|['"]$/g, ''));
}

function secretAssignmentFindings(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const assignment = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token)\b\s*[:=]\s*(['"]?)([^\s'";#]{8,})\1/i;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(assignment);
    if (!match) continue;
    const quoted = Boolean(match[1]);
    const value = match[2];
    // Unquoted expressions and property references are code, not embedded
    // credentials. Quoted literals are always checked; unquoted values must
    // resemble a literal rather than `env.KEY`, `portal.token`, or a call.
    if (!quoted && /[().,]/.test(value)) continue;
    if (!isPlaceholder(value)) findings.push({ line: i + 1, rule: 'secret-assignment' });
  }
  return findings;
}

function scanText(text, markers) {
  const findings = [];
  const lower = text.toLocaleLowerCase('en-US');
  for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
    const needle = markers[markerIndex].toLocaleLowerCase('en-US');
    let offset = 0;
    while ((offset = lower.indexOf(needle, offset)) !== -1) {
      findings.push({ line: lineAt(text, offset), rule: `personal-marker-${markerIndex + 1}` });
      offset += Math.max(needle.length, 1);
    }
  }
  for (const { id, regex } of SECRET_RULES) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      findings.push({ line: lineAt(text, match.index), rule: id });
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  }
  findings.push(...secretAssignmentFindings(text));
  return findings;
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const visit = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      result.push(entry);
      return;
    }
    if (!stat.isDirectory() || IGNORED_DIRECTORY_NAMES.has(path.basename(entry))) return;
    for (const name of fs.readdirSync(entry).sort()) visit(path.join(entry, name));
  };
  visit(directory);
  return result;
}

export function collectTrackedFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer', windowsHide: true });
  if (result.status !== 0) throw new Error('could not list Git-tracked files');
  return result.stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

export function loadMarkers({ markerFile, envMarkers } = {}) {
  const lines = [];
  if (markerFile) {
    const text = fs.readFileSync(markerFile, 'utf8');
    lines.push(...text.split(/\r?\n/));
  }
  if (envMarkers) lines.push(...String(envMarkers).split(/\r?\n/));
  return [...new Set(lines.map((line) => line.trim()).filter((line) => line && !line.startsWith('#')))].sort();
}

export function auditRelease({
  root = process.cwd(),
  trackedFiles,
  buildDirs = DEFAULT_BUILD_DIRS,
  markers = [],
  markerFile = null,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const excluded = markerFile ? path.resolve(markerFile) : null;
  const listedTrackedFiles = trackedFiles ?? collectTrackedFiles(absoluteRoot);
  const tracked = listedTrackedFiles
    .filter((file) => trackedFiles !== undefined || !testOnlySource(file))
    .map((file) => path.resolve(absoluteRoot, file))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  const built = buildDirs.flatMap((dir) => filesUnder(path.resolve(absoluteRoot, dir)));
  const files = [...new Set([...tracked, ...built])]
    .filter((file) => file !== excluded)
    .sort((a, b) => normaliseRelative(absoluteRoot, a).localeCompare(normaliseRelative(absoluteRoot, b), 'en'));
  const findings = [];
  let filesScanned = 0;
  for (const file of files) {
    const content = fs.readFileSync(file);
    if (content.subarray(0, 8192).includes(0)) continue;
    filesScanned += 1;
    const text = content.toString('utf8');
    for (const finding of scanText(text, markers)) {
      findings.push({ file: normaliseRelative(absoluteRoot, file), ...finding });
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line || a.rule.localeCompare(b.rule, 'en'));
  return { ok: findings.length === 0, filesScanned, markerCount: markers.length, findings };
}

function valuesAfter(flag, argv) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === flag && argv[i + 1]) values.push(argv[i + 1]);
  return values;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const rootValue = valuesAfter('--root', argv).at(-1);
  const root = path.resolve(rootValue || process.cwd());
  const markerFileValue = valuesAfter('--markers-file', argv).at(-1) || env.SCOUT_RELEASE_MARKERS_FILE || null;
  const markerFile = markerFileValue ? path.resolve(root, markerFileValue) : null;
  const markers = loadMarkers({ markerFile, envMarkers: env.SCOUT_RELEASE_MARKERS });
  if (argv.includes('--require-markers') && markers.length === 0) throw new Error('release audit requires at least one configured personal marker');
  const explicitBuildDirs = valuesAfter('--build', argv);
  const stagedTree = argv.includes('--stage');
  const stagedFiles = stagedTree
    ? filesUnder(root).map((file) => normaliseRelative(root, file))
    : undefined;
  const result = auditRelease({
    root,
    markerFile,
    markers,
    trackedFiles: stagedFiles,
    buildDirs: stagedTree ? [] : (explicitBuildDirs.length ? explicitBuildDirs : DEFAULT_BUILD_DIRS),
  });
  process.stdout.write(`Release audit scanned ${result.filesScanned} files with ${result.markerCount} configured personal markers.\n`);
  for (const finding of result.findings) process.stdout.write(`${finding.file}:${finding.line} ${finding.rule}\n`);
  process.stdout.write(result.ok ? 'Release audit passed.\n' : `Release audit failed with ${result.findings.length} finding(s).\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  try { main(); }
  catch (error) {
    process.stderr.write(`Release audit configuration error: ${error.message}\n`);
    process.exitCode = 2;
  }
}
