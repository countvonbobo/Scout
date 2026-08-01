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

function temporaryLiveGuard(root, holdMs = 100) {
  const scanLeaseUrl = new URL('./scanLease.mjs', import.meta.url).href;
  const source = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { currentLeaseOwner } from ${JSON.stringify(scanLeaseUrl)};
    const guard = path.join(process.env.SCOUT_AUTH_ROOT, '.scout', 'provider-auth', 'v1', 'codex.guard');
    fs.mkdirSync(guard, { recursive: true });
    fs.writeFileSync(path.join(guard, 'owner.json'), JSON.stringify({
      token: String(['temporary', 'live', 'guard', '0001'].join('-')),
      owner: currentLeaseOwner(), acquiredAt: Date.now(),
    }));
    process.stdout.write('ready\\n');
    setTimeout(() => fs.rmSync(guard, { recursive: true, force: true }), Number(process.env.HOLD_MS));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: { ...process.env, SCOUT_AUTH_ROOT: root, HOLD_MS: String(holdMs) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stderr.once('data', (chunk) => reject(new Error(String(chunk))));
    child.stdout.once('data', () => resolve(child));
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

test('release waits for a temporary live guard instead of abandoning durable authority', async (t) => {
  const root = workspace(t);
  const auth = acquireProviderAuthMutation(root, 'codex', {
    owner: currentLeaseOwner(), now: Date.now(), durationMs: 5_000,
    mutationId: 'release-after-guard-01',
  });
  const child = await temporaryLiveGuard(root);
  assert.equal(releaseProviderAuthMutation(root, auth), true);
  await new Promise((resolve, reject) => {
    child.once('close', (status) => (status === 0 ? resolve() : reject(new Error(`guard child exited ${status}`))));
  });
  assert.equal(readProviderAuthMutation(root, 'codex'), null);
});

test('release reports bounded guard timeout and preserves durable authority', (t) => {
  const root = workspace(t);
  const auth = acquireProviderAuthMutation(root, 'codex', {
    owner: currentLeaseOwner(), now: Date.now(), durationMs: 5_000,
    mutationId: 'release-timeout-guard1',
  });
  const guard = path.join(root, '.scout', 'provider-auth', 'v1', 'codex.guard');
  fs.mkdirSync(guard, { recursive: true });
  fs.writeFileSync(path.join(guard, 'owner.json'), JSON.stringify({
    token: String(['live', 'release', 'guard', '0001'].join('-')),
    owner: currentLeaseOwner(), acquiredAt: Date.now(),
  }));
  assert.throws(
    () => releaseProviderAuthMutation(root, auth),
    /could not be released/,
  );
  assert.equal(readProviderAuthMutation(root, 'codex').mutationId, auth.mutationId);
  fs.rmSync(guard, { recursive: true, force: true });
  assert.equal(releaseProviderAuthMutation(root, auth), true);
});

test('simultaneous provider work acquisitions are serialized but all admitted', async (t) => {
  const root = workspace(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => mixedContender(root, 'work')));
  assert.deepEqual(results, ['acquired', 'acquired', 'acquired', 'acquired']);
});

test('committed authority survives transient canonical guard cleanup contention', (t) => {
  const root = workspace(t);
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (source, destination) => {
    if (!injected && String(source).endsWith('codex.guard')
      && String(destination).includes('.cleanup-')) {
      injected = true;
      throw Object.assign(new Error('injected Windows cleanup contention'), { code: 'EPERM' });
    }
    return originalRename(source, destination);
  };
  const scheduled = [];
  const cleanupScheduler = (callback) => {
    scheduled.push(callback);
    return { unref() {} };
  };
  let auth;
  try {
    auth = acquireProviderAuthMutation(root, 'codex', {
      owner: currentLeaseOwner(), now: Date.now(), durationMs: 5_000,
      mutationId: 'cleanup-contention-01',
      _testHooks: { cleanupScheduler },
    });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.ok(auth);
  assert.equal(readProviderAuthMutation(root, 'codex').mutationId, auth.mutationId);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(releaseProviderAuthMutation(root, auth), true);
});

test('canonical cleanup retries transient owner record unreadability', (t) => {
  const root = workspace(t);
  const originalRename = fs.renameSync;
  const originalRead = fs.readFileSync;
  const scheduled = [];
  const cleanupScheduler = (callback) => {
    scheduled.push(callback);
    return { unref() {} };
  };
  fs.renameSync = (source, destination) => {
    if (String(source).endsWith('codex.guard') && String(destination).includes('.cleanup-')) {
      throw Object.assign(new Error('injected canonical contention'), { code: 'EPERM' });
    }
    return originalRename(source, destination);
  };
  let auth;
  try {
    auth = acquireProviderAuthMutation(root, 'codex', {
      owner: currentLeaseOwner(), now: Date.now(), durationMs: 5_000,
      mutationId: 'cleanup-unreadable-01', _testHooks: { cleanupScheduler },
    });
  } finally {
    fs.renameSync = originalRename;
  }
  const ownerFile = path.join(root, '.scout', 'provider-auth', 'v1', 'codex.guard', 'owner.json');
  let unreadable = true;
  fs.readFileSync = (file, ...args) => {
    if (unreadable && path.resolve(String(file)) === path.resolve(ownerFile)) {
      unreadable = false;
      throw Object.assign(new Error('injected transient owner read contention'), { code: 'EBUSY' });
    }
    return originalRead(file, ...args);
  };
  try {
    assert.equal(scheduled.length, 1);
    scheduled.shift()();
  } finally {
    fs.readFileSync = originalRead;
  }
  assert.equal(scheduled.length, 1, 'ambiguous owner reads must remain scheduled');
  scheduled.shift()();
  assert.equal(fs.existsSync(path.dirname(ownerFile)), false);
  assert.equal(releaseProviderAuthMutation(root, auth), true);
});

test('canonical cleanup never strands a guard after partial Windows removal', (t) => {
  const root = workspace(t);
  const originalRemove = fs.rmSync;
  let injected = false;
  fs.rmSync = (target, options) => {
    if (!injected && String(target).endsWith('codex.guard')) {
      injected = true;
      fs.unlinkSync(path.join(target, 'owner.json'));
      throw Object.assign(new Error('injected partial Windows cleanup'), { code: 'EPERM' });
    }
    return originalRemove(target, options);
  };
  let auth;
  try {
    auth = acquireProviderAuthMutation(root, 'codex', {
      owner: currentLeaseOwner(), now: Date.now(), durationMs: 5_000,
      mutationId: 'partial-cleanup-0001',
    });
  } finally {
    fs.rmSync = originalRemove;
  }
  assert.ok(auth);
  assert.equal(
    fs.existsSync(path.join(root, '.scout', 'provider-auth', 'v1', 'codex.guard')),
    false,
  );
  assert.equal(releaseProviderAuthMutation(root, auth), true);
});

test('committed authority schedules identity-checked cleanup after persistent Windows contention', (t) => {
  const root = workspace(t);
  const originalRemove = fs.rmSync;
  const originalRename = fs.renameSync;
  fs.rmSync = (target, options) => {
    if (String(target).endsWith('codex.guard')) {
      throw Object.assign(new Error('injected persistent cleanup contention'), { code: 'EPERM' });
    }
    return originalRemove(target, options);
  };
  fs.renameSync = (source, destination) => {
    if (String(source).endsWith('codex.guard') && String(destination).includes('.cleanup-')) {
      throw Object.assign(new Error('injected persistent cleanup rename contention'), { code: 'EPERM' });
    }
    return originalRename(source, destination);
  };
  const scheduled = [];
  const cleanupScheduler = (callback) => {
    scheduled.push(callback);
    return { unref() {} };
  };
  let auth;
  try {
    auth = acquireProviderAuthMutation(root, 'codex', {
      owner: currentLeaseOwner(), now: Date.now(), durationMs: 5_000,
      mutationId: 'cleanup-pending-0001',
      _testHooks: { cleanupScheduler },
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert.equal(scheduled.length, 1);
      scheduled.shift()();
    }
  } finally {
    fs.rmSync = originalRemove;
    fs.renameSync = originalRename;
  }
  assert.ok(auth);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(fs.existsSync(path.join(root, '.scout', 'provider-auth', 'v1', 'codex.guard')), false);
  assert.equal(releaseProviderAuthMutation(root, auth), true);
  assert.equal(fs.existsSync(path.join(root, '.scout', 'provider-auth', 'v1', 'codex.guard')), false);
});

test('detached cleanup finishes an empty quarantine after partial Windows removal', (t) => {
  const root = workspace(t);
  const originalRemove = fs.rmSync;
  let injected = false;
  fs.rmSync = (target, options) => {
    if (!injected && String(target).includes('codex.guard.cleanup-')) {
      injected = true;
      fs.unlinkSync(path.join(target, 'owner.json'));
      throw Object.assign(new Error('injected partial quarantine cleanup'), { code: 'EPERM' });
    }
    return originalRemove(target, options);
  };
  const scheduled = [];
  const cleanupScheduler = (callback) => {
    scheduled.push(callback);
    return { unref() {} };
  };
  let auth;
  try {
    auth = acquireProviderAuthMutation(root, 'codex', {
      owner: currentLeaseOwner(), now: Date.now(), durationMs: 5_000,
      mutationId: 'partial-quarantine-01',
      _testHooks: { cleanupScheduler },
    });
  } finally {
    fs.rmSync = originalRemove;
  }
  assert.ok(auth);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  const directory = path.join(root, '.scout', 'provider-auth', 'v1');
  assert.equal(fs.readdirSync(directory).some((name) => name.includes('codex.guard.cleanup-')), false);
  assert.equal(releaseProviderAuthMutation(root, auth), true);
});

test('owned cleanup stops when canonical guard ownership changes', (t) => {
  const root = workspace(t);
  const originalRemove = fs.rmSync;
  const originalRename = fs.renameSync;
  const scheduled = [];
  const cleanupScheduler = (callback) => {
    scheduled.push(callback);
    return { unref() {} };
  };
  fs.rmSync = (target, options) => {
    if (String(target).endsWith('codex.guard')) {
      throw Object.assign(new Error('injected cleanup contention'), { code: 'EPERM' });
    }
    return originalRemove(target, options);
  };
  fs.renameSync = (source, destination) => {
    if (String(source).endsWith('codex.guard') && String(destination).includes('.cleanup-')) {
      throw Object.assign(new Error('injected rename contention'), { code: 'EPERM' });
    }
    return originalRename(source, destination);
  };
  let auth;
  try {
    auth = acquireProviderAuthMutation(root, 'codex', {
      owner: currentLeaseOwner(), now: Date.now(), durationMs: 5_000,
      mutationId: 'cleanup-successor-01', _testHooks: { cleanupScheduler },
    });
  } finally {
    fs.rmSync = originalRemove;
    fs.renameSync = originalRename;
  }
  const guard = path.join(root, '.scout', 'provider-auth', 'v1', 'codex.guard');
  const ownerFile = path.join(guard, 'owner.json');
  const successor = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  successor.token = ['successor', 'token', '00000001'].join('-');
  fs.writeFileSync(ownerFile, `${JSON.stringify(successor)}\n`);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(scheduled.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token, successor.token);
  fs.rmSync(guard, { recursive: true, force: true });
  assert.equal(releaseProviderAuthMutation(root, auth), true);
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
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(candidate, old, old);
  const auth = acquireProviderAuthMutation(root, 'codex', {
    owner: currentLeaseOwner(),
    now: 1_000,
    durationMs: 10,
    mutationId: 'candidate-safe-auth1',
  });
  assert.ok(auth);
  assert.equal(fs.existsSync(candidate), false);
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
