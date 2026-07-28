import fs from 'node:fs';
import path from 'node:path';
import { assessmentRecoveryBoundary } from './assessmentBatches.mjs';
import { projectRunManifest } from './runArtifacts.mjs';
import { validateRunJournal } from './runJournal.mjs';
import { projectScanQueue } from './scanQueue.mjs';
import { workspacePaths } from './workspace.mjs';

export function parseScanRuns(text) {
  const runs = [];
  const errors = [];
  for (const [index, raw] of String(text || '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      runs.push(JSON.parse(line));
    } catch (e) {
      errors.push({ line: index + 1, error: e.message });
    }
  }
  return { runs, errors };
}

function sourceKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function normaliseSourceHealth(run = {}) {
  const errors = Array.isArray(run.errors) ? run.errors.map(String) : [];
  const recorded = run.source_health || run.sourceHealth;
  if (recorded && typeof recorded === 'object' && !Array.isArray(recorded)) {
    return Object.entries(recorded).map(([name, value]) => ({
      name,
      status: ['healthy', 'degraded', 'unavailable'].includes(value?.status) ? value.status : 'degraded',
      count: Number.isFinite(Number(value?.count)) ? Number(value.count) : null,
      reason: value?.reason ? String(value.reason) : null,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const api = run.api_sources || run.apiSources || {};
  const entries = [];
  for (const [name, rawCount] of Object.entries(api)) {
    const count = Number.isFinite(Number(rawCount)) ? Number(rawCount) : null;
    const related = errors.filter((error) => sourceKey(error).includes(sourceKey(name)));
    const status = related.length ? (count > 0 ? 'degraded' : 'unavailable') : 'healthy';
    entries.push({ name, status, count, reason: related[0] || null });
  }
  const seen = new Set(entries.map((entry) => sourceKey(entry.name)));
  for (const name of run.sources_checked || run.sourcesChecked || []) {
    if (seen.has(sourceKey(name))) continue;
    const related = errors.filter((error) => sourceKey(error).includes(sourceKey(name)));
    entries.push({ name, status: related.length ? 'unavailable' : 'healthy', count: null, reason: related[0] || null });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function scanHealthFromText(text, today) {
  const parsed = parseScanRuns(text);
  const last = parsed.runs.at(-1) || null;
  if (!last) {
    return {
      lastRunAt: null,
      healthy: false,
      stale: true,
      degraded: false,
      reason: parsed.errors.length ? 'scan log contains invalid JSON' : 'no scan runs recorded yet',
      runs: 0,
      parseErrors: parsed.errors,
    };
  }

  const lastDate = String(last.timestamp || '').slice(0, 10);
  const stale = lastDate !== today;
  const runErrors = Array.isArray(last.errors) ? last.errors : [];
  const degraded = Boolean(last.search_degraded || last.degraded || last.degradation?.degraded);
  const healthy = !stale && !degraded && runErrors.length === 0 && parsed.errors.length === 0;
  let reason = null;
  if (stale) reason = `no run recorded for ${today}`;
  else if (degraded) reason = 'last scan was degraded';
  else if (runErrors.length) reason = runErrors.join('; ');
  else if (parsed.errors.length) reason = 'scan log contains invalid JSON';

  return {
    lastRunAt: last.timestamp || null,
    healthy,
    stale,
    degraded,
    reason,
    sourcesChecked: last.sources_checked || last.sourcesChecked || last.checked_sources || [],
    atsPortalsChecked: last.ats_portals_checked || last.atsPortalsChecked || 0,
    candidatesFound: last.candidates_found ?? last.candidatesFound ?? last.candidate_count ?? null,
    keepersAdded: last.keepers_added ?? last.keepersAdded ?? last.keeper_count ?? null,
    discarded: last.discarded || last.discarded_reasons || {},
    funnel: publicFunnel(last.funnel),
    reviewedAvailable: Array.isArray(last.reviewed) && last.reviewed.length > 0,
    errors: runErrors,
    sourceHealth: normaliseSourceHealth(last),
    runs: parsed.runs.length,
    parseErrors: parsed.errors,
  };
}

function publicFunnel(value) {
  if (!value || typeof value !== 'object') return null;
  const names = [
    'sourceRecords', 'sourceErrors', 'failedSourceRecords', 'uniqueVacancies',
    'deterministicallyExcluded', 'eligible', 'ranked', 'selected', 'assessed', 'assessmentFailed',
  ];
  return Object.fromEntries(names.filter((name) => Number.isFinite(Number(value[name]))).map((name) => [name, Number(value[name])]));
}

const NEXT_RUN_STATE = Object.freeze({
  collect: 'normalising',
  normalise: 'deduplicating',
  deduplicate: 'filtering',
  filter: 'ranking',
  rank: 'selecting',
  select: 'assessing',
  assess: 'updating-tracker',
  tracker: 'writing-report',
  report: 'finalising',
});

const RUN_LABELS = Object.freeze({
  waiting: 'Waiting to scan',
  collecting: 'Collecting vacancies',
  normalising: 'Normalising vacancies',
  deduplicating: 'Deduplicating vacancies',
  filtering: 'Filtering confirmed exclusions',
  ranking: 'Ranking eligible vacancies',
  selecting: 'Selecting vacancies for assessment',
  assessing: 'Assessing selected vacancies',
  repairing: 'Repairing affected jobs',
  recovering: 'Recovering interrupted scan',
  'updating-tracker': 'Updating tracker',
  'writing-report': 'Writing report',
  finalising: 'Finalising scan',
  partial: 'Scan partially completed',
  abandoned: 'Scan abandoned',
  failed: 'Scan failed',
  complete: 'Scan complete',
});

function shortId(value) {
  const id = String(value || '');
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function safeToken(value) {
  const token = String(value || '');
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(token) ? token : null;
}

function eventSequence(event) {
  return Number.isSafeInteger(event?.sequence) ? event.sequence : 0;
}

function currentAssessmentEvents(events) {
  const boundary = assessmentRecoveryBoundary({ events });
  return events.filter((event) => (
    event.type.startsWith('assessment.')
    && eventSequence(event) > boundary.sequence
    && Number(event.fencingGeneration) >= boundary.fencingGeneration
  ));
}

function assessmentProgress(manifest, current) {
  const attempted = current.filter((event) => event.type === 'assessment.batch-attempted');
  const completed = current.filter((event) => event.type === 'assessment.batch-completed');
  const batchIds = new Set(attempted.map((event) => event.payload?.reference?.id).filter(Boolean));
  const selectedCount = Number(manifest.completedWork?.find((work) => work.stageId === 'select')?.count || 0);
  const totalBatches = Math.max(batchIds.size, completed.length, Math.ceil(selectedCount / 10));
  if (!totalBatches && !attempted.length) return null;
  const latestAttempt = attempted.at(-1);
  const currentId = latestAttempt?.payload?.reference?.id;
  const orderedIds = [...batchIds];
  return {
    currentBatch: currentId ? orderedIds.indexOf(currentId) + 1 : Math.min(completed.length + 1, totalBatches),
    totalBatches,
    totalBatchesExact: manifest.completedWork?.some((work) => work.stageId === 'assess') || false,
    completedBatches: new Set(completed.map((event) => event.payload?.reference?.id).filter(Boolean)).size,
    completedJobs: current.filter((event) => event.type === 'assessment.job-completed').length,
    failedJobs: current.filter((event) => event.type === 'assessment.job-failed').length,
  };
}

function durableRunState(manifest, events, currentAssessment) {
  if (['partial', 'abandoned', 'failed', 'complete'].includes(manifest?.outcome)) return manifest.outcome;
  const latestRecovery = [...events].reverse().find((event) => event.type === 'recovery.started');
  const latestWork = [...events].reverse().find((event) => (
    event.type === 'stage.completed' || event.type.startsWith('assessment.') || event.type.startsWith('mutation.')
  ));
  if (latestRecovery && eventSequence(latestRecovery) > eventSequence(latestWork)) return 'recovering';
  const latestAttempt = [...currentAssessment].reverse().find((event) => event.type === 'assessment.batch-attempted');
  const assessCompleted = manifest?.completedWork?.some((work) => work.stageId === 'assess');
  if (latestAttempt && !assessCompleted && /^(?:repair|retry-)/.test(String(latestAttempt.payload?.attempt || ''))) return 'repairing';
  const completed = manifest?.completedWork || [];
  if (!completed.length) return 'collecting';
  return NEXT_RUN_STATE[completed.at(-1).stageId] || 'finalising';
}

function hasCurrentActiveLease(lease, runId, outcome, now) {
  if (!lease || lease.runId !== runId || outcome !== 'in-progress' || lease.lastTerminalSequence !== null) return false;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('run projection time must be a date');
  const expiresAt = Date.parse(lease.expiresAt || '');
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return false;
  const owner = lease.owner;
  return Boolean(owner && typeof owner.host === 'string' && owner.host
    && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.processStart === 'string' && owner.processStart);
}

export function publicRunSummary(manifest = {}, { events = [], lease = null, now = new Date() } = {}) {
  const assessmentEvents = currentAssessmentEvents(events);
  const state = durableRunState(manifest, events, assessmentEvents);
  const failure = [...events].reverse().find((event) => event.type === 'run.failure-recorded');
  const completedStages = (manifest.completedWork || []).map((work) => safeToken(work.stageId)).filter(Boolean);
  const startedAt = events.find((event) => event.type === 'run.started')?.recordedAt || null;
  const updatedAt = events.at(-1)?.recordedAt || startedAt;
  const runId = String(manifest.runId || events[0]?.runId || '');
  const result = {
    id: shortId(runId),
    state,
    label: RUN_LABELS[state] || RUN_LABELS.waiting,
    owner: hasCurrentActiveLease(lease, runId, manifest.outcome, now) ? 'active worker' : null,
    startedAt,
    updatedAt,
    profileVersion: safeToken(manifest.compatibility?.profileVersion),
    pipelineVersion: safeToken(manifest.compatibility?.pipelineVersion),
    completedStages,
    assessment: assessmentProgress(manifest, assessmentEvents),
    recoveryCount: Array.isArray(manifest.recoveryAttempts) ? manifest.recoveryAttempts.length : 0,
    terminalReason: safeToken(failure?.payload?.reason)
      || (['partial', 'abandoned', 'failed'].includes(state) ? 'reason-not-recorded' : null),
  };
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

export function publicQueueSummary(projection = {}) {
  const requests = (Array.isArray(projection.requests) ? projection.requests : []).map((request) => {
    const item = {
      id: shortId(request.id),
      status: safeToken(request.status) || 'queued',
      requester: ['manual', 'scheduled'].includes(request.requester) ? request.requester : 'manual',
      purpose: safeToken(request.purpose),
      requestedAt: typeof request.requestedAt === 'string' ? request.requestedAt : null,
      expiresAt: typeof request.expiresAt === 'string' ? request.expiresAt : null,
    };
    if (request.claim?.runId) item.runId = shortId(request.claim.runId);
    if (request.claim?.owner) item.owner = 'active worker';
    return item;
  });
  return {
    state: requests.some((request) => request.status === 'queued') ? 'queued' : 'waiting',
    generatedAt: typeof projection.generatedAt === 'string' ? projection.generatedAt : null,
    requests,
  };
}

export function readPublicRunSummaries(root, { lease = null, now = new Date() } = {}) {
  const directory = workspacePaths(root).runs;
  if (!fs.existsSync(directory)) return { state: 'waiting', runs: [] };
  const runs = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const journalFile = path.join(directory, entry.name, 'journal.jsonl');
    if (!fs.existsSync(journalFile)) continue;
    try {
      const { events } = validateRunJournal(journalFile);
      if (!events.length) continue;
      runs.push(publicRunSummary(projectRunManifest(events), { events, lease, now }));
    } catch {
      runs.push({
        id: 'invalid-run',
        state: 'failed',
        label: RUN_LABELS.failed,
        owner: null,
        startedAt: null,
        updatedAt: null,
        profileVersion: null,
        pipelineVersion: null,
        completedStages: [],
        assessment: null,
        recoveryCount: 0,
        terminalReason: 'journal-validation-failed',
      });
    }
  }
  runs.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  return { state: runs[0]?.state || 'waiting', runs };
}

export function readPublicScanQueue(root, now = new Date()) {
  return publicQueueSummary(projectScanQueue(root, now));
}
