import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/mainModule.mjs';
import { atomicWriteFile } from './lib/atomicWrite.mjs';
import {
  PROFILE_PUBLICATION_RUN_PREFIX, publishProfileGeneration,
  recoverPendingProfilePublications,
} from './lib/profilePublication.mjs';
import { rerankHistoricalVacancies } from './lib/workspaceMigration.mjs';
import {
  withWorkspaceMutationAuthority, withWorkspaceMutationAuthorityAsync,
} from './lib/workspaceMutationAuthority.mjs';
import { withMutationCoordinator } from './lib/mutationCoordinator.mjs';
import { codexDeepLinkCapability } from './lib/codexDeepLink.mjs';
import { triage } from './lib/derive.mjs';
import { emptyTrackerView, pipeline } from './lib/pipeline.mjs';
import { cvPdfPath, listCvFiles, renderCvTarget, safeCvPath } from './lib/cv.mjs';
import { cvDownloadDecision, overrideCvQuality, readCvQuality, runCvQuality } from './lib/cvQuality.mjs';
import {
  parseScanRuns, readPublicRunSummaries, readPublicScanQueue, readPublicStoragePressure,
  scanHealthFromText,
} from './lib/scanHealth.mjs';
import {
  acquireScanLease, currentLeaseOwner, readScanLease, releaseScanLease, renewScanLease,
  startLeaseHeartbeat,
} from './lib/scanLease.mjs';
import { scanEstimate } from './lib/scanEstimate.mjs';
import { createProviderHealthMonitor, scheduleStatus, scheduleSummary } from './lib/scheduler.mjs';
import { loadPortals, portalSummary } from './lib/ats.mjs';
import { JOB_CATEGORIES } from './lib/filters.mjs';
import { buildSourcePayload, sourceUrlOf, SourceCache } from './lib/source.mjs';
import { fetchPublicResource, PublicHttpError } from './lib/publicHttp.mjs';
import {
  assertSafeModel, detectProvidersAsync, providerLocalHealthSignal, runProviderCommand,
} from './lib/providers.mjs';
import {
  PROVIDER_HEALTH_STATES, providerPreflight, readProviderHealth,
} from './lib/providerHealth.mjs';
import {
  acquireProviderAuthMutation, acquireProviderWork, releaseProviderAuthMutation,
  releaseProviderWork, renewProviderAuthMutation,
} from './lib/providerAuthMutation.mjs';
import { createProviderLoginManager } from './lib/providerLogin.mjs';
import { runStructuredTurn } from './lib/structuredTurn.mjs';
import { doctor, publicDoctor } from './lib/doctor.mjs';
import { extractCvText } from './lib/cvImport.mjs';
import { setupReadiness } from './lib/setupReadiness.mjs';
import { OperationConflictError, OperationManager } from './lib/operations.mjs';
import {
  activateOnboardingProposal, activatedProposalRecovery, createOnboardingProposal, discardOnboardingProposal,
  readOnboardingProposal, recoverActivatedProposal, recoverOnboardingActivationAtStartup,
} from './lib/onboardingProposal.mjs';
import { loadDeviceSettings, pendingDeviceSections, saveDeviceSettings, setWindowsStartup, updateDownloadDirectory, windowsStartupStatus } from './lib/deviceSettings.mjs';
import { disableRemoteAccess, enableRemoteAccess, remoteAccessStatus } from './lib/remoteAccess.mjs';
import {
  checkForUpdate, downloadVerifiedUpdate, publicDownloadedUpdate, publicIsoTimestamp,
} from './lib/updates.mjs';
import {
  adoptExistingWorkspaceFromGithub, confirmRecoveryKey, connectWorkspaceSync, detectGit, disableWorkspaceSync, loadSyncSettings, pendingRecoveryKey,
  prepareGithubDeployKey, queueWorkspaceResolution, queueWorkspaceSync, restoreWorkspaceFromGithub,
  rotateWorkspaceRecoveryPassphrase, syncStatus,
} from './lib/workspaceSync.mjs';
import { completedWorkspaceSections, pendingWorkspaceSections } from './lib/setupSections.mjs';
import { BoundedUtf8Body } from './lib/requestBody.mjs';
import {
  acquireTrackerMutationLock, mutateTrackerSnapshot, readTrackerSnapshot,
  releaseTrackerMutationLock, TrackerRevisionConflictError,
} from './lib/trackerPersistence.mjs';
import { loadEnv, saveEnv } from './lib/env.mjs';
import {
  loadPublishedSearchProfile, migrateSearchProfile, profileFingerprint, publishSearchProfile,
  searchProfileRuleIds, validateSearchProfile,
} from './lib/searchProfile.mjs';
import {
  applyAdaptiveAnswers, buildAdaptiveQuestionnaire,
} from './lib/adaptiveSetup.mjs';
import {
  loadSearchLanePlan, reconcileSearchLanePlan, restoreSearchLane,
  retireUnproductiveSearchLanes, searchLanePlanRevision, writeSearchLanePlan,
} from './lib/searchLanes.mjs';
import {
  employerRegistryRevision, loadEmployerRegistry, migrateLegacyPortals,
  reconcileEmployerDiscoveries, undoEmployerRegistryReview,
  updateEmployerRegistryEntry, writeEmployerRegistry,
} from './lib/employerRegistry.mjs';
import {
  activeLearningPolicy, createLearningLedger, learningLedgerRevision,
  loadLearningLedger, proposeLearningChange, publishLearningProposal,
  recordFeedback, undoLearningVersion, writeLearningLedger,
} from './lib/feedbackLearning.mjs';
import {
  loadWorkspaceConfig, migrateWorkspace, resolveWorkspaceRoot, seedWorkspace, syncManagedInstructions,
  workspacePaths, writeWorkspaceConfig,
} from './lib/workspace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = APP_ROOT; // retained for API compatibility
export const WORKSPACE_ROOT = resolveWorkspaceRoot({ appRoot: APP_ROOT });
export const PORT = Number(process.env.PORT) || 8459;
export const APP_VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
// Every file the browser caches under this id. A module served to the shell
// belongs here: leaving one out lets a release change behaviour while installed
// clients keep the previous `scout-shell-<id>` cache and the previous ?v= URL.
export const UI_BUILD_FILES = [
  'index.html', 'app.js', 'setup.js', 'reportView.js', 'service-worker.js', 'manifest.webmanifest',
  'lib/scoutCharacter.mjs', 'lib/chatDrawerState.mjs', 'lib/codexDeepLink.mjs',
  'assets/scout-icon.ico', 'assets/scout-icon.png', 'assets/scout-idle.png',
  'assets/scout-thinking.png', 'assets/scout-searching.png', 'assets/scout-explaining.png',
  'assets/scout-found.png', 'assets/scout-warning.png',
];
export function computeUiBuildId(readFile = (name) => fs.readFileSync(path.join(__dirname, name))) {
  const hash = createHash('sha256');
  for (const name of UI_BUILD_FILES) {
    hash.update(name).update('\0').update(readFile(name)).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}
export const UI_BUILD_ID = computeUiBuildId();
const WORKSPACE = workspacePaths(WORKSPACE_ROOT);
const TRACKER = WORKSPACE.tracker;
const REPORTS_DIR = WORKSPACE.reports;
const SCAN_RUNS = WORKSPACE.scanRuns;
export const operations = new OperationManager();
let runtimeHttpServer = null;
let runtimeRequestAdmissionOpen = true;
let runtimeRecoveryAdmissionOpen = true;
const runtimeRecoveryTimers = new Set();
const pausedRuntimeRecoveries = [];
const runtimeHttpHandlers = new Set();
let runtimeSyncTimer = null;

function scheduleRuntimeRecovery(callback, delay, schedule = setTimeout, cancel = clearTimeout) {
  if (!runtimeRecoveryAdmissionOpen) return null;
  const record = {
    timer: null, cancel, callback, delay, schedule,
  };
  record.timer = schedule(() => {
    runtimeRecoveryTimers.delete(record);
    if (runtimeRecoveryAdmissionOpen) return callback();
    return undefined;
  }, delay);
  runtimeRecoveryTimers.add(record);
  record.timer?.unref?.();
  return record.timer;
}

function closeRuntimeRecoveryAdmission() {
  runtimeRecoveryAdmissionOpen = false;
  for (const record of runtimeRecoveryTimers) {
    record.cancel(record.timer);
    pausedRuntimeRecoveries.push(record);
  }
  runtimeRecoveryTimers.clear();
}

function trackRuntimeHttpHandler(task) {
  const pending = Promise.resolve(task);
  runtimeHttpHandlers.add(pending);
  void pending.finally(() => runtimeHttpHandlers.delete(pending)).catch(() => {});
  return pending;
}

function createRuntimeHttpHandlerBarrier() {
  let settle;
  let settled = false;
  const pending = new Promise((resolve) => { settle = resolve; });
  trackRuntimeHttpHandler(pending);
  return () => {
    if (settled) return;
    settled = true;
    settle();
  };
}

function startRuntimeSyncTimer() {
  if (runtimeSyncTimer) return;
  runtimeSyncTimer = setInterval(() => {
    if (workspaceInitialised()) void scheduleCheckpoint('periodic sync');
  }, 5 * 60 * 1000);
  runtimeSyncTimer.unref();
}

// Fresh installations remain uninitialised until the person chooses either a
// new local workspace or Restore. Existing workspaces keep the legacy fast path.
if (fs.existsSync(TRACKER) && path.resolve(APP_ROOT) !== path.resolve(WORKSPACE_ROOT)) {
  migrateWorkspace(WORKSPACE_ROOT);
  syncManagedInstructions(APP_ROOT, WORKSPACE_ROOT);
}

function workspaceInitialised() { return fs.existsSync(TRACKER) && fs.existsSync(WORKSPACE.config); }

export function recoverProfilePublicationsAtStartup({
  root = WORKSPACE_ROOT,
  initialised = workspaceInitialised,
  recover = recoverPendingProfilePublications,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!runtimeRecoveryAdmissionOpen || !initialised()) return;
  try {
    recover(root);
  } catch (error) {
    if (error?.reasonCode !== 'profile-publication-fenced') {
      throw error;
    }
    scheduleRuntimeRecovery(() => recoverProfilePublicationsAtStartup({
      root, initialised, recover, schedule, cancel,
    }), 1_000, schedule, cancel);
  }
}

recoverProfilePublicationsAtStartup();

export function recoverOnboardingAtStartup({
  root = WORKSPACE_ROOT,
  initialised = workspaceInitialised,
  recover = recoverOnboardingActivationAtStartup,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!runtimeRecoveryAdmissionOpen || !initialised()) return null;
  try {
    return recover(root);
  } catch (error) {
    if (!['mutation-busy', 'scan-in-progress'].includes(error?.reasonCode)) throw error;
    scheduleRuntimeRecovery(() => recoverOnboardingAtStartup({
      root, initialised, recover, schedule, cancel,
    }), 1_000, schedule, cancel);
    return null;
  }
}

recoverOnboardingAtStartup();

export function stageSearchProfileReviewAtStartup({
  initialised = workspaceInitialised,
  stage = () => {
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    const readiness = setupReadiness(WORKSPACE_ROOT, config, {}, readTracker());
    if (!(readiness.checks.preferences && readiness.checks.evidence && readiness.checks.approved)) return null;
    return migrateSearchProfile(WORKSPACE_ROOT);
  },
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) {
  if (!runtimeRecoveryAdmissionOpen || !initialised()) return null;
  try {
    return stage();
  } catch (error) {
    if (error?.reasonCode !== 'mutation-busy') throw error;
    scheduleRuntimeRecovery(() => stageSearchProfileReviewAtStartup({
      initialised, stage, schedule, cancel,
    }), 1_000, schedule, cancel);
    return null;
  }
}

stageSearchProfileReviewAtStartup();

function queueCheckpoint(reason, { includeDevicePreferences = false } = {}) {
  const options = includeDevicePreferences && process.platform === 'win32'
    ? { deviceSettings: loadDeviceSettings() }
    : {};
  return queueWorkspaceSync(WORKSPACE_ROOT, reason, options)
    .catch(() => ({
      state: 'needs-attention',
      error: 'Private backup needs attention',
      reasonCode: 'backup-error',
    }));
}

let scheduledCheckpointBatch = null;
const activeCheckpointTasks = new Set();

function executeCheckpointBatch(batch) {
  if (batch.task) return batch.task;
  clearTimeout(batch.timer);
  if (scheduledCheckpointBatch === batch) scheduledCheckpointBatch = null;
  batch.task = queueCheckpoint(batch.reason, {
    includeDevicePreferences: batch.includeDevicePreferences,
  }).finally(() => activeCheckpointTasks.delete(batch.task));
  activeCheckpointTasks.add(batch.task);
  void batch.task.then((result) => {
    for (const resolve of batch.waiters) resolve(result);
  });
  return batch.task;
}

export function scheduleCheckpoint(reason, { includeDevicePreferences = false } = {}) {
  if (!scheduledCheckpointBatch) {
    scheduledCheckpointBatch = {
      reason,
      includeDevicePreferences,
      timer: null,
      waiters: [],
    };
  } else {
    scheduledCheckpointBatch.reason = reason;
    scheduledCheckpointBatch.includeDevicePreferences ||= includeDevicePreferences;
    clearTimeout(scheduledCheckpointBatch.timer);
  }
  const batch = scheduledCheckpointBatch;
  const pending = new Promise((resolve) => batch.waiters.push(resolve));
  batch.timer = setTimeout(() => {
    if (scheduledCheckpointBatch !== batch) return;
    void executeCheckpointBatch(batch);
  }, 1_000);
  batch.timer.unref?.();
  return pending;
}

export async function drainScheduledCheckpoints() {
  while (scheduledCheckpointBatch || activeCheckpointTasks.size) {
    if (scheduledCheckpointBatch) executeCheckpointBatch(scheduledCheckpointBatch);
    await Promise.allSettled([...activeCheckpointTasks]);
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function readTracker() {
  if (!workspaceInitialised()) return { updated: today(), opportunities: [] };
  return JSON.parse(fs.readFileSync(TRACKER, 'utf8'));
}

function readCategories() {
  if (!fs.existsSync(WORKSPACE.categories)) return JOB_CATEGORIES;
  try {
    const parsed = JSON.parse(fs.readFileSync(WORKSPACE.categories, 'utf8'));
    const categories = (parsed.categories || []).map((category) => ({
      id: String(category.id || '').trim().toLowerCase(),
      label: String(category.label || category.id || '').trim(),
      description: String(category.description || '').trim(),
    })).filter((category) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(category.id) && category.label);
    return categories.length ? categories : JOB_CATEGORIES;
  } catch {
    return JOB_CATEGORIES;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function publicApiError(fallback = 'Request could not be completed.', _error = null) {
  return { error: fallback, reasonCode: 'request-failed' };
}

export function publicSetupConfigError(error) {
  if (String(error?.message || '') === 'workspace triage.checkScore cannot exceed actionScore') {
    return {
      error: 'Check score cannot exceed action score.',
      reasonCode: 'invalid-triage-thresholds',
    };
  }
  return publicApiError('Setup settings could not be saved.');
}

export function publicCvImportError(error) {
  const message = String(error?.message || '');
  if (message === 'PDF contains little or no selectable text; scanned PDFs need OCR before import') {
    return {
      error: 'This PDF contains little or no selectable text. Scanned PDFs need OCR before import.',
      reasonCode: 'pdf-needs-ocr',
    };
  }
  if (message.startsWith('PDF could not be read:')) {
    return {
      error: 'PDF could not be read. Export it again or choose another PDF.',
      reasonCode: 'pdf-unreadable',
    };
  }
  return publicApiError('CV import could not be completed.');
}

function sendText(res, status, type, text) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function serveStatic(res, file, type) {
  if (!fs.existsSync(file)) return sendText(res, 404, 'text/plain', 'not built yet');
  const buf = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=300' });
  res.end(buf);
}

function serveUiTemplate(res, name, type) {
  const body = fs.readFileSync(path.join(__dirname, name), 'utf8').replaceAll('__SCOUT_UI_BUILD__', UI_BUILD_ID);
  res.setHeader('Cache-Control', 'no-cache');
  return sendText(res, 200, type, body);
}

function reportDates() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort()
    .reverse();
}

function readScanHealth() {
  const text = fs.existsSync(SCAN_RUNS) ? fs.readFileSync(SCAN_RUNS, 'utf8') : '';
  return {
    ...scanHealthFromText(text, today()),
    storagePressure: readPublicStoragePressure(WORKSPACE_ROOT),
  };
}

function readScanRecords() {
  const text = fs.existsSync(SCAN_RUNS) ? fs.readFileSync(SCAN_RUNS, 'utf8') : '';
  return parseScanRuns(text).runs;
}

function publicLatestScan() {
  const run = readScanRecords().at(-1);
  if (!run) return null;
  const safePublicUrl = (value) => {
    try {
      const url = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      const result = url.toString().replace(/\/$/, '');
      return result.length <= 2048 ? result : null;
    } catch {
      return null;
    }
  };
  const reviewed = Array.isArray(run.reviewed) ? run.reviewed.map((item) => ({
    company: String(item?.company || '').slice(0, 120), role: String(item?.role || '').slice(0, 160),
    source: String(item?.source || '').slice(0, 80),
    sourceUrl: safePublicUrl(item?.sourceUrl),
    categoryId: item?.categoryId ? String(item.categoryId).slice(0, 80) : null,
    outcome: ['kept', 'hard_exclusion', 'mandatory_unmet', 'below_threshold', 'provider_discarded'].includes(item?.outcome) ? item.outcome : 'provider_discarded',
    score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
    reasons: (Array.isArray(item?.reasons) ? item.reasons : []).map((reason) => String(reason).slice(0, 220)).slice(0, 3),
  })).slice(0, 80) : [];
  const boundedContribution = (item) => typeof item === 'string' ? item.slice(0, 100) : ({ code: String(item?.code || '').slice(0, 100), score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null });
  const boundedFunnel = (value) => {
    const names = [
      'sourceRecords', 'sourceErrors', 'failedSourceRecords', 'parsed', 'normalised',
      'duplicateObservations', 'uniqueVacancies', 'deterministicallyExcluded',
      'eligible', 'ranked', 'aboveThreshold', 'selected', 'assessed', 'assessmentFailed',
      'added', 'updated', 'unchanged', 'closed',
    ];
    if (!value || typeof value !== 'object') return null;
    const projected = Object.fromEntries(names.filter((name) => Number.isFinite(Number(value[name])))
      .map((name) => [name, Number(value[name])]));
    if (value.bySource && typeof value.bySource === 'object' && !Array.isArray(value.bySource)) {
      projected.bySource = Object.fromEntries(Object.entries(value.bySource).map(([source, row]) => [
        String(source).slice(0, 80),
        {
          count: Number(row?.count || 0),
          failedRecords: Number(row?.failedRecords || 0),
          sourceErrors: Number(row?.sourceErrors || 0),
          ...Object.fromEntries(names.filter((name) => Number.isFinite(Number(row?.[name])))
            .map((name) => [name, Number(row[name])])),
        },
      ]));
    }
    return projected;
  };
  const boundedSelectionSummary = (value) => value && typeof value === 'object' ? Object.fromEntries(['selected', 'assessed', 'assessmentFailed'].filter((name) => Number.isFinite(Number(value[name]))).map((name) => [name, Number(value[name])])) : null;
  const boundedCoverageRow = (row) => ({
    value: String(row?.value || 'unknown').slice(0, 160),
    ...Object.fromEntries(['found', 'ranked', 'selected', 'excluded', 'assessed', 'assessmentFailed']
      .map((name) => [name, Number(row?.[name] || 0)])),
  });
  const coverage = run.coverage && typeof run.coverage === 'object' ? {
    schemaVersion: Number(run.coverage.schemaVersion || 1),
    ...Object.fromEntries(['source', 'employer', 'lane', 'roleFamily', 'location', 'provider', 'run', 'date']
      .map((name) => [name, (Array.isArray(run.coverage[name]) ? run.coverage[name] : []).map(boundedCoverageRow)])),
    failureReasons: (Array.isArray(run.coverage.failureReasons) ? run.coverage.failureReasons : [])
      .map((row) => ({ value: String(row?.value || 'unknown-failure').slice(0, 100), count: Number(row?.count || 0) })),
  } : null;
  if ((run.explanations || []).length > 10_000) throw new Error('latest scan explanation capacity exceeded');
  const explanations = Array.isArray(run.explanations) ? run.explanations.map((item) => ({
    vacancyId: String(item?.vacancy_id || '').slice(0, 160),
    company: String(item?.company || '').slice(0, 120),
    role: String(item?.role || '').slice(0, 160),
    dimensions: {
      source: String(item?.dimensions?.source || item?.source || '').slice(0, 80),
      employer: String(item?.dimensions?.employer || '').slice(0, 120),
      lane: String(item?.dimensions?.lane || '').slice(0, 120),
      roleFamily: String(item?.dimensions?.role_family || '').slice(0, 120),
      location: String(item?.dimensions?.location || '').slice(0, 120),
    },
    stages: {
      found: Boolean(item?.stages?.found),
      ranked: Boolean(item?.stages?.ranked),
      selected: Boolean(item?.stages?.selected),
      excluded: Boolean(item?.stages?.excluded),
      assessed: Boolean(item?.stages?.assessed),
    },
    aboveThreshold: Boolean(item?.above_threshold),
    preRank: { score: Number.isFinite(Number(item?.pre_rank?.score)) ? Number(item.pre_rank.score) : null,
      positive: (Array.isArray(item?.pre_rank?.positive) ? item.pre_rank.positive : []).slice(0, 3).map(boundedContribution), negative: (Array.isArray(item?.pre_rank?.negative) ? item.pre_rank.negative : []).slice(0, 3).map(boundedContribution) },
    reasonCode: item?.reason_code ? String(item.reason_code).slice(0, 100) : 'unknown',
    selectionReason: item?.selection_reason ? String(item.selection_reason).slice(0, 100) : null,
    deterministicExclusion: item?.deterministic_exclusion ? String(item.deterministic_exclusion).slice(0, 100) : null,
    deterministicExclusions: (Array.isArray(item?.deterministic_exclusions) ? item.deterministic_exclusions : [])
      .map((value) => String(value).slice(0, 100)).slice(0, 8),
    assessmentStatus: ['assessed', 'assessment-failed', 'not-selected'].includes(item?.assessment_status) ? item.assessment_status : 'not-selected',
    outcome: item?.outcome ? String(item.outcome).slice(0, 100) : null,
    source: String(item?.source || '').slice(0, 80), sourceUrl: safePublicUrl(item?.sourceUrl),
  })) : [];
  return {
    schemaVersion: Number(run.schemaVersion || 1), runAt: run.timestamp || null,
    provider: run.agent || null, mode: run.mode || null, degraded: Boolean(run.degraded),
    candidatesFound: Number(run.candidates_found || 0), keepersAdded: Number(run.keepers_added || 0),
    keepersUpdated: Number(run.keepers_updated || 0), discarded: run.discarded || {},
    sourceHealth: run.source_health || {}, reportDate: String(run.timestamp || '').slice(0, 10) || null,
    profileId: run.profile_id ? String(run.profile_id).slice(0, 80) : null,
    discoveryEngine: run.discovery_engine ? String(run.discovery_engine).slice(0, 80) : null,
    funnel: boundedFunnel(run.funnel), selectionSummary: boundedSelectionSummary(run.selection_summary),
    coverage, explanations,
    automaticBroadened: run.mode === 'broadened', reviewed,
  };
}

function readScheduleSummary(config = loadWorkspaceConfig(WORKSPACE_ROOT), health = readScanHealth()) {
  const records = fs.existsSync(SCAN_RUNS)
    ? fs.readFileSync(SCAN_RUNS, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean)
    : [];
  const runs = Object.fromEntries((config.schedule?.jobs || []).map((job) => {
    const record = records.findLast((item) => item.agent === job.provider && item.mode === job.mode);
    return [job.id, {
      lastRunAt: record?.timestamp || null,
      lastResult: !record ? 'never' : record.degraded ? 'degraded' : 'healthy',
    }];
  }));
  return scheduleSummary(config, { ...health, runs }, (config.schedule?.jobs || []).map((job) => scheduleStatus({ id: job.id })));
}

// Task 5 assigns handlers into this table: routes['POST /api/status'] = (req,res,body)=>{...}
export const routes = {};

function loopbackHost(hostHeader) {
  try {
    const hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function loopbackSocket(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

const LOCAL_ONLY_ROUTES = new Set([
  'POST /api/workspace/create',
  'POST /api/workspace/restore',
  'POST /api/device/settings',
  'POST /api/update/download',
  'POST /api/setup/section',
  'POST /api/setup/recovery',
  'POST /api/remote-access/enable',
  'POST /api/remote-access/disable',
  'POST /api/shutdown',
  'POST /api/workspace/adopt-private',
  'POST /api/sync/connect',
  'POST /api/sync/deploy-key',
  'POST /api/sync/disable',
  'POST /api/sync/recovery-key',
  'POST /api/sync/recovery-key/confirm',
  'POST /api/sync/passphrase',
]);

const REMOTE_MUTATION_WITHOUT_BACKUP = new Set([
  'POST /api/sync/backup',
  'POST /api/sync/retry',
  'POST /api/update/check',
  'POST /api/restart',
  'POST /api/provider-login/start',
  'POST /api/provider-login/code',
  'POST /api/provider-login/cancel',
  'POST /api/provider-login/retry',
  'POST /api/provider-login/clear-claude-credentials',
]);

function applySecurityHeaders(res, url) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (url.pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
}

function sameOrigin(origin, expected, protocol) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === protocol && parsed.origin.toLowerCase() === expected.toLowerCase();
  } catch { return false; }
}

export function requestAccess(req, url, settings = loadDeviceSettings()) {
  const host = String(req.headers.host || '');
  if (!loopbackSocket(req.socket?.remoteAddress)) return { ok: false, error: 'loopback proxy required' };

  let access;
  let expectedOrigin;
  let protocol;
  if (loopbackHost(host)) {
    access = 'local';
    expectedOrigin = `http://${host}`;
    protocol = 'http:';
  } else {
    const remote = settings.remoteAccess || {};
    let configured;
    try { configured = new URL(remote.origin || ''); } catch { configured = null; }
    if (!remote.enabled || !configured || configured.host.toLowerCase() !== host.toLowerCase()) {
      return { ok: false, error: 'private remote access is not enabled for this address' };
    }
    const login = String(req.headers['tailscale-user-login'] || '').trim();
    if (!login || login.toLowerCase() !== String(remote.ownerLogin || '').trim().toLowerCase()) {
      return { ok: false, error: 'configured Tailscale owner identity required' };
    }
    access = 'remote-owner';
    expectedOrigin = configured.origin;
    protocol = 'https:';
  }

  const mutatingApi = url.pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method);
  if (mutatingApi && LOCAL_ONLY_ROUTES.has(`${req.method} ${url.pathname}`) && access !== 'local') {
    return { ok: false, error: 'this setting can only be changed on the Scout host' };
  }

  const origin = req.headers.origin;
  const providerLoginMutation = mutatingApi && url.pathname.startsWith('/api/provider-login/');
  if ((origin && !sameOrigin(origin, expectedOrigin, protocol))
      || (mutatingApi && (access === 'remote-owner' || providerLoginMutation) && !origin)) {
    return { ok: false, error: 'same-origin request required' };
  }

  const requiresJson = url.pathname.startsWith('/api/chat/')
    || url.pathname.startsWith('/api/search-profile')
    || url.pathname.startsWith('/api/sync/')
    || url.pathname.startsWith('/api/workspace/')
    || url.pathname.startsWith('/api/remote-access/')
    || url.pathname.startsWith('/api/provider-login/')
    || ['POST /api/restart', 'POST /api/setup/proposal', 'POST /api/setup/activate', 'POST /api/setup/recovery'].includes(`${req.method} ${url.pathname}`);
  if (mutatingApi && requiresJson) {
    const mediaType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return { ok: false, status: 415, error: 'application/json required' };
    }
  }
  if (mutatingApi && access === 'remote-owner'
      && !REMOTE_MUTATION_WITHOUT_BACKUP.has(`${req.method} ${url.pathname}`)
      && !loadSyncSettings(WORKSPACE_ROOT).enabled) {
    return {
      ok: false,
      status: 409,
      error: 'Encrypted private backup must be enabled on the Scout host before remote changes are allowed',
    };
  }
  return { ok: true, access };
}

function guardRequest(req, res, url) {
  applySecurityHeaders(res, url);
  const result = requestAccess(req, url);
  if (!result.ok) {
    sendJson(res, result.status || 403, { error: result.error });
    return false;
  }
  req.scoutAccess = result.access;
  if (result.access === 'remote-owner') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  return true;
}

function publicRemoteStatus(value) {
  return {
    state: value.state,
    enabled: Boolean(value.enabled),
    installed: Boolean(value.detected?.installed),
    version: value.detected?.version || null,
    ownerLogin: value.ownerLogin || value.identity?.ownerLogin || null,
    deviceName: value.identity?.dnsName || null,
    origin: value.origin || null,
    httpsPort: value.httpsPort || null,
    blocker: value.blocker || null,
    authorizationUrl: value.authorizationUrl || null,
    suggestedPort: value.suggestedPort || null,
    customPortRequired: Boolean(value.customPortRequired),
  };
}

export function publicDeviceSettings(settings, startupStatus = {}) {
  return {
    schemaVersion: Number(settings?.schemaVersion) || 3,
    startWithWindows: Boolean(settings?.startWithWindows),
    startup: {
      mechanism: settings?.startup?.mechanism === 'task-scheduler' ? 'task-scheduler' : null,
      verifiedAt: publicIsoTimestamp(settings?.startup?.verifiedAt),
    },
    updates: {
      policy: settings?.updates?.policy === 'download' ? 'download' : 'notify',
      downloaded: publicDownloadedUpdate(settings?.updates?.downloaded),
      downloadError: settings?.updates?.downloadError ? 'Update download could not be completed.' : null,
    },
    startupStatus: {
      supported: Boolean(startupStatus?.supported),
      enabled: Boolean(startupStatus?.enabled),
      mechanism: startupStatus?.mechanism === 'task-scheduler' ? 'task-scheduler' : null,
    },
  };
}

function currentDeviceSettings() {
  const settings = loadDeviceSettings();
  const startupStatus = process.platform === 'win32'
    ? windowsStartupStatus()
    : { supported: false, enabled: false, mechanism: null };
  return publicDeviceSettings(settings, startupStatus);
}

export const providerDetection = { detect: detectProvidersAsync };

const PUBLIC_PROVIDER_HEALTH_STATES = new Set(Object.values(PROVIDER_HEALTH_STATES));

export function publicProviderStatus(value, health = null) {
  const healthStateIsValid = health === null || PUBLIC_PROVIDER_HEALTH_STATES.has(health?.state);
  const healthState = health === null ? null
    : healthStateIsValid ? health.state : PROVIDER_HEALTH_STATES.PROVIDER_ERROR;
  const authenticationBlocked = !healthStateIsValid
    || health?.remoteAuthBarrier === true
    || healthState === PROVIDER_HEALTH_STATES.SIGN_IN_REQUIRED;
  return {
    installed: value?.installed === true,
    authenticated: value?.authenticated === true && !authenticationBlocked,
    capabilities: {
      structuredOutput: value?.capabilities?.structuredOutput === true,
    },
    ...(healthState === null ? {} : { healthState }),
  };
}

function publicProviderStatuses(values, root) {
  return Object.fromEntries(
    ['codex', 'claude']
      .filter((provider) => values?.[provider])
      .map((provider) => {
        let health;
        try {
          health = readProviderHealth(root, provider);
        } catch {
          health = {
            state: PROVIDER_HEALTH_STATES.PROVIDER_ERROR,
            remoteAuthBarrier: true,
          };
        }
        return [provider, publicProviderStatus(values[provider], health)];
      }),
  );
}

const PROVIDER_LOGIN_OWNER_ID = randomUUID();
const providerLoginCsrfTokens = new Map();
const providerLoginWorkingDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'scout-provider-login-'),
);
fs.chmodSync(providerLoginWorkingDirectory, 0o700);

export function confirmProviderLoginHealth(provider, status, {
  runStructuredTurnFn = runStructuredTurn,
} = {}) {
  const turn = runStructuredTurnFn({
      provider,
      status,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ready'],
        properties: { ready: { const: true } },
      },
      prompt: 'Perform the fixed provider health check. Respond only with {"ready":true}.',
      timeoutMs: 60_000,
      maxInputTokens: 256,
      maxOutputBytes: 32 * 1024,
      maxOutputLines: 128,
      maxLineBytes: 2 * 1024,
      validate(value) {
        if (!value || value.ready !== true || Object.keys(value).join(',') !== 'ready') {
          throw new Error('provider health confirmation is invalid');
        }
        return value;
      },
  });
  const result = Promise.resolve(turn).then(
    () => ({ kind: 'remote-success', source: 'post-auth' }),
    (error) => {
      const kind = {
        'authentication-required': 'remote-auth-failure',
        'network-unavailable': 'network-failure',
        'rate-limited': 'rate-limit',
        'cli-update-required': 'cli-update',
      }[error?.reasonCode] || 'provider-failure';
      return { kind, source: 'post-auth' };
    },
  );
  Object.defineProperties(result, {
    stop: { value: () => turn?.stop?.() },
    closed: { value: turn?.closed || result.then(() => undefined) },
  });
  return result;
}

const runtimeProviderLoginManager = createProviderLoginManager({
  cwd: providerLoginWorkingDirectory,
  providerStatus: async (provider) => (await providerDetection.detect())[provider],
  confirmProviderHealth: confirmProviderLoginHealth,
  canClearClaudeCredentials: ({ status }) => {
    const current = readProviderHealth(WORKSPACE_ROOT, 'claude');
    if (current.state !== 'sign-in-required'
      || current.reasonCode !== 'authentication-required') {
      return Promise.resolve(false);
    }
    const confirmation = confirmProviderLoginHealth('claude', status);
    const result = Promise.resolve(confirmation)
      .then((signal) => signal.kind === 'remote-auth-failure');
    Object.defineProperties(result, {
      stop: { value: () => confirmation?.stop?.() },
      closed: { value: confirmation?.closed || result.then(() => undefined) },
    });
    return result;
  },
  onHealthSignal: async (provider, signal) => providerPreflight(
    WORKSPACE_ROOT,
    provider,
    signal.kind === 'remote-success' ? 'post-auth' : 'post-auth-failure',
    {
      source: 'post-auth',
      probe: async () => signal,
    },
  ),
  acquireAuthMutation: async (provider, phase) => acquireProviderAuthMutation(
    WORKSPACE_ROOT,
    provider,
    { phase, owner: currentLeaseOwner() },
  ),
  renewAuthMutation: async (capability) => renewProviderAuthMutation(
    WORKSPACE_ROOT,
    capability,
  ),
  releaseAuthMutation: async (capability) => releaseProviderAuthMutation(
    WORKSPACE_ROOT,
    capability,
  ),
});

export const providerLoginControl = {
  manager: runtimeProviderLoginManager,
  async shutdown() {
    try {
      await this.manager.shutdown();
    } catch (error) {
      // The production manager enters a terminal shutdown state before it
      // waits for children. If that wait fails, reopening provider routes
      // would expose a manager that cannot accept work.
      if (this.manager === runtimeProviderLoginManager) {
        error.runtimeAdmissionMayResume = false;
      }
      throw error;
    }
    fs.rmSync(providerLoginWorkingDirectory, { recursive: true, force: true });
  },
};

async function runFixedCapabilityCommand(command, args, {
  timeoutMs = 2_500,
  maxOutputBytes = 16 * 1024,
} = {}) {
  const result = await runProviderCommand(command, args, {
    shell: false,
    windowsHide: true,
    timeoutMs,
    maxOutputBytes,
  });
  return {
    status: result.status,
    failed: Boolean(result.error),
    timedOut: result.timedOut,
    exceeded: result.outputExceeded,
    stdout: result.stdout,
  };
}

export async function inspectCodexDeepLinkHandler({
  platform = process.platform,
  run = runFixedCapabilityCommand,
} = {}) {
  if (platform === 'darwin') {
    const result = await run('/usr/bin/defaults', [
      'read',
      'com.apple.LaunchServices/com.apple.launchservices.secure',
      'LSHandlers',
    ]);
    if (result.failed || result.timedOut || result.exceeded) return { failed: true };
    if (result.status !== 0) return { registered: false };
    return {
      registered: /LSHandlerURLScheme\s*=\s*"?codex"?\s*;/i.test(String(result.stdout || '')),
    };
  }
  if (platform === 'win32') {
    const keys = [
      'HKCU\\Software\\Classes\\codex\\shell\\open\\command',
      'HKCR\\codex\\shell\\open\\command',
    ];
    for (const key of keys) {
      const result = await run('reg.exe', ['query', key, '/ve']);
      if (result.failed || result.timedOut || result.exceeded) return { failed: true };
      if (result.status === 0) return { registered: true };
    }
    return { registered: false };
  }
  return { registered: false };
}

export const codexDeepLinkDetection = { inspect: inspectCodexDeepLinkHandler };

async function handleRead(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/') {
    return serveUiTemplate(res, 'index.html', 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/app.js') {
    return serveUiTemplate(res, 'app.js', 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/reportView.js') {
    return serveStatic(res, path.join(__dirname, 'reportView.js'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/setup.js') {
    return serveStatic(res, path.join(__dirname, 'setup.js'), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
    return serveUiTemplate(res, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/service-worker.js') {
    return serveUiTemplate(res, 'service-worker.js', 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname.startsWith('/lib/')) {
    const name = url.pathname.slice('/lib/'.length);
    if (!/^[a-zA-Z0-9.-]+\.mjs$/.test(name)) return sendJson(res, 400, { error: 'bad module path' });
    return serveStatic(res, path.join(__dirname, 'lib', name), 'text/javascript; charset=utf-8');
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    return serveStatic(res, path.join(__dirname, 'assets', 'scout-icon.ico'), 'image/x-icon');
  }
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const name = url.pathname.slice('/assets/'.length);
    if (!/^[a-zA-Z0-9.-]+\.(?:png|webp|ico)$/.test(name)) return sendJson(res, 400, { error: 'bad asset path' });
    const type = name.endsWith('.webp') ? 'image/webp' : name.endsWith('.ico') ? 'image/x-icon' : 'image/png';
    const requested = path.join(__dirname, 'assets', name);
    const fallback = path.join(__dirname, 'assets', 'scout-icon.png');
    return serveStatic(res, fs.existsSync(requested) ? requested : fallback, type);
  }
  if (req.method === 'GET' && url.pathname === '/api/operations') {
    const type = url.searchParams.get('type');
    if (type && !['proposal', 'scan', 'cv-render'].includes(type)) return sendJson(res, 400, { error: 'operation type must be proposal, scan or cv-render' });
    return sendJson(res, 200, { operation: operations.latest(type), operations: operations.list(type) });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/operations/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/operations/'.length));
    const operation = operations.get(id);
    return operation ? sendJson(res, 200, { operation }) : sendJson(res, 404, { error: 'operation not found' });
  }
  if (req.method === 'GET' && url.pathname === '/api/setup/status') {
    if (!workspaceInitialised()) {
      const config = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'templates', 'workspace', 'workspace.json'), 'utf8'));
      const env = loadEnv(WORKSPACE_ROOT);
      return sendJson(res, 200, {
        bootstrap: true,
        workspaceRoot: WORKSPACE_ROOT,
        appRoot: APP_ROOT,
        appVersion: APP_VERSION,
        platform: process.platform,
        config,
        providers: {},
        adzunaConfigured: !!(env.ADZUNA_APP_ID && env.ADZUNA_API_KEY),
        trackerExists: false,
        established: false,
        ready: false,
        searchProfilePublished: false,
        setupComplete: false,
        readiness: {},
        scanHealth: { healthy: false, lastRunAt: null },
        schedule: { enabled: false, configured: false, lastResult: 'never' },
        doctor: publicDoctor({ ok: false, providerSetupRequired: true, checks: {} }),
        device: currentDeviceSettings(),
        remoteAccess: publicRemoteStatus(remoteAccessStatus(loadDeviceSettings())),
        requestAccess: req.scoutAccess,
        git: detectGit(),
        sync: syncStatus(WORKSPACE_ROOT),
        recovery: { available: false, file: 'cv/master-cv.md', reason: 'workspace is not initialised' },
        pendingSetupSections: [],
      });
    }
    stageSearchProfileReviewAtStartup();
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    const providers = await providerDetection.detect();
    const providerStatuses = publicProviderStatuses(providers, WORKSPACE_ROOT);
    const env = loadEnv(WORKSPACE_ROOT);
    const readiness = setupReadiness(WORKSPACE_ROOT, config, providerStatuses, readTracker());
    return sendJson(res, 200, {
      workspaceRoot: WORKSPACE_ROOT,
      appRoot: APP_ROOT,
      appVersion: APP_VERSION,
      platform: process.platform,
      config,
      providers: providerStatuses,
      adzunaConfigured: !!(env.ADZUNA_APP_ID && env.ADZUNA_API_KEY),
      trackerExists: fs.existsSync(TRACKER),
      established: readiness.established,
      ready: readiness.ready,
      searchProfilePublished: Boolean(loadPublishedSearchProfile(WORKSPACE_ROOT)),
      setupComplete: Boolean(config.setup?.completedAt),
      readiness: readiness.checks,
      scanHealth: readScanHealth(),
      schedule: readScheduleSummary(config),
      doctor: publicDoctor(doctor(WORKSPACE_ROOT, { appRoot: APP_ROOT, providers })),
      git: detectGit(),
      sync: syncStatus(WORKSPACE_ROOT),
      device: currentDeviceSettings(),
      remoteAccess: publicRemoteStatus(remoteAccessStatus(loadDeviceSettings())),
      requestAccess: req.scoutAccess,
      pendingSetupSections: [...pendingWorkspaceSections(readiness.established ? { ...config.setup, completedAt: config.setup?.completedAt || 'legacy' } : config.setup), ...pendingDeviceSections(loadDeviceSettings())],
      recovery: activatedProposalRecovery(WORKSPACE_ROOT),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/setup/proposal') {
    try { return sendJson(res, 200, { proposal: readOnboardingProposal(WORKSPACE_ROOT) }); }
    catch { return sendJson(res, 400, publicApiError('Setup proposal could not be read.')); }
  }
  if (req.method === 'GET' && url.pathname === '/api/search-profile') {
    try { return sendJson(res, 200, readSearchProfileState()); }
    catch { return sendJson(res, 400, publicApiError('Search profile could not be read.')); }
  }
  if (req.method === 'GET' && url.pathname === '/api/app-info') {
    return sendJson(res, 200, {
      name: 'Scout', version: APP_VERSION, uiBuildId: UI_BUILD_ID, appRoot: APP_ROOT, workspaceRoot: WORKSPACE_ROOT,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/device/codex-deep-link') {
    const checkedAt = new Date().toISOString();
    if (req.scoutAccess !== 'local') {
      return sendJson(res, 200, codexDeepLinkCapability({
        requestAccess: req.scoutAccess,
        platform: process.platform,
        handler: null,
        checkedAt,
      }));
    }
    let handler;
    try { handler = await codexDeepLinkDetection.inspect(); }
    catch { handler = { failed: true }; }
    return sendJson(res, 200, codexDeepLinkCapability({
      requestAccess: req.scoutAccess,
      platform: process.platform,
      handler,
      checkedAt,
    }));
  }
  if (req.method === 'GET' && url.pathname === '/api/remote-access/status') {
    return sendJson(res, 200, {
      ...publicRemoteStatus(remoteAccessStatus(loadDeviceSettings())), requestAccess: req.scoutAccess,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/opportunities') {
    if (!workspaceInitialised()) return sendJson(res, 200, {
      ...emptyTrackerView(today()),
      scanHealth: { healthy: false, lastRunAt: null },
      schedule: { enabled: false, configured: false }, categories: JOB_CATEGORIES,
      workspaceConfig: null, bootstrap: true, trackerRevision: null,
    });
    const snapshot = readTrackerSnapshot(TRACKER);
    const data = snapshot.data;
    const todayValue = today();
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    return sendJson(res, 200, {
      ...data,
      triage: triage(data, todayValue, config.triage),
      pipeline: pipeline(data, todayValue, config.triage),
      scanHealth: readScanHealth(),
      schedule: readScheduleSummary(config),
      categories: readCategories(),
      workspaceConfig: config,
      trackerRevision: snapshot.revision,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/pipeline') {
    const data = readTracker();
    return sendJson(res, 200, pipeline(data, today(), loadWorkspaceConfig(WORKSPACE_ROOT).triage));
  }
  if (req.method === 'GET' && url.pathname === '/api/scan-health') {
    return sendJson(res, 200, readScanHealth());
  }
  if (req.method === 'GET' && url.pathname === '/api/scan/runs') {
    try { return sendJson(res, 200, readPublicRunSummaries(WORKSPACE_ROOT, { lease: readScanLease(WORKSPACE_ROOT) })); }
    catch { return sendJson(res, 503, { error: 'durable scan state needs attention' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/scan/queue') {
    try { return sendJson(res, 200, readPublicScanQueue(WORKSPACE_ROOT)); }
    catch { return sendJson(res, 503, { error: 'durable scan queue needs attention' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/scans/latest') {
    return sendJson(res, 200, { scan: publicLatestScan() });
  }
  if (req.method === 'GET' && url.pathname === '/api/sync/status') {
    return sendJson(res, 200, syncStatus(WORKSPACE_ROOT));
  }
  if (req.method === 'GET' && url.pathname === '/api/ats-portals') {
    return sendJson(res, 200, { portals: portalSummary(loadPortals(WORKSPACE_ROOT)) });
  }
  if (req.method === 'GET' && url.pathname === '/api/employers') {
    try { return sendJson(res, 200, publicEmployerRegistry(currentEmployerRegistry())); }
    catch { return sendJson(res, 400, publicApiError('Employer registry could not be loaded.')); }
  }
  if (req.method === 'GET' && url.pathname === '/api/reports') {
    return sendJson(res, 200, { reports: reportDates() });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/reports/')) {
    const date = url.pathname.slice('/api/reports/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'bad date' });
    const file = path.join(REPORTS_DIR, `${date}.md`);
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'no report' });
    return sendText(res, 200, 'text/markdown; charset=utf-8', fs.readFileSync(file, 'utf8'));
  }
  if (req.method === 'GET' && url.pathname === '/api/cv') {
    return sendJson(res, 200, listCvFiles(WORKSPACE_ROOT));
  }
  if (req.method === 'GET' && url.pathname === '/api/cv/file') {
    try {
      const abs = safeCvPath(WORKSPACE_ROOT, url.searchParams.get('path'));
      if (!fs.existsSync(abs)) return sendJson(res, 404, { error: 'no such file' });
      return sendText(res, 200, 'text/plain; charset=utf-8', fs.readFileSync(abs, 'utf8'));
    } catch { return sendJson(res, 400, publicApiError('CV file request is invalid.')); }
  }
  if (req.method === 'GET' && url.pathname === '/api/cv/quality') {
    try { return sendJson(res, 200, readCvQuality(WORKSPACE_ROOT, url.searchParams.get('slug') || '')); }
    catch { return sendJson(res, 400, publicApiError('CV quality record could not be read.')); }
  }
  if (req.method === 'GET' && url.pathname === '/api/cv/pdf') {
    const target = url.searchParams.get('target') === 'master' ? 'master' : 'application';
    const slug = url.searchParams.get('slug') || '';
    let pdf;
    try { pdf = cvPdfPath(WORKSPACE_ROOT, { target, slug }); }
    catch (e) { return sendJson(res, /(stale|record lost)/i.test(e.message) ? 409 : 404, publicApiError('CV PDF is stale or unavailable.')); }
    if (target === 'application' && url.searchParams.get('download') === '1') {
      let decision;
      try { decision = cvDownloadDecision(WORKSPACE_ROOT, slug); }
      catch { return sendJson(res, 400, publicApiError('CV download could not be validated.')); }
      if (!decision.allowed) return sendJson(res, 409, decision);
    }
    const buf = fs.readFileSync(pdf);
    const headers = { 'Content-Type': 'application/pdf', 'Content-Length': buf.length };
    if (url.searchParams.get('download') === '1') headers['Content-Disposition'] = `attachment; filename="${target === 'master' ? 'master-cv-reference' : `${slug}-cv`}.pdf"`;
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.writeHead(200, headers);
    return res.end(buf);
  }
  if (req.method === 'GET' && url.pathname === '/api/source') {
    handleSource(res, url.searchParams.get('id') || '');
    return true; // async handler owns the response
  }
  return null; // not a read route
}

const sourceCache = new SourceCache();

async function handleSource(res, id) {
  let entry;
  try {
    entry = (readTracker().opportunities || []).find((o) => o.id === id);
  } catch {
    return sendJson(res, 500, publicApiError('Tracker could not be read.'));
  }
  if (!entry) return sendJson(res, 404, { error: 'no such opportunity' });
  const target = sourceUrlOf(entry);
  if (!target) return sendJson(res, 404, { error: 'no usable source url' });
  const cached = sourceCache.get(id);
  if (cached) return sendJson(res, 200, cached);
  let html;
  try {
    const r = await fetchPublicResource(target, {
      timeoutMs: 10000,
      maxBytes: 1_000_000,
      maxRedirects: 4,
      allowedContentTypes: ['text/html', 'application/xhtml+xml', 'application/xml', 'text/plain'],
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!r.ok) return sendJson(res, 502, { ok: false, error: `source returned ${r.status}` });
    html = await r.text();
  } catch (e) {
    return sendJson(res, 502, {
      ok: false,
      ...(e instanceof PublicHttpError && e.reasonCode === 'request-timeout'
        ? { error: 'Source request timed out.', reasonCode: 'source-timeout' }
        : {
          error: 'Source could not be fetched.',
          reasonCode: e instanceof PublicHttpError ? e.reasonCode : 'source-fetch-failed',
        }),
    });
  }
  const payload = buildSourcePayload(html, target, new Date().toISOString());
  sourceCache.set(id, payload);
  return sendJson(res, 200, payload);
}

export function createServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (!runtimeRequestAdmissionOpen) {
      return sendJson(res, 503, { error: 'Scout is shutting down. Try again shortly.' });
    }
    if (!guardRequest(req, res, url)) return;
    const routeKey = `${req.method} ${url.pathname}`;
    if (routes[routeKey]) {
      const finishHandler = createRuntimeHttpHandlerBarrier();
      const limit = url.pathname === '/api/setup/import-cv'
        ? 14 * 1024 * 1024
        : url.pathname.startsWith('/api/provider-login/')
          ? 4 * 1024
          : 1e6;
      const body = new BoundedUtf8Body(limit);
      let bodyFailed = false;
      req.on('data', (chunk) => {
        if (bodyFailed) return;
        const result = body.append(chunk);
        if (result.ok) return;
        bodyFailed = true;
        replyJson(res, result.reason === 'too-large' ? 413 : 400, {
          error: result.reason === 'too-large' ? 'request body too large' : 'request body is not valid UTF-8',
        });
        finishHandler();
      });
      req.once('aborted', finishHandler);
      req.on('end', () => {
        if (bodyFailed) return;
        const decoded = body.finish();
        if (!decoded.ok) {
          replyJson(res, 400, { error: 'request body is not valid UTF-8' });
          finishHandler();
          return;
        }
        void trackRuntimeHttpHandler(Promise.resolve(routes[routeKey](req, res, decoded.text, url))
          .catch(() => { if (!res.writableEnded) replyJson(res, 500, publicApiError()); })
          .finally(finishHandler));
      });
      return;
    }
    void trackRuntimeHttpHandler(handleRead(req, res, url)
      .then((handled) => { if (handled === null && !res.writableEnded) sendJson(res, 404, { error: 'not found' }); })
      .catch(() => { if (!res.writableEnded) sendJson(res, 500, publicApiError()); }));
  });
  server.once('close', () => { void providerLoginControl.shutdown().catch(() => {}); });
  return server;
}

export async function closeServerSafely(server, { drain = drainRuntimeWork } = {}) {
  closeRuntimeAdmission();
  try {
    await drain();
  } catch (error) {
    recoverRuntimeAdmissionAfterFailedDrain(error);
    throw error;
  }
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// --- Mutation wiring (Task 5) ---
import {
  setStatus, addNote, logEvent, addContact, editContact, serializeTracker, findEntry,
  markApplied, markRejected, addApplicationStage, completeApplicationStage,
  setCategory, setCommute,
} from './lib/tracker.mjs';
import { renderCv } from './lib/cv.mjs';

const TRACKER_FILE = TRACKER;

function replyJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

function parseBody(body) {
  try { return JSON.parse(body || '{}'); } catch { return null; }
}

function exactJsonBody(body, keys) {
  const value = parseBody(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    return null;
  }
  return value;
}

function providerLoginCsrfToken(access) {
  if (!providerLoginCsrfTokens.has(access)) {
    providerLoginCsrfTokens.set(access, randomUUID().replaceAll('-', ''));
  }
  return providerLoginCsrfTokens.get(access);
}

function providerLoginOwnerContext(req, csrfVerified) {
  return {
    ownerId: PROVIDER_LOGIN_OWNER_ID,
    access: req.scoutAccess,
    originVerified: true,
    csrfVerified,
  };
}

function providerLoginCsrfVerified(req) {
  const supplied = String(req.headers['x-scout-provider-login-csrf'] || '');
  const expected = providerLoginCsrfToken(req.scoutAccess);
  return supplied.length === expected.length && supplied === expected;
}

function replyProviderLoginError(res, error) {
  const code = String(error?.code || '');
  if (code === 'LOGIN_SESSION_UNAVAILABLE') {
    return replyJson(res, 404, { error: 'provider login session is unavailable' });
  }
  if (code.includes('RATE_LIMIT')) {
    return replyJson(res, 429, { error: 'provider login rate limit reached; wait before retrying' });
  }
  if ([
    'CLAUDE_CREDENTIAL_CLEAR_NOT_ALLOWED',
    'LOGIN_ALREADY_ACTIVE',
    'LOGIN_CODE_NOT_EXPECTED',
    'LOGIN_RETRY_NOT_ALLOWED',
    'LOGIN_RETRY_REPLAYED',
    'LOGIN_SESSION_TERMINAL',
  ].includes(code)) {
    return replyJson(res, 409, { error: 'provider login state changed; refresh its status and retry' });
  }
  if (code === 'LOGIN_SHUTDOWN') {
    return replyJson(res, 503, { error: 'provider login is unavailable while Scout is shutting down' });
  }
  return replyJson(res, 400, { error: 'provider login request was rejected' });
}

function requireProviderLoginCsrf(req, res) {
  if (providerLoginCsrfVerified(req)) return true;
  replyJson(res, 403, { error: 'provider login CSRF token required' });
  return false;
}

routes['GET /api/provider-login/status'] = (req, res, _body, url) => {
  const provider = url.searchParams.get('provider');
  if (!['codex', 'claude'].includes(provider)) {
    return replyJson(res, 400, { error: 'supported provider required' });
  }
  try {
    const owner = providerLoginOwnerContext(req, true);
    const sessionId = url.searchParams.get('sessionId');
    const session = sessionId
      ? providerLoginControl.manager.getProviderLoginSession(sessionId, owner)
      : providerLoginControl.manager.getActiveProviderLogin(provider, owner);
    if (session && session.provider !== provider) {
      return replyJson(res, 404, { error: 'provider login session is unavailable' });
    }
    return replyJson(res, 200, {
      provider,
      session,
      csrfToken: providerLoginCsrfToken(req.scoutAccess),
    });
  } catch (error) {
    return replyProviderLoginError(res, error);
  }
};

routes['POST /api/provider-login/start'] = async (req, res, body) => {
  if (!requireProviderLoginCsrf(req, res)) return;
  const value = exactJsonBody(body, ['provider']);
  if (!value || !['codex', 'claude'].includes(value.provider)) {
    return replyJson(res, 400, { error: 'supported provider required' });
  }
  try {
    const session = await providerLoginControl.manager.startProviderLogin(
      value.provider,
      providerLoginOwnerContext(req, true),
    );
    return replyJson(res, 202, { session });
  } catch (error) {
    return replyProviderLoginError(res, error);
  }
};

routes['POST /api/provider-login/code'] = async (req, res, body) => {
  if (!requireProviderLoginCsrf(req, res)) return;
  const value = exactJsonBody(body, ['code', 'sessionId']);
  if (!value) return replyJson(res, 400, { error: 'session and code are required' });
  try {
    const session = await providerLoginControl.manager.submitProviderLoginCode(
      value.sessionId,
      value.code,
      providerLoginOwnerContext(req, true),
    );
    return replyJson(res, 200, { session });
  } catch (error) {
    return replyProviderLoginError(res, error);
  }
};

routes['POST /api/provider-login/cancel'] = async (req, res, body) => {
  if (!requireProviderLoginCsrf(req, res)) return;
  const value = exactJsonBody(body, ['sessionId']);
  if (!value) return replyJson(res, 400, { error: 'session is required' });
  try {
    const session = await providerLoginControl.manager.cancelProviderLogin(
      value.sessionId,
      providerLoginOwnerContext(req, true),
    );
    return replyJson(res, 200, { session });
  } catch (error) {
    return replyProviderLoginError(res, error);
  }
};

routes['POST /api/provider-login/retry'] = async (req, res, body) => {
  if (!requireProviderLoginCsrf(req, res)) return;
  const value = exactJsonBody(body, ['provider', 'sessionId']);
  if (!value || !['codex', 'claude'].includes(value.provider)) {
    return replyJson(res, 400, { error: 'supported provider and session are required' });
  }
  const owner = providerLoginOwnerContext(req, true);
  try {
    const session = await providerLoginControl.manager.retryProviderLogin(
      value.provider,
      value.sessionId,
      owner,
    );
    return replyJson(res, 202, { session });
  } catch (error) {
    return replyProviderLoginError(res, error);
  }
};

routes['POST /api/provider-login/clear-claude-credentials'] = async (req, res, body) => {
  if (!requireProviderLoginCsrf(req, res)) return;
  const value = exactJsonBody(body, ['confirmed', 'sessionId']);
  if (!value || value.confirmed !== true) {
    return replyJson(res, 409, { error: 'explicit confirmation is required' });
  }
  try {
    const result = await providerLoginControl.manager.clearClaudeCredentials(
      value.sessionId,
      providerLoginOwnerContext(req, true),
    );
    return replyJson(res, result.state === 'cleared' ? 200 : 502, { result });
  } catch (error) {
    return replyProviderLoginError(res, error);
  }
};

function readDraftSearchProfile() {
  if (!fs.existsSync(WORKSPACE.searchProfileDraft)) return null;
  const draft = validateSearchProfile(JSON.parse(fs.readFileSync(WORKSPACE.searchProfileDraft, 'utf8')));
  if (draft.status !== 'draft') throw new Error('search profile draft must have draft status');
  return draft;
}

function readSearchProfileState() {
  stageSearchProfileReviewAtStartup();
  const draft = readDraftSearchProfile();
  return {
    rawPresent: fs.existsSync(WORKSPACE.searchProfileRaw),
    draft,
    published: loadPublishedSearchProfile(WORKSPACE_ROOT),
    draftRevision: draft ? profileFingerprint(draft) : null,
  };
}

function currentDraftForRevision(revision) {
  const draft = readDraftSearchProfile();
  const currentRevision = draft ? profileFingerprint(draft) : null;
  if (revision !== currentRevision) {
    const error = new Error('The search-profile draft changed while this page was open. Refresh and retry.');
    error.currentRevision = currentRevision;
    throw error;
  }
  return draft;
}

function replySearchProfileConflict(res, error) {
  return replyJson(res, 409, {
    conflict: true, currentRevision: error.currentRevision,
    ...publicApiError('Search-profile update conflict.'),
  });
}

function currentEmployerRegistry() {
  const evidenceFile = fs.existsSync(WORKSPACE.employers)
    ? WORKSPACE.employers
    : WORKSPACE.portals;
  const recordedAt = fs.existsSync(evidenceFile)
    ? fs.statSync(evidenceFile).mtime.toISOString()
    : '2000-01-01T00:00:00.000Z';
  return migrateLegacyPortals(
    loadEmployerRegistry(WORKSPACE_ROOT),
    loadPortals(WORKSPACE_ROOT),
    { now: () => recordedAt },
  );
}

function currentLearningLedger() {
  return loadLearningLedger(WORKSPACE_ROOT)
    || createLearningLedger({ now: () => '2000-01-01T00:00:00.000Z' });
}

function learningLedgerForRevision(revision) {
  const ledger = currentLearningLedger();
  const currentRevision = learningLedgerRevision(ledger);
  if (revision !== currentRevision) {
    const error = new Error('The feedback ledger changed while this page was open.');
    error.currentRevision = currentRevision;
    throw error;
  }
  return ledger;
}

function replyLearningConflict(res, error) {
  return replyJson(res, 409, {
    conflict: true,
    currentRevision: error.currentRevision,
    ...publicApiError('Feedback or learned preferences changed. Refresh and retry.'),
  });
}

function publicLearningLedger(ledger) {
  return {
    schemaVersion: ledger.schemaVersion,
    generation: ledger.generation,
    updatedAt: ledger.updatedAt,
    revision: learningLedgerRevision(ledger),
    active: activeLearningPolicy(ledger),
    feedbackEvents: ledger.feedbackEvents,
    proposals: ledger.proposals,
    versions: ledger.versions,
  };
}

function assertCurrentProfileRule(change) {
  if (change?.kind !== 'reconsider-rule') return;
  const profile = loadPublishedSearchProfile(WORKSPACE_ROOT);
  if (!profile || !searchProfileRuleIds(profile).has(change.profileRuleId)) {
    throw new TypeError('learning reconsideration must reference a current published profile rule');
  }
}

routes['GET /api/feedback-learning'] = (req, res) => {
  try {
    return replyJson(res, 200, publicLearningLedger(currentLearningLedger()));
  } catch {
    return replyJson(res, 500, publicApiError('Feedback history could not be read.'));
  }
};

routes['POST /api/feedback'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || typeof value.revision !== 'string'
    || typeof value.opportunityId !== 'string') {
    return replyJson(res, 400, {
      error: 'feedback, opportunity ID and current revision are required',
    });
  }
  try {
    return withSearchPlanMutation(res, 'feedback', () => {
      const ledger = learningLedgerForRevision(value.revision);
      const tracker = readTrackerSnapshot(TRACKER_FILE).data;
      const opportunity = findEntry(tracker, value.opportunityId);
      const profile = loadPublishedSearchProfile(WORKSPACE_ROOT);
      const next = recordFeedback(ledger, {
        opportunityId: opportunity.id,
        vacancyId: opportunity.vacancyId
          || opportunity.jobIdentity?.vacancyId
          || opportunity.jobIdentity?.providerId
          || opportunity.id,
        decision: value.decision,
        reason: value.reason,
        explanation: value.explanation,
        profileId: opportunity.profileId || profile?.id || 'legacy-profile',
        learningVersionId: opportunity.learningVersionId || ledger.activeVersionId,
      });
      writeLearningLedger(WORKSPACE_ROOT, next);
      void scheduleCheckpoint('ui: record job feedback');
      return replyJson(res, 200, { ok: true, ledger: publicLearningLedger(next) });
    });
  } catch (error) {
    if (Object.hasOwn(error, 'currentRevision')) return replyLearningConflict(res, error);
    return replyJson(res, 400, publicApiError('Job feedback could not be recorded.'));
  }
};

routes['POST /api/learning/proposals'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || typeof value.revision !== 'string') {
    return replyJson(res, 400, {
      error: 'learning proposal and current revision are required',
    });
  }
  try {
    return withSearchPlanMutation(res, 'learning-proposal', () => {
      const ledger = learningLedgerForRevision(value.revision);
      assertCurrentProfileRule(value.change);
      const next = proposeLearningChange(ledger, value);
      writeLearningLedger(WORKSPACE_ROOT, next);
      void scheduleCheckpoint('ui: propose learned preference');
      return replyJson(res, 200, { ok: true, ledger: publicLearningLedger(next) });
    });
  } catch (error) {
    if (Object.hasOwn(error, 'currentRevision')) return replyLearningConflict(res, error);
    return replyJson(res, 400, publicApiError('Learned preference could not be proposed.'));
  }
};

routes['POST /api/learning/publish'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || typeof value.revision !== 'string'
    || value.confirmed !== true || typeof value.proposalId !== 'string') {
    return replyJson(res, 400, {
      error: 'proposal ID, explicit confirmation and current revision are required',
    });
  }
  try {
    return withSearchPlanMutation(res, 'learning-publish', () => {
      const ledger = learningLedgerForRevision(value.revision);
      const proposal = ledger.proposals.find(({ id }) => id === value.proposalId);
      assertCurrentProfileRule(proposal?.change);
      const next = publishLearningProposal(ledger, value);
      writeLearningLedger(WORKSPACE_ROOT, next);
      void scheduleCheckpoint('ui: publish learned preference');
      return replyJson(res, 200, { ok: true, ledger: publicLearningLedger(next) });
    });
  } catch (error) {
    if (Object.hasOwn(error, 'currentRevision')) return replyLearningConflict(res, error);
    return replyJson(res, 400, publicApiError('Learned preference could not be published.'));
  }
};

routes['POST /api/learning/undo'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || typeof value.revision !== 'string'
    || value.confirmed !== true || typeof value.versionId !== 'string') {
    return replyJson(res, 400, {
      error: 'version ID, explanation, explicit confirmation and current revision are required',
    });
  }
  try {
    return withSearchPlanMutation(res, 'learning-undo', () => {
      const ledger = learningLedgerForRevision(value.revision);
      const next = undoLearningVersion(ledger, value);
      writeLearningLedger(WORKSPACE_ROOT, next);
      void scheduleCheckpoint('ui: undo learned preference');
      return replyJson(res, 200, { ok: true, ledger: publicLearningLedger(next) });
    });
  } catch (error) {
    if (Object.hasOwn(error, 'currentRevision')) return replyLearningConflict(res, error);
    return replyJson(res, 400, publicApiError('Learned preference could not be undone.'));
  }
};

function publicEmployerRegistry(registry) {
  return {
    schemaVersion: registry.schemaVersion,
    revision: employerRegistryRevision(registry),
    generation: registry.generation,
    updatedAt: registry.updatedAt,
    employers: registry.employers.map((employer) => ({
      id: employer.id,
      canonicalName: employer.canonicalName,
      aliases: employer.aliases,
      origins: employer.origins,
      careersUrl: employer.careersUrl,
      board: employer.board,
      industries: employer.industries,
      locations: employer.locations,
      userPriority: employer.userPriority,
      decision: employer.decision,
      access: employer.access,
      health: employer.health,
      monitoring: employer.monitoring,
      history: employer.history.slice(-10),
      reviewHistory: (employer.reviewHistory || []).slice(-10),
      createdAt: employer.createdAt,
      updatedAt: employer.updatedAt,
    })),
  };
}

routes['GET /api/search-profile/adaptive'] = (req, res) => {
  try {
    stageSearchProfileReviewAtStartup();
    const draft = readDraftSearchProfile();
    const lanePlan = loadSearchLanePlan(WORKSPACE_ROOT);
    return replyJson(res, 200, {
      questionnaire: draft ? buildAdaptiveQuestionnaire(draft) : null,
      lanePlan,
      laneRevision: lanePlan ? searchLanePlanRevision(lanePlan) : null,
    });
  } catch {
    return replyJson(res, 400, publicApiError('Adaptive search-profile review could not be loaded.'));
  }
};

function currentLanePlanForRevision(revision) {
  const plan = loadSearchLanePlan(WORKSPACE_ROOT);
  if (!plan) throw new Error('No published search-lane plan is available.');
  const currentRevision = searchLanePlanRevision(plan);
  if (revision !== currentRevision) {
    const error = new Error('The search-lane plan changed while this page was open. Refresh and retry.');
    error.currentRevision = currentRevision;
    throw error;
  }
  return plan;
}

function replyLaneConflict(res, error) {
  return replyJson(res, 409, {
    conflict: true,
    currentRevision: error.currentRevision,
    ...publicApiError('Search-lane update conflict.'),
  });
}

function withSearchPlanMutation(res, phase, action) {
  let lease;
  let heartbeat;
  try {
    if (phase === 'publish') recoverPendingProfilePublications(WORKSPACE_ROOT);
    const runId = phase === 'publish'
      ? `${PROFILE_PUBLICATION_RUN_PREFIX}${randomUUID()}`
      : `search-plan-${phase}-${randomUUID()}`;
    lease = acquireScanLease(
      WORKSPACE_ROOT,
      currentLeaseOwner(),
      {
        kind: 'search-plan-mutation',
        runId,
        phase,
      },
    );
    if (!lease) {
      return replyJson(res, 409, {
        error: 'A scan or workspace mutation is in progress. Refresh and retry.',
      });
    }
    heartbeat = startLeaseHeartbeat(lease);
    if (phase === 'publish') return action({ lease, runId });
    return withMutationCoordinator(WORKSPACE_ROOT, lease, () => action({ lease, runId }));
  } finally {
    heartbeat?.stop();
    if (lease) {
      try { releaseScanLease(lease); } catch {}
    }
  }
}

routes['POST /api/search-lanes/retire-unproductive'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || value.confirmed !== true || !Object.hasOwn(value, 'revision')) {
    return replyJson(res, 400, {
      error: 'explicit confirmation and current lane revision are required',
    });
  }
  try {
    return withSearchPlanMutation(res, 'retire', () => {
      const current = currentLanePlanForRevision(value.revision);
      const plan = retireUnproductiveSearchLanes(current, { minimumRuns: 3 });
      if (searchLanePlanRevision(plan) === searchLanePlanRevision(current)) {
        return replyJson(res, 409, {
          error: 'No active lane has three completed unproductive runs.',
        });
      }
      writeSearchLanePlan(WORKSPACE_ROOT, plan);
      void scheduleCheckpoint('ui: retire unproductive search lanes');
      return replyJson(res, 200, {
        ok: true,
        lanePlan: plan,
        laneRevision: searchLanePlanRevision(plan),
      });
    });
  } catch (error) {
    if (Object.hasOwn(error, 'currentRevision')) return replyLaneConflict(res, error);
    return replyJson(res, 400, publicApiError('Search lanes could not be retired.'));
  }
};

routes['POST /api/search-lanes/restore'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || value.confirmed !== true
    || !Object.hasOwn(value, 'revision') || !Object.hasOwn(value, 'laneId')) {
    return replyJson(res, 400, {
      error: 'lane ID, explicit confirmation and current lane revision are required',
    });
  }
  try {
    return withSearchPlanMutation(res, 'restore', () => {
      const current = currentLanePlanForRevision(value.revision);
      const plan = restoreSearchLane(current, value.laneId);
      writeSearchLanePlan(WORKSPACE_ROOT, plan);
      void scheduleCheckpoint('ui: restore search lane');
      return replyJson(res, 200, {
        ok: true,
        lanePlan: plan,
        laneRevision: searchLanePlanRevision(plan),
      });
    });
  } catch (error) {
    if (Object.hasOwn(error, 'currentRevision')) return replyLaneConflict(res, error);
    return replyJson(res, 400, publicApiError('Search lane could not be restored.'));
  }
};

routes['PUT /api/employers'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || value.confirmed !== true
    || typeof value.revision !== 'string'
    || !value.employer || typeof value.employer !== 'object') {
    return replyJson(res, 400, {
      error: 'employer update, explicit confirmation and current revision are required',
    });
  }
  try {
    return withSearchPlanMutation(res, 'employer-registry', () => {
      const current = currentEmployerRegistry();
      const currentRevision = employerRegistryRevision(current);
      if (value.revision !== currentRevision) {
        return replyJson(res, 409, {
          conflict: true,
          currentRevision,
          ...publicApiError('Employer registry update conflict.'),
        });
      }
      const registry = updateEmployerRegistryEntry(current, value.employer);
      writeEmployerRegistry(WORKSPACE_ROOT, registry);
      void scheduleCheckpoint('ui: update employer registry');
      return replyJson(res, 200, {
        ok: true,
        registry: publicEmployerRegistry(registry),
      });
    });
  } catch {
    return replyJson(res, 400, publicApiError('Employer registry could not be updated.'));
  }
};

routes['POST /api/employers/undo'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || value.confirmed !== true
    || typeof value.revision !== 'string'
    || typeof value.employerId !== 'string'
    || typeof value.reviewId !== 'string') {
    return replyJson(res, 400, {
      error: 'employer ID, review ID, explicit confirmation and current revision are required',
    });
  }
  try {
    return withSearchPlanMutation(res, 'employer-registry-undo', () => {
      const current = currentEmployerRegistry();
      const currentRevision = employerRegistryRevision(current);
      if (value.revision !== currentRevision) {
        return replyJson(res, 409, {
          conflict: true,
          currentRevision,
          ...publicApiError('Employer registry update conflict.'),
        });
      }
      const registry = undoEmployerRegistryReview(current, value);
      writeEmployerRegistry(WORKSPACE_ROOT, registry);
      void scheduleCheckpoint('ui: undo employer metadata review');
      return replyJson(res, 200, {
        ok: true,
        registry: publicEmployerRegistry(registry),
      });
    });
  } catch {
    return replyJson(res, 400, publicApiError('Employer metadata review could not be undone.'));
  }
};

routes['PUT /api/search-profile/draft'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || !Object.hasOwn(value, 'draft') || !Object.hasOwn(value, 'revision')) {
    return replyJson(res, 400, { error: 'complete draft and current revision are required' });
  }
  try {
    currentDraftForRevision(value.revision);
    const draft = validateSearchProfile(value.draft);
    if (draft.status !== 'draft') throw new Error('search profile draft must have draft status');
    atomicWriteFile(WORKSPACE.searchProfileDraft, `${JSON.stringify(draft, null, 2)}\n`);
    const state = readSearchProfileState();
    void scheduleCheckpoint('ui: save search profile draft');
    return replyJson(res, 200, { ok: true, draft: state.draft, draftRevision: state.draftRevision });
  } catch (e) {
    if (Object.hasOwn(e, 'currentRevision')) return replySearchProfileConflict(res, e);
    return replyJson(res, 400, publicApiError('Search-profile draft could not be saved.'));
  }
};

routes['PUT /api/search-profile/adaptive'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value || !Object.hasOwn(value, 'answers') || !Object.hasOwn(value, 'revision')) {
    return replyJson(res, 400, { error: 'adaptive answers and current revision are required' });
  }
  try {
    const current = currentDraftForRevision(value.revision);
    const draft = applyAdaptiveAnswers(current, value.answers);
    atomicWriteFile(WORKSPACE.searchProfileDraft, `${JSON.stringify(draft, null, 2)}\n`);
    const draftRevision = profileFingerprint(draft);
    void scheduleCheckpoint('ui: save adaptive search profile answers');
    return replyJson(res, 200, {
      ok: true,
      draft,
      draftRevision,
      questionnaire: buildAdaptiveQuestionnaire(draft),
    });
  } catch (e) {
    if (Object.hasOwn(e, 'currentRevision')) return replySearchProfileConflict(res, e);
    return replyJson(res, 400, publicApiError('Adaptive search-profile answers could not be saved.'));
  }
};

function employerRegistryForPublishedProfile(published) {
  const migrated = migrateLegacyPortals(
    loadEmployerRegistry(WORKSPACE_ROOT),
    loadPortals(WORKSPACE_ROOT),
    { now: () => published.publishedAt },
  );
  const discoveries = (published.target.employers || []).map((rule, index) => ({
    canonicalName: rule.value,
    userPriority: ['mandatory', 'strong-preference'].includes(rule.strength)
      ? 'priority'
      : 'relevant',
    origin: {
      kind: 'named-profile',
      recordedAt: published.publishedAt,
      reference: `${published.id}:target.employers:${index}`,
    },
  }));
  return reconcileEmployerDiscoveries(migrated, discoveries, {
    now: () => published.publishedAt,
  });
}

function publishProfileAndLanePlan(
  published,
  lanePlan,
  employerRegistry,
  config,
  { lease, runId, hooks } = {},
) {
  return publishProfileGeneration(
    { root: WORKSPACE_ROOT, runId, lease },
    {
      profile: published,
      lanes: lanePlan,
      employers: employerRegistry,
      config,
    },
    hooks,
  );
}

routes['POST /api/search-profile/publish'] = (req, res, body) => {
  const value = parseBody(body);
  if (!value) return replyJson(res, 400, { error: 'bad json' });
  try {
    return withSearchPlanMutation(res, 'publish', ({ lease, runId }) => {
      const draft = currentDraftForRevision(value.revision);
      if (value.confirmed !== true) {
        const error = new Error('Explicit confirmation is required before publishing this search profile.');
        error.currentRevision = profileFingerprint(draft);
        throw error;
      }
      const published = publishSearchProfile(draft);
      const lanePlan = reconcileSearchLanePlan(loadSearchLanePlan(WORKSPACE_ROOT), published);
      const employerRegistry = employerRegistryForPublishedProfile(published);
      const historicalRerank = rerankHistoricalVacancies(WORKSPACE_ROOT, published, {
        lease,
        renew: () => renewScanLease(lease),
      });
      const config = loadWorkspaceConfig(WORKSPACE_ROOT);
      const nextConfig = {
        ...config,
        searchProfile: { ...(config.searchProfile || {}), publishedId: published.id },
      };
      publishProfileAndLanePlan(
        published,
        lanePlan,
        employerRegistry,
        nextConfig,
        { lease, runId },
      );
      void scheduleCheckpoint('ui: publish search profile');
      return replyJson(res, 200, {
        ok: true,
        published,
        lanePlan: {
          schemaVersion: lanePlan.schemaVersion,
          profileId: lanePlan.profileId,
          generation: lanePlan.generation,
          active: lanePlan.lanes.filter(({ state }) => state === 'active').length,
          retired: lanePlan.lanes.filter(({ state }) => state === 'retired').length,
          archived: lanePlan.archivedLanes.length,
          omissions: lanePlan.omissions.length,
        },
        employerRegistry: {
          revision: employerRegistryRevision(employerRegistry),
          generation: employerRegistry.generation,
          active: employerRegistry.employers.filter(({ decision }) => decision.state === 'active').length,
          inactive: employerRegistry.employers.filter(({ decision }) => decision.state === 'inactive').length,
          irrelevant: employerRegistry.employers.filter(({ decision }) => decision.state === 'irrelevant').length,
        },
        historicalRerank: {
          created: historicalRerank.created,
          totals: historicalRerank.totals,
        },
      });
    });
  } catch (e) {
    if (Object.hasOwn(e, 'currentRevision')) return replySearchProfileConflict(res, e);
    return replyJson(res, 400, publicApiError('Search profile could not be published.'));
  }
};

routes['POST /api/workspace/create'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (workspaceInitialised()) return replyJson(res, 409, { error: 'This Scout workspace already exists' });
  try {
    seedWorkspace(APP_ROOT, WORKSPACE_ROOT);
    return replyJson(res, 200, { ok: true, workspaceRoot: WORKSPACE_ROOT });
  } catch { return replyJson(res, 400, publicApiError('Workspace creation could not be completed.')); }
};

routes['POST /api/workspace/restore'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (workspaceInitialised()) return replyJson(res, 409, { error: 'Restore is available only before a workspace is created' });
  try {
    const result = await restoreWorkspaceFromGithub({
      remoteUrl: b.remoteUrl, targetRoot: WORKSPACE_ROOT, secret: b.secret,
    }, {
      prepareWorkspace: (root) => syncManagedInstructions(APP_ROOT, root),
      validateWorkspace: (root) => doctor(root, { requireProvider: false, appRoot: APP_ROOT }),
    });
    const { validation, ...restored } = result;
    return replyJson(res, 200, { ...restored, doctor: validation });
  } catch { return replyJson(res, 400, publicApiError('Workspace restore could not be completed.')); }
};

routes['POST /api/workspace/adopt-private'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (!workspaceInitialised()) return replyJson(res, 409, { error: 'Adoption requires the existing workspace to be initialised' });
  try {
    const result = await adoptExistingWorkspaceFromGithub({
      remoteUrl: b.remoteUrl, targetRoot: WORKSPACE_ROOT, passphrase: b.passphrase, confirmation: b.confirmation,
    }, {
      prepareWorkspace: (root) => syncManagedInstructions(APP_ROOT, root),
      validateWorkspace: (root) => doctor(root, { requireProvider: false, appRoot: APP_ROOT }),
    });
    res.setHeader('Cache-Control', 'no-store');
    return replyJson(res, 200, result);
  } catch { return replyJson(res, 400, publicApiError('Private workspace adoption could not be completed.')); }
};

routes['POST /api/sync/connect'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (!workspaceInitialised()) return replyJson(res, 409, { error: 'Create the local workspace before setting up backup' });
  try {
    const result = await connectWorkspaceSync(WORKSPACE_ROOT, {
      remoteUrl: b.remoteUrl, passphrase: b.passphrase,
    }, { deviceSettings: process.platform === 'win32' ? loadDeviceSettings() : null });
    return replyJson(res, 200, result);
  } catch { return replyJson(res, 400, publicApiError('Private backup could not be connected.')); }
};

routes['POST /api/sync/deploy-key'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (!workspaceInitialised()) return replyJson(res, 409, { error: 'Create the workspace before preparing a deploy key' });
  try {
    const result = prepareGithubDeployKey(WORKSPACE_ROOT);
    res.setHeader('Cache-Control', 'no-store');
    return replyJson(res, 200, { ok: true, publicKey: result.publicKey });
  } catch { return replyJson(res, 400, publicApiError('Deploy key preparation failed.')); }
};

routes['POST /api/sync/backup'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try { return replyJson(res, 200, await queueCheckpoint(b.reason || 'manual backup')); }
  catch { return replyJson(res, 500, publicApiError('Private backup could not be completed.')); }
};

routes['POST /api/sync/retry'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try { return replyJson(res, 200, await queueCheckpoint('retry backup')); }
  catch { return replyJson(res, 500, publicApiError('Private backup retry could not be completed.')); }
};

routes['POST /api/sync/resolve'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (b.confirmed !== true) {
    return replyJson(res, 409, { error: 'Confirm that Scout should preserve both histories' });
  }
  const analysisToken = String(b.analysisToken || '');
  const runId = `backup-${createHash('sha256').update(analysisToken).digest('hex').slice(0, 40)}`;
  let lease;
  let heartbeat;
  try {
    lease = acquireScanLease(
      WORKSPACE_ROOT,
      currentLeaseOwner(),
      { kind: 'backup-divergence', runId, phase: 'resolve' },
    );
    if (!lease) {
      return replyJson(res, 409, {
        error: 'A scan or workspace mutation is in progress; refresh Backup details and try again',
      });
    }
    heartbeat = startLeaseHeartbeat(lease);
    const result = await queueWorkspaceResolution(WORKSPACE_ROOT, analysisToken, lease);
    return replyJson(res, 200, result);
  } catch (e) {
    return replyJson(
      res,
      /confirm|changed|in progress|lease/i.test(e.message) ? 409 : 500,
      publicApiError('Backup resolution could not be completed.'),
    );
  } finally {
    heartbeat?.stop();
    if (lease) {
      try { releaseScanLease(lease); } catch {}
    }
  }
};

routes['POST /api/sync/disable'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (!workspaceInitialised()) return replyJson(res, 409, { error: 'Create or restore the workspace first' });
  return replyJson(res, 200, disableWorkspaceSync(WORKSPACE_ROOT));
};

routes['POST /api/sync/recovery-key'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  res.setHeader('Cache-Control', 'no-store');
  return replyJson(res, 200, { recoveryKey: pendingRecoveryKey(WORKSPACE_ROOT) });
};

routes['POST /api/sync/recovery-key/confirm'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (!workspaceInitialised()) return replyJson(res, 409, { error: 'Create or restore the workspace first' });
  return replyJson(res, 200, confirmRecoveryKey(WORKSPACE_ROOT));
};

routes['POST /api/sync/passphrase'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (!workspaceInitialised()) return replyJson(res, 409, { error: 'Create or restore the workspace first' });
  try {
    const result = await rotateWorkspaceRecoveryPassphrase(WORKSPACE_ROOT, b.passphrase);
    return replyJson(res, result.ok ? 200 : 503, result);
  } catch { return replyJson(res, 400, publicApiError('Recovery passphrase could not be changed.')); }
};

async function applyTrackerMutation(res, mutate, commitMessage, expectedRevision) {
  const lock = await acquireTrackerMutationLock(WORKSPACE_ROOT);
  if (!lock) return replyJson(res, 409, { conflict: true, error: 'A scan is updating the tracker. Scout did not overwrite it; try again shortly.' });
  try {
    const result = mutateTrackerSnapshot(TRACKER_FILE, mutate, serializeTracker, { expectedRevision });
    const reason = typeof commitMessage === 'function' ? commitMessage(result.data) : commitMessage;
    void scheduleCheckpoint(reason);
    return replyJson(res, 200, {
      ok: true, savedLocally: true, syncQueued: true, trackerRevision: result.revision,
    });
  } catch (e) {
    if (e instanceof TrackerRevisionConflictError) {
      return replyJson(res, 409, {
        conflict: true,
        currentRevision: e.currentRevision,
        error: 'The tracker changed while this page was open. Scout preserved the newer data; refresh and retry.',
      });
    }
    if (e instanceof SyntaxError) return replyJson(res, 500, publicApiError('Tracker could not be read.'));
    return replyJson(res, 400, publicApiError('Tracker update could not be completed.'));
  } finally {
    releaseTrackerMutationLock(WORKSPACE_ROOT, lock.token);
  }
}

function company(data, id) { try { return findEntry(data, id).company; } catch { return id; } }

routes['POST /api/status'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  await applyTrackerMutation(res, (d) => setStatus(d, b.id, b.status),
    (d) => `ui: status ${b.status} - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/note'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (!b.text || !b.text.trim()) return replyJson(res, 400, { error: 'note text required' });
  await applyTrackerMutation(res, (d) => addNote(d, b.id, b.text.trim(), today()),
    (d) => `ui: note - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/log'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  await applyTrackerMutation(res, (d) => logEvent(d, b.id, b.event, b.note || '', today()),
    (d) => `ui: log ${b.event} - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/contact'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const mutate = typeof b.index === 'number'
    ? (d) => editContact(d, b.id, b.index, b.contact || {})
    : (d) => addContact(d, b.id, b.contact || {});
  await applyTrackerMutation(res, mutate, (d) => `ui: contact - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/category'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  await applyTrackerMutation(res, (d) => setCategory(d, b.id, b.category),
    (d) => `ui: category ${b.category} - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/commute'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  await applyTrackerMutation(res, (d) => setCommute(d, b.id, b.commute || {}, today()),
    (d) => `ui: commute - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/applied'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  await applyTrackerMutation(res, (d) => markApplied(d, b.id, today(), b.note || ''),
    (d) => `ui: applied - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/rejected'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  await applyTrackerMutation(res, (d) => markRejected(d, b.id, today(), b.note || ''),
    (d) => `ui: rejected - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/stage'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  await applyTrackerMutation(res, (d) => addApplicationStage(d, b.id, b.stage || {}, today()),
    (d) => `ui: stage - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/stage/complete'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  await applyTrackerMutation(res, (d) => completeApplicationStage(d, b.id, b.index, today()),
    (d) => `ui: complete stage - ${company(d, b.id)}`, b.trackerRevision);
};

routes['POST /api/cv/save'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  let abs;
  try { abs = safeCvPath(WORKSPACE_ROOT, b.path); } catch { return replyJson(res, 400, publicApiError('CV file request is invalid.')); }
  if (typeof b.content !== 'string') return replyJson(res, 400, { error: 'content required' });
  if (path.resolve(abs) === path.resolve(WORKSPACE.cv, 'master-cv.md') && Buffer.byteLength(b.content.trim(), 'utf8') < 500) {
    return replyJson(res, 409, { error: 'The master CV is empty or incomplete. Scout kept the existing file; restore the reviewed proposal or enter at least 500 bytes before saving.' });
  }
  try {
    withWorkspaceMutationAuthority(WORKSPACE_ROOT, {
      kind: 'cv-save', phase: 'persist-cv',
    }, () => atomicWriteFile(abs, b.content));
  } catch { return replyJson(res, 500, publicApiError('CV file could not be saved.')); }
  void scheduleCheckpoint(`edit cv - ${b.path}`);
  replyJson(res, 200, { ok: true, savedLocally: true, syncQueued: true });
};

routes['POST /api/cv/render'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const target = b.target === 'master' ? 'master' : 'application';
  const slug = target === 'application' ? String(b.slug || '') : '';
  try {
    const operation = operations.start('cv-render', async (update, { signal }) => {
      update({ phase: target === 'master' ? 'Preparing master reference PDF' : 'Preparing tailored PDF', current: 1, total: 3 });
      const result = await renderCvTarget(WORKSPACE_ROOT, { target, slug }, {
        appRoot: APP_ROOT, signal,
      });
      update({ phase: 'Validating PDF', current: 2, total: 3 });
      void scheduleCheckpoint(target === 'application' ? `render cv - ${slug}` : 'render master cv');
      update({ phase: 'PDF ready', current: 3, total: 3 });
      return result;
    }, { phase: 'Queued for rendering', total: 3 });
    return replyJson(res, 202, { operation });
  } catch (e) {
    if (e instanceof OperationConflictError) return replyJson(res, 409, { ...publicApiError('Another operation is already running.'), operation: e.operation });
    return replyJson(res, 400, publicApiError('CV rendering could not be started.'));
  }
};

routes['POST /api/cv/quality'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    const result = runCvQuality(WORKSPACE_ROOT, b.slug || '', { locale: config.locale, appRoot: APP_ROOT, compile: false });
    void scheduleCheckpoint(`review cv quality - ${b.slug || 'application'}`);
    return replyJson(res, 200, result);
  } catch { return replyJson(res, 400, publicApiError('CV quality check could not be completed.')); }
};

routes['POST /api/cv/quality/override'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const result = overrideCvQuality(WORKSPACE_ROOT, b.slug || '', b.cvSha256 || '');
    void scheduleCheckpoint(`accept cv draft - ${b.slug || 'application'}`);
    return replyJson(res, 200, result);
  }
  catch { return replyJson(res, 409, publicApiError('CV quality decision could not be saved.')); }
};

import { activeChatTurnCount, registerChatRoutes } from './lib/chatService.mjs';
import { registerCompanyRoutes } from './lib/companyService.mjs';
routes['POST /api/setup/proposal'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const provider = b.provider || loadWorkspaceConfig(WORKSPACE_ROOT).ai?.provider;
  if (!['codex', 'claude'].includes(provider)) return replyJson(res, 400, { error: 'choose an authenticated AI provider first' });
  try {
    const operation = operations.start('proposal', async (update, { signal }) => {
      const result = await createOnboardingProposal(WORKSPACE_ROOT, provider, {
        onProgress: update,
        signal,
      });
      void scheduleCheckpoint('stage setup proposal');
      return { ok: true, proposalId: result.proposalId, files: result.files };
    }, { phase: 'Preparing approved evidence', total: 4 });
    return replyJson(res, 202, { operation });
  }
  catch (e) {
    if (e instanceof OperationConflictError) return replyJson(res, 409, { ...publicApiError('Another operation is already running.'), operation: e.operation });
    return replyJson(res, 400, publicApiError('Setup proposal could not be started.'));
  }
};

routes['POST /api/setup/activate'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const result = activateOnboardingProposal(WORKSPACE_ROOT, b.proposalId || '', b.confirmed);
    void scheduleCheckpoint('activate setup proposal');
    return replyJson(res, 200, result);
  }
  catch { return replyJson(res, 409, publicApiError('Setup proposal could not be activated.')); }
};

routes['POST /api/setup/recovery'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const result = recoverActivatedProposal(WORKSPACE_ROOT, b.confirmed);
    void scheduleCheckpoint('recover activated master cv');
    return replyJson(res, 200, result);
  } catch { return replyJson(res, 409, publicApiError('Setup recovery could not be completed.')); }
};

routes['DELETE /api/setup/proposal'] = (req, res) => {
  const result = discardOnboardingProposal(WORKSPACE_ROOT);
  void scheduleCheckpoint('discard setup proposal');
  return replyJson(res, 200, result);
};

routes['POST /api/setup/config'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    if (!fs.existsSync(TRACKER)) seedWorkspace(APP_ROOT, WORKSPACE_ROOT);
    const current = loadWorkspaceConfig(WORKSPACE_ROOT);
    const next = {
      ...current,
      ...b,
      profile: { ...current.profile, ...(b.profile || {}) },
      search: { ...current.search, ...(b.search || {}) },
      triage: { ...current.triage, ...(b.triage || {}) },
      sources: {
        ...current.sources,
        ...(b.sources || {}),
        adzuna: { ...current.sources?.adzuna, ...(b.sources?.adzuna || {}) },
        hiringCafe: { ...current.sources?.hiringCafe, ...(b.sources?.hiringCafe || {}) },
      },
      commute: { ...current.commute, ...(b.commute || {}) },
      ai: { ...current.ai, ...(b.ai || {}), models: { ...current.ai?.models, ...(b.ai?.models || {}) } },
      schedule: b.schedule?.jobs ? { jobs: b.schedule.jobs } : current.schedule,
      setup: { ...current.setup, ...(b.setup || {}) },
    };
    writeWorkspaceConfig(WORKSPACE_ROOT, next);
    void scheduleCheckpoint('update setup');
    return replyJson(res, 200, { ok: true, config: next });
  } catch (error) { return replyJson(res, 400, publicSetupConfigError(error)); }
};

routes['POST /api/setup/complete'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const config = loadWorkspaceConfig(WORKSPACE_ROOT);
    if (!config.setup?.completedAt) {
      const providers = publicProviderStatuses(await providerDetection.detect(), WORKSPACE_ROOT);
      const readiness = setupReadiness(WORKSPACE_ROOT, config, providers, readTracker());
      if (!readiness.ready) return replyJson(res, 409, { error: 'review and activate a complete onboarding proposal before finishing setup' });
    }
    config.setup = { ...config.setup, completedAt: new Date().toISOString(), completedSections: completedWorkspaceSections({ completedAt: new Date().toISOString() }) };
    writeWorkspaceConfig(WORKSPACE_ROOT, config);
    if (process.platform === 'win32') {
      const device = loadDeviceSettings();
      device.completedSections['windows-startup'] = 1;
      saveDeviceSettings(device);
    }
    void scheduleCheckpoint('complete setup', { includeDevicePreferences: true });
    return replyJson(res, 200, { ok: true, completedAt: config.setup.completedAt });
  } catch { return replyJson(res, 400, publicApiError('Setup could not be completed.')); }
};

routes['POST /api/device/settings'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const settings = loadDeviceSettings();
    if (Object.hasOwn(b, 'startWithWindows')) {
      const enabled = Boolean(b.startWithWindows);
      const host = path.resolve(APP_ROOT, '..', 'Scout.exe');
      if (!fs.existsSync(host)) return replyJson(res, 400, { error: 'Windows startup is available in the installed Scout app' });
      const result = setWindowsStartup(enabled, host);
      if (!result.ok) return replyJson(res, 400, publicApiError('Windows startup could not be changed.'));
      settings.startWithWindows = enabled;
      settings.startup = {
        mechanism: result.mechanism || 'task-scheduler',
        verifiedAt: result.verifiedAt || new Date().toISOString(),
      };
    }
    if (Object.hasOwn(b, 'updatePolicy')) {
      if (!['notify', 'download'].includes(b.updatePolicy)) return replyJson(res, 400, { error: 'updatePolicy must be notify or download' });
      settings.updates = { ...settings.updates, policy: b.updatePolicy };
    }
    saveDeviceSettings(settings);
    void scheduleCheckpoint('update device settings', { includeDevicePreferences: true });
    return replyJson(res, 200, {
      ok: true,
      settings: publicDeviceSettings(
        settings,
        process.platform === 'win32'
          ? windowsStartupStatus()
          : { supported: false, enabled: false, mechanism: null },
      ),
      pendingSetupSections: pendingDeviceSections(settings),
    });
  } catch { return replyJson(res, 400, publicApiError('Device settings could not be saved.')); }
};

routes['POST /api/remote-access/enable'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (b.confirmOwner !== true) return replyJson(res, 400, { error: 'Confirm the detected Tailscale owner before enabling remote access' });
  try {
    let result = enableRemoteAccess(loadDeviceSettings(), { httpsPort: b.httpsPort });
    if (result.settings) {
      const settings = result.settings;
      let startupWarning = null;
      if (process.platform === 'win32' && b.startWithWindows !== false && result.enabled) {
        const host = path.resolve(APP_ROOT, '..', 'Scout.exe');
        if (!fs.existsSync(host)) startupWarning = 'Automatic startup is available in the installed Scout app';
        else {
          const startup = setWindowsStartup(true, host);
          if (startup.ok) {
            settings.startWithWindows = true;
            settings.startup = { mechanism: startup.mechanism, verifiedAt: startup.verifiedAt };
          } else startupWarning = 'Automatic startup could not be enabled.';
        }
      }
      saveDeviceSettings(settings);
      result = { ...result, startupWarning };
    }
    return replyJson(res, result.enabled ? 200 : 202, { ...publicRemoteStatus(result), startupWarning: result.startupWarning || null });
  } catch { return replyJson(res, 400, publicApiError('Private remote access could not be enabled.')); }
};

routes['POST /api/remote-access/disable'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const result = disableRemoteAccess(loadDeviceSettings());
    saveDeviceSettings(result.settings);
    return replyJson(res, 200, publicRemoteStatus(result));
  } catch { return replyJson(res, 409, publicApiError('Private remote access could not be disabled.')); }
};

routes['POST /api/setup/section'] = (req, res, body) => {
  const b = parseBody(body); if (!b || b.id !== 'windows-startup') return replyJson(res, 400, { error: 'unknown setup section' });
  const settings = loadDeviceSettings();
  if (b.action === 'complete') {
    settings.completedSections[b.id] = 1;
    delete settings.deferredSections[b.id];
  } else if (b.action === 'defer') {
    settings.deferredSections[b.id] = new Date(Date.now() + 7 * 86400000).toISOString();
  } else return replyJson(res, 400, { error: 'action must be complete or defer' });
  saveDeviceSettings(settings);
  void scheduleCheckpoint('update device setup', { includeDevicePreferences: true });
  return replyJson(res, 200, { ok: true, pendingSetupSections: pendingDeviceSections(settings) });
};

let updateCheckRunning = null;
let updateDownloadRunning = null;
async function downloadCurrentUpdate(result) {
  if (!updateDownloadRunning) updateDownloadRunning = downloadVerifiedUpdate(result, updateDownloadDirectory()).then((downloaded) => {
    const settings = loadDeviceSettings();
    settings.updates = { ...settings.updates, downloaded };
    saveDeviceSettings(settings);
    return downloaded;
  }).finally(() => { updateDownloadRunning = null; });
  return updateDownloadRunning;
}

export function canAutoDownloadUpdate(requestAccess, settings, result) {
  return requestAccess === 'local'
    && result?.available === true
    && Boolean(result.package)
    && settings?.updates?.policy === 'download'
    && settings?.updates?.downloaded?.version !== result.latestVersion;
}

async function updateStatus(force = false, { requestAccess = 'local' } = {}) {
  const settings = loadDeviceSettings();
  const last = new Date(settings.updates?.lastCheckedAt || 0).getTime();
  if (!force && Date.now() - last < 86400000 && settings.updates?.lastResult) {
    const cached = settings.updates.lastResult;
    return { ...cached, notify: false, policy: settings.updates.policy, downloaded: publicDownloadedUpdate(settings.updates.downloaded) };
  }
  if (!updateCheckRunning) updateCheckRunning = checkForUpdate(APP_VERSION).then((result) => {
    const notify = Boolean(result.available && (force || settings.updates?.lastNotifiedVersion !== result.latestVersion));
    settings.updates = { ...settings.updates, lastCheckedAt: new Date().toISOString(), lastResult: result, lastNotifiedVersion: notify ? result.latestVersion : settings.updates?.lastNotifiedVersion };
    saveDeviceSettings(settings);
    if (canAutoDownloadUpdate(requestAccess, settings, result)) {
      void downloadCurrentUpdate(result).catch(() => {
        const latest = loadDeviceSettings();
        latest.updates = { ...latest.updates, downloadError: 'Update download could not be completed.' };
        saveDeviceSettings(latest);
      });
    }
    return { ...result, notify, policy: settings.updates.policy, downloaded: publicDownloadedUpdate(settings.updates.downloaded) };
  }).finally(() => { updateCheckRunning = null; });
  return updateCheckRunning;
}

routes['POST /api/update/check'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try { return replyJson(res, 200, { ...await updateStatus(Boolean(b.force), { requestAccess: req.scoutAccess }), canDownload: req.scoutAccess === 'local' }); }
  catch { return replyJson(res, 503, { ...publicApiError('Update check could not be completed.'), available: false, currentVersion: APP_VERSION }); }
};

routes['POST /api/update/download'] = async (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    const result = await updateStatus(true, { requestAccess: req.scoutAccess });
    if (!result.available) return replyJson(res, 409, { error: 'Scout is already up to date' });
    const downloaded = await downloadCurrentUpdate(result);
    return replyJson(res, 200, { ok: true, downloaded: publicDownloadedUpdate(downloaded) });
  } catch { return replyJson(res, 503, publicApiError('Update download could not be completed.')); }
};

routes['POST /api/setup/credentials'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  try {
    saveEnv(WORKSPACE_ROOT, {
      ADZUNA_APP_ID: typeof b.appId === 'string' ? b.appId.trim() : '',
      ADZUNA_API_KEY: typeof b.apiKey === 'string' ? b.apiKey.trim() : '',
    });
    void scheduleCheckpoint('update source credentials');
    return replyJson(res, 200, { ok: true, configured: !!(b.appId && b.apiKey) });
  } catch { return replyJson(res, 400, publicApiError('Source credentials could not be saved.')); }
};

routes['POST /api/setup/import-cv'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const name = path.basename(String(b.name || ''));
  if (!name || typeof b.base64 !== 'string') return replyJson(res, 400, { error: 'name and base64 are required' });
  const encoded = b.base64.trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return replyJson(res, 400, { error: 'invalid base64' });
  }
  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); } catch { return replyJson(res, 400, { error: 'invalid base64' }); }
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) return replyJson(res, 400, { error: 'CV must be between 1 byte and 10 MB' });
  const imported = path.join(WORKSPACE.imports, name);
  void withWorkspaceMutationAuthorityAsync(WORKSPACE_ROOT, {
    kind: 'cv-import', phase: 'import-cv',
  }, async () => {
    fs.mkdirSync(WORKSPACE.imports, { recursive: true });
    const extracted = path.join(WORKSPACE.imports, `${name}.txt`);
    let completed = false;
    try {
      atomicWriteFile(imported, bytes, { mode: 0o600 });
      const text = await extractCvText(imported);
      atomicWriteFile(extracted, `${text}\n`, { mode: 0o600 });
      completed = true;
      return { text, extracted };
    } finally {
      if (!completed) {
        fs.rmSync(imported, { force: true });
        fs.rmSync(extracted, { force: true });
      }
    }
  }).then(({ text, extracted }) => {
    void scheduleCheckpoint(`import cv - ${name}`);
    replyJson(res, 200, { ok: true, source: `imports/${name}`, extracted: `imports/${path.basename(extracted)}`, text });
  }).catch((error) => {
    replyJson(res, 400, publicCvImportError(error));
  });
};

import { installSchedule, runScan } from '../tools/scout.mjs';
import { removeSchedule, runScheduledNow } from './lib/scheduler.mjs';

routes['POST /api/scan'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const config = loadWorkspaceConfig(WORKSPACE_ROOT);
  const provider = b.provider || config.ai?.provider;
  let model;
  try { model = assertSafeModel(b.model); } catch { return replyJson(res, 400, { error: 'model is invalid' }); }
  if (!['codex', 'claude'].includes(provider)) return replyJson(res, 400, { error: 'choose an authenticated AI provider first' });
  try {
    const estimate = scanEstimate(readScanRecords(), provider, 'primary');
    const operation = operations.start('scan', async (update, { signal }) => {
      const result = await runScan(WORKSPACE_ROOT, provider, 'primary', {
        onProgress: update, model, autoBroaden: true, estimate, signal,
      });
      if (!result.ok && result.status === 'in-progress'
        && result.reason === 'operator-intervention-required') {
        update({ phase: 'Operator intervention required' });
        return {
          ok: false,
          status: result.status,
          reason: result.reason,
          runId: result.runId || null,
        };
      }
      if (!result.ok) throw new Error(result.error || `scan ended with ${result.status}`);
      const scanHealth = readScanHealth();
      return {
        ok: true, status: result.status,
        summary: {
          healthy: scanHealth.healthy, degraded: scanHealth.degraded, lastRunAt: scanHealth.lastRunAt,
          candidatesFound: scanHealth.candidatesFound, keepersAdded: scanHealth.keepersAdded,
          discarded: scanHealth.discarded, reportDate: String(scanHealth.lastRunAt || '').slice(0, 10) || null,
        },
      };
    }, { phase: 'Validating approved evidence', total: 5, estimate });
    return replyJson(res, 202, { operation });
  } catch (e) {
    if (e instanceof OperationConflictError) return replyJson(res, 409, { ...publicApiError('Another operation is already running.'), operation: e.operation });
    return replyJson(res, 400, publicApiError('Scan could not be started.'));
  }
};

routes['POST /api/schedule'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  const config = loadWorkspaceConfig(WORKSPACE_ROOT);
  try {
    const mode = b.mode || 'primary';
    const provider = b.provider || config.ai?.provider;
    const id = b.id || `${provider}-${mode}`;
    const model = assertSafeModel(b.model);
    let result;
    if (b.action === 'install') {
      const configured = (config.schedule?.jobs || []).some((job) => job.id === id);
      if (!configured) {
        const health = readScanHealth();
        if (!health.lastRunAt || !health.healthy) return replyJson(res, 409, { error: 'complete a healthy supervised scan before enabling daily scans' });
      }
      if (b.days !== undefined && b.days !== null && !Array.isArray(b.days)) {
        return replyJson(res, 400, { error: 'days must be an array of whole numbers from 0 (Sunday) to 6 (Saturday)' });
      }
      result = installSchedule(WORKSPACE_ROOT, b.time || '07:30', provider, { id, mode, model, days: b.days ?? null });
    } else if (b.action === 'remove') {
      result = removeSchedule({ id });
      if (result.ok) {
        config.schedule.jobs = config.schedule.jobs.map((job) => job.id === id ? { ...job, enabled: false } : job);
        writeWorkspaceConfig(WORKSPACE_ROOT, config);
      }
    } else if (b.action === 'run-now') result = runScheduledNow({ id });
    else return replyJson(res, 400, { error: 'action must be install, remove, or run-now' });
    if (result.ok) void scheduleCheckpoint(`schedule ${b.action}`);
    return replyJson(res, result.ok ? 200 : 500, {
      ...(result.ok ? result : { ok: false, error: 'Schedule could not be changed.', reasonCode: 'request-failed' }),
      id,
      schedule: readScheduleSummary(),
    });
  } catch { return replyJson(res, 400, publicApiError('Schedule could not be changed.')); }
};

// Restart: reply first, then hand the port to a fresh detached copy of this
// server. The new process retries binding until the old one has exited.
// Injectable so tests can hit the route without killing the test runner.
export const restartControl = {
  respawn() {
    spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: APP_ROOT, detached: true, stdio: 'ignore', env: process.env,
    }).unref();
    setTimeout(() => process.exit(0), 300);
  },
};

export const shutdownControl = {
  exit() { process.exit(0); },
};

routes['POST /api/restart'] = (req, res, body) => {
  const b = parseBody(body); if (!b) return replyJson(res, 400, { error: 'bad json' });
  if (req.scoutAccess === 'remote-owner' && b.confirmed !== true) {
    return replyJson(res, 409, { error: 'Confirm the remote restart explicitly before Scout stops remote access.' });
  }
  const activeOperations = operations.activeList();
  const activeChats = activeChatTurnCount();
  if (activeOperations.length || activeChats) {
    return replyJson(res, 409, {
      error: 'Wait for active Scout work to finish before restarting.',
      active: { operations: activeOperations.map(({ id, type, status, phase }) => ({ id, type, status, phase })), chats: activeChats },
    });
  }
  replyJson(res, 200, { ok: true, restarting: true });
  closeRuntimeAdmission();
  setTimeout(() => {
    const productionServer = runtimeHttpServer?.listening ? runtimeHttpServer : null;
    const quiesced = productionServer
      ? closeServerSafely(productionServer)
      : drainRuntimeWork();
    void quiesced.then(() => {
      restartControl.respawn();
      if (!productionServer) resumeRuntimeAdmission();
    }).catch((error) => {
      if (!productionServer) recoverRuntimeAdmissionAfterFailedDrain(error);
    });
  }, 200);
};

routes['POST /api/shutdown'] = (req, res) => {
  replyJson(res, 200, { ok: true, shuttingDown: true });
  closeRuntimeAdmission();
  setTimeout(() => {
    const productionServer = runtimeHttpServer?.listening ? runtimeHttpServer : null;
    const quiesced = productionServer
      ? closeServerSafely(productionServer)
      : drainRuntimeWork();
    void quiesced.then(() => {
      shutdownControl.exit();
      if (!productionServer) resumeRuntimeAdmission();
    }).catch((error) => {
      if (!productionServer) recoverRuntimeAdmissionAfterFailedDrain(error);
    });
  }, 200);
};

registerCompanyRoutes({ routes, repoRoot: WORKSPACE_ROOT, readTracker, onCheckpoint: scheduleCheckpoint });
const chatRuntime = registerChatRoutes({
  routes, repoRoot: WORKSPACE_ROOT, readTracker, onCheckpoint: scheduleCheckpoint,
});

function resumeRuntimeAdmission() {
  // Manager admission is restored before any externally reachable work. If a
  // manager rejects the transition, HTTP and recovery admission remain closed.
  operations.resumeAdmission();
  chatRuntime.openAdmission();
  runtimeProviderHealthMonitor?.resume?.();
  runtimeRecoveryAdmissionOpen = true;
  for (const record of pausedRuntimeRecoveries.splice(0)) {
    scheduleRuntimeRecovery(record.callback, record.delay, record.schedule, record.cancel);
  }
  runtimeRequestAdmissionOpen = true;
  if (runtimeHttpServer?.listening && !runtimeSyncTimer) startRuntimeSyncTimer();
}

function recoverRuntimeAdmissionAfterFailedDrain(error) {
  if (error?.runtimeAdmissionMayResume === false) return;
  const resume = () => {
    try { resumeRuntimeAdmission(); } catch { /* admission remains externally closed for retry */ }
  };
  if (error?.pendingRuntimeQuiescence) {
    void Promise.resolve(error.pendingRuntimeQuiescence).then(resume, resume);
    return;
  }
  resume();
}

function closeRuntimeAdmission() {
  runtimeRequestAdmissionOpen = false;
  closeRuntimeRecoveryAdmission();
  chatRuntime.closeAdmission();
  if (runtimeSyncTimer) clearInterval(runtimeSyncTimer);
  runtimeSyncTimer = null;
}

export async function runtimeProviderPreflight(root, provider, purpose, {
  source,
  detectProvidersFn = detectProvidersAsync,
  preflightFn = providerPreflight,
} = {}) {
  let providerWork = null;
  try {
    providerWork = acquireProviderWork(root, provider);
    const status = (await detectProvidersFn())[provider];
    return await preflightFn(root, provider, purpose, {
      source,
      probe: async () => providerLocalHealthSignal(status, { source }),
    });
  } catch (error) {
    if (error?.reasonCode !== 'provider-auth-in-progress') throw error;
    return preflightFn(root, provider, purpose, { source });
  } finally {
    if (providerWork) releaseProviderWork(root, providerWork);
  }
}

const runtimeBackgroundTasks = new Set();
let runtimeProviderHealthMonitor = null;

function trackRuntimeBackgroundTask(task) {
  const pending = Promise.resolve(task);
  runtimeBackgroundTasks.add(pending);
  void pending.finally(() => runtimeBackgroundTasks.delete(pending)).catch(() => {});
  return pending;
}

export async function drainRuntimeWork({ timeoutMs = 10_000 } = {}) {
  runtimeProviderHealthMonitor?.stop();
  closeRuntimeAdmission();
  const quiescence = (async () => {
    const managerSettlements = await Promise.allSettled([
      operations.shutdown({ timeoutMs: null }),
      chatRuntime.shutdown({ timeoutMs: null }),
      runtimeProviderHealthMonitor?.drain?.(),
    ].filter(Boolean));
    // Work that was already admitted may register a child task while it is
    // settling. Drain snapshots until both registries remain empty.
    while (runtimeBackgroundTasks.size || runtimeHttpHandlers.size) {
      await Promise.allSettled([
        ...runtimeBackgroundTasks,
        ...runtimeHttpHandlers,
      ]);
    }
    // Mutations completed during quiescence can enqueue their final durable
    // checkpoint. It belongs to the reversible quiescence phase, so a timed-
    // out drain cannot reopen admission ahead of that write.
    await drainScheduledCheckpoints();
    const failure = managerSettlements.find(({ status }) => status === 'rejected');
    if (failure) throw failure.reason;
  })();
  void quiescence.catch(() => {});
  const timeoutError = new Error('Scout runtime work did not close before shutdown');
  let timer;
  try {
    await Promise.race([
      quiescence,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error === timeoutError) error.pendingRuntimeQuiescence = quiescence;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  try {
    await providerLoginControl.shutdown();
  } catch (error) {
    // The production provider-login control marks terminal failures as
    // non-resumable. Injected/test controls may report a reversible failure.
    throw error;
  }
}

function configuredHealthProviders(config) {
  return [...new Set([
    config?.ai?.provider,
    ...(config?.schedule?.jobs || [])
      .filter((job) => job?.enabled === true)
      .map((job) => job.provider),
  ].filter((provider) => ['codex', 'claude'].includes(provider)))];
}

export function checkStartupProviderHealth(root, {
  loadConfigFn = loadWorkspaceConfig,
  preflight = runtimeProviderPreflight,
} = {}) {
  return Promise.all(configuredHealthProviders(loadConfigFn(root)).map((provider) => (
    preflight(root, provider, 'startup', { source: 'startup' })
  )));
}

export function createRuntimeProviderHealthMonitor(root, {
  loadConfigFn = loadWorkspaceConfig,
  preflight = runtimeProviderPreflight,
  intervalMs,
  setInterval,
  clearInterval,
} = {}) {
  return createProviderHealthMonitor({
    root,
    getScheduleJobs: () => loadConfigFn(root).schedule?.jobs || [],
    preflight,
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(setInterval === undefined ? {} : { setInterval }),
    ...(clearInterval === undefined ? {} : { clearInterval }),
  });
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const providerHealthMonitor = createRuntimeProviderHealthMonitor(WORKSPACE_ROOT);
  runtimeProviderHealthMonitor = providerHealthMonitor;
  if (process.platform === 'win32') {
    try {
      const settings = loadDeviceSettings();
      const host = path.resolve(APP_ROOT, '..', 'Scout.exe');
      if (settings.startWithWindows && fs.existsSync(host) && !windowsStartupStatus().enabled) {
        const migrated = setWindowsStartup(true, host);
        if (migrated.ok) {
          settings.startup = { mechanism: migrated.mechanism, verifiedAt: migrated.verifiedAt };
          saveDeviceSettings(settings);
        }
      }
    } catch (error) { console.warn(`Scout startup migration needs attention: ${error.message}`); }
  }
  const server = createServer();
  runtimeHttpServer = server;
  let bindRetries = 0;
  server.on('error', (err) => {
    // After /api/restart the previous process may hold the port briefly.
    if (err.code === 'EADDRINUSE' && bindRetries++ < 40) {
      setTimeout(() => server.listen(PORT, '127.0.0.1'), 250);
    } else {
      throw err;
    }
  });
  server.on('listening', () => {
    console.log(`Scout UI on http://127.0.0.1:${PORT}`);
    if (workspaceInitialised()) {
      void scheduleCheckpoint('startup sync');
      void trackRuntimeBackgroundTask(checkStartupProviderHealth(WORKSPACE_ROOT)).catch(() => {});
      void trackRuntimeBackgroundTask(providerHealthMonitor.runNow()).catch(() => {});
    }
  });
  server.listen(PORT, '127.0.0.1');
  startRuntimeSyncTimer();
  let signalShutdown = null;
  const stopForSignal = async () => {
    if (signalShutdown) return signalShutdown;
    if (runtimeSyncTimer) clearInterval(runtimeSyncTimer);
    runtimeSyncTimer = null;
    providerHealthMonitor.stop();
    signalShutdown = (async () => {
      await closeServerSafely(server);
      process.exit(0);
    })();
    try { await signalShutdown; } finally { signalShutdown = null; }
  };
  process.on('SIGTERM', () => { void stopForSignal().catch(() => {}); });
  process.on('SIGINT', () => { void stopForSignal().catch(() => {}); });
}
