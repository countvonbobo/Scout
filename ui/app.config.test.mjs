import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { CATEGORY_PALETTE } from './lib/categoryColor.mjs';
import { createChatDrawerState, reduceChatDrawer } from './lib/chatDrawerState.mjs';
import { codexDeepLinkCapability, openCodexTask } from './lib/codexDeepLink.mjs';

function loadScout() {
  const context = {
    URL,
    window: {},
    document: { querySelectorAll: () => [] },
    fetch: () => new Promise(() => {}),
    console,
    matchMedia: () => ({ matches: false }),
    createChatDrawerState,
    codexDeepLinkCapability,
    codexTaskLaunchView: openCodexTask,
    reduceChatDrawer,
  };
  context.activityState = () => 'thinking';
  context.applyScoutState = () => {};
  context.scoutMarkup = () => '';
  context.discoveryStorageKey = () => 'test';
  context.mergeAcknowledged = (current) => current;
  context.strongUnseenMatches = () => [];
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(source, context, { filename: 'ui/app.js' });
  return { scout: context.window.Scout, context };
}

test('custom CV recommendations are preselected but remain optional', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /id="cv-option-xyz"[^>]*checked/);
  assert.match(html, /id="cv-option-humanize"[^>]*checked/);
  assert.match(html, /recommends both options, but they are optional/i);
  assert.match(html, /app\.js\?v=__SCOUT_UI_BUILD__/);
});

test('strict CSP-compatible UI markup uses delegated actions instead of inline handlers', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\son(?:click|change|input|keydown|submit)\s*=/i);
  assert.doesNotMatch(html, /\son(?:click|change|input|keydown|submit)\s*=/i);
  assert.match(html, /app\.js\?v=__SCOUT_UI_BUILD__/);
  assert.match(fs.readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8'), /scout-shell-\$\{BUILD\}/);
  assert.match(source, /data-action="open-entry"/);
  assert.match(source, /\.card\[data-id\]/);
  assert.match(source, /bindDelegatedActions/);
});

test('sync status opens backup details and stale builds require a safe explicit refresh', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /sync-status'[\s\S]*openBackupDetails/);
  assert.match(source, /if \(controlled\) this\.showUiUpdate\(\);[\s\S]*controlled = true/);
  assert.doesNotMatch(source, /sync-status'[\s\S]{0,180}openSettings/);
  assert.match(source, /info\.uiBuildId[\s\S]*!== this\.uiBuildId[\s\S]*showUiUpdate/);
  assert.match(source, /uiReloadBlocker\(\)/);
  assert.match(source, /location\.reload\(\)/);
  assert.doesNotMatch(source, /controllerchange'[\s\S]{0,120}location\.reload/);
});

test('master CV preview explains how to obtain a rendered PDF', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /No master reference PDF yet\. Save and render to create it\./i);
  assert.doesNotMatch(source, /master CV is source material only and has no PDF preview/i);
});

test('tagHtml renders an escaped, colour-styled category tag', () => {
  const { scout } = loadScout();
  scout.state.data = { categories: [{ id: 'startup', label: 'Priority' }, { id: 'established', label: 'Explore' }] };
  const html = scout.tagHtml({ id: 'x', category: 'startup' });
  assert.match(html, /class="cat-tag"/);
  assert.match(html, /Priority/);
  assert.match(html, /background:#4a73c3/);
});

test('tagHtml escapes a hostile category label', () => {
  const { scout } = loadScout();
  scout.state.data = { categories: [{ id: 'startup', label: '<img src=x onerror=alert(1)>' }] };
  const html = scout.tagHtml({ id: 'x', category: 'startup' });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img/);
});

test('tabForEntry routes speculative opportunities before status-based tabs', () => {
  const { scout } = loadScout();
  assert.equal(scout.tabForEntry({ status: 'new', tags: ['SPECULATIVE OUTREACH'] }), 'speculative');
  assert.equal(scout.tabForEntry({ status: 'new' }), 'jobs');
  assert.equal(scout.tabForEntry({ status: 'shortlist' }), 'shortlist');
  assert.equal(scout.tabForEntry({ status: 'applied' }), 'pipeline');
  assert.equal(scout.tabForEntry({ status: 'ignore' }), 'all');
});

test('company history keeps real correspondence separate from role-specific Scout chats', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(html, /id="company-drawer"/);
  assert.match(source, /company relationship history/);
  assert.match(source, /Saved only in your private Scout workspace/);
  assert.match(source, /openCompanyRoleChat/);
  assert.match(source, /\/api\/company\/communication/);
});

test('configured categories drive labels and legacy category mapping', () => {
  const { scout } = loadScout();
  scout.state.data = {
    categories: [
      { id: 'priority', label: 'Best fit' },
      { id: 'explore', label: 'Worth exploring' },
    ],
    opportunities: [],
  };

  assert.deepEqual(Array.from(scout.categoryIds()), ['priority', 'explore']);
  assert.equal(scout.categoryLabel('priority'), 'Best fit');
  assert.equal(scout.categoryOf({ category: 'priority' }), 'priority');
  assert.equal(scout.categoryOf({ category: 'startup' }), 'priority');
  assert.equal(scout.categoryOf({ category: 'corporate' }), 'explore');
});

test('configured triage thresholds drive score presentation', () => {
  const { scout } = loadScout();
  scout.workspaceConfig = { triage: { actionScore: 82, checkScore: 64 } };

  assert.equal(scout.fitClass(82), 'fit-strong');
  assert.equal(scout.fitClass(81), 'fit-medium');
  assert.equal(scout.fitClass(64), 'fit-medium');
  assert.equal(scout.fitClass(63), 'fit-weak');
});

test('Codex task controls escape fallback identity and never call a click success', () => {
  const { scout } = loadScout();
  scout.chat = {
    id: 'chat-a',
    engine: 'codex',
    data: { cliSessionId: '<img src=x onerror=alert(1)>' },
  };
  scout.chatDrawerState = createChatDrawerState('chat-a', 1);
  scout.chatDrawerState = reduceChatDrawer(scout.chatDrawerState, {
    type: 'codexLink/resolved', chatId: 'chat-a', generation: 1, requestGeneration: 1,
    value: { state: 'unavailable', canAttempt: false, reasonCode: 'handler-missing' },
  });
  const fallback = scout.codexTaskControlsHtml(scout.chat);
  assert.match(fallback, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(fallback, /<img/);
  assert.match(fallback, /copy task ID/i);
  assert.doesNotMatch(fallback, /success/i);
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /chat-msg tool/);
  assert.match(source, /Technical details/);
});

test('chat usage copy keeps unavailable, account estimate, allowance window, model spend and reset timing distinct', () => {
  const { scout } = loadScout();
  const unavailable = scout.usageSummaryView({ claude: { unknown: true }, codex: { unknown: true } });
  assert.match(unavailable.text, /claude usage unavailable/i);
  assert.match(unavailable.text, /codex usage unavailable/i);

  const estimated = scout.usageSummaryView({
    checkedAt: '2026-07-28T10:00:00.000Z',
    claude: { fiveHourTokens: 2_000, weekTokens: 5_000, approximate: true },
    codex: {
      windows: [{
        usedPercent: 42, label: 'weekly', resetsAt: '2026-07-29T10:00:00.000Z',
      }],
    },
  });
  assert.match(estimated.text, /estimated account usage/i);
  assert.match(estimated.text, /42% weekly allowance used/i);
  assert.match(estimated.title, /weekly resets/i);

  const spend = scout.modelSpendHtml('claude', {
    byModel: [{ model: 'safe-model', weekTokens: 9_000 }],
  }, 'safe-model');
  assert.match(spend, /spent on this model/i);
  assert.doesNotMatch(spend, /allowance remaining/i);
});

test('engine picker explains catalogue provenance, effective defaults and unavailable saved choices', () => {
  const { scout } = loadScout();
  scout.chat = { id: 'synthetic-chat', purpose: 'job' };
  scout.chatDrawerState = createChatDrawerState('synthetic-chat', 1);

  const refreshed = scout.engineCardHtml('codex', {
    usage: { unknown: true },
    models: [{
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      tradeoff: 'Most capable for complex work.',
      source: 'refreshed',
      available: true,
      selected: true,
    }],
    defaultModel: null,
    effectiveModel: {
      id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', available: true, known: true,
      state: 'provider-default',
    },
    catalogue: { state: 'refreshed' },
  });
  assert.match(refreshed, /Provider default — GPT-5\.6 Sol/);
  assert.match(refreshed, /Most capable for complex work/);
  assert.match(refreshed, /refreshed catalogue/);

  const stale = scout.engineCardHtml('codex', {
    usage: { unknown: true },
    models: [{
      id: 'gpt-old-stale',
      label: 'gpt-old-stale',
      tradeoff: 'Configured model is absent from the refreshed catalogue.',
      source: 'configured',
      available: false,
      selected: false,
    }],
    defaultModel: null,
    effectiveModel: {
      id: 'gpt-old-stale', label: 'gpt-old-stale', available: false, known: true,
      state: 'stale',
    },
    catalogue: { state: 'refreshed' },
  });
  assert.match(stale, /saved default unavailable/i);
  assert.match(stale, /choose another model/i);
  assert.match(stale, /value="gpt-old-stale"[^>]*disabled/);
});

test('engine picker escapes catalogue labels, tradeoffs and IDs and ignores unexpected raw fields', () => {
  const { scout } = loadScout();
  const html = scout.engineCardHtml('codex', {
    usage: { unknown: true },
    models: [{
      id: 'safe-model',
      label: '<img src=x onerror=alert(1)>',
      tradeoff: '<script>bad()</script>',
      source: 'refreshed',
      available: true,
      selected: false,
      raw: '/Users/example token=secret',
    }],
    effectiveModel: { id: null, label: 'Provider default (model unknown)', available: 'unknown', known: false },
    catalogue: { state: 'fallback' },
  });
  assert.doesNotMatch(html, /<img|<script|Users\/example|token=secret/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /bundled fallback/);
});

test('interview prep is a manual, separate conversation with escaped saved-pack content', () => {
  const { scout } = loadScout();
  let opened;
  scout.openChat = (...args) => { opened = args; };
  scout.openInterviewPrep('acme-role-2026-07');
  assert.deepEqual(Array.from(opened), ['acme-role-2026-07', 'interviewPrep', null, 'interview-prep']);
  scout.state.data = { pipeline: { active: [{ id: 'acme-role-2026-07', needsInterviewPrep: true }] } };
  assert.equal(scout.interviewPrepRecommended('acme-role-2026-07'), true);
  assert.equal(scout.interviewPrepRecommended('other-role-2026-07'), false);

  scout.chat = {
    purpose: 'interview-prep',
    artifact: { exists: true, updatedAt: null, content: '<script>alert(1)</script>' },
  };
  const pack = scout.interviewPrepPackHtml();
  assert.match(pack, /View prep pack/);
  assert.match(pack, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(pack, /<script>/);

  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, />interview prep<\/button>/);
  assert.doesNotMatch(source, /openInterviewPrep[\s\S]{0,200}sendChat\(/);
});

test('index.html defines static Jobs, Speculative and Shortlist tabs, not category lanes', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /data-tab="jobs"/);
  assert.match(html, /data-tab="speculative"/);
  assert.match(html, /data-tab="shortlist"/);
  assert.match(html, /id="tab-jobs"/);
  assert.match(html, /id="tab-speculative"/);
  assert.match(html, /id="tab-shortlist"/);
  assert.doesNotMatch(html, /data-tab="startup"/);
  assert.doesNotMatch(html, /data-tab="established"/);
  assert.doesNotMatch(html, /data-category="true"/);
});

function withJobsDom() {
  const sections = {};
  const make = () => ({ innerHTML: '', classList: { toggle() {}, add() {}, remove() {} }, addEventListener() {}, querySelector: () => null });
  const doc = {
    getElementById: (id) => (sections[id] ||= make()),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return { doc, sections };
}

test('pipeline shows application outcomes without ignored jobs, flags or scan health', () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  scout.state.data = {
    opportunities: [
      { id: 'ignored', company: 'No', role: 'Ignored', status: 'ignore', score: 20 },
      { id: 'accepted', company: 'Yes', role: 'Accepted', status: 'accepted', score: 90 },
      { id: 'rejected', company: 'Done', role: 'Rejected', status: 'rejected', score: 70 },
    ],
    pipeline: {
      summary: { shortlist: 0, watch: 0, active: 0, accepted: 1, recentlyClosed: 1 },
      shortlist: [],
      watch: [],
      active: [],
      accepted: [{ id: 'accepted', company: 'Yes', role: 'Accepted', status: 'accepted', score: 90 }],
      recentlyClosed: [{ id: 'rejected', company: 'Done', role: 'Rejected', status: 'rejected', score: 70 }],
    },
  };
  scout.renderPipeline();
  const html = doc.getElementById('tab-pipeline').innerHTML;
  assert.match(html, />Accepted</);
  assert.match(html, />Closed</);
  assert.match(html, /data-pipeline-status="new"/);
  assert.match(html, /data-pipeline-status="shortlist"/);
  assert.match(html, /data-pipeline-status="watch"/);
  assert.match(html, /data-pipeline-status="outreach"/);
  assert.match(html, /data-pipeline-status="accepted"/);
  assert.match(html, /data-pipeline-status="rejected"/);
  assert.match(html, /Drag a card into another column/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /data-id="accepted"/);
  assert.match(html, /data-id="rejected"/);
  assert.doesNotMatch(html, /data-id="ignored"/);
  assert.doesNotMatch(html, /Closed \/ ignored|Flags|Scan health/);
});

test('pipeline moves persist status and preserve an existing active stage', async () => {
  const { scout } = loadScout();
  scout.state.data = {
    opportunities: [
      { id: 'watch', status: 'watch' },
      { id: 'interview', status: 'interviewing' },
    ],
  };
  const calls = [];
  scout.post = async (...args) => { calls.push(args); return { ok: true }; };

  await scout.movePipelineEntry('watch', 'new');
  await scout.movePipelineEntry('interview', 'outreach');

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['/api/status', { id: 'watch', status: 'new' }]]);
});

test('reports shows scan health above dated reports', async () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  scout.state.data = {
    scanHealth: {
      healthy: true,
      lastRunAt: '2026-07-25T07:30:00Z',
      candidatesFound: 12,
      keepersAdded: 2,
      discarded: { mandatory_unmet: 10 },
      sourceHealth: [{ name: 'ATS', status: 'healthy', count: 12 }],
    },
  };
  scout.api = async (path) => path === '/api/reports' ? { reports: ['2026-07-25'] } : '# Daily report';
  await scout.renderReports();
  const html = doc.getElementById('tab-reports').innerHTML;
  assert.match(html, /Scan health/);
  assert.match(html, /12 assessed, 2 kept/);
  assert.match(html, /ATS: healthy \(12\)/);
  assert.match(html, /Report date/);
});

test('scan health labels distinguish selection from successful assessment', () => {
  const { scout } = loadScout();
  scout.state.data = { scanHealth: { funnel: { sourceRecords: 2532, sourceErrors: 2, failedSourceRecords: 3, uniqueVacancies: 120, deterministicallyExcluded: 40, eligible: 80, ranked: 80, selected: 60, assessed: 59, assessmentFailed: 1 } } };
  const html = scout.scanHealthCard();
  for (const label of ['Source records returned', 'Source or portal errors', 'Records not normalised', 'Unique vacancies after deduplication', 'Excluded by confirmed rules', 'Eligible and ranked', 'Selected for detailed assessment', 'Successfully assessed', 'Assessment failed']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /vacancies checked/i);
});

test('run audit renders persisted recovery and queue state without private diagnostic fields', () => {
  const { scout } = loadScout();
  scout.scanRuns = [{
    id: 'run-1234…', state: 'repairing', label: 'Repairing affected jobs',
    owner: 'active worker', startedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:05:00.000Z', profileVersion: 'profile-v3',
    pipelineVersion: 'pipeline-v9', completedStages: ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'],
    assessment: {
      currentBatch: 2, totalBatches: 3, totalBatchesExact: false,
      completedBatches: 1, completedJobs: 10, failedJobs: 1,
    },
    recoveryCount: 2, terminalReason: null,
    host: 'PRIVATE-HOST', pid: 4242, prompt: 'private prompt', advert: 'full advert body',
  }];
  scout.scanQueue = {
    requests: [{
      id: 'request-…', status: 'queued', requester: 'manual', purpose: 'job-discovery',
      requestedAt: '2026-07-29T00:04:00.000Z', expiresAt: '2026-07-30T00:04:00.000Z',
      prompt: 'private queued prompt',
    }],
  };
  const html = scout.scanRunAuditCard();
  assert.match(html, /Repairing affected jobs/);
  assert.match(html, /batch 2 of at least 3/i);
  assert.match(html, /2 recoveries/i);
  assert.match(html, /1 queued request/i);
  assert.match(html, /run-1234…/);
  assert.doesNotMatch(html, /PRIVATE-HOST|4242|private prompt|full advert body|private queued prompt/i);
});

test('the Jobs audit remains visible for queue-only and waiting workspaces', () => {
  const { scout } = loadScout();
  scout.latestScan = null;
  scout.scanRuns = [];
  scout.scanRunState = 'waiting';
  scout.scanQueue = {
    state: 'queued',
    requests: [{ id: 'request-…', status: 'queued', requester: 'manual', purpose: 'job-discovery' }],
  };
  assert.match(scout.latestScanCard(), /1 queued request/i);
  scout.scanQueue = { state: 'waiting', requests: [] };
  assert.match(scout.latestScanCard(), /Waiting to scan/i);
});

test('renderJobs lists only new jobs, highest score first, with tags and actions', () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  scout.filterBar = () => '';
  scout.latestScanCard = () => '';
  scout.state.data = {
    categories: [{ id: 'startup', label: 'Priority' }],
    opportunities: [
      { id: 'a', company: 'A', role: 'Eng', status: 'new', score: 60, category: 'startup' },
      { id: 'b', company: 'B', role: 'Eng', status: 'new', score: 90, category: 'startup', sources: ['https://example.com/jobs/b'] },
      { id: 'c', company: 'C', role: 'Eng', status: 'shortlist', score: 99, category: 'startup' },
      { id: 's', company: 'S', role: 'Speculative', status: 'new', score: 95, category: 'startup', tags: ['Speculative Outreach'] },
    ],
  };
  scout.renderJobs();
  const html = doc.getElementById('tab-jobs').innerHTML;
  assert.match(html, /data-action="triage-yes"/);
  assert.match(html, /data-action="triage-no"/);
  assert.match(html, /href="https:\/\/example\.com\/jobs\/b"/);
  assert.match(html, /view source/);
  assert.ok(html.indexOf('data-id="b"') < html.indexOf('data-id="a"')); // 90 before 60
  assert.doesNotMatch(html, /data-id="c"/); // shortlisted excluded
  assert.doesNotMatch(html, /data-id="s"/); // speculative excluded
});

test('speculative classification uses the exact tag case-insensitively', () => {
  const { scout } = loadScout();
  assert.equal(scout.isSpeculative({ tags: ['Speculative Outreach'] }), true);
  assert.equal(scout.isSpeculative({ tags: [' speculative outreach '] }), true);
  assert.equal(scout.isSpeculative({ role: 'Speculative engineer', tags: [] }), false);
  assert.equal(scout.isSpeculative({ tags: ['Speculative'] }), false);
});

test('renderSpeculative groups tagged opportunities and honours commute filtering', () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  scout.filterBar = () => '';
  scout.state.commute = { mode: 'car', maxMinutes: '60', includeUnknown: false };
  scout.state.data = {
    categories: [{ id: 'startup', label: 'Priority' }],
    opportunities: [
      { id: 'near', company: 'Near', role: 'Eng', status: 'new', score: 70, category: 'startup', tags: ['SPECULATIVE OUTREACH'], commute: { carMinutes: 45 } },
      { id: 'far', company: 'Far', role: 'Eng', status: 'watch', score: 80, category: 'startup', tags: ['Speculative Outreach'], commute: { carMinutes: 90 } },
      { id: 'normal', company: 'Normal', role: 'Eng', status: 'new', score: 90, category: 'startup', commute: { carMinutes: 30 } },
    ],
  };
  scout.renderSpeculative();
  const html = doc.getElementById('tab-speculative').innerHTML;
  assert.match(html, /Speculative opportunities \(1\)/);
  assert.match(html, /New \(1\)/);
  assert.match(html, /data-id="near"/);
  assert.doesNotMatch(html, /data-id="far"/);
  assert.doesNotMatch(html, /data-id="normal"/);
});

test('renderSpeculative shows an empty state when nothing matches', () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  scout.filterBar = () => '';
  scout.state.data = { opportunities: [] };
  scout.renderSpeculative();
  assert.match(doc.getElementById('tab-speculative').innerHTML, /No speculative opportunities match/);
});

test('triage actions post the right status transitions', async () => {
  const { scout } = loadScout();
  scout.state.data = {
    opportunities: [
      { id: 'a', status: 'new' },
      { id: 'b', status: 'new' },
    ],
  };
  scout.renderJobs = () => {};
  const calls = [];
  scout.post = (path, payload) => { calls.push([path, payload]); return Promise.resolve({ ok: true }); };
  scout.showUndo = () => {};
  scout.hideUndo = () => {};
  scout.triageYes('a');
  await scout.triageNo('b');
  scout.undoDismiss('b');
  const normalized = calls.map(([path, payload]) => [path, JSON.parse(JSON.stringify(payload))]);
  assert.deepEqual(normalized[0], ['/api/status', { id: 'a', status: 'shortlist' }]);
  assert.deepEqual(normalized[1], ['/api/status', { id: 'b', status: 'ignore' }]);
  assert.deepEqual(normalized[2], ['/api/status', { id: 'b', status: 'new' }]);
});

test('No removes a job immediately and restores it when persistence fails', async () => {
  const { scout } = loadScout();
  scout.state.data = { opportunities: [{ id: 'b', status: 'new' }] };
  let finishWrite;
  scout.post = () => new Promise((resolve) => { finishWrite = resolve; });
  const renderedStatuses = [];
  scout.renderJobs = () => renderedStatuses.push(scout.state.data.opportunities[0].status);

  const pending = scout.triageNo('b');
  assert.equal(scout.state.data.opportunities[0].status, 'ignore');
  assert.deepEqual(renderedStatuses, ['ignore']);

  finishWrite({ ok: false });
  await pending;
  assert.equal(scout.state.data.opportunities[0].status, 'new');
  assert.deepEqual(renderedStatuses, ['ignore', 'new']);
});

test('renderShortlist lists only shortlisted jobs with a remove action', () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  scout.filterBar = () => '';
  scout.state.data = {
    categories: [{ id: 'startup', label: 'Priority' }],
    opportunities: [
      { id: 'a', company: 'A', role: 'Eng', status: 'new', score: 60, category: 'startup' },
      { id: 'b', company: 'B', role: 'Eng', status: 'shortlist', score: 90, category: 'startup' },
    ],
  };
  scout.renderShortlist();
  const html = doc.getElementById('tab-shortlist').innerHTML;
  assert.match(html, /data-id="b"/);
  assert.match(html, /data-action="remove-shortlist"/);
  assert.doesNotMatch(html, /data-id="a"/);
});

test('removeFromShortlist dismisses to ignore with undo', () => {
  const { scout } = loadScout();
  const calls = [];
  scout.post = (p, payload) => { calls.push([p, payload]); return Promise.resolve({ ok: true }); };
  scout.showUndo = () => {};
  scout.removeFromShortlist('b');
  const normalized = calls.map(([path, payload]) => [path, JSON.parse(JSON.stringify(payload))]);
  assert.deepEqual(normalized[0], ['/api/status', { id: 'b', status: 'ignore' }]);
});

test('renderAll lists ignored items with a restore action', () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  scout.state.data = {
    categories: [{ id: 'startup', label: 'Priority' }],
    opportunities: [
      { id: 'i', company: 'I', role: 'Eng', status: 'ignore', score: 20, category: 'startup' },
      { id: 's', company: 'S', role: 'Speculative', status: 'new', score: 70, category: 'startup', tags: ['Speculative Outreach'] },
    ],
  };
  scout.renderAll();
  const html = doc.getElementById('tab-all').innerHTML;
  assert.match(html, /data-id="i"/);
  assert.match(html, /data-id="s"/);
  assert.match(html, /data-action="restore"/);
});

test('restore action moves an item back to new', () => {
  const { scout } = loadScout();
  const calls = [];
  scout.post = (p, payload) => { calls.push([p, payload]); return Promise.resolve({ ok: true }); };
  scout.showUndo = () => {};
  scout.restoreEntry('i');
  const normalized = calls.map(([path, payload]) => [path, JSON.parse(JSON.stringify(payload))]);
  assert.deepEqual(normalized[0], ['/api/status', { id: 'i', status: 'new' }]);
});

test('switching tabs resets scroll position', () => {
  const { scout, context } = loadScout();
  let scrolled = null;
  context.window.scrollTo = (x, y) => { scrolled = [x, y]; };
  context.document = {
    getElementById: () => ({ innerHTML: '', classList: { toggle() {}, add() {}, remove() {} } }),
    querySelectorAll: () => [],
  };
  scout.state.data = { opportunities: [] };
  scout.renderJobs = () => {}; scout.renderShortlist = () => {};
  scout.renderPipeline = () => {}; scout.renderReports = () => {}; scout.renderCv = () => {};
  scout.showTab('cv');
  assert.deepEqual(scrolled, [0, 0]);
});

test('tailored CV actions are named for their outcome', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /Review CV options/);
  assert.match(source, /Start tailored CV/);
});

test('app.js inlined CATEGORY_PALETTE stays in sync with the canonical ui/lib/categoryColor.mjs copy', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  for (const { bg, fg } of CATEGORY_PALETTE) {
    assert.match(source, new RegExp(`bg: '${bg}', fg: '${fg}'`), `app.js is missing inlined entry ${bg}/${fg}`);
  }
});

test('app.js keeps no Scout animation timing, geometry or alignment data of its own', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  // Every duplicate below produced a different animation from the canonical
  // ui/lib/scoutCharacter.mjs definition: one 2s/16-frame cycle for every state,
  // an alignment table missing welcome/asking/sleeping, and a still frame pinned
  // to frame zero regardless of the state's configured reducedMotionFrame.
  assert.doesNotMatch(source, /SCOUT_RUNTIME_ALIGNMENT/);
  assert.doesNotMatch(source, /SCOUT_RUNTIME_STATES/);
  assert.doesNotMatch(source, /--scout-(?:duration|frames|columns|rows|iterations|align-[xy]|still-[xy]|src)/);
  assert.doesNotMatch(source, /\/assets\/scout-\w+\.png/);
  assert.match(source, /window\.ScoutCharacter/);
});

test('index.html loads the canonical character module and defines no fixed 16-frame animation', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="\/lib\/scoutCharacter\.mjs\?v=__SCOUT_UI_BUILD__"><\/script>/);
  // The old hand-written keyframe table hard-coded 16 cells and rounded thirds,
  // so any state with a different grid or frame rate drifted off its cell. The
  // walk is now a per-grid keyframes rule generated from the definition.
  assert.doesNotMatch(html, /@keyframes scout-frames/);
  assert.doesNotMatch(html, /@keyframes scout-frame-column/);
  const sprite = html.match(/\.scout-sprite \{[^}]*\}/)?.[0] || '';
  assert.ok(sprite, '.scout-sprite rule must exist');
  assert.doesNotMatch(sprite, /\d+\.\d+%/);
  assert.match(sprite, /animation:var\(--scout-walk\) var\(--scout-duration\) step-end var\(--scout-iterations\)/);
  // Offscreen and hidden-page pausing must survive the rewrite.
  assert.match(html, /\.scout-offscreen \.scout-sprite, \.scout-page-hidden \.scout-sprite \{ animation-play-state:paused; \}/);
  // Reduced motion holds the representative frame on its own anchor.
  assert.match(html, /\.scout-sprite\.reduced-motion \{[^}]*animation:none;[^}]*--scout-still-align-x/);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\) \{[^}]*--scout-still-align-x/);
});

test('a character rendered before the module arrives is a hydratable, labelled placeholder', () => {
  const { context } = loadScout();
  // loadScout runs app.js with no window.ScoutCharacter, which is exactly the
  // production window between the classic script executing and the deferred
  // module evaluating — and the permanent state if the module never loads.
  assert.equal(context.window.ScoutCharacter, undefined);
  const markup = context.scoutMarkup('found', 'scout-arrival-character');
  assert.match(markup, /class="scout-character[^"]*scout-arrival-character/);
  assert.match(markup, /role="img"/);
  assert.match(markup, /aria-label="Scout"/);
  assert.match(markup, /data-scout-state="found"/);
  assert.match(markup, /<span class="scout-sprite" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(markup, /data-scout-ready/);
  // A state name can only ever reach the placeholder as a bare identifier.
  assert.match(context.scoutMarkup('"><script>alert(1)</script>'), /data-scout-state="scriptalertscript"/);
  assert.doesNotMatch(context.scoutMarkup('"><script>alert(1)</script>'), /<script>/);

  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  // Until the module marks a character ready, the box shows Scout's resting
  // cell rather than an empty slot.
  assert.match(html, /\.scout-character:not\(\[data-scout-ready\]\) \.scout-sprite \{[^}]*scout-idle\.png/);
  assert.match(html, /\.scout-character:not\(\[data-scout-ready\]\) \.scout-sprite \{[^}]*animation:none/);
});

test('the character module is cached offline and carries the UI build fingerprint', () => {
  const worker = fs.readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /\/lib\/scoutCharacter\.mjs\?v=\$\{BUILD\}/);
  assert.match(worker, /url\.pathname === '\/lib\/scoutCharacter\.mjs'/);
  // A module-only change must move the build id, or the shell cache and the
  // versioned module URL would both keep serving the previous character.
  const server = fs.readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(server, /UI_BUILD_FILES = \[[\s\S]*'lib\/scoutCharacter\.mjs'/);
});

test('dynamic category lane machinery is gone', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /renderCategory/);
  assert.doesNotMatch(source, /setupCategoryUi/);
});

test('commute filter refresh re-renders jobs, speculative and shortlist', () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  let jobs = 0; let speculative = 0; let shortlist = 0;
  scout.renderJobs = () => { jobs += 1; };
  scout.renderSpeculative = () => { speculative += 1; };
  scout.renderShortlist = () => { shortlist += 1; };
  scout.renderAll = () => {};
  scout.state.data = { opportunities: [] };
  scout.setCommuteFilter('mode', 'car');
  assert.equal(jobs, 1);
  assert.equal(speculative, 1);
  assert.equal(shortlist, 1);
});

test('saveCv persists the source without rendering', async () => {
  const { scout, context } = loadScout();
  const calls = [];
  context.document = {
    getElementById: (id) => (id === 'cv-text' ? { value: 'source' } : { textContent: '', innerHTML: '', classList: { toggle() {}, add() {}, remove() {} } }),
    querySelectorAll: () => [],
  };
  scout.cvState = { path: 'applications/acme-eng-2026-07/cv.typ', dirty: true };
  scout.post = (p, payload) => { calls.push([p, payload]); return Promise.resolve({ ok: true }); };
  scout.renderCvPreview = () => { calls.push(['RENDER_PREVIEW']); };
  await scout.saveCv();
  assert.deepEqual(calls.map((c) => c[0]), ['/api/cv/save']);
  assert.equal(scout.cvState.dirty, false);
});

test('renderCvOnly renders without re-saving the source', async () => {
  const { scout, context } = loadScout();
  const calls = [];
  context.document = {
    getElementById: () => ({ textContent: '', innerHTML: '', classList: { toggle() {}, add() {}, remove() {} } }),
    querySelectorAll: () => [],
  };
  scout.cvState = { path: 'applications/acme-eng-2026-07/cv.typ', dirty: false };
  scout.post = (p, payload) => { calls.push([p, payload]); return Promise.resolve({ ok: true }); };
  scout.renderCvPreview = () => { calls.push(['RENDER_PREVIEW']); return Promise.resolve(); };
  await scout.renderCvOnly();
  assert.ok(!calls.some((c) => c[0] === '/api/cv/save'), 'must not re-save the source');
  assert.ok(calls.some((c) => c[0] === 'RENDER_PREVIEW'));
});

test('renderCvOnly reports a saved-but-render-failed status when the real render path fails', async () => {
  const { scout, context } = loadScout();
  const elements = {
    'cv-status': { textContent: '' },
    'cv-preview': { innerHTML: '' },
  };
  context.document = {
    getElementById: (id) => elements[id],
    querySelectorAll: () => [],
  };
  // Exercise renderCvPreview's real fetch-driven implementation (not a throwing
  // test double) so the failure path actually observed in production is covered.
  context.fetch = () => Promise.resolve({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: 'render engine crashed' }),
  });
  scout.cvState = { path: 'applications/acme-eng-2026-07/cv.typ', slug: 'acme-eng-2026-07', dirty: false };
  scout.post = () => { throw new Error('must not re-save the source'); };
  await scout.renderCvOnly();
  assert.match(elements['cv-preview'].innerHTML, /render engine crashed/);
  assert.match(elements['cv-status'].textContent, /Saved source is intact/);
  assert.match(elements['cv-status'].textContent, /render engine crashed/);
});

test('creating a CV for a second role at one company does not open the first role\'s CV', () => {
  const { scout, context } = loadScout();
  const opened = [];
  context.document = { getElementById: () => ({ value: 'acme-frontend-engineer-2026-07' }), querySelectorAll: () => [] };
  scout.state.data = { opportunities: [
    { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' },
    { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' },
  ] };
  scout.state.cvFiles = { applications: ['acme-backend-engineer-2026-07'] };
  scout.seeCv = (slug, id) => opened.push(['seeCv', slug, id]);
  scout.chooseCvOptions = (id) => opened.push(['chooseCvOptions', id]);
  scout.startCvCreate();
  assert.deepEqual(opened, [['chooseCvOptions', 'acme-frontend-engineer-2026-07']]);
});

test('an existing artifact for the same role is opened directly', () => {
  const { scout, context } = loadScout();
  const opened = [];
  context.document = { getElementById: () => ({ value: 'acme-backend-engineer-2026-07' }), querySelectorAll: () => [] };
  scout.state.data = { opportunities: [{ id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' }] };
  scout.state.cvFiles = { applications: ['acme-backend-engineer-2026-07'] };
  scout.seeCv = (slug, id) => opened.push(['seeCv', slug, id]);
  scout.chooseCvOptions = (id) => opened.push(['chooseCvOptions', id]);
  scout.startCvCreate();
  assert.deepEqual(opened, [['seeCv', 'acme-backend-engineer-2026-07', 'acme-backend-engineer-2026-07']]);
});

test('the Shortlist "Review CV options" button goes through the same collision guard as the CV library', () => {
  const { scout } = loadScout();
  scout.esc = (value) => String(value);
  const html = scout.shortlistCardHtml({ id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer', score: 7 });
  assert.match(html, /data-action="choose-cv-options"/);
  assert.match(html, />Review CV options</);
  // runAction must route that action into the resolve+confirm method, not straight
  // into generation, so there is exactly one place a collision can be missed.
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /case 'choose-cv-options': return this\.reviewCvOptions\(id\);/);
  assert.match(source, /case 'start-cv-create': return this\.startCvCreate\(\);/);
  assert.match(source, /startCvCreate\(\)[\s\S]{0,200}return this\.reviewCvOptions\(id\)/);
});

test('declining a shared legacy folder starts fresh in the role\'s own folder, never the legacy one', () => {
  const { scout, context } = loadScout();
  const chosen = [];
  context.document = { getElementById: () => ({ value: 'acme-frontend-engineer-2026-07' }), querySelectorAll: () => [] };
  context.confirm = () => false; // "Cancel" = start a new CV for this role
  scout.state.data = { opportunities: [
    { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' },
    { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' },
  ] };
  scout.state.cvFiles = { applications: ['acme'] }; // one legacy company folder, shared
  scout.seeCv = (slug, id) => chosen.push(['seeCv', slug, id]);
  scout.chooseCvOptions = (id, slug) => chosen.push(['chooseCvOptions', id, slug]);
  scout.reviewCvOptions('acme-frontend-engineer-2026-07');
  assert.deepEqual(chosen, [['chooseCvOptions', 'acme-frontend-engineer-2026-07', 'acme-frontend-engineer-2026-07']]);
  // Accepting reuses the legacy folder in place instead.
  chosen.length = 0;
  context.confirm = () => true;
  scout.reviewCvOptions('acme-frontend-engineer-2026-07');
  assert.deepEqual(chosen, [['seeCv', 'acme', 'acme-frontend-engineer-2026-07']]);
});

test('the chosen folder is carried into chat start so the agent writes where the user chose', async () => {
  const { scout, context } = loadScout();
  const requested = [];
  context.document = { getElementById: () => ({ checked: true, value: '', classList: { add() {}, remove() {} } }), querySelectorAll: () => [] };
  scout.api = (url) => { requested.push(url); return Promise.resolve({ prefills: {}, chat: null }); };
  scout.renderChatDrawer = () => {};
  scout.refreshUsage = () => {};
  scout.loadEngineOptions = () => {};
  scout.cvOptionsOpportunityId = 'acme-frontend-engineer-2026-07';
  scout.cvOptionsArtifactSlug = 'acme-frontend-engineer-2026-07';
  await scout.startCvFromOptions();
  assert.equal(requested.length, 1);
  assert.match(requested[0], /artifact=acme-frontend-engineer-2026-07/);
});

test('the user\'s own current-role CV opens without a confusing legacy prompt', () => {
  const { scout, context } = loadScout();
  const chosen = [];
  context.confirm = () => { throw new Error('must not prompt for this role\'s own CV folder'); };
  scout.state.data = { opportunities: [{ id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' }] };
  scout.seeCv = (slug, id) => chosen.push(['seeCv', slug, id]);
  scout.chooseCvOptions = (id, slug) => chosen.push(['chooseCvOptions', id, slug]);
  // Its own per-role folder.
  scout.state.cvFiles = { applications: ['acme-backend-engineer-2026-07'] };
  scout.reviewCvOptions('acme-backend-engineer-2026-07');
  // A legacy folder that can only belong to this role (no other tracked role at
  // this employer) is also opened directly.
  scout.state.cvFiles = { applications: ['acme'] };
  scout.reviewCvOptions('acme-backend-engineer-2026-07');
  assert.deepEqual(chosen, [
    ['seeCv', 'acme-backend-engineer-2026-07', 'acme-backend-engineer-2026-07'],
    ['seeCv', 'acme', 'acme-backend-engineer-2026-07'],
  ]);
});

test('opening a different CV clears the status left by the previous file', async () => {
  const { scout, context } = loadScout();
  const elements = {
    'cv-status': { textContent: 'Saved. The PDF is out of date until you render it.' },
    'cv-text': { value: '' },
    'cv-editing': { textContent: '' },
    'cv-dirty': { textContent: '' },
    'cv-quality': { innerHTML: '' },
    'cv-preview': { innerHTML: '' },
  };
  context.document = { getElementById: (id) => elements[id], querySelectorAll: () => [] };
  scout.cvState = { path: 'applications/a/cv.typ', slug: 'a', dirty: false };
  scout.api = () => Promise.resolve('new source');
  await scout.openCv('applications/b/cv.typ', null);
  assert.equal(elements['cv-status'].textContent, '');
});

test('tailored CV preview maps the application render state returned by the API', () => {
  const { scout } = loadScout();
  scout.cvState = { path: 'applications/helsing/cv.typ', slug: 'helsing' };
  scout.state.cvFiles = {
    entries: [{ slug: 'helsing', pdf: true, pdfCurrent: true, pdfStale: false }],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(scout.currentCvRenderState())), {
    slug: 'helsing', pdf: true, pdfCurrent: true, pdfStale: false, current: true, stale: false,
  });
});

test('cvLinkHtml shows no link (never a wrong-role link) when the chat opportunity is not in tracked data', () => {
  const { scout } = loadScout();
  scout.esc = (value) => String(value);
  scout.state.data = { opportunities: [
    { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' },
  ] };
  scout.state.cvFiles = { applications: ['acme-frontend-engineer-2026-07'] };
  // this.chat.id is absent from state.data.opportunities (e.g. the tracker refreshed
  // and dropped/filtered the opportunity while its chat panel stayed open). The
  // pre-fix code fell back to `slugOf(company(chat.id))`, and `company()` on a
  // lookup miss returns the raw id itself; since this id is already slug-shaped,
  // slugOf() leaves it unchanged, so the pre-fix slug equals the chat id verbatim.
  // filesTouched below contains exactly that pre-fix-derived path, so a passing
  // pre-fix run would emit a real (and here, misleadingly self-referential) link;
  // only the post-fix "no entry -> no link" short-circuit returns ''.
  scout.chat = {
    id: 'acme-backend-engineer-2026-07',
    data: { filesTouched: ['applications/acme-backend-engineer-2026-07/cv.typ'] },
  };
  const html = scout.cvLinkHtml();
  assert.equal(html, '');
  assert.doesNotMatch(html, /acme-backend-engineer-2026-07/);
});
