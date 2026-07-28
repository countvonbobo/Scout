import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normaliseSourceHealth, parseScanRuns, publicQueueSummary, publicRunSummary,
  readPublicRunSummaries, scanHealthFromText,
} from './scanHealth.mjs';

test('parseScanRuns parses jsonl and reports bad lines', () => {
  const out = parseScanRuns('{"timestamp":"2026-07-08T07:30:00"}\nnope\n');
  assert.equal(out.runs.length, 1);
  assert.equal(out.errors.length, 1);
});

test('scanHealthFromText reports missing runs as stale', () => {
  const out = scanHealthFromText('', '2026-07-08');
  assert.equal(out.healthy, false);
  assert.equal(out.stale, true);
  assert.match(out.reason, /no scan runs/i);
});

test('scanHealthFromText reports a healthy same-day run', () => {
  const line = JSON.stringify({
    timestamp: '2026-07-08T07:30:00',
    search_degraded: false,
    sources_checked: ['ats'],
    ats_portals_checked: 2,
    candidates_found: 8,
    keepers_added: 1,
    discarded: { stale: 2 },
    errors: [],
  });
  const out = scanHealthFromText(`${line}\n`, '2026-07-08');
  assert.equal(out.healthy, true);
  assert.equal(out.stale, false);
  assert.equal(out.keepersAdded, 1);
  assert.deepEqual(out.sourcesChecked, ['ats']);
});

test('scan health exposes reconciled ranked funnel metrics', () => {
  const out = scanHealthFromText(`${JSON.stringify({
    timestamp: '2026-07-08T07:30:00Z', errors: [], funnel: {
      sourceRecords: 2532, sourceErrors: 2, failedSourceRecords: 3,
      uniqueVacancies: 120, deterministicallyExcluded: 40,
      eligible: 80, ranked: 80, selected: 60, assessed: 59, assessmentFailed: 1,
    },
  })}\n`, '2026-07-08');
  assert.deepEqual(out.funnel, {
    sourceRecords: 2532, sourceErrors: 2, failedSourceRecords: 3,
    uniqueVacancies: 120, deterministicallyExcluded: 40,
    eligible: 80, ranked: 80, selected: 60, assessed: 59, assessmentFailed: 1,
  });
});

test('scanHealthFromText flags stale and degraded runs', () => {
  const stale = scanHealthFromText('{"timestamp":"2026-07-07T07:30:00","errors":[]}\n', '2026-07-08');
  assert.equal(stale.stale, true);
  const degraded = scanHealthFromText('{"timestamp":"2026-07-08T07:30:00","search_degraded":true,"errors":[]}\n', '2026-07-08');
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.healthy, false);
});

test('normaliseSourceHealth distinguishes healthy, degraded and unavailable sources', () => {
  const result = normaliseSourceHealth({
    api_sources: { adzuna: 4, hiring_cafe: 0, ats: 12 },
    errors: ['hiring.cafe returned 0 results', 'ATS one portal failed'],
  });
  assert.deepEqual(result, [
    { name: 'adzuna', status: 'healthy', count: 4, reason: null },
    { name: 'ats', status: 'degraded', count: 12, reason: 'ATS one portal failed' },
    { name: 'hiring_cafe', status: 'unavailable', count: 0, reason: 'hiring.cafe returned 0 results' },
  ]);
});

test('normaliseSourceHealth prefers explicit source records from new scans', () => {
  assert.deepEqual(normaliseSourceHealth({
    source_health: {
      hiring_cafe: { status: 'healthy', count: 0, reason: null },
      ats: { status: 'degraded', count: 8, reason: 'one portal blocked' },
    },
    errors: ['unrelated wording'],
  }), [
    { name: 'ats', status: 'degraded', count: 8, reason: 'one portal blocked' },
    { name: 'hiring_cafe', status: 'healthy', count: 0, reason: null },
  ]);
});

function event(sequence, type, stageId, payload = {}, fencingGeneration = 1) {
  return {
    sequence, type, stageId, recordedAt: `2026-07-29T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    fencingGeneration, payload,
  };
}

function runFixture({ outcome = 'in-progress', completed = [], tail = [], runId = 'run-1234567890-private' } = {}) {
  const events = [
    event(1, 'run.started', 'initialise', {
      compatibility: { profileVersion: 'profile-v3', pipelineVersion: 'pipeline-v9' },
    }),
    ...completed.map((stageId, index) => event(index + 2, 'stage.completed', stageId, {})),
    ...tail,
  ];
  return {
    manifest: {
      runId, outcome,
      compatibility: { profileVersion: 'profile-v3', pipelineVersion: 'pipeline-v9' },
      completedWork: completed.map((stageId, index) => ({ stageId, sequence: index + 2 })),
      recoveryAttempts: tail.filter((item) => item.type === 'recovery.started'),
    },
    events,
  };
}

test('public run summaries cover every durable pipeline and terminal state', () => {
  const cases = [
    ['collecting', []],
    ['normalising', ['collect']],
    ['deduplicating', ['collect', 'normalise']],
    ['filtering', ['collect', 'normalise', 'deduplicate']],
    ['ranking', ['collect', 'normalise', 'deduplicate', 'filter']],
    ['selecting', ['collect', 'normalise', 'deduplicate', 'filter', 'rank']],
    ['assessing', ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select']],
    ['updating-tracker', ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select', 'assess']],
    ['writing-report', ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select', 'assess', 'tracker']],
  ];
  for (const [want, completed] of cases) {
    const fixture = runFixture({ completed });
    assert.equal(publicRunSummary(fixture.manifest, { events: fixture.events }).state, want);
  }
  for (const outcome of ['partial', 'abandoned', 'failed', 'complete']) {
    const fixture = runFixture({ outcome });
    assert.equal(publicRunSummary(fixture.manifest, { events: fixture.events }).state, outcome);
  }
});

test('public run summaries show durable assessment repair, batch progress and recovery evidence', () => {
  const selected = ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'];
  const assessment = runFixture({
    completed: selected,
    tail: [
      event(8, 'assessment.batch-attempted', 'assessment', {
        reference: { id: 'batch-1' }, count: 10, attempt: 'batch',
      }),
      event(9, 'assessment.batch-completed', 'assessment', {
        reference: { id: 'batch-1' }, count: 10,
      }),
      event(10, 'assessment.batch-attempted', 'assessment', {
        reference: { id: 'batch-2' }, count: 3, attempt: 'repair',
      }),
      event(11, 'assessment.job-completed', 'assessment', { reference: { id: 'job-11' } }),
      event(12, 'assessment.job-failed', 'assessment', { reference: { id: 'job-12' } }),
    ],
  });
  assessment.manifest.completedWork.find((work) => work.stageId === 'select').count = 20;
  const repairing = publicRunSummary(assessment.manifest, { events: assessment.events });
  assert.equal(repairing.state, 'repairing');
  assert.deepEqual(repairing.assessment, {
    currentBatch: 2, totalBatches: 2, totalBatchesExact: false,
    completedBatches: 1, completedJobs: 1, failedJobs: 1,
  });

  const recoveryEvent = event(8, 'recovery.started', 'recover', {});
  const recovery = runFixture({ completed: ['collect'], tail: [recoveryEvent] });
  recovery.manifest.recoveryAttempts = [{ sequence: 8 }];
  const summary = publicRunSummary(recovery.manifest, { events: recovery.events });
  assert.equal(summary.state, 'recovering');
  assert.equal(summary.recoveryCount, 1);
});

test('active assessment totals are marked as lower bounds and missing failure reasons stay auditable', () => {
  const active = runFixture({
    completed: ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'],
    tail: [event(8, 'assessment.batch-attempted', 'assessment', {
      reference: { id: 'context-limited-batch-1' }, count: 2, attempt: 'batch',
    })],
  });
  active.manifest.completedWork.find((work) => work.stageId === 'select').count = 20;
  assert.deepEqual(publicRunSummary(active.manifest, { events: active.events }).assessment, {
    currentBatch: 1, totalBatches: 2, totalBatchesExact: false,
    completedBatches: 0, completedJobs: 0, failedJobs: 0,
  });

  const failed = runFixture({ outcome: 'failed' });
  assert.equal(
    publicRunSummary(failed.manifest, { events: failed.events }).terminalReason,
    'reason-not-recorded',
  );
});

test('assessment restart recovery ignores superseded batches and jobs for schema v1 and upstream schema v2', () => {
  for (const recovery of [
    event(12, 'recovery.started', 'recover', { schemaVersion: 1 }, 2),
    event(12, 'recovery.started', 'recover', {
      schemaVersion: 2,
      decisions: [{ stageId: 'select', action: 'restart', reason: 'ranking-version-mismatch' }],
    }, 2),
  ]) {
    const fixture = runFixture({
      completed: ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'],
      tail: [
        event(8, 'assessment.batch-attempted', 'assessment', {
          reference: { id: 'old-batch' }, count: 2, attempt: 'batch',
        }),
        event(9, 'assessment.job-completed', 'assessment', { reference: { id: 'old-complete' } }),
        event(10, 'assessment.job-failed', 'assessment', { reference: { id: 'old-failed' } }),
        event(11, 'assessment.batch-completed', 'assessment', {
          reference: { id: 'old-batch' }, count: 2,
        }),
        recovery,
        event(13, 'assessment.batch-attempted', 'assessment', {
          reference: { id: 'new-batch' }, count: 1, attempt: 'batch',
        }, 2),
      ],
    });
    fixture.manifest.completedWork.find((work) => work.stageId === 'select').count = 20;
    assert.deepEqual(publicRunSummary(fixture.manifest, { events: fixture.events }).assessment, {
      currentBatch: 1, totalBatches: 2, totalBatchesExact: false,
      completedBatches: 0, completedJobs: 0, failedJobs: 0,
    });
  }
});

test('assessment reuse recovery preserves valid earlier progress', () => {
  const fixture = runFixture({
    completed: ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'],
    tail: [
      event(8, 'assessment.batch-attempted', 'assessment', {
        reference: { id: 'batch-1' }, count: 2, attempt: 'batch',
      }),
      event(9, 'assessment.job-completed', 'assessment', { reference: { id: 'job-complete' } }),
      event(10, 'assessment.job-failed', 'assessment', { reference: { id: 'job-failed' } }),
      event(11, 'assessment.batch-completed', 'assessment', {
        reference: { id: 'batch-1' }, count: 2,
      }),
      event(12, 'recovery.started', 'recover', {
        schemaVersion: 2,
        decisions: [{ stageId: 'assess', action: 'reuse', reason: 'compatible' }],
      }, 2),
      event(13, 'assessment.batch-attempted', 'assessment', {
        reference: { id: 'batch-2' }, count: 1, attempt: 'batch',
      }, 2),
    ],
  });
  assert.deepEqual(publicRunSummary(fixture.manifest, { events: fixture.events }).assessment, {
    currentBatch: 2, totalBatches: 2, totalBatchesExact: false,
    completedBatches: 1, completedJobs: 1, failedJobs: 1,
  });
});

test('superseded repair attempts cannot control state after an upstream restart resumes collection', () => {
  const fixture = runFixture({
    completed: ['collect'],
    tail: [
      event(3, 'assessment.batch-attempted', 'assessment', {
        reference: { id: 'old-batch' }, count: 1, attempt: 'repair',
      }),
      event(4, 'recovery.started', 'recover', {
        schemaVersion: 2,
        decisions: [{ stageId: 'collect', action: 'restart', reason: 'ranking-version-mismatch' }],
      }, 2),
      event(5, 'stage.completed', 'collect', {}, 2),
    ],
  });
  assert.equal(publicRunSummary(fixture.manifest, { events: fixture.events }).state, 'normalising');
  assert.equal(publicRunSummary(fixture.manifest, { events: fixture.events }).assessment, null);
});

test('assessment reuse keeps a valid repair attempt eligible for current state', () => {
  const fixture = runFixture({
    completed: ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'],
    tail: [
      event(8, 'assessment.batch-attempted', 'assessment', {
        reference: { id: 'reused-batch' }, count: 1, attempt: 'repair',
      }),
      event(9, 'recovery.started', 'recover', {
        schemaVersion: 2,
        decisions: [{ stageId: 'assess', action: 'reuse', reason: 'compatible' }],
      }, 2),
      event(10, 'assessment.job-completed', 'assessment', {
        reference: { id: 'reused-job' },
      }, 2),
    ],
  });
  const summary = publicRunSummary(fixture.manifest, { events: fixture.events });
  assert.equal(summary.state, 'repairing');
  assert.equal(summary.assessment.currentBatch, 1);
  assert.equal(summary.assessment.completedJobs, 1);
});

test('active worker is shown only for a current nonterminal lease', () => {
  const now = new Date('2026-07-29T00:00:30.000Z');
  const fixture = runFixture();
  const lease = {
    runId: fixture.manifest.runId,
    expiresAt: '2026-07-29T00:01:00.000Z',
    lastTerminalSequence: null,
    owner: { host: 'PRIVATE-HOST', pid: 4242, processStart: 'private-start' },
  };
  assert.equal(publicRunSummary(fixture.manifest, { events: fixture.events, lease, now }).owner, 'active worker');
  assert.equal(publicRunSummary(fixture.manifest, {
    events: fixture.events,
    lease: { ...lease, expiresAt: '2026-07-29T00:00:30.000Z' },
    now,
  }).owner, null);
  assert.equal(publicRunSummary({ ...fixture.manifest, outcome: 'complete' }, {
    events: fixture.events,
    lease: { ...lease, lastTerminalSequence: 4 },
    now,
  }).owner, null);
});

test('public run and queue summaries use closed privacy-safe projections', () => {
  const fullRunId = 'run-1234567890-private';
  const fixture = runFixture({
    runId: fullRunId,
    outcome: 'failed',
    tail: [event(2, 'run.failure-recorded', 'finalise', {
      code: 'provider-timeout', reason: 'provider-timeout',
      prompt: 'private prompt', advert: 'full advert body', providerOutput: 'raw output',
    })],
  });
  fixture.manifest.host = 'PRIVATE-HOST';
  fixture.manifest.pid = 4242;
  fixture.manifest.path = 'C:\\private\\workspace';
  fixture.manifest.cv = 'private CV body';
  const run = publicRunSummary(fixture.manifest, {
    events: fixture.events,
    lease: {
      runId: fullRunId, expiresAt: '2026-07-29T01:00:00.000Z', lastTerminalSequence: null,
      owner: { host: 'PRIVATE-HOST', pid: 4242, processStart: 'private-start' },
    },
    now: new Date('2026-07-29T00:30:00.000Z'),
  });
  assert.equal(run.id, 'run-1234…');
  assert.equal(run.owner, null);
  assert.equal(run.terminalReason, 'provider-timeout');
  const runText = JSON.stringify(run);
  for (const secret of [fullRunId, 'PRIVATE-HOST', '4242', 'private-start', 'C:\\\\private', 'private prompt', 'full advert body', 'raw output', 'private CV body']) {
    assert.doesNotMatch(runText, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  const queue = publicQueueSummary({
    generatedAt: '2026-07-29T01:00:00.000Z',
    requests: [{
      id: 'request-1234567890-private', status: 'claimed', requester: 'manual',
      purpose: 'job-discovery', requestedAt: '2026-07-29T00:00:00.000Z',
      expiresAt: '2026-07-30T00:00:00.000Z',
      compatibility: { profileFingerprint: 'a'.repeat(64), configFingerprint: 'b'.repeat(64) },
      execution: { prompt: 'private prompt', token: 'secret-token' },
      claim: {
        runId: fullRunId, leaseId: 'private-lease', generation: 7,
        owner: { host: 'PRIVATE-HOST', pid: 4242, processStart: 'private-start' },
      },
    }],
  });
  assert.deepEqual(queue.requests[0], {
    id: 'request-…', status: 'claimed', requester: 'manual', purpose: 'job-discovery',
    requestedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-30T00:00:00.000Z',
    runId: 'run-1234…', owner: 'active worker',
  });
  assert.doesNotMatch(JSON.stringify(queue), /PRIVATE-HOST|4242|private-start|private-lease|secret-token|private prompt|a{32}|b{32}/i);
});

test('a corrupt run directory never publishes its unvalidated name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-public-run-corrupt-'));
  try {
    const directory = path.join(root, '.scout', 'runs', 'private-looking-prefix-secret');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'journal.jsonl'), '{"not":"a journal"}\n');
    const result = readPublicRunSummaries(root);
    assert.equal(result.runs[0].id, 'invalid-run');
    assert.doesNotMatch(JSON.stringify(result), /private-looking-prefix-secret|private-looking/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

