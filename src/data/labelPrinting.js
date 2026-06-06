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
// 2026-06-06 — Native HTTP for direct printer access. On iOS/Android we POST
// to the Epson ePOS endpoint via CapacitorHttp (OS network stack) instead of
// the WebView's fetch. That sidesteps the HTTPS→HTTP mixed-content block AND
// the printer's CORS allow-list — which is what lets the phone/tablet apps
// print straight to the TM-L100 over Wi-Fi with no Pi. Used ONLY for the
// printer call (see sendToPrinter); we never enable the global fetch patch,
// which would route Firestore through native and break its live listeners.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import {
    doc, collection, getDoc, setDoc, addDoc, onSnapshot, serverTimestamp,
    query, orderBy, limit as fsLimit,
} from 'firebase/firestore';
import { recordAudit } from './audit';
import { getLabelFormat } from './labelFormat';
// Pi 5 print bridge — Andrew 2026-05-22. When configured, all Brother
// QL-820NWB prints try the bridge FIRST (HTTPS POST to a Tailscale
// Funnel URL → Flask on the Pi → brother_ql raster → printer). If the
// bridge is disabled, unreachable, or the Brother is offline, we fall
// through to the existing PDF + Web Share Sheet path so date stickers
// still work. See src/data/printBridge.js + /pi5-print-bridge/.
import { tryPrintViaBridge } from './printBridge';

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
//
// 2026-05-20 — Andrew: "add the option to print off the office
// printer or off the kitchen printer". Each location now supports
// multiple "slots": 'kitchen' (default) and 'office'. Per-slot
// docs live at /config/printers_{location}_{slot}. The legacy
// /config/printers_{location} doc is still read as a fallback
// when slot='kitchen' so existing setups keep working without a
// migration step.
export const PRINTER_SLOTS = Object.freeze(['kitchen', 'office']);
export const DEFAULT_PRINTER_SLOT = 'kitchen';

// 2026-05-20 (later same day) — Andrew also asked about non-
// linerless alternatives because linerless thermal might not stick
// to freezer surfaces. So each slot can now be one of two TYPES:
//
//   • epson_linerless — Epson TM-L100 (existing path). Browser
//     POSTs ePOS-Print XML straight to the printer's HTTP server
//     over the LAN. Fully unattended — no dialog, no human in the
//     loop. Best for high-volume kitchen prep where every second
//     matters.
//
//   • brother_ql      — Brother QL-820NWB or similar AirPrint
//     printer using DK adhesive labels (with liner). The browser
//     renders the label as HTML, then calls window.print() in a
//     hidden iframe. The OS print dialog opens and the user picks
//     the Brother via AirPrint discovery. One extra tap vs Epson
//     but supports freezer-safe DK rolls, no bridge or driver
//     install, and zero CORS configuration because the print
//     dialog is the OS, not the printer's HTTP server.
//
// Why expose both: linerless thermal doesn't always grab on cold/
// wet surfaces (deli containers in the walk-in / freezer). DK
// rolls with permanent acrylic adhesive do. Andrew runs both so we
// can pick the right tool per use case (kitchen pass = Epson fast,
// office/walk-in tagging = Brother sticks-to-anything).
export const PRINTER_TYPES = Object.freeze({
    EPSON_LINERLESS: 'epson_linerless',
    BROTHER_QL:      'brother_ql',
});
export const DEFAULT_PRINTER_TYPE = PRINTER_TYPES.EPSON_LINERLESS;

// Brother DK roll defaults — DK-2205 (62mm continuous tape) with a
// 90mm cut length. Admin can change in AdminPanel to match whatever
// roll is loaded (DK-1201 29×90, DK-1247 103×164, etc.).
export const DEFAULT_BROTHER_LABEL_WIDTH_MM  = 62;
export const DEFAULT_BROTHER_LABEL_HEIGHT_MM = 90;

// Label size presets — Andrew 2026-05-20: "lets make 3 tabs in the
// print screen for the labels. 3x3 3x2 3x1.5 or something like that
// depending on the printer and paper size".
//
// 2026-05-20 update: per-printer preset lists, because Andrew is
// running two label printers with different paper widths:
//   • Epson TM-L100 thermal: 80mm-wide continuous (sold as "3-inch
//     thermal paper" — the colloquial restaurant name).
//   • Brother QL-820NWB: 62mm-wide DK-4205-compatible continuous
//     removable roll (2.4" wide × 100ft, black on white).
//
// Both rolls are continuous so we can cut to any length. The
// heights below are the cut lengths each preset asks for.
//
// Architecture:
//   • EPSON_LABEL_PRESETS and BROTHER_LABEL_PRESETS each list 3
//     presets with the same conceptual IDs ('full', 'medium',
//     'small') and the same section-toggle behavior. Only physical
//     dimensions + display names differ.
//   • getLabelSizePresets(printerType) returns the right list at
//     call time. The modal + free-text printer both look up the
//     configured printer's type and feed it through.
//   • LABEL_SIZE_PRESETS stays exported as an alias to the Epson
//     list (matches DEFAULT_PRINTER_TYPE) so any leftover caller
//     that doesn't yet pass printerType still gets sensible dims.
//
// Each preset:
//   • Has physical dimensions (inch + mm) so the Brother HTML
//     @page can size correctly and the Epson knows roughly how
//     much content to fit before cutting.
//   • Carries layout overrides — smaller labels auto-drop non-
//     essential sections so the date + title still dominate.
//
// Admin's saved /config/label_format remains the base; the preset
// applies on top of it at print time. Staff's choice persists in
// localStorage so the same size sticks across prints.
//
// Note on widthIn vs widthMm for Epson: 80mm = 3.15" but staff
// universally call this "3 inch thermal paper", so widthIn shows
// the colloquial 3 while widthMm carries the precise 80 the
// Brother @page CSS would need. Epson prints at its native paper
// width regardless of these values; the dims are mainly for
// display and for the Brother @page rule.
// Andrew 2026-05-20 (later same day): "make the whole tab say small
// medium and large" — staff already know which roll is loaded; the
// tab is just a content-density choice. So the display names drop
// the dimensions; widthIn/heightIn/widthMm/heightMm are kept (still
// used for Brother @page sizing) but no longer shown in the UI.
// ID 'full' is kept (not renamed to 'large') to preserve any value
// staff have already cached in localStorage.
// Tabs render in array order — Andrew wants "small medium and
// large" so the array is in ascending size.
export const EPSON_LABEL_PRESETS = Object.freeze([
    {
        id: 'small',
        nameEn: 'Small',
        nameEs: 'Pequeña',
        widthIn: 3, heightIn: 1.5,
        widthMm: 80, heightMm: 38,
        // Keep only the essentials. Andrew (5/20) "add [the title]
        // next to the date" + (5/21) "small still doesnt have the
        // staff name on it fix it". Show: date, title, use-by, by-
        // name. Hide: ingredients, notes, allergens, location, time,
        // and the "PREPPED" header line (the date number speaks
        // for itself at scale 3).
        showIngredients: false,
        showNotes: false,
        showAllergens: false,
        showLocation: false,
        showTime: false,
        showPreppedLabel: false,
        // showByName left at default (true) so prep cook's initials
        // print on every small sticker.
        // Both date and title at scale 3 — readable + same prominence.
        titleScale: 3,
        dateNumberScale: 3,
    },
    {
        id: 'medium',
        nameEn: 'Medium',
        nameEs: 'Media',
        widthIn: 3, heightIn: 2,
        widthMm: 80, heightMm: 51,
        // Drop the two biggest section blocks so date+title still pop.
        showIngredients: false,
        showNotes: false,
        // Date is still the focal point at scale 5.
    },
    {
        id: 'full',
        nameEn: 'Large',
        nameEs: 'Grande',
        widthIn: 3, heightIn: 3,
        widthMm: 80, heightMm: 80,
        // No section overrides — uses admin's saved format as-is.
        // Default scales unchanged.
    },
]);

export const BROTHER_LABEL_PRESETS = Object.freeze([
    {
        id: 'small',
        nameEn: 'Small',
        nameEs: 'Pequeña',
        widthIn: 2.4, heightIn: 1,
        widthMm: 62, heightMm: 25,
        // Andrew (5/20) "no name. add it next to the date" + (5/21)
        // "small still doesnt have the staff name on it fix it".
        // Brother's CSS sizes the date by % of width (~17mm tall on
        // 62mm wide) which would overflow a 25mm label once we add
        // by-name + use-by. buildBrotherPrintDoc detects short
        // labels (h < 35mm) and switches to a `.compact` rule that
        // scales the date down to fit. titleScale here is honored
        // only by Epson; Brother's title font is in CSS too.
        showIngredients: false,
        showNotes: false,
        showAllergens: false,
        showLocation: false,
        showTime: false,
        showPreppedLabel: false,
        // showByName left at default (true) so prep cook's initials
        // print on every small sticker.
        titleScale: 3,
        dateNumberScale: 2,
    },
    {
        id: 'medium',
        nameEn: 'Medium',
        nameEs: 'Media',
        widthIn: 2.4, heightIn: 1.5,
        widthMm: 62, heightMm: 38,
        showIngredients: false,
        showNotes: false,
    },
    {
        id: 'full',
        nameEn: 'Large',
        nameEs: 'Grande',
        widthIn: 2.4, heightIn: 2.4,
        widthMm: 62, heightMm: 62,
    },
]);

// Backward-compat alias — matches DEFAULT_PRINTER_TYPE so any
// caller that hasn't been updated to pass printerType still gets
// the right defaults.
export const LABEL_SIZE_PRESETS = EPSON_LABEL_PRESETS;

// Return the preset list for a given printer type. Defaults to
// the Epson list when the type is missing/unknown (matches
// DEFAULT_PRINTER_TYPE).
export function getLabelSizePresets(printerType) {
    return printerType === PRINTER_TYPES.BROTHER_QL
        ? BROTHER_LABEL_PRESETS
        : EPSON_LABEL_PRESETS;
}

export const DEFAULT_LABEL_SIZE_PRESET = 'full';

// Apply a preset's overrides on top of a format. Returns a new
// format object — the preset wins for any field it specifies.
// Also stamps the preset's physical dimensions so Brother HTML
// can size the @page correctly. printerType picks which list of
// presets to resolve from (Epson 80mm vs Brother 62mm); defaults
// to Epson to match DEFAULT_PRINTER_TYPE.
export function applyLabelSizePreset(format, presetId, printerType) {
    const list = getLabelSizePresets(printerType);
    const preset = list.find(p => p.id === presetId);
    if (!preset) return format || {};
    const out = { ...(format || {}) };
    // Override section toggles + scales when the preset specifies.
    // showPreppedLabel added 2026-05-20 — Small preset uses it to
    // drop the "PREPPED" line on tight 1"-tall labels so the item
    // name has room to print next to the date.
    for (const k of ['showIngredients', 'showNotes', 'showAllergens',
        'showLocation', 'showByName', 'showTime', 'showTitle',
        'showPreppedLabel',
        'titleScale', 'dateNumberScale']) {
        if (k in preset) out[k] = preset[k];
    }
    // Stamp physical dims for the printer page size.
    out._presetWidthMm = preset.widthMm;
    out._presetHeightMm = preset.heightMm;
    out._presetId = preset.id;
    return out;
}

function printerDocPath(location, slot) {
    const safeSlot = PRINTER_SLOTS.includes(slot) ? slot : DEFAULT_PRINTER_SLOT;
    return `printers_${location}_${safeSlot}`;
}

export async function getPrinterConfig(location, slot = DEFAULT_PRINTER_SLOT) {
    if (!location) throw new Error('location required');
    const safeSlot = PRINTER_SLOTS.includes(slot) ? slot : DEFAULT_PRINTER_SLOT;
    const primary = await getDoc(doc(db, 'config', printerDocPath(location, safeSlot)));
    if (primary.exists()) {
        return { id: location, slot: safeSlot, ...primary.data() };
    }
    // Backward-compat: the legacy single-printer-per-location doc
    // counts as the kitchen printer.
    if (safeSlot === 'kitchen') {
        const legacy = await getDoc(doc(db, 'config', `printers_${location}`));
        if (legacy.exists()) {
            return { id: location, slot: 'kitchen', legacy: true, ...legacy.data() };
        }
    }
    return null;
}

// Live subscription per (location, slot). Feeds the print modals.
export function subscribePrinterConfig(location, cb, slot = DEFAULT_PRINTER_SLOT) {
    if (!location) { cb(null); return () => {}; }
    const safeSlot = PRINTER_SLOTS.includes(slot) ? slot : DEFAULT_PRINTER_SLOT;
    let primaryHit = false;
    const unsubPrimary = onSnapshot(doc(db, 'config', printerDocPath(location, safeSlot)), (snap) => {
        if (snap.exists()) {
            primaryHit = true;
            cb({ id: location, slot: safeSlot, ...snap.data() });
        } else if (safeSlot !== 'kitchen') {
            // Office slot with no doc → no legacy fallback exists.
            primaryHit = false;
            cb(null);
        } else if (!primaryHit) {
            // Wait for the legacy listener below to fire.
        }
    }, (err) => {
        console.warn('subscribePrinterConfig (primary) failed:', err);
        cb(null);
    });
    let unsubLegacy = () => {};
    if (safeSlot === 'kitchen') {
        unsubLegacy = onSnapshot(doc(db, 'config', `printers_${location}`), (snap) => {
            // Legacy fallback only if the primary slot doc isn't there.
            if (primaryHit) return;
            cb(snap.exists()
                ? { id: location, slot: 'kitchen', legacy: true, ...snap.data() }
                : null);
        }, (err) => {
            console.warn('subscribePrinterConfig (legacy) failed:', err);
        });
    }
    return () => { unsubPrimary(); unsubLegacy(); };
}

export async function savePrinterConfig({
    location, slot = DEFAULT_PRINTER_SLOT,
    name, ip, port, deviceId, model, enabled, byName,
    type = DEFAULT_PRINTER_TYPE,
    labelWidthMm, labelHeightMm,
}) {
    if (!location) throw new Error('location required');
    const safeSlot = PRINTER_SLOTS.includes(slot) ? slot : DEFAULT_PRINTER_SLOT;
    const safeType = Object.values(PRINTER_TYPES).includes(type) ? type : DEFAULT_PRINTER_TYPE;
    const trimmedIp = String(ip || '').trim();
    if (trimmedIp && !/^[0-9a-zA-Z.\-:]+$/.test(trimmedIp)) {
        throw new Error('printer ip looks malformed');
    }
    const defaultModel = safeType === PRINTER_TYPES.BROTHER_QL ? 'QL-820NWB' : 'TM-L100';
    const payload = {
        name: String(name || '').slice(0, 100) || `${location} ${safeSlot} printer`,
        ip: trimmedIp,
        port: Number.isFinite(Number(port)) ? Number(port) : DEFAULT_PRINTER_PORT,
        deviceId: String(deviceId || DEFAULT_DEVICE_ID).slice(0, 64),
        model: String(model || defaultModel).slice(0, 64),
        slot: safeSlot,
        type: safeType,
        enabled: enabled !== false,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    };
    // Brother needs DK roll dimensions so the @page CSS matches the
    // physical label. Epson reads these too (default), but the field
    // is only meaningful for the browser-print path.
    if (safeType === PRINTER_TYPES.BROTHER_QL) {
        const w = Number(labelWidthMm);
        const h = Number(labelHeightMm);
        payload.labelWidthMm  = Number.isFinite(w) && w > 0 ? w : DEFAULT_BROTHER_LABEL_WIDTH_MM;
        payload.labelHeightMm = Number.isFinite(h) && h > 0 ? h : DEFAULT_BROTHER_LABEL_HEIGHT_MM;
    }
    await setDoc(doc(db, 'config', printerDocPath(location, safeSlot)), payload, { merge: true });
    recordAudit({
        action: 'printer.config.update',
        actorName: byName || 'admin',
        targetType: 'printer_config',
        targetId: `${location}_${safeSlot}`,
        details: { slot: safeSlot, type: safeType, name: payload.name, ip: payload.ip, enabled: payload.enabled },
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
    // Andrew 2026-05-20: "make a label edit button so i can go in
    // and edit all the labels format at once". `format` carries the
    // admin's saved label preferences — section toggles, sizes, text
    // overrides, date/time formats. Defaults applied when missing.
    format = null,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    // FIX (review 2026-05-22): adding a fixed `shelfLifeDays * 86400000` ms is
    // off by one calendar day across a DST transition. prepDate is a local
    // wall-clock date; near spring-forward a late-night prep overshoots past
    // midnight and prints a use-by date one day too LATE (a food-safety risk),
    // and the (Wed) weekday below is then wrong too. setDate() does true
    // calendar-date arithmetic on the local civil date — DST-safe, preserves
    // the prep time-of-day, and rolls month/year correctly.
    const useByDate = new Date(prepDate);
    useByDate.setDate(useByDate.getDate() + shelfLifeDays);

    const dateFmtIsDayFirst = format?.dateFormat === 'dd/mm/yy';
    const timeFmt24h = format?.timeFormat === '24h';
    const showWeekday = format?.showUseByWeekday !== false;

    const fmtDate = (d) => {
        // Short month/day plus 2-digit year — fits on a 80mm label.
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        return dateFmtIsDayFirst ? `${dd}/${mm}/${yy}` : `${mm}/${dd}/${yy}`;
    };
    const fmtTime = (d) => {
        if (timeFmt24h) {
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        }
        let h = d.getHours();
        const ampm = h >= 12 ? 'p' : 'a';
        h = h % 12 || 12;
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${h}:${m}${ampm}`;
    };

    const titleLine = (isEs && itemNameEs) ? itemNameEs : itemName;
    const titleLines = wrapWords(String(titleLine || 'Item').toUpperCase(), 18);

    // Big prep date at the top — for FIFO scanning. Format-aware:
    // admin can override the "PREPPED" prefix text (e.g. "MADE",
    // "PREP") via /config/label_format.
    const prepDateLabel  = format?.showPreppedLabel === false
        ? ''
        : isEs
            ? (format?.preppedLabelTextEs || 'HECHO')
            : (format?.preppedLabelTextEn || 'PREPPED');
    const prepDateNumber = fmtDate(prepDate);
    const prepDateBig    = prepDateLabel
        ? `${prepDateLabel} ${prepDateNumber}`
        : prepDateNumber;
    const prepTimeBig    = format?.showTime === false ? '' : fmtTime(prepDate);

    const weekday = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][useByDate.getDay()];
    const weekdayEs = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][useByDate.getDay()];
    const metaLines = [];
    if (format?.showUseBy !== false) {
        const useByLine = showWeekday
            ? `${tx('Use by', 'Caduca')}: ${fmtDate(useByDate)} (${isEs ? weekdayEs : weekday})`
            : `${tx('Use by', 'Caduca')}: ${fmtDate(useByDate)}`;
        metaLines.push(useByLine);
    }
    if (format?.showByName !== false) {
        metaLines.push(`${tx('By', 'Por')}:     ${(preppedBy || '').slice(0, 22)}`);
    }
    if (location && format?.showLocation !== false) {
        metaLines.push(`${tx('Loc', 'Loc')}:    ${location}`);
    }

    // Trim allergen list to fit. Allergens go LAST visually so a
    // line that overflows still keeps the date info readable.
    const allergenList = format?.showAllergens === false
        ? []
        : (allergens || []).filter(Boolean).slice(0, 8);

    // Top ingredients — keep first 4 to avoid 4-inch-tall labels.
    const ingredientList = format?.showIngredients === false
        ? []
        : (ingredients || []).filter(Boolean).slice(0, 4);

    const footer = format?.showFooter === false
        ? ''
        : (format?.footerText || 'DD MAU');

    return {
        titleLines: format?.showTitle === false ? [] : titleLines,
        metaLines,
        prepDateLabel,    // e.g. "PREPPED" — small text above the date number
        prepDateNumber,   // e.g. "05/20/26" — printed HUGE
        prepDateBig,      // legacy combined "PREPPED 05/20/26"
        prepTimeBig,
        allergens: allergenList,
        ingredients: ingredientList,
        notes: format?.showNotes === false ? '' : String(notes || '').slice(0, 120),
        footer,
        // Pass through size scales so renderers can apply them.
        dateNumberScale: Number(format?.dateNumberScale) || 5,
        titleScale:      Number(format?.titleScale) || 2,
        // Bug fix 2026-05-20: forward the preset's physical dims +
        // id from the format to the payload. printPrepLabel /
        // printFreeText / buildBrotherPrintDoc all read these off
        // the payload to size the Brother @page rule. Without this
        // forwarding the dims were dropped between applyLabelSize
        // Preset and the printer, so the Brother always printed at
        // the admin's saved printer-config dims regardless of which
        // Small/Medium/Large tab staff picked.
        _presetId:       format?._presetId       || null,
        _presetWidthMm:  format?._presetWidthMm  || null,
        _presetHeightMm: format?._presetHeightMm || null,
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

// Build the inner ePOS body for ONE prep label. Layout (Andrew
// 2026-05-20 "lets also make the lable to be Date it was prep the
// top and largest this helps with FIFO"):
//
//   ┌────────────────────────────────┐
//   │       PREPPED 05/20/26         │  ← width=3 height=3, BOLD
//   │           2:15p                │  ← width=2 height=2
//   │ ============================== │
//   │     Lemongrass Chicken         │  ← width=2 height=2 (title)
//   │ ------------------------------ │
//   │ Use by: 5/25/26 (Wed)          │
//   │ By:     Andrew Shih            │
//   │ Loc:    Webster                │
//   │ ALLERGENS: gluten, soy         │  ← bold
//   │ ------------------------------ │
//   │             DD MAU             │
//   └────────────────────────────────┘
//
// Date goes top + huge so a cook scanning the walk-in for FIFO sees
// "what got made when" at a glance. Item name stays prominent below.
function renderPrepLabelBody(payload) {
    const lines = [];

    // ── HUGE prep date at the top ────────────────────────────
    // 2026-05-20 — Andrew: "lets make the date at the very top in
    // bold and larger". Split into two lines so the date NUMBER
    // (e.g. "05/20/26") fits at width=5 height=5 without wrapping:
    //   PREPPED       ← width=2 height=2, bold
    //   05/20/26      ← width=5 height=5, bold (the HUGE date)
    //   2:15p         ← width=2 height=2
    lines.push(`<text align="center"/>`);
    lines.push(`<text em="true"/>`);
    if (payload.prepDateLabel) {
        lines.push(`<text width="2" height="2"/>`);
        lines.push(`<text>${escapeXml(payload.prepDateLabel)}&#10;</text>`);
    }
    if (payload.prepDateNumber) {
        // Dynamic scale from format config (default 5). Epson supports
        // 1..8 — we clamp to a safe range. Admin can dial up/down via
        // the Label Format editor.
        const dateScale = Math.max(2, Math.min(8, Number(payload.dateNumberScale) || 5));
        lines.push(`<text width="${dateScale}" height="${dateScale}"/>`);
        lines.push(`<text>${escapeXml(payload.prepDateNumber)}&#10;</text>`);
    } else if (payload.prepDateBig) {
        // Back-compat fallback if caller didn't set prepDateNumber.
        lines.push(`<text width="3" height="3"/>`);
        lines.push(`<text>${escapeXml(payload.prepDateBig)}&#10;</text>`);
    }
    lines.push(`<text em="false"/>`);
    // Smaller time line under the date
    if (payload.prepTimeBig) {
        lines.push(`<text width="2" height="2"/>`);
        lines.push(`<text>${escapeXml(payload.prepTimeBig)}&#10;</text>`);
    }
    // Divider
    lines.push(`<text width="1" height="1"/>`);
    lines.push(`<text>==============================&#10;</text>`);

    // ── Item title (admin-scalable) ──────────────────────────
    if (payload.titleLines && payload.titleLines.length > 0) {
        const titleScale = Math.max(1, Math.min(4, Number(payload.titleScale) || 2));
        lines.push(`<text width="${titleScale}" height="${titleScale}"/>`);
        for (const t of payload.titleLines) {
            lines.push(`<text>${escapeXml(t)}&#10;</text>`);
        }
        lines.push(`<text width="1" height="1"/>`);
        lines.push(`<text align="left"/>`);
        lines.push(`<text>------------------------------&#10;</text>`);
    } else {
        lines.push(`<text align="left"/>`);
    }

    // ── Meta (use-by, by, location) ──────────────────────────
    if (payload.metaLines && payload.metaLines.length > 0) {
        for (const m of payload.metaLines) {
            lines.push(`<text>${escapeXml(m)}&#10;</text>`);
        }
    }
    if (payload.allergens.length > 0) {
        lines.push(`<text>------------------------------&#10;</text>`);
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
    if (payload.footer) {
        lines.push(`<text>------------------------------&#10;</text>`);
        lines.push(`<text align="center"/>`);
        lines.push(`<text em="true"/>`);
        lines.push(`<text>${escapeXml(payload.footer)}&#10;</text>`);
        lines.push(`<text em="false"/>`);
    }
    lines.push(`<feed line="1"/>`);
    lines.push(`<cut type="feed"/>`);
    return lines.join('');
}

// Public: render N copies of a prep label inside one SOAP envelope.
// Stitching copies inside a single envelope = one HTTP round-trip,
// printer handles N cuts. Same trick the free-text printer uses.
export function renderEposXml(payload, copies = 1) {
    const c = Math.max(1, Math.min(20, Math.floor(Number(copies) || 1)));
    const body = renderPrepLabelBody(payload);
    const stitched = Array.from({ length: c }, () => body).join('');
    return wrapSoapEnvelope(stitched);
}

// Wrap any ePOS-Print body fragment in the SOAP envelope expected by
// the printer's /cgi-bin/epos/service.cgi endpoint. Factored out so
// the prep-label renderer + free-text renderer share the wrapper.
function wrapSoapEnvelope(innerEposPrintBody) {
    return [
        `<?xml version="1.0" encoding="utf-8"?>`,
        `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">`,
        `<s:Body>`,
        `<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">`,
        innerEposPrintBody,
        `</epos-print>`,
        `</s:Body>`,
        `</s:Envelope>`,
    ].join('');
}

// ── Brother / AirPrint renderer ───────────────────────────────
// Linerless thermal is great for high-volume kitchen labels but
// can lose grip on freezer surfaces. Brother QL-820NWB with DK
// adhesive rolls fills that gap. Instead of speaking the Brother
// raster protocol (binary, browser-hostile, no CORS), we render
// the SAME payload shape as the Epson path into print-ready HTML
// and let the OS print dialog do the routing. The user picks the
// Brother via AirPrint discovery; the OS handles the binary
// translation. One extra tap per print, zero infrastructure.
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// One prep label as HTML body. Layout mirrors the Epson version
// (PREPPED date HUGE at top, item title, meta, allergens, etc.).
function renderPrepLabelHtmlBody(payload) {
    const allergens = (payload.allergens || []).join(', ');
    const metaHtml = (payload.metaLines || []).map(escapeHtml).join('<br>');
    const titleHtml = (payload.titleLines || []).map(escapeHtml).join('<br>');
    const ingredientsHtml = (payload.ingredients && payload.ingredients.length)
        ? payload.ingredients.map(i => '&bull; ' + escapeHtml(i)).join('<br>')
        : '';
    // 2026-05-20 — Andrew: "lets make the date at the very top in
    // bold and larger". Split into label + number; the date number
    // gets its own .prep-date-number style at much bigger font.
    const dateLabel = payload.prepDateLabel
        ? `<div class="prep-date-label">${escapeHtml(payload.prepDateLabel)}</div>`
        : '';
    const dateNumber = payload.prepDateNumber
        ? `<div class="prep-date-number">${escapeHtml(payload.prepDateNumber)}</div>`
        : (payload.prepDateBig
            ? `<div class="prep-date">${escapeHtml(payload.prepDateBig)}</div>`
            : '');
    return [
        '<div class="label">',
        dateLabel,
        dateNumber,
        payload.prepTimeBig ? `<div class="prep-time">${escapeHtml(payload.prepTimeBig)}</div>` : '',
        '<div class="divider"></div>',
        `<div class="title">${titleHtml}</div>`,
        '<div class="divider thin"></div>',
        `<div class="meta">${metaHtml}</div>`,
        allergens ? `<div class="allergens">ALLERGENS: ${escapeHtml(allergens)}</div>` : '',
        ingredientsHtml ? `<div class="ingredients">${ingredientsHtml}</div>` : '',
        payload.notes ? `<div class="notes">${escapeHtml(payload.notes)}</div>` : '',
        `<div class="footer">${escapeHtml(payload.footer || 'DD MAU')}</div>`,
        '</div>',
    ].join('');
}

// One free-text label as HTML body. Honors size/bold/align/stamps
// the same way renderFreeTextBody does for Epson.
function renderFreeTextHtmlBody(freePayload) {
    const sizeClass = ['small', 'normal', 'large', 'huge'].includes(freePayload.size)
        ? freePayload.size : 'normal';
    const align = ['left', 'center', 'right'].includes(freePayload.align)
        ? freePayload.align : 'center';
    const boldClass = freePayload.bold ? ' bold' : '';
    const textLines = String(freePayload.text || '').split(/\r?\n/);
    const bodyLines = textLines.map(t => t
        ? `<div>${escapeHtml(t)}</div>`
        : '<div>&nbsp;</div>').join('');

    const footerLines = [];
    if (freePayload.stampDate) {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        let h = d.getHours(); const ampm = h >= 12 ? 'p' : 'a';
        h = h % 12 || 12;
        const mi = String(d.getMinutes()).padStart(2, '0');
        footerLines.push(`${mm}/${dd}/${yy} ${h}:${mi}${ampm}`);
    }
    if (freePayload.stampSignature && freePayload.signature) {
        footerLines.push(`— ${freePayload.signature}`);
    }
    if (freePayload.footer != null) {
        footerLines.push(String(freePayload.footer).slice(0, 30));
    } else if (footerLines.length > 0) {
        footerLines.push('DD MAU');
    }
    const footerHtml = footerLines.length > 0
        ? `<div class="freetext-footer">${footerLines.map(l => `<div>${escapeHtml(l)}</div>`).join('')}</div>`
        : '';
    return `<div class="freetext ${sizeClass}${boldClass}" style="text-align:${align}">${bodyLines}</div>${footerHtml}`;
}

// Wrap label HTML body(s) in a self-printing HTML document. @page
// size matches the configured DK roll dimensions; typography scales
// proportionally to label width so the layout reads on a 29mm
// address roll just as cleanly as a 102mm shipping roll.
function buildBrotherPrintDoc({ widthMm, heightMm, bodyHtml, copies = 1 }) {
    const w = Math.max(20, Math.min(200, Number(widthMm) || DEFAULT_BROTHER_LABEL_WIDTH_MM));
    const h = Math.max(20, Math.min(300, Number(heightMm) || DEFAULT_BROTHER_LABEL_HEIGHT_MM));
    const c = Math.max(1, Math.min(20, Math.floor(Number(copies) || 1)));
    // Andrew 2026-05-21: "small still doesnt have the staff name on
    // it fix it". Brother small (62 × 25mm) was overflowing once
    // we re-enabled by-name. The default `.prep-date-number` font
    // is 28% of WIDTH = 17mm on 62mm — eats most of a 25mm label
    // before title/meta/by-name even get a chance. Detect short
    // labels (h < 35mm) and emit a `.compact` class on the page
    // that re-scales the typography off label HEIGHT instead.
    const compact = h < 35;
    const pageClass = compact ? 'page compact' : 'page';
    const pages = Array.from({ length: c },
        () => `<section class="${pageClass}">${bodyHtml}</section>`).join('');
    const mm = (x) => `${(Math.max(0, x)).toFixed(2)}mm`;
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>DD Mau Label</title>
<style>
@page { size: ${w}mm ${h}mm; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #000; background: #fff; }
.page { width: ${w}mm; height: ${h}mm; padding: ${mm(Math.min(2, w * 0.04))}; page-break-after: always; overflow: hidden; }
.page.compact { padding: ${mm(Math.min(1.5, w * 0.02))}; }
.page:last-child { page-break-after: auto; }
.label { display: flex; flex-direction: column; height: 100%; gap: ${mm(w * 0.015)}; }
.page.compact .label { gap: ${mm(h * 0.02)}; }
/* 2026-05-20 — Andrew: date BIG at top. Label small ("PREPPED"),
   number HUGE (~28% of label width — covers ~8 chars on 62mm).
   2026-05-21 — short labels (h < 35mm) get .compact overrides
   that size the date + title off HEIGHT so 4 lines (date / title
   / use-by / by-name) all fit on a 25mm-tall Brother small. */
.prep-date-label { font-size: ${mm(w * 0.08)}; font-weight: 700; text-align: center; letter-spacing: 0.5px; text-transform: uppercase; line-height: 1; }
.prep-date-number { font-size: ${mm(w * 0.28)}; font-weight: 900; text-align: center; letter-spacing: -1px; line-height: 0.95; }
.page.compact .prep-date-number { font-size: ${mm(h * 0.36)}; line-height: 1; }
.prep-date { font-size: ${mm(w * 0.16)}; font-weight: 900; text-align: center; letter-spacing: -0.5px; line-height: 1.05; }
.prep-time { font-size: ${mm(w * 0.10)}; text-align: center; }
.divider { border-top: 1.5px dashed #000; margin: ${mm(w * 0.01)} 0; }
.divider.thin { border-top-style: solid; border-top-width: 0.5px; }
.page.compact .divider, .page.compact .divider.thin { margin: ${mm(h * 0.01)} 0; border-top-width: 0.5px; }
.title { font-size: ${mm(w * 0.09)}; font-weight: 700; text-align: center; line-height: 1.1; }
.page.compact .title { font-size: ${mm(h * 0.18)}; line-height: 1; }
.meta { font-size: ${mm(w * 0.055)}; line-height: 1.25; font-variant-numeric: tabular-nums; }
.page.compact .meta { font-size: ${mm(h * 0.10)}; line-height: 1.15; text-align: center; }
.allergens { font-size: ${mm(w * 0.055)}; font-weight: 700; }
.ingredients { font-size: ${mm(w * 0.05)}; }
.notes { font-size: ${mm(w * 0.05)}; font-style: italic; }
.footer { font-size: ${mm(w * 0.055)}; font-weight: 700; text-align: center; margin-top: auto; padding-top: ${mm(w * 0.01)}; }
/* Hide the trailing "DD MAU" footer on compact labels — every mm
   counts and the brand on the sticker is low-value next to date /
   item / use-by / staff name. */
.page.compact .footer { display: none; }
.freetext { white-space: pre-wrap; word-break: break-word; }
.freetext.small  { font-size: ${mm(w * 0.06)}; }
.freetext.normal { font-size: ${mm(w * 0.10)}; }
.freetext.large  { font-size: ${mm(w * 0.14)}; }
.freetext.huge   { font-size: ${mm(w * 0.18)}; }
.freetext.bold   { font-weight: 800; }
.freetext-footer { margin-top: ${mm(w * 0.02)}; padding-top: ${mm(w * 0.01)}; border-top: 0.5px solid #999; text-align: center; font-size: ${mm(w * 0.045)}; color: #333; }
@media print { html, body { background: #fff !important; } }
</style></head>
<body>${pages}
<script>
(function(){
  function go(){ try { window.focus(); window.print(); } catch(e){} }
  if (document.readyState === 'complete') setTimeout(go, 120);
  else window.addEventListener('load', function(){ setTimeout(go, 120); });
})();
</script></body></html>`;
}

// ── Brother PDF renderer ──────────────────────────────────────
// Andrew 2026-05-21: AirPrint on iOS was ignoring the HTML doc's
// `@page { size: 62mm Hmm; }` rule and defaulting to Letter (8.5×11)
// — the preview showed an 8.5×11 page with the label tiny in a
// corner. Switched the Brother path from "render HTML + window.
// print()" to "render a PDF with the page size baked into the PDF
// MediaBox + open in iframe + window.print()". PDF page size lives
// in the file header, not in CSS, so AirPrint can't reflow it.
//
// pdf-lib is already in deps (used by the onboarding fillable-PDF
// flow). Dynamic-import keeps it out of the main bundle.
async function buildBrotherPrintPdfBlob({ widthMm, heightMm, payload, copies = 1, kind = 'prep' }) {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const w = Math.max(20, Math.min(200, Number(widthMm) || DEFAULT_BROTHER_LABEL_WIDTH_MM));
    const h = Math.max(20, Math.min(300, Number(heightMm) || DEFAULT_BROTHER_LABEL_HEIGHT_MM));
    const c = Math.max(1, Math.min(20, Math.floor(Number(copies) || 1)));
    const mmToPt = (mm) => mm * (72 / 25.4);
    const pageWidth = mmToPt(w);
    const pageHeight = mmToPt(h);
    const compact = h < 35;

    const pdf = await PDFDocument.create();
    const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const fontReg = await pdf.embedFont(StandardFonts.Helvetica);
    const fontItalic = await pdf.embedFont(StandardFonts.HelveticaOblique);

    for (let i = 0; i < c; i++) {
        const page = pdf.addPage([pageWidth, pageHeight]);
        if (kind === 'freetext') {
            renderFreeTextOnPdfPage(page, payload, { fontBold, fontReg }, w, h, compact);
        } else {
            renderPrepLabelOnPdfPage(page, payload, { fontBold, fontReg, fontItalic }, w, h, compact);
        }
    }

    const bytes = await pdf.save();
    return new Blob([bytes], { type: 'application/pdf' });
}

// Render a prep-label payload onto a single PDF page. Layout
// mirrors the HTML renderer (date HUGE, title, meta, allergens,
// ingredients, notes, footer) so what came out before still comes
// out — just with a properly-sized PDF page instead of an 8.5×11
// page with the label rendered in one corner.
//
// PDF coords are bottom-up (0,0 at bottom-left) — we track a
// "drawing cursor" `y` that starts at the top and decreases as we
// stack lines downward.
function renderPrepLabelOnPdfPage(page, payload, fonts, widthMm, heightMm, compact) {
    const { fontBold, fontReg, fontItalic } = fonts;
    const mmToPt = (mm) => mm * (72 / 25.4);
    const pageW = mmToPt(widthMm);
    const pageH = mmToPt(heightMm);
    const padding = mmToPt(Math.min(2, widthMm * 0.04));
    let y = pageH - padding;

    const drawCentered = (text, font, fontSize) => {
        const tw = font.widthOfTextAtSize(text, fontSize);
        page.drawText(text, {
            x: Math.max(padding, (pageW - tw) / 2),
            y: y - fontSize,
            size: fontSize,
            font,
        });
        y -= fontSize + mmToPt(0.6);
    };
    const drawLeft = (text, font, fontSize) => {
        page.drawText(text, {
            x: padding,
            y: y - fontSize,
            size: fontSize,
            font,
        });
        y -= fontSize + mmToPt(0.5);
    };

    // Date label (PREPPED) — small caps line above the big date.
    if (payload.prepDateLabel) {
        const size = compact ? mmToPt(heightMm * 0.07) : mmToPt(widthMm * 0.08);
        drawCentered(String(payload.prepDateLabel).toUpperCase(), fontBold, size);
    }
    // Date number — the HUGE focal element.
    if (payload.prepDateNumber) {
        const size = compact ? mmToPt(heightMm * 0.30) : mmToPt(widthMm * 0.26);
        drawCentered(payload.prepDateNumber, fontBold, size);
    } else if (payload.prepDateBig) {
        const size = compact ? mmToPt(heightMm * 0.22) : mmToPt(widthMm * 0.16);
        drawCentered(payload.prepDateBig, fontBold, size);
    }
    if (payload.prepTimeBig) {
        const size = compact ? mmToPt(heightMm * 0.09) : mmToPt(widthMm * 0.09);
        drawCentered(payload.prepTimeBig, fontReg, size);
    }

    // Divider line — thin dashed-look (pdf-lib draws a solid line;
    // close enough to the HTML dashed style, this just visually
    // separates date from title).
    page.drawLine({
        start: { x: padding, y },
        end: { x: pageW - padding, y },
        thickness: 0.5,
    });
    y -= mmToPt(1.5);

    // Title — item name, centered + bold.
    if (Array.isArray(payload.titleLines) && payload.titleLines.length > 0) {
        const size = compact ? mmToPt(heightMm * 0.17) : mmToPt(widthMm * 0.09);
        for (const line of payload.titleLines) {
            if (!line) continue;
            drawCentered(String(line), fontBold, size);
        }
        y -= mmToPt(0.5);
    }

    // Meta lines — use-by, by, location.
    if (Array.isArray(payload.metaLines) && payload.metaLines.length > 0) {
        const size = compact ? mmToPt(heightMm * 0.09) : mmToPt(widthMm * 0.055);
        for (const line of payload.metaLines) {
            if (!line) continue;
            drawLeft(String(line), fontReg, size);
        }
    }
    // Allergens — bold callout.
    if (Array.isArray(payload.allergens) && payload.allergens.length > 0) {
        const size = mmToPt(widthMm * 0.055);
        drawLeft(`ALLERGENS: ${payload.allergens.join(', ')}`, fontBold, size);
    }
    // Ingredients.
    if (Array.isArray(payload.ingredients) && payload.ingredients.length > 0) {
        const size = mmToPt(widthMm * 0.05);
        for (const ing of payload.ingredients) {
            if (!ing) continue;
            drawLeft('• ' + String(ing), fontReg, size);
        }
    }
    // Notes — italic.
    if (payload.notes) {
        const size = mmToPt(widthMm * 0.05);
        drawLeft(String(payload.notes), fontItalic, size);
    }
    // Footer — bottom-anchored, not part of the y cursor. Compact
    // labels hide the brand line to free up vertical space.
    if (!compact && payload.footer) {
        const size = mmToPt(widthMm * 0.055);
        const tw = fontBold.widthOfTextAtSize(payload.footer, size);
        page.drawText(payload.footer, {
            x: (pageW - tw) / 2,
            y: padding,
            size,
            font: fontBold,
        });
    }
}

// Render a free-text payload onto a single PDF page (PrintCenter
// custom prints). Mirrors renderFreeTextHtmlBody: size class
// (small/normal/large/huge), bold, alignment, optional date +
// signature footer.
function renderFreeTextOnPdfPage(page, payload, fonts, widthMm, heightMm /* , compact */) {
    const { fontBold, fontReg } = fonts;
    const mmToPt = (mm) => mm * (72 / 25.4);
    const pageW = mmToPt(widthMm);
    const pageH = mmToPt(heightMm);
    const padding = mmToPt(Math.min(2, widthMm * 0.04));
    let y = pageH - padding;

    const sizeMap = {
        small:  widthMm * 0.06,
        normal: widthMm * 0.10,
        large:  widthMm * 0.14,
        huge:   widthMm * 0.18,
    };
    const fontSize = mmToPt(sizeMap[payload.size] != null ? sizeMap[payload.size] : sizeMap.normal);
    const font = payload.bold ? fontBold : fontReg;
    const align = ['left', 'center', 'right'].includes(payload.align) ? payload.align : 'center';

    const lines = String(payload.text || '').split(/\r?\n/);
    for (const line of lines) {
        const text = line || ' ';
        const tw = font.widthOfTextAtSize(text, fontSize);
        let x = padding;
        if (align === 'center') x = Math.max(padding, (pageW - tw) / 2);
        else if (align === 'right') x = Math.max(padding, pageW - tw - padding);
        page.drawText(text, { x, y: y - fontSize, size: fontSize, font });
        y -= fontSize + mmToPt(0.6);
    }

    // Footer (date stamp / signature / brand) — mirrors the HTML
    // freetext-footer block.
    const footerLines = [];
    if (payload.stampDate) {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        let h = d.getHours(); const ampm = h >= 12 ? 'p' : 'a';
        h = h % 12 || 12;
        const mi = String(d.getMinutes()).padStart(2, '0');
        footerLines.push(`${mm}/${dd}/${yy} ${h}:${mi}${ampm}`);
    }
    if (payload.stampSignature && payload.signature) {
        footerLines.push(`— ${payload.signature}`);
    }
    if (payload.footer != null) {
        footerLines.push(String(payload.footer).slice(0, 30));
    } else if (footerLines.length > 0) {
        footerLines.push('DD MAU');
    }
    if (footerLines.length > 0) {
        const footerSize = mmToPt(widthMm * 0.045);
        let fy = padding + footerLines.length * (footerSize + mmToPt(0.5));
        for (const fl of footerLines) {
            const tw = fontReg.widthOfTextAtSize(fl, footerSize);
            page.drawText(fl, {
                x: Math.max(padding, (pageW - tw) / 2),
                y: fy - footerSize,
                size: footerSize,
                font: fontReg,
            });
            fy -= footerSize + mmToPt(0.5);
        }
    }
}

// Brother transport (PDF + iOS share sheet). Andrew 2026-05-21:
// "the proxy is off on the printer, can we just use the ip and
// bridge straight into the printer?" — direct-IP probe revealed
// the DD Mau app is served over HTTPS and the Brother only speaks
// HTTP, so Safari blocks ALL direct requests via mixed-content
// policy. AirPrint preview showed the label on a full Letter page
// because iOS was advertising Letter as the default paper.
//
// Solution: use the Web Share API to push the rendered PDF to the
// iOS share sheet. From the share sheet the user picks:
//   • Brother iPrint&Scan (best — Brother's native protocol,
//     correct paper sizes, no AirPrint involvement)
//   • Or the system Print action (falls back to AirPrint)
//
// One extra tap per print vs. window.print(), but reliable on
// both printers. Falls back to the legacy iframe-then-print path
// when navigator.share() isn't available (desktop browsers,
// older iOS, share-sheet rejected by the user, etc.).
async function sendBrotherPdfViaShareSheet(pdfBlob, fileNameHint = 'DD-Mau-Label.pdf') {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
            const file = new File([pdfBlob], fileNameHint, { type: 'application/pdf' });
            // canShare check is important — calling share() with
            // unsupported MIME on some browsers throws synchronously.
            const canShareFiles = typeof navigator.canShare === 'function'
                ? navigator.canShare({ files: [file] })
                : true;
            if (canShareFiles) {
                await navigator.share({
                    files: [file],
                    title: 'DD Mau Label',
                });
                return { ok: true, status: 200, responseXml: 'web_share_dispatched' };
            }
        } catch (e) {
            // AbortError = user dismissed the share sheet. That's a
            // legit "no print this time" outcome — return ok:true
            // so the caller doesn't surface a scary toast. Other
            // errors fall through to the iframe fallback.
            if (e && e.name === 'AbortError') {
                return { ok: true, status: 200, responseXml: 'share_dismissed' };
            }
            console.warn('navigator.share failed, falling back to iframe:', e);
            // fall through to iframe fallback below
        }
    }
    // Fallback: legacy iframe-then-print path. Useful on desktop
    // browsers (which don't support Web Share API with files) and
    // as a safety net if share() is unavailable. Same code as the
    // previous PDF-iframe path.
    return sendBrotherPdfToBrowserPrintDialog(pdfBlob);
}

// Brother transport (PDF path). Same iframe-then-print pattern as
// the HTML path, but uses a blob: URL pointing at a PDF instead of
// writing HTML inline. The PDF carries explicit page dimensions in
// its MediaBox so iOS AirPrint can't reflow it to letter.
async function sendBrotherPdfToBrowserPrintDialog(pdfBlob) {
    if (typeof document === 'undefined') {
        return { ok: false, status: 0, responseXml: 'no_document' };
    }
    return new Promise((resolve) => {
        const url = URL.createObjectURL(pdfBlob);
        const iframe = document.createElement('iframe');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        document.body.appendChild(iframe);

        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            // Hold the iframe + blob URL for 90 s so the OS print
            // dialog has time to read the document. Print dialogs
            // are opaque to JS — we can't be told when they close.
            setTimeout(() => {
                try { iframe.remove(); } catch {}
                try { URL.revokeObjectURL(url); } catch {}
            }, 90_000);
            resolve(result);
        };

        iframe.onload = () => {
            // Give the embedded PDF viewer a moment to lay out
            // before triggering print. Mobile Safari especially
            // needs ~200-400ms here.
            setTimeout(() => {
                try {
                    iframe.contentWindow.focus();
                    iframe.contentWindow.print();
                    finish({ ok: true, status: 200, responseXml: 'browser_print_dialog_pdf' });
                } catch (e) {
                    console.warn('PDF iframe print failed:', e);
                    finish({ ok: false, status: 0, responseXml: 'pdf_print_failed' });
                }
            }, 350);
        };
        iframe.onerror = () => {
            finish({ ok: false, status: 0, responseXml: 'pdf_iframe_error' });
        };

        try {
            iframe.src = url;
        } catch (e) {
            console.warn('PDF iframe src failed:', e);
            finish({ ok: false, status: 0, responseXml: 'pdf_iframe_src_failed' });
        }

        // Hard-stop in case the iframe never fires onload (rare,
        // but happens if the browser can't decode the blob).
        setTimeout(() => {
            finish({ ok: false, status: 0, responseXml: 'pdf_iframe_timeout' });
        }, 30_000);
    });
}

// Brother transport. Render the label HTML inside a hidden iframe
// and trigger window.print(). User picks the Brother via AirPrint
// in the system dialog. We can't read the result (print dialog is
// opaque to JS) — we treat "iframe wrote successfully" as ok.
//
// Must be called from a user gesture (button click), because some
// browsers block window.print() outside of one. All our call sites
// are click-handlers so this is fine.
//
// Kept for non-Brother paths / future debugging; the live Brother
// path now uses sendBrotherPdfToBrowserPrintDialog above.
// eslint-disable-next-line no-unused-vars
async function sendToBrowserPrintDialog(htmlString) {
    if (typeof document === 'undefined') {
        return { ok: false, status: 0, responseXml: 'no_document' };
    }
    return new Promise((resolve) => {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.style.position = 'fixed';
        iframe.style.right = '0';
        iframe.style.bottom = '0';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = '0';
        iframe.style.opacity = '0';
        iframe.style.pointerEvents = 'none';
        document.body.appendChild(iframe);
        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            // Keep iframe around long enough for the OS print dialog
            // to grab the document, then clean up. 90s = plenty of
            // time for a user to pick a printer and confirm.
            setTimeout(() => { try { document.body.removeChild(iframe); } catch {} }, 90_000);
            resolve(result);
        };
        try {
            const innerDoc = iframe.contentWindow.document;
            innerDoc.open();
            innerDoc.write(htmlString);
            innerDoc.close();
            // The embedded <script> calls print() once the document
            // is loaded. Give it a moment to fire before we resolve.
            setTimeout(() => finish({ ok: true, status: 200, responseXml: 'browser_print_dialog' }), 350);
        } catch (e) {
            console.warn('browser print dialog failed:', e);
            try { document.body.removeChild(iframe); } catch {}
            finish({ ok: false, status: 0, responseXml: 'iframe_write_failed' });
        }
    });
}

// ── Free-text "Print Center" renderer ─────────────────────────
// Andrew 2026-05-20 — Word-style mini print app. Builds an ePOS-
// Print body for arbitrary multi-line text with optional global
// size / bold / alignment. Each call adds one cut, but the caller
// can stitch N copies into a single envelope via renderFreeTextXml
// with `copies > 1` to print multiple identical labels in one
// network round trip.
//
// freePayload shape:
//   { text:    string            — multi-line; \n delimits lines
//     size:    'small'|'normal'|'large'|'huge'
//     bold:    boolean
//     align:   'left'|'center'|'right'
//     copies:  number 1..20
//     stampDate: boolean         — appends MM/DD/YY footer line
//     stampSignature: boolean    — appends "— <name>" footer line
//     signature: string          — name to use if stampSignature
//     footer:  string?           — overrides the "DD MAU" stamp
//   }
const SIZE_DIM = Object.freeze({
    small:  { width: 1, height: 1 },
    normal: { width: 2, height: 2 },
    large:  { width: 3, height: 3 },
    huge:   { width: 4, height: 4 },
});
function sizeDim(size) {
    return SIZE_DIM[size] || SIZE_DIM.normal;
}

// Build the inner ePOS body for a SINGLE label (no envelope, no
// top-level cut sequencing). renderFreeTextXml wraps this N times.
function renderFreeTextBody(freePayload) {
    const lines = [];
    const dim = sizeDim(freePayload.size);
    const align = ['left', 'center', 'right'].includes(freePayload.align)
        ? freePayload.align : 'center';
    lines.push(`<text align="${align}"/>`);
    lines.push(`<text width="${dim.width}" height="${dim.height}"/>`);
    if (freePayload.bold) lines.push(`<text em="true"/>`);

    // Split user text on newlines + trim trailing whitespace. Empty
    // lines render as feed gaps — useful for spacing.
    const rawText = String(freePayload.text || '');
    const textLines = rawText.split(/\r?\n/).map(l => l.slice(0, 80));
    for (const t of textLines) {
        // Empty lines become a small feed so vertical spacing is
        // preserved without a blank `<text>` (which the printer
        // sometimes collapses).
        if (!t) {
            lines.push(`<feed line="1"/>`);
        } else {
            lines.push(`<text>${escapeXml(t)}&#10;</text>`);
        }
    }
    if (freePayload.bold) lines.push(`<text em="false"/>`);

    // Optional auto-footer block — small text below the body so it
    // doesn't dwarf the user's content.
    const footerLines = [];
    if (freePayload.stampDate) {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        let h = d.getHours(); const ampm = h >= 12 ? 'p' : 'a';
        h = h % 12 || 12;
        const mi = String(d.getMinutes()).padStart(2, '0');
        footerLines.push(`${mm}/${dd}/${yy} ${h}:${mi}${ampm}`);
    }
    if (freePayload.stampSignature && freePayload.signature) {
        footerLines.push(`— ${freePayload.signature}`);
    }
    if (freePayload.footer != null) {
        footerLines.push(String(freePayload.footer).slice(0, 30));
    } else if (footerLines.length > 0 || freePayload.stampDate || freePayload.stampSignature) {
        // Default footer if any stamp is present, just to anchor the label.
        footerLines.push('DD MAU');
    }
    if (footerLines.length > 0) {
        // Reset to small + center for the stamp block, regardless of
        // user formatting choices for the body.
        lines.push(`<text width="1" height="1"/>`);
        lines.push(`<text align="center"/>`);
        lines.push(`<feed line="1"/>`);
        for (const f of footerLines) {
            lines.push(`<text>${escapeXml(f)}&#10;</text>`);
        }
    }
    lines.push(`<feed line="1"/>`);
    lines.push(`<cut type="feed"/>`);
    return lines.join('');
}

export function renderFreeTextXml(freePayload) {
    const copies = Math.max(1, Math.min(20, Math.floor(Number(freePayload.copies) || 1)));
    // Stitch N copies inside the same envelope = one HTTP round-trip,
    // printer handles N cuts sequentially. Significantly faster than
    // POSTing N separate envelopes for a stack of identical labels.
    const oneBody = renderFreeTextBody(freePayload);
    const stitched = Array.from({ length: copies }, () => oneBody).join('');
    return wrapSoapEnvelope(stitched);
}

// Convenience wrapper — like printPrepLabel but for free-text. The
// audit row captures a preview of the text body (first 80 chars) so
// admins can see what was printed without full content (privacy +
// log volume).
export async function printFreeText({
    location, slot = DEFAULT_PRINTER_SLOT,
    text, size, bold, align, copies = 1,
    stampDate = false, stampSignature = false, signature, footer,
    byName,
    presetId = DEFAULT_LABEL_SIZE_PRESET,
}) {
    try {
        const printer = await getPrinterConfig(location, slot);
        if (!printer) return { ok: false, error: 'no_printer_configured' };
        const type = printer.type || DEFAULT_PRINTER_TYPE;
        // Epson needs a reachable IP. Brother goes through the OS
        // print dialog (AirPrint), so it works even with no IP.
        if (type !== PRINTER_TYPES.BROTHER_QL && !printer.ip) {
            return { ok: false, error: 'no_printer_configured' };
        }
        if (printer.enabled === false) {
            return { ok: false, error: 'printer_disabled' };
        }
        const trimmed = String(text || '').trim();
        if (!trimmed) return { ok: false, error: 'empty_text' };
        if (trimmed.length > 2000) {
            return { ok: false, error: 'text_too_long' };
        }
        const c = Math.max(1, Math.min(20, Math.floor(Number(copies) || 1)));
        const freePayload = {
            text: trimmed, size, bold, align,
            copies: c, stampDate, stampSignature, signature, footer,
        };
        // Resolve preset dimensions for Brother @page sizing. Free-
        // text printing doesn't go through buildLabelPayload so we
        // pull the preset directly here. Pick the right preset list
        // based on the printer's type so Epson gets 80mm dims and
        // Brother gets 62mm dims.
        const presetDims = getLabelSizePresets(type).find(p => p.id === presetId);

        let res;
        let transport = null;
        if (type === PRINTER_TYPES.BROTHER_QL) {
            // 1. Try the Pi print bridge first. Free-text goes through
            //    its own bridge endpoint (POST /print/free-text) so the
            //    Pi can render it tighter than the prep-label layout.
            const bridgeAttempt = await tryPrintViaBridge({
                copies: c,
                freeText: {
                    text: trimmed,
                    sizeMm: {
                        widthMm:  presetDims?.widthMm  || DEFAULT_BROTHER_LABEL_WIDTH_MM,
                        heightMm: presetDims?.heightMm || DEFAULT_BROTHER_LABEL_HEIGHT_MM,
                    },
                    copies: c,
                },
            });
            if (bridgeAttempt.ok) {
                res = { ok: true, status: 200, via: 'bridge' };
                transport = 'bridge';
            } else {
                if (!bridgeAttempt.fallback) {
                    return { ok: false, error: bridgeAttempt.reason || 'bridge_rejected' };
                }
                // 2. Fallback — PDF + iOS Share Sheet (existing path).
                const pdfBlob = await buildBrotherPrintPdfBlob({
                    widthMm:  presetDims?.widthMm  || printer.labelWidthMm  || DEFAULT_BROTHER_LABEL_WIDTH_MM,
                    heightMm: presetDims?.heightMm || printer.labelHeightMm || DEFAULT_BROTHER_LABEL_HEIGHT_MM,
                    payload: freePayload,
                    copies: c,
                    kind: 'freetext',
                });
                res = await sendBrotherPdfViaShareSheet(pdfBlob, `DD-Mau-FreeText.pdf`);
                transport = `pdf_share_sheet (bridge fallback: ${bridgeAttempt.reason})`;
            }
        } else {
            const xml = renderFreeTextXml(freePayload);
            res = await sendToPrinter(printer, xml);
            transport = 'epson_epos';
        }
        recordAudit({
            action: 'print.freetext',
            actorName: byName || 'unknown',
            targetType: 'printer',
            targetId: `${location}_${slot}`,
            details: {
                location,
                slot,
                type,
                preview: trimmed.slice(0, 80),
                size, bold, align, copies: c,
                printerOk: res.ok,
                printerStatus: res.status,
                transport, // 'bridge' | 'pdf_share_sheet (...)' | 'epson_epos'
            },
        });
        if (!res.ok) return { ok: false, error: 'printer_rejected' };
        return { ok: true };
    } catch (e) {
        console.warn('printFreeText failed:', e);
        return { ok: false, error: e?.message || 'print_failed' };
    }
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
export async function sendToPrinter(printer, eposXml, meta = {}) {
    // Capture the start time so the print job log records latency.
    // Useful when diagnosing "is the printer slow today?" — Pi bridges
    // on busy Wi-Fi can stretch from ~150ms to several seconds.
    const startedAt = Date.now();
    // Wrapper to capture every attempt's outcome to /print_jobs.
    // We log success AND failure so the Label Printing Center can
    // surface "why didn't my label print?" without admin having to
    // open DevTools. Logging is fire-and-forget; a failure to log
    // never blocks the actual print.
    const finalize = (outcome) => {
        try {
            logPrintAttempt({
                printer,
                meta,
                outcome,
                durationMs: Date.now() - startedAt,
            });
        } catch { /* logging is best-effort */ }
    };

    if (!printer || !printer.ip) {
        finalize({ ok: false, error: 'not_configured' });
        throw new Error('printer not configured');
    }
    if (printer.enabled === false) {
        finalize({ ok: false, error: 'disabled' });
        throw new Error('printer disabled');
    }
    const port = printer.port || DEFAULT_PRINTER_PORT;
    const devId = printer.deviceId || DEFAULT_DEVICE_ID;
    const url = `http://${printer.ip}:${port}/cgi-bin/epos/service.cgi?devid=${encodeURIComponent(devId)}&timeout=${DEFAULT_TIMEOUT_MS}`;

    // Transport split (2026-06-06):
    //   • Native (iOS/Android) → CapacitorHttp.post — the request goes through
    //     the OS network stack, NOT the WebView, so it bypasses the HTTPS→HTTP
    //     mixed-content block AND the printer's CORS allow-list. This is the
    //     no-Pi path: phone/tablet prints straight to the TM-L100 over Wi-Fi.
    //     Needs native cleartext + local-network permission (AndroidManifest
    //     usesCleartextTraffic + iOS NSAllowsLocalNetworking / usage string).
    //   • Web/PWA/desktop → plain fetch. NOTE: blocked by browser mixed-content
    //     when the app is HTTPS and the printer is HTTP, so direct printing
    //     from a browser won't work — use the native app (or the Pi bridge).
    //     Kept for localhost/dev and any future HTTPS-capable printer.
    const TIMEOUT = DEFAULT_TIMEOUT_MS + 2_000;
    let httpStatus = 0;
    let body = '';
    try {
        if (Capacitor.isNativePlatform()) {
            const native = await CapacitorHttp.post({
                url,
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '""' },
                data: eposXml,                 // already a string — sent as-is
                responseType: 'text',          // ePOS replies with XML, not JSON
                readTimeout: TIMEOUT,
                connectTimeout: TIMEOUT,
            });
            httpStatus = native?.status || 0;
            body = typeof native?.data === 'string' ? native.data : String(native?.data ?? '');
        } else {
            // AbortController so the fetch doesn't hang forever if the
            // printer is off. Belt + suspenders alongside the printer's
            // own ?timeout= param.
            const controller = new AbortController();
            const killer = setTimeout(() => controller.abort(), TIMEOUT);
            try {
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/xml; charset=utf-8',
                        'SOAPAction': '""',
                    },
                    body: eposXml,
                    signal: controller.signal,
                });
                httpStatus = resp.status;
                body = await resp.text();
            } finally {
                clearTimeout(killer);
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            finalize({ ok: false, error: 'timeout' });
            throw new Error('printer timeout');
        }
        finalize({ ok: false, error: e?.message || 'network_error' });
        throw e;
    }
    if (httpStatus >= 400) {
        finalize({ ok: false, error: `http_${httpStatus}` });
        throw new Error(`printer responded ${httpStatus}`);
    }
    // Epson returns SOAP with a <response success="true"/> tag on
    // success. Quick string sniff is enough — we don't need a full
    // XML parser for one boolean.
    const successMatch = /success\s*=\s*"(true|false)"/i.exec(body);
    const ok = successMatch ? successMatch[1].toLowerCase() === 'true' : false;
    finalize({
        ok,
        status: httpStatus,
        // If the printer reported success=false, surface the body
        // snippet so admin can see "media empty", "cover open",
        // "wrong tape", etc. in the Label Center.
        printerMessage: !ok ? body.slice(0, 200) : null,
    });
    return { ok, status: httpStatus, responseXml: body.slice(0, 500) };
}

// ── Print job log ──────────────────────────────────────────────
// Every sendToPrinter call writes one /print_jobs row with the
// outcome. The Label Printing Center reads this collection to
// surface a "recent jobs" feed with success/fail status, latency,
// and the printer error message when the device rejected the job.
// Bounded by the dashboard's `limit(50)` — we never expect to
// scan the full collection from the client.
async function logPrintAttempt({ printer, meta, outcome, durationMs }) {
    try {
        await addDoc(collection(db, 'print_jobs'), {
            // Printer context — keeps the log readable when admin
            // looks at "all printers' jobs" rather than per-device.
            // NOTE: getPrinterConfig/subscribePrinterConfig expose the
            // location as `id` (e.g. 'webster'/'maryland'), NOT a
            // `location` field — the saved printer doc has no such
            // field. Reading printer?.location always yielded null, so
            // every print_jobs row logged location:null and the Label
            // Printing Center's per-printer filter (j.location === loc)
            // matched zero rows. Use printer?.id.
            location: printer?.id || printer?.location || meta?.location || null,
            slot:     printer?.slot     || meta?.slot     || null,
            printerName: printer?.name || null,
            printerIp:   printer?.ip   || null,
            printerType: printer?.type || null,
            // Label content for the recent-jobs UI. Caller-provided
            // metadata so we don't have to parse XML to surface a
            // human label.
            kind:      meta?.kind     || 'label',   // 'label'|'date'|'free_text'|'test'
            title:     meta?.title    || null,      // e.g. "Pho Broth · 5 days"
            byName:    meta?.byName   || null,
            source:    meta?.source   || null,
            copies:    Number(meta?.copies || 1),
            // Outcome.
            ok:        outcome.ok === true,
            error:     outcome.error || null,
            printerMessage: outcome.printerMessage || null,
            durationMs: Number(durationMs || 0),
            // Server timestamp so the dashboard can sort + show
            // "Xm ago" relative times.
            createdAt: serverTimestamp(),
        });
    } catch (e) {
        console.warn('logPrintAttempt failed:', e);
    }
}

// Live subscription for the Label Printing Center. Newest first,
// bounded at 50. The page also derives per-printer stats from
// this snapshot (recent failure rate, last successful print).
export function subscribePrintJobs(cb, max = 50) {
    const q = query(
        collection(db, 'print_jobs'),
        orderBy('createdAt', 'desc'),
        fsLimit(max),
    );
    const unsub = onSnapshot(q, (snap) => {
        const out = [];
        snap.forEach(d => out.push({ id: d.id, ...d.data() }));
        cb(out);
    }, (err) => {
        console.warn('print_jobs subscription failed:', err);
        cb([]);
    });
    return unsub;
}

// Convenience wrapper — build + send + audit in one call. Caller
// passes the raw inputs; we resolve the printer config and shelf
// life from the inputs.
//
// Returns { ok, error? }. Never throws — even network/CORS errors
// are caught and surfaced as { ok: false, error: '<message>' }
// so the UI can toast cleanly.
export async function printPrepLabel({
    location, slot = DEFAULT_PRINTER_SLOT,
    recipe, preppedBy, shelfLifeDays, language = 'en',
    notes, byName, copies = 1, source = 'recipe',
    presetId = DEFAULT_LABEL_SIZE_PRESET,
}) {
    try {
        const printer = await getPrinterConfig(location, slot);
        if (!printer) return { ok: false, error: 'no_printer_configured' };
        const type = printer.type || DEFAULT_PRINTER_TYPE;
        // Epson needs a reachable IP. Brother goes through the OS
        // print dialog (AirPrint), so it works even with no IP.
        if (type !== PRINTER_TYPES.BROTHER_QL && !printer.ip) {
            return { ok: false, error: 'no_printer_configured' };
        }
        if (printer.enabled === false) {
            return { ok: false, error: 'printer_disabled' };
        }
        const baseFormat = await getLabelFormat();
        // Pass the printer's type so the right preset list (Epson
        // 80mm vs Brother 62mm) resolves the physical dims stamped
        // onto the payload.
        const format = applyLabelSizePreset(baseFormat, presetId, type);
        const days = Number.isFinite(shelfLifeDays) && shelfLifeDays > 0
            ? Math.floor(shelfLifeDays)
            : (resolveShelfLifeDays(recipe) || baseFormat?.defaultShelfLifeDays || DEFAULT_SHELF_LIFE_DAYS);
        const c = Math.max(1, Math.min(20, Math.floor(Number(copies) || 1)));

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
            format,
        });

        let res;
        // Tracks how the label got printed for the audit log — useful
        // when debugging "did it go via the bridge or fall back?"
        let transport = null;
        if (type === PRINTER_TYPES.BROTHER_QL) {
            // 1. Try the Pi print bridge first (Andrew 2026-05-22).
            //    Fully automatic, prints to Brother in ~2s, correct
            //    label dimensions every time. The bridge probes /healthz
            //    first; if Pi or Brother is unreachable it cleanly
            //    returns { fallback: true } and we drop to the
            //    PDF/share-sheet path below — staff never see a hang.
            const bridgeAttempt = await tryPrintViaBridge({ payload, copies: c });
            if (bridgeAttempt.ok) {
                res = { ok: true, status: 200, via: 'bridge' };
                transport = 'bridge';
            } else {
                if (!bridgeAttempt.fallback) {
                    // Bridge said "no — and don't try the fallback either"
                    // (e.g. malformed payload). Bubble the error up rather
                    // than printing a broken label via share-sheet.
                    return { ok: false, error: bridgeAttempt.reason || 'bridge_rejected' };
                }
                // 2. Fallback — PDF + iOS Share Sheet. Pre-existing path
                //    from before the bridge existed. Manual taps but
                //    works offline-from-the-bridge.
                const pdfBlob = await buildBrotherPrintPdfBlob({
                    widthMm:  payload._presetWidthMm  || printer.labelWidthMm  || DEFAULT_BROTHER_LABEL_WIDTH_MM,
                    heightMm: payload._presetHeightMm || printer.labelHeightMm || DEFAULT_BROTHER_LABEL_HEIGHT_MM,
                    payload,
                    copies: c,
                    kind: 'prep',
                });
                // Use the printed item name in the share-sheet preview
                // so the user can see what they're about to print.
                const safeName = String(recipe?.titleEn || 'Label')
                    .replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40);
                res = await sendBrotherPdfViaShareSheet(pdfBlob, `DD-Mau-${safeName}.pdf`);
                transport = `pdf_share_sheet (bridge fallback: ${bridgeAttempt.reason})`;
            }
        } else {
            const xml = renderEposXml(payload, c);
            res = await sendToPrinter(printer, xml);
            transport = 'epson_epos';
        }
        recordAudit({
            action: 'print.label',
            actorName: byName || 'unknown',
            targetType: source === 'datestickers' ? 'menu_component' : 'recipe',
            targetId: recipe?.id || recipe?.titleEn || 'unknown',
            details: {
                location,
                slot,
                type,
                itemName: recipe?.titleEn,
                shelfLifeDays: days,
                copies: c,
                source, // 'recipe' | 'datestickers' | 'operations'
                printerOk: res.ok,
                printerStatus: res.status,
                transport, // 'bridge' | 'pdf_share_sheet (...)' | 'epson_epos'
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
export async function testPrint({ location, slot = DEFAULT_PRINTER_SLOT, byName }) {
    try {
        const printer = await getPrinterConfig(location, slot);
        if (!printer) return { ok: false, error: 'no_printer_configured' };
        const type = printer.type || DEFAULT_PRINTER_TYPE;
        if (type !== PRINTER_TYPES.BROTHER_QL && !printer.ip) {
            return { ok: false, error: 'no_printer_configured' };
        }
        const format = await getLabelFormat();
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
            format,
        });

        let res;
        if (type === PRINTER_TYPES.BROTHER_QL) {
            // PDF path (Andrew 2026-05-21) — same as the regular
            // print path so the test print exercises the same code.
            const pdfBlob = await buildBrotherPrintPdfBlob({
                widthMm:  payload._presetWidthMm  || printer.labelWidthMm  || DEFAULT_BROTHER_LABEL_WIDTH_MM,
                heightMm: payload._presetHeightMm || printer.labelHeightMm || DEFAULT_BROTHER_LABEL_HEIGHT_MM,
                payload,
                copies: 1,
                kind: 'prep',
            });
            res = await sendBrotherPdfViaShareSheet(pdfBlob, 'DD-Mau-Test.pdf');
        } else {
            const xml = renderEposXml(payload);
            res = await sendToPrinter(printer, xml);
        }
        // Stamp the printer doc (per slot) with the test result.
        try {
            const slotPath = printerDocPath(location, slot);
            await setDoc(doc(db, 'config', slotPath), {
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
            targetId: `${location}_${slot}`,
            details: { location, slot, type, printerOk: res.ok, printerStatus: res.status },
        });
        return res.ok
            ? { ok: true }
            : { ok: false, error: 'printer_rejected' };
    } catch (e) {
        console.warn('testPrint failed:', e);
        return { ok: false, error: e?.message || 'test_failed' };
    }
}
