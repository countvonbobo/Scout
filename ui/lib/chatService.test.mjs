import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, registerChatRoutes } from './chatService.mjs';
import { parseClaudeLine } from './chatClaude.mjs';
import { emptyChat, loadChat, saveChat } from './chatStore.mjs';
import { HANDOFF_SUMMARY_PROMPT } from './chatPrompts.mjs';
import { interviewPrepPath } from './interviewPrep.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-cli.mjs');
const ID = 'acme-role-2026-07';
const ENTRY = { id: ID, company: 'Acme', role: 'Engineer' };

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
    this.destroyed = false;
    this.writableEnded = false;
    this.finished = new Promise((resolve) => { this.resolveFinished = resolve; });
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
  }

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    this.resolveFinished();
  }

  text() { return this.chunks.join(''); }
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scout-chat-service-'));
}

function routeFixture(root, overrides = {}) {
  const routes = {};
  registerChatRoutes({
    routes,
    repoRoot: root,
    readTracker: () => ({ opportunities: [ENTRY] }),
    providerStatusFn: () => ({ installed: true, authenticated: true, executable: 'provider', env: process.env }),
    providerCataloguesFn: async () => ({
      claude: { state: 'unsupported', models: [] },
      codex: { state: 'unsupported', models: [] },
    }),
    ...overrides,
  });
  return routes;
}

async function callRoute(handler, body, { closeRequest = false } = {}) {
  const req = new EventEmitter();
  const res = new MockResponse();
  handler(req, res, body);
  if (closeRequest) req.emit('close');
  await res.finished;
  return res;
}

function sseEvents(text) {
  return text.trim().split('\n\n').map((block) => {
    const lines = block.split('\n');
    const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    return { event, data: JSON.parse(data) };
  });
}

function fakeBuild(calls, engine) {
  return (resumeId) => {
    calls.push({ engine, resumeId });
    return { command: 'node', args: [FAKE] };
  };
}

test('chat prefills honour per-CV option query parameters', async () => {
  const root = tmpRoot();
  const routes = routeFixture(root);
  const response = new MockResponse();
  routes['GET /api/chat'](
    new EventEmitter(), response, '',
    new URL(`http://127.0.0.1/api/chat?id=${ID}&xyz=0&humanize=1`),
  );
  await response.finished;
  const body = JSON.parse(response.text());
  assert.match(body.prefills.cv, /Do not require Google XYZ/);
  assert.match(body.prefills.cv, /separate natural-voice revision/);
  assert.match(body.prefills.cv, /xyz=false and humanize=true/);
});

// Bug #55: the browser's confirm() answer must reach the write path, and the
// server must not take an arbitrary slug from the query on trust.
async function prefillsFor(root, query = '') {
  const routes = routeFixture(root);
  const response = new MockResponse();
  routes['GET /api/chat'](
    new EventEmitter(), response, '',
    new URL(`http://127.0.0.1/api/chat?id=${ID}${query}`),
  );
  await response.finished;
  return JSON.parse(response.text()).prefills;
}

test('the CV write path is keyed by the opportunity, so a legacy company folder is never written over by default', async () => {
  const root = tmpRoot();
  // A legacy company folder exists on disk and is shared by two tracked roles.
  fs.mkdirSync(path.join(root, 'applications', 'acme'), { recursive: true });
  fs.writeFileSync(path.join(root, 'applications', 'acme', 'cv.typ'), 'other role\n');
  const routes = {};
  registerChatRoutes({
    routes,
    repoRoot: root,
    readTracker: () => ({ opportunities: [ENTRY, { id: 'acme-other-2026-07', company: 'Acme', role: 'Other' }] }),
    providerStatusFn: () => ({ installed: true, authenticated: true, executable: 'provider', env: process.env }),
  });
  const response = new MockResponse();
  // "Start fresh": the client passes this opportunity's own slug.
  routes['GET /api/chat'](
    new EventEmitter(), response, '',
    new URL(`http://127.0.0.1/api/chat?id=${ID}&artifact=${ID}`),
  );
  await response.finished;
  const prefills = JSON.parse(response.text()).prefills;
  assert.match(prefills.cv, new RegExp(`applications/${ID}/cv\\.typ`));
  assert.match(prefills.cv, new RegExp(`applications/${ID}/cv-evidence\\.json`));
  assert.doesNotMatch(prefills.cv, /applications\/acme\//);
  // The other role's file was never a write target and is untouched.
  assert.equal(fs.readFileSync(path.join(root, 'applications', 'acme', 'cv.typ'), 'utf8'), 'other role\n');
});

test('an explicitly reused legacy folder is honoured, but an arbitrary requested slug is rejected', async () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'applications', 'acme'), { recursive: true });
  fs.writeFileSync(path.join(root, 'applications', 'acme', 'cv.typ'), 'legacy\n');
  // "Open it as-is": the legacy slug is one this server's own resolver produces.
  const reused = await prefillsFor(root, '&artifact=acme');
  assert.match(reused.cv, /applications\/acme\/cv\.typ/);
  // An attacker-supplied slug is not a slug the resolver would produce, so it is
  // discarded and the server's own resolution is used instead.
  const forged = await prefillsFor(root, '&artifact=someone-elses-folder');
  assert.doesNotMatch(forged.cv, /someone-elses-folder/);
  assert.match(forged.cv, /applications\/acme\/cv\.typ/);
  // With no legacy folder on disk at all, resolution is the per-role folder.
  const clean = await prefillsFor(tmpRoot(), '&artifact=../../etc/passwd');
  assert.match(clean.cv, new RegExp(`applications/${ID}/cv\\.typ`));
  assert.doesNotMatch(clean.cv, /passwd/);
});

test('interview prep GET uses a separate transcript and returns the saved pack without running a provider', async () => {
  const root = tmpRoot();
  const job = emptyChat('claude');
  job.messages.push({ role: 'user', text: 'job conversation' });
  const prep = emptyChat('codex');
  prep.messages.push({ role: 'user', text: 'prep conversation' });
  saveChat(root, ID, job);
  saveChat(root, ID, prep, 'interview-prep');
  const pack = interviewPrepPath(root, ENTRY);
  fs.mkdirSync(path.dirname(pack), { recursive: true });
  fs.writeFileSync(pack, '# Interview prep\n\n## My notes\nRemember this.\n');

  const response = new MockResponse();
  routeFixture(root)['GET /api/chat'](
    new EventEmitter(), response, '',
    new URL(`http://127.0.0.1/api/chat?id=${ID}&purpose=interview-prep`),
  );
  await response.finished;
  const body = JSON.parse(response.text());
  assert.equal(body.purpose, 'interview-prep');
  assert.equal(body.chat.messages[0].text, 'prep conversation');
  assert.match(body.prefills.interviewPrep, /Use \$interview-prep/);
  assert.equal(body.artifact.exists, true);
  assert.match(body.artifact.content, /Remember this/);
  assert.equal(loadChat(root, ID).messages[0].text, 'job conversation');
});

test('interview prep sends a pinned prompt and persists only to the prep transcript', async () => {
  const root = tmpRoot();
  let captured;
  const routes = routeFixture(root, {
    runTurnFn: (options) => {
      captured = options;
      return {
        stop() {},
        finished: Promise.resolve({ ok: true, text: 'Prepared.', updates: ['Prepared.'], sessionId: 'prep-session', filesTouched: [], usage: {} }),
      };
    },
  });
  const response = await callRoute(
    routes['POST /api/chat/send'],
    JSON.stringify({ id: ID, purpose: 'interview-prep', engine: 'codex', text: 'Prepare me' }),
  );
  assert.equal(sseEvents(response.text()).at(-1).event, 'done');
  assert.match(captured.prompt, /authoritative selected opportunity/);
  assert.match(captured.prompt, /Never switch to another opportunity/);
  assert.match(captured.prompt, /applications\/acme\/interview-prep\/acme-role-2026-07\.md/);
  assert.equal(loadChat(root, ID), null);
  const saved = loadChat(root, ID, 'interview-prep');
  assert.equal(saved.cliSessionId, 'prep-session');
  assert.equal(saved.messages.at(-1).text, 'Prepared.');
});

test('interview prep handoff resumes the separate prep conversation', async () => {
  const root = tmpRoot();
  const prep = emptyChat('claude');
  prep.cliSessionId = 'prep-old-session';
  saveChat(root, ID, prep, 'interview-prep');
  const prompts = [];
  let call = 0;
  const routes = routeFixture(root, {
    runTurnFn: (options) => {
      prompts.push(options.prompt);
      call += 1;
      return {
        stop() {},
        finished: Promise.resolve(call === 1
          ? { ok: true, text: 'Prep handoff summary', sessionId: 'prep-old-session', filesTouched: [] }
          : { ok: true, text: 'Continuing prep', sessionId: 'prep-new-session', filesTouched: [] }),
      };
    },
  });
  const response = await callRoute(
    routes['POST /api/chat/handoff'],
    JSON.stringify({ id: ID, purpose: 'interview-prep' }),
  );
  assert.equal(sseEvents(response.text()).at(-1).event, 'done');
  assert.equal(loadChat(root, ID), null);
  const saved = loadChat(root, ID, 'interview-prep');
  assert.equal(saved.engine, 'codex');
  assert.equal(saved.cliSessionId, 'prep-new-session');
  assert.match(prompts[1], /dedicated interview-prep agent/);
  assert.match(prompts[1], /Prep handoff summary/);
});

test('job and prep conversations share one running slot per opportunity', async () => {
  const root = tmpRoot();
  let finish;
  const routes = routeFixture(root, {
    runTurnFn: () => ({
      stop() {},
      finished: new Promise((resolve) => { finish = resolve; }),
    }),
  });
  const prepPromise = callRoute(
    routes['POST /api/chat/send'],
    JSON.stringify({ id: ID, purpose: 'interview-prep', engine: 'claude', text: 'Prepare me' }),
  );
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const job = await callRoute(
    routes['POST /api/chat/send'],
    JSON.stringify({ id: ID, engine: 'codex', text: 'Edit my CV' }),
  );
  assert.equal(job.statusCode, 409);
  assert.match(JSON.parse(job.text()).error, /already running/);
  finish({ ok: true, text: 'Done', sessionId: 'prep-session', filesTouched: [] });
  assert.equal(sseEvents((await prepPromise).text()).at(-1).event, 'done');
});

test('chat routes reject unknown purposes and fit mode in prep chats', async () => {
  const root = tmpRoot();
  const routes = routeFixture(root);
  const get = new MockResponse();
  routes['GET /api/chat'](
    new EventEmitter(), get, '', new URL(`http://127.0.0.1/api/chat?id=${ID}&purpose=other`),
  );
  await get.finished;
  assert.equal(get.statusCode, 400);
  assert.match(JSON.parse(get.text()).error, /invalid chat purpose/);

  const send = await callRoute(
    routes['POST /api/chat/send'],
    JSON.stringify({ id: ID, purpose: 'interview-prep', engine: 'claude', mode: 'fit-assessment', text: 'Assess' }),
  );
  assert.equal(send.statusCode, 400);
  assert.match(JSON.parse(send.text()).error, /belongs to the job conversation/);
});

test('handoff route summarises the old session, starts the other engine, and persists it', { concurrency: false }, async () => {
  const root = tmpRoot();
  const chat = emptyChat('claude');
  chat.cliSessionId = 'old-session';
  saveChat(root, ID, chat);
  const calls = [];
  const oldClaude = ENGINES.claude;
  const oldCodex = ENGINES.codex;
  ENGINES.claude = { build: fakeBuild(calls, 'claude'), parse: parseClaudeLine };
  ENGINES.codex = { build: fakeBuild(calls, 'codex'), parse: parseClaudeLine };

  try {
    const res = await callRoute(
      routeFixture(root)['POST /api/chat/handoff'],
      JSON.stringify({ id: ID }),
      { closeRequest: true },
    );
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /text\/event-stream/);
    const events = sseEvents(res.text());
    assert.deepEqual(events.filter((ev) => ev.event === 'status').map((ev) => ev.data.message), [
      'asking claude for a handoff summary…',
      'starting codex with the summary…',
    ]);
    assert.ok(events.some((ev) => ev.event === 'delta'));
    assert.deepEqual(events.at(-1), { event: 'done', data: { engine: 'codex' } });
    assert.deepEqual(calls, [
      { engine: 'claude', resumeId: 'old-session' },
      { engine: 'codex', resumeId: null },
    ]);

    const saved = loadChat(root, ID);
    assert.equal(saved.engine, 'codex');
    assert.equal(saved.cliSessionId, 'fake-sess-1');
    assert.equal(saved.handoffs.length, 1);
    assert.deepEqual(saved.handoffs[0].from, 'claude');
    assert.deepEqual(saved.handoffs[0].to, 'codex');
    assert.ok(saved.messages.some((m) => m.role === 'system' && m.text.includes(`echo: ${HANDOFF_SUMMARY_PROMPT}`)));
    assert.ok(saved.messages.some((m) => m.role === 'user' && m.text.includes('taking over an in-progress task')));
    assert.ok(saved.messages.some((m) => m.role === 'assistant' && m.text.includes('taking over an in-progress task')));
    assert.deepEqual(saved.filesTouched, ['applications/acme-role-2026-07/cv.typ']);
  } finally {
    ENGINES.claude = oldClaude;
    ENGINES.codex = oldCodex;
  }
});

test('handoff route persists the switch and summary when the replacement turn fails', { concurrency: false }, async () => {
  const root = tmpRoot();
  const chat = emptyChat('claude');
  chat.cliSessionId = 'old-session';
  saveChat(root, ID, chat);
  const oldClaude = ENGINES.claude;
  const oldCodex = ENGINES.codex;
  ENGINES.claude = { build: fakeBuild([], 'claude'), parse: parseClaudeLine };
  ENGINES.codex = {
    build: fakeBuild([], 'codex'),
    parse: (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return []; }
      if (event.type === 'result') return [
        { kind: 'session', sessionId: 'replacement-session' },
        { kind: 'tool', label: 'Edit: applications/acme/failed.typ', file: 'applications/acme/failed.typ', mutatesFile: true },
        { kind: 'done', text: 'replacement failed', ok: false, usage: {} },
      ];
      return [];
    },
  };

  try {
    const res = await callRoute(routeFixture(root)['POST /api/chat/handoff'], JSON.stringify({ id: ID }));
    const events = sseEvents(res.text());
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.message, 'replacement failed');
    assert.equal(events.at(-1).data.engine, 'codex');
    assert.equal(events.at(-1).data.sessionId, 'replacement-session');
    const saved = loadChat(root, ID);
    assert.equal(saved.engine, 'codex');
    assert.equal(saved.cliSessionId, 'replacement-session');
    assert.ok(saved.filesTouched.includes('applications/acme/failed.typ'));
    assert.equal(saved.handoffs.length, 1);
    assert.ok(saved.messages.some((m) => m.role === 'system' && m.text.startsWith('handoff summary:')));
    assert.equal(saved.messages.at(-1).text, 'replacement failed');
  } finally {
    ENGINES.claude = oldClaude;
    ENGINES.codex = oldCodex;
  }
});

test('handoff route rejects malformed JSON and chats without a resumable session', { concurrency: false }, async () => {
  const root = tmpRoot();
  const route = routeFixture(root)['POST /api/chat/handoff'];
  const badJson = await callRoute(route, '{');
  assert.equal(badJson.statusCode, 400);
  assert.deepEqual(JSON.parse(badJson.text()), { error: 'bad json' });

  const missing = await callRoute(route, JSON.stringify({ id: ID }));
  assert.equal(missing.statusCode, 400);
  assert.deepEqual(JSON.parse(missing.text()), { error: 'no conversation to hand off yet' });
});

test('a failed cold start keeps history but allows retrying with the other engine', { concurrency: false }, async () => {
  const root = tmpRoot();
  const routes = routeFixture(root);
  const calls = [];
  const oldClaude = ENGINES.claude;
  const oldCodex = ENGINES.codex;
  ENGINES.claude = { build: fakeBuild(calls, 'claude'), parse: parseClaudeLine };
  ENGINES.codex = { build: fakeBuild(calls, 'codex'), parse: parseClaudeLine };

  try {
    const failed = await callRoute(
      routes['POST /api/chat/send'],
      JSON.stringify({ id: ID, engine: 'claude', text: 'FAIL' }),
    );
    assert.equal(sseEvents(failed.text()).at(-1).event, 'error');

    const req = new EventEmitter();
    const get = new MockResponse();
    routes['GET /api/chat'](req, get, '', new URL(`http://127.0.0.1/api/chat?id=${ID}`));
    await get.finished;
    const visible = JSON.parse(get.text());
    assert.equal(visible.exists, true);
    assert.equal(visible.chat.engine, null);
    assert.ok(visible.chat.messages.some((message) => message.role === 'system'));

    const retried = await callRoute(
      routes['POST /api/chat/send'],
      JSON.stringify({ id: ID, engine: 'codex', text: 'hello' }),
    );
    assert.equal(sseEvents(retried.text()).at(-1).event, 'done');
    const saved = loadChat(root, ID);
    assert.equal(saved.engine, 'codex');
    assert.equal(saved.cliSessionId, 'fake-sess-1');
    assert.deepEqual(calls.map((call) => call.engine), ['claude', 'codex']);
  } finally {
    ENGINES.claude = oldClaude;
    ENGINES.codex = oldCodex;
  }
});

test('a failed send preserves emitted session and file metadata for retry', { concurrency: false }, async () => {
  const root = tmpRoot();
  const oldClaude = ENGINES.claude;
  ENGINES.claude = {
    build: fakeBuild([], 'claude'),
    parse: (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return []; }
      if (event.type !== 'result') return [];
      return [
        { kind: 'session', sessionId: 'failed-session' },
        { kind: 'tool', label: 'Edit: applications/acme/partial.typ', file: 'applications/acme/partial.typ', mutatesFile: true },
        { kind: 'done', text: 'failed after editing', ok: false, usage: {} },
      ];
    },
  };

  try {
    const response = await callRoute(
      routeFixture(root)['POST /api/chat/send'],
      JSON.stringify({ id: ID, engine: 'claude', text: 'hello' }),
    );
    assert.equal(sseEvents(response.text()).at(-1).event, 'error');
    const saved = loadChat(root, ID);
    assert.equal(saved.cliSessionId, 'failed-session');
    assert.deepEqual(saved.filesTouched, ['applications/acme/partial.typ']);
  } finally {
    ENGINES.claude = oldClaude;
  }
});

test('a CV writing turn triggers installed-app quality validation when evidence exists', { concurrency: false }, async () => {
  const root = tmpRoot();
  const app = path.join(root, 'applications', 'acme-role-2026-07');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'cv.typ'), '#show: cv.with(name: "Example")\n');
  fs.writeFileSync(path.join(app, 'cv-evidence.json'), '{"schemaVersion":1}\n');
  const qualityCalls = [];
  const oldClaude = ENGINES.claude;
  ENGINES.claude = { build: fakeBuild([], 'claude'), parse: parseClaudeLine };
  try {
    const routes = routeFixture(root, {
      runCvQualityFn: (repoRoot, slug, options) => qualityCalls.push({ repoRoot, slug, options }),
    });
    await callRoute(routes['POST /api/chat/send'], JSON.stringify({ id: ID, engine: 'claude', text: 'hello' }));
    assert.deepEqual(qualityCalls, [{ repoRoot: root, slug: 'acme-role-2026-07', options: { locale: 'en-GB' } }]);
    const saved = loadChat(root, ID);
    assert.ok(saved.filesTouched.includes('applications/acme-role-2026-07/cv-quality.json'));
    assert.ok(saved.filesTouched.includes('applications/acme-role-2026-07/cv.pdf'));
  } finally {
    ENGINES.claude = oldClaude;
  }
});

test('bounded fit assessment receives the selected job, identifies its provider and persists without touched files', async () => {
  const root = tmpRoot();
  let captured;
  const routes = routeFixture(root, {
    runStructuredTurnFn: async (options) => {
      captured = options;
      return {
        value: { summary: 'Good evidence-led fit.', strengths: ['Software delivery'], evidenceGaps: ['Scale unknown'], mandatoryGaps: [], recommendation: 'Verify scale.' },
        usage: { input_tokens: 20 },
      };
    },
  });
  const response = await callRoute(
    routes['POST /api/chat/send'],
    JSON.stringify({ id: ID, engine: 'claude', mode: 'fit-assessment', text: 'Assess fit and evidence gaps.' }),
  );
  const events = sseEvents(response.text());
  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.at(-1).data.engine, 'claude');
  assert.deepEqual(events.at(-1).data.filesTouched, []);
  assert.equal(captured.provider, 'claude');
  assert.match(captured.prompt, /"id":"acme-role-2026-07"/);
  assert.match(captured.prompt, /"company":"Acme"/);

  const saved = loadChat(root, ID);
  assert.equal(saved.engine, 'claude');
  assert.equal(saved.bounded, true);
  assert.deepEqual(saved.filesTouched, []);
  assert.match(saved.messages.at(-1).text, /Good evidence-led fit/);

  const get = new MockResponse();
  routes['GET /api/chat'](new EventEmitter(), get, '', new URL(`http://127.0.0.1/api/chat?id=${ID}`));
  await get.finished;
  assert.equal(JSON.parse(get.text()).chat.engine, 'claude');
});

test('completed assistant updates persist as separate chat messages', async () => {
  const root = tmpRoot();
  const checkpoints = [];
  const runTurnFn = () => ({
    stop() {},
    finished: Promise.resolve({
      ok: true, text: 'First update\n\nSecond update', updates: ['First update', 'Second update'],
      sessionId: 'session-one', filesTouched: [], usage: {},
    }),
  });
  const routes = routeFixture(root, { runTurnFn, onCheckpoint: (reason) => checkpoints.push(reason) });
  const response = await callRoute(routes['POST /api/chat/send'], JSON.stringify({ id: ID, engine: 'codex', text: 'Help me' }));
  const done = sseEvents(response.text()).find((event) => event.event === 'done');
  assert.deepEqual(done.data.updates, ['First update', 'Second update']);
  const saved = loadChat(root, ID);
  assert.deepEqual(saved.messages.filter((message) => message.role === 'assistant').map((message) => message.text), ['First update', 'Second update']);
  assert.deepEqual(checkpoints, [`save chat - ${ID}`]);
});

test('handoff build errors end SSE and release the running slot', { concurrency: false }, async () => {
  const root = tmpRoot();
  const chat = emptyChat('claude');
  chat.cliSessionId = 'old-session';
  saveChat(root, ID, chat);
  const oldClaude = ENGINES.claude;
  ENGINES.claude = { build: () => { throw new Error('bad saved session'); }, parse: parseClaudeLine };

  try {
    const routes = routeFixture(root);
    const response = await callRoute(routes['POST /api/chat/handoff'], JSON.stringify({ id: ID }));
    assert.deepEqual(sseEvents(response.text()).at(-1), {
      event: 'error', data: { message: 'summary failed: bad saved session' },
    });
    const get = new MockResponse();
    routes['GET /api/chat'](new EventEmitter(), get, '', new URL(`http://127.0.0.1/api/chat?id=${ID}`));
    await get.finished;
    assert.equal(JSON.parse(get.text()).busy, false);
  } finally {
    ENGINES.claude = oldClaude;
  }
});

test('handoff save errors end SSE and release the running slot', { concurrency: false }, async () => {
  const root = tmpRoot();
  const chat = emptyChat('claude');
  chat.cliSessionId = 'old-session';
  saveChat(root, ID, chat);
  const oldClaude = ENGINES.claude;
  ENGINES.claude = { build: fakeBuild([], 'claude'), parse: parseClaudeLine };

  try {
    const routes = routeFixture(root, {
      saveChatFn: () => { throw new Error('disk full'); },
    });
    const response = await callRoute(routes['POST /api/chat/handoff'], JSON.stringify({ id: ID }));
    assert.deepEqual(sseEvents(response.text()).at(-1), {
      event: 'error', data: { message: 'handoff transcript save failed: disk full' },
    });
    const get = new MockResponse();
    routes['GET /api/chat'](new EventEmitter(), get, '', new URL(`http://127.0.0.1/api/chat?id=${ID}`));
    await get.finished;
    assert.equal(JSON.parse(get.text()).busy, false);
  } finally {
    ENGINES.claude = oldClaude;
  }
});

test('a conversation keeps the model it was started with', async () => {
  const root = tmpRoot();
  let captured;
  const routes = routeFixture(root, {
    runTurnFn: (options) => {
      captured = options;
      return {
        stop() {},
        finished: Promise.resolve({ ok: true, text: 'Done.', updates: ['Done.'], sessionId: 'session-1', filesTouched: [], usage: {} }),
      };
    },
  });
  await callRoute(
    routes['POST /api/chat/send'],
    JSON.stringify({ id: ID, engine: 'claude', model: 'claude-opus-4-8', text: 'Hello' }),
  );
  assert.ok(captured.args.includes('claude-opus-4-8'), 'the chosen model reaches the CLI invocation');
  assert.equal(loadChat(root, ID).model, 'claude-opus-4-8');

  // The CLI session is already bound to that model, so a later request cannot
  // switch it mid-conversation.
  await callRoute(
    routes['POST /api/chat/send'],
    JSON.stringify({ id: ID, engine: 'claude', model: 'claude-haiku-4-5', text: 'Again' }),
  );
  assert.equal(loadChat(root, ID).model, 'claude-opus-4-8');
  assert.equal(captured.args.includes('claude-haiku-4-5'), false);
});

test('an unsafe model identifier is rejected before any turn runs', async () => {
  const root = tmpRoot();
  let ran = false;
  const routes = routeFixture(root, {
    runTurnFn: () => { ran = true; return { stop() {}, finished: Promise.resolve({ ok: true, text: '', updates: [], sessionId: 's', filesTouched: [], usage: {} }) }; },
  });
  const response = await callRoute(
    routes['POST /api/chat/send'],
    JSON.stringify({ id: ID, engine: 'claude', model: 'model & command', text: 'Hello' }),
  );
  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.text()).error, /model is invalid/);
  assert.equal(ran, false);
});

test('the engine picker uses bounded injected catalogues and returns effective defaults', async () => {
  const root = tmpRoot();
  const config = {
    locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London',
    ai: { provider: 'codex', model: null, models: { codex: 'gpt-5.6-terra', claude: null } },
  };
  fs.writeFileSync(path.join(root, 'workspace.json'), `${JSON.stringify(config)}\n`);
  let catalogueChecks = 0;
  const routes = routeFixture(root, {
    providerCataloguesFn: async () => {
      catalogueChecks += 1;
      return {
        codex: {
          state: 'refreshed',
          models: [{ id: 'gpt-5.6-sol', isDefault: true }, { id: 'gpt-5.6-terra' }],
        },
        claude: { state: 'unsupported', models: [] },
      };
    },
  });
  const response = new MockResponse();
  await routes['GET /api/engines'](
    new EventEmitter(), response, '', new URL('http://127.0.0.1/api/engines'),
  );
  await response.finished;
  const body = JSON.parse(response.text());
  assert.deepEqual(Object.keys(body.engines).sort(), ['claude', 'codex']);
  for (const engine of ['claude', 'codex']) {
    assert.ok(Array.isArray(body.engines[engine].models));
    assert.ok('usage' in body.engines[engine]);
    assert.ok('defaultModel' in body.engines[engine]);
    assert.ok('effectiveModel' in body.engines[engine]);
    assert.ok('catalogue' in body.engines[engine]);
  }
  assert.equal(body.engines.codex.defaultModel, 'gpt-5.6-terra');
  assert.equal(body.engines.codex.effectiveModel.label, 'GPT-5.6 Terra');
  assert.equal(body.engines.codex.catalogue.state, 'refreshed');
  assert.equal(catalogueChecks, 1);
  assert.doesNotMatch(response.text(), /executable|env|stdout|stderr|Users|person@|token/);
});

test('a stale configured engine model is explained and cannot masquerade as the default', async () => {
  const root = tmpRoot();
  const config = {
    locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London',
    ai: { provider: 'codex', model: null, models: { codex: 'gpt-old-stale', claude: null } },
  };
  fs.writeFileSync(path.join(root, 'workspace.json'), `${JSON.stringify(config)}\n`);
  const routes = routeFixture(root, {
    providerCataloguesFn: async () => ({
      codex: { state: 'refreshed', models: [{ id: 'gpt-5.6-sol', isDefault: true }] },
      claude: { state: 'unsupported', models: [] },
    }),
  });
  const response = new MockResponse();
  await routes['GET /api/engines'](
    new EventEmitter(), response, '', new URL('http://127.0.0.1/api/engines'),
  );
  await response.finished;
  const codex = JSON.parse(response.text()).engines.codex;
  assert.equal(codex.defaultModel, null);
  assert.equal(codex.effectiveModel.id, 'gpt-old-stale');
  assert.equal(codex.effectiveModel.available, false);
  assert.equal(codex.models.find((model) => model.id === 'gpt-old-stale').available, false);
});
