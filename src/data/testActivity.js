// Test-login activity log (2026-11-05). The owner gives the Test login to someone
// to look over the app and wants to see what they did. Test mode sends nothing to
// the server, so this is its one deliberate exception: which pages were opened and
// which buttons were tapped, with times. Never anything typed, never a field value.
//
// It goes out over Firestore's REST API with fetch, because the SDK in test mode is
// on an in-memory cache with the network off for good, and must stay that way.
import { TEST_MODE } from './testMode';
import { getOrCreateDeviceId } from './deviceId';

export const TEST_ACTIVITY_COLLECTION = 'test_activity';
const REST_BASE = 'https://firestore.googleapis.com/v1/projects/dd-mau-staff-app/databases/(default)/documents/' + TEST_ACTIVITY_COLLECTION;
const FLUSH_EVERY_MS = 20000;
const FLUSH_AT = 25;
const MAX_EVENTS_PER_SESSION = 3000;
const MAX_LABEL = 60;

// What a tapped thing is called, from its visible label only.
export function tapLabel(el) {
    if (!el || typeof el.closest !== 'function') return null;
    if (el.closest('input, textarea, select, [contenteditable="true"]')) return null;
    const target = el.closest('button, a, [role="button"], [role="tab"], [role="menuitem"], summary, label');
    if (!target || target.tagName === 'LABEL' && target.querySelector('input, textarea, select')) return null;
    const raw = target.getAttribute('aria-label') || target.getAttribute('title') || target.textContent || '';
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL - 1) + '…' : text;
}

// Firestore REST encoding for the plain values this log uses.
export function toRestValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toRestValue) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toRestValue(x)])) } };
}

export function createTestActivityLog({ session, staff, appVersion, fetchImpl, now = () => Date.now() }) {
    let seq = 0;
    let total = 0;
    let buffer = [];
    let timer = null;
    const base = {
        session,
        staffId: staff?.id ?? null,
        staffName: staff?.name || 'Test',
        deviceId: (() => { try { return getOrCreateDeviceId(); } catch { return null; } })(),
        appVersion: appVersion || '',
        platform: (typeof window !== 'undefined' && window.Capacitor?.getPlatform?.()) || 'web',
        screen: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : '',
        startedAt: now(),
    };

    const flush = (keepalive = false) => {
        if (!buffer.length || !fetchImpl) return;
        const events = buffer;
        buffer = [];
        seq += 1;
        const id = `${session}_${String(seq).padStart(4, '0')}`;
        const body = { fields: toRestValue({ ...base, seq, at: now(), events }).mapValue.fields };
        try {
            fetchImpl(`${REST_BASE}?documentId=${encodeURIComponent(id)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                keepalive,
            }).catch(() => { /* a lost batch is better than a test session that breaks */ });
        } catch { /* same */ }
    };

    const record = (kind, detail = {}) => {
        if (total >= MAX_EVENTS_PER_SESSION) return;
        total += 1;
        buffer.push({ at: now(), kind, ...detail });
        if (buffer.length >= FLUSH_AT) flush();
        else if (!timer) timer = setTimeout(() => { timer = null; flush(); }, FLUSH_EVERY_MS);
    };

    return { record, flush, base };
}

let active = null;

// Called once at boot. Does nothing outside test mode.
export function startTestActivityLog({ appVersion, getTab }) {
    if (!TEST_MODE || active || typeof window === 'undefined') return null;
    const session = `${TEST_MODE.id ?? 'test'}_${TEST_MODE.at || Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    active = createTestActivityLog({ session, staff: TEST_MODE, appVersion, fetchImpl: window.fetch.bind(window) });
    active.record('start');
    const onClick = (e) => {
        const label = tapLabel(e.target);
        if (label) active.record('tap', { label, tab: getTab?.() || '' });
    };
    const onHide = () => { if (document.visibilityState === 'hidden') active.flush(true); };
    document.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', () => active.flush(true));
    return active;
}

export function recordTestPage(tab) {
    if (active && tab) active.record('page', { tab: String(tab) });
}
