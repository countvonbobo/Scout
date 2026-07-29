import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  commandInvocation,
  providerStatusAsync,
} from './providers.mjs';

const PROVIDERS = new Set(['codex', 'claude']);
const TERMINAL_STATES = new Set([
  'cancelled',
  'expired',
  'failed',
  'succeeded',
]);
const LOGIN_ARGUMENTS = Object.freeze({
  codex: Object.freeze(['login', '--device-auth']),
  claude: Object.freeze(['auth', 'login']),
});
const STATUS_ARGUMENTS = Object.freeze({
  codex: Object.freeze(['login', 'status']),
  claude: Object.freeze(['auth', 'status']),
});
const PUBLIC_FIELDS = Object.freeze([
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
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_RETENTION_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 256;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024;
const MANUAL_CODE = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{5,255}$/;
const ENV_ALLOWLIST = new Set([
  'appdata',
  'comspec',
  'home',
  'homedrive',
  'homepath',
  'http_proxy',
  'https_proxy',
  'localappdata',
  'no_proxy',
  'path',
  'pathext',
  'ssl_cert_dir',
  'ssl_cert_file',
  'systemroot',
  'temp',
  'tmp',
  'tmpdir',
  'userprofile',
  'xdg_config_home',
  'xdg_data_home',
]);

function checkedPositiveInteger(value, fallback, label) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return candidate;
}

function checkedOwner(ownerContext) {
  if (!ownerContext
    || typeof ownerContext !== 'object'
    || Array.isArray(ownerContext)
    || ownerContext.originVerified !== true
    || ownerContext.csrfVerified !== true
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(ownerContext.ownerId || ''))) {
    throw new TypeError('provider login requires a verified owner context');
  }
  return String(ownerContext.ownerId);
}

function checkedProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new TypeError('unsupported provider');
  return provider;
}

function checkedExecutable(status) {
  const executable = status?.executable;
  if (status?.installed !== true
    || typeof executable !== 'string'
    || executable.length < 1
    || executable.length > 4_096
    || /[\0\r\n]/.test(executable)) {
    throw new Error('provider status did not supply a trusted provider executable');
  }
  return executable;
}

function checkedManualCode(value) {
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > 256
    || !MANUAL_CODE.test(value)) {
    throw new TypeError('manual code is invalid');
  }
  return value;
}

function safeUrl(provider, value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2_048) {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    const allowed = provider === 'codex'
      ? hostname === 'openai.com' || hostname.endsWith('.openai.com')
      : hostname === 'anthropic.com'
        || hostname.endsWith('.anthropic.com')
        || hostname === 'claude.ai'
        || hostname.endsWith('.claude.ai');
    if (!allowed) return null;
    // Device verification queries can carry opaque transient state. The CLI
    // keeps that state; Scout exposes only the provider-owned destination.
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function minimalProviderEnvironment(source) {
  return Object.fromEntries(
    Object.entries(source || {}).filter(([key]) => ENV_ALLOWLIST.has(key.toLowerCase())),
  );
}

function parseSafeLoginLine(session, line) {
  if (session.provider === 'claude'
    && /\b(?:paste|enter|submit)\b.{0,80}\b(?:authorization|authentication|login)?\s*code\b/i.test(line)) {
    session.codeRequired = true;
    if (session.state === 'starting') session.state = 'awaiting-code';
  }

  const urlMatch = line.match(/https:\/\/[^\s<>"']{1,2048}/i);
  if (urlMatch) {
    const url = safeUrl(session.provider, urlMatch[0].replace(/[),.;]+$/, ''));
    if (url) session.verificationUrl = url;
  }

  if (session.provider === 'codex') {
    const codeMatch = line.match(/\b(?:enter|use)\s+(?:code\s+)?([A-Z0-9][A-Z0-9-]{5,63})\b/i);
    if (codeMatch) session.userCode = codeMatch[1];
  }
}

function publicSnapshot(session) {
  return Object.fromEntries(PUBLIC_FIELDS.map((field) => [field, session[field] ?? null]));
}

function ownerProviderKey(ownerId, provider) {
  return `${ownerId}\0${provider}`;
}

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createProviderLoginManager({
  providerStatus = providerStatusAsync,
  spawn = spawnProcess,
  onHealthSignal = async () => {},
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  now = Date.now,
  sessionId = randomUUID,
  timeoutMs: configuredTimeoutMs,
  rateWindowMs: configuredRateWindowMs,
  retentionMs: configuredRetentionMs,
  maxStarts: configuredMaxStarts,
  maxOutputBytes: configuredMaxOutputBytes,
  maxOutputLines: configuredMaxOutputLines,
  maxLineBytes: configuredMaxLineBytes,
} = {}) {
  const timeoutMs = checkedPositiveInteger(
    configuredTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    'provider login timeout',
  );
  const rateWindowMs = checkedPositiveInteger(
    configuredRateWindowMs,
    DEFAULT_RATE_WINDOW_MS,
    'provider login rate window',
  );
  const retentionMs = checkedPositiveInteger(
    configuredRetentionMs,
    DEFAULT_RETENTION_MS,
    'provider login retention',
  );
  const maxStarts = checkedPositiveInteger(
    configuredMaxStarts,
    3,
    'provider login start limit',
  );
  const maxOutputBytes = checkedPositiveInteger(
    configuredMaxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    'provider login output limit',
  );
  const maxOutputLines = checkedPositiveInteger(
    configuredMaxOutputLines,
    DEFAULT_MAX_OUTPUT_LINES,
    'provider login line limit',
  );
  const maxLineBytes = checkedPositiveInteger(
    configuredMaxLineBytes,
    DEFAULT_MAX_LINE_BYTES,
    'provider login individual line limit',
  );

  const sessions = new Map();
  const active = new Map();
  const pendingStarts = new Set();
  const starts = new Map();
  const clearingOwners = new Set();
  let shuttingDown = false;

  function emitHealth(session, signal) {
    try {
      Promise.resolve(onHealthSignal(session.provider, signal, {
        ownerId: session.ownerId,
      })).catch(() => {});
    } catch {
      // Health persistence is deliberately unable to leak provider output or
      // keep a completed authentication subprocess alive.
    }
  }

  function stopProcess(session) {
    const child = session.process;
    session.process = null;
    if (!child) return;
    let closed = false;
    child.once?.('close', () => { closed = true; });
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const hardStop = setTimeout(() => {
      try {
        if (!closed) child.kill('SIGKILL');
      } catch {
        // The child already exited or the platform refused a redundant kill.
      }
    }, 1_000);
    hardStop.unref?.();
  }

  function terminalHealth(reasonCode, state) {
    if (state === 'succeeded') {
      // A successful fixed provider status check is the post-auth remote
      // evidence that may clear provider health's sticky auth barrier.
      return { kind: 'remote-success', source: 'post-auth' };
    }
    if (reasonCode === 'validation-failed'
      || reasonCode === 'cancelled'
      || reasonCode === 'expired') {
      return { kind: 'local-signed-out', source: 'post-auth' };
    }
    return { kind: 'provider-failure', source: 'post-auth' };
  }

  function terminal(session, state, reasonCode, { kill = false } = {}) {
    if (TERMINAL_STATES.has(session.state)) return;
    if (kill) stopProcess(session);
    clearTimeout(session.timeout);
    session.timeout = null;
    session.state = state;
    session.reasonCode = reasonCode;
    active.delete(ownerProviderKey(session.ownerId, session.provider));
    emitHealth(session, terminalHealth(reasonCode, state));
    const retention = setTimeout(() => {
      if (sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
    }, retentionMs);
    retention.unref?.();
  }

  function failOutput(session) {
    terminal(session, 'failed', 'output-limit', { kill: true });
  }

  function collectOutput(session, stream, chunk) {
    if (TERMINAL_STATES.has(session.state)) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    session.outputBytes += data.length;
    if (session.outputBytes > maxOutputBytes) {
      failOutput(session);
      return;
    }
    session.buffers[stream] += data.toString('utf8');
    if (Buffer.byteLength(session.buffers[stream], 'utf8') > maxLineBytes
      && !session.buffers[stream].includes('\n')) {
      failOutput(session);
      return;
    }
    let newline = session.buffers[stream].indexOf('\n');
    while (newline >= 0 && !TERMINAL_STATES.has(session.state)) {
      const line = session.buffers[stream].slice(0, newline).replace(/\r$/, '');
      session.buffers[stream] = session.buffers[stream].slice(newline + 1);
      session.outputLines += 1;
      if (session.outputLines > maxOutputLines
        || Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        failOutput(session);
        return;
      }
      parseSafeLoginLine(session, line);
      newline = session.buffers[stream].indexOf('\n');
    }
    if (Buffer.byteLength(session.buffers[stream], 'utf8') > maxLineBytes) {
      failOutput(session);
      return;
    }
    // Interactive CLIs do not always newline-terminate their prompt.
    parseSafeLoginLine(session, session.buffers[stream]);
  }

  function spawnFixed(session, argumentsList, stdin) {
    const invocation = commandInvocation(session.executable, [...argumentsList], {
      platform,
      env: session.env,
      resolve: (value) => value,
    });
    return spawn(invocation.command, invocation.args, {
      cwd,
      env: session.env,
      shell: false,
      stdio: [stdin, 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
  }

  function monitorChild(session, child, phase) {
    session.process = child;
    child.stdout?.on('data', (chunk) => collectOutput(session, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => collectOutput(session, 'stderr', chunk));
    child.once('error', () => {
      terminal(session, 'failed', phase === 'login'
        ? 'process-start-failed'
        : 'validation-failed', { kill: true });
    });
    child.once('close', (status) => {
      if (TERMINAL_STATES.has(session.state)) return;
      session.process = null;
      if (phase === 'login') {
        if (status !== 0) {
          terminal(session, 'failed', 'login-failed');
          return;
        }
        beginValidation(session);
        return;
      }
      terminal(
        session,
        status === 0 ? 'succeeded' : 'failed',
        status === 0 ? null : 'validation-failed',
      );
    });
  }

  function beginValidation(session) {
    if (TERMINAL_STATES.has(session.state)) return;
    session.state = 'validating';
    session.codeRequired = false;
    session.buffers = { stdout: '', stderr: '' };
    let child;
    try {
      child = spawnFixed(session, STATUS_ARGUMENTS[session.provider], 'ignore');
    } catch {
      terminal(session, 'failed', 'validation-failed');
      return;
    }
    monitorChild(session, child, 'validation');
  }

  function sessionForOwner(sessionIdValue, ownerContext) {
    const ownerId = checkedOwner(ownerContext);
    const session = sessions.get(String(sessionIdValue || ''));
    if (!session || session.ownerId !== ownerId) {
      throw createError('provider login session is unavailable', 'LOGIN_SESSION_UNAVAILABLE');
    }
    return session;
  }

  function enforceRate(ownerId, provider) {
    const key = ownerProviderKey(ownerId, provider);
    const current = Number(now());
    const recent = (starts.get(key) || []).filter((at) => current - at < rateWindowMs);
    if (recent.length >= maxStarts) {
      throw createError('provider login start rate limit reached', 'LOGIN_RATE_LIMIT');
    }
    recent.push(current);
    starts.set(key, recent);
  }

  async function startProviderLogin(providerValue, ownerContext) {
    if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
    const provider = checkedProvider(providerValue);
    const ownerId = checkedOwner(ownerContext);
    const key = ownerProviderKey(ownerId, provider);
    const existing = active.get(key);
    if (pendingStarts.has(key) || (existing && !TERMINAL_STATES.has(existing.state))) {
      throw createError('provider login is already active', 'LOGIN_ALREADY_ACTIVE');
    }
    enforceRate(ownerId, provider);
    pendingStarts.add(key);
    try {
      const status = await providerStatus(provider);
      if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
      const executable = checkedExecutable(status);
      const createdAtMs = Number(now());
      const id = String(sessionId());
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(id) || sessions.has(id)) {
        throw new Error('provider login session identifier is invalid');
      }
      const session = {
        sessionId: id,
        provider,
        ownerId,
        state: 'starting',
        reasonCode: null,
        codeRequired: false,
        verificationUrl: null,
        userCode: null,
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + timeoutMs).toISOString(),
        executable,
        env: minimalProviderEnvironment(
          status.env && typeof status.env === 'object' ? status.env : env,
        ),
        process: null,
        outputBytes: 0,
        outputLines: 0,
        buffers: { stdout: '', stderr: '' },
        codeSubmitted: false,
        codeAttempts: 0,
        timeout: null,
      };
      sessions.set(id, session);
      active.set(key, session);
      session.timeout = setTimeout(() => {
        terminal(session, 'expired', 'expired', { kill: true });
      }, timeoutMs);
      session.timeout.unref?.();

      let child;
      try {
        child = spawnFixed(session, LOGIN_ARGUMENTS[provider], 'pipe');
      } catch {
        terminal(session, 'failed', 'process-start-failed');
        return publicSnapshot(session);
      }
      monitorChild(session, child, 'login');
      emitHealth(session, { kind: 'login-started', source: 'post-auth' });
      return publicSnapshot(session);
    } finally {
      pendingStarts.delete(key);
    }
  }

  async function submitProviderLoginCode(sessionIdValue, code, ownerContext) {
    const session = sessionForOwner(sessionIdValue, ownerContext);
    if (session.provider !== 'claude'
      || session.state !== 'awaiting-code'
      || session.codeRequired !== true
      || session.codeSubmitted
      || !session.process?.stdin?.writable) {
      throw createError(
        'provider login session is not awaiting a manual code',
        'LOGIN_CODE_NOT_EXPECTED',
      );
    }
    session.codeAttempts += 1;
    if (session.codeAttempts >= 3) {
      terminal(session, 'failed', 'code-attempt-limit', { kill: true });
      throw createError('provider login manual code attempt limit reached', 'LOGIN_CODE_RATE_LIMIT');
    }
    const boundedCode = checkedManualCode(code);
    session.codeSubmitted = true;
    session.codeRequired = false;
    session.state = 'authenticating';
    await new Promise((resolve, reject) => {
      session.process.stdin.write(`${boundedCode}\n`, (error) => {
        if (error) {
          terminal(session, 'failed', 'code-write-failed', { kill: true });
          reject(createError('manual code was not accepted', 'LOGIN_CODE_WRITE_FAILED'));
          return;
        }
        resolve();
      });
    });
    return publicSnapshot(session);
  }

  async function cancelProviderLogin(sessionIdValue, ownerContext) {
    const session = sessionForOwner(sessionIdValue, ownerContext);
    if (TERMINAL_STATES.has(session.state)) {
      throw createError('provider login session is already terminal', 'LOGIN_SESSION_TERMINAL');
    }
    terminal(session, 'cancelled', 'cancelled', { kill: true });
    return publicSnapshot(session);
  }

  async function clearClaudeCredentials(ownerContext) {
    if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
    const ownerId = checkedOwner(ownerContext);
    const activeKey = ownerProviderKey(ownerId, 'claude');
    if (active.has(activeKey) || pendingStarts.has(activeKey) || clearingOwners.has(ownerId)) {
      throw createError('provider login is already active', 'LOGIN_ALREADY_ACTIVE');
    }
    enforceRate(ownerId, 'claude-clear');
    clearingOwners.add(ownerId);
    const signalSession = { provider: 'claude', ownerId };
    try {
      const status = await providerStatus('claude');
      if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
      const executable = checkedExecutable(status);
      const environment = minimalProviderEnvironment(
        status.env && typeof status.env === 'object' ? status.env : env,
      );
      const invocation = commandInvocation(executable, ['auth', 'logout'], {
        platform,
        env: environment,
        resolve: (value) => value,
      });
      const state = await new Promise((resolve) => {
        let child;
        let settled = false;
        let bytes = 0;
        let lines = 0;
        let partial = { stdout: 0, stderr: 0 };
        const settle = (result, { kill = false } = {}) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (kill) {
            try { child?.kill('SIGTERM'); } catch {}
          }
          resolve(result);
        };
        try {
          child = spawn(invocation.command, invocation.args, {
            cwd,
            env: environment,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            windowsVerbatimArguments: invocation.windowsVerbatimArguments,
          });
        } catch {
          resolve('failed');
          return;
        }
        const timer = setTimeout(() => settle('failed', { kill: true }), timeoutMs);
        timer.unref?.();
        const collect = (stream, chunk) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          const text = data.toString('utf8');
          lines += (text.match(/\n/g) || []).length;
          const finalNewline = text.lastIndexOf('\n');
          partial[stream] = finalNewline >= 0
            ? Buffer.byteLength(text.slice(finalNewline + 1), 'utf8')
            : partial[stream] + data.length;
          if (bytes > maxOutputBytes || lines > maxOutputLines || partial[stream] > maxLineBytes) {
            settle('failed', { kill: true });
          }
        };
        child.stdout?.on('data', (chunk) => collect('stdout', chunk));
        child.stderr?.on('data', (chunk) => collect('stderr', chunk));
        child.once('error', () => settle('failed', { kill: true }));
        child.once('close', (statusCode) => settle(statusCode === 0 ? 'cleared' : 'failed'));
      });
      const reasonCode = state === 'cleared' ? null : 'logout-failed';
      emitHealth(signalSession, state === 'cleared'
        ? { kind: 'local-signed-out', source: 'post-auth' }
        : { kind: 'provider-failure', source: 'post-auth' });
      return { provider: 'claude', reasonCode, state };
    } finally {
      clearingOwners.delete(ownerId);
    }
  }

  function getProviderLoginSession(sessionIdValue, ownerContext) {
    return publicSnapshot(sessionForOwner(sessionIdValue, ownerContext));
  }

  function getActiveProviderLogin(providerValue, ownerContext) {
    const provider = checkedProvider(providerValue);
    const ownerId = checkedOwner(ownerContext);
    const session = active.get(ownerProviderKey(ownerId, provider));
    return session && !TERMINAL_STATES.has(session.state)
      ? publicSnapshot(session)
      : null;
  }

  async function disconnectOwner(ownerContext) {
    const ownerId = checkedOwner(ownerContext);
    for (const session of sessions.values()) {
      if (session.ownerId === ownerId && !TERMINAL_STATES.has(session.state)) {
        terminal(session, 'cancelled', 'cancelled', { kill: true });
      }
    }
  }

  async function shutdown() {
    shuttingDown = true;
    for (const session of sessions.values()) {
      if (!TERMINAL_STATES.has(session.state)) {
        terminal(session, 'cancelled', 'cancelled', { kill: true });
      }
    }
  }

  return Object.freeze({
    cancelProviderLogin,
    clearClaudeCredentials,
    disconnectOwner,
    getActiveProviderLogin,
    getProviderLoginSession,
    shutdown,
    startProviderLogin,
    submitProviderLoginCode,
  });
}

const defaultManager = createProviderLoginManager();

export const startProviderLogin = defaultManager.startProviderLogin;
export const submitProviderLoginCode = defaultManager.submitProviderLoginCode;
export const cancelProviderLogin = defaultManager.cancelProviderLogin;
export const clearClaudeCredentials = defaultManager.clearClaudeCredentials;
export const getActiveProviderLogin = defaultManager.getActiveProviderLogin;
export const getProviderLoginSession = defaultManager.getProviderLoginSession;
export const disconnectProviderLoginOwner = defaultManager.disconnectOwner;
export const shutdownProviderLogins = defaultManager.shutdown;
