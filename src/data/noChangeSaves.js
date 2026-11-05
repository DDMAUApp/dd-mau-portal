// noChangeSaves.js: the decisions behind "don't run a transaction that has
// nothing to change" (flag skipNoChangeTx). No firebase import, so it can be used
// at boot and tested on its own. Every storage failure means the old behavior.
//
// A transaction that writes nothing still holds the SDK's single-file line, and
// the push token and sign-in stamp ran one after every reload.

import { getReliabilityFlag } from './reliabilityFlags';

export const SKIP_NO_CHANGE_FLAG = 'skipNoChangeTx';
export const MAX_TOKENS_PER_STAFF = 5;
export const SIGN_IN_STAMP_MS = 30 * 60 * 1000;

const SIGN_IN_KEY_PREFIX = 'ddmau:stamped:signIn:';
const OUTCOMES_KEY = 'ddmau:pushOutcomes';

/**
 * What binding `token` to `staffName` would do to this roster. Pure. Both the
 * transaction bodies and the check before them use it, so they can't disagree.
 *
 * alreadyBound is the rule the transactions have always used: my own list keeps
 * the same tokens in the same order with mine first, and nobody else's entry
 * needs sweeping. Web callers leave platform and tokenKind out, and the entry
 * must then have no such keys: Firestore refuses `undefined`.
 *
 * Throws on the same malformed rosters the transaction bodies did. A caller
 * checking before a transaction treats that as doubt.
 */
export function planTokenBinding(list, staffName, token, deviceId, platform, tokenKind, now = Date.now()) {
    const liveList = list || [];
    const meIdx = liveList.findIndex((s) => s.name === staffName);
    if (meIdx === -1) {
        return { found: false, alreadyBound: false, nextList: null, nextTokens: null, sweepCount: 0 };
    }
    const me = liveList[meIdx];
    const existing = Array.isArray(me.fcmTokens) ? me.fcmTokens : [];
    // Dedup on two axes. Same deviceId: one entry per physical browser, so this
    // replaces the old token after a rotation. Same token string: keeps legacy
    // entries with no deviceId from piling up. A legacy entry that matches neither
    // stays, because it may be another device; the dispatcher prunes it if it dies.
    const seenTokens = new Set();
    const dedup = [];
    for (const t of existing) {
        if (!t || !t.token) continue;
        if (t.token === token) continue;
        if (t.deviceId && t.deviceId === deviceId) continue;
        if (seenTokens.has(t.token)) continue;
        seenTokens.add(t.token);
        dedup.push(t);
    }
    const entry = platform
        ? { token, lastSeen: now, deviceId, platform, tokenKind }
        : { token, lastSeen: now, deviceId };
    const nextTokens = [entry, ...dedup].slice(0, MAX_TOKENS_PER_STAFF);

    // Cross-staff sweep (2026-05-17: Julie's phone got pushes for messages she
    // sent, because her device was also on Andrew's record). This device and this
    // token come off everyone else, so someone signing in on the wrong phone heals
    // the next time the right person opens it.
    let sweepCount = 0;
    const nextList = liveList.map((s, i) => {
        if (i === meIdx) return { ...s, fcmTokens: nextTokens };
        if (!Array.isArray(s.fcmTokens) || s.fcmTokens.length === 0) return s;
        const cleaned = s.fcmTokens.filter((t) => {
            if (!t || !t.token) return false;
            if (t.deviceId && t.deviceId === deviceId) return false;
            if (t.token === token) return false;
            return true;
        });
        if (cleaned.length !== s.fcmTokens.length) {
            sweepCount += (s.fcmTokens.length - cleaned.length);
            return { ...s, fcmTokens: cleaned };
        }
        return s;
    });

    const myOwnSame = existing.length === nextTokens.length &&
        existing.every((t, i) => t.token === nextTokens[i].token);
    return { found: true, alreadyBound: myOwnSame && sweepCount === 0, nextList, nextTokens, sweepCount };
}

/**
 * Should a boot effect that needs the real roster run yet? With the flag off this
 * is always true, so adding it to an effect's deps can never re-run that effect.
 */
export function rosterGateOpen(staffListReady) {
    return staffListReady === true || !getReliabilityFlag(SKIP_NO_CHANGE_FLAG);
}

/** True only for a readable stamp under 30 minutes old. A future time is doubt. */
export function signInStampedRecently(staffName, now = Date.now()) {
    try {
        const at = Number(localStorage.getItem(SIGN_IN_KEY_PREFIX + staffName));
        if (!Number.isFinite(at) || at <= 0) return false;
        const age = now - at;
        return age >= 0 && age < SIGN_IN_STAMP_MS;
    } catch { return false; }
}

export function markSignInStamped(staffName, at = Date.now()) {
    try { localStorage.setItem(SIGN_IN_KEY_PREFIX + staffName, String(at)); } catch { /* the transaction just runs */ }
}

// ── Counts ───────────────────────────────────────────────────────────────────
// Kept on the device and carried on the daily device_seen row, so skipping a
// transaction adds no write of its own. Only ever called with the flag on.
//   already-bound        skipped, roster confirmed by the server
//   already-bound:cache  skipped on the cached roster, server check still to come
//   cache-confirmed      that server check agreed
//   late-rebind:<x>      that server check disagreed, so the transaction ran. If
//                        this is common, the cached fallback is too trusting.
//   tx:<x>               the transaction ran, with its own outcome
function _readOutcomes() {
    try {
        const parsed = JSON.parse(localStorage.getItem(OUTCOMES_KEY) || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
}

export function notePushOutcome(key) {
    try {
        const all = _readOutcomes();
        all[key] = (Number(all[key]) || 0) + 1;
        localStorage.setItem(OUTCOMES_KEY, JSON.stringify(all));
    } catch { /* a missed count, nothing more */ }
}

export function readPushOutcomes() {
    return _readOutcomes();
}

/** Takes off what a landed row carried, keeping anything counted since. */
export function clearPushOutcomes(sent) {
    try {
        const all = _readOutcomes();
        for (const [k, n] of Object.entries(sent || {})) {
            const left = (Number(all[k]) || 0) - (Number(n) || 0);
            if (left > 0) all[k] = left; else delete all[k];
        }
        if (Object.keys(all).length) localStorage.setItem(OUTCOMES_KEY, JSON.stringify(all));
        else localStorage.removeItem(OUTCOMES_KEY);
    } catch { /* counted again tomorrow */ }
}
