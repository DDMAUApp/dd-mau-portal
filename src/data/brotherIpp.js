// brotherIpp.js — print to a Brother QL-820NWB DIRECTLY over Wi-Fi, from the
// app, with NO Pi and NO AirPrint dialog. We build an Apple-Raster (image/urf)
// job and POST it over IPP to the printer's :631 endpoint, exactly like the
// Epson talks ePOS over HTTP. The byte format here is HARDWARE-VALIDATED against
// the real QL-820NWB (a captured known-good CUPS/AirPrint job was reverse-
// engineered; see memory project_brother_direct_ipp). The critical pieces a
// naive job was missing — and that this includes — are the `media-col` page
// geometry + `print-color-mode` + `print-quality`; without them the printer
// jams ("spool-area-full") and needs a power cycle.
//
// Transport: native CapacitorHttp with `dataType:'file'` (base64 → raw bytes),
// which sends the binary body over the OS network stack and bypasses the
// WebView's mixed-content block — the same reason the Epson path uses
// CapacitorHttp. This is LAN-only (the printing device must be on the store
// Wi-Fi with the printer) and native-only (web can't reach plain-http LAN).
//
// This module is self-contained and is NOT wired into the Epson path — the
// caller chooses it explicitly (a per-print "Brother" toggle). Epson is
// untouched.

import { Capacitor, CapacitorHttp } from '@capacitor/core';

export const BROTHER_DPI = 300;
export const BROTHER_PORT = 631;
// 62mm continuous tape. CUPS/AirPrint render the imageable area as 664 px wide
// (62mm minus the printer's 3.03mm left+right margins) — match it exactly.
export const BROTHER_IMAGEABLE_W = 664;
export const BROTHER_MARGIN_HMM = 303;      // hundredths-mm (3.03mm) all sides
export const BROTHER_TAPE_W_HMM = 6200;     // 62.00mm tape width
const MM_PER_PX = 25.4 / BROTHER_DPI;

// ── Apple Raster (URF) encoder ───────────────────────────────────────────
// Modified-PackBits, whole-pixel, validated against Apple's raster-stream.c
// reader. `rows` = array of Uint8Array (one 8-bit-gray byte per pixel;
// 0x00 = black ink, 0xFF = white).
function encodeLine(out, row, w) {
    const pend = w, plast = pend - 1;
    let p = 0;
    while (p < pend) {
        const s = p; p += 1;
        if (p === pend) {                                   // last single pixel
            out.push(0, row[s]);
        } else if (row[s] === row[p]) {                     // repeat run
            let c = 2;
            while (c < 128 && p < plast && row[p] === row[p + 1]) { c++; p++; }
            out.push(c - 1, row[p]); p++;
        } else {                                            // literal run
            let c = 1;
            while (c < 128 && p < plast && row[p] !== row[p + 1]) { c++; p++; }
            if (p >= plast && c < 128) { c++; p++; }
            out.push((257 - c) & 0xFF);
            for (let k = 0; k < c; k++) out.push(row[s + k]);
        }
    }
}

// rows: array of Uint8Array(width) grayscale. Returns Uint8Array of URF bytes.
export function rowsToUrf(rows, width, height, dpi = BROTHER_DPI) {
    const out = [];
    [0x55, 0x4E, 0x49, 0x52, 0x41, 0x53, 0x54, 0x00].forEach((b) => out.push(b)); // UNIRAST\0
    pushU32(out, 1);                                  // page count
    const hdr = new Array(32).fill(0);
    hdr[0] = 8;                                       // bitsPerPixel
    hdr[1] = 0;                                       // colorSpace 0 = 8-bit gray (SW)
    hdr[2] = 1;                                       // simplex
    hdr[3] = 0;                                       // quality byte (matches capture)
    setU32(hdr, 12, width);
    setU32(hdr, 16, height);
    setU32(hdr, 20, dpi);
    out.push(...hdr);
    let i = 0;
    while (i < rows.length) {
        let j = i + 1;
        while (j < rows.length && eqRow(rows[j], rows[i]) && (j - i) < 256) j++;
        out.push((j - i) - 1);                        // line-repeat byte
        encodeLine(out, rows[i], width);
        i = j;
    }
    return Uint8Array.from(out);
}

// Threshold an RGBA buffer to 1-bit ink and encode. <128 luma = black.
export function imageDataToUrf(rgba, width, height, dpi = BROTHER_DPI) {
    const rows = [];
    for (let y = 0; y < height; y++) {
        const row = new Uint8Array(width);
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            const luma = rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114;
            row[x] = luma < 128 ? 0x00 : 0xFF;
        }
        rows.push(row);
    }
    return rowsToUrf(rows, width, height, dpi);
}

// ── IPP Print-Job builder (RFC 8010) ─────────────────────────────────────
function u16(n) { return [(n >>> 8) & 0xFF, n & 0xFF]; }
function pushU32(a, n) { a.push((n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF); }
function setU32(a, o, n) { a[o] = (n >>> 24) & 0xFF; a[o + 1] = (n >>> 16) & 0xFF; a[o + 2] = (n >>> 8) & 0xFF; a[o + 3] = n & 0xFF; }
function eqRow(a, b) { if (a.length !== b.length) return false; for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false; return true; }

const TE = new TextEncoder();
function attr(out, tag, name, valueBytes) {
    const nb = TE.encode(name);
    out.push(tag, ...u16(nb.length), ...nb, ...u16(valueBytes.length), ...valueBytes);
}
function attrStr(out, tag, name, s) { attr(out, tag, name, Array.from(TE.encode(s))); }
function attrEnum(out, name, n) { attr(out, 0x23, name, [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]); }
function memberName(out, s) { const vb = TE.encode(s); out.push(0x4a, ...u16(0), ...u16(vb.length), ...vb); }
function memberInt(out, n) { out.push(0x21, ...u16(0), ...u16(4), (n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF); }
function begColl(out, name) { const nb = TE.encode(name); out.push(0x34, ...u16(nb.length), ...nb, ...u16(0)); }
function endColl(out) { out.push(0x37, ...u16(0), ...u16(0)); }

function mediaCol(out, xHmm, yHmm, margin = BROTHER_MARGIN_HMM) {
    begColl(out, 'media-col');
    memberName(out, 'media-size'); begColl(out, '');
    memberName(out, 'x-dimension'); memberInt(out, xHmm);
    memberName(out, 'y-dimension'); memberInt(out, yHmm);
    endColl(out);
    memberName(out, 'media-top-margin'); memberInt(out, margin);
    memberName(out, 'media-left-margin'); memberInt(out, margin);
    memberName(out, 'media-right-margin'); memberInt(out, margin);
    memberName(out, 'media-bottom-margin'); memberInt(out, margin);
    endColl(out);
}

// Build the full IPP Print-Job request (header + attributes + URF document).
export function buildIppPrintJob({ host, port = BROTHER_PORT, urf, heightPx, jobName = 'DD Mau Label', user = 'ddmau', requestId = 1 }) {
    const yHmm = Math.round(heightPx * MM_PER_PX * 100);
    const uri = `ipp://${host}:${port}/ipp/print`;
    const out = [];
    out.push(0x02, 0x00, ...u16(0x0002));                 // version 2.0, Print-Job
    pushU32(out, requestId);
    out.push(0x01);                                       // operation-attributes
    attrStr(out, 0x47, 'attributes-charset', 'utf-8');
    attrStr(out, 0x48, 'attributes-natural-language', 'en-us');
    attrStr(out, 0x45, 'printer-uri', uri);
    attrStr(out, 0x42, 'requesting-user-name', user);
    attrStr(out, 0x42, 'job-name', jobName);
    attrStr(out, 0x49, 'document-format', 'image/urf');
    out.push(0x02);                                       // job-attributes
    mediaCol(out, BROTHER_TAPE_W_HMM, yHmm);
    attrStr(out, 0x44, 'print-color-mode', 'auto-monochrome');
    attrEnum(out, 'print-quality', 4);
    out.push(0x03);                                       // end-of-attributes
    const head = Uint8Array.from(out);
    const full = new Uint8Array(head.length + urf.length);
    full.set(head, 0); full.set(urf, head.length);
    return full;
}

function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

// POST one IPP job to the printer. Native only (CapacitorHttp binary body).
// Returns { ok, status }.
async function postIpp(ip, ippBytes) {
    if (!Capacitor.isNativePlatform()) {
        return { ok: false, status: 0, error: 'web_unsupported' };
    }
    const res = await CapacitorHttp.post({
        url: `http://${ip}:${BROTHER_PORT}/ipp/print`,
        headers: { 'Content-Type': 'application/ipp' },
        data: bytesToBase64(ippBytes),
        dataType: 'file',                 // base64 → raw binary request body
        responseType: 'arraybuffer',
        connectTimeout: 8000,
        readTimeout: 15000,
    });
    const status = Number(res?.status) || 0;
    return { ok: status >= 200 && status < 300, status };
}

// ── Canvas label renderer ────────────────────────────────────────────────
// Draws the label "lines" (the bridge's clean {text,scale,bold} model) onto an
// offscreen canvas at the imageable width, returns the RGBA + dimensions. Fits
// within the page width by shrinking any line that would overflow. `rightShift`
// nudges all content right (Andrew: "center it to the right a little bit").
export function renderLabelCanvas(lines, { width = BROTHER_IMAGEABLE_W, rightShift = 16, footer = 'DD Mau' } = {}) {
    const PAD = 16;
    const GAP = 10;
    const BASE = 30;                               // base font px (scale=1)
    const innerW = width - PAD * 2 - rightShift;
    const cv = document.createElement('canvas');
    const ctx = cv.getContext('2d');
    const items = [];
    for (const ln of (lines || [])) {
        const text = String(ln?.text ?? '').trim();
        if (!text) continue;
        let px = Math.max(14, Math.round(BASE * (Number(ln.scale) || 1)));
        const weight = ln.bold ? '800' : '600';
        // Shrink to fit the printable width.
        for (let guard = 0; guard < 40; guard++) {
            ctx.font = `${weight} ${px}px Arial, sans-serif`;
            if (ctx.measureText(text).width <= innerW || px <= 14) break;
            px -= 2;
        }
        items.push({ text, px, weight, h: Math.round(px * 1.18) });
    }
    let height = PAD;
    for (const it of items) height += it.h + GAP;
    if (footer) height += Math.round(BASE * 0.7) + GAP;
    height += PAD;
    height = Math.max(height, 90);

    cv.width = width; cv.height = height;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const cx = PAD + rightShift + innerW / 2;
    let y = PAD;
    for (const it of items) {
        ctx.font = `${it.weight} ${it.px}px Arial, sans-serif`;
        ctx.fillText(it.text, cx, y);
        y += it.h + GAP;
    }
    if (footer) {
        ctx.font = `600 ${Math.round(BASE * 0.7)}px Arial, sans-serif`;
        ctx.fillText(String(footer), cx, y);
    }
    const img = ctx.getImageData(0, 0, width, height);
    return { rgba: img.data, width, height };
}

// ── Top-level: render + send one label (copies = repeat the job; the
// QL-820NWB does NOT support the IPP `copies` attribute, so we loop). ──
export async function printBrotherDirect({ ip, lines, footer, copies = 1, rightShift, jobName }) {
    if (!ip) return { ok: false, error: 'no_brother_ip' };
    if (!Capacitor.isNativePlatform()) return { ok: false, error: 'web_unsupported' };
    const { rgba, width, height } = renderLabelCanvas(lines, { footer, rightShift });
    const urf = imageDataToUrf(rgba, width, height);
    const n = Math.max(1, Math.min(20, Math.floor(Number(copies) || 1)));
    let last = { ok: false, status: 0 };
    for (let i = 0; i < n; i++) {
        const ipp = buildIppPrintJob({ host: ip, urf, heightPx: height, jobName: jobName || 'DD Mau Label', requestId: i + 1 });
        // eslint-disable-next-line no-await-in-loop
        last = await postIpp(ip, ipp);
        if (!last.ok) return { ok: false, status: last.status, error: 'printer_rejected', copyFailed: i + 1 };
    }
    return { ok: true, status: last.status, via: 'brother_ipp', copies: n };
}
