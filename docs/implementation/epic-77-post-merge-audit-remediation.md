# Epic #77 post-merge audit remediation

## Programme state

- Programme status: **ACTIVE — next beta paused**.
- Repository: `https://github.com/oliver-hitchings/Scout`.
- Exact starting and current `main`: `1f8310c0af50935c68978e95a916682bbb9cecec`.
- Remote verification: GitHub `main` was re-queried on 2026-08-04 and still matched the audited commit.
- Epic #77: open; current body last updated `2026-08-02T09:56:43Z` and byte-equivalent to the frozen body apart from a trailing newline.
- Issue #76: open; current body/comments last updated `2026-08-02T09:46:33Z`; four live provider-authentication checks remain operator-only.
- Existing open PR review: PR #15 is unrelated. No active PR duplicates this remediation programme.
- First worktree: fresh disposable isolated worktree outside every private workspace.
- First branch: `codex/epic-77-f1-release-packaging`, based directly on the exact `main` above.
- No tag, release, package publication, deployment, live-VPS mutation, real-workspace mutation, issue closure, merge, retarget, force-push, history rewrite or branch deletion is authorised by this programme.

## Audit identity and frozen inputs

| Input | Identity |
| --- | --- |
| Complete audit | `2026-08-02-epic77-review-2020.md`; 147,732 bytes; SHA-256 `ae4c86cb61234294e3d57c64e09d0c6d58d38b969d4983c448609ffb4a803df3` |
| Frozen Epic body | `epic77-body.md`; 21,369 bytes; SHA-256 `78b3a42bf8b6bf94639008aaba50e7404e0e5d77a15ca2a0e4b2516929b98ef9` |
| Frozen Epic JSON | `epic77-body.json`; SHA-256 `770a110f1c71e3acd547c8e00beb89efd8700eda30226eb4c5c0f078515bd1f9` |
| Audit integration range | `985ccdf8b95f3505aa713c739b38a37c0083c585..1f8310c0af50935c68978e95a916682bbb9cecec` |
| Audit environment | Windows/NTFS, Node 24.18.0, npm 11.16.0, Playwright 1.61.1; no Linux/macOS/live-VPS/private-workspace/provider execution |

The original attachments remain immutable and outside this repository. This ledger records corrected indexing and remediation evidence; it does not rewrite the audit.

## Editorial reconciliation

The following corrections are canonical for programme accounting:

1. The report contains **2 Critical, 10 Important, 14 Minor and 5 Provisional findings (31 total)**. The headline's `8 Minor` is inconsistent with the 14 distinct Minor IDs under its Minor-labelled headings.
2. The sentence saying `two Critical and seven Important` is stale. The report names exactly 10 Important findings: E-1, E-2, D-2, B-1, B-2, A-1, A-2, A-3, F-2 and C-1.
3. The report is complete across the six planned domains, subject to its expressly stated partial-coverage gaps. The final `Sections still to be written` footer is stale and non-authoritative.
4. Discovery/ranking review is complete with the partial coverage stated in §§1 and 12. The §12 next action to collect the B workstream is stale.
5. The report contains no `twelve operator items` phrase. Its §11 actually lists **8** numbered operator questions/checks; those eight are preserved below.
6. Gates B–D are wired into production while their Epic boxes remain unticked. This is Epic truth drift, not evidence that every individual criterion is accepted.
7. A green suite is supporting evidence only. It cannot overrule a failed real-function composition or packaging path.

## Corrected finding index

Verification status in this initial ledger is deliberately `unverified`: the audit evidence is strong, but the remediation programme must independently reproduce or statically prove each claim before changing production behaviour. `Beta gate` records the conservative initial release decision and may change only with evidence.

| ID | Severity | Provenance | Verification | Beta gate | Workstream | Required disposition and evidence | Branch / commit / PR / tests / CI / review |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F-1 | Critical | Epic-introduced | reproduced; repaired and independently approved at exact code head | **BLOCK: final evidence-only head CI** | 1 | Reproduce clean seal→assert failure; preserve pre-seal audit and read-only seal; authorise sealed digest; clean pass plus content/mode/path/link/add/delete/replace tamper failures; pre/post packager checks; primary error not masked by cleanup; execute real packager round trips; publish only authorized private temporary artifacts with atomic no-overwrite promotion. | Draft PR #84; exact code head `d165e1d9099b93b705e56aea0a170f2d9ab0b979`; focused 118/118; exact-SHA specification/code/security reviews APPROVE; CI run 30946243076 has six green jobs and one stalled Intel macOS attempt; see F-1 evidence below. |
| D-1 | Critical | Pre-existing but amplified by Epic authority model | unverified | **BLOCK** | 2 | Put adoption under shared mutation/OS exclusion; heartbeat and recheck fence through renames/receipt/publication; advance generation lineage; prove stale owners cannot write; crash-safe rollback; require service stop/restart ordering in workflow and operations docs. Synthetic roots only. | pending |
| E-1 | Important | Epic-introduced | unverified | **BLOCK** | 3/7 | Upgraded users must be gated on publication or shown an explicit legacy-discovery disclosure; ranked-stage/UI claims must match the actual engine; update troubleshooting and composition/browser coverage. | pending |
| E-2 | Important | Epic-introduced | unverified | **BLOCK** | 3 | Derive provider card, sign-in panel and verification offer from one health-gated presentation authority; contradictory signed-in/blocked states and suppressed remedies must be impossible. | pending |
| D-2 | Important | Epic-introduced | unverified | pre-beta truthfulness | 2/7 | Correct the one-way old/new coexistence claim and explicit stop-old-binary guidance; decide whether the never-written legacy sentinel branches should be removed. Do not resurrect continuous sentinel refreshing. | pending |
| B-1 | Important | Pre-existing but amplified by Epic scoring | unverified | pre-beta correctness | 5 | Derive Adzuna currency from queried country or keep it unknown; expose/derive country explicitly; validate compatibility; preserve currency provenance; migrate conservatively; remove hard-coded UK-English onboarding language. | pending |
| B-2 | Important | Pre-existing quadratic grouping amplified by Epic scale/prior reconciliation | unverified | pre-beta scale decision | 5 | Replace global quadratic grouping with semantics-preserving blocking/indexing; retain durable ID reconciliation; prove deterministic/idempotent/order-independent/cross-source convergence; preserve heartbeat; benchmark 2,500 and 10,000 cases and leave VPS remeasurement instructions. | pending |
| A-1 | Important | Epic-introduced | unverified | **BLOCK** | 4 | Compose real recovery selection with cleanup planning; pin only genuine current recovery obligations; terminal historical skips become eligible; retain audit trail; add bounded fenced recovery-selection compaction. | pending |
| A-2 | Important | Epic-introduced | unverified | pre-beta performance | 4 | Make inventory content digests lazy for measurement while cleanup/archive review retains full comparison; reuse scan health in one request; add stable 100 MiB measurement budget. | pending |
| A-3 | Important | Epic-introduced | unverified | after-beta unless host evidence escalates | 7 | Independently measure; if retained, add bounded tail verification with fail-closed full-validation fallback. Preserve the journal hash chain, fencing and torn-tail rules. | pending |
| F-2 | Important | Pre-existing | unverified | **BLOCK** | 6 | Pin every reusable action in any workflow receiving `secrets.` to reviewed immutable SHAs; test every secret-bearing workflow, not only privileged release jobs. | pending |
| C-1 | Important | Epic-introduced | unverified | **BLOCK** | 3 | Remote-auth failure remains authoritative during login mutation and until real remote success; visible login progress may coexist with underlying barrier; observe chat result before work release; add chat/fit/onboarding interleaving compositions. Keep #76 open. | pending |
| D-3 | Minor | unresolved | unverified | decide before beta | 7 | Re-check Windows path threshold and production consumers; use `core.longpaths=true` where justified and surface bounded reason codes without private paths. | pending |
| D-4 | Minor | unresolved coverage gap | unverified | pre-beta coverage | 2/7 | Run Windows junction versions of skipped migration tests and add direct physical-path/mutation-authority coverage where still absent. Existing guard correctness must not be weakened. | pending |
| E-3 | Minor | Epic-introduced drift | unverified | pre-beta documentation | 7 | Replace obsolete two-hour advisory-lock protocol and remove/update stale CLI authority claims. | pending |
| E-4 | Minor | Pre-existing but amplified | unverified | fix or defer explicitly | 7 | Reproduce accessible announcement and 381–700 px truncation failures; add correct live-region/role/title/layout behavior and browser evidence if confirmed. | pending |
| E-5 | Minor | Pre-existing but amplified; provenance unresolved | unverified | fix or defer explicitly | 7 | Reproduce two-tab out-of-order opportunity rendering; if confirmed, use the existing request-generation guard pattern. | pending |
| E-6 | Minor | unresolved | unverified | pre-beta truthfulness | 7 | Make commute copy explicit: current commute configuration affects assessment/context/display, not ranked-discovery filtering. | pending |
| B-3 | Minor | unresolved | unverified | pre-beta neutrality | 5 | Confirm provenance and interpolate the published workspace locale instead of hard-coded UK English. | pending |
| B-4 | Minor | Mixed/pre-existing thresholds amplified by new dimensions | unverified | product decision before beta | 5 | Decide whether small plural pools may bypass diversity caps; either enforce the stated anti-dominance rule or document a dated exception and expose relaxation/constraint status. | pending |
| B-5 | Minor | unresolved | unverified | pre-beta lifecycle correctness | 5/7 | Normalize reason-code vocabulary at the boundary; document/test the 384-record reassessment horizon or replace it with an explicit bounded policy. | pending |
| F-3 | Minor | unresolved | unverified | pre-beta release hardening | 6 | Reject nested `node_modules` under allowlisted trees; retain only reviewed top-level production dependency staging and privacy rules. | pending |
| C-2 | Minor | Epic-introduced | unverified | decide in provider PR | 3/7 | Either health-gate chat/fit consistently through the production preflight or explicitly defer/remove dead expectations without weakening auth-mutation exclusion. | pending |
| C-3 | Minor | Epic-introduced | unverified | schema/product decision before beta | 3/7 | Decide whether alerts are a product surface. Wire real API/UI acknowledgement excluding non-blocking states, or remove/defer machinery with a schema-compatible reader and corrected docs. | pending |
| C-4 | Minor | Epic-introduced disagreement | unverified | fix with provider truth | 3/7 | Make `/api/app-info` doctor and provider projections derive from the same health-gated authority. | pending |
| C-5 | Minor | Pre-existing | unverified | pre-beta privacy | 3/7 | Replace filesystem exception text with a bounded privacy-safe transcript-save failure; no private path may reach logs. | pending |
| PROV-1 | Provisional (Minor→Important) | Pre-existing artifact, gap amplified by Epic retention | unverified | pre-beta storage | 4 | Measure and prove; fold `.scout/scan-input/` into governed run artifacts or add explicit bounded retention/storage pressure without a parallel unsafe policy. | pending |
| PROV-2 | Provisional Minor | Provenance internally inconsistent; treat unresolved | unverified | explicit disposition | 7 | Compose production queue request→public status/UI projection; derive truthful purpose or remove the dead dimension without widening dedup semantics. | pending |
| PROV-3 | Provisional Minor | Epic-introduced | unverified | Epic decision before beta | 7/8 | Add truthful retrying/recovered states or record a dated product-spec vocabulary change; do not tick by interpretation. | pending |
| PROV-4 | Provisional Minor | Epic-introduced | unverified | explicit disposition | 7/8 | Either produce a real `unchanged` funnel outcome or remove the structurally dead counter and rely on existing lifecycle reason codes. | pending |
| PROV-5 | Provisional Minor | Epic-introduced | unverified | documentation truth | 7 | Qualify semantic-fact documentation to non-stopword/non-duplicate facts, or design a safe placeholder. Prefer the accurate documentation fix unless product evidence requires otherwise. | pending |

## Workstream plan and dependencies

1. **F-1 release packaging blocker** — independent branch/PR from current `main`. This ledger is its first commit. The first product-code change must be the RED clean seal→assert composition test after independent reproduction and a focused design/implementation plan.
2. **D-1 fenced workspace adoption** — separate branch/PR from accepted current `main`; synthetic roots only; service-stop workflow mitigation remains even after code repair.
3. **Provider authority and truthful UI** — C-1, E-2, issue #76 prerequisites, C-2/C-3/C-4 decision and C-5 privacy sanitisation; separate draft PR.
4. **Retention/storage lifecycle** — A-1, A-2 and PROV-1; real producer→consumer compositions and fenced compaction.
5. **Discovery correctness/scale** — B-1 and B-2, then explicit B-3/B-4/B-5 dispositions; split PRs when their safety arguments differ.
6. **Supply chain/packaged execution** — F-2 and F-3 plus staged-product execution and honest release-audit scope; adjudicate `--public-source` from history/consumer evidence rather than deleting by assumption.
7. **Remaining confirmed Minors, Provisionals, documentation and Epic truth** — every remaining row fixed, rebutted or deferred to a named issue/milestone with owner and rationale.
8. **Test-quality conversion across workstreams** — real production-function compositions for seal/package, recovery/retention, provider failure/auth mutation/preflight, config/Adzuna/normalisation/compensation, queue/status/UI and realistic scale/heartbeat budgets.

Independent workstreams should base on current `main`. A stack is allowed only where the parent dependency is real and is declared with both exact SHAs. One focused draft PR per safety argument is preferred. No PR is merged by this programme.

## Epic truth and acceptance state

- The next beta remains paused.
- The checked `Package and release audits pass` box is not supported: staging/audit passed, but F-1 means packaging cannot complete.
- The checked domain-neutrality and multi-currency claims are contradicted by B-1/B-3 until repaired or the product contract is changed honestly.
- The A6 anti-dominance claim needs the B-4 small-pool qualification or a code repair.
- Gates B–D contain production code but remain unticked; each checkbox needs requirement-level evidence before any change.
- A7 and funnel reconciliation have substantial audit evidence but their unchecked boxes are not changed in this programme until exact-main acceptance evidence and maintainer review exist.
- Issue #76 remains open after C-1 repair until all four live checks pass.
- Epic #77 remains open until all gates, operator acceptance and release evidence genuinely pass.

## Initial evidence inherited from the audit (not remediation completion evidence)

- Full Node baseline at audited SHA: 1,455 discovered; 1,453 passed; 0 failed; 2 environmental skips.
- Full Chromium+Firefox browser baseline: 186 total; 175 passed; 0 failed; 11 skipped.
- Durable-execution focus: 228 passed, 0 failed.
- Provider health/models/doctor focus: 28 passed, 0 failed.
- Provider login/auth mutation/chat focus: 119 passed, 0 failed.
- Release/build/workflow focus: 95 total; 94 passed; 0 failed; 1 skipped.
- Release audit: exit 0, 358 files with configured synthetic marker exercise in the audit environment.
- Not run: an actual platform package; Linux/macOS host execution; live VPS; real provider; real workspace.

These counts establish the reviewed baseline only. Every PR must record its own exact-head focused/full tests, CI run URLs/log inspection, platform limits, independent reviews and PR-range privacy/metadata audit.

## Operator-only and live checks

The audit's actual §11 contains these eight open checks:

1. Determine whether any platform package was ever built from code at or after introduction of `assertAuditedStage`; if one exists, reconcile its provenance separately.
2. Confirm the repaired clean packaging path on Linux and macOS native runners.
3. Re-measure A-2 and A-3 on the Ubuntu VPS without touching the real workspace contents.
4. Inspect live-VPS `.scout/runs` and `recovery-selections.jsonl` bounded sizes only after explicit operational authorisation.
5. Run issue #76's four live provider-authentication acceptance checks only after C-1 reaches accepted `main`.
6. Confirm `os.tmpdir()` permissions for the Scout service account and guided-login private-directory assumptions.
7. Confirm how a two-hour unheartbeated UI-tracker lease behaves if the UI dies before the scheduled scan.
8. Decide whether running `npm test` during live VPS deployment remains an accepted bounded operational step.

Additional operator/release-only gates from the Epic remain: native Windows/macOS/Linux packaging and installation, VPS migration/deployment/rollback rehearsal, provider sessions, owner access and Tailscale rejection, schedules, encrypted backup/restore, operating-system signing decisions, protected markers, tag/release publication and post-deployment acceptance. None is claimed here.

## Invariants that must not change

- Preserve the durable journal hash chain, fenced lease, generation lineage, mutation receipts, torn-tail quarantine distinction, guard exclusion, rollback isolation, canonical identity and privacy-safe durable projections.
- Do not remove `seal()` or mode bits from integrity protection as a shortcut around F-1.
- Do not simplify `withGuard` into a lockfile or weaken its identity-bound candidate/quarantine protocol.
- Do not merge owner-only `assertCurrentFence` with loser-safe `appendObservedScanQueueEvent`.
- Preserve embedded mutation marker + written digest + target revision as distinct checks.
- Preserve synchronous fence callback rejection of async functions/thenables.
- Preserve `isIncompleteJson`; do not replace its torn-tail distinction with plain `JSON.parse`.
- Preserve provider work and provider auth mutation as separate authority domains.
- Preserve the provider-health `USABLE_STATES`/`verified` distinction.
- Preserve verified no-follow regular-file reads and ancestor identity rechecks in release staging/audit.
- Preserve exact reviewed binary digests and fork-PR marker/secret separation.
- Preserve durable ID reconciliation in vacancy canonicalisation.
- Preserve recovery `skipped` evidence; change pin semantics, not history existence.
- Preserve fresh storage measurement; remove unnecessary content hashing rather than caching a stale result.
- Preserve fail-closed full journal validation fallback when optimizing append cost.
- Never silently delete recovery-critical partial/failed runs or private adoption residue.

## F-1 focused design and implementation plan

Independent reproduction on 2026-08-03 used the real `auditStageBeforePackaging`,
`verifiedAuditTreeDigest` and `assertAuditedStage` against a synthetic one-file
stage outside the repository. The file changed from mode `0644` to `0444` during
sealing; the audit digest and sealed digest differed; the untouched clean
snapshot then failed with `audited release payload differs from the
privacy-authorized snapshot`. No private marker, workspace or package was used.

Root cause: `auditStagedRelease` correctly authorises the copied snapshot before
sealing and the code correctly verifies that inspected digest before changing
anything. `seal()` then intentionally changes protected file modes. The return
value nevertheless carries the pre-seal digest, so every later assertion compares
the sealed state with an authority that describes a state which no longer exists.

The focused repair will use this protocol:

1. Keep the current audit and pre-seal `verifiedAuditTreeDigest(snapshot) ===
   result.treeDigest` check unchanged. This continues to prove that the inspected
   bytes/metadata are the copied bytes/metadata before any intentional mutation.
2. Seal the snapshot read-only exactly as today.
3. Traverse the sealed snapshot with the existing no-follow, ancestor-identity-
   checked audit reader and capture one sealed authorization state containing:
   the content/path/mode/link digest and a local identity digest over every file,
   directory and allowed link (`dev`, `ino`, size, mode and change timestamps as
   applicable). The identity digest is local ephemeral authority, not a release
   reproducibility digest.
4. Return the sealed content digest plus sealed identity digest. Recompute and
   compare both immediately before and after packaging. Content, mode, path,
   link, addition and deletion changes fail through the tree digest; same-byte,
   same-mode replacement also fails through the identity digest.
5. Keep the protocol local to release audit/build code. Do not unify the separate
   release digest formats or remove modes/sealing in this PR.
6. Add cleanup finalisation that preserves the primary packaging error when
   cleanup also fails, while appending only a fixed privacy-safe statement that
   a sealed payload was retained for runner cleanup. A cleanup-only failure also
   throws that bounded statement. No retained path or raw filesystem error is
   emitted.

Test order and acceptance:

1. First product-code change: add and run the clean production-function
   composition assertion; record the expected RED failure.
2. Make only the sealed authorization change and record the clean GREEN result.
3. Add a fresh-snapshot tamper matrix for content, file mode, rename/path,
   symlink (or supported platform equivalent), addition, deletion and same-byte
   replacement, plus cleanup-primary-error precedence.
4. Replace the source-regex packaging assertion with behaviour evidence while
   retaining useful structural assertions. Add a Linux CI step that executes
   the real `buildLinux` path after normal dependency/Typst setup and creates the
   native DEB and tar payload using a synthetic release marker.
5. Run focused release/build/workflow/privacy tests, staged audit, synthetic
   marker canary, `npm audit --omit=dev`, then the proportionate full Node and
   browser suites. Inspect the exact-head cross-platform CI logs and obtain
   independent specification, code and security/privacy reviews before any
   acceptance claim.

## F-1 implementation and local verification evidence

- Draft PR: `https://github.com/oliver-hitchings/Scout/pull/84`.
- Branch: `codex/epic-77-f1-release-packaging`, based directly on
  `1f8310c0af50935c68978e95a916682bbb9cecec`.
- Exact pushed and independently reviewed code head:
  `d165e1d9099b93b705e56aea0a170f2d9ab0b979`.
- Fixed base and current upstream `main`:
  `1f8310c0af50935c68978e95a916682bbb9cecec`.
- Commit map:
  - `e7294263331ec7abcc2453f3fd462d2d5153190d` — initial remediation ledger.
  - `143ffb7edb0b88411919fe3d8007398626a53d06` — focused sealed-snapshot design.
  - `0e3b42ed4f0f45eebd78b89ed398bfb6e1ffbbf7` — first product-code change:
    clean production composition RED test.
  - `514b0a385233f56043a0334d153455a583c93f90` — sealed tree/identity
    authorization, pre/post packager assertion, privacy-safe cleanup precedence,
    tamper matrix and real Linux CI packaging step.
  - `7e075813f091d78e510d3c295024f4e38bd9437c` — retain this active ledger while
    preserving the stale-plan documentation guard.
  - `6556502060f5bc5ee31bc3963e23532858ddeacb` — record pre-review local
    verification; this was the first reviewed PR head.
  - `db4df350ce958e44505dccedd277e8979254a021` — resolve review findings for
    preparation-cleanup reporting and transient ancestor substitution; authorize
    Debian's required `DEBIAN` directory mode while files remain read-only and
    the mode/identity/ancestor authorization remains tamper-evident.
  - `f265b367f40bf1b74ea9b531f48dd2a529a5d01c` — record the first exact-head
    reviewer verdicts and the unresolved temporary-publication security blocker.
  - `d33258f96d4c82db7cc434839b2c1edbf1fee6ec` — package every platform into a private, unique same-filesystem
    directory; validate Unix modes or a protected Windows DACL, real ancestors,
    directory/output identity and artifact identity; run all postchecks before
    atomic no-overwrite hard-link promotion; add bounded failure cleanup and
    crash-recovery semantics; and exercise Linux, Windows and both macOS CI paths.
  - `ab530f494e1f15c3bf8bb90803976747b61fd48b` — record artifact-publication evidence.
  - `5e374f1c69c9eb6c9a1bdda3d831cc1d42e828cf` — make the ancestor-substitution regression portable.
  - `ef76f70b15ff46af06bd098bc8179e3e01e9fe13` — enforce Windows publication privacy.
  - `0bfc6c83617830b6ddd7ae2eef4e60a679251a95` — validate normalized Windows ACLs.
  - `f9faefae63d526a5f9514a7c4bdb8365400e8bd6` — add bounded Windows privacy diagnostics.
  - `a29a13f3cc44b22146de094a660ed506eaecd905` — seal the publication transaction.
  - `8c3abf64583da8fb51747609cb610b54ceaa222e` — invoke Windows ACL validation safely.
  - `32bf8433753598aca68d537acdd65ef4c870b28f` — preserve the current owner while restricting Windows ACLs.
  - `5592058cb59fa8831d6056c686b2f007eadd8c9b` — make publication recovery durable.
  - `fdf1bde766994cbd359fdbda48e8192215f19637` — restrict the Windows publication ACL natively.
  - `915afd4eedf116316cd6b5470909e1a622799dd4` — bind the Windows ACL grant to the current SID.
  - `e1126838afe247af84d2119bcaadb18e0bf7d099` — classify the hosted Windows ACL-read failure.
  - `f6a4bfb7f3b73d6e91f668fb17c34f9e05a407f8` — try filesystem-API Windows ACL verification; superseded after hosted evidence.
  - `1b0a079f8da54e1c8472ee6be0f7f399759385cb` — verify the Windows publication DACL from SDDL.
  - `2eb511e5436cbf10e65e27a4f5cc9105743a1229` — classify the hosted SDDL representation.
  - `d9d08476ac3e192b580d04f054ab77626207552e` — isolate the DACL from the saved Windows descriptor.
  - `184947245bfad97ed8f8bce0954d064d701b13af` — verify the Windows DACL semantically.
  - `e855b6d9028466bbc7c824ad88555a14741ecae7` — rebuild the Windows publication DACL deterministically.
  - `0fff5b8d8b3dcd9ecdcc27f78e4027e210ab6091` — resolve the canonical Windows ACL principal.
  - `a2b2117eca9a0895823a13831285ede3485f8b2d` — classify a hosted Windows sealing failure.
  - `c6ef4bd186e99243cd5a8263dac6541e2a14a11e` — flush sealed files through a Windows write-capable handle.
  - `d165e1d9099b93b705e56aea0a170f2d9ab0b979` — close completion-receipt rollback,
    bound-directory cleanup and atomic rollback-quarantine races, with regressions.
- Independent reproduction: a synthetic one-file stage changed from mode `0644`
  to `0444`; pre-seal digest
  `df3328...` and sealed digest `9da773...` differed, and the untouched clean
  stage failed the real `assertAuditedStage` call with the bounded expected
  mismatch. No private workspace, provider, release or package was involved.
- RED evidence: the first production-code change ran one clean seal→assert test:
  1 total, 0 passed, 1 failed as expected. The same test passed after the repair.
- Focused release/build/platform/workflow/privacy/documentation verification at
  exact code head `d165e1d`: **118 passed, 0 failed, 0 skipped**.
  This includes content, mode, rename/path, symlink, addition, deletion and
  same-byte replacement cases. Publication coverage includes postcheck and packager
  failure, destination collision, competing publication, active ancestor
  substitution, cleanup failure, cleanup substitution before the child binds its
  cwd, pre/post-promotion crash boundaries, symlink/reparse ancestors, private-mode
  mutation, unexpected outputs, checksum authorization, transaction loss,
  completion-receipt validation failure and substitution during rollback.
- Full hosted Node suite at `d165e1d`:
  - Ubuntu: 1,487 total; 1,481 passed; 0 failed; 6 skipped.
  - Apple Silicon macOS: 1,487 total; 1,481 passed; 0 failed; 6 skipped.
  - Windows: 1,487 total; 1,484 passed; 0 failed; 3 skipped.
  - Dedicated Windows publication/DACL protocol: 22 total; 21 passed; 0 failed;
    1 platform-appropriate skip.
- Full Playwright suite after the publication implementation: 186 total; 175
  passed; 0 failed; 11 intentional skips; Chromium and Firefox; 2.9 minutes.
  Exact `d165e1d` hosted browser counts are Ubuntu Chromium 93/93, Ubuntu Firefox
  82 passed plus 11 intentional skips, and Windows Chromium 93/93.
- Documentation policy focus: 13 passed, 0 failed.
- Production dependency audit: `npm audit --omit=dev` found 0 vulnerabilities.
- Stage-only build passed. Required-marker release audit scanned 1,596 files
  with one synthetic marker, produced tree digest
  `5e9f9ec30c86c3c5c1f207911665544e82d0bf2070e9e8fb082b90d177154232`,
  and passed.
- Native packaging at exact code head `d165e1d` passed through the real packagers:
  Ubuntu produced the Debian package and Linux tar archive without
  `dpkg-deb --nocheck`; Apple Silicon macOS produced the DMG; Windows applied and
  verified the private DACL and produced the installer. All used audited private
  temporary publication. The Intel macOS attempt is discussed under hosted CI.
- Earlier local native macOS packaging passed through the real `build-platform.mjs mac` path
  after installing the pinned Typst 0.14.2 runtime. At local review-repair head
  `d33258f96d4c82db7cc434839b2c1edbf1fee6ec`, artifact `Scout-0.1.0-beta.23-macos-arm64.dmg` had SHA-256
  `243a334c9c8dd561676d369f7341776af23180da19ea3084ca8dfa238875d099`.
  It was created through private temporary publication; the final output was a
  regular one-link file in a `0700` output directory with no pending/lock residue.
  The artifact remains ignored in the disposable worktree and is not published.
- Interrupted/environment-limited attempts: the first unprivileged native macOS
  build could not use the host Clang cache/SDK, then passed under the approved
  host execution. The first sandboxed full Node run could not inspect process
  start identity and was stopped after an isolated chat-service test spun; the
  same full suite then passed under approved host execution. The first sandboxed
  npm audit lacked registry DNS access; the approved network retry passed. These
  were environment limitations, not product-test failures.
- Exact-code-head CI run:
  `https://github.com/oliver-hitchings/Scout/actions/runs/30946243076`.
  Six jobs completed successfully: Ubuntu full/audit/native DEB+tar, Apple
  Silicon macOS full/audit/native DMG, Windows full/audit/DACL/native installer,
  and all three browser jobs. The Intel macOS runner remained in `npm test` for
  more than 30 minutes, versus about 5 minutes in the immediately preceding
  successful all-platform run 30945126304 at `c6ef4bd`; GitHub exposed no partial log. An attempted
  cancellation was rejected with HTTP 403 because the fork account lacks
  upstream administration rights, so no CI state changed. The evidence-only
  ledger commit must trigger a fresh Intel attempt before acceptance.
- Evidence-head CI run:
  `https://github.com/oliver-hitchings/Scout/actions/runs/30949153353`.
  Ubuntu full/audit/native packaging, Apple Silicon macOS full/audit/native
  packaging and all three browser jobs passed. The fresh Intel full suite
  completed with 1,480 passed, 6 skipped and one unrelated timing failure because
  its slow-provider probe did not start within the test window. Windows completed
  with 1,483 passed, 3 skipped and one different unrelated lock-coordination
  timing failure; its dedicated publication/DACL protocol had already passed.
  Neither failed test or source file changed after approved code head `d165e1d`.
  GitHub rejected the built-in failed-job retry with an upstream-admin 403, so
  no rerun state changed; this ledger-only evidence update triggers a fresh
  attempt without altering production code.
- Independent exact-SHA reviews at `d165e1d`:
  - specification: **APPROVE**, no findings; 67/67 focused checks;
  - code quality: **APPROVE**, no findings; 118/118 focused checks;
  - security/privacy: **APPROVE**, no findings; 118/118 focused checks and no
    private path, credential or personal-data disclosure in the changed range.
- All original and fresh F-1 findings are repaired: clean seal authorization,
  audit-preparation cleanup reporting, stable ancestor fencing, Debian control
  mode, private same-filesystem output, Windows DACL application/verification,
  sealed-copy durability, transaction/recovery evidence, post-link mutation,
  completion-receipt rollback, substituted-directory cleanup and atomic
  quarantine-based rollback.
- Remaining gates are evidence/operator gates, not known code findings: a fresh
  exact-head Intel macOS hosted run; native installation/first-launch smoke on
  release hosts; and the later signing/attestation/publication/deployment gates.
  No merge, tag, release, package publication, deployment, retarget, approval,
  review resolution or issue closure occurred or is authorised here.

## Evidence update protocol

For every finding, update its row only after independent reproduction/static proof. Record RED test evidence before the fix, then exact commits, PR URL, focused and full counts, CI URL/status/log inspection, independent spec/code/security/documentation reviews, privacy and metadata audit, platform limitations, rollback considerations and remaining operator work. A claim reaches `fixed` only at the exact pushed SHA reviewed and tested. A merged-main Epic checkbox requires a separate main-SHA reconciliation; a feature-branch result is insufficient.
