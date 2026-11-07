/* Umsteiger – service worker: makes the app available offline */
const VERSION = 'umsteiger-dev';          // deploy.sh replaces 'dev' with a checksum of the app files
const TILES = 'umsteiger-tiles';
const KEEP = 'umsteiger-keep';            // library and station list: survive version changes
const MAX_TILES = 400;
const SHELL = [
  './', './index.html', './route.js', './station.html', './app.js', './departures.html', './departures.js', './route.html',
  './style.css', './i18n.js', './core.js', './common.js', './stationdata.js', './stationmap.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

// The app files belong together (app.js needs the texts of the same i18n.js). So every version is one
// complete set: fetched fresh on install (past the browser's HTTP cache, which once kept an old i18n.js)
// and never updated piece by piece. A new deploy arrives as a new service worker with a new set.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => ![VERSION, TILES, KEEP].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) { cache.put(req, res.clone()); trim(cache); }
  return res;
}

// App file from this version's set; the "?v=…" in the pages does not matter here
async function shell(url) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(url.origin + url.pathname, { ignoreVary: true });
  return hit || fetch(url.href);
}

// Fresh from the network when possible, the stored copy when offline (station list for the search)
async function networkFirst(req, key) {
  const cache = await caches.open(KEEP);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

// Files that never change under their address (Leaflet from the CDN)
async function cacheFirst(req) {
  const cache = await caches.open(KEEP);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.includes('overpass')) return;            // the app caches its data itself
  if (url.pathname.includes('/api/')) return;               // live data from server.py: never cache
  if (/\/data\/(st|osm)\//.test(url.pathname)) return;      // station files: the app stores stations itself and must see when the server is unreachable
  if (url.hostname.endsWith('tile.openstreetmap.org')) { e.respondWith(tile(req)); return; }

  if (url.origin !== self.location.origin) { e.respondWith(cacheFirst(req)); return; }
  if (/\/data\//.test(url.pathname)) { e.respondWith(networkFirst(req, url.origin + url.pathname)); return; }
  e.respondWith(shell(url));
});
