import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCoverageRollups,
  buildVacancyExplanations,
  reconcileCoverageFunnel,
} from './scanCoverage.mjs';

function vacancy(vacancyId, {
  source = 'ats', score = 80, employer = 'Acme', role = 'Engineer',
  laneId = 'primary', roleFamily = 'engineering', location = 'London',
} = {}) {
  return {
    vacancyId,
    source,
    canonicalUrl: `https://example.test/${vacancyId}?private=query#fragment`,
    employer: { value: employer },
    title: { value: role },
    laneId,
    roleFamily,
    location: { value: location },
    preRankScore: score,
    contributions: [
      { profileRuleId: 'title-fit', score: 8 },
      { profileRuleId: 'location-distance', score: -2 },
    ],
  };
}

test('builds one privacy-bounded stage explanation for every unique vacancy', () => {
  const ranked = [
    vacancy('selected-assessed'),
    vacancy('selected-failed', { employer: 'Beta' }),
    vacancy('diversity-miss', { source: 'board', employer: 'Gamma', score: 70 }),
    vacancy('threshold-miss', { source: 'board', employer: 'Delta', score: 30 }),
  ];
  const explanations = buildVacancyExplanations({
    ranked,
    exclusions: [vacancy('excluded', { score: 0 })],
    candidates: [
      { ...ranked[0], candidateId: 'candidate-001' },
      { ...ranked[1], candidateId: 'candidate-002' },
    ],
    assessmentResult: { assessments: [{ candidateId: 'candidate-001' }] },
    reviewed: [{
      vacancyId: 'selected-assessed',
      outcome: 'kept',
      trackerOutcome: 'added',
    }],
    selectionDecision: {
      threshold: 40,
      selected: ranked.slice(0, 2),
      reasons: [
        { vacancyId: 'selected-assessed', reason: 'deterministic-rank' },
        { vacancyId: 'selected-failed', reason: 'deterministic-rank' },
      ],
      notSelected: [
        { vacancyId: 'diversity-miss', reason: 'diversity-limit' },
        { vacancyId: 'threshold-miss', reason: 'below-relevance-threshold' },
      ],
      assessmentSkipped: [],
    },
    deterministicExclusions: [{ vacancyId: 'excluded', code: 'mandatory-location-unmet' }],
  });

  assert.equal(explanations.length, 5);
  assert.equal(new Set(explanations.map(({ vacancy_id }) => vacancy_id)).size, 5);
  assert.deepEqual(explanations.find(({ vacancy_id }) => vacancy_id === 'selected-assessed').stages, {
    found: true, ranked: true, selected: true, excluded: false, assessed: true,
  });
  assert.equal(explanations.find(({ vacancy_id }) => vacancy_id === 'selected-assessed').outcome, 'kept');
  assert.equal(explanations.find(({ vacancy_id }) => vacancy_id === 'selected-failed').reason_code, 'assessment-failed');
  assert.equal(explanations.find(({ vacancy_id }) => vacancy_id === 'diversity-miss').reason_code, 'diversity-limit');
  assert.equal(explanations.find(({ vacancy_id }) => vacancy_id === 'threshold-miss').above_threshold, false);
  assert.equal(explanations.find(({ vacancy_id }) => vacancy_id === 'excluded').deterministic_exclusion, 'mandatory-location-unmet');
  assert.deepEqual(explanations.find(({ vacancy_id }) => vacancy_id === 'diversity-miss').dimensions, {
    source: 'board', employer: 'Gamma', lane: 'primary', role_family: 'engineering', location: 'London',
  });
  assert.doesNotMatch(JSON.stringify(explanations), /private=query|fragment/);
});

test('reconciles every total funnel stage to complete per-source funnels', () => {
  const explanations = buildVacancyExplanations({
    ranked: [
      vacancy('selected-assessed'),
      vacancy('selected-failed', { employer: 'Beta' }),
      vacancy('diversity-miss', { source: 'board', score: 70 }),
      vacancy('threshold-miss', { source: 'board', score: 30 }),
    ],
    exclusions: [vacancy('excluded')],
    candidates: [
      { ...vacancy('selected-assessed'), candidateId: 'candidate-001' },
      { ...vacancy('selected-failed'), candidateId: 'candidate-002' },
    ],
    assessmentResult: { assessments: [{ candidateId: 'candidate-001' }] },
    reviewed: [{
      vacancyId: 'selected-assessed',
      outcome: 'kept',
      trackerOutcome: 'added',
    }],
    selectionDecision: {
      threshold: 40,
      selected: [vacancy('selected-assessed'), vacancy('selected-failed')],
      reasons: [],
      notSelected: [
        { vacancyId: 'diversity-miss', reason: 'diversity-limit' },
        { vacancyId: 'threshold-miss', reason: 'below-relevance-threshold' },
      ],
      assessmentSkipped: [],
    },
    deterministicExclusions: [{ vacancyId: 'excluded', code: 'mandatory-location-unmet' }],
  });
  const funnel = reconcileCoverageFunnel({
    sourceRecords: 7, sourceErrors: 1, failedSourceRecords: 1, parsed: 7, normalised: 6,
    duplicateObservations: 1, uniqueVacancies: 5, deterministicallyExcluded: 1,
    eligible: 4, ranked: 4, aboveThreshold: 3, selected: 2, assessed: 1,
    assessmentFailed: 1, added: 1, updated: 0, unchanged: 0, closed: 0,
    bySource: {
      ats: { count: 4, failedRecords: 0, sourceErrors: 0 },
      board: { count: 3, failedRecords: 1, sourceErrors: 1 },
    },
  }, explanations);

  assert.deepEqual(funnel.bySource.ats, {
    count: 4, failedRecords: 0, sourceErrors: 0,
    sourceRecords: 4, parsed: 4, normalised: 4, duplicateObservations: 1,
    uniqueVacancies: 3, deterministicallyExcluded: 1, eligible: 2, ranked: 2,
    aboveThreshold: 2, selected: 2, assessed: 1, assessmentFailed: 1,
    added: 1, updated: 0, unchanged: 0, closed: 0,
  });
  assert.deepEqual(funnel.bySource.board, {
    count: 3, failedRecords: 1, sourceErrors: 1,
    sourceRecords: 3, parsed: 3, normalised: 2, duplicateObservations: 0,
    uniqueVacancies: 2, deterministicallyExcluded: 0, eligible: 2, ranked: 2,
    aboveThreshold: 1, selected: 0, assessed: 0, assessmentFailed: 0,
    added: 0, updated: 0, unchanged: 0, closed: 0,
  });
  for (const stage of [
    'sourceRecords', 'sourceErrors', 'failedSourceRecords', 'parsed', 'normalised',
    'duplicateObservations', 'uniqueVacancies', 'deterministicallyExcluded',
    'eligible', 'ranked', 'aboveThreshold', 'selected', 'assessed', 'assessmentFailed',
    'added', 'updated', 'unchanged', 'closed',
  ]) {
    const sourceTotal = Object.values(funnel.bySource).reduce((total, row) => (
      total + Number(stage === 'failedSourceRecords' ? row.failedRecords : stage === 'sourceErrors' ? row.sourceErrors : row[stage])
    ), 0);
    assert.equal(sourceTotal, funnel[stage], stage);
  }
});

test('fails closed instead of publishing an unreconciled per-source funnel', () => {
  assert.throws(() => reconcileCoverageFunnel({
    sourceRecords: 1, sourceErrors: 0, failedSourceRecords: 0, parsed: 1, normalised: 1,
    duplicateObservations: 0, uniqueVacancies: 1, deterministicallyExcluded: 0,
    eligible: 1, ranked: 1, aboveThreshold: 1, selected: 1, assessed: 1,
    assessmentFailed: 0, added: 0, updated: 0, unchanged: 0, closed: 0,
    bySource: { ats: { count: 1, failedRecords: 0, sourceErrors: 0 } },
  }, []), /coverage funnel/i);
});

test('rolls complete vacancy stages up by every required coverage dimension', () => {
  const explanations = buildVacancyExplanations({
    ranked: [vacancy('kept'), vacancy('missed', { source: 'board', employer: 'Beta' })],
    candidates: [{ ...vacancy('kept'), candidateId: 'candidate-001' }],
    assessmentResult: { assessments: [{ candidateId: 'candidate-001' }] },
    reviewed: [{ vacancyId: 'kept', outcome: 'kept' }],
    selectionDecision: {
      threshold: 40, selected: [vacancy('kept')], reasons: [],
      notSelected: [{ vacancyId: 'missed', reason: 'diversity-limit' }], assessmentSkipped: [],
    },
  });
  const coverage = buildCoverageRollups({
    explanations,
    provider: 'codex',
    runId: 'run-123',
    date: '2026-07-30',
    sourceHealth: { board: { status: 'failed', reason: 'network-unavailable' } },
  });

  assert.equal(coverage.schemaVersion, 1);
  for (const dimension of ['source', 'employer', 'lane', 'roleFamily', 'location', 'provider', 'run', 'date']) {
    assert.ok(Array.isArray(coverage[dimension]) && coverage[dimension].length > 0, dimension);
  }
  assert.deepEqual(
    coverage.provider.find(({ value }) => value === 'codex'),
    { value: 'codex', found: 2, ranked: 2, selected: 1, excluded: 0, assessed: 1, assessmentFailed: 0 },
  );
  assert.ok(coverage.failureReasons.some(({ value, count }) => value === 'diversity-limit' && count === 1));
  assert.ok(coverage.failureReasons.some(({ value, count }) => value === 'network-unavailable' && count === 1));
});

test('never truncates a valid ranked-vacancy explanation audit at the old display limit', () => {
  const ranked = Array.from({ length: 220 }, (_, index) => vacancy(`vacancy-${index}`, { score: 30 }));
  const explanations = buildVacancyExplanations({
    ranked,
    selectionDecision: {
      threshold: 40, selected: [], reasons: [],
      notSelected: ranked.map((item) => ({ vacancyId: item.vacancyId, reason: 'below-relevance-threshold' })),
      assessmentSkipped: [],
    },
  });
  assert.equal(explanations.length, 220);
});

test('projects URL-shaped vacancy identities to stable safe IDs without losing the source URL', () => {
  const url = 'https://example.test/jobs/unsafe-id?private=query#fragment';
  const ranked = [{
    ...vacancy('temporary'),
    vacancyId: url,
    canonicalUrl: url,
  }];
  const explanations = buildVacancyExplanations({
    ranked,
    selectionDecision: {
      threshold: 40, selected: [], reasons: [],
      notSelected: [{ vacancyId: url, reason: 'assessment-capacity' }],
      assessmentSkipped: [],
    },
  });

  assert.match(explanations[0].vacancy_id, /^vacancy-[a-f0-9]{32}$/);
  assert.equal(explanations[0].sourceUrl, 'https://example.test/jobs/unsafe-id');
  assert.equal(explanations[0].reason_code, 'assessment-capacity');
});

test('joins assessed outcomes by canonical URL when a legacy reviewed ID was truncated', () => {
  const url = `https://example.test/jobs/${'long-path-'.repeat(20)}`;
  const ranked = [{ ...vacancy('temporary'), vacancyId: url, canonicalUrl: url }];
  const candidate = { ...ranked[0], candidateId: 'candidate-001', url };
  const explanations = buildVacancyExplanations({
    ranked,
    candidates: [candidate],
    assessmentResult: { assessments: [{ candidateId: 'candidate-001' }] },
    reviewed: [{ vacancyId: url.slice(0, 160), sourceUrl: url, outcome: 'kept' }],
    selectionDecision: {
      threshold: 40, selected: ranked,
      reasons: [{ vacancyId: url, reason: 'deterministic-rank' }],
      notSelected: [], assessmentSkipped: [],
    },
  });

  assert.equal(explanations[0].outcome, 'kept');
  assert.equal(explanations[0].reason_code, 'kept');
});
