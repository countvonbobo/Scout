# Task 5 review: stage-aware recovery

Commit reviewed: `c83b553 feat: recover compatible scan stages`

## Verdicts

- **Specification compliance: FAIL.** The implementation has a useful
  allow-listed compatibility contract, deterministic newest-first ordering,
  explicit provider-substitution events, strict journal corruption handling,
  fenced writes, artifact digest/schema validation and an additive manifest-v1
  upgrade path. However, `recoverRun` does not consume the compatibility
  request/decision made by `selectRecoverableRun`, so ranking, prompt,
  assessment-schema, mutation-schema and target-revision changes are discarded
  before recovery is journalled. Recovery decisions also do not invalidate
  older completed-stage artifacts, allowing a later recovery to resurrect work
  that a prior recovery explicitly restarted.
- **Code quality: FAIL pending Critical and Important fixes.** The code is
  readable and the fixed payload grammars are carefully bounded, but the
  manifest is not yet a coherent current-state projection across multiple
  recovery generations. Selection failures and recovery-failure records also
  lack the durable, idempotent treatment required for reliable orchestration.

## Critical findings

### 1. `recoverRun` discards the stage-aware compatibility decision selected by the caller

**Lines:** `ui/lib/runRecovery.mjs:176-185,216-264,274-291,374-395,443-451`

`selectRecoverableRun(candidates, request)` correctly computes stage-level
restarts for non-hard differences. For example, a ranking-version change keeps
the candidate recoverable but marks ranking and downstream completed work for
restart. The selected request or decision is not accepted by `recoverRun`,
though. `recoveryRequest` reconstructs a request by cloning the historical
manifest compatibility and overrides only mode, provider and model from the
lease.

Consequently, the normal select-then-recover flow can silently reverse its own
decision:

1. candidate ranking version is `v4`, current request is `v5`;
2. selection returns that run with `rank` marked `restart`;
3. `recoverRun` rebuilds the request as historical `v4`;
4. it journals `rank` as `reuse`.

The same loss affects prompt version, assessment schema, mutation schema and
target revision. It is not limited to a race after selection; the exact
request is never present at the recovery boundary. Provider/model happen to
survive only because those two fields are carried by the lease.

Pass the validated current compatibility request (or a canonical, immutable
decision bound to its fingerprint) into `recoverRun` and revalidate it under
the current fence immediately before appending recovery events. The journal
must record the decision that selection actually made, and a changed request
must force reselection rather than being replaced with historical values.

### 2. Restart decisions do not invalidate old completions, so later recovery can resurrect stale work

**Lines:** `ui/lib/runArtifacts.mjs:206-267`;
`ui/lib/runRecovery.mjs:242-258,443-491`

The manifest appends every `stage.completed` event to `completedWork` and
stores `recovery.stage-decided` events in a separate `recoveryDecisions` list.
`RecoveryCompatibilityDecision` reads only `completedWork`; it never applies
the prior decisions when determining which artifacts are currently reusable.

After an explicit Codex-to-Claude substitution, for example, recovery journals
that the old assessment must restart. If the process dies before replacement
assessment work commits, a later recovery using the old provider sees the
original assessment completion and can mark it reusable, undoing the recorded
substitution boundary. More generally, any ranking or assessment artifact
previously invalidated by a restart remains eligible on a later generation.

When replacement work does complete, the manifest retains both completions for
the same stage. A subsequent recovery maps both entries to stage decisions and
attempts to append them with the same generation/stage idempotency key; differing
artifacts then conflict rather than producing one current stage state.

Project one authoritative current completion per stage. A restart decision
must invalidate the earlier completion for reuse, and a later valid completion
must supersede it under explicit provenance. Replay should enforce canonical
stage order and reject impossible downstream-only histories so a missing
assessment completion cannot permit tracker/report reuse. Add multi-generation
tests covering crash immediately after restart decisions, provider switching
back, replacement completion and another takeover.

## Important findings

### 3. Newer skipped runs and incompatible in-progress histories are not recorded durably

**Lines:** `ui/lib/runRecovery.mjs:274-291`;
`ui/lib/runJournal.mjs:18-59`

Selection returns an in-memory `skipped` array, but no journal or external
selection record persists those reasons. A crash after selection loses the
explanation, and an incompatible in-progress candidate remains indefinitely
`in-progress`; it is not made into an immutable `partial` or `abandoned`
history with a reason.

This falls short of the approved requirement to record why every newer
incomplete run was skipped and to preserve incompatible histories as
reasoned, non-failed terminal records. Add a fixed, privacy-safe durable event
or selection journal with a stable selection identity. Repeating the same
selection must acknowledge the existing record, while a changed candidate set
or request fingerprint must have a distinct identity.

### 4. A damaged or contradictory manifest is failed instead of rebuilt from the valid journal

**Lines:** `ui/lib/runArtifacts.mjs:313-344`;
`ui/lib/runRecovery.mjs:422-431`

Missing manifests, exact stale prefixes and the recognized schema-1 projection
are rebuilt. Invalid JSON or any other contradictory manifest throws
`ManifestAgreementError`, which `recoverRun` turns into a visible
`manifest-damaged` recovery failure.

The journal is the authority, and the approved design explicitly requires a
missing, stale **or contradictory** manifest to be rebuilt after journal
validation. A manifest that claims nonexistent work must never be trusted, but
it also must not make an otherwise valid run unrecoverable. Discard the derived
manifest and atomically rebuild the validated projection. Continue failing
closed when the authoritative journal or a journal-referenced artifact is
invalid.

### 5. One malformed or unsupported candidate aborts selection instead of becoming a recorded skip

**Lines:** `ui/lib/runRecovery.mjs:109-127,156-173,274-291`

`candidates.map(checkedCandidate)` validates the whole list before sorting.
Therefore a newer legacy candidate with missing compatibility, an unsupported
schema, an unknown completed stage or another incompatible shape throws and
prevents selection of an older valid run. This is particularly problematic at
the additive migration boundary, where legacy summaries are expected to remain
readable and unsupported versions should make work incompatible, not stop all
recovery.

Additionally, `checkedCompatibility` accepts any positive journal and artifact
schema numbers. If candidate and request both say version 2, selection reports
them compatible even though this implementation supports only journal/artifact
version 1.

Classify each candidate independently and emit stable reasons such as
`compatibility-missing`, `journal-schema-unsupported` and
`artifact-schema-unsupported`; continue scanning older candidates. Bind
support checks to `RUN_JOURNAL_SCHEMA_VERSION` and
`RUN_ARTIFACT_SCHEMA_VERSION`, not merely equality between two inputs.

### 6. Recovery-failure appends are fenced but not idempotent

**Lines:** `ui/lib/runRecovery.mjs:294-337`

The external failure record has a random event ID but no stable recovery
attempt identity, idempotency key or canonical input digest. Retrying recovery
of the same damaged run under the same lease generation appends another
failure rather than returning the already committed result. The file is
append-only but has no replay validation for duplicate/conflicting records or
an interrupted final append.

Derive a stable failure identity from run ID, lease generation and recovery
request/decision fingerprint. Under the workspace fence, acknowledge an exact
existing failure and reject a conflicting retry. Give this visible journal a
bounded replay rule for an incomplete final append rather than allowing the
diagnostic record itself to become ambiguous.

## Minor findings

None.

## Confirmed compliant areas

- For fully valid candidates, ordering is newest `updatedAt` first with a
  deterministic run-ID tie-break, and selection stops at the first recoverable
  candidate while returning reasons for candidates examined before it
  (`ui/lib/runRecovery.mjs:274-291`).
- The compatibility schema contains the required scan mode, purpose, published
  profile, source/config fingerprint, journal/artifact schemas, pipeline and
  ranking versions, prompt/assessment provenance, provider/model and
  mutation/target revision. Unknown fields and raw private content are rejected
  by exact-key, bounded-token schemas
  (`ui/lib/runRecovery.mjs:26-70,92-127`;
  `ui/lib/runJournal.mjs:18-91,175-230`).
- Collection through selection excludes provider/model provenance; assessment
  includes provider/model/prompt/schema, and tracker/report include
  mutation-schema and target-revision requirements
  (`ui/lib/pipeline.mjs:6-47`).
- A provider/model change requires an exact explicit substitution and the
  selected-run recovery path journals old and new provenance before stage
  decisions (`ui/lib/runRecovery.mjs:129-154,187-193,229-239,465-491`).
- Complete journal corruption, including a complete invalid final entry, fails
  closed without appending to the damaged run. Only a syntactically incomplete
  final append is bounded, quarantined and removed; the operation is performed
  with a genuine current workspace/run lease and inside the shared guard
  (`ui/lib/runJournal.mjs:362-421`;
  `ui/lib/runRecovery.mjs:339-371,405-431`).
- Journal, manifest, artifact, quarantine and external failure writes use the
  real fenced lease path. Run-scoped writes are checked against the lease's
  canonical workspace/run scope before commit
  (`ui/lib/scanLease.mjs:828-852,1163-1186`;
  `ui/lib/runRecovery.mjs:315-329,405-411`).
- Journal-referenced artifacts are checked for exact envelope schema,
  supported artifact schema and canonical digest before reuse. Recovery
  decision artifacts are included in the manifest artifact set
  (`ui/lib/runArtifacts.mjs:115-178,198-267,309-317`).
- Schema-1 manifests that match their valid historical projection are upgraded
  additively to schema 2; recovery event payloads remain independently
  versioned with fixed version-1 schemas
  (`ui/lib/runArtifacts.mjs:297-342`;
  `ui/lib/runJournal.mjs:18-59`).
- Per-generation stage and substitution journal keys are retry-idempotent for
  identical payloads because `appendRunEvent` returns an existing exact match
  and rejects a conflicting payload
  (`ui/lib/runRecovery.mjs:465-491`;
  `ui/lib/runJournal.mjs:447-523`).

## Review basis

Reviewed `AGENTS.md`, `docs/OPERATIONS.md`, the approved recoverable-scan
execution design, `task-5-brief.md`, `task-5-report.md`,
`task-5-review-package.md`, commit `c83b553`, and the Task 3 lease boundary
used by all Task 5 writes.

Per instruction, I did not rerun the evidenced tests. The supplied report
records 43/43 focused tests, 764 full-suite tests with 762 passing and two
documented platform skips, the release privacy audit, syntax checks and
`git diff --check` as passing; those results are accepted as supplied rather
than independently re-executed here.

## Fix round 1

All six findings were addressed with regression coverage.

- Recovery execution now requires and revalidates the exact selected
  `RecoveryCompatibilityDecision`, journals its request and selection
  fingerprints in a generation-bound `recovery.started` event, and refuses a
  changed candidate or mismatched lease operation.
- Manifest schema 3 projects one canonical current completion per pipeline
  stage. A restart invalidates that stage and every downstream stage, while a
  later completion becomes the sole authoritative replacement across repeated
  provider-switch generations.
- Candidate selection independently classifies malformed and unsupported
  inputs, binds journal/artifact versions to the current supported constants,
  and can durably record the selected run plus immutable `partial` or
  `abandoned` skip outcomes in an idempotent selection journal.
- The manifest is treated as derived state: after journal and artifact
  validation, missing, unreadable, stale, or contradictory manifests are
  atomically rebuilt from the journal.
- Recovery failure records use a stable identity derived from run, lease
  generation, request fingerprint, and reason. Their replay validates exact
  schemas and duplicate identities, and only a bounded syntactically incomplete
  final append may be quarantined and repaired.

Verification on 2026-07-27:

- Focused recovery/artifact tests: 22 passed, 0 failed.
- Full suite: 769 tests; 767 passed, 0 failed, 2 documented skips.
- Release audit: 202 files scanned, 0 configured personal markers, passed.
- `git diff --check`: passed (line-ending conversion notices only).
