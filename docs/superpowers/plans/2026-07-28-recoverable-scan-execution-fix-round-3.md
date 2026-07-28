# Recoverable Scan Execution Fix Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Task 6 with bounded asynchronous fenced backup, durable pending/partial queue outcomes, credential-safe exact semantic facts, and separate transient URL execution values.

**Architecture:** Convert only the runtime workspace-sync path to bounded asynchronous commands and expose a narrow fence callback. Extend existing pipeline and queue contracts additively, while keeping fresh executed stage values separate from their sanitized durable projections.

**Tech Stack:** Node.js ESM, `node:test`, child-process promises, append-only JSONL journals, fenced scan leases, SHA-256 artifacts.

## Global Constraints

- Task 8's full mutation coordinator and crash-idempotent tracker/report
  receipts remain out of scope.
- Existing queue and artifact journal versions remain replayable.
- Durable artifacts contain no raw advert, requirement sentence, credential,
  user-info, fragment, or query string.
- Every production change follows an observed RED then GREEN test cycle.
- `succeeded-pending` and `succeeded-partial` remain logically successful for
  scheduled-window coverage but visibly distinct from `succeeded`.

---

### Task 1: Exact post-success and queue outcomes

**Files:**
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`
- Modify: `ui/lib/scanQueue.mjs`
- Modify: `ui/lib/scanQueue.test.mjs`
- Modify: `tools/scout.mjs`
- Modify: `tools/scout.test.mjs`

**Interfaces:**
- Produces: `postTerminalSuccess(...) -> { status, reason? }`.
- Produces: queue outcomes `succeeded-pending` and `succeeded-partial`.

- [x] **Step 1: Write failing receipt and hook-result tests**

Add pipeline tests whose malformed receipt envelope completes with
`mutation-receipt-invalid`, whose `{status:"pending"}` hook result produces
`backup-pending`, and whose `{status:"partial"}` result produces
`backup-partial`.

- [x] **Step 2: Run the named pipeline tests and observe RED**

Run:
`node --test --test-name-pattern="malformed receipt|explicit pending|explicit partial" ui/lib/scanPipeline.test.mjs`

Expected: malformed receipt fails the run and hook return values are ignored.

- [x] **Step 3: Implement exact outcome parsing**

Change `finalizationOutcome` to return a bounded receipt issue instead of
throwing. Validate the post-success result against:

```js
{ status: 'complete' }
{ status: 'pending', reason: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ }
{ status: 'partial', reason: /^[a-z0-9]+(?:-[a-z0-9]+)*$/ }
```

Map the latter two to bounded pipeline failures without changing terminal
`complete`.

- [x] **Step 4: Write failing durable queue propagation tests**

Add queue replay/coverage tests for both new outcomes and a real queued Scout
test whose backup returns `offline` or `needs-attention`.

- [x] **Step 5: Run queue/Scout tests and observe RED**

Run:
`node --test --test-name-pattern="succeeded-pending|succeeded-partial|queued backup" ui/lib/scanQueue.test.mjs tools/scout.test.mjs`

Expected: queue validation rejects the new outcomes and production collapses
the queued run to `succeeded`.

- [x] **Step 6: Implement additive queue outcomes and Scout mapping**

Allow both new outcomes in queue v4 replay/completion, preserve them through
`drainScanQueue`, and count all three successful outcomes in completed-window
coverage. Map real sync statuses to exact post-success results and map queued
pipeline failures to the durable queue outcome.

- [x] **Step 7: Run all Task 1 tests to GREEN**

Run the named pipeline, queue, and Scout tests and confirm no raw backup error
text enters the result or queue journal.

### Task 2: Bounded asynchronous fenced workspace sync

**Files:**
- Modify: `ui/lib/workspaceSync.mjs`
- Modify: `ui/lib/workspaceSync.test.mjs`
- Modify: `tools/scout.mjs`
- Modify: `tools/scout.test.mjs`

**Interfaces:**
- Produces: `runWorkspaceSync(root, reason, { assertFence, commandTimeoutMs, spawnAsync? })`.
- `assertFence()` throws when the scan lease is stale.

- [x] **Step 1: Write failing async/timeout/fence tests**

Add tests proving a deferred runtime command does not block a timer, a command
exceeding the configured deadline returns bounded pending state, and fence
loss after a read prevents the next `git add`, recovery write, commit, merge,
or push from starting.

- [x] **Step 2: Run workspace-sync tests and observe RED**

Run:
`node --test --test-name-pattern="runtime sync remains asynchronous|runtime sync command timeout|stale sync fence" ui/lib/workspaceSync.test.mjs`

Expected: timers cannot advance around `spawnSync`, no deadline exists, and no
fence callback is consumed.

- [x] **Step 3: Implement bounded asynchronous command execution**

Use `child_process.spawn` with bounded stdout/stderr buffers, a 30-second
default timer, and forced child termination on timeout. Preserve the existing
synchronous injection adapter only for tests and non-runtime setup paths.

- [x] **Step 4: Implement async runtime mutation helpers**

Create async runtime equivalents for repository checks, legacy untracking,
secret checks, local checkpoint/commit, fetch, merge, restore, and push.
Call `assertFence` immediately before and after every mutating child or
filesystem operation.

- [x] **Step 5: Wire the scan fence into backup**

Pass an assertion closure from `postTerminalSuccess` through
`queueWorkspaceSync` into `runWorkspaceSync`. Assert before the call and after
its result. Keep the pipeline heartbeat active until this completes.

- [x] **Step 6: Run workspace-sync and Scout backup tests to GREEN**

Run:
`node --test ui/lib/workspaceSync.test.mjs --test-name-pattern="runtime sync|stale sync fence|offline sync"`
and the focused Scout backup tests.

### Task 3: Privacy-safe exact semantic clauses

**Files:**
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`

**Interfaces:**
- Produces: bounded ordered `responsibilityFacts[]` and
  `mandatorySignals[].fact`.

- [x] **Step 1: Write adversarial failing semantic tests**

Use requirements containing `password: hunter2`, `Authorization: Bearer
PRIVATE_BEARER`, a JWT-like value, and a credential-bearing URL. Assert no
label payload appears in any stage artifact or assessment candidate. Also
assert `non-technical applicants required` preserves `non-technical`, and
`Accountability for incident response` produces a responsibility fact.

- [x] **Step 2: Run the semantic tests and observe RED**

Run:
`node --test --test-name-pattern="credential-shaped semantic|semantic operators|accountability responsibility" ui/lib/scanPipeline.test.mjs`

Expected: credential values survive, `non` disappears, and accountability
produces no fact.

- [x] **Step 3: Implement ordered clauses and whole-value redaction**

Detect credential assignments, authorization payloads, JWT-like values, and
URL user-info before normalization. Return the fixed
`sensitive requirement redacted` fact for sensitive clauses. Otherwise retain
bounded normalized word order and operators. Select bounded clauses from every
non-empty description without a verb gate.

- [x] **Step 4: Run semantic/privacy tests to GREEN**

Run the new named tests plus all existing artifact privacy and semantic
recovery tests.

### Task 4: Transient URL execution values

**Files:**
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`
- Modify: `tools/scout.test.mjs`

**Interfaces:**
- Fresh stage `execute` output feeds the next stage.
- Encoded/decoded projection alone is committed to artifacts.

- [x] **Step 1: Write failing query-sensitive execution tests**

Use two source jobs with one path and distinct query identities. Assert fresh
normalization/deduplication keeps both and liveness receives the original
query-bearing URLs, while every persisted artifact and scan-input file
contains only origin/path.

- [x] **Step 2: Run the named tests and observe RED**

Run:
`node --test --test-name-pattern="transient query URL" ui/lib/scanPipeline.test.mjs tools/scout.test.mjs`

Expected: live callbacks receive sanitized URLs and query-distinct jobs
collapse.

- [x] **Step 3: Separate executed and durable values**

After each fresh stage, encode/decode only for artifact validation and commit.
Set `priorArtifact` and `stageOutputs` to the original plain executed value.
Recovered stage values continue to come from the sanitized artifact.

- [x] **Step 4: Run transient URL and recovery tests to GREEN**

Run the new tests plus all deterministic-stage recovery and artifact privacy
tests.

### Task 5: Verification and handoff

**Files:**
- Modify: `docs/OPERATIONS.md`
- Modify: `.superpowers/sdd/2026-07-27-recoverable-scan-execution/task-6-report.md`

- [x] **Step 1: Run affected suites**

Run:
`node --test ui/lib/workspaceSync.test.mjs ui/lib/scanPipeline.test.mjs ui/lib/scanQueue.test.mjs ui/lib/vacancyRank.test.mjs ui/lib/vacancyFilter.test.mjs tools/scout.test.mjs`

- [x] **Step 2: Run full and privacy verification**

Run `npm.cmd test`, `npm.cmd run release:audit`, `node --check` for every
changed production module, and `git diff --check`.

- [x] **Step 3: Update operations and ignored Task 6 report**

Record async fenced backup, the two queue outcomes, transient URL behavior,
semantic redaction, exact RED observations, and final pass counts.

- [x] **Step 4: Commit**

Stage only reviewed Task 6 files and commit with:
`fix: finish recoverable scan execution`
