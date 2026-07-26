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
    parsed: 129, normalised: 128, duplicateObservations: 8,
    uniqueVacancies: 120, deterministicallyExcluded: 20,
    eligible: 100, ranked: 100, aboveThreshold: 75, selected: 60,
  });
  assert.equal(assertDiscoveryFunnel(complete).selected, 60);
});

test('funnel preserves source-level observation and failure counts', () => {
  const funnel = createDiscoveryFunnel({
    first: { count: 3, errors: ['failed record'] },
    second: { count: 2, errors: [] },
  });

  assert.equal(funnel.sourceRecords, 5);
  assert.equal(funnel.failedSourceRecords, 1);
  assert.deepEqual(funnel.bySource, {
    first: { count: 3, failedRecords: 1 },
    second: { count: 2, failedRecords: 0 },
  });
});

test('funnel rejects source counts that do not reconcile with parsed records', () => {
  const funnel = advanceDiscoveryFunnel(createDiscoveryFunnel({
    source: { count: 2, errors: ['malformed record'] },
  }), 'selection', {
    sourceRecords: 0, failedSourceRecords: 0,
  });

  assert.throws(() => assertDiscoveryFunnel(funnel), /parsed must equal source records minus failed source records/);
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
