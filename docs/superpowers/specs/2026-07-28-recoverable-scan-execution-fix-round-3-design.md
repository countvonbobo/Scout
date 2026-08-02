# Recoverable Scan Execution Fix Round 3 Design

## Scope

Close the four findings in `task-6-re-review-2.md` without implementing Task
8's full mutation coordinator or crash-idempotent tracker/report receipt
protocol. Existing run, artifact, and queue schemas remain additively readable.

## Bounded asynchronous fenced backup

The scan-owned backup path uses asynchronous child processes with a fixed
timeout and bounded output. This leaves the Node event loop available to renew
the scan lease while Git fetch, merge, commit, and push operations run.
Setup, restore, and other non-scan callers may retain their existing
synchronous helpers.

`runWorkspaceSync` accepts a scan-supplied fence assertion. It checks that
fence immediately before and after every local or external mutation, including
index changes, recovery-backup writes/restores, commits, merges, and pushes.
The production scan hook also checks before entering and after returning from
the sync call. A stale owner cannot begin another mutation.

Every child process has a default 30-second deadline. Timeout or transport
failure becomes a normal bounded sync status; raw command output does not
enter run or queue state.

## Explicit post-success and queue outcomes

The post-success hook returns one exact result:

- `{ status: "complete" }`;
- `{ status: "pending", reason: <bounded reason> }`; or
- `{ status: "partial", reason: <bounded reason> }`.

`synced` and local-only `disabled` sync results are complete.
`offline` or any result with `pending: true` is pending. `needs-attention`
without pending work is partial. Thrown or timed-out backup remains pending.

The scan stays terminally complete. Its bounded failure is `backup-pending` or
`backup-partial`. Queued scans preserve this distinction as
`succeeded-pending` or `succeeded-partial`; neither is collapsed to
`succeeded`. Both are logically successful for same-window scheduling
coverage because discovery and tracker/report mutation completed.

A malformed receipt envelope is handled like a missing receipt: the scan
completes, backup is not called, and a bounded
`mutation-receipt-invalid` pending reason is returned. It never changes the
run to failed.

## Privacy-safe exact semantic evidence

Semantic evidence uses ordered bounded clauses instead of a stopword bag.
Normalization preserves word order and operators such as `non`, `not`,
`without`, and `except`. Every non-empty description can contribute a bounded
responsibility clause; evidence is not gated by a narrow verb list.

Credential-shaped input is classified before normalization. Assignments to
password, token, secret, key, session, cookie, authorization, and credential
labels; bearer/basic authorization payloads; JWT-like strings; and URL
userinfo are replaced by a fixed `sensitive requirement redacted` fact. The
label and its value are removed together, so values such as `hunter2` cannot
survive after their label is stripped.

Facts remain deliberately bounded and are stored only in fixed semantic
fields. Complete advert and requirement sentences remain excluded.

## Transient and durable stage values

Fresh stage execution keeps two values:

- the executed in-memory value, which retains query-bearing source URLs and
  is passed to the next stage and finalizer; and
- the encoded/decoded durable projection, whose URLs contain only origin and
  path and which is written to the artifact.

Recovered stages necessarily resume from their sanitized durable projection.
No raw URL is added to the journal, artifact, manifest, scan-input bundle, or
public result. Fresh liveness, deduplication, and selection therefore retain
their original query-sensitive semantics without weakening durable privacy.

## Verification

Each production behavior receives a focused test that is observed failing
before implementation. Verification then runs the affected suites, the full
Node suite, the release/privacy audit, syntax checks, and `git diff --check`.
