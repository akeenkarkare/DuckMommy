#!/usr/bin/env bash
# Download every model duck.py uses (they're gitignored). Run once on the Pi.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models

./posture/get_model.sh lite
curl -fL -o models/hand_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
curl -fL -o models/yamnet.tflite \
  "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite"
echo "models ready"
