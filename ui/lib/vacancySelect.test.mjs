import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectVacancies } from './vacancySelect.mjs';

function ranked({
  vacancyId, score = 80, employerId = 'employer-a', source = 'ats', laneId = 'lane-a',
  change = 'unchanged', assessedAt = null,
} = {}) {
  return { vacancyId, preRankScore: score, employerId, source, laneId, change, assessedAt };
}

function rankedFixture({ dominantEmployer, alternatives }) {
  return [
    ...Array.from({ length: dominantEmployer }, (_, index) => ranked({
      vacancyId: `dominant-${index}`, score: 100 - index / 100, employerId: 'dominant',
      source: 'ats', laneId: 'lane-dominant',
    })),
    ...Array.from({ length: alternatives }, (_, index) => ranked({
      vacancyId: `alternative-${index}`, score: 90 - index / 100, employerId: `alternative-${index}`,
      source: index % 2 ? 'board' : 'ats', laneId: `lane-${index % 3}`,
    })),
  ];
}

test('one employer cannot consume the budget while strong alternatives exist', () => {
  const result = selectVacancies(rankedFixture({
    dominantEmployer: 50, alternatives: 20,
  }), { limit: 10, threshold: 40, exploration: 0, seed: 'run-1' });

  assert.ok(result.selected.filter((job) => job.employerId === 'dominant').length <= 3);
  assert.ok(new Set(result.selected.map((job) => job.source)).size > 1);
});

test('weak sources receive no guaranteed places', () => {
  const strongAts = ranked({ vacancyId: 'strong-ats', score: 90, source: 'ats' });
  const weakBoard = ranked({ vacancyId: 'weak-board', score: 40, source: 'board' });
  const result = selectVacancies([strongAts, weakBoard], {
    limit: 1, threshold: 50, exploration: 0, seed: 'run-1',
  });

  assert.deepEqual(result.selected.map((job) => job.vacancyId), [strongAts.vacancyId]);
  assert.deepEqual(result.belowCutoff.map((job) => job.vacancyId), [weakBoard.vacancyId]);
});

test('relaxes a diversity limit only when eligible jobs cannot fill the budget', () => {
  const result = selectVacancies([
    ...Array.from({ length: 4 }, (_, index) => ranked({
      vacancyId: `lane-a-${index}`, score: 100 - index, employerId: `employer-${index}`,
      source: index % 2 ? 'board' : 'ats', laneId: 'lane-a',
    })),
    ranked({ vacancyId: 'lane-b', score: 90, employerId: 'employer-4', source: 'ats', laneId: 'lane-b' }),
    ranked({ vacancyId: 'lane-c', score: 89, employerId: 'employer-5', source: 'board', laneId: 'lane-c' }),
  ], { limit: 6, threshold: 40, exploration: 0, seed: 'run-1' });

  assert.equal(result.selected.length, 6);
  assert.deepEqual(result.constraintsRelaxed, ['lane']);
  assert.ok(result.reasons.every((reason) => typeof reason === 'object' && reason.vacancyId));
});

test('equal scores prefer materially changed, then unseen, then older assessed vacancies', () => {
  const result = selectVacancies([
    ranked({ vacancyId: 'recent', assessedAt: '2026-07-25T00:00:00.000Z' }),
    ranked({ vacancyId: 'old', assessedAt: '2026-07-01T00:00:00.000Z' }),
    ranked({ vacancyId: 'unseen' }),
    ranked({ vacancyId: 'changed', change: 'material', assessedAt: '2026-07-26T00:00:00.000Z' }),
  ], { limit: 4, threshold: 40, exploration: 0, seed: 'run-1' });

  assert.deepEqual(result.selected.map((job) => job.vacancyId), ['changed', 'unseen', 'old', 'recent']);
});

test('seeded exploration only replaces deterministic above-threshold selections', () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ranked({
    vacancyId: `job-${index}`, score: 100 - index, employerId: `employer-${index}`,
    source: 'ats', laneId: 'lane-a',
  }));
  const deterministic = selectVacancies(jobs, { limit: 3, threshold: 40, exploration: 0, seed: 'run-1' });
  const exploratory = selectVacancies(jobs, { limit: 3, threshold: 40, exploration: 1, seed: 'run-1' });
  const repeat = selectVacancies(jobs, { limit: 3, threshold: 40, exploration: 1, seed: 'run-1' });

  assert.deepEqual(deterministic.selected.map((job) => job.vacancyId), ['job-0', 'job-1', 'job-2']);
  assert.deepEqual(exploratory.selected.map((job) => job.vacancyId), repeat.selected.map((job) => job.vacancyId));
  assert.ok(exploratory.selected.some((job) => !deterministic.selected.includes(job)));
  assert.ok(exploratory.selected.every((job) => job.preRankScore >= 40));
});
