#!/usr/bin/env bash
# Run on the Raspberry Pi: stream the camera to a laptop for live preview.
# Usage: ./stream.sh <laptop-ip> [port]
# Start view.sh on the laptop FIRST, then run this. Ctrl+C to stop.
set -euo pipefail

LAPTOP_IP="${1:?usage: ./stream.sh <laptop-ip> [port]}"
PORT="${2:-5000}"

# MJPEG = every frame is an independent JPEG, so the viewer can show the
# newest frame without waiting on neighbours (H.264 gave up to ~8 s of lag).
exec rpicam-vid -t 0 --nopreview \
  --width 640 --height 480 \
  --framerate 30 \
  --codec mjpeg \
  --quality 60 \
  -o "udp://${LAPTOP_IP}:${PORT}"
