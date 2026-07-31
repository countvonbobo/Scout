# Codex and Claude Providers

Scout needs one installed and authenticated provider CLI. Codex and Claude are supported; a second provider is optional and can perform a second-pass review.

For Codex, use the current [official Codex CLI installation guide](https://developers.openai.com/codex/cli/) and select the macOS, Linux or Windows instructions for the host. After installation, open Terminal or PowerShell, run `codex`, complete its sign-in flow, and verify `codex login status`. Scout needs that authenticated CLI session; signing in to a desktop app alone does not authenticate the command-line provider.

Install each CLI only from its official provider documentation. Scout does not manage provider subscriptions, passwords or tokens.

## Verify outside Scout

```powershell
codex --version
codex login
codex login status
```

or:

```powershell
claude --version
claude auth login
claude auth status
```

Then refresh provider status in Scout. Scout checks standard Windows standalone, npm, Node.js and user-local locations directly, so a stale desktop `PATH` should not hide a normal installation. macOS and Linux checks include Homebrew, `/usr/local/bin`, `/usr/bin`, `$HOME/.local/bin`, `$HOME/.codex/bin`, `$HOME/.npm-global/bin` and `$HOME/bin`; custom locations still require PATH configuration.

Provider checks run asynchronously, share an in-progress probe and keep a short-lived result cache. A slow or hung provider CLI may leave Settings showing its checking state until the bounded probe finishes, but it does not block the dashboard or unrelated Scout API requests. After signing in or upgrading a CLI, wait a few seconds and refresh provider status again.

Scout uses the provider CLI, not a desktop application's embedded session. If Codex is installed but shown as signed out, run `codex`, complete sign-in, and confirm `codex login status` in the same host account before refreshing Scout.

While guided sign-in, verification or explicit Claude credential clearing is
active, Scout blocks new chat, onboarding and scan work for that same provider
before starting a provider process. Work using the other provider remains
available. Wait for the bounded sign-in result, then retry the blocked action;
Scout does not resend it automatically, and a late result cannot replace the
current login-in-progress health state.

Scout separately reports installation, authentication and bounded structured-output compatibility. An authenticated CLI that is too old for schema-constrained output remains disabled until it is upgraded from the provider's official installer. Bounded setup, scans and fit assessments use one non-resumable turn with no provider file-writing tools; Scout's trusted runtime validates and writes the workspace artifacts. Claude and Codex use the same strict assessment schema: providers supply nuanced fit and evidence, while Scout retains numeric scoring, category, deterministic-exclusion, ordering and source-coverage authority.

On Windows, Codex runs under its documented `unelevated` sandbox. Scout never uses Codex's unrestricted filesystem mode.

## Configure

Choose the primary provider in **Settings → AI providers**. The same screen accepts an optional model identifier for Codex and Claude independently. Those choices apply to individual job conversations, CV tailoring, fit assessment and interview preparation. Leave either field blank to use that provider's current default.

When a new conversation starts, Scout shows a model picker. Codex models come from the installed CLI's bounded model catalogue when that capability is available; Scout labels this as a refreshed catalogue. If catalogue refresh is unavailable or fails, Scout clearly labels its short built-in list as fallback suggestions whose availability is unknown. Claude suggestions are also labelled as fallback because its CLI does not currently expose a model catalogue. A saved model missing from a refreshed catalogue, or one the provider has rejected, remains visible for diagnosis but cannot be selected again.

**Other…** is the advanced escape hatch for an exact provider model ID. Scout checks its syntax locally, but the provider remains the authority on whether it is accepted. Raw provider catalogue output, executable paths, account details and diagnostics are never sent to the browser.

For a resumable Codex conversation, Scout checks the device-local `codex://` handler before enabling **open in Codex**. A click is treated only as an attempt because browsers cannot confirm that a desktop app opened. Scout therefore keeps the exact technical task ID visible and copyable with resume instructions. In remote Scout sessions, the server host's handler is deliberately ignored: the integration must exist on the browser's own device, so copy/resume is used instead.

Scan models are separate. Choose an optional model for each job under **Settings → Scans & schedule**. The supervised scan uses the model shown for the primary scan row, and an enabled daily job saves its own model. Leaving it blank uses the provider default rather than the job-conversation model.

In `workspace.json`, the job-work choices are `ai.models.codex` and `ai.models.claude`; scheduled scan choices are stored on each `schedule.jobs[]` item. The singular `ai.model` field is retained only as a compatibility fallback for older workspaces.

Run a primary scan with:

```powershell
scout scan --provider codex --mode primary
```

For a one-off explicit override, add `--model MODEL`. Omit it to use the configured compatibility/default behaviour.

`second-pass` is a verification workflow, not an independent licence to add weak or unverified results.

## Common failures

- **Not installed:** confirm the command works in a new PowerShell window and its directory is on the user `PATH`.
- **Installed but unauthenticated:** run the provider's status command, complete its official login, then retry.
- **Signed in but update required:** update the official CLI, verify `--output-schema` (Codex) or `--json-schema` (Claude) support, and refresh Scout.
- **Works in terminal, not Scout:** restart Scout/Windows after `PATH` changes and check whether the CLI is installed for a different Windows user.
- **Model rejected or saved default unavailable:** choose a model marked available in the conversation picker, or clear the relevant model field in **Settings → AI providers** or **Settings → Scans & schedule**. Do not assume a fallback suggestion is currently available; the provider validates it when the conversation starts.
- **Corporate/network restriction:** test the provider directly and follow its proxy/firewall documentation; do not paste credentials into Scout logs or issues.

Provider output may contain private prompt context. Keep workspace `logs/` private when requesting support.
