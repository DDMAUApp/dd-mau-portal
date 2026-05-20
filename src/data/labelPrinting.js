// Date-code / prep label printing — Epson TM-L100 (linerless 80mm).
//
// Andrew 2026-05-20 — Vietnamese Jolt-equivalent feature. Tap "Print
// prep label" on a recipe / inventory item / catering line → an 80mm
// linerless sticker spits out at the kitchen pass with the item
// name, prep date, use-by date, prepped-by employee, allergens, and
// the top ingredients. Sticks to any food container, doesn't peel
// off in the walk-in, no liner to throw away.
//
// ─── Architecture ─────────────────────────────────────────────
// The browser talks DIRECTLY to the printer's built-in HTTP server
// (no Cloud Function, no print server PC, no driver install). This
// is the entire point of Epson's ePOS-Print API:
//
//    Browser  ─POST XML over LAN─►  TM-L100 HTTP server  ─prints─►  label
//
// Endpoint: http://<printer-ip>/cgi-bin/epos/service.cgi?devid=<id>&timeout=<ms>
// Body:     SOAP envelope wrapping an <epos-print> document
// CORS:     The printer's HTTP server has its own CORS allow-list
//           (config'd via the printer's web UI at http://<ip>/). For
//           prod, set it to the GitHub Pages domain OR `*`. If a
//           print 0-times-out / CORS-fails, that's the first place
//           to check.
//
// Connectivity: the browser must be on the same LAN as the printer.
// Staff devices use the restaurant Wi-Fi → the printer's static IP
// is reachable. Off-shift staff trying to print from home → they
// can't reach the printer; we'll detect + degrade gracefully later.
//
// ─── Config model ─────────────────────────────────────────────
// /config/printers/{location} = {
//   name:        "Webster Kitchen Pass"
//   ip:          "192.168.1.42"
//   port:        80              // TM-L100 default
//   deviceId:    "local_printer" // Epson default device id
//   model:       "TM-L100"
//   enabled:     true
//   lastTestedAt: Timestamp
//   lastTestOk:  bool
//   updatedAt:   Timestamp
//   updatedBy:   string
// }
//
// Per-location so a multi-location operator can add stores without
// touching the existing config. Mirrors how ops/inventory_{loc} works.

import { db } from '../firebase';
import { doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { recordAudit } from './audit';

// ── Public types ──────────────────────────────────────────────
// PrinterConfig shape — see header. Defaults applied at print time
// so even a partial config doc renders sane requests.
export const DEFAULT_PRINTER_PORT = 80;
export const DEFAULT_DEVICE_ID = 'local_printer';
export const DEFAULT_TIMEOUT_MS = 10_000;

// Shelf life defaults by recipe category. Tunable — admin can
// override per-recipe (future). Kept conservative so default prints
// always pass an inspector's "looks reasonable" sniff test.
export const DEFAULT_SHELF_LIFE_DAYS = 5;
export const SHELF_LIFE_BY_CATEGORY = Object.freeze({
    'Sauces & Dressings':  7,
    'Stocks & Broths':     5,
    'Marinades & Brines':  4,
    'Proteins':            3,   // raw/marinated proteins
    'Cooked Proteins':     5,
    'Vegetables':          4,
    'Prep':                4,
    'Other':               5,
});

// Resolve the shelf life days for a recipe object. Recipe-level
// override wins; falls back to category-derived; finally to the
// global default. Returns an integer day count.
export function resolveShelfLifeDays(recipe) {
    if (!recipe) return DEFAULT_SHELF_LIFE_DAYS;
    if (Number.isFinite(recipe.shelfLifeDays) && recipe.shelfLifeDays > 0) {
        return Math.floor(recipe.shelfLifeDays);
    }
    const cat = recipe.category || '';
    if (SHELF_LIFE_BY_CATEGORY[cat]) return SHELF_LIFE_BY_CATEGORY[cat];
    return DEFAULT_SHELF_LIFE_DAYS;
}

// ── Config CRUD ───────────────────────────────────────────────
export async function getPrinterConfig(location) {
    if (!location) throw new Error('location required');
    const snap = await getDoc(doc(db, 'config', `printers_${location}`));
    if (!snap.exists()) return null;
    return { id: location, ...snap.data() };
}

// Live subscription — feeds the Print Label modal so a fresh
// admin-side IP change propagates without a tab reload.
export function subscribePrinterConfig(location, cb) {
    if (!location) { cb(null); return () => {}; }
    return onSnapshot(doc(db, 'config', `printers_${location}`), (snap) => {
        cb(snap.exists() ? { id: location, ...snap.data() } : null);
    }, (err) => {
        console.warn('subscribePrinterConfig failed:', err);
        cb(null);
    });
}

export async function savePrinterConfig({ location, name, ip, port, deviceId, model, enabled, byName }) {
    if (!location) throw new Error('location required');
    const trimmedIp = String(ip || '').trim();
    // Lightweight sanity: IPv4-shaped or non-empty hostname. Don't
    // block exotic configs — the print attempt itself will surface
    // network errors better than a regex.
    if (trimmedIp && !/^[0-9a-zA-Z.\-:]+$/.test(trimmedIp)) {
        throw new Error('printer ip looks malformed');
    }
    const payload = {
        name: String(name || '').slice(0, 100) || `${location} printer`,
        ip: trimmedIp,
        port: Number.isFinite(Number(port)) ? Number(port) : DEFAULT_PRINTER_PORT,
        deviceId: String(deviceId || DEFAULT_DEVICE_ID).slice(0, 64),
        model: String(model || 'TM-L100').slice(0, 64),
        enabled: enabled !== false,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    };
    await setDoc(doc(db, 'config', `printers_${location}`), payload, { merge: true });
    recordAudit({
        action: 'printer.config.update',
        actorName: byName || 'admin',
        targetType: 'printer_config',
        targetId: location,
        details: { name: payload.name, ip: payload.ip, model: payload.model, enabled: payload.enabled },
    });
}

// ── Label content layout ──────────────────────────────────────
// Build the printable label payload from input data. Returns an
// object the renderer can stringify. Keeps content building
// separate from XML serialization so we can render previews on
// screen using the same payload shape.
//
// payload shape:
//   { titleLines: string[], metaLines: string[], allergens: string[],
//     ingredients: string[], location: string, footer: string }
export function buildLabelPayload({
    itemName,
    itemNameEs,
    prepDate = new Date(),
    shelfLifeDays = DEFAULT_SHELF_LIFE_DAYS,
    preppedBy,
    location,
    allergens = [],
    ingredients = [],
    language = 'en',
    notes = '',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const useByDate = new Date(prepDate.getTime() + shelfLifeDays * 86400_000);

    const fmtDate = (d) => {
        // Short month/day plus 2-digit year — fits on a 80mm label.
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        return `${mm}/${dd}/${yy}`;
    };
    const fmtTime = (d) => {
        let h = d.getHours();
        const ampm = h >= 12 ? 'p' : 'a';
        h = h % 12 || 12;
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${h}:${m}${ampm}`;
    };

    const titleLine = (isEs && itemNameEs) ? itemNameEs : itemName;
    const titleLines = wrapWords(String(titleLine || 'Item').toUpperCase(), 18);

    const metaLines = [
        `${tx('Prep', 'Hecho')}:   ${fmtDate(prepDate)} ${fmtTime(prepDate)}`,
        `${tx('Use by', 'Caduca')}: ${fmtDate(useByDate)}`,
        `${tx('By', 'Por')}:     ${(preppedBy || '').slice(0, 22)}`,
    ];
    if (location) metaLines.push(`${tx('Loc', 'Loc')}:    ${location}`);

    // Trim allergen list to fit. Allergens go LAST visually so a
    // line that overflows still keeps the date info readable.
    const allergenList = (allergens || []).filter(Boolean).slice(0, 8);

    // Top ingredients — keep first 4 to avoid 4-inch-tall labels.
    const ingredientList = (ingredients || []).filter(Boolean).slice(0, 4);

    return {
        titleLines,
        metaLines,
        allergens: allergenList,
        ingredients: ingredientList,
        notes: String(notes || '').slice(0, 120),
        footer: 'DD MAU',
    };
}

// Soft word-wrap so long names don't get truncated. We split by
// space, packing tokens into lines no longer than `width` chars.
function wrapWords(text, width) {
    const tokens = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const t of tokens) {
        if (!cur) { cur = t; continue; }
        if ((cur + ' ' + t).length <= width) cur += ' ' + t;
        else { lines.push(cur); cur = t; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
}

// ── ePOS-Print XML serialization ──────────────────────────────
// Build the SOAP-wrapped ePOS-Print document. Epson supports a
// rich tag set (text + barcode + image) — we keep this minimal:
// text-only with size + alignment markers. Fits the food-label
// use case and stays printer-firmware-agnostic.
//
// Whitespace in <text> tags is significant; newlines must be
// explicit (&#10; or a wrap in &#10; the API). We use \n as the
// line break — the printer normalizes it.
function escapeXml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function renderEposXml(payload) {
    const lines = [];
    // Header — center + double-size title
    lines.push(`<text align="center"/>`);
    lines.push(`<text width="2" height="2"/>`);
    for (const t of payload.titleLines) {
        lines.push(`<text>${escapeXml(t)}&#10;</text>`);
    }
    // Reset size + left-align for meta
    lines.push(`<text width="1" height="1"/>`);
    lines.push(`<text align="left"/>`);
    lines.push(`<text>------------------------------&#10;</text>`);
    for (const m of payload.metaLines) {
        lines.push(`<text>${escapeXml(m)}&#10;</text>`);
    }
    if (payload.allergens.length > 0) {
        lines.push(`<text>------------------------------&#10;</text>`);
        // Bold for allergens so it's hard to miss on a scan.
        lines.push(`<text em="true"/>`);
        lines.push(`<text>ALLERGENS: ${escapeXml(payload.allergens.join(', '))}&#10;</text>`);
        lines.push(`<text em="false"/>`);
    }
    if (payload.ingredients.length > 0) {
        lines.push(`<text>------------------------------&#10;</text>`);
        for (const ing of payload.ingredients) {
            lines.push(`<text>- ${escapeXml(ing.slice(0, 30))}&#10;</text>`);
        }
    }
    if (payload.notes) {
        lines.push(`<text>------------------------------&#10;</text>`);
        lines.push(`<text>${escapeXml(payload.notes)}&#10;</text>`);
    }
    lines.push(`<text>------------------------------&#10;</text>`);
    lines.push(`<text align="center"/>`);
    lines.push(`<text em="true"/>`);
    lines.push(`<text>${escapeXml(payload.footer || 'DD MAU')}&#10;</text>`);
    lines.push(`<text em="false"/>`);
    lines.push(`<feed line="1"/>`);
    lines.push(`<cut type="feed"/>`);

    return [
        `<?xml version="1.0" encoding="utf-8"?>`,
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">`,
        `<s:Body>`,
        `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">`,
        ...lines,
        `</epos-print>`,
        `</s:Body>`,
        `</s:Envelope>`,
    ].join('');
}

// ── Print transport ───────────────────────────────────────────
// Sends the SOAP envelope to the printer. Returns { ok, status,
// responseXml }.
//
// IMPORTANT — this fires from the browser. The printer must be:
//   • reachable on the local LAN (browser is on restaurant Wi-Fi)
//   • CORS-permissive for our origin (configure via printer web UI)
// Either failure mode = network/fetch error, surfaced to the
// caller for a toast.
export async function sendToPrinter(printer, eposXml) {
    if (!printer || !printer.ip) {
        throw new Error('printer not configured');
    }
    if (printer.enabled === false) {
        throw new Error('printer disabled');
    }
    const port = printer.port || DEFAULT_PRINTER_PORT;
    const devId = printer.deviceId || DEFAULT_DEVICE_ID;
    const url = `http://${printer.ip}:${port}/cgi-bin/epos/service.cgi?devid=${encodeURIComponent(devId)}&timeout=${DEFAULT_TIMEOUT_MS}`;

    // AbortController so the fetch doesn't hang forever if the
    // printer is off. Belt + suspenders alongside the printer's
    // own ?timeout= param.
    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS + 2_000);
    let resp, body = '';
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': '""',
            },
            body: eposXml,
            signal: controller.signal,
        });
        body = await resp.text();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('printer timeout');
        throw e;
    } finally {
        clearTimeout(killer);
    }
    if (!resp.ok) {
        throw new Error(`printer responded ${resp.status}`);
    }
    // Epson returns SOAP with a <response success="true"/> tag on
    // success. Quick string sniff is enough — we don't need a full
    // XML parser for one boolean.
    const successMatch = /success\s*=\s*"(true|false)"/i.exec(body);
    const ok = successMatch ? successMatch[1].toLowerCase() === 'true' : false;
    return { ok, status: resp.status, responseXml: body.slice(0, 500) };
}

// Convenience wrapper — build + send + audit in one call. Caller
// passes the raw inputs; we resolve the printer config and shelf
// life from the inputs.
//
// Returns { ok, error? }. Never throws — even network/CORS errors
// are caught and surfaced as { ok: false, error: '<message>' }
// so the UI can toast cleanly.
export async function printPrepLabel({
    location, recipe, preppedBy, shelfLifeDays, language = 'en',
    notes, byName,
}) {
    try {
        const printer = await getPrinterConfig(location);
        if (!printer || !printer.ip) {
            return { ok: false, error: 'no_printer_configured' };
        }
        const days = Number.isFinite(shelfLifeDays) && shelfLifeDays > 0
            ? Math.floor(shelfLifeDays)
            : resolveShelfLifeDays(recipe);

        const payload = buildLabelPayload({
            itemName: recipe?.titleEn || recipe?.title || 'Item',
            itemNameEs: recipe?.titleEs,
            prepDate: new Date(),
            shelfLifeDays: days,
            preppedBy: preppedBy || byName,
            location: locationLabel(location),
            allergens: recipe?.allergens || [],
            ingredients: pickIngredientsForLabel(recipe, language),
            language,
            notes,
        });
        const xml = renderEposXml(payload);
        const res = await sendToPrinter(printer, xml);
        // Audit every print — who, what, where. Inspector-ready.
        recordAudit({
            action: 'print.label',
            actorName: byName || 'unknown',
            targetType: 'recipe',
            targetId: recipe?.id || recipe?.titleEn || 'unknown',
            details: {
                location,
                itemName: recipe?.titleEn,
                shelfLifeDays: days,
                printerOk: res.ok,
                printerStatus: res.status,
            },
        });
        if (!res.ok) {
            return { ok: false, error: 'printer_rejected' };
        }
        return { ok: true };
    } catch (e) {
        console.warn('printPrepLabel failed:', e);
        return { ok: false, error: e?.message || 'print_failed' };
    }
}

// Helper — pick ingredient lines for the label, language-aware.
// Drop measurements when they bloat the line: most labels just
// need the ingredient identity, not "28 cups".
function pickIngredientsForLabel(recipe, language) {
    if (!recipe) return [];
    const list = language === 'es' && Array.isArray(recipe.ingredientsEs) && recipe.ingredientsEs.length
        ? recipe.ingredientsEs
        : (recipe.ingredientsEn || recipe.ingredients || []);
    // Strip leading "<qty> <unit>" — common pattern in master
    // recipes ("2 cups fish sauce" → "fish sauce"). Not exact but
    // good enough: drop the first 1-2 tokens if they look numeric.
    return list.slice(0, 4).map(line => {
        const m = String(line).match(/^(?:\d+\s*[/\-]?\s*\d*\s*\w{0,12}\s*)?(.*)$/);
        const stripped = (m && m[1]) ? m[1] : line;
        return stripped.trim() || String(line);
    });
}

function locationLabel(loc) {
    if (loc === 'webster') return 'Webster';
    if (loc === 'maryland') return 'MD Heights';
    if (loc === 'both') return 'Both';
    return String(loc || '');
}

// ── Test print ────────────────────────────────────────────────
// Simple fixed-content label so admin can verify a freshly-
// configured printer works before staff start hitting Print.
export async function testPrint({ location, byName }) {
    try {
        const printer = await getPrinterConfig(location);
        if (!printer || !printer.ip) return { ok: false, error: 'no_printer_configured' };
        const payload = buildLabelPayload({
            itemName: 'Printer Test',
            prepDate: new Date(),
            shelfLifeDays: 1,
            preppedBy: byName || 'admin',
            location: locationLabel(location),
            allergens: [],
            ingredients: ['if you see this, printing works'],
            language: 'en',
            notes: 'Test print from DD Mau app',
        });
        const xml = renderEposXml(payload);
        const res = await sendToPrinter(printer, xml);
        // Stamp the printer doc with the test result. Admin UI
        // reads this to show a green ✓ / red ✕ next to the IP.
        try {
            await setDoc(doc(db, 'config', `printers_${location}`), {
                lastTestedAt: serverTimestamp(),
                lastTestOk: res.ok === true,
                lastTestBy: byName || null,
            }, { merge: true });
        } catch (e) {
            console.warn('test-print stamp failed:', e);
        }
        recordAudit({
            action: 'print.test',
            actorName: byName || 'admin',
            targetType: 'printer_config',
            targetId: location,
            details: { printerOk: res.ok, printerStatus: res.status },
        });
        return res.ok
            ? { ok: true }
            : { ok: false, error: 'printer_rejected' };
    } catch (e) {
        console.warn('testPrint failed:', e);
        return { ok: false, error: e?.message || 'test_failed' };
    }
}
