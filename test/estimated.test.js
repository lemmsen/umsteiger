/*
 * Test for platforms mapped only as a point (U Spichernstraße). Run: node test/estimated.test.js
 *
 *   P1 (U1) point at (0, 0), trains from west and east       stair A at x = -40 (west end), B at x = +40
 *   P2 (U2) point at (-60, 40), trains from south and north  stair C at y = 0 (south end), D at y = 85
 *
 *   The platforms cross near the west end of P1 and the south end of P2. Each becomes a segment of
 *   100 m along the direction from its previous stops; the transfer is at the crossing.
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

const center = { name: 'Teststadt', lat: 52.5, lon: 13.4, r: 300 };
const P = U.projector(center.lat, center.lon);
const ll = (x, y) => { const [lat, lon] = P.ll(x, y); return { lat, lon }; };
const node = (id, tags, x, y) => Object.assign({ type: 'node', id, tags }, ll(x, y));
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => ll(x, y)) });

const raw = { elements: [
  node(1, { railway: 'platform', ref: '1', subway: 'yes' }, 0, 0),
  node(2, { railway: 'platform', ref: '2', subway: 'yes' }, -60, 40),
  way(11, { highway: 'steps' }, [[-40, 3], [-40, 20]]),   // A
  way(12, { highway: 'steps' }, [[40, 3], [40, 20]]),     // B
  way(21, { highway: 'steps' }, [[-63, 0], [-80, 0]]),    // C
  way(22, { highway: 'steps' }, [[-63, 85], [-80, 85]]),  // D
  way(23, { highway: 'steps' }, [[300, 0], [320, 0]])     // far away: no access of either platform
] };

const line = (ref, code, px, py, prevName, x, y) => ({
  ref, type: 'subway', platform: Object.assign({ id: 'p' + code, code }, ll(px, py)),
  prev: Object.assign({ id: prevName, name: prevName }, ll(x, y)), destinations: [], trips: 10, share: 0.5
});
const tt = { id: '1', name: 'Teststadt', prepared: '2026-10-16', lines: [
  line('U1', '1', 0, 0, 'Westend', -1000, 0), line('U1', '1', 0, 0, 'Ostend', 1000, 0),
  line('U2', '2', -60, 40, 'Südend', -60, -1000), line('U2', '2', -60, 40, 'Nordend', -60, 1000)
] };

let st = U.buildStation(raw, center);
U.applyLookup(st, { elements: [] });
U.applyTimetable(st, tt);
st = U.finalize(st);
st = JSON.parse(JSON.stringify(st)); // the app caches the station as JSON
assert.ok(!('spare' in st), 'no left-over candidates in the cached station');

const p1 = st.platforms.n1, p2 = st.platforms.n2;
assert.ok(p1.estimated && p2.estimated, 'both platforms are estimated');
assert.strictEqual(p1.lines[0].length, 2, 'point became a segment');
assert.ok(Math.abs(p1.ax.tmax - p1.ax.tmin - 100) < 0.5, 'typical subway length');
assert.ok(Math.abs(p1.ax.u[1]) < 0.01, 'P1 runs east–west like its trains');
assert.ok(Math.abs(p2.ax.u[0]) < 0.01, 'P2 runs north–south like its trains');
const accessOf = (pl) => st.access.filter(a => a.platform === pl.key).map(a => a.key).sort();
assert.deepStrictEqual(accessOf(p1), ['w11', 'w12'], 'stairs A and B at P1');
assert.deepStrictEqual(accessOf(p2), ['w21', 'w22'], 'stairs C and D at P2');

const rec = (ref, prev, target) => U.recommend(st, st.options.find(o => o.ref === ref && o.prevNames[0] === prev).key, target, {});
const r1 = rec('U1', 'Westend', 'n2');
assert.ok(r1.estimated, 'marked as estimated');
assert.strictEqual(r1.chosen.key, 'w11', 'transfer at the crossing');
assert.strictEqual(r1.chosen.zone, 'hinten', 'eastbound train: west end is the rear');
assert.strictEqual(rec('U1', 'Ostend', 'n2').chosen.zone, 'vorne', 'westbound train: west end is the front');
const r2 = rec('U2', 'Südend', 'n1');
assert.strictEqual(r2.chosen.key, 'w21', 'transfer at the crossing');
assert.strictEqual(r2.chosen.zone, 'hinten', 'northbound train: south end is the rear');
assert.strictEqual(rec('U2', 'Nordend', 'n1').chosen.zone, 'vorne', 'southbound train: south end is the front');

// A platform mapped as an area stays as it is
const raw2 = { elements: raw.elements.map(e => e.id === 1
  ? way(1, { railway: 'platform', ref: '1', subway: 'yes' }, [[-50, 0], [50, 0]]) : e) };
let st2 = U.buildStation(raw2, center);
U.applyLookup(st2, { elements: [] });
U.applyTimetable(st2, tt);
st2 = U.finalize(st2);
assert.ok(!st2.platforms.w1.estimated, 'mapped platform is not estimated');
const r3 = U.recommend(st2, st2.options.find(o => o.ref === 'U1' && o.prevNames[0] === 'Westend').key, 'n2', {});
assert.ok(r3.estimated, 'target platform estimated: still marked');

console.log('estimated.test.js: OK');
