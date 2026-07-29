# Task 11 implementation report

## Scope and source

- Read Task 11 from the implementation plan, the backup-divergence design,
  Task 11 brief, SDD ledger, current lease/coordinator/sync/server/setup
  interfaces, and repository operations/documentation rules.
- Inspected local historical commit `55116d6` from PR #71 for tests and intent.
  Ported bounded behaviour and recreated tests; no commit was cherry-picked.
- Excluded PR #71's unrelated tab-order change.

## TDD RED

Command:

`node --test ui/lib/workspaceSync.test.mjs ui/server.test.mjs ui/setup.test.mjs`

Observed expected feature-missing failure:

- `SyntaxError: ... workspaceSync.mjs does not provide an export named
  'analyseBackupDivergence'`.
- Existing server assertions passed. Its already-documented Windows temporary
  directory after-hook intermittently reported `EPERM` after the substantive
  assertions.

The RED tests cover:

- disjoint additions and modifications;
- overlapping paths and ancestor/descendant path handling;
- rename, deletion, dirty tracked and unsafe untracked refusal;
- branch/tip-bound confirmation and stale token refusal;
- fetch/revalidation before mutation;
- two recovery refs before a normal `--no-ff` merge;
- merge failure, push-pending state and forbidden reset/rebase/force actions;
- public affected-area sanitisation; and
- exclusion against a tracker/report mutation holding the shared coordinator.

## Implementation decisions

- Public analysis returns only classification, ahead/behind counts, a SHA-256
  confirmation token, sanitised affected areas and a bounded reason. Raw paths,
  branch names and commit tips never enter the public object.
- The token hashes the current branch plus both analysed tips. Resolution
  fetches, re-analyses and checks the token, creates `local` and `github`
  recovery refs, then re-analyses immediately before the merge.
- Resolution requires its own fenced lease. The server keeps an independent
  lease heartbeat active for the whole operation and refuses acquisition while
  a scan owns the fence.
- The shared mutation coordinator now safely retains its OS-level guard until
  a callback's returned promise settles. Existing synchronous tracker/report
  mutation semantics are unchanged.
- Every mutating Git command checks the current fence immediately before and
  after its bounded asynchronous process.
- Merge failure preserves both recovery refs and aborts a real in-progress
  merge when the current fence still authorises cleanup. Push failure preserves
  the local merge/checkpoint and reports `offline`/pending.
- Setup shows only sanitised areas and requires an explicit browser
  confirmation before sending the analysis token.
- Operations and troubleshooting documentation now describe the bounded safe
  path and the manual-review cases.

## GREEN evidence

- `node --test ui/lib/mutationCoordinator.test.mjs`
  - PASS: 17/17.
- `node --test --test-name-pattern="disjoint additions and modifications" ui/lib/workspaceSync.test.mjs`
  - PASS: 1/1 after strengthening the fixture to use real modifications on
    both sides.
- `node --test --test-name-pattern="backup divergence resolution cannot overlap" ui/lib/workspaceSync.test.mjs`
  - PASS: 1/1.
- `npx.cmd playwright test tests/browser/settings.spec.mjs --project=chromium`
  - PASS: 20/20.
- `node --check ui/lib/workspaceSync.mjs`
  - PASS.
- `node --check ui/lib/mutationCoordinator.mjs`
  - PASS.
- `node --check ui/server.mjs`
  - PASS.
- `node --check ui/setup.js`
  - PASS.
- `git diff --check`
  - PASS; Git printed only repository line-ending conversion notices.

The exact three-file Node suite completed all 86 substantive assertions green;
the process exit remained non-zero only because the unchanged Windows
`ui/server.test.mjs` after-hook could not immediately remove its temporary
directory (`EPERM`).

Final exact rerun immediately before commit:

- `node --test ui/lib/workspaceSync.test.mjs ui/server.test.mjs ui/setup.test.mjs`
  - 87 tests, 86 passed, 1 failed.
  - The sole failure was the unchanged `ui/server.test.mjs` after-hook
    `fs.rmSync(testWorkspace)` Windows `EPERM`, after every substantive
    workspace-sync, server and setup assertion passed.
  - Duration: 149.1 seconds.

## Concerns

- No product correctness concern is currently open.
- The unchanged Windows server-test temporary-directory cleanup race remains a
  test-infrastructure concern. It occurs after all server assertions complete
  and is already documented in the SDD ledger.
