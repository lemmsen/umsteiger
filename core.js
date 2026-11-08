/*
 * Umsteiger – core logic
 * Fetches platforms, stairs, elevators and routes from OpenStreetMap
 * and works out whether to board at the front, middle or rear of the train.
 * No dependencies; runs in the browser and in Node (for tests).
 */
(function (root) {
  'use strict';

  const ROUTE_TYPES = '^(light_rail|subway|train)$';
  const ACCESS_MAX_DIST = 12;       // m: max distance of an access point from the platform
  const ACCESS_EXTENT_TOL = 15;     // m: tolerance beyond the platform ends
  const LINK_MAX_DIST = 30;         // m: footway between a platform and stairs that still count as its access
  const BUFFER_SIDE = 12;           // m: buffer stop this close to the platform's centre line …
  const BUFFER_BEFORE = 20, BUFFER_BEYOND = 60; // … and between 20 m before and 60 m beyond the platform end
  const HEAD_END_ACCESS = 25;       // m: level access this close to the end with the buffer stop = head end
  const LEVEL_LEAVE_DIST = 8;       // m: a footway this far from the platform outline has left the platform
  const LEVEL_NEAR = 5;             // m: level access points closer than this to each other or to stairs count once
  const LEVEL_SEARCH_MAX = 400;     // footway nodes looked at per platform node
  const SECTION_MAX_DIST = 15;      // m: section marker (A–G) -> platform
  const SIGN_MAX_DIST = 20;         // m: stop sign on the track -> platform
  const SECTION_REACH = 60;         // m: a position belongs to the nearest section marker within this distance
  const SHORT_TRAIN_SHARE = 0.5;    // "Kurzzug" without a length: assumed half the platform

  // Display texts produced here; German by default, the app sets its language with setTexts()
  const TEXT = { track: 'Gleis {n}', platformNoName: 'Bahnsteig ohne Namen', prevStop: 'vorheriger Halt',
    shortTrain: 'Kurzzug', fullTrain: 'Vollzug', exit: 'Ausgang {name}' };
  function setTexts(texts) { Object.assign(TEXT, texts); }
  const SIGN_FIT_TOL = 20;          // m: a train may stick out this far beyond the platform end
  const SEQUENCE_MISFIT = 40;       // m: DB sectors and OSM section markers may disagree this much on average
  const SIGN_CHECK_DIST = 30;       // m: train front this close to a stop sign confirms the placement
  const SIGN_CONFLICT_FAR = 50, SIGN_CONFLICT_NEAR = 25; // m: front far from every sign, mirror image close to one
  // (checked on 16 real trains: no false alarm; a mirrored placement is caught in most cases)
  const PLATFORM_FOR_STOP_MAX = 30; // m: stop position -> nearest platform
  const AMBIGUOUS_COS = 0.35;       // direction nearly perpendicular to platform -> ambiguous
  const FAR_PREV = 10000;           // m: previous stop farther than this …
  const AMBIGUOUS_COS_FAR = 0.7;    // … needs a clearer angle
  const WALK_HIGHWAYS = 'footway|path|pedestrian|corridor'; // ways used for walking routes (plus stairs etc.)
  const ENTRANCES = 'subway_entrance|train_station_entrance'; // railway=* of station entrances (exits)
  const POINT_KEY = 'point';        // target key of a destination chosen on the map
  // Bump DATA_VERSION whenever this file changes the station model, so stations cached in the browser are rebuilt
  const DATA_VERSION = 22;
  const SPOT_GAP = 15;              // m: access ways closer than this along the platform form one spot
  const TIE_ABS = 5;                // m: spots within this distance of the best one count as equal
  // Platforms mapped only as a point (a placeholder, U Spichernstraße): a segment of an assumed length
  // along the direction from the previous stops, and access points farther away than usual
  const ESTIMATED_LENGTH = { subway: 100, light_rail: 140, train: 200 }; // m, rough typical platform lengths
  const ESTIMATED_ACCESS_DIST = 40; // m, beside the segment and beyond its ends

  // ---------- Geometry ----------

  function projector(lat0, lon0) {
    const k = Math.PI / 180 * 6371000;
    const kx = k * Math.cos(lat0 * Math.PI / 180);
    return {
      xy: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * k],
      ll: (x, y) => [lat0 + y / k, lon0 + x / kx]
    };
  }

  function distSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function distToLines(p, lines) {
    let best = Infinity;
    for (const line of lines) {
      if (line.length === 1) best = Math.min(best, Math.hypot(p.x - line[0].x, p.y - line[0].y));
      for (let i = 1; i < line.length; i++) best = Math.min(best, distSeg(p, line[i - 1], line[i]));
    }
    return best;
  }

  // Main axis of the platform (principal component analysis of all vertices)
  function axisOf(lines) {
    const pts = [].concat(...lines);
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) {
      const dx = p.x - mx, dy = p.y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const u = [Math.cos(ang), Math.sin(ang)];
    let tmin = Infinity, tmax = -Infinity;
    for (const p of pts) {
      const t = (p.x - mx) * u[0] + (p.y - my) * u[1];
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    return { mx, my, u, tmin, tmax };
  }

  function proj(ax, p) { return (p.x - ax.mx) * ax.u[0] + (p.y - ax.my) * ax.u[1]; }

  // ---------- Overpass queries ----------

  function stationQuery(lat, lon, r) {
    const a = `(around:${r},${lat},${lon})`;
    return `[out:json][timeout:60];
(
  node["public_transport"="stop_position"]${a};
  node["railway"="stop"]${a};
)->.stops;
(
  way["railway"="platform"]${a};
  way["public_transport"="platform"]${a};
  rel["railway"="platform"]${a};
  rel["public_transport"="platform"]${a};
)->.plats;
(
  way["highway"="steps"]${a};
  way["conveying"]${a};
  node["highway"="elevator"]${a};
  way["highway"="elevator"]${a};
)->.access;
way["highway"~"^(${WALK_HIGHWAYS})$"]${a}->.walk;
node["railway"~"^(${ENTRANCES}|buffer_stop)$"]${a}->.exits;
(
  rel(bn.stops)["route"~"${ROUTE_TYPES}"];
  rel(bw.plats)["route"~"${ROUTE_TYPES}"];
  rel(br.plats)["route"~"${ROUTE_TYPES}"];
)->.routes;
.stops out body;
.plats out geom;
.access out geom;
.walk out geom;
.exits out body;
.routes out body;`;
  }

  function lookupQuery(keys) {
    const n = keys.filter(k => k[0] === 'n').map(k => k.slice(1));
    const w = keys.filter(k => k[0] === 'w').map(k => k.slice(1));
    const r = keys.filter(k => k[0] === 'r').map(k => k.slice(1));
    let q = '[out:json][timeout:30];\n';
    if (n.length) q += `node(id:${n.join(',')});out body;\n`;
    if (w.length) q += `way(id:${w.join(',')});out center;\n`;
    if (r.length) q += `rel(id:${r.join(',')});out center;\n`;
    return q;
  }

  // ---------- Build model ----------

  const keyOf = (type, id) => type[0] + id;

  function kindOf(t) {
    if (t.highway === 'elevator') return 'elevator';
    if (t.conveying) return 'escalator';
    return 'steps';
  }

  function buildStation(raw, center) {
    const P = projector(center.lat, center.lon);
    const pt = (lat, lon) => { const [x, y] = P.xy(lat, lon); return { lat, lon, x, y }; };

    const geomLines = (el) => {
      if (el.type === 'node') return [[pt(el.lat, el.lon)]];
      if (el.type === 'way' && el.geometry) return [el.geometry.filter(Boolean).map(g => pt(g.lat, g.lon))];
      if (el.type === 'relation' && el.members) {
        return el.members.filter(m => m.type === 'way' && m.geometry)
          .map(m => m.geometry.filter(Boolean).map(g => pt(g.lat, g.lon)));
      }
      return [];
    };

    const stops = {}, platforms = {}, access = [], routes = [], walk = [], markers = [], exits = [], buffers = [];
    const seen = new Set();
    const walkRe = new RegExp('^(' + WALK_HIGHWAYS + ')$'), entranceRe = new RegExp('^(' + ENTRANCES + ')$');
    // Ways below or above the street (the walk to a point on the map starts on the surface)
    const offSurface = (t) => t.highway === 'corridor' || t.indoor === 'yes' || (!!t.tunnel && t.tunnel !== 'no') ||
      (!!t.level && t.level !== '0');
    const xyOf = (pts) => pts.map(p => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100]);
    const levelsOf = (t) => { const l = parseLevels(t.level); return l ? { l } : null; };

    for (const el of raw.elements || []) {
      const t = el.tags || {};
      const k = keyOf(el.type, el.id);
      if (seen.has(k)) continue;
      seen.add(k);
      if (el.type === 'relation' && t.route) { routes.push(el); continue; }
      if (t.railway === 'platform' || t.public_transport === 'platform') {
        const lines = geomLines(el).filter(l => l.length);
        if (lines.length) platforms[k] = { key: k, tags: t, lines, refs: [], rail: t.railway === 'platform' };
        continue;
      }
      if (el.type === 'node' && (t.public_transport === 'stop_position' || t.railway === 'stop')) {
        stops[k] = { key: k, tags: t, p: pt(el.lat, el.lon) };
        continue;
      }
      if (el.type === 'node' && t.railway === 'buffer_stop') { buffers.push(pt(el.lat, el.lon)); continue; }
      if (el.type === 'node' && t['railway:platform:section']) {
        markers.push({ section: t['railway:platform:section'], p: pt(el.lat, el.lon) });
        continue;
      }
      if (el.type === 'node' && t['railway:signal:stop'] && t['umsteiger:bearing']) {
        markers.push({ caption: t['railway:signal:stop:caption'] || '', bearing: Number(t['umsteiger:bearing']), p: pt(el.lat, el.lon) });
        continue;
      }
      const blocked = /^(no|private)$/.test(t.access || '') || t.foot === 'no';
      // Station entrances are the exits one can choose as destination (an entrance may be an elevator, too)
      if (el.type === 'node' && entranceRe.test(t.railway || '') && !blocked) {
        const p = pt(el.lat, el.lon);
        exits.push({ key: k, name: t.name || '', ref: t.ref || '', lat: p.lat, lon: p.lon, x: p.x, y: p.y });
      }
      if (t.highway === 'steps' || t.highway === 'elevator' || t.conveying) {
        const pts = [].concat(...geomLines(el));
        // Closed stairs and lifts (access=no|private, foot=no) are neither an access point nor part of a walk
        if (pts.length && !blocked) {
          access.push({ key: k, kind: kindOf(t), tags: t, pts });
          walk.push(Object.assign({ k: kindOf(t), p: xyOf(pts) }, levelsOf(t)));
        }
        continue;
      }
      if (el.type === 'way' && walkRe.test(t.highway || '') && !blocked) {
        const pts = [].concat(...geomLines(el));
        if (pts.length > 1) walk.push(Object.assign({ k: 'walk', p: xyOf(pts) }, offSurface(t) ? { u: 1 } : null, levelsOf(t)));
      }
    }

    for (const pl of Object.values(platforms)) {
      pl.ax = axisOf(pl.lines);
      if ([].concat(...pl.lines).length === 1) pl.estimated = true; // axis and length follow in finalize()
    }

    // Terminus platforms, first half: a buffer stop just beyond one end and none at the other.
    // (Second half below: people also leave the platform on the level at that end.)
    for (const pl of Object.values(platforms)) {
      if (!pl.rail || pl.estimated) continue;
      let hi = false, lo = false;
      for (const b of buffers) {
        const t = proj(pl.ax, b);
        const side = Math.abs(-(b.x - pl.ax.mx) * pl.ax.u[1] + (b.y - pl.ax.my) * pl.ax.u[0]);
        if (side > BUFFER_SIDE) continue;
        if (t > pl.ax.tmax - BUFFER_BEFORE && t < pl.ax.tmax + BUFFER_BEYOND) hi = true;
        if (t < pl.ax.tmin + BUFFER_BEFORE && t > pl.ax.tmin - BUFFER_BEYOND) lo = true;
      }
      if (hi !== lo) pl.bufferEnd = hi ? 1 : -1;
    }

    // Section markers (A–G) and stop signs (Haltetafeln) belong to the nearest platform
    for (const m of markers) {
      let best = null, bd = m.section ? SECTION_MAX_DIST : SIGN_MAX_DIST;
      for (const pl of Object.values(platforms)) {
        if (pl.estimated) continue;
        const d = distToLines(m.p, pl.lines);
        if (d < bd) { bd = d; best = pl; }
      }
      if (!best) continue;
      const t = proj(best.ax, m.p);
      if (t < best.ax.tmin - ACCESS_EXTENT_TOL || t > best.ax.tmax + ACCESS_EXTENT_TOL) continue;
      if (m.section) { (best.sections = best.sections || []).push({ ref: m.section, t }); continue; }
      // Bearing (0 = north) -> +1 / -1 along the platform axis
      const b = m.bearing * Math.PI / 180, cos = Math.sin(b) * best.ax.u[0] + Math.cos(b) * best.ax.u[1];
      if (Math.abs(cos) < 0.5) continue;
      (best.signs = best.signs || []).push({ t, dir: cos > 0 ? 1 : -1, caption: m.caption });
    }

    const nearestPlatform = (p, max) => {
      let best = null, bd = max;
      for (const pl of Object.values(platforms)) {
        const d = distToLines(p, pl.lines);
        if (d < bd) { bd = d; best = pl; }
      }
      return best;
    };

    // Evaluate routes
    const routeInfos = [];
    const need = new Set();
    for (const r of routes) {
      const t = r.tags || {};
      const m = r.members || [];
      const stopSeq = m.filter(x => x.type === 'node' && /^stop/.test(x.role)).map(x => keyOf(x.type, x.ref));
      const platSeq = m.filter(x => /^platform/.test(x.role)).map(x => keyOf(x.type, x.ref));

      let seq = stopSeq, i = stopSeq.findIndex(k => stops[k]);
      if (i < 0) { seq = platSeq; i = platSeq.findIndex(k => platforms[k]); }
      if (i < 0) continue;
      // Circular lines start and end at the same stop: use the arrival at the end
      if (i === 0) {
        const j = seq.length - 1 - [...seq].reverse().findIndex(k => stops[k] || platforms[k]);
        if (j > 0) i = j;
      }

      let plKey = platSeq.find(k => platforms[k]);
      if (!plKey && seq === stopSeq) {
        const near = nearestPlatform(stops[seq[i]].p, PLATFORM_FOR_STOP_MAX);
        if (near) plKey = near.key;
      }
      if (!plKey) continue;
      const pl = platforms[plKey];
      const ref = t.ref || t.name || '?';
      if (!pl.refs.includes(ref)) pl.refs.push(ref);

      if (i === 0) continue; // train starts here – nobody arrives with it
      const here = seq === stopSeq ? stops[seq[i]].p : { x: pl.ax.mx, y: pl.ax.my };
      const prevKey = seq[i - 1];
      if (!stops[prevKey] && !platforms[prevKey]) need.add(prevKey);

      routeInfos.push({
        id: r.id, ref, name: t.name || '', to: t.to || '', routeType: t.route,
        colour: t.colour || '', plat: plKey, here: { x: here.x, y: here.y }, prevKey
      });
    }

    // Assign each access point to its nearest platform (platforms mapped as a point get theirs in finalize())
    const platList = Object.values(platforms).filter(pl => !pl.estimated);
    const onPlatform = [], spare = [];
    for (const a of access) {
      let best = null;
      for (const pl of platList) {
        if (!stopsAt(a, pl)) continue;
        for (const v of a.pts) {
          const d = distToLines(v, pl.lines);
          if (!best || d < best.d) best = { d, pl, v };
        }
      }
      if (!best || best.d > ACCESS_MAX_DIST) { spare.push(a); continue; }
      const tt = proj(best.pl.ax, best.v);
      if (tt < best.pl.ax.tmin - ACCESS_EXTENT_TOL || tt > best.pl.ax.tmax + ACCESS_EXTENT_TOL) { spare.push(a); continue; }
      onPlatform.push(Object.assign(a, { platform: best.pl.key, anchor: best.v, t: tt }));
    }

    const st = {
      name: center.name || '', center: { lat: center.lat, lon: center.lon, r: center.r },
      platforms, stops, access: onPlatform, walk, exits, routeInfos, need: [...need], lookup: {}
    };
    if (platList.length < Object.keys(platforms).length) st.spare = spare;
    st.access.push(...linkedAccess(st, access, P));
    st.access.push(...levelAccess(st, P));
    // Terminus platforms, second half: buffer stops alone also stand behind the ends of through platforms
    // (sidings at Hannover Hbf). A real head end is where the platform is left on the level. Every train
    // then arrives heading for that end, whatever the position of the previous stop says.
    for (const pl of Object.values(platforms)) {
      const end = pl.bufferEnd > 0 ? pl.ax.tmax : pl.ax.tmin;
      if (pl.bufferEnd && st.access.some(a => a.platform === pl.key && a.kind === 'level' && Math.abs(a.t - end) <= HEAD_END_ACCESS)) {
        pl.deadEnd = pl.bufferEnd;
      }
      delete pl.bufferEnd;
    }
    return st;
  }

  // "-1;-3" -> [-1, -3]; null if there is no usable level tag
  function parseLevels(v) {
    if (v === undefined || v === null || v === '') return null;
    const out = String(v).split(';').map(x => parseFloat(x)).filter(x => !isNaN(x));
    return out.length ? out : null;
  }
  // Two things can be on the same level unless both say otherwise
  const sameLevel = (a, b) => !a || !b || a.some(x => b.includes(x));
  // A lift lists every level it stops at: one that does not stop at the platform's level only passes by
  // (Gesundbrunnen: the lift "S+U8" goes from the street to the U8 right beside platform 7/8 on level -1).
  // Stairs often name only one of their ends, so they are not checked.
  const stopsAt = (a, pl) => a.kind !== 'elevator' || sameLevel(parseLevels(a.tags.level), parseLevels(pl.tags.level));

  // Stairs, escalators and elevators that are not at a platform but joined to it by a short footway
  // (Gesundbrunnen: the stairs from platform 1/2 down to the U8 start at the end of an 11 m corridor).
  // They become access points of that platform too, anchored where the footway leaves the platform.
  // Places where a footway leaves the platform on its own level: the head end of a terminus platform
  // (München Hbf), a path or ramp at a small station. No stairs or lift there, so the platform had no
  // access point at all. They get the kind 'level'.
  function levelAccess(st, P) {
    const g = walkGraph(st), out = [];
    for (const pl of Object.values(st.platforms)) {
      const chain = g.platformNodes[pl.key] || [], own = new Set(chain);
      const plLevels = parseLevels(pl.tags.level);
      // Not where a corridor to stairs or a lift starts (linkedAccess): that is their access, not a level one
      const taken = st.access.filter(a => a.platform === pl.key && a.linked !== undefined).map(a => a.t);
      const found = [];
      for (const i of chain) {
        const t = proj(pl.ax, { x: g.xs[i], y: g.ys[i] });
        if (taken.some(x => Math.abs(x - t) < LEVEL_NEAR) || found.some(f => Math.abs(f.t - t) < LEVEL_NEAR)) continue;
        if (leavesPlatform(g, pl, own, plLevels, i)) found.push({ i, t });
      }
      for (const f of found) {
        const x = g.xs[f.i], y = g.ys[f.i], [lat, lon] = P.ll(x, y), anchor = { x, y, lat, lon };
        out.push({ key: 'level:' + pl.key + ':' + Math.round(f.t), kind: 'level', tags: {}, pts: [anchor],
          platform: pl.key, anchor, t: f.t });
      }
    }
    return out;
  }

  // Does a plain footway lead away from the platform from this node, on the platform's level?
  function leavesPlatform(g, pl, own, plLevels, start) {
    const seen = new Set([start]), stack = [start];
    for (let n = 0; stack.length && n < LEVEL_SEARCH_MAX; n++) {
      const i = stack.pop();
      for (const [j, , kind] of g.adj[i]) {
        // From the platform itself also the short link to a snapped loose end ('platform'), then footways only
        if (seen.has(j) || own.has(j) || !(kind === 'walk' || (i === start && kind === 'platform'))) continue;
        if (!sameLevel(plLevels, g.levels[j])) continue;
        if (distToLines({ x: g.xs[j], y: g.ys[j] }, pl.lines) >= LEVEL_LEAVE_DIST) return true;
        seen.add(j);
        stack.push(j);
      }
    }
    return false;
  }

  function linkedAccess(st, access, P) {
    const g = walkGraph(st);
    const byNode = new Map(); // graph node -> access ways with a vertex there
    for (const a of access) {
      for (const v of a.pts) {
        const i = g.at(v);
        if (i === undefined) continue;
        if (!byNode.has(i)) byNode.set(i, []);
        byNode.get(i).push(a);
      }
    }
    const out = [];
    for (const pl of Object.values(st.platforms)) {
      const plLevels = parseLevels(pl.tags.level);
      const have = new Set(st.access.filter(a => a.platform === pl.key).map(a => a.key));
      const own = new Set(g.platformNodes[pl.key] || []);
      // Shortest walks from the platform over plain footways only, up to LINK_MAX_DIST
      const dist = new Map(), origin = new Map(), queue = [];
      for (const i of g.platformNodes[pl.key] || []) { dist.set(i, 0); origin.set(i, i); queue.push(i); }
      while (queue.length) {
        queue.sort((a, b) => dist.get(b) - dist.get(a));
        const i = queue.pop(), d = dist.get(i);
        for (const a of byNode.get(i) || []) {
          if (have.has(a.key) || !sameLevel(plLevels, parseLevels(a.tags.level))) continue;
          have.add(a.key);
          const o = origin.get(i), x = g.xs[o], y = g.ys[o], [lat, lon] = P.ll(x, y);
          out.push(Object.assign({}, a, { platform: pl.key, anchor: { x, y, lat, lon }, t: proj(pl.ax, { x, y }), linked: Math.round(d) }));
        }
        for (const [j, cost, kind] of g.adj[i]) {
          // Plain footways, and from the platform itself the short link to a snapped loose end
          if (!(kind === 'walk' || (kind === 'platform' && own.has(i) && !own.has(j)))) continue;
          if (d + cost > LINK_MAX_DIST || (dist.has(j) && dist.get(j) <= d + cost)) continue;
          dist.set(j, d + cost); origin.set(j, origin.get(i)); queue.push(j);
        }
      }
      anchorAtPlatform(st, g, pl, dist);
    }
    return out;
  }

  // Stairs and escalators start at the end that can be reached from the platform without steps.
  // Before, the end closer to the platform edge was taken – for stairs running along the platform often
  // the top – and every flight of a staircase mapped in several ways counted as an access point of its own
  // (Gesundbrunnen 5/6: the route began at the top of the third flight and skipped the stairs).
  // dist: walking distances from the platform over footways only (linkedAccess).
  function anchorAtPlatform(st, g, pl, dist) {
    const reach = (v) => { const i = g.at(v); return i !== undefined && dist.has(i) ? dist.get(i) : Infinity; };
    const ways = st.access.filter(a => a.platform === pl.key && a.pts.length > 1).map(a => {
      const ends = [a.pts[0], a.pts[a.pts.length - 1]], d = ends.map(reach);
      return d[0] <= d[1] ? { a, end: ends[0], d: d[0] } : { a, end: ends[1], d: d[1] };
    });
    if (!ways.some(w => isFinite(w.d))) return; // the footway network says nothing about this platform
    for (const w of ways) {
      if (isFinite(w.d)) { w.a.anchor = w.end; w.a.t = proj(pl.ax, w.end); continue; }
      // Not reachable: an upper flight continues from other ways at its near end; a loose end is just
      // a badly connected staircase and stays as it was
      const i = g.at(w.a.anchor);
      if (i !== undefined && g.adj[i].length > 1) st.access.splice(st.access.indexOf(w.a), 1);
    }
  }

  function applyLookup(st, raw) {
    const P = projector(st.center.lat, st.center.lon);
    for (const el of (raw && raw.elements) || []) {
      const c = el.type === 'node' ? el : el.center;
      if (!c) continue;
      const [x, y] = P.xy(c.lat, c.lon);
      st.lookup[keyOf(el.type, el.id)] = { x, y, name: (el.tags && el.tags.name) || '' };
    }
    return st;
  }

  // Position and name of a stop or platform from the station query
  function localPoint(st, k) {
    if (st.stops[k]) return { x: st.stops[k].p.x, y: st.stops[k].p.y, name: st.stops[k].tags.name || '' };
    const pl = st.platforms[k];
    if (pl) return { x: pl.ax.mx, y: pl.ax.my, name: pl.tags.name || '' };
    return null;
  }

  // ---------- Timetable (GTFS, prepared by tools/prepare-gtfs.js) ----------

  const PLATFORM_CODE_MAX = 40;  // m: timetable platform position -> OSM platform with that number
  const PREV_MATCH_MAX = 1000;   // m: previous stop of an OSM route vs. the timetable's previous stop

  // "S+U Berlin Hauptbahnhof" -> "Berlin Hauptbahnhof", "S Bornholmer Str. (Berlin)" -> "Bornholmer Str."
  const cleanName = (n) => (n || '').replace(/^(S\+U|S|U)\s+/, '').replace(/\s*\([^)]*\)$/, '').replace(/\s+Bhf$/, '');
  const splitRefs = (v) => (v || '').split(/\s*[;,]\s*/).filter(Boolean);
  const sameRef = (a, b) => a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase();

  // Replaces the lines found in OSM route relations with the timetable's lines.
  // Run after applyLookup: the OSM routes still help to find the platform.
  // Platform per line, in this order: platform number from the timetable,
  // OSM route relation of the same line, route_ref on the OSM platform, otherwise unknown.
  function applyTimetable(st, tt) {
    const P = projector(st.center.lat, st.center.lon);
    const xy = (p) => { const [x, y] = P.xy(p.lat, p.lon); return { x, y }; };
    const platforms = Object.values(st.platforms);
    const infos = [];

    // Modes served at each platform, from OSM routes and platform tags (S-Bahn and trains count as one mode)
    const mode = (t) => t === 'subway' ? 'subway' : 'rail';
    const modes = {};
    for (const pl of platforms) {
      const m = modes[pl.key] = new Set();
      if (pl.tags.subway === 'yes') m.add('subway');
      if (pl.tags.train === 'yes' || pl.tags.light_rail === 'yes') m.add('rail');
    }
    for (const r of st.routeInfos) if (modes[r.plat]) modes[r.plat].add(mode(r.routeType));
    const fits = (pl, type) => !modes[pl.key].size || modes[pl.key].has(mode(type));

    // "Hamburg, Stadthausbrücke" -> "Stadthausbrücke" when the station itself is in Hamburg
    const city = /^([^,]+),/.exec(tt.name || '');
    const cityPrefix = city ? new RegExp('^' + city[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ',\\s*') : /^$/;

    for (const l of (tt && tt.lines) || []) {
      let plat = null, how = null;

      if (l.platform.code) {
        const p = xy(l.platform);
        let bd = PLATFORM_CODE_MAX;
        for (const pl of platforms) {
          const refs = [pl.tags.ref, pl.tags.local_ref, pl.tags['railway:track_ref']].flatMap(splitRefs);
          if (!refs.includes(l.platform.code) || !fits(pl, l.type)) continue;
          const d = distToLines(p, pl.lines);
          if (d < bd) { bd = d; plat = pl.key; how = 'code'; }
        }
      }

      const routes = st.routeInfos.filter(r => sameRef(r.ref, l.ref));
      if (!plat && routes.length) {
        const prev = xy(l.prev);
        let bd = PREV_MATCH_MAX;
        for (const r of routes) {
          const q = st.lookup[r.prevKey] || localPoint(st, r.prevKey);
          if (!q) continue;
          const d = Math.hypot(q.x - prev.x, q.y - prev.y);
          if (d < bd) { bd = d; plat = r.plat; how = 'route'; }
        }
        if (!plat && routes.every(r => r.plat === routes[0].plat)) { plat = routes[0].plat; how = 'route'; }
      }

      if (!plat) {
        const hits = platforms.filter(pl => fits(pl, l.type) && splitRefs(pl.tags.route_ref).some(r => sameRef(r, l.ref)));
        if (hits.length === 1) { plat = hits[0].key; how = 'route_ref'; }
      }

      const pl = plat ? st.platforms[plat] : null;
      if (pl) {
        // "S 1" from OSM and "S1" from the timetable are the same line; keep the timetable's spelling
        const i = pl.refs.findIndex(r => sameRef(r, l.ref));
        if (i < 0) pl.refs.push(l.ref); else pl.refs[i] = l.ref;
      }
      const prevKey = 'g' + l.prev.id;
      st.lookup[prevKey] = Object.assign(xy(l.prev), { name: l.prev.name.replace(cityPrefix, '') });
      const colour = (routes.find(r => r.colour) || {}).colour || '';
      infos.push({
        id: 'gtfs', ref: l.ref, name: '', to: cleanName(l.destinations[0]), routeType: l.type, colour,
        plat, how, here: pl ? { x: pl.ax.mx, y: pl.ax.my } : null, prevKey
      });
    }

    st.routeInfos = infos;
    st.timetable = { id: tt.id, prepared: tt.prepared };
    return st;
  }

  // Direction of travel along a platform: +1 if the train runs towards the axis' positive end
  function directionOn(pl, here, prev) {
    if (pl.deadEnd) return { sign: pl.deadEnd, ambiguous: false }; // terminus platform
    const vx = here.x - prev.x, vy = here.y - prev.y;
    const len = Math.hypot(vx, vy);
    if (len < 1) return null;
    const cos = (vx * pl.ax.u[0] + vy * pl.ax.u[1]) / len;
    // A far previous stop says little about the direction at the platform (curves on the way)
    const limit = len > FAR_PREV ? AMBIGUOUS_COS_FAR : AMBIGUOUS_COS;
    return { sign: cos >= 0 ? 1 : -1, ambiguous: Math.abs(cos) < limit };
  }

  const TYPE_ORDER = { light_rail: 0, subway: 1, train: 2 };
  const MAX_LABEL_REFS = 6; // lines listed per target platform
  const natCmp = (a, b) => a.localeCompare(b, 'de', { numeric: true });

  // Platforms mapped only as a point: a segment through the point along the direction in which the trains
  // come in (from the previous stops; from both sides on a through platform), of a typical length for the
  // kind of train. Stairs and lifts up to ESTIMATED_ACCESS_DIST away (also beyond the assumed ends) become its access points. Without any
  // previous stop the point stays as it is (no direction, no access).
  function estimatePlatforms(st) {
    const P = projector(st.center.lat, st.center.lon);
    const est = Object.values(st.platforms).filter(pl => pl.estimated);
    for (const pl of est) {
      const here = { x: pl.ax.mx, y: pl.ax.my };
      let ux = 0, uy = 0, len = 0;
      for (const r of st.routeInfos) {
        if (r.plat !== pl.key) continue;
        const prev = st.lookup[r.prevKey] || localPoint(st, r.prevKey);
        if (!prev) continue;
        let vx = here.x - prev.x, vy = here.y - prev.y;
        const l = Math.hypot(vx, vy);
        if (l < 1) continue;
        vx /= l; vy /= l;
        if (vx * ux + vy * uy < 0) { vx = -vx; vy = -vy; } // trains from the other side
        ux += vx; uy += vy;
        len = Math.max(len, ESTIMATED_LENGTH[r.routeType] || ESTIMATED_LENGTH.subway);
      }
      const l = Math.hypot(ux, uy);
      if (!len || l < 0.5) continue;
      ux /= l; uy /= l;
      pl.lines = [[-len / 2, len / 2].map(t => {
        const x = here.x + t * ux, y = here.y + t * uy, [lat, lon] = P.ll(x, y);
        return { lat, lon, x, y };
      })];
      pl.ax = axisOf(pl.lines);
      // Level and linked access points found at the point: their position along the new axis
      for (const a of st.access) if (a.platform === pl.key) a.t = proj(pl.ax, a.anchor);
    }
    const shaped = est.filter(pl => pl.lines[0].length > 1);
    for (const a of st.spare || []) {
      let best = null;
      for (const pl of shaped) {
        if (!stopsAt(a, pl)) continue;
        for (const v of a.pts) {
          const d = distToLines(v, pl.lines);
          if (!best || d < best.d) best = { d, pl, v };
        }
      }
      if (!best || best.d > ESTIMATED_ACCESS_DIST) continue;
      const t = proj(best.pl.ax, best.v);
      if (t < best.pl.ax.tmin - ESTIMATED_ACCESS_DIST || t > best.pl.ax.tmax + ESTIMATED_ACCESS_DIST) continue;
      st.access.push(Object.assign(a, { platform: best.pl.key, anchor: best.v, t }));
    }
    delete st.spare;
  }

  function finalize(st) {
    estimatePlatforms(st);
    const groups = {};
    for (const r of st.routeInfos) {
      const pl = r.plat ? st.platforms[r.plat] : null;
      const prev = st.lookup[r.prevKey] || localPoint(st, r.prevKey);
      if (!prev || (r.plat && !pl)) continue;
      let dir = null;
      if (pl) {
        dir = directionOn(pl, r.here, prev);
        if (!dir) continue;
      }
      const prevName = cleanName(prev.name) || TEXT.prevStop;
      // Lines with unknown platform: one option per line and previous stop, platform chosen by the user
      // One option per line, platform and previous stop (never merge different origins)
      const gk = [r.ref, pl ? r.plat : '?', prevName].join('|');
      const g = groups[gk] || (groups[gk] = {
        key: gk, ref: r.ref, routeType: r.routeType, colour: r.colour, plat: pl ? r.plat : null,
        frontSign: dir ? dir.sign : null, prev: { x: prev.x, y: prev.y }, prevNames: [], tos: [], ambiguous: false
      });
      if (!g.prevNames.includes(prevName)) g.prevNames.push(prevName);
      if (r.to && !g.tos.includes(r.to)) g.tos.push(r.to);
      if (dir && dir.ambiguous) g.ambiguous = true;
    }

    st.options = Object.values(groups).sort((a, b) =>
      (TYPE_ORDER[a.routeType] ?? 9) - (TYPE_ORDER[b.routeType] ?? 9) || natCmp(a.ref, b.ref) ||
      natCmp(a.prevNames[0], b.prevNames[0]));

    for (const pl of Object.values(st.platforms)) pl.refs.sort(natCmp);
    st.targets = Object.values(st.platforms)
      .filter(pl => pl.refs.length)
      .map(pl => ({ key: pl.key, refs: pl.refs, label: platformLabel(pl) }))
      .sort((a, b) => natCmp(a.label, b.label));

    // Exits with a letter or a name, after the platforms: "Ausgang A2 · Alsterarkaden". Entrances with the
    // same text are one exit; a name that only repeats the station's name says nothing.
    const own = new Set(tokens(st.name)), byText = {};
    for (const e of st.exits || []) {
      const name = tokens(e.name).every(w => own.has(w)) ? '' : e.name;
      const text = [e.ref, name].filter(Boolean).join(' · ');
      if (text) (byText[text] = byText[text] || []).push(e.key);
    }
    st.targets.push(...Object.keys(byText).sort(natCmp)
      .map(text => ({ key: 'exit:' + text, refs: [], label: TEXT.exit.replace('{name}', text), exit: true, nodes: byText[text] })));
    return st;
  }

  // Destination of the walk: a platform (key of st.platforms), an exit (key of st.targets) or a point
  // chosen on the map ({ lat, lon }). Exits and points are { key, kind, label, lines: [], points: [{ x, y, lat, lon }] }.
  function targetOf(st, target) {
    if (target && typeof target === 'object') {
      if (target.points) return target;
      const P = projector(st.center.lat, st.center.lon), [x, y] = P.xy(target.lat, target.lon);
      return { key: POINT_KEY, kind: 'point', label: '', lines: [], points: [{ x, y, lat: target.lat, lon: target.lon }] };
    }
    if (target === POINT_KEY) return { key: POINT_KEY, kind: 'point', label: '', lines: [], points: [] };
    if (st.platforms[target]) return st.platforms[target];
    const ex = (st.targets || []).find(t => t.exit && t.key === target);
    if (!ex) return null;
    return { key: ex.key, kind: 'exit', label: ex.label, lines: [],
      points: (st.exits || []).filter(e => ex.nodes.includes(e.key)).map(e => ({ x: e.x, y: e.y, lat: e.lat, lon: e.lon })) };
  }

  // Straight-line distance from a point to the target
  function distToTarget(p, target) {
    if (!target.points) return distToLines(p, target.lines);
    return Math.min(...target.points.map(q => Math.hypot(p.x - q.x, p.y - q.y)));
  }

  // Target list: "Gleis 1/2 · S1 S2 S25 …"; arrival list (withLines false): "Gleis 1/2" only.
  // Without a track number the lines, otherwise the name.
  function platformLabel(pl, withLines) {
    const tr = (pl.tags.ref || pl.tags.local_ref || '').replace(/\s*;\s*/g, '/');
    const track = /\d/.test(tr) ? TEXT.track.replace('{n}', tr) : ''; // "B" or a stop name is no track number
    const shown = pl.refs.length > MAX_LABEL_REFS ? pl.refs.slice(0, MAX_LABEL_REFS).concat('…') : pl.refs;
    const lines = shown.join(' ');
    if (track) return withLines === false || !lines ? track : track + ' · ' + lines;
    return lines || pl.tags.name || tr || TEXT.platformNoName;
  }

  // Platforms where one can arrive, with the lines arriving there and, per line, one entry per previous stop:
  // [{ key, label, routeType, known, lines: [{ key, ref, routeType, guessed, directions: [option] }] }]
  // A direction is an option with plat and frontSign (can be passed to recommend()). Lines with unknown
  // platform are offered on platforms with lines of the same type (or without known lines); their
  // direction is computed for that platform (platformChosen). Lines that fit nowhere go to all
  // non-subway platforms. A platform without any arrival in the timetable (e.g. only used when trains
  // are diverted) offers the timetable lines that OSM knows there, so it can still be chosen.
  function arrivals(st) {
    const opts = st.options || [];
    const unknown = opts.filter(o => !o.plat);
    const pls = Object.values(st.platforms);
    const knownOn = (pl) => opts.filter(o => o.plat === pl.key);
    const typesOn = new Map(pls.map(pl => [pl.key, new Set(knownOn(pl).map(o => o.routeType))]));
    const fits = (pl, o) => pl.rail && (!typesOn.get(pl.key).size || typesOn.get(pl.key).has(o.routeType));
    const nowhere = unknown.filter(o => !pls.some(pl => fits(pl, o)));
    const fallback = (pl, o) => pl.rail && o.routeType !== 'subway' && !typesOn.get(pl.key).has('subway');
    const fromOsm = (pl) => {
      const seen = new Set();
      return opts.filter(o => o.plat && pl.refs.some(r => sameRef(r, o.ref)) &&
        !seen.has(o.ref + '|' + o.prevNames[0]) && seen.add(o.ref + '|' + o.prevNames[0]));
    };

    const out = [];
    for (const pl of pls) {
      const known = knownOn(pl);
      let guessed = unknown.filter(o => fits(pl, o) || (nowhere.includes(o) && fallback(pl, o)));
      if (!known.length && !guessed.length && pl.rail) guessed = fromOsm(pl);
      guessed = guessed.map(o => withPlatform(st, o, pl.key)).filter(Boolean);
      if (!known.length && !guessed.length) continue;

      const lines = {};
      for (const o of known.concat(guessed)) {
        const l = lines[o.ref] || (lines[o.ref] = { key: pl.key + '|' + o.ref, ref: o.ref, routeType: o.routeType,
          guessed: true, directions: [] });
        if (!o.platformChosen) l.guessed = false;
        l.directions.push(o);
      }
      for (const l of Object.values(lines)) l.directions.sort((a, b) => natCmp(a.prevNames[0], b.prevNames[0]));
      const count = {};
      for (const o of known.length ? known : guessed) count[o.routeType] = (count[o.routeType] || 0) + 1;
      const routeType = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
      out.push({ key: pl.key, label: platformLabel(pl, false), routeType, known: known.length,
        lines: Object.values(lines).sort((a, b) => a.guessed - b.guessed ||
          (TYPE_ORDER[a.routeType] ?? 9) - (TYPE_ORDER[b.routeType] ?? 9) || natCmp(a.ref, b.ref)) });
    }
    out.sort((a, b) => (b.known > 0) - (a.known > 0) || (TYPE_ORDER[a.routeType] ?? 9) - (TYPE_ORDER[b.routeType] ?? 9) ||
      natCmp(a.label, b.label));
    // Same track number on several platforms (S-Bahn "Gleis 1" and U-Bahn "Gleis 1"): add the lines,
    // still the same label (e.g. two "U2 U4" platforms): number them
    const dup = {};
    for (const a of out) dup[a.label] = (dup[a.label] || 0) + 1;
    for (const a of out) if (dup[a.label] > 1) a.label = platformLabel(st.platforms[a.key], true);
    const n = {}, seen = {};
    for (const a of out) n[a.label] = (n[a.label] || 0) + 1;
    for (const a of out) if (n[a.label] > 1) a.label += ` (${seen[a.label] = (seen[a.label] || 0) + 1})`;
    return out;
  }

  // Option with a platform chosen by the user (for lines whose platform is unknown)
  function withPlatform(st, opt, platKey) {
    const pl = st.platforms[platKey];
    if (!pl) return null;
    const dir = directionOn(pl, { x: pl.ax.mx, y: pl.ax.my }, opt.prev) || { sign: 1, ambiguous: true };
    return Object.assign({}, opt, { plat: platKey, frontSign: dir.sign, ambiguous: dir.ambiguous, platformChosen: true });
  }

  // ---------- Recommendation ----------

  function zoneOf(p) { return p >= 2 / 3 ? 'vorne' : p <= 1 / 3 ? 'hinten' : 'Mitte'; }

  // Group access ways that sit close together along the platform (a staircase split into
  // several OSM ways, stairs next to escalators and elevators) into one spot
  function groupSpots(cands) {
    const spots = [];
    for (const c of [...cands].sort((a, b) => a.t - b.t)) {
      const last = spots[spots.length - 1];
      if (last && Math.abs(c.t - last.tLast) <= SPOT_GAP) { last.members.push(c); last.tLast = c.t; }
      else spots.push({ members: [c], tLast: c.t });
    }
    for (const sp of spots) {
      sp.members.sort((a, b) => a.dist - b.dist);
      const best = sp.members[0];
      Object.assign(sp, { key: best.key, best, zone: best.zone, p: best.p, dTarget: best.dTarget, dist: best.dist,
        section: best.section, offTrain: best.offTrain, exitT: best.exitT,
        fromFront: best.fromFront, kinds: [...new Set(sp.members.map(m => m.kind))] });
      delete sp.tLast;
    }
    return spots.sort((a, b) => a.dist - b.dist);
  }

  // ---------- Sections and train length ----------

  // Section letter at a position along the platform: the nearest section marker
  function sectionAt(pl, t) {
    let best = null, bd = SECTION_REACH;
    for (const s of pl.sections || []) if (Math.abs(s.t - t) < bd) { bd = Math.abs(s.t - t); best = s.ref; }
    return best;
  }

  // Train lengths one can choose for this platform and direction, from the stop signs there:
  // [{ key, label, front (position of the train's front on the axis), length (m), estimated }]
  function trainChoices(st, opt) {
    const pl = opt && opt.plat && st.platforms[opt.plat];
    if (!pl || !pl.signs) return [];
    const platLen = pl.ax.tmax - pl.ax.tmin, platFront = opt.frontSign > 0 ? pl.ax.tmax : pl.ax.tmin;
    const byLabel = {};
    for (const s of pl.signs.filter(s => s.dir === opt.frontSign)) {
      const c = s.caption.replace(/\s+/g, ' ').trim();
      let key, label, length = null, estimated = false; // key stays the same in every language
      const behind = Math.abs(s.t - (opt.frontSign > 0 ? pl.ax.tmin : pl.ax.tmax)); // platform behind the sign
      const m = /^(\d+)\s*m$/i.exec(c);
      if (m) { key = label = m[1] + ' m'; length = Number(m[1]); }
      else if (/kurz/i.test(c)) { key = 'Kurzzug'; label = TEXT.shortTrain; length = Math.min(platLen * SHORT_TRAIN_SHARE, behind); estimated = true; }
      else if (/voll|lang/i.test(c)) { key = 'Vollzug'; label = TEXT.fullTrain; length = behind; }
      else continue; // no caption or car numbers: length unknown
      // The train must fit on the platform behind its sign; otherwise the sign is probably for the other
      // direction or placed inaccurately in OSM
      if (length > behind + SIGN_FIT_TOL) continue;
      // Several signs with the same label (both edges, duplicates): the one furthest ahead
      const prev = byLabel[key];
      if (!prev || (s.t - prev.front) * opt.frontSign > 0) byLabel[key] = { key, label, front: s.t, length, estimated };
    }
    // Nothing to choose if every train would cover the whole platform anyway
    const out = Object.values(byLabel).filter(c => c.length < platLen - 10 || Math.abs(c.front - platFront) > 10);
    return out.sort((a, b) => b.length - a.length);
  }

  // ---------- Live train (server.py: route geometry; coach sequences came from bahn.de) ----------

  // Direction object for a live train: direction of travel from a point on its route shortly before
  // the station (or the previous stop)
  function liveDirection(st, platKey, from, prevName) {
    const pl = st.platforms[platKey];
    if (!pl || !from) return null;
    const [x, y] = projector(st.center.lat, st.center.lon).xy(from.lat, from.lon);
    const dir = directionOn(pl, { x: pl.ax.mx, y: pl.ax.my }, { x, y });
    if (!dir) return null;
    return { key: 'live', plat: platKey, frontSign: dir.sign, ambiguous: dir.ambiguous, prevNames: [prevName || ''],
      tos: [], live: true };
  }

  // Coach sequence (positions in metres along the DB platform) -> positions on the OSM platform axis.
  // 1. With OSM section markers: fit the DB sectors onto them (needs two matching letters).
  // 2. Otherwise: the first coach in the DB list is the front of the train (checked on 12 trains at
  //    three stations), so the list order tells which way the train runs along the DB metres; with the
  //    direction of travel on the OSM axis (frontSign) that fixes where the DB's 0 m is. The DB platform
  //    is then stretched onto the OSM platform.
  function mapSequence(st, platKey, seq, frontSign) {
    const pl = st.platforms[platKey];
    if (!pl || !seq || !seq.vehicles || !seq.vehicles.length) return null;
    const fit = fitSections(pl, seq) || fitByOrder(pl, seq, frontSign);
    if (!fit) return null;
    const { toT, toM, method } = fit;
    const starts = seq.vehicles.map(v => toT(v.start)), ends = seq.vehicles.map(v => toT(v.end));
    const lo = Math.min(...starts, ...ends), hi = Math.max(...starts, ...ends);
    return { lo, hi, toT, toM, method, check: checkWithSigns(pl, lo, hi, frontSign),
      // Coach at a position on the axis (nearest one if between coaches)
      vehicleAt: (t) => {
        const m = toM(t);
        return seq.vehicles.reduce((best, v) => {
          const d = m < v.start ? v.start - m : m > v.end ? m - v.end : 0;
          return !best || d < best.d ? { d, v } : best;
        }, null).v;
      } };
  }

  // Plausibility: a train stops with its front near a stop sign for its direction. Compare the placed
  // train with its mirror image on the platform:
  // 'confirmed' only the train fits, 'conflict' only the mirror image fits, 'unchecked' otherwise
  function checkWithSigns(pl, lo, hi, frontSign) {
    const signs = (pl.signs || []).filter(x => x.dir === frontSign);
    if (!signs.length || !frontSign) return 'unchecked';
    const near = (t) => Math.min(...signs.map(x => Math.abs(x.t - t)));
    const front = frontSign > 0 ? hi : lo;
    const mirrorFront = pl.ax.tmin + pl.ax.tmax - (frontSign > 0 ? lo : hi);
    // Only a clear contrast counts (placing by coach order alone can be off by some 30 m); where both the
    // train and its mirror image stand at a sign (many signs), nothing is proven
    const d = near(front), dm = near(mirrorFront);
    if (d <= SIGN_CHECK_DIST && dm > SIGN_CONFLICT_FAR) return 'confirmed';
    if (d > SIGN_CONFLICT_FAR && dm <= SIGN_CONFLICT_NEAR) return 'conflict';
    return 'unchecked';
  }

  function fitSections(pl, seq) {
    if (!pl.sections || !seq.sectors) return null;
    const pairs = [];
    for (const sec of seq.sectors) {
      const ts = pl.sections.filter(m => m.ref === sec.name).map(m => m.t);
      if (ts.length) pairs.push([(sec.start + sec.end) / 2, ts.reduce((a, b) => a + b) / ts.length]);
    }
    if (new Set(pairs.map(p => p[0])).size < 2) return null;
    // t = a + b·m with b = ±1 (both in metres); b from the order of the sectors
    const mm = pairs.reduce((a, p) => a + p[0], 0) / pairs.length, mt = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
    const b = pairs.reduce((a, p) => a + (p[0] - mm) * (p[1] - mt), 0) >= 0 ? 1 : -1;
    const a = mt - b * mm;
    const misfit = pairs.reduce((s, p) => s + Math.abs(a + b * p[0] - p[1]), 0) / pairs.length;
    if (misfit > SEQUENCE_MISFIT) return null;
    return { toT: (m) => a + b * m, toM: (t) => (t - a) / b, method: 'sections' };
  }

  function fitByOrder(pl, seq, frontSign) {
    const first = seq.vehicles[0], last = seq.vehicles[seq.vehicles.length - 1];
    if (!frontSign || first === last || seq.end == null || seq.start == null || seq.end <= seq.start) return null;
    const up = first.start > last.start;             // train runs towards higher DB metres
    const b = up ? frontSign : -frontSign;            // DB metres increase along +axis (1) or -axis (-1)
    const k = (pl.ax.tmax - pl.ax.tmin) / (seq.end - seq.start);
    const t0 = b > 0 ? pl.ax.tmin : pl.ax.tmax;
    return { toT: (m) => t0 + b * k * (m - seq.start), toM: (t) => seq.start + (t - t0) / (b * k), method: 'order' };
  }

  // ---------- Walking routes ----------

  const WALK_FACTOR = { walk: 1, steps: 1.5, escalator: 1, elevator: 0 }; // per metre
  const WALK_EXTRA = { walk: 0, steps: 10, escalator: 5, elevator: 40 };  // m equivalent per way (changing level)
  const ELEVATOR_NODE_EXTRA = 20;  // m, entering or leaving an elevator node
  const SNAP_PLATFORM = 5;         // m: loose ends this close to a platform are connected to it
  const SNAP_NODE = 2;             // m: loose ends this close to another way are connected to it
  const TAIL_WARN = 40;            // m: a straight last part this long to a point on the map gets a warning
  const SEED_SPREAD = 30;          // m: a point off the network is reached from surface ways up to this much farther than the nearest …
  const SEED_SPREAD_MIN = 5;       // … but when the nearest is right at the point, only a little farther: the straight line knows no
                                   // tracks or walls (Eberswalde: from platform 2/3 straight across the tracks to a locker at the building)
  const seedSpread = (nearest) => Math.min(SEED_SPREAD, Math.max(SEED_SPREAD_MIN, nearest));
  const RAIL_CANDIDATES = 300;     // surface nodes looked at for a straight line that crosses no track
  // Does the segment a–b (coordinates) cross the segment c–d ([x, y] pairs)?
  function segmentsCross(ax, ay, bx, by, c, d) {
    const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
    return o(ax, ay, bx, by, c[0], c[1]) * o(ax, ay, bx, by, d[0], d[1]) < 0 &&
      o(c[0], c[1], d[0], d[1], ax, ay) * o(c[0], c[1], d[0], d[1], bx, by) < 0;
  }
  const WALK_PLAUSIBLE = 3, WALK_PLAUSIBLE_ABS = 200; // walk > 3 × straight line + 200 m: network incomplete

  // Same key for a position whether it was stored rounded (st.walk) or not (platforms, access points)
  const r2 = (v) => Math.round(v * 100) / 100;
  const posKey = (x, y) => r2(x).toFixed(1) + ',' + r2(y).toFixed(1);

  const graphCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  // Footway network: nodes are identified by their position (shared OSM nodes have identical coordinates).
  // Platforms are walkable along their axis; loose ends of ways are snapped to platforms and nearby ways.
  function walkGraph(st) {
    if (graphCache && graphCache.has(st)) return graphCache.get(st);
    const ids = new Map(), xs = [], ys = [], adj = [], kindAt = [], surface = [], levels = [];
    const node = (x, y) => {
      const k = posKey(x, y);
      let i = ids.get(k);
      if (i === undefined) { i = xs.length; ids.set(k, i); xs.push(x); ys.push(y); adj.push([]); }
      return i;
    };
    const edge = (a, b, cost, kind) => {
      if (a === b) return;
      adj[a].push([b, cost, kind]);
      adj[b].push([a, cost, kind]);
    };
    const len = (a, b) => Math.hypot(xs[a] - xs[b], ys[a] - ys[b]);

    // Ways
    const ends = [];
    for (const w of st.walk || []) {
      const n = w.p.map(([x, y]) => node(x, y));
      // Levels of the ways meeting at a node (only where tagged)
      if (w.l) for (const i of n) levels[i] = (levels[i] || []).concat(w.l);
      if (n.length === 1) { kindAt[n[0]] = w.k; ends.push(n[0]); continue; } // elevator node
      let first = true;
      for (let i = 1; i < n.length; i++) {
        const d = len(n[i - 1], n[i]);
        edge(n[i - 1], n[i], d * WALK_FACTOR[w.k] + (first ? WALK_EXTRA[w.k] : 0), w.k);
        first = false;
      }
      ends.push(n[0], n[n.length - 1]);
      if (w.k === 'walk' && !w.u) for (const i of n) surface[i] = true;
    }
    const wayNodes = xs.length;

    // Loose ends: snap to nearby nodes of other ways (grid of 5 m cells)
    const grid = new Map(), cell = (v) => Math.floor(v / 5);
    for (let i = 0; i < wayNodes; i++) {
      const k = cell(xs[i]) + ':' + cell(ys[i]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
    const loose = [...new Set(ends)].filter(i => adj[i].length <= 1);
    for (const i of loose) {
      let best = -1, bd = SNAP_NODE;
      for (let gx = cell(xs[i]) - 1; gx <= cell(xs[i]) + 1; gx++) for (let gy = cell(ys[i]) - 1; gy <= cell(ys[i]) + 1; gy++) {
        for (const j of grid.get(gx + ':' + gy) || []) {
          // Not across levels: a footway on the street can end right above a platform three floors down
          if (j === i || adj[i].some(e => e[0] === j) || !sameLevel(levels[i], levels[j])) continue;
          const d = len(i, j);
          if (d < bd) { bd = d; best = j; }
        }
      }
      if (best >= 0) edge(i, best, bd, 'walk');
    }

    // Platforms: outline and all touching or snapped points, chained along the platform axis
    const platformNodes = {};
    for (const pl of Object.values(st.platforms)) {
      const pts = [];
      for (const line of pl.lines) {
        const n = line.map(p => node(p.x, p.y));
        for (let i = 1; i < n.length; i++) edge(n[i - 1], n[i], len(n[i - 1], n[i]), 'platform');
        pts.push(...n);
      }
      const plLevels = parseLevels(pl.tags.level);
      for (const i of loose) {
        const p = { x: xs[i], y: ys[i] };
        if (!sameLevel(levels[i], plLevels) || distToLines(p, pl.lines) > SNAP_PLATFORM) continue;
        // Point on the platform axis next to the loose end
        const t = proj(pl.ax, p), x = pl.ax.mx + pl.ax.u[0] * t, y = pl.ax.my + pl.ax.u[1] * t;
        const j = node(x, y);
        edge(i, j, len(i, j), 'platform');
        pts.push(j);
      }
      const chain = [...new Set(pts)].sort((a, b) => proj(pl.ax, { x: xs[a], y: ys[a] }) - proj(pl.ax, { x: xs[b], y: ys[b] }));
      for (let i = 1; i < chain.length; i++) edge(chain[i - 1], chain[i], len(chain[i - 1], chain[i]), 'platform');
      platformNodes[pl.key] = chain;
    }

    const g = { ids, xs, ys, adj, kindAt, surface, levels, platformNodes,
      at: (p) => ids.get(posKey(p.x, p.y)) };
    if (graphCache) graphCache.set(st, g);
    return g;
  }

  // Shortest walks from every node to the target (Dijkstra from the target's nodes): a platform, or the
  // points of an exit or a destination on the map. A point that is no node of the network is reached
  // from the surface ways next to it (the nearest one and those up to SEED_SPREAD farther), straight
  // across the last metres. Returns null if there is no footway data at all.
  function walkRoutes(st, target, liftOnly) {
    if (typeof target === 'string') target = st.platforms[target];
    if (!st.walk || !st.walk.length || !target) return null;
    const g = walkGraph(st);
    const n = g.xs.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const heap = [];
    const push = (i, d) => {
      heap.push([d, i]);
      for (let c = heap.length - 1; c > 0;) {
        const p = (c - 1) >> 1;
        if (heap[p][0] <= heap[c][0]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]]; c = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let c = 0; ;) {
          const l = 2 * c + 1, r = l + 1;
          let m = c;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]]; c = m;
        }
      }
      return top;
    };
    const tail = new Map(); // seed node -> the point it stands for
    const seed = (i, d, p) => { if (d < dist[i]) { dist[i] = d; push(i, d); if (d > 0) tail.set(i, [p.x, p.y]); else tail.delete(i); } };
    if (!target.points) for (const i of g.platformNodes[target.key] || []) seed(i, 0);
    for (const p of target.points || []) {
      const exact = g.at(p);
      if (exact !== undefined && g.adj[exact].length) { seed(exact, 0); continue; }
      const near = [];
      g.surface.forEach((on, i) => near.push([i, Math.hypot(g.xs[i] - p.x, g.ys[i] - p.y)]));
      if (!near.length) continue;
      near.sort((a, b) => a[1] - b[1]);
      // A straight line across tracks is no way: with tracks known (ways loaded around the station), only the
      // surface ways that reach the point without crossing one – if there are any
      const rails = st.rails || [];
      const crosses = (i) => rails.some(r => r.some((q, k) => k > 0 && segmentsCross(g.xs[i], g.ys[i], p.x, p.y, r[k - 1], q)));
      const free = rails.length ? near.slice(0, RAIL_CANDIDATES).filter(([i]) => !crosses(i)) : near;
      const pool = free.length ? free : near;
      const nearest = pool[0][1], spread = seedSpread(nearest);
      for (const [i, d] of pool) { if (d > nearest + spread) break; seed(i, d, p); }
    }
    while (heap.length) {
      const [d, i] = pop();
      if (d > dist[i]) continue;
      for (const [j, cost, kind] of g.adj[i]) {
        if (liftOnly && (kind === 'steps' || kind === 'escalator')) continue;
        const extra = (g.kindAt[i] === 'elevator' ? ELEVATOR_NODE_EXTRA : 0) + (g.kindAt[j] === 'elevator' ? ELEVATOR_NODE_EXTRA : 0);
        const nd = d + cost + extra;
        if (nd < dist[j]) { dist[j] = nd; prev[j] = i; push(j, nd); }
      }
    }
    return {
      distAt: (p) => { const i = g.at(p); return i === undefined ? Infinity : dist[i]; },
      // Route from a point to the target platform, as [x, y] pairs; out.tail: length of the straight last
      // part to a point off the network (the app knows no ways there: it may cross tracks or buildings)
      pathFrom: (p) => {
        let i = g.at(p);
        if (i === undefined || !isFinite(dist[i])) return null;
        const out = [];
        let last = i;
        for (let guard = 0; i >= 0 && guard < n; guard++, i = prev[i]) { out.push([g.xs[i], g.ys[i]]); last = i; }
        out.tail = 0;
        if (tail.has(last)) {
          const q = tail.get(last);
          out.tail = Math.hypot(q[0] - g.xs[last], q[1] - g.ys[last]);
          out.push(q);
        }
        return out;
      }
    };
  }

  function recommend(st, optionKey, targetKey, opts) {
    opts = opts || {};
    // optionKey: key of st.options, or a direction object from arrivals()
    let opt = typeof optionKey === 'object' ? optionKey : (st.options || []).find(o => o.key === optionKey);
    if (!opt) return { error: 'Linie nicht gefunden.', code: 'noLine' };
    if (!opt.plat) {
      opt = opts.platform ? withPlatform(st, opt, opts.platform) : null;
      if (!opt) return { error: 'Bitte wähle, an welchem Bahnsteig du ankommst.', code: 'needPlatform', needPlatform: true };
    }
    const pl = st.platforms[opt.plat];
    const target = targetOf(st, targetKey);
    if (!target) return { error: 'Ziel nicht gefunden.', code: 'noTarget' };
    if (target.points && !target.points.length) return { error: 'Bitte tippe in der Karte auf dein Ziel.', code: 'needPoint', opt, pl };
    if (target.key === pl.key) return { error: 'Das Ziel fährt vom selben Bahnsteig ab – einfach am Bahnsteig bleiben.', code: 'samePlatform', same: true, opt, pl };

    // Train: whole platform, or placed at its stop sign with the chosen length (trainChoices())
    // or (live train) the range given by the coach sequence (opts.trainRange: { lo, hi } on the axis)
    const range = opts.trainRange || null;
    const train = range ? { live: true } : opts.train && (trainChoices(st, opt).find(c => c.key === opts.train) || null);
    const pFront = opt.frontSign > 0 ? pl.ax.tmax : pl.ax.tmin, pRear = opt.frontSign > 0 ? pl.ax.tmin : pl.ax.tmax;
    const tFront = range ? (opt.frontSign > 0 ? range.hi : range.lo) : train ? train.front : pFront;
    const tRear = range ? (opt.frontSign > 0 ? range.lo : range.hi)
      : train ? (opt.frontSign > 0 ? Math.max(pRear, tFront - train.length) : Math.min(pRear, tFront + train.length)) : pRear;
    const lo = Math.min(tFront, tRear), hi = Math.max(tFront, tRear);
    let cands = st.access.filter(a => a.platform === pl.key).map(a => {
      const exit = Math.max(lo, Math.min(hi, a.t));   // nearest point of the train
      const p = (exit - tRear) / (tFront - tRear);
      let dTarget = Infinity;
      for (const v of a.pts) dTarget = Math.min(dTarget, distToTarget(v, target));
      return Object.assign({}, a, { p, zone: zoneOf(p), dTarget, fromFront: Math.abs(tFront - exit),
        offTrain: Math.abs(a.t - exit), exitT: exit, section: sectionAt(pl, exit) });
    });
    // Step-free: lifts and level access
    if (opts.liftOnly) cands = cands.filter(c => c.kind === 'elevator' || c.kind === 'level');
    const none = () => ({ error: opts.liftOnly
      ? 'Für diesen Bahnsteig ist in OpenStreetMap kein stufenloser Zugang (Aufzug oder ebenerdig) erfasst.'
      : 'Für diesen Bahnsteig sind in OpenStreetMap keine Zugänge (Treppen, Aufzüge, Wege) erfasst.',
      code: opts.liftOnly ? 'noLift' : 'noAccess', opt, pl, target });
    if (!cands.length) return none();
    // Walking distance from each access point (where it meets the platform) to the target.
    // Falls back to straight-line distance if the footway network has no plausible route.
    const net = walkRoutes(st, target, !!opts.liftOnly);
    for (const c of cands) c.dWalk = net ? net.distAt(c.anchor) : Infinity;
    // A level access only counts as step-free if the way on from there needs no stairs either
    if (opts.liftOnly && net) {
      cands = cands.filter(c => c.kind !== 'level' || isFinite(c.dWalk));
      if (!cands.length) return none();
    }
    const bestAir = Math.min(...cands.map(c => c.dTarget)), bestWalk = Math.min(...cands.map(c => c.dWalk));
    const method = isFinite(bestWalk) && bestWalk <= WALK_PLAUSIBLE * bestAir + WALK_PLAUSIBLE_ABS ? 'walk' : 'air';
    // Walking along the platform from the train to an access point outside the train counts too
    for (const c of cands) c.dist = (method === 'walk' ? c.dWalk : c.dTarget) + c.offTrain;

    cands.sort((a, b) => a.dist - b.dist);
    const spots = groupSpots(cands);
    const chosen = (opts.override && cands.find(c => c.key === opts.override)) || cands[0];
    const overridden = chosen !== cands[0];
    const chosenSpot = spots.find(sp => sp.members.includes(chosen));

    // Other spots that are about as close to the target, one per zone
    const equal = [];
    if (!overridden) {
      const limit = spots[0].dist + TIE_ABS;
      for (const sp of spots) {
        if (sp === chosenSpot || sp.dist > limit) continue;
        if (sp.zone === chosenSpot.zone || equal.some(e => e.zone === sp.zone)) continue;
        equal.push(sp);
      }
    }
    const route = method === 'walk' && net ? net.pathFrom(chosen.anchor) : null;
    // Straight last part of the walk to a point off the footway network (m); from TAIL_WARN on the app says so
    const tail = route ? Math.round(route.tail) : 0;
    return { opt, pl, target, cands, spots, chosen, chosenSpot, equal, tFront, tRear, overridden, method, route, tail, train,
      length: Math.abs(tFront - tRear), estimated: !!(pl.estimated || target.estimated) };
  }

  // ---------- Journeys (compact format of server.py /api/journeys) ----------

  // Product of the journey planner -> route type of the station model; bus, tram, ferry have no platform model
  const PRODUCT_TYPE = { ICE: 'train', EC_IC: 'train', IR: 'train', REGIONAL: 'train', SBAHN: 'light_rail', UBAHN: 'subway' };
  const STATION_MATCH_MAX = 400;    // m: stop of the journey planner -> station of data/index.json
  const STATION_MATCH_NAMELESS = 150; // m: … without a word of the name in common
  const SAME_STATION_WALK = 300;    // m: a walk this short between two legs is a change within the station

  const routeTypeOf = (product) => PRODUCT_TYPE[product] || null;
  // "1 (U8)" -> "1", "9 D-G" (track with sections) -> "9", " 16 " -> "16", "Fern 6" (Frankfurt Flughafen) -> "6"
  const trackOf = (s) => (s || '').trim().split(/\s+/).find(w => /\d/.test(w)) || '';
  // "Schillingstr." (timetable, city removed) is the stop "Schillingstr.(U), Berlin" (journey planner)
  const sameStop = (short, long) => { const a = tokens(short), b = new Set(tokens(long)); return a.length > 0 && a.every(w => b.has(w)); };

  // Station of data/index.json for a stop of a journey: nearest one that shares a word of the name,
  // or a very close one. rows: index.json "stations". Returns { id, name, d } or null.
  function matchStation(rows, lat, lon, name) {
    if (lat == null || lon == null) return null;
    const words = new Set(tokens(name));
    const near = nearestStations(rows, lat, lon, 6).filter(n => n.d <= STATION_MATCH_MAX);
    const named = near.find(n => tokens(n.row[1]).concat(tokens(n.row[6] || '')).some(w => words.has(w)));
    const hit = named || near.find(n => n.d <= STATION_MATCH_NAMELESS);
    return hit ? { id: hit.row[0], name: hit.row[1], d: Math.round(hit.d) } : null;
  }

  // Places in a journey where the station model can help: arriving by rail and changing to another
  // train (kind 'change', target = platform of the next leg) or leaving the station (kind 'leave',
  // target = where the walk afterwards ends, or the stop of a bus or tram).
  // [{ kind, arrive, depart, point, legIndex }]
  function journeyStops(journey) {
    const legs = (journey && journey.legs) || [];
    const out = [];
    for (let i = 0; i < legs.length; i++) {
      const arrive = legs[i];
      if (arrive.mode !== 'transit' || !routeTypeOf(arrive.product)) continue;
      let j = i + 1, walked = 0, walk = null;
      while (j < legs.length && legs[j].mode === 'walk') { walk = walk || legs[j]; walked += legs[j].distance || 0; j++; }
      const depart = legs[j] || null;
      if (depart && routeTypeOf(depart.product) && walked <= SAME_STATION_WALK) {
        out.push({ kind: 'change', arrive, depart, point: null, legIndex: i });
        continue;
      }
      // Leaving: to the stop of a bus/tram nearby, else to the end of the walk (destination or next stop)
      const end = depart && walked <= SAME_STATION_WALK ? depart.from : walk ? walk.to : null;
      const point = end && end.lat != null ? { lat: end.lat, lon: end.lon } : null;
      out.push({ kind: 'leave', arrive, depart, point, legIndex: i });
    }
    return out;
  }

  // Direction of travel on a platform from a point before the platform (from) or after it (towards)
  function directionAt(st, platKey, from, towards) {
    const pl = st.platforms[platKey];
    const p = from || towards;
    if (!pl || !p || p.lat == null) return null;
    const [x, y] = projector(st.center.lat, st.center.lon).xy(p.lat, p.lon);
    const mid = { x: pl.ax.mx, y: pl.ax.my };
    // A point ahead is mirrored behind the platform: same direction of travel
    const behind = from ? { x, y } : { x: 2 * mid.x - x, y: 2 * mid.y - y };
    return directionOn(pl, mid, behind);
  }

  // OSM platform for one leg at this station: by track number (only platforms of the right kind),
  // U-Bahn also by line; several or none left: the platform where this line comes from the same previous
  // stop, then the one where it runs in the same direction.
  // leg: { product, line, track, from?: previous stop { name, lat, lon }, towards?: next stop { lat, lon } }
  function findPlatform(st, leg) {
    const type = routeTypeOf(leg.product);
    if (!type) return null;
    const isU = type === 'subway';
    const typesAt = {};
    for (const o of st.options || []) if (o.plat) (typesAt[o.plat] = typesAt[o.plat] || new Set()).add(o.routeType === 'subway' ? 'subway' : 'rail');
    const fits = (pl) => {
      const m = new Set(typesAt[pl.key] || []);
      if (pl.tags.subway === 'yes') m.add('subway');
      if (pl.tags.train === 'yes' || pl.tags.light_rail === 'yes') m.add('rail');
      return pl.rail && (!m.size || m.has(isU ? 'subway' : 'rail'));
    };
    let cands = Object.values(st.platforms).filter(fits);
    const withLine = leg.line ? cands.filter(pl => pl.refs.some(r => sameRef(r, leg.line))) : [];
    if (isU && withLine.length) cands = withLine;
    const track = trackOf(leg.track);
    const tracks = (pl) => [pl.tags.ref, pl.tags.local_ref, pl.tags['railway:track_ref']].flatMap(splitRefs);
    let byTrack = track ? cands.filter(pl => tracks(pl).includes(track)) : [];
    // A second object with the same track number but nothing else known (Berlin Hbf: track 4 twice in OSM):
    // the platform with lines or a kind of train counts
    const known = byTrack.filter(pl => pl.refs.length || typesAt[pl.key] || ['train', 'light_rail', 'subway'].some(k => pl.tags[k] === 'yes'));
    if (byTrack.length > 1 && known.length) byTrack = known;
    if (byTrack.length === 1) return byTrack[0].key;
    if (byTrack.length > 1) cands = byTrack;
    else if (!isU) cands = withLine.length ? withLine : [];
    if (cands.length === 1) return cands[0].key;
    // Same line from the same previous stop in the timetable (e.g. Alexanderplatz: the U5 platforms of the
    // next station Rotes Rathaus are within the radius too and fit the direction as well)
    const lineAt = (pl) => (st.options || []).filter(o => o.plat === pl.key && sameRef(o.ref, leg.line || ''));
    const byPrev = leg.from && leg.from.name ? cands.filter(pl => lineAt(pl).some(o => o.prevNames.some(n => sameStop(n, leg.from.name)))) : [];
    if (byPrev.length === 1) return byPrev[0].key;
    // Side platforms of a line: the one where the timetable lets this line run in the same direction
    const fit = cands.filter(pl => {
      const d = directionAt(st, pl.key, leg.from, leg.towards);
      return d && lineAt(pl).some(o => o.frontSign === d.sign);
    });
    return fit.length === 1 ? fit[0].key : null;
  }

  // The journey planner gives a bus or tram stop only roughly (often the middle of the whole stop area, Eberswalde Hbf:
  // 80 m beside the stop on the bridge). The OSM platform of that name nearby is where people wait: the walk
  // goes there. "Hauptbahnhof, Eberswalde" (journey planner) = "Eberswalde, Hauptbahnhof (Bahnhofsbrücke)" (OSM).
  // Returns the stop with point { lat, lon } moved there and stopRef (the platform's ref), or the stop as it is.
  const STOP_SNAP_MAX = 150;   // m between the point of the journey planner and the OSM platform
  const SIDE_MIN = 5;          // m: two platforms this far apart across the direction of travel are on opposite sides
  function snapStop(st, stop) {
    const d = stop.depart, p = stop.point;
    if (stop.kind !== 'leave' || !d || routeTypeOf(d.product) || !p || typeof p !== 'object' || stop.stopRef !== undefined) return stop;
    const name = ((d.from && d.from.name) || '').replace(/,[^,]*$/, '');   // without the city after the comma
    if (!tokens(name).length) return stop;
    const tram = d.product === 'TRAM';
    const P = projector(st.center.lat, st.center.lon);
    const [px, py] = P.xy(p.lat, p.lon);
    // Platforms of that name nearby (bus and tram not mixed up), each at its point closest to the journey planner's
    const cands = [];
    for (const pl of Object.values(st.platforms || {})) {
      const t = pl.tags || {};
      if (pl.rail || !t.name || !sameStop(name, t.name)) continue;
      const isTram = t.tram === 'yes' || t.railway === 'tram_stop', isBus = t.bus === 'yes' || t.trolleybus === 'yes' || t.highway === 'bus_stop';
      if (tram ? isBus && !isTram : isTram && !isBus) continue;
      let best = null, bd = STOP_SNAP_MAX;
      for (const q of [].concat(...pl.lines)) { const dd = Math.hypot(q.x - px, q.y - py); if (dd < bd) { bd = dd; best = q; } }
      if (best) cands.push({ pl, q: best, d: bd, ref: t.ref || t.local_ref || '' });
    }
    if (!cands.length) return Object.assign({}, stop, { stopRef: null });
    cands.sort((a, b) => a.d - b.d);
    let pick = cands[0];
    // The bay the journey planner names ("Bussteig F", "F")
    const bay = ((d.from && (d.from.rtTrack || d.from.track)) || '').replace(/^(bussteig|steig|pos\.?|position)\s*/i, '').trim().toUpperCase();
    const byBay = bay && cands.find(c => [c.pl.tags.local_ref, c.pl.tags.ref].some(r => r && r.replace(/^(bussteig|steig)\s*/i, '').trim().toUpperCase() === bay));
    if (byBay) pick = byBay;
    else if (cands.length === 2 && d.next && d.next.lat != null) {
      // A stop on each side of the street: the bus stops on the right in its direction of travel (towards the next stop)
      const [nx, ny] = P.xy(d.next.lat, d.next.lon);
      const len = Math.hypot(nx - px, ny - py) || 1, ux = (nx - px) / len, uy = (ny - py) / len;
      const mx = (cands[0].q.x + cands[1].q.x) / 2, my = (cands[0].q.y + cands[1].q.y) / 2;
      const side = (c) => ux * (c.q.y - my) - uy * (c.q.x - mx);   // > 0: left of the direction of travel
      if (Math.abs(side(cands[0]) - side(cands[1])) >= SIDE_MIN) pick = side(cands[0]) < side(cands[1]) ? cands[0] : cands[1];
    }
    return Object.assign({}, stop, { point: { lat: pick.q.lat, lon: pick.q.lon }, stopRef: pick.ref });
  }

  // Recommendation for one stop of journeyStops() in its station model: { plat, target, rec } or
  // { code } when the platform ('noPlatform'), the direction ('noDirection') or the platform of the
  // next train ('noTarget') cannot be told for sure – then better no recommendation than a wrong one.
  function transferAdvice(st, stop, opts) {
    stop = snapStop(st, stop);
    const a = stop.arrive;
    const plat = findPlatform(st, { product: a.product, line: a.line, track: a.to.rtTrack || a.to.track, from: a.prev });
    if (!plat) return { code: 'noPlatform' };
    const dir = liveDirection(st, plat, a.prev, a.prev && cleanName(a.prev.name));
    if (!dir) return { code: 'noDirection', plat };
    let target;
    if (stop.kind === 'change') {
      const d = stop.depart;
      target = findPlatform(st, { product: d.product, line: d.line, track: d.from.rtTrack || d.from.track, towards: d.next });
      if (!target) return { code: 'noTarget', plat };
    } else {
      if (!stop.point) return { code: 'noTarget', plat };
      target = stop.point;  // { lat, lon } or a target key of the station (an exit)
    }
    const rec = recommend(st, dir, target, opts || {});
    return { plat, target, rec, ambiguous: !!dir.ambiguous };
  }

  // Enough time to change? Time between arrival and the next departure (real time where known) against the
  // walk: from recommend() when it found a walk, else the walks of the journey planner between the two legs, plus a
  // minute to get off. level: 'ok', 'tight' (less than TIGHT_MINUTES to spare), 'risk' (walk longer than
  // the time left) or 'cancelled' (one of the two trains). null without a following departure or times.
  const WALK_SPEED = 75;     // m per minute (4.5 km/h; stairs are already longer in the walk graph)
  const GET_OFF = 1;         // minutes
  const TIGHT_MINUTES = 2;
  function connectionTime(stop, rec, legs) {
    const a = stop.arrive, d = stop.depart;
    if (!d || !a) return null;
    if (a.cancelled || d.cancelled || a.to.cancelled || d.from.cancelled) return { level: 'cancelled' };
    const arr = a.to.rtTime || a.to.time, dep = d.from.rtTime || d.from.time;
    if (!arr || !dep) return null;
    const minutes = Math.round((new Date(dep) - new Date(arr)) / 60000);
    let walk = rec && !rec.error && rec.method === 'walk' && isFinite(rec.chosen.dist) ? rec.chosen.dist : null;
    if (walk === null && legs) {
      const i = legs.indexOf(a), j = legs.indexOf(d);
      if (i >= 0 && j > i) walk = legs.slice(i + 1, j).reduce((sum, l) => sum + (l.distance || 0), 0);
    }
    const need = Math.ceil(GET_OFF + (walk || 0) / WALK_SPEED);
    const spare = minutes - need;
    return { minutes, need, walk, level: spare < 0 ? 'risk' : spare < TIGHT_MINUTES ? 'tight' : 'ok' };
  }

  // The same change as a selection of the station view (app.js, stored per station): platform, line and
  // the direction entry that runs the same way – so "view station" opens with this change chosen.
  function viewSelection(st, stop, adv) {
    if (!adv || !adv.plat) return null;
    const a = arrivals(st).find(x => x.key === adv.plat);
    const line = a && (a.lines.find(l => sameRef(l.ref, stop.arrive.line)) || a.lines[0]);
    const sign = adv.rec && adv.rec.opt ? adv.rec.opt.frontSign : null;
    const prev = stop.arrive.prev && stop.arrive.prev.name;
    const dirs = line ? line.directions.filter(d => d.frontSign === sign) : [];
    const dir = dirs.find(d => prev && d.prevNames.some(n => sameStop(n, prev))) || dirs[0];
    const to = typeof adv.target === 'string' ? adv.target : adv.target ? POINT_KEY : '';
    return { arr: adv.plat, line: line ? line.ref : '', from: dir ? dir.key : '', to };
  }

  // ---------- Station search (data/index.json) ----------

  // Lower case, no accents, common abbreviations unified: "Hauptbahnhof" = "Hbf", "Straße" = "Str."
  function normalizeName(n) {
    return (n || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
      .replace(/hauptbahnhof/g, 'hbf').replace(/bahnhof/g, 'bhf').replace(/strasse\b/g, 'str');
  }
  const tokens = (n) => normalizeName(n).split(/[^a-z0-9]+/).filter(t => t && !['s', 'u'].includes(t));

  // "S+U Alexanderplatz Bhf (Berlin)" -> "Alexanderplatz (Berlin)", "Hamburg, Hamburg Hbf" -> "Hamburg Hbf"
  const displayName = (n) => (n || '').replace(/^(S\+U|S|U)\s+/, '').replace(/\s+Bhf\b/, '')
    .replace(/^([^,]+),\s*\1\b/, '$1');

  // Words of every station, computed once per index
  const tokenCache = new WeakMap();
  function indexTokens(rows) {
    let t = tokenCache.get(rows);
    if (!t) {
      t = rows.map(row => {
        const name = tokens(row[1]);
        return { name, all: row[6] ? name.concat(tokens(row[6])) : name };
      });
      tokenCache.set(rows, t);
    }
    return t;
  }

  // rows: index.json "stations" ([id, name, lat, lon, types, lines, aliases]).
  // Every word of the query must start a word of the name or an alias.
  function searchStations(rows, query, limit) {
    const q = tokens(query);
    if (!q.length) return [];
    const hits = [], tok = indexTokens(rows);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], nameTok = tok[i].name, all = tok[i].all;
      let score = 0, ok = true;
      for (const t of q) {
        if (all.includes(t)) score += 2;
        else if (all.some(w => w.startsWith(t))) score += 1;
        else { ok = false; break; }
      }
      if (!ok) continue;
      if (nameTok[0] && nameTok[0].startsWith(q[0])) score += 2;
      hits.push({ row, score: score + Math.min(row[5], 20) / 10 });
    }
    hits.sort((a, b) => b.score - a.score || a.row[1].length - b.row[1].length);
    return hits.slice(0, limit || 20).map(h => h.row);
  }

  function nearestStations(rows, lat, lon, limit) {
    const P = projector(lat, lon);
    return rows.map(row => { const [x, y] = P.xy(row[2], row[3]); return { row, d: Math.hypot(x, y) }; })
      .sort((a, b) => a.d - b.d).slice(0, limit || 8);
  }

  // ---------- More ways around the station (loaded on demand from Overpass) ----------

  // The station data knows footways within its radius only. For a destination farther out or off those
  // footways the app loads streets and paths (and tracks as obstacles) in a box around station and point.
  const AREA_HIGHWAYS = 'footway|path|pedestrian|steps|corridor|living_street|residential|service|unclassified|road|' +
    'tertiary|tertiary_link|secondary|secondary_link|primary|primary_link|track|cycleway';
  const AREA_MARGIN = 150;   // m around the stretch from the edge of the station data to the point (room for detours)
  const AREA_MAX = 2500;     // m: farther points keep the straight line (too much to load)
  const AREA_GRID = 100;     // m: the box is rounded to this grid, so nearby points share one stored area

  // Box to load for a point: { x0, y0, x1, y1 (m from the station centre), key, bbox [s, w, n, e], outside }.
  // It covers the stretch from where the station data ends (its radius, towards the point) to the point –
  // the ways inside the radius are known already. outside: the point lies beyond the station radius.
  // null when the point is too far away.
  function areaFor(st, point) {
    const P = projector(st.center.lat, st.center.lon);
    const [x, y] = P.xy(point.lat, point.lon);
    const d = Math.hypot(x, y);
    if (d > AREA_MAX) return null;
    const r = st.center.r || 0;
    const k = d > r ? r / d : 1;   // edge of the station data towards the point (the point itself when inside)
    const ex = x * k, ey = y * k;
    const down = (v) => Math.floor(v / AREA_GRID) * AREA_GRID, up = (v) => Math.ceil(v / AREA_GRID) * AREA_GRID;
    const a = { x0: down(Math.min(ex, x) - AREA_MARGIN), y0: down(Math.min(ey, y) - AREA_MARGIN),
      x1: up(Math.max(ex, x) + AREA_MARGIN), y1: up(Math.max(ey, y) + AREA_MARGIN) };
    const [s, w] = P.ll(a.x0, a.y0), [n, e] = P.ll(a.x1, a.y1);
    return Object.assign(a, { key: [a.x0, a.y0, a.x1, a.y1].join(','), bbox: [s, w, n, e], outside: d > r });
  }

  function areaQuery(area) {
    const b = area.bbox.map(v => v.toFixed(6)).join(',');
    return `[out:json][timeout:25];
(
  way["highway"~"^(${AREA_HIGHWAYS})$"](${b});
  way["railway"~"^(rail|light_rail|narrow_gauge)$"](${b});
);
out geom;`;
  }

  // Ways of an area answer (Overpass format) like st.walk, and the tracks that cannot be crossed (not on a
  // bridge, not in a tunnel) as lines – both in metres from the station centre. Ways the station data has
  // already are left out.
  function areaWays(st, raw) {
    const P = projector(st.center.lat, st.center.lon);
    const r2 = (v) => Math.round(v * 100) / 100;
    const xy = (geom) => geom.filter(Boolean).map(g => { const [x, y] = P.xy(g.lat, g.lon); return [r2(x), r2(y)]; });
    const known = new Set();
    for (const w of st.walk || []) for (const [x, y] of w.p) known.add(x + ',' + y);
    const walk = [], rails = [];
    for (const el of raw.elements || []) {
      if (el.type !== 'way' || !el.geometry) continue;
      const t = el.tags || {}, p = xy(el.geometry);
      if (p.length < 2) continue;
      if (t.railway) {
        if (!(t.tunnel && t.tunnel !== 'no') && !(t.bridge && t.bridge !== 'no')) rails.push(p);
        continue;
      }
      if (t.foot === 'no' || (/^(no|private)$/.test(t.access || '') && !/^(yes|designated|permissive)$/.test(t.foot || ''))) continue;
      if (p.every(([x, y]) => known.has(x + ',' + y))) continue;
      const off = t.highway === 'corridor' || t.indoor === 'yes' || (!!t.tunnel && t.tunnel !== 'no') || (!!t.level && t.level !== '0');
      const l = parseLevels(t.level);
      walk.push(Object.assign({ k: t.highway === 'steps' ? 'steps' : 'walk', p }, off && t.highway !== 'steps' ? { u: 1 } : null, l ? { l } : null));
    }
    return { walk, rails };
  }

  // The station with the ways of an area added: a new object (its walk network is built anew)
  function withArea(st, area, ways) {
    return Object.assign({}, st, { walk: (st.walk || []).concat(ways.walk), rails: (st.rails || []).concat(ways.rails),
      area: { x0: area.x0, y0: area.y0, x1: area.x1, y1: area.y1 } });
  }

  // ---------- Places of the journey search ----------

  // Any point as origin or destination of the journey search: 'lat,lon' as id (kind 'point', or 'here' for
  // the own location, which is located again before every search)
  function pointPlace(lat, lon, name, kind) {
    return { id: `${lat.toFixed(6)},${lon.toFixed(6)}`, name, kind: kind || 'point', lat, lon };
  }
  // Same place? As the user sees it: the own location is always the same place (wherever it was), everything
  // else by kind and name – points on the map are named after the closest stop, the newest one replaces an
  // older one of the same name; ids can change with the data (bahn.de ids carried a data version)
  const placeKey = (p) => !p ? '' : p.kind === 'here' ? 'here' : p.kind + ':' + p.name;
  const tripKey = (t) => placeKey(t.from) + '>' + placeKey(t.to);

  // List of recent entries: the new one first, an older copy of it removed, at most max entries
  function addRecent(list, entry, keyOf, max) {
    const k = keyOf(entry);
    return [entry].concat((list || []).filter(e => keyOf(e) !== k)).slice(0, max);
  }

  const api = { projector, stationQuery, lookupQuery, buildStation, applyLookup, applyTimetable, finalize,
    setTexts, withPlatform, arrivals, platformLabel, trainChoices, sectionAt, liveDirection, mapSequence, recommend, targetOf, POINT_KEY, cleanName, displayName, normalizeName, searchStations, nearestStations, zoneOf, axisOf, proj,
    matchStation, journeyStops, findPlatform, transferAdvice, viewSelection, routeTypeOf, trackOf, DATA_VERSION,
    pointPlace, placeKey, tripKey, addRecent, connectionTime, TAIL_WARN, seedSpread, snapStop,
    areaFor, areaQuery, areaWays, withArea };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Umstieg = api;
})(typeof window !== 'undefined' ? window : globalThis);
