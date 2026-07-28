export const STRENGTH_WEIGHT = Object.freeze({
  mandatory: 1,
  'strong-preference': 0.8,
  'nice-to-have': 0.35,
  neutral: 0,
  'strong-negative': -0.7,
  'hard-exclusion': -1,
});

const POSITIVE_DIMENSIONS = Object.freeze([
  ['primaryTitles', 'title', 'phrase'],
  ['titles', 'title', 'phrase'],
  ['locations', 'location', 'phrase'],
  ['workingPatterns', 'workingPattern', 'exact'],
  ['employmentTypes', 'employmentType', 'exact'],
  ['seniority', 'seniority', 'exact'],
  ['employers', 'employer', 'phrase'],
  ['sectors', 'description', 'phrase'],
]);

const NEGATIVE_DIMENSIONS = Object.freeze([
  ['excludedTitles', 'title', 'phrase'],
  ['excludedEmployers', 'employer', 'phrase'],
  ['excludedEmploymentTypes', 'employmentType', 'exact'],
  ['excludedLocations', 'location', 'phrase'],
  ['excludedResponsibilities', 'description', 'phrase'],
]);

function valueOf(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value;
}

function normalise(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function ruleId(rule) {
  return `rule-${normalise(rule?.value).replace(/\s+/g, '-')}`;
}

function vacancyIdentifier(vacancy) {
  return String(vacancy?.vacancyId || vacancy?.candidateId || vacancy?.canonicalUrl
    || vacancy?.observationId || vacancy?.sourceRecordId || 'unknown-vacancy');
}

function field(vacancy, name) {
  const aliases = {
    title: ['title', 'role'], employer: ['employer', 'company'],
    workingPattern: ['workingPattern', 'workingType'], employmentType: ['employmentType', 'employment'],
  };
  return (aliases[name] || [name]).map((key) => vacancy?.[key])
    .find((value) => value !== undefined && value !== null) ?? null;
}

function match(value, ruleValue, mode) {
  const actual = normalise(value);
  const expected = normalise(ruleValue);
  if (!actual || !expected) return false;
  if (mode === 'exact') return actual === expected;
  const tokens = expected.split(' ');
  const actualTokens = new Set(actual.split(' '));
  return tokens.every((token) => actualTokens.has(token));
}

function evidenceFor(source, rule, matched, unknown = false) {
  return {
    vacancy: source === undefined ? null : valueOf(source), rule: rule.value,
    matched, ...(unknown ? { comparison: 'unknown' } : {}),
  };
}

function scoreRules(vacancy, name, sourceName, mode, rules) {
  const source = sourceName === 'description' ? vacancy?.description : field(vacancy, sourceName);
  const actual = valueOf(source);
  const suppliedSemanticEvidence = sourceName === 'description' ? vacancy?.semanticEvidence : null;
  const semanticEvidence = suppliedSemanticEvidence
    && (suppliedSemanticEvidence.descriptionPresent
      ?? Number(suppliedSemanticEvidence.descriptionLength || 0) > 0)
    ? suppliedSemanticEvidence
    : null;
  const semanticMatches = semanticEvidence
    ? new Set((semanticEvidence.profileRuleMatches || []).map((item) => (
      typeof item === 'string' ? item : item.id
    )))
    : null;
  const unknown = semanticMatches ? false : actual === null || actual === undefined || actual === '';
  const positiveRules = rules.filter((rule) => (STRENGTH_WEIGHT[rule?.strength] || 0) > 0);
  const maximum = positiveRules.reduce((total, rule) => total + STRENGTH_WEIGHT[rule.strength], 0);
  const confidenceWeight = rules.reduce((total, rule) => total + Math.abs(STRENGTH_WEIGHT[rule?.strength] || 0), 0);
  const matched = rules.filter((rule) => (
    semanticMatches ? semanticMatches.has(ruleId(rule)) : !unknown && match(actual, rule.value, mode)
  ));
  const score = matched.reduce((total, rule) => total + STRENGTH_WEIGHT[rule.strength], 0);
  return {
    name,
    score,
    maximum,
    confidence: confidenceWeight ? (unknown ? 0 : 1) : 1,
    confidenceWeight,
    evidence: rules.map((rule) => semanticMatches
      ? {
        vacancy: {
          digest: semanticEvidence.descriptionDigest,
          matchedRule: matched.includes(rule) ? ruleId(rule) : null,
        },
        rule: rule.value,
        matched: matched.includes(rule),
      }
      : evidenceFor(source, rule, matched.includes(rule), unknown)),
    profileRuleIds: rules.map(ruleId),
    contributions: matched.map((rule) => ({
      name, profileRuleId: ruleId(rule), score: STRENGTH_WEIGHT[rule.strength],
      evidence: semanticMatches
        ? { vacancy: { digest: semanticEvidence.descriptionDigest, matchedRule: ruleId(rule) }, rule: rule.value, matched: true }
        : evidenceFor(source, rule, true),
    })),
  };
}

export function compareCompensation(amount, preference) {
  if (preference?.minimum === null || preference?.minimum === undefined) return 'not-configured';
  const comparable = amount
    && Number.isFinite(amount.minimum)
    && amount.currency && preference.currency
    && amount.period && preference.period
    && amount.rateType && preference.rateType
    && normalise(amount.currency) === normalise(preference.currency)
    && normalise(amount.period) === normalise(preference.period)
    && normalise(amount.rateType) === normalise(preference.rateType);
  if (!comparable) return 'unknown';
  return amount.minimum >= preference.minimum ? 'meets-minimum' : 'below-minimum';
}

function compensationDimension(vacancy, profile) {
  const preference = profile?.compensation || {};
  const weight = STRENGTH_WEIGHT[preference.minimumStrength] || 0;
  const maximum = weight > 0 ? weight : 0;
  if (!maximum && weight === 0) {
    return { name: 'compensation', score: 0, maximum: 0, confidence: 1, confidenceWeight: 0, evidence: [], profileRuleIds: [], contributions: [] };
  }
  const source = field(vacancy, 'compensation');
  const amount = valueOf(source);
  const comparison = compareCompensation(amount, preference);
  const knownComparable = comparison === 'meets-minimum' || comparison === 'below-minimum';
  const meetsMinimum = comparison === 'meets-minimum';
  const belowMinimum = comparison === 'below-minimum';
  const unknownPenalty = !knownComparable && preference.unknownPolicy === 'penalise' ? maximum * 0.25 : 0;
  const rawScore = weight > 0 ? (meetsMinimum ? weight : -unknownPenalty) : (belowMinimum ? weight : -unknownPenalty);
  const score = Object.is(rawScore, -0) ? 0 : rawScore;
  const rule = { value: `${preference.currency || 'unknown'} ${preference.period || 'unknown'} ${preference.rateType || 'unknown'} ${preference.minimum}`, strength: preference.minimumStrength };
  return {
    name: 'compensation', score, maximum, confidence: knownComparable ? 1 : 0, confidenceWeight: Math.abs(weight),
    evidence: [{ vacancy: amount || null, rule: preference.minimum, comparison }],
    profileRuleIds: [ruleId(rule)],
    contributions: score ? [{ name: 'compensation', profileRuleId: ruleId(rule), score, evidence: { vacancy: amount || null, rule: preference.minimum, comparison } }] : [],
  };
}

function dimensionsFor(vacancy, profile) {
  const dimensions = [];
  for (const [name, sourceName, mode] of POSITIVE_DIMENSIONS) {
    const rules = profile?.target?.[name] || [];
    if (rules.length) dimensions.push(scoreRules(vacancy, name, sourceName, mode, rules));
  }
  for (const [name, sourceName, mode] of NEGATIVE_DIMENSIONS) {
    const rules = (profile?.negative?.[name] || []).filter((rule) => (STRENGTH_WEIGHT[rule?.strength] || 0) < 0);
    if (rules.length) dimensions.push(scoreRules(vacancy, name, sourceName, mode, rules));
  }
  if (profile?.compensation) dimensions.push(compensationDimension(vacancy, profile));
  return dimensions;
}

function dateValue(value) {
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function stableTieBreak(vacancy) {
  const vacancyId = vacancyIdentifier(vacancy);
  return {
    postedAt: vacancy?.postedAt || vacancy?.postedDate || null,
    employer: normalise(valueOf(field(vacancy, 'employer'))),
    title: normalise(valueOf(field(vacancy, 'title'))),
    vacancyId,
  };
}

function compareRanked(left, right) {
  if (right.preRankScore !== left.preRankScore) return right.preRankScore - left.preRankScore;
  if (right.preRankConfidence !== left.preRankConfidence) return right.preRankConfidence - left.preRankConfidence;
  const dateDifference = dateValue(right.stableTieBreak.postedAt) - dateValue(left.stableTieBreak.postedAt);
  if (dateDifference) return dateDifference;
  for (const key of ['employer', 'title', 'vacancyId']) {
    const comparison = left.stableTieBreak[key].localeCompare(right.stableTieBreak[key]);
    if (comparison) return comparison;
  }
  return 0;
}

export function rankVacancies(vacancies, profile, history = []) {
  void history;
  return (vacancies || []).map((vacancy) => {
    const dimensions = dimensionsFor(vacancy, profile);
    const positiveMaximum = dimensions.reduce((total, dimension) => total + dimension.maximum, 0);
    const rawScore = dimensions.reduce((total, dimension) => total + dimension.score, 0);
    const confidenceMaximum = dimensions.reduce((total, dimension) => total + dimension.confidenceWeight, 0);
    const weightedConfidence = dimensions.reduce((total, dimension) => total + dimension.confidenceWeight * dimension.confidence, 0);
    const preRankScore = positiveMaximum ? Math.round(Math.max(0, Math.min(100, (rawScore / positiveMaximum) * 100)) * 100) / 100 : 0;
    const preRankConfidence = confidenceMaximum ? Math.round((weightedConfidence / confidenceMaximum) * 10000) / 100 : 100;
    const contributions = dimensions.flatMap((dimension) => dimension.contributions);
    const publicDimensions = dimensions.map(({ contributions: _contributions, confidenceWeight: _confidenceWeight, ...dimension }) => dimension);
    return {
      ...vacancy,
      vacancyId: vacancyIdentifier(vacancy),
      preRankScore,
      preRankConfidence,
      dimensions: publicDimensions,
      contributions,
      stableTieBreak: stableTieBreak(vacancy),
    };
  }).sort(compareRanked);
}
