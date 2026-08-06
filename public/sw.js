const CACHE_NAME = 'havehjulet-shell-v1';
const SHELL_FILES = [
  '/',
  '/manifest.json',
  '/favicon.svg',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first for everything (API calls, map tiles, live data) so users
// always see fresh data when online; falls back to the cached app shell
// (index.html) if the network is unavailable, so the app still opens.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if(req.method !== 'GET') return;

  // never try to cache/serve cross-origin requests (map tiles, external APIs)
  if(new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => {
        if(req.url.endsWith('/') || SHELL_FILES.some(f => req.url.endsWith(f))){
          cache.put(req, copy);
        }
      });
      return res;
    }).catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
  );
});
