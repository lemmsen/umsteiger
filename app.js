/* Umsteiger – UI, map, data loading */
(function () {
  'use strict';
  const U = window.Umstieg;
  const I = window.I18N, t = I.t;
  const C = window.Common, D = window.StationData;
  const { store, esc, api, pad, hm } = C;
  C.applyTexts();

  // Station via URL: ?id=146054 uses the prepared timetable data in data/st/;
  // ?name=Alexanderplatz&lat=52.5215&lon=13.4113&r=450 works without it (OSM only)
  const RECENT_KEY = 'umsteiger:recent';
  // Newest first; one entry per name, because ids of a station change when parts are merged in the timetable data
  const recent = () => {
    let list = [];
    try { list = JSON.parse(store.get(RECENT_KEY) || '[]'); } catch (e) { /* unreadable: start empty */ }
    if (!Array.isArray(list)) list = []; // version 55 of the journey search stored its own list here
    return list.filter((r, i) => list.findIndex(o => o.id === r.id || o.name === r.name) === i);
  };

  const qs = new URLSearchParams(location.search);
  const hasCoords = qs.has('lat') && qs.has('lon');
  // Without id or coordinates: last used station, otherwise none (the coordinates below are only a fallback)
  const STATION = {
    id: qs.get('id') || (hasCoords ? '' : (recent()[0] || {}).id || ''),
    name: qs.get('name') || 'Berlin Gesundbrunnen',
    lat: parseFloat(qs.get('lat')) || 52.5486,
    lon: parseFloat(qs.get('lon')) || 13.3886,
    r: parseInt(qs.get('r'), 10) || 450
  };
  // First visit: nothing to load until a station is chosen in the search
  const NO_STATION = !STATION.id && !hasCoords;
  const STATION_KEY = STATION.id || [STATION.lat, STATION.lon, STATION.r].join(',');
  const SEL_KEY = 'umsteiger:sel:' + STATION_KEY;
  const OVR_KEY = 'umsteiger:override:';
  const POINT_STORE = 'umsteiger:point:' + STATION_KEY; // destination tapped on the map, per station

  const $ = (id) => document.getElementById(id);
  const els = { from: $('from'), to: $('to'), lift: $('lift'), result: $('result'), alts: $('alts'), altsRow: $('alts-row'), status: $('status'),
    arr: $('arr'), line: $('line'), len: $('len'), lenRow: $('len-row'),
    live: $('live'), liveRow: $('live-row'), liveInfo: $('live-info'), lineRow: $('line-row'), fromRow: $('from-row'), liveTime: $('live-time'),
    liveKind: $('live-kind'), liveFilter: $('live-filter'), dataDate: $('data-date') };

  // The search field shows the current station unless the user is typing in it
  let stationName = '';
  function showStation(name) {
    stationName = name;
    const input = $('search-input');
    if (document.activeElement !== input) input.value = name;
    $('search-clear').hidden = !input.value;
  }
  showStation(qs.get('name') || (recent().find(r => r.id === STATION.id) || {}).name || '');

  const KIND = { steps: t('steps'), escalator: t('escalator'), elevator: t('elevator'), level: t('level') };
  const TYPE = { light_rail: 'S-Bahn', subway: 'U-Bahn', train: t('typeTrain') };
  // core.js names the thirds of the train in German; these are the keys of the texts
  const ZONE = { vorne: 'front', Mitte: 'middle', hinten: 'rear' };
  const ZONE_ORDER = ['vorne', 'Mitte', 'hinten'];
  const zoneName = (z) => t('zone.' + ZONE[z]);
  const zoneAt = (z) => t('at.' + ZONE[z]);
  // "Treppe (oder Aufzug)": first what the walk shown uses (the quickest), then what else is at this spot
  const kindsText = (kinds) => kinds.length > 1
    ? t('kindsAlso', { main: KIND[kinds[0]], others: kinds.slice(1).map(k => KIND[k]).join(', ') })
    : KIND[kinds[0]];
  const quoted = (s) => t('quote', { s });

  // "Vorne einsteigen" / "Vorne oder in der Mitte einsteigen"
  function verdict(zones) {
    const text = t('verdict', { where: I.or(ZONE_ORDER.filter(z => zones.includes(z)).map(zoneAt)) });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  let st = null, map = null, layer = null, lastFit = '';

  function status(msg, isError) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (isError ? ' error' : '');
  }

  // Running bar on top of the form while something is loading
  let loading = 0;
  function busy(on) {
    loading += on ? 1 : -1;
    $('progress').hidden = loading <= 0;
  }

  // Show or hide a part of the form by sliding instead of jumping
  const calm = !!window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function slide(el, show) {
    const shown = el._slideTo !== undefined ? el._slideTo : !el.hidden;
    if (shown === show) return;
    if (el._slide) el._slide.cancel();
    el._slideTo = show;
    el.hidden = false;
    const done = () => { el.hidden = !show; el.style.overflow = ''; el._slide = null; el._slideTo = undefined; };
    if (calm || !el.animate) { done(); return; }
    const frames = [{ maxHeight: '0px', opacity: 0 }, { maxHeight: el.scrollHeight + 'px', opacity: 1 }];
    el.style.overflow = 'hidden';
    el._slide = el.animate(show ? frames : frames.reverse(), { duration: 300, easing: 'ease-out' });
    el._slide.onfinish = done;
  }

  // Footer: date of the OSM extract and of the timetable the station data was prepared from
  function showDates(d) {
    const fmt = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString(I.lang);
    const parts = [];
    if (d && d.osm) parts.push('OpenStreetMap ' + fmt(d.osm));
    if (d && d.timetable) parts.push(t('dateTimetable', { date: fmt(d.timetable) }));
    els.dataDate.textContent = parts.length ? t('dataDate', { parts: parts.join(', ') }) : '';
  }

  async function load(force) {
    const c = !force && D.cached(STATION_KEY);
    if (c) {
      st = c.station;
      status('');
      showDates(c.dates);
      fill();
      refresh(c);
      return;
    }
    els.reload.disabled = true;
    busy(true);
    try {
      status(t('loadingStation'));
      const tt = await timetable();
      const pre = await prepared();
      await build(tt, pre);
      showStored(null);
      status(st.options.length ? '' : t('noLines'), !st.options.length);
      fill();
    } catch (e) {
      status(t('loadFailed', { msg: e.message }), true);
    } finally {
      els.reload.disabled = false;
      busy(false);
    }
  }

  // Station model from the prepared data (or from Overpass when there is none), stored on the device
  async function build(tt, pre) {
    const b = await D.build(STATION_KEY, STATION, tt, pre, (msg) => status(msg));
    st = b.station;
    showDates(b.dates);
  }

  // A stored station is shown at once and replaced quietly when the server has newer data.
  // If the server cannot be asked, the date of the stored copy appears next to the reload button.
  async function refresh(c) {
    try {
      const tt = await timetable(true);
      const pre = await prepared(true);
      if (!pre) throw new Error('no prepared data to compare with'); // station came from Overpass
      const dates = c.dates || {};
      if (pre.prepared === dates.osm && ((tt && tt.prepared) || null) === (dates.timetable || null)) return;
      await build(tt, pre);
      fill();
    } catch (e) {
      showStored(c.at);
    }
  }

  function showStored(at) {
    const el = $('stored');
    el.textContent = at ? t('loadedOn', { date: new Date(at).toLocaleDateString(I.lang) }) : '';
    el.hidden = !at;
  }

  const stationFile = (kind, strict) => D.file(kind, STATION.id, strict);
  // Prepared timetable data for the station (optional: without it the app uses OSM routes only)
  async function timetable(strict) {
    const tt = await stationFile('st', strict);
    if (!tt) return null;
    if (tt.mergedInto) {
      // This part of a station was merged into another one (tools/prepare-gtfs.js)
      store.set(RECENT_KEY, JSON.stringify(recent().filter(r => r.id !== STATION.id)));
      location.replace('?id=' + encodeURIComponent(tt.mergedInto));
      return new Promise(() => {}); // page is being replaced
    }
    if (!hasCoords) Object.assign(STATION, { lat: tt.lat, lon: tt.lon, r: tt.r });
    if (!qs.get('name')) STATION.name = U.displayName(tt.name);
    return tt;
  }

  // OSM data prepared on the server (tools/prepare-osm.js); without it the app asks Overpass
  function prepared(strict) {
    return stationFile('osm', strict);
  }

  els.reload = $('reload');
  els.reload.addEventListener('click', () => load(true));

  let arrivals = [];

  function fill() {
    showStation(st.name);
    if (STATION.id) remember(STATION.id, st.name);
    const sel = JSON.parse(store.get(SEL_KEY) || '{}');
    if (!liveReady && sel.live) wantLive = sel.live;
    arrivals = U.arrivals(st);
    // Lines grouped by kind; every line once, whatever platforms it stops at
    const groups = {}, seen = new Set();
    for (const a of arrivals) for (const l of a.lines) {
      if (seen.has(l.ref)) continue;
      seen.add(l.ref);
      const g = TYPE[l.routeType] || l.routeType;
      (groups[g] = groups[g] || []).push(l.ref);
    }
    els.line.innerHTML = Object.keys(groups).map(g => `<optgroup label="${esc(g)}">` +
      groups[g].sort((a, b) => a.localeCompare(b, 'de', { numeric: true }))
        .map(ref => `<option value="${esc(ref)}">${esc(ref)}</option>`).join('') + '</optgroup>').join('');
    // Destinations: platforms to change to, then ways out of the station (named exits, or a point on the map)
    const target = (x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`;
    els.to.innerHTML = `<optgroup label="${esc(t('targetChange'))}">${st.targets.filter(x => !x.exit).map(target).join('')}</optgroup>` +
      `<optgroup label="${esc(t('targetLeave'))}"><option value="${U.POINT_KEY}">${esc(t('pointOnMap'))}</option>` +
      `${st.targets.filter(x => x.exit).map(target).join('')}</optgroup>`;
    const ref = (sel.line || '').split('|').pop(); // older versions stored "platform|line"
    if (seen.has(ref)) els.line.value = ref;
    showPlatforms(false, sel.arr);
    fillDirections(sel.from);
    fillTrain(sel.len || '');
    if (sel.to && (sel.to === U.POINT_KEY || st.targets.some(t => t.key === sel.to))) els.to.value = sel.to;
    else preselectTarget();
    els.lift.checked = !!sel.lift;
    els.arr.disabled = els.line.disabled = els.from.disabled = els.to.disabled = false;
    render();
    initLive();
  }

  const currentArrival = () => arrivals.find(a => a.key === els.arr.value);
  const currentLine = () => { const a = currentArrival(); return a && a.lines.find(l => l.ref === els.line.value); };
  const currentDir = () => { const l = currentLine(); return l && l.directions.find(d => d.key === els.from.value); };
  const platKey = () => els.arr.value;

  // Platforms of the chosen line: where it is known to stop first, then platforms that are only possible.
  // With a live train all platforms are listed, because the train decides (all = true).
  let allPlatforms = false;
  function showPlatforms(all, preferred) {
    const keep = preferred || els.arr.value;
    const opt = (a) => `<option value="${esc(a.key)}">${esc(a.label)}</option>`;
    const group = (label, list) => list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '';
    if (all) {
      const groups = {};
      for (const a of arrivals) {
        const g = a.known ? TYPE[a.routeType] || a.routeType : t('otherPlatforms');
        (groups[g] = groups[g] || []).push(a);
      }
      els.arr.innerHTML = Object.keys(groups).map(g => group(g, groups[g])).join('');
    } else {
      const line = (a) => a.lines.find(l => l.ref === els.line.value);
      const on = arrivals.filter(line);
      const known = on.filter(a => !line(a).guessed), other = on.filter(a => line(a).guessed);
      els.arr.innerHTML = other.length ? group(t('stopsHere'), known) + group(t('trackUnknown'), other) : known.map(opt).join('');
    }
    allPlatforms = !!all;
    if (keep && [...els.arr.options].some(o => o.value === keep)) els.arr.value = keep;
  }

  // The line follows the platform (live train, or platform changed while all platforms were listed)
  function alignLine(name) {
    const a = currentArrival();
    if (!a) return;
    const l = (name && a.lines.find(x => sameLine(x.ref, name))) || a.lines.find(x => x.ref === els.line.value) || a.lines[0];
    if (l) els.line.value = l.ref;
  }

  // "aus Bernau · nach Lutherstadt Wittenberg"
  function dirLabel(d) {
    const tos = d.tos.filter(t => U.cleanName(t) !== d.prevNames[0]).map(U.cleanName);
    return t('dirFrom', { from: d.prevNames[0] }) + (tos.length ? ' · ' + t('dirTo', { to: tos.slice(0, 2).join(' / ') }) : '');
  }

  function fillDirections(preferred) {
    const l = currentLine();
    const dirs = l ? l.directions : [];
    els.from.innerHTML = dirs.map(d => `<option value="${esc(d.key)}">${esc(dirLabel(d))}</option>`).join('');
    if (preferred && dirs.some(d => d.key === preferred)) els.from.value = preferred;
    fillTrain();
  }

  // Train length: only where stop signs for this platform and direction are mapped
  function fillTrain(preferred) {
    const d = currentDir();
    const choices = d ? U.trainChoices(st, d) : [];
    const keep = preferred !== undefined ? preferred : els.len.value;
    slide(els.lenRow, !!choices.length);
    els.len.innerHTML = `<option value="">${esc(t('wholePlatform'))}</option>` + choices.map(c =>
      `<option value="${esc(c.key)}">${esc(c.estimated ? t('lengthEstimated', { label: c.label }) : c.label)}</option>`).join('');
    if (keep && choices.some(c => c.key === keep)) els.len.value = keep;
  }

  // Default target: first platform other than your own (prefer U-Bahn when arriving by S-Bahn and vice versa)
  function preselectTarget() {
    const a = currentArrival();
    if (!a) return;
    const others = st.targets.filter(t => !t.exit && t.key !== platKey());
    const pref = others.find(t => t.refs.some(r => a.routeType === 'subway' ? /^S/.test(r) : /^U/.test(r))) || others[0];
    if (pref) els.to.value = pref.key;
  }

  function saveSel() {
    store.set(SEL_KEY, JSON.stringify({ arr: els.arr.value, line: els.line.value, from: els.from.value,
      to: els.to.value, lift: els.lift.checked, len: els.len.value }));
  }

  els.arr.addEventListener('change', () => {
    if (live) { live = null; els.live.value = ''; showLiveInfo(''); }
    if (allPlatforms) { alignLine(); showPlatforms(false); }
    fillDirections();
    if (els.to.value === platKey()) preselectTarget();
    saveSel(); render();
  });
  els.line.addEventListener('change', () => {
    showPlatforms(false);
    fillDirections();
    if (els.to.value === platKey()) preselectTarget();
    saveSel(); render();
  });
  els.from.addEventListener('change', () => { fillTrain(); saveSel(); render(); });
  els.len.addEventListener('change', () => { saveSel(); render(); });
  els.to.addEventListener('change', () => { saveSel(); render(); });
  els.lift.addEventListener('change', () => { saveSel(); render(); });

  const ovrKey = () => OVR_KEY + platKey() + '>' + els.to.value;

  function choose(accessKey) {
    store.set(ovrKey(), accessKey);
    render();
  }
  els.alts.addEventListener('change', () => choose(els.alts.value));

  // Destination outside the station, tapped on the map
  function point() {
    try { const p = JSON.parse(store.get(POINT_STORE)); if (p && isFinite(p.lat) && isFinite(p.lon)) return p; } catch (e) { /* none */ }
    return null;
  }
  function setPoint(lat, lon) {
    store.set(POINT_STORE, JSON.stringify({ lat, lon }));
    els.to.value = U.POINT_KEY;
    store.set(ovrKey(), ''); // an access chosen by hand belonged to the old point
    saveSel();
    render();
  }
  // The point stays for this station until it is moved or removed
  $('point-clear').addEventListener('click', () => {
    store.set(POINT_STORE, '');
    store.set(ovrKey(), ''); // a choice belonged to the old point
    render();
  });

  function setTarget(key) {
    els.to.value = key;
    saveSel();
    render();
  }

  // ---------- Live train (needs server.py) ----------

  const EVA_KEY = 'umsteiger:eva3:' + STATION_KEY; // eva3: earlier versions could store a bus stop or a station entrance
  let live = null, liveReady = false, liveArrivals = [];
  // Train handed over by the journey search ("view station"): chosen under "Mein Zug (live)" once
  let wantLive = null;
  const WANT_LIVE_MINUTES = 30;   // only right after the journey search, and only for today

  function showLiveInfo(text, isError) {
    els.liveInfo.textContent = text;
    els.liveInfo.hidden = !text;
    els.liveInfo.className = 'live-info' + (isError ? ' error' : '');
  }

  const delayMin = (a) => a.rtTime && a.time ? Math.round((new Date(a.rtTime) - new Date(a.time)) / 60000) : 0;

  // Live arrivals at this station, only if server.py answers (not on a purely static server)
  async function initLive() {
    if (liveReady) return;
    liveReady = true;
    // Without live data nothing changes: the bar stops and the status line shows what it showed before
    const before = [els.status.textContent, els.status.classList.contains('error')];
    busy(true);
    status(t('loadingArrivals'));
    try {
      let eva = store.get(EVA_KEY);
      if (!eva) {
        const q = `q=${encodeURIComponent(st.name)}&lat=${st.center.lat}&lon=${st.center.lon}`;
        eva = (await api('eva?' + q)).eva;
        if (!eva) return;
        store.set(EVA_KEY, eva);
      }
      els.live.dataset.eva = eva;
      const now = new Date();
      const want = wantLive && Date.now() - wantLive.at < WANT_LIVE_MINUTES * 60000 &&
        wantLive.time.slice(0, 10) === `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` ? wantLive : null;
      wantLive = null;
      els.liveTime.value = want ? want.time.slice(11, 16) : pad(now.getHours()) + ':' + pad(now.getMinutes() - now.getMinutes() % 5);
      await loadArrivals();
      slide(els.liveRow, true);
      if (want) await pickLive(want);
    } catch (e) { /* no server.py or bahn.de not reachable: app works without live data */ }
    finally {
      busy(false);
      status(...before);
    }
  }

  const LIVE_BEFORE = 5, LIVE_AFTER = 15; // minutes around "Ankunft gegen"
  const LIVE_KIND_KEY = 'umsteiger:livekinds';
  let liveWindow = { a: '', b: '' };
  // The first entry is also the key in the stored selection; kindName() is what is shown
  const LIVE_GROUPS = [['Regional- & Fernverkehr', ['ICE', 'EC_IC', 'IR', 'REGIONAL'], 'r'], ['S-Bahn', ['SBAHN'], 's'], ['U-Bahn', ['UBAHN'], 'u']];
  const kindName = (label) => label === LIVE_GROUPS[0][0] ? t('typeTrain') : label;
  const TRAIN_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="1.5" width="10" height="10.5" rx="2.5"/><path d="M3 7h10M5.5 9.6h.1M10.4 9.6h.1M5.5 12l-1.7 2.5M10.5 12l1.7 2.5"/></svg>';
  const kindIcon = (id, state) => `<span class="kind-icon ${id}${state ? ' ' + state : ''}" aria-hidden="true">${id === 'r' ? TRAIN_ICON : id.toUpperCase()}</span>`;

  // Arrivals around the chosen time: planned or actual arrival within the window
  async function loadArrivals() {
    const [h, m] = (els.liveTime.value || '00:00').split(':').map(Number);
    const t = new Date(); t.setHours(h, m, 0, 0);
    const from = new Date(t - LIVE_BEFORE * 60000), to = new Date(+t + LIVE_AFTER * 60000);
    const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const all = (await api(`arrivals?eva=${encodeURIComponent(els.live.dataset.eva)}&when=${local(from)}`)).arrivals;
    const inWindow = (iso) => iso && new Date(iso) >= from && new Date(iso) <= to;
    const seen = new Set();
    // Same train twice (e.g. trains that are split or joined): show once
    const once = (a) => { const k = [a.name, a.time, a.rtPlatform || a.platform].join('|'); return !seen.has(k) && seen.add(k); };
    liveArrivals = all.filter(a => (inWindow(a.time) || inWindow(a.rtTime)) && once(a))
      .sort((a, b) => new Date(a.rtTime || a.time) - new Date(b.rtTime || b.time));
    liveWindow = { a: local(from).slice(11), b: local(to).slice(11) };
    // Filter by kind of train (several at once), with the number of arrivals per kind
    const chosen = liveKinds();
    els.liveKind.innerHTML = LIVE_GROUPS.map(([label, products, id]) => {
      const n = liveArrivals.filter(a => products.includes(a.product)).length;
      return `<button type="button" class="chip" data-kind="${esc(label)}" aria-pressed="${chosen.includes(label)}"${n ? '' : ' disabled'}>` +
        `${kindIcon(id)}${esc(kindName(label))}<small>${n}</small></button>`;
    }).join('');
    showLiveFilter();
    fillLiveTrains();
    if (live) { live = null; showLiveInfo(''); render(); }
  }

  // Chosen kinds of train (remembered; all by default)
  function liveKinds() {
    try { const k = JSON.parse(store.get(LIVE_KIND_KEY)); if (Array.isArray(k)) return k; } catch (e) { /* default */ }
    return LIVE_GROUPS.map(([label]) => label);
  }

  // Collapsed filter: icons of all kinds; switched off = grey, switched on but no arrivals of this kind = coloured but pale
  function showLiveFilter() {
    const chosen = liveKinds(), open = !els.liveKind.hidden;
    const none = [...els.liveKind.querySelectorAll('.chip:disabled')].map(c => c.dataset.kind);
    const shown = chosen.filter(label => !none.includes(label));
    els.liveFilter.innerHTML = `<span>${esc(t('filter'))}</span>` +
      LIVE_GROUPS.map(([label, , id]) => kindIcon(id, !chosen.includes(label) ? 'off' : none.includes(label) ? 'none' : '')).join('') +
      `<span>${open ? '▴' : '▾'}</span>`;
    els.liveFilter.setAttribute('aria-expanded', String(open));
    els.liveFilter.setAttribute('aria-label', t('filter') + ' ' + (shown.map(kindName).join(', ') || t('nothingChosen')));
  }
  els.liveFilter.addEventListener('click', () => { els.liveKind.hidden = !els.liveKind.hidden; showLiveFilter(); });
  showLiveFilter();

  // Trains of the chosen kinds; grouped when more than one kind is shown
  function fillLiveTrains() {
    const chosen = liveKinds();
    const groups = LIVE_GROUPS.filter(([label]) => chosen.includes(label))
      .map(([label, products]) => [label, liveArrivals.filter(a => products.includes(a.product))]).filter(([, l]) => l.length);
    const option = (a) => {
      const i = liveArrivals.indexOf(a), d = delayMin(a), gl = a.rtPlatform || a.platform;
      return `<option value="${i}">${hm(a.time)}${d > 0 ? ` → ${hm(a.rtTime)}` : ''} ${esc(t('liveTrain', { name: a.name, from: a.from || '?' }))}` +
        `${gl ? ' · ' + esc(t('trackShort', { n: gl })) : ''}</option>`;
    };
    const empty = !chosen.length ? t('chooseKind') : t('noArrivals', liveWindow);
    els.live.innerHTML = `<option value="">${esc(groups.length ? t('noLive') : empty)}</option>` +
      (groups.length > 1
        ? groups.map(([label, l]) => `<optgroup label="${esc(kindName(label))}">${l.map(option).join('')}</optgroup>`).join('')
        : groups.map(([, l]) => l.map(option).join('')).join(''));
  }
  els.liveKind.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || chip.disabled) return;
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', String(on));
    store.set(LIVE_KIND_KEY, JSON.stringify([...els.liveKind.querySelectorAll('.chip[aria-pressed="true"]')].map(c => c.dataset.kind)));
    showLiveFilter();
    fillLiveTrains();
    if (live) { live = null; showLiveInfo(''); render(); }
  });

  els.liveTime.addEventListener('change', () => {
    busy(true);
    loadArrivals().catch(e => showLiveInfo(t('arrivalsFailed', { msg: e.message }), true)).finally(() => busy(false));
  });

  const sameLine = (x, y) => x.replace(/\s+/g, '').toUpperCase() === y.replace(/\s+/g, '').toUpperCase();

  // OSM platform for a live train: by track number; U-Bahn by line, then track number, then (side
  // platforms) the platform where this line already arrives in the same direction
  function livePlatform(a, gleis, from) {
    const isU = a.product === 'UBAHN';
    let cands = arrivals.filter(x => isU ? x.routeType === 'subway' : x.routeType !== 'subway');
    if (isU) {
      const withLine = cands.filter(x => st.platforms[x.key].refs.some(r => sameLine(r, a.name)));
      if (withLine.length) cands = withLine;
    }
    const track = (x) => (st.platforms[x.key].tags.ref || st.platforms[x.key].tags.local_ref || '').split(/[;\/,]\s*/);
    const byTrack = gleis && cands.find(x => track(x).includes(gleis));
    if (byTrack || !isU) return byTrack || null;
    if (cands.length === 1) return cands[0];
    return cands.find(x => {
      const d = U.liveDirection(st, x.key, from, '');
      return d && x.lines.some(l => sameLine(l.ref, a.name) &&
        l.directions.some(o => !o.platformChosen && o.frontSign === d.frontSign));
    }) || null;
  }

  // The train of the journey search: same trip of bahn.de, else same line and planned arrival
  async function pickLive(want) {
    const i = liveArrivals.findIndex(a => want.journeyId && a.journeyId === want.journeyId);
    const a = liveArrivals[i >= 0 ? i : liveArrivals.findIndex(x => x.time === want.time && sameLine(x.name || '', want.line || ''))];
    if (!a) return;
    // Its kind of train may be filtered out
    const group = LIVE_GROUPS.find(([, products]) => products.includes(a.product));
    const kinds = liveKinds();
    if (group && !kinds.includes(group[0])) {
      store.set(LIVE_KIND_KEY, JSON.stringify(kinds.concat(group[0])));
      const chip = els.liveKind.querySelector(`.chip[data-kind="${group[0]}"]`);
      if (chip) chip.setAttribute('aria-pressed', 'true');
      showLiveFilter();
      fillLiveTrains();
    }
    els.live.value = String(liveArrivals.indexOf(a));
    if (els.live.value === '') return;
    await chooseLive();
  }

  async function chooseLive() {
    // "Ohne Live-Daten" has an empty value; Number('') would be 0, the first train
    const a = els.live.value === '' ? null : liveArrivals[Number(els.live.value)];
    live = null;
    if (!a) { showLiveInfo(''); render(); return; }
    showLiveInfo(t('loadingTrain'));
    busy(true);
    try {
      const info = await api(`train?eva=${encodeURIComponent(els.live.dataset.eva)}&stop=${encodeURIComponent(a.stop || '')}` +
        `&lat=${st.center.lat}&lon=${st.center.lon}&journeyId=${encodeURIComponent(a.journeyId)}`);
      const gleis = a.rtPlatform || info.platform || a.platform || '';
      const arr = livePlatform(a, gleis, info.approach || info.prev);
      const parts = [a.name || info.name, gleis && t('track', { n: gleis }), delayMin(a) > 0 && `+${delayMin(a)} min`];
      const seq = info.sequence;
      if (seq) {
        const used = [...new Set(seq.vehicles.map(v => v.sector).filter(Boolean))].sort();
        if (used.length) parts.push(t('stopsInSection', { s: used.length > 1 ? used[0] + '–' + used[used.length - 1] : used[0] }));
      }
      if (!arr) {
        showLiveInfo(parts.filter(Boolean).join(' · ') + '. ' + t('trackNotMapped', { track: t('track', { n: gleis }) }), true);
        render();
        return;
      }
      showPlatforms(true, arr.key);
      alignLine(a.name);
      fillDirections();
      const dir = U.liveDirection(st, arr.key, info.approach || info.prev, info.prev && info.prev.name);
      let map = seq ? U.mapSequence(st, arr.key, seq, dir && dir.frontSign) : null;
      const problem = map && map.check === 'conflict';
      if (problem) map = null; // placement contradicts the stop signs: rather none than a mirrored one
      live = { dir, map, info };
      if (problem) parts.push(t('coachUnsure'));
      else if (!map && seq) parts.push(t('coachUnknown'));
      if (map && map.method === 'order') parts.push(t('coachFromMeters'));
      if (map && map.check === 'confirmed') parts.push(t('confirmedBySigns'));
      if (!seq) parts.push(t('noSequence'));
      showLiveInfo(parts.filter(Boolean).join(' · '));
      if (els.to.value === platKey()) preselectTarget();
      saveSel();
      render();
    } catch (e) {
      showLiveInfo(t('trainFailed', { msg: e.message }), true);
      render();
    } finally {
      busy(false);
    }
  }
  els.live.addEventListener('change', chooseLive);


  // "ca. 80 m Fußweg bis zum Zielbahnsteig" / "… bis zum Ausgang" / "… bis zum Ziel"
  function toTargetText(target, dist) {
    if (target.kind === 'exit') return t('toTargetExit', { dist });
    if (target.kind === 'point') return t('toTargetPoint', { dist });
    return t('toTargetPlatform', { dist });
  }

  function render() {
    if (!st) return;
    const liveOn = !!(live && live.dir && live.dir.plat === platKey());
    slide(els.lineRow, !liveOn);
    slide(els.fromRow, !liveOn);
    if (!liveOn && allPlatforms) showPlatforms(false);
    // A live train placed by its coach sequence shows itself; without a sequence the train length still counts
    const placed = liveOn && !!live.map;
    slide(els.lenRow, !placed && els.len.options.length > 1);
    const dir = liveOn ? live.dir : currentDir();
    const toPoint = els.to.value === U.POINT_KEY;
    $('map-hint').textContent = toPoint ? t('mapHintPoint') + ' ' + t('mapArea') : t('mapHint');
    $('point-clear').hidden = !(toPoint && point());
    // Destination beyond the station data: with the ways loaded around it (when they are on this device)
    const pt = toPoint ? point() : null;
    const s = (pt && D.withWays(st, STATION_KEY, pt)) || st;
    const r = dir ? U.recommend(s, dir, toPoint ? pt || U.POINT_KEY : els.to.value, { liftOnly: els.lift.checked, override: store.get(ovrKey()),
      train: placed ? null : els.len.value || null, trainRange: placed ? live.map : null })
      : { error: t('choose') };
    if (pt && D.needsWays(st, STATION_KEY, pt, r)) D.loadWays(st, STATION_KEY, pt).then(render);
    const areaState = pt ? D.areaState(st, STATION_KEY, pt) : '';
    const areaHtml = areaState === 'loading' ? `<p class="live-info">${esc(t('loadingArea'))}</p>`
      : areaState === 'failed' && C.tailWarning(r)
        ? `<p class="warn">${esc(t('areaFailed'))} <button type="button" class="link-btn area-retry">${esc(t('areaRetry'))}</button></p>` : '';
    const R = els.result;
    R.hidden = false;
    R.onclick = (e) => { if (e.target.closest('.area-retry')) { D.retryWays(st, STATION_KEY, pt).then(render); render(); } };

    if (r.error) {
      R.innerHTML = `<p class="detail" style="margin:0">${esc(r.code ? t('err.' + r.code) : r.error)}</p>`;
      els.altsRow.hidden = true;
      drawMap(r, s);
      return;
    }
    const c = r.chosen;
    const shown = [r.chosenSpot, ...r.equal];
    const zones = shown.map(sp => sp.zone);
    const name = c.tags.name || c.tags.description || '';
    const seg = (z, label) => `<span class="seg${zones.includes(z) ? ' on' : ''}">${label}</span>`;
    const fromFront = (m) => t(r.train ? 'fromTrainFront' : 'fromPlatformFront', { m: Math.round(m) });
    const spotLine = (sp) => t('spot', { kinds: kindsText(sp.kinds), at: zoneAt(sp.zone) }) + ' · ' + fromFront(sp.fromFront);
    // Section (and, for a live train with coach sequence, the coach) where to get off – for every
    // recommended spot: "front or rear" needs "front: section A · rear: section C", not just one letter
    const places = [...shown].sort((a, b) => ZONE_ORDER.indexOf(a.zone) - ZONE_ORDER.indexOf(b.zone)).map(sp => {
      const coach = liveOn && live.map ? live.map.vehicleAt(sp === r.chosenSpot ? c.exitT : sp.exitT) : null;
      return { zone: sp.zone, section: (coach && coach.sector) || sp.section, coach };
    }).filter(pl => pl.section);
    const coachText = (co) => co && co.number ? ` · ${esc(t('coach', { n: co.number }))}${co.firstClass ? ` (${esc(t('firstClass'))})` : ''}` : '';
    const several = places.length > 1 && new Set(places.map(pl => pl.section)).size > 1;
    const sectionHtml = !places.length ? '' : several
      ? places.map(pl => `<p class="section"><b>${esc(pl.section)}</b> ${esc(zoneName(pl.zone))}: ${esc(t('section', { s: pl.section }))}${coachText(pl.coach)}</p>`).join('')
      : `<p class="section"><b>${esc(places[0].section)}</b> ${esc(t('section', { s: places[0].section }))}${coachText(places[0].coach)}</p>`;
    const off = r.chosenSpot.offTrain;
    const walkHtml = off >= 3 ? `<p class="walk">${esc(t('offTrain', { m: Math.round(off) }))}</p>` : '';
    const how = t(r.method === 'walk' ? 'walk' : 'air');
    const detail = r.equal.length
      ? esc(t('equalFar', { how })) + '<br>' + [...shown]
        .sort((a, b) => ZONE_ORDER.indexOf(a.zone) - ZONE_ORDER.indexOf(b.zone))
        .map(sp => esc(spotLine(sp))).join('<br>')
      : `${esc(KIND[c.kind])}${name ? ' ' + esc(quoted(name)) : ''} · ${esc(fromFront(c.fromFront))}<br>` +
        esc(toTargetText(r.target, isFinite(c.dist) ? C.walkText(r, c.dist) : t('noWalk')));
    R.innerHTML = `
      <p class="verdict">${verdict(zones)}</p>
      ${sectionHtml}
      <div class="train">
        <div class="train-body">${['hinten', 'Mitte', 'vorne'].map(z => seg(z, esc(zoneName(z)))).join('')}</div>
        ${shown.map(sp => `<div class="marker" style="left:${((sp === r.chosenSpot ? c.p : sp.p) * 100).toFixed(1)}%"></div>`).join('')}
      </div>
      <div class="dir"><span>${esc(t('trainEnd'))}</span><span>${esc(t('direction'))}</span></div>
      <p class="detail">${detail}<br>(${esc(t(r.train ? 'trainLen' : 'platformLen', { m: Math.round(r.length) }))})${r.overridden ? ' · ' + esc(t('chosenByYou')) : ''}</p>
      ${walkHtml}
      ${r.method === 'air' && st.walk && st.walk.length ? `<p class="warn">${esc(t('warnAir'))}</p>` : ''}
      ${r.opt.ambiguous ? `<p class="warn">${esc(t('warnAmbiguous'))}</p>` : ''}
      ${r.estimated ? `<p class="warn">${esc(t('warnEstimated'))}</p>` : ''}
      ${areaState !== 'loading' && areaState !== 'failed' && C.tailWarning(r) ? `<p class="warn">${esc(C.tailWarning(r))}</p>` : ''}
      ${areaHtml}`;

    // All access points of the platform as a dropdown above the map; choosing one overrides the recommendation
    els.altsRow.hidden = false;
    els.alts.innerHTML = StationMap.spotOptions(r);
    els.alts.value = r.chosenSpot.key;
    drawMap(r, s);
  }

  // s: the station, with the ways loaded around a destination farther out
  function drawMap(r, s) {
    if (typeof L === 'undefined') return; // Leaflet not loaded (offline on first start)
    if (!map) {
      map = StationMap.create('map', STATION.lat, STATION.lon);
      // Destination on the map: a tap sets (or moves) the point
      map.on('click', (e) => { if (st && els.to.value === U.POINT_KEY) setPoint(e.latlng.lat, e.latlng.lng); });
    }
    // Section letters along the platform: from the live train's coach sequence (DB gives the position of
    // every section) where it could be placed, otherwise the markers mapped in OSM
    const liveSecs = r.pl && live && live.map && live.dir && live.dir.plat === r.pl.key
      ? StationMap.liveSections(live.info.sequence, live.map) : null;
    // Fitted to the platforms again only when they change, not after a tap on an access point or exit
    const fitKey = [st.name, r.pl && r.pl.key, r.target && r.target.key].join('|');
    const fit = fitKey !== lastFit;
    lastFit = fitKey;
    layer = StationMap.draw(map, s || st, r, { old: layer, sections: liveSecs, fit,
      onSpot: choose, onExit: (named, e) => named ? setTarget(named.key) : setPoint(e.lat, e.lon) });
  }

  // ---------- Station search ----------

  const TYPE_SHORT = { S: 'S-Bahn', U: 'U-Bahn', Z: t('trainShort') };
  const search = { input: $('search-input'), results: $('search-results'), status: $('search-status'),
    nearby: $('nearby'), clear: $('search-clear') };
  let stationRows = null;

  function remember(id, name) {
    store.set(RECENT_KEY, JSON.stringify([{ id, name }, ...recent().filter(r => r.id !== id && r.name !== name)].slice(0, 6)));
  }

  // data/index.json is only loaded when the search is used
  async function stationIndex() {
    if (!stationRows) {
      searchStatus(t('loadingIndex'));
      const res = await fetch('data/index.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      stationRows = (await res.json()).stations;
      searchStatus('');
    }
    return stationRows;
  }

  function searchStatus(msg) {
    search.status.textContent = msg;
    search.status.hidden = !msg;
  }

  function showResults(items, title) {
    search.results.innerHTML = (items.length && title ? `<li class="res-title">${esc(title)}</li>` : '') +
      items.map(i => `<li><a href="?id=${encodeURIComponent(i.id)}">${esc(i.name)}${i.info ? `<small>${esc(i.info)}</small>` : ''}</a></li>`).join('');
  }

  const rowItem = (row, extra) => ({
    id: row[0], name: U.displayName(row[1]),
    info: [...row[4]].map(c => TYPE_SHORT[c]).concat(extra || []).join(' · ')
  });

  async function runSearch() {
    const q = search.input.value.trim();
    if (!q || q === stationName) {
      searchStatus('');
      showResults(recent().filter(r => r.id !== STATION.id && r.name !== stationName).map(r => ({ id: r.id, name: r.name })), t('recent'));
      return;
    }
    try {
      const rows = await stationIndex();
      if (search.input.value.trim() !== q) return; // user typed on meanwhile
      const hits = U.searchStations(rows, q, 20);
      searchStatus(hits.length ? '' : t('noStation'));
      showResults(hits.map(r => rowItem(r)));
    } catch (e) {
      searchStatus(t('indexFailed', { msg: e.message }));
    }
  }

  function resetSearch() {
    search.results.innerHTML = '';
    searchStatus('');
    search.input.blur();
    showStation(stationName);
  }

  function clearSearch() {
    search.input.value = '';
    search.clear.hidden = true;
    search.input.focus();
    runSearch();
  }

  const fmtDist = (m) => m < 1000 ? Math.round(m / 10) * 10 + ' m'
    : (m / 1000).toLocaleString(I.lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';

  function searchNearby() {
    if (!navigator.geolocation) { searchStatus(t('noGeo')); return; }
    searchStatus(t('locating'));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const rows = await stationIndex();
        const near = U.nearestStations(rows, pos.coords.latitude, pos.coords.longitude, 8);
        search.input.value = '';
        searchStatus('');
        showResults(near.map(h => rowItem(h.row, fmtDist(h.d))), t('near'));
      } catch (e) {
        searchStatus(t('indexFailed', { msg: e.message }));
      }
    }, () => searchStatus(t('geoDenied')),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
  }

  // The recently used stations appear as soon as the field is tapped
  search.input.addEventListener('focus', () => {
    search.input.select(); // typing replaces the current station
    if (!search.results.innerHTML) runSearch();
  });
  search.input.addEventListener('blur', () => { if (!search.input.value.trim()) showStation(stationName); });
  search.input.addEventListener('input', () => { search.clear.hidden = !search.input.value; runSearch(); });
  search.clear.addEventListener('click', clearSearch);
  search.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') resetSearch();
    if (e.key === 'Enter' && search.input.value.trim() !== stationName) { const a = search.results.querySelector('a'); if (a) location.href = a.href; }
  });
  search.nearby.addEventListener('click', searchNearby);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // A new version arrives as a new service worker with a complete set of files (sw.js). When it takes
    // over, load the page once more, so that it does not go on with the old files.
    const hadWorker = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadWorker || reloading) return;
      reloading = true;
      location.reload();
    });
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => reg.update()).catch(() => {}));
  }

  if (NO_STATION) {
    document.body.classList.add('no-station');
    status(t('welcome'));
  } else load(false);
})();
