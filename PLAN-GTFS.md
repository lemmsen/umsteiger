# Plan: Timetable data (DELFI GTFS) for all of Germany

Goal: the app works at every station in Germany. Lines, direction of travel and the station search
come from the official timetable (GTFS). OpenStreetMap still provides platforms and accesses.

## Basic idea

```
DELFI GTFS (ZIP, large)               OpenStreetMap (Overpass, live)
        │                                        │
  tools/prepare-gtfs.js                          │
  (once a month, on your Mac)                    │
        │                                        │
  data/index.json   ─── station search           │
  data/st/<id>.json ─── lines + previous stop    │
        │                                        │
        └──────────► core.js ◄───────────────────┘
                 platform axis, accesses, recommendation
```

- Still **no backend**. The script runs only on your own computer, and the generated JSON files are
  copied to the server like all other files.
- The browser loads only the small file of the chosen station (a few KB).
- The OSM route relations remain as a **fallback** in case a station is missing from the GTFS.

## What GTFS provides and what it does not

| Question | Today (OSM) | With GTFS |
|---|---|---|
| Which lines stop here? | route relations, often incomplete | complete, official timetable |
| Previous stop, i.e. direction of travel | relation + second Overpass query | directly from `stop_times` |
| Platform / track of the line | assigned by distance | `platform_code` + coordinates of the stop (where present) |
| Station search | coordinates by hand in the URL | search over all stations |
| Platform geometry, stairs, lifts | OSM | **still OSM** (not in GTFS) |

---

## Step 0 – Reference ✅ (done 30.09.2026)

Gesundbrunnen tested **with OSM only**. Result: all lines (S1, S2, S15, S25, S26, S41, S42, U8) are
found, the samples for front/rear are right. Fixed along the way: the ring lines (S41/S42) were
missing because their OSM relation begins and ends at Gesundbrunnen; fragmented accesses are now
grouped into spots, and equally good spots are all shown. These results are the benchmark for the
GTFS version.

## Step 1 – Get the data and look at it ✅ (done 30.09.2026)

**Source:** the free feeds from **gtfs.de**. They are generated from the DELFI data and can be
downloaded without registration (licence CC BY 4.0, updated daily, each valid for the next 30 days).
They come in three parts:

| File | Content | Size (ZIP → unpacked) |
|---|---|---|
| `https://download.gtfs.de/germany/fv_free/latest.zip` | long distance (ICE, IC, EC) | 0.4 MB → 3 MB |
| `https://download.gtfs.de/germany/rv_free/latest.zip` | regional **incl. S-Bahn** | 11 MB → 80 MB |
| `https://download.gtfs.de/germany/nv_free/latest.zip` | local: **U-Bahn**, tram, bus | 287 MB → 2.3 GB |

The complete feed (`germany/full`) is not free. It is not needed, because the three parts can be
merged: the station ids (`parent_station`) are the same in all three.

The files live locally in `rawdata/` (in `.gitignore`, not for the server).

**Result for Gesundbrunnen:** there is one entry **per track with its own coordinate and
`platform_code`**, i.e. the good case. Lines and previous stops are right:

| Line | Track | comes from |
|---|---|---|
| S1, S2, S25, S26 | 1 | Bornholmer Straße |
| S1, S2, S25, S26 | 4 | Humboldthain |
| S41 | 3 | Wedding |
| S42 | 2 | Schönhauser Allee |
| S15 (new) | 3 | Wedding |
| U8 | 1 | Pankstraße |
| U8 | 2 | Voltastraße |
| RE3, RE5, RB27 … | 5–10 | depending on direction |

**Findings for the script:**
- `stop_id` and `parent_station` are plain numbers (e.g. Gesundbrunnen = `146054`), **not DHIDs**.
  Whether they stay the same between two releases is unclear. The app URL should therefore contain
  name and coordinates, not only the id.
- `route_type` is always `2` in the regional feed. S-Bahn lines are therefore recognised by name (`^S\d`).
- `route_color` is mostly empty; colours still come from OSM or from a small table of our own.
- Besides the tracks there are entries without `platform_code` (bus and tram stops); ignore them.

## Step 2 – Preparation script `tools/prepare-gtfs.js` ✅

Node script without extra packages (Node v24 is installed). The three ZIPs are unpacked beforehand
with the Mac command `unzip` to `rawdata/fv|rv|nv`, and the script reads all three. Large files are
read **line by line** (`readline`), so the memory suffices.

Procedure:

1. `routes.txt` → keep rail only: S-Bahn, U-Bahn, regional and long distance (tram and bus later).
2. `trips.txt` → remember the trips of these lines (line, destination `trip_headsign`).
3. `stops.txt` → stops with name, coordinates, `platform_code` and parent station
   (`parent_station`, e.g. `146054` = Gesundbrunnen).
4. `stop_times.txt` (the big file) → walk through the stop sequence of every trip and record for every
   stop: **line, platform here, previous stop, destination**. Count how often each combination occurs.
5. Drop rare combinations (e.g. < 1 % of the trips: diversions, empty runs).
6. Output:
   - `data/index.json`: all stations with id, name, centre and radius (from the extent of the
     platforms). Roughly 7,000 entries, under 300 KB compressed.
   - `data/st/<id>.json` per station, e.g.:
     ```json
     {
       "id": "146054",
       "name": "S+U Gesundbrunnen",
       "lat": 52.5486, "lon": 13.3886, "r": 450,
       "date": "2026-10-01",
       "lines": [
         { "ref": "S1", "type": "light_rail", "colour": "#DA6BA2",
           "platform": { "code": "1", "lat": 52.549, "lon": 13.388 },
           "prev": { "name": "Bornholmer Straße", "lat": 52.554, "lon": 13.398 },
           "destinations": ["Wannsee"], "share": 0.98 }
       ]
     }
     ```
7. At the end the script prints a short summary (number of stations, lines, stops without track).
   It shows whether something is wrong with the data.

### Result of the first run (30.09.2026)

- The script runs in about 50 s and produces 8,666 stations: `index.json` about 1 MB, all station files together about 10 MB.
- Gesundbrunnen matches step 0 (all S-Bahn lines and the U8 at the right track, with the right previous stop).
- **Problem: track information exists almost only around Berlin/Brandenburg** (409 of 991 stations,
  in the rest of Germany 221 of 7,675). Köln Hbf, Frankfurt Hbf, Leipzig Hbf and Hannover Hbf have
  only 1–2 entries for the whole station in the free feed.
  → Lines and previous stop are reliable nationwide, **the track is not**.
- Decided in step 3: the track outside Berlin comes from OSM (see below).

## Step 3 – Integration into `core.js` ✅ (done 30.09.2026, variant "combined with OSM")

Implemented as described below, plus:
- The track number only counts at a platform of the matching kind (U-Bahn vs. train); otherwise the
  U8 "track 2" at Gesundbrunnen ended up at the S-Bahn platform "1;2".
- If the platform is unknown, the app asks "Which platform do you arrive at?" and remembers the choice.
- App: `?id=<station number>`; without `id` and without coordinates Gesundbrunnen (`146054`) applies.
- Tested: Gesundbrunnen (all tracks via track number or relation, directions as in step 0),
  Hamburg Jungfernstieg (13 of 15 via OSM relations, S5 unknown → user chooses), `test/timetable.test.js`.

### Original plan

New function `applyTimetable(st, tt)` that fills `routeInfos` **instead of** `lookupQuery()`/`applyLookup()`:

1. Assign every GTFS line to an OSM platform, in this order:
   a. `platform_code` matches OSM `ref`/`local_ref` of the platform,
   b. otherwise the OSM platform nearest to the stop coordinate (max. ~30 m),
   c. otherwise: mark the line as "track unknown" and do not recommend.
2. `here` = stop coordinate (or platform centre), `prev` = coordinate of the previous stop.
   `finalize()` and `recommend()` stay **unchanged**, as they already work with exactly these values.
3. Fallback: if there is no GTFS file for the station, the OSM path runs as before.

Test: `test/gtfs.test.js` with a tiny synthetic station (two platforms, one line in both directions)
in the same style as the existing test.

## Step 4 – User interface: station search ✅ (done 30.09.2026)

Implemented: "Change station" at the top, search tolerant of umlauts and abbreviations
("koeln hauptbahnhof" finds "Köln Hbf"), "Search near me", recently used stations, start with the
last station. `index.json` compact: 509 KB (192 KB compressed), loaded only when the search is opened.

**Noticed, still open:**
- ✅ (01.10.2026) Large stations were split into several "stations" in the timetable (Hamburg Hbf,
  "HBF/Kirchenallee", "Hauptbahnhof Nord/Süd"; Frankfurt Hbf + "tief"; Leipzig, Hannover, Stuttgart …).
  `prepare-gtfs.js` now merges them (86 parts). Occasionally neighbouring stops with the same district
  name are merged too (e.g. Zuffenhausen Kelterplatz/Rathaus) – harmless, only extra lines appear there.
- Stations of the same name in different cities (e.g. two "Marienplatz") cannot be told apart in the
  result list, because the timetable gives no city.

### Original plan

- Search field at the top. Typing searches `data/index.json` (names without "S+U", umlauts normalised).
- Selection → `?id=146054&name=…&lat=…&lon=…` in the URL (the id alone is not enough, see step 1).
  The old parameters `name/lat/lon/r` keep working.
- Remember recently used stations (`localStorage`, in try/catch as before).
- Optional: button "Station near me" (location access in the browser).

## Step 5 – Offline and updates

- `sw.js`: cache `data/index.json` and the `data/st/*.json` already opened.
- Monthly: load new GTFS → run the script → upload the folder `data/`. The date is in every file as
  `date` and shown in the app.
- Footer: "Timetable data: DELFI e.V. / gtfs.de, CC BY 4.0" (exact wording from the licence).

## Step 6 – Check at several stations

Few but different stations with a known answer:

| Station | Why |
|---|---|
| Berlin Gesundbrunnen | reference from step 0 |
| Berlin Alexanderplatz | many levels, U-Bahn crossing |
| Hamburg Hbf | large hall, S-Bahn + long distance |
| München Marienplatz | S- and U-Bahn on top of each other |
| a small regional station | checks whether the app reacts sensibly to sparse OSM data |

---

## Open questions

1. How much space is there on the server? (The files in `data/` are estimated at 20–50 MB in total,
   but small one by one.)
2. Tram in round 1 or later? Tram stops rarely have stairs at the platform, so the benefit is small there.

## Deliberately later

- Live lift status (DB FaSta, BVG)
- Walk routing instead of the straight line (step 3 in CLAUDE.md) – done since
- Coach sequence / short train notice – done since
- Prepare the OSM data in advance as well, in case the public Overpass servers become a bottleneck
  with many users – done since (`tools/prepare-osm.js`)
