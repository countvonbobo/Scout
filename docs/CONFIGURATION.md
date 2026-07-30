# Configuration Reference

`workspace.json` is the versioned, non-secret configuration for one private Scout workspace. Paths, CVs, reports and credentials must not be put in the application repository.

## Selecting a workspace

Precedence is `--workspace PATH`, then `SCOUT_WORKSPACE`, then the default `%USERPROFILE%\Documents\Scout Workspace`. Existing private source checkouts containing `data/opportunities.json` retain legacy in-place behaviour unless an explicit workspace is selected.

```powershell
$env:SCOUT_WORKSPACE = 'D:\Private\Scout Workspace'
scout doctor
```

## Schema version 2

```json
{
  "schemaVersion": 2,
  "locale": "en-GB",
  "currency": "GBP",
  "timezone": "Europe/London",
  "profile": { "displayName": "", "tone": "natural, direct and evidence-led" },
  "search": {
    "roleFamilies": [], "sectors": [], "locations": [], "exclusions": [],
    "salaryMinimum": null
  },
  "commute": {
    "origin": "", "mode": "either", "maxMinutes": 180,
    "includeUnknown": true
  },
  "ai": { "provider": null, "model": null, "models": { "codex": null, "claude": null } },
  "schedule": {
    "jobs": [
      { "id": "claude-primary", "enabled": true, "time": "07:30", "days": [0, 1, 3, 5], "provider": "claude", "mode": "primary", "model": null },
      { "id": "codex-second-pass", "enabled": true, "time": "08:30", "days": [2, 4, 6], "provider": "codex", "mode": "second-pass", "model": null }
    ]
  },
  "setup": { "completedAt": null }
}
```

- `locale`, `currency` and `timezone` are required strings. Use recognised BCP 47, ISO 4217 and IANA values.
- `profile.tone` guides drafts; it never authorises sending.
- Search arrays contain user-defined plain-text preferences. `salaryMinimum` is numeric or `null`; adverts with missing salary remain uncertain rather than passing automatically.
- `commute.mode` records the user's policy; `maxMinutes` is the allowed journey time and `includeUnknown` controls whether unverified journeys remain visible.
- `ai.provider` is `codex`, `claude` or `null`. `ai.models` provides optional per-provider choices for job-specific questions, CV tailoring and interview preparation; leave a value null to use the provider's current supported default. `ai.model` is retained as a compatibility fallback for older workspaces. Explicit model identifiers may contain letters, digits, `.`, `_`, `:`, or `-` only.
- Schedule job IDs use lower-case letters, numbers and hyphens. Time uses 24-hour `HH:MM`; `days` lists the weekdays the job runs on with Sunday as `0` (omit it or use an empty array for every day); provider is `codex` or `claude`; mode is `primary` or `second-pass`; and `model` is an optional per-scan override. Every enabled provider must be installed and authenticated on the host.
- `setup.completedAt` is written by Scout when onboarding finishes. It prevents the first-run wizard reopening; use Settings to retune an existing workspace.

The profile narrative and scoring precedents live in `profile/context.md` and `profile/calibration.md`. Search categories, ATS portals and employer lists live under `data/`. Preserve dated history instead of replacing it.

## Authoritative scan input

For a ranked-discovery scan, the immutable published search profile in
`profile/search/published.json` is the authority for deterministic filtering,
ranking, selection and the profile provenance carried into detailed
assessment. `workspace.json` stores only its `searchProfile.publishedId`
reference. Draft and raw profile artifacts are review evidence and never drive
a scan.

Publishing a reviewed profile also creates or selectively reconciles
`data/search-lanes.json`. Each bounded lane records its exact query, priority,
contributing profile fields and run history. Unchanged fields retain their lane
history; removed fields are archived instead of remaining as hidden search
preferences. Once this plan exists, query sources use only its selected active
lanes. Legacy categories are not silently added.

Settings shows the universal structured questions before at most six
specialist follow-ups. Only checked answers change the complete draft, and no
answer publishes it. Hard exclusions still require explicit confirmation.
Scout rotates bounded capacity fairly across core, relevant and exploration
lanes rather than allowing stored order to starve a lane.

| Published profile field | Current runtime effect |
| --- | --- |
| `target.primaryTitles`, `target.titles`, `target.locations`, `target.workingPatterns`, `target.employmentTypes`, `target.seniority`, `target.employers`, `target.sectors` | Confirmed mandatory rules may filter when supported by advert evidence; all configured strengths contribute to deterministic ranking. |
| `negative.excludedTitles`, `excludedEmployers`, `excludedEmploymentTypes`, `excludedLocations`, `excludedResponsibilities` | Only explicit or confirmed hard exclusions remove a vacancy; strong negatives reduce deterministic rank. |
| `compensation` | Controls conservative like-for-like comparison, unknown-value handling, exclusion and rank contribution. Optional `amountType` (`base`, `total`, `rate` or `unknown`) and `certainty` (`exact`, `range`, `estimated` or `unknown`) make pay evidence explicit; omitted fields remain valid for existing version-1 profiles. |
| `unknownPolicies.location` | Selects how missing location evidence is handled: `include` keeps the vacancy eligible with zero location confidence, `penalise` applies a bounded traceable rank penalty, and `exclude` records an overrideable `location-unknown` exclusion when a blocking location rule exists. Omission remains backward-compatible and behaves as `include`. |
| `selection.breadth`, `selection.relevanceThreshold`, `selection.exploration` | Bound how widely the deterministic result set is selected. Breadth is `focused`, `balanced` or `broad`; the threshold is 0–100 and exploration is 0–1. The whole section is optional for existing version-1 profiles. |
| Profile `id`, version and publication time | Identify the immutable decision input and recovery compatibility; they do not add preferences by themselves. |

## Workspace runtime configuration

These `workspace.json` fields configure runtime mechanics or non-scan product
behaviour. They are not substitutes for published preference rules.

| Field | Current effect |
| --- | --- |
| `locale` | Formats source results, CV checks and user-facing/provider language. It is not a relevance rule. |
| `currency` | Supplies legacy source-normalisation and migration context. A published compensation rule must still provide its own currency and period. |
| `timezone` | Calculates scheduled windows. It does not affect job location. |
| `profile.displayName` | Supports onboarding/readiness and display copy; it has no scan-decision effect. |
| `profile.tone` | Guides chat, CV and outreach drafts. It never changes eligibility and never authorises sending. |
| `triage` | Buckets existing tracker items, follow-up timing and the legacy relevance fallback. It does not override a published profile rule. |
| `sources` | Enables and bounds configured source adapters. Source configuration may change what is returned, but cannot alter deterministic rank directly. |
| `ai.provider`, `ai.models` | Select the provider/model used after deterministic selection and for other bounded AI features. |
| `schedule.jobs` | Selects provider, mode, model and logical run windows; it does not define preferences. |
| `commute` | Remains legacy assessment/context configuration. It is not currently a structured ranked-discovery dimension. |

## Legacy compatibility inputs

The following fields remain live only where stated, so an existing workspace
keeps working while the published-profile and future lane contracts replace
them:

- `search.roleFamilies` and `search.sectors` are collection inputs only while
  no published search-lane plan exists. They also seed the conservative
  migrated profile draft, but do not override an already published profile or
  add queries beside its lanes.
- `search.locations` and `search.salaryMinimum` are legacy collection inputs
  for the configured Adzuna request. They seed migration evidence; unknown and
  non-comparable compensation in ranked discovery follows the published
  profile instead.
- `search.exclusions` seeds a reviewable migrated draft. Whole prose is not
  treated as an automatic structured exclusion.
- `ai.model` is a fallback for workspaces created before per-provider
  `ai.models`.
- Schema 1 schedule and setup records are migration inputs. Their preserved
  historical values are not new scan preferences.
- `profile/context.md`, `profile/calibration.md` and
  `data/search-categories.json` remain user-authored evidence and legacy
  provider/search inputs. Search categories are ignored for collection after
  a lane plan is published. None of these files silently mutates the immutable
  published profile.

## Search-lane history and retirement

Every selected lane records returned, parsed, new, eligible, selected and
promising counts in the same fenced final mutation as the tracker, report and
run log. A failed run is recorded as failed and cannot count towards
unproductive retirement. History is bounded and idempotent by run ID.

Open **Settings → Search & profile → Search lanes and run history** to inspect
the exact query, profile provenance and recent evidence. Scout offers
retirement only after three completed, non-failed runs with no new, eligible,
selected or promising result. Retirement requires a review checkbox and is
reversible with **Restore this lane**. A lane archived because its profile rule
was removed must instead be restored by editing and republishing the rule.

## Deployment-only configuration

Deployment-only settings are not stored in `workspace.json`: workspace path
selection, provider and source credentials, public-source audit markers,
runtime binary locations, host binding/private remote access, service-manager
configuration, signing keys and release credentials. Keep those in the
documented environment, device or private operator context. They may make a
capability available, but they must not change a user's relevance rules.

## Readiness and UI claims

`setup.completedAt` controls whether onboarding reopens; it does not change
collection, filtering, ranking or assessment. The setup readiness check also
requires a display name and legacy search fields so an older workspace remains
usable. Passing that UI check is not a claim that every field is authoritative
for ranked discovery.

Settings shows the draft/published profile state, provider health, source
configuration and schedule state as separate concepts. A displayed source,
provider or setup value is not evidence that it contributed to a vacancy
decision; persisted filter/rank/selection explanations are the decision
record.

Run `scout doctor` after edits. Do not store secrets in `workspace.json`; see [Privacy](PRIVACY.md).

When upgrading a schema 1 workspace, Scout migrates the legacy singular schedule into one named primary job and saves the original configuration under `.scout/backups/`. Versions that understand only schema 1 refuse schema 2 rather than silently applying the wrong timer.
