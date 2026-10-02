// Offline cache. Bump VERSION whenever any file changes so phones pick up the update.
const VERSION = 'v2';
const FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'manifest.webmanifest',
  'data/packs.json',
  'data/en-dublin.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first (instant + works on bad roaming signal), refresh the cache in the background.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      if (cached) { e.waitUntil(fresh); return cached; }
      return fresh;
    })
  );
});
