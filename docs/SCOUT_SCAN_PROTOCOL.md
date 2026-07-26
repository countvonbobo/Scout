# Scout scan protocol

This is the provider-neutral contract for manual and scheduled scans.

## Trusted runtime ownership

Every run declares `agent=codex|claude` and `mode=primary|broadened|second-pass`. Scout's trusted runtime owns the private workspace lock, source collection, normalisation, deduplication, mandatory gates, score arithmetic, tracker merge, report generation and scan-run record. A live lock stops an overlapping run; the blocked run is recorded as skipped instead of running concurrently. Stale locks older than two hours may be recovered.

The provider receives only the scoring-relevant part of the private configuration (locale, currency, search, triage and commute), bounded profile/CV evidence and at most 60 selected candidates with capped descriptions, carrying only the fields the assessment reads. It returns schema-constrained assessments from one non-resumable, no-tools turn. It never invokes Scout, browses independently, writes workspace files, applies for a role or sends outreach. When sources yield zero candidates, Scout skips the provider entirely and still writes a truthful healthy-empty or degraded run.

Direct developer workflows may inspect or commit workspace changes separately. Git is not part of installed scan health: missing Git, a non-Git workspace or a commit failure cannot make otherwise valid scan artifacts unhealthy.

Interactive tracker changes use the same workspace lock as scans. Each browser response includes a tracker revision; a mutation made from a stale page is rejected before writing, the interface refreshes the current tracker and retries once. Successful UI mutations flush a complete temporary file and atomically replace `data/opportunities.json`. This prevents a scan finishing at the same time as a note, status, contact, category, commute or application-stage edit from silently overwriting either side.

## Published search-profile boundary

Ranked discovery uses only a reviewed, immutable published search profile. Raw setup answers and an editable draft are evidence for review; they do not become scan rules until publication. A migrated legacy workspace starts with an unpublished draft, so it remains on the legacy discovery path until its owner reviews and publishes that draft. Explicit or confirmed rules can exclude a vacancy; inferred values and strong preferences cannot silently become hard exclusions. Unknown source facts remain unknown and follow the published profile's configured policy (`include`, `penalise`, or `exclude`).

## Candidate selection, liveness and cost

When a published profile is available, before the provider is asked to score anything, the trusted runtime:

1. **Normalises and deduplicates every returned record.** Source order does not affect the canonical vacancy set. A source failure is counted separately and does not turn missing data into a fact.
2. **Applies confirmed rules, then ranks the complete eligible pool.** Every successfully normalised unique vacancy is evaluated before the 60-candidate cutoff. Strong preferences and unknown-value policies influence ranking without becoming unconfirmed hard exclusions.
3. **Selects a bounded assessment set.** Score comes first; soft employer, source and lane diversity limits prevent a dominant source from consuming the set when strong alternatives exist. The selection is deterministic for the same observations, profile and run configuration.
4. **Confirms each selected advert is still open.** A `HEAD` request, then a `GET`, classifies each advert as `live`, `gone` or `unverified` under bounded concurrency, a per-host delay and an overall time budget. `gone` means a 404 or 410, a redirect to the board's generic index, or wording such as "no longer accepting applications". Timeouts, DNS failures, blocks, 429s and 5xx remain `unverified` and the candidate is kept, so an offline host can never mass-close a tracker. Closed adverts are counted as `advert_closed` and the next eligible ranked vacancy may backfill the selection.

Workspaces without a published profile retain the legacy candidate path temporarily. Its run record is marked `legacy-discovery`; it does not claim ranked full-pool coverage.

A `second-pass` run is a verification pass, not a repeat of discovery. It re-examines the roles today's primary scan kept, plus those close enough to the threshold that a second opinion could change the outcome, rather than re-scoring every candidate. When there is nothing from today to verify it falls back to the full set, so a standalone second-pass run still does useful work.

## Search coverage and health

Scout runs configured ATS, Adzuna and hiring.cafe sources. Missing optional configuration is reported as not configured. A successful empty response is healthy; partial query/portal failure is degraded; a blocked or failed configured source is unavailable. Sources may omit, delay, duplicate or ambiguously format salary, location, working pattern and advert status; Scout preserves that uncertainty instead of guessing. Hiring.cafe retryable network/HTTP failures receive at most three bounded attempts, and Scout refreshes its build ID once after a 404 or endpoint-shape change.

Only healthy completed coverage enables scheduling. A degraded run states that its results are not evidence that no suitable roles exist.

If a supervised first/manual primary scan keeps no candidates, Scout automatically performs one broader discovery pass. It adds adjacent role aliases and broader role/sector/location query combinations, and removes the source-level location restriction where supported. It does not change the approved minimum salary, hard exclusions, location/commute policy, mandatory evidence or score gates. Scheduled scans and explicit second passes do not recursively broaden.

Manual operations show phase, elapsed time and an approximate remaining range. The range comes from up to ten healthy, non-skipped runs using the same provider and mode; without history Scout displays a conservative 5-10 minute range. An overrun remains visibly active rather than becoming a false zero countdown.

## Mandatory requirements and scoring

Scout applies configured hard exclusions before keeping a result. Employer language such as `required`, `essential`, `must`, `mandatory` and `non-negotiable` receives stable advert-evidence IDs that the provider must assess.

- A hard exclusion or confirmed unmet mandatory requirement discards the candidate.
- An unknown mandatory requirement can appear only in **One check from unlocking** and is capped below the action threshold.
- **Action today** requires advert evidence and supporting profile evidence for every mandatory requirement.

Scout recomputes dimension totals, scores and bands; provider totals are never trusted directly. New tracker entries may store backward-compatible `eligibility` and `mandatoryRequirements` evidence. Existing status, tags, sources, notes, contacts, logs and application history are preserved.

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

It appends one canonical schema-version-4 JSON object to `data/scan-runs.jsonl` containing timestamp/start time, agent, mode, `degraded`, `sources_checked`, `queries_checked`, candidate/keeper counts, discarded reasons, errors, `source_health` and a bounded `reviewed` audit. Ranked runs also record the profile ID, discovery engine, reconciled funnel, selection summary and bounded explanations. Scan-health presents these as **Source records returned**, **Unique vacancies after deduplication**, **Excluded by confirmed rules**, **Eligible and ranked**, **Selected for detailed assessment**, **Successfully assessed**, and **Assessment failed**. It never implies that every discovered vacancy received a detailed provider assessment. Audit entries contain only company, role, source link, category, outcome, score and up to three concise reasons; they never contain prompts, profile evidence, provider transcripts, raw observation caches or full advert descriptions. Readers remain compatible with older records and beta.9 aliases including nested `degradation`, `checked_sources`, `candidate_count`, `keeper_count` and `discarded_reasons`.

Ranked discovery does not yet add employers outside configured sources and does not learn new hard rules from feedback. Those capabilities remain deferred until Gates C and D.

Multiple runs on the same date are combined into one report with separate provider/mode summaries; the later run never erases the earlier run's presence. Before reporting success, Scout reads back and validates the tracker, required report sections and the matching final run record. The lock is released after completed, healthy-empty, degraded or failed runs.
