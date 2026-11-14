#!/bin/sh
# Image build step: compile the warm-up documents with network access so the Tectonic cache is filled.
# Run as: warm.sh <assets-dir> <min-cache-MB>. Every warmup/*.tex is compiled. Needs TECTONIC_CACHE_DIR. Any failure stops the build (set -e, no `|| true`).
set -eu
assets="$1"; min_mb="$2"
here="$(cd "$(dirname "$0")" && pwd)"
bundle="${TECTONIC_BUNDLE:-https://relay.fullyjustified.net/default_bundle_v33.tar}"
work="$(mktemp -d)"; mkdir -p "$work/out"
cp -r "$assets"/. "$work"/
cp "$here"/*.tex "$work"/
cd "$work"
for f in "$here"/*.tex; do
  doc="$(basename "$f" .tex)"
  tectonic -X compile "$doc.tex" --untrusted --bundle "$bundle" --outdir out
  test -s "out/$doc.pdf"
done
# Second pass with the run-time flags: proves nothing is missing from the cache.
for f in "$here"/*.tex; do
  doc="$(basename "$f" .tex)"
  tectonic -X compile "$doc.tex" --untrusted --only-cached --bundle "$bundle" --outdir out
done
size="$(du -sm "$TECTONIC_CACHE_DIR" | cut -f1)"
echo "tectonic cache: ${size} MB (minimum ${min_mb} MB)"
if [ "$size" -lt "$min_mb" ]; then echo "cache is smaller than ${min_mb} MB: the warm-up did not fill it" >&2; exit 1; fi
rm -rf "$work"
