#!/usr/bin/env node
/*
 * Checks the live data of server.py against a fixed set of cases (see PLAN-TRANSITOUS.md):
 * journeys with the advice at every change (computed with core.js as the journey page does),
 * departures and arrivals – and counts per kind of transport how often track, real time and messages come.
 *
 *   python3 server.py 8765 127.0.0.1 &
 *   node tools/check-live.js [--base http://localhost:8765] [--when 2026-11-09T07:45] [--journeys 3]
 *                            [--near lat,lon] [--out report.json] [cases.json …]
 *
 * Default cases: tools/live-cases.json, plus tools/live-cases.local.json if it exists (private, not in Git).
 * Needs the prepared station data in data/ (tools/prepare-gtfs.js, tools/prepare-osm.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const U = require('../core.js');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args.splice(i, 2)[1] : def; };
const BASE = opt('base', 'http://localhost:8765');
const WHEN = opt('when', '');
const PER_CASE = Number(opt('journeys', 3));
const OUT = opt('out', '');
// The app prefers places near home or the last journey; here: the default station of the app (Gesundbrunnen)
const NEAR = opt('near', '52.5486,13.3886').split(',');
const files = args.length ? args : ['live-cases.json', 'live-cases.local.json']
  .map(f => path.join(__dirname, f)).filter(f => fs.existsSync(f));
const cases = { journeys: [], departures: [], arrivals: [] };
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const k of Object.keys(cases)) cases[k].push(...(c[k] || []));
}

// ---------- server ----------

const timing = {};
async function api(p) {
  const t0 = Date.now();
  const res = await fetch(BASE + '/api/' + p);
  const ep = p.split('?')[0];
  (timing[ep] = timing[ep] || []).push(Date.now() - t0);
  if (!res.ok) throw new Error(`${ep}: HTTP ${res.status}`);
  return res.json();
}
const whenParam = () => WHEN ? '&when=' + encodeURIComponent(WHEN) : '';

// "lat,lon" stays, otherwise the first hit of the place search (a station when kind is 'station')
async function place(q, kind) {
  if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(q)) return { id: q, name: q, kind: 'point' };
  const { places } = await api('places?q=' + encodeURIComponent(q) + (NEAR.length === 2 ? `&lat=${NEAR[0]}&lon=${NEAR[1]}` : ''));
  const hit = places.find(p => !kind || p.kind === kind) || null;
  if (!hit) throw new Error('place not found: ' + q);
  return hit;
}

// ---------- station models (as StationData.build, from the prepared files) ----------

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/index.json'), 'utf8')).stations;
const models = new Map();
function model(id) {
  if (models.has(id)) return models.get(id);
  let st = null;
  try {
    const read = (kind, i) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', kind, i + '.json'), 'utf8'));
    let tt = read('st', id);
    if (tt.mergedInto) { st = model(tt.mergedInto); models.set(id, st); return st; }
    const pre = read('osm', id);
    let s = U.buildStation(pre.osm, { name: tt.name, lat: tt.lat, lon: tt.lon, r: tt.r });
    if (s.need.length) U.applyLookup(s, pre.lookup);
    U.applyTimetable(s, tt);
    st = Object.assign(U.finalize(s), { id });
  } catch (e) { st = null; }
  models.set(id, st);
  return st;
}

// ---------- measures ----------

const ZONE = { vorne: 'front', Mitte: 'middle', hinten: 'rear' };
const stats = {};   // area -> product -> { n, track, rt, late, notes, cancelled }
function count(area, product, item) {
  const a = stats[area] = stats[area] || {};
  const s = a[product] = a[product] || { n: 0, track: 0, rt: 0, late: 0, notes: 0, cancelled: 0 };
  s.n++;
  if (item.track) s.track++;
  if (item.rtTime) s.rt++;
  if (item.rtTime && item.time && new Date(item.rtTime) - new Date(item.time) >= 60000) s.late++;
  if (item.notes && item.notes.length) s.notes++;
  if (item.cancelled) s.cancelled++;
}
const adviceStats = { change: {}, leave: {} };
const tally = (kind, code) => { adviceStats[kind][code] = (adviceStats[kind][code] || 0) + 1; };

const hm = (iso) => iso ? iso.slice(11, 16) : '--:--';
const late = (s) => s.rtTime && s.time ? Math.round((new Date(s.rtTime) - new Date(s.time)) / 60000) : null;
const stopText = (s) => {
  const d = late(s);
  return `${hm(s.time)}${d === null ? ' (no rt)' : d ? ` +${d}` : ' +0'} ${s.name || '?'}${s.track ? ' Gl. ' + s.track : ''}${s.rtTrack ? ' → ' + s.rtTrack : ''}`;
};

function adviceText(stop) {
  const a = stop.arrive;
  const m = U.matchStation(index, a.to.lat, a.to.lon, a.to.name);
  if (!m) return { code: 'noStation', text: `no station in data/index.json for "${a.to.name}"` };
  const st = model(m.id);
  if (!st) return { code: 'noModel', text: `no prepared data for ${m.name}` };
  if (stop.kind === 'leave' && !stop.point) return { code: 'endsHere', text: `${m.name}: journey ends in the station (exit to choose)` };
  const adv = U.transferAdvice(st, stop, {});
  if (adv.code) return { code: adv.code, text: `${m.name}: ${adv.code}` };
  const r = adv.rec;
  if (r.error) return { code: r.code || 'error', text: `${m.name}: ${r.code || r.error}` };
  const c = r.chosen;
  const zones = [c.zone].concat(r.equal.map(e => e.zone)).map(z => ZONE[z]).join(' or ');
  const sec = c.section ? ` · section ${c.section}` : '';
  return { code: 'ok', zone: ZONE[c.zone], text: `${m.name}: ${zones} · ${c.kind}${sec} · ${Math.round(c.dist)} m ${r.method}` +
    `${adv.ambiguous ? ' (unsure)' : ''}${r.estimated ? ' (estimated platform)' : ''}` };
}

const report = { at: new Date().toISOString(), base: BASE, when: WHEN || null, journeys: [], departures: [], arrivals: [] };
const out = (s) => process.stdout.write(s + '\n');

async function checkJourney(c) {
  out(`\n=== ${c.name}`);
  const rep = { name: c.name, journeys: [] };
  report.journeys.push(rep);
  try {
    const from = await place(c.from, c.fromKind), to = await place(c.to, c.toKind);
    out(`    ${from.name} → ${to.name}`);
    const res = await api(`journeys?from=${encodeURIComponent(from.id)}&to=${encodeURIComponent(to.id)}${whenParam()}`);
    rep.found = res.journeys.length;
    if (!res.journeys.length) out('    NO JOURNEY');
    for (const j of res.journeys.slice(0, PER_CASE)) {
      const transit = j.legs.filter(l => l.mode === 'transit');
      const r = { lines: transit.map(l => l.line), duration: j.duration, changes: j.changes, advice: [] };
      out(`  - ${Math.round(j.duration / 60)} min, ${j.changes} changes: ${r.lines.join(' → ')}`);
      for (const l of j.legs) {
        if (l.mode === 'walk') { out(`      walk ${Math.round(l.distance || 0)} m${l.from.lat == null || l.to.lat == null ? ' (no position)' : ''}`); continue; }
        out(`      ${l.line} [${l.product}] → ${l.direction || '?'}${l.cancelled ? ' CANCELLED' : ''}${l.notes.length ? ` · ${l.notes.length} notes` : ''}` +
          ` · shape ${l.shape ? l.shape.points.length : 0} pts`);
        out(`        ${stopText(l.from)}  →  ${stopText(l.to)}`);
        count('legs', l.product, Object.assign({}, l.from, { notes: l.notes, cancelled: l.cancelled }));
        count('legs', l.product, l.to);
      }
      for (const stop of U.journeyStops(j)) {
        const a = adviceText(stop);
        const expect = (c.expect || []).find(e => a.text.toLowerCase().includes(e.at.toLowerCase()) && (!e.line || e.line === stop.arrive.line));
        const verdict = expect && expect.zone ? (expect.zone === a.zone ? ' ✓ as with bahn.de' : ` ✗ bahn.de: ${expect.zone}`) : '';
        out(`      ${stop.kind === 'change' ? 'CHANGE' : 'LEAVE '} ${a.text}${verdict}`);
        tally(stop.kind, a.code);
        r.advice.push(Object.assign({ kind: stop.kind }, a));
      }
      rep.journeys.push(r);
    }
  } catch (e) { out('    ERROR ' + e.message); rep.error = e.message; }
}

async function checkDepartures(c) {
  out(`\n=== departures ${c.name}`);
  try {
    const p = await place(c.station, 'station');
    const { departures } = await api(`departures?eva=${encodeURIComponent(p.eva)}${whenParam()}`);
    out(`    ${p.name} (${p.eva}): ${departures.length} departures`);
    for (const d of departures) {
      count('departures', d.product, d);
      out(`      ${stopText(Object.assign({}, d, { name: d.line + ' → ' + d.direction }))}${d.cancelled ? ' CANCELLED' : ''}`);
    }
    report.departures.push({ name: c.name, n: departures.length });
  } catch (e) { out('    ERROR ' + e.message); report.departures.push({ name: c.name, error: e.message }); }
}

// Arrivals as in the station view: the station's stop id, the trains, and for each the platform and the
// direction it comes from (/api/train) – what "My train (live)" needs
async function checkArrivals(c) {
  out(`\n=== arrivals ${c.name}`);
  const rep = { name: c.name, n: 0, platform: 0, approach: 0 };
  report.arrivals.push(rep);
  try {
    const m = index.find(r => String(r[0]) === String(c.id));
    const ev = await api(`eva?q=${encodeURIComponent(c.q || m[1])}&lat=${m[2]}&lon=${m[3]}`);
    if (!ev.eva) { out('    no stop id'); rep.error = 'eva'; return; }
    const { arrivals } = await api(`arrivals?eva=${encodeURIComponent(ev.eva)}${whenParam()}`);
    const st = model(c.id);
    out(`    ${ev.name} (${ev.eva}): ${arrivals.length} arrivals`);
    for (const a of arrivals.slice(0, c.max || 12)) {
      rep.n++;
      count('arrivals', a.product, { time: a.time, rtTime: a.rtTime, track: a.platform });
      const tr = await api(`train?journeyId=${encodeURIComponent(a.journeyId)}&eva=${encodeURIComponent(ev.eva)}` +
        `&stop=${encodeURIComponent(a.stop || '')}&lat=${m[2]}&lon=${m[3]}`).catch(e => ({ error: e.message }));
      if (a.platform) rep.platform++;
      if (tr.approach || tr.prev) rep.approach++;
      // Platform as the station view finds it: by track, else line and direction
      const plat = st && !tr.error ? U.findPlatform(st, { product: a.product, line: a.name, track: tr.platform || a.platform, from: tr.prev }) : null;
      const dir = plat ? U.liveDirection(st, plat, tr.approach || tr.prev, tr.prev && tr.prev.name) : null;
      out(`      ${stopText({ time: a.time, rtTime: a.rtTime, name: `${a.name} from ${a.from}`, track: a.platform })}` +
        ` · prev ${tr.prev ? tr.prev.name : '?'} · platform ${plat ? U.platformLabel(st.platforms[plat]) : 'NOT FOUND'}` +
        `${dir ? '' : plat ? ' · direction unknown' : ''}${tr.error ? ' · ' + tr.error : ''}`);
    }
  } catch (e) { out('    ERROR ' + e.message); rep.error = e.message; }
}

(async () => {
  for (const c of cases.journeys) await checkJourney(c);
  for (const c of cases.departures) await checkDepartures(c);
  for (const c of cases.arrivals) await checkArrivals(c);

  out('\n=== summary');
  const pct = (a, n) => n ? Math.round(100 * a / n) + '%' : '-';
  for (const [area, byProduct] of Object.entries(stats)) {
    out(`  ${area}: product   n  track  real-time  late≥1  notes  cancelled`);
    for (const [p, s] of Object.entries(byProduct).sort()) {
      out(`    ${p.padEnd(10)} ${String(s.n).padStart(4)}  ${pct(s.track, s.n).padStart(5)}  ${pct(s.rt, s.n).padStart(9)}  ${pct(s.late, s.n).padStart(6)}  ${pct(s.notes, s.n).padStart(5)}  ${pct(s.cancelled, s.n).padStart(9)}`);
    }
  }
  for (const kind of ['change', 'leave']) {
    const t = adviceStats[kind], n = Object.values(t).reduce((a, b) => a + b, 0);
    out(`  advice at ${kind}: ${n} – ` + Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  }
  const noAnswer = report.journeys.filter(r => !r.found).map(r => r.name);
  if (noAnswer.length) out('  no journey: ' + noAnswer.join('; '));
  for (const [ep, ms] of Object.entries(timing)) {
    ms.sort((a, b) => a - b);
    out(`  ${ep}: ${ms.length} requests, median ${ms[ms.length >> 1]} ms, max ${ms[ms.length - 1]} ms`);
  }
  Object.assign(report, { stats, advice: adviceStats, timing });
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
})();
