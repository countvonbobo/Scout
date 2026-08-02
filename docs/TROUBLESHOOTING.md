# Troubleshooting

Start with `scout doctor --workspace PATH`. Keep error reports synthetic and never attach a real workspace, `.env`, CV or provider log.

## Scout cannot find the workspace

Confirm the directory contains `workspace.json`. Check `--workspace` first, then `SCOUT_WORKSPACE`; command-line selection takes precedence. Quote paths containing spaces. Run `scout workspace init` only for a new/empty intended destination.

## Invalid or newer workspace schema

Restore valid JSON from a private backup or correct the reported field. Do not reduce `schemaVersion` to bypass a newer-schema error; install a compatible Scout version. Migration backups are under `.scout/backups/`.

## Beta.22 rollback snapshot is missing or damaged

Do not point beta.22 at the newer live workspace and do not edit a snapshot
manifest to make verification pass. Stop Scout and run
`scout workspace snapshot-beta22 --workspace PATH` to inspect the newest
verified compatibility point. Materialise it only into a separate absent
directory with `scout workspace rollback-beta22 --workspace PATH --to PATH`.
If the command reports a missing file, digest mismatch, symbolic link or
incompatible schema, preserve both workspaces and restore a verified private
pre-activation backup. The rollback command never overwrites the live
workspace.

## Provider not found or not authenticated

Run the provider's `--version` and authentication status command in a new PowerShell window. Restart Scout after `PATH` changes. Clear unsupported `ai.model` overrides. See [Providers](PROVIDERS.md).

## CV import fails

Files must be PDF, DOCX, Markdown or plain text and no larger than 10 MB. Password-protected, malformed and image-only/scanned PDFs cannot be extracted reliably; decrypt or OCR a private copy locally, then review extracted text before accepting it.

## Adzuna is unavailable

Confirm both variables exist in the selected workspace `.env`, without quotes accidentally becoming part of their values. Test `scout source adzuna`. Missing Adzuna credentials are non-fatal; invalid credentials, quota and network failures should be recorded as reduced coverage.

## A promising vacancy was not assessed

Open **Jobs -> Review this scan**, then expand **Why roles missed detailed
assessment**. Scout shows the deterministic score and a stable reason, including
the relevance threshold, diversity limit, assessment capacity, seeded
exploration, an unchanged prior decision, a closed advert or second-pass scope.
Expand **Coverage by source** to compare found, ranked, selected, excluded and
assessed counts. Do not infer that every found vacancy was sent to the provider.
If the displayed total and source funnels do not reconcile, preserve the run
record and stop; schema-v5 writers fail closed rather than publishing that state.

## Scheduled scan does not run

Check `scout schedule status`, confirm the native scheduler entry points to the current application/workspace and run `scout schedule run-now`. Inspect workspace logs and Task Scheduler, launchd, or systemd-user history. Remove/reinstall the schedule after moving a workspace.

If Scout reports a provider-health block, open **Settings -> AI providers**.
`sign-in required`, `network unavailable`, `rate limited`, `CLI update
required`, and `provider error` are distinct conditions. Fix only the named
provider and retry explicitly; Scout does not substitute the other provider or
automatically replay a missed scheduled window. Guided sign-in uses the fixed
Codex device flow or fixed Claude login flow. If it is unavailable, use the
manual command shown in Settings. Claude credential clearing is offered only
after a fresh expired-credential failure and always requires confirmation.

## Interrupted scan, recovery, or lost lease

After a process exit or machine restart, start Scout normally. It validates the
append-only run journal, the rebuildable manifest, the persisted lease expiry
and the previous process-start identity. It then resumes the newest
stage-compatible run; it may reuse deterministic stages while restarting
assessment when provider/model/prompt/schema/profile/pipeline provenance
changed. A provider-neutral assessment-schema upgrade therefore restarts
incompatible assessment work without recollecting or reranking compatible
deterministic stages. Newer
incompatible candidates are left as bounded `partial` or `abandoned` evidence,
not rewritten.

Do not delete `.scout/scan-lease.json`, `.scout/scan-queue.jsonl`, a run
journal, or a legacy `.scout-scan.lock` to make work continue. A live,
unexpired or unverifiable owner must be stopped and allowed to reach its
takeover margin. Stop every older Scout process before the first fenced
activation. Once activated, the fenced lease is authoritative; an older Scout
binary or a new legacy lock is a downgrade/coexistence conflict, and Scout
refuses to run until only the current version remains.

If a terminal run remains visible because lease cleanup was interrupted, leave
it in place. A successor validates the terminal journal and removes or
supersedes the stale lease safely after expiry. If Scout reports a corrupt
journal, preserve the workspace and the exact bounded error. It can quarantine
only a torn final append; hash, identity, schema or mid-history corruption fails
closed and requires restoring that run state from an encrypted backup or
operator review. Never hand-edit journal hashes or copy events between runs.

Queued manual overlaps expire after 24 hours. Scheduled overlaps expire at the
next window or 12 hours, whichever is earlier. Expired, stale, superseded and
deduplicated requests remain auditable but do not run. After release, the oldest
compatible manual request is handed off before the newest compatible scheduled
request.

## Storage pressure or interrupted cleanup

Scout measures run journals, derived artifacts and the queue separately. It
retains the newest 20 runs, 30 days of full history, one year of compact
terminal summaries, and every active, queued, partial, failed, unrepaired or
recovery-referenced run. If a warning becomes a refusal, preserve the workspace
and collect only bounded diagnostics. Scout will not silently delete
recovery-critical state.

An interrupted cleanup is resumable from its verified encrypted archive and
receipt. Do not remove the archive, receipt, run directories or queue journal
manually. The current release contains the fenced archive/cleanup engine but no
general UI or CLI entrypoint. An integration or operator tool that began the
reviewed cleanup must resume the same selection; otherwise preserve the whole
workspace and escalate with bounded diagnostics. If the archive fails
authentication or the fence changed, preserve all source data and investigate
before selecting anything again.

## Port or UI problem

Scout serves the UI on loopback at `http://127.0.0.1:8459`. Close stale Scout processes before retrying. Do not expose the port to the network. From source, run `npm test` before `npm start` and inspect terminal output.

If an already-open page still shows an older layout after Scout itself was upgraded, refresh it once. Current Scout builds compare the loaded interface with the serving process and display **Scout updated — Refresh Scout** when they differ. Scout never performs that refresh silently; save or close active CV edits, chats, scans and settings first.

The same protection applies when a new service worker is ready: Scout keeps the refresh pending while CV edits, settings, chats, scans or setup operations are active. A remote restart requires explicit confirmation and is refused until active work has drained; retry after the operation finishes.

The header backup status opens **Backup details**. Use **Advanced backup settings** from there for configuration. The main **Settings** button opens the sectioned settings hub; first-run onboarding appears automatically only for an unfinished workspace.

An authenticated remote owner can open Scout and review settings through the private Tailscale address. Scout does not request or display the emergency recovery key remotely; recovery-key handling remains available only on the Scout host and must not prevent the remote interface from loading.

On macOS, use the Scout menu's **Open Scout** and **Show diagnostic log** actions. A packaged startup failure should display an alert naming the log. If Finder still does nothing, verify the DMG checksum, move Scout into Applications, use Control-click → Open once, and inspect `~/Documents/Scout Workspace/logs/ui-stdout.log` before reporting a synthetic error summary.

If Setup temporarily cannot reach the local Scout server, select **Retry** after the server is available. Retry reconnects in place: it does not reload the page or discard answers you have entered in the current onboarding or retuning step.

## Private backup cannot be enabled

Backup is optional. Confirm Git and Git Credential Manager are installed, restart Scout after installation, and use a credential-free `https://github.com/owner/repository` URL. Connecting a local workspace requires an empty Private repository; use **Restore my existing workspace** for a repository that already contains Scout data. Scout refuses public repositories and refuses to push `.env`, generated PDF/DOCX files or other sensitive ignored paths when they are already tracked in Git.

## Backup is offline, pending, or needs attention

**Offline — saved locally** means Scout made a local commit and will retry later. **Needs attention** can mean both the Scout host and GitHub have new history. Open **Backup details**, then **Advanced backup settings**. Scout offers **Preserve both and sync** only after it has fetched both tips, verified that the worktree is clean, and confirmed that the two histories changed separate ordinary files. The action creates recovery references and uses a normal merge; it never resets, rebases or force-pushes. Overlapping changes, renames, deletions, dirty files, stale confirmations and unusual Git state remain manual-review cases. Never delete `.git`, `.scout/sync.json` or `.scout-backup/` as a conflict workaround.

If the normal merge committed locally but its push was interrupted, leave the
merge and both recovery references intact. Backup remains push-pending and a
normal Retry resumes from that local merge after refetch/revalidation. Do not
start another resolution, reset the branch, rebase or force-push. If ordinary
tracker/report work is still active, wait: divergence resolution and workspace
mutation share one coordinator and must not overlap.

## A scan reviewed candidates but kept zero

This is not automatically a failed scan. Scout shows the number reviewed, number kept and the discard breakdown (hard exclusions, mandatory gates, below-threshold results and provider assessment discards), with links to the bounded candidate audit and dated report. Check source health first. If a first/manual primary scan keeps zero, Scout automatically runs one broader discovery pass while retaining every approved gate. If both passes keep zero, use **Review this scan** to inspect concise role-level reasons. Do not weaken a genuine hard gate merely to produce results.

## A PDF is missing, stale or blank

Select the master or tailored source and use its **save changes** and **render PDF** actions, which report independent outcomes: saving persists the source without rendering, and rendering compiles the last saved source without rewriting it. Keep Scout open while the background operation runs. A source edit makes the previous PDF stale immediately; render again after saving. If rendering fails, Scout preserves the old file and confirms the saved source is intact, but will not preview or download the stale PDF as current. Run `scout doctor` and repair/reinstall Scout when the managed Typst runtime is missing. Do not install an unrelated system Typst merely to mask a damaged package.

Scout refuses to start a scan when the approved profile, calibration or master CV is incomplete. If Setup reports an empty activated master CV and offers the validated recovery control, use it there; Scout backs up the current file and restores only the hash-checked reviewed staging copy. If the control is unavailable, preserve the workspace and inspect the reported mismatch.

If your restored PDFs show as needing re-rendering, verify your `.gitignore` tracks the render manifest. Workspaces created before Scout `0.1.0-beta.21` will self-heal their ignore rules on the next start. If you are editing `.gitignore` manually, replace the bare `.scout/` line with these two lines to ensure your render state survives a backup:

```gitignore
.scout/*
!.scout/cv-renders.json
```

## A tracker change conflicts with a scan

Scout briefly waits when a scan is finishing, then refreshes and retries a stale tracker change once. If the scan is still running, Scout reports that it did not overwrite the tracker. Wait for the scan to finish and repeat the change; do not edit `data/opportunities.json` or remove `.scout-scan.lock` while a live scan is active.

## Restore fails

Restore requires an empty target folder, the private repository HTTPS URL, and either the passphrase or emergency recovery key. Scout rejects malformed/tampered recovery data, symlinks, unsupported workspace schemas and workspaces that fail `scout doctor`. Codex/Claude authentication is not restored; sign in to the provider separately. Startup and scheduled scans require explicit confirmation on the new computer.

Scout validates the restored workspace both before and after activation. If the post-activation check fails, it removes the rejected restored data and returns the original empty target folder instead of leaving a partly activated workspace behind.

## SmartScreen or checksum mismatch

Unsigned beta installers may trigger SmartScreen. Compare `Get-FileHash -Algorithm SHA256` with the release checksum. If it differs, do not run the file; download again from the official release. A matching checksum does not replace antivirus scanning or code signing.

Scout streams an in-app update into a restricted temporary file and computes SHA-256 as bytes arrive. It renames the package to its final download name only after the complete checksum matches; an interrupted, oversized or mismatched download removes its partial file and does not replace an existing verified package.
