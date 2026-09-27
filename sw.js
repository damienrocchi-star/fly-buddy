// Offline support: keep a copy of the app on the phone.
// Serves the saved copy instantly, and refreshes it in the background when there's signal.
const CACHE = 'fly-buddy-v1';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'store.js', 'manifest.json',
  'data/usgs.js', 'data/weather.js', 'engine/recommend.js', 'engine/rigging.js',
  'knowledge/hatches.json', 'knowledge/flies.json', 'knowledge/steelhead.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Only handle our own files; river and weather data are saved by the app itself.
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(fresh); return hit; }
    return (await fresh) || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
  }));
});
