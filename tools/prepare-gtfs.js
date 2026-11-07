#!/usr/bin/env node
/*
 * Umsteiger – prepares timetable data (GTFS) for the app.
 *
 * Reads the GTFS feeds from gtfs.de (fv = long distance, rv = regional incl. S-Bahn,
 * nv = local incl. U-Bahn), unzipped into <rawdata>/fv, <rawdata>/rv, <rawdata>/nv.
 * For every station it records which lines arrive at which platform and where they
 * come from (previous stop), and writes:
 *   <out>/index.json        list of all stations (for search)
 *   <out>/st/<id>.json      lines, platforms and previous stops per station
 *
 * Usage: node tools/prepare-gtfs.js [rawdata] [out]
 * No dependencies; large files are streamed line by line.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const U = require('../core.js');

const ROOT = path.join(__dirname, '..');
const RAW = path.resolve(process.argv[2] || path.join(ROOT, 'rawdata'));
const OUT = path.resolve(process.argv[3] || path.join(ROOT, 'data'));
const FEEDS = ['fv', 'rv', 'nv'];

const MIN_TRIPS = 2;        // drop line/platform/previous-stop combinations rarer than this …
const MIN_SHARE = 0.02;     // … or rarer than this share of the line's arrivals at the station
const MAX_DESTINATIONS = 3; // destinations listed per combination
const RADIUS_MIN = 250;     // m: search radius for the OSM query
const RADIUS_MAX = 800;
const RADIUS_MARGIN = 150;  // m: added to the farthest platform

// ---------- CSV ----------

// Splits one CSV line; handles quoted fields with commas and doubled quotes
function splitCsv(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Calls onRow(fields, col) for every data row; col maps column name -> index.
// filter(line) may skip lines cheaply before they are parsed.
async function readCsv(file, onRow, filter) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let col = null;
  for await (let line of rl) {
    if (!col) {
      col = {};
      splitCsv(line.replace(/^﻿/, '')).forEach((name, i) => { col[name.trim()] = i; });
      continue;
    }
    if (!line || (filter && !filter(line))) continue;
    onRow(splitCsv(line), col);
  }
}

// ---------- Helpers ----------

// GTFS route_type -> type names used by the app (same as OSM route=*)
function lineType(routeType, ref) {
  const t = Number(routeType);
  if (t === 1 || (t >= 400 && t <= 405)) return 'subway';
  if (t === 2 || (t >= 100 && t <= 117)) return /^S\d/.test(ref) || t === 109 ? 'light_rail' : 'train';
  return null; // tram, bus, ferry … not used yet
}

function distance(a, b) {
  const k = Math.PI / 180;
  const x = (b.lon - a.lon) * k * Math.cos((a.lat + b.lat) / 2 * k);
  const y = (b.lat - a.lat) * k;
  return Math.hypot(x, y) * 6371000;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// Type letters in index.json: S = S-Bahn, U = U-Bahn, Z = other trains
const TYPE_LETTERS = [['light_rail', 'S'], ['subway', 'U'], ['train', 'Z']];

// Other names of a station that add searchable words (skip platform and direction labels)
const words = (n) => n.toLowerCase().split(/[^a-z0-9äöüß]+/).filter(Boolean);
function searchAliases(name, names) {
  const known = new Set(words(name));
  const out = [];
  for (const n of names) {
    if (n.length > 40 || /gleis|\bri\.|richtung|bstg|steig|\bvon\b/i.test(n)) continue;
    const add = words(n).filter(w => !known.has(w));
    if (!add.length) continue;
    add.forEach(w => known.add(w));
    out.push(n);
  }
  return out.join('|');
}
const topKeys = (counts, n) => [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);

function elapsed(t0) { return ((Date.now() - t0) / 1000).toFixed(0) + ' s'; }

// ---------- Merging parts of one station ----------

const MERGE_DIST = 300;   // m: parts of one station lie at most this far apart …
// … and share a word of their name that is not generic or a city name
const GENERIC_WORDS = new Set(['bhf', 'bf', 'station', 'gleis', 'tief', 'oben', 'flixtrain']);

// Groups of station ids that belong together (union-find over nearby stations with similar names)
function mergeGroups(built) {
  const ids = [...built.keys()];
  const nameWords = (n) => U.normalizeName(n.replace(/\([^)]*\)/g, ' ')).split(/[^a-z0-9]+/)
    .filter(w => w.length > 1 && !GENERIC_WORDS.has(w));

  // City-like words: "Hamburg, …" or the first word of many station names ("Dortmund …")
  const firstCount = new Map();
  for (const id of ids) {
    const w = nameWords(built.get(id).s.name)[0];
    if (w) firstCount.set(w, (firstCount.get(w) || 0) + 1);
  }
  const words = new Map();
  for (const id of ids) {
    const n = built.get(id).s.name, city = /^([^,]+),/.exec(n);
    const cityWords = city ? nameWords(city[1]) : [];
    words.set(id, new Set(nameWords(n).filter(w => !cityWords.includes(w) && !(firstCount.get(w) >= 5 && w !== 'hbf'))));
  }

  const parent = new Map(ids.map(id => [id, id]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };

  const grid = new Map(), cell = (v) => Math.floor(v / 0.01);
  for (const id of ids) {
    const s = built.get(id).s, k = cell(s.lat) + ':' + cell(s.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(id);
  }
  for (const id of ids) {
    const s = built.get(id).s, a = cell(s.lat), b = cell(s.lon);
    for (let x = a - 1; x <= a + 1; x++) for (let y = b - 1; y <= b + 1; y++) {
      for (const other of grid.get(x + ':' + y) || []) {
        if (other <= id) continue;
        const o = built.get(other).s;
        if (distance(s, o) > MERGE_DIST) continue;
        if (![...words.get(id)].some(w => words.get(other).has(w))) continue;
        parent.set(find(other), find(id));
      }
    }
  }
  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  return [...groups.values()];
}

// ---------- Main ----------

async function main() {
  const t0 = Date.now();
  for (const f of FEEDS) {
    if (!fs.existsSync(path.join(RAW, f, 'stop_times.txt'))) {
      throw new Error(`${path.join(RAW, f)} not found – unzip the feeds first (see PLAN-GTFS.md)`);
    }
  }

  // Stops are shared across the three feeds (same ids)
  const stops = new Map();
  for (const f of FEEDS) {
    await readCsv(path.join(RAW, f, 'stops.txt'), (r, c) => {
      const id = r[c.stop_id];
      if (stops.has(id)) return;
      stops.set(id, {
        name: r[c.stop_name], lat: Number(r[c.stop_lat]), lon: Number(r[c.stop_lon]),
        parent: r[c.parent_station] || '', code: r[c.platform_code] || ''
      });
    });
  }
  const stationOf = (id) => (stops.get(id) && stops.get(id).parent) || id;
  console.log(`stops: ${stops.size} (${elapsed(t0)})`);

  // key "station|ref|type|platformStop|prevStation" -> { trips, prevStop, dests }
  const agg = new Map();
  let tripCount = 0, rowCount = 0;

  for (const f of FEEDS) {
    const dir = path.join(RAW, f);

    const routes = new Map();
    await readCsv(path.join(dir, 'routes.txt'), (r, c) => {
      const ref = (r[c.route_short_name] || r[c.route_long_name] || '').trim();
      const type = lineType(r[c.route_type], ref);
      if (ref && type) routes.set(r[c.route_id], { ref, type });
    });

    const trips = new Map();
    await readCsv(path.join(dir, 'trips.txt'), (r, c) => {
      const route = routes.get(r[c.route_id]);
      if (route) trips.set(r[c.trip_id], route);
    });
    console.log(`${f}: ${routes.size} rail routes, ${trips.size} trips (${elapsed(t0)})`);

    // stop_times is ordered by trip and stop_sequence (checked for the gtfs.de feeds)
    let curTrip = null, rows = [];
    const flush = () => {
      const route = trips.get(curTrip);
      if (route && rows.length > 1) {
        tripCount++;
        const last = stops.get(rows[rows.length - 1].stop);
        const dest = last ? stops.get(stationOf(rows[rows.length - 1].stop)) || last : null;
        for (let i = 1; i < rows.length; i++) {
          if (rows[i].noDropOff) continue; // nobody can get off here
          const stop = rows[i].stop, prevStop = rows[i - 1].stop;
          const station = stationOf(stop), prevStation = stationOf(prevStop);
          if (station === prevStation) continue;
          const key = [station, route.ref, route.type, stop, prevStation].join('|');
          let a = agg.get(key);
          if (!a) agg.set(key, a = { trips: 0, prevStop, dests: new Map() });
          a.trips++;
          if (dest && i < rows.length - 1) a.dests.set(dest.name, (a.dests.get(dest.name) || 0) + 1);
        }
      }
      rows = [];
    };

    await readCsv(path.join(dir, 'stop_times.txt'), (r, c) => {
      const trip = r[c.trip_id];
      if (trip !== curTrip) { flush(); curTrip = trip; }
      rows.push({ stop: r[c.stop_id], noDropOff: r[c.drop_off_type] === '1' });
      rowCount++;
    }, (line) => trips.has(line.slice(0, line.indexOf(','))));
    flush();
    console.log(`${f}: stop_times done, ${rowCount} rows used so far (${elapsed(t0)})`);
  }

  // Group by station and drop rare combinations
  const byStation = new Map();
  for (const [key, a] of agg) {
    const [station, ref, type, stop, prevStation] = key.split('|');
    if (!byStation.has(station)) byStation.set(station, []);
    byStation.get(station).push({ ref, type, stop, prevStation, ...a });
  }

  const prepared = new Date().toISOString().slice(0, 10);
  const stDir = path.join(OUT, 'st');
  fs.rmSync(stDir, { recursive: true, force: true });
  fs.mkdirSync(stDir, { recursive: true });

  // Lines per station
  const built = new Map(); // station id -> { s, lines }
  let lineCount = 0, noCode = 0, bytes = 0;
  for (const [station, entries] of byStation) {
    const s = stops.get(station);
    if (!s) continue;

    const totals = new Map();
    for (const e of entries) totals.set(e.ref + '|' + e.type, (totals.get(e.ref + '|' + e.type) || 0) + e.trips);

    const lines = [];
    for (const e of entries) {
      const total = totals.get(e.ref + '|' + e.type);
      if (e.trips < MIN_TRIPS || e.trips < total * MIN_SHARE) continue;
      const p = stops.get(e.stop), prev = stops.get(e.prevStop), prevSt = stops.get(e.prevStation) || prev;
      if (!p || !prev) continue;
      lines.push({
        ref: e.ref, type: e.type,
        platform: { id: e.stop, code: p.code, lat: round(p.lat, 6), lon: round(p.lon, 6) },
        prev: { id: e.prevStation, name: prevSt.name, lat: round(prev.lat, 6), lon: round(prev.lon, 6) },
        destinations: topKeys(e.dests, MAX_DESTINATIONS),
        trips: e.trips, share: round(e.trips / total, 2)
      });
    }
    if (lines.length) built.set(station, { s, lines });
  }

  // Large stations are split into several parts in the timetable (Hamburg Hbf, "HBF/Kirchenallee",
  // "Hauptbahnhof Nord/Süd"); merge them, so changing between the parts works
  const groups = mergeGroups(built);

  const index = [];
  let mergedParts = 0;
  for (const members of groups) {
    // Main part: the one with the most lines; its id, name and position are used
    members.sort((a, b) => built.get(b).lines.length - built.get(a).lines.length);
    const station = members[0], s = built.get(station).s;
    const inGroup = new Set(members);
    let lines = [];
    for (const m of members) lines = lines.concat(built.get(m).lines.filter(l => !inGroup.has(l.prev.id)));
    if (!lines.length) continue;
    lines.sort((a, b) => a.type.localeCompare(b.type) || a.ref.localeCompare(b.ref, 'de', { numeric: true }) ||
      a.platform.code.localeCompare(b.platform.code, 'de', { numeric: true }) || b.trips - a.trips);
    lineCount += lines.length;
    noCode += lines.filter(l => !l.platform.code).length;

    // Radius: cover all platforms used by these lines, plus a margin for stairs and exits
    const center = { lat: s.lat, lon: s.lon };
    let far = 0;
    for (const l of lines) far = Math.max(far, distance(center, l.platform));
    const r = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.ceil((far + RADIUS_MARGIN) / 50) * 50));

    const names = [...new Set(members.slice(1).map(m => built.get(m).s.name)
      .concat(lines.map(l => stops.get(l.platform.id).name)))].filter(n => n !== s.name);
    const types = TYPE_LETTERS.filter(([t]) => lines.some(l => l.type === t)).map(([, c]) => c).join('');
    const doc = { id: station, name: s.name, names, parts: members.slice(1), lat: round(s.lat, 6), lon: round(s.lon, 6),
      r, prepared, lines };
    const json = JSON.stringify(doc);
    fs.writeFileSync(path.join(stDir, station + '.json'), json);
    bytes += json.length;
    // Merged parts point to the main part (old links and "recently used" entries)
    for (const m of members.slice(1)) {
      fs.writeFileSync(path.join(stDir, m + '.json'), JSON.stringify({ id: m, mergedInto: station }));
      mergedParts++;
    }
    const refCount = new Set(lines.map(l => l.ref)).size;
    index.push([station, s.name, round(s.lat, 5), round(s.lon, 5), types, refCount, searchAliases(s.name, names)]);
  }

  index.sort((a, b) => a[1].localeCompare(b[1], 'de'));
  const indexJson = JSON.stringify({
    prepared, source: 'DELFI e.V. / gtfs.de, CC BY 4.0',
    fields: ['id', 'name', 'lat', 'lon', 'types', 'lines', 'aliases'], stations: index
  });
  fs.writeFileSync(path.join(OUT, 'index.json'), indexJson);

  console.log('\n--- Summary ---');
  console.log(`trips used:          ${tripCount}`);
  console.log(`stations:            ${index.length} (${mergedParts} parts merged into others)`);
  console.log(`line entries:        ${lineCount} (${noCode} without platform code)`);
  console.log(`index.json:          ${(indexJson.length / 1024).toFixed(0)} KB`);
  console.log(`st/*.json total:     ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`time:                ${elapsed(t0)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
