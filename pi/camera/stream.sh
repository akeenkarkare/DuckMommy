#!/usr/bin/env bash
# Run on the Raspberry Pi: stream the camera to a laptop for live preview.
# Usage: ./stream.sh [--night] [--noir] <laptop-ip> [port]
#   --night  low light: 15 fps (longer exposure), black & white, stronger denoise
#   --noir   camera has no IR filter: use the sensor's NoIR tuning (fixes pink daylight colour)
# Start view.sh on the laptop FIRST, then run this. Ctrl+C to stop.
set -euo pipefail

NIGHT=0 NOIR=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --night) NIGHT=1 ;;
    --noir)  NOIR=1 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

LAPTOP_IP="${1:?usage: ./stream.sh [--night] [--noir] <laptop-ip> [port]}"
PORT="${2:-5000}"

FPS=30
EXTRA=()
if (( NIGHT )); then
  # At 15 fps each frame can expose for up to ~66 ms instead of ~33 ms.
  # IR light carries no colour, so saturation 0 drops the pink cast and chroma noise.
  FPS=15
  EXTRA+=(--saturation 0 --denoise cdn_hq)
fi

if (( NOIR )); then
  # e.g. "0 : imx708_wide_noir [4608x2592 ...]" -> imx708_wide_noir
  MODEL="$(rpicam-hello --list-cameras 2>/dev/null | sed -nE 's/^[[:space:]]*0 : ([a-z0-9_]+).*/\1/p')"
  if [[ "$MODEL" == *noir* ]]; then
    echo "camera reports $MODEL: NoIR tuning is already used automatically" >&2
  else
    TUNING="$(ls /usr/share/libcamera/ipa/rpi/*/"${MODEL}_noir.json" 2>/dev/null | head -1 || true)"
    if [[ -n "$TUNING" ]]; then
      echo "using NoIR tuning $TUNING" >&2
      EXTRA+=(--tuning-file "$TUNING")
    else
      echo "no NoIR tuning file for '${MODEL:-unknown}', using the default" >&2
    fi
  fi
fi

# MJPEG = every frame is an independent JPEG, so the viewer can show the
# newest frame without waiting on neighbours (H.264 gave up to ~8 s of lag).
exec rpicam-vid -t 0 --nopreview \
  --width 640 --height 480 \
  --framerate "$FPS" \
  --codec mjpeg \
  --quality 60 \
  "${EXTRA[@]}" \
  -o "udp://${LAPTOP_IP}:${PORT}"
