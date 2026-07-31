import { validateSearchProfile } from './searchProfile.mjs';

export const MAX_SPECIALIST_QUESTIONS = 6;

const RULE_STRENGTHS = Object.freeze([
  'mandatory', 'strong-preference', 'nice-to-have', 'neutral',
  'strong-negative', 'hard-exclusion',
]);

const UNIVERSAL = Object.freeze([
  {
    id: 'primary-work',
    field: 'target.primaryTitles',
    label: 'Primary work',
    prompt: 'Which titles or role families should Scout treat as your primary work?',
    maxItems: 8,
  },
  {
    id: 'adjacent-work',
    field: 'target.adjacentTitles',
    label: 'Adjacent work',
    prompt: 'Which adjacent titles would you genuinely consider?',
    maxItems: 8,
  },
  {
    id: 'accepted-locations',
    field: 'target.locations',
    label: 'Locations',
    prompt: 'Which locations or mobility areas should Scout search?',
    maxItems: 8,
  },
  {
    id: 'accepted-mobility',
    field: 'target.mobility',
    label: 'Mobility',
    prompt: 'Which travel, relocation or mobility arrangements would you consider?',
    maxItems: 8,
  },
  {
    id: 'working-patterns',
    field: 'target.workingPatterns',
    label: 'Working patterns',
    prompt: 'Which remote, hybrid or on-site working patterns are acceptable?',
    maxItems: 6,
  },
  {
    id: 'employment-arrangements',
    field: 'target.employmentTypes',
    label: 'Employment arrangements',
    prompt: 'Which permanent, contract, temporary, internship or other arrangements are acceptable?',
    maxItems: 6,
  },
  {
    id: 'confirmed-exclusions',
    field: 'negative.excludedResponsibilities',
    label: 'Confirmed exclusions',
    prompt: 'Which responsibilities or conditions should reduce or block a match?',
    maxItems: 10,
    allowBlocking: true,
  },
  {
    id: 'compensation-unknown-policy',
    field: 'compensation.unknownPolicy',
    label: 'Unknown compensation',
    prompt: 'Should jobs with unknown or non-comparable compensation be included, penalised or excluded?',
    enum: ['include', 'penalise', 'exclude'],
  },
  {
    id: 'unknown-location-policy',
    field: 'unknownPolicies.location',
    label: 'Unknown location',
    prompt: 'Should jobs with unknown location evidence be included, penalised or excluded?',
    enum: ['include', 'penalise', 'exclude'],
  },
  {
    id: 'search-behaviour',
    field: 'selection',
    label: 'Search breadth',
    prompt: 'Choose focused, balanced or broad search and a bounded exploration allocation.',
    object: true,
  },
]);

const SPECIALIST = Object.freeze([
  {
    id: 'specialist-responsibilities',
    field: 'target.responsibilities',
    label: 'Responsibilities',
    prompt: 'Which responsibilities distinguish suitable %s opportunities?',
    maxItems: 10,
  },
  {
    id: 'specialist-skills',
    field: 'target.skills',
    label: 'Skills',
    prompt: 'Which skills matter most for %s opportunities?',
    maxItems: 12,
  },
  {
    id: 'specialist-qualifications',
    field: 'target.qualifications',
    label: 'Qualifications',
    prompt: 'Which qualifications are relevant to %s opportunities?',
    maxItems: 10,
  },
  {
    id: 'specialist-eligibility',
    field: 'target.eligibility',
    label: 'Eligibility',
    prompt: 'Which eligibility or registration requirements apply to %s opportunities?',
    maxItems: 8,
  },
  {
    id: 'specialist-industries',
    field: 'target.sectors',
    label: 'Industries',
    prompt: 'Which industries or sectors should shape %s discovery?',
    maxItems: 10,
  },
  {
    id: 'specialist-seniority',
    field: 'target.seniority',
    label: 'Seniority',
    prompt: 'Which seniority levels fit %s opportunities?',
    maxItems: 6,
  },
  {
    id: 'specialist-employers',
    field: 'target.employers',
    label: 'Named employers',
    prompt: 'Which named employers should receive explicit attention for %s?',
    maxItems: 10,
  },
]);

function valueAt(root, path) {
  return path.split('.').reduce((value, key) => value?.[key], root);
}

function setAt(root, path, value) {
  const keys = path.split('.');
  let target = root;
  for (const key of keys.slice(0, -1)) {
    target[key] = target[key] && typeof target[key] === 'object'
      ? { ...target[key] }
      : {};
    target = target[key];
  }
  target[keys.at(-1)] = value;
}

function currentValues(draft, definition) {
  const value = valueAt(draft, definition.field);
  if (Array.isArray(value)) return structuredClone(value);
  if (value && typeof value === 'object') return structuredClone(value);
  return value ?? null;
}

function question(definition, phase, draft, prompt = definition.prompt) {
  return Object.freeze({
    id: definition.id,
    phase,
    field: definition.field,
    label: definition.label,
    prompt,
    answer: definition.enum
      ? Object.freeze({ kind: 'enum', values: definition.enum })
      : definition.object
        ? Object.freeze({ kind: 'search-behaviour' })
        : Object.freeze({
          kind: 'rules',
          maxItems: definition.maxItems,
          strengths: RULE_STRENGTHS,
          allowBlocking: Boolean(definition.allowBlocking),
        }),
    current: currentValues(draft, definition),
  });
}

function titleAnchor(draft) {
  const rule = [
    ...(draft?.target?.primaryTitles || []),
    ...(draft?.target?.adjacentTitles || []),
    ...(draft?.target?.titles || []),
  ].find((item) => String(item?.value || '').trim());
  return String(rule?.value || '').trim() || 'this work';
}

export function buildAdaptiveQuestionnaire(draft = {}) {
  const anchor = titleAnchor(draft);
  const universal = UNIVERSAL.map((definition) => question(definition, 'universal', draft));
  const specialist = [...SPECIALIST]
    .sort((left, right) => {
      const leftEmpty = (valueAt(draft, left.field) || []).length === 0 ? 0 : 1;
      const rightEmpty = (valueAt(draft, right.field) || []).length === 0 ? 0 : 1;
      return leftEmpty - rightEmpty;
    })
    .slice(0, MAX_SPECIALIST_QUESTIONS)
    .map((definition) => question(
      definition,
      'specialist',
      draft,
      definition.prompt.replace('%s', anchor),
    ));
  return Object.freeze({
    schemaVersion: 1,
    questions: Object.freeze([...universal, ...specialist]),
    specialistLimit: MAX_SPECIALIST_QUESTIONS,
  });
}

function definitionById(id) {
  return [...UNIVERSAL, ...SPECIALIST].find((definition) => definition.id === id);
}

function exactAnswerKeys(answer, allowed) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new TypeError('adaptive answer must be an object');
  }
  const unsupported = Object.keys(answer).find((key) => !allowed.includes(key));
  if (unsupported) throw new TypeError(`adaptive answer contains unsupported field: ${unsupported}`);
}

function ruleAnswers(answer, definition) {
  exactAnswerKeys(answer, ['questionId', 'values', 'confirmed']);
  if (!Array.isArray(answer.values)) throw new TypeError(`${definition.id} values must be an array`);
  if (answer.values.length > definition.maxItems) {
    throw new RangeError(`${definition.id} accepts at most ${definition.maxItems} values`);
  }
  const seen = new Set();
  return answer.values.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'strength,value') {
      throw new TypeError(`${definition.id} values must contain only value and strength`);
    }
    const value = String(item.value || '').trim();
    if (!value || value.length > 160) throw new TypeError(`${definition.id} values must be 1-160 characters`);
    if (seen.has(value.toLocaleLowerCase('en'))) throw new TypeError(`${definition.id} values must be unique`);
    seen.add(value.toLocaleLowerCase('en'));
    if (!RULE_STRENGTHS.includes(item.strength)) throw new TypeError(`${definition.id} strength is invalid`);
    if (['strong-negative', 'hard-exclusion'].includes(item.strength) && !definition.allowBlocking) {
      throw new TypeError(`${definition.id} cannot create negative or blocking rules`);
    }
    if (item.strength === 'hard-exclusion' && answer.confirmed !== true) {
      throw new TypeError(`${definition.id} hard exclusion requires explicit confirmation`);
    }
    return { value, strength: item.strength, provenance: 'explicit' };
  });
}

function enumAnswer(answer, definition) {
  exactAnswerKeys(answer, ['questionId', 'value']);
  if (!definition.enum.includes(answer.value)) {
    throw new TypeError(`${definition.id} must be one of: ${definition.enum.join(', ')}`);
  }
  return answer.value;
}

function searchBehaviourAnswer(answer) {
  exactAnswerKeys(answer, ['questionId', 'value']);
  const value = answer.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'breadth,exploration,relevanceThreshold') {
    throw new TypeError('search-behaviour must contain breadth, exploration and relevanceThreshold');
  }
  return structuredClone(value);
}

export function applyAdaptiveAnswers(draft, answers) {
  if (!Array.isArray(answers) || !answers.length) throw new TypeError('adaptive answers are required');
  const updated = structuredClone(draft);
  const seen = new Set();
  for (const answer of answers) {
    const definition = definitionById(answer?.questionId);
    if (!definition) throw new TypeError(`unknown adaptive question: ${answer?.questionId || ''}`);
    if (seen.has(definition.id)) throw new TypeError(`adaptive question is duplicated: ${definition.id}`);
    seen.add(definition.id);
    const value = definition.enum
      ? enumAnswer(answer, definition)
      : definition.object
        ? searchBehaviourAnswer(answer)
        : ruleAnswers(answer, definition);
    setAt(updated, definition.field, value);
  }
  return validateSearchProfile(updated);
}
