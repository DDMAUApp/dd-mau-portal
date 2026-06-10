#!/bin/bash
# DD Mau TV kiosk launcher — survives Wi-Fi races and browser crashes.
# 2026-06-10. Replaces launching chromium directly from the .desktop.
URL="https://app.ddmaustl.com/?tv=webster-photos"
# 1. After a power outage the Pi boots faster than the router. Do not
#    launch until the app is actually reachable, or the kiosk lands on
#    a "No internet" error page.
until curl -fsm 5 "https://app.ddmaustl.com/version.json" >/dev/null 2>&1; do
    sleep 3
done
# 2. Relaunch if Chromium ever exits/crashes — but bail out if it dies
#    within 30s (means the desktop session itself is going down; the
#    session restart will run this script again).
while true; do
    START=$(date +%s)
    /usr/bin/chromium --kiosk --force-device-scale-factor=2 --noerrdialogs --disable-infobars --password-store=basic --check-for-update-interval=31536000 "$URL"
    (( $(date +%s) - START < 30 )) && exit 0
    sleep 2
done
