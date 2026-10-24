#!/usr/bin/env bash
# Download a MediaPipe pose model into this folder. Usage: ./get_model.sh [lite|full|heavy]
# lite is the default for the Pi 5; try full if landmarks jitter.
set -euo pipefail
v="${1:-lite}"
cd "$(dirname "$0")"
curl -fL -o "pose_landmarker_${v}.task" \
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/latest/pose_landmarker_${v}.task"
echo "saved pose_landmarker_${v}.task"
