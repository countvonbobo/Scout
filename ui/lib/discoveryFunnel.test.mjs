import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceDiscoveryFunnel,
  assertDiscoveryFunnel,
  createDiscoveryFunnel,
} from './discoveryFunnel.mjs';

test('funnel reconciles every observation before assessment selection', () => {
  const funnel = createDiscoveryFunnel({
    ats: { count: 100, errors: [] },
    hiring_cafe: { count: 30, errors: ['one malformed row'] },
  });
  const complete = advanceDiscoveryFunnel(funnel, 'selection', {
    parsed: 130, normalised: 130, duplicateObservations: 10,
    uniqueVacancies: 120, deterministicallyExcluded: 20,
    eligible: 100, ranked: 100, aboveThreshold: 75, selected: 60,
  });
  assert.equal(assertDiscoveryFunnel(complete).selected, 60);
});

test('funnel records source errors separately from failed records', () => {
  const funnel = createDiscoveryFunnel({
    first: { count: 3, errors: ['failed record'] },
    second: { count: 2, errors: [] },
  });

  assert.equal(funnel.sourceRecords, 5);
  assert.equal(funnel.sourceErrors, 1);
  assert.equal(funnel.failedSourceRecords, 0);
  assert.deepEqual(funnel.bySource, {
    first: { count: 3, failedRecords: 0, sourceErrors: 1 },
    second: { count: 2, failedRecords: 0, sourceErrors: 0 },
  });
});

test('unavailable and degraded sources never create negative observation counts', () => {
  const funnel = advanceDiscoveryFunnel(createDiscoveryFunnel({
    unavailable: { status: 'unavailable', count: 0, errors: ['portal unavailable'] },
    degraded: { status: 'degraded', count: 1, errors: ['another portal unavailable'] },
  }), 'selection', {
    parsed: 1, normalised: 1, duplicateObservations: 0,
    uniqueVacancies: 1, deterministicallyExcluded: 0,
    eligible: 1, ranked: 1, aboveThreshold: 1, selected: 1,
  });

  assert.equal(assertDiscoveryFunnel(funnel).normalised, 1);
  assert.equal(funnel.sourceErrors, 2);
  assert.equal(funnel.failedSourceRecords, 0);
});

test('funnel rejects source counts that do not reconcile with normalised records', () => {
  const funnel = advanceDiscoveryFunnel(createDiscoveryFunnel({
    source: { count: 2, failedRecords: 1, errors: ['portal warning'] },
  }), 'selection', {
    parsed: 2, normalised: 2,
  });

  assert.throws(() => assertDiscoveryFunnel(funnel), /normalised plus failed source records must equal parsed/);
});

test('funnel advances without mutating the previous snapshot', () => {
  const initial = createDiscoveryFunnel({ source: { count: 1, errors: [] } });
  const next = advanceDiscoveryFunnel(initial, 'selection', {
    parsed: 1, normalised: 1, duplicateObservations: 0,
    uniqueVacancies: 1, deterministicallyExcluded: 0,
    eligible: 1, ranked: 1, aboveThreshold: 1, selected: 1,
  });

  assert.notEqual(next, initial);
  assert.equal(initial.selected, 0);
  assert.equal(next.selected, 1);
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.bySource));
});

test('funnel rejects vacancies selected before every eligible vacancy is ranked', () => {
  const funnel = advanceDiscoveryFunnel(createDiscoveryFunnel({ source: { count: 2, errors: [] } }), 'selection', {
    parsed: 2, normalised: 2, duplicateObservations: 0, uniqueVacancies: 2,
    deterministicallyExcluded: 0, eligible: 2, ranked: 1,
  });

  assert.throws(() => assertDiscoveryFunnel(funnel), /every eligible vacancy must be ranked/);
});
