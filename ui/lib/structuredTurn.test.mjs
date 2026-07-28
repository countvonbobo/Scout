import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { buildStructuredClaudeArgs, buildStructuredCodexArgs, runStructuredTurn } from './structuredTurn.mjs';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

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

test('structured turns enforce their own bounded deadline and stop an unresponsive adapter', { timeout: 1_000 }, async () => {
  let stopped = false;
  await assert.rejects(runStructuredTurn({
    provider: 'codex',
    status: { installed: true, authenticated: true, executable: 'codex', capabilities: { structuredOutput: true } },
    schema,
    prompt: 'synthetic',
    timeoutMs: 25,
    runTurnFn: () => ({
      finished: new Promise(() => {}),
      stop() { stopped = true; },
    }),
  }), /timed out after 25 ms/);
  assert.equal(stopped, true);
});
