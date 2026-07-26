import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseObservation } from './vacancyObservation.mjs';
import {
  canonicaliseObservations, classifyVacancyChange, vacancyContentFingerprint,
} from './vacancyCanonical.mjs';

const DIRECT_URL = 'https://careers.acme.test/jobs/platform-engineer';
const DESCRIPTION = 'Design and operate reliable platform services, mentor engineers, and improve production reliability.';

function observation({
  source = 'adzuna', providerId = `${source}-1`, url = DIRECT_URL,
  location = 'London', seniority = 'senior', employmentType = 'permanent',
  description = DESCRIPTION, ...overrides
} = {}) {
  return normaliseObservation({
    providerId, url, title: 'Platform Engineer', company: 'Acme Ltd', location,
    seniority, employmentType, description, ...overrides,
  }, { sourceName: source, fetchedAt: '2026-07-26T20:00:00.000Z', laneId: 'lane-1' });
}

test('cross-source copies become one canonical vacancy with all observations', () => {
  const result = canonicaliseObservations([
    observation({ source: 'adzuna' }),
    observation({ source: 'greenhouse' }),
  ]);

  assert.equal(result.vacancies.length, 1);
  assert.equal(result.vacancies[0].observations.length, 2);
  assert.equal(result.duplicateObservations, 1);
});

test('canonicalisation keeps different provider IDs, locations, and seniorities separate', () => {
  assert.equal(canonicaliseObservations([
    observation({ providerId: '1' }), observation({ providerId: '2' }),
  ]).vacancies.length, 2);
  assert.equal(canonicaliseObservations([
    observation({ location: 'London' }), observation({ location: 'Edinburgh' }),
  ]).vacancies.length, 2);
  assert.equal(canonicaliseObservations([
    observation({ seniority: 'senior' }), observation({ seniority: 'lead' }),
  ]).vacancies.length, 2);
});

test('canonicalisation prefers explicit fields and the longer verified description', () => {
  const result = canonicaliseObservations([
    observation({ employmentType: 'permanent', description: 'Build services.' }),
    observation({ source: 'greenhouse', employmentType: '', description: `${DESCRIPTION} Own incident response and production improvements.` }),
  ]).vacancies[0];

  assert.equal(result.employmentType.value, 'permanent');
  assert.equal(result.description, `${DESCRIPTION} Own incident response and production improvements.`);
});

test('content fingerprints ignore tracking copy and identify material updates', () => {
  const oldJob = observation({ description: DESCRIPTION, url: `${DIRECT_URL}?utm_source=board` });
  const sameContent = { ...oldJob, fetchedAt: '2026-07-27T20:00:00.000Z', description: `${DESCRIPTION}\nApply now.` };

  assert.equal(vacancyContentFingerprint(oldJob), vacancyContentFingerprint(sameContent));
  assert.equal(classifyVacancyChange(oldJob, sameContent), 'minor');
  assert.equal(classifyVacancyChange(oldJob, { ...oldJob, compensation: { value: { minimum: 70000, maximum: 80000, currency: 'GBP', period: 'year' }, provenance: 'explicit-source' } }), 'material');
  assert.equal(classifyVacancyChange(oldJob, { ...oldJob, location: { value: 'Edinburgh', provenance: 'explicit-source' } }), 'material');
});

test('a live vacancy returning from a closed state is reopened', () => {
  const oldJob = { ...observation(), status: 'closed' };
  assert.equal(classifyVacancyChange(oldJob, { ...oldJob, status: 'open' }), 'reopened');
});
