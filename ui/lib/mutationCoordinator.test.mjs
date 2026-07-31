import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import {
  MutationConflictError,
  applyPreparedMutation,
  loadPreparedMutation,
  prepareMutation,
  reconcileMutation,
  withMutationCoordinator,
} from './mutationCoordinator.mjs';
import { coordinateScanArtifacts } from './scanPipeline.mjs';
import {
  acquireScanLease, currentLeaseOwner, releaseScanLease,
} from './scanLease.mjs';
import { appendRunEvent, openRunJournal, replayRunJournal } from './runJournal.mjs';
import { runLogAppendRecipe, scanReportRecipe, trackerMergeRecipe } from './scanMutationProjection.mjs';
import {
  generateSearchLanePlan, loadSearchLanePlan, writeSearchLanePlan,
} from './searchLanes.mjs';
import {
  createEmployerRegistry, employerRegistryRevision, loadEmployerRegistry,
  writeEmployerRegistry,
} from './employerRegistry.mjs';

const roots = [];

function canonicalJson(value) {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mutation-coordinator-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{\n  "updated": "2026-07-28",\n  "opportunities": []\n}\n');
  fs.writeFileSync(path.join(root, 'reports', '2026-07-28.md'), '# Scout report\n\n## Headline\n\nBefore.\n');
  const lease = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'run-task-8' });
  const handle = openRunJournal(root, 'run-task-8');
  return { root, lease, handle };
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for mutation child fixture');
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function mutationInput(root) {
  const intendedTracker = '{\n  "updated": "2026-07-28",\n  "opportunities": [{"id":"valid-sibling","company":"Valid Co","role":"Engineer"}]\n}\n';
  return {
    target: {
      id: 'scan-tracker-report',
      schemaVersion: 1,
      files: [
        { kind: 'tracker', key: 'tracker' },
        { kind: 'report', key: 'report:2026-07-28' },
      ],
    },
    content: {
      tracker: trackerMergeRecipe(
        fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8'),
        intendedTracker,
      ),
      'report:2026-07-28': scanReportRecipe({
        date: '2026-07-28',
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
    },
  };
}

test('a matching post-replacement identity reconciles without replay and appends one receipt', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  content.tracker.rawProviderResponse = 'Unlabelled complete candidate history from provider.';
  const plan = prepareMutation({ handle, lease }, target, content);
  let replacements = 0;

  assert.throws(
    () => applyPreparedMutation(plan, lease, {
      afterReplacement() {
        replacements += 1;
        if (replacements === 2) throw new Error('synthetic crash before receipt');
      },
    }),
    /synthetic crash before receipt/,
  );
  assert.equal(reconcileMutation(plan).status, 'applied-unreceipted');

  const receipt = applyPreparedMutation(plan, lease, {
    beforeReplacement() {
      assert.fail('matching content must be acknowledged without replay');
    },
  });
  assert.equal(receipt.id, plan.mutationId);
  assert.equal(reconcileMutation(plan).status, 'receipted');
  assert.deepEqual(
    replayRunJournal(handle.file).map((event) => event.type),
    ['mutation.prepared', 'mutation.receipted'],
  );
});

test('crashes before replacement and after one replacement resume only pending targets', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const plan = prepareMutation({ handle, lease }, target, content);

  assert.throws(
    () => applyPreparedMutation(plan, lease, {
      beforeReplacement() {
        throw new Error('synthetic crash before replacement');
      },
    }),
    /synthetic crash before replacement/,
  );
  assert.equal(reconcileMutation(plan).status, 'prepared');

  let replacements = 0;
  assert.throws(
    () => applyPreparedMutation(plan, lease, {
      afterReplacement() {
        replacements += 1;
        throw new Error('synthetic crash after first replacement');
      },
    }),
    /synthetic crash after first replacement/,
  );
  assert.equal(replacements, 1);
  assert.equal(reconcileMutation(plan).status, 'partially-applied');

  const replaced = [];
  applyPreparedMutation(plan, lease, {
    beforeReplacement(file) {
      replaced.push(file.key);
    },
  });
  assert.deepEqual(replaced, ['report:2026-07-28']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8')).opportunities[0].id, 'valid-sibling');
});

test('conflicting and unverifiable target states fail closed', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const plan = prepareMutation({ handle, lease }, target, content);
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"opportunities":[{"id":"operator-edit"}]}\n');
  assert.throws(() => reconcileMutation(plan), MutationConflictError);
  assert.throws(() => applyPreparedMutation(plan, lease), MutationConflictError);

  const report = path.join(root, 'reports', '2026-07-28.md');
  fs.writeFileSync(report, `${fs.readFileSync(report, 'utf8')}\n<!-- scout-mutation:not-json -->\n`);
  assert.throws(() => reconcileMutation(plan), MutationConflictError);
});

test('a stale fencing generation cannot mutate or append a receipt', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const plan = prepareMutation({ handle, lease }, target, content);
  releaseScanLease(lease);
  const successor = acquireScanLease(root, currentLeaseOwner(), { kind: 'scan', runId: 'successor-run' });

  assert.throws(() => applyPreparedMutation(plan, lease), /lease/i);
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.receipted').length, 0);
  releaseScanLease(successor);
});

test('the shared OS-level coordinator excludes another mutation boundary', () => {
  const { root, lease } = fixture();
  assert.throws(
    () => withMutationCoordinator(root, lease, () => (
      withMutationCoordinator(root, lease, () => assert.fail('nested mutation must not run'))
    )),
    /another workspace mutation is in progress/,
  );
  assert.equal(fs.existsSync(path.join(root, '.scout', 'mutation.guard')), false);
});

test('the shared coordinator remains held until the durable receipt is appended', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const plan = prepareMutation({ handle, lease }, target, content);

  applyPreparedMutation(plan, lease, {
    beforeReceipt() {
      assert.throws(
        () => withMutationCoordinator(root, lease, () => assert.fail('receipt gap admitted another mutation')),
        /another workspace mutation is in progress/,
      );
    },
  });
  assert.equal(reconcileMutation(plan).status, 'receipted');
});

test('parent death during merge, add, commit and push keeps every live child fenced from a successor', async () => {
  const fixtureFile = fileURLToPath(new URL('./fixtures/mutation-child-owner.mjs', import.meta.url));
  for (const phase of ['merge', 'add', 'commit', 'push']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `scout-orphan-${phase}-`));
    roots.push(root);
    const marker = path.join(root, 'child.json');
    const owner = spawn(process.execPath, [fixtureFile, root, phase, marker], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let ownerStderr = '';
    owner.stderr.on('data', (chunk) => { ownerStderr = (ownerStderr + chunk).slice(-4_096); });
    let childPid;
    let successor;
    try {
      await Promise.race([
        waitUntil(() => fs.existsSync(marker), 15_000),
        new Promise((resolve, reject) => owner.once('exit', (code, signal) => reject(new Error(
          `mutation child owner exited before readiness (${code ?? signal}): ${ownerStderr.trim() || 'no stderr'}`,
        )))),
      ]);
      const fixtureState = JSON.parse(fs.readFileSync(marker, 'utf8'));
      ({ childPid } = fixtureState);
      const guard = JSON.parse(fs.readFileSync(
        path.join(root, '.scout', 'mutation.guard', 'owner.json'),
        'utf8',
      ));
      assert.deepEqual(
        Object.keys(guard.owner).sort(),
        ['host', 'pid', 'processStart'],
      );
      assert.equal(guard.owner.pid, fixtureState.ownerPid);
      assert.equal(guard.childOperation.operationId, fixtureState.operationId);
      assert.equal(guard.childOperation.phase, phase);
      assert.equal(guard.childOperation.owner.pid, childPid);
      assert.match(guard.childOperation.owner.processStart, /^[A-Za-z0-9][A-Za-z0-9._:-]+$/);
      assert.equal(processExists(childPid), true, `${phase} child must be live before parent death`);
      owner.kill('SIGKILL');
      await waitUntil(() => owner.exitCode !== null || owner.signalCode !== null || !processExists(owner.pid));
      successor = acquireScanLease(
        root,
        currentLeaseOwner(),
        { kind: 'backup', runId: `successor-${phase}`, phase: 'checkpoint' },
        {
          leaseDurationMs: 5_000,
          takeoverMarginMs: 0,
          now: Date.parse(fixtureState.leaseExpiresAt) + 1,
        },
      );
      assert.ok(successor, `${phase} successor lease was not acquired`);
      assert.throws(
        () => withMutationCoordinator(root, successor, () => assert.fail(`${phase} successor overlapped child`)),
        /another workspace mutation is in progress/i,
      );

      if (process.platform === 'win32') {
        spawn('taskkill.exe', ['/pid', String(childPid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        try { process.kill(-childPid, 'SIGKILL'); } catch { process.kill(childPid, 'SIGKILL'); }
      }
      await waitUntil(() => !processExists(childPid));
      assert.equal(withMutationCoordinator(root, successor, () => `${phase}-recovered`), `${phase}-recovered`);
      assert.equal(
        fs.readdirSync(path.join(root, '.scout'))
          .some((name) => name.startsWith('mutation.guard.quarantine.')),
        true,
      );
    } finally {
      if (processExists(owner.pid)) owner.kill('SIGKILL');
      if (childPid && processExists(childPid)) {
        try {
          if (process.platform === 'win32') process.kill(childPid, 'SIGKILL');
          else process.kill(-childPid, 'SIGKILL');
        } catch {}
      }
      if (successor) releaseScanLease(successor);
    }
  }
});

test('the canonical run, target revision and intended content produce one stable prepared plan', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const first = prepareMutation({ handle, lease }, target, content);
  const second = prepareMutation({ handle, lease }, target, structuredClone(content));

  assert.equal(second.mutationId, first.mutationId);
  assert.equal(second.key, first.key);
  assert.equal(second.intendedDigest, first.intendedDigest);
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.prepared').length, 1);
});

test('the journal rejects a self-consistent prepared artifact forged after preparation', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const plan = prepareMutation({ handle, lease }, target, content);
  const artifactFile = path.join(handle.directory, 'mutations', `${plan.mutationId}.json`);
  const envelope = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  envelope.value.target.id = 'forged-target';
  envelope.digest = digest(envelope.value);
  fs.writeFileSync(artifactFile, `${canonicalJson(envelope)}\n`);

  assert.throws(
    () => loadPreparedMutation(handle, plan.mutationId),
    /journal.*digest|prepared.*journal/i,
  );
});

test('coordinator fails closed when one mutation identity has duplicate receipts', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const plan = prepareMutation({ handle, lease }, target, content);
  applyPreparedMutation(plan, lease);
  appendRunEvent(handle, {
    type: 'mutation.receipted',
    stageId: 'finalise',
    idempotencyKey: 'forged-duplicate-receipt',
    payload: {
      schemaVersion: 1,
      reference: { kind: 'mutation', id: plan.mutationId },
      digest: plan.receiptDigest,
    },
  }, lease);

  assert.throws(() => reconcileMutation(plan), /duplicate mutation receipt/i);
});

test('prepared mutation artifacts reject opaque target bodies', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const unsafe = structuredClone(content);
  unsafe.tracker = JSON.stringify({
    opportunities: [],
    rawProviderResponse: 'Bearer secret-token-value',
  });

  assert.throws(
    () => prepareMutation({ handle, lease }, target, unsafe),
    /mutation recipe|recipe is missing|plain object/i,
  );
  assert.equal(replayRunJournal(handle.file).length, 0);
  assert.equal(fs.existsSync(path.join(handle.directory, 'mutations')), false);
});

test('prepared artifacts use resolver-backed opaque keys and one canonical content copy', () => {
  const { root, lease, handle } = fixture();
  const { target, content } = mutationInput(root);
  const plan = prepareMutation({ handle, lease }, target, content);
  const artifact = fs.readFileSync(
    path.join(handle.directory, 'mutations', `${plan.mutationId}.json`),
    'utf8',
  );

  assert.doesNotMatch(artifact, /data[\\/]opportunities|reports[\\/]2026|intendedContent|preparedContent|"path"/);
  assert.doesNotMatch(artifact, /Unlabelled complete candidate history/);
  assert.doesNotMatch(artifact, /"content":/);
  assert.equal((artifact.match(/"recipe":/g) || []).length, 2);
  assert.deepEqual(plan.files.map((file) => file.key), ['tracker', 'report:2026-07-28']);
});

test('resolver rejects a tracker file reached through an escaping junction', { skip: process.platform !== 'win32' }, () => {
  const { root, lease, handle } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mutation-outside-file-'));
  roots.push(outside);
  const outsideTracker = path.join(outside, 'opportunities.json');
  fs.writeFileSync(outsideTracker, '{"updated":"2026-07-28","opportunities":[]}\n');
  fs.rmSync(path.join(root, 'data'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'data'), 'junction');

  assert.throws(
    () => prepareMutation({ handle, lease }, {
      id: 'scan-tracker',
      schemaVersion: 1,
      files: [{ kind: 'tracker', key: 'tracker' }],
    }, {
      tracker: {
        schemaVersion: 1,
        operation: 'tracker-merge',
        updated: '2026-07-28',
        upserts: [],
      },
    }),
    /symlink|junction|outside its workspace/i,
  );
});

test('replacement rechecks containment after a directory is swapped for a junction', { skip: process.platform !== 'win32' }, () => {
  const { root, lease, handle } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-mutation-outside-junction-'));
  roots.push(outside);
  const outsideReport = path.join(outside, '2026-07-28.md');
  fs.writeFileSync(outsideReport, 'outside sentinel\n');
  const plan = prepareMutation({ handle, lease }, {
    id: 'scan-report',
    schemaVersion: 1,
    files: [{ kind: 'report', key: 'report:2026-07-28' }],
  }, {
    'report:2026-07-28': scanReportRecipe({
      date: '2026-07-28',
      degraded: false,
      coverage: [],
      actions: [],
      checks: [],
      keeperCount: 0,
      discarded: {},
      nearMisses: [],
      errors: [],
      runs: [],
    }),
  });

  assert.throws(
    () => applyPreparedMutation(plan, lease, {
      beforeReplacement() {
        fs.rmSync(path.join(root, 'reports'), { recursive: true });
        fs.symlinkSync(outside, path.join(root, 'reports'), 'junction');
      },
    }),
    /symlink|junction|outside its workspace/i,
  );
  assert.equal(fs.readFileSync(outsideReport, 'utf8'), 'outside sentinel\n');
  fs.rmSync(path.join(root, 'reports'));
  fs.mkdirSync(path.join(root, 'reports'));
  fs.writeFileSync(path.join(root, 'reports', '2026-07-28.md'), '# Scout report\n\n## Headline\n\nBefore.\n');
  assert.equal(reconcileMutation(plan).status, 'prepared');
});

test('partial assessment success produces one deterministic tracker/report plan without duplicate mutation', () => {
  const { root, lease, handle } = fixture();
  const candidates = [
    { candidateId: 'candidate-001', company: 'Valid Co', role: 'Engineer', url: 'https://example.test/valid', source: 'ats' },
    { candidateId: 'candidate-002', company: 'Failed Co', role: 'Engineer', url: 'https://example.test/failed', source: 'ats' },
  ];
  const input = {
    provider: 'codex',
    mode: 'primary',
    sources: { ats: { configured: true, status: 'healthy', count: 2 } },
    candidates,
    assessmentResult: {
      assessments: [{
        candidateId: 'candidate-001',
        summary: 'Synthetic fit',
        responsibilityFit: {
          rating: 'strong',
          advertEvidence: 'The advert requires engineering delivery.',
          profileEvidence: 'The profile records engineering delivery.',
          explanation: 'The evidence aligns.',
        },
        mandatoryRequirements: [],
        transferableExperience: [],
        uncertainties: [],
        strengths: [],
        concerns: [],
        recommendation: 'keep',
      }],
    },
    assessmentFailures: [{
      jobId: 'stable-job-002',
      code: 'assessment-exhausted',
      attempts: 3,
      validationFailures: ['missing-required-field'],
    }],
    policy: { actionScore: 70, checkScore: 55 },
    startedAt: '2026-07-28T09:00:00.000Z',
  };

  const first = coordinateScanArtifacts(root, input, { run: handle, lease });
  const second = coordinateScanArtifacts(root, input, { run: handle, lease });
  const tracker = JSON.parse(fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8'));
  const scanRuns = fs.readFileSync(path.join(root, 'data', 'scan-runs.jsonl'), 'utf8').trim().split(/\r?\n/);

  assert.equal(first.mutationReceipt.id, second.mutationReceipt.id);
  assert.equal(tracker.opportunities.length, 1);
  assert.equal(tracker.opportunities[0].company, 'Valid Co');
  assert.equal(scanRuns.length, 1);
  assert.deepEqual(JSON.parse(scanRuns[0]).assessment_failures, [{
    jobId: 'stable-job-002',
    code: 'assessment-exhausted',
    attempts: 3,
    validationFailures: ['missing-required-field'],
  }]);
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.prepared').length, 1);
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.receipted').length, 1);
});

test('scan finalisation commits employer health and advert discoveries in the same prepared mutation', () => {
  const { root, lease, handle } = fixture();
  const registry = createEmployerRegistry([{
    canonicalName: 'Monitored Example',
    careersUrl: 'https://careers.example.test/jobs',
    origin: {
      kind: 'manual', recordedAt: '2026-07-28T08:00:00.000Z', reference: 'settings',
    },
  }], { now: () => '2026-07-28T08:00:00.000Z' });
  writeEmployerRegistry(root, registry);
  const input = {
    provider: 'codex',
    mode: 'primary',
    sources: {
      employer_registry: {
        configured: true,
        status: 'healthy',
        count: 1,
        jobs: [],
        registrySnapshot: registry,
        registryRevision: employerRegistryRevision(registry),
        checks: [{
          employerId: registry.employers[0].id,
          adapter: 'structured-data',
          status: 'healthy',
          returned: 1,
          parsed: 1,
        }],
      },
    },
    candidates: [{
      candidateId: 'candidate-001',
      vacancyId: 'vacancy-advert-001',
      company: 'Advert Discovery Example',
      role: 'Research lead',
      url: 'https://jobs.example.test/research-lead',
      source: 'careers-structured',
    }],
    assessmentResult: { assessments: [] },
    policy: {},
    startedAt: '2026-07-28T09:00:00.000Z',
  };

  const artifacts = coordinateScanArtifacts(root, input, { run: handle, lease });
  const updated = loadEmployerRegistry(root);
  assert.match(artifacts.mutationReceipt.id, /^mutation-[a-f0-9]{40}$/);
  assert.match(artifacts.mutationReceipt.digest, /^[a-f0-9]{64}$/);
  assert.equal(updated.employers.find(
    ({ canonicalName }) => canonicalName === 'Monitored Example',
  ).history[0].runId, handle.runId);
  assert.equal(updated.employers.find(
    ({ canonicalName }) => canonicalName === 'Advert Discovery Example',
  ).origins[0].kind, 'advert-discovered');
  const prepared = replayRunJournal(handle.file).find(({ type }) => type === 'mutation.prepared');
  assert.equal(loadPreparedMutation(handle, prepared.payload.reference.id).files.some(
    ({ key }) => key === 'employers',
  ), true);
});

test('lane history is one recoverable target in the fenced final scan mutation', () => {
  const { root, lease, handle } = fixture();
  const profile = {
    id: 'profile-aaaaaaaaaaaa',
    version: 1,
    status: 'published',
    target: {
      primaryTitles: [{
        value: 'Platform engineer', strength: 'strong-preference', provenance: 'explicit',
      }],
    },
    negative: {},
    compensation: {
      currency: null, period: 'year', minimum: null,
      minimumStrength: 'neutral', unknownPolicy: 'include',
    },
    selection: { breadth: 'balanced', relevanceThreshold: 45, exploration: 0 },
  };
  const plan = generateSearchLanePlan(profile, {
    now: () => '2026-07-28T08:00:00.000Z',
  });
  const lane = plan.lanes[0];
  writeSearchLanePlan(root, plan);
  const input = {
    provider: 'codex',
    mode: 'primary',
    profileId: profile.id,
    lanes: [lane],
    sources: {
      hiring_cafe: {
        configured: true,
        status: 'healthy',
        count: 1,
        queryCounts: { [lane.query]: 1 },
        observations: [{
          observationId: 'observation-lane',
          laneIds: [lane.id],
        }],
      },
    },
    ranked: [{
      vacancyId: 'vacancy-lane',
      laneIds: [lane.id],
      dimensions: [{ name: 'novelty', evidence: [{ comparison: 'unseen' }] }],
    }],
    candidates: [],
    assessmentResult: { assessments: [] },
    policy: {},
    startedAt: '2026-07-28T09:00:00.000Z',
  };

  assert.throws(() => coordinateScanArtifacts(root, input, {
    run: handle,
    lease,
    hooks: {
      afterReplacement(target) {
        if (target.key === 'search-lanes') throw new Error('synthetic crash after lane replacement');
      },
    },
  }), /synthetic crash after lane replacement/);
  assert.equal(loadSearchLanePlan(root).lanes[0].history.length, 1);
  assert.equal(replayRunJournal(handle.file).some((event) => event.type === 'mutation.receipted'), false);

  coordinateScanArtifacts(root, input, { run: handle, lease });
  const restored = loadSearchLanePlan(root).lanes[0];
  assert.equal(restored.history.length, 1);
  assert.deepEqual(restored.history[0], {
    runId: handle.runId,
    recordedAt: handle.events.find((event) => event.type === 'run.started')?.recordedAt
      || input.startedAt,
    laneId: lane.id,
    returned: 1,
    parsed: 1,
    new: 1,
    eligible: 1,
    selected: 0,
    promising: 0,
  });
  assert.equal(replayRunJournal(handle.file).filter((event) => event.type === 'mutation.receipted').length, 1);
});

test('a later scan strips mutation markers from historical run-log records', () => {
  const { root, lease, handle } = fixture();
  const input = {
    provider: 'codex',
    mode: 'primary',
    sources: { ats: { configured: true, status: 'healthy', count: 0 } },
    candidates: [],
    assessmentResult: { assessments: [] },
    policy: {},
    startedAt: '2026-07-28T09:00:00.000Z',
  };
  coordinateScanArtifacts(root, input, { run: handle, lease });
  releaseScanLease(lease);

  const successorLease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'scan',
    runId: 'run-task-8-successor',
  });
  const successorRun = openRunJournal(root, 'run-task-8-successor');
  coordinateScanArtifacts(root, { ...input, mode: 'second-pass' }, {
    run: successorRun,
    lease: successorLease,
  });

  const records = fs.readFileSync(path.join(root, 'data', 'scan-runs.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(Object.hasOwn(records[0], '_scoutMutation'), false);
  assert.equal(Object.hasOwn(records[1], '_scoutMutation'), true);
});

test('real prepared recipe excludes unlabelled private bodies while preserving tracker semantics', () => {
  const { root, lease, handle } = fixture();
  const privateBodies = {
    cv: 'Led the Acme migration from 2020 to 2024 across three business units.',
    advert: 'About the role, you will own the platform roadmap and mentor the engineering group.',
    prompt: 'Compare every requirement against the candidate and return a strict JSON decision.',
    provider: 'The candidate demonstrates unusually strong ownership across the supplied evidence.',
    response: 'Upstream returned the complete candidate document in a successful response.',
  };
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), `${JSON.stringify({
    updated: '2026-07-01',
    opportunities: [{
      id: 'existing-user-entry',
      company: 'Existing Co',
      role: 'Engineer',
      status: 'shortlist',
      notes: privateBodies.cv,
      contacts: [{ name: 'Private Contact' }],
      log: [{ date: '2026-07-01', event: 'user note' }],
    }],
  }, null, 2)}\n`);
  const artifacts = coordinateScanArtifacts(root, {
    provider: 'codex',
    mode: 'primary',
    sources: {
      ats: {
        configured: true,
        status: 'healthy',
        count: 1,
        reason: privateBodies.response,
      },
    },
    candidates: [{
      candidateId: 'candidate-001',
      company: 'Valid Co',
      role: 'Platform Engineer',
      url: 'https://example.test/valid',
      source: 'ats',
      description: privateBodies.advert,
    }],
    assessmentResult: {
      assessments: [{
        candidateId: 'candidate-001',
        summary: privateBodies.provider,
        responsibilityFit: {
          rating: 'strong',
          advertEvidence: privateBodies.advert,
          profileEvidence: privateBodies.cv,
          explanation: privateBodies.provider,
        },
        mandatoryRequirements: [{
          requirement: privateBodies.prompt,
          advertEvidence: privateBodies.advert,
          advertEvidenceId: 'provider-platform',
          status: 'met',
          profileEvidence: privateBodies.cv,
        }],
        transferableExperience: [],
        uncertainties: [],
        strengths: [],
        concerns: [],
        recommendation: 'keep',
      }],
    },
    assessmentFailures: [{
      jobId: 'stable-job-002',
      code: 'assessment-exhausted',
      attempts: 3,
      validationFailures: ['missing-required-field'],
    }],
    policy: { actionScore: 70, checkScore: 55 },
    startedAt: '2026-07-28T09:00:00.000Z',
  }, { run: handle, lease });
  const prepared = handle.events.find((event) => event.type === 'mutation.prepared');
  const durable = fs.readFileSync(
    path.join(handle.directory, 'mutations', `${prepared.payload.reference.id}.json`),
    'utf8',
  );

  for (const body of Object.values(privateBodies)) {
    assert.doesNotMatch(durable, new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(durable, /Valid Co|Platform Engineer/);
  assert.match(durable, /assessment-exhausted|missing-required-field/);
  const tracker = JSON.parse(fs.readFileSync(path.join(root, 'data', 'opportunities.json'), 'utf8'));
  assert.equal(tracker.opportunities.find((item) => item.id === 'existing-user-entry').notes, privateBodies.cv);
  assert.deepEqual(
    tracker.opportunities.find((item) => item.id === 'existing-user-entry').contacts,
    [{ name: 'Private Contact' }],
  );
  assert.equal(tracker.opportunities.some((item) => item.company === 'Valid Co'), true);
  assert.equal(artifacts.mutationReceipt.id, prepared.payload.reference.id);
});

test('run-log recipes project funnel counters without copying nested source prose', () => {
  const privateBody = 'Unlabelled provider response containing a complete candidate history.';
  const recipe = runLogAppendRecipe({
    timestamp: '2026-07-28T09:00:00.000Z',
    discarded: {
      hard_exclusion: 1,
      mandatory_unmet: 2,
      below_threshold: 3,
      provider_discarded: 4,
      advert_closed: 5,
      private_counter: 999,
    },
    funnel: {
      sourceRecords: 1,
      selected: 1,
      privateProviderBody: privateBody,
      bySource: {
        ats: {
          count: 1,
          failedRecords: 0,
          sourceErrors: 0,
          response: privateBody,
        },
      },
    },
    selection_summary: {
      selected: 1,
      assessed: 1,
      assessmentFailed: 0,
      explanation: privateBody,
    },
    profile_id: privateBody,
    learning_version_id: 'learning-safe',
    assessment_failures: [{ jobId: privateBody, code: 'assessment-failed' }],
    explanations: [{ vacancy_id: privateBody, assessment_status: 'failed' }],
    reviewed: [{
      vacancyId: 'vacancy-safe-1',
      company: 'Safe Company',
      role: 'Safe Role',
      source: 'ats',
      sourceUrl: 'https://example.test/jobs/1?token=private#fragment',
      contentFingerprint: 'a'.repeat(64),
      profileId: 'profile-safe',
      learningVersionId: 'learning-safe',
      categoryId: 'general',
      outcome: 'below_threshold',
      score: 42,
      rawDiagnostic: privateBody,
    }],
  });
  const durable = JSON.stringify(recipe);

  assert.doesNotMatch(durable, new RegExp(privateBody));
  assert.deepEqual(recipe.record.funnel, {
    sourceRecords: 1,
    selected: 1,
    bySource: {
      ats: { count: 1, failedRecords: 0, sourceErrors: 0 },
    },
  });
  assert.deepEqual(recipe.record.selection_summary, {
    selected: 1,
    assessed: 1,
    assessmentFailed: 0,
  });
  assert.deepEqual(recipe.record.discarded, {
    hard_exclusion: 1,
    mandatory_unmet: 2,
    below_threshold: 3,
    provider_discarded: 4,
    advert_closed: 5,
  });
  assert.deepEqual(recipe.record.reviewed, [{
    vacancyId: 'vacancy-safe-1',
    company: 'Safe Company',
    role: 'Safe Role',
    source: 'ats',
    sourceUrl: 'https://example.test/jobs/1',
    sourceReferences: [],
    contentFingerprint: 'a'.repeat(64),
    profileId: 'profile-safe',
    learningVersionId: 'learning-safe',
    categoryId: 'general',
    outcome: 'below_threshold',
    score: 42,
    reasonCodes: ['below-threshold'],
  }]);
  assert.equal(recipe.record.learning_version_id, 'learning-safe');
  assert.deepEqual(scanReportRecipe({
    date: '2026-07-28',
    discarded: {
      hard_exclusion: 1,
      mandatory_unmet: 2,
      below_threshold: 3,
      provider_discarded: 4,
      advert_closed: 5,
      private_counter: 999,
    },
  }).model.discarded, recipe.record.discarded);
});

test('tracker recipes preserve bounded durable scan identity and ranking lineage', () => {
  const recipe = trackerMergeRecipe(
    '{"opportunities":[]}',
    JSON.stringify({
      updated: '2026-07-31',
      opportunities: [{
        id: 'safe-company-role-2026-07',
        company: 'Safe Company',
        role: 'Safe Role',
        vacancyId: 'https://jobs.example.test/role?access_token=redacted',
        profileId: 'profile-safe',
        learningVersionId: 'learning-safe',
        rankingHistory: [{
          rankedAt: '2026-07-31',
          profileId: 'profile-safe',
          learningVersionId: 'learning-safe',
          preRankScore: 73,
          privateBody: 'must not persist',
        }],
      }],
    }),
  );
  const upsert = recipe.upserts[0];
  assert.equal(upsert.vacancyId, 'https://jobs.example.test/role');
  assert.equal(upsert.profileId, 'profile-safe');
  assert.equal(upsert.learningVersionId, 'learning-safe');
  assert.deepEqual(upsert.rankingHistory, [{
    rankedAt: '2026-07-31',
    profileId: 'profile-safe',
    learningVersionId: 'learning-safe',
    preRankScore: 73,
  }]);
  assert.doesNotMatch(JSON.stringify(recipe), /must not persist|access_token/);
});

test('run-log recipes preserve URL vacancy IDs and full supported provider references', () => {
  const providerId = 'a'.repeat(129);
  const vacancyId = 'https://jobs.example.test/opening/42?tracking=private';
  const recipe = runLogAppendRecipe({
    timestamp: '2026-07-31T09:00:00.000Z',
    explanations: [{
      vacancy_id: vacancyId,
      company: 'Safe Company',
      role: 'Safe Role',
      outcome: 'below_threshold',
      sourceReferences: [{ source: 'provider-z', providerId }],
    }],
    reviewed: [{
      vacancyId,
      company: 'Safe Company',
      role: 'Safe Role',
      outcome: 'below_threshold',
      sourceReferences: [{ source: 'provider-z', providerId }],
    }],
  });
  assert.equal(recipe.record.explanations[0].vacancy_id, 'https://jobs.example.test/opening/42');
  assert.equal(recipe.record.reviewed[0].vacancyId, 'https://jobs.example.test/opening/42');
  assert.equal(recipe.record.explanations[0].sourceReferences[0].providerId, providerId);
  assert.equal(recipe.record.reviewed[0].sourceReferences[0].providerId, providerId);
});
