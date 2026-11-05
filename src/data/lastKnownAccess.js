// lastKnownAccess.js: what the gates need to know about a person, kept on this
// device so a stuck roster can't bounce them off the page they were on.
//
// While /config/staff hasn't answered, the staff list is the built-in placeholder.
// It has no opsAccess and no recent hires, so every gate reads wrong until the
// roster lands. App.jsx merges these fields over the placeholder for that window
// only. Real access is rechecked by the bounce effect the moment the roster lands.
//
// Allow-list only. Never pin or fcmTokens. A test pins these keys. Saved only for
// people who've signed in on this device. Behind flag placeRestore. No firebase import.

import { TEST_MODE } from './testMode';

export const LAST_KNOWN_ACCESS_KEY = 'ddmau:lastKnownAccess';
export const MAX_SAVED_PEOPLE = 30;
export const ACCESS_KEYS = Object.freeze([
    'id', 'role', 'location', 'opsAccess', 'recipesAccess', 'canCountMoney',
    'canViewClockedIn', 'shiftLead', 'hiddenPages', 'canViewOnboarding',
]);

function _readAll() {
    try {
        const v = JSON.parse(localStorage.getItem(LAST_KNOWN_ACCESS_KEY) || '{}');
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; }
}

/** Only the allowed fields. Pure. */
export function pickAccessFields(record) {
    const out = {};
    if (!record || typeof record !== 'object') return out;
    for (const k of ACCESS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(record, k) && record[k] !== undefined) out[k] = record[k];
    }
    return out;
}

/** Saves this person's fields from a real roster record. Never throws. */
export function saveLastKnownAccess(record, now = Date.now()) {
    if (TEST_MODE || !record?.name) return;
    try {
        const all = _readAll();
        const access = pickAccessFields(record);
        const prev = all[record.name];
        // A roster tick with the same access writes nothing except a stale date.
        if (prev && JSON.stringify(prev.access) === JSON.stringify(access) && now - (prev.at || 0) < 3600000) return;
        all[record.name] = { access, at: now };
        const names = Object.keys(all);
        if (names.length > MAX_SAVED_PEOPLE) {
            names.sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0));
            names.slice(0, names.length - MAX_SAVED_PEOPLE).forEach((n) => { delete all[n]; });
        }
        localStorage.setItem(LAST_KNOWN_ACCESS_KEY, JSON.stringify(all));
    } catch { /* no saved access means today's behavior */ }
}

/** This person's saved fields, or null. Filtered again on the way out. */
export function readLastKnownAccess(name) {
    if (TEST_MODE || !name) return null;
    const entry = _readAll()[name];
    if (!entry || typeof entry.access !== 'object' || !entry.access) return null;
    const access = pickAccessFields(entry.access);
    return Object.keys(access).length ? access : null;
}

/**
 * The record every gate reads. Pure. Once the roster has answered, or with
 * nothing saved, it's the plain list lookup. Before that, saved fields replace
 * the built-in entry's, or stand alone for someone the built-in list doesn't have.
 */
export function effectiveStaffRecord({ staffList, staffName, staffListReady, saved }) {
    const base = (staffList || []).find((s) => s.name === staffName) || null;
    if (staffListReady || !staffName || !saved) return base;
    if (!base) return { name: staffName, ...saved };
    const merged = { ...base };
    for (const k of ACCESS_KEYS) delete merged[k];
    return { ...merged, ...saved };
}
