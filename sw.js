const CACHE_NAME = 'suzans-security-v2';
const CORE_ASSETS = ['./', './index.html', './manifest.json', './House_Black_Logo.png'];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(CORE_ASSETS))
            .catch((err) => console.warn('SW precache failed (non-fatal):', err))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);

    // Never intercept cross-origin requests (Firebase, Firestore, Google Fonts, images).
    // Those need to hit the real network every time so live data / auth still works.
    if (url.origin !== self.location.origin) return;

    // Network-first for same-origin app-shell files, falling back to cache when offline.
    // This keeps the app fast on repeat loads without ever serving a stale index.html
    // while you're online.
    e.respondWith(
        fetch(e.request)
            .then((resp) => {
                const copy = resp.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(e.request, copy)).catch(() => {});
                return resp;
            })
            .catch(() => caches.match(e.request))
    );
});
