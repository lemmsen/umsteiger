/*
 * Test for sections (A–F) and train length (stop signs). Run: node test/train.test.js
 *
 *   P1: 300 m, x = -150 … +150 (t = 0 … 300 from the west end), trains run east
 *       sections A–F every 50 m, stairs at t = 40, 160, 270
 *       stop signs (eastbound): "210 m" at t = 295, "90 m" at t = 280
 *   P2 (target): short, only next to the west end (x = -150 … -100, 30 m south)
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

const center = { name: 'Teststadt', lat: 52.5, lon: 13.4, r: 400 };
const P = U.projector(center.lat, center.lon);
const ll = (x, y) => { const [lat, lon] = P.ll(x, y); return { lat, lon }; };
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => ll(x, y)) });
const node = (id, tags, x, y) => Object.assign({ type: 'node', id, tags }, ll(x, y));
const X = (t) => t - 150;

const raw = { elements: [
  way(1, { railway: 'platform', ref: '1', train: 'yes' }, [[-150, 0], [150, 0]]),
  way(2, { railway: 'platform', ref: '2', train: 'yes' }, [[-150, -30], [-100, -30]]),
  way(11, { highway: 'steps' }, [[X(40), 1], [X(40), 15]]),
  way(12, { highway: 'steps' }, [[X(160), 1], [X(160), 15]]),
  way(13, { highway: 'steps' }, [[X(270), 1], [X(270), 15]]),
  ...'ABCDEF'.split('').map((s, i) => node(100 + i, { 'railway:platform:section': s }, X(25 + 50 * i), 0)),
  node(201, { railway: 'signal', 'railway:signal:stop': 'DE-ESO:ne5', 'railway:signal:stop:caption': '210 m', 'umsteiger:bearing': '90' }, X(295), 4),
  node(202, { railway: 'signal', 'railway:signal:stop': 'DE-ESO:ne5', 'railway:signal:stop:caption': '90 m', 'umsteiger:bearing': '90' }, X(280), 4),
  node(203, { railway: 'signal', 'railway:signal:stop': 'DE-ESO:ne5', 'railway:signal:stop:caption': '90 m', 'umsteiger:bearing': '270' }, X(20), 4)
] };
const tt = { id: '1', name: 'Teststadt', prepared: '2026-10-01', lines: [{
  ref: 'RE1', type: 'train', platform: Object.assign({ id: 'p1', code: '1' }, ll(0, 1)),
  prev: Object.assign({ id: 'prev', name: 'Westend' }, ll(-3000, 0)), destinations: [], trips: 10, share: 1
}] };

let st = U.buildStation(raw, center);
U.applyLookup(st, { elements: [] });
U.applyTimetable(st, tt);
st = JSON.parse(JSON.stringify(U.finalize(st)));
const opt = st.options.find(o => o.ref === 'RE1');
assert.strictEqual(opt.frontSign > 0, true, 'eastbound');

// Sections
assert.strictEqual(st.platforms.w1.sections.length, 6);
const pl1 = st.platforms.w1;
assert.strictEqual(U.sectionAt(pl1, U.proj(pl1.ax, { x: X(160), y: 0 })), 'D', 'position on the axis (centred)');

// Train lengths: only the eastbound signs, longest first
const choices = U.trainChoices(st, opt);
assert.deepStrictEqual(choices.map(c => c.label), ['210 m', '90 m']);

// Whole platform (as before): stair 1 at the rear end, section A
const full = U.recommend(st, opt, 'w2', {});
assert.strictEqual(full.chosen.key, 'w11');
assert.strictEqual(full.chosen.zone, 'hinten');
assert.strictEqual(full.chosen.section, 'A');
assert.ok(full.chosen.offTrain < 1);

// 210 m: the train ends 45 m before stair 1; still the best, get off at the very rear (section B)
const long = U.recommend(st, opt, 'w2', { train: '210 m' });
assert.strictEqual(long.chosen.key, 'w11');
assert.ok(Math.abs(long.chosen.offTrain - 45) < 1, 'walk 45 m on the platform: ' + long.chosen.offTrain);
assert.strictEqual(long.chosen.section, 'B');

// 90 m: the train stands at t = 190 … 280; stair 2 (30 m behind the train) beats stair 1 (150 m)
const short = U.recommend(st, opt, 'w2', { train: '90 m' });
assert.strictEqual(short.chosen.key, 'w12');
assert.ok(Math.abs(short.chosen.offTrain - 30) < 1);
assert.strictEqual(short.chosen.zone, 'hinten');
assert.strictEqual(short.chosen.section, 'D');

console.log('train.test.js: all checks passed');

// Coach sequence without OSM sections: the first coach in the list is the front of the train.
// DB platform 0 … 400 m stretched onto the 300 m OSM platform; train runs east (frontSign +1).
const bare = JSON.parse(JSON.stringify(pl1)); delete bare.sections;
const st2 = Object.assign({}, st, { platforms: Object.assign({}, st.platforms, { w1: bare }) });
const seqUp = { start: 0, end: 400, sectors: [], vehicles: [
  { start: 300, end: 380, number: '1' }, { start: 220, end: 300, number: '2' }, { start: 140, end: 220, number: '3' }] };
const mUp = U.mapSequence(st2, 'w1', seqUp, opt.frontSign);
assert.strictEqual(mUp.method, 'order');
// List descends: the front (coach 1) is at 380 DB metres -> train runs towards higher metres -> DB 0 m at the west end
assert.ok(Math.abs(mUp.hi - U.proj(pl1.ax, { x: X(380 * 0.75), y: 0 })) < 1, 'front at 285 m from the west end');
assert.strictEqual(mUp.vehicleAt(mUp.hi - 1).number, '1', 'coach 1 at the front');
const seqDown = Object.assign({}, seqUp, { vehicles: seqUp.vehicles.slice().reverse() });
const mDown = U.mapSequence(st2, 'w1', seqDown, opt.frontSign);
assert.ok(Math.abs(mDown.hi - U.proj(pl1.ax, { x: X((400 - 140) * 0.75), y: 0 })) < 1, 'reversed list: DB 0 m at the east end');

// Plausibility with the stop signs (eastbound signs at 280 and 295 m from the west end)
assert.strictEqual(mUp.check, 'confirmed', 'front at 285 m, next to the sign at 280 m');
assert.strictEqual(mDown.check, 'conflict', 'front at 195 m fits no sign, the mirror image (285 m) does');
const noSigns = Object.assign({}, bare); delete noSigns.signs;
const st3 = Object.assign({}, st, { platforms: Object.assign({}, st.platforms, { w1: noSigns }) });
assert.strictEqual(U.mapSequence(st3, 'w1', seqUp, opt.frontSign).check, 'unchecked');

console.log('train.test.js: coach sequence checks passed');
