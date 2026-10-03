// Offline support: keep a copy of the app on the phone.
// With signal, always load the latest version (so updates show up straight away).
// Offline or on a very slow connection, use the saved copy.
const CACHE = 'fly-buddy-v16';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'store.js', 'units.js', 'icons.js', 'manifest.json',
  'data/usgs.js', 'data/weather.js', 'data/noaa.js', 'data/nldi.js', 'data/places.js', 'engine/recommend.js', 'engine/rigging.js', 'engine/rating.js',
  'knowledge/hatches.json', 'knowledge/flies.json', 'knowledge/steelhead.json', 'knowledge/rating.json', 'knowledge/rivers.json', 'knowledge/salmon.json', 'knowledge/report-signals.json', 'engine/report-signals.js', 'knowledge/learn.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
];
const NETWORK_WAIT_MS = 4000;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache so we save the newest files.
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // (A page-navigation Request can't be re-fetched with options, so use its URL.)
    const network = fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS, null));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch (err) { /* offline */ }
    const hit = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('index.html') : null);
    if (hit) { e.waitUntil(network.catch(() => {})); return hit; }
    return network; // nothing saved yet; wait for the network
  })());
});
