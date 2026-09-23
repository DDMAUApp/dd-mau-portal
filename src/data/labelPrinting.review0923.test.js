// 2026-09-23 sticker review — pure-logic pins for the label content fixes:
//   C4  back-dated prep date: real time of day, not a fabricated 12:00 noon
//   M5  Label Format "Default shelf life (days)" is the LAST-resort fallback
//   (b) hour-clock use-by band names the weekday when it crosses midnight
//   (e) free-text Brother footer follows the Epson rule
import { describe, it, expect, vi } from 'vitest';

// labelPrinting.js drags in firebase + printer transports — none of which
// the pure helpers under test need (same mocks as labelPrinting.test.js).
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, CapacitorHttp: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(), collection: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn(),
    addDoc: vi.fn(), onSnapshot: vi.fn(), serverTimestamp: vi.fn(),
    query: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), deleteField: vi.fn(),
}));
vi.mock('./audit', () => ({ recordAudit: vi.fn() }));
vi.mock('./labelFormat', () => ({ getLabelFormat: vi.fn(), getLabelFormatFast: vi.fn() }));
vi.mock('./printBridge', () => ({
    tryPrintViaBridge: vi.fn(), payloadToBridgeFormat: vi.fn(), warmPrintBridge: vi.fn(),
}));
vi.mock('./brotherIpp', () => ({ printBrotherDirect: vi.fn() }));

import {
    resolveShelfLifeDays, DEFAULT_SHELF_LIFE_DAYS,
    buildLabelPayload, prepDateFromPick, prepDateWithTime,
    freeTextFooter, renderFreeTextXml,
} from './labelPrinting';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('resolveShelfLifeDays — format default is the LAST resort (M5)', () => {
    it('without a fallback the results are exactly the old ones', () => {
        expect(resolveShelfLifeDays(null)).toBe(DEFAULT_SHELF_LIFE_DAYS);
        expect(resolveShelfLifeDays({})).toBe(5);
        expect(resolveShelfLifeDays({ category: 'Proteins' })).toBe(3);
        expect(resolveShelfLifeDays({ category: 'Sauces & Dressings' })).toBe(7);
        expect(resolveShelfLifeDays({ category: 'Other' })).toBe(5);
        expect(resolveShelfLifeDays({ shelfLifeDays: 9, category: 'Proteins' })).toBe(9);
    });
    it('item and SPECIFIC category defaults still beat the admin default', () => {
        expect(resolveShelfLifeDays({ shelfLifeDays: 9 }, 2)).toBe(9);
        expect(resolveShelfLifeDays({ category: 'Proteins' }, 9)).toBe(3);
        expect(resolveShelfLifeDays({ category: 'Vegetables' }, 9)).toBe(4);
    });
    it('no life + catch-all/unknown/no category → the admin default (was unreachable)', () => {
        expect(resolveShelfLifeDays({ category: 'Other' }, 2)).toBe(2);
        expect(resolveShelfLifeDays({ category: 'Soups' }, 2)).toBe(2);
        expect(resolveShelfLifeDays({}, 2)).toBe(2);
        expect(resolveShelfLifeDays(null, 2)).toBe(2);
    });
    it('garbage fallback → built-in default; huge → capped at 60', () => {
        for (const bad of [0, -3, 'abc', NaN, undefined, null]) {
            expect(resolveShelfLifeDays({}, bad)).toBe(DEFAULT_SHELF_LIFE_DAYS);
        }
        expect(resolveShelfLifeDays({}, 999)).toBe(60);
        expect(resolveShelfLifeDays({}, '4')).toBe(4);
    });
});

describe('prepDateFromPick — no more fabricated 12:00 noon (C4)', () => {
    const now = new Date(2026, 8, 23, 17, 42, 31, 500);   // Wed Sep 23 2026, 5:42:31p

    it('picking TODAY = now (the real time of day)', () => {
        const d = prepDateFromPick(ymd(now), { now });
        expect(d.getTime()).toBe(now.getTime());
    });
    it('picking another day keeps the time of day shown (default: now), seconds zeroed', () => {
        const d = prepDateFromPick('2026-09-21', { now });
        expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()])
            .toEqual([2026, 8, 21, 17, 42, 0]);
        const custom = prepDateFromPick('2026-09-21', { now, timeOf: new Date(2026, 8, 22, 6, 15) });
        expect([custom.getDate(), custom.getHours(), custom.getMinutes()]).toEqual([21, 6, 15]);
    });
    it('the picked CALENDAR day is exact at either end of the day', () => {
        expect(prepDateFromPick('2026-09-20', { now, timeOf: new Date(2026, 0, 1, 0, 0) }).getDate()).toBe(20);
        expect(prepDateFromPick('2026-09-20', { now, timeOf: new Date(2026, 0, 1, 23, 59) }).getDate()).toBe(20);
        // US spring-forward day: a 2:30 wall time doesn't exist there, but
        // the calendar day must not move.
        const dst = prepDateFromPick('2026-03-08', { now, timeOf: new Date(2026, 0, 1, 2, 30) });
        expect([dst.getMonth(), dst.getDate()]).toEqual([2, 8]);
    });
    it('never later than now (a future prep time would push the use-by out)', () => {
        expect(prepDateFromPick('2026-09-25', { now }).getTime()).toBe(now.getTime());
    });
    it('rejects malformed / impossible dates', () => {
        expect(prepDateFromPick('', { now })).toBeNull();
        expect(prepDateFromPick('2026-02-31', { now })).toBeNull();
        expect(prepDateFromPick('garbage', { now })).toBeNull();
    });
});

describe('prepDateWithTime (C4 time input)', () => {
    const now = new Date(2026, 8, 23, 17, 42);
    it('sets HH:MM on the same calendar day', () => {
        const d = prepDateWithTime(new Date(2026, 8, 21, 17, 42), '06:05', now);
        expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([21, 6, 5]);
    });
    it('today + a later time → clamped to now', () => {
        expect(prepDateWithTime(new Date(2026, 8, 23, 9, 0), '23:30', now).getTime()).toBe(now.getTime());
    });
    it('bad input → null', () => {
        expect(prepDateWithTime(new Date(2026, 8, 21), '', now)).toBeNull();
        expect(prepDateWithTime(new Date(2026, 8, 21), '25:00', now)).toBeNull();
        expect(prepDateWithTime(null, '06:00', now)).toBeNull();
    });
});

describe('back-dated hour clock counts from the REAL prep time (C4, end to end)', () => {
    it('picked yesterday at 7:00a, 4h clock → prints 7:00a prep and 11:00a discard, never 12:00p', () => {
        const now = new Date(2026, 8, 23, 17, 42);
        const prep = prepDateFromPick('2026-09-22', { now, timeOf: new Date(2026, 8, 23, 7, 0) });
        const p = buildLabelPayload({ itemName: 'Bean sprouts', prepDate: prep, shelfLifeHours: 4, format: {} });
        expect(p.prepTimeBig).toBe('7:00a');
        expect(p.useByBig).toBe('11:00a');
        expect(p.metaLines[0]).toBe('Use by: 09/22/26 11:00a');
        expect(JSON.stringify(p)).not.toContain('12:00p');
    });
    it('day clocks are unchanged (calendar math, weekday band)', () => {
        const prep = new Date(2026, 8, 22, 7, 0);   // Tue
        const p = buildLabelPayload({ itemName: 'Pho broth', prepDate: prep, shelfLifeDays: 3, format: {} });
        expect(p.metaLines[0]).toBe('Use by: 09/25/26 (Fri)');
        expect(p.useByBig).toBe('FRI');
    });
});

describe('hour-clock use-by band names the day when it crosses midnight (b)', () => {
    it('same day → time only (unchanged)', () => {
        const p = buildLabelPayload({ itemName: 'Rice', prepDate: new Date(2026, 8, 23, 10, 0), shelfLifeHours: 4, format: {} });
        expect(p.useByBig).toBe('2:00p');
    });
    it('past midnight → weekday + time, in the label language', () => {
        const prep = new Date(2026, 8, 23, 20, 0);   // Wed 8pm
        expect(buildLabelPayload({ itemName: 'Rice', prepDate: prep, shelfLifeHours: 12, format: {} }).useByBig)
            .toBe('THU 8:00a');
        expect(buildLabelPayload({ itemName: 'Arroz', prepDate: prep, shelfLifeHours: 12, language: 'es', format: {} }).useByBig)
            .toBe('JUE 8:00a');
    });
    it('respects 24h format and the band kill-switches', () => {
        const prep = new Date(2026, 8, 23, 20, 0);
        expect(buildLabelPayload({ itemName: 'R', prepDate: prep, shelfLifeHours: 12, format: { timeFormat: '24h' } }).useByBig)
            .toBe('THU 08:00');
        expect(buildLabelPayload({ itemName: 'R', prepDate: prep, shelfLifeHours: 12, format: { showUseByBand: false } }).useByBig)
            .toBe('');
    });
});

describe('free-text footer — Brother follows the Epson rule (e)', () => {
    it('plain message → no footer; any stamp → DD MAU; explicit footer wins', () => {
        expect(freeTextFooter({})).toBe('');
        expect(freeTextFooter()).toBe('');
        expect(freeTextFooter({ stampDate: true })).toBe('DD MAU');
        expect(freeTextFooter({ stampSignature: true })).toBe('DD MAU');
        expect(freeTextFooter({ footer: 'KITCHEN' })).toBe('KITCHEN');
        expect(freeTextFooter({ footer: '', stampDate: true })).toBe('');
        expect(freeTextFooter({ footer: 'x'.repeat(50) })).toHaveLength(30);
    });
    it('matches what the Epson XML actually prints for every stamp combo', () => {
        for (const stampDate of [false, true]) {
            for (const stampSignature of [false, true]) {
                const xml = renderFreeTextXml({ text: 'BROKEN', stampDate, stampSignature, signature: 'Ann', copies: 1 });
                const epsonHasFooter = xml.includes('DD MAU');
                expect(freeTextFooter({ stampDate, stampSignature }) === 'DD MAU').toBe(epsonHasFooter);
            }
        }
    });
});
