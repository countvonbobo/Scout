import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  assertSafeModel,
  commandInvocation,
  codexModelCatalogueStatus,
  createProviderDetector,
  createProviderModelCatalogueDetector,
  providerEnvironment,
  providerCandidates,
  providerCommand,
  providerHealthSignal,
  providerFailureClassification,
  providerLocalHealthSignal,
  providerRemoteHealthSignal,
  providerStatus,
  providerStatusAsync,
  runProviderCommand,
} from './providers.mjs';

const windowsHome = (name) => ['C:', 'Users', name].join('\\');
const unixHome = (root, name) => ['', root, name].join('/');
const WINDOWS_EXAMPLE_HOME = windowsHome('example');
const WINDOWS_QA_HOME = windowsHome('ScoutQA');
const MAC_EXAMPLE_HOME = unixHome('Users', 'example');
const LINUX_EXAMPLE_HOME = unixHome('home', 'example');

test('provider commands allow Windows resolution to choose native executables or cmd shims', () => {
  assert.equal(providerCommand('codex', 'win32'), 'codex.cmd');
  assert.equal(providerCommand('claude', 'linux'), 'claude');
});

test('provider status distinguishes install and authentication', () => {
  const calls = [];
  const spawn = (command, args) => { calls.push([command, args]); return { status: calls.length === 1 ? 0 : 1, stdout: '1.2.3', stderr: 'not logged in' }; };
  const result = providerStatus('codex', { spawn, platform: 'linux' });
  assert.equal(result.installed, true);
  assert.equal(result.authenticated, false);
  assert.deepEqual(calls[1][1], ['login', 'status']);
});

test('async provider status does not block the event loop', async () => {
  let timerFired = false;
  const run = async (command, args) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (args.includes('--version')) return { status: 0, stdout: '1.2.3', stderr: '' };
    if (args[0] === 'login') return { status: 0, stdout: 'logged in', stderr: '' };
    return { status: 0, stdout: '--output-schema', stderr: '' };
  };
  const pending = providerStatusAsync('codex', { run, platform: 'linux', resolve: () => 'codex', exists: () => false });
  setTimeout(() => { timerFired = true; }, 5);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(timerFired, true);
  const result = await pending;
  assert.equal(result.authenticated, true);
  assert.equal(result.capabilities.structuredOutput, true);
});

test('provider command timeout escalates and settles even when close never arrives', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killSignals.push(signal);
    return true;
  };
  const started = Date.now();
  const result = await runProviderCommand('synthetic-provider', ['--version'], {
    timeoutMs: 10,
    terminateGraceMs: 10,
    closeDeadlineMs: 40,
    spawn: () => child,
    platform: 'linux',
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
  assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 500);
});

test('provider detector shares an in-flight probe and caches the result briefly', async () => {
  let calls = 0;
  let clock = 1_000;
  const detector = createProviderDetector({
    ttlMs: 100,
    now: () => clock,
    status: async (provider) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { provider, installed: true, authenticated: true };
    },
  });
  const [first, shared] = await Promise.all([detector(), detector()]);
  assert.equal(calls, 2);
  assert.deepEqual(shared, first);
  assert.equal(await detector(), first);
  assert.equal(calls, 2);
  clock += 101;
  await detector();
  assert.equal(calls, 4);
});

test('Windows provider environment includes standard Codex and Claude install locations', () => {
  const env = providerEnvironment({
    USERPROFILE: WINDOWS_EXAMPLE_HOME,
    APPDATA: `${WINDOWS_EXAMPLE_HOME}\\AppData\\Roaming`,
    Path: 'C:\\Windows\\System32',
  }, 'win32');
  assert.ok(env.Path.toLowerCase().includes(`${WINDOWS_EXAMPLE_HOME}\\AppData\\Roaming\\npm`.toLowerCase()));
  assert.match(env.Path, /C:\\Program Files\\nodejs/i);
  assert.ok(env.Path.toLowerCase().includes(`${WINDOWS_EXAMPLE_HOME}\\.local\\bin`.toLowerCase()));
  assert.match(env.Path, /C:\\Windows\\System32/i);
});

test('Codex candidates include the official OpenAI Windows installation', () => {
  const candidates = providerCandidates('codex', {
    platform: 'win32',
    env: { USERPROFILE: windowsHome('Oli'), LOCALAPPDATA: `${windowsHome('Oli')}\\AppData\\Local`, APPDATA: `${windowsHome('Oli')}\\AppData\\Roaming`, Path: '' },
    exists: (candidate) => candidate.endsWith('Programs\\OpenAI\\Codex\\bin\\codex.exe'),
    resolve: () => 'codex.cmd',
  });
  assert.equal(candidates[0], `${windowsHome('Oli')}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`);
});

test('macOS and Linux candidates include user-local and standalone installs before PATH fallback', () => {
  for (const platform of ['darwin', 'linux']) {
    const candidates = providerCandidates('codex', {
      platform, env: { HOME: LINUX_EXAMPLE_HOME, PATH: '' },
      exists: (candidate) => candidate === `${LINUX_EXAMPLE_HOME}/.local/bin/codex` || candidate === `${LINUX_EXAMPLE_HOME}/.codex/bin/codex`,
      resolve: () => 'codex',
    });
    assert.deepEqual(candidates, [`${LINUX_EXAMPLE_HOME}/.local/bin/codex`, `${LINUX_EXAMPLE_HOME}/.codex/bin/codex`, 'codex']);
  }
});

test('Unix provider status redacts the home directory with a native-looking path', () => {
  const result = providerStatus('codex', {
    platform: 'darwin',
    env: { HOME: MAC_EXAMPLE_HOME, PATH: '' },
    exists: (candidate) => candidate === `${MAC_EXAMPLE_HOME}/.local/bin/codex`,
    resolve: () => null,
    spawn: (command, args) => ({
      status: 0,
      stdout: args.includes('--version') ? 'codex-cli 1.0' : args[0] === 'exec' ? '--output-schema' : 'Logged in',
      stderr: '',
    }),
  });
  assert.equal(result.source, '~/.local/bin/codex');
});

test('provider status exposes bounded structured-output compatibility', () => {
  const spawn = (command, args) => {
    if (args.includes('--version')) return { status: 0, stdout: '2.1.205' };
    if (args[0] === 'auth') return { status: 0, stdout: 'logged in' };
    return { status: 0, stdout: '--json-schema --no-session-persistence' };
  };
  const compatible = providerStatus('claude', { spawn, platform: 'linux' });
  assert.equal(compatible.authenticated, true);
  assert.equal(compatible.capabilities.structuredOutput, true);

  const old = providerStatus('claude', {
    spawn: (command, args) => args.includes('--version') || args[0] === 'auth'
      ? { status: 0, stdout: 'old' } : { status: 0, stdout: '--print only' },
    platform: 'linux',
  });
  assert.equal(old.authenticated, true);
  assert.equal(old.capabilities.structuredOutput, false);
});

test('Windows provider candidates tolerate lowercase packaged-runtime environment keys', () => {
  const candidates = providerCandidates('codex', {
    platform: 'win32',
    env: { userprofile: WINDOWS_QA_HOME, localappdata: `${WINDOWS_QA_HOME}\\AppData\\Local`, path: '' },
    exists: (candidate) => candidate.toLowerCase().endsWith('programs\\openai\\codex\\bin\\codex.exe'),
    resolve: () => null,
  });
  assert.equal(candidates[0], `${WINDOWS_QA_HOME}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`);
});

test('Windows provider candidates recover the user home from LocalAppData', () => {
  const candidates = providerCandidates('claude', {
    platform: 'win32',
    env: { LOCALAPPDATA: `${WINDOWS_QA_HOME}\\AppData\\Local`, Path: '' },
    exists: (candidate) => candidate.toLowerCase().endsWith('.local\\bin\\claude.exe'),
    resolve: () => null,
  });
  assert.equal(candidates[0], `${WINDOWS_QA_HOME}\\.local\\bin\\claude.exe`);
});

test('packaged Scout derives LocalAppData from its own runtime path', () => {
  const candidates = providerCandidates('codex', {
    platform: 'win32',
    env: { Path: '' },
    runtimePath: `${WINDOWS_QA_HOME}\\AppData\\Local\\Programs\\Scout\\runtime\\ScoutRuntime.exe`,
    exists: () => false,
    resolve: () => null,
  });
  assert.equal(candidates[0], `${WINDOWS_QA_HOME}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`);
});

test('packaged Scout gives provider turns the interactive user home', () => {
  const env = providerEnvironment(
    { Path: 'C:\\Windows\\System32' },
    'win32',
    `${WINDOWS_QA_HOME}\\AppData\\Local\\Programs\\Scout\\runtime\\ScoutRuntime.exe`,
  );
  assert.equal(env.USERPROFILE, WINDOWS_QA_HOME);
  assert.equal(env.HOME, WINDOWS_QA_HOME);
  assert.equal(env.LOCALAPPDATA, `${WINDOWS_QA_HOME}\\AppData\\Local`);
  assert.equal(env.APPDATA, `${WINDOWS_QA_HOME}\\AppData\\Roaming`);
  assert.ok(env.Path.toLowerCase().includes(`${WINDOWS_QA_HOME}\\.local\\bin`.toLowerCase()));
});

test('provider checks receive the augmented environment', () => {
  const calls = [];
  const spawn = (command, args, options) => { calls.push(options); return { status: 0, stdout: 'ok', stderr: '' }; };
  providerStatus('codex', {
    spawn, platform: 'win32',
    env: { USERPROFILE: WINDOWS_EXAMPLE_HOME, APPDATA: `${WINDOWS_EXAMPLE_HOME}\\AppData\\Roaming`, Path: 'C:\\Windows\\System32' },
    resolve: (command, options) => { assert.match(options.env.Path, /AppData\\Roaming\\npm/i); return 'codex.exe'; },
  });
  assert.match(calls[0].env.Path, /AppData\\Roaming\\npm/i);
  assert.match(calls[1].env.Path, /\.local\\bin/i);
});

test('Windows provider status uses a resolved native executable directly', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push([command, args, options]);
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const result = providerStatus('claude', {
    spawn,
    platform: 'win32',
    env: { USERPROFILE: WINDOWS_EXAMPLE_HOME, APPDATA: `${WINDOWS_EXAMPLE_HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${WINDOWS_EXAMPLE_HOME}\\AppData\\Local`, Path: 'C:\\Windows\\System32' },
    exists: () => false,
    resolve: () => `${WINDOWS_EXAMPLE_HOME}\\.local\\bin\\claude.exe`,
  });
  assert.equal(result.installed, true);
  assert.equal(result.authenticated, true);
  assert.equal(calls[0][0], `${WINDOWS_EXAMPLE_HOME}\\.local\\bin\\claude.exe`);
  assert.equal(calls[0][2].shell, false);
});

test('provider status does not expose authenticated account metadata', () => {
  let call = 0;
  const spawn = () => (++call === 1
    ? { status: 0, stdout: '1.2.3', stderr: '' }
    : { status: 0, stdout: '{"loggedIn":true,"email":"person@example.test"}', stderr: '' });
  const result = providerStatus('claude', { spawn, platform: 'linux' });
  assert.equal(result.authMessage, 'Logged in');
  assert.doesNotMatch(JSON.stringify(result), /person@example\.test/);
  assert.doesNotMatch(JSON.stringify(result), /USERPROFILE|ComSpec|SystemRoot/);
});

test('Windows cmd shims use cmd.exe without enabling a Node shell', () => {
  const invocation = commandInvocation('codex', ['exec', 'value & literal'], {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    resolve: () => 'C:\\Program Files\\npm\\codex.cmd',
  });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.shell, false);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(invocation.args[3], /^""C:\\Program Files\\npm\\codex\.cmd"/);
  assert.match(invocation.args[3], /"value \^& literal""$/);
});

test('model overrides reject shell metacharacters', () => {
  assert.equal(assertSafeModel('gpt-example-1'), 'gpt-example-1');
  assert.throws(() => assertSafeModel('model & calc'), /invalid model/);
  assert.throws(() => assertSafeModel('x'.repeat(129)), /invalid model/);
});

test('Codex catalogue discovery uses fixed argv, shell false and bounded execution', async () => {
  const calls = [];
  const result = await codexModelCatalogueStatus({
    installed: true,
    authenticated: true,
    executable: '/synthetic/codex',
    env: { SYNTHETIC: '1' },
  }, {
    platform: 'linux',
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', is_default: true }] }),
        stderr: '',
      };
    },
  });
  assert.equal(result.state, 'refreshed');
  assert.deepEqual(result.models, [{ id: 'gpt-5.6-sol', isDefault: true }]);
  assert.deepEqual(calls[0].args, ['debug', 'models']);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeoutMs <= 10_000);
  assert.ok(calls[0].options.maxOutputBytes <= 524_288);
});

test('unsupported, malformed, oversized and timed-out catalogues fail closed without raw output', async () => {
  const status = {
    installed: true,
    authenticated: true,
    executable: `${MAC_EXAMPLE_HOME}/.local/bin/codex`,
    env: {},
  };
  const cases = [
    { status: 2, stdout: '', stderr: 'unknown command person@example.test token=secret' },
    { status: 0, stdout: '{', stderr: `${MAC_EXAMPLE_HOME}/.codex` },
    { status: 0, stdout: 'x'.repeat(600_000), stderr: 'oversized secret' },
    { status: null, stdout: '', stderr: `timed out ${MAC_EXAMPLE_HOME}`, timedOut: true },
  ];
  for (const synthetic of cases) {
    const result = await codexModelCatalogueStatus(status, { run: async () => synthetic });
    assert.ok(['unsupported', 'failed'].includes(result.state));
    assert.deepEqual(result.models, []);
    assert.doesNotMatch(JSON.stringify(result), /person@|Users|token|secret|stderr|stdout/);
  }
});

test('provider catalogue discovery caches a refresh and expires explicitly', async () => {
  let clock = 1_000;
  let detects = 0;
  let catalogues = 0;
  const discover = createProviderModelCatalogueDetector({
    now: () => clock,
    ttlMs: 500,
    detect: async () => {
      detects += 1;
      return { codex: { installed: true, authenticated: true, executable: '/synthetic/codex' } };
    },
    catalogue: async () => {
      catalogues += 1;
      return { state: 'refreshed', reasonCode: null, models: [{ id: 'gpt-5.6-sol' }] };
    },
  });

  const first = await discover();
  assert.equal(await discover(), first);
  assert.equal(detects, 1);
  assert.equal(catalogues, 1);

  clock = 1_501;
  assert.notEqual(await discover(), first);
  assert.equal(detects, 2);
  assert.equal(catalogues, 2);
});

test('local provider status becomes a bounded privacy-safe health signal', () => {
  const signal = providerLocalHealthSignal({
    provider: 'codex',
    installed: true,
    authenticated: true,
    version: 'codex-cli 1.2.3 person@example.test',
    authMessage: 'Logged in as person@example.test',
    executable: `${MAC_EXAMPLE_HOME}/.local/bin/codex`,
    env: { TOKEN: 'secret' },
    attempts: [{ source: `${MAC_EXAMPLE_HOME}/.local/bin/codex`, result: 'authenticated' }],
  });

  assert.deepEqual(signal, {
    kind: 'local-credentials-present',
    source: 'provider-operation',
  });
  assert.doesNotMatch(JSON.stringify(signal), /person@|Users|TOKEN|secret|version|attempts|executable|authMessage/);
  assert.deepEqual(providerLocalHealthSignal({
    installed: false,
    authenticated: false,
  }, { source: 'startup' }), {
    kind: 'provider-failure',
    source: 'startup',
    reasonCode: 'provider-error',
  });
  assert.deepEqual(providerLocalHealthSignal({
    installed: true,
    authenticated: true,
    capabilities: { structuredOutput: false },
  }, { source: 'manual-preflight' }), {
    kind: 'cli-update',
    source: 'manual-preflight',
    reasonCode: 'cli-update-required',
  });
});

test('remote provider responses become distinct bounded signals without response bodies', () => {
  const cases = [
    [{ ok: true, status: 204, body: 'private transcript' }, { kind: 'remote-success', source: 'provider-operation' }],
    [{ ok: false, status: 401, body: 'token=secret person@example.test' }, { kind: 'remote-auth-failure', source: 'provider-operation', reasonCode: 'authentication-required' }],
    [{ ok: false, status: 403 }, { kind: 'remote-auth-failure', source: 'provider-operation', reasonCode: 'authentication-required' }],
    [{ ok: false, status: 429 }, { kind: 'rate-limit', source: 'provider-operation', reasonCode: 'rate-limited' }],
    [{ ok: false, errorCode: 'ENETUNREACH', stderr: `${MAC_EXAMPLE_HOME} private` }, { kind: 'network-failure', source: 'provider-operation', reasonCode: 'network-unavailable' }],
    [{ ok: false, reasonCode: 'cli-update-required', stdout: 'download from private URL' }, { kind: 'cli-update', source: 'provider-operation', reasonCode: 'cli-update-required' }],
    [{ loginInProgress: true }, { kind: 'login-started', source: 'provider-operation' }],
    [{ checking: true }, { kind: 'check-started', source: 'provider-operation' }],
    [{ ok: false, status: 503, reasonCode: 'token-secret', body: 'provider account identity' }, { kind: 'provider-failure', source: 'provider-operation', reasonCode: 'provider-error' }],
  ];

  for (const [input, expected] of cases) {
    const signal = providerRemoteHealthSignal(input);
    assert.deepEqual(signal, expected);
    assert.doesNotMatch(JSON.stringify(signal), /private|person@|Users|token|stdout|stderr|body|status/);
  }
});

test('provider failure classification returns only allowlisted safe reason codes', () => {
  const cases = [
    [{ error: '403 forbidden token=secret' }, { reasonCode: 'authentication-required' }],
    [{ error: `connect ETIMEDOUT ${MAC_EXAMPLE_HOME}/private` }, { reasonCode: 'network-unavailable' }],
    [{ error: 'rate limit exceeded for person@example.test' }, { reasonCode: 'rate-limited' }],
    [{ error: 'please upgrade the CLI; unsupported --json-schema' }, { reasonCode: 'cli-update-required' }],
    [{ error: 'opaque provider failure token=secret' }, { reasonCode: 'provider-error' }],
  ];

  for (const [input, expected] of cases) {
    const classification = providerFailureClassification(input);
    assert.deepEqual(classification, expected);
    assert.doesNotMatch(JSON.stringify(classification), /secret|person@|Users|private|message|stdout|stderr|body/i);
  }
});

test('remote authentication failure outranks locally present credentials until remote success', () => {
  const local = {
    provider: 'claude',
    installed: true,
    authenticated: true,
    authMessage: 'Logged in',
  };
  assert.deepEqual(providerHealthSignal({ local, remote: { status: 401 } }), {
    kind: 'remote-auth-failure',
    source: 'provider-operation',
    reasonCode: 'authentication-required',
  });
  assert.deepEqual(providerHealthSignal({ local, remote: { ok: true, status: 200 } }), {
    kind: 'remote-success',
    source: 'provider-operation',
  });
  assert.deepEqual(providerHealthSignal({ local }), {
    kind: 'local-credentials-present',
    source: 'provider-operation',
  });
});
