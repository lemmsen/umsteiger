/* Umsteiger – station models: prepared files of the server (data/st, data/osm), Overpass as fallback, stored on the
   device. Used by the station view (app.js) and the journey search (route.js). Global: window.StationData */
(function () {
  'use strict';
  const U = window.Umstieg;
  const I = window.I18N, t = I.t;
  const { store } = window.Common;

  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  const MODEL_DAYS = 7;   // the journey search rebuilds older copies (the station view checks the server's data date itself)

  // The stored station holds texts (platform labels): one copy per language and version of the model.
  // stationKey: id of data/index.json, or "lat,lon,r" for a station given by coordinates
  const cacheKey = (stationKey) => 'umsteiger:data:v' + U.DATA_VERSION + ':' + I.lang + ':' + stationKey;

  // Stored copy { at, dates, station } or null (maxDays: older copies count as missing)
  function cached(stationKey, maxDays) {
    try {
      const c = JSON.parse(store.get(cacheKey(stationKey)));
      if (c && c.station && (!maxDays || Date.now() - c.at < maxDays * 864e5)) return c;
    } catch (e) { /* unreadable: rebuild */ }
    return null;
  }

  // Station file from the server, always checked for a newer version; null when the server has none.
  // strict: a server that cannot be reached is an error instead of "no file".
  async function file(kind, id, strict) {
    if (!id) return null;
    try {
      const res = await fetch(`data/${kind}/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
      if (res.ok) return await res.json();
      if (strict && res.status !== 404) throw new Error('HTTP ' + res.status);
    } catch (e) {
      if (strict) throw e; // otherwise: offline or no data folder
    }
    return null;
  }

  async function overpass(query) {
    let lastErr;
    for (const ep of ENDPOINTS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60000);
      try {
        const res = await fetch(ep + '?data=' + encodeURIComponent(query), { signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error(t('overpassDown'));
  }

  // Station model from the prepared data (or from Overpass when there is none), stored on the device.
  // center: { name, lat, lon, r }; tt: data/st file or null; pre: data/osm file or null.
  // onStatus(text): progress while asking Overpass. Returns { station, dates }.
  async function build(stationKey, center, tt, pre, onStatus) {
    const say = onStatus || (() => {});
    let raw;
    if (pre) raw = pre.osm;
    else {
      say(t('loadingOverpass'));
      raw = await overpass(U.stationQuery(center.lat, center.lon, center.r));
    }
    let s = U.buildStation(raw, center);
    if (s.need.length) {
      if (!pre) say(t('loadingDirections'));
      U.applyLookup(s, pre ? pre.lookup : await overpass(U.lookupQuery(s.need)));
    }
    if (tt) U.applyTimetable(s, tt);
    s = U.finalize(s);
    delete s.stops; delete s.routeInfos; delete s.lookup; delete s.need; // keep the stored copy small
    const station = JSON.parse(JSON.stringify(s));
    // without prepared OSM data the station comes live from Overpass: OSM as of today
    const dates = { osm: pre ? pre.prepared : new Date().toISOString().slice(0, 10), timetable: tt && tt.prepared };
    store.set(cacheKey(stationKey), JSON.stringify({ at: Date.now(), dates, station }));
    return { station, dates };
  }

  // Station model for an id of data/index.json, only from prepared data (no Overpass: the journey search asks
  // for several stations at once); null without data. Parts merged into another station lead to that one.
  const models = new Map();
  function model(id) {
    if (!models.has(id)) models.set(id, (async () => {
      const c = cached(id, MODEL_DAYS);
      if (c) return Object.assign(c.station, { id });
      const tt = await file('st', id);
      if (!tt) return null;
      if (tt.mergedInto) return model(tt.mergedInto);
      const pre = await file('osm', id);
      if (!pre) return null;
      const { station } = await build(id, { name: tt.name, lat: tt.lat, lon: tt.lon, r: tt.r }, tt, pre);
      return Object.assign(station, { id });
    })().catch(() => null));
    return models.get(id);
  }

  // ---------- Ways around the station for a destination beyond the station data ----------

  // Loaded from Overpass when needed, stored per station and area (box on a 100 m grid, see core.js areaFor)
  const AREA_DAYS = 30;
  const areaKey = (stationKey, area) => 'umsteiger:area:v2:' + stationKey + ':' + area.key;
  // Areas of version 1 (whole station radius, 250 m grid) are not asked for any more
  try { Object.keys(localStorage).filter(k => k.startsWith('umsteiger:area:v1:')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* no storage */ }
  const areas = new Map();     // storage key -> { ways } | { failed } | { pending }
  const extended = new Map();  // storage key -> { base, st }: the same object every time, so the walk network is built once

  function areaEntry(stationKey, area) {
    const k = areaKey(stationKey, area);
    if (!areas.has(k)) {
      try {
        const c = JSON.parse(store.get(k));
        if (c && c.ways && Date.now() - c.at < AREA_DAYS * 864e5) areas.set(k, { ways: c.ways });
      } catch (e) { /* load again */ }
    }
    return { k, entry: areas.get(k) };
  }

  // State of the ways around a point: 'inside' (the station data covers it), 'far' (too far to load),
  // 'none' (not loaded yet), 'loading', 'done' or 'failed' (Overpass did not answer; not asked again until reload)
  function areaState(st, stationKey, point) {
    const area = U.areaFor(st, point);
    if (!area) return 'far';
    const { entry } = areaEntry(stationKey, area);
    return !entry ? 'none' : entry.ways ? 'done' : entry.pending ? 'loading' : 'failed';
  }

  // The station with the ways around the point, when they are on this device; null otherwise
  function withWays(st, stationKey, point) {
    const area = U.areaFor(st, point);
    if (!area) return null;
    const { k, entry } = areaEntry(stationKey, area);
    if (!entry || !entry.ways) return null;
    const e = extended.get(k);
    if (e && e.base === st) return e.st;
    const ext = U.withArea(st, area, entry.ways);
    extended.set(k, { base: st, st: ext });
    return ext;
  }

  // Loads the ways around the point (once); resolves true when they are there
  function loadWays(st, stationKey, point) {
    const area = U.areaFor(st, point);
    if (!area) return Promise.resolve(false);
    const { k, entry } = areaEntry(stationKey, area);
    if (entry) return entry.pending || Promise.resolve(!!entry.ways);
    const pending = overpass(U.areaQuery(area)).then(raw => {
      const ways = U.areaWays(st, raw);
      areas.set(k, { ways });
      store.set(k, JSON.stringify({ at: Date.now(), ways }));
      return true;
    }).catch(() => { areas.set(k, { failed: true }); return false; });
    areas.set(k, { pending });
    return pending;
  }

  // Ask again after a failure (the failure is kept so the app does not ask Overpass over and over by itself)
  function retryWays(st, stationKey, point) {
    const area = U.areaFor(st, point);
    if (!area) return Promise.resolve(false);
    const { k, entry } = areaEntry(stationKey, area);
    if (entry && entry.failed) areas.delete(k);
    return loadWays(st, stationKey, point);
  }

  // Worth loading? The point lies beyond the station radius, or the walk to it ends in a long straight line
  function needsWays(st, stationKey, point, r) {
    const area = U.areaFor(st, point);
    return !!area && areaState(st, stationKey, point) === 'none' &&
      (area.outside || !!(r && !r.error && r.method === 'walk' && r.tail >= U.TAIL_WARN));
  }

  window.StationData = { cacheKey, cached, file, overpass, build, model, areaState, withWays, loadWays, retryWays, needsWays };
})();
