import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_SEARCH_LANES, deriveSearchLaneResults, generateSearchLanePlan, loadSearchLanePlan,
  reconcileSearchLanePlan, recordSearchLaneRun, restoreSearchLane,
  retireUnproductiveSearchLanes, selectSearchLanes, validateSearchLanePlan,
  writeSearchLanePlan,
} from './searchLanes.mjs';

function rule(value, strength = 'strong-preference') {
  return { value, strength, provenance: 'explicit' };
}

function profile({
  id = 'profile-aaaaaaaaaaaa',
  primaryTitles = [], titles = [], locations = [], industries = [], skills = [],
  workingPatterns = [], employers = [], exploration = 0.1,
} = {}) {
  return {
    id,
    version: 1,
    status: 'published',
    publishedAt: '2026-07-30T12:00:00.000Z',
    target: {
      primaryTitles: primaryTitles.map((value) => rule(value)),
      titles: titles.map((value) => rule(value, 'nice-to-have')),
      locations: locations.map((value) => rule(value)),
      industries: industries.map((value) => rule(value)),
      skills: skills.map((value) => rule(value)),
      workingPatterns: workingPatterns.map((value) => rule(value)),
      employers: employers.map((value) => rule(value)),
    },
    negative: { excludedResponsibilities: [] },
    compensation: {
      currency: null, period: 'year', minimum: null,
      minimumStrength: 'neutral', unknownPolicy: 'include',
    },
    selection: { breadth: 'balanced', relevanceThreshold: 45, exploration },
  };
}

test('lane generation is bounded, linear and traces every supported profile family', () => {
  const plan = generateSearchLanePlan(profile({
    primaryTitles: ['Platform engineer'],
    titles: ['Site reliability engineer'],
    locations: ['Manchester'],
    industries: ['Developer tools'],
    skills: ['Incident response'],
    workingPatterns: ['Remote'],
    employers: ['Example Systems'],
  }), { now: () => '2026-07-30T13:00:00.000Z' });

  assert.ok(plan.lanes.length <= MAX_SEARCH_LANES);
  assert.deepEqual(new Set(plan.lanes.map(({ kind }) => kind)), new Set([
    'title', 'exploration', 'location', 'industry', 'skill', 'remote-policy', 'employer',
  ]));
  for (const lane of plan.lanes) {
    assert.match(lane.id, /^lane-[a-f0-9]{16}$/);
    assert.ok(lane.query);
    assert.ok(lane.profileFields.length);
    assert.ok(lane.profileFields.every(({ path, ruleId }) => path && ruleId));
  }
  assert.ok(plan.lanes.some(({ profileFields }) => (
    profileFields.some(({ path }) => path === 'selection.exploration')
  )));
});

test('lane generation accepts deterministic derivation from a migrated profile', () => {
  const migrated = profile({ primaryTitles: ['Research coordinator'] });
  migrated.target.primaryTitles[0].provenance = 'deterministic-derivation';

  const plan = generateSearchLanePlan(migrated);

  assert.equal(plan.lanes.length, 1);
  assert.equal(
    plan.lanes[0].profileFields[0].provenance,
    'deterministic-derivation',
  );
});

test('six materially different domain profiles produce different neutral lane plans', () => {
  const fixtures = [
    profile({ id: 'profile-000000000001', primaryTitles: ['Junior developer'], locations: ['Remote'], skills: ['JavaScript'] }),
    profile({ id: 'profile-000000000002', primaryTitles: ['Hospital administrator'], industries: ['Healthcare'], skills: ['Service planning'] }),
    profile({ id: 'profile-000000000003', primaryTitles: ['Hospitality team member'], workingPatterns: ['Part-time'], locations: ['City centre'] }),
    profile({ id: 'profile-000000000004', primaryTitles: ['Commercial solicitor'], industries: ['Legal services'], skills: ['Contract negotiation'] }),
    profile({ id: 'profile-000000000005', primaryTitles: ['Graduate mechanical engineer'], industries: ['Manufacturing'], skills: ['CAD'] }),
    profile({ id: 'profile-000000000006', primaryTitles: ['Retail store manager'], employers: ['Example Retail'], skills: ['Team leadership'] }),
  ];
  const querySets = fixtures.map((value) => (
    generateSearchLanePlan(value).lanes.map(({ query }) => query).sort().join('|')
  ));

  assert.equal(new Set(querySets).size, fixtures.length);
  assert.equal(querySets.join('|').includes('Oxford'), false);
  assert.equal(querySets.join('|').includes('defence'), false);
  assert.equal(querySets.join('|').includes('60000'), false);
});

test('fair bounded selection is independent of stored order and rotates an unrun lower band', () => {
  const initial = generateSearchLanePlan(profile({
    primaryTitles: ['Primary one', 'Primary two'],
    titles: ['Adjacent one'],
    locations: ['North'],
    industries: ['Industry'],
    skills: ['Skill'],
  }));
  const first = selectSearchLanes(initial, { limit: 2 });
  const reversed = selectSearchLanes({ ...initial, lanes: [...initial.lanes].reverse() }, { limit: 2 });
  assert.deepEqual(first.map(({ id }) => id), reversed.map(({ id }) => id));

  const after = recordSearchLaneRun(initial, {
    runId: 'run-first',
    recordedAt: '2026-07-30T14:00:00.000Z',
    results: first.map(({ id }) => ({
      laneId: id, returned: 1, parsed: 1, new: 1, eligible: 1, selected: 1, promising: 1,
    })),
  });
  const next = selectSearchLanes(after, { limit: 2 });
  assert.ok(next.some((lane) => !first.some(({ id }) => id === lane.id)));
});

test('selective reconciliation preserves unaffected history and archives removed fields', () => {
  const beforeProfile = profile({
    primaryTitles: ['Platform engineer'],
    locations: ['Manchester'],
    skills: ['Observability'],
  });
  const before = generateSearchLanePlan(beforeProfile);
  const location = before.lanes.find(({ kind }) => kind === 'location');
  const skill = before.lanes.find(({ kind }) => kind === 'skill');
  const recorded = recordSearchLaneRun(before, {
    runId: 'run-history',
    recordedAt: '2026-07-30T15:00:00.000Z',
    results: [{
      laneId: skill.id, returned: 3, parsed: 3, new: 2, eligible: 2, selected: 1, promising: 1,
    }],
  });
  const nextProfile = profile({
    id: 'profile-bbbbbbbbbbbb',
    primaryTitles: ['Platform engineer'],
    locations: ['Leeds'],
    skills: ['Observability'],
  });
  const reconciled = reconcileSearchLanePlan(recorded, nextProfile);
  const preservedSkill = reconciled.lanes.find(({ id }) => id === skill.id);

  assert.equal(preservedSkill.history.length, 1);
  assert.equal(preservedSkill.aggregate.promising, 1);
  assert.equal(reconciled.lanes.some(({ id }) => id === location.id), false);
  assert.ok(reconciled.archivedLanes.some(({ id }) => id === location.id));
});

test('run history is idempotent and retirement is repeated, explicit and reversible', () => {
  const generated = generateSearchLanePlan(profile({ primaryTitles: ['Archivist'] }));
  const lane = generated.lanes[0];
  let plan = generated;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const event = {
      runId: `run-empty-${attempt}`,
      recordedAt: `2026-08-0${attempt}T10:00:00.000Z`,
      results: [{
        laneId: lane.id, returned: 0, parsed: 0, new: 0,
        eligible: 0, selected: 0, promising: 0,
      }],
    };
    plan = recordSearchLaneRun(plan, event);
    if (attempt === 1) {
      const duplicate = recordSearchLaneRun(plan, event);
      assert.deepEqual(duplicate, plan);
    }
  }
  assert.equal(plan.lanes[0].state, 'active');
  const retired = retireUnproductiveSearchLanes(plan, {
    minimumRuns: 3,
    now: () => '2026-08-03T10:00:00.000Z',
  });
  assert.equal(retired.lanes[0].state, 'retired');
  assert.equal(retired.lanes[0].history.length, 3);

  const restored = restoreSearchLane(retired, lane.id, {
    now: () => '2026-08-04T10:00:00.000Z',
  });
  assert.equal(restored.lanes[0].state, 'active');
  assert.equal(restored.lanes[0].history.length, 3);
  assert.equal(restored.lanes[0].retirement, null);
});

test('lane metrics reconcile exact query returns with persisted discovery and assessment evidence', () => {
  const generated = generateSearchLanePlan(profile({
    primaryTitles: ['Platform engineer'],
    skills: ['Observability'],
  }));
  const titleLane = generated.lanes.find(({ kind }) => kind === 'title');
  const skillLane = generated.lanes.find(({ kind }) => kind === 'skill');
  const results = deriveSearchLaneResults({
    lanes: [titleLane, skillLane],
    sources: {
      hiring_cafe: {
        queryCounts: {
          [titleLane.query]: 3,
          [skillLane.query]: 2,
        },
        queryFailures: {
          [skillLane.query]: 'source-query-failed',
        },
        observations: [
          { observationId: 'observation-a', laneIds: [titleLane.id, skillLane.id] },
          { observationId: 'observation-b', laneIds: [titleLane.id] },
        ],
      },
      adzuna: {
        queryCounts: { [titleLane.query]: 4, [skillLane.query]: 1 },
        observations: [
          { observationId: 'observation-c', laneIds: [skillLane.id] },
        ],
      },
    },
    ranked: [
      {
        vacancyId: 'vacancy-new',
        laneIds: [titleLane.id, skillLane.id],
        dimensions: [{ name: 'novelty', evidence: [{ comparison: 'unseen' }] }],
      },
      {
        vacancyId: 'vacancy-seen',
        laneIds: [titleLane.id],
        dimensions: [{ name: 'novelty', evidence: [{ comparison: 'seen-exact' }] }],
      },
    ],
    candidates: [
      { vacancyId: 'vacancy-new', laneIds: [titleLane.id, skillLane.id] },
    ],
    reviewed: [
      { vacancyId: 'vacancy-new', outcome: 'kept' },
    ],
  });

  assert.deepEqual(results, [
    {
      laneId: titleLane.id,
      returned: 7,
      parsed: 2,
      new: 1,
      eligible: 2,
      selected: 1,
      promising: 1,
    },
    {
      laneId: skillLane.id,
      returned: 3,
      parsed: 2,
      new: 1,
      eligible: 1,
      selected: 1,
      promising: 1,
      failures: [{ source: 'hiring-cafe', code: 'source-query-failed' }],
    },
  ]);
});

test('one lane can have only one result per run', () => {
  const generated = generateSearchLanePlan(profile({ primaryTitles: ['Archivist'] }));
  const laneId = generated.lanes[0].id;
  const result = {
    laneId, returned: 0, parsed: 0, new: 0, eligible: 0, selected: 0, promising: 0,
  };
  assert.throws(() => recordSearchLaneRun(generated, {
    runId: 'run-duplicate-result',
    recordedAt: '2026-08-01T10:00:00.000Z',
    results: [result, result],
  }), /duplicated/);
});

test('lane-plan validation rejects forged definitions and duplicate run evidence', () => {
  const generated = generateSearchLanePlan(profile({ primaryTitles: ['Archivist'] }));
  const forged = structuredClone(generated);
  forged.lanes[0].id = 'lane-ffffffffffffffff';
  assert.throws(() => validateSearchLanePlan(forged), /identity/);

  const laneId = generated.lanes[0].id;
  const recorded = recordSearchLaneRun(generated, {
    runId: 'run-once',
    recordedAt: '2026-08-01T10:00:00.000Z',
    results: [{
      laneId, returned: 1, parsed: 1, new: 1, eligible: 1, selected: 1, promising: 1,
    }],
  });
  const duplicated = structuredClone(recorded);
  duplicated.lanes[0].history.push(structuredClone(duplicated.lanes[0].history[0]));
  assert.throws(() => validateSearchLanePlan(duplicated), /history.*duplicated/);
});

test('validated private lane plans round-trip atomically', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-lanes-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const plan = generateSearchLanePlan(profile({ primaryTitles: ['Research coordinator'] }));
  writeSearchLanePlan(root, plan);
  assert.deepEqual(loadSearchLanePlan(root), plan);
});
