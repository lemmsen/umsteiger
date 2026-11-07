/*
 * Test for the journey helpers: which stops of a journey get a recommendation, station and platform
 * matching, and the recommendation itself. Synthetic station, no network. Run: node test/journey.test.js
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
  line('S1', 'light_rail', '1', [0, 2], [-2000, 0], 'Westend'),
  line('U9', 'subway', '', [0, -28], [0, 2000], 'Nord')     // runs southwards
] };
let st = U.buildStation(raw, center);
U.applyLookup(st, { elements: [] });
U.applyTimetable(st, tt);
st = U.finalize(st);

// ---------- Journey in the format of server.py ----------
const stop = (name, x, y, track) => Object.assign({ name, track: track || null, rtTrack: null, time: null }, ll(x, y));
const transit = (line, product, from, to, prev, next) => ({ mode: 'transit', line, product, from, to, prev, next });
const walk = (from, to, distance) => ({ mode: 'walk', from, to, distance });
const here = (track) => stop('Testbahnhof', 0, 0, track);

const s1 = transit('S1', 'SBAHN', stop('Westend', -2000, 0, '3'), here('1'), stop('Westend', -2000, 0), stop('x', 0, 0));
const u9 = transit('U9', 'UBAHN', here('2 (U9)'), stop('Süd', 0, -2000), stop('x', 0, 0), stop('Süd', 0, -2000));
const bus = transit('Bus 100', 'BUS', stop('Bushalt', 200, 40), stop('Weit', 3000, 3000), null, null);
const home = stop('Zuhause', 400, 200);

// Change S1 -> U9 with a short walk in between; then a walk home
let stops = U.journeyStops({ legs: [s1, walk(here(), here(), 40), u9, walk(u9.to, home, 300)] });
assert.deepStrictEqual(stops.map(s => s.kind), ['change', 'leave'], 'U9 is rail too: its end is a "leave"');
assert.strictEqual(stops[0].depart, u9);
assert.strictEqual(stops[1].arrive, u9);
assert.ok(Math.abs(stops[1].point.lat - home.lat) < 1e-9, 'point = end of the walk');

// Bus after the train: leave the station towards the bus stop; a long walk is no change either
stops = U.journeyStops({ legs: [s1, walk(here(), bus.from, 210), bus] });
assert.deepStrictEqual(stops.map(s => s.kind), ['leave']);
assert.ok(Math.abs(stops[0].point.lon - bus.from.lon) < 1e-9, 'point = bus stop');
stops = U.journeyStops({ legs: [s1, walk(here(), here(), 900), u9] });
assert.deepStrictEqual(stops.map(s => s.kind), ['leave', 'leave'], 'walk of 900 m is no change within the station');
assert.deepStrictEqual(U.journeyStops({ legs: [bus] }), [], 'bus only: nothing to recommend');

console.log('journey.test.js: journey stops passed');

// ---------- Station and platform matching ----------
const rows = [
  ['10', 'S Testbahnhof (Teststadt)', ...Object.values(ll(30, 0)), 'S', 3, ''],
  ['11', 'Nebenstraße (Teststadt)', ...Object.values(ll(5, 5)), 'B', 1, ''],
  ['12', 'Weit weg', ...Object.values(ll(5000, 0)), 'S', 1, '']
];
assert.strictEqual(U.matchStation(rows, center.lat, center.lon, 'Testbahnhof').id, '10', 'shared word beats a closer stop');
assert.strictEqual(U.matchStation(rows, center.lat, center.lon, 'Ganz anders').id, '11', 'very close without a word in common');
assert.strictEqual(U.matchStation(rows, ...Object.values(ll(2000, 0)), 'Testbahnhof'), null, 'nothing within 400 m');

assert.strictEqual(U.trackOf('2 (U9)'), '2');
assert.strictEqual(U.trackOf('9 D-G'), '9', 'track with sections (Köln Hbf)');
assert.strictEqual(U.findPlatform(st, { product: 'SBAHN', line: 'S1', track: '1' }), 'w1', 'by track');
assert.strictEqual(U.findPlatform(st, { product: 'UBAHN', line: 'U9', track: '2 (U9)' }), 'w2',
  'U-Bahn by line, not the train platform that also has a track 2');
assert.strictEqual(U.findPlatform(st, { product: 'REGIONAL', line: 'RE9', track: '7' }), null, 'unknown track: no guess');
assert.strictEqual(U.findPlatform(st, { product: 'BUS', line: 'Bus 100', track: '1' }), null, 'bus: no platform model');
assert.strictEqual(U.trackOf('Fern 6'), '6', 'word before the number (Frankfurt Flughafen Fernbahnhof)');
assert.strictEqual(U.trackOf(''), '');

// The same track number on a second OSM object without lines or kind of train (Berlin Hbf: track 4 twice):
// the platform with information counts
const rawDup = { elements: raw.elements.concat([way(3, { railway: 'platform', ref: '1' }, [[-100, 30], [100, 30]])]) };
let stDup = U.buildStation(rawDup, center);
U.applyLookup(stDup, { elements: [] });
U.applyTimetable(stDup, tt);
stDup = U.finalize(stDup);
assert.ok(stDup.platforms.w3, 'second object with track 1 is a platform of the model');
assert.strictEqual(U.findPlatform(stDup, { product: 'SBAHN', line: 'S1', track: '1' }), 'w1', 'duplicate track: the known platform');

console.log('journey.test.js: matching passed');

// ---------- Recommendation ----------
// S1 eastbound on P1 to the U9: stairs at x = +60 -> front (as in timetable.test.js)
stops = U.journeyStops({ legs: [s1, u9, walk(u9.to, home, 300)] });
let adv = U.transferAdvice(st, stops[0]);
assert.strictEqual(adv.plat, 'w1');
assert.strictEqual(adv.target, 'w2');
assert.strictEqual(adv.rec.chosen.key, 'w12');
assert.strictEqual(adv.rec.chosen.zone, 'vorne');

// Same train from the east: rear
const s1w = Object.assign({}, s1, { prev: stop('Ostend', 2000, 0) });
adv = U.transferAdvice(st, { kind: 'change', arrive: s1w, depart: u9 });
assert.strictEqual(adv.rec.chosen.zone, 'hinten');

// Leaving towards a point far west: stairs at x = -90 -> rear of the eastbound train
adv = U.transferAdvice(st, { kind: 'leave', arrive: s1, point: ll(-400, 100) });
assert.strictEqual(adv.rec.chosen.key, 'w11');
assert.strictEqual(adv.rec.chosen.zone, 'hinten');

// What cannot be told is reported, not guessed
assert.strictEqual(U.transferAdvice(st, { kind: 'leave', arrive: s1, point: null }).code, 'noTarget');
const re9 = transit('RE9', 'REGIONAL', stop('x', 0, 0), here('7'), stop('Westend', -2000, 0), null);
assert.strictEqual(U.transferAdvice(st, { kind: 'change', arrive: re9, depart: u9 }).code, 'noPlatform');

// Selection for the station view: platform, line and the direction entry of the same way
const sel = U.viewSelection(st, stops[0], U.transferAdvice(st, stops[0]));
assert.deepStrictEqual(sel, { arr: 'w1', line: 'S1', from: st.options.find(o => o.ref === 'S1').key, to: 'w2' });

console.log('journey.test.js: recommendation passed');

// ---------- Platforms of the next station within the radius (as U5 at Berlin Alexanderplatz) ----------
//   P2 (U9, here)              x =  -60 …  +60, y = -30
//   P3 (U9, next station, "9") x = 300 … 420, y = -30
// Both get trains from the east, so the direction fits both; the previous stop tells them apart.
const raw2 = { elements: [
  way(2, { railway: 'platform', subway: 'yes', route_ref: 'U9' }, [[-60, -30], [60, -30]]),
  way(3, { railway: 'platform', subway: 'yes', ref: '9', name: 'Nachbar' }, [[300, -30], [420, -30]]),
  way(21, { highway: 'steps' }, [[-50, -28], [-50, -10]]),
  way(31, { highway: 'steps' }, [[310, -28], [310, -10]])
] };
const tt2 = { id: '2', name: center.name, prepared: '2026-10-01', lines: [
  line('U9', 'subway', '', [0, -28], [2000, -30], 'Ost'),
  Object.assign(line('U9', 'subway', '9', [360, -28], [3000, -30], 'Weiter'), { prev: Object.assign({ id: 'prevU9b', name: 'Teststadt, Weiter' }, ll(3000, -30)) })
] };
let st2 = U.buildStation(raw2, center);
U.applyLookup(st2, { elements: [] });
U.applyTimetable(st2, tt2);
st2 = U.finalize(st2);
assert.deepStrictEqual(st2.options.map(o => o.plat).sort(), ['w2', 'w3'], 'one U9 option on each platform');
const fromEast = { product: 'UBAHN', line: 'U9', track: '1 (U9)', from: Object.assign({ name: 'Ost (U), Teststadt' }, ll(2000, -30)) };
assert.strictEqual(U.findPlatform(st2, fromEast), 'w2', 'previous stop decides');
assert.strictEqual(U.findPlatform(st2, Object.assign({}, fromEast, { from: Object.assign({ name: 'Unbekannt' }, ll(2000, -30)) })), null,
  'unknown previous stop and both directions fit: no guess');

// Leaving towards an exit (target key) instead of a point
const raw3 = { elements: raw.elements.concat([{ type: 'node', id: 900, tags: { railway: 'subway_entrance', ref: 'A' }, ...ll(-120, 40) }]) };
let st3 = U.buildStation(raw3, center);
U.applyLookup(st3, { elements: [] });
U.applyTimetable(st3, tt);
st3 = U.finalize(st3);
const exitA = st3.targets.find(x => x.exit);
assert.ok(exitA, 'exit A offered');
adv = U.transferAdvice(st3, { kind: 'leave', arrive: s1, point: exitA.key });
assert.strictEqual(adv.rec.chosen.zone, 'hinten', 'exit in the west: rear of the eastbound train');
assert.strictEqual(U.viewSelection(st3, { arrive: s1 }, adv).to, exitA.key);

// ---------- Time to change against the walk ----------
const timed = (leg, side, time, rtTime) => Object.assign({}, leg, { [side]: Object.assign({}, leg[side], { time, rtTime: rtTime || null }) });
const arriveAt = (t, rt) => timed(s1, 'to', '2026-10-22T08:00:00', rt);
const departAt = (t, rt) => timed(u9, 'from', t, rt);
const walkRec = (dist) => ({ method: 'walk', chosen: { dist } });
let ct = U.connectionTime({ arrive: arriveAt(), depart: departAt('2026-10-22T08:06:00') }, walkRec(150));
assert.deepStrictEqual([ct.minutes, ct.need, ct.level], [6, 3, 'ok'], '150 m = 2 min + 1 min to get off');
ct = U.connectionTime({ arrive: arriveAt(), depart: departAt('2026-10-22T08:04:00') }, walkRec(150));
assert.strictEqual(ct.level, 'tight', 'one minute to spare');
// Delay of the arriving train eats the time to change
ct = U.connectionTime({ arrive: arriveAt(null, '2026-10-22T08:05:00'), depart: departAt('2026-10-22T08:06:00') }, walkRec(150));
assert.deepStrictEqual([ct.minutes, ct.level], [1, 'risk']);
// … a delayed departure gives time back
ct = U.connectionTime({ arrive: arriveAt(null, '2026-10-22T08:05:00'), depart: departAt('2026-10-22T08:06:00', '2026-10-22T08:10:00') }, walkRec(150));
assert.strictEqual(ct.level, 'ok');
// Without a walk from the station model: the walks of the journey planner between the two legs
const a1 = arriveAt(), d1 = departAt('2026-10-22T08:03:00');
ct = U.connectionTime({ arrive: a1, depart: d1 }, null, [a1, walk(here(), here(), 200), d1]);
assert.deepStrictEqual([ct.walk, ct.need, ct.level], [200, 4, 'risk']);
ct = U.connectionTime({ arrive: a1, depart: d1 }, { method: 'air', chosen: { dist: 20 } }, [a1, d1]);
assert.strictEqual(ct.walk, 0, 'straight line distance does not count, no walk of the journey planner: only getting off');
assert.strictEqual(U.connectionTime({ arrive: a1, depart: Object.assign({}, d1, { cancelled: true }) }).level, 'cancelled');
assert.strictEqual(U.connectionTime({ arrive: a1, depart: null }), null, 'end of the journey');

// ---------- Bus stop of the journey planner moved to the OSM platform of that name ----------
const node = (id, tags, x, y) => Object.assign({ type: 'node', id, tags }, ll(x, y));
const raw4 = { elements: raw.elements.concat([
  node(801, { highway: 'bus_stop', public_transport: 'platform', name: 'Teststadt, Bahnhof (Brücke)', ref: 'Brücke' }, 150, 40),
  node(802, { highway: 'bus_stop', public_transport: 'platform', name: 'Teststadt, Marktplatz' }, 110, 70),
  node(803, { railway: 'tram_stop', public_transport: 'platform', tram: 'yes', name: 'Teststadt, Bahnhof' }, 120, 60),
  // the same stop on the other side of the street (the street runs east–west at y = 30)
  node(804, { highway: 'bus_stop', public_transport: 'platform', name: 'Teststadt, Bahnhof (Brücke)', ref: 'Brücke' }, 150, 20),
  // bus station with bays of one name
  node(805, { highway: 'bus_stop', public_transport: 'platform', name: 'Teststadt, Busbahnhof', local_ref: 'A' }, -150, 40),
  node(806, { highway: 'bus_stop', public_transport: 'platform', name: 'Teststadt, Busbahnhof', local_ref: 'B' }, -160, 40),
  node(807, { highway: 'bus_stop', public_transport: 'platform', name: 'Teststadt, Busbahnhof', local_ref: 'C' }, -170, 40)
]) };
let st4 = U.buildStation(raw4, center);
U.applyLookup(st4, { elements: [] });
U.applyTimetable(st4, tt);
st4 = JSON.parse(JSON.stringify(U.finalize(st4)));
const busAt = (name, x, y, product, next, track) => transit('Bus 862', product || 'BUS', Object.assign(stop(name, x, y), { track: track || null }),
  stop('Weit', 3000, 3000), null, next || null);
const leaveTo = (bus) => ({ kind: 'leave', arrive: s1, depart: bus, point: { lat: bus.from.lat, lon: bus.from.lon }, legIndex: 0 });
const near = (p, x, y) => { const [px, py] = U.projector(center.lat, center.lon).xy(p.lat, p.lon); return Math.hypot(px - x, py - y) < 1; };
// The journey planner puts "Bahnhof, Teststadt" 50 m beside the platforms on the bridge; one on each side of the street
let sn = U.snapStop(st4, leaveTo(busAt('Bahnhof, Teststadt', 120, 80, 'BUS', stop('West', -2000, 30))));
assert.ok(near(sn.point, 150, 40), 'westwards: the platform north of the street (on the right)');
assert.strictEqual(sn.stopRef, 'Brücke');
sn = U.snapStop(st4, leaveTo(busAt('Bahnhof, Teststadt', 120, 80, 'BUS', stop('Ost', 2000, 30))));
assert.ok(near(sn.point, 150, 20), 'eastwards: the platform south of the street');
sn = U.snapStop(st4, leaveTo(busAt('Bahnhof, Teststadt', 120, 80)));
assert.ok(near(sn.point, 150, 40), 'next stop unknown: the closer one');
// Bus station: the bay the journey planner names, else the closest
assert.ok(near(U.snapStop(st4, leaveTo(busAt('Busbahnhof, Teststadt', -150, 60, 'BUS', null, 'Bussteig C'))).point, -170, 40), 'bay C');
assert.ok(near(U.snapStop(st4, leaveTo(busAt('Busbahnhof, Teststadt', -150, 60, 'BUS', stop('West', -2000, 30)))).point, -150, 40),
  'no bay known and more than two bays: the closest (no side rule)');
sn = U.snapStop(st4, leaveTo(busAt('Bahnhof, Teststadt', 120, 80, 'TRAM')));
assert.ok(near(sn.point, 120, 60), 'a tram goes to the tram stop of that name');
sn = U.snapStop(st4, leaveTo(busAt('Rathaus, Teststadt', 120, 80)));
assert.ok(near(sn.point, 120, 80) && sn.stopRef === null, 'no platform of that name: the point of the journey planner stays');
sn = U.snapStop(st4, leaveTo(busAt('Bahnhof, Teststadt', 400, 400)));
assert.ok(near(sn.point, 400, 400), 'too far from any platform of that name: stays');
const adv4 = U.transferAdvice(st4, leaveTo(busAt('Bahnhof, Teststadt', 120, 80)));
assert.ok(near(adv4.target, 150, 40), 'the recommendation leads to the bus platform');

console.log('journey.test.js: all checks passed');
