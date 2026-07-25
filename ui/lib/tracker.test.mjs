import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES, LOG_EVENTS, findEntry, setStatus, addNote,
  logEvent, addContact, editContact, serializeTracker,
  markApplied, addApplicationStage, completeApplicationStage, markRejected,
  currentStage, lastCompletedStage, isInterviewStage,
  setCategory, setCommute,
} from './tracker.mjs';

function fixture() {
  return {
    updated: '2026-07-08',
    opportunities: [
      { id: 'a-1', company: 'Alpha', score: 87, scoreBreakdown: {}, status: 'watch',
        tags: ['Startup'], sources: [], notes: 'seed note', lastChecked: '2026-07-08',
        foundVia: 'x', contacts: [], log: [] },
      { id: 'b-2', company: 'Beta', score: null, scoreBreakdown: {}, status: 'new',
        tags: [], sources: [], notes: '', lastChecked: null,
        foundVia: 'y', contacts: [], log: [] },
    ],
  };
}

test('findEntry returns the entry or throws', () => {
  assert.equal(findEntry(fixture(), 'a-1').company, 'Alpha');
  assert.throws(() => findEntry(fixture(), 'nope'), /not found/);
});

test('setStatus validates and does not mutate input', () => {
  const data = fixture();
  const out = setStatus(data, 'a-1', 'outreach');
  assert.equal(findEntry(out, 'a-1').status, 'outreach');
  assert.equal(findEntry(data, 'a-1').status, 'watch', 'input unchanged');
  assert.throws(() => setStatus(fixture(), 'a-1', 'bogus'), /invalid status/i);
});

test('setStatus accepts the shortlist status', () => {
  const data = { opportunities: [{ id: 'acme-eng-2026-07', status: 'new' }] };
  const next = setStatus(data, 'acme-eng-2026-07', 'shortlist');
  assert.equal(next.opportunities[0].status, 'shortlist');
  assert.equal(data.opportunities[0].status, 'new'); // input not mutated
});

test('addNote appends a dated line and preserves existing notes', () => {
  const out = addNote(fixture(), 'a-1', 'called them', '2026-07-09');
  assert.equal(findEntry(out, 'a-1').notes, 'seed note\n[2026-07-09] called them');
});

test('addNote on empty notes has no leading newline', () => {
  const out = addNote(fixture(), 'b-2', 'first', '2026-07-09');
  assert.equal(findEntry(out, 'b-2').notes, '[2026-07-09] first');
});

test('logEvent validates event and appends to log', () => {
  const out = logEvent(fixture(), 'a-1', 'outreach-sent', 'LinkedIn', '2026-07-09');
  assert.deepEqual(findEntry(out, 'a-1').log, [
    { date: '2026-07-09', event: 'outreach-sent', note: 'LinkedIn' },
  ]);
  assert.throws(() => logEvent(fixture(), 'a-1', 'faxed', '', '2026-07-09'), /invalid event/i);
});

test('addContact requires a name and appends', () => {
  const out = addContact(fixture(), 'a-1',
    { name: 'Jo', role: 'CTO', linkedin: 'u', foundVia: 'site' });
  assert.equal(findEntry(out, 'a-1').contacts.length, 1);
  assert.equal(findEntry(out, 'a-1').contacts[0].role, 'CTO');
  assert.throws(() => addContact(fixture(), 'a-1', { name: '' }), /name/i);
});

test('editContact replaces by index and rejects bad index', () => {
  const seeded = addContact(fixture(), 'a-1', { name: 'Jo', role: '', linkedin: '', foundVia: '' });
  const out = editContact(seeded, 'a-1', 0, { name: 'Joanne', role: 'CEO', linkedin: '', foundVia: '' });
  assert.equal(findEntry(out, 'a-1').contacts[0].name, 'Joanne');
  assert.throws(() => editContact(seeded, 'a-1', 5, { name: 'X' }), /index/i);
});

test('constants expose the allowed values', () => {
  assert.deepEqual(STATUSES, ['new','shortlist','watch','outreach','applied','interviewing','accepted','rejected','ignore']);
  assert.deepEqual(LOG_EVENTS, ['outreach-sent','replied','nudged','meeting','closed']);
});

test('serializeTracker writes one entry object per line and round-trips', () => {
  const data = fixture();
  const text = serializeTracker(data);
  const lines = text.split('\n');
  assert.equal(lines[0], '{');
  assert.equal(lines[1], '  "updated": "2026-07-08",');
  assert.equal(lines[2], '  "opportunities": [');
  assert.match(lines[3], /^ {4}\{".*\}\,$/, 'entry 1 on its own 4-space-indented line');
  assert.match(lines[4], /^ {4}\{".*\}$/, 'entry 2, last, no trailing comma');
  assert.equal(text.at(-1), '\n', 'trailing newline');
  assert.deepEqual(JSON.parse(text), data, 'round-trips to identical data');
});

test('serializeTracker with no updated key returns valid JSON with a real date string', () => {
  const data = { opportunities: fixture().opportunities };
  const text = serializeTracker(data);
  const parsed = JSON.parse(text);
  assert.match(parsed.updated, /^\d{4}-\d{2}-\d{2}/, 'should have a valid date string');
  assert.deepEqual(parsed.opportunities, data.opportunities);
});

test('serializeTracker output parses for every status in STATUSES', () => {
  for (const status of STATUSES) {
    const data = { updated: '2026-07-25', opportunities: [{ ...fixture().opportunities[0], status }] };
    const text = serializeTracker(data);
    const parsed = JSON.parse(text);
    assert.equal(parsed.opportunities[0].status, status);
  }
});

test('markApplied adds an application block and Applied stage idempotently', () => {
  const once = markApplied(fixture(), 'a-1', '2026-07-10', 'Submitted via site');
  const entry = findEntry(once, 'a-1');
  assert.equal(entry.status, 'applied');
  assert.equal(entry.application.appliedDate, '2026-07-10');
  assert.deepEqual(entry.application.stages, [
    { name: 'Applied', completed: true, date: '2026-07-10' },
  ]);
  assert.match(entry.notes, /Submitted via site/);

  const twice = markApplied(once, 'a-1', '2026-07-11', '');
  assert.equal(findEntry(twice, 'a-1').application.stages.length, 1);
});

test('addApplicationStage tracks current and interview status', () => {
  const data = markApplied(fixture(), 'a-1', '2026-07-10');
  const out = addApplicationStage(data, 'a-1', { name: 'Technical call', completed: false }, '2026-07-12');
  const entry = findEntry(out, 'a-1');
  assert.equal(entry.status, 'interviewing');
  assert.equal(currentStage(entry), 'Technical call');
  assert.equal(isInterviewStage('Technical call'), true);
});

test('completeApplicationStage marks a stage complete with a date', () => {
  const data = addApplicationStage(fixture(), 'a-1', { name: 'Founder chat', completed: false }, '2026-07-12');
  const out = completeApplicationStage(data, 'a-1', 0, '2026-07-13');
  const entry = findEntry(out, 'a-1');
  assert.equal(currentStage(entry), null);
  assert.deepEqual(lastCompletedStage(entry), { name: 'Founder chat', completed: true, date: '2026-07-13' });
  assert.throws(() => completeApplicationStage(data, 'a-1', 9, '2026-07-13'), /stage index/i);
});

test('markRejected closes the opportunity and preserves the stage history', () => {
  const data = markApplied(fixture(), 'a-1', '2026-07-10');
  const out = markRejected(data, 'a-1', '2026-07-15', 'No longer hiring');
  const entry = findEntry(out, 'a-1');
  assert.equal(entry.status, 'rejected');
  assert.equal(entry.application.rejectedDate, '2026-07-15');
  assert.deepEqual(entry.application.stages.map((s) => s.name), ['Applied', 'Rejected']);
  assert.match(entry.notes, /No longer hiring/);
});

test('setCategory validates and stores configured search lanes', () => {
  const out = setCategory(fixture(), 'a-1', 'corporate');
  assert.equal(findEntry(out, 'a-1').category, 'established');
  assert.equal(findEntry(setCategory(fixture(), 'a-1', 'research-labs'), 'a-1').category, 'research-labs');
  assert.throws(() => setCategory(fixture(), 'a-1', 'not a lane'), /invalid category/i);
});

test('setCommute records practical travel times from a configured origin', () => {
  const out = setCommute(fixture(), 'a-1', {
    originPostcode: 'AB1 2CD',
    destination: 'Oxford lab',
    carMinutes: '48',
    publicTransportMinutes: 72,
    notes: 'Typical weekday morning',
    sources: ['https://maps.example'],
  }, '2026-07-10');
  const commute = findEntry(out, 'a-1').commute;
  assert.deepEqual(commute, {
    originPostcode: 'AB1 2CD',
    destination: 'Oxford lab',
    carMinutes: 48,
    publicTransportMinutes: 72,
    checked: '2026-07-10',
    notes: 'Typical weekday morning',
    sources: ['https://maps.example'],
  });
  assert.throws(() => setCommute(fixture(), 'a-1', { carMinutes: -5 }, '2026-07-10'), /invalid car/i);
});
