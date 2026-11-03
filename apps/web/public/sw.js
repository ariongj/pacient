/*
 * Pacient service worker – makes the app installable and gives a friendly offline page.
 *
 * Privacy rule: only the application shell (HTML, hashed JS/CSS assets, icons) is cached.
 * API responses (/api/…) are NEVER cached or intercepted, so no health information is stored on
 * the device. Navigations are network-first; when offline the cached shell or offline page is used.
 */
const VERSION = 'pacient-shell-v1';
const SCOPE = self.registration.scope;
const SHELL = ['./', 'offline.html', 'offline.css', 'manifest.webmanifest', 'icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((p) => new URL(p, SCOPE).toString())))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never touch the API, other origins or live event streams.
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(VERSION).then((c) => c.put(new URL('./', SCOPE).toString(), copy));
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(VERSION);
          return (
            (await cache.match(new URL('./', SCOPE).toString())) ||
            (await cache.match(new URL('offline.html', SCOPE).toString()))
          );
        }),
    );
    return;
  }

  // Hashed build assets and icons: cache-first (their names change with every release).
  if (url.pathname.includes('/assets/') || url.pathname.includes('/icons/')) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) void cache.put(req, res.clone());
        return res;
      }),
    );
  }
});
