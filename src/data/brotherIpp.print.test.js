// printBrotherDirect × IPP status (2026-09-23 review M3). The QL-820NWB
// reports a refused job INSIDE an HTTP 200 body; the sender used to read
// only the HTTP status, so a rejected label looked printed. Pins:
//   • an IPP error on the Print-Job → printer_rejected + readable message,
//     and the job is NEVER re-sent (double-print rule, 2026-07-23);
//   • a copy loop stops at the first rejection;
//   • a probe answered with an IPP error isn't "ready": it's re-probed
//     (safe — Get-Printer-Attributes can't print), marks the strip
//     not-ready, but the job still goes out once and ITS status decides.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true },
    CapacitorHttp: { post },
}));

import { printBrotherDirect, warmBrotherDirect } from './brotherIpp';

function ippResponse(status, requestId) {
    return Uint8Array.from([
        2, 0, (status >> 8) & 0xff, status & 0xff,
        (requestId >>> 24) & 0xff, (requestId >>> 16) & 0xff, (requestId >>> 8) & 0xff, requestId & 0xff,
        0x01, 0x03,
    ]);
}
const b64 = (u8) => Buffer.from(u8).toString('base64');
// Which IPP operation a CapacitorHttp.post carried (0x000B probe, 0x0002 job)
// and its request-id — decoded from the base64 request body.
function opOf(call) {
    const bytes = Buffer.from(call[0].data, 'base64');
    return { op: (bytes[2] << 8) | bytes[3], requestId: bytes.readUInt32BE(4) };
}
// Script the printer: probe replies from `probeStatuses` (in order, last one
// repeats), every job reply from `jobStatuses`.
function scriptPrinter({ probeStatuses = [0], jobStatuses = [0] } = {}) {
    let p = 0; let j = 0;
    post.mockImplementation(async (req) => {
        const { op, requestId } = opOf([req]);
        if (op === 0x000b) {
            const s = probeStatuses[Math.min(p++, probeStatuses.length - 1)];
            if (s === 'timeout') throw new Error('The request timed out');
            return { status: 200, data: b64(ippResponse(s, requestId)) };
        }
        const s = jobStatuses[Math.min(j++, jobStatuses.length - 1)];
        return { status: 200, data: b64(ippResponse(s, requestId)) };
    });
}
const jobPosts = () => post.mock.calls.filter((c) => opOf(c).op === 0x0002).length;
const probePosts = () => post.mock.calls.filter((c) => opOf(c).op === 0x000b).length;

// jsdom has no 2D canvas — same minimal fake as brotherIpp.test.js.
let spy;
beforeEach(() => {
    post.mockReset();
    const ctx = {
        font: '10px Arial', fillStyle: '', textAlign: '', textBaseline: '',
        measureText(text) { return { width: String(text).length * 5 }; },
        fillRect() {}, fillText() {}, strokeRect() {},
        getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4).fill(255) }; },
    };
    spy = vi.spyOn(document, 'createElement').mockImplementation(() => ({ width: 0, height: 0, getContext: () => ctx }));
});
afterEach(() => { spy.mockRestore(); vi.useRealTimers(); });

const LINES = [{ text: 'PHO BROTH', scale: 1, bold: true }];

describe('printBrotherDirect — IPP status is authoritative, jobs sent once', () => {
    it('accepted job → ok (unchanged happy path)', async () => {
        scriptPrinter({ probeStatuses: [0], jobStatuses: [0] });
        const r = await printBrotherDirect({ ip: '10.0.0.1', lines: LINES, footer: '' });
        expect(r.ok).toBe(true);
        expect(jobPosts()).toBe(1);
    });

    it('HTTP 200 + IPP not-accepting-jobs → printer_rejected with a reason, sent exactly ONCE', async () => {
        scriptPrinter({ probeStatuses: [0], jobStatuses: [0x0506] });
        const r = await printBrotherDirect({ ip: '10.0.0.2', lines: LINES, footer: '' });
        expect(r.ok).toBe(false);
        expect(r.error).toBe('printer_rejected');
        expect(r.ippStatus).toBe(0x0506);
        expect(r.message).toMatch(/not accepting jobs/);
        expect(jobPosts()).toBe(1);   // never re-sent
    });

    it('multi-copy stops at the first rejected copy (no further jobs)', async () => {
        scriptPrinter({ probeStatuses: [0], jobStatuses: [0x0507] });
        const r = await printBrotherDirect({ ip: '10.0.0.3', lines: LINES, footer: '', copies: 3 });
        expect(r).toMatchObject({ ok: false, error: 'printer_rejected', copyFailed: 1 });
        expect(jobPosts()).toBe(1);
    });

    it('probe answered with an IPP error is re-probed, then the job goes out ONCE and decides', async () => {
        vi.useFakeTimers();
        scriptPrinter({ probeStatuses: [0x0502, 0x0502], jobStatuses: [0] });
        const p = printBrotherDirect({ ip: '10.0.0.4', lines: LINES, footer: '' });
        await vi.advanceTimersByTimeAsync(1500);
        const r = await p;
        expect(probePosts()).toBe(2);
        expect(jobPosts()).toBe(1);
        expect(r.ok).toBe(true);
    });

    it('a booting printer that becomes ready on the re-probe prints normally', async () => {
        vi.useFakeTimers();
        scriptPrinter({ probeStatuses: [0x0502, 0], jobStatuses: [0] });
        const p = printBrotherDirect({ ip: '10.0.0.5', lines: LINES, footer: '' });
        await vi.advanceTimersByTimeAsync(1500);
        expect((await p).ok).toBe(true);
        expect(jobPosts()).toBe(1);
    });

    it('no answer at all → printer timeout, no job sent (unchanged)', async () => {
        vi.useFakeTimers();
        scriptPrinter({ probeStatuses: ['timeout'] });
        const p = printBrotherDirect({ ip: '10.0.0.6', lines: LINES, footer: '' });
        await vi.advanceTimersByTimeAsync(1500);
        const r = await p;
        expect(r).toMatchObject({ ok: false, error: 'printer timeout' });
        expect(jobPosts()).toBe(0);
    });
});

describe('warmBrotherDirect — an IPP error body is not "ready"', () => {
    it('successful-ok → ready', async () => {
        scriptPrinter({ probeStatuses: [0] });
        expect(await warmBrotherDirect('10.0.1.1')).toBe(true);
    });
    it('service-unavailable → not ready (strip + offline confirm engage)', async () => {
        scriptPrinter({ probeStatuses: [0x0502] });
        expect(await warmBrotherDirect('10.0.1.2')).toBe(false);
    });
});
