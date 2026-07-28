const BUILD = '__SCOUT_UI_BUILD__';
const CACHE = `scout-shell-${BUILD}`;
const SHELL = [
  '/', `/reportView.js?v=${BUILD}`, `/app.js?v=${BUILD}`, `/setup.js?v=${BUILD}`,
  `/lib/scoutCharacter.mjs?v=${BUILD}`,
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
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(fetch(request).then((response) => {
      if (response.ok && response.type === 'basic') {
        caches.open(CACHE).then((cache) => cache.put('/', response.clone()));
      }
      return response;
    }).catch(() => caches.match('/')));
    return;
  }
  const isShell = url.pathname === '/app.js' || url.pathname === '/setup.js' || url.pathname === '/reportView.js'
    || url.pathname === '/lib/scoutCharacter.mjs'
    || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/assets/');
  if (!isShell) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
    return response;
  })));
});
