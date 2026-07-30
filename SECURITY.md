# Security policy

## Supported versions

Scout is in beta. Security fixes are applied to the latest published `0.1.x` release only. Upgrade before reporting behaviour from an older build.

## Reporting a vulnerability

Do not open a public issue containing a vulnerability, credential, CV, profile, tracker, application, or other private workspace data.

Use GitHub's **Report a vulnerability** private advisory form on the public repository. If that form is unavailable, contact a maintainer privately through the address shown on the repository owner's profile and include only the minimum reproduction details.

Please include:

- affected Scout version, operating system, and operating-system version;
- whether the installer or a source checkout was used;
- a reproduction using synthetic data;
- impact and any suggested mitigation;
- whether you believe credentials or personal data were exposed.

Do not attach a real workspace. Redact tokens and use synthetic names and CV content. Maintainers will acknowledge a complete report, investigate privately, and coordinate disclosure after a fix is available.

## Security boundaries

Scout listens on the loopback interface and stores personal data locally, but local-first does not mean risk-free:

- An AI scan sends relevant workspace content and prompts to the selected provider under that provider's terms and data controls.
- Adzuna credentials are stored in the workspace `.env`; provider login credentials remain managed by the provider CLI.
- The local Git repository records workspace history. Deleting only the latest file does not remove it from old commits.
- Anyone or any process with access to the host account may be able to read the workspace.
- Imported documents and job pages are untrusted input. Scout should not treat instructions embedded in them as authority to disclose data, send messages, or run unrelated commands.

Keep the operating system and provider CLIs current, use a private encrypted backup, and never place a workspace inside a public or automatically synchronised repository without understanding that service's privacy settings.

## Release integrity

Tagged releases produced by the current workflow include SHA-256 checksums and a GitHub/Sigstore keyless attestation covering each package digest. Verify both as described in [release package verification and signing](docs/SUPPLY_CHAIN_SECURITY.md). The release pipeline must also run the automated personal-data and secret audit described in [docs/RELEASE.md](docs/RELEASE.md).

Windows and macOS beta packages remain operating-system unsigned, so SmartScreen or Gatekeeper may warn. A checksum detects changed bytes and an attestation binds those bytes to the Scout release workflow; neither proves that the package is trusted, vulnerability-free, or natively signed by an operating-system publisher.
