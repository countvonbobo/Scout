import { classifyVacancyChange } from './vacancyCanonical.mjs';
import { sameUnderlyingJob } from './jobIdentity.mjs';

const REJECTED_OUTCOMES = new Set([
  'rejected',
  'ignore',
  'below_threshold',
  'provider_discarded',
  'mandatory_unmet',
  'hard_exclusion',
]);

function rejected(previous) {
  return REJECTED_OUTCOMES.has(String(previous?.outcome || previous?.status || '').toLowerCase());
}

export function decideVacancyLifecycle(previous, current, {
  profileId = null,
  scoringChanged = false,
  assessmentChanged = false,
} = {}) {
  if (!previous) {
    return {
      change: 'new',
      revalidate: true,
      rerank: true,
      reassess: true,
      skipAssessment: false,
      reason: 'new-vacancy',
    };
  }

  const change = classifyVacancyChange(previous, current);
  if (change === 'reopened' || change === 'material') {
    return {
      change,
      revalidate: true,
      rerank: true,
      reassess: true,
      skipAssessment: false,
      reason: change === 'reopened' ? 'reopened-vacancy' : 'material-change',
    };
  }

  const profileChanged = Boolean(
    profileId && previous.profileId && String(profileId) !== String(previous.profileId),
  );
  const legacyProfile = Boolean(profileId && !previous.profileId);
  if (legacyProfile) {
    return {
      change,
      revalidate: true,
      rerank: true,
      reassess: true,
      skipAssessment: false,
      reason: 'legacy-profile-rerank',
    };
  }
  if (profileChanged) {
    return {
      change,
      revalidate: true,
      rerank: true,
      reassess: true,
      skipAssessment: false,
      reason: 'profile-change',
    };
  }

  if (assessmentChanged) {
    return {
      change,
      revalidate: true,
      rerank: false,
      reassess: true,
      skipAssessment: false,
      reason: 'assessment-change',
    };
  }

  if (scoringChanged) {
    const skipAssessment = rejected(previous);
    return {
      change,
      revalidate: true,
      rerank: true,
      reassess: !skipAssessment,
      skipAssessment,
      reason: 'scoring-change',
    };
  }

  const skipAssessment = rejected(previous);
  return {
    change,
    revalidate: true,
    rerank: false,
    reassess: !skipAssessment,
    skipAssessment,
    reason: skipAssessment ? 'unchanged-rejection' : 'unchanged-prior-assessment',
  };
}

function previousDecision(vacancy, history) {
  return (history || []).find((previous) => (
    previous?.vacancyId && vacancy?.vacancyId && previous.vacancyId === vacancy.vacancyId
  ) || sameUnderlyingJob(previous, vacancy)) || null;
}

export function partitionVacanciesForAssessment(ranked, history, options = {}) {
  const eligible = [];
  const skipped = [];
  for (const vacancy of ranked || []) {
    const lifecycle = decideVacancyLifecycle(previousDecision(vacancy, history), vacancy, options);
    const annotated = { ...vacancy, lifecycle };
    if (lifecycle.skipAssessment) skipped.push(annotated);
    else eligible.push(annotated);
  }
  return { eligible, skipped };
}
