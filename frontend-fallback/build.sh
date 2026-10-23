#!/usr/bin/env bash
# Build the dependency-free fallback UI into the daemon's embedded dist dir.
#
# This is the OFFLINE-demoable UI. It uses the globally available `tsc` only
# (no npm install, no bundler, DOM lib only). It compiles the vanilla TypeScript
# in src/ to ES2020 modules and copies the static assets (index.html, styles.css)
# so the Go daemon can //go:embed daemon/web/dist and serve the whole slice.
#
# Usage: frontend-fallback/build.sh   (run from anywhere)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/../daemon/web/dist"

echo "==> compiling fallback UI with tsc"
tsc -p "$HERE/tsconfig.json"

echo "==> copying static assets into $DIST"
mkdir -p "$DIST"
cp "$HERE/public/index.html" "$DIST/index.html"
cp "$HERE/public/styles.css" "$DIST/styles.css"

echo "==> done. built files in $DIST:"
ls -1 "$DIST"
