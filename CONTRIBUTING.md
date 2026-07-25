# Contributing to Scout

Thank you for helping make Scout safer and more useful. The most important contribution rule is simple: public Scout development must never contain a person's career data.

## Before you start

- Make application changes in this public application repository, not in a private workspace or a legacy mixed-history archive. See [Repository layout](docs/REPOSITORY_LAYOUT.md).
- Discuss substantial UI, workspace-schema, provider, or source changes in an issue first.
- Keep Scout local-first and provider-neutral.
- Preserve the rule that applications and outreach are drafts for human review only.
- Use UK English in user-facing copy unless the text is explicitly locale-specific.

## Privacy-safe development

Use synthetic fixtures throughout tests, screenshots, issue reports, and pull requests. Do not commit:

- real names, contact details, postcodes, employers, salaries, or career histories;
- CVs, profiles, trackers, reports, applications, chat transcripts, or imported files;
- `.env` files, provider credentials, source keys, or logs;
- copied workspace Git history.

Before opening a pull request, check `git diff --cached` and the complete branch history. Removing a leaked file in a later commit is not sufficient; rewrite the branch before sharing it and rotate any exposed credential.

## Development loop

Use Node.js 24 LTS on a supported Windows, macOS, or Linux development host.

```powershell
npm install
npm test
npm run release:audit
```

For manual UI testing, point Scout at a disposable synthetic workspace:

```powershell
$env:SCOUT_WORKSPACE = "$env:TEMP\scout-synthetic-workspace"
node tools/scout.mjs workspace init
npm start
```

Do not run destructive migration or scheduler tests against your real workspace.

## Design expectations

- Resolve every personal path through the workspace abstraction.
- Keep secrets in the workspace `.env` or provider-owned credential storage.
- Make workspace migrations versioned, backed up, and safe to rerun.
- Use direct child-process invocation with explicit arguments; do not introduce `shell: true` for user-controlled content.
- Treat missing source data as uncertainty and individual source failures as degraded coverage.
- Add focused tests for behaviour and failure modes. **Every new test must fail against the pre-fix code.** Revert the change locally, confirm RED, restore it, confirm GREEN. Put both outputs in the report. A regression test that has never been observed to fail is not evidence. Where a bug has a user-visible symptom, at least one assertion must exercise that symptom — the action the user takes, not the flag the code sets.
- Follow [Documentation maintenance](docs/DOCUMENTATION.md) whenever a change affects commands, configuration, setup, migrations, providers, sources, installers, operations, privacy, or user-visible copy.

## Pull requests

Explain the user-facing change, tests run, privacy impact, migration impact, and relevant manual platform verification. Complete the pull-request documentation and privacy checklist. Keep unrelated changes separate. A maintainer may ask for a new synthetic fixture or release-audit marker before merging.

See [docs/RELEASE.md](docs/RELEASE.md) for the clean-room release process and [SECURITY.md](SECURITY.md) for private vulnerability reports.
