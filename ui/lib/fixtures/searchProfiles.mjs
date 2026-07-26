import { publishSearchProfile } from '../searchProfile.mjs';

const PUBLISHED_AT = '2026-07-26T20:00:00.000Z';

function rule(value, strength = 'strong-preference') {
  return { value, strength, provenance: 'explicit' };
}

function profile({ title, fixtureId, arrangement, currency, period, rateType, unknownPolicy }) {
  return publishSearchProfile({
    version: 1,
    status: 'draft',
    target: {
      primaryTitles: [rule(title, 'mandatory')],
      locations: [rule(`${fixtureId} location`, 'strong-preference')],
      workingPatterns: [rule(arrangement, 'nice-to-have')],
      employmentTypes: [rule('permanent', 'nice-to-have')],
      sectors: [],
    },
    negative: {
      excludedTitles: [],
      excludedEmployers: [],
      excludedEmploymentTypes: [],
      excludedLocations: [],
      excludedResponsibilities: [],
    },
    compensation: {
      currency,
      period,
      rateType,
      minimum: 50,
      minimumStrength: 'strong-preference',
      unknownPolicy,
    },
  }, { publishedAt: PUBLISHED_AT });
}

export function softwareDeveloperProfile() {
  return profile({
    title: 'Software Developer', fixtureId: 'software-developer', arrangement: 'remote',
    currency: 'GBP', period: 'year', rateType: 'salary', unknownPolicy: 'include',
  });
}

export function hospitalAdministratorProfile() {
  return profile({
    title: 'Hospital Administrator', fixtureId: 'hospital-administrator', arrangement: 'on-site',
    currency: 'EUR', period: 'month', rateType: 'salary', unknownPolicy: 'penalise',
  });
}

export function hospitalityWorkerProfile() {
  return profile({
    title: 'Hospitality Worker', fixtureId: 'hospitality-worker', arrangement: 'flexible',
    currency: 'USD', period: 'hour', rateType: 'wage', unknownPolicy: 'exclude',
  });
}

export function commercialSolicitorProfile() {
  return profile({
    title: 'Commercial Solicitor', fixtureId: 'commercial-solicitor', arrangement: 'hybrid',
    currency: 'CHF', period: 'day', rateType: 'contract', unknownPolicy: 'include',
  });
}

export function mechanicalGraduateProfile() {
  return profile({
    title: 'Mechanical Engineering Graduate', fixtureId: 'mechanical-graduate', arrangement: 'field-based',
    currency: 'CAD', period: 'week', rateType: 'salary', unknownPolicy: 'penalise',
  });
}

export function retailManagerProfile() {
  return profile({
    title: 'Retail Manager', fixtureId: 'retail-manager', arrangement: 'shift-based',
    currency: 'AUD', period: 'shift', rateType: 'wage', unknownPolicy: 'exclude',
  });
}
