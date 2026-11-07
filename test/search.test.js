/*
 * Test for the station search. Run: node test/search.test.js
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

// Same layout as data/index.json: [id, name, lat, lon, types, lines, aliases]
const rows = [
  ['1', 'S+U Alexanderplatz Bhf (Berlin)', 52.5215, 13.4113, 'SU', 12, ''],
  ['2', 'Alexisbad', 51.65, 11.13, 'Z', 1, ''],
  ['3', 'Köln Hbf', 50.9430, 6.9589, 'SZ', 40, ''],
  ['4', 'Hamburg, Hamburg Hbf', 53.5530, 10.0067, 'Z', 30, ''],
  ['5', 'Hamburg, Mönckebergstraße', 53.5510, 9.9990, 'U', 1, ''],
  ['6', 'Frankfurt (Main) Südbahnhof', 50.0990, 8.6860, 'SUZ', 10, 'Frankfurt(Main)Süd']
];
const ids = (q) => U.searchStations(rows, q).map(r => r[0]);

assert.deepStrictEqual(ids('alex'), ['1', '2'], 'prefix, bigger station first');
assert.deepStrictEqual(ids('koeln hauptbahnhof'), ['3'], 'umlaut spelling and Hauptbahnhof = Hbf');
assert.deepStrictEqual(ids('Mönckebergstr'), ['5'], 'Straße = Str.');
assert.deepStrictEqual(ids('frankfurt süd'), ['6'], 'alias');
assert.deepStrictEqual(ids('xyz'), [], 'no match');
assert.deepStrictEqual(ids(''), [], 'empty query');

assert.strictEqual(U.displayName('S+U Alexanderplatz Bhf (Berlin)'), 'Alexanderplatz (Berlin)');
assert.strictEqual(U.displayName('Hamburg, Hamburg Hbf'), 'Hamburg Hbf');

const near = U.nearestStations(rows, 52.52, 13.41, 2);
assert.strictEqual(near[0].row[0], '1', 'nearest station');
assert.ok(near[0].d < 300, 'distance in metres');

console.log('search.test.js: all checks passed');
