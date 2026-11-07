#!/bin/bash
# Monthly data update in one go: download timetable (gtfs.de) and OSM extract (Geofabrik),
# prepare data/ and copy it to the Raspberry Pi.
# Usage (in the project folder):   bash tools/update-data.sh
# Runs on the Mac, not on the Pi: prepare-osm.js needs about 6 GB of memory.
# Takes about 5 minutes plus the download (about 5 GB, only when there is a newer extract).
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p rawdata

echo "1/4 Timetable (gtfs.de)"
for f in fv rv nv; do
  curl -fsSL -o "rawdata/${f}_free.zip.part" "https://download.gtfs.de/germany/${f}_free/latest.zip"
  mv "rawdata/${f}_free.zip.part" "rawdata/${f}_free.zip"
  rm -rf "rawdata/$f"
  unzip -oq "rawdata/${f}_free.zip" -d "rawdata/$f"
  rm -f "rawdata/${f}_free.zip"   # unpacked, not needed any more
done

echo "2/4 OSM extract for Germany (only if there is a newer one)"
PBF=rawdata/germany-latest.osm.pbf
rm -f "$PBF.part"
NEWER=()
if [ -f "$PBF" ]; then NEWER=(-z "$PBF"); fi
curl -fL -R ${NEWER[@]+"${NEWER[@]}"} -o "$PBF.part" https://download.geofabrik.de/europe/germany-latest.osm.pbf ||
  curl -fL -R ${NEWER[@]+"${NEWER[@]}"} -o "$PBF.part" https://ftp5.gwdg.de/pub/misc/openstreetmap/download.geofabrik.de/germany-latest.osm.pbf
# no .part file = the extract on the server is not newer than ours
if [ -s "$PBF.part" ]; then mv "$PBF.part" "$PBF"; else echo "    unchanged"; fi

echo "3/4 Preparing"
BEFORE=$(ls data/osm 2>/dev/null | wc -l)
node tools/prepare-gtfs.js
node --max-old-space-size=6144 tools/prepare-osm.js
AFTER=$(ls data/osm | wc -l)
# do not replace good data on the server with a broken result
if [ "$AFTER" -lt $((BEFORE * 9 / 10)) ] || [ ! -s data/index.json ]; then
  echo "Stopped: only $AFTER stations instead of $BEFORE before – nothing copied." >&2
  exit 1
fi

# Free the disk: timetable files and the filtered OSM intermediates are made anew by the next update.
# The OSM extract stays: it tells whether Geofabrik has a newer one, and it serves to look into single stations.
rm -rf rawdata/fv rawdata/rv rawdata/nv rawdata/osm-*.opl
echo "    Intermediate files deleted, rawdata/ now takes $(du -sh rawdata | cut -f1)"

echo "4/4 Copying to the Raspberry Pi"
bash deploy/deploy.sh
