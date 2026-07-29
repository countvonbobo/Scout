import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const UI_ROOT = new URL('../../ui/', import.meta.url);
const text = (name) => fs.readFileSync(new URL(name, UI_ROOT), 'utf8');
const binary = (name) => fs.readFileSync(new URL(name, UI_ROOT));
const WORKER_TEMPLATE = text('service-worker.js');
const TEMPLATES = {
  '/offline-rollover/': text('index.html'),
  '/offline-rollover/app.js': text('app.js'),
  '/offline-rollover/setup.js': text('setup.js'),
  '/offline-rollover/reportView.js': text('reportView.js'),
  '/offline-rollover/manifest.webmanifest': text('manifest.webmanifest'),
  '/offline-rollover/lib/scoutCharacter.mjs': text('lib/scoutCharacter.mjs'),
  '/offline-rollover/lib/chatDrawerState.mjs': text('lib/chatDrawerState.mjs'),
  '/offline-rollover/lib/codexDeepLink.mjs': text('lib/codexDeepLink.mjs'),
};
const ASSETS = Object.fromEntries([
  'scout-icon.ico', 'scout-icon.png', 'scout-idle.png', 'scout-thinking.png',
  'scout-searching.png', 'scout-explaining.png', 'scout-found.png', 'scout-warning.png',
].map((name) => [`/offline-rollover/assets/${name}`, binary(`assets/${name}`)]));

function shellSource(build) {
  return TEMPLATES['/offline-rollover/']
    .replaceAll('__SCOUT_UI_BUILD__', build)
    .replaceAll('="/', '="/offline-rollover/');
}

function workerSource(build) {
  // Exercise the production worker's real SHELL, activation deletion and fetch
  // policy. Only its build placeholder and absolute scope are transformed so
  // two versions can coexist with the test server without controlling `/`.
  return WORKER_TEMPLATE
    .replaceAll('__SCOUT_UI_BUILD__', build)
    .replaceAll("'/", "'/offline-rollover/")
    .replaceAll('`/', '`/offline-rollover/');
}

async function waitForActiveBuild(page, build) {
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/offline-rollover/');
    return registration?.active?.scriptURL || '';
  }), { timeout: 15_000 }).toContain(`/offline-rollover/sw.js?build=${build}`);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || ''), {
    timeout: 15_000,
  }).toContain(`/offline-rollover/sw.js?build=${build}`);
}

test('a real A-to-B worker activation keeps the exact app module graph bootable offline', async ({ browserName, context, page }) => {
  test.skip(browserName !== 'chromium', 'the HTTP-cache isolation uses a Chromium DevTools session');
  let servedBuild = 'build-a';
  let failedShellPath = null;
  let networkUnavailable = false;
  // The production app registers its root worker during boot. This harness
  // owns a narrower scope and blocks that unrelated registration so the root
  // worker cannot apply its production-wide old-cache deletion policy to the
  // two synthetic build caches under test.
  await context.route('**/service-worker.js', (route) => route.abort());
  await context.route('**/offline-rollover/**', async (route) => {
    if (networkUnavailable) {
      await route.abort();
      return;
    }
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/offline-rollover/sw.js') {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        headers: { 'Service-Worker-Allowed': '/offline-rollover/', 'Cache-Control': 'no-store' },
        body: workerSource(servedBuild),
      });
      return;
    }
    if (path === '/offline-rollover/') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: shellSource(servedBuild) });
      return;
    }
    if (TEMPLATES[path] !== undefined) {
      if (path === failedShellPath) {
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'fault-injected shell failure' });
        return;
      }
      const source = TEMPLATES[path]
        .replaceAll('__SCOUT_UI_BUILD__', servedBuild)
        .replaceAll('="/', '="/offline-rollover/');
      const contentType = path.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/javascript';
      await route.fulfill({ status: 200, contentType, body: source });
      return;
    }
    if (ASSETS[path]) {
      await route.fulfill({ status: 200, body: ASSETS[path] });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  });

  await page.goto('/offline-rollover/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/offline-rollover/sw.js?build=build-a', {
      scope: '/offline-rollover/',
      updateViaCache: 'none',
    });
  });
  await waitForActiveBuild(page, 'build-a');
  expect(await page.evaluate(() => caches.has('scout-shell-build-a'))).toBe(true);

  // A live build-A worker may serve newer HTML from the network, but an
  // interrupted build-B install must leave A's complete offline graph intact.
  servedBuild = 'build-broken';
  failedShellPath = '/offline-rollover/lib/chatDrawerState.mjs';
  await page.goto('/offline-rollover/?preview=build-broken');
  await expect(page.locator('meta[name="scout-ui-build"]')).toHaveAttribute('content', 'build-broken');
  const interrupted = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register(
      '/offline-rollover/sw.js?build=build-broken',
      { scope: '/offline-rollover/', updateViaCache: 'none' },
    );
    const worker = registration.installing;
    if (worker && !['activated', 'redundant'].includes(worker.state)) {
      await new Promise((resolve) => worker.addEventListener('statechange', () => {
        if (['activated', 'redundant'].includes(worker.state)) resolve();
      }));
    }
    return {
      attempted: worker?.state || null,
      active: registration.active?.scriptURL || '',
    };
  });
  expect(interrupted).toEqual({
    attempted: 'redundant',
    active: expect.stringContaining('/offline-rollover/sw.js?build=build-a'),
  });
  const retainedBuild = await page.evaluate(async () => {
    const cached = await (await caches.open('scout-shell-build-a')).match('/offline-rollover/');
    const source = await cached.text();
    return source.match(/name="scout-ui-build" content="([^"]+)"/)?.[1] || null;
  });
  expect(retainedBuild).toBe('build-a');

  const interruptedOfflinePage = await context.newPage();
  const interruptedCdp = await context.newCDPSession(interruptedOfflinePage);
  await interruptedCdp.send('Network.enable');
  await interruptedCdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  networkUnavailable = true;
  await context.setOffline(true);
  await interruptedOfflinePage.goto('/offline-rollover/?offline=interrupted', { waitUntil: 'commit' });
  await expect.poll(() => interruptedOfflinePage.evaluate(() => ({
    build: document.querySelector('meta[name="scout-ui-build"]')?.content,
    booted: Boolean(window.Scout),
  })), { timeout: 15_000 }).toEqual({ build: 'build-a', booted: true });
  await context.setOffline(false);
  networkUnavailable = false;
  await interruptedOfflinePage.close();

  servedBuild = 'build-b';
  failedShellPath = null;
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/offline-rollover/sw.js?build=build-b', {
      scope: '/offline-rollover/',
      updateViaCache: 'none',
    });
  });
  await waitForActiveBuild(page, 'build-b');
  await expect.poll(() => page.evaluate(async () => ({
    old: await caches.has('scout-shell-build-a'),
    next: await caches.has('scout-shell-build-b'),
  }))).toEqual({ old: false, next: true });

  const graph = await page.evaluate(async () => {
    const build = 'build-b';
    const cache = await caches.open(`scout-shell-${build}`);
    const appUrl = new URL(`/offline-rollover/app.js?v=${build}`, location.origin).href;
    const appResponse = await cache.match(appUrl);
    if (!appResponse) throw new Error('build-B app.js is not cached');
    const source = await appResponse.text();
    const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)]
      .map((match) => new URL(match[1], appUrl).href);
    return {
      imports,
      cached: await Promise.all(imports.map(async (url) => Boolean(await cache.match(url)))),
    };
  });
  expect(graph.imports.length).toBeGreaterThan(0);
  expect(graph.cached, 'every browser-resolved static import has an exact build-B cache key')
    .toEqual(graph.imports.map(() => true));

  await page.close();
  const offlinePage = await context.newPage();
  const cdp = await context.newCDPSession(offlinePage);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  networkUnavailable = true;
  await context.setOffline(true);
  await offlinePage.goto('/offline-rollover/?offline=build-b', { waitUntil: 'commit' });
  await expect.poll(() => offlinePage.evaluate(() => ({
    build: document.querySelector('meta[name="scout-ui-build"]')?.content,
    booted: Boolean(window.Scout),
  })), { timeout: 15_000 }).toEqual({ build: 'build-b', booted: true });
});
