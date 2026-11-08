const CACHE_NAME = 'gudangpro-v4.3';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon.svg',
  '/vendor/chart.umd.js',
  '/vendor/xlsx.full.min.js',
  '/camcount.js',
  // Camera Counter AI engine + model (so counting works offline in the field)
  '/vendor/tf.min.js',
  '/vendor/coco-ssd.min.js',
  '/vendor/coco/model.json',
  '/vendor/coco/group1-shard1of5',
  '/vendor/coco/group1-shard2of5',
  '/vendor/coco/group1-shard3of5',
  '/vendor/coco/group1-shard4of5',
  '/vendor/coco/group1-shard5of5'
];

// Install: Cache core application assets immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of ASSETS_TO_CACHE) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn('[SW] Could not pre-cache:', asset, err);
        }
      }
    })
  );
  self.skipWaiting();
});

// Activate: Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Offline-First for App Shell so installed phone app works 100% without Hotspot or Tunnel
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. API and dynamic routes: Network first, fall back to offline JSON marker
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.status === 502 || res.status === 503 || res.status === 504 || res.status === 404) {
            throw new Error('Tunnel offline');
          }
          return res;
        })
        .catch(() => {
          return new Response(
            JSON.stringify({
              status: 'error',
              message: 'Koneksi ke server terputus (Offline). Menggunakan memori lokal HP.'
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        })
    );
    return;
  }

  // On PC localhost, always use network first so updates are immediate
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // 2. Navigation / HTML pages: Cache-First with safe background refresh (never overwrite with 502/404 tunnel page)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = (await cache.match('/index.html')) || (await cache.match('/'));
        const fetchPromise = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200 && (networkResponse.headers.get('x-gudangpro-app') === '1' || self.location.hostname.endsWith('.github.io'))) {
              cache.put('/index.html', networkResponse.clone());
              cache.put('/', networkResponse.clone());
              return networkResponse;
            }
            return cached || networkResponse;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // 3. Static assets: Cache-First
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200) return networkResponse;
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
        return networkResponse;
      });
    })
  );
});

