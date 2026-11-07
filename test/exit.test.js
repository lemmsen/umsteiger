/*
 * Test for leaving the station: exits and a destination tapped on the map. Run: node test/exit.test.js
 *
 *   P1 (arrival)  x = -100 … +100, y = 0, train eastbound
 *   stair A at x = -90 and stair B at x = +60, both up to the street at y = 20
 *   Entrance at the top of A: "A · Weststraße"; at the top of B only the station's name (not listed)
 *   A tunnel leads from the top of A to (-22, 58); a footway from the top of B to (80, 40)
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

const center = { name: 'Teststadt', lat: 52.5, lon: 13.4, r: 300 };
const P = U.projector(center.lat, center.lon);
const ll = (x, y) => { const [lat, lon] = P.ll(x, y); return { lat, lon }; };
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => ll(x, y)) });
const node = (id, tags, x, y) => Object.assign({ type: 'node', id, tags }, ll(x, y));

const raw = { elements: [
  way(1, { railway: 'platform', ref: '1', train: 'yes' }, [[-100, 0], [100, 0]]),
  way(11, { highway: 'steps' }, [[-90, 1], [-90, 20]]),                // A
  way(12, { highway: 'steps' }, [[60, 1], [60, 20]]),                  // B
  way(31, { highway: 'footway', tunnel: 'yes' }, [[-90, 20], [-22, 58]]),
  way(32, { highway: 'footway' }, [[60, 20], [80, 40]]),
  node(41, { railway: 'subway_entrance', ref: 'A', name: 'Weststraße' }, -90, 20),
  node(42, { railway: 'subway_entrance', name: 'Teststadt' }, 60, 20)
] };

const tt = { id: '1', name: 'Teststadt', prepared: '2026-10-01', lines: [{
  ref: 'S1', type: 'light_rail', platform: Object.assign({ id: 'p1', code: '1' }, ll(0, 1)),
  prev: Object.assign({ id: 'prev', name: 'Westend' }, ll(-2000, 0)), destinations: [], trips: 10, share: 1
}] };

let st = U.buildStation(raw, center);
U.applyLookup(st, { elements: [] });
U.applyTimetable(st, tt);
st = JSON.parse(JSON.stringify(U.finalize(st))); // the station data goes through JSON in the app

assert.strictEqual(st.exits.length, 2, 'both entrances are kept for the map');
const exits = st.targets.filter(t => t.exit);
assert.deepStrictEqual(exits.map(t => t.label), ['Ausgang A · Weststraße'], 'only the exit that has more than the station name');
assert.ok(st.targets.findIndex(t => t.exit) > st.targets.findIndex(t => !t.exit), 'platforms first');

const opt = st.options.find(o => o.ref === 'S1');

// Named exit: stair A, at the rear of an eastbound train
const a = U.recommend(st, opt.key, exits[0].key, {});
assert.strictEqual(a.target.kind, 'exit');
assert.strictEqual(a.method, 'walk');
assert.strictEqual(a.chosen.key, 'w11');
assert.strictEqual(a.chosen.zone, 'hinten');
assert.ok(Math.abs(a.chosen.dist - 38.5) < 0.5, 'just the stairs (19 m × 1.5 + 10 m): ' + a.chosen.dist);

// Point on the map next to the tunnel's end: the tunnel is below the street, so the walk comes from
// the footway at B (89 m across) and not through the tunnel (which would favour A)
const p = U.recommend(st, opt.key, ll(-20, 60), {});
assert.strictEqual(p.target.kind, 'point');
assert.strictEqual(p.method, 'walk');
assert.strictEqual(p.chosen.key, 'w12', 'stair B');
assert.strictEqual(p.chosen.zone, 'vorne');
assert.ok(Math.abs(p.chosen.dist - (38.5 + Math.hypot(80, 40))) < 0.5, 'stairs + straight across: ' + p.chosen.dist);
const end = p.route[p.route.length - 1];
assert.ok(Math.hypot(end[0] + 20, end[1] - 60) < 0.5, 'route ends at the point');
assert.strictEqual(p.tail, Math.round(Math.hypot(80, 40)), 'the straight last part is reported (no ways known there)');
assert.strictEqual(a.tail, 0, 'an exit is part of the network: no straight part');

// How far a point off the network may be reached from other ways than the nearest one: little when a way is
// right at the point (a straight line knows no tracks), more for points far from any way
assert.strictEqual(U.seedSpread(1), 5);
assert.strictEqual(U.seedSpread(12), 12);
assert.strictEqual(U.seedSpread(80), 30);

// Point next to the top of A: only reachable from there once a surface way leads to it
assert.strictEqual(U.recommend(st, opt.key, ll(-95, 30), {}).chosen.key, 'w12', 'no surface way at A: still via B');
const st2 = JSON.parse(JSON.stringify(st));
st2.walk.push({ k: 'walk', p: [[-90, 20], [-100, 30]] });
assert.strictEqual(U.recommend(st2, opt.key, ll(-95, 30), {}).chosen.key, 'w11', 'with a footway at A: via A');

// No point chosen yet
const none = U.recommend(st, opt.key, U.POINT_KEY, {});
assert.strictEqual(none.code, 'needPoint');
assert.ok(none.pl, 'platform for the map');

// Without footways: straight line
const air = U.recommend(Object.assign({}, st, { walk: [] }), opt.key, ll(70, 30), {});
assert.strictEqual(air.method, 'air');
assert.strictEqual(air.chosen.key, 'w12');

console.log('exit.test.js: all checks passed');
