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
- Important 5 CI run `30529475151` passed six jobs but failed Ubuntu Node
  because an existing assessment regression compared whole-suite wall time to
  1,000 ms. The same test completed 20/20 isolated runs in 190–225 ms, while
  the loaded Ubuntu runner delayed it to 1,774 ms. Commit
  `871ef5ef419f6df18c93f8407add30ce5c554f27` keeps the unchanged 35 ms
  production watchdog and instead asserts the exact bounded provider sequence:
  one `batch` attempt and one `retry`, each receiving 35 ms, while the
  independent heartbeat advances. Twenty repeated isolated runs, all 14
  assessment tests and complete `npm test` (1,121 discovered, 1,116 passed, 5
  skips, 0 failed) pass.
- Still open from the exact-head review: Important 6–12 and Minor 3. Important
  12 remains a rolling ledger repair and requires a final exact-head update.
- Exact next action: commit and normally push this ledger checkpoint, update
  draft PR #82 with the Important 5 SHA and evidence, require all seven CI jobs
  to pass, then implement Important 6 by re-detecting provider state inside the
  fenced direct-run preflight after queued work drains.

## 2026-07-30 PR #82 review checkpoint 3

- The final Important 5 replacement run
  [30529978300](https://github.com/oliver-hitchings/Scout/actions/runs/30529978300)
  passed all seven required jobs at exact head
  `8fbc2e23adf4adbb9f83e3076509fad1076f9591`.
- Fixed Important 6 in
  `393eedee6aafc078adb8f4280c4aed1fa0f5ebd2`. RED drained three
  distinct older Claude requests before the unqueued Codex run. A Codex
  sign-out during that drain was ignored by the entry-time authenticated
  snapshot, while a sign-in during the same drain was hidden by the
  entry-time signed-out snapshot.
- GREEN removes the entry-time provider observation and re-detects the
  selected provider inside the current fenced health preflight after startup
  queue drain. The exact freshly trusted status object, including its
  executable and environment, is retained for every bounded assessment call
  in that run.
- The signed-out scheduled regression drains all three older requests,
  durably abandons the direct run as `sign-in-required`, performs no direct
  collection or provider call and creates no replacement queue request. The
  signed-in regression drains the same three requests and proves the provider
  receives the exact new trusted status object once direct assessment begins.
- Verification for Important 6:
  - focused multi-item queue-drain regressions: 2 passed;
  - complete scan runtime suite: 44 passed;
  - complete `npm test`: 1,123 discovered, 1,118 passed, 0 failed and 5
    documented platform skips;
  - release/build audit tests: 35 passed;
  - source release audit: 519 files, passed;
  - fresh stage construction and staged release audit: 182 files, passed;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 7–12 and Minor 3. Important
  12 remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this checkpoint, update draft PR #82, then
  implement Important 7 by reproducing the Windows reused-PID guard-budget
  exhaustion with deterministic observations before changing recovery.

## 2026-07-30 PR #82 review checkpoint 4

- Important 6 CI run
  [30531385486](https://github.com/oliver-hitchings/Scout/actions/runs/30531385486)
  passed all seven required jobs at exact head
  `82aa7609133ac09866ac4c2d034193010b02f721`.
- Fixed Important 7 in
  `05842b7d4b4816f3a9ebd2129c5f733588cd0463`. The deterministic RED
  makes each of two reused-PID observations consume 1,100 ms of the unchanged
  2,000 ms guard budget. Recovery revalidated and moved the stale guard, then
  redundantly observed the same metadata a third time, quarantined it and
  returned busy without trying the now-free canonical guard.
- GREEN uses the injected monotonic clock for the existing guard deadline,
  retains the exact metadata revalidated under recovery authority and does
  not re-observe that same owner while quarantining the moved guard. Recovery
  state now distinguishes retry after actual cleanup/race progress from wait
  when the blocking state did not change. A successful cleanup receives one
  immediate canonical acquisition pass even if the original deadline elapsed;
  a failed quarantine still waits and returns busy.
- Deterministic regressions prove two observations only, post-cleanup
  acquisition, no acquisition after injected quarantine contention and
  fail-closed preservation when a live owner cannot be verified. A separate
  Windows-only integration uses the real process-start observer against the
  current live PID with a different persisted start identity.
- Verification for Important 7:
  - deterministic progress/no-progress/fail-closed regressions: 3 passed;
  - complete lease suite: 62 discovered, 61 passed and 1 Windows-only skip;
  - combined lease, queue and durable pipeline suites: 152 discovered, 151
    passed and 1 Windows-only skip;
  - complete `npm test`: 1,127 discovered, 1,121 passed, 0 failed and 6
    platform skips;
  - release/build audit tests: 35 passed;
  - source release audit: 519 files, passed;
  - fresh stage construction and staged release audit: 182 files, passed;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 8–12 and Minor 3. Important
  12 remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this checkpoint, update draft PR #82 and
  require the real Windows integration plus all other CI jobs to pass, then
  implement Important 8's production-interface Gate 5 fault matrix.

### Important 7 Windows CI follow-up

- CI run
  [30532451491](https://github.com/oliver-hitchings/Scout/actions/runs/30532451491)
  at exact head `7f28ca766701e1c3081aad79124208dc6334f46d` passed six of
  seven jobs. Windows Node/audit alone failed the cross-process heartbeat
  regression after the lease contender completed its bounded identity work
  later than the heartbeat-owner fixture's unrelated five-second stop-file
  polling deadline. The production heartbeat/takeover assertion itself had
  succeeded; the child exited while waiting for the parent to create its
  cleanup file, but the parent was still awaiting the contender.
- The repair replaces that circular timed filesystem cleanup handshake with an
  explicit parent-to-child stdin stop signal. It does not increase a lease,
  guard, liveness-observation or takeover timeout and does not relax the
  production assertions. The parent still stops the owner in `finally`, and
  the child still releases its genuine live lease before reporting.
- GREEN verification before publication: the exact cross-process regression
  passed ten consecutive isolated runs. A replacement all-seven CI run is
  required before Important 8 may be published as complete.
- Replacement run
  [30534312496](https://github.com/oliver-hitchings/Scout/actions/runs/30534312496)
  then exposed an independent macOS ARM test defect: the provider-timeout
  regression assigned fake PID `4242` but called the real OS process-group
  signal function. That process group existed on the shared runner, so the
  real `SIGTERM` succeeded outside the fake child and only fallback `SIGKILL`
  appeared in the fake signal log. The production boundary now accepts the
  same injectable process-group signal dependency used by other provider
  lifecycle tests, and the regression asserts exact `-pid`, `SIGTERM`,
  `SIGKILL` calls without signalling a real process. Ten consecutive focused
  runs pass; another replacement all-seven CI run remains required.

## 2026-07-30 PR #82 review checkpoint 5

- Important 7's final replacement CI run
  [30534610810](https://github.com/oliver-hitchings/Scout/actions/runs/30534610810)
  passed all seven required jobs at exact pushed head
  `0285fd26aca1899a0b7b8c6fac203a844f8c7b10`: four Node/audit jobs and
  three browser-acceptance jobs.
- Important 8 is implemented in three focused commits:
  - `4458c184202dabfdfac63428789e4a845c14f3d6` repairs production recovery
    candidate selection for a journal with a valid hash-checked prefix and a
    torn final append. The RED regression showed the candidate was rejected
    before fenced recovery could quarantine the incomplete tail. Empty or
    wholly invalid journals still fail closed, while a valid prefix now reaches
    the existing recovery/quarantine boundary.
  - `5452ad8189e4983971516334c44a0aecf07acf82` closes and destroys the
    heartbeat-owner fixture's stdin after its explicit stop signal. This
    preserves the real cross-process heartbeat/takeover assertion while
    preventing a completed child from retaining an input handle under the
    concurrent full suite.
  - `2db30f304c168e66d64c34ab184d9b024164557e` replaces fixture-only Gate 5
    confidence with production-interface fault injection.
- The production fault matrix now exercises every durable discovery boundary;
  initial assessment, focused repair, per-job retry, exhaustion and completed
  work reuse; stale assessment fencing; tracker/report mutation faults before,
  during and after replacement; ambiguous mutation state; backup/mutation
  exclusion; simultaneous leases, heartbeat/takeover, owner death and boot
  identity; torn and invalid-hash journals; manifest rebuild; queue
  deduplication, expiry, supersession, orphan recovery and automatic handoff;
  reviewed archive cleanup, interrupted cleanup and queue compaction; storage
  pressure, backup, tamper rejection and one-way legacy migration.
- Valid run state is created through the durable pipeline and read through the
  real `/api/scan/runs` route and production UI. The #72–#76 browser
  composition uses the production route consumers and separately verifies the
  real bounded device-local Codex capability route before exercising the
  composed UI states.
- Verification for Important 8:
  - exact cross-process heartbeat regression: 10 consecutive passes;
  - source release audit: 519 files, passed;
  - combined lease, queue and durable pipeline suites: 153 discovered, 152
    passed and 1 documented Windows-only skip;
  - real Chromium Gate 5 matrix: 14 passed;
  - complete `npm test`: 1,128 discovered, 1,122 passed, 0 failed and 6
    documented platform skips;
  - complete cross-browser acceptance: 168 discovered, 157 passed, 0 failed
    and 11 intentional Chromium-only skips;
  - fresh stage construction and staged release audit: 182 files, passed;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 9–12 and Minor 3. Important
  12 remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this checkpoint, update draft PR #82,
  require all seven CI jobs to pass, then implement Important 9 by injecting
  nested ignored private files into the real release-stage boundary and
  proving the combined stage-plus-audit gate fails closed.

## 2026-07-30 PR #82 review checkpoint 6

- Important 8 CI run
  [30535714483](https://github.com/oliver-hitchings/Scout/actions/runs/30535714483)
  passed all seven required jobs at exact pushed head
  `c2783a1d304ea2df59822d02c032eae758458739`.
- Full-suite verification exposed a separate readiness-publication race in the
  cross-process heartbeat fixture. Under sufficient load the parent could see
  the ready pathname after creation but before its JSON content was visible,
  then throw before entering child cleanup. Commit
  `c81bf595a58375b786f11924929569fff7b71fc2` publishes that synthetic
  readiness document through a same-directory atomic rename and moves
  readiness parsing under unconditional cleanup. The lease duration, takeover
  margin and liveness assertions are unchanged.
- Important 9 is implemented in
  `b59e81a1cbf72fba72573750f69ecbee336acd23` and
  `95270fe200171f19b76ac88b86e81117d28fa2bf`. The RED tests placed
  case-variant nested `.env`, `workspace.json`, log, temporary and backup
  files inside real public-source and installer staging trees; both boundaries
  copied them, and the unit policy admitted them.
- A shared case-insensitive copied-tree predicate now excludes those private
  artifact classes from release trees, public-source trees and the production
  dependency copy. Public-source tree copies no longer bypass the predicate.
  The synthetic stage contains a configured private marker in each adversarial
  file and proves the combined stage-plus-real-audit gate remains green only
  because none of those inputs reaches the staged tree.
- The first real stage after that repair correctly caught an over-broad
  `workspace.json` rule: it removed Scout's required generic
  `templates/workspace/workspace.json`. The follow-up gives copy filters their
  source-root context and permits only that exact reviewed public template;
  arbitrary nested workspace configuration remains excluded. The real stage
  returned to 182 files, retains the template and passes its privacy audit.
- Verification for Important 9:
  - RED staging/policy regressions: 3 failed for the private-file leak, then 4
    failed for required-template preservation;
  - focused GREEN staging/policy regressions: 4 passed;
  - release staging, privacy-audit and documentation suites: 42 passed;
  - heartbeat regression: 20 consecutive passes;
  - complete lease suite: 62 discovered, 61 passed and 1 Windows-only skip;
  - complete `npm test` after the readiness repair and primary staging fix:
    1,128 discovered, 1,122 passed, 0 failed and 6 platform skips;
  - real public-source stage with configured synthetic marker: passed;
  - fresh release stage: 182 files, required workspace template present and
    staged privacy audit passed;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 10–12 and Minor 3. Important
  12 remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this checkpoint, update draft PR #82,
  require all seven CI jobs to pass, then implement Important 10 by making the
  stage-mode privacy audit inspect the actual selected production dependency
  payload and proving extra private JSON, text, log and runtime files inside a
  selected package are detected.

## 2026-07-30 PR #82 review checkpoint 7

- Important 9 CI run
  [30536900055](https://github.com/oliver-hitchings/Scout/actions/runs/30536900055)
  failed only the Windows Chromium job at exact pushed head
  `f5f0d26d79faeb309257e5c64d4dbdc0a07db750`; the other six required
  jobs passed, including all four Node, staging and audit jobs.
- The Windows browser evidence showed two manifestations of one test-clock
  mismatch in the production recovery matrix. The lease used a frozen
  injected wall and monotonic clock, but its production heartbeat silently
  rebased onto real elapsed time. On the slower runner the genuine one-second
  fence could therefore expire before the intended injected finalisation
  interruption, yielding a truthful `lease-lost` result; the stale-worker
  case could likewise report the loss at `select` instead of at `finalise`.
  The production fencing response was correct and no timeout was increased.
- Commit `700e6c2` passes the same controlled wall and monotonic clock to the
  production heartbeat in both scenarios. Machine speed can no longer expire
  the synthetic lease, while the tests retain their one-second duration,
  explicit clock advance, successor takeover, stale-write rejection,
  interrupted-run recovery and exact journal assertions.
- Verification for the CI repair:
  - both affected fault paths: 40 passed across 20 consecutive repetitions
    each;
  - complete production recovery matrix: 14 passed;
  - complete `npm test`: 1,128 discovered, 1,122 passed, 0 failed and 6
    platform skips;
  - complete cross-browser acceptance: 168 discovered, 157 passed, 0 failed
    and 11 intentional Chromium-only skips;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 10–12 and Minor 3. Important
  12 remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this checkpoint, update draft PR #82,
  require all seven replacement CI jobs to pass, then begin Important 10.

## 2026-07-30 PR #82 review checkpoint 8

- Replacement CI run
  [30537833020](https://github.com/oliver-hitchings/Scout/actions/runs/30537833020)
  passed all seven required jobs at exact pushed head
  `d1247dfe2ee47d8ac2c0e60a1f550b69ba18fd7a`.
- Important 10 is implemented in
  `b0000619edcb3c0fffa1c4d15c0e7d0b77c6f45a`. The RED tests proved that
  explicit stage mode scanned only the non-dependency file and that the real
  staged installer admitted selected-package JSON, text and runtime state
  without the privacy audit noticing it.
- Explicit `--stage` traversal now includes every installed `node_modules`
  file. Ordinary tracked-source and build-directory audits retain their
  dependency exclusion. Every staged dependency text file receives configured
  personal-marker and concrete-token checks; raw-state, credential and path
  heuristics additionally inspect JSON, JSONL, NDJSON, log, output and text
  payloads while excluding reviewed package metadata. This avoids treating
  third-party source, documentation, type declarations and source maps as
  private workspace state.
- The adversarial stage boundary covers extra private JSON, text, log and
  runtime-journal files inside a selected package. A second regression uses
  the real release builder, confirms the selected dependency files physically
  enter the installer stage, and requires the spawned stage audit to reject
  them. The clean real installer audit now scans 1,582 files rather than the
  previous 182-file non-dependency projection.
- Verification for Important 10:
  - RED dependency boundaries: 2 failed;
  - focused release build and audit suite: 37 passed;
  - marker-required real release-stage audit: 1,582 files scanned, passed;
  - release workflow and documentation suite: 17 passed;
  - complete `npm test`: 1,130 discovered, 1,124 passed, 0 failed and 6
    platform skips;
  - complete cross-browser acceptance: 168 discovered, 157 passed, 0 failed
    and 11 intentional Chromium-only skips;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 11–12 and Minor 3. Important
  12 remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this checkpoint, update draft PR #82,
  require all seven CI jobs to pass, then implement Important 11's
  format-independent sensitive-field and private-path coverage.

## 2026-07-30 PR #82 review checkpoint 9

- Important 10 CI run
  [30538977383](https://github.com/oliver-hitchings/Scout/actions/runs/30538977383)
  passed all seven required jobs at exact pushed head
  `5091e2cad0b2c8dd3c0b90c297134aa03fab0456`.
- Important 11 is implemented in
  `0d975c6ae4c1e3d5b4e8f50f4ecba97baec36735`. The RED regressions proved
  that YAML and TOML `rawRunState`, `raw_run_state` and `prompt` fields passed
  the release audit, as did the complete adversarial profile-path matrix for
  root homes, alternate Unix homes, UNC shares and real usernames beginning
  with placeholder-like text.
- State-shaped scanning now covers YAML, YML and TOML as well as the existing
  JSON, JSONL, NDJSON, log, output and text formats. Its syntax-independent
  fallback accepts both colon and equals field syntax. Successfully parsed
  JSON/JSONL is not rescanned as damaged text, public skill
  `default_prompt` metadata remains distinct from captured prompt fields, and
  unparsed generic process-output words remain unclassified without
  provenance. Parsed generic `output` and `payload` handling remains open
  under Minor 3.
- Private-path classification now uses exact segments rather than prefix
  exemptions. It detects root-account homes, macOS and derived Unix home
  families, drive-letter Windows profiles, and UNC `Users`, `home`, `homes`
  and `profiles` shares. Only exact public or documented placeholder segments
  are exempt; adversarial
  `yourname`, `yourself`, `YourAccount` and mixed-case equivalents fail. The
  findings continue to contain only file, line and rule metadata, never the
  matched private value.
- The explicit stage regression now proves that YAML and TOML leaks inside a
  selected production dependency are inspected at the installer boundary.
- Verification for Important 11:
  - RED focused boundary: 2 failed and 1 exact-placeholder control passed;
  - focused release audit: 29 passed;
  - focused release build and audit suite: 40 passed;
  - fresh release stage and marker-required audit: 1,582 files scanned,
    passed;
  - complete `npm test`: 1,133 discovered, 1,127 passed, 0 failed and 6
    platform skips;
  - complete cross-browser acceptance: 168 discovered, 157 passed, 0 failed
    and 11 intentional Chromium-only skips;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 12 and Minor 3. Important 12
  remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this checkpoint, update draft PR #82,
  require all seven CI jobs to pass, then repair the remaining generic
  `output`/`payload` provenance false positive before the final exact-head
  ledger reconciliation.

## 2026-07-30 PR #82 review checkpoint 10

- Important 11 CI run
  [30540383849](https://github.com/oliver-hitchings/Scout/actions/runs/30540383849)
  failed all four Node jobs during `npm test` at exact pushed head
  `a06d61ef4a62c92fd72ce0df3f05dfcb7c983f2c`. All three browser jobs
  passed.
- Every Node platform failed the same clean-tree release-audit integration
  assertion. The new detector correctly rejected two root-account
  path-shaped examples added to this public ledger after the implementation
  suite had run. Release staging and audit steps were skipped because the Node
  gate failed.
- Commit `ce17134f002f81457fb59170d485039aa65fb5e1` records the behavior
  without embedding private-path-shaped literals. It also makes the
  clean-tree assertion report the audit's already bounded file, line and rule
  metadata, so a future failure identifies its public source without exposing
  matched values.
- Verification for the CI repair:
  - combined release build and audit suite: 40 passed across 20 consecutive
    repetitions, 800 total test executions;
  - fresh marker-required release-stage audit: 1,582 files scanned, passed;
  - complete `npm test`: 1,133 discovered, 1,127 passed, 0 failed and 6
    platform skips;
  - the failed-head CI run's three browser jobs all passed;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 12 and Minor 3. Important 12
  remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this repair checkpoint, update draft PR
  #82, require all seven replacement CI jobs to pass, then implement Minor 3.

## 2026-07-30 PR #82 review checkpoint 12

- Important 11 replacement CI run
  [30543397168](https://github.com/oliver-hitchings/Scout/actions/runs/30543397168)
  passed all seven required jobs at exact pushed head
  `872b06f5d5519cdf05261fd1bd91bbec46dbae82`: four Node, release-stage
  and audit jobs plus three browser jobs. Windows Node/audit passed in 4m57s,
  and the Intel macOS ranking regression also passed.
- Minor 3 is implemented in
  `136e4a10d834e8f4aa2ae9c7b16fe014613979c7`. The RED matrix proved that
  otherwise benign parsed build and package records were rejected solely
  because they used generic `output` or `payload` keys. The same false
  positives appeared inside a selected staged dependency.
- Bare `output` and `payload` are now private only when their owner or
  ancestry establishes auth, provider, session, run, scan, execution,
  journal or transcript provenance. Explicit raw payload keys and
  `stdout`/`stderr` remain fail-closed, as do every independent credential,
  prompt, transcript, run-state, advert, CV, marker and private-path rule.
  Benign generic package metadata now remains auditable at the complete
  staged-dependency boundary.
- Verification for Minor 3:
  - focused RED boundary: 3 failed;
  - focused release build and audit suite: 41 passed;
  - complete `npm test`: 1,135 discovered, 1,129 passed, 0 failed and 6
    platform skips;
  - complete cross-browser acceptance: 168 discovered, 157 passed, 0 failed
    and 11 intentional Chromium-only skips;
  - source release audit: 519 files scanned, passed;
  - fresh marker-required release-stage audit: 1,582 files scanned, passed;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 12 only. It remains a
  rolling ledger repair and requires final old-to-rewritten history,
  publication, CI and exact-head reconciliation after this checkpoint is
  pushed and its seven jobs pass.
- Exact next action: normally push this Minor 3 checkpoint, update draft PR
  #82, require all seven CI jobs to pass, then perform Important 12's final
  durable-ledger and exact-head reconciliation.

## 2026-07-30 PR #82 review checkpoint 13

- Minor 3 CI run
  [30544560153](https://github.com/oliver-hitchings/Scout/actions/runs/30544560153)
  passed all three browser jobs and the Ubuntu, ARM macOS and Intel macOS
  Node/audit jobs at exact pushed head
  `2d11162e7c280f0bc257bd49f661252c0b65126c`. Windows alone failed
  `competing processes serialize overlap enqueues through the workspace
  guard`; release staging and audit were skipped after `npm test` failed.
- The Minor 3 audit matrix passed on Windows. The unrelated failure was a
  one-shot Windows filesystem busy result while a four-process queue
  contender published the canonical guard junction. Guard cleanup already
  treated that platform result as transient, but canonical publication
  omitted it from the existing lost-race codes and allowed it to escape.
- Repair commit `db143488e5ef1c34a863c5c3df0d1e8ae7012d99`
  classifies only that Windows busy publication result with the existing
  contention path. The contender re-observes and retries inside the unchanged
  monotonic acquisition budget; unexpected I/O failures still propagate.
  No lease, heartbeat, guard or test timeout changed.
- A deterministic RED regression injects exactly one busy result at canonical
  guard publication and requires the second publication attempt to acquire
  inside its original 100ms test budget.
- Verification for the guard-publication repair:
  - focused RED regression: 1 failed;
  - deterministic busy publication plus exact four-process queue contention:
    20 consecutive runs, 40 passed and 0 failed;
  - complete lease and queue suites: 88 discovered, 87 passed, 0 failed and 1
    Windows-only skip;
  - complete `npm test`: 1,136 discovered, 1,130 passed, 0 failed and 6
    platform skips;
  - complete cross-browser acceptance: 168 discovered, 157 passed, 0 failed
    and 11 intentional Chromium-only skips;
  - source release audit: 519 files scanned, passed;
  - fresh marker-required release-stage audit: 1,582 files scanned, passed;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 12 only. Exact-head
  reconciliation remains blocked on all seven replacement CI jobs passing.
- Exact next action: normally push this repair checkpoint, update draft PR
  #82, require all seven replacement CI jobs to pass, then perform Important
  12's final durable-ledger and exact-head reconciliation.

## 2026-07-30 PR #82 review checkpoint 11

- Important 11 replacement CI run
  [30540952581](https://github.com/oliver-hitchings/Scout/actions/runs/30540952581)
  passed all three browser jobs and three of the four Node/audit jobs at exact
  pushed head `e6c3dc1c6f82f7534cc476b6a7d2817b01b3783d`. Windows alone failed
  `an independent heartbeat prevents a competing process from taking over`
  after the heartbeat failed to renew beyond its original takeover window.
- The failure was platform-specific work inside the renewal loop, not an
  insufficient test allowance. Every heartbeat tick re-observed its own
  process-start identity; on Windows that can require a PowerShell process
  query. The heartbeat already holds an opaque hydrated in-process lease
  capability that cannot be recreated from durable JSON, so repeating that
  platform observation could consume the lease window under runner load.
- Repair commit `f550c616d0bb391ac1253066e6336a9fe5ccd2c3` keeps direct/manual
  renewals fail-closed behind current-process identity proof, while the
  heartbeat renews through its existing opaque local capability. Renewal
  still revalidates the persisted fence, expiry, workspace guard and
  one-way legacy-lock boundary before writing. No lease duration, heartbeat
  interval or test timeout changed.
- A deterministic RED regression injected a throwing process-identity
  observation hook and proved the heartbeat previously attempted the
  redundant observation instead of renewing. It is GREEN only when the
  heartbeat advances the durable sequence with zero repeat observations.
- Verification for the Windows heartbeat repair:
  - focused real cross-process contender plus opaque-capability regression:
    20 consecutive runs, 40 passed and 0 failed;
  - complete lease suite: 63 discovered, 62 passed, 0 failed and 1
    Windows-only skip;
  - exact cross-browser durable-recovery integration: 20 consecutive
    Chromium repetitions passed after an initial isolated pass;
  - complete `npm test`: 1,134 discovered, 1,128 passed, 0 failed and 6
    platform skips;
  - complete cross-browser acceptance: 168 discovered, 157 passed, 0 failed
    and 11 intentional Chromium-only skips;
  - fresh marker-required release-stage audit: 1,582 files scanned, passed;
  - `git diff --check`: passed.
- Still open from review `4812913188`: Important 12 and Minor 3. Important 12
  remains a rolling ledger repair and requires another update at the final
  exact pushed head.
- Exact next action: normally push this repair checkpoint, update draft PR
  #82, require all seven replacement CI jobs to pass, then implement Minor 3.

## 2026-07-30 Important 12 final ledger reconciliation

This section supersedes only stale current-state claims in the historical
checkpoints above. It does not replace their RED/GREEN evidence or reinterpret
an earlier candidate review as acceptance of a later tree.

### Rewrite and review identity

- PR #82 still targets exact base
  `f8732fd005a8b77fa79c7d63abe52c5a08b205bd`.
- The authorised metadata rewrite retained identical trees and commit
  messages. Old published head
  `dcf2c5ef02d726eeb35d997a53f156f90b440a76` maps to rewritten
  `7953b48`; old final implementation checkpoint `f152950` maps to
  `ab402c2ffa33d25d1cb6f26cfef5ea765b8b9067`. The two 64-commit
  ranges have identical final tree
  `472c7856ad85f5a9f0b9514aafccd3331abdee19` and the ordered
  tree/message digest recorded in the 2026-07-29 bridge above. The complete
  old-to-rewritten commit map remains in the draft PR body.
- Two additive Windows portability commits followed the rewrite. Their exact
  reviewed descendant was
  `d5ebca214863389aa7febd1bfc88ef5e3d35f67d`.
- The independent review is resolvable at
  [review 4812913188](https://github.com/oliver-hitchings/Scout/pull/82#pullrequestreview-4812913188).
  It records Changes requested against exact head `d5ebca2`: 0 Critical,
  12 Important and 4 Minor findings. It is the authority for the repair list,
  but it is not an approval of any descendant.

### Complete post-review behavior bridge

The following additive commits are every behavior-changing repair between the
reviewed head and the final implementation/evidence head. Ledger-only commits
between them record the detailed reproductions, verification counts and CI
runs above.

- `173e792` restarts in-place Scout character state animations; `8fcedce`
  isolates the Codex deep-link test; `f0f9289` documents the one-way fenced
  lease upgrade; and `5618adb` retains the immediately previous exact offline
  shell cache.
- `4ffa882` makes guided-login parsing record-complete and preserves only a
  strictly allowlisted equivalent Claude OAuth URL; `25235b7` adds
  provider-scoped authentication-mutation authority.
- `221de5a` replaces the stale service-worker source-spelling assertion with
  executed cache-contract semantics and lets durable scan stages yield to the
  existing heartbeat. `35a94df` observes durable takeover readiness and
  `93da518` aligns injected recovery clocks.
- `5988b4c` routes chat, assessment and onboarding results through durable
  provider health without resending work; `871ef5e` asserts assessment retry
  bounds semantically rather than by whole-suite wall time.
- `393eede` refreshes the selected provider after queue drain and uses the
  same freshly trusted status for the direct run.
- `05842b7` recovers a Windows reused-PID guard with progress-aware retry and
  one post-cleanup acquisition attempt. `51e55b6` replaces a circular
  fixture-cleanup poll with explicit input, and `0285fd2` injects provider
  timeout signals instead of targeting a real process group.
- `4458c18` admits a valid hash-checked journal prefix with a torn final
  append; `5452ad8` closes the heartbeat fixture input; and `2db30f3`
  exercises the production recovery fault matrix through real interfaces.
- `c81bf59` publishes cross-process readiness atomically. `b59e81a` excludes
  nested ignored private artifacts at every copied-tree boundary, while
  `95270fe` preserves only the exact reviewed public workspace template.
  `700e6c2` gives recovery fault heartbeats the same deterministic clocks as
  their leases.
- `b000061` audits actual staged production dependencies.
- `0d975c6` closes cross-format and cross-platform privacy-audit gaps;
  `ce17134` keeps the audit's own public evidence privacy-safe; and
  `f550c61` avoids a redundant platform process-identity probe for an opaque
  in-process heartbeat capability while retaining fail-closed manual renewal.
- `136e4a1` scopes generic serialized output and payload fields by provenance
  while retaining explicit raw payload, stdout and stderr detection.
  `db14348` treats a Windows busy result during canonical guard publication as
  the same bounded lost race already used for other contention results.

All 16 findings from review `4812913188` are therefore fixed as candidate
changes. The review decision correctly remains Changes requested until a
reviewer evaluates this descendant; no historical review is represented as
approval.

### Exact implementation head, publication and verification

- Final implementation/evidence head before this ledger-only reconciliation:
  `c63de191d3392d59c3e652fb6670c8105930ee85`.
- Publication is no longer blocked. The local branch and the published fork
  branch `agent/finish-epic-77-tasks-12-18` both resolve to that SHA, and
  cross-repository PR #82 is open and remains draft. No later history rewrite,
  force push, merge or issue closure occurred.
- Replacement
  [CI run 30545561626](https://github.com/oliver-hitchings/Scout/actions/runs/30545561626)
  passed all seven required jobs at that exact head: Node, release staging and
  staged audit on Ubuntu, Windows, ARM macOS and Intel macOS, plus browser
  acceptance on Ubuntu Chromium, Ubuntu Firefox and Windows Chromium.
- Local verification for the final behavior repair discovered 1,136 Node
  tests: 1,130 passed, 0 failed and 6 intentional platform skips. Browser
  acceptance discovered 168 tests: 157 passed, 0 failed and 11 intentional
  Chromium-only skips. The source audit scanned 519 files and the fresh
  marker-required installer-stage audit scanned 1,582 files, both clean.
  Complete-range diff checks passed.
- Author and committer metadata for every additive post-review commit use the
  configured GitHub noreply identity. The worktree and published branch were
  clean and equal before this documentation-only change.

A Git commit cannot embed its own SHA because the file content determines that
SHA. The commit containing this section is therefore a documentation-only
descendant of the named, fully green implementation head. After it is
fast-forward published and its seven jobs pass, an additive attestation must
record that exact reconciliation SHA and CI run without rewriting history.

- Exact next action: commit and normally publish this reconciliation, require
  all seven CI jobs to pass, append the exact reconciliation SHA and CI result,
  normally publish that attestation and require all seven jobs to pass again.
  Then begin the Gate A requirement-by-requirement evidence reconciliation;
  keep PR #82 draft and leave every protected issue and epic checkbox open.

### Additive reconciliation attestation

- The reconciliation above was committed and fast-forward published as exact
  SHA `f258c4e87d63f2864175240f5e9e9b659fa75f8d`.
- [CI run 30546232396](https://github.com/oliver-hitchings/Scout/actions/runs/30546232396)
  passed all seven required jobs at that exact SHA, including complete Node,
  release-stage and staged-dependency audit gates on all four platforms.
- This attestation is the only change after that green reconciliation. The
  commit containing this subsection is necessarily identified by Git rather
  than self-referential file content; its exact published SHA and seven-job
  result must be recorded in draft PR #82 before Gate A work starts.
- Important 12 is complete as a candidate once that final attestation run is
  green. The durable record then contains the rewrite bridge, resolvable
  review, complete post-review behavior bridge, real publication state and
  exact green reconciliation state without claiming a descendant was reviewed
  by the historical Changes requested decision.

## Gate A10 — existing next-beta readiness reconciliation

- Status: implementation and local acceptance complete; protected merge,
  issue closure and epic checkbox updates remain deliberately deferred.
- Verification head before this ledger-only change:
  `72f4571eead481e33808fe85588a61c01befd622`.

### PR #71 — safe backup divergence

- Recommendation: **supersede** the backup-divergence portion of draft PR #71
  with the integrated implementation. Do not merge its branch into PR #82.
- Duplicate behavior retained: sanitised ahead/behind diagnosis, refusal of
  ambiguous or overlapping changes, confirmation before resolution, recovery
  references, a normal merge and push, and explicit no-reset/no-rebase/
  no-force-push guidance.
- Integrated behavior is stricter than the original candidate: the analysis
  is bound to exact verified tips and object IDs; malformed diff metadata,
  symlinks, gitlinks, mode changes, deletions, renames and dirty state fail
  closed; both recovery refs precede an exact no-FF merge; stale analysis and
  tracking-ref movement are rejected; merge/push failure preserves both
  histories; and backup resolution uses the same lease and mutation
  coordinator as tracker/report/scan writes.
- Real production-interface race evidence:
  - `backup divergence resolution cannot overlap a tracker or report
    mutation`;
  - `backup divergence confirmation cannot acquire authority while a scan
    owns the fence`.
  Both passed, 2/2, against real temporary Git repositories and the real HTTP
  route.
- Unique unrelated commit `3f95b5c` reorders Speculative before Jobs. It is
  intentionally excluded because the operator did not approve that separate
  product change. Jobs remains first in both navigation and content order.
- PR #71 must remain draft/open for the protected reviewer to accept the
  supersede recommendation or choose a split. This work does not close it.

### Issue #72 — Scout character

- The canonical state table controls sheets, cells, frame rates, looping,
  still frames and anchors. A real state change explicitly replaces the CSS
  animation lifecycle so persistent-element transitions to `success` and
  `warning` begin at frame zero and finish exactly one complete walk.
- Focused Node verification: 70/70 passed.
- Real Chromium and Firefox character acceptance: 24/24 passed, including
  in-place one-shot transitions, every configured cell, per-state timing,
  partial sheets, reduced motion, labelled pre-module fallback, and
  representative-frame centring at 44px and 112px.

### Issues #73 and #74 — models and asynchronous usage

- Model catalogues retain trustworthy provenance, readable trade-offs,
  effective-default explanations, explicit bundled fallback and stale/
  rejected model states. Custom IDs remain a deliberate advanced escape hatch.
- Drawer state is generation-bound and reducer-owned. Usage and engine
  responses preserve each other in both completion orders; stale responses
  from an older refresh, closed drawer or different chat are ignored.
- Focused model, drawer, chat and Codex-fallback verification: 56/56 passed.
- Real Chromium and Firefox chat-drawer acceptance: 34/34 passed, including
  both response orders, unavailable usage, refreshed/fallback/stale/rejected
  catalogues, chat switching/closure and keyboard operation.

### Issue #75 — supported Codex navigation and fallback

- Direct navigation is offered only for a bounded, device-local supported
  handler. Remote browsers, missing handlers, unsupported platforms, hostile
  task IDs and unacknowledged/failed launches receive an exact copyable task
  identity and resume guidance; Scout never claims that an anchor click
  succeeded.
- The server regression now creates and restores its own device settings and
  restores its handler inspector in cleanup. It passed twice in separate
  standalone processes, 1/1 each time, proving that it no longer depends on
  test order or leaked global state.
- The Chromium and Firefox drawer acceptance above also passed the supported,
  missing, remote, failed-navigation, hostile-ID and mixed stale-model cases.

### Issue #76 — provider health and guided reauthentication

- Same-provider authentication mutation authority prevents local preflight or
  health writes from replacing `login-in-progress`; the other provider remains
  independent. Authority is released only after child closure and durable
  terminal health persistence.
- Login output is record-complete before parsing. Ambiguous chunk prefixes
  cannot publish a Codex device code or URL, and Claude OAuth links preserve
  only a complete strictly allowlisted equivalent query required by the
  provider flow.
- Ordinary chat, bounded fit assessment and onboarding route remote-auth
  results through durable provider health without automatically resending
  provider work. The failed message/work remains available for explicit retry.
- A direct scan re-detects the selected provider after startup queue drain and
  passes that same fresh trusted status into the scan, preventing stale
  pre-queue authentication from authorising work.
- Windows reused-PID recovery is progress-aware, grants one acquisition pass
  after genuine stale cleanup, continues to wait when cleanup makes no
  progress and remains fail-closed for unverifiable live owners. Heartbeats
  renew through their opaque local capability without redundant identity
  probes.
- The exact six reviewed defect regressions passed 12/12 locally; the genuine
  Windows process-observation integration was the single expected macOS skip.
- Full affected provider-health, login, provider, scheduling, chat,
  onboarding, scan-pipeline, lease, CLI and server matrix: 377 discovered,
  376 passed, 0 failed and 1 Windows-only skip.
- Chromium and Firefox reconnect UI acceptance: 8/8 passed, covering
  device/manual code, durable alerts, failure, explicit retry, cancellation,
  failed clear-session behavior, stale polls, duplicate suppression and no
  browser persistence.

### Explicit exclusions and state

- The old Wails v3 draft PR #15 is excluded from this release inventory and
  Epic #77 scope. No Wails source or migration is imported by Gate A10.
- PR #82 remains draft. PR #71 remains draft/open. Issues #72–#76 remain open.
  No protected merge, issue closure or epic completion checkbox is performed
  by this reconciliation.

## Gate A11 — faults, privacy, packaging and candidate release evidence

- Status: candidate implementation and local acceptance complete. Protected
  review/merge and the authorised live/private acceptance step remain
  deliberately outstanding.
- This work is additive to exact green Gate A10 head
  `ed49a10db768d8597cec0af3eef63932842c75d3`.

### Unknown-value policy contract

- Compensation already exposed published `include`, `penalise` and `exclude`
  behavior. Location had only implicit include-with-zero-confidence behavior,
  so presenting it as a selectable policy would have been false.
- Six RED assertions proved the missing location schema, migration default,
  filter, rank, review and release-note behavior before the repair.
- A published optional `unknownPolicies.location` now accepts only `include`,
  `penalise` or `exclude`. Omission remains beta.22-compatible and behaves as
  `include`; legacy profile migration writes that conservative default.
- `include` keeps an otherwise eligible unknown-location vacancy at zero
  location confidence and never awards a match. `penalise` adds a bounded
  negative contribution tied to `policy-location-unknown`. `exclude` emits an
  overrideable `location-unknown` reason only when a blocking location rule
  exists. The review surface and configuration guide name the selected
  behavior before publication.
- Focused schema, filter, rank, review and documentation verification passed
  67/67.

### Required fault and migration matrix

- Ranked discovery, canonical identity, lifecycle, assessment batches,
  interrupted-run recovery, leases, profile migration, filtering, ranking and
  observation verification discovered 166 tests: 165 passed, 0 failed and 1
  genuine Windows-only process-observation test skipped on macOS.
- That matrix covers unknown compensation, unknown location, duplicate
  observations, material changes, unchanged rejected vacancies, malformed
  assessment artifacts, partial/resumed runs, stale leases, bounded
  diagnostic retention, production-shaped profile migration and the
  beta.22-compatible snapshot/rollback boundary.
- Real source-adapter and complete scan-pipeline verification passed 97/97,
  including fail-soft Adzuna, ATS and hiring.cafe failures, partial-source
  degradation, retry/recovery and preservation of valid completed work.

### Privacy, authentication and release audit

- The provider-authentication, provider-health, guided-login, server,
  observation, release-builder and release-audit matrix passed 187/187.
  Coverage includes same-provider mutation authority, raw-output and
  one-time-code exclusion, bounded diagnostic retention, origin/owner/CSRF
  enforcement, private API cache prevention, safe browser projections,
  provider isolation, staged-runtime filtering and content-based rejection of
  renamed private payloads.
- The live npm advisory audit reported zero vulnerabilities at the
  moderate-or-higher threshold.
- A fresh real release stage was built from the candidate. Its stage-mode
  privacy audit scanned 1,585 files with no configured personal markers and
  passed.

### Candidate notes and live/private boundary

- The beta.23 notes now describe the beta.22-to-candidate ranked-discovery,
  recovery, migration and rollback contract; the #70–#76 readiness inventory;
  the integrated portion of #71 and its deliberately excluded unrelated tab
  reorder; and the unknown compensation/location decisions.
- No authorised operator supplied live VPS access or explicitly requested a
  migration, deployment, rollback or owner-acceptance rehearsal. Those
  private/live steps are therefore **blocked and not recorded as passing**.
  Local, CI and staged-package checks are not substitutes for that evidence.
- The private operator-context record is unavailable in this checkout. No
  hosting detail is inferred or copied into this public evidence.

### Gate A definition-of-done reconciliation

- Candidate evidence proves canonical dedupe/filter/rank precedes detailed
  assessment; global ordering prevents earlier sources and lanes from
  starving stronger work; interruption resumes or remains an auditable
  partial; profile, rule, score, selection and assessment provenance remain
  traceable; and reconciled metrics/UI language distinguish returned,
  duplicate, excluded, eligible, selected, assessed, failed and outcome
  counts.
- Production-shaped migration, immutable historical reranking, explicit
  legacy provenance and beta.22-compatible snapshot/rollback evidence pass.
  Fault, package, privacy and release-stage verification also pass.
- Gate A remains a draft candidate, not an accepted release: protected
  reviewer acceptance/merge, issue acceptance and the authorised live/private
  rehearsal are outside this branch's authority and remain open. No issue is
  closed, no epic completion checkbox is changed and PR #82 remains draft.

## Gate B — adaptive setup and mature search lanes

- Status: candidate implementation and local acceptance complete. Protected
  review/merge remains outstanding; PR #82 stays draft and no epic checkbox is
  changed.
- The reviewed draft now exposes universal structured questions followed by at
  most six occupation-relevant specialist questions. Answers are bounded,
  selective and explicit; unchecked answers do not alter the draft, no answer
  publishes it, and a hard exclusion still requires confirmation.
- Publishing the immutable profile creates or selectively reconciles
  `data/search-lanes.json`. Bounded lanes cover titles, locations, industries,
  skills, remote policy, named employers and configured exploration. Every lane
  retains its exact query, profile-rule provenance, priority, overlap evidence,
  returned/parsed/new/eligible/selected/promising funnel, bounded failures and
  run history.
- Lane selection is independent of stored order, rotates lower-run lanes across
  core/relevant/exploration bands and cannot grow as a profile-field
  cross-product. Re-publication preserves unaffected lane history and archives
  rules that were removed. Three completed non-failed unproductive runs make a
  lane eligible for explicit retirement; restoration is reviewable and
  reversible.
- Query attribution survives cross-query deduplication and canonical
  cross-source merging without changing the raw source-content fingerprint.
  The selected lane contract is fixed at run start, persisted in the collect
  artifact, and its metrics are committed in the same fenced final mutation as
  tracker, report and run-log output. Failed runs retain bounded failure
  evidence and do not count towards unproductive retirement.
- Profile publication, retirement and restoration acquire the existing fenced
  workspace lease, reject stale revisions and cannot race an active scan.
  Marker-free private backup includes the lane plan, and interrupted
  multi-target finalisation recovers without duplicate lane history.
- The exact six Gate A domain fixtures produce six materially different,
  domain-neutral plans. Focused unit/server/pipeline tests cover bounds,
  provenance, overlap, rotation, selective reconciliation, idempotency,
  failure accounting, retirement, restoration, contention and crash recovery.
- Complete candidate verification passed: `npm test` reported 1,189 passes, 0
  failures and 6 platform skips out of 1,195 tests; the formerly slow unique
  ranking test completed in 25.75 seconds. Chromium and Firefox reported 159
  passes, 0 failures and 11 intentional skips out of 170 browser scenarios.
  The source audit passed, a fresh release stage was built, and its stage audit
  scanned 1,587 files with no findings.
