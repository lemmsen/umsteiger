#!/usr/bin/env node
/*
 * Umsteiger – prepares OpenStreetMap data per station, so the app does not need Overpass.
 *
 * Input:  <rawdata>/germany-latest.osm.pbf (Geofabrik extract) and data/st/*.json
 *         (run tools/prepare-gtfs.js first: it defines the stations and their radius).
 * Output: <out>/osm/<id>.json with the same elements an Overpass stationQuery() would
 *         return, plus the positions needed by lookupQuery() – so core.js works unchanged.
 *
 * Needs osmium-tool (brew install osmium-tool). Usage: node tools/prepare-osm.js [rawdata] [out]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const U = require('../core.js');

const ROOT = path.join(__dirname, '..');
const RAW = path.resolve(process.argv[2] || path.join(ROOT, 'rawdata'));
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'data'));
const PBF = path.join(RAW, 'germany-latest.osm.pbf');
// Bump FILTER_VERSION when the osmium filters change, so the extract is filtered again
const FILTER_VERSION = 5;
const FEATURES = path.join(RAW, `osm-features-v${FILTER_VERSION}.opl`);
const ROUTES = path.join(RAW, `osm-routes-v${FILTER_VERSION}.opl`);
const TRACKS = path.join(RAW, `osm-tracks-v${FILTER_VERSION}.opl`); // tracks carrying stop signs
const WALK_HIGHWAYS = ['footway', 'path', 'pedestrian', 'corridor']; // same as core.js
const ENTRANCES = ['subway_entrance', 'train_station_entrance'];     // same as core.js

const ROUTE_TYPES = ['train', 'light_rail', 'subway']; // same as core.js stationQuery()
const CELL = 0.01;          // degrees: grid cell for the spatial index (about 1 km)
const MARGIN = 100;         // m: extra distance when collecting nodes around stations
const KEEP_TAGS = new Set(['name', 'ref', 'local_ref', 'route_ref', 'railway:track_ref', 'railway', 'public_transport',
  'highway', 'conveying', 'subway', 'train', 'light_rail', 'route', 'colour', 'to', 'description', 'level', 'tunnel', 'indoor', 'access', 'foot',
  'railway:platform:section', 'railway:signal:stop', 'railway:signal:stop:caption']);
const RAIL_WAYS = /^(rail|light_rail|subway|narrow_gauge)$/;

const elapsed = (t0) => ((Date.now() - t0) / 1000).toFixed(0) + ' s';
const round = (v) => Math.round(v * 1e6) / 1e6;

// ---------- Step 1: filter the extract with osmium (only when the .pbf is newer) ----------

function newer(a, b) { return !fs.existsSync(b) || fs.statSync(a).mtimeMs > fs.statSync(b).mtimeMs; }

function osmium(args) {
  console.log('osmium ' + args.join(' '));
  execFileSync('osmium', args, { stdio: 'inherit' });
}

function filterExtract() {
  if (!fs.existsSync(PBF)) throw new Error(PBF + ' not found – download the Geofabrik extract first (see README.md)');
  if (newer(PBF, FEATURES)) {
    const tmp = path.join(RAW, 'osm-features.osm.pbf');
    // Stops, platforms and access ways, with the nodes and member ways they need for their geometry
    osmium(['tags-filter', PBF, 'n/public_transport=stop_position', 'n/railway=stop',
      'nwr/railway=platform', 'nwr/public_transport=platform', 'w/highway=steps', 'nw/highway=elevator',
      'w/conveying', 'w/highway=' + WALK_HIGHWAYS.join(','),
      'n/railway=' + ENTRANCES.join(','), 'n/railway=buffer_stop', 'n/railway:platform:section', 'n/railway:signal:stop',
      '-o', tmp, '--overwrite']);
    osmium(['cat', tmp, '-f', 'opl,add_metadata=false', '-o', FEATURES, '--overwrite']);
    fs.unlinkSync(tmp);
  }
  if (newer(PBF, ROUTES)) {
    const tmp = path.join(RAW, 'osm-routes.osm.pbf');
    // Route relations only (member lists, no geometry)
    osmium(['tags-filter', PBF, 'r/route=' + ROUTE_TYPES.join(','), '-R', '-o', tmp, '--overwrite']);
    osmium(['cat', tmp, '-f', 'opl,add_metadata=false', '-o', ROUTES, '--overwrite']);
    fs.unlinkSync(tmp);
  }
}

// Tracks carrying stop signs (Haltetafeln), with their nodes: needed to know for which direction
// of travel a sign is meant (railway:signal:direction is relative to the track's drawing direction)
async function filterTracks() {
  if (!newer(FEATURES, TRACKS)) return;
  const signIds = path.join(RAW, 'osm-signs.ids'), wayIds = path.join(RAW, 'osm-sign-ways.ids');
  const parents = path.join(RAW, 'osm-sign-parents.opl');
  const ids = [];
  await eachLine(FEATURES, (line) => { if (line[0] === 'n' && line.includes('railway:signal:stop=')) ids.push(line.split(' ')[0]); });
  fs.writeFileSync(signIds, ids.join('\n') + '\n');
  osmium(['getparents', PBF, '-i', signIds, '-f', 'opl,add_metadata=false', '-o', parents, '--overwrite']);
  const ways = [];
  await eachLine(parents, (line) => { if (line[0] === 'w' && /railway=(rail|light_rail|subway|narrow_gauge)\b/.test(line)) ways.push(line.split(' ')[0]); });
  fs.writeFileSync(wayIds, ways.join('\n') + '\n');
  osmium(['getid', '-r', PBF, '-i', wayIds, '-f', 'opl,add_metadata=false', '-o', TRACKS, '--overwrite']);
  for (const f of [signIds, wayIds, parents]) fs.unlinkSync(f);
}

// Direction of travel a stop sign is meant for, as compass bearing (0 = north, 90 = east)
async function signBearings() {
  const signDir = new Map();        // sign node id -> 'forward' | 'backward'
  await eachLine(FEATURES, (line) => {
    if (line[0] !== 'n' || !line.includes('railway:signal:stop=')) return;
    const o = parseLine(line);
    signDir.set(o.id, o.tags['railway:signal:direction'] === 'backward' ? 'backward' : 'forward');
  });
  const pos = new Map(), bearing = new Map();
  await eachLine(TRACKS, (line) => {
    const o = parseLine(line);
    if (o.type === 'n') { pos.set(o.id, [o.lat, o.lon]); return; }
    if (o.type !== 'w' || !RAIL_WAYS.test(o.tags.railway || '')) return;
    o.nodes.forEach((n, i) => {
      if (!signDir.has(n) || bearing.has(n)) return;
      const a = pos.get(o.nodes[Math.max(0, i - 1)]), b = pos.get(o.nodes[Math.min(o.nodes.length - 1, i + 1)]);
      if (!a || !b || (a[0] === b[0] && a[1] === b[1])) return;
      const dy = b[0] - a[0], dx = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180);
      let deg = Math.atan2(dx, dy) * 180 / Math.PI;
      if (signDir.get(n) === 'backward') deg += 180;
      bearing.set(n, Math.round(((deg % 360) + 360) % 360));
    });
  });
  return bearing;
}

// ---------- OPL parsing ----------

const unescape = (s) => s.replace(/%([0-9a-fA-F]+)%/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));

function parseTags(s) {
  const tags = {};
  if (!s) return tags;
  for (const kv of s.split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) tags[unescape(kv.slice(0, i))] = unescape(kv.slice(i + 1));
  }
  return tags;
}

// "n123 Tk=v x13.1 y52.5" / "w5 Tk=v Nn1,n2" / "r7 Tk=v Mn1@stop,w2@platform"
function parseLine(line) {
  const parts = line.split(' ');
  const o = { type: parts[0][0], id: Number(parts[0].slice(1)), tags: {} };
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i], k = p[0], v = p.slice(1);
    if (k === 'T') o.tags = parseTags(v);
    else if (k === 'x') o.lon = Number(v);
    else if (k === 'y') o.lat = Number(v);
    else if (k === 'N') o.nodes = v ? v.split(',').map(n => Number(n.slice(1))) : [];
    else if (k === 'M') o.members = v ? v.split(',').map(m => {
      const at = m.indexOf('@');
      return { type: m[0], ref: Number(m.slice(1, at)), role: unescape(m.slice(at + 1)) };
    }) : [];
  }
  return o;
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) fn(line);
}

const pick = (tags) => {
  const out = {};
  for (const k in tags) if (KEEP_TAGS.has(k)) out[k] = tags[k];
  return out;
};

// ---------- Main ----------

async function main() {
  const t0 = Date.now();
  filterExtract();
  await filterTracks();
  const bearings = await signBearings();
  console.log(`filtered, ${bearings.size} stop signs with direction (${elapsed(t0)})`);

  // Stations and their search radius from the timetable data
  const stDir = path.join(OUT, 'st');
  const stations = fs.readdirSync(stDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(stDir, f))))
    .filter(d => !d.mergedInto) // parts merged into another station
    .map(d => ({ id: d.id, name: d.name, lat: d.lat, lon: d.lon, r: d.r }));
  const cellKey = (lat, lon) => Math.floor(lat / CELL) + ':' + Math.floor(lon / CELL);
  const cellsAround = (lat, lon, m) => {
    const dLat = m / 111320, dLon = m / (111320 * Math.cos(lat * Math.PI / 180)), keys = [];
    for (let a = Math.floor((lat - dLat) / CELL); a <= Math.floor((lat + dLat) / CELL); a++)
      for (let b = Math.floor((lon - dLon) / CELL); b <= Math.floor((lon + dLon) / CELL); b++) keys.push(a + ':' + b);
    return keys;
  };
  const nearCells = new Set();
  for (const s of stations) for (const k of cellsAround(s.lat, s.lon, s.r + MARGIN)) nearCells.add(k);
  console.log(`${stations.length} stations, ${nearCells.size} grid cells`);

  // Read features: keep node positions near stations (and all stops, for previous-stop positions)
  const pos = new Map();       // node id -> [lat, lon]
  const features = [];         // tagged objects near stations
  const byKey = new Map();     // "n123" -> feature (for lookups and route members)
  const relWays = new Map();   // way id -> geometry, for platform relations
  const pendingRels = [];
  const isStop = (t) => t.public_transport === 'stop_position' || t.railway === 'stop';
  const isPlatform = (t) => t.railway === 'platform' || t.public_transport === 'platform';
  const isAccess = (t) => t.highway === 'steps' || t.highway === 'elevator' || !!t.conveying;
  const isWalk = (t) => WALK_HIGHWAYS.includes(t.highway);
  const isEntrance = (t) => ENTRANCES.includes(t.railway);

  let lines = 0;
  await eachLine(FEATURES, (line) => {
    lines++;
    const o = parseLine(line);
    if (o.type === 'n') {
      const near = nearCells.has(cellKey(o.lat, o.lon));
      if (near || isStop(o.tags) || isPlatform(o.tags)) pos.set(o.id, [o.lat, o.lon]);
      const isMarker = near && (o.tags['railway:platform:section'] || bearings.has(o.id) || o.tags.railway === 'buffer_stop');
      if (isStop(o.tags) || isPlatform(o.tags) || (near && (isAccess(o.tags) || isEntrance(o.tags))) || isMarker) {
        const f = { type: 'node', id: o.id, lat: round(o.lat), lon: round(o.lon), tags: pick(o.tags) };
        if (bearings.has(o.id)) f.tags['umsteiger:bearing'] = String(bearings.get(o.id)); // see signBearings()
        byKey.set('n' + o.id, f);
        if (near) features.push(f);
      }
    } else if (o.type === 'w') {
      const geometry = o.nodes.map(n => pos.get(n)).filter(Boolean).map(([lat, lon]) => ({ lat: round(lat), lon: round(lon) }));
      if (!geometry.length) return;
      const tagged = isPlatform(o.tags) || isAccess(o.tags) || isWalk(o.tags);
      relWays.set(o.id, geometry);
      if (!tagged) return;
      const f = { type: 'way', id: o.id, tags: pick(o.tags), geometry };
      byKey.set('w' + o.id, f);
      if (geometry.some(g => nearCells.has(cellKey(g.lat, g.lon)))) features.push(f);
    } else if (o.type === 'r' && isPlatform(o.tags)) {
      pendingRels.push(o);
    }
  });
  for (const o of pendingRels) {
    const members = o.members.filter(m => m.type === 'w' && relWays.has(m.ref))
      .map(m => ({ type: 'way', ref: m.ref, role: m.role, geometry: relWays.get(m.ref) }));
    if (!members.length) continue;
    const f = { type: 'relation', id: o.id, tags: pick(o.tags), members };
    byKey.set('r' + o.id, f);
    if (members.some(m => m.geometry.some(g => nearCells.has(cellKey(g.lat, g.lon))))) features.push(f);
  }
  relWays.clear();
  console.log(`features: ${lines} lines read, ${features.length} near stations (${elapsed(t0)})`);

  // Route relations, indexed by their stop and platform members
  const routesByMember = new Map();
  let routeCount = 0;
  await eachLine(ROUTES, (line) => {
    const o = parseLine(line);
    if (o.type !== 'r' || !ROUTE_TYPES.includes(o.tags.route)) return;
    // Only stops and platforms are used (core.js buildStation); track ways would make the files 20 times bigger
    const r = { type: 'relation', id: o.id, tags: pick(o.tags),
      members: o.members.filter(m => /^(stop|platform)/.test(m.role))
        .map(m => ({ type: { n: 'node', w: 'way', r: 'relation' }[m.type], ref: m.ref, role: m.role })) };
    routeCount++;
    for (const m of o.members) {
      const k = m.type + m.ref;
      if (!routesByMember.has(k)) routesByMember.set(k, []);
      routesByMember.get(k).push(r);
    }
  });
  console.log(`routes: ${routeCount} (${elapsed(t0)})`);

  // Spatial index of the features
  const grid = new Map();
  const pointsOf = (f) => f.type === 'node' ? [f] : f.type === 'way' ? f.geometry : [].concat(...f.members.map(m => m.geometry));
  for (const f of features) {
    const keys = new Set(pointsOf(f).map(p => cellKey(p.lat, p.lon)));
    for (const k of keys) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(f); }
  }

  // Positions for lookupQuery(): node position, or centre of a way / relation
  const centre = (f) => {
    const pts = pointsOf(f);
    const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
    return { lat: round(lat), lon: round(lon) };
  };

  // Write one file per station
  const osmDir = path.join(OUT, 'osm');
  fs.rmSync(osmDir, { recursive: true, force: true });
  fs.mkdirSync(osmDir, { recursive: true });
  const prepared = new Date(fs.statSync(PBF).mtimeMs).toISOString().slice(0, 10);
  let bytes = 0, withRoutes = 0, missingLookup = 0;

  for (const s of stations) {
    const P = U.projector(s.lat, s.lon);
    const xy = (p) => { const [x, y] = P.xy(p.lat, p.lon); return { x, y }; };
    // Like Overpass "around": any point or segment within the radius
    const within = (f) => {
      const pts = f.type === 'relation' ? f.members.map(m => m.geometry) : [f.type === 'node' ? [f] : f.geometry];
      for (const line of pts) {
        const q = line.map(xy);
        for (let i = 0; i < q.length; i++) {
          if (Math.hypot(q[i].x, q[i].y) <= s.r) return true;
          if (i && segDist(q[i - 1], q[i]) <= s.r) return true;
        }
      }
      return false;
    };
    const seen = new Set(), elements = [];
    for (const k of cellsAround(s.lat, s.lon, s.r)) {
      for (const f of grid.get(k) || []) {
        const key = f.type[0] + f.id;
        if (seen.has(key)) continue;
        seen.add(key);
        if (within(f)) elements.push(f);
      }
    }
    // Routes that stop at one of these stops or platforms
    const routeIds = new Set();
    for (const f of elements) {
      const t = f.tags;
      if (!(isStop(t) || isPlatform(t))) continue;
      for (const r of routesByMember.get(f.type[0] + f.id) || []) {
        if (!routeIds.has(r.id)) { routeIds.add(r.id); elements.push(r); }
      }
    }
    if (routeIds.size) withRoutes++;

    const osm = { elements };
    const need = U.buildStation(osm, s).need;
    const lookup = [];
    for (const k of need) {
      const f = byKey.get(k);
      if (!f) { missingLookup++; continue; }
      const c = f.type === 'node' ? { lat: f.lat, lon: f.lon } : centre(f);
      lookup.push(f.type === 'node' ? { type: 'node', id: f.id, lat: c.lat, lon: c.lon, tags: { name: f.tags.name || '' } }
        : { type: f.type, id: f.id, center: c, tags: { name: f.tags.name || '' } });
    }
    const json = JSON.stringify({ id: s.id, prepared, osm, lookup: { elements: lookup } });
    fs.writeFileSync(path.join(osmDir, s.id + '.json'), json);
    bytes += json.length;
  }

  console.log('\n--- Summary ---');
  console.log(`stations:            ${stations.length} (${withRoutes} with OSM routes)`);
  console.log(`missing lookups:     ${missingLookup}`);
  console.log(`osm/*.json total:    ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`time:                ${elapsed(t0)}`);
}

// Distance from the origin to the segment a–b (local metres)
function segDist(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / l2)) : 0;
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
