# Umsteiger

A web app (PWA) for public transport in Germany that tells you whether to board **at the front, in the middle or at the rear** of the train, so that you get off right at the stairs to your connection (or to the exit). It also searches journeys and shows this advice for every change on the way.

The app's texts are available in German, English, French, Italian, Spanish and Japanese.

## Hosting

1. Copy the whole folder to your web server (static files; `server.py` is only needed for live data and journey search).
2. Serve it over **HTTPS**, otherwise offline mode and the home screen app do not work properly.
3. Local test: run `python3 server.py` in the folder, then open `http://localhost:8000`.
   `server.py` serves the app and forwards requests for live data that the browser may not make itself (needs Python 3.9+ and `curl`). On a purely static server (or with `python3 -m http.server`) the station view still works, just without live data.

### Raspberry Pi with Caddy

The folder `deploy/` holds everything for a Raspberry Pi with Caddy installed. Caddy serves the files, obtains and renews the Let's Encrypt certificate by itself and passes `/api/` on to `server.py` (running as the service `umsteiger.service`).

1. Forward ports 80 and 443 (TCP) from your router to the Pi.
2. Copy `deploy/Caddyfile.example` to `deploy/Caddyfile` and enter your own host name (it must point to your connection). Also create `deploy/local.sh`:
   ```
   PI=user@raspberrypi
   URL=https://umsteiger.example.org/
   ```
   Both files stay out of Git.
3. One-time setup (`user@raspberrypi` as in `deploy/local.sh`):
   ```
   ssh user@raspberrypi mkdir -p umsteiger-setup
   scp deploy/Caddyfile deploy/umsteiger.service deploy/setup-pi.sh user@raspberrypi:umsteiger-setup/
   ssh -t user@raspberrypi 'sudo bash umsteiger-setup/setup-pi.sh'
   ```
4. Copy app and data – also after every change and after the monthly data update: `bash deploy/deploy.sh`

`deploy/deploy.sh` sets the app version for the phones by itself (a checksum of the app files) – nothing to bump by hand.

## On the iPhone

Open the page in **Safari** → Share → **"Add to Home Screen"**. The app then starts full screen. After the first load the station data is stored offline (also available in a tunnel).

## How it works

1. Loads from OpenStreetMap (prepared per station, or via the Overpass API as a fallback): platforms, stairs, escalators, lifts, footways and the routes of the lines (S-Bahn, U-Bahn, regional and long-distance trains).
2. Determines the long axis of each platform and projects the accesses onto it.
3. Derives the direction of travel from the line's previous stop → "front" is the end of the platform in the direction of travel.
4. Groups stairs, escalators and lifts that lie close together into one spot.
5. Computes the shortest walk through the OSM footway network (footways, corridors, stairs, escalators, lifts) from each spot to the target platform and splits the platform into thirds. The walk is drawn dashed on the map. If the network lacks a connection, the app uses the straight line and says so. If several spots are about equally far, the app shows all of them (e.g. "board at the front or at the rear").

Where mapped in OSM, the app also names the **platform section** (A–G, as on the signs on the platform). If there are stop signs for shorter trains, you can choose the **train length**: the app then places the train at its stop sign and adds the walk along the platform to the stairs.

**My train (live)** (only with `server.py`): set the time under "Arrival around" (default: now), choose with the filters which kinds of train you want to see, then pick your train from the arrivals. The app then sets platform and direction by itself and places the train with its real coach sequence on the platform – with coach number and section.

If a recommendation is wrong, tap the right access on the map or in the list – the choice is stored on the device.

## Another station

Tap **"Change station"** at the top and type the name – or "Search near me" (needs location access and HTTPS). The app remembers the stations used last and starts with the last one.

Directly by URL with the station number from `data/index.json`, e.g. Hamburg Jungfernstieg:
`…/station.html?id=70733`

Without timetable data it also works with coordinates (then only with the lines from OSM):
`…/station.html?name=Alexanderplatz&lat=52.5215&lon=13.4113&r=450`

## Updating the data (about monthly)

Timetable and OSM data are prepared on a Mac (or any machine with about 6 GB of free memory) and copied to the server as files in `data/`. The app then needs no Overpass queries any more (only for stations opened by coordinates).

Once: `brew install osmium-tool`

1. **Timetable:** download the three feeds from gtfs.de and unpack them to `rawdata/fv`, `rawdata/rv`, `rawdata/nv`:
   ```
   cd rawdata
   for f in fv rv nv; do curl -sSL -o ${f}_free.zip https://download.gtfs.de/germany/${f}_free/latest.zip && unzip -oq ${f}_free.zip -d $f; done
   ```
2. **OSM:** download the extract for Germany (about 5 GB) to `rawdata/germany-latest.osm.pbf` – from Geofabrik or its mirror at GWDG:
   ```
   curl -L -R -o germany-latest.osm.pbf https://download.geofabrik.de/europe/germany-latest.osm.pbf
   # if Geofabrik cannot be reached:
   curl -L -R -o germany-latest.osm.pbf https://ftp5.gwdg.de/pub/misc/openstreetmap/download.geofabrik.de/germany-latest.osm.pbf
   ```
3. In the project folder run one after the other (the order matters):
   ```
   node tools/prepare-gtfs.js
   node --max-old-space-size=6144 tools/prepare-osm.js
   ```
4. Copy the folder `data/` to the server.

All four steps in one go (downloads, prepares and copies to the Raspberry Pi): `bash tools/update-data.sh`

## Limits

- The walk is only as good as the footway network in OSM. Missing or wrongly connected ways lead to detours or to the straight line.
- Positions are for full-length trains unless a train length is chosen; short trains may stop elsewhere.
- Only as good as the OSM data. You can fix errors directly on openstreetmap.org.

## Data sources

Map data © OpenStreetMap contributors, ODbL. Timetable data: DELFI e.V. / gtfs.de, CC BY 4.0.

## Licence

The code is under the [MIT licence](LICENSE). The data is under the licences of its sources (see above).
