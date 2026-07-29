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

ATS portal configuration lives in `data/ats-portals.json`; search categories and queries live in `data/search-categories.json`; source notes live in `data/sources.md`. Keep entries generic and validated. Commands for diagnostic fetches are:

```powershell
scout source ats
scout source hiring-cafe
```

Before reporting an opportunity, verify the original advert/careers page is current, cite its URL and record the absolute date checked. Deduplicate into `data/opportunities.json` using a stable `company-role-YYYY-MM` ID. Never infer salary, location, qualifications or availability from missing fields.

For a published search profile, Scout normalises and deduplicates every returned vacancy, applies only confirmed exclusions, ranks the entire eligible pool, and then selects only above-threshold vacancies for detailed assessment. Source/portal errors are reported separately from records that fail normalisation. Source records can be stale, incomplete, duplicated or ambiguous; an unknown salary, arrangement or location remains unknown and follows the profile's selected unknown-value policy. Compensation is comparable only when explicit currency, period and rate type agree. Under `exclude`, absent or non-comparable compensation is rejected; Scout never invents a conversion. Source order, a missing optional source, and an unverified advert do not create a positive fact or a hard exclusion.

Configured sources are discovery inputs, not a promise to discover every employer or opening. Scout does not yet learn new search rules from feedback; review and publish profile changes yourself before a later scan uses them.

Respect site terms, robots/rate limits and personal-data rules. Do not work around access controls.
