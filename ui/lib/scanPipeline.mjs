import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { serializeTracker } from './tracker.mjs';
import { workspacePaths } from './workspace.mjs';
import {
  advertMateriallyChanged, invalidateJobIdentity, jobIdentity, mergeSourceReferences, sameUnderlyingJob, sourceReferencesOf,
} from './jobIdentity.mjs';
import { isVerifiable } from './statusGroups.mjs';
import { canonicaliseObservations, vacancyContentFingerprint } from './vacancyCanonical.mjs';
import { createDiscoveryFunnel, advanceDiscoveryFunnel, assertDiscoveryFunnel } from './discoveryFunnel.mjs';
import { filterVacancies } from './vacancyFilter.mjs';
import { normaliseObservation } from './vacancyObservation.mjs';
import { rankVacancies, vacancyNoveltyComparison } from './vacancyRank.mjs';
import { selectVacancies } from './vacancySelect.mjs';
import { partitionVacanciesForAssessment } from './vacancyLifecycle.mjs';
import {
  buildCoverageRollups, buildVacancyExplanations, reconcileCoverageFunnel,
} from './scanCoverage.mjs';
import {
  PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION, commitRunArtifact, projectRunManifest,
  readRunArtifact, validateManifestAgreement,
} from './runArtifacts.mjs';
import { appendRunEvent, openRunJournal, validateRunJournal } from './runJournal.mjs';
import { recoverRun, selectRecoverableRun } from './runRecovery.mjs';
import {
  LeaseLostError, acquireScanLease, assertScanLeaseScope, currentLeaseOwner, isScanLease,
  handoffScanLease, readScanLease, releaseScanLease, startLeaseHeartbeat,
} from './scanLease.mjs';
import {
  claimNextScanRequest, completeOrphanedScanRequest, completeScanRequest,
  enqueueOverlappingScanRequest, projectScanQueue,
} from './scanQueue.mjs';
import { assertRunStorageWritable } from './runRetention.mjs';
import {
  ASSESSMENT_RESPONSE_SCHEMA,
  planAssessmentBatches,
  resumeAssessments,
  validateAssessmentJob,
} from './assessmentBatches.mjs';
import { ProviderLifecycleUnclosedError } from './structuredTurn.mjs';
import {
  applyPreparedMutation, loadPreparedMutation, markerFreeMutationContent, prepareMutation,
} from './mutationCoordinator.mjs';
import {
  jsonReplaceRecipe, renderMutationRecipe, runLogAppendRecipe, scanReportRecipe, trackerMergeRecipe,
} from './scanMutationProjection.mjs';
import {
  deriveSearchLaneResults, loadSearchLanePlan, recordSearchLaneRun,
} from './searchLanes.mjs';
import {
  canonicalEmployerId, employerRegistryRevision, loadEmployerRegistry,
  reconcileEmployerDiscoveries, recordEmployerChecks, validateEmployerRegistry,
} from './employerRegistry.mjs';
import { profileRuleId } from './searchProfile.mjs';
export { filterVacancies } from './vacancyFilter.mjs';

const EMPTY_DISCARDED = Object.freeze({ hard_exclusion: 0, mandatory_unmet: 0, below_threshold: 0, provider_discarded: 0 });
const REVIEW_REASON_LIMIT = 3;
const DURABLE_DISCOVERY_STAGES = Object.freeze([
  'collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select',
]);
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const BOUNDED_REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUCCESSFUL_QUEUE_OUTCOMES = new Set([
  'succeeded', 'succeeded-pending', 'succeeded-partial',
]);
const OPERATOR_INTERVENTION_REASON = 'operator-intervention-required';
const PROVIDER_HEALTH_STATES = new Set([
  'checking',
  'ready',
  'credentials-present-unverified',
  'sign-in-required',
  'login-in-progress',
  'network-unavailable',
  'rate-limited',
  'cli-update-required',
  'provider-error',
]);

export class PipelineInterruptedError extends Error {
  constructor(message = 'scan pipeline was interrupted after a durable stage') {
    super(message);
    this.name = 'PipelineInterruptedError';
  }
}

function pipelineOperation(runId, compatibility, phase) {
  return {
    kind: 'scan',
    runId,
    provider: compatibility.provider,
    model: compatibility.model,
    mode: compatibility.mode,
    phase,
  };
}

function queueDrainOperation(runId) {
  return {
    kind: 'scan',
    runId,
    phase: 'queue-drain',
  };
}

function stageFunctions(stages) {
  const entries = Array.isArray(stages)
    ? stages.map((stage) => [stage?.id, stage?.execute ?? stage?.run])
    : Object.entries(stages || {});
  const functions = new Map(entries.map(([stageId, execute]) => [stageId, {
    execute,
    encode: execute?.artifactCodec?.encode ?? ((value) => encodePipelineStageValue(stageId, value)),
    decode: execute?.artifactCodec?.decode ?? decodeRankedStageValue,
    transient: execute?.artifactCodec?.transient ?? ((executed) => (
      stageId === 'collect'
        ? encodePipelineStageValue(stageId, executed, null, { durableUrls: false })
        : executed
    )),
  }]));
  for (const stageId of DURABLE_DISCOVERY_STAGES) {
    if (typeof functions.get(stageId)?.execute !== 'function') {
      throw new TypeError(`scan pipeline stage is required: ${stageId}`);
    }
  }
  if (functions.size !== DURABLE_DISCOVERY_STAGES.length
    || [...functions.keys()].some((stageId) => !DURABLE_DISCOVERY_STAGES.includes(stageId))) {
    throw new TypeError('scan pipeline stages have an unsupported schema');
  }
  return functions;
}

function pipelineRunCandidates(root, requestedRunId) {
  const directory = workspacePaths(root).runs;
  if (!fs.existsSync(directory)) return [];
  const names = requestedRunId ? [requestedRunId] : fs.readdirSync(directory);
  const candidates = [];
  for (const runId of names) {
    let stat;
    try {
      stat = fs.statSync(path.join(directory, runId));
      if (!stat.isDirectory()) continue;
      const journalState = validateRunJournal(path.join(directory, runId, 'journal.jsonl'));
      if (journalState.truncatedTail && journalState.events.length === 0) {
        throw new Error('recovery candidate has no valid journal prefix');
      }
      const run = openRunJournal(root, runId);
      if (!run.events.length) continue;
      const manifest = projectRunManifest(run.events);
      candidates.push({
        runId,
        updatedAt: run.events.at(-1).recordedAt,
        outcome: manifest.outcome,
        compatibility: manifest.compatibility,
        completedWork: manifest.completedWork,
      });
    } catch {
      if (stat?.isDirectory()) {
        // Keep the damaged run itself immutable. Selection will classify this
        // bounded placeholder and durably record the skip in the fenced
        // workspace-level recovery diagnostic.
        candidates.push({
          runId,
          updatedAt: stat.mtime.toISOString(),
          outcome: 'in-progress',
          compatibility: null,
          completedWork: [],
        });
      }
    }
  }
  return candidates;
}

function plainStageData(value, stageId) {
  if (value === undefined) throw new TypeError(`scan pipeline stage returned no artifact: ${stageId}`);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`scan pipeline stage artifact is not JSON: ${stageId}`, { cause: error });
  }
  if (encoded === undefined) throw new TypeError(`scan pipeline stage artifact is not JSON: ${stageId}`);
  return JSON.parse(encoded);
}

function stableIdsFor(stageId, value) {
  const supplied = Array.isArray(value?.stableIds) ? value.stableIds : [];
  const ids = [...new Set(supplied.map(String).filter((id) => SAFE_ARTIFACT_ID.test(id)))].slice(0, 128);
  return ids.length ? ids : [`${stageId}-output`];
}

function recoveredStageData(stage, codec) {
  const value = readRunArtifact(stage.artifact);
  if (value.schemaVersion !== PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION || value.stageId !== stage.stageId) {
    throw new Error(`recovered pipeline artifact does not match stage: ${stage.stageId}`);
  }
  return plainStageData(codec.decode(value.data), stage.stageId);
}

function resultWithOutputs(result, outputs, { providerClosure = null } = {}) {
  Object.defineProperty(result, 'stageOutputs', {
    value: Object.freeze(Object.fromEntries(outputs)),
    enumerable: false,
  });
  if (providerClosure) {
    Object.defineProperty(result, 'providerClosure', {
      value: providerClosure,
      enumerable: false,
    });
  }
  return Object.freeze(result);
}

function finalizationOutcome(value) {
  const envelopeIntent = value?.schemaVersion === 1
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.hasOwn(value, 'mutationReceipt');
  const envelope = envelopeIntent
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === 'mutationReceipt,result,schemaVersion'
    ? value
    : null;
  if (!envelope) {
    return {
      result: envelopeIntent && Object.hasOwn(value, 'result') ? value.result : value,
      mutationReceipt: null,
      receiptIssue: envelopeIntent ? 'mutation-receipt-invalid' : 'mutation-receipt-missing',
    };
  }
  const receipt = envelope.mutationReceipt;
  if (!receipt || Object.getPrototypeOf(receipt) !== Object.prototype
    || Object.keys(receipt).sort().join(',') !== 'digest,id,schemaVersion'
    || receipt.schemaVersion !== 1
    || !SAFE_ARTIFACT_ID.test(receipt.id || '')
    || !SHA256_DIGEST.test(receipt.digest || '')) {
    return {
      result: envelope.result,
      mutationReceipt: null,
      receiptIssue: 'mutation-receipt-invalid',
    };
  }
  return {
    result: envelope.result,
    mutationReceipt: Object.freeze({ ...receipt }),
    receiptIssue: null,
  };
}

function postSuccessOutcome(value) {
  if (value === undefined) return { status: 'complete' };
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('scan post-success result is invalid');
  }
  if (value.status === 'complete' && Object.keys(value).join(',') === 'status') return value;
  if (['pending', 'partial'].includes(value.status)
    && Object.keys(value).sort().join(',') === 'reason,status'
    && BOUNDED_REASON.test(value.reason || '')) return value;
  throw new TypeError('scan post-success result is invalid');
}

function recordPostSuccessFailure(run, lease, failure) {
  appendRunEvent(run, {
    type: 'run.failure-recorded',
    stageId: 'post-success',
    idempotencyKey: `post-success-${failure.code}-g${lease.generation}`,
    payload: {
      schemaVersion: 1,
      code: failure.code,
      reason: failure.reason,
    },
  }, lease);
  return validateManifestAgreement(run, lease).manifest;
}

async function drainScanQueue(root, queue, compatibility, leaseOptions, initialLease = null) {
  if (!queue) return [];
  if (typeof queue.run !== 'function') throw new TypeError('scan queue drain callback is required');
  const drained = [];
  for (let index = 0; index < 128; index += 1) {
    const runId = randomUUID();
    const lease = index === 0 && initialLease ? initialLease : acquireScanLease(
      root,
      currentLeaseOwner(),
      queueDrainOperation(runId),
      leaseOptions,
    );
    if (!lease) break;
    let safeToRelease = false;
    try {
      const orphan = reconcileOrphanedQueueClaim(root, lease);
      if (orphan?.completed) {
        safeToRelease = true;
        drained.push(Object.freeze({ requestId: orphan.request.id, outcome: orphan.outcome }));
        continue;
      }
      const queueCompatibility = typeof queue.compatibility === 'function'
        ? await queue.compatibility()
        : queue.compatibility;
      const currentCompatibility = {
        ...queueCompatibility,
        purpose: compatibility.purpose,
      };
      const request = orphan?.resume
        ? orphan.request
        : claimNextScanRequest(root, currentCompatibility, lease, queue.now ?? new Date());
      if (!request) {
        safeToRelease = true;
        break;
      }
      if (typeof queue.verify === 'function'
        && !await queue.verify(request, { lease, phase: 'claim' })) {
        if (orphan?.resume) {
          completeOrphanedScanRequest(root, request.id, 'stale', request.claim, lease);
        } else {
          completeScanRequest(root, request.id, 'stale', lease, request.claim);
        }
        safeToRelease = true;
        drained.push(Object.freeze({ requestId: request.id, outcome: 'stale' }));
        continue;
      }
      let requestedOutcome = 'failed';
      let queueFailure = null;
      try {
        const value = await queue.run(request, { runId: lease.runId, lease });
        if (value?.outcome === 'in-progress'
          && value.reason === OPERATOR_INTERVENTION_REASON
          && typeof value.closure?.then === 'function') {
          const failure = Object.freeze({
            code: 'provider-lifecycle-unclosed',
            stage: 'finalise',
            reason: OPERATOR_INTERVENTION_REASON,
          });
          drained.push(Object.freeze({
            requestId: request.id,
            outcome: 'in-progress',
            reason: OPERATOR_INTERVENTION_REASON,
          }));
          Object.defineProperty(drained, 'paused', {
            value: Object.freeze({
              requestId: request.id,
              runId: lease.runId,
              closure: value.closure,
              failure,
            }),
            enumerable: false,
          });
          value.closure.then(() => {
            try { releaseScanLease(lease); } catch { /* recovery owns any successor fence */ }
          });
          return drained;
        }
        requestedOutcome = value === 'complete' ? 'succeeded'
          : SUCCESSFUL_QUEUE_OUTCOMES.has(value) || value === 'skipped' ? value : 'failed';
      } catch (error) {
        queueFailure = error;
        // A failed queued scan is a durable terminal result for that request;
        // it must not prevent the next compatible request from draining.
      }
      const runOutcome = ensureQueuedRunTerminal(root, lease, compatibility, request, queueFailure);
      const terminalManifest = projectRunManifest(openRunJournal(root, lease.runId).events);
      const terminalCompatible = typeof queue.verify !== 'function'
        || await queue.verify(request, { lease, phase: 'terminal', manifest: terminalManifest });
      const outcome = !terminalCompatible ? 'stale'
        : runOutcome === 'complete' && SUCCESSFUL_QUEUE_OUTCOMES.has(requestedOutcome)
        ? requestedOutcome
        : runOutcome === 'abandoned' && requestedOutcome === 'skipped'
          ? 'skipped'
          : 'failed';
      if (orphan?.resume) {
        completeOrphanedScanRequest(root, request.id, outcome, request.claim, lease);
      } else {
        completeScanRequest(root, request.id, outcome, lease, request.claim);
      }
      safeToRelease = true;
      drained.push(Object.freeze({ requestId: request.id, outcome }));
    } finally {
      if (safeToRelease) {
        try { releaseScanLease(lease); } catch { /* a successor fence owns cleanup */ }
      }
    }
  }
  return drained;
}

function terminalRunState(root, runId) {
  const run = openRunJournal(root, runId);
  if (!run.events.length) return { outcome: null, backupOutcome: null };
  const manifest = projectRunManifest(run.events);
  const backupFailures = run.events
    .filter((event) => event.type === 'run.failure-recorded')
    .map((event) => event.payload?.code);
  const backupOutcome = backupFailures.includes('backup-pending') ? 'succeeded-pending'
    : backupFailures.includes('backup-partial') ? 'succeeded-partial'
      : null;
  return {
    outcome: manifest.outcome === 'in-progress' ? null : manifest.outcome,
    backupOutcome,
  };
}

function terminalRunOutcome(root, runId) {
  return terminalRunState(root, runId).outcome;
}

function reconcileOrphanedQueueClaim(root, lease) {
  const orphan = projectScanQueue(root).requests.find((request) => request.status === 'claimed');
  if (!orphan) return null;
  let terminal = null;
  try {
    terminal = terminalRunState(root, orphan.claim.runId);
  } catch {
    // A damaged/incomplete run cannot authorize queue completion. Requeue the
    // request under the successor fence so a new journalled attempt can run.
  }
  if (terminal?.outcome) {
    const queueOutcome = terminal.outcome === 'complete' ? terminal.backupOutcome || 'succeeded'
      : terminal.outcome === 'abandoned' ? 'skipped' : 'failed';
    completeOrphanedScanRequest(root, orphan.id, queueOutcome, orphan.claim, lease);
    return Object.freeze({ completed: true, request: orphan, outcome: queueOutcome });
  }
  return Object.freeze({ resume: true, request: orphan });
}

function ensureQueuedRunTerminal(root, lease, compatibility, request, queueFailure = null) {
  const existingOutcome = terminalRunOutcome(root, lease.runId);
  if (existingOutcome) return existingOutcome;
  const run = openRunJournal(root, lease.runId);
  if (!run.events.length) {
    const execution = request.execution || null;
    appendRunEvent(run, {
      type: 'run.started',
      stageId: 'initialise',
      idempotencyKey: 'queued-run-started-v1',
      payload: {
        schemaVersion: 1,
        compatibility: {
          ...compatibility,
          provider: execution?.provider || compatibility.provider,
          model: execution ? (execution.model || 'provider-default') : compatibility.model,
          mode: execution?.mode || compatibility.mode,
        },
      },
    }, lease);
  }
  if (queueFailure) {
    appendRunEvent(run, {
      type: 'run.failure-recorded',
      stageId: 'finalise',
      idempotencyKey: `queued-run-failure-g${lease.generation}`,
      payload: {
        schemaVersion: 1,
        code: 'queue-run-failed-before-pipeline',
        reason: 'queued-scan-failed-before-durable-execution',
      },
    }, lease);
  }
  appendRunEvent(run, {
    type: 'run.completed',
    stageId: 'finalise',
    idempotencyKey: `queued-run-failed-g${lease.generation}`,
    payload: { schemaVersion: 1, outcome: 'failed' },
  }, lease);
  return validateManifestAgreement(run, lease).manifest.outcome;
}

/**
 * Execute the deterministic discovery boundary under a durable fenced run.
 *
 * Stage callbacks receive the current journal handle, genuine lease and the
 * preceding stage's recovered-or-new artifact data. The enumerable result is
 * deliberately limited to the public run contract; `stageOutputs` is a
 * non-enumerable local execution aid for the legacy scan adapter.
 */
export async function runScanPipeline({
  root,
  compatibility,
  stages,
  runId: requestedRunId = null,
  leaseOptions = {},
  heartbeatOptions = {},
  onStageCommitted = () => {},
  prepare = null,
  finalize = null,
  postTerminalSuccess = null,
  recordFailure = null,
  bindAuthority = null,
  queue = null,
  claimedLease = null,
  storagePolicy = {},
  healthPreflight = null,
  waitForTransientLease = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
} = {}) {
  if (!root) throw new TypeError('scan pipeline workspace root is required');
  assertRunStorageWritable(root, storagePolicy);
  if (recordFailure !== null && typeof recordFailure !== 'function') {
    throw new TypeError('scan pipeline failure recorder must be a function');
  }
  if (bindAuthority !== null && typeof bindAuthority !== 'function') {
    throw new TypeError('scan pipeline authority binder must be a function');
  }
  if (prepare !== null && typeof prepare !== 'function') {
    throw new TypeError('scan pipeline prepare callback must be a function');
  }
  if (postTerminalSuccess !== null && typeof postTerminalSuccess !== 'function') {
    throw new TypeError('scan pipeline post-success callback must be a function');
  }
  if (healthPreflight !== null && typeof healthPreflight !== 'function') {
    throw new TypeError('scan pipeline health preflight must be a function');
  }
  if (typeof waitForTransientLease !== 'function') {
    throw new TypeError('scan pipeline transient lease waiter must be a function');
  }
  const effectiveHeartbeatOptions = {
    ...(typeof leaseOptions.wallNow === 'function' ? { wallNow: leaseOptions.wallNow } : {}),
    ...(typeof leaseOptions.monotonicNow === 'function'
      ? { monotonicNow: leaseOptions.monotonicNow }
      : {}),
    ...heartbeatOptions,
  };
  const functions = stageFunctions(stages);
  const ownsLease = claimedLease === null;
  const provisionalRunId = claimedLease?.runId || requestedRunId || randomUUID();
  if (claimedLease !== null) {
    if (!isScanLease(claimedLease)) throw new TypeError('claimed queue lease must be a genuine scan lease');
    assertScanLeaseScope(claimedLease, root, provisionalRunId);
  }
  let lease = claimedLease || acquireScanLease(
      root,
      currentLeaseOwner(),
      pipelineOperation(provisionalRunId, compatibility, 'recovery-selection'),
      leaseOptions,
  );
  let durableQueueSubmission = false;
  let queueCoveragePending = false;
  for (let attempt = 0; !lease && attempt < 64; attempt += 1) {
    const observed = readScanLease(root);
    if (observed?.operation?.kind === 'provider-health') {
      const waitUntil = Date.parse(observed.expiresAt) + Number(observed.takeoverMarginMs || 0);
      const waitMs = Math.max(1, Math.min(250, waitUntil - Date.now()));
      await waitForTransientLease(waitMs);
      lease = acquireScanLease(
        root,
        currentLeaseOwner(),
        pipelineOperation(provisionalRunId, compatibility, 'recovery-selection'),
        leaseOptions,
      );
      continue;
    }
    if (!queue?.request) break;
    if (observed) {
      const queued = enqueueOverlappingScanRequest(root, {
        ...queue.request,
        observedLease: {
          leaseId: observed.leaseId,
          generation: observed.generation,
          runId: observed.runId,
          operation: observed.operation,
        },
      }, leaseOptions);
      if (queued.status !== 'not-active') {
        durableQueueSubmission = true;
        break;
      }
    }
    lease = acquireScanLease(
      root,
      currentLeaseOwner(),
      pipelineOperation(provisionalRunId, compatibility, 'recovery-selection'),
      leaseOptions,
    );
  }
  if (!lease) {
    return resultWithOutputs({
      runId: provisionalRunId,
      outcome: durableQueueSubmission ? 'queued' : 'failed',
      manifest: null,
      failures: Object.freeze([{
        code: durableQueueSubmission ? 'lease-busy' : 'queue-submit-raced',
        stage: 'initialise',
      }]),
    }, new Map());
  }

  const startupQueueState = ownsLease && queue ? projectScanQueue(root).requests : [];
  if (startupQueueState.some((request) => (
    request.status === 'queued' || request.status === 'claimed'
  ))) {
    const startupQueueRunId = startupQueueState.find((request) => request.status === 'claimed')?.claim?.runId
      || randomUUID();
    lease = handoffScanLease(
      lease,
      queueDrainOperation(startupQueueRunId),
    );
    const startupDrain = await drainScanQueue(root, queue, compatibility, leaseOptions, lease);
    if (startupDrain.paused) {
      const pausedRun = openRunJournal(root, startupDrain.paused.runId);
      return resultWithOutputs({
        runId: startupDrain.paused.runId,
        outcome: 'in-progress',
        manifest: projectRunManifest(pausedRun.events),
        failures: Object.freeze([startupDrain.paused.failure]),
      }, new Map(), { providerClosure: startupDrain.paused.closure });
    }
    lease = acquireScanLease(
      root,
      currentLeaseOwner(),
      pipelineOperation(provisionalRunId, compatibility, 'recovery-selection'),
      leaseOptions,
    );
    if (!lease) {
      return resultWithOutputs({
        runId: provisionalRunId,
        outcome: 'failed',
        manifest: null,
        failures: Object.freeze([{ code: 'startup-drain-raced', stage: 'initialise' }]),
      }, new Map());
    }
  }

  let run;
  let recovery = null;
  let manifest = null;
  let terminal = false;
  let released = false;
  let retainInterruptedLease = false;
  let retainUnclosedAuthority = false;
  let providerClosure = null;
  let heartbeat = null;
  const failures = [];
  const outputs = new Map();
  let mutationReceipt = null;
  let receiptIssue = 'mutation-receipt-missing';
  try {
    if (bindAuthority !== null) {
      const bound = await bindAuthority({ root, runId: provisionalRunId, lease, compatibility });
      if (!bound || Object.getPrototypeOf(bound) !== Object.prototype) {
        throw new TypeError('scan pipeline authority binder returned no compatibility contract');
      }
      compatibility = bound;
    }
    if (healthPreflight !== null) {
      heartbeat = startLeaseHeartbeat(lease, effectiveHeartbeatOptions);
      let health;
      try {
        health = await healthPreflight({
          root,
          provider: compatibility.provider,
          purpose: compatibility.purpose,
          runId: provisionalRunId,
          lease,
        });
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        health = { ok: false, state: 'provider-error' };
      }
      if (health?.ok !== true) {
        const state = PROVIDER_HEALTH_STATES.has(health?.state)
          ? health.state
          : 'provider-error';
        const failure = Object.freeze({
          code: 'provider-health-blocked',
          stage: 'initialise',
          reason: state,
        });
        failures.push(failure);
        run = openRunJournal(root, provisionalRunId);
        appendRunEvent(run, {
          type: 'run.started',
          stageId: 'initialise',
          idempotencyKey: 'run-started-v1',
          payload: { schemaVersion: 1, compatibility },
        }, lease);
        appendRunEvent(run, {
          type: 'run.failure-recorded',
          stageId: 'initialise',
          idempotencyKey: `provider-health-blocked-g${lease.generation}`,
          payload: {
            schemaVersion: 1,
            code: failure.code,
            reason: failure.reason,
          },
        }, lease);
        appendRunEvent(run, {
          type: 'run.completed',
          stageId: 'finalise',
          idempotencyKey: `run-provider-health-blocked-g${lease.generation}`,
          payload: { schemaVersion: 1, outcome: 'abandoned' },
        }, lease);
        manifest = validateManifestAgreement(run, lease).manifest;
        terminal = true;
      } else {
        heartbeat.stop();
        heartbeat = null;
      }
    }
    if (!terminal) {
      const mayRecoverClaimedRun = !ownsLease && openRunJournal(root, provisionalRunId).events.length > 0;
      const candidates = ownsLease || mayRecoverClaimedRun
        ? pipelineRunCandidates(root, mayRecoverClaimedRun ? provisionalRunId : requestedRunId)
        : [];
      const selection = ownsLease || mayRecoverClaimedRun
        ? selectRecoverableRun(candidates, compatibility, { root, lease })
        : { candidate: null };
      if (selection.candidate) {
        if (ownsLease) {
          lease = handoffScanLease(
            lease,
            pipelineOperation(selection.candidate.runId, compatibility, 'recover'),
          );
        }
        recovery = recoverRun(root, selection.candidate.runId, lease, selection.decision);
        run = openRunJournal(root, recovery.runId);
        manifest = recovery.manifest;
      } else {
        run = openRunJournal(root, provisionalRunId);
        appendRunEvent(run, {
          type: 'run.started',
          stageId: 'initialise',
          idempotencyKey: 'run-started-v1',
          payload: { schemaVersion: 1, compatibility },
        }, lease);
        manifest = validateManifestAgreement(run, lease).manifest;
      }
      heartbeat = startLeaseHeartbeat(lease, effectiveHeartbeatOptions);
      if (prepare !== null) await prepare({ run, lease });

      const reusable = new Map((recovery?.reusableStages || []).map((stage) => [stage.stageId, stage]));
      let priorArtifact = null;
      for (const stageId of DURABLE_DISCOVERY_STAGES) {
        const stage = functions.get(stageId);
        if (reusable.has(stageId)) {
          priorArtifact = recoveredStageData(reusable.get(stageId), stage);
          outputs.set(stageId, priorArtifact);
          continue;
        }
        const executed = plainStageData(await stage.execute({ run, lease, priorArtifact }), stageId);
        const persisted = plainStageData(stage.encode(executed), stageId);
        const durableValue = plainStageData(stage.decode(persisted), stageId);
        const value = plainStageData(stage.transient(executed, durableValue), stageId);
        const artifact = commitRunArtifact(run, {
          id: `${stageId}-g${lease.generation}`,
          schemaVersion: PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION,
        }, {
          schemaVersion: PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION,
          stageId,
          stableIds: stableIdsFor(stageId, durableValue),
          data: persisted,
        }, lease);
        appendRunEvent(run, {
          type: 'stage.completed',
          stageId,
          idempotencyKey: `${stageId}-completed-g${lease.generation}`,
          payload: {
            schemaVersion: 1,
            reference: { kind: 'stage', id: stageId },
            count: stableIdsFor(stageId, durableValue).length,
            artifact,
          },
        }, lease);
        manifest = validateManifestAgreement(run, lease).manifest;
        priorArtifact = value;
        outputs.set(stageId, value);
        await onStageCommitted({ stageId, run, lease, artifact, manifest });
        // Stage execution, privacy projection and artifact validation are
        // intentionally synchronous. Yield only after the artifact and event
        // are durable so the existing timer heartbeat can renew its genuine
        // fence between individually bounded stages.
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (finalize !== null) {
        if (typeof finalize !== 'function') throw new TypeError('scan pipeline finalizer must be a function');
        const finalized = finalizationOutcome(await finalize({
          run,
          lease,
          stageOutputs: Object.freeze(Object.fromEntries(outputs)),
        }));
        outputs.set('finalize', finalized.result);
        mutationReceipt = finalized.mutationReceipt;
        receiptIssue = finalized.receiptIssue;
        if (mutationReceipt) {
          const existingReceipts = run.events.filter((event) => (
            event.type === 'mutation.receipted'
            && event.payload?.reference?.id === mutationReceipt.id
          ));
          if (existingReceipts.some((event) => event.payload?.reference?.kind !== 'mutation')
            || existingReceipts.length > 1) {
            throw new Error('scan mutation receipt authority is ambiguous');
          }
          const existingReceipt = existingReceipts[0];
          if (existingReceipt && existingReceipt.payload.digest !== mutationReceipt.digest) {
            throw new Error('scan mutation receipt conflicts with durable journal evidence');
          }
          if (!existingReceipt) {
            appendRunEvent(run, {
              type: 'mutation.receipted',
              stageId: 'finalise',
              idempotencyKey: `scan-mutation-receipt-g${lease.generation}`,
              payload: {
                schemaVersion: 1,
                reference: { kind: 'mutation', id: mutationReceipt.id },
                digest: mutationReceipt.digest,
              },
            }, lease);
          }
          manifest = validateManifestAgreement(run, lease).manifest;
        }
      }

      appendRunEvent(run, {
        type: 'run.completed',
        stageId: 'finalise',
        idempotencyKey: `run-completed-g${lease.generation}`,
        payload: { schemaVersion: 1, outcome: 'complete' },
      }, lease);
      manifest = validateManifestAgreement(run, lease).manifest;
      terminal = true;
      if (typeof queue?.cover === 'function') {
        let covered = false;
        for (let attempt = 0; attempt < 3 && !covered; attempt += 1) {
          try {
            await queue.cover({ run, lease, manifest, mutationReceipt });
            covered = true;
          } catch { /* retry the idempotent durable coverage append */ }
        }
        if (!covered) {
          queueCoveragePending = true;
          failures.push(Object.freeze({
            code: 'queue-coverage-pending',
            stage: 'post-success',
            reason: 'window-coverage-failed',
          }));
        }
      }
      if (postTerminalSuccess !== null) {
        let postSuccessFailure = null;
        if (!mutationReceipt) {
          postSuccessFailure = Object.freeze({
            code: 'backup-pending',
            stage: 'post-success',
            reason: receiptIssue,
          });
        } else {
          try {
            const postSuccess = postSuccessOutcome(
              await postTerminalSuccess({ run, lease, manifest, mutationReceipt }),
            );
            if (postSuccess.status !== 'complete') {
              postSuccessFailure = Object.freeze({
                code: postSuccess.status === 'partial' ? 'backup-partial' : 'backup-pending',
                stage: 'post-success',
                reason: postSuccess.reason,
              });
            }
          } catch {
            postSuccessFailure = Object.freeze({
              code: 'backup-pending',
              stage: 'post-success',
              reason: 'backup-failed',
            });
          }
        }
        if (postSuccessFailure) {
          failures.push(postSuccessFailure);
          manifest = recordPostSuccessFailure(run, lease, postSuccessFailure);
        }
      }
    }
  } catch (error) {
    if (error instanceof ProviderLifecycleUnclosedError) {
      retainUnclosedAuthority = true;
      providerClosure = error.closure;
      const failure = Object.freeze({
        code: 'provider-lifecycle-unclosed',
        stage: 'finalise',
        reason: 'operator-intervention-required',
      });
      failures.push(failure);
      if (run) {
        if (recordFailure !== null) {
          try {
            await recordFailure({
              error,
              failedStage: 'finalise',
              run,
              lease,
              stageOutputs: Object.freeze(Object.fromEntries(outputs)),
            });
          } catch (recordError) {
            if (recordError instanceof LeaseLostError) throw recordError;
            failures.push(Object.freeze({
              code: 'failure-record-failed',
              stage: 'finalise',
              message: boundedText(recordError?.message, 220),
            }));
          }
        }
        appendRunEvent(run, {
          type: 'run.failure-recorded',
          stageId: 'finalise',
          idempotencyKey: `provider-lifecycle-unclosed-g${lease.generation}`,
          payload: {
            schemaVersion: 1,
            code: failure.code,
            reason: failure.reason,
          },
        }, lease);
        manifest = validateManifestAgreement(run, lease).manifest;
      }
      error.closure.then(() => {
        heartbeat?.stop();
        if (ownsLease && !released) {
          try { releaseScanLease(lease); released = true; } catch { /* recovery owns any successor fence */ }
        }
      });
    } else if (error instanceof PipelineInterruptedError) {
      retainInterruptedLease = true;
      throw error;
    } else if (error instanceof LeaseLostError) {
      failures.push(Object.freeze({ code: 'lease-lost', stage: outputs.size ? DURABLE_DISCOVERY_STAGES[outputs.size] ?? 'finalise' : 'initialise' }));
      manifest = run ? projectRunManifest(run.events) : null;
      return resultWithOutputs({
        runId: run?.runId ?? provisionalRunId,
        outcome: 'lease-lost',
        manifest,
        failures: Object.freeze(failures),
      }, outputs);
    } else {
      const failedStage = DURABLE_DISCOVERY_STAGES[outputs.size] ?? 'finalise';
      failures.push(Object.freeze({
        code: 'stage-failed',
        stage: failedStage,
        message: boundedText(error?.message, 220),
      }));
      if (run) {
        try {
          if (recordFailure !== null) {
            try {
              await recordFailure({
                error,
                failedStage,
                run,
                lease,
                stageOutputs: Object.freeze(Object.fromEntries(outputs)),
              });
            } catch (recordError) {
              if (recordError instanceof LeaseLostError) throw recordError;
              failures.push(Object.freeze({
                code: 'failure-record-failed',
                stage: failedStage,
                message: boundedText(recordError?.message, 220),
              }));
            }
          }
          appendRunEvent(run, {
            type: 'run.completed',
            stageId: 'finalise',
            idempotencyKey: `run-failed-g${lease.generation}`,
            payload: { schemaVersion: 1, outcome: 'failed' },
          }, lease);
          manifest = validateManifestAgreement(run, lease).manifest;
          terminal = true;
        } catch (commitError) {
          if (!(commitError instanceof LeaseLostError)) throw commitError;
        }
      }
    }
  } finally {
    if (!retainUnclosedAuthority) heartbeat?.stop();
    if (ownsLease && !released && !retainInterruptedLease && (terminal || !run)) {
      try { releaseScanLease(lease); released = true; } catch { /* lease loss is already reflected above */ }
    }
  }

  if (terminal && ownsLease && !queueCoveragePending) {
    const postTerminalDrain = await drainScanQueue(root, queue, compatibility, leaseOptions);
    if (postTerminalDrain.paused) {
      const pausedRun = openRunJournal(root, postTerminalDrain.paused.runId);
      return resultWithOutputs({
        runId: postTerminalDrain.paused.runId,
        outcome: 'in-progress',
        manifest: projectRunManifest(pausedRun.events),
        failures: Object.freeze([...failures, postTerminalDrain.paused.failure]),
      }, outputs, { providerClosure: postTerminalDrain.paused.closure });
    }
  }
  return resultWithOutputs({
    runId: run?.runId ?? provisionalRunId,
    outcome: manifest?.outcome ?? 'failed',
    manifest,
    failures: Object.freeze(failures),
  }, outputs, { providerClosure });
}

function boundedText(value, maximum = 220) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, maximum);
}

function safeDiagnostic(value) {
  const text = boundedText(value?.message ?? value, 220).toLowerCase();
  if (!text) return null;
  if (/no job sources are configured/.test(text)) return 'no-sources-configured';
  if (/not configured|without credentials|no supported .* enabled/.test(text)) return 'source-not-configured';
  if (/another scan is already running/.test(text)) return 'scan-overlap';
  if (/assessment.*(?:retry|retries|exhausted)|all candidate assessments/.test(text)) return 'assessment-retries-exhausted';
  if (/timed? ?out|timeout/.test(text)) return 'source-timeout';
  if (/authentication|unauthori[sz]ed|forbidden/.test(text)) return 'source-authentication-failed';
  if (/provider.*fail/.test(text)) return 'provider-failed';
  if (/unavailable|offline|network|connection/.test(text)) return 'source-unavailable';
  return 'redacted-diagnostic';
}

function safeSourceUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    const canonical = parsed.toString().replace(/\/$/, '');
    return canonical.length <= 2048 ? canonical : null;
  } catch { return null; }
}

export const SCAN_ASSESSMENT_SCHEMA = ASSESSMENT_RESPONSE_SCHEMA;

function stableAssessmentJobId(candidate) {
  const supplied = String(candidate?.vacancyId || '');
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(supplied)) return supplied;
  return `vacancy-${createHash('sha256')
    .update(JSON.stringify(jobIdentity(candidate)))
    .digest('hex')
    .slice(0, 32)}`;
}

export async function assessScanCandidates({
  run,
  lease,
  candidates,
  compatibility,
  invokeProvider,
  contextBudgetCharacters,
  contextOverheadCharacters = 0,
  timeoutMs = 20 * 60 * 1000,
  maxInputTokens = 75_000,
  providerSubstitution = null,
  heartbeat = null,
  heartbeatIntervalMs,
  contextDigests,
} = {}) {
  if (!run || !lease || !compatibility || !Array.isArray(candidates)) {
    throw new TypeError('scan assessment requires a run, lease, compatibility and candidates');
  }
  const requiredContextDigests = [
    'scoringConfigDigest', 'profileDigest', 'calibrationDigest', 'masterCvDigest',
  ];
  if (!contextDigests || Object.keys(contextDigests).sort().join(',') !== requiredContextDigests.sort().join(',')
    || requiredContextDigests.some((key) => !/^[a-f0-9]{64}$/.test(contextDigests[key]))) {
    throw new TypeError('scan assessment requires complete privacy-safe context digests');
  }
  const provenance = {
    profileVersion: compatibility.profileVersion,
    promptVersion: compatibility.promptVersion,
    assessmentSchemaVersion: compatibility.assessmentSchemaVersion,
    pipelineVersion: compatibility.pipelineVersion,
    provider: compatibility.provider,
    model: compatibility.model,
  };
  const batches = planAssessmentBatches({
    runId: run.runId,
    jobs: candidates.map((candidate) => ({
      ...candidate,
      assessmentJobId: stableAssessmentJobId(candidate),
      assessmentInput: promptCandidate(candidate),
      // One extra character accounts for the comma between adjacent JSON
      // array items, so planning never underestimates the assembled context.
      contextCharacters: JSON.stringify(promptCandidate(candidate)).length + 1,
    })),
    provenance,
    contextBudgetCharacters,
    contextOverheadCharacters,
    timeoutMs,
    maxInputTokens,
    contextDigests,
  });
  return resumeAssessments(run, {
    batches,
    lease,
    invokeProvider,
    providerSubstitution,
    heartbeat,
    heartbeatIntervalMs,
  });
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'opportunity';
}

function mandatorySignals(description, requirements) {
  const sourceRequirements = String(requirements || '').split(/(?:\r?\n|;\s*)/)
    .map((text) => text.trim())
    .filter((text) => text && !/\b(?:benefits?|perks?|stock options?|compensation|salary|remote-friendly)\b/i.test(text));
  const explicitLanguage = String(description || '').split(/(?:\r?\n|[.;]\s+)/)
    .map((text) => text.trim()).filter((text) => text && /\b(?:required|essential|must|mandatory|non-negotiable)\b/i.test(text));
  return [...new Set([...sourceRequirements, ...explicitLanguage])]
    .slice(0, 12).map((text, index) => ({ id: `mandatory-${String(index + 1).padStart(2, '0')}`, text: text.slice(0, 300) }));
}

function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
}

function compareText(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sourceReferences(vacancy) {
  return (vacancy?.sourceReferences || []).map((reference) => ({
    source: reference.source || reference.sourceName || '',
    providerId: reference.providerId || reference.sourceRecordId || '',
    url: reference.url || reference.sourceUrl || '',
  }));
}

function assessmentVacancy(vacancy) {
  const observations = vacancy?.observations || [];
  const observation = observations[0] || {};
  const { observations: omittedObservations, ...canonicalVacancy } = vacancy || {};
  void omittedObservations;
  const references = sourceReferences(vacancy);
  const url = vacancy?.canonicalUrl || observation.sourceUrl || references[0]?.url || '';
  return {
    ...canonicalVacancy,
    company: valueOf(vacancy?.employer) || '',
    role: valueOf(vacancy?.title) || '',
    url,
    location: valueOf(vacancy?.location) || '',
    workingType: valueOf(vacancy?.workingPattern) || '',
    salary: valueOf(vacancy?.compensation) || null,
    postedDate: vacancy?.postedAt || null,
    source: observation.source || references[0]?.source || '',
    providerId: observation.sourceRecordId || references[0]?.providerId || '',
    sourceReferences: references,
    sources: [...new Set([url, ...references.map((reference) => reference.url)].filter(Boolean))],
    duplicateCount: Math.max(1, Number(observations.length || 1)),
    contentFingerprint: vacancyContentFingerprint(vacancy),
    tags: [],
    requirements: '',
  };
}

function laneDiscoveryCounts(vacancies, profile, history) {
  const unseenByLane = new Map();
  for (const vacancy of vacancies || []) {
    if (vacancyNoveltyComparison(vacancy, profile, history) !== 'unseen') continue;
    const identity = String(vacancy?.vacancyId || vacancy?.canonicalUrl || '');
    if (!identity) continue;
    for (const laneId of [...new Set(vacancy?.laneIds || [])]) {
      if (!unseenByLane.has(laneId)) unseenByLane.set(laneId, new Set());
      unseenByLane.get(laneId).add(identity);
    }
  }
  return [...unseenByLane].sort(([left], [right]) => compareText(left, right))
    .map(([laneId, identities]) => ({ laneId, new: identities.size }));
}

function candidateFromSelected(vacancy, index) {
  const candidate = assessmentVacancy(vacancy);
  const semantic = candidate.semanticEvidence || null;
  const semanticSignals = (semantic?.mandatorySignals || []).map((signal) => ({
    id: signal.id,
    text: `Advert mandatory requirement: ${signal.fact || 'requirement disclosed'}.`,
  }));
  const semanticDescriptionFacts = semantic ? [
    ...(semantic.profileRuleMatches || []).map((rule) => (
      typeof rule === 'string' ? null : rule.fact
    )),
    ...(semantic.responsibilityFacts || []),
  ].filter(Boolean) : [];
  const semanticDescription = semantic
    ? (semantic.descriptionPresent === false
      ? ''
      : [...new Set(semanticDescriptionFacts)]
        .map((fact) => `Advert responsibility: ${fact}.`).join(' '))
    : null;
  return {
    ...candidate,
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    description: semanticDescription ?? String(candidate.description || '').slice(0, 1200),
    mandatorySignals: semantic ? semanticSignals : mandatorySignals(candidate.description, candidate.requirements),
  };
}

export function assessmentCandidatesForSelection(selected) {
  return (selected || []).map(candidateFromSelected);
}

const VACANCY_DECISION_HISTORY_LIMIT = 512;

export function readVacancyDecisionHistory(root, { limit = VACANCY_DECISION_HISTORY_LIMIT } = {}) {
  const file = workspacePaths(root).scanRuns;
  if (!fs.existsSync(file)) return [];
  const boundedLimit = Math.max(0, Math.min(VACANCY_DECISION_HISTORY_LIMIT, Math.floor(Number(limit) || 0)));
  if (!boundedLimit) return [];
  const records = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    let run;
    try {
      run = JSON.parse(line);
    } catch {
      continue;
    }
    for (const item of [...(Array.isArray(run?.reviewed) ? run.reviewed : [])].reverse()) {
      if (!item?.company || !item?.role || !item?.outcome) continue;
      records.push({
        vacancyId: boundedText(item.vacancyId, 160) || null,
        company: boundedText(item.company, 120),
        role: boundedText(item.role, 160),
        source: boundedText(item.source, 80),
        url: safeSourceUrl(item.sourceUrl),
        outcome: boundedText(item.outcome, 80),
        contentFingerprint: /^[a-f0-9]{64}$/.test(String(item.contentFingerprint || ''))
          ? item.contentFingerprint
          : null,
        profileId: boundedText(item.profileId || run.profile_id, 80),
        learningVersionId: boundedText(
          item.learningVersionId || run.learning_version_id || 'learning-baseline',
          80,
        ),
        assessedAt: boundedText(run.timestamp, 80),
      });
      if (records.length >= boundedLimit) return records;
    }
  }
  return records;
}

function observationInputs(sources) {
  const observations = [];
  const funnelSources = {};
  for (const [sourceName, source] of Object.entries(sources || {})) {
    if (Array.isArray(source?.observations)) {
      observations.push(...source.observations.map((observation) => ({
        ...observation,
        collectionSource: observation?.collectionSource || sourceName,
      })));
      funnelSources[sourceName] = {
        count: Number(source.count || source.observations.length),
        failedRecords: Number(source.failedRecords || 0),
        errors: Array.from({ length: Number(source.sourceErrorCount || 0) }, () => 'redacted'),
      };
      continue;
    }
    const jobs = [...(source?.jobs || [])];
    const normalised = jobs.map((job) => normaliseObservation(job, {
      sourceName: job?.source || sourceName,
      collectionSource: sourceName,
      fetchedAt: source?.fetchedAt || source?.generatedAt || null,
      laneId: job?.laneId || job?.source || source?.laneId || sourceName,
      laneIds: job?.laneIds || source?.laneIds || null,
      roleFamily: job?.roleFamilyId || job?.roleFamily
        || source?.roleFamilyId || source?.roleFamily || null,
    })).filter(Boolean);
    observations.push(...normalised);
    funnelSources[sourceName] = {
      ...source,
      jobs,
      failedRecords: jobs.length - normalised.length,
    };
  }
  return { observations, funnelSources };
}

// The deterministic discovery boundary deliberately evaluates every
// normalised, canonical vacancy before it applies the bounded assessment set.
// Candidate identifiers are generated only after selection, so a source's
// response order cannot leak into provider-facing identities.
export function prepareRankedDiscovery({
  sources, profile, tracker = { opportunities: [] }, runId = '', limit = DEFAULT_CANDIDATE_LIMIT,
  relevanceThreshold, decisionHistory = [], learningPolicy = null,
} = {}) {
  if (!profile || profile.status !== 'published') throw new Error('ranked discovery requires a published search profile');
  const input = observationInputs(sources);
  const observations = input.observations;
  const initialFunnel = createDiscoveryFunnel(input.funnelSources);
  const canonical = canonicaliseObservations(observations);
  const vacancies = canonical.vacancies.map(assessmentVacancy);
  const discoveryCounts = laneDiscoveryCounts(vacancies, profile, tracker?.opportunities || []);
  const filtered = filterVacancies(vacancies, profile, { learningPolicy });
  const ranked = rankVacancies(filtered.eligible, profile, tracker?.opportunities || [], { learningPolicy });
  const lifecycle = partitionVacanciesForAssessment(ranked, decisionHistory, { profileId: profile.id });
  const configuredThreshold = Number(relevanceThreshold ?? profile?.selection?.relevanceThreshold ?? 1);
  const threshold = Number.isFinite(configuredThreshold) ? Math.max(Number.EPSILON, configuredThreshold) : 1;
  const selection = selectVacancies(lifecycle.eligible, {
    limit,
    threshold,
    exploration: Number(profile?.selection?.exploration || 0),
    seed: runId,
  });
  selection.assessmentSkipped = lifecycle.skipped;
  const funnel = assertDiscoveryFunnel(advanceDiscoveryFunnel(initialFunnel, 'selection', {
    parsed: initialFunnel.sourceRecords,
    normalised: observations.length,
    duplicateObservations: canonical.duplicateObservations,
    uniqueVacancies: vacancies.length,
    deterministicallyExcluded: new Set(filtered.excluded.map((item) => String(item.vacancyId))).size,
    eligible: filtered.eligible.length,
    ranked: ranked.length,
    aboveThreshold: ranked.filter((vacancy) => Number(vacancy.preRankScore || 0) >= threshold).length,
    selected: selection.selected.length,
  }));
  const vacancyById = new Map(vacancies.map((vacancy) => [String(vacancy.vacancyId || vacancy.canonicalUrl), vacancy]));
  const exclusions = filtered.excluded.map((item) => {
    const vacancy = vacancyById.get(String(item.vacancyId));
    return {
      ...(vacancy || {}),
      ...item,
      source: vacancy?.source || '',
      url: vacancy?.url || vacancy?.canonicalUrl || '',
    };
  });
  return {
    observations,
    vacancies,
    discoveryCounts,
    exclusions,
    reconsidered: filtered.reconsidered || [],
    ranked,
    selection,
    funnel,
    candidates: assessmentCandidatesForSelection(selection.selected),
  };
}

const RANKED_STAGE_ARTIFACT_FIELDS = Object.freeze({
  collect: Object.freeze(['generatedAt', 'lanes', 'queries', 'sources']),
  normalise: Object.freeze(['generatedAt', 'initialFunnel', 'observations', 'queries']),
  deduplicate: Object.freeze(['duplicateObservations', 'initialFunnel', 'normalisedCount', 'vacancies']),
  filter: Object.freeze(['discoveryCounts', 'duplicateObservations', 'eligible', 'exclusions', 'initialFunnel', 'normalisedCount', 'reconsidered', 'uniqueVacancies']),
  rank: Object.freeze(['discoveryCounts', 'duplicateObservations', 'exclusions', 'initialFunnel', 'normalisedCount', 'ranked', 'reconsidered', 'uniqueVacancies']),
  select: Object.freeze(['candidates', 'discoveryCounts', 'exclusions', 'funnel', 'ranked', 'reconsidered', 'selection']),
});
const OMIT_PRIVATE_STAGE_KEY = /^(?:access[-_]?token|advert[-_]?body|api[-_]?(?:key|token)|auth(?:orization)?|body|cookies?|credentials?|cv|description|headers?|html|master[-_]?cv|password|payload|profile[-_]?evidence|prompt|raw[-_]?(?:html|response)|requirements|response|secret(?:[-_]?(?:key|token))?|token|transcript)$/i;
const URL_STAGE_KEY = /(?:^url$|url$)/i;

function privacySafeStageUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '').slice(0, 2_048);
  } catch {
    return null;
  }
}

function encodeRankedStageValue(value) {
  if (Array.isArray(value)) return value.map(encodeRankedStageValue);
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return privacySafeStageUrl(value) ?? value.slice(0, 4_096);
  }
  const encoded = {};
  for (const [key, item] of Object.entries(value)) {
    if (OMIT_PRIVATE_STAGE_KEY.test(key)) continue;
    if (URL_STAGE_KEY.test(key) && typeof item === 'string') {
      encoded[key] = privacySafeStageUrl(item);
      continue;
    }
    encoded[key] = encodeRankedStageValue(item);
  }
  return encoded;
}

export function durableScanProjection(value) {
  return encodeRankedStageValue(value);
}

function semanticText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const SEMANTIC_FACT_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'be', 'for', 'from', 'in', 'is', 'must', 'mandatory',
  'negotiable', 'of', 'on', 'or', 'required', 'requirement', 'requirements',
  'role', 'the', 'this', 'to', 'with', 'you', 'your',
  'advert', 'authorization', 'bearer', 'credential', 'credentials', 'jwt', 'key',
  'legacy', 'password', 'private', 'secret', 'session', 'signature', 'token',
]);
const CREDENTIAL_ASSIGNMENT = /(?:^|[^a-z0-9])(?:(?:api|private|secret|session|access|client|refresh|auth)[\s._-]*(?:key|token|id|secret)|authorization|cookie|credential|jwt|password|secret|session|token|key)(?![a-z0-9])\s*[:=]\s*\S+/i;
const CREDENTIAL_LABEL_VALUE = /(?:^|[^a-z0-9])(?:(?:api|private|secret|session|access|client|refresh|auth)[\s._-]*(?:key|token|secret)|authorization|cookie|credential|jwt|password)(?![a-z0-9])\s+(?:sk-(?:proj-)?[a-z0-9_-]{8,}|[a-z0-9._~+/=-]{16,})/i;
const HIGH_SIGNAL_CREDENTIAL = /\b(?:sk-(?:proj-)?[a-z0-9_-]{8,}|gh[opsu]_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{16,})\b/i;
const AUTHORIZATION_VALUE = /\b(?:authorization\s*:?\s*)?(?:basic|bearer)\s+[a-z0-9._~+/=-]+/i;
const JWT_VALUE = /\beyj[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i;
const URL_USERINFO_VALUE = /https?:\/\/[^/\s:@]+:[^/\s@]+@/i;

function credentialShapedSemanticText(value) {
  const text = String(value || '');
  return CREDENTIAL_ASSIGNMENT.test(text)
    || CREDENTIAL_LABEL_VALUE.test(text)
    || HIGH_SIGNAL_CREDENTIAL.test(text)
    || AUTHORIZATION_VALUE.test(text)
    || JWT_VALUE.test(text)
    || URL_USERINFO_VALUE.test(text);
}

function semanticFact(value) {
  if (credentialShapedSemanticText(value)) return 'sensitive requirement redacted';
  const tokens = semanticText(value).split(' ')
    .filter((token) => token && !SEMANTIC_FACT_STOPWORDS.has(token))
    .slice(0, 16);
  return tokens.join(' ').slice(0, 160);
}

function responsibilityFacts(description) {
  return [...new Set(String(description || '').split(/(?:\r?\n|[.;]\s+)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map(semanticFact)
    .filter(Boolean))].slice(0, 6);
}

function semanticPhraseMatches(value, phrase) {
  const actual = new Set(semanticText(value).split(' ').filter(Boolean));
  const expected = semanticText(phrase).split(' ').filter(Boolean);
  return expected.length > 0 && expected.every((token) => actual.has(token));
}

function digestText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function semanticObservation(job, sourceName, source, profile, { durableUrls = true } = {}) {
  const observation = normaliseObservation(job, {
    sourceName: job?.source || sourceName,
    fetchedAt: source?.fetchedAt || source?.generatedAt || null,
    laneId: job?.laneId || job?.source || source?.laneId || sourceName,
    laneIds: job?.laneIds || source?.laneIds || null,
    roleFamily: job?.roleFamilyId || job?.roleFamily
      || source?.roleFamilyId || source?.roleFamily || null,
  });
  if (!observation) return null;
  const description = String(job?.description || '');
  const requirements = String(job?.requirements || '');
  const identity = jobIdentity(observation);
  const descriptionRules = [
    ...['responsibilities', 'skills', 'qualifications', 'eligibility', 'mobility', 'industries', 'sectors']
      .flatMap((field) => (profile?.target?.[field] || [])
        .map((rule) => ({ section: 'target', field, rule }))),
    ...[
      'excludedResponsibilities', 'excludedSkills', 'excludedQualifications',
      'excludedEligibility', 'excludedMobility', 'excludedIndustries', 'excludedSectors',
    ].flatMap((field) => (profile?.negative?.[field] || [])
      .map((rule) => ({ section: 'negative', field, rule }))),
  ];
  const descriptionDigest = digestText(description);
  const profileRuleEvidence = [...new Map(descriptionRules.map(({ section, field, rule }) => {
    const id = profileRuleId(section, field, rule);
    const matched = semanticPhraseMatches(description, rule?.value);
    return [id, {
      id,
      fact: semanticFact(rule.value),
      status: matched ? 'matched' : 'unknown',
      evidence: [{
        source: String(observation.source || '').slice(0, 80),
        providerId: String(observation.sourceRecordId || '').slice(0, 160),
        descriptionDigest,
        provenance: 'deterministic-extraction',
      }],
    }];
  })).values()];
  const profileRuleMatches = profileRuleEvidence
    .filter(({ status }) => status === 'matched')
    .map(({ status, ...evidence }) => evidence);
  const signals = mandatorySignals(description, requirements).map((signal) => ({
    id: signal.id,
    digest: digestText(signal.text),
    kind: 'mandatory-language',
    fact: semanticFact(signal.text) || 'requirement disclosed',
  }));
  const {
    description: omittedDescription,
    sourceUrl,
    canonicalUrl,
    ...safeObservation
  } = observation;
  void omittedDescription;
  return {
    ...safeObservation,
    sourceUrl: durableUrls ? privacySafeStageUrl(sourceUrl) : sourceUrl,
    canonicalUrl: durableUrls ? privacySafeStageUrl(canonicalUrl) : canonicalUrl,
    jobIdentity: {
      company: identity.company,
      title: identity.title,
      location: identity.location,
      seniority: identity.seniority,
      evidenceTokenDigests: identity.evidenceTokens.map(digestText),
    },
    semanticEvidence: {
      descriptionPresent: Boolean(description.trim()),
      descriptionDigest,
      descriptionLength: description.length,
      profileRuleEvidence,
      profileRuleMatches,
      responsibilityFacts: responsibilityFacts(description),
      mandatorySignals: signals,
    },
  };
}

function semanticCollectedSource(source, sourceName, profile, options = {}) {
  const jobs = Array.isArray(source?.jobs) ? source.jobs : [];
  const observations = jobs
    .map((job) => semanticObservation(job, sourceName, source, profile, options))
    .filter(Boolean);
  const status = ['healthy', 'degraded', 'unavailable'].includes(source?.status) ? source.status : 'unavailable';
  const employerMonitoring = sourceName === 'employer_registry'
    && source?.registrySnapshot && Array.isArray(source?.checks)
    ? {
      registrySnapshot: structuredClone(validateEmployerRegistry(source.registrySnapshot)),
      registryRevision: String(source.registryRevision || '').slice(0, 128),
      checks: structuredClone(source.checks.slice(0, 24)),
    }
    : {};
  return {
    configured: Boolean(source?.configured),
    status,
    count: Number.isFinite(Number(source?.count)) ? Math.max(0, Number(source.count)) : jobs.length,
    queryCounts: Object.fromEntries(Object.entries(source?.queryCounts || {})
      .slice(0, 128)
      .map(([query, count]) => [
        String(query).slice(0, 300),
        Number.isSafeInteger(Number(count)) && Number(count) >= 0 ? Number(count) : 0,
      ])),
    queryFailures: Object.fromEntries(Object.entries(source?.queryFailures || {})
      .slice(0, 128)
      .map(([query, code]) => [
        String(query).slice(0, 300),
        String(code).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 100),
      ])),
    failedRecords: Math.max(0, Number(source?.failedRecords || 0) + jobs.length - observations.length),
    sourceErrorCount: Array.isArray(source?.errors) ? source.errors.length : 0,
    observations,
    ...employerMonitoring,
  };
}

function legacySemanticJob(job, sourceName, { durableUrls = true } = {}) {
  const candidate = normaliseJob(job);
  if (!candidate) return null;
  const description = String(job?.description || '');
  const requirements = String(job?.requirements || '');
  return {
    company: candidate.company,
    title: candidate.role,
    url: durableUrls ? privacySafeStageUrl(candidate.url) : candidate.url,
    location: candidate.location,
    salary: candidate.salary,
    workingType: candidate.workingType,
    postedDate: candidate.postedDate,
    source: candidate.source || sourceName,
    providerId: candidate.providerId,
    sourceReferences: candidate.sourceReferences.map((reference) => ({
      ...reference,
      url: durableUrls ? privacySafeStageUrl(reference.url) : reference.url,
    })),
    semanticEvidence: {
      descriptionPresent: Boolean(description.trim()),
      descriptionDigest: digestText(description),
      descriptionLength: description.length,
      requirementsDigest: digestText(requirements),
      requirementsLength: requirements.length,
      responsibilityFacts: responsibilityFacts(description),
      mandatorySignals: mandatorySignals(description, requirements).map((signal) => ({
        id: signal.id,
        digest: digestText(signal.text),
        kind: 'mandatory-language',
        fact: semanticFact(signal.text) || 'requirement disclosed',
      })),
    },
  };
}

function legacySemanticCollectedSource(source, sourceName, options = {}) {
  const jobs = Array.isArray(source?.jobs) ? source.jobs : [];
  const semanticJobs = jobs.map((job) => legacySemanticJob(job, sourceName, options)).filter(Boolean);
  return {
    configured: Boolean(source?.configured),
    status: ['healthy', 'degraded', 'unavailable'].includes(source?.status) ? source.status : 'unavailable',
    count: Number.isFinite(Number(source?.count)) ? Math.max(0, Number(source.count)) : jobs.length,
    queryCounts: Object.fromEntries(Object.entries(source?.queryCounts || {})
      .slice(0, 128)
      .map(([query, count]) => [
        String(query).slice(0, 300),
        Number.isSafeInteger(Number(count)) && Number(count) >= 0 ? Number(count) : 0,
      ])),
    queryFailures: Object.fromEntries(Object.entries(source?.queryFailures || {})
      .slice(0, 128)
      .map(([query, code]) => [
        String(query).slice(0, 300),
        String(code).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 100),
      ])),
    failedRecords: Math.max(0, Number(source?.failedRecords || 0) + jobs.length - semanticJobs.length),
    sourceErrorCount: Array.isArray(source?.errors) ? source.errors.length : 0,
    jobs: semanticJobs,
  };
}

function encodePipelineStageValue(stageId, value, profile = null, { durableUrls = true } = {}) {
  if (stageId !== 'collect') return encodeRankedStageValue(value);
  return {
    generatedAt: String(value?.generatedAt || '').slice(0, 80) || null,
    lanes: (Array.isArray(value?.lanes) ? value.lanes : []).slice(0, 32).map((lane) => ({
      id: String(lane?.id || '').slice(0, 80),
      query: String(lane?.query || '').slice(0, 300),
      queryFingerprint: String(lane?.queryFingerprint || '').slice(0, 64),
      source: String(lane?.source || '').slice(0, 80),
      priority: Number.isFinite(Number(lane?.priority)) ? Number(lane.priority) : 0,
      priorityBand: String(lane?.priorityBand || '').slice(0, 40),
      roleFamily: String(lane?.roleFamily || '').slice(0, 160) || null,
    })),
    queries: (Array.isArray(value?.queries) ? value.queries : [])
      .slice(0, 128)
      .map((query) => String(query || '').slice(0, 300)),
    sources: Object.fromEntries(Object.entries(value?.sources || {})
      .slice(0, 128)
      .map(([source, result]) => [
        String(source).slice(0, 80),
        profile
          ? semanticCollectedSource(result, source, profile, { durableUrls })
          : legacySemanticCollectedSource(result, source, { durableUrls }),
      ])),
  };
}

function decodeRankedStageValue(value) {
  if (Array.isArray(value)) return value.map(decodeRankedStageValue);
  if (!value || typeof value !== 'object') return value;
  const decoded = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'advertExcerpt') {
      decoded.description = String(item || '');
    } else if (key === 'requirementExcerpt') {
      decoded.requirements = String(item || '');
    } else {
      decoded[key] = decodeRankedStageValue(item);
    }
  }
  return decoded;
}

function withRankedArtifactCodec(stageId, execute, profile = null) {
  const fields = RANKED_STAGE_ARTIFACT_FIELDS[stageId];
  Object.defineProperty(execute, 'artifactCodec', {
    enumerable: false,
    value: Object.freeze({
      encode(value) {
        const actual = Object.keys(value || {}).sort();
        if (actual.join(',') !== fields.join(',')) {
          throw new TypeError(`ranked ${stageId} stage returned an unsupported artifact schema`);
        }
        return encodePipelineStageValue(stageId, value, profile);
      },
      decode: decodeRankedStageValue,
      transient(value) {
        return stageId === 'collect'
          ? encodePipelineStageValue(stageId, value, profile, { durableUrls: false })
          : value;
      },
    }),
  });
  return execute;
}

export function createRankedDiscoveryStages({
  collect,
  profile,
  tracker = { opportunities: [] },
  decisionHistory = [],
  learningPolicy = null,
  limit = DEFAULT_CANDIDATE_LIMIT,
  relevanceThreshold,
} = {}) {
  if (typeof collect !== 'function') throw new TypeError('ranked discovery collection stage is required');
  if (!profile || profile.status !== 'published') throw new Error('ranked discovery requires a published search profile');
  const collectWithLanes = async (...args) => {
    const value = await collect(...args);
    return {
      ...value,
      lanes: Array.isArray(value?.lanes) ? value.lanes : [],
    };
  };
  return {
    collect: withRankedArtifactCodec('collect', collectWithLanes, profile),
    normalise: withRankedArtifactCodec('normalise', function normaliseStage({ priorArtifact }) {
      const input = observationInputs(priorArtifact?.sources);
      return {
        generatedAt: priorArtifact?.generatedAt || null,
        queries: priorArtifact?.queries || [],
        observations: input.observations,
        initialFunnel: createDiscoveryFunnel(input.funnelSources),
      };
    }),
    deduplicate: withRankedArtifactCodec('deduplicate', function deduplicateStage({ priorArtifact }) {
      const canonical = canonicaliseObservations(priorArtifact.observations);
      return {
        initialFunnel: priorArtifact.initialFunnel,
        normalisedCount: priorArtifact.observations.length,
        vacancies: canonical.vacancies.map(assessmentVacancy),
        duplicateObservations: canonical.duplicateObservations,
      };
    }),
    filter: withRankedArtifactCodec('filter', function filterStage({ priorArtifact }) {
      const filtered = filterVacancies(priorArtifact.vacancies, profile, { learningPolicy });
      const vacancyById = new Map(priorArtifact.vacancies.map((vacancy) => [
        String(vacancy.vacancyId || vacancy.canonicalUrl),
        vacancy,
      ]));
      return {
        initialFunnel: priorArtifact.initialFunnel,
        normalisedCount: priorArtifact.normalisedCount,
        duplicateObservations: priorArtifact.duplicateObservations,
        uniqueVacancies: priorArtifact.vacancies.length,
        discoveryCounts: laneDiscoveryCounts(
          priorArtifact.vacancies,
          profile,
          tracker?.opportunities || [],
        ),
        eligible: filtered.eligible,
        reconsidered: filtered.reconsidered || [],
        exclusions: filtered.excluded.map((item) => {
          const vacancy = vacancyById.get(String(item.vacancyId));
          return {
            ...(vacancy || {}),
            ...item,
            source: vacancy?.source || '',
            url: vacancy?.url || vacancy?.canonicalUrl || '',
          };
        }),
      };
    }),
    rank: withRankedArtifactCodec('rank', function rankStage({ priorArtifact }) {
      return {
        discoveryCounts: priorArtifact.discoveryCounts,
        initialFunnel: priorArtifact.initialFunnel,
        normalisedCount: priorArtifact.normalisedCount,
        duplicateObservations: priorArtifact.duplicateObservations,
        uniqueVacancies: priorArtifact.uniqueVacancies,
        exclusions: priorArtifact.exclusions,
        reconsidered: priorArtifact.reconsidered,
        ranked: rankVacancies(
          priorArtifact.eligible,
          profile,
          tracker?.opportunities || [],
          { learningPolicy },
        ),
      };
    }),
    select: withRankedArtifactCodec('select', function selectStage({ run, priorArtifact }) {
      const configuredThreshold = Number(relevanceThreshold ?? profile?.selection?.relevanceThreshold ?? 1);
      const threshold = Number.isFinite(configuredThreshold) ? Math.max(Number.EPSILON, configuredThreshold) : 1;
      const lifecycle = partitionVacanciesForAssessment(
        priorArtifact.ranked,
        decisionHistory,
        { profileId: profile.id },
      );
      const selection = selectVacancies(lifecycle.eligible, {
        limit,
        threshold,
        exploration: Number(profile?.selection?.exploration || 0),
        seed: run.runId,
      });
      selection.assessmentSkipped = lifecycle.skipped;
      const funnel = assertDiscoveryFunnel(advanceDiscoveryFunnel(priorArtifact.initialFunnel, 'selection', {
        parsed: priorArtifact.initialFunnel.sourceRecords,
        normalised: priorArtifact.normalisedCount,
        duplicateObservations: priorArtifact.duplicateObservations,
        uniqueVacancies: priorArtifact.uniqueVacancies,
        deterministicallyExcluded: new Set(priorArtifact.exclusions.map((item) => String(item.vacancyId))).size,
        eligible: priorArtifact.ranked.length,
        ranked: priorArtifact.ranked.length,
        aboveThreshold: priorArtifact.ranked
          .filter((vacancy) => Number(vacancy.preRankScore || 0) >= threshold).length,
        selected: selection.selected.length,
      }));
      return {
        discoveryCounts: priorArtifact.discoveryCounts,
        exclusions: priorArtifact.exclusions,
        reconsidered: priorArtifact.reconsidered,
        ranked: priorArtifact.ranked,
        selection,
        funnel,
        candidates: assessmentCandidatesForSelection(selection.selected),
      };
    }),
  };
}

// Deprecated: retained only for beta.22 compatibility consumers. Ranked
// discovery uses filterVacancies() and never performs whole-prose matching.
export function applyHardExclusions(candidates, exclusions = []) {
  const terms = (exclusions || []).map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
  const kept = [];
  const excluded = [];
  for (const candidate of candidates || []) {
    const matches = terms.filter((term) => String(candidate?.description || '').toLowerCase().includes(term));
    if (matches.length) excluded.push({ ...candidate, hardExclusionMatches: matches });
    else kept.push(candidate);
  }
  return { candidates: kept, excluded };
}

export const DEFAULT_CANDIDATE_LIMIT = 60;

// Fields the assessment prompt actually reads. Everything else stays in the
// local scan bundle: `requirements` and `sourceReferences` duplicate content
// the model already receives, and `providerId`/`duplicateCount` are bookkeeping.
const PROMPT_CANDIDATE_FIELDS = [
  'candidateId', 'company', 'role', 'url', 'location', 'salary', 'workingType',
  'postedDate', 'source', 'tags', 'description', 'mandatorySignals',
];

// `second-pass` previously changed nothing but the artifact label: the second
// provider re-collected every source and re-scored every candidate, so two
// daily jobs cost roughly double for largely the same work. A verification pass
// should re-examine what the primary scan actually decided today — the roles it
// kept, and the ones close enough to the threshold that a second opinion could
// change the outcome. Falls back to the full set when there is nothing from
// today to verify, so a standalone second-pass run still does useful work.
export function verificationCandidates(candidates, tracker, today, policy = {}) {
  const checkScore = Number(policy.checkScore ?? 55);
  const recentUrls = new Set();
  for (const entry of tracker?.opportunities || []) {
    const recent = entry.lastChecked === today || entry.firstSeen === today;
    const worthVerifying = recent && isVerifiable(entry.status)
      && (typeof entry.score !== 'number' || entry.score >= checkScore - 10);
    if (!worthVerifying) continue;
    for (const url of entry.sources || []) if (url) recentUrls.add(String(url));
  }
  if (!recentUrls.size) return { candidates, verified: false };
  const selected = candidates.filter((candidate) => (candidate.sources || [candidate.url])
    .some((url) => recentUrls.has(String(url))));
  return selected.length ? { candidates: selected, verified: true } : { candidates, verified: false };
}

// Existing untriaged jobs must not live in the inbox forever merely because a
// later scan did not rediscover them. Recheck only `new` entries; every status
// set by the user is deliberately outside this maintenance path.
export function inboxRecheckCandidates(tracker, incomingCandidates = []) {
  const checkable = [];
  const missingSource = [];
  for (const entry of tracker?.opportunities || []) {
    if (entry.status !== 'new') continue;
    if (incomingCandidates.some((candidate) => sameUnderlyingJob(entry, candidate))) continue;
    const url = (entry.sources || []).map(safeSourceUrl).find(Boolean);
    const candidate = { _inboxRecheck: true, _trackerId: entry.id, url };
    if (url) checkable.push(candidate);
    else missingSource.push({ ...candidate, liveness: { state: 'gone', reason: 'no individual advert URL is stored' } });
  }
  return { checkable, missingSource };
}

function archiveStaleInboxEntries(tracker, entries, date) {
  const reasons = new Map(entries.map((item) => [item._trackerId, item.liveness?.reason || 'advert is no longer live']));
  let archived = 0;
  for (const entry of tracker.opportunities || []) {
    const reason = reasons.get(entry.id);
    if (entry.status !== 'new' || !reason) continue;
    entry.status = 'ignore';
    entry.tags = [...new Set([...(entry.tags || []), 'Advert unavailable'])];
    const note = `[${date}] Removed from Jobs automatically: ${reason}.`;
    if (!String(entry.notes || '').includes(note)) entry.notes = entry.notes ? `${entry.notes}\n${note}` : note;
    entry.lastChecked = date;
    archived += 1;
  }
  return archived;
}

export function promptCandidate(candidate) {
  return Object.fromEntries(PROMPT_CANDIDATE_FIELDS
    .filter((field) => candidate[field] !== undefined)
    .map((field) => [field, candidate[field]]));
}

export function buildAssessmentPrompt(context, {
  kind = 'batch',
  validationFailures = {},
} = {}) {
  const retryInstruction = kind === 'repair'
    ? `Repair only the supplied invalid jobs against these bounded validation codes: ${JSON.stringify(validationFailures)}`
    : kind === 'retry'
      ? 'This is one clean per-job retry. Produce a fresh assessment without relying on any previous provider response.'
      : 'This is the initial assessment batch.';
  return [
    'Assess only the supplied Scout candidates and return one result per candidate using only the required JSON schema.',
    'Scout has already normalised, deduplicated, filtered, ranked and selected these vacancies. Do not assign numeric scores, categories or deterministic exclusions; do not reorder candidates, repair source coverage or invent user preferences.',
    'Judge nuanced responsibility fit from advert and profile evidence. Record transferable experience, explicit uncertainty, evidence-backed strengths and concerns, and a keep, check or discard recommendation.',
    'Cover every supplied mandatorySignals item and copy its id into advertEvidenceId. For an additional mandatory requirement you identify, use a concise provider-<slug> advertEvidenceId.',
    'Every met mandatory requirement needs explicit profile evidence. Use unknown when evidence is absent or ambiguous.',
    'Never access files, run commands, browse, write artifacts, apply, or send outreach.',
    retryInstruction,
    JSON.stringify(context),
  ].join('\n\n');
}

function normaliseJob(job) {
  const company = String(job?.company || '').trim();
  const role = String(job?.title || job?.role || '').trim();
  const url = String(job?.url || '').trim();
  if (!company || !role || !/^https?:\/\//i.test(url)) return null;
  return {
    company, role, url, location: String(job?.location || ''), salary: job?.salary || null,
    workingType: String(job?.workingType || ''), postedDate: job?.postedDate || null,
    source: String(job?.source || ''), providerId: String(job?.providerId || ''),
    description: String(job?.description || ''), requirements: String(job?.requirements || ''),
    tags: Array.isArray(job?.tags) ? job.tags : [], sourceReferences: sourceReferencesOf(job), duplicateCount: 1,
    semanticEvidence: job?.semanticEvidence || null,
  };
}

function absorbDuplicate(existing, incoming) {
  existing.sourceReferences = mergeSourceReferences(existing, incoming);
  existing.duplicateCount += 1;
  existing.tags = [...new Set([...existing.tags, ...incoming.tags])];
  if (incoming.description.length > existing.description.length) existing.description = incoming.description;
  if (Number(incoming.semanticEvidence?.descriptionLength || 0) > Number(existing.semanticEvidence?.descriptionLength || 0)) {
    existing.semanticEvidence = incoming.semanticEvidence;
  }
  if (!existing.salary && incoming.salary) existing.salary = incoming.salary;
  invalidateJobIdentity(existing);
}

// Candidates were previously filled in source order until the cap was reached,
// so once it filled every remaining source contributed nothing and the loss was
// never recorded. Each source now gets a guaranteed share of the budget first,
// leftover capacity is shared among the sources that still have jobs, and what
// could not fit is reported so a truncated scan is visible rather than silent.
export function compactCandidates(sources, maximum = DEFAULT_CANDIDATE_LIMIT) {
  const pools = new Map();
  // sameUnderlyingJob only matches jobs that share a URL or a normalised
  // company, so comparing every new job against every earlier one is wasted
  // work. Bucketing keeps the raised candidate limit from making collection
  // quadratic over a few hundred postings.
  const byCompany = new Map();
  const byUrl = new Map();
  for (const [name, source] of Object.entries(sources || {})) {
    const pool = [];
    for (const job of source?.jobs || []) {
      const incoming = normaliseJob(job);
      if (!incoming) continue;
      const key = jobIdentity(incoming).company || '';
      const bucket = byCompany.get(key) || [];
      const duplicate = byUrl.get(incoming.url)
        || bucket.find((candidate) => sameUnderlyingJob(candidate, incoming));
      if (duplicate) {
        absorbDuplicate(duplicate, incoming);
        for (const reference of duplicate.sourceReferences) if (reference.url) byUrl.set(reference.url, duplicate);
        continue;
      }
      bucket.push(incoming);
      byCompany.set(key, bucket);
      for (const reference of incoming.sourceReferences) if (reference.url) byUrl.set(reference.url, incoming);
      byUrl.set(incoming.url, incoming);
      pool.push(incoming);
    }
    if (pool.length) pools.set(name, pool);
  }

  const selected = [];
  const dropped = {};
  const share = pools.size ? Math.max(1, Math.floor(maximum / pools.size)) : 0;
  for (const [name, pool] of pools) selected.push(...pool.slice(0, share).map((job) => ({ name, job })));
  // Round-robin the remainder so no single large source consumes it all.
  for (let index = share; selected.length < maximum; index += 1) {
    let added = false;
    for (const [name, pool] of pools) {
      if (selected.length >= maximum) break;
      if (index >= pool.length) continue;
      selected.push({ name, job: pool[index] });
      added = true;
    }
    if (!added) break;
  }
  const takenByName = new Map();
  for (const { name } of selected) takenByName.set(name, (takenByName.get(name) || 0) + 1);
  for (const [name, pool] of pools) {
    const missed = pool.length - (takenByName.get(name) || 0);
    if (missed > 0) dropped[name] = missed;
  }

  const candidates = selected.map(({ job }, index) => ({
    ...job,
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    description: job.semanticEvidence
      ? (job.semanticEvidence.responsibilityFacts || [])
        .map((fact) => `Advert responsibility: ${fact}.`).join(' ')
      : job.description.slice(0, 1200),
    sources: [...new Set(job.sourceReferences.map((reference) => reference.url).filter(Boolean))],
    mandatorySignals: job.semanticEvidence
      ? (job.semanticEvidence.mandatorySignals || []).map((signal) => ({
        id: signal.id,
        text: `Advert mandatory requirement: ${signal.fact || 'requirement disclosed'}.`,
      }))
      : mandatorySignals(job.description, job.requirements),
  }));
  return {
    candidates,
    dropped: { perSource: dropped, total: Object.values(dropped).reduce((sum, count) => sum + count, 0) },
  };
}

export function validateAssessments(value, candidates) {
  if (!value || !Array.isArray(value.assessments)) throw new Error('scan assessment must contain an assessments array');
  const known = new Set(candidates.map((item) => item.candidateId));
  const seen = new Set();
  for (const item of value.assessments) {
    if (!known.has(item.candidateId) || seen.has(item.candidateId)) throw new Error(`invalid or duplicate candidate assessment: ${item.candidateId}`);
    seen.add(item.candidateId);
    const candidate = candidates.find((entry) => entry.candidateId === item.candidateId);
    const failures = validateAssessmentJob(item, candidate);
    if (failures.includes('mandatory-advert-evidence-omitted')) {
      throw new Error(`assessment omitted mandatory advert evidence: ${item.candidateId}`);
    }
    if (failures.length) {
      throw new Error(`assessment validation failed for ${item.candidateId}: ${failures.join(', ')}`);
    }
  }
  if (seen.size !== candidates.length) throw new Error(`scan assessment covered ${seen.size} of ${candidates.length} candidates`);
  return value;
}

export function gateAssessment(assessment, policy, candidate = {}) {
  const actionScore = Number(policy?.actionScore ?? 70);
  const checkScore = Number(policy?.checkScore ?? 55);
  const rankedScore = Number(candidate?.preRankScore);
  const total = Number.isFinite(rankedScore)
    ? Math.round(rankedScore * 100) / 100
    : assessment.recommendation === 'keep' ? actionScore
      : assessment.recommendation === 'check' ? checkScore : 0;
  const unmet = (assessment.mandatoryRequirements || []).filter((item) => item.status === 'unmet');
  const unknown = (assessment.mandatoryRequirements || []).filter((item) => item.status === 'unknown');
  if (assessment.recommendation === 'discard' || unmet.length) {
    return {
      eligibility: 'ineligible',
      score: Math.min(total, checkScore - 1),
      keep: false,
      reasons: unmet.map((item) => item.requirement),
    };
  }
  if (unknown.length || assessment.recommendation === 'check') {
    return { eligibility: 'check', score: Math.min(total, actionScore - 1), keep: total >= checkScore, reasons: unknown.map((item) => item.requirement) };
  }
  return { eligibility: total >= actionScore ? 'eligible' : total >= checkScore ? 'check' : 'below-threshold', score: total, keep: total >= checkScore, reasons: [] };
}

function sourceHealth(sources) {
  return Object.fromEntries(Object.entries(sources || {}).map(([name, value]) => [name, {
    status: value.status || 'unavailable', count: Number.isFinite(Number(value.count)) ? Number(value.count) : null,
    reason: safeDiagnostic(value.reason), configured: value.configured !== false,
  }]));
}

function mergeTracker(
  existing,
  candidates,
  assessments,
  policy,
  date,
  profileId = null,
  learningVersionId = 'learning-baseline',
) {
  const byId = new Map(existing.opportunities.map((entry) => [entry.id, entry]));
  const discarded = { ...EMPTY_DISCARDED };
  const reviewed = [];
  let keepersAdded = 0;
  let keepersUpdated = 0;
  for (const assessment of assessments) {
    const candidate = candidates.find((item) => item.candidateId === assessment.candidateId);
    if (!candidate) continue;
    const gate = gateAssessment(assessment, policy, candidate);
    let outcome = 'kept';
    if (!gate.keep) {
      if ((assessment.mandatoryRequirements || []).some((item) => item.status === 'unmet')) outcome = 'mandatory_unmet';
      else if (assessment.recommendation === 'discard') outcome = 'provider_discarded';
      else outcome = 'below_threshold';
      discarded[outcome] += 1;
    }
    const reasons = gate.reasons.length
      ? gate.reasons
      : outcome === 'provider_discarded' ? [assessment.summary]
        : outcome === 'below_threshold' ? ['Below the configured check threshold'] : [];
    reviewed.push({
      vacancyId: boundedText(candidate.vacancyId, 160),
      company: boundedText(candidate.company, 120), role: boundedText(candidate.role, 160),
      source: boundedText(candidate.source, 80), sourceUrl: safeSourceUrl(candidate.url),
      contentFingerprint: /^[a-f0-9]{64}$/.test(String(candidate.contentFingerprint || ''))
        ? candidate.contentFingerprint
        : vacancyContentFingerprint(candidate),
      profileId: boundedText(profileId, 80),
      learningVersionId: boundedText(learningVersionId, 80),
      categoryId: null,
      outcome, score: gate.score,
      reasons: reasons.map((reason) => boundedText(reason)).filter(Boolean).slice(0, REVIEW_REASON_LIMIT),
    });
    if (!gate.keep) {
      continue;
    }
    const baseId = `${slug(candidate.company)}-${slug(candidate.role)}-${date.slice(0, 7)}`;
    const previous = existing.opportunities.find((entry) => sameUnderlyingJob(entry, candidate));
    let id = previous?.id || baseId;
    for (let suffix = 2; !previous && byId.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    const changedAdvert = Boolean(previous && advertMateriallyChanged(previous, candidate));
    const references = mergeSourceReferences(previous || {}, candidate);
    const urls = references.map((reference) => reference.url).filter(Boolean);
    const deterministicDimensions = Array.isArray(candidate.dimensions) ? candidate.dimensions : [];
    const generated = {
      id, company: candidate.company, role: candidate.role, location: candidate.location || previous?.location || '', score: gate.score,
      scoreBreakdown: Object.fromEntries(deterministicDimensions
        .filter((item) => item?.name && Number.isFinite(Number(item.score)))
        .map((item) => [item.name, Number(item.score)])),
      eligibility: { status: gate.eligibility, reasons: gate.reasons },
      mandatoryRequirements: assessment.mandatoryRequirements,
      status: previous?.status || 'new', category: previous?.category || null,
      tags: [...new Set([...(previous?.tags || []), ...(candidate.tags || []), ...(gate.eligibility === 'check' ? ['Check mandatory requirement'] : []), ...(changedAdvert ? ['Updated advert — review'] : [])])],
      sources: [...new Set([...(previous?.sources || []), ...urls])], sourceReferences: references,
      jobIdentity: jobIdentity(candidate),
      profileId: boundedText(profileId, 80),
      learningVersionId: boundedText(learningVersionId, 80),
      rankingHistory: [
        ...(previous?.rankingHistory || []),
        {
          rankedAt: date,
          profileId: boundedText(profileId, 80),
          learningVersionId: boundedText(learningVersionId, 80),
          preRankScore: Number(candidate.preRankScore || 0),
        },
      ].filter((item, index, items) => (
        index === items.findIndex((candidateItem) => (
          candidateItem.rankedAt === item.rankedAt
          && candidateItem.profileId === item.profileId
          && candidateItem.learningVersionId === item.learningVersionId
        ))
      )).slice(-32),
      notes: previous && Object.hasOwn(previous, 'notes') ? previous.notes : assessment.summary,
      lastChecked: date, foundVia: candidate.source, contacts: previous?.contacts || [], log: previous?.log || [],
      ...(changedAdvert ? { advertUpdate: { detectedAt: date, previousFingerprint: previous.jobIdentity?.advertFingerprint || '', currentFingerprint: jobIdentity(candidate).advertFingerprint } } : {}),
    };
    if (previous) { Object.assign(previous, generated); keepersUpdated += 1; }
    else { existing.opportunities.push(generated); byId.set(generated.id, generated); keepersAdded += 1; }
  }
  existing.updated = date;
  return { tracker: existing, keepersAdded, keepersUpdated, discarded, reviewed };
}

function reportText({ date, degraded, source_health, kept, discarded, reviewed, errors }) {
  const coverage = Object.entries(source_health).map(([name, value]) => `- ${name}: ${value.configured === false ? 'not configured' : value.status} (${value.count ?? 'unknown'})${value.reason ? ` — ${value.reason}` : ''}`).join('\n');
  const actions = kept.filter((item) => item.eligibility?.status === 'eligible').map((item) => `- **${item.company} — ${item.role}** (${item.score}) — ${item.sources?.[0] || ''}`).join('\n') || '- None.';
  const checks = kept.filter((item) => item.eligibility?.status === 'check').map((item) => `- **${item.company} — ${item.role}** (${item.score}) — ${(item.eligibility.reasons || []).join('; ')}`).join('\n') || '- None.';
  const nearMisses = (reviewed || []).filter((item) => item.outcome !== 'kept' && item.outcome !== 'hard_exclusion')
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, 5)
    .map((item) => `- **${item.company} — ${item.role}** (${item.score}) — ${item.reasons.join('; ') || item.outcome}${item.sourceUrl ? ` — ${item.sourceUrl}` : ''}`).join('\n') || '- None.';
  return `# Scout report — ${date}\n\n## Headline\n\n${degraded ? 'Coverage was degraded; this is not evidence that no suitable roles exist.' : 'Configured sources completed successfully.'}\n\n${coverage}\n\n## Action today\n\n${actions}\n\n## One check from unlocking\n\n${checks}\n\n## Follow-ups due\n\n- Review existing tracker follow-ups in Scout.\n\n## Changes since last scan\n\n- ${kept.length} current keeper(s) in the tracker.\n\n## Discarded\n\n${Object.entries(discarded).map(([name, count]) => `- ${name}: ${count}`).join('\n')}\n\n### Closest reviewed roles not kept\n\n${nearMisses}\n\nThe full sanitised review is available from Scout's latest scan result.\n\n## Verdicts\n\n${errors.length ? errors.map((error) => `- Error: ${error}`).join('\n') : '- No applications or outreach were sent.'}\n`;
}

function atomicWrite(file, content) {
  atomicWriteFile(file, content);
}

export function validateWrittenScanArtifacts(root, expectedRun) {
  const paths = workspacePaths(root);
  const tracker = JSON.parse(fs.readFileSync(paths.tracker, 'utf8'));
  if (!Array.isArray(tracker.opportunities)) throw new Error('scan tracker artifact is invalid');
  const report = fs.readFileSync(path.join(paths.reports, `${expectedRun.timestamp.slice(0, 10)}.md`), 'utf8');
  for (const heading of ['Headline', 'Action today', 'One check from unlocking', 'Follow-ups due', 'Changes since last scan', 'Discarded', 'Verdicts']) {
    if (!report.includes(`## ${heading}`)) throw new Error(`scan report is missing ${heading}`);
  }
  const lines = fs.readFileSync(paths.scanRuns, 'utf8').trim().split(/\r?\n/);
  const run = JSON.parse(lines.at(-1));
  for (const field of ['schemaVersion', 'timestamp', 'agent', 'mode', 'degraded', 'sources_checked', 'candidates_found', 'keepers_added', 'discarded', 'errors', 'source_health']) {
    if (!Object.hasOwn(run, field)) throw new Error(`scan run is missing ${field}`);
  }
  if (Number(run.schemaVersion) >= 3 && !Array.isArray(run.reviewed)) throw new Error('scan run is missing reviewed audit data');
  if (run.timestamp !== expectedRun.timestamp || run.agent !== expectedRun.agent || run.mode !== expectedRun.mode) throw new Error('scan run record does not match the completed request');
  return { tracker, report, run };
}

function buildScanArtifacts(root, {
  provider, mode, sources, queries = [], candidates, assessmentResult, policy, startedAt,
  error = null, skipped = false, dropped = { perSource: {}, total: 0 }, hardExcluded = [], closedAdverts = [], exclusions = [],
  assessmentFailures = [],
  livenessSummary = { checked: 0, gone: 0, unverified: 0 }, verificationScoped = false,
  staleInboxEntries = [], inboxRechecked = 0, funnel = null, selection = [], discoveryEngine = 'legacy-discovery', profileId = null,
  learningVersionId = 'learning-baseline',
  ranked = [], selectionDecision = null, runId = null,
  timestamp: requestedTimestamp = null,
}) {
  const paths = workspacePaths(root);
  const timestamp = requestedTimestamp || new Date().toISOString();
  const date = timestamp.slice(0, 10);
  const health = sourceHealth(sources);
  const configuredSources = Object.values(health).filter((item) => item.configured !== false);
  const configuredFailures = Object.values(health).filter((item) => item.configured !== false && item.status !== 'healthy');
  const boundedAssessmentFailures = (assessmentFailures || []).map((failure) => ({
    jobId: boundedText(failure?.jobId, 128),
    code: boundedText(failure?.code, 100),
    attempts: Number.isSafeInteger(failure?.attempts) ? failure.attempts : 0,
    validationFailures: (failure?.validationFailures || []).map((item) => boundedText(item, 100)).slice(0, 8),
  })).filter((failure) => failure.jobId && failure.code);
  const errors = [
    ...(error ? [safeDiagnostic(error)] : []),
    ...(!error && boundedAssessmentFailures.length ? [`${boundedAssessmentFailures.length} candidate assessment(s) exhausted bounded retries`] : []),
    ...(configuredSources.length ? [] : ['no job sources are configured']),
  ];
  const degraded = configuredFailures.length > 0 || errors.length > 0;
  const existing = JSON.parse(fs.readFileSync(paths.tracker, 'utf8'));
  const merged = assessmentResult
    ? mergeTracker(
      existing,
      candidates,
      assessmentResult.assessments,
      policy,
      date,
      profileId,
      learningVersionId,
    )
    : { tracker: existing, keepersAdded: 0, keepersUpdated: 0, discarded: { ...EMPTY_DISCARDED }, reviewed: [] };
  const inboxArchived = archiveStaleInboxEntries(merged.tracker, staleInboxEntries, date);
  const baseFunnel = funnel && error ? {
    ...funnel,
    assessed: Number(assessmentResult?.assessments?.length || 0),
    assessmentFailed: Math.max(
      0,
      Number(funnel.selected || candidates.length) - Number(assessmentResult?.assessments?.length || 0),
    ),
  } : funnel;
  const effectiveSelectionDecision = selectionDecision ? {
    ...selectionDecision,
    reasons: [...(selectionDecision.reasons || []), ...selection],
  } : selection.length
    ? {
      selected: candidates,
      reasons: selection,
      notSelected: [],
      assessmentSkipped: [],
    }
    : null;
  const explanations = buildVacancyExplanations({
    ranked,
    exclusions,
    candidates,
    assessmentResult,
    reviewed: merged.reviewed,
    selectionDecision: effectiveSelectionDecision,
    deterministicExclusions: exclusions,
    closedAdverts,
    verificationScoped,
  });
  const reconciledFunnel = reconcileCoverageFunnel(baseFunnel, explanations);
  const coverage = buildCoverageRollups({
    explanations,
    provider,
    runId: runId || `scan-${timestamp}`,
    date,
    sourceHealth: health,
  });
  const selection_summary = reconciledFunnel ? { selected: Number(reconciledFunnel.selected || 0), assessed: Number(reconciledFunnel.assessed || 0), assessmentFailed: Number(reconciledFunnel.assessmentFailed || 0) } : null;
  const durableTracker = durableScanProjection(merged.tracker);
  const durableReviewed = durableScanProjection(merged.reviewed);
  const run = durableScanProjection({
    schemaVersion: 5, timestamp, started_at: startedAt, agent: provider, mode, degraded, skipped,
    sources_checked: Object.entries(health).filter(([, item]) => item.configured !== false).map(([name]) => name),
    queries_checked: [...queries], candidates_found: candidates.length, keepers_added: merged.keepersAdded,
    duplicates_collapsed: candidates.reduce((total, candidate) => total + Math.max(0, Number(candidate.duplicateCount || 1) - 1), 0),
    keepers_updated: merged.keepersUpdated,
    discarded: {
      ...merged.discarded,
      // Applied deterministically before the assessment turn rather than by
      // the provider, so they are counted here instead.
      hard_exclusion: merged.discarded.hard_exclusion + new Set(hardExcluded.map((item, index) => (
        String(item?.vacancyId || item?.candidateId || item?.canonicalUrl || `excluded-${index}`)
      ))).size,
      advert_closed: closedAdverts.length,
    },
    candidates_dropped: dropped.total, candidates_dropped_by_source: dropped.perSource,
    adverts_checked: livenessSummary.checked, adverts_closed: livenessSummary.gone,
    adverts_unverified: livenessSummary.unverified, verification_scoped: verificationScoped,
    inbox_rechecked: inboxRechecked, inbox_archived: inboxArchived,
    profile_id: profileId, learning_version_id: learningVersionId,
    discovery_engine: discoveryEngine,
    ...(reconciledFunnel ? { funnel: reconciledFunnel } : {}),
    ...(selection_summary ? { selection_summary } : {}),
    ...(boundedAssessmentFailures.length ? { assessment_failures: boundedAssessmentFailures } : {}),
    ...(selection.length ? { selection } : {}),
    ...(explanations.length ? { explanations } : {}),
    coverage,
    reviewed: merged.reviewed, errors, source_health: health,
  });
  const earlierRuns = fs.existsSync(paths.scanRuns)
    ? fs.readFileSync(paths.scanRuns, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((item) => item?.timestamp?.startsWith(date))
    : [];
  const dayRuns = [...earlierRuns, run];
  const dayErrors = [...new Set(dayRuns.flatMap((item) => item.errors || []).map((item) => safeDiagnostic(item)).filter(Boolean))];
  const reportRecipe = scanReportRecipe({
    date,
    degraded: dayRuns.some((item) => item.degraded),
    coverage: Object.entries(health).map(([source, value]) => ({
      source,
      status: value.status,
      count: value.count,
      reasonCode: value.reason,
      configured: value.configured,
    })),
    actions: durableTracker.opportunities.filter((item) => item.eligibility?.status === 'eligible')
      .map((item) => ({
        company: item.company,
        role: item.role,
        score: item.score,
        url: item.sources?.[0],
      })),
    checks: durableTracker.opportunities.filter((item) => item.eligibility?.status === 'check')
      .map((item) => ({
        company: item.company,
        role: item.role,
        score: item.score,
        reasonCodes: ['check-required'],
      })),
    keeperCount: durableTracker.opportunities.length,
    discarded: merged.discarded,
    nearMisses: durableReviewed.filter((item) => item.outcome !== 'kept' && item.outcome !== 'hard_exclusion')
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))
      .slice(0, 5)
      .map((item) => ({
        company: item.company,
        role: item.role,
        score: item.score,
        reasonCodes: [String(item.outcome || 'not-kept').replaceAll('_', '-')],
        sourceUrl: item.sourceUrl,
      })),
    errors: dayErrors,
    runs: dayRuns.map((item) => ({
      agent: item.agent,
      mode: item.mode,
      timestamp: item.timestamp,
      skipped: item.skipped,
      degraded: item.degraded,
      candidatesFound: item.candidates_found,
      keepersAdded: item.keepers_added,
      keepersUpdated: item.keepers_updated,
      sources: Object.entries(item.source_health || {}).map(([name, value]) => ({
        name,
        status: value.status,
      })),
    })),
  });
  const report = renderMutationRecipe('report', '', reportRecipe);
  const reportPath = path.join(paths.reports, `${date}.md`);
  const priorRuns = fs.existsSync(paths.scanRuns)
    ? markerFreeMutationContent('run-log', fs.readFileSync(paths.scanRuns, 'utf8')).trimEnd()
    : '';
  const runRecipe = runLogAppendRecipe(run);
  const scanRuns = renderMutationRecipe('run-log', priorRuns, runRecipe);
  return {
    run,
    tracker: durableTracker,
    report: reportPath,
    contents: {
      ...(error ? {} : { tracker: serializeTracker(durableTracker) }),
      report,
      scanRuns,
    },
    recipes: {
      report: reportRecipe,
      runLog: runRecipe,
    },
  };
}

export function writeScanArtifacts(root, input) {
  const paths = workspacePaths(root);
  const artifacts = buildScanArtifacts(root, input);
  if (artifacts.contents.tracker !== undefined) atomicWrite(paths.tracker, artifacts.contents.tracker);
  atomicWrite(artifacts.report, artifacts.contents.report);
  atomicWrite(paths.scanRuns, artifacts.contents.scanRuns);
  validateWrittenScanArtifacts(root, artifacts.run);
  return { run: artifacts.run, tracker: artifacts.tracker, report: artifacts.report };
}

function coordinatedArtifactsFromPlan(root, plan) {
  const paths = workspacePaths(root);
  const trackerTarget = plan.files.find((target) => target.kind === 'tracker');
  const reportTarget = plan.files.find((target) => target.kind === 'report');
  const runTarget = plan.files.find((target) => target.kind === 'run-log');
  if (!reportTarget || !runTarget) {
    throw new Error('prepared scan mutation does not contain report and run-log targets');
  }
  const tracker = JSON.parse(fs.readFileSync(paths.tracker, 'utf8'));
  delete tracker._scoutMutation;
  const lines = fs.readFileSync(paths.scanRuns, 'utf8').trim().split(/\r?\n/);
  const scanRun = JSON.parse(lines.at(-1));
  delete scanRun._scoutMutation;
  return {
    run: scanRun,
    tracker,
    report: reportTarget.file,
    paths,
  };
}

export function coordinateScanArtifacts(root, input, { run, lease, hooks = {} }) {
  const existing = [...run.events].reverse().find((event) => (
    event.type === 'mutation.prepared'
    && event.stageId === 'finalise'
    && event.payload?.reference?.kind === 'mutation'
  ));
  let plan;
  if (existing) {
    plan = loadPreparedMutation(run, existing.payload.reference.id);
  } else {
    const timestamp = run.events.find((event) => event.type === 'run.started')?.recordedAt
      || input.startedAt;
    const artifacts = buildScanArtifacts(root, { ...input, timestamp });
    const date = artifacts.run.timestamp.slice(0, 10);
    const hasTracker = artifacts.contents.tracker !== undefined;
    const selectedLanes = Array.isArray(input.lanes) ? input.lanes : [];
    const currentLanePlan = selectedLanes.length ? loadSearchLanePlan(root) : null;
    if (currentLanePlan && input.profileId && currentLanePlan.profileId !== input.profileId) {
      throw new Error('selected search lanes do not match the scan profile');
    }
    const updatedLanePlan = currentLanePlan ? recordSearchLaneRun(currentLanePlan, {
      runId: run.runId,
      recordedAt: timestamp,
      results: deriveSearchLaneResults({
        lanes: selectedLanes,
        sources: input.sources,
        discoveryCounts: input.discoveryCounts,
        ranked: input.ranked,
        candidates: input.candidates,
        reviewed: artifacts.run.reviewed,
        scanFailureCode: input.error ? 'scan-failed' : null,
      }),
    }) : null;
    const employerSource = input.sources?.employer_registry;
    const employerDiscoveries = [];
    let updatedEmployerRegistry = null;
    if (employerSource?.registrySnapshot) {
      const snapshot = validateEmployerRegistry(structuredClone(employerSource.registrySnapshot));
      if (employerRegistryRevision(snapshot) !== employerSource.registryRevision) {
        throw new Error('collected employer registry snapshot does not match its revision');
      }
      const stored = loadEmployerRegistry(root);
      const currentEmployerRegistry = stored || snapshot;
      if (stored && employerRegistryRevision(stored) !== employerSource.registryRevision) {
        throw new Error('employer registry changed after scan collection');
      }
      const knownIds = new Set([
        ...currentEmployerRegistry.employers,
        ...currentEmployerRegistry.archivedEmployers,
      ].map(({ id }) => id));
      const discoveredIds = new Set();
      let remainingCapacity = Math.max(0, 256 - currentEmployerRegistry.employers.length);
      for (const candidate of input.candidates || []) {
        const canonicalName = String(candidate?.company || candidate?.employer || '').trim();
        if (!canonicalName) continue;
        const id = canonicalEmployerId(canonicalName);
        if (discoveredIds.has(id) || (!knownIds.has(id) && remainingCapacity <= 0)) continue;
        discoveredIds.add(id);
        if (!knownIds.has(id)) remainingCapacity -= 1;
        employerDiscoveries.push({
          canonicalName,
          origin: {
            kind: 'advert-discovered',
            recordedAt: timestamp,
            reference: String(candidate.vacancyId || candidate.url || `scan:${run.runId}`).slice(0, 160),
          },
        });
      }
      const checked = recordEmployerChecks(currentEmployerRegistry, {
        runId: run.runId,
        recordedAt: timestamp,
        checks: Array.isArray(employerSource.checks) ? employerSource.checks : [],
      });
      updatedEmployerRegistry = reconcileEmployerDiscoveries(checked, employerDiscoveries, {
        now: () => timestamp,
      });
    }
    const target = {
      id: [
        'scan',
        hasTracker ? 'tracker' : 'failure',
        'report',
        ...(updatedLanePlan ? ['lanes'] : []),
        ...(updatedEmployerRegistry ? ['employers'] : []),
      ].join('-'),
      schemaVersion: 1,
      files: [
        ...(hasTracker ? [{ kind: 'tracker', key: 'tracker' }] : []),
        { kind: 'report', key: `report:${date}` },
        { kind: 'run-log', key: 'scan-log' },
        ...(updatedLanePlan ? [{ kind: 'json', key: 'search-lanes' }] : []),
        ...(updatedEmployerRegistry ? [{ kind: 'json', key: 'employers' }] : []),
      ],
    };
    plan = prepareMutation({ handle: run, lease }, target, {
      ...(hasTracker ? {
        tracker: trackerMergeRecipe(
          fs.readFileSync(workspacePaths(root).tracker, 'utf8'),
          artifacts.contents.tracker,
        ),
      } : {}),
      [`report:${date}`]: artifacts.recipes.report,
      'scan-log': artifacts.recipes.runLog,
      ...(updatedLanePlan ? { 'search-lanes': jsonReplaceRecipe(updatedLanePlan) } : {}),
      ...(updatedEmployerRegistry ? { employers: jsonReplaceRecipe(updatedEmployerRegistry) } : {}),
    });
  }
  const mutationReceipt = applyPreparedMutation(plan, lease, hooks);
  const artifacts = coordinatedArtifactsFromPlan(root, plan);
  validateWrittenScanArtifacts(root, artifacts.run);
  return {
    run: artifacts.run,
    tracker: artifacts.tracker,
    report: artifacts.report,
    mutationReceipt,
  };
}
