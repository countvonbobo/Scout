import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectVacancies } from './vacancySelect.mjs';

function ranked({
  vacancyId, score = 80, employerId = 'employer-a', source = 'ats', laneId = 'lane-a',
  roleFamily = 'engineering', location = 'London', change = 'unchanged', assessedAt = null,
} = {}) {
  return {
    vacancyId, preRankScore: score, employerId, source, laneId,
    roleFamily, location, change, assessedAt,
  };
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

test('one role family cannot consume the budget while strong alternatives exist', () => {
  const result = selectVacancies([
    ...Array.from({ length: 12 }, (_, index) => ranked({
      vacancyId: `engineering-${index}`,
      score: 100 - index / 100,
      roleFamily: 'engineering',
      employerId: 'shared-employer',
    })),
    ...Array.from({ length: 6 }, (_, index) => ranked({
      vacancyId: `alternative-family-${index}`,
      score: 90 - index / 100,
      roleFamily: index % 2 ? 'operations' : 'research',
      employerId: 'shared-employer',
    })),
  ], { limit: 10, threshold: 40, exploration: 0, seed: 'run-1' });

  assert.ok(result.selected.filter((job) => job.roleFamily === 'engineering').length <= 5);
  assert.equal(result.constraintsRelaxed.includes('roleFamily'), false);
});

test('one location cannot consume the budget while strong alternatives exist', () => {
  const result = selectVacancies([
    ...Array.from({ length: 12 }, (_, index) => ranked({
      vacancyId: `london-${index}`,
      score: 100 - index / 100,
      location: 'London',
      employerId: 'shared-employer',
    })),
    ...Array.from({ length: 6 }, (_, index) => ranked({
      vacancyId: `alternative-location-${index}`,
      score: 90 - index / 100,
      location: index % 2 ? 'Manchester' : 'Bristol',
      employerId: 'shared-employer',
    })),
  ], { limit: 10, threshold: 40, exploration: 0, seed: 'run-1' });

  assert.ok(result.selected.filter((job) => job.location === 'London').length <= 5);
  assert.equal(result.constraintsRelaxed.includes('location'), false);
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

test('role-family and location limits relax only when their alternatives cannot fill the budget', () => {
  for (const [field, dominant, second, third, expected] of [
    ['roleFamily', 'engineering', 'operations', 'research', 'roleFamily'],
    ['location', 'London', 'Manchester', 'Bristol', 'location'],
  ]) {
    const result = selectVacancies([
      ...Array.from({ length: 4 }, (_, index) => ranked({
        vacancyId: `${expected}-dominant-${index}`,
        score: 100 - index,
        employerId: 'shared-employer',
        [field]: dominant,
      })),
      ranked({
        vacancyId: `${expected}-second`,
        score: 90,
        employerId: 'shared-employer',
        [field]: second,
      }),
      ranked({
        vacancyId: `${expected}-third`,
        score: 89,
        employerId: 'shared-employer',
        [field]: third,
      }),
    ], { limit: 6, threshold: 40, exploration: 0, seed: 'run-1' });

    assert.equal(result.selected.length, 6);
    assert.deepEqual(result.constraintsRelaxed, [expected]);
  }
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

test('records one stable reason for every ranked vacancy not selected for assessment', () => {
  const jobs = [
    ...Array.from({ length: 8 }, (_, index) => ranked({
      vacancyId: `dominant-${index}`, score: 100 - index,
      employerId: 'dominant', source: 'ats', laneId: 'lane-a',
    })),
    ...Array.from({ length: 7 }, (_, index) => ranked({
      vacancyId: `alternative-${index}`, score: 90 - index,
      employerId: `alternative-${index}`, source: index % 2 ? 'board' : 'ats',
      laneId: index % 3 ? 'lane-b' : 'lane-c',
      roleFamily: index % 2 ? 'operations' : 'research',
      location: index % 2 ? 'Manchester' : 'Bristol',
    })),
    ranked({ vacancyId: 'below-threshold', score: 39 }),
  ];
  const result = selectVacancies(jobs, {
    limit: 10, threshold: 40, exploration: 2, seed: 'reason-audit',
  });

  assert.equal(result.selected.length + result.notSelected.length, jobs.length);
  assert.deepEqual(
    [...result.selected.map(({ vacancyId }) => vacancyId), ...result.notSelected.map(({ vacancyId }) => vacancyId)].sort(),
    jobs.map(({ vacancyId }) => vacancyId).sort(),
  );
  assert.equal(result.notSelected.find(({ vacancyId }) => vacancyId === 'below-threshold').reason, 'below-relevance-threshold');
  assert.ok(result.notSelected.some(({ reason }) => reason === 'diversity-limit'));
  assert.ok(result.notSelected.some(({ reason }) => reason === 'exploration-replacement'));
  assert.ok(result.notSelected.every(({ vacancyId, score, reason }) => (
    vacancyId && Number.isFinite(score) && [
      'below-relevance-threshold', 'diversity-limit', 'assessment-capacity', 'exploration-replacement',
    ].includes(reason)
  )));
  const capacity = selectVacancies(
    Array.from({ length: 4 }, (_, index) => ranked({ vacancyId: `capacity-${index}`, score: 80 - index })),
    { limit: 2, threshold: 40, exploration: 0, seed: 'reason-audit' },
  );
  assert.ok(capacity.notSelected.every(({ reason }) => reason === 'assessment-capacity'));
});

test('exploration preserves diversity limits that were not relaxed', () => {
  const result = selectVacancies([
    ...Array.from({ length: 8 }, (_, index) => ranked({
      vacancyId: `dominant-${index}`, score: 100 - index, employerId: 'dominant',
      source: 'ats', laneId: 'lane-a',
    })),
    ...Array.from({ length: 7 }, (_, index) => ranked({
      vacancyId: `alternative-${index}`, score: 80 - index, employerId: `alternative-${index}`,
      source: index % 2 ? 'board' : 'ats', laneId: index % 3 ? 'lane-b' : 'lane-c',
      roleFamily: index % 2 ? 'operations' : 'research',
      location: index % 2 ? 'Manchester' : 'Bristol',
    })),
  ], { limit: 10, threshold: 40, exploration: 5, seed: 'run-1' });

  assert.equal(result.constraintsRelaxed.includes('employer'), false);
  assert.ok(result.selected.filter((job) => job.employerId === 'dominant').length <= 3);
  assert.ok(result.selected.filter((job) => job.roleFamily === 'engineering').length <= 5);
  assert.ok(result.selected.filter((job) => job.location === 'London').length <= 5);
});

test('stable vacancy identifiers use code-unit order rather than the host locale', () => {
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = function reversedLocaleCompare(other) {
    return original.call(String(other), String(this));
  };
  try {
    const result = selectVacancies([
      ranked({ vacancyId: 'vacancy-b', employerId: 'employer-b' }),
      ranked({ vacancyId: 'vacancy-a', employerId: 'employer-a' }),
    ], { limit: 2, threshold: 40, exploration: 0, seed: 'run-1' });

    assert.deepEqual(result.selected.map((job) => job.vacancyId), ['vacancy-a', 'vacancy-b']);
  } finally {
    String.prototype.localeCompare = original;
  }
});
