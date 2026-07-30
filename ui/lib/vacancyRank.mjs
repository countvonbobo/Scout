export const STRENGTH_WEIGHT = Object.freeze({
  mandatory: 1,
  'strong-preference': 0.8,
  'nice-to-have': 0.35,
  neutral: 0,
  'strong-negative': -0.7,
  'hard-exclusion': -1,
});

const REQUIRED_DIMENSIONS = Object.freeze([
  {
    name: 'title', sourceNames: ['title'], positive: ['primaryTitles', 'adjacentTitles', 'titles'],
    negative: ['excludedTitles'], mode: 'phrase',
  },
  {
    name: 'responsibilities', sourceNames: ['responsibilities'], fallbackDescription: true,
    positive: ['responsibilities'], negative: ['excludedResponsibilities'], mode: 'phrase',
  },
  {
    name: 'skills', sourceNames: ['skills'], fallbackDescription: true,
    positive: ['skills'], negative: ['excludedSkills'], mode: 'phrase',
  },
  {
    name: 'qualifications', sourceNames: ['qualifications'], fallbackDescription: true,
    positive: ['qualifications'], negative: ['excludedQualifications'], mode: 'phrase',
  },
  {
    name: 'industry', sourceNames: ['industry'], fallbackDescription: true,
    positive: ['industries', 'sectors'], negative: ['excludedIndustries', 'excludedSectors'], mode: 'phrase',
  },
  {
    name: 'location', sourceNames: ['location'], positive: ['locations'],
    negative: ['excludedLocations'], mode: 'phrase',
  },
  {
    name: 'workingPattern', sourceNames: ['workingPattern'], positive: ['workingPatterns'],
    negative: ['excludedWorkingPatterns'], mode: 'exact',
  },
  {
    name: 'seniority', sourceNames: ['seniority'], positive: ['seniority'],
    negative: ['excludedSeniority'], mode: 'exact',
  },
  {
    name: 'employerPreference', sourceNames: ['employer'], positive: ['employers'],
    negative: ['excludedEmployers'], mode: 'phrase',
  },
]);

const OPTIONAL_DIMENSIONS = Object.freeze([
  {
    name: 'employmentType', sourceNames: ['employmentType'], positive: ['employmentTypes'],
    negative: ['excludedEmploymentTypes'], mode: 'exact',
  },
  {
    name: 'eligibility', sourceNames: ['eligibility'], fallbackDescription: true,
    positive: ['eligibility'], negative: ['excludedEligibility'], mode: 'phrase',
  },
  {
    name: 'mobility', sourceNames: ['location'], fallbackDescription: true,
    positive: ['mobility'], negative: ['excludedMobility'], mode: 'phrase',
  },
]);

const SEARCH_BREADTH_BEHAVIOUR = Object.freeze({
  focused: Object.freeze({ freshnessMaximum: 1, freshnessHorizonDays: 30, noveltyMaximum: 0.35 }),
  balanced: Object.freeze({ freshnessMaximum: 0.8, freshnessHorizonDays: 90, noveltyMaximum: 0.8 }),
  broad: Object.freeze({ freshnessMaximum: 0.35, freshnessHorizonDays: 180, noveltyMaximum: 1 }),
});

const DAY_MS = 24 * 60 * 60 * 1000;

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

function evidenceValue(source, rule, matched, mode) {
  const actual = valueOf(source);
  if (!Array.isArray(actual)) return actual;
  return {
    itemCount: actual.length,
    matchedValue: matched
      ? actual.find((item) => match(item, rule.value, mode)) ?? null
      : null,
  };
}

function evidenceFor(source, rule, matched, unknown = false, mode = 'phrase') {
  return {
    vacancy: source === undefined ? null : evidenceValue(source, rule, matched, mode), rule: rule.value,
    matched, ...(unknown ? { comparison: 'unknown' } : {}),
  };
}

function hasValue(value) {
  const actual = valueOf(value);
  if (Array.isArray(actual)) return actual.some((item) => normalise(item));
  return actual !== null && actual !== undefined && normalise(actual) !== '';
}

function sourceFor(vacancy, dimension) {
  const structured = dimension.sourceNames.map((name) => field(vacancy, name)).find(hasValue);
  if (structured !== undefined) return { source: structured, descriptionFallback: false };
  if (dimension.fallbackDescription && hasValue(vacancy?.description)) {
    return { source: vacancy.description, descriptionFallback: true };
  }
  if (dimension.fallbackDescription && vacancy?.semanticEvidence) {
    return { source: null, descriptionFallback: true };
  }
  return { source: dimension.sourceNames.map((name) => field(vacancy, name))
    .find((value) => value !== undefined) ?? null, descriptionFallback: false };
}

function sourceMatches(source, expected, mode) {
  const actual = valueOf(source);
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => match(value, expected, mode));
}

function scoreRules(vacancy, dimension, rules, unknownPolicy = 'include') {
  const { source, descriptionFallback } = sourceFor(vacancy, dimension);
  const actual = valueOf(source);
  const suppliedSemanticEvidence = descriptionFallback ? vacancy?.semanticEvidence : null;
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
  const unknown = semanticMatches ? false : !hasValue(actual);
  const positiveRules = rules.filter((rule) => (STRENGTH_WEIGHT[rule?.strength] || 0) > 0);
  const maximum = positiveRules.reduce((total, rule) => total + STRENGTH_WEIGHT[rule.strength], 0);
  const confidenceWeight = rules.reduce((total, rule) => total + Math.abs(STRENGTH_WEIGHT[rule?.strength] || 0), 0);
  const matched = rules.filter((rule) => (
    semanticMatches
      ? semanticMatches.has(ruleId(rule))
      : !unknown && sourceMatches(source, rule.value, dimension.mode)
  ));
  const unknownPenalty = unknown && unknownPolicy === 'penalise' ? maximum * 0.25 : 0;
  const score = matched.reduce((total, rule) => total + STRENGTH_WEIGHT[rule.strength], 0)
    - unknownPenalty;
  return {
    name: dimension.name,
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
      : evidenceFor(source, rule, matched.includes(rule), unknown, dimension.mode)),
    profileRuleIds: rules.map(ruleId),
    contributions: [
      ...matched.map((rule) => ({
        name: dimension.name, profileRuleId: ruleId(rule), score: STRENGTH_WEIGHT[rule.strength],
        evidence: semanticMatches
          ? { vacancy: { digest: semanticEvidence.descriptionDigest, matchedRule: ruleId(rule) }, rule: rule.value, matched: true }
          : evidenceFor(source, rule, true, false, dimension.mode),
      })),
      ...(unknownPenalty ? [{
        name: dimension.name,
        profileRuleId: `policy-${dimension.name}-unknown`,
        score: -unknownPenalty,
        evidence: {
          vacancy: null,
          rule: `unknown ${dimension.name} policy: penalise`,
          comparison: 'unknown',
        },
      }] : []),
    ],
  };
}

export function compareCompensation(amount, preference) {
  if (preference?.minimum === null || preference?.minimum === undefined) return 'not-configured';
  const amountTypeComparable = !preference.amountType || preference.amountType === 'unknown'
    || !amount?.amountType
    || (amount.amountType !== 'unknown'
      && normalise(amount.amountType) === normalise(preference.amountType));
  const certaintyUsable = !amount?.certainty || amount.certainty !== 'unknown';
  const comparable = amount
    && Number.isFinite(amount.minimum)
    && amount.currency && preference.currency
    && amount.period && preference.period
    && amount.rateType && preference.rateType
    && normalise(amount.currency) === normalise(preference.currency)
    && normalise(amount.period) === normalise(preference.period)
    && normalise(amount.rateType) === normalise(preference.rateType)
    && amountTypeComparable
    && certaintyUsable;
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

function dimensionRules(profile, dimension) {
  const positive = dimension.positive.flatMap((name) => profile?.target?.[name] || []);
  const negative = dimension.negative.flatMap((name) => profile?.negative?.[name] || [])
    .filter((rule) => (STRENGTH_WEIGHT[rule?.strength] || 0) < 0);
  return [...positive, ...negative];
}

function round(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function temporalNotConfigured(name) {
  return {
    name, score: 0, maximum: 0, confidence: 1, confidenceWeight: 0,
    evidence: [{ comparison: 'not-configured', breadth: null }],
    profileRuleIds: [], contributions: [],
  };
}

function freshnessReference(vacancies) {
  const timestamps = (vacancies || []).flatMap((vacancy) => [
    vacancy?.lastSeenAt, vacancy?.firstSeenAt, vacancy?.postedAt, vacancy?.postedDate,
  ]).map(dateValue).filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : Number.NEGATIVE_INFINITY;
}

function freshnessDimension(vacancy, profile, referenceTimestamp) {
  const breadth = profile?.selection?.breadth;
  const behaviour = SEARCH_BREADTH_BEHAVIOUR[breadth];
  if (!behaviour) return temporalNotConfigured('freshness');
  const observedTimestamp = dateValue(vacancy?.postedAt || vacancy?.postedDate || vacancy?.firstSeenAt);
  const rule = { value: `${breadth} freshness`, strength: 'search-behaviour' };
  const profileRuleId = `search-breadth-${breadth}-freshness`;
  if (!Number.isFinite(observedTimestamp) || !Number.isFinite(referenceTimestamp)) {
    return {
      name: 'freshness', score: 0, maximum: behaviour.freshnessMaximum,
      confidence: 0, confidenceWeight: behaviour.freshnessMaximum,
      evidence: [{
        comparison: 'unknown', observedDate: null,
        referenceDate: Number.isFinite(referenceTimestamp) ? new Date(referenceTimestamp).toISOString() : null,
        horizonDays: behaviour.freshnessHorizonDays, breadth,
      }],
      profileRuleIds: [profileRuleId], contributions: [],
    };
  }
  const ageDays = Math.max(0, (referenceTimestamp - observedTimestamp) / DAY_MS);
  const ratio = Math.max(0, 1 - (ageDays / behaviour.freshnessHorizonDays));
  const score = round(behaviour.freshnessMaximum * ratio);
  const evidence = {
    comparison: ratio === 0 ? 'outside-horizon' : ageDays === 0 ? 'current' : 'within-horizon',
    observedDate: new Date(observedTimestamp).toISOString(),
    referenceDate: new Date(referenceTimestamp).toISOString(),
    ageDays: round(ageDays, 2),
    horizonDays: behaviour.freshnessHorizonDays,
    breadth,
  };
  return {
    name: 'freshness', score, maximum: behaviour.freshnessMaximum,
    confidence: 1, confidenceWeight: behaviour.freshnessMaximum,
    evidence: [evidence], profileRuleIds: [profileRuleId],
    contributions: score ? [{
      name: 'freshness', profileRuleId, score, evidence: { ...evidence, rule: rule.value },
    }] : [],
  };
}

function identityKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return `id:${text}`;
    url.hash = '';
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return `url:${url.toString()}`;
  } catch {
    return `id:${text}`;
  }
}

function identityValues(item) {
  const direct = [
    item?.vacancyId, item?.canonicalUrl, item?.sourceUrl, item?.url,
    item?.sourceRecordId, item?.providerId,
  ];
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  const references = Array.isArray(item?.sourceReferences) ? item.sourceReferences : [];
  const referenceValues = references.flatMap((reference) => [
    reference?.canonicalUrl, reference?.sourceUrl, reference?.url,
    reference?.sourceRecordId, reference?.providerId,
  ]);
  return [...new Set([...direct, ...sources, ...referenceValues].map(identityKey).filter(Boolean))];
}

function historyIdentityIndex(history) {
  const index = new Map();
  for (const entry of history || []) {
    for (const key of identityValues(entry)) {
      if (!index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

function noveltyDimension(vacancy, profile, historyIndex) {
  const breadth = profile?.selection?.breadth;
  const behaviour = SEARCH_BREADTH_BEHAVIOUR[breadth];
  if (!behaviour) return temporalNotConfigured('novelty');
  const profileRuleId = `search-breadth-${breadth}-novelty`;
  const identities = identityValues(vacancy);
  if (!identities.length) {
    return {
      name: 'novelty', score: 0, maximum: behaviour.noveltyMaximum,
      confidence: 0, confidenceWeight: behaviour.noveltyMaximum,
      evidence: [{ comparison: 'unknown', breadth, identity: null }],
      profileRuleIds: [profileRuleId], contributions: [],
    };
  }
  const matchedKey = identities.find((key) => historyIndex.has(key));
  const comparison = matchedKey ? 'seen-exact' : 'unseen';
  const score = matchedKey ? 0 : behaviour.noveltyMaximum;
  const evidence = {
    comparison,
    breadth,
    identity: matchedKey?.startsWith('url:') ? 'exact-url' : matchedKey ? 'exact-source-id' : 'stable-identity',
  };
  return {
    name: 'novelty', score, maximum: behaviour.noveltyMaximum,
    confidence: 1, confidenceWeight: behaviour.noveltyMaximum,
    evidence: [evidence], profileRuleIds: [profileRuleId],
    contributions: score ? [{ name: 'novelty', profileRuleId, score, evidence }] : [],
  };
}

function dimensionsFor(vacancy, profile, { referenceTimestamp, historyIndex }) {
  const dimensions = [];
  for (const dimension of REQUIRED_DIMENSIONS) {
    if (dimension.name === 'seniority') dimensions.push(compensationDimension(vacancy, profile));
    dimensions.push(scoreRules(
      vacancy,
      dimension,
      dimensionRules(profile, dimension),
      profile?.unknownPolicies?.[dimension.name] || 'include',
    ));
  }
  dimensions.push(
    freshnessDimension(vacancy, profile, referenceTimestamp),
    noveltyDimension(vacancy, profile, historyIndex),
  );
  for (const dimension of OPTIONAL_DIMENSIONS) {
    const rules = dimensionRules(profile, dimension);
    if (rules.length) {
      dimensions.push(scoreRules(
        vacancy,
        dimension,
        rules,
        profile?.unknownPolicies?.[dimension.name] || 'include',
      ));
    }
  }
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
  const candidates = vacancies || [];
  const referenceTimestamp = freshnessReference(candidates);
  const historyIndex = historyIdentityIndex(history);
  return candidates.map((vacancy) => {
    const dimensions = dimensionsFor(vacancy, profile, { referenceTimestamp, historyIndex });
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
