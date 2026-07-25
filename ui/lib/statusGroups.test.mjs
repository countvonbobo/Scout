import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUSES } from './tracker.mjs';
import {
  TRIAGE_STATUSES, OPEN_STATUSES, ACTIVE_STATUSES, CLOSED_STATUSES,
  DISMISSED_STATUSES, VERIFIABLE_STATUSES,
  isTriage, isOpen, isActive, isClosed, isDismissed, isVerifiable,
} from './statusGroups.mjs';

test('every tracker status belongs to exactly one primary group', () => {
  const primary = [...TRIAGE_STATUSES, ...OPEN_STATUSES, ...ACTIVE_STATUSES, ...CLOSED_STATUSES];
  assert.deepEqual([...primary].sort(), [...STATUSES].sort());
  assert.equal(new Set(primary).size, primary.length, 'a status appears in two primary groups');
});

test('shortlist is an open status, not triage and not active', () => {
  assert.ok(isOpen('shortlist'));
  assert.ok(!isTriage('shortlist'));
  assert.ok(!isActive('shortlist'));
  assert.ok(!isClosed('shortlist'));
});

test('only new is a triage status', () => {
  assert.deepEqual(TRIAGE_STATUSES, ['new']);
  assert.ok(isTriage('new'));
});

test('dismissed is a subset of closed', () => {
  for (const status of DISMISSED_STATUSES) assert.ok(isClosed(status));
  assert.ok(isDismissed('ignore'));
  assert.ok(!isDismissed('rejected'));
});

test('shortlisted and watched roles are worth verifying, closed ones are not', () => {
  assert.ok(isVerifiable('new'));
  assert.ok(isVerifiable('shortlist'));
  assert.ok(isVerifiable('watch'));
  assert.ok(!isVerifiable('applied'));
  assert.ok(!isVerifiable('ignore'));
  assert.deepEqual(VERIFIABLE_STATUSES, ['new', 'shortlist', 'watch']);
});

test('predicates reject unknown statuses', () => {
  for (const fn of [isTriage, isOpen, isActive, isClosed, isDismissed, isVerifiable]) {
    assert.equal(fn('not-a-status'), false);
    assert.equal(fn(undefined), false);
  }
});
