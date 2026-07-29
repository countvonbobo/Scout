import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { commandInvocation, providerFailureClassification } from './providers.mjs';

function killTree(child, { force = false } = {}) {
  if (process.platform === 'win32') {
    // taskkill is the only built-in way to reliably stop a shell-launched CLI
    // and its descendants, but managed Windows environments can deny it even
    // for a process we spawned. Fall back to killing the immediate child so a
    // direct executable (and our tests) still stops instead of hanging forever.
    let fellBack = false;
    const fallback = () => {
      if (fellBack) return;
      fellBack = true;
      try { child.kill(); } catch { /* it may already have exited */ }
    };
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', fallback);
    killer.once('close', (code) => { if (code !== 0) fallback(); });
    setTimeout(fallback, 1000).unref();
  } else {
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    try {
      if (Number.isSafeInteger(child?.pid) && child.pid > 0) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try { child.kill(signal); } catch { /* it may already have exited */ }
    }
  }
}

function relativeToRepo(cwd, file) {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return null;
  return rel.replace(/\\/g, '/');
}

const SAFE_TOOL_ACTIVITIES = new Set(['searching', 'thinking', 'writing']);

function publicTurnEvent(event) {
  if (event?.kind === 'tool') {
    const activity = SAFE_TOOL_ACTIVITIES.has(event.activity) ? event.activity : 'thinking';
    return {
      kind: 'tool',
      label: activity === 'writing'
        ? 'Editing a file'
        : activity === 'searching' ? 'Searching provider sources' : 'Using provider tools',
      activity,
    };
  }
  if (event?.kind === 'done' && event.ok === false) {
    return { kind: 'done', text: '', ok: false, usage: {} };
  }
  return event;
}

function providerFailure(detail) {
  const text = String(detail || '').slice(0, 4_096);
  const modelRejected = /\b(?:invalid|unknown|unsupported)\s+model\b/i.test(text)
    || /\bmodel\b.{0,120}\b(?:does not exist|not found|not available|unavailable|unsupported|access denied)\b/i.test(text);
  if (modelRejected) {
    return { error: 'The provider rejected that model.', reasonCode: 'model-rejected' };
  }
  const { reasonCode } = providerFailureClassification({ error: text });
  const error = {
    'authentication-required': 'Provider authentication is required.',
    'network-unavailable': 'The provider network is unavailable.',
    'rate-limited': 'The provider rate limit was reached.',
    'cli-update-required': 'The provider CLI must be updated.',
    'provider-error': 'Provider turn failed.',
  }[reasonCode];
  return { error, reasonCode };
}

export function runTurn({
  command, args, prompt, cwd, parseLine,
  env = process.env,
  onEvent = () => {},
  timeoutMs = 600000,
  maxOutputBytes = 8 * 1024 * 1024,
  maxOutputLines = 10_000,
  maxLineBytes = 256 * 1024,
}) {
  for (const [label, value] of Object.entries({
    maxOutputBytes, maxOutputLines, maxLineBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive integer`);
    }
  }
  let child = null;
  let stopped = false;
  let timedOut = false;
  let outputExceeded = false;
  let terminationTimer = null;
  const finished = new Promise((resolve) => {
    const state = {
      sessionId: null,
      deltas: [],
      files: new Set(),
      done: null,
      stderr: '',
      outputBytes: 0,
      outputLines: 0,
      partial: { stdout: '', stderr: '' },
    };
    const invocation = commandInvocation(command, args, { env });
    child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      env,
      detached: process.platform !== 'win32',
    });
    const stopChild = () => {
      killTree(child);
      if (!terminationTimer && process.platform !== 'win32') {
        terminationTimer = setTimeout(() => killTree(child, { force: true }), 750);
        terminationTimer.unref?.();
      }
    };
    const timer = setTimeout(() => { timedOut = true; stopChild(); }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      resolve({
        ok: false,
        error: err.code === 'ENOENT' ? 'Provider CLI is unavailable.' : 'Provider turn could not start.',
        reasonCode: err.code === 'ENOENT' ? 'provider-unavailable' : 'process-start-failed',
      });
    });
    const observeOutput = (stream, chunk) => {
      if (outputExceeded) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      state.outputBytes += data.length;
      state.partial[stream] += data.toString('utf8');
      let newline = state.partial[stream].indexOf('\n');
      while (newline >= 0 && !outputExceeded) {
        const line = state.partial[stream].slice(0, newline).replace(/\r$/, '');
        state.partial[stream] = state.partial[stream].slice(newline + 1);
        state.outputLines += 1;
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) outputExceeded = true;
        newline = state.partial[stream].indexOf('\n');
      }
      if (state.outputBytes > maxOutputBytes
          || state.outputLines > maxOutputLines
          || Buffer.byteLength(state.partial[stream], 'utf8') > maxLineBytes) {
        outputExceeded = true;
      }
      if (outputExceeded) stopChild();
    };
    child.stdout.on('data', (chunk) => observeOutput('stdout', chunk));
    child.stderr.on('data', (chunk) => observeOutput('stderr', chunk));
    child.stderr.on('data', (c) => {
      if (!outputExceeded) state.stderr = (state.stderr + c).slice(-2000);
    });
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (outputExceeded) return;
      let events = [];
      try { events = parseLine(line) || []; } catch { /* skip unparseable line */ }
      for (const ev of events) {
        if (ev.kind === 'session') state.sessionId = ev.sessionId;
        if (ev.kind === 'delta') state.deltas.push(ev.text);
        if (ev.kind === 'tool' && ev.file && ev.mutatesFile === true) {
          const rel = relativeToRepo(cwd, ev.file);
          if (rel) state.files.add(rel);
        }
        if (ev.kind === 'done') state.done = ev;
        onEvent(publicTurnEvent(ev));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      const filesTouched = [...state.files];
      if (outputExceeded) {
        resolve({
          ok: false,
          error: 'Provider output exceeded the safe limit.',
          reasonCode: 'output-limit',
          outputExceeded: true,
          sessionId: state.sessionId,
          filesTouched,
        });
      } else if (timedOut) {
        const duration = timeoutMs % 60000 === 0 ? `${timeoutMs / 60000} minutes` : `${timeoutMs} ms`;
        resolve({
          ok: false,
          error: `Provider turn timed out after ${duration}.`,
          reasonCode: 'timeout',
          sessionId: state.sessionId,
          filesTouched,
        });
      } else if (stopped) {
        resolve({
          ok: false,
          error: 'Provider turn stopped.',
          reasonCode: 'stopped',
          stopped: true,
          sessionId: state.sessionId,
          filesTouched,
        });
      } else if (code !== 0) {
        const detail = (state.done && state.done.text) || state.stderr.trim() || `exit code ${code}`;
        resolve({ ok: false, ...providerFailure(detail), sessionId: state.sessionId, filesTouched });
      } else if (state.done && state.done.ok !== false) {
        resolve({
          ok: true,
          text: state.done.text || state.deltas.join('\n\n'),
          updates: state.deltas.filter((value) => String(value || '').trim()),
          sessionId: state.sessionId,
          filesTouched,
          usage: state.done.usage || {},
        });
      } else {
        const detail = (state.done && state.done.text) || state.stderr.trim() || `exit code ${code}`;
        resolve({ ok: false, ...providerFailure(detail), sessionId: state.sessionId, filesTouched });
      }
    });
    child.stdin.on('error', () => { /* child may exit before reading stdin */ });
    child.stdin.end(prompt);
  });
  return {
    finished,
    stop: () => {
      stopped = true;
      if (child) {
        killTree(child);
        if (!terminationTimer && process.platform !== 'win32') {
          terminationTimer = setTimeout(() => killTree(child, { force: true }), 750);
          terminationTimer.unref?.();
        }
      }
    },
  };
}
