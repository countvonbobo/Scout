import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  acquireScanLease, assertCurrentFence, currentLeaseOwner, readScanLease,
  releaseScanLease, renewScanLease, startLeaseHeartbeat, synchronousFenceCallback,
} from '../../ui/lib/scanLease.mjs';
import {
  assessScanCandidates, PipelineInterruptedError, runScanPipeline,
} from '../../ui/lib/scanPipeline.mjs';
import {
  claimNextScanRequest, completeScanRequest, coverScheduledScanWindow,
  enqueueScanRequest, projectScanQueue, recoverOrphanedScanRequest,
} from '../../ui/lib/scanQueue.mjs';
import {
  initializeRecoveryBackup, verifyReviewedRunArchive, writeReviewedRunArchive,
} from '../../ui/lib/recoveryBackup.mjs';
import {
  archiveSelectedRuns, compactScanQueue, measureRunStorage, planRunCleanup,
} from '../../ui/lib/runRetention.mjs';
import {
  MutationConflictError, applyPreparedMutation, prepareMutation, reconcileMutation,
  withMutationCoordinator,
} from '../../ui/lib/mutationCoordinator.mjs';
import {
  scanReportRecipe, trackerMergeRecipe,
} from '../../ui/lib/scanMutationProjection.mjs';
import {
  openRunJournal, replayRunJournal, validateRunJournal,
} from '../../ui/lib/runJournal.mjs';
import {
  resolveBackupDivergence, saveSyncSettings,
} from '../../ui/lib/workspaceSync.mjs';

const DURABLE_STAGES = ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'];
const ACCEPTANCE_COMPATIBILITY = Object.freeze({
  schemaVersion: 1,
  mode: 'primary',
  purpose: 'manual-discovery',
  profileVersion: 'profile-v1',
  sourceConfigFingerprint: 'a'.repeat(64),
  journalSchemaVersion: 1,
  artifactSchemaVersion: 1,
  pipelineVersion: 'pipeline-v1',
  rankingVersion: 'ranking-v1',
  promptVersion: 'prompt-v1',
  assessmentSchemaVersion: 1,
  provider: 'codex',
  model: 'provider-default',
  mutationSchemaVersion: 1,
  targetRevision: 'tracker-v1',
});
const QUEUE_COMPATIBILITY = Object.freeze({
  profileFingerprint: 'b'.repeat(64),
  configFingerprint: 'c'.repeat(64),
  schemaVersion: 1,
});
const ASSESSMENT_CONTEXT_DIGESTS = Object.freeze({
  scoringConfigDigest: '1'.repeat(64),
  profileDigest: '2'.repeat(64),
  calibrationDigest: '3'.repeat(64),
  masterCvDigest: '4'.repeat(64),
});

const PRIVATE_SENTINELS = [
  'PRIVATE-HOST',
  ['', 'Users', 'synthetic-private'].join('/'),
  'SYNTHETIC-AUTH-CODE',
  'SYNTHETIC-PRIVATE-PROMPT',
  'SYNTHETIC-PROVIDER-TRANSCRIPT',
  'utm_source=synthetic-private',
];

function setupStatus() {
  return {
    bootstrap: false,
    established: true,
    ready: true,
    setupComplete: true,
    trackerExists: true,
    config: {
      locale: 'en-GB',
      ai: { provider: 'codex', models: { codex: null, claude: null } },
      search: {},
      commute: {},
    },
    providers: {
      codex: {
        installed: true,
        authenticated: true,
        capabilities: { structuredOutput: true },
      },
      claude: {
        installed: true,
        authenticated: false,
        capabilities: { structuredOutput: true },
      },
    },
    scanHealth: { healthy: false, lastRunAt: null },
    schedule: { enabled: false, runs: [] },
    sync: { state: 'disabled' },
    device: { updates: { policy: 'notify' }, startupStatus: {} },
    remoteAccess: {},
    pendingSetupSections: [],
  };
}

async function installRecoverableRoutes(page, state) {
  await page.route('**/api/setup/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(setupStatus()),
  }));
  await page.route('**/api/opportunities', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      updated: '2026-07-29',
      opportunities: [],
      triage: { action: [], unlock: [], followups: [], other: [] },
      pipeline: {
        summary: {},
        new: [],
        watch: [],
        active: [],
        recentlyClosed: [],
        flags: [],
      },
      scanHealth: { healthy: false, lastRunAt: null, sourceHealth: [] },
      categories: [],
      workspaceConfig: { ai: { provider: 'codex' }, commute: {} },
      trackerRevision: 'synthetic-revision',
    }),
  }));
  await page.route('**/api/cv', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      master: null,
      masterRender: {},
      applications: [],
      entries: [],
    }),
  }));
  await page.route('**/api/scans/latest', (route) => route.fulfill({
    contentType: 'application/json',
    body: '{"scan":null}',
  }));
  await page.route('**/api/scan/runs', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(state.runs),
  }));
  await page.route('**/api/scan/queue', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(state.queue),
  }));
  await page.route('**/api/provider-login/status?*', (route) => {
    const provider = new URL(route.request().url()).searchParams.get('provider');
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        provider,
        session: null,
        csrfToken: `csrf-${provider}-synthetic-000000000000`,
      }),
    });
  });
}

function publicRun(state, label, fields = {}) {
  return {
    id: 'run-synthetic…',
    state,
    label,
    owner: state === 'complete' ? 'inactive worker' : 'active worker',
    startedAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:01:00.000Z',
    recoveryCount: fields.recoveryCount || 0,
    completedStages: fields.completedStages || [],
    assessment: fields.assessment || null,
    terminalReason: fields.terminalReason || null,
    // Fault-injected fields are intentionally outside the public contract.
    host: PRIVATE_SENTINELS[0],
    pid: 4242,
    workingDirectory: PRIVATE_SENTINELS[1],
    authCode: PRIVATE_SENTINELS[2],
    prompt: PRIVATE_SENTINELS[3],
    providerTranscript: PRIVATE_SENTINELS[4],
    sourceUrl: `https://example.test/job?${PRIVATE_SENTINELS[5]}`,
  };
}

function acceptanceStages(calls = new Map()) {
  return Object.fromEntries(DURABLE_STAGES.map((stageId) => [stageId, async ({
    priorArtifact,
  }) => {
    calls.set(stageId, (calls.get(stageId) || 0) + 1);
    return {
      stageId,
      stableIds: [...(priorArtifact?.stableIds || []), `${stageId}-accepted`],
    };
  }]));
}

function acceptanceCandidates() {
  return Array.from({ length: 3 }, (_, index) => ({
    vacancyId: `acceptance-candidate-${index + 1}`,
    candidateId: `acceptance-candidate-${index + 1}`,
    company: `Synthetic employer ${index + 1}`,
    role: 'Synthetic engineer',
    url: `https://example.test/jobs/${index + 1}`,
    description: `Synthetic responsibility ${index + 1}.`,
    mandatorySignals: [{
      id: 'mandatory-01',
      text: 'Synthetic evidence is mandatory.',
    }],
  }));
}

function acceptanceAssessment(candidateId, overrides = {}) {
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
    dimensions: [{
      name: 'fit',
      score: 80,
      maximum: 100,
      evidence: 'Bounded synthetic evidence.',
    }],
    recommendation: 'keep',
    ...overrides,
  };
}

function acceptanceMutation(root, lease, runId = lease.runId) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  const tracker = path.join(root, 'data', 'opportunities.json');
  const report = path.join(root, 'reports', '2026-07-29.md');
  const initialTracker = '{\n  "updated": "2026-07-29",\n  "opportunities": []\n}\n';
  const intendedTracker = '{\n  "updated": "2026-07-29",\n  "opportunities": [{"id":"accepted-role","company":"Synthetic employer","role":"Engineer"}]\n}\n';
  fs.writeFileSync(tracker, initialTracker);
  fs.writeFileSync(report, '# Scout report\n\n## Headline\n\nBefore.\n');
  const handle = openRunJournal(root, runId);
  const plan = prepareMutation({ handle, lease }, {
    id: 'acceptance-tracker-report',
    schemaVersion: 1,
    files: [
      { kind: 'tracker', key: 'tracker' },
      { kind: 'report', key: 'report:2026-07-29' },
    ],
  }, {
    tracker: trackerMergeRecipe(initialTracker, intendedTracker),
    'report:2026-07-29': scanReportRecipe({
      date: '2026-07-29',
      degraded: true,
      coverage: [],
      actions: [],
      checks: [],
      keeperCount: 1,
      discarded: {},
      nearMisses: [],
      errors: ['assessment-retries-exhausted'],
      runs: [],
    }),
  });
  return { handle, plan, report, tracker };
}

test('production pipeline recovers through every durable discovery boundary', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  test.setTimeout(60_000);
  for (const interruptedAfter of DURABLE_STAGES) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `scout-${interruptedAfter}-acceptance-`));
    const calls = new Map();
    let now = Date.parse('2026-07-29T10:00:00.000Z');
    const leaseOptions = {
      wallNow: () => now,
      monotonicNow: () => now,
      leaseDurationMs: 1_000,
      takeoverMarginMs: 0,
    };
    let interruptedRunId;
    try {
      await expect(runScanPipeline({
        root,
        compatibility: ACCEPTANCE_COMPATIBILITY,
        stages: acceptanceStages(calls),
        leaseOptions,
        onStageCommitted({ stageId, run }) {
          if (stageId !== interruptedAfter) return;
          interruptedRunId = run.runId;
          now += 1_001;
          throw new PipelineInterruptedError(`fault after ${stageId}`);
        },
      })).rejects.toThrow(PipelineInterruptedError);

      const beforeRecovery = Object.fromEntries(calls);
      const recovered = await runScanPipeline({
        root,
        compatibility: ACCEPTANCE_COMPATIBILITY,
        stages: acceptanceStages(calls),
        leaseOptions,
      });

      expect(recovered).toMatchObject({ runId: interruptedRunId, outcome: 'complete' });
      const interruptedIndex = DURABLE_STAGES.indexOf(interruptedAfter);
      for (const stageId of DURABLE_STAGES.slice(0, interruptedIndex + 1)) {
        expect(calls.get(stageId)).toBe(beforeRecovery[stageId]);
      }
      for (const stageId of DURABLE_STAGES.slice(interruptedIndex + 1)) {
        expect(calls.get(stageId)).toBe(1);
      }
      expect(recovered.manifest.completedWork.map(({ stageId }) => stageId))
        .toEqual(DURABLE_STAGES);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('production assessment repair, retry and completed-work reuse survive finalisation death', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-assessment-acceptance-'));
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const leaseOptions = {
    wallNow: () => now,
    monotonicNow: () => now,
    leaseDurationMs: 1_000,
    takeoverMarginMs: 0,
  };
  const providerCalls = [];
  let interruptAfterAssessment = true;
  const invokeProvider = async ({ kind, jobs }) => {
    const ids = jobs.map(({ candidateId }) => candidateId);
    providerCalls.push({ kind, ids });
    if (kind === 'batch') {
      return { assessments: [acceptanceAssessment(ids[0])] };
    }
    if (kind === 'repair') {
      return {
        assessments: ids.map((id) => acceptanceAssessment(id, {
          mandatoryRequirements: [],
        })),
      };
    }
    if (ids[0] === 'acceptance-candidate-2') {
      return { assessments: [acceptanceAssessment(ids[0])] };
    }
    return {
      assessments: [acceptanceAssessment(ids[0], { dimensions: [] })],
    };
  };
  const finalize = async ({ run, lease }) => {
    const assessed = await assessScanCandidates({
      run,
      lease,
      candidates: acceptanceCandidates(),
      compatibility: ACCEPTANCE_COMPATIBILITY,
      invokeProvider,
      contextBudgetCharacters: 10_000,
      contextDigests: ASSESSMENT_CONTEXT_DIGESTS,
    });
    if (interruptAfterAssessment) {
      interruptAfterAssessment = false;
      now += 1_001;
      throw new PipelineInterruptedError('fault after assessment work before terminalisation');
    }
    return assessed;
  };
  try {
    await expect(runScanPipeline({
      root,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
      leaseOptions,
      finalize,
    })).rejects.toThrow(PipelineInterruptedError);
    expect(providerCalls).toEqual([
      {
        kind: 'batch',
        ids: [
          'acceptance-candidate-1',
          'acceptance-candidate-2',
          'acceptance-candidate-3',
        ],
      },
      {
        kind: 'repair',
        ids: ['acceptance-candidate-2', 'acceptance-candidate-3'],
      },
      { kind: 'retry', ids: ['acceptance-candidate-2'] },
      { kind: 'retry', ids: ['acceptance-candidate-3'] },
    ]);

    const callCountBeforeRecovery = providerCalls.length;
    const recovered = await runScanPipeline({
      root,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
      leaseOptions,
      finalize,
    });
    expect(providerCalls).toHaveLength(callCountBeforeRecovery);
    expect(recovered.outcome).toBe('complete');
    expect(recovered.stageOutputs.finalize.assessments.map(({ candidateId }) => candidateId))
      .toEqual(['acceptance-candidate-1', 'acceptance-candidate-2']);
    expect(recovered.stageOutputs.finalize.failures).toEqual([{
      jobId: 'acceptance-candidate-3',
      code: 'assessment-validation-exhausted',
      attempts: 3,
      validationFailures: ['dimensions-required'],
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a stale production assessment worker cannot append batch, journal or terminal evidence', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-stale-assessment-'));
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  let successor;
  let interruptedRun;
  const leaseOptions = {
    wallNow: () => now,
    monotonicNow: () => now,
    leaseDurationMs: 1_000,
    takeoverMarginMs: 0,
  };
  try {
    const stale = await runScanPipeline({
      root,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
      leaseOptions,
      finalize: async ({ run, lease }) => {
        interruptedRun = run;
        return assessScanCandidates({
          run,
          lease,
          candidates: acceptanceCandidates().slice(0, 1),
          compatibility: ACCEPTANCE_COMPATIBILITY,
          contextBudgetCharacters: 10_000,
          contextDigests: ASSESSMENT_CONTEXT_DIGESTS,
          async invokeProvider({ jobs }) {
            now += 1_001;
            successor = acquireScanLease(root, currentLeaseOwner(), {
              kind: 'scan',
              runId: 'assessment-successor',
              phase: 'assessment',
            }, leaseOptions);
            return {
              assessments: jobs.map(({ candidateId }) => (
                acceptanceAssessment(candidateId)
              )),
            };
          },
        });
      },
    });
    expect(stale).toMatchObject({
      outcome: 'lease-lost',
      failures: [{ code: 'lease-lost', stage: 'finalise' }],
    });
    expect(successor?.runId).toBe('assessment-successor');
    const types = replayRunJournal(interruptedRun.file).map(({ type }) => type);
    expect(types).toContain('assessment.batch-attempted');
    expect(types).not.toContain('assessment.job-completed');
    expect(types).not.toContain('assessment.batch-completed');
    expect(types).not.toContain('run.completed');
  } finally {
    if (successor) releaseScanLease(successor);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production mutation coordinator reconciles every write crash window and rejects stale ambiguity', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mutation-acceptance-'));
  let lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan',
    runId: 'acceptance-mutation',
    phase: 'finalise',
  });
  try {
    const { handle, plan, tracker } = acceptanceMutation(root, lease);
    expect(() => applyPreparedMutation(plan, lease, {
      beforeReplacement() {
        throw new Error('fault before write');
      },
    })).toThrow('fault before write');
    expect(reconcileMutation(plan).status).toBe('prepared');

    expect(() => applyPreparedMutation(plan, lease, {
      afterReplacement() {
        throw new Error('fault during replacement set');
      },
    })).toThrow('fault during replacement set');
    expect(reconcileMutation(plan).status).toBe('partially-applied');

    expect(() => applyPreparedMutation(plan, lease, {
      afterReplacement() {
        throw new Error('fault after all writes before receipt');
      },
    })).toThrow('fault after all writes before receipt');
    expect(reconcileMutation(plan).status).toBe('applied-unreceipted');

    let replayedWrites = 0;
    const receipt = applyPreparedMutation(plan, lease, {
      beforeReplacement() {
        replayedWrites += 1;
      },
    });
    expect(replayedWrites).toBe(0);
    expect(reconcileMutation(plan).status).toBe('receipted');
    expect(replayRunJournal(handle.file).filter(({ type }) => type === 'mutation.receipted'))
      .toHaveLength(1);
    saveSyncSettings(root, {
      enabled: true,
      remoteUrl: 'https://github.com/example/scout-backup.git',
      dataKey: null,
    });
    await withMutationCoordinator(root, lease, async () => {
      await expect(resolveBackupDivergence(
        root,
        'a'.repeat(64),
        lease,
        { spawn: () => { throw new Error('Git must not run across the mutation guard'); } },
      )).rejects.toThrow(/another workspace mutation is in progress/i);
    });

    releaseScanLease(lease);
    const staleLease = lease;
    lease = acquireScanLease(root, currentLeaseOwner(), {
      kind: 'scan',
      runId: 'acceptance-mutation-successor',
      phase: 'finalise',
    });
    expect(() => applyPreparedMutation(plan, staleLease)).toThrow(/lease|scope/i);

    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mutation-ambiguous-'));
    let secondLease = acquireScanLease(secondRoot, currentLeaseOwner(), {
      kind: 'scan',
      runId: 'acceptance-mutation-ambiguous',
      phase: 'finalise',
    });
    try {
      const ambiguous = acceptanceMutation(secondRoot, secondLease);
      fs.writeFileSync(
        ambiguous.tracker,
        '{"updated":"2026-07-29","opportunities":[{"id":"operator-edit"}]}\n',
      );
      expect(() => reconcileMutation(ambiguous.plan)).toThrow(MutationConflictError);
      expect(() => applyPreparedMutation(ambiguous.plan, secondLease))
        .toThrow(MutationConflictError);
    } finally {
      releaseScanLease(secondLease);
      secondLease = null;
      fs.rmSync(secondRoot, { recursive: true, force: true });
    }
    expect(JSON.parse(fs.readFileSync(tracker, 'utf8')).opportunities[0].id)
      .toBe('accepted-role');
  } finally {
    if (lease) releaseScanLease(lease);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production recovery quarantines a torn append, rebuilds disagreement and fails closed on a valid corrupt record', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const leaseOptions = {
    wallNow: () => now,
    monotonicNow: () => now,
    leaseDurationMs: 1_000,
    takeoverMarginMs: 0,
  };
  const recoverableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-journal-recovery-'));
  const corruptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-journal-corrupt-'));
  try {
    let recoverableRun;
    await expect(runScanPipeline({
      root: recoverableRoot,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
      leaseOptions,
      onStageCommitted({ stageId, run }) {
        if (stageId !== 'collect') return;
        recoverableRun = run;
        now += 1_001;
        throw new PipelineInterruptedError('fault before torn append');
      },
    })).rejects.toThrow(PipelineInterruptedError);
    fs.appendFileSync(recoverableRun.file, '{"schemaVersion":');
    const manifestFile = path.join(recoverableRun.directory, 'manifest.json');
    const disagreement = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    disagreement.completedWork = [];
    fs.writeFileSync(manifestFile, `${JSON.stringify(disagreement)}\n`);

    const recovered = await runScanPipeline({
      root: recoverableRoot,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
      leaseOptions,
    });
    expect(recovered.outcome).toBe('complete');
    expect(fs.readdirSync(recoverableRun.directory)
      .filter((name) => name.startsWith('journal.truncated.'))).toHaveLength(1);
    expect(validateRunJournal(recoverableRun.file).truncatedTail).toBe(false);
    expect(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).completedWork
      .map(({ stageId }) => stageId)).toEqual(DURABLE_STAGES);

    let corruptRun;
    await expect(runScanPipeline({
      root: corruptRoot,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
      leaseOptions,
      onStageCommitted({ stageId, run }) {
        if (stageId !== 'collect') return;
        corruptRun = run;
        now += 1_001;
        throw new PipelineInterruptedError('fault before complete corruption');
      },
    })).rejects.toThrow(PipelineInterruptedError);
    const lines = fs.readFileSync(corruptRun.file, 'utf8').trimEnd().split('\n');
    const damaged = JSON.parse(lines.at(-1));
    damaged.eventHash = '0'.repeat(64);
    lines[lines.length - 1] = JSON.stringify(damaged);
    fs.writeFileSync(corruptRun.file, `${lines.join('\n')}\n`);
    const corruptBytes = fs.readFileSync(corruptRun.file);
    expect(() => validateRunJournal(corruptRun.file)).toThrow(/hash|journal/i);
    expect(() => validateRunJournal(corruptRun.file)).toThrow(/hash|journal/i);
    expect(fs.readFileSync(corruptRun.file)).toEqual(corruptBytes);
  } finally {
    fs.rmSync(recoverableRoot, { recursive: true, force: true });
    fs.rmSync(corruptRoot, { recursive: true, force: true });
  }
});

test('production lease arbitration covers contention, heartbeat, death, boot identity and one-way migration', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  const roots = [];
  const makeRoot = (name) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `scout-${name}-`));
    roots.push(root);
    return root;
  };
  const operation = (runId, phase = 'collect') => ({
    kind: 'scan', runId, phase,
  });
  try {
    const contentionRoot = makeRoot('contention');
    const contenders = await Promise.all([
      Promise.resolve().then(() => acquireScanLease(
        contentionRoot, currentLeaseOwner(), operation('contender-a'),
      )),
      Promise.resolve().then(() => acquireScanLease(
        contentionRoot, currentLeaseOwner(), operation('contender-b'),
      )),
    ]);
    expect(contenders.filter(Boolean)).toHaveLength(1);
    expect(contenders.filter((lease) => lease === null)).toHaveLength(1);
    releaseScanLease(contenders.find(Boolean));

    const heartbeatRoot = makeRoot('heartbeat');
    let wall = Date.parse('2026-07-29T10:00:00.000Z');
    let monotonic = 0;
    const timers = [];
    const heartbeatLease = acquireScanLease(
      heartbeatRoot,
      currentLeaseOwner(),
      operation('heartbeat-owner'),
      {
        wallNow: () => wall,
        monotonicNow: () => monotonic,
        leaseDurationMs: 1_000,
        takeoverMarginMs: 0,
      },
    );
    const heartbeat = startLeaseHeartbeat(heartbeatLease, {
      intervalMs: 500,
      wallNow: () => wall,
      monotonicNow: () => monotonic,
      setTimeoutFn(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeoutFn() {},
    });
    wall += 600;
    monotonic += 600;
    timers.shift()();
    expect(readScanLease(heartbeatRoot).heartbeatSequence).toBe(1);
    wall += 600;
    monotonic += 600;
    expect(acquireScanLease(
      heartbeatRoot,
      currentLeaseOwner(),
      operation('blocked-takeover'),
      {
        wallNow: () => wall,
        monotonicNow: () => monotonic,
        leaseDurationMs: 1_000,
        takeoverMarginMs: 0,
      },
    )).toBeNull();
    heartbeat.stop();
    wall += 401;
    monotonic += 401;
    const successor = acquireScanLease(
      heartbeatRoot,
      currentLeaseOwner(),
      operation('post-death-successor'),
      {
        wallNow: () => wall,
        monotonicNow: () => monotonic,
        leaseDurationMs: 1_000,
        takeoverMarginMs: 0,
      },
    );
    expect(successor.recoveryCount).toBeUndefined();
    expect(readScanLease(heartbeatRoot)).toMatchObject({
      runId: 'post-death-successor',
      recoveryCount: 1,
    });
    expect(() => renewScanLease(heartbeatLease)).toThrow(/lease/i);
    releaseScanLease(successor);

    const restartRoot = makeRoot('restart-identity');
    const guard = path.join(restartRoot, '.scout', 'scan-lease.guard');
    fs.mkdirSync(guard, { recursive: true });
    fs.writeFileSync(path.join(guard, 'pre-restart-owner.json'), `${JSON.stringify({
      schemaVersion: 1,
      guardId: 'pre-restart-owner',
      owner: {
        host: os.hostname(),
        pid: process.pid,
        processStart: 'pre-restart-boot-identity',
      },
      acquiredAt: '2026-07-29T09:00:00.000Z',
    })}\n`);
    let identityChecks = 0;
    const afterRestart = acquireScanLease(
      restartRoot,
      currentLeaseOwner(),
      operation('after-machine-restart'),
      {
        wallNow: () => Date.parse('2026-07-29T10:00:00.000Z'),
        monotonicNow: () => 0,
        guardAcquireTimeoutMs: 0,
        _testHooks: {
          ownerIsLive(owner) {
            identityChecks += 1;
            return owner.processStart === currentLeaseOwner().processStart;
          },
        },
      },
    );
    expect(afterRestart?.runId).toBe('after-machine-restart');
    expect(identityChecks).toBeGreaterThan(0);
    releaseScanLease(afterRestart);

    const migrationRoot = makeRoot('legacy-migration');
    fs.writeFileSync(path.join(migrationRoot, '.scout-scan.lock'), `${JSON.stringify({
      agent: 'legacy-scout',
      mode: 'primary',
      token: ['legacy', 'stopped', 'owner'].join('-'),
      startedAt: '2026-07-29T07:00:00.000Z',
      owner: {
        host: os.hostname(),
        pid: 999_999_999,
        processStart: 'stopped-process',
      },
    })}\n`);
    const migrated = acquireScanLease(
      migrationRoot,
      currentLeaseOwner(),
      operation('fenced-activation'),
      { wallNow: () => Date.parse('2026-07-29T10:00:01.000Z') },
    );
    expect(migrated?.generation).toBe(1);
    expect(fs.existsSync(path.join(migrationRoot, '.scout-scan.lock'))).toBe(false);
    releaseScanLease(migrated);
    fs.writeFileSync(path.join(migrationRoot, '.scout-scan.lock'), `${JSON.stringify({
      agent: 'legacy-scout',
      mode: 'primary',
      token: ['legacy', 'downgrade'].join('-'),
      startedAt: '2026-07-29T10:00:02.000Z',
    })}\n`);
    expect(() => acquireScanLease(
      migrationRoot,
      currentLeaseOwner(),
      operation('refuse-downgrade'),
    )).toThrow(/downgrade|coexistence/i);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production queue deduplicates, expires, supersedes, recovers claims and hands off automatically', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-queue-acceptance-'));
  const request = (id, lease, overrides = {}) => ({
    id,
    key: overrides.key || id,
    requestedAt: overrides.requestedAt || '2026-07-29T08:00:00.000Z',
    expiresAt: overrides.expiresAt || '2026-07-30T08:00:00.000Z',
    requester: overrides.requester || 'manual',
    windowAt: overrides.windowAt ?? null,
    purpose: 'manual-discovery',
    compatibility: QUEUE_COMPATIBILITY,
    lease,
  });
  let lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan', runId: 'queue-seed', phase: 'queue',
  });
  try {
    expect(enqueueScanRequest(root, request('manual-original', lease, {
      key: 'same-manual-work',
    })).status).toBe('enqueued');
    expect(enqueueScanRequest(root, request('manual-duplicate', lease, {
      key: 'same-manual-work',
    })).status).toBe('deduplicated');
    enqueueScanRequest(root, request('already-expired', lease, {
      requestedAt: '2026-07-28T08:00:00.000Z',
      expiresAt: '2026-07-29T08:00:00.000Z',
    }));
    enqueueScanRequest(root, request('scheduled-old', lease, {
      key: 'scheduled-window',
      requester: 'scheduled',
      windowAt: '2026-07-29T12:00:00.000Z',
      expiresAt: '2026-07-29T12:00:00.000Z',
    }));
    expect(enqueueScanRequest(root, request('scheduled-new', lease, {
      key: 'scheduled-window',
      requester: 'scheduled',
      requestedAt: '2026-07-29T08:30:00.000Z',
      windowAt: '2026-07-29T13:00:00.000Z',
      expiresAt: '2026-07-29T13:00:00.000Z',
    })).status).toBe('enqueued');
    expect(coverScheduledScanWindow(root, {
      scheduleId: 'different-schedule',
      logicalWindowId: '2026-07-29T12:00:00.000Z',
      purpose: 'manual-discovery',
      compatibilityFingerprint: 'f'.repeat(64),
    }, lease)).toEqual([]);
    releaseScanLease(lease);

    lease = acquireScanLease(root, currentLeaseOwner(), {
      kind: 'scan', runId: 'queue-claim-owner', phase: 'queue',
    });
    const claimed = claimNextScanRequest(
      root,
      { ...QUEUE_COMPATIBILITY, purpose: 'manual-discovery' },
      lease,
      new Date('2026-07-29T09:00:00.000Z'),
    );
    expect(claimed.id).toBe('manual-original');
    releaseScanLease(lease);

    lease = acquireScanLease(root, currentLeaseOwner(), {
      kind: 'scan', runId: 'queue-claim-recovery', phase: 'queue',
    });
    expect(() => completeScanRequest(root, claimed.id, 'succeeded', lease, claimed.claim))
      .toThrow(/claim|owner|fence/i);
    expect(recoverOrphanedScanRequest(root, claimed.id, claimed.claim, lease).status)
      .toBe('queued');
    const reclaimed = claimNextScanRequest(
      root,
      { ...QUEUE_COMPATIBILITY, purpose: 'manual-discovery' },
      lease,
      new Date('2026-07-29T09:01:00.000Z'),
    );
    expect(reclaimed.id).toBe('manual-original');
    completeScanRequest(root, reclaimed.id, 'succeeded', lease, reclaimed.claim);
    const scheduledClaim = claimNextScanRequest(
      root,
      { ...QUEUE_COMPATIBILITY, purpose: 'manual-discovery' },
      lease,
      new Date('2026-07-29T09:02:00.000Z'),
    );
    expect(scheduledClaim?.id).toBe('scheduled-new');
    completeScanRequest(root, scheduledClaim.id, 'succeeded', lease, scheduledClaim.claim);
    releaseScanLease(lease);

    lease = acquireScanLease(root, currentLeaseOwner(), {
      kind: 'scan', runId: 'queue-handoff-seed', phase: 'queue',
    });
    enqueueScanRequest(root, request('automatic-handoff', lease, {
      requestedAt: '2026-07-29T09:02:00.000Z',
      expiresAt: '2026-07-30T09:02:00.000Z',
    }));
    releaseScanLease(lease);
    lease = null;

    const handedOff = [];
    const primary = await runScanPipeline({
      root,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
      queue: {
        compatibility: QUEUE_COMPATIBILITY,
        now: new Date('2026-07-29T09:03:00.000Z'),
        async run(queued, context) {
          handedOff.push({
            id: queued.id,
            generation: context.lease.generation,
            active: readScanLease(root)?.generation,
          });
          return (await runScanPipeline({
            root,
            compatibility: ACCEPTANCE_COMPATIBILITY,
            stages: acceptanceStages(),
            claimedLease: context.lease,
          })).outcome;
        },
      },
    });
    expect(primary.outcome).toBe('complete');
    expect(handedOff).toEqual([expect.objectContaining({
      id: 'automatic-handoff',
    })]);
    expect(handedOff[0].generation).toBe(handedOff[0].active);
    const queue = projectScanQueue(root, new Date('2026-07-29T13:01:00.000Z'));
    expect(queue.requests.find(({ id }) => id === 'manual-duplicate')).toBeUndefined();
    expect(queue.requests.find(({ id }) => id === 'already-expired').status).toBe('expired');
    expect(queue.requests.find(({ id }) => id === 'scheduled-old').status).toBe('superseded');
    expect(queue.requests.find(({ id }) => id === 'automatic-handoff').status).toBe('succeeded');
  } finally {
    if (lease) {
      try { releaseScanLease(lease); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production retention resumes reviewed archive cleanup and reconciles interrupted queue compaction', async ({
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  const cleanupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-cleanup-acceptance-'));
  const queueRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-compaction-acceptance-'));
  let cleanupLease;
  let queueLease;
  try {
    const recovery = initializeRecoveryBackup(cleanupRoot, 'synthetic retention passphrase');
    const oldRun = await runScanPipeline({
      root: cleanupRoot,
      runId: 'reviewed-old-run',
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
    });
    expect(oldRun.outcome).toBe('complete');
    cleanupLease = acquireScanLease(cleanupRoot, currentLeaseOwner(), {
      kind: 'scan', runId: 'reviewed-cleanup', phase: 'finalise',
    });
    const plan = planRunCleanup(cleanupRoot, {
      now: new Date('2030-07-29T10:00:00.000Z'),
      keepNewest: 0,
      keepDays: 0,
      selectedRunIds: [oldRun.runId],
      recoveryDataKey: recovery.dataKey,
    });
    expect(plan.selected.map(({ runId }) => runId)).toEqual([oldRun.runId]);
    expect(() => archiveSelectedRuns(plan, cleanupLease, {
      afterSourceDelete() {
        throw new Error('fault after archived source deletion');
      },
    })).toThrow('fault after archived source deletion');
    const resumed = archiveSelectedRuns(plan, cleanupLease);
    expect(resumed.archivedRuns).toBe(1);
    expect(fs.existsSync(path.join(cleanupRoot, '.scout', 'runs', oldRun.runId))).toBe(false);
    expect(verifyReviewedRunArchive(resumed.archiveFile, recovery.dataKey).runs[0].runId)
      .toBe(oldRun.runId);

    queueLease = acquireScanLease(queueRoot, currentLeaseOwner(), {
      kind: 'scan', runId: 'queue-compaction', phase: 'queue',
    });
    enqueueScanRequest(queueRoot, {
      id: 'old-queue-evidence',
      key: 'old-queue-evidence',
      requestedAt: '2024-01-01T00:00:00.000Z',
      expiresAt: '2024-01-02T00:00:00.000Z',
      requester: 'manual',
      windowAt: null,
      purpose: 'manual-discovery',
      compatibility: QUEUE_COMPATIBILITY,
      lease: queueLease,
    });
    expect(() => compactScanQueue(queueRoot, queueLease, {
      now: new Date('2026-07-29T12:00:00.000Z'),
      afterQueueReplace() {
        throw new Error('fault after queue replacement');
      },
    })).toThrow('fault after queue replacement');
    expect(measureRunStorage(queueRoot).queue.recoveryCriticalOperations).toBe(1);
    const compacted = compactScanQueue(queueRoot, queueLease, {
      now: new Date('2026-07-29T12:00:00.000Z'),
    });
    expect(compacted).toMatchObject({ changed: false, reconciled: true });
    expect(measureRunStorage(queueRoot).queue.recoveryCriticalOperations).toBe(0);
    expect(projectScanQueue(queueRoot).requests).toEqual([]);
  } finally {
    if (cleanupLease) releaseScanLease(cleanupLease);
    if (queueLease) releaseScanLease(queueLease);
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
    fs.rmSync(queueRoot, { recursive: true, force: true });
  }
});

test('real durable interfaces survive crash, takeover, queue, provider, storage, backup and tamper faults', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  test.setTimeout(30_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-interface-acceptance-'));
  const calls = new Map();
  let now = Date.parse('2026-07-29T10:00:00.000Z');
  const leaseOptions = {
    wallNow: () => now,
    monotonicNow: () => now,
    leaseDurationMs: 1_000,
    takeoverMarginMs: 0,
  };
  const stages = acceptanceStages(calls);
  try {
    const recovery = initializeRecoveryBackup(root, 'synthetic acceptance passphrase');
    let interruptedRunId;
    await expect(runScanPipeline({
      root,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages,
      leaseOptions,
      onStageCommitted({ stageId, run }) {
        if (stageId !== 'collect') return;
        interruptedRunId = run.runId;
        now += 1_001;
        throw new PipelineInterruptedError('fault-injected worker crash');
      },
    })).rejects.toThrow(PipelineInterruptedError);
    expect(readScanLease(root)?.runId).toBe(interruptedRunId);

    let archiveFile;
    const recovered = await runScanPipeline({
      root,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages,
      leaseOptions,
      finalize: async () => ({
        schemaVersion: 1,
        result: { accepted: true },
        mutationReceipt: {
          schemaVersion: 1,
          id: 'acceptance-tracker-report',
          digest: 'd'.repeat(64),
        },
      }),
      postTerminalSuccess: async ({ lease }) => {
        const written = writeReviewedRunArchive(root, recovery.dataKey, {
          schemaVersion: 1,
          archiveId: 'e'.repeat(64),
          reviewedSelectionDigest: 'f'.repeat(64),
          runs: [{
            runId: interruptedRunId,
            files: [{ path: 'journal.jsonl', data: 'synthetic reviewed journal' }],
          }],
        }, {
          commitFence: (commit) => assertCurrentFence(lease, synchronousFenceCallback(commit)),
        });
        archiveFile = written.file;
        return { status: 'complete' };
      },
    });
    expect(recovered).toMatchObject({ runId: interruptedRunId, outcome: 'complete', failures: [] });
    expect(calls.get('collect')).toBe(1);
    expect(DURABLE_STAGES.slice(1).every((stageId) => calls.get(stageId) === 1)).toBe(true);
    expect(verifyReviewedRunArchive(archiveFile, recovery.dataKey).runs[0].runId)
      .toBe(interruptedRunId);

    const archive = JSON.parse(fs.readFileSync(archiveFile, 'utf8'));
    const changed = Buffer.from(archive.data, 'base64url');
    changed[0] ^= 1;
    archive.data = changed.toString('base64url');
    fs.writeFileSync(archiveFile, JSON.stringify(archive));
    expect(() => verifyReviewedRunArchive(archiveFile, recovery.dataKey)).toThrow(/modified|invalid/i);

    const queueLease = acquireScanLease(
      root,
      currentLeaseOwner(),
      { kind: 'scan', runId: 'acceptance-queue', phase: 'queue-drain' },
      leaseOptions,
    );
    expect(queueLease).toBeTruthy();
    enqueueScanRequest(root, {
      id: 'acceptance-request',
      key: 'acceptance-request',
      requestedAt: '2026-07-29T10:00:00.000Z',
      expiresAt: '2026-07-30T10:00:00.000Z',
      requester: 'manual',
      windowAt: null,
      purpose: 'manual-discovery',
      compatibility: QUEUE_COMPATIBILITY,
      execution: {
        schemaVersion: 1,
        provider: 'claude',
        model: null,
        mode: 'primary',
      },
      lease: queueLease,
    });
    const claimed = claimNextScanRequest(root, {
      ...QUEUE_COMPATIBILITY,
      purpose: 'manual-discovery',
    }, queueLease, new Date('2026-07-29T10:01:00.000Z'));
    completeScanRequest(root, claimed.id, 'succeeded', queueLease, claimed.claim);
    releaseScanLease(queueLease);
    expect(projectScanQueue(root).requests.map(({ id, status }) => [id, status]))
      .toEqual([['acceptance-request', 'succeeded']]);

    const providerBlocked = await runScanPipeline({
      root,
      compatibility: { ...ACCEPTANCE_COMPATIBILITY, provider: 'claude' },
      stages,
      healthPreflight: () => ({ ok: false, state: 'sign-in-required' }),
    });
    expect(providerBlocked).toMatchObject({
      outcome: 'abandoned',
      failures: [{ code: 'provider-health-blocked', reason: 'sign-in-required' }],
    });

    const pressured = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-storage-acceptance-'));
    try {
      await expect(runScanPipeline({
        root: pressured,
        compatibility: ACCEPTANCE_COMPATIBILITY,
        stages,
        storagePolicy: {
          maximumBytes: { runs: 0, artifacts: 0, queue: 0 },
          reserveBytes: 1,
        },
      })).rejects.toMatchObject({ code: 'SCOUT_STORAGE_PRESSURE' });
      expect(fs.existsSync(path.join(pressured, '.scout', 'scan-lease.json'))).toBe(false);
    } finally {
      fs.rmSync(pressured, { recursive: true, force: true });
    }
  } finally {
    const live = readScanLease(root);
    if (live) {
      try {
        const owned = acquireScanLease(
          root,
          currentLeaseOwner(),
          { kind: 'scan', runId: 'acceptance-cleanup', phase: 'cleanup' },
          { ...leaseOptions, wallNow: () => now + 2_000, monotonicNow: () => now + 2_000 },
        );
        if (owned) releaseScanLease(owned);
      } catch {
        // The temporary workspace is removed below; no durable user state exists.
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('real recovery and provider APIs reject a fault-injected private journal identity', async ({ page, request }) => {
  const workspace = process.env.SCOUT_WORKSPACE;
  expect(workspace).toBeTruthy();
  const sentinel = 'PRIVATE-FAULT-JOURNAL-IDENTITY';
  const corruptRun = path.join(workspace, '.scout', 'runs', sentinel);
  fs.mkdirSync(corruptRun, { recursive: true });
  fs.writeFileSync(path.join(corruptRun, 'journal.jsonl'), '{"not":"a valid journal"}\n');
  try {
    const [runsResponse, queueResponse, loginResponse] = await Promise.all([
      request.get('/api/scan/runs'),
      request.get('/api/scan/queue'),
      request.get('/api/provider-login/status?provider=codex'),
    ]);
    expect(runsResponse.ok()).toBe(true);
    expect(queueResponse.ok()).toBe(true);
    expect(loginResponse.ok()).toBe(true);
    const payloads = JSON.stringify([
      await runsResponse.json(),
      await queueResponse.json(),
      await loginResponse.json(),
    ]);
    expect(payloads).not.toContain(sentinel);
    expect(payloads).not.toContain(workspace);
    expect(payloads).not.toMatch(/rawRunState|rawAuthOutput|providerTranscript|authCode|prompt|utm_source/i);

    await page.goto('/');
    await expect(page.getByText(sentinel, { exact: false })).toHaveCount(0);
    const browserState = await page.evaluate(() => JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    expect(browserState).not.toContain(sentinel);
    expect(browserState).not.toContain(workspace);
  } finally {
    fs.rmSync(corruptRun, { recursive: true, force: true });
  }
});

test('real run state reaches the production API and UI through a bounded valid projection', async ({
  browserName, page, request,
}) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  const workspace = process.env.SCOUT_WORKSPACE;
  expect(workspace).toBeTruthy();
  const runId = 'acceptance-valid-public-projection';
  const runDirectory = path.join(workspace, '.scout', 'runs', runId);
  const trackerFile = path.join(workspace, 'data', 'opportunities.json');
  let trackerBefore = null;
  try {
    const result = await runScanPipeline({
      root: workspace,
      runId,
      compatibility: ACCEPTANCE_COMPATIBILITY,
      stages: acceptanceStages(),
    });
    expect(result.outcome).toBe('complete');

    const response = await request.get('/api/scan/runs');
    expect(response.ok()).toBe(true);
    const payload = await response.json();
    const projected = payload.runs.find(({ id }) => id === 'acceptan…');
    expect(projected).toMatchObject({
      state: 'complete',
      label: 'Scan complete',
      completedStages: DURABLE_STAGES,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /leaseId|generation|processStart|workingDirectory|rawRunState|prompt|providerTranscript/i,
    );

    trackerBefore = fs.readFileSync(trackerFile);
    fs.writeFileSync(trackerFile, '{"updated":"2026-07-30","opportunities":[]}\n');
    await page.goto('/');
    const audit = page.locator('.scan-run-audit');
    await expect(audit).toContainText('Scan complete');
    await expect(page.getByText(/leaseId|processStart|rawRunState/i)).toHaveCount(0);
  } finally {
    if (trackerBefore) fs.writeFileSync(trackerFile, trackerBefore);
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test('every durable pipeline and recovery state remains reviewable and privacy-safe', async ({ page }) => {
  test.setTimeout(60_000);
  const state = {
    runs: { state: 'waiting', runs: [] },
    queue: { state: 'waiting', requests: [] },
  };
  await installRecoverableRoutes(page, state);
  await page.goto('/');

  const phases = [
    ['queued', 'Queued for a fenced worker'],
    ['collecting', 'Collecting source records'],
    ['normalising', 'Normalising records'],
    ['deduplicating', 'Deduplicating vacancies'],
    ['filtering', 'Applying confirmed rules'],
    ['ranking', 'Ranking eligible vacancies'],
    ['selecting', 'Selecting the assessment set'],
    ['assessing', 'Assessing jobs in bounded batches'],
    ['repairing', 'Repairing affected jobs'],
    ['recovered', 'Recovered compatible work'],
    ['partial', 'Completed with partial evidence'],
    ['abandoned', 'Abandoned safely'],
    ['failed', 'Failed without mutation'],
    ['complete', 'Completed and backed up'],
  ];
  for (const [runState, label] of phases) {
    state.runs = {
      state: runState,
      runs: [publicRun(runState, label, {
        recoveryCount: runState === 'recovered' ? 1 : 0,
        assessment: ['assessing', 'repairing'].includes(runState)
          ? {
            currentBatch: 2,
            totalBatches: 4,
            totalBatchesExact: true,
            completedBatches: 1,
            completedJobs: 10,
            failedJobs: runState === 'repairing' ? 1 : 0,
          }
          : null,
        terminalReason: ['partial', 'abandoned', 'failed'].includes(runState)
          ? `${runState}-bounded-reason`
          : null,
      })],
    };
    await page.reload();
    const audit = page.locator('.scan-run-audit');
    await expect(audit.locator('.chip')).toHaveText(runState);
    await expect(audit).toContainText(label);
    if (runState === 'recovered') await expect(audit).toContainText('1 recovery');
    if (['assessing', 'repairing'].includes(runState)) {
      await expect(audit).toContainText('batch 2 of 4');
    }
    for (const sentinel of PRIVATE_SENTINELS) {
      await expect(page.getByText(sentinel, { exact: false })).toHaveCount(0);
    }
  }
});

test('overlap queue expiry, deduplication and automatic handoff stay coherent', async ({ page }) => {
  const state = {
    runs: { state: 'waiting', runs: [] },
    queue: {
      state: 'queued',
      requests: [{
        id: 'request-synthetic…',
        status: 'queued',
        requester: 'manual',
        purpose: 'job-discovery',
        requestedAt: '2026-07-29T10:00:00.000Z',
        expiresAt: '2026-07-29T22:00:00.000Z',
      }],
    },
  };
  await installRecoverableRoutes(page, state);
  await page.goto('/');
  await expect(page.locator('#scan-status')).toHaveText('1 queued request');
  await expect(page.locator('.scan-run-audit')).toContainText('1 queued request');

  // A duplicate request is represented by durable audit evidence, not a
  // second public queue entry.
  state.queue = {
    ...state.queue,
    deduplicatedCount: 1,
    requests: [{ ...state.queue.requests[0] }],
  };
  await page.reload();
  await expect(page.locator('#scan-status')).toHaveText('1 queued request');

  // Expiry removes the request from live work.
  state.queue = {
    state: 'waiting',
    requests: [{ ...state.queue.requests[0], status: 'expired' }],
  };
  await page.reload();
  await expect(page.locator('#scan-status')).toHaveText('Waiting to scan');

  // Automatic handoff exposes the successor's newer fence only through its
  // bounded public state.
  state.runs = {
    state: 'collecting',
    runs: [publicRun('collecting', 'Collecting handed-off work', {
      recoveryCount: 1,
    })],
  };
  state.queue = {
    state: 'claimed',
    requests: [{
      id: 'request-synthetic…',
      status: 'claimed',
      requester: 'manual',
      purpose: 'job-discovery',
    }],
  };
  await page.reload();
  await expect(page.locator('#scan-status')).toContainText('Collecting handed-off work');
  await expect(page.locator('.scan-run-audit')).toContainText('1 recovery');
  await expect(page.getByText(/generation|lease|4242|PRIVATE-HOST/i)).toHaveCount(0);
});

test('issues #72–#76 compose through production browser routes in one accessible session', async ({
  page, request,
}) => {
  const realDeepLinkResponse = await request.get('/api/device/codex-deep-link');
  expect(realDeepLinkResponse.ok()).toBe(true);
  const realDeepLink = await realDeepLinkResponse.json();
  expect(Object.keys(realDeepLink).sort()).toEqual([
    'canAttempt', 'checkedAt', 'platform', 'reasonCode', 'state',
  ]);
  expect(realDeepLink.state).toMatch(/^(supported|unavailable|failed|remote)$/);
  expect(typeof realDeepLink.canAttempt).toBe('boolean');
  expect(typeof realDeepLink.checkedAt).toBe('string');
  expect(typeof realDeepLink.platform).toBe('string');
  expect(realDeepLink.reasonCode === null || typeof realDeepLink.reasonCode === 'string')
    .toBe(true);
  expect(JSON.stringify(realDeepLink)).not.toMatch(
    /registry|executable|workingDirectory|account|token|raw/i,
  );

  const state = {
    runs: {
      state: 'repairing',
      runs: [publicRun('repairing', 'Repairing affected jobs', {
        recoveryCount: 1,
        assessment: {
          currentBatch: 2,
          totalBatches: 3,
          totalBatchesExact: true,
          completedBatches: 1,
          completedJobs: 10,
          failedJobs: 1,
        },
      })],
    },
    queue: { state: 'waiting', requests: [] },
  };
  await installRecoverableRoutes(page, state);
  await page.route('**/api/usage', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      claude: { unknown: true },
      codex: {
        windows: [{
          usedPercent: 42,
          windowMinutes: 10_080,
          label: 'weekly',
          resetsInSeconds: 3_600,
          resetsAt: '2026-07-29T11:00:00.000Z',
        }],
        approximate: true,
      },
    }),
  }));
  await page.route('**/api/engines', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      engines: {
        codex: {
          usage: { unknown: true },
          models: [{
            id: 'gpt-synthetic',
            label: 'Synthetic Codex',
            tradeoff: 'Synthetic acceptance model.',
            source: 'refreshed',
            available: true,
            selected: true,
          }],
          defaultModel: 'gpt-synthetic',
          effectiveModel: {
            id: 'gpt-synthetic',
            label: 'Synthetic Codex',
            source: 'refreshed',
            available: true,
            known: true,
            state: 'provider-default',
          },
          catalogue: {
            state: 'refreshed',
            reasonCode: null,
            checkedAt: '2026-07-29T10:00:00.000Z',
          },
        },
        claude: {
          usage: { unknown: true },
          models: [],
          defaultModel: null,
          effectiveModel: {
            id: null,
            label: 'Provider default (model unknown)',
            source: null,
            available: 'unknown',
            known: false,
            state: 'unknown',
          },
          catalogue: {
            state: 'fallback',
            reasonCode: 'enumeration-unsupported',
            checkedAt: '2026-07-29T10:00:00.000Z',
          },
        },
      },
      checkedAt: '2026-07-29T10:00:00.000Z',
    }),
  }));
  await page.route('**/api/chat?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      chat: {
        engine: 'codex',
        model: 'gpt-synthetic',
        cliSessionId: '019f-synthetic-acceptance-task',
        messages: [],
        filesTouched: [],
      },
      prefills: { ask: 'Synthetic acceptance prompt.' },
      purpose: 'job',
      busy: false,
    }),
  }));
  await page.route('**/api/device/codex-deep-link', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      state: 'supported',
      canAttempt: true,
      reasonCode: null,
      checkedAt: '2026-07-29T10:00:00.000Z',
      platform: 'darwin',
    }),
  }));
  await page.goto('/', { waitUntil: 'commit' });
  await expect.poll(() => page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(true);
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'acceptance-scout';
    probe.innerHTML = window.ScoutCharacter.scoutMarkup('idle');
    document.body.append(probe);
  });
  await expect(page.locator('.acceptance-scout .scout-character'))
    .toHaveAttribute('aria-label', /Scout/i);
  await expect(page.locator('#scan-status')).toContainText('Repairing affected jobs');

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'AI providers' }).click();
  await expect(dialog.getByLabel('Codex model')).toBeVisible();
  await expect(dialog.getByLabel('Claude model')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sign in to Claude with Scout' })).toBeVisible();
  await expect(dialog).toContainText('claude auth login');
  await dialog.getByRole('button', { name: 'Close settings' }).click();

  await page.evaluate(() => window.Scout.openChat('synthetic-opportunity', 'ask'));
  await expect(page.locator('.model-chip')).toHaveText('gpt-synthetic');
  await expect(page.locator('#usage-meters')).toContainText('42% weekly allowance used');
  await expect(page.locator('[data-codex-task-id]'))
    .toHaveText('019f-synthetic-acceptance-task');
  await expect(page.locator('[data-action="open-codex-task"]')).toBeEnabled();

  const persisted = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  for (const sentinel of PRIVATE_SENTINELS) {
    expect(JSON.stringify(persisted)).not.toContain(sentinel);
  }
});
