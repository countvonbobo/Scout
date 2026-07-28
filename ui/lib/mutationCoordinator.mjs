import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import {
  embedTrackerMutationMarker, readTrackerMutationMarker, trackerRevision,
} from './trackerPersistence.mjs';
import { appendRunEvent, replayRunJournal } from './runJournal.mjs';
import {
  LeaseLostError, assertCurrentFence, assertScanLeaseScope, isScanLease,
  synchronousFenceCallback,
} from './scanLease.mjs';

export const MUTATION_SCHEMA_VERSION = 1;
const MUTATION_GUARD = 'mutation.guard';
const MAX_MUTATION_BYTES = 16 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPORT_MARKER = /\n?<!-- scout-mutation:([A-Za-z0-9%._~-]+) -->\s*$/;
const PRIVATE_CONTENT_KEY = /^(?:access[-_]?token|advert[-_]?(?:body|description)|api[-_]?(?:key|token)|auth(?:orization)?|body|cookies?|credentials?|cv|description|headers?|html|master[-_]?cv|password|profile[-_]?evidence|prompt|raw[-_]?(?:html|output|provider(?:[-_]?response)?|response)|response|secret(?:[-_]?(?:key|token))?|token|transcript)$/i;
const CREDENTIAL_VALUE = /(?:\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)|(?:\b(?:api[-_ ]?key|authorization|password|secret|session[-_ ]?id|token)\s*[:=]\s*\S+)|(?:\bbearer\s+[A-Za-z0-9._~+/-]{8,})|(?:\bsk-[A-Za-z0-9_-]{16,})|(?:\bgh[pousr]_[A-Za-z0-9]{20,})|(?:\bxox[baprs]-[A-Za-z0-9-]{10,})|(?:\bAKIA[0-9A-Z]{16}\b)/i;
const TRANSIENT_TRACKING_VALUE = /https?:\/\/[^\s"'<>]+[?&](?:fbclid|gclid|mc_[a-z]+|utm_[a-z]+)=/i;
const MARKER_KEYS = [
  'intendedDigest', 'mutationId', 'mutationKey', 'runKey',
  'schemaVersion', 'targetKey',
];

export class MutationConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MutationConflictError';
  }
}

export class MutationCoordinatorBusyError extends Error {
  constructor(message = 'another workspace mutation is in progress') {
    super(message);
    this.name = 'MutationCoordinatorBusyError';
  }
}

function stableJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('mutation values must be finite JSON values');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('mutation values must be plain JSON objects');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value) {
  return sha256(stableJson(value));
}

function requireId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} must be a bounded identifier`);
  return value;
}

function mutationContext(value) {
  const handle = value?.handle ?? value?.run;
  const lease = value?.lease;
  if (!handle?.root || !handle?.runId || !handle?.directory || !handle?.file) {
    throw new TypeError('mutation run journal handle is required');
  }
  if (!isScanLease(lease)) throw new LeaseLostError('a genuine current scan lease is required to prepare a mutation');
  assertScanLeaseScope(lease, handle.root, handle.runId, handle.directory, handle.file);
  return { handle, lease };
}

function relativeTargetPath(root, value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError('mutation target path is invalid');
  const file = path.resolve(root, value);
  const relative = path.relative(path.resolve(root), file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TypeError('mutation target path must stay inside the workspace');
  }
  return relative.split(path.sep).join('/');
}

function fileContent(root, relative) {
  const file = path.join(root, ...relative.split('/'));
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function reportMarker(content) {
  const encoded = String(content).match(REPORT_MARKER)?.[1];
  if (!encoded) return null;
  try {
    return JSON.parse(decodeURIComponent(encoded));
  } catch {
    return null;
  }
}

function embedReportMarker(content, marker) {
  const source = String(content).replace(REPORT_MARKER, '').trimEnd();
  return `${source}\n\n<!-- scout-mutation:${encodeURIComponent(JSON.stringify(marker))} -->\n`;
}

function embedRunLogMarker(content, marker) {
  const lines = String(content).split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new TypeError('scan run log mutation content must contain a record');
  const record = JSON.parse(lines.at(-1));
  record._scoutMutation = marker;
  lines[lines.length - 1] = JSON.stringify(record);
  return `${lines.join('\n')}\n`;
}

function runLogMarker(content) {
  const lines = String(content).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  return JSON.parse(lines.at(-1))?._scoutMutation ?? null;
}

function markerFor(kind, content) {
  if (kind === 'tracker' || kind === 'json') return readTrackerMutationMarker(content);
  if (kind === 'report') return reportMarker(content);
  if (kind === 'run-log') return runLogMarker(content);
  throw new TypeError(`unsupported mutation target kind: ${kind}`);
}

function markerSyntaxPresent(kind, content) {
  if (kind === 'report') return content.includes('<!-- scout-mutation:');
  if (kind === 'tracker' || kind === 'json') {
    const value = JSON.parse(content);
    return Boolean(value && typeof value === 'object' && Object.hasOwn(value, '_scoutMutation'));
  }
  if (kind === 'run-log') {
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return false;
    const value = JSON.parse(lines.at(-1));
    return Boolean(value && typeof value === 'object' && Object.hasOwn(value, '_scoutMutation'));
  }
  return false;
}

function validateCurrentMarker(kind, content, targetPath) {
  let marker;
  try {
    marker = markerFor(kind, content);
  } catch (error) {
    throw new MutationConflictError(`mutation target is unverifiable: ${targetPath}: ${error.message}`);
  }
  if ((marker !== null || markerSyntaxPresent(kind, content)) && !exactMarker(marker)) {
    throw new MutationConflictError(`mutation target marker is unverifiable: ${targetPath}`);
  }
}

function embedMarker(kind, content, marker) {
  if (kind === 'tracker' || kind === 'json') return embedTrackerMutationMarker(content, marker);
  if (kind === 'report') return embedReportMarker(content, marker);
  if (kind === 'run-log') return embedRunLogMarker(content, marker);
  throw new TypeError(`unsupported mutation target kind: ${kind}`);
}

function validatePrivateValues(value, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (CREDENTIAL_VALUE.test(value)) throw new TypeError('mutation content contains credential-shaped data');
    if (TRANSIENT_TRACKING_VALUE.test(value)) throw new TypeError('mutation content contains transient tracking data');
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw new TypeError('mutation content must be acyclic JSON');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validatePrivateValues(item, seen);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('mutation content must use plain JSON objects');
    }
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_CONTENT_KEY.test(key)) throw new TypeError(`private mutation content property is not allowed: ${key}`);
      validatePrivateValues(item, seen);
    }
  }
  seen.delete(value);
}

function validateMutationContent(kind, content) {
  if (content.includes('<!-- scout-mutation:')) throw new TypeError('mutation content already contains a receipt marker');
  if (kind === 'report') {
    validatePrivateValues(content);
    return;
  }
  if (kind === 'run-log') {
    for (const line of content.split(/\r?\n/).filter(Boolean)) validatePrivateValues(JSON.parse(line));
    return;
  }
  validatePrivateValues(JSON.parse(content));
}

function exactMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== [...MARKER_KEYS].sort().join(',')
    || value.schemaVersion !== MUTATION_SCHEMA_VERSION
    || !SAFE_ID.test(value.mutationId || '')) return false;
  for (const key of ['mutationKey', 'runKey', 'intendedDigest', 'targetKey']) {
    if (!SHA256.test(value[key] || '')) return false;
  }
  return true;
}

function sameMarker(actual, expected) {
  return exactMarker(actual) && stableJson(actual) === stableJson(expected);
}

function artifactFile(handle, mutationId) {
  return path.join(handle.directory, 'mutations', `${mutationId}.json`);
}

function attachRuntime(plan, handle) {
  Object.defineProperties(plan, {
    root: { value: handle.root, enumerable: false },
    handle: { value: handle, enumerable: false },
  });
  return Object.freeze(plan);
}

function readPreparedArtifact(handle, mutationId) {
  const file = artifactFile(handle, mutationId);
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new MutationConflictError(`prepared mutation artifact is unavailable: ${error.message}`);
  }
  if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype
    || Object.keys(envelope).sort().join(',') !== 'digest,schemaVersion,value'
    || envelope.schemaVersion !== MUTATION_SCHEMA_VERSION
    || !SHA256.test(envelope.digest || '')
    || canonicalDigest(envelope.value) !== envelope.digest
    || envelope.value?.mutationId !== mutationId) {
    throw new MutationConflictError('prepared mutation artifact is unverifiable');
  }
  return { plan: attachRuntime(envelope.value, handle), digest: envelope.digest };
}

function readJournalledPreparedArtifact(handle, mutationId) {
  const prepared = replayRunJournal(handle.file).find((event) => (
    event.type === 'mutation.prepared'
    && event.payload?.reference?.kind === 'mutation'
    && event.payload.reference.id === mutationId
  ));
  if (!prepared) throw new MutationConflictError('prepared mutation has no journal authority');
  const artifact = readPreparedArtifact(handle, mutationId);
  if (artifact.digest !== prepared.payload.digest
    || artifact.plan.targetRevision !== prepared.payload.targetRevision) {
    throw new MutationConflictError('prepared mutation journal digest conflicts with its artifact');
  }
  return artifact;
}

export function loadPreparedMutation(handle, mutationId) {
  requireId(mutationId, 'mutation ID');
  return readJournalledPreparedArtifact(handle, mutationId).plan;
}

function validateTarget(target) {
  if (!target || Object.getPrototypeOf(target) !== Object.prototype
    || !Array.isArray(target.files) || !target.files.length
    || target.schemaVersion !== MUTATION_SCHEMA_VERSION) {
    throw new TypeError('mutation target is invalid');
  }
  requireId(target.id, 'mutation target ID');
}

export function prepareMutation(run, target, content) {
  const { handle, lease } = mutationContext(run);
  validateTarget(target);
  if (!content || Object.getPrototypeOf(content) !== Object.prototype) {
    throw new TypeError('mutation content map is required');
  }
  const paths = new Set();
  const intended = target.files.map((descriptor) => {
    if (!descriptor || Object.getPrototypeOf(descriptor) !== Object.prototype
      || !['tracker', 'report', 'run-log', 'json'].includes(descriptor.kind)) {
      throw new TypeError('mutation target file is invalid');
    }
    const relative = relativeTargetPath(handle.root, descriptor.path);
    if (paths.has(relative)) throw new TypeError('mutation target path is duplicated');
    paths.add(relative);
    if (typeof content[relative] !== 'string') throw new TypeError(`mutation content is missing: ${relative}`);
    validateMutationContent(descriptor.kind, content[relative]);
    const current = fileContent(handle.root, relative);
    validateCurrentMarker(descriptor.kind, current, relative);
    return {
      kind: descriptor.kind,
      path: relative,
      targetRevision: trackerRevision(current),
      intendedContent: content[relative],
      intendedDigest: sha256(content[relative]),
    };
  });
  if (Object.keys(content).sort().join(',') !== [...paths].sort().join(',')) {
    throw new TypeError('mutation content does not match its target files');
  }
  const targetRevision = canonicalDigest(intended.map(({ path: file, targetRevision: revision }) => ({ path: file, revision })));
  const intendedDigest = canonicalDigest(intended.map(({ path: file, intendedDigest: digest }) => ({ path: file, digest })));
  const key = canonicalDigest({
    schemaVersion: MUTATION_SCHEMA_VERSION,
    runId: handle.runId,
    target: {
      id: target.id,
      schemaVersion: target.schemaVersion,
      files: intended.map(({ kind, path: file, targetRevision: revision }) => ({ kind, path: file, revision })),
    },
    targetRevision,
    intendedDigest,
  });
  const mutationId = `mutation-${key.slice(0, 40)}`;
  const runKey = sha256(handle.runId);
  const files = intended.map((entry) => {
    const marker = {
      schemaVersion: MUTATION_SCHEMA_VERSION,
      mutationId,
      mutationKey: key,
      runKey,
      intendedDigest: entry.intendedDigest,
      targetKey: sha256(entry.path),
    };
    const preparedContent = embedMarker(entry.kind, entry.intendedContent, marker);
    return {
      ...entry,
      marker,
      preparedContent,
      writtenDigest: sha256(preparedContent),
    };
  });
  const planValue = {
    schemaVersion: MUTATION_SCHEMA_VERSION,
    runId: handle.runId,
    mutationId,
    key,
    target: { id: target.id, schemaVersion: target.schemaVersion },
    targetRevision,
    intendedDigest,
    receiptDigest: canonicalDigest(files.map(({ path: file, writtenDigest: digest }) => ({ path: file, digest }))),
    files,
  };
  const encoded = `${stableJson(planValue)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_MUTATION_BYTES) {
    throw new TypeError('prepared mutation exceeds the 16 MiB limit');
  }
  const digest = canonicalDigest(planValue);
  const envelope = `${stableJson({
    schemaVersion: MUTATION_SCHEMA_VERSION,
    digest,
    value: planValue,
  })}\n`;

  assertCurrentFence(lease, synchronousFenceCallback(() => {
    atomicWriteFile(artifactFile(handle, mutationId), envelope, { mode: 0o600 });
    const verified = readPreparedArtifact(handle, mutationId);
    if (verified.digest !== digest) throw new MutationConflictError('prepared mutation artifact digest changed');
  }));
  appendRunEvent(handle, {
    type: 'mutation.prepared',
    stageId: 'finalise',
    idempotencyKey: `${mutationId}-prepared`,
    payload: {
      schemaVersion: MUTATION_SCHEMA_VERSION,
      reference: { kind: 'mutation', id: mutationId },
      digest,
      targetRevision,
    },
  }, lease);
  return readJournalledPreparedArtifact(handle, mutationId).plan;
}

function targetState(plan, target) {
  const current = fileContent(plan.root, target.path);
  let marker = null;
  try {
    marker = markerFor(target.kind, current);
  } catch (error) {
    throw new MutationConflictError(`mutation target is unverifiable: ${target.path}: ${error.message}`);
  }
  const hasMarker = marker !== null || markerSyntaxPresent(target.kind, current);
  if (hasMarker) {
    if (!sameMarker(marker, target.marker) || sha256(current) !== target.writtenDigest) {
      if (sha256(current) === target.targetRevision) return 'pending';
      throw new MutationConflictError(`mutation target identity or digest conflicts: ${target.path}`);
    }
    return 'applied';
  }
  if (sha256(current) === target.targetRevision) return 'pending';
  throw new MutationConflictError(`mutation target revision conflicts: ${target.path}`);
}

function matchingReceipt(plan) {
  const events = replayRunJournal(plan.handle.file);
  const matches = events.filter((event) => event.type === 'mutation.receipted'
    && event.payload?.reference?.id === plan.mutationId);
  if (matches.some((event) => event.payload.digest !== plan.receiptDigest)) {
    throw new MutationConflictError('mutation receipt conflicts with the prepared plan');
  }
  return matches.at(-1) ?? null;
}

export function reconcileMutation(plan) {
  if (!plan?.handle || !Array.isArray(plan.files)) throw new TypeError('prepared mutation plan is required');
  const durable = readJournalledPreparedArtifact(plan.handle, plan.mutationId);
  if (durable.digest !== canonicalDigest(plan)) {
    throw new MutationConflictError('prepared mutation plan differs from its durable artifact');
  }
  const states = plan.files.map((target) => targetState(plan, target));
  const receipt = matchingReceipt(plan);
  if (receipt && states.some((state) => state !== 'applied')) {
    throw new MutationConflictError('mutation receipt exists without matching target content');
  }
  const status = receipt ? 'receipted'
    : states.every((state) => state === 'applied') ? 'applied-unreceipted'
      : states.every((state) => state === 'pending') ? 'prepared' : 'partially-applied';
  return Object.freeze({ status, states: Object.freeze(states), receipt });
}

function guardDirectory(root) {
  return path.join(root, '.scout', MUTATION_GUARD);
}

function readGuard(directory) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== 'coordinatorId,fencingGeneration,leaseId,schemaVersion'
      || value.schemaVersion !== MUTATION_SCHEMA_VERSION
      || !SAFE_ID.test(value.coordinatorId || '')
      || !SAFE_ID.test(value.leaseId || '')
      || !Number.isSafeInteger(value.fencingGeneration)
      || value.fencingGeneration < 1) {
      throw new Error('invalid coordinator metadata');
    }
    return value;
  } catch (error) {
    throw new MutationCoordinatorBusyError(`workspace mutation coordinator is unverifiable: ${error.message}`);
  }
}

function createGuard(root, lease) {
  const directory = guardDirectory(root);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const coordinatorId = randomUUID();
  const metadata = {
    schemaVersion: MUTATION_SCHEMA_VERSION,
    coordinatorId,
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
  };
  const acquire = () => {
    fs.mkdirSync(directory);
    atomicWriteFile(path.join(directory, 'owner.json'), `${stableJson(metadata)}\n`, { mode: 0o600 });
  };
  try {
    acquire();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readGuard(directory);
    if (Number.isSafeInteger(existing?.fencingGeneration)
      && existing.fencingGeneration < lease.generation) {
      fs.renameSync(directory, `${directory}.quarantine.${randomUUID()}`);
      acquire();
    } else {
      throw new MutationCoordinatorBusyError();
    }
  }
  return { directory, metadata };
}

function releaseGuard(guard) {
  const current = readGuard(guard.directory);
  if (stableJson(current) !== stableJson(guard.metadata)) {
    throw new MutationCoordinatorBusyError('workspace mutation coordinator ownership changed');
  }
  fs.unlinkSync(path.join(guard.directory, 'owner.json'));
  fs.rmdirSync(guard.directory);
}

function assertFence(lease) {
  return assertCurrentFence(lease, synchronousFenceCallback(() => true));
}

export function withMutationCoordinator(root, lease, commit) {
  if (typeof commit !== 'function' || commit.constructor?.name === 'AsyncFunction') {
    throw new TypeError('workspace mutation coordinator callback must be synchronous');
  }
  assertScanLeaseScope(lease, root, lease?.runId);
  assertFence(lease);
  const guard = createGuard(root, lease);
  try {
    assertFence(lease);
    return commit();
  } finally {
    releaseGuard(guard);
  }
}

export function applyPreparedMutation(plan, lease, hooks = {}) {
  if (!plan?.handle || !Array.isArray(plan.files)) throw new TypeError('prepared mutation plan is required');
  assertScanLeaseScope(lease, plan.root, plan.runId, plan.handle.directory, plan.handle.file);
  const durable = readJournalledPreparedArtifact(plan.handle, plan.mutationId);
  if (durable.digest !== canonicalDigest(plan)) {
    throw new MutationConflictError('prepared mutation plan differs from its durable artifact');
  }

  return withMutationCoordinator(plan.root, lease, () => {
    for (const target of plan.files) {
      if (targetState(plan, target) === 'applied') continue;
      assertCurrentFence(lease, synchronousFenceCallback(() => {
        if (targetState(plan, target) === 'applied') return;
        hooks.beforeReplacement?.(target);
        const file = path.join(plan.root, ...target.path.split('/'));
        atomicWriteFile(file, target.preparedContent);
        hooks.afterReplacement?.(target);
        if (targetState(plan, target) !== 'applied') {
          throw new MutationConflictError(`mutation target verification failed: ${target.path}`);
        }
      }));
    }

    const reconciled = reconcileMutation(plan);
    if (reconciled.status === 'receipted') {
      return Object.freeze({
        schemaVersion: MUTATION_SCHEMA_VERSION,
        id: plan.mutationId,
        digest: plan.receiptDigest,
      });
    }
    if (reconciled.status !== 'applied-unreceipted') {
      throw new MutationConflictError('mutation target set is not fully applied');
    }
    hooks.beforeReceipt?.();
    appendRunEvent(plan.handle, {
      type: 'mutation.receipted',
      stageId: 'finalise',
      idempotencyKey: `${plan.mutationId}-receipted`,
      payload: {
        schemaVersion: MUTATION_SCHEMA_VERSION,
        reference: { kind: 'mutation', id: plan.mutationId },
        digest: plan.receiptDigest,
      },
    }, lease);
    if (reconcileMutation(plan).status !== 'receipted') {
      throw new MutationConflictError('mutation receipt verification failed');
    }
    return Object.freeze({
      schemaVersion: MUTATION_SCHEMA_VERSION,
      id: plan.mutationId,
      digest: plan.receiptDigest,
    });
  });
}
