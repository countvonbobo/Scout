import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from './atomicWrite.mjs';
import { normaliseScheduleDays } from './scheduler.mjs';

export const CURRENT_WORKSPACE_SCHEMA = 2;

export const DEFAULT_WORKSPACE_CONFIG = Object.freeze({
  schemaVersion: CURRENT_WORKSPACE_SCHEMA,
  locale: 'en-GB',
  currency: 'GBP',
  timezone: 'Europe/London',
  profile: {
    displayName: '',
    tone: 'natural, direct and evidence-led',
  },
  searchProfile: {
    publishedId: null,
    schemaVersion: 1,
  },
  search: {
    roleFamilies: [],
    sectors: [],
    locations: [],
    exclusions: [],
    salaryMinimum: null,
  },
  triage: {
    actionScore: 70,
    checkScore: 55,
    nudgeDays: 8,
    closeoutDays: 10,
    staleDays: 10,
    decisionDays: 2,
  },
  sources: {
    adzuna: {
      country: 'gb',
      where: '',
      distanceKm: null,
      resultsPerPage: 50,
    },
    hiringCafe: {},
  },
  commute: {
    origin: '',
    mode: 'either',
    maxMinutes: 180,
    includeUnknown: true,
  },
  ai: {
    provider: null,
    model: null,
    models: { codex: null, claude: null },
  },
  schedule: {
    jobs: [],
  },
  setup: {
    completedAt: null,
    completedSections: {},
  },
});

export function defaultWorkspaceRoot(home = os.homedir()) {
  return path.join(home, 'Documents', 'Scout Workspace');
}

function workspaceArg(argv) {
  const i = argv.indexOf('--workspace');
  if (i === -1) return null;
  if (!argv[i + 1]) throw new Error('--workspace requires a path');
  return argv[i + 1];
}

export function resolveWorkspaceRoot({ appRoot, argv = process.argv.slice(2), env = process.env } = {}) {
  if (!appRoot) throw new Error('appRoot is required');
  const explicit = workspaceArg(argv) || env.SCOUT_WORKSPACE;
  if (explicit) return path.resolve(explicit);
  // Backwards compatibility for existing private checkouts. Fresh installations
  // omit data/opportunities.json and therefore use the separate Documents path.
  if (fs.existsSync(path.join(appRoot, 'data', 'opportunities.json'))) return path.resolve(appRoot);
  return defaultWorkspaceRoot();
}

export function workspacePaths(root) {
  const workspaceRoot = path.resolve(root);
  return Object.freeze({
    root: workspaceRoot,
    config: path.join(workspaceRoot, 'workspace.json'),
    env: path.join(workspaceRoot, '.env'),
    tracker: path.join(workspaceRoot, 'data', 'opportunities.json'),
    scanRuns: path.join(workspaceRoot, 'data', 'scan-runs.jsonl'),
    categories: path.join(workspaceRoot, 'data', 'search-categories.json'),
    portals: path.join(workspaceRoot, 'data', 'ats-portals.json'),
    employers: path.join(workspaceRoot, 'data', 'employers.json'),
    sources: path.join(workspaceRoot, 'data', 'sources.md'),
    reports: path.join(workspaceRoot, 'reports'),
    applications: path.join(workspaceRoot, 'applications'),
    profile: path.join(workspaceRoot, 'profile'),
    profileContext: path.join(workspaceRoot, 'profile', 'context.md'),
    searchProfileRaw: path.join(workspaceRoot, 'profile', 'search', 'raw.json'),
    searchProfileDraft: path.join(workspaceRoot, 'profile', 'search', 'draft.json'),
    searchProfilePublished: path.join(workspaceRoot, 'profile', 'search', 'published.json'),
    cv: path.join(workspaceRoot, 'cv'),
    imports: path.join(workspaceRoot, 'imports'),
    logs: path.join(workspaceRoot, 'logs'),
    backups: path.join(workspaceRoot, '.scout', 'backups'),
  });
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_WORKSPACE_CONFIG));
}

export function normaliseScheduleJobs(schedule = {}, fallbackProvider = null) {
  const supplied = Array.isArray(schedule.jobs) ? schedule.jobs : null;
  const legacy = !supplied && schedule.enabled
    ? [{
      id: `${schedule.provider || fallbackProvider || 'provider'}-primary`,
      enabled: true,
      time: schedule.time || '07:30',
      provider: schedule.provider || fallbackProvider,
      mode: 'primary',
    }]
    : [];
  return (supplied || legacy).map((job) => ({
    id: String(job.id || `${job.provider || fallbackProvider || 'provider'}-${job.mode || 'primary'}`),
    enabled: Boolean(job.enabled),
    time: job.time || '07:30',
    // Workspaces written before per-day scheduling have no days and keep
    // running every day.
    days: normaliseScheduleDays(job.days),
    provider: job.provider || fallbackProvider || null,
    mode: job.mode || 'primary',
    model: job.model || null,
  }));
}

export function mergeWorkspaceDefaults(value = {}) {
  const defaults = cloneDefaults();
  return {
    ...defaults,
    ...value,
    profile: { ...defaults.profile, ...(value.profile || {}) },
    searchProfile: { ...defaults.searchProfile, ...(value.searchProfile || {}) },
    search: { ...defaults.search, ...(value.search || {}) },
    triage: { ...defaults.triage, ...(value.triage || {}) },
    sources: {
      ...defaults.sources,
      ...(value.sources || {}),
      adzuna: { ...defaults.sources.adzuna, ...(value.sources?.adzuna || {}) },
      hiringCafe: { ...defaults.sources.hiringCafe, ...(value.sources?.hiringCafe || {}) },
    },
    commute: { ...defaults.commute, ...(value.commute || {}) },
    setup: { ...defaults.setup, ...(value.setup || {}), completedSections: { ...defaults.setup.completedSections, ...(value.setup?.completedSections || {}) } },
    ai: { ...defaults.ai, ...(value.ai || {}), models: { ...defaults.ai.models, ...(value.ai?.models || {}) } },
    schedule: { jobs: normaliseScheduleJobs(value.schedule, value.ai?.provider) },
  };
}

export function validateWorkspaceConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workspace.json must contain an object');
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) throw new Error('workspace schemaVersion must be a positive integer');
  if (value.schemaVersion > CURRENT_WORKSPACE_SCHEMA) throw new Error(`workspace schema ${value.schemaVersion} is newer than this Scout version`);
  for (const key of ['locale', 'currency', 'timezone']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`workspace ${key} is required`);
  }
  if (value.search && typeof value.search !== 'object') throw new Error('workspace search must be an object');
  for (const key of ['roleFamilies', 'sectors', 'locations', 'exclusions']) {
    if (!Array.isArray(value.search?.[key])) throw new Error(`workspace search.${key} must be an array`);
  }
  if (!value.triage || typeof value.triage !== 'object') throw new Error('workspace triage must be an object');
  for (const key of ['actionScore', 'checkScore', 'nudgeDays', 'closeoutDays', 'staleDays', 'decisionDays']) {
    if (!Number.isFinite(Number(value.triage[key])) || Number(value.triage[key]) < 0) throw new Error(`workspace triage.${key} must be a non-negative number`);
  }
  if (Number(value.triage.checkScore) > Number(value.triage.actionScore)) throw new Error('workspace triage.checkScore cannot exceed actionScore');
  if (!value.sources || typeof value.sources !== 'object') throw new Error('workspace sources must be an object');
  if (value.commute && typeof value.commute !== 'object') throw new Error('workspace commute must be an object');
  if (value.ai && ![null, 'codex', 'claude'].includes(value.ai.provider ?? null)) throw new Error('workspace ai.provider must be codex, claude, or null');
  for (const [provider, model] of Object.entries(value.ai?.models || {})) {
    if (!['codex', 'claude'].includes(provider)) throw new Error('workspace ai.models keys must be codex or claude');
    if (model !== null && !/^[A-Za-z0-9._:-]+$/.test(String(model))) throw new Error(`workspace ai.models.${provider} is invalid`);
  }
  if (!value.schedule || !Array.isArray(value.schedule.jobs)) throw new Error('workspace schedule.jobs must be an array');
  const ids = new Set();
  for (const job of value.schedule.jobs) {
    if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('workspace schedule jobs must be objects');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(job.id || ''))) throw new Error('workspace schedule job id must use lower-case letters, numbers and hyphens');
    if (ids.has(job.id)) throw new Error(`workspace schedule job id is duplicated: ${job.id}`);
    ids.add(job.id);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(job.time || ''))) throw new Error(`workspace schedule job ${job.id} time must be HH:MM`);
    if (job.days !== undefined && job.days !== null) {
      if (!Array.isArray(job.days)) throw new Error(`workspace schedule job ${job.id} days must be an array`);
      if (job.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error(`workspace schedule job ${job.id} days must be whole numbers from 0 (Sunday) to 6 (Saturday)`);
      }
    }
    if (!['codex', 'claude'].includes(job.provider)) throw new Error(`workspace schedule job ${job.id} provider must be codex or claude`);
    if (!['primary', 'second-pass'].includes(job.mode)) throw new Error(`workspace schedule job ${job.id} mode must be primary or second-pass`);
    if (job.model !== null && job.model !== undefined && !/^[A-Za-z0-9._:-]+$/.test(String(job.model))) throw new Error(`workspace schedule job ${job.id} model is invalid`);
  }
  return value;
}

// `ai.model` remains the compatibility fallback for workspaces created before
// per-provider choices were introduced.
export function modelForProvider(config, provider) {
  const chosen = config?.ai?.models?.[provider];
  if (chosen) return chosen;
  return config?.ai?.provider === provider ? config.ai?.model || null : null;
}

export function loadWorkspaceConfig(root, { allowMissing = true } = {}) {
  const file = workspacePaths(root).config;
  if (!fs.existsSync(file)) {
    if (!allowMissing) throw new Error(`workspace config missing: ${file}`);
    return cloneDefaults();
  }
  return validateWorkspaceConfig(mergeWorkspaceDefaults(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

export function writeWorkspaceConfig(root, config) {
  const checked = validateWorkspaceConfig(config);
  atomicWriteFile(workspacePaths(root).config, `${JSON.stringify(checked, null, 2)}\n`);
}

export function ensureWorkspaceDirectories(root) {
  const p = workspacePaths(root);
  for (const dir of [p.root, p.profile, p.cv, path.dirname(p.tracker), p.reports, p.applications, p.imports, p.logs, p.backups]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

export function seedWorkspace(appRoot, root) {
  ensureWorkspaceDirectories(root);
  const template = path.join(appRoot, 'templates', 'workspace');
  if (fs.existsSync(template)) fs.cpSync(template, root, { recursive: true, force: false, errorOnExist: false });
  migrateWorkspace(root);
  syncManagedInstructions(appRoot, root);
  return workspacePaths(root);
}

export function syncManagedInstructions(appRoot, workspaceRoot) {
  const ignore = path.join(workspaceRoot, '.gitignore');
  const ignoreText = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  if (!ignoreText.split(/\r?\n/).includes('data/chats/')) {
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.appendFileSync(ignore, `${ignoreText && !ignoreText.endsWith('\n') ? '\n' : ''}data/chats/\n`, 'utf8');
  }
  const currentIgnore = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const lines = currentIgnore.split(/\r?\n/);
  const scoutIndex = lines.indexOf('.scout/');
  if (scoutIndex !== -1) {
    // Note: applications/**/*.pdf remains ignored because PDFs are large and regenerable,
    // while the manifest (cv-renders.json) persists their state across restores.
    const eol = currentIgnore.includes('\r\n') ? '\r\n' : '\n';
    lines.splice(scoutIndex, 1, '.scout/*', '!.scout/cv-renders.json');
    // Atomic: this file decides what leaves the machine in a backup, so a torn
    // write here is a privacy and data-loss risk, not just a corrupt config.
    atomicWriteFile(ignore, lines.join(eol));
  }
  // A source checkout can still act as its own legacy workspace. Its managed
  // files are already present and may be protected by the host sandbox.
  if (path.resolve(appRoot) === path.resolve(workspaceRoot)) return;
  const managed = [
    [path.join('templates', 'managed', 'AGENTS.md'), 'AGENTS.md'],
    [path.join('templates', 'managed', 'CLAUDE.md'), 'CLAUDE.md'],
    [path.join('.agents', 'skills'), path.join('.agents', 'skills')],
    [path.join('.claude', 'skills'), path.join('.claude', 'skills')],
    [path.join('skills', 'builtin'), path.join('.agents', 'skills')],
    [path.join('skills', 'builtin'), path.join('.claude', 'skills')],
    [path.join('skills', 'onboard-scout'), path.join('.agents', 'skills', 'onboard-scout')],
    [path.join('skills', 'onboard-scout'), path.join('.claude', 'skills', 'onboard-scout')],
    [path.join('docs', 'SCOUT_SCAN_PROTOCOL.md'), path.join('docs', 'SCOUT_SCAN_PROTOCOL.md')],
  ];
  for (const [sourceRel, targetRel] of managed) {
    const source = path.join(appRoot, sourceRel);
    if (!fs.existsSync(source)) continue;
    const target = path.join(workspaceRoot, targetRel);
    if (path.resolve(source) === path.resolve(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
  }
}

export function backupWorkspace(root, label = 'migration') {
  const p = workspacePaths(root);
  if (!fs.existsSync(p.config)) return null;
  fs.mkdirSync(p.backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(p.backups, `${stamp}-${label}.json`);
  fs.copyFileSync(p.config, target);
  return target;
}

export function migrateWorkspace(root) {
  const p = ensureWorkspaceDirectories(root);
  if (!fs.existsSync(p.config)) {
    writeWorkspaceConfig(root, cloneDefaults());
    return { from: 0, to: CURRENT_WORKSPACE_SCHEMA, backup: null };
  }
  const raw = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  const from = Number(raw.schemaVersion || 0);
  if (from > CURRENT_WORKSPACE_SCHEMA) throw new Error(`workspace schema ${from} is newer than this Scout version`);
  if (from === CURRENT_WORKSPACE_SCHEMA) return { from, to: from, backup: null };
  const backup = backupWorkspace(root);
  const next = { ...mergeWorkspaceDefaults(raw), schemaVersion: CURRENT_WORKSPACE_SCHEMA };
  writeWorkspaceConfig(root, next);
  return { from, to: CURRENT_WORKSPACE_SCHEMA, backup };
}
