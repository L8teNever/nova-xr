#!/usr/bin/env bash
# Fallback only: skip when DEST already exists (repo ships the GLB).
set -euo pipefail
DEST="${1:-frontend/assets/models/character.glb}"
URL="https://grab3d.com/dl/woman-rigged/woman-rigged.glb"

if [ -s "$DEST" ]; then
  echo "Using existing $DEST ($(wc -c < "$DEST") bytes); skip fetch"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
tmp="${DEST}.part"
curl -4 -fL --retry 5 --retry-delay 2 --max-time 120 \
  -A "Mozilla/5.0" \
  -o "$tmp" \
  "$URL"
mv "$tmp" "$DEST"
echo "Wrote $DEST ($(wc -c < "$DEST") bytes)"
