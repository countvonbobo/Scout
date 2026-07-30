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
const unknownLocationJob = { ...softwareJob, vacancyId: 'vacancy-unknown-location', location: { value: null, provenance: 'unknown' } };

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

test('unknown location follows the published policy without pretending it matches', () => {
  const include = {
    ...profile({ locations: [rule('London', 'mandatory')] }),
    unknownPolicies: { location: 'include' },
  };
  const exclude = {
    ...include,
    unknownPolicies: { location: 'exclude' },
  };

  assert.equal(filterVacancies([unknownLocationJob], include).eligible.length, 1);
  assert.deepEqual(filterVacancies([unknownLocationJob], exclude).excluded[0], {
    vacancyId: 'vacancy-unknown-location',
    code: 'location-unknown',
    profileRuleId: 'policy-location-unknown',
    profileVersion: 'profile-test000001',
    evidence: {
      vacancy: null,
      rule: 'unknown location policy: exclude',
      comparison: 'unknown',
    },
    confidence: 'unknown',
    overrideable: true,
  });
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

test('structured rules require normalized equality rather than token containment', () => {
  const result = filterVacancies([{ ...softwareJob, location: { value: 'York, New', provenance: 'explicit-source' } }], profile({
    locations: [rule('New York', 'mandatory')],
  }));
  assert.equal(result.excluded[0].code, 'mandatory-location-unmet');
});

test('unconfirmed target hard rules do not exclude', () => {
  const result = filterVacancies([softwareJob], profile({
    primaryTitles: [rule('Data Engineer', 'hard-exclusion', 'unconfirmed-inference')],
  }));
  assert.deepEqual(result, { eligible: [softwareJob], excluded: [] });
});

test('unconfirmed inferred mandatory rules remain non-blocking', () => {
  const result = filterVacancies([softwareJob], profile({
    primaryTitles: [rule('Data Engineer', 'mandatory', 'unconfirmed-inference')],
  }));

  assert.deepEqual(result, { eligible: [softwareJob], excluded: [] });
});

test('multiple mandatory accepted values for one field are alternatives', () => {
  const result = filterVacancies([softwareJob], profile({
    primaryTitles: [
      rule('Data Engineer', 'mandatory'),
      rule('Software Engineer', 'mandatory'),
    ],
  }));

  assert.deepEqual(result, { eligible: [softwareJob], excluded: [] });
});

test('exclude unknown compensation policy rejects non-comparable supplied values', () => {
  const incompatible = {
    ...softwareJob,
    compensation: {
      value: { minimum: 90000, maximum: 100000, currency: 'USD', period: 'year', rateType: 'salary' },
      provenance: 'explicit-source',
    },
  };
  const result = filterVacancies([incompatible], {
    ...profile({ salaryUnknownPolicy: 'exclude', minimum: 60000 }),
    compensation: {
      currency: 'GBP', period: 'year', rateType: 'salary',
      minimum: 60000, minimumStrength: 'strong-preference', unknownPolicy: 'exclude',
    },
  });

  assert.equal(result.eligible.length, 0);
  assert.equal(result.excluded[0].code, 'compensation-non-comparable');
});

test('structured title and employer rules read compacted runtime candidate fields', () => {
  const candidate = { vacancyId: 'runtime-001', company: 'Acme', role: 'Software Engineer', workingType: 'permanent', description: '' };
  const title = filterVacancies([candidate], profile({ primaryTitles: [rule('Data Engineer', 'mandatory')] }));
  assert.equal(title.excluded[0].code, 'mandatory-title-unmet');
  const employer = filterVacancies([candidate], {
    ...profile(), negative: { excludedTitles: [], excludedEmployers: [rule('Acme', 'hard-exclusion', 'explicit')] },
  });
  assert.equal(employer.excluded[0].code, 'excluded-employer');
});
