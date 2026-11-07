#!/bin/bash
# Copies the app and its data from the Mac to the Raspberry Pi and restarts the live-data service.
# Usage (in the project folder):   bash deploy/deploy.sh
# The Pi must have been prepared once with deploy/setup-pi.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
# PI (user@host of the Raspberry Pi) and URL (address of the app) come from deploy/local.sh, which is not in Git:
#   PI=pi@raspberrypi
#   URL=https://umsteiger.example.org/
if [ -f deploy/local.sh ]; then . deploy/local.sh; fi
if [ -z "${PI:-}" ]; then
  echo "Stopped: please create deploy/local.sh with PI=user@pi (and URL=https://…/)." >&2
  exit 1
fi

# The app files: the SHELL list in sw.js ('./' is index.html and left out) and sw.js itself.
FILES=$(sed -n '/^const SHELL = \[/,/\];/p' sw.js | grep -o "'\./[^']\+'" | tr -d "'" | sed 's|^\./||' | grep -v '^$'; echo sw.js)

# Phones keep one complete set of app files per VERSION in sw.js and only fetch a new set when VERSION
# changes. So the version is a checksum of all app files: any change gives a new one, nothing to bump by hand.
# The files say 'dev' (sw.js: VERSION, pages: ?v=dev); the copy for the Pi gets the checksum.
SUM=$(cat $FILES | shasum | cut -c1-10)
STAGE=$(mktemp -d)
chmod 755 "$STAGE"   # rsync copies this mode to the app folder on the Pi; the web server must read it
trap 'rm -rf "$STAGE"' EXIT
for f in $FILES; do
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$f" "$STAGE/$f"
done
sed -i '' "s/const VERSION = 'umsteiger-dev'/const VERSION = 'umsteiger-$SUM'/" "$STAGE/sw.js"
for f in $FILES; do
  case "$f" in *.html) sed -i '' "s/?v=dev\"/?v=$SUM\"/g" "$STAGE/$f" ;; esac
done
grep -q "umsteiger-$SUM" "$STAGE/sw.js" || { echo "Stopped: VERSION not found in sw.js." >&2; exit 1; }

rsync -az --delete --exclude .DS_Store "$STAGE/" data "$PI:/srv/umsteiger/app/"
rsync -az server.py "$PI:/srv/umsteiger/"

ssh "$PI" 'sudo -n systemctl restart umsteiger.service && sleep 1 && systemctl is-active umsteiger.service'
echo "Copied (version $SUM). ${URL:-}"
