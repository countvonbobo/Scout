import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { validateRunJournal } from './runJournal.mjs';

export const RUN_ARTIFACT_SCHEMA_VERSION = 1;
export const RUN_MANIFEST_SCHEMA_VERSION = 1;

const MAX_ARTIFACT_BYTES = 16 * 1024;
const MAX_STABLE_IDS = 128;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class ArtifactIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArtifactIntegrityError';
  }
}

export class ManifestAgreementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManifestAgreementError';
  }
}

function stableJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('artifact values must be finite JSON values');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('artifact values must be plain JSON objects');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function requireSafeToken(value, name, ErrorType = TypeError) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) throw new ErrorType(`${name} must be a bounded identifier`);
  return value;
}

function requireRunDirectory(value, ErrorType = TypeError) {
  if (typeof value !== 'string' || !value) throw new ErrorType('run directory is required');
  return path.resolve(value);
}

function validateArtifactValue(descriptor, value, ErrorType = TypeError) {
  if (descriptor.schemaVersion !== RUN_ARTIFACT_SCHEMA_VERSION) throw new ErrorType(`unsupported artifact schema version: ${descriptor.schemaVersion}`);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ErrorType('artifact value must be an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'schemaVersion,stableIds' || value.schemaVersion !== RUN_ARTIFACT_SCHEMA_VERSION
    || !Array.isArray(value.stableIds) || value.stableIds.length > MAX_STABLE_IDS) {
    throw new ErrorType('artifact value is not supported by schema version 1');
  }
  for (const id of value.stableIds) requireSafeToken(id, 'artifact stable ID', ErrorType);
  const encoded = stableJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ARTIFACT_BYTES) throw new ErrorType('artifact exceeds the 16 KiB limit');
  return encoded;
}

function validateDescriptor(descriptor, ErrorType = TypeError) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || Object.keys(descriptor).sort().join(',') !== 'id,schemaVersion') {
    throw new ErrorType('artifact descriptor is invalid');
  }
  return {
    id: requireSafeToken(descriptor.id, 'artifact ID', ErrorType),
    schemaVersion: descriptor.schemaVersion,
  };
}

function artifactPath(directory, ref) {
  // The immutable key includes all identity fields. It keeps valid journal IDs
  // portable across Windows and POSIX filesystems without accepting a
  // caller-controlled path segment or replacing an earlier digest.
  const key = stableJson({ id: ref.id, schemaVersion: ref.schemaVersion, digest: ref.digest });
  return path.join(directory, 'artifacts', `${createHash('sha256').update(key).digest('hex')}.json`);
}

function legacyArtifactPath(directory, ref) {
  return path.join(directory, 'artifacts', `${createHash('sha256').update(ref.id).digest('hex')}.json`);
}

function referenceFor(directory, descriptor, value) {
  const ref = { id: descriptor.id, schemaVersion: descriptor.schemaVersion, digest: sha256(value) };
  Object.defineProperty(ref, 'directory', { value: directory, enumerable: false });
  return ref;
}

function directoryForReference(ref, ErrorType = ArtifactIntegrityError) {
  return requireRunDirectory(ref?.directory ?? ref?.run?.directory, ErrorType);
}

function validateReference(ref, ErrorType = ArtifactIntegrityError) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new ErrorType('artifact reference is invalid');
  const descriptor = validateDescriptor({ id: ref.id, schemaVersion: ref.schemaVersion }, ErrorType);
  if (typeof ref.digest !== 'string' || !SHA256.test(ref.digest)) throw new ErrorType('artifact reference digest is invalid');
  if (descriptor.schemaVersion !== RUN_ARTIFACT_SCHEMA_VERSION) throw new ErrorType(`unsupported artifact schema version: ${descriptor.schemaVersion}`);
  return descriptor;
}

export function commitRunArtifact(run, descriptor, value) {
  const directory = requireRunDirectory(run?.directory);
  const checked = validateDescriptor(descriptor);
  const encoded = validateArtifactValue(checked, value);
  const ref = referenceFor(directory, checked, value);
  const stored = {
    storageSchemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    id: ref.id,
    schemaVersion: ref.schemaVersion,
    digest: ref.digest,
    value,
  };
  atomicWriteFile(artifactPath(directory, ref), `${stableJson(stored)}\n`, { mode: 0o600 });
  // Keep the validation close to the commit boundary: an acknowledged ref is
  // never returned for an unflushed, malformed, or digest-mismatched artifact.
  if (encoded !== stableJson(value)) throw new ArtifactIntegrityError('artifact encoding changed during commit');
  return ref;
}

export function readRunArtifact(ref) {
  const descriptor = validateReference(ref);
  const directory = directoryForReference(ref);
  const file = artifactPath(directory, ref);
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new ArtifactIntegrityError(`artifact cannot be read: ${error.message}`);
    try {
      contents = fs.readFileSync(legacyArtifactPath(directory, ref), 'utf8');
    } catch (legacyError) {
      throw new ArtifactIntegrityError(`artifact cannot be read: ${legacyError.message}`);
    }
  }
  let stored;
  try {
    stored = JSON.parse(contents);
  } catch (error) {
    throw new ArtifactIntegrityError(`artifact cannot be read: ${error.message}`);
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)
    || Object.keys(stored).sort().join(',') !== 'digest,id,schemaVersion,storageSchemaVersion,value'
    || stored.storageSchemaVersion !== RUN_ARTIFACT_SCHEMA_VERSION
    || stored.id !== descriptor.id || stored.schemaVersion !== descriptor.schemaVersion || stored.digest !== ref.digest) {
    throw new ArtifactIntegrityError('artifact envelope is invalid');
  }
  try {
    validateArtifactValue(descriptor, stored.value, ArtifactIntegrityError);
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) throw error;
    throw new ArtifactIntegrityError(error.message);
  }
  if (sha256(stored.value) !== ref.digest) throw new ArtifactIntegrityError('artifact digest does not match its reference');
  return stored.value;
}

function assertJournalEvents(events) {
  if (!Array.isArray(events)) throw new ManifestAgreementError('journal events are required');
  let runId = null;
  let previousHash = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== 'object' || Array.isArray(event) || event.sequence !== index + 1
      || typeof event.runId !== 'string' || !event.runId || event.runId !== (runId ?? event.runId)
      || event.previousHash !== previousHash || typeof event.eventHash !== 'string' || !SHA256.test(event.eventHash)) {
      throw new ManifestAgreementError('journal events are not a validated sequence');
    }
    runId = event.runId;
    previousHash = event.eventHash;
  }
  return { runId, lastHash: previousHash };
}

function addArtifact(artifacts, artifact) {
  if (!artifact) return;
  const value = { id: artifact.id, schemaVersion: artifact.schemaVersion, digest: artifact.digest };
  const existing = artifacts.find((candidate) => candidate.id === value.id);
  if (existing && stableJson(existing) !== stableJson(value)) throw new ManifestAgreementError('journal gives an artifact ID conflicting references');
  if (!existing) artifacts.push(value);
}

export function projectRunManifest(events) {
  const { runId, lastHash } = assertJournalEvents(events);
  const artifacts = [];
  const compatibility = {};
  const completedWork = [];
  const receipts = [];
  let outcome = 'in-progress';

  for (const event of events) {
    if (event.type === 'stage.completed') {
      const work = { sequence: event.sequence, stageId: event.stageId };
      for (const key of ['reference', 'count', 'version', 'artifact']) {
        if (event.payload?.[key] !== undefined) work[key] = event.payload[key];
      }
      completedWork.push(work);
      if (event.payload?.version) compatibility[event.payload.version.kind] = event.payload.version.value;
      addArtifact(artifacts, event.payload?.artifact);
    } else if (event.type === 'run.completed') {
      outcome = event.payload?.outcome;
      if (event.payload?.compatibility) compatibility[event.payload.compatibility.kind] = event.payload.compatibility.value;
    } else if (event.type === 'mutation.receipted') {
      receipts.push({ sequence: event.sequence, stageId: event.stageId, reference: event.payload?.reference, digest: event.payload?.digest });
    }
  }

  return {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runId,
    lastValidatedSequence: events.length,
    lastValidatedHash: lastHash,
    outcome,
    compatibility,
    completedWork,
    artifacts,
    receipts,
  };
}

function manifestFile(run) {
  return path.join(requireRunDirectory(run?.directory, ManifestAgreementError), 'manifest.json');
}

export function replaceRunManifest(run, manifest) {
  const directory = requireRunDirectory(run?.directory, ManifestAgreementError);
  const state = validateRunJournal(run?.file);
  const expected = projectRunManifest(state.events);
  if (!manifestsMatch(manifest, expected)) {
    throw new ManifestAgreementError('manifest does not agree with the validated journal');
  }
  validateProjectedArtifacts(run, expected);
  const encoded = stableJson(expected);
  atomicWriteFile(path.join(directory, 'manifest.json'), `${encoded}\n`, { mode: 0o600 });
  return expected;
}

function manifestsMatch(actual, expected) {
  try {
    return stableJson(actual) === stableJson(expected);
  } catch {
    return false;
  }
}

function validateProjectedArtifacts(run, manifest) {
  for (const artifact of manifest.artifacts) readRunArtifact({ ...artifact, directory: run.directory });
}

export function validateManifestAgreement(run) {
  if (!run || typeof run !== 'object') throw new ManifestAgreementError('run is required');
  const state = validateRunJournal(run.file);
  const expected = projectRunManifest(state.events);
  validateProjectedArtifacts(run, expected);
  const file = manifestFile(run);
  if (!fs.existsSync(file)) {
    replaceRunManifest(run, expected);
    return { manifest: expected, rebuilt: true };
  }
  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ManifestAgreementError(`manifest cannot be read: ${error.message}`);
  }
  if (manifestsMatch(actual, expected)) return { manifest: expected, rebuilt: false };

  const sequence = actual?.lastValidatedSequence;
  if (Number.isSafeInteger(sequence) && sequence >= 0 && sequence < state.events.length
    && manifestsMatch(actual, projectRunManifest(state.events.slice(0, sequence)))) {
    replaceRunManifest(run, expected);
    return { manifest: expected, rebuilt: true };
  }
  throw new ManifestAgreementError('manifest does not agree with the validated journal');
}
