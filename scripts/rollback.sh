#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Rollback — the kill-switch. Repoint the PRODUCTION OTA channel back to a
# previous, known-good bundle. Every staff phone reverts on its next open.
#
#   npm run rollback              → shows what production serves now + the
#                                   recent versions, then tells you the command
#   npm run rollback 1.0.31       → roll production back to 1.0.31
#
# It only re-points `production` at the version you name. It does NOT delete
# bundles and does NOT change any other channel setting. Fully reversible:
# roll forward the same way, or just `npm run deploy` a new fix.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
APP="com.ddmau.staff"

if [ -z "${CAPGO_TOKEN:-}" ]; then
  echo "⚠ CAPGO_TOKEN not set — see DEPLOY.md (§ One-time setup). Aborting; nothing changed."
  exit 1
fi

echo "▸ Production is currently serving:"
npx @capgo/cli@latest channel currentBundle production "$APP" --apikey "$CAPGO_TOKEN" 2>&1 | grep -i "current bundle" || true

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo
  echo "▸ Recent bundles you can roll back to (newest first):"
  npx @capgo/cli@latest bundle list "$APP" --apikey "$CAPGO_TOKEN" 2>&1 | tail -30
  echo
  echo "Then run:   npm run rollback <version>     e.g.  npm run rollback 1.0.31"
  exit 0
fi

echo
printf "Roll PRODUCTION back to %s for ALL staff phones? [y/N] " "$TARGET"
read -r ok
case "$ok" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "Aborted — nothing changed."; exit 0 ;;
esac

# --state default re-asserts production as the default channel (it already is;
# this is idempotent). Only the bundle pointer changes.
npx @capgo/cli@latest channel set production "$APP" --bundle "$TARGET" --state default --apikey "$CAPGO_TOKEN"
echo "✅ Production now serves $TARGET — phones revert on next open. (Roll forward with: npm run rollback <newer>, or npm run deploy.)"
