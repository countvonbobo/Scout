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
- Claude runs the 07:30 primary scan and Codex runs the 08:30 second pass in the workspace timezone.
- The fenced scan lease prevents overlap. A losing scan process may only append
  a compatible durable queue request; idle startup drains older compatible work
  before beginning new unqueued work, and interrupted claims resume under their
  original run identity.
- Only successfully terminalised mutations and scans queue encrypted
  private-repository backup checkpoints. The scan keeps its fenced lease and
  heartbeat through the receipt-gated checkpoint; each successfully drained
  queued run owns its own checkpoint. A queued contender, stale, lease-lost,
  receipted-backup-pending, or failed preflight scan has no unfenced backup
  authority.
- A successful direct scheduled run durably covers only queued overlaps for
  the same schedule job, logical window, purpose, and execution fingerprint.
  Other windows and jobs remain queued.
- Normal tracked career files remain readable only inside the private repository; ignored sensitive recovery state is encrypted under `.scout-backup/v1`.

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
4. Run the complete test suite, release privacy audit, packaging checks, and relevant manual acceptance.
5. Commit intentionally, push the branch, and open a pull request against `main`.
6. For release rehearsal, update the protected `codex/release-candidate` branch to the reviewed commit.
7. Tag the reviewed package version. The protected release workflow builds every platform, deploys the exact tag to the VPS, verifies health and rollback, and only then publishes.
8. Confirm the private URL, providers, schedules, backup, and restore path after deployment.

Pushing or merging a branch does not by itself update the live VPS.

## Maintenance contract

Critical mutable workspace records are replaced atomically. Scout writes new contents to a temporary file in the same directory, flushes that file, and then renames it over the canonical path. This covers configuration, tracker state, chats, company timelines, CV-quality records, onboarding state, scan artifacts, recovery metadata, and imported CV text. Code that adds another critical workspace write must use the shared atomic-write helper; temporary files are never a source of truth.

Update this file in the same pull request whenever any of these change:

- which host or workspace is authoritative;
- repository roles or branch/release flow;
- service account, service manager, ports, or Tailscale model;
- provider location or authentication model;
- scan job IDs, providers, modes, times, timezone, or overlap rules;
- backup transport, encryption boundary, trigger, restore path, or health reporting; or
- required development, acceptance, rollback, or deployment checks.

Update the private workspace's `docs/OPERATOR_CONTEXT.md` whenever a hostname, URL, local checkout path, SSH identity path, account name, current deployed version, or last-verified state changes. Public tests enforce this maintenance link, but the operator remains responsible for keeping private values current.
