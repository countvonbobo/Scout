import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { CATEGORY_PALETTE } from './lib/categoryColor.mjs';

function loadScout() {
  const context = {
    URL,
    window: {},
    document: { querySelectorAll: () => [] },
    fetch: () => new Promise(() => {}),
    console,
    matchMedia: () => ({ matches: false }),
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

test('tabForEntry routes by status', () => {
  const { scout } = loadScout();
  assert.equal(scout.tabForEntry({ status: 'new' }), 'jobs');
  assert.equal(scout.tabForEntry({ status: 'shortlist' }), 'shortlist');
  assert.equal(scout.tabForEntry({ status: 'applied' }), 'pipeline');
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

test('Codex chats use the canonical desktop task deep link and raw tool commands stay hidden', () => {
  const { context } = loadScout();
  assert.equal(context.codexTaskUrl('019f1234-abcd-7890'), 'codex://threads/019f1234-abcd-7890');
  assert.equal(context.codexTaskUrl('../unsafe'), null);
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /chat-msg tool/);
  assert.match(source, /Technical details/);
});

test('interview prep is a manual, separate conversation with escaped saved-pack content', () => {
  const { scout } = loadScout();
  let opened;
  scout.openChat = (...args) => { opened = args; };
  scout.openInterviewPrep('acme-role-2026-07');
  assert.deepEqual(Array.from(opened), ['acme-role-2026-07', 'interviewPrep', null, 'interview-prep']);
  scout.state.data = { pipeline: { flags: [{ id: 'acme-role-2026-07', kind: 'interview-prep' }] } };
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

test('index.html defines static Jobs and Shortlist tabs, not category lanes', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /data-tab="jobs"/);
  assert.match(html, /data-tab="shortlist"/);
  assert.match(html, /id="tab-jobs"/);
  assert.match(html, /id="tab-shortlist"/);
  assert.doesNotMatch(html, /data-tab="startup"/);
  assert.doesNotMatch(html, /data-tab="established"/);
  assert.doesNotMatch(html, /data-category="true"/);
});

function withJobsDom() {
  const sections = {};
  const make = () => ({ innerHTML: '', classList: { toggle() {}, add() {}, remove() {} } });
  const doc = {
    getElementById: (id) => (sections[id] ||= make()),
    querySelectorAll: () => [],
  };
  return { doc, sections };
}

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
      { id: 'b', company: 'B', role: 'Eng', status: 'new', score: 90, category: 'startup' },
      { id: 'c', company: 'C', role: 'Eng', status: 'shortlist', score: 99, category: 'startup' },
    ],
  };
  scout.renderJobs();
  const html = doc.getElementById('tab-jobs').innerHTML;
  assert.match(html, /data-action="triage-yes"/);
  assert.match(html, /data-action="triage-no"/);
  assert.ok(html.indexOf('data-id="b"') < html.indexOf('data-id="a"')); // 90 before 60
  assert.doesNotMatch(html, /data-id="c"/); // shortlisted excluded
});

test('triage actions post the right status transitions', () => {
  const { scout } = loadScout();
  const calls = [];
  scout.post = (path, payload) => { calls.push([path, payload]); return Promise.resolve({ ok: true }); };
  scout.showUndo = () => {};
  scout.hideUndo = () => {};
  scout.triageYes('a');
  scout.triageNo('b');
  scout.undoDismiss('b');
  const normalized = calls.map(([path, payload]) => [path, JSON.parse(JSON.stringify(payload))]);
  assert.deepEqual(normalized[0], ['/api/status', { id: 'a', status: 'shortlist' }]);
  assert.deepEqual(normalized[1], ['/api/status', { id: 'b', status: 'ignore' }]);
  assert.deepEqual(normalized[2], ['/api/status', { id: 'b', status: 'new' }]);
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

test('dynamic category lane machinery is gone', () => {
  const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /renderCategory/);
  assert.doesNotMatch(source, /setupCategoryUi/);
});

test('commute filter refresh re-renders jobs and shortlist', () => {
  const { scout, context } = loadScout();
  const { doc } = withJobsDom();
  context.document = doc;
  let jobs = 0; let shortlist = 0;
  scout.renderJobs = () => { jobs += 1; };
  scout.renderShortlist = () => { shortlist += 1; };
  scout.renderAll = () => {};
  scout.state.data = { opportunities: [] };
  scout.setCommuteFilter('mode', 'car');
  assert.equal(jobs, 1);
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
