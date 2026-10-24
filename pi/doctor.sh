#!/usr/bin/env bash
# Why won't the camera start? Run from pi/:  ./doctor.sh
# Checks the usual suspects in order and prints the fix for each failure.
cd "$(dirname "$0")"
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n       fix: %s\n' "$1" "$2"; FAILS=$((FAILS+1)); }
warn() { printf '  \033[33mNOTE\033[0m %s\n' "$1"; }
FAILS=0
ON_PI=0; [[ -f /proc/device-tree/model ]] && grep -qi raspberry /proc/device-tree/model && ON_PI=1

echo "== machine"
if (( ON_PI )); then ok "$(tr -d '\0' < /proc/device-tree/model)"; else
  warn "not a Pi: use --source 0 (webcam). On a Mac, allow Camera for Terminal/VS Code in"
  warn "System Settings > Privacy & Security > Camera, then restart the terminal."
fi

if (( ON_PI )); then
  echo "== camera hardware"
  if cams="$(rpicam-hello --list-cameras 2>&1)" && grep -q '^[[:space:]]*0 :' <<<"$cams"; then
    ok "camera detected: $(grep -m1 '^[[:space:]]*0 :' <<<"$cams" | sed 's/^[[:space:]]*//' | cut -c1-60)"
  else
    bad "no camera detected" "power off, reseat the ribbon (Pi 5 needs the 22-pin end, contacts facing the right way), boot again"
  fi

  echo "== camera busy?"
  busy="$(pgrep -af 'rpicam|libcamera|duck\.py|posture/run\.py|sentry/run\.py|asl/run\.py|run\.py' | grep -v doctor || true)"
  if [[ -n "$busy" ]]; then
    bad "something already has the camera (only one program can):" "stop it (Ctrl+C in its terminal, or: pkill -f rpicam; pkill -f duck.py; pkill -f run.py)"
    sed 's/^/         /' <<<"$busy"
  else ok "camera is free"; fi
fi

echo "== python environment"
if [[ -z "${VIRTUAL_ENV:-}" ]]; then
  if [[ -d .venv ]]; then bad "venv not active" "source .venv/bin/activate"
  else bad "no venv in pi/" "python3 -m venv --system-site-packages .venv && source .venv/bin/activate && pip install mediapipe websockets"; fi
else
  ok "venv active: $VIRTUAL_ENV"
  if (( ON_PI )) && ! grep -q 'include-system-site-packages = true' "$VIRTUAL_ENV/pyvenv.cfg" 2>/dev/null; then
    bad "venv can't see the Pi's camera library" "rm -rf .venv && python3 -m venv --system-site-packages .venv && source .venv/bin/activate && pip install mediapipe websockets"
  fi
fi

mp="$(python3 -c 'import mediapipe as m; print(m.__version__)' 2>&1 | tail -1)"
if [[ "$mp" =~ ^[0-9] ]]; then
  if python3 -c 'from mediapipe.tasks.python import vision; vision.HolisticLandmarker' 2>/dev/null; then ok "mediapipe $mp"
  elif [[ -s models/holistic_landmarker.task ]]; then
    bad "mediapipe $mp is too old: duck.py will crash loading the Holistic model, before the camera starts" "pip install -U mediapipe   (or run duck.py --no-sign)"
  else warn "mediapipe $mp has no Holistic (fine until models/holistic_landmarker.task exists; then pip install -U mediapipe)"; fi
else bad "mediapipe won't import: $mp" "pip install mediapipe"; fi

if (( ON_PI )); then
  pc="$(python3 -c 'import picamera2, libcamera; print("ok")' 2>&1 | tail -1)"
  if [[ "$pc" == ok ]]; then ok "picamera2 imports"
  elif [[ "$pc" == *numpy* || "$pc" == *"dtype size"* || "$pc" == *"binary incompat"* ]]; then
    bad "picamera2 clashes with pip's numpy: $pc" "pip uninstall -y numpy   (uses the Pi's own numpy)"
  else bad "picamera2 won't import: $pc" "sudo apt install -y python3-picamera2, and make sure the venv has --system-site-packages"; fi
fi

echo "== models"
[[ -s posture/pose_landmarker_lite.task ]] && ok "posture model" || bad "posture/pose_landmarker_lite.task missing" "./get_models.sh"
[[ -s models/holistic_landmarker.task ]] && ok "holistic model (signs)" || warn "models/holistic_landmarker.task missing: duck.py runs without Sign to Duck (./get_models.sh)"
[[ -s models/yamnet.tflite ]] && ok "yamnet model (sound alerts)" || warn "models/yamnet.tflite missing: sound alerts off (./get_models.sh)"

echo "== .env"
if [[ -f .env ]]; then
  ok ".env exists"
  if (( ! ON_PI )) && grep -Eq '^(PRESS_PIN|LED_PIN|ULTRASONIC_TRIG|ULTRASONIC_ECHO)=[0-9]' .env; then
    bad "GPIO pins are set but this isn't a Pi" "blank PRESS_PIN / LED_PIN / ULTRASONIC_* in .env on laptops"
  fi
else warn "no .env: runs offline (no relay). cp .env.example .env and fill it in"; fi

echo
if (( FAILS )); then echo "$FAILS problem(s) above. Fix them top to bottom, then run ./doctor.sh again."
else echo "All clear. Start with: python3 duck.py$( (( ON_PI )) || echo ' --source 0')"; fi
