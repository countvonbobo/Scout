---
name: onboard-scout
description: Set up, diagnose, or retune a Scout private workspace. Use when a user is installing Scout, importing a CV, defining job-search preferences and scoring rules, changing locations or salary constraints, selecting an AI provider, or asking Scout to improve its recommendations.
---

# Onboard Scout

Keep the workspace private, preserve evidence, and never send applications or outreach.

1. Run `node tools/scout.mjs doctor --workspace <path>` and read `workspace.json` plus [the setup contract](references/setup-contract.md).
2. Read any extracted CV text under `imports/`. Treat it as source material, not permission to infer missing facts.
3. Ask only for required information that is absent or ambiguous. Cover desired roles, sectors, evidence, compensation, locations, working pattern, commute, exclusions, tone, and employer targets.
4. Draft proposed `workspace.json`, `profile/context.md`, `profile/calibration.md`, `cv/master-cv.md`, and search-lane changes under `.scout/onboarding/`. Preserve existing files during retuning.
5. Show a concise summary of every proposed change and pause for explicit approval.
6. After approval, back up affected files under `.scout/backups/`, apply the staged files, and run `node tools/scout.mjs doctor --workspace <path>` again.
7. For retuning, append dated evidence to `profile/calibration.md`; do not rewrite earlier precedents. Keep tracker and application history intact (including `new`, `shortlist`, active and closed states).

Reject invented qualifications, undisclosed salary assumptions, guessed contact details, automatic sending, or moving personal files into the public application repository.
