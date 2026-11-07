/*
 * Test for the ways loaded around a station (destination beyond the station data): the box to load, the
 * answer turned into walk items, and tracks as obstacles for the straight last part. Synthetic station,
 * no network. Run: node test/area.test.js
 *
 *   Platform x = -100 … +100 at y = 0, stairs A at x = -90 and B at x = +60 up to y = 20,
 *   surface footways from the top of A (to -90,40) and of B (to 80,40). Station radius 150 m.
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

const center = { name: 'Teststadt', lat: 52.5, lon: 13.4, r: 150 };
const P = U.projector(center.lat, center.lon);
const ll = (x, y) => { const [lat, lon] = P.ll(x, y); return { lat, lon }; };
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => ll(x, y)) });

const raw = { elements: [
  way(1, { railway: 'platform', ref: '1', train: 'yes' }, [[-100, 0], [100, 0]]),
  way(11, { highway: 'steps' }, [[-90, 1], [-90, 20]]),
  way(12, { highway: 'steps' }, [[60, 1], [60, 20]]),
  way(31, { highway: 'footway' }, [[-90, 20], [-90, 40]]),
  way(32, { highway: 'footway' }, [[60, 20], [80, 40]])
] };
const tt = { id: '1', name: 'Teststadt', prepared: '2026-10-01', lines: [{
  ref: 'S1', type: 'light_rail', platform: Object.assign({ id: 'p1', code: '1' }, ll(0, 1)),
  prev: Object.assign({ id: 'prev', name: 'Westend' }, ll(-2000, 0)), destinations: [], trips: 10, share: 1
}] };
let st = U.buildStation(raw, center);
U.applyLookup(st, { elements: [] });
U.applyTimetable(st, tt);
st = JSON.parse(JSON.stringify(U.finalize(st)));
const opt = st.options.find(o => o.ref === 'S1');

// ---------- Box to load ----------
const far = ll(60, 400);
const area = U.areaFor(st, far);
assert.ok(area.outside, 'beyond the station radius');
// From the edge of the station data towards the point (22, 148) to the point (60, 400), 150 m margin, 100 m grid –
// not the whole station radius, whose ways are known already
assert.deepStrictEqual([area.x0, area.y0, area.x1, area.y1], [-200, -100, 300, 600], 'stretch from the station radius to the point');
assert.strictEqual(U.areaFor(st, ll(0, 3000)), null, 'too far: keeps the straight line');
assert.ok(!U.areaFor(st, ll(20, 30)).outside, 'inside the radius');
assert.strictEqual(U.areaFor(st, ll(70, 390)).key, area.key, 'a nearby point shares the stored area');
assert.ok(/way\["highway"~"\^\(footway\|.*residential/.test(U.areaQuery(area)), 'streets are asked for');

// ---------- Destination beyond the station data ----------
const before = U.recommend(st, opt.key, far, {});
assert.ok(before.tail > 300, 'without more ways: a long straight line (' + before.tail + ' m)');

const answer = { elements: [
  way(101, { highway: 'residential' }, [[80, 40], [80, 400], [60, 400]]),
  way(102, { highway: 'footway' }, [[60, 20], [80, 40]]),                        // already in the station data
  way(103, { highway: 'service', access: 'private' }, [[-90, 40], [60, 400]]),   // private: not for walking
  way(104, { railway: 'rail' }, [[-75, -100], [-75, 300]]),
  way(105, { railway: 'rail', bridge: 'yes' }, [[200, -100], [200, 300]])        // on a bridge: can be passed below
] };
const ways = U.areaWays(st, answer);
assert.strictEqual(ways.walk.length, 1, 'only the new, open street');
assert.strictEqual(ways.rails.length, 1, 'tracks on a bridge are no obstacle');
const ext = U.withArea(st, area, ways);
assert.notStrictEqual(ext, st, 'a new station object (new walk network)');
assert.strictEqual(st.walk.length, 4, 'the station itself is unchanged');
const after = U.recommend(ext, opt.key, far, {});
assert.strictEqual(after.method, 'walk');
assert.strictEqual(after.tail, 0, 'the point is on the street now');
assert.strictEqual(after.chosen.key, 'w12', 'stair B, where the street begins');
assert.ok(Math.abs(after.chosen.dist - (38.5 + Math.hypot(20, 20) + 360 + 20)) < 1, 'stairs + footway + street: ' + after.chosen.dist);

// ---------- Tracks as obstacles for the straight last part ----------
// Point east of the track at x = -75, close to the footway from stair A – which lies west of the track
const west = ll(-60, 45);
assert.strictEqual(U.recommend(st, opt.key, west, {}).chosen.key, 'w11', 'without tracks known: straight from A across');
const withTrack = U.withArea(st, U.areaFor(st, west), { walk: [], rails: [[[-75, -100], [-75, 300]]] });
const r = U.recommend(withTrack, opt.key, west, {});
assert.strictEqual(r.chosen.key, 'w12', 'with the track known: from the footway at B, which reaches the point without crossing it');
const last = r.route[r.route.length - 2];
assert.ok(last[0] > -75, 'the straight part starts east of the track');

console.log('area.test.js: all checks passed');
