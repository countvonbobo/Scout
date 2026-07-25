import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugOf, buildPrefills, HANDOFF_SUMMARY_PROMPT, handoffOpening } from './chatPrompts.mjs';

test('slugOf matches the app.js slug rules', () => {
  assert.equal(slugOf('Acme Avionics'), 'acme-avionics');
  assert.equal(slugOf('Boom & Bust Ltd.'), 'boom-and-bust-ltd');
  assert.equal(slugOf('  Weird -- Name  '), 'weird-name');
});

test('prefills carry slug-correct paths and the tracker id', () => {
  const entry = { id: 'acme-avionics-lead-2026-07', company: 'Acme Avionics', role: 'Lead Engineer' };
  const p = buildPrefills(entry, { locale: 'en-US', tone: 'concise and warm' });
  assert.equal(p.ask, '');
  assert.match(p.cv, /applications\/acme-avionics-lead-2026-07\/cv\.typ/);
  assert.match(p.cv, /typst compile --root \. applications\/acme-avionics-lead-2026-07\/cv\.typ/);
  assert.match(p.cv, /cv\/master-cv\.md/);
  assert.match(p.cv, /acme-avionics-lead-2026-07/);
  assert.match(p.cv, /Draft only, nothing sent\./);
  assert.match(p.cv, /Google XYZ/);
  assert.match(p.cv, /one focused question per turn/);
  assert.match(p.cv, /cv-evidence\.json/);
  assert.match(p.cv, /quality checks after the turn/);
  assert.match(p.coverLetter, /applications\/acme-avionics-lead-2026-07\/outreach\.md/);
  assert.match(p.coverLetter, /en-US, concise and warm/);
  assert.match(p.tweak, /<your change>/);
  assert.match(p.tweak, /applications\/acme-avionics-lead-2026-07\/cv\.typ/);
  assert.match(p.reuseEvidence, /explicit confirmation/);
});

// Bug #55: the write path, not just the read path. Two roles at one employer must
// never be handed the same cv.typ/cv-evidence.json to write.
test('two roles at the same company get different CV and evidence write paths', () => {
  const backend = { id: 'acme-backend-engineer-2026-07', company: 'Acme', role: 'Backend Engineer' };
  const frontend = { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' };
  const a = buildPrefills(backend);
  const b = buildPrefills(frontend);
  const cvPath = (prefills) => prefills.cv.match(/applications\/[^/]+\/cv\.typ/)[0];
  const evidencePath = (prefills) => prefills.cv.match(/applications\/[^/]+\/cv-evidence\.json/)[0];
  assert.equal(cvPath(a), 'applications/acme-backend-engineer-2026-07/cv.typ');
  assert.equal(cvPath(b), 'applications/acme-frontend-engineer-2026-07/cv.typ');
  assert.notEqual(cvPath(a), cvPath(b));
  assert.notEqual(evidencePath(a), evidencePath(b));
  // The company folder must not appear at all: writing there is what destroyed
  // the other role's CV.
  assert.doesNotMatch(a.cv, /applications\/acme\//);
  assert.doesNotMatch(b.cv, /applications\/acme\//);
  assert.doesNotMatch(b.coverLetter, /applications\/acme\//);
  assert.doesNotMatch(b.tweak, /applications\/acme\//);
});

test('a deliberately reused legacy folder is honoured, and "start fresh" stays id-keyed', () => {
  const entry = { id: 'acme-frontend-engineer-2026-07', company: 'Acme', role: 'Frontend Engineer' };
  // The user chose "open it as-is" for the pre-existing company folder.
  const reused = buildPrefills(entry, { artifactSlug: 'acme' });
  assert.match(reused.cv, /applications\/acme\/cv\.typ/);
  // The user chose "start fresh": the per-role folder, never the legacy one.
  const fresh = buildPrefills(entry, { artifactSlug: 'acme-frontend-engineer-2026-07' });
  assert.match(fresh.cv, /applications\/acme-frontend-engineer-2026-07\/cv\.typ/);
  assert.doesNotMatch(fresh.cv, /applications\/acme\//);
  assert.doesNotMatch(fresh.cv, /applications\/acme\/cv-evidence\.json/);
});

test('CV recommendations can be disabled independently', () => {
  const entry = { id: 'acme-role-2026-07', company: 'Acme', role: 'Engineer' };
  const neither = buildPrefills(entry, { cvOptions: { xyz: false, humanize: false } });
  assert.match(neither.cv, /Do not require Google XYZ/);
  assert.match(neither.cv, /Do not run the optional natural-voice revision/);
  assert.match(neither.cv, /xyz=false and humanize=false/);
  const voiceOnly = buildPrefills(entry, { cvOptions: { xyz: false, humanize: true } });
  assert.match(voiceOnly.cv, /separate natural-voice revision/);
});

test('handoff prompt and opening are well-formed', () => {
  assert.match(HANDOFF_SUMMARY_PROMPT, /decisions made/);
  assert.match(HANDOFF_SUMMARY_PROMPT, /files created or edited/);
  const opening = handoffOpening('SUMMARY GOES HERE');
  assert.match(opening, /taking over an in-progress task/);
  assert.match(opening, /SUMMARY GOES HERE/);
});
