#!/bin/bash
# Sign the packaged app with the stable self-signed "POS Dev" identity, inside-out:
# frameworks → helper apps → outer bundle. `codesign --deep` on the whole bundle is the
# obvious one-liner and it FAILS on Electron's nested helper apps (tried 2026-08-25, died
# in "POS Helper (Plugin).app" and left the outer bundle adhoc) — which is exactly why
# electron-builder signs components explicitly. Signature STABILITY across rebuilds is all
# macOS TCC needs to keep Full Disk Access / Automation grants; Apple-chain trust is not
# the goal (self-signed reads NOT_TRUSTED forever, and that is fine for a local app).
set -e
ID="POS Dev"
APP="$(cd "$(dirname "$0")/.." && pwd)/release/mac-arm64/POS.app"

for fw in "$APP/Contents/Frameworks/"*.framework; do
  [ -e "$fw" ] && codesign --force --deep --sign "$ID" "$fw"
done
for helper in "$APP/Contents/Frameworks/"*.app; do
  [ -e "$helper" ] && codesign --force --deep --sign "$ID" "$helper"
done
codesign --force --sign "$ID" "$APP"

echo "--- result ---"
codesign -dv "$APP" 2>&1 | grep -E "Authority|Signature=|TeamIdentifier" | head -3
