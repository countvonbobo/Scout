import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, followUpsDue, triage } from './derive.mjs';

test('daysBetween counts whole days', () => {
  assert.equal(daysBetween('2026-07-01', '2026-07-09'), 8);
  assert.equal(daysBetween('2026-07-09', '2026-07-09'), 0);
});

const entry = (over) => ({ id: 'x', company: 'X', status: 'new', score: 60, tags: [], log: [], ...over });

test('nudge due after 8 days with no reply', () => {
  const e = entry({ log: [{ date: '2026-07-01', event: 'outreach-sent', note: '' }] });
  assert.deepEqual(followUpsDue(e, '2026-07-09'), [{ kind: 'nudge', since: '2026-07-01' }]);
});

test('no nudge before 8 days', () => {
  const e = entry({ log: [{ date: '2026-07-05', event: 'outreach-sent', note: '' }] });
  assert.deepEqual(followUpsDue(e, '2026-07-09'), []);
});

test('a reply clears the nudge', () => {
  const e = entry({ log: [
    { date: '2026-07-01', event: 'outreach-sent', note: '' },
    { date: '2026-07-03', event: 'replied', note: '' },
  ] });
  assert.deepEqual(followUpsDue(e, '2026-07-20'), []);
});

test('closeout due 10 days after a nudge with no reply', () => {
  const e = entry({ log: [
    { date: '2026-07-01', event: 'outreach-sent', note: '' },
    { date: '2026-07-09', event: 'nudged', note: '' },
  ] });
  assert.deepEqual(followUpsDue(e, '2026-07-20'), [{ kind: 'closeout', since: '2026-07-09' }]);
});

test('closed event suppresses follow-ups', () => {
  const e = entry({ log: [
    { date: '2026-07-01', event: 'outreach-sent', note: '' },
    { date: '2026-07-02', event: 'closed', note: '' },
  ] });
  assert.deepEqual(followUpsDue(e, '2026-08-01'), []);
});

test('triage buckets by score and Check tag', () => {
  const data = { updated: 't', opportunities: [
    entry({ id: 'hi', score: 87 }),
    entry({ id: 'unlock', score: 62, tags: ['Needs Salary Check'] }),
    entry({ id: 'mid-no-tag', score: 62, tags: ['Startup'] }),
    entry({ id: 'low', score: 30 }),
    entry({ id: 'unscored', score: null }),
  ] };
  const t = triage(data, '2026-07-09');
  assert.deepEqual(t.action.map((e) => e.id), ['hi']);
  assert.deepEqual(t.unlock.map((e) => e.id), ['unlock']);
  assert.deepEqual(t.other.map((e) => e.id).sort(), ['low', 'mid-no-tag', 'unscored']);
});

test('triage collects follow-ups across entries', () => {
  const data = { updated: 't', opportunities: [
    entry({ id: 'due', score: 80, log: [{ date: '2026-07-01', event: 'outreach-sent', note: '' }] }),
  ] };
  const t = triage(data, '2026-07-20');
  assert.equal(t.followups.length, 1);
  assert.equal(t.followups[0].entry.id, 'due');
  assert.equal(t.followups[0].due[0].kind, 'nudge');
});

test('triage action and unlock contain only untouched new opportunities', () => {
  const data = { opportunities: [
    entry({ id: 'new-action', status: 'new', score: 80 }),
    entry({ id: 'shortlist', status: 'shortlist', score: 80 }),
    entry({ id: 'rejected', status: 'rejected', score: 90 }),
    entry({ id: 'applied', status: 'applied', score: 85 }),
    entry({ id: 'watch', status: 'watch', score: 75 }),
    entry({ id: 'new-unlock', status: 'new', score: 60, tags: ['Needs Salary Check'] }),
    entry({ id: 'watch-unlock', status: 'watch', score: 60, tags: ['Needs Salary Check'] }),
  ] };
  const out = triage(data, '2026-07-10');
  assert.deepEqual(out.action.map((e) => e.id), ['new-action']);
  assert.deepEqual(out.unlock.map((e) => e.id), ['new-unlock']);
  assert.deepEqual(out.other.map((e) => e.id).sort(), ['applied', 'rejected', 'shortlist', 'watch', 'watch-unlock']);
});

test('mandatory eligibility gates override stale or provider-supplied scores', () => {
  const data = { opportunities: [
    entry({ id: 'eligible', score: 80, eligibility: { status: 'eligible' } }),
    entry({ id: 'unknown', score: 69, eligibility: { status: 'check' } }),
    entry({ id: 'blocked-high', score: 95, eligibility: { status: 'ineligible' } }),
    entry({ id: 'check-too-high', score: 90, eligibility: { status: 'check' } }),
  ] };
  const out = triage(data, '2026-07-10');
  assert.deepEqual(out.action.map((e) => e.id), ['eligible']);
  assert.deepEqual(out.unlock.map((e) => e.id), ['unknown']);
  assert.deepEqual(out.other.map((e) => e.id).sort(), ['blocked-high', 'check-too-high']);
});

test('closed statuses never produce follow-ups', () => {
  const log = [{ date: '2026-07-01', event: 'outreach-sent', note: '' }];
  assert.deepEqual(followUpsDue(entry({ status: 'rejected', log }), '2026-07-20'), []);
  assert.deepEqual(followUpsDue(entry({ status: 'ignore', log }), '2026-07-20'), []);
  assert.deepEqual(followUpsDue(entry({ status: 'accepted', log }), '2026-07-20'), []);
});
