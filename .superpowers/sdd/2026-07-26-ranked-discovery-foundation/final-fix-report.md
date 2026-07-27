# Ranked discovery final fix report

## Scope

Holistic regression-first fix round for the seven Important findings raised
against the ranked discovery foundation at base `3134e74`.

## Baseline

Command:

```powershell
npm.cmd test
```

Result before fixes:

```text
tests 640
pass 638
fail 0
skipped 2
duration_ms 36972.5813
```

The two skips are the repository's documented platform checks.

## RED

Command:

```powershell
node --test tools/scout.test.mjs ui/server.test.mjs ui/lib/vacancyFilter.test.mjs ui/lib/vacancyObservation.test.mjs ui/lib/adzuna.test.mjs ui/lib/hiringCafe.test.mjs ui/lib/discoveryFunnel.test.mjs ui/lib/scanPipeline.test.mjs
```

Observed result:

```text
tests 120
pass 103
fail 17
```

The expected regression failures demonstrated:

1. scan readiness did not stage `migrateSearchProfile`, a fresh workspace was
   not blocked pending publication, and setup status exposed no review draft;
2. an `unconfirmed-inference` mandatory rule excluded a vacancy;
3. one matching value did not satisfy a field with multiple mandatory
   alternatives;
4. threshold `0` selected unrelated zero-score vacancies and padded the
   runtime assessment set to 60;
5. adapters and observation normalisation dropped `rateType`, end-to-end
   comparable compensation stayed `unknown`, and `exclude` accepted supplied
   incompatible compensation;
6. source errors were subtracted as failed records, causing incorrect and
   potentially negative observation counts;
7. persisted hard-exclusion accounting reported two discarded vacancies for
   one vacancy matching two rules, although both explanations were retained.

After correcting the readiness fixture's provider configuration, the dedicated
RED command remained correctly failing:

```powershell
node --test --test-name-pattern="fresh scan readiness|grandfathered established" tools/scout.test.mjs
```

```text
tests 2
pass 0
fail 2
```

The fresh-workspace regression failed with `Missing expected exception`; the
grandfathered-workspace regression failed because no draft was staged.

An additional workspace-safety RED test then proved that the initial readiness
hook staged a draft before setup evidence and approval were complete:

```powershell
node --test --test-name-pattern="incomplete scan readiness" tools/scout.test.mjs
```

```text
tests 1
pass 0
fail 1
```

The setup-status route reproduced the same premature-staging failure before the
server hook was tightened.

## GREEN

Command:

```powershell
node --test tools/scout.test.mjs ui/server.test.mjs ui/lib/searchProfile.test.mjs ui/lib/vacancyFilter.test.mjs ui/lib/vacancyObservation.test.mjs ui/lib/adzuna.test.mjs ui/lib/hiringCafe.test.mjs ui/lib/discoveryFunnel.test.mjs ui/lib/vacancyRank.test.mjs ui/lib/scanPipeline.test.mjs ui/lib/rankedDiscovery.acceptance.test.mjs
```

Observed result:

```text
tests 144
pass 144
fail 0
skipped 0
duration_ms 17675.2557
```

The green implementation:

- stages legacy preferences as an unpublished review draft from server startup,
  setup-status/profile reads and scan readiness only after preferences,
  evidence and approval are complete, so incomplete setup cannot freeze a
  premature migration draft;
- blocks only fresh workspaces without a published profile while preserving the
  explicit established-workspace legacy path;
- makes unconfirmed mandatory inferences non-blocking and evaluates accepted
  mandatory values as alternatives;
- applies the configured triage check score at runtime (with a positive
  profile-boundary fallback) so zero-score vacancies are never padding;
- preserves explicit provider rate types and uses one conservative compensation
  comparator for ranking and filtering;
- separates source errors from failed returned records and reconciles returned,
  parsed, normalised, duplicate and unique counts without subtraction;
- counts unique deterministically excluded vacancy IDs while retaining all rule
  explanations.

The source-error accounting was then exercised through the public scan-health
and latest-scan projections, not only the internal funnel.

RED commands:

```powershell
node --test --test-name-pattern="scan health exposes reconciled|latest scan API exposes reconciled" ui/lib/scanHealth.test.mjs ui/server.test.mjs
node --test --test-name-pattern="scan health labels distinguish" ui/app.config.test.mjs
```

Observed results:

```text
tests 2
pass 0
fail 2

tests 1
pass 0
fail 1
```

The projections omitted both `sourceErrors` and `failedSourceRecords`, and the
UI omitted their truthful labels.

GREEN command:

```powershell
node --test --test-name-pattern="scan health exposes reconciled|latest scan API exposes reconciled|scan health labels distinguish" ui/lib/scanHealth.test.mjs ui/server.test.mjs ui/app.config.test.mjs
```

```text
tests 3
pass 3
fail 0
```

## Review

The fresh scoped review of the complete `3134e74..afea87e` delta found no
Critical issues and one Important failure-path gap: a provider assessment
failure retained the unique deterministic-exclusion count but omitted both the
published `profile_id` and the individual rule explanations.

The fix was regression-first. The existing failed-ranked-scan test was expanded
with one vacancy matching two deterministic rules. RED demonstrated a null
`profile_id`; GREEN now verifies the published profile identity, one unique
discarded vacancy, and both exclusion explanations. The focused verification
was:

```text
tests 45
pass 45
fail 0
```

The reviewer then re-reviewed the entire `3134e74..87a6d05` delta and reported:

```text
No Critical/Important findings.
Overall verdict: approved for merge.
```

## Final verification

Commands:

```powershell
npm.cmd test
npm.cmd run release:audit
git diff --check
```

Results:

```text
tests 650
pass 648
fail 0
skipped 2
duration_ms 40209.0866

Release audit scanned 195 files with 0 configured personal markers.
Release audit passed.

git diff --check: passed
```

The two skips are the unchanged documented platform checks.
