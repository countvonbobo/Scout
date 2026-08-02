# Recoverable Scan Execution Fix Round 2 Design

## Scope

Resolve the five remaining Task 6 review findings without implementing Task
7 assessment receipts or Task 8's complete crash-idempotent mutation protocol.
Historical journal, queue, artifact, and compatibility schemas remain
additively readable.

## Receipt-gated fenced backup

`runScanPipeline` receives a narrow post-success hook. It runs only after a
complete terminal journal and only when the finalizer returns a valid bounded
mutation receipt proving that tracker/report mutation succeeded. The heartbeat
and current scan fence remain live while the hook awaits backup. A claimed
queued run uses the same path, so every successful mutation can request its own
checkpoint; overlap losers never enter it.

The receipt is deliberately narrow: a schema version, mutation kind, and
SHA-256 digest. Task 8 will replace the current mutation implementation with
the complete durable receipt protocol. No receipt means no backup. Backup
failure does not change the successful scan outcome; it adds a bounded
`backup-pending` failure/status to the public durable result.

## Canonical durable URLs

Durable source references retain only an HTTP(S) origin and pathname. The
sanitizer removes user-info, fragment, and the complete query string. Provider
IDs remain separate structured identity fields. Query-bearing source URLs are
transient fetch inputs and never durable artifact or scan-input values.

## Assessment-ready semantic evidence

Complete in-memory adverts are reduced before persistence into exact structured
facts:

- whether description evidence was present;
- the full-description digest and length;
- matched published rule identifiers plus bounded normalized rule facts; and
- mandatory-signal identifiers, full-signal digests, kinds, and bounded
  normalized requirement facts.

Facts are normalized tokens selected from the complete source text, not
verbatim sentences, complete requirements, or opaque hashes. Candidate
conversion provides these facts to the existing assessment call. An empty
description stays `unknown` for ranking confidence rather than becoming a
known non-match.

## Claim-bound terminal compatibility

Claim verification continues to re-read current config, profile, and tracker.
Terminal verification compares the terminal manifest compatibility to the
request's recorded execution fingerprint. It does not re-read the tracker
after the queued run's own keeper mutation, so authorized output cannot stale
its input claim.

## Direct scheduled-window coverage

After a directly executing scheduled run has a complete terminal journal and
before it releases its lease, it appends `window-covered` for queued requests
with the same schedule ID, logical-window ID, purpose, and execution
compatibility fingerprint. The covered overlap is skipped and never reruns
collection. The queue transition is fenced and durable before backup.

## Failure behavior

- Missing/malformed receipt: successful run, no backup, bounded
  `backup-pending` durable status.
- Backup exception: successful run, bounded `backup-pending` durable status;
  raw exception text is not persisted.
- Lease loss during the success hook: stop mutation authority and preserve the
  journal truth already committed; the caller receives bounded failure state.
- Coverage mismatch: leave the request queued for ordinary compatibility and
  claim processing.

## Verification

Each finding gets a focused failing test observed before production changes.
Then run all affected files, the full Node test suite, release/privacy audit,
syntax checks, and `git diff --check`.
