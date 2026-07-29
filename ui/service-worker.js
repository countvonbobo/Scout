const BUILD = '__SCOUT_UI_BUILD__';
const CACHE_PREFIX = 'scout-shell-';
const CACHE = `${CACHE_PREFIX}${BUILD}`;
const SHELL = [
  '/', `/reportView.js?v=${BUILD}`, `/app.js?v=${BUILD}`, `/setup.js?v=${BUILD}`,
  `/lib/scoutCharacter.mjs?v=${BUILD}`, `/lib/chatDrawerState.mjs?v=${BUILD}`,
  `/lib/codexDeepLink.mjs?v=${BUILD}`,
  `/manifest.webmanifest?v=${BUILD}`, `/assets/scout-icon.ico?v=${BUILD}`, `/assets/scout-icon.png?v=${BUILD}`,
  `/assets/scout-idle.png?v=${BUILD}`, `/assets/scout-thinking.png?v=${BUILD}`,
  `/assets/scout-searching.png?v=${BUILD}`, `/assets/scout-explaining.png?v=${BUILD}`,
  `/assets/scout-found.png?v=${BUILD}`, `/assets/scout-warning.png?v=${BUILD}`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => {
    const shellCaches = keys.filter((key) => key.startsWith(CACHE_PREFIX));
    const previousCache = shellCaches.filter((key) => key !== CACHE).at(-1) || null;
    const retained = new Set([CACHE, previousCache].filter(Boolean));
    return Promise.all(shellCaches.filter((key) => !retained.has(key)).map((key) => caches.delete(key)));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' || url.pathname === '/') {
    // The install transaction owns the immutable root shell for this build.
    // A newer network document must not contaminate an older complete graph if
    // the newer worker's all-or-nothing installation later fails.
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then((cache) => cache.match('/'))));
    return;
  }
  const isShell = url.pathname === '/app.js' || url.pathname === '/setup.js' || url.pathname === '/reportView.js'
    || url.pathname === '/lib/scoutCharacter.mjs' || url.pathname === '/lib/chatDrawerState.mjs'
    || url.pathname === '/lib/codexDeepLink.mjs'
    || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/assets/');
  if (!isShell) return;
  const requestedBuild = url.searchParams.get('v');
  const requestedCache = requestedBuild && /^[a-z0-9-]{1,128}$/i.test(requestedBuild)
    ? `${CACHE_PREFIX}${requestedBuild}`
    : CACHE;
  event.respondWith(caches.has(requestedCache)
    .then((exists) => (exists ? caches.open(requestedCache).then((cache) => cache.match(request)) : null))
    .then((cached) => cached || fetch(request).then((response) => {
    if (requestedBuild === BUILD && response.ok && response.type === 'basic') {
      caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    }
    return response;
    })));
});
