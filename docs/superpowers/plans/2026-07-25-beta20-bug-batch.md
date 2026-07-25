# beta.20 Bug Batch — Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five open beta19 bugs (#51–#55) so scan schedules stay editable, Reports renders correctly, the CV workflow is clear and separable, and tailored CVs are keyed per role instead of per company.

**Architecture:** Four contained fixes (#51–#54) touching `ui/setup.js`, `ui/server.mjs`, `ui/index.html`, `ui/reportView.js`, and `ui/app.js`. One larger change (#55) that re-keys tailored CV artifacts from company slug to the tracked opportunity id, with a **non-destructive** migration: nothing on disk is moved, renamed, or deleted — legacy company-slug directories stay readable and are mapped to their opportunity through an index.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert/strict`, Playwright (`tests/browser/`), vanilla browser JS (`ui/app.js` classic script, `ui/setup.js` module), no new dependencies.

## Global Constraints

- Baseline: `origin/main` @ `de5263f`. Work in the `agent/beta20-bug-batch` worktree.
- **No inline event handlers** (`on(click|change|input|keydown|submit)=`) in `ui/app.js` / `ui/index.html`; use `data-action` + `runAction`. Inline `style=` is allowed. Enforced by `ui/app.config.test.mjs`.
- `ui/app.js` is a **classic script** (cannot `import`); shared helpers keep a canonical tested copy in `ui/lib/*.mjs` and a verbatim inlined copy in `app.js`.
- Escape interpolated tracker data with `this.esc(...)` (`ui/app.js`) / `this.escape(...)` (`ui/setup.js`).
- **Never destroy user artifacts.** Migration copies or indexes; it must not move, rename, overwrite, or delete anything under `applications/`.
- Per `CLAUDE.md`: read `docs/OPERATIONS.md` first; keep private workspace data (CV, profile, tracker, reports, credentials, personal paths, hostnames) out of this public repo; use absolute ISO dates; keep current guides version-neutral; update docs/help/tests together.
- Full suite: `npm test` from repo root. Browser suite: `npm run test:browser`. Both must pass before the final task.

---

### Task 1: #51 — Keep configured scan schedules editable after an unhealthy run

The healthy-supervised-scan gate may guard **first enablement** only. Updating an already-configured job's time, days, or model must always be possible.

**Files:**
- Modify: `ui/setup.js` (`renderFirstScan`, ~lines 985–1018)
- Modify: `ui/server.mjs` (`routes['POST /api/schedule']`, the `b.action === 'install'` branch)
- Test: `ui/setup.test.mjs`, `ui/server.test.mjs`

**Interfaces:**
- Consumes: `readScanHealth()`, `loadWorkspaceConfig(WORKSPACE_ROOT)` (existing).
- Produces: `POST /api/schedule {action:'install'}` succeeds for an already-configured `id` regardless of scan health; returns 409 only when the id is not yet configured **and** health is unhealthy.

- [ ] **Step 1: Write the failing server test** in `ui/server.test.mjs`. Mirror the existing `/api/schedule` test setup in that file (find it with `grep -n "api/schedule" ui/server.test.mjs`). Two cases:

```js
// 1) update of an already-configured job succeeds despite unhealthy latest scan
//    - seed workspace config with schedule.jobs = [{ id: 'claude-primary', enabled: true, ... }]
//    - make readScanHealth report an unhealthy/stale latest run
//    - POST /api/schedule { action:'install', id:'claude-primary', time:'09:15', model:<valid> }
//    - assert response status 200 and ok:true
// 2) first enablement of an UNconfigured id still returns 409 when unhealthy
//    - POST /api/schedule { action:'install', id:'codex-verify', ... }
//    - assert status 409 and the existing error message
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test ui/server.test.mjs`
Expected: case 1 FAILS with 409 (`complete a healthy supervised scan before enabling daily scans`).

- [ ] **Step 3: Gate only first enablement** in `ui/server.mjs`. Replace the two health-gate lines inside the `b.action === 'install'` branch with:

```js
      const configured = (config.schedule?.jobs || []).some((job) => job.id === id);
      if (!configured) {
        const health = readScanHealth();
        if (!health.lastRunAt || !health.healthy) return replyJson(res, 409, { error: 'complete a healthy supervised scan before enabling daily scans' });
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test ui/server.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing client test** in `ui/setup.test.mjs`, following the existing render-assertion pattern in that file. Assert that when a job is already configured (`run.configured === true`) and scan health is unhealthy, the rendered `Save scan settings` button is **not** disabled; and that the heading/callout do not use first-run wording ("Run your first search with me" / "Supervised first scan") when configured jobs or a previous run exist.

- [ ] **Step 6: Run to verify it fails**

Run: `node --test ui/setup.test.mjs`
Expected: FAIL (button carries `disabled`; first-run wording present).

- [ ] **Step 7: Fix the client gate** in `ui/setup.js` `renderFirstScan`. Keep `healthy` for the wording, and add a separate flag for the action gate. In the schedule-action button (~line 1008) replace `${healthy ? '' : 'disabled'}` with `${(healthy || run?.configured) ? '' : 'disabled'}`. For the first-run wording (~lines 1014, 1016), replace the bare `healthy` condition with a `hasHistory` value computed near `healthy`:

```js
    const configuredJobs = (this.status?.config?.schedule?.jobs || []).some((job) => job.enabled !== false);
    const hasHistory = Boolean(health.lastRunAt) || configuredJobs;
```

Use `hasHistory` (not `healthy`) to choose between first-run and returning-user wording at lines ~1014 and ~1016, and for the `Run first scan now` / `Scan now` button label (~line 1018). Leave the actual health/outcome text driven by `healthy`.

- [ ] **Step 8: Run to verify it passes**

Run: `node --test ui/setup.test.mjs ui/server.test.mjs`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add ui/setup.js ui/server.mjs ui/setup.test.mjs ui/server.test.mjs
git commit -m "fix: keep configured scan schedules editable after an unhealthy run (#51)"
```

---

### Task 2: #52a — Stop the report-date navigation collapsing the desktop layout

The global `nav { display: flex }` rule also hits `<nav class="dates">`, so the date list becomes a horizontal row and expands to min-content, crushing `.report-body`.

**Files:**
- Modify: `ui/index.html` (`.report-list .dates` rule, ~line 371)
- Test: `ui/responsive.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `.report-list .dates` renders as a fixed-width vertical sidebar.

- [ ] **Step 1: Write the failing test** in `ui/responsive.test.mjs`, following the existing CSS-assertion style in that file (it reads `ui/index.html` as text). Assert the `.report-list .dates` rule declares a column direction and a bounded minimum width:

```js
test('report date navigation stays a vertical sidebar on desktop', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const rule = html.match(/\.report-list \.dates \{[^}]*\}/);
  assert.ok(rule, 'expected a .report-list .dates rule');
  assert.match(rule[0], /flex-direction:\s*column/);
  assert.match(rule[0], /min-width:\s*0/);
  assert.match(rule[0], /flex:\s*0 0 220px/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test ui/responsive.test.mjs`
Expected: FAIL (no `flex-direction`/`min-width` in the rule).

- [ ] **Step 3: Constrain the nav** in `ui/index.html` — add two declarations to the existing `.report-list .dates` rule (keep every current declaration):

```css
      flex-direction: column;
      min-width: 0;
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test ui/responsive.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/index.html ui/responsive.test.mjs
git commit -m "fix: keep report date navigation a vertical sidebar (#52)"
```

---

### Task 3: #52b — Render nested Markdown headings in reports

`blockHtml` recognises paragraphs and lists but not `###`+ headings, so a valid nested heading renders as a paragraph containing the raw marker.

**Files:**
- Modify: `ui/reportView.js` (`blockHtml`)
- Test: `ui/reportView.test.mjs`

**Interfaces:**
- Consumes: existing `inline()` helper.
- Produces: `blockHtml` emits `<h4>`–`<h6>` for `###`–`#####` (section titles already use `<h3>` for `##`).

- [ ] **Step 1: Write the failing test** in `ui/reportView.test.mjs`, following the existing parse/render assertions in that file:

```js
test('nested markdown headings render as headings, not raw text', () => {
  const html = ScoutReportView.render(['# Daily report', '', '## Discarded', '', '### Closest reviewed roles not kept', '', 'Body text.'].join('\n'));
  assert.match(html, /<h4>Closest reviewed roles not kept<\/h4>/);
  assert.doesNotMatch(html, /###/);
});
```

Adjust the entry point to whatever the module exposes (check the top of `ui/reportView.test.mjs` for how it invokes rendering) — the assertion content stays the same.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test ui/reportView.test.mjs`
Expected: FAIL — output contains `<p>### Closest reviewed roles not kept</p>`.

- [ ] **Step 3: Handle headings** in `ui/reportView.js` `blockHtml`. Inside the `for (const raw of lines)` loop, **before** the `checklist`/`unordered`/`ordered` matches, add:

```js
      const heading = raw.match(/^\s*(#{3,6})\s+(.+?)\s*$/);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length + 1, 6);
        output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test ui/reportView.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/reportView.js ui/reportView.test.mjs
git commit -m "fix: render nested markdown headings in reports (#52)"
```

---

### Task 4: #53 — Make the tailored-CV controls reachable and clearly named

Three defects: the CV tab inherits the previous tab's scroll position; a long opportunity label pushes **Continue** off-screen; and the actions don't say what starts generation.

**Files:**
- Modify: `ui/app.js` (`showTab`; the CV create panel markup in the CV library render; action labels)
- Modify: `ui/index.html` (CV create panel CSS)
- Test: `ui/app.config.test.mjs`, `ui/responsive.test.mjs`

**Interfaces:**
- Consumes: existing `showTab`, `toggleCvCreate`, `startCvCreate`.
- Produces: `showTab` resets scroll to top on tab change; the create panel's select is width-bounded; actions read **Review CV options** and **Start tailored CV**.

- [ ] **Step 1: Write the failing tests** in `ui/app.config.test.mjs`:

```js
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
```

And in `ui/responsive.test.mjs`:

```js
test('CV create panel keeps its primary action on screen', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const rule = html.match(/\.cv-create[^{]*\{[^}]*\}/);
  assert.ok(rule, 'expected a .cv-create rule');
  assert.match(html, /\.cv-create select \{[^}]*max-width/);
  assert.match(html, /\.cv-create label \{[^}]*min-width:\s*0/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test ui/app.config.test.mjs ui/responsive.test.mjs`
Expected: FAIL on all three.

- [ ] **Step 3: Reset scroll on tab change** — in `ui/app.js` `showTab`, after the section visibility toggling and before the per-tab render dispatch, add:

```js
    window.scrollTo?.(0, 0);
```

- [ ] **Step 4: Bound the create panel** — add to the `<style>` block in `ui/index.html`:

```css
    .cv-create { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .cv-create label { min-width: 0; flex: 1 1 240px; display: flex; gap: 6px; align-items: center; }
    .cv-create select { min-width: 0; max-width: 100%; flex: 1 1 auto; text-overflow: ellipsis; }
```

Locate the CV create panel markup in `ui/app.js` (search: `cv-create-opportunity`) and ensure its container carries `class="cv-create"`, adding the class if absent.

- [ ] **Step 5: Rename the actions for their outcome** — in the same CV library markup in `ui/app.js`, change the create-panel toggle button text from `Create tailored CV` to `Review CV options`, and the confirm button text from `Continue` to `Start tailored CV`. Update the CV options modal's confirm control in `ui/index.html` (`id="cv-options-continue"`) to read `Start tailored CV` as well. Do **not** change any `data-action` values — only the visible labels.

- [ ] **Step 6: Run to verify they pass**

Run: `node --test ui/app.config.test.mjs ui/responsive.test.mjs`
Expected: PASS.

- [ ] **Step 7: Check the browser suite still matches the labels**

Run: `grep -rn "Create tailored CV\|Continue" tests/browser/`
Update any Playwright selector that targets the old label text to the new one. Then run `npm run test:browser` (if Playwright browsers are unavailable offline, say so in your report and verify the selectors against the markup instead of claiming a run).

- [ ] **Step 8: Commit**

```bash
git add ui/app.js ui/index.html ui/app.config.test.mjs ui/responsive.test.mjs tests/browser
git commit -m "fix: make tailored CV controls reachable and clearly named (#53)"
```

---

### Task 5: #54 — Separate CV saving from PDF rendering

`saveCv()` always saves **and** renders, so users cannot save without rendering or re-render without rewriting the source (which needlessly checkpoints a backup). Partial failures don't say what succeeded.

**Files:**
- Modify: `ui/app.js` (`saveCv`, add `renderCvOnly`, CV editor toolbar markup, `runAction`)
- Modify: `ui/index.html` (CV state indicator markup/CSS if needed)
- Test: `ui/app.config.test.mjs`

**Interfaces:**
- Consumes: existing `post`, `renderCvPreview`, `cvState`.
- Produces:
  - `saveCv()` — persists source only, then reports saved state. Does **not** render.
  - `renderCvOnly()` — renders the last saved source without re-posting `/api/cv/save`. Refuses with a clear message when the buffer is dirty.
  - `setCvStatus(text)` — writes a status line to `#cv-status`.
  - `runAction` handles `render-cv`.

- [ ] **Step 1: Write the failing tests** in `ui/app.config.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test ui/app.config.test.mjs`
Expected: FAIL (`saveCv` still calls the preview render; `renderCvOnly` undefined).

- [ ] **Step 3: Split the operations** in `ui/app.js`. Replace `saveCv` and add `renderCvOnly` + `setCvStatus`:

```js
  setCvStatus(text) {
    const status = document.getElementById('cv-status');
    if (status) status.textContent = text;
  },

  async saveCv() {
    if (!this.cvState.path) return alert('Open a file first.');
    const content = document.getElementById('cv-text').value;
    this.setCvStatus('Saving…');
    const save = await this.post('/api/cv/save', { path: this.cvState.path, content });
    if (!(save && save.ok)) return this.setCvStatus('Save failed. Your changes are still in the editor.');
    this.cvState.dirty = false;
    this.cvState.content = content;
    const dirty = document.getElementById('cv-dirty');
    if (dirty) dirty.textContent = '';
    this.setCvStatus('Saved. The PDF is out of date until you render it.');
  },

  async renderCvOnly() {
    if (!this.cvState.path) return alert('Open a file first.');
    if (this.cvState.dirty) return this.setCvStatus('Save your changes first — rendering uses the last saved source.');
    this.setCvStatus('Rendering PDF…');
    try {
      await this.renderCvPreview();
      this.setCvStatus('PDF rendered from the saved source.');
    } catch (error) {
      this.setCvStatus(`Saved source is intact. PDF render failed: ${error.message}`);
    }
  },
```

- [ ] **Step 4: Add the render control and status line.** In the CV editor toolbar markup in `ui/app.js` (search: `data-action="save-cv"`), change the save button's label to `save changes` and add immediately after it:

```js
             `<button id="cv-render" class="act" data-action="render-cv">render PDF</button>`
```

and add a status element beside the existing `cv-dirty` indicator:

```js
             `<span id="cv-status" class="meta"></span>`
```

- [ ] **Step 5: Wire the action** — add to the `runAction` switch in `ui/app.js`, beside the existing `save-cv` case:

```js
      case 'render-cv': return this.renderCvOnly();
```

- [ ] **Step 6: Run to verify they pass**

Run: `node --test ui/app.config.test.mjs`
Expected: PASS.

- [ ] **Step 7: Update browser selectors if needed**

Run: `grep -rn "save + render\|save-cv" tests/browser/`
Update any Playwright assertion that expects the combined `save + render` label. Run `npm run test:browser` (or report honestly if unavailable).

- [ ] **Step 8: Commit**

```bash
git add ui/app.js ui/index.html ui/app.config.test.mjs tests/browser
git commit -m "fix: separate CV save from PDF render with distinct states (#54)"
```

---

### Task 6: #55a — Key tailored CV artifacts by opportunity, with a non-destructive migration

Artifacts live at `applications/<company-slug>/`, so a second role at the same employer collides. New artifacts will use the tracked **opportunity id** (already stable, role-unique, and slug-shaped: `company-role-YYYY-MM`). Existing directories are left untouched on disk and mapped through an index.

**Files:**
- Create: `ui/lib/cvArtifacts.mjs`
- Test: `ui/lib/cvArtifacts.test.mjs`
- Modify: `ui/lib/cv.mjs` (`listCvFiles` — surface the opportunity each entry belongs to)
- Modify: `ui/server.mjs` (expose the resolved artifact key on the CV files route)

**Interfaces:**
- Consumes: `listCvFiles(root)` (existing), tracker opportunities (`{ id, company, role }`).
- Produces, from `ui/lib/cvArtifacts.mjs`:
  - `artifactSlugFor(opportunity) => string` — returns `opportunity.id` when it matches `/^[a-z0-9-]+$/`, else a sanitised fallback `slugify(company)-slugify(role)`.
  - `resolveArtifact(existingSlugs, opportunity, slugOfCompany) => { slug, legacy: boolean, ambiguous: boolean }` — prefers an existing directory named exactly `artifactSlugFor(opportunity)`; otherwise, if a legacy directory named `slugOfCompany(opportunity.company)` exists, returns it with `legacy: true` and `ambiguous: true` when more than one tracked opportunity shares that company slug; otherwise returns the new id-based slug with `legacy: false`.
  - `artifactOwners(existingSlugs, opportunities, slugOfCompany) => Map<string, string[]>` — directory slug → ids of opportunities it may belong to, for labelling the library.

- [ ] **Step 1: Write the failing test** `ui/lib/cvArtifacts.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactSlugFor, resolveArtifact, artifactOwners } from './cvArtifacts.mjs';

const slugOfCompany = (c) => String(c || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

test('artifact slug uses the stable opportunity id', () => {
  assert.equal(artifactSlugFor({ id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' }), 'acme-backend-engineer-2026-07');
});

test('artifact slug falls back to company-role when the id is not slug-shaped', () => {
  assert.equal(artifactSlugFor({ id: 'Acme/Eng 2026', company: 'Acme & Co', role: 'Backend Engineer' }), 'acme-and-co-backend-engineer');
});

test('an existing id-keyed directory is preferred', () => {
  const o = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  assert.deepEqual(resolveArtifact(['acme-backend-engineer-2026-07', 'acme'], o, slugOfCompany), { slug: 'acme-backend-engineer-2026-07', legacy: false, ambiguous: false });
});

test('a legacy company directory is reused and flagged', () => {
  const o = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  assert.deepEqual(resolveArtifact(['acme'], o, slugOfCompany), { slug: 'acme', legacy: true, ambiguous: false });
});

test('a legacy directory shared by two roles is ambiguous', () => {
  const o = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  const owners = artifactOwners(['acme'], [o, { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' }], slugOfCompany);
  assert.deepEqual(owners.get('acme'), ['acme-backend-engineer-2026-07', 'acme-frontend-engineer-2026-07']);
  assert.equal(resolveArtifact(['acme'], o, slugOfCompany, [o, { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' }]).ambiguous, true);
});

test('with no existing directory a fresh id-keyed slug is returned', () => {
  const o = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  assert.deepEqual(resolveArtifact([], o, slugOfCompany), { slug: 'acme-backend-engineer-2026-07', legacy: false, ambiguous: false });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test ui/lib/cvArtifacts.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `ui/lib/cvArtifacts.mjs`:**

```js
// Tailored CV artifacts are keyed by the tracked opportunity so two roles at one
// company never share a directory. Legacy company-slug directories stay exactly
// where they are: they are reused in place and flagged, never moved or deleted.
const SLUG = /^[a-z0-9-]+$/;

function slugify(value) {
  return String(value || '').toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function artifactSlugFor(opportunity) {
  const id = String(opportunity?.id || '');
  if (SLUG.test(id)) return id;
  return [slugify(opportunity?.company), slugify(opportunity?.role)].filter(Boolean).join('-');
}

export function artifactOwners(existingSlugs, opportunities, slugOfCompany) {
  const owners = new Map();
  for (const slug of existingSlugs || []) {
    const ids = (opportunities || [])
      .filter((o) => artifactSlugFor(o) === slug || slugOfCompany(o.company) === slug)
      .map((o) => o.id);
    owners.set(slug, ids);
  }
  return owners;
}

export function resolveArtifact(existingSlugs, opportunity, slugOfCompany, opportunities = []) {
  const slugs = new Set(existingSlugs || []);
  const preferred = artifactSlugFor(opportunity);
  if (slugs.has(preferred)) return { slug: preferred, legacy: false, ambiguous: false };
  const legacy = slugOfCompany(opportunity?.company);
  if (legacy && slugs.has(legacy)) {
    const sharing = (opportunities || []).filter((o) => slugOfCompany(o.company) === legacy).length;
    return { slug: legacy, legacy: true, ambiguous: sharing > 1 };
  }
  return { slug: preferred, legacy: false, ambiguous: false };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test ui/lib/cvArtifacts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/lib/cvArtifacts.mjs ui/lib/cvArtifacts.test.mjs
git commit -m "feat: resolve tailored CV artifacts by opportunity id (#55)"
```

---

### Task 7: #55b — Use opportunity-keyed artifacts in the CV workflow

Wire Task 6's resolver into the UI so creating a CV for a second role never silently opens another role's CV, and the library identifies the role.

**Files:**
- Modify: `ui/app.js` (inline the Task 6 helpers; `startCvCreate`, `chooseCvOptions`/`buildPrefills` path construction, `seeCv`, `seeCoverLetter`, the CV library entry labels, `opportunitiesForSlug`, the chat `filesTouched` check)
- Test: `ui/app.config.test.mjs`

**Interfaces:**
- Consumes: `artifactSlugFor`, `resolveArtifact` (inlined verbatim from `ui/lib/cvArtifacts.mjs`), `this.state.cvFiles.applications`, `this.state.data.opportunities`.
- Produces: `Scout.artifactSlugFor(entry)` and `Scout.resolveArtifactFor(entry)` used by every tailored-CV path in place of `this.slugOf(entry.company)`.

- [ ] **Step 1: Write the failing tests** in `ui/app.config.test.mjs`:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test ui/app.config.test.mjs`
Expected: FAIL — the first test opens `seeCv` because the company slug `acme` logic still applies.

- [ ] **Step 3: Inline the helpers** in `ui/app.js`, beside the other inlined top-level helpers. Paste `SLUG`, `slugify`, `artifactSlugFor`, and `resolveArtifact` verbatim from Task 6 Step 3 (do not import — classic script). Name the local constant `CV_SLUG` if `SLUG` collides with an existing identifier; check with `grep -n "const SLUG" ui/app.js` first.

- [ ] **Step 4: Add resolver methods** to the `Scout` object near `slugOf`:

```js
  artifactSlugFor(entry) { return artifactSlugFor(entry); },
  resolveArtifactFor(entry) {
    return resolveArtifact(
      this.state.cvFiles?.applications || [],
      entry,
      (company) => this.slugOf(company),
      this.state.data?.opportunities || [],
    );
  },
```

- [ ] **Step 5: Fix `startCvCreate`** — replace its body with:

```js
  startCvCreate() {
    const id = document.getElementById('cv-create-opportunity')?.value;
    if (!id) return;
    const entry = (this.state.data?.opportunities || []).find((item) => item.id === id);
    if (!entry) return;
    const resolved = this.resolveArtifactFor(entry);
    const exists = (this.state.cvFiles?.applications || []).includes(resolved.slug);
    if (exists && !resolved.legacy) return this.seeCv(resolved.slug, id);
    if (exists && resolved.legacy) {
      const owner = resolved.ambiguous ? 'another role at this company' : 'this company';
      if (!confirm(`Scout has an existing CV folder for ${owner}. Open it as-is? Choose Cancel to start a new CV tailored to this role.`)) {
        return this.chooseCvOptions(id);
      }
      return this.seeCv(resolved.slug, id);
    }
    this.chooseCvOptions(id);
  },
```

- [ ] **Step 6: Repoint the remaining company-slug sites.** Run `grep -n "slugOf(" ui/app.js` and, for every tailored-CV artifact path (the `applications/<slug>/cv.typ`, `outreach.md`, evidence, quality, download, and chat `filesTouched` sites — noted at approximately lines 1032, 1291, 1297, 1329, 1410, 1421, 1959 of the pre-change file), replace `this.slugOf(<entry>.company)` with `this.resolveArtifactFor(<entry>).slug`. Leave any non-artifact use of `slugOf` alone. For `opportunitiesForSlug(slug)` (~line 1410), match on either key so legacy folders still resolve:

```js
    return (this.state.data?.opportunities || []).filter((entry) =>
      this.artifactSlugFor(entry) === slug || this.slugOf(entry.company) === slug);
```

- [ ] **Step 7: Label library entries by role.** In the CV library entry markup (search: `cv-entry-label`), build the label from the owning opportunities rather than the bare slug: when `opportunitiesForSlug(slug)` returns exactly one entry, show `${company} — ${role}`; when it returns more than one, keep the existing multi-role wording but append `(shared folder — created before per-role CVs)`; when it returns none, show the slug unchanged. Escape all interpolated values with `this.esc(...)`.

- [ ] **Step 8: Run to verify they pass**

Run: `node --test ui/app.config.test.mjs`
Expected: PASS.

- [ ] **Step 9: Run the full suite and browser suite**

Run: `npm test` then `npm run test:browser`
Expected: PASS (report any pre-existing environmental failures explicitly, comparing against the parent commit with `git stash` if needed).

- [ ] **Step 10: Commit**

```bash
git add ui/app.js ui/app.config.test.mjs
git commit -m "fix: tailored CVs identify their role instead of sharing a company folder (#55)"
```

---

### Task 8: Documentation, release notes, and verification

**Files:**
- Modify: user-facing guides identified via `docs/DOCUMENTATION.md`
- Create: `docs/releases/0.1.0-beta.20.md`
- Modify: `package.json` (version → `0.1.0-beta.20`)

- [ ] **Step 1: Read `docs/OPERATIONS.md` and `docs/DOCUMENTATION.md`.** List every current guide / in-app help string affected by tasks 1–7.

- [ ] **Step 2: Update those guides/help** — schedules editable after an unhealthy run; Reports layout/nested headings; renamed CV actions (**Review CV options**, **Start tailored CV**); separate **save changes** / **render PDF**; per-role tailored CVs and what happens to folders created before this release. Keep guides version-neutral.

- [ ] **Step 3: Bump the version** in `package.json` to `0.1.0-beta.20`.

- [ ] **Step 4: Write `docs/releases/0.1.0-beta.20.md`** following the structure of `docs/releases/0.1.0-beta.19.md`. Cover:
  - the Jobs triage inbox + Shortlist tab (merged in PR #56);
  - fixes #51–#55 from this plan;
  - the four swarm-audit fixes merged from PR #57 (commit `da91c19`), which are already on this branch and must not be re-implemented: `DELETE /api/setup/proposal` no longer demands a JSON content-type; `setCommute` can clear a field again (`||` → `??`); report Markdown links are no longer double-escaped; `parseChecksums` tolerates trailing spaces and a `./` prefix.

  Include an explicit note that tailored CV folders created before this release are left exactly where they are, are still readable, and are reused in place with a prompt rather than being moved or deleted.

- [ ] **Step 5: Verify.** Run `npm test` and `npm run test:browser`; both must pass. Then start the app against a **synthetic** workspace only (never real private data) per `docs/OPERATIONS.md` and confirm: a configured schedule saves after an unhealthy run; Reports renders a `###` heading with a sidebar layout at desktop width; the CV tab opens at the top with **Start tailored CV** visible for a long opportunity label; **save changes** and **render PDF** report independently; and two roles at one company each get their own tailored CV. Report honestly anything you could not exercise.

- [ ] **Step 6: Commit**

```bash
git add docs package.json
git commit -m "docs: release notes and guides for 0.1.0-beta.20"
```

---

## Self-Review

**Spec coverage (Part B of the design):** B1 #51 → Task 1 ✓ (both the client gate and the server 409, plus first-run wording). B2 #52 → Tasks 2 and 3 ✓ (sidebar CSS; `###`+ headings). B3 #53 → Task 4 ✓ (scroll reset, bounded select, outcome-named actions). B4 #54 → Task 5 ✓ (separate save and render, distinct states, failure states that confirm the source is saved). B5 #55 → Tasks 6 and 7 ✓ (explicit opportunity identity, no silent substitution, explicit reuse prompt naming the source, role-identifying labels, and migration that cannot lose artifacts because nothing is moved or deleted). Docs/release → Task 8 ✓.

**Placeholder scan:** no TBD/TODO; every code step carries the actual code. Steps that must locate a call site give the exact `grep` to run.

**Type consistency:** `artifactSlugFor(opportunity) => string` and `resolveArtifact(existingSlugs, opportunity, slugOfCompany, opportunities?) => {slug, legacy, ambiguous}` are identical in Tasks 6 and 7; `Scout.resolveArtifactFor(entry)` wraps the latter and is the only form used at call sites; `setCvStatus`/`renderCvOnly`/`saveCv` names match their `runAction` case `render-cv`.

**Risk note for the executor:** Task 7 Step 6 edits several call sites. After it, `grep -n "slugOf(" ui/app.js` should show only non-artifact uses. Any remaining `applications/${this.slugOf(...)}` path is a bug.
