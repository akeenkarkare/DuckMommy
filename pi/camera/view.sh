#!/usr/bin/env bash
# Run on the laptop (needs ffmpeg/ffplay: `brew install ffmpeg` on macOS).
# Usage: ./view.sh [port]
# Start this BEFORE stream.sh on the Pi. Ctrl+C to stop.
set -euo pipefail

PORT="${1:-5000}"

# nobuffer/low_delay/framedrop: keep only the latest frame, drop late ones.
exec ffplay -fflags nobuffer \
  -flags low_delay \
  -framedrop \
  -probesize 32 \
  -analyzeduration 0 \
  -sync ext \
  -f mjpeg \
  "udp://0.0.0.0:${PORT}?fifo_size=65536&overrun_nonfatal=1"
