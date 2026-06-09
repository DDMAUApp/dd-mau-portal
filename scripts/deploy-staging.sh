#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Staging deploy — preview a bundle on ONE phone before it reaches all staff.
#
#   npm run deploy:staging
#
# Builds the current code and uploads it to the **dev** channel ONLY. Staff
# phones follow the **production** channel, so a staging bundle CANNOT reach
# them — it's a safe preview lane.
#
# One-time setup: point your own test phone at the `dev` channel
#   console.capgo.app → com.ddmau.staff → Devices → (your device) → channel = dev
#
# Day-to-day flow:
#   1. commit your change
#   2. npm run deploy:staging      ← lands on your dev-channel phone only
#   3. looks good?  →  npm run deploy        (ships the SAME committed code to everyone)
#   4. shipped something bad?  →  npm run rollback <previous-version>
#
# This bumps NOTHING in git and never touches production.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${CAPGO_TOKEN:-}" ]; then
  echo "⚠ CAPGO_TOKEN not set — see DEPLOY.md (§ One-time setup). Aborting; nothing uploaded."
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
STAMP="$(date +%s)"
# Unique, valid-semver prerelease tag: e.g. 1.0.32-staging.8de021c.1717900000
# (encodes the commit so you can tell what's on dev; timestamp keeps re-runs unique).
STAGING_VERSION="${VERSION}-staging.${SHA}.${STAMP}"

echo "▸ Building…"
npm run build

echo "▸ Uploading $STAGING_VERSION to the 'dev' (staging) channel…"
# Same invocation as the production deploy, just a different channel — the
# CLI infers appId (com.ddmau.staff) + path (dist) from capacitor.config.
npx @capgo/cli@latest bundle upload --apikey "$CAPGO_TOKEN" --channel dev --bundle "$STAGING_VERSION"

echo "  ✓ Staged on 'dev' as $STAGING_VERSION."
echo "    Open the app on your dev-channel phone to test it."
echo "    Good? → ship the same committed code to everyone:  npm run deploy"
