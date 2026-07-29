import { expect, test } from '@playwright/test';
import fs from 'node:fs';

const currentVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const establishedStatus = {
  bootstrap: false,
  established: true,
  ready: true,
  setupComplete: true,
  trackerExists: true,
  workspaceRoot: 'SYNTHETIC_WORKSPACE',
  appRoot: 'SYNTHETIC_APP',
  appVersion: currentVersion,
  config: {
    locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London',
    profile: { displayName: 'Example Person', tone: 'natural and direct' },
    search: {
      roleFamilies: ['Product engineer'], sectors: ['Climate technology'],
      locations: ['Example City'], exclusions: ['Extensive travel'], salaryMinimum: 70000,
    },
    commute: { origin: 'Example City', mode: 'either', maxMinutes: 60, includeUnknown: true },
    ai: { provider: 'codex', model: null, models: { codex: null, claude: null } },
  },
  providers: {
    codex: { installed: true, authenticated: true, capabilities: { structuredOutput: true } },
    claude: { installed: true, authenticated: true, capabilities: { structuredOutput: true } },
  },
  adzunaConfigured: false,
  scanHealth: { healthy: true, lastRunAt: '2026-07-20T08:00:00.000Z' },
  schedule: { enabled: false, configured: false, runs: [] },
  device: { updates: { policy: 'notify' }, startupStatus: { supported: false }, startWithWindows: false },
  git: { installed: true },
  sync: { state: 'disabled', enabled: false },
  remoteAccess: { state: 'disabled', enabled: false, installed: false },
  requestAccess: 'local',
  pendingSetupSections: [],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(establishedStatus),
    });
  });
  await page.route('**/api/setup/proposal', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ proposal: null }) });
  });
  await page.route('**/api/operations?type=*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation: null }) });
  });
  await page.route('**/api/provider-login/status?*', async (route) => {
    const provider = new URL(route.request().url()).searchParams.get('provider');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ provider, session: null, csrfToken: `csrf-${provider}-synthetic-000000000000` }),
    });
  });
  await page.goto('/');
  await expect(page.locator('#sync-status')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(
    window.ScoutSetup?.status?.established && window.ScoutSetup?.view === 'closed',
  ))).toBe(true);
});

test('remote owner setup does not request the host-only recovery key', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...establishedStatus,
        requestAccess: 'remote-owner',
        sync: { state: 'synced', enabled: true },
        remoteAccess: { state: 'enabled', enabled: true, installed: true },
      }),
    });
  });
  let recoveryKeyRequests = 0;
  await page.route('**/api/sync/recovery-key', async (route) => {
    recoveryKeyRequests += 1;
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'this setting can only be changed on the Scout host' }),
    });
  });

  await page.evaluate(() => window.ScoutSetup.refreshStatus());

  await expect.poll(() => recoveryKeyRequests).toBe(0);
  await expect.poll(() => page.evaluate(() => window.ScoutSetup.status?.requestAccess)).toBe('remote-owner');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('first service worker installation does not pretend Scout has updated', async ({ page }) => {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  await expect(page.locator('#ui-update-banner')).toBeHidden();
});

test('a verified update download presents a safe package name and actionable location alias', async ({ page }) => {
  const packageName = 'Scout-0.1.0-beta.23-windows-x64.exe';
  const locationHint = `%LOCALAPPDATA%\\Scout\\updates\\${packageName}`;
  await page.route('**/api/update/download', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        downloaded: {
          name: packageName,
          sha256: 'a'.repeat(64),
          version: '0.1.0-beta.23',
          verifiedAt: '2026-07-29T10:00:00.000Z',
          locationHint,
        },
      }),
    });
  });
  await page.evaluate(() => window.Scout.renderUpdateBanner({
    available: true,
    latestVersion: '0.1.0-beta.23',
    canDownload: true,
    package: { name: 'Scout-0.1.0-beta.23-windows-x64.exe' },
  }));

  const banner = page.locator('#update-banner');
  await banner.getByRole('button', { name: 'Download verified update' }).click();
  await expect(banner).toContainText(packageName);
  await expect(banner).toContainText(locationHint);
  await expect(banner).not.toContainText('undefined');
  await expect(banner).not.toContainText('/Users/');
});

test('a stale tracker mutation refreshes its revision and retries exactly once', async ({ page }) => {
  let revision = 'revision-before-scan';
  const revisionsSent = [];
  await page.route('**/api/opportunities', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, trackerRevision: revision } });
  });
  await page.route('**/api/applied', async (route) => {
    revisionsSent.push(route.request().postDataJSON().trackerRevision);
    if (revisionsSent.length === 1) {
      revision = 'revision-after-scan';
      await route.fulfill({
        status: 409, contentType: 'application/json',
        body: JSON.stringify({ conflict: true, error: 'The tracker changed' }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.reload();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.Scout.state.data?.trackerRevision)).toBe('revision-before-scan');
  await page.evaluate(() => window.Scout.post('/api/applied', { id: 'new-systems-product-2026-07', note: '' }));
  expect(revisionsSent).toEqual(['revision-before-scan', 'revision-after-scan']);
});

test('backup status opens dedicated details and advanced backup settings', async ({ page }) => {
  const sync = page.locator('#sync-status');
  await sync.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Backup details' })).toBeVisible();
  await expect(dialog.getByText('Review or retune Scout')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Advanced backup settings' }).click();
  await expect(dialog.getByRole('heading', { name: 'Backup' })).toBeVisible();
  await expect(dialog.getByText('Private backup: Not set up (optional)')).toBeVisible();
  await expect(dialog.getByText(/Viewing this guide does not enable backup/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Back to settings' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).toBeHidden();
  await expect(sync).toBeFocused();
});

test('safe backup divergence requires confirmation and submits only the analysis token', async ({ page }) => {
  const analysisToken = 'a'.repeat(64);
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ...establishedStatus,
      sync: {
        state: 'needs-attention',
        enabled: true,
        conflict: true,
        ahead: 2,
        behind: 1,
        resolution: {
          classification: 'disjoint-safe',
          canResolve: true,
          analysisToken,
          localAreas: ['opportunity tracker'],
          remoteAreas: ['reports'],
        },
      },
    }),
  }));
  let submitted;
  await page.route('**/api/sync/resolve', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ state: 'synced', resolved: true, recoveryRefsCreated: true }),
    });
  });
  await page.reload();
  await page.locator('#sync-status').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Advanced backup settings' }).click();
  await expect(dialog.getByText(/Scout host and GitHub both have new backup history/)).toBeVisible();
  await expect(dialog.getByText(/opportunity tracker/)).toBeVisible();
  await expect(dialog.getByText(/reports/)).toBeVisible();
  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: 'Preserve both and sync' }).click();
  await expect.poll(() => submitted).toEqual({ analysisToken, confirmed: true });
  expect(JSON.stringify(submitted)).not.toMatch(/opportunit|reports|refs\/|workspace/i);
});

test('scan settings offer only the selected provider until verification is requested', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Scans & schedule' }).click();
  await expect(dialog.getByText('Codex scan time')).toBeVisible();
  await expect(dialog.getByText('Claude verification pass time')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Add verification pass' }).click();
  await expect(dialog.getByText('Claude verification pass time')).toBeVisible();
});

test('AI and scan settings save independent provider model choices', async ({ page }) => {
  let aiRequest;
  await page.route('**/api/setup/config', async (route) => {
    aiRequest = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        config: { ...establishedStatus.config, ai: aiRequest.ai },
      }),
    });
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'AI providers' }).click();
  await expect(dialog.getByRole('heading', { name: 'AI providers' })).toBeFocused();
  await dialog.locator('#setup-chat-model-codex').fill('gpt-job');
  await expect(dialog.locator('#setup-chat-model-codex')).toHaveValue('gpt-job');
  await dialog.locator('#setup-chat-model-claude').fill('claude-job');
  await expect(dialog.locator('#setup-chat-model-claude')).toHaveValue('claude-job');
  await dialog.getByRole('button', { name: 'Save AI settings' }).click();
  await expect.poll(() => aiRequest).toBeTruthy();
  expect(aiRequest).toEqual({
    ai: { provider: 'codex', model: null, models: { codex: 'gpt-job', claude: 'claude-job' } },
  });

  let scheduleRequest;
  await page.route('**/api/schedule', async (route) => {
    scheduleRequest = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await dialog.getByRole('button', { name: 'Back to settings' }).click();
  await dialog.getByRole('button', { name: 'Scans & schedule' }).click();
  await dialog.locator('[data-schedule-row="codex-primary"] [data-schedule-model]').fill('gpt-scan');
  // Alternating splits the week so the two providers never scan on the same day.
  await dialog.locator('[data-schedule-row="codex-primary"] [data-schedule-preset]').selectOption('alternating');
  await dialog.getByRole('button', { name: 'Enable codex scan' }).click();
  await expect.poll(() => scheduleRequest).toBeTruthy();
  expect(scheduleRequest).toMatchObject({
    action: 'install', id: 'codex-primary', provider: 'codex', mode: 'primary', model: 'gpt-scan',
    days: [0, 1, 3, 5],
  });
});

test('proposal and scan operations show reviewable progress and strict zero-keeper results', async ({ page }) => {
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.evaluate((status) => {
    const setup = window.ScoutSetup;
    Object.values(setup.operationTimers || {}).forEach((timer) => clearTimeout(timer));
    setup.operationTimers = {};
    setup.status = { ...status, established: false, ready: false, setupComplete: false, recovery: { available: false } };
    setup.proposal = null;
    setup.view = 'onboarding';
    setup.step = 5;
    setup.operations.proposal = {
      id: 'proposal-synthetic', type: 'proposal', status: 'running', phase: 'Generating proposal with codex',
      progress: { current: 2, total: 4 }, startedAt: new Date(Date.now() - 65000).toISOString(),
    };
    document.getElementById('setup-overlay').classList.remove('hidden');
    setup.render();
  }, establishedStatus);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Generating proposal with codex')).toBeVisible();
  await expect(dialog.getByText(/Step 2 of 4/)).toBeVisible();
  await expect(dialog.getByText(/Quitting Scout interrupts local work/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Continue in background' })).toBeVisible();

  await page.evaluate(() => {
    const setup = window.ScoutSetup;
    setup.operations.proposal = {
      ...setup.operations.proposal, status: 'succeeded', phase: 'Proposal ready to review',
      progress: { current: 4, total: 4 }, finishedAt: new Date().toISOString(),
    };
    setup.proposal = {
      proposalId: 'proposal-synthetic', summary: 'Synthetic reviewed proposal', unresolvedQuestions: [],
      files: ['workspace.json', 'profile/context.md', 'profile/calibration.md', 'cv/master-cv.md', 'data/search-categories.json']
        .map((path) => ({ path, staged: `Synthetic staged content for ${path}` })),
    };
    setup.render();
  });
  const activate = dialog.getByRole('button', { name: 'Approve and activate' });
  await expect(dialog.getByRole('heading', { name: 'cv/master-cv.md' })).toBeVisible();
  await expect(activate).toBeDisabled();
  await dialog.getByLabel('I reviewed all five staged files').check();
  await expect(activate).toBeEnabled();

  await page.evaluate((status) => {
    const setup = window.ScoutSetup;
    setup.status = {
      ...status, established: false, ready: true, setupComplete: false,
      scanHealth: {
        healthy: true, lastRunAt: '2026-07-21T20:00:00.000Z', candidatesFound: 40, keepersAdded: 0,
        discarded: { mandatory_unmet: 19, provider_discarded: 21 },
      },
    };
    setup.step = 6;
    setup.operations.scan = {
      id: 'scan-synthetic', type: 'scan', status: 'running', phase: 'Scoring 40 candidates',
      progress: { current: 3, total: 5 }, startedAt: new Date(Date.now() - 125000).toISOString(),
    };
    setup.render();
  }, establishedStatus);
  await expect(dialog.getByText('40 reviewed, 0 kept')).toBeVisible();
  await expect(dialog.getByText(/19 mandatory gates/)).toBeVisible();
  await expect(dialog.getByText(/21 assessment discards/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Finish setup — scan continues' })).toBeVisible();
  await expect(dialog.getByText('Codex scan time')).toBeVisible();
  await expect(dialog.getByText('Claude verification pass time')).toHaveCount(0);
});

test('refresh reattaches setup to a running proposal operation', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ...establishedStatus, established: false, ready: false, setupComplete: false }),
  }));
  await page.unroute('**/api/operations?type=*');
  await page.route('**/api/operations?type=proposal', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ operation: {
      id: 'proposal-reattach', type: 'proposal', status: 'running', phase: 'Validating and staging proposal',
      progress: { current: 3, total: 4 }, startedAt: '2026-07-21T20:00:00.000Z',
    } }),
  }));
  await page.route('**/api/operations?type=scan', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ operation: null }),
  }));
  await page.reload();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Generate your evidence-led CV and search proposal' })).toBeVisible();
  await expect(dialog.getByText('Validating and staging proposal')).toBeVisible();
  await expect(dialog.getByText(/Step 3 of 4/)).toBeVisible();
});

test('settings opens a hub and retuning is explicit and dismissible', async ({ page }) => {
  const settings = page.getByRole('button', { name: 'Settings' });
  await settings.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Scout settings' })).toBeVisible();
  await expect(dialog.locator('.settings-card')).toHaveCount(7);
  await expect(dialog.getByText('Review settings')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Search & profile' }).click();
  await expect(dialog.getByRole('heading', { name: 'Search & profile' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Retune my search' }).click();
  await expect(dialog.getByRole('heading', { name: 'Retune Scout' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Retune Scout' })).toBeFocused();
  // Retuning the search must open the search questions, not the AI provider step.
  await expect(dialog.getByRole('heading', { name: 'First, what should I call you?' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
});

test('settings traps focus, makes the dashboard inert, and restores its opener', async ({ page }) => {
  const settings = page.getByRole('button', { name: 'Settings' });
  await settings.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.settings-card')).toHaveCount(7);
  await expect(dialog.getByRole('heading', { name: 'Scout settings' })).toBeFocused();
  await expect.poll(() => page.locator('main').evaluate((element) => element.inert)).toBe(true);

  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'App & device' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
  await expect.poll(() => page.locator('main').evaluate((element) => element.inert)).toBe(false);
});

test('a setup-adjacent drawer becomes the active modal layer then returns focus to setup', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings' }).click();
  const setupDialog = page.locator('#setup-overlay');
  await expect(setupDialog.locator('#setup-title')).toBeFocused();

  await page.evaluate(() => {
    const drawer = document.getElementById('chat-drawer');
    drawer.innerHTML = '<div class="chat-head"><button class="act" data-action="close-chat">close</button></div><textarea aria-label="Synthetic chat"></textarea>';
    drawer.classList.remove('hidden');
  });
  const chatDialog = page.getByRole('dialog', { name: 'Scout job conversation' });
  await expect(chatDialog.getByRole('button', { name: 'close' })).toBeFocused();
  await expect.poll(() => setupDialog.evaluate((element) => element.inert)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(chatDialog).toBeHidden();
  await expect.poll(() => setupDialog.evaluate((element) => element.inert)).toBe(false);
  await expect(setupDialog.locator('#setup-title')).toBeFocused();
});

test('a slow initial setup response cannot replace an explicit Settings view', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  let releaseInitial;
  let statusRequests = 0;
  await page.route('**/api/setup/status', async (route) => {
    statusRequests += 1;
    if (statusRequests === 1) {
      await new Promise((resolve) => { releaseInitial = resolve; });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...establishedStatus,
          pendingSetupSections: [{ id: 'start-with-windows', title: 'Start with Windows' }],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(establishedStatus),
    });
  });

  await page.reload();
  await expect.poll(() => Boolean(releaseInitial)).toBe(true);
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.settings-card')).toHaveCount(7);

  releaseInitial();
  await expect.poll(() => statusRequests).toBe(2);
  await page.waitForTimeout(100);
  await expect(dialog.locator('.settings-card')).toHaveCount(7);
  await expect(dialog.getByRole('heading', { name: 'Scout setup update' })).toHaveCount(0);
});

test('setup retry recovers in place without losing an unsaved onboarding answer', async ({ page }) => {
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.unroute('**/api/setup/status');
  let statusAvailable = false;
  await page.route('**/api/setup/status', async (route) => {
    if (!statusAvailable) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Scout is restarting' }) });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(establishedStatus) });
  });

  await page.evaluate(async (status) => {
    const setup = window.ScoutSetup;
    setup.status = status;
    setup.view = 'retune';
    setup.step = 2;
    setup.preferenceStep = 1;
    setup.preferenceDraft = null;
    document.getElementById('setup-overlay').classList.remove('hidden');
    setup.render();
    setup.el('setup-roles').value = 'Product engineer, Systems lead';
    await setup.refreshStatus({ keepOpen: true });
  }, establishedStatus);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Scout setup could not be loaded' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();

  statusAvailable = true;
  await dialog.getByRole('button', { name: 'Retry' }).click();
  await expect(dialog.getByRole('heading', { name: 'What kind of work should I look for?' })).toBeVisible();
  await expect(dialog.locator('#setup-roles')).toHaveValue('Product engineer, Systems lead');
  await expect(dialog.getByRole('button', { name: 'Answer' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Answer' }).click();
  await expect(dialog.getByRole('heading', { name: 'Where can the right role be?' })).toBeVisible();
});

test('remote restart asks explicitly and does not interrupt active work', async ({ page }) => {
  let restartRequests = 0;
  await page.route('**/api/restart', async (route) => {
    restartRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, restarting: true }) });
  });
  await page.evaluate(() => { window.ScoutSetup.status.requestAccess = 'remote-owner'; });
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('Remote access will disconnect briefly');
    await dialog.dismiss();
  });
  await page.evaluate(() => window.ScoutSetup.restartServer());
  expect(restartRequests).toBe(0);

  const restartWarning = await page.evaluate(async () => {
    window.ScoutSetup.operations.proposal = { id: 'active-proposal', status: 'running', phase: 'Saving work' };
    await window.ScoutSetup.restartServer();
    return document.getElementById('setup-status').textContent;
  });
  expect(restartWarning).toBe('Wait for the current Scout operation to finish before restarting.');
  expect(restartRequests).toBe(0);
});

test('settings is a single usable scroll surface on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  const close = page.getByRole('button', { name: 'Close settings' });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.y).toBeGreaterThanOrEqual(0);

  await expect(dialog.locator('#setup-actions')).toBeHidden();
  const geometry = await dialog.evaluate((element) => {
    const shell = element.querySelector('.setup-dialog');
    const body = element.querySelector('.setup-body');
    return {
      shellHeight: shell.clientHeight,
      shellScrollHeight: shell.scrollHeight,
      shellOverflow: getComputedStyle(shell).overflowY,
      bodyHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      bodyOverflow: getComputedStyle(body).overflowY,
    };
  });
  expect(geometry.shellHeight).toBeLessThanOrEqual(740);
  expect(geometry.shellScrollHeight).toBe(geometry.shellHeight);
  expect(geometry.shellOverflow).toBe('hidden');
  expect(geometry.bodyScrollHeight).toBeGreaterThan(geometry.bodyHeight);
  expect(geometry.bodyOverflow).toBe('auto');

  const appDevice = dialog.getByRole('button', { name: 'App & device' });
  await appDevice.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  await expect(appDevice).toBeVisible();
  const appBox = await appDevice.boundingBox();
  expect(appBox.y).toBeGreaterThanOrEqual(0);
  expect(appBox.y + appBox.height).toBeLessThanOrEqual(740);
});

test('guided provider login supports code, failure, retry and cancel without browser persistence', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...establishedStatus,
        providers: {
          ...establishedStatus.providers,
          claude: { installed: true, authenticated: false, capabilities: { structuredOutput: true } },
        },
      }),
    });
  });
  await page.unroute('**/api/provider-login/status?*');
  let session = null;
  let startCount = 0;
  let retryCount = 0;
  let statusRequests = 0;
  const requests = [];
  const snapshot = (state, fields = {}) => ({
    codeRequired: state === 'awaiting-code',
    createdAt: '2026-07-29T10:00:00.000Z',
    expiresAt: '2026-07-29T10:10:00.000Z',
    provider: 'claude',
    reasonCode: state === 'failed' ? 'validation-failed' : null,
    sessionId: '00000000-0000-4000-8000-000000000002',
    state,
    userCode: null,
    verificationUrl: null,
    ...fields,
  });
  await page.route('**/api/provider-login/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const action = url.pathname.split('/').at(-1);
    if (action === 'status') {
      statusRequests += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'claude', session, csrfToken: 'csrf-claude-synthetic-000000000000',
        }),
      });
      return;
    }
    requests.push({
      action,
      csrf: request.headers()['x-scout-provider-login-csrf'],
      body: request.postDataJSON(),
    });
    if (action === 'start') session = snapshot(++startCount === 1 ? 'awaiting-code' : 'succeeded');
    if (action === 'code') session = snapshot('failed');
    if (action === 'retry') session = snapshot(++retryCount === 1 ? 'starting' : 'succeeded');
    if (action === 'cancel') session = snapshot('failed', {
      reasonCode: 'credentials-expired',
    });
    if (action === 'clear-claude-credentials') {
      session = null;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ result: { provider: 'claude', reasonCode: null, state: 'cleared' } }),
      });
      return;
    }
    await route.fulfill({
      status: action === 'start' || action === 'retry' ? 202 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ session }),
    });
  });

  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'AI providers' }).click();
  await dialog.getByRole('button', { name: 'Sign in to Claude with Scout' }).click();
  const codeInput = dialog.getByLabel('One-time provider code');
  await expect(codeInput).toBeVisible();
  await codeInput.fill('PRIVATE-CODE');
  const statusBeforeTyping = statusRequests;
  await expect.poll(() => statusRequests).toBeGreaterThan(statusBeforeTyping);
  await expect(codeInput).toHaveValue('PRIVATE-CODE');
  await dialog.getByRole('button', { name: 'Submit code' }).click();
  await expect(dialog.getByRole('button', { name: 'Retry Claude sign-in' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Clear expired Claude sign-in' })).toHaveCount(0);
  await expect(dialog).toContainText('claude auth login');
  await expect(dialog).not.toContainText('validation-failed');

  await dialog.getByRole('button', { name: 'Retry Claude sign-in' }).click();
  await expect(dialog.getByRole('button', { name: 'Cancel Claude sign-in' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel Claude sign-in' }).click();
  await expect(dialog.getByRole('button', { name: 'Retry Claude sign-in' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Clear expired Claude sign-in' })).toBeVisible();
  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: 'Clear expired Claude sign-in' }).click();
  await dialog.getByRole('button', { name: 'Sign in to Claude with Scout' }).click();
  await expect(dialog).toContainText('Sign-in succeeded');

  expect(requests.map(({ action }) => action)).toEqual([
    'start', 'code', 'retry', 'cancel', 'clear-claude-credentials', 'start',
  ]);
  for (const request of requests) {
    expect(request.csrf).toBe('csrf-claude-synthetic-000000000000');
  }
  expect(requests.find(({ action }) => action === 'clear-claude-credentials').body)
    .toEqual({
      confirmed: true,
      sessionId: '00000000-0000-4000-8000-000000000002',
    });
  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  expect(JSON.stringify(stored)).not.toContain('PRIVATE-CODE');
});

test('guided login preserves failed logout state and reports no false success', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ...establishedStatus,
      providers: {
        ...establishedStatus.providers,
        claude: {
          installed: true,
          authenticated: false,
          capabilities: { structuredOutput: true },
        },
      },
    }),
  }));
  let session = {
    codeRequired: false,
    createdAt: '2026-07-29T10:00:00.000Z',
    expiresAt: '2026-07-29T10:10:00.000Z',
    provider: 'claude',
    reasonCode: 'credentials-expired',
    sessionId: '00000000-0000-4000-8000-000000000003',
    state: 'failed',
    userCode: null,
    verificationUrl: null,
  };
  await page.route('**/api/provider-login/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'status') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'claude',
          session,
          csrfToken: 'csrf-claude-synthetic-000000000000',
        }),
      });
    }
    session = { ...session, reasonCode: 'logout-failed' };
    return route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({
        result: { provider: 'claude', reasonCode: 'logout-failed', state: 'failed' },
      }),
    });
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'AI providers' }).click();
  page.once('dialog', (confirmation) => confirmation.accept());
  await dialog.getByRole('button', { name: 'Clear expired Claude sign-in' }).click();
  await expect(dialog.getByRole('button', { name: 'Retry Claude sign-in' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Sign in to Claude with Scout' })).toHaveCount(0);
  await expect(page.locator('#setup-status')).not.toContainText('sign-in cleared');
});

test('guided login ignores stale polls and suppresses duplicate mutations', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ...establishedStatus,
      providers: {
        ...establishedStatus.providers,
        claude: {
          installed: true,
          authenticated: false,
          capabilities: { structuredOutput: true },
        },
      },
    }),
  }));
  let claudeStatusCount = 0;
  let releaseStaleStatus;
  const staleStatus = new Promise((resolve) => { releaseStaleStatus = resolve; });
  let starts = 0;
  const active = {
    codeRequired: false,
    createdAt: '2026-07-29T10:00:00.000Z',
    expiresAt: '2026-07-29T10:10:00.000Z',
    provider: 'claude',
    reasonCode: null,
    sessionId: '00000000-0000-4000-8000-000000000004',
    state: 'starting',
    userCode: null,
    verificationUrl: null,
  };
  await page.route('**/api/provider-login/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const action = url.pathname.split('/').at(-1);
    if (action === 'status') {
      const provider = url.searchParams.get('provider');
      if (provider === 'claude') {
        claudeStatusCount += 1;
        if (claudeStatusCount === 2) await staleStatus;
      }
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider,
          session: null,
          csrfToken: `csrf-${provider}-synthetic-000000000000`,
        }),
      });
    }
    if (action === 'start') starts += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ session: active }),
    });
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'AI providers' }).click();
  await page.evaluate(() => { void window.ScoutSetup.refreshProviderLogin('claude'); });
  const start = dialog.getByRole('button', { name: 'Sign in to Claude with Scout' });
  await start.evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(dialog.getByRole('button', { name: 'Cancel Claude sign-in' })).toBeVisible();
  releaseStaleStatus();
  await expect.poll(() => claudeStatusCount).toBeGreaterThanOrEqual(2);
  await expect(dialog.getByRole('button', { name: 'Cancel Claude sign-in' })).toBeVisible();
  expect(starts).toBe(1);
});

test('phone All view reaches its rightmost column and keeps strong-match controls on screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.getByRole('button', { name: 'Archive' }).click();
  const tableRegion = page.getByRole('region', { name: 'All opportunities table' });
  await expect(tableRegion).toBeVisible();
  const scroll = await tableRegion.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    const region = element.getBoundingClientRect();
    const last = element.querySelector('th:last-child').getBoundingClientRect();
    return { left: element.scrollLeft, regionRight: region.right, lastLeft: last.left, lastRight: last.right };
  });
  expect(scroll.left).toBeGreaterThan(0);
  expect(scroll.lastLeft).toBeLessThan(scroll.regionRight);
  expect(scroll.lastRight).toBeLessThanOrEqual(scroll.regionRight + 1);

  await page.evaluate(() => {
    window.Scout.discoveries = [window.Scout.state.data.opportunities[0]];
    window.Scout.showStrongMatchArrival();
  });
  const arrival = page.locator('#scout-arrival');
  await expect(arrival.getByRole('button', { name: 'Show me' })).toBeVisible();
  const arrivalBox = await arrival.boundingBox();
  expect(arrivalBox.x).toBeGreaterThanOrEqual(0);
  expect(arrivalBox.x + arrivalBox.width).toBeLessThanOrEqual(360);
  expect(arrivalBox.y + arrivalBox.height).toBeLessThanOrEqual(740);
  for (const button of await arrival.getByRole('button').all()) {
    const buttonBox = await button.boundingBox();
    expect(buttonBox.x).toBeGreaterThanOrEqual(0);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(360);
  }
});

test('All filter preserves start, middle, end, and composition editing', async ({ page }) => {
  await page.getByRole('button', { name: 'Archive' }).click();
  const filter = page.locator('#filter');
  await filter.fill('Legacy');
  await page.evaluate(() => { window.filterIdentity = document.getElementById('filter'); });
  for (const sample of [
    { start: 0, text: 'X', expected: 'XLegacy', caret: 1 },
    { start: 3, text: 'X', expected: 'LegXacy', caret: 4 },
    { start: 6, text: 'X', expected: 'LegacyX', caret: 7 },
  ]) {
    await filter.fill('Legacy');
    const result = await page.evaluate(({ start, text }) => {
      const input = document.getElementById('filter');
      input.setRangeText(text, start, start, 'end');
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return {
        same: input === document.getElementById('filter') && input === window.filterIdentity,
        value: input.value, start: input.selectionStart, end: input.selectionEnd,
      };
    }, sample);
    expect(result).toEqual({ same: true, value: sample.expected, start: sample.caret, end: sample.caret });
  }

  const composition = await page.evaluate(() => {
    const input = document.getElementById('filter');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    input.value = '気候';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '気候', isComposing: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '気候' }));
    return { same: input === document.getElementById('filter'), value: input.value, caret: input.selectionStart };
  });
  expect(composition).toEqual({ same: true, value: '気候', caret: 2 });
});

test('mandatory first-run setup cannot be dismissed', async ({ page }) => {
  await page.unroute('**/api/setup/status');
  await page.route('**/api/setup/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bootstrap: true,
        workspaceRoot: 'SYNTHETIC_WORKSPACE',
        appRoot: 'SYNTHETIC_APP',
        appVersion: currentVersion,
        git: { installed: true },
        sync: { state: 'disabled', enabled: false },
        pendingSetupSections: [],
      }),
    });
  });
  await page.reload();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Welcome to Scout' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close settings' })).toBeHidden();
  await expect(dialog.getByRole('heading', { name: 'Welcome to Scout' })).toBeFocused();
  await expect.poll(() => page.locator('main').evaluate((element) => element.inert)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
});

test('a service-worker or build upgrade waits for CV edits, operations, and settings', async ({ page }) => {
  await page.route('**/api/app-info', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ name: 'Scout', version: currentVersion, uiBuildId: 'newer-build' }),
    });
  });
  const operationsReattached = page.waitForResponse((response) => response.url().includes('/api/operations?type=scan'));
  await page.reload();
  await operationsReattached;

  const banner = page.locator('#ui-update-banner');
  await expect(page.locator('#setup-overlay')).toHaveClass(/hidden/);
  await expect.poll(() => banner.evaluate((element) => element.inert)).toBe(false);
  await expect(banner).toContainText('Scout has updated');
  const cvBlocker = await page.evaluate(() => {
    window.Scout.cvState.dirty = true;
    window.ScoutSetup.operations.proposal = { id: 'upgrade-proposal', type: 'proposal', status: 'running', phase: 'Writing staged files' };
    return window.Scout.uiReloadBlocker();
  });
  expect(cvBlocker).toBe('Save or discard the open CV changes first.');

  const operationBlocker = await page.evaluate(() => {
    window.Scout.cvState.dirty = false;
    window.ScoutSetup.operations.proposal = { id: 'upgrade-proposal', type: 'proposal', status: 'running', phase: 'Writing staged files' };
    return window.Scout.uiReloadBlocker();
  });
  expect(operationBlocker).toBe('Wait for the current Scout operation to finish first.');

  await page.evaluate(() => {
    window.ScoutSetup.operations.proposal = { id: 'upgrade-proposal', type: 'proposal', status: 'succeeded', phase: 'Complete' };
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => banner.evaluate((element) => element.inert)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.Scout.uiReloadBlocker())).toBe('Close or finish the open Scout settings first.');
  await page.getByRole('button', { name: 'Close settings' }).click();

  await Promise.all([
    page.waitForNavigation(),
    banner.getByRole('button', { name: 'Refresh Scout' }).click({ force: true }),
  ]);
});
