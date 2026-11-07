/* Umsteiger – map of one station (Leaflet): platforms, access points, walking route, exits and destination.
   Used by the station view (app.js) and for every change of a journey (route.js). Global: window.StationMap */
(function () {
  'use strict';
  const U = window.Umstieg;
  const t = window.I18N.t;
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const KIND = { steps: t('steps'), escalator: t('escalator'), elevator: t('elevator'), level: t('level') };
  const ZONE = { vorne: 'front', Mitte: 'middle', hinten: 'rear' };
  const zoneName = (z) => t('zone.' + ZONE[z]);
  const kindsText = (kinds) => kinds.length > 1
    ? t('kindsAlso', { main: KIND[kinds[0]], others: kinds.slice(1).map(k => KIND[k]).join(', ') })
    : KIND[kinds[0]];

  const quoted = (s) => t('quote', { s });

  // All access points of the platform for the list above the map ("Treppe 'Nord' · vorne · 80 m"; short, because a
  // list cannot wrap on a phone), the recommended one selected; choosing one overrides the recommendation
  const spotDist = (d, method) => !isFinite(d) ? t('noWalk') : t(method === 'walk' ? 'spotDist' : 'spotDistAir', { m: Math.round(d) });
  function spotOptions(r) {
    return (r.spots || []).map(sp => `<option value="${esc(sp.key)}"${sp === r.chosenSpot ? ' selected' : ''}>` +
      esc([kindsText(sp.kinds) + (sp.best.tags.name ? ' ' + quoted(sp.best.tags.name) : ''), zoneName(sp.zone),
        spotDist(sp.dist, r.method)].join(' · ')) + '</option>').join('');
  }

  // Section letters of a live train placed by its coach sequence, for draw(… { sections })
  const liveSections = (sequence, placement) => sequence && placement
    ? sequence.sectors.map(sec => ({ t: placement.toT((sec.start + sec.end) / 2), ref: sec.name })) : null;

  // Leaflet map with OSM tiles in the element (or element id)
  function create(el, lat, lon) {
    const map = L.map(el, { zoomControl: true }).setView([lat, lon], 17);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende'
    }).addTo(map);
    return map;
  }

  // Draws the recommendation r of recommend() (or just the station without r) and returns the new layer.
  // opts: { old: layer to replace, sections: [{ t, ref }] instead of the OSM section markers (live train),
  //         onSpot(accessKey): an access point was tapped, onExit(namedTarget | null, exit): an exit was tapped,
  //         fit: false = keep the view (after a tap on the map), view: { center, zoom } to show instead }
  function draw(map, st, r, opts) {
    opts = opts || {};
    r = r || {};
    if (opts.old) opts.old.remove();
    const layer = L.layerGroup().addTo(map);
    const ll = (p) => [p.lat, p.lon];
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#006f3c';
    const pick = css.getPropertyValue('--pick').trim() || '#e8710a';
    const goal = '#2d6cdf'; // target platform, exit or point

    // Area of the station data: outside it the app knows no ways (a point there is reached in a straight line)
    if (st.center && st.center.r) {
      // dark in both themes: the map tiles are always light
      L.circle([st.center.lat, st.center.lon], { radius: st.center.r, color: '#2f3a34', weight: 2.5, opacity: 0.85,
        dashArray: '6 6', fill: true, fillColor: '#2f3a34', fillOpacity: 0.05, interactive: false }).addTo(layer);
    }
    // … and the box of ways loaded around it for a destination farther out
    if (st.area) {
      const P = U.projector(st.center.lat, st.center.lon);
      L.rectangle([P.ll(st.area.x0, st.area.y0), P.ll(st.area.x1, st.area.y1)], { color: '#2f3a34', weight: 2, opacity: 0.6,
        dashArray: '6 6', fill: false, interactive: false }).addTo(layer);
    }

    const plKey = r.pl && r.pl.key, tgKey = r.target && r.target.key;
    for (const pl of Object.values(st.platforms)) {
      if (!pl.refs.length && pl.key !== plKey) continue;
      const color = pl.key === plKey ? accent : pl.key === tgKey ? goal : '#8a948f';
      const weight = pl.key === plKey || pl.key === tgKey ? 5 : 2;
      // Platforms mapped only as a point: the estimated segment is dashed
      const dash = pl.estimated ? { dashArray: '8 6' } : null;
      for (const line of pl.lines) L.polyline(line.map(ll), Object.assign({ color, weight, opacity: 0.9 }, dash)).addTo(layer);
    }

    if (r.pl && r.tFront !== undefined) {
      const P = U.projector(st.center.lat, st.center.lon);
      const at = (t) => { const x = r.pl.ax.mx + r.pl.ax.u[0] * t, y = r.pl.ax.my + r.pl.ax.u[1] * t; return P.ll(x, y); };
      const label = (t, text, cls) => L.marker(at(t), { interactive: false,
        icon: L.divIcon({ className: '', html: `<span class="lbl ${cls}">${text}</span>`, iconSize: null, iconAnchor: [20, 10] }) }).addTo(layer);
      // Train position, when a train length is chosen
      if (r.train) L.polyline([at(r.tRear), at(r.tFront)], { color: accent, weight: 10, opacity: 0.45 }).addTo(layer);
      label(r.tFront, esc(t('mapFront')), 'front');
      label(r.tRear, esc(zoneName('hinten')), '');
      for (const sec of opts.sections || r.pl.sections || []) {
        if (sec.t >= r.pl.ax.tmin - 20 && sec.t <= r.pl.ax.tmax + 20) label(sec.t, esc(sec.ref), 'sec');
      }
    }

    const bounds = [];
    for (const sp of r.spots || []) {
      const sel = sp === r.chosenSpot, equal = r.equal.includes(sp);
      const a = sel ? r.chosen : sp.best;
      const m = L.circleMarker(ll(a.anchor), {
        radius: sel || equal ? 10 : 7, color: sel || equal ? pick : '#555', weight: 2,
        fillColor: sel ? pick : '#fff', fillOpacity: 0.95, bubblingMouseEvents: false
      }).addTo(layer);
      m.bindTooltip(`${kindsText(sp.kinds)} · ${zoneName(sp.zone)}`);
      if (opts.onSpot) m.on('click', () => opts.onSpot(sp.key));
      bounds.push(ll(a.anchor));
    }
    // Exits: a tap chooses one as destination (exits without name or letter become the point on the map)
    const chosenExits = r.target && r.target.kind === 'exit' ? r.target.points : [];
    for (const e of st.exits || []) {
      const named = st.targets.find(x => x.exit && x.nodes.includes(e.key));
      const on = chosenExits.some(p => p.lat === e.lat && p.lon === e.lon);
      const m = L.circleMarker(ll(e), { radius: on ? 9 : 5, color: goal, weight: 2, fillColor: on ? goal : '#fff',
        fillOpacity: 0.95, bubblingMouseEvents: false }).addTo(layer);
      m.bindTooltip(named ? named.label : t('exitNoName'));
      if (opts.onExit) m.on('click', () => opts.onExit(named || null, e));
      if (on) bounds.push(ll(e));
    }
    if (r.target && r.target.kind === 'point') for (const p of r.target.points) {
      L.circleMarker(ll(p), { radius: 9, color: goal, weight: 2, fillColor: goal, fillOpacity: 0.95, interactive: false }).addTo(layer);
      bounds.push(ll(p));
    }
    for (const pl of [r.pl, r.target]) if (pl && pl.lines) for (const line of pl.lines) for (const p of line) bounds.push(ll(p));
    // Walking route from the chosen access point to the target platform
    if (r.route) {
      const P = U.projector(st.center.lat, st.center.lon);
      const path = r.route.map(([x, y]) => P.ll(x, y));
      // The straight last part to a point off the footway network is no known way: thin and dotted
      const walked = r.tail ? path.slice(0, -1) : path;
      if (walked.length > 1) L.polyline(walked, { color: pick, weight: 4, opacity: 0.9, dashArray: '6 6' }).addTo(layer);
      if (r.tail) L.polyline(path.slice(-2), { color: '#6b7570', weight: 2, opacity: 0.9, dashArray: '1 6', interactive: false }).addTo(layer);
      bounds.push(...path);
    }
    // Fitted without animation: after a tap the map must not fly away and back
    if (opts.view) map.setView(opts.view.center, opts.view.zoom, { animate: false });
    else if (opts.fit !== false && bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 18, animate: false });
    return layer;
  }

  window.StationMap = { create, draw, spotOptions, liveSections };
})();
