/*
 * Test for applyTimetable: platform matching and lines with unknown platform.
 * Synthetic station, no network. Run: node test/timetable.test.js
 *
 *   P1 (train, "Gleis 1;2")   x = -100 … +100, y = 0     stairs at x = -90 and x = +60
 *   P2 (subway, route_ref U9) x =  -60 …  +60, y = -30   stairs at x = -50 and x = +50
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

const center = { name: 'Teststadt, Testbahnhof', lat: 52.5, lon: 13.4, r: 300 };
const P = U.projector(center.lat, center.lon);
const ll = (x, y) => { const [lat, lon] = P.ll(x, y); return { lat, lon }; };
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => ll(x, y)) });

const raw = { elements: [
  way(1, { railway: 'platform', ref: '1;2', train: 'yes' }, [[-100, 0], [100, 0]]),
  way(2, { railway: 'platform', subway: 'yes', route_ref: 'U9' }, [[-60, -30], [60, -30]]),
  way(11, { highway: 'steps' }, [[-90, 2], [-90, 20]]),
  way(12, { highway: 'steps' }, [[60, 2], [60, 20]]),
  way(21, { highway: 'steps' }, [[-50, -28], [-50, -10]]),
  way(22, { highway: 'steps' }, [[50, -28], [50, -10]])
] };

const line = (ref, type, code, at, prevAt, prevName) => ({
  ref, type,
  platform: Object.assign({ id: 'p' + ref, code }, ll(...at)),
  prev: Object.assign({ id: 'prev' + ref, name: 'Teststadt, ' + prevName }, ll(...prevAt)),
  destinations: ['Irgendwo'], trips: 10, share: 1
});
const tt = { id: '1', name: center.name, prepared: '2026-10-01', lines: [
  line('S1', 'light_rail', '1', [0, 2], [-2000, 0], 'Westend'),     // number matches P1, runs eastwards
  line('U9', 'subway', '2', [0, -28], [0, -2000], 'Süd'),            // "2" is also on P1, but P1 is a train platform
  line('X1', 'train', '', [0, 0], [2000, 0], 'Ostend')              // no number, no route: platform unknown
] };

let st = U.buildStation(raw, center);
U.applyLookup(st, { elements: [] });
U.applyTimetable(st, tt);
st = U.finalize(st);

const opt = (ref) => st.options.find(o => o.ref === ref);

// Platform matching
assert.strictEqual(opt('S1').plat, 'w1', 'S1 via platform number');
assert.strictEqual(opt('U9').plat, 'w2', 'U9 via route_ref, not the train platform with the same number');
assert.strictEqual(opt('X1').plat, null, 'X1 platform unknown');
assert.deepStrictEqual(opt('S1').prevNames, ['Westend'], 'city prefix removed');
assert.ok(st.targets.some(t => t.key === 'w2' && t.refs.includes('U9')), 'P2 offered as target with U9');

// Known platform: S1 eastbound, stair at x = +60 is closest to P2 -> front part of the train
const s1 = U.recommend(st, opt('S1').key, 'w2', {});
assert.strictEqual(s1.chosen.key, 'w12');
assert.strictEqual(s1.chosen.zone, 'vorne');

// Unknown platform: asks for it first, then works with the chosen platform (westbound -> rear)
const x1a = U.recommend(st, opt('X1').key, 'w2', {});
assert.ok(x1a.needPlatform, 'asks for platform');
const x1b = U.recommend(st, opt('X1').key, 'w2', { platform: 'w1' });
assert.strictEqual(x1b.chosen.key, 'w12');
assert.strictEqual(x1b.chosen.zone, 'hinten');

console.log('timetable.test.js: platform checks passed');

// Arrival by platform: P1 has S1 (eastbound) and – as fallback, no other train platform – X1 (westbound)
const arr = U.arrivals(st);
const p1 = arr.find(a => a.key === 'w1'), p2 = arr.find(a => a.key === 'w2');
assert.ok(p1 && p2, 'both platforms offered');
assert.deepStrictEqual(p1.lines.map(l => l.ref), ['S1', 'X1'], 'known line first');
assert.deepStrictEqual(p1.lines.map(l => l.guessed), [false, true]);
assert.deepStrictEqual(p2.lines.map(l => l.ref), ['U9'], 'X1 (train) not offered on the U-Bahn platform');
const x1 = p1.lines.find(l => l.ref === 'X1').directions;
assert.deepStrictEqual(x1.map(d => d.prevNames[0]), ['Ostend'], 'one entry per previous stop');
const viaDir = U.recommend(st, x1[0], 'w2', {});
assert.strictEqual(viaDir.chosen.zone, 'hinten', 'recommend with a direction object');

console.log('timetable.test.js: all checks passed');
