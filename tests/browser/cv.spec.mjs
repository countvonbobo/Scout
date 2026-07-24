import { expect, test } from '@playwright/test';
import fs from 'node:fs';

const currentVersion = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const establishedStatus = {
  bootstrap: false, established: true, ready: true, setupComplete: true, trackerExists: true,
  workspaceRoot: 'SYNTHETIC_WORKSPACE', appRoot: 'SYNTHETIC_APP', appVersion: currentVersion,
  config: { locale: 'en-GB', currency: 'GBP', timezone: 'Europe/London', profile: { displayName: 'Example Person' }, search: {}, commute: {}, ai: { provider: 'codex' } },
  providers: { codex: { installed: true, authenticated: true }, claude: { installed: false, authenticated: false } },
  scanHealth: { healthy: true }, schedule: { enabled: false, configured: false, runs: [] },
  device: { updates: { policy: 'notify' }, startupStatus: { supported: false } },
  git: { installed: true }, sync: { state: 'disabled', enabled: false }, remoteAccess: { state: 'disabled', enabled: false },
  requestAccess: 'local', pendingSetupSections: [],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/setup/status', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(establishedStatus) }));
  await page.goto('/');
});

test('CV library exposes legacy sources whose PDF and quality files are absent', async ({ page }) => {
  await page.getByRole('button', { name: 'CV' }).click();
  await expect(page.getByRole('heading', { name: 'CV library' })).toBeVisible();
  const legacy = page.locator('[data-cv-path="applications/legacy-systems/cv.typ"]');
  await expect(legacy).toContainText('Legacy Systems — Hardware Engineer');
  await expect(legacy).toContainText('PDF missing');
  await expect(legacy).toContainText('legacy');
  await legacy.click();
  await expect(page.locator('#cv-text')).toHaveValue(/Existing source remains editable/);
  await expect(page.locator('#cv-preview')).toContainText('No tailored PDF yet');
});

test('master reference PDF uses the real same-origin preview endpoint', async ({ page, request }) => {
  await page.getByRole('button', { name: 'CV' }).click();
  await page.locator('[data-cv-path="cv/master-cv.md"]').click();
  await expect(page.getByRole('button', { name: 'save + render reference PDF' })).toBeVisible();
  await expect(page.locator('#cv-preview iframe')).toBeVisible();
  await expect(page.getByRole('button', { name: 'download PDF' })).toBeEnabled();
  const response = await request.get('/api/cv/pdf?target=master');
  expect(response.status()).toBe(200);
  expect(response.headers()['x-frame-options']).toBe('SAMEORIGIN');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'self'");
  expect(response.headers()['content-type']).toBe('application/pdf');
});

test('CV creation is available from the library and opportunity card', async ({ page }) => {
  await page.getByRole('button', { name: 'CV' }).click();
  await page.getByRole('button', { name: 'Create tailored CV' }).click();
  await page.locator('#cv-create-opportunity').selectOption({ label: 'New Systems — Product Engineer' });
  const continueFromLibrary = page.getByRole('button', { name: 'Continue' });
  await continueFromLibrary.click();
  await expect(page.getByRole('heading', { name: 'Build this custom CV' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Build this custom CV' })).toBeFocused();
  await expect.poll(() => page.locator('main').evaluate((element) => element.inert)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Continue to job chat' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#cv-option-xyz')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#cv-options-overlay')).toBeHidden();
  await expect(continueFromLibrary).toBeFocused();

  await page.getByRole('button', { name: 'Jobs' }).click();
  const card = page.locator('#tab-jobs .card[data-id="new-systems-product-2026-07"]');
  await card.click();
  await expect(card.getByRole('button', { name: 'create custom CV' })).toBeVisible();
});

test('a generated CV appears after the chat file refresh without reloading', async ({ page }) => {
  let cvState = { master: 'cv/master-cv.md', applications: [], outreach: [], entries: [] };
  await page.route('**/api/cv', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(cvState) }));
  await page.reload();
  await page.getByRole('button', { name: 'CV' }).click();
  await expect(page.getByText('No tailored CVs yet. Create one from a tracked opportunity.')).toBeVisible();
  cvState = { master: 'cv/master-cv.md', applications: ['new-systems'], outreach: [], entries: [{ slug: 'new-systems', source: true, pdf: false, outreach: false, evidence: false, quality: false }] };
  await page.evaluate(() => window.Scout.refreshCvFilesIfTouched(['applications/new-systems/cv.typ']));
  await expect(page.locator('[data-cv-path="applications/new-systems/cv.typ"]')).toContainText('New Systems — Product Engineer');
});

test('an open master CV buffer survives an opportunities refresh', async ({ page }) => {
  await page.getByRole('button', { name: 'CV' }).click();
  await page.locator('[data-cv-path="cv/master-cv.md"]').click();
  const editor = page.locator('#cv-text');
  await expect(editor).toHaveValue(/Master CV/);
  const original = await editor.inputValue();
  const edited = `${original}\nUnsaved synthetic edit stays in the editor.\n`;
  await editor.fill(edited);
  await page.evaluate(() => window.Scout.loadOpportunities());
  await expect(editor).toHaveValue(edited);
  await expect(page.locator('#cv-dirty')).toHaveText('unsaved');
});
