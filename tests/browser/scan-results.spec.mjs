import { expect, test } from '@playwright/test';

const reviewed = Array.from({ length: 40 }, (_, index) => ({
  company: `Synthetic Company ${index + 1}`,
  role: `Synthetic Role ${index + 1}`,
  source: 'synthetic', sourceUrl: `https://example.test/jobs/${index + 1}`,
  categoryId: 'priority', outcome: index < 16 ? 'mandatory_unmet' : 'provider_discarded',
  score: 54 - (index % 10), reasons: [index < 16 ? 'Required synthetic evidence was not met' : 'Insufficient evidence-led fit'],
}));
const coverageRow = (value) => ({
  value, found: 42, ranked: 42, selected: 40, excluded: 0, assessed: 40, assessmentFailed: 0,
});

const scan = {
  schemaVersion: 5, runAt: '2026-07-22T10:00:00.000Z', provider: 'codex', mode: 'broadened',
  degraded: false, candidatesFound: 40, keepersAdded: 0, keepersUpdated: 0,
  discarded: { hard_exclusion: 0, mandatory_unmet: 16, below_threshold: 0, provider_discarded: 24 },
  sourceHealth: { synthetic: { status: 'healthy', count: 40 } }, reportDate: '2026-07-22',
  automaticBroadened: true,
  coverage: {
    source: [coverageRow('synthetic')],
    employer: [coverageRow('Synthetic employers')],
    lane: [coverageRow('primary')],
    roleFamily: [coverageRow('engineering')],
    location: [coverageRow('United Kingdom')],
    provider: [coverageRow('codex')],
    run: [coverageRow('run-synthetic')],
    date: [coverageRow('2026-07-22')],
    failureReasons: [{ value: 'diversity-limit', count: 1 }],
  },
  explanations: [{
    vacancyId: 'promising-diversity-miss', company: 'Promising Company', role: 'Platform Lead',
    dimensions: { source: 'synthetic', lane: 'primary', roleFamily: 'engineering', location: 'London' },
    stages: { found: true, ranked: true, selected: false, excluded: false, assessed: false },
    aboveThreshold: true, preRank: { score: 88, positive: [], negative: [] },
    reasonCode: 'diversity-limit', assessmentStatus: 'not-selected',
    sourceUrl: 'https://example.test/jobs/promising',
  }, {
    vacancyId: 'threshold-miss', company: 'Lower Match Company', role: 'Operations Lead',
    dimensions: { source: 'synthetic', lane: 'adjacent', roleFamily: 'operations', location: 'Leeds' },
    stages: { found: true, ranked: true, selected: false, excluded: false, assessed: false },
    aboveThreshold: false, preRank: { score: 32, positive: [], negative: [] },
    reasonCode: 'below-relevance-threshold', assessmentStatus: 'not-selected',
    sourceUrl: 'https://example.test/jobs/lower',
  }],
  reviewed,
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/setup/status', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    bootstrap: false, established: true, ready: true, setupComplete: true, trackerExists: true,
    config: { locale: 'en-GB', ai: { provider: 'codex' }, search: {}, commute: {} }, providers: {},
    scanHealth: { healthy: true, lastRunAt: scan.runAt }, schedule: { enabled: false, runs: [] },
    sync: { state: 'disabled' }, device: { updates: { policy: 'notify' }, startupStatus: {} }, remoteAccess: {}, pendingSetupSections: [],
  }) }));
  await page.route('**/api/opportunities', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    updated: '2026-07-22', opportunities: [], triage: { action: [], unlock: [], followups: [], other: [] },
    pipeline: { summary: { new: 0, watch: 0, active: 0, recentlyClosed: 0, flags: 0 }, new: [], watch: [], active: [], recentlyClosed: [], flags: [] },
    scanHealth: { healthy: true, lastRunAt: scan.runAt, candidatesFound: 40, keepersAdded: 0, discarded: scan.discarded, sourceHealth: [] },
    categories: [{ id: 'priority', label: 'Priority' }], workspaceConfig: { ai: { provider: 'codex' }, commute: {} }, trackerRevision: 'synthetic',
  }) }));
  await page.route('**/api/scans/latest', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ scan }) }));
  await page.route('**/api/scan/runs', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    runs: [{
      id: 'run-1234…', state: 'repairing', label: 'Repairing affected jobs',
      owner: 'active worker', startedAt: '2026-07-22T09:53:00.000Z',
      updatedAt: '2026-07-22T09:59:00.000Z', recoveryCount: 1,
      completedStages: ['collect', 'normalise', 'deduplicate', 'filter', 'rank', 'select'],
      assessment: {
        currentBatch: 2, totalBatches: 4, totalBatchesExact: true,
        completedBatches: 1, completedJobs: 10, failedJobs: 0,
      },
      terminalReason: null,
    }],
  }) }));
  await page.route('**/api/scan/queue', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    requests: [{
      id: 'request-…', status: 'queued', requester: 'manual', purpose: 'job-discovery',
      requestedAt: '2026-07-22T09:58:00.000Z', expiresAt: '2026-07-23T09:58:00.000Z',
    }],
  }) }));
  await page.route('**/api/cv', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ master: 'cv/master-cv.md', masterRender: {}, applications: [], entries: [] }) }));
  await page.goto('/');
});

test('zero-keeper results remain visible and expose the complete sanitised audit', async ({ page }) => {
  await expect(page.locator('#scan-status')).toHaveText(/Repairing affected jobs/);
  await expect(page.getByText('40 assessed, 0 kept').first()).toBeVisible();
  await expect(page.getByText(/16 mandatory gates/).first()).toBeVisible();
  await expect(page.getByText(/automatic broader discovery pass/)).toBeVisible();
  await page.getByRole('button', { name: 'Review this scan' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Latest scan result' });
  await expect(dialog.getByText('Mandatory gates (16)')).toBeVisible();
  await expect(dialog.getByText('Assessment discards (24)')).toBeVisible();
  await expect(dialog.getByText('Coverage by source (1)')).toBeVisible();
  await expect(dialog.getByText('Coverage by role family (1)')).toBeVisible();
  await expect(dialog.getByText('Coverage failures (1)')).toBeVisible();
  await expect(dialog.getByText('Why roles missed detailed assessment (2)')).toBeVisible();
  await expect(dialog.getByText('Promising Company — Platform Lead')).toBeVisible();
  await expect(dialog.locator('.scan-explanation-item p').filter({ hasText: /stronger mix of employers, sources, role families/i })).toBeVisible();
  await expect(dialog.locator('.scan-review-item:not(.scan-explanation-item)')).toHaveCount(49);
  await expect(dialog.locator('.scan-explanation-item')).toHaveCount(2);
  await expect(page.locator('.card[data-id]')).toHaveCount(0);
});

test('journal-backed recovery and queued overlap stay visible without diagnostic identity', async ({ page }) => {
  await expect(page.locator('#scan-status')).toContainText(/Repairing affected jobs/i);
  await expect(page.getByText(/batch 2 of 4/i).first()).toBeVisible();
  await expect(page.getByText(/1 recovery/i).first()).toBeVisible();
  await expect(page.getByText(/1 queued request/i).first()).toBeVisible();
  await expect(page.getByText('run-1234…').first()).toBeVisible();
  await expect(page.getByText(/PRIVATE-HOST|private-start|4242/)).toHaveCount(0);
});

test('first-run queue and waiting states come from durable summaries', async ({ page }) => {
  await page.unroute('**/api/opportunities');
  await page.route('**/api/opportunities', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    updated: '2026-07-22', opportunities: [], triage: { action: [], unlock: [], followups: [], other: [] },
    pipeline: { summary: {}, new: [], watch: [], active: [], recentlyClosed: [], flags: [] },
    scanHealth: { healthy: false, lastRunAt: null }, categories: [],
    workspaceConfig: { ai: { provider: 'codex' }, commute: {} }, trackerRevision: 'synthetic',
  }) }));
  await page.unroute('**/api/scans/latest');
  await page.route('**/api/scans/latest', (route) => route.fulfill({ contentType: 'application/json', body: '{"scan":null}' }));
  await page.unroute('**/api/scan/runs');
  await page.route('**/api/scan/runs', (route) => route.fulfill({ contentType: 'application/json', body: '{"state":"waiting","runs":[]}' }));
  await page.unroute('**/api/scan/queue');
  await page.route('**/api/scan/queue', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    state: 'queued', requests: [{ id: 'request-…', status: 'queued', requester: 'manual', purpose: 'job-discovery' }],
  }) }));
  await page.reload();
  await expect(page.locator('#scan-status')).toHaveText(/1 queued request/i);
  await expect(page.getByText(/1 queued request/i).first()).toBeVisible();

  await page.unroute('**/api/scan/queue');
  await page.route('**/api/scan/queue', (route) => route.fulfill({ contentType: 'application/json', body: '{"state":"waiting","requests":[]}' }));
  await page.reload();
  await expect(page.locator('#scan-status')).toHaveText(/Waiting to scan/i);
  await expect(page.getByText(/Waiting to scan/i).first()).toBeVisible();
});

test('manual scan status and approximate remaining time stay visible on a narrow screen', async ({ page }) => {
  await page.unroute('**/api/scan/runs');
  let releaseRuns;
  let markRunsRequested;
  const runsRequested = new Promise((resolve) => { markRunsRequested = resolve; });
  await page.route('**/api/scan/runs', async (route) => {
    markRunsRequested();
    await new Promise((resolve) => { releaseRuns = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      runs: [{
        id: 'run-1234…', state: 'repairing', label: 'Repairing affected jobs',
        assessment: { currentBatch: 2, totalBatches: 4, totalBatchesExact: true },
      }],
    }) });
  });
  const reload = page.reload({ waitUntil: 'domcontentloaded' });
  await runsRequested;
  await page.setViewportSize({ width: 375, height: 760 });
  await page.evaluate(() => {
    window.Scout.scanRunning = true;
    window.Scout.showOperation({
      id: 'scan-eta', type: 'scan', status: 'running', phase: 'Scoring candidates',
      progress: { current: 3, total: 5 }, startedAt: new Date(Date.now() - 120000).toISOString(),
      estimate: { basis: 'history', sampleSize: 3, totalSecondsLow: 360, totalSecondsHigh: 540 },
    });
  });
  releaseRuns();
  await reload;
  await page.waitForFunction(() => Boolean(window.Scout.state.data));
  await expect(page.locator('#scan-status')).toBeVisible();
  await expect(page.locator('#scan-status')).toContainText(/about 4–7 min remaining/i);
});

test('transient operation polling failure keeps the active scan fenced and recovers', async ({ page }) => {
  let requests = 0;
  let releaseRecovery;
  const recoveryAllowed = new Promise((resolve) => { releaseRecovery = resolve; });
  await page.route('**/api/operations/scan-transient', async (route) => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporarily unavailable"}' });
      return;
    }
    await recoveryAllowed;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      operation: {
        id: 'scan-transient', type: 'scan', status: 'running', phase: 'Scoring candidates',
        progress: { current: 2, total: 5 }, startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    }) });
  });
  await page.evaluate(() => window.Scout.watchScanOperation('scan-transient'));
  await expect.poll(() => requests).toBe(2);
  await expect(page.locator('#scan-now')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.Scout.scanRunning)).toBe(true);
  releaseRecovery();
  await expect(page.locator('#scan-status')).toContainText(/Scoring candidates/i);
});

test('missing pre-restart operation is rediscovered without dropping the scan fence', async ({ page }) => {
  await page.waitForFunction(() => Boolean(window.Scout.state.data));
  await page.waitForTimeout(100);
  let replacementPolls = 0;
  let discoveryRequests = 0;
  await page.route('**/api/operations/scan-before-restart', (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: '{"error":"operation not found"}',
  }));
  await page.route('**/api/operations?type=scan', (route) => {
    discoveryRequests += 1;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      operation: {
        id: 'scan-after-restart', type: 'scan', status: 'running', phase: 'Recovering scan',
        progress: { current: 1, total: 3 }, startedAt: new Date(Date.now() - 30_000).toISOString(),
      },
    }) });
  });
  await page.route('**/api/operations/scan-after-restart', (route) => {
    replacementPolls += 1;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      operation: {
        id: 'scan-after-restart', type: 'scan', status: 'running', phase: 'Recovering scan',
        progress: { current: 1, total: 3 }, startedAt: new Date(Date.now() - 30_000).toISOString(),
      },
    }) });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    clearTimeout(window.Scout.scanOperationTimer);
    window.Scout.scanOperationTimer = null;
  });
  discoveryRequests = 0;
  replacementPolls = 0;
  await page.evaluate(() => window.Scout.watchScanOperation('scan-before-restart'));
  await expect.poll(() => discoveryRequests).toBe(1);
  await expect.poll(() => replacementPolls).toBeGreaterThan(0);
  await expect(page.locator('#scan-now')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.Scout.scanRunning)).toBe(true);
  await expect(page.locator('#scan-status')).toContainText(/Recovering scan/i);
});

test('missing operation re-enables scanning only after durable state is idle', async ({ page }) => {
  await page.waitForFunction(() => Boolean(window.Scout.state.data));
  await page.route('**/api/operations/scan-finished-before-restart', (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: '{"error":"operation not found"}',
  }));
  await page.route('**/api/operations?type=scan', (route) => route.fulfill({
    contentType: 'application/json', body: '{"operation":null,"operations":[]}',
  }));
  await page.route('**/api/scan/runs', (route) => route.fulfill({
    contentType: 'application/json', body: '{"state":"waiting","runs":[]}',
  }));
  await page.route('**/api/scan/queue', (route) => route.fulfill({
    contentType: 'application/json', body: '{"state":"waiting","requests":[]}',
  }));
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    clearTimeout(window.Scout.scanOperationTimer);
    window.Scout.scanOperationTimer = null;
    window.Scout.watchScanOperation('scan-finished-before-restart');
  });
  await expect(page.locator('#scan-now')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => window.Scout.scanRunning)).toBe(false);
});

test('missing operation stays fenced when durable scan state is unavailable', async ({ page }) => {
  await page.waitForFunction(() => Boolean(window.Scout.state.data));
  let reconciliationRequests = 0;
  let runsRequests = 0;
  let queueRequests = 0;
  await page.route('**/api/operations/scan-unknown-after-restart', (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: '{"error":"operation not found"}',
  }));
  await page.route('**/api/operations?type=scan', (route) => {
    reconciliationRequests += 1;
    return route.fulfill({ contentType: 'application/json', body: '{"operation":null,"operations":[]}' });
  });
  await page.route('**/api/scan/runs', (route) => {
    runsRequests += 1;
    return route.fulfill(runsRequests % 2 === 1
      ? { status: 503, contentType: 'application/json', body: '{"error":"durable scan state needs attention"}' }
      : { contentType: 'application/json', body: '{"state":"waiting","runs":[]}' });
  });
  await page.route('**/api/scan/queue', (route) => {
    queueRequests += 1;
    return route.fulfill(queueRequests % 2 === 0
      ? { status: 503, contentType: 'application/json', body: '{"error":"durable queue state needs attention"}' }
      : { contentType: 'application/json', body: '{"state":"waiting","requests":[]}' });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    clearTimeout(window.Scout.scanOperationTimer);
    window.Scout.scanOperationTimer = null;
  });
  reconciliationRequests = 0;
  runsRequests = 0;
  queueRequests = 0;
  await page.evaluate(() => window.Scout.watchScanOperation('scan-unknown-after-restart'));
  await expect.poll(() => reconciliationRequests).toBeGreaterThan(1);
  await expect.poll(() => runsRequests).toBeGreaterThan(1);
  await expect.poll(() => queueRequests).toBeGreaterThan(1);
  await expect(page.locator('#scan-now')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.Scout.scanRunning)).toBe(true);
});

test('claimed durable queue work remains fenced before a recovered run exists', async ({ page }) => {
  await page.waitForFunction(() => Boolean(window.Scout.state.data));
  await page.route('**/api/operations/scan-claimed-before-restart', (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: '{"error":"operation not found"}',
  }));
  await page.route('**/api/operations?type=scan', (route) => route.fulfill({
    contentType: 'application/json', body: '{"operation":null,"operations":[]}',
  }));
  await page.route('**/api/scan/runs', (route) => route.fulfill({
    contentType: 'application/json', body: '{"state":"waiting","runs":[]}',
  }));
  await page.route('**/api/scan/queue', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({
      state: 'waiting',
      requests: [
        { id: 'claimed-request', status: 'claimed' },
        { id: 'legacy-claimed-request', status: 'legacy-claimed' },
      ],
    }),
  }));
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    clearTimeout(window.Scout.scanOperationTimer);
    window.Scout.scanOperationTimer = null;
    window.Scout.watchScanOperation('scan-claimed-before-restart');
  });
  await page.waitForTimeout(1500);
  await expect(page.locator('#scan-now')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.Scout.scanRunning)).toBe(true);
});

test('malformed durable statuses never prove restart reconciliation is idle', async ({ page }) => {
  await page.waitForFunction(() => Boolean(window.Scout.state.data));
  let reconciliations = 0;
  await page.route('**/api/operations/scan-malformed-after-restart', (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: '{"error":"operation not found"}',
  }));
  await page.route('**/api/operations?type=scan', (route) => {
    reconciliations += 1;
    return route.fulfill({ contentType: 'application/json', body: '{"operation":null,"operations":[]}' });
  });
  await page.route('**/api/scan/runs', (route) => route.fulfill({
    contentType: 'application/json', body: '{"state":"waiting","runs":[]}',
  }));
  await page.route('**/api/scan/queue', (route) => {
    const malformed = [
      { state: 'waiting', requests: [{ status: 'unsupported' }] },
      { state: 'waiting', requests: [{}] },
      { state: 'claimed', requests: [] },
    ][Math.min(Math.max(reconciliations - 1, 0), 2)];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(malformed) });
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    clearTimeout(window.Scout.scanOperationTimer);
    window.Scout.scanOperationTimer = null;
  });
  reconciliations = 0;
  await page.evaluate(() => window.Scout.watchScanOperation('scan-malformed-after-restart'));
  await expect.poll(() => reconciliations).toBeGreaterThan(3);
  await expect(page.locator('#scan-now')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.Scout.scanRunning)).toBe(true);
});
