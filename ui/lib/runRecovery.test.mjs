import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  RecoveryCompatibilityDecision,
  compatibilityFingerprint,
  recoverRun,
  selectRecoverableRun,
} from './runRecovery.mjs';
import {
  ArtifactIntegrityError,
  commitRunArtifact,
  ManifestAgreementError,
  projectRunManifest,
  validateManifestAgreement,
} from './runArtifacts.mjs';
import {
  appendRunEvent,
  openRunJournal,
  replayRunJournal,
} from './runJournal.mjs';
import {
  acquireScanLease,
  currentLeaseOwner,
  releaseScanLease,
} from './scanLease.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-run-recovery-'));
  roots.push(root);
  return root;
}

const digest = (character) => character.repeat(64);

function compatibility(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: 'primary',
    purpose: 'scheduled-discovery',
    profileVersion: 'profile-v3',
    sourceConfigFingerprint: digest('a'),
    journalSchemaVersion: 1,
    artifactSchemaVersion: 1,
    pipelineVersion: 'pipeline-v2',
    rankingVersion: 'ranking-v4',
    promptVersion: 'prompt-v5',
    assessmentSchemaVersion: 2,
    provider: 'codex',
    model: 'gpt-5',
    mutationSchemaVersion: 1,
    targetRevision: 'tracker-rev-7',
    ...overrides,
  };
}

function candidate(runId, updatedAt, overrides = {}) {
  return {
    runId,
    updatedAt,
    outcome: 'in-progress',
    compatibility: compatibility(),
    completedWork: [
      { sequence: 2, stageId: 'collect', artifact: { id: `${runId}-collect`, schemaVersion: 1, digest: digest('b') } },
      { sequence: 3, stageId: 'rank', artifact: { id: `${runId}-rank`, schemaVersion: 1, digest: digest('c') } },
    ],
    ...overrides,
  };
}

function operation(runId, overrides = {}) {
  return {
    kind: 'scan',
    runId,
    provider: 'codex',
    model: 'gpt-5',
    mode: 'primary',
    phase: 'recover',
    ...overrides,
  };
}

function appendStarted(run, lease, contract = compatibility()) {
  return appendRunEvent(run, {
    type: 'run.started',
    stageId: 'initialise',
    idempotencyKey: 'run-started-v1',
    payload: { schemaVersion: 1, compatibility: contract },
  }, lease);
}

const PIPELINE_STAGES = [
  'collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select', 'assess', 'tracker', 'report',
];

function appendStage(run, lease, stageId, stableIds = [`${stageId}-vacancy`]) {
  const identity = `${stageId}-g${lease.generation}`;
  const artifact = commitRunArtifact(
    run,
    { id: `${identity}-artifact`, schemaVersion: 1 },
    { schemaVersion: 1, stableIds },
    lease,
  );
  appendRunEvent(run, {
    type: 'stage.completed',
    stageId,
    idempotencyKey: `${identity}-completed`,
    payload: {
      schemaVersion: 1,
      reference: { kind: 'stage', id: stageId },
      count: stableIds.length,
      artifact,
    },
  }, lease);
  return artifact;
}

function appendThrough(run, lease, finalStage) {
  const finalIndex = PIPELINE_STAGES.indexOf(finalStage);
  assert.notEqual(finalIndex, -1);
  for (const stageId of PIPELINE_STAGES.slice(0, finalIndex + 1)) appendStage(run, lease, stageId);
}

function recoveryCandidate(run, manifest = projectRunManifest(run.events)) {
  return {
    runId: run.runId,
    updatedAt: run.events.at(-1).recordedAt,
    outcome: manifest.outcome,
    compatibility: manifest.compatibility,
    completedWork: manifest.completedWork,
  };
}

function substitutionRequest(contract, from) {
  return {
    ...contract,
    providerSubstitution: {
      allowed: true,
      fromProvider: from.provider,
      fromModel: from.model,
      toProvider: contract.provider,
      toModel: contract.model,
    },
  };
}

test('compatibility fingerprints are canonical and reject unreviewed or raw fields', () => {
  const left = compatibility();
  const right = Object.fromEntries(Object.entries(left).reverse());

  assert.match(compatibilityFingerprint(left), /^[a-f0-9]{64}$/);
  assert.equal(compatibilityFingerprint(left), compatibilityFingerprint(right));
  assert.notEqual(compatibilityFingerprint(left), compatibilityFingerprint({ ...left, pipelineVersion: 'pipeline-v3' }));
  assert.throws(() => compatibilityFingerprint({ ...left, prompt: 'raw private prompt' }), /compatibility schema/i);
});

test('selects the newest recoverable run and records why newer incomplete runs were skipped', () => {
  const candidates = [
    candidate('run-old', '2026-07-27T08:00:00.000Z'),
    candidate('run-selected', '2026-07-27T09:00:00.000Z'),
    candidate('run-newest', '2026-07-27T10:00:00.000Z', {
      compatibility: compatibility({ profileVersion: 'profile-v2' }),
    }),
  ];

  const result = selectRecoverableRun(candidates, compatibility());

  assert.equal(result.candidate.runId, 'run-selected');
  assert.deepEqual(result.skipped, [{
    runId: 'run-newest',
    outcome: 'partial',
    reasons: ['profile-version-mismatch'],
  }]);
  assert.equal(result.decision instanceof RecoveryCompatibilityDecision, true);
  assert.equal(result.decision.recoverable, true);
});

test('reuses collection and ranking across an explicit provider change but never reuses assessment', () => {
  const prior = candidate('run-provider-change', '2026-07-27T10:00:00.000Z', {
    completedWork: [
      { sequence: 2, stageId: 'collect', artifact: { id: 'collect-artifact', schemaVersion: 1, digest: digest('b') } },
      { sequence: 3, stageId: 'rank', artifact: { id: 'rank-artifact', schemaVersion: 1, digest: digest('c') } },
      { sequence: 4, stageId: 'assess', artifact: { id: 'assess-artifact', schemaVersion: 1, digest: digest('d') } },
      { sequence: 5, stageId: 'tracker', artifact: { id: 'tracker-artifact', schemaVersion: 1, digest: digest('e') } },
    ],
  });
  const request = compatibility({ provider: 'claude', model: 'sonnet-4' });
  request.providerSubstitution = {
    allowed: true,
    fromProvider: 'codex',
    fromModel: 'gpt-5',
    toProvider: 'claude',
    toModel: 'sonnet-4',
  };

  const decision = new RecoveryCompatibilityDecision(prior, request);

  assert.equal(decision.recoverable, true);
  assert.deepEqual(
    decision.stages.map(({ stageId, action, reason }) => ({ stageId, action, reason })),
    [
      { stageId: 'collect', action: 'reuse', reason: 'compatible' },
      { stageId: 'rank', action: 'reuse', reason: 'compatible' },
      { stageId: 'assess', action: 'restart', reason: 'provider-substituted' },
      { stageId: 'tracker', action: 'restart', reason: 'upstream-stage-restarted' },
    ],
  );
  assert.deepEqual(decision.providerSubstitution, request.providerSubstitution);
});

test('requires explicit provider substitution and restarts only stages with changed version inputs', () => {
  const prior = candidate('run-provider-blocked', '2026-07-27T10:00:00.000Z', {
    completedWork: [
      { sequence: 2, stageId: 'collect', artifact: { id: 'collect-artifact', schemaVersion: 1, digest: digest('b') } },
      { sequence: 3, stageId: 'rank', artifact: { id: 'rank-artifact', schemaVersion: 1, digest: digest('c') } },
      { sequence: 4, stageId: 'tracker', artifact: { id: 'tracker-artifact', schemaVersion: 1, digest: digest('d') } },
    ],
  });

  const blocked = new RecoveryCompatibilityDecision(
    prior,
    compatibility({ provider: 'claude', model: 'sonnet-4' }),
  );
  assert.equal(blocked.recoverable, false);
  assert.deepEqual(blocked.reasons, ['explicit-provider-substitution-required']);

  const changed = new RecoveryCompatibilityDecision(
    prior,
    compatibility({ rankingVersion: 'ranking-v5', targetRevision: 'tracker-rev-8' }),
  );
  assert.deepEqual(
    changed.stages.map(({ stageId, action, reason }) => ({ stageId, action, reason })),
    [
      { stageId: 'collect', action: 'reuse', reason: 'compatible' },
      { stageId: 'rank', action: 'restart', reason: 'ranking-version-mismatch' },
      { stageId: 'tracker', action: 'restart', reason: 'target-revision-mismatch' },
    ],
  );
});

test('keeps partial and abandoned candidates immutable while selecting an older compatible run', () => {
  const partial = candidate('run-partial', '2026-07-27T11:00:00.000Z', { outcome: 'partial' });
  const abandoned = candidate('run-abandoned', '2026-07-27T10:30:00.000Z', { outcome: 'abandoned' });
  const partialBefore = structuredClone(partial);
  const abandonedBefore = structuredClone(abandoned);

  const result = selectRecoverableRun([
    candidate('run-compatible', '2026-07-27T10:00:00.000Z'),
    abandoned,
    partial,
  ], compatibility());

  assert.equal(result.candidate.runId, 'run-compatible');
  assert.deepEqual(result.skipped, [
    { runId: 'run-partial', outcome: 'partial', reasons: ['terminal-partial'] },
    { runId: 'run-abandoned', outcome: 'abandoned', reasons: ['terminal-abandoned'] },
  ]);
  assert.deepEqual(partial, partialBefore);
  assert.deepEqual(abandoned, abandonedBefore);
});

test('validates the journal before rebuilding the manifest and journals explicit substitution provenance', () => {
  const root = temp();
  const runId = 'run-rebuild';
  let lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, { phase: 'collect' }));
  const run = openRunJournal(root, runId);
  appendStarted(run, lease);
  appendThrough(run, lease, 'assess');
  const initial = validateManifestAgreement(run, lease).manifest;
  fs.rmSync(path.join(run.directory, 'manifest.json'));
  releaseScanLease(lease);

  const request = substitutionRequest(
    compatibility({ provider: 'claude', model: 'sonnet-4' }),
    compatibility(),
  );
  const selected = selectRecoverableRun([recoveryCandidate(run, initial)], request);
  lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, {
    provider: 'claude',
    model: 'sonnet-4',
    phase: 'provider-substitution',
  }));
  const recovered = recoverRun(root, runId, lease, selected.decision);
  const events = replayRunJournal(run.file);

  assert.equal(recovered.manifest.runId, runId);
  assert.equal(recovered.manifest.outcome, 'in-progress');
  assert.deepEqual(
    recovered.reusableStages.map((stage) => stage.stageId),
    ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'],
  );
  assert.deepEqual(recovered.restartStages.map((stage) => stage.stageId), ['assess']);
  assert.equal(events.filter((event) => event.type === 'recovery.provider-substituted').length, 1);
  assert.deepEqual(
    events.find((event) => event.type === 'recovery.provider-substituted').payload,
    {
      schemaVersion: 1,
      previousProvider: 'codex',
      previousModel: 'gpt-5',
      nextProvider: 'claude',
      nextModel: 'sonnet-4',
    },
  );
  assert.deepEqual(projectRunManifest(events), recovered.manifest);
});

test('recoverRun preserves the exact selected request and invalidates every affected downstream completion', () => {
  const root = temp();
  const runId = 'run-exact-request';
  let lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, { phase: 'collect' }));
  const run = openRunJournal(root, runId);
  appendStarted(run, lease);
  appendThrough(run, lease, 'report');
  const initial = validateManifestAgreement(run, lease).manifest;
  releaseScanLease(lease);

  const request = compatibility({
    rankingVersion: 'ranking-v5',
    promptVersion: 'prompt-v6',
    assessmentSchemaVersion: 3,
    mutationSchemaVersion: 2,
    targetRevision: 'tracker-rev-8',
  });
  const selected = selectRecoverableRun([recoveryCandidate(run, initial)], request);
  assert.equal(selected.decision.stages.find((stage) => stage.stageId === 'rank').action, 'restart');

  lease = acquireScanLease(root, currentLeaseOwner(), operation(runId));
  const recovered = recoverRun(root, runId, lease, selected.decision);

  assert.deepEqual(recovered.manifest.compatibility, request);
  assert.deepEqual(recovered.manifest.completedWork.map((stage) => stage.stageId), ['collect']);
  assert.deepEqual(
    recovered.restartStages.map((stage) => stage.stageId),
    ['normalise', 'deduplicate', 'filter', 'rank', 'select', 'assess', 'tracker', 'report'],
  );
  const recoveryStart = replayRunJournal(run.file).find((event) => event.type === 'recovery.started');
  assert.equal(recoveryStart.payload.requestFingerprint, compatibilityFingerprint(request));
  assert.deepEqual(recoveryStart.payload.compatibility, request);
});

test('restart invalidation survives provider switches and a replacement completion supersedes the old stage once', () => {
  const root = temp();
  const runId = 'run-generations';
  const codex = compatibility();
  const claude = compatibility({ provider: 'claude', model: 'sonnet-4' });
  let lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, { phase: 'collect' }));
  const run = openRunJournal(root, runId);
  appendStarted(run, lease, codex);
  appendThrough(run, lease, 'assess');
  let manifest = validateManifestAgreement(run, lease).manifest;
  releaseScanLease(lease);

  let request = substitutionRequest(claude, codex);
  let selected = selectRecoverableRun([recoveryCandidate(run, manifest)], request);
  lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, {
    provider: 'claude', model: 'sonnet-4', phase: 'provider-substitution',
  }));
  manifest = recoverRun(root, runId, lease, selected.decision).manifest;
  assert.equal(manifest.compatibility.provider, 'claude');
  assert.ok(!manifest.completedWork.some((stage) => stage.stageId === 'assess'));
  releaseScanLease(lease);

  request = substitutionRequest(codex, claude);
  selected = selectRecoverableRun([recoveryCandidate(run, manifest)], request);
  assert.equal(selected.decision.recoverable, true);
  lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, {
    provider: 'codex', model: 'gpt-5', phase: 'provider-substitution',
  }));
  manifest = recoverRun(root, runId, lease, selected.decision).manifest;
  assert.ok(!manifest.completedWork.some((stage) => stage.stageId === 'assess'));
  releaseScanLease(lease);

  request = substitutionRequest(claude, codex);
  selected = selectRecoverableRun([recoveryCandidate(run, manifest)], request);
  lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, {
    provider: 'claude', model: 'sonnet-4', phase: 'provider-substitution',
  }));
  recoverRun(root, runId, lease, selected.decision);
  appendStage(run, lease, 'assess', ['replacement-assessment']);
  manifest = validateManifestAgreement(run, lease).manifest;
  assert.equal(manifest.completedWork.filter((stage) => stage.stageId === 'assess').length, 1);
  releaseScanLease(lease);

  selected = selectRecoverableRun([recoveryCandidate(run, manifest)], claude);
  lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, {
    provider: 'claude', model: 'sonnet-4',
  }));
  const recovered = recoverRun(root, runId, lease, selected.decision);
  assert.equal(recovered.manifest.completedWork.filter((stage) => stage.stageId === 'assess').length, 1);
  assert.equal(recovered.reusableStages.filter((stage) => stage.stageId === 'assess').length, 1);
});

test('fails closed without changing a damaged run and writes a fixed external recovery failure record', () => {
  const root = temp();
  const runId = 'run-damaged';
  let lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, { phase: 'collect' }));
  const run = openRunJournal(root, runId);
  appendStarted(run, lease);
  appendStage(run, lease, 'collect');
  const decision = new RecoveryCompatibilityDecision(recoveryCandidate(run), compatibility());
  releaseScanLease(lease);

  const lines = fs.readFileSync(run.file, 'utf8').trimEnd().split(/\r?\n/);
  const damaged = JSON.parse(lines[1]);
  damaged.eventHash = digest('0');
  lines[1] = JSON.stringify(damaged);
  fs.writeFileSync(run.file, `${lines.join('\n')}\n`, 'utf8');
  const before = fs.readFileSync(run.file, 'utf8');

  lease = acquireScanLease(root, currentLeaseOwner(), operation(runId));
  assert.throws(() => recoverRun(root, runId, lease, decision), /journal.*damaged/i);
  assert.throws(() => recoverRun(root, runId, lease, decision), /journal.*damaged/i);
  assert.equal(fs.readFileSync(run.file, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(run.directory, 'manifest.json')), false);

  const failures = fs.readFileSync(path.join(root, '.scout', 'recovery-failures.jsonl'), 'utf8')
    .trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(failures.length, 1);
  assert.deepEqual(
    Object.keys(failures[0]).sort(),
    [
      'eventId', 'failureId', 'fencingGeneration', 'leaseId', 'reason',
      'recordedAt', 'requestFingerprint', 'runId', 'schemaVersion',
    ].sort(),
  );
  assert.equal(failures[0].runId, runId);
  assert.equal(failures[0].reason, 'journal-damaged');
});

test('quarantines only an incomplete final append before replay and recovery', () => {
  const root = temp();
  const runId = 'run-truncated';
  let lease = acquireScanLease(root, currentLeaseOwner(), operation(runId, { phase: 'collect' }));
  const run = openRunJournal(root, runId);
  appendStarted(run, lease);
  appendStage(run, lease, 'collect');
  const decision = new RecoveryCompatibilityDecision(recoveryCandidate(run), compatibility());
  releaseScanLease(lease);
  fs.appendFileSync(run.file, '{"schemaVersion":', 'utf8');

  lease = acquireScanLease(root, currentLeaseOwner(), operation(runId));
  const recovered = recoverRun(root, runId, lease, decision);
  const quarantines = fs.readdirSync(run.directory).filter((name) => name.startsWith('journal.truncated.'));

  assert.deepEqual(recovered.reusableStages.map((stage) => stage.stageId), ['collect']);
  assert.equal(quarantines.length, 1);
  assert.equal(fs.readFileSync(path.join(run.directory, quarantines[0]), 'utf8'), '{"schemaVersion":');
  assert.doesNotThrow(() => replayRunJournal(run.file));
});

test('manifest validation covers artifact references in recovery decisions', () => {
  const root = temp();
  const runId = 'run-recovery-artifact';
  const lease = acquireScanLease(root, currentLeaseOwner(), operation(runId));
  const run = openRunJournal(root, runId);
  appendStarted(run, lease);
  appendRunEvent(run, {
    type: 'recovery.stage-decided',
    stageId: 'collect',
    idempotencyKey: 'recovery-artifact-v1',
    payload: {
      schemaVersion: 1,
      action: 'reuse',
      reason: 'compatible',
      artifact: { id: 'missing-artifact', schemaVersion: 1, digest: digest('f') },
    },
  }, lease);

  assert.throws(() => validateManifestAgreement(run, lease), ManifestAgreementError);
});

test('durably records skipped candidates and immutable partial or abandoned outcomes idempotently', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('selection-run'));
  const candidates = [
    candidate('run-valid', '2026-07-27T09:00:00.000Z'),
    candidate('run-no-work', '2026-07-27T10:00:00.000Z', {
      compatibility: compatibility({ profileVersion: 'old-profile' }),
      completedWork: [],
    }),
    candidate('run-partial-work', '2026-07-27T11:00:00.000Z', {
      compatibility: compatibility({ pipelineVersion: 'old-pipeline' }),
    }),
  ];

  const first = selectRecoverableRun(candidates, compatibility(), { root, lease });
  const second = selectRecoverableRun(candidates, compatibility(), { root, lease });
  const records = fs.readFileSync(path.join(root, '.scout', 'recovery-selections.jsonl'), 'utf8')
    .trimEnd().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(first.selectionId, second.selectionId);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].skipped.map(({ runId, outcome, reasons }) => ({ runId, outcome, reasons })), [
    { runId: 'run-partial-work', outcome: 'partial', reasons: ['pipeline-version-mismatch'] },
    { runId: 'run-no-work', outcome: 'abandoned', reasons: ['profile-version-mismatch'] },
  ]);
});

test('skips malformed and unsupported candidates durably instead of aborting older compatible selection', () => {
  const root = temp();
  const lease = acquireScanLease(root, currentLeaseOwner(), operation('selection-invalid'));
  const candidates = [
    candidate('run-valid', '2026-07-27T09:00:00.000Z'),
    { runId: 'run-legacy', updatedAt: '2026-07-27T11:00:00.000Z', outcome: 'in-progress', completedWork: [] },
    candidate('run-future-journal', '2026-07-27T10:30:00.000Z', {
      compatibility: compatibility({ journalSchemaVersion: 2 }),
    }),
    candidate('run-future-artifact', '2026-07-27T10:00:00.000Z', {
      compatibility: compatibility({ artifactSchemaVersion: 2 }),
    }),
  ];

  const result = selectRecoverableRun(candidates, compatibility(), { root, lease });

  assert.equal(result.candidate.runId, 'run-valid');
  assert.deepEqual(result.skipped.map(({ runId, reasons }) => ({ runId, reasons })), [
    { runId: 'run-legacy', reasons: ['compatibility-missing'] },
    { runId: 'run-future-journal', reasons: ['journal-schema-unsupported'] },
    { runId: 'run-future-artifact', reasons: ['artifact-schema-unsupported'] },
  ]);
});
