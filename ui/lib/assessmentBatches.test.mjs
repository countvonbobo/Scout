import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertMinimalAssessmentRequest,
  executeAssessmentBatch,
  planAssessmentBatches,
  resumeAssessments,
} from './assessmentBatches.mjs';
import { acquireScanLease, currentLeaseOwner, releaseScanLease } from './scanLease.mjs';
import { appendRunEvent, openRunJournal, validateRunJournal } from './runJournal.mjs';

const provenance = Object.freeze({
  profileVersion: 'profile-v1',
  promptVersion: 'prompt-v1',
  assessmentSchemaVersion: 1,
  pipelineVersion: 'pipeline-v1',
  provider: 'codex',
  model: 'provider-default',
});

function jobs(count) {
  return Array.from({ length: count }, (_, index) => ({
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    company: `Synthetic ${index + 1}`,
    role: 'Engineer',
    url: `https://example.test/jobs/${index + 1}`,
    description: `Advert responsibility: synthetic-${index + 1}.`,
    mandatorySignals: [{ id: 'mandatory-01', text: 'Advert mandatory requirement: synthetic evidence.' }],
    contextCharacters: 100,
  }));
}

function assessment(candidateId, overrides = {}) {
  return {
    candidateId,
    categoryId: null,
    summary: 'Evidence-led synthetic match.',
    hardExclusionMatches: [],
    mandatoryRequirements: [{
      requirement: 'Synthetic evidence',
      advertEvidence: 'The advert marks synthetic evidence as mandatory.',
      advertEvidenceId: 'mandatory-01',
      status: 'met',
      profileEvidence: 'The synthetic profile supplies matching evidence.',
    }],
    dimensions: [{ name: 'fit', score: 80, maximum: 100, evidence: 'Bounded evidence.' }],
    recommendation: 'keep',
    ...overrides,
  };
}

function runFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-assessment-batches-'));
  const runId = 'assessment-run';
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId, provider: 'codex', model: 'provider-default', mode: 'primary', phase: 'assessment',
  });
  const run = openRunJournal(root, runId);
  appendRunEvent(run, {
    type: 'run.started',
    stageId: 'initialise',
    idempotencyKey: 'run-started-v1',
    payload: {
      schemaVersion: 1,
      compatibility: {
        schemaVersion: 1,
        journalSchemaVersion: 1,
        artifactSchemaVersion: 1,
        mode: 'primary',
        purpose: 'job-discovery',
        profileVersion: provenance.profileVersion,
        sourceConfigFingerprint: 'a'.repeat(64),
        pipelineVersion: provenance.pipelineVersion,
        rankingVersion: 'ranking-v1',
        promptVersion: provenance.promptVersion,
        assessmentSchemaVersion: provenance.assessmentSchemaVersion,
        provider: provenance.provider,
        model: provenance.model,
        mutationSchemaVersion: 1,
        targetRevision: 'tracker-v1',
      },
    },
  }, lease);
  return {
    root,
    run,
    lease,
    cleanup() {
      try { releaseScanLease(lease); } catch { /* terminal tests may already release */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('stable assessment planning caps batches at ten and deterministically reduces for context', () => {
  const input = {
    runId: 'run-1',
    jobs: jobs(23),
    provenance,
    contextBudgetCharacters: 10_000,
    contextOverheadCharacters: 100,
  };
  const first = planAssessmentBatches(input);
  const repeated = planAssessmentBatches(input);
  assert.deepEqual(first.map((batch) => batch.jobs.length), [10, 10, 3]);
  assert.deepEqual(first.map((batch) => batch.id), repeated.map((batch) => batch.id));

  const reduced = planAssessmentBatches({
    ...input,
    jobs: jobs(7),
    contextBudgetCharacters: 350,
    contextOverheadCharacters: 50,
  });
  assert.deepEqual(reduced.map((batch) => batch.jobs.length), [3, 3, 1]);
});

test('persistable requests contain only stable references, digests, bounds and provenance', () => {
  const [batch] = planAssessmentBatches({
    runId: 'run-privacy',
    jobs: jobs(2),
    provenance,
    contextBudgetCharacters: 2_000,
    contextOverheadCharacters: 100,
    timeoutMs: 12_000,
    maxInputTokens: 5_000,
  });
  assert.deepEqual(Object.keys(batch.request).sort(), [
    'batchId', 'jobReferences', 'parameters', 'provenance', 'runId', 'schemaVersion',
  ]);
  assert.deepEqual(Object.keys(batch.request.jobReferences[0]).sort(), ['inputDigest', 'jobId']);
  const persisted = JSON.stringify(batch.request);
  for (const privateValue of ['Synthetic 1', 'Engineer', 'Advert responsibility', 'https://example.test']) {
    assert.equal(persisted.includes(privateValue), false);
  }
  assert.doesNotThrow(() => assertMinimalAssessmentRequest(batch.request));
  for (const forbidden of ['cv', 'advertBody', 'prompt', 'transcript', 'rawResponse', 'credentials']) {
    assert.throws(
      () => assertMinimalAssessmentRequest({ ...batch.request, parameters: { ...batch.request.parameters, [forbidden]: 'private' } }),
      /private assessment request property is not allowed/,
    );
  }
});

test('valid siblings persist while only invalid jobs receive one focused repair', async () => {
  const fixture = runFixture();
  try {
    const [batch] = planAssessmentBatches({
      runId: fixture.run.runId, jobs: jobs(3), provenance,
      contextBudgetCharacters: 5_000, contextOverheadCharacters: 100,
    });
    const calls = [];
    const result = await executeAssessmentBatch(batch, {
      run: fixture.run,
      lease: fixture.lease,
      async invokeProvider({ kind, jobs: requested }) {
        calls.push({ kind, ids: requested.map((job) => job.candidateId) });
        if (kind === 'batch') {
          return {
            assessments: [
              assessment('candidate-001'),
              assessment('candidate-002', { mandatoryRequirements: [] }),
              assessment('candidate-003'),
            ],
          };
        }
        return { assessments: [assessment('candidate-002')] };
      },
    });
    assert.deepEqual(result.assessments.map((item) => item.candidateId), [
      'candidate-001', 'candidate-002', 'candidate-003',
    ]);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(calls, [
      { kind: 'batch', ids: ['candidate-001', 'candidate-002', 'candidate-003'] },
      { kind: 'repair', ids: ['candidate-002'] },
    ]);
    const eventTypes = validateRunJournal(fixture.run.file).events.map((event) => event.type);
    assert.equal(eventTypes.filter((type) => type === 'assessment.job-completed').length, 3);
  } finally {
    fixture.cleanup();
  }
});

test('credential-shaped provider evidence is isolated to its job and never persisted', async () => {
  const fixture = runFixture();
  const privateValue = 'PRIVATE_ASSESSMENT_SECRET';
  try {
    const [batch] = planAssessmentBatches({
      runId: fixture.run.runId, jobs: jobs(2), provenance,
      contextBudgetCharacters: 5_000, contextOverheadCharacters: 100,
    });
    const calls = [];
    const result = await executeAssessmentBatch(batch, {
      run: fixture.run,
      lease: fixture.lease,
      async invokeProvider({ kind, jobs: requested }) {
        calls.push({ kind, ids: requested.map((job) => job.candidateId) });
        if (kind === 'batch') {
          const unsafe = assessment('candidate-002');
          unsafe.mandatoryRequirements[0].profileEvidence = `token=${privateValue}`;
          return { assessments: [assessment('candidate-001'), unsafe] };
        }
        return { assessments: [assessment('candidate-002')] };
      },
    });
    assert.deepEqual(result.assessments.map((item) => item.candidateId), ['candidate-001', 'candidate-002']);
    assert.deepEqual(calls, [
      { kind: 'batch', ids: ['candidate-001', 'candidate-002'] },
      { kind: 'repair', ids: ['candidate-002'] },
    ]);
    const durableText = fs.readdirSync(fixture.run.directory, { recursive: true })
      .filter((entry) => typeof entry === 'string')
      .map((entry) => path.join(fixture.run.directory, entry))
      .filter((file) => fs.statSync(file).isFile())
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    assert.equal(durableText.includes(privateValue), false);
  } finally {
    fixture.cleanup();
  }
});

test('failed repair gets one clean per-job retry and exhausted failures stay auditable', async () => {
  const fixture = runFixture();
  try {
    const [batch] = planAssessmentBatches({
      runId: fixture.run.runId, jobs: jobs(3), provenance,
      contextBudgetCharacters: 5_000, contextOverheadCharacters: 100,
    });
    const calls = [];
    const result = await executeAssessmentBatch(batch, {
      run: fixture.run,
      lease: fixture.lease,
      async invokeProvider({ kind, jobs: requested }) {
        calls.push({ kind, ids: requested.map((job) => job.candidateId) });
        if (kind === 'batch') return { assessments: [assessment('candidate-001')] };
        if (kind === 'repair') return {
          assessments: requested.map((job) => assessment(job.candidateId, { mandatoryRequirements: [] })),
        };
        if (requested[0].candidateId === 'candidate-002') return { assessments: [assessment('candidate-002')] };
        return { assessments: [assessment('candidate-003', { dimensions: [] })] };
      },
    });
    assert.deepEqual(result.assessments.map((item) => item.candidateId), ['candidate-001', 'candidate-002']);
    assert.deepEqual(result.failures, [{
      jobId: 'candidate-003',
      code: 'assessment-validation-exhausted',
      attempts: 3,
      validationFailures: ['dimensions-required'],
    }]);
    assert.deepEqual(calls, [
      { kind: 'batch', ids: ['candidate-001', 'candidate-002', 'candidate-003'] },
      { kind: 'repair', ids: ['candidate-002', 'candidate-003'] },
      { kind: 'retry', ids: ['candidate-002'] },
      { kind: 'retry', ids: ['candidate-003'] },
    ]);
    const failed = validateRunJournal(fixture.run.file).events.filter((event) => event.type === 'assessment.job-failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].payload.reference.id, 'candidate-003');
  } finally {
    fixture.cleanup();
  }
});

test('resume returns committed jobs and never invokes completed batches again', async () => {
  const fixture = runFixture();
  try {
    const batches = planAssessmentBatches({
      runId: fixture.run.runId, jobs: jobs(2), provenance,
      contextBudgetCharacters: 5_000, contextOverheadCharacters: 100,
    });
    await resumeAssessments(fixture.run, {
      batches,
      lease: fixture.lease,
      invokeProvider: async ({ jobs: requested }) => ({
        assessments: requested.map((job) => assessment(job.candidateId)),
      }),
    });
    let repeatedCalls = 0;
    const resumed = await resumeAssessments(fixture.run, {
      batches,
      lease: fixture.lease,
      invokeProvider: async () => {
        repeatedCalls += 1;
        throw new Error('completed work must not repeat');
      },
    });
    assert.equal(repeatedCalls, 0);
    assert.deepEqual(resumed.assessments.map((item) => item.candidateId), ['candidate-001', 'candidate-002']);
    assert.deepEqual(resumed.failures, []);
  } finally {
    fixture.cleanup();
  }
});

test('resume never resubmits a committed sibling from an interrupted partial batch', async () => {
  const fixture = runFixture();
  try {
    const batches = planAssessmentBatches({
      runId: fixture.run.runId, jobs: jobs(2), provenance,
      contextBudgetCharacters: 5_000, contextOverheadCharacters: 100,
    });
    await assert.rejects(
      executeAssessmentBatch(batches[0], {
        run: fixture.run,
        lease: fixture.lease,
        invokeProvider: async () => ({
          assessments: [
            assessment('candidate-001'),
            assessment('candidate-002', { mandatoryRequirements: [] }),
          ],
        }),
        onJobCommitted({ jobId }) {
          if (jobId === 'candidate-001') throw new Error('synthetic interruption');
        },
      }),
      /synthetic interruption/,
    );
    const calls = [];
    const resumed = await resumeAssessments(fixture.run, {
      batches,
      lease: fixture.lease,
      async invokeProvider({ kind, jobs: requested }) {
        calls.push({ kind, ids: requested.map((job) => job.candidateId) });
        return { assessments: requested.map((job) => assessment(job.candidateId)) };
      },
    });
    assert.deepEqual(calls, [{ kind: 'repair', ids: ['candidate-002'] }]);
    assert.deepEqual(resumed.assessments.map((item) => item.candidateId), ['candidate-001', 'candidate-002']);
  } finally {
    fixture.cleanup();
  }
});

test('provider calls time out while an independent heartbeat keeps advancing', async () => {
  const fixture = runFixture();
  try {
    const [batch] = planAssessmentBatches({
      runId: fixture.run.runId, jobs: jobs(1), provenance,
      contextBudgetCharacters: 5_000, contextOverheadCharacters: 100,
      timeoutMs: 35,
    });
    let heartbeats = 0;
    const started = Date.now();
    const result = await executeAssessmentBatch(batch, {
      run: fixture.run,
      lease: fixture.lease,
      heartbeatIntervalMs: 5,
      heartbeat: () => { heartbeats += 1; },
      invokeProvider: () => new Promise(() => {}),
    });
    assert.ok(Date.now() - started < 500, 'provider timeout must remain bounded');
    assert.ok(heartbeats >= 2, `expected independent heartbeats, received ${heartbeats}`);
    assert.equal(result.assessments.length, 0);
    assert.equal(result.failures[0].code, 'assessment-provider-exhausted');
  } finally {
    fixture.cleanup();
  }
});

test('provider substitution is rejected unless explicit and records new provenance', async () => {
  const fixture = runFixture();
  try {
    const substituted = { ...provenance, provider: 'claude', model: 'sonnet' };
    const batches = planAssessmentBatches({
      runId: fixture.run.runId, jobs: jobs(1), provenance: substituted,
      contextBudgetCharacters: 5_000, contextOverheadCharacters: 100,
    });
    await assert.rejects(
      resumeAssessments(fixture.run, {
        batches,
        lease: fixture.lease,
        invokeProvider: async () => ({ assessments: [assessment('candidate-001')] }),
      }),
      /explicit provider substitution/,
    );
    const result = await resumeAssessments(fixture.run, {
      batches,
      lease: fixture.lease,
      providerSubstitution: {
        previousProvider: 'codex',
        previousModel: 'provider-default',
        nextProvider: 'claude',
        nextModel: 'sonnet',
      },
      invokeProvider: async ({ jobs: requested }) => ({
        assessments: requested.map((job) => assessment(job.candidateId)),
      }),
    });
    assert.equal(result.assessments[0].candidateId, 'candidate-001');
    const events = validateRunJournal(fixture.run.file).events;
    assert.equal(events.filter((event) => event.type === 'recovery.provider-substituted').length, 1);
    assert.deepEqual(result.provenanceByJob['candidate-001'], {
      provider: 'claude',
      model: 'sonnet',
      promptVersion: 'prompt-v1',
      assessmentSchemaVersion: 1,
    });
  } finally {
    fixture.cleanup();
  }
});
