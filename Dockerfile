# Railway service: sync-toast-86-attribution cron
#
# History: this file USED to be a Python+Playwright Dockerfile (apt-get
# install Chromium fonts, pip install requirements.txt, run scraper.py)
# but `requirements.txt` and `scraper.py` were never actually in this
# repo — that Dockerfile got pasted in from the dd-mau-labor-scraper
# repo by accident (commit 3df603e). It went unnoticed because nothing
# in dd-mau-portal's deploy path uses Docker:
#   • Frontend deploys via GitHub Actions → GitHub Pages (Vite build)
#   • Cloud Functions deploy via `firebase deploy` (Node, no Docker)
# So the broken Dockerfile sat there harmlessly for months — until we
# added a Railway service from this repo, and Railway picked it up and
# tried to build a Python+Chromium container around a Node script. The
# build failed at apt-get because the container process died before
# finishing the system installs. Andrew + Claude 2026-05-23.
#
# What this file IS now: a minimal Node 22 image for the Railway cron
# that runs scripts/sync-toast-86-attribution.mjs every 5 minutes. The
# script makes HTTPS calls to Toast's API and writes attribution data
# to Firestore. No graphics deps, no Playwright, no Python.

FROM node:22-slim

WORKDIR /app

# Install dependencies FIRST (separate from copying source) so Docker's
# layer cache reuses the npm install layer on subsequent code changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy only what the script needs. Keeps the image small and avoids
# shipping the full Vite frontend, Firebase Functions, etc.
COPY scripts/sync-toast-86-attribution.mjs ./scripts/

# Run the script. Exits when done; Railway shows "deployment success"
# and the service goes idle until the next cron trigger fires.
CMD ["node", "scripts/sync-toast-86-attribution.mjs"]
