// testMode.js — per-staff TEST MODE (Andrew 2026-11-03: "add a test mode in
// the staff page so I can put any staff member into test mode … they can
// change anything on the app but nothing publishes or saves").
//
// How it works:
//   • An admin flips `testMode: true` on a staff record (Admin → Staff).
//   • When that person logs in, enterTestMode() backs up this device's
//     localStorage, sets the flag below and reloads.
//   • On the reloaded page TEST_MODE is set for the WHOLE page lifetime:
//       – Firestore runs on an in-MEMORY cache (src/firebase.js) — nothing
//         queued in test mode can survive the page,
//       – main.jsx copies a snapshot of the live data into that cache,
//         then disables the network PERMANENTLY for this page,
//       – the firebase/* shims (src/testmode/) make writes apply locally
//         and resolve immediately, never send; uploads stay in memory;
//         server functions that write are blocked; printers never print,
//       – the person gets owner access on this device only (staff.js).
//   • Logout / relock / closing the app → exitTestMode() restores the
//     backed-up localStorage and reloads into the normal app. Every test
//     change is gone.
//
// This module must stay free of firebase imports — the firebase shims and
// src/firebase.js import it, and it must evaluate before either.

const FLAG_KEY = 'ddmau:testMode';
const BACKUP_KEY = 'ddmau:testMode:lsBackup';
const SESSION_ALIVE_KEY = 'ddmau:sessionAlive';
const STAFF_NAME_KEY = 'ddmau:staffName';

// Device-local stores that would carry test-mode state into the next real
// session if the backup couldn't be written (localStorage full). Pages
// rehydrate these on boot — a stashed inventory tap would otherwise be
// RE-SAVED for real after test mode ends.
const UNSAFE_KEY_RE = /stash|draft|pending|cache|queue|lastOpen/i;

function safeLocal() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}
function safeSession() {
    try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; }
}

function restoreBackup(ls) {
    const raw = ls.getItem(BACKUP_KEY);
    if (raw) {
        let saved = null;
        try { saved = JSON.parse(raw); } catch { saved = null; }
        if (saved && typeof saved === 'object') {
            ls.clear();
            for (const [k, v] of Object.entries(saved)) {
                try { ls.setItem(k, String(v)); } catch { /* quota — skip */ }
            }
            ls.removeItem(STAFF_NAME_KEY);
            return true;
        }
    }
    // No usable backup: drop everything test mode could have left behind.
    for (let i = ls.length - 1; i >= 0; i--) {
        const k = ls.key(i);
        if (k && (k.startsWith(FLAG_KEY) || UNSAFE_KEY_RE.test(k))) ls.removeItem(k);
    }
    ls.removeItem(STAFF_NAME_KEY);
    return false;
}

function readFlag() {
    const ls = safeLocal();
    if (!ls) return null;
    let flag = null;
    try { flag = JSON.parse(ls.getItem(FLAG_KEY) || 'null'); } catch { flag = null; }
    if (!flag) return null;
    if (typeof flag.name !== 'string' || !flag.name.trim()) {
        try { restoreBackup(ls); } catch { /* ignore */ }
        return null;
    }
    // Cold launch (app was closed) never resumes test mode: restore the
    // device and boot the normal app on the lock screen. sessionStorage
    // survives reloads, not app closes — same signal App.jsx uses to lock.
    const ss = safeSession();
    if (!ss || !ss.getItem(SESSION_ALIVE_KEY)) {
        try { restoreBackup(ls); } catch { /* ignore */ }
        return null;
    }
    const id = Number(flag.id);
    return Object.freeze({
        name: flag.name,
        id: Number.isFinite(id) ? id : null,
        at: Number(flag.at) || Date.now(),
    });
}

// The page-lifetime switch. null = normal app.
export const TEST_MODE = readFlag();

export function isTestModeStaff(staff) {
    return staff?.testMode === true;
}

let _reload = () => { try { window.location.reload(); } catch { /* ignore */ } };
export function __setTestModeReloadForTests(fn) { _reload = fn; }

// Called with the staff record at login (or when an admin flips the
// switch on someone who is logged in). Reloads the page.
export function enterTestMode(staff) {
    const ls = safeLocal();
    if (!ls || !staff?.name) return false;
    const backup = {};
    for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && !k.startsWith(FLAG_KEY) && k !== STAFF_NAME_KEY) backup[k] = ls.getItem(k);
    }
    try { ls.setItem(BACKUP_KEY, JSON.stringify(backup)); } catch { /* full — exit falls back to the unsafe-key sweep */ }
    ls.setItem(FLAG_KEY, JSON.stringify({ name: staff.name, id: staff.id ?? null, at: Date.now() }));
    ls.setItem(STAFF_NAME_KEY, staff.name);
    const ss = safeSession();
    try { ss?.setItem(SESSION_ALIVE_KEY, '1'); } catch { /* ignore */ }
    _reload();
    return true;
}

// Leave test mode: put the device back exactly as it was, then reload into
// the normal app (lock screen).
export function exitTestMode() {
    const ls = safeLocal();
    if (ls) {
        try { restoreBackup(ls); } catch { /* ignore */ }
        try { ls.removeItem(FLAG_KEY); ls.removeItem(BACKUP_KEY); } catch { /* ignore */ }
    }
    _reload();
}

// Printing stand-in: a sticker or receipt in test mode never reaches a
// printer. Same success shape the print paths return.
export function testModePrintSkipped() {
    try {
        import('../toast').then((m) => m.toast('🧪 Test mode — nothing was printed', { kind: 'info', duration: 2500 })).catch(() => {});
    } catch { /* ignore */ }
    return { ok: true, testMode: true };
}
