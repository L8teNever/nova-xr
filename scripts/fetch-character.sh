#!/usr/bin/env bash
# Lädt die CC0-rigged GLB von Grab3D (öffentliches Asset, kein Betreiber-Host).
set -euo pipefail
DEST="${1:-frontend/assets/models/character.glb}"
URL="https://grab3d.com/dl/woman-rigged/woman-rigged.glb"
SIZE=13013836
CHUNK=1048576
mkdir -p "$(dirname "$DEST")"
tmp="${DEST}.part"
: > "$tmp"
offset=0
while [ "$offset" -lt "$SIZE" ]; do
  end=$((offset + CHUNK - 1))
  if [ "$end" -ge "$SIZE" ]; then
    end=$((SIZE - 1))
  fi
  curl -4 -fL --retry 5 --retry-delay 2 --max-time 60 \
    -A "Mozilla/5.0" \
    -H "Range: bytes=${offset}-${end}" \
    -o "${tmp}.chunk" \
    "$URL"
  cat "${tmp}.chunk" >> "$tmp"
  rm -f "${tmp}.chunk"
  offset=$((end + 1))
done
mv "$tmp" "$DEST"
echo "Wrote $DEST ($(wc -c < "$DEST") bytes)"
