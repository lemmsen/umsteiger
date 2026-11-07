/* Umsteiger – journey search (needs server.py): connections from A to B, with the place to board at every change */
(function () {
  'use strict';
  const U = window.Umstieg;
  const I = window.I18N, t = I.t;

  const C = window.Common, D = window.StationData;
  const { store, esc, pad, hm, delay, api, loadLeaflet } = C;
  C.applyTexts();

  const TRIP_KEY = 'umsteiger:trip';   // last origin and destination
  const $ = (id) => document.getElementById(id);

  const KIND = { steps: t('steps'), escalator: t('escalator'), elevator: t('elevator'), level: t('level') };
  const ZONE = { vorne: 'front', Mitte: 'middle', hinten: 'rear' };
  const ZONE_ORDER = ['vorne', 'Mitte', 'hinten'];
  const zoneAt = (z) => t('at.' + ZONE[z]);
  const kindsText = (kinds) => kinds.length > 1
    ? t('kindsAlso', { main: KIND[kinds[0]], others: kinds.slice(1).map(k => KIND[k]).join(', ') })
    : KIND[kinds[0]];
  // "In Eberswalde Hbf hinten einsteigen": the advice stands at the station of the change, but it is about where
  // you get on the train that takes you there
  const placeName = (n) => (n || '').replace(/,\s*[^,]+$/, '');   // "Pankstr.(U), Berlin" -> "Pankstr.(U)"
  function verdict(zones, place) {
    const where = I.or(ZONE_ORDER.filter(z => zones.includes(z)).map(zoneAt));
    const text = place ? t('r.verdictAt', { place: placeName(place), where }) : t('verdict', { where });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  const status = C.statusLine($('trip-status'));
  const busy = C.progress($('progress'));

  // ---------- Origin and destination ----------

  const FAV_KEY = 'umsteiger:fav';         // favourites { home, work }
  const RECENT_KEY = 'umsteiger:recenttrips';   // { places: [place], trips: [{ from, to }] } ('umsteiger:recent' = stations of app.js)
  const RECENT_PLACES = 5, RECENT_TRIPS = 3;
  const NEAR_NAME = 500;                   // m: a point on the map is named after a stop this close
  const readJson = (k) => { const v = C.readJson(k, {}); return v && typeof v === 'object' ? v : {}; };
  const keep = (p) => p ? { id: p.id, name: p.name, kind: p.kind, lat: p.lat, lon: p.lon } : null;
  // The own location keeps the text of the current language
  const named = (p) => p && p.kind === 'here' ? Object.assign({}, p, { name: t('r.here') }) : p;

  const saved = readJson(TRIP_KEY);
  const places = { from: named(saved.from) || null, to: named(saved.to) || null };
  const favs = readJson(FAV_KEY);
  const recent = Object.assign({ places: [], trips: [] }, readJson(RECENT_KEY));
  // Lists stored by version 55–58 could hold the same place twice (own location, points)
  const unique = (list, keyOf) => (Array.isArray(list) ? list : []).filter((e, i, all) => all.findIndex(o => keyOf(o) === keyOf(e)) === i);
  recent.places = unique(recent.places, U.placeKey);
  recent.trips = unique(recent.trips, U.tripKey);
  const FAVS = ['home', 'work'];
  const ICON = { home: '🏠', work: '💼', here: '📍', map: '🗺️', recent: '🕘' };
  const PLACE_KIND = { station: t('r.kind.station'), address: t('r.kind.address'), place: t('r.kind.place'), point: t('r.kind.point') };
  const setting = { from: null, to: null };   // favourite that the next place chosen in this field becomes

  // Suggestions under a field: search results while typing, otherwise own location, map, favourites and
  // recent places. Entry: { title } or { icon, label, sub, run, edit, remove }
  function placeField(which) {
    const input = $('trip-' + which), list = $('trip-' + which + '-list');
    input.value = places[which] ? places[which].name : '';
    let timer = null, asked = '';
    const show = (items) => {
      list.innerHTML = items.map((it, i) => it.title ? `<li class="res-title">${esc(it.title)}</li>` :
        `<li class="res-row${it.quiet ? ' quiet' : ''}"><a href="#" data-i="${i}">${it.icon ? `<span class="res-icon" aria-hidden="true">${it.icon}</span>` : ''}` +
        `<span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></a>` +
        (it.edit ? `<button type="button" class="res-btn" data-edit="${i}" aria-label="${esc(t('r.favEdit'))}">✎</button>` : '') +
        (it.remove ? `<button type="button" class="res-btn" data-remove="${i}" aria-label="${esc(t('r.favRemove'))}">×</button>` : '') +
        '</li>').join('');
      list._items = items;
    };
    const showMenu = () => show(menu(which));
    input.addEventListener('focus', () => {
      if (input.value.trim().length < 2 || places[which]) showMenu();
      if (places[which]) input.select();
    });
    input.addEventListener('input', () => {
      places[which] = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { asked = ''; showMenu(); return; }
      timer = setTimeout(async () => {
        asked = q;
        try {
          const res = await api('places?q=' + encodeURIComponent(q));
          if (asked === q) show(res.places.map(p => ({ label: p.name, sub: PLACE_KIND[p.kind], run: () => choosePlace(which, p) })));
        } catch (e) { noServer(e); }
      }, 250);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { show([]); endSetting(which); } });
    list.addEventListener('click', (e) => {
      const el = e.target.closest('a, button');
      if (!el) return;
      e.preventDefault();
      const it = list._items[Number(el.dataset.i ?? el.dataset.edit ?? el.dataset.remove)];
      if (el.dataset.edit !== undefined) it.edit();
      else if (el.dataset.remove !== undefined) it.remove();
      else it.run();
    });
    return { input, list, show, showMenu };
  }

  function menu(which) {
    const fav = setting[which];
    const onMap = { icon: ICON.map, label: t('r.onMap'), run: () => pickOnMap(which) };
    if (fav) return [{ title: t('r.favHint', { fav: t('r.' + fav) }) }, onMap];
    const items = [];
    if (which === 'from') items.push({ icon: ICON.here, label: t('r.here'), run: () => useHere(which) });
    items.push(onMap);
    for (const f of FAVS) {
      const p = favs[f];
      items.push(p
        ? { icon: ICON[f], label: t('r.' + f), sub: p.name, run: () => choosePlace(which, p),
          edit: () => startSetting(which, f), remove: () => setFav(f, null) }
        : { icon: ICON[f], label: t('r.favSet', { fav: t('r.' + f) }), quiet: true, run: () => startSetting(which, f) });
    }
    const isFav = (p) => FAVS.some(f => favs[f] && U.placeKey(favs[f]) === U.placeKey(p));
    const rec = recent.places.filter(p => !isFav(p));
    if (rec.length) {
      items.push({ title: t('r.recent') });
      for (const p of rec) items.push({ icon: ICON.recent, label: p.name, sub: PLACE_KIND[p.kind], run: () => choosePlace(which, p) });
    }
    return items;
  }
  const fields = { from: placeField('from'), to: placeField('to') };

  // Lists close when tapping elsewhere
  document.addEventListener('pointerdown', (e) => {
    for (const which of ['from', 'to']) {
      if (!e.target.closest('#trip-' + which + ', #trip-' + which + '-list')) fields[which].show([]);
    }
  });

  function setPlace(which, p) {
    places[which] = keep(p);
    fields[which].input.value = p ? p.name : '';
    fields[which].show([]);
    store.set(TRIP_KEY, JSON.stringify(places));
  }

  // A place chosen while a favourite is being set becomes that favourite (and fills the field)
  function choosePlace(which, p) {
    const fav = setting[which];
    endSetting(which);
    if (fav && p) { setFav(fav, p); status(t('r.favSaved', { fav: t('r.' + fav) })); }
    setPlace(which, p);
  }

  function startSetting(which, fav) {
    setting[which] = fav;
    const f = fields[which];
    f.input.value = '';
    f.input.placeholder = t('r.favPlaceholder', { fav: t('r.' + fav) });
    f.input.focus();
    f.showMenu();
  }
  function endSetting(which) {
    if (!setting[which]) return;
    setting[which] = null;
    fields[which].input.placeholder = t('r.placeholder');
    if (!fields[which].input.value && places[which]) fields[which].input.value = places[which].name;
  }

  function setFav(f, p) {
    if (p) favs[f] = keep(p); else delete favs[f];
    store.set(FAV_KEY, JSON.stringify(favs));
    renderQuick();
    for (const which of ['from', 'to']) if (fields[which].list.children.length) fields[which].showMenu();
  }

  $('trip-swap').addEventListener('click', () => {
    const f = places.from, to = places.to;
    endSetting('from'); endSetting('to');
    setPlace('from', to);
    setPlace('to', f);
  });

  // ----- Own location (asked only when tapped, located again before every search) -----

  const locate = () => new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('unsupported')); return; }
    navigator.geolocation.getCurrentPosition(p => resolve(p.coords), reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
  async function locateHere() {
    for (const which of ['from', 'to']) {
      if (!places[which] || places[which].kind !== 'here') continue;
      status(t('r.locating'));
      const c = await locate();
      setPlace(which, U.pointPlace(c.latitude, c.longitude, t('r.here'), 'here'));
    }
  }
  async function useHere(which) {
    endSetting(which);
    setPlace(which, { id: '', name: t('r.here'), kind: 'here' });
    try {
      await locateHere();
      status('');
    } catch (e) {
      setPlace(which, null);
      status(t('r.hereFailed'), true);
    }
  }

  // ----- Point on the map (Leaflet is loaded only when needed) -----

  let pick = null;

  async function pickOnMap(which) {
    const fav = setting[which];
    fields[which].show([]);
    if (document.activeElement) document.activeElement.blur();
    const card = $('pick-card');
    $('pick-title').textContent = fav ? t('r.favPlaceholder', { fav: t('r.' + fav) }) : t(which === 'from' ? 'r.pickFrom' : 'r.pickTo');
    card.hidden = false;
    let L;
    try { L = await loadLeaflet(); } catch (e) { card.hidden = true; status(t('r.mapOffline'), true); return; }
    if (!pick) {
      const map = L.map('pick-map').setView([52.52, 13.405], 12);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' }).addTo(map);
      pick = { map, marker: null, at: null, which };
      map.on('click', (e) => setPick(e.latlng));
    }
    pick.which = which;
    pick.at = null;
    if (pick.marker) { pick.marker.remove(); pick.marker = null; }
    $('pick-ok').disabled = true;
    // Start where the field (or the other one, or a favourite) already is, else in Berlin
    const other = which === 'from' ? 'to' : 'from';
    const near = [places[which], places[other], favs.home, favs.work, ...recent.places].find(p => p && p.lat != null);
    pick.map.invalidateSize();
    pick.map.setView(near ? [near.lat, near.lon] : [52.52, 13.405], near ? 15 : 12);
    const cur = places[which];
    if (cur && cur.kind === 'point' && !fav) setPick({ lat: cur.lat, lng: cur.lon });
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function setPick(latlng) {
    pick.at = latlng;
    if (pick.marker) pick.marker.setLatLng(latlng);
    else pick.marker = window.L.marker(latlng).addTo(pick.map);
    $('pick-ok').disabled = false;
  }
  function closePick() {
    $('pick-card').hidden = true;
    if (pick) endSetting(pick.which);
  }
  $('pick-cancel').addEventListener('click', closePick);
  $('pick-ok').addEventListener('click', async () => {
    if (!pick || !pick.at) return;
    const which = pick.which;
    const lat = Math.round(pick.at.lat * 1e5) / 1e5, lon = Math.round(pick.at.lng * 1e5) / 1e5;
    $('pick-card').hidden = true;
    // Named after the closest stop, so it can be told apart in the lists
    let name = t('r.mapPoint');
    busy(true);
    try {
      const res = await api(`nearby?lat=${lat}&lon=${lon}`);
      if (res.stop && res.stop.distance <= NEAR_NAME) name = t('r.mapPointNear', { stop: res.stop.name });
    } catch (e) { /* keep the plain name */ }
    busy(false);
    choosePlace(which, U.pointPlace(lat, lon, name));
  });

  // ----- Commute in one tap and recent searches -----

  function renderQuick() {
    const trips = [];
    if (favs.home && favs.work) {
      trips.push({ label: `${ICON.home} ${t('r.home')} → ${ICON.work} ${t('r.work')}`, from: favs.home, to: favs.work });
      trips.push({ label: `${ICON.work} ${t('r.work')} → ${ICON.home} ${t('r.home')}`, from: favs.work, to: favs.home });
    }
    const shown = new Set(trips.map(U.tripKey));
    for (const tr of recent.trips) {
      if (shown.has(U.tripKey(tr))) continue;
      shown.add(U.tripKey(tr));
      trips.push({ label: `${named(tr.from).name} → ${named(tr.to).name}`, from: named(tr.from), to: named(tr.to) });
    }
    const row = $('trip-quick');
    row.hidden = !trips.length;
    row.innerHTML = trips.map((tr, i) => `<button type="button" class="chip" data-i="${i}">${esc(tr.label)}</button>`).join('');
    row._trips = trips;
  }
  $('trip-quick').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const tr = $('trip-quick')._trips[Number(b.dataset.i)];
    endSetting('from'); endSetting('to');
    setPlace('from', tr.from);
    setPlace('to', tr.to);
    search();
  });
  renderQuick();

  function remember() {
    for (const p of [places.from, places.to]) {
      if (p.kind !== 'here') recent.places = U.addRecent(recent.places, keep(p), U.placeKey, RECENT_PLACES);
    }
    recent.trips = U.addRecent(recent.trips, { from: keep(places.from), to: keep(places.to) }, U.tripKey, RECENT_TRIPS);
    store.set(RECENT_KEY, JSON.stringify(recent));
    renderQuick();
  }

  $('trip-when').value = C.localTime(new Date());

  function noServer(e) {
    // A plain web server (no server.py) answers /api/ with 404 or with the page itself
    status(e && e.status && e.status !== 404 ? t('r.failed', { msg: e.message }) : t('r.noServer'), true);
  }

  // ---------- Journeys ----------

  let result = null;      // last answer of /api/journeys
  let opened = null;      // index of the expanded journey

  // No journey for short distances: then walking is the answer
  const NEAR_WALK = 1000;   // m
  function near(a, b) {
    if (!a || !b || a.lat == null || b.lat == null) return false;
    const [x, y] = U.projector(a.lat, a.lon).xy(b.lat, b.lon);
    return Math.hypot(x, y) < NEAR_WALK;
  }

  async function search(page) {
    if (!places.from || !places.to) { status(t('r.chooseBoth'), true); return; }
    busy(true);
    try {
      if (!page) {
        try { await locateHere(); } catch (e) { status(t('r.hereFailed'), true); return; }
        remember();
      }
      status(t('r.searching'));
      const q = `from=${encodeURIComponent(places.from.id)}&to=${encodeURIComponent(places.to.id)}` +
        `&when=${encodeURIComponent($('trip-when').value)}${$('trip-mode').value === 'arr' ? '&arrive=1' : ''}` +
        (page ? '&page=' + encodeURIComponent(page) : '');
      result = await api('journeys?' + q);
      result.query = { from: places.from.id, to: places.to.id };
      result.at = Date.now();
      closeAllMaps();     // before forgetting their views: closing stores the view
      opened = null;
      mapsOpen.clear();
      views.clear();
      tempOverride.clear(); // choices for points of the old journeys: a new search starts with the shortest way
      stopsOpen.clear();
      connTimes.clear();
      status(result.journeys.length ? '' : t(near(places.from, places.to) ? 'r.noneNear' : 'r.none'));
      renderTrips();
      precompute();
    } catch (e) {
      noServer(e);
    } finally {
      busy(false);
    }
  }
  $('trip-search').addEventListener('click', () => search());
  // Step-free only changes the walks: times to change are worked out again
  $('trip-lift').addEventListener('change', () => {
    if (!result) return;
    connTimes.clear();
    renderTrips();
    precompute();
  });
  $('trip-earlier').addEventListener('click', () => result && search(result.earlier));
  $('trip-later').addEventListener('click', () => result && search(result.later));

  const durationText = (s) => {
    const m = Math.round((s || 0) / 60);
    return m >= 60 ? t('r.hours', { h: Math.floor(m / 60), m: pad(m % 60) }) : t('r.minutes', { m });
  };
  const changesText = (n) => n ? t(n === 1 ? 'r.change1' : 'r.changes', { n }) : t('r.direct');
  const timeHtml = C.timeHtml;
  const trackHtml = (s) => { const h = C.trackHtml(s); return h ? ' ' + h : ''; };
  // Messages of the journey planner: important ones as a warning, the others folded away
  function notesHtml(notes) {
    const high = (notes || []).filter(n => n.high), low = (notes || []).filter(n => !n.high);
    return high.map(n => `<p class="warn">${esc(n.text)}</p>`).join('') + (low.length
      ? `<details class="notes"><summary>${esc(t(low.length === 1 ? 'r.note1' : 'r.notes', { n: low.length }))}</summary>${low.map(n => `<p>${esc(n.text)}</p>`).join('')}</details>` : '');
  }
  const stopHtml = (s, gone) => `<div class="leg-stop">${timeHtml(s, gone)} ${esc(s.name)}${trackHtml(s)}` +
    `${s.cancelled ? ` <span class="late">${esc(t('r.stopCancelled'))}</span>` : ''}</div>${notesHtml(s.notes)}`;

  // Is there enough time to change? Before the station model is loaded with the walks of the journey planner, then
  // with the walk of the recommendation (connTimes, per journey and leg)
  const connTimes = new Map();
  const CONN_RANK = { ok: 0, tight: 1, risk: 2, cancelled: 3 };
  function worstConnection(j) {
    let worst = null;
    for (const stop of U.journeyStops(j)) {
      const c = connTimes.get(j.id + '|' + stop.legIndex) || U.connectionTime(stop, null, j.legs);
      if (c && (!worst || CONN_RANK[c.level] > CONN_RANK[worst.level])) worst = c;
    }
    return worst;
  }
  function metaHtml(j) {
    const cancelled = j.legs.some(l => l.cancelled || l.from.cancelled || l.to.cancelled);
    const c = worstConnection(j);
    const flag = cancelled ? t('r.cancelled') : c && c.level === 'risk' ? t('r.connRiskShort') : c && c.level === 'tight' ? t('r.connTightShort') : '';
    const warn = !flag && [j, ...j.legs].some(x => (x.notes || []).some(n => n.high));
    return `${esc(durationText(j.duration))} · ${esc(changesText(j.changes))}` +
      (flag ? ` · <span class="${c && c.level === 'tight' && !cancelled ? 'minor' : 'late'}">${esc(flag)}</span>` : '') +
      (warn ? ` · <span class="minor">${esc(t('r.disruption'))}</span>` : '');
  }
  function connHtml(c) {
    if (!c) return '';
    if (c.level === 'cancelled') return `<p class="conn risk">${esc(t('r.conn.cancelled'))}</p>`;
    const p = { m: c.minutes, need: c.need };
    const text = c.level === 'ok' ? t('r.conn.ok', p) : c.level === 'tight' ? t('r.conn.tight', p) : t('r.conn.risk', p);
    return `<p class="conn ${c.level}">${esc(text)}</p>`;
  }
  const kindClass = (p) => ({ SBAHN: 's', UBAHN: 'u', BUS: 'b', TRAM: 't' }[p] || 'r');

  function renderTrips() {
    closeAllMaps();
    const list = (result && result.journeys) || [];
    $('trip-earlier-row').hidden = !(result && result.earlier && list.length);
    $('trip-later-row').hidden = !(result && result.later && list.length);
    $('trips').innerHTML = list.map((j, i) => {
      const first = j.legs[0], last = j.legs[j.legs.length - 1];
      const lines = j.legs.filter(l => l.mode === 'transit')
        .map(l => `<span class="line-chip ${kindClass(l.product)}">${esc(l.line)}</span>`).join('');
      return `<article class="card trip${i === opened ? ' open' : ''}" data-i="${i}">
        <button type="button" class="trip-head" aria-expanded="${i === opened}">
          <span class="trip-times">${timeHtml(first.from)} – ${timeHtml(last.to)}</span>
          <span class="trip-meta">${metaHtml(j)}</span>
          <span class="trip-lines">${lines}</span>
        </button>
        ${i === opened ? `<div class="legs">${refreshHtml(j)}${notesHtml(j.notes)}${legsHtml(j)}</div>` : ''}
      </article>`;
    }).join('');
    if (opened !== null) {
      if (routeOpen) drawRoute(list[opened]);
      // Stops on the way are fetched right away, so they are there when the list is opened
      list[opened].legs.forEach((l, k) => {
        if (l.mode === 'transit' && l.stops > 0 && l.journeyId) legShape(l);
        fillStops(list[opened], k);
      });
      advise(list[opened]);
    }
  }

  // ----- Refresh the opened journey: on request and every minute while the page is visible -----

  const REFRESH_SECONDS = 60;
  const clock = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const refreshHtml = (j) => `<div class="refresh-row"><span class="muted">${esc(t('r.asOf', { time: clock(j.at || result.at) }))}</span>` +
    `<span class="row-btns"><button type="button" class="link-btn route-btn" aria-expanded="${routeOpen}">${esc(t(routeOpen ? 'r.routeHide' : 'r.routeShow'))}</button>` +
    `<button type="button" class="link-btn refresh-btn">${esc(t('r.refresh'))}</button></span></div>` +
    `<div class="route-map"${routeOpen ? '' : ' hidden'}></div>`;
  // What the user sees of a journey (without the id, which may change on refresh)
  const visible = (j) => JSON.stringify([j.legs, j.notes]);
  let refreshing = false;
  async function refresh(quiet) {
    const i = opened;
    if (i === null || refreshing || !result) return;
    const j = result.journeys[i];
    refreshing = true;
    if (!quiet) busy(true);
    try {
      const res = await api(`journey?id=${encodeURIComponent(j.id)}&from=${encodeURIComponent(result.query.from)}&to=${encodeURIComponent(result.query.to)}`);
      if (opened !== i || result.journeys[i] !== j) return; // something else was opened meanwhile
      if (!res.journey) { if (!quiet) status(t('r.refreshGone'), true); return; }
      j.at = Date.now();
      if (visible(res.journey) === visible(j)) {
        document.querySelector('.trip.open .refresh-row .muted').textContent = t('r.asOf', { time: clock(j.at) });
      } else {
        // Keep the id of the search (a refresh may send a new one): times to change are stored under it
        for (const k of [...connTimes.keys()]) if (k.startsWith(j.id + '|')) connTimes.delete(k);
        result.journeys[i] = Object.assign(res.journey, { id: j.id, at: j.at });
        renderTrips();
      }
      if (!quiet) status('');
    } catch (e) {
      if (!quiet) noServer(e);
    } finally {
      refreshing = false;
      if (!quiet) busy(false);
    }
  }
  setInterval(() => { if (document.visibilityState === 'visible') refresh(true); }, REFRESH_SECONDS * 1000);
  document.addEventListener('visibilitychange', () => {
    const j = result && opened !== null && result.journeys[opened];
    if (document.visibilityState === 'visible' && j && Date.now() - (j.at || result.at) > REFRESH_SECONDS * 1000) refresh(true);
  });

  // ----- Stops on the way of a leg (from the course of the leg, like the map) -----

  const stopsOpen = new Set();   // '<journey>:<leg>'
  const stopsHtml = (l, i) => {
    const open = stopsOpen.has(opened + ':' + i);
    return `<button type="button" class="link-btn stops-btn" data-leg="${i}" aria-expanded="${open}">` +
      `${esc(t(l.stops === 1 ? 'r.stops1' : 'r.stops', { n: l.stops }))} ${open ? '▴' : '▾'}</button>` +
      `<ol class="leg-stops" data-leg="${i}"${open ? '' : ' hidden'}></ol>`;
  };
  async function fillStops(j, i) {
    const box = document.querySelector(`.trip.open .leg-stops[data-leg="${i}"]`);
    if (!box || box.hidden) return;
    if (!box.children.length) box.innerHTML = `<li class="muted">${esc(t('r.loadingStops'))}</li>`;
    const sh = await legShape(j.legs[i]);
    if (!box.isConnected) return;
    box.innerHTML = sh && sh.stops.length > 2
      ? sh.stops.slice(1, -1).map(st => `<li>${timeHtml(st)} ${esc(st.name)}</li>`).join('')
      : `<li class="muted">${esc(t('d.courseFailed'))}</li>`;
  }
  function toggleStops(i) {
    const key = opened + ':' + i;
    if (stopsOpen.has(key)) stopsOpen.delete(key); else stopsOpen.add(key);
    const j = result.journeys[opened];
    const btn = document.querySelector(`.trip.open .stops-btn[data-leg="${i}"]`);
    btn.outerHTML = stopsHtml(j.legs[i], i).replace(/<ol[\s\S]*$/, '');
    document.querySelector(`.trip.open .leg-stops[data-leg="${i}"]`).hidden = !stopsOpen.has(key);
    fillStops(j, i);
  }

  // ----- The whole journey on a map: lines in their colours, walks dashed, changes to tap -----

  const ROUTE_KEY = 'umsteiger:routemap';   // map of the journey open (remembered)
  let routeOpen = store.get(ROUTE_KEY) === '1';
  const LINE_COLOR = { s: '#008d4f', u: '#0065ae', b: '#95276e', t: '#cc0a22', r: '#c8102e' };
  // Course of a leg (line and stops on the way): comes with the journey
  const legShape = (l) => Promise.resolve(l.shape || null);

  async function drawRoute(j) {
    const box = document.querySelector('.trip.open .route-map');
    if (!box) return;
    const key = 'route:' + opened;
    let L;
    try { L = await loadLeaflet(); } catch (e) { box.innerHTML = `<p class="muted">${esc(t('r.mapOffline'))}</p>`; return; }
    if (!box.isConnected || box.hidden || maps.has(key)) return;
    const has = (s) => s && s.lat != null && s.lon != null;
    const pos = (s) => [s.lat, s.lon];
    const legs = j.legs.filter(l => has(l.from) && has(l.to));
    if (!legs.length) return;
    const map = StationMap.create(box, legs[0].from.lat, legs[0].from.lon);
    maps.set(key, map);
    const layer = L.layerGroup().addTo(map);
    const bounds = [];
    for (const l of legs) {
      bounds.push(pos(l.from), pos(l.to));
      if (l.mode === 'walk') {
        L.polyline([pos(l.from), pos(l.to)], { color: '#6b7570', weight: 3, dashArray: '4 7', interactive: false }).addTo(layer);
        continue;
      }
      // Straight line first, the course of the leg as soon as it is there
      const color = LINE_COLOR[kindClass(l.product)];
      const line = L.polyline([pos(l.from), pos(l.to)], { color, weight: 5, opacity: 0.9 }).addTo(layer);
      line.bindTooltip(l.line + (l.direction ? ' · ' + t('r.towards', { to: l.direction }) : ''), { sticky: true });
      if (!l.journeyId) continue;
      legShape(l).then(sh => {
        if (!sh || maps.get(key) !== map) return;
        if (sh.points.length >= 2) line.setLatLngs(sh.points);
        for (const st of sh.stops.slice(1, -1)) {
          L.circleMarker(pos(st), { radius: 3, color, weight: 2, fillColor: '#fff', fillOpacity: 1 })
            .bindTooltip(`${hm(st.time)} ${st.name}`).addTo(layer);
        }
      });
    }
    // Changes and the end of each ride: tapping one opens the map of that station further down
    const dot = (p, fill, tip, onClick) => {
      const m = L.circleMarker(p, { radius: 8, color: '#17201b', weight: 2, fillColor: fill, fillOpacity: 1, bubblingMouseEvents: false })
        .bindTooltip(tip).addTo(layer);
      if (onClick) m.on('click', onClick);
    };
    for (const stop of U.journeyStops(j)) {
      const a = stop.arrive.to;
      if (has(a)) dot(pos(a), '#fff', `${a.name} · ${t('r.routeTapStation')}`, () => openStationMap(stop.legIndex));
    }
    const first = legs[0].from, last = legs[legs.length - 1].to;
    dot(pos(first), '#2d6cdf', first.name || t('r.from'));
    dot(pos(last), '#17201b', last.name || t('r.to'));
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
  }

  // Station map of one change below, opened and scrolled into view
  function openStationMap(legIndex) {
    const el = document.querySelector(`.trip.open .advice[data-leg="${legIndex}"]`);
    if (!el) return;
    const btn = el.querySelector('.map-btn');
    if (btn && !mapsOpen.has(opened + ':' + legIndex)) btn.click();
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toggleRoute() {
    routeOpen = !routeOpen;
    store.set(ROUTE_KEY, routeOpen ? '1' : '');
    const box = document.querySelector('.trip.open .route-map'), btn = document.querySelector('.trip.open .route-btn');
    btn.textContent = t(routeOpen ? 'r.routeHide' : 'r.routeShow');
    btn.setAttribute('aria-expanded', String(routeOpen));
    box.hidden = !routeOpen;
    if (routeOpen) drawRoute(result.journeys[opened]); else closeMap('route:' + opened);
  }

  $('trips').addEventListener('click', (e) => {
    if (e.target.closest('.refresh-btn')) { refresh(false); return; }
    if (e.target.closest('.route-btn')) { toggleRoute(); return; }
    const sb = e.target.closest('.stops-btn');
    if (sb) { toggleStops(Number(sb.dataset.leg)); return; }
    const head = e.target.closest('.trip-head');
    if (!head) return;
    const i = Number(head.parentElement.dataset.i);
    opened = opened === i ? null : i;
    renderTrips();
  });

  function legsHtml(j) {
    return j.legs.map((l, i) => {
      if (l.mode === 'walk') {
        return `<div class="leg walk">${esc(t('r.walkLeg', { m: Math.round(l.distance || 0) }))}</div>`;
      }
      return `<div class="leg">
        <div class="leg-line"><span class="line-chip ${kindClass(l.product)}">${esc(l.line)}</span>
          ${l.direction ? `<span class="muted">${esc(t('r.towards', { to: l.direction }))}</span>` : ''}
          ${l.cancelled ? `<span class="late">${esc(t('r.cancelled'))}</span>` : ''}</div>
        ${stopHtml(l.from, l.cancelled)}
        ${l.stops > 0 && l.journeyId ? stopsHtml(l, i) : ''}
        ${stopHtml(l.to, l.cancelled)}
        ${notesHtml(l.notes)}
        <div class="advice" data-leg="${i}" hidden></div>
      </div>`;
    }).join('');
  }

  // ---------- Where to board: station models of the stations in the journey ----------

  let index = null;
  async function stationIndex() {
    if (!index) index = fetch('data/index.json').then(r => r.ok ? r.json() : null).then(d => d ? d.stations : []).catch(() => []);
    return index;
  }

  // Station model from the prepared files, stored like in the station view (so "view station" opens at once)
  const stationModel = D.model;

  // Destination outside the station when the journey ends there: a point set in the station view, else an exit
  const pointKey = (id) => 'umsteiger:point:' + id;
  const exitKey = (id) => 'umsteiger:tripexit:' + id;
  function savedPoint(id) {
    try { const p = JSON.parse(store.get(pointKey(id))); if (p && isFinite(p.lat) && isFinite(p.lon)) return p; } catch (e) { /* none */ }
    return null;
  }

  async function advise(j) {
    const stops = U.journeyStops(j);
    if (!stops.length) return;
    const rows = await stationIndex();
    for (const stop of stops) {
      const el = document.querySelector(`.trip.open .advice[data-leg="${stop.legIndex}"]`);
      if (!el) return; // another journey was opened meanwhile
      el.hidden = false;
      el.innerHTML = `<p class="muted">${esc(t('r.loadingAdvice'))}</p>`;
      const a = stop.arrive;
      const m = U.matchStation(rows, a.to.lat, a.to.lon, a.to.name);
      const st = m && await stationModel(m.id);
      showAdvice(el, stop, st);
    }
  }

  // Station maps opened under a change ('<journey>:<leg>'), with their Leaflet maps
  const mapsOpen = new Set(), maps = new Map();
  // View of a station map, kept when it is drawn again (after a tap, a refresh, "step-free only"); per journey
  // and station, because the keys of maps are only positions in the list
  const views = new Map();
  function closeMap(key) {
    if (!maps.has(key)) return;
    const map = maps.get(key);
    if (map._viewKey) views.set(map._viewKey, { center: map.getCenter(), zoom: map.getZoom() });
    map.remove();
    maps.delete(key);
  }
  function closeAllMaps() { for (const key of [...maps.keys()]) closeMap(key); }

  // An access point chosen by hand (on the map or in the list) is stored like in the station view, per platform
  // and target, so both views agree – also for the point stored for the station. Not for points that come from
  // the journey (they change with every search): those choices last only while the page is open.
  const OVR_KEY = 'umsteiger:override:';
  const ovrKey = (adv, s) => !adv || !adv.plat ? null : typeof adv.target === 'string' ? OVR_KEY + adv.plat + '>' + adv.target
    : s.fromStationView ? OVR_KEY + adv.plat + '>' + U.POINT_KEY : null;
  const tempOverride = new Map();
  const getOverride = (k, tmp) => k ? store.get(k) : tempOverride.get(tmp) || null;
  const setOverride = (k, tmp, v) => { if (k) store.set(k, v); else tempOverride.set(tmp, v); };

  // Selection of the station view (shared train length, see app.js)
  const selKey = (id) => 'umsteiger:sel:' + id;
  const readSel = (id) => { const v = C.readJson(selKey(id), {}); return v && typeof v === 'object' ? v : {}; };

  // Arriving train with its coach sequence (like "Mein Zug (live)" in the station view); only kinds of train
  // for which DB may have one. journeyId|eva -> { info } once known (info null: none)
  // Empty for now: the coach sequences came from bahn.de, which blocks them since November 2026; the kinds
  // were 'ICE', 'EC_IC', 'IR', 'REGIONAL', 'SBAHN'.
  const LIVE_PRODUCTS = new Set();
  const liveInfo = new Map(), livePending = new Map();
  function liveTrain(a, st) {
    if (!a.journeyId || !LIVE_PRODUCTS.has(a.product)) return null;
    const k = a.journeyId + '|' + (a.to.eva || '');
    if (liveInfo.has(k)) return { info: liveInfo.get(k) };
    if (!livePending.has(k)) {
      livePending.set(k, api(`train?eva=${encodeURIComponent(a.to.eva || '')}&lat=${st.center.lat}&lon=${st.center.lon}` +
        `&journeyId=${encodeURIComponent(a.journeyId)}`).catch(() => null).then(info => { liveInfo.set(k, info); return info; }));
    }
    return { pending: livePending.get(k) };
  }
  // Position of the train on the platform from its coach sequence, as in the station view (null: not placed)
  function placeTrain(st, plat, info) {
    if (!info || !info.sequence) return null;
    const dir = U.liveDirection(st, plat, info.approach || info.prev, info.prev && info.prev.name);
    const m = U.mapSequence(st, plat, info.sequence, dir && dir.frontSign);
    return m && m.check !== 'conflict' ? m : null; // contradicting the stop signs: rather none than a mirrored one
  }

  // Recommendation for a stop as shown: with the access point chosen by hand, the train length of the station
  // and (when known) the live train placed by its coach sequence. key: '<journey>:<leg>'
  function computeAdvice(st, s, key, placed) {
    const opts = { liftOnly: $('trip-lift').checked };
    let adv = U.transferAdvice(st, s, opts);
    const choices = !placed && adv.rec && adv.rec.opt ? U.trainChoices(st, adv.rec.opt) : [];
    const len = readSel(st.id).len || '';
    const k = ovrKey(adv, s), tmp = key + '|' + adv.plat + '|' + JSON.stringify(adv.target || '');
    Object.assign(opts, { override: getOverride(k, tmp), trainRange: placed,
      train: !placed && choices.some(c => c.key === len) ? len : null });
    if (opts.override || opts.trainRange || opts.train) adv = U.transferAdvice(st, s, opts);
    return { adv, opts, choices, k, tmp };
  }

  // Time to change of every journey with the walk of its recommendation, worked out in the background right
  // after the search: the head of a journey then says the same as its changes, open or closed
  async function precompute() {
    const res = result;
    const rows = await stationIndex();
    for (const [i, j] of res.journeys.entries()) {
      for (const stop of U.journeyStops(j)) {
        const ck = j.id + '|' + stop.legIndex;
        if (!stop.depart || connTimes.has(ck)) continue;
        const a = stop.arrive;
        const m = U.matchStation(rows, a.to.lat, a.to.lon, a.to.name);
        const st = m && await stationModel(m.id);
        if (result !== res || connTimes.has(ck)) break; // new search, or the change was shown meanwhile
        if (!st) continue;
        const { adv } = computeAdvice(st, stop, i + ':' + stop.legIndex, null);
        const conn = U.connectionTime(stop, adv.rec && !adv.rec.error ? adv.rec : null, j.legs);
        if (!conn) continue;
        connTimes.set(ck, conn);
        const meta = document.querySelector(`.trip[data-i="${i}"] .trip-meta`);
        if (meta) meta.innerHTML = metaHtml(j);
      }
      if (result !== res) return;
    }
  }

  function showAdvice(el, stop, st) {
    const key = opened + ':' + stop.legIndex;
    const j = result.journeys[opened];
    closeMap(key);
    el.classList.remove('quiet');
    if (!st) {
      el.innerHTML = connHtml(U.connectionTime(stop, null, j.legs)) + adviceHtml(stop, null, { code: 'noStation' });
      el.classList.add('quiet');
      return;
    }
    const redraw = () => { if (el.isConnected) showAdvice(el, stop, st); };
    // Journey ends in the station without a known destination: an exit from the list, or a point tapped on the map
    const canPoint = stop.kind === 'leave' && !stop.point;
    let s = stop, exits = [];
    // The point stored for this station is one entry of the list, used only when chosen (or tapped here) –
    // a point set weeks ago for another errand must not silently become the destination
    if (canPoint) {
      exits = st.targets.filter(x => x.exit);
      const chosen = store.get(exitKey(st.id));
      const p = savedPoint(st.id);
      if (p) exits = exits.concat({ key: U.POINT_KEY, label: t('r.lastPoint') });
      if (chosen === U.POINT_KEY && p) s = Object.assign({}, stop, { point: p, fromStationView: true });
      else if (chosen && exits.some(x => x.key === chosen)) s = Object.assign({}, stop, { point: chosen });
    }
    // To a bus or tram: its stop as mapped in OSM (the journey planner gives it only roughly)
    s = U.snapStop(st, s);
    // Live train placed by its coach sequence; otherwise the train length chosen for this station
    const plat = U.transferAdvice(st, s, { liftOnly: $('trip-lift').checked }).plat;
    const lt = plat ? liveTrain(stop.arrive, st) : null;
    if (lt && lt.pending && !el._waiting) { el._waiting = true; lt.pending.then(() => { el._waiting = false; redraw(); }); }
    const placed = lt && lt.info ? placeTrain(st, plat, lt.info) : null;
    // Destination beyond the station data: with the ways loaded around it (when they are on this device)
    const pt = s.point && typeof s.point === 'object' ? s.point : null;
    const stx = (pt && D.withWays(st, st.id, pt)) || st;
    const { adv, opts, choices, k, tmp } = computeAdvice(stx, s, key, placed);
    if (pt && D.needsWays(st, st.id, pt, adv.rec) && !el._area) { el._area = true; D.loadWays(st, st.id, pt).then(() => { el._area = false; redraw(); }); }
    const areaState = pt ? D.areaState(st, st.id, pt) : '';
    const rec = adv.rec && !adv.rec.error ? adv.rec : null;
    const open = mapsOpen.has(key);
    // Time to change with the walk of the recommendation; the head of the journey shows the worst change
    const conn = U.connectionTime(stop, rec, j.legs);
    if (conn) {
      connTimes.set(j.id + '|' + stop.legIndex, conn);
      const meta = el.closest('.trip').querySelector('.trip-meta');
      if (meta) meta.innerHTML = metaHtml(j);
    }
    // The map as in the station view: all access points above it, train length, hint below
    const card = !open ? '' : `<div class="advice-card">` +
      (rec ? `<div class="alts-row"><label>${esc(t('allAccesses'))}</label><select class="alts">${StationMap.spotOptions(rec)}</select></div>` : '') +
      (choices.length ? `<div class="len-row"><label>${esc(t('trainLength'))}</label><select class="len">` +
        `<option value="">${esc(t('wholePlatform'))}</option>` + choices.map(c => `<option value="${esc(c.key)}"${c.key === opts.train ? ' selected' : ''}>` +
        `${esc(c.estimated ? t('lengthEstimated', { label: c.label }) : c.label)}</option>`).join('') + '</select></div>' : '') +
      (placed ? `<p class="live-info">${esc(liveText(lt.info, placed, stop.arrive.line))}</p>` : '') +
      `<div class="advice-map"></div><p class="hint">${esc(canPoint ? t('mapHintPoint') + ' ' + t('mapArea') : t('mapHint'))}</p></div>`;
    el.innerHTML = connHtml(conn) + adviceHtml(s, st, adv, exits, open, placed, areaState) + card;
    if (!rec) el.classList.add('quiet');
    const on = (sel, fn) => { const x = el.querySelector(sel); if (x) x.addEventListener('change', () => fn(x.value)); };
    on('.exit-sel', (v) => { store.set(exitKey(st.id), v); redraw(); });
    const retry = el.querySelector('.area-retry');
    if (retry) retry.addEventListener('click', () => { D.retryWays(st, st.id, pt).then(redraw); redraw(); });
    // Choosing another access point overrides the recommendation, choosing the recommended one resets it
    const choose = (v) => { setOverride(k, tmp, rec && v === rec.cands[0].key ? '' : v); redraw(); };
    on('.alts', choose);
    on('.len', (v) => { store.set(selKey(st.id), JSON.stringify(Object.assign(readSel(st.id), { len: v }))); redraw(); });
    el.querySelector('.map-btn').addEventListener('click', () => {
      if (open) { const m = maps.get(key); if (m) { views.delete(m._viewKey); delete m._viewKey; } mapsOpen.delete(key); } else mapsOpen.add(key);
      redraw();
    });
    if (open) drawStationMap(el.querySelector('.advice-map'), key, stx, rec || adv.rec, {
      sections: placed ? StationMap.liveSections(lt.info.sequence, placed) : null,
      onSpot: rec ? choose : null,
      // Exits: a named one becomes the destination, others (and any tap on the map) the point
      onExit: canPoint ? (named, e) => named ? (store.set(exitKey(st.id), named.key), redraw()) : setPointHere(e.lat, e.lon) : null,
      onMap: canPoint ? (lat, lon) => setPointHere(lat, lon) : null
    });
    function setPointHere(lat, lon) {
      store.set(pointKey(st.id), JSON.stringify({ lat, lon }));
      store.set(exitKey(st.id), U.POINT_KEY);   // tapped here: chosen
      if (adv.plat) store.set(OVR_KEY + adv.plat + '>' + U.POINT_KEY, ''); // a choice belonged to the old point (as app.js)
      redraw();
    }
    const link = el.querySelector('a.page-link');
    // The station view opens with this change chosen (its selection is stored per station)
    if (link) link.addEventListener('click', () => {
      // Without a platform nothing is preselected but the train, which often tells the platform by its track
      const v = U.viewSelection(st, s, adv) || {};
      // … with the arriving train under "Mein Zug (live)" (planned arrival, line, trip of the journey planner)
      const a = stop.arrive;
      v.live = a.to.time ? { time: a.to.time, line: a.line, journeyId: a.journeyId || '', at: Date.now() } : null;
      store.set(selKey(st.id), JSON.stringify(Object.assign(readSel(st.id), v, { lift: $('trip-lift').checked })));
      if (v.to === U.POINT_KEY && s.point && typeof s.point === 'object') store.set(pointKey(st.id), JSON.stringify(s.point));
    });
  }

  // "RE3 · hält in Abschnitt A–F" (as the line under "Mein Zug (live)"); line as in the journey (the coach data
  // named regional trains by their number)
  function liveText(info, placed, line) {
    const used = [...new Set(info.sequence.vehicles.map(v => v.sector).filter(Boolean))].sort();
    return [line || info.name, used.length && t('stopsInSection', { s: used.length > 1 ? used[0] + '–' + used[used.length - 1] : used[0] }),
      placed.check === 'confirmed' && t('confirmedBySigns')].filter(Boolean).join(' · ');
  }

  async function drawStationMap(box, key, st, rec, handlers) {
    let L;
    try { L = await loadLeaflet(); } catch (e) { box.innerHTML = `<p class="muted">${esc(t('r.mapOffline'))}</p>`; return; }
    if (!box.isConnected || maps.has(key)) return; // redrawn meanwhile
    const map = StationMap.create(box, st.center.lat, st.center.lon);
    map._viewKey = result.journeys[opened].id + '|' + key.split(':')[1] + '|' + st.id;
    maps.set(key, map);
    if (handlers.onMap) map.on('click', (e) => handlers.onMap(e.latlng.lat, e.latlng.lng));
    StationMap.draw(map, st, rec && !rec.error ? rec : null, Object.assign({ view: views.get(map._viewKey) }, handlers));
  }

  function adviceHtml(stop, st, adv, exits, mapOpen, placed, areaState) {
    // Changing to another train, to a bus or tram (with the stop's name in OSM), or leaving the station
    const head = stop.depart ? t('r.forChange', { line: stop.depart.line }) + (stop.stopRef ? ' · ' + t('r.stopRef', { ref: stop.stopRef }) : '')
      : t('r.forLeave');
    const mapBtn = st ? ` <button type="button" class="map-btn" aria-expanded="${!!mapOpen}">${esc(t(mapOpen ? 'r.hideMap' : 'r.showMap'))}</button>` : '';
    // The station view only where the automatic stops: platform, direction or connecting platform unknown –
    // there they can be chosen by hand (with everything known preselected)
    const selfLink = st ? ` · <a class="page-link" href="station.html?id=${encodeURIComponent(st.id)}">${esc(t('r.chooseYourself'))}</a>` : '';
    // Exits to choose from when the journey ends in this station
    const exitSel = exits && exits.length ? `<select class="exit-sel" aria-label="${esc(t('r.chooseExit'))}">` +
      `<option value="">${esc(t('r.chooseExit'))}</option>` +
      exits.map(x => `<option value="${esc(x.key)}"${(x.key === U.POINT_KEY ? stop.fromStationView : x.key === stop.point) ? ' selected' : ''}>` +
        `${esc(x.label)}</option>`).join('') + '</select>' : '';
    const r = adv.rec;
    if (!r || r.error) {
      const noPoint = adv.code === 'noTarget' && stop.kind === 'leave';
      const code = !r ? 'r.no.' + (noPoint ? (exitSel ? 'chooseExit' : 'noPoint') : adv.code) : 'err.' + r.code;
      const manual = !r && !noPoint && ['noPlatform', 'noDirection', 'noTarget'].includes(adv.code);
      return `<p class="advice-head">${esc(head)}</p><p class="muted">${esc(t(code))}${mapBtn}${manual ? selfLink : ''}</p>${exitSel}`;
    }
    const zones = [r.chosenSpot, ...r.equal].map(sp => sp.zone);
    const dist = C.walkText(r, r.chosen.dist);
    // Section, for a placed live train the one of the coach at the exit (and its number), as in the station view
    const coach = placed ? placed.vehicleAt(r.chosen.exitT) : null;
    const sec = (coach && coach.sector) || r.chosenSpot.section;
    const section = (sec ? ' · ' + t('section', { s: sec }) : '') + (coach && coach.number ? ' · ' + t('coach', { n: coach.number }) : '');
    const unsure = r.opt.ambiguous || r.estimated || r.method === 'air' || !!C.tailWarning(r);
    return `<p class="advice-head">${esc(head)}${stop.fromStationView ? ' · ' + esc(t('r.pointFromView')) : ''}${r.overridden ? ' · ' + esc(t('r.ownChoice')) : ''}</p>
      <p class="advice-verdict">${esc(verdict(zones, stop.arrive.from.name))}${unsure ? ` <span class="late">(${esc(t('r.unsure'))})</span>` : ''}</p>
      <p class="muted">${esc(kindsText(r.chosenSpot.kinds))}${esc(section)}${dist ? ' · ' + esc(dist) : ''}${mapBtn}</p>${exitSel}
      ${areaState === 'loading' ? `<p class="muted">${esc(t('loadingArea'))}</p>`
        : C.tailWarning(r) ? `<p class="warn">${esc(t(areaState === 'failed' ? 'areaFailed' : 'warnTail', { m: r.tail }))}` +
          `${areaState === 'failed' ? ` <button type="button" class="link-btn area-retry">${esc(t('areaRetry'))}</button>` : ''}</p>` : ''}`;
  }

  if (places.from && places.to) status(t('r.ready'));
})();
