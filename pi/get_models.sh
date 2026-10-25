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
# "hey duck" wake word (pi/memory): Vosk small English model, ~40 MB
if [ ! -d models/vosk-small-en ]; then
  curl -fL -o /tmp/vosk-small-en.zip https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
  unzip -q /tmp/vosk-small-en.zip -d models && mv models/vosk-model-small-en-us-0.15 models/vosk-small-en
  rm /tmp/vosk-small-en.zip
fi
echo "models ready"
