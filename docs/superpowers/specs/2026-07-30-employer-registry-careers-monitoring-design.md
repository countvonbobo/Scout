# Employer Registry and Careers Monitoring

## Status and scope

This design implements Gate C of issue #77 on the existing draft-PR branch,
stacked on exact all-green Gate B head
`23aa145080ce2a786b0c8c3613ec5f7c3b479def`.

The operator explicitly required continuing the existing branch and PR #82, so
Gate C does not create another branch or PR.

Gate C adds:

- a persistent, domain-neutral employer registry;
- deterministic employer selection and fair monitoring rotation;
- a common collection contract for ATS, query and careers-page adapters;
- validated structured-data and conservative generic-page monitoring;
- terms, robots, rate-limit and JavaScript-page safeguards;
- per-employer/source health and bounded check history; and
- safe retention of named, advert-discovered, research-discovered and manual
  employer evidence.

It does not add hidden preference learning. Employer decisions and priorities
are explicit registry state. Gate D remains the only feedback/learning
boundary.

## Authority and separation

The private registry is:

```text
data/employers.json
```

The immutable published search profile supplies named-employer preferences.
The registry records monitoring facts and explicit user decisions; it cannot
add profile rules, hard exclusions or ranking weights.

The stages remain separate:

```text
employer discovery
  -> registry reconciliation
  -> access/adapter validation
  -> fair monitoring selection
  -> advert collection
  -> canonical vacancy pipeline
  -> deterministic filter/rank
  -> detailed assessment
```

Employer discovery and monitoring never invoke the detailed-assessment model.
An advert-discovered employer is retained as reviewable evidence, not silently
promoted to a priority target.

## Registry schema

Schema version 1 contains a bounded employer array and bounded archived
records. Every active employer records:

- stable canonical ID and normalized canonical name;
- bounded aliases;
- origins: `named-profile`, `advert-discovered`, `research-discovered` or
  `manual`, each with timestamp and bounded provenance;
- optional canonical careers URL;
- optional board adapter and public board ID;
- bounded industries and locations;
- explicit user priority: `priority`, `relevant`, `normal`, `inactive` or
  `irrelevant`;
- explicit decision and its timestamp/reason;
- access policy: reviewed terms, robots permission, minimum interval and
  whether generic HTML collection is explicitly enabled;
- health: `unknown`, `healthy`, `degraded`, `blocked` or `unsupported`, bounded
  reason code, consecutive failures and last success/check;
- fair-rotation counters and next eligibility; and
- bounded check history with adapter, outcome, returned/parsed counts and
  redacted failure code.

Names, URLs, board IDs and user decisions are strictly validated. Raw pages,
robots bodies, response headers, exception messages and personal data are not
persisted.

## Identity and reconciliation

Canonical identity uses the normalized employer name. Exact normalized-name
and reviewed-alias matches merge; an alias matching more than one record fails
closed for review. Careers hosts and public board IDs remain reviewable
collection facts and never silently merge differently named employers.

New observations append origins and aliases without replacing user decisions,
access policy, health or history. Published named employers create or update
`named-profile` origins. Advert observations may add
`advert-discovered` origins after canonical dedupe. Removed profile rules do
not delete employers or historical monitoring decisions.

Legacy `data/ats-portals.json` remains readable and becomes a conservative
migration input. It does not run beside a migrated registry entry as a hidden
duplicate source.

## Fair monitoring selection

The registry freezes one bounded employer-monitoring contract at scan start:

- every eligible `priority` employer is selected;
- `relevant` and `normal` employers rotate by oldest successful/check time,
  lowest run count and stable ID;
- `inactive` employers use a longer review interval;
- `irrelevant` employers are excluded unless explicitly reactivated;
- per-band capacity is bounded and unused capacity may be filled by the next
  eligible band; and
- input/config order never affects selection.

Fresh priority employers are checked every scan subject only to the explicit
minimum rate interval. Relevant employers rotate each scan. Inactive employers
receive infrequent validation so a reversible decision does not become hidden
permanent deletion.

## Adapter contract and safeguards

All collection adapters return the same bounded result:

```text
adapter
employerId
status
jobs[]
returned
parsed
failureCode
checkedAt
```

Greenhouse, Lever and Ashby use their public board endpoints. Hiring.cafe and
Adzuna retain their query-source contracts. Selected canonical vacancies from
every configured source attach bounded employer discovery evidence during
finalisation, without changing source attribution.

Careers-page monitoring has two paths:

1. `structured-data` accepts only live HTTP success with a validated
   `JobPosting` JSON-LD object and a safe absolute HTTP(S) advert URL.
2. `generic` is opt-in per employer, respects reviewed terms and robots state,
   obeys the configured minimum interval and extracts only bounded same-site
   vacancy links with explicit job-like evidence.

Redirects to authentication, CAPTCHA/anti-bot responses, robots denial,
unreviewed terms, rate limiting and JavaScript-only shells are never bypassed.
They produce honest `blocked` or `unsupported` health with one correct next
action. Scout does not simulate a browser to evade these controls.

## Durable state and concurrency

Registry publication/edits acquire the existing fenced workspace lease and
use revision-bound writes. A scan persists the selected employer/adapter
contract in its collection artifact.

At finalisation, per-employer results and newly observed employer discoveries
are reconciled into the registry in the same prepared fenced mutation as the
tracker, report, run log and Gate B lane plan. Run IDs make check history
idempotent. A failed source records bounded failure evidence without treating
zero results as proof that an employer is irrelevant.

`data/employers.json` participates in marker-free private backup and never in
public release staging.

## Review and compatibility

Settings exposes canonical identity, origins, careers/board configuration,
industries, locations, priority, explicit decision, access safeguards, health
and recent checks. Mutations require current revision. Reactivation and policy
changes are explicit and reversible.

Existing workspaces with only `ats-portals.json` continue to collect through a
reviewable migration projection. Existing query-source and ranked-discovery
behavior remains unchanged when no registry is published.
