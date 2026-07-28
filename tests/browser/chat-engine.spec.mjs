import { expect, test } from '@playwright/test';
import fs from 'node:fs';

const currentVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

// Mocked so this spec never spawns the machine's real provider CLIs; that work
// is slow, unrelated to the picker, and its cost outlives the test.
const establishedStatus = {
  bootstrap: false, established: true, ready: true, setupComplete: true, trackerExists: true,
  workspaceRoot: 'SYNTHETIC_WORKSPACE', appRoot: 'SYNTHETIC_APP', appVersion: currentVersion,
  config: {
    locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London',
    profile: { displayName: 'Example Person' }, search: {}, commute: {},
    ai: { provider: 'claude', model: null, models: { codex: null, claude: null } },
  },
  providers: { codex: { installed: true, authenticated: true }, claude: { installed: true, authenticated: true } },
  scanHealth: { healthy: true }, schedule: { enabled: false, configured: false, runs: [] },
  device: { updates: { policy: 'notify' }, startupStatus: { supported: false } },
  git: { installed: true }, sync: { state: 'disabled', enabled: false },
  remoteAccess: { state: 'disabled', enabled: false }, requestAccess: 'local', pendingSetupSections: [],
};

const engines = {
  engines: {
    claude: {
      usage: {
        fiveHourTokens: 2_500_000,
        weekTokens: 7_000_000,
        byModel: [{ model: 'claude-opus-4-8', fiveHourTokens: 2_000_000, weekTokens: 4_000_000 }],
        approximate: true,
      },
      models: [
        { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable', detected: true },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest', detected: false },
      ],
      defaultModel: null,
    },
    codex: {
      usage: {
        windows: [{ usedPercent: 62, windowMinutes: 10080, label: 'weekly', resetsInSeconds: 3600, resetsAt: '2026-07-23T09:00:00.000Z' }],
        approximate: true,
      },
      models: [],
      defaultModel: null,
    },
  },
  checkedAt: '2026-07-22T12:00:00.000Z',
};

const opportunity = {
  id: 'example-co-role-2026-07', company: 'Example Co', role: 'Product engineer',
  score: 82, status: 'new', sources: ['https://example.test/job'], lastChecked: '2026-07-20',
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/setup/status', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(establishedStatus) }));
  await page.route('**/api/setup/proposal', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ proposal: null }) }));
  await page.route('**/api/operations?type=*', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation: null }) }));
  await page.route('**/api/usage', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ claude: { unknown: true }, codex: { unknown: true } }) }));
  await page.route('**/api/engines', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(engines) });
  });
  await page.route('**/api/chat?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ chat: null, prefills: { ask: 'Tell me about this role' }, purpose: 'job', busy: false }),
    });
  });
  // Mock the API boundary rather than reaching into Scout's in-memory state, so
  // this spec leaves nothing behind for whatever runs next.
  await page.route('**/api/opportunities', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        updated: '2026-07-20',
        opportunities: [opportunity],
        triage: { action: [], unlock: [], followups: [], other: [] },
        pipeline: {
          summary: { total: 1, byStatus: {}, new: 1, watch: 0, active: 0, awaitingDecision: 1, recentlyClosed: 0, flags: 0 },
          new: [], watch: [], active: [], awaitingDecision: [], recentlyClosed: [], flags: [],
        },
        scanHealth: { healthy: true, lastRunAt: '2026-07-20T08:00:00.000Z' },
        schedule: { enabled: false, configured: false },
        categories: [{ id: 'startup', label: 'Priority' }, { id: 'established', label: 'Explore' }],
        workspaceConfig: null,
        trackerRevision: 'r1',
      }),
    });
  });
  await page.goto('/');
  await expect(page.locator('#sync-status')).toBeVisible();
  await page.evaluate(() => window.ScoutSetup?.closeSettings?.());
});

test('the engine picker shows each provider allowance and offers models', async ({ page }) => {
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  const picker = page.locator('.chat-picker');
  await expect(picker.locator('.engine-card')).toHaveCount(2);

  // A real limit is stated as a limit; Claude spend is stated as spend.
  await expect(picker).toContainText('62% of your weekly limit used');
  await expect(picker).toContainText('account-wide; Claude does not publish a per-model limit');

  const claudeModels = picker.locator('[data-engine-model="claude"] option');
  await expect(claudeModels).toContainText(['Provider default', 'Opus 4.8 — most capable · used here', 'Haiku 4.5 — fastest', 'Other…']);

  // Codex offers no guessed identifiers — default plus free text only.
  await expect(picker.locator('[data-engine-model="codex"] option')).toHaveCount(2);

  // Leave no modal open: the drawer makes the rest of the page inert, and a test
  // that ends mid-modal bleeds that state into whatever runs next.
  await page.click('[data-action="close-chat"]');
  await expect(page.locator('#chat-drawer')).toBeHidden();
});

test('choosing a model sends it and shows it on the conversation', async ({ page }) => {
  let sent = null;
  await page.route('**/api/chat/send', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: done\ndata: {"text":"ok","updates":["ok"],"sessionId":"s1","filesTouched":[]}\n\n',
    });
  });
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await page.waitForSelector('.engine-card');

  await page.selectOption('[data-engine-model="claude"]', 'claude-opus-4-8');
  await expect(page.locator('[data-engine-card="claude"] .engine-model-spend'))
    .toContainText('spent on this model this week');
  await page.click('[data-engine-card="claude"] [data-action="pick-engine"]');

  await expect(page.locator('.chat-head .model-chip')).toHaveText('claude-opus-4-8');
  await page.fill('#chat-input', 'hello');
  await page.click('#chat-send');
  await expect.poll(() => sent?.model).toBe('claude-opus-4-8');
  expect(sent.engine).toBe('claude');
});

test('a free-text model is accepted for a provider Scout cannot enumerate', async ({ page }) => {
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await page.waitForSelector('.engine-card');

  const custom = page.locator('[data-engine-model-custom="codex"]');
  await expect(custom).toBeHidden();
  await page.selectOption('[data-engine-model="codex"]', '__other__');
  await expect(custom).toBeVisible();
  await custom.fill('gpt-5.6-sol');
  await page.click('[data-engine-card="codex"] [data-action="pick-engine"]');
  await expect(page.locator('.chat-head .model-chip')).toHaveText('gpt-5.6-sol');
});

test('the picker still works when provider usage cannot be read', async ({ page }) => {
  await page.unroute('**/api/engines');
  await page.route('**/api/engines', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ engines: { claude: { usage: { unknown: true }, models: [], defaultModel: null }, codex: { usage: { unknown: true }, models: [], defaultModel: null } } }),
    });
  });
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await page.waitForSelector('.engine-card');
  await expect(page.locator('.chat-picker')).toContainText('usage unavailable');
  await page.click('[data-engine-card="claude"] [data-action="pick-engine"]');
  await expect(page.locator('.chat-head .model-chip')).toHaveText('provider default');
});

test('usage resolving before engines remains visible after the picker renders', async ({ page }) => {
  await page.unroute('**/api/usage');
  await page.unroute('**/api/engines');
  const usageGate = deferred();
  const enginesGate = deferred();
  await page.route('**/api/usage', async (route) => {
    await usageGate.promise;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        claude: { fiveHourTokens: 2_000, weekTokens: 5_000, approximate: true },
        codex: { windows: [{ usedPercent: 42, label: 'weekly' }] },
      }),
    });
  });
  await page.route('**/api/engines', async (route) => {
    await enginesGate.promise;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(engines) });
  });

  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  usageGate.resolve();
  await expect(page.locator('#usage-meters')).toContainText('42% weekly allowance used');
  enginesGate.resolve();
  await expect(page.locator('[data-engine-model="claude"]')).toBeVisible();
  await expect(page.locator('#usage-meters')).toContainText('42% weekly allowance used');
});

test('engines resolving before usage keeps model choices visible', async ({ page }) => {
  await page.unroute('**/api/usage');
  await page.unroute('**/api/engines');
  const usageGate = deferred();
  const enginesGate = deferred();
  await page.route('**/api/usage', async (route) => {
    await usageGate.promise;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ claude: { unknown: true }, codex: { unknown: true } }),
    });
  });
  await page.route('**/api/engines', async (route) => {
    await enginesGate.promise;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(engines) });
  });

  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  enginesGate.resolve();
  await expect(page.locator('[data-engine-model="claude"]')).toContainText('Opus 4.8');
  usageGate.resolve();
  await expect(page.locator('#usage-meters')).toContainText('usage unavailable');
  await expect(page.locator('[data-engine-model="claude"]')).toContainText('Opus 4.8');
});

test('switching chats rejects late usage and engine results from the previous chat', async ({ page }) => {
  await page.unroute('**/api/usage');
  await page.unroute('**/api/engines');
  const oldUsageGate = deferred();
  const oldEnginesGate = deferred();
  let usageCalls = 0;
  let engineCalls = 0;
  await page.route('**/api/usage', async (route) => {
    usageCalls += 1;
    if (usageCalls === 1) {
      await oldUsageGate.promise;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          claude: { unknown: true },
          codex: { windows: [{ usedPercent: 99, label: 'stale-window' }] },
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        claude: { unknown: true },
        codex: { windows: [{ usedPercent: 12, label: 'current-window' }] },
      }),
    });
  });
  await page.route('**/api/engines', async (route) => {
    engineCalls += 1;
    if (engineCalls === 1) {
      await oldEnginesGate.promise;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          engines: {
            claude: { usage: { unknown: true }, models: [{ id: 'stale-only', label: 'Stale only' }], defaultModel: null },
            codex: { usage: { unknown: true }, models: [], defaultModel: null },
          },
        }),
      });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(engines) });
  });

  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await expect.poll(() => usageCalls).toBe(1);
  await expect.poll(() => engineCalls).toBe(1);
  await page.evaluate(() => window.Scout.openChat('second-synthetic-chat-2026-07', 'ask'));
  await expect(page.locator('#usage-meters')).toContainText('12% current-window allowance used');
  await expect(page.locator('[data-engine-model="claude"]')).toContainText('Opus 4.8');
  oldUsageGate.resolve();
  oldEnginesGate.resolve();
  await expect(page.locator('#usage-meters')).not.toContainText('stale-window');
  await expect(page.locator('[data-engine-model="claude"]')).not.toContainText('Stale only');
});

test('closing the drawer rejects late usage and engine results', async ({ page }) => {
  await page.unroute('**/api/usage');
  await page.unroute('**/api/engines');
  const usageGate = deferred();
  const enginesGate = deferred();
  await page.route('**/api/usage', async (route) => {
    await usageGate.promise;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ claude: { unknown: true }, codex: { unknown: true } }),
    });
  });
  await page.route('**/api/engines', async (route) => {
    await enginesGate.promise;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(engines) });
  });

  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await page.evaluate(() => window.Scout.closeChat());
  usageGate.resolve();
  enginesGate.resolve();
  await expect(page.locator('#chat-drawer')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.Scout.chat)).toBe(null);
});
