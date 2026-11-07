/* Umsteiger – departures of a stop (needs server.py), with the course of every trip */
(function () {
  'use strict';
  const U = window.Umstieg;
  const I = window.I18N, t = I.t;

  const C = window.Common;
  const { store, esc, pad, hm, delay, api } = C;
  const local = C.localTime;
  C.applyTexts();

  const STOP_KEY = 'umsteiger:depstop';       // stop shown last
  const RECENT_KEY = 'umsteiger:depstops';    // recent stops
  const HIDDEN_KEY = 'umsteiger:dephidden';   // kinds switched off (new kinds stay visible)
  const RECENT_MAX = 6;
  const REFRESH_SECONDS = 60;
  const $ = (id) => document.getElementById(id);
  const readJson = (k, def) => C.readJson(k, def);
  const status = C.statusLine($('dep-status'));
  const busy = C.progress($('progress'));
  function noServer(e) {
    status(e && e.status && e.status !== 404 ? t('d.failed', { msg: e.message }) : t('r.noServer'), true);
  }

  // Kinds of transport as on the departure boards; colours as the line chips of the journey search
  const KINDS = [
    ['train', ['ICE', 'EC_IC', 'IR', 'REGIONAL'], 'r'], ['s', ['SBAHN'], 's'], ['u', ['UBAHN'], 'u'],
    ['tram', ['TRAM'], 't'], ['bus', ['BUS', 'ANRUFPFLICHTIG'], 'b'], ['ship', ['SCHIFF'], 'b']
  ];
  const KIND_NAME = { train: t('d.kind.train'), s: t('d.kind.s'), u: t('d.kind.u'), tram: t('d.kind.tram'), bus: t('d.kind.bus'), ship: t('d.kind.ship') };
  const kindOf = (product) => (KINDS.find(k => k[1].includes(product)) || KINDS[0]);

  // Names without the city of the chosen stop: "Berlin Humboldthain" / "Pankstr.(U), Berlin" -> "Humboldthain" / "Pankstr.(U)"
  function cityOf(name) {
    const m = /,\s*([^,]+)$/.exec(name || '');
    return m ? m[1] : (name || '').split(/[ -]/)[0];
  }
  function short(name) {
    const city = stop ? cityOf(stop.name) : '';
    if (!city) return name;
    const n = (name || '').replace(new RegExp(',\\s*' + city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
    return n.startsWith(city + ' ') || n.startsWith(city + '-') ? n.slice(city.length + 1) : n;
  }

  // ---------- Stop ----------

  let stop = readJson(STOP_KEY, null);       // { eva, name }
  let recent = readJson(RECENT_KEY, []);
  if (!Array.isArray(recent)) recent = [];
  const input = $('dep-stop'), list = $('dep-stop-list');

  function showList(items) {
    list.innerHTML = items.map((it, i) => it.title ? `<li class="res-title">${esc(it.title)}</li>` :
      `<li class="res-row"><a href="#" data-i="${i}">${it.icon ? `<span class="res-icon" aria-hidden="true">${it.icon}</span>` : ''}` +
      `<span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></a></li>`).join('');
    list._items = items;
  }
  const menu = () => [{ icon: '📍', label: t('d.nearby'), run: nearby }]
    .concat(recent.length ? [{ title: t('r.recent') }] : [])
    .concat(recent.map(s => ({ icon: '🕘', label: s.name, run: () => chooseStop(s) })));

  let timer = null, asked = '';
  input.addEventListener('focus', () => { showList(menu()); if (stop) input.select(); });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { asked = ''; showList(menu()); return; }
    timer = setTimeout(async () => {
      asked = q;
      try {
        const res = await api('places?q=' + encodeURIComponent(q) + C.nearHint(stop));
        if (asked === q) showList(res.places.filter(p => p.kind === 'station' && p.eva).map(p => ({ label: p.name, run: () => chooseStop(p) })));
      } catch (e) { noServer(e); }
    }, 250);
  });
  list.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    list._items[Number(a.dataset.i)].run();
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#dep-stop, #dep-stop-list')) showList([]); });

  // Stops around the own location (asked only when tapped)
  function nearby() {
    if (!navigator.geolocation) { status(t('r.hereFailed'), true); return; }
    status(t('r.locating'));
    busy(true);
    navigator.geolocation.getCurrentPosition(async (p) => {
      try {
        const res = await api(`nearby?lat=${p.coords.latitude}&lon=${p.coords.longitude}`);
        status(res.stops.length ? '' : t('d.noneNearby'));
        showList(res.stops.map(s => ({ label: s.name, sub: t('d.distance', { m: s.distance }), run: () => chooseStop(s) })));
      } catch (e) { noServer(e); }
      finally { busy(false); }
    }, () => { busy(false); status(t('r.hereFailed'), true); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  function chooseStop(s) {
    stop = { eva: s.eva, name: s.name };
    input.value = s.name;
    showList([]);
    input.blur();
    store.set(STOP_KEY, JSON.stringify(stop));
    recent = U.addRecent(recent, stop, x => x.eva, RECENT_MAX);
    store.set(RECENT_KEY, JSON.stringify(recent));
    setNow();
    load();
  }

  // ---------- Time ----------

  let followNow = true;    // the board follows the clock until a time is chosen
  function setNow() { followNow = true; $('dep-when').value = local(new Date()); }
  $('dep-when').addEventListener('change', () => { followNow = false; load(); });
  $('dep-now').addEventListener('click', () => { setNow(); load(); });

  // ---------- Departures ----------

  let deps = [];
  let openId = null;        // journeyId of the trip whose course is shown
  const courses = new Map(); // journeyId -> course from /api/trip
  let hidden = readJson(HIDDEN_KEY, []);
  if (!Array.isArray(hidden)) hidden = [];

  async function load(quiet) {
    if (!stop) { status(t('d.choose')); return; }
    if (followNow) $('dep-when').value = local(new Date());
    if (!quiet) { busy(true); status(t('d.loading')); }
    try {
      const res = await api(`departures?eva=${encodeURIComponent(stop.eva)}&when=${encodeURIComponent($('dep-when').value)}`);
      deps = res.departures;
      if (!quiet) status('');
      courses.delete(openId);   // fresh times for the open trip too
      render();
    } catch (e) {
      if (!quiet) noServer(e);
    } finally {
      if (!quiet) busy(false);
    }
  }
  $('dep-later').addEventListener('click', () => {
    const last = deps[deps.length - 1];
    if (!last) return;
    followNow = false;
    $('dep-when').value = last.time.slice(0, 16);
    load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  const { timeHtml, trackHtml } = C;

  function renderKinds() {
    const counts = KINDS.map(([id, products, cls]) => [id, cls, deps.filter(d => products.includes(d.product)).length]).filter(k => k[2]);
    const row = $('dep-kinds');
    row.hidden = counts.length < 2;
    row.innerHTML = counts.map(([id, cls, n]) => `<button type="button" class="chip" data-kind="${id}" aria-pressed="${!hidden.includes(id)}">` +
      `<span class="line-chip ${cls}">${esc(KIND_NAME[id])}</span><small>${n}</small></button>`).join('');
  }
  $('dep-kinds').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.kind;
    hidden = hidden.includes(id) ? hidden.filter(k => k !== id) : hidden.concat(id);
    store.set(HIDDEN_KEY, JSON.stringify(hidden));
    render();
  });

  function render() {
    renderKinds();
    const shown = deps.filter(d => !hidden.includes(kindOf(d.product)[0]));
    $('deps').hidden = !shown.length;
    $('dep-later-row').hidden = !deps.length;
    if (!deps.length) status(t('d.none'));
    else if (!shown.length) status(t('d.allHidden'));
    $('deps').innerHTML = shown.map(d => {
      const i = deps.indexOf(d), open = d.journeyId === openId;
      const high = d.notes.filter(n => n.high);
      return `<div class="dep${open ? ' open' : ''}" data-i="${i}">
        <button type="button" class="dep-head" aria-expanded="${open}">
          <span class="dep-time">${timeHtml(d, d.cancelled)}</span>
          <span class="dep-line"><span class="line-chip ${kindOf(d.product)[2]}">${esc(d.line || t('trainNoName'))}</span></span>
          <span class="dep-dir">${esc(short(d.direction || ''))}${d.cancelled ? ` <span class="late">${esc(t('r.cancelled'))}</span>` : ''}
            ${d.via.length ? `<small>${esc(t('d.via', { stops: d.via.map(short).join(', ') }))}</small>` : ''}
            ${high.map(n => `<small class="minor">${esc(n.text)}</small>`).join('')}</span>
          <span class="dep-track">${trackHtml(d)}</span>
        </button>
        ${open ? `<div class="course" data-id="${esc(d.journeyId)}"><p class="muted">${esc(t('d.loadingCourse'))}</p></div>` : ''}
      </div>`;
    }).join('');
    const d = deps.find(x => x.journeyId === openId);
    if (d) showCourse(d);
  }

  $('deps').addEventListener('click', (e) => {
    const head = e.target.closest('.dep-head');
    if (head) {
      const d = deps[Number(head.parentElement.dataset.i)];
      openId = openId === d.journeyId ? null : d.journeyId;
      render();
      return;
    }
    const more = e.target.closest('.course-more');
    if (more) { more.parentElement.classList.add('all'); more.remove(); }
  });

  // ---------- Course of a trip: all stops, this one highlighted, the earlier ones folded ----------

  async function showCourse(d) {
    const box = document.querySelector(`.course[data-id="${CSS.escape(d.journeyId)}"]`);
    if (!box) return;
    let c = courses.get(d.journeyId);
    if (!c) {
      try {
        c = await api('trip?journeyId=' + encodeURIComponent(d.journeyId));
        courses.set(d.journeyId, c);
      } catch (e) {
        box.innerHTML = `<p class="muted">${esc(t('d.courseFailed'))}</p>`;
        return;
      }
    }
    if (!box.isConnected) return;
    box.innerHTML = courseHtml(c, d);
  }

  function courseHtml(c, d) {
    // This stop: by number, else by name (the journey planner gives the sub-stop, e.g. a bus stop of the station)
    let here = c.stops.findIndex(s => s.eva === d.stop);
    if (here < 0) here = c.stops.findIndex(s => s.name === stop.name);
    const now = Date.now();
    const rows = c.stops.map((s, k) => {
      const at = k === 0 ? s.dep : s.arr || s.dep;
      const when = at ? new Date(at.rtTime || at.time).getTime() : 0;
      const cls = [k === here ? 'here' : '', k < here ? 'before' : '', when && when < now ? 'passed' : ''].join(' ').trim();
      return `<li class="${cls}">${at ? timeHtml(at, s.cancelled) : '<time></time>'} <span>${esc(short(s.name))}</span>` +
        `${s.cancelled ? ` <span class="late">${esc(t('r.stopCancelled'))}</span>` : ''} ${trackHtml(s)}` +
        `${s.notes.filter(n => n.high).map(n => `<small class="minor">${esc(n.text)}</small>`).join('')}</li>`;
    }).join('');
    const earlier = here > 0 ? `<button type="button" class="link-btn course-more">${esc(t(here === 1 ? 'd.earlier1' : 'd.earlier', { n: here }))}</button>` : '';
    return `${c.notes.map(n => `<p class="${n.high ? 'warn' : 'muted'}">${esc(n.text)}</p>`).join('')}` +
      `<div class="course-list">${earlier}<ol>${rows}</ol></div>`;
  }

  // ---------- Start ----------

  setInterval(() => { if (followNow && stop && document.visibilityState === 'visible') load(true); }, REFRESH_SECONDS * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && followNow && stop) load(true); });

  // Opened with a stop: departures.html?eva=…&name=…
  const qs = new URLSearchParams(location.search);
  if (qs.get('eva')) { chooseStop({ eva: qs.get('eva'), name: qs.get('name') || qs.get('eva') }); return; }
  setNow();
  if (stop) { input.value = stop.name; load(); } else status(t('d.choose'));
})();
