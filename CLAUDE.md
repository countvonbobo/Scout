# Scout project instructions

## Mandatory first read

Before any task, read `docs/OPERATIONS.md`. It explains the maintained deployment, repository boundaries, source-of-truth rules, verification commands, and release path. If the task changes hosting, deployment, scheduling, backup, provider execution, repository layout, or access, update that file in the same change.

## Repository boundary

This checkout must be the public Scout application repository for app development. Put UI, server, installer, provider, test, template, and public-documentation work here. Put CV, profile, tracker, report, application, chat, and credential data only in a separate private workspace. A private workspace or legacy mixed-history archive must not receive new application development. See `docs/REPOSITORY_LAYOUT.md` before choosing a destination.

Scout is a local-first, AI-assisted opportunity finder. Before searching, scoring, tailoring a CV, preparing for an interview, or drafting outreach, read `workspace.json`, `profile/context.md`, and `profile/calibration.md`. They are the source of truth for the current user.

## Hard rules

- Be selective. Apply the user's hard exclusions before scoring and do not pad reports with weak matches.
- Never invent qualifications, achievements, compensation, contact details, or role facts.
- Use the locale and communication tone recorded in the workspace.
- Never send applications or outreach. Produce drafts for human review only.
- Verify that adverts and careers pages are current before reporting them; cite source URLs and the date checked.
- Keep the workspace private. Never move profile, CV, tracker, report, application, chat, or credential data into the public Scout application repository.

## Conventions

- Tracker: `data/opportunities.json`. Every reported opportunity has a stable `id` (`company-role-YYYY-MM`) and is deduplicated before insertion.
- Reports: `reports/YYYY-MM-DD.md`; newest verified facts win and score changes are explained.
- Tailored material: `applications/<slug>/` with `cv.typ`, rendered `cv.pdf`, and `outreach.md` where applicable. The slug is keyed by the tracked opportunity (falling back to company+role), not the company alone, so two roles at the same employer never collide. Folders created before this keying existed are left in place and reused only after an explicit prompt.
- Use absolute ISO dates (`YYYY-MM-DD`) and the configured currency.
- Preserve tracker, calibration, and application history; append dated evidence rather than erasing it.

## Documentation maintenance

- Read `docs/DOCUMENTATION.md` before changing user-visible behaviour, setup, configuration, operations, security, privacy, or support material.
- Update implementation, current guides, in-app help, tests, and release notes together.
- Remove completed plans and obsolete workarounds. Track unfinished work in issues or pull requests, not root-level TODO or handoff documents.
- Keep current guides version-neutral unless a compatibility boundary genuinely requires a version.
- Before committing, scrub documentation, examples, logs, fixtures, and screenshots for private workspace data, credentials, personal paths, hostnames, and private repository details.
