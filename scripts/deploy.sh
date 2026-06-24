#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# One-command deploy → all platforms.
#
#   npm run deploy
#
# Ships the CURRENTLY COMMITTED code to:
#   • WEB  (app.ddmaustl.com via GitHub Pages)  — also what the Pi TVs load
#   • iOS + Android apps  (via Capgo OTA — JS/UI changes only, no store review)
#
# JS / UI / feature / fix changes ride OTA to the phones automatically.
# NATIVE changes (a new Capacitor plugin, a permission, the app icon) still
# need a rebuild + store update — those are the only times you touch the stores.
#
# One-time setup for the phone-app (OTA) step — see DEPLOY.md:
#   1. export CAPGO_TOKEN=<your Capgo API key>   (add to ~/.zprofile to persist)
#   2. In console.capgo.app: create a channel named "production", mark it
#      DEFAULT, and enable "Allow self-assign / self-set". Fixes the no_channel
#      error so devices know which bundle stream to follow.
#
# Commit your changes FIRST, then run this. It ships what's committed.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

CHANNEL="${CAPGO_CHANNEL:-production}"

# 1) Bump the patch version so the OTA bundle is NEWER than what's on phones
#    (Capgo only serves a bundle that's newer than the installed one).
npm version patch --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
echo "▸ Releasing v$VERSION"

# 2) Build the web bundle.
echo "▸ Building…"
npm run build

# 3) Commit the version bump + push → GitHub Pages builds & deploys the web app
#    (and the Pi menu TVs, which load the web app).
echo "▸ Pushing web (GitHub Pages)…"
# Commit the lockfile too — `npm version patch` bumps the version field in BOTH
# package.json and package-lock.json, but only staging package.json left the
# lock's version field drifting (cosmetic, but it kept showing as a dirty file
# every release). Harmless either way; keeps the tree clean.
git add package.json package-lock.json
git commit -m "Release v$VERSION" >/dev/null
git push origin main
echo "  ✓ Web pushed — live in ~1-2 min."

# 4) Upload the OTA bundle → iOS + Android apps pull it on their next open.
echo "▸ Pushing OTA to iOS + Android (Capgo)…"
if [ -z "${CAPGO_TOKEN:-}" ]; then
  echo "  ⚠ CAPGO_TOKEN not set — skipped the phone-app OTA (web still shipped)."
  echo "    One-time: export CAPGO_TOKEN=<your key>  +  set channel '$CHANNEL' DEFAULT in console.capgo.app (see DEPLOY.md)."
  exit 0
fi
npx @capgo/cli@latest bundle upload --apikey "$CAPGO_TOKEN" --channel "$CHANNEL" --bundle "$VERSION"
echo "  ✓ OTA v$VERSION uploaded to channel '$CHANNEL' — phones update on next open."

# 5) Post-deploy verification (Debug/QA automation). Calls the read-only
#    healthCheck Cloud Function, which records the deploy to /deploys + runs
#    site/Firestore liveness checks → /health_checks. NON-FATAL: the deploy
#    already shipped above; this just records + flags. Web version propagation
#    (GitHub Pages, ~1-2 min) is verified separately by the scheduled check, so
#    a brief version mismatch here is expected and informational only.
SHA="$(git rev-parse --short HEAD)"
HC_URL="https://us-central1-dd-mau-staff-app.cloudfunctions.net/healthCheck?version=$VERSION&sha=$SHA&trigger=deploy"
echo "▸ Recording deploy + health check…"
if curl -fsS --max-time 30 "$HC_URL" -o /tmp/dd_healthcheck.json 2>/dev/null; then
  if grep -q '"ok":true' /tmp/dd_healthcheck.json; then
    echo "  ✓ Site + Firestore reachable; deploy recorded (v$VERSION)."
  else
    echo "  ⚠ Health check flagged a failure — see the Debug dashboard:"
    cat /tmp/dd_healthcheck.json; echo
  fi
else
  echo "  ⚠ Health check endpoint unreachable (deploy still shipped; the scheduled check will catch up)."
fi

echo "✅ Deploy complete — web live; apps on v$VERSION."
