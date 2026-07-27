import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  type: 'stage.completed', stageId: 'collect', idempotencyKey: 'collect-v1', payload: {
    schemaVersion: 1, reference: { kind: 'source', id: 'adzuna' }, count: 2, version: { kind: 'provider', value: 'adzuna' },
  },
};
const ranked = {
  type: 'stage.completed', stageId: 'rank', idempotencyKey: 'rank-v1', payload: {
    schemaVersion: 1, reference: { kind: 'selection', id: 'vacancy-1' }, count: 1,
  },
};

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function hashEvent(event) {
  const { eventHash, ...envelope } = event;
  return sha256(envelope);
}

test('appends canonical hash-chained events and replays them in sequence', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  const second = appendRunEvent(journal, ranked, lease);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousHash, first.eventHash);
  assert.equal(first.payloadHash, sha256(collected.payload));
  assert.equal(second.eventHash, hashEvent(second));
  assert.equal(fs.readFileSync(journal.file, 'utf8'), `${canonicalJson(first)}\n${canonicalJson(second)}\n`);
  assert.deepEqual(replayRunJournal(journal.file), [first, second]);
});

test('returns the committed event for a duplicate idempotency key and rejects a conflicting key', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const committed = appendRunEvent(journal, collected, lease);

  assert.deepEqual(appendRunEvent(journal, collected, lease), committed);
  assert.throws(
    () => appendRunEvent(journal, { ...collected, payload: { ...collected.payload, count: 3 } }, lease),
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

test('fails closed when an incomplete final JSON record already has a newline delimiter', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  fs.appendFileSync(journal.file, '{"schemaVersion":\n', 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('fails closed when non-JSON whitespace appears in an unterminated final record', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  for (const value of ['{"schemaVersion":\u00a0', '\ufeff{"schemaVersion":']) {
    fs.writeFileSync(journal.file, `${fs.readFileSync(journal.file, 'utf8').split('\n')[0]}\n${value}`, 'utf8');
    assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
  }
});

test('never acknowledges an append while a truncated final record remains unresolved', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  fs.appendFileSync(journal.file, '{"schemaVersion":', 'utf8');

  assert.throws(() => appendRunEvent(journal, ranked, lease), JournalCorruptionError);
  assert.deepEqual(replayRunJournal(journal.file), [first]);
});

test('repairs a missing final record delimiter before acknowledging the next append', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  fs.writeFileSync(journal.file, fs.readFileSync(journal.file, 'utf8').trimEnd(), 'utf8');

  const second = appendRunEvent(journal, ranked, lease);
  assert.deepEqual(replayRunJournal(journal.file), [first, second]);
});

test('rejects malformed unclosed final text rather than treating it as a torn append', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  fs.appendFileSync(journal.file, 'garbage{', 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);

  fs.writeFileSync(journal.file, `${fs.readFileSync(journal.file, 'utf8').split('\n')[0]}\n{"schemaVersion":oops`, 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('rejects caller-defined metadata and secret-shaped bypass fields at the journal boundary', () => {
  const journal = openRunJournal(temp(), 'run-1');
  for (const property of ['apiKey', 'auth', 'session', 'code']) {
    assert.throws(() => appendRunEvent(journal, {
      ...collected, idempotencyKey: `${property}-v1`, payload: { schemaVersion: 1, metadata: { [property]: 'sk-live-secret' } },
    }, lease), /payload/i);
  }
  assert.throws(() => appendRunEvent(journal, {
    ...collected, type: 'stage.unreviewed', idempotencyKey: 'unknown-type-v1', payload: collected.payload,
  }, lease), /event type/i);
  assert.throws(() => appendRunEvent(journal, {
    ...collected, idempotencyKey: 'unknown-field-v1', payload: { ...collected.payload, note: 'not-allowed' },
  }, lease), /payload/i);
});

test('accepts only the reviewed stage-completion reference, count, version, and artifact fields', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const event = appendRunEvent(journal, {
    ...collected,
    idempotencyKey: 'artifact-v1',
    payload: {
      schemaVersion: 1,
      reference: { kind: 'stage', id: 'collect' },
      count: 2,
      version: { kind: 'pipeline', value: 'pipeline-v1' },
      artifact: { id: 'collect-v1', schemaVersion: 1, digest: 'a'.repeat(64) },
    },
  }, lease);
  assert.deepEqual(replayRunJournal(journal.file), [event]);
});

test('rejects run IDs that are unsafe as Windows directory components', () => {
  for (const runId of ['run:one', 'run.', 'CON', 'lpt1']) {
    assert.throws(() => openRunJournal(temp(), runId), /run ID/i);
  }
});

test('rejects duplicate event IDs and idempotency keys in otherwise hash-valid replay history', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  const second = appendRunEvent(journal, ranked, lease);
  const duplicateEventId = { ...second, eventId: first.eventId };
  duplicateEventId.eventHash = hashEvent(duplicateEventId);
  fs.writeFileSync(journal.file, `${canonicalJson(first)}\n${canonicalJson(duplicateEventId)}\n`, 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);

  const duplicateKey = { ...second, eventId: randomUUID(), idempotencyKey: first.idempotencyKey };
  duplicateKey.eventHash = hashEvent(duplicateKey);
  fs.writeFileSync(journal.file, `${canonicalJson(first)}\n${canonicalJson(duplicateKey)}\n`, 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('rejects a hash-valid event with an invalid event ID format', () => {
  const journal = openRunJournal(temp(), 'run-1');
  const first = appendRunEvent(journal, collected, lease);
  const second = appendRunEvent(journal, ranked, lease);
  const invalidId = { ...second, eventId: 'event-two' };
  invalidId.eventHash = hashEvent(invalidId);
  fs.writeFileSync(journal.file, `${canonicalJson(first)}\n${canonicalJson(invalidId)}\n`, 'utf8');
  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});

test('fails closed when a complete final event has a changed event hash', () => {
  const journal = openRunJournal(temp(), 'run-1');
  appendRunEvent(journal, collected, lease);
  const event = appendRunEvent(journal, ranked, lease);
  event.eventHash = '0'.repeat(64);
  fs.writeFileSync(journal.file, `${JSON.stringify(validateRunJournal(journal.file).events[0])}\n${JSON.stringify(event)}\n`, 'utf8');

  assert.throws(() => validateRunJournal(journal.file), JournalCorruptionError);
});
