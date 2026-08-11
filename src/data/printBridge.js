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
import { Capacitor, CapacitorHttp } from '@capacitor/core';

// Native app? Then we can use CapacitorHttp (the OS network stack) instead
// of WebView fetch(). That matters twice over (Andrew 2026-07-13, "taking a
// long time to connect to the printer… android app users are not connecting
// at all"):
//   1. SPEED — phones and the Pi share the store Wi-Fi, so we can hit the
//      bridge DIRECTLY at its LAN address (~35ms) instead of hairpinning
//      through the Tailscale Funnel relay on the internet (300ms-3s+ cold).
//      WebView fetch can't do that (mixed content: https app → http LAN is
//      blocked, and CORS applies) — native HTTP has neither restriction.
//   2. OLD ANDROIDS — WebView fetch to the *.ts.net funnel needs the
//      Let's Encrypt ISRG root, missing on old Android trust stores, so
//      those phones could never reach the bridge at all. The LAN URL is
//      plain http — no TLS, no root store, no CORS. API key still applies.
const isNativeApp = () => !!Capacitor?.isNativePlatform?.();

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
            // Optional direct LAN address of the Pi (e.g. http://192.168.1.32:8443).
            // Native apps probe it FIRST; if the phone isn't on the store Wi-Fi
            // (or the Pi's IP drifted) the probe fails and the funnel URL wins,
            // so this only ever ADDS speed, never breaks printing.
            lanUrl: data.lanUrl ? String(data.lanUrl).replace(/\/+$/, '') : null,
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
    activeBase = null;
    lastProbe = { ok: false, at: 0 };
}

// Fetch with a timeout. AbortController-based; native fetch doesn't
// accept a timeout option directly. Returns either { ok, status, body }
// or { ok: false, error: 'timeout' | 'network' | ... }.
async function fetchWithTimeout(url, options, timeoutMs) {
    // Native path — CapacitorHttp goes through the OS network stack:
    // no CORS preflight, no mixed-content block (so plain-http LAN URLs
    // work), no dependence on the WebView's TLS root store.
    if (isNativeApp()) {
        try {
            const req = {
                url,
                method: options?.method || 'GET',
                headers: options?.headers || {},
                connectTimeout: timeoutMs,
                readTimeout: timeoutMs,
            };
            if (options?.body) {
                // CapacitorHttp serializes `data` itself from an object.
                try { req.data = JSON.parse(options.body); }
                catch { req.data = options.body; }
            }
            const race = await Promise.race([
                CapacitorHttp.request(req),
                // Belt-and-braces: some platform/plugin combos ignore the
                // native timeouts; never hang the print UI past timeoutMs+1s.
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs + 1000)),
            ]);
            let body = race.data ?? null;
            if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep string */ } }
            return { ok: race.status >= 200 && race.status < 300, status: race.status, body };
        } catch (e) {
            const msg = e?.message || String(e);
            return { ok: false, error: /timeout/i.test(msg) ? 'timeout' : 'network', detail: msg };
        }
    }
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
// Which base URL won the last probe race (LAN or funnel). Sticky so every
// call in a session reuses the fast path; cleared when a probe/POST fails.
let activeBase = null;

function probeIsFresh() {
    return lastProbe.ok && activeBase && (Date.now() - lastProbe.at) < PROBE_FRESH_MS;
}

// The URLs worth trying, fastest first. Native apps on the store Wi-Fi
// try the Pi's LAN address before the Tailscale Funnel; web (HTTPS page)
// can't call a plain-http LAN address (mixed content), so it's funnel-only.
function candidateBases(config) {
    const bases = [];
    if (isNativeApp() && config.lanUrl) bases.push(config.lanUrl);
    if (config.url) bases.push(config.url);
    return bases;
}

async function probeBase(base, timeoutMs) {
    const res = await fetchWithTimeout(
        `${base}/healthz`,
        { method: 'GET', headers: { Accept: 'application/json' } },
        timeoutMs
    );
    if (!res.ok) return { ok: false, error: res.error || 'http_' + res.status };
    const brotherReachable = res.body?.brother?.reachable === true;
    if (!brotherReachable) return { ok: false, error: 'brother_unreachable', body: res.body };
    return { ok: true, body: res.body };
}

// Probe every candidate base IN PARALLEL and adopt the best one (LAN wins
// over funnel whenever both answer). One round-trip decides the session's
// path — a phone off the store Wi-Fi just ends up on the funnel like before.
async function pickBase(config) {
    const bases = candidateBases(config);
    if (bases.length === 0) return { ok: false, error: 'no_config' };
    const timeoutMs = config.healthCheckTimeoutMs || 800;
    const results = await Promise.all(bases.map(b => probeBase(b, timeoutMs)));
    for (let i = 0; i < bases.length; i++) {
        if (results[i].ok) {
            activeBase = bases[i];
            return { ok: true, base: bases[i], body: results[i].body };
        }
    }
    activeBase = null;
    return { ok: false, error: results[results.length - 1]?.error || 'unreachable' };
}

// Fire-and-forget: open the tunnel + wake the printer ahead of the print.
// Safe to call repeatedly (in-flight de-duped). Never throws.
export async function warmPrintBridge() {
    if (warmInFlight) return warmInFlight;
    warmInFlight = (async () => {
        try {
            const config = await getPrintBridgeConfig();
            if (!config) { lastProbe = { ok: false, at: Date.now() }; activeBase = null; return; }
            const picked = await pickBase(config);
            lastProbe = { ok: picked.ok, at: Date.now() };
        } catch { /* warming is best-effort */ }
        finally { warmInFlight = null; }
    })();
    return warmInFlight;
}

// Probe /healthz with a short timeout. Used by the caller to decide
// whether to attempt the bridge or skip straight to the share-sheet
// fallback. Returns { ok, body? }. (Kept for AdminPanel "Test connection";
// races LAN + funnel like the warm path.)
export async function probePrintBridge(config) {
    if (!config) return { ok: false, error: 'no_config' };
    return pickBase(config);
}

// Send a label payload (in the bridge's clean format — see below).
// Returns { ok, body? } or { ok: false, error: <code> }.
export async function sendLabelToBridge(config, payload) {
    if (!config) return { ok: false, error: 'no_config' };
    const res = await fetchWithTimeout(
        `${activeBase || config.url}/print/label`,
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
        `${activeBase || config.url}/print/free-text`,
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
//   • Translated title → second, smaller name line (title2Scale × 0.6)
//   • Prep date label → small caption above the date number
//   • Prep date number → HUGE (dateNumberScale × 0.45)
//   • Prep time → medium (timeScale × 0.45)
//   • Meta lines (Use by, By, Loc) → small (metaScale × 0.7)
//   • Use-by band → big (useByBandScale × 0.4)
//   • Allergens → small + bold, prefixed with ⚠ (allergensScale × 0.7)
//   • Ingredients → smallest (ingredientsScale × 0.6)
//   • Notes → smallest (notesScale × 0.6)
//   • Footer → handled by the bridge's separate footer field
//
// 2026-07-30 — the whole "every text editable" Label Format batch never
// reached the Brother: this converter used to hardcode every scale and
// bold flag, so per-block sizes/bolds and the translated name line were
// silently inert on the Pi. Every multiplier below is now
// `<hardcoded value> ÷ <that field's DEFAULT>`, so a default (or legacy,
// pre-batch) format reproduces the old numbers EXACTLY:
//     timeScale 2→0.9 · metaScale 1→0.7 · useByBandScale 4→1.6 ·
//     allergensScale 1→0.7 · ingredientsScale 1→0.6 · notesScale 1→0.6
// 2026-07-30 (second pass) — the last three flags are now threaded too:
// `titleBold`, `footerBold`, and `dateBold` on the small PREPPED caption.
// They had been left hardcoded to preserve byte-identical output for a
// DEFAULT format, but that traded the wrong thing away: an admin toggling
// "Bold item name" in the Label Format editor saw the Epson change and the
// Brother ignore them, so the editor was lying about half the fleet
// (Andrew: "the format label need to reflect whats the current format for
// the stickers"). Editor truthfulness beats default-output stability, and
// both printers now read the SAME flags. Consequence to know: a never-
// touched (all-default) format now prints a NON-bold title and a BOLD
// footer on the Brother, matching what the Epson has always done and what
// the editor preview shows. The live saved format is unaffected — it has
// titleBold=true / footerBold=false / showPreppedLabel=false, which is
// byte-identical to the old hardcoding.
//
// `footerScale`+`footerBold` reach the canvas only because renderLabelCanvas
// now accepts them; it used to hardcode `600 ${BASE*0.7}px`, which silently
// ate footerScale as well.
//
// Scale factors above are tuned so a 62×40mm label fills nicely. If a
// future label preset comes in much larger / smaller, the bridge's
// renderer auto-scales the base font from the label's height — but
// these relative multipliers stay sane across sizes.
export function payloadToBridgeFormat(payload, { copies = 1 } = {}) {
    const lines = [];
    const clamp = (v, lo, hi, dflt) => Math.max(lo, Math.min(hi, Number(v) || dflt));

    // 0. Brand band (2026-08-11, catering) — black bar, white brand text,
    //    very top of the label. renderLabelCanvas draws lines flagged
    //    `band: true` inverted; the (dormant) Pi bridge ignores the flag.
    if (payload.brandBand) {
        lines.push({ text: String(payload.brandBand), scale: 1.1, bold: true, band: true });
    }

    // 1. Title (already word-wrapped by buildLabelPayload).
    const titleScale = Math.max(Number(payload.titleScale) || 2, 1);
    for (const tl of payload.titleLines || []) {
        const t = String(tl || '').trim();
        if (!t) continue;
        lines.push({ text: t, scale: titleScale * 0.6, bold: !!payload.titleBold });
    }
    // 1b. Translated item name (showTitleTranslation). Was never emitted at
    //     all, so the toggle did nothing on Brother. Empty by default ⇒ no
    //     change to a default label.
    const title2Scale = clamp(payload.title2Scale, 1, 6, 1);
    for (const tl of payload.titleLines2 || []) {
        const t = String(tl || '').trim();
        if (!t) continue;
        lines.push({ text: t, scale: title2Scale * 0.6, bold: !!payload.title2Bold });
    }

    // 2. Prep date label + huge date number
    if (payload.prepDateLabel) {
        // Same dateBold flag the Epson applies to this caption (labelPrinting
        // line ~1339) — the two printers now agree.
        lines.push({ text: String(payload.prepDateLabel), scale: 0.7, bold: payload.dateBold !== false });
    }
    if (payload.prepDateNumber) {
        const dateScale = Math.max(Number(payload.dateNumberScale) || 5, 1);
        lines.push({
            text: String(payload.prepDateNumber),
            scale: dateScale * 0.45,
            bold: payload.dateBold !== false,
        });
    }
    if (payload.prepTimeBig) {
        lines.push({
            text: String(payload.prepTimeBig),
            scale: clamp(payload.timeScale, 1, 4, 2) * 0.45,
            bold: !!payload.timeBold,
        });
    }

    // 3. Meta lines
    const metaScale = clamp(payload.metaScale, 1, 3, 1);
    for (const ml of payload.metaLines || []) {
        const t = String(ml || '').trim();
        if (!t) continue;
        lines.push({ text: t, scale: metaScale * 0.7, bold: !!payload.metaBold });
    }

    // 3b. Giant use-by band (2026-07-26 feature #3) — weekday for day
    // clocks, discard time for hour clocks. Mirrors the Epson renderer.
    if (payload.useByBig) {
        lines.push({
            text: String(payload.useByBig),
            scale: clamp(payload.useByBandScale, 2, 8, 4) * 0.4,
            bold: payload.bandBold !== false,
        });
    }

    // 4. Allergens — small + bold + warning prefix
    if (Array.isArray(payload.allergens) && payload.allergens.length > 0) {
        const txt = '⚠ ' + payload.allergens.join(', ');
        lines.push({
            text: txt,
            scale: clamp(payload.allergensScale, 1, 3, 1) * 0.7,
            bold: payload.allergensBold !== false,
        });
    }

    // 5. Ingredients — smallest, dot-separated for compactness
    if (Array.isArray(payload.ingredients) && payload.ingredients.length > 0) {
        const txt = payload.ingredients.join(' • ');
        lines.push({
            text: txt,
            scale: clamp(payload.ingredientsScale, 1, 3, 1) * 0.6,
            bold: !!payload.ingredientsBold,
        });
    }

    // 6. Notes — only if present, smallest
    if (payload.notes) {
        lines.push({
            text: String(payload.notes),
            scale: clamp(payload.notesScale, 1, 3, 1) * 0.6,
            bold: !!payload.notesBold,
        });
    }

    return {
        kind: 'prep',
        lines,
        size: {
            widthMm: Number(payload._presetWidthMm) || 62,
            heightMm: Number(payload._presetHeightMm) || 40,
        },
        copies: Math.max(1, Math.min(20, Math.floor(Number(copies) || 1))),
        // No 'DD Mau' fallback (2026-07-30): buildLabelPayload already omits
        // the footer when showFooter is OFF, and re-introducing a default
        // here printed "DD Mau" on every label the admin had turned it off
        // for — the exact bug the Epson path fixed.
        footer: payload.footer ? String(payload.footer) : '',
        // Multiplier on the bridge's fixed footer size (height/14). Default
        // 1 = today's exact size; older bridges simply ignore the field.
        footerScale: clamp(payload.footerScale, 1, 3, 1),
        footerBold: payload.footerBold !== false,
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
        const probe = await pickBase(config);
        lastProbe = { ok: probe.ok, at: Date.now() };
        if (!probe.ok) {
            return { ok: false, fallback: true, reason: `probe_${probe.error}` };
        }
    }

    const doSend = () => freeText
        ? sendFreeTextToBridge(config, freeText)
        : sendLabelToBridge(config, payloadToBridgeFormat(payload, { copies }));

    let res = await doSend();

    // If the fast LAN path died between probe and POST (Wi-Fi blip, Pi IP
    // drift), fall back to the funnel once before giving up on the bridge.
    if (!res.ok && activeBase && activeBase !== config.url) {
        activeBase = config.url;
        res = await doSend();
    }

    if (res.ok) {
        return { ok: true, body: res.body };
    }

    // Bridge POST failed AFTER the health probe passed — probably a
    // mid-print error (out of paper, printer error). Fall back so the
    // user still has a way to print via share-sheet.
    return { ok: false, fallback: true, reason: res.error || 'bridge_error', body: res.body };
}
