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
        { id: 'claude-opus-4-8', label: 'Opus 4.8', tradeoff: 'Most capable bundled Claude suggestion.', source: 'bundled', available: 'unknown', selected: false },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', tradeoff: 'Fastest bundled Claude suggestion.', source: 'bundled', available: 'unknown', selected: false },
      ],
      defaultModel: null,
      effectiveModel: { id: null, label: 'Provider default (model unknown)', source: null, available: 'unknown', known: false, state: 'unknown' },
      catalogue: { state: 'fallback', reasonCode: 'enumeration-unsupported', checkedAt: '2026-07-22T12:00:00.000Z' },
    },
    codex: {
      usage: {
        windows: [{ usedPercent: 62, windowMinutes: 10080, label: 'weekly', resetsInSeconds: 3600, resetsAt: '2026-07-23T09:00:00.000Z' }],
        approximate: true,
      },
      models: [
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tradeoff: 'Most capable for complex, open-ended work.', source: 'refreshed', available: true, selected: true },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', tradeoff: 'Balanced everyday workhorse.', source: 'refreshed', available: true, selected: false },
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', tradeoff: 'Fast for clear, repeatable work.', source: 'refreshed', available: true, selected: false },
      ],
      defaultModel: null,
      effectiveModel: { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', source: 'refreshed', available: true, known: true, state: 'provider-default' },
      catalogue: { state: 'refreshed', reasonCode: null, checkedAt: '2026-07-22T12:00:00.000Z' },
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
  await page.route('**/api/device/codex-deep-link', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      state: 'supported',
      canAttempt: true,
      reasonCode: null,
      checkedAt: '2026-07-28T12:00:00.000Z',
      platform: 'darwin',
    }),
  }));
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
  await expect(claudeModels).toContainText(['Provider default', 'Opus 4.8', 'Haiku 4.5', 'Other…']);
  await expect(picker.locator('[data-engine-card="codex"]')).toContainText('Provider default — GPT-5.6 Sol');
  await expect(picker.locator('[data-engine-card="codex"]')).toContainText('refreshed catalogue');
  await expect(picker.locator('[data-engine-model="codex"] option')).toHaveCount(5);
  await expect(picker.locator('[data-engine-model="codex"]')).toContainText('Most capable for complex');
  await expect(picker.locator('[data-engine-model="codex"]')).toContainText('Balanced everyday');
  await expect(picker.locator('[data-engine-model="codex"]')).toContainText('Fast for clear');

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

test('fallback and stale catalogues are explicit and force a deliberate valid choice', async ({ page }) => {
  await page.unroute('**/api/engines');
  await page.route('**/api/engines', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        engines: {
          claude: engines.engines.claude,
          codex: {
            usage: { unknown: true },
            models: [
              { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tradeoff: 'Most capable bundled choice.', source: 'bundled', available: 'unknown', selected: false },
              { id: 'gpt-old-stale', label: 'gpt-old-stale', tradeoff: 'Configured model is absent from the refreshed catalogue.', source: 'configured', available: false, selected: false },
            ],
            defaultModel: null,
            effectiveModel: { id: 'gpt-old-stale', label: 'gpt-old-stale', source: 'configured', available: false, known: true, state: 'stale' },
            catalogue: { state: 'fallback', reasonCode: 'command-unsupported', checkedAt: null },
            raw: `${['', 'Users', 'example'].join('/')} person@example.test token=secret`,
          },
        },
      }),
    });
  });
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  const codex = page.locator('[data-engine-card="codex"]');
  await expect(codex).toContainText('bundled fallback');
  await expect(codex).toContainText(/saved default unavailable/i);
  await expect(codex.locator('option[value="gpt-old-stale"]')).toHaveAttribute('disabled', '');
  await expect(codex).not.toContainText(['', 'Users', 'example'].join('/'));
  await expect(codex).not.toContainText('person@example.test');
  await expect(codex).not.toContainText('token=secret');
  await page.click('[data-engine-card="codex"] [data-action="pick-engine"]');
  await expect(page.locator('#chat-drawer')).toContainText('Choose an available model');
  await page.selectOption('[data-engine-model="codex"]', 'gpt-5.6-sol');
  await page.click('[data-engine-card="codex"] [data-action="pick-engine"]');
  await expect(page.locator('.chat-head .model-chip')).toHaveText('gpt-5.6-sol');
});

test('a provider-rejected choice is disabled and explained', async ({ page }) => {
  await page.unroute('**/api/engines');
  await page.route('**/api/engines', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        engines: {
          claude: engines.engines.claude,
          codex: {
            usage: { unknown: true },
            models: [{
              id: 'gpt-former',
              label: 'gpt-former',
              tradeoff: 'Provider rejected this model; choose another model deliberately.',
              source: 'configured',
              available: false,
              selected: false,
            }],
            defaultModel: null,
            effectiveModel: { id: 'gpt-former', label: 'gpt-former', source: 'configured', available: false, known: true, state: 'stale' },
            catalogue: { state: 'refreshed', reasonCode: null, checkedAt: null },
          },
        },
      }),
    });
  });
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  const codex = page.locator('[data-engine-card="codex"]');
  await expect(codex).toContainText('Provider rejected this model');
  await expect(codex.locator('option[value="gpt-former"]')).toHaveAttribute('disabled', '');
});

test('the picker still works when provider usage cannot be read', async ({ page }) => {
  await page.unroute('**/api/engines');
  await page.route('**/api/engines', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ engines: {
        claude: { usage: { unknown: true }, models: [], defaultModel: null, effectiveModel: { id: null, label: 'Provider default (model unknown)', available: 'unknown', known: false }, catalogue: { state: 'fallback' } },
        codex: { usage: { unknown: true }, models: [], defaultModel: null, effectiveModel: { id: null, label: 'Provider default (model unknown)', available: 'unknown', known: false }, catalogue: { state: 'fallback' } },
      } }),
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

test('model-picker draft state does not leak between chats', async ({ page }) => {
  await page.evaluate(() => window.Scout.openChat('chat-a', 'ask'));
  await page.waitForSelector('[data-engine-model="codex"]');
  await page.selectOption('[data-engine-model="codex"]', '__other__');
  await page.fill('[data-engine-model-custom="codex"]', 'private-custom-model');

  await page.evaluate(() => window.Scout.openChat('chat-b', 'ask'));
  await page.waitForSelector('[data-engine-model="codex"]');
  await expect(page.locator('[data-engine-model="codex"]')).toHaveValue('');
  await expect(page.locator('[data-engine-model-custom="codex"]')).toBeHidden();
  await expect(page.locator('[data-engine-model-custom="codex"]')).toHaveValue('');
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

test('a supported local Codex handler targets the exact task without claiming success', async ({ page }) => {
  await page.unroute('**/api/chat?*');
  await page.route('**/api/chat?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      chat: {
        engine: 'codex',
        model: 'gpt-5.6-sol',
        cliSessionId: '019f1234-abcd-7890',
        messages: [],
        filesTouched: [],
      },
      prefills: {},
      purpose: 'job',
      busy: false,
    }),
  }));
  await page.evaluate(() => {
    window.Scout.codexNavigate = (href) => { window.__codexTarget = href; };
  });

  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  const open = page.locator('[data-action="open-codex-task"]');
  await expect(open).toBeEnabled();
  await expect(page.locator('[data-codex-task-id]')).toHaveText('019f1234-abcd-7890');
  await open.click();
  await expect.poll(() => page.evaluate(() => window.__codexTarget))
    .toBe('codex://threads/019f1234-abcd-7890');
  await expect(page.locator('.codex-link-status')).toContainText(/cannot confirm|could not open/i);
  await expect(page.locator('.model-chip')).toHaveText('gpt-5.6-sol');
  await expect(page.locator('#usage-meters')).toContainText('usage unavailable');
});

test('missing and remote Codex handlers keep the exact task copyable with resume guidance', async ({ page }) => {
  await page.unroute('**/api/chat?*');
  await page.route('**/api/chat?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      chat: {
        engine: 'codex',
        model: null,
        cliSessionId: 'task-exact-123',
        messages: [],
        filesTouched: [],
      },
      prefills: {},
      purpose: 'job',
      busy: false,
    }),
  }));
  await page.unroute('**/api/device/codex-deep-link');
  await page.route('**/api/device/codex-deep-link', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      state: 'remote',
      canAttempt: false,
      reasonCode: 'browser-device-required',
      checkedAt: '2026-07-28T12:00:00.000Z',
      platform: null,
    }),
  }));
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { window.__copiedTask = value; } },
    });
  });

  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await expect(page.locator('[data-action="open-codex-task"]')).toHaveCount(0);
  await expect(page.locator('.codex-link-status')).toContainText(/device opening this page/i);
  await expect(page.locator('.codex-link-status')).toContainText(/resume/i);
  await page.click('[data-action="copy-codex-task"]');
  await expect.poll(() => page.evaluate(() => window.__copiedTask)).toBe('task-exact-123');
});

test('a failed Codex navigation becomes a visible fallback', async ({ page }) => {
  await page.unroute('**/api/chat?*');
  await page.route('**/api/chat?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      chat: {
        engine: 'codex',
        model: null,
        cliSessionId: 'task-launch-fails',
        messages: [],
        filesTouched: [],
      },
      prefills: {},
      purpose: 'job',
      busy: false,
    }),
  }));
  await page.evaluate(() => {
    window.Scout.codexNavigate = () => { throw new Error(`${['', 'Users', 'private'].join('/')} raw launch error`); };
  });
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await page.click('[data-action="open-codex-task"]');
  await expect(page.locator('.codex-link-status')).toContainText(/could not open Codex/i);
  await expect(page.locator('.codex-link-status')).toContainText('task-launch-fails');
  await expect(page.locator('.codex-link-status')).not.toContainText(['', 'Users', 'private'].join('/'));
});

test('a hostile Codex task identity is escaped, copyable and never launched', async ({ page }) => {
  const hostile = '<img src=x onerror=alert(1)>';
  await page.unroute('**/api/chat?*');
  await page.route('**/api/chat?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      chat: {
        engine: 'codex',
        model: null,
        cliSessionId: hostile,
        messages: [],
        filesTouched: [],
      },
      prefills: {},
      purpose: 'job',
      busy: false,
    }),
  }));
  await page.evaluate(() => {
    window.Scout.codexNavigate = (href) => { window.__codexTarget = href; };
  });
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await expect(page.locator('[data-codex-task-id]')).toHaveText(hostile);
  await expect(page.locator('.codex-link-status img')).toHaveCount(0);
  await expect(page.locator('[data-action="open-codex-task"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.__codexTarget)).toBeUndefined();
});

test('stale Codex model and unavailable task handler remain independently actionable', async ({ page }) => {
  await page.unroute('**/api/chat?*');
  await page.route('**/api/chat?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      chat: {
        engine: 'codex',
        model: null,
        cliSessionId: 'task-stale-model',
        messages: [],
        filesTouched: [],
      },
      prefills: {},
      purpose: 'job',
      busy: false,
    }),
  }));
  await page.unroute('**/api/engines');
  await page.route('**/api/engines', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      engines: {
        ...engines.engines,
        codex: {
          ...engines.engines.codex,
          models: [{
            id: 'gpt-old-stale',
            label: 'gpt-old-stale',
            tradeoff: 'Configured model is absent from the refreshed catalogue.',
            source: 'configured',
            available: false,
            selected: false,
          }],
          defaultModel: null,
          effectiveModel: {
            id: 'gpt-old-stale',
            label: 'gpt-old-stale',
            source: 'configured',
            available: false,
            known: true,
            state: 'stale',
          },
          catalogue: { state: 'refreshed', reasonCode: null, checkedAt: '2026-07-28T12:00:00.000Z' },
        },
      },
    }),
  }));
  await page.unroute('**/api/device/codex-deep-link');
  await page.route('**/api/device/codex-deep-link', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      state: 'unavailable',
      canAttempt: false,
      reasonCode: 'handler-missing',
      checkedAt: '2026-07-28T12:00:00.000Z',
      platform: 'darwin',
    }),
  }));

  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  await expect(page.locator('.chat-model-status')).toContainText(/saved default.*unavailable/i);
  await expect(page.locator('.codex-link-status')).toContainText(/no supported Codex handler/i);
  await expect(page.locator('#usage-meters')).toContainText('usage unavailable');
  await expect(page.locator('.model-chip')).toHaveText('provider default');
  await expect(page.locator('.codex-link-status')).toHaveAttribute('role', 'status');

  const copy = page.locator('[data-action="copy-codex-task"]');
  const close = page.locator('[data-action="close-chat"]');
  await copy.focus();
  await expect(copy).toBeFocused();
  await close.focus();
  await expect(close).toBeFocused();
});

test('model picker and custom model controls remain keyboard reachable', async ({ page }) => {
  await page.evaluate((id) => window.Scout.openChat(id, 'ask'), opportunity.id);
  const picker = page.locator('[data-engine-model="codex"]');
  const custom = page.locator('[data-engine-model-custom="codex"]');
  const close = page.locator('[data-action="close-chat"]');
  await picker.focus();
  await expect(picker).toBeFocused();
  await page.selectOption('[data-engine-model="codex"]', '__other__');
  await custom.focus();
  await expect(custom).toBeFocused();
  await close.focus();
  await expect(close).toBeFocused();
  await expect(page.locator('[data-engine-card="codex"] .engine-model-status'))
    .toHaveAttribute('aria-live', 'polite');
});
