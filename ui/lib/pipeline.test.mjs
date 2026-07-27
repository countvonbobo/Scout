import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOVERABLE_PIPELINE_STAGES,
  applicationSummary,
  emptyTrackerView,
  pipeline,
  recoveryRequirementsForStage,
} from './pipeline.mjs';
import { triage } from './derive.mjs';

const entry = (over) => ({
  id: over.id || 'x',
  company: over.company || 'X',
  role: over.role || 'Role',
  status: over.status || 'watch',
  score: over.score ?? 60,
  tags: [],
  lastChecked: over.lastChecked || '2026-07-01',
  log: over.log || [],
  application: over.application,
});

test('applicationSummary derives current stage and movement age', () => {
  const e = entry({
    status: 'interviewing',
    application: {
      appliedDate: '2026-07-01',
      stages: [
        { name: 'Applied', completed: true, date: '2026-07-01' },
        { name: 'Technical call', completed: false, date: null },
      ],
    },
  });
  const out = applicationSummary(e, '2026-07-11');
  assert.equal(out.currentStage, 'Technical call');
  assert.equal(out.needsInterviewPrep, true);
  assert.equal(out.daysSinceApplied, 10);
});

test('pipeline buckets active, awaiting, accepted and genuinely closed work', () => {
  const data = { opportunities: [
    entry({ id: 'shortlist', status: 'shortlist', score: 80, lastChecked: '2026-07-01' }),
    entry({ id: 'active', status: 'applied', application: { appliedDate: '2026-07-01', stages: [{ name: 'Applied', completed: true, date: '2026-07-01' }] } }),
    entry({ id: 'prep', status: 'interviewing', application: { appliedDate: '2026-07-01', stages: [{ name: 'Screen', completed: false, date: null }] } }),
    entry({ id: 'closed', status: 'rejected', application: { rejectedDate: '2026-07-09', stages: [{ name: 'Rejected', completed: true, date: '2026-07-09' }] } }),
    entry({ id: 'watch', status: 'watch', score: 65 }),
    entry({ id: 'accepted', status: 'accepted', score: 90 }),
  ] };
  const out = pipeline(data, '2026-07-12');
  assert.equal(out.new, undefined);
  assert.deepEqual(out.shortlist.map((x) => x.id), ['shortlist']);
  assert.deepEqual(out.watch.map((x) => x.id), ['watch']);
  assert.deepEqual(out.awaitingDecision.map((x) => x.id).sort(), ['shortlist', 'watch']);
  assert.deepEqual(out.active.map((x) => x.id).sort(), ['active', 'prep']);
  assert.deepEqual(out.accepted.map((x) => x.id), ['accepted']);
  assert.deepEqual(out.recentlyClosed.map((x) => x.id), ['closed']);
  assert.equal(out.summary.total, data.opportunities.length);
  assert.equal(out.summary.accepted, 1);
  assert.equal(out.summary.recentlyClosed, 1);
  assert.equal(out.flags, undefined);
});

test('the uninitialised view matches the shape a populated workspace returns', () => {
  const empty = emptyTrackerView('2026-07-12');
  const populated = {
    updated: '2026-07-12',
    opportunities: [entry({ id: 'new', status: 'new', score: 80, lastChecked: '2026-07-01' })],
  };
  const live = {
    ...populated,
    triage: triage(populated, '2026-07-12'),
    pipeline: pipeline(populated, '2026-07-12'),
  };
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(live).sort());
  assert.deepEqual(Object.keys(empty.pipeline).sort(), Object.keys(live.pipeline).sort());
  assert.deepEqual(Object.keys(empty.triage).sort(), Object.keys(live.triage).sort());
  // The dashboard iterates these directly; a missing array crashes first paint.
  for (const key of ['shortlist', 'watch', 'active', 'awaitingDecision', 'accepted', 'recentlyClosed']) {
    assert.deepEqual(empty.pipeline[key], [], `pipeline.${key} must be an empty array`);
  }
  assert.equal(empty.pipeline.summary.total, 0);
  assert.deepEqual(empty.opportunities, []);
});

test('untriaged new items never appear in the pipeline', () => {
  const data = { opportunities: [
    { id: 'a', company: 'A', role: 'R', status: 'new', score: 80, lastChecked: '2026-07-20' },
    { id: 'b', company: 'B', role: 'R', status: 'shortlist', score: 70, lastChecked: '2026-07-20' },
  ] };
  const result = pipeline(data, '2026-07-25', {});
  const ids = JSON.stringify(result);
  assert.ok(!ids.includes('"id":"a"'), 'new item must not appear anywhere in the pipeline');
  assert.equal(result.new, undefined, 'the new bucket should no longer exist');
});

test('shortlisted roles are a first-class pipeline bucket and metric', () => {
  const data = { opportunities: [
    { id: 'b', company: 'B', role: 'R', status: 'shortlist', score: 70, lastChecked: '2026-07-20' },
  ] };
  const result = pipeline(data, '2026-07-25', {});
  assert.equal(result.shortlist.length, 1);
  assert.equal(result.summary.shortlist, 1);
});

test('the pipeline no longer exposes flags', () => {
  const data = { opportunities: [
    { id: 'a', company: 'A', role: 'R', status: 'new', score: 80, lastChecked: '2026-01-01' },
  ] };
  const result = pipeline(data, '2026-07-25', {});
  assert.equal(result.flags, undefined);
  assert.equal(result.summary.flags, undefined);
});

test('dismissed items stay out of the pipeline closed bucket', () => {
  const data = { opportunities: [
    { id: 'c', company: 'C', role: 'R', status: 'ignore', score: 40, lastChecked: '2026-07-20' },
  ] };
  const result = pipeline(data, '2026-07-25', {});
  assert.equal(result.recentlyClosed.length, 0);
  assert.ok(!JSON.stringify(result).includes('"id":"c"'));
});

test('shortlisted roles report a last-checked date', () => {
  const data = { opportunities: [
    { id: 'b', company: 'B', role: 'R', status: 'shortlist', score: 70, lastChecked: '2026-07-20' },
  ] };
  const result = pipeline(data, '2026-07-25', {});
  assert.equal(result.shortlist[0].lastChecked, '2026-07-20');
});

test('recovery stage contracts keep provider provenance out of deterministic stages', () => {
  assert.deepEqual(RECOVERABLE_PIPELINE_STAGES.map((stage) => stage.id), [
    'collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select', 'assess', 'tracker', 'report',
  ]);
  for (const stageId of ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select']) {
    const required = recoveryRequirementsForStage(stageId);
    assert.ok(required.includes('pipelineVersion'));
    assert.ok(!required.includes('provider'));
    assert.ok(!required.includes('model'));
  }
  assert.ok(recoveryRequirementsForStage('rank').includes('rankingVersion'));
  assert.ok(recoveryRequirementsForStage('assess').includes('provider'));
  assert.ok(recoveryRequirementsForStage('assess').includes('model'));
  assert.ok(recoveryRequirementsForStage('assess').includes('promptVersion'));
  assert.ok(recoveryRequirementsForStage('tracker').includes('targetRevision'));
  assert.ok(recoveryRequirementsForStage('report').includes('mutationSchemaVersion'));
  assert.throws(() => recoveryRequirementsForStage('raw-provider-output'), /unknown recovery stage/i);
});
