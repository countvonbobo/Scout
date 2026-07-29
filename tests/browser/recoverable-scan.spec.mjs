import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { currentLeaseOwner } from '../../ui/lib/scanLease.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_ACCEPTANCE_SUITES = Object.freeze([
  'ui/lib/runJournal.test.mjs',
  'ui/lib/runArtifacts.test.mjs',
  'ui/lib/runRecovery.test.mjs',
  'ui/lib/scanLease.test.mjs',
  'ui/lib/scanPipeline.test.mjs',
  'ui/lib/assessmentBatches.test.mjs',
  'ui/lib/scanQueue.test.mjs',
  'ui/lib/mutationCoordinator.test.mjs',
  'ui/lib/recoveryBackup.test.mjs',
  'ui/lib/workspaceSync.test.mjs',
  'ui/lib/runRetention.test.mjs',
  'ui/lib/providerHealth.test.mjs',
  'ui/lib/providerLogin.test.mjs',
  'ui/lib/providers.test.mjs',
  'ui/lib/scheduler.test.mjs',
  'ui/server.test.mjs',
]);

const PRIVATE_SENTINELS = [
  'PRIVATE-HOST',
  ['', 'Users', 'synthetic-private'].join('/'),
  'SYNTHETIC-AUTH-CODE',
  'SYNTHETIC-PRIVATE-PROMPT',
  'SYNTHETIC-PROVIDER-TRANSCRIPT',
  'utm_source=synthetic-private',
];

test('the real acceptance suite manifest contains only existing test files', () => {
  expect(
    REAL_ACCEPTANCE_SUITES.filter((relative) => !fs.existsSync(path.join(ROOT, relative))),
  ).toEqual([]);
});

function setupStatus() {
  return {
    bootstrap: false,
    established: true,
    ready: true,
    setupComplete: true,
    trackerExists: true,
    config: {
      locale: 'en-GB',
      ai: { provider: 'codex', models: { codex: null, claude: null } },
      search: {},
      commute: {},
    },
    providers: {
      codex: {
        installed: true,
        authenticated: true,
        capabilities: { structuredOutput: true },
      },
      claude: {
        installed: true,
        authenticated: false,
        capabilities: { structuredOutput: true },
      },
    },
    scanHealth: { healthy: false, lastRunAt: null },
    schedule: { enabled: false, runs: [] },
    sync: { state: 'disabled' },
    device: { updates: { policy: 'notify' }, startupStatus: {} },
    remoteAccess: {},
    pendingSetupSections: [],
  };
}

async function installRecoverableRoutes(page, state) {
  await page.route('**/api/setup/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(setupStatus()),
  }));
  await page.route('**/api/opportunities', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      updated: '2026-07-29',
      opportunities: [],
      triage: { action: [], unlock: [], followups: [], other: [] },
      pipeline: {
        summary: {},
        new: [],
        watch: [],
        active: [],
        recentlyClosed: [],
        flags: [],
      },
      scanHealth: { healthy: false, lastRunAt: null, sourceHealth: [] },
      categories: [],
      workspaceConfig: { ai: { provider: 'codex' }, commute: {} },
      trackerRevision: 'synthetic-revision',
    }),
  }));
  await page.route('**/api/cv', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      master: null,
      masterRender: {},
      applications: [],
      entries: [],
    }),
  }));
  await page.route('**/api/scans/latest', (route) => route.fulfill({
    contentType: 'application/json',
    body: '{"scan":null}',
  }));
  await page.route('**/api/scan/runs', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(state.runs),
  }));
  await page.route('**/api/scan/queue', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(state.queue),
  }));
  await page.route('**/api/provider-login/status?*', (route) => {
    const provider = new URL(route.request().url()).searchParams.get('provider');
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        provider,
        session: null,
        csrfToken: `csrf-${provider}-synthetic-000000000000`,
      }),
    });
  });
}

function publicRun(state, label, fields = {}) {
  return {
    id: 'run-synthetic…',
    state,
    label,
    owner: state === 'complete' ? 'inactive worker' : 'active worker',
    startedAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:01:00.000Z',
    recoveryCount: fields.recoveryCount || 0,
    completedStages: fields.completedStages || [],
    assessment: fields.assessment || null,
    terminalReason: fields.terminalReason || null,
    // Fault-injected fields are intentionally outside the public contract.
    host: PRIVATE_SENTINELS[0],
    pid: 4242,
    workingDirectory: PRIVATE_SENTINELS[1],
    authCode: PRIVATE_SENTINELS[2],
    prompt: PRIVATE_SENTINELS[3],
    providerTranscript: PRIVATE_SENTINELS[4],
    sourceUrl: `https://example.test/job?${PRIVATE_SENTINELS[5]}`,
  };
}

test('real fault-injection durability and security suites form one release acceptance boundary', async ({ browserName }) => {
  test.skip(browserName !== 'chromium', 'the release matrix is browser-independent and runs once');
  try {
    currentLeaseOwner();
  } catch {
    test.skip(true, 'this macOS host cannot read its own process-start identity; the Linux CI matrix is authoritative');
  }
  test.setTimeout(180_000);
  const result = spawnSync(process.execPath, ['--test', ...REAL_ACCEPTANCE_SUITES], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 170_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  expect(
    result.status,
    `real recovery acceptance failed\n${String(result.stdout || '').slice(-8000)}\n${String(result.stderr || '').slice(-8000)}`,
  ).toBe(0);
});

test('real recovery and provider APIs reject a fault-injected private journal identity', async ({ page, request }) => {
  const workspace = process.env.SCOUT_WORKSPACE;
  expect(workspace).toBeTruthy();
  const sentinel = 'PRIVATE-FAULT-JOURNAL-IDENTITY';
  const corruptRun = path.join(workspace, '.scout', 'runs', sentinel);
  fs.mkdirSync(corruptRun, { recursive: true });
  fs.writeFileSync(path.join(corruptRun, 'journal.jsonl'), '{"not":"a valid journal"}\n');
  try {
    const [runsResponse, queueResponse, loginResponse] = await Promise.all([
      request.get('/api/scan/runs'),
      request.get('/api/scan/queue'),
      request.get('/api/provider-login/status?provider=codex'),
    ]);
    expect(runsResponse.ok()).toBe(true);
    expect(queueResponse.ok()).toBe(true);
    expect(loginResponse.ok()).toBe(true);
    const payloads = JSON.stringify([
      await runsResponse.json(),
      await queueResponse.json(),
      await loginResponse.json(),
    ]);
    expect(payloads).not.toContain(sentinel);
    expect(payloads).not.toContain(workspace);
    expect(payloads).not.toMatch(/rawRunState|rawAuthOutput|providerTranscript|authCode|prompt|utm_source/i);

    await page.goto('/');
    await expect(page.getByText(sentinel, { exact: false })).toHaveCount(0);
    const browserState = await page.evaluate(() => JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage),
    }));
    expect(browserState).not.toContain(sentinel);
    expect(browserState).not.toContain(workspace);
  } finally {
    fs.rmSync(corruptRun, { recursive: true, force: true });
  }
});

test('every durable pipeline and recovery state remains reviewable and privacy-safe', async ({ page }) => {
  const state = {
    runs: { state: 'waiting', runs: [] },
    queue: { state: 'waiting', requests: [] },
  };
  await installRecoverableRoutes(page, state);
  await page.goto('/');

  const phases = [
    ['queued', 'Queued for a fenced worker'],
    ['collecting', 'Collecting source records'],
    ['normalising', 'Normalising records'],
    ['deduplicating', 'Deduplicating vacancies'],
    ['filtering', 'Applying confirmed rules'],
    ['ranking', 'Ranking eligible vacancies'],
    ['selecting', 'Selecting the assessment set'],
    ['assessing', 'Assessing jobs in bounded batches'],
    ['repairing', 'Repairing affected jobs'],
    ['recovered', 'Recovered compatible work'],
    ['partial', 'Completed with partial evidence'],
    ['abandoned', 'Abandoned safely'],
    ['failed', 'Failed without mutation'],
    ['complete', 'Completed and backed up'],
  ];
  for (const [runState, label] of phases) {
    state.runs = {
      state: runState,
      runs: [publicRun(runState, label, {
        recoveryCount: runState === 'recovered' ? 1 : 0,
        assessment: ['assessing', 'repairing'].includes(runState)
          ? {
            currentBatch: 2,
            totalBatches: 4,
            totalBatchesExact: true,
            completedBatches: 1,
            completedJobs: 10,
            failedJobs: runState === 'repairing' ? 1 : 0,
          }
          : null,
        terminalReason: ['partial', 'abandoned', 'failed'].includes(runState)
          ? `${runState}-bounded-reason`
          : null,
      })],
    };
    await page.reload();
    const audit = page.locator('.scan-run-audit');
    await expect(audit.locator('.chip')).toHaveText(runState);
    await expect(audit).toContainText(label);
    if (runState === 'recovered') await expect(audit).toContainText('1 recovery');
    if (['assessing', 'repairing'].includes(runState)) {
      await expect(audit).toContainText('batch 2 of 4');
    }
    for (const sentinel of PRIVATE_SENTINELS) {
      await expect(page.getByText(sentinel, { exact: false })).toHaveCount(0);
    }
  }
});

test('overlap queue expiry, deduplication and automatic handoff stay coherent', async ({ page }) => {
  const state = {
    runs: { state: 'waiting', runs: [] },
    queue: {
      state: 'queued',
      requests: [{
        id: 'request-synthetic…',
        status: 'queued',
        requester: 'manual',
        purpose: 'job-discovery',
        requestedAt: '2026-07-29T10:00:00.000Z',
        expiresAt: '2026-07-29T22:00:00.000Z',
      }],
    },
  };
  await installRecoverableRoutes(page, state);
  await page.goto('/');
  await expect(page.locator('#scan-status')).toHaveText('1 queued request');
  await expect(page.locator('.scan-run-audit')).toContainText('1 queued request');

  // A duplicate request is represented by durable audit evidence, not a
  // second public queue entry.
  state.queue = {
    ...state.queue,
    deduplicatedCount: 1,
    requests: [{ ...state.queue.requests[0] }],
  };
  await page.reload();
  await expect(page.locator('#scan-status')).toHaveText('1 queued request');

  // Expiry removes the request from live work.
  state.queue = {
    state: 'waiting',
    requests: [{ ...state.queue.requests[0], status: 'expired' }],
  };
  await page.reload();
  await expect(page.locator('#scan-status')).toHaveText('Waiting to scan');

  // Automatic handoff exposes the successor's newer fence only through its
  // bounded public state.
  state.runs = {
    state: 'collecting',
    runs: [publicRun('collecting', 'Collecting handed-off work', {
      recoveryCount: 1,
    })],
  };
  state.queue = {
    state: 'claimed',
    requests: [{
      id: 'request-synthetic…',
      status: 'claimed',
      requester: 'manual',
      purpose: 'job-discovery',
    }],
  };
  await page.reload();
  await expect(page.locator('#scan-status')).toContainText('Collecting handed-off work');
  await expect(page.locator('.scan-run-audit')).toContainText('1 recovery');
  await expect(page.getByText(/generation|lease|4242|PRIVATE-HOST/i)).toHaveCount(0);
});

test('Tasks 12–17 compose in one accessible settings and dashboard session', async ({ page }) => {
  const state = {
    runs: {
      state: 'repairing',
      runs: [publicRun('repairing', 'Repairing affected jobs', {
        recoveryCount: 1,
        assessment: {
          currentBatch: 2,
          totalBatches: 3,
          totalBatchesExact: true,
          completedBatches: 1,
          completedJobs: 10,
          failedJobs: 1,
        },
      })],
    },
    queue: { state: 'waiting', requests: [] },
  };
  await installRecoverableRoutes(page, state);
  await page.goto('/', { waitUntil: 'commit' });
  await expect.poll(() => page.evaluate(() => Boolean(window.ScoutCharacter))).toBe(true);
  await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'acceptance-scout';
    probe.innerHTML = window.ScoutCharacter.scoutMarkup('idle');
    document.body.append(probe);
  });
  await expect(page.locator('.acceptance-scout .scout-character'))
    .toHaveAttribute('aria-label', /Scout/i);
  await expect(page.locator('#scan-status')).toContainText('Repairing affected jobs');

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'AI providers' }).click();
  await expect(dialog.getByLabel('Codex model')).toBeVisible();
  await expect(dialog.getByLabel('Claude model')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sign in to Claude with Scout' })).toBeVisible();
  await expect(dialog).toContainText('claude auth login');

  const persisted = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  for (const sentinel of PRIVATE_SENTINELS) {
    expect(JSON.stringify(persisted)).not.toContain(sentinel);
  }
});
