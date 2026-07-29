import { expect, test } from '@playwright/test';

test('a cache rollover keeps the exact app module graph bootable offline', async ({ context, page }) => {
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const graph = await page.evaluate(async () => {
    const build = document.querySelector('meta[name="scout-ui-build"]')?.content;
    if (!build) throw new Error('missing UI build');
    const currentName = `scout-shell-${build}`;
    const oldName = 'scout-shell-offline-regression-a';
    const current = await caches.open(currentName);
    const currentKeys = await current.keys();
    if (!currentKeys.length) throw new Error('current shell cache is empty');

    // Recreate an A -> B activation sequence from the installed B snapshot.
    const old = await caches.open(oldName);
    for (const request of currentKeys) {
      const response = await current.match(request);
      const url = new URL(request.url);
      if (url.searchParams.get('v') === build) url.searchParams.set('v', 'offline-regression-a');
      await old.put(new Request(url), response.clone());
    }
    await caches.delete(currentName);
    const next = await caches.open(currentName);
    for (const request of await old.keys()) {
      const response = await old.match(request);
      const url = new URL(request.url);
      if (url.searchParams.get('v') === 'offline-regression-a') url.searchParams.set('v', build);
      await next.put(new Request(url), response.clone());
    }
    await caches.delete(oldName);

    const appUrl = new URL(`/app.js?v=${build}`, location.origin).href;
    const appResponse = await next.match(appUrl);
    if (!appResponse) throw new Error('build-B app.js is not cached');
    const source = await appResponse.text();
    const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)]
      .map((match) => new URL(match[1], appUrl).href);
    return {
      build,
      imports,
      cached: await Promise.all(imports.map(async (url) => Boolean(await next.match(url)))),
    };
  });

  expect(graph.imports.length).toBeGreaterThan(0);
  await page.close();
  const offlinePage = await context.newPage();
  const cdp = await context.newCDPSession(offlinePage);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await context.setOffline(true);
  await offlinePage.goto('/?offline-rollover=build-b', { waitUntil: 'commit' });
  await expect.poll(() => offlinePage.evaluate(() => Boolean(window.Scout)), { timeout: 10_000 }).toBe(true);
  expect(graph.cached, 'every browser-resolved static import has an exact build-B cache key')
    .toEqual(graph.imports.map(() => true));
});
