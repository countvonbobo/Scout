import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgs, parseCodexLine } from './chatCodex.mjs';

test('buildCodexArgs: fresh session reads prompt from stdin', () => {
  assert.deepEqual(buildCodexArgs(null, { platform: 'linux' }), {
    command: process.platform === 'win32' ? 'codex.cmd' : 'codex',
    args: [
      'exec', '--json',
      '-c', 'model_reasoning_effort="high"',
      '--sandbox', 'workspace-write', '--skip-git-repo-check', '-',
    ],
  });
});

test('buildCodexArgs: resume follows exec-level flags, rejects bad ids', () => {
  const { args } = buildCodexArgs('thread-42', { platform: 'linux' });
  assert.deepEqual(args, [
    'exec', '--json',
    '-c', 'model_reasoning_effort="high"',
    '--sandbox', 'workspace-write', '--skip-git-repo-check',
    'resume', 'thread-42', '-',
  ]);
  assert.ok(buildCodexArgs(null, { model: 'gpt-example' }).args.includes('gpt-example'));
  assert.throws(() => buildCodexArgs('x; echo pwned'), /invalid session id/i);
  const windows = buildCodexArgs(null, { platform: 'win32' });
  assert.ok(windows.args.includes('windows.sandbox="unelevated"'));
});

test('parseCodexLine: current shape', () => {
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ type: 'thread.started', thread_id: 't-1' })),
    [{ kind: 'session', sessionId: 't-1' }],
  );
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Hi.' } })),
    [{ kind: 'delta', text: 'Hi.' }],
  );
  assert.deepEqual(
    parseCodexLine(JSON.stringify({
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: 'applications/acme/cv.typ' }, { path: 'applications/acme/outreach.md' }] },
    })),
    [
      { kind: 'tool', label: 'Editing a file', file: 'applications/acme/cv.typ', mutatesFile: true, activity: 'writing' },
      { kind: 'tool', label: 'Editing a file', file: 'applications/acme/outreach.md', mutatesFile: true, activity: 'writing' },
    ],
  );
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'typst compile' } })),
    [{ kind: 'tool', label: 'Running a provider command', file: null, activity: 'thinking' }],
  );
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9 } })),
    [{ kind: 'done', text: '', ok: true, usage: { input_tokens: 9 } }],
  );
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } })),
    [{ kind: 'done', text: '', ok: false, usage: {} }],
  );
});

test('parseCodexLine: legacy shape', () => {
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ msg: { type: 'session_configured', session_id: 's-9' } })),
    [{ kind: 'session', sessionId: 's-9' }],
  );
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ msg: { type: 'agent_message', message: 'Hello.' } })),
    [{ kind: 'delta', text: 'Hello.' }],
  );
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ msg: { type: 'task_complete', last_agent_message: 'Done.' } })),
    [{ kind: 'done', text: 'Done.', ok: true, usage: {} }],
  );
  assert.deepEqual(
    parseCodexLine(JSON.stringify({ msg: { type: 'error', message: 'bad' } })),
    [{ kind: 'done', text: '', ok: false, usage: {} }],
  );
});

test('parseCodexLine: malformed and unknown lines yield []', () => {
  assert.deepEqual(parseCodexLine('{oops'), []);
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: 'item.started', item: {} })), []);
});
