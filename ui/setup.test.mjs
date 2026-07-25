import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ALTERNATING_DAYS,
  buildConfig,
  bytesToBase64,
  formatLocalDateTime,
  matchingPreset,
  presetDays,
  handoffAction,
  operationElapsed,
  operationRemaining,
  scanOutcomeSummary,
  shouldAutoRunFirstScan,
  shouldRequestRecoveryKey,
  splitList,
  validateCvName,
} from './setup.js';

test('splitList accepts comma and newline separated settings', () => {
  assert.deepEqual(splitList('Robotics, climate tech\nHealthcare,  '), [
    'Robotics', 'climate tech', 'Healthcare',
  ]);
});
test('buildConfig creates generic search and commute settings', () => {
  const config = buildConfig({
    displayName: 'Alex',
    tone: 'concise and warm',
    roleFamilies: 'Design, Operations',
    sectors: 'Energy\nMobility',
    locations: 'Manchester, Remote UK',
    exclusions: 'Commission-only',
    salaryMinimum: '65000',
    currency: 'gbp',
    locale: 'en-GB',
    timezone: 'Europe/London',
    commuteOrigin: 'Manchester',
    commuteMode: 'public',
    commuteMax: '75',
    includeUnknown: false,
  }, { profile: { retained: true }, search: { retained: true }, commute: { retained: true } });

  assert.equal(config.profile.displayName, 'Alex');
  assert.equal(config.profile.retained, true);
  assert.deepEqual(config.search.roleFamilies, ['Design', 'Operations']);
  assert.deepEqual(config.search.sectors, ['Energy', 'Mobility']);
  assert.equal(config.search.salaryMinimum, 65000);
  assert.equal(config.currency, 'GBP');
  assert.deepEqual(config.commute, {
    retained: true,
    origin: 'Manchester',
    mode: 'public',
    maxMinutes: 75,
    includeUnknown: false,
  });
});

test('buildConfig represents a blank salary as null', () => {
  assert.equal(buildConfig({ displayName: 'Alex', salaryMinimum: '' }).search.salaryMinimum, null);
});

test('CV validation accepts only supported local import types', () => {
  for (const name of ['cv.pdf', 'cv.docx', 'cv.md', 'cv.markdown', 'cv.txt']) {
    assert.equal(validateCvName(name), true);
  }
  assert.throws(() => validateCvName('cv.pages'), /PDF, DOCX, Markdown or text/);
});

test('bytesToBase64 preserves binary bytes', () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
  assert.deepEqual(Buffer.from(bytesToBase64(bytes), 'base64'), Buffer.from(bytes));
});

test('formatLocalDateTime returns local readable text and handles missing values', () => {
  assert.equal(formatLocalDateTime(null), 'pending');
  assert.match(formatLocalDateTime('2026-07-12T07:30:00.000Z', 'en-GB'), /2026/);
});

test('bounded proposal activation gates the first scan', () => {
  assert.deepEqual(handoffAction(false), { label: 'Activate a proposal to continue', defer: false, ready: false });
  assert.deepEqual(handoffAction(true), { label: 'Continue to first scan', defer: false, ready: true });
});

test('a first scan starts automatically only when the workspace has never scanned', () => {
  assert.equal(shouldAutoRunFirstScan({}), true);
  assert.equal(shouldAutoRunFirstScan({}, false), false);
  assert.equal(shouldAutoRunFirstScan({ lastRunAt: '2026-07-12T10:00:00.000Z' }), false);
});

test('recovery keys are requested only from the Scout host', () => {
  assert.equal(shouldRequestRecoveryKey({ requestAccess: 'local', sync: { enabled: true } }), true);
  assert.equal(shouldRequestRecoveryKey({ requestAccess: 'remote-owner', sync: { enabled: true } }), false);
  assert.equal(shouldRequestRecoveryKey({ requestAccess: 'local', sync: { enabled: false } }), false);
  assert.equal(shouldRequestRecoveryKey({ requestAccess: 'local', sync: { enabled: true } }, 'already-shown'), false);
});

test('scan outcome explains strict zero-keeper results', () => {
  assert.deepEqual(scanOutcomeSummary({
    candidatesFound: 40, keepersAdded: 0,
    discarded: { mandatory_unmet: 19, provider_discarded: 21 },
  }), {
    reviewed: 40, kept: 0, headline: '40 reviewed, 0 kept',
    breakdown: ['19 mandatory gates', '21 assessment discards'],
  });
  assert.equal(operationElapsed({ startedAt: '2026-07-21T20:00:00.000Z' }, Date.parse('2026-07-21T20:02:05.000Z')), '2m 5s elapsed');
  assert.equal(operationRemaining({
    startedAt: '2026-07-21T20:00:00.000Z', estimate: { totalSecondsLow: 300, totalSecondsHigh: 600 },
  }, Date.parse('2026-07-21T20:02:00.000Z')), 'About 3–8 min remaining');
  assert.match(operationRemaining({
    startedAt: '2026-07-21T20:00:00.000Z', estimate: { totalSecondsLow: 300, totalSecondsHigh: 600 },
  }, Date.parse('2026-07-21T20:11:00.000Z')), /Taking longer/);
});

test('first-run setup offers optional local create, private backup guidance, and restore', () => {
  const source = fs.readFileSync(new URL('./setup.js', import.meta.url), 'utf8');
  assert.match(source, /Set up Scout for the first time/);
  assert.match(source, /Restore my existing workspace/);
  assert.match(source, /Scout works fully.*without GitHub/s);
  assert.match(source, /select <strong>Private<\/strong>/);
  assert.match(source, />Not now</);
  assert.match(source, /Save your emergency recovery key/);
  assert.match(source, /Save key to file/);
  assert.doesNotMatch(source, /window\.prompt/);
  assert.match(source, /GitHub copy is still pending/);
  assert.match(source, /setup-backup-check-git/);
  assert.match(source, />Retry</);
  assert.match(source, /api\/sync\/recovery-key\/confirm/);
  assert.doesNotMatch(source, /setup-next'\)\.onclick/);
});

test('a configured schedule job stays editable and drops first-run wording once there is scan history', () => {
  const source = fs.readFileSync(new URL('./setup.js', import.meta.url), 'utf8');
  // The schedule action button must not be disabled just because the latest scan is unhealthy
  // when the job is already configured.
  assert.match(source, /\$\{\(healthy \|\| run\?\.configured\) \? '' : 'disabled'\}/);
  assert.doesNotMatch(source, /\$\{healthy \? '' : 'disabled'\}/);
  // First-run wording (heading/callout/button label) must be gated on whether there is any
  // history at all (a previous run or a configured job), not on the latest run being healthy.
  assert.match(source, /const hasHistory = Boolean\(health\.lastRunAt\) \|\| configuredJobs;/);
  assert.match(source, /\$\{hasHistory \? 'Your first scan is ready to review' : 'Run your first search with me'\}/);
  assert.match(source, /\$\{hasHistory \? 'Supervised scan completed' : 'Supervised first scan'\}/);
  assert.match(source, /\$\{scanning \? 'Scan running…' : hasHistory \? 'Scan now' : 'Run first scan now'\}/);
});

test('the alternating preset gives each provider its own days', () => {
  const primary = presetDays('alternating', 'primary');
  const second = presetDays('alternating', 'second-pass');
  assert.deepEqual(primary, ALTERNATING_DAYS.primary);
  assert.deepEqual(second, ALTERNATING_DAYS['second-pass']);
  assert.equal(primary.some((day) => second.includes(day)), false);
  assert.deepEqual([...primary, ...second].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test('day presets round-trip to the selection they describe', () => {
  for (const mode of ['primary', 'second-pass']) {
    for (const preset of ['every', 'alternating', 'weekdays']) {
      assert.equal(matchingPreset(presetDays(preset, mode), mode), preset);
    }
  }
  assert.equal(matchingPreset([1, 4], 'primary'), 'custom');
  assert.equal(matchingPreset([], 'primary'), 'every');
});
