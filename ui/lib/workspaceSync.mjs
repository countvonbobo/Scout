import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { atomicWriteFile } from './atomicWrite.mjs';
import {
  initializeRecoveryBackup, loadRecoveryHeader, RECOVERY_DIR, restoreRecoveryBackup, restoreRecoveryBackupWithKey,
  restoreRecoveryBackupWithKeyAsync, rotateRecoveryPassphrase, writeRecoveryBackup, writeRecoveryBackupAsync,
} from './recoveryBackup.mjs';
import { withMutationCoordinator } from './mutationCoordinator.mjs';
import { assertCurrentFence, synchronousFenceCallback } from './scanLease.mjs';

const SETTINGS = '.scout/sync.json';
const STATUS = new Map();
const GITHUB_ED25519_HOST = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const PROCESS_TREE_KILL_GRACE_MS = 100;
const RUNTIME_FENCE_FAILURE = Symbol('runtime-fence-failure');
const MARKER_FILTER = 'scout-marker';
const MARKER_FILTER_PATHS = Object.freeze([
  'data/opportunities.json',
  'data/search-lanes.json',
  'data/scan-runs.jsonl',
  'reports/*.md',
]);
const MARKER_CLEANER = fileURLToPath(new URL('../../tools/scout-marker-clean.mjs', import.meta.url))
  .replaceAll('\\', '/');
const PUBLIC_SYNC_ERRORS = new Set([
  'Private backup command timed out',
  'Recovery key cache is missing',
  'The safe merge did not complete; both recovery references were preserved',
  'The Scout host and GitHub both contain new changes',
  'The Scout host and GitHub both contain new changes that can be safely preserved',
  'This backup divergence needs manual review',
  'This device has unsynced work and GitHub contains newer changes',
]);

class RuntimeCommandTimeoutError extends Error {}

function runGit(cwd, args, options = {}) {
  const result = (options.spawn || spawnSync)('git', args, {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...(options.env || {}), GIT_TERMINAL_PROMPT: options.allowPrompt ? '1' : '0' },
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: String(result.stderr || result.stdout || `git ${args[0]} failed`).trim(),
  };
}

function boundedOutput(value) {
  return String(value || '').slice(-COMMAND_OUTPUT_LIMIT);
}

function isChildProcess(value) {
  return value && typeof value.once === 'function' && typeof value.kill === 'function';
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForAuxiliaryProcess(child) {
  return new Promise((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (status) => resolve(status));
  });
}

async function terminateProcessTree(child) {
  if (!child?.pid) {
    try { child?.kill('SIGKILL'); } catch {}
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const status = await waitForAuxiliaryProcess(killer);
    if (status !== 0 && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    return;
  }

  let signalledGroup = false;
  try {
    process.kill(-child.pid, 'SIGTERM');
    signalledGroup = true;
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
  await delay(PROCESS_TREE_KILL_GRACE_MS);
  try {
    process.kill(-child.pid, 'SIGKILL');
    signalledGroup = true;
  } catch {
    if (!signalledGroup) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

function collectChildProcess(child, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let closed = false;
    let closeStatus = null;
    let spawnError = null;
    let timedOut = false;
    let terminationComplete = true;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const finishAfterClose = () => {
      if (!closed || (timedOut && !terminationComplete)) return;
      finish({
        status: closeStatus,
        stdout,
        stderr: timedOut ? 'command timed out' : boundedOutput(spawnError?.message || stderr),
        ...(timedOut ? { timedOut: true } : {}),
      });
    };
    child.stdout?.on('data', (chunk) => { stdout = boundedOutput(stdout + chunk.toString('utf8')); });
    child.stderr?.on('data', (chunk) => { stderr = boundedOutput(stderr + chunk.toString('utf8')); });
    child.once('error', (error) => {
      spawnError = error;
      if (!child.pid) {
        closed = true;
        finishAfterClose();
      }
    });
    child.once('close', (status) => {
      closed = true;
      closeStatus = status;
      finishAfterClose();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminationComplete = false;
      Promise.resolve()
        .then(() => terminateProcessTree(child))
        .finally(() => {
          terminationComplete = true;
          finishAfterClose();
        });
    }, timeoutMs);
    timer.unref?.();
  });
}

function defaultSpawnAsync(command, args, spawnOptions, timeoutMs) {
  const child = spawn(command, args, {
    ...spawnOptions,
    detached: process.platform !== 'win32',
    encoding: undefined,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return collectChildProcess(child, timeoutMs);
}

async function adapterSpawnAsync(spawnAdapter, command, args, spawnOptions, timeoutMs) {
  const startedAt = Date.now();
  let timer;
  let value;
  try {
    const pending = Promise.resolve().then(() => spawnAdapter(command, args, {
      ...spawnOptions,
      encoding: 'utf8',
    }));
    value = await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({
          status: null,
          stdout: '',
          stderr: 'command timed out',
          timedOut: true,
        }), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    return { status: null, stdout: '', stderr: boundedOutput(error?.message) };
  } finally {
    clearTimeout(timer);
  }
  if (!isChildProcess(value)) return value;
  return collectChildProcess(value, Math.max(1, timeoutMs - (Date.now() - startedAt)));
}

async function runGitAsync(cwd, args, options = {}) {
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('workspace sync command timeout must be positive');
  }
  const spawnOptions = {
    cwd,
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}), GIT_TERMINAL_PROMPT: options.allowPrompt ? '1' : '0' },
  };
  let result;
  if (options.spawnAsync || options.spawn) {
    result = await adapterSpawnAsync(
      options.spawnAsync || options.spawn,
      'git',
      args,
      spawnOptions,
      timeoutMs,
    );
  } else {
    result = await defaultSpawnAsync('git', args, spawnOptions, timeoutMs);
  }
  const stdout = boundedOutput(result?.stdout).trim();
  const stderr = boundedOutput(result?.stderr).trim();
  return {
    ok: result?.status === 0,
    status: result?.status ?? null,
    stdout,
    stderr,
    timedOut: result?.timedOut === true,
    error: String(stderr || stdout || `git ${args[0]} failed`).trim(),
  };
}

function atomicJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function settingsPath(root) { return path.join(root, ...SETTINGS.split('/')); }

export function prepareGithubDeployKey(root, options = {}) {
  const home = options.home || process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error('Scout could not locate the account home directory');
  const sshDir = path.join(home, '.ssh');
  const keyPath = path.join(sshDir, 'scout-workspace-deploy');
  const knownHosts = path.join(sshDir, 'scout-github-known-hosts');
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(keyPath)) {
    const created = (options.spawn || spawnSync)('ssh-keygen', [
      '-t', 'ed25519', '-N', '', '-C', 'scout-workspace-backup', '-f', keyPath,
    ], { encoding: 'utf8', windowsHide: true });
    if (created.status !== 0) throw new Error(String(created.stderr || created.stdout || 'ssh-keygen failed').trim());
  }
  fs.chmodSync(keyPath, 0o600);
  const known = fs.existsSync(knownHosts) ? fs.readFileSync(knownHosts, 'utf8') : '';
  if (!known.split(/\r?\n/).includes(GITHUB_ED25519_HOST)) fs.appendFileSync(knownHosts, `${known && !known.endsWith('\n') ? '\n' : ''}${GITHUB_ED25519_HOST}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(knownHosts, 0o600);
  const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
  const sshCommand = `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="${knownHosts}"`;
  ensureRepo(root, options);
  const configured = runGit(root, ['config', 'core.sshCommand', sshCommand], options);
  if (!configured.ok) throw new Error(configured.error);
  return { ok: true, keyPath, knownHosts, publicKey, sshCommand };
}

export function loadSyncSettings(root) {
  const file = settingsPath(root);
  if (!fs.existsSync(file)) return { version: 1, enabled: false, remoteUrl: null, dataKey: null };
  try { return { version: 1, enabled: false, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch { return { version: 1, enabled: false, remoteUrl: null, dataKey: null }; }
}

export function saveSyncSettings(root, value) {
  atomicJson(settingsPath(root), { version: 1, ...value });
  return value;
}

export function pendingRecoveryKey(root) {
  return loadSyncSettings(root).pendingRecoveryKey || null;
}

export function confirmRecoveryKey(root) {
  const settings = loadSyncSettings(root);
  const hadPendingKey = Boolean(settings.pendingRecoveryKey);
  delete settings.pendingRecoveryKey;
  saveSyncSettings(root, settings);
  return { ok: true, confirmed: hadPendingKey };
}

export function validateGithubUrl(value) {
  const text = String(value || '').trim();
  const ssh = text.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (ssh) return {
    url: `git@github.com:${ssh[1]}/${ssh[2]}.git`,
    owner: ssh[1], repo: ssh[2], transport: 'ssh', identity: `${ssh[1].toLowerCase()}/${ssh[2].toLowerCase()}`,
  };
  let url;
  try { url = new URL(text); } catch { throw new Error('Enter a valid GitHub HTTPS or SSH repository URL'); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use a credential-free https://github.com/owner/repository or git@github.com:owner/repository URL');
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error('Use a credential-free https://github.com/owner/repository or git@github.com:owner/repository URL');
  return {
    url: `https://github.com/${match[1]}/${match[2]}.git`,
    owner: match[1], repo: match[2], transport: 'https', identity: `${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
  };
}

export function detectGit(options = {}) {
  const git = runGit(process.cwd(), ['--version'], options);
  if (!git.ok) return {
    installed: false,
    credentialManager: false,
    error: 'Git could not be detected',
    reasonCode: 'git-unavailable',
  };
  const manager = runGit(process.cwd(), ['credential-manager', '--version'], options);
  return { installed: true, version: git.stdout, credentialManager: manager.ok, credentialManagerVersion: manager.ok ? manager.stdout : null };
}

export async function verifyPrivateGithubRemote(value, options = {}) {
  const parsed = (options.validateUrl || validateGithubUrl)(value);
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (!fetchFn) throw new Error('Scout could not verify that the repository is private');
  let visibility;
  try {
    visibility = await fetchFn(`https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'Scout' },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Scout could not verify that the GitHub repository is private');
  }
  if (visibility.status === 200) throw new Error('This GitHub repository is public. Change it to Private before connecting Scout');
  if (visibility.status !== 404) throw new Error(`GitHub privacy check failed (${visibility.status})`);
  const cwd = options.cwd || process.cwd();
  const configuredSsh = parsed.transport === 'ssh' ? runGit(cwd, ['config', '--get', 'core.sshCommand'], options) : null;
  const access = runGit(cwd, ['ls-remote', '--heads', parsed.url], {
    ...options,
    allowPrompt: parsed.transport === 'https',
    ...(parsed.transport === 'ssh' ? {
      env: {
        ...(options.env || {}),
        GIT_SSH_COMMAND: configuredSsh?.ok
          ? configuredSsh.stdout
          : 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      },
    } : {}),
  });
  if (!access.ok) throw new Error(`GitHub sign-in or repository access failed: ${access.error}`);
  return { ...parsed, empty: !access.stdout, refs: access.stdout };
}

function repoReady(root, options = {}) {
  const result = runGit(root, ['rev-parse', '--show-toplevel'], options);
  if (!result.ok) return false;
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try { return fs.realpathSync.native(resolved); } catch { return resolved; }
  };
  const top = canonical(result.stdout);
  const workspace = canonical(root);
  return process.platform === 'win32'
    ? top.toLowerCase() === workspace.toLowerCase()
    : top === workspace;
}

function sensitiveTrackedPath(value) {
  const file = String(value || '').replaceAll('\\', '/');
  return file === '.env' || file === 'AGENTS.md' || file === 'CLAUDE.md'
    || file.startsWith('.scout/') || file.startsWith('.agents/') || file.startsWith('.claude/') || file.startsWith('logs/')
    || file.startsWith('data/chats/')
    || (/^applications\/.+\.(?:pdf|docx)$/i.test(file));
}

function untrackLegacyChats(root, options = {}) {
  const tracked = runGit(root, ['ls-files', '-z', '--', 'data/chats'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  if (!tracked.stdout.split('\0').filter(Boolean).length) return;
  const removed = runGit(root, ['rm', '--cached', '-r', '--ignore-unmatch', '--', 'data/chats'], options);
  if (!removed.ok) throw new Error(`Private backup could not make chats device-local: ${removed.error}`);
}

function untrackLegacyManagedInstructions(root, options = {}) {
  const tracked = runGit(root, ['ls-files', '-z', '--', 'AGENTS.md', 'CLAUDE.md'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  if (!tracked.stdout.split('\0').filter(Boolean).length) return;
  const removed = runGit(root, ['rm', '--cached', '--ignore-unmatch', '--', 'AGENTS.md', 'CLAUDE.md'], options);
  if (!removed.ok) throw new Error(`Private backup could not make managed instructions device-local: ${removed.error}`);
}

function assertNoTrackedSecrets(root, options = {}) {
  const tracked = runGit(root, ['ls-files', '-z'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  const unsafe = tracked.stdout.split('\0').filter(sensitiveTrackedPath);
  if (unsafe.length) throw new Error(`Private backup cannot continue because sensitive ignored files are already tracked: ${unsafe.slice(0, 5).join(', ')}`);
}

function ensureRepo(root, options = {}) {
  if (!repoReady(root, options)) {
    const enclosing = runGit(root, ['rev-parse', '--show-toplevel'], options);
    if (enclosing.ok) {
      throw new Error('Private backup refuses a workspace nested inside another Git repository');
    }
    const init = runGit(root, ['init'], options);
    if (!init.ok) throw new Error(init.error);
  }
  if (!runGit(root, ['config', '--get', 'user.name'], options).ok) runGit(root, ['config', 'user.name', 'Scout'], options);
  if (!runGit(root, ['config', '--get', 'user.email'], options).ok) runGit(root, ['config', 'user.email', 'scout@local'], options);
}

function remoteUrl(root, options = {}) {
  const result = runGit(root, ['remote', 'get-url', 'origin'], options);
  return result.ok ? result.stdout : null;
}

function setState(root, state, details = {}) {
  const checkedAt = new Date().toISOString();
  const publicDetails = { ...details };
  if (Object.hasOwn(publicDetails, 'error')) {
    const proposed = String(publicDetails.error || '');
    publicDetails.error = PUBLIC_SYNC_ERRORS.has(proposed)
      ? proposed
      : state === 'offline' ? 'GitHub backup is temporarily unavailable' : 'Private backup needs attention';
    publicDetails.reasonCode = state === 'offline' ? 'backup-offline' : 'backup-error';
  }
  const value = { state, checkedAt, ...publicDetails, ...(state === 'synced' ? { lastSuccessfulAt: checkedAt } : {}) };
  if (state === 'synced') {
    const settings = loadSyncSettings(root);
    if (settings.enabled) saveSyncSettings(root, { ...settings, lastSuccessfulAt: checkedAt });
  }
  STATUS.set(path.resolve(root), value);
  return value;
}

function affectedArea(file) {
  const value = String(file || '').replaceAll('\\', '/');
  if (value.startsWith('.scout-backup/')) return 'encrypted recovery data';
  if (value.startsWith('applications/')) return 'applications';
  if (value.startsWith('data/opportunities')) return 'opportunity tracker';
  if (value.startsWith('data/companies')) return 'company history';
  if (value.startsWith('reports/')) return 'reports';
  if (value.startsWith('profile/')) return 'profile and preferences';
  if (value === 'workspace.json' || value.startsWith('config/')) return 'workspace settings';
  return 'workspace files';
}

function divergenceToken(localCommit, remoteCommit, branch) {
  return crypto.createHash('sha256')
    .update(`${branch}\n${localCommit}\n${remoteCommit}`)
    .digest('hex');
}

function changedPaths(root, range, options = {}) {
  const result = runGit(root, ['diff', '--raw', '--no-abbrev', '-z', '--find-renames', range], options);
  if (!result.ok) return { ok: false, paths: [], complex: true };
  if (!result.stdout) return { ok: true, paths: [], complex: false };
  const records = result.stdout.split('\0');
  if (records.at(-1) === '') records.pop();
  const paths = [];
  let complex = false;
  for (let index = 0; index < records.length;) {
    const header = records[index++];
    const match = header.match(
      /^:([0-7]{6}) ([0-7]{6}) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([A-Z])(\d{0,3})$/,
    );
    if (!match) return { ok: false, paths: [], complex: true };
    const [, oldMode, newMode, , , status, score] = match;
    if ((status === 'R' || status === 'C') !== Boolean(score)) {
      return { ok: false, paths: [], complex: true };
    }
    const firstPath = records[index++];
    if (!firstPath) return { ok: false, paths: [], complex: true };
    paths.push(firstPath);
    if (status === 'R' || status === 'C') {
      const secondPath = records[index++];
      if (!secondPath) return { ok: false, paths: [], complex: true };
      paths.push(secondPath);
      complex = true;
      continue;
    }
    const regularModes = new Set(['100644', '100755']);
    const ordinaryAddition = status === 'A'
      && oldMode === '000000'
      && regularModes.has(newMode);
    const ordinaryModification = status === 'M'
      && regularModes.has(oldMode)
      && oldMode === newMode;
    if (!ordinaryAddition && !ordinaryModification) complex = true;
  }
  return { ok: true, paths: [...new Set(paths)], complex };
}

function manualDivergence(reason, details = {}) {
  return {
    classification: 'manual-required',
    canResolve: false,
    reason,
    localAreas: [],
    remoteAreas: [],
    ...details,
  };
}

function pathsOverlap(left, right) {
  const local = String(left).replaceAll('\\', '/').toLowerCase();
  const remote = String(right).replaceAll('\\', '/').toLowerCase();
  return local === remote || local.startsWith(`${remote}/`) || remote.startsWith(`${local}/`);
}

export function analyseBackupDivergence(root, options = {}) {
  if (!repoReady(root, options)) return manualDivergence('backup repository is not ready');
  const branchResult = runGit(root, ['branch', '--show-current'], options);
  if (!branchResult.ok || !branchResult.stdout) {
    return manualDivergence('backup branch is unavailable');
  }
  const branch = branchResult.stdout;
  const upstream = `refs/remotes/origin/${branch}`;
  if (!runGit(root, ['show-ref', '--verify', '--quiet', upstream], options).ok) {
    return manualDivergence('GitHub branch has not been fetched');
  }
  const counts = runGit(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`], options);
  if (!counts.ok) return manualDivergence('backup history could not be compared');
  const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
  if (!(ahead > 0 && behind > 0)) return null;

  const local = runGit(root, ['rev-parse', 'HEAD'], options);
  const remote = runGit(root, ['rev-parse', upstream], options);
  const base = runGit(root, ['merge-base', 'HEAD', upstream], options);
  if (!local.ok || !remote.ok || !base.ok) {
    return manualDivergence('backup branch tips could not be verified', { ahead, behind });
  }
  const common = {
    ahead,
    behind,
    analysisToken: divergenceToken(local.stdout, remote.stdout, branch),
  };
  const tracked = runGit(root, ['status', '--porcelain', '--untracked-files=no'], options);
  if (!tracked.ok || tracked.stdout) {
    return manualDivergence('tracked workspace files have uncommitted changes', common);
  }
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], options);
  if (!untracked.ok) {
    return manualDivergence('untracked workspace files could not be checked', common);
  }
  const unsafeUntracked = untracked.stdout.split('\0').filter(Boolean)
    .filter((file) => !sensitiveTrackedPath(file));
  if (unsafeUntracked.length) {
    return manualDivergence('untracked workspace files need review', common);
  }

  const localChanges = changedPaths(root, `${base.stdout}..HEAD`, options);
  const remoteChanges = changedPaths(root, `${base.stdout}..${upstream}`, options);
  if (!localChanges.ok || !remoteChanges.ok) {
    return manualDivergence('changed workspace areas could not be compared', common);
  }
  const details = {
    ...common,
    localAreas: [...new Set(localChanges.paths.map(affectedArea))].sort(),
    remoteAreas: [...new Set(remoteChanges.paths.map(affectedArea))].sort(),
  };
  if (localChanges.complex || remoteChanges.complex) {
    return manualDivergence('renamed, deleted, or non-standard changes need review', details);
  }
  if (localChanges.paths.some((localPath) => (
    remoteChanges.paths.some((remotePath) => pathsOverlap(localPath, remotePath))
  ))) {
    return {
      classification: 'overlapping',
      canResolve: false,
      reason: 'the Scout host and GitHub changed at least one of the same files',
      ...details,
    };
  }
  return {
    classification: 'disjoint-safe',
    canResolve: true,
    reason: 'the Scout host and GitHub changed separate files',
    ...details,
  };
}

export function syncStatus(root, options = {}) {
  const settings = loadSyncSettings(root);
  const git = detectGit(options);
  if (!settings.enabled) return { state: git.installed ? 'disabled' : 'setup-required', enabled: false, git, remoteUrl: remoteUrl(root, options) };
  const current = {
    state: 'pending',
    enabled: true,
    git,
    remoteUrl: settings.remoteUrl,
    lastSuccessfulAt: settings.lastSuccessfulAt || null,
    ...(STATUS.get(path.resolve(root)) || {}),
  };
  if (current.state === 'pending' || current.state === 'needs-attention') {
    const resolution = analyseBackupDivergence(root, options);
    if (resolution) {
      return {
        ...current,
        state: 'needs-attention',
        pending: true,
        conflict: true,
        ahead: resolution.ahead,
        behind: resolution.behind,
        error: resolution.classification === 'disjoint-safe'
          ? 'The Scout host and GitHub both contain new changes that can be safely preserved'
          : 'The Scout host and GitHub both contain new changes',
        resolution,
      };
    }
  }
  return current;
}

function sameGithubRepository(left, right) {
  try { return validateGithubUrl(left).identity === validateGithubUrl(right).identity; }
  catch { return left === right; }
}

function markerFilterAttributes(root) {
  const file = path.join(root, '.git', 'info', 'attributes');
  const managed = [
    '# scout marker clean filter begin',
    'data/opportunities.json filter=scout-marker',
    'data/search-lanes.json filter=scout-marker',
    'data/scan-runs.jsonl filter=scout-marker',
    'reports/*.md filter=scout-marker',
    '# scout marker clean filter end',
  ].join('\n');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const withoutManaged = current.replace(
    /(?:^|\n)# scout marker clean filter begin[\s\S]*?# scout marker clean filter end\n?/g,
    '\n',
  ).trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, `${withoutManaged ? `${withoutManaged}\n` : ''}${managed}\n`, { mode: 0o600 });
}

function markerFilterTrackedPaths(root, options) {
  const tracked = runGit(root, ['ls-files', '--', ...MARKER_FILTER_PATHS], options);
  if (!tracked.ok) throw new Error(tracked.error);
  return tracked.stdout.split(/\r?\n/).filter(Boolean);
}

function ensureMarkerCleanFilter(root, options = {}) {
  markerFilterAttributes(root);
  const command = `node "${MARKER_CLEANER}" %f`;
  for (const [key, value] of [
    [`filter.${MARKER_FILTER}.clean`, command],
    [`filter.${MARKER_FILTER}.required`, 'true'],
  ]) {
    const configured = runGit(root, ['config', key, value], options);
    if (!configured.ok) throw new Error(configured.error);
  }
  const paths = markerFilterTrackedPaths(root, options);
  if (!paths.length) return;
  for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) {
    const cleared = runGit(root, ['update-index', flag, '--', ...paths], options);
    if (!cleared.ok) throw new Error(cleared.error);
  }
}

function commitAll(root, message, options = {}) {
  untrackLegacyChats(root, options);
  untrackLegacyManagedInstructions(root, options);
  assertNoTrackedSecrets(root, options);
  ensureMarkerCleanFilter(root, options);
  const update = runGit(root, ['add', '-u'], options);
  if (!update.ok) throw new Error(update.error);
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], options);
  if (!untracked.ok) throw new Error(untracked.error);
  const files = untracked.stdout.split('\0').filter(Boolean).filter((file) => !sensitiveTrackedPath(file));
  for (let index = 0; index < files.length; index += 100) {
    const add = runGit(root, ['add', '--', ...files.slice(index, index + 100)], options);
    if (!add.ok) throw new Error(add.error);
  }
  const commit = runGit(root, ['commit', '-m', message], options);
  if (!commit.ok && !/nothing to commit|nothing added|no changes added/i.test(commit.error)) {
    throw new Error(commit.error);
  }
}

function assertRuntimeFence(options) {
  if (typeof options.assertFence !== 'function') return;
  try {
    options.assertFence();
  } catch (error) {
    Object.defineProperty(error, RUNTIME_FENCE_FAILURE, { value: true });
    throw error;
  }
}

async function runtimeGit(root, args, options, { mutation = false } = {}) {
  if (mutation) assertRuntimeFence(options);
  const result = await runGitAsync(root, args, options);
  if (mutation) assertRuntimeFence(options);
  if (result.timedOut) throw new RuntimeCommandTimeoutError(`git ${args[0]} timed out`);
  return result;
}

async function repoReadyAsync(root, options) {
  const result = await runtimeGit(root, ['rev-parse', '--show-toplevel'], options);
  if (!result.ok) return false;
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try { return fs.realpathSync.native(resolved); } catch { return resolved; }
  };
  const top = canonical(result.stdout);
  const workspace = canonical(root);
  return process.platform === 'win32'
    ? top.toLowerCase() === workspace.toLowerCase()
    : top === workspace;
}

async function ensureRepoAsync(root, options) {
  if (!await repoReadyAsync(root, options)) {
    const enclosing = await runtimeGit(root, ['rev-parse', '--show-toplevel'], options);
    if (enclosing.ok) {
      throw new Error('Private backup refuses a workspace nested inside another Git repository');
    }
    const init = await runtimeGit(root, ['init'], options, { mutation: true });
    if (!init.ok) throw new Error(init.error);
  }
  const name = await runtimeGit(root, ['config', '--get', 'user.name'], options);
  if (!name.ok) {
    const configured = await runtimeGit(root, ['config', 'user.name', 'Scout'], options, { mutation: true });
    if (!configured.ok) throw new Error(configured.error);
  }
  const email = await runtimeGit(root, ['config', '--get', 'user.email'], options);
  if (!email.ok) {
    const configured = await runtimeGit(root, ['config', 'user.email', 'scout@local'], options, { mutation: true });
    if (!configured.ok) throw new Error(configured.error);
  }
}

async function untrackLegacyChatsAsync(root, options) {
  const tracked = await runtimeGit(root, ['ls-files', '-z', '--', 'data/chats'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  if (!tracked.stdout.split('\0').filter(Boolean).length) return;
  const removed = await runtimeGit(
    root,
    ['rm', '--cached', '-r', '--ignore-unmatch', '--', 'data/chats'],
    options,
    { mutation: true },
  );
  if (!removed.ok) throw new Error(`Private backup could not make chats device-local: ${removed.error}`);
}

async function untrackLegacyManagedInstructionsAsync(root, options) {
  const tracked = await runtimeGit(root, ['ls-files', '-z', '--', 'AGENTS.md', 'CLAUDE.md'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  if (!tracked.stdout.split('\0').filter(Boolean).length) return;
  const removed = await runtimeGit(
    root,
    ['rm', '--cached', '--ignore-unmatch', '--', 'AGENTS.md', 'CLAUDE.md'],
    options,
    { mutation: true },
  );
  if (!removed.ok) throw new Error(`Private backup could not make managed instructions device-local: ${removed.error}`);
}

async function assertNoTrackedSecretsAsync(root, options) {
  const tracked = await runtimeGit(root, ['ls-files', '-z'], options);
  if (!tracked.ok) throw new Error(tracked.error);
  const unsafe = tracked.stdout.split('\0').filter(sensitiveTrackedPath);
  if (unsafe.length) {
    throw new Error(
      `Private backup cannot continue because sensitive ignored files are already tracked: ${unsafe.slice(0, 5).join(', ')}`,
    );
  }
}

async function ensureMarkerCleanFilterAsync(root, options) {
  assertRuntimeFence(options);
  markerFilterAttributes(root);
  assertRuntimeFence(options);
  const command = `node "${MARKER_CLEANER}" %f`;
  for (const [key, value] of [
    [`filter.${MARKER_FILTER}.clean`, command],
    [`filter.${MARKER_FILTER}.required`, 'true'],
  ]) {
    const configured = await runtimeGit(root, ['config', key, value], options, { mutation: true });
    if (!configured.ok) throw new Error(configured.error);
  }
  const tracked = await runtimeGit(root, ['ls-files', '--', ...MARKER_FILTER_PATHS], options);
  if (!tracked.ok) throw new Error(tracked.error);
  const paths = tracked.stdout.split(/\r?\n/).filter(Boolean);
  if (!paths.length) return;
  for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) {
    const cleared = await runtimeGit(
      root,
      ['update-index', flag, '--', ...paths],
      options,
      { mutation: true },
    );
    if (!cleared.ok) throw new Error(cleared.error);
  }
}

async function commitAllAsync(root, message, options) {
  await untrackLegacyChatsAsync(root, options);
  await untrackLegacyManagedInstructionsAsync(root, options);
  await assertNoTrackedSecretsAsync(root, options);
  await ensureMarkerCleanFilterAsync(root, options);
  const update = await runtimeGit(root, ['add', '-u'], options, { mutation: true });
  if (!update.ok) throw new Error(update.error);
  const untracked = await runtimeGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], options);
  if (!untracked.ok) throw new Error(untracked.error);
  const files = untracked.stdout.split('\0').filter(Boolean).filter((file) => !sensitiveTrackedPath(file));
  for (let index = 0; index < files.length; index += 100) {
    const add = await runtimeGit(
      root,
      ['add', '--', ...files.slice(index, index + 100)],
      options,
      { mutation: true },
    );
    if (!add.ok) throw new Error(add.error);
  }
  const commit = await runtimeGit(root, ['commit', '-m', message], options, { mutation: true });
  if (!commit.ok && !/nothing to commit|nothing added|no changes added/i.test(commit.error)) {
    throw new Error(commit.error);
  }
}

async function worktreeDirtyAsync(root, options) {
  const status = await runtimeGit(root, ['status', '--porcelain', '--untracked-files=normal'], options);
  if (!status.ok) throw new Error(status.error);
  return Boolean(status.stdout);
}

async function checkpointLocallyAsync(root, settings, options, reason) {
  if (settings.enabled) {
    const key = Buffer.from(String(settings.dataKey || ''), 'base64url');
    if (key.length !== 32) throw new Error('Recovery key cache is missing');
    const header = loadRecoveryHeader(root);
    assertRuntimeFence(options);
    await writeRecoveryBackupAsync(root, key, header, {
      devicePreferences: deviceBackupPreferences(options.deviceSettings),
      assertFence: () => assertRuntimeFence(options),
    });
    assertRuntimeFence(options);
  }
  await commitAllAsync(root, `scout: ${reason}`, options);
}

function deviceBackupPreferences(settings) {
  if (settings === undefined) return undefined;
  return settings ? {
    startWithWindows: Boolean(settings.startWithWindows),
    completedSections: settings.completedSections || {},
  } : null;
}

function worktreeDirty(root, options = {}) {
  const status = runGit(root, ['status', '--porcelain', '--untracked-files=normal'], options);
  if (!status.ok) throw new Error(status.error);
  return Boolean(status.stdout);
}

function checkpointLocally(root, settings, options, reason) {
  if (settings.enabled) {
    const key = Buffer.from(String(settings.dataKey || ''), 'base64url');
    if (key.length !== 32) throw new Error('Recovery key cache is missing');
    const header = loadRecoveryHeader(root);
    writeRecoveryBackup(root, key, header, { devicePreferences: deviceBackupPreferences(options.deviceSettings) });
  }
  commitAll(root, `scout: ${reason}`, options);
}

export async function runWorkspaceSync(root, reason = 'workspace update', options = {}) {
  try {
    const settings = loadSyncSettings(root);
    if (!await repoReadyAsync(root, options)) return setState(root, 'disabled', { enabled: false });
    await ensureRepoAsync(root, options);
    await ensureMarkerCleanFilterAsync(root, options);
    await untrackLegacyChatsAsync(root, options);
    await untrackLegacyManagedInstructionsAsync(root, options);
    await assertNoTrackedSecretsAsync(root, options);
    if (!settings.enabled) {
      await commitAllAsync(root, `scout: ${reason}`, options);
      return setState(root, 'disabled', { enabled: false, committed: true });
    }
    const key = Buffer.from(String(settings.dataKey || ''), 'base64url');
    if (key.length !== 32) {
      return setState(root, 'needs-attention', {
        enabled: true,
        error: 'Recovery key cache is missing',
      });
    }

    setState(root, 'syncing', { enabled: true });
    const fetch = await runtimeGit(root, ['fetch', 'origin'], options, { mutation: true });
    if (!fetch.ok) {
      await checkpointLocallyAsync(root, settings, options, reason);
      return setState(root, 'offline', {
        enabled: true,
        pending: true,
        error: fetch.error,
      });
    }
    const branchResult = await runtimeGit(root, ['branch', '--show-current'], options);
    const branch = branchResult.stdout || 'master';
    const upstream = `refs/remotes/origin/${branch}`;
    const upstreamExists = await runtimeGit(
      root,
      ['show-ref', '--verify', '--quiet', upstream],
      options,
    );
    if (!upstreamExists.ok) {
      await checkpointLocallyAsync(root, settings, options, reason);
      const pushInitial = await runtimeGit(
        root,
        ['push', '-u', 'origin', 'HEAD'],
        { ...options, allowPrompt: true },
        { mutation: true },
      );
      if (pushInitial.ok) {
        assertRuntimeFence(options);
        const synced = setState(root, 'synced', { enabled: true, pending: false });
        assertRuntimeFence(options);
        return synced;
      }
      return setState(root, 'offline', {
        enabled: true,
        pending: true,
        error: pushInitial.error,
      });
    }
    const counts = await runtimeGit(
      root,
      ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
      options,
    );
    if (!counts.ok) {
      return setState(root, 'needs-attention', { enabled: true, error: counts.error });
    }
    const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
    if (ahead > 0 && behind > 0) {
      await checkpointLocallyAsync(root, settings, options, reason);
      const resolution = analyseBackupDivergence(root, options);
      return setState(root, 'needs-attention', {
        enabled: true,
        pending: true,
        conflict: true,
        ahead: resolution?.ahead ?? ahead,
        behind: resolution?.behind ?? behind,
        error: resolution?.classification === 'disjoint-safe'
          ? 'The Scout host and GitHub both contain new changes that can be safely preserved'
          : 'The Scout host and GitHub both contain new changes',
        ...(resolution ? { resolution } : {}),
      });
    }
    if (behind > 0) {
      if (await worktreeDirtyAsync(root, options)) {
        await checkpointLocallyAsync(root, settings, options, reason);
        const resolution = analyseBackupDivergence(root, options);
        return setState(root, 'needs-attention', {
          enabled: true,
          pending: true,
          conflict: true,
          ahead: resolution?.ahead ?? Math.max(1, ahead),
          behind: resolution?.behind ?? behind,
          error: resolution?.classification === 'disjoint-safe'
            ? 'The Scout host and GitHub both contain new changes that can be safely preserved'
            : 'This device has unsynced work and GitHub contains newer changes',
          ...(resolution ? { resolution } : {}),
        });
      }
      const ff = await runtimeGit(
        root,
        ['merge', '--ff-only', upstream],
        options,
        { mutation: true },
      );
      if (!ff.ok) {
        return setState(root, 'needs-attention', {
          enabled: true,
          conflict: true,
          error: ff.error,
        });
      }
      try {
        assertRuntimeFence(options);
        await restoreRecoveryBackupWithKeyAsync(root, root, key, null, {
          assertFence: () => assertRuntimeFence(options),
        });
        assertRuntimeFence(options);
      } catch (error) {
        if (error?.[RUNTIME_FENCE_FAILURE]) throw error;
        return setState(root, 'needs-attention', {
          enabled: true,
          error: `Remote recovery data could not be applied: ${error.message}`,
        });
      }
    }
    await checkpointLocallyAsync(root, settings, options, reason);
    const after = await runtimeGit(
      root,
      ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
      options,
    );
    if (!after.ok) {
      return setState(root, 'needs-attention', { enabled: true, error: after.error });
    }
    const [aheadAfter] = after.stdout.split(/\s+/).map(Number);
    if (aheadAfter > 0) {
      const push = await runtimeGit(
        root,
        ['push', 'origin', 'HEAD'],
        { ...options, allowPrompt: true },
        { mutation: true },
      );
      if (!push.ok) {
        return setState(root, 'offline', {
          enabled: true,
          pending: true,
          error: push.error,
        });
      }
    }
    assertRuntimeFence(options);
    const synced = setState(root, 'synced', {
      enabled: true,
      pending: false,
      pulled: behind > 0,
      ...(behind > 0 ? { pulledAt: new Date().toISOString() } : {}),
    });
    assertRuntimeFence(options);
    return synced;
  } catch (error) {
    if (error?.[RUNTIME_FENCE_FAILURE]) throw error;
    if (error instanceof RuntimeCommandTimeoutError) {
      return setState(root, 'needs-attention', {
        enabled: loadSyncSettings(root).enabled,
        pending: true,
        error: 'Private backup command timed out',
      });
    }
    throw error;
  }
}

const QUEUES = new Map();
export function queueWorkspaceSync(root, reason, options = {}) {
  const key = path.resolve(root);
  const previous = QUEUES.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => runWorkspaceSync(root, reason, options));
  const tracked = next.finally(() => { if (QUEUES.get(key) === tracked) QUEUES.delete(key); });
  QUEUES.set(key, tracked);
  return next;
}

function fencedSyncOptions(lease, options) {
  return {
    ...options,
    assertFence: () => assertCurrentFence(
      lease,
      synchronousFenceCallback(() => true),
    ),
  };
}

export async function resolveBackupDivergence(root, analysisToken, lease, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(String(analysisToken || ''))) {
    throw new Error('Backup history changed; review the refreshed diagnosis before fixing it');
  }
  const settings = loadSyncSettings(root);
  if (!settings.enabled) throw new Error('Private backup is not enabled');
  const fenced = fencedSyncOptions(lease, options);

  return withMutationCoordinator(root, lease, async () => {
    const fetch = await runtimeGit(root, ['fetch', 'origin'], fenced, { mutation: true });
    if (!fetch.ok) {
      return setState(root, 'offline', { enabled: true, pending: true, error: fetch.error });
    }
    let resolution = analyseBackupDivergence(root, fenced);
    if (!resolution) return { ...syncStatus(root, fenced), alreadyResolved: true };
    if (resolution.classification !== 'disjoint-safe' || !resolution.canResolve) {
      return setState(root, 'needs-attention', {
        enabled: true,
        pending: true,
        conflict: true,
        ahead: resolution.ahead,
        behind: resolution.behind,
        error: 'This backup divergence needs manual review',
        resolution,
      });
    }
    if (analysisToken !== resolution.analysisToken) {
      throw new Error('Backup history changed; review the refreshed diagnosis before fixing it');
    }

    const branchResult = await runtimeGit(root, ['branch', '--show-current'], fenced);
    const localResult = await runtimeGit(root, ['rev-parse', 'HEAD'], fenced);
    const remoteResult = branchResult.ok && branchResult.stdout
      ? await runtimeGit(root, ['rev-parse', `refs/remotes/origin/${branchResult.stdout}`], fenced)
      : { ok: false };
    if (!branchResult.ok || !branchResult.stdout || !localResult.ok || !remoteResult.ok
      || divergenceToken(localResult.stdout, remoteResult.stdout, branchResult.stdout) !== analysisToken) {
      throw new Error('Backup history changed; review the refreshed diagnosis before fixing it');
    }

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
    const refRoot = `refs/scout-recovery/${stamp}-${analysisToken.slice(0, 12)}`;
    const localSaved = await runtimeGit(
      root,
      ['update-ref', `${refRoot}/local`, localResult.stdout],
      fenced,
      { mutation: true },
    );
    const remoteSaved = await runtimeGit(
      root,
      ['update-ref', `${refRoot}/github`, remoteResult.stdout],
      fenced,
      { mutation: true },
    );
    if (!localSaved.ok || !remoteSaved.ok) {
      throw new Error('Scout could not create backup recovery references');
    }

    resolution = analyseBackupDivergence(root, fenced);
    if (!resolution || resolution.analysisToken !== analysisToken
      || resolution.classification !== 'disjoint-safe' || !resolution.canResolve) {
      throw new Error('Backup history changed; review the refreshed diagnosis before fixing it');
    }
    const merge = await runtimeGit(
      root,
      ['merge', '--no-ff', '--no-edit', remoteResult.stdout],
      fenced,
      { mutation: true },
    );
    if (!merge.ok) {
      const mergeHead = await runtimeGit(root, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], fenced);
      if (mergeHead.ok) {
        await runtimeGit(root, ['merge', '--abort'], fenced, { mutation: true });
      }
      return setState(root, 'needs-attention', {
        enabled: true,
        pending: true,
        conflict: true,
        error: 'The safe merge did not complete; both recovery references were preserved',
        resolution,
      });
    }

    const status = await runWorkspaceSync(root, 'resolve backup divergence', fenced);
    return {
      ...status,
      resolved: status.state === 'synced',
      recoveryRefsCreated: true,
    };
  });
}

export function queueWorkspaceResolution(root, analysisToken, lease, options = {}) {
  const key = path.resolve(root);
  const previous = QUEUES.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(
    () => resolveBackupDivergence(root, analysisToken, lease, options),
  );
  const tracked = next.finally(() => { if (QUEUES.get(key) === tracked) QUEUES.delete(key); });
  QUEUES.set(key, tracked);
  return next;
}

export async function connectWorkspaceSync(root, { remoteUrl: value, passphrase }, options = {}) {
  const git = detectGit(options);
  if (!git.installed) throw new Error('Install Git before setting up private backup');
  const verified = options.verifyRemote
    ? await options.verifyRemote(value)
    : await verifyPrivateGithubRemote(value, { ...options, cwd: root });
  const transport = verified.transport || (() => { try { return validateGithubUrl(value).transport; } catch { return 'https'; } })();
  if (transport === 'https' && !git.credentialManager) throw new Error('Install Git Credential Manager before setting up an HTTPS private backup');
  ensureRepo(root, options);
  untrackLegacyChats(root, options);
  untrackLegacyManagedInstructions(root, options);
  assertNoTrackedSecrets(root, options);
  const current = remoteUrl(root, options);
  if (current && !sameGithubRepository(current, verified.url)) throw new Error('This workspace is already connected to a different origin');
  if (!verified.empty && !current) throw new Error('This repository is not empty. Use Restore existing workspace instead');
  if (!current) {
    const add = runGit(root, ['remote', 'add', 'origin', verified.url], options);
    if (!add.ok) throw new Error(add.error);
  } else if (current !== verified.url) {
    const update = runGit(root, ['remote', 'set-url', 'origin', verified.url], options);
    if (!update.ok) throw new Error(update.error);
  }
  const created = initializeRecoveryBackup(root, passphrase, { devicePreferences: deviceBackupPreferences(options.deviceSettings) });
  saveSyncSettings(root, {
    enabled: true, remoteUrl: verified.url, dataKey: created.dataKey.toString('base64url'),
    pendingRecoveryKey: created.recoveryKey,
  });
  let status;
  try {
    status = await runWorkspaceSync(root, 'enable private backup', options);
  } catch (error) {
    status = setState(root, 'needs-attention', { enabled: true, pending: true, error: error.message });
  }
  return { status, recoveryKey: created.recoveryKey, remoteUrl: verified.url };
}

export function disableWorkspaceSync(root) {
  const settings = loadSyncSettings(root);
  saveSyncSettings(root, { ...settings, enabled: false });
  return setState(root, 'disabled', { enabled: false, remoteUrl: settings.remoteUrl });
}

function emptyDirectory(dir) {
  if (!fs.existsSync(dir)) return true;
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error('Restore target must not be a symbolic link');
  return stat.isDirectory() && fs.readdirSync(dir).length === 0;
}

function assertNoSymlinks(root, current = root) {
  for (const name of fs.readdirSync(current)) {
    if (current === root && name === '.git') continue;
    const child = path.join(current, name);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error('The repository contains a symbolic link and cannot be restored safely');
    if (stat.isDirectory()) assertNoSymlinks(root, child);
  }
}

export async function restoreWorkspaceFromGithub({ remoteUrl: value, targetRoot, secret }, options = {}) {
  if (!emptyDirectory(targetRoot)) throw new Error('Restore requires an empty workspace folder');
  const targetExisted = fs.existsSync(targetRoot);
  const git = detectGit(options);
  if (!git.installed) throw new Error('Install Git before restoring Scout');
  const verified = options.verifyRemote
    ? await options.verifyRemote(value)
    : await verifyPrivateGithubRemote(value, options);
  const transport = verified.transport || (() => { try { return validateGithubUrl(value).transport; } catch { return 'https'; } })();
  if (transport === 'https' && !git.credentialManager) throw new Error('Install Git Credential Manager before restoring an HTTPS backup');
  if (verified.empty) throw new Error('The repository is empty; there is no Scout workspace to restore');
  const parent = path.dirname(path.resolve(targetRoot));
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, `.scout-restore-${crypto.randomUUID()}`);
  let activated = false;
  try {
    const clone = runGit(parent, ['clone', verified.url, temp], { ...options, allowPrompt: true });
    if (!clone.ok) throw new Error(`Restore clone failed: ${clone.error}`);
    assertNoSymlinks(temp);
    for (const relative of ['workspace.json', 'data/opportunities.json']) {
      if (!fs.existsSync(path.join(temp, ...relative.split('/')))) throw new Error('The repository is not a Scout workspace');
    }
    const restored = restoreRecoveryBackup(temp, temp, secret);
    if (options.prepareWorkspace) await options.prepareWorkspace(temp);
    if (options.validateWorkspace) {
      const validation = await options.validateWorkspace(temp);
      if (!validation?.ok) throw new Error('The restored workspace did not pass Scout doctor');
    }
    const settings = { enabled: true, remoteUrl: verified.url, dataKey: restored.dataKey.toString('base64url') };
    saveSyncSettings(temp, settings);
    if (fs.existsSync(targetRoot)) fs.rmdirSync(targetRoot);
    fs.renameSync(temp, targetRoot);
    activated = true;
    let validation = null;
    if (options.validateWorkspace) {
      validation = await options.validateWorkspace(targetRoot);
      if (!validation?.ok) throw new Error('The restored workspace failed validation after activation; Scout rolled it back');
    }
    setState(targetRoot, 'synced', { enabled: true, pending: false });
    return {
      ok: true, workspaceRoot: path.resolve(targetRoot), devicePreferences: restored.devicePreferences,
      files: restored.files, validation,
    };
  } catch (error) {
    if (activated && fs.existsSync(targetRoot)) fs.rmSync(targetRoot, { recursive: true, force: true });
    if (activated && targetExisted && !fs.existsSync(targetRoot)) fs.mkdirSync(targetRoot, { recursive: true });
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function rotateWorkspaceRecoveryPassphrase(root, passphrase, options = {}) {
  const settings = loadSyncSettings(root);
  if (!settings.enabled) throw new Error('Encrypted private backup is not enabled');
  const dataKey = Buffer.from(String(settings.dataKey || ''), 'base64url');
  if (dataKey.length !== 32) throw new Error('Recovery key cache is missing');
  rotateRecoveryPassphrase(root, dataKey, passphrase);
  const status = await runWorkspaceSync(root, 'rotate recovery passphrase', options);
  return { ok: status.state === 'synced', status };
}

export async function adoptExistingWorkspaceFromGithub({
  remoteUrl: value, targetRoot, passphrase, confirmation,
}, options = {}) {
  if (confirmation !== 'replace-with-existing-private-workspace') {
    throw new Error('Explicit private-workspace replacement confirmation is required');
  }
  const target = path.resolve(targetRoot);
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory()) {
    throw new Error('The current Scout workspace must be a real directory');
  }
  for (const relative of ['workspace.json', 'data/opportunities.json']) {
    if (!fs.existsSync(path.join(target, ...relative.split('/')))) throw new Error('The current Scout workspace is not initialised');
  }
  const prepared = prepareGithubDeployKey(target, options);
  const verified = options.verifyRemote
    ? await options.verifyRemote(value)
    : await verifyPrivateGithubRemote(value, { ...options, cwd: target });
  if (verified.empty) throw new Error('The private repository is empty; there is no existing workspace to adopt');
  if ((verified.transport || validateGithubUrl(value).transport) !== 'ssh') {
    throw new Error('Unattended VPS workspace adoption requires a repository-scoped SSH deploy key');
  }

  const parent = path.dirname(target);
  const temporary = path.join(parent, `.scout-adopt-${crypto.randomUUID()}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = `${target}.before-adopt-${stamp}`;
  let originalMoved = false;
  try {
    const clone = runGit(parent, ['clone', verified.url, temporary], {
      ...options, env: { ...(options.env || {}), GIT_SSH_COMMAND: prepared.sshCommand },
    });
    if (!clone.ok) throw new Error(`Private workspace clone failed: ${clone.error}`);
    assertNoSymlinks(temporary);
    for (const relative of ['workspace.json', 'data/opportunities.json']) {
      if (!fs.existsSync(path.join(temporary, ...relative.split('/')))) throw new Error('The private repository is not a Scout workspace');
    }
    const configured = runGit(temporary, ['config', 'core.sshCommand', prepared.sshCommand], options);
    if (!configured.ok) throw new Error(configured.error);
    untrackLegacyChats(temporary, options);
    untrackLegacyManagedInstructions(temporary, options);
    assertNoTrackedSecrets(temporary, options);
    const hasRecoveryBackup = fs.existsSync(path.join(temporary, ...RECOVERY_DIR.split('/'), 'header.json'));
    const recovery = hasRecoveryBackup
      ? restoreRecoveryBackup(temporary, temporary, passphrase)
      : initializeRecoveryBackup(temporary, passphrase, { devicePreferences: deviceBackupPreferences(options.deviceSettings) });
    if (options.prepareWorkspace) await options.prepareWorkspace(temporary);
    if (options.validateWorkspace) {
      const validation = await options.validateWorkspace(temporary);
      if (!validation?.ok) throw new Error('The private workspace did not pass Scout doctor');
    }
    saveSyncSettings(temporary, {
      enabled: true, remoteUrl: verified.url, dataKey: recovery.dataKey.toString('base64url'),
      ...(recovery.recoveryKey ? { pendingRecoveryKey: recovery.recoveryKey } : {}),
    });
    const status = await runWorkspaceSync(temporary, 'adopt existing private workspace', options);
    if (status.state !== 'synced') throw new Error(`Initial private backup did not complete: ${status.error || status.state}`);

    fs.renameSync(target, backupRoot);
    originalMoved = true;
    fs.renameSync(temporary, target);
    originalMoved = false;
    setState(target, 'synced', { enabled: true, pending: false, lastSuccessfulAt: status.lastSuccessfulAt });
    return {
      ok: true, workspaceRoot: target, backupRoot, recoveryKey: recovery.recoveryKey || null,
      restoredExistingRecovery: hasRecoveryBackup, status: syncStatus(target, options),
    };
  } catch (error) {
    if (originalMoved && !fs.existsSync(target) && fs.existsSync(backupRoot)) fs.renameSync(backupRoot, target);
    throw error;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
