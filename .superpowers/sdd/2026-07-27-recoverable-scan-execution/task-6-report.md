# Task 6 report: persistent scan pipeline integration

## Scope

Implemented Task 6 against base `d0687a1` without starting Task 7.

Committed as `1c785a9` (`feat: persist scan pipeline progress`).

Changed:

- `ui/lib/scanPipeline.mjs`
- `ui/lib/scanPipeline.test.mjs`
- `ui/lib/runArtifacts.mjs`
- `ui/lib/runArtifacts.test.mjs`
- `ui/lib/scanLease.mjs`
- `ui/lib/scanQueue.mjs`
- `ui/lib/scanQueue.test.mjs`
- `tools/scout.mjs`
- `tools/scout.test.mjs`

The additive `runArtifacts` changes were required because the reviewed Task 2
schema stored stable identifiers only. Recovering real deterministic pipeline
work requires a bounded stage-data artifact. Schema 1 remains readable and
retains its original 16 KiB limit; schema 2 is limited to 16 MiB and rejects
private provider, credential, CV, advert-body and transcript property names.

The additive Task 4 lease/queue changes were required to make a real
contending process persist its request. The dedicated overlap path serialises
through the same workspace guard, revalidates the exact observed active lease
and operation, and can only append an idempotent queue submission. Claim,
completion, run and mutation transitions still require the genuine current
lease. Queue schema 3 adds the bounded provider/mode/model execution contract;
schema 1 and 2 replay rules remain supported.

## Implemented behavior

- `runScanPipeline(options)` returns the exact enumerable
  `{ runId, outcome, manifest, failures }` contract.
- A random run ID and genuine fenced lease are allocated before collection.
- The deterministic stages execute in order: collect, normalise, deduplicate,
  filter, rank and select.
- Every stage receives `{ run, lease, priorArtifact }`.
- Each stage artifact is atomically persisted and verified before its
  `stage.completed` event is appended.
- The rebuildable manifest is validated after every completion.
- Compatible interrupted runs are selected through the reviewed Task 5
  recovery APIs. Committed artifacts are read and reused without re-running
  their stage callbacks.
- An independent heartbeat remains active across asynchronous collection,
  liveness and provider work.
- Lease loss prevents all later artifact, journal and legacy tracker/report
  commits. The stale worker cannot append a terminal event.
- The terminal journal event is committed before lease release.
- Queue draining begins only after release, claims manual FIFO before scheduled
  work through the reviewed Task 4 projection, uses a fresh increasing fence
  for every request, records failed queued work durably and continues draining.
- Real overlaps are submitted by competing processes through the shared guard.
  If the observed lease has already ended, the contender retries normal lease
  acquisition rather than appending a stale overlap.
- Each claimed queued request executes a real six-stage journalled scan under
  the claim lease before its queue completion is appended.
- `runScanWith` now uses the durable pipeline for real ranked and legacy scans.
  Existing ranked selection, liveness backfill, second-pass behavior,
  assessment, tracker/report output and test injection adapters are preserved.
- Legacy tracker/report and scan-input writes are revalidated and performed
  synchronously inside the genuine fence.
- Collection and deterministic-stage failures retain the canonical failure
  scan/report record before the failed terminal journal event.
- Ranked stage codecs persist bounded advert and requirement excerpts, strip
  raw HTML, credential material and tracking parameters, and use the same
  decoded representation on fresh execution and recovery.

## TDD evidence

Observed RED before implementation:

- Focused Task 6 suite failed because `runScanPipeline` and
  `PipelineInterruptedError` did not exist.
- Real `runScanWith` test failed because no run journal or lease existed when
  collection began.
- Stage-data artifact test failed because schema 2 was unsupported.
- Legacy-bound regression failed because the initial schema 2 implementation
  had inadvertently enlarged the schema 1 limit.
- Queue continuation test failed because one queued callback exception stopped
  all later draining.
- Review-driven privacy test failed because raw advert fields were present in
  actual stage files.
- Review-driven overlap test failed because a lease contender returned
  `queued` without a durable queue append or executable request contract.
- Collection-stage failure test failed because the durable run had no
  canonical scan/report failure record.

Observed GREEN:

- Interruptions after each of the six deterministic stages recover the same run
  and do not repeat committed callbacks.
- Stale takeover leaves only the already committed stage and no stale terminal
  append.
- Queue drain observes the primary terminal event, uses strictly newer fences,
  runs real journalled queued scans, continues after a failed request and
  preserves manual-before-scheduled order.
- Four competing child processes append complete, replayable overlap requests
  without corrupting the queue. A lost-response retry appends no duplicate.
- Actual ranked artifacts contain bounded excerpts and omit raw HTML,
  credentials, full private tails and tracking parameters.
- Real scans expose the durable run ID and manifest and remove the lease only
  after a complete or failed terminal event.

## Verification

- Focused:
  `node --test ui/lib/scanLease.test.mjs ui/lib/scanQueue.test.mjs ui/lib/runArtifacts.test.mjs ui/lib/scanPipeline.test.mjs tools/scout.test.mjs`
  - 145 passed, 0 failed.
- Static checks:
  - `git diff --check` passed.
  - `node --check` passed for all changed production modules.
- Release/privacy audit:
  - scanned 202 files, 0 configured personal markers, passed.
- Full suite:
  - latest run: 792 passed, 0 failed, 2 skipped.

## Privacy and compatibility review

- No credential, provider transcript, prompt, raw provider response, raw HTML,
  CV/profile evidence, description, requirements or full advert-body field is
  accepted in the new artifact schema.
- Deterministic recovery data uses named, bounded excerpts and sanitised URLs;
  actual artifact-file tests verify full private tails and tracking parameters
  are absent.
- Journals contain only bounded metadata and artifact references/digests.
- Existing schema 1 artifacts and legacy artifact paths remain readable.
- The ignored SDD brief was rewritten only to correct its en-dash encoding; no
  production audit or tracked source was weakened.

## Review resolution and remaining scope

- Independent review findings about overlap persistence, private stage data,
  queued-run terminal ordering, orphaned claims, false queued responses,
  scheduled request identity, startup compatibility and hostile schema 1
  replay were resolved and covered by focused tests.
- Crash-idempotent receipts for final assessment/tracker/report mutations are
  intentionally deferred to Tasks 7 and 8.
- Further diagnostics for damaged recovery candidates and process-kill coverage
  at every stage remain useful hardening work; the current suite covers every
  stage interruption and stale takeover with deterministic clocks, plus
  multi-process queue contention.

---

# Fix round 1: review resolution

Date: 2026-07-28

## Outcome

All three Critical findings, all eight Important findings, and the narrow API
Minor from `task-6-review.md` were addressed. Task 7/8 assessment and mutation
receipts remain deliberately out of scope.

## Review findings resolved

- Losing overlap callers now acquire no workspace-mutation authority. Managed
  instruction synchronisation runs only after lease ownership is established,
  and backup is queued only for the caller's own successful terminal result.
- Recovery selection changes run scope with an atomic fenced lease handoff.
  There is no release/reacquire branch which can claim that work was queued
  without a durable queue transition.
- Ranked and grandfathered artifacts persist structured semantic facts,
  digests, stable references, sanitised URLs, bounded source status counts, and
  exact profile-rule or mandatory-signal matches. They persist no advert prose,
  requirements prose, provider diagnostics, credential values, or tracking
  parameters.
- Semantic extraction runs against the complete in-memory advert before prose
  is discarded. A responsibility exclusion beyond the former prefix limit is
  therefore recovered exactly. Legacy source insertion order, duplicate
  winner, fair-share iteration, and candidate identity order are preserved.
- Idle startup claims older compatible FIFO work before starting an unqueued
  run. A durable orphan claim resumes under its original run ID and reuses
  already committed artifacts.
- Queue compatibility now fingerprints all result-affecting configuration and
  the tracker revision. It is re-read at claim and terminal boundaries, and a
  mismatch becomes a durable `stale` result.
- Scheduled requests and run journals carry both schedule job ID and canonical
  logical-window ID. Coalescing and window coverage require both identities.
- A terminal append or manifest-validation failure retains the lease for fenced
  recovery. A queued pre-pipeline failure records a fixed bounded
  `run.failure-recorded` code/reason without persisting exception text.
- Recovery compatibility schema 2 separately declares storage-envelope and
  deterministic stage-data schema versions, while schema 1 remains readable.
- Damaged candidate journals are represented by bounded placeholders and
  durably skipped in the fenced workspace recovery-selection journal without
  modifying the damaged run.
- The generic observed-owner callback was removed. The only exported
  non-owner primitive accepts a validated queue event and optimistic queue
  digest, revalidates the exact observed lease, and appends under the shared
  guard.

## TDD evidence

Each finding received focused regression coverage. Important RED observations
included pre-lease `.gitignore` mutation, backup after a queued result, a
non-atomic recovery handoff, missing semantic evidence beyond the old prefix,
new work leapfrogging an older queued request, orphan replay under a fresh run
ID, missing scheduled identity, raw queued exception loss, silent damaged-run
omission, and legacy mandatory semantics disappearing from persisted output.

The first full-suite run additionally found that direct ranker callers without
semantic artifacts entered the semantic evidence branch. The compatibility
guard was corrected and the two ranker regressions were rerun before repeating
the full suite.

## Verification

- Focused affected files:
  - `188 passed`, `0 failed`.
- Full suite:
  - `808 passed`, `0 failed`, `2 skipped`.
- Release/privacy audit:
  - scanned 202 files with 0 configured personal markers; passed.
- Static:
  - `git diff --check` passed.
- Operations documentation now describes durable overlap queuing, startup
  draining, original-run claim recovery, and success-only backup authority.

---

# Fix round 2: re-review resolution

Date: 2026-07-28

## Outcome

The five findings left open by `task-6-re-review-1.md` are addressed without
implementing Task 7 assessment receipts or Task 8's complete crash-idempotent
mutation protocol.

## Review findings resolved

- A successful tracker/report mutation emits a narrow exact receipt. The
  complete terminal manifest is validated before a receipt-gated backup runs,
  and the pipeline keeps the genuine lease and heartbeat until that backup
  finishes. Missing receipts and backup errors leave the scan complete with a
  bounded pending status. Each direct, drained, or startup-drained successful
  run owns its own checkpoint; overlap losers own none.
- Durable scan URLs retain only HTTP(S) origin and pathname. User-info,
  passwords, fragments, all query parameters, and nested credential-bearing
  redirects are removed from deterministic artifacts and `.scout/scan-input`.
- Semantic artifacts now distinguish an absent description from known empty
  matches and preserve bounded normalized responsibility, profile-rule, and
  mandatory-requirement facts. Assessment input is readable and
  behaviorally useful without retaining complete advert sentences.
- Queued terminal verification compares the terminal manifest with the
  fingerprint captured by the claim. Live workspace profile/config/tracker
  inputs are still re-read at claim time, but a queued run's own authorized
  tracker mutation no longer self-classifies it as stale.
- A successful direct scheduled run appends a fenced durable coverage
  transition for queued overlaps matching the exact schedule job, logical
  window, purpose, and execution fingerprint. Mismatched jobs, windows, and
  fingerprints remain queued.

## TDD evidence

Observed RED before implementation:

- The post-success hook did not exist, successful mutation output carried no
  exact receipt, and backup occurred only after lease release.
- Adversarial persisted URLs retained user-info, session/JWT/code/key/referrer
  query values, nested redirect credentials, and fragments.
- Empty descriptions were treated as known evidence, while assessment input
  exposed only opaque rule IDs and digests.
- A real queued keeper run mutated the tracker and then completed as `stale`.
- A same-window scheduled overlap collected twice because direct runs could
  not cover queued work.

Observed GREEN:

- Valid receipts back up under the current fence; missing receipts and backup
  errors preserve successful completion with bounded pending evidence.
- Direct, normally drained, and startup-drained successes each receive exactly
  one owned checkpoint, including when the following direct run fails.
- Deterministic stage artifacts and the production scan-input bundle contain
  the canonical origin/path URL and none of the adversarial private values.
- Empty descriptions retain unknown-confidence behavior, while semantic
  recovery supplies bounded readable facts without full advert sentences.
- Keeper-producing queued scans complete `succeeded` against claim-time input,
  and direct scheduled success covers only its exact queued window.

## Verification

- Focused affected files:
  - `123 passed`, `0 failed`.
- Full suite:
  - First run exposed one load-sensitive failure in the unchanged scan-lease
    PID-reuse test; that test passed immediately in isolation.
  - Clean rerun: `819 passed`, `0 failed`, `2 skipped`.
- Release/privacy audit:
  - scanned 204 files with 0 configured personal markers; passed.
- Static:
  - `node --check` passed for all changed production modules.
  - `git diff --check` passed.
- Operations documentation now records receipt-gated fenced checkpoints and
  exact scheduled-window coverage.

---

# Fix round 3: final re-review resolution

Date: 2026-07-28

## Outcome

The four remaining round-two findings are addressed without implementing Task
8's full crash-idempotent mutation coordinator.

## Review findings resolved

- Runtime backup no longer blocks the Node.js event loop. Production Git
  commands use bounded asynchronous child processes with bounded output and a
  30-second default deadline. The scan fence is asserted before and after each
  Git or recovery mutation, and the pipeline heartbeat remains active until
  backup returns.
- Real backup status is explicit. Offline backup becomes `backup-pending`;
  reconciliation requiring attention becomes `backup-partial`. Queued runs
  durably preserve these as `succeeded-pending` and `succeeded-partial`, while
  both still count as successful exact-window coverage.
- A malformed mutation receipt no longer throws after a successful scan. The
  terminal scan remains complete, backup is skipped, and the bounded reason is
  `mutation-receipt-invalid`.
- Credential assignments, authorization payloads, JWT-like strings, and URL
  user-info are redacted as the fixed whole fact `sensitive requirement
  redacted`. Ordered semantic operators such as `non` are retained, and every
  non-empty description clause can produce bounded responsibility evidence.
- Fresh discovery retains query-bearing URLs in memory for normalization,
  deduplication, selection, and liveness. The separate durable projection
  strips user-info, query, and fragment from stage artifacts, scan-input,
  scan-run history, tracker entries, and reports.

## TDD evidence

Observed RED before implementation:

- Runtime sync ignored the async spawn adapter, could not advance a timer while
  a Git mutation was pending, had no command deadline, and ignored the scan
  fence.
- Pending and partial hook results were collapsed to success; queue validation
  rejected the new outcomes; malformed receipt envelopes failed instead of
  completing with pending backup.
- Semantic facts persisted credential payloads, removed `non`, and discarded
  `Accountability for incident response`.
- Liveness received the durable path-only URL, while later strengthened tests
  found query identity persisting in scan-run and tracker/report projections.

Observed GREEN:

- Deferred Git mutation leaves timers and heartbeat work runnable; timeout
  returns bounded needs-attention state; stale fence prevents the first
  mutation.
- Direct and queued offline/needs-attention outcomes remain visible and
  durable without raw error text, while exact-window coverage remains
  logically successful.
- Credential payloads are absent from artifacts and assessment input;
  `non-technical` and accountability evidence remain available.
- Liveness receives the transient query-bearing URL, while every persisted
  projection exercised by the scan contains only HTTP(S) origin/path.

## Verification

- Focused affected files:
  - `152 passed`, `0 failed`.
- Release/privacy audit:
  - scanned 206 files with 0 configured personal markers; passed.
- Static:
  - `node --check` passed for all changed production modules.
  - `git diff --check` passed.
- Full suite:
  - Initial loaded run: `830 passed`, `2 failed`, `2 skipped`. The unchanged
    scan-lease PID-reuse timing test passed immediately in isolation. The
    substantive 36 server tests passed, but the Windows after-hook could not
    remove its temporary directory because of an `EPERM` cleanup race.
  - Fresh rerun after confirming no test-spawned Node process remained:
    `831 passed`, `1 failed`, `2 skipped`. The only failure was the same
    unchanged `ui/server.test.mjs` Windows after-hook `EPERM`; all 36
    substantive server assertions passed again. Full-suite green is therefore
    not claimed.
