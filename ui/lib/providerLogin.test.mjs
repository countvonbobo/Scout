import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import {
  createProviderLoginManager,
  terminateProviderProcessTree,
} from './providerLogin.mjs';

const OWNER = Object.freeze({
  access: 'local',
  ownerId: 'local-owner',
  originVerified: true,
  csrfVerified: true,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeChild({ captureInput = null, closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (captureInput) captureInput.push(Buffer.from(chunk).toString('utf8'));
      callback();
    },
  });
  child.killed = false;
  child.killSignals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.killSignals.push(signal);
    if (closeOnKill) queueMicrotask(() => child.close(null));
    return true;
  };
  child.close = (status = 0) => child.emit('close', status, null);
  return child;
}

function harness({
  provider = 'codex',
  maxStarts = 3,
  timeoutMs = 60_000,
  maxOutputBytes,
  maxOutputLines,
  maxLineBytes,
  maxCancels,
  maxRetries,
  terminateGraceMs,
  shutdownDeadlineMs,
  closeOnKill = true,
  childCount = 2,
  confirmProviderHealth = async () => ({ kind: 'remote-success', source: 'post-auth' }),
  onHealthSignal = async () => {},
  canClearClaudeCredentials = async () => true,
} = {}) {
  const login = fakeChild({ closeOnKill });
  const validation = fakeChild({ closeOnKill });
  const calls = [];
  const health = [];
  const status = {
    installed: true,
    authenticated: false,
    command: provider,
  };
  Object.defineProperties(status, {
    executable: { value: `/trusted/bin/${provider}`, enumerable: false },
    env: {
      value: {
        PATH: '/trusted/bin',
        HOME: '/synthetic-owner',
        SCOUT_TEST_SECRET: 'must-not-reach-login',
      },
      enumerable: false,
    },
  });
  const children = [login, validation];
  while (children.length < childCount) children.push(fakeChild({ closeOnKill }));
  const childQueue = [...children];
  const manager = createProviderLoginManager({
    providerStatus: async (name) => {
      assert.equal(name, provider);
      return status;
    },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const child = childQueue.shift();
      if (!child) throw new Error('unexpected spawn');
      return child;
    },
    confirmProviderHealth,
    canClearClaudeCredentials,
    onHealthSignal: async (name, signal) => {
      health.push([name, signal]);
      await onHealthSignal(name, signal);
    },
    cwd: '/fixed/scout',
    timeoutMs,
    maxStarts,
    ...(maxCancels === undefined ? {} : { maxCancels }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(terminateGraceMs === undefined ? {} : { terminateGraceMs }),
    ...(shutdownDeadlineMs === undefined ? {} : { shutdownDeadlineMs }),
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    ...(maxOutputLines === undefined ? {} : { maxOutputLines }),
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
  });
  return { manager, login, validation, children, calls, health };
}

test('Windows provider cleanup uses only fixed taskkill process-tree arguments', async () => {
  const child = fakeChild({ closeOnKill: false });
  child.pid = 4242;
  const killer = new EventEmitter();
  let call;
  const result = terminateProviderProcessTree(child, {
    platform: 'win32',
    timeoutMs: 50,
    spawn(command, args, options) {
      call = { command, args, options };
      queueMicrotask(() => killer.emit('close', 0));
      return killer;
    },
  });
  await result;
  assert.deepEqual(call, {
    command: 'taskkill.exe',
    args: ['/pid', '4242', '/T', '/F'],
    options: {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    },
  });
  assert.deepEqual(child.killSignals, []);
});

test('Codex login uses only the trusted executable and fixed device-auth/status arguments', async () => {
  const h = harness();
  const started = await h.manager.startProviderLogin('codex', OWNER);
  assert.deepEqual(Object.keys(started).sort(), [
    'codeRequired',
    'createdAt',
    'expiresAt',
    'provider',
    'reasonCode',
    'sessionId',
    'state',
    'userCode',
    'verificationUrl',
  ]);
  assert.equal(started.provider, 'codex');
  assert.equal(started.state, 'starting');
  assert.deepEqual(h.calls[0], {
    command: '/trusted/bin/codex',
    args: ['login', '--device-auth'],
    options: {
      cwd: '/fixed/scout',
      env: { PATH: '/trusted/bin', HOME: '/synthetic-owner' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: undefined,
    },
  });

  h.login.stdout.write('Open https://auth.openai.com/cod');
  h.login.stdout.write('ex/device?state=opaque#fragment and enter ABCD-');
  h.login.stdout.write('EFGH\n');
  h.login.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls[1].args, ['login', 'status']);
  h.validation.stdout.write('Logged in as private@example.test with token sk-secret\n');
  h.validation.close(0);
  await new Promise((resolve) => setImmediate(resolve));

  const complete = h.manager.getProviderLoginSession(started.sessionId, OWNER);
  assert.equal(complete.state, 'succeeded');
  assert.equal(complete.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(complete.userCode, 'ABCD-EFGH');
  assert.equal(JSON.stringify(complete).includes('private@example.test'), false);
  assert.equal(JSON.stringify(complete).includes('sk-secret'), false);
  assert.deepEqual(h.health, [
    ['codex', { kind: 'login-started', source: 'post-auth' }],
    ['codex', { kind: 'remote-success', source: 'post-auth' }],
  ]);
});

test('Claude accepts one bounded manual code only after its fixed flow requests one', async () => {
  const input = [];
  const h = harness({ provider: 'claude' });
  h.login.stdin = fakeChild({ captureInput: input }).stdin;
  const started = await h.manager.startProviderLogin('claude', OWNER);
  assert.deepEqual(h.calls[0].args, ['auth', 'login']);
  await assert.rejects(
    h.manager.submitProviderLoginCode(started.sessionId, 'CODE-1234', OWNER),
    /not awaiting a manual code/,
  );

  h.login.stderr.write('Paste the authorization code:\n');
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = h.manager.getProviderLoginSession(started.sessionId, OWNER);
  assert.equal(waiting.state, 'awaiting-code');
  assert.equal(waiting.codeRequired, true);

  const submitted = await h.manager.submitProviderLoginCode(
    started.sessionId,
    'CODE-1234',
    OWNER,
  );
  assert.equal(submitted.state, 'authenticating');
  assert.deepEqual(input, ['CODE-1234\n']);
  assert.equal(h.login.stdin.writableEnded, true);
  await assert.rejects(
    h.manager.submitProviderLoginCode(started.sessionId, 'CODE-1234', OWNER),
    /not awaiting a manual code/,
  );

  h.login.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls[1].args, ['auth', 'status']);
  h.validation.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.manager.getProviderLoginSession(started.sessionId, OWNER).state,
    'succeeded',
  );
});

test('owner, origin and CSRF checks protect every session operation', async () => {
  const h = harness();
  await assert.rejects(
    h.manager.startProviderLogin('codex', { ...OWNER, csrfVerified: false }),
    /verified owner context/,
  );
  await assert.rejects(
    h.manager.startProviderLogin('codex', { ...OWNER, originVerified: false }),
    /verified owner context/,
  );
  await assert.rejects(
    h.manager.startProviderLogin('codex', { ...OWNER, access: 'public' }),
    /verified owner context/,
  );
  const started = await h.manager.startProviderLogin('codex', OWNER);
  assert.equal(
    h.manager.getProviderLoginSession(started.sessionId, {
      ...OWNER,
      access: 'remote-owner',
    }).sessionId,
    started.sessionId,
  );
  const otherOwner = { ...OWNER, ownerId: 'other-owner' };
  assert.throws(
    () => h.manager.getProviderLoginSession(started.sessionId, otherOwner),
    /session is unavailable/,
  );
  await assert.rejects(
    h.manager.cancelProviderLogin(started.sessionId, otherOwner),
    /session is unavailable/,
  );
  await assert.rejects(
    h.manager.submitProviderLoginCode(started.sessionId, 'CODE-1234', otherOwner),
    /session is unavailable/,
  );
  assert.equal(h.manager.getActiveProviderLogin('claude', OWNER), null);
  assert.equal(
    h.manager.getActiveProviderLogin('codex', OWNER).sessionId,
    started.sessionId,
  );
  assert.throws(
    () => h.manager.getActiveProviderLogin('other', OWNER),
    /unsupported provider/,
  );
});

test('cancel is not replayable after the owner ended a session', async () => {
  const h = harness();
  const started = await h.manager.startProviderLogin('codex', OWNER);
  await h.manager.cancelProviderLogin(started.sessionId, OWNER);
  await assert.rejects(
    h.manager.cancelProviderLogin(started.sessionId, OWNER),
    /already terminal/,
  );
});

test('sessions enforce one active login and bounded start rate per owner/provider', async () => {
  const h = harness({ maxStarts: 2 });
  const first = await h.manager.startProviderLogin('codex', OWNER);
  await assert.rejects(
    h.manager.startProviderLogin('codex', OWNER),
    /login is already active/,
  );
  await h.manager.cancelProviderLogin(first.sessionId, OWNER);

  const second = await h.manager.startProviderLogin('codex', OWNER);
  await h.manager.cancelProviderLogin(second.sessionId, OWNER);
  await assert.rejects(
    h.manager.startProviderLogin('codex', OWNER),
    /login start rate limit/,
  );
});

test('cancel and retry have distinct bounded owner/provider rate limits', async () => {
  const h = harness({
    childCount: 4,
    maxCancels: 1,
    maxRetries: 1,
    maxStarts: 3,
  });
  const first = await h.manager.startProviderLogin('codex', OWNER);
  await h.manager.cancelProviderLogin(first.sessionId, OWNER);

  const retry = await h.manager.retryProviderLogin('codex', OWNER);
  await assert.rejects(
    h.manager.cancelProviderLogin(retry.sessionId, OWNER),
    /cancel rate limit/,
  );
  retry && h.validation.close(1);
  await new Promise((resolve) => setImmediate(resolve));

  const secondRetry = h.manager.retryProviderLogin('codex', OWNER);
  await assert.rejects(secondRetry, /retry rate limit/);
});

test('simultaneous starts reserve the provider before asynchronous status lookup', async () => {
  const statusReady = deferred();
  const status = { installed: true };
  Object.defineProperties(status, {
    executable: { value: '/trusted/bin/codex' },
    env: { value: { PATH: '/trusted/bin', HOME: '/synthetic-owner' } },
  });
  const manager = createProviderLoginManager({
    providerStatus: () => statusReady.promise,
    spawn: () => fakeChild(),
    cwd: '/fixed/scout',
  });
  const first = manager.startProviderLogin('codex', OWNER);
  await assert.rejects(
    manager.startProviderLogin('codex', OWNER),
    /login is already active/,
  );
  statusReady.resolve(status);
  const started = await first;
  assert.equal(started.state, 'starting');
});

test('manual codes reject excess length, control characters and unsupported providers', async () => {
  const h = harness({ provider: 'claude' });
  const started = await h.manager.startProviderLogin('claude', OWNER);
  h.login.stdout.write('Enter authorization code\n');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    h.manager.submitProviderLoginCode(started.sessionId, 'A'.repeat(257), OWNER),
    /manual code is invalid/,
  );
  await assert.rejects(
    h.manager.submitProviderLoginCode(started.sessionId, 'abc\nxyz', OWNER),
    /manual code is invalid/,
  );
  await assert.rejects(
    h.manager.startProviderLogin('other', OWNER),
    /unsupported provider/,
  );
});

test('repeated invalid manual-code attempts terminate the session', async () => {
  const h = harness({ provider: 'claude' });
  const started = await h.manager.startProviderLogin('claude', OWNER);
  h.login.stdout.write('Enter authorization code\n');
  await new Promise((resolve) => setImmediate(resolve));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      h.manager.submitProviderLoginCode(started.sessionId, '\n', OWNER),
      /manual code is invalid/,
    );
  }
  await assert.rejects(
    h.manager.submitProviderLoginCode(started.sessionId, '\n', OWNER),
    /manual code attempt limit/,
  );
  const terminal = h.manager.getProviderLoginSession(started.sessionId, OWNER);
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.reasonCode, 'code-attempt-limit');
  assert.equal(h.login.killed, true);
});

test('Claude credential clearing is an explicit owner-only fixed logout operation', async () => {
  const h = harness({ provider: 'claude' });
  const pending = h.manager.clearClaudeCredentials({
    ...OWNER,
    csrfVerified: false,
  });
  await assert.rejects(pending, /verified owner context/);

  const clearing = h.manager.clearClaudeCredentials(OWNER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls[0], {
    command: '/trusted/bin/claude',
    args: ['auth', 'logout'],
    options: {
      cwd: '/fixed/scout',
      env: { PATH: '/trusted/bin', HOME: '/synthetic-owner' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: undefined,
    },
  });
  h.login.stdout.write('Logged out private@example.test token=secret\n');
  h.login.close(0);
  assert.deepEqual(await clearing, {
    provider: 'claude',
    reasonCode: null,
    state: 'cleared',
  });
  assert.deepEqual(h.health.at(-1), [
    'claude',
    { kind: 'local-signed-out', source: 'post-auth' },
  ]);
});

test('Claude login cannot start while credential clearing owns the provider', async () => {
  const h = harness({ provider: 'claude' });
  const clearing = h.manager.clearClaudeCredentials(OWNER);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    h.manager.startProviderLogin('claude', OWNER),
    /already active/,
  );
  assert.equal(h.calls.length, 1);
  h.login.close(0);
  await clearing;
});

test('Claude clear response waits for its durable terminal health transition', async () => {
  const persisted = deferred();
  const h = harness({
    provider: 'claude',
    onHealthSignal: async (_provider, signal) => {
      if (signal.kind === 'local-signed-out') await persisted.promise;
    },
  });
  const clearing = h.manager.clearClaudeCredentials(OWNER);
  await new Promise((resolve) => setImmediate(resolve));
  h.login.close(0);
  let settled = false;
  clearing.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  persisted.resolve();
  assert.equal((await clearing).state, 'cleared');
});

test('output, line, timeout, cancellation, disconnect and shutdown paths terminate safely', async (t) => {
  await t.test('aggregate output limit', async () => {
    const h = harness({ maxOutputBytes: 16 });
    const started = await h.manager.startProviderLogin('codex', OWNER);
    h.login.stdout.write('x'.repeat(17));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.login.killed, true);
    assert.equal(
      h.manager.getProviderLoginSession(started.sessionId, OWNER).reasonCode,
      'output-limit',
    );
  });

  await t.test('line count limit', async () => {
    const h = harness({ maxOutputLines: 2 });
    const started = await h.manager.startProviderLogin('codex', OWNER);
    h.login.stdout.write('one\ntwo\nthree\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.login.killed, true);
    assert.equal(
      h.manager.getProviderLoginSession(started.sessionId, OWNER).reasonCode,
      'output-limit',
    );
  });

  await t.test('individual line limit', async () => {
    const h = harness({ maxLineBytes: 8 });
    const started = await h.manager.startProviderLogin('codex', OWNER);
    h.login.stdout.write('123456789');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.login.killed, true);
    assert.equal(
      h.manager.getProviderLoginSession(started.sessionId, OWNER).reasonCode,
      'output-limit',
    );
  });

  await t.test('timeout', async () => {
    const h = harness({ timeoutMs: 10 });
    const started = await h.manager.startProviderLogin('codex', OWNER);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.login.killed, true);
    assert.equal(
      h.manager.getProviderLoginSession(started.sessionId, OWNER).reasonCode,
      'expired',
    );
  });

  await t.test('explicit cancel', async () => {
    const h = harness();
    const started = await h.manager.startProviderLogin('codex', OWNER);
    const result = await h.manager.cancelProviderLogin(started.sessionId, OWNER);
    assert.equal(result.state, 'cancelled');
    assert.equal(h.login.killed, true);
  });

  await t.test('cancel waits for close and escalates TERM to KILL within a bound', async () => {
    const h = harness({
      closeOnKill: false,
      terminateGraceMs: 5,
      shutdownDeadlineMs: 20,
    });
    const started = await h.manager.startProviderLogin('codex', OWNER);
    let settled = false;
    const cancelled = h.manager.cancelProviderLogin(started.sessionId, OWNER)
      .then((value) => {
        settled = true;
        return value;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(h.login.killSignals, ['SIGTERM']);
    const result = await cancelled;
    assert.equal(result.state, 'cancelled');
    assert.deepEqual(h.login.killSignals, ['SIGTERM', 'SIGKILL']);
  });

  await t.test('shutdown gives a previously stubborn child a fresh bounded close wait', async () => {
    const h = harness({
      closeOnKill: false,
      terminateGraceMs: 5,
      shutdownDeadlineMs: 20,
    });
    const started = await h.manager.startProviderLogin('codex', OWNER);
    await h.manager.cancelProviderLogin(started.sessionId, OWNER);
    let stopped = false;
    const shutdown = h.manager.shutdown().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    h.login.close(null);
    await shutdown;
    assert.equal(stopped, true);
  });

  await t.test('child error', async () => {
    const h = harness();
    const started = await h.manager.startProviderLogin('codex', OWNER);
    h.login.emit('error', new Error('private path and token'));
    await new Promise((resolve) => setImmediate(resolve));
    const result = h.manager.getProviderLoginSession(started.sessionId, OWNER);
    assert.equal(result.state, 'failed');
    assert.equal(result.reasonCode, 'process-start-failed');
    assert.equal(JSON.stringify(result).includes('private path'), false);
  });

  await t.test('owner disconnect', async () => {
    const h = harness();
    const started = await h.manager.startProviderLogin('codex', OWNER);
    await h.manager.disconnectOwner(OWNER);
    assert.equal(
      h.manager.getProviderLoginSession(started.sessionId, OWNER).state,
      'cancelled',
    );
    assert.equal(h.login.killed, true);
  });

  await t.test('actual child disconnect is terminal and cleaned up', async () => {
    const h = harness();
    const started = await h.manager.startProviderLogin('codex', OWNER);
    h.login.emit('disconnect');
    await new Promise((resolve) => setImmediate(resolve));
    const result = h.manager.getProviderLoginSession(started.sessionId, OWNER);
    assert.equal(result.state, 'failed');
    assert.equal(result.reasonCode, 'process-disconnected');
    assert.equal(h.login.killed, true);
  });

  await t.test('shutdown', async () => {
    const h = harness();
    const started = await h.manager.startProviderLogin('codex', OWNER);
    await h.manager.shutdown();
    assert.equal(
      h.manager.getProviderLoginSession(started.sessionId, OWNER).state,
      'cancelled',
    );
    assert.equal(h.login.killed, true);
    await assert.rejects(
      h.manager.startProviderLogin('codex', OWNER),
      /shutting down/,
    );
  });
});

test('shutdown tracks login and explicit Claude-clear children until both close', async () => {
  const login = fakeChild({ closeOnKill: false });
  const clear = fakeChild({ closeOnKill: false });
  const children = [login, clear];
  const manager = createProviderLoginManager({
    providerStatus: async (provider) => {
      const status = { installed: true, authenticated: false };
      Object.defineProperties(status, {
        executable: { value: `/trusted/bin/${provider}` },
        env: { value: { PATH: '/trusted/bin', HOME: '/synthetic-owner' } },
      });
      return status;
    },
    spawn: () => children.shift(),
    canClearClaudeCredentials: async () => true,
    terminateGraceMs: 50,
    shutdownDeadlineMs: 200,
    timeoutMs: 60_000,
  });
  await manager.startProviderLogin('codex', OWNER);
  const clearing = manager.clearClaudeCredentials(OWNER);
  await new Promise((resolve) => setImmediate(resolve));

  let stopped = false;
  const shutdown = manager.shutdown().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  login.close(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  clear.close(null);
  await shutdown;
  assert.equal(stopped, true);
  await clearing;
});

test('shutdown forcibly settles a stubborn Claude-clear operation at its final deadline', async () => {
  const clear = fakeChild({ closeOnKill: false });
  const manager = createProviderLoginManager({
    providerStatus: async () => {
      const status = { installed: true, authenticated: false };
      Object.defineProperties(status, {
        executable: { value: '/trusted/bin/claude' },
        env: { value: { PATH: '/trusted/bin', HOME: '/synthetic-owner' } },
      });
      return status;
    },
    spawn: () => clear,
    canClearClaudeCredentials: async () => true,
    terminateGraceMs: 5,
    shutdownDeadlineMs: 20,
    timeoutMs: 60_000,
  });
  const clearing = manager.clearClaudeCredentials(OWNER);
  await new Promise((resolve) => setImmediate(resolve));
  await manager.shutdown();
  const raced = await Promise.race([
    clearing,
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 30)),
  ]);
  clear.close(null);
  await clearing;
  assert.deepEqual(raced, {
    provider: 'claude',
    reasonCode: 'logout-failed',
    state: 'failed',
  });
});

test('Codex device-code parsing rejects token-shaped output', async () => {
  const h = harness();
  const started = await h.manager.startProviderLogin('codex', OWNER);
  h.login.stdout.write('Use code TOKN-SECR from token output\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.manager.getProviderLoginSession(started.sessionId, OWNER).userCode,
    null,
  );
  h.login.stdout.write('Enter code ABCD-EFGH\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.manager.getProviderLoginSession(started.sessionId, OWNER).userCode,
    'ABCD-EFGH',
  );
});

test('failed validation is terminal, redacted and signals signed-out health', async () => {
  const h = harness();
  const started = await h.manager.startProviderLogin('codex', OWNER);
  h.login.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  h.validation.stderr.write('token=secret account=private@example.test\n');
  h.validation.close(1);
  await new Promise((resolve) => setImmediate(resolve));
  const result = h.manager.getProviderLoginSession(started.sessionId, OWNER);
  assert.equal(result.state, 'failed');
  assert.equal(result.reasonCode, 'validation-failed');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  assert.deepEqual(h.health.at(-1), [
    'codex',
    { kind: 'local-signed-out', source: 'post-auth' },
  ]);
});

test('success waits for a real health confirmation and its durable write', async () => {
  const confirmed = deferred();
  const persisted = deferred();
  const h = harness({
    confirmProviderHealth: async () => confirmed.promise,
    onHealthSignal: async (_provider, signal) => {
      if (signal.kind === 'remote-success') await persisted.promise;
    },
  });
  const started = await h.manager.startProviderLogin('codex', OWNER);
  h.login.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  h.validation.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.manager.getProviderLoginSession(started.sessionId, OWNER).state,
    'validating',
  );

  confirmed.resolve({ kind: 'remote-success', source: 'post-auth' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.manager.getProviderLoginSession(started.sessionId, OWNER).state,
    'validating',
  );

  persisted.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    h.manager.getProviderLoginSession(started.sessionId, OWNER).state,
    'succeeded',
  );
});

test('cancel stops and closes an in-flight confirmation before any late health write', async () => {
  const result = deferred();
  const closure = deferred();
  let stopped = 0;
  result.promise.stop = () => {
    stopped += 1;
    result.resolve({ kind: 'remote-success', source: 'post-auth' });
    closure.resolve();
  };
  result.promise.closed = closure.promise;
  const h = harness({ confirmProviderHealth: () => result.promise });
  const started = await h.manager.startProviderLogin('codex', OWNER);
  h.login.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  h.validation.close(0);
  await new Promise((resolve) => setImmediate(resolve));

  const cancelled = await h.manager.cancelProviderLogin(started.sessionId, OWNER);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(stopped, 1);
  assert.equal(h.health.some(([, signal]) => signal.kind === 'remote-success'), false);
});

test('cancel response waits for its terminal health transition', async () => {
  const persisted = deferred();
  const h = harness({
    onHealthSignal: async (_provider, signal) => {
      if (signal.kind === 'provider-failure') await persisted.promise;
    },
  });
  const started = await h.manager.startProviderLogin('codex', OWNER);
  let settled = false;
  const cancellation = h.manager.cancelProviderLogin(started.sessionId, OWNER)
    .then((value) => {
      settled = true;
      return value;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  persisted.resolve();
  assert.equal((await cancellation).state, 'cancelled');
});

test('failed real health confirmation remains terminal without false ready evidence', async () => {
  const h = harness({
    confirmProviderHealth: async () => ({ kind: 'network-failure', source: 'post-auth' }),
  });
  const started = await h.manager.startProviderLogin('codex', OWNER);
  h.login.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  h.validation.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  const result = h.manager.getProviderLoginSession(started.sessionId, OWNER);
  assert.equal(result.state, 'failed');
  assert.equal(result.reasonCode, 'health-confirmation-failed');
  assert.deepEqual(h.health.at(-1), [
    'codex',
    { kind: 'network-failure', source: 'post-auth' },
  ]);
});

test('only a real Claude remote-auth failure enables explicit credential clearing', async () => {
  const h = harness({
    provider: 'claude',
    childCount: 3,
    canClearClaudeCredentials: async () => false,
    confirmProviderHealth: async () => ({
      kind: 'remote-auth-failure',
      source: 'post-auth',
    }),
  });
  const started = await h.manager.startProviderLogin('claude', OWNER);
  h.login.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  h.validation.close(0);
  await new Promise((resolve) => setImmediate(resolve));
  const failed = h.manager.getProviderLoginSession(started.sessionId, OWNER);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reasonCode, 'credentials-expired');

  const clearing = h.manager.clearClaudeCredentials(OWNER);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.at(-1).args, ['auth', 'logout']);
  assert.equal(h.calls.length, 3);
  h.children[2].close(0);
  assert.equal((await clearing).state, 'cleared');
});

test('Claude clear rejects absent expired-credential evidence and bounds full lines', async () => {
  const denied = harness({
    provider: 'claude',
    canClearClaudeCredentials: async () => false,
  });
  await assert.rejects(
    denied.manager.clearClaudeCredentials(OWNER),
    /expired Claude credentials/,
  );

  const h = harness({
    provider: 'claude',
    maxLineBytes: 8,
    canClearClaudeCredentials: async () => true,
  });
  const clearing = h.manager.clearClaudeCredentials(OWNER);
  await new Promise((resolve) => setImmediate(resolve));
  h.login.stdout.write(`${'x'.repeat(9)}\n`);
  const result = await clearing;
  assert.equal(result.state, 'failed');
  assert.equal(result.reasonCode, 'logout-failed');
  assert.equal(h.login.killed, true);
});

test('spawn failures, untrusted status and nonzero login exits expose no raw diagnostics', async () => {
  const baseStatus = {
    installed: true,
    authenticated: false,
  };
  await assert.rejects(
    createProviderLoginManager({
      providerStatus: async () => baseStatus,
    }).startProviderLogin('codex', OWNER),
    /trusted provider executable/,
  );

  const errorManager = createProviderLoginManager({
    providerStatus: async () => {
      const status = { installed: true, authenticated: false };
      Object.defineProperty(status, 'executable', { value: '/trusted/bin/codex' });
      return status;
    },
    spawn() {
      throw new Error('spawn leaked /private/path token=secret');
    },
  });
  const failed = await errorManager.startProviderLogin('codex', OWNER);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.reasonCode, 'process-start-failed');
  assert.equal(JSON.stringify(failed).includes('/private/path'), false);

  const h = harness();
  const started = await h.manager.startProviderLogin('codex', OWNER);
  h.login.stderr.write('private@example.test token=secret\n');
  h.login.close(2);
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = h.manager.getProviderLoginSession(started.sessionId, OWNER);
  assert.equal(terminal.reasonCode, 'login-failed');
  assert.equal(JSON.stringify(terminal).includes('private@example.test'), false);
});

test('no session secret, raw output or manual code is persisted or returned', async () => {
  const h = harness({ provider: 'claude' });
  const started = await h.manager.startProviderLogin('claude', OWNER);
  h.login.stdout.write('Paste authorization code: token=raw-secret\n');
  await new Promise((resolve) => setImmediate(resolve));
  await h.manager.submitProviderLoginCode(started.sessionId, 'PRIVATE-CODE', OWNER);
  const snapshot = h.manager.getProviderLoginSession(started.sessionId, OWNER);
  const encoded = JSON.stringify(snapshot);
  assert.equal(encoded.includes('raw-secret'), false);
  assert.equal(encoded.includes('PRIVATE-CODE'), false);
  assert.equal('output' in snapshot, false);
  assert.equal('ownerId' in snapshot, false);
});
