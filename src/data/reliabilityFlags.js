// reliabilityFlags.js: per-device and fleet switches for risky changes.
//
// Lives on an optional `reliability` field of config/minVersion:
//   { flags: { <flag>: true|false }, pilot: { devices: { <deviceId>: { <flag>: true } } } }
// Pilot flags are per device, so adding one device to a flag can't hand it flags
// another pilot device has. A device key is a whole ID or the 6 on the badge.
// A flag that has never reached a device reads as off, which means today's
// behavior, so failing to read flags is always safe.
//
// Two feeds, because the version-floor listener can't reach a device whose line
// is stuck: that listener, and a plain REST read capped at 5s at boot and on
// every resume. Set flags with scripts/reliability-flag.cjs. Risky flags should
// be read when used, not once at boot, so "off" works without a reload.

import { TEST_MODE } from './testMode';
import { getOrCreateDeviceId } from './deviceId';

export const FLAGS_KEY = 'ddmau:relFlags';
export const FLAG_FETCH_CAP_MS = 5000;
const REST_URL = 'https://firestore.googleapis.com/v1/projects/dd-mau-staff-app/databases/(default)/documents/config/minVersion';

export function getReliabilityFlag(name, fallback = false) {
    if (TEST_MODE) return false;
    try {
        const flags = JSON.parse(localStorage.getItem(FLAGS_KEY) || '{}')?.flags;
        return flags && Object.prototype.hasOwnProperty.call(flags, name) ? flags[name] : fallback;
    } catch { return fallback; }
}

/** Fleet flags, with pilot flags on top when this device is listed. Pure. */
export function resolveFlags(reliability, deviceId) {
    const out = reliability?.flags && typeof reliability.flags === 'object' ? { ...reliability.flags } : {};
    const devices = reliability?.pilot?.devices;
    if (!deviceId || !devices || typeof devices !== 'object') return out;
    for (const [id, flags] of Object.entries(devices)) {
        // Accepts a whole ID or a suffix of at least 6, such as the badge's.
        if (id.length < 6 || !(id === deviceId || deviceId.endsWith(id))) continue;
        if (flags && typeof flags === 'object') Object.assign(out, flags);
    }
    return out;
}

/** Takes the `reliability` field from either feed and stores what applies here. */
export function applyReliabilityConfig(reliability) {
    if (TEST_MODE) return;
    try {
        localStorage.setItem(FLAGS_KEY, JSON.stringify({ flags: resolveFlags(reliability, getOrCreateDeviceId()), at: Date.now() }));
    } catch { /* last known flags stay */ }
}

function _decodeRest(value) {
    if (!value || typeof value !== 'object') return undefined;
    if ('booleanValue' in value) return value.booleanValue;
    if ('stringValue' in value) return value.stringValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return value.doubleValue;
    if ('nullValue' in value) return null;
    if ('arrayValue' in value) return (value.arrayValue.values || []).map(_decodeRest);
    if ('mapValue' in value) {
        const out = {};
        for (const [k, v] of Object.entries(value.mapValue.fields || {})) out[k] = _decodeRest(v);
        return out;
    }
    return undefined;
}

/** Pulls `reliability` out of a Firestore REST document. Pure. */
export function reliabilityFromRestDoc(restDoc) {
    return _decodeRest(restDoc?.fields?.reliability) ?? null;
}

export async function refreshReliabilityFlags(fetchImpl = typeof fetch !== 'undefined' ? fetch : null) {
    if (TEST_MODE || !fetchImpl) return false;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FLAG_FETCH_CAP_MS) : null;
    try {
        const resp = await fetchImpl(REST_URL, { cache: 'no-store', signal: ctrl?.signal });
        if (!resp.ok) return false;
        applyReliabilityConfig(reliabilityFromRestDoc(await resp.json()));
        return true;
    } catch {
        // No connection or too slow. Keep the last flags this device heard.
        return false;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function installReliabilityFlags() {
    if (TEST_MODE || typeof document === 'undefined') return;
    refreshReliabilityFlags();
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshReliabilityFlags();
    });
    (async () => {
        try {
            if (!window.Capacitor?.isNativePlatform?.()) return;
            const { App: CapApp } = await import('@capacitor/app');
            await CapApp.addListener('appStateChange', ({ isActive }) => { if (isActive) refreshReliabilityFlags(); });
        } catch { /* the web path above still covers it */ }
    })();
}
