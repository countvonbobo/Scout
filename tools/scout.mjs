#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { doctor } from '../ui/lib/doctor.mjs';
import { fetchAdzuna, resolveAdzunaCredentials } from '../ui/lib/adzuna.mjs';
import { fetchConfiguredPortals } from '../ui/lib/ats.mjs';
import { fetchHiringCafe } from '../ui/lib/hiringCafe.mjs';
import { loadEnv } from '../ui/lib/env.mjs';
import { assertSafeModel, providerStatus } from '../ui/lib/providers.mjs';
import { setupReadiness } from '../ui/lib/setupReadiness.mjs';
import { runStructuredTurn } from '../ui/lib/structuredTurn.mjs';
import {
  compactCandidates, DEFAULT_CANDIDATE_LIMIT, filterVacancies, inboxRecheckCandidates, promptCandidate,
  SCAN_ASSESSMENT_SCHEMA, validateAssessments, verificationCandidates, writeScanArtifacts,
} from '../ui/lib/scanPipeline.mjs';
import { loadPublishedSearchProfile } from '../ui/lib/searchProfile.mjs';
import { partitionLiveCandidates } from '../ui/lib/advertLiveness.mjs';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import { runCvQuality } from '../ui/lib/cvQuality.mjs';
import { queueWorkspaceSync } from '../ui/lib/workspaceSync.mjs';
import { normaliseScheduleDays, registerDailySchedule, registerUnixSchedule, removeLegacySchedule, removeSchedule, runScheduledNow, scheduleStatus, schedulerRegistrationScript } from '../ui/lib/scheduler.mjs';
import {
  loadWorkspaceConfig, resolveWorkspaceRoot, seedWorkspace as seedWorkspaceFiles,
  syncManagedInstructions, workspacePaths, writeWorkspaceConfig,
} from '../ui/lib/workspace.mjs';
import { acquireScanLock, readScanLock, releaseScanLock } from './scan-lock.mjs';
import { runRemoteHostingPreflight } from './remote-hosting-preflight.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SCAN_FILE_CHARS = 100_000;
const MAX_SCAN_CONTEXT_CHARS = 280_000;

function argValue(name, argv = process.argv.slice(2)) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
}

function selectedWorkspace(argv = process.argv.slice(2)) {
  return resolveWorkspaceRoot({ appRoot: APP_ROOT, argv, env: process.env });
}

const ROLE_ALIASES = [
  [/\baccount manager\b/i, ['key account manager', 'strategic account manager', 'client account manager', 'partner manager']],
  [/\bcustomer success\b/i, ['client success manager', 'customer success manager', 'customer experience manager']],
  [/\bsoftware engineer\b/i, ['software developer', 'platform engineer', 'application developer']],
  [/\bproduct manager\b/i, ['product owner', 'technical product manager', 'product lead']],
  [/\boperations\b/i, ['operations manager', 'programme manager', 'delivery manager']],
];

export function broadenSearchQueries(config, baseQueries = []) {
  const queries = new Set(baseQueries.map((query) => String(query).trim()).filter(Boolean));
  const roles = (config.search?.roleFamilies || []).map((value) => String(value).trim()).filter(Boolean);
  const sectors = (config.search?.sectors || []).map((value) => String(value).trim()).filter(Boolean);
  const locations = (config.search?.locations || []).map((value) => String(value).trim()).filter(Boolean);
  for (const role of roles) {
    for (const [pattern, aliases] of ROLE_ALIASES) if (pattern.test(role)) aliases.forEach((alias) => queries.add(alias));
    for (const sector of sectors.slice(0, 6)) queries.add(`${role} ${sector}`);
  }
  for (const sector of sectors.slice(0, 8)) {
    queries.add(sector);
    for (const location of locations.slice(0, 2)) queries.add(`${sector} ${location}`);
  }
  return [...queries].slice(0, 30);
}

export function shouldAutoBroaden(scanResult, mode, enabled = false) {
  if (!enabled || mode !== 'primary' || !scanResult?.ok) return false;
  return !(scanResult.scan?.reviewed || []).some((item) => item.outcome === 'kept');
}

function workspaceQueries(root, { broadened = false } = {}) {
  const config = loadWorkspaceConfig(root);
  const queries = new Set((config.search?.roleFamilies || []).map((q) => String(q).trim()).filter(Boolean));
  const file = workspacePaths(root).categories;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const category of parsed.categories || []) for (const query of category.queries || []) if (String(query).trim()) queries.add(String(query).trim());
    } catch { /* doctor reports malformed configuration separately */ }
  }
  return broadened ? broadenSearchQueries(config, [...queries]) : [...queries];
}

function copyIfPresent(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The generic seed is created first so a migrated workspace always has the
  // current schema and managed files. Legacy user content must then win over
  // those placeholders; skipping an existing destination silently discarded
  // profile, CV, tracker, report and application data.
  fs.cpSync(source, target, { recursive: true, force: true });
}

function verifyCopiedTree(source, target) {
  if (!fs.existsSync(source)) return 0;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`legacy migration does not accept symbolic links: ${source}`);
  if (stat.isDirectory()) {
    return fs.readdirSync(source).reduce((count, name) => (
      count + verifyCopiedTree(path.join(source, name), path.join(target, name))
    ), 0);
  }
  if (!fs.existsSync(target) || !fs.readFileSync(source).equals(fs.readFileSync(target))) {
    throw new Error(`legacy migration parity check failed: ${source}`);
  }
  return 1;
}

function initWorkspace(root) {
  const p = seedWorkspaceFiles(APP_ROOT, root);
  if (!fs.existsSync(path.join(root, '.git'))) spawnSync('git', ['init'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return p;
}

function inferLegacyConfig(sourceRoot, targetRoot) {
  const config = loadWorkspaceConfig(targetRoot);
  const cv = path.join(sourceRoot, 'cv', 'master-cv.md');
  if (fs.existsSync(cv)) {
    const heading = fs.readFileSync(cv, 'utf8').match(/^#\s+(.+?)(?:\s+[—-]\s+|$)/m);
    if (heading) config.profile.displayName = heading[1].trim();
  }
  const commute = path.join(sourceRoot, 'data', 'commute-policy.md');
  if (fs.existsSync(commute)) {
    const postcode = fs.readFileSync(commute, 'utf8').match(/Origin postcode[^`]*`([^`]+)`/i);
    if (postcode) config.commute.origin = postcode[1].trim();
  }
  writeWorkspaceConfig(targetRoot, config);
}

export function migrateLegacyWorkspace(sourceRoot, targetRoot) {
  if (path.resolve(sourceRoot) === path.resolve(targetRoot)) throw new Error('source and target workspace must differ');
  initWorkspace(targetRoot);
  for (const rel of ['profile', 'cv', 'data', 'reports', 'applications', '.env']) {
    copyIfPresent(path.join(sourceRoot, rel), path.join(targetRoot, rel));
  }
  const verifiedFiles = ['profile', 'cv', 'data', 'reports', 'applications', '.env']
    .reduce((count, rel) => count + verifyCopiedTree(path.join(sourceRoot, rel), path.join(targetRoot, rel)), 0);
  inferLegacyConfig(sourceRoot, targetRoot);
  const ignore = path.join(targetRoot, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '.env\n.agents/\n.claude/\nAGENTS.md\nCLAUDE.md\n.scout/*\n!.scout/cv-renders.json\nlogs/\napplications/**/*.pdf\napplications/**/*.docx\ndata/chats/\n', 'utf8');
  spawnSync('git', ['add', '--', '.'], { cwd: targetRoot, encoding: 'utf8', windowsHide: true });
  const commit = spawnSync('git', ['commit', '-m', 'Initial private Scout workspace'], { cwd: targetRoot, encoding: 'utf8', windowsHide: true });
  return { sourceRoot, targetRoot, verifiedFiles, committed: commit.status === 0, commitMessage: String(commit.stderr || commit.stdout || '').trim() };
}

export function assertScanReady(root, provider, { providerStatusFn = providerStatus } = {}) {
  const config = loadWorkspaceConfig(root);
  const tracker = JSON.parse(fs.readFileSync(workspacePaths(root).tracker, 'utf8'));
  const selected = config.ai?.provider;
  const providers = Object.fromEntries([...new Set([selected, provider].filter(Boolean))].map((name) => [name, providerStatusFn(name)]));
  const readiness = setupReadiness(root, config, providers, tracker);
  const requestedProviderReady = Boolean(providers[provider]?.installed && providers[provider]?.authenticated
    && providers[provider]?.capabilities?.structuredOutput !== false);
  readiness.checks.requestedProvider = requestedProviderReady;
  readiness.ready = readiness.ready && requestedProviderReady;
  if (!readiness.ready) {
    const missing = Object.entries(readiness.checks).filter(([, ready]) => !ready).map(([name]) => name);
    throw new Error(`scan requires complete approved evidence and an authenticated provider; fix: ${missing.join(', ')}`);
  }
  return readiness;
}

export async function runScan(root, provider, mode, {
  onProgress = () => {}, model, autoBroaden = false, estimate = null,
} = {}) {
  onProgress({ phase: 'Validating approved evidence', current: 1, total: 5 });
  assertScanReady(root, provider);
  const initial = await runScanWith(root, provider, mode, { onProgress, model });
  let result = initial;
  if (shouldAutoBroaden(initial, mode, autoBroaden)) {
    const broadenedEstimate = estimate ? {
      ...estimate,
      totalSecondsLow: Number(estimate.totalSecondsLow || 0) * 2,
      totalSecondsHigh: Number(estimate.totalSecondsHigh || 0) * 2,
    } : null;
    onProgress({
      phase: 'No keepers — widening discovery safely', current: 6, total: 10,
      ...(broadenedEstimate ? { estimate: broadenedEstimate } : {}),
    });
    const retryProgress = (progress = {}) => onProgress({
      ...progress, total: 10,
      current: Number.isFinite(progress.current) ? Math.min(10, 5 + progress.current) : 6,
    });
    const broadened = await runScanWith(root, provider, 'broadened', { onProgress: retryProgress, model });
    result = { ...broadened, automaticBroadened: true, initialScan: initial.scan };
  }
  await queueWorkspaceSync(root, `complete ${mode || 'primary'} scan`).catch(() => {});
  return result;
}

function compactSource(result, configured = true) {
  return {
    configured, status: result?.status || (result?.available === false ? 'unavailable' : 'healthy'),
    count: Number.isFinite(Number(result?.count)) ? Number(result.count) : (Array.isArray(result?.jobs) ? result.jobs.length : 0),
    reason: result?.reason || null, errors: Array.isArray(result?.errors) ? result.errors.slice(0, 20) : [],
    recovery: result?.recovery || null, jobs: Array.isArray(result?.jobs) ? result.jobs : [],
  };
}

export async function collectScanSources(root, config, {
  fetchAts = fetchConfiguredPortals, fetchCafe = fetchHiringCafe, fetchAdzunaFn = fetchAdzuna, broadened = false,
} = {}) {
  const queries = workspaceQueries(root, { broadened });
  const env = { ...loadEnv(root), ...process.env };
  const credentials = resolveAdzunaCredentials(env);
  const adzuna = config.sources?.adzuna || {};
  const capture = async (action, configured) => {
    if (!configured) return compactSource({ status: 'unavailable', count: 0, reason: 'not configured', jobs: [] }, false);
    try { return compactSource(await action(), true); }
    catch (error) { return compactSource({ status: 'unavailable', count: 0, reason: error.message, errors: [error.message], jobs: [] }, true); }
  };
  const atsResult = await capture(() => fetchAts(root), true);
  if (/^no .*portals? (?:configured|enabled)$/i.test(String(atsResult.reason || ''))) atsResult.configured = false;
  const [hiringCafe, adzunaResult] = await Promise.all([
    capture(() => fetchCafe(queries, globalThis.fetch, { ...config.sources?.hiringCafe, locale: config.locale }), queries.length > 0),
    capture(() => fetchAdzunaFn({
      ...(credentials || {}), ...adzuna, queries, where: broadened ? '' : (adzuna.where || config.search?.locations?.[0] || ''),
      salaryMin: config.search?.salaryMinimum, locale: config.locale, currency: config.currency,
    }), Boolean(credentials)),
  ]);
  return { generatedAt: new Date().toISOString(), queries, sources: { ats: atsResult, hiring_cafe: hiringCafe, adzuna: adzunaResult } };
}

function readBounded(file, label, maximum = MAX_SCAN_FILE_CHARS) {
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  if (text.length > maximum) throw new Error(`${label} exceeds Scout's ${maximum.toLocaleString('en-GB')}-character per-file scan limit`);
  return text;
}

// Only the settings that affect scoring. The full workspace config also carries
// source credentials configuration, schedule jobs and provider choices, none of
// which the model needs and all of which it was previously sent.
export function scoringConfig(config = {}) {
  return {
    locale: config.locale,
    currency: config.currency,
    search: config.search,
    triage: config.triage,
    commute: config.commute,
  };
}

function buildScanContext(paths, config, candidates) {
  const context = {
    config: scoringConfig(config),
    profile: readBounded(path.join(paths.profile, 'context.md'), 'profile/context.md'),
    calibration: readBounded(path.join(paths.profile, 'calibration.md'), 'profile/calibration.md'),
    masterCv: readBounded(path.join(paths.cv, 'master-cv.md'), 'cv/master-cv.md'),
    candidates,
  };
  const characters = JSON.stringify(context).length;
  if (characters > MAX_SCAN_CONTEXT_CHARS) {
    throw new Error(`assembled scan context exceeds Scout's ${MAX_SCAN_CONTEXT_CHARS.toLocaleString('en-GB')}-character limit (${characters.toLocaleString('en-GB')}); reduce configured sources or shorten the profile/CV`);
  }
  return context;
}

export async function runScanWith(root, provider, mode, {
  providerStatusFn = providerStatus, collectSourcesFn = collectScanSources,
  runStructuredTurnFn = runStructuredTurn, acquireLockFn = acquireScanLock, releaseLockFn = releaseScanLock,
  checkLivenessFn = partitionLiveCandidates,
  onProgress = () => {}, model,
} = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('provider must be codex or claude');
  if (!['primary', 'second-pass', 'broadened'].includes(mode)) throw new Error('mode must be primary, broadened or second-pass');
  const status = providerStatusFn(provider);
  if (!status.installed || !status.authenticated) throw new Error(`${provider} is not installed and authenticated; run scout doctor`);
  syncManagedInstructions(APP_ROOT, root);
  const config = loadWorkspaceConfig(root);
  model = model === undefined
    ? (config.ai?.provider === provider ? assertSafeModel(config.ai?.model) : null)
    : assertSafeModel(model);
  const startedAt = new Date().toISOString();
  const lock = acquireLockFn(root, { agent: provider, mode });
  if (!lock.ok) {
    const artifacts = writeScanArtifacts(root, {
      provider, mode, sources: {}, candidates: [], assessmentResult: null, policy: config.triage,
      startedAt, error: 'another scan is already running', skipped: true,
    });
    return { ok: false, status: 'skipped', error: 'another scan is already running', lock: lock.lock, scan: artifacts.run };
  }
  let result;
  let collected = null;
  let candidates = [];
  let dropped = { perSource: {}, total: 0 };
  let hardExcluded = [];
  let closedAdverts = [];
  let livenessSummary = { checked: 0, gone: 0, unverified: 0 };
  let staleInboxEntries = [];
  let inboxRechecked = 0;
  let verificationScoped = false;
  try {
    onProgress({ phase: 'Collecting current opportunities', current: 2, total: 5 });
    collected = await collectSourcesFn(root, config, { broadened: mode === 'broadened' });
    const compacted = compactCandidates(collected.sources, DEFAULT_CANDIDATE_LIMIT);
    dropped = compacted.dropped;

    // Everything below runs before the assessment turn, so each candidate it
    // removes is one the provider is never asked to score.
    const publishedProfile = loadPublishedSearchProfile(root);
    const afterExclusions = publishedProfile
      ? filterVacancies(compacted.candidates, publishedProfile)
      : { eligible: compacted.candidates, excluded: [] };
    hardExcluded = afterExclusions.excluded;
    if (mode === 'second-pass') {
      const tracker = JSON.parse(fs.readFileSync(workspacePaths(root).tracker, 'utf8'));
      const verification = verificationCandidates(afterExclusions.eligible, tracker, new Date().toISOString().slice(0, 10), config.triage);
      afterExclusions.eligible = verification.candidates;
      verificationScoped = verification.verified;
    }
    const tracker = JSON.parse(fs.readFileSync(workspacePaths(root).tracker, 'utf8'));
    const inboxRecheck = inboxRecheckCandidates(tracker, afterExclusions.eligible);
    inboxRechecked = inboxRecheck.checkable.length + inboxRecheck.missingSource.length;
    onProgress({ phase: `Checking ${afterExclusions.eligible.length + inboxRecheck.checkable.length} adverts are still open`, current: 2, total: 5 });
    const liveness = await checkLivenessFn([...afterExclusions.eligible, ...inboxRecheck.checkable]);
    closedAdverts = liveness.removed.filter((candidate) => !candidate._inboxRecheck);
    staleInboxEntries = [
      ...inboxRecheck.missingSource,
      ...liveness.removed.filter((candidate) => candidate._inboxRecheck),
    ];
    livenessSummary = liveness.summary;
    candidates = liveness.live.filter((candidate) => !candidate._inboxRecheck).map((candidate, index) => ({
      ...candidate,
      candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
    }));

    const bundleDir = path.join(root, '.scout', 'scan-input');
    fs.mkdirSync(bundleDir, { recursive: true });
    const bundleFile = path.join(bundleDir, `${startedAt.replace(/[:.]/g, '-')}-${provider}-${mode}.json`);
    fs.writeFileSync(bundleFile, `${JSON.stringify({ generatedAt: collected.generatedAt, queries: collected.queries, sources: Object.fromEntries(Object.entries(collected.sources).map(([name, value]) => [name, { ...value, jobs: undefined }])), dropped, livenessSummary, hardExcluded: hardExcluded.map((item) => ({ url: item.url, matches: item.hardExclusionMatches })), closedAdverts: closedAdverts.map((item) => ({ url: item.url, reason: item.liveness?.reason })), candidates }, null, 2)}\n`, 'utf8');
    let assessmentResult = null;
    let usage = {};
    if (candidates.length) {
      onProgress({ phase: `Scoring ${candidates.length} candidates`, current: 3, total: 5 });
      const paths = workspacePaths(root);
      const context = buildScanContext(paths, config, candidates.map(promptCandidate));
      const prompt = [
        'Assess only the supplied Scout candidates. Return one assessment per candidate and only the required JSON schema.',
        'Use a 100-point evidence-led breakdown. Treat every supplied normalized requirement signal, plus advert words such as required, essential, must and non-negotiable, as mandatory requirements.',
        'Cover every supplied mandatorySignals item and copy its id into advertEvidenceId. For an additional mandatory requirement you identify, use a concise provider-<slug> advertEvidenceId.',
        'Every met mandatory requirement needs explicit profile evidence. Use unknown when evidence is absent or ambiguous.',
        'Apply hard exclusions before scoring. Never access files, run commands, browse, write artifacts, apply, or send outreach.',
        JSON.stringify(context),
      ].join('\n\n');
      const turn = await runStructuredTurnFn({
        provider, status, schema: SCAN_ASSESSMENT_SCHEMA, prompt,
        model,
        validate: (value) => validateAssessments(value, candidates), timeoutMs: 20 * 60 * 1000, maxInputTokens: 75_000,
      });
      assessmentResult = turn.value;
      usage = turn.usage;
    }
    onProgress({ phase: 'Writing tracker and report', current: 4, total: 5 });
    const artifacts = writeScanArtifacts(root, {
      provider, mode, sources: collected.sources, queries: collected.queries, candidates, assessmentResult,
      policy: config.triage, startedAt,
      dropped, hardExcluded, closedAdverts, livenessSummary, verificationScoped,
      staleInboxEntries, inboxRechecked,
    });
    result = { ok: true, status: artifacts.run.degraded ? 'degraded' : candidates.length ? 'completed' : 'healthy-empty', scan: artifacts.run, usage };
    onProgress({ phase: 'Scan completed', current: 5, total: 5 });
  } catch (error) {
    try {
      const artifacts = writeScanArtifacts(root, {
        provider, mode, sources: collected?.sources || {}, queries: collected?.queries || [], candidates,
        assessmentResult: null, policy: config.triage, startedAt, error: error.message,
      });
      result = { ok: false, status: 'failed', error: error.message, scan: artifacts.run };
    } catch {
      result = { ok: false, status: 'failed', error: error.message };
    }
  } finally {
    const released = releaseLockFn(root, lock.lock.token);
    if (!released.ok) result = { ...(result || {}), ok: false, status: 'failed', error: 'scan lock could not be released safely' };
  }
  const logs = workspacePaths(root).logs;
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify({ provider, mode, ...result }, null, 2)}\n`);
  return result;
}

export function installSchedule(root, time, provider, { id = `${provider}-primary`, mode = 'primary', model = null, days = null } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('schedule provider must be codex or claude');
  if (!['primary', 'second-pass'].includes(mode)) throw new Error('schedule mode must be primary or second-pass');
  model = assertSafeModel(model);
  const selectedDays = normaliseScheduleDays(days);
  const config = loadWorkspaceConfig(root);
  removeLegacySchedule();
  const cli = fileURLToPath(import.meta.url);
  if (process.platform !== 'win32') {
    const args = [cli, 'scan', '--workspace', root, '--provider', provider, '--mode', mode];
    if (model) args.push('--model', model);
    const result = registerUnixSchedule({ id, platform: process.platform, command: process.execPath, args, workingDirectory: APP_ROOT, time, timezone: config.timezone, days: selectedDays });
    if (result.ok) {
      config.schedule.jobs = [...config.schedule.jobs.filter((job) => job.id !== id), { id, enabled: true, time, days: selectedDays, provider, mode, model: model || null }];
      writeWorkspaceConfig(root, config);
    }
    return result;
  }
  const scriptFile = path.join(os.tmpdir(), `scout-task-${process.pid}.ps1`);
  fs.writeFileSync(scriptFile, schedulerRegistrationScript(), 'utf8');
  try {
    const argumentsText = `"${cli}" scan --workspace "${root}" --provider ${provider} --mode ${mode}${model ? ` --model ${model}` : ''}`;
    const result = registerDailySchedule({ id, scriptFile, command: process.execPath, argumentsText, workingDirectory: APP_ROOT, time, days: selectedDays });
    if (result.ok) {
      config.schedule.jobs = [...config.schedule.jobs.filter((job) => job.id !== id), { id, enabled: true, time, days: selectedDays, provider, mode, model: model || null }];
      writeWorkspaceConfig(root, config);
    }
    return result;
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }
}

function print(value) { process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`); }

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'help';
  const root = selectedWorkspace(argv);
  if (command === 'doctor') return print(doctor(root, { appRoot: APP_ROOT }));
  if (command === 'remote') {
    const action = argv[1] || 'preflight';
    if (action !== 'preflight') throw new Error('remote action must be preflight');
    const result = await runRemoteHostingPreflight({
      url: argValue('--url', argv) || 'http://127.0.0.1:8459',
      requireEnabled: argv.includes('--require-enabled'),
    });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'workspace') {
    const action = argv[1] || 'init';
    if (action === 'init') return print({ ok: true, workspace: initWorkspace(root) });
    if (action === 'migrate') {
      const source = path.resolve(argValue('--from', argv) || APP_ROOT);
      const target = path.resolve(argValue('--to', argv) || argValue('--workspace', argv) || path.join(os.homedir(), 'Documents', 'Scout Workspace'));
      return print({ ok: true, ...migrateLegacyWorkspace(source, target) });
    }
  }
  if (command === 'scan') {
    const config = loadWorkspaceConfig(root);
    const provider = argValue('--provider', argv) || config.ai?.provider;
    const result = await runScan(root, provider, argValue('--mode', argv) || 'primary', {
      model: argv.includes('--model') ? argValue('--model', argv) : undefined,
    });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === 'cv') {
    const action = argv[1] || 'quality';
    if (action !== 'quality') throw new Error('cv action must be quality');
    const slug = argv[2];
    if (!slug) throw new Error('cv quality requires an application slug');
    const config = loadWorkspaceConfig(root);
    const result = runCvQuality(root, slug, { locale: config.locale, appRoot: APP_ROOT });
    await queueWorkspaceSync(root, `review cv quality - ${slug}`).catch(() => {});
    print(result);
    if (!result.pass) process.exitCode = 1;
    return;
  }
  if (command === 'lock') {
    const action = argv[1] || 'status';
    if (action === 'acquire') return print(acquireScanLock(root, { agent: argv[2], mode: argv[3] }));
    if (action === 'release') return print(releaseScanLock(root, argv[2]));
    if (action === 'status') return print({ ok: true, lock: readScanLock(root) });
    throw new Error('lock action must be acquire, release, or status');
  }
  if (command === 'source') {
    const source = argv[1];
    const queries = workspaceQueries(root);
    const config = loadWorkspaceConfig(root);
    if (source === 'ats') return print(await fetchConfiguredPortals(root));
    if (source === 'hiring-cafe') return print(await fetchHiringCafe(queries, globalThis.fetch, {
      ...config.sources?.hiringCafe,
      locale: config.locale,
    }));
    if (source === 'adzuna') {
      const credentials = resolveAdzunaCredentials({ ...loadEnv(root), ...process.env });
      const adzuna = config.sources?.adzuna || {};
      return print(await fetchAdzuna({
        ...(credentials || {}),
        ...adzuna,
        queries,
        where: adzuna.where || config.search?.locations?.[0] || '',
        salaryMin: config.search?.salaryMinimum,
        locale: config.locale,
        currency: config.currency,
      }));
    }
    throw new Error('source must be ats, adzuna, or hiring-cafe');
  }
  if (command === 'schedule') {
    const action = argv[1] || 'status';
    const config = loadWorkspaceConfig(root);
    const id = argValue('--id', argv) || config.schedule?.jobs?.[0]?.id || 'primary';
    if (action === 'status') return print({
      ok: true,
      runs: config.schedule.jobs.map((job) => ({ ...job, ...scheduleStatus({ id: job.id }) })),
    });
    if (action === 'remove') {
      const result = removeSchedule({ id });
      if (result.ok) {
        config.schedule.jobs = config.schedule.jobs.map((job) => job.id === id ? { ...job, enabled: false } : job);
        writeWorkspaceConfig(root, config);
      }
      return print(result);
    }
    if (action === 'run-now') return print(runScheduledNow({ id }));
    if (action === 'install') {
      const provider = argValue('--provider', argv) || config.ai?.provider;
      const mode = argValue('--mode', argv) || 'primary';
      const days = argValue('--days', argv);
      return print(installSchedule(root, argValue('--time', argv) || '07:30', provider, {
        id: argValue('--id', argv) || `${provider}-${mode}`,
        mode,
        model: argValue('--model', argv),
        days: days ? days.split(',').map((day) => Number(day.trim())) : null,
      }));
    }
  }
  print(`Scout CLI\n\nCommands:\n  doctor [--workspace PATH]\n  remote preflight [--require-enabled] [--url URL]\n  workspace init|migrate [--from PATH] [--to PATH]\n  cv quality <application-slug> [--workspace PATH]\n  lock acquire|release|status\n  source ats|adzuna|hiring-cafe\n  scan --provider codex|claude [--mode primary|second-pass] [--model MODEL]\n  schedule install|status|remove|run-now [--id ID] [--time HH:MM] [--days 0,1,2] [--provider PROVIDER] [--mode primary|second-pass] [--model MODEL]`);
}

const isMain = isMainModule(import.meta.url);
if (isMain) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
