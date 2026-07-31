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
  isIncompleteJson,
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
const COMPATIBILITY_SCHEMA_VERSIONS = new Set([1, 2, 3]);
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
const COMPATIBILITY_FIELDS_V2 = Object.freeze([
  ...COMPATIBILITY_FIELDS,
  'logicalWindowId',
  'scheduleJobId',
  'stageArtifactSchemaVersion',
]);
const COMPATIBILITY_FIELDS_V3 = Object.freeze([
  ...COMPATIBILITY_FIELDS_V2,
  'lanePlanGeneration',
  'lanePlanRevision',
  'laneSelectionFingerprint',
]);
const HARD_REQUIREMENTS = Object.freeze([
  'mode',
  'purpose',
  'profileVersion',
  'sourceConfigFingerprint',
  'journalSchemaVersion',
  'artifactSchemaVersion',
  'stageArtifactSchemaVersion',
  'pipelineVersion',
  'lanePlanGeneration',
  'lanePlanRevision',
  'laneSelectionFingerprint',
  'scheduleJobId',
  'logicalWindowId',
]);
const REASON_FOR_FIELD = Object.freeze({
  mode: 'scan-mode-mismatch',
  purpose: 'purpose-mismatch',
  profileVersion: 'profile-version-mismatch',
  sourceConfigFingerprint: 'source-config-mismatch',
  journalSchemaVersion: 'journal-schema-mismatch',
  artifactSchemaVersion: 'artifact-schema-mismatch',
  stageArtifactSchemaVersion: 'stage-artifact-schema-mismatch',
  pipelineVersion: 'pipeline-version-mismatch',
  lanePlanGeneration: 'lane-plan-generation-mismatch',
  lanePlanRevision: 'lane-plan-revision-mismatch',
  laneSelectionFingerprint: 'lane-selection-mismatch',
  scheduleJobId: 'schedule-job-mismatch',
  logicalWindowId: 'logical-window-mismatch',
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
const DIAGNOSTIC_SCHEMA_VERSION = 1;
const SELECTION_REASONS = new Set([
  ...Object.values(REASON_FOR_FIELD),
  'compatibility-missing',
  'compatibility-schema-unsupported',
  'journal-schema-unsupported',
  'artifact-schema-unsupported',
  'completed-stage-unsupported',
  'candidate-malformed',
  'explicit-provider-substitution-required',
  'terminal-complete',
  'terminal-partial',
  'terminal-abandoned',
  'terminal-failed',
]);

class CandidateSkipError extends TypeError {
  constructor(reason, message) {
    super(message);
    this.name = 'CandidateSkipError';
    this.reason = reason;
  }
}

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

function checkedCompatibility(input, { candidate = false } = {}) {
  try {
    exactKeys(
      input,
      input?.schemaVersion === 3
        ? COMPATIBILITY_FIELDS_V3
        : input?.schemaVersion === 2 ? COMPATIBILITY_FIELDS_V2 : COMPATIBILITY_FIELDS,
      'recovery compatibility schema',
    );
  } catch (error) {
    if (candidate && (input === null || input === undefined)) {
      throw new CandidateSkipError('compatibility-missing', 'recovery compatibility is missing');
    }
    if (candidate) throw new CandidateSkipError('compatibility-missing', error.message);
    throw error;
  }
  if (!COMPATIBILITY_SCHEMA_VERSIONS.has(input.schemaVersion)) {
    if (candidate) throw new CandidateSkipError('compatibility-schema-unsupported', 'unsupported recovery compatibility schema');
    throw new TypeError('unsupported recovery compatibility schema');
  }
  for (const field of [
    'artifactSchemaVersion', 'assessmentSchemaVersion', 'journalSchemaVersion', 'mutationSchemaVersion',
    ...(input.schemaVersion >= 2 ? ['stageArtifactSchemaVersion'] : []),
  ]) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 1) {
      throw new TypeError(`recovery compatibility ${field} is invalid`);
    }
  }
  for (const field of [
    'mode', 'model', 'pipelineVersion', 'profileVersion', 'promptVersion',
    'provider', 'purpose', 'rankingVersion', 'targetRevision',
    ...(input.schemaVersion >= 2 ? ['scheduleJobId', 'logicalWindowId'] : []),
    ...(input.schemaVersion >= 3 ? ['lanePlanGeneration'] : []),
  ]) token(input[field], `recovery compatibility ${field}`);
  if (typeof input.sourceConfigFingerprint !== 'string' || !SHA256.test(input.sourceConfigFingerprint)) {
    throw new TypeError('recovery compatibility source/config fingerprint is invalid');
  }
  for (const field of input.schemaVersion >= 3
    ? ['lanePlanRevision', 'laneSelectionFingerprint'] : []) {
    if (typeof input[field] !== 'string' || !SHA256.test(input[field])) {
      throw new TypeError(`recovery compatibility ${field} is invalid`);
    }
  }
  if (input.journalSchemaVersion !== RUN_JOURNAL_SCHEMA_VERSION) {
    if (candidate) throw new CandidateSkipError('journal-schema-unsupported', 'candidate journal schema is unsupported');
    throw new TypeError('requested journal schema is unsupported');
  }
  if (input.artifactSchemaVersion !== RUN_ARTIFACT_SCHEMA_VERSION) {
    if (candidate) throw new CandidateSkipError('artifact-schema-unsupported', 'candidate artifact schema is unsupported');
    throw new TypeError('requested artifact schema is unsupported');
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
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CandidateSkipError('candidate-malformed', 'recovery candidate is invalid');
  }
  const updated = new Date(input.updatedAt);
  if (Number.isNaN(updated.getTime()) || updated.toISOString() !== input.updatedAt) {
    throw new CandidateSkipError('candidate-malformed', 'recovery candidate updated time is invalid');
  }
  if (!['in-progress', ...TERMINAL_OUTCOMES].includes(input.outcome)) {
    throw new CandidateSkipError('candidate-malformed', 'recovery candidate outcome is invalid');
  }
  if (!Array.isArray(input.completedWork)) {
    throw new CandidateSkipError('candidate-malformed', 'recovery candidate completed work is invalid');
  }
  let checkedRunId;
  try {
    checkedRunId = runId(input.runId);
  } catch (error) {
    throw new CandidateSkipError('candidate-malformed', error.message);
  }
  for (const work of input.completedWork) {
    if (!RECOVERABLE_PIPELINE_STAGES.some((stage) => stage.id === work?.stageId)) {
      throw new CandidateSkipError('completed-stage-unsupported', 'candidate contains an unsupported completed stage');
    }
  }
  return {
    original: input,
    runId: checkedRunId,
    updatedAt: input.updatedAt,
    outcome: input.outcome,
    compatibility: checkedCompatibility(input.compatibility, { candidate: true }),
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
    const requestValue = {
      ...request.compatibility,
      ...(request.providerSubstitution ? { providerSubstitution: request.providerSubstitution } : {}),
    };
    const requestFingerprint = createHash('sha256').update(stableJson(requestValue)).digest('hex');
    const candidateFingerprint = createHash('sha256').update(stableJson({
      runId: candidate.runId,
      outcome: candidate.outcome,
      compatibility: candidate.compatibility,
      completedWork: candidate.completedWork,
    })).digest('hex');
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
    this.request = Object.freeze(requestValue);
    this.requestFingerprint = requestFingerprint;
    this.candidateFingerprint = candidateFingerprint;
    this.selectionFingerprint = createHash('sha256').update(stableJson({
      candidateFingerprint,
      requestFingerprint,
    })).digest('hex');
    Object.freeze(this);
  }
}

export function compatibilityFingerprint(input) {
  const checked = checkedCompatibility(input);
  return createHash('sha256').update(stableJson(checked)).digest('hex');
}

function diagnosticJournalState(file, validateRecord, identityKey) {
  if (!fs.existsSync(file)) return { events: [], truncatedTail: false, prefix: '' };
  const contents = fs.readFileSync(file, 'utf8');
  if (!contents) return { events: [], truncatedTail: false, prefix: '' };
  const terminated = contents.endsWith('\n');
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  const identities = new Set();
  let prefix = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const final = index === lines.length - 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (final && !terminated && Buffer.byteLength(line, 'utf8') <= MAX_QUARANTINED_TAIL_BYTES
        && isIncompleteJson(line)) {
        return { events, truncatedTail: true, prefix };
      }
      throw new Error('recovery diagnostic journal is corrupt');
    }
    validateRecord(event);
    if (identities.has(event[identityKey])) throw new Error('recovery diagnostic identity is duplicated');
    identities.add(event[identityKey]);
    events.push(event);
    prefix += `${line}\n`;
  }
  return { events, truncatedTail: false, prefix };
}

function validateFingerprint(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} is invalid`);
}

function validateSelectionRecord(record) {
  exactKeys(record, [
    'candidateSetFingerprint', 'eventId', 'fencingGeneration', 'leaseId', 'recordedAt',
    'requestFingerprint', 'schemaVersion', 'selectedRunId', 'selectionId', 'skipped',
  ], 'recovery selection record');
  if (record.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) throw new Error('recovery selection schema is unsupported');
  validateFingerprint(record.selectionId, 'recovery selection ID');
  validateFingerprint(record.candidateSetFingerprint, 'recovery candidate-set fingerprint');
  validateFingerprint(record.requestFingerprint, 'recovery request fingerprint');
  token(record.eventId, 'recovery selection event ID');
  token(record.leaseId, 'recovery selection lease ID');
  if (!Number.isSafeInteger(record.fencingGeneration) || record.fencingGeneration < 1) {
    throw new Error('recovery selection fencing generation is invalid');
  }
  if (Number.isNaN(Date.parse(record.recordedAt)) || !record.recordedAt.endsWith('Z')) {
    throw new Error('recovery selection timestamp is invalid');
  }
  if (record.selectedRunId !== null) runId(record.selectedRunId);
  if (!Array.isArray(record.skipped)) throw new Error('recovery selection skips are invalid');
  for (const skipped of record.skipped) {
    exactKeys(skipped, ['outcome', 'reasons', 'runId'], 'recovery selection skip');
    runId(skipped.runId);
    if (!['partial', 'abandoned', 'complete', 'failed'].includes(skipped.outcome)) {
      throw new Error('recovery selection skip outcome is invalid');
    }
    if (!Array.isArray(skipped.reasons) || !skipped.reasons.length
      || skipped.reasons.some((reason) => !SELECTION_REASONS.has(reason))) {
      throw new Error('recovery selection skip reasons are invalid');
    }
  }
}

function repairDiagnosticTail(file, state) {
  if (!state.truncatedTail) return;
  const contents = fs.readFileSync(file, 'utf8');
  const tail = contents.slice(state.prefix.length);
  const digest = createHash('sha256').update(tail).digest('hex');
  const quarantine = `${file}.truncated.${digest}`;
  if (!fs.existsSync(quarantine)) atomicWriteFile(quarantine, tail, { mode: 0o600 });
  atomicWriteFile(file, state.prefix, { mode: 0o600 });
}

function appendDiagnosticRecord(file, identityKey, validateRecord, lease, makeRecord) {
  return assertCurrentFence(lease, synchronousFenceCallback(() => {
    let state = diagnosticJournalState(file, validateRecord, identityKey);
    if (state.truncatedTail) {
      repairDiagnosticTail(file, state);
      state = diagnosticJournalState(file, validateRecord, identityKey);
    }
    const pending = makeRecord();
    const existing = state.events.find((event) => event[identityKey] === pending[identityKey]);
    if (existing) {
      const canonical = ({
        eventId: _eventId,
        recordedAt: _recordedAt,
        leaseId: _leaseId,
        fencingGeneration: _fencingGeneration,
        ...record
      }) => stableJson(record);
      if (canonical(existing) !== canonical(pending)) {
        throw new Error('recovery diagnostic identity conflicts with a different canonical payload');
      }
      return existing;
    }
    appendSynced(file, pending);
    return pending;
  }));
}

function selectionFile(root) {
  return path.join(path.resolve(root), '.scout', 'recovery-selections.jsonl');
}

function candidateSortEnvelope(input, index) {
  const parsed = new Date(input?.updatedAt);
  const updatedAt = !Number.isNaN(parsed.getTime()) && parsed.toISOString() === input?.updatedAt
    ? input.updatedAt : '';
  let identifier;
  try {
    identifier = runId(input?.runId);
  } catch {
    identifier = `invalid-${createHash('sha256').update(String(index)).digest('hex').slice(0, 16)}`;
  }
  return { input, index, updatedAt, runId: identifier };
}

function skippedOutcome(candidate, reasons) {
  if (['partial', 'abandoned'].includes(candidate?.outcome)) return candidate.outcome;
  if (candidate?.outcome === 'complete') return 'complete';
  if (candidate?.outcome === 'failed') return 'failed';
  return Array.isArray(candidate?.completedWork) && candidate.completedWork.length ? 'partial' : 'abandoned';
}

function candidateSetFingerprintFor(ordered) {
  return createHash('sha256').update(stableJson(ordered.map((candidate) => ({
    runId: candidate.runId,
    updatedAt: candidate.updatedAt,
    digest: createHash('sha256').update(stableJson(candidate.input)).digest('hex'),
  })))).digest('hex');
}

function persistSelection(root, lease, candidateSetFingerprint, requestFingerprint, selectedRunId, skipped) {
  assertScanLeaseScope(lease, root, lease.runId);
  const selectionId = createHash('sha256').update(stableJson({
    candidateSetFingerprint,
    requestFingerprint,
  })).digest('hex');
  const record = appendDiagnosticRecord(
    selectionFile(root),
    'selectionId',
    validateSelectionRecord,
    lease,
    () => ({
      schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
      eventId: randomUUID(),
      selectionId,
      recordedAt: new Date().toISOString(),
      leaseId: lease.leaseId,
      fencingGeneration: lease.generation,
      requestFingerprint,
      candidateSetFingerprint,
      selectedRunId,
      skipped,
    }),
  );
  return { selectionId: record.selectionId, candidateSetFingerprint };
}

export function selectRecoverableRun(candidates, request, context) {
  if (!Array.isArray(candidates)) throw new TypeError('recovery candidates must be an array');
  if (!context) throw new TypeError('durable recovery selection context is required');
  exactKeys(context, ['lease', 'root'], 'recovery selection context');
  const checkedRequest = splitRequest(request);
  const requestValue = {
    ...checkedRequest.compatibility,
    ...(checkedRequest.providerSubstitution ? { providerSubstitution: checkedRequest.providerSubstitution } : {}),
  };
  const requestFingerprint = createHash('sha256').update(stableJson(requestValue)).digest('hex');
  const ordered = candidates.map(candidateSortEnvelope).sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId)
  ));
  const candidateSetFingerprint = candidateSetFingerprintFor(ordered);
  const priorState = diagnosticJournalState(selectionFile(context.root), validateSelectionRecord, 'selectionId');
  const terminal = new Map();
  for (const record of priorState.events) {
    if (record.candidateSetFingerprint === candidateSetFingerprint
      && record.requestFingerprint === requestFingerprint) continue;
    for (const skipped of record.skipped) {
      if (['partial', 'abandoned', 'complete', 'failed'].includes(skipped.outcome)) {
        terminal.set(skipped.runId, skipped.outcome);
      }
    }
  }
  const skipped = [];
  let selected = null;
  for (const envelope of ordered) {
    let decision;
    const terminalOutcome = terminal.get(envelope.runId);
    if (terminalOutcome) {
      skipped.push(Object.freeze({
        runId: envelope.runId,
        outcome: terminalOutcome,
        reasons: Object.freeze([`terminal-${terminalOutcome}`]),
      }));
      continue;
    }
    try {
      decision = new RecoveryCompatibilityDecision(envelope.input, requestValue);
    } catch (error) {
      const reason = error instanceof CandidateSkipError ? error.reason : 'candidate-malformed';
      skipped.push(Object.freeze({
        runId: envelope.runId,
        outcome: skippedOutcome(envelope.input, [reason]),
        reasons: Object.freeze([reason]),
      }));
      continue;
    }
    if (decision.recoverable) {
      selected = { candidate: envelope.input, decision };
      break;
    }
    skipped.push(Object.freeze({
      runId: envelope.runId,
      outcome: skippedOutcome(envelope.input, decision.reasons),
      reasons: decision.reasons,
    }));
  }
  const durable = persistSelection(
    context.root,
    context.lease,
    candidateSetFingerprint,
    requestFingerprint,
    selected?.candidate?.runId ?? null,
    skipped,
  );
  return Object.freeze({
    candidate: selected?.candidate ?? null,
    decision: selected?.decision ?? null,
    skipped: Object.freeze(skipped),
    ...durable,
  });
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

function validateFailureRecord(record) {
  exactKeys(record, [
    'eventId', 'failureId', 'fencingGeneration', 'leaseId', 'reason', 'recordedAt',
    'requestFingerprint', 'runId', 'schemaVersion',
  ], 'recovery failure record');
  if (record.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) throw new Error('recovery failure schema is unsupported');
  token(record.eventId, 'recovery failure event ID');
  validateFingerprint(record.failureId, 'recovery failure ID');
  runId(record.runId);
  token(record.leaseId, 'recovery failure lease ID');
  if (!Number.isSafeInteger(record.fencingGeneration) || record.fencingGeneration < 1) {
    throw new Error('recovery failure fencing generation is invalid');
  }
  if (Number.isNaN(Date.parse(record.recordedAt)) || !record.recordedAt.endsWith('Z')) {
    throw new Error('recovery failure timestamp is invalid');
  }
  validateFingerprint(record.requestFingerprint, 'recovery failure request fingerprint');
  if (!FAILURE_REASONS.has(record.reason)) throw new Error('recovery failure reason is invalid');
}

function recordRecoveryFailure(root, targetRunId, lease, reason, requestFingerprint) {
  if (!FAILURE_REASONS.has(reason)) throw new TypeError('recovery failure reason is invalid');
  validateFingerprint(requestFingerprint, 'recovery failure request fingerprint');
  const failureId = createHash('sha256').update(stableJson({
    runId: targetRunId,
    fencingGeneration: lease.generation,
    requestFingerprint,
    reason,
  })).digest('hex');
  const failure = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    eventId: randomUUID(),
    failureId,
    runId: targetRunId,
    recordedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
    fencingGeneration: lease.generation,
    requestFingerprint,
    reason,
  };
  return appendDiagnosticRecord(
    failureFile(root),
    'failureId',
    validateFailureRecord,
    lease,
    () => failure,
  );
}

function failRecovery(root, targetRunId, lease, reason, requestFingerprint, message, cause) {
  recordRecoveryFailure(root, targetRunId, lease, reason, requestFingerprint);
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

function withArtifactDirectory(stage, directory) {
  if (!stage.artifact) return stage;
  const artifact = { ...stage.artifact };
  Object.defineProperty(artifact, 'directory', { value: directory, enumerable: false });
  return Object.freeze({ ...stage, artifact });
}

export function recoverRun(root, targetRunId, lease, selectedDecision) {
  targetRunId = runId(targetRunId);
  assertScanLeaseScope(lease, root, targetRunId);
  if (!(selectedDecision instanceof RecoveryCompatibilityDecision)
    || selectedDecision.runId !== targetRunId
    || !selectedDecision.recoverable) {
    throw new TypeError('recovery requires the exact recoverable selection decision');
  }
  const requestFingerprint = selectedDecision.requestFingerprint;
  let run;
  try {
    run = openRunJournal(root, targetRunId);
    quarantineTruncatedTail(run, lease);
  } catch (error) {
    if (error instanceof JournalCorruptionError) {
      return failRecovery(root, targetRunId, lease, 'journal-damaged', requestFingerprint, 'run journal is damaged; recovery failed closed', error);
    }
    throw error;
  }
  if (!run.events.length) {
    return failRecovery(root, targetRunId, lease, 'journal-damaged', requestFingerprint, 'run journal is damaged or missing; recovery failed closed');
  }

  let agreement;
  try {
    agreement = validateManifestAgreement(run, lease);
  } catch (error) {
    if (error instanceof JournalCorruptionError) {
      return failRecovery(root, targetRunId, lease, 'journal-damaged', requestFingerprint, 'run journal is damaged; recovery failed closed', error);
    }
    if (error instanceof ManifestAgreementError || error instanceof ArtifactIntegrityError) {
      return failRecovery(root, targetRunId, lease, 'manifest-damaged', requestFingerprint, 'run manifest or artifact is damaged; recovery failed closed', error);
    }
    throw error;
  }

  const { manifest } = agreement;
  if (!manifest.compatibility?.schemaVersion) {
    return failRecovery(root, targetRunId, lease, 'compatibility-missing', requestFingerprint, 'run has no supported recovery compatibility contract');
  }
  if (TERMINAL_OUTCOMES.has(manifest.outcome)) {
    throw new Error(`terminal ${manifest.outcome} run is immutable and cannot be recovered`);
  }

  const candidate = {
    runId: targetRunId,
    updatedAt: run.events.at(-1).recordedAt,
    outcome: manifest.outcome,
    compatibility: manifest.compatibility,
    completedWork: manifest.completedWork,
  };
  const decision = new RecoveryCompatibilityDecision(candidate, selectedDecision.request);
  if (decision.selectionFingerprint !== selectedDecision.selectionFingerprint) {
    throw new Error('recovery candidate changed after selection; select the run again');
  }
  if (!decision.recoverable) {
    if (decision.reasons.includes('explicit-provider-substitution-required')) {
      return failRecovery(
        root,
        targetRunId,
        lease,
        'provider-substitution-required',
        requestFingerprint,
        'provider or model substitution requires an explicit recovery decision',
      );
    }
    throw new Error(`run is not recoverable: ${decision.reasons.join(', ')}`);
  }

  const current = readScanLease(root);
  if (!current || current.leaseId !== lease.leaseId || current.generation !== lease.generation) {
    throw new Error('scan lease is no longer current');
  }
  if ((current.operation.mode ?? decision.request.mode) !== decision.request.mode
    || (current.operation.provider ?? decision.request.provider) !== decision.request.provider
    || (current.operation.model ?? decision.request.model) !== decision.request.model) {
    throw new Error('scan lease operation does not match the selected recovery request');
  }
  if (decision.providerSubstitution && current.operation.phase !== 'provider-substitution') {
    throw new Error('scan lease does not authorize provider substitution');
  }

  const { providerSubstitution: _providerSubstitution, ...compatibility } = decision.request;
  appendRunEvent(run, {
    type: 'recovery.started',
    stageId: 'run',
    idempotencyKey: `recovery-started-${lease.generation}`,
    payload: {
      schemaVersion: 2,
      compatibility,
      requestFingerprint: decision.requestFingerprint,
      selectionFingerprint: decision.selectionFingerprint,
      providerSubstitution: decision.providerSubstitution ? {
        previousProvider: decision.providerSubstitution.fromProvider,
        previousModel: decision.providerSubstitution.fromModel,
        nextProvider: decision.providerSubstitution.toProvider,
        nextModel: decision.providerSubstitution.toModel,
      } : null,
      decisions: decision.stages.map((stage) => ({
        stageId: stage.stageId,
        action: stage.action,
        reason: stage.reason,
        ...(stage.artifact ? { artifact: stage.artifact } : {}),
      })),
    },
  }, lease);

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
