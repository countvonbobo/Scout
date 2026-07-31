import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { jobIdentity, sameUnderlyingJob } from './jobIdentity.mjs';
import { filterVacancies } from './vacancyFilter.mjs';
import { rankVacancies } from './vacancyRank.mjs';
import { workspacePaths } from './workspace.mjs';
import { withWorkspaceMutationAuthority } from './workspaceMutationAuthority.mjs';

export const BETA22_COMPATIBLE_VERSION = '0.1.0-beta.22';
const SNAPSHOT_SCHEMA_VERSION = 1;
const HISTORICAL_RANKING_SCHEMA_VERSION = 1;
const MAX_SNAPSHOT_DEPTH = 64;
const MAX_SNAPSHOT_ENTRIES = 20_000;
const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 512 * 1024 * 1024;
const SNAPSHOT_COPY_CHUNK_BYTES = 1024 * 1024;
const SNAPSHOT_PATHS = Object.freeze([
  '.env',
  '.gitignore',
  '.scout-backup',
  'workspace.json',
  'profile',
  'cv',
  'data',
  'reports',
  'applications',
  'imports',
  'logs',
]);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('snapshot time is invalid');
  return parsed.toISOString().replace(/[:.]/g, '-');
}

function slash(relative) {
  return relative.split(path.sep).join('/');
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function physicalDestination(value) {
  const missing = [];
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) throw new Error('rollback destination has no physical parent');
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function snapshotBudget() {
  return { entries: 0, totalBytes: 0 };
}

function inspectSnapshotEntry(source, relative, budget, depth) {
  if (depth > MAX_SNAPSHOT_DEPTH) throw new Error('beta.22 workspace snapshot exceeds the depth limit');
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`beta.22 workspace snapshot does not accept symbolic links: ${slash(relative)}`);
  }
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`beta.22 workspace snapshot only accepts regular files and directories: ${slash(relative)}`);
  }
  budget.entries += 1;
  if (budget.entries > MAX_SNAPSHOT_ENTRIES) {
    throw new Error('beta.22 workspace snapshot exceeds the entry limit');
  }
  if (stat.isFile()) {
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES) {
      throw new Error(`beta.22 workspace snapshot file exceeds the size limit: ${slash(relative)}`);
    }
    budget.totalBytes += stat.size;
    if (budget.totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new Error('beta.22 workspace snapshot exceeds the total size limit');
    }
  }
  return stat;
}

function assertPhysicalTree(source, relative = '', budget = snapshotBudget(), depth = 0) {
  const stat = inspectSnapshotEntry(source, relative, budget, depth);
  if (!stat.isDirectory()) return budget;
  for (const name of fs.readdirSync(source)) {
    assertPhysicalTree(path.join(source, name), path.join(relative, name), budget, depth + 1);
  }
  return budget;
}

function ignoredSnapshotPath(relative) {
  const normalised = slash(relative);
  return normalised === 'profile/search' || normalised.startsWith('profile/search/');
}

function copySnapshotEntry(
  source,
  target,
  relative,
  renew = () => {},
  budget = snapshotBudget(),
  depth = 0,
) {
  renew();
  const stat = inspectSnapshotEntry(source, relative, budget, depth);
  if (stat.isDirectory()) {
    if (ignoredSnapshotPath(relative)) return;
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.chmodSync(target, 0o700);
    for (const name of fs.readdirSync(source).sort()) {
      copySnapshotEntry(
        path.join(source, name),
        path.join(target, name),
        path.join(relative, name),
        renew,
        budget,
        depth + 1,
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const inputFlags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
  const input = fs.openSync(source, inputFlags);
  let output;
  try {
    const opened = fs.fstatSync(input);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`beta.22 workspace snapshot file changed during copy: ${slash(relative)}`);
    }
    output = fs.openSync(target, 'wx', stat.mode & 0o100 ? 0o700 : 0o600);
    const buffer = Buffer.allocUnsafe(SNAPSHOT_COPY_CHUNK_BYTES);
    let position = 0;
    while (position < stat.size) {
      renew();
      const count = fs.readSync(input, buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (count <= 0) throw new Error(`beta.22 workspace snapshot file changed during copy: ${slash(relative)}`);
      let written = 0;
      while (written < count) written += fs.writeSync(output, buffer, written, count - written);
      position += count;
    }
    if (fs.fstatSync(input).size !== stat.size) {
      throw new Error(`beta.22 workspace snapshot file changed during copy: ${slash(relative)}`);
    }
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
  fs.chmodSync(target, stat.mode & 0o100 ? 0o700 : 0o600);
}

function beta22WorkspaceConfigBytes(file, budget = snapshotBudget()) {
  const stat = inspectSnapshotEntry(file, 'workspace.json', budget, 0);
  if (!stat.isFile()) throw new Error('beta.22 rollback workspace config must be a regular file');
  const source = fs.readFileSync(file);
  const value = JSON.parse(source.toString('utf8'));
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > 2) {
    throw new Error('beta.22 rollback requires workspace schema version 1 or 2');
  }
  if (!Object.hasOwn(value, 'searchProfile')) return source;
  delete value.searchProfile;
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function digestSnapshotFile(file, stat, renew) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error('beta.22 snapshot file changed during verification');
    }
    const buffer = Buffer.allocUnsafe(SNAPSHOT_COPY_CHUNK_BYTES);
    let position = 0;
    while (position < stat.size) {
      renew();
      const count = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, stat.size - position),
        position,
      );
      if (count <= 0) throw new Error('beta.22 snapshot file changed during verification');
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    if (fs.fstatSync(descriptor).size !== stat.size) {
      throw new Error('beta.22 snapshot file changed during verification');
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function snapshotEntries(directory, renew = () => {}) {
  const entries = [];
  const budget = snapshotBudget();
  function visit(current, relative = '', depth = 0) {
    renew();
    const stat = inspectSnapshotEntry(current, relative, budget, depth);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), path.join(relative, name), depth + 1);
      }
      return;
    }
    entries.push({
      path: slash(relative),
      bytes: stat.size,
      sha256: digestSnapshotFile(current, stat, renew),
    });
  }
  visit(directory);
  return entries;
}

function manifestPath(directory) {
  return `${path.resolve(directory)}.manifest.json`;
}

function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || value.compatibleVersion !== BETA22_COMPATIBLE_VERSION
    || typeof value.createdAt !== 'string'
    || !Array.isArray(value.entries)
    || !/^[a-f0-9]{64}$/.test(String(value.treeDigest || ''))) {
    throw new Error('beta.22 snapshot manifest is invalid');
  }
  const paths = new Set();
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== 'string' || !entry.path
      || entry.path.includes('\\') || entry.path.startsWith('/')
      || entry.path.split('/').includes('..')
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))
      || paths.has(entry.path)) {
      throw new Error('beta.22 snapshot manifest entry is invalid');
    }
    paths.add(entry.path);
  }
  return value;
}

function treeDigest(entries) {
  return digest(Buffer.from(entries.map((entry) => (
    `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`
  )).join('')));
}

function verifySnapshotDirectory(directory) {
  const manifestFile = manifestPath(directory);
  if (!fs.existsSync(directory) || !fs.existsSync(manifestFile)) {
    throw new Error('beta.22 snapshot or manifest is missing');
  }
  assertPhysicalTree(directory);
  const manifestStat = fs.lstatSync(manifestFile);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()
    || manifestStat.size > MAX_SNAPSHOT_FILE_BYTES) {
    throw new Error('beta.22 snapshot manifest is invalid');
  }
  const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  const entries = snapshotEntries(directory);
  if (JSON.stringify(entries) !== JSON.stringify(manifest.entries)
    || treeDigest(entries) !== manifest.treeDigest) {
    throw new Error('beta.22 snapshot digest verification failed; the snapshot is damaged');
  }
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8'));
  if (config.schemaVersion > 2 || Object.hasOwn(config, 'searchProfile')
    || fs.existsSync(path.join(directory, '.scout'))
    || fs.existsSync(path.join(directory, 'profile', 'search'))) {
    throw new Error('beta.22 snapshot contains incompatible ranked-discovery state');
  }
  return manifest;
}

function snapshotsDirectory(root) {
  return path.join(workspacePaths(root).backups);
}

export function latestBeta22WorkspaceSnapshot(root) {
  const directory = snapshotsDirectory(root);
  if (!fs.existsSync(directory)) return null;
  const manifests = fs.readdirSync(directory)
    .filter((name) => name.endsWith('-beta22-compatible.manifest.json'))
    .sort()
    .reverse();
  for (const name of manifests) {
    const snapshotDirectory = path.join(directory, name.slice(0, -'.manifest.json'.length));
    try {
      const manifest = verifySnapshotDirectory(snapshotDirectory);
      return {
        directory: snapshotDirectory,
        manifestPath: manifestPath(snapshotDirectory),
        ...manifest,
      };
    } catch {
      // A damaged newest snapshot must not hide an older verified rollback
      // point. Explicit restoration of the damaged path still fails closed.
    }
  }
  return null;
}

function createBeta22WorkspaceSnapshotUnderAuthority(root, {
  now = () => new Date().toISOString(),
  renew = () => {},
  _testHooks = {},
} = {}) {
  const workspaceRoot = path.resolve(root);
  const existing = latestBeta22WorkspaceSnapshot(workspaceRoot);
  const configFile = path.join(workspaceRoot, 'workspace.json');
  if (!fs.existsSync(configFile)) throw new Error('workspace config is required for beta.22 snapshot');
  const parent = snapshotsDirectory(workspaceRoot);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.chmodSync(parent, 0o700);
  const createdAt = new Date(now()).toISOString();
  const name = `${safeTimestamp(createdAt)}-beta22-compatible`;
  const directory = path.join(parent, name);
  const staging = path.join(parent, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    const budget = snapshotBudget();
    for (const relative of SNAPSHOT_PATHS) {
      renew();
      _testHooks.beforeCopy?.(relative);
      const source = path.join(workspaceRoot, relative);
      if (!fs.existsSync(source)) continue;
      if (relative === 'workspace.json') {
        atomicWriteFile(
          path.join(staging, relative),
          beta22WorkspaceConfigBytes(source, budget),
          { mode: 0o600 },
        );
      } else {
        copySnapshotEntry(source, path.join(staging, relative), relative, renew, budget);
      }
    }
    const entries = snapshotEntries(staging, renew);
    const currentTreeDigest = treeDigest(entries);
    if (existing
      && JSON.stringify(entries) === JSON.stringify(existing.entries)
      && currentTreeDigest === existing.treeDigest) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { ...existing, created: false };
    }
    if (fs.existsSync(directory) || fs.existsSync(manifestPath(directory))) {
      throw new Error('beta.22 snapshot destination already exists without an equivalent valid manifest');
    }
    const manifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      compatibleVersion: BETA22_COMPATIBLE_VERSION,
      createdAt,
      entries,
      treeDigest: currentTreeDigest,
    };
    fs.renameSync(staging, directory);
    atomicWriteFile(manifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const verified = verifySnapshotDirectory(directory);
    return {
      directory,
      manifestPath: manifestPath(directory),
      ...verified,
      created: true,
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (fs.existsSync(directory) && !fs.existsSync(manifestPath(directory))) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

export function withBeta22MigrationAuthority(root, commit) {
  return withWorkspaceMutationAuthority(root, {
    kind: 'workspace-migration',
    phase: 'beta22-snapshot',
  }, ({ renew }) => commit({
    createSnapshot: (options = {}) => createBeta22WorkspaceSnapshotUnderAuthority(
      root,
      { ...options, renew },
    ),
    renew,
  }));
}

export function createBeta22WorkspaceSnapshot(root, options = {}) {
  return withBeta22MigrationAuthority(root, ({ createSnapshot }) => createSnapshot(options));
}

export function materializeBeta22Rollback(root, destination, { snapshotDirectory = null } = {}) {
  const workspaceRoot = path.resolve(root);
  const target = path.resolve(destination);
  const physicalRoot = fs.realpathSync(workspaceRoot);
  const physicalTarget = physicalDestination(target);
  if (target === workspaceRoot || within(workspaceRoot, target)
    || within(physicalRoot, physicalTarget)) {
    throw new Error('beta.22 rollback must use a separate workspace outside the live workspace');
  }
  if (fs.existsSync(target)) throw new Error('beta.22 rollback destination must not already exist');
  const chosen = snapshotDirectory
    ? { directory: path.resolve(snapshotDirectory) }
    : latestBeta22WorkspaceSnapshot(workspaceRoot);
  if (!chosen) throw new Error('no verified beta.22-compatible workspace snapshot is available');
  if (!within(snapshotsDirectory(workspaceRoot), chosen.directory)
    || !within(fs.realpathSync(snapshotsDirectory(workspaceRoot)), fs.realpathSync(chosen.directory))) {
    throw new Error('beta.22 rollback snapshot must belong to this workspace');
  }
  const manifest = verifySnapshotDirectory(chosen.directory);
  const staging = `${target}.scout-rollback-${crypto.randomUUID()}`;
  if (fs.existsSync(staging)) throw new Error('beta.22 rollback staging destination already exists');
  try {
    copySnapshotEntry(chosen.directory, staging, '', () => {});
    const copiedEntries = snapshotEntries(staging);
    if (JSON.stringify(copiedEntries) !== JSON.stringify(manifest.entries)
      || treeDigest(copiedEntries) !== manifest.treeDigest) {
      throw new Error('beta.22 rollback copy verification failed');
    }
    fs.renameSync(staging, target);
    return {
      compatibleVersion: BETA22_COMPATIBLE_VERSION,
      snapshotDirectory: chosen.directory,
      destination: target,
      fileCount: manifest.entries.length,
      treeDigest: manifest.treeDigest,
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function text(value, maximum = 200) {
  const clean = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return clean ? clean.slice(0, maximum) : null;
}

function sourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const canonical = url.toString().replace(/\/$/, '');
    return canonical.length <= 2048 ? canonical : null;
  } catch {
    return null;
  }
}

function trackerDecision(entry) {
  return {
    ref: `tracker:${text(entry.id, 160) || 'unknown'}`,
    outcome: text(entry.status, 80) || 'unknown',
    score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : null,
    profileId: text(entry.profileId, 80),
  };
}

function reviewDecision(run, item, lineIndex, index) {
  return {
    ref: `scan:${text(run.timestamp, 80) || 'unknown'}:${lineIndex}:${index}`,
    outcome: text(item.outcome, 80) || 'unknown',
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
    profileId: text(item.profileId || run.profile_id, 80),
  };
}

function historicalVacancy(value, decision) {
  const company = text(value.company || value.employer, 120) || 'Unknown employer';
  const role = text(value.role || value.title, 160) || 'Unknown role';
  const url = sourceUrl(value.url || value.sourceUrl || value.sources?.[0]);
  const suppliedVacancyId = text(value.vacancyId, 200);
  const vacancyId = (/^https?:/i.test(suppliedVacancyId || '')
    ? sourceUrl(suppliedVacancyId)
    : suppliedVacancyId) || url || text(value.id, 200)
    || `legacy-${digest(Buffer.from(`${company}\0${role}`)).slice(0, 24)}`;
  return {
    vacancyId,
    company,
    role,
    employer: { value: company, provenance: 'legacy-reconstructed' },
    title: { value: role, provenance: 'legacy-reconstructed' },
    location: {
      value: text(value.location, 160),
      provenance: value.location ? 'legacy-reconstructed' : 'unknown',
    },
    canonicalUrl: url,
    url,
    sources: url ? [url] : [],
    source: text(value.source || value.foundVia, 80),
    description: '',
    historicalDecisions: [decision],
  };
}

function collectHistoricalVacancies(root) {
  const paths = workspacePaths(root);
  const vacancies = [];
  const byUrl = new Map();
  const byCompany = new Map();
  const add = (candidate) => {
    const identity = jobIdentity(candidate);
    const urls = identity.references.map((reference) => reference.url).filter(Boolean);
    const candidates = [
      ...new Set([
        ...urls.map((url) => byUrl.get(url)).filter(Boolean),
        ...(byCompany.get(identity.company) || []),
      ]),
    ];
    const existing = candidates.find((item) => sameUnderlyingJob(item, candidate));
    if (existing) {
      existing.historicalDecisions.push(...candidate.historicalDecisions);
      if (!existing.canonicalUrl && candidate.canonicalUrl) {
        existing.canonicalUrl = candidate.canonicalUrl;
        existing.url = candidate.url;
        existing.sources = candidate.sources;
      }
      return;
    }
    vacancies.push(candidate);
    for (const url of urls) byUrl.set(url, candidate);
    if (!byCompany.has(identity.company)) byCompany.set(identity.company, []);
    byCompany.get(identity.company).push(candidate);
  };
  const tracker = JSON.parse(fs.readFileSync(paths.tracker, 'utf8'));
  for (const entry of tracker.opportunities || []) add(historicalVacancy(entry, trackerDecision(entry)));
  if (fs.existsSync(paths.scanRuns)) {
    for (const [lineIndex, line] of fs.readFileSync(paths.scanRuns, 'utf8')
      .split(/\r?\n/).filter(Boolean).entries()) {
      let run;
      try { run = JSON.parse(line); } catch { continue; }
      for (const [index, item] of (Array.isArray(run.reviewed) ? run.reviewed : []).entries()) {
        if (!item?.company || !item?.role || !item?.outcome) continue;
        add(historicalVacancy(item, reviewDecision(run, item, lineIndex, index)));
      }
    }
  }
  return vacancies;
}

function decisionProvenance(decision, profile) {
  const exactProfile = decision.profileId && decision.profileId === profile.id;
  return {
    ...decision,
    profileProvenance: exactProfile ? 'exact-current-profile' : 'legacy-unreconstructable',
    scoringProvenance: 'legacy-unreconstructable',
  };
}

function publicHistoricalRank(item, profile) {
  const {
    stableTieBreak: _stableTieBreak,
    employer: _employer,
    title: _title,
    description: _description,
    ...value
  } = item;
  return {
    ...value,
    historicalDecisions: item.historicalDecisions.map((decision) => decisionProvenance(decision, profile)),
    currentDecision: 'reranked-only',
    assessmentRequested: false,
  };
}

export function rerankHistoricalVacancies(root, profile, { now = () => new Date().toISOString() } = {}) {
  if (!profile || profile.status !== 'published' || !profile.id) {
    throw new Error('historical re-ranking requires a published search profile');
  }
  const directory = path.join(workspacePaths(root).profile, 'search', 'rankings');
  const artifactPath = path.join(directory, `${profile.id}.json`);
  if (fs.existsSync(artifactPath)) {
    const existing = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (existing?.schemaVersion !== HISTORICAL_RANKING_SCHEMA_VERSION
      || existing?.profileId !== profile.id
      || !existing?.totals
      || !Array.isArray(existing?.ranked)
      || !Array.isArray(existing?.excluded)) {
      throw new Error('historical ranking artifact is invalid');
    }
    return { artifactPath, created: false, totals: existing.totals };
  }
  const paths = workspacePaths(root);
  const trackerBytes = fs.readFileSync(paths.tracker);
  const scanRunBytes = fs.existsSync(paths.scanRuns) ? fs.readFileSync(paths.scanRuns) : null;
  const vacancies = collectHistoricalVacancies(root);
  const filtered = filterVacancies(vacancies, profile);
  const ranked = rankVacancies(filtered.eligible, profile, vacancies)
    .map((item) => publicHistoricalRank(item, profile));
  const excludedById = new Map();
  for (const exclusion of filtered.excluded) {
    const key = String(exclusion.vacancyId);
    if (!excludedById.has(key)) excludedById.set(key, []);
    excludedById.get(key).push(exclusion.code);
  }
  const byId = new Map(vacancies.map((item) => [String(item.vacancyId), item]));
  const excluded = [...excludedById].map(([vacancyId, reasonCodes]) => {
    const vacancy = byId.get(vacancyId);
    return {
      vacancyId,
      company: vacancy?.company || 'Unknown employer',
      role: vacancy?.role || 'Unknown role',
      sourceUrl: vacancy?.url || null,
      historicalDecisions: (vacancy?.historicalDecisions || [])
        .map((decision) => decisionProvenance(decision, profile)),
      reasonCodes: [...new Set(reasonCodes)].sort(),
      currentDecision: 'reranked-excluded',
      assessmentRequested: false,
    };
  });
  const artifact = {
    schemaVersion: HISTORICAL_RANKING_SCHEMA_VERSION,
    createdAt: new Date(now()).toISOString(),
    profileId: profile.id,
    policy: {
      historicalDecisionsImmutable: true,
      assessmentRequested: false,
      legacyProvenance: 'legacy-unreconstructable',
    },
    sourceDigests: {
      tracker: digest(trackerBytes),
      scanRuns: scanRunBytes ? digest(scanRunBytes) : null,
    },
    totals: {
      reconstructed: vacancies.length,
      ranked: ranked.length,
      excluded: excluded.length,
    },
    ranked,
    excluded,
  };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  atomicWriteFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  return {
    artifactPath,
    created: true,
    totals: artifact.totals,
  };
}
