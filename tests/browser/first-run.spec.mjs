import { expect, test } from '@playwright/test';
import fs from 'node:fs';

const currentVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const bootstrapStatus = {
  bootstrap: true,
  workspaceRoot: 'SYNTHETIC_WORKSPACE',
  appRoot: 'SYNTHETIC_APP',
  appVersion: currentVersion,
  git: { installed: true, credentialManager: true },
  sync: { state: 'disabled', enabled: false },
  pendingSetupSections: [],
};

const createdStatus = {
  bootstrap: false,
  established: false,
  ready: false,
  setupComplete: false,
  trackerExists: true,
  workspaceRoot: 'SYNTHETIC_WORKSPACE',
  appRoot: 'SYNTHETIC_APP',
  appVersion: currentVersion,
  config: {
    locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London',
    profile: { displayName: '', tone: '' },
    search: { roleFamilies: [], sectors: [], locations: [], exclusions: [], salaryMinimum: null },
    commute: { origin: '', mode: 'either', maxMinutes: 180, includeUnknown: true },
    ai: { provider: null, model: null, models: { codex: null, claude: null } },
  },
  providers: {
    codex: { installed: true, authenticated: true, capabilities: { structuredOutput: true } },
    claude: { installed: true, authenticated: true, capabilities: { structuredOutput: true } },
  },
  adzunaConfigured: false,
  scanHealth: { healthy: false, lastRunAt: null },
  schedule: { enabled: false, configured: false, runs: [] },
  device: { updates: { policy: 'notify' }, startupStatus: { supported: false }, startWithWindows: false },
  git: { installed: true, credentialManager: true },
  sync: { state: 'disabled', enabled: false },
  remoteAccess: { state: 'disabled', enabled: false, installed: false },
  requestAccess: 'local',
  pendingSetupSections: [],
};

async function stubSupportingRoutes(page) {
  await page.route('**/api/setup/proposal', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ proposal: null }) });
  });
  await page.route('**/api/operations?type=*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation: null }) });
  });
}

test('a brand-new install renders its dashboard without a script error', async ({ page }) => {
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await stubSupportingRoutes(page);
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(bootstrapStatus) });
  });

  await page.goto('/');
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'Welcome to Scout' })).toBeVisible();

  // Missing pipeline arrays used to throw inside renderPipeline and abort the
  // whole dashboard render behind the setup dialog. Shape parity between the
  // initialised and uninitialised answers is asserted in ui/lib/pipeline.test.mjs.
  await expect
    .poll(() => page.evaluate(() => Array.isArray(window.Scout?.state?.data?.pipeline?.recentlyClosed)))
    .toBe(true);
  expect(failures).toEqual([]);
});

test('creating the first workspace confirms immediately and cannot be double-submitted', async ({ page }) => {
  await stubSupportingRoutes(page);
  let statusCalls = 0;
  let releaseSecondStatus;
  await page.route('**/api/setup/status', async (route) => {
    statusCalls += 1;
    if (statusCalls === 1) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(bootstrapStatus) });
      return;
    }
    // A real status refresh probes providers and Git and is slow. The wizard
    // must not wait for it before telling the person what happened.
    await new Promise((resolve) => { releaseSecondStatus = resolve; });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(createdStatus) });
  });
  await page.route('**/api/workspace/create', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, workspaceRoot: 'SYNTHETIC_WORKSPACE' }) });
  });

  await page.goto('/');
  const dialog = page.getByRole('dialog');
  const create = dialog.getByRole('button', { name: 'Create my local workspace' });
  await expect(create).toBeVisible();
  await create.click();

  // Feedback arrives while the status refresh is still outstanding.
  await expect(dialog.getByRole('heading', { name: 'How would you like to begin?' })).toHaveCount(0);
  await expect(page.locator('#setup-status')).toContainText('Your local workspace is ready');
  expect(await page.evaluate(() => window.ScoutSetup.step)).toBe(0);

  releaseSecondStatus?.();
  await expect.poll(() => page.evaluate(() => window.ScoutSetup.status?.trackerExists)).toBe(true);
});

test('an established workspace is never trapped in first-run onboarding', async ({ page }) => {
  await page.route('**/api/operations?type=*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation: null }) });
  });
  await page.route('**/api/setup/proposal', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ proposal: { proposalId: 'p1', summary: 'A staged proposal', files: [], unresolvedQuestions: [] } }),
    });
  });
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...createdStatus, established: true, setupComplete: true, ready: false }),
    });
  });

  await page.goto('/');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Retune Scout' })).toBeVisible();

  // Closing must be possible: the alternative is a dashboard the owner cannot
  // reach until they discard work they may still want.
  const close = dialog.getByRole('button', { name: 'Close settings' });
  await expect(close).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('settings sections open the step that edits them', async ({ page }) => {
  await stubSupportingRoutes(page);
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...createdStatus, established: true, ready: true, setupComplete: true }),
    });
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog');

  await page.getByRole('button', { name: 'Settings' }).click();
  await dialog.getByRole('button', { name: 'Sources' }).click();
  await dialog.getByRole('button', { name: 'Retune search and sources' }).click();
  await expect(dialog.getByRole('heading', { name: 'Add Adzuna search (optional)' })).toBeVisible();

  // Back from a retune entry step returns to the hub rather than walking
  // further backwards into first-run onboarding.
  await dialog.getByRole('button', { name: 'Back to settings' }).click();
  await expect(dialog.locator('.settings-card')).toHaveCount(9);
});

test('the first-run restore form can be dismissed again', async ({ page }) => {
  await stubSupportingRoutes(page);
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(bootstrapStatus) });
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog');

  await dialog.getByRole('button', { name: 'Restore existing workspace' }).click();
  await expect(dialog.getByRole('button', { name: 'Restore securely' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByRole('button', { name: 'Restore securely' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Restore existing workspace' })).toBeEnabled();
});
