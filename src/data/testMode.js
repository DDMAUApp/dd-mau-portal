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
const TAB_KEY = 'ddmau:testModeTab';
const PAYROLL_UNLOCK_KEY = 'ddmau:payrollUnlocked';

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

const newTabId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// One browsing context only (no second tab can exist): the native app's
// single WebView, and an iOS home-screen web app (its storage is its own).
const isSingleContextApp = () => {
    try {
        if (typeof window === 'undefined') return false;
        if (window.Capacitor?.isNativePlatform?.() === true) return true;
        return window.navigator?.standalone === true;
    } catch { return false; }
};
// This tab's own test-session leftovers, without touching localStorage
// (someone else already restored the device): keep only "app is open".
function clearThisTabSession(ss) {
    if (!ss) return;
    try {
        const alive = ss.getItem(SESSION_ALIVE_KEY);
        ss.clear();
        if (alive) ss.setItem(SESSION_ALIVE_KEY, alive);
    } catch { /* ignore */ }
}
// The test tab refreshes flag.beat every BEAT_MS. A flag whose beat is older
// than BEAT_STALE_MS has no live test tab behind it (background tabs throttle
// timers to ~1/min, hence the margin).
const BEAT_MS = 5000;
const BEAT_STALE_MS = 90 * 1000;
const beatIsFresh = (flag) => Number(flag?.beat) > 0 && Date.now() - Number(flag.beat) < BEAT_STALE_MS;

function clearFlag(ls) {
    try { restoreBackup(ls); } catch { /* ignore */ }
    try { ls.removeItem(FLAG_KEY); ls.removeItem(BACKUP_KEY); } catch { /* ignore */ }
}

// Returns { mode, otherTab }:
//   mode     — the frozen test-mode identity for THIS page, or null
//   otherTab — a LIVE test session is running in another tab/window of this
//              browser (desktop web shares localStorage): main.jsx shows a
//              blocker instead of running a real session next to it.
function readFlag() {
    const none = { mode: null, otherTab: false };
    const ls = safeLocal();
    if (!ls) return none;
    let flag = null;
    try { flag = JSON.parse(ls.getItem(FLAG_KEY) || 'null'); } catch { flag = null; }
    if (flag && (typeof flag.name !== 'string' || !flag.name.trim())) {
        clearFlag(ls);
        flag = null;
    }
    const ss = safeSession();
    const alive = !!ss?.getItem(SESSION_ALIVE_KEY);
    let tab = ss?.getItem(TAB_KEY) || null;
    if (!flag) {
        // This tab WAS a test tab but its session was ended elsewhere (or
        // the flag went stale): drop its test-session sessionStorage (e.g. a
        // payroll unlock set against the test copy) before the real app boots.
        if (tab) clearThisTabSession(ss);
        return none;
    }
    if (alive && !flag.tab) {
        // A flag written by v1.0.499 (before tab keying) in this very tab:
        // adopt it and stay in test mode — returning null here booted the
        // REAL app logged in as the tester.
        tab = newTabId();
        flag.tab = tab;
        flag.beat = Date.now();
        try { ls.setItem(FLAG_KEY, JSON.stringify(flag)); ss.setItem(TAB_KEY, tab); } catch { /* ignore */ }
    }
    if (alive && flag.tab === tab) {
        const id = Number(flag.id);
        return {
            mode: Object.freeze({ name: flag.name, id: Number.isFinite(id) ? id : null, at: Number(flag.at) || Date.now() }),
            otherTab: false,
        };
    }
    // Not this tab's test session. A former test tab drops its leftovers.
    if (tab) clearThisTabSession(ss);
    // A live session elsewhere → block this tab. A single-context app (native
    // WebView, iOS home-screen app) can't have another tab, so its flag is
    // always stale (closed mid-test) — a cold launch never resumes test mode.
    if (!isSingleContextApp() && beatIsFresh(flag)) return { mode: null, otherTab: true };
    clearFlag(ls);
    return none;
}

const _boot = readFlag();
// The page-lifetime switch. null = normal app.
export const TEST_MODE = _boot.mode;
// Another tab of this browser is in test mode right now (see main.jsx).
export const TEST_MODE_IN_OTHER_TAB = _boot.otherTab;

// Called by main.jsx in the test tab: keep the flag's heartbeat fresh, and
// if the flag disappears or changes owner (another tab ended it, or it went
// stale and a new tab cleaned it up), leave test mode at once.
export function startTestModeHeartbeat() {
    if (!TEST_MODE || typeof window === 'undefined') return () => {};
    const ls = safeLocal();
    const ss = safeSession();
    const myTab = ss?.getItem(TAB_KEY);
    let leaving = false;
    // Still ours? If the flag is gone or owned by another tab, the device
    // was ALREADY restored by whoever ended it — leave without restoring
    // again (a second restore would wipe drafts the first one put back).
    const stillOwned = () => {
        if (leaving) return false;
        let flag = null;
        try { flag = JSON.parse(ls.getItem(FLAG_KEY) || 'null'); } catch { flag = null; }
        if (flag && flag.tab === myTab) return flag;
        leaving = true;
        clearThisTabSession(ss);
        _reload();
        return false;
    };
    const beat = () => {
        const flag = stillOwned();
        if (!flag) return;
        try {
            flag.beat = Date.now();
            ls.setItem(FLAG_KEY, JSON.stringify(flag));
        } catch { /* ignore */ }
    };
    beat();
    const id = setInterval(beat, BEAT_MS);
    // Storage events only CHECK ownership — never write (two tabs sharing a
    // tab id, e.g. Chrome "Duplicate tab", would otherwise ping-pong writes).
    const onStorage = (e) => { if (e.key === FLAG_KEY || e.key === null) stillOwned(); };
    window.addEventListener('storage', onStorage);
    return () => { clearInterval(id); window.removeEventListener('storage', onStorage); };
}

// Blocker button in a non-test tab: end the other tab's test session (its
// heartbeat sees the flag gone and exits) and reload this one normally.
export function endTestModeElsewhere() {
    const ls = safeLocal();
    if (ls) clearFlag(ls);
    _reload();
}

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
    // A backup that already exists belongs to a test session that never
    // finished — it holds the CLEAN device state; never overwrite it with
    // the test-polluted one.
    if (!(ls.getItem(BACKUP_KEY) && ls.getItem(FLAG_KEY))) {
        const backup = {};
        for (let i = 0; i < ls.length; i++) {
            const k = ls.key(i);
            if (k && !k.startsWith(FLAG_KEY) && k !== STAFF_NAME_KEY) backup[k] = ls.getItem(k);
        }
        try { ls.setItem(BACKUP_KEY, JSON.stringify(backup)); } catch { /* full — exit falls back to the unsafe-key sweep */ }
    }
    const tab = newTabId();
    ls.setItem(FLAG_KEY, JSON.stringify({ name: staff.name, id: staff.id ?? null, at: Date.now(), tab, beat: Date.now() }));
    // The test identity is NOT written to the shared ddmau:staffName — App
    // reads TEST_MODE.name — so another tab never picks it up.
    ls.removeItem(STAFF_NAME_KEY);
    const ss = safeSession();
    try {
        ss?.setItem(SESSION_ALIVE_KEY, '1');
        ss?.setItem(TAB_KEY, tab);
        // A real owner's payroll unlock must not carry into the test session.
        ss?.removeItem(PAYROLL_UNLOCK_KEY);
    } catch { /* ignore */ }
    _reload();
    return true;
}

// Leave test mode: put the device back exactly as it was, then reload into
// the normal app (lock screen).
export function exitTestMode() {
    const ls = safeLocal();
    // Restore only while the flag is still there: if it's already gone,
    // someone else restored the device and a second pass would sweep the
    // drafts it just put back.
    if (ls && ls.getItem(FLAG_KEY)) {
        try { restoreBackup(ls); } catch { /* ignore */ }
        try { ls.removeItem(FLAG_KEY); ls.removeItem(BACKUP_KEY); } catch { /* ignore */ }
    }
    // Everything this tab stored for the test session goes too (payroll
    // unlock set against the test copy, reload stashes, guards) — only the
    // "app is open" marker survives, so the reload lands on the lock screen
    // instead of being treated as a cold launch.
    const ss = safeSession();
    if (ss) {
        try {
            const alive = ss.getItem(SESSION_ALIVE_KEY);
            ss.clear();
            if (alive) ss.setItem(SESSION_ALIVE_KEY, alive);
        } catch { /* ignore */ }
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
