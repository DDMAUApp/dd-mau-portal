// printRiceLabel (2026-11-03): the rice sticker's own print path. Follows
// printRecipeIngredients, plus a left margin, timeouts kept apart from
// rejections, and a job is never sent twice.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const printers = vi.hoisted(() => new Map());
const brother = vi.hoisted(() => ({ printBrotherDirect: vi.fn() }));

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, CapacitorHttp: http }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn((db, coll, id) => ({ id })),
    collection: vi.fn(), setDoc: vi.fn(),
    getDoc: vi.fn(async (ref) => ({ exists: () => printers.has(ref.id), data: () => printers.get(ref.id) })),
    addDoc: vi.fn(async () => ({})), onSnapshot: vi.fn(() => () => {}), serverTimestamp: vi.fn(),
    query: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), deleteField: vi.fn(),
}));
vi.mock('./audit', () => ({ recordAudit: vi.fn() }));
vi.mock('./labelFormat', () => ({ getLabelFormat: vi.fn(), getLabelFormatFast: vi.fn() }));
vi.mock('./printBridge', () => ({
    tryPrintViaBridge: vi.fn(async () => ({ ok: true })), payloadToBridgeFormat: vi.fn(), warmPrintBridge: vi.fn(),
}));
vi.mock('./brotherIpp', () => ({ printBrotherDirect: brother.printBrotherDirect, warmBrotherDirect: vi.fn() }));

import { printErrorCode, printRiceLabel, renderRiceStickerXml, riceStickerLeftDots } from './labelPrinting';
import { RICE_ROUTE_TODAY, buildRiceStickerRows, riceRouteDeadlines } from './riceSticker';

const madeAt = new Date(2026, 10, 3, 12, 0);
const d = riceRouteDeadlines(RICE_ROUTE_TODAY, madeAt);
const rows = buildRiceStickerRows({
    route: RICE_ROUTE_TODAY, batchNo: 4, madeAt: madeAt.toISOString(), startTempF: 198, cookedBy: 'Ana <R>',
    tossByAt: d.tossByAt.toISOString(), wokByAt: d.wokByAt.toISOString(),
});

let storeNo = 0;
// A fresh store + printer IP per test: the config cache and the probe-failure
// cache are both keyed on them.
function store(printer) {
    storeNo += 1;
    const location = `store${storeNo}`;
    printers.set(`printers_${location}_kitchen`, { paperWidthMm: 40, ip: `10.0.0.${storeNo}`, ...printer });
    return location;
}

beforeEach(() => {
    http.get.mockReset().mockResolvedValue({ status: 200 });
    http.post.mockReset().mockResolvedValue({ status: 200, data: '<response success="true"/>' });
    brother.printBrotherDirect.mockReset().mockResolvedValue({ ok: true, status: 200 });
});

describe('the XML', () => {
    it('prints each row with its own size, bold and reverse, then cuts', () => {
        const xml = renderRiceStickerXml(rows);
        expect(xml).toContain('<text>MADE/HECHO     12:00p&#10;</text>');
        expect(xml).toContain('<text reverse="true"/><text em="true"/><text width="1" height="2"/><text>NO FRIDGE/NO AL REFRI&#10;</text>');
        expect(xml).toContain('<text reverse="false"/><text em="true"/><text width="4" height="4"/><text>4:00p&#10;</text>');
        expect(xml.match(/<cut type="feed"\/>/g)).toHaveLength(1);
        expect(xml).toContain('<text reverse="false"/><text em="false"/><text width="1" height="1"/><feed');
    });
    it('stitches copies into one envelope, so it is one job', () => {
        const xml = renderRiceStickerXml(rows, { copies: 3 });
        expect(xml.match(/<cut type="feed"\/>/g)).toHaveLength(3);
        expect(xml.match(/<s:Envelope/g)).toHaveLength(1);
    });
    it('emits the left margin first, and nothing when it is zero', () => {
        expect(renderRiceStickerXml(rows)).not.toContain('<command>');
        const xml = renderRiceStickerXml(rows, { leftDots: 16 });
        expect(xml.indexOf('<command>1d4c1000</command>')).toBeGreaterThan(-1);
        expect(xml.indexOf('<command>')).toBeLessThan(xml.indexOf('<text'));
    });
});

describe('left margin', () => {
    it('is capped on the 40 mm roll, where a bigger offset would wrap 21-column lines', () => {
        expect(riceStickerLeftDots({ paperWidthMm: 40, leftOffsetMm: 2 })).toBe(16);
        expect(riceStickerLeftDots({ paperWidthMm: 40, leftOffsetMm: 10 })).toBe(28);
    });
    it('is the saved offset on a wider roll, and zero when unset', () => {
        expect(riceStickerLeftDots({ paperWidthMm: 80, leftOffsetMm: 10 })).toBe(80);
        expect(riceStickerLeftDots({ paperWidthMm: 40 })).toBe(0);
        expect(riceStickerLeftDots(null)).toBe(0);
    });
});

describe('Epson', () => {
    it('sends one job with the store margin, escaped text, and a timeout scaled to the copies', async () => {
        const location = store({ leftOffsetMm: 2 });
        const res = await printRiceLabel({ location, rows, copies: 3, byName: 'Ana' });
        expect(res).toEqual({ ok: true });
        expect(http.post).toHaveBeenCalledTimes(1);
        const { url, data } = http.post.mock.calls[0][0];
        expect(data).toContain('<command>1d4c1000</command>');
        expect(data.match(/<cut type="feed"\/>/g)).toHaveLength(3);
        expect(url).toContain('timeout=16000');
    });

    it('a timed-out job stays a timeout and is never sent again', async () => {
        const location = store();
        http.post.mockRejectedValue(new Error('The request timed out.'));
        const res = await printRiceLabel({ location, rows });
        expect(res).toEqual({ ok: false, error: 'printer timeout' });
        expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('a printer that never answers the probe is a timeout, and no job went out', async () => {
        const location = store();
        http.get.mockRejectedValue(new Error('no route'));
        const res = await printRiceLabel({ location, rows });
        expect(res).toEqual({ ok: false, error: 'printer timeout' });
        expect(http.post).not.toHaveBeenCalled();
    }, 10000);

    it('a printer that says no is a rejection, not a timeout', async () => {
        const location = store();
        http.post.mockResolvedValue({ status: 200, data: '<response success="false"/>' });
        const res = await printRiceLabel({ location, rows });
        expect(res).toEqual({ ok: false, error: 'printer_rejected' });
        expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('a job POST lost after the probe passed may have printed, so it reads as a timeout', async () => {
        const location = store();
        http.post.mockRejectedValue(new Error('The network connection was lost.'));
        const res = await printRiceLabel({ location, rows });
        expect(res).toEqual({ ok: false, error: 'printer timeout' });
        expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('a timeout the printer reports in its own 200 reply reads as a timeout', async () => {
        const location = store();
        http.post.mockResolvedValue({ status: 200, data: '<response success="false" code="EX_TIMEOUT" status="0"/>' });
        const res = await printRiceLabel({ location, rows });
        expect(res).toEqual({ ok: false, error: 'printer timeout' });
        expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('a real device error stays a rejection', async () => {
        const location = store();
        http.post.mockResolvedValue({ status: 200, data: '<response success="false" code="EPTR_REC_EMPTY" status="0"/>' });
        const res = await printRiceLabel({ location, rows });
        expect(res).toEqual({ ok: false, error: 'printer_rejected' });
    });

    it('an HTTP error is the printer answering, and keeps its own message', async () => {
        const location = store();
        http.post.mockResolvedValue({ status: 500, data: '' });
        const res = await printRiceLabel({ location, rows });
        expect(res).toEqual({ ok: false, error: 'printer responded 500' });
    });
});

describe('no working printer', () => {
    it('reports no printer, a turned-off printer, and no rows, and sends nothing', async () => {
        expect(await printRiceLabel({ location: 'nowhere', rows })).toEqual({ ok: false, error: 'no_printer_configured' });
        expect(await printRiceLabel({ location: store({ enabled: false }), rows })).toEqual({ ok: false, error: 'printer_disabled' });
        expect(await printRiceLabel({ location: store({ ip: '' }), rows })).toEqual({ ok: false, error: 'no_printer_configured' });
        expect(await printRiceLabel({ location: store(), rows: [] })).toEqual({ ok: false, error: 'empty_text' });
        expect(http.post).not.toHaveBeenCalled();
    });
});

describe('Brother', () => {
    it('a store with only a Brother gets labeled rows and no footer', async () => {
        const location = store({ ip: '', brotherIp: '10.9.9.1' });
        const res = await printRiceLabel({ location, rows, copies: 2, byName: 'Ana' });
        expect(res).toEqual({ ok: true });
        expect(http.post).not.toHaveBeenCalled();
        expect(brother.printBrotherDirect).toHaveBeenCalledTimes(1);
        const arg = brother.printBrotherDirect.mock.calls[0][0];
        expect(arg.ip).toBe('10.9.9.1');
        expect(arg.copies).toBe(2);
        expect(arg.footer).toBe('');
        expect(arg.lines.map((l) => l.text)).toContain('MADE/HECHO 12:00p');
        expect(arg.lines.map((l) => l.text)).toContain('NO FRIDGE/NO AL REFRI');
    });

    it('a Brother slot prints direct too, and its timeout stays a timeout', async () => {
        const location = store({ type: 'brother_ql', ip: '', brotherIp: '10.9.9.2' });
        brother.printBrotherDirect.mockResolvedValue({ ok: false, status: 0, error: 'printer timeout' });
        const res = await printRiceLabel({ location, rows });
        expect(res).toEqual({ ok: false, error: 'printer timeout' });
        expect(brother.printBrotherDirect).toHaveBeenCalledTimes(1);
    });

    it('says which copy failed, so the earlier ones count', async () => {
        const location = store({ ip: '', brotherIp: '10.9.9.5' });
        brother.printBrotherDirect.mockResolvedValue({ ok: false, status: 0, error: 'printer timeout', copyFailed: 2 });
        expect(await printRiceLabel({ location, rows, copies: 3 })).toEqual({ ok: false, error: 'printer timeout', copyFailed: 2 });
        brother.printBrotherDirect.mockResolvedValue({ ok: false, status: 0, error: 'printer_rejected', copyFailed: 1 });
        expect(await printRiceLabel({ location, rows, copies: 3 })).toEqual({ ok: false, error: 'printer_rejected' });
    });

    it('a Brother the app can\'t reach from the web says so', async () => {
        const location = store({ ip: '', brotherIp: '10.9.9.3' });
        brother.printBrotherDirect.mockResolvedValue({ ok: false, error: 'web_unsupported' });
        expect(await printRiceLabel({ location, rows })).toEqual({ ok: false, error: 'web_unsupported' });
    });

    it('an Epson store never goes to its Brother', async () => {
        const location = store({ brotherIp: '10.9.9.4' });
        await printRiceLabel({ location, rows });
        expect(brother.printBrotherDirect).not.toHaveBeenCalled();
        expect(http.post).toHaveBeenCalledTimes(1);
    });
});

describe('printErrorCode', () => {
    it('reads every spelling of a timeout as one code', () => {
        for (const msg of ['printer timeout', 'The request timed out.', 'timeout', 'Time out', 'java.net.SocketTimeoutException: timeout']) {
            expect(printErrorCode(new Error(msg))).toBe('printer timeout');
        }
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        expect(printErrorCode(abort)).toBe('printer timeout');
    });
    it('leaves other errors alone', () => {
        expect(printErrorCode(new Error('printer responded 500'))).toBe('printer responded 500');
        expect(printErrorCode(null)).toBe('print_failed');
    });
});
