#!/bin/sh
# Force HDMI full-range RGB output (Broadcast RGB = Full).
# In "Automatic" the Pi sends limited-range (16-235) for TV modes; the
# panel here reads it as full-range -> washed out / off colors.
# Runs before the display manager grabs DRM master; the compositor
# modeset inherits the connector property. 2026-06-10.
for i in $(seq 1 20); do
  [ -e /dev/dri/card1 ] && break
  sleep 0.5
done
ID=$(modetest -M vc4 -c 2>/dev/null | awk "/HDMI-A-1/ {print \$1; exit}")
[ -n "$ID" ] && modetest -M vc4 -w "$ID:Broadcast RGB:1" || true
