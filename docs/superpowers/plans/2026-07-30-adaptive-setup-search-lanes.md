# Gate B Adaptive Setup and Search Lanes Plan

## Baseline

- Stack from exact Gate A candidate
  `22f8a5d78692c9d3cb94ad742f539ea31f4121cc`.
- Keep PR #82 draft and unchanged.
- Use a focused Gate B branch and draft PR.
- Preserve the issue #77 cross-gate interfaces and private-workspace boundary.

## 1. Adaptive structured setup

- [ ] Add RED tests for ordered universal questions, bounded specialist
  follow-ups, neutral occupation interpolation and strict answer shapes.
- [ ] Add a pure adaptive-questionnaire module.
- [ ] Apply answers only to a complete search-profile draft with explicit
  provenance.
- [ ] Add revision-bound API routes and a review/edit UI.
- [ ] Verify hard-exclusion confirmation remains unchanged.

## 2. Deterministic lane generation

- [ ] Add RED tests for title, location, industry, skill, remote-policy,
  employer and exploration provenance.
- [ ] Add the versioned private lane-plan schema and strict validation.
- [ ] Generate linear-bounded lanes with stable IDs and recorded omissions.
- [ ] Merge exact duplicates and record high-similarity overlaps.
- [ ] Validate the six Gate A profile fixtures.

## 3. Fair selection and lifecycle

- [ ] Add RED tests showing reversed input order cannot starve a lane.
- [ ] Select deterministic shares across core, relevant and exploration bands.
- [ ] Persist bounded per-lane run and failure history.
- [ ] Add explicit repeated-unproductive retirement and lossless restoration.
- [ ] Reconcile publication by preserving unaffected lane IDs/history and
  archiving removed-rule lanes.

## 4. Collection and canonical provenance

- [ ] Replace legacy category queries with selected active lanes after a plan
  exists.
- [ ] Retain all matching lane IDs on deduplicated source records.
- [ ] Preserve lane IDs through observation normalisation and canonical dedupe.
- [ ] Record the selected lane/query contract in the durable collection
  artifact.

## 5. Fenced metrics

- [ ] Derive returned, parsed, new, eligible, selected and promising counts
  from persisted scan-stage evidence.
- [ ] Add the lane-plan update to the existing final fenced mutation.
- [ ] Make lane history idempotent by run ID and recovery-safe.
- [ ] Expose bounded lane status/history through a private API and UI.

## 6. Documentation and verification

- [ ] Document adaptive setup, lane generation, rotation, retirement and
  compatibility behavior.
- [ ] Run focused RED→GREEN suites.
- [ ] Run the complete Node suite and affected Chromium/Firefox acceptance.
- [ ] Build and audit the real release stage.
- [ ] Fast-forward push normally and require every CI job to pass.
- [ ] Post exact-SHA Gate B evidence to the stacked draft PR and Epic #77.
