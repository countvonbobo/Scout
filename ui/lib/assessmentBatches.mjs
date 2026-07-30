import { createHash } from 'node:crypto';
import {
  ASSESSMENT_ARTIFACT_SCHEMA_VERSION,
  commitRunArtifact,
  readRunArtifact,
  validateManifestAgreement,
} from './runArtifacts.mjs';
import { appendRunEvent } from './runJournal.mjs';
import {
  isCloseGatedProviderCall,
  ProviderLifecycleUnclosedError,
} from './structuredTurn.mjs';

const MAX_BATCH_JOBS = 10;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_INPUT_TOKENS = 75_000;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRIVATE_REQUEST_KEY = /^(?:access[-_]?token|advert[-_]?body|api[-_]?(?:key|token)|auth(?:orization)?|body|cookies?|credentials?|cv|description|headers?|html|master[-_]?cv|password|payload|profile[-_]?evidence|prompt|raw[-_]?(?:html|response)|requirements?|response|secret(?:[-_]?(?:key|token))?|token|transcript)$/i;
const CREDENTIAL_VALUE = /(?:\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)|(?:\b(?:api[-_ ]?key|authorization|password|secret|session[-_ ]?id|token)\s*[:=]\s*\S+)|(?:\bbearer\s+[A-Za-z0-9._~+/-]{8,})|(?:\bsk-[A-Za-z0-9_-]{16,})|(?:\bgh[pousr]_[A-Za-z0-9]{20,})|(?:\bxox[baprs]-[A-Za-z0-9-]{10,})|(?:\bAKIA[0-9A-Z]{16}\b)/i;
const URL_VALUE = /\bhttps?:\/\/\S+/i;
const CONTEXT_DIGEST_KEYS = Object.freeze([
  'scoringConfigDigest', 'profileDigest', 'calibrationDigest', 'masterCvDigest',
]);
const ASSESSMENT_KEYS = Object.freeze([
  'candidateId', 'summary', 'responsibilityFit', 'mandatoryRequirements',
  'transferableExperience', 'uncertainties', 'strengths', 'concerns', 'recommendation',
]);
const REQUIREMENT_KEYS = Object.freeze([
  'requirement', 'advertEvidence', 'advertEvidenceId', 'status', 'profileEvidence',
]);
const RESPONSIBILITY_FIT_KEYS = Object.freeze([
  'rating', 'advertEvidence', 'profileEvidence', 'explanation',
]);
const TRANSFERABLE_EXPERIENCE_KEYS = Object.freeze([
  'advertNeed', 'profileEvidence', 'relevance', 'explanation',
]);
const EVIDENCE_POINT_KEYS = Object.freeze(['point', 'advertEvidence', 'profileEvidence']);

export const ASSESSMENT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    assessments: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_BATCH_JOBS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidateId: { type: 'string', maxLength: 128 },
          summary: { type: 'string', maxLength: 600 },
          responsibilityFit: {
            type: 'object',
            additionalProperties: false,
            properties: {
              rating: { type: 'string', enum: ['strong', 'mixed', 'weak', 'unknown'] },
              advertEvidence: { type: 'string', maxLength: 600 },
              profileEvidence: { type: ['string', 'null'], maxLength: 600 },
              explanation: { type: 'string', maxLength: 600 },
            },
            required: RESPONSIBILITY_FIT_KEYS,
          },
          mandatoryRequirements: {
            type: 'array',
            maxItems: 24,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                requirement: { type: 'string', maxLength: 300 },
                advertEvidence: { type: 'string', maxLength: 600 },
                advertEvidenceId: { type: 'string', maxLength: 128 },
                status: { type: 'string', enum: ['met', 'unmet', 'unknown'] },
                profileEvidence: { type: ['string', 'null'], maxLength: 600 },
              },
              required: REQUIREMENT_KEYS,
            },
          },
          transferableExperience: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                advertNeed: { type: 'string', maxLength: 600 },
                profileEvidence: { type: ['string', 'null'], maxLength: 600 },
                relevance: { type: 'string', enum: ['strong', 'partial', 'unknown'] },
                explanation: { type: 'string', maxLength: 600 },
              },
              required: TRANSFERABLE_EXPERIENCE_KEYS,
            },
          },
          uncertainties: {
            type: 'array', maxItems: 12, items: { type: 'string', maxLength: 600 },
          },
          strengths: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                point: { type: 'string', maxLength: 600 },
                advertEvidence: { type: 'string', maxLength: 600 },
                profileEvidence: { type: ['string', 'null'], maxLength: 600 },
              },
              required: EVIDENCE_POINT_KEYS,
            },
          },
          concerns: {
            type: 'array',
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                point: { type: 'string', maxLength: 600 },
                advertEvidence: { type: 'string', maxLength: 600 },
                profileEvidence: { type: ['string', 'null'], maxLength: 600 },
              },
              required: EVIDENCE_POINT_KEYS,
            },
          },
          recommendation: { type: 'string', enum: ['keep', 'check', 'discard'] },
        },
        required: ASSESSMENT_KEYS,
      },
    },
  },
  required: ['assessments'],
});

function stableJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('assessment batch values must be finite JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('assessment batch values must be plain JSON');
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function safeId(value, name) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${name} must be a bounded identifier`);
  return value;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a bounded positive integer`);
  }
  return value;
}

function boundedString(value, name, maximum, { nullable = false, empty = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum
    || CREDENTIAL_VALUE.test(value) || URL_VALUE.test(value)) {
    throw new TypeError(`${name} must be a bounded string`);
  }
  return value;
}

function jobId(job) {
  return safeId(job?.assessmentJobId || job?.vacancyId || job?.jobId || job?.candidateId, 'assessment job ID');
}

function candidateId(job) {
  return safeId(job?.candidateId || jobId(job), 'assessment candidate ID');
}

function validateContextDigests(value) {
  if (!exactKeys(value, CONTEXT_DIGEST_KEYS)) throw new TypeError('assessment context digests are invalid');
  for (const key of CONTEXT_DIGEST_KEYS) {
    if (typeof value[key] !== 'string' || !SHA256.test(value[key])) {
      throw new TypeError(`assessment context digest is invalid: ${key}`);
    }
  }
  return value;
}

function validateProvenance(value) {
  const keys = [
    'profileVersion', 'promptVersion', 'assessmentSchemaVersion',
    'pipelineVersion', 'provider', 'model',
  ];
  if (!exactKeys(value, keys)) throw new TypeError('assessment provenance is invalid');
  for (const key of ['profileVersion', 'promptVersion', 'pipelineVersion', 'provider', 'model']) {
    safeId(value[key], `assessment provenance ${key}`);
  }
  positiveInteger(value.assessmentSchemaVersion, 'assessment schema version');
  return value;
}

function inspectPrivateRequestKeys(value, seen = new Set()) {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('assessment request must be acyclic JSON');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) inspectPrivateRequestKeys(item, seen);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('assessment request must use plain objects');
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_REQUEST_KEY.test(key)) throw new TypeError(`private assessment request property is not allowed: ${key}`);
      inspectPrivateRequestKeys(item, seen);
    }
  }
  seen.delete(value);
}

export function assertMinimalAssessmentRequest(request) {
  inspectPrivateRequestKeys(request);
  if (!exactKeys(request, [
    'schemaVersion', 'batchId', 'runId', 'contextDigests', 'jobReferences', 'parameters', 'provenance',
  ])
    || request.schemaVersion !== 1) {
    throw new TypeError('minimal assessment request is invalid');
  }
  safeId(request.batchId, 'assessment batch ID');
  safeId(request.runId, 'assessment run ID');
  validateContextDigests(request.contextDigests);
  if (!Array.isArray(request.jobReferences) || !request.jobReferences.length || request.jobReferences.length > MAX_BATCH_JOBS) {
    throw new TypeError('assessment request job references are invalid');
  }
  const seen = new Set();
  for (const reference of request.jobReferences) {
    if (!exactKeys(reference, ['jobId', 'inputDigest'])) throw new TypeError('assessment job reference is invalid');
    safeId(reference.jobId, 'assessment job reference ID');
    if (seen.has(reference.jobId)) throw new TypeError('assessment job reference is duplicated');
    seen.add(reference.jobId);
    if (typeof reference.inputDigest !== 'string' || !SHA256.test(reference.inputDigest)) {
      throw new TypeError('assessment job input digest is invalid');
    }
  }
  if (!exactKeys(request.parameters, ['maxJobs', 'maxInputTokens', 'timeoutMs', 'contextBudgetCharacters'])) {
    throw new TypeError('assessment request parameters are invalid');
  }
  positiveInteger(request.parameters.maxJobs, 'assessment request maximum jobs', MAX_BATCH_JOBS);
  positiveInteger(request.parameters.maxInputTokens, 'assessment request token cap', 1_000_000);
  positiveInteger(request.parameters.timeoutMs, 'assessment request timeout', MAX_TIMEOUT_MS);
  positiveInteger(request.parameters.contextBudgetCharacters, 'assessment request context budget', 10_000_000);
  validateProvenance(request.provenance);
  return request;
}

function contextCharacters(job) {
  const explicit = Number(job?.contextCharacters);
  return Number.isSafeInteger(explicit) && explicit > 0
    ? explicit
    : JSON.stringify(job).length;
}

function canonicalJobInput(job) {
  if (job?.assessmentInput && typeof job.assessmentInput === 'object') return job.assessmentInput;
  const {
    assessmentJobId: _assessmentJobId,
    assessmentInput: _assessmentInput,
    contextCharacters: _contextCharacters,
    ...input
  } = job;
  return input;
}

const EMPTY_CONTEXT_DIGESTS = Object.freeze({
  scoringConfigDigest: digest(''),
  profileDigest: digest(''),
  calibrationDigest: digest(''),
  masterCvDigest: digest(''),
});

export function planAssessmentBatches({
  runId,
  jobs = [],
  provenance,
  contextBudgetCharacters,
  contextOverheadCharacters = 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
  maxJobs = MAX_BATCH_JOBS,
  contextDigests = EMPTY_CONTEXT_DIGESTS,
} = {}) {
  safeId(runId, 'assessment run ID');
  validateProvenance(provenance);
  validateContextDigests(contextDigests);
  positiveInteger(contextBudgetCharacters, 'assessment context budget', 10_000_000);
  if (!Number.isSafeInteger(contextOverheadCharacters) || contextOverheadCharacters < 0
    || contextOverheadCharacters >= contextBudgetCharacters) {
    throw new TypeError('assessment context overhead must fit within the context budget');
  }
  positiveInteger(timeoutMs, 'assessment timeout', MAX_TIMEOUT_MS);
  positiveInteger(maxInputTokens, 'assessment input-token cap', 1_000_000);
  maxJobs = positiveInteger(Math.min(maxJobs, MAX_BATCH_JOBS), 'assessment maximum jobs', MAX_BATCH_JOBS);
  if (!Array.isArray(jobs)) throw new TypeError('assessment jobs must be an array');
  const ids = new Set();
  const prepared = jobs.map((job) => {
    const id = jobId(job);
    if (ids.has(id)) throw new TypeError(`assessment job is duplicated: ${id}`);
    ids.add(id);
    return {
      job,
      id,
      inputDigest: digest({
        job: canonicalJobInput(job),
        contextDigests,
      }),
      characters: contextCharacters(job),
    };
  });
  const groups = [];
  let current = [];
  let characters = contextOverheadCharacters;
  for (const item of prepared) {
    const wouldOverflow = current.length > 0
      && (current.length >= maxJobs || characters + item.characters > contextBudgetCharacters);
    if (wouldOverflow) {
      groups.push(current);
      current = [];
      characters = contextOverheadCharacters;
    }
    current.push(item);
    characters += item.characters;
  }
  if (current.length) groups.push(current);
  return groups.map((group) => {
    const parameters = {
      maxJobs,
      maxInputTokens,
      timeoutMs,
      contextBudgetCharacters,
    };
    const jobReferences = group.map((item) => ({ jobId: item.id, inputDigest: item.inputDigest }));
    const identity = {
      runId,
      contextDigests,
      jobReferences,
      parameters,
      provenance,
    };
    const id = `assessment-${digest(identity).slice(0, 32)}`;
    const request = assertMinimalAssessmentRequest({
      schemaVersion: 1,
      batchId: id,
      runId,
      contextDigests: { ...contextDigests },
      jobReferences,
      parameters,
      provenance: { ...provenance },
    });
    return Object.freeze({
      id,
      runId,
      jobs: Object.freeze(group.map((item) => item.job)),
      request: Object.freeze(request),
    });
  });
}

function validationFailure(code) {
  return Object.freeze([code]);
}

export function validateAssessmentJob(value, job) {
  const expectedId = candidateId(job);
  if (!exactKeys(value, ASSESSMENT_KEYS)) return validationFailure('assessment-shape-invalid');
  if (value.candidateId !== expectedId) return validationFailure('candidate-id-mismatch');
  try {
    boundedString(value.candidateId, 'assessment candidate ID', 128);
    boundedString(value.summary, 'assessment summary', 600);
    if (!exactKeys(value.responsibilityFit, RESPONSIBILITY_FIT_KEYS)) {
      return validationFailure('responsibility-fit-shape-invalid');
    }
    boundedString(value.responsibilityFit.advertEvidence, 'responsibility advert evidence', 600);
    boundedString(
      value.responsibilityFit.profileEvidence,
      'responsibility profile evidence',
      600,
      { nullable: true },
    );
    boundedString(value.responsibilityFit.explanation, 'responsibility fit explanation', 600);
    if (!['strong', 'mixed', 'weak', 'unknown'].includes(value.responsibilityFit.rating)) {
      return validationFailure('responsibility-fit-rating-invalid');
    }
    if (value.responsibilityFit.rating === 'strong'
      && !String(value.responsibilityFit.profileEvidence || '').trim()) {
      return validationFailure('responsibility-profile-evidence-required');
    }
    if (!Array.isArray(value.mandatoryRequirements) || value.mandatoryRequirements.length > 24) {
      return validationFailure('mandatory-requirements-invalid');
    }
    const knownSignals = new Set((job?.mandatorySignals || []).map((signal) => signal.id));
    const covered = new Set();
    for (const requirement of value.mandatoryRequirements) {
      if (!exactKeys(requirement, REQUIREMENT_KEYS)) return validationFailure('mandatory-requirement-shape-invalid');
      boundedString(requirement.requirement, 'mandatory requirement', 300);
      boundedString(requirement.advertEvidence, 'mandatory advert evidence', 600);
      boundedString(requirement.advertEvidenceId, 'mandatory advert evidence ID', 128);
      if (!['met', 'unmet', 'unknown'].includes(requirement.status)) return validationFailure('mandatory-status-invalid');
      boundedString(requirement.profileEvidence, 'mandatory profile evidence', 600, { nullable: true, empty: true });
      if (!knownSignals.has(requirement.advertEvidenceId)
        && !/^provider-[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(requirement.advertEvidenceId)) {
        return validationFailure('advert-evidence-id-unknown');
      }
      if (requirement.status === 'met' && !String(requirement.profileEvidence || '').trim()) {
        return validationFailure('profile-evidence-required');
      }
      if (covered.has(requirement.advertEvidenceId)) {
        return validationFailure('advert-evidence-duplicate');
      }
      covered.add(requirement.advertEvidenceId);
    }
    if ([...knownSignals].some((id) => !covered.has(id))) return validationFailure('mandatory-advert-evidence-omitted');
    if (!Array.isArray(value.transferableExperience) || value.transferableExperience.length > 12) {
      return validationFailure('transferable-experience-invalid');
    }
    for (const experience of value.transferableExperience) {
      if (!exactKeys(experience, TRANSFERABLE_EXPERIENCE_KEYS)) {
        return validationFailure('transferable-experience-shape-invalid');
      }
      boundedString(experience.advertNeed, 'transferable advert need', 600);
      boundedString(experience.profileEvidence, 'transferable profile evidence', 600, { nullable: true });
      boundedString(experience.explanation, 'transferable experience explanation', 600);
      if (!['strong', 'partial', 'unknown'].includes(experience.relevance)) {
        return validationFailure('transferable-relevance-invalid');
      }
      if (experience.relevance !== 'unknown' && !String(experience.profileEvidence || '').trim()) {
        return validationFailure('transferable-profile-evidence-required');
      }
    }
    if (!Array.isArray(value.uncertainties) || value.uncertainties.length > 12) {
      return validationFailure('uncertainties-invalid');
    }
    for (const uncertainty of value.uncertainties) {
      boundedString(uncertainty, 'assessment uncertainty', 600);
    }
    for (const [name, points, requireProfile] of [
      ['strength', value.strengths, true],
      ['concern', value.concerns, false],
    ]) {
      if (!Array.isArray(points) || points.length > 12) return validationFailure(`${name}s-invalid`);
      for (const point of points) {
        if (!exactKeys(point, EVIDENCE_POINT_KEYS)) return validationFailure(`${name}-shape-invalid`);
        boundedString(point.point, `${name} point`, 600);
        boundedString(point.advertEvidence, `${name} advert evidence`, 600);
        boundedString(point.profileEvidence, `${name} profile evidence`, 600, { nullable: true });
        if (requireProfile && !String(point.profileEvidence || '').trim()) {
          return validationFailure(`${name}-profile-evidence-required`);
        }
      }
    }
    if (!['keep', 'check', 'discard'].includes(value.recommendation)) {
      return validationFailure('recommendation-invalid');
    }
  } catch {
    return validationFailure('assessment-value-invalid');
  }
  return Object.freeze([]);
}

const ASSESSMENT_INVALIDATING_STAGES = new Set([
  'collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select', 'assess', 'assessment',
]);

export function assessmentRecoveryBoundary(run) {
  let boundary = { sequence: 0, fencingGeneration: 1 };
  for (const event of run.events || []) {
    let restart = false;
    if (event.type === 'recovery.started') {
      restart = event.payload.schemaVersion === 1
        || event.payload.decisions?.some((decision) => (
          ASSESSMENT_INVALIDATING_STAGES.has(decision.stageId) && decision.action === 'restart'
        ));
    } else if (event.type === 'recovery.stage-decided') {
      restart = ASSESSMENT_INVALIDATING_STAGES.has(event.stageId) && event.payload.action === 'restart';
    }
    if (restart) {
      boundary = {
        sequence: event.sequence,
        fencingGeneration: event.fencingGeneration,
      };
    }
  }
  return boundary;
}

function batchReference(batch, id) {
  return batch.request.jobReferences.find((reference) => reference.jobId === id);
}

function artifactMatchesFence(data, event, boundary) {
  return data.fencingGeneration === event.fencingGeneration
    && event.fencingGeneration >= boundary.fencingGeneration;
}

function assessmentState(run, batch) {
  const state = {
    completed: new Map(),
    failed: new Map(),
    completedBatches: new Set(),
    attempts: new Map(),
  };
  const boundary = assessmentRecoveryBoundary(run);
  for (const event of run.events || []) {
    if (!event.type.startsWith('assessment.') || event.sequence <= boundary.sequence
      || event.fencingGeneration < boundary.fencingGeneration) continue;
    if (event.type === 'assessment.batch-attempted') {
      if (event.payload.reference.id !== batch.id) continue;
      const stored = readRunArtifact({ ...event.payload.artifact, directory: run.directory });
      const request = assertMinimalAssessmentRequest(stored.data.request);
      if (request.batchId !== batch.id
        || stableJson(request.contextDigests) !== stableJson(batch.request.contextDigests)
        || stableJson(request.parameters) !== stableJson(batch.request.parameters)
        || stableJson(request.provenance) !== stableJson(batch.request.provenance)
        || request.jobReferences.some((reference) => (
          batchReference(batch, reference.jobId)?.inputDigest !== reference.inputDigest
        ))) continue;
      const ids = request.jobReferences.map((reference) => reference.jobId);
      const attempts = state.attempts.get(batch.id) || new Map();
      attempts.set(event.payload.attempt, new Set(ids));
      state.attempts.set(batch.id, attempts);
    } else if (event.type === 'assessment.job-completed') {
      const stored = readRunArtifact({ ...event.payload.artifact, directory: run.directory });
      const data = stored.data;
      const reference = batchReference(batch, data.jobId);
      if (data.batchId === batch.id && reference?.inputDigest === data.inputDigest
        && artifactMatchesFence(data, event, boundary)
        && event.payload.reference.id === data.jobId) {
        state.completed.set(data.jobId, data);
      }
    } else if (event.type === 'assessment.job-failed') {
      const stored = readRunArtifact({ ...event.payload.artifact, directory: run.directory });
      const data = stored.data;
      const reference = batchReference(batch, data.jobId);
      if (data.batchId === batch.id && reference?.inputDigest === data.inputDigest
        && artifactMatchesFence(data, event, boundary)
        && event.payload.reference.id === data.jobId) {
        state.failed.set(data.jobId, data);
      }
    } else if (event.type === 'assessment.batch-completed') {
      if (event.payload.reference.id !== batch.id) continue;
      const stored = readRunArtifact({ ...event.payload.artifact, directory: run.directory });
      if (stored.data.batchId === batch.id && artifactMatchesFence(stored.data, event, boundary)) {
        state.completedBatches.add(batch.id);
      }
    }
  }
  return state;
}

function artifact(run, lease, id, type, stableIds, data) {
  return commitRunArtifact(run, {
    id,
    schemaVersion: ASSESSMENT_ARTIFACT_SCHEMA_VERSION,
  }, {
    schemaVersion: ASSESSMENT_ARTIFACT_SCHEMA_VERSION,
    type,
    stableIds,
    data,
  }, lease);
}

function executionIdentity(run, lease) {
  const boundary = assessmentRecoveryBoundary(run);
  return `g${lease.generation}-e${boundary.sequence}`;
}

function durableOperationId(batch, context, kind, id = '') {
  return `assessment-${digest({
    batchId: batch.id,
    execution: executionIdentity(context.run, context.lease),
    kind,
    id,
  }).slice(0, 48)}`;
}

function appendAttempt(batch, subset, kind, context) {
  const request = assertMinimalAssessmentRequest({
    ...batch.request,
    jobReferences: subset.map((job) => {
      const id = jobId(job);
      const source = batch.request.jobReferences.find((reference) => reference.jobId === id);
      return { ...source };
    }),
  });
  const ref = artifact(
    context.run,
    context.lease,
    durableOperationId(batch, context, 'request', kind),
    'request',
    request.jobReferences.map((reference) => reference.jobId),
    { request },
  );
  appendRunEvent(context.run, {
    type: 'assessment.batch-attempted',
    stageId: 'assessment',
    idempotencyKey: durableOperationId(batch, context, 'attempted', kind),
    payload: {
      schemaVersion: 1,
      reference: { kind: 'batch', id: batch.id },
      count: subset.length,
      attempt: kind,
      artifact: ref,
    },
  }, context.lease);
}

function commitAssessment(batch, job, value, context) {
  const id = jobId(job);
  const inputDigest = batchReference(batch, id).inputDigest;
  const provenance = {
    provider: batch.request.provenance.provider,
    model: batch.request.provenance.model,
    promptVersion: batch.request.provenance.promptVersion,
    assessmentSchemaVersion: batch.request.provenance.assessmentSchemaVersion,
    profileVersion: batch.request.provenance.profileVersion,
    pipelineVersion: batch.request.provenance.pipelineVersion,
  };
  const ref = artifact(
    context.run,
    context.lease,
    durableOperationId(batch, context, 'result', id),
    'result',
    [id],
    {
      batchId: batch.id,
      jobId: id,
      inputDigest,
      fencingGeneration: context.lease.generation,
      assessment: value,
      provenance,
    },
  );
  appendRunEvent(context.run, {
    type: 'assessment.job-completed',
    stageId: 'assessment',
    idempotencyKey: durableOperationId(batch, context, 'completed', id),
    payload: {
      schemaVersion: 1,
      reference: { kind: 'vacancy', id },
      artifact: ref,
    },
  }, context.lease);
  return {
    batchId: batch.id,
    jobId: id,
    inputDigest,
    fencingGeneration: context.lease.generation,
    assessment: value,
    provenance,
  };
}

function commitFailure(batch, job, failure, context) {
  const id = jobId(job);
  const data = {
    batchId: batch.id,
    jobId: id,
    inputDigest: batchReference(batch, id).inputDigest,
    fencingGeneration: context.lease.generation,
    ...failure,
  };
  const ref = artifact(
    context.run,
    context.lease,
    durableOperationId(batch, context, 'failure', id),
    'failure',
    [id],
    data,
  );
  appendRunEvent(context.run, {
    type: 'assessment.job-failed',
    stageId: 'assessment',
    idempotencyKey: durableOperationId(batch, context, 'failed', id),
    payload: {
      schemaVersion: 1,
      reference: { kind: 'vacancy', id },
      artifact: ref,
    },
  }, context.lease);
  return data;
}

async function boundedProviderCall(batch, kind, subset, validationFailures, context) {
  const timeoutMs = batch.request.parameters.timeoutMs;
  const heartbeatIntervalMs = Math.max(1, Number(context.heartbeatIntervalMs || 1_000));
  let timer;
  let heartbeatTransferred = false;
  const heartbeat = typeof context.heartbeat === 'function'
    ? setInterval(() => {
      Promise.resolve(context.heartbeat()).catch(() => {});
    }, heartbeatIntervalMs)
    : null;
  heartbeat?.unref?.();
  try {
    let invocation;
    try {
      invocation = context.invokeProvider({
        batchId: batch.id,
        kind,
        jobs: subset,
        validationFailures,
        timeoutMs,
        maxInputTokens: batch.request.parameters.maxInputTokens,
        provenance: batch.request.provenance,
      });
    } catch (error) {
      if (error instanceof ProviderLifecycleUnclosedError) throw error;
      return { ok: false, code: 'provider-call-failed' };
    }
    const lifecycleManaged = isCloseGatedProviderCall(invocation);
    const call = Promise.resolve(invocation);
    const closure = call.then(
      () => undefined,
      (error) => error instanceof ProviderLifecycleUnclosedError ? error.closure : undefined,
    );
    const settled = call.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    let outcome;
    if (lifecycleManaged) {
      outcome = await settled;
    } else {
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, watchdog: true }), timeoutMs);
      });
      outcome = await Promise.race([settled, deadline]);
      if (outcome.watchdog) {
        throw new ProviderLifecycleUnclosedError(
          `assessment provider call did not settle within ${timeoutMs} ms`,
          closure,
        );
      }
    }
    if (!outcome.ok) {
      if (outcome.error instanceof ProviderLifecycleUnclosedError) throw outcome.error;
      return { ok: false, code: 'provider-call-failed' };
    }
    return outcome;
  } catch (error) {
    if (!(error instanceof ProviderLifecycleUnclosedError)) throw error;
    heartbeatTransferred = true;
    error.closure.then(() => {
      if (heartbeat) clearInterval(heartbeat);
    });
    const state = assessmentState(context.run, batch);
    for (const job of subset) {
      const id = jobId(job);
      if (state.completed.has(id) || state.failed.has(id)) continue;
      commitFailure(batch, job, {
        code: 'assessment-provider-unclosed',
        attempts: state.attempts.get(batch.id)
          ? [...state.attempts.get(batch.id).values()].filter((ids) => ids.has(id)).length
          : 0,
        validationFailures: ['provider-lifecycle-unclosed'],
      }, context);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (heartbeat && !heartbeatTransferred) clearInterval(heartbeat);
  }
}

function classifyProviderOutput(call, subset) {
  const issues = new Map();
  const valid = new Map();
  if (!call.ok) {
    for (const job of subset) issues.set(jobId(job), [call.code]);
    return { valid, issues, providerFailed: true };
  }
  const output = call.value?.value ?? call.value;
  if (!output || !Array.isArray(output.assessments)) {
    for (const job of subset) issues.set(jobId(job), ['assessments-array-required']);
    return { valid, issues, providerFailed: false };
  }
  const returned = new Map();
  for (const assessment of output.assessments) {
    const id = assessment?.candidateId;
    const job = subset.find((candidate) => candidateId(candidate) === id);
    const durableId = job ? jobId(job) : null;
    if (!job || returned.has(durableId)) {
      if (durableId) issues.set(durableId, ['candidate-duplicate']);
      continue;
    }
    returned.set(durableId, assessment);
  }
  for (const job of subset) {
    const id = jobId(job);
    if (issues.has(id)) continue;
    if (!returned.has(id)) {
      issues.set(id, ['assessment-missing']);
      continue;
    }
    const failures = validateAssessmentJob(returned.get(id), job);
    if (failures.length) issues.set(id, failures);
    else valid.set(id, returned.get(id));
  }
  return { valid, issues, providerFailed: false, usage: call.value?.usage || {} };
}

async function commitValid(batch, subset, classified, context, completed) {
  for (const job of subset) {
    const id = jobId(job);
    if (!classified.valid.has(id) || completed.has(id)) continue;
    completed.set(id, commitAssessment(batch, job, classified.valid.get(id), context));
    if (typeof context.onJobCommitted === 'function') {
      await context.onJobCommitted({ batchId: batch.id, jobId: id });
    }
  }
}

function mergeUsage(target, usage) {
  for (const [key, value] of Object.entries(usage || {})) {
    if (Number.isFinite(Number(value))) target[key] = Number(target[key] || 0) + Number(value);
  }
}

export async function executeAssessmentBatch(batch, context = {}) {
  if (!batch || !Array.isArray(batch.jobs) || !context.run || !context.lease) {
    throw new TypeError('assessment batch execution requires a batch, run and lease');
  }
  if (typeof context.invokeProvider !== 'function') throw new TypeError('assessment provider callback is required');
  assertMinimalAssessmentRequest(batch.request);
  let state = assessmentState(context.run, batch);
  const completed = new Map(state.completed);
  const failed = new Map(state.failed);
  const usage = {};
  if (state.completedBatches.has(batch.id)) {
    return batchResult(batch, completed, failed, usage);
  }
  const pending = batch.jobs.filter((job) => !completed.has(jobId(job)) && !failed.has(jobId(job)));
  if (!pending.length) return completeBatch(batch, context, completed, failed);
  const attempts = state.attempts.get(batch.id) || new Map();
  let issues = new Map();
  let providerFailed = false;
  if (!attempts.has('batch')) {
    appendAttempt(batch, pending, 'batch', context);
    const classified = classifyProviderOutput(
      await boundedProviderCall(batch, 'batch', pending, {}, context),
      pending,
    );
    mergeUsage(usage, classified.usage);
    await commitValid(batch, pending, classified, context, completed);
    issues = classified.issues;
    providerFailed = classified.providerFailed;
  } else {
    for (const job of pending) issues.set(jobId(job), ['interrupted-attempt']);
    providerFailed = false;
  }

  let invalid = pending.filter((job) => !completed.has(jobId(job)));
  if (invalid.length && !providerFailed && !attempts.has('repair')) {
    appendAttempt(batch, invalid, 'repair', context);
    const classified = classifyProviderOutput(
      await boundedProviderCall(batch, 'repair', invalid, Object.fromEntries(issues), context),
      invalid,
    );
    mergeUsage(usage, classified.usage);
    await commitValid(batch, invalid, classified, context, completed);
    issues = classified.issues;
    providerFailed = classified.providerFailed;
  }

  invalid = pending.filter((job) => !completed.has(jobId(job)));
  for (const job of invalid) {
    const id = jobId(job);
    const retryAttempt = `retry-${id}`;
    if (attempts.has(retryAttempt)) continue;
    appendAttempt(batch, [job], retryAttempt, context);
    const classified = classifyProviderOutput(
      await boundedProviderCall(batch, 'retry', [job], { [id]: issues.get(id) || ['assessment-invalid'] }, context),
      [job],
    );
    mergeUsage(usage, classified.usage);
    await commitValid(batch, [job], classified, context, completed);
    if (!completed.has(id)) issues.set(id, classified.issues.get(id) || ['assessment-invalid']);
  }

  state = assessmentState(context.run, batch);
  for (const job of pending) {
    const id = jobId(job);
    if (completed.has(id) || failed.has(id)) continue;
    const failures = issues.get(id) || ['assessment-invalid'];
    const allProviderFailures = failures.every((failure) => (
      failure === 'provider-timeout' || failure === 'provider-call-failed' || failure === 'interrupted-attempt'
    ));
    const data = commitFailure(batch, job, {
      code: allProviderFailures ? 'assessment-provider-exhausted' : 'assessment-validation-exhausted',
      attempts: state.attempts.get(batch.id)
        ? [...state.attempts.get(batch.id).values()].filter((ids) => ids.has(id)).length
        : 0,
      validationFailures: failures,
    }, context);
    failed.set(id, data);
  }
  return completeBatch(batch, context, completed, failed, usage);
}

function completeBatch(batch, context, completed, failed, usage = {}) {
  const completedJobIds = batch.jobs.map(jobId).filter((id) => completed.has(id));
  const failedJobIds = batch.jobs.map(jobId).filter((id) => failed.has(id));
  const ref = artifact(
    context.run,
    context.lease,
    durableOperationId(batch, context, 'batch-complete'),
    'batch',
    [...completedJobIds, ...failedJobIds],
    {
      batchId: batch.id,
      completedJobIds,
      failedJobIds,
      fencingGeneration: context.lease.generation,
      provenance: batch.request.provenance,
    },
  );
  appendRunEvent(context.run, {
    type: 'assessment.batch-completed',
    stageId: 'assessment',
    idempotencyKey: durableOperationId(batch, context, 'batch-completed'),
    payload: {
      schemaVersion: 1,
      reference: { kind: 'batch', id: batch.id },
      count: batch.jobs.length,
      artifact: ref,
    },
  }, context.lease);
  validateManifestAgreement(context.run, context.lease);
  return batchResult(batch, completed, failed, usage);
}

function batchResult(batch, completed, failed, usage = {}) {
  const assessments = [];
  const failures = [];
  const provenanceByJob = {};
  for (const job of batch.jobs) {
    const id = jobId(job);
    const outputId = candidateId(job);
    if (completed.has(id)) {
      const data = completed.get(id);
      assessments.push(data.assessment);
      provenanceByJob[outputId] = data.provenance;
    } else if (failed.has(id)) {
      const data = failed.get(id);
      failures.push({
        jobId: outputId,
        code: data.code,
        attempts: data.attempts,
        validationFailures: data.validationFailures,
      });
    }
  }
  return { assessments, failures, provenanceByJob, usage };
}

function effectiveProvenance(run) {
  const started = run.events.find((event) => event.type === 'run.started')?.payload?.compatibility || {};
  const substituted = [...run.events].reverse().find((event) => event.type === 'recovery.provider-substituted')?.payload;
  return {
    provider: substituted?.nextProvider || started.provider,
    model: substituted?.nextModel || started.model,
  };
}

function assertOrRecordSubstitution(run, batches, context) {
  if (!batches.length) return;
  const current = effectiveProvenance(run);
  const next = batches[0].request.provenance;
  if (current.provider === next.provider && current.model === next.model) return;
  const decision = context.providerSubstitution;
  if (!decision
    || decision.previousProvider !== current.provider
    || decision.previousModel !== current.model
    || decision.nextProvider !== next.provider
    || decision.nextModel !== next.model) {
    throw new Error('assessment recovery requires an explicit provider substitution decision');
  }
  appendRunEvent(run, {
    type: 'recovery.provider-substituted',
    stageId: 'assessment',
    idempotencyKey: `assessment-provider-substitution-${next.provider}-${next.model}`,
    payload: { schemaVersion: 1, ...decision },
  }, context.lease);
}

export async function resumeAssessments(run, context = {}) {
  const batches = context.batches || [];
  if (!run || !Array.isArray(batches) || !context.lease) {
    throw new TypeError('assessment resume requires a run, batches and lease');
  }
  assertOrRecordSubstitution(run, batches, context);
  const combined = { assessments: [], failures: [], provenanceByJob: {}, usage: {} };
  for (const batch of batches) {
    const result = await executeAssessmentBatch(batch, { ...context, run });
    combined.assessments.push(...result.assessments);
    combined.failures.push(...result.failures);
    Object.assign(combined.provenanceByJob, result.provenanceByJob);
    mergeUsage(combined.usage, result.usage);
  }
  validateManifestAgreement(run, context.lease);
  return combined;
}
