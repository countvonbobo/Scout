import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  adoptExistingWorkspaceFromGithub, analyseBackupDivergence, confirmRecoveryKey, connectWorkspaceSync,
  disableWorkspaceSync, loadSyncSettings, pendingRecoveryKey, queueWorkspaceSync, resolveBackupDivergence,
  restoreWorkspaceFromGithub, runWorkspaceSync, saveSyncSettings, syncStatus, validateGithubUrl,
  verifyPrivateGithubRemote,
} from './workspaceSync.mjs';
import { initializeRecoveryBackup } from './recoveryBackup.mjs';
import { mutateTrackerSnapshot } from './trackerPersistence.mjs';
import { serializeTracker } from './tracker.mjs';
import { withMutationCoordinator } from './mutationCoordinator.mjs';
import {
  acquireScanLease, currentLeaseOwner, releaseScanLease,
} from './scanLease.mjs';

const EXAMPLE_ENV = ['SECRET', 'example'].join('=') + '\n';
const CHANGED_ENV = ['SECRET', 'dummy'].join('=') + '\n';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-sync-'));
  const root = path.join(base, 'device-one');
  const remote = path.join(base, 'remote.git');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"opportunities":[]}\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n.scout/\napplications/**/*.pdf\n');
  fs.writeFileSync(path.join(root, '.env'), EXAMPLE_ENV);
  git(base, 'init', '--bare', remote);
  return { base, root, remote };
}

const fakeCapabilities = (spawn) => ({ spawn });

async function pairedFixture() {
  const f = fixture();
  const spawnAdapter = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn: spawnAdapter });
  const deviceTwo = path.join(f.base, 'device-two');
  await restoreWorkspaceFromGithub({
    remoteUrl: 'https://github.com/example/repo', targetRoot: deviceTwo, secret: connected.recoveryKey,
  }, { verifyRemote: async () => ({ url: f.remote, empty: false }), spawn: spawnAdapter });
  return { ...f, spawn: spawnAdapter, deviceTwo };
}

async function disjointDivergence(pair) {
  fs.writeFileSync(path.join(pair.root, 'data', 'remote-change.json'), '{}\n');
  await runWorkspaceSync(pair.root, 'remote change', { spawn: pair.spawn });
  fs.writeFileSync(path.join(pair.deviceTwo, 'data', 'local-change.json'), '{}\n');
  return runWorkspaceSync(pair.deviceTwo, 'local change', { spawn: pair.spawn });
}

function backupLease(root, runId = 'backup-resolution-test') {
  const lease = acquireScanLease(root, currentLeaseOwner(), {
    kind: 'backup-divergence', runId, phase: 'resolve',
  });
  assert.ok(lease);
  return lease;
}

function commitRawIndexEntry(root, relative, mode, contentOrOid, message) {
  let oid = contentOrOid;
  if (mode !== '160000') {
    const source = path.join(root, '.scout-raw-entry');
    fs.writeFileSync(source, contentOrOid);
    oid = git(root, 'hash-object', '-w', source);
    fs.rmSync(source);
  }
  git(root, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${relative}`);
  git(root, 'commit', '-m', message);
}

function commitLocalSideOfRawDivergence(pair, name) {
  git(pair.deviceTwo, 'config', 'user.name', 'Test');
  git(pair.deviceTwo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(pair.deviceTwo, 'data', `${name}-local.json`), '{}\n');
  git(pair.deviceTwo, 'add', 'data');
  git(pair.deviceTwo, 'commit', '-m', `${name} local change`);
  git(pair.deviceTwo, 'fetch', 'origin');
}

test('GitHub repository URLs reject credentials and non-GitHub remotes', () => {
  assert.equal(validateGithubUrl('https://github.com/example/scout-workspace').url, 'https://github.com/example/scout-workspace.git');
  assert.deepEqual(validateGithubUrl('git@github.com:example/scout-workspace.git'), {
    url: 'git@github.com:example/scout-workspace.git', owner: 'example', repo: 'scout-workspace',
    transport: 'ssh', identity: 'example/scout-workspace',
  });
  assert.throws(() => validateGithubUrl('https://token@github.com/example/repo'), /credential-free/);
  assert.throws(() => validateGithubUrl('https://example.com/example/repo'), /credential-free/);
  assert.throws(() => validateGithubUrl('git@example.com:example/repo'), /GitHub HTTPS or SSH/);
});

test('SSH backup transport does not require Git Credential Manager', async () => {
  const f = fixture();
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'git@github.com:example/scout-workspace.git', passphrase: 'correct horse battery staple',
  }, {
    verifyRemote: async () => ({ url: f.remote, empty: true, transport: 'ssh' }),
    spawn: (command, args, options) => args[0] === 'credential-manager'
      ? { status: 1, stdout: '', stderr: 'not installed' }
      : spawnSync(command, args, options),
  });
  assert.equal(connected.status.state, 'synced');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('privacy verification rejects a repository visible without authentication', async () => {
  await assert.rejects(() => verifyPrivateGithubRemote('https://github.com/example/repo', {
    fetchFn: async () => ({ status: 200 }),
  }), /public/);
});

test('connecting an existing remote is rejected before origin is changed', async () => {
  const f = fixture();
  const spawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  await assert.rejects(() => connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/existing', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: false }), spawn }), /Use Restore existing workspace/);
  assert.equal(git(f.root, 'remote'), '');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('sync refuses sensitive files already tracked by Git', async () => {
  const f = fixture();
  git(f.root, 'init');
  git(f.root, 'config', 'user.name', 'Test');
  git(f.root, 'config', 'user.email', 'test@example.invalid');
  git(f.root, 'add', '-f', '.env');
  git(f.root, 'commit', '-m', 'unsafe fixture');
  await assert.rejects(() => runWorkspaceSync(f.root, 'unsafe sync'), /sensitive ignored files are already tracked: \.env/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('local-only checkpoints never contact a Git remote', async () => {
  const f = fixture();
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push(args);
    return spawnSync(command, args, options);
  };
  git(f.root, 'init');
  const result = await runWorkspaceSync(f.root, 'local only change', { spawn });
  assert.equal(result.state, 'disabled');
  assert.match(git(f.root, 'log', '-1', '--pretty=%s'), /local only change/);
  assert.equal(calls.some((args) => ['fetch', 'push', 'pull', 'ls-remote'].includes(args[0])), false);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('multi-record scan-run backup and fresh clone are marker-free while live recovery state remains', async () => {
  const f = fixture();
  const marker = {
    schemaVersion: 1,
    mutationId: 'mutation-backup-test',
    mutationKey: 'a'.repeat(64),
    runKey: 'b'.repeat(64),
    intendedDigest: 'c'.repeat(64),
    targetKey: 'd'.repeat(64),
  };
  fs.mkdirSync(path.join(f.root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'data', 'opportunities.json'), `${JSON.stringify({
    updated: '2026-07-28',
    opportunities: [{ id: 'kept' }],
    _scoutMutation: marker,
  }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(f.root, 'reports', '2026-07-28.md'),
    `# Scout report\n\n## Headline\n\nSafe summary.\n\n<!-- scout-mutation:${encodeURIComponent(JSON.stringify(marker))} -->\n`,
  );
  fs.writeFileSync(
    path.join(f.root, 'data', 'scan-runs.jsonl'),
    `${JSON.stringify({ schemaVersion: 4, timestamp: '2026-07-28T09:00:00.000Z' })}\n`
      + `${JSON.stringify({ schemaVersion: 4, timestamp: '2026-07-28T10:00:00.000Z', _scoutMutation: marker })}\n`,
  );
  git(f.root, 'init');

  const status = await runWorkspaceSync(f.root, 'marker-free recovery projection');

  assert.equal(status.state, 'disabled');
  for (const relative of [
    'data/opportunities.json',
    'data/scan-runs.jsonl',
    'reports/2026-07-28.md',
  ]) {
    assert.doesNotMatch(git(f.root, 'show', `HEAD:${relative}`), /scout-mutation|_scoutMutation/);
    assert.match(fs.readFileSync(path.join(f.root, ...relative.split('/')), 'utf8'), /scout-mutation|_scoutMutation/);
  }
  const restoredTracker = JSON.parse(git(f.root, 'show', 'HEAD:data/opportunities.json'));
  const committedRuns = git(f.root, 'show', 'HEAD:data/scan-runs.jsonl')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(restoredTracker.opportunities[0].id, 'kept');
  assert.deepEqual(
    committedRuns.map((record) => record.timestamp),
    ['2026-07-28T09:00:00.000Z', '2026-07-28T10:00:00.000Z'],
  );
  assert.equal(committedRuns.some((record) => Object.hasOwn(record, '_scoutMutation')), false);
  const restored = path.join(f.base, 'fresh-clone');
  git(f.base, 'clone', f.root, restored);
  const restoredRuns = fs.readFileSync(path.join(restored, 'data', 'scan-runs.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(restoredRuns.length, 2);
  assert.equal(restoredRuns.some((record) => Object.hasOwn(record, '_scoutMutation')), false);
  const liveRuns = fs.readFileSync(path.join(f.root, 'data', 'scan-runs.jsonl'), 'utf8')
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(Object.hasOwn(liveRuns[0], '_scoutMutation'), false);
  assert.deepEqual(liveRuns[1]._scoutMutation, marker);
  assert.equal(git(f.root, 'status', '--porcelain'), '');

  const liveTracker = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'opportunities.json'), 'utf8'));
  liveTracker.opportunities.push({ id: 'later-semantic-change' });
  fs.writeFileSync(path.join(f.root, 'data', 'opportunities.json'), `${JSON.stringify(liveTracker, null, 2)}\n`);
  await runWorkspaceSync(f.root, 'later marker-bearing semantic change');
  const laterBackup = JSON.parse(git(f.root, 'show', 'HEAD:data/opportunities.json'));
  assert.deepEqual(laterBackup.opportunities.map((item) => item.id), ['kept', 'later-semantic-change']);
  assert.equal(Object.hasOwn(laterBackup, '_scoutMutation'), false);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('marker-free backup survives a real tracker mutation and restores the semantic edit', async () => {
  const f = fixture();
  const marker = {
    schemaVersion: 1,
    mutationId: 'mutation-real-edit',
    mutationKey: '1'.repeat(64),
    runKey: '2'.repeat(64),
    intendedDigest: '3'.repeat(64),
    targetKey: '4'.repeat(64),
  };
  const trackerFile = path.join(f.root, 'data', 'opportunities.json');
  fs.writeFileSync(trackerFile, `${JSON.stringify({
    updated: '2026-07-28',
    opportunities: [{ id: 'before-edit', status: 'new' }],
    _scoutMutation: marker,
  }, null, 2)}\n`);
  git(f.root, 'init');
  await runWorkspaceSync(f.root, 'first marker-free backup');

  mutateTrackerSnapshot(
    trackerFile,
    (tracker) => ({
      ...tracker,
      opportunities: [
        ...tracker.opportunities,
        { id: 'edited-through-real-api', status: 'shortlist' },
      ],
    }),
    serializeTracker,
  );
  await queueWorkspaceSync(f.root, 'real tracker edit backup');

  const committed = git(f.root, 'show', 'HEAD:data/opportunities.json');
  assert.match(committed, /edited-through-real-api/);
  assert.doesNotMatch(committed, /_scoutMutation/);
  const restored = path.join(f.base, 'restored');
  git(f.base, 'clone', f.root, restored);
  const restoredTracker = JSON.parse(fs.readFileSync(path.join(restored, 'data', 'opportunities.json'), 'utf8'));
  assert.deepEqual(
    restoredTracker.opportunities.map((item) => item.id),
    ['before-edit', 'edited-through-real-api'],
  );
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  assert.doesNotMatch(git(f.root, 'ls-files', '-v'), /^[a-z] /m);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('marker projection cleanup leaves no hidden or temporary Git state after commit failure', async () => {
  const f = fixture();
  const marker = {
    schemaVersion: 1,
    mutationId: 'mutation-cleanup',
    mutationKey: '5'.repeat(64),
    runKey: '6'.repeat(64),
    intendedDigest: '7'.repeat(64),
    targetKey: '8'.repeat(64),
  };
  const trackerFile = path.join(f.root, 'data', 'opportunities.json');
  fs.writeFileSync(trackerFile, `${JSON.stringify({
    updated: '2026-07-28',
    opportunities: [{ id: 'before-failure' }],
    _scoutMutation: marker,
  }, null, 2)}\n`);
  git(f.root, 'init');
  await runWorkspaceSync(f.root, 'seed marker-free backup');
  mutateTrackerSnapshot(
    trackerFile,
    (tracker) => ({
      ...tracker,
      opportunities: [...tracker.opportunities, { id: 'visible-after-failure' }],
    }),
    serializeTracker,
  );
  const failingSpawn = (command, args, options) => (
    args[0] === 'commit'
      ? { status: 1, stdout: '', stderr: 'synthetic commit interruption' }
      : spawnSync(command, args, options)
  );

  await assert.rejects(
    runWorkspaceSync(f.root, 'interrupted marker projection', { spawn: failingSpawn }),
    /synthetic commit interruption/,
  );
  assert.doesNotMatch(git(f.root, 'ls-files', '-v'), /^[a-z] /m);
  const scoutState = path.join(f.root, '.scout');
  assert.equal(fs.existsSync(scoutState) && fs.readdirSync(scoutState).some((name) => (
    name.startsWith('backup-projection-') || name.includes('index')
  )), false);
  assert.match(git(f.root, 'status', '--porcelain'), /opportunities\.json/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('runtime sync remains asynchronous while a Git mutation is pending', async () => {
  const f = fixture();
  git(f.root, 'init');
  let commitStarted = false;
  let releaseCommit;
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 5);
  const spawnAsync = async (command, args, options) => {
    if (args[0] === 'commit') {
      commitStarted = true;
      await commitGate;
    }
    return spawnSync(command, args, options);
  };

  const sync = runWorkspaceSync(f.root, 'asynchronous runtime checkpoint', { spawnAsync });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const observed = { commitStarted, timerFired };
  releaseCommit();
  const result = await sync;

  assert.deepEqual(observed, { commitStarted: true, timerFired: true });
  assert.equal(result.state, 'disabled');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('enabled runtime recovery checkpoint yields to an independent heartbeat and fences component mutations', async () => {
  const f = fixture();
  git(f.root, 'init');
  git(f.root, 'config', 'user.name', 'Test');
  git(f.root, 'config', 'user.email', 'test@example.invalid');
  const created = initializeRecoveryBackup(f.root, 'correct horse battery staple');
  saveSyncSettings(f.root, {
    enabled: true,
    remoteUrl: 'https://github.com/example/private-workspace.git',
    dataKey: created.dataKey.toString('base64url'),
  });
  fs.mkdirSync(path.join(f.root, 'applications'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'applications', 'large-cv.pdf'), Buffer.alloc(8 * 1024 * 1024, 0x61));

  let afterFetch = false;
  let heartbeatTicks = 0;
  let heartbeat;
  let ticksBeforeNextGit = null;
  let fenceChecks = 0;
  let checksBeforeNextGit = null;
  const spawnAsync = async (command, args, options) => {
    if (args[0] === 'fetch') {
      afterFetch = true;
      heartbeat = setInterval(() => { heartbeatTicks += 1; }, 1);
      return { status: 1, stdout: '', stderr: 'synthetic offline' };
    }
    if (afterFetch && ticksBeforeNextGit === null) {
      ticksBeforeNextGit = heartbeatTicks;
      checksBeforeNextGit = fenceChecks;
    }
    return spawnSync(command, args, options);
  };

  try {
    const result = await runWorkspaceSync(f.root, 'large fenced checkpoint', {
      spawnAsync,
      assertFence() {
        fenceChecks += 1;
      },
    });

    assert.equal(result.state, 'offline');
    assert.ok(ticksBeforeNextGit > 0, 'the recovery checkpoint must yield before the next Git command');
    assert.ok(checksBeforeNextGit > 4, 'recovery component mutations must be fenced individually');
  } finally {
    clearInterval(heartbeat);
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('runtime sync command timeout returns bounded needs-attention state', async () => {
  const f = fixture();
  git(f.root, 'init');
  const spawnAsync = async (command, args, options) => {
    if (args[0] === 'commit') return new Promise(() => {});
    return spawnSync(command, args, options);
  };

  const result = await runWorkspaceSync(f.root, 'timed runtime checkpoint', {
    commandTimeoutMs: 20,
    spawnAsync,
  });

  assert.equal(result.state, 'needs-attention');
  assert.equal(result.pending, true);
  assert.doesNotMatch(JSON.stringify(result), /workspace\.json|opportunities\.json/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

function terminateTestProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

test('runtime command timeout terminates the process tree and awaits parent close', async () => {
  const f = fixture();
  const sentinel = path.join(f.base, 'surviving-grandchild.txt');
  git(f.root, 'init');
  let commandProcess;
  let commandClosed = false;
  const grandchildScript = [
    "const fs = require('node:fs');",
    "const destination = process.argv[1];",
    "setTimeout(() => fs.writeFileSync(destination, 'survived'), 400);",
  ].join(' ');
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}, process.argv[1]], { stdio: 'ignore', windowsHide: true });`,
    'setTimeout(() => process.exit(0), 800);',
  ].join(' ');
  const spawnAsync = async (command, args, options) => {
    if (args[0] !== 'commit') return spawnSync(command, args, options);
    commandProcess = spawn(process.execPath, ['-e', parentScript, sentinel], {
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    commandProcess.once('close', () => { commandClosed = true; });
    return commandProcess;
  };

  try {
    const result = await runWorkspaceSync(f.root, 'timed process-tree checkpoint', {
      commandTimeoutMs: 50,
      spawnAsync,
    });

    assert.equal(result.state, 'needs-attention');
    assert.equal(result.pending, true);
    assert.equal(commandClosed, true, 'sync must await the timed-out parent close event');
    await new Promise((resolve) => setTimeout(resolve, 550));
    assert.equal(fs.existsSync(sentinel), false, 'a timed-out transport grandchild must not outlive sync');
  } finally {
    terminateTestProcessTree(commandProcess);
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('a stale runtime sync fence prevents the first local mutation', async () => {
  const f = fixture();
  git(f.root, 'init');

  await assert.rejects(() => runWorkspaceSync(f.root, 'stale fenced checkpoint', {
    assertFence() {
      throw new Error('synthetic stale sync fence');
    },
  }), /synthetic stale sync fence/);

  assert.equal(git(f.root, 'log', '--all', '--oneline'), '');
  assert.match(git(f.root, 'status', '--porcelain'), /workspace\.json/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('a workspace nested under another checkout never checkpoints the parent repository', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-parent-repo-'));
  git(parent, 'init');
  const root = path.join(parent, 'private-workspace');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace.json'), '{"schemaVersion":2}\n');
  fs.writeFileSync(path.join(root, 'data', 'opportunities.json'), '{"opportunities":[]}\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.scout/\n');
  const result = await runWorkspaceSync(root, 'nested workspace');
  assert.equal(result.state, 'disabled');
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
  assert.equal(git(parent, 'status', '--porcelain'), '?? private-workspace/');
  fs.rmSync(parent, { recursive: true, force: true });
});

test('workspace upgrade untracks legacy chats without deleting transcripts', async () => {
  const f = fixture();
  fs.appendFileSync(path.join(f.root, '.gitignore'), 'data/chats/\n');
  fs.mkdirSync(path.join(f.root, 'data', 'chats'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'data', 'chats', 'example.json'), '{"messages":[]}\n');
  fs.writeFileSync(path.join(f.root, 'AGENTS.md'), 'Managed instructions\n');
  git(f.root, 'init');
  git(f.root, 'config', 'user.name', 'Test');
  git(f.root, 'config', 'user.email', 'test@example.invalid');
  git(f.root, 'add', 'workspace.json', '.gitignore', 'data/opportunities.json');
  git(f.root, 'add', '-f', 'data/chats/example.json');
  git(f.root, 'add', '-f', 'AGENTS.md');
  git(f.root, 'commit', '-m', 'legacy tracked chat');
  await runWorkspaceSync(f.root, 'make chats device local');
  assert.equal(fs.existsSync(path.join(f.root, 'data', 'chats', 'example.json')), true);
  assert.equal(git(f.root, 'ls-files', 'data/chats'), '');
  assert.equal(fs.existsSync(path.join(f.root, 'AGENTS.md')), true);
  assert.equal(git(f.root, 'ls-files', 'AGENTS.md'), '');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('optional sync commits, pushes, restores ignored state, and can be disabled', async () => {
  const f = fixture();
  const verifyRemote = async () => ({ url: f.remote, empty: true, owner: 'test', repo: 'test' });
  const spawn = (command, args, options) => {
    if (args[0] === '--version') return spawnSync(command, args, options);
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote, ...fakeCapabilities(spawn) });
  assert.equal(connected.status.state, 'synced');
  assert.equal(loadSyncSettings(f.root).enabled, true);
  assert.equal(pendingRecoveryKey(f.root), connected.recoveryKey);
  assert.doesNotMatch(JSON.stringify(syncStatus(f.root, fakeCapabilities(spawn))), new RegExp(connected.recoveryKey));
  assert.deepEqual(confirmRecoveryKey(f.root), { ok: true, confirmed: true });
  assert.equal(pendingRecoveryKey(f.root), null);
  assert.match(git(f.root, 'log', '-1', '--pretty=%s'), /enable private backup/);

  fs.writeFileSync(path.join(f.root, 'data', 'chats.json'), '{"message":"hello"}\n');
  await queueWorkspaceSync(f.root, 'save chat', fakeCapabilities(spawn));
  assert.equal(syncStatus(f.root, fakeCapabilities(spawn)).state, 'synced');

  const target = path.join(f.base, 'device-two');
  const restored = await restoreWorkspaceFromGithub({
    remoteUrl: 'https://github.com/example/repo', targetRoot: target, secret: connected.recoveryKey,
  }, { verifyRemote: async () => ({ url: f.remote, empty: false }), ...fakeCapabilities(spawn) });
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), EXAMPLE_ENV);
  assert.match(fs.readFileSync(path.join(target, 'data', 'chats.json'), 'utf8'), /hello/);
  assert.equal(loadSyncSettings(target).enabled, true);
  assert.equal(disableWorkspaceSync(target).state, 'disabled');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('two devices fast-forward safely and divergence never resets, rebases, or force-pushes', async () => {
  const f = fixture();
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push(args);
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn });
  const deviceTwo = path.join(f.base, 'device-two');
  await restoreWorkspaceFromGithub({
    remoteUrl: 'https://github.com/example/repo', targetRoot: deviceTwo, secret: connected.recoveryKey,
  }, { verifyRemote: async () => ({ url: f.remote, empty: false }), spawn });

  fs.writeFileSync(path.join(f.root, 'data', 'from-one.json'), '{}\n');
  fs.writeFileSync(path.join(f.root, '.env'), CHANGED_ENV);
  assert.equal((await runWorkspaceSync(f.root, 'device one change', { spawn })).state, 'synced');
  const pulled = await runWorkspaceSync(deviceTwo, 'check remote', {
    spawn,
    deviceSettings: { startWithWindows: false, completedSections: { 'windows-startup': 1 } },
  });
  assert.equal(pulled.state, 'synced');
  assert.equal(pulled.pulled, true);
  assert.equal(fs.existsSync(path.join(deviceTwo, 'data', 'from-one.json')), true);
  assert.equal(fs.readFileSync(path.join(deviceTwo, '.env'), 'utf8'), CHANGED_ENV);

  const refreshedOne = await runWorkspaceSync(f.root, 'refresh device one', { spawn });
  assert.equal(refreshedOne.state, 'synced');
  assert.equal(refreshedOne.pulled, true);
  fs.writeFileSync(path.join(f.root, 'data', 'remote-change.json'), '{}\n');
  await runWorkspaceSync(f.root, 'remote change', { spawn });
  fs.writeFileSync(path.join(deviceTwo, 'data', 'local-change.json'), '{}\n');
  const diverged = await runWorkspaceSync(deviceTwo, 'local change', { spawn });
  assert.equal(diverged.state, 'needs-attention');
  assert.equal(diverged.conflict, true);
  assert.equal(fs.existsSync(path.join(deviceTwo, 'data', 'local-change.json')), true);
  assert.equal(fs.existsSync(path.join(deviceTwo, 'data', 'remote-change.json')), false);
  assert.equal(calls.some((args) => args.includes('rebase') || args.includes('reset') || args.some((arg) => /^--force/.test(arg))), false);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('disjoint additions and modifications produce a tip-bound sanitised confirmation', async () => {
  const f = await pairedFixture();
  try {
    fs.mkdirSync(path.join(f.root, 'profile'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'profile', 'context.md'), 'baseline profile\n');
    await runWorkspaceSync(f.root, 'shared profile baseline', { spawn: f.spawn });
    await runWorkspaceSync(f.deviceTwo, 'receive profile baseline', { spawn: f.spawn });

    fs.writeFileSync(path.join(f.root, 'profile', 'context.md'), 'remote profile modification\n');
    await runWorkspaceSync(f.root, 'remote profile change', { spawn: f.spawn });
    fs.writeFileSync(
      path.join(f.deviceTwo, 'data', 'opportunities.json'),
      '{"opportunities":[],"localModification":true}\n',
    );
    const diverged = await runWorkspaceSync(f.deviceTwo, 'local tracker modification', { spawn: f.spawn });

    assert.equal(diverged.resolution.classification, 'disjoint-safe');
    assert.equal(diverged.resolution.canResolve, true);
    assert.deepEqual(diverged.resolution.localAreas, ['opportunity tracker']);
    assert.deepEqual(diverged.resolution.remoteAreas, ['profile and preferences']);
    assert.match(diverged.resolution.analysisToken, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      Object.keys(diverged.resolution).sort(),
      ['ahead', 'analysisToken', 'behind', 'canResolve', 'classification', 'localAreas', 'reason', 'remoteAreas'].sort(),
    );
    assert.doesNotMatch(JSON.stringify(diverged.resolution), /context\.md|opportunities\.json|refs\//i);
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('overlap, rename, deletion, dirty tracked and unsafe untracked state fail closed', async () => {
  const overlap = await pairedFixture();
  try {
    fs.writeFileSync(path.join(overlap.root, 'workspace.json'), '{"schemaVersion":1,"from":"remote"}\n');
    await runWorkspaceSync(overlap.root, 'remote overlap', { spawn: overlap.spawn });
    fs.writeFileSync(path.join(overlap.deviceTwo, 'workspace.json'), '{"schemaVersion":1,"from":"local"}\n');
    await runWorkspaceSync(overlap.deviceTwo, 'local overlap', { spawn: overlap.spawn });
    const analysis = analyseBackupDivergence(overlap.deviceTwo, { spawn: overlap.spawn });
    assert.equal(analysis.classification, 'overlapping');
    assert.equal(analysis.canResolve, false);
    assert.deepEqual(analysis.localAreas, ['workspace settings']);
    assert.deepEqual(analysis.remoteAreas, ['workspace settings']);
    assert.doesNotMatch(JSON.stringify(analysis), /workspace\.json/);
  } finally {
    fs.rmSync(overlap.base, { recursive: true, force: true });
  }

  for (const change of ['rename', 'delete']) {
    const f = await pairedFixture();
    try {
      fs.writeFileSync(path.join(f.root, 'data', 'remote-change.json'), '{}\n');
      await runWorkspaceSync(f.root, 'remote change', { spawn: f.spawn });
      if (change === 'rename') {
        fs.renameSync(path.join(f.deviceTwo, 'workspace.json'), path.join(f.deviceTwo, 'workspace-renamed.json'));
      } else {
        fs.rmSync(path.join(f.deviceTwo, 'workspace.json'));
      }
      await runWorkspaceSync(f.deviceTwo, `local ${change}`, { spawn: f.spawn });
      const analysis = analyseBackupDivergence(f.deviceTwo, { spawn: f.spawn });
      assert.equal(analysis.classification, 'manual-required');
      assert.match(analysis.reason, /renamed, deleted|non-standard/i);
    } finally {
      fs.rmSync(f.base, { recursive: true, force: true });
    }
  }

  const dirty = await pairedFixture();
  try {
    await disjointDivergence(dirty);
    fs.appendFileSync(path.join(dirty.deviceTwo, 'workspace.json'), ' ');
    assert.match(analyseBackupDivergence(dirty.deviceTwo, { spawn: dirty.spawn }).reason, /uncommitted/);
    git(dirty.deviceTwo, 'restore', 'workspace.json');
    fs.writeFileSync(path.join(dirty.deviceTwo, 'review-me.txt'), 'untracked\n');
    assert.match(analyseBackupDivergence(dirty.deviceTwo, { spawn: dirty.spawn }).reason, /untracked/);
  } finally {
    fs.rmSync(dirty.base, { recursive: true, force: true });
  }
});

test('resolution refetches, rejects stale tips and creates both recovery refs before a no-ff merge', async () => {
  const f = await pairedFixture();
  const calls = [];
  const spawnAdapter = (command, args, options) => {
    calls.push([...args]);
    return f.spawn(command, args, options);
  };
  let lease;
  try {
    const diverged = await disjointDivergence(f);
    lease = backupLease(f.deviceTwo);
    await assert.rejects(
      resolveBackupDivergence(f.deviceTwo, '0'.repeat(64), lease, { spawn: spawnAdapter }),
      /history changed/i,
    );
    assert.equal(git(f.deviceTwo, 'for-each-ref', '--format=%(refname)', 'refs/scout-recovery'), '');

    const resolved = await resolveBackupDivergence(
      f.deviceTwo,
      diverged.resolution.analysisToken,
      lease,
      { spawn: spawnAdapter },
    );
    assert.equal(resolved.state, 'synced');
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.recoveryRefsCreated, true);
    assert.equal(fs.existsSync(path.join(f.deviceTwo, 'data', 'local-change.json')), true);
    assert.equal(fs.existsSync(path.join(f.deviceTwo, 'data', 'remote-change.json')), true);
    assert.equal(git(f.deviceTwo, 'rev-list', '--left-right', '--count', 'HEAD...@{u}'), '0\t0');
    assert.equal(
      git(f.deviceTwo, 'for-each-ref', '--format=%(refname)', 'refs/scout-recovery').split('\n').length,
      2,
    );
    assert.equal(calls.some((args) => args[0] === 'fetch'), true);
    assert.equal(calls.some((args) => args[0] === 'merge' && args.includes('--no-ff')), true);
    assert.equal(
      calls.some((args) => args.includes('reset') || args.includes('rebase')
        || args.some((arg) => /^--force/.test(arg))),
      false,
    );
  } finally {
    if (lease) releaseScanLease(lease);
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('resolution merges the exact verified remote object when its tracking ref advances', async () => {
  const f = await pairedFixture();
  let lease;
  try {
    const divergence = await disjointDivergence(f);
    const verifiedRemote = git(f.deviceTwo, 'rev-parse', '@{u}');
    let advanced = false;
    const racingSpawn = (command, args, options) => {
      if (!advanced && args[0] === 'merge' && args.includes('--no-ff')) {
        advanced = true;
        fs.writeFileSync(path.join(f.root, 'data', 'unconfirmed-remote.json'), '{}\n');
        git(f.root, 'add', 'data/unconfirmed-remote.json');
        git(f.root, 'commit', '-m', 'unconfirmed remote advance');
        git(f.root, 'push', 'origin', 'HEAD');
        git(f.deviceTwo, 'fetch', 'origin');
      }
      return f.spawn(command, args, options);
    };
    lease = backupLease(f.deviceTwo, 'backup-moving-ref-race');
    const result = await resolveBackupDivergence(
      f.deviceTwo,
      divergence.resolution.analysisToken,
      lease,
      { spawn: racingSpawn },
    );

    assert.equal(advanced, true);
    assert.equal(result.state, 'needs-attention');
    assert.equal(result.resolved, false);
    assert.equal(fs.existsSync(path.join(f.deviceTwo, 'data', 'unconfirmed-remote.json')), false);
    const githubRef = git(
      f.deviceTwo,
      'for-each-ref',
      '--format=%(refname)',
      'refs/scout-recovery',
    ).split('\n').find((ref) => ref.endsWith('/github'));
    assert.equal(git(f.deviceTwo, 'rev-parse', githubRef), verifiedRemote);
  } finally {
    if (lease) releaseScanLease(lease);
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('disjoint symlink, gitlink and file-mode transitions require manual review', async () => {
  for (const kind of ['symlink', 'gitlink', 'type-change', 'executable-change']) {
    const f = await pairedFixture();
    try {
      git(f.root, 'config', 'user.name', 'Test');
      git(f.root, 'config', 'user.email', 'test@example.invalid');
      if (kind === 'type-change' || kind === 'executable-change') {
        fs.mkdirSync(path.join(f.root, 'profile'), { recursive: true });
        fs.writeFileSync(path.join(f.root, 'profile', `${kind}.md`), 'ordinary file\n');
        git(f.root, 'add', `profile/${kind}.md`);
        git(f.root, 'commit', '-m', `${kind} baseline`);
        git(f.root, 'push', 'origin', 'HEAD');
        git(f.deviceTwo, 'fetch', 'origin');
        git(f.deviceTwo, 'merge', '--ff-only', '@{u}');
      }

      if (kind === 'symlink') {
        commitRawIndexEntry(
          f.root,
          'profile/disjoint-link',
          '120000',
          '../workspace.json',
          'add disjoint symlink',
        );
      } else if (kind === 'gitlink') {
        commitRawIndexEntry(
          f.root,
          'applications/disjoint-module',
          '160000',
          git(f.root, 'rev-parse', 'HEAD'),
          'add disjoint gitlink',
        );
      } else if (kind === 'type-change') {
        commitRawIndexEntry(
          f.root,
          'profile/type-change.md',
          '120000',
          '../workspace.json',
          'replace regular file with symlink',
        );
      } else {
        git(f.root, 'update-index', '--chmod=+x', 'profile/executable-change.md');
        git(f.root, 'commit', '-m', 'change regular file mode');
      }
      git(f.root, 'push', 'origin', 'HEAD');
      commitLocalSideOfRawDivergence(f, kind);

      const analysis = analyseBackupDivergence(f.deviceTwo, { spawn: f.spawn });
      assert.equal(analysis.classification, 'manual-required', kind);
      assert.equal(analysis.canResolve, false, kind);
      assert.match(analysis.reason, /mode|non-standard|file type/i, kind);
      assert.doesNotMatch(JSON.stringify(analysis), /disjoint-link|disjoint-module|type-change\.md/i);
    } finally {
      fs.rmSync(f.base, { recursive: true, force: true });
    }
  }
});

test('malformed or unmerged raw diff metadata fails closed', async () => {
  const f = await pairedFixture();
  try {
    await disjointDivergence(f);
    const malformed = analyseBackupDivergence(f.deviceTwo, {
      spawn: (command, args, options) => (
        args[0] === 'diff' && args.includes('--raw')
          ? { status: 0, stdout: ':malformed\0data/example.json\0', stderr: '' }
          : f.spawn(command, args, options)
      ),
    });
    assert.equal(malformed.classification, 'manual-required');
    assert.match(malformed.reason, /could not be compared/i);

    const unmergedHeader = `:100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} U`;
    const unmerged = analyseBackupDivergence(f.deviceTwo, {
      spawn: (command, args, options) => (
        args[0] === 'diff' && args.includes('--raw')
          ? { status: 0, stdout: `${unmergedHeader}\0data/conflict.json\0`, stderr: '' }
          : f.spawn(command, args, options)
      ),
    });
    assert.equal(unmerged.classification, 'manual-required');
    assert.match(unmerged.reason, /non-standard/i);
    assert.doesNotMatch(JSON.stringify(unmerged), /conflict\.json/i);

    for (const length of [40, 64, 41, 63]) {
      const objectId = 'a'.repeat(length);
      const zeroId = '0'.repeat(length);
      const header = `:000000 100644 ${zeroId} ${objectId} A`;
      const analysis = analyseBackupDivergence(f.deviceTwo, {
        spawn: (command, args, options) => (
          args[0] === 'diff' && args.includes('--raw')
            ? { status: 0, stdout: `${header}\0data/object-id.json\0`, stderr: '' }
            : f.spawn(command, args, options)
        ),
      });
      if (length === 40 || length === 64) {
        assert.equal(analysis.classification, 'overlapping', `valid ${length}-digit object ID`);
      } else {
        assert.equal(analysis.classification, 'manual-required', `invalid ${length}-digit object ID`);
        assert.match(analysis.reason, /could not be compared/i);
      }
      assert.doesNotMatch(JSON.stringify(analysis), /object-id\.json/i);
    }
  } finally {
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('merge failure keeps both tips and refs while push failure keeps a pending local merge', async () => {
  const mergeFailure = await pairedFixture();
  let lease;
  try {
    const divergence = await disjointDivergence(mergeFailure);
    const localBefore = git(mergeFailure.deviceTwo, 'rev-parse', 'HEAD');
    const remoteBefore = git(mergeFailure.deviceTwo, 'rev-parse', '@{u}');
    lease = backupLease(mergeFailure.deviceTwo, 'backup-merge-failure');
    const result = await resolveBackupDivergence(
      mergeFailure.deviceTwo,
      divergence.resolution.analysisToken,
      lease,
      {
        spawn: (command, args, options) => (
          args[0] === 'merge' && args.includes('--no-ff')
            ? { status: 1, stdout: '', stderr: 'synthetic merge failure' }
            : mergeFailure.spawn(command, args, options)
        ),
      },
    );
    assert.equal(result.state, 'needs-attention');
    assert.equal(git(mergeFailure.deviceTwo, 'rev-parse', 'HEAD'), localBefore);
    assert.equal(git(mergeFailure.deviceTwo, 'rev-parse', '@{u}'), remoteBefore);
    assert.equal(
      git(mergeFailure.deviceTwo, 'for-each-ref', '--format=%(refname)', 'refs/scout-recovery').split('\n').length,
      2,
    );
  } finally {
    if (lease) releaseScanLease(lease);
    fs.rmSync(mergeFailure.base, { recursive: true, force: true });
  }

  const pushFailure = await pairedFixture();
  lease = null;
  try {
    const divergence = await disjointDivergence(pushFailure);
    lease = backupLease(pushFailure.deviceTwo, 'backup-push-failure');
    const result = await resolveBackupDivergence(
      pushFailure.deviceTwo,
      divergence.resolution.analysisToken,
      lease,
      {
        spawn: (command, args, options) => (
          args[0] === 'push'
            ? { status: 1, stdout: '', stderr: 'synthetic offline push' }
            : pushFailure.spawn(command, args, options)
        ),
      },
    );
    assert.equal(result.state, 'offline');
    assert.equal(result.pending, true);
    assert.equal(fs.existsSync(path.join(pushFailure.deviceTwo, 'data', 'local-change.json')), true);
    assert.equal(fs.existsSync(path.join(pushFailure.deviceTwo, 'data', 'remote-change.json')), true);
    assert.equal(Number(git(pushFailure.deviceTwo, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').split('\t')[0]) > 0, true);
  } finally {
    if (lease) releaseScanLease(lease);
    fs.rmSync(pushFailure.base, { recursive: true, force: true });
  }
});

test('backup divergence resolution cannot overlap a tracker or report mutation', async () => {
  const f = await pairedFixture();
  let lease;
  try {
    const divergence = await disjointDivergence(f);
    lease = backupLease(f.deviceTwo, 'backup-coordinator-race');
    await withMutationCoordinator(f.deviceTwo, lease, async () => {
      await assert.rejects(
        resolveBackupDivergence(f.deviceTwo, divergence.resolution.analysisToken, lease, { spawn: f.spawn }),
        /another workspace mutation is in progress/i,
      );
    });
  } finally {
    if (lease) releaseScanLease(lease);
    fs.rmSync(f.base, { recursive: true, force: true });
  }
});

test('offline sync keeps a local commit pending', async () => {
  const f = fixture();
  const realSpawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn: realSpawn });
  fs.writeFileSync(path.join(f.root, 'data', 'offline.json'), '{}\n');
  const offlineSpawn = (command, args, options) => args[0] === 'fetch'
    ? { status: 1, stdout: '', stderr: 'synthetic offline' }
    : realSpawn(command, args, options);
  const result = await runWorkspaceSync(f.root, 'offline change', { spawn: offlineSpawn });
  assert.equal(result.state, 'offline');
  assert.equal(result.pending, true);
  assert.equal(result.reasonCode, 'backup-offline');
  assert.equal(result.error, 'GitHub backup is temporarily unavailable');
  assert.doesNotMatch(JSON.stringify(result), /synthetic offline|github\.com\/example|Users|home\//i);
  assert.match(git(f.root, 'log', '-1', '--pretty=%s'), /offline change/);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('backup setup still returns the recovery key when the first checkpoint needs attention', async () => {
  const f = fixture();
  const spawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    if (args[0] === 'commit') return { status: 1, stdout: '', stderr: 'synthetic commit failure' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn });
  assert.match(connected.recoveryKey, /^SCOUT-1-/);
  assert.equal(connected.status.state, 'needs-attention');
  assert.equal(connected.status.pending, true);
  assert.match(connected.status.error, /synthetic commit failure/);
  assert.equal(loadSyncSettings(f.root).enabled, true);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('restore validation fails before installing the target workspace', async () => {
  const f = fixture();
  const spawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn });
  const target = path.join(f.base, 'rejected-device');
  await assert.rejects(() => restoreWorkspaceFromGithub({
    remoteUrl: 'https://github.com/example/repo', targetRoot: target, secret: connected.recoveryKey,
  }, {
    verifyRemote: async () => ({ url: f.remote, empty: false }), spawn,
    validateWorkspace: () => ({ ok: false }),
  }), /did not pass Scout doctor/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readdirSync(f.base).some((name) => name.startsWith('.scout-restore-')), false);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('restore rolls back an empty target when validation fails after activation', async () => {
  const f = fixture();
  const spawn = (command, args, options) => {
    if (args[0] === 'credential-manager') return { status: 0, stdout: 'test-gcm', stderr: '' };
    return spawnSync(command, args, options);
  };
  const connected = await connectWorkspaceSync(f.root, {
    remoteUrl: 'https://github.com/example/repo', passphrase: 'correct horse battery staple',
  }, { verifyRemote: async () => ({ url: f.remote, empty: true }), spawn });
  const target = path.join(f.base, 'post-activation-rejected');
  fs.mkdirSync(target);
  let validations = 0;
  await assert.rejects(() => restoreWorkspaceFromGithub({
    remoteUrl: 'https://github.com/example/repo', targetRoot: target, secret: connected.recoveryKey,
  }, {
    verifyRemote: async () => ({ url: f.remote, empty: false }), spawn,
    validateWorkspace: () => ({ ok: ++validations === 1 }),
  }), /failed validation after activation; Scout rolled it back/);
  assert.equal(validations, 2);
  assert.equal(fs.existsSync(target), true);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(fs.readdirSync(f.base).some((name) => name.startsWith('.scout-restore-')), false);
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('legacy private workspace adoption keeps a rollback copy and enables encrypted sync', async () => {
  const f = fixture();
  const source = path.join(f.base, 'legacy-source');
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.mkdirSync(path.join(source, 'applications', 'legacy-role'), { recursive: true });
  fs.writeFileSync(path.join(source, 'workspace.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(source, 'data', 'opportunities.json'), '{"opportunities":[]}\n');
  fs.writeFileSync(path.join(source, 'applications', 'legacy-role', 'cv.typ'), 'Legacy CV\n');
  fs.writeFileSync(path.join(source, '.gitignore'), '.env\n.scout/\napplications/**/*.pdf\ndata/chats/\n');
  git(source, 'init');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'legacy private workspace');
  git(source, 'remote', 'add', 'origin', f.remote);
  git(source, 'push', '-u', 'origin', 'HEAD');

  const home = path.join(f.base, 'home');
  fs.mkdirSync(home);
  const adopted = await adoptExistingWorkspaceFromGithub({
    remoteUrl: 'git@github.com:example/scout-workspace.git', targetRoot: f.root,
    passphrase: 'correct horse battery staple', confirmation: 'replace-with-existing-private-workspace',
  }, {
    home,
    verifyRemote: async () => ({ url: f.remote, empty: false, transport: 'ssh' }),
    validateWorkspace: () => ({ ok: true }),
  });
  assert.equal(adopted.ok, true);
  assert.equal(fs.readFileSync(path.join(f.root, 'applications', 'legacy-role', 'cv.typ'), 'utf8').trim(), 'Legacy CV');
  assert.equal(fs.existsSync(path.join(adopted.backupRoot, 'workspace.json')), true);
  assert.equal(loadSyncSettings(f.root).enabled, true);
  assert.match(pendingRecoveryKey(f.root), /^SCOUT-1-/);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('private workspace adoption unlocks existing recovery data and restores ignored chats', async () => {
  const f = fixture();
  const source = path.join(f.base, 'encrypted-source');
  fs.mkdirSync(path.join(source, 'data', 'chats'), { recursive: true });
  fs.mkdirSync(path.join(source, 'applications', 'existing-role'), { recursive: true });
  fs.writeFileSync(path.join(source, 'workspace.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(source, 'data', 'opportunities.json'), '{"opportunities":[]}\n');
  fs.writeFileSync(path.join(source, 'data', 'chats', 'private.json'), '{"messages":[]}\n');
  fs.writeFileSync(path.join(source, 'applications', 'existing-role', 'cv.typ'), 'Existing CV\n');
  fs.writeFileSync(path.join(source, '.gitignore'), '.env\n.scout/\napplications/**/*.pdf\ndata/chats/\n');
  git(source, 'init');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  initializeRecoveryBackup(source, 'correct horse battery staple');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'encrypted private workspace');
  git(source, 'remote', 'add', 'origin', f.remote);
  git(source, 'push', '-u', 'origin', 'HEAD');

  const home = path.join(f.base, 'home');
  fs.mkdirSync(home);
  const adopted = await adoptExistingWorkspaceFromGithub({
    remoteUrl: 'git@github.com:example/scout-workspace.git', targetRoot: f.root,
    passphrase: 'correct horse battery staple', confirmation: 'replace-with-existing-private-workspace',
  }, {
    home,
    verifyRemote: async () => ({ url: f.remote, empty: false, transport: 'ssh' }),
    validateWorkspace: () => ({ ok: true }),
  });
  assert.equal(adopted.restoredExistingRecovery, true);
  assert.equal(adopted.recoveryKey, null);
  assert.equal(pendingRecoveryKey(f.root), null);
  const restoredChat = JSON.parse(fs.readFileSync(path.join(f.root, 'data', 'chats', 'private.json'), 'utf8'));
  assert.equal(restoredChat.recovered.providerSessionReset, true);
  assert.match(restoredChat.messages[0].text, /recovered on a new Scout host/);
  assert.equal(git(f.root, 'ls-files', '--', 'data/chats/private.json'), '');
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  fs.rmSync(f.base, { recursive: true, force: true });
});

test('legacy adoption validation failure leaves the original workspace installed', async () => {
  const f = fixture();
  const source = path.join(f.base, 'invalid-source');
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.writeFileSync(path.join(source, 'workspace.json'), '{"schemaVersion":1}\n');
  fs.writeFileSync(path.join(source, 'data', 'opportunities.json'), '{"opportunities":[]}\n');
  git(source, 'init');
  git(source, 'config', 'user.name', 'Test');
  git(source, 'config', 'user.email', 'test@example.invalid');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'invalid private workspace');
  git(source, 'remote', 'add', 'origin', f.remote);
  git(source, 'push', '-u', 'origin', 'HEAD');
  const home = path.join(f.base, 'home');
  fs.mkdirSync(home);
  await assert.rejects(() => adoptExistingWorkspaceFromGithub({
    remoteUrl: 'git@github.com:example/scout-workspace.git', targetRoot: f.root,
    passphrase: 'correct horse battery staple', confirmation: 'replace-with-existing-private-workspace',
  }, {
    home,
    verifyRemote: async () => ({ url: f.remote, empty: false, transport: 'ssh' }),
    validateWorkspace: () => ({ ok: false }),
  }), /did not pass Scout doctor/);
  assert.equal(fs.existsSync(path.join(f.root, 'workspace.json')), true);
  assert.equal(fs.readdirSync(f.base).some((name) => name.startsWith('.scout-adopt-')), false);
  fs.rmSync(f.base, { recursive: true, force: true });
});
