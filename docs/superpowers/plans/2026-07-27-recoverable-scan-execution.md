# Recoverable Scan Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Gate A2+A7, the safe portion of PR #71, and issues #72–#76 as a recoverable, privacy-safe, independently reviewable Scout milestone.

**Architecture:** A versioned append-only JSONL journal is the durable source of truth; atomically replaced manifests and artifacts are rebuildable projections. A cross-process guard, fenced lease, durable queue, stage-aware recovery and shared mutation coordinator make scan, assessment, tracker/report and backup operations safely resumable. The UI reads persisted run/provider state, while the five open-issue workstreams remain isolated modules with deterministic tests.

**Tech Stack:** Node.js ESM, built-in `node:test`, JSON/JSONL workspace persistence, filesystem atomic replacement, child-process provider adapters, vanilla browser JavaScript, Playwright.

## Global Constraints

- Start from merged PR #78 (`985ccdf`) on `agent/recoverable-scan-execution`; do not mix this milestone into PR #78.
- Use TDD for every behavior change and request a specification review followed by a code-quality review for every task.
- The append-only journal is authoritative; manifests and summaries are rebuildable projections.
- Every run, stage, batch and mutation has a stable identity and idempotency key.
- Every append, batch completion and external mutation verifies the current fencing generation immediately before commit.
- Use atomic `mkdir` of `.scout/scan-lease.guard/` for cross-process exclusion; atomic file replacement alone is not compare-and-swap.
- Lease duration is 90 seconds, heartbeat interval 15 seconds, and takeover safety margin 15 seconds; external waits use bounded timeouts and an independent heartbeat.
- Only a genuinely truncated or syntactically incomplete final append may be ignored. Any syntactically complete hash-invalid entry fails closed, including the final entry.
- Tracker/report behavior is idempotent and effectively exactly-once from Scout's perspective; ambiguous crash state fails closed for review.
- Persist only minimal structured assessment references and digests. Never persist CV content, full adverts, full prompts, provider transcripts, credentials, tokens, tracking parameters or unnecessary raw provider content.
- Full run IDs and owner identity are internal diagnostics only; public UI uses shortened IDs and sanitised owner summaries.
- Never silently substitute providers or models.
- Never automatically delete recovery-critical active, queued, partial, failed, unrepaired or recovery-referenced state.
- Port only PR #71's safe backup-divergence behavior; do not cherry-pick its unrelated tab-order change.
- Lease migration is one-way: an active legacy lock blocks until expiry, the
  old Scout process must be stopped before upgrade, fenced generations become
  authoritative after activation, and new Scout refuses downgrade or
  coexistence with an older binary. Do not continuously refresh a legacy
  sentinel across old and new binaries.
- Preserve existing workspace formats additively and keep all 649 baseline tests passing.

---

## File and interface map

- `ui/lib/runJournal.mjs`: canonical event envelopes, hash-chain validation, append and replay.
- `ui/lib/runArtifacts.mjs`: versioned minimal artifacts, digest verification and atomic manifest projection.
- `ui/lib/scanLease.mjs`: guard-directory mutex, fenced lease lifecycle and heartbeat.
- `ui/lib/scanQueue.mjs`: durable request journal, deduplication, expiry, staleness and draining.
- `ui/lib/runRecovery.mjs`: compatibility contracts, candidate selection and manifest rebuilding.
- `ui/lib/assessmentBatches.mjs`: stable batches, per-job validation, repair and retry.
- `ui/lib/mutationCoordinator.mjs`: fenced, idempotent tracker/report/backup mutation protocol.
- `ui/lib/runRetention.mjs`: retention, storage pressure, archival and queue compaction.
- `ui/lib/providerHealth.mjs` and `ui/lib/providerLogin.mjs`: durable provider state and constrained login subprocesses.
- Existing `scanPipeline`, `scanHealth`, `workspaceSync`, server and app modules consume these focused interfaces.

### Task 1: Authoritative run journal

**Files:**
- Create: `ui/lib/runJournal.mjs`
- Create: `ui/lib/runJournal.test.mjs`
- Modify: `ui/lib/workspace.mjs`
- Modify: `ui/lib/workspace.test.mjs`

**Interfaces:**
- Produces: `openRunJournal(root, runId)`, `appendRunEvent(handle, input, lease)`, `validateRunJournal(file)`, and `replayRunJournal(file)`.
- Event input contains `type`, `stageId`, `idempotencyKey`, and a bounded `payload`; validation returns `{ events, lastHash, truncatedTail }` or throws `JournalCorruptionError`.

- [ ] **Step 1: Write failing tests**

Add tests that append two canonical events, reject duplicate/conflicting idempotency keys, tolerate a final `{"schemaVersion":` fragment, and reject a complete final event whose `eventHash` was changed.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/runJournal.test.mjs ui/lib/workspace.test.mjs`
Expected: FAIL because `runJournal.mjs` and run paths do not exist.

- [ ] **Step 3: Implement the journal**

Use stable key ordering, SHA-256 over the envelope excluding `eventHash`, newline-delimited appends opened with exclusive append semantics, and `fsync` before success. Add `.scout/runs/<runId>` paths without changing legacy paths. Reject unsupported schemas, sequence gaps, invalid previous hashes and all syntactically complete invalid entries.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/runJournal.test.mjs ui/lib/workspace.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/runJournal.mjs ui/lib/runJournal.test.mjs ui/lib/workspace.mjs ui/lib/workspace.test.mjs && git commit -m "feat: add authoritative run journal"`

### Task 2: Atomic artifacts and manifest projection

**Files:**
- Create: `ui/lib/runArtifacts.mjs`
- Create: `ui/lib/runArtifacts.test.mjs`
- Modify: `ui/lib/atomicWrite.mjs`
- Modify: `ui/lib/atomicWrite.test.mjs`

**Interfaces:**
- Consumes: `validateRunJournal(file)` and journal hashes from Task 1.
- Produces: `commitRunArtifact(run, descriptor, value)`, `readRunArtifact(ref)`, `projectRunManifest(events)`, `replaceRunManifest(run, manifest)`, and `validateManifestAgreement(run)`.

- [ ] **Step 1: Write failing tests**

Cover temp-write/fsync/replace ordering, digest mismatch, unsupported artifact schema, manifest rebuild after deletion, and rejection when a manifest claims a non-journalled artifact.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/runArtifacts.test.mjs ui/lib/atomicWrite.test.mjs`
Expected: FAIL because artifact projection is absent.

- [ ] **Step 3: Implement minimal versioned storage**

Store bounded JSON artifacts by stable ID, schema and SHA-256 digest. Write the artifact before its journal reference. Project manifest schema, last validated sequence/hash, outcome, compatibility, completed work and receipts solely from events; replace through a same-directory temporary file.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/runJournal.test.mjs ui/lib/runArtifacts.test.mjs ui/lib/atomicWrite.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/runArtifacts.mjs ui/lib/runArtifacts.test.mjs ui/lib/atomicWrite.mjs ui/lib/atomicWrite.test.mjs && git commit -m "feat: add atomic run projections"`

### Task 3: Cross-process fenced lease

**Files:**
- Create: `ui/lib/scanLease.mjs`
- Create: `ui/lib/scanLease.test.mjs`
- Create: `ui/lib/fixtures/lease-contender.mjs`
- Modify: `tools/scan-lock.mjs`
- Modify: `tools/scan-lock.test.mjs`

**Interfaces:**
- Produces: `acquireScanLease(root, owner, operation)`, `renewScanLease(lease)`, `assertCurrentFence(lease)`, `releaseScanLease(lease)`, `startLeaseHeartbeat(lease, options)`, and `LeaseLostError`.
- A lease exposes `{ leaseId, runId, generation, owner, expiresAt }`.

- [ ] **Step 1: Write failing process-race tests**

Launch separate Node processes against one temp workspace and assert one
simultaneous winner, heartbeat defeats takeover, expiry allocates generation
+1, stale generation cannot append, PID reuse is distinguished by
process-start identity, and a dead 30-second guard is quarantined safely. Add
fixtures for an active/unexpired legacy lock, an expired lock with stopped
owner, attempted old/new coexistence and attempted downgrade after fenced
activation.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/scanLease.test.mjs tools/scan-lock.test.mjs`
Expected: FAIL because the fenced lease API is absent.

- [ ] **Step 3: Implement guard and lease**

Use atomic directory creation for every acquire/renew/takeover/release
operation, atomic JSON replacement while holding the guard, monotonic local
renewal scheduling, wall-clock restart validation, 90/15/15 timing defaults,
and a heartbeat independent of provider promises. Implement a one-way legacy
adapter: preserve an active legacy lock until expiry, require its owner process
to be stopped, journal/record the migration decision, then activate the fenced
generation as authoritative. After activation, reject legacy lock creation,
downgrade and old/new coexistence with a clear operator error. Do not create or
continuously refresh a cross-version legacy sentinel.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/scanLease.test.mjs tools/scan-lock.test.mjs`
Expected: PASS with competing-process, migration, downgrade and coexistence
tests.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/scanLease.mjs ui/lib/scanLease.test.mjs ui/lib/fixtures/lease-contender.mjs tools/scan-lock.mjs tools/scan-lock.test.mjs && git commit -m "feat: enforce fenced scan leases"`

### Task 4: Durable overlap queue

**Files:**
- Create: `ui/lib/scanQueue.mjs`
- Create: `ui/lib/scanQueue.test.mjs`
- Modify: `ui/lib/scheduler.mjs`
- Modify: `ui/lib/scheduler.test.mjs`

**Interfaces:**
- Produces: `enqueueScanRequest(root, request)`, `projectScanQueue(root, now)`, `claimNextScanRequest(root, compatibility, lease)`, and `completeScanRequest(root, requestId, outcome, lease)`.
- Requests include stable ID/key, requester type, purpose, compatibility fingerprint, requested time and expiry.

- [ ] **Step 1: Write failing queue tests**

Test manual FIFO and 24-hour expiry, scheduled 12-hour/next-window expiry, equivalent deduplication, newest scheduled supersession, stale profile/config/purpose rejection, successful-window skip and automatic post-lease draining.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/scanQueue.test.mjs ui/lib/scheduler.test.mjs`
Expected: FAIL because queue persistence does not exist.

- [ ] **Step 3: Implement queue journal**

Append every enqueue, dedup, supersession, expiry, stale rejection, claim and terminal event to `.scout/scan-queue.jsonl`; rebuild queue state from events and fence all claims/completions.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/scanQueue.test.mjs ui/lib/scheduler.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/scanQueue.mjs ui/lib/scanQueue.test.mjs ui/lib/scheduler.mjs ui/lib/scheduler.test.mjs && git commit -m "feat: persist overlapping scan requests"`

### Task 5: Stage-aware recovery

**Files:**
- Create: `ui/lib/runRecovery.mjs`
- Create: `ui/lib/runRecovery.test.mjs`
- Modify: `ui/lib/pipeline.mjs`
- Modify: `ui/lib/pipeline.test.mjs`

**Interfaces:**
- Consumes: journal replay, manifest projection and fenced lease.
- Produces: `compatibilityFingerprint(input)`, `selectRecoverableRun(candidates, request)`, `recoverRun(root, runId, lease)`, and `RecoveryCompatibilityDecision`.

- [ ] **Step 1: Write failing recovery tests**

Cover newest compatible rather than newest incomplete selection, recorded skip reasons, reuse of collection/ranking across provider changes, explicit assessment substitution provenance, immutable incompatible partial/abandoned runs, damaged-journal fail-closed behavior, and manifest rebuild.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/runRecovery.test.mjs ui/lib/pipeline.test.mjs`
Expected: FAIL because recovery selection is absent.

- [ ] **Step 3: Implement compatibility decisions**

Compare scan mode, purpose, published profile, source/config, schemas and pipeline per stage; additionally compare prompt/provider/model for assessment and target revision for mutations. Journal decisions without rewriting historical outcomes.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/runRecovery.test.mjs ui/lib/pipeline.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/runRecovery.mjs ui/lib/runRecovery.test.mjs ui/lib/pipeline.mjs ui/lib/pipeline.test.mjs && git commit -m "feat: recover compatible scan stages"`

### Task 6: Persistent scan pipeline integration

**Files:**
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`
- Modify: `tools/scout.mjs`
- Modify: `tools/scout.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `runScanPipeline(options)` returning `{ runId, outcome, manifest, failures }`; each pipeline stage receives `{ run, lease, priorArtifact }`.

- [ ] **Step 1: Write failing interruption tests**

Inject process-equivalent stops after collection, normalisation, deduplication, filtering, ranking and selection; assert recovery reuses committed artifacts, stale workers cannot commit, and queued overlaps drain after terminal lease release.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/scanPipeline.test.mjs tools/scout.test.mjs`
Expected: FAIL because scan execution is not journal-driven.

- [ ] **Step 3: Integrate durable stages**

Allocate a run before collection, persist each deterministic stage artifact before its completion event, thread the fence through all commits, stop all commits on lease loss, and release with a terminal journal event.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/scanPipeline.test.mjs tools/scout.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/scanPipeline.mjs ui/lib/scanPipeline.test.mjs tools/scout.mjs tools/scout.test.mjs && git commit -m "feat: persist scan pipeline progress"`

### Task 7: Resilient assessment batches

**Files:**
- Create: `ui/lib/assessmentBatches.mjs`
- Create: `ui/lib/assessmentBatches.test.mjs`
- Modify: `ui/lib/structuredTurn.mjs`
- Modify: `ui/lib/structuredTurn.test.mjs`
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`

**Interfaces:**
- Produces: `planAssessmentBatches(input)`, `executeAssessmentBatch(batch, context)`, and `resumeAssessments(run, context)`.
- Minimal request artifacts contain job IDs, input digests, bounded parameters and version/provenance fields only.

- [ ] **Step 1: Write failing batch tests**

Assert maximum ten jobs, deterministic context-based reduction, completed batch non-repetition, sibling partial success, one focused invalid-job repair, one clean per-job retry, exhausted failure persistence, bounded provider timeout and explicit provider substitution.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/assessmentBatches.test.mjs ui/lib/structuredTurn.test.mjs ui/lib/scanPipeline.test.mjs`
Expected: FAIL because stable batching and repair do not exist.

- [ ] **Step 3: Implement batching and privacy boundary**

Validate each returned job separately and commit it under a stable key. Keep heartbeat active across the bounded provider call. Reject request artifacts containing keys such as `cv`, `advertBody`, `prompt`, `transcript`, `rawResponse` or credentials.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/assessmentBatches.test.mjs ui/lib/structuredTurn.test.mjs ui/lib/scanPipeline.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/assessmentBatches.mjs ui/lib/assessmentBatches.test.mjs ui/lib/structuredTurn.mjs ui/lib/structuredTurn.test.mjs ui/lib/scanPipeline.mjs ui/lib/scanPipeline.test.mjs && git commit -m "feat: make assessment batches recoverable"`

### Task 8: Idempotent tracker and report mutations

**Files:**
- Create: `ui/lib/mutationCoordinator.mjs`
- Create: `ui/lib/mutationCoordinator.test.mjs`
- Modify: `ui/lib/trackerPersistence.mjs`
- Modify: `ui/lib/trackerPersistence.test.mjs`
- Modify: `ui/reportView.js`
- Modify: `ui/reportView.test.mjs`

**Interfaces:**
- Produces: `prepareMutation(run, target, content)`, `applyPreparedMutation(plan, lease)`, and `reconcileMutation(plan)`.
- A plan contains stable mutation ID/key, target revision, intended digest and embedded receipt marker.

- [ ] **Step 1: Write failing crash-window tests**

Inject failure before replacement, after replacement and before receipt; assert matching embedded identity reconciles without replay, conflicting/unverifiable targets fail closed, stale fences cannot mutate, and partial assessment success creates one deterministic tracker/report plan.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/mutationCoordinator.test.mjs ui/lib/trackerPersistence.test.mjs ui/reportView.test.mjs`
Expected: FAIL because coordinated mutation receipts do not exist.

- [ ] **Step 3: Implement prepare/apply/verify**

Persist intent, acquire the shared coordinator, revalidate fence and target revision, atomically replace content carrying the mutation marker, verify digest, then append the receipt.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/mutationCoordinator.test.mjs ui/lib/trackerPersistence.test.mjs ui/reportView.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/mutationCoordinator.mjs ui/lib/mutationCoordinator.test.mjs ui/lib/trackerPersistence.mjs ui/lib/trackerPersistence.test.mjs ui/reportView.js ui/reportView.test.mjs && git commit -m "feat: coordinate durable scan mutations"`

### Task 9: Run health API and privacy-safe UI

**Files:**
- Modify: `ui/lib/scanHealth.mjs`
- Modify: `ui/lib/scanHealth.test.mjs`
- Modify: `ui/server.mjs`
- Modify: `ui/server.test.mjs`
- Modify: `ui/app.js`
- Modify: `ui/app.config.test.mjs`
- Modify: `tests/browser/scan-results.spec.mjs`

**Interfaces:**
- Consumes: projected manifests, queue and provider-independent run state.
- Produces: `/api/scan/runs`, `/api/scan/queue`, and public `runSummary` values with shortened ID and sanitised owner.

- [ ] **Step 1: Write failing state/privacy tests**

Exercise waiting, queued, every pipeline phase, batch progress, repair, recovery, partial, abandoned, failed and complete. Assert API/UI omit full IDs, host, PID, paths, prompts, adverts, tracking data and provider output.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/scanHealth.test.mjs ui/server.test.mjs ui/app.config.test.mjs`
Expected: FAIL because persisted run summaries are not exposed.

- [ ] **Step 3: Implement projections and rendering**

Make browser state derive from journal-backed summaries, show terminal reason and recovery count, and keep full diagnostic fields behind the existing local diagnostic boundary only.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/scanHealth.test.mjs ui/server.test.mjs ui/app.config.test.mjs && npx playwright test tests/browser/scan-results.spec.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/scanHealth.mjs ui/lib/scanHealth.test.mjs ui/server.mjs ui/server.test.mjs ui/app.js ui/app.config.test.mjs tests/browser/scan-results.spec.mjs && git commit -m "feat: show auditable scan recovery state"`

### Task 10: Retention, storage pressure and safe archival

**Files:**
- Create: `ui/lib/runRetention.mjs`
- Create: `ui/lib/runRetention.test.mjs`
- Modify: `ui/lib/recoveryBackup.mjs`
- Modify: `ui/lib/recoveryBackup.test.mjs`
- Modify: `ui/lib/scanHealth.mjs`
- Modify: `ui/lib/scanHealth.test.mjs`

**Interfaces:**
- Produces: `measureRunStorage(root)`, `planRunCleanup(root, policy)`, `archiveSelectedRuns(plan, lease)`, and `compactScanQueue(root, lease)`.

- [ ] **Step 1: Write failing retention tests**

Keep newest 20 and previous 30 days, summaries for one year, and every recovery-critical record. Test warning thresholds, refusal to start when journalling is unsafe, encrypted reviewed archive before deletion, live queue preservation and idempotent compaction.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/runRetention.test.mjs ui/lib/recoveryBackup.test.mjs ui/lib/scanHealth.test.mjs`
Expected: FAIL because storage-pressure policy is absent.

- [ ] **Step 3: Implement fenced cleanup**

Calculate separate run/artifact/queue totals, expose warnings, require an explicit selected cleanup plan, atomically verify encrypted archive and compact index, and remove only eligible selected data after the fence is rechecked.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/runRetention.test.mjs ui/lib/recoveryBackup.test.mjs ui/lib/scanHealth.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/runRetention.mjs ui/lib/runRetention.test.mjs ui/lib/recoveryBackup.mjs ui/lib/recoveryBackup.test.mjs ui/lib/scanHealth.mjs ui/lib/scanHealth.test.mjs && git commit -m "feat: bound recoverable run storage"`

### Task 11: Safe backup-divergence resolution from PR #71

**Files:**
- Modify: `ui/lib/workspaceSync.mjs`
- Modify: `ui/lib/workspaceSync.test.mjs`
- Modify: `ui/server.mjs`
- Modify: `ui/server.test.mjs`
- Modify: `ui/setup.js`
- Modify: `ui/setup.test.mjs`
- Modify: `tests/browser/settings.spec.mjs`

**Interfaces:**
- Consumes: `prepareMutation`/shared coordinator and current fenced lease.
- Produces: `analyseBackupDivergence(root)`, `resolveBackupDivergence(root, analysisToken, lease)`, and confirmation API endpoints.

- [ ] **Step 1: Port tests, not commits, from PR #71**

Recreate coverage for disjoint additions/modifications, overlap, rename, deletion, dirty tracked/untracked paths, stale analysis token, recovery refs, merge failure and push-pending behavior. Add a race proving backup resolution cannot overlap tracker/report mutation.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/workspaceSync.test.mjs ui/server.test.mjs ui/setup.test.mjs`
Expected: FAIL because divergence remains manual-only.

- [ ] **Step 3: Port only safe behavior**

Fetch/revalidate tips, bind a confirmation token to branch/tips, create both recovery refs, perform normal `--no-ff` merge, never reset/rebase/force-push, sanitise public affected areas, and share mutation fencing. Do not port PR #71's tab-order commit.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/workspaceSync.test.mjs ui/server.test.mjs ui/setup.test.mjs && npx playwright test tests/browser/settings.spec.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/workspaceSync.mjs ui/lib/workspaceSync.test.mjs ui/server.mjs ui/server.test.mjs ui/setup.js ui/setup.test.mjs tests/browser/settings.spec.mjs && git commit -m "feat: safely resolve disjoint backup divergence"`

### Task 12: Fix character pacing and alignment (#72)

**Files:**
- Modify: `ui/lib/scoutCharacter.mjs`
- Modify: `ui/lib/scoutCharacter.test.mjs`
- Modify: `ui/app.js`
- Modify: `ui/app.config.test.mjs`
- Modify: `ui/index.html`
- Create: `tests/browser/scout-character.spec.mjs`

**Interfaces:**
- Produces: canonical `SCOUT_STATES`, `applyScoutState`, exact sprite-cell positioning and optional per-frame/common anchors.

- [ ] **Step 1: Write failing runtime/browser tests**

Assert each state uses its configured FPS/frame count, idle/listening/sleeping remain slower than action states, reduced motion is static, cell coordinates are integral, and representative frames stay centred at 44px and 112px.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/scoutCharacter.test.mjs ui/app.config.test.mjs && npx playwright test tests/browser/scout-character.spec.mjs`
Expected: FAIL because `app.js` still imposes global animation assumptions.

- [ ] **Step 3: Make the library authoritative**

Remove duplicate runtime timing, set exact background cell geometry, consume state duration/iteration/alignment variables, and encode the smallest anchor table needed by the image comparisons.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/scoutCharacter.test.mjs ui/app.config.test.mjs && npx playwright test tests/browser/scout-character.spec.mjs --project=chromium`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/scoutCharacter.mjs ui/lib/scoutCharacter.test.mjs ui/app.js ui/app.config.test.mjs ui/index.html tests/browser/scout-character.spec.mjs && git commit -m "fix: stabilise Scout character animation"`

### Task 13: Trustworthy provider model choices (#73)

**Files:**
- Modify: `ui/lib/providerModels.mjs`
- Modify: `ui/lib/providerModels.test.mjs`
- Modify: `ui/lib/providers.mjs`
- Modify: `ui/lib/providers.test.mjs`
- Modify: `ui/lib/chatService.mjs`
- Modify: `ui/lib/chatService.test.mjs`
- Modify: `ui/app.js`
- Modify: `tests/browser/chat-engine.spec.mjs`

**Interfaces:**
- Produces: `providerModelCatalogue(provider, status)`, `effectiveProviderModel(provider, config, catalogue)`, and model records `{ id, label, tradeoff, source, available, selected }`.

- [ ] **Step 1: Write failing catalogue tests**

Cover fresh Codex catalogue, configured effective default, `codex debug models` unsupported fallback, stale saved model, provider rejection, custom safe ID, labels/trade-offs and absence of ambiguous log inference.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/providerModels.test.mjs ui/lib/providers.test.mjs ui/lib/chatService.test.mjs`
Expected: FAIL because Codex currently returns no catalogue.

- [ ] **Step 3: Implement bounded catalogue discovery**

Parse bounded JSON from fixed `codex debug models`, distinguish refreshed versus bundled/fallback sources, merge only verified configured/custom values, expose the effective model when resolvable, and visibly invalidate stale/rejected choices.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/providerModels.test.mjs ui/lib/providers.test.mjs ui/lib/chatService.test.mjs && npx playwright test tests/browser/chat-engine.spec.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/providerModels.mjs ui/lib/providerModels.test.mjs ui/lib/providers.mjs ui/lib/providers.test.mjs ui/lib/chatService.mjs ui/lib/chatService.test.mjs ui/app.js tests/browser/chat-engine.spec.mjs && git commit -m "fix: expose trustworthy provider models"`

### Task 14: Eliminate usage-summary render races (#74)

**Files:**
- Create: `ui/lib/chatDrawerState.mjs`
- Create: `ui/lib/chatDrawerState.test.mjs`
- Modify: `ui/app.js`
- Modify: `ui/app.config.test.mjs`
- Modify: `tests/browser/chat-engine.spec.mjs`

**Interfaces:**
- Produces: `createChatDrawerState(chatId)`, `reduceChatDrawer(state, event)`, and request-generation checks for engine and usage responses.

- [ ] **Step 1: Write failing deterministic race tests**

Resolve usage then engines, engines then usage, and both after switching chats. Assert both regions persist for the active chat and old-chat responses are ignored. Cover unavailable, estimate, context-window and model-spend labels.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/chatDrawerState.test.mjs ui/app.config.test.mjs`
Expected: FAIL because independent rerenders delete state.

- [ ] **Step 3: Implement one drawer state model**

Have `loadEngineOptions` and `refreshUsage` dispatch generation-tagged events and render one stable snapshot with persistent engine and usage containers.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/chatDrawerState.test.mjs ui/app.config.test.mjs && npx playwright test tests/browser/chat-engine.spec.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/chatDrawerState.mjs ui/lib/chatDrawerState.test.mjs ui/app.js ui/app.config.test.mjs tests/browser/chat-engine.spec.mjs && git commit -m "fix: preserve chat usage across async renders"`

### Task 15: Detect Codex deep links and provide fallback (#75)

**Files:**
- Create: `ui/lib/codexDeepLink.mjs`
- Create: `ui/lib/codexDeepLink.test.mjs`
- Modify: `ui/server.mjs`
- Modify: `ui/server.test.mjs`
- Modify: `ui/app.js`
- Modify: `ui/app.config.test.mjs`
- Modify: `tests/browser/chat-engine.spec.mjs`

**Interfaces:**
- Produces: `codexDeepLinkCapability(device)`, `openCodexTask(task, capability)`, and `/api/device/codex-deep-link`.

- [ ] **Step 1: Write failing capability/fallback tests**

Cover supported handler, missing handler, bounded launch failure, remote browser, copyable exact technical task ID and resume instructions. Assert an anchor click alone never records success.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/codexDeepLink.test.mjs ui/server.test.mjs ui/app.config.test.mjs`
Expected: FAIL because only a raw `codex://threads/` anchor exists.

- [ ] **Step 3: Implement device-local behavior**

Keep the documented canonical URI, detect registered protocol support through a fixed platform adapter, return capability without paths, attempt with bounded acknowledgement where possible, and render a copy/resume fallback plus remote-device explanation.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/codexDeepLink.test.mjs ui/server.test.mjs ui/app.config.test.mjs && npx playwright test tests/browser/chat-engine.spec.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/codexDeepLink.mjs ui/lib/codexDeepLink.test.mjs ui/server.mjs ui/server.test.mjs ui/app.js ui/app.config.test.mjs tests/browser/chat-engine.spec.mjs && git commit -m "fix: fall back when Codex links cannot open"`

### Task 16: Durable provider health (#76)

**Files:**
- Create: `ui/lib/providerHealth.mjs`
- Create: `ui/lib/providerHealth.test.mjs`
- Modify: `ui/lib/providers.mjs`
- Modify: `ui/lib/providers.test.mjs`
- Modify: `ui/lib/scheduler.mjs`
- Modify: `ui/lib/scheduler.test.mjs`
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`

**Interfaces:**
- Produces: `classifyProviderHealth(signal)`, `recordProviderHealth(root, provider, signal)`, `providerPreflight(root, provider, purpose)`, and the nine-state enum in the design.

- [ ] **Step 1: Write failing state-machine tests**

Cover every state, startup/pre-run/scheduled/periodic/post-auth checks, 401 precedence over local credential presence, deduplicated alerts, blocked scan record, unrelated-provider continuation, explicit retry and no automatic missed-scan resend.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/providerHealth.test.mjs ui/lib/providers.test.mjs ui/lib/scheduler.test.mjs ui/lib/scanPipeline.test.mjs`
Expected: FAIL because provider readiness is a shallow boolean.

- [ ] **Step 3: Implement durable health evidence**

Persist bounded redacted transitions and evidence source, keep remote authentication failures authoritative until a real remote success, gate only the affected provider, and connect scheduled blocks to durable queue/run evidence.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/providerHealth.test.mjs ui/lib/providers.test.mjs ui/lib/scheduler.test.mjs ui/lib/scanPipeline.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/providerHealth.mjs ui/lib/providerHealth.test.mjs ui/lib/providers.mjs ui/lib/providers.test.mjs ui/lib/scheduler.mjs ui/lib/scheduler.test.mjs ui/lib/scanPipeline.mjs ui/lib/scanPipeline.test.mjs && git commit -m "feat: persist provider health"`

### Task 17: Secure guided provider login (#76)

**Files:**
- Create: `ui/lib/providerLogin.mjs`
- Create: `ui/lib/providerLogin.test.mjs`
- Modify: `ui/server.mjs`
- Modify: `ui/server.test.mjs`
- Modify: `ui/setup.js`
- Modify: `ui/setup.test.mjs`
- Modify: `tests/browser/settings.spec.mjs`

**Interfaces:**
- Produces: `startProviderLogin(provider, ownerContext)`, `submitProviderLoginCode(sessionId, code, ownerContext)`, `cancelProviderLogin(sessionId, ownerContext)`, and fixed owner-only API routes.

- [ ] **Step 1: Write failing security and flow tests**

Cover Codex `login --device-auth` plus `login status`, fixed Claude authentication arguments/manual input, explicit credential clearing, CSRF/origin/owner checks, command allow-list, output/input/time limits, redaction, rate limit, cancel, retry and zero secret persistence.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test ui/lib/providerLogin.test.mjs ui/server.test.mjs ui/setup.test.mjs`
Expected: FAIL because guided login endpoints do not exist.

- [ ] **Step 3: Implement constrained subprocess state machine**

Allow only provider-specific executable and fixed arguments, expose only sanitised URL/code/status fields, accept bounded code input only for the active owner session, never pass arbitrary stdin, and feed terminal results back into provider health.

- [ ] **Step 4: Verify**

Run: `node --test ui/lib/providerLogin.test.mjs ui/server.test.mjs ui/setup.test.mjs && npx playwright test tests/browser/settings.spec.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add ui/lib/providerLogin.mjs ui/lib/providerLogin.test.mjs ui/server.mjs ui/server.test.mjs ui/setup.js ui/setup.test.mjs tests/browser/settings.spec.mjs && git commit -m "feat: guide secure provider reauthentication"`

### Task 18: End-to-end acceptance, documentation and issue evidence

**Files:**
- Create: `tests/browser/recoverable-scan.spec.mjs`
- Modify: `tools/release-audit.mjs`
- Modify: `tools/release-audit.test.mjs`
- Modify: `tools/build-release.test.mjs`
- Modify: `docs/TROUBLESHOOTING.md`
- Modify: `docs/VPS_BACKUP_AND_STATE.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: all prior task interfaces.
- Produces: release evidence for epic #77, PR #71 and issues #72–#76.

- [ ] **Step 1: Write failing end-to-end and audit tests**

Exercise recovery during every phase, machine restart, lease races, completed-batch reuse, partial/repaired/failed outcomes, queued overlap, storage pressure, backup mutation race and all public privacy exclusions. Make release audit inspect packaged files for forbidden raw run/auth content.

- [ ] **Step 2: Prove the new acceptance tests fail**

Run: `node --test tools/release-audit.test.mjs tools/build-release.test.mjs && npx playwright test tests/browser/recoverable-scan.spec.mjs`
Expected: FAIL until the acceptance fixture and documentation contract are complete.

- [ ] **Step 3: Complete docs and fixtures**

Document recovery selection, queue expiry, storage warnings/reviewed cleanup, provider health/login, deep-link fallback and backup divergence. Add no new default occupation, location, profile or provider preference.

- [ ] **Step 4: Run full verification**

Run: `npm test`
Expected: 0 failures; only the two pre-existing documented skips.

Run: `npm run test:browser`
Expected: all Chromium and Firefox projects pass.

Run: `npm run release:audit`
Expected: PASS with no secret, raw assessment or private run-state leakage.

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 5: Review, publish and update GitHub**

Use `superpowers:requesting-code-review`, fix all findings with TDD, then use `superpowers:verification-before-completion` and `superpowers:finishing-a-development-branch`. Open one draft PR from `agent/recoverable-scan-execution`; link #77 and #71–#76, explain that PR #71's tab-order commit was excluded, and update the epic checkboxes only for acceptance evidence actually present. Close PR #71 and issues #72–#76 only after the new PR merges.

- [ ] **Step 6: Commit**

Run: `git add tests/browser/recoverable-scan.spec.mjs tools/release-audit.mjs tools/release-audit.test.mjs tools/build-release.test.mjs docs/TROUBLESHOOTING.md docs/VPS_BACKUP_AND_STATE.md README.md && git commit -m "test: verify recoverable Scout milestone"`
