/*
 * Test for the places of the journey search: points as locations with coordinates and the lists of recent
 * places and searches. Run: node test/places.test.js
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

// A point becomes a location id with its coordinates ('lat,lon', as Transitous takes it)
const p = U.pointPlace(52.5486, 13.3886, 'Punkt bei Gesundbrunnen');
assert.strictEqual(p.id, '52.548600,13.388600');
assert.strictEqual(p.kind, 'point');
assert.deepStrictEqual([p.lat, p.lon], [52.5486, 13.3886]);
assert.strictEqual(U.pointPlace(52.5, 13.4, 'Mein Standort', 'here').kind, 'here');

// Same place: stations and addresses by name (their ids can change with the data)
const a1 = { id: 'A=1@O=Berlin Gesundbrunnen@p=1@', name: 'Berlin Gesundbrunnen', kind: 'station' };
const a2 = { id: 'A=1@O=Berlin Gesundbrunnen@p=2@', name: 'Berlin Gesundbrunnen', kind: 'station' };
const b = { id: 'A=1@O=Berlin Alexanderplatz@', name: 'Berlin Alexanderplatz', kind: 'station' };
assert.strictEqual(U.placeKey(a1), U.placeKey(a2));
assert.notStrictEqual(U.placeKey(a1), U.placeKey(b));
// … points by name (two points near the same stop look the same in the list)
assert.strictEqual(U.placeKey(U.pointPlace(52.5, 13.4, 'Punkt bei A')), U.placeKey(U.pointPlace(52.5001, 13.4, 'Punkt bei A')));
assert.notStrictEqual(U.placeKey(U.pointPlace(52.5, 13.4, 'Punkt bei A')), U.placeKey(U.pointPlace(52.6, 13.4, 'Punkt bei B')));
// … the own location is one place, wherever it was located
const here1 = U.pointPlace(52.5, 13.4, 'Mein Standort', 'here'), here2 = U.pointPlace(52.6, 13.5, 'My location', 'here');
assert.strictEqual(U.placeKey(here1), U.placeKey(here2));

// Recent list: newest first, no duplicates, limited length
let recent = [];
for (const x of [a1, b, a2]) recent = U.addRecent(recent, x, U.placeKey, 2);
assert.deepStrictEqual(recent, [a2, b]);
recent = U.addRecent(recent, p, U.placeKey, 2);
assert.deepStrictEqual(recent, [p, a2]);

// Searches from the own location at different places are one entry
let fromHere = [];
for (const h of [here1, here2]) fromHere = U.addRecent(fromHere, { from: h, to: b }, U.tripKey, 5);
assert.strictEqual(fromHere.length, 1);
assert.strictEqual(fromHere[0].from, here2);

// Recent searches: the same trip again moves to the top, the reverse trip is a trip of its own
let trips = [];
for (const tr of [{ from: a1, to: b }, { from: b, to: a1 }, { from: a2, to: b }]) trips = U.addRecent(trips, tr, U.tripKey, 5);
assert.strictEqual(trips.length, 2);
assert.strictEqual(trips[0].from, a2);
assert.strictEqual(trips[1].from, b);

console.log('places.test.js: OK');
