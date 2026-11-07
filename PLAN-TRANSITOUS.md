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
- [ ] Extract the earlier API outputs from the session logs into a local summary: per endpoint and kind
  of train, how often track, real time, notes, coach sequence were filled; which journeys were asked
  and what came back (B2).
- [ ] List the fields of the old `server.py` that the new one no longer fills (B3).
- [ ] Write the result into this file (section "Findings"), without personal data.

### Step 2 – Check script
- [ ] `tools/check-live.js`: reads the cases, asks the local `server.py`, runs the journeys through
  `journeyStops()` → `transferAdvice()` with the prepared station data (as `route.js` does) and prints
  the measures above as a table plus a JSON report (in the scratchpad, not in Git).
- [ ] `tools/live-cases.json` (public set) and the private set from the Pi log.

### Step 3 – Measure
- [ ] Runs on a weekday morning (7–9), midday, evening and on a weekend day – real time and messages
  depend on the time.
- [ ] Compare with the baseline; table "bahn.de vs. Transitous" per measure.

### Step 4 – Classify and decide
- [ ] Every gap gets a class (A–D) and a size (how many cases, how bad for the user).
- [ ] Ordered list of fixes; short summary for the user in German.

### Step 5 – Fix classes A and B
- [ ] One fix per commit, with a synthetic test in `test/` where it concerns `core.js`.
- [ ] Run the check script again after every fix; deploy when a group of fixes is done.

### Step 6 – Class C
- [ ] Report data gaps to Transitous (with examples).
- [ ] If the user requests the VBB access and/or a DB API key: provider supplement in `server.py`
  (separate plan).

### Step 7 – On the road
- [ ] Short checklist for the user (which trips, what to look at: advice right? track right? delay shown?).
- [ ] Their notes go into step 4 again.

---

## Findings

(filled in during steps 1–4)
