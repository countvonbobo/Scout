# Gate C Employer Registry and Careers Monitoring Plan

## Baseline

- Stack from exact all-green Gate B head
  `23aa145080ce2a786b0c8c3613ec5f7c3b479def`.
- Continue existing draft PR #82 and its current branch.
- Do not create another branch or PR.
- Preserve Gate A ranked-discovery and Gate B lane/fenced-mutation interfaces.

## 1. Versioned employer registry

- [x] Add RED tests for strict schema, stable identity and ambiguous merges.
- [x] Implement bounded origins, aliases, board/careers facts, explicit
  priority/decisions, access policy, health and history.
- [x] Reconcile named-profile, advert, research and manual discoveries without
  overwriting user state.
- [x] Project legacy ATS portals as conservative migration evidence.
- [x] Add atomic load/write and revision-bound API behavior.

## 2. Fair monitoring plan

- [x] Add RED tests proving input order cannot starve employers.
- [x] Select all eligible priority employers, rotate relevant/normal employers
  and validate inactive employers less often.
- [x] Enforce per-scan and per-band bounds plus per-employer rate eligibility.
- [x] Freeze and persist the exact employer/adapter contract at scan start.

## 3. Common adapter contract

- [x] Refactor Greenhouse, Lever and Ashby behind a bounded common result.
- [x] Attach Adzuna and hiring.cafe employer discoveries after canonical
  vacancy normalization.
- [x] Validate `JobPosting` JSON-LD with canonical advert links.
- [x] Add conservative opt-in generic careers-link extraction.
- [x] Fail closed for robots, terms, rate limits, authentication, anti-bot and
  JavaScript-only pages without bypass behavior.

## 4. Durable health and discovery

- [x] Record per-employer/source checked/healthy/degraded/blocked/unsupported
  outcomes with bounded reason codes.
- [x] Reconcile newly discovered employers without automatic priority changes.
- [x] Commit registry history through the existing prepared fenced final
  mutation and make it idempotent by run ID.
- [x] Add interrupted-finalisation, source-isolation and backup marker tests.

## 5. Review UI and documentation

- [x] Expose bounded registry identity, origins, monitoring facts, decisions,
  safeguards, health and recent checks in Settings.
- [x] Require current revision and explicit confirmation for destructive or
  suppressive changes.
- [x] Document adapter support, migration, safe degradation and the
  no-assessment-model monitoring boundary.

## 6. Verification and handoff

- [x] Run focused RED→GREEN registry, adapter, pipeline, API and browser tests.
- [x] Run complete `npm test` and affected Chromium/Firefox acceptance.
- [x] Build and audit a fresh real release stage.
- [ ] Commit and fast-forward push normally.
- [ ] Require all seven CI jobs to pass.
- [ ] Post exact-SHA evidence to draft PR #82 and Epic #77 without changing
  issue checkboxes.
