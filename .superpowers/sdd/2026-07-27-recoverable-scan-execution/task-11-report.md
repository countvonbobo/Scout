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

## Fix round 1

Independent review found two Important gaps:

1. The final merge named the movable remote-tracking ref instead of the exact
   remote object authenticated by the confirmation token.
2. Name/status-only diff parsing treated symlink, gitlink and file-mode changes
   as ordinary safe additions or modifications.

### RED

Command:

`node --test --test-name-pattern="exact verified remote object|disjoint symlink" ui/lib/workspaceSync.test.mjs`

Observed:

- 0/2 passed.
- The moving-ref race advanced the remote-tracking ref after final analysis;
  the current implementation returned `synced` and merged the unconfirmed tip.
- A real Git `120000` symlink addition was classified `disjoint-safe`.

### Fixes

- The resolver still verifies the branch, local tip and remote-tracking tip,
  and creates recovery refs for those exact objects. Its merge command now
  names the verified remote commit OID rather than the movable ref.
- Diff classification now parses `git diff --raw --no-abbrev -z` records.
  It accepts only:
  - additions from mode `000000` to regular-file mode `100644` or `100755`;
  - modifications whose old/new modes are the same regular-file mode.
- Rename/copy records, deletion, type/mode changes, symlink `120000`, gitlink
  `160000`, unmerged status and malformed raw records fail closed.
- Real Git fixtures create symlink and gitlink index entries without requiring
  platform symlink privileges. Additional fixtures cover regular-to-symlink
  and executable-bit transitions.

### GREEN

- `node --test --test-name-pattern="exact verified remote object" ui/lib/workspaceSync.test.mjs`
  - PASS: 1/1.
- `node --test --test-name-pattern="disjoint symlink" ui/lib/workspaceSync.test.mjs`
  - PASS: 1/1, covering four real Git cases.
- `node --test --test-name-pattern="malformed or unmerged" ui/lib/workspaceSync.test.mjs`
  - PASS: 1/1.
- Combined focused regression command:

  `node --test --test-name-pattern="disjoint additions and modifications|overlap, rename, deletion|resolution refetches|exact verified remote object|disjoint symlink|malformed or unmerged|merge failure keeps|backup divergence resolution cannot overlap" ui/lib/workspaceSync.test.mjs`

  - PASS: 8/8 in 123.0 seconds.
- Final parser-hardening rerun:
  `node --test --test-name-pattern="malformed or unmerged" ui/lib/workspaceSync.test.mjs`
  - PASS: 1/1.
- `node --check ui/lib/workspaceSync.mjs`
  - PASS.
- `git diff --check`
  - PASS; only repository line-ending conversion notices were printed.

### Fix-round concerns

- None open.

## Fix round 2

Scoped re-review found that the raw-diff object grammar accepted malformed
lengths from 41 through 63 characters because it used `{40,64}`.

### RED

Command:

`node --test --test-name-pattern="malformed or unmerged" ui/lib/workspaceSync.test.mjs`

Result:

- FAIL: 0/1.
- The otherwise valid 41-digit raw addition was classified `overlapping`
  instead of failing closed, proving that the parser accepted it.

The fixture also explicitly checks valid 40- and 64-digit object IDs and an
invalid 63-digit object ID.

### Fix and GREEN

- Replaced each object-ID range with an exact 40-or-64 lowercase hexadecimal
  alternative.
- `node --test --test-name-pattern="malformed or unmerged" ui/lib/workspaceSync.test.mjs`
  - PASS: 1/1. Valid 40/64 records parse; malformed 41/63 records fail closed.
- `node --test --test-name-pattern="disjoint additions and modifications" ui/lib/workspaceSync.test.mjs`
  - PASS: 1/1, preserving real Git SHA-1 behaviour.
- `node --check ui/lib/workspaceSync.mjs`
  - PASS.
- `git diff --check`
  - PASS; only repository line-ending conversion notices were printed.

### Fix-round concerns

- None open.
