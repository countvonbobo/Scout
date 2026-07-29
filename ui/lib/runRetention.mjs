import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { projectRunManifest } from './runArtifacts.mjs';
import { validateRunJournal } from './runJournal.mjs';
import {
  assertCurrentFence, assertScanLeaseScope, synchronousFenceCallback,
} from './scanLease.mjs';
import { projectScanQueue } from './scanQueue.mjs';
import {
  verifyReviewedRunArchive, writeReviewedRunArchive,
} from './recoveryBackup.mjs';
import { workspacePaths } from './workspace.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLICY = Object.freeze({
  keepNewest: 20,
  keepDays: 30,
  summaryDays: 365,
});
const DEFAULT_MAXIMUM_BYTES = Object.freeze({
  runs: 256 * 1024 * 1024,
  artifacts: 1024 * 1024 * 1024,
  queue: 64 * 1024 * 1024,
});
const RETENTION_INDEX_SCHEMA_VERSION = 1;
const ARCHIVE_SCHEMA_VERSION = 1;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkedDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

function safeRunDirectory(root, runId) {
  const runsRoot = path.resolve(workspacePaths(root).runs);
  const target = path.resolve(runsRoot, runId);
  if (path.dirname(target) !== runsRoot) throw new Error('retention run path escaped the run store');
  return target;
}

function walkFiles(directory, relative = '', files = []) {
  if (!fs.existsSync(directory)) return files;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error('retention does not accept symbolic links');
  if (stat.isFile()) {
    files.push({ relative: relative.replaceAll('\\', '/'), absolute: directory, size: stat.size });
    return files;
  }
  if (!stat.isDirectory()) throw new Error('retention encountered an unsupported filesystem entry');
  for (const name of fs.readdirSync(directory).sort()) {
    walkFiles(path.join(directory, name), relative ? path.join(relative, name) : name, files);
  }
  return files;
}

function runInventory(root) {
  const runsRoot = workspacePaths(root).runs;
  if (!fs.existsSync(runsRoot)) return [];
  const inventory = [];
  for (const entry of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      if (entry.isSymbolicLink()) throw new Error('retention run store contains a symbolic link');
      continue;
    }
    const directory = safeRunDirectory(root, entry.name);
    const journalFile = path.join(directory, 'journal.jsonl');
    const files = walkFiles(directory);
    let events = [];
    let invalid = false;
    if (fs.existsSync(journalFile)) {
      try {
        const result = validateRunJournal(journalFile);
        if (result.truncatedTail) throw new Error('run journal has a truncated final entry');
        events = result.events;
      } catch {
        invalid = true;
      }
    } else {
      invalid = true;
    }
    let manifest = null;
    if (!invalid && events.length) {
      try {
        manifest = projectRunManifest(events);
      } catch {
        invalid = true;
      }
    }
    const updatedAt = events.at(-1)?.recordedAt || null;
    inventory.push({
      runId: entry.name,
      directory,
      files,
      invalid,
      events,
      manifest,
      outcome: manifest?.outcome || 'in-progress',
      updatedAt,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      digest: digestFiles(files),
    });
  }
  return inventory;
}

function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(fs.readFileSync(file.absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function recoveryReferencedRunIds(root) {
  const file = path.join(path.resolve(root), '.scout', 'recovery-selections.jsonl');
  if (!fs.existsSync(file)) return new Set();
  const contents = fs.readFileSync(file, 'utf8');
  if (contents && !contents.endsWith('\n')) throw new Error('recovery selection journal is truncated');
  const ids = new Set();
  for (const line of contents.split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error('recovery selection journal is invalid');
    }
    if (typeof record.selectedRunId === 'string') ids.add(record.selectedRunId);
    for (const skipped of Array.isArray(record.skipped) ? record.skipped : []) {
      if (typeof skipped?.runId === 'string') ids.add(skipped.runId);
    }
  }
  return ids;
}

function queuedRunIds(root, now) {
  const ids = new Set();
  for (const request of projectScanQueue(root, now).requests) {
    if (request.claim?.runId && ['queued', 'claimed', 'legacy-claimed'].includes(request.status)) {
      ids.add(request.claim.runId);
    }
  }
  return ids;
}

function isArtifactFile(file) {
  return file.relative === 'artifacts' || file.relative.startsWith('artifacts/');
}

export function measureRunStorage(root) {
  const inventory = runInventory(root);
  const referenced = recoveryReferencedRunIds(root);
  let runBytes = 0;
  let artifactBytes = 0;
  let artifactCount = 0;
  const critical = [];
  for (const run of inventory) {
    for (const file of run.files) {
      if (isArtifactFile(file)) {
        artifactBytes += file.size;
        artifactCount += 1;
      } else {
        runBytes += file.size;
      }
    }
    if (run.invalid || run.outcome !== 'complete' || referenced.has(run.runId)) critical.push(run);
  }
  const queueFile = path.join(path.resolve(root), '.scout', 'scan-queue.jsonl');
  const queueBytes = fs.existsSync(queueFile) ? fs.statSync(queueFile).size : 0;
  let queueEvents = 0;
  if (queueBytes) {
    const text = fs.readFileSync(queueFile, 'utf8');
    queueEvents = text.split('\n').filter(Boolean).length;
  }
  return {
    runs: { bytes: runBytes, count: inventory.length },
    artifacts: { bytes: artifactBytes, count: artifactCount },
    queue: { bytes: queueBytes, events: queueEvents },
    totalBytes: runBytes + artifactBytes + queueBytes,
    recoveryCritical: {
      count: critical.length,
      bytes: critical.reduce((sum, run) => sum + run.bytes, 0),
      runIds: critical.map((run) => run.runId).sort(),
    },
  };
}

function compactSummary(run) {
  return {
    schemaVersion: 1,
    runId: run.runId,
    updatedAt: run.updatedAt,
    outcome: run.outcome,
    completedStages: (run.manifest?.completedWork || []).map((work) => work.stageId),
    recoveryCount: Array.isArray(run.manifest?.recoveryAttempts)
      ? run.manifest.recoveryAttempts.length : 0,
  };
}

function selectionDigest(root, generatedAt, selected) {
  return sha256(stableJson({
    root: path.resolve(root),
    generatedAt,
    selected: selected.map(({ runId, digest }) => ({ runId, digest })),
  }));
}

export function planRunCleanup(root, inputPolicy = {}) {
  const now = checkedDate(inputPolicy.now ?? new Date(), 'retention policy time');
  const keepNewest = inputPolicy.keepNewest ?? DEFAULT_POLICY.keepNewest;
  const keepDays = inputPolicy.keepDays ?? DEFAULT_POLICY.keepDays;
  const summaryDays = inputPolicy.summaryDays ?? DEFAULT_POLICY.summaryDays;
  if (![keepNewest, keepDays, summaryDays].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('retention policy bounds must be non-negative whole numbers');
  }
  const inventory = runInventory(root);
  const referenced = recoveryReferencedRunIds(root);
  const queued = queuedRunIds(root, now);
  const ordered = [...inventory].sort((left, right) => (
    String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
      || right.runId.localeCompare(left.runId)
  ));
  const newest = new Set(ordered.slice(0, keepNewest).map((run) => run.runId));
  const recentBoundary = now.getTime() - keepDays * DAY_MS;
  const summaryBoundary = now.getTime() - summaryDays * DAY_MS;
  const candidates = [];
  const protectedReasons = new Map();
  for (const run of inventory) {
    let reason = null;
    const updated = Date.parse(run.updatedAt || '');
    if (run.invalid || run.outcome !== 'complete') reason = 'recovery-critical';
    else if (referenced.has(run.runId)) reason = 'recovery-referenced';
    else if (queued.has(run.runId)) reason = 'queued';
    else if (newest.has(run.runId)) reason = 'newest-retained';
    else if (!Number.isFinite(updated) || updated >= recentBoundary) reason = 'recent-retained';
    if (reason) {
      protectedReasons.set(run.runId, reason);
      continue;
    }
    candidates.push({
      runId: run.runId,
      updatedAt: run.updatedAt,
      outcome: run.outcome,
      bytes: run.bytes,
      digest: run.digest,
      summary: compactSummary(run),
    });
  }
  candidates.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)
    || left.runId.localeCompare(right.runId));
  const candidateById = new Map(candidates.map((candidate) => [candidate.runId, candidate]));
  const requested = [...new Set(inputPolicy.selectedRunIds || [])].sort();
  const selected = requested.map((runId) => candidateById.get(runId)).filter(Boolean);
  const refusedSelections = requested.filter((runId) => !candidateById.has(runId)).map((runId) => ({
    runId,
    reason: protectedReasons.get(runId) || 'unknown-run',
  }));
  const plan = {
    schemaVersion: 1,
    root: path.resolve(root),
    generatedAt: now.toISOString(),
    policy: { keepNewest, keepDays, summaryDays },
    candidates,
    selected,
    refusedSelections,
    compactSummaries: selected
      .filter((candidate) => Date.parse(candidate.updatedAt) >= summaryBoundary)
      .map((candidate) => candidate.summary),
    reviewedSelectionDigest: selectionDigest(root, now.toISOString(), selected),
  };
  Object.defineProperty(plan, 'recoveryDataKey', {
    value: inputPolicy.recoveryDataKey,
    enumerable: false,
    writable: false,
  });
  return Object.freeze(plan);
}

function currentFence(lease, callback) {
  return assertCurrentFence(lease, synchronousFenceCallback(callback));
}

function checkedSelectedSources(plan) {
  const sources = [];
  for (const selected of plan.selected) {
    const directory = safeRunDirectory(plan.root, selected.runId);
    if (!fs.existsSync(directory)) throw new Error('selected run changed after review');
    const files = walkFiles(directory);
    if (digestFiles(files) !== selected.digest) throw new Error('selected run changed after review');
    sources.push({
      runId: selected.runId,
      digest: selected.digest,
      files: files.map((file) => ({
        path: file.relative,
        size: file.size,
        sha256: sha256(fs.readFileSync(file.absolute)),
        data: fs.readFileSync(file.absolute).toString('base64'),
      })),
    });
  }
  return sources;
}

function retentionIndexFile(root) {
  return path.join(path.resolve(root), '.scout', 'run-retention-index.json');
}

function readRetentionIndex(root) {
  const file = retentionIndexFile(root);
  if (!fs.existsSync(file)) return { schemaVersion: RETENTION_INDEX_SCHEMA_VERSION, summaries: [] };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value?.schemaVersion !== RETENTION_INDEX_SCHEMA_VERSION || !Array.isArray(value.summaries)) {
    throw new Error('run retention index is invalid');
  }
  return value;
}

function appendAudit(root, record) {
  const file = path.join(path.resolve(root), '.scout', 'run-retention.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try {
    const bytes = Buffer.from(`${stableJson(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('retention audit append made no progress');
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function archiveSelectedRuns(plan, lease) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.selected) || !plan.selected.length) {
    throw new TypeError('an explicit non-empty reviewed cleanup selection is required');
  }
  if (!Buffer.isBuffer(plan.recoveryDataKey) || plan.recoveryDataKey.length !== 32) {
    throw new Error('A protected archive sink with an unlocked recovery data key is required');
  }
  if (selectionDigest(plan.root, plan.generatedAt, plan.selected) !== plan.reviewedSelectionDigest) {
    throw new Error('reviewed selection changed after operator review');
  }
  assertScanLeaseScope(lease, plan.root, lease?.runId);
  const sources = currentFence(lease, () => checkedSelectedSources(plan));
  const archiveId = sha256(stableJson({
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runs: sources.map(({ runId, digest }) => ({ runId, digest })),
  }));
  const payload = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runs: sources,
  };
  const assertFence = () => currentFence(lease, () => true);
  const written = writeReviewedRunArchive(
    plan.root,
    plan.recoveryDataKey,
    payload,
    { assertFence },
  );
  const verified = verifyReviewedRunArchive(written.file, plan.recoveryDataKey);
  if (sha256(stableJson(verified)) !== sha256(stableJson(payload))) {
    throw new Error('Reviewed run archive verification failed');
  }

  const previousIndex = readRetentionIndex(plan.root);
  const summaryBoundary = Date.parse(plan.generatedAt) - plan.policy.summaryDays * DAY_MS;
  const summaries = new Map(previousIndex.summaries
    .filter((summary) => Date.parse(summary.updatedAt || '') >= summaryBoundary)
    .map((summary) => [summary.runId, summary]));
  for (const summary of plan.compactSummaries) summaries.set(summary.runId, summary);
  const nextIndex = {
    schemaVersion: RETENTION_INDEX_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    summaries: [...summaries.values()].sort((left, right) => (
      String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.runId.localeCompare(right.runId)
    )),
  };
  const indexFile = retentionIndexFile(plan.root);
  currentFence(lease, () => atomicWriteFile(indexFile, `${stableJson(nextIndex)}\n`, { mode: 0o600 }));
  currentFence(lease, () => appendAudit(plan.root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    type: 'archive-reviewed',
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runIds: plan.selected.map((selected) => selected.runId),
  }));

  let archivedRuns = 0;
  for (const selected of plan.selected) {
    currentFence(lease, () => {
      const directory = safeRunDirectory(plan.root, selected.runId);
      if (!fs.existsSync(directory) || digestFiles(walkFiles(directory)) !== selected.digest) {
        throw new Error('selected run changed after review');
      }
      fs.rmSync(directory, { recursive: true, force: false });
      archivedRuns += 1;
    });
  }
  currentFence(lease, () => appendAudit(plan.root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    type: 'archive-completed',
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runIds: plan.selected.map((selected) => selected.runId),
  }));
  return { archiveFile: written.file, indexFile, archiveId, archivedRuns };
}

function queueEventIds(record) {
  return [
    record.request?.id,
    record.requestId,
    record.incomingRequestId,
    record.supersededRequestId,
  ].filter((value) => typeof value === 'string');
}

function queueEvents(root) {
  const file = path.join(path.resolve(root), '.scout', 'scan-queue.jsonl');
  if (!fs.existsSync(file)) return { file, events: [], contents: '' };
  const contents = fs.readFileSync(file, 'utf8');
  if (contents && !contents.endsWith('\n')) throw new Error('scan queue journal is truncated');
  const events = contents.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error('scan queue journal is invalid');
    }
  });
  // The canonical projector performs the full schema and lifecycle validation.
  projectScanQueue(root, new Date());
  return { file, events, contents };
}

export function compactScanQueue(root, lease, { now = new Date(), summaryDays = 365 } = {}) {
  now = checkedDate(now, 'queue compaction time');
  if (!Number.isSafeInteger(summaryDays) || summaryDays < 0) {
    throw new TypeError('queue summary retention must be a non-negative whole number');
  }
  assertScanLeaseScope(lease, root, lease?.runId);
  const snapshot = currentFence(lease, () => queueEvents(root));
  const projection = projectScanQueue(root, now);
  const cutoff = now.getTime() - summaryDays * DAY_MS;
  const keepIds = new Set();
  for (const request of projection.requests) {
    const expiresAt = Date.parse(request.expiresAt || '');
    const live = request.status === 'claimed' || request.status === 'legacy-claimed'
      || (request.status === 'queued' && Number.isFinite(expiresAt) && expiresAt > now.getTime());
    const terminalAt = Date.parse(request.completion?.at || request.expiresAt || request.requestedAt || '');
    if (live || (Number.isFinite(terminalAt) && terminalAt >= cutoff)) keepIds.add(request.id);
  }
  // A scheduled replacement depends on the earlier request being replayable.
  let changed;
  do {
    changed = false;
    for (const record of snapshot.events) {
      if (record.request?.id && keepIds.has(record.request.id) && record.supersededRequestId
        && !keepIds.has(record.supersededRequestId)) {
        keepIds.add(record.supersededRequestId);
        changed = true;
      }
    }
  } while (changed);
  const kept = snapshot.events.filter((record) => queueEventIds(record).some((id) => keepIds.has(id)));
  const next = kept.length ? `${kept.map((record) => JSON.stringify(record)).join('\n')}\n` : '';
  if (next === snapshot.contents) {
    return { changed: false, removedEvents: 0, keptEvents: kept.length };
  }
  currentFence(lease, () => {
    const current = queueEvents(root);
    if (sha256(current.contents) !== sha256(snapshot.contents)) {
      throw new Error('scan queue changed during compaction');
    }
    atomicWriteFile(snapshot.file, next, { mode: 0o600 });
  });
  currentFence(lease, () => appendAudit(root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    type: 'queue-compacted',
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    beforeDigest: sha256(snapshot.contents),
    afterDigest: sha256(next),
    removedEvents: snapshot.events.length - kept.length,
  }));
  return {
    changed: true,
    removedEvents: snapshot.events.length - kept.length,
    keptEvents: kept.length,
  };
}

export function assertRunStorageWritable(root, policy = {}) {
  const measurement = measureRunStorage(root);
  const maximumBytes = { ...DEFAULT_MAXIMUM_BYTES, ...(policy.maximumBytes || {}) };
  const reserveBytes = Number(policy.reserveBytes ?? 64 * 1024);
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new TypeError('journal storage reserve must be a non-negative whole number');
  }
  const blocked = ['runs', 'artifacts', 'queue'].filter((area) => (
    measurement[area].bytes + reserveBytes > maximumBytes[area]
  ));
  if (blocked.length) {
    const error = new Error(`Scout cannot safely journal new work: storage pressure in ${blocked.join(', ')}`);
    error.name = 'RunStoragePressureError';
    error.code = 'SCOUT_STORAGE_PRESSURE';
    error.areas = blocked;
    error.measurement = measurement;
    throw error;
  }
  return measurement;
}

export const RUN_STORAGE_MAXIMUM_BYTES = DEFAULT_MAXIMUM_BYTES;
