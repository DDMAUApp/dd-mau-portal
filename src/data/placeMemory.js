// placeMemory.js: remembers where someone was, per person on this device.
//
// Main tab, plus an inventory record per person and store. 30-minute life, in
// localStorage so it covers relock and closing the app. A different person on a
// shared iPad has their own record. Behind flag placeRestore, and test mode
// never reads or writes it. No firebase import.

import { TEST_MODE } from './testMode';

export const PLACE_TTL_MS = 30 * 60 * 1000;
export const PLACE_SAVE_EVERY_MS = 500;
// A record's 30 minutes run from when the person was last here, so it's rewritten
// on this beat while the page is open.
export const PLACE_REFRESH_MS = 60 * 1000;
const TAB_PREFIX = 'ddmau:placeTab:';
const INV_PREFIX = 'ddmau:placeInv:';

// What an inventory record may hold. Anything else is dropped on read and write.
export const INVENTORY_PLACE_KEYS = Object.freeze([
    'subTab', 'invViewMode', 'invSearch', 'invShowOnlyCounted', 'invShowOnlyLow', 'collapsedCats',
    'writeInValues', 'writeInDest', 'locWriteIn', 'locWriteInCat', 'invNewName', 'invNewNameEs', 'scrollY',
]);
const SUB_TABS = ['checklist', 'assign', 'wall', 'saucelog', 'inventory', 'breaks', 'prep'];
const VIEW_MODES = ['category', 'location', 'vendor', 'split', 'pricing'];

const _isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function _sanitize(place) {
    if (!_isMap(place)) return null;
    const out = {};
    for (const k of INVENTORY_PLACE_KEYS) if (place[k] !== undefined) out[k] = place[k];
    if (!SUB_TABS.includes(out.subTab)) delete out.subTab;
    if (!VIEW_MODES.includes(out.invViewMode)) delete out.invViewMode;
    if (typeof out.invSearch !== 'string') delete out.invSearch;
    if (typeof out.invNewName !== 'string') delete out.invNewName;
    if (typeof out.invNewNameEs !== 'string') delete out.invNewNameEs;
    if (typeof out.invShowOnlyCounted !== 'boolean') delete out.invShowOnlyCounted;
    if (typeof out.invShowOnlyLow !== 'boolean') delete out.invShowOnlyLow;
    for (const k of ['collapsedCats', 'writeInValues', 'writeInDest', 'locWriteIn', 'locWriteInCat']) {
        if (!_isMap(out[k])) delete out[k];
    }
    if (!Number.isFinite(out.scrollY) || out.scrollY < 0) delete out.scrollY;
    return out;
}

let _prunedThisPage = false;
// Records hold typed text, so one left by someone who never returns shouldn't stay.
function _pruneOnce(now) {
    if (_prunedThisPage) return;
    _prunedThisPage = true;
    try {
        for (let i = localStorage.length - 1; i >= 0; i -= 1) {
            const k = localStorage.key(i);
            if (!k || !(k.startsWith(TAB_PREFIX) || k.startsWith(INV_PREFIX))) continue;
            let at = 0;
            try { at = Number(JSON.parse(localStorage.getItem(k))?.at) || 0; } catch { /* broken: remove */ }
            if (now - at >= PLACE_TTL_MS) localStorage.removeItem(k);
        }
    } catch { /* tries again next page */ }
}

function _write(key, value, now) {
    if (TEST_MODE) return;
    _pruneOnce(now);
    try { localStorage.setItem(key, JSON.stringify({ ...value, at: now })); } catch { /* no saved place means today's behavior */ }
}

function _read(key, now) {
    if (TEST_MODE) return null;
    try {
        const v = JSON.parse(localStorage.getItem(key) || 'null');
        if (!_isMap(v) || !Number.isFinite(v.at)) return null;
        if (now - v.at >= PLACE_TTL_MS || now < v.at) return null;
        return v;
    } catch { return null; }
}

/** A null name is a no-op, so a relock's setActiveTab('home') can't overwrite the tab. */
export function saveMainTab(staffName, tab, now = Date.now()) {
    if (!staffName || !tab) return;
    _write(TAB_PREFIX + staffName, { tab }, now);
}

export function readMainTab(staffName, now = Date.now()) {
    if (!staffName) return null;
    const v = _read(TAB_PREFIX + staffName, now);
    return typeof v?.tab === 'string' && v.tab ? v.tab : null;
}

export function saveInventoryPlace(staffName, store, place, now = Date.now()) {
    if (!staffName || !store) return;
    const clean = _sanitize(place);
    if (clean) _write(`${INV_PREFIX}${staffName}:${store}`, { place: clean }, now);
}

export function readInventoryPlace(staffName, store, now = Date.now()) {
    if (!staffName || !store) return null;
    return _sanitize(_read(`${INV_PREFIX}${staffName}:${store}`, now)?.place);
}

/**
 * Keeps the latest value and writes it at most once per `everyMs`. flush() writes
 * what's waiting now, for pagehide, unmount and a store switch.
 */
export function createPlaceSaver(write, everyMs = PLACE_SAVE_EVERY_MS) {
    let timer = null;
    let lastAt = -Infinity;
    let dirty = false;
    const flush = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!dirty) return;
        dirty = false;
        lastAt = Date.now();
        try { write(); } catch { /* best-effort */ }
    };
    return {
        schedule() {
            dirty = true;
            if (timer) return;
            timer = setTimeout(flush, Math.max(0, everyMs - (Date.now() - lastAt)));
        },
        flush,
    };
}

/** Pure: did this reload put the person back where they were? */
export function placeOutcome({ reportTab, tab, body }) {
    const painted = body === 'tab' || body === 'home';
    return {
        restored: painted && (reportTab == null || reportTab === tab),
        landedHome: tab === 'home' && reportTab != null && reportTab !== 'home',
    };
}

export function __resetPlaceMemoryForTests() { _prunedThisPage = false; }
