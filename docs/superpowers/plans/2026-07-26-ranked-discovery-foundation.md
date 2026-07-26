# Ranked Discovery Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Scout evaluate and deterministically rank every successfully normalised unique vacancy before selecting the bounded set sent to Claude or Codex.

**Architecture:** Add immutable published search-profile, source-observation, canonical-vacancy, deterministic-decision, pre-rank and selection-result contracts in focused modules. Keep the existing source adapters and assessment writer, but replace `compactCandidates()` as the pre-assessment boundary with a pipeline that normalises all observations, canonicalises duplicates, applies confirmed rules, ranks the complete eligible pool and then diversifies the final selection. Persist a reconciled funnel and explanations into existing scan artifacts.

**Tech Stack:** Node.js ES modules, built-in `node:test`, JSON workspace files, existing atomic file utilities, existing Greenhouse/Lever/Ashby/hiring.cafe/Adzuna adapters, existing tracker/report pipeline.

## Global Constraints

- Shared discovery code contains no occupation-, country-, currency-, location-, sector- or user-specific defaults.
- Raw setup evidence is preserved; only an explicitly published immutable profile version drives new scans.
- AI-inferred values never become hard exclusions without explicit confirmation.
- Unknown source facts remain unknown and follow the profile's configured unknown-value policy.
- Every successfully normalised unique vacancy is deterministically evaluated before the 60-candidate assessment cutoff.
- Identical observations, profile version and configuration produce identical ranks and selection.
- Existing tracker state, reports, contacts, notes, applications and source URLs remain intact.
- Source failures remain isolated and private workspace data never enters the public repository.
- Use test-driven development and commit after every independently testable task.

---

## Planned File Structure

- `ui/lib/searchProfile.mjs`: validate, publish, hash and load immutable structured search profiles.
- `ui/lib/searchProfile.test.mjs`: generic profile, provenance, strength and migration tests.
- `ui/lib/vacancyObservation.mjs`: source-independent observation normalisation and field provenance.
- `ui/lib/vacancyObservation.test.mjs`: adapter-neutral normalisation fixtures.
- `ui/lib/vacancyCanonical.mjs`: deterministic canonical grouping and material fingerprinting.
- `ui/lib/vacancyCanonical.test.mjs`: cross-source duplicate, repost and changed-advert tests.
- `ui/lib/vacancyFilter.mjs`: confirmed-rule filtering with evidence and uncertainty.
- `ui/lib/vacancyFilter.test.mjs`: exclusion, unknown-policy and override tests.
- `ui/lib/vacancyRank.mjs`: dimension-level deterministic pre-ranking.
- `ui/lib/vacancyRank.test.mjs`: order independence, weights, confidence and compensation tests.
- `ui/lib/vacancySelect.mjs`: deterministic soft-diversity candidate selection.
- `ui/lib/vacancySelect.test.mjs`: starvation, dominance, relaxation and exploration tests.
- `ui/lib/discoveryFunnel.mjs`: reconciled counters and invariant validation.
- `ui/lib/discoveryFunnel.test.mjs`: mathematical reconciliation tests.
- `ui/lib/scanPipeline.mjs`: assessment-boundary integration and artifact explanations.
- `tools/scout.mjs`: orchestration of the new deterministic stages.
- `ui/lib/workspace.mjs`: additive profile schema migration and profile paths.
- `ui/setup.js` and `ui/server.mjs`: publish/review API and minimum profile-review UI.
- `templates/workspace/workspace.json`: generic schema defaults only.

### Task 1: Lock the discovery funnel and starvation regressions

**Files:**
- Create: `ui/lib/discoveryFunnel.mjs`
- Create: `ui/lib/discoveryFunnel.test.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`

**Interfaces:**
- Produces: `createDiscoveryFunnel(sourceResults) -> DiscoveryFunnel`
- Produces: `advanceDiscoveryFunnel(funnel, stage, counts) -> DiscoveryFunnel`
- Produces: `assertDiscoveryFunnel(funnel) -> DiscoveryFunnel`
- `DiscoveryFunnel` has `sourceRecords`, `failedSourceRecords`, `parsed`, `normalised`, `duplicateObservations`, `uniqueVacancies`, `deterministicallyExcluded`, `eligible`, `ranked`, `aboveThreshold`, `selected`, `assessed`, `assessmentFailed`, `added`, `updated`, `unchanged`, `closed`, plus `bySource`.

- [ ] **Step 1: Write failing reconciliation and source-order tests**

```js
test('funnel reconciles every observation before assessment selection', () => {
  const funnel = createDiscoveryFunnel({
    ats: { count: 100, errors: [] },
    hiring_cafe: { count: 30, errors: ['one malformed row'] },
  });
  const complete = advanceDiscoveryFunnel(funnel, 'selection', {
    parsed: 129, normalised: 128, duplicateObservations: 8,
    uniqueVacancies: 120, deterministicallyExcluded: 20,
    eligible: 100, ranked: 100, aboveThreshold: 75, selected: 60,
  });
  assert.equal(assertDiscoveryFunnel(complete).selected, 60);
});

test('candidate fixture proves source order cannot define the final selection', () => {
  const forward = compactCandidates(sourceFixture(['ats-a', 'ats-b']), 2);
  const reverse = compactCandidates(sourceFixture(['ats-b', 'ats-a']), 2);
  assert.notDeepEqual(forward.candidates.map((item) => item.url), reverse.candidates.map((item) => item.url));
});
```

- [ ] **Step 2: Run tests and verify the new contract test fails**

Run: `node --test ui/lib/discoveryFunnel.test.mjs ui/lib/scanPipeline.test.mjs`

Expected: FAIL because `discoveryFunnel.mjs` does not exist; the regression demonstrates the current source-order dependence.

- [ ] **Step 3: Implement the immutable funnel and invariant checks**

```js
const STAGES = Object.freeze([
  'sourceRecords', 'failedSourceRecords', 'parsed', 'normalised',
  'duplicateObservations', 'uniqueVacancies', 'deterministicallyExcluded',
  'eligible', 'ranked', 'aboveThreshold', 'selected', 'assessed',
  'assessmentFailed', 'added', 'updated', 'unchanged', 'closed',
]);

export function advanceDiscoveryFunnel(funnel, _stage, counts = {}) {
  const next = structuredClone(funnel);
  for (const key of STAGES) {
    if (counts[key] !== undefined) next[key] = Number(counts[key]);
  }
  return next;
}

export function assertDiscoveryFunnel(value) {
  if (value.normalised !== value.duplicateObservations + value.uniqueVacancies) {
    throw new Error('normalised must equal duplicate observations plus unique vacancies');
  }
  if (value.uniqueVacancies !== value.deterministicallyExcluded + value.eligible) {
    throw new Error('unique vacancies must equal excluded plus eligible');
  }
  if (value.ranked !== value.eligible) throw new Error('every eligible vacancy must be ranked');
  if (value.selected > value.aboveThreshold || value.assessed > value.selected) {
    throw new Error('assessment funnel is inconsistent');
  }
  return value;
}
```

- [ ] **Step 4: Run focused tests**

Run: `node --test ui/lib/discoveryFunnel.test.mjs ui/lib/scanPipeline.test.mjs`

Expected: PASS for funnel tests; the source-order regression remains documented as the behaviour later tasks must reverse.

- [ ] **Step 5: Commit**

```bash
git add ui/lib/discoveryFunnel.mjs ui/lib/discoveryFunnel.test.mjs ui/lib/scanPipeline.test.mjs
git commit -m "test: define ranked discovery funnel"
```

### Task 2: Add the immutable published search-profile contract

**Files:**
- Create: `ui/lib/searchProfile.mjs`
- Create: `ui/lib/searchProfile.test.mjs`
- Modify: `ui/lib/workspace.mjs`
- Modify: `ui/lib/workspace.test.mjs`
- Modify: `templates/workspace/workspace.json`

**Interfaces:**
- Produces: `validateSearchProfile(profile) -> SearchProfile`
- Produces: `profileFingerprint(profile) -> sha256 hex string`
- Produces: `draftProfileFromLegacy(config, context) -> SearchProfileDraft`
- Produces: `publishSearchProfile(draft, { publishedAt }) -> SearchProfile`
- Produces: `loadPublishedSearchProfile(root) -> SearchProfile | null`
- Adds `workspacePaths(root).searchProfileRaw`, `.searchProfileDraft`, `.searchProfilePublished`.

- [ ] **Step 1: Write failing profession-neutral profile tests**

```js
test('published profile preserves strengths, provenance and unknown policies', () => {
  const draft = genericProfileDraft({
    primaryTitles: [{ value: 'Commercial solicitor', strength: 'mandatory', provenance: 'explicit' }],
    compensation: { currency: 'EUR', period: 'day', minimum: 450, minimumStrength: 'strong-preference', unknownPolicy: 'include' },
  });
  const profile = publishSearchProfile(draft, { publishedAt: '2026-07-26T20:00:00.000Z' });
  assert.equal(profile.version, 1);
  assert.equal(profile.target.primaryTitles[0].provenance, 'explicit');
  assert.equal(profile.compensation.period, 'day');
  assert.equal(profile.compensation.unknownPolicy, 'include');
  assert.match(profile.id, /^profile-[a-f0-9]{12}$/);
});

test('unconfirmed inference cannot publish as a hard exclusion', () => {
  const draft = genericProfileDraft({
    excludedTitles: [{ value: 'Manager', strength: 'hard-exclusion', provenance: 'unconfirmed-inference' }],
  });
  assert.throws(() => publishSearchProfile(draft, { publishedAt: NOW }), /hard exclusion.*confirmation/i);
});
```

- [ ] **Step 2: Run the profile tests**

Run: `node --test ui/lib/searchProfile.test.mjs ui/lib/workspace.test.mjs`

Expected: FAIL because the profile contract and profile paths do not exist.

- [ ] **Step 3: Implement enums, validation, canonical JSON hashing and publication**

```js
export const PREFERENCE_STRENGTHS = Object.freeze([
  'mandatory', 'strong-preference', 'nice-to-have',
  'neutral', 'strong-negative', 'hard-exclusion',
]);
export const PROVENANCE = Object.freeze([
  'explicit', 'deterministic-derivation', 'confirmed-inference', 'unconfirmed-inference',
]);
export const UNKNOWN_POLICIES = Object.freeze(['include', 'penalise', 'exclude']);

export function publishSearchProfile(draft, { publishedAt = new Date().toISOString() } = {}) {
  const validated = validateSearchProfile({ ...structuredClone(draft), status: 'published', publishedAt });
  const fingerprint = profileFingerprint({ ...validated, id: undefined });
  return Object.freeze({ ...validated, id: `profile-${fingerprint.slice(0, 12)}` });
}
```

Store profile artifacts under `profile/search/raw.json`, `profile/search/draft.json`, and `profile/search/published.json`. Raw answers are append-only evidence; publishing atomically replaces only the draft/published profile artifacts.

- [ ] **Step 4: Add additive workspace path/default support**

Keep `workspace.json` schema-compatible. Add only:

```json
{
  "searchProfile": {
    "publishedId": null,
    "schemaVersion": 1
  }
}
```

Do not place user-specific titles, currency, countries, thresholds or sectors in shared defaults.

- [ ] **Step 5: Run focused tests**

Run: `node --test ui/lib/searchProfile.test.mjs ui/lib/workspace.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/searchProfile.mjs ui/lib/searchProfile.test.mjs ui/lib/workspace.mjs ui/lib/workspace.test.mjs templates/workspace/workspace.json
git commit -m "feat: add published search profile contract"
```

### Task 3: Migrate legacy workspace preferences into a reviewable draft

**Files:**
- Modify: `ui/lib/searchProfile.mjs`
- Modify: `ui/lib/searchProfile.test.mjs`
- Modify: `ui/lib/workspace.mjs`
- Modify: `ui/lib/workspace.test.mjs`

**Interfaces:**
- Consumes: `draftProfileFromLegacy(config, context)`
- Produces: `migrateSearchProfile(root) -> { migrated, draftPath, backupPath }`

- [ ] **Step 1: Write failing migration tests**

```js
test('legacy migration creates a draft without publishing inferred exclusions', () => {
  const draft = draftProfileFromLegacy({
    locale: 'en-GB', currency: 'GBP',
    search: {
      roleFamilies: ['Hardware Engineer'],
      locations: ['Reading'],
      exclusions: ['Pure software roles'],
      salaryMinimum: 60000,
    },
  }, 'user-authored profile prose');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.target.primaryTitles[0].provenance, 'deterministic-derivation');
  assert.equal(draft.negative.excludedResponsibilities[0].strength, 'strong-negative');
  assert.equal(draft.compensation.minimumStrength, 'strong-preference');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test ui/lib/searchProfile.test.mjs ui/lib/workspace.test.mjs`

Expected: FAIL because legacy migration is absent.

- [ ] **Step 3: Implement conservative mapping**

Map legacy role families and locations to deterministic derivations. Map legacy prose exclusions to `strong-negative`, never `hard-exclusion`. Map salary minimum to `strong-preference` with `unknownPolicy: 'include'`. Preserve the raw legacy JSON and context text byte-for-byte under the raw evidence artifact.

- [ ] **Step 4: Add idempotent migration and backup**

`migrateSearchProfile(root)` must:

1. return unchanged when a published/draft profile already exists;
2. call existing `backupWorkspace(root, 'search-profile-v1')`;
3. atomically write raw evidence and draft;
4. leave `workspace.json.searchProfile.publishedId` null;
5. never modify tracker, reports, applications or profile prose.

- [ ] **Step 5: Run focused migration tests**

Run: `node --test ui/lib/searchProfile.test.mjs ui/lib/workspace.test.mjs`

Expected: PASS, including a second idempotent migration call.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/searchProfile.mjs ui/lib/searchProfile.test.mjs ui/lib/workspace.mjs ui/lib/workspace.test.mjs
git commit -m "feat: stage legacy search profile migration"
```

### Task 4: Add minimum review and publish workflow

**Files:**
- Modify: `ui/server.mjs`
- Modify: `ui/server.test.mjs`
- Modify: `ui/setup.js`
- Modify: `ui/setup.test.mjs`

**Interfaces:**
- `GET /api/search-profile` returns `{ rawPresent, draft, published }`.
- `PUT /api/search-profile/draft` accepts a complete validated draft plus current draft revision.
- `POST /api/search-profile/publish` accepts `{ revision, confirmed: true }`.
- Publishing updates `workspace.json.searchProfile.publishedId` only after the published artifact is atomically written.

- [ ] **Step 1: Write failing route tests**

```js
test('profile publication requires current revision and explicit confirmation', async () => {
  const unconfirmed = await request({
    method: 'POST', path: '/api/search-profile/publish',
    headers: JSON_HEADERS, body: JSON.stringify({ revision: 'r1', confirmed: false }),
  });
  assert.equal(unconfirmed.status, 409);
  const stale = await request({
    method: 'POST', path: '/api/search-profile/publish',
    headers: JSON_HEADERS, body: JSON.stringify({ revision: 'stale', confirmed: true }),
  });
  assert.equal(stale.status, 409);
});
```

- [ ] **Step 2: Run focused tests**

Run: `node --test ui/server.test.mjs ui/setup.test.mjs`

Expected: FAIL because the routes and review UI are absent.

- [ ] **Step 3: Implement bounded same-origin JSON routes**

Reuse the existing request-body, origin, atomic-write and revision patterns. Reject partial patch semantics: the server validates the entire draft so UI and runtime cannot disagree about omitted fields.

- [ ] **Step 4: Add the plain-language review panel**

Render sections for:

- primary and adjacent work;
- mandatory requirements, preferences and confirmed exclusions;
- accepted locations/working patterns;
- compensation and unknown handling;
- focused/balanced/exploratory breadth.

The publish confirmation text must state that unconfirmed inferences remain non-blocking.

- [ ] **Step 5: Run focused tests**

Run: `node --test ui/server.test.mjs ui/setup.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/server.mjs ui/server.test.mjs ui/setup.js ui/setup.test.mjs
git commit -m "feat: review and publish search profiles"
```

### Task 5: Normalise every source record into observations

**Files:**
- Create: `ui/lib/vacancyObservation.mjs`
- Create: `ui/lib/vacancyObservation.test.mjs`
- Modify: `ui/lib/ats.mjs`
- Modify: `ui/lib/hiringCafe.mjs`
- Modify: `ui/lib/adzuna.mjs`
- Modify: corresponding adapter tests

**Interfaces:**
- Produces: `normaliseObservation(job, { sourceName, fetchedAt, laneId }) -> VacancyObservation | null`
- `VacancyObservation` includes stable `observationId`, `source`, `sourceRecordId`, `sourceUrl`, `canonicalUrl`, `employer`, `title`, `description`, structured location/working/employment/seniority/compensation fields, dates, `fieldProvenance`, `warnings`, and `rawFingerprint`.

- [ ] **Step 1: Write failing cross-adapter fixtures**

```js
test('normalisation preserves explicit values and unknowns with provenance', () => {
  const observation = normaliseObservation({
    providerId: 'job-1', title: 'Store Manager', company: 'Acme',
    url: 'https://jobs.example/1?utm_source=board',
    location: '', salary: null, description: 'Permanent full-time role',
  }, { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-1' });
  assert.equal(observation.canonicalUrl, 'https://jobs.example/1');
  assert.equal(observation.location.value, null);
  assert.equal(observation.location.provenance, 'unknown');
  assert.equal(observation.employmentType.value, 'permanent');
  assert.equal(observation.employmentType.provenance, 'deterministic-extraction');
});
```

- [ ] **Step 2: Run adapter-neutral and existing adapter tests**

Run: `node --test ui/lib/vacancyObservation.test.mjs ui/lib/ats.test.mjs ui/lib/hiringCafe.test.mjs ui/lib/adzuna.test.mjs`

Expected: FAIL because observation normalisation is absent.

- [ ] **Step 3: Implement bounded deterministic extraction**

Only extract values supported by explicit source fields or unambiguous phrases. Do not use an AI call. Store ambiguous values as unknown with a warning. Generate `observationId` from source name, source record ID/canonical URL and raw fingerprint.

- [ ] **Step 4: Add stable source record IDs to adapters**

Map Greenhouse/Ashby/Lever/Adzuna provider identifiers where available. hiring.cafe uses its provider hit identifier; if absent, use the canonical URL fingerprint. Preserve current adapter result shapes for diagnostic CLI consumers while adding observation-ready fields.

- [ ] **Step 5: Run focused tests**

Run: `node --test ui/lib/vacancyObservation.test.mjs ui/lib/ats.test.mjs ui/lib/hiringCafe.test.mjs ui/lib/adzuna.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/vacancyObservation.mjs ui/lib/vacancyObservation.test.mjs ui/lib/ats.mjs ui/lib/ats.test.mjs ui/lib/hiringCafe.mjs ui/lib/hiringCafe.test.mjs ui/lib/adzuna.mjs ui/lib/adzuna.test.mjs
git commit -m "feat: normalise source vacancy observations"
```

### Task 6: Canonicalise duplicates and material changes

**Files:**
- Create: `ui/lib/vacancyCanonical.mjs`
- Create: `ui/lib/vacancyCanonical.test.mjs`
- Modify: `ui/lib/jobIdentity.mjs`
- Modify: `ui/lib/jobIdentity.test.mjs`

**Interfaces:**
- Produces: `canonicaliseObservations(observations) -> { vacancies, duplicateObservations }`
- Produces: `vacancyContentFingerprint(vacancy) -> sha256`
- Produces: `classifyVacancyChange(previous, current) -> 'unchanged' | 'minor' | 'material' | 'reopened'`

- [ ] **Step 1: Write failing canonicalisation tests**

```js
test('cross-source copies become one canonical vacancy with all observations', () => {
  const result = canonicaliseObservations([
    observation({ source: 'adzuna', canonicalUrl: DIRECT_URL }),
    observation({ source: 'greenhouse', canonicalUrl: DIRECT_URL }),
  ]);
  assert.equal(result.vacancies.length, 1);
  assert.equal(result.vacancies[0].observations.length, 2);
  assert.equal(result.duplicateObservations, 1);
});

test('salary and location changes are material but tracking copy is not', () => {
  assert.equal(classifyVacancyChange(oldJob, { ...oldJob, description: `${oldJob.description} Apply now.` }), 'minor');
  assert.equal(classifyVacancyChange(oldJob, { ...oldJob, compensation: salary(70000) }), 'material');
});
```

- [ ] **Step 2: Run tests**

Run: `node --test ui/lib/vacancyCanonical.test.mjs ui/lib/jobIdentity.test.mjs`

Expected: FAIL because canonical vacancy grouping is absent.

- [ ] **Step 3: Implement deterministic grouping**

Reuse canonical URL and existing `sameUnderlyingJob()` evidence. Never merge jobs that differ by provider ID, materially different location or materially different seniority. Choose display fields by explicit provenance first, then longer verified content, while retaining every observation.

- [ ] **Step 4: Implement material fingerprints**

Fingerprint normalised title, employer, location, working pattern, employment type, compensation and responsibility-bearing description. Exclude tracking parameters, whitespace, application boilerplate and fetch timestamps.

- [ ] **Step 5: Run tests**

Run: `node --test ui/lib/vacancyCanonical.test.mjs ui/lib/jobIdentity.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/vacancyCanonical.mjs ui/lib/vacancyCanonical.test.mjs ui/lib/jobIdentity.mjs ui/lib/jobIdentity.test.mjs
git commit -m "feat: canonicalise vacancy observations"
```

### Task 7: Apply conservative deterministic rules

**Files:**
- Create: `ui/lib/vacancyFilter.mjs`
- Create: `ui/lib/vacancyFilter.test.mjs`
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`

**Interfaces:**
- Produces: `filterVacancies(vacancies, profile) -> { eligible, excluded }`
- Each exclusion has `{ vacancyId, code, profileRuleId, profileVersion, evidence, confidence, overrideable }`.

- [ ] **Step 1: Write failing mandatory/preference/unknown tests**

```js
test('only confirmed hard rules deterministically exclude', () => {
  const result = filterVacancies([softwareJob], profile({
    excludedResponsibilities: [
      rule('coding', 'hard-exclusion', 'confirmed-inference'),
      rule('management', 'strong-negative', 'explicit'),
    ],
  }));
  assert.equal(result.excluded[0].code, 'excluded-responsibility');
  assert.equal(result.excluded[0].profileRuleId, 'rule-coding');
});

test('unknown salary follows the published policy', () => {
  assert.equal(filterVacancies([unknownSalaryJob], profile({ salaryUnknownPolicy: 'include' })).eligible.length, 1);
  assert.equal(filterVacancies([unknownSalaryJob], profile({ salaryUnknownPolicy: 'exclude' })).excluded[0].code, 'compensation-unknown');
});
```

- [ ] **Step 2: Run tests**

Run: `node --test ui/lib/vacancyFilter.test.mjs ui/lib/scanPipeline.test.mjs`

Expected: FAIL because structured filtering does not exist.

- [ ] **Step 3: Implement evidence-backed rule matching**

Use exact structured values and token/phrase matching on individual approved rules. Delete the old whole-prose literal exclusion path from the runtime once integration lands. Strong negatives add rank penalties later; they do not exclude here.

- [ ] **Step 4: Add overrideable exclusion records**

Unknown-policy and explicit employer/title/employment/location rules may exclude only when the profile rule says `mandatory` or `hard-exclusion`. Every exclusion retains source evidence and confidence.

- [ ] **Step 5: Run tests**

Run: `node --test ui/lib/vacancyFilter.test.mjs ui/lib/scanPipeline.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/vacancyFilter.mjs ui/lib/vacancyFilter.test.mjs ui/lib/scanPipeline.mjs ui/lib/scanPipeline.test.mjs
git commit -m "feat: filter vacancies from confirmed profile rules"
```

### Task 8: Rank the complete eligible pool

**Files:**
- Create: `ui/lib/vacancyRank.mjs`
- Create: `ui/lib/vacancyRank.test.mjs`

**Interfaces:**
- Produces: `rankVacancies(vacancies, profile, history = []) -> RankedVacancy[]`
- `RankedVacancy` adds `{ preRankScore, preRankConfidence, dimensions, contributions, stableTieBreak }`.

- [ ] **Step 1: Write failing order-independence and domain fixtures**

```js
test('ranking is independent of source response order', () => {
  const forward = rankVacancies([weak, strong], profile);
  const reverse = rankVacancies([strong, weak], profile);
  assert.deepEqual(forward.map(({ vacancyId }) => vacancyId), reverse.map(({ vacancyId }) => vacancyId));
  assert.equal(forward[0].vacancyId, strong.vacancyId);
});

test('different profiles rank the same jobs differently', () => {
  assert.equal(rankVacancies(jobs, solicitorProfile)[0].title, 'Commercial Solicitor');
  assert.equal(rankVacancies(jobs, hospitalityProfile)[0].title, 'Part-time Bar Supervisor');
});
```

- [ ] **Step 2: Run tests**

Run: `node --test ui/lib/vacancyRank.test.mjs`

Expected: FAIL because ranking does not exist.

- [ ] **Step 3: Implement dimension scoring**

Each dimension returns `{ name, score, maximum, confidence, evidence, profileRuleIds }`. Derive maximum weights from profile strengths using:

```js
const STRENGTH_WEIGHT = Object.freeze({
  mandatory: 1,
  'strong-preference': 0.8,
  'nice-to-have': 0.35,
  neutral: 0,
  'strong-negative': -0.7,
  'hard-exclusion': -1,
});
```

Normalise positive dimensions to 0–100 after penalties. Unknown evidence lowers confidence and follows the dimension's unknown policy; it never receives a positive match score.

- [ ] **Step 4: Implement conservative compensation comparison**

Compare only matching currency/period/rate types directly. If a dated conversion is unavailable, return unknown instead of excluding or awarding a match. Preserve original values.

- [ ] **Step 5: Add stable ordering**

Sort by score descending, confidence descending, posted date descending, canonical employer/title ascending, then vacancy ID ascending.

- [ ] **Step 6: Run tests**

Run: `node --test ui/lib/vacancyRank.test.mjs`

Expected: PASS across all six generic profile fixtures.

- [ ] **Step 7: Commit**

```bash
git add ui/lib/vacancyRank.mjs ui/lib/vacancyRank.test.mjs
git commit -m "feat: rank every eligible vacancy"
```

### Task 9: Select a deterministic diverse assessment set

**Files:**
- Create: `ui/lib/vacancySelect.mjs`
- Create: `ui/lib/vacancySelect.test.mjs`

**Interfaces:**
- Produces: `selectVacancies(ranked, { limit, threshold, exploration, seed }) -> SelectionResult`
- `SelectionResult` has `{ selected, belowCutoff, reasons, constraintsRelaxed, seed }`.

- [ ] **Step 1: Write failing starvation and dominance tests**

```js
test('one employer cannot consume the budget while strong alternatives exist', () => {
  const result = selectVacancies(rankedFixture({
    dominantEmployer: 50, alternatives: 20,
  }), { limit: 10, threshold: 40, exploration: 0, seed: 'run-1' });
  assert.ok(result.selected.filter((job) => job.employerId === 'dominant').length <= 3);
  assert.ok(new Set(result.selected.map((job) => job.source)).size > 1);
});

test('weak sources receive no guaranteed places', () => {
  const result = selectVacancies([strongAts, weakBoard], {
    limit: 1, threshold: 50, exploration: 0, seed: 'run-1',
  });
  assert.deepEqual(result.selected.map((job) => job.vacancyId), [strongAts.vacancyId]);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test ui/lib/vacancySelect.test.mjs`

Expected: FAIL because selection does not exist.

- [ ] **Step 3: Implement score-first soft constraints**

Use score-ordered greedy selection with soft defaults:

- maximum 30% per employer when at least four eligible employers exist;
- maximum 60% per source when at least two healthy sources have above-threshold jobs;
- maximum 50% per lane when at least three lanes have above-threshold jobs.

If the selection is not full, relax lane, source, then employer limits in that order and record each relaxation. Never select below threshold merely to satisfy diversity.

- [ ] **Step 4: Implement changed/new and exploration handling**

Within equal score bands, prefer materially changed, then unseen, then older assessed vacancies. Exploration draws only from eligible above-threshold jobs outside the deterministic top set, uses the recorded seed, and defaults to zero until the profile explicitly enables it.

- [ ] **Step 5: Run tests**

Run: `node --test ui/lib/vacancySelect.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/vacancySelect.mjs ui/lib/vacancySelect.test.mjs
git commit -m "feat: diversify ranked assessment candidates"
```

### Task 10: Integrate ranked discovery into scan orchestration

**Files:**
- Modify: `tools/scout.mjs`
- Modify: `tools/scout.test.mjs`
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`

**Interfaces:**
- Consumes all modules from Tasks 1–9.
- Replaces runtime use of `compactCandidates()` with `prepareRankedDiscovery({ sources, profile, tracker, runId, limit })`.
- Produces `{ observations, vacancies, exclusions, ranked, selection, funnel }`.

- [ ] **Step 1: Write the failing full-pool integration test**

```js
test('runtime ranks all unique jobs before selecting sixty', async () => {
  const result = await runScanWith(root, 'codex', 'primary', harness({
    sources: sourceSetWithLaterStrongCandidate(2500),
    assessment: validAssessmentForSelected(),
  }));
  assert.equal(result.scan.funnel.uniqueVacancies, 2500);
  assert.equal(result.scan.funnel.ranked, result.scan.funnel.eligible);
  assert.equal(result.scan.funnel.selected, 60);
  assert.ok(result.scan.selection.some((item) => item.url === LATE_STRONG_URL));
});
```

- [ ] **Step 2: Run focused integration tests**

Run: `node --test tools/scout.test.mjs ui/lib/scanPipeline.test.mjs`

Expected: FAIL because the runtime still truncates before relevance evaluation.

- [ ] **Step 3: Implement `prepareRankedDiscovery`**

Collect all adapter jobs, normalise observations, canonicalise, filter, rank and select in that exact order. Assign assessment `candidateId` only after selection. Keep liveness checking between selection and assessment; a closed selected vacancy is removed and backfilled from the next ranked eligible vacancy until the limit is filled or no candidate remains.

- [ ] **Step 4: Require a published profile for the new engine**

Grandfathered workspaces with no published profile continue on the beta.22 path with an explicit `legacy-discovery` run marker until the user publishes the migrated draft. New workspaces cannot run the new engine without a published profile.

- [ ] **Step 5: Remove runtime whole-prose exclusion matching**

Keep `applyHardExclusions()` exported temporarily for old tests/legacy scans, but the ranked engine calls `filterVacancies()` only. Add a deprecation comment and a follow-up removal checkbox to the Gate A release audit.

- [ ] **Step 6: Run focused tests**

Run: `node --test tools/scout.test.mjs ui/lib/scanPipeline.test.mjs ui/lib/vacancy*.test.mjs`

Expected: PASS, including late strong candidates and reversed-source fixtures.

- [ ] **Step 7: Commit**

```bash
git add tools/scout.mjs tools/scout.test.mjs ui/lib/scanPipeline.mjs ui/lib/scanPipeline.test.mjs
git commit -m "feat: rank vacancies before assessment cutoff"
```

### Task 11: Persist explanations and honest funnel metrics

**Files:**
- Modify: `ui/lib/scanPipeline.mjs`
- Modify: `ui/lib/scanPipeline.test.mjs`
- Modify: `ui/lib/scanHealth.mjs`
- Modify: `ui/lib/scanHealth.test.mjs`
- Modify: `ui/server.mjs`
- Modify: `ui/server.test.mjs`
- Modify: `ui/app.js`
- Modify: `ui/app.config.test.mjs`

**Interfaces:**
- Scan run schema adds `profile_id`, `discovery_engine`, `funnel`, `selection_summary`.
- Candidate audit adds bounded `pre_rank`, `selection_reason`, `deterministic_exclusion`, `assessment_status`.
- `/api/scan/latest` exposes bounded reconciled metrics and explanation records without raw payloads or private paths.

- [ ] **Step 1: Write failing artifact/API tests**

```js
test('scan artifact exposes a reconciled funnel without claiming all jobs were assessed', () => {
  const artifacts = writeScanArtifacts(root, rankedFixture);
  assert.equal(artifacts.run.funnel.sourceRecords, 2532);
  assert.equal(artifacts.run.funnel.selected, 60);
  assert.equal(artifacts.run.funnel.assessed, 59);
  assert.equal(artifacts.run.funnel.assessmentFailed, 1);
  assert.equal(artifacts.run.candidates_found, 60);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test ui/lib/scanPipeline.test.mjs ui/lib/scanHealth.test.mjs ui/server.test.mjs ui/app.config.test.mjs`

Expected: FAIL because the new funnel and explanations are absent.

- [ ] **Step 3: Persist bounded metrics and explanations**

Limit explanations to stable IDs, scores, top three positive/negative contributions, exclusion/selection code, source names and safe URLs. Do not persist raw source payloads in `scan-runs.jsonl`.

- [ ] **Step 4: Update Reports scan-health copy**

Use exact labels:

- “Source records returned”
- “Unique vacancies after deduplication”
- “Excluded by confirmed rules”
- “Eligible and ranked”
- “Selected for detailed assessment”
- “Successfully assessed”
- “Assessment failed”

Remove or qualify any “vacancies checked” wording.

- [ ] **Step 5: Run focused tests**

Run: `node --test ui/lib/scanPipeline.test.mjs ui/lib/scanHealth.test.mjs ui/server.test.mjs ui/app.config.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/lib/scanPipeline.mjs ui/lib/scanPipeline.test.mjs ui/lib/scanHealth.mjs ui/lib/scanHealth.test.mjs ui/server.mjs ui/server.test.mjs ui/app.js ui/app.config.test.mjs
git commit -m "feat: explain ranked discovery coverage"
```

### Task 12: Add production-shaped migration and six-domain acceptance fixtures

**Files:**
- Create: `ui/lib/fixtures/searchProfiles.mjs`
- Create: `ui/lib/rankedDiscovery.acceptance.test.mjs`
- Modify: `tools/release-audit.test.mjs`
- Modify: `docs/SCOUT_SCAN_PROTOCOL.md`
- Modify: `docs/ADZUNA_AND_SOURCES.md`
- Modify: `docs/QUICK_START.md`

**Interfaces:**
- Produces six exported fixture builders: `softwareDeveloperProfile`, `hospitalAdministratorProfile`, `hospitalityWorkerProfile`, `commercialSolicitorProfile`, `mechanicalGraduateProfile`, `retailManagerProfile`.

- [ ] **Step 1: Write the failing cross-domain acceptance test**

```js
test('one generic engine produces different justified rankings for six profiles', () => {
  for (const fixture of profileCases()) {
    const result = discover(fixture.jobs, fixture.profile);
    assert.equal(result.ranked[0].vacancyId, fixture.expectedFirst);
    assert.ok(result.ranked.every((item) => item.dimensions.length > 0));
    assert.equal(result.funnel.ranked, result.funnel.eligible);
  }
});
```

- [ ] **Step 2: Run acceptance and release-audit tests**

Run: `node --test ui/lib/rankedDiscovery.acceptance.test.mjs tools/release-audit.test.mjs`

Expected: FAIL because fixtures/docs/audit requirements are absent.

- [ ] **Step 3: Add generic fixtures and migration rehearsal**

Each profile must use different titles, arrangements, compensation units and unknown policies. No fixture constants may be imported by production modules. Add a production-shaped synthetic legacy workspace migration that verifies tracker/report/application byte preservation.

- [ ] **Step 4: Update documentation**

Document the published-profile boundary, ranked-before-cutoff funnel, legacy fallback, source limitations, unknown handling and truthful metrics. Do not claim employer discovery or feedback learning before Gates C/D ship.

- [ ] **Step 5: Add release audit assertions**

Assert production source files do not contain the six fixture titles or Oliver-specific defaults, and release bundles exclude raw observation caches.

- [ ] **Step 6: Run the full suite**

Run: `npm.cmd test`

Expected: 0 failures and only documented platform skips.

- [ ] **Step 7: Run release audit**

Run: `npm.cmd run release:audit`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/lib/fixtures/searchProfiles.mjs ui/lib/rankedDiscovery.acceptance.test.mjs tools/release-audit.test.mjs docs/SCOUT_SCAN_PROTOCOL.md docs/ADZUNA_AND_SOURCES.md docs/QUICK_START.md
git commit -m "test: verify generic ranked discovery foundation"
```

## Follow-on Plans Required Before Gate A Release

This plan intentionally creates the shared contracts first. Gate A remains blocked until separate plans are written and executed for:

1. persistent scan stages, leases, heartbeats, resumable batches and focused assessment repair;
2. PR #71 review/merge/acceptance;
3. issues #72, #73, #74, #75 and #76;
4. combined migration, packaging, VPS rehearsal, rollback and release acceptance.

Those plans must consume the interfaces defined here rather than redesign them.

