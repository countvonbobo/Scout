import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { RECOVERABLE_PIPELINE_STAGES, recoveryRequirementsForStage } from './pipeline.mjs';
import {
  ArtifactIntegrityError,
  ManifestAgreementError,
  RUN_ARTIFACT_SCHEMA_VERSION,
  validateManifestAgreement,
} from './runArtifacts.mjs';
import {
  JournalCorruptionError,
  RUN_JOURNAL_SCHEMA_VERSION,
  appendRunEvent,
  openRunJournal,
  validateRunJournal,
} from './runJournal.mjs';
import {
  assertCurrentFence,
  assertScanLeaseScope,
  readScanLease,
  synchronousFenceCallback,
} from './scanLease.mjs';

const COMPATIBILITY_SCHEMA_VERSION = 1;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TERMINAL_OUTCOMES = new Set(['complete', 'partial', 'abandoned', 'failed']);
const COMPATIBILITY_FIELDS = Object.freeze([
  'artifactSchemaVersion',
  'assessmentSchemaVersion',
  'journalSchemaVersion',
  'mode',
  'model',
  'mutationSchemaVersion',
  'pipelineVersion',
  'profileVersion',
  'promptVersion',
  'provider',
  'purpose',
  'rankingVersion',
  'schemaVersion',
  'sourceConfigFingerprint',
  'targetRevision',
]);
const HARD_REQUIREMENTS = Object.freeze([
  'mode',
  'purpose',
  'profileVersion',
  'sourceConfigFingerprint',
  'journalSchemaVersion',
  'artifactSchemaVersion',
  'pipelineVersion',
]);
const REASON_FOR_FIELD = Object.freeze({
  mode: 'scan-mode-mismatch',
  purpose: 'purpose-mismatch',
  profileVersion: 'profile-version-mismatch',
  sourceConfigFingerprint: 'source-config-mismatch',
  journalSchemaVersion: 'journal-schema-mismatch',
  artifactSchemaVersion: 'artifact-schema-mismatch',
  pipelineVersion: 'pipeline-version-mismatch',
  rankingVersion: 'ranking-version-mismatch',
  promptVersion: 'prompt-version-mismatch',
  assessmentSchemaVersion: 'assessment-schema-version-mismatch',
  mutationSchemaVersion: 'mutation-schema-version-mismatch',
  targetRevision: 'target-revision-mismatch',
});
const FAILURE_REASONS = new Set([
  'journal-damaged',
  'manifest-damaged',
  'compatibility-missing',
  'provider-substitution-required',
]);
const MAX_QUARANTINED_TAIL_BYTES = 32 * 1024;

function stableJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('recovery values must be finite JSON values');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('recovery values must be plain JSON objects');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new TypeError(`${label} has an unsupported schema`);
  }
}

function token(value, label) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function runId(value) {
  if (typeof value !== 'string' || !SAFE_RUN_ID.test(value)) throw new TypeError('recovery run ID is invalid');
  return value;
}

function checkedCompatibility(input) {
  exactKeys(input, COMPATIBILITY_FIELDS, 'recovery compatibility schema');
  if (input.schemaVersion !== COMPATIBILITY_SCHEMA_VERSION) throw new TypeError('unsupported recovery compatibility schema');
  for (const field of [
    'artifactSchemaVersion', 'assessmentSchemaVersion', 'journalSchemaVersion', 'mutationSchemaVersion',
  ]) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 1) {
      throw new TypeError(`recovery compatibility ${field} is invalid`);
    }
  }
  for (const field of [
    'mode', 'model', 'pipelineVersion', 'profileVersion', 'promptVersion',
    'provider', 'purpose', 'rankingVersion', 'targetRevision',
  ]) token(input[field], `recovery compatibility ${field}`);
  if (typeof input.sourceConfigFingerprint !== 'string' || !SHA256.test(input.sourceConfigFingerprint)) {
    throw new TypeError('recovery compatibility source/config fingerprint is invalid');
  }
  return structuredClone(input);
}

function splitRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('recovery request is invalid');
  }
  const { providerSubstitution = null, ...compatibility } = input;
  return {
    compatibility: checkedCompatibility(compatibility),
    providerSubstitution: checkedProviderSubstitution(providerSubstitution, compatibility),
  };
}

function checkedProviderSubstitution(value, request) {
  if (value === null || value === undefined) return null;
  exactKeys(value, ['allowed', 'fromProvider', 'fromModel', 'toProvider', 'toModel'], 'provider substitution');
  if (value.allowed !== true) throw new TypeError('provider substitution must be explicitly allowed');
  for (const field of ['fromProvider', 'fromModel', 'toProvider', 'toModel']) {
    token(value[field], `provider substitution ${field}`);
  }
  if (value.toProvider !== request.provider || value.toModel !== request.model) {
    throw new TypeError('provider substitution does not match requested provenance');
  }
  if (value.fromProvider === value.toProvider && value.fromModel === value.toModel) {
    throw new TypeError('provider substitution does not change provenance');
  }
  return Object.freeze(structuredClone(value));
}

function checkedCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('recovery candidate is invalid');
  const updated = new Date(input.updatedAt);
  if (Number.isNaN(updated.getTime()) || updated.toISOString() !== input.updatedAt) {
    throw new TypeError('recovery candidate updated time is invalid');
  }
  if (!['in-progress', ...TERMINAL_OUTCOMES].includes(input.outcome)) {
    throw new TypeError('recovery candidate outcome is invalid');
  }
  if (!Array.isArray(input.completedWork)) throw new TypeError('recovery candidate completed work is invalid');
  return {
    original: input,
    runId: runId(input.runId),
    updatedAt: input.updatedAt,
    outcome: input.outcome,
    compatibility: checkedCompatibility(input.compatibility),
    completedWork: structuredClone(input.completedWork),
  };
}

function stageMismatch(stageId, candidate, request, substitution) {
  const requirements = recoveryRequirementsForStage(stageId);
  if (stageId === 'assess'
    && (candidate.provider !== request.provider || candidate.model !== request.model)
    && substitution) return 'provider-substituted';
  for (const field of requirements) {
    if (candidate[field] !== request[field]) return REASON_FOR_FIELD[field] ?? `${field}-mismatch`;
  }
  return null;
}

function validSubstitutionFor(candidate, request, substitution) {
  if (!substitution) return false;
  return substitution.fromProvider === candidate.provider
    && substitution.fromModel === candidate.model
    && substitution.toProvider === request.provider
    && substitution.toModel === request.model;
}

function cascadeStageRestarts(stages) {
  const stageIndexes = new Map(RECOVERABLE_PIPELINE_STAGES.map((stage, index) => [stage.id, index]));
  const firstRestart = stages
    .filter((stage) => stage.action === 'restart')
    .map((stage) => stageIndexes.get(stage.stageId))
    .filter((index) => index !== undefined)
    .sort((left, right) => left - right)[0];
  if (firstRestart === undefined) return stages;
  return stages.map((stage) => {
    const index = stageIndexes.get(stage.stageId);
    if (stage.action === 'reuse' && index !== undefined && index > firstRestart) {
      return Object.freeze({
        ...stage,
        action: 'restart',
        reason: 'upstream-stage-restarted',
      });
    }
    return stage;
  });
}

export class RecoveryCompatibilityDecision {
  constructor(candidateInput, requestInput) {
    const candidate = checkedCandidate(candidateInput);
    const request = splitRequest(requestInput);
    const reasons = [];
    const terminal = TERMINAL_OUTCOMES.has(candidate.outcome);
    if (terminal) reasons.push(`terminal-${candidate.outcome}`);
    for (const field of HARD_REQUIREMENTS) {
      if (candidate.compatibility[field] !== request.compatibility[field]) {
        reasons.push(REASON_FOR_FIELD[field]);
      }
    }

    const provenanceChanged = candidate.compatibility.provider !== request.compatibility.provider
      || candidate.compatibility.model !== request.compatibility.model;
    let providerSubstitution = null;
    if (provenanceChanged) {
      if (validSubstitutionFor(candidate.compatibility, request.compatibility, request.providerSubstitution)) {
        providerSubstitution = request.providerSubstitution;
      } else {
        reasons.push('explicit-provider-substitution-required');
      }
    } else if (request.providerSubstitution) {
      throw new TypeError('provider substitution was supplied without a provenance change');
    }

    const stages = cascadeStageRestarts(candidate.completedWork.map((work) => {
      const stageId = token(work?.stageId, 'recovery completed stage ID');
      const mismatch = stageMismatch(
        stageId,
        candidate.compatibility,
        request.compatibility,
        providerSubstitution,
      );
      const hasArtifact = work.artifact && typeof work.artifact === 'object';
      const reason = mismatch ?? (hasArtifact ? 'compatible' : 'artifact-reference-missing');
      return Object.freeze({
        stageId,
        action: reason === 'compatible' ? 'reuse' : 'restart',
        reason,
        ...(hasArtifact ? { artifact: structuredClone(work.artifact) } : {}),
      });
    }));

    this.runId = candidate.runId;
    this.recoverable = reasons.length === 0;
    this.reasons = Object.freeze([...new Set(reasons)]);
    this.stages = Object.freeze(stages);
    this.providerSubstitution = providerSubstitution;
    Object.freeze(this);
  }
}

export function compatibilityFingerprint(input) {
  const checked = checkedCompatibility(input);
  return createHash('sha256').update(stableJson(checked)).digest('hex');
}

export function selectRecoverableRun(candidates, request) {
  if (!Array.isArray(candidates)) throw new TypeError('recovery candidates must be an array');
  const ordered = candidates.map(checkedCandidate).sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId)
  ));
  const skipped = [];
  for (const candidate of ordered) {
    const decision = new RecoveryCompatibilityDecision(candidate.original, request);
    if (decision.recoverable) {
      return Object.freeze({
        candidate: candidate.original,
        decision,
        skipped: Object.freeze(skipped),
      });
    }
    skipped.push(Object.freeze({ runId: candidate.runId, reasons: decision.reasons }));
  }
  return Object.freeze({ candidate: null, decision: null, skipped: Object.freeze(skipped) });
}

function failureFile(root) {
  return path.join(path.resolve(root), '.scout', 'recovery-failures.jsonl');
}

function appendSynced(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(`${stableJson(value)}\n`, 'utf8');
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (!written) throw new Error('recovery failure append made no progress');
      offset += written;
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function recordRecoveryFailure(root, targetRunId, lease, reason) {
  if (!FAILURE_REASONS.has(reason)) throw new TypeError('recovery failure reason is invalid');
  const failure = {
    schemaVersion: 1,
    eventId: randomUUID(),
    runId: targetRunId,
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    reason,
  };
  return assertCurrentFence(lease, synchronousFenceCallback(() => {
    appendSynced(failureFile(root), failure);
    return failure;
  }));
}

function failRecovery(root, targetRunId, lease, reason, message, cause) {
  recordRecoveryFailure(root, targetRunId, lease, reason);
  const error = new Error(message, { cause });
  error.name = 'RunRecoveryError';
  throw error;
}

function validJournalPrefix(contents, eventCount) {
  let offset = 0;
  for (let index = 0; index < eventCount; index += 1) {
    const delimiter = contents.indexOf('\n', offset);
    if (delimiter === -1) throw new JournalCorruptionError('journal valid prefix has no record delimiter');
    offset = delimiter + 1;
  }
  return { prefix: contents.slice(0, offset), tail: contents.slice(offset) };
}

function quarantineTruncatedTail(run, lease) {
  const initial = validateRunJournal(run.file);
  if (!initial.truncatedTail) return false;
  return assertCurrentFence(lease, synchronousFenceCallback(() => {
    const state = validateRunJournal(run.file);
    if (!state.truncatedTail) return false;
    const contents = fs.readFileSync(run.file, 'utf8');
    const { prefix, tail } = validJournalPrefix(contents, state.events.length);
    if (!tail || Buffer.byteLength(tail, 'utf8') > MAX_QUARANTINED_TAIL_BYTES) {
      throw new JournalCorruptionError('journal truncated tail is not safely bounded');
    }
    const tailDigest = createHash('sha256').update(tail).digest('hex');
    const quarantine = path.join(run.directory, `journal.truncated.${tailDigest}.jsonl`);
    if (fs.existsSync(quarantine) && fs.readFileSync(quarantine, 'utf8') !== tail) {
      throw new JournalCorruptionError('journal truncated-tail quarantine conflicts');
    }
    if (!fs.existsSync(quarantine)) atomicWriteFile(quarantine, tail, { mode: 0o600 });
    atomicWriteFile(run.file, prefix, { mode: 0o600 });
    const recovered = validateRunJournal(run.file);
    run.events = recovered.events;
    run.lastHash = recovered.lastHash;
    return true;
  }));
}

function recoveryRequest(root, compatibility, lease) {
  const current = readScanLease(root);
  if (!current || current.leaseId !== lease.leaseId || current.generation !== lease.generation) {
    throw new Error('scan lease is no longer current');
  }
  const request = {
    ...compatibility,
    mode: current.operation.mode ?? compatibility.mode,
    provider: current.operation.provider ?? compatibility.provider,
    model: current.operation.model ?? compatibility.model,
  };
  if (request.provider !== compatibility.provider || request.model !== compatibility.model) {
    if (current.operation.phase !== 'provider-substitution') return request;
    request.providerSubstitution = {
      allowed: true,
      fromProvider: compatibility.provider,
      fromModel: compatibility.model,
      toProvider: request.provider,
      toModel: request.model,
    };
  }
  return request;
}

function withArtifactDirectory(stage, directory) {
  if (!stage.artifact) return stage;
  const artifact = { ...stage.artifact };
  Object.defineProperty(artifact, 'directory', { value: directory, enumerable: false });
  return Object.freeze({ ...stage, artifact });
}

export function recoverRun(root, targetRunId, lease) {
  targetRunId = runId(targetRunId);
  assertScanLeaseScope(lease, root, targetRunId);
  let run;
  try {
    run = openRunJournal(root, targetRunId);
    quarantineTruncatedTail(run, lease);
  } catch (error) {
    if (error instanceof JournalCorruptionError) {
      return failRecovery(root, targetRunId, lease, 'journal-damaged', 'run journal is damaged; recovery failed closed', error);
    }
    throw error;
  }
  if (!run.events.length) {
    return failRecovery(root, targetRunId, lease, 'journal-damaged', 'run journal is damaged or missing; recovery failed closed');
  }

  let agreement;
  try {
    agreement = validateManifestAgreement(run, lease);
  } catch (error) {
    if (error instanceof JournalCorruptionError) {
      return failRecovery(root, targetRunId, lease, 'journal-damaged', 'run journal is damaged; recovery failed closed', error);
    }
    if (error instanceof ManifestAgreementError || error instanceof ArtifactIntegrityError) {
      return failRecovery(root, targetRunId, lease, 'manifest-damaged', 'run manifest or artifact is damaged; recovery failed closed', error);
    }
    throw error;
  }

  const { manifest } = agreement;
  if (!manifest.compatibility?.schemaVersion) {
    return failRecovery(root, targetRunId, lease, 'compatibility-missing', 'run has no supported recovery compatibility contract');
  }
  if (TERMINAL_OUTCOMES.has(manifest.outcome)) {
    throw new Error(`terminal ${manifest.outcome} run is immutable and cannot be recovered`);
  }

  const request = recoveryRequest(root, manifest.compatibility, lease);
  const candidate = {
    runId: targetRunId,
    updatedAt: run.events.at(-1).recordedAt,
    outcome: manifest.outcome,
    compatibility: manifest.compatibility,
    completedWork: manifest.completedWork,
  };
  const decision = new RecoveryCompatibilityDecision(candidate, request);
  if (!decision.recoverable) {
    if (decision.reasons.includes('explicit-provider-substitution-required')) {
      return failRecovery(
        root,
        targetRunId,
        lease,
        'provider-substitution-required',
        'provider or model substitution requires an explicit recovery decision',
      );
    }
    throw new Error(`run is not recoverable: ${decision.reasons.join(', ')}`);
  }

  if (decision.providerSubstitution) {
    appendRunEvent(run, {
      type: 'recovery.provider-substituted',
      stageId: 'assess',
      idempotencyKey: `recovery-substitution-${lease.generation}`,
      payload: {
        schemaVersion: 1,
        previousProvider: decision.providerSubstitution.fromProvider,
        previousModel: decision.providerSubstitution.fromModel,
        nextProvider: decision.providerSubstitution.toProvider,
        nextModel: decision.providerSubstitution.toModel,
      },
    }, lease);
  }
  for (const stage of decision.stages) {
    appendRunEvent(run, {
      type: 'recovery.stage-decided',
      stageId: stage.stageId,
      idempotencyKey: `recovery-${lease.generation}-${stage.stageId}`,
      payload: {
        schemaVersion: 1,
        action: stage.action,
        reason: stage.reason,
        ...(stage.artifact ? { artifact: stage.artifact } : {}),
      },
    }, lease);
  }

  const finalAgreement = validateManifestAgreement(run, lease);
  const stages = decision.stages.map((stage) => withArtifactDirectory(stage, run.directory));
  return Object.freeze({
    runId: targetRunId,
    manifest: finalAgreement.manifest,
    rebuilt: agreement.rebuilt || finalAgreement.rebuilt,
    decision,
    reusableStages: Object.freeze(stages.filter((stage) => stage.action === 'reuse')),
    restartStages: Object.freeze(stages.filter((stage) => stage.action === 'restart')),
  });
}

export const RECOVERY_COMPATIBILITY_DEFAULTS = Object.freeze({
  schemaVersion: COMPATIBILITY_SCHEMA_VERSION,
  journalSchemaVersion: RUN_JOURNAL_SCHEMA_VERSION,
  artifactSchemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
});
