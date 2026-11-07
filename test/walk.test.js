/*
 * Test for walking routes. Run: node test/walk.test.js
 *
 *   P1 (arrival)  x = -100 … +100, y = 0     stair A at x = -90, stair B at x = +60 (both go north)
 *   P2 (target)   x =  -60 …  +60, y = -30   stair C at x = -50 (goes south)
 *
 *   Straight line: B is closer to P2 (32 m vs. 42 m).
 *   Footways: only A is connected to C (around the west end); B ends at a dead end.
 *   -> walking route must recommend A.
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

const center = { name: 'Teststadt', lat: 52.5, lon: 13.4, r: 300 };
const P = U.projector(center.lat, center.lon);
const ll = (x, y) => { const [lat, lon] = P.ll(x, y); return { lat, lon }; };
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => ll(x, y)) });

const raw = { elements: [
  way(1, { railway: 'platform', ref: '1', train: 'yes' }, [[-100, 0], [100, 0]]),
  way(2, { railway: 'platform', ref: '2', train: 'yes' }, [[-60, -30], [60, -30]]),
  way(11, { highway: 'steps' }, [[-90, 1], [-90, 20]]),               // A: ends 1 m off the platform (snapped)
  way(12, { highway: 'steps' }, [[60, 1], [60, 20]]),                 // B
  way(21, { highway: 'steps' }, [[-50, -31], [-50, -50]]),            // C
  way(31, { highway: 'footway' }, [[-90, 20], [-130, 20], [-130, -50], [-50, -50]]), // A -> C
  way(32, { highway: 'footway' }, [[60, 20], [80, 40]]),               // B -> dead end
  way(13, { highway: 'steps', access: 'no' }, [[0, 1], [0, 20]])       // closed stairs (Eberswalde 4/5)
] };

const tt = { id: '1', name: 'Teststadt', prepared: '2026-10-01', lines: [{
  ref: 'S1', type: 'light_rail', platform: Object.assign({ id: 'p1', code: '1' }, ll(0, 1)),
  prev: Object.assign({ id: 'prev', name: 'Westend' }, ll(-2000, 0)), destinations: [], trips: 10, share: 1
}] };

let st = U.buildStation(raw, center);
U.applyLookup(st, { elements: [] });
U.applyTimetable(st, tt);
st = U.finalize(st);
// Simulate the cache: the station data goes through JSON in the app
st = JSON.parse(JSON.stringify(st));

const opt = st.options.find(o => o.ref === 'S1');
const r = U.recommend(st, opt.key, 'w2', {});
assert.strictEqual(r.method, 'walk', 'uses the footway network');
assert.ok(!r.cands.some(c => c.key === 'w13'), 'closed stairs (access=no) are not offered');
assert.strictEqual(r.chosen.key, 'w11', 'stair A, although B is closer in a straight line');
assert.strictEqual(r.chosen.zone, 'hinten', 'A is at the rear end for an eastbound train');
const b = r.cands.find(c => c.key === 'w12');
assert.ok(b.dist > r.chosen.dist + 100, 'B means walking along the platform to A');
assert.ok(r.chosen.dist > 250 && r.chosen.dist < 290, 'stairs 2 × 38.5 m + footway 190 m: ' + r.chosen.dist);
assert.ok(Array.isArray(r.route) && r.route.length > 3, 'route for the map');

// Elevators only: no route (all connections are stairs) -> straight line
const lift = U.recommend(st, opt.key, 'w2', { liftOnly: true });
assert.ok(lift.error, 'no elevator at all');

// Without footways: straight line as before
const st2 = Object.assign({}, st, { walk: [] });
const r2 = U.recommend(st2, opt.key, 'w2', {});
assert.strictEqual(r2.method, 'air');
assert.strictEqual(r2.chosen.key, 'w12', 'straight line picks B');

// ---------- Levels and stairs at the end of a corridor (modelled on Berlin Gesundbrunnen) ----------
//
//   Q1 (arrival, level -1)  x = -100 … +100, y = 0
//   Q2 (target,  level -3)  x =  -60 …  +60, y = -30
//   Real way:   corridor (level -1) from the west end of Q1, 15 m long, then stairs down (-1;-3), then a
//               footway (level -3) to Q2. The stairs are too far from Q1 to count as its access by distance.
//   Trap:       stair T up to the street (level -1;0) and a street footway (level 0) that ends 1.5 m beside the
//               end of a short level -3 footway on Q2 – three floors apart, must not be joined.
const raw3 = { elements: [
  way(1, { railway: 'platform', ref: '1', train: 'yes', level: '-1' }, [[-100, 0], [100, 0]]),
  way(2, { railway: 'platform', ref: '2', train: 'yes', level: '-3' }, [[-60, -30], [60, -30]]),
  way(41, { highway: 'footway', level: '-1', indoor: 'yes' }, [[-100, 0], [-115, 0]]),
  way(42, { highway: 'steps', level: '-1;-3', indoor: 'yes' }, [[-115, 0], [-115, -30]]),
  way(43, { highway: 'footway', level: '-3', indoor: 'yes' }, [[-115, -30], [-60, -30]]),
  way(51, { highway: 'steps', level: '-1;0' }, [[60, 1], [60, 20]]),
  way(52, { highway: 'footway', level: '0' }, [[60, 20], [0, 20], [0, -28.5]]),
  way(53, { highway: 'footway', level: '-3', indoor: 'yes' }, [[0, -30], [0, -29.9]])
] };
let st3 = U.buildStation(raw3, center);
U.applyLookup(st3, { elements: [] });
U.applyTimetable(st3, tt);
st3 = JSON.parse(JSON.stringify(U.finalize(st3)));
const opt3 = st3.options.find(o => o.ref === 'S1');
const r3 = U.recommend(st3, opt3.key, 'w2', {});
assert.strictEqual(r3.method, 'walk');
assert.strictEqual(r3.chosen.key, 'w42', 'stairs at the end of the corridor are an access point of Q1');
assert.strictEqual(r3.chosen.zone, 'hinten', 'the corridor leaves the platform at its west (rear) end');
assert.ok(Math.abs(r3.chosen.dist - (15 + 30 * 1.5 + 10 + 55)) < 3, 'corridor + stairs + footway: ' + r3.chosen.dist);
const trap = r3.cands.find(c => c.key === 'w51');
assert.ok(trap.dist > 250, 'no shortcut through the ceiling (street footway above the platform): ' + trap.dist);

// ---------- Terminus: level access at the head end, direction from the buffer stops (München Hbf) ----------
//
//   T1 (arrival) and T2 (target): level 0, x = -100 … +100, 20 m apart; the tracks end at the east end
//   (buffer stops), where a concourse footway joins the two platforms. No stairs, no lifts.
//   The previous stop lies to the EAST (like Rosenheim for München): the usual estimate would have the
//   train run westwards and call the head end the rear.
const node = (id, tags, x, y) => Object.assign({ type: 'node', id, tags }, ll(x, y));
const raw4 = { elements: [
  way(1, { railway: 'platform', ref: '1', train: 'yes', level: '0' }, [[-100, 0], [100, 0]]),
  way(2, { railway: 'platform', ref: '2', train: 'yes', level: '0' }, [[-100, -20], [100, -20]]),
  way(61, { highway: 'footway', level: '0' }, [[100, 0], [120, 0], [120, -20], [100, -20]]),
  node(71, { railway: 'buffer_stop' }, 108, 4),
  node(72, { railway: 'buffer_stop' }, 108, -16)
] };
const tt4 = { id: '1', name: 'Teststadt', prepared: '2026-10-01', lines: [{
  ref: 'ICE 1', type: 'train', platform: Object.assign({ id: 'p1', code: '1' }, ll(0, 1)),
  prev: Object.assign({ id: 'prev', name: 'Oststadt' }, ll(3000, 0)), destinations: [], trips: 10, share: 1
}] };
let st4 = U.buildStation(raw4, center);
U.applyLookup(st4, { elements: [] });
U.applyTimetable(st4, tt4);
st4 = JSON.parse(JSON.stringify(U.finalize(st4)));
assert.ok(st4.platforms.w1.deadEnd, 'buffer stop beyond the east end only: terminus platform');
const opt4 = st4.options.find(o => o.ref === 'ICE 1');
const r4 = U.recommend(st4, opt4.key, 'w2', {});
assert.ok(!r4.error, 'a platform without stairs or lifts has a level access: ' + r4.error);
assert.strictEqual(r4.chosen.kind, 'level');
assert.strictEqual(r4.chosen.zone, 'vorne', 'trains run towards the buffer stop: the head end is the front');
assert.ok(!r4.opt.ambiguous, 'direction is certain at a terminus');
assert.ok(Math.abs(r4.chosen.dist - 60) < 2, 'along the concourse: ' + r4.chosen.dist);
const r4free = U.recommend(st4, opt4.key, 'w2', { liftOnly: true });
assert.strictEqual(r4free.chosen && r4free.chosen.kind, 'level', 'level access is step-free');

// ---------- Stairs in several flights along the platform (Gesundbrunnen 5/6) ----------
//
//   R1 (arrival, level -1) and R2 (target, level -1), 30 m apart. Stairs up to a bridge (level 0) in three
//   flights running along R1, 2 m beside it: bottom at x = 20, top at x = -10. All three flights are close
//   to the platform, but only the bottom of the first one is on it.
const raw5 = { elements: [
  way(1, { railway: 'platform', ref: '1', train: 'yes', level: '-1' }, [[-100, 0], [100, 0]]),
  way(2, { railway: 'platform', ref: '2', train: 'yes', level: '-1' }, [[-100, -30], [100, -30]]),
  way(81, { highway: 'steps', level: '-1;-0.7' }, [[20, 2], [10, 2]]),
  way(82, { highway: 'steps', level: '-0.7;-0.3' }, [[10, 2], [0, 2]]),
  way(83, { highway: 'steps', level: '-0.3;0' }, [[0, 2], [-10, 2]]),
  way(84, { highway: 'footway', level: '0', bridge: 'yes' }, [[-10, 2], [-10, -28]]),
  way(85, { highway: 'steps', level: '0;-1' }, [[-10, -28], [0, -28]])
] };
let st5 = U.buildStation(raw5, center);
U.applyLookup(st5, { elements: [] });
U.applyTimetable(st5, tt);
st5 = JSON.parse(JSON.stringify(U.finalize(st5)));
const r5 = U.recommend(st5, st5.options.find(o => o.ref === 'S1').key, 'w2', {});
assert.deepStrictEqual(r5.cands.filter(c => c.kind === 'steps').map(c => c.key), ['w81'], 'only the first flight is an access point');
assert.ok(Math.abs(r5.chosen.anchor.x - 20) < 1, 'the walk starts at the bottom of the stairs: x = ' + r5.chosen.anchor.x);
assert.strictEqual(r5.chosen.zone, 'Mitte', 'x = 20 on a platform from -100 to 100, train running east');
// three flights (10 m each) + bridge 30 m + stairs down 10 m, plus the two short links to the platforms
assert.ok(Math.abs(r5.chosen.dist - (3 * 25 + 30 + 25 + 4)) < 3, 'the stairs are part of the walk: ' + r5.chosen.dist);
assert.ok(Math.abs(r5.route[0][0] - 20) < 1 && r5.route.some(([x, y]) => Math.abs(x + 10) < 1 && Math.abs(y - 2) < 1), 'route climbs the stairs');

console.log('walk.test.js: all checks passed');
