/* Umsteiger – helpers shared by all pages (texts, storage, server, small formatting). Global: window.Common */
(function () {
  'use strict';
  const U = window.Umstieg;
  const I = window.I18N, t = I.t;

  // Texts of the page (data-i18n, data-i18n-attr) and of core.js in the language of the browser (i18n.js)
  function applyTexts() {
    document.documentElement.lang = I.lang;
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-attr]').forEach(el => el.dataset.i18nAttr.split(',').forEach(pair => {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr, t(key));
    }));
    U.setTexts({ track: t('track'), platformNoName: t('core.platformNoName'), prevStop: t('core.prevStop'),
      shortTrain: t('core.shortTrain'), fullTrain: t('core.fullTrain'), exit: t('core.exit') });
  }

  // localStorage can be full, blocked or missing (private mode): never fail because of it
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* full or blocked */ } }
  };
  const readJson = (k, fallback) => {
    try { const v = JSON.parse(store.get(k)); return v == null ? fallback : v; } catch (e) { return fallback; }
  };

  // JSON from server.py (api/…); errors carry the HTTP status
  // Position for the place search to prefer (it finds "Kochstraße" near the user first, not in Ahlbeck):
  // the places given, else home, work, the last journey, the last departures stop. '' when none is known.
  function nearHint(...first) {
    const fav = readJson('umsteiger:fav', {}) || {}, trip = readJson('umsteiger:trip', {}) || {};
    const p = first.concat([fav.home, fav.work, trip.from, trip.to, readJson('umsteiger:depstop', null)])
      .find(x => x && isFinite(x.lat) && isFinite(x.lon) && x.lat !== null);
    return p ? `&lat=${Number(p.lat).toFixed(4)}&lon=${Number(p.lon).toFixed(4)}` : '';
  }

  async function api(path) {
    const res = await fetch('api/' + path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw Object.assign(new Error(data.error || 'HTTP ' + res.status), { status: res.status });
    return data;
  }

  // Leaflet from the CDN, loaded on first use (pages that always show a map load it with a script tag)
  let leaflet = null;
  function loadLeaflet() {
    if (!leaflet) leaflet = new Promise((resolve, reject) => {
      if (window.L) { resolve(window.L); return; }
      const base = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = base + 'leaflet.min.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = base + 'leaflet.min.js';
      js.onload = () => resolve(window.L);
      js.onerror = () => { leaflet = null; js.remove(); reject(new Error('leaflet')); };
      document.head.appendChild(js);
    });
    return leaflet;
  }

  // Status line and progress bar of a page
  function statusLine(el) {
    return (msg, isError) => {
      el.textContent = msg || '';
      el.className = 'status' + (isError ? ' error' : '');
    };
  }
  function progress(el) {
    let n = 0;
    return (on) => { n += on ? 1 : -1; el.hidden = n <= 0; };
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (iso) => iso ? iso.slice(11, 16) : '';
  // Minutes late of { time, rtTime } (planned and real time from the journey planner)
  const delay = (s) => s && s.rtTime && s.time ? Math.round((new Date(s.rtTime) - new Date(s.time)) / 60000) : 0;
  // Date as the value of <input type="datetime-local">
  const localTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  // Planned time with the delay behind it (from LATE minutes in red); struck through when cancelled
  const LATE = 5;
  function timeHtml(s, gone) {
    if (gone || s.cancelled) return `<time class="gone">${esc(hm(s.time))}</time>`;
    const d = delay(s);
    return `<time>${esc(hm(s.time))}</time>${d > 0 ? `<span class="${d >= LATE ? 'late' : 'minor'}">+${d}</span>` : ''}`;
  }
  // Track or bus stand; a changed track stands out: "Gl. 3 statt 2"
  function trackHtml(s) {
    if (s.rtTrack && s.track && s.rtTrack !== s.track) return `<span class="late">${esc(t('r.trackChange', { n: s.rtTrack, old: s.track }))}</span>`;
    const tr = s.rtTrack || s.track;
    return tr ? `<span class="muted">${esc(/^\d/.test(tr) ? t('trackShort', { n: tr }) : tr)}</span>` : '';
  }

  // Walking distance of a recommendation; a long straight last part (no ways known there) is named separately:
  // "ca. 60 m Fußweg + 55 m Luftlinie"
  function walkText(r, d) {
    if (!isFinite(d)) return '';
    if (r.method !== 'walk') return t('distAir', { m: Math.round(d) });
    if (r.tail >= U.TAIL_WARN) return d - r.tail < 5 ? t('distAir', { m: r.tail }) : t('distWalkAir', { walk: Math.round(d - r.tail), air: r.tail });
    return t('distWalk', { m: Math.round(d) });
  }
  const tailWarning = (r) => r.method === 'walk' && r.tail >= U.TAIL_WARN ? t('warnTail', { m: r.tail }) : '';

  window.Common = { walkText, tailWarning, applyTexts, store, readJson, nearHint, api, loadLeaflet, statusLine, progress, esc, pad, hm, delay, localTime,
    timeHtml, trackHtml };
})();
