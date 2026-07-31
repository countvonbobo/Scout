import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ALTERNATING_DAYS,
  buildConfig,
  bytesToBase64,
  firstScanProfileReady,
  formatLocalDateTime,
  matchingPreset,
  presetDays,
  handoffAction,
  operationElapsed,
  operationRemaining,
  providerLoginPanelHtml,
  scanOutcomeSummary,
  shouldRequestRecoveryKey,
  adaptiveQuestionnaireHtml,
  employerRegistryHtml,
  feedbackLearningHtml,
  searchLanePlanHtml,
  searchProfileReviewHtml,
  splitList,
  validateCvName,
} from './setup.js';

test('feedback learning review separates job events, pending proposals and published undo', () => {
  const html = feedbackLearningHtml({
    revision: 'a'.repeat(64),
    active: {
      id: 'learning-v1',
      changes: [{
        kind: 'rank-adjustment', field: 'location', value: '<script>Manchester</script>',
        weight: 4, scope: 'profile-wide',
      }],
    },
    feedbackEvents: [{
      id: 'feedback-1', opportunityId: 'job-1', decision: 'promising', reason: 'positive',
      explanation: '<img src=x onerror=alert(1)>', recordedAt: '2026-07-30T10:00:00.000Z',
      profileId: 'profile-1', learningVersionId: 'learning-baseline',
    }],
    proposals: [{
      id: 'proposal-1', status: 'pending', sourceEventIds: ['feedback-1'],
      explanation: 'Reviewed proposal', change: {
        kind: 'rank-adjustment', field: 'location', value: 'Manchester',
        weight: 4, scope: 'profile-wide',
      },
    }],
    versions: [{
      id: 'learning-v1', explanation: 'Reviewed proposal',
      publishedAt: '2026-07-30T11:00:00.000Z', undoOf: null,
    }],
  });

  assert.match(html, /Job feedback never changes tracker status or ranking by itself/);
  assert.match(html, /data-learning-publish="proposal-1"/);
  assert.match(html, /Undo active learned version/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;Manchester/);
});

test('employer settings expose bounded health, policy and reversible priority controls safely', () => {
  const html = employerRegistryHtml({
    revision: 'a'.repeat(64),
    employers: [{
      id: 'employer-0123456789abcdef',
      canonicalName: '<script>Example</script>',
      aliases: ['Example Ltd'],
      industries: ['Research'],
      locations: ['London'],
      origins: [{ kind: 'named-profile', recordedAt: '2026-07-30T10:00:00.000Z' }],
      careersUrl: 'https://example.test/careers',
      board: null,
      userPriority: 'priority',
      decision: { state: 'active', reason: null },
      access: {
        terms: 'unreviewed', robots: 'unknown', genericEnabled: false, minIntervalMinutes: 60,
      },
      health: { status: 'blocked', reasonCode: 'terms-unreviewed' },
      monitoring: { lastCheckedAt: null, nextEligibleAt: null },
      history: [{
        recordedAt: '2026-07-30T10:00:00.000Z',
        status: 'blocked', adapter: 'structured-data', parsed: 0,
        failureCode: 'terms-unreviewed',
      }],
      reviewHistory: [{
        id: 'employer-review-0123456789abcdef',
        recordedAt: '2026-07-30T10:00:00.000Z',
        undoOf: null,
      }],
    }],
  });
  assert.doesNotMatch(html, /<script>Example/);
  assert.match(html, /&lt;script&gt;Example&lt;\/script&gt;/);
  assert.match(html, /priority/);
  assert.match(html, /inactive/);
  assert.match(html, /irrelevant/);
  assert.match(html, /Terms review/);
  assert.match(html, /Robots review/);
  assert.match(html, /Reviewed aliases/);
  assert.match(html, /Example Ltd/);
  assert.match(html, /Industries/);
  assert.match(html, /Locations/);
  assert.match(html, /Undo latest alias\/metadata review/);
  assert.match(html, /data-employer-confirm/);
  assert.match(html, /Add an employer for review/);
});

test('profile review names every decision area and keeps unconfirmed inferences non-blocking', () => {
  const html = searchProfileReviewHtml({
    rawPresent: true,
    draftRevision: 'r1',
    published: null,
    draft: {
      target: {
        primaryTitles: [{ value: 'Researcher', strength: 'mandatory', provenance: 'explicit' }],
        sectors: [{ value: 'Education', strength: 'nice-to-have', provenance: 'unconfirmed-inference' }],
        locations: [{ value: 'Remote', strength: 'strong-preference', provenance: 'explicit' }],
      },
      negative: {
        excludedTitles: [{ value: 'Commission-only', strength: 'hard-exclusion', provenance: 'explicit' }],
        excludedResponsibilities: [],
      },
      compensation: { currency: 'GBP', period: 'year', minimum: 60000, minimumStrength: 'strong-preference', unknownPolicy: 'include' },
      unknownPolicies: { location: 'penalise' },
    },
  });

  for (const label of [
    'Primary work', 'Adjacent work', 'Mandatory requirements', 'Preferences',
    'Confirmed exclusions', 'Accepted locations and working patterns',
    'Compensation and unknown handling', 'Focused, balanced or exploratory breadth',
  ]) assert.match(html, new RegExp(label));
  assert.match(html, /unknown location facts: penalise/i);
  assert.match(html, /Unconfirmed inferences remain non-blocking/);
  assert.match(html, /Publish this reviewed profile/);
});

test('adaptive questionnaire renders universal questions before bounded specialist follow-ups safely', () => {
  const html = adaptiveQuestionnaireHtml({
    questionnaire: {
      specialistLimit: 6,
      questions: [
        {
          id: 'primary-work', phase: 'universal', field: 'target.primaryTitles',
          label: 'Primary work', prompt: 'Which primary work?', current: [],
          answer: { kind: 'rules', maxItems: 8, allowBlocking: false },
        },
        {
          id: 'specialist-skills', phase: 'specialist', field: 'target.skills',
          label: 'Skills', prompt: '<script>skills</script>', current: [],
          answer: { kind: 'rules', maxItems: 12, allowBlocking: false },
        },
      ],
    },
  });
  assert.ok(html.indexOf('Universal questions') < html.indexOf('Specialist follow-ups'));
  assert.match(html, /data-adaptive-include="primary-work"/);
  assert.match(html, /Save selected structured answers/);
  assert.doesNotMatch(html, /<script>skills<\/script>/);
  assert.match(html, /&lt;script&gt;skills&lt;\/script&gt;/);
});

test('search-lane review shows bounded evidence with explicit retirement and restoration controls', () => {
  const lane = {
    id: 'lane-aaaaaaaaaaaaaaaa',
    query: '<script>Platform engineer</script>',
    kind: 'title',
    state: 'active',
    runCount: 3,
    consecutiveUnproductiveRuns: 3,
    aggregate: { returned: 4, eligible: 0, promising: 0 },
    profileFields: [{ path: 'target.primaryTitles' }],
    history: [{
      recordedAt: '2026-07-30T10:00:00.000Z',
      returned: 1,
      eligible: 0,
      promising: 0,
      failures: [{ source: 'adzuna', code: 'source-query-failed' }],
    }],
  };
  const html = searchLanePlanHtml({
    lanePlan: {
      lanes: [
        lane,
        {
          ...lane,
          id: 'lane-bbbbbbbbbbbbbbbb',
          query: 'Restorable lane',
          state: 'retired',
          retirement: { reversible: true },
          consecutiveUnproductiveRuns: 0,
        },
      ],
      archivedLanes: [],
    },
    laneRevision: 'revision',
  });

  assert.doesNotMatch(html, /<script>Platform/);
  assert.match(html, /&lt;script&gt;Platform engineer&lt;\/script&gt;/);
  assert.match(html, /source failure recorded/);
  assert.match(html, /search-lanes-retire-confirm/);
  assert.match(html, /data-search-lane-restore="lane-bbbbbbbbbbbbbbbb"/);
});

test('profile review renders safely before profile state loads', () => {
  const html = searchProfileReviewHtml(null);
  assert.match(html, /No complete draft is available yet/);
  assert.match(html, /Not yet published/);
});

test('splitList accepts comma and newline separated settings', () => {
  assert.deepEqual(splitList('Robotics, climate tech\nHealthcare,  '), [
    'Robotics', 'climate tech', 'Healthcare',
  ]);
});

test('provider login panel exposes only accessible state-specific guided actions', () => {
  const idle = providerLoginPanelHtml('codex', {
    installed: true, authenticated: false,
  }, null);
  assert.match(idle, /Sign in to Codex with Scout/);
  assert.match(idle, /codex login --device-auth/);
  assert.match(idle, /Official Codex login guide/);
  assert.match(idle, /aria-live="polite"/);
  assert.doesNotMatch(idle, /provider-login-code/);

  const remoteAuthFailure = providerLoginPanelHtml('codex', {
    installed: true,
    authenticated: true,
    healthState: 'sign-in-required',
  }, null);
  assert.match(remoteAuthFailure, /Codex needs sign-in/);
  assert.match(remoteAuthFailure, /Sign in to Codex with Scout/);
  assert.match(remoteAuthFailure, /codex login --device-auth/);
  assert.doesNotMatch(remoteAuthFailure, /Codex is signed in/);

  const waiting = providerLoginPanelHtml('claude', {
    installed: true, authenticated: false,
  }, {
    provider: 'claude',
    sessionId: 'synthetic-session',
    state: 'awaiting-code',
    codeRequired: true,
    reasonCode: null,
  });
  assert.match(waiting, /provider-login-code-claude/);
  assert.match(waiting, /maxlength="256"/);
  assert.match(waiting, /autocomplete="off"/);
  assert.match(waiting, /spellcheck="false"/);
  assert.match(waiting, /Submit code/);
  assert.match(waiting, /Cancel Claude sign-in/);

  const failed = providerLoginPanelHtml('claude', {
    installed: true, authenticated: false,
  }, {
    provider: 'claude',
    sessionId: 'synthetic-session',
    state: 'failed',
    codeRequired: false,
    reasonCode: 'validation-failed',
  });
  assert.match(failed, /Retry Claude sign-in/);
  assert.doesNotMatch(failed, /Clear expired Claude sign-in/);
  assert.match(failed, /claude auth login/);
  assert.doesNotMatch(failed, /validation-failed/);

  const expired = providerLoginPanelHtml('claude', {
    installed: true, authenticated: false,
  }, {
    provider: 'claude',
    sessionId: 'synthetic-session',
    state: 'failed',
    codeRequired: false,
    reasonCode: 'credentials-expired',
  });
  assert.match(expired, /Clear expired Claude sign-in/);
  assert.match(expired, /data-session-id="synthetic-session"/);

  const pending = providerLoginPanelHtml('claude', {
    installed: true, authenticated: false,
  }, {
    provider: 'claude',
    sessionId: 'synthetic-session',
    state: 'failed',
    codeRequired: false,
    reasonCode: 'credentials-expired',
  }, true);
  assert.match(pending, /disabled aria-disabled="true"/);

  const succeeded = providerLoginPanelHtml('codex', {
    installed: true, authenticated: false,
  }, {
    provider: 'codex',
    sessionId: 'synthetic-session',
    state: 'succeeded',
    codeRequired: false,
    reasonCode: null,
  });
  assert.match(succeeded, /Sign-in succeeded/);
  assert.doesNotMatch(succeeded, /Sign in to Codex with Scout/);
});

test('provider login UI keeps its CSRF token and manual code out of browser storage', () => {
  const source = fs.readFileSync(new URL('./setup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage).*providerLogin/i);
  assert.doesNotMatch(source, /providerLogin.*(?:localStorage|sessionStorage)/i);
  assert.match(source, /codeInput\.value = ''/);
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

test('a fresh first scan stays gated until its search profile is published', () => {
  assert.equal(firstScanProfileReady(null), false);
  assert.equal(firstScanProfileReady({ draft: {} }), false);
  assert.equal(firstScanProfileReady({ published: { id: 'profile-1' } }), true);
  assert.equal(firstScanProfileReady(null, true), true);
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

test('backup details explain safe and manual divergence without exposing paths', async () => {
  globalThis.window = globalThis.window || {};
  await import('./setup.js?backup-resolution-harness');
  const view = Object.create(globalThis.window.ScoutSetup);
  view.status = {
    config: { locale: 'en-GB' },
    git: { installed: true },
    sync: {
      enabled: true,
      state: 'needs-attention',
      conflict: true,
      ahead: 1,
      behind: 4,
      lastSuccessfulAt: '2026-07-26T12:54:14.254Z',
      resolution: {
        classification: 'disjoint-safe',
        canResolve: true,
        analysisToken: 'a'.repeat(64),
        localAreas: ['encrypted recovery data'],
        remoteAreas: ['applications'],
      },
    },
  };
  const safe = view.backupPanelHtml();
  assert.match(safe, /Scout host and GitHub both have new backup history/);
  assert.match(safe, /Preserve both and sync/);
  assert.match(safe, /encrypted recovery data/);
  assert.match(safe, /Retry alone cannot resolve/);
  assert.doesNotMatch(safe, /\.scout-backup|applications\/synthetic-role/);

  view.status.sync.resolution = {
    classification: 'overlapping',
    canResolve: false,
    reason: 'the Scout host and GitHub changed at least one of the same files',
    localAreas: ['workspace settings'],
    remoteAreas: ['workspace settings'],
  };
  const manual = view.backupPanelHtml();
  assert.doesNotMatch(manual, /id="setup-resolve-backup"/);
  assert.match(manual, /cannot safely resolve/);
  assert.match(manual, /Do not reset, rebase, force-push/);
});

// Renders renderFirstScan for real and inspects the output, so a behavioural
// regression fails here even if the source text is rewritten, and a harmless
// reformat does not.
async function renderFirstScanHtml({ scanHealth, jobs = [], runs = [] }) {
  globalThis.window = globalThis.window || {};
  // A query string gives a module instance loaded after `window` exists, so the
  // module's `window.ScoutSetup = Setup` export runs. `document` is deliberately
  // installed only afterwards, so the module's auto-init does not fire.
  await import('./setup.js?render-harness');
  const Setup = globalThis.window.ScoutSetup;
  const body = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  const noop = { addEventListener() {}, textContent: '' };
  const elements = { 'setup-body': body, 'setup-run-scan': noop, 'setup-next': noop };
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: (id) => elements[id] };
  try {
    const view = Object.create(Setup);
    view.view = 'section';
    view.operations = {};
    view.status = {
      scanHealth, schedule: { runs },
      config: { ai: { provider: 'claude' }, locale: 'en-GB', schedule: { jobs } },
      providers: {},
    };
    view.renderFirstScan({ includeBackup: false });
    return body.innerHTML;
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

function scheduleButton(html) {
  return html.match(/<button[^>]*data-schedule-enable[^>]*>[^<]*<\/button>/)[0];
}

test('a configured schedule job stays editable and drops first-run wording once there is scan history', async () => {
  // Already configured, but the latest scan is unhealthy: the settings must stay
  // saveable — this is the regression the fix is for.
  const configured = await renderFirstScanHtml({
    scanHealth: { lastRunAt: '2026-07-20T07:30:00.000Z', healthy: false },
    jobs: [{ id: 'claude-primary', enabled: true }],
    runs: [{ id: 'claude-primary', provider: 'claude', mode: 'primary', configured: true, time: '07:30', days: [0, 1, 2, 3, 4, 5, 6] }],
  });
  const button = scheduleButton(configured);
  assert.match(button, />Save scan settings</);
  assert.doesNotMatch(button, /\bdisabled\b/);
  // History exists, so none of the first-run wording is used.
  assert.match(configured, /Your first scan is ready to review/);
  assert.match(configured, /Supervised scan completed/);
  assert.match(configured, />Scan now</);
  assert.doesNotMatch(configured, /Run your first search with me/);
  assert.doesNotMatch(configured, /Run first scan now/);

  // Nothing configured and no healthy run: first enablement is still gated, and
  // the first-run wording is still used.
  const firstRun = await renderFirstScanHtml({ scanHealth: {}, jobs: [], runs: [] });
  const firstButton = scheduleButton(firstRun);
  assert.match(firstButton, />Enable claude scan</);
  assert.match(firstButton, /\bdisabled\b/);
  assert.match(firstRun, /Run your first search with me/);
  assert.match(firstRun, /Supervised first scan/);
  assert.match(firstRun, />Run first scan now</);
});

test('the alternating preset gives each provider its own days', () => {
  const primary = presetDays('alternating', 'primary');
  const second = presetDays('alternating', 'second-pass');
  assert.deepEqual(primary, ALTERNATING_DAYS.primary);
  assert.deepEqual(second, ALTERNATING_DAYS['second-pass']);
  assert.equal(primary.some((day) => second.includes(day)), false);
  assert.deepEqual([...primary, ...second].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
});

test('the alternating weekdays preset offsets providers and excludes weekends', () => {
  const primary = presetDays('alternating-weekdays', 'primary');
  const second = presetDays('alternating-weekdays', 'second-pass');
  assert.deepEqual(primary, [1, 3, 5]);
  assert.deepEqual(second, [2, 4]);
  assert.equal(primary.some((day) => second.includes(day)), false);
  assert.equal([...primary, ...second].some((day) => day === 0 || day === 6), false);
});

test('day presets round-trip to the selection they describe', () => {
  for (const mode of ['primary', 'second-pass']) {
    for (const preset of ['every', 'alternating', 'alternating-weekdays', 'weekdays']) {
      assert.equal(matchingPreset(presetDays(preset, mode), mode), preset);
    }
  }
  assert.equal(matchingPreset([1, 4], 'primary'), 'custom');
  assert.equal(matchingPreset([], 'primary'), 'every');
});
