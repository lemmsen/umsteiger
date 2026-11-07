/*
 * Test for the translation of Transitous answers in server.py (no network): journeys with long walks that
 * a quicker journey replaces, and trains added in real time without kind and name.
 * Runs server.py's functions with python3. Run: node test/server.test.js
 */
'use strict';
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

// Calls functions of server.py with JSON arguments, returns their JSON results
function py(code) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('server', ${JSON.stringify(path.join(__dirname, '..', 'server.py'))})
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
print(json.dumps(${code}))`;
  return JSON.parse(execFileSync('python3', ['-I', '-c', script], { encoding: 'utf8' }));
}

// Itineraries as Transitous sends them (only what the filter reads)
const walk = (m) => `{'mode': 'WALK', 'distance': ${m}}`;
const ride = `{'mode': 'SUBURBAN'}`;
const it = (id, start, end, legs) => `{'id': '${id}', 'startTime': '2026-11-09T07:${start}:00Z', 'endTime': '2026-11-09T07:${end}:00Z', 'legs': [${legs.join(', ')}]}`;

// Bornholmer Str. -> Voltastr.: S-Bahn and 950 m on foot, or S-Bahn and one stop U8 (leaves at the same time, earlier there)
const ids = (its) => py(`[i['id'] for i in s.without_long_walks([${its.join(', ')}])]`);
assert.deepStrictEqual(ids([it('walk', '48', '59', [ride, walk(950)]), it('change', '48', '57', [ride, walk(200), ride])]),
  ['change'], 'long walk replaced by the quicker change');
assert.deepStrictEqual(ids([it('walk', '48', '55', [ride, walk(950)]), it('change', '48', '57', [ride, walk(200), ride])]),
  ['walk', 'change'], 'walking is quicker: both stay');
assert.deepStrictEqual(ids([it('walk', '50', '59', [ride, walk(950)]), it('change', '48', '57', [ride, walk(200), ride])]),
  ['walk', 'change'], 'the change leaves earlier: both stay');
assert.deepStrictEqual(ids([it('walk', '48', '59', [ride, walk(450)]), it('change', '48', '57', [ride, walk(100), ride])]),
  ['walk', 'change'], 'a short walk stays');
assert.deepStrictEqual(ids([it('only', '48', '59', [walk(900), ride])]), ['only'], 'nothing better: the long walk stays');

// Train added in real time: mode OTHER, name "?", stops with a track
const added = py(`s.leg_of({'mode': 'OTHER', 'tripId': 't', 'displayName': '?', 'routeShortName': '?', 'headsign': 'Hamburg Hbf',
  'from': {'name': 'Berlin Hbf', 'lat': 52.525, 'lon': 13.37, 'scheduledTrack': '7', 'track': '7', 'scheduledDeparture': '2026-11-07T19:09:00Z', 'tz': 'Europe/Berlin'},
  'to': {'name': 'Hamburg Hbf', 'lat': 53.55, 'lon': 10.0, 'scheduledArrival': '2026-11-07T21:10:00Z', 'tz': 'Europe/Berlin'}})`);
assert.strictEqual(added.line, '', 'no "?" as the name');
assert.strictEqual(added.product, 'REGIONAL', 'a stop with a track: a train');
assert.strictEqual(added.from.track, '7');
assert.strictEqual(py(`s.product_of('OTHER', '', {'track': 'Pos. 3'})`), 'BUS', 'a bus bay is no track');
assert.strictEqual(py(`s.product_of('SUBURBAN', 'S41')`), 'SBAHN');

console.log('server.test.js: all checks passed');
