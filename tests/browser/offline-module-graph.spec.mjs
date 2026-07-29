import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const UI_ROOT = new URL('../../ui/', import.meta.url);
const text = (name) => fs.readFileSync(new URL(name, UI_ROOT), 'utf8');
const binary = (name) => fs.readFileSync(new URL(name, UI_ROOT));
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
  const shell = [
    '/offline-rollover/',
    ...['reportView.js', 'app.js', 'setup.js'].map((name) => `/offline-rollover/${name}?v=${build}`),
    ...['scoutCharacter.mjs', 'chatDrawerState.mjs', 'codexDeepLink.mjs']
      .map((name) => `/offline-rollover/lib/${name}?v=${build}`),
    `/offline-rollover/manifest.webmanifest?v=${build}`,
    ...Object.keys(ASSETS).map((name) => `${name}?v=${build}`),
  ];
  return `
    const CACHE = ${JSON.stringify(`scout-offline-rollover-${build}`)};
    const SHELL = ${JSON.stringify(shell)};
    self.addEventListener('install', (event) => {
      event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
      self.skipWaiting();
    });
    self.addEventListener('activate', (event) => {
      event.waitUntil(caches.keys().then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('scout-offline-rollover-') && key !== CACHE)
          .map((key) => caches.delete(key)),
      )));
      self.clients.claim();
    });
    self.addEventListener('fetch', (event) => {
      const url = new URL(event.request.url);
      if (url.pathname === '/offline-rollover/' || event.request.mode === 'navigate') {
        event.respondWith(fetch(event.request).catch(() => caches.match('/offline-rollover/')));
        return;
      }
      event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
    });
  `;
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

test('a real A-to-B worker activation keeps the exact app module graph bootable offline', async ({ context, page }) => {
  let servedBuild = 'build-a';
  // The production app registers its root worker during boot. This harness
  // owns a narrower scope and blocks that unrelated registration so the root
  // worker cannot apply its production-wide old-cache deletion policy to the
  // two synthetic build caches under test.
  await context.route('**/service-worker.js', (route) => route.abort());
  await context.route('**/offline-rollover/**', async (route) => {
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
  expect(await page.evaluate(() => caches.has('scout-offline-rollover-build-a'))).toBe(true);

  servedBuild = 'build-b';
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/offline-rollover/sw.js?build=build-b', {
      scope: '/offline-rollover/',
      updateViaCache: 'none',
    });
  });
  await waitForActiveBuild(page, 'build-b');
  await expect.poll(() => page.evaluate(async () => ({
    old: await caches.has('scout-offline-rollover-build-a'),
    next: await caches.has('scout-offline-rollover-build-b'),
  }))).toEqual({ old: false, next: true });

  const graph = await page.evaluate(async () => {
    const build = 'build-b';
    const cache = await caches.open(`scout-offline-rollover-${build}`);
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
  await context.setOffline(true);
  await offlinePage.goto('/offline-rollover/?offline=build-b', { waitUntil: 'commit' });
  await expect.poll(() => offlinePage.evaluate(() => ({
    build: document.querySelector('meta[name="scout-ui-build"]')?.content,
    booted: Boolean(window.Scout),
  })), { timeout: 15_000 }).toEqual({ build: 'build-b', booted: true });
});
