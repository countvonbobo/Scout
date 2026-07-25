// Pure tracker domain: read helpers, single-field mutators, and a serializer that
// preserves one-entry-per-line formatting. No I/O here — the server does file access.

export const STATUSES = ['new', 'shortlist', 'watch', 'outreach', 'applied', 'interviewing', 'accepted', 'rejected', 'ignore'];
export const LOG_EVENTS = ['outreach-sent', 'replied', 'nudged', 'meeting', 'closed'];
export const INTERVIEW_STAGE_PATTERN = /\b(interview|technical|screen|call|system design|onsite|assessment)\b/i;
export const JOB_CATEGORIES = ['startup', 'established'];

export function findEntry(data, id) {
  const entry = data.opportunities.find((o) => o.id === id);
  if (!entry) throw new Error(`opportunity not found: ${id}`);
  return entry;
}

function withEntry(data, id, fn) {
  const next = structuredClone(data);
  const entry = findEntry(next, id);
  fn(entry);
  return next;
}

export function setStatus(data, id, status) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  return withEntry(data, id, (e) => { e.status = status; });
}

export function addNote(data, id, text, today) {
  const line = `[${today}] ${text}`;
  return withEntry(data, id, (e) => {
    e.notes = e.notes ? `${e.notes}\n${line}` : line;
  });
}

export function logEvent(data, id, event, note, today) {
  if (!LOG_EVENTS.includes(event)) throw new Error(`invalid event: ${event}`);
  return withEntry(data, id, (e) => {
    e.log = e.log || [];
    e.log.push({ date: today, event, note: note || '' });
  });
}

function cleanContact(contact) {
  const name = (contact.name || '').trim();
  if (!name) throw new Error('contact name is required');
  return {
    name,
    role: contact.role || '',
    linkedin: contact.linkedin || '',
    foundVia: contact.foundVia || '',
  };
}

export function addContact(data, id, contact) {
  const clean = cleanContact(contact);
  return withEntry(data, id, (e) => {
    e.contacts = e.contacts || [];
    e.contacts.push(clean);
  });
}

export function editContact(data, id, index, contact) {
  const clean = cleanContact(contact);
  return withEntry(data, id, (e) => {
    e.contacts = e.contacts || [];
    if (index < 0 || index >= e.contacts.length) throw new Error(`contact index out of range: ${index}`);
    e.contacts[index] = clean;
  });
}

function cleanCategory(category) {
  const value = String(category || '').trim().toLowerCase();
  if (value === 'scaleup' || value === 'hidden' || value === 'speculative') return 'startup';
  if (['corporate', 'mainstream', 'bigtech', 'big-tech', 'prime', 'standard'].includes(value)) return 'established';
  if (!JOB_CATEGORIES.includes(value) && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(value)) throw new Error(`invalid category: ${category}`);
  return value;
}

function cleanMinutes(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 600) throw new Error(`invalid ${label} minutes: ${value}`);
  return Math.round(n);
}

function cleanUrlList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((u) => String(u || '').trim()).filter(Boolean);
}

export function setCategory(data, id, category) {
  const clean = cleanCategory(category);
  return withEntry(data, id, (e) => { e.category = clean; });
}

export function setCommute(data, id, commute, today) {
  return withEntry(data, id, (e) => {
    e.commute = {
      originPostcode: String(commute?.originPostcode ?? e.commute?.originPostcode ?? '').trim(),
      destination: String(commute?.destination ?? e.location ?? '').trim(),
      carMinutes: cleanMinutes(commute?.carMinutes, 'car'),
      publicTransportMinutes: cleanMinutes(commute?.publicTransportMinutes ?? commute?.trainMinutes, 'public transport'),
      checked: validDateOrNull(commute?.checked) || today,
      notes: String(commute?.notes || '').trim(),
      sources: cleanUrlList(commute?.sources),
    };
  });
}

function validDateOrNull(date) {
  if (date === undefined || date === null || date === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error(`invalid stage date: ${date}`);
  return String(date);
}

function ensureApplication(entry) {
  entry.application = entry.application || {};
  entry.application.stages = Array.isArray(entry.application.stages) ? entry.application.stages : [];
  return entry.application;
}

function cleanStage(stage, today) {
  const name = String(stage?.name || '').trim();
  if (!name) throw new Error('stage name is required');
  const completed = Boolean(stage?.completed);
  const date = validDateOrNull(stage?.date ?? (completed ? today : null));
  return { name, completed, date };
}

export function stagesOf(entry) {
  return Array.isArray(entry.application?.stages) ? entry.application.stages : [];
}

export function isInterviewStage(name) {
  return INTERVIEW_STAGE_PATTERN.test(String(name || ''));
}

export function currentStage(entry) {
  const next = stagesOf(entry).find((s) => !s.completed);
  return next ? next.name : null;
}

export function lastCompletedStage(entry) {
  const stages = stagesOf(entry);
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i].completed) return stages[i];
  }
  return null;
}

function hasStageNamed(entry, name) {
  const wanted = String(name).toLowerCase();
  return stagesOf(entry).some((s) => String(s.name).toLowerCase() === wanted);
}

function appendTrackerNote(entry, text, today) {
  if (!text || !String(text).trim()) return;
  const line = `[${today}] ${String(text).trim()}`;
  entry.notes = entry.notes ? `${entry.notes}\n${line}` : line;
}

export function markApplied(data, id, today, note = '') {
  return withEntry(data, id, (e) => {
    const app = ensureApplication(e);
    app.appliedDate = app.appliedDate || today;
    if (!hasStageNamed(e, 'Applied')) {
      app.stages.push({ name: 'Applied', completed: true, date: today });
    }
    if (e.status !== 'interviewing') e.status = 'applied';
    appendTrackerNote(e, note, today);
  });
}

export function addApplicationStage(data, id, stage, today) {
  return withEntry(data, id, (e) => {
    const app = ensureApplication(e);
    const clean = cleanStage(stage, today);
    app.stages.push(clean);
    if (String(clean.name).toLowerCase() === 'applied') {
      app.appliedDate = app.appliedDate || clean.date || today;
      if (e.status !== 'interviewing') e.status = 'applied';
    }
    if (isInterviewStage(clean.name)) e.status = 'interviewing';
  });
}

export function completeApplicationStage(data, id, index, today) {
  return withEntry(data, id, (e) => {
    const app = ensureApplication(e);
    if (index < 0 || index >= app.stages.length) throw new Error(`stage index out of range: ${index}`);
    app.stages[index] = { ...app.stages[index], completed: true, date: app.stages[index].date || today };
  });
}

export function markRejected(data, id, today, note = '') {
  return withEntry(data, id, (e) => {
    const app = ensureApplication(e);
    app.rejectedDate = today;
    if (!hasStageNamed(e, 'Rejected')) {
      app.stages.push({ name: 'Rejected', completed: true, date: today });
    }
    e.status = 'rejected';
    appendTrackerNote(e, note || 'Rejected / closed out.', today);
  });
}

export function serializeTracker(data) {
  const entries = data.opportunities.map((o) => '    ' + JSON.stringify(o));
  return '{\n'
    + `  "updated": ${JSON.stringify(data.updated)},\n`
    + '  "opportunities": [\n'
    + entries.join(',\n') + '\n'
    + '  ]\n'
    + '}\n';
}
