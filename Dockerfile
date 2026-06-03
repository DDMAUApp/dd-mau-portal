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
#
# Note: we DON'T pass --omit=dev. firebase-admin is in devDependencies
# in this repo (it's only used by admin scripts + Firebase Functions,
# not by the Vite frontend), and the sync-toast-86-attribution.mjs
# script imports it. Installing devDeps in the cron container is fine —
# the image is throwaway and we don't ship it anywhere.
#
# 2026-06-02 — Andrew "look at safari": Railway deploys started failing
# after we added @capacitor-firebase/messaging (firebase v12 peer dep
# vs our firebase v10). The repo root .npmrc has legacy-peer-deps=true
# which fixes both `npm ci` and `npm install` everywhere ELSE — but
# the previous COPY line only copied package.json and package-lock.json
# into the Docker build context, so npm install in here ran without the
# .npmrc flag and rejected the peer-dep conflict. Adding .npmrc to the
# COPY makes the Docker build behave the same as the GitHub Actions
# build and the local install.
COPY package.json package-lock.json* .npmrc ./
RUN npm install --no-audit --no-fund

# Copy only what the script needs. Keeps the image small and avoids
# shipping the full Vite frontend, Firebase Functions, etc.
COPY scripts/sync-toast-86-attribution.mjs ./scripts/

# Run the script. Exits when done; Railway shows "deployment success"
# and the service goes idle until the next cron trigger fires.
CMD ["node", "scripts/sync-toast-86-attribution.mjs"]
