# Explicit Feedback and Reversible Learning Design

## Baseline and boundary

This Gate D design stacks on exact all-green Gate C head
`95c8437039f622cee59e8627faf424584f94af13` in draft PR #82.
The operator required the existing branch and PR to continue, so no additional
branch or PR is created.

Feedback is private workspace data, not tracker status and not provider output.
Recording a reaction must never silently shortlist, dismiss, apply, exclude or
change ranking. Learned behavior begins only when a separate proposal is
reviewed and explicitly published.

## Private ledger

`data/feedback-learning.json` is a strict schema-v1 document with:

- bounded job-scoped feedback events;
- bounded pending/published proposal history;
- immutable published learning versions;
- one explicit active version;
- generation, update time and content revision.

Every feedback event records its job and canonical vacancy identity, decision,
reason, explanation, timestamp, and the profile and learning versions that
governed the original decision. Required decisions are applied, interview,
promising, saved, rejected, not interested, duplicate and already seen.
Rejection reasons include location, salary, seniority, responsibilities,
employer and role family.

The ledger fails closed on malformed, future or over-capacity data. It does not
discard referenced events, proposals or versions to make room.

## Transparent changes

A proposal cites one or more feedback events and contains one bounded change:

- a signed integer rank adjustment from -10 to +10 for an explicit field/value
  match; or
- reconsideration of one exact published profile rule in an explicit role
  family, employer or profile-wide scope.

The active cumulative adjustment is capped at ±20 points. Contributions retain
field, match value, weight, scope, explicit employer or role-family scope value
where applicable and source proposal ID. Learned changes cannot
create a hard exclusion. One rejection therefore creates no rule at all unless
the user separately proposes, reviews and publishes a bounded change.

Confirmed reconsideration makes matching rule-excluded vacancies eligible for
ranking while preserving the original exclusion evidence and learning version.
It does not delete or rewrite the published profile.

## Publication, ranking and recovery

Publishing requires the current ledger revision, exact pending proposal ID and
explicit confirmation under the existing fenced workspace mutation authority.
It appends an immutable version whose parent is the prior active version.

The active learning ID participates in scan queue and ranking compatibility.
Changing it invalidates stale rank artifacts, but unchanged prior assessment
decisions remain reusable. Unassessed jobs rerank deterministically; a
reconsidered job can enter assessment because no prior assessment exists.

Tracker entries and scan-review records retain profile and learning IDs plus a
bounded ranking history. Historical feedback events remain bound to their
original versions.

Undo requires exact active version, explanation, current revision and explicit
confirmation. It appends a new version with the prior parent's changes. No
history is erased, and reranking restores the prior published behavior.

## User interface and privacy

Every job exposes an explicit feedback action. The action asks for decision,
reason and explanation and states that ranking did not change.

Settings exposes:

- active changes and exact weights;
- recent job-only feedback;
- pending proposals and their source events;
- proposal creation;
- confirmed publication;
- immutable version history; and
- confirmed undo.

The ledger remains in the private workspace and private backup. It is excluded
from public release data and is never sent to an assessment provider as a raw
history. The provider receives only the selected job after deterministic
filtering, ranking and selection.

## Failure behavior

- stale revisions return conflict without mutation;
- scan or workspace mutation contention returns conflict;
- malformed events, unsupported fields, zero/out-of-range weights and missing
  explanations fail closed;
- failed writes leave the prior ledger active;
- a feedback write never partially changes tracker status; and
- publication and undo never run without exact confirmation.
