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
