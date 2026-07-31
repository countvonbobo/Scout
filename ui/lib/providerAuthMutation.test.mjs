import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquireProviderAuthMutation,
  acquireProviderWork,
  createProviderWorkSupervisor,
  readProviderAuthMutation,
  releaseProviderAuthMutation,
  releaseProviderWork,
  renewProviderAuthMutation,
  renewProviderWork,
} from './providerAuthMutation.mjs';
import { currentLeaseOwner } from './scanLease.mjs';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-provider-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const owner = { host: 'synthetic-host', pid: 42, processStart: 'synthetic-start' };

function contender(root, provider) {
  const moduleUrl = new URL('./providerAuthMutation.mjs', import.meta.url).href;
  const source = `
    import os from 'node:os';
    import { acquireProviderAuthMutation } from ${JSON.stringify(moduleUrl)};
    const mutation = acquireProviderAuthMutation(
      process.env.SCOUT_AUTH_ROOT,
      process.env.SCOUT_AUTH_PROVIDER,
      {
        owner: { host: os.hostname(), pid: process.pid, processStart: 'process-' + process.pid },
        durationMs: 30000,
      },
    );
    process.stdout.write(mutation ? 'acquired' : 'blocked');
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, SCOUT_AUTH_ROOT: root, SCOUT_AUTH_PROVIDER: provider },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => (
      status === 0 ? resolve(stdout) : reject(new Error(stderr || `contender exited ${status}`))
    ));
  });
}

function mixedContender(root, kind) {
  const moduleUrl = new URL('./providerAuthMutation.mjs', import.meta.url).href;
  const source = `
    import os from 'node:os';
    import { acquireProviderAuthMutation, acquireProviderWork } from ${JSON.stringify(moduleUrl)};
    const owner = { host: os.hostname(), pid: process.pid, processStart: 'process-' + process.pid };
    try {
      const capability = process.env.SCOUT_AUTH_KIND === 'auth'
        ? acquireProviderAuthMutation(process.env.SCOUT_AUTH_ROOT, 'codex', {
          owner, durationMs: 30000, mutationId: 'mixed-auth-operation-' + process.pid,
        })
        : acquireProviderWork(process.env.SCOUT_AUTH_ROOT, 'codex', {
          owner, durationMs: 30000, workId: 'mixed-work-operation-' + process.pid,
        });
      process.stdout.write(capability ? 'acquired' : 'blocked');
    } catch (error) {
      process.stdout.write(
        ['provider-auth-in-progress', 'provider-work-in-progress'].includes(error?.reasonCode)
          ? 'blocked' : 'error',
      );
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
      env: { ...process.env, SCOUT_AUTH_ROOT: root, SCOUT_AUTH_KIND: kind },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => (
      status === 0 ? resolve(stdout) : reject(new Error(stderr || `mixed contender exited ${status}`))
    ));
  });
}

test('authentication mutation authority blocks only the same provider', (t) => {
  const root = workspace(t);
  const codex = acquireProviderAuthMutation(root, 'codex', {
    owner, now: 1_000, durationMs: 5_000, mutationId: 'codex-mutation-0001',
  });
  assert.equal(acquireProviderAuthMutation(root, 'codex', {
    owner, now: 1_001, durationMs: 5_000, mutationId: 'codex-mutation-0002',
  }), null);
  const claude = acquireProviderAuthMutation(root, 'claude', {
    owner, now: 1_001, durationMs: 5_000, mutationId: 'claude-mutation-01',
  });
  assert.equal(claude.provider, 'claude');
  assert.equal(readProviderAuthMutation(root, 'codex', { now: 1_002 }).mutationId, codex.mutationId);
});

test('simultaneous processes admit one auth mutation per provider', async (t) => {
  const root = workspace(t);
  const codex = await Promise.all(Array.from({ length: 4 }, () => contender(root, 'codex')));
  assert.equal(codex.filter((status) => status === 'acquired').length, 1);
  assert.equal(codex.filter((status) => status === 'blocked').length, 3);
  assert.deepEqual(
    (await Promise.all([contender(root, 'claude'), contender(root, 'claude')])).sort(),
    ['acquired', 'blocked'],
  );
});

test('an old guard owned by this live process cannot be stolen', (t) => {
  const root = workspace(t);
  const guard = path.join(root, '.scout', 'provider-auth', 'v1', 'codex.guard');
  const guardIdentity = ['live', 'guard', 'token', '0001'].join('-');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), JSON.stringify({
    token: String(guardIdentity),
    owner: currentLeaseOwner(),
    acquiredAt: 0,
  }));
  assert.equal(acquireProviderAuthMutation(root, 'codex', {
    owner: currentLeaseOwner(),
    now: 20_000,
    durationMs: 5_000,
    mutationId: 'must-remain-blocked',
  }), null);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(guard, 'owner.json'), 'utf8')).token,
    guardIdentity,
  );
});

test('transient guard publication contention retries before reporting an auth result', (t) => {
  const root = workspace(t);
  const originalRename = fs.renameSync;
  let publicationAttempts = 0;
  fs.renameSync = (source, destination) => {
    if (String(source).includes('codex.guard.candidate-')
      && String(destination).endsWith('codex.guard')) {
      publicationAttempts += 1;
      if (publicationAttempts === 1) {
        throw Object.assign(new Error('injected Windows publication contention'), { code: 'EPERM' });
      }
    }
    return originalRename(source, destination);
  };
  let auth;
  try {
    auth = acquireProviderAuthMutation(root, 'codex', {
      owner,
      now: 1_000,
      durationMs: 5_000,
      mutationId: 'transient-publish-01',
    });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.ok(auth);
  assert.equal(publicationAttempts, 2);
  assert.equal(releaseProviderAuthMutation(root, auth, { now: 1_001 }), true);
});

test('expired authentication authority is recovered with a new capability', (t) => {
  const root = workspace(t);
  const deadOwner = {
    ...currentLeaseOwner(),
    pid: 2_147_483_647,
    processStart: 'definitely-dead-owner',
  };
  const expired = acquireProviderAuthMutation(root, 'codex', {
    owner: deadOwner, now: 1_000, durationMs: 10, mutationId: 'expired-mutation-01',
  });
  assert.equal(readProviderAuthMutation(root, 'codex', { now: 1_011 }), null);
  const recovered = acquireProviderAuthMutation(root, 'codex', {
    owner, now: 1_011, durationMs: 10, mutationId: 'recovered-mutation1',
  });
  assert.notEqual(recovered.mutationId, expired.mutationId);
  assert.throws(
    () => releaseProviderAuthMutation(root, expired, { now: 1_012 }),
    /capability was lost/,
  );
  assert.equal(releaseProviderAuthMutation(root, recovered, { now: 1_012 }), true);
  assert.equal(readProviderAuthMutation(root, 'codex', { now: 1_012 }), null);
});

test('expired live auth and work records remain mutually exclusive and renewable', (t) => {
  const root = workspace(t);
  const liveOwner = currentLeaseOwner();
  const auth = acquireProviderAuthMutation(root, 'codex', {
    owner: liveOwner,
    now: 1_000,
    durationMs: 10,
    mutationId: 'live-expired-auth-01',
  });
  assert.equal(acquireProviderAuthMutation(root, 'codex', {
    owner: liveOwner,
    now: 1_011,
    durationMs: 10,
    mutationId: 'overlap-auth-denied',
  }), null);
  assert.throws(() => acquireProviderWork(root, 'codex', {
    owner: liveOwner,
    now: 1_011,
    durationMs: 10,
    workId: 'overlap-work-denied',
  }), (error) => error.reasonCode === 'provider-auth-in-progress');
  const renewedAuth = renewProviderAuthMutation(root, auth, {
    now: 1_011,
    durationMs: 10,
  });
  releaseProviderAuthMutation(root, renewedAuth, { now: 1_012 });

  const work = acquireProviderWork(root, 'codex', {
    owner: liveOwner,
    now: 2_000,
    durationMs: 10,
    workId: 'live-expired-work-01',
  });
  assert.equal(acquireProviderAuthMutation(root, 'codex', {
    owner: liveOwner,
    now: 2_011,
    durationMs: 10,
    mutationId: 'overlap-auth-denied2',
  }), null);
  const renewedWork = renewProviderWork(root, work, {
    now: 2_011,
    durationMs: 10,
  });
  releaseProviderWork(root, renewedWork, { now: 2_012 });
});

test('an orphaned guard candidate never blocks the published guard path', (t) => {
  const root = workspace(t);
  const candidate = path.join(
    root,
    '.scout',
    'provider-auth',
    'v1',
    'codex.guard.candidate-orphaned-process',
  );
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, 'owner.json'), '{}');
  const auth = acquireProviderAuthMutation(root, 'codex', {
    owner: currentLeaseOwner(),
    now: 1_000,
    durationMs: 10,
    mutationId: 'candidate-safe-auth1',
  });
  assert.ok(auth);
  assert.equal(fs.existsSync(candidate), true);
  releaseProviderAuthMutation(root, auth, { now: 1_001 });
});

test('provider work and authentication mutation are mutually exclusive under one guard', (t) => {
  const root = workspace(t);
  const work = acquireProviderWork(root, 'codex', {
    owner,
    now: 1_000,
    durationMs: 5_000,
    workId: 'provider-work-0001',
  });
  assert.equal(acquireProviderAuthMutation(root, 'codex', {
    owner,
    now: 1_001,
    durationMs: 5_000,
    mutationId: 'blocked-auth-0001',
  }), null);
  assert.equal(releaseProviderWork(root, work, { now: 1_002 }), true);

  const auth = acquireProviderAuthMutation(root, 'codex', {
    owner,
    now: 1_003,
    durationMs: 5_000,
    mutationId: 'active-auth-000001',
  });
  assert.throws(() => acquireProviderWork(root, 'codex', {
    owner,
    now: 1_004,
    durationMs: 5_000,
    workId: 'blocked-work-0001',
  }), (error) => error.reasonCode === 'provider-auth-in-progress');
  releaseProviderAuthMutation(root, auth, { now: 1_005 });
});

test('active provider work renews before expiry and remains an auth barrier', (t) => {
  const root = workspace(t);
  const work = acquireProviderWork(root, 'codex', {
    owner, now: 1_000, durationMs: 1_000, workId: 'renewed-work-0001',
  });
  const renewed = renewProviderWork(root, work, {
    now: 1_900, durationMs: 1_000,
  });
  assert.equal(renewed.expiresAt, 2_900);
  assert.equal(acquireProviderAuthMutation(root, 'codex', {
    owner,
    now: 2_001,
    durationMs: 100,
    mutationId: 'blocked-by-renewal',
  }), null);
  assert.equal(releaseProviderWork(root, renewed, { now: 2_002 }), true);
});

test('active authentication mutation renews before expiry and retains its original acquisition', (t) => {
  const root = workspace(t);
  const auth = acquireProviderAuthMutation(root, 'codex', {
    owner, now: 1_000, durationMs: 1_000, mutationId: 'renewed-auth-000001',
  });
  const renewed = renewProviderAuthMutation(root, auth, {
    now: 1_900, durationMs: 1_000,
  });
  assert.equal(renewed.acquiredAt, 1_000);
  assert.equal(renewed.expiresAt, 2_900);
  assert.throws(
    () => renewProviderAuthMutation(root, { ...auth, mutationId: 'forged-auth-000001' }, {
      now: 2_000,
      durationMs: 1_000,
    }),
    /capability was lost/,
  );
  assert.equal(releaseProviderAuthMutation(root, renewed, { now: 2_001 }), true);
});

test('provider work supervisor renews long work and transfers release to lifecycle closure', async () => {
  let intervalCallback;
  let released = 0;
  let renewed = 0;
  let close;
  const closure = new Promise((resolve) => { close = resolve; });
  const supervisor = createProviderWorkSupervisor('/synthetic', 'codex', {
    acquire: () => ({ provider: 'codex', workId: 'supervised-work-01' }),
    renew: (_root, capability) => {
      renewed += 1;
      return capability;
    },
    release: () => {
      released += 1;
      return true;
    },
    setIntervalFn(callback) {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
    intervalMs: 1,
  });
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewed, 1);
  assert.equal(await supervisor.release({ closure }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 0);
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewed, 2);
  close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1);
});

test('provider work supervisor retries the same fence or stops the active operation', async () => {
  let intervalCallback;
  let acquisitions = 0;
  let renewals = 0;
  let stopped = 0;
  const releasedIds = [];
  const recovered = createProviderWorkSupervisor('/synthetic', 'codex', {
    acquire: () => ({
      provider: 'codex',
      workId: `replacement-${String(++acquisitions).padStart(2, '0')}`,
    }),
    renew: async (_root, capability) => {
      renewals += 1;
      if (renewals === 1) throw new Error('synthetic renewal contention');
      return capability;
    },
    release: (_root, capability) => {
      releasedIds.push(capability.workId);
      return true;
    },
    setIntervalFn(callback) {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
    intervalMs: 1,
  });
  recovered.setFailureHandler(() => { stopped += 1; });
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquisitions, 1);
  assert.equal(renewals, 2);
  assert.equal(stopped, 0);
  assert.deepEqual(releasedIds, []);
  assert.equal(recovered.assertCurrent(), true);
  await recovered.release();
  assert.deepEqual(releasedIds, ['replacement-01']);

  const failed = createProviderWorkSupervisor('/synthetic', 'codex', {
    acquire: () => ({ provider: 'codex', workId: 'initial-failed-work' }),
    renew: async () => { throw new Error('unrecoverable renewal loss'); },
    release: () => true,
    setIntervalFn(callback) {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
    intervalMs: 1,
  });
  failed.setFailureHandler(() => { stopped += 1; });
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.throws(() => failed.assertCurrent(), /unrecoverable renewal loss/);
  await failed.release();
});

test('provider work retry keeps one filesystem capability without an authority gap', async (t) => {
  const root = workspace(t);
  let intervalCallback;
  let renewals = 0;
  const supervisor = createProviderWorkSupervisor(root, 'codex', {
    renew: async (workspaceRoot, capability) => {
      renewals += 1;
      if (renewals === 1) throw new Error('synthetic guard contention');
      return renewProviderWork(workspaceRoot, capability);
    },
    setIntervalFn(callback) {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
    intervalMs: 1,
  });
  const workDirectory = path.join(root, '.scout', 'provider-auth', 'v1', 'codex.work');
  assert.equal(fs.readdirSync(workDirectory).length, 1);
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(renewals, 2);
  assert.equal(fs.readdirSync(workDirectory).length, 1);
  await supervisor.release();
  assert.equal(fs.existsSync(workDirectory), false);
});

test('simultaneous auth and provider-work processes admit exactly one class of operation', async (t) => {
  const root = workspace(t);
  const outcomes = await Promise.all([
    mixedContender(root, 'auth'),
    mixedContender(root, 'work'),
  ]);
  assert.deepEqual(outcomes.sort(), ['acquired', 'blocked']);
});
