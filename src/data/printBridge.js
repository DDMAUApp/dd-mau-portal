// printBridge — client-side helpers for the Pi 5 print bridge.
//
// Architecture (full picture lives in /pi5-print-bridge/README.md):
//
//   Web app (HTTPS, app.ddmaustl.com)
//        │  POST /print/label  +  X-API-Key header
//        ▼
//   Tailscale Funnel HTTPS endpoint
//        │  (Tailscale terminates HTTPS, forwards to localhost:8443)
//        ▼
//   print_server.py on the Pi 5
//        │  brother_ql raster over TCP:9100
//        ▼
//   Brother QL-820NWB @ 192.168.1.34
//
// Config lives at /config/print_bridge in Firestore:
//
//   {
//     enabled: bool,                      // master toggle — flip off if bridge breaks
//     url: 'https://<host>.<tailnet>.ts.net',
//     apiKey: '<64-hex-char secret>',     // matches /etc/print_bridge/api_key on Pi
//     healthCheckTimeoutMs: 800           // how long to wait for /healthz
//   }
//
// Caller flow inside labelPrinting.js:
//   1. Read config (cached for ~30s to avoid hammering Firestore)
//   2. If bridge.enabled === false → return null → caller falls back to PDF/share-sheet
//   3. Quick /healthz probe (fail-fast)
//   4. POST /print/label with the converted payload + API key
//   5. On any error → return { ok: false, fallback: true } → caller falls back

import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';

const CONFIG_PATH = ['config', 'print_bridge'];
const CACHE_TTL_MS = 30 * 1000; // 30s — long enough to skip Firestore on rapid prints

let cachedConfig = null;
let cachedAt = 0;

// Read /config/print_bridge with a 30s cache. Returns null if the doc
// doesn't exist or `enabled` is false — that's the signal to the caller
// to fall back to the existing PDF/share-sheet path.
export async function getPrintBridgeConfig({ force = false } = {}) {
    const now = Date.now();
    if (!force && cachedConfig !== undefined && (now - cachedAt) < CACHE_TTL_MS) {
        return cachedConfig;
    }
    try {
        const snap = await getDoc(doc(db, ...CONFIG_PATH));
        if (!snap.exists()) {
            cachedConfig = null;
            cachedAt = now;
            return null;
        }
        const data = snap.data() || {};
        if (data.enabled !== true) {
            cachedConfig = null;
            cachedAt = now;
            return null;
        }
        if (!data.url || !data.apiKey) {
            console.warn('print_bridge config missing url or apiKey');
            cachedConfig = null;
            cachedAt = now;
            return null;
        }
        cachedConfig = {
            url: String(data.url).replace(/\/+$/, ''), // strip trailing slash
            apiKey: String(data.apiKey),
            healthCheckTimeoutMs: Number(data.healthCheckTimeoutMs) || 800,
        };
        cachedAt = now;
        return cachedConfig;
    } catch (e) {
        console.warn('getPrintBridgeConfig failed:', e);
        cachedConfig = null;
        cachedAt = now;
        return null;
    }
}

// Invalidate the cache — used by Admin Panel "Test connection" so a
// freshly-edited URL/key takes effect immediately.
export function invalidatePrintBridgeCache() {
    cachedConfig = null;
    cachedAt = 0;
}

// Fetch with a timeout. AbortController-based; native fetch doesn't
// accept a timeout option directly. Returns either { ok, status, body }
// or { ok: false, error: 'timeout' | 'network' | ... }.
async function fetchWithTimeout(url, options, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        clearTimeout(timer);
        let body = null;
        try { body = await res.json(); }
        catch { /* not JSON, ignore */ }
        return { ok: res.ok, status: res.status, body };
    } catch (e) {
        clearTimeout(timer);
        if (e?.name === 'AbortError') {
            return { ok: false, error: 'timeout' };
        }
        return { ok: false, error: 'network', detail: e?.message || String(e) };
    }
}

// ── Connection pre-warming ──────────────────────────────────────────
// The real "printer takes a while to connect" latency is the /healthz probe:
// it establishes the Tailscale Funnel HTTPS session (cold TLS + relay routing)
// AND makes the Pi open a TCP socket to the Brother (waking it from sleep).
// Doing that lazily at Print time = a visible stall. Instead we warm it the
// moment a print surface opens (the user then spends a few seconds picking
// size/copies), and cache the successful probe so the actual Print skips it.
//   lastProbe: the most recent probe result + when it happened.
//   PROBE_FRESH_MS: how long a good probe is trusted (skip re-probing).
let lastProbe = { ok: false, at: 0 };
let warmInFlight = null;          // de-dupe concurrent warms (rapid re-renders)
const PROBE_FRESH_MS = 8000;      // a green probe is trusted for 8s

function probeIsFresh() {
    return lastProbe.ok && (Date.now() - lastProbe.at) < PROBE_FRESH_MS;
}

// Fire-and-forget: open the tunnel + wake the printer ahead of the print.
// Safe to call repeatedly (in-flight de-duped). Never throws.
export async function warmPrintBridge() {
    if (warmInFlight) return warmInFlight;
    warmInFlight = (async () => {
        try {
            const config = await getPrintBridgeConfig();
            if (!config) { lastProbe = { ok: false, at: Date.now() }; return; }
            const probe = await probePrintBridge(config);
            lastProbe = { ok: probe.ok, at: Date.now() };
        } catch { /* warming is best-effort */ }
        finally { warmInFlight = null; }
    })();
    return warmInFlight;
}

// Probe /healthz with a short timeout. Used by the caller to decide
// whether to attempt the bridge or skip straight to the share-sheet
// fallback. Returns { ok, body? }.
export async function probePrintBridge(config) {
    if (!config) return { ok: false, error: 'no_config' };
    const res = await fetchWithTimeout(
        `${config.url}/healthz`,
        { method: 'GET', headers: { Accept: 'application/json' } },
        config.healthCheckTimeoutMs || 800
    );
    if (!res.ok) return { ok: false, error: res.error || 'http_' + res.status };
    const brotherReachable = res.body?.brother?.reachable === true;
    if (!brotherReachable) return { ok: false, error: 'brother_unreachable', body: res.body };
    return { ok: true, body: res.body };
}

// Send a label payload (in the bridge's clean format — see below).
// Returns { ok, body? } or { ok: false, error: <code> }.
export async function sendLabelToBridge(config, payload) {
    if (!config) return { ok: false, error: 'no_config' };
    const res = await fetchWithTimeout(
        `${config.url}/print/label`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-API-Key': config.apiKey,
            },
            body: JSON.stringify(payload),
        },
        // Label render + raster + TCP send can take 2-3 seconds in the worst
        // case. 5s timeout gives headroom without hanging the UI too long.
        5000
    );
    if (!res.ok) {
        return { ok: false, error: res.error || `http_${res.status}`, body: res.body };
    }
    return { ok: true, body: res.body };
}

// Send a free-text label payload. Convenience wrapper.
export async function sendFreeTextToBridge(config, { text, sizeMm, copies = 1 }) {
    if (!config) return { ok: false, error: 'no_config' };
    const res = await fetchWithTimeout(
        `${config.url}/print/free-text`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-API-Key': config.apiKey,
            },
            body: JSON.stringify({ text, sizeMm, copies }),
        },
        5000
    );
    if (!res.ok) {
        return { ok: false, error: res.error || `http_${res.status}`, body: res.body };
    }
    return { ok: true, body: res.body };
}

// ── Payload conversion ─────────────────────────────────────────────
//
// The existing buildLabelPayload() in labelPrinting.js returns a rich
// payload shape designed for the Epson + Brother PDF renderers (titleLines,
// metaLines, prepDateBig, allergens, ingredients, etc.). The Pi bridge
// expects a simpler, vertically-stacked "lines" format. This converter
// lossy-but-faithfully turns one into the other.
//
// Layout decisions baked in here:
//   • Title → big bold lines at top (uses titleScale × 0.6)
//   • Prep date label → small caption above the date number
//   • Prep date number → HUGE (dateNumberScale × 0.45)
//   • Prep time → medium
//   • Meta lines (Use by, By, Loc) → small
//   • Allergens → small + bold, prefixed with ⚠
//   • Ingredients → smallest
//   • Footer → handled by the bridge's separate footer field
//
// Scale factors above are tuned so a 62×40mm label fills nicely. If a
// future label preset comes in much larger / smaller, the bridge's
// renderer auto-scales the base font from the label's height — but
// these relative multipliers stay sane across sizes.
export function payloadToBridgeFormat(payload, { copies = 1 } = {}) {
    const lines = [];

    // 1. Title (already word-wrapped by buildLabelPayload)
    const titleScale = Math.max(Number(payload.titleScale) || 2, 1);
    for (const tl of payload.titleLines || []) {
        const t = String(tl || '').trim();
        if (!t) continue;
        lines.push({ text: t, scale: titleScale * 0.6, bold: true });
    }

    // 2. Prep date label + huge date number
    if (payload.prepDateLabel) {
        lines.push({ text: String(payload.prepDateLabel), scale: 0.7, bold: false });
    }
    if (payload.prepDateNumber) {
        const dateScale = Math.max(Number(payload.dateNumberScale) || 5, 1);
        lines.push({ text: String(payload.prepDateNumber), scale: dateScale * 0.45, bold: true });
    }
    if (payload.prepTimeBig) {
        lines.push({ text: String(payload.prepTimeBig), scale: 0.9, bold: false });
    }

    // 3. Meta lines
    for (const ml of payload.metaLines || []) {
        const t = String(ml || '').trim();
        if (!t) continue;
        lines.push({ text: t, scale: 0.7, bold: false });
    }

    // 4. Allergens — small + bold + warning prefix
    if (Array.isArray(payload.allergens) && payload.allergens.length > 0) {
        const txt = '⚠ ' + payload.allergens.join(', ');
        lines.push({ text: txt, scale: 0.7, bold: true });
    }

    // 5. Ingredients — smallest, dot-separated for compactness
    if (Array.isArray(payload.ingredients) && payload.ingredients.length > 0) {
        const txt = payload.ingredients.join(' • ');
        lines.push({ text: txt, scale: 0.6, bold: false });
    }

    // 6. Notes — only if present, smallest
    if (payload.notes) {
        lines.push({ text: String(payload.notes), scale: 0.6, bold: false });
    }

    return {
        kind: 'prep',
        lines,
        size: {
            widthMm: Number(payload._presetWidthMm) || 62,
            heightMm: Number(payload._presetHeightMm) || 40,
        },
        copies: Math.max(1, Math.min(20, Math.floor(Number(copies) || 1))),
        footer: payload.footer ? String(payload.footer) : 'DD Mau',
    };
}

// ── Top-level "try the bridge, signal whether the caller should fall
// back" helper. labelPrinting.js calls this before its existing
// PDF/share-sheet path. Returns:
//   • { ok: true }                              → printed via bridge, all done
//   • { ok: false, fallback: true, reason }    → bridge unreachable / disabled
//                                                 → caller should run existing path
//   • { ok: false, fallback: false, reason }   → bridge gave us a clear "no"
//                                                 → caller should NOT also try
//                                                 the fallback (e.g. payload was
//                                                 malformed — would fail there too)
export async function tryPrintViaBridge({ payload, copies = 1, freeText = null } = {}) {
    const config = await getPrintBridgeConfig();
    if (!config) {
        return { ok: false, fallback: true, reason: 'bridge_disabled' };
    }

    // Probe first — if the Pi or printer is unreachable, skip the POST
    // (which would either hang or 502) and let the fallback path take over.
    // BUT if we warmed the bridge on modal-open and that probe is still fresh
    // (<8s), skip this probe entirely — the tunnel is up and the printer is
    // awake, so go straight to the POST. This is what makes the actual Print
    // feel instant after opening the sticker.
    if (!probeIsFresh()) {
        const probe = await probePrintBridge(config);
        lastProbe = { ok: probe.ok, at: Date.now() };
        if (!probe.ok) {
            return { ok: false, fallback: true, reason: `probe_${probe.error}` };
        }
    }

    let res;
    if (freeText) {
        res = await sendFreeTextToBridge(config, freeText);
    } else {
        const bridgePayload = payloadToBridgeFormat(payload, { copies });
        res = await sendLabelToBridge(config, bridgePayload);
    }

    if (res.ok) {
        return { ok: true, body: res.body };
    }

    // Bridge POST failed AFTER the health probe passed — probably a
    // mid-print error (out of paper, printer error). Fall back so the
    // user still has a way to print via share-sheet.
    return { ok: false, fallback: true, reason: res.error || 'bridge_error', body: res.body };
}
