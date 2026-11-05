#!/usr/bin/env node
// Read-only weekly numbers for the reliability work. Writes nothing.
//   node scripts/reliability-weekly.cjs [weeks=4]
// During pilots, run it every morning. error_logs is a sample, not a census, and
// rows age out at 90 days. Compare across the Release A line carefully: reports
// that used to be dropped now land, so counts rise with no change on devices.
// Only the old-definition line compares against the baseline.
//   RELIABILITY_EXCLUDE_DEVICES=id1,id2 also leaves those devices off that line
//   (Andrew's own, and pilots no longer listed on config/minVersion).
const path = require('path');

const HOLIDAY_WEEKS = new Set(['2026-11-23', '2026-12-21', '2026-12-28']);
const FEATURE_RELOAD = 'firestoreRevive:reload-after';
const FEATURE_SKIPPED = 'firestoreRevive:reload-skipped';
const FEATURE_BOOT = 'firestoreRevive:boot-slow';

function chicago(ms) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
}
function weekOf(ms) {
    const day = chicago(ms);
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}
const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';

// ── The old-definition line ─────────────────────────────────────────────────
// Everything below this line stays pure, so a test can pin the definition.
const EPISODE_GAP_MS = 30 * 60 * 1000;
const SLOW_QUEUE_MS = 5000;
const DEV_PERSON = 'Andrew Shih';

function _browser(ua) {
    if (/CriOS|FxiOS|EdgiOS|Edg\//.test(ua)) return 'other';
    if (/Chrome\//.test(ua)) return /; wv\)/.test(ua) ? 'webview' : 'chrome';
    if (/Firefox\//.test(ua)) return 'other';
    if (/Safari\//.test(ua)) return 'safari';
    return /AppleWebKit/.test(ua) ? 'webview' : 'other';
}

// The same classes the baseline was measured with. iPadOS's app claims to be a Mac,
// so only its screen size and the missing Safari token give it away.
function deviceClass(device) {
    const ua = device?.ua || '';
    const b = _browser(ua);
    const [w, h] = String(device?.viewport || '').split('x').map(Number);
    const short = Math.min(w || 0, h || 0);
    const long = Math.max(w || 0, h || 0);
    if (/iPad/.test(ua)) return 'iPad (UA says iPad)';
    if (/iPhone/.test(ua)) return b === 'webview' ? 'iPhone app' : (b === 'safari' ? 'iPhone Safari' : 'iPhone other browser');
    if (/Android/.test(ua)) return b === 'webview' ? 'Android app' : 'Android browser';
    if (/Macintosh/.test(ua)) {
        if (b === 'webview') return long <= 1400 && short >= 600 && long !== 1330 ? 'iPad app' : 'Mac-UA WebView (odd size)';
        return b === 'safari' ? 'Mac/iPad Safari' : 'Mac browser';
    }
    return /Windows/.test(ua) ? 'Windows browser' : 'other';
}

function matchesDevice(deviceId, listed) {
    if (!deviceId) return false;
    return listed.some((id) => id.length >= 6 && (id === deviceId || deviceId.endsWith(id)));
}

/** Which kind of row this is on the line, or null when it isn't on it. */
function oldLineKind(row) {
    const m = row.meta || {};
    if (m.deliveredBoot === 'later') return null;
    const reason = m.reason || '';
    if (/^fs-heal/.test(reason)) return 'fs-heal';
    // A timed-out pre-probe waits exactly 5 s, and older rows have no probeMs at all.
    if (/^write-stuck/.test(reason)) return m.preProbe === 'timeout' || Number(m.probeMs) >= SLOW_QUEUE_MS ? 'write-stuck' : null;
    if (reason === 'probe-stuck' || m.detectedBy === 'probe-3min') return 'probe';
    return null;
}

function isExcludedFromOldLine(row, listedDevices) {
    return row.env === 'dev' || row.userName === DEV_PERSON || matchesDevice(row.deviceId, listedDevices);
}

/** Rows into episodes: same person and device class, under 30 minutes apart. */
function mergeEpisodes(rows) {
    const last = {};
    const episodes = [];
    const when = (r) => (typeof r.meta?.at === 'number' ? r.meta.at : r.occurredAt);
    [...rows].sort((a, b) => when(a) - when(b)).forEach((r) => {
        const key = `${r.userName || '(none)'}|${deviceClass(r.device)}`;
        const t = when(r);
        const open = last[key];
        if (open && t - open.lastAt < EPISODE_GAP_MS) {
            open.lastAt = t;
            open.rows.push(r);
            return;
        }
        last[key] = { key, firstAt: t, lastAt: t, rows: [r] };
        episodes.push(last[key]);
    });
    return episodes;
}

function main() {
    const root = path.join(__dirname, '..');
    const admin = require(path.join(root, 'functions/node_modules/firebase-admin'));
    admin.initializeApp({ credential: admin.credential.cert(require(path.join(root, 'firebase-service-account.json'))) });
    return report(admin);
}

async function report(admin) {
    const weeks = Number(process.argv[2]) || 4;
    const db = admin.firestore();
    const since = Date.now() - weeks * 7 * 86400000;
    const snap = await db.collection('error_logs').where('occurredAt', '>=', since).get();
    const byWeek = {};
    const week = (k) => (byWeek[k] ||= { reloads: 0, cls: {}, reason: {}, role: {}, devices: {}, seen: new Set(), skipped: {}, bootSlow: 0, late: 0, oldEpisodes: 0, oldNonCrash: 0, oldKinds: {}, oldExcluded: 0, dropped: new Map(), droppedOverflow: 0, pushOutcomes: {} });
    const pilot = Object.keys((await db.doc('config/minVersion').get()).data()?.reliability?.pilot?.devices || {});
    const listedDevices = [...pilot, ...String(process.env.RELIABILITY_EXCLUDE_DEVICES || '').split(',').map((s) => s.trim()).filter(Boolean)];
    const oldRows = [];
    snap.forEach((docSnap) => {
        const r = docSnap.data();
        const w = week(weekOf(r.occurredAt));
        const m = r.meta || {};
        if (r.feature === FEATURE_RELOAD) {
            w.reloads += 1;
            bump(w.cls, m.cls || 'no label (old build)');
            bump(w.reason, m.reason || '?');
            bump(w.role, m.who?.role || r.userRole || '?');
            bump(w.devices, r.deviceId ? String(r.deviceId).slice(-6) : 'old build');
            if (m.deliveredBoot === 'later') w.late += 1;
            const kind = oldLineKind(r);
            if (kind && isExcludedFromOldLine(r, listedDevices)) w.oldExcluded += 1;
            else if (kind) oldRows.push(r);
        } else if (r.feature === FEATURE_SKIPPED) {
            bump(w.skipped, m.why || '?');
        } else if (r.feature === FEATURE_BOOT) {
            w.bootSlow += 1;
        }
    });
    // Episodes land in the week they started. The crash-free figure is the one the
    // 'non-crash' baseline speaks to, so it's merged again without the crash rows.
    mergeEpisodes(oldRows).forEach((ep) => {
        const w = week(weekOf(ep.firstAt));
        w.oldEpisodes += 1;
        ep.rows.forEach((r) => bump(w.oldKinds, oldLineKind(r)));
    });
    mergeEpisodes(oldRows.filter((r) => oldLineKind(r) !== 'fs-heal')).forEach((ep) => { week(weekOf(ep.firstAt)).oldNonCrash += 1; });
    // One row per device per day, in its own collection, with exact IDs.
    const seenSnap = await db.collection('device_seen').where('at', '>=', new Date(since)).get();
    seenSnap.forEach((docSnap) => {
        const r = docSnap.data();
        const at = r.at?.toMillis?.();
        if (!at) return;
        const w = week(weekOf(at));
        if (r.deviceId) w.seen.add(r.deviceId);
        // Keyed by report ID: a row that hung and landed late can repeat an entry.
        (r.droppedReports || []).forEach((e) => { if (e?.id) w.dropped.set(e.id, e); });
        w.droppedOverflow += Number(r.droppedReportsOverflow) || 0;
        Object.entries(r.pushOutcomes || {}).forEach(([key, n]) => bump(w.pushOutcomes, key, Number(n) || 0));
    });
    // Given up on means never confirmed, not lost: the row may have landed from the
    // SDK's queue later. Its fixed ID says which, once the row is looked up.
    const droppedIds = [...new Set(Object.values(byWeek).flatMap((w) => [...w.dropped.keys()]))];
    const landedIds = new Set();
    if (droppedIds.length) {
        const docs = await db.getAll(...droppedIds.map((id) => db.collection('error_logs').doc(id)));
        docs.forEach((d) => { if (d.exists) landedIds.add(d.id); });
    }
    const countRows = {};
    for (const loc of ['webster', 'maryland']) {
        const c = await db.collection(`inventory_audits_${loc}`).where('at', '>=', new Date(since)).select('at').get().catch(() => null);
        c?.forEach((d) => {
            const at = d.data().at?.toMillis?.();
            if (!at) return;
            const wk = weekOf(at);
            countRows[wk] ||= {};
            bump(countRows[wk], new Date(at).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Chicago' }));
        });
    }
    for (const k of Object.keys(byWeek).sort()) {
        const w = byWeek[k];
        console.log(`\nWeek of ${k}${HOLIDAY_WEEKS.has(k) ? ' (holiday week)' : ''}`);
        console.log(`  forced reloads: ${w.reloads} | delivered late: ${w.late}`);
        console.log(`  old-definition line: ${w.oldEpisodes} episodes, ${w.oldNonCrash} without crashes (rows: ${fmt(w.oldKinds)}; left off as dev or pilot: ${w.oldExcluded})`);
        console.log(`  by cause: ${fmt(w.cls)}`);
        console.log(`  by reason: ${fmt(w.reason)}`);
        console.log(`  by role: ${fmt(w.role)}`);
        console.log(`  by device: ${fmt(w.devices)}`);
        console.log(`  reloads skipped: ${fmt(w.skipped)} | slow boots: ${w.bootSlow} | devices seen: ${w.seen.size}`);
        if (w.dropped.size || w.droppedOverflow) {
            const entries = [...w.dropped.values()];
            const lost = entries.filter((e) => !landedIds.has(e.id));
            const by = {};
            lost.forEach((e) => bump(by, `${e.reason || '?'}/${e.cls || '?'}`));
            console.log(`  reports given up on: ${entries.length + w.droppedOverflow} | landed anyway: ${entries.length - lost.length} | never landed: ${lost.length}${w.droppedOverflow ? ` (+${w.droppedOverflow} not itemized)` : ''} (${fmt(by)})`);
        }
        if (Object.keys(w.pushOutcomes).length) console.log(`  push binding at boot: ${fmt(w.pushOutcomes)}`);
        if (countRows[k]) console.log(`  count rows by weekday: ${fmt(countRows[k])}`);
    }
    console.log('\nNot on this report yet: landing on Home and place restored (Release B), counts and adds lost (Release C), iOS versions (join capgoDeviceId by hand from the Capgo console), assertion IDs on crash reloads, the cache-size split, and failures followed by another within 30 minutes (read those from error_logs by hand for now).');
}

module.exports = { deviceClass, isExcludedFromOldLine, mergeEpisodes, oldLineKind };

if (require.main === module) {
    main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}
