import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseClaudeLine } from './chatClaude.mjs';
import { runTurn } from './chatRun.mjs';
import {
  buildStructuredClaudeArgs,
  buildStructuredCodexArgs,
  ProviderLifecycleUnclosedError,
  runStructuredTurn,
} from './structuredTurn.mjs';
import { providerRemoteHealthSignal } from './providers.mjs';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-cli.mjs');

test('structured Codex is ephemeral, read-only, rule-free and schema constrained', () => {
  const args = buildStructuredCodexArgs('C:/temp/schema.json', { platform: 'win32' });
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-schema', '--skip-git-repo-check']) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(args.includes('windows.sandbox="unelevated"'));
  assert.equal(args.at(-1), '-');
});

test('structured Claude is one-turn, no-tools and schema constrained', () => {
  const args = buildStructuredClaudeArgs(schema);
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.deepEqual(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2), ['--max-turns', '1']);
  assert.ok(args.includes('--json-schema'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args.includes('--bare'), false);
  assert.ok(args.includes('--disable-slash-commands'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true });
  assert.ok(args.includes('dontAsk'));
});

test('structured turns run in a disposable directory and validate JSON', async () => {
  let captured;
  const result = await runStructuredTurn({
    provider: 'codex', schema, prompt: 'synthetic',
    status: { installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } },
    runTurnFn: (options) => {
      captured = options;
      return { finished: Promise.resolve({ ok: true, text: '{"answer":"bounded"}', usage: { input_tokens: 10 } }) };
    },
    validate: (value) => ({ ...value, checked: true }),
  });
  assert.deepEqual(result.value, { answer: 'bounded', checked: true });
  assert.equal(captured.prompt, 'synthetic');
  assert.equal(fs.existsSync(captured.cwd), false);
});

test('structured turns reject malformed output and unsupported CLIs', async () => {
  const status = { installed: true, authenticated: true, executable: 'claude', capabilities: { structuredOutput: true } };
  await assert.rejects(runStructuredTurn({
    provider: 'claude', status, schema, prompt: 'x',
    runTurnFn: () => ({ finished: Promise.resolve({ ok: true, text: 'not json' }) }),
  }), /invalid structured JSON/);
  await assert.rejects(runStructuredTurn({
    provider: 'claude', status: { ...status, capabilities: { structuredOutput: false } }, schema, prompt: 'x',
  }), /must be upgraded/);
  await assert.rejects(runStructuredTurn({
    provider: 'claude', status, schema, prompt: 'x', maxInputTokens: 10,
    runTurnFn: () => ({ finished: Promise.resolve({ ok: true, text: '{"answer":"x"}', usage: { input_tokens: 11 } }) }),
  }), /exceeded its 10 input-token cap/);
});

test('structured provider failures cross the real boundary as safe distinct health classes', async () => {
  const status = {
    installed: true,
    authenticated: true,
    executable: 'codex',
    capabilities: { structuredOutput: true },
  };
  const cases = [
    [
      '401 Unauthorized for person@example.test token=secret',
      { kind: 'remote-auth-failure', source: 'provider-operation', reasonCode: 'authentication-required' },
    ],
    [
      `request failed: ENETUNREACH ${['', 'Users', 'example', 'private.json'].join('/')}`,
      { kind: 'network-failure', source: 'provider-operation', reasonCode: 'network-unavailable' },
    ],
    [
      '429 Too Many Requests for account person@example.test',
      { kind: 'rate-limit', source: 'provider-operation', reasonCode: 'rate-limited' },
    ],
    [
      `unsupported CLI version: unknown option --output-schema at ${['', 'Users', 'example', 'bin', 'codex'].join('/')}`,
      { kind: 'cli-update', source: 'provider-operation', reasonCode: 'cli-update-required' },
    ],
    [
      `500 provider body token=secret person@example.test ${['', 'Users', 'example', 'private.json'].join('/')}`,
      { kind: 'provider-failure', source: 'provider-operation', reasonCode: 'provider-error' },
    ],
  ];

  for (const [rawFailure, expectedSignal] of cases) {
    const error = await runStructuredTurn({
      provider: 'codex',
      status,
      schema,
      prompt: 'synthetic',
      runTurnFn: () => ({ finished: Promise.resolve({ ok: false, error: rawFailure }) }),
    }).then(
      () => null,
      (caught) => caught,
    );

    assert.ok(error instanceof Error);
    assert.deepEqual(providerRemoteHealthSignal(error), expectedSignal);
    assert.doesNotMatch(
      `${error.message} ${JSON.stringify(error)}`,
      /person@|token|secret|Users|private|stdout|stderr|body/i,
    );
  }
});

test('real turn adapter preserves a bounded remote-auth reason through structured health', async () => {
  const error = await runStructuredTurn({
    provider: 'codex',
    status: {
      installed: true,
      authenticated: true,
      executable: 'codex',
      capabilities: { structuredOutput: true },
    },
    schema,
    prompt: 'AUTH_FAIL',
    runTurnFn: (options) => runTurn({
      ...options,
      command: process.execPath,
      args: [FAKE],
      parseLine: parseClaudeLine,
    }),
  }).then(
    () => null,
    (caught) => caught,
  );

  assert.equal(error?.reasonCode, 'authentication-required');
  assert.deepEqual(providerRemoteHealthSignal(error), {
    kind: 'remote-auth-failure',
    source: 'provider-operation',
    reasonCode: 'authentication-required',
  });
  assert.doesNotMatch(`${error.message} ${JSON.stringify(error)}`, /401|person@example|secret|token/i);
});

test('structured turns wait for adapter closure after stopping a timed-out turn', { timeout: 1_000 }, async () => {
  const lifecycle = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  await assert.rejects(runStructuredTurn({
    provider: 'codex',
    status: { installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } },
    schema,
    prompt: 'synthetic',
    timeoutMs: 25,
    runTurnFn: () => ({
      finished,
      stop() {
        lifecycle.push('stop');
        setTimeout(() => {
          lifecycle.push('closed');
          finish({ ok: false, error: 'stopped' });
        }, 20);
      },
    }),
  }), /timed out after 25 ms/);
  lifecycle.push('rejected');
  assert.deepEqual(lifecycle, ['stop', 'closed', 'rejected']);
});

test('structured turns expose cancellable close-gated ownership and output limits', async () => {
  let finish;
  let stopped = 0;
  let received;
  const finished = new Promise((resolve) => { finish = resolve; });
  const operation = runStructuredTurn({
    provider: 'codex',
    status: { installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } },
    schema,
    prompt: 'synthetic',
    maxOutputBytes: 1024,
    maxOutputLines: 12,
    maxLineBytes: 256,
    runTurnFn: (options) => {
      received = options;
      return {
        finished,
        stop() {
          stopped += 1;
          finish({ ok: false, stopped: true, error: 'stopped' });
        },
      };
    },
  });
  assert.equal(typeof operation.stop, 'function');
  assert.ok(operation.closed instanceof Promise);
  operation.stop();
  await assert.rejects(operation, /provider operation failed/);
  await operation.closed;
  assert.equal(stopped, 1);
  assert.equal(received.maxOutputBytes, 1024);
  assert.equal(received.maxOutputLines, 12);
  assert.equal(received.maxLineBytes, 256);
});

test('structured turns expose unresolved closure as a distinct fail-closed outcome', { timeout: 1_000 }, async () => {
  let stopped = 0;
  let taskDirectory;
  const error = await runStructuredTurn({
    provider: 'codex',
    status: { installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } },
    schema,
    prompt: 'synthetic',
    timeoutMs: 10,
    runTurnFn: ({ cwd }) => {
      taskDirectory = cwd;
      return {
        finished: new Promise(() => {}),
        stop() { stopped += 1; },
      };
    },
  }).then(
    () => null,
    (caught) => caught,
  );

  assert.ok(error instanceof ProviderLifecycleUnclosedError);
  assert.equal(stopped, 1);
  let closureObserved = false;
  error.closure.then(() => { closureObserved = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closureObserved, false);
  assert.equal(fs.existsSync(taskDirectory), true);
  fs.rmSync(taskDirectory, { recursive: true, force: true });
});
