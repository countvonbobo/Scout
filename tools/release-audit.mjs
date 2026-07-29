#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';

const DEFAULT_BUILD_DIRS = ['dist', path.join('installer', 'output')];
const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);
const PLACEHOLDER = /^(?:change-?me|dummy|example|fake|not-?set|placeholder|redacted|replace-?me|test|todo|your[-_][a-z0-9_-]+|<[^>\r\n]+>|\$\{[A-Z][A-Z0-9_]*\})$/i;

const SECRET_RULES = Object.freeze([
  { id: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { id: 'aws-access-key', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: 'github-token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { id: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'google-api-key', regex: /\bAIza[A-Za-z0-9_-]{30,}\b/g },
  { id: 'authorization-bearer', regex: /\bAuthorization["']?[ \t]*[:=][ \t]*["']?Bearer[ \t]+[A-Za-z0-9._~+/-]{16,}\b/gi },
  { id: 'openai-token', regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
]);
const PRIVATE_RUNTIME_ROOTS = new Set([
  '.scout', 'applications', 'chats', 'cv', 'data', 'profile', 'reports',
]);
const SERIALIZED_EXTENSIONS = /\.(?:json|jsonl|ndjson|log|out|txt)$/i;
const PRIVATE_PATH = /\/Users\/(?!(?:Shared|Public)(?:\/|["'\s])|YOUR|<)[^/"'\s]+|\/home\/(?!YOUR|<)[^/"'\s]+|[A-Za-z]:[\\/]Users[\\/](?!Public(?:[\\/]|["'\s])|YOUR|<)[^\\/"'\s]+/gi;
const DOCUMENTED_PUBLIC_PATH_FILES = new Set([
  'docs/INSTALL_VPS.md',
  'docs/diagnostics/beta15-vps-workspace-incident.md',
  'tools/deploy-vps.sh',
]);
const PUBLIC_UI_BINARY_ASSETS = new Set([
  'scout-explaining.png',
  'scout-found.png',
  'scout-icon.ico',
  'scout-icon.png',
  'scout-idle.png',
  'scout-searching.png',
  'scout-static.png',
  'scout-thinking.png',
  'scout-warning.png',
]);
const PUBLIC_DOC_SCREENSHOTS = new Set([
  'docs/screenshots/0.1.0-beta.23/codex-remote-fallback.png',
  'docs/screenshots/0.1.0-beta.23/trustworthy-model-picker.png',
  'docs/screenshots/0.1.0-beta.23/usage-and-engine-regions.png',
]);
const BINARY_OR_DOCUMENT_EXTENSION = /\.(?:7z|bin|bz2|db|dmg|doc|docx|exe|gz|ico|icc|jpeg|jpg|msi|node|odt|pdf|pfb|pkg|png|rtf|sqlite|sqlite3|tar|tgz|ttf|wasm|xz|zip)$/i;

function normaliseRelative(root, file) {
  const relative = path.relative(root, file);
  return relative.split(path.sep).join('/');
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
  const assignment = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|secret|token)\b\s*[:=]\s*(['"]?)([^\s'";#]{8,})\1/gi;
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(assignment)) {
      const quoted = Boolean(match[1]);
      const value = match[2];
      // Unquoted expressions and property references are code, not embedded
      // credentials. Quoted literals are always checked; unquoted values must
      // resemble a literal rather than `env.KEY`, `portal.token`, or a call.
      if (!quoted && /[().,`$]/.test(value)) continue;
      if (!isPlaceholder(value)) findings.push({ line: i + 1, rule: 'secret-assignment' });
    }
  }
  return findings;
}

function normaliseSerializedKey(key) {
  return String(key).normalize('NFKC').replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en-US');
}

function privacyRuleForKey(key, value, owner = {}, ancestors = []) {
  const normal = normaliseSerializedKey(key);
  const inAuthContext = ancestors.some((part) =>
    /(?:auth|authentication|authorization|credential|device|login|provider|session)/.test(part));
  if (normal === 'authorization'
    || normal === 'credentials'
    || ['accesstoken', 'authtoken', 'bearertoken', 'clientsecret', 'idtoken', 'password', 'refreshtoken'].includes(normal)
    || (normal === 'token' && inAuthContext)) {
    return 'credential';
  }
  if (['authstate', 'authenticationstate', 'loginstate'].includes(normal)) return 'raw-auth-state';
  if (['response', 'result'].includes(normal)
    && ancestors.some((part) => /(?:auth|authentication|authorization|device|login)/.test(part))) {
    return 'raw-auth-output';
  }
  if (normal === 'events'
    || (normal === 'state' && ancestors.some((part) => /(?:run|scan|journal)/.test(part)))
    || (normal.includes('raw') && /(?:run|scan|execution|journal|state|event)/.test(normal))) {
    return 'raw-run-state';
  }
  if (['output', 'payload', 'stdout', 'stderr'].includes(normal)
    || (normal.includes('raw') && /(?:auth|login|provider|output|response|transcript)/.test(normal))) {
    return 'raw-auth-output';
  }
  if (normal === 'usercode'
    || /(?:auth|authentication|authorization|device|login).*code/.test(normal)
    || (normal === 'code' && /^(?:claude|codex)$/i.test(String(owner.provider || '')))
    || (normal === 'code' && ancestors.some((part) => /(?:auth|device|login|provider|session)/.test(part)))) return 'auth-code';
  if (normal.includes('prompt')) return 'full-prompt';
  if (normal === 'content'
    && /^(?:system|user)$/i.test(String(owner.role || ''))
    && ancestors.some((part) => /messages?/.test(part))) return 'full-prompt';
  if (normal === 'resume' || normal === 'mastercv'
    || (/(?:cv|resume)/.test(normal) && /(?:body|content|document|text)/.test(normal))) return 'cv-body';
  if (normal.includes('advert') || /job(?:body|description|text|content)/.test(normal)) return 'advert-body';
  if (['body', 'content', 'text'].includes(normal)
    && ancestors.some((part) => /(?:advert|job|vacancy)/.test(part))) return 'advert-body';
  if (normal === 'description' && typeof value === 'string'
    && (value.length >= 120
      || ['company', 'role', 'title'].some((field) => Object.hasOwn(owner, field))
      || ancestors.some((part) => /(?:advert|job|vacancy)/.test(part)))) {
    return 'advert-body';
  }
  if (normal.includes('transcript')) return 'provider-transcript';
  if (normal.includes('tracking') || /^utm(?:source|medium|campaign|term|content)$/.test(normal)
    || ['fbclid', 'gclid', 'msclkid'].includes(normal)) return 'tracking-value';
  return null;
}

function serializedPrivacyFindings(text) {
  const findings = [];
  const seen = new Set();
  const inspect = (value, owner = value, ancestors = []) => {
    if (Array.isArray(value)) {
      for (const item of value) inspect(item, item, ancestors);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const rule = privacyRuleForKey(key, child, owner, ancestors);
      if (rule) {
        const index = text.search(new RegExp(`["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:`, 'i'));
        const finding = `${rule}:${Math.max(index, 0)}`;
        if (!seen.has(finding)) {
          seen.add(finding);
          findings.push({ line: lineAt(text, Math.max(index, 0)), rule });
        }
      }
      inspect(child, child, [...ancestors, normaliseSerializedKey(key)]);
    }
  };
  const records = [];
  try {
    records.push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/).filter((entry) => entry.trim())) {
      try { records.push(JSON.parse(line)); } catch { /* handled by fallback key scan below */ }
    }
  }
  for (const record of records) inspect(record);

  // Text exports and damaged JSON still fail closed on high-signal field names.
  const key = /["']?([A-Za-z][A-Za-z0-9_-]{1,80})["']?\s*:/g;
  let match;
  while ((match = key.exec(text)) !== null) {
    const rule = privacyRuleForKey(match[1], null, {});
    const finding = `${rule}:${match.index}`;
    if (rule && !seen.has(finding)) {
      seen.add(finding);
      findings.push({ line: lineAt(text, match.index), rule });
    }
  }
  return findings;
}

function serializedByContent(text, relative) {
  if (SERIALIZED_EXTENSIONS.test(relative)) return true;
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return false;
  try {
    JSON.parse(lines.join('\n'));
    return true;
  } catch {
    try {
      return lines.every((line) => {
        JSON.parse(line);
        return true;
      });
    } catch {
      return false;
    }
  }
}

function scanText(text, markers, relative = '') {
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
  if (serializedByContent(text, relative)) findings.push(...serializedPrivacyFindings(text));
  let pathText = text.replaceAll('\\\\', '\\');
  const documentedPublicPath = [...DOCUMENTED_PUBLIC_PATH_FILES].some((documented) =>
    relative === documented || relative === `app/${documented}` || relative.endsWith(`/app/${documented}`));
  if (documentedPublicPath) {
    pathText = pathText.replaceAll(/\/home\/(?:scout-deploy|ubuntu)/g, '/home/YOUR');
  }
  PRIVATE_PATH.lastIndex = 0;
  let pathMatch;
  while ((pathMatch = PRIVATE_PATH.exec(pathText)) !== null) {
    findings.push({ line: lineAt(pathText, pathMatch.index), rule: 'private-path' });
  }
  return findings;
}

function privateRuntimeArtifact(relative) {
  const parts = String(relative).split(/[\\/]+/).filter(Boolean)
    .map((part) => part.toLocaleLowerCase('en-US'));
  if (PRIVATE_RUNTIME_ROOTS.has(parts[0])) return true;
  // Release build output wraps the source tree under paths such as
  // dist/release/stage/app/. The app boundary, wherever its staging parents
  // live, must apply the same private-root exclusion as a direct stage audit.
  return parts.some((part, index) =>
    part === 'app' && PRIVATE_RUNTIME_ROOTS.has(parts[index + 1]));
}

function allowedReleaseBinary(relative) {
  const value = String(relative).replaceAll('\\', '/').toLocaleLowerCase('en-US');
  const appIndex = value.lastIndexOf('/app/');
  const packaged = appIndex === -1 ? value : value.slice(appIndex + 1);
  if (packaged.startsWith('app/node_modules/') || packaged.startsWith('node_modules/')) return true;
  if (/^(?:.*\/)?runtime\/(?:node|node\.exe|scoutruntime\.exe|typst|typst\.exe)$/.test(value)) return true;
  if (value === 'scout.exe' || /^dist\/release\/[^/]+\/scout\.exe$/.test(value)) return true;
  if (/(?:^|\/)dmg-root\/scout\.app\/contents\/macos\/scout$/.test(value)) return true;
  const asset = packaged.match(/^(?:app\/)?ui\/assets\/([^/]+)$/)?.[1];
  if (asset && PUBLIC_UI_BINARY_ASSETS.has(asset)) return true;
  if ([...PUBLIC_DOC_SCREENSHOTS].some((screenshot) =>
    value === screenshot || value.endsWith(`/app/${screenshot}`) || value.endsWith(`/${screenshot}`))) return true;
  return false;
}

function binaryContent(content) {
  const sample = content.subarray(0, Math.min(content.length, 64 * 1024));
  if (sample.includes(0)) return true;
  let controls = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return sample.length > 0 && controls / sample.length > 0.01;
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
    filesScanned += 1;
    const relative = normaliseRelative(absoluteRoot, file);
    const privateRuntime = privateRuntimeArtifact(relative);
    const pathFindings = [];
    const lowerRelative = relative.toLocaleLowerCase('en-US');
    const compactRelative = lowerRelative.normalize('NFKC').replace(/[^a-z0-9]/g, '');
    for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
      const compactMarker = markers[markerIndex].toLocaleLowerCase('en-US')
        .normalize('NFKC').replace(/[^a-z0-9]/g, '');
      if (compactMarker && compactRelative.includes(compactMarker)) {
        pathFindings.push({ line: 1, rule: `personal-marker-path-${markerIndex + 1}` });
      }
    }
    for (const { id, regex } of SECRET_RULES) {
      regex.lastIndex = 0;
      if (regex.test(relative)) pathFindings.push({ line: 1, rule: `${id}-path` });
    }
    const redactedPath = privateRuntime || pathFindings.length > 0;
    const publicFile = redactedPath ? '[redacted-path]' : relative;
    if (privateRuntime) {
      findings.push({ file: publicFile, line: 1, rule: 'private-runtime-artifact' });
    }
    // Executables and archives are allowlisted build inputs, not serialized
    // workspace state. Classify their path above, then avoid unbounded UTF-8
    // decoding and random byte-pattern findings.
    if (binaryContent(content) || BINARY_OR_DOCUMENT_EXTENSION.test(relative)) {
      if (!privateRuntime && !allowedReleaseBinary(relative)) {
        findings.push({ file: publicFile, line: 1, rule: 'unexpected-binary' });
      }
      findings.push(...pathFindings.map((finding) => ({ file: publicFile, ...finding })));
      continue;
    }
    const text = content.toString('utf8');
    findings.push(...pathFindings.map((finding) => ({ file: publicFile, ...finding })));
    for (const finding of scanText(text, markers, relative)) {
      findings.push({ file: publicFile, ...finding });
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
