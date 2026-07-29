# Scout

Scout is a local-first, AI-assisted opportunity finder. It searches configured job sources, applies your own exclusions and scoring rubric, keeps a private opportunity tracker, and drafts material for you to review.

Scout never submits an application or sends outreach. Your CV, profile, tracker, reports, applications, chat history, and source credentials live in a separate private workspace.

**New user?** Start with the [five-minute quick start](docs/QUICK_START.md), then choose [Windows](docs/INSTALL_WINDOWS.md), [macOS](docs/INSTALL_MACOS.md), or [Linux](docs/INSTALL_LINUX.md). Advanced users can run the same private workspace on an always-on Linux host by following the [VPS guide](docs/INSTALL_VPS.md). Scout beta packages are unsigned and require your own authenticated Codex or Claude provider account.

> **Repository note:** this repository contains the public Scout application. Personal CV, profile, tracker, report, application, chat, and credential data belongs only in a separate private workspace. See [Repository layout](docs/REPOSITORY_LAYOUT.md).

## Status

Scout `0.1.x` is a cross-platform public beta. Windows SmartScreen and macOS Gatekeeper may warn because packages are unsigned. Verify the SHA-256 checksum published with every release. See [Known issues](docs/KNOWN_ISSUES.md) for confirmed current limitations.

## What Scout does

- Uses either the Codex CLI or Claude Code as the AI provider; a second provider is optional.
- Imports selectable text from PDF, DOCX, Markdown, or plain-text CVs.
- Interviews you to build a factual profile, configurable search lanes, exclusions, and a 100-point scoring rubric.
- Offers optional Google XYZ evidence questions and a separate natural-voice review when tailoring a CV.
- Builds searches from the CV and preferences you explicitly approve; it does not inspect unrelated AI conversations or provider history.
- Searches configured ATS boards and public sources. Adzuna is optional.
- Tracks evidence, verdicts, follow-ups, applications, and dated reports in a private local Git repository.
- Keeps real recruiter correspondence, calls, contacts and related vacancies together in a company relationship history while leaving each AI job chat role-specific.
- Optionally backs that workspace up to a private GitHub repository and restores it on another computer; local-only use remains the default.
- Optionally hosts that same running workspace and its Scout chats privately to the owner's phone or laptop through Tailscale Serve.
- Runs supervised or scheduled scans on Windows, macOS, or Linux, including paired primary and second-pass jobs.
- Keeps model choice optional, using the provider's supported default unless you select an override.

Scout is not an auto-apply tool. It does not invent qualifications, infer positive facts from missing evidence, or send anything on your behalf.

## Five-minute start

1. Install Scout from the release page and launch it. For a source checkout, see [Development setup](#development-setup).
2. Create a new local workspace or restore an existing Scout workspace from a private GitHub backup. Scout proposes a platform-appropriate local path during setup.
3. Install and sign in to either Codex or Claude, then let Scout verify it.
4. Import a CV, answer the setup questions, and generate one bounded proposal. Review every staged file before explicitly activating it.
5. Optionally add Adzuna credentials, run `scout doctor`, then perform one supervised scan.
6. Optionally connect a private GitHub repository for automatic backup. Git and Git Credential Manager are required only for backup/restore.
7. Only after reviewing that scan, enable the daily schedule.
8. Optionally open **Settings -> Private Remote Access** to use this same host from your phone or laptop. See [Private Remote Access](docs/PRIVATE_REMOTE_ACCESS.md).

The full walkthrough is in [Quick Start](docs/QUICK_START.md). If you want an AI assistant to guide setup, use [AI Setup](docs/AI_SETUP.md). The [documentation index](docs/README.md) groups every guide by task.

## Application and workspace are separate

```text
Scout application                  Private Scout workspace
-----------------                  -----------------------
UI, CLI, templates                 workspace.json
provider adapters                  profile/ and cv/
managed skills                     data/ and reports/
release documentation              applications/ and imports/
                                    .env, logs/, private Git history
```

Application upgrades replace application files and managed instructions. They do not delete or publish the workspace. Uninstalling Scout leaves the workspace in place.

Private GitHub backup is optional. Scout verifies that a repository is not public before connecting it, keeps normal career files readable in that private repository, and additionally encrypts credentials, generated PDF/DOCX files and recovery state. Keep the passphrase or one-time emergency recovery key safe. Codex and Claude sign-in state remains provider-owned and is not copied.

Scans are recoverable rather than blindly restarted. An append-only journal,
fenced lease and durable overlap queue let Scout resume compatible completed
stages and assessment batches after a process or machine restart, while stale
workers are prevented from committing. The Jobs view shows bounded recovery,
batch and queue state without exposing host identity, private paths, prompts,
provider output or advert content. Storage-pressure warnings stop new durable
work before recovery evidence becomes unsafe. The archive/cleanup engine never
deletes active or recovery-critical runs, but this release does not expose a
general cleanup button or CLI command; preserve the workspace and follow a
reviewed operator handoff if a refusal is reached.

Provider health is tracked separately for Codex and Claude. An unhealthy
provider blocks only its own work and is never silently replaced. Use the
owner-only guided sign-in in **Settings -> AI providers**, or the documented
terminal command shown there. Scout never clears Claude credentials
automatically; expired credentials can be cleared only after a fresh failed
authentication check and explicit confirmation.

You can select a non-default workspace with either:

```powershell
$env:SCOUT_WORKSPACE = 'D:\Private\My Scout Workspace'
scout doctor
```

or:

```powershell
scout doctor --workspace 'D:\Private\My Scout Workspace'
```

See [Privacy and Data](docs/PRIVACY.md) and [Configuration](docs/CONFIGURATION.md) before moving or backing up a workspace.

## Core commands

```text
scout doctor [--workspace PATH]
scout remote preflight [--require-enabled] [--url URL]
scout workspace init [--workspace PATH]
scout workspace migrate --from PATH --to PATH
scout cv quality <application-slug> [--workspace PATH]
scout scan --provider codex|claude --mode primary|second-pass
scout schedule install|status|remove|run-now
```

Run `scout` without arguments for command help.

## Development setup

Requirements: a supported Windows, macOS, or Linux host; Node.js 24 LTS; Git; and at least one authenticated compatible provider CLI.

```powershell
git clone https://github.com/oliver-hitchings/Scout.git
cd Scout
npm install
$env:SCOUT_WORKSPACE = "$HOME\Documents\Scout Workspace"
node tools/scout.mjs workspace init
npm test
npm start
```

Open `http://127.0.0.1:8459`. Use a synthetic workspace for development and never copy private workspace content into tests, screenshots or commits.

## Documentation

Use the [documentation index](docs/README.md) to find the right installation, setup, VPS, configuration, privacy, troubleshooting, or contributor guide. Historical release notes are kept separately and are not current setup instructions.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Use synthetic fixtures only; never contribute a real CV, profile, tracker, report, credential, or application. User-facing changes must follow the [documentation maintenance guide](docs/DOCUMENTATION.md).

Report vulnerabilities through the private route described in [SECURITY.md](SECURITY.md), not in a public issue.

Scout is available under the [MIT License](LICENSE).
