import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  adoptExistingWorkspaceFromGithub, confirmRecoveryKey, connectWorkspaceSync, disableWorkspaceSync, loadSyncSettings, pendingRecoveryKey,
  queueWorkspaceSync, restoreWorkspaceFromGithub, runWorkspaceSync, saveSyncSettings, syncStatus, validateGithubUrl,
  verifyPrivateGithubRemote,
} from './workspaceSync.mjs';
import { initializeRecoveryBackup } from './recoveryBackup.mjs';

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
