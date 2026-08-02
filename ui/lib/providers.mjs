import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCodexModelCatalogue } from './providerModels.mjs';

export const PROVIDERS = Object.freeze(['codex', 'claude']);
const PROVIDER_HEALTH_SOURCES = new Set([
  'startup',
  'manual-preflight',
  'scheduled-preflight',
  'periodic',
  'post-auth',
  'provider-operation',
]);
const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);
const PROVIDER_HEALTH_REASONS = new Set([
  'checking',
  'credentials-found',
  'signed-out',
  'login-started',
  'remote-ok',
  'authentication-required',
  'network-unavailable',
  'rate-limited',
  'cli-update-required',
  'provider-error',
]);

function providerHealthSource(value) {
  return PROVIDER_HEALTH_SOURCES.has(value) ? value : 'provider-operation';
}

function providerHealthReason(value, fallback) {
  const reason = String(value || '');
  return PROVIDER_HEALTH_REASONS.has(reason) ? reason : fallback;
}

function healthSignal(kind, source, reasonCode = null) {
  return {
    kind,
    source: providerHealthSource(source),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function providerFailureText(value) {
  const error = value?.error;
  if (typeof error === 'string') return error.slice(0, 8_192);
  if (error && typeof error.message === 'string') return error.message.slice(0, 8_192);
  return typeof value?.message === 'string' ? value.message.slice(0, 8_192) : '';
}

// Provider failures can contain complete response bodies, local paths, account
// identifiers, and credential material. Reduce them at the adapter boundary to
// one allowlisted reason code; callers must never carry the inspected text on.
export function providerFailureClassification(result) {
  const status = Number(result?.status ?? result?.statusCode);
  const errorCode = String(result?.errorCode || result?.code || result?.error?.code || '').toUpperCase();
  const reasonCode = String(result?.reasonCode || '').toLowerCase();
  const text = providerFailureText(result);

  if (
    status === 401
    || status === 403
    || result?.authenticationFailed === true
    || reasonCode === 'authentication-required'
    || /\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication (?:failed|required)|(?:not|please) (?:logged|signed) in|(?:invalid|expired|missing) (?:api[- ]?)?(?:key|token|credential)/i.test(text)
  ) {
    return { reasonCode: 'authentication-required' };
  }
  if (
    status === 429
    || result?.rateLimited === true
    || reasonCode === 'rate-limited'
    || /\b429\b|too many requests|rate[- ]limit(?:ed|ing| exceeded)?/i.test(text)
  ) {
    return { reasonCode: 'rate-limited' };
  }
  if (
    result?.networkUnavailable === true
    || NETWORK_ERROR_CODES.has(errorCode)
    || reasonCode === 'network-unavailable'
    || /\b(?:ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETDOWN|ENETUNREACH|ENOTFOUND|ETIMEDOUT)\b|network (?:is )?unavailable|connection (?:refused|reset)|could not resolve (?:host|hostname)|socket hang up/i.test(text)
  ) {
    return { reasonCode: 'network-unavailable' };
  }
  if (
    result?.cliUpdateRequired === true
    || ['cli-update', 'cli-update-required', 'unsupported-cli-version'].includes(reasonCode)
    || /(?:update|upgrade) (?:the )?(?:provider )?cli|cli (?:update|upgrade) required|(?:outdated|unsupported) cli(?: version)?|(?:unknown|unrecognized|unsupported) (?:option|argument|flag).*(?:--output-schema|--json-schema)/i.test(text)
  ) {
    return { reasonCode: 'cli-update-required' };
  }
  return { reasonCode: 'provider-error' };
}

function envValue(env, name) {
  const key = Object.keys(env || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function installedLocalAppData(runtimePath = process.execPath) {
  const normalized = path.win32.normalize(String(runtimePath || ''));
  const marker = '\\Programs\\Scout\\runtime\\';
  const index = normalized.toLowerCase().lastIndexOf(marker.toLowerCase());
  return index >= 0 ? normalized.slice(0, index) : null;
}

function windowsHomes(env) {
  const profile = envValue(env, 'USERPROFILE');
  const drive = envValue(env, 'HOMEDRIVE');
  const homePath = envValue(env, 'HOMEPATH');
  const local = envValue(env, 'LOCALAPPDATA');
  const roaming = envValue(env, 'APPDATA');
  return [
    profile,
    drive && homePath ? `${drive}${homePath}` : null,
    local ? path.win32.resolve(local, '..', '..') : null,
    roaming ? path.win32.resolve(roaming, '..', '..') : null,
    os.homedir(),
  ].filter(Boolean);
}

export function providerCommand(provider, platform = process.platform) {
  if (!PROVIDERS.includes(provider)) throw new Error(`unsupported AI provider: ${provider}`);
  return platform === 'win32' ? `${provider}.cmd` : provider;
}

export function providerStatus(provider, {
  spawn = spawnSync,
  platform = process.platform,
  env = process.env,
  resolve = resolveExecutable,
  exists = fs.existsSync,
  runtimePath = process.execPath,
  timeoutMs = 10_000,
} = {}) {
  const providerEnv = providerEnvironment(env, platform, runtimePath);
  const attempts = [];
  let installed = null;
  for (const candidate of providerCandidates(provider, { platform, env: providerEnv, resolve, exists, runtimePath })) {
    const versionCommand = commandInvocation(candidate, ['--version'], { platform, env: providerEnv, resolve: (value) => value });
    const version = spawn(versionCommand.command, versionCommand.args, {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs,
      windowsVerbatimArguments: versionCommand.windowsVerbatimArguments, env: providerEnv,
    });
    if (version.status !== 0) {
      attempts.push({
        source: providerSource(candidate, providerEnv, platform), result: 'unavailable',
        errorCode: version.error?.code || undefined,
        exitCode: Number.isInteger(version.status) ? version.status : undefined,
      });
      continue;
    }
    const authArgs = provider === 'codex' ? ['login', 'status'] : ['auth', 'status'];
    const authCommand = commandInvocation(candidate, authArgs, { platform, env: providerEnv, resolve: (value) => value });
    const auth = spawn(authCommand.command, authCommand.args, {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs,
      windowsVerbatimArguments: authCommand.windowsVerbatimArguments, env: providerEnv,
    });
    const helpArgs = provider === 'codex' ? ['exec', '--help'] : ['--help'];
    const helpCommand = commandInvocation(candidate, helpArgs, { platform, env: providerEnv, resolve: (value) => value });
    const help = spawn(helpCommand.command, helpCommand.args, {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: timeoutMs,
      windowsVerbatimArguments: helpCommand.windowsVerbatimArguments, env: providerEnv,
    });
    const helpText = String(help.stdout || help.stderr || '');
    const structuredOutput = help.status === 0 && (provider === 'codex'
      ? helpText.includes('--output-schema')
      : helpText.includes('--json-schema'));
    const item = { command: candidate, version, auth, authenticated: auth.status === 0, structuredOutput };
    attempts.push({ source: providerSource(candidate, providerEnv, platform), result: item.authenticated ? 'authenticated' : 'signed-out' });
    if (item.authenticated) { installed = item; break; }
    if (!installed) installed = item;
  }
  if (!installed) return { provider, installed: false, authenticated: false, command: providerCommand(provider, platform), attempts };
  const rawAuthMessage = String(installed.auth.stdout || installed.auth.stderr || '').trim();
  const result = {
    provider, command: providerCommand(provider, platform), installed: true, authenticated: installed.authenticated,
    version: String(installed.version.stdout || installed.version.stderr || '').trim(),
    capabilities: { structuredOutput: installed.structuredOutput },
    source: providerSource(installed.command, providerEnv, platform), attempts,
    // Some provider CLIs return account email/org identifiers as JSON. The UI
    // needs readiness, not account metadata, so never expose that raw output.
    authMessage: installed.authenticated ? 'Logged in' : (rawAuthMessage.split(/\r?\n/, 1)[0] || 'Not logged in'),
  };
  Object.defineProperties(result, {
    executable: { value: installed.command, enumerable: false },
    env: { value: providerEnv, enumerable: false },
  });
  return result;
}

function terminateProviderCommand(child, {
  force = false,
  platform = process.platform,
  kill = process.kill,
} = {}) {
  if (platform === 'win32') {
    if (Number.isSafeInteger(child?.pid) && child.pid > 0) {
      try {
        spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 1_000,
          shell: false,
        });
      } catch { /* fall through to the direct child */ }
    }
    try { child?.kill('SIGKILL'); } catch { /* it may already have exited */ }
    return;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    if (Number.isSafeInteger(child?.pid) && child.pid > 0) kill(-child.pid, signal);
    else child?.kill(signal);
  } catch {
    try { child?.kill(signal); } catch { /* it may already have exited */ }
  }
}

export function runProviderCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const {
      timeoutMs = 10_000,
      maxOutputBytes: configuredMaxOutputBytes = 64 * 1024,
      terminateGraceMs = 750,
      spawn = spawnProcess,
      platform = process.platform,
      kill = process.kill,
      ...spawnOptions
    } = options;
    let child;
    try {
      child = spawn(command, args, {
        ...spawnOptions,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error });
      return;
    }
    const maxOutputBytes = Number(configuredMaxOutputBytes);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let error = null;
    let closed = false;
    let forcedTimer = null;
    let timeout = null;
    const finish = (status = null) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      clearTimeout(forcedTimer);
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        error,
        outputExceeded,
        timedOut,
      });
    };
    const stop = () => {
      terminateProviderCommand(child, { platform, kill });
      if (!forcedTimer) {
        forcedTimer = setTimeout(
          () => terminateProviderCommand(child, { force: true, platform, kill }),
          terminateGraceMs,
        );
        forcedTimer.unref?.();
      }
    };
    timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeout.unref?.();
    const collect = (chunks, chunk, stream) => {
      if (outputExceeded) return;
      const nextBytes = stream === 'stdout' ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
      if (nextBytes > maxOutputBytes) {
        outputExceeded = true;
        stop();
        return;
      }
      chunks.push(chunk);
      if (stream === 'stdout') stdoutBytes = nextBytes;
      else stderrBytes = nextBytes;
    };
    child.stdout?.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr?.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.on('error', (value) => { error = value; });
    child.on('close', (status) => finish(status));
  });
}

export async function providerStatusAsync(provider, {
  run = runProviderCommand,
  platform = process.platform,
  env = process.env,
  resolve = resolveExecutable,
  exists = fs.existsSync,
  runtimePath = process.execPath,
  timeoutMs = 10_000,
} = {}) {
  const providerEnv = providerEnvironment(env, platform, runtimePath);
  const attempts = [];
  let installed = null;
  for (const candidate of providerCandidates(provider, { platform, env: providerEnv, resolve, exists, runtimePath })) {
    const invoke = async (args) => {
      const command = commandInvocation(candidate, args, { platform, env: providerEnv, resolve: (value) => value });
      return run(command.command, command.args, {
        windowsHide: true, shell: false, timeoutMs,
        windowsVerbatimArguments: command.windowsVerbatimArguments, env: providerEnv,
      });
    };
    const version = await invoke(['--version']);
    if (version.status !== 0) {
      attempts.push({
        source: providerSource(candidate, providerEnv, platform), result: 'unavailable',
        errorCode: version.error?.code || undefined,
        exitCode: Number.isInteger(version.status) ? version.status : undefined,
      });
      continue;
    }
    const auth = await invoke(provider === 'codex' ? ['login', 'status'] : ['auth', 'status']);
    const help = await invoke(provider === 'codex' ? ['exec', '--help'] : ['--help']);
    const helpText = String(help.stdout || help.stderr || '');
    const structuredOutput = help.status === 0 && (provider === 'codex'
      ? helpText.includes('--output-schema')
      : helpText.includes('--json-schema'));
    const item = { command: candidate, version, auth, authenticated: auth.status === 0, structuredOutput };
    attempts.push({ source: providerSource(candidate, providerEnv, platform), result: item.authenticated ? 'authenticated' : 'signed-out' });
    if (item.authenticated) { installed = item; break; }
    if (!installed) installed = item;
  }
  if (!installed) return { provider, installed: false, authenticated: false, command: providerCommand(provider, platform), attempts };
  const rawAuthMessage = String(installed.auth.stdout || installed.auth.stderr || '').trim();
  const result = {
    provider, command: providerCommand(provider, platform), installed: true, authenticated: installed.authenticated,
    version: String(installed.version.stdout || installed.version.stderr || '').trim(),
    capabilities: { structuredOutput: installed.structuredOutput },
    source: providerSource(installed.command, providerEnv, platform), attempts,
    authMessage: installed.authenticated ? 'Logged in' : (rawAuthMessage.split(/\r?\n/, 1)[0] || 'Not logged in'),
  };
  Object.defineProperties(result, {
    executable: { value: installed.command, enumerable: false },
    env: { value: providerEnv, enumerable: false },
  });
  return result;
}

export function providerCandidates(provider, {
  platform = process.platform, env = process.env, resolve = resolveExecutable,
  exists = fs.existsSync, runtimePath = process.execPath,
} = {}) {
  const list = [];
  const addIfPresent = (candidate) => { if (exists(candidate)) list.push(candidate); };
  if (platform === 'win32') {
    const homes = windowsHomes(env);
    const runtimeLocal = installedLocalAppData(runtimePath);
    const locals = [
      envValue(env, 'LOCALAPPDATA'),
      runtimeLocal,
      ...homes.map((home) => path.win32.join(home, 'AppData', 'Local')),
    ].filter(Boolean);
    const roamings = [envValue(env, 'APPDATA'), ...homes.map((home) => path.win32.join(home, 'AppData', 'Roaming'))].filter(Boolean);
    if (provider === 'codex') {
      // The packaged runtime can receive a restricted environment and has been
      // observed returning false from existsSync for a sibling per-user app.
      // Trying this deterministic path is safe: spawn reports it unavailable
      // when Codex is genuinely absent.
      if (runtimeLocal) list.push(path.win32.join(runtimeLocal, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
      for (const local of locals) addIfPresent(path.win32.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    }
    for (const roaming of roamings) addIfPresent(path.win32.join(roaming, 'npm', `${provider}.cmd`));
    for (const home of homes) {
      addIfPresent(path.win32.join(home, '.local', 'bin', `${provider}.exe`));
      addIfPresent(path.win32.join(home, `.${provider}`, 'bin', `${provider}.exe`));
    }
  } else {
    const home = envValue(env, 'HOME') || os.homedir();
    const candidates = [
      path.posix.join(home, '.local', 'bin', provider),
      path.posix.join(home, '.npm-global', 'bin', provider),
      path.posix.join(home, `.${provider}`, 'bin', provider),
      path.posix.join(home, 'bin', provider),
      '/opt/homebrew/bin/' + provider,
      '/usr/local/bin/' + provider,
      '/usr/bin/' + provider,
    ];
    for (const candidate of candidates) addIfPresent(candidate);
  }
  const resolved = resolve(providerCommand(provider, platform), { platform, env });
  if (resolved) list.push(resolved);
  const seen = new Set();
  return list.filter((candidate) => {
    const key = platform === 'win32' ? String(candidate).toLowerCase() : String(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerSource(command, env, platform = process.platform) {
  const home = envValue(env, 'USERPROFILE') || envValue(env, 'HOME') || os.homedir();
  return String(command).replace(home, platform === 'win32' ? '%USERPROFILE%' : '~');
}

export function providerEnvironment(env = process.env, platform = process.platform, runtimePath = process.execPath) {
  const next = { ...env };
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  const runtimeLocal = platform === 'win32' ? installedLocalAppData(runtimePath) : null;
  const home = runtimeLocal
    ? path.win32.resolve(runtimeLocal, '..', '..')
    : envValue(env, 'USERPROFILE') || envValue(env, 'HOME') || os.homedir();
  if (platform === 'win32') {
    // The packaged tray host can provide a restricted or system-profile
    // environment even though it runs with the interactive user's token.
    // Provider CLIs use these variables to find their OAuth state.
    next.USERPROFILE = home;
    next.HOME = home;
    next.HOMEDRIVE = path.win32.parse(home).root.slice(0, 2);
    next.HOMEPATH = home.slice(next.HOMEDRIVE.length) || '\\';
    if (!envValue(next, 'LOCALAPPDATA')) next.LOCALAPPDATA = runtimeLocal || path.win32.join(home, 'AppData', 'Local');
    if (!envValue(next, 'APPDATA')) next.APPDATA = path.win32.join(home, 'AppData', 'Roaming');
  }
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === 'path') || (platform === 'win32' ? 'Path' : 'PATH');
  const separator = platform === 'win32' ? ';' : ':';
  const existing = String(next[pathKey] || '');
  const common = platform === 'win32'
    ? [
        platformPath.join(envValue(env, 'APPDATA') || platformPath.join(home, 'AppData', 'Roaming'), 'npm'),
        platformPath.join(envValue(env, 'ProgramFiles') || 'C:\\Program Files', 'nodejs'),
        platformPath.join(envValue(env, 'LOCALAPPDATA') || platformPath.join(home, 'AppData', 'Local'), 'Programs', 'nodejs'),
        platformPath.join(home, '.local', 'bin'),
        platformPath.join(home, '.codex', 'bin'),
      ]
    : [
        platformPath.join(home, '.local', 'bin'),
        platformPath.join(home, '.npm-global', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];
  const seen = new Set();
  next[pathKey] = [...common, ...existing.split(separator)]
    .map((entry) => entry.trim()).filter(Boolean)
    .filter((entry) => {
      const key = platform === 'win32' ? entry.toLowerCase() : entry;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).join(separator);
  return next;
}

export function detectProviders(options) {
  return Object.fromEntries(PROVIDERS.map((name) => [name, providerStatus(name, options)]));
}

// Provider CLIs and remote clients can include account identifiers, paths,
// credentials and complete response bodies. Health persistence needs only this
// small allowlisted signal vocabulary, so conversion deliberately never copies
// arbitrary input fields.
export function providerLocalHealthSignal(status, { source = 'provider-operation' } = {}) {
  if (status?.installed !== true) {
    return healthSignal('provider-failure', source, 'provider-error');
  }
  if (status?.capabilities?.structuredOutput === false) {
    return healthSignal('cli-update', source, 'cli-update-required');
  }
  if (status?.authenticated === true) {
    return healthSignal('local-credentials-present', source);
  }
  return healthSignal(
    'local-signed-out',
    source,
    'signed-out',
  );
}

export function providerRemoteHealthSignal(result, { source = 'provider-operation' } = {}) {
  const status = Number(result?.status ?? result?.statusCode);
  const classification = providerFailureClassification(result);

  // Authentication responses are authoritative even if a faulty adapter also
  // marks the request successful or local credentials still appear present.
  if (classification.reasonCode === 'authentication-required') {
    return healthSignal('remote-auth-failure', source, 'authentication-required');
  }
  if (classification.reasonCode === 'rate-limited') {
    return healthSignal('rate-limit', source, 'rate-limited');
  }
  if (classification.reasonCode === 'network-unavailable') {
    return healthSignal('network-failure', source, 'network-unavailable');
  }
  if (classification.reasonCode === 'cli-update-required') {
    return healthSignal('cli-update', source, 'cli-update-required');
  }
  if (result?.loginInProgress === true) return healthSignal('login-started', source);
  if (result?.checking === true) return healthSignal('check-started', source);
  if (result?.remoteSuccess === true || result?.ok === true || (status >= 200 && status < 300)) {
    return healthSignal('remote-success', source);
  }
  return healthSignal(
    'provider-failure',
    source,
    providerHealthReason(classification.reasonCode, 'provider-error'),
  );
}

export function providerHealthSignal({ local = null, remote = null, source = 'provider-operation' } = {}) {
  // Once a remote check has happened it is stronger evidence than a local CLI
  // credential-presence probe. A later real remote success clears that barrier.
  return remote !== null && remote !== undefined
    ? providerRemoteHealthSignal(remote, { source })
    : providerLocalHealthSignal(local, { source });
}

export function createProviderDetector({ status = providerStatusAsync, ttlMs = 5_000, now = Date.now } = {}) {
  let cached = null;
  let expiresAt = 0;
  let inFlight = null;
  return async function detect(options) {
    const current = now();
    if (cached && current < expiresAt) return cached;
    if (inFlight) return inFlight;
    inFlight = Promise.all(PROVIDERS.map(async (name) => [name, await status(name, options)]))
      .then((entries) => {
        cached = Object.fromEntries(entries);
        expiresAt = now() + ttlMs;
        return cached;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

export const detectProvidersAsync = createProviderDetector();

export function assertSafeModel(value) {
  if (value == null || value === '') return null;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('invalid model identifier');
  return value;
}

export function resolveExecutable(command, { env = process.env, platform = process.platform } = {}) {
  if (path.isAbsolute(command)) return command;
  if (platform !== 'win32') return command;
  const extension = path.extname(command);
  // npm's .cmd shim is often the usable CLI even when a Windows Store package
  // exposes an inaccessible .exe under WindowsApps. Native-only CLIs (such as
  // Claude's installer) still fall through to .exe.
  const candidates = /\.cmd$/i.test(command)
    ? [command, `${command.slice(0, -4)}.exe`]
    : extension ? [command] : [`${command}.cmd`, `${command}.exe`, command];
  for (const candidate of candidates) {
    const result = spawnSync('where.exe', [candidate], { encoding: 'utf8', windowsHide: true, env });
    const found = String(result.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (found) return found;
  }
  return command;
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error('command arguments cannot contain newlines');
  return `"${text.replace(/%/g, '%%').replace(/(["^&|<>])/g, '^$1')}"`;
}

export function commandInvocation(command, args, {
  platform = process.platform,
  env = process.env,
  resolve = resolveExecutable,
} = {}) {
  const executable = resolve(command, { platform, env });
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return { command: executable, args, shell: false };
  const line = [quoteCmdArg(executable), ...args.map(quoteCmdArg)].join(' ');
  return {
    command: env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    shell: false,
    windowsVerbatimArguments: true,
  };
}

export async function codexModelCatalogueStatus(status, {
  run = runProviderCommand,
  platform = process.platform,
  timeoutMs = 7_500,
  maxOutputBytes = 512 * 1024,
  now = () => new Date().toISOString(),
} = {}) {
  if (!status?.installed || !status?.authenticated || !status?.executable) {
    return { state: 'unsupported', reasonCode: 'provider-unavailable', models: [], checkedAt: now() };
  }
  const invocation = commandInvocation(status.executable, ['debug', 'models'], {
    platform,
    env: status.env || process.env,
    resolve: (value) => value,
  });
  let result;
  try {
    result = await run(invocation.command, invocation.args, {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      env: status.env || process.env,
      timeoutMs,
      maxOutputBytes,
    });
  } catch {
    return { state: 'failed', reasonCode: 'command-failed', models: [], checkedAt: now() };
  }
  if (result?.outputExceeded) {
    return { state: 'failed', reasonCode: 'output-too-large', models: [], checkedAt: now() };
  }
  if (result?.status !== 0) {
    const timedOut = result?.timedOut === true || result?.error?.code === 'ETIMEDOUT';
    return {
      state: timedOut ? 'failed' : 'unsupported',
      reasonCode: timedOut ? 'timeout' : 'command-unsupported',
      models: [],
      checkedAt: now(),
    };
  }
  try {
    const parsed = parseCodexModelCatalogue(result.stdout, { maxBytes: maxOutputBytes });
    return { state: 'refreshed', reasonCode: null, models: parsed.models, checkedAt: now() };
  } catch (error) {
    return {
      state: 'failed',
      reasonCode: /too large/i.test(error.message) ? 'output-too-large' : 'invalid-output',
      models: [],
      checkedAt: now(),
    };
  }
}

export function createProviderModelCatalogueDetector({
  detect = detectProvidersAsync,
  catalogue = codexModelCatalogueStatus,
  ttlMs = 5 * 60 * 1000,
  now = Date.now,
} = {}) {
  let cached = null;
  let expiresAt = 0;
  let inFlight = null;
  return async function detectCatalogues() {
    const current = now();
    if (cached && current < expiresAt) return cached;
    if (inFlight) return inFlight;
    inFlight = Promise.resolve(detect())
      .then(async (statuses) => ({
        codex: await catalogue(statuses?.codex),
        claude: {
          state: 'unsupported',
          reasonCode: 'enumeration-unsupported',
          models: [],
          checkedAt: new Date(now()).toISOString(),
        },
      }))
      .then((value) => {
        cached = value;
        expiresAt = now() + ttlMs;
        return value;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

export const detectProviderModelCataloguesAsync = createProviderModelCatalogueDetector();
