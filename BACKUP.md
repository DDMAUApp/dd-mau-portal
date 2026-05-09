# DD Mau Portal — Backup Guide

Two layers of backup. You should have both.

## Layer 1 — Code backup (already done, free, automatic)

Every time a change is committed to this repo, GitHub stores it forever.
Your local clone just needs `git pull` to refresh.

To get a current copy of the code on your laptop:

```
cd "~/Documents/Claude Projects/DD Mau Training/dd-mau-portal"
git pull
```

(Adjust the path to wherever your local copy actually lives.)

## Layer 2 — Data backup (the irreplaceable stuff)

Firestore holds all the live data: shifts, staff, training progress,
tardies, sauce log, schedules, time-off, checklists, vendor matches.
GitHub does NOT back this up. If the database disappeared, the code
would still work but every shift, every trained employee, every saved
PIN would be gone.

### One-time setup

1. Open the Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key" — downloads a `.json` file
3. Save it as `firebase-service-account.json` at the repo root
4. From the repo root, install dependencies: `npm install`

The key file is gitignored — it's a credential, **never commit it**.

### Run a backup

From the repo root:

```
npm run backup
```

This dumps every Firestore collection to `backups/firestore-YYYY-MM-DD-HHMMSS.json`.
The `backups/` folder is gitignored. Move the files to wherever you
keep long-term storage (Dropbox, Google Drive, external drive).

### One command for everything

```
npm run backup-all
```

Pulls the latest code from GitHub, then runs the Firestore backup.
Use this as your "weekly catch-up" command.

## Layer 3 — Cloud-side scheduled backups (optional, requires Blaze plan)

Firebase has built-in automatic backups separate from this script. If
you're on the Blaze plan:

1. Open Firebase Console → Firestore → Backups
2. Click "Configure backup schedule"
3. Set frequency (recommend daily) and retention (recommend 30 days)

This stores backups inside Firebase. One-click restore from the console.
Pairs well with the local script above — Firebase covers
"oops I deleted the wrong collection," local script covers
"the whole Firebase project is gone."

## What's NOT backed up (yet)

- **Photos in Firebase Storage** (checklist photos, etc.) — needs a
  separate backup story. Not critical (audit trail rather than
  business-critical data) but worth setting up later.
- **Toast order/invoice data** that's already in Firestore IS backed
  up, but the live source of truth is Toast itself; Toast keeps its
  own copy.
- **Railway scraper code** — separate repo, separate backup.
