# Recoverable Scan Execution and Assessment Resilience

## Status and scope

This design implements Gate A2 and the tightly coupled Gate A7 work from
issue #77. It also incorporates the safe backup-divergence behaviour from
PR #71, excluding that PR's unrelated tab-order commit, and resolves open
issues #72 through #76 in the same milestone.

The work starts from merged PR #78 on `main` at `985ccdf` and lives on
`agent/recoverable-scan-execution`. It must remain a separate review from the
ranked-discovery foundation.

The milestone covers:

- durable scan runs from collection through reporting;
- single-writer leases with fencing;
- automatic stage-aware recovery;
- durable, stale-aware overlap queues;
- resilient assessment batches, focused repair and per-job failure isolation;
- idempotent, effectively exactly-once tracker and report mutation from Scout's
  perspective;
- run-centric scan health and UI states;
- bounded retention, compaction and privacy controls; and
- safe resolution of disjoint private-backup divergence;
- canonical, accessible Scout character animation timing and alignment (#72);
- trustworthy provider model discovery and effective-default display (#73);
- race-safe chat usage rendering (#74);
- detected Codex deep-link support with a resumable fallback (#75); and
- durable provider-health and guided reauthentication workflows (#76).

It does not add search lanes, employer discovery or preference learning.

## Durable run model

Each scan has a stable random `runId` and a private run directory:

```text
.scout/runs/<runId>/
  journal.jsonl
  manifest.json
  artifacts/
```

The append-only journal is the durable source of truth. The manifest is a
compact, rebuildable projection of validated journal state and completed
artifact references.

Every journal event has:

- journal schema version;
- run ID and monotonically increasing sequence number;
- stable event ID and event type;
- UTC audit timestamp;
- lease ID and fencing generation;
- stable stage, assessment-batch or mutation identity where applicable;
- idempotency key;
- previous-entry hash;
- canonical payload hash; and
- a bounded privacy-safe payload or a versioned artifact reference and digest.

Artifacts are written to a temporary file, flushed, and atomically replaced
before an event may reference them. The manifest uses the same temporary-file
and atomic-replacement protocol. The manifest records its projection schema,
last validated journal sequence and hash, run outcome, compatibility versions,
completed stages and batches, artifact references, queue/recovery information
and terminal mutation receipts.

Every append validates the current fencing token immediately before commit.
The append implementation serialises writers through the same operating-system
exclusion mechanism used by the lease. An older worker cannot append after a
takeover even if it has not observed the expiry itself.

### Journal integrity and recovery

Recovery validates canonical hashes, the previous-hash chain, sequence
monotonicity, schema support and event invariants.

- Only a genuinely truncated or syntactically incomplete final append is
  quarantined and excluded from replay. Earlier valid events remain
  authoritative.
- A syntactically complete entry whose canonical payload hash, previous-entry
  hash or event hash is invalid fails closed, including when it is the final
  line. Complete-but-invalid data is corruption, not an interrupted append.
- Corruption before the final entry fails closed. Recovery records a visible
  recovery failure outside the damaged run and does not append to it.
- A missing, stale or contradictory manifest is rebuilt from the valid journal.
- A manifest that claims work not present in the journal is never trusted.
- A referenced artifact must exist, match its digest and use a supported schema
  before the corresponding stage is reusable.

Journal and artifact schemas are independently versioned. Unsupported versions
make the affected stage incompatible without rewriting the historical run.

## Identities and idempotency

Stable identities exist for:

- run requests;
- runs;
- lease generations;
- pipeline stages;
- source collections;
- canonical ranking inputs;
- assessment batches;
- per-job assessment attempts;
- focused repairs;
- tracker mutations;
- report mutations;
- backup-divergence analyses and resolutions; and
- retention/compaction operations.

Idempotency keys are derived from canonical inputs and relevant schema,
profile, configuration, pipeline, prompt and provider versions. Completed
assessment jobs and batches cannot be submitted again during recovery. A
duplicate request or append returns the existing committed result rather than
creating a second effect.

## Lease and fencing model

The active lease is stored at:

```text
.scout/scan-lease.json
```

It contains:

- lease schema version;
- lease ID;
- monotonically increasing fencing generation;
- run ID or coordinated mutation ID;
- operation kind;
- provider, model and scan mode where applicable;
- current phase;
- owner host;
- process ID;
- process-start identity;
- acquisition, heartbeat and expiry wall-clock timestamps;
- monotonic heartbeat sequence;
- recovery count; and
- last terminal journal sequence when known.

Owner identity combines host, PID and a process-start identity so a reused PID
cannot impersonate the original worker.

### Operating-system exclusion

Lease acquisition, heartbeat, takeover and release all acquire the same
short-lived operating-system mutex:

```text
.scout/scan-lease.guard/
```

Scout creates this guard directory atomically with `mkdir`, which is exclusive
on supported Windows, macOS and Linux filesystems. It writes guard-owner
metadata only after successful creation, performs one bounded lease operation,
and removes the guard on exit. The durable lease remains in
`.scout/scan-lease.json`; the guard is not the lease itself.

A process that dies while holding the short-lived guard cannot block forever.
Guard metadata includes host, PID, process-start identity and acquisition time.
After a 30-second guard timeout, a contender may atomically rename the observed
guard to a unique quarantine name, create a new guard, and then revalidate the
lease before acting. A live guard is never renamed.

Only the process holding the guard may read-modify-replace the lease or allocate
the next fencing generation. Atomic replacement protects JSON integrity; the
guard prevents two processes both believing they acquired, renewed, took over
or released the lease.

All operations re-read and validate the lease generation while holding the
guard. Tests launch competing processes, not merely concurrent promises in one
process.

### Heartbeat and expiry

The default lease duration is 90 seconds and the heartbeat interval is 15
seconds. Normal renewal therefore has a six-heartbeat window. The worker begins
takeover safety checks only after expiry plus a 15-second margin.

Provider calls have explicit bounded timeouts. An independent heartbeat loop
runs while collection or provider work is awaiting external I/O. Long phases
may extend the advertised expiry only through successful fenced heartbeat
renewal; a phase cannot pre-authorise an unbounded expiry.

Wall-clock time is audit information and supports restart recovery. The active
process uses monotonic elapsed time for its own renewal schedule and timeout
decisions. A backward wall-clock jump cannot extend the process's local
heartbeat deadline. A forward jump triggers an immediate fenced renewal check.
After a machine restart, no monotonic state is assumed; recovery uses the
persisted expiry, owner process-start identity and takeover margin.

### Takeover and lease loss

Takeover order is:

1. observe an expired lease;
2. acquire the exclusive takeover primitive;
3. revalidate expiry and the observed generation;
4. allocate and persist the next fencing generation;
5. validate the referenced journal and manifest;
6. append a fenced recovery event only when validation succeeds; and
7. begin an independent heartbeat loop.

If validation fails, the new worker records a separate visible recovery failure
and does not attach to the damaged run.

On lease loss, the worker stops all journal appends, artifact commits,
assessment completions and external mutations. In-flight computation may finish
locally, but its output cannot be committed. Reuse requires normal recovery
under a newer lease generation.

Lease release is journalled as a terminal action where possible, fenced through
the exclusive primitive, and then removes the lease. A terminal run whose lease
file could not be removed remains recoverable after expiry because takeover
validates the terminal journal before doing any work.

## Durable request queue

Overlaps are persisted in the append-only `.scout/scan-queue.jsonl` queue
journal. It is the durable source of truth for queue transitions; any queue
summary is a rebuildable projection. Every request has a stable request ID,
idempotency key, requested time, requester type, mode, provider preference,
profile/config compatibility fingerprint, purpose and expiry.

- Manual requests queue by default and expire after 24 hours.
- Scheduled requests expire at the next scheduled window or after 12 hours,
  whichever comes first.
- A request becomes stale immediately when its published profile, source/config
  fingerprint, pipeline purpose or supported schema no longer matches.
- Equivalent queued requests deduplicate by idempotency key.
- Manual requests retain FIFO order among compatible requests.
- Equivalent scheduled requests coalesce; the newest request supersedes older
  scheduled equivalents, which become auditable `skipped/superseded` records.
- A scheduled request is skipped when a compatible successful or active run
  already covers its scheduling window.
- Expired and stale requests never execute. Their terminal reason remains
  visible.
- After lease release, the oldest compatible manual request runs first,
  followed by the newest non-superseded scheduled request.

Every enqueue, deduplication, supersession, expiry, stale rejection, dequeue and
terminal result is appended to the versioned queue journal. Queue state is never
represented only in process output.

## Automatic, stage-aware recovery

Recovery chooses the newest recoverable run matching the compatibility contract,
not merely the newest incomplete run. It records why every newer incomplete run
was skipped.

Compatibility includes:

- scan mode and purpose;
- published profile version;
- source and configuration fingerprint;
- journal and artifact schema versions;
- pipeline version;
- canonicalisation/ranking version;
- prompt and assessment schema version for assessment reuse;
- provider and model for completed assessment reuse; and
- tracker/report mutation schema and target revision.

Compatibility is stage-aware:

- valid collection, normalisation, deduplication, filtering, ranking and
  selection artifacts remain reusable when their own inputs and versions match;
- assessment work remains reusable only when its provider, model, prompt and
  schema provenance match;
- a different provider or model may assess the remaining jobs only through an
  explicit configured recovery decision and a journal event recording the old
  and new provenance; and
- tracker/report work is reusable only through its mutation identity and digest
  checks.

Incompatible runs become immutable `partial` or `abandoned` records with a
reason. They are not rewritten as failed unless they genuinely failed.

## Assessment batching and repair

The selected assessment set is split into stable batches of at most 10 jobs.
The context budget may deterministically reduce a batch size. A batch identity
is derived from the run, ordered vacancy IDs, profile version, prompt version,
assessment schema, provider/model and pipeline version.

For each batch:

1. persist a minimal structured request artifact containing stable job
   references, input digests, schema/prompt/provider/model versions and the
   bounded parameters needed to reproduce the request;
2. append the fenced attempt event;
3. call the provider with a bounded timeout while the independent heartbeat
   continues;
4. validate each returned job independently;
5. commit each valid assessment under its stable job idempotency key;
6. send only invalid jobs and their validation failures through one focused
   schema-repair attempt;
7. allow at most one clean per-job retry after failed repair; and
8. persist exhausted jobs as auditable failures.

One malformed job or response cannot discard valid sibling results or completed
batches. A partial run can still update the tracker and report with successful
jobs while recording failures precisely.

Provider substitution is never silent. Completed pre-assessment stages may be
reused, but a substitution requires an explicit configured recovery decision,
new batch identities and new assessment provenance.

The persisted request artifact is a reference record, not a transcript. It
does not contain CV content, full adverts, full prompts, provider transcripts
or raw responses. If a future provider integration proves that any such
content is strictly required for recovery, it needs an explicit protected
schema, documented purpose, access boundary and retention period before it may
be persisted.

## Tracker and report mutations

Tracker and report updates are idempotent and effectively exactly-once from
Scout's perspective. The design does not claim an absolute distributed
exactly-once guarantee. Genuinely ambiguous crash state fails closed for review.

Each mutation uses a deterministic plan:

1. persist the intended mutation artifact, target revision and digest;
2. append a prepared event;
3. validate the current fencing token immediately before mutation;
4. acquire the shared mutation coordinator;
5. revalidate fencing and the tracker revision;
6. atomically apply content carrying the run and mutation identities;
7. verify the written digest and embedded identity; and
8. append the mutation receipt.

Recovery compares embedded mutation identities and digests. A matching target is
acknowledged without replay. A conflicting target or unverifiable crash window
fails closed instead of guessing.

Backup-divergence resolution uses this same mutation coordinator and fencing
protocol. It cannot merge or sync while a tracker/report mutation is active, and
a scan cannot begin a tracker/report mutation while divergence resolution owns
the coordinator.

## Safe backup-divergence resolution

The milestone ports only the safe backup feature from PR #71.

Scout classifies divergence after fetching and verifying both tips:

- `disjoint-safe`: clean tracked worktree, ordinary additions/modifications and
  no overlapping paths;
- `overlapping`: both histories touched the same path or ancestor/descendant
  path; or
- `manual-required`: rename, deletion, unusual status, dirty tracked files,
  unsafe untracked files, missing upstream, stale tips or failed analysis.

Only `disjoint-safe` can be resolved automatically. Resolution requires an
explicit confirmation and an analysis token bound to local tip, remote tip and
branch. Scout:

1. acquires the shared fenced mutation coordinator;
2. refetches and revalidates both tips and the analysis token;
3. creates recovery refs for both tips;
4. performs a normal `--no-ff` merge without reset, rebase or force push;
5. retries the normal encrypted backup sync; and
6. reports synced, offline/pending or manual-review state.

Merge failure aborts the merge when possible and preserves both recovery refs.
Push failure preserves the local merge and reports pending/offline.

The UI shows only ahead/behind counts and sanitised affected areas. It never
shows raw paths. Active and incomplete run state may enter private backup only
inside Scout's encrypted recovery data, never as plaintext tracked workspace
files.

## Included open-issue workstreams

The following workstreams are independently testable and releasable, while
sharing this milestone's reliability, privacy and diagnostics rules.

### Character animation pacing and alignment (#72)

`ui/lib/scoutCharacter.mjs` is the single source of truth for state-specific
frame count, frame rate and anchoring. The browser runtime consumes that data
instead of imposing one 16-frame/two-second animation on every state. Calm
states remain calm, action states may be faster, and reduced-motion mode shows
a stable representative frame. Common or per-frame anchors keep distinct poses
centred at both the 44px compact and 112px expanded render sizes. Browser timing
tests and image comparisons guard against flicker, fractional-cell drift and
pose jumps.

### Provider model catalogue and effective defaults (#73)

The provider model picker uses a trustworthy provider-specific catalogue and
shows human-readable available choices with concise trade-off labels. For
Codex, Scout reads the effective configured model and the catalogue exposed by
the installed client (`codex debug models` where supported), with a bounded
bundled fallback rather than inferring availability from ambiguous logs.
"Provider default" includes the resolved effective model when it can be
verified. Custom exact IDs remain an escape hatch. A stale or rejected saved
choice is visibly invalid and cannot silently masquerade as the current
default.

### Coherent usage summary rendering (#74)

Engine options and usage data update one persistent chat-drawer state model.
Rendering either result cannot delete the other's region, and responses carry
the active chat/request generation so late data from a previous chat is
discarded. Usage copy distinguishes unavailable data, account estimates,
context-window use and model spend. Deterministic tests exercise both
completion orders and a chat switch between requests.

### Codex task deep-link detection and fallback (#75)

Scout retains the currently documented `codex://threads/<technical-thread-id>`
link for local chats, but enables it only after a device-local capability
check or a bounded launch acknowledgement. A failed or unavailable handler
produces a plain explanation plus copyable technical task ID and resume
instructions. Remote sessions explain that the desktop handler must exist on
the device opening the link. The fallback preserves the exact resumable task
identity and never claims success merely because an anchor was clicked.

### Provider health and guided reauthentication (#76)

Provider health is durable device-local state with these explicit values:
`checking`, `ready`, `credentials-present-unverified`, `sign-in-required`,
`login-in-progress`, `network-unavailable`, `rate-limited`,
`cli-update-required` and `provider-error`. Checks run at startup, before a
manual run, during scheduled-job preflight, periodically while scheduled work
is enabled and after authentication failure or login. A remote authentication
failure cannot be overwritten by a local credential-presence check.

Scheduled work blocked by provider health creates a persistent deduplicated
alert and an auditable skipped/blocked scan record; work for unrelated healthy
providers continues and no provider substitution occurs silently. Explicit
retry does not automatically resend a missed scan or duplicate mutations.

Guided login is a fixed, owner-only state machine. Codex uses the supported
`codex login --device-auth` flow and validates with `codex login status` plus
the provider health signal. Claude uses only the documented fixed
authentication command and bounded manual-code input required by its flow.
The implementation has origin/CSRF checks, fixed executable/argument allow
lists, process/output/time limits, redaction, rate limits and no arbitrary
stdin. Tokens, codes and raw authentication output never enter journals,
backups or UI diagnostics. Expired Claude credentials are cleared only through
an explicit user action, never automatic logout.

## UI and diagnostics

Scan health and the UI expose:

- waiting/queued;
- collecting;
- normalising;
- deduplicating;
- filtering;
- ranking;
- selecting;
- assessing batch X of Y;
- repairing/retrying affected jobs;
- recovering;
- partial;
- abandoned;
- failed; and
- complete.

User-facing audit records show shortened run IDs and sanitised lease-owner
summaries. Full IDs and owner data remain available only in bounded internal
diagnostics.

Each run view may show profile/pipeline versions, recovery count, completed
stages, batch totals, queued overlaps, funnel metrics and terminal reason. It
must not expose credentials, prompts, provider transcripts, raw provider output,
private paths, tracking parameters or full advert content.

## Migration and compatibility

Migration is additive and idempotent.

- Existing scan records remain readable as legacy summaries.
- New run, queue and lease state is private ignored workspace state.
- Existing tracker, reports and scheduled jobs remain unchanged.
- An active legacy lock continues to block until its existing expiry rule is
  satisfied. A safely expired legacy lock may migrate into a recovery event.
- Migration failure leaves old workspace data readable and unchanged.
- Manifest rebuild and queue migration can be rerun.

## Retention and compaction

Scout retains:

- full journals and referenced artifacts for the newest 20 runs and every run
  from the previous 30 days;
- compact terminal summaries for one year; and
- all active, queued, partial, failed, unrepaired or recovery-referenced runs
  regardless of age.

Compaction is fenced and journalled. It writes new derived artifacts atomically
before removing eligible old derived artifacts. It never rewrites the
authoritative events of a retained run.

Credentials, transient tracking data, full prompts, provider transcripts,
unnecessary raw provider content and full advert bodies are never journalled.
Release and privacy audits verify that raw run state is excluded from public
artifacts.

Storage-pressure thresholds account separately for retained runs, artifacts
and the queue journal. Scout warns before storage becomes operationally unsafe
and identifies which records are recovery-critical. It never automatically
deletes active, queued, partial, failed, unrepaired or recovery-referenced
state. A reviewed archival/cleanup operation may first validate and atomically
write an encrypted archive plus compact terminal index, then remove only the
explicitly selected eligible source data under the retention fence. Queue
compaction preserves every live request and the terminal evidence required by
the retention policy. If safe cleanup cannot free enough space, new durable
work fails closed with a visible storage-pressure reason instead of accepting
work it cannot journal.

## Acceptance and fault injection

Tests cover:

- simultaneous process acquisition;
- heartbeat versus takeover;
- stale-worker append, batch completion and mutation after takeover;
- process death during renewal and every pipeline phase;
- independent heartbeat during a timed provider call;
- machine restart, PID reuse and wall-clock changes;
- genuinely truncated final journal append, complete final-entry hash
  corruption, and earlier-entry corruption;
- manifest disagreement and rebuild;
- unsupported journal/artifact schemas;
- newest-compatible recovery selection and recorded incompatibility reasons;
- completed batch non-repetition;
- partial batch results, focused repair, per-job retry and exhaustion;
- explicit provider substitution provenance;
- crash before and after tracker/report atomic replacement and receipt;
- queue deduplication, expiry, staleness, supersession and automatic draining;
- terminal lease with failed lease-file removal;
- retention, compaction and privacy bounds;
- storage-pressure warnings, protected recovery-critical records, reviewed
  archive/cleanup and queue-journal compaction;
- safe disjoint backup resolution;
- refused overlapping, dirty, renamed, deleted and stale-token divergence;
- backup resolution racing scan mutation;
- every visible run state in browser acceptance;
- canonical character timing, reduced motion and 44px/112px alignment (#72);
- fresh/default/stale/custom provider model choices (#73);
- both usage/options completion orders and stale chat responses (#74);
- supported, unavailable, failed and remote Codex deep-link paths (#75);
- every provider-health transition, secure guided login, blocked scheduled
  scans, deduplicated alerts and retry behaviour (#76);
- legacy workspace migration and rollback safety; and
- full unit, integration, browser, packaging and release audits.

The milestone is complete only when stale processes cannot commit, completed
batches cannot repeat, valid work survives interruption, ambiguous mutations
fail closed, queue behaviour is durable and bounded, and all public UI claims
match persisted run evidence.
