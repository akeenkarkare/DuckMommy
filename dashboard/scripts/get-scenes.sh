#!/usr/bin/env bash
# Download the background panoramas (CC0, polyhaven.com) into public/scenes. Gitignored; run once.
set -euo pipefail
cd "$(dirname "$0")/../public/scenes"
for id in pool secluded_beach white_cliff_top lakeside; do
  [ -f "${id}_2k.hdr" ] || curl -fL -o "${id}_2k.hdr" "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/2k/${id}_2k.hdr"
  [ -f "${id}.jpg" ] || curl -fL -o "${id}.jpg" "https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=240&height=120&format=jpg"
done
echo "scenes ready"
