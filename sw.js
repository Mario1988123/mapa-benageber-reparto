const CACHE = 'reparto-sab-v2';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'config.js',
  'manifest.json',
  'streets.geojson',
  'zones.json',
  'lib/leaflet.js',
  'lib/leaflet.css',
  'lib/supabase.js',
  'icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Nunca cachear llamadas a Supabase (tiempo real) ni las teselas de satélite (pesan mucho).
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('ign.es')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp.ok && event.request.method === 'GET') {
          const clone = resp.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
