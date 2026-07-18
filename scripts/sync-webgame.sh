#!/usr/bin/env bash
# Build the web game and copy it into the iOS app bundle resources, so the app is
# self-contained (the "pure app" finish — no Vite dev server / Mac needed on device).
#
# The web build uses a relative base (see web/vite.config.ts) so the bundle loads
# correctly from a file:// URL inside the WKWebView. GameConfig auto-prefers this
# bundle when present (falling back to the dev server when it's absent).
#
# Run from the repo root:  ./scripts/sync-webgame.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/ios/Resources/webgame"

echo "→ building web game…"
npm --workspace web run build

echo "→ syncing dist → $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$ROOT/web/dist/." "$DEST/"
# Sourcemaps aren't needed in the shipped app — drop them to keep the bundle lean.
find "$DEST" -name '*.map' -delete

echo "✓ webgame bundled ($(find "$DEST" -type f | wc -l | tr -d ' ') files). Rebuild the iOS app to pick it up."
