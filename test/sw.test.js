/*
 * Test for the service worker: the app files of one version stay together.
 * Runs sw.js with a small imitation of the browser (caches, fetch, events). Run: node test/sw.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ORIGIN = 'https://example.org';
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

// ---------- Imitation of the browser ----------

const server = {};                 // path -> content, what the web server has right now
let online = true;
const fetched = [];                // { url, cache } of every network request

class FakeRequest {
  constructor(url, init) { this.url = new URL(url, ORIGIN + '/').href; this.method = 'GET'; this.cache = (init && init.cache) || 'default'; }
}
const urlOf = (r) => typeof r === 'string' ? new URL(r, ORIGIN + '/').href : r.url;
const response = (body) => ({ ok: true, body, clone() { return response(body); } });

async function fakeFetch(req) {
  const url = urlOf(req);
  fetched.push({ url, cache: req.cache || 'default' });
  if (!online) throw new Error('offline');
  const u = new URL(url);
  const key = u.pathname === '/' ? '/index.html' : u.pathname;
  if (!(key in server)) return { ok: false, body: null, clone() { return this; } };
  return response(server[key]);
}

const stores = new Map();          // cache name -> Map(url -> response)
const fakeCaches = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async addAll(reqs) { for (const r of reqs) { const res = await fakeFetch(r); if (!res.ok) throw new Error('addAll ' + urlOf(r)); m.set(urlOf(r), res); } },
      async match(r) { return m.get(urlOf(r)); },
      async put(r, res) { m.set(urlOf(r), res); },
      async keys() { return [...m.keys()]; },
      async delete(r) { return m.delete(urlOf(r)); }
    };
  },
  async keys() { return [...stores.keys()]; },
  async delete(name) { return stores.delete(name); }
};

// Start a service worker from the source (optionally with another VERSION) and return its event handlers
function startWorker(version) {
  const src = version ? SOURCE.replace(/const VERSION = '[^']*'/, `const VERSION = '${version}'`) : SOURCE;
  const handlers = {};
  const self = { location: new URL(ORIGIN + '/sw.js'), addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {}, clients: { claim: async () => {} } };
  new Function('self', 'caches', 'fetch', 'Request', 'URL', src)(self, fakeCaches, fakeFetch, FakeRequest, URL);
  const run = async (type) => { let p; handlers[type]({ waitUntil: (x) => { p = x; } }); await p; };
  const get = async (url) => {
    let p = null;
    handlers.fetch({ request: new FakeRequest(url), respondWith: (x) => { p = x; } });
    return p ? (await p).body : 'NOT HANDLED';
  };
  return { install: () => run('install'), activate: () => run('activate'), get };
}

// ---------- The story ----------

(async () => {
  // Every file of SHELL in sw.js is on the server ('./' is the start page index.html)
  const shellFiles = [...SOURCE.match(/const SHELL = \[([\s\S]*?)\]/)[1].matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
  const deploy = (tag) => {
    for (const f of shellFiles) server['/' + f] = f + ' ' + tag;
    server['/data/index.json'] = 'stations ' + tag;
  };

  // Version 1 is installed
  deploy('v1');
  const sw1 = startWorker('umsteiger-test-1');
  await sw1.install();
  await sw1.activate();
  assert.ok(fetched.length >= 9 && fetched.every(f => f.cache === 'reload'), 'install fetches past the HTTP cache');
  assert.strictEqual(await sw1.get('/app.js?v=1'), 'app.js v1');
  assert.strictEqual(await sw1.get('/?id=450426'), 'index.html v1', 'start page with parameters');

  // New files on the server, the phone still runs the old service worker: everything stays version 1
  // (before, app.js could be new while i18n.js was old – the UI then showed text keys like "kindsAlso")
  deploy('v2');
  assert.strictEqual(await sw1.get('/app.js?v=2'), 'app.js v1');
  assert.strictEqual(await sw1.get('/i18n.js?v=2'), 'i18n.js v1');
  assert.strictEqual(await sw1.get('/index.html'), 'index.html v1');

  // The new service worker brings the complete new set and removes the old one
  const sw2 = startWorker('umsteiger-test-2');
  await sw2.install();
  await sw2.activate();
  assert.strictEqual(await sw2.get('/app.js?v=2'), 'app.js v2');
  assert.strictEqual(await sw2.get('/i18n.js?v=2'), 'i18n.js v2');
  assert.ok(!stores.has('umsteiger-test-1'), 'old set deleted');

  // Station list: fresh when online, the stored copy when offline
  assert.strictEqual(await sw2.get('/data/index.json'), 'stations v2');
  deploy('v3');
  assert.strictEqual(await sw2.get('/data/index.json'), 'stations v3');
  online = false;
  assert.strictEqual(await sw2.get('/data/index.json'), 'stations v3');
  assert.strictEqual(await sw2.get('/core.js?v=2'), 'core.js v2', 'app works offline');

  // Left to the app: station files and live data
  assert.strictEqual(await sw2.get('/data/st/450426.json'), 'NOT HANDLED');
  assert.strictEqual(await sw2.get('/api/arrivals?eva=1'), 'NOT HANDLED');

  // The real sw.js lists both pages and every app file they load
  const pages = ['index.html', 'station.html', 'departures.html', 'route.html'];
  const html = pages.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  for (const page of pages) assert.ok(SOURCE.includes(`'./${page}'`), page + ' is missing in SHELL of sw.js');
  const local = [...html.matchAll(/(?:src|href)="([^":]+?)(?:\?v=dev)?"/g)].map(m => m[1]).filter(f => /\.(js|css|webmanifest)$/.test(f));
  for (const f of local) assert.ok(SOURCE.includes(`'./${f}'`), f + ' is missing in SHELL of sw.js');
  // deploy.sh replaces 'dev' with a checksum of the app files, so every app file in a page carries ?v=dev
  const plain = [...html.matchAll(/(?:src|href)="([^":?]+\.(?:js|css))(\?v=[^"]*)?"/g)].filter(m => m[2] !== '?v=dev');
  assert.deepStrictEqual(plain.map(m => m[0]), [], 'app files in the pages without ?v=dev');
  assert.ok(SOURCE.includes("const VERSION = 'umsteiger-dev'"), "VERSION in sw.js is 'umsteiger-dev' (deploy.sh fills it in)");

  console.log('sw.test.js: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
