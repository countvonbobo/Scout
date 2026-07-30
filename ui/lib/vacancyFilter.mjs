import { compareCompensation } from './vacancyRank.mjs';

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

function blockingStructuredRule(rule) {
  if (rule?.provenance === 'unconfirmed-inference') return false;
  if (rule?.strength === 'mandatory') return true;
  return hardRule(rule);
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
  primaryTitles: ['title', 'title'], titles: ['title', 'title'], locations: ['location', 'location', 'location'],
  employmentTypes: ['employmentType', 'employment-type'], employers: ['employer', 'employer'],
});

const NEGATIVE_FIELDS = Object.freeze({
  excludedTitles: ['title', 'excluded-title'], excludedEmployers: ['employer', 'excluded-employer'],
  excludedEmploymentTypes: ['employmentType', 'excluded-employment-type'], excludedLocations: ['location', 'excluded-location'],
});

function fieldValue(vacancy, field) {
  const aliases = {
    title: ['title', 'role'], employer: ['employer', 'company'],
    employmentType: ['employmentType', 'employment', 'workingType'],
  };
  return (aliases[field] || [field]).map((name) => vacancy?.[name]).find((value) => value !== undefined && value !== null && value !== '');
}

function structuredExclusions(vacancy, profile) {
  const found = [];
  for (const [listName, [field, name, unknownPolicyField]] of Object.entries(POSITIVE_FIELDS)) {
    const rules = (profile?.target?.[listName] || []).filter(blockingStructuredRule);
    if (!rules.length) continue;
    const source = fieldValue(vacancy, field);
    const actual = valueOf(source);
    if (actual === null || actual === undefined || actual === '') {
      if (unknownPolicyField && profile?.unknownPolicies?.[unknownPolicyField] === 'exclude') {
        found.push({
          vacancyId: vacancy?.vacancyId || vacancy?.candidateId || vacancy?.canonicalUrl || 'unknown-vacancy',
          code: `${unknownPolicyField}-unknown`,
          profileRuleId: `policy-${unknownPolicyField}-unknown`,
          profileVersion: profileVersion(profile),
          evidence: {
            vacancy: null,
            rule: `unknown ${unknownPolicyField} policy: exclude`,
            comparison: 'unknown',
          },
          confidence: confidence(source),
          overrideable: true,
        });
      }
      continue;
    }
    if (rules.some((rule) => exactMatches(actual, rule.value))) continue;
    for (const rule of rules) {
      found.push(exclusion(vacancy, profile, `mandatory-${name}-unmet`, rule,
        { vacancy: actual, rule: rule.value }, confidence(source), true));
    }
  }
  for (const [listName, [field, code]] of Object.entries(NEGATIVE_FIELDS)) {
    for (const rule of profile?.negative?.[listName] || []) {
      if (!hardRule(rule)) continue;
      const source = fieldValue(vacancy, field);
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
  const semanticMatches = new Set((vacancy?.semanticEvidence?.profileRuleMatches || []).map((item) => (
    typeof item === 'string' ? item : item.id
  )));
  return (profile?.negative?.excludedResponsibilities || []).flatMap((rule) => {
    const matched = semanticMatches.has(ruleId(rule)) || phraseMatches(description, rule.value);
    if (!hardRule(rule) || !matched) return [];
    return [exclusion(vacancy, profile, 'excluded-responsibility', rule,
      {
        vacancy: vacancy?.semanticEvidence
          ? { digest: vacancy.semanticEvidence.descriptionDigest, matchedRule: ruleId(rule) }
          : description,
        rule: rule.value,
      }, 'explicit-source', false)];
  });
}

function compensationExclusions(vacancy, profile) {
  const source = vacancy?.compensation;
  const amount = valueOf(source);
  if (profile?.compensation?.unknownPolicy !== 'exclude') return [];
  const missing = amount === null || amount === undefined || amount === '';
  if (missing) {
    return [exclusion(vacancy, profile, 'compensation-unknown', null,
      {
        vacancy: null,
        rule: 'unknown compensation policy: exclude',
        comparison: 'unknown',
      }, confidence(source), true)];
  }
  if (profile?.compensation?.minimum === null || profile?.compensation?.minimum === undefined) return [];
  const comparison = compareCompensation(amount, profile.compensation);
  if (comparison !== 'unknown') return [];
  return [exclusion(vacancy, profile, 'compensation-non-comparable', null,
    {
      vacancy: amount,
      rule: 'unknown compensation policy: exclude',
      comparison,
    }, confidence(source), true)];
}

function learningScopeMatches(vacancy, change) {
  if (change.scope === 'profile-wide') return true;
  const actual = change.scope === 'employer'
    ? fieldValue(vacancy, 'employer')
    : fieldValue(vacancy, 'title');
  return normalise(valueOf(actual)) === normalise(change.value);
}

function reconsideredByLearning(vacancy, match, learningPolicy) {
  return (learningPolicy?.changes || []).some((change) => (
    change.kind === 'reconsider-rule'
    && change.profileRuleId === match.profileRuleId
    && learningScopeMatches(vacancy, change)
  ));
}

export function filterVacancies(vacancies, profile, {
  learningPolicy = null,
} = {}) {
  const eligible = [];
  const excluded = [];
  const reconsidered = [];
  for (const vacancy of vacancies || []) {
    const matches = [
      ...responsibilityExclusions(vacancy, profile),
      ...structuredExclusions(vacancy, profile),
      ...compensationExclusions(vacancy, profile),
    ];
    const active = matches.filter((match) => !reconsideredByLearning(vacancy, match, learningPolicy));
    reconsidered.push(...matches.filter((match) => reconsideredByLearning(vacancy, match, learningPolicy))
      .map((match) => ({
        ...match,
        learningVersionId: learningPolicy.id,
        reconsidered: true,
      })));
    if (active.length) excluded.push(...active);
    else eligible.push(vacancy);
  }
  return learningPolicy ? { eligible, excluded, reconsidered } : { eligible, excluded };
}
