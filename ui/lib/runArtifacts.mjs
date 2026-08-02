import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { RECOVERABLE_PIPELINE_STAGES, recoveryRequirementsForStage } from './pipeline.mjs';
import { validateRunJournal } from './runJournal.mjs';
import {
  LeaseLostError, assertCurrentFence, assertScanLeaseScope, isScanLease,
  synchronousFenceCallback,
} from './scanLease.mjs';

export const RUN_ARTIFACT_SCHEMA_VERSION = 1;
export const PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION = 2;
export const ASSESSMENT_ARTIFACT_SCHEMA_VERSION = 3;
export const RUN_MANIFEST_SCHEMA_VERSION = 3;

const MAX_LEGACY_ARTIFACT_BYTES = 16 * 1024;
const MAX_PIPELINE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_ASSESSMENT_ARTIFACT_BYTES = 256 * 1024;
const MAX_STABLE_IDS = 128;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PRIVATE_PIPELINE_KEYS = /^(?:access[-_]?token|advert[-_]?body|api[-_]?(?:key|token)|auth(?:orization)?|body|cookies?|credentials?|cv|description|headers?|html|master[-_]?cv|password|payload|profile[-_]?evidence|prompt|raw[-_]?(?:html|response)|requirements?|response|secret(?:[-_]?(?:key|token))?|token|transcript)$/i;
const PRIVATE_ASSESSMENT_KEYS = /^(?:access[-_]?token|advert[-_]?body|api[-_]?(?:key|token)|auth(?:orization)?|body|cookies?|credentials?|cv|headers?|html|master[-_]?cv|password|prompt|raw[-_]?(?:html|response)|response|secret(?:[-_]?(?:key|token))?|token|transcript)$/i;
const CREDENTIAL_VALUE = /(?:\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)|(?:\b(?:api[-_ ]?key|authorization|password|secret|session[-_ ]?id|token)\s*[:=]\s*\S+)|(?:\bbearer\s+[A-Za-z0-9._~+/-]{8,})|(?:\bsk-[A-Za-z0-9_-]{16,})|(?:\bgh[pousr]_[A-Za-z0-9]{20,})|(?:\bxox[baprs]-[A-Za-z0-9-]{10,})|(?:\bAKIA[0-9A-Z]{16}\b)/i;
const URL_VALUE = /\bhttps?:\/\/\S+/i;
const ASSESSMENT_ARTIFACT_TYPES = new Set(['request', 'result', 'failure', 'batch']);
const ASSESSMENT_DATA_KEYS = Object.freeze({
  request: Object.freeze(['request']),
  result: Object.freeze([
    'assessment', 'batchId', 'fencingGeneration', 'inputDigest', 'jobId', 'provenance',
  ]),
  failure: Object.freeze([
    'attempts', 'batchId', 'code', 'fencingGeneration', 'inputDigest', 'jobId', 'validationFailures',
  ]),
  batch: Object.freeze([
    'batchId', 'completedJobIds', 'failedJobIds', 'fencingGeneration', 'provenance',
  ]),
});

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

function validatePipelineData(value, ErrorType, seen = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ErrorType('pipeline artifact values must be finite JSON values');
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw new ErrorType('pipeline artifact data must be acyclic JSON');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validatePipelineData(item, ErrorType, seen);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new ErrorType('pipeline artifact data must use plain JSON objects');
    }
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_PIPELINE_KEYS.test(key)) {
        throw new ErrorType(`private pipeline artifact property is not allowed: ${key}`);
      }
      validatePipelineData(item, ErrorType, seen);
    }
  }
  seen.delete(value);
}

function validateAssessmentData(value, ErrorType, seen = new Set()) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ErrorType('assessment artifact values must be finite JSON values');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 2_000) throw new ErrorType('assessment artifact strings must be bounded');
    if (CREDENTIAL_VALUE.test(value)) throw new ErrorType('assessment artifact credentials are not allowed');
    if (URL_VALUE.test(value)) throw new ErrorType('assessment artifact URLs are not allowed');
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw new ErrorType('assessment artifact data must be acyclic JSON');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 128) throw new ErrorType('assessment artifact arrays must be bounded');
    for (const item of value) validateAssessmentData(item, ErrorType, seen);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new ErrorType('assessment artifact data must use plain JSON objects');
    }
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_ASSESSMENT_KEYS.test(key)) {
        throw new ErrorType(`private assessment artifact property is not allowed: ${key}`);
      }
      validateAssessmentData(item, ErrorType, seen);
    }
  }
  seen.delete(value);
}

function validateAssessmentArtifactData(type, value, ErrorType) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(',') !== [...ASSESSMENT_DATA_KEYS[type]].sort().join(',')) {
    throw new ErrorType(`assessment ${type} artifact shape is invalid`);
  }
  validateAssessmentData(value, ErrorType);
  if (type !== 'request') {
    requireSafeToken(value.batchId, 'assessment batch ID', ErrorType);
    if (!Number.isSafeInteger(value.fencingGeneration) || value.fencingGeneration < 1) {
      throw new ErrorType('assessment artifact fencing generation is invalid');
    }
  }
  if (type === 'result' || type === 'failure') {
    requireSafeToken(value.jobId, 'assessment job ID', ErrorType);
    if (typeof value.inputDigest !== 'string' || !SHA256.test(value.inputDigest)) {
      throw new ErrorType('assessment artifact input digest is invalid');
    }
  }
}

function validateArtifactValue(descriptor, value, ErrorType = TypeError) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ErrorType('artifact value must be an object');
  }
  const keys = Object.keys(value).sort();
  if (descriptor.schemaVersion === RUN_ARTIFACT_SCHEMA_VERSION) {
    if (keys.join(',') !== 'schemaVersion,stableIds' || value.schemaVersion !== RUN_ARTIFACT_SCHEMA_VERSION) {
      throw new ErrorType('artifact value is not supported by schema version 1');
    }
  } else if (descriptor.schemaVersion === PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION) {
    if (keys.join(',') !== 'data,schemaVersion,stableIds,stageId'
      || value.schemaVersion !== PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION) {
      throw new ErrorType('artifact value is not supported by schema version 2');
    }
    requireSafeToken(value.stageId, 'artifact stage ID', ErrorType);
    validatePipelineData(value.data, ErrorType);
  } else if (descriptor.schemaVersion === ASSESSMENT_ARTIFACT_SCHEMA_VERSION) {
    if (keys.join(',') !== 'data,schemaVersion,stableIds,type'
      || value.schemaVersion !== ASSESSMENT_ARTIFACT_SCHEMA_VERSION
      || !ASSESSMENT_ARTIFACT_TYPES.has(value.type)) {
      throw new ErrorType('artifact value is not supported by schema version 3');
    }
    validateAssessmentArtifactData(value.type, value.data, ErrorType);
  } else {
    throw new ErrorType(`unsupported artifact schema version: ${descriptor.schemaVersion}`);
  }
  if (!Array.isArray(value.stableIds) || value.stableIds.length > MAX_STABLE_IDS) {
    throw new ErrorType(`artifact value is not supported by schema version ${descriptor.schemaVersion}`);
  }
  for (const id of value.stableIds) requireSafeToken(id, 'artifact stable ID', ErrorType);
  const encoded = stableJson(value);
  const maximum = descriptor.schemaVersion === RUN_ARTIFACT_SCHEMA_VERSION
    ? MAX_LEGACY_ARTIFACT_BYTES
    : descriptor.schemaVersion === PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION
      ? MAX_PIPELINE_ARTIFACT_BYTES
      : MAX_ASSESSMENT_ARTIFACT_BYTES;
  if (Buffer.byteLength(encoded, 'utf8') > maximum) {
    const label = maximum === MAX_LEGACY_ARTIFACT_BYTES ? '16 KiB'
      : maximum === MAX_PIPELINE_ARTIFACT_BYTES ? '16 MiB' : '256 KiB';
    throw new ErrorType(`artifact exceeds the ${label} limit`);
  }
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

function commitWithFence(run, lease, commit) {
  if (!isScanLease(lease)) throw new LeaseLostError('a genuine current scan lease is required to commit an artifact');
  assertScanLeaseScope(lease, run?.root, run?.runId, run?.directory, run?.file);
  return assertCurrentFence(lease, synchronousFenceCallback(commit));
}

function directoryForReference(ref, ErrorType = ArtifactIntegrityError) {
  return requireRunDirectory(ref?.directory ?? ref?.run?.directory, ErrorType);
}

function validateReference(ref, ErrorType = ArtifactIntegrityError) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new ErrorType('artifact reference is invalid');
  const descriptor = validateDescriptor({ id: ref.id, schemaVersion: ref.schemaVersion }, ErrorType);
  if (typeof ref.digest !== 'string' || !SHA256.test(ref.digest)) throw new ErrorType('artifact reference digest is invalid');
  if (![RUN_ARTIFACT_SCHEMA_VERSION, PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION, ASSESSMENT_ARTIFACT_SCHEMA_VERSION].includes(descriptor.schemaVersion)) {
    throw new ErrorType(`unsupported artifact schema version: ${descriptor.schemaVersion}`);
  }
  return descriptor;
}

export function commitRunArtifact(run, descriptor, value, lease) {
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
  return commitWithFence(run, lease, () => {
    atomicWriteFile(artifactPath(directory, ref), `${stableJson(stored)}\n`, { mode: 0o600 });
    // Keep the validation close to the commit boundary: an acknowledged ref is
    // never returned for an unflushed, malformed, or digest-mismatched artifact.
    if (encoded !== stableJson(value)) throw new ArtifactIntegrityError('artifact encoding changed during commit');
    return ref;
  });
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

const RECOVERY_REASON_FOR_FIELD = Object.freeze({
  stageArtifactSchemaVersion: 'stage-artifact-schema-mismatch',
  scheduleJobId: 'schedule-job-mismatch',
  logicalWindowId: 'logical-window-mismatch',
  rankingVersion: 'ranking-version-mismatch',
  promptVersion: 'prompt-version-mismatch',
  assessmentSchemaVersion: 'assessment-schema-version-mismatch',
  mutationSchemaVersion: 'mutation-schema-version-mismatch',
  targetRevision: 'target-revision-mismatch',
});
const HARD_RECOVERY_REQUIREMENTS = Object.freeze([
  'mode',
  'purpose',
  'profileVersion',
  'sourceConfigFingerprint',
  'journalSchemaVersion',
  'artifactSchemaVersion',
  'stageArtifactSchemaVersion',
  'pipelineVersion',
  'scheduleJobId',
  'logicalWindowId',
]);

function expectedAtomicRecoveryPlan(completedByStage, prior, requested, substitution) {
  if (HARD_RECOVERY_REQUIREMENTS.some((field) => prior[field] !== requested[field])) {
    throw new ManifestAgreementError('journal recovery plan changes an incompatible run requirement');
  }
  const provenanceChanged = prior.provider !== requested.provider || prior.model !== requested.model;
  if (provenanceChanged) {
    const expected = {
      previousProvider: prior.provider,
      previousModel: prior.model,
      nextProvider: requested.provider,
      nextModel: requested.model,
    };
    if (!substitution || stableJson(substitution) !== stableJson(expected)) {
      throw new ManifestAgreementError('journal recovery plan lacks exact provider substitution provenance');
    }
  } else if (substitution !== null) {
    throw new ManifestAgreementError('journal recovery plan has an unnecessary provider substitution');
  }

  const stages = [...completedByStage.values()]
    .sort((left, right) => RECOVERABLE_PIPELINE_STAGES.findIndex(({ id }) => id === left.stageId)
      - RECOVERABLE_PIPELINE_STAGES.findIndex(({ id }) => id === right.stageId))
    .map((work) => {
      let reason = null;
      if (work.stageId === 'assess' && provenanceChanged) {
        reason = 'provider-substituted';
      } else {
        for (const field of recoveryRequirementsForStage(work.stageId)) {
          if (prior[field] !== requested[field]) {
            reason = RECOVERY_REASON_FOR_FIELD[field] ?? `${field}-mismatch`;
            break;
          }
        }
      }
      reason ??= work.artifact ? 'compatible' : 'artifact-reference-missing';
      return {
        stageId: work.stageId,
        action: reason === 'compatible' ? 'reuse' : 'restart',
        reason,
        ...(work.artifact ? { artifact: work.artifact } : {}),
      };
    });
  const firstRestart = stages.findIndex(({ action }) => action === 'restart');
  if (firstRestart !== -1) {
    for (let index = firstRestart + 1; index < stages.length; index += 1) {
      if (stages[index].action === 'reuse') {
        stages[index] = { ...stages[index], action: 'restart', reason: 'upstream-stage-restarted' };
      }
    }
  }
  return stages;
}

export function projectRunManifest(events) {
  const { runId, lastHash } = assertJournalEvents(events);
  const artifacts = [];
  const compatibility = {};
  const completedByStage = new Map();
  const receipts = [];
  const receiptIdentities = new Set();
  const recoveryDecisions = [];
  const providerSubstitutions = [];
  const recoveryAttempts = [];
  const assessmentJobs = new Map();
  const assessmentBatches = new Map();
  const stageIndexes = new Map(RECOVERABLE_PIPELINE_STAGES.map((stage, index) => [stage.id, index]));
  const invalidatedByGeneration = new Map();
  const plannedByGeneration = new Map();
  let activeRecoveryGeneration = null;
  let activeRecoverySchema = null;
  let versionedRun = false;
  let outcome = 'in-progress';

  for (const event of events) {
    if (event.type === 'run.started') {
      versionedRun = true;
      Object.assign(compatibility, event.payload.compatibility);
    } else if (event.type === 'stage.completed') {
      const stageIndex = stageIndexes.get(event.stageId);
      if (versionedRun && stageIndex === undefined) {
        throw new ManifestAgreementError(`journal completed an unsupported recovery stage: ${event.stageId}`);
      }
      if (completedByStage.has(event.stageId)) {
        throw new ManifestAgreementError(`journal completed stage more than once without restart: ${event.stageId}`);
      }
      const work = { sequence: event.sequence, stageId: event.stageId };
      for (const key of ['reference', 'count', 'version', 'artifact']) {
        if (event.payload?.[key] !== undefined) work[key] = event.payload[key];
      }
      completedByStage.set(event.stageId, work);
      if (event.payload?.version) compatibility[event.payload.version.kind] = event.payload.version.value;
    } else if (event.type === 'run.completed') {
      outcome = event.payload?.outcome;
      if (event.payload?.compatibility) compatibility[event.payload.compatibility.kind] = event.payload.compatibility.value;
    } else if (event.type === 'mutation.receipted') {
      const identity = event.payload?.reference?.id;
      if (event.payload?.reference?.kind !== 'mutation') {
        throw new ManifestAgreementError('journal mutation receipt reference kind is invalid');
      }
      if (receiptIdentities.has(identity)) {
        throw new ManifestAgreementError('journal contains a duplicate mutation receipt');
      }
      receiptIdentities.add(identity);
      receipts.push({ sequence: event.sequence, stageId: event.stageId, reference: event.payload?.reference, digest: event.payload?.digest });
    } else if (event.type.startsWith('assessment.')) {
      addArtifact(artifacts, event.payload?.artifact);
      if (event.type === 'assessment.job-completed' || event.type === 'assessment.job-failed') {
        assessmentJobs.set(event.payload.reference.id, {
          sequence: event.sequence,
          jobId: event.payload.reference.id,
          status: event.type === 'assessment.job-completed' ? 'completed' : 'failed',
          artifact: event.payload.artifact,
        });
      } else if (event.type === 'assessment.batch-completed') {
        assessmentBatches.set(event.payload.reference.id, {
          sequence: event.sequence,
          batchId: event.payload.reference.id,
          count: event.payload.count,
          artifact: event.payload.artifact,
        });
      }
    } else if (event.type === 'recovery.started') {
      const priorCompatibility = structuredClone(compatibility);
      if (event.payload.schemaVersion === 2) {
        const expectedPlan = expectedAtomicRecoveryPlan(
          completedByStage,
          priorCompatibility,
          event.payload.compatibility,
          event.payload.providerSubstitution,
        );
        if (stableJson(expectedPlan) !== stableJson(event.payload.decisions)) {
          throw new ManifestAgreementError('journal atomic recovery plan contradicts compatibility requirements');
        }
      }
      activeRecoveryGeneration = event.fencingGeneration;
      activeRecoverySchema = event.payload.schemaVersion;
      Object.assign(compatibility, event.payload.compatibility);
      const invalidated = new Map();
      invalidatedByGeneration.set(activeRecoveryGeneration, invalidated);
      recoveryAttempts.push({
        sequence: event.sequence,
        fencingGeneration: event.fencingGeneration,
        requestFingerprint: event.payload.requestFingerprint,
        selectionFingerprint: event.payload.selectionFingerprint,
      });
      if (activeRecoverySchema === 1) {
        for (const [stageId, work] of completedByStage) invalidated.set(stageId, work);
        completedByStage.clear();
      } else {
        const plans = new Map(event.payload.decisions.map((decision) => [decision.stageId, decision]));
        plannedByGeneration.set(activeRecoveryGeneration, plans);
        if (event.payload.providerSubstitution) {
          providerSubstitutions.push({ sequence: event.sequence, ...event.payload.providerSubstitution });
        }
        for (const planned of event.payload.decisions) {
          const current = completedByStage.get(planned.stageId);
          const expected = current ?? invalidated.get(planned.stageId);
          if (planned.artifact && (!expected?.artifact
            || stableJson(planned.artifact) !== stableJson(expected.artifact))) {
            throw new ManifestAgreementError('journal recovery plan artifact does not match current stage');
          }
          const decision = {
            sequence: event.sequence,
            stageId: planned.stageId,
            action: planned.action,
            reason: planned.reason,
            ...(planned.artifact ? { artifact: planned.artifact } : {}),
          };
          if (planned.action === 'reuse') {
            if (!current) throw new ManifestAgreementError('journal cannot reuse a stage without a current completion');
          } else {
            const stageIndex = stageIndexes.get(planned.stageId);
            if (stageIndex === undefined) throw new ManifestAgreementError('journal restarts an unsupported stage');
            if (!current && !invalidated.has(planned.stageId)) {
              throw new ManifestAgreementError('journal cannot restart a stage without a current completion');
            }
            for (const stage of RECOVERABLE_PIPELINE_STAGES.slice(stageIndex)) {
              const removed = completedByStage.get(stage.id);
              if (removed) {
                invalidated.set(stage.id, removed);
                completedByStage.delete(stage.id);
              }
            }
          }
          recoveryDecisions.push(decision);
        }
      }
    } else if (event.type === 'recovery.stage-decided') {
      const plans = plannedByGeneration.get(event.fencingGeneration);
      if (plans) {
        const planned = plans.get(event.stageId);
        const confirmation = {
          stageId: event.stageId,
          action: event.payload.action,
          reason: event.payload.reason,
          ...(event.payload.artifact ? { artifact: event.payload.artifact } : {}),
        };
        if (!planned || stableJson(planned) !== stableJson(confirmation)) {
          throw new ManifestAgreementError('journal recovery confirmation conflicts with its atomic plan');
        }
        continue;
      }
      const decision = {
        sequence: event.sequence,
        stageId: event.stageId,
        action: event.payload.action,
        reason: event.payload.reason,
      };
      if (event.payload.artifact) decision.artifact = event.payload.artifact;
      const current = completedByStage.get(event.stageId);
      const invalidated = invalidatedByGeneration.get(event.fencingGeneration) ?? new Map();
      const expected = current ?? invalidated.get(event.stageId);
      if (event.payload.artifact && (!expected?.artifact
        || stableJson(event.payload.artifact) !== stableJson(expected.artifact))) {
        throw new ManifestAgreementError('journal recovery decision artifact does not match current stage');
      }
      if (event.payload.action === 'reuse') {
        if (!current && expected) completedByStage.set(event.stageId, expected);
        else if (!current) throw new ManifestAgreementError('journal cannot reuse a stage without a current completion');
      } else {
        const stageIndex = stageIndexes.get(event.stageId);
        if (stageIndex === undefined) throw new ManifestAgreementError('journal restarts an unsupported stage');
        if (current) {
          for (const stage of RECOVERABLE_PIPELINE_STAGES.slice(stageIndex)) {
            const removed = completedByStage.get(stage.id);
            if (removed) {
              invalidated.set(stage.id, removed);
              completedByStage.delete(stage.id);
            }
          }
        } else if (!invalidated.has(event.stageId)) {
          throw new ManifestAgreementError('journal cannot restart a stage without a current completion');
        }
      }
      recoveryDecisions.push(decision);
    } else if (event.type === 'recovery.provider-substituted') {
      const planned = plannedByGeneration.get(event.fencingGeneration);
      if (planned) {
        const expected = events.find((candidate) => candidate.type === 'recovery.started'
          && candidate.fencingGeneration === event.fencingGeneration)?.payload.providerSubstitution;
        const actual = {
          previousProvider: event.payload.previousProvider,
          previousModel: event.payload.previousModel,
          nextProvider: event.payload.nextProvider,
          nextModel: event.payload.nextModel,
        };
        if (!expected || stableJson(expected) !== stableJson(actual)) {
          throw new ManifestAgreementError('journal provider confirmation conflicts with its atomic plan');
        }
        continue;
      }
      providerSubstitutions.push({
        sequence: event.sequence,
        previousProvider: event.payload.previousProvider,
        previousModel: event.payload.previousModel,
        nextProvider: event.payload.nextProvider,
        nextModel: event.payload.nextModel,
      });
      compatibility.provider = event.payload.nextProvider;
      compatibility.model = event.payload.nextModel;
    }
  }
  const completedWork = [...completedByStage.values()]
    .sort((left, right) => (
      (stageIndexes.get(left.stageId) ?? Number.MAX_SAFE_INTEGER)
      - (stageIndexes.get(right.stageId) ?? Number.MAX_SAFE_INTEGER)
    ));
  for (const work of completedWork) addArtifact(artifacts, work.artifact);

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
    recoveryDecisions,
    providerSubstitutions,
    recoveryAttempts,
    ...(assessmentJobs.size ? { assessmentJobs: [...assessmentJobs.values()] } : {}),
    ...(assessmentBatches.size ? { assessmentBatches: [...assessmentBatches.values()] } : {}),
  };
}

function manifestFile(run) {
  return path.join(requireRunDirectory(run?.directory, ManifestAgreementError), 'manifest.json');
}

export function replaceRunManifest(run, manifest, lease) {
  const directory = requireRunDirectory(run?.directory, ManifestAgreementError);
  return commitWithFence(run, lease, () => {
    const state = validateRunJournal(run?.file);
    const expected = projectRunManifest(state.events);
    if (!manifestsMatch(manifest, expected)) {
      throw new ManifestAgreementError('manifest does not agree with the validated journal');
    }
    validateProjectedArtifacts(run, expected);
    const encoded = stableJson(expected);
    atomicWriteFile(path.join(directory, 'manifest.json'), `${encoded}\n`, { mode: 0o600 });
    return expected;
  });
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

export function validateManifestAgreement(run, lease) {
  if (!run || typeof run !== 'object') throw new ManifestAgreementError('run is required');
  const state = validateRunJournal(run.file);
  const expected = projectRunManifest(state.events);
  validateProjectedArtifacts(run, expected);
  const file = manifestFile(run);
  if (!fs.existsSync(file)) {
    replaceRunManifest(run, expected, lease);
    return { manifest: expected, rebuilt: true };
  }
  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    replaceRunManifest(run, expected, lease);
    return { manifest: expected, rebuilt: true };
  }
  if (manifestsMatch(actual, expected)) return { manifest: expected, rebuilt: false };
  replaceRunManifest(run, expected, lease);
  return { manifest: expected, rebuilt: true };
}
