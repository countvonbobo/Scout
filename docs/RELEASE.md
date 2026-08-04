# Release Process

Release only from this clean-history public application repository. Never copy commits, files, or Git history from a private workspace repository or a legacy mixed-history archive.

## Release gates

1. Start from a reviewed commit with a clean working tree. Complete the [documentation maintenance checklist](DOCUMENTATION.md), then run `npm ci`, `npm test`, `npm audit --audit-level=moderate` and `git diff --check`.
2. Complete code/security review, a fresh-workspace onboarding browser smoke test and representative CV import tests.
3. Configure personal markers for the audit without committing personal values. Run `npm run release:audit`; findings must be resolved, not waived casually.
4. Stage the allowlisted bundle:

   ```powershell
   node tools/build-release.mjs --stage-only
   ```

5. Manually inspect every staged path. It is the installer payload, not a public source repository. It must contain runtime UI/tools, templates, managed skills, dependencies, licence and bundled runtime only. It must not contain `profile/`, `cv/`, `data/`, `reports/`, `applications/`, `.env`, logs, scratch files, private docs, test fixtures or `.git`.
6. Build the unsigned Windows, macOS arm64/x64 and Linux x64 packages on their native GitHub runners. For a local Windows build:

   ```powershell
   npm ci --omit=dev
   node tools/typst-runtime.mjs install
   node tools/typst-runtime.mjs verify --compile
   $Version = (Get-Content package.json | ConvertFrom-Json).version
   node tools/build-release.mjs --installer --version $Version
   ```

   Set `ISCC_PATH` when required. The installer is named
   `Scout-<version>-windows-x64.exe`; it and `checksums.txt` are written to
   `installer/output/`. The current installer creates UI shortcuts but does not
   add the CLI to `PATH`. Start with no file at either final name: package
   publication never overwrites an existing artifact or checksum manifest.

   Every platform packager writes into a private
   `.scout-release-pending-<random-id>` directory under `installer/output/`
   while holding the local `.scout-release-publication.lock`. The output
   directory, lock, temporary directory and their real ancestor identities are
   checked without following symlinks or reparse points. Temporary directories
   use mode `0700` on Unix and a protected current-user-only DACL on Windows;
   that privacy state is rechecked with the directory identity. Packaging, payload
   postchecks and temporary-file authorization all finish before Scout creates
   publisher-owned sealed copies in a second unpredictable private directory
   that is never passed to the packager. Scout rechecks the temporary source
   while copying, records the authorized digests in a private transaction
   journal, and creates each final artifact name with an atomic, no-overwrite
   same-filesystem link to the sealed inode. The original ancestor fence and
   the complete sealed/final byte identity are rechecked after every link and
   again before the publication call succeeds. Scout flushes each sealed file,
   the full-identity transaction journal and its directory before the first
   link. After every final link is authorized, it publishes and flushes one
   unpredictable `.scout-release-completed-<id>.json` receipt containing the
   complete artifact authority; that small receipt remains after private
   temporary cleanup as the durable commit boundary.
   Packager or postcheck failure removes the temporary output; a cleanup failure
   retains only bounded runner-cleanup residue and never replaces the primary
   error with a raw filesystem path.

   If a process stops before promotion, no final artifact exists. After
   validating that the lock and pending directory are real children of the
   expected output directory and that no packaging process remains, the runner
   may delete that clearly temporary residue and rebuild. A stop during a
   multi-file promotion leaves the private lock, sealed copies and transaction
   journal as recovery evidence; some final names may contain authorized sealed
   inodes, but the publication call did not complete. Validate the journal,
   every recorded digest and every final inode as one set before either
   identity-bound rollback or acceptance. Cleanup first moves owned directories
   to unpredictable quarantine names, then empties the already-bound directory
   rather than recursively trusting the pathname; any substituted quarantine is
   retained and reported. A rollback failure is reported and
   retains this evidence instead of silently deleting it. If the process stops
   after the publication call succeeds, every final artifact is an authorized
   sealed inode and the matching durable completion receipt exists; only
   identity-bound temporary cleanup may remain. Never
   delete or overwrite a colliding final artifact automatically—investigate its
   provenance or use a clean output directory.
7. Test on clean Windows, macOS and Ubuntu runners: install; first launch; provider detection; supervised/scheduled scans; missed-run/overlap/timeout; upgrade; and uninstall preserving the workspace.
8. Tag the reviewed commit with the exact package version prefixed by `v`. The cross-platform workflow builds all packages, runs native smoke tests and required-marker audits, deploys and health-checks the exact tag on the approved private Beta VPS, then publishes one checksum manifest, a keyless GitHub/Sigstore attestation bundle covering every package digest, and the release notes. A failed or unapproved VPS deployment prevents publication. Follow [release package verification and signing](SUPPLY_CHAIN_SECURITY.md) for the ownership, verification, rotation, incident and remaining platform-signing contract.

Every reusable action in the release workflow is pinned to a reviewed immutable
full commit SHA. Treat an action update as a dependency change: review the new
commit, update the pin and rerun the complete release-candidate rehearsal.

### Release tags are immutable

Once a tag is pushed, never move, delete or recreate it. The workflow deploys "the exact tag", so a moved tag means the commit someone fetched earlier is not the commit the release now claims, and Scout's own update check verifies packages against the assets of that published tag. To correct a published release, bump the version and cut a new tag (for example `v0.1.0-beta.19.1`); leave the original tag and its release in place. Consider a GitHub tag-protection ruleset on `v*` so this cannot happen by accident.

## Private Beta VPS deployment

The tag workflow uses the protected GitHub Environment `beta-vps`. Configure an owner approval rule and restrict it to release tags. Store these values as environment secrets, never in the repository:

- `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` for a narrowly scoped Tailscale OAuth client allowed to create ephemeral `tag:scout-deploy` nodes;
- `SCOUT_VPS_HOST` containing the private Tailscale hostname;
- `SCOUT_VPS_SSH_PRIVATE_KEY` containing a deployment-only Ed25519 private key;
- `SCOUT_VPS_SSH_KNOWN_HOSTS` containing the separately verified, pinned VPS SSH host-key line.

Tailnet policy should allow `tag:scout-deploy` to reach only TCP 22 on the Scout VPS. Install the matching public key only for the unprivileged deployment user. The VPS sudoers policy should allow that user to run only `/usr/bin/systemctl restart scout-host.service` without a password; validate the file with `visudo`.

The OAuth client needs only the `auth_keys` scope and permission to create `tag:scout-deploy` devices. The workflow sends [the reviewed deployment script](../tools/deploy-vps.sh) over the private SSH connection. It refuses a dirty or unexpected checkout, verifies that the release ref resolves to the workflow commit, runs `npm ci`, installs and verifies the pinned app-local Typst runtime, runs `npm test`, restarts the service, checks the version on `127.0.0.1:8459`, confirms the Tailscale Serve configuration did not change and runs the remote-hosting preflight. On failure after checkout, it restores the previous application commit and dependencies before restarting the service. It never changes the separate workspace or provider credential directories.

Before tagging a release, update the protected, stable `codex/release-candidate` branch to the reviewed commit and manually dispatch **Cross-platform release candidate** from that branch with the exact `package.json` version and **Deploy VPS** selected. First select **Test rollback** while the VPS still runs the previous commit; that job must fail deliberately and log a healthy rollback. Then dispatch it again without **Test rollback** and require success. Workflow dispatch never enters the publication job.

Record live acceptance in the pull request or release record. Confirm owner access, rejection of a different Tailscale identity, crash recovery, reboot recovery, provider authentication, both scheduled jobs, a completed encrypted backup, and a temporary isolated restore. Do not keep a completed acceptance checklist as a current root document.

## Required privacy review

Search tracked files, staged output, installer contents and all public Git objects for real names, email/phone/address/postcode, employers, CV phrases, salaries, opportunity IDs and secret assignments. Use synthetic screenshots and fixtures only. If a secret entered any commit, rotate it and rewrite the unpublished clean-history branch before sharing.

The release audit detects configured personal markers and likely secret assignments, but it is not proof of anonymity. Manual review remains mandatory.

## Versioning and rollback

Use semantic application versions and explicit workspace `schemaVersion`. Release notes must identify migrations, privacy/network changes, provider/source changes and manual actions. Retain the previous installer and checksums for rollback, but never publish a private workspace or its backups.

Windows and macOS beta packages remain operating-system unsigned until operator-controlled publisher credentials and policy exist. Checksums verify bytes only; the tagged-release workflow's keyless GitHub/Sigstore attestations separately bind package digests to this repository and workflow. See [release package verification and signing](SUPPLY_CHAIN_SECURITY.md).
