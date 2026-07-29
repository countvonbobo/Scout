import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationConflictError, OperationManager, operationIsTerminal } from './operations.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('operation manager reports phases, results, and terminal state', async () => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const manager = new OperationManager({ id: () => 'op-1' });
  const started = manager.start('scan', async (update) => {
    update({ phase: 'Scoring candidates', current: 2, total: 4 });
    await blocker;
    return { reviewed: 40, kept: 0 };
  }, { phase: 'Validating evidence', total: 4, estimate: { basis: 'history', sampleSize: 3, totalSecondsLow: 300, totalSecondsHigh: 540 } });

  assert.equal(started.status, 'queued');
  assert.equal(started.estimate.totalSecondsHigh, 540);
  await tick();
  assert.deepEqual(manager.get('op-1').progress, { current: 2, total: 4 });
  assert.equal(manager.get('op-1').phase, 'Scoring candidates');
  assert.equal(manager.active().id, 'op-1');
  assert.deepEqual(manager.activeList().map((operation) => operation.id), ['op-1']);
  assert.throws(() => manager.start('scan', async () => null), OperationConflictError);
  release();
  await tick();
  assert.equal(manager.get('op-1').status, 'succeeded');
  assert.deepEqual(manager.activeList(), []);
  assert.deepEqual(manager.get('op-1').result, { reviewed: 40, kept: 0 });
  assert.equal(operationIsTerminal(manager.get('op-1')), true);
});

test('operation manager sanitises failure details', async () => {
  const manager = new OperationManager({ id: () => 'op-2' });
  manager.start('proposal', async () => { throw new Error('provider\nfailed\tcleanly'); });
  await tick();
  assert.equal(manager.latest('proposal').status, 'failed');
  assert.equal(manager.latest('proposal').error, 'provider failed cleanly');
  assert.equal(manager.latest('scan'), null);
});

test('operation records do not expose absolute workspace paths', async () => {
  const manager = new OperationManager({ id: () => 'op-3' });
  manager.start('scan', async () => { throw new Error(`failed reading ${['', 'Users', 'example', 'Documents', 'Private Scout', 'profile', 'context.md'].join('/')}`); });
  await tick();
  assert.doesNotMatch(manager.get('op-3').error, /Users|Private Scout|context\.md/);
  assert.match(manager.get('op-3').error, /\[local path\]/);
});
