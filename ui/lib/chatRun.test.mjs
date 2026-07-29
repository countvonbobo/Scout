import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn } from './chatRun.mjs';
import { parseClaudeLine } from './chatClaude.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-cli.mjs');
const REPO = path.resolve(HERE, '..', '..');

function fakeTurn(prompt, extra = {}) {
  return runTurn({
    command: process.execPath,
    args: [FAKE],
    prompt,
    cwd: REPO,
    parseLine: parseClaudeLine,
    ...extra,
  });
}

test('happy path: streams events, captures session, text, files, usage', async () => {
  const events = [];
  const { finished } = fakeTurn('hello world', { onEvent: (e) => events.push(e) });
  const r = await finished;
  assert.equal(r.ok, true);
  assert.equal(r.text, 'echo: hello world');
  assert.equal(r.sessionId, 'fake-sess-1');
  assert.deepEqual(r.filesTouched, ['applications/acme-role-2026-07/cv.typ']);
  assert.equal(r.usage.costUsd, 0.01);
  assert.ok(events.some((e) => e.kind === 'delta'));
  assert.ok(events.some((e) => e.kind === 'tool'));
});

test('non-zero exit without a done event returns only a bounded failure code', async () => {
  const r = await fakeTurn('FAIL').finished;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Provider turn failed.');
  assert.equal(r.reasonCode, 'provider-error');
  assert.doesNotMatch(JSON.stringify(r), /fake failure detail/);
});

test('raw provider authentication failures become a bounded reason before diagnostics are discarded', async () => {
  const r = await fakeTurn('AUTH_FAIL').finished;
  assert.deepEqual(r, {
    ok: false,
    error: 'Provider authentication is required.',
    reasonCode: 'authentication-required',
    sessionId: null,
    filesTouched: [],
  });
  assert.doesNotMatch(JSON.stringify(r), /401|person@example|secret|unauthorized/i);
});

test('non-zero exit remains a failure even after a successful done event', async () => {
  const r = await fakeTurn('DONE_THEN_FAIL').finished;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Provider turn failed.');
  assert.equal(r.reasonCode, 'provider-error');
  assert.doesNotMatch(JSON.stringify(r), /not actually successful/);
});

test('stop() kills the child and reports stopped', async () => {
  const turn = fakeTurn('HANG');
  setTimeout(() => turn.stop(), 300);
  const r = await turn.finished;
  assert.equal(r.ok, false);
  assert.equal(r.stopped, true);
});

test('timeout resolves with a timeout error', async () => {
  const r = await fakeTurn('HANG', { timeoutMs: 500 }).finished;
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
});

test('output byte and individual-line limits stop the provider turn', async () => {
  const result = await fakeTurn('OVER_OUTPUT', {
    timeoutMs: 5_000,
    maxOutputBytes: 256,
    maxOutputLines: 8,
    maxLineBytes: 64,
  }).finished;
  assert.equal(result.ok, false);
  assert.equal(result.outputExceeded, true);
  assert.equal(result.error, 'Provider output exceeded the safe limit.');
  assert.equal(result.reasonCode, 'output-limit');
});

test('stop escalates a stubborn provider process group to forced closure', async () => {
  const turn = fakeTurn('STUBBORN');
  await new Promise((resolve) => setTimeout(resolve, 50));
  turn.stop();
  const result = await Promise.race([
    turn.finished,
    new Promise((resolve) => setTimeout(() => resolve('still-running'), 2_000)),
  ]);
  assert.notEqual(result, 'still-running');
  assert.equal(result.stopped, true);
});

test('tool events expose only bounded activity while touched files stay relative', async () => {
  const events = [];
  const result = await fakeTurn('hello', { onEvent: (event) => events.push(event) }).finished;
  const tool = events.find((event) => event.kind === 'tool');
  assert.deepEqual(tool, { kind: 'tool', label: 'Editing a file', activity: 'writing' });
  assert.deepEqual(result.filesTouched, ['applications/acme-role-2026-07/cv.typ']);
});

test('missing binary resolves with a not-found error', async () => {
  const r = await runTurn({
    command: 'definitely-not-a-real-cli-xyz',
    args: [],
    prompt: 'hi',
    cwd: REPO,
    parseLine: parseClaudeLine,
  }).finished;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Provider CLI is unavailable.');
  assert.equal(r.reasonCode, 'provider-unavailable');
});

test('tool paths on another Windows drive are excluded', { skip: process.platform !== 'win32' }, async () => {
  const otherDrive = path.parse(REPO).root.toLowerCase().startsWith('c:') ? 'D:\\secret.txt' : 'C:\\secret.txt';
  const r = await fakeTurn('hello', {
    parseLine: (line) => parseClaudeLine(line).map((event) => (
      event.kind === 'tool' ? { ...event, file: otherDrive } : event
    )),
  }).finished;
  assert.equal(r.ok, true);
  assert.deepEqual(r.filesTouched, []);
});
