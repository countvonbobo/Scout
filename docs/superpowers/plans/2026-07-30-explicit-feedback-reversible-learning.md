# Gate D Explicit Feedback and Reversible Learning Plan

## Baseline

- Continue draft PR #82 and its existing branch from exact green Gate C head
  `95c8437039f622cee59e8627faf424584f94af13`.
- Preserve Gate A ranking/recovery, Gate B profile/lane and Gate C fenced
  mutation interfaces.

## 1. Private feedback ledger

- [x] Capture RED for the absent feedback-learning domain.
- [x] Add strict bounded job feedback, proposals and immutable versions.
- [x] Cover every required decision and rejection reason.
- [x] Preserve original profile and learning versions.

## 2. Reviewable learning

- [x] Keep feedback separate from tracker status and active policy.
- [x] Require a separate inspectable proposal.
- [x] Require exact revision and confirmation to publish.
- [x] Prevent learned hard exclusions and bound transparent weights.
- [x] Append reversible versions and retain undo history.

## 3. Deterministic scan behavior

- [x] Apply explicit contributions after base profile ranking.
- [x] Include learning version in queue/ranking compatibility.
- [x] Reconsider exact rule exclusions only in confirmed scope.
- [x] Retain reusable prior assessments and assess newly reconsidered work.
- [x] Persist profile/learning provenance in review and tracker history.

## 4. API, UI and backup

- [x] Add revision-bound feedback, proposal, publication and undo APIs.
- [x] Expose explicit job feedback without implicit status mutation.
- [x] Expose active changes, pending proposals, versions and undo in Settings.
- [x] Include the private ledger in marker-clean private backup.

## 5. Verification and handoff

- [x] Run the complete focused domain, pipeline, server and browser matrix.
- [x] Run complete Node and browser suites.
- [x] Build and audit a fresh release stage.
- [ ] Commit and fast-forward push normally.
- [ ] Require all seven CI jobs to pass.
- [ ] Post exact-SHA evidence without changing draft or issue state.
