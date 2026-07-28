# Recoverable Scan Execution Fix Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five remaining Task 6 findings with receipt-gated fenced backup, canonical private URLs, assessment-ready semantic artifacts, claim-bound terminal compatibility, and direct scheduled-window coverage.

**Architecture:** Extend the existing fenced pipeline and queue transitions rather than adding a second coordinator. Keep mutation receipts narrow and additive so Task 8 can supply the durable implementation later.

**Tech Stack:** Node.js ESM, `node:test`, append-only JSONL journals, SHA-256 compatibility and artifact digests.

## Global Constraints

- Task 7/8 full assessment and mutation receipt protocols remain out of scope.
- Existing schema replay remains additive.
- No raw advert, requirement sentence, diagnostic, credential, user-info,
  fragment, or query string may enter durable scan artifacts.
- Every production change follows an observed RED then GREEN test cycle.

---

### Task 1: Receipt-gated fenced success backup

**Files:**
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`
- Modify: `tools/scout.mjs`
- Modify: `tools/scout.test.mjs`

**Interfaces:**
- Consumes: finalizer return `{ result, mutationReceipt }` or existing finalizer value.
- Produces: `postTerminalSuccess({ run, lease, manifest, mutationReceipt })` and bounded `backup-pending` durable failures.

- [x] Write failing tests proving no receipt means no backup, a valid receipt
  backs up while the lease is current, queued successes back up independently,
  and backup failure leaves the scan complete with `backup-pending`.
- [x] Run the named tests and confirm the current post-release behavior fails.
- [x] Add exact receipt validation and invoke the hook after complete terminal
  validation but before heartbeat stop/release.
- [x] Move Scout backup dispatch into the hook and remove `runScan`'s
  post-return backup.
- [x] Run the focused tests to GREEN.

### Task 2: Canonical durable URL privacy

**Files:**
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`

**Interfaces:**
- Produces: canonical HTTP(S) URL strings containing origin and pathname only.

- [x] Add an adversarial artifact test with user-info, password, session/JWT
  params, nested credential redirect, tracking/referrer params, and fragment.
- [x] Run it and observe credential/query leakage.
- [x] Replace query deny-listing with origin/path canonicalization and clear
  user-info, search, and fragment.
- [x] Run privacy tests to GREEN.

### Task 3: Assessment-ready semantic facts

**Files:**
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/vacancyRank.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`
- Modify: `ui/lib/vacancyRank.test.mjs`

**Interfaces:**
- Produces: `semanticEvidence.descriptionPresent`, bounded normalized
  `profileRuleMatches[].fact`, and `mandatorySignals[].fact`.

- [x] Add failing tests proving empty descriptions lower confidence and
  provider candidates contain readable normalized facts without complete
  source sentences.
- [x] Run tests and observe the known-empty and opaque-digest failures.
- [x] Extract bounded canonical fact tokens from complete in-memory evidence,
  persist them with digest/completeness metadata, and render them into
  assessment candidates.
- [x] Run semantic and ranking tests to GREEN.

### Task 4: Claim-time terminal compatibility

**Files:**
- Modify: `tools/scout.mjs`
- Modify: `tools/scout.test.mjs`

**Interfaces:**
- Terminal verifier consumes the request execution fingerprint and terminal
  manifest; claim verifier still consumes live workspace state.

- [x] Add a real queued keeper test whose own tracker mutation changes the
  tracker digest but completes `succeeded`.
- [x] Run it and observe the current `stale` result.
- [x] Split claim and terminal verification so only claim re-reads workspace
  inputs and terminal compares recorded fingerprints.
- [x] Run the real runtime test to GREEN.

### Task 5: Direct scheduled-window coverage

**Files:**
- Modify: `ui/lib/scanQueue.mjs`
- Modify: `ui/lib/scanQueue.test.mjs`
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `tools/scout.mjs`
- Modify: `tools/scout.test.mjs`

**Interfaces:**
- Produces: `coverScheduledScanWindow(root, execution, lease)` for an exact
  schedule/logical-window/execution fingerprint.

- [x] Change the real scheduled overlap expectation to one collection and a
  durable skipped/covered request; run it RED.
- [x] Add queue-level adversarial coverage tests for mismatched job, window,
  and fingerprint.
- [x] Implement the exact fenced coverage transition and invoke it after direct
  terminal success before backup/release.
- [x] Run queue, pipeline, and Scout tests to GREEN.

### Task 6: Verification and handoff

**Files:**
- Modify: `docs/OPERATIONS.md` if the ownership or scheduling description changes.
- Modify: `.superpowers/sdd/2026-07-27-recoverable-scan-execution/task-6-report.md`

- [x] Run affected test files and record pass counts.
- [x] Run `npm.cmd test`.
- [x] Run `npm.cmd run release:audit`, syntax checks, and `git diff --check`.
- [x] Append exact RED/GREEN and verification evidence to the ignored Task 6 report.
- [x] Commit the reviewed tracked changes with a focused message.
