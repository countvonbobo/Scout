# Jobs Triage Inbox — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Scout's dynamic category lanes with a single **Jobs** triage inbox (colour-tagged cards, one-tap Yes→shortlist / No→dismiss+undo) plus a new **Shortlist** tab.

**Architecture:** Add one `shortlist` status to the tracker domain. Add a shared category-colour palette module (canonical in `ui/lib/`, inlined copy in the classic `ui/app.js` script). Rework `ui/index.html` nav + sections and `ui/app.js` rendering so `Jobs` and `Shortlist` are static tabs backed by status filters, reusing the existing `/api/status` mutation endpoint and the `data-action`/`runAction` delegation.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`, vanilla browser JS (classic script `ui/app.js`), server `ui/server.mjs`, no new dependencies.

## Global Constraints

- Baseline branch: `origin/main` @ `cfa0919` (v0.1.0-beta.19). Work in the `agent/jobs-triage-rework` worktree.
- **No inline event handlers.** `ui/app.config.test.mjs` asserts `app.js`/`index.html` contain no `on(click|change|input|keydown|submit)=`. All interactivity uses `data-action` + `runAction`. Inline `style="…"` attributes are permitted.
- `ui/app.js` is a **classic script** (`<script src="/app.js">`), self-contained so a pre-update browser can boot. Shared helpers have a canonical tested copy in `ui/lib/*.mjs` and an inlined copy at the top of `app.js` (pattern: `ui/lib/scoutDiscovery.mjs`).
- Status vocabulary is the single source `STATUSES` in `ui/lib/tracker.mjs`; `setStatus` throws on unknown status.
- Escape all interpolated user/tracker data with `this.esc(...)` in markup.
- Use absolute ISO dates; run the full suite with `npm test` from repo root.
- Per `CLAUDE.md`: read `docs/OPERATIONS.md` first; update `docs/DOCUMENTATION.md`-referenced current guides/help/release notes together when user-visible behaviour changes; never commit private workspace data.

---

### Task 1: Add the `shortlist` status to the tracker domain

**Files:**
- Modify: `ui/lib/tracker.mjs:4`
- Test: `ui/lib/tracker.test.mjs`
- Test: `ui/server.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `STATUSES` now includes `'shortlist'`; `setStatus(data, id, 'shortlist')` succeeds. `POST /api/status {status:'shortlist'}` returns `{ok:true}`.

- [ ] **Step 1: Write the failing test** in `ui/lib/tracker.test.mjs`:

```js
test('setStatus accepts the shortlist status', () => {
  const data = { opportunities: [{ id: 'acme-eng-2026-07', status: 'new' }] };
  const next = setStatus(data, 'acme-eng-2026-07', 'shortlist');
  assert.equal(next.opportunities[0].status, 'shortlist');
  assert.equal(data.opportunities[0].status, 'new'); // input not mutated
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/lib/tracker.test.mjs`
Expected: FAIL with `invalid status: shortlist`.

- [ ] **Step 3: Add the status** — edit `ui/lib/tracker.mjs:4`:

```js
export const STATUSES = ['new', 'shortlist', 'watch', 'outreach', 'applied', 'interviewing', 'accepted', 'rejected', 'ignore'];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/lib/tracker.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add a server acceptance test** in `ui/server.test.mjs` following the existing `/api/status` test pattern in that file (locate the current status test with `grep -n "api/status" ui/server.test.mjs` and mirror its setup). Assert that posting `{ id, status: 'shortlist' }` to `POST /api/status` responds `ok:true` and the persisted tracker entry has `status: 'shortlist'`.

- [ ] **Step 6: Run the suite**

Run: `node --test ui/lib/tracker.test.mjs ui/server.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/lib/tracker.mjs ui/lib/tracker.test.mjs ui/server.test.mjs
git commit -m "feat: add shortlist status to tracker vocabulary"
```

---

### Task 2: Category colour palette module

**Files:**
- Create: `ui/lib/categoryColor.mjs`
- Test: `ui/lib/categoryColor.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CATEGORY_PALETTE`: array of `{ bg: string, fg: string }` (8 entries).
  - `categoryColor(categoryId: string, categoryIds: string[]) => { bg, fg }` — returns the palette entry at the category's index in `categoryIds`, wrapping modulo palette length; falls back to index 0 when not found.

- [ ] **Step 1: Write the failing test** `ui/lib/categoryColor.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATEGORY_PALETTE, categoryColor } from './categoryColor.mjs';

test('palette has eight distinct backgrounds with foregrounds', () => {
  assert.equal(CATEGORY_PALETTE.length, 8);
  const backgrounds = new Set(CATEGORY_PALETTE.map((c) => c.bg));
  assert.equal(backgrounds.size, 8);
  for (const entry of CATEGORY_PALETTE) {
    assert.match(entry.bg, /^#[0-9a-f]{6}$/i);
    assert.match(entry.fg, /^#[0-9a-f]{6}$/i);
  }
});

test('colour is assigned by index and is stable', () => {
  const ids = ['startup', 'established'];
  assert.deepEqual(categoryColor('startup', ids), CATEGORY_PALETTE[0]);
  assert.deepEqual(categoryColor('established', ids), CATEGORY_PALETTE[1]);
});

test('index wraps past the palette length', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
  assert.deepEqual(categoryColor('c8', ids), CATEGORY_PALETTE[0]);
  assert.deepEqual(categoryColor('c9', ids), CATEGORY_PALETTE[1]);
});

test('unknown category falls back to the first colour', () => {
  assert.deepEqual(categoryColor('missing', ['startup']), CATEGORY_PALETTE[0]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/lib/categoryColor.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `ui/lib/categoryColor.mjs`:**

```js
// Category colour palette: stable, index-assigned tags that replace the old
// per-category lane headings. Canonical copy — the classic ui/app.js inlines a
// matching categoryColor() so a pre-update browser can still boot.
export const CATEGORY_PALETTE = [
  { bg: '#5b8def', fg: '#ffffff' }, // blue
  { bg: '#e0794b', fg: '#ffffff' }, // orange
  { bg: '#3bb59a', fg: '#04231c' }, // teal
  { bg: '#9d7be0', fg: '#ffffff' }, // purple
  { bg: '#d1495b', fg: '#ffffff' }, // rose
  { bg: '#4c9f70', fg: '#ffffff' }, // green
  { bg: '#c9a227', fg: '#241f04' }, // amber
  { bg: '#5c7a99', fg: '#ffffff' }, // slate
];

export function categoryColor(categoryId, categoryIds) {
  const index = Array.isArray(categoryIds) ? categoryIds.indexOf(categoryId) : -1;
  const position = index >= 0 ? index : 0;
  return CATEGORY_PALETTE[position % CATEGORY_PALETTE.length];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ui/lib/categoryColor.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/lib/categoryColor.mjs ui/lib/categoryColor.test.mjs
git commit -m "feat: add category colour palette helper"
```

---

### Task 3: Inline the colour helper and render a colour tag on cards

Adds the inlined `categoryColor`/`CATEGORY_PALETTE` to `app.js`, a `tagHtml(e)` helper, and a `tabForEntry(e)` router used by later tasks and the All tab.

**Files:**
- Modify: `ui/app.js` (top-level helpers near lines 35–46; add methods near `cardHtml`/`metaLine` ~line 596–623; update All-tab row ~line 837 and discovery routing ~line 588)
- Test: `ui/app.config.test.mjs`

**Interfaces:**
- Consumes: `this.categoryOf(e)`, `this.categoryLabel(id)`, `this.categoryIds()` (existing).
- Produces:
  - top-level `categoryColor(categoryId, categoryIds)` and `CATEGORY_PALETTE` (identical to Task 2).
  - `Scout.tagHtml(e) => string` — a `<span class="cat-tag" style="background:…;color:…">Label</span>`.
  - `Scout.tabForEntry(e) => 'jobs' | 'shortlist' | 'pipeline'`.

- [ ] **Step 1: Write the failing test** in `ui/app.config.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/app.config.test.mjs`
Expected: FAIL (`scout.tagHtml is not a function`).

- [ ] **Step 3: Add the inlined helper** near the other top-level helpers in `ui/app.js` (after `mergeAcknowledged`, ~line 46). Paste the exact `CATEGORY_PALETTE` and `categoryColor` from Task 2 Step 3 (repeat verbatim — do not import; the browser loads this as a classic script):

```js
const CATEGORY_PALETTE = [
  { bg: '#5b8def', fg: '#ffffff' }, { bg: '#e0794b', fg: '#ffffff' },
  { bg: '#3bb59a', fg: '#04231c' }, { bg: '#9d7be0', fg: '#ffffff' },
  { bg: '#d1495b', fg: '#ffffff' }, { bg: '#4c9f70', fg: '#ffffff' },
  { bg: '#c9a227', fg: '#241f04' }, { bg: '#5c7a99', fg: '#ffffff' },
];
function categoryColor(categoryId, categoryIds) {
  const index = Array.isArray(categoryIds) ? categoryIds.indexOf(categoryId) : -1;
  const position = index >= 0 ? index : 0;
  return CATEGORY_PALETTE[position % CATEGORY_PALETTE.length];
}
```

- [ ] **Step 4: Add `tagHtml` and `tabForEntry` methods** to the `Scout` object near `cardHtml` (~line 607):

```js
  tagHtml(e) {
    const id = this.categoryOf(e);
    const color = categoryColor(id, this.categoryIds());
    return `<span class="cat-tag" style="background:${color.bg};color:${color.fg}">${this.esc(this.categoryLabel(id))}</span>`;
  },
  tabForEntry(e) {
    if (e.status === 'new') return 'jobs';
    if (e.status === 'shortlist') return 'shortlist';
    return 'pipeline';
  },
```

- [ ] **Step 5: Route the All-tab row and discovery by status.** In the All-table row (~line 837) replace `data-tab="${this.esc(this.categoryOf(e))}"` with `data-tab="${this.esc(this.tabForEntry(e))}"`. In the discovery reveal (~line 588) replace `this.showTab(this.categoryOf(first))` with `this.showTab(this.tabForEntry(first))`.

- [ ] **Step 6: Run tests**

Run: `node --test ui/app.config.test.mjs`
Expected: PASS (including the existing "no inline handlers" test).

- [ ] **Step 7: Commit**

```bash
git add ui/app.js ui/app.config.test.mjs
git commit -m "feat: inline category colour helper and render card tags"
```

---

### Task 4: Static Jobs + Shortlist tabs in markup and CSS

Converts the two dynamic category tabs/sections into two static tabs, adds tag/triage/undo CSS, and points defaults at `jobs`. Rendering logic follows in Tasks 5–6; after this task the tabs exist but are empty.

**Files:**
- Modify: `ui/index.html` (nav ~lines 862–867, sections ~lines 875–880, `<style>` block)
- Modify: `ui/app.js` (`state.tab` default ~line 53)
- Test: `ui/app.config.test.mjs` (or `ui/responsive.test.mjs` for markup assertions — match where existing tab-markup assertions live)

**Interfaces:**
- Consumes: nothing.
- Produces: DOM ids `tab-jobs`, `tab-shortlist`; nav buttons `data-tab="jobs"` (with `<span id="jobs-count">`) and `data-tab="shortlist"`; CSS classes `.cat-tag`, `.triage-actions`, `.triage-yes`, `.triage-no`, `.tab-badge`, `.inbox-empty`, `#undo-toast`.

- [ ] **Step 1: Write the failing test** in `ui/app.config.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ui/app.config.test.mjs`
Expected: FAIL (still has `data-tab="startup"`).

- [ ] **Step 3: Replace the nav buttons** at `ui/index.html:862-863`:

```html
      <button data-tab="jobs" class="active">Jobs <span id="jobs-count" class="tab-badge hidden"></span></button>
      <button data-tab="shortlist">Shortlist</button>
```

- [ ] **Step 4: Replace the sections** at `ui/index.html:875-876`:

```html
    <section id="tab-jobs"></section>
    <section id="tab-shortlist" class="hidden"></section>
```

- [ ] **Step 5: Add CSS** to the `<style>` block in `ui/index.html`:

```css
    .cat-tag { font-size:11px; font-weight:600; padding:2px 9px; border-radius:20px; display:inline-block; }
    .tab-badge { background:#7fd1ff; color:#04222e; border-radius:20px; padding:0 7px; font-size:11px; font-weight:700; margin-left:2px; }
    .tab-badge.hidden { display:none; }
    .triage-actions { display:flex; gap:10px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border,#2c313a); }
    .triage-actions .act { flex:1; }
    .triage-no { color:#c98b8b; }
    .triage-yes { background:#1f7a4d; color:#fff; }
    .inbox-empty { color:var(--muted,#8b93a0); }
    #undo-toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#2a2420; border:1px solid #4a3a2a; color:#d7c3a8; border-radius:10px; padding:11px 14px; display:flex; gap:14px; align-items:center; z-index:50; }
    #undo-toast.hidden { display:none; }
    #undo-toast button { background:none; border:none; color:#f0a982; font-weight:600; cursor:pointer; }
```

- [ ] **Step 6: Add the undo toast element** just before the closing `</body>` in `ui/index.html` (a single hidden container the app fills in):

```html
    <div id="undo-toast" class="hidden" role="status" aria-live="polite"></div>
```

- [ ] **Step 7: Default the start tab to `jobs`** — `ui/app.js:53` change `tab: 'startup',` to `tab: 'jobs',`.

- [ ] **Step 8: Run tests**

Run: `node --test ui/app.config.test.mjs`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ui/index.html ui/app.js
git commit -m "feat: add static Jobs and Shortlist tab markup and styles"
```

---

### Task 5: Render the Jobs inbox and wire triage actions

**Files:**
- Modify: `ui/app.js` — add `triageCardHtml`, `renderJobs`, `updateJobsBadge`, `triageYes`, `triageNo`, `undoDismiss`, `showUndo`, `hideUndo`; extend `runAction` (~line 2243) and `showTab` (~lines 2230–2236).
- Test: `ui/app.config.test.mjs`

**Interfaces:**
- Consumes: `filteredEntries`, `fitClass`, `metaLine`, `tagHtml`, `latestScanCard`, `filterBar`, `post`.
- Produces:
  - `renderJobs()` fills `#tab-jobs` with only `status:'new'` entries, score-desc.
  - `triageCardHtml(e)` — Style-B card with `data-action="triage-no"`/`"triage-yes"` footer buttons.
  - `triageYes(id)` → `POST /api/status {status:'shortlist'}`; `triageNo(id)` → `POST /api/status {status:'ignore'}` then `showUndo(id)`; `undoDismiss(id)` → `POST /api/status {status:'new'}` then `hideUndo()`.
  - `runAction` handles `triage-yes`, `triage-no`, `undo-dismiss`.

- [ ] **Step 1: Write the failing tests** in `ui/app.config.test.mjs`. Use a minimal fake `document` so `renderJobs` can write markup, and capture `post` calls:

```js
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
  scout.triageYes('a');
  scout.triageNo('b');
  scout.undoDismiss('b');
  assert.deepEqual(calls[0], ['/api/status', { id: 'a', status: 'shortlist' }]);
  assert.deepEqual(calls[1], ['/api/status', { id: 'b', status: 'ignore' }]);
  assert.deepEqual(calls[2], ['/api/status', { id: 'b', status: 'new' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test ui/app.config.test.mjs`
Expected: FAIL (`scout.renderJobs is not a function`).

- [ ] **Step 3: Add rendering + actions** to the `Scout` object in `ui/app.js` (place near the old `renderCategory`, which Task 7 removes):

```js
  triageCardHtml(e) {
    const score = typeof e.score === 'number' ? e.score : '-';
    return `<div class="card triage-card" data-id="${this.esc(e.id)}" role="button" tabindex="0">
      <div class="chiprow">${this.tagHtml(e)}<span class="score ${this.fitClass(e.score)}">${this.esc(score)}</span></div>
      <div class="top"><b>${this.esc(e.company)} - ${this.esc(e.role)}</b></div>
      <div class="meta">${this.metaLine(e)}</div>
      <div class="detail"></div>
      <div class="triage-actions">
        <button class="act triage-no" data-action="triage-no" data-id="${this.esc(e.id)}">No</button>
        <button class="act triage-yes" data-action="triage-yes" data-id="${this.esc(e.id)}">Yes, shortlist</button>
      </div>
    </div>`;
  },

  renderJobs() {
    if (!this.state.data) return;
    const target = document.getElementById('tab-jobs');
    if (!target) return;
    const entries = this.filteredEntries('all')
      .filter((e) => e.status === 'new')
      .sort((a, b) => (typeof b.score === 'number' ? b.score : -1) - (typeof a.score === 'number' ? a.score : -1));
    const list = entries.length
      ? entries.map((e) => this.triageCardHtml(e)).join('')
      : (this.latestScanCard() || '<p class="inbox-empty">All caught up - nothing new to review.</p>');
    target.innerHTML = this.filterBar()
      + `<div class="label">${entries.length} new job${entries.length === 1 ? '' : 's'} to review</div>`
      + list;
    this.updateJobsBadge(entries.length);
  },

  updateJobsBadge(count) {
    const badge = document.getElementById('jobs-count');
    if (!badge) return;
    badge.textContent = count ? String(count) : '';
    badge.classList.toggle('hidden', !count);
  },

  triageYes(id) { this.post('/api/status', { id, status: 'shortlist' }); },
  triageNo(id) { this.post('/api/status', { id, status: 'ignore' }).then((r) => { if (r && r.ok) this.showUndo(id); }); },
  undoDismiss(id) { this.post('/api/status', { id, status: 'new' }).then(() => this.hideUndo()); },

  showUndo(id) {
    const toast = document.getElementById('undo-toast');
    if (!toast) return;
    toast.innerHTML = `<span>${this.esc(this.company(id))} dismissed</span>`
      + `<button data-action="undo-dismiss" data-id="${this.esc(id)}">Undo</button>`;
    toast.classList.remove('hidden');
    window.clearTimeout?.(this.undoTimer);
    this.undoTimer = window.setTimeout?.(() => this.hideUndo(), 6000);
  },
  hideUndo() {
    window.clearTimeout?.(this.undoTimer);
    document.getElementById('undo-toast')?.classList.add('hidden');
  },
```

- [ ] **Step 4: Extend `runAction`** (~line 2243) with three cases before `default`:

```js
      case 'triage-yes': return this.triageYes(id);
      case 'triage-no': return this.triageNo(id);
      case 'undo-dismiss': return this.undoDismiss(id);
```

- [ ] **Step 5: Route `showTab` to `renderJobs`.** In `showTab` (~line 2230) change the tab-id list from `[...this.categoryIds(), 'pipeline', 'all', 'reports', 'cv']` to `['jobs', 'shortlist', 'pipeline', 'all', 'reports', 'cv']`, and replace the `if (this.categoryIds().includes(tab)) this.renderCategory(tab);` line with:

```js
    if (tab === 'jobs') this.renderJobs();
    if (tab === 'shortlist') this.renderShortlist();
```

(`renderShortlist` is added in Task 6; add the line now — it is only called when the shortlist tab is shown, which Task 6 completes. If running the suite between tasks, add a temporary `renderShortlist() {}` no-op and replace it in Task 6.)

- [ ] **Step 6: Run tests**

Run: `node --test ui/app.config.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/app.js ui/app.config.test.mjs
git commit -m "feat: render Jobs triage inbox with yes/no and undo"
```

---

### Task 6: Render the Shortlist tab and its Remove action

**Files:**
- Modify: `ui/app.js` — add `shortlistCardHtml`, `renderShortlist`, `removeFromShortlist`; extend `runAction`.
- Test: `ui/app.config.test.mjs`

**Interfaces:**
- Consumes: `filteredEntries`, `tagHtml`, `metaLine`, `fitClass`, `post`, `showUndo`.
- Produces:
  - `renderShortlist()` fills `#tab-shortlist` with only `status:'shortlist'` entries.
  - `removeFromShortlist(id)` → `POST /api/status {status:'ignore'}` then `showUndo(id)`.
  - `runAction` handles `remove-shortlist`.

- [ ] **Step 1: Write the failing test** in `ui/app.config.test.mjs`:

```js
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
  assert.deepEqual(calls[0], ['/api/status', { id: 'b', status: 'ignore' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test ui/app.config.test.mjs`
Expected: FAIL (`scout.renderShortlist is not a function` / no-op returns nothing).

- [ ] **Step 3: Implement** in `ui/app.js` (replace the Task 5 temporary `renderShortlist` no-op):

```js
  shortlistCardHtml(e) {
    const score = typeof e.score === 'number' ? e.score : '-';
    return `<div class="card" data-id="${this.esc(e.id)}" role="button" tabindex="0">
      <div class="chiprow">${this.tagHtml(e)}<span class="score ${this.fitClass(e.score)}">${this.esc(score)}</span></div>
      <div class="top"><b>${this.esc(e.company)} - ${this.esc(e.role)}</b></div>
      <div class="meta">${this.metaLine(e)}</div>
      <div class="detail"></div>
      <div class="triage-actions">
        <button class="act triage-no" data-action="remove-shortlist" data-id="${this.esc(e.id)}">Remove</button>
        <button class="act bridge" data-action="choose-cv-options" data-id="${this.esc(e.id)}">Create tailored CV</button>
      </div>
    </div>`;
  },

  renderShortlist() {
    if (!this.state.data) return;
    const target = document.getElementById('tab-shortlist');
    if (!target) return;
    const entries = this.filteredEntries('all')
      .filter((e) => e.status === 'shortlist')
      .sort((a, b) => (typeof b.score === 'number' ? b.score : -1) - (typeof a.score === 'number' ? a.score : -1));
    const list = entries.length
      ? entries.map((e) => this.shortlistCardHtml(e)).join('')
      : '<p class="inbox-empty">Nothing shortlisted yet. Tap "Yes" on a job to add it here.</p>';
    target.innerHTML = this.filterBar()
      + `<div class="label">Shortlist (${entries.length})</div>`
      + list;
  },

  removeFromShortlist(id) { this.post('/api/status', { id, status: 'ignore' }).then((r) => { if (r && r.ok) this.showUndo(id); }); },
```

- [ ] **Step 4: Extend `runAction`** with:

```js
      case 'remove-shortlist': return this.removeFromShortlist(id);
```

- [ ] **Step 5: Run tests**

Run: `node --test ui/app.config.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/app.js ui/app.config.test.mjs
git commit -m "feat: render Shortlist tab with remove action"
```

---

### Task 7: Remove dead category-lane code and refresh render call sites

Deletes the now-unused dynamic-lane machinery and points every render/refresh path at the new tabs.

**Files:**
- Modify: `ui/app.js` — remove `setupCategoryUi` (~661) and its call site; remove `renderCategory` (~686); update `applyWorkspaceConfig` (~657), `setCommuteFilter` (~644), and any other `categoryIds().forEach(... renderCategory ...)` call sites to call `renderJobs()` + `renderShortlist()`; delete the now-unused `this.showTab(this.state.tab)` inside `setupCategoryUi`.
- Test: `ui/app.config.test.mjs`

**Interfaces:**
- Consumes: `renderJobs`, `renderShortlist`.
- Produces: no `renderCategory`/`setupCategoryUi` symbols remain.

- [ ] **Step 1: Locate every reference**

Run: `grep -n "renderCategory\|setupCategoryUi" ui/app.js`
Record each line; each must be removed or repointed in Step 3.

- [ ] **Step 2: Write the failing test** in `ui/app.config.test.mjs`:

```js
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
```

- [ ] **Step 3: Delete and repoint.**
  - Delete the whole `setupCategoryUi() { … }` method and its invocation (find with the Step 1 grep; the call is in the data-load path — replace the call with nothing, since `index.html` now hosts the static tabs).
  - Delete the whole `renderCategory(category) { … }` method.
  - In `applyWorkspaceConfig` (~657) and `setCommuteFilter` (~644), replace `this.categoryIds().forEach((category) => this.renderCategory(category));` with:

```js
    this.renderJobs();
    this.renderShortlist();
```
  - Confirm the Step 1 grep now returns no lines except test files.

- [ ] **Step 4: Run tests**

Run: `node --test ui/app.config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 6: Commit**

```bash
git add ui/app.js ui/app.config.test.mjs
git commit -m "refactor: remove dynamic category lanes in favour of Jobs/Shortlist tabs"
```

---

### Task 8: Manual verification and documentation

**Files:**
- Modify: user-facing docs/help/release notes as directed by `docs/DOCUMENTATION.md` (e.g. in-app help copy referencing "Priority/Explore" tabs, and the current UI guide). Update `docs/OPERATIONS.md` only if operations changed (they do not here).

- [ ] **Step 1: Read `docs/DOCUMENTATION.md`** and list every current guide / in-app help string that describes the old Priority/Explore tabs or the triage flow.

- [ ] **Step 2: Update those docs/help** to describe: single **Jobs** triage inbox, colour-coded category tags, one-tap **Yes → Shortlist** / **No → dismiss (with undo)**, and the new **Shortlist** tab. Keep guides version-neutral.

- [ ] **Step 3: Manual smoke test.** Start the app (`npm start` or the documented dev command from `docs/OPERATIONS.md`) against a synthetic/test workspace with a few `new` opportunities across two categories. Verify:
  - Jobs tab shows only new jobs with distinct colour tags and a count badge.
  - "Yes, shortlist" moves a card to the Shortlist tab.
  - "No" removes the card and shows the undo toast; Undo restores it to Jobs.
  - Shortlist "Remove" dismisses with undo; "Create tailored CV" opens the existing options flow.
  - Reload persists all transitions; ignored jobs appear in All and not in Jobs.

- [ ] **Step 4: Commit docs**

```bash
git add docs
git commit -m "docs: describe Jobs triage inbox and Shortlist tab"
```

---

## Self-Review

**Spec coverage (Part A):**
- A1 status model → Task 1 (`shortlist` status), Tasks 5–6 (Yes/No/undo/remove transitions). ✓
- A2 colour palette → Task 2 (module), Task 3 (inlined + `tagHtml`). ✓
- A3 Jobs inbox (only `new`, score-desc, Style-B card, expand, badge, empty state, commute filter) → Task 4 (markup/CSS), Task 5 (render + badge + empty state; filter bar retained; expand via existing `.card[data-id]` delegation). ✓
- A4 Shortlist tab (list, tags, create-CV, Remove→ignore+undo) → Task 4 (tab), Task 6. ✓
- A5 Testing → tests in every task; full suite in Task 7; manual smoke in Task 8. ✓
- Removal of `setupCategoryUi`/`renderCategory`/lane sections → Task 4 (markup), Task 7 (code). ✓

**Placeholder scan:** No TBD/TODO; all code blocks concrete; the only "temporary no-op" (`renderShortlist`) is explicitly created in Task 5 and replaced in Task 6. ✓

**Type consistency:** `categoryColor(categoryId, categoryIds) => {bg,fg}` identical in Tasks 2 and 3; `tagHtml`, `tabForEntry`, `renderJobs`, `renderShortlist`, `triageYes/No`, `undoDismiss`, `removeFromShortlist`, `showUndo/hideUndo`, `updateJobsBadge` names consistent across tasks and `runAction` cases (`triage-yes`, `triage-no`, `undo-dismiss`, `remove-shortlist`). `/api/status` payload shape `{id,status}` matches the existing endpoint (Task 1). ✓

**Note for executor:** Between Task 5 and Task 6 the suite passes only with the temporary `renderShortlist` no-op in place; do not skip Task 6.
