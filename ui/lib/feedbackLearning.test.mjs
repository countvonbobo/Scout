import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  activeLearningPolicy,
  applyLearningToRankedVacancies,
  createLearningLedger,
  learningLedgerRevision,
  loadLearningLedger,
  proposeLearningChange,
  publishLearningProposal,
  recordFeedback,
  undoLearningVersion,
  validateLearningLedger,
  writeLearningLedger,
} from './feedbackLearning.mjs';

const AT = '2026-07-30T10:00:00.000Z';

function event(overrides = {}) {
  return {
    opportunityId: 'example-role-2026-07',
    vacancyId: 'vacancy-example',
    decision: 'not-interested',
    reason: 'location',
    explanation: 'The commute is too long for this role.',
    profileId: 'profile-aaaaaaaaaaaa',
    learningVersionId: 'learning-baseline',
    ...overrides,
  };
}

test('feedback is a bounded job event and never silently changes learning policy', () => {
  const initial = createLearningLedger({ now: () => AT });
  const recorded = recordFeedback(initial, event(), {
    now: () => '2026-07-30T10:01:00.000Z',
  });

  assert.equal(recorded.feedbackEvents.length, 1);
  assert.equal(recorded.feedbackEvents[0].scope, 'job');
  assert.equal(recorded.feedbackEvents[0].decision, 'not-interested');
  assert.equal(recorded.feedbackEvents[0].reason, 'location');
  assert.equal(recorded.feedbackEvents[0].profileId, 'profile-aaaaaaaaaaaa');
  assert.equal(recorded.feedbackEvents[0].learningVersionId, 'learning-baseline');
  assert.equal(recorded.proposals.length, 0);
  assert.deepEqual(activeLearningPolicy(recorded).changes, []);
});

test('all required feedback decisions and rejection reasons validate explicitly', () => {
  const decisions = [
    'applied', 'interview', 'promising', 'saved', 'rejected',
    'not-interested', 'duplicate', 'already-seen',
  ];
  let ledger = createLearningLedger({ now: () => AT });
  decisions.forEach((decision, index) => {
    ledger = recordFeedback(ledger, event({
      opportunityId: `job-${index}`,
      vacancyId: `vacancy-${index}`,
      decision,
      reason: decision === 'rejected' ? 'responsibilities'
        : decision === 'duplicate' ? 'duplicate'
          : decision === 'already-seen' ? 'already-seen' : 'other',
    }), { now: () => `2026-07-30T10:${String(index + 2).padStart(2, '0')}:00.000Z` });
  });
  assert.deepEqual(ledger.feedbackEvents.map(({ decision }) => decision), decisions);

  for (const reason of ['location', 'salary', 'seniority', 'responsibilities', 'employer']) {
    assert.doesNotThrow(() => recordFeedback(ledger, event({ reason })));
  }
});

test('a proposal is inspectable and cannot affect ranking before confirmed publication', () => {
  const recorded = recordFeedback(createLearningLedger({ now: () => AT }), event());
  const proposed = proposeLearningChange(recorded, {
    sourceEventIds: [recorded.feedbackEvents[0].id],
    explanation: 'Prefer roles in Manchester based on reviewed feedback.',
    change: {
      kind: 'rank-adjustment',
      field: 'location',
      value: 'Manchester',
      weight: 8,
      scope: 'profile-wide',
    },
  });
  assert.equal(proposed.proposals[0].status, 'pending');
  assert.deepEqual(activeLearningPolicy(proposed).changes, []);
  assert.throws(
    () => publishLearningProposal(proposed, {
      proposalId: proposed.proposals[0].id, confirmed: false,
    }),
    /confirmation/,
  );
});

test('confirmed learning changes ranking predictably and undo restores prior behavior', () => {
  const recorded = recordFeedback(createLearningLedger({ now: () => AT }), event());
  const proposed = proposeLearningChange(recorded, {
    sourceEventIds: [recorded.feedbackEvents[0].id],
    explanation: 'Give a modest reviewed preference to Manchester roles.',
    change: {
      kind: 'rank-adjustment',
      field: 'location',
      value: 'Manchester',
      weight: 8,
      scope: 'profile-wide',
    },
  });
  const published = publishLearningProposal(proposed, {
    proposalId: proposed.proposals[0].id,
    confirmed: true,
  }, { now: () => '2026-07-30T11:00:00.000Z' });
  const policy = activeLearningPolicy(published);
  const ranked = applyLearningToRankedVacancies([
    { vacancyId: 'london', preRankScore: 60, location: 'London' },
    { vacancyId: 'manchester', preRankScore: 60, location: 'Manchester' },
  ], policy);

  assert.deepEqual(ranked.map(({ vacancyId }) => vacancyId), ['manchester', 'london']);
  assert.equal(ranked[0].learningAdjustment, 8);
  assert.equal(ranked[0].learningContributions[0].proposalId, proposed.proposals[0].id);

  const undone = undoLearningVersion(published, {
    versionId: published.activeVersionId,
    confirmed: true,
    explanation: 'Restore the prior published behavior.',
  }, { now: () => '2026-07-30T12:00:00.000Z' });
  assert.deepEqual(activeLearningPolicy(undone).changes, []);
  assert.deepEqual(
    applyLearningToRankedVacancies(ranked, activeLearningPolicy(undone))
      .map(({ vacancyId, preRankScore }) => [vacancyId, preRankScore]),
    [['london', 60], ['manchester', 60]],
  );
});

test('equal learned adjustments preserve the established ranking tie-break', () => {
  const policy = {
    id: 'learning-reviewed',
    changes: [{
      kind: 'rank-adjustment',
      field: 'location',
      value: 'Manchester',
      weight: 4,
      scope: 'profile-wide',
      proposalId: 'proposal-location',
    }],
  };
  const ranked = applyLearningToRankedVacancies([
    {
      vacancyId: 'z-id',
      preRankScore: 60,
      preRankConfidence: 90,
      location: 'Manchester',
      stableTieBreak: {
        postedAt: '2026-07-20T00:00:00.000Z',
        employer: 'able',
        title: 'engineer',
        vacancyId: 'z-id',
      },
    },
    {
      vacancyId: 'a-id',
      preRankScore: 60,
      preRankConfidence: 90,
      location: 'Manchester',
      stableTieBreak: {
        postedAt: '2026-07-20T00:00:00.000Z',
        employer: 'baker',
        title: 'engineer',
        vacancyId: 'a-id',
      },
    },
  ], policy);

  assert.deepEqual(ranked.map(({ vacancyId }) => vacancyId), ['z-id', 'a-id']);
});

test('non-global rank adjustments require and enforce an explicit scope value', () => {
  const recorded = recordFeedback(createLearningLedger({ now: () => AT }), event());
  assert.throws(() => proposeLearningChange(recorded, {
    sourceEventIds: [recorded.feedbackEvents[0].id],
    explanation: 'Limit this reviewed location preference to one employer.',
    change: {
      kind: 'rank-adjustment',
      field: 'location',
      value: 'Manchester',
      weight: 4,
      scope: 'employer',
    },
  }), /scope value/);

  const ranked = applyLearningToRankedVacancies([
    {
      vacancyId: 'other',
      company: 'Other Co',
      location: 'Manchester',
      preRankScore: 60,
    },
    {
      vacancyId: 'scoped',
      company: 'Acme',
      location: 'Manchester',
      preRankScore: 60,
    },
  ], {
    id: 'learning-scoped',
    changes: [{
      kind: 'rank-adjustment',
      field: 'location',
      value: 'Manchester',
      weight: 4,
      scope: 'employer',
      scopeValue: 'Acme',
      proposalId: 'proposal-scoped',
    }],
  });

  assert.equal(ranked[0].vacancyId, 'scoped');
  assert.equal(ranked[0].learningAdjustment, 4);
  assert.equal(ranked[1].learningAdjustment, undefined);
});

test('role-family learning uses preserved canonical families with exact scope and no title leakage', () => {
  const policy = {
    id: 'learning-role-family',
    changes: [{
      kind: 'rank-adjustment',
      field: 'location',
      value: 'Manchester',
      weight: 5,
      scope: 'role-family',
      scopeValue: 'Product Management',
      proposalId: 'proposal-role-family',
    }],
  };
  const ranked = applyLearningToRankedVacancies([
    {
      vacancyId: 'same-title-wrong-family',
      title: 'Product Management',
      roleFamily: 'Engineering',
      location: 'Manchester',
      preRankScore: 60,
    },
    {
      vacancyId: 'canonical-family',
      title: 'Delivery Lead',
      roleFamilies: ['Operations', 'Product-Management'],
      location: 'Manchester',
      preRankScore: 60,
    },
    {
      vacancyId: 'partial-family',
      title: 'Delivery Lead',
      roleFamily: 'Senior Product Management',
      location: 'Manchester',
      preRankScore: 60,
    },
  ], policy);

  assert.equal(ranked[0].vacancyId, 'canonical-family');
  assert.equal(ranked[0].learningAdjustment, 5);
  assert.equal(ranked.find(({ vacancyId }) => vacancyId === 'same-title-wrong-family').learningAdjustment, undefined);
  assert.equal(ranked.find(({ vacancyId }) => vacancyId === 'partial-family').learningAdjustment, undefined);
});

test('role-family learning publication and undo preserve historical decision provenance', () => {
  const baseline = createLearningLedger({ now: () => AT });
  const recorded = recordFeedback(baseline, event({
    learningVersionId: baseline.activeVersionId,
    reason: 'role-family',
  }), { now: () => '2026-07-30T10:10:00.000Z' });
  const proposed = proposeLearningChange(recorded, {
    sourceEventIds: [recorded.feedbackEvents[0].id],
    explanation: 'Apply the reviewed preference only to product management.',
    change: {
      kind: 'rank-adjustment',
      field: 'location',
      value: 'Manchester',
      weight: 3,
      scope: 'role-family',
      scopeValue: 'Product Management',
    },
  }, { now: () => '2026-07-30T10:20:00.000Z' });
  const published = publishLearningProposal(proposed, {
    proposalId: proposed.proposals[0].id,
    confirmed: true,
  }, { now: () => '2026-07-30T10:30:00.000Z' });
  const undone = undoLearningVersion(published, {
    versionId: published.activeVersionId,
    confirmed: true,
    explanation: 'Restore the prior reviewed behavior.',
  }, { now: () => '2026-07-30T10:40:00.000Z' });

  assert.equal(published.generation, proposed.generation + 1);
  assert.equal(activeLearningPolicy(published).changes[0].scopeValue, 'Product Management');
  assert.deepEqual(activeLearningPolicy(undone).changes, []);
  assert.equal(undone.feedbackEvents[0].learningVersionId, 'learning-baseline');
  assert.equal(undone.feedbackEvents[0].reason, 'role-family');
});

test('one rejection can only propose reconsideration and never creates a hard exclusion', () => {
  const recorded = recordFeedback(createLearningLedger({ now: () => AT }), event({
    decision: 'rejected',
    reason: 'responsibilities',
  }));
  const proposed = proposeLearningChange(recorded, {
    sourceEventIds: [recorded.feedbackEvents[0].id],
    explanation: 'Review this existing exclusion for future jobs.',
    change: {
      kind: 'reconsider-rule',
      profileRuleId: 'rule-customer-support',
      scope: 'role-family',
      value: 'Product Manager',
    },
  });
  assert.deepEqual(activeLearningPolicy(proposed).reconsiderRuleIds, []);
  const published = publishLearningProposal(proposed, {
    proposalId: proposed.proposals[0].id,
    confirmed: true,
  });
  assert.deepEqual(activeLearningPolicy(published).reconsiderRuleIds, ['rule-customer-support']);
  assert.equal(JSON.stringify(published).includes('hard-exclusion'), false);
});

test('ledgers are revisioned and round-trip atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-learning-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const ledger = recordFeedback(createLearningLedger({ now: () => AT }), event());
  writeLearningLedger(root, ledger);
  assert.deepEqual(loadLearningLedger(root), ledger);
  assert.equal(learningLedgerRevision(loadLearningLedger(root)), learningLedgerRevision(ledger));
});

test('malformed or non-monotonic learning histories fail closed', () => {
  const initial = createLearningLedger({ now: () => AT });
  assert.throws(() => validateLearningLedger({
    ...initial,
    activeVersionId: 'learning-baseline',
    versions: [
      ...initial.versions,
      {
        ...initial.versions[0],
        id: 'learning-invalid',
        parentId: 'learning-baseline',
        version: 0,
      },
    ],
  }), /duplicated|ancestry/);

  const recorded = recordFeedback(initial, event());
  assert.throws(() => validateLearningLedger({
    ...recorded,
    proposals: [{
      id: 'proposal-invalid',
      status: 'pending',
      createdAt: AT,
      sourceEventIds: [
        recorded.feedbackEvents[0].id,
        recorded.feedbackEvents[0].id,
      ],
      explanation: 'Duplicated source history.',
      change: {
        kind: 'rank-adjustment',
        field: 'location',
        value: 'Manchester',
        weight: 2,
        scope: 'profile-wide',
      },
      publishedVersionId: null,
    }],
  }), /duplicated/);
});
