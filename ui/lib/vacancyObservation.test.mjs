import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseObservation } from './vacancyObservation.mjs';

const NOW = '2026-07-26T20:00:00.000Z';

test('normalisation preserves explicit values and unknowns with provenance', () => {
  const observation = normaliseObservation({
    providerId: 'job-1', title: 'Store Manager', company: 'Acme',
    url: 'https://jobs.example/1?utm_source=board',
    location: '', salary: null, description: 'Permanent full-time role',
  }, { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-1' });

  assert.equal(observation.canonicalUrl, 'https://jobs.example/1');
  assert.equal(observation.location.value, null);
  assert.equal(observation.location.provenance, 'unknown');
  assert.equal(observation.employmentType.value, 'permanent');
  assert.equal(observation.employmentType.provenance, 'deterministic-extraction');
  assert.equal(observation.workingPattern.value, 'full-time');
  assert.equal(observation.fieldProvenance.location, 'unknown');
  assert.equal(observation.fetchedAt, NOW);
  assert.equal(observation.laneId, 'lane-1');
});

test('normalisation keeps stable identities despite tracking parameters and object key order', () => {
  const context = { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-1' };
  const first = normaliseObservation({
    providerId: 'job-1', title: 'Store Manager', company: 'Acme',
    url: 'https://jobs.example/1?utm_source=board&utm_campaign=spring', description: 'Role',
  }, context);
  const second = normaliseObservation({
    description: 'Role', url: 'https://jobs.example/1?utm_campaign=spring&utm_source=board',
    company: 'Acme', title: 'Store Manager', providerId: 'job-1',
  }, context);

  assert.equal(first.observationId, second.observationId);
  assert.equal(first.rawFingerprint, second.rawFingerprint);
});

test('normalisation avoids guessing ambiguous values and records a warning', () => {
  const observation = normaliseObservation({
    providerId: 'job-2', title: 'Engineer', company: 'Acme', url: 'https://jobs.example/2',
    description: 'Flexible arrangement and competitive salary.',
  }, { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-1' });

  assert.equal(observation.workingPattern.value, null);
  assert.equal(observation.compensation.value, null);
  assert.ok(observation.warnings.some((warning) => /ambiguous working pattern/i.test(warning)));
  assert.ok(observation.warnings.some((warning) => /ambiguous compensation/i.test(warning)));
});

test('normalisation parses explicit structured source fields without AI inference', () => {
  const observation = normaliseObservation({
    providerId: 'job-3', title: 'Senior Engineer', company: 'Acme', url: 'https://jobs.example/3',
    location: 'Leeds', workingType: 'Remote', employmentType: 'Contract',
    salaryMin: 60000, salaryMax: 70000, salaryCurrency: 'GBP', salaryPeriod: 'year', salaryRateType: 'salary',
    postedDate: '2026-07-01', description: 'Role',
  }, { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-1' });

  assert.deepEqual(observation.compensation.value, {
    minimum: 60000, maximum: 70000, currency: 'GBP', period: 'year', rateType: 'salary',
  });
  assert.equal(observation.compensation.provenance, 'explicit-source');
  assert.equal(observation.seniority.value, 'senior');
  assert.equal(observation.seniority.provenance, 'deterministic-extraction');
  assert.equal(observation.postedAt, '2026-07-01');
});

test('normalisation records warnings when bounded extraction is ambiguous and freezes nested values', () => {
  const observation = normaliseObservation({
    providerId: 'job-4', title: 'Senior Lead Engineer', company: 'Acme', url: 'https://jobs.example/4',
    description: 'Permanent contract with remote and hybrid working in this full-time role.',
    salaryMin: 60000, salaryMax: 70000, salaryCurrency: 'GBP', salaryPeriod: 'year',
  }, { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-1' });

  assert.equal(observation.employmentType.value, null);
  assert.equal(observation.seniority.value, null);
  assert.equal(observation.workingPattern.value, null);
  assert.ok(observation.warnings.some((warning) => /ambiguous employment type/i.test(warning)));
  assert.ok(observation.warnings.some((warning) => /ambiguous seniority/i.test(warning)));
  assert.ok(observation.warnings.some((warning) => /ambiguous working pattern/i.test(warning)));
  assert.throws(() => { observation.compensation.value.minimum = 1; }, TypeError);
  assert.throws(() => { observation.warnings.push('mutated'); }, TypeError);
});

test('normalisation preserves complete structured source evidence and lifecycle dates', () => {
  const observation = normaliseObservation({
    providerId: 'job-5',
    employerReference: 'employer-42',
    title: 'Clinical Operations Lead',
    company: 'Health Co',
    url: 'https://jobs.example/5',
    description: 'Lead a regulated service.',
    responsibilities: ['Service improvement', ' Service improvement ', 'Team leadership'],
    skills: ['Stakeholder facilitation', 'Risk management'],
    qualifications: ['Professional registration'],
    eligibility: ['Right to work'],
    industry: 'Healthcare',
    salaryMin: 5000,
    salaryMax: 5500,
    salaryCurrency: 'EUR',
    salaryPeriod: 'month',
    salaryRateType: 'salary',
    compensationAmountType: 'base',
    compensationCertainty: 'range',
    postedAt: '2026-07-01T00:00:00.000Z',
    closingAt: '2026-08-01T23:59:59.000Z',
    firstSeenAt: '2026-07-02T10:00:00.000Z',
    lastSeenAt: '2026-07-03T10:00:00.000Z',
  }, { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-clinical' });

  assert.equal(observation.employerReference.value, 'employer-42');
  assert.deepEqual(observation.responsibilities.value, ['Service improvement', 'Team leadership']);
  assert.deepEqual(observation.skills.value, ['Stakeholder facilitation', 'Risk management']);
  assert.deepEqual(observation.qualifications.value, ['Professional registration']);
  assert.deepEqual(observation.eligibility.value, ['Right to work']);
  assert.equal(observation.industry.value, 'Healthcare');
  assert.deepEqual(observation.compensation.value, {
    minimum: 5000,
    maximum: 5500,
    currency: 'EUR',
    period: 'month',
    rateType: 'salary',
    amountType: 'base',
    certainty: 'range',
  });
  assert.equal(observation.postedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(observation.closingAt, '2026-08-01T23:59:59.000Z');
  assert.equal(observation.firstSeenAt, '2026-07-02T10:00:00.000Z');
  assert.equal(observation.lastSeenAt, '2026-07-03T10:00:00.000Z');
  for (const field of [
    'employerReference', 'responsibilities', 'skills', 'qualifications', 'eligibility', 'industry',
  ]) {
    assert.equal(observation.fieldProvenance[field], 'explicit-source');
  }
});

test('normalisation retains only bounded redacted diagnostics and a raw fingerprint', () => {
  const observation = normaliseObservation({
    providerId: 'job-6',
    title: 'Engineer',
    company: 'Acme',
    url: 'https://jobs.example/6',
    description: 'Flexible arrangement and competitive salary.',
    diagnostic: 'Authorization Bearer PRIVATE_SOURCE_TOKEN',
    rawPayload: { value: 'PRIVATE_RAW_VALUE' },
    skills: Array.from({ length: 40 }, (_, index) => `Skill ${index} ${'x'.repeat(400)}`),
  }, { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-1' });
  const stored = JSON.stringify(observation);

  assert.deepEqual(Object.keys(observation.diagnostics).sort(), [
    'codes', 'rawPayloadRetained', 'retention',
  ]);
  assert.equal(observation.diagnostics.rawPayloadRetained, false);
  assert.equal(observation.diagnostics.retention, 'fingerprint-only');
  assert.ok(observation.diagnostics.codes.length <= 16);
  assert.equal(observation.skills.value.length, 32);
  assert.ok(observation.skills.value.every((value) => value.length <= 300));
  assert.match(observation.rawFingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(stored, /PRIVATE_SOURCE_TOKEN|PRIVATE_RAW_VALUE|Authorization Bearer/);
});
