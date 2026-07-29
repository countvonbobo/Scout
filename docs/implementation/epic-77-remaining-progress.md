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
