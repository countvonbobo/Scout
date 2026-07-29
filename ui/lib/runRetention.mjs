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
  assertPersistedRecoveryDataKey, verifyReviewedRunArchive, writeReviewedRunArchive,
} from './recoveryBackup.mjs';
import { validatePhysicalWorkspacePath } from './physicalPath.mjs';
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
const DEFAULT_WARNING_BYTES = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_MAXIMUM_BYTES).map(([area, bytes]) => [area, Math.floor(bytes * 0.75)]),
));
const DEFAULT_RESERVE_BYTES = 64 * 1024;
const RETENTION_INDEX_SCHEMA_VERSION = 1;
const ARCHIVE_SCHEMA_VERSION = 1;
const MAX_COMPLETED_QUEUE_COMPACTION_RECEIPTS = 20;

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
  return validatePhysicalWorkspacePath(root, target, 'retention run path');
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
  validatePhysicalWorkspacePath(root, runsRoot, 'retention run store');
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
  validatePhysicalWorkspacePath(root, file, 'recovery selection journal');
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
  const queueFileBytes = fs.existsSync(queueFile) ? fs.statSync(queueFile).size : 0;
  let queueEvents = 0;
  if (queueFileBytes) {
    const text = fs.readFileSync(queueFile, 'utf8');
    queueEvents = text.split('\n').filter(Boolean).length;
  }
  const queueOperationRoot = path.join(path.resolve(root), '.scout', 'queue-compactions');
  let operationBytes = 0;
  let recoveryCriticalOperations = 0;
  let completedReceipts = 0;
  if (fs.existsSync(queueOperationRoot)) {
    validatePhysicalWorkspacePath(root, queueOperationRoot, 'queue compaction store');
    operationBytes = walkFiles(queueOperationRoot)
      .reduce((sum, file) => sum + file.size, 0);
    for (const name of fs.readdirSync(queueOperationRoot).sort()) {
      const manifestFile = path.join(queueOperationRoot, name, 'manifest.json');
      if (!fs.existsSync(manifestFile)) {
        recoveryCriticalOperations += 1;
        continue;
      }
      validatePhysicalWorkspacePath(root, manifestFile, 'queue compaction manifest');
      try {
        const manifest = checkedQueueOperationManifest(root, name, manifestFile);
        if (manifest.status === 'completed') completedReceipts += 1;
        else recoveryCriticalOperations += 1;
      } catch {
        recoveryCriticalOperations += 1;
      }
    }
  }
  const queueBytes = queueFileBytes + operationBytes;
  return {
    runs: { bytes: runBytes, count: inventory.length },
    artifacts: { bytes: artifactBytes, count: artifactCount },
    queue: {
      bytes: queueBytes,
      events: queueEvents,
      operationBytes,
      recoveryCriticalOperations,
      completedReceipts,
    },
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

function snapshotDigest(file) {
  if (!fs.existsSync(file)) return sha256('');
  validatePhysicalWorkspacePath(path.dirname(path.dirname(file)), file, 'retention authority snapshot');
  return sha256(fs.readFileSync(file));
}

function authoritySnapshots(root) {
  const scout = path.join(path.resolve(root), '.scout');
  return {
    queueDigest: snapshotDigest(path.join(scout, 'scan-queue.jsonl')),
    recoverySelectionsDigest: snapshotDigest(path.join(scout, 'recovery-selections.jsonl')),
  };
}

function planDigest(plan) {
  return sha256(stableJson({
    schemaVersion: plan.schemaVersion,
    root: plan.root,
    generatedAt: plan.generatedAt,
    policy: plan.policy,
    candidates: plan.candidates,
    selected: plan.selected,
    refusedSelections: plan.refusedSelections,
    compactSummaries: plan.compactSummaries,
    authoritySnapshots: plan.authoritySnapshots,
  }));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
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
    authoritySnapshots: authoritySnapshots(root),
  };
  plan.reviewedSelectionDigest = planDigest(plan);
  Object.defineProperty(plan, 'recoveryDataKey', {
    value: inputPolicy.recoveryDataKey,
    enumerable: false,
    writable: false,
  });
  return deepFreeze(plan);
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

function checkedCompactSummary(value) {
  const keys = ['completedStages', 'outcome', 'recoveryCount', 'runId', 'schemaVersion', 'updatedAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schemaVersion !== 1
    || typeof value.runId !== 'string'
    || typeof value.updatedAt !== 'string'
    || value.outcome !== 'complete'
    || !Array.isArray(value.completedStages)
    || value.completedStages.some((stage) => typeof stage !== 'string')
    || !Number.isSafeInteger(value.recoveryCount) || value.recoveryCount < 0) {
    throw new Error('run retention summary is invalid');
  }
  return value;
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
  value.summaries.forEach(checkedCompactSummary);
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

function auditEvents(root) {
  const file = path.join(path.resolve(root), '.scout', 'run-retention.jsonl');
  if (!fs.existsSync(file)) return [];
  validatePhysicalWorkspacePath(root, file, 'retention audit');
  const contents = fs.readFileSync(file, 'utf8');
  if (contents && !contents.endsWith('\n')) throw new Error('retention audit is truncated');
  return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function appendAuditOnce(root, record) {
  const existing = auditEvents(root).find((event) => (
    event.operationId === record.operationId && event.type === record.type
  ));
  if (existing) {
    const canonical = (event) => {
      const {
        eventId: ignoredEventId,
        recordedAt: ignoredRecordedAt,
        leaseId: ignoredLeaseId,
        fencingGeneration: ignoredGeneration,
        ...durable
      } = event;
      void ignoredEventId;
      void ignoredRecordedAt;
      void ignoredLeaseId;
      void ignoredGeneration;
      return stableJson(durable);
    };
    if (canonical(existing) !== canonical(record)) throw new Error('retention audit identity conflicts');
    return existing;
  }
  appendAudit(root, record);
  return record;
}

function cleanupOperationFile(plan) {
  const operationId = sha256(`cleanup:${plan.reviewedSelectionDigest}`);
  const file = path.join(plan.root, '.scout', 'run-cleanups', operationId, 'manifest.json');
  return { operationId, file };
}

function writeCleanupOperation(root, file, manifest) {
  validatePhysicalWorkspacePath(root, file, 'cleanup operation manifest');
  atomicWriteFile(file, `${stableJson(manifest)}\n`, { mode: 0o600 });
}

function readCleanupOperation(root, file) {
  if (!fs.existsSync(file)) return null;
  validatePhysicalWorkspacePath(root, file, 'cleanup operation manifest');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = ['archiveFile', 'archiveId', 'operationId', 'planDigest', 'runs', 'schemaVersion', 'status'];
  if (!value || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.schemaVersion !== 1
    || !/^[a-f0-9]{64}$/.test(value.operationId || '')
    || !/^[a-f0-9]{64}$/.test(value.planDigest || '')
    || !['prepared', 'archived', 'completed'].includes(value.status)
    || (value.archiveFile !== null && typeof value.archiveFile !== 'string')
    || (value.archiveId !== null && !/^[a-f0-9]{64}$/.test(value.archiveId || ''))
    || !Array.isArray(value.runs)
    || value.runs.some((run) => (
      !run || Object.keys(run).sort().join(',') !== 'digest,runId,status'
      || typeof run.runId !== 'string' || !/^[a-f0-9]{64}$/.test(run.digest || '')
      || !['pending', 'deleted'].includes(run.status)
    ))) {
    throw new Error('cleanup operation manifest is invalid');
  }
  return value;
}

function assertPlanCurrent(plan, { allowMissing = false } = {}) {
  if (planDigest(plan) !== plan.reviewedSelectionDigest) {
    throw new Error('reviewed selection changed after operator review');
  }
  const snapshots = authoritySnapshots(plan.root);
  if (stableJson(snapshots) !== stableJson(plan.authoritySnapshots)) {
    throw new Error('cleanup eligibility changed because recovery-critical durable state changed');
  }
  const current = planRunCleanup(plan.root, {
    now: new Date(plan.generatedAt),
    ...plan.policy,
    selectedRunIds: plan.selected.map((selected) => selected.runId),
    recoveryDataKey: plan.recoveryDataKey,
  });
  const eligible = new Set(current.candidates.map((candidate) => candidate.runId));
  for (const selected of plan.selected) {
    const directory = path.join(workspacePaths(plan.root).runs, selected.runId);
    if (!fs.existsSync(directory) && allowMissing) continue;
    if (!eligible.has(selected.runId)) {
      throw new Error(`selected run became recovery-critical or otherwise ineligible: ${selected.runId}`);
    }
  }
}

function archivePayloadMatchesPlan(payload, plan) {
  if (payload.reviewedSelectionDigest !== plan.reviewedSelectionDigest) return false;
  const archived = payload.runs.map(({ runId, digest }) => ({ runId, digest }));
  const selected = plan.selected.map(({ runId, digest }) => ({ runId, digest }));
  return stableJson(archived) === stableJson(selected);
}

export function archiveSelectedRuns(plan, lease, hooks = {}) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.selected) || !plan.selected.length) {
    throw new TypeError('an explicit non-empty reviewed cleanup selection is required');
  }
  if (!Buffer.isBuffer(plan.recoveryDataKey) || plan.recoveryDataKey.length !== 32) {
    throw new Error('A protected archive sink with an unlocked recovery data key is required');
  }
  assertScanLeaseScope(lease, plan.root, lease?.runId);
  currentFence(lease, () => assertPlanCurrent(plan, { allowMissing: true }));
  // Prove the supplied key belongs to the persisted recovery header before
  // creating cleanup intent or touching a source.
  const persistedHeader = path.join(plan.root, '.scout-backup', 'v1', 'header.json');
  validatePhysicalWorkspacePath(plan.root, persistedHeader, 'persisted recovery authority');
  assertPersistedRecoveryDataKey(plan.root, plan.recoveryDataKey);
  const { operationId, file: operationManifest } = cleanupOperationFile(plan);
  let operation = currentFence(lease, () => {
    const existing = readCleanupOperation(plan.root, operationManifest);
    if (existing) {
      if (existing.operationId !== operationId
        || existing.planDigest !== plan.reviewedSelectionDigest
        || !Array.isArray(existing.runs)) throw new Error('cleanup operation manifest conflicts');
      return existing;
    }
    const created = {
      schemaVersion: 1,
      operationId,
      planDigest: plan.reviewedSelectionDigest,
      status: 'prepared',
      archiveFile: null,
      archiveId: null,
      runs: plan.selected.map(({ runId, digest }) => ({ runId, digest, status: 'pending' })),
    };
    writeCleanupOperation(plan.root, operationManifest, created);
    return created;
  });

  let payload = null;
  let written = null;
  if (operation.archiveFile) {
    const archiveFile = validatePhysicalWorkspacePath(plan.root, path.join(plan.root, operation.archiveFile), 'reviewed archive');
    payload = verifyReviewedRunArchive(archiveFile, plan.recoveryDataKey);
    if (!archivePayloadMatchesPlan(payload, plan)) throw new Error('verified archive conflicts with reviewed cleanup plan');
    written = { file: archiveFile, archiveId: payload.archiveId };
  }
  const sources = payload?.runs || currentFence(lease, () => {
    assertPlanCurrent(plan);
    return checkedSelectedSources(plan);
  });
  const archiveId = sha256(stableJson({
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runs: sources.map(({ runId, digest }) => ({ runId, digest })),
  }));
  payload ||= {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runs: sources,
  };
  written ||= writeReviewedRunArchive(
    plan.root,
    plan.recoveryDataKey,
    payload,
    {
      commitFence: (commit) => currentFence(lease, () => {
        assertPlanCurrent(plan);
        checkedSelectedSources(plan);
        return commit();
      }),
      beforeCommit: hooks.beforeArchiveCommit,
    },
  );
  const verified = verifyReviewedRunArchive(written.file, plan.recoveryDataKey);
  if (sha256(stableJson(verified)) !== sha256(stableJson(payload))) {
    throw new Error('Reviewed run archive verification failed');
  }

  operation = currentFence(lease, () => {
    const next = {
      ...operation,
      status: 'archived',
      archiveFile: path.relative(plan.root, written.file).replaceAll('\\', '/'),
      archiveId,
    };
    writeCleanupOperation(plan.root, operationManifest, next);
    return next;
  });

  const previousIndex = readRetentionIndex(plan.root);
  const summaryBoundary = Date.parse(plan.generatedAt) - plan.policy.summaryDays * DAY_MS;
  const summaries = new Map(previousIndex.summaries
    .filter((summary) => Date.parse(summary.updatedAt || '') >= summaryBoundary)
    .map((summary) => [summary.runId, summary]));
  for (const summary of plan.compactSummaries) summaries.set(summary.runId, checkedCompactSummary(summary));
  const nextIndex = {
    schemaVersion: RETENTION_INDEX_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    summaries: [...summaries.values()].sort((left, right) => (
      String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.runId.localeCompare(right.runId)
    )),
  };
  const indexFile = retentionIndexFile(plan.root);
  currentFence(lease, () => {
    assertPlanCurrent(plan, { allowMissing: true });
    validatePhysicalWorkspacePath(plan.root, indexFile, 'run retention index');
    atomicWriteFile(indexFile, `${stableJson(nextIndex)}\n`, { mode: 0o600 });
  });
  currentFence(lease, () => appendAuditOnce(plan.root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    type: 'archive-reviewed',
    operationId,
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runIds: plan.selected.map((selected) => selected.runId),
  }));

  for (const [index, selected] of plan.selected.entries()) {
    const receipt = operation.runs.find((run) => run.runId === selected.runId);
    if (receipt?.status === 'deleted') continue;
    let removedNow = false;
    currentFence(lease, () => {
      assertPlanCurrent(plan, { allowMissing: true });
      const directory = safeRunDirectory(plan.root, selected.runId);
      if (!fs.existsSync(directory)) return;
      if (digestFiles(walkFiles(directory)) !== selected.digest) {
        throw new Error('selected run changed after review');
      }
      fs.rmSync(directory, { recursive: true, force: false });
      removedNow = true;
    });
    if (removedNow && typeof hooks.afterSourceDelete === 'function') hooks.afterSourceDelete({ index, runId: selected.runId });
    operation = currentFence(lease, () => {
      assertPlanCurrent(plan, { allowMissing: true });
      const archivedRun = verified.runs.find((run) => run.runId === selected.runId && run.digest === selected.digest);
      if (!archivedRun) throw new Error('verified archive does not contain the deleted run');
      const next = {
        ...operation,
        runs: operation.runs.map((run) => (
          run.runId === selected.runId ? { ...run, status: 'deleted' } : run
        )),
      };
      writeCleanupOperation(plan.root, operationManifest, next);
      return next;
    });
  }
  currentFence(lease, () => appendAuditOnce(plan.root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    type: 'archive-completed',
    operationId,
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    archiveId,
    reviewedSelectionDigest: plan.reviewedSelectionDigest,
    runIds: plan.selected.map((selected) => selected.runId),
  }));
  operation = currentFence(lease, () => {
    const next = { ...operation, status: 'completed' };
    writeCleanupOperation(plan.root, operationManifest, next);
    return next;
  });
  return {
    archiveFile: written.file,
    indexFile,
    archiveId,
    archivedRuns: operation.runs.filter((run) => run.status === 'deleted').length,
    operationManifest,
  };
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
  validatePhysicalWorkspacePath(root, file, 'scan queue journal');
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

function terminalQueueTime(events, requestId) {
  const terminal = events.filter((record) => (
    (['completed', 'expired', 'stale', 'window-covered'].includes(record.type)
      && record.requestId === requestId)
    || (record.type === 'scheduled-replaced' && record.supersededRequestId === requestId)
  )).at(-1);
  return terminal ? Date.parse(terminal.at || '') : NaN;
}

function queueCompactionDirectory(root, operationId) {
  return path.join(path.resolve(root), '.scout', 'queue-compactions', operationId);
}

function checkedQueueOperationManifest(root, operationId, manifestFile) {
  validatePhysicalWorkspacePath(root, manifestFile, 'queue compaction manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const versionOneKeys = ['afterDigest', 'beforeDigest', 'operationId', 'removedEvents', 'schemaVersion', 'status'];
  const versionTwoKeys = [...versionOneKeys, 'completedAt'];
  const keys = manifest && Object.keys(manifest).sort().join(',');
  const expectedKeys = manifest?.schemaVersion === 1 ? versionOneKeys : versionTwoKeys;
  if (!manifest || keys !== expectedKeys.sort().join(',')
    || ![1, 2].includes(manifest.schemaVersion)
    || manifest.operationId !== operationId
    || !/^[a-f0-9]{64}$/.test(manifest.operationId || '')
    || !/^[a-f0-9]{64}$/.test(manifest.beforeDigest || '')
    || !/^[a-f0-9]{64}$/.test(manifest.afterDigest || '')
    || !['prepared', 'completed'].includes(manifest.status)
    || !Number.isSafeInteger(manifest.removedEvents) || manifest.removedEvents < 0
    || (manifest.schemaVersion === 2
      && manifest.completedAt !== null
      && (typeof manifest.completedAt !== 'string'
        || Number.isNaN(Date.parse(manifest.completedAt))))
    || (manifest.schemaVersion === 2 && manifest.status === 'prepared' && manifest.completedAt !== null)
    || (manifest.schemaVersion === 2 && manifest.status === 'completed' && manifest.completedAt === null)) {
    throw new Error('queue compaction manifest is invalid');
  }
  return manifest;
}

function queueOperations(root) {
  const base = path.join(path.resolve(root), '.scout', 'queue-compactions');
  if (!fs.existsSync(base)) return [];
  validatePhysicalWorkspacePath(root, base, 'queue compaction store');
  return fs.readdirSync(base).sort().map((operationId) => {
    const directory = queueCompactionDirectory(root, operationId);
    validatePhysicalWorkspacePath(root, directory, 'queue compaction receipt');
    const manifestFile = path.join(directory, 'manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error('queue compaction manifest is missing');
    return {
      directory,
      manifestFile,
      manifest: checkedQueueOperationManifest(root, operationId, manifestFile),
    };
  });
}

function reduceCompletedQueueOperations(root) {
  const operations = queueOperations(root);
  const completed = operations.filter(({ manifest }) => manifest.status === 'completed');
  completed.sort((left, right) => {
    const timeDifference = Date.parse(right.manifest.completedAt || 0)
      - Date.parse(left.manifest.completedAt || 0);
    return timeDifference || right.manifest.operationId.localeCompare(left.manifest.operationId);
  });
  const retained = new Set(completed.slice(0, MAX_COMPLETED_QUEUE_COMPACTION_RECEIPTS)
    .map(({ manifest }) => manifest.operationId));
  for (const operation of completed) {
    for (const snapshot of ['before.jsonl', 'after.jsonl']) {
      const file = path.join(operation.directory, snapshot);
      if (!fs.existsSync(file)) continue;
      validatePhysicalWorkspacePath(root, file, 'queue compaction snapshot');
      fs.rmSync(file);
    }
    if (!retained.has(operation.manifest.operationId)) {
      validatePhysicalWorkspacePath(root, operation.directory, 'queue compaction receipt');
      walkFiles(operation.directory);
      fs.rmSync(operation.directory, { recursive: true });
    }
  }

  const auditFile = path.join(path.resolve(root), '.scout', 'run-retention.jsonl');
  if (!fs.existsSync(auditFile)) return;
  const events = auditEvents(root);
  const kept = events.filter((event) => (
    event.type !== 'queue-compacted' || retained.has(event.operationId)
  ));
  if (kept.length !== events.length) {
    validatePhysicalWorkspacePath(root, auditFile, 'retention audit');
    const contents = kept.length ? `${kept.map(stableJson).join('\n')}\n` : '';
    atomicWriteFile(auditFile, contents, { mode: 0o600 });
  }
}

function writeQueueOperation(root, operation) {
  const directory = queueCompactionDirectory(root, operation.operationId);
  validatePhysicalWorkspacePath(root, directory, 'queue compaction snapshot');
  atomicWriteFile(path.join(directory, 'before.jsonl'), operation.beforeContents, { mode: 0o600 });
  atomicWriteFile(path.join(directory, 'after.jsonl'), operation.afterContents, { mode: 0o600 });
  const manifest = {
    schemaVersion: 2,
    operationId: operation.operationId,
    status: operation.status,
    completedAt: null,
    beforeDigest: operation.beforeDigest,
    afterDigest: operation.afterDigest,
    removedEvents: operation.removedEvents,
  };
  atomicWriteFile(path.join(directory, 'manifest.json'), `${stableJson(manifest)}\n`, { mode: 0o600 });
  return path.join(directory, 'manifest.json');
}

function completeQueueOperation(root, lease, operation, manifestFile) {
  currentFence(lease, () => appendAuditOnce(root, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    operationId: operation.operationId,
    type: 'queue-compacted',
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    beforeDigest: operation.beforeDigest,
    afterDigest: operation.afterDigest,
    removedEvents: operation.removedEvents,
  }));
  currentFence(lease, () => {
    const completed = {
      schemaVersion: 2,
      operationId: operation.operationId,
      status: 'completed',
      completedAt: new Date().toISOString(),
      beforeDigest: operation.beforeDigest,
      afterDigest: operation.afterDigest,
      removedEvents: operation.removedEvents,
    };
    validatePhysicalWorkspacePath(root, manifestFile, 'queue compaction manifest');
    atomicWriteFile(manifestFile, `${stableJson(completed)}\n`, { mode: 0o600 });
    reduceCompletedQueueOperations(root);
  });
}

function reconcileQueueOperation(root, lease, currentDigest) {
  for (const { manifestFile, manifest } of queueOperations(root)) {
    if (manifest.afterDigest !== currentDigest || manifest.status === 'completed') continue;
    const afterFile = path.join(path.dirname(manifestFile), 'after.jsonl');
    validatePhysicalWorkspacePath(root, afterFile, 'queue compaction snapshot');
    const afterContents = fs.readFileSync(afterFile, 'utf8');
    if (sha256(afterContents) !== currentDigest) throw new Error('queue compaction snapshot is damaged');
    const operation = { ...manifest, afterContents, beforeContents: '' };
    completeQueueOperation(root, lease, operation, manifestFile);
    return { changed: false, reconciled: true, removedEvents: manifest.removedEvents, keptEvents: afterContents.split('\n').filter(Boolean).length };
  }
  return null;
}

export function compactScanQueue(root, lease, {
  now = new Date(),
  summaryDays = 365,
  beforeQueueReplace,
  afterQueueReplace,
} = {}) {
  now = checkedDate(now, 'queue compaction time');
  if (!Number.isSafeInteger(summaryDays) || summaryDays < 0) {
    throw new TypeError('queue summary retention must be a non-negative whole number');
  }
  assertScanLeaseScope(lease, root, lease?.runId);
  currentFence(lease, () => reduceCompletedQueueOperations(root));
  const snapshot = currentFence(lease, () => queueEvents(root));
  const projection = projectScanQueue(root, now);
  const cutoff = now.getTime() - summaryDays * DAY_MS;
  const keepIds = new Set();
  for (const request of projection.requests) {
    const expiresAt = Date.parse(request.expiresAt || '');
    const live = request.status === 'claimed' || request.status === 'legacy-claimed'
      || (request.status === 'queued' && Number.isFinite(expiresAt) && expiresAt > now.getTime());
    const terminalAt = terminalQueueTime(snapshot.events, request.id);
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
    return reconcileQueueOperation(root, lease, sha256(snapshot.contents))
      || { changed: false, removedEvents: 0, keptEvents: kept.length };
  }
  const beforeDigest = sha256(snapshot.contents);
  const afterDigest = sha256(next);
  const operationId = sha256(`queue-compaction:${beforeDigest}:${afterDigest}`);
  const operation = {
    operationId,
    status: 'prepared',
    beforeDigest,
    afterDigest,
    beforeContents: snapshot.contents,
    afterContents: next,
    removedEvents: snapshot.events.length - kept.length,
  };
  const manifestFile = currentFence(lease, () => writeQueueOperation(root, operation));
  currentFence(lease, () => {
    if (typeof beforeQueueReplace === 'function') beforeQueueReplace();
    const current = queueEvents(root);
    if (sha256(current.contents) !== beforeDigest) {
      throw new Error('scan queue changed during compaction');
    }
    validatePhysicalWorkspacePath(root, snapshot.file, 'scan queue journal');
    atomicWriteFile(snapshot.file, next, { mode: 0o600 });
  });
  if (typeof afterQueueReplace === 'function') afterQueueReplace();
  completeQueueOperation(root, lease, operation, manifestFile);
  return {
    changed: true,
    reconciled: false,
    removedEvents: snapshot.events.length - kept.length,
    keptEvents: kept.length,
  };
}

export function assertRunStorageWritable(root, policy = {}) {
  const measurement = measureRunStorage(root);
  const maximumBytes = { ...DEFAULT_MAXIMUM_BYTES, ...(policy.maximumBytes || {}) };
  const reserveBytes = Number(policy.reserveBytes ?? DEFAULT_RESERVE_BYTES);
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new TypeError('journal storage reserve must be a non-negative whole number');
  }
  const blocked = ['runs', 'artifacts', 'queue'].filter((area) => (
    measurement[area].bytes + reserveBytes >= maximumBytes[area]
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
export const RUN_STORAGE_WARNING_BYTES = DEFAULT_WARNING_BYTES;
export const RUN_STORAGE_RESERVE_BYTES = DEFAULT_RESERVE_BYTES;
