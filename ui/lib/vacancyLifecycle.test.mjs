import assert from 'node:assert/strict';
import test from 'node:test';
import { decideVacancyLifecycle } from './vacancyLifecycle.mjs';

const vacancy = {
  vacancyId: 'vacancy-1',
  title: { value: 'Platform Engineer', provenance: 'explicit-source' },
  employer: { value: 'Acme', provenance: 'explicit-source' },
  location: { value: 'London', provenance: 'explicit-source' },
  description: 'Operate reliable services and improve production resilience.',
};

test('new and materially changed vacancies are revalidated, re-ranked and assessed', () => {
  assert.deepEqual(decideVacancyLifecycle(null, vacancy), {
    change: 'new',
    revalidate: true,
    rerank: true,
    reassess: true,
    skipAssessment: false,
    reason: 'new-vacancy',
  });

  const previous = {
    ...vacancy,
    description: 'Maintain the existing service.',
    outcome: 'provider_discarded',
    profileId: 'profile-old',
  };
  const decision = decideVacancyLifecycle(previous, vacancy, { profileId: 'profile-old' });
  assert.equal(decision.change, 'material');
  assert.equal(decision.reassess, true);
  assert.equal(decision.skipAssessment, false);
  assert.equal(decision.reason, 'material-change');
});

test('an unchanged rejected vacancy is revalidated but does not consume assessment capacity', () => {
  const previous = {
    ...vacancy,
    outcome: 'below_threshold',
    profileId: 'profile-current',
  };
  assert.deepEqual(
    decideVacancyLifecycle(previous, vacancy, { profileId: 'profile-current' }),
    {
      change: 'unchanged',
      revalidate: true,
      rerank: false,
      reassess: false,
      skipAssessment: true,
      reason: 'unchanged-rejection',
    },
  );
});

test('profile, scoring and assessment changes have distinct rerank and reassess behaviour', () => {
  const previous = {
    ...vacancy,
    outcome: 'below_threshold',
    profileId: 'profile-old',
  };
  const profile = decideVacancyLifecycle(previous, vacancy, { profileId: 'profile-new' });
  assert.equal(profile.rerank, true);
  assert.equal(profile.reassess, true);
  assert.equal(profile.reason, 'profile-change');

  const scoring = decideVacancyLifecycle(previous, vacancy, {
    profileId: 'profile-old',
    scoringChanged: true,
  });
  assert.equal(scoring.rerank, true);
  assert.equal(scoring.reassess, false);
  assert.equal(scoring.skipAssessment, true);
  assert.equal(scoring.reason, 'scoring-change');

  const assessment = decideVacancyLifecycle(previous, vacancy, {
    profileId: 'profile-old',
    assessmentChanged: true,
  });
  assert.equal(assessment.rerank, false);
  assert.equal(assessment.reassess, true);
  assert.equal(assessment.skipAssessment, false);
  assert.equal(assessment.reason, 'assessment-change');
});

test('reopened vacancies are reassessed even after a prior rejection', () => {
  const previous = {
    ...vacancy,
    status: 'closed',
    outcome: 'mandatory_unmet',
    profileId: 'profile-current',
  };
  const current = { ...vacancy, status: 'open' };
  const decision = decideVacancyLifecycle(previous, current, { profileId: 'profile-current' });
  assert.equal(decision.change, 'reopened');
  assert.equal(decision.reassess, true);
  assert.equal(decision.reason, 'reopened-vacancy');
});

test('a resurfaced legacy rejection is re-ranked and reassessed once under the published profile', () => {
  const previous = {
    ...vacancy,
    outcome: 'below_threshold',
    profileId: null,
  };
  const decision = decideVacancyLifecycle(previous, vacancy, { profileId: 'profile-current' });

  assert.deepEqual(decision, {
    change: 'unchanged',
    revalidate: true,
    rerank: true,
    reassess: true,
    skipAssessment: false,
    reason: 'legacy-profile-rerank',
  });

  const currentDecision = decideVacancyLifecycle(
    { ...previous, profileId: 'profile-current' },
    vacancy,
    { profileId: 'profile-current' },
  );
  assert.equal(currentDecision.reason, 'unchanged-rejection');
  assert.equal(currentDecision.skipAssessment, true);
});
