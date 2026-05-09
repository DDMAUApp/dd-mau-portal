#!/bin/bash
# Double-click me from Finder to back up everything: pull latest code
# from GitHub AND export the Firestore database to a local JSON file
# in the backups/ folder.
#
# This file lives at the root of the dd-mau-portal repo. You can drag
# it to your Desktop (or anywhere) and double-click from there — the
# PROJECT_DIR below tells it where the actual project lives.
#
# IF YOU EVER MOVE THE PROJECT FOLDER, edit PROJECT_DIR below.

PROJECT_DIR="$HOME/Documents/Claude/Projects/DD Mau Training/dd-mau-portal"

clear
echo "═══════════════════════════════════════════════════════════"
echo "  DD Mau Portal — One-Click Backup"
echo "═══════════════════════════════════════════════════════════"
echo ""

cd "$PROJECT_DIR" 2>/dev/null || {
    echo "❌ Could not find the project folder at:"
    echo "   $PROJECT_DIR"
    echo ""
    echo "Fix: open Backup.command in TextEdit and update the"
    echo "PROJECT_DIR line at the top to point to wherever you"
    echo "moved the dd-mau-portal folder."
    echo ""
    read -p "Press Enter to close this window..."
    exit 1
}

# Run the backup. This calls git pull + Firestore export.
npm run backup-all
EXIT_CODE=$?

echo ""
echo "═══════════════════════════════════════════════════════════"
if [ $EXIT_CODE -eq 0 ]; then
    echo "  ✅ Done. New backup is in: backups/"
    echo "  Move that file to Dropbox/Drive/external for safety."
else
    echo "  ❌ Backup failed. Scroll up to see the error."
fi
echo "═══════════════════════════════════════════════════════════"
echo ""
read -p "Press Enter to close this window..."
