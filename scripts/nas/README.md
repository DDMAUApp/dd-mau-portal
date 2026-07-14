# NAS Firebase backup (ddmau-nas)

Pulls the whole DD Mau Firebase project — **Firestore + Storage** — down to the
home NAS every night, so there's an independent, offline copy of all app data,
staff info, and files (health docs, onboarding PDFs, chat media, TV images).

It writes into `/cloud/backups/firebase/`, which the **existing** nightly USB
rsync (`/usr/local/sbin/ddmau-backup.sh`, 3:15am) already mirrors to the WD
backup drive with dated `_history/`. So one run gives you **two** copies +
change history, reusing infrastructure that's already there.

```
Firebase ──(nightly 12:45am, this script)──▶ /cloud/backups/firebase/  ──(3:15am rsync)──▶ /srv/backup (USB) + _history
```

## What's in a backup

```
/cloud/backups/firebase/
├── LAST_BACKUP.json                 # summary of the most recent run
├── firestore/
│   ├── _manifest.json               # per-collection doc counts + timestamp
│   ├── staff.ndjson … (one NDJSON file per collection, one doc per line)
│   └── …
└── storage/
    ├── _manifest.ndjson             # name, size, md5, contentType per object
    ├── health/…  onboarding/…  chats/…  (mirror of the bucket, original paths)
    └── …
```

- **Firestore** streams (never loads a 66k-doc collection into RAM). Timestamps,
  GeoPoints, DocumentReferences and Bytes are encoded with `__ts`/`__geo`/`__ref`/
  `__bytes` markers so the restore script re-creates the exact native types.
- **Storage** is an incremental mirror: a file is re-downloaded only if its size
  (or md5, when the bucket exposes one) changed. Nightly runs move a few MB.
- Files stay at a **stable path** (no timestamp in names) — dated history is the
  USB rsync's job (`--backup-dir=_history/<date>`), so there's no snapshot bloat.

## One-time install on the NAS

SSH in as root (`ssh root@192.168.68.50` on the LAN, or `ssh root@ddmau-nas` over
Tailscale). Node 18+ is required.

```bash
# 1. Node (Debian 13 / OMV) — if `node -v` is missing or < 18:
apt-get update && apt-get install -y nodejs npm    # or NodeSource for a newer LTS

# 2. Lay down the scripts + install firebase-admin once
mkdir -p /usr/local/lib/ddmau && cd /usr/local/lib/ddmau
# copy ddmau-nas-backup.mjs + ddmau-nas-restore.mjs here (scp from the Mac), then:
npm init -y >/dev/null && npm install firebase-admin

# 3. Credential — root-only (this key can read+write all Firestore/Storage)
mkdir -p /etc/ddmau
# scp the firebase-service-account.json to /etc/ddmau/ then:
chmod 600 /etc/ddmau/firebase-service-account.json
chown root:root /etc/ddmau/firebase-service-account.json

# 4. Cron wrapper
cp ddmau-firebase-backup.sh /usr/local/sbin/ && chmod 700 /usr/local/sbin/ddmau-firebase-backup.sh

# 5. Schedule — 12:45am Central, before the 3:15am USB rsync
cat >/etc/cron.d/ddmau-firebase-backup <<'EOF'
CRON_TZ=America/Chicago
45 0 * * * root /usr/local/sbin/ddmau-firebase-backup.sh
EOF

# 6. Seed the first full backup now (~1 GB Storage, one-time; nightly deltas are tiny)
/usr/local/sbin/ddmau-firebase-backup.sh; tail -n 30 /var/log/ddmau-firebase-backup.log
```

From the Mac, the scp for steps 2–3:
```bash
scp scripts/nas/ddmau-nas-backup.mjs scripts/nas/ddmau-nas-restore.mjs root@ddmau-nas:/usr/local/lib/ddmau/
scp scripts/nas/ddmau-firebase-backup.sh root@ddmau-nas:/usr/local/lib/ddmau/
scp firebase-service-account.json root@ddmau-nas:/etc/ddmau/
```

## Restore (disaster recovery)

Dry-run by default; refuses to write unless `--confirm` **and** `--project` matches
the key. Overwrites docs/objects of the same id/path in the target.

```bash
cd /usr/local/lib/ddmau
export GOOGLE_APPLICATION_CREDENTIALS=/etc/ddmau/firebase-service-account.json
node ddmau-nas-restore.mjs --project dd-mau-staff-app                    # dry run
node ddmau-nas-restore.mjs --project dd-mau-staff-app --confirm          # everything
node ddmau-nas-restore.mjs --project dd-mau-staff-app --only firestore \
     --collections staff,config,health_records --confirm                # scoped
```

## Notes

- Read-only vs admin key: this uses the project's Admin SDK key (full access).
  A least-privilege key (**Datastore Viewer + Storage Object Viewer**) is a good
  hardening follow-up — the backup only needs read.
- **This backup contains employee PII** (SSNs on I-9/W-4 under `onboarding/`,
  health records). The NAS is login-gated + LAN/Tailscale-only, the key is
  root-600, and the USB drive stays on-site. Offsite (Backblaze B2) is still the
  one gap — encrypt if you add it.
- Cost is negligible (~270k reads/night ≈ pennies/month).
- Sibling tool: `scripts/backup-firestore.mjs` is the Mac one-shot
  (monolithic JSON, no Storage). This NAS pair supersedes it for automated backup.
```
