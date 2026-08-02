import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, parseClaudeLine } from './chatClaude.mjs';

test('buildClaudeArgs: fresh session', () => {
  assert.deepEqual(buildClaudeArgs(null), {
    command: process.platform === 'win32' ? 'claude.cmd' : 'claude',
    args: [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'acceptEdits',
    ],
  });
  assert.deepEqual(buildClaudeArgs(null, { model: 'claude-example' }).args.slice(-2), ['--model', 'claude-example']);
});

test('buildClaudeArgs: unattended scans can use Claude auto permissions', () => {
  const built = buildClaudeArgs(null, { permissionMode: 'auto' });
  assert.deepEqual(built.args.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto']);
  assert.throws(() => buildClaudeArgs(null, { permissionMode: 'bypassPermissions' }), /invalid Claude permission mode/);
});

test('buildClaudeArgs: resume appends --resume, rejects bad ids', () => {
  const { args } = buildClaudeArgs('abc-123-DEF');
  assert.deepEqual(args.slice(-2), ['--resume', 'abc-123-DEF']);
  assert.throws(() => buildClaudeArgs('bad id; rm -rf'), /invalid session id/i);
});

test('parseClaudeLine: init event yields session', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  assert.deepEqual(parseClaudeLine(line), [{ kind: 'session', sessionId: 'sess-1' }]);
});

test('parseClaudeLine: assistant message yields deltas and tools', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'C:/repo/applications/acme/cv.typ' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'C:/repo/profile/context.md' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'typst compile …' } },
      ],
    },
  });
  assert.deepEqual(parseClaudeLine(line), [
    { kind: 'delta', text: 'Working on it.' },
    { kind: 'tool', label: 'Editing a file', file: 'C:/repo/applications/acme/cv.typ', mutatesFile: true, activity: 'writing' },
    { kind: 'tool', label: 'Using provider tools', file: 'C:/repo/profile/context.md', mutatesFile: false, activity: 'searching' },
    { kind: 'tool', label: 'Using provider tools', file: null, mutatesFile: false, activity: 'thinking' },
  ]);
});

test('parseClaudeLine: result yields session then done with usage', () => {
  const line = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'All done.',
    session_id: 'sess-1', total_cost_usd: 0.12, usage: { output_tokens: 42 },
  });
  assert.deepEqual(parseClaudeLine(line), [
    { kind: 'session', sessionId: 'sess-1' },
    { kind: 'done', text: 'All done.', ok: true, usage: { costUsd: 0.12, output_tokens: 42 } },
  ]);
});

test('parseClaudeLine: error result has ok false', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' });
  const events = parseClaudeLine(line);
  assert.equal(events.at(-1).ok, false);
  assert.equal(events.at(-1).text, '');
});

test('parseClaudeLine: structured output is the authoritative result text', () => {
  const line = JSON.stringify({ type: 'result', is_error: false, result: 'ignored', structured_output: { answer: 'bounded' } });
  assert.equal(parseClaudeLine(line).at(-1).text, '{"answer":"bounded"}');
});

test('parseClaudeLine: malformed and unknown lines yield []', () => {
  assert.deepEqual(parseClaudeLine('not json {'), []);
  assert.deepEqual(parseClaudeLine(''), []);
  assert.deepEqual(parseClaudeLine(JSON.stringify({ type: 'user' })), []);
});
