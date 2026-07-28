# Task 8 Round 2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make marker-free Git backups lossless without index flags and replace opaque prepared target bodies with deterministic structured mutation recipes.

**Architecture:** Git will use a repository-local clean filter for the three mutation target classes, so ordinary staging and status comparisons see marker-free canonical bytes while live files retain recovery markers; no `assume-unchanged`, `skip-worktree`, or temporary index is needed. Mutation artifacts will store closed-schema recipes: tracker merge operations over the authoritative target revision, a structured scan-report model, and one allowlisted run-log record. Recovery reconstructs exact marker-bearing target bytes from the verified current revision plus the durable recipe.

**Tech Stack:** Node.js ESM, `node:test`, synchronous filesystem primitives at the mutation boundary, Git clean filters, existing scan journal/lease/coordinator APIs.

## Global Constraints

- Use strict TDD: observe every new regression test fail for the intended reason before production edits.
- Preserve findings 1, 4, and 5.
- Run focused and affected tests only; do not run the full npm suite.
- Append exact round-2 RED/GREEN evidence to `.superpowers/sdd/2026-07-27-recoverable-scan-execution/task-8-report.md`.
- Finish with one commit and a clean tracked worktree.

---

### Task 1: Marker-free Git clean projection without hidden index state

**Files:**
- Create: `tools/scout-marker-clean.mjs`
- Modify: `ui/lib/workspaceSync.mjs`
- Modify: `ui/lib/workspaceSync.test.mjs`
- Test: `ui/lib/workspaceSync.test.mjs`

**Interfaces:**
- Consumes: marker-bearing tracker JSON, scan-run JSONL, and dated Markdown on stdin plus the Git `%f` path argument.
- Produces: canonical marker-free bytes on stdout; `runWorkspaceSync()` installs the repository-local filter before ordinary staging.

- [ ] **Step 1: Write the failing real integration test**

Import `mutateTrackerSnapshot` and `serializeTracker`. After the first marker-free backup, mutate the real tracker through `mutateTrackerSnapshot()`, run the next queued backup, clone `HEAD`, and assert that the semantic edit exists locally and in the clone, no marker is committed, `git status --porcelain` is empty, and `git ls-files -v` contains no lowercase assume-unchanged entries.

- [ ] **Step 2: Run the focused test and verify RED**

Run:
`node --test --test-name-pattern "marker-free backup survives a real tracker mutation" ui/lib/workspaceSync.test.mjs`

Expected: the second backup omits the semantic edit because the current code never clears the hidden flag after `mutateTrackerSnapshot()` removes the marker.

- [ ] **Step 3: Add interruption cleanup coverage**

Add a test whose Git commit adapter fails after staging. Assert no assume-unchanged/skip-worktree entry exists and no temporary projection/index file remains. The staged semantic change may remain visible; it must never be silently clean.

- [ ] **Step 4: Implement the minimal clean-filter boundary**

Implement `tools/scout-marker-clean.mjs` as a bounded stdin transform using `markerFreeMutationContent()` for exactly:

- `data/opportunities.json` → `tracker`
- `data/scan-runs.jsonl` → `run-log`
- `reports/YYYY-MM-DD.md` → `report`

In `workspaceSync.mjs`, install local filter config and `.git/info/attributes`, remove all projection blob/index-flag helpers, and let normal `git add`/`git commit` stage canonical bytes.

- [ ] **Step 5: Run Task 1 tests and verify GREEN**

Run:
`node --test --test-name-pattern "marker-free backup|projection cleanup" ui/lib/workspaceSync.test.mjs`

Expected: all selected tests pass with no hidden index flags and no temporary state.

### Task 2: Structured deterministic mutation recipes

**Files:**
- Create: `ui/lib/scanMutationProjection.mjs`
- Create: `ui/lib/scanMutationProjection.test.mjs`
- Modify: `ui/lib/mutationCoordinator.mjs`
- Modify: `ui/lib/mutationCoordinator.test.mjs`
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`
- Test: `ui/lib/scanMutationProjection.test.mjs`
- Test: `ui/lib/mutationCoordinator.test.mjs`
- Test: `ui/lib/scanPipeline.test.mjs`

**Interfaces:**
- Consumes: authoritative current tracker/run-log bytes and scan-owned structured output.
- Produces:
  - `trackerMergeRecipe(current, desired)` with `updated` plus bounded scan-owned opportunity upserts, excluding user notes/contact/log/application bodies and provider prose.
  - `scanReportRecipe(model)` containing only fixed status codes, counts, canonical URLs, bounded company/role/source identifiers, and reason/error codes.
  - `runLogAppendRecipe(record)` containing the allowlisted semantic run record with reason/error codes.
  - `renderMutationRecipe(kind, currentContent, recipe)` reconstructing exact unmarked target bytes.

- [ ] **Step 1: Write realistic privacy RED tests**

Drive the real `coordinateScanArtifacts()` builder with:

- an existing tracker note `Led the Acme migration from 2020 to 2024`;
- an advert paragraph beginning `About the role, you will own...`;
- a prompt paragraph `Compare every requirement against the candidate...`;
- a provider response paragraph `The candidate demonstrates...`.

Inspect the durable prepared JSON and assert none of those bodies appears. Also assert the plan retains normal bounded company/role semantics, stable failure codes, and enough structured data to recover.

- [ ] **Step 2: Run the privacy tests and verify RED**

Run:
`node --test --test-name-pattern "real prepared recipe excludes unlabelled private bodies" ui/lib/mutationCoordinator.test.mjs`

Expected: the current `content` fields expose the existing note and injected opaque source/error text.

- [ ] **Step 3: Write reconstruction RED tests**

Prepare a three-target recipe, fail before target 2 and target 3, reload the plan from disk, and apply it under the same valid fence. Assert exact tracker semantics, report headings/counts, historical run preservation, final digests, and one receipt.

- [ ] **Step 4: Implement closed-schema recipes and reconstruction**

Replace prepared `content` with one validated `recipe` per target. During preparation, reconstruct unmarked bytes from the current revision to derive `intendedDigest`, embed the marker only in memory to derive `writtenDigest`, and persist neither body. During apply, re-read and revision-check the target, reconstruct from the recipe, embed the durable marker, verify the precomputed digest, and atomically replace.

Build report text only from the structured report recipe. Replace assessment/provider prose in tracker/run/report projections with fixed bounded codes; retain canonical company/role/source semantic fields and user-owned tracker fields only in the authoritative target, never in the recipe.

- [ ] **Step 5: Make diagnostics code-only**

Change `safeDiagnostic()` to map known codes and conditions to a closed set such as `source-unavailable`, `source-timeout`, `provider-failed`, `assessment-retries-exhausted`, and `redacted-diagnostic`. Unknown input always becomes `redacted-diagnostic`; it is never returned verbatim.

- [ ] **Step 6: Run Task 2 tests and verify GREEN**

Run:
`node --test ui/lib/scanMutationProjection.test.mjs ui/lib/mutationCoordinator.test.mjs`

Then run:
`node --test --test-name-pattern "builder sanitises|partial assessment|runtime finalisation preserves" ui/lib/scanPipeline.test.mjs tools/scout.test.mjs`

Expected: all selected tests pass.

### Task 3: Affected verification, report, and commit

**Files:**
- Modify: `.superpowers/sdd/2026-07-27-recoverable-scan-execution/task-8-report.md` (ignored evidence file)
- Verify: every production/test file changed by Tasks 1–2

**Interfaces:**
- Consumes: completed Task 1 and Task 2 changes.
- Produces: exact evidence, one reviewable commit, clean tracked worktree.

- [ ] **Step 1: Run affected test files**

Run only the directly affected suites:

`node --test ui/lib/runJournal.test.mjs ui/lib/runArtifacts.test.mjs ui/lib/scanMutationProjection.test.mjs ui/lib/mutationCoordinator.test.mjs`

`node --test ui/lib/scanPipeline.test.mjs`

`node --test tools/scout.test.mjs`

`node --test ui/lib/workspaceSync.test.mjs`

- [ ] **Step 2: Run syntax and diff checks**

Run `node --check` for each changed production module and `git diff --check`.

- [ ] **Step 3: Append exact round-2 evidence**

Record each exact RED and GREEN command, observed pass/fail counts, affected-suite totals, syntax results, and the fact that no full npm suite ran.

- [ ] **Step 4: Commit**

Stage only Task 8 round-2 tracked files and commit with:

`fix: make scan recovery projections lossless`

- [ ] **Step 5: Verify clean handoff**

Run `git status --short` and `git log -1 --oneline`. Report status, commit, tests, and concerns only.
