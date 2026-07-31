import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicaliseObservations } from './vacancyCanonical.mjs';
import { PROFILE_RULE_SUPPORT, filterVacancies } from './vacancyFilter.mjs';
import { normaliseObservation } from './vacancyObservation.mjs';

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

test('every published structured rule family has an explicit filter support contract', () => {
  assert.deepEqual(
    PROFILE_RULE_SUPPORT.map(({ dimension }) => dimension),
    [
      'title', 'responsibilities', 'skills', 'qualifications', 'eligibility',
      'industry', 'location', 'mobility', 'workingPattern', 'employmentType',
      'seniority', 'employer',
    ],
  );
});

test('mandatory working pattern and seniority contradictions exclude deterministically', () => {
  const vacancy = {
    ...softwareJob,
    workingPattern: { value: 'on-site', provenance: 'explicit-source' },
    seniority: { value: 'senior', provenance: 'explicit-source' },
  };
  const result = filterVacancies([vacancy], {
    ...profile(),
    target: {
      workingPatterns: [rule('remote', 'mandatory')],
      seniority: [rule('junior', 'mandatory')],
    },
    unknownPolicies: {
      workingPattern: 'include',
      seniority: 'include',
    },
  });

  assert.deepEqual(result.excluded.map(({ code }) => code), [
    'mandatory-working-pattern-unmet',
    'mandatory-seniority-unmet',
  ]);
});

test('mandatory structured unknowns follow policy while preferences remain ranking-only', () => {
  const vacancy = {
    ...softwareJob,
    workingPattern: { value: null, provenance: 'unknown' },
    skills: { value: ['JavaScript'], provenance: 'explicit-source' },
  };
  const base = {
    ...profile(),
    target: {
      workingPatterns: [rule('remote', 'mandatory')],
      skills: [
        rule('Rust', 'strong-preference'),
        rule('TypeScript', 'mandatory', 'unconfirmed-inference'),
      ],
    },
    unknownPolicies: { workingPattern: 'include' },
  };
  assert.deepEqual(filterVacancies([vacancy], base), { eligible: [vacancy], excluded: [] });

  const excluded = filterVacancies([vacancy], {
    ...base,
    unknownPolicies: { workingPattern: 'exclude' },
  });
  assert.equal(excluded.excluded[0].code, 'working-pattern-unknown');
  assert.equal(excluded.excluded[0].evidence.comparison, 'unknown');
});

test('strong negatives and unconfirmed hard rules do not exclude', () => {
  const result = filterVacancies([softwareJob], profile({
    excludedTitles: [rule('Software Engineer', 'strong-negative'), rule('Software Engineer', 'hard-exclusion', 'unconfirmed-inference')],
  }));
  assert.deepEqual(result, { eligible: [softwareJob], excluded: [] });
});

test('confirmed duplicate-source responsibility evidence blocks without hardening unconfirmed rules', () => {
  const canonical = canonicaliseObservations([
    {
      ...normaliseObservation({
        providerId: 'short-source',
        url: 'https://example.test/jobs/shared',
        title: 'Platform Engineer',
        company: 'Example Co',
        description: 'Operate gambling products.',
      }, {
        sourceName: 'adzuna',
        fetchedAt: '2026-07-31T08:00:00.000Z',
      }),
      semanticEvidence: {
        descriptionPresent: true,
        descriptionDigest: 'a'.repeat(64),
        descriptionLength: 27,
        profileRuleMatches: [{
          id: 'rule-operate-gambling-products',
          fact: 'operate gambling products',
        }],
        responsibilityFacts: ['operate gambling products'],
        mandatorySignals: [],
      },
    },
    {
      ...normaliseObservation({
        providerId: 'long-source',
        url: 'https://example.test/jobs/shared',
        title: 'Platform Engineer',
        company: 'Example Co',
        description: 'Build and operate reliable public-interest platforms. '.repeat(8),
      }, {
        sourceName: 'greenhouse',
        fetchedAt: '2026-07-31T08:00:00.000Z',
      }),
      semanticEvidence: {
        descriptionPresent: true,
        descriptionDigest: 'b'.repeat(64),
        descriptionLength: 400,
        profileRuleMatches: [],
        responsibilityFacts: ['build reliable public interest platforms'],
        mandatorySignals: [],
      },
    },
  ]).vacancies[0];
  const confirmed = profile({
    excludedResponsibilities: [
      rule('operate gambling products', 'hard-exclusion', 'confirmed-inference'),
    ],
  });

  const blocked = filterVacancies([canonical], confirmed);
  assert.equal(blocked.eligible.length, 0);
  assert.equal(blocked.excluded[0].code, 'excluded-responsibility');
  assert.deepEqual(blocked.excluded[0].evidence.vacancy.sources, [{
    source: 'adzuna',
    providerId: 'short-source',
    descriptionDigest: 'a'.repeat(64),
    provenance: 'deterministic-extraction',
  }]);

  const nonBlocking = filterVacancies([canonical], profile({
    excludedResponsibilities: [
      rule('operate gambling products', 'strong-negative', 'explicit'),
      rule('operate gambling products', 'hard-exclusion', 'unconfirmed-inference'),
    ],
  }));
  assert.deepEqual(nonBlocking, { eligible: [canonical], excluded: [] });
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

test('confirmed learned reconsideration is scoped, versioned and preserves exclusion evidence', () => {
  const rankedProfile = profile({
    primaryTitles: [rule('Data Engineer', 'mandatory')],
  });
  const policy = {
    id: 'learning-reviewed',
    changes: [{
      kind: 'reconsider-rule',
      profileRuleId: 'rule-data-engineer',
      scope: 'role-family',
      value: 'Software Engineer',
    }],
  };
  const result = filterVacancies([softwareJob], rankedProfile, { learningPolicy: policy });

  assert.deepEqual(result.eligible, [softwareJob]);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.reconsidered[0].profileRuleId, 'rule-data-engineer');
  assert.equal(result.reconsidered[0].learningVersionId, 'learning-reviewed');
  assert.equal(result.reconsidered[0].reconsidered, true);
});
