import { daysBetween, followUpsDue, triage } from './derive.mjs';
import { currentStage, isInterviewStage, lastCompletedStage, stagesOf } from './tracker.mjs';

import { ACTIVE_STATUSES, OPEN_STATUSES, isOpen } from './statusGroups.mjs';

const BASE_RECOVERY_REQUIREMENTS = Object.freeze([
  'mode',
  'purpose',
  'profileVersion',
  'sourceConfigFingerprint',
  'journalSchemaVersion',
  'artifactSchemaVersion',
  'pipelineVersion',
]);
const RANKING_RECOVERY_REQUIREMENTS = Object.freeze([
  ...BASE_RECOVERY_REQUIREMENTS,
  'rankingVersion',
]);
const ASSESSMENT_RECOVERY_REQUIREMENTS = Object.freeze([
  ...RANKING_RECOVERY_REQUIREMENTS,
  'promptVersion',
  'assessmentSchemaVersion',
  'provider',
  'model',
]);
const MUTATION_RECOVERY_REQUIREMENTS = Object.freeze([
  ...BASE_RECOVERY_REQUIREMENTS,
  'mutationSchemaVersion',
  'targetRevision',
]);

export const RECOVERABLE_PIPELINE_STAGES = Object.freeze([
  Object.freeze({ id: 'collect', requirements: BASE_RECOVERY_REQUIREMENTS }),
  Object.freeze({ id: 'normalise', requirements: RANKING_RECOVERY_REQUIREMENTS }),
  Object.freeze({ id: 'deduplicate', requirements: RANKING_RECOVERY_REQUIREMENTS }),
  Object.freeze({ id: 'filter', requirements: RANKING_RECOVERY_REQUIREMENTS }),
  Object.freeze({ id: 'rank', requirements: RANKING_RECOVERY_REQUIREMENTS }),
  Object.freeze({ id: 'select', requirements: RANKING_RECOVERY_REQUIREMENTS }),
  Object.freeze({ id: 'assess', requirements: ASSESSMENT_RECOVERY_REQUIREMENTS }),
  Object.freeze({ id: 'tracker', requirements: MUTATION_RECOVERY_REQUIREMENTS }),
  Object.freeze({ id: 'report', requirements: MUTATION_RECOVERY_REQUIREMENTS }),
]);

export function recoveryRequirementsForStage(stageId) {
  const stage = RECOVERABLE_PIPELINE_STAGES.find((candidate) => candidate.id === stageId);
  if (!stage) throw new TypeError(`unknown recovery stage: ${stageId}`);
  return stage.requirements;
}

function latestDate(dates) {
  return dates.filter(Boolean).sort().at(-1) || null;
}

export function applicationSummary(entry, today, policy = {}) {
  const stages = stagesOf(entry);
  const completed = lastCompletedStage(entry);
  const appliedDate = entry.application?.appliedDate || null;
  const rejectedDate = entry.application?.rejectedDate || null;
  const logDate = latestDate((entry.log || []).map((l) => l.date));
  const stageDate = latestDate(stages.map((s) => s.date));
  const trackerCheckDate = (isOpen(entry.status) || entry.status === 'new') ? entry.lastChecked : null;
  const lastMovementDate = latestDate([rejectedDate, stageDate, logDate, appliedDate, trackerCheckDate]);
  const current = currentStage(entry);
  return {
    id: entry.id,
    company: entry.company,
    role: entry.role,
    status: entry.status,
    score: entry.score,
    lastChecked: trackerCheckDate,
    currentStage: current,
    lastCompletedStage: completed ? completed.name : null,
    appliedDate,
    rejectedDate,
    lastMovementDate,
    daysSinceApplied: appliedDate ? daysBetween(appliedDate, today) : null,
    daysSinceLastMovement: lastMovementDate ? daysBetween(lastMovementDate, today) : null,
    needsInterviewPrep: current ? isInterviewStage(current) : false,
    followUps: followUpsDue(entry, today, policy),
  };
}

function byScoreThenMovement(a, b) {
  const scoreA = typeof a.score === 'number' ? a.score : -1;
  const scoreB = typeof b.score === 'number' ? b.score : -1;
  if (scoreA !== scoreB) return scoreB - scoreA;
  return String(b.lastMovementDate || '').localeCompare(String(a.lastMovementDate || ''));
}

export function pipeline(data, today, policy = {}) {
  const summaries = (data.opportunities || []).map((entry) => applicationSummary(entry, today, policy));
  const byStatus = {};
  for (const item of summaries) byStatus[item.status] = (byStatus[item.status] || 0) + 1;

  const shortlist = summaries
    .filter((item) => item.status === 'shortlist')
    .sort(byScoreThenMovement);
  const watch = summaries
    .filter((item) => item.status === 'watch')
    .sort(byScoreThenMovement);
  const active = summaries
    .filter((item) => ACTIVE_STATUSES.includes(item.status))
    .sort((a, b) => String(b.lastMovementDate || '').localeCompare(String(a.lastMovementDate || '')));
  const awaitingDecision = summaries
    .filter((item) => OPEN_STATUSES.includes(item.status))
    .sort(byScoreThenMovement);
  const accepted = summaries
    .filter((item) => item.status === 'accepted')
    .sort((a, b) => String(b.lastMovementDate || '').localeCompare(String(a.lastMovementDate || '')));
  const recentlyClosed = summaries
    .filter((item) => item.status === 'rejected')
    .sort((a, b) => String(b.rejectedDate || b.lastMovementDate || '').localeCompare(String(a.rejectedDate || a.lastMovementDate || '')));

  return {
    summary: {
      total: summaries.length,
      byStatus,
      shortlist: shortlist.length,
      watch: watch.length,
      active: active.length,
      awaitingDecision: awaitingDecision.length,
      accepted: accepted.length,
      recentlyClosed: recentlyClosed.length,
    },
    shortlist,
    watch,
    active,
    awaitingDecision,
    accepted,
    recentlyClosed,
  };
}

// A workspace that has not been created yet must still answer /api/opportunities
// with exactly the shape a populated workspace returns. Deriving it from the
// same functions keeps the two branches from drifting apart: a hand-written
// literal previously drifted from the live pipeline shape, which crashed the
// dashboard on every fresh install.
export function emptyTrackerView(today, policy = {}) {
  const data = { updated: today, opportunities: [] };
  return {
    ...data,
    triage: triage(data, today, policy),
    pipeline: pipeline(data, today, policy),
  };
}
