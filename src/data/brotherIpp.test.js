import { describe, it, expect, vi, afterEach } from 'vitest';
import { rowsToUrf, imageDataToUrf, buildIppPrintJob, renderLabelCanvas, BROTHER_IMAGEABLE_W } from './brotherIpp';

const u32 = (b, o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];

describe('brother URF encoder (hardware-validated format)', () => {
    it('writes the UNIRAST header + 32-byte page header at the proven offsets', () => {
        const rows = [Uint8Array.from([0xff, 0x00, 0xff])];
        const urf = rowsToUrf(rows, 3, 1, 300);
        expect(String.fromCharCode(...urf.slice(0, 7))).toBe('UNIRAST');
        expect(urf[7]).toBe(0x00);
        expect(u32(urf, 8)).toBe(1);          // page count
        const h = urf.slice(12, 44);          // 32-byte page header
        expect(h[0]).toBe(8);                 // bitsPerPixel
        expect(h[1]).toBe(0);                 // colorSpace 0 = 8-bit gray (SW)
        expect(h[2]).toBe(1);                 // simplex
        expect(h[3]).toBe(0);                 // quality byte = 0 (matches capture)
        expect(u32(h, 12)).toBe(3);           // width
        expect(u32(h, 16)).toBe(1);           // height
        expect(u32(h, 20)).toBe(300);         // dpi
    });

    it('coalesces identical rows into one line-repeat group', () => {
        const row = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
        const urf = rowsToUrf([row, row, row], 4, 3);
        // first byte after the 44-byte header is the line-repeat byte = rows-1 = 2
        expect(urf[44]).toBe(2);
    });

    it('imageDataToUrf thresholds <128 luma to black ink (0x00)', () => {
        // 2x1 RGBA: black pixel then white pixel
        const rgba = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255]);
        const urf = imageDataToUrf(rgba, 2, 1);
        // header ok + a 2-px line encodes both pixels (no crash, valid length)
        expect(String.fromCharCode(...urf.slice(0, 7))).toBe('UNIRAST');
        expect(u32(urf.slice(12, 44), 12)).toBe(2);
    });
});

describe('brother IPP Print-Job builder', () => {
    it('emits a valid Print-Job with media-col + image/urf, doc appended', () => {
        const urf = rowsToUrf([Uint8Array.from([0xff])], 1, 1);
        const ipp = buildIppPrintJob({ host: '192.168.1.157', urf, heightPx: 360 });
        expect(ipp[0]).toBe(0x02);                       // version 2.0
        expect(ipp[1]).toBe(0x00);
        expect((ipp[2] << 8) | ipp[3]).toBe(0x0002);     // operation-id Print-Job
        const ascii = String.fromCharCode(...ipp);
        expect(ascii).toContain('image/urf');
        expect(ascii).toContain('media-col');
        expect(ascii).toContain('x-dimension');
        expect(ascii).toContain('print-color-mode');
        expect(ascii).toContain('auto-monochrome');
        // the URF document is appended after the IPP end-of-attributes tag
        expect(ascii).toContain('UNIRAST');
        expect(ipp.length).toBeGreaterThan(urf.length);
    });

    it('imageable width constant matches the printer (62mm tape minus margins)', () => {
        expect(BROTHER_IMAGEABLE_W).toBe(664);
    });
});

// ── renderLabelCanvas word-wrap (2026-07-10 size-chip fix) ────────────
// jsdom has no real 2D canvas, so stub document.createElement with a
// fake whose measureText scales with the current font px — enough to
// pin the wrap-vs-shrink logic without rasterizing anything.
function withFakeCanvas(fn) {
    const calls = { fillText: [] };
    const ctx = {
        font: '10px Arial', fillStyle: '', textAlign: '', textBaseline: '',
        measureText(text) {
            const px = Number((this.font.match(/(\d+)px/) || [])[1] || 10);
            return { width: String(text).length * px * 0.55 };
        },
        fillRect() {},
        fillText(text) { calls.fillText.push({ text, font: this.font }); },
        getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    };
    const cv = { width: 0, height: 0, getContext: () => ctx };
    const spy = vi.spyOn(document, 'createElement').mockImplementation(() => cv);
    try { return { result: fn(), calls }; } finally { spy.mockRestore(); }
}
afterEach(() => vi.restoreAllMocks());

describe('renderLabelCanvas — honor size, wrap instead of shrink', () => {
    it('multi-word text keeps the requested px and word-wraps', () => {
        // Regression — the old loop shrank the WHOLE line to fit one
        // row, so small/normal/large/huge all converged to the same
        // fitted size for any longer text (the size tabs looked dead).
        const { calls } = withFakeCanvas(() => renderLabelCanvas(
            [{ text: 'CHICKEN SALAD FOR CATERING', scale: 1.9, bold: true }],
            { footer: '' },
        ));
        expect(calls.fillText.length).toBeGreaterThan(1); // wrapped, not shrunk
        for (const c of calls.fillText) expect(c.font).toContain('99px'); // 52 * 1.9
    });

    it('different scales produce different rendered px', () => {
        const px = (scale) => {
            const { calls } = withFakeCanvas(() => renderLabelCanvas(
                [{ text: 'TACO TUESDAY PREP', scale, bold: false }], { footer: '' },
            ));
            return Number(calls.fillText[0].font.match(/(\d+)px/)[1]);
        };
        expect(px(0.7)).toBeLessThan(px(1.0));
        expect(px(1.0)).toBeLessThan(px(1.45));
        expect(px(1.45)).toBeLessThan(px(1.9));
    });

    it('a single unbreakable word still shrinks to fit the tape', () => {
        const { calls } = withFakeCanvas(() => renderLabelCanvas(
            [{ text: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', scale: 1.9, bold: false }],
            { footer: '' },
        ));
        expect(calls.fillText.length).toBe(1);
        const px = Number(calls.fillText[0].font.match(/(\d+)px/)[1]);
        expect(px).toBeLessThan(99);
    });
});

// ── IPP response status (2026-09-23 review M3) ────────────────────────
// The printer reports job errors INSIDE an HTTP 200 body; bytes 2-3 are
// the IPP status-code. Synthetic responses below mirror RFC 8010 framing:
// version, status, request-id, operation-attributes group, end tag.
import {
    ippResponseBytes, parseIppResponseStatus, ippStatusIsError, ippStatusMessage,
    interpretIppHttpResponse, probeAnsweredReady,
} from './brotherIpp';

function ippResponse(status, requestId = 1, version = [2, 0]) {
    const enc = (s) => Array.from(new TextEncoder().encode(s));
    const name = enc('attributes-charset');
    const val = enc('utf-8');
    return Uint8Array.from([
        version[0], version[1],
        (status >> 8) & 0xff, status & 0xff,
        (requestId >>> 24) & 0xff, (requestId >>> 16) & 0xff, (requestId >>> 8) & 0xff, requestId & 0xff,
        0x01,                                   // operation-attributes-tag
        0x47, 0x00, name.length, ...name, 0x00, val.length, ...val,
        0x03,                                   // end-of-attributes
    ]);
}
const b64 = (u8) => Buffer.from(u8).toString('base64');

describe('IPP response parsing', () => {
    it('reads version / status / request-id from a base64 body (native CapacitorHttp shape)', () => {
        const r = parseIppResponseStatus(b64(ippResponse(0x0000, 1)), 1);
        expect(r).toEqual({ version: '2.0', statusCode: 0, requestId: 1 });
        expect(parseIppResponseStatus(b64(ippResponse(0x0506, 7)), 7).statusCode).toBe(0x0506);
    });

    it('tolerates Android line-wrapped base64 and raw ArrayBuffer / Uint8Array bodies', () => {
        const wrapped = b64(ippResponse(0x0507, 2)).replace(/(.{8})/g, '$1\n');
        expect(parseIppResponseStatus(wrapped, 2).statusCode).toBe(0x0507);
        const u8 = ippResponse(0x0400, 3);
        expect(parseIppResponseStatus(u8, 3).statusCode).toBe(0x0400);
        expect(parseIppResponseStatus(u8.buffer, 3).statusCode).toBe(0x0400);
    });

    it('returns null for anything that is not clearly OUR IPP response', () => {
        expect(parseIppResponseStatus(undefined)).toBeNull();
        expect(parseIppResponseStatus('')).toBeNull();
        expect(parseIppResponseStatus('<html>busy</html>')).toBeNull();
        expect(parseIppResponseStatus(b64(new TextEncoder().encode('HTTP/1.1 200 OK hello')))).toBeNull();
        expect(parseIppResponseStatus(b64(ippResponse(0x0506, 9)), 1)).toBeNull();   // request-id mismatch
        expect(parseIppResponseStatus(b64(ippResponse(0x0506, 1, [3, 0])), 1)).toBeNull(); // bad version
        expect(parseIppResponseStatus(b64(Uint8Array.from([2, 0, 0, 0, 0, 0, 0, 1]))), 1).toBeNull(); // too short
        expect(ippResponseBytes({ some: 'object' })).toBeNull();
    });

    it('status-codes above 0x00FF are errors; successful-* are not', () => {
        for (const ok of [0x0000, 0x0001, 0x0007, 0x00ff]) expect(ippStatusIsError(ok)).toBe(false);
        for (const bad of [0x0400, 0x040a, 0x0500, 0x0506, 0x0507]) expect(ippStatusIsError(bad)).toBe(true);
    });

    it('builds a readable reason with the hex code', () => {
        expect(ippStatusMessage(0x0506)).toMatch(/not accepting jobs/);
        expect(ippStatusMessage(0x0506)).toMatch(/0x0506/);
        expect(ippStatusMessage(0x04ff)).toMatch(/client error/);
        expect(ippStatusMessage(0x05ff)).toMatch(/server error/);
    });
});

describe('interpretIppHttpResponse (Print-Job verdict)', () => {
    it('HTTP 200 + IPP successful-ok = ok', () => {
        expect(interpretIppHttpResponse({ status: 200, data: b64(ippResponse(0, 1)) }, 1))
            .toEqual({ ok: true, status: 200, ippStatus: 0 });
    });
    it('HTTP 200 + IPP error = printer_rejected with a readable message (was a false success)', () => {
        const r = interpretIppHttpResponse({ status: 200, data: b64(ippResponse(0x0506, 4)) }, 4);
        expect(r.ok).toBe(false);
        expect(r.error).toBe('printer_rejected');
        expect(r.ippStatus).toBe(0x0506);
        expect(r.message).toMatch(/not accepting jobs/);
    });
    it('unreadable 2xx body keeps the OLD behavior (ok) — never invent a failure', () => {
        expect(interpretIppHttpResponse({ status: 200, data: '' }, 1).ok).toBe(true);
        expect(interpretIppHttpResponse({ status: 200 }, 1).ok).toBe(true);
        expect(interpretIppHttpResponse({ status: 200, data: b64(ippResponse(0x0506, 8)) }, 1).ok).toBe(true);
    });
    it('non-2xx HTTP keeps the old shape (no error code → caller maps to printer_rejected)', () => {
        expect(interpretIppHttpResponse({ status: 500 }, 1)).toEqual({ ok: false, status: 500 });
        expect(interpretIppHttpResponse(undefined, 1)).toEqual({ ok: false, status: 0 });
    });
});

describe('probeAnsweredReady (wake / keep-alive probe)', () => {
    it('any HTTP reply is still "up"…', () => {
        expect(probeAnsweredReady({ status: 200, data: b64(ippResponse(0, 1)) })).toBe(true);
        expect(probeAnsweredReady({ status: 200 })).toBe(true);
        expect(probeAnsweredReady({ status: 400 })).toBe(true);
    });
    it('…except an IPP error body — answered but NOT ready', () => {
        expect(probeAnsweredReady({ status: 200, data: b64(ippResponse(0x0502, 1)) })).toBe(false);
    });
    it('no reply = not ready', () => {
        expect(probeAnsweredReady({ status: 0 })).toBe(false);
        expect(probeAnsweredReady(null)).toBe(false);
    });
});
