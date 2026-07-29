# Canonical VPS state and automatic backup

This guide reproduces Scout's single-owner VPS model on a personal installation. In this model the VPS is the canonical Scout computer. A phone, tablet, laptop, or installed browser app is a remote view of that same process and workspace; clients do not keep independent Scout databases or clone the private repository.

## What “saved everywhere” means

Every permitted client connects through Tailscale Serve to Scout on the VPS. When a client changes an opportunity, CV, company record, chat, setup value, source credential, schedule, or scan result:

1. Scout writes the change to the VPS workspace first.
2. Scout queues a serialized Git checkpoint immediately after the write.
3. Ordinary workspace files are committed and pushed to the configured private repository.
4. Credentials, chat transcripts, generated PDF/DOCX files, and recovery state are encrypted with AES-256-GCM before their opaque recovery blobs are committed.
5. Startup and five-minute periodic checkpoints pull or retry any pending work after a temporary network or GitHub failure.

The response may say `savedLocally: true` and `syncQueued: true`: the durable VPS write has completed and the remote push is queued. **Settings -> Backup** shows `synced`, `offline`, or `needs attention` and the last successful time. Offline changes remain on the VPS and retry; Scout never force-pushes or silently resolves divergent histories.

Remote pages remain readable when backup is disabled, but Beta 16 rejects remote state-changing requests until encrypted private backup is enabled. Backup connection, disablement, deploy-key generation, and recovery-key display are host-local administration operations. This prevents a phone session from silently creating unbacked canonical state or changing recovery ownership.

## Scope and exclusions

The private repository contains readable tracked workspace records such as profile, tracker, reports, tailored CV sources, quality evidence, company history, and configuration. Scout's encrypted recovery area contains ignored source credentials, chats, generated PDF/DOCX files, onboarding recovery material, and selected device preferences.

Provider authentication stores and resumable provider session identifiers are never backed up. Tailscale identity, Serve mappings, operating-system services/timers, deployment keys, logs, caches, and VPS firewall configuration are host state and must be covered by the operator's VPS configuration records and snapshots. Restored chats intentionally start a new provider session.

## One-time owner setup

1. Install Scout under a dedicated, unprivileged VPS owner account and configure the reboot-safe service from [Host Scout on a private VPS](INSTALL_VPS.md).
2. Install Tailscale on the VPS and every client. Enable private Tailscale Serve access from Scout's host-local page. Do not use Funnel, a public listener, or router port forwarding.
3. Create an empty **private** GitHub repository dedicated to this Scout workspace. Do not reuse the public Scout application repository.
4. On the VPS host-local Scout page, select **Prepare VPS deploy key**. Add only the displayed public key to the private workspace repository as a write-enabled deploy key. The private key must remain in the VPS owner's `.ssh` directory.
5. In **Settings -> Backup**, connect the repository's SSH URL, for example `git@github.com:YOUR-ACCOUNT/YOUR-PRIVATE-WORKSPACE.git`, and choose a recovery passphrase of at least 12 characters.
6. Save the one-time `SCOUT-1-...` emergency recovery key in a password manager separate from the VPS. Confirm it in Scout only after verifying the saved copy.
7. Select **Back up now** and require status `synced` with a successful timestamp.
8. Restore into an isolated empty directory or replacement test host with the passphrase or emergency key. Run `scout doctor` and confirm expected records before relying on the backup.
9. Connect each client to the VPS Tailscale HTTPS address. Do not run a second writable Scout host against the same repository; all interactive clients should use the canonical VPS.

If adopting an older non-empty private repository, checkpoint the surviving local workspace into Scout's encrypted recovery format first. Then use the protected adoption procedure described in the release/incident documentation; Scout clones and validates into a temporary sibling, restores the existing encrypted data, completes a backup push, and atomically retains the old VPS workspace as `.before-adopt-<timestamp>`.

If the canonical VPS is already synced but the original passphrase is unavailable, do not initialize another recovery header or force-push a stale checkout. From the host-local maintenance path, rotate the recovery passphrase while the VPS still has its unlocked data key. Rotation changes only the passphrase-wrapped copy of that key; it preserves the encrypted file blobs and emergency-key wrapper, then must reach `synced` before the new passphrase is accepted.

## Divergence and push-pending recovery

Scout resolves divergence automatically only after fetching both tips,
verifying a clean worktree and proving that the changes are disjoint ordinary
additions or modifications. The confirmation is bound to the branch and both
analysed tips. Resolution holds the fenced lease and workspace mutation
coordinator, creates local and remote recovery references, revalidates the tips,
and uses a normal no-fast-forward merge. It never resets, rebases or
force-pushes.

If the merge succeeds but GitHub is unavailable, the local merge is canonical
and backup reports push-pending. Preserve the merge commit and both recovery
references. After connectivity returns, use **Retry**; Scout refetches and
revalidates before pushing the existing merge. Do not launch another writable
host or reconstruct the merge by hand. If a tracker/report mutation or scan
finalisation is active, wait for it to finish before resolving divergence.

Overlapping edits, renames, deletions, dirty files, changed tips, unusual Git
state or a failed merge remain manual-review cases. Retain both recovery
references and a VPS snapshot while investigating. Never remove `.git`,
`.scout/sync.json`, `.scout-backup/`, run journals or the fenced lease as a
recovery shortcut.

## Acceptance test

Complete this test from a phone or other remote client:

1. Confirm Backup shows `synced`.
2. Add a harmless dated note to a test opportunity.
3. Confirm the note remains after refreshing and after restarting the Scout service.
4. Select **Back up now** and confirm a newer successful timestamp.
5. Verify the private repository received a new Scout checkpoint without exposing a chat, credential, or generated PDF as readable tracked content.
6. Render a tailored CV and confirm its source remains visible and its PDF opens on the client.
7. Temporarily interrupt outbound GitHub access, make another harmless change, and confirm Backup reports `offline` or pending rather than losing the VPS write. Restore access, select **Retry**, and require `synced`.
8. Reboot the VPS and confirm the Tailscale URL, saved note, CV library, and backup status recover without an interactive SSH login.

Retain normal encrypted VPS snapshots as a second recovery layer. A Git repository is version history, not a substitute for host backups or safekeeping of the recovery secrets.

## Troubleshooting and handoff evidence

Record only non-secret evidence for the next maintainer: Scout version/commit, backup state and last-success timestamp, expected record/CV counts, Doctor result, managed Typst version, service health, and whether the Tailscale mapping is unchanged. Never paste repository credentials, passphrases, recovery keys, private hostnames, CV contents, chats, owner login, or deploy private keys into issues, release logs, or the public application repository.

For data boundaries see [Privacy and Data Handling](PRIVACY.md). For client access and identity enforcement see [Private Remote Access](PRIVATE_REMOTE_ACCESS.md). For release-only deployment separation see [Release Process](RELEASE.md).
