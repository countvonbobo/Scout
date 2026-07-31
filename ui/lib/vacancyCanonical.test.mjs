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
  description = DESCRIPTION, laneId = 'lane-1', roleFamily = '', ...overrides
} = {}) {
  return normaliseObservation({
    providerId, url, title: 'Platform Engineer', company: 'Acme Ltd', location,
    seniority, employmentType, description, roleFamily, ...overrides,
  }, { sourceName: source, fetchedAt: '2026-07-26T20:00:00.000Z', laneId });
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

test('canonicalisation is stable when the same observations arrive in another order', () => {
  const observations = [
    observation({ source: 'adzuna', providerId: 'a-1', description: 'Build systems A.', employmentType: 'permanent' }),
    observation({ source: 'greenhouse', providerId: 'g-1', description: 'Build systems B.', employmentType: 'full-time' }),
    observation({ providerId: 'data-1', url: 'https://careers.acme.test/jobs/data-engineer', title: 'Data Engineer' }),
  ];

  assert.deepEqual(canonicaliseObservations(observations), canonicaliseObservations([...observations].reverse()));
});

test('canonicalisation merges source-traceable rule evidence from a shorter duplicate', () => {
  const excludedRule = {
    id: 'rule-operate-gambling-products',
    fact: 'operate gambling products',
  };
  const shorter = {
    ...observation({
      source: 'adzuna',
      providerId: 'adzuna-exclusion',
      description: 'Operate gambling products.',
    }),
    semanticEvidence: {
      descriptionPresent: true,
      descriptionDigest: 'a'.repeat(64),
      descriptionLength: 27,
      profileRuleMatches: [excludedRule],
      responsibilityFacts: ['operate gambling products'],
      mandatorySignals: [],
    },
  };
  const longer = {
    ...observation({
      source: 'greenhouse',
      providerId: 'greenhouse-longer',
      description: DESCRIPTION.repeat(4),
    }),
    semanticEvidence: {
      descriptionPresent: true,
      descriptionDigest: 'b'.repeat(64),
      descriptionLength: DESCRIPTION.length * 4,
      profileRuleMatches: [],
      responsibilityFacts: ['design reliable platform services'],
      mandatorySignals: [],
    },
  };

  const forward = canonicaliseObservations([shorter, longer]).vacancies[0];
  const reverse = canonicaliseObservations([longer, shorter]).vacancies[0];

  assert.deepEqual(forward, reverse);
  assert.equal(forward.semanticEvidence.descriptionDigest, 'b'.repeat(64));
  assert.deepEqual(forward.semanticEvidence.profileRuleMatches, [{
    ...excludedRule,
    evidence: [{
      source: 'adzuna',
      providerId: 'adzuna-exclusion',
      descriptionDigest: 'a'.repeat(64),
      provenance: 'deterministic-extraction',
    }],
  }]);
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

test('canonical vacancies preserve structured evidence and observed lifecycle bounds', () => {
  const first = observation({
    source: 'adzuna',
    laneId: 'lane-primary',
    laneIds: ['lane-primary', 'lane-location'],
    roleFamily: 'platform',
    employerReference: 'acme-careers',
    responsibilities: ['Operate services'],
    skills: ['Incident response'],
    qualifications: ['Cloud certification'],
    eligibility: ['Right to work'],
    industry: 'Technology',
    postedAt: '2026-07-01T00:00:00.000Z',
    closingAt: '2026-08-10T00:00:00.000Z',
    firstSeenAt: '2026-07-02T00:00:00.000Z',
    lastSeenAt: '2026-07-03T00:00:00.000Z',
  });
  const second = observation({
    source: 'greenhouse',
    providerId: 'greenhouse-1',
    laneId: 'lane-adjacent',
    roleFamily: 'site-reliability',
    responsibilities: ['Operate services', 'Mentor engineers'],
    skills: ['Incident response', 'Observability'],
    qualifications: ['Cloud certification'],
    eligibility: ['Right to work'],
    industry: 'Technology',
    postedAt: '2026-06-30T00:00:00.000Z',
    closingAt: '2026-08-01T00:00:00.000Z',
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-04T00:00:00.000Z',
  });

  const vacancy = canonicaliseObservations([first, second]).vacancies[0];

  assert.equal(vacancy.canonicalUrl, DIRECT_URL);
  assert.equal(vacancy.employerReference.value, 'acme-careers');
  assert.deepEqual(vacancy.responsibilities.value, ['Mentor engineers', 'Operate services']);
  assert.deepEqual(vacancy.skills.value, ['Incident response', 'Observability']);
  assert.deepEqual(vacancy.qualifications.value, ['Cloud certification']);
  assert.deepEqual(vacancy.eligibility.value, ['Right to work']);
  assert.equal(vacancy.industry.value, 'Technology');
  assert.equal(vacancy.postedAt, '2026-06-30T00:00:00.000Z');
  assert.equal(vacancy.closingAt, '2026-08-01T00:00:00.000Z');
  assert.equal(vacancy.firstSeenAt, '2026-07-01T00:00:00.000Z');
  assert.equal(vacancy.lastSeenAt, '2026-07-04T00:00:00.000Z');
  assert.deepEqual(vacancy.laneIds, ['lane-adjacent', 'lane-location', 'lane-primary']);
  assert.equal(vacancy.laneId, 'lane-adjacent');
  assert.deepEqual(vacancy.roleFamilies, ['platform', 'site-reliability']);
  assert.equal(vacancy.roleFamily, 'platform');
});

test('URL-less canonical identities are stable, collision-free and source-order independent', () => {
  const first = observation({
    source: 'provider-z',
    providerId: 'reference-1',
    url: null,
    description: 'Build stable services.',
  });
  const second = observation({
    source: 'provider-z',
    providerId: 'reference-2',
    url: null,
    description: 'Build stable services.',
  });
  const separate = canonicaliseObservations([first, second]).vacancies;
  const firstAlone = canonicaliseObservations([first]).vacancies[0];
  const firstAloneId = firstAlone.vacancyId;
  const secondAloneId = canonicaliseObservations([second]).vacancies[0].vacancyId;

  assert.equal(separate.length, 2);
  assert.notEqual(firstAloneId, secondAloneId);
  assert.equal(new Set(separate.map(({ vacancyId }) => vacancyId)).size, 2);
  assert.ok(separate.every(({ vacancyId }) => /^vacancy-ref-[a-f0-9]{24}$/.test(vacancyId)));
  assert.deepEqual(
    separate.map(({ vacancyId }) => vacancyId).sort(),
    [firstAloneId, secondAloneId].sort(),
  );

  const crossSource = [
    first,
    observation({
      source: 'provider-a',
      providerId: 'other-reference',
      url: null,
      description: 'Build stable services.',
    }),
  ];
  const forward = canonicaliseObservations(crossSource, { priorVacancies: [firstAlone] });
  const reverse = canonicaliseObservations([...crossSource].reverse(), { priorVacancies: [firstAlone] });
  assert.equal(forward.vacancies.length, 1);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.vacancies[0].vacancyId, firstAloneId);
  assert.equal(forward.vacancies[0].sourceReferences.length, 2);
  assert.ok(forward.vacancies.every(
    ({ vacancyId }) => /^vacancy-ref-[a-f0-9]{24}$/.test(vacancyId),
  ));

  const laterEarlierSource = observation({
    source: 'provider-a',
    providerId: 'earlier-reference',
    url: null,
    description: 'Build stable services.',
  });
  const firstWithEarlier = canonicaliseObservations(
    [first, laterEarlierSource],
    { priorVacancies: [firstAlone] },
  ).vacancies;
  assert.equal(firstWithEarlier.length, 1);
  assert.equal(
    firstWithEarlier[0].vacancyId,
    firstAloneId,
  );

  const laterGreaterSource = observation({
    source: 'provider-zz',
    providerId: 'greater-reference',
    url: null,
    description: 'Build stable services.',
  });
  const firstWithGreater = canonicaliseObservations(
    [first, laterGreaterSource],
    { priorVacancies: [firstAlone] },
  ).vacancies;
  assert.equal(firstWithGreater.length, 1);
  assert.equal(
    firstWithGreater[0].vacancyId,
    firstAloneId,
  );

  const enriched = observation({
    source: 'provider-z',
    providerId: 'reference-1',
    url: null,
    location: 'London, Greater London, United Kingdom',
    seniority: 'senior',
    description: 'Build stable services.',
  });
  assert.equal(
    canonicaliseObservations([enriched], { priorVacancies: [firstAlone] }).vacancies[0].vacancyId,
    firstAloneId,
  );
});

test('privacy-canonical URLs remain unique for distinct same-source provider vacancies', () => {
  const vacancies = canonicaliseObservations([
    observation({
      source: 'provider-a',
      providerId: 'query-job-one',
      url: 'https://jobs.example.test/apply',
      description: 'Build stable services.',
    }),
    observation({
      source: 'provider-a',
      providerId: 'query-job-two',
      url: 'https://jobs.example.test/apply',
      description: 'Build stable services.',
    }),
  ]).vacancies;
  assert.equal(vacancies.length, 2);
  assert.equal(new Set(vacancies.map(({ vacancyId }) => vacancyId)).size, 2);
  assert.ok(vacancies.every(({ vacancyId }) => /^vacancy-ref-[a-f0-9]{24}$/.test(vacancyId)));

  const first = canonicaliseObservations([observation({
    source: 'provider-a',
    providerId: 'query-job-one',
    url: 'https://jobs.example.test/apply',
  })]).vacancies[0];
  const laterDistinct = canonicaliseObservations([observation({
    source: 'provider-a',
    providerId: 'query-job-two',
    url: 'https://jobs.example.test/apply',
  })], { priorVacancies: [first] }).vacancies[0];
  assert.equal(first.vacancyId, 'https://jobs.example.test/apply');
  assert.notEqual(laterDistinct.vacancyId, first.vacancyId);
});

test('canonicalisation rejects semantic responsibility overflow instead of truncating evidence', () => {
  const semantic = {
    ...observation({ source: 'provider-z', providerId: 'capacity-1' }),
    semanticEvidence: {
    descriptionPresent: true,
    descriptionDigest: 'c'.repeat(64),
    descriptionLength: 10_000,
    profileRuleMatches: [],
    responsibilityFacts: Array.from({ length: 65 }, (_, index) => `distinct fact ${index + 1}`),
    mandatorySignals: [],
    },
  };
  assert.throws(
    () => canonicaliseObservations([semantic]),
    /responsibility evidence exceeds the supported limit/,
  );
});
