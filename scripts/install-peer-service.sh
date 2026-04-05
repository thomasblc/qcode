#!/usr/bin/env bash
# Install qcode-peer.service on a Debian peer machine so peer-provider.mjs
# starts at boot and restarts on crash. Run this ONCE on the peer.
#
# Usage (on the peer, not the Mac):
#   cd ~/qcode-peer
#   sudo bash install-peer-service.sh
#
# This will:
#   1. Copy qcode-peer.service to /etc/systemd/system/
#   2. daemon-reload
#   3. enable + start the service
#   4. show status

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "needs root (re-run with sudo)"
  exit 1
fi

SERVICE_SRC="$(dirname "$0")/qcode-peer.service"
if [ ! -f "$SERVICE_SRC" ]; then
  echo "qcode-peer.service not found at $SERVICE_SRC"
  exit 1
fi

# Stop any running peer-provider started manually to avoid the hypercore
# storage lock colliding with the service.
pkill -9 -f peer-provider || true
pkill -9 -f worker.js || true
sleep 1

install -m 0644 "$SERVICE_SRC" /etc/systemd/system/qcode-peer.service
systemctl daemon-reload
systemctl enable qcode-peer.service
systemctl restart qcode-peer.service
sleep 2
systemctl --no-pager status qcode-peer.service | head -25

echo
echo "installed. useful commands:"
echo "  sudo systemctl status qcode-peer       # check running"
echo "  sudo systemctl stop qcode-peer         # stop"
echo "  sudo systemctl start qcode-peer        # start"
echo "  sudo systemctl restart qcode-peer      # reboot service"
echo "  tail -f /home/tom/qcode-peer/peer-provider.log   # live logs"
