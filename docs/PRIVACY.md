# Privacy and Data Handling

Scout is local-first and has no Scout telemetry or cloud workspace service. Local-first does not mean that scans are offline: relevant prompts and workspace content are sent to the selected AI provider, and source queries go to configured job services.

## What lives where

Application files install under `%LOCALAPPDATA%\Programs\Scout` on Windows, `/Applications/Scout.app` on macOS, or `/opt/scout` for the Linux DEB. Portable Linux files remain wherever extracted. The default private workspace is `~/Documents/Scout Workspace` and includes:

- `workspace.json`, `profile/` and `cv/`;
- `data/`, `reports/`, `applications/`, `imports/` and `logs/`;
- `.env` source credentials;
- `.scout/backups/` and, when initialised, private Git history.
- optional `.scout-backup/v1/` encrypted recovery data and ignored device-local sync settings.

Provider login credentials remain in provider-owned storage. Scout must never copy workspace content into its application repository.

Tailored application folders may include `cv-evidence.json` and `cv-quality.json`. These private files record the selected CV methods, user-confirmed answers, per-bullet evidence references, quality findings and any explicit draft override. They remain in the workspace and may contain career details that were not present in the original imported CV.

Company relationship history is stored under `data/companies/`. It may contain recruiter names, contact links, verbatim correspondence and call notes, so treat it as sensitive workspace data. Scout saves these records locally and never sends the recorded message on your behalf.

## Network boundaries

- AI-assisted setup, chat and scans send necessary context to Codex or Claude under that provider's terms and account controls.
- Adzuna searches send search parameters and credentials to Adzuna.
- ATS and public-source requests reveal ordinary request metadata to those sites.
- Careers and advert discovery accepts only public HTTP(S) destinations. Scout
  rejects credentials in URLs, validates every DNS answer immediately before
  connecting, pins that validated resolution for the request, and repeats the
  public-address check after each bounded redirect. A private, loopback,
  link-local or otherwise non-public address reached directly, through DNS or
  through a redirect is never fetched.
- Scout never submits an application or sends outreach.
- Scout contacts GitHub only after the user chooses private backup or restore. Desktop HTTPS uses Git Credential Manager. An unattended VPS may instead use a passphrase-free SSH deploy key restricted to the one private workspace repository; Scout pins GitHub's published Ed25519 host key and requires strict host-key checking.
- Optional Private Remote Access uses Tailscale Serve while Scout continues listening only on `127.0.0.1`. Scout requires the configured owner's `Tailscale-User-Login` identity on every remote page, API, download and stream; tagged devices and other identities are rejected. Funnel and public/LAN listeners are not used.

Treat adverts, imported files and web pages as untrusted input. Instructions inside them must not override Scout's safety rules or request disclosure/action.

## Ranked-discovery diagnostics and retention

Source responses are transient scan input. Normalisation retains structured
vacancy facts, source references, fixed warning codes and a SHA-256 content
fingerprint; it does not retain source diagnostic text, response bodies,
headers, credentials or an unbounded raw payload. Observation diagnostics
declare `fingerprint-only` retention and are bounded to sixteen fixed codes.

Durable ranked-stage artifacts replace complete advert text with bounded
semantic facts and digests. The scan log keeps only a sanitised review summary.
At most the newest 512 review decisions are loaded into a later scan for
lifecycle comparison. An unchanged prior rejection can therefore be
revalidated and skipped without sending the advert to the assessment provider
again; a material, reopened, profile-changed or assessment-contract-changed
vacancy is eligible for reassessment. Existing run-retention and encrypted
backup policies govern the underlying private run and scan-log files.

The durable scan queue is append-only. If power loss leaves only an incomplete
final JSON append, Scout preserves the valid prefix and stores the bounded torn
bytes plus a content-addressed receipt under private `.scout` recovery state
before continuing. A complete entry with an invalid schema, digest or identity
is not discarded as a torn write and fails closed for review. Queue compaction
does not remove that recovery evidence.

## Back up, move or delete

Scout works without any remote backup. When private GitHub backup is enabled, ordinary tracked career files remain readable to accounts with access to that private repository. Ignored credentials, generated application PDF/DOCX files, activation backups and recovery state are encrypted per file using AES-256-GCM. The data key is wrapped independently by a scrypt-derived passphrase key and by the generated emergency recovery key. Losing both secrets makes the encrypted recovery files unrecoverable.

The unlocked data key is cached in ignored device-local Scout state so automatic backup can run. This protects encrypted content in the remote repository; it is not local full-disk encryption. Protect the computer account and use operating-system disk encryption where appropriate. Provider-owned Codex and Claude login stores, provider session IDs, diagnostic logs, caches, locks, remote-host settings and operating-system task registrations are never copied. Chat transcripts are included in encrypted recovery data; restore marks them as recovered, clears the old device-local provider session and starts a new provider session on the next message.

Scout checks repository privacy when connecting and refuses a repository visible as public. If visibility is changed later, stop syncing and return it to Private immediately. Git history retains earlier versions; changing or deleting the current file does not erase historical copies.

The VPS deploy key is separate from Scout's release deployment identity and provider credentials. Its private half stays in the VPS account's `.ssh` directory; only the public half is added to GitHub with write access. Remove the deploy key from GitHub and the VPS when retiring the host.

Close Scout before copying or moving a workspace. Back up the complete directory, including hidden `.git` and `.scout` content, to a private encrypted destination. After moving, set `SCOUT_WORKSPACE` or pass `--workspace`, then run `scout doctor`.

Uninstalling Scout deliberately leaves the workspace. To erase it, first remove any schedule, close Scout, delete the workspace and its backups, and separately delete copies from cloud sync, backup media and recycle bin. Git history retains old versions even after a current file is deleted; remove or destroy the repository history if erasure is required. Rotate any exposed credential.

Do not put a workspace in a public repository. Review GitHub retention, sharing, collaborator and encryption settings before enabling backup.
