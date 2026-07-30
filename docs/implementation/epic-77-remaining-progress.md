# Epic 77 remaining-work progress

This ledger records reviewable implementation checkpoints for Tasks 12–18.
It contains synthetic test evidence only and no provider output, credentials,
private paths, account data, CV content, adverts, prompts, or transcripts.

## Gate 1 — Task 12 / issue #72

- Status: review-clean and complete as a candidate implementation.
- Commit range: `f8732fd005a8b77fa79c7d63abe52c5a08b205bd..e2da28e8fa05f7fc93408a1f5932bf6ff29e6ad7`.
- Integrated source commits: `45776fb`, `0452b44`.
- Stabilisation commit: `e2da28e`.
- RED command: `npx playwright test tests/browser/scout-character.spec.mjs --project=chromium --grep "dashboard readiness does not wait"`.
- RED result: 1 failed after 10 seconds because the original `page.goto('/')`
  waited for the full page `load` event while a deterministic nonessential
  image remained pending.
- Fix: navigate to the explicit `commit` boundary, then poll for the exact
  bounded `window.ScoutCharacter` readiness state.
- GREEN:
  - `node --test ui/lib/scoutCharacter.test.mjs ui/app.config.test.mjs`:
    67 passed, 0 failed, 0 skipped.
  - Chromium character file, unchanged consecutive reruns: 11 passed, then
    11 passed.
  - Firefox character file: 11 passed.
  - Focused readiness stress review: 30 passed.
  - `npm run release:audit`: passed; 214 files scanned.
  - `git diff --check f8732fd005a8b77fa79c7d63abe52c5a08b205bd..HEAD`:
    passed.
- Infrastructure evidence: an earlier Chromium run passed 10 assertions before
  the headless browser process exited with `SIGSEGV`; the unchanged full-file
  reruns then passed twice consecutively.
- Fresh read-only review:
  - Spec compliance: PASS.
  - Code quality: APPROVED.
  - Findings: 0 Critical, 0 Important, 0 Minor.
- Findings fixed/open: no open findings.
- Next exact action: cherry-pick Gate 2 commits `b00644f`, `110d52f`,
  `0694717`, `826932f`, `c155032`, and `b96b3c2` in that order, resolving
  overlaps semantically.

## Gate 2 — Tasks 13–15 / issues #73–#75

- Status: review-clean and complete as candidate implementations.
- Commit range: `23537e1..1aea7bb1417f88aea53e20063fe5c9c5619c8d4c`.
- Integrated source commits: `b00644f`, `110d52f`, `0694717`, `826932f`,
  `c155032`, and `b96b3c2`, cherry-picked semantically as `b93f2b3`,
  `f200b8a`, `e7d2387`, `f790ec5`, `1f981f9`, and `a530049`.
- Integration/review-fix commits: `548c1ab`, `6d91e27`, and `1aea7bb`.
- RED command: `npx playwright test tests/browser/offline-module-graph.spec.mjs --project=chromium`.
- RED result: the build-B shell loaded its cached `app.js`, but the browser
  resolved both static imports to unversioned URLs absent from the exact
  build-B cache keys; with HTTP cache disabled the offline UI did not boot.
- Additional integration RED: the first combined Chromium chat run had 4
  failures because A2 initialises tracker data as `null` while the source
  branch's `company()` helper dereferenced it before asynchronous load.
- Fixes:
  - serve `app.js` through the existing UI-build template and version every
    static module import with the same build key pre-cached by the worker;
  - add a real browser A-to-B worker lifecycle derived mechanically from the
    production service worker, asserting activation deletes A, retains B,
    exact import keys exist, and the actual Scout module graph boots offline;
  - make chat company lookup tolerate the existing pre-load `null` state;
  - document the fixed Codex catalogue command, per-stream output bound,
    timeout, record cap, cache lifetime, fallback, and privacy boundary.
- GREEN:
  - non-server focused Node/PWA suite: 129 passed, 0 failed, 0 skipped;
  - changed server templating/cache tests: 2 passed;
  - Chromium chat-engine file: 17 passed;
  - Firefox chat-engine file: 17 passed;
  - production-worker A-to-B offline rollover: 1 passed;
  - `npm run release:audit`: passed; 218 files scanned;
  - diff checks: passed.
- Known local environment limitation: the exact shared focused command reports
  164 passes and 4 failures in inherited server tests because this macOS Codex
  sandbox cannot read `kern.proc.pid.<pid>`. `ui/lib/scanLease.mjs` is unchanged
  from the required base. The Gate 2 server paths changed here pass in isolation;
  the complete GitHub matrix remains the authoritative unsandboxed confirmation.
- Fresh read-only review rounds:
  - Round 1: FAIL / CHANGES REQUIRED; 0 Critical, 1 Important, 1 Minor.
    Replaced a simulated cache-name rollover with a real browser worker
    lifecycle and corrected combined-versus-per-stream documentation.
  - Round 2: FAIL / CHANGES REQUIRED; 0 Critical, 1 Important, 0 Minor.
    Replaced the hand-written test worker with path-scoped builds of the actual
    production service-worker source.
  - Round 3: Spec compliance PASS; Code quality APPROVED; 0 Critical,
    0 Important, 0 Minor.
- Findings fixed/open: every Gate 2 finding fixed; none open.
- Next exact action: add failing `ui/lib/providerHealth.test.mjs` state,
  persistence, precedence, scheduling, fencing, and retry cases, then run
  `node --test ui/lib/providerHealth.test.mjs ui/lib/providers.test.mjs ui/lib/scheduler.test.mjs ui/lib/scanPipeline.test.mjs`.

## Gate 3 — Task 16 / issue #76

- Status: review-clean and complete as a candidate implementation.
- Commit range: `595d314..5e98f40`.
- Implementation commits: `c675a2d`, `9767719`, and `e128676`.
- Review-fix commits: `63d2d5d`, `502ac83`, `9e6c501`, and `5e98f40`.
- RED evidence:
  - the provider-health core initially failed module loading because
    `ui/lib/providerHealth.mjs` did not exist;
  - provider/scheduler adapter tests initially failed because the bounded
    health signal and monitor exports did not exist;
  - scan preflight initially had no refusal hook or durable blocked-run path;
  - review regressions reproduced preflight authority retention, unsafe error
    collapsing, mislabeled scheduled checks, unfenced read/modify/write, and a
    transient health lease incorrectly entering the overlap queue.
- Fixes:
  - persist one strict schema-v1 health record per provider using bounded
    evidence, 32-entry history, alert deduplication and acknowledgement;
  - preserve remote authentication failure authority until a genuine remote
    success, while retaining distinct network, rate-limit, CLI-update and
    provider-error states;
  - serialize unleased health mutations through short existing fenced lease
    authority, and retry that transient authority without enqueueing a scan;
  - run fenced preflight after startup queue drain and before recovery or
    stages, recording `run.started`, `provider-health-blocked`, and terminal
    `abandoned` evidence without assessment or tracker/report mutation;
  - wire manual, scheduled, startup, periodic and provider-operation health
    checks with exact bounded purposes and no provider substitution or
    automatic missed-window resend.
- GREEN:
  - provider-health, provider-adapter, structured-turn and scheduler suites:
    70 passed, 0 failed, 0 skipped;
  - focused server startup/periodic runtime-wiring test: 1 passed;
  - storage-pressure ordering regression: 1 passed;
  - `npm run release:audit`: passed; 219 files scanned;
  - full-range diff check: passed.
- Required focused command:
  - 128 tests discovered; 92 passed and 36 stopped at the inherited macOS
    process-start identity boundary before executing their lease assertions.
  - Every failure reports `cannot determine the current process-start identity`
    from unchanged `ui/lib/scanLease.mjs`; this sandbox cannot read
    `kern.proc.pid.<pid>` even with escalation. The new real-fence pipeline
    tests remain authoritative in the GitHub Linux matrix.
- Fresh read-only review rounds:
  - Round 1: FAIL / CHANGES_REQUESTED; 0 Critical, 4 Important, 0 Minor.
    Fixed preflight exception authority, cross-process health serialization,
    production error classification, and runtime purpose/wiring coverage.
  - Round 2: FAIL / CHANGES_REQUESTED; 0 Critical, 1 Important, 0 Minor.
    Prevented short provider-health authority from queueing and stranding a
    racing scan.
  - Round 3: Spec compliance PASS; Code quality APPROVED; 0 Critical,
    0 Important, 0 Minor.
- Findings fixed/open: every Gate 3 finding fixed; none open.
- Next exact action: add failing `ui/lib/providerLogin.test.mjs` cases for
  allowlisted provider login commands, bounded lifecycle and safe post-auth
  validation, then run the Gate 4 focused command from the execution brief.

## Gate 4 — Task 17 / guided provider login

- Status: review-clean and complete as a candidate implementation.
- Commit range: `c64457e..8cded8f`.
- Implementation commits: `d9dc24d` and the required `6dcadb9`
  (`feat: guide secure provider reauthentication`).
- Review-fix commits: `da68902`, `28c5a1f`, and `8cded8f`.
- RED evidence:
  - the first focused tests failed because `ui/lib/providerLogin.mjs` and its
    owner-only routes did not exist;
  - review regressions then reproduced false local-only post-auth success,
    uncancelled confirmation turns, unbounded confirmation output, incomplete
    child-tree shutdown, replayable retry/logout authorisations, stale Claude
    expiry evidence, false logout-success UI, and stale poll/double-action
    response races;
  - the stubborn real provider fixture remained alive after `SIGTERM` until
    the close-gated forced process-group escalation was implemented.
- Fixes:
  - constrain Codex and Claude to trusted executables, documented fixed
    arguments, `shell: false`, a minimal environment, a private working
    directory, bounded output/input/time and sanitised public snapshots;
  - require same-origin JSON, ephemeral CSRF and a server-derived local or
    configured remote-owner context for every route and session operation;
  - validate local login status with a bounded real structured provider turn,
    feed terminal evidence to provider health, serialize/await health writes,
    and own cancellation through close or bounded shutdown;
  - terminate POSIX process groups with TERM-to-KILL escalation and Windows
    trees with fixed `taskkill.exe` arguments;
  - consume retry and Claude-clear predecessor sessions once, bind clear to a
    recent `credentials-expired` session, and re-probe remote authentication
    immediately before the explicit fixed logout;
  - make failed logout a failed API/UI outcome, disable mutations in flight,
    and ignore stale polling responses by per-provider generation.
- GREEN:
  - focused provider-login, provider-turn and setup suites: 77 discovered,
    76 passed, 0 failed, 1 platform-specific skip;
  - required Gate 4 Node command: 106 discovered, 102 passed, with only the
    four inherited macOS process-start identity failures below;
  - Chromium settings acceptance: 23 passed;
  - Firefox settings acceptance: 23 passed;
  - `npm run release:audit`: passed; 220 files scanned;
  - full-range diff checks: passed.
- Known local environment limitation: four unchanged server tests fail because
  this macOS Codex sandbox cannot read the process-start identity used by
  `currentLeaseOwner()`. The same four failures were recorded in Gates 2 and 3;
  all Gate 4 server-route assertions pass.
- Fresh read-only review rounds:
  - Early hardening rounds found and fixed false health confirmation,
    insufficient lifecycle ownership, shared rate buckets, access
    classification, output bounds, health-write ordering and explicit-clear
    eligibility.
  - Penultimate round: Security FAIL (0 Critical, 2 Important), Spec FAIL
    (0 Critical, 1 Important), Code quality CHANGES REQUIRED (0 Critical,
    2 Important). Fixed confirmation process-group closure, retry replay,
    session-bound fresh Claude clear, failed-logout reporting and UI response
    serialization.
  - Final complete-range round: Security PASS, Spec PASS, Code quality PASS;
    0 Critical, 0 Important.
- Findings fixed/open: every Gate 4 finding fixed; none open.
- Next exact action: write failing Task 18 browser acceptance and release-audit
  tests, beginning with `tests/browser/recoverable-scan.spec.mjs` and the
  privacy-sensitive release fixture matrix.

## Gate 5 — Task 18 / end-to-end acceptance and release evidence

- Status: review-clean and complete as a candidate implementation.
- Implementation commit: `964abe4` (`test: add recoverable scan release
  acceptance`).
- Review-fix commit: `82a2b9b` (`fix: close recoverable scan release gaps`).
- RED evidence:
  - the new release-audit/build regressions discovered 18 tests, with 15
    passing and 3 failing because private runtime roots, raw serialized
    recovery/auth payloads and release-path exclusions were not enforced;
  - the first complete browser run reproduced the held-character-module
    regression: the earlier character module blocked `app.js`, so
    `window.Scout` never became ready;
  - adversarial review probes then reproduced ordinary key variants, Linux
    paths, staged `app/` wrappers, binary/document payloads, sensitive
    filenames and production-shaped device-code/run-state schemas passing the
    audit.
- Fixes:
  - add one Chromium release-acceptance boundary over the real journal,
    recovery, lease, assessment, queue, mutation, backup, retention,
    provider-health, guided-login and server fault-injection suites; the local
    macOS host skips only that aggregate when it cannot read its own
    process-start identity, while Linux CI runs it;
  - add a real-server corrupt-journal fault injection and assert the run,
    queue and provider-login HTTP projections, DOM and browser storage never
    expose the private directory identity;
  - retain the bounded UI coverage for every durable phase/terminal state,
    assessment repair progress, overlap expiry/deduplication/handoff and the
    composed Tasks 12–17 settings/dashboard experience;
  - reject private runtime trees at source and staged `app/` roots, serialized
    raw run/auth state, auth/device codes, prompts, CV/ad bodies, provider
    transcripts, tracking values, macOS/Linux/Windows private paths,
    unexpected documents/binaries and sensitive filenames without echoing
    private values or paths;
  - allow only exact reviewed UI assets, screenshots, platform
    runtimes/launchers and lockfile-selected production dependencies, while
    keeping the staged 230 MB runtime audit bounded;
  - order the independent application module before the character module so a
    held or failed character module leaves the labelled hydratable fallback
    usable;
  - document recovery selection, stage compatibility, overlap expiry,
    provider health/login, Codex fallback, safe divergence handling,
    retention/privacy and corrupt-journal, lost-lease, interrupted-cleanup and
    push-pending operator boundaries without advertising a cleanup control
    that this release does not expose.
- GREEN:
  - release-audit/build suite: 22 passed, 0 failed, 0 skipped;
  - Chromium Gate 5 acceptance: 5 discovered, 4 passed, 0 failed, 1 known
    macOS process-identity skip;
  - complete browser matrix after explicit CV-catalogue readiness and
    Chromium-only DevTools cache isolation: 142 discovered, 139 passed, 0
    failed, 3 intentional platform/host skips;
  - focused CV readiness verification: the formerly failing Firefox master
    reference case passed twice consecutively, then the complete CV file
    passed 10 of 10 across Chromium and Firefox;
  - character browser acceptance after the module-order repair: Chromium
    11 passed and Firefox 11 passed; the formerly failing held-module case
    also passed twice consecutively;
  - documentation and app-configuration bundle: 64 passed;
  - `npm run release:audit`: passed for 412 source/build files in the local
    tree; direct staged-tree audit passed for 180 files and completed in under
    one second with the 230 MB Node runtime present;
  - diff checks: passed.
- Local packaging note: `node tools/build-release.mjs --stage-only` cannot
  finish in this worktree because the optional local `.scout-runtime/typst`
  binary is absent. It created enough of the stage to validate the real
  wrapper/runtime audit. The required complete packaging paths remain covered
  by build tests and the GitHub release matrix.
- Local full-Node note: `npm test` discovered 1,080 tests; 822 passed, 253
  failed and 5 skipped because this sandbox cannot read the macOS
  `kern.proc.pid.<pid>` process-start identity. The same identity boundary is
  the only root failure and its dependent server assertions receive 500
  responses. Linux and the repository's other CI hosts remain the required
  authoritative full-suite evidence.
- Browser rerun evidence: an earlier complete run had one Firefox
  offline-worker failure because the test attempted its Chromium DevTools
  cache-isolation primitive on Firefox; that test is now explicitly
  Chromium-scoped. One unchanged rerun then ended in a Chromium browser
  `SIGSEGV`. A subsequent run exposed a real Firefox CV boot race, which was
  reproduced in isolation and fixed with an explicit application-data
  readiness boundary rather than a sleep. The final unchanged complete matrix
  passed with the counts above.
- Fresh read-only review rounds:
  - initial Spec FAIL (0 Critical, 1 Important), Quality FAIL (0 Critical,
    4 Important), Privacy FAIL (0 Critical, 3 Important): replaced
    mocked-only evidence, closed representation/staging gaps and corrected
    unavailable cleanup and overbroad privacy claims;
  - adversarial follow-ups found and fixed contextual serialized fields,
    exact documented-path wrapping, runtime performance, binary/document
    allowlisting, sensitive filenames, device-code documentation and the
    exact screenshot allowlist;
  - final Spec PASS, Code quality PASS and Privacy/security PASS; 0 Critical,
    0 Important.
- Findings fixed/open: every Gate 5 finding fixed; none open.
- Next exact action: complete the fresh whole-epic re-review and final clean
  verification matrix, push the branch, open the required draft PR and obtain
  the complete GitHub Actions matrix.

## Final whole-epic release review

- Status: review fixes committed; independent re-review pending.
- Review-fix commit: `5651ac6` (`fix: close final release review blockers`).
- Initial complete-range verdicts:
  - Spec FAIL: 0 Critical, 3 Important.
  - Code quality FAIL: 0 Critical, 2 Important.
  - Privacy/security FAIL: 0 Critical, 2 Important.
- Findings reproduced and fixed:
  - replace the nonexistent aggregate-suite entry with a browser assertion
    that every aggregate target exists;
  - detect ordinary credential/auth-state/prompt/advert representations,
    content-sniff structured payloads after harmless renames, audit tests and
    fixtures, and recognise private roots at every packaged `app/` boundary;
  - run the real privacy audit over the generated public-source stage;
  - consume the single retry only after the successor login starts, releasing
    it after a transient pre-session failure;
  - bound provider and deep-link command settlement after TERM/KILL even when
    a child never emits `close`;
  - project tool activity and failures to fixed public values while retaining
    only repo-relative touched-file evidence internally;
  - replace tracker, chat-history, usage and catalogue exception details with
    fixed API copy so provider output, credentials, commands and host paths do
    not reach SSE, API responses or durable transcripts.
- GREEN after fixes:
  - focused release-audit/build, provider-login/provider and chat suites:
    143 discovered, 142 passed, 0 failed, 1 Windows-only skip;
  - wider provider/setup/chat verification: 155 discovered, 154 passed,
    0 failed, 1 Windows-only skip;
  - affected browser files: 92 discovered, 90 passed, 0 failed, 2 intentional
    platform/host skips;
  - `npm run release:audit`: passed for 515 source/build files;
  - diff checks: passed.
- Findings fixed/open: all initial findings fixed; the fresh complete-range
  Spec, code-quality and privacy/security re-review verdicts remain required
  before final verification and publication.

### Whole-epic review round 2

- Verdicts:
  - Spec FAIL: 0 Critical, 2 Important.
  - Code quality FAIL: 0 Critical, 1 Important.
  - Privacy/security FAIL: 0 Critical, 2 Important.
- Review-fix commit: `7c9fcca` (`fix: harden publication privacy boundaries`).
- Findings reproduced and fixed:
  - remove broad credential-placeholder and plausible-username exemptions;
    exact placeholders remain accepted while realistic `secret`, `private`
    and `synthetic` credential values are rejected;
  - recognise Windows private home paths with either separator and construct
    all synthetic path/credential fixtures so tests never weaken production
    matching;
  - require configured personal markers when auditing generated
    public-source publication output;
  - reduce Git/sync failures to fixed status copy and allowlisted
    `backup-offline`, `backup-error` and `git-unavailable` reason codes;
  - project arbitrary API exceptions to fixed route copy, remove raw
    exception details from update/setup/sync/CV/schedule surfaces, retain the
    existing local-only update mutation guard, and omit device-local download
    paths from update responses.
- GREEN after fixes:
  - release-audit/build and update suites: 38 passed, 0 failed, 0 skipped;
  - generated public-source audit: passed with a configured synthetic marker;
    the marker-free publication regression fails closed;
  - default release audit: passed for 515 files;
  - server suite: 48 discovered, 44 passed, with only the four documented
    macOS process-start identity failures;
  - diff checks: passed.
- Findings fixed/open: all round-2 findings fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 3

- Verdicts:
  - Spec PASS: 0 Critical, 0 Important.
  - Code quality FAIL: 0 Critical, 1 Important.
  - Privacy/security FAIL: 0 Critical, 2 Important.
- Review-fix commit: `4ec238a` (`fix: close diagnostics privacy gaps`).
- Findings reproduced and fixed:
  - update the inherited sync test to require fixed public copy,
    `backup-error`, and absence of the raw commit diagnostic;
  - add a closed public doctor projection for setup status so configuration,
    tracker/CLI/runtime paths, versions, provider records and raw errors never
    cross the API boundary;
  - replace source tracker/fetch exception details with fixed reason-coded
    responses;
  - inspect every sensitive assignment on a line instead of stopping at the
    first placeholder, and reject high-signal Authorization Bearer and
    OpenAI-style provider tokens.
- GREEN after fixes:
  - release-audit/build, doctor and update suites: 41 passed, 0 failed,
    0 skipped;
  - bounded offline and failed-checkpoint sync regressions: 2 passed;
  - setup/API public-projection server regressions: 2 passed;
  - affected chat/settings/recoverable browser matrix: 92 discovered,
    90 passed, 0 failed, 2 intentional platform/host skips;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Findings fixed/open: all round-3 findings fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 4

- Verdicts:
  - Spec PASS: 0 Critical, 0 Important.
  - Code quality PASS: 0 Critical, 0 Important.
  - Privacy/security FAIL: 0 Critical, 2 Important.
- Review-fix commit: `219032a` (`fix: enforce local update privacy boundary`).
- Findings reproduced and fixed:
  - classify serialized `Authorization` values as credentials and detect
    quoted JSON/header Bearer syntax;
  - require local request access before the saved automatic-download policy
    may start a package download, so remote update checks remain read-only;
  - project device settings through a closed schema, omitting persisted
    download paths, startup diagnostics and arbitrary corrupted fields;
  - validate the bounded downloaded-update projection instead of copying
    persisted names, hashes, versions or timestamps on trust.
- GREEN after fixes:
  - release-audit/build, doctor and update suites: 42 passed, 0 failed,
    0 skipped;
  - device/update boundary regression and local update-policy integration:
    2 passed;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Findings fixed/open: all round-4 findings fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 5

- Verdicts:
  - Spec PASS: 0 Critical, 0 Important.
  - Code quality FAIL: 0 Critical, 1 Important.
  - Privacy/security PASS: 0 Critical, 0 Important.
- Review-fix commit: `4564ff7` (`fix: validate public update metadata`).
- Finding reproduced and fixed:
  - require canonical ISO UTC timestamps for public device/update status and
    require a downloaded package name to match both its exact Scout version
    and one of the supported platform package formats, so corrupted persisted
    metadata cannot carry private text through otherwise generic fields.
- GREEN after fixes:
  - release-audit/build, doctor and update suites: 42 passed, 0 failed,
    0 skipped;
  - device/update boundary regression and local update-policy integration:
    2 passed;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Findings fixed/open: the round-5 finding is fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 6

- Verdicts:
  - Spec FAIL: 0 Critical, 1 Important.
  - Code quality FAIL: 0 Critical, 1 Important.
  - Privacy/security PASS: 0 Critical, 0 Important.
- Review-fix commit: `12c0869`
  (`fix: close final audit and update handoff gaps`).
- RED:
  - the new quoted-credential regression returned `ok: true` for ordinary
    single- and double-quoted password, auth-token and API-key values
    containing whitespace;
  - the new Chromium update-download regression rendered the old
    `ready at undefined` copy because the UI still expected a local path that
    the privacy-safe API projection intentionally omits.
- Findings reproduced and fixed:
  - parse bounded quoted credential literals through their matching quote,
    preserve exact placeholder handling, fail closed on missing or oversized
    closing quotes, and report only the fixed rule and line metadata;
  - keep private fixture meaning at runtime without placing credential-shaped
    literals in public test source;
  - render the validated package name and configured-download-folder
    instruction after a successful update download without exposing a
    device-local path.
- GREEN after fixes:
  - release-audit/build suite: 33 passed, 0 failed, 0 skipped;
  - quoted-credential regression: passed;
  - Chromium update-download regression: passed;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Local full-suite note: the unchanged macOS host still cannot read
  `kern.proc.pid.<pid>` process-start identity. The affected artifact and
  setup suites therefore retain their documented dependent failures; the
  directly changed setup fixture path passed before those failures.
- Findings fixed/open: both round-6 findings are fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 7

- Verdicts:
  - Spec PASS: 0 Critical, 0 Important.
  - Code quality FAIL: 0 Critical, 2 Important.
  - Privacy/security FAIL: 0 Critical, 1 Important.
- Review-fix commit: `8d37127`
  (`fix: harden credential audit and update handoff`).
- RED:
  - escaped and doubled quoted credential literals plus a static backtick
    literal were omitted from the expected audit findings;
  - common namespaced credential keys including provider API keys, database
    passwords and refresh/bearer/ID/session token families returned
    `ok: true`;
  - the update browser regression received a fixed package name but not an
    actionable, privacy-safe location alias.
- Findings reproduced and fixed:
  - classify complete bounded assignment identifiers by exact/specific
    sensitive suffix, including quoted YAML keys, without treating unrelated
    cancellation, CSRF or lock tokens as credentials;
  - scan quoted literals through escaped or doubled delimiters, fail closed on
    malformed/oversized literals and inspect static backticks while leaving
    interpolated code expressions to normal source review;
  - preserve only exact documented placeholders, including GitHub Actions
    expressions, and update the Adzuna documentation to use an exact
    angle-bracket placeholder;
  - return a fixed environment-variable or home-alias location hint derived
    from platform/configuration shape, never the expanded device path, and
    use it in the successful installer handoff.
- GREEN after fixes:
  - release-audit/build/update suite: 42 passed, 0 failed, 0 skipped;
  - device/update privacy boundaries: 2 passed;
  - Chromium update handoff regression: passed;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Preliminary full browser evidence before these narrow fixes: 146 discovered,
  143 passed, 0 failed and 3 intentional platform/host skips. The affected
  update test then passed directly with the final location-hint contract; the
  complete matrix remains to be rerun from the final clean commit.
- Findings fixed/open: all round-7 findings are fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 8

- Verdicts:
  - Spec PASS: 0 Critical, 0 Important.
  - Code quality FAIL: 0 Critical, 2 Important.
  - Privacy/security FAIL: 0 Critical, 1 Important.
- Review-fix commit: `a185912`
  (`fix: close credential and auto-update edge cases`).
- RED:
  - camel/lower API-token, API-secret, consumer-secret and authorization
    assignments were absent from audit findings;
  - a leading doubled single quote caused a quoted password to be read as an
    empty literal;
  - plausible `your-live-*` and generic angle-bracket values were incorrectly
    accepted as placeholders;
  - the already-downloaded browser path rendered only “verified package is
    ready” and omitted both the package name and safe location alias.
- Findings reproduced and fixed:
  - add specific credential/authorization suffixes, handle a doubled
    delimiter at the start of a bounded literal and retain unrelated token
    exclusions;
  - reduce placeholders to fixed generic sentinel words, the two exact
    documented angle-bracket values, and exact environment/workflow
    expressions;
  - keep privacy test values constructed at runtime so the default
    publication audit scans tests without exemptions;
  - share the exact package-name/location-alias handoff across manual and
    automatic downloads.
- GREEN after fixes:
  - release-audit/build/update suite: 43 passed, 0 failed, 0 skipped;
  - manual and automatic Chromium update handoffs: 2 passed;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Full Node evidence at the preceding clean review commit: 1,101 discovered,
  840 passed, 256 failed and 5 skipped. All root failures remain the documented
  inability of this macOS host to read process-start identity, with dependent
  server/setup assertions receiving fixed 500 responses; affected focused
  suites are green.
- Findings fixed/open: all round-8 findings are fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 9

- Verdicts:
  - Spec FAIL: 0 Critical, 1 Important.
  - Code quality PASS: 0 Critical, 0 Important.
  - Privacy/security PASS: 0 Critical, 0 Important.
- Review-fix commit: `8b1b6ea`
  (`fix: detect generic credential token keys`).
- RED: ordinary quoted `serviceToken`, `providerToken`, `githubToken` and
  `openaiToken` assignments were absent from audit findings.
- Finding reproduced and fixed:
  - classify camel/lower keys ending in `Token` as credential assignments by
    default, retaining only the exact noncredential coordination-key
    exclusions for cancellation, CSRF and lock tokens.
- GREEN after fixes:
  - release-audit/build/update suite: 43 passed, 0 failed, 0 skipped;
  - generic token-key regression: passed;
  - generated public-source audit: passed;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Findings fixed/open: the round-9 finding is fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 10

- Verdicts:
  - Spec PASS: 0 Critical, 0 Important.
  - Code quality FAIL: 0 Critical, 1 Important.
  - Privacy/security FAIL: 0 Critical, 1 Important.
- Review-fix commit: `9175bf4` (`fix: audit hard-coded CSRF tokens`).
- RED: hard-coded `csrfToken` and `providerLoginCsrfToken` assignments returned
  `ok: true` because the new generic token handling exempted those key names
  before inspecting their values.
- Finding reproduced and fixed:
  - remove both CSRF exclusions so hard-coded CSRF capability tokens fail the
    publication audit; dynamic expressions continue through the existing
    expression exclusion, and synthetic browser fixtures construct their
    values at runtime rather than weakening production scanning.
- GREEN after fixes:
  - release-audit/build/update suite: 43 passed, 0 failed, 0 skipped;
  - hard-coded CSRF/provider-login-CSRF regressions: passed;
  - generated public-source audit: passed;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Verification note: the complete browser run started at the preceding commit
  was deliberately interrupted once this real review finding arrived; its
  interrupted result is not counted as verification evidence.
- Findings fixed/open: the round-10 finding is fixed; complete-range Spec,
  code-quality and privacy/security re-review is pending.

### Whole-epic review round 11

- Verdicts:
  - Spec PASS: 0 Critical, 0 Important.
  - Code quality PASS: 0 Critical, 0 Important.
  - Privacy/security PASS: 0 Critical, 0 Important.
- Complete reviewed range:
  `f8732fd005a8b77fa79c7d63abe52c5a08b205bd..a0a4234`.
- Independent reviewers verified:
  - hard-coded CSRF and provider-login CSRF values fail closed while dynamic
    expressions remain source code rather than embedded credentials;
  - generic camel/lower token-key assignments remain sensitive by default;
  - only the exact cancellation and lock coordination-key exclusions remain,
    with no credential-bearing literal found under either;
  - prior Gates 1–5 acceptance, privacy, publication and manual/automatic
    update-handoff contracts remain intact.
- Review verification:
  - release-audit/build/update suite: 43 passed, 0 failed, 0 skipped;
  - default release audit: passed for 515 files;
  - diff checks: passed.
- Findings fixed/open: none open.
- Next exact action: run the complete final verification matrix from this
  review-clean committed tree, push the branch, open the required stacked
  draft PR and obtain every required GitHub Actions result.

## Final local verification

- Verified commit: `a64168cacb8d3a8e21ca37d3415ef673dad77439`.
- `node --test tools/release-audit.test.mjs tools/build-release.test.mjs`:
  35 passed, 0 failed, 0 skipped.
- `npx playwright test tests/browser/recoverable-scan.spec.mjs
  --project=chromium`: 5 passed, 0 failed, 1 documented macOS
  process-identity skip.
- `npm test`: 1,102 discovered, 841 passed, 256 failed and 5 skipped. The
  failures trace to this host's inability to read `kern.proc.pid.<pid>`
  process-start identity or dependent server/setup assertions receiving fixed
  failure responses; every affected focused suite that does not require that
  host primitive is green.
- `npm run test:browser`: 148 discovered, 145 passed, 0 failed and 3
  intentional platform/host skips.
- `npm run release:audit`: passed for 515 source/build files.
- complete-range diff checks: passed.
- worktree before this evidence-only ledger commit: clean.
- Known packaging limitation remains unchanged: local stage construction
  refreshes the real release tree but cannot finish without the optional
  app-local `.scout-runtime/typst`; cross-platform packaging tests and CI are
  authoritative.
- Next exact action: push this evidence commit, create the required stacked
  draft PR and wait for all seven required GitHub Actions checks.

## Draft-PR CI remediation and final re-review

- Initial draft-PR run:
  [GitHub Actions run 30470247535](https://github.com/oliver-hitchings/Scout/actions/runs/30470247535).
- The first cross-platform run exposed eleven deterministic Node failures:
  one expired scheduled-window fixture, two invalid queue fixtures, three
  over-redacted setup/CV errors, four stale raw ranked-selection/error
  expectations and one discard-counter schema projection defect.
- CI repair commit: `671201b`
  (`fix: close cross-platform verification gaps`).
- RED/GREEN and repair details:
  - scheduled and queued fixtures now satisfy their existing expiry and
    compatibility invariants without weakening production validation;
  - durable run/report recipes preserve the five canonical underscore-named
    discard counters through a closed allowlist;
  - ranked runtime tests assert the intended bounded explanation and reason
    code projections instead of omitted raw selections and diagnostics;
  - setup threshold and PDF import failures use fixed actionable public
    classifications, while unknown and parser-specific diagnostics remain
    redacted;
  - focused public-error/privacy and discard-schema tests passed; the three
    setup HTTP regressions passed; the queue/runtime cases reached only the
    already documented macOS process-start-identity limitation locally.
- Whole-range review then found one Important guided-login reachability gap:
  a remote authentication failure could remain authoritative while local CLI
  detection still reported credentials, leaving no Settings reauthentication
  action.
- Review-fix commits:
  - `42a17ed` (`fix: keep provider reauthentication reachable`);
  - `ff9435c` (`fix: preserve remote authentication barriers`).
- RED/GREEN and review-fix details:
  - RED server, unit and browser regressions reproduced the stale
    authenticated projection, missing guided/manual sign-in actions and stale
    compatible provider card;
  - setup status and setup completion now consume a closed public provider
    projection that combines CLI capability with durable provider health;
  - the private `remoteAuthBarrier` forces public `authenticated: false`
    across intervening login, network, rate-limit, CLI and provider-error
    states until a real remote success clears it;
  - invalid or unreadable health records fail closed to unauthenticated plus
    the fixed allowlisted `provider-error` state, without publishing the
    barrier, diagnostics, reason history, timestamps or alerts;
  - Settings keeps guided sign-in and the fixed manual fallback reachable and
    no longer labels the affected provider compatible;
  - beta.23 release notes now cover recoverable scans, provider health/login
    and Scout character behavior as well as provider/chat/Codex-link work.
- Final focused GREEN:
  - provider health/login/setup unit suites: 99 passed;
  - complete Settings browser suite: 52 passed across Chromium and Firefox;
  - release/app/docs/privacy suite: 88 passed;
  - release/build suite: 35 passed;
  - release audit: 515 files, clean.
- Final complete local evidence:
  - `npm test`: 1,103 discovered, 845 passed, 253 failed and 5 skipped. Every
    remaining failure traces to the documented inability of this macOS host
    to obtain process-start identity or a dependent fixed failure response;
  - `npm run test:browser`: 150 discovered, 147 passed, 0 failed and 3
    intentional platform/host skips;
  - complete-range diff checks: passed.
- Final complete-range independent re-review through `ff9435c`:
  - Spec PASS: 0 Critical, 0 Important.
  - Code quality PASS: 0 Critical, 0 Important.
  - Privacy/security PASS: 0 Critical, 0 Important.
- Findings fixed/open: none open.
- Next exact action: commit this evidence, push the exact reviewed branch and
  require all seven draft-PR checks to pass before final handoff.

## Whole-epic review round 12 and exact-HEAD verification

- Review-fix commits:
  - `410527c` (`fix: harden provider authentication boundaries`);
  - `e1e4b61` (`fix: strengthen final acceptance boundaries`);
  - `d9eed37` (`test: keep provider auth fixture release-safe`);
  - `59f68cd` (`test: bound durable state acceptance under load`).
- RED findings reproduced:
  - real CLI authentication diagnostics were reduced to a generic provider
    error before the durable remote-auth classifier could observe them;
  - POSIX guided-login cancellation signalled only the immediate process;
  - terminal device-auth sessions retained their code and verification URL;
  - a failed build-B installation could leave build-B HTML in build A's cache;
  - cross-provider queued work inherited the outer provider's lease metadata;
  - the browser release boundary nested unit suites instead of directly
    injecting crash, takeover, queue, provider, storage, backup and tamper
    faults;
  - the release audit rejected a credential-shaped fake CLI diagnostic;
  - two browser acceptance timeouts were narrower than their own work.
- GREEN after fixes:
  - complete provider/server regression group: 149 passed, 1 platform skip;
  - durable pipeline/lease/queue/journal/backup/retention group: 227 passed,
    2 platform skips;
  - changed Chromium acceptance files: 17 passed;
  - direct interface acceptance: passed;
  - interrupted offline rollover: passed;
  - release/build audit tests: 35 passed.
- Exact reviewed range:
  `f8732fd005a8b77fa79c7d63abe52c5a08b205bd..59f68cd`.
- Independent final implementation verdicts:
  - Spec PASS: 0 Critical, 0 Important, 0 Minor.
  - Code quality PASS: 0 Critical, 0 Important, 0 Minor.
  - Privacy/security PASS: 0 Critical, 0 Important, 0 Minor.
- Full Node run 1 under concurrent independent browser verification:
  1,108 discovered, 1,098 passed, 5 failed and 5 skipped. The exact five
  failures were retained and rerun unchanged; all eight selected cases
  covering those parameterised failures passed. They were classified as
  concurrent host-load infrastructure failures, not assertion flakes.
- Full Node run 2, unchanged and without concurrent browser load:
  1,108 discovered, 1,103 passed, 0 failed and 5 platform skips.
- Complete browser run:
  148 discovered, 146 passed, 0 failed and 2 intentional non-Chromium skips.
- `npm run release:audit`: passed for 515 files.
- Complete-range `git diff --check`: passed.
- Worktree before this ledger-only commit: clean.
- Publication blocker:
  earlier feature-branch commits contain personal author/committer metadata.
  The branch was already published before this was found, while the brief
  forbids rebasing or force-pushing a published branch. Additive commits cannot
  remove immutable historical metadata, so publication, exact-HEAD CI and the
  PR privacy confirmation must remain paused until the operator explicitly
  chooses whether to authorise rewriting this draft branch.
- Next exact action after that decision:
  if rewriting is authorised, replace only the feature branch's historical
  author/committer address with the GitHub noreply identity, re-run exact-HEAD
  review and verification, update the draft PR and require all seven GitHub
  Actions checks to pass. Otherwise leave the draft PR unpushed and report the
  privacy gate as unresolved.

## 2026-07-29 metadata rewrite and independent review bridge

The publication blocker recorded immediately above is historical. The operator
authorised a metadata-only rewrite of the already published feature branch.
Publication used a force-with-lease bound to old fork head
`dcf2c5ef02d726eeb35d997a53f156f90b440a76`; its rewritten equivalent is
`7953b48`. The final pre-rewrite implementation checkpoint `f152950` maps to
`ab402c2ffa33d25d1cb6f26cfef5ea765b8b9067`. Both 64-commit ranges have final
tree `472c7856ad85f5a9f0b9514aafccd3331abdee19` and ordered tree/message digest
`5ccfc4d039ffdf329ec4174b2be2c2d9d52981b08d2ff97fb425f3a27cb42214`.
The complete per-commit old → rewritten map is retained in draft PR #82's
body. No later history rewrite is authorised.

Two normal fast-forward Windows portability commits followed the rewrite. All
seven CI jobs passed at exact head
`d5ebca214863389aa7febd1bfc88ef5e3d35f67d`. Independent review of that exact
head against `f8732fd005a8b77fa79c7d63abe52c5a08b205bd` then recorded Changes
requested in review `4812913188`: 0 Critical, 12 Important and 4 Minor findings.
The earlier zero-finding verdicts in this ledger are historical checkpoints,
not acceptance of `d5ebca2`.

## 2026-07-29 PR #82 repair checkpoint 1

- Reviewed starting head: `d5ebca214863389aa7febd1bfc88ef5e3d35f67d`.
- Repair implementation head before this ledger-only commit: `25235b7`.
- Publication/CI state: additive commits are local and cleanly committed; they
  have not yet received new exact-head CI or independent review.
- Fixed Important 1 in `173e792`: the persistent production character now
  breaks the reused CSS animation lifecycle on a state change. RED reused the
  old `thinking` animation at 10 seconds; GREEN starts `success` and `warning`
  at cell zero, visits all 16 cells and finishes on the terminal cell. The
  complete character browser file passed 24/24 across Chromium and Firefox;
  70 affected unit/configuration tests passed.
- Fixed Minor 2 in `8fcedce`: the Codex deep-link server regression failed
  alone with `403 !== 200`; it now creates/restores its own device settings and
  restores the inspector in `try/finally`, and passes independently.
- Fixed Minor 4 in `f0f9289`: a failing documentation contract now requires
  the Beta 23 note, upgrade/rollback guide and troubleshooting guide to state
  that no manual data conversion is normally needed, older Scout must stop
  before first fenced activation, the fenced lease becomes authoritative and
  downgrade/coexistence is refused. All documentation checks pass.
- Fixed Minor 1 in `5618adb`: activation retains the current and immediately
  previous exact shell caches, navigation falls back only to the active cache,
  and versioned assets resolve from their matching build. The real Chromium
  A-client → activate B → stay on A → disable HTTP cache → offline unused-A
  sprite regression passes, as does the independent B offline graph.
- Fixed Important 3 and Important 4 in `4ffa882`: URL/code candidates are
  committed only from complete bounded records; incomplete output recognises
  only the minimal non-secret Claude prompt. The split secret-labelled prefix
  regression leaves code and URL null. Claude OAuth accepts only the complete
  eight-key reviewed query with strict count/value/length/host rules and
  preserves the accepted query exactly; unknown parameters, duplicates,
  userinfo, fragments and unbounded values fail closed. The 64 affected
  provider-login/setup tests and release audit pass.
- Fixed Important 2 in `25235b7`: provider-scoped cross-process
  authentication-mutation capabilities block only same-provider preflight,
  prevent local credential observations overwriting `login-in-progress`,
  expire/recover within a bound and are held through child/confirmation
  closure plus terminal health persistence. Explicit Claude logout acquires
  the same authority before its fresh expiry check and mutation. Sixty focused
  authority/health/login tests, all 50 server tests and release audit pass.
- Still open from the exact-head review: Important 5–12 and Minor 3. Important
  12 is partially repaired by this truthful bridge/checkpoint but requires one
  final update at the eventual exact pushed head.
- Exact next action: push this additive checkpoint normally, update draft PR
  #82 with these exact commits and evidence, then implement Important 5 by
  routing chat, bounded fit assessment and onboarding provider results through
  the durable health hook without resending provider work.

## 2026-07-30 PR #82 CI repair and review checkpoint 2

- Resumed from exact pushed head
  `3b130c69f0bc807057be33c9f2a59e1f6d3c47a0`.
- Repaired failed CI run `30493547303` without weakening production contracts:
  `221de5a` replaced a stale service-worker spelling assertion with an executed
  cache-behaviour contract and yielded between already-durable scan stages so
  the existing heartbeat can renew its genuine fence. `35a94df` made the
  heartbeat takeover integration test wait for durable renewal evidence rather
  than a fixed sleep. `93da518` aligned the semantic-recovery test's heartbeat
  with its injected wall and monotonic clocks.
- Replacement CI run `30528186616` passed all seven jobs at exact head
  `93da5189e9872b05f4384df335d5eeb719511911`: Node/test/release-audit on
  Ubuntu, macOS ARM, Intel macOS and Windows, plus browser acceptance on Ubuntu
  Firefox, Ubuntu Chromium and Windows Chromium.
- Fixed Important 5 in
  `5988b4cb8cec707ad3262fa06e8c474e761bf911`. RED proved that remote
  authentication failures from ordinary chat, bounded fit assessment and
  onboarding left durable provider health at `checking`. GREEN routes those
  boundaries, both handoff turns and scan assessments through one
  settled-result hook. The hook reduces raw results to the allowlisted health
  vocabulary, retries only the health transition under bounded authority,
  preserves remote-auth barriers until a real remote success and cannot resend
  provider work because it receives no invocation callback.
- The failed ordinary-chat message remains in its private transcript. The
  regression observes one provider invocation after failure and a second only
  after a separate explicit user request; that real remote success clears the
  barrier. Fit assessment and onboarding each prove one invocation and no
  automatic retry.
- Verification for Important 5:
  - focused provider/chat/onboarding/structured-turn/scan group: 100 passed;
  - complete `npm test`: 1,121 discovered, 1,116 passed, 0 failed and 5
    documented platform skips;
  - release/build audit tests: 35 passed;
  - fresh staged release audit: 519 files, passed;
  - `git diff --check`: passed.
- Still open from the exact-head review: Important 6–12 and Minor 3. Important
  12 remains a rolling ledger repair and requires a final exact-head update.
- Exact next action: commit and normally push this ledger checkpoint, update
  draft PR #82 with the Important 5 SHA and evidence, require all seven CI jobs
  to pass, then implement Important 6 by re-detecting provider state inside the
  fenced direct-run preflight after queued work drains.
