# Adaptive Setup and Mature Search Lanes

## Status and scope

This design implements Gate B of issue #77 on the existing draft-PR branch,
stacked on exact Gate A candidate head
`22f8a5d78692c9d3cb94ad742f539ea31f4121cc`.

Gate B adds:

- universal setup questions followed by bounded structured specialist
  follow-ups;
- deterministic, profile-derived search lanes;
- durable per-lane execution history and reconciled counts;
- overlap detection and fair lower-priority rotation;
- reversible retirement of consistently unproductive lanes; and
- selective lane regeneration after profile publication.

It does not add employer discovery/monitoring or learned preferences. Those
remain the separate Gate C and Gate D boundaries. The Gate A order remains
authoritative:

```text
published profile
  -> selected search lanes
  -> collection
  -> source observations
  -> canonical dedupe
  -> deterministic filter/rank
  -> diversified selection
  -> detailed assessment
```

## Authority and privacy boundaries

Raw setup answers remain immutable evidence. Adaptive answers update only the
reviewable search-profile draft. They cannot publish a profile or create a hard
exclusion without the existing explicit confirmation boundary.

The immutable published profile is the only lane-generation authority. AI may
help a user phrase answers, but it cannot add hidden questions, rules, lane
weights, queries or retirement decisions.

Lane state lives only in the private workspace:

```text
data/search-lanes.json
```

It is excluded from public release artifacts by the existing workspace/public
repository boundary. Queries, answers, run history and failure detail are not
returned through public diagnostics.

## Adaptive questionnaire

The questionnaire has two ordered phases.

### Universal questions

Every profile receives the same bounded questions for:

- primary and adjacent work;
- accepted locations and mobility;
- working patterns and employment arrangements;
- compensation and unknown-value handling;
- confirmed exclusions; and
- search breadth and exploration.

Each question declares its exact draft field, input shape, maximum values,
current values and whether confirmation is required. Answers are arrays,
enums, numbers or booleans, never accumulated prose.

### Specialist follow-ups

Scout selects at most six specialist follow-ups from missing or review-worthy
structured fields:

- responsibilities;
- skills;
- qualifications;
- eligibility;
- industries/sectors;
- seniority; and
- named employers.

Prompts interpolate only the already supplied primary title or the neutral
phrase "this work". No occupation taxonomy or occupation-specific question is
built into Scout. A follow-up remains a bounded list question with an exact
profile-field destination.

Every answer becomes an explicit rule in the draft. Re-answering a question
replaces only the rules for that field. The existing complete JSON review
remains available so every draft and published rule is inspectable and
editable.

## Lane plan

The lane-plan schema is version 1:

```text
schemaVersion
profileId
generatedAt
generation
lanes[]
archivedLanes[]
omissions[]
```

Each lane records:

- stable lane ID and deterministic fingerprint;
- state: `active` or `retired`;
- kind: title, location, industry, skill, remote-policy, employer or
  exploration;
- source contract and exact query;
- priority band and numeric priority;
- every contributing profile path, rule ID, value, strength and provenance;
- overlap IDs and overlap reason;
- creation/update timestamps;
- bounded run/failure history;
- aggregate returned, parsed, new, eligible, selected and promising counts;
- consecutive unproductive-run count; and
- reversible retirement metadata where applicable.

Removed profile rules move their lanes to `archivedLanes`; they are never kept
active as hidden preferences. An unchanged lane retains its ID, history and
retirement state when another profile field changes.

## Deterministic bounded generation

Generation is linear in published profile fields, not a cross-product:

- each bounded primary/adjacent title may create a title lane;
- location, industry, skill, remote-policy and employer lanes pair one value
  with one stable anchor title;
- exploration uses only explicit adjacent titles and the published exploration
  setting; and
- exact duplicate queries merge their profile-field provenance.

Per-kind caps and a global cap of 32 lanes prevent combinatorial growth.
Omitted values are recorded with their profile path and a stable
`bounded-capacity` reason so the omission is reviewable.

No built-in occupation, country, currency, employer, location or salary value
may influence generation.

## Overlap and rotation

Exact canonical-query matches merge. Remaining lanes record overlap when their
normalised token Jaccard similarity is at least 0.8.

Run selection uses priority bands:

- core;
- relevant; and
- exploration.

When capacity is bounded, each non-empty band receives a deterministic share.
Within a band, least-recently-run and least-run lanes come first, then stable
lane ID. Unused capacity is filled by the same fairness key. Input array order
never participates, so earlier lanes cannot starve later lanes.

Every selected lane is persisted in the run input before collection. Query
sources retain all matching lane IDs on each source record. Canonical vacancies
therefore retain every lane that found them while global Gate A ranking remains
independent of lane order.

## Durable lane results

The final fenced scan mutation updates tracker, report, run log and lane plan
as one recoverable mutation. A lane-history event is idempotent by run ID.

For every selected lane it records:

- returned: source-reported results for the exact query;
- parsed: valid source records carrying the lane ID;
- new: canonical vacancies with explicit unseen identity evidence;
- eligible: canonical vacancies surviving deterministic filtering;
- selected: vacancies entering detailed assessment after global ranking; and
- promising: assessed vacancies retained as eligible/check-worthy outcomes.

Source failures record only a bounded reason code and source identifier.
History is capped; aggregates remain after compaction.

## Retirement and restoration

A lane becomes eligible for retirement only after at least three completed,
non-failed runs with zero new, eligible, selected and promising results.
Retirement is an explicit deterministic operation, not a hidden side effect of
one scan. The record keeps its prior state, reason, threshold and timestamp.

Restoration clears retirement metadata without deleting history. A lane
archived because its profile rule was removed cannot be restored; the user must
restore and republish the rule instead.

## Migration and compatibility

Publishing a profile reconciles the lane plan atomically:

- no plan: generate all current lanes;
- unchanged contributing fields: preserve lane history/state;
- changed fields: replace only affected lanes;
- removed fields: archive only affected lanes; and
- malformed/newer plan: fail closed without changing the published profile.

Existing workspaces without a plan continue to read legacy search categories
until a reviewed profile publication creates the authoritative lane plan.
Once a plan exists, collection uses its selected active lanes and does not add
legacy category queries behind the user’s back.

## Acceptance evidence

Tests must prove:

- universal questions precede at most six structured specialist follow-ups;
- six materially different Gate A profiles produce materially different lanes;
- all requested field families contribute traceable provenance;
- generation remains within per-kind/global bounds;
- overlap is deterministic;
- bounded selection rotates every lane despite reversed input order;
- retirement requires repeated unproductive evidence and restoration is
  lossless;
- one profile-field change preserves every unaffected lane and its history;
- source jobs and canonical vacancies retain lane IDs;
- lane metrics reconcile with source, deterministic and assessment stages;
- recovery cannot append the same run twice;
- every draft/published rule remains visible and editable; and
- full Node, browser, privacy and staged-release audits remain green.
