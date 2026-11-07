# Plan: From Umsteiger to a public transport navigator

This document is the **start prompt** for the work on the branch `navigator`. It can be given as it is
to a new Claude Code session ("Read PLAN-NAVIGATOR.md and continue with the next open step"). The
project rules from `CLAUDE.md` still apply.

---

## Initial prompt

> You are working on the project **Umsteiger** (see `CLAUDE.md`): a PWA without a build step that
> today tells you for **one** station whether to board at the front, in the middle or at the rear of
> the train, so that you have the shortest way when changing or leaving the station.
>
> **Goal:** turn it into a full public transport navigator for Germany – door-to-door journey search
> (address, stop or location → destination), with real time, departures board and map. The unique
> feature stays: **at every change and at the destination it says where to board** ("S41 → U8: board
> at the rear, stairs, about 60 m"), including the coach sequence where DB provides it.
>
> **Constraints (not negotiable):**
> - Plain HTML/CSS/JS without a build step, Leaflet 1.9.4 from cdnjs. `core.js` stays free of DOM and testable in Node.
> - Runs on a Raspberry Pi 3 B+ (905 MB RAM) behind Caddy. **No routing server of our own**
>   (MOTIS/OpenTripPlanner for Germany need gigabytes). Journeys come from an external provider,
>   `server.py` only passes them on (cache 60 s, no database).
> - Provider: **bahn.de** (unofficial interface, already used for live arrivals; nationwide incl. local
>   transport, with real time and coach sequence). Everything behind a **compact format of our own**
>   (see below), so that Transitous (MOTIS, open data) can be added later as a second provider.
> - Every displayed text in all six languages in `i18n.js`. Add new files to `sw.js` (SHELL)
>   (`deploy/deploy.sh` reads its list from there) and include them in the pages with `?v=dev`.
> - Tests as small Node scripts in `test/` with synthetic data, no framework.
> - Talk to the user in German; code and comments in English. The user is not a professional
>   developer: explain steps briefly, and after each step say how to try it out.
>
> Work through the steps below in order, tick off finished ones here (with date) and keep `CLAUDE.md`
> up to date.

---

## What a full navigator app lacks today

| Area | Today | Needed for a navigator |
|---|---|---|
| Journey search | – | from A to B with changes, departure/arrival, earlier/later journeys |
| Origin/destination | a station from `data/index.json` | stops, **addresses**, places (POIs), **own location** |
| Real time | arrivals of a station | delay, cancellation, track change per leg; connection at risk? |
| Departures board | – | departures of a stop (also bus/tram) |
| Course of a trip | – | all stops of a train with times |
| Map | station with accesses | whole route (lines, walks), station zoomed in on demand |
| Changing | advice for one station, the user picks everything by hand | **automatic** for every change of the journey |
| Accessibility | "step-free only" | also in the journey search; lift outages (DB FaSta) |
| Remembering | last station used | favourites (home, work), recent searches, commuter trip with one tap |
| Notification | – | later: Web Push (iOS 16.4+, only as a home screen app) on delays |
| Disruptions | – | messages for the journey (bahn.de `himMeldungen`) |
| Sharing | – | link to a journey |

**Not** planned: buying tickets, prices (at most a note "Deutschlandticket valid"), timetable computation of our own.

## Architecture

```
Browser (PWA)                               Raspberry Pi
─────────────                               ────────────
route.html / route.js  ── /api/places  ──►  server.py ──► bahn.de  reiseloesung/orte
  journey search       ── /api/journeys ─►            ──► bahn.de  angebote/fahrplan
        │
        │ per change: data/st/<id>.json + data/osm/<id>.json (as before)
        ▼
core.js   journeyStops() → matchStation() → transferAdvice() → recommend()
        │
index.html / app.js   detail view of a station (as before, preselected via link)
```

(Since step 6: `index.html` is the journey search with `route.js`, the station view is `station.html` with `app.js`.)

### Compact journey format (response of `/api/journeys`)

```json
{ "journeys": [ {
    "id": "…ctxRecon…", "duration": 1860, "changes": 1,
    "legs": [
      { "mode": "walk", "from": { "name": "Badstraße 10", "lat": 52.55, "lon": 13.38 }, "to": {…}, "distance": 320 },
      { "mode": "transit", "line": "S41", "product": "SBAHN", "direction": "Ring ⟳",
        "journeyId": "2|#VN#…",
        "from": { "name": "Berlin Wedding", "eva": "8089028", "lat": …, "lon": …,
                  "time": "2026-10-22T07:58:00", "rtTime": "…", "track": "2", "rtTrack": null },
        "to":   { "name": "Berlin Gesundbrunnen", "eva": "8011102", …, "time": "…", "track": "3" },
        "prev": { "name": "Berlin Humboldthain", "lat": …, "lon": … },
        "cancelled": false }
    ] } ],
  "later": "…", "earlier": "…" }
```

`prev` = the stop before `to` – as with the live train, it gives the direction of travel at the arrival platform.

### Change advice

For every pair (arriving leg, next leg) at a station:
1. `matchStation(index, lat, lon, name)` → Umsteiger station in `data/index.json` (≤ 400 m, similar name).
2. Load the station data as in `app.js` (`data/st`, `data/osm`, same `localStorage` cache).
3. `findPlatform(st, { product, track, line })` for arrival and departure (track number, kind of transport, line; logic like `livePlatform()`).
4. Direction via `liveDirection()` with `prev`, then `recommend(st, dir, targetPlatform)`.
5. Last leg: the target is the start of the walk after it (map point), otherwise nothing.
6. No station / no platform found → the change is shown without advice (never guess).

---

## Steps

### Step 1 – Fetch journeys and show them with advice (MVP)
- [x] `server.py`: `/api/places?q=` (stops, addresses, places) and `/api/journeys?from=&to=&when=&arrive=&page=` (POST to bahn.de, gzip, translated into the format above). *(21.10.2026)*
- [x] `core.js`: `matchStation()`, `findPlatform()`, `journeyStops()`, `transferAdvice()`; test `test/journey.test.js`. *(21.10.2026)*
- [x] `route.html` + `route.js`: origin/destination with suggestions, time, departure/arrival; list of journeys; opened, the legs with advice per change. *(21.10.2026)*
- [x] Checked with real journeys *(21.10.2026)*. Plausible: Gesundbrunnen S → U8, Alexanderplatz S ↔ U2/U8 and U5 → S, Friedrichstraße S ↔ U6, Ostkreuz Ring ↔ S3, Hermannplatz U7 → U8, Mehringdamm U6 → U7, München Odeonsplatz U5 → U3/U6 (without tracks, via line and direction), Köln Messe/Deutz ICE → S, Köln Hbf, Berlin Hbf, Hamburg Hbf. Fixed: U5 at Alexanderplatz (platforms of the neighbouring station within the radius → told apart by the previous stop), tracks with sections ("9 D-G").
- [x] Destination is itself a station: target point from the station view, otherwise a choice of the OSM exits, otherwise a note. *(21.10.2026)*
- [x] "View station" opens the station view with this change preselected (via the selection stored there, without new URL parameters). *(21.10.2026)*
- [x] Station models in the same `localStorage` cache as `app.js`. *(21.10.2026)*

Left open (belongs to the station data, not to the journey search):
- [ ] Köln Hbf: the OSM footway network connects tracks 8/9 and 10/11 directly at platform level (advice "lift, 20 m") – check the network as in Stuttgart Hbf.
- [ ] Alexanderplatz: the radius of 450 m includes the U5 platforms of Rotes Rathaus; the station view therefore shows a U5 direction "from Rotes Rathaus" at the wrong platform.

### Step 2 – Convenient origin and destination
- [x] Own location as origin (geolocation, only on tap; determined anew before every search). *(22.10.2026)*
- [x] Favourites (home, work) and recent searches in `localStorage`; "swap" button; quick buttons "Home → Work" and the last three searches. *(22.10.2026)*
- [x] Destination (and origin) by tapping the map; the point is named after the nearest stop (`/api/nearby`). *(22.10.2026)*

Learned: bahn.de accepts any coordinates as origin/destination (`A=16@X=<lon·1e6>@Y=<lat·1e6>@`), `fill_walks()` reads them from the id. For short distances (straight line below about 1 km) bahn.de returns no journey → note "on foot".

### Step 3 – Take real time seriously
- [x] Highlight delay, cancellation, track change per leg (`rtTime`, `rtTrack`, `cancelled`). *(22.10.2026)* Fixed: in the journey search bahn.de has the real time under `echtzeit` (not `ezZeit` as in the arrivals) – before, no delays arrived at all. Track changes (`ezGleis`) and cancelled stops did not occur in the samples; field names unchecked.
- [x] Check the change time against the walk from `recommend()`: "tight" / "connection at risk" (`connectionTime()`: 75 m/min + 1 min to get off, tight below 2 min of buffer). *(22.10.2026)*
- [x] Show disruption messages of the journey (journey, leg, stop; priority HIGH as a warning, the rest collapsed). *(22.10.2026)*
- [x] Refresh the journey (button + every 60 s while the page is open; bahn.de `angebote/recon`). *(22.10.2026)*
- [x] "View station" also hands over arrival time and train, so that "My train (live)" with coach sequence is preselected there. *(22.10.2026)*

### Step 4 – Map of the route
- [x] Line course and walks on a Leaflet map ("Route on the map" in the opened journey, remembered). Geometry via `/api/shape` (bahn.de `reiseloesung/fahrt?poly=true`, the piece between boarding and getting off, simplified to 15 m); for U-Bahn and bus bahn.de gives only stop-to-stop lines, walks only as straight lines. Tapping a change opens its station map. *(22.10.2026)*
- [x] Station map with the recommended access to open at every change ("Show map" next to "View station"); drawing shared with `app.js` in `stationmap.js`. Tapping another access = correction as in the station view (same storage), tapping an exit chooses it as the target. *(22.10.2026)*

### Step 5 – Departures board and course of a trip
- [x] `/api/departures` (bahn.de `abfahrten`), view per stop, also bus/tram: new page `departures.html` with search, "stops nearby", recent stops, filter by kind of transport, "Later", reload every 60 s. *(22.10.2026)* Note: bahn.de returns about one hour from the chosen time; real time only for DB trains and S-Bahn, not for BVG U-Bahn and bus.
- [x] Course of a train (all stops, real time): can be opened in the departures board (`/api/trip`, earlier stops collapsed), in the journey "n stops in between" per leg. *(22.10.2026)*

### Step 6 – One app instead of two pages
- [x] Shared navigation (Journey / Departures / Station), start page = journey search: `index.html` is now the journey search, the station view is called `station.html`; old links redirect. *(22.10.2026)*
- [x] Move the loading of station data from `app.js` into a shared file (`stationdata.js`), plus `common.js` with the helpers all pages had twice. *(22.10.2026)*

### Step 7 – Later
- [x] Switch the provider to Transitous (MOTIS, open data). *(07.11.2026)* Reason: since November 2026 bahn.de blocks journeys, departures, arrivals and coach sequences for clients that are not browsers (bot protection), only the place search still answers. Transitous asks for open-source projects, hence this public repository. Only `server.py` changed (plus footers and the course of a leg, which now comes with the journey). Lost: coach sequences (no open source for them). The Berlin S-Bahn has no tracks at Transitous; the platform comes from line and direction.
- [ ] Lift outages (DB FaSta) in "step-free only".
- [ ] Web Push on delays of the remembered commuter journey.

## Risks

- **bahn.de is unofficial**: fields can change, requests may be throttled or blocked (which happened in
  November 2026, see step 7). That is why everything sits behind our own format, so that a change of
  provider only concerns `server.py`. The app stays usable without `/api/` (station view as before).
- **Private use only**: a public app with many users needs an official interface (DB API Marketplace,
  transport association APIs such as VBB) or Transitous.
- **Matching a bahn.de stop to an OSM platform** is the real difficulty (Berlin's S-Bahn has its own stop
  numbers, U-Bahn tracks are named differently at bahn.de). Better no advice than wrong advice.
