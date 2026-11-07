# Plan: Make the app as good with Transitous as it was with bahn.de

Since 07.11.2026 journeys, departures, arrivals and trips come from Transitous instead of bahn.de (see
`PLAN-NAVIGATOR.md`, step 7). The user finds the app much worse since. This plan finds out **where**
exactly, **why**, and fixes what can be fixed on our side. Rules from `CLAUDE.md` apply; bahn.de's bot
protection is not worked around.

---

## Approach

1. **Know what bahn.de delivered** (baseline) – we cannot ask bahn.de any more, so the baseline is put
   together from what we still have.
2. **Measure Transitous** with a fixed set of cases and a script, at several times of day.
3. **Classify every gap** by its cause – only then decide what to do.
4. **Fix our side first** (cheap, under our control), with tests; one commit per fix.
5. **For data gaps** at Transitous: report upstream or add an official source – the user decides.
6. **Check on the road** with the user's own trips.

### Sources for the baseline (bahn.de, October 2026)

| Source | What it tells | Where |
|---|---|---|
| B1 Checked changes | expected advice per change (plausible on site/map) | `PLAN-NAVIGATOR.md` step 1, `CLAUDE.md` |
| B2 Earlier API outputs | which fields were filled (tracks, real time, notes, sequence) | Claude Code session logs (about 250 calls, 30.09.–04.11.2026); extracted only locally, not into Git |
| B3 Old code | which fields existed at all | `git show 1dc1140:server.py` |
| B4 Timetable | planned tracks independent of any provider | `data/st/<id>.json` (GTFS; tracks almost only in Berlin/Brandenburg) |
| B5 Known limits | e.g. bahn.de departures had no real time for BVG U-Bahn and bus | `PLAN-NAVIGATOR.md` step 5 |

### Cases

- **Public set** `tools/live-cases.json` (in Git): one journey per change checked in step 1 – Gesundbrunnen
  S → U8, Alexanderplatz S ↔ U2/U8 and U5 → S, Friedrichstraße S ↔ U6, Ostkreuz ring ↔ S3, Hermannplatz
  U7 → U8, Mehringdamm U6 → U7, München Odeonsplatz U5 → U3/U6, Köln Messe/Deutz ICE → S, Köln Hbf,
  Berlin Hbf, Hamburg Hbf, Eberswalde Hbf RE3 → bus 862; plus address → address in Berlin, a long
  distance trip (Berlin → Hamburg, → München) and a rural one. Departures and arrivals at Gesundbrunnen,
  Alexanderplatz, Berlin Hbf, Hermannplatz (U/bus), Hamburg Hbf, München Hbf.
- **Private set** `tools/live-cases.local.json` (not in Git): the family's real trips, taken from the
  request log of `server.py` on the Pi (`journalctl -u umsteiger`) – only on the Mac, never committed.

### What is measured (per case, per run)

| Area | Measure | Why it matters |
|---|---|---|
| Journeys | found at all; number; duration and changes compared to B1/B2 | does the search still find the usual route? |
| Advice | share of changes with advice; reason when not (station not matched, platform not found, direction unknown) | the core of the app |
| Tracks | share of legs with a track, per kind (ICE/IC, RE/RB, S, U, tram/bus) | platform finding depends on it |
| Real time | share of legs/departures with `rtTime`; delays seen; cancellations | change at risk, departures board |
| Notes | disruption messages present | step 3 of the navigator |
| Names | line names ("RE3", "S41", "Bus 862"), stop names, directions as before | `findPlatform()` and `matchStation()` match on them |
| Walks | coordinates and length of walks | advice at the destination, change time |
| Geometry | course of the leg on the map | route map |
| Places | first hit for typical searches (station, address, place) | origin/destination input |
| Live train (station view) | arrivals in the window; platform and direction found | "My train (live)" |
| Speed | answer time of `/api/journeys`, `/api/departures` | felt quality on the phone |

### Classes of causes

- **A – our translation** in `server.py` (field not read, wrong mapping, time zone, product, line name).
- **B – our logic** that was tuned to bahn.de (`matchStation()`, `findPlatform()`, `snapStop()`,
  `liveDirection()`, `connectionTime()`), e.g. other stop names or track formats.
- **C – data gap at Transitous** (feed without tracks or real time, missing feed) → report to Transitous
  (Matrix `#transitous:matrix.spline.de` / GitHub), or add an official source (see below).
- **D – gone for good** without a new source (coach sequence).

### Official sources for class C (need the user)

- **VBB API** (HAFAS, Berlin/Brandenburg; tracks also for the S-Bahn, real time, messages): free on
  request by e-mail to the VBB.
- **DB API Marketplace "Timetables"** (planned and changed tracks, real time of DB trains per station):
  free account and API key.
- Both only as a supplement behind our compact format; the key stays in a file outside Git on the Pi.

---

## Steps

### Step 1 – Baseline
- [x] Extract the earlier API outputs from the session logs (B2). *(07.11.2026)* Full answers were hardly
  kept, mostly printed summaries; usable: nine journeys with tracks, real time and advice, one departures
  board (Gesundbrunnen), one live arrival. They are the `expect` entries in `tools/live-cases.json`.
- [x] Fields of the old `server.py` that the new one no longer fills (B3): coach sequence (`sequence`);
  everything else exists, but is filled less often (see findings).
- [x] Result in "Findings" below. *(07.11.2026)*

### Step 2 – Check script
- [x] `tools/check-live.js` *(07.11.2026)*: reads the cases, asks the local `server.py`, runs the journeys through
  `journeyStops()` → `transferAdvice()` with the prepared station data (as `route.js` does) and prints
  the measures above as a table plus a JSON report (in the scratchpad, not in Git).
- [x] `tools/live-cases.json` (public set). *(07.11.2026)*
- [ ] Private set from the Pi log.

### Step 3 – Measure
- [x] Saturday evening 07.11.2026, live (with real time). Timetable for Monday 09.11.2026 07:45 (without real time).
- [ ] Live on a weekday morning (7–9) – real time and messages depend on the time.
- [ ] Compare with the baseline; table "bahn.de vs. Transitous" per measure.

### Step 4 – Classify and decide
- [x] Every gap gets a class (A–D) and a size (see findings). *(07.11.2026)* The user: tracks change often in
  Berlin – the planned track is only a hint, the real-time track counts (the app already prefers it).
- [ ] Ordered list of fixes; short summary for the user in German.

### Step 5 – Fix classes A and B
- [x] Finding 1, long walks: `without_long_walks()` in `server.py`. *(07.11.2026)* Monday morning: no Berlin
  case starts with a long walk any more; changes with advice 33 of 41 (before 19 of 27).
- [x] Finding 3, trains without a name: train when the stop has a track, line shown as "Zug". *(07.11.2026)*
- [x] Finding 5, place search: places near home / the last journey first (`placeBias` 3; "München Hbf" still
  first). *(07.11.2026)* Left: Transitous does not find "U Kochstr" (the stop is called "U Kochstr.
  (Checkpoint Charlie)") – report upstream.
- [x] Finding 2 in part: "Fern 6" counts as track 6. Finding 7: Berlin Hbf track 4. *(07.11.2026)*
- [x] Finding 8 (FlixBus): the user wants them shown – nothing to do. *(07.11.2026)*
- [x] Deployed (07.11.2026).

### Step 6 – Class C
- [ ] Report data gaps to Transitous (with examples).
- [ ] If the user requests the VBB access and/or a DB API key: provider supplement in `server.py`
  (separate plan).

### Step 7 – On the road
- [ ] Short checklist for the user (which trips, what to look at: advice right? track right? delay shown?).
- [ ] Their notes go into step 4 again.

---

## Findings

### bahn.de (checked 07.11.2026)

Not a changed interface but a block in front of it: every path under `/web/api/` – also one that does not
exist – answers Akamai's "403 Access Denied" to a client that names itself; the home page answers 200.
Since November even the place search (`orte`) is blocked, which still answered at the switch. The host of
the DB Navigator app interface (`app.vendo.noncd.db.de`) no longer resolves. Nothing to adapt on our side.

### Transitous against bahn.de (runs of 07.11.2026, 19 journeys, 5 departures boards, 3 arrival lists)

Ordered by how much the user notices it. Class: A our translation, B our logic, C data at Transitous,
D gone.

1. **Long walks instead of a change (A, biggest).** Transitous (MOTIS) keeps journeys with fewer changes
   even when they need up to 15 minutes on foot, and lists them first by departure. In almost every Berlin
   case one or two of the first three journeys are of this kind: Bornholmer Str. → Voltastr.: S-Bahn and
   then 925 m on foot instead of one stop on the U8; Humboldthain → Voltastr.: 925 m to the U8; U5 → walk
   757 m instead of changing at Alexanderplatz; Ostkreuz 885 m, Hermannplatz 880 m; Eberswalde 991 m
   instead of bus 862. bahn.de showed the change. The good journey is there, just further down.
   Options: shorter walks before/after the ride in the request (`maxPreTransitTime`,
   `maxPostTransitTime`, 900 s by default), or hiding a journey with a long walk when another arrives
   about as early.
2. **Tracks missing or wrong outside Berlin (C, partly A).**
   - Berlin S-Bahn: no tracks (known). The platform still comes from line and direction – right in
     every case checked (Gesundbrunnen from north and south as with bahn.de).
   - Hamburg Hbf, Köln Hbf: planned tracks missing for ICE and S-Bahn; they come only with real time
     shortly before → no advice for journeys later in the day (`noPlatform`).
   - Köln/Bonn area (VRS): the planned "track" is a stop-point code (94, 91, 74, 80, 87); the real one
     comes only with real time → wrong "track change 94 → 12" and no platform.
   - Frankfurt Flughafen: "Fern 6" → our `trackOf()` reads "Fern" (A/B, easy).
3. **Extra trains without a name (A).** Trains added in real time (e.g. a replacement ICE Berlin → Hamburg)
   come as mode `OTHER`, name "?" → shown as bus "?" without advice. Can be shown as a train with its
   destination and track.
4. **No disruption messages (C).** 0 messages in all runs (bahn.de: e.g. "Reparatur an der Strecke").
   Check again on a weekday.
5. **Place search without location (A).** "Kochstraße Berlin" → "Ahlbeck, Kochstraße". The search can be
   biased to a position (`place`), e.g. the user's location or last place.
6. **Different planned track (data question).** RE3 from Eberswalde at Gesundbrunnen: track 8 at
   Transitous (November data), 6/7 in our timetable (October) and at bahn.de (23.10.) → other advice
   (middle, lift, 39 m instead of front, escalator, 120 m). Which one is right can only be seen on site.
7. **Berlin Hbf track 4 (B, independent of the provider).** Two OSM platforms carry ref 4 → `findPlatform()`
   gives up (`noTarget`). Prefer the platform with train/line information.
8. **Coaches in the results (A, small).** FlixBus (also to Milan) and FlixTrain appear; bahn.de showed no
   FlixBus.
9. **Coach sequence (D).** Gone.

Better than with bahn.de: real time for U-Bahn and bus (bahn.de had none for BVG): departures U-Bahn 55 %,
bus 88 %, S-Bahn about 80 %; course of U-Bahn and bus legs as a real line; answers fast (journeys median
0.3 s). "My train (live)": platform found for all arrivals checked at Gesundbrunnen, Alexanderplatz and
Hamburg Hbf, also for the S-Bahn without track.

Advice per change (Monday morning, timetable): 19 of 27 changes with advice, 2 "same platform",
5 without platform (Hamburg Hbf, Köln), 1 without target (Berlin Hbf track 4).
