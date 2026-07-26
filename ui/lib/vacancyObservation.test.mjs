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
    salaryMin: 60000, salaryMax: 70000, salaryCurrency: 'GBP', salaryPeriod: 'year',
    postedDate: '2026-07-01', description: 'Role',
  }, { sourceName: 'fixture', fetchedAt: NOW, laneId: 'lane-1' });

  assert.deepEqual(observation.compensation.value, { minimum: 60000, maximum: 70000, currency: 'GBP', period: 'year' });
  assert.equal(observation.compensation.provenance, 'explicit-source');
  assert.equal(observation.seniority.value, 'senior');
  assert.equal(observation.seniority.provenance, 'deterministic-extraction');
  assert.equal(observation.postedAt, '2026-07-01');
});

test('normalisation records warnings when bounded extraction is ambiguous and freezes nested values', () => {
  const observation = normaliseObservation({
    providerId: 'job-4', title: 'Senior Lead Engineer', company: 'Acme', url: 'https://jobs.example/4',
    description: 'Permanent contract with remote and hybrid working.',
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
