import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadEnv } from './env.mjs';
import { commandInvocation, detectProviders } from './providers.mjs';
import { loadWorkspaceConfig, workspacePaths } from './workspace.mjs';
import { resolveTypstRuntime } from './typstRuntime.mjs';

function binary(name) {
  const invocation = commandInvocation(name, ['--version']);
  const r = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 10_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  return { available: r.status === 0, version: String(r.stdout || r.stderr || '').trim() || null };
}

export function doctor(workspaceRoot, {
  requireProvider = true,
  providerDetector = detectProviders,
  providers = null,
  appRoot,
  typstResolver = resolveTypstRuntime,
} = {}) {
  const paths = workspacePaths(workspaceRoot);
  const checks = {};
  try {
    checks.config = { ok: true, value: loadWorkspaceConfig(workspaceRoot) };
  } catch (e) {
    checks.config = { ok: false, error: e.message };
  }
  checks.tracker = { ok: fs.existsSync(paths.tracker), path: paths.tracker };
  const git = binary('git');
  const typst = typstResolver({ appRoot });
  checks.git = { ok: git.available, ...git, optional: true };
  checks.typst = { ok: typst.available, ...typst, optional: false };
  checks.providers = providers || providerDetector();
  const env = { ...loadEnv(workspaceRoot), ...process.env };
  checks.adzuna = { ok: !!(env.ADZUNA_APP_ID && env.ADZUNA_API_KEY), optional: true };
  const providerReady = Object.values(checks.providers).some((p) => p.installed && p.authenticated);
  const required = checks.config.ok && checks.tracker.ok && checks.typst.ok && (!requireProvider || providerReady);
  return { ok: required, workspaceRoot, checks, providerSetupRequired: !providerReady };
}

function publicCheck(check) {
  return {
    ok: Boolean(check?.ok),
    ...(Object.hasOwn(check || {}, 'optional') ? { optional: Boolean(check.optional) } : {}),
  };
}

export function publicDoctor(result) {
  const checks = result?.checks || {};
  const providers = {};
  for (const provider of ['codex', 'claude']) {
    const value = checks.providers?.[provider];
    if (!value) continue;
    providers[provider] = {
      installed: Boolean(value.installed),
      authenticated: Boolean(value.authenticated),
      capabilities: { structuredOutput: Boolean(value.capabilities?.structuredOutput) },
    };
  }
  return {
    ok: Boolean(result?.ok),
    providerSetupRequired: Boolean(result?.providerSetupRequired),
    checks: {
      config: publicCheck(checks.config),
      tracker: publicCheck(checks.tracker),
      git: publicCheck(checks.git),
      typst: publicCheck(checks.typst),
      providers,
      adzuna: publicCheck(checks.adzuna),
    },
  };
}
