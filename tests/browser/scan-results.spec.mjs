import { expect, test } from '@playwright/test';

const reviewed = Array.from({ length: 40 }, (_, index) => ({
  company: `Synthetic Company ${index + 1}`,
  role: `Synthetic Role ${index + 1}`,
  source: 'synthetic', sourceUrl: `https://example.test/jobs/${index + 1}`,
  categoryId: 'priority', outcome: index < 16 ? 'mandatory_unmet' : 'provider_discarded',
  score: 54 - (index % 10), reasons: [index < 16 ? 'Required synthetic evidence was not met' : 'Insufficient evidence-led fit'],
}));

const scan = {
  schemaVersion: 3, runAt: '2026-07-22T10:00:00.000Z', provider: 'codex', mode: 'broadened',
  degraded: false, candidatesFound: 40, keepersAdded: 0, keepersUpdated: 0,
  discarded: { hard_exclusion: 0, mandatory_unmet: 16, below_threshold: 0, provider_discarded: 24 },
  sourceHealth: { synthetic: { status: 'healthy', count: 40 } }, reportDate: '2026-07-22',
  automaticBroadened: true, reviewed,
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
  await page.route('**/api/cv', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ master: 'cv/master-cv.md', masterRender: {}, applications: [], entries: [] }) }));
  await page.goto('/');
});

test('zero-keeper results remain visible and expose the complete sanitised audit', async ({ page }) => {
  await expect(page.locator('#scan-status')).toHaveText(/40 assessed · 0 kept/);
  await expect(page.getByText('40 assessed, 0 kept').first()).toBeVisible();
  await expect(page.getByText(/16 mandatory gates/).first()).toBeVisible();
  await expect(page.getByText(/automatic broader discovery pass/)).toBeVisible();
  await page.getByRole('button', { name: 'Review this scan' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Latest scan result' });
  await expect(dialog.getByText('Mandatory gates (16)')).toBeVisible();
  await expect(dialog.getByText('Assessment discards (24)')).toBeVisible();
  await expect(dialog.locator('.scan-review-item')).toHaveCount(40);
  await expect(page.locator('.card[data-id]')).toHaveCount(0);
});

test('manual scan status and approximate remaining time stay visible on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await page.evaluate(() => window.Scout.showOperation({
    id: 'scan-eta', type: 'scan', status: 'running', phase: 'Scoring candidates',
    progress: { current: 3, total: 5 }, startedAt: new Date(Date.now() - 120000).toISOString(),
    estimate: { basis: 'history', sampleSize: 3, totalSecondsLow: 360, totalSecondsHigh: 540 },
  }));
  await expect(page.locator('#scan-status')).toBeVisible();
  await expect(page.locator('#scan-status')).toContainText(/about 4–7 min remaining/i);
});
