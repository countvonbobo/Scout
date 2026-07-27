import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  JournalCorruptionError, appendRunEvent, openRunJournal, replayRunJournal, validateRunJournal,
} from './runJournal.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-run-journal-')); roots.push(root); return root; }

const lease = { leaseId: 'lease-1', generation: 1 };
const collected = {
  type: 'stage.completed', stageId: 'collect', idempotencyKey: 'collect-v1', payload: { source: 'adzuna', count: 2 },
};
const ranked = {
  type: 'stage.completed', stageId: 'rank', idempotencyKey: 'rank-v1', payload: { selected: ['vacancy-1'] },
};

test('appends canonical hash-chained events and replays them in sequence', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  const second = appendRunEvent(journal, ranked, lease);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousHash, first.eventHash);
  assert.match(first.payloadHash, /^[a-f0-9]{64}$/);
  assert.match(second.eventHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(replayRunJournal(journal.file), [first, second]);
});

test('returns the committed event for a duplicate idempotency key and rejects a conflicting key', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const committed = appendRunEvent(journal, collected, lease);

  assert.deepEqual(appendRunEvent(journal, collected, lease), committed);
  assert.throws(
    () => appendRunEvent(journal, { ...collected, payload: { source: 'adzuna', count: 3 } }, lease),
    /idempotency key conflicts/,
  );
});

test('keeps valid events when only the final JSONL append is truncated', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  appendRunEvent(journal, ranked, lease);
  fs.appendFileSync(journal.file, '{"schemaVersion":', 'utf8');

  const validated = validateRunJournal(journal.file);
  assert.equal(validated.events.length, 2);
  assert.equal(validated.truncatedTail, true);
});

test('fails closed when a complete final event has a changed event hash', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  const event = appendRunEvent(journal, ranked, lease);
  event.eventHash = '0'.repeat(64);
  fs.writeFileSync(journal.file, `${JSON.stringify(validateRunJournal(journal.file).events[0])}\n${JSON.stringify(event)}\n`, 'utf8');

  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});
