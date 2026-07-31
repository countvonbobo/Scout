import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SPECIALIST_QUESTIONS, applyAdaptiveAnswers, buildAdaptiveQuestionnaire,
} from './adaptiveSetup.mjs';

function rule(value, strength = 'strong-preference') {
  return { value, strength, provenance: 'explicit' };
}

function draft(overrides = {}) {
  return {
    version: 1,
    status: 'draft',
    target: {
      primaryTitles: [rule('Platform engineer')],
      adjacentTitles: [],
      titles: [],
      locations: [],
      workingPatterns: [],
      employmentTypes: [],
      responsibilities: [],
      skills: [],
      qualifications: [],
      eligibility: [],
      sectors: [],
      seniority: [],
      employers: [],
      ...(overrides.target || {}),
    },
    negative: {
      excludedResponsibilities: [],
      ...(overrides.negative || {}),
    },
    compensation: {
      currency: 'GBP',
      period: 'year',
      minimum: null,
      minimumStrength: 'neutral',
      unknownPolicy: 'include',
    },
    unknownPolicies: { location: 'include' },
    selection: { breadth: 'balanced', relevanceThreshold: 45, exploration: 0.1 },
    ...overrides,
  };
}

test('universal questions precede bounded structured occupation-relevant follow-ups', () => {
  const questionnaire = buildAdaptiveQuestionnaire(draft());
  const universal = questionnaire.questions.filter(({ phase }) => phase === 'universal');
  const specialist = questionnaire.questions.filter(({ phase }) => phase === 'specialist');

  assert.ok(universal.length >= 6);
  assert.ok(specialist.length > 0);
  assert.ok(specialist.length <= MAX_SPECIALIST_QUESTIONS);
  assert.deepEqual(questionnaire.questions, [...universal, ...specialist]);
  assert.ok(specialist.every(({ prompt }) => /Platform engineer/i.test(prompt)));
  assert.ok(specialist.every(({ answer }) => (
    answer.kind === 'rules'
    && Number.isSafeInteger(answer.maxItems)
    && answer.maxItems > 0
  )));
  assert.equal(JSON.stringify(questionnaire).includes('software'), false);
});

test('specialist prompts remain neutral when no primary title exists', () => {
  const questionnaire = buildAdaptiveQuestionnaire(draft({
    target: { primaryTitles: [], titles: [] },
  }));
  assert.ok(questionnaire.questions
    .filter(({ phase }) => phase === 'specialist')
    .every(({ prompt }) => /this work/i.test(prompt)));
});

test('adaptive answers replace only their exact draft fields with explicit rules', () => {
  const original = draft({
    target: {
      locations: [rule('London')],
      skills: [rule('Old skill')],
      employers: [rule('Example Health')],
    },
  });
  const updated = applyAdaptiveAnswers(original, [
    {
      questionId: 'specialist-skills',
      values: [
        { value: 'Incident response', strength: 'strong-preference' },
        { value: 'Observability', strength: 'nice-to-have' },
      ],
    },
    {
      questionId: 'unknown-location-policy',
      value: 'penalise',
    },
  ]);

  assert.deepEqual(updated.target.skills, [
    rule('Incident response'),
    rule('Observability', 'nice-to-have'),
  ]);
  assert.deepEqual(updated.target.locations, original.target.locations);
  assert.deepEqual(updated.target.employers, original.target.employers);
  assert.equal(updated.unknownPolicies.location, 'penalise');
  assert.deepEqual(original.target.skills, [rule('Old skill')]);
});

test('adjacent-work reads and replaces the exact adjacentTitles field', () => {
  const original = draft({
    target: {
      adjacentTitles: [rule('Reliability engineer')],
      titles: [rule('Legacy broad title')],
    },
  });
  const question = buildAdaptiveQuestionnaire(original).questions
    .find(({ id }) => id === 'adjacent-work');
  assert.equal(question.field, 'target.adjacentTitles');
  assert.deepEqual(question.current, original.target.adjacentTitles);

  const updated = applyAdaptiveAnswers(original, [{
    questionId: 'adjacent-work',
    values: [{ value: 'Platform operations', strength: 'nice-to-have' }],
  }]);
  assert.deepEqual(updated.target.adjacentTitles, [rule('Platform operations', 'nice-to-have')]);
  assert.deepEqual(updated.target.titles, original.target.titles);
});

test('adaptive answers reject unbounded, unknown and unconfirmed blocking values', () => {
  const tooMany = Array.from({ length: 20 }, (_, index) => ({
    value: `Skill ${index}`,
    strength: 'nice-to-have',
  }));
  assert.throws(
    () => applyAdaptiveAnswers(draft(), [{ questionId: 'specialist-skills', values: tooMany }]),
    /at most/i,
  );
  assert.throws(
    () => applyAdaptiveAnswers(draft(), [{ questionId: 'unknown-question', value: 'x' }]),
    /unknown adaptive question/i,
  );
  assert.throws(
    () => applyAdaptiveAnswers(draft(), [{
      questionId: 'confirmed-exclusions',
      values: [{ value: 'Night shifts', strength: 'hard-exclusion' }],
    }]),
    /explicit confirmation/i,
  );

  const confirmed = applyAdaptiveAnswers(draft(), [{
    questionId: 'confirmed-exclusions',
    confirmed: true,
    values: [{ value: 'Night shifts', strength: 'hard-exclusion' }],
  }]);
  assert.deepEqual(confirmed.negative.excludedResponsibilities, [
    rule('Night shifts', 'hard-exclusion'),
  ]);
});
