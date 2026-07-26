import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterVacancies } from './vacancyFilter.mjs';

const rule = (value, strength, provenance = 'explicit') => ({ value, strength, provenance });
const profile = ({
  excludedResponsibilities = [], excludedTitles = [], primaryTitles = [], locations = [],
  employmentTypes = [], salaryUnknownPolicy = 'include', minimum = null,
} = {}) => ({
  id: 'profile-test000001', version: 1,
  target: { primaryTitles, locations, employmentTypes },
  negative: { excludedTitles, excludedResponsibilities },
  compensation: { minimum, unknownPolicy: salaryUnknownPolicy },
});

const softwareJob = {
  vacancyId: 'vacancy-software', employer: { value: 'Acme', provenance: 'explicit-source' },
  title: { value: 'Software Engineer', provenance: 'explicit-source' },
  employmentType: { value: 'permanent', provenance: 'explicit-source' },
  location: { value: 'London', provenance: 'explicit-source' },
  description: 'Build software systems and perform coding for customers.',
};
const unknownSalaryJob = { ...softwareJob, vacancyId: 'vacancy-unknown-salary', compensation: { value: null, provenance: 'unknown' } };

test('only confirmed hard rules deterministically exclude', () => {
  const result = filterVacancies([softwareJob], profile({
    excludedResponsibilities: [
      rule('coding', 'hard-exclusion', 'confirmed-inference'),
      rule('management', 'strong-negative', 'explicit'),
    ],
  }));
  assert.equal(result.excluded[0].code, 'excluded-responsibility');
  assert.equal(result.excluded[0].profileRuleId, 'rule-coding');
  assert.equal(result.excluded[0].profileVersion, 'profile-test000001');
  assert.equal(result.excluded[0].overrideable, false);
});

test('unknown salary follows the published policy', () => {
  assert.equal(filterVacancies([unknownSalaryJob], profile({ salaryUnknownPolicy: 'include' })).eligible.length, 1);
  assert.equal(filterVacancies([unknownSalaryJob], profile({ salaryUnknownPolicy: 'exclude' })).excluded[0].code, 'compensation-unknown');
});

test('mandatory structured title mismatch is overrideable and preserves source evidence', () => {
  const result = filterVacancies([softwareJob], profile({
    primaryTitles: [rule('Data Engineer', 'mandatory')],
  }));
  assert.deepEqual(result.excluded[0], {
    vacancyId: 'vacancy-software', code: 'mandatory-title-unmet', profileRuleId: 'rule-data-engineer',
    profileVersion: 'profile-test000001', evidence: { vacancy: 'Software Engineer', rule: 'Data Engineer' },
    confidence: 'explicit-source', overrideable: true,
  });
});

test('strong negatives and unconfirmed hard rules do not exclude', () => {
  const result = filterVacancies([softwareJob], profile({
    excludedTitles: [rule('Software Engineer', 'strong-negative'), rule('Software Engineer', 'hard-exclusion', 'unconfirmed-inference')],
  }));
  assert.deepEqual(result, { eligible: [softwareJob], excluded: [] });
});
