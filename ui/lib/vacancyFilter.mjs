import { compareCompensation } from './vacancyRank.mjs';
import { profileRuleId } from './searchProfile.mjs';

function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
}

function normalise(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

function exclusion(vacancy, profile, code, rule, evidence, sourceConfidence, overrideable, exactRuleId = null) {
  return {
    vacancyId: vacancy?.vacancyId || vacancy?.candidateId || vacancy?.canonicalUrl || 'unknown-vacancy',
    code,
    profileRuleId: rule ? exactRuleId : 'policy-compensation-unknown',
    profileVersion: profileVersion(profile),
    evidence,
    confidence: sourceConfidence,
    overrideable,
  };
}

export const PROFILE_RULE_SUPPORT = Object.freeze([
  { dimension: 'title', code: 'title', target: ['primaryTitles', 'adjacentTitles', 'titles'], negative: ['excludedTitles'], field: 'title', mode: 'exact' },
  { dimension: 'responsibilities', code: 'responsibility', target: ['responsibilities'], negative: ['excludedResponsibilities'], field: 'responsibilities', mode: 'phrase', semantic: true },
  { dimension: 'skills', code: 'skill', target: ['skills'], negative: ['excludedSkills'], field: 'skills', mode: 'phrase', semantic: true },
  { dimension: 'qualifications', code: 'qualification', target: ['qualifications'], negative: ['excludedQualifications'], field: 'qualifications', mode: 'phrase', semantic: true },
  { dimension: 'eligibility', code: 'eligibility', target: ['eligibility'], negative: ['excludedEligibility'], field: 'eligibility', mode: 'phrase', semantic: true },
  { dimension: 'industry', code: 'industry', target: ['industries', 'sectors'], negative: ['excludedIndustries', 'excludedSectors'], field: 'industry', mode: 'phrase', semantic: true },
  { dimension: 'location', code: 'location', target: ['locations'], negative: ['excludedLocations'], field: 'location', mode: 'exact' },
  { dimension: 'mobility', code: 'mobility', target: ['mobility'], negative: ['excludedMobility'], field: 'location', mode: 'phrase', semantic: true },
  { dimension: 'workingPattern', code: 'working-pattern', target: ['workingPatterns'], negative: ['excludedWorkingPatterns'], field: 'workingPattern', mode: 'exact' },
  { dimension: 'employmentType', code: 'employment-type', target: ['employmentTypes'], negative: ['excludedEmploymentTypes'], field: 'employmentType', mode: 'exact' },
  { dimension: 'seniority', code: 'seniority', target: ['seniority'], negative: ['excludedSeniority'], field: 'seniority', mode: 'exact' },
  { dimension: 'employer', code: 'employer', target: ['employers'], negative: ['excludedEmployers'], field: 'employer', mode: 'exact' },
]);

function fieldValue(vacancy, field) {
  const aliases = {
    title: ['title', 'role'], employer: ['employer', 'company'],
    employmentType: ['employmentType', 'employment', 'workingType'],
  };
  return (aliases[field] || [field]).map((name) => vacancy?.[name]).find((value) => value !== undefined && value !== null && value !== '');
}

function semanticMatch(vacancy, rule, section, field) {
  const id = profileRuleId(section, field, rule);
  return (vacancy?.semanticEvidence?.profileRuleMatches || []).find((item) => (
    (typeof item === 'string' ? item : item?.id) === id
  )) || null;
}

function structuredMatch(source, rule, mode) {
  const actual = valueOf(source);
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => (
    mode === 'exact' ? exactMatches(value, rule.value) : phraseMatches(value, rule.value)
  ));
}

function knownSource(source) {
  const actual = valueOf(source);
  if (Array.isArray(actual)) return actual.some((value) => normalise(value));
  return actual !== null && actual !== undefined && actual !== '';
}

function ruleEvidence(vacancy, source, rule, semantic, exactRuleId) {
  if (semantic) {
    return {
      vacancy: {
        matchedRule: exactRuleId,
        sources: (typeof semantic === 'object' ? semantic.evidence || [] : []).slice(0, 8),
      },
      rule: rule.value,
    };
  }
  return { vacancy: valueOf(source), rule: rule.value };
}

function structuredExclusions(vacancy, profile) {
  const found = [];
  for (const support of PROFILE_RULE_SUPPORT) {
    const rules = support.target.flatMap((field) => (profile?.target?.[field] || [])
      .map((rule) => ({ field, rule })))
      .filter(({ rule }) => blockingStructuredRule(rule));
    if (!rules.length) continue;
    const source = fieldValue(vacancy, support.field);
    const matched = rules.find(({ field, rule }) => (
      structuredMatch(source, rule, support.mode)
      || (support.semantic && semanticMatch(vacancy, rule, 'target', field))
    ));
    if (matched) continue;
    if (!knownSource(source)) {
      if (profile?.unknownPolicies?.[support.dimension] === 'exclude') {
        found.push({
          vacancyId: vacancy?.vacancyId || vacancy?.candidateId || vacancy?.canonicalUrl || 'unknown-vacancy',
          code: `${support.code}-unknown`,
          profileRuleId: `policy-${support.code}-unknown`,
          profileVersion: profileVersion(profile),
          evidence: {
            vacancy: null,
            rule: `unknown ${support.dimension} policy: exclude`,
            comparison: 'unknown',
          },
          confidence: confidence(source),
          overrideable: true,
        });
      }
      continue;
    }
    for (const { field, rule } of rules) {
      found.push(exclusion(vacancy, profile, `mandatory-${support.code}-unmet`, rule,
        { vacancy: valueOf(source), rule: rule.value }, confidence(source), true,
        profileRuleId('target', field, rule)));
    }
  }
  for (const support of PROFILE_RULE_SUPPORT) {
    const source = fieldValue(vacancy, support.field);
    for (const field of support.negative) {
      for (const rule of profile?.negative?.[field] || []) {
        if (!hardRule(rule)) continue;
        const exactRuleId = profileRuleId('negative', field, rule);
        const semantic = support.semantic ? semanticMatch(vacancy, rule, 'negative', field) : null;
        const rawDescriptionMatch = support.semantic
          && !vacancy?.semanticEvidence
          && phraseMatches(vacancy?.description, rule.value);
        if (!structuredMatch(source, rule, support.mode) && !semantic && !rawDescriptionMatch) continue;
        found.push(exclusion(
          vacancy,
          profile,
          `excluded-${support.code}`,
          rule,
          ruleEvidence(vacancy, source, rule, semantic, exactRuleId),
          confidence(source),
          support.dimension !== 'responsibilities',
          exactRuleId,
        ));
      }
    }
  }
  return found;
}

function compensationExclusions(vacancy, profile) {
  const source = vacancy?.compensation;
  const amount = valueOf(source);
  const minimum = profile?.compensation?.minimum;
  const comparison = minimum === null || minimum === undefined
    ? 'not-configured'
    : compareCompensation(amount, profile.compensation);
  if (profile?.compensation?.minimumStrength === 'mandatory' && comparison === 'below-minimum') {
    return [{
      vacancyId: vacancy?.vacancyId || vacancy?.candidateId || vacancy?.canonicalUrl || 'unknown-vacancy',
      code: 'mandatory-compensation-unmet',
      profileRuleId: 'policy-compensation-minimum',
      profileVersion: profileVersion(profile),
      evidence: {
        vacancy: amount,
        rule: minimum,
        comparison,
      },
      confidence: confidence(source),
      overrideable: true,
    }];
  }
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
  if (minimum === null || minimum === undefined) return [];
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
  if (change.scope === 'employer') {
    return normalise(valueOf(fieldValue(vacancy, 'employer'))) === normalise(change.value);
  }
  const roleFamilies = [
    ...(Array.isArray(vacancy?.roleFamilies) ? vacancy.roleFamilies : []),
    vacancy?.roleFamilyId,
    vacancy?.roleFamily,
    vacancy?.targetRoleFamily,
  ].map(valueOf).map(normalise).filter(Boolean);
  return roleFamilies.includes(normalise(change.value));
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
