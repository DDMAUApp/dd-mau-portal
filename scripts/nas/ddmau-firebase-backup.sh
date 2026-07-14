#!/bin/bash
# ddmau-firebase-backup.sh — cron wrapper for the NAS Firebase backup.
# Installed on ddmau-nas as /usr/local/sbin/ddmau-firebase-backup.sh
# Cron (12:45am Central, before the 3:15am USB rsync in ddmau-backup.sh):
#   45 0 * * *  root  CRON_TZ=America/Chicago /usr/local/sbin/ddmau-firebase-backup.sh
#
# Layout on the NAS:
#   /usr/local/lib/ddmau/ddmau-nas-backup.mjs     (this repo's script)
#   /usr/local/lib/ddmau/node_modules/            (firebase-admin, installed once)
#   /etc/ddmau/firebase-service-account.json      (chmod 600, root only)
#   /cloud/backups/firebase/                       (output — rides the USB rsync)
#   /var/log/ddmau-firebase-backup.log             (this log)
set -euo pipefail

export BACKUP_ROOT="${BACKUP_ROOT:-/cloud/backups/firebase}"
export GOOGLE_APPLICATION_CREDENTIALS="${GOOGLE_APPLICATION_CREDENTIALS:-/etc/ddmau/firebase-service-account.json}"
LIB=/usr/local/lib/ddmau
LOG=/var/log/ddmau-firebase-backup.log
NODE="$(command -v node || echo /usr/bin/node)"

{
  echo "==================================================================="
  echo "START $(date -u +%FT%TZ)"
  # Only run if the /cloud shared folder is actually mounted (rootfs share).
  if [ ! -d "$BACKUP_ROOT" ] && ! mkdir -p "$BACKUP_ROOT" 2>/dev/null; then
    echo "FATAL: cannot create $BACKUP_ROOT — is /cloud mounted?"; exit 1
  fi
  cd "$LIB"
  "$NODE" "$LIB/ddmau-nas-backup.mjs"
  code=$?
  echo "END   $(date -u +%FT%TZ) exit=$code"
  exit $code
} >> "$LOG" 2>&1
