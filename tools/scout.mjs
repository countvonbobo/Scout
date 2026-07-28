#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
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
  assessScanCandidates, assessmentCandidatesForSelection, compactCandidates, createRankedDiscoveryStages, DEFAULT_CANDIDATE_LIMIT,
  durableScanProjection, inboxRecheckCandidates, promptCandidate, runScanPipeline, SCAN_ASSESSMENT_SCHEMA,
  verificationCandidates, writeScanArtifacts,
} from '../ui/lib/scanPipeline.mjs';
import { loadPublishedSearchProfile, migrateSearchProfile } from '../ui/lib/searchProfile.mjs';
import { partitionLiveCandidates } from '../ui/lib/advertLiveness.mjs';
import { isMainModule } from '../ui/lib/mainModule.mjs';
import { runCvQuality } from '../ui/lib/cvQuality.mjs';
import { queueWorkspaceSync } from '../ui/lib/workspaceSync.mjs';
import {
  nextScheduledRun, normaliseScheduleDays, registerDailySchedule, registerUnixSchedule,
  removeLegacySchedule, removeSchedule, runScheduledNow, scheduledRequestExpiry,
  scheduleStatus, scheduledLogicalWindow, schedulerRegistrationScript,
} from '../ui/lib/scheduler.mjs';
import {
  loadWorkspaceConfig, resolveWorkspaceRoot, seedWorkspace as seedWorkspaceFiles,
  syncManagedInstructions, workspacePaths, writeWorkspaceConfig,
} from '../ui/lib/workspace.mjs';
import { acquireScanLock, readScanLock, releaseScanLock } from './scan-lock.mjs';
import { runRemoteHostingPreflight } from './remote-hosting-preflight.mjs';
import { assertCurrentFence, synchronousFenceCallback } from '../ui/lib/scanLease.mjs';
import { PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION, RUN_ARTIFACT_SCHEMA_VERSION } from '../ui/lib/runArtifacts.mjs';
import { compatibilityFingerprint } from '../ui/lib/runRecovery.mjs';
import { coverScheduledScanWindow } from '../ui/lib/scanQueue.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SCAN_FILE_CHARS = 100_000;
const MAX_SCAN_CONTEXT_CHARS = 280_000;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scanDigest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function scanMutationReceipt(root, artifacts) {
  const paths = workspacePaths(root);
  return Object.freeze({
    schemaVersion: 1,
    id: 'scan-tracker-report',
    digest: scanDigest({
      tracker: fs.readFileSync(paths.tracker, 'utf8'),
      report: fs.readFileSync(artifacts.report, 'utf8'),
      run: artifacts.run,
    }),
  });
}

function backupHookOutcome(status) {
  if (status === undefined) return Object.freeze({ status: 'complete' });
  if (status?.state === 'offline' || status?.state === 'pending' || status?.pending === true) {
    return Object.freeze({ status: 'pending', reason: 'backup-offline' });
  }
  if (status?.state === 'needs-attention') {
    return Object.freeze({ status: 'partial', reason: 'backup-needs-attention' });
  }
  if (['synced', 'disabled'].includes(status?.state) && status?.pending !== true) {
    return Object.freeze({ status: 'complete' });
  }
  return Object.freeze({ status: 'partial', reason: 'backup-status-unknown' });
}

function queuedScanOutcome(durable) {
  if (durable?.outcome !== 'complete') return null;
  if (durable.failures?.some((failure) => failure.code === 'backup-partial')) {
    return 'succeeded-partial';
  }
  if (durable.failures?.some((failure) => failure.code === 'backup-pending')) {
    return 'succeeded-pending';
  }
  return 'succeeded';
}

function sourceConfigFingerprint(config) {
  return scanDigest({
    locale: config.locale,
    currency: config.currency,
    search: config.search,
    sources: config.sources,
    triage: config.triage,
    commute: config.commute,
  });
}

function queueConfigFingerprint(config, tracker) {
  return scanDigest({
    sourceConfigFingerprint: sourceConfigFingerprint(config),
    tracker: scanDigest(tracker),
  });
}

function scanCompatibility({
  config, mode, model, profile, provider, tracker,
  requester = 'manual', scheduleId = null, logicalWindowId = null,
}) {
  return {
    schemaVersion: 2,
    mode,
    purpose: 'manual-discovery',
    profileVersion: profile?.id || 'legacy-profile',
    sourceConfigFingerprint: sourceConfigFingerprint(config),
    journalSchemaVersion: 1,
    artifactSchemaVersion: RUN_ARTIFACT_SCHEMA_VERSION,
    stageArtifactSchemaVersion: PIPELINE_STAGE_ARTIFACT_SCHEMA_VERSION,
    pipelineVersion: 'scan-pipeline-v3-semantic-stage-artifacts',
    rankingVersion: `ranked-discovery-v1-${scanDigest(tracker).slice(0, 32)}`,
    promptVersion: 'assessment-prompt-v1',
    assessmentSchemaVersion: 1,
    provider,
    model: model || 'provider-default',
    mutationSchemaVersion: 1,
    targetRevision: `tracker-${scanDigest(tracker).slice(0, 32)}`,
    scheduleJobId: requester === 'scheduled' ? scheduleId : 'none',
    logicalWindowId: requester === 'scheduled' ? logicalWindowId : 'none',
  };
}

function scanQueueCompatibility(compatibility, profile, config, tracker) {
  return Object.freeze({
    profileFingerprint: scanDigest(profile || { id: compatibility.profileVersion }),
    configFingerprint: queueConfigFingerprint(config, tracker),
    schemaVersion: 1,
  });
}

function currentScanQueueCompatibility(root) {
  const config = loadWorkspaceConfig(root);
  const profile = loadPublishedSearchProfile(root);
  const tracker = JSON.parse(fs.readFileSync(workspacePaths(root).tracker, 'utf8'));
  return Object.freeze({
    profileFingerprint: scanDigest(profile || { id: profile?.id || 'legacy-profile' }),
    configFingerprint: queueConfigFingerprint(config, tracker),
    schemaVersion: 1,
  });
}

function verifyQueuedScanCompatibility(root, request, manifest = null) {
  const execution = request?.execution;
  if (execution?.schemaVersion !== 2) return false;
  if (manifest !== null) {
    return compatibilityFingerprint(manifest.compatibility) === execution.compatibilityFingerprint;
  }
  const config = loadWorkspaceConfig(root);
  const profile = loadPublishedSearchProfile(root);
  const tracker = JSON.parse(fs.readFileSync(workspacePaths(root).tracker, 'utf8'));
  const currentQueue = {
    ...currentScanQueueCompatibility(root),
    purpose: request.purpose,
  };
  if (stableJson(currentQueue) !== stableJson({ ...request.compatibility, purpose: request.purpose })) {
    return false;
  }
  const currentRun = scanCompatibility({
    config,
    profile,
    tracker,
    provider: execution.provider,
    mode: execution.mode,
    model: execution.model,
    requester: request.requester,
    scheduleId: execution.scheduleId,
    logicalWindowId: execution.logicalWindowId,
  });
  if (compatibilityFingerprint(currentRun) !== execution.compatibilityFingerprint) return false;
  return true;
}

function scanQueueRequest(compatibility, profile, {
  config, tracker, mode, model, provider, requestedAt, requester = 'manual',
  windowAt = null, scheduleId = null, logicalWindowId = null,
}) {
  if (!['manual', 'scheduled'].includes(requester)) throw new TypeError('scan requester is invalid');
  if (requester === 'scheduled' && !windowAt) throw new TypeError('scheduled scan requires its next window');
  if (requester === 'scheduled' && (!scheduleId || !logicalWindowId)) {
    throw new TypeError('scheduled scan requires its job and logical window identities');
  }
  return Object.freeze({
    id: randomUUID(),
    key: `scan-${scanDigest({
      mode, model: model || 'provider-default', profile: compatibility.profileVersion, provider,
      sourceConfigFingerprint: compatibility.sourceConfigFingerprint,
    }).slice(0, 40)}`,
    requester,
    purpose: compatibility.purpose,
    compatibility: scanQueueCompatibility(compatibility, profile, config, tracker),
    execution: Object.freeze({
      schemaVersion: 2,
      provider,
      mode,
      model: model || null,
      scheduleId: requester === 'scheduled' ? scheduleId : null,
      logicalWindowId: requester === 'scheduled' ? logicalWindowId : null,
      compatibilityFingerprint: compatibilityFingerprint(compatibility),
    }),
    requestedAt,
    expiresAt: requester === 'scheduled'
      ? scheduledRequestExpiry(requestedAt, windowAt)
      : new Date(Date.parse(requestedAt) + 24 * 60 * 60 * 1000).toISOString(),
    windowAt,
  });
}

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
  if (readiness.checks.preferences && readiness.checks.evidence && readiness.checks.approved) {
    migrateSearchProfile(root);
  }
  const requestedProviderReady = Boolean(providers[provider]?.installed && providers[provider]?.authenticated
    && providers[provider]?.capabilities?.structuredOutput !== false);
  readiness.checks.requestedProvider = requestedProviderReady;
  readiness.ready = readiness.ready && requestedProviderReady;
  const publishedProfile = loadPublishedSearchProfile(root);
  const profileReady = Boolean(publishedProfile || readiness.established);
  readiness.checks.searchProfile = profileReady;
  readiness.ready = readiness.ready && profileReady;
  if (!readiness.ready) {
    const missing = Object.entries(readiness.checks).filter(([, ready]) => !ready).map(([name]) => name);
    if (missing.length === 1 && missing[0] === 'searchProfile') {
      throw new Error('scan requires publishing the staged search profile after review');
    }
    throw new Error(`scan requires complete approved evidence and an authenticated provider; fix: ${missing.join(', ')}`);
  }
  return readiness;
}

export async function runScan(root, provider, mode, {
  onProgress = () => {}, model, autoBroaden = false, estimate = null,
  requester = 'manual', windowAt = null, scheduleId = null, logicalWindowId = null,
  assertScanReadyFn = assertScanReady,
  runScanWithFn = runScanWith,
  queueWorkspaceSyncFn = queueWorkspaceSync,
} = {}) {
  onProgress({ phase: 'Validating approved evidence', current: 1, total: 5 });
  assertScanReadyFn(root, provider);
  const initial = await runScanWithFn(root, provider, mode, {
    onProgress, model, requester, windowAt, scheduleId, logicalWindowId, queueWorkspaceSyncFn,
  });
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
    const broadened = await runScanWithFn(root, provider, 'broadened', {
      onProgress: retryProgress, model, queueWorkspaceSyncFn,
    });
    result = { ...broadened, automaticBroadened: true, initialScan: initial.scan };
  }
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

function vacancyKey(vacancy) {
  return String(vacancy?.vacancyId || vacancy?.canonicalUrl || vacancy?.url || '');
}

function addLivenessSummary(total, summary = {}) {
  return {
    checked: total.checked + Number(summary.checked || 0),
    gone: total.gone + Number(summary.gone || 0),
    unverified: total.unverified + Number(summary.unverified || 0),
  };
}

async function selectLiveRankedVacancies(discovery, inbox, checkLivenessFn) {
  const selected = [...discovery.selection.selected];
  const belowCutoff = new Set(discovery.selection.belowCutoff.map(vacancyKey));
  const attempted = new Set(selected.map(vacancyKey));
  const live = [];
  const closed = [];
  let summary = { checked: 0, gone: 0, unverified: 0 };

  const check = async (vacancies, extra = []) => {
    const rankedCandidates = assessmentCandidatesForSelection(vacancies).map((candidate, index) => ({
      ...candidate,
      _rankedVacancy: vacancies[index],
    }));
    const result = await checkLivenessFn([...rankedCandidates, ...extra]);
    summary = addLivenessSummary(summary, result.summary);
    live.push(...result.live.filter((candidate) => candidate._rankedVacancy).map((candidate) => candidate._rankedVacancy));
    closed.push(...result.removed.filter((candidate) => candidate._rankedVacancy));
    return result;
  };

  const initial = await check(selected, inbox.checkable);
  const staleInboxEntries = [
    ...inbox.missingSource,
    ...initial.removed.filter((candidate) => candidate._inboxRecheck),
  ];
  while (live.length < selected.length) {
    const next = discovery.ranked.find((vacancy) => !belowCutoff.has(vacancyKey(vacancy)) && !attempted.has(vacancyKey(vacancy)));
    if (!next) break;
    attempted.add(vacancyKey(next));
    await check([next]);
  }
  return { selected: live, closed, staleInboxEntries, summary };
}

export async function runScanWith(root, provider, mode, {
  providerStatusFn = providerStatus, collectSourcesFn = collectScanSources,
  runStructuredTurnFn = runStructuredTurn, acquireLockFn = acquireScanLock, releaseLockFn = releaseScanLock,
  checkLivenessFn = partitionLiveCandidates,
  onProgress = () => {}, model,
  claimedLease = null,
  requester = 'manual',
  windowAt = null,
  scheduleId = null,
  logicalWindowId = null,
  queueWorkspaceSyncFn = queueWorkspaceSync,
} = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('provider must be codex or claude');
  if (!['primary', 'second-pass', 'broadened'].includes(mode)) throw new Error('mode must be primary, broadened or second-pass');
  const status = providerStatusFn(provider);
  if (!status.installed || !status.authenticated) throw new Error(`${provider} is not installed and authenticated; run scout doctor`);
  const config = loadWorkspaceConfig(root);
  model = model === undefined
    ? (config.ai?.provider === provider ? assertSafeModel(config.ai?.model) : null)
    : assertSafeModel(model);
  const startedAt = new Date().toISOString();
  const injectedLegacyLock = claimedLease === null
    && (acquireLockFn !== acquireScanLock || releaseLockFn !== releaseScanLock);
  const lock = injectedLegacyLock ? acquireLockFn(root, { agent: provider, mode }) : null;
  if (lock && !lock.ok) {
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
  let assessmentFailures = [];
  let discovery = null;
  let publishedProfile = null;
  let funnel = null;
  let selection = [];
  let discoveryEngine = 'legacy-discovery';
  let durable = null;
  const publishedAtStart = loadPublishedSearchProfile(root);
  const trackerAtStart = JSON.parse(fs.readFileSync(workspacePaths(root).tracker, 'utf8'));
  const compatibility = scanCompatibility({
    config, mode, model, profile: publishedAtStart, provider, tracker: trackerAtStart,
    requester, scheduleId, logicalWindowId,
  });
  const request = claimedLease === null
    ? scanQueueRequest(compatibility, publishedAtStart, {
      mode, model, provider, requestedAt: startedAt, requester, windowAt,
      scheduleId, logicalWindowId, config, tracker: trackerAtStart,
    })
    : null;
  const collect = async () => {
    onProgress({ phase: 'Collecting current opportunities', current: 2, total: 5 });
    return collectSourcesFn(root, config, { broadened: mode === 'broadened' });
  };
  const stages = publishedAtStart
    ? createRankedDiscoveryStages({
      collect,
      profile: publishedAtStart,
      tracker: trackerAtStart,
      limit: DEFAULT_CANDIDATE_LIMIT,
      relevanceThreshold: config.search?.relevanceThreshold ?? config.triage?.checkScore,
    })
    : {
      collect,
      normalise({ priorArtifact }) {
        const compacted = compactCandidates(priorArtifact.sources, DEFAULT_CANDIDATE_LIMIT);
        return { candidates: compacted.candidates, dropped: compacted.dropped };
      },
      deduplicate: ({ priorArtifact }) => priorArtifact,
      filter: ({ priorArtifact }) => priorArtifact,
      rank: ({ priorArtifact }) => priorArtifact,
      select: ({ priorArtifact }) => priorArtifact,
    };
  try {
    durable = await runScanPipeline({
      root,
      compatibility,
      stages,
      claimedLease,
      prepare({ lease }) {
        assertCurrentFence(lease, synchronousFenceCallback(() => {
          syncManagedInstructions(APP_ROOT, root);
        }));
      },
      queue: {
        compatibility: () => currentScanQueueCompatibility(root),
        verify: (queuedRequest, context) => verifyQueuedScanCompatibility(
          root,
          queuedRequest,
          context.phase === 'terminal' ? context.manifest : null,
        ),
        ...(claimedLease === null && requester === 'scheduled' ? {
          cover({ lease }) {
            return coverScheduledScanWindow(root, {
              scheduleId: request.execution.scheduleId,
              logicalWindowId: request.execution.logicalWindowId,
              purpose: request.purpose,
              compatibilityFingerprint: request.execution.compatibilityFingerprint,
            }, lease);
          },
        } : {}),
        ...(claimedLease === null ? { request } : {}),
        async run(queuedRequest, context) {
          const execution = queuedRequest.execution;
          if (!execution) throw new Error('queued scan lacks a durable execution contract');
          const queued = await runScanWith(root, execution.provider, execution.mode, {
            providerStatusFn,
            collectSourcesFn,
            runStructuredTurnFn,
            acquireLockFn,
            releaseLockFn,
            checkLivenessFn,
            onProgress,
            model: execution.model,
            claimedLease: context.lease,
            requester: queuedRequest.requester,
            windowAt: queuedRequest.windowAt,
            scheduleId: execution.scheduleId,
            logicalWindowId: execution.logicalWindowId,
            queueWorkspaceSyncFn,
          });
          return queuedScanOutcome(queued.durable)
            || (queued.status === 'skipped' ? 'skipped' : 'failed');
        },
      },
      async recordFailure({ error, lease }) {
        if (result) return result;
        const artifacts = assertCurrentFence(lease, synchronousFenceCallback(() => writeScanArtifacts(root, {
          provider,
          mode,
          sources: collected?.sources || {},
          queries: collected?.queries || [],
          candidates,
          assessmentResult: null,
          policy: config.triage,
          startedAt,
          error: error.message,
          dropped,
          hardExcluded,
          closedAdverts,
          livenessSummary,
          assessmentFailures,
          verificationScoped,
          funnel,
          selection,
          discoveryEngine,
          exclusions: discovery?.exclusions || [],
          profileId: publishedProfile?.id || publishedAtStart?.id || null,
          staleInboxEntries,
          inboxRechecked,
        })));
        result = { ok: false, status: 'failed', error: error.message, scan: artifacts.run };
        return result;
      },
      async postTerminalSuccess({ lease }) {
        const assertFence = () => assertCurrentFence(lease, synchronousFenceCallback(() => true));
        assertFence();
        const status = await queueWorkspaceSyncFn(root, `complete ${mode} scan`, { assertFence });
        assertFence();
        return backupHookOutcome(status);
      },
      async finalize({ run, lease, stageOutputs }) {
        collected = stageOutputs.collect;
        publishedProfile = publishedAtStart;
        const tracker = JSON.parse(fs.readFileSync(workspacePaths(root).tracker, 'utf8'));
        try {
          if (publishedProfile) {
            discovery = stageOutputs.select;
            hardExcluded = discovery.exclusions;
            discoveryEngine = 'ranked-discovery';
            const provisional = assessmentCandidatesForSelection(discovery.selection.selected);
            const inboxRecheck = inboxRecheckCandidates(tracker, provisional);
            inboxRechecked = inboxRecheck.checkable.length + inboxRecheck.missingSource.length;
            onProgress({ phase: `Checking ${provisional.length + inboxRecheck.checkable.length} adverts are still open`, current: 2, total: 5 });
            const liveness = await selectLiveRankedVacancies(discovery, inboxRecheck, checkLivenessFn);
            closedAdverts = liveness.closed;
            staleInboxEntries = liveness.staleInboxEntries;
            livenessSummary = liveness.summary;
            let selectedVacancies = liveness.selected;
            if (mode === 'second-pass') {
              const verification = verificationCandidates(
                assessmentCandidatesForSelection(selectedVacancies), tracker, new Date().toISOString().slice(0, 10), config.triage,
              );
              const selectedIds = new Set(verification.candidates.map((candidate) => candidate.vacancyId));
              selectedVacancies = selectedVacancies.filter((vacancy) => selectedIds.has(vacancy.vacancyId));
              verificationScoped = verification.verified;
            }
            candidates = assessmentCandidatesForSelection(selectedVacancies);
            selection = candidates.map((candidate) => ({
              url: candidate.url,
              vacancyId: candidate.vacancyId,
              preRankScore: candidate.preRankScore,
              reason: discovery.selection.reasons.find((item) => item.vacancyId === candidate.vacancyId)?.reason || 'deterministic-rank',
            }));
            funnel = { ...discovery.funnel, selected: candidates.length };
          } else {
            dropped = stageOutputs.select.dropped;
            const compactedCandidates = stageOutputs.select.candidates;
            const inboxRecheck = inboxRecheckCandidates(tracker, compactedCandidates);
            inboxRechecked = inboxRecheck.checkable.length + inboxRecheck.missingSource.length;
            onProgress({ phase: `Checking ${compactedCandidates.length + inboxRecheck.checkable.length} adverts are still open`, current: 2, total: 5 });
            const liveness = await checkLivenessFn([...compactedCandidates, ...inboxRecheck.checkable]);
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
            if (mode === 'second-pass') {
              const verification = verificationCandidates(candidates, tracker, new Date().toISOString().slice(0, 10), config.triage);
              candidates = verification.candidates.map((candidate, index) => ({
                ...candidate,
                candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
              }));
              verificationScoped = verification.verified;
            }
          }

          const bundleDir = path.join(root, '.scout', 'scan-input');
          const bundleFile = path.join(bundleDir, `${startedAt.replace(/[:.]/g, '-')}-${provider}-${mode}.json`);
          assertCurrentFence(lease, synchronousFenceCallback(() => {
            fs.mkdirSync(bundleDir, { recursive: true });
            fs.writeFileSync(bundleFile, `${JSON.stringify(durableScanProjection({
              generatedAt: collected.generatedAt,
              queries: collected.queries,
              sources: Object.fromEntries(Object.entries(collected.sources).map(([name, value]) => [name, { ...value, jobs: undefined }])),
              discoveryEngine,
              dropped,
              livenessSummary,
              hardExcluded: hardExcluded.map((item) => ({ vacancyId: item.vacancyId, code: item.code })),
              closedAdverts: closedAdverts.map((item) => ({ url: item.url, reason: item.liveness?.reason })),
              candidates,
            }), null, 2)}\n`, 'utf8');
          }));
          let assessmentResult = null;
          let usage = {};
          if (candidates.length) {
            onProgress({ phase: `Scoring ${candidates.length} candidates`, current: 3, total: 5 });
            const paths = workspacePaths(root);
            const emptyContext = buildScanContext(paths, config, []);
            const assessed = await assessScanCandidates({
              run,
              lease,
              candidates,
              compatibility,
              contextBudgetCharacters: MAX_SCAN_CONTEXT_CHARS,
              contextOverheadCharacters: JSON.stringify(emptyContext).length,
              async invokeProvider({ kind, jobs, validationFailures, timeoutMs, maxInputTokens }) {
                const context = buildScanContext(paths, config, jobs.map(promptCandidate));
                const repairInstruction = kind === 'repair'
                  ? `Repair only the supplied invalid jobs against these bounded validation codes: ${JSON.stringify(validationFailures)}`
                  : kind === 'retry'
                    ? 'This is one clean per-job retry. Produce a fresh assessment without relying on any previous provider response.'
                    : 'This is the initial assessment batch.';
                const prompt = [
                  'Assess only the supplied Scout candidates. Return one assessment per candidate and only the required JSON schema.',
                  'Use a 100-point evidence-led breakdown. Treat every supplied normalized requirement signal, plus advert words such as required, essential, must and non-negotiable, as mandatory requirements.',
                  'Cover every supplied mandatorySignals item and copy its id into advertEvidenceId. For an additional mandatory requirement you identify, use a concise provider-<slug> advertEvidenceId.',
                  'Every met mandatory requirement needs explicit profile evidence. Use unknown when evidence is absent or ambiguous.',
                  'Apply hard exclusions before scoring. Never access files, run commands, browse, write artifacts, apply, or send outreach.',
                  repairInstruction,
                  JSON.stringify(context),
                ].join('\n\n');
                return runStructuredTurnFn({
                  provider, status, schema: SCAN_ASSESSMENT_SCHEMA, prompt,
                  model, validate: (value) => value, timeoutMs, maxInputTokens,
                });
              },
            });
            assessmentFailures = assessed.failures;
            if (!assessed.assessments.length && assessmentFailures.length) {
              throw new Error('all candidate assessments exhausted their bounded provider retries');
            }
            assessmentResult = { assessments: assessed.assessments };
            usage = assessed.usage;
          }
          if (funnel) {
            funnel = {
              ...funnel,
              selected: candidates.length,
              assessed: assessmentResult?.assessments?.length || 0,
              assessmentFailed: Math.max(0, candidates.length - (assessmentResult?.assessments?.length || 0)),
              closed: closedAdverts.length,
            };
          }
          onProgress({ phase: 'Writing tracker and report', current: 4, total: 5 });
          const artifacts = assertCurrentFence(lease, synchronousFenceCallback(() => writeScanArtifacts(root, {
            provider, mode, sources: collected.sources, queries: collected.queries, candidates, assessmentResult,
            policy: config.triage, startedAt,
            assessmentFailures,
            dropped, hardExcluded, closedAdverts, exclusions: discovery?.exclusions || [], livenessSummary, verificationScoped, funnel, selection, discoveryEngine, profileId: publishedProfile?.id || null,
            staleInboxEntries, inboxRechecked,
          })));
          result = { ok: true, status: artifacts.run.degraded ? 'degraded' : candidates.length ? 'completed' : 'healthy-empty', scan: artifacts.run, usage };
          return {
            schemaVersion: 1,
            result,
            mutationReceipt: scanMutationReceipt(root, artifacts),
          };
        } catch (error) {
          try {
            const artifacts = assertCurrentFence(lease, synchronousFenceCallback(() => writeScanArtifacts(root, {
              provider, mode, sources: collected?.sources || {}, queries: collected?.queries || [], candidates,
              assessmentResult: null, policy: config.triage, startedAt, error: error.message,
              assessmentFailures,
              dropped, hardExcluded, closedAdverts, livenessSummary, verificationScoped, funnel, selection, discoveryEngine,
              exclusions: discovery?.exclusions || [], profileId: publishedProfile?.id || null,
              staleInboxEntries, inboxRechecked,
            })));
            result = { ok: false, status: 'failed', error: error.message, scan: artifacts.run };
          } catch {
            result = { ok: false, status: 'failed', error: error.message };
          }
          throw error;
        }
      },
    });
    if (!result) {
      const failure = durable.failures[0];
      result = {
        ok: false,
        status: durable.outcome === 'queued' ? 'queued' : 'failed',
        error: failure?.message || (failure?.code === 'lease-busy' ? 'another scan is already running' : 'durable scan pipeline failed'),
      };
    }
    result = {
      ...result,
      runId: durable.runId,
      durable: {
        outcome: durable.outcome,
        manifest: durable.manifest,
        failures: durable.failures,
      },
    };
    if (result.ok) onProgress({ phase: 'Scan completed', current: 5, total: 5 });
  } catch (error) {
    result = { ok: false, status: 'failed', error: error.message };
  } finally {
    if (lock?.ok) {
      const released = releaseLockFn(root, lock.lock.token);
      if (!released.ok) result = { ...(result || {}), ok: false, status: 'failed', error: 'scan lock could not be released safely' };
    }
  }
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
    const args = [
      cli, 'scan', '--workspace', root, '--provider', provider, '--mode', mode,
      '--scheduled', '--schedule-id', id,
    ];
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
    const argumentsText = `"${cli}" scan --workspace "${root}" --provider ${provider} --mode ${mode} --scheduled --schedule-id ${id}${model ? ` --model ${model}` : ''}`;
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
    const mode = argValue('--mode', argv) || 'primary';
    const scheduled = argv.includes('--scheduled');
    let windowAt = null;
    let scheduleId = null;
    let logicalWindowId = null;
    if (scheduled) {
      scheduleId = argValue('--schedule-id', argv);
      const job = config.schedule?.jobs?.find((candidate) => candidate.id === scheduleId);
      if (!job || job.provider !== provider || job.mode !== mode) {
        throw new Error('scheduled scan does not match a configured schedule job');
      }
      const invokedAt = new Date();
      logicalWindowId = scheduledLogicalWindow(job.time, invokedAt, config.timezone, job.days);
      windowAt = nextScheduledRun(job.time, invokedAt, config.timezone, job.days);
      if (!logicalWindowId) throw new Error('scheduled scan has no current configured logical window');
      if (!windowAt) throw new Error('scheduled scan has no next configured window');
    }
    const result = await runScan(root, provider, mode, {
      model: argv.includes('--model') ? argValue('--model', argv) : undefined,
      requester: scheduled ? 'scheduled' : 'manual',
      windowAt,
      scheduleId,
      logicalWindowId,
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
