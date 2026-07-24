import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

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
  assert.match(source, /save \+ render reference PDF/i);
  assert.match(source, /No master reference PDF yet\. Save and render to create it\./i);
  assert.doesNotMatch(source, /master CV is source material only and has no PDF preview/i);
});

test('tagHtml renders an escaped, colour-styled category tag', () => {
  const { scout } = loadScout();
  scout.state.data = { categories: [{ id: 'startup', label: 'Priority' }, { id: 'established', label: 'Explore' }] };
  const html = scout.tagHtml({ id: 'x', category: 'startup' });
  assert.match(html, /class="cat-tag"/);
  assert.match(html, /Priority/);
  assert.match(html, /background:#5b8def/);
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

test('rendered category lanes escape configured labels', () => {
  const { scout, context } = loadScout();
  const target = { innerHTML: '' };
  context.document.getElementById = () => target;
  scout.state.data = {
    categories: [{ id: 'priority', label: '<img src=x onerror=alert(1)>' }],
    opportunities: [],
    triage: { followups: [] },
  };
  scout.workspaceConfig = { triage: { actionScore: 70, checkScore: 55 } };
  scout.filterBar = () => '';
  scout.renderCategory('priority');
  assert.match(target.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt; lane/);
  assert.doesNotMatch(target.innerHTML, /<img/);
});
