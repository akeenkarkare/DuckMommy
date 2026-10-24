#!/usr/bin/env bash
# Download every model duck.py uses (they're gitignored). Run once on the Pi.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models

./posture/get_model.sh lite
curl -fL -o models/holistic_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task"
curl -fL -o models/yamnet.tflite \
  "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite"
echo "models ready"
