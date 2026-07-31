# Adzuna and Other Sources

Scout combines configured ATS boards and public discovery sources. Individual source failures reduce coverage; they do not make missing results evidence that no opportunity exists.

## Adzuna (optional)

Create an application through Adzuna's official developer portal and obtain an application ID and API key. Store them only in the selected workspace `.env`:

```dotenv
ADZUNA_APP_ID=replace_with_your_app_id
ADZUNA_API_KEY=<your-api-key>
```

Do not commit `.env`, paste keys into chat, or add them to `workspace.json`. Test availability with:

```powershell
scout source adzuna
```

Without credentials this command reports Adzuna unavailable and Scout can continue with other configured sources. For invalid keys, check spelling, account status, quotas and network access. Rotate a key immediately if it appears in Git history, logs or support material.

## ATS and public discovery

Employer monitoring lives in `data/employers.json`; legacy ATS portal
configuration in `data/ats-portals.json` is migrated into that reviewable
registry and is not collected a second time. Source notes live in
`data/sources.md`. `data/search-categories.json` remains a legacy query
input only until a reviewed profile creates `data/search-lanes.json`. After
that, Adzuna and hiring.cafe use the fairly selected active lanes and preserve
every matching lane ID when queries overlap. Keep entries generic and
validated. Commands for diagnostic fetches are:

```powershell
scout source ats
scout source hiring-cafe
```

Before reporting an opportunity, verify the original advert/careers page is current, cite its URL and record the absolute date checked. Deduplicate into `data/opportunities.json` using a stable `company-role-YYYY-MM` ID. Never infer salary, location, qualifications or availability from missing fields.

For a published search profile, Scout normalises and deduplicates every returned vacancy, applies only confirmed exclusions, ranks the entire eligible pool, and then selects only above-threshold vacancies for detailed assessment. Source/portal errors are reported separately from records that fail normalisation. Source records can be stale, incomplete, duplicated or ambiguous; an unknown salary, arrangement or location remains unknown and follows the profile's selected unknown-value policy. Compensation is comparable only when explicit currency, period and rate type agree. Under `exclude`, absent or non-comparable compensation is rejected; Scout never invents a conversion. Source order, a missing optional source, and an unverified advert do not create a positive fact or a hard exclusion.

The deterministic pre-rank exposes semantic dimensions for title, responsibilities, skills, qualifications, industry, location, working pattern, compensation, seniority, employer preference, freshness and novelty. Structured vacancy fields take precedence; bounded description evidence is used only when the structured field is absent. Each configured rule retains its published profile rule, strength, match evidence, score and evidence confidence. Missing evidence receives no positive score. Compensation amount type must also agree when both profile and advert specify it, and an explicitly unknown compensation certainty remains non-comparable.

Freshness and novelty are configured by published search breadth, not by occupation defaults. Focused search gives freshness a maximum weight of `1` over a 30-day horizon and novelty `0.35`; balanced search uses `0.8` over 90 days and novelty `0.8`; broad search uses `0.35` over 180 days and novelty `1`. Freshness compares the persisted posting/first-seen date with the newest persisted observation date in the same ranked pool, so identical artifacts rank identically without consulting the wall clock. Novelty becomes `seen-exact` only when a stable vacancy/source identifier or canonical URL exactly matches an existing tracker record. Employer/title similarity, a human tracker slug and other fuzzy signals cannot create a history match. Profiles without published search-behaviour settings retain zero-weight `not-configured` freshness and novelty dimensions.

Assessment selection remains score-first and never admits a below-threshold vacancy merely to improve variety. When the above-threshold pool has enough distinct values, soft limits allow at most 30% from one employer (four or more employers), 60% from one source (two or more sources), and 50% from one lane, explicit role family or canonical location (three or more values for that dimension). Role families come only from explicit lane/source metadata and are never inferred from a title. If the limits cannot fill the assessment budget, Scout relaxes lane, source, role family, location and then employer in that stable order, recording every relaxation. Seeded exploration must still satisfy every limit that was not relaxed.

Configured sources and reviewed employer pages are discovery inputs, not a
promise to discover every employer or opening. Scout retains employers from
selected canonical adverts as normal-priority review evidence. Explicit job
feedback remains separate from tracker status and ranking. A bounded learned
rank adjustment or exact rule reconsideration affects a later scan only after
you create, inspect and explicitly publish the separate proposal in
**Settings → Feedback & learning**. Learned changes never create a hidden hard
exclusion and every published version can be inspected and undone.

Respect site terms, robots/rate limits and personal-data rules. Do not work around access controls.

Open **Settings → Employers** to review named and advert-discovered employers,
priority, careers URL or public ATS board, access policy, rate interval, health
and recent bounded check outcomes. Greenhouse, Lever and Ashby public boards
share one monitoring result contract. A careers page is fetched only after
terms and robots state are explicitly allowed; validated `JobPosting` JSON-LD
is preferred, and conservative same-site generic links are opt-in. Redirects
to another origin, authentication, anti-bot challenges, rate limits and
JavaScript-only shells are recorded honestly rather than bypassed. Priority
employer pages with more than 100 qualifying structured postings or generic
job links are reported as degraded capacity with the returned and parsed
counts; the bounded result is never reported as a healthy complete page.
Priority employers are selected first whenever eligible. A scan checks at most
32 employers; if eligible priority employers exceed that bound, Scout reports
degraded capacity with exact eligible and omitted counts instead of claiming
complete coverage. Relevant/normal employers rotate
fairly, inactive employers receive only a 30-day validation check, and
irrelevant employers remain excluded until restored.

Monitoring never sends a page to the detailed-assessment model and never
treats an empty or blocked page as evidence that an employer is irrelevant.
The exact selected registry revision and bounded check outcomes are persisted
at collection, then committed with advert-discovery evidence in the same
recoverable final mutation as the tracker, report, scan log and search lanes.
