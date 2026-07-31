# Scout scan protocol

This is the provider-neutral contract for manual and scheduled scans.

## Trusted runtime ownership

Every run declares `agent=codex|claude` and `mode=primary|broadened|second-pass`. Scout's trusted runtime owns the private workspace lock, source collection, normalisation, deduplication, mandatory gates, score arithmetic, tracker merge, report generation and scan-run record. A live lock stops an overlapping run; the blocked run is recorded as skipped instead of running concurrently. Stale locks older than two hours may be recovered.

The provider receives only the assessment-relevant part of the private configuration, bounded profile/CV evidence and at most 60 selected candidates with capped descriptions, carrying only the fields the assessment reads. It returns schema-constrained assessments from one non-resumable, no-tools turn. It never invokes Scout, browses independently, writes workspace files, applies for a role or sends outreach. When sources yield zero candidates, Scout skips the provider entirely and still writes a truthful healthy-empty or degraded run.

Direct developer workflows may inspect or commit workspace changes separately. Git is not part of installed scan health: missing Git, a non-Git workspace or a commit failure cannot make otherwise valid scan artifacts unhealthy.

Interactive tracker changes use the same workspace lock as scans. Each browser response includes a tracker revision; a mutation made from a stale page is rejected before writing, the interface refreshes the current tracker and retries once. Successful UI mutations flush a complete temporary file and atomically replace `data/opportunities.json`. This prevents a scan finishing at the same time as a note, status, contact, category, commute or application-stage edit from silently overwriting either side.

## Published search-profile boundary

Ranked discovery uses only a reviewed, immutable published search profile. Raw setup answers and an editable draft are evidence for review; they do not become scan rules until publication. Scout stages that draft during workspace startup, setup review or scan readiness once the legacy preferences and profile evidence exist. An established beta workspace with tracked opportunities may temporarily remain on the explicitly marked legacy discovery path, but a fresh workspace cannot scan until its staged draft is reviewed and published. Explicit or confirmed rules can exclude a vacancy; unconfirmed inferred rules remain non-blocking even if their draft strength says `mandatory`. Multiple mandatory accepted values for one field are alternatives: matching any one satisfies that field. Unknown source facts remain unknown and follow the published profile's configured policy (`include`, `penalise`, or `exclude`).

Before ranked-discovery profile migration changes the workspace, Scout creates
and verifies one beta.22-compatible snapshot under `.scout/backups/`. It
contains the beta.22 private workspace boundaries, including credentials,
tracker, reports, applications, chats, imports, logs and encrypted
`.scout-backup` recovery data, but excludes fenced runtime state and
ranked-profile artifacts. Profile publication reconstructs
the bounded identities of historical tracker and scan-review vacancies,
filters and re-ranks them under the new published profile, and writes an
immutable profile-specific artifact under `profile/search/rankings/`. It does
not edit an old score, status, note, contact, event, report or assessment.
Historical profile or scoring inputs that cannot be reconstructed exactly are
labelled `legacy-unreconstructable`; a rejected vacancy that resurfaces is
re-ranked and may be assessed once under the published profile. Its new
profile-bound decision then prevents unchanged repeats from consuming later
assessment capacity.

## Candidate selection, liveness and cost

When a published profile is available, before the provider is asked for detailed assessment, the trusted runtime:

1. **Selects traceable search lanes.** The immutable published profile generates a bounded lane plan without a cross-product. Capacity rotates fairly across core, relevant and exploration bands; the exact selected lane/query contract is retained with collection evidence.
2. **Normalises and deduplicates every returned record.** Source order does not affect the canonical vacancy set. Source/portal errors are counted separately from returned records that fail normalisation, so neither kind of failure can create a negative observation count. A record and its canonical vacancy retain every matching lane ID.
3. **Applies confirmed rules, then ranks the complete eligible pool.** Every successfully normalised unique vacancy is evaluated before the 60-candidate cutoff. Strong preferences and unknown-value policies influence ranking without becoming unconfirmed hard exclusions. Deterministic discard totals count unique vacancies while the audit retains every matched-rule explanation.
4. **Selects a bounded assessment set above a relevance threshold.** The runtime uses the configured check score as the pre-assessment relevance threshold; a positive profile-boundary fallback prevents zero-score unrelated vacancies from padding direct ranked-discovery calls. Score comes first; soft employer, source, lane, role-family and location limits prevent one cohort from consuming the set when strong alternatives exist. The selection is deterministic for the same observations, profile and run configuration.
5. **Confirms each selected advert is still open.** A `HEAD` request, then a `GET`, classifies each advert as `live`, `gone` or `unverified` under bounded concurrency, a per-host delay and an overall time budget. `gone` means a 404 or 410, a redirect to the board's generic index, or wording such as "no longer accepting applications". Timeouts, DNS failures, blocks, 429s and 5xx remain `unverified` and the candidate is kept, so an offline host can never mass-close a tracker. Closed adverts are counted as `advert_closed` and the next eligible ranked vacancy may backfill the selection.

Only grandfathered established workspaces without a published profile retain the legacy candidate path temporarily. Its run record is marked `legacy-discovery`; it does not claim ranked full-pool coverage.

A `second-pass` run is a verification pass, not a repeat of discovery. It re-examines the roles today's primary scan kept, plus those close enough to the threshold that a second opinion could change the outcome, rather than re-scoring every candidate. When there is nothing from today to verify it falls back to the full set, so a standalone second-pass run still does useful work.

## Search coverage and health

Scout runs configured ATS, Adzuna and hiring.cafe sources. Missing optional configuration is reported as not configured. A successful empty response is healthy; partial query/portal failure is degraded; a blocked or failed configured source is unavailable. Sources may omit, delay, duplicate or ambiguously format salary, location, working pattern and advert status; Scout preserves that uncertainty instead of guessing. Hiring.cafe retryable network/HTTP failures receive at most three bounded attempts, and Scout refreshes its build ID once after a 404 or endpoint-shape change.

Only healthy completed coverage enables scheduling. A degraded run states that its results are not evidence that no suitable roles exist.

Every ranked run keeps one stage explanation for every unique vacancy, including vacancies rejected before ranking and ranked vacancies that did not enter detailed assessment. The explanation records whether the vacancy was found, ranked, selected, deterministically excluded and assessed; its bounded score contributions; and one stable reason such as `below-relevance-threshold`, `diversity-limit`, `assessment-capacity`, `exploration-replacement`, `advert-closed`, `verification-scope` or a lifecycle skip. Multiple confirmed rules may exclude one vacancy, so the vacancy remains one funnel item while retaining every matched exclusion code.

The total funnel and every configured-source funnel reconcile exactly across returned, failed, normalised, duplicate, unique, excluded, eligible, ranked, above-threshold, selected, assessed and assessment-failed counts. Scout retains the configured collection-source identity separately from a vacancy vendor so an ATS record cannot be attributed to another source merely because the vendor label differs. Coverage rollups show the same vacancy stages by source, employer, lane, role family, location, provider, run and date, plus bounded failure-reason counts. The latest-scan dialog exposes source coverage and explains why a promising role missed detailed assessment.

For each selected search lane, the final fenced mutation also reconciles exact
query returns, valid parsed records, exact unseen vacancies, deterministic
eligibility, detailed-assessment selection and promising kept/check outcomes.
The tracker, report, run log and lane plan therefore recover together after an
interruption. Failed runs record bounded failure evidence and never advance
the repeated-unproductive counter. Retirement remains an explicit user action
after three completed unproductive runs, and restoration preserves history.

If a supervised first/manual primary scan keeps no candidates, Scout automatically performs one broader discovery pass. It adds adjacent role aliases and broader role/sector/location query combinations, and removes the source-level location restriction where supported. It does not change the approved minimum salary, hard exclusions, location/commute policy, mandatory evidence or score gates. Scheduled scans and explicit second passes do not recursively broaden.

Manual operations show phase, elapsed time and an approximate remaining range. The range comes from up to ten healthy, non-skipped runs using the same provider and mode; without history Scout displays a conservative 5-10 minute range. An overrun remains visibly active rather than becoming a false zero countdown.

## Mandatory requirements and scoring

Scout applies configured hard exclusions before keeping a result. Employer language such as `required`, `essential`, `must`, `mandatory` and `non-negotiable` receives stable advert-evidence IDs that the provider must assess.

- A hard exclusion or confirmed unmet mandatory requirement discards the candidate.
- An unknown mandatory requirement can appear only in **One check from unlocking** and is capped below the action threshold.
- **Action today** requires advert evidence and supporting profile evidence for every mandatory requirement.

Scout owns score dimensions, arithmetic, relevance thresholds, bands, categories and deterministic exclusions. The provider-neutral assessment schema accepts only responsibility fit, mandatory-requirement evidence, transferable experience, uncertainties, evidence-backed strengths and concerns, and a `keep`, `check` or `discard` recommendation. It cannot supply a numeric score, category or hard exclusion. Each committed assessment records provider, model, prompt, assessment-schema, profile and pipeline provenance; a provenance change restarts only incompatible assessment work. New tracker entries may store backward-compatible `eligibility` and `mandatoryRequirements` evidence. Existing status, tags, sources, notes, contacts, logs and application history are preserved.

## Runtime artifacts

Scout writes `reports/YYYY-MM-DD.md` with:

1. `## Headline`
2. `## Scan runs`
3. `## Action today`
4. `## One check from unlocking`
5. `## Follow-ups due`
6. `## Changes since last scan`
7. `## Discarded`
8. `## Verdicts`

It appends one canonical schema-version-5 JSON object to `data/scan-runs.jsonl` containing timestamp/start time, agent, mode, `degraded`, `sources_checked`, `queries_checked`, candidate/keeper counts, discarded reasons, errors, `source_health` and a bounded `reviewed` audit. Ranked runs also record the profile ID, discovery engine, mathematically reconciled total/per-source funnel, selection summary, complete bounded per-vacancy explanations and coverage rollups. Scan-health presents these as **Source records returned**, **Unique vacancies after deduplication**, **Excluded by confirmed rules**, **Eligible and ranked**, **Selected for detailed assessment**, **Successfully assessed**, and **Assessment failed**. It never implies that every discovered vacancy received a detailed provider assessment. Audit entries contain only bounded company, role, dimensions, canonical source link and provider-reference identities, stage flags, deterministic score contributions, reason codes and assessment outcomes; they never contain prompts, profile evidence, provider transcripts, raw observation caches, URL query/fragment data or full advert descriptions. A run fails closed rather than silently truncating an audit above the 10,000-vacancy artifact capacity. Readers remain compatible with older records and beta.9 aliases including nested `degradation`, `checked_sources`, `candidate_count`, `keeper_count` and `discarded_reasons`.

Ranked discovery retains employers from selected canonical adverts as
normal-priority review evidence and can monitor explicitly reviewed public
careers sources. Job feedback is a separate versioned event and cannot change
ranking itself. Only an explicitly reviewed learned-preference proposal enters
the deterministic rank compatibility fingerprint. Its bounded contribution is
shown separately from base profile evidence; confirmed exact rule
reconsideration retains the original exclusion evidence. Undo appends a new
version restoring the prior published behavior, while historical decisions
retain their original profile and learning versions.

Multiple runs on the same date are combined into one report with separate provider/mode summaries; the later run never erases the earlier run's presence. Before reporting success, Scout reads back and validates the tracker, required report sections and the matching final run record. The lock is released after completed, healthy-empty, degraded or failed runs.
