import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeLine } from './chatClaude.mjs';
import { parseCodexLine } from './chatCodex.mjs';
import { assertSafeModel } from './providers.mjs';
import { runTurn } from './chatRun.mjs';

function parseJsonResult(text) {
  let value;
  try { value = JSON.parse(String(text || '').trim()); }
  catch (error) { throw new Error(`provider returned invalid structured JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider structured result must be an object');
  return value;
}

export function structuredTurnCancellationGraceMs(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60 * 1000) {
    throw new TypeError('structured turn timeout must be between 1 ms and 30 minutes');
  }
  return Math.min(2_000, Math.max(100, Math.floor(timeoutMs * 0.05)));
}

function delayOutcome(milliseconds, value) {
  let timer;
  const promise = new Promise((resolve) => { timer = setTimeout(() => resolve(value), milliseconds); });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function awaitBoundedTurn(turn, timeoutMs, provider) {
  const cancellationGraceMs = structuredTurnCancellationGraceMs(timeoutMs);
  const settled = Promise.resolve(turn.finished).then(
    (value) => ({ kind: 'finished', value }),
    (error) => ({ kind: 'failed', error }),
  );
  const deadline = delayOutcome(timeoutMs, { kind: 'timeout' });
  const first = await Promise.race([settled, deadline.promise]);
  deadline.cancel();
  if (first.kind === 'finished') return first.value;
  if (first.kind === 'failed') throw first.error;

  try { turn.stop?.(); } catch { /* closure observation remains authoritative */ }
  const closeDeadline = delayOutcome(cancellationGraceMs, { kind: 'close-timeout' });
  const closed = await Promise.race([settled, closeDeadline.promise]);
  closeDeadline.cancel();
  if (closed.kind === 'close-timeout') {
    throw new Error(
      `${provider} structured turn did not close within its ${cancellationGraceMs} ms cancellation grace`,
    );
  }
  const duration = timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs} ms`;
  throw new Error(`${provider} structured turn timed out after ${duration}`);
}

export function buildStructuredCodexArgs(schemaFile, options = {}) {
  const effort = options.reasoningEffort || 'medium';
  if (!['low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error(`invalid reasoning effort: ${effort}`);
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '--skip-git-repo-check',
    '--output-schema', schemaFile,
    '-c', `model_reasoning_effort="${effort}"`,
  ];
  if ((options.platform || process.platform) === 'win32') args.push('-c', 'windows.sandbox="unelevated"');
  const model = assertSafeModel(options.model);
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

export function buildStructuredClaudeArgs(schema, options = {}) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'dontAsk', '--tools', '', '--strict-mcp-config',
    '--disable-slash-commands', '--settings', JSON.stringify({ disableAllHooks: true }),
    '--no-session-persistence', '--max-turns', '1',
    '--json-schema', JSON.stringify(schema),
  ];
  const model = assertSafeModel(options.model);
  if (model) args.push('--model', model);
  return args;
}

export async function runStructuredTurn({
  provider, status, schema, prompt, model = null, timeoutMs = 10 * 60 * 1000,
  maxInputTokens = null, runTurnFn = runTurn, validate = (value) => value,
} = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('structured provider must be codex or claude');
  if (!status?.installed || !status?.authenticated) throw new Error(`${provider} is not installed and authenticated`);
  if (status.capabilities?.structuredOutput === false) throw new Error(`${provider} CLI must be upgraded before Scout can use bounded structured output`);
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-structured-'));
  const schemaFile = path.join(taskDir, 'schema.json');
  fs.writeFileSync(schemaFile, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  try {
    const args = provider === 'codex'
      ? buildStructuredCodexArgs(schemaFile, { model })
      : buildStructuredClaudeArgs(schema, { model });
    const turn = runTurnFn({
      command: status.executable, args, prompt, cwd: taskDir, env: status.env,
      parseLine: provider === 'codex' ? parseCodexLine : parseClaudeLine,
      timeoutMs,
    });
    const result = await awaitBoundedTurn(turn, timeoutMs, provider);
    if (!result.ok) throw new Error(result.error || `${provider} structured turn failed`);
    const inputTokens = Number(result.usage?.input_tokens ?? result.usage?.inputTokens ?? 0);
    if (maxInputTokens != null && inputTokens > maxInputTokens) {
      throw new Error(`${provider} structured turn exceeded its ${maxInputTokens.toLocaleString()} input-token cap (${inputTokens.toLocaleString()})`);
    }
    const value = validate(parseJsonResult(result.text));
    return { ok: true, value, usage: result.usage || {}, provider };
  } finally {
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
}
