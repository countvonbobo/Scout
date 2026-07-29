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
const POST_AUTH_SIGNALS = new Set([
  'remote-success',
  'local-credentials-present',
  'remote-auth-failure',
  'network-failure',
  'rate-limit',
  'cli-update',
  'provider-failure',
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
const DEFAULT_TERMINATE_GRACE_MS = 1_000;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 3_000;
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
    || !['local', 'remote-owner'].includes(ownerContext.access)
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
    const codeMatch = line.match(
      /\b(?:enter|use)\s+(?:(?:the\s+)?(?:device\s+)?code(?:\s*[:=]\s*|\s+))?([A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3})(?!-[A-Z0-9])\b/i,
    );
    const code = codeMatch?.[1] || '';
    if (code
      && code === code.toUpperCase()
      && !/\b(?:api[- ]?key|bearer|password|secret|token)\b/i.test(line)) {
      session.userCode = code;
    }
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

export async function terminateProviderProcessTree(child, {
  platform = process.platform,
  spawn = spawnProcess,
  timeoutMs = 1_000,
} = {}) {
  if (platform !== 'win32' || !Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    try { child?.kill('SIGKILL'); } catch {}
    return;
  }
  const status = await new Promise((resolve) => {
    let settled = false;
    let killer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    try {
      killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    killer.once('error', () => finish(null));
    killer.once('close', (code) => finish(code));
  });
  if (status !== 0 && child.exitCode == null && child.signalCode == null) {
    try { child.kill('SIGKILL'); } catch {}
  }
}

export function createProviderLoginManager({
  providerStatus = providerStatusAsync,
  spawn = spawnProcess,
  processTreeSpawn = spawnProcess,
  confirmProviderHealth = async () => ({
    kind: 'local-credentials-present',
    source: 'post-auth',
  }),
  onHealthSignal = async () => {},
  canClearClaudeCredentials = async () => false,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  now = Date.now,
  sessionId = randomUUID,
  timeoutMs: configuredTimeoutMs,
  rateWindowMs: configuredRateWindowMs,
  retentionMs: configuredRetentionMs,
  maxStarts: configuredMaxStarts,
  maxCancels: configuredMaxCancels,
  maxRetries: configuredMaxRetries,
  maxOutputBytes: configuredMaxOutputBytes,
  maxOutputLines: configuredMaxOutputLines,
  maxLineBytes: configuredMaxLineBytes,
  terminateGraceMs: configuredTerminateGraceMs,
  shutdownDeadlineMs: configuredShutdownDeadlineMs,
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
  const maxCancels = checkedPositiveInteger(
    configuredMaxCancels,
    10,
    'provider login cancel limit',
  );
  const maxRetries = checkedPositiveInteger(
    configuredMaxRetries,
    3,
    'provider login retry limit',
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
  const terminateGraceMs = checkedPositiveInteger(
    configuredTerminateGraceMs,
    DEFAULT_TERMINATE_GRACE_MS,
    'provider login termination grace',
  );
  const shutdownDeadlineMs = checkedPositiveInteger(
    configuredShutdownDeadlineMs,
    DEFAULT_SHUTDOWN_DEADLINE_MS,
    'provider login shutdown deadline',
  );

  const sessions = new Map();
  const active = new Map();
  const pendingStarts = new Set();
  const starts = new Map();
  const cancels = new Map();
  const retries = new Map();
  const clearingOwners = new Set();
  const trackedChildren = new Set();
  const pendingClearSettlers = new Map();
  const pendingClearAuthorizations = new Set();
  const pendingClearOperations = new Set();
  const pendingHealthWrites = new Set();
  let shuttingDown = false;

  function persistHealth(session, signal) {
    const previous = session.healthWriteTail || Promise.resolve();
    const write = previous.catch(() => {}).then(() => onHealthSignal(
        session.provider,
        signal,
        { ownerId: session.ownerId },
      ));
    session.healthWriteTail = write;
    pendingHealthWrites.add(write);
    write.finally(() => pendingHealthWrites.delete(write)).catch(() => {});
    return write;
  }

  function emitHealth(session, signal) {
    try {
      persistHealth(session, signal).catch(() => {});
    } catch {
      // Health persistence is deliberately unable to leak provider output or
      // keep a completed authentication subprocess alive.
    }
  }

  function trackChild(child) {
    let resolveClosed;
    const record = {
      child,
      closed: false,
      closedPromise: new Promise((resolve) => { resolveClosed = resolve; }),
      stopPromise: null,
    };
    trackedChildren.add(record);
    child.once('close', () => {
      if (record.closed) return;
      record.closed = true;
      trackedChildren.delete(record);
      resolveClosed();
    });
    return record;
  }

  function waitForChildClose(record, timeout) {
    if (record.closed) return Promise.resolve(true);
    if (timeout <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeout);
      record.closedPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  function stopTrackedChild(record, deadlineAt = Date.now() + shutdownDeadlineMs) {
    if (!record || record.closed) return Promise.resolve();
    if (record.stopPromise) return record.stopPromise;
    const attempt = (async () => {
      if (platform === 'win32') {
        await terminateProviderProcessTree(record.child, {
          platform,
          spawn: processTreeSpawn,
          timeoutMs: Math.min(terminateGraceMs, shutdownDeadlineMs),
        });
        await waitForChildClose(record, Math.max(0, deadlineAt - Date.now()));
        return;
      }
      try { record.child.kill('SIGTERM'); } catch {}
      const grace = Math.min(
        terminateGraceMs,
        Math.max(0, deadlineAt - Date.now()),
      );
      if (await waitForChildClose(record, grace)) return;
      try { record.child.kill('SIGKILL'); } catch {}
      await waitForChildClose(record, Math.max(0, deadlineAt - Date.now()));
    })();
    record.stopPromise = attempt.finally(() => {
      if (!record.closed) record.stopPromise = null;
    });
    return record.stopPromise;
  }

  function stopProcess(session, deadlineAt) {
    return stopTrackedChild(session.processRecord, deadlineAt);
  }

  async function stopConfirmation(session, deadlineAt = Date.now() + shutdownDeadlineMs) {
    const confirmation = session.confirmation;
    if (!confirmation) return;
    try { confirmation.stop?.(); } catch {}
    const closed = Promise.resolve(confirmation.closed || confirmation).catch(() => {});
    await Promise.race([
      closed,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
        timer.unref?.();
      }),
    ]);
  }

  function terminalHealth(reasonCode, state) {
    if (state === 'succeeded') {
      return { kind: 'local-credentials-present', source: 'post-auth' };
    }
    if (reasonCode === 'validation-failed') {
      return { kind: 'local-signed-out', source: 'post-auth' };
    }
    return { kind: 'provider-failure', source: 'post-auth' };
  }

  function terminal(session, state, reasonCode, {
    kill = false,
    deadlineAt,
    reportHealth = true,
  } = {}) {
    if (TERMINAL_STATES.has(session.state)) return Promise.resolve();
    const cleanup = kill
      ? Promise.all([
        stopProcess(session, deadlineAt),
        stopConfirmation(session, deadlineAt),
      ])
      : Promise.resolve();
    clearTimeout(session.timeout);
    session.timeout = null;
    session.state = state;
    session.reasonCode = reasonCode;
    const activeKey = ownerProviderKey(session.ownerId, session.provider);
    const record = session.processRecord;
    if (record && !record.closed) {
      record.closedPromise.then(() => {
        if (active.get(activeKey) === session) active.delete(activeKey);
      });
    } else {
      active.delete(activeKey);
    }
    const health = reportHealth
      ? persistHealth(session, terminalHealth(reasonCode, state)).catch(() => {})
      : Promise.resolve();
    session.buffers = { stdout: '', stderr: '' };
    session.executable = null;
    session.env = null;
    session.healthStatus = null;
    const retention = setTimeout(() => {
      if (sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
    }, retentionMs);
    retention.unref?.();
    return Promise.all([cleanup, health]).then(() => undefined);
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
    session.processRecord = trackChild(child);
    let finished = false;
    child.stdout?.on('data', (chunk) => collectOutput(session, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => collectOutput(session, 'stderr', chunk));
    child.stdin?.once('error', () => {
      if (finished || TERMINAL_STATES.has(session.state)) return;
      finished = true;
      void terminal(session, 'failed', 'code-write-failed', { kill: true });
    });
    child.once('error', () => {
      if (finished) return;
      finished = true;
      void terminal(session, 'failed', phase === 'login'
        ? 'process-start-failed'
        : 'validation-failed', { kill: true });
    });
    child.once('disconnect', () => {
      if (finished) return;
      finished = true;
      void terminal(session, 'failed', 'process-disconnected', { kill: true });
    });
    child.once('close', (status) => {
      if (finished) return;
      finished = true;
      if (TERMINAL_STATES.has(session.state)) return;
      session.process = null;
      session.processRecord = null;
      if (phase === 'login') {
        if (status !== 0) {
          terminal(session, 'failed', 'login-failed');
          return;
        }
        beginValidation(session);
        return;
      }
      if (status === 0) void completeValidation(session);
      else terminal(session, 'failed', 'validation-failed');
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

  function checkedPostAuthSignal(signal) {
    if (!signal
      || typeof signal !== 'object'
      || Array.isArray(signal)
      || signal.source !== 'post-auth'
      || !POST_AUTH_SIGNALS.has(signal.kind)
      || Object.keys(signal).sort().join(',') !== 'kind,source') {
      throw new Error('provider health confirmation returned an unsupported signal');
    }
    return { kind: signal.kind, source: signal.source };
  }

  async function completeValidation(session) {
    if (TERMINAL_STATES.has(session.state)) return;
    let confirmation;
    let signal;
    try {
      confirmation = confirmProviderHealth(
        session.provider,
        session.healthStatus,
      );
      session.confirmation = confirmation;
      signal = checkedPostAuthSignal(await confirmation);
      await Promise.resolve(confirmation?.closed || confirmation);
      if (TERMINAL_STATES.has(session.state)
        || session.confirmation !== confirmation) return;
      await persistHealth(session, signal);
      if (TERMINAL_STATES.has(session.state)
        || session.confirmation !== confirmation) return;
    } catch {
      if (!TERMINAL_STATES.has(session.state)) {
        await terminal(session, 'failed', 'health-confirmation-failed');
      }
      return;
    } finally {
      if (session.confirmation === confirmation) session.confirmation = null;
    }
    const confirmed = signal.kind === 'remote-success'
      || signal.kind === 'local-credentials-present';
    await terminal(
      session,
      confirmed ? 'succeeded' : 'failed',
      confirmed
        ? null
        : session.provider === 'claude' && signal.kind === 'remote-auth-failure'
          ? 'credentials-expired'
          : 'health-confirmation-failed',
      { reportHealth: false },
    );
  }

  function sessionForOwner(sessionIdValue, ownerContext) {
    const ownerId = checkedOwner(ownerContext);
    const session = sessions.get(String(sessionIdValue || ''));
    if (!session || session.ownerId !== ownerId) {
      throw createError('provider login session is unavailable', 'LOGIN_SESSION_UNAVAILABLE');
    }
    return session;
  }

  function enforceRate(bucket, ownerId, provider, limit, message, code) {
    const key = ownerProviderKey(ownerId, provider);
    const current = Number(now());
    const recent = (bucket.get(key) || []).filter((at) => current - at < rateWindowMs);
    if (recent.length >= limit) {
      throw createError(message, code);
    }
    recent.push(current);
    bucket.set(key, recent);
  }

  async function start(providerValue, ownerContext, operation) {
    if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
    const provider = checkedProvider(providerValue);
    const ownerId = checkedOwner(ownerContext);
    const key = ownerProviderKey(ownerId, provider);
    const existing = active.get(key);
    if ((provider === 'claude' && clearingOwners.has(ownerId))
      || pendingStarts.has(key)
      || (existing && (
        !TERMINAL_STATES.has(existing.state)
        || (existing.processRecord && !existing.processRecord.closed)
      ))) {
      throw createError('provider login is already active', 'LOGIN_ALREADY_ACTIVE');
    }
    if (operation === 'retry') {
      enforceRate(
        retries,
        ownerId,
        provider,
        maxRetries,
        'provider login retry rate limit reached',
        'LOGIN_RETRY_RATE_LIMIT',
      );
    } else {
      enforceRate(
        starts,
        ownerId,
        provider,
        maxStarts,
        'provider login start rate limit reached',
        'LOGIN_RATE_LIMIT',
      );
    }
    pendingStarts.add(key);
    try {
      const status = await providerStatus(provider);
      if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
      const executable = checkedExecutable(status);
      const providerEnv = minimalProviderEnvironment(
        status.env && typeof status.env === 'object' ? status.env : env,
      );
      const healthStatus = {
        installed: true,
        authenticated: true,
        capabilities: {
          structuredOutput: status.capabilities?.structuredOutput !== false,
        },
      };
      Object.defineProperties(healthStatus, {
        executable: { value: executable },
        env: { value: providerEnv },
      });
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
        env: providerEnv,
        healthStatus,
        process: null,
        processRecord: null,
        confirmation: null,
        healthWriteTail: Promise.resolve(),
        outputBytes: 0,
        outputLines: 0,
        buffers: { stdout: '', stderr: '' },
        codeSubmitted: false,
        codeAttempts: 0,
        retryConsumed: false,
        clearConsumed: false,
        timeout: null,
      };
      sessions.set(id, session);
      active.set(key, session);
      session.timeout = setTimeout(() => {
        void terminal(session, 'expired', 'expired', { kill: true });
      }, timeoutMs);
      session.timeout.unref?.();

      let child;
      try {
        child = spawnFixed(
          session,
          LOGIN_ARGUMENTS[provider],
          provider === 'codex' ? 'ignore' : 'pipe',
        );
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

  async function startProviderLogin(providerValue, ownerContext) {
    return start(providerValue, ownerContext, 'start');
  }

  async function retryProviderLogin(providerValue, previousSessionId, ownerContext) {
    const provider = checkedProvider(providerValue);
    const previous = sessionForOwner(previousSessionId, ownerContext);
    if (previous.provider !== provider || !TERMINAL_STATES.has(previous.state)) {
      throw createError(
        'only a terminal provider login can be retried',
        'LOGIN_RETRY_NOT_ALLOWED',
      );
    }
    if (previous.retryConsumed) {
      throw createError(
        'provider login retry has already been used',
        'LOGIN_RETRY_REPLAYED',
      );
    }
    previous.retryConsumed = true;
    return start(provider, ownerContext, 'retry');
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
      const input = session.process.stdin;
      input.write(`${boundedCode}\n`, (error) => {
        if (error) {
          void terminal(session, 'failed', 'code-write-failed', { kill: true });
          reject(createError('manual code was not accepted', 'LOGIN_CODE_WRITE_FAILED'));
          return;
        }
        try {
          input.end();
        } catch {
          void terminal(session, 'failed', 'code-write-failed', { kill: true });
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
    enforceRate(
      cancels,
      session.ownerId,
      session.provider,
      maxCancels,
      'provider login cancel rate limit reached',
      'LOGIN_CANCEL_RATE_LIMIT',
    );
    await terminal(session, 'cancelled', 'cancelled', { kill: true });
    return publicSnapshot(session);
  }

  async function performClearClaudeCredentials(sessionIdValue, ownerContext) {
    if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
    const ownerId = checkedOwner(ownerContext);
    const sourceSession = sessionForOwner(sessionIdValue, ownerContext);
    if (sourceSession.provider !== 'claude'
      || sourceSession.state !== 'failed'
      || sourceSession.reasonCode !== 'credentials-expired'
      || Number(now()) > Date.parse(sourceSession.expiresAt)
      || sourceSession.clearConsumed) {
      throw createError(
        'expired Claude credentials have not been confirmed',
        'CLAUDE_CREDENTIAL_CLEAR_NOT_ALLOWED',
      );
    }
    const activeKey = ownerProviderKey(ownerId, 'claude');
    if (active.has(activeKey) || pendingStarts.has(activeKey) || clearingOwners.has(ownerId)) {
      throw createError('provider login is already active', 'LOGIN_ALREADY_ACTIVE');
    }
    enforceRate(
      starts,
      ownerId,
      'claude-clear',
      maxStarts,
      'provider login start rate limit reached',
      'LOGIN_RATE_LIMIT',
    );
    sourceSession.clearConsumed = true;
    clearingOwners.add(ownerId);
    const signalSession = {
      provider: 'claude',
      ownerId,
      healthWriteTail: Promise.resolve(),
    };
    let clearRecord = null;
    try {
      const status = await providerStatus('claude');
      if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
      const executable = checkedExecutable(status);
      const environment = minimalProviderEnvironment(
        status.env && typeof status.env === 'object' ? status.env : env,
      );
      const healthStatus = {
        installed: true,
        authenticated: true,
        capabilities: {
          structuredOutput: status.capabilities?.structuredOutput !== false,
        },
      };
      Object.defineProperties(healthStatus, {
        executable: { value: executable },
        env: { value: environment },
      });
      let authorization;
      let eligible = false;
      try {
        authorization = canClearClaudeCredentials({
          access: ownerContext.access,
          ownerId,
          sessionId: sourceSession.sessionId,
          status: healthStatus,
        });
        pendingClearAuthorizations.add(authorization);
        eligible = await authorization === true;
        await Promise.resolve(authorization?.closed || authorization);
      } catch {
        eligible = false;
      } finally {
        pendingClearAuthorizations.delete(authorization);
      }
      if (shuttingDown) throw createError('provider login manager is shutting down', 'LOGIN_SHUTDOWN');
      if (!eligible) {
        sourceSession.reasonCode = 'credentials-no-longer-expired';
        throw createError(
          'expired Claude credentials are no longer confirmed',
          'CLAUDE_CREDENTIAL_CLEAR_NOT_ALLOWED',
        );
      }
      const invocation = commandInvocation(executable, ['auth', 'logout'], {
        platform,
        env: environment,
        resolve: (value) => value,
      });
      const state = await new Promise((resolve) => {
        let child;
        let settled = false;
        let record = null;
        let timer = null;
        let bytes = 0;
        let lines = 0;
        const buffers = { stdout: '', stderr: '' };
        const settle = async (result, { kill = false } = {}) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (record) pendingClearSettlers.delete(record);
          if (kill) await stopTrackedChild(record);
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
        record = trackChild(child);
        clearRecord = record;
        pendingClearSettlers.set(record, () => settle('failed'));
        timer = setTimeout(() => { void settle('failed', { kill: true }); }, timeoutMs);
        timer.unref?.();
        const collect = (stream, chunk) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          buffers[stream] += data.toString('utf8');
          let newline = buffers[stream].indexOf('\n');
          while (newline >= 0 && !settled) {
            const line = buffers[stream].slice(0, newline).replace(/\r$/, '');
            buffers[stream] = buffers[stream].slice(newline + 1);
            lines += 1;
            if (lines > maxOutputLines
              || Buffer.byteLength(line, 'utf8') > maxLineBytes) {
              void settle('failed', { kill: true });
              return;
            }
            newline = buffers[stream].indexOf('\n');
          }
          if (bytes > maxOutputBytes
            || Buffer.byteLength(buffers[stream], 'utf8') > maxLineBytes) {
            void settle('failed', { kill: true });
          }
        };
        child.stdout?.on('data', (chunk) => collect('stdout', chunk));
        child.stderr?.on('data', (chunk) => collect('stderr', chunk));
        child.once('error', () => { void settle('failed', { kill: true }); });
        child.once('disconnect', () => { void settle('failed', { kill: true }); });
        child.once('close', (statusCode) => { void settle(statusCode === 0 ? 'cleared' : 'failed'); });
      });
      const reasonCode = state === 'cleared' ? null : 'logout-failed';
      try {
        await persistHealth(signalSession, state === 'cleared'
          ? { kind: 'local-signed-out', source: 'post-auth' }
          : { kind: 'provider-failure', source: 'post-auth' });
      } catch {
        sourceSession.reasonCode = 'health-write-failed';
        return {
          provider: 'claude',
          reasonCode: 'health-write-failed',
          state: 'failed',
        };
      }
      if (state !== 'cleared') sourceSession.reasonCode = reasonCode;
      return { provider: 'claude', reasonCode, state };
    } finally {
      if (!clearRecord || clearRecord.closed) {
        clearingOwners.delete(ownerId);
      } else {
        clearRecord.closedPromise.then(() => clearingOwners.delete(ownerId));
      }
    }
  }

  function clearClaudeCredentials(sessionIdValue, ownerContext) {
    const operation = performClearClaudeCredentials(sessionIdValue, ownerContext);
    pendingClearOperations.add(operation);
    operation.finally(() => pendingClearOperations.delete(operation)).catch(() => {});
    return operation;
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
    const cleanup = [];
    for (const session of sessions.values()) {
      if (session.ownerId === ownerId && !TERMINAL_STATES.has(session.state)) {
        cleanup.push(terminal(session, 'cancelled', 'cancelled', { kill: true }));
      }
    }
    await Promise.all(cleanup);
  }

  async function shutdown() {
    shuttingDown = true;
    const deadlineAt = Date.now() + shutdownDeadlineMs;
    const cleanup = [];
    for (const session of sessions.values()) {
      if (!TERMINAL_STATES.has(session.state)) {
        cleanup.push(terminal(session, 'cancelled', 'cancelled', {
          kill: true,
          deadlineAt,
        }));
      }
    }
    for (const record of [...trackedChildren]) {
      cleanup.push(stopTrackedChild(record, deadlineAt));
    }
    for (const authorization of [...pendingClearAuthorizations]) {
      try { authorization?.stop?.(); } catch {}
      cleanup.push(Promise.race([
        Promise.resolve(authorization?.closed || authorization).catch(() => {}),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadlineAt - Date.now()));
          timer.unref?.();
        }),
      ]));
    }
    await Promise.all(cleanup);
    await Promise.all(
      [...pendingClearSettlers.values()].map((settle) => settle()),
    );
    await Promise.allSettled([...pendingClearOperations]);
    await Promise.allSettled([...pendingHealthWrites]);
  }

  return Object.freeze({
    cancelProviderLogin,
    clearClaudeCredentials,
    disconnectOwner,
    getActiveProviderLogin,
    getProviderLoginSession,
    retryProviderLogin,
    shutdown,
    startProviderLogin,
    submitProviderLoginCode,
  });
}

const defaultManager = createProviderLoginManager();

export const startProviderLogin = defaultManager.startProviderLogin;
export const retryProviderLogin = defaultManager.retryProviderLogin;
export const submitProviderLoginCode = defaultManager.submitProviderLoginCode;
export const cancelProviderLogin = defaultManager.cancelProviderLogin;
export const clearClaudeCredentials = defaultManager.clearClaudeCredentials;
export const getActiveProviderLogin = defaultManager.getActiveProviderLogin;
export const getProviderLoginSession = defaultManager.getProviderLoginSession;
export const disconnectProviderLoginOwner = defaultManager.disconnectOwner;
export const shutdownProviderLogins = defaultManager.shutdown;
