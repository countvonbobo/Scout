#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../ui/lib/mainModule.mjs';

const DEFAULT_BUILD_DIRS = ['dist', path.join('installer', 'output')];
const IGNORED_DIRECTORY_NAMES = new Set(['node_modules']);
const PLACEHOLDER = /^(?:change-?me|dummy|example|fake|not-?set|placeholder|redacted|replace-?me|test|todo|<your-api-key>|<your-password>|\$\{[A-Z][A-Z0-9_]*\}|\$\{\{\s*[A-Z][A-Z0-9_.-]*\s*\}\})$/i;
const NON_CREDENTIAL_ASSIGNMENT_TOKENS = new Set([
  'cancellationtoken', 'locktoken',
]);

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
  '.scout', '.scout-backup', 'applications', 'chats', 'cv', 'data',
  'imports', 'logs', 'profile', 'reports',
]);
const STATE_SHAPED_TEXT_EXTENSIONS = /\.(?:json|jsonl|ndjson|log|out|toml|txt|yaml|yml)$/i;
const CROSS_FORMAT_CONFIG_EXTENSIONS = /\.(?:toml|yaml|yml)$/i;
const EXACT_PROFILE_PLACEHOLDERS = new Set([
  'your', '<user>', '<username>', '<your-user>', '<your-username>',
]);
const UNIX_HOME_PROFILE_PATH = /\/(Users|home)\/([A-Za-z0-9._-]+|<[^/>\s]+>)/gi;
const WINDOWS_HOME_PROFILE_PATH = /[A-Za-z]:[\\/]+(Users)[\\/]+([A-Za-z0-9._-]+|<[^\\/>\s]+>)/gi;
const UNC_PROFILE_PATH = /(?:\\{2,}|\/{2,})[A-Za-z0-9._-]+[\\/]+(Users|home|profiles|homes)[\\/]+([A-Za-z0-9._-]+|<[^\\/>\s]+>)/gi;
const ROOT_PROFILE_PATH = /\/root(?=\/|["'`\s]|$)/g;
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
const REVIEWED_PUBLIC_BINARY_DIGESTS = new Map(Object.entries({
  'ui/assets/scout-explaining.png': 'ebc8920f843543f098af494f61f0592a1fd4db84467e571f8bdaec6528a20f72',
  'ui/assets/scout-found.png': '913425712ba5eea7f5d6a28244cf3621c651706ea4bab9e3b3aa91c25dfb5918',
  'ui/assets/scout-icon.ico': 'eaa34428c23de32f00ab2687d1f8b8409d024fb0ecf12d015720c788f951ae52',
  'ui/assets/scout-icon.png': 'a8a22f54d179b00290b0fd47d18637689b2881e852e21ac42da366ff54a93e18',
  'ui/assets/scout-idle.png': 'b6743c5ed1e4804a2e36d79029711546b68e4c25b5f63ee2ed7982c5a436342a',
  'ui/assets/scout-searching.png': 'f8619a583c5e4d72e69d6ee7c5c46dc4c456bec4d1c0deffd30c19e2168974c6',
  'ui/assets/scout-static.png': 'ff940cd16c2c37a03ef85d6f12069ff3964f84a8cc06ee4ec9f2e384f4f342ef',
  'ui/assets/scout-thinking.png': '86a247f523bddfd940db81d566f603092ab853580857015a393c3fc74e777a68',
  'ui/assets/scout-warning.png': '2230faf4c3faaf1bbdf46d2c6096cd1c584019b43f962e6e303030a24579a22f',
  'docs/screenshots/0.1.0-beta.23/codex-remote-fallback.png': '57589a685757b6b8d5deb88b4843b0274b9bf0879ac78cbf74bd5e9019e5cda0',
  'docs/screenshots/0.1.0-beta.23/trustworthy-model-picker.png': '583deedd4ac6da79454305e0093e3d03098ee82721e3bbd613671c23eff8daf1',
  'docs/screenshots/0.1.0-beta.23/usage-and-engine-regions.png': '19d73fce9cac11306d0092cc26d4dc8af52b847dab6f77a8194aedb003ee77bf',
}));
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

function sensitiveAssignmentKey(key) {
  const text = String(key);
  const normal = text.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en-US');
  const specificSuffixes = [
    'apikey', 'apisecret', 'apitoken', 'accesstoken', 'authorization',
    'authtoken', 'bearertoken', 'clientsecret', 'consumersecret', 'credential',
    'credentials', 'idtoken', 'password', 'privatekey', 'refreshtoken',
    'sessiontoken',
  ];
  if (specificSuffixes.some((suffix) => normal.endsWith(suffix))) return true;
  if (normal === 'secret' || normal === 'token' || normal.endsWith('secret')) return true;
  if (normal.endsWith('token') && !NON_CREDENTIAL_ASSIGNMENT_TOKENS.has(normal)) return true;
  return /^[A-Z][A-Z0-9_-]+$/.test(text)
    && (normal.endsWith('secret') || normal.endsWith('token'));
}

function boundedQuotedLiteral(remainder, quote) {
  let value = '';
  for (let i = 1; i < remainder.length && i <= 4097; i += 1) {
    const character = remainder[i];
    if (character === '\\') {
      if (i + 1 >= remainder.length) return { invalid: true };
      value += character + remainder[i + 1];
      i += 1;
      continue;
    }
    if (character === quote) {
      if (remainder[i + 1] === quote) {
        value += quote + quote;
        i += 1;
        continue;
      }
      return { value };
    }
    value += character;
  }
  return { invalid: true };
}

function secretAssignmentFindings(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const assignment = /(?<![A-Za-z0-9_])(["']?)([A-Za-z][A-Za-z0-9_-]{1,80})\1\s*[:=]\s*/g;
  for (let i = 0; i < lines.length; i += 1) {
    for (const match of lines[i].matchAll(assignment)) {
      if (!sensitiveAssignmentKey(match[2])) continue;
      const remainder = lines[i].slice((match.index || 0) + match[0].length);
      const quote = ['"', "'", '`'].includes(remainder[0]) ? remainder[0] : null;
      const literal = quote ? boundedQuotedLiteral(remainder, quote) : null;
      if (literal?.invalid) {
        findings.push({ line: i + 1, rule: 'secret-assignment' });
        continue;
      }
      const value = quote
        ? literal.value
        : remainder.match(/^[^\s'";#]{8,}/)?.[0];
      if (!value || value.length < 8) continue;
      if (quote === '`' && value.includes('${')) continue;
      // Unquoted expressions and property references are code, not embedded
      // credentials. Quoted literals are always checked; unquoted values must
      // resemble a literal rather than `env.KEY`, `portal.token`, or a call.
      if (!quote && /[().,`$]/.test(value)) continue;
      if (!isPlaceholder(value)) findings.push({ line: i + 1, rule: 'secret-assignment' });
    }
  }
  return findings;
}

function normaliseSerializedKey(key) {
  return String(key).normalize('NFKC').replace(/[^a-z0-9]/gi, '').toLocaleLowerCase('en-US');
}

const PRIVATE_OUTPUT_CONTEXT_KEYS = [
  /^auth(?:entication|orization|state|code|output|response)?$/,
  /^credentials?$/,
  /^device(?:auth|login|session)?$/,
  /^login(?:state|session|output|response)?$/,
  /^provider(?:state|session|output|response|turn|run)?$/,
  /^session(?:state|id|output|result)?$/,
  /^run(?:state|id|output|result|events?)?$/,
  /^scan(?:state|id|run|journal|output|result)?$/,
  /^execution(?:state|id|output|result)?$/,
  /^journal(?:state|id|output|events?)?$/,
  /^transcript$/,
];

function privateOutputContext(owner, ancestors) {
  const contextKey = (part) => PRIVATE_OUTPUT_CONTEXT_KEYS.some((pattern) => pattern.test(part));
  return ancestors.some(contextKey)
    || Object.keys(owner || {}).some((key) => contextKey(normaliseSerializedKey(key)));
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
  if (['stdout', 'stderr'].includes(normal)
    || (['output', 'payload'].includes(normal) && privateOutputContext(owner, ancestors))
    || (normal.includes('raw') && /(?:auth|login|provider|output|payload|response|transcript)/.test(normal))) {
    return 'raw-auth-output';
  }
  if (normal === 'usercode'
    || /(?:auth|authentication|authorization|device|login).*code/.test(normal)
    || (normal === 'code' && /^(?:claude|codex)$/i.test(String(owner.provider || '')))
    || (normal === 'code' && ancestors.some((part) => /(?:auth|device|login|provider|session)/.test(part)))) return 'auth-code';
  if (normal === 'defaultprompt') return null;
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
  const nonemptyLines = text.split(/\r?\n/).filter((entry) => entry.trim());
  let parsedComplete = false;
  try {
    records.push(JSON.parse(text));
    parsedComplete = true;
  } catch {
    for (const line of nonemptyLines) {
      try { records.push(JSON.parse(line)); } catch { /* handled by fallback key scan below */ }
    }
    parsedComplete = nonemptyLines.length > 0 && records.length === nonemptyLines.length;
  }
  for (const record of records) inspect(record);

  // Text exports and damaged JSON still fail closed on high-signal field names.
  if (!parsedComplete) {
    const key = /["']?([A-Za-z][A-Za-z0-9_-]{1,80})["']?\s*[:=]/g;
    let match;
    while ((match = key.exec(text)) !== null) {
      const normal = normaliseSerializedKey(match[1]);
      // Generic process-output words have no privacy provenance in an
      // unparsed config record. Explicit raw/auth-qualified keys remain
      // high-signal; parsed object ancestry is handled above.
      const rule = ['output', 'payload', 'stdout', 'stderr'].includes(normal)
        ? null
        : privacyRuleForKey(match[1], null, {});
      const finding = `${rule}:${match.index}`;
      if (rule && !seen.has(finding)) {
        seen.add(finding);
        findings.push({ line: lineAt(text, match.index), rule });
      }
    }
  }
  return findings;
}

function serializedByContent(text, relative) {
  if (STATE_SHAPED_TEXT_EXTENSIONS.test(relative)) return true;
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

function dependencyArtifact(relative) {
  return String(relative).split(/[\\/]+/).some((part) =>
    part.toLocaleLowerCase('en-US') === 'node_modules');
}

function dependencyDataArtifact(relative) {
  const base = path.posix.basename(String(relative).replaceAll('\\', '/'))
    .toLocaleLowerCase('en-US');
  // Installed vendor code, documentation and source maps contain example
  // field names and paths. Every dependency file still receives marker and
  // concrete-token checks; state-shaped heuristics apply to data payloads,
  // excluding the package metadata selected by the reviewed lockfile.
  return base !== 'package.json' && STATE_SHAPED_TEXT_EXTENSIONS.test(base);
}

function publicProfileSegment(family, segment) {
  const normalFamily = String(family).toLocaleLowerCase('en-US');
  const normalSegment = String(segment).toLocaleLowerCase('en-US');
  if (EXACT_PROFILE_PLACEHOLDERS.has(normalSegment)) return true;
  return normalFamily === 'users' && (normalSegment === 'public' || normalSegment === 'shared');
}

function privatePathFindings(text) {
  const value = String(text);
  const findings = [];
  for (const regex of [UNIX_HOME_PROFILE_PATH, WINDOWS_HOME_PROFILE_PATH, UNC_PROFILE_PATH]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(value)) !== null) {
      if (!publicProfileSegment(match[1], match[2])) {
        findings.push({ line: lineAt(value, match.index), rule: 'private-path' });
      }
    }
  }
  ROOT_PROFILE_PATH.lastIndex = 0;
  let rootMatch;
  while ((rootMatch = ROOT_PROFILE_PATH.exec(value)) !== null) {
    findings.push({ line: lineAt(value, rootMatch.index), rule: 'private-path' });
  }
  return findings;
}

function scanText(text, markers, relative = '', { dependency = false } = {}) {
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
  if (dependency && !dependencyDataArtifact(relative)) return findings;
  findings.push(...secretAssignmentFindings(text));
  if (serializedByContent(text, relative)) {
    let privacyFindings = serializedPrivacyFindings(text);
    // Config credentials are already value-checked above with exact
    // placeholder handling. The format-independent state scan adds the
    // structural rules that cannot be decided from credential values.
    if (CROSS_FORMAT_CONFIG_EXTENSIONS.test(relative)) {
      privacyFindings = privacyFindings.filter(({ rule }) => rule !== 'credential');
    }
    findings.push(...privacyFindings);
  }
  let pathText = text;
  const documentedPublicPath = [...DOCUMENTED_PUBLIC_PATH_FILES].some((documented) =>
    relative === documented || relative === `app/${documented}` || relative.endsWith(`/app/${documented}`));
  if (documentedPublicPath) {
    pathText = pathText.replaceAll(/\/home\/(?:scout-deploy|ubuntu)/g, '/home/YOUR');
  }
  findings.push(...privatePathFindings(pathText));
  return findings;
}

function privateRuntimeArtifact(relative) {
  const parts = String(relative).split(/[\\/]+/).filter(Boolean)
    .map((part) => part.toLocaleLowerCase('en-US'));
  const runtimeRoot = parts[0] === 'app' ? parts[1] : parts[0];
  const runtimeTail = parts[0] === 'app' ? parts.slice(1) : parts;
  const templateWorkspace = parts.slice(-3).join('/') === 'templates/workspace/workspace.json';
  if (PRIVATE_RUNTIME_ROOTS.has(runtimeRoot)) return true;
  if (runtimeTail.some((part) => part.startsWith('.env'))) return true;
  if (runtimeTail.at(-1) === 'workspace.json' && !templateWorkspace) return true;
  // Release build output wraps the source tree under paths such as
  // dist/release/stage/app/. The app boundary, wherever its staging parents
  // live, must apply the same private-root exclusion as a direct stage audit.
  return parts.some((part, index) =>
    part === 'app' && PRIVATE_RUNTIME_ROOTS.has(parts[index + 1]));
}

function allowedReleaseBinary(relative) {
  const value = String(relative).replaceAll('\\', '/').toLocaleLowerCase('en-US');
  if (value === 'deb/usr/share/icons/hicolor/512x512/apps/scout.png') return true;
  const appIndex = value.lastIndexOf('/app/');
  const packaged = appIndex === -1 ? value : value.slice(appIndex + 1);
  if (packaged.startsWith('app/node_modules/') || packaged.startsWith('node_modules/')) return true;
  if (/^(?:.*\/)?runtime\/(?:node|node\.exe|scoutruntime\.exe|typst|typst\.exe)$/.test(value)) return true;
  if (value === 'scout.exe' || /^dist\/release\/[^/]+\/scout\.exe$/.test(value)) return true;
  if (/(?:^|\/)dmg-root\/scout\.app\/contents\/macos\/scout$/.test(value)
    || value === 'contents/macos/scout') return true;
  const asset = packaged.match(/^(?:app\/)?ui\/assets\/([^/]+)$/)?.[1];
  if (asset && PUBLIC_UI_BINARY_ASSETS.has(asset)) return true;
  if ([...PUBLIC_DOC_SCREENSHOTS].some((screenshot) =>
    value === screenshot || value.endsWith(`/app/${screenshot}`) || value.endsWith(`/${screenshot}`))) return true;
  return false;
}

function reviewedPublicBinaryDigest(relative) {
  const value = String(relative).replaceAll('\\', '/').toLocaleLowerCase('en-US');
  if (value === 'deb/usr/share/icons/hicolor/512x512/apps/scout.png') {
    return REVIEWED_PUBLIC_BINARY_DIGESTS.get('ui/assets/scout-icon.png');
  }
  const appIndex = value.lastIndexOf('/app/');
  const packaged = appIndex === -1 ? value : value.slice(appIndex + 5);
  return REVIEWED_PUBLIC_BINARY_DIGESTS.get(packaged) || null;
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

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function withinPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative));
}

function snapshotDirectory(directory) {
  const before = fs.lstatSync(directory, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`release audit refuses non-directory traversal input: ${directory}`);
  }
  const names = fs.readdirSync(directory).sort();
  const after = fs.lstatSync(directory, { bigint: true });
  if (!sameDirectoryIdentity(before, after)) {
    throw new Error(`release audit directory changed during enumeration: ${directory}`);
  }
  return { directory, identity: after, names };
}

function verifyDirectorySnapshot(snapshot) {
  const before = fs.lstatSync(snapshot.directory, { bigint: true });
  const names = fs.readdirSync(snapshot.directory).sort();
  const after = fs.lstatSync(snapshot.directory, { bigint: true });
  if (!sameDirectoryIdentity(snapshot.identity, before)
    || !sameDirectoryIdentity(before, after)
    || JSON.stringify(names) !== JSON.stringify(snapshot.names)) {
    throw new Error(`release audit directory changed after enumeration: ${snapshot.directory}`);
  }
}

function filesUnder(directory, {
  includeDependencies = false, directorySnapshots = [], linkSnapshots = [], allowStageLinks = false,
} = {}) {
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const visit = (entry) => {
    const stat = fs.lstatSync(entry, { bigint: true });
    if (stat.isSymbolicLink()) {
      const relative = normaliseRelative(directory, entry);
      const target = fs.readlinkSync(entry);
      if (allowStageLinks && relative === 'dmg-root/Applications' && target === '/Applications') {
        linkSnapshots.push({ file: entry, target, identity: stat });
        return;
      }
      throw new Error(`release audit refuses symbolic link: ${entry}`);
    }
    if (stat.isFile()) {
      result.push(entry);
      return;
    }
    if (!stat.isDirectory()) return;
    const name = path.basename(entry);
    if (
      IGNORED_DIRECTORY_NAMES.has(name)
      && (name !== 'node_modules' || !includeDependencies)
    ) return;
    const snapshot = snapshotDirectory(entry);
    directorySnapshots.push(snapshot);
    for (const child of snapshot.names) visit(path.join(entry, child));
  };
  visit(directory);
  return result;
}

function assertAuditedPath(root, file) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (resolvedFile !== resolvedRoot) throw new Error('release audit path escapes its root');
  }
  const components = relative ? relative.split(path.sep) : [];
  const identities = [];
  let current = resolvedRoot;
  for (let index = 0; index < components.length; index += 1) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`release audit refuses symbolic link: ${current}`);
    if (!stat.isDirectory()) throw new Error(`release audit ancestor is not a directory: ${current}`);
    identities.push(`${stat.dev}:${stat.ino}`);
    current = path.join(current, components[index]);
  }
  const rootStat = fs.lstatSync(resolvedRoot, { bigint: true });
  if (rootStat.isSymbolicLink()) throw new Error(`release audit refuses symbolic link: ${resolvedRoot}`);
  if (!identities.length) identities.push(`${rootStat.dev}:${rootStat.ino}`);
  return identities.join('|');
}

function readAuditedRegularFile(root, file) {
  const ancestorsBefore = assertAuditedPath(root, file);
  const before = fs.lstatSync(file, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`release audit refuses non-regular file: ${file}`);
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const content = fs.readFileSync(descriptor);
    const openedAfterRead = fs.fstatSync(descriptor, { bigint: true });
    const ancestorsAfter = assertAuditedPath(root, file);
    const after = fs.lstatSync(file, { bigint: true });
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
      throw new Error(`release audit input identity changed while reading: ${file}`);
    }
    return {
      content,
      identity: openedAfterRead,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function auditedTreeDigest(root, files, directories, links = []) {
  const records = [
    ...directories.map((snapshot) => ({
      type: 'directory',
      path: normaliseRelative(root, snapshot.directory),
      names: snapshot.names,
    })),
    ...files.map((record) => ({
      type: 'file',
      path: normaliseRelative(root, record.file),
      mode: Number(record.identity.mode & 0o777n),
      sha256: record.sha256,
    })),
    ...links.map((record) => ({
      type: 'link',
      path: normaliseRelative(root, record.file),
      target: record.target,
    })),
  ].sort((a, b) => a.path.localeCompare(b.path, 'en') || a.type.localeCompare(b.type, 'en'));
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

function auditedTreeIdentityDigest(root, files, directories, links = []) {
  const identity = (value) => ({
    dev: String(value.dev),
    ino: String(value.ino),
    mode: Number(value.mode & 0o777n),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
    ctimeNs: String(value.ctimeNs),
  });
  const records = [
    ...directories.map((snapshot) => ({
      type: 'directory',
      path: normaliseRelative(root, snapshot.directory),
      ...identity(snapshot.identity),
    })),
    ...files.map((record) => ({
      type: 'file',
      path: normaliseRelative(root, record.file),
      ...identity(record.identity),
    })),
    ...links.map((record) => ({
      type: 'link',
      path: normaliseRelative(root, record.file),
      target: record.target,
      ...identity(record.identity),
    })),
  ].sort((a, b) => a.path.localeCompare(b.path, 'en') || a.type.localeCompare(b.type, 'en'));
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export function verifiedAuditTreeState(root) {
  const absoluteRoot = path.resolve(root);
  const directories = [];
  const links = [];
  const files = filesUnder(absoluteRoot, {
    includeDependencies: true,
    directorySnapshots: directories,
    linkSnapshots: links,
    allowStageLinks: true,
  }).map((file) => ({ file, ...readAuditedRegularFile(absoluteRoot, file) }));
  for (const snapshot of directories) verifyDirectorySnapshot(snapshot);
  return {
    treeDigest: auditedTreeDigest(absoluteRoot, files, directories, links),
    identityDigest: auditedTreeIdentityDigest(absoluteRoot, files, directories, links),
  };
}

export function verifiedAuditTreeDigest(root) {
  return verifiedAuditTreeState(root).treeDigest;
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
  directorySnapshots = [],
  linkSnapshots = [],
  snapshotRoot = null,
  preparedSnapshotRoot = false,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const excluded = markerFile ? path.resolve(markerFile) : null;
  const listedTrackedFiles = trackedFiles ?? collectTrackedFiles(absoluteRoot);
  const tracked = listedTrackedFiles
    .map((file) => path.resolve(absoluteRoot, file))
    .filter((file) => {
      if (!fs.existsSync(file)) return false;
      assertAuditedPath(absoluteRoot, file);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`release audit refuses symbolic link: ${file}`);
      return stat.isFile();
    });
  const traversalSnapshots = [...directorySnapshots];
  const built = buildDirs.flatMap((dir) => filesUnder(path.resolve(absoluteRoot, dir), {
    directorySnapshots: traversalSnapshots,
  }));
  const files = [...new Set([...tracked, ...built])]
    .filter((file) => file !== excluded)
    .sort((a, b) => normaliseRelative(absoluteRoot, a).localeCompare(normaliseRelative(absoluteRoot, b), 'en'));
  const snapshot = snapshotRoot ? path.resolve(snapshotRoot) : null;
  if (snapshot) {
    if (withinPath(absoluteRoot, snapshot)) {
      throw new Error('release audit snapshot destination is invalid');
    }
    if (preparedSnapshotRoot) {
      const stat = fs.lstatSync(snapshot);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || fs.readdirSync(snapshot).length !== 0
        || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)) {
        throw new Error('release audit snapshot destination is invalid');
      }
    } else {
      if (fs.existsSync(snapshot)) throw new Error('release audit snapshot destination is invalid');
      fs.mkdirSync(snapshot, { recursive: false, mode: 0o700 });
    }
    for (const directory of traversalSnapshots) {
      const relative = normaliseRelative(absoluteRoot, directory.directory);
      if (relative) fs.mkdirSync(path.join(snapshot, relative), { recursive: true, mode: 0o700 });
    }
    for (const link of linkSnapshots) {
      const target = path.join(snapshot, normaliseRelative(absoluteRoot, link.file));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.symlinkSync(link.target, target, process.platform === 'win32' ? 'junction' : undefined);
    }
  }
  const findings = [];
  const scannedFiles = [];
  let filesScanned = 0;
  for (const file of files) {
    const scanned = readAuditedRegularFile(absoluteRoot, file);
    const { content } = scanned;
    scannedFiles.push({ file, identity: scanned.identity, sha256: scanned.sha256 });
    filesScanned += 1;
    const relative = normaliseRelative(absoluteRoot, file);
    if (snapshot) {
      const target = path.join(snapshot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { mode: Number(scanned.identity.mode & 0o777n) });
      fs.chmodSync(target, Number(scanned.identity.mode & 0o777n));
    }
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
      const expectedDigest = reviewedPublicBinaryDigest(relative);
      if (expectedDigest
        && crypto.createHash('sha256').update(content).digest('hex') !== expectedDigest) {
        findings.push({ file: publicFile, line: 1, rule: 'reviewed-binary-digest-mismatch' });
      }
      findings.push(...pathFindings.map((finding) => ({ file: publicFile, ...finding })));
      for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
        const utf8 = Buffer.from(markers[markerIndex], 'utf8');
        const utf16le = Buffer.from(markers[markerIndex], 'utf16le');
        const utf16be = Buffer.from(utf16le);
        for (let index = 0; index + 1 < utf16be.length; index += 2) {
          [utf16be[index], utf16be[index + 1]] = [utf16be[index + 1], utf16be[index]];
        }
        if ([utf8, utf16le, utf16be].some((markerBytes) => (
          markerBytes.length && content.indexOf(markerBytes) !== -1
        ))) {
          findings.push({
            file: publicFile,
            line: 1,
            rule: `personal-marker-${markerIndex + 1}`,
          });
        }
      }
      continue;
    }
    const text = content.toString('utf8');
    findings.push(...pathFindings.map((finding) => ({ file: publicFile, ...finding })));
    for (const finding of scanText(text, markers, relative, {
      dependency: dependencyArtifact(relative),
    })) {
      findings.push({ file: publicFile, ...finding });
    }
  }
  for (const scanned of scannedFiles) {
    const current = readAuditedRegularFile(absoluteRoot, scanned.file);
    if (!sameDirectoryIdentity(scanned.identity, current.identity)
      || scanned.identity.size !== current.identity.size
      || scanned.sha256 !== current.sha256) {
      throw new Error(`release audit input changed after scan: ${scanned.file}`);
    }
  }
  for (const snapshot of traversalSnapshots) verifyDirectorySnapshot(snapshot);
  findings.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line || a.rule.localeCompare(b.rule, 'en'));
  return {
    ok: findings.length === 0,
    filesScanned,
    markerCount: markers.length,
    findings,
    treeDigest: auditedTreeDigest(absoluteRoot, scannedFiles, traversalSnapshots, linkSnapshots),
  };
}

export function auditStagedRelease({
  root,
  markers = [],
  snapshotRoot = null,
  preparedSnapshotRoot = false,
} = {}) {
  const absoluteRoot = path.resolve(root);
  const directories = [];
  const links = [];
  const files = filesUnder(absoluteRoot, {
    includeDependencies: true,
    directorySnapshots: directories,
    linkSnapshots: links,
    allowStageLinks: true,
  }).map((file) => normaliseRelative(absoluteRoot, file));
  return auditRelease({
    root: absoluteRoot,
    trackedFiles: files,
    buildDirs: [],
    markers,
    directorySnapshots: directories,
    linkSnapshots: links,
    snapshotRoot,
    preparedSnapshotRoot,
  });
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
  const stagedDirectorySnapshots = [];
  const stagedLinkSnapshots = [];
  const stagedFiles = stagedTree
    ? filesUnder(root, {
      includeDependencies: true,
      directorySnapshots: stagedDirectorySnapshots,
      linkSnapshots: stagedLinkSnapshots,
      allowStageLinks: true,
    })
      .map((file) => normaliseRelative(root, file))
    : undefined;
  const result = auditRelease({
    root,
    markerFile,
    markers,
    trackedFiles: stagedFiles,
    directorySnapshots: stagedDirectorySnapshots,
    linkSnapshots: stagedLinkSnapshots,
    buildDirs: stagedTree ? [] : (explicitBuildDirs.length ? explicitBuildDirs : DEFAULT_BUILD_DIRS),
  });
  process.stdout.write(`Release audit scanned ${result.filesScanned} files with ${result.markerCount} configured personal markers.\n`);
  process.stdout.write(`Release audit tree digest: ${result.treeDigest}\n`);
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
