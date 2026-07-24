# Scout — Jobs triage rework & beta19 bug batch

**Date:** 2026-07-24
**Branch baseline:** `origin/main` @ `cfa0919` (v0.1.0-beta.19)
**Status:** Approved design, ready for implementation planning

## Problem

Scout's home screen splits new opportunities across dynamically generated
category lanes (today "Priority" / `startup` and "Explore" / `established`).
Each lane mixes untriaged new jobs with watch/active/closed items, so the daily
"is this worth pursuing?" decision is buried in noise. The user wants a fast
daily pass: see the handful of new jobs a scan found, tap yes or no on each, and
move on — without lanes full of jobs they no longer care about.

## Goals

- Replace the dynamic category lanes with a single **Jobs** tab that is a clean
  triage inbox of only untriaged new jobs.
- Preserve the category distinction as an auto-assigned **colour + tag** on each
  card instead of separate lane headings.
- One-tap **Yes** (shortlist) / **No** (dismiss) per card, with the card still
  expandable for full detail and the original advert source.
- Add a **Shortlist** tab for jobs the user said yes to but has not applied to.
- Fold in the five open beta19 bug fixes as a second, independent workstream.

## Non-goals

- No change to scanning, scoring, deduplication, or report generation.
- No change to Pipeline, All, Reports, or CV tab behaviour (beyond the bug
  fixes listed in Part B).
- No new setup UI for category colours (auto-assigned).

---

## Part A — Jobs triage rework

### A1. Data model

Add one status, **`shortlist`**, to the existing vocabulary
(`new, watch, outreach, applied, interviewing, accepted, rejected, ignore`).

Triage actions reuse the existing `POST /api/status` endpoint:

| Action | Transition | Notes |
| --- | --- | --- |
| **Yes** | `new → shortlist` | Card leaves the inbox, appears in Shortlist. |
| **No** | `new → ignore` | Committed immediately (durable across reload). |
| **Undo** (after No) | `ignore → new` | Offered for ~6s via a toast; reverts the card. |
| **Remove** (in Shortlist) | `shortlist → ignore` | With the same undo affordance. |

Rationale for committing "No" immediately rather than deferring the write: it
survives a page reload or close, and matches Scout's append-history discipline
(`CLAUDE.md`). The fade-out is purely visual; the authoritative state changes at
tap time and Undo issues the reverse transition.

Ignored jobs remain in the tracker and the **All** tab and are not re-surfaced
by future scans (scan dedup already keys on the stable tracker `id`).

No data migration is required: existing `new` entries populate the Jobs inbox;
no `shortlist` entries exist yet.

### A2. Colour palette

A shared helper assigns each category a stable colour by its **index** in the
`categories()` list:

- Add `categoryColor(categoryId)` (and a `CATEGORY_PALETTE` constant) to a small
  shared module so both `ui/app.js` and any unit-tested lib can use it.
- Palette: ~8 visually distinct, WCAG-AA-legible colours (both the solid chip
  and its text). Index wraps modulo palette length if categories ever exceed it.
- No category ids or labels are hardcoded; the mapping is purely positional over
  whatever `workspace.json` defines.

### A3. Jobs tab (triage inbox)

Replaces the two dynamic category lane tabs/sections with **one static `Jobs`
tab**.

- **Contents:** only entries with `status === 'new'`, respecting the existing
  commute filter, sorted by score descending. A flat list — no sub-headings.
- **Card (Style B):** solid coloured category tag + score badge + company/role +
  meta line; a footer with **✕ No** and **✓ Yes, shortlist**; the card body is
  tap-to-expand.
- **Expanded card:** why Scout flagged it, source / "view original advert"
  link, "show what the source says", company history, and the existing
  ask/fit chat bridges. Yes/No remain pinned while expanded.
- **Nav badge:** the Jobs tab shows a count of remaining new jobs.
- **Empty state:** when the inbox is cleared, show "All caught up — nothing new
  to review" (fall back to the latest-scan card when no scan has run).
- The commute filter bar is retained above the list.

Removed: `setupCategoryUi()` dynamic lane generation, the per-category
`renderCategory()` lane layout, and the `startup`/`established` lane sections in
`ui/index.html`. `categoryOf()` is retained — it still drives the colour tag and
the All-tab category column.

### A4. Shortlist tab (new, static)

Navigation becomes: `Jobs · Shortlist · Pipeline · All · Reports · CV`.

- Lists `status === 'shortlist'` entries with the same colour tags and expandable
  detail.
- Primary actions per card: open, **create tailored CV** (existing `tailor`
  flow), and mark applied (existing transition into Pipeline). A **Remove**
  action returns the job to `ignore` with undo.
- This is the "said yes, not applied yet" staging area between triage and the
  Pipeline.

### A5. Testing

- Unit: `categoryColor()` mapping (stable, wraps, distinct); inbox filtering
  (only `new`); each status transition and the undo reversal.
- Server: `/api/status` accepts and persists `shortlist`.
- Browser/responsive: Jobs inbox renders cards with tags + Yes/No; expand shows
  source; Shortlist tab lists shortlisted entries; empty state; follow existing
  patterns in `ui/app.config.test.mjs`, `ui/responsive.test.mjs`,
  `ui/server.test.mjs`.

---

## Part B — beta19 bug batch (independent workstream)

These are already diagnosed in the GitHub issues; the fixes are captured here by
approach and link. They share little code with Part A and with each other, and
can ship independently.

### B1. #51 — Scan schedules cannot be saved after an unhealthy/stale run
Decouple *editing an existing schedule* from the healthy-supervised-scan gate.
The gate may still guard first enablement of automated scans, but must not
disable updates to a configured job's time/days/model.
- `ui/setup.js` `renderFirstScan()`: stop deriving the schedule action's
  disabled state from latest scan health for already-configured jobs; stop
  showing first-run wording when jobs/reports already exist.
- `ui/server.mjs` `POST /api/schedule`: distinguish create vs update so an
  `install` that updates an existing job is not rejected with `409` on
  unhealthy latest scan.
- Failed saves preserve the draft and stay visibly failed; successful saves
  refresh the `Currently runs` summary from persisted/native state.
- Issue: https://github.com/oliver-hitchings/Scout/issues/51

### B2. #52 — Reports desktop layout collapses; nested Markdown not rendered
- `ui/index.html`: scope the global `nav { display:flex }` rule (or override in
  `.report-list .dates`) so the report-date navigation stays a fixed ~220px
  vertical sidebar with `min-width:0`, instead of expanding to min-content and
  crushing `.report-body`.
- `ui/reportView.js`: render level-three-and-deeper headings (`###`+) instead of
  emitting the raw marker as a paragraph.
- Issue: https://github.com/oliver-hitchings/Scout/issues/52

### B3. #53 — CV creation controls off-screen; unclear start action
- `showTab()`: reset (or preserve per-tab) scroll position so CV opens at a
  meaningful position.
- CV create panel: `min-width:0` on the flexible label and a bounded
  width/`max-width` on the select so **Continue** stays on-screen without
  horizontal overflow.
- Rename actions for outcome clarity, e.g. **Review CV options** and **Start
  tailored CV**; keep the handoff CV-specific and state whether generation is
  waiting/running/complete.
- Issue: https://github.com/oliver-hitchings/Scout/issues/53

### B4. #54 — CV save and PDF render are inseparable; partial failures unclear
- Split into a standalone **Save changes** (persist source only, confirm
  saved/sync-queued) and **Render PDF** (render current saved source without an
  unnecessary rewrite/checkpoint). A combined convenience action may remain, but
  save and render outcomes are reported separately.
- Surface distinct visible states: dirty source, saved source, PDF current/stale,
  render running, render failed. A render failure after a successful save must
  explicitly confirm the source is saved.
- `ui/app.js` `saveCv()` / `renderCvPreview()`, `ui/server.mjs`
  `/api/cv/save` and `/api/cv/render`.
- Issue: https://github.com/oliver-hitchings/Scout/issues/54

### B5. #55 — Tailored CVs for different roles at one company collide
Key tailored artifacts by opportunity/role, not company slug alone.
- Give each tailored artifact an explicit, stable relationship to the selected
  opportunity id; `startCvCreate()`, `buildPrefills()`, render/quality lookup,
  and downloads must all resolve by that identity rather than
  `slugOf(entry.company)`.
- Creating a CV for a second role at the same company must never silently open
  another role's CV; reuse/branch must be an explicit, labelled choice.
- Library labels, evidence, quality, render state, chat, and downloads all
  identify the intended role. Existing company-slug workspaces migrate without
  losing prior artifacts.
- Issue: https://github.com/oliver-hitchings/Scout/issues/55

---

## Implementation phasing

1. **Phase 1 — Jobs + Shortlist rework** (Part A) as its own implementation plan.
2. **Phase 2 — beta19 bug batch** (Part B) as a second batched plan; each bug is
   independently testable and can land in any order.

Both phases branch from `origin/main` (beta19). Part A is the primary design
effort; Part B is largely mechanical against well-specified issues.
