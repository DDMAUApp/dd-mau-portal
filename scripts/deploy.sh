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

# 3) Commit the version bump + ALL working-tree changes + push → GitHub Pages
#    rebuilds & deploys the web app (and the Pi menu TVs, which load it).
#
#    ⚠ CRITICAL (2026-07-14 fix): the WEB app is rebuilt by GitHub Pages from
#    the COMMITTED source on main — NOT from the local `dist/` built in step 2.
#    The old script committed ONLY package.json/package-lock.json, so any
#    uncommitted source changes were silently DROPPED from the web build: the
#    version bumped, OTA (which uploads the local dist) got the code, but the
#    web bundle was rebuilt from stale committed source WITHOUT the changes.
#    That is exactly the recurring "my changes aren't showing on the web app"
#    bug. Fix: stage the ENTIRE working tree so the release commit carries the
#    source it just built. `git add -A` respects .gitignore (dist/, node_modules
#    stay out). If there is genuinely nothing to commit beyond the version bump
#    (a no-op re-deploy), --allow-empty keeps the push flowing.
echo "▸ Pushing web (GitHub Pages)…"
git add -A
echo "  Shipping these files in v$VERSION:"
git diff --cached --name-only | sed 's/^/    • /'
git commit --allow-empty -m "Release v$VERSION" >/dev/null
git push origin main
# Guard: the web build is only as fresh as what we just committed+pushed. If
# the working tree is somehow STILL dirty after the commit (e.g. a file changed
# mid-deploy), warn loudly — the web bundle would miss it.
if [ -n "$(git status --porcelain)" ]; then
  echo "  ⚠ Working tree still dirty AFTER the release commit — these files did NOT ship to web:" >&2
  git status --porcelain | sed 's/^/      /' >&2
fi
echo "  ✓ Web pushed — live in ~1-2 min."

# 4) Upload the OTA bundle → iOS + Android apps pull it on their next open.
echo "▸ Pushing OTA to iOS + Android (Capgo)…"
# The token usually lives in ~/.zprofile, but `npm run deploy` spawns a NON-login
# shell that never sources it — so CAPGO_TOKEN was often unset HERE and the OTA
# step skipped SILENTLY (web shipped, phones did NOT, and it exited 0 = "success").
# Pull it from the profile files as a fallback, then FAIL LOUD if truly missing so
# a half-shipped release can never masquerade as a full one.
if [ -z "${CAPGO_TOKEN:-}" ]; then
  set +e   # a missing profile file must not abort the deploy under `set -e`
  CAPGO_TOKEN="$(sed -n 's/^[[:space:]]*export CAPGO_TOKEN=//p' ~/.zprofile ~/.zshrc ~/.bash_profile 2>/dev/null | tr -d "\"'" | head -1)"
  set -e
fi
if [ -z "${CAPGO_TOKEN:-}" ]; then
  echo "  ✗ CAPGO_TOKEN not set — the phone-app OTA did NOT ship (the web IS live)." >&2
  echo "    Fix: add 'export CAPGO_TOKEN=<your key>' to ~/.zprofile, then re-run this deploy." >&2
  echo "    Or ship the OTA for THIS release manually:" >&2
  echo "      npx @capgo/cli@latest bundle upload --apikey <key> --channel '$CHANNEL' --bundle '$VERSION'" >&2
  exit 1
fi
npx @capgo/cli@latest bundle upload --apikey "$CAPGO_TOKEN" --channel "$CHANNEL" --bundle "$VERSION"
echo "  ✓ OTA v$VERSION uploaded to channel '$CHANNEL' — open phones apply it via the broadcast below."

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

# 6) Auto-refresh broadcast (2026-07-11 — Andrew: "no more manually
#    pressing refresh"). Wait until GitHub Pages actually serves THIS
#    build (clients verify too, but broadcasting after propagation means
#    even devices on pre-broadcast-aware bundles reload into the new
#    version), then flip /config/forceRefresh. Every open phone, browser,
#    and TV updates itself within seconds; closed devices update on next
#    open as before. The Danger Zone button remains as a manual backup.
echo "▸ Waiting for web propagation, then broadcasting auto-refresh…"
PROPAGATED=""
WAIT_DEADLINE=$((SECONDS + 240))
while [ $SECONDS -lt $WAIT_DEADLINE ]; do
  SERVED="$(curl -fsS --max-time 10 "https://app.ddmaustl.com/version.json?t=$(date +%s)" 2>/dev/null || true)"
  case "$SERVED" in
    *"$SHA"*) PROPAGATED="yes"; break ;;
  esac
  sleep 10
done
if [ -n "$PROPAGATED" ]; then
  # Shaped client-style write (rules require triggeredBy string +
  # triggeredAt == request.time, satisfied via the REQUEST_TIME
  # transform). The apiKey is the public client key from src/firebase.js.
  FS_API_KEY="$(grep -o 'apiKey: *"[^"]*"' src/firebase.js | cut -d'"' -f2)"
  BROADCAST_BODY='{"writes":[{"update":{"name":"projects/dd-mau-staff-app/databases/(default)/documents/config/forceRefresh","fields":{"triggeredBy":{"stringValue":"auto-deploy v'"$VERSION"'"},"version":{"stringValue":"'"$VERSION"'"}}},"updateTransforms":[{"fieldPath":"triggeredAt","setToServerValue":"REQUEST_TIME"}]}]}'
  if curl -fsS --max-time 20 -X POST \
       "https://firestore.googleapis.com/v1/projects/dd-mau-staff-app/databases/(default)/documents:commit?key=$FS_API_KEY" \
       -H 'Content-Type: application/json' -d "$BROADCAST_BODY" -o /dev/null; then
    echo "  ✓ Auto-refresh broadcast sent — every open device is updating to v$VERSION now."
  else
    echo "  ⚠ Broadcast write failed — press 🚨 System Refresh in Admin → Danger Zone to push it manually."
  fi
else
  echo "  ⚠ Web didn't propagate within 4 min — broadcast skipped so devices can't reload onto the OLD build."
  echo "    Once https://app.ddmaustl.com/version.json shows $SHA, press 🚨 System Refresh in Admin → Danger Zone."
fi

echo "✅ Deploy complete — web live, all open devices auto-updating; apps on v$VERSION."
