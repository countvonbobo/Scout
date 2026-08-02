import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPST_PROBE_TIMEOUT_MS = 5_000;

function executableName(platform) {
  return platform === 'win32' ? 'typst.exe' : 'typst';
}

export function typstCandidates({
  appRoot = DEFAULT_APP_ROOT,
  env = process.env,
  platform = process.platform,
} = {}) {
  const name = executableName(platform);
  return [
    env.SCOUT_TYPST_PATH ? { command: path.resolve(env.SCOUT_TYPST_PATH), source: 'override' } : null,
    { command: path.resolve(appRoot, '.scout-runtime', name), source: 'managed' },
    { command: path.resolve(appRoot, '..', 'runtime', name), source: 'packaged' },
    { command: name, source: 'system' },
  ].filter(Boolean);
}

export function resolveTypstRuntime({
  appRoot = DEFAULT_APP_ROOT,
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
  spawn = spawnSync,
} = {}) {
  for (const candidate of typstCandidates({ appRoot, env, platform })) {
    if (candidate.source !== 'system' && !exists(candidate.command)) continue;
    const result = spawn(candidate.command, ['--version'], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: TYPST_PROBE_TIMEOUT_MS,
    });
    if (result.status === 0) {
      return {
        available: true,
        ...candidate,
        version: String(result.stdout || result.stderr || '').trim() || null,
      };
    }
  }
  return {
    available: false,
    command: null,
    source: null,
    version: null,
    error: 'Scout\'s managed Typst runtime is missing or unusable. Repair or reinstall Scout, then try rendering again.',
  };
}
