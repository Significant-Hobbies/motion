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
pnpm --filter motion-web run build

echo "→ syncing dist → $DEST"
mkdir -p "$DEST"
rsync -a --exclude '*.map' "$ROOT/web/dist/" "$DEST/"

echo "✓ webgame bundled ($(find "$DEST" -type f | wc -l | tr -d ' ') files). Rebuild the iOS app to pick it up."
