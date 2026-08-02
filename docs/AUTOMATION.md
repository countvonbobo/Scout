# Scheduled scans

Scout can register multiple named, per-user scheduler jobs. Scheduling is optional and a job's first enablement requires a successful supervised scan. Once a job exists, its time, days and model can always be changed — and it can be disabled or re-enabled — regardless of whether a later run was healthy, stale or skipped. Each job is enabled, changed and disabled independently.

First-run setup offers only the provider selected for the workspace, for example a Codex primary scan. A second compatible provider appears only after choosing **Add verification pass** in **Settings → Scans & schedule**. It is never enabled implicitly.

## Choosing which days a job runs

Each job runs on a set of weekdays. **Days** offers five choices:

- **Every day** — the default, and what existing schedules keep after an upgrade.
- **Alternating with the other provider** — the primary job runs Sunday, Monday, Wednesday and Friday; the verification pass runs Tuesday, Thursday and Saturday. The two providers never scan on the same day, which halves daily provider usage and gives each scan a fresh day of postings to find.
- **Alternating weekdays (no weekends)** — the primary job runs Monday, Wednesday and Friday; the verification pass runs Tuesday and Thursday.
- **Weekdays only** — Monday to Friday.
- **Custom days** — tick individual days.

A day set of Sunday to Saturday is stored as `days` on each schedule job, with Sunday as `0`. Windows uses a weekly Task Scheduler trigger, Linux prefixes `OnCalendar` with the day names, and macOS lists one `StartCalendarInterval` entry per weekday. A job with every day selected keeps its simpler daily trigger.

Scout deliberately uses weekdays rather than an "every N days" interval: only a weekly pattern is expressed natively and identically by all three schedulers, and two jobs meant to alternate stay aligned after a missed or catch-up run.

An optional two-provider VPS schedule is:

- `claude-primary` at 07:30 in `primary` mode;
- `codex-second-pass` at 08:30 in `second-pass` mode.

Run both every day for the fastest turnaround, select **Alternating with the other provider** to spread them across the full week, or select **Alternating weekdays (no weekends)** to use Monday to Friday only.

Linux timers pin the workspace IANA timezone (normally `Europe/London`) in `OnCalendar`, so daylight-saving changes do not shift the intended wall-clock time even when the VPS itself runs UTC.

When two jobs share a day, the one-hour gap exceeds Scout's 45-minute native execution limit. The workspace lock remains authoritative: if a prior scan is still active, the later run is recorded as skipped and never overlaps it.

## Install and inspect

```powershell
scout schedule install --id claude-primary --time 07:30 --provider claude --mode primary
scout schedule install --id codex-second-pass --time 08:30 --provider codex --mode second-pass

# Or alternate them across the week (Sunday is 0):
scout schedule install --id claude-primary --time 07:30 --days 0,1,3,5 --provider claude --mode primary
scout schedule install --id codex-second-pass --time 08:30 --days 2,4,6 --provider codex --mode second-pass
scout schedule status
scout schedule run-now --id claude-primary
```

Add `--model MODEL` to `schedule install` to pin a supported model for that scan job. The model is stored with the named job and passed to both direct and scheduled runs. Omit it to follow the provider default; job-conversation model choices do not leak into scans.

Each job receives a distinct native identity, such as `Scout Daily Scan - claude-primary`, `app.scout.daily-scan.claude-primary`, or `scout-daily-scan-claude-primary.timer`. Jobs run as the current user with least privilege, catch up after a missed trigger, and stop after 45 minutes.

On a headless Linux VPS, enable lingering for the dedicated Scout account so its user timers and D-Bus session remain available:

```sh
sudo loginctl enable-linger "$(id -un)"
systemctl --user status scout-daily-scan-claude-primary.timer
systemctl --user status scout-daily-scan-codex-second-pass.timer
```

## Change or remove

Re-run `schedule install` with the same ID to update one job. Remove jobs individually:

```powershell
scout schedule remove --id claude-primary
scout schedule remove --id codex-second-pass
scout schedule status
```

Remove all jobs before deleting or moving a workspace. Native scheduler status is authoritative. Uninstalling Scout does not implicitly remove saved jobs.

Scan metadata is written under `logs/` and `data/scan-runs.jsonl`. Do not share private prompts, workspace content, or provider credentials when diagnosing failures.
