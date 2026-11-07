/* Every language must have the same texts with the same placeholders as German.
 * Run: node test/i18n.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const I = require('../i18n.js');

const keys = Object.keys(I.TEXTS.de).sort();
const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
assert.deepStrictEqual(I.LANGS, ['de', 'en', 'fr', 'it', 'es', 'ja']);
for (const lang of I.LANGS) {
  assert.deepStrictEqual(Object.keys(I.TEXTS[lang]).sort(), keys, lang + ': same keys as de');
  for (const k of keys) {
    assert.ok(I.TEXTS[lang][k].trim(), `${lang}.${k} is empty`);
    assert.strictEqual(holes(I.TEXTS[lang][k]), holes(I.TEXTS.de[k]), `${lang}.${k}: same placeholders as de`);
  }
}

// Every key used in the scripts and pages exists
const root = path.join(__dirname, '..');
const read = (...files) => files.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
const app = read('app.js', 'route.js', 'stationmap.js', 'departures.js', 'common.js', 'stationdata.js');
const html = read('index.html', 'station.html', 'departures.html');
const used = new Set();
for (const m of app.matchAll(/\bt\('([\w.]+)'/g)) used.add(m[1]);
for (const m of html.matchAll(/data-i18n="([\w.]+)"/g)) used.add(m[1]);
for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const p of m[1].split(',')) used.add(p.split(':')[1]);
for (const k of used) if (!k.endsWith('.')) assert.ok(keys.includes(k), 'unknown text key: ' + k);
// Keys built at run time: t('zone.' + …), t('at.' + …), t('err.' + …), t('r.no.' + …), t(cond ? 'a' : 'b')
for (const m of app.matchAll(/\? '([\w.]+)' : '([\w.]+)'/g)) for (const k of [m[1], m[2]]) if (keys.includes(k)) used.add(k);
const unused = keys.filter(k => !used.has(k) && !/^(zone|at|err|r\.no)\./.test(k));
assert.deepStrictEqual(unused, [], 'texts that nothing uses');

assert.strictEqual(I.lang, 'de', 'German in Node');
assert.strictEqual(I.t('track', { n: '3' }), 'Gleis 3');
assert.strictEqual(I.or(['vorne', 'in der Mitte', 'hinten']), 'vorne, in der Mitte oder hinten');
console.log('i18n: ' + keys.length + ' texts in ' + I.LANGS.length + ' languages – ok');
