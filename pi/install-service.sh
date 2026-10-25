#!/usr/bin/env bash
# Make duck.py start on boot and restart itself if it crashes (systemd user service + lingering).
#   ./install-service.sh            install + start
#   systemctl --user restart duck   restart (after a git pull)     · stop: systemctl --user stop duck
#   systemctl --user disable --now duck    turn autostart off again
set -euo pipefail
cd "$(dirname "$0")"
PI_DIR="$(pwd)"
[ -x .venv/bin/python ] || { echo "No .venv here ($PI_DIR/.venv). Set up the Pi first (README.md)."; exit 1; }
mkdir -p ~/.config/systemd/user
sed "s|@PI_DIR@|$PI_DIR|g" duck.service > ~/.config/systemd/user/duck.service
# a duck started by hand would fight the service for the camera
pkill -f "^[^ ]*python[0-9.]* (duck|([a-z]+/)?run)\.py" || true
sleep 1
sudo loginctl enable-linger "$USER"   # user services run at boot, without anyone logged in
systemctl --user daemon-reload
systemctl --user enable --now duck
sleep 4
systemctl --user --no-pager --lines=0 status duck | head -4
echo "logs: tail -f ~/duck.log   ·   restart: systemctl --user restart duck"
