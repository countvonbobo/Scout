function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
}

function normalise(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function ruleId(rule) {
  return `rule-${normalise(rule?.value).replace(/\s+/g, '-')}`;
}

function profileVersion(profile) {
  return profile?.id || `version-${profile?.version ?? 'unknown'}`;
}

function confidence(value) {
  return value && typeof value === 'object' && value.provenance ? value.provenance : 'unknown';
}

function phraseMatches(value, phrase) {
  const target = normalise(value);
  const tokens = normalise(phrase).split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => target.split(' ').includes(token));
}

function exactMatches(value, rule) {
  return normalise(value) === normalise(rule);
}

function hardRule(rule) {
  return rule?.strength === 'hard-exclusion' && ['explicit', 'confirmed-inference'].includes(rule?.provenance);
}

function exclusion(vacancy, profile, code, rule, evidence, sourceConfidence, overrideable) {
  return {
    vacancyId: vacancy?.vacancyId || vacancy?.candidateId || vacancy?.canonicalUrl || 'unknown-vacancy',
    code,
    profileRuleId: rule ? ruleId(rule) : 'policy-compensation-unknown',
    profileVersion: profileVersion(profile),
    evidence,
    confidence: sourceConfidence,
    overrideable,
  };
}

const POSITIVE_FIELDS = Object.freeze({
  primaryTitles: ['title', 'title'], titles: ['title', 'title'], locations: ['location', 'location'],
  employmentTypes: ['employmentType', 'employment-type'], employers: ['employer', 'employer'],
});

const NEGATIVE_FIELDS = Object.freeze({
  excludedTitles: ['title', 'excluded-title'], excludedEmployers: ['employer', 'excluded-employer'],
  excludedEmploymentTypes: ['employmentType', 'excluded-employment-type'], excludedLocations: ['location', 'excluded-location'],
});

function structuredExclusions(vacancy, profile) {
  const found = [];
  for (const [listName, [field, name]] of Object.entries(POSITIVE_FIELDS)) {
    for (const rule of profile?.target?.[listName] || []) {
      if (!['mandatory', 'hard-exclusion'].includes(rule?.strength)) continue;
      if (rule?.strength === 'hard-exclusion' && !hardRule(rule)) continue;
      const source = vacancy?.[field];
      const actual = valueOf(source);
      if (actual === null || actual === undefined || actual === '') continue;
      if (!exactMatches(actual, rule.value)) {
        found.push(exclusion(vacancy, profile, `mandatory-${name}-unmet`, rule,
          { vacancy: actual, rule: rule.value }, confidence(source), true));
      }
    }
  }
  for (const [listName, [field, code]] of Object.entries(NEGATIVE_FIELDS)) {
    for (const rule of profile?.negative?.[listName] || []) {
      if (!hardRule(rule)) continue;
      const source = vacancy?.[field];
      const actual = valueOf(source);
      if (actual && exactMatches(actual, rule.value)) {
        found.push(exclusion(vacancy, profile, code, rule, { vacancy: actual, rule: rule.value }, confidence(source), true));
      }
    }
  }
  return found;
}

function responsibilityExclusions(vacancy, profile) {
  const description = String(vacancy?.description || '');
  return (profile?.negative?.excludedResponsibilities || []).flatMap((rule) => {
    if (!hardRule(rule) || !phraseMatches(description, rule.value)) return [];
    return [exclusion(vacancy, profile, 'excluded-responsibility', rule,
      { vacancy: description, rule: rule.value }, 'explicit-source', false)];
  });
}

function compensationExclusions(vacancy, profile) {
  const source = vacancy?.compensation;
  const amount = valueOf(source);
  if (amount !== null && amount !== undefined && amount !== '') return [];
  if (profile?.compensation?.unknownPolicy !== 'exclude') return [];
  return [exclusion(vacancy, profile, 'compensation-unknown', null,
    { vacancy: null, rule: 'unknown compensation policy: exclude' }, confidence(source), true)];
}

export function filterVacancies(vacancies, profile) {
  const eligible = [];
  const excluded = [];
  for (const vacancy of vacancies || []) {
    const matches = [
      ...responsibilityExclusions(vacancy, profile),
      ...structuredExclusions(vacancy, profile),
      ...compensationExclusions(vacancy, profile),
    ];
    if (matches.length) excluded.push(...matches);
    else eligible.push(vacancy);
  }
  return { eligible, excluded };
}
