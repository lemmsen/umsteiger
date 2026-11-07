#!/bin/bash
# One-time setup on the Raspberry Pi. Run with sudo from the folder that holds this script,
# Caddyfile (your copy of Caddyfile.example) and umsteiger.service:   sudo bash setup-pi.sh
# Safe to run again.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
OWNER="${SUDO_USER:?Please run with sudo as a normal user: sudo bash $0}"
SYSTEMCTL="$(command -v systemctl)"

echo "1/4 Folder /srv/umsteiger (owned by $OWNER, so deploy.sh can copy without sudo)"
install -d -o "$OWNER" -g "$OWNER" /srv/umsteiger /srv/umsteiger/app

echo "2/4 Service umsteiger.service"
install -m 644 "$HERE/umsteiger.service" /etc/systemd/system/umsteiger.service
systemctl daemon-reload
systemctl enable umsteiger.service
# started by deploy.sh once server.py is there
if [ -f /srv/umsteiger/server.py ]; then systemctl restart umsteiger.service; fi

echo "3/4 $OWNER may restart exactly this service without a password"
RULE="$(mktemp)"
echo "$OWNER ALL=(root) NOPASSWD: $SYSTEMCTL restart umsteiger.service" > "$RULE"
visudo -cf "$RULE" > /dev/null
install -m 440 "$RULE" /etc/sudoers.d/umsteiger
rm -f "$RULE"

echo "4/4 Caddy"
if [ ! -f "$HERE/Caddyfile" ]; then
  echo "Stopped: Caddyfile missing – copy Caddyfile.example and enter your own names." >&2
  exit 1
fi
if ! cmp -s "$HERE/Caddyfile" /etc/caddy/Caddyfile; then
  BACKUP="/etc/caddy/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
  cp /etc/caddy/Caddyfile "$BACKUP"
  echo "    old configuration saved: $BACKUP"
  caddy validate --config "$HERE/Caddyfile" --adapter caddyfile > /dev/null
  install -m 644 "$HERE/Caddyfile" /etc/caddy/Caddyfile
fi
systemctl reload caddy

echo
echo "Done. Caddy now gets the certificate by itself as soon as ports 80 and 443 are reachable from outside."
echo "See the log: journalctl -u caddy -n 30 --no-pager"
