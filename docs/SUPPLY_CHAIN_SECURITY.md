# Release package verification and signing

Scout publishes SHA-256 checksums and GitHub artifact attestations for packages built by the current tagged-release workflow. Verify both before installing a package. The checksum detects changed bytes; the attestation links those bytes to the release workflow in `oliver-hitchings/Scout`.

Windows and macOS packages remain operating-system unsigned. Windows SmartScreen and macOS Gatekeeper therefore cannot yet identify Scout through an Authenticode or Apple Developer ID publisher certificate.

## Verify a downloaded package

1. Download the package, `checksums.txt` and `checksums.intoto.jsonl` from the same GitHub release.
2. Verify the package digest against `checksums.txt`:

   **Windows PowerShell**

   ```powershell
   Get-FileHash .\Scout-<version>-windows-x64.exe -Algorithm SHA256
   Get-Content .\checksums.txt
   ```

   **macOS**

   ```sh
   shasum -a 256 Scout-<version>-macos-<architecture>.dmg
   grep 'Scout-<version>-macos-<architecture>.dmg' checksums.txt
   ```

   **Linux**

   ```sh
   sha256sum --check --ignore-missing checksums.txt
   ```

   Compare the filename and the complete hexadecimal digest. Checksums verify bytes, not publisher identity, so continue with the attestation check.
3. Install the [GitHub CLI](https://cli.github.com/) and verify the package against Scout's public repository:

   ```sh
   gh attestation verify Scout-<version>-<platform-package> \
     --repo oliver-hitchings/Scout
   ```

4. Confirm that verification reports `oliver-hitchings/Scout` as the source repository. Stop if the checksum, repository identity or attestation verification differs.

An older release without `checksums.intoto.jsonl` predates this control. Its checksum can still detect changed bytes, but it has no Scout release-workflow attestation.

## Offline verification

Prepare the verifier on a trusted connected machine:

```sh
gh attestation trusted-root > trusted_root.jsonl
```

Transfer the package, `checksums.txt`, `checksums.intoto.jsonl` and `trusted_root.jsonl` to the offline machine through the approved path. After checking the checksum, verify:

```sh
gh attestation verify Scout-<version>-<platform-package> \
  --repo oliver-hitchings/Scout \
  --bundle checksums.intoto.jsonl \
  --custom-trusted-root trusted_root.jsonl
```

Refresh `trusted_root.jsonl` on a connected trusted machine for each new release or after a GitHub/Sigstore trust-root change. Offline verification proves against the captured trust state; it cannot discover later revocation or incident information by itself.

## Signing identity and ownership

The project has no long-lived project signing key for these attestations. For a tagged release, GitHub Actions issues the exact release workflow a short-lived GitHub OIDC identity. `actions/attest` obtains an ephemeral Sigstore signing certificate, records the attestation in the public transparency log and returns the bundle published with the release.

The repository owner controls who can approve and change the tagged-release workflow. The `publish` job alone receives `id-token: write` and `attestations: write`; build jobs and workflow-dispatch rehearsals cannot publish releases or attestations. Every subject digest is generated from `checksums.txt`, verified locally, verified again with `gh attestation verify`, and only then published.

Attestation establishes build provenance, not software safety. It does not prove that the source or resulting package is free of vulnerabilities or malicious behaviour.

## Rotation and dependency maintenance

There is no private attestation key to rotate. GitHub and Sigstore rotate the short-lived issuing infrastructure and trusted roots. Maintainers must:

1. update `actions/attest` only through a reviewed pull request;
2. run release-workflow tests and a release-candidate rehearsal after an update;
3. retain the published bundle with each immutable release; and
4. refresh offline trusted-root files rather than assuming an old root remains current.

If the repository, workflow or GitHub identity is suspected to be compromised, disable release publication, revoke affected GitHub sessions and tokens, rotate any unrelated environment secrets, and investigate the transparency-log evidence. Mark the affected release as compromised with a security advisory and prominent release notice. Never move, delete or recreate its tag. Publish a bumped replacement version after the workflow and repository are trusted again. Keyless attestation entries remain historical evidence; they cannot be erased or made trustworthy by rotating a non-existent project key.

## Remaining platform-signing work

Attestation does not replace native package signing. Completing operating-system publisher identity requires operator-controlled credentials and policy that are deliberately absent from the public repository:

- acquire an Authenticode code-signing certificate for the chosen Windows publisher identity, protect it in a release-only GitHub Environment, define approval and renewal procedures, and validate the signed installer on a clean Windows system;
- enrol the chosen Apple publisher identity, provision Developer ID Application signing and notarisation credentials in a release-only GitHub Environment, define approval and renewal procedures, and validate Gatekeeper assessment on a clean macOS system; and
- document the authorised legal/publisher identity, credential custodians, expiry monitoring, emergency revocation and replacement process before enabling either signing path.

Until those decisions and credentials exist, releases must continue to say that Windows and macOS packages are unsigned and users should expect platform warnings.
