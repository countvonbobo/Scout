import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ONBOARDING_FILES, activateOnboardingProposal, buildOnboardingEvidence, createOnboardingProposal,
  activatedProposalRecovery, discardOnboardingProposal, readOnboardingProposal, recoverActivatedProposal,
  recoverOnboardingActivationAtStartup, validateOnboardingProposal,
} from './onboardingProposal.mjs';
import { readProviderHealth } from './providerHealth.mjs';
import { ProviderLifecycleUnclosedError } from './structuredTurn.mjs';
import {
  acquireProviderAuthMutation, releaseProviderAuthMutation,
} from './providerAuthMutation.mjs';
import { acquireScanLease, currentLeaseOwner } from './scanLease.mjs';
import { DEFAULT_WORKSPACE_CONFIG, writeWorkspaceConfig } from './workspace.mjs';

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-onboarding-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'opportunities.json'), '{"updated":"2026-07-14","opportunities":[]}\n');
  writeWorkspaceConfig(dir, {
    ...structuredClone(DEFAULT_WORKSPACE_CONFIG),
    profile: { displayName: 'Rowan', tone: 'direct' },
    search: { roleFamilies: ['Senior Software Engineer'], sectors: ['software'], locations: ['Manchester'], exclusions: ['gambling'], salaryMinimum: 60000 },
    ai: { provider: 'codex', model: null },
  });
  fs.writeFileSync(path.join(dir, 'imports', 'rowan.txt'), 'Built reliable software systems for synthetic employers only.\n');
  return dir;
}

const sourced = (text) => ({ text, evidenceIds: ['config-roles'] });
function proposal() {
  return {
    summary: 'Synthetic proposal', unresolvedQuestions: [],
    profile: { headline: sourced('Senior software engineer'), priorities: [sourced('Senior software roles')], evidence: [sourced('Software delivery evidence')], exclusions: [sourced('Exclude gambling')], tone: sourced('Direct evidence-led tone') },
    calibration: { dimensions: [{ name: 'Evidence fit', weight: 100, description: 'Advert and profile evidence' }], gates: ['Mandatory requirements need evidence'], actionScore: 70, checkScore: 55 },
    searchCategories: [{ id: 'senior-software', label: 'Senior software', description: 'Senior software roles', priority: 'primary', queries: ['senior software engineer'], keeperRule: 'Evidence-led fit' }],
    masterCv: {
      title: sourced('Rowan Testwell — Senior Software Engineer'),
      profile: sourced(Array.from({ length: 255 }, () => 'software').join(' ')),
      skills: [sourced('Reliable software delivery'), sourced('Technical leadership'), sourced('Evidence-led collaboration')],
      experience: [{ heading: sourced('Synthetic software experience'), bullets: [sourced('Built reliable software systems')] }],
      education: [], otherEvidence: [],
    },
  };
}

const status = () => ({ installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } });
const run = async () => ({ value: proposal(), usage: { input_tokens: 50 } });
const healthyDoctor = () => ({ checks: { config: { ok: true }, tracker: { ok: true }, providers: { codex: { installed: true, authenticated: true } } } });

test('onboarding evidence has stable IDs and oversized imports are never truncated', () => {
  const dir = root();
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json')));
  const evidence = buildOnboardingEvidence(dir, config);
  assert.ok(evidence.evidence.some((item) => item.id === 'config-roles'));
  assert.ok(evidence.evidence.some((item) => item.id === 'cv-0001'));
  assert.throws(() => buildOnboardingEvidence(dir, config, 10), /reduce it below/);
});

test('proposal validation rejects invented evidence IDs and bad score arithmetic', () => {
  const valid = proposal();
  const evidence = [{ id: 'config-roles' }];
  assert.equal(validateOnboardingProposal(valid, evidence), valid);
  const invented = structuredClone(valid);
  invented.masterCv.title.evidenceIds = ['invented'];
  assert.throws(() => validateOnboardingProposal(invented, evidence), /unknown evidence IDs/);
  const arithmetic = structuredClone(valid);
  arithmetic.calibration.dimensions[0].weight = 99;
  assert.throws(() => validateOnboardingProposal(arithmetic, evidence), /total 100/);
});

test('proposal staging, explicit zero-AI activation and discard are isolated', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run, now: () => '2026-07-14T10:00:00.000Z' });
  assert.equal(staged.valid, true);
  assert.equal(readOnboardingProposal(dir).files.length, 5);
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, false, { doctorFn: healthyDoctor }), /explicit/);
  const active = activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor, now: () => '2026-07-14T10:05:00.000Z' });
  assert.equal(active.ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'cv', 'master-cv.md'), 'utf8'), /evidence: config-roles/);
  assert.equal(readOnboardingProposal(dir), null);
  assert.equal(discardOnboardingProposal(dir).ok, true);
  assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activated.json')), true);
});

test('activation holds the shared backup lease across every active-file replacement', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status,
    runStructuredTurnFn: run,
  });
  let checked = false;
  activateOnboardingProposal(dir, staged.proposalId, true, {
    doctorFn: healthyDoctor,
    _testHooks: {
      beforeWrite(relative) {
        if (checked || relative !== 'workspace.json') return;
        checked = true;
        const backup = acquireScanLease(dir, currentLeaseOwner(), {
          kind: 'backup',
          runId: 'activation-backup',
          phase: 'checkpoint',
        });
        assert.equal(backup, null);
      },
    },
  });
  assert.equal(checked, true);
});

test('onboarding records remote-auth failure without resending proposal generation', async () => {
  const dir = root();
  let invocations = 0;
  const remoteAuthFailure = async () => {
    invocations += 1;
    const error = new Error('codex structured turn failed: authentication is required');
    Object.defineProperty(error, 'reasonCode', { value: 'authentication-required' });
    throw error;
  };

  await assert.rejects(
    createOnboardingProposal(dir, 'codex', {
      providerStatusFn: status,
      runStructuredTurnFn: remoteAuthFailure,
    }),
    /authentication is required/,
  );

  assert.equal(invocations, 1);
  assert.equal(readProviderHealth(dir, 'codex').state, 'sign-in-required');
  assert.equal(readProviderHealth(dir, 'codex').remoteAuthBarrier, true);
  assert.equal(readOnboardingProposal(dir), null);
});

test('onboarding proposal generation obeys the durable per-provider auth barrier', async () => {
  const dir = root();
  const mutation = acquireProviderAuthMutation(dir, 'codex', {
    owner: { host: 'synthetic-host', pid: 42, processStart: 'synthetic-start' },
    mutationId: 'onboarding-auth-mutation',
  });
  let invocations = 0;
  await assert.rejects(createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status,
    runStructuredTurnFn: async () => {
      invocations += 1;
      return { value: proposal(), usage: {} };
    },
  }), (error) => error.reasonCode === 'provider-auth-in-progress');
  assert.equal(invocations, 0);
  assert.equal(readOnboardingProposal(dir), null);

  const claude = await createOnboardingProposal(dir, 'claude', {
    providerStatusFn: status,
    runStructuredTurnFn: async () => {
      invocations += 1;
      return { value: proposal(), usage: {} };
    },
  });
  assert.equal(claude.provider, 'claude');
  assert.equal(invocations, 1);
  releaseProviderAuthMutation(dir, mutation);
});

test('onboarding transfers provider-work fencing until an unclosed turn really closes', async () => {
  const dir = root();
  let close;
  const closure = new Promise((resolve) => { close = resolve; });
  let releases = 0;
  await assert.rejects(createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status,
    runStructuredTurnFn: async () => {
      throw new ProviderLifecycleUnclosedError('provider child remains open', closure);
    },
    recordProviderResultHealthFn: async () => {},
    acquireProviderWorkFn: () => ({ provider: 'codex', workId: 'onboarding-work-01' }),
    renewProviderWorkFn: (_root, capability) => capability,
    releaseProviderWorkFn: () => { releases += 1; },
  }), /provider child remains open/);
  assert.equal(releases, 0);
  close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases, 1);
});

test('activation rejects stale targets and rolls back every active file if doctor fails', async () => {
  const dir = root();
  let staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  fs.appendFileSync(path.join(dir, '.scout', 'onboarding', 'cv', 'master-cv.md'), '\ntampered\n');
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor }), /staged cv\/master-cv.md changed/);
  discardOnboardingProposal(dir);

  staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profile', 'context.md'), 'changed after generation\n');
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor }), /changed after proposal/);
  discardOnboardingProposal(dir);

  staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  const before = Object.fromEntries(ONBOARDING_FILES.map((relative) => [relative, fs.existsSync(path.join(dir, ...relative.split('/'))) ? fs.readFileSync(path.join(dir, ...relative.split('/')), 'utf8') : null]));
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: () => ({ checks: {} }) }), /doctor rejected/);
  for (const relative of ONBOARDING_FILES) {
    const file = path.join(dir, ...relative.split('/'));
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before[relative], relative);
  }
});

test('startup reconciles a prepared activation after process death at every replacement', async () => {
  for (const interruptedAfter of ONBOARDING_FILES) {
    const dir = root();
    const staged = await createOnboardingProposal(dir, 'codex', {
      providerStatusFn: status, runStructuredTurnFn: run,
    });
    const crash = new Error(`synthetic process death after ${interruptedAfter}`);
    crash.simulateProcessDeath = true;
    assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, {
      doctorFn: healthyDoctor,
      now: () => '2026-07-14T10:05:00.000Z',
      _testHooks: {
        afterWrite(relative) {
          if (relative === interruptedAfter) throw crash;
        },
      },
    }), /synthetic process death/);
    assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), true);
    const recovered = recoverOnboardingActivationAtStartup(dir, { doctorFn: healthyDoctor });
    assert.equal(recovered.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'))).setup.completedAt,
      '2026-07-14T10:05:00.000Z');
  }
});

test('activation recovery preserves conflicting post-crash user state and its intent', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status, runStructuredTurnFn: run,
  });
  const crash = new Error('synthetic process death');
  crash.simulateProcessDeath = true;
  assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, {
    doctorFn: healthyDoctor,
    _testHooks: {
      afterWrite(relative) {
        if (relative === 'workspace.json') throw crash;
      },
    },
  }), /synthetic process death/);
  const context = path.join(dir, 'profile', 'context.md');
  fs.mkdirSync(path.dirname(context), { recursive: true });
  fs.writeFileSync(context, 'a legitimate post-crash user mutation\n');

  assert.throws(
    () => recoverOnboardingActivationAtStartup(dir, { doctorFn: healthyDoctor }),
    /conflicts with prepared onboarding activation/,
  );
  assert.equal(fs.readFileSync(context, 'utf8'), 'a legitimate post-crash user mutation\n');
  assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), true);
  assert.throws(() => discardOnboardingProposal(dir), /requires recovery/);
  await assert.rejects(createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status, runStructuredTurnFn: run,
  }), /requires recovery/);
});

test('startup finalises activation after death in each terminal cleanup window', async () => {
  for (const hook of ['afterActivatedMarker', 'afterProposalRemoval']) {
    const dir = root();
    const staged = await createOnboardingProposal(dir, 'codex', {
      providerStatusFn: status, runStructuredTurnFn: run,
    });
    const crash = new Error(`synthetic process death at ${hook}`);
    crash.simulateProcessDeath = true;
    assert.throws(() => activateOnboardingProposal(dir, staged.proposalId, true, {
      doctorFn: healthyDoctor,
      now: () => '2026-07-14T10:05:00.000Z',
      _testHooks: { [hook]: () => { throw crash; } },
    }), /synthetic process death/);
    assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), true);
    const recovered = recoverOnboardingActivationAtStartup(dir, { doctorFn: healthyDoctor });
    assert.equal(recovered.ok, true);
    assert.equal(fs.existsSync(path.join(dir, '.scout', 'onboarding', 'activation.json')), false);
    assert.equal(readOnboardingProposal(dir), null);
  }
});

test('activated empty master CV recovery is narrow, backed up, and integrity checked', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  const active = path.join(dir, 'cv', 'master-cv.md');
  const reviewed = fs.readFileSync(path.join(dir, '.scout', 'onboarding', 'cv', 'master-cv.md'), 'utf8');
  fs.writeFileSync(active, '');
  assert.equal(activatedProposalRecovery(dir).available, true);
  assert.throws(() => recoverActivatedProposal(dir, false, { doctorFn: healthyDoctor }), /explicit recovery confirmation/);
  const recovered = recoverActivatedProposal(dir, true, { doctorFn: healthyDoctor, now: () => '2026-07-14T11:00:00.000Z' });
  assert.equal(recovered.restoredBytes, Buffer.byteLength(reviewed));
  assert.equal(fs.readFileSync(active, 'utf8'), reviewed);
  assert.equal(fs.statSync(path.join(recovered.backupDir, 'cv', 'master-cv.md')).size, 0);
  assert.equal(activatedProposalRecovery(dir).available, false);
});

test('activated CV recovery cannot overlap another workspace mutation owner', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', {
    providerStatusFn: status, runStructuredTurnFn: run,
  });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  fs.writeFileSync(path.join(dir, 'cv', 'master-cv.md'), '');
  const lease = acquireScanLease(dir, currentLeaseOwner(), {
    kind: 'backup', runId: 'recovery-overlap', phase: 'checkpoint',
  });
  assert.throws(
    () => recoverActivatedProposal(dir, true, { doctorFn: healthyDoctor }),
    /mutation|progress|authority|lease/i,
  );
  assert.ok(lease);
});

test('activated master CV recovery refuses unrelated active-file drift', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  fs.writeFileSync(path.join(dir, 'cv', 'master-cv.md'), '');
  fs.appendFileSync(path.join(dir, 'profile', 'context.md'), '\nunreviewed change\n');
  assert.equal(activatedProposalRecovery(dir).available, false);
  assert.throws(() => recoverActivatedProposal(dir, true, { doctorFn: healthyDoctor }), /no longer matches/);
});

test('activated master CV recovery refuses workspace drift beyond activation time', async () => {
  const dir = root();
  const staged = await createOnboardingProposal(dir, 'codex', { providerStatusFn: status, runStructuredTurnFn: run });
  activateOnboardingProposal(dir, staged.proposalId, true, { doctorFn: healthyDoctor });
  fs.writeFileSync(path.join(dir, 'cv', 'master-cv.md'), '');
  const workspaceFile = path.join(dir, 'workspace.json');
  const config = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  config.search.locations = ['Unreviewed place'];
  fs.writeFileSync(workspaceFile, `${JSON.stringify(config, null, 2)}\n`);
  assert.equal(activatedProposalRecovery(dir).available, false);
  assert.throws(() => recoverActivatedProposal(dir, true, { doctorFn: healthyDoctor }), /workspace\.json no longer matches/);
});
