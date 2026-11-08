/*
 * Test: a lift belongs only to a platform at whose level it stops. Run: node test/lift.test.js
 *
 *   P1 (level -1)  x = -100 … +100, y = 0
 *   P2 (level -3)  x = -100 … +100, y = -15 (the U-Bahn below, beside P1 on the map)
 *   Lift L at (0, -6), levels "-3;0": from the street to P2, passing beside P1 (Gesundbrunnen "S+U8")
 *   Lift M at (50, -4), no level: nearest platform as before
 */
'use strict';
const assert = require('assert');
const U = require('../core.js');

const center = { name: 'Teststadt', lat: 52.5, lon: 13.4, r: 300 };
const P = U.projector(center.lat, center.lon);
const ll = (x, y) => { const [lat, lon] = P.ll(x, y); return { lat, lon }; };
const way = (id, tags, pts) => ({ type: 'way', id, tags, geometry: pts.map(([x, y]) => ll(x, y)) });
const node = (id, tags, [x, y]) => Object.assign({ type: 'node', id, tags }, ll(x, y));

const raw = { elements: [
  way(1, { railway: 'platform', ref: '1', train: 'yes', level: '-1' }, [[-100, 0], [100, 0]]),
  way(2, { railway: 'platform', ref: '2', subway: 'yes', level: '-3' }, [[-100, -15], [100, -15]]),
  node(11, { highway: 'elevator', level: '-3;0' }, [0, -6]),
  node(12, { highway: 'elevator' }, [50, -4])
] };

const st = U.buildStation(raw, center);
const platformOf = (key) => (st.access.find(a => a.key === key) || {}).platform;
assert.strictEqual(platformOf('n11'), 'w2', 'the lift does not stop at level -1: it belongs to the U-Bahn platform');
assert.strictEqual(platformOf('n12'), 'w1', 'a lift without level: the nearest platform');

console.log('lift.test.js: all checks passed');
