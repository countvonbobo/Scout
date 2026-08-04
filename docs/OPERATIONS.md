# Scout operations context

Read this before changing Scout. It explains which system is authoritative, where each kind of work belongs, and how a change reaches the maintained private deployment.

This file contains public architecture only. Private hostnames, account identities, local key paths, and recovery material belong in the private workspace's `docs/OPERATOR_CONTEXT.md`.

## System map

| System | Purpose | Authority |
| --- | --- | --- |
| Public Scout application repository | UI, server, providers, installers, templates, tests, public documentation, and release workflow | Authoritative for application code |
| Private Scout workspace | CV, profile, tracker, reports, applications, chats, workspace configuration, and encrypted recovery state | Authoritative for the owner's career data |
| Maintained private VPS | Always-on Scout process, private workspace checkout, provider sessions, schedules, and backup execution | Authoritative running host for the maintained deployment |
| Developer computers | Application development, review, testing, and private access to the VPS | Never an implicit second live workspace |

The public repository and private workspace are separate Git histories. Never copy private workspace files or commits into the public application repository.

## Maintained deployment

The maintained beta deployment uses one private, single-owner Ubuntu VPS:

- Scout listens only on `127.0.0.1:8459`.
- Tailscale Serve provides the owner-only HTTPS route; Funnel and public ports are not used.
- Codex and Claude authentication belongs to the dedicated unprivileged Scout account on the VPS.
- When an authenticated installed Codex client supports catalogue discovery,
  Scout invokes only the fixed read-only `codex debug models` argument vector
  through the resolved provider executable with `shell: false`. The probe has a
  7.5-second timeout, a 512 KiB boundary for each output stream, and accepts at most
  100 bounded structured model records. A successful result is cached for five
  minutes; failed, unsupported, malformed, oversized, or timed-out discovery
  uses the labelled bundled fallback instead of guessing from session logs.
  Executable paths, account/auth data, raw stdout/stderr, and rejected raw
  records never reach the UI, logs, or durable workspace state.
- Claude runs the 07:30 primary scan and Codex runs the 08:30 second pass in the workspace timezone.
- The fenced scan lease prevents overlap. A losing scan process may only append
  a compatible durable queue request; idle startup drains older compatible work
  before beginning new unqueued work, and interrupted claims resume under their
  original run identity.
- Recovery selects the newest run compatible with the requested mode, purpose,
  published profile, source/config fingerprint and versioned stage inputs. It
  records why newer incomplete candidates were skipped. Deterministic stages
  are reused only when their inputs match; assessment reuse additionally binds
  provider, model, prompt and schema provenance. Incompatible candidates become
  immutable partial or abandoned evidence. A provider change is explicit and
  creates new assessment provenance.
- The durable queue is an append-only journal. Manual requests expire after 24
  hours; scheduled requests expire at the next logical window or 12 hours,
  whichever comes first. Equivalent work deduplicates, scheduled equivalents
  coalesce, and stale/expired/superseded work never executes. On handoff, the
  oldest compatible manual request precedes the newest compatible scheduled
  request. Every transition remains auditable. A genuinely incomplete torn
  final queue append is content-addressed and quarantined before the valid
  prefix continues; complete invalid schema, digest or identity evidence fails
  closed, and compaction retains the recovery receipt.
- All startup and periodic backup checkpoints use the same fenced lease and
  shared mutation coordinator as scan and tracker/report mutation. A foreign
  owner produces a bounded pending result; lease loss stops the checkpoint
  without an unfenced retry. Short UI mutation bursts coalesce their backup
  request instead of immediately blocking the next reviewed action. Only
  successfully terminalised mutations and scans queue encrypted
  private-repository backup checkpoints. The scan keeps its fenced lease and
  heartbeat through the receipt-gated checkpoint. Runtime Git commands are
  asynchronous, time-bounded, and fence-checked around every mutation so the
  heartbeat remains live and a stale owner cannot start another mutation.
  The mutation guard records the host, process, process-start identity and a
  pre-spawn child-operation identity. A successor remains blocked while that
  Git child is live or its state is ambiguous; timeout terminates the complete
  process tree and observes close before releasing authority.
  Recovery-file encryption, writes, and fast-forward restores run in bounded
  chunks with event-loop yields and component-level fence checks. A timed-out
  Git command terminates its process tree and reaches `close` before the scan
  can stop its heartbeat or release the lease.
  Offline backup is retained as `succeeded-pending`; reconciliation requiring
  attention is retained as `succeeded-partial`. Both remain successful scan
  outcomes for exact scheduled-window coverage. Each successfully drained
  queued run owns its own checkpoint. A queued contender, stale, lease-lost,
  receipted-backup-pending, or failed preflight scan has no unfenced backup
  authority.
- A successful direct scheduled run durably covers only queued overlaps for
  the same schedule job, logical window, purpose, and execution fingerprint.
  Other windows and jobs remain queued.
- Query-bearing source URLs may exist only in the live in-memory discovery
  path used for liveness and deduplication. Stage artifacts, scan-input
  bundles, scan history, tracker entries, and reports retain HTTP(S)
  origin/path only. Semantic scan artifacts preserve bounded ordered clauses
  and operators, redact credential-shaped values as a whole fact, and retain
  a fact for every non-empty description clause. More than 64 distinct
  responsibility facts or mandatory signals fails the advert boundary
  explicitly; neither set is silently truncated.
- Ranked scan schema v5 retains one bounded explanation per unique vacancy and
  exact total/per-configured-source funnel equations. The configured collection
  source survives separately from vendor identity through normalisation and
  deduplication. Coverage rollups are available by source, employer, lane, role
  family, location, provider, run, date and bounded failure reason. More than
  10,000 unique vacancies fails the artifact boundary explicitly; it is never
  silently truncated into a misleading funnel.
- Ranked-profile migration creates a manifest-verified beta.22-compatible
  snapshot before profile state changes. The snapshot preserves the documented
  private workspace boundaries, including encrypted `.scout-backup` recovery
  data, but omits `profile/search` and fenced `.scout` runtime state.
  Snapshot capture holds the shared workspace mutation authority; CV, import,
  chat, company, environment and ranking publishers must acquire that same
  authority before changing any included path. Historical ranking renews and
  rechecks the publication lease before its immutable artifact is written.
  Publishing writes a separate immutable historical-ranking
  artifact for the new profile; it never rewrites tracker or scan decisions
  and labels unreconstructable old profile/scoring provenance as legacy.
  Rollback validation materialises only into a new workspace outside the live
  root, pins and rechecks both source-storage and destination-ancestor
  identities throughout copying, verifies every copied digest, and leaves the
  newer workspace untouched.
- Assessment work is split into stable provider batches of at most ten jobs,
  with smaller deterministic batches when the context budget requires them.
  The strict provider-neutral schema accepts nuanced responsibility fit,
  mandatory advert/profile evidence, transferable experience, uncertainties,
  strengths, concerns and a recommendation. Numeric scores, categories and
  deterministic exclusions remain trusted-runtime decisions. Each committed
  assessment binds provider, model, prompt, assessment-schema, profile and
  pipeline provenance.
  Valid job results are committed independently; invalid jobs receive one
  focused schema repair and one clean per-job retry. Recovery never resubmits
  completed jobs or batches. Durable request records contain only stable job
  references, input digests, bounded parameters and versioned provenance, not
  CVs, adverts, prompts, transcripts or raw provider responses.
- Device-local provider health uses `checking`, `ready`,
  `credentials-present-unverified`, `sign-in-required`, `login-in-progress`,
  `network-unavailable`, `rate-limited`, `cli-update-required` and
  `provider-error`. Checks run at startup, before manual/scheduled work,
  periodically while schedules are enabled and after login outcomes. A remote
  auth failure remains authoritative until a real remote success. A blocked
  provider creates deduplicated durable alert/run evidence and blocks only its
  own work; there is no silent substitution or automatic missed-window resend.
- Guided provider login is an owner-only, same-origin, CSRF-protected in-memory
  state machine. It uses only `codex login --device-auth` plus
  `codex login status`, or `claude auth login` with bounded code input when
  requested. Commands use trusted executables, fixed arguments, `shell: false`,
  a minimal environment, private working directory and bounded process/output
  lifetime. Claude logout is never automatic: a recent one-use failed session
  and fresh remote-auth recheck precede explicit `claude auth logout`.
- Tracker, daily-report and scan-run finalisation is one journal-authorised
  mutation plan. Scout persists the bounded intended content and target
  revisions before taking the shared workspace mutation coordinator, then
  rechecks the scan fence and revisions, atomically replaces each file,
  verifies embedded opaque identities and written digests, and journals one
  receipt. Recovery accepts matching written identities without replay and
  stops for review on conflicting or unverifiable state. Backup starts only
  after that receipt; a backup failure does not erase the successful scan.
- Normal tracked career files remain readable only inside the private repository; ignored sensitive recovery state is encrypted under `.scout-backup/v1`.
- Backup divergence is automatic only for a clean, fetched, disjoint pair of
  ordinary additions or modifications. Confirmation is bound to the branch
  and both analysed tips. Resolution owns the fenced lease and shared mutation
  coordinator, revalidates the tips, creates local and remote recovery refs,
  and performs a normal `--no-ff` merge. It never resets, rebases or
  force-pushes. Merge failure preserves both refs; push failure preserves the
  local merge as pending. Public status exposes only counts and sanitised
  affected areas.
- Full journals and referenced artifacts are retained for the newest 20 runs,
  all runs from the previous 30 days and every active, queued, partial, failed,
  unrepaired or recovery-referenced run. Compact terminal summaries are kept
  for one year. Storage pressure measures runs, artifacts and queue separately
  and refuses new durable work before journalling becomes unsafe.
  Reviewed cleanup validates and atomically writes an encrypted archive before
  deleting only explicitly selected eligible data under the active fence;
  interrupted cleanup resumes from the archive/receipt. Queue compaction keeps
  live work and required terminal evidence.
- The recovery, queue, provider-health and guided-login API/UI projections,
  diagnostics and release artifacts exclude credentials, retained or
  user-entered authentication codes, full prompts, CV/ad bodies, provider
  transcripts, raw stdout/stderr, raw run/auth state, private paths and tracking
  values. Codex guided login has one deliberate exception: its bounded,
  ephemeral device code is returned to and displayed for the authenticated
  owner while that in-memory session is active; it is never written to the
  workspace, logs, browser storage or backup. Provider/account state otherwise
  remains device-local. Run views use shortened IDs, sanitised ownership,
  allowlisted reason codes and bounded counts. This does not describe ordinary
  private workspace features: setup/app information intentionally shows the
  configured workspace path to its authenticated owner, and career files are
  displayed in Scout and included under the documented private-backup policy.

Do not assume a developer computer's local application checkout or workspace is live. Diagnose the VPS for production-like bugs unless the user explicitly reports a local-only installation.

## Task routing

- Application bug, UI, server, provider, installer, test, template, or public-documentation work: use the public application repository.
- Scan, CV, tracker, report, application, chat, or scoring work: use the private workspace on the authoritative host.
- Live service, timer, provider-session, Tailscale, or backup diagnosis: inspect the VPS read-only first, then change the public application or private workspace according to the cause.
- Deployment credentials, recovery keys, and host-specific identifiers: keep them outside the public repository.

Do not patch the live application checkout as a substitute for source control. Implement application fixes on a branch, test them, review them through a pull request, and deploy an immutable release. Emergency live changes must be explicitly authorised, recorded, and immediately reconciled back into the public repository.

## Establish current state

Never rely on a version number copied into prose. At the start of a relevant task:

1. Read this file and, when available, the private `docs/OPERATOR_CONTEXT.md`.
2. Confirm the public checkout branch, status, remotes, and recent commits.
3. Query the live host's loopback `/api/app-info` endpoint to learn its actual version, application root, and workspace root.
4. For scheduling or backup work, inspect native timer state and `/api/sync/status`.
5. Reproduce UI bugs against the private HTTPS address when the report concerns the live deployment; compare with a local synthetic workspace only when isolating the cause.

Access details differ by operator and must be discovered from the private operator context or approved local SSH/Tailscale configuration. Never guess, publish, or weaken host-key checking to gain access.

## Change and release path

1. Update the public checkout from `main` and create a focused `codex/` branch.
2. Use a disposable synthetic workspace for tests; never point development tests at the authoritative workspace.
3. Implement the change with regression coverage and update affected documentation and in-app guidance.
4. Run the complete test suite, release privacy audit, packaging checks, and relevant manual acceptance. For a workspace-format release, also migrate a production-shaped synthetic workspace, materialise its beta.22 rollback into a separate directory, compare every manifest digest and prove the live synthetic workspace retained its newer data.
   Platform packagers consume only the audit-created content snapshot, recheck
   its privacy-authorized digest immediately before and after packaging, and
   remove the sealed snapshot in a `finally` path. Each native artifact is first
   written inside a private, unpredictable directory on the destination
   filesystem (`0700` on Unix and a protected current-user-only DACL on
   Windows). Scout binds that privacy state, directory and every real ancestor to the
   repository root, authorizes the temporary file after the payload postcheck,
   then creates the final name atomically without overwrite. A destination
   collision or changed output identity fails closed. Pre-publication crashes
   can leave only the clearly named temporary directory and publication lock,
   which are eligible for identity-checked runner cleanup; once the atomic link
   succeeds, the authorized final inode exists even if temporary cleanup is
   interrupted.
5. Commit intentionally, push the branch, and open a pull request against `main`.
6. For release rehearsal, update the protected `codex/release-candidate` branch to the reviewed commit.
7. Tag the reviewed package version. The protected release workflow builds every platform, deploys the exact tag to the VPS, verifies health and rollback, and only then publishes.
8. Confirm the private URL, providers, schedules, backup, and restore path after deployment.

Pushing or merging a branch does not by itself update the live VPS.

## Maintenance contract

Critical mutable workspace records are replaced atomically. Scout writes new contents to a temporary file in the same directory, flushes that file, and then renames it over the canonical path. This covers configuration, tracker state, chats, company timelines, CV-quality records, onboarding state, scan artifacts, recovery metadata, and imported CV text. Code that adds another critical workspace write must use the shared atomic-write helper; temporary files are never a source of truth.

Multi-file onboarding activation additionally writes a prepared intent before
the first replacement and reconciles it at startup under the shared workspace
mutation authority. Proposal staging and discard cannot erase that intent;
conflicting post-crash bytes are preserved for review, and terminal marker
cleanup is idempotent. Setup approval is valid only while every activated file
matches the marker hash. Shutdown and restart synchronously gate HTTP, chat,
operation and startup-recovery admission, cancel managed child processes, await
admitted handlers and settle checkpoint producers, then drain acknowledged
backup batches and provider-health probes before process handoff. A failed
drain reopens admission and leaves the listener in place for a safe retry.

Update this file in the same pull request whenever any of these change:

- which host or workspace is authoritative;
- repository roles or branch/release flow;
- service account, service manager, ports, or Tailscale model;
- provider location or authentication model;
- scan job IDs, providers, modes, times, timezone, or overlap rules;
- backup transport, encryption boundary, trigger, restore path, or health reporting; or
- required development, acceptance, rollback, or deployment checks.

Update the private workspace's `docs/OPERATOR_CONTEXT.md` whenever a hostname, URL, local checkout path, SSH identity path, account name, current deployed version, or last-verified state changes. Public tests enforce this maintenance link, but the operator remains responsible for keeping private values current.
