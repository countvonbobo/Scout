import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankVacancies } from './vacancyRank.mjs';

function rule(value, strength = 'strong-preference') {
  return { value, strength, provenance: 'explicit' };
}

function profile({
  primaryTitles = [], locations = [], workingPatterns = [], employmentTypes = [],
  sectors = [], excludedResponsibilities = [], compensation = {},
} = {}) {
  return {
    id: 'profile-ranked-fixture', version: 1,
    target: { primaryTitles, locations, workingPatterns, employmentTypes, sectors },
    negative: { excludedTitles: [], excludedResponsibilities },
    compensation: {
      currency: null, period: 'year', minimum: null, minimumStrength: 'neutral', unknownPolicy: 'include',
      ...compensation,
    },
  };
}

function field(value, provenance = 'explicit-source') {
  return { value, provenance };
}

function vacancy({
  vacancyId, title, employer = 'Example Ltd', location = 'London', workingPattern = 'hybrid',
  employmentType = 'permanent', description = '', compensation = null, postedAt = '2026-07-20T00:00:00.000Z',
} = {}) {
  return {
    vacancyId, canonicalUrl: `https://jobs.example/${vacancyId}`, description, postedAt,
    employer: field(employer), title: field(title), location: field(location),
    workingPattern: field(workingPattern), employmentType: field(employmentType),
    compensation: compensation === null ? field(null, 'unknown') : field(compensation),
  };
}

test('ranking is independent of source response order', () => {
  const rankedProfile = profile({ primaryTitles: [rule('Platform Engineer', 'mandatory')] });
  const weak = vacancy({ vacancyId: 'weak', title: 'Office Administrator' });
  const strong = vacancy({ vacancyId: 'strong', title: 'Platform Engineer' });

  const forward = rankVacancies([weak, strong], rankedProfile);
  const reverse = rankVacancies([strong, weak], rankedProfile);

  assert.deepEqual(forward.map(({ vacancyId }) => vacancyId), reverse.map(({ vacancyId }) => vacancyId));
  assert.equal(forward[0].vacancyId, strong.vacancyId);
});

test('different profiles rank the same jobs differently', () => {
  const jobs = [
    vacancy({ vacancyId: 'law', title: 'Commercial Solicitor', description: 'Commercial contracts and client advisory work.' }),
    vacancy({ vacancyId: 'bar', title: 'Part-time Bar Supervisor', employmentType: 'permanent', description: 'Lead a hospitality bar team.' }),
  ];
  const solicitorProfile = profile({ primaryTitles: [rule('Commercial Solicitor', 'mandatory')] });
  const hospitalityProfile = profile({ primaryTitles: [rule('Part-time Bar Supervisor', 'mandatory')] });

  assert.equal(rankVacancies(jobs, solicitorProfile)[0].title.value, 'Commercial Solicitor');
  assert.equal(rankVacancies(jobs, hospitalityProfile)[0].title.value, 'Part-time Bar Supervisor');
});

test('ranked vacancies expose weighted dimensions and contribution evidence', () => {
  const result = rankVacancies([vacancy({
    vacancyId: 'explained', title: 'Data Analyst', location: 'Manchester',
    description: 'Analyse public-health data.',
  })], profile({
    primaryTitles: [rule('Data Analyst', 'mandatory')],
    locations: [rule('Manchester', 'strong-preference')],
    sectors: [rule('public health', 'nice-to-have')],
  }))[0];

  assert.equal(result.preRankScore, 100);
  assert.equal(result.preRankConfidence, 100);
  assert.ok(result.dimensions.every(({ name, score, maximum, confidence, evidence, profileRuleIds }) =>
    typeof name === 'string' && Number.isFinite(score) && Number.isFinite(maximum) && Number.isFinite(confidence)
      && Array.isArray(evidence) && Array.isArray(profileRuleIds)));
  assert.ok(result.contributions.some((item) => item.profileRuleId === 'rule-data-analyst' && item.score > 0));
  assert.deepEqual(result.stableTieBreak, {
    postedAt: '2026-07-20T00:00:00.000Z', employer: 'example ltd', title: 'data analyst', vacancyId: 'explained',
  });
});

test('unknown evidence lowers confidence and never receives a positive match score', () => {
  const result = rankVacancies([vacancy({ vacancyId: 'unknown', title: 'Data Analyst', location: null })], profile({
    primaryTitles: [rule('Data Analyst', 'strong-preference')], locations: [rule('Manchester', 'strong-preference')],
  }))[0];
  const location = result.dimensions.find((dimension) => dimension.name === 'locations');

  assert.equal(location.score, 0);
  assert.equal(location.confidence, 0);
  assert.ok(result.preRankConfidence < 100);
  assert.ok(result.preRankScore < 100);
});

test('compensation only matches comparable currency, period and rate types', () => {
  const rankedProfile = profile({ compensation: {
    currency: 'GBP', period: 'year', rateType: 'salary', minimum: 60000,
    minimumStrength: 'strong-preference', unknownPolicy: 'include',
  } });
  const jobs = [
    vacancy({ vacancyId: 'match', title: 'Engineer', compensation: { minimum: 65000, maximum: 70000, currency: 'GBP', period: 'year', rateType: 'salary' } }),
    vacancy({ vacancyId: 'foreign', title: 'Engineer', compensation: { minimum: 80000, maximum: 90000, currency: 'USD', period: 'year', rateType: 'salary' } }),
    vacancy({ vacancyId: 'hourly', title: 'Engineer', compensation: { minimum: 40, maximum: 45, currency: 'GBP', period: 'hour', rateType: 'salary' } }),
  ];
  const ranked = rankVacancies(jobs, rankedProfile);

  assert.equal(ranked[0].vacancyId, 'match');
  for (const vacancyResult of ranked.filter(({ vacancyId }) => vacancyId !== 'match')) {
    const compensation = vacancyResult.dimensions.find((dimension) => dimension.name === 'compensation');
    assert.equal(compensation.score, 0);
    assert.equal(compensation.confidence, 0);
    assert.equal(compensation.evidence[0].comparison, 'unknown');
  }
});

test('ties use confidence, posted date, employer/title, then vacancy id deterministically', () => {
  const noPreference = profile();
  const ranked = rankVacancies([
    vacancy({ vacancyId: 'z', title: 'Same', employer: 'Beta', postedAt: '2026-07-19T00:00:00.000Z' }),
    vacancy({ vacancyId: 'b', title: 'Same', employer: 'Alpha', postedAt: '2026-07-20T00:00:00.000Z' }),
    vacancy({ vacancyId: 'a', title: 'Same', employer: 'Alpha', postedAt: '2026-07-20T00:00:00.000Z' }),
  ], noPreference);

  assert.deepEqual(ranked.map(({ vacancyId }) => vacancyId), ['a', 'b', 'z']);
});

test('normalized observations without a canonical URL still have an order-independent tie break', () => {
  const first = vacancy({ vacancyId: undefined, title: 'Engineer', employer: 'Acme', postedAt: null });
  const second = vacancy({ vacancyId: undefined, title: 'Engineer', employer: 'Acme', postedAt: null });
  first.canonicalUrl = null;
  second.canonicalUrl = null;
  first.observationId = 'observation-b';
  second.observationId = 'observation-a';

  const forward = rankVacancies([first, second], profile());
  const reverse = rankVacancies([second, first], profile());

  assert.deepEqual(forward.map(({ stableTieBreak }) => stableTieBreak.vacancyId), ['observation-a', 'observation-b']);
  assert.deepEqual(forward.map(({ stableTieBreak }) => stableTieBreak.vacancyId), reverse.map(({ stableTieBreak }) => stableTieBreak.vacancyId));
});

test('unknown negative-rule evidence lowers confidence without receiving a penalty', () => {
  const result = rankVacancies([vacancy({ vacancyId: 'unknown-negative', title: null })], profile({
    excludedResponsibilities: [rule('coding', 'strong-negative')],
  }))[0];
  const negative = result.dimensions.find((dimension) => dimension.name === 'excludedResponsibilities');

  assert.equal(negative.score, 0);
  assert.equal(negative.confidence, 0);
  assert.ok(result.preRankConfidence < 100);
});

test('the generic ranker gives six distinct profile fixtures their matching vacancy first', () => {
  const jobs = [
    vacancy({ vacancyId: 'developer', title: 'Software Developer' }),
    vacancy({ vacancyId: 'administrator', title: 'Hospital Administrator' }),
    vacancy({ vacancyId: 'hospitality', title: 'Hospitality Worker' }),
    vacancy({ vacancyId: 'solicitor', title: 'Commercial Solicitor' }),
    vacancy({ vacancyId: 'graduate', title: 'Mechanical Engineering Graduate' }),
    vacancy({ vacancyId: 'retail', title: 'Retail Manager' }),
  ];
  const cases = [
    ['developer', 'Software Developer'], ['administrator', 'Hospital Administrator'],
    ['hospitality', 'Hospitality Worker'], ['solicitor', 'Commercial Solicitor'],
    ['graduate', 'Mechanical Engineering Graduate'], ['retail', 'Retail Manager'],
  ];

  for (const [expected, title] of cases) {
    assert.equal(rankVacancies(jobs, profile({ primaryTitles: [rule(title, 'mandatory')] }))[0].vacancyId, expected);
  }
});
