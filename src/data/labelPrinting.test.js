// Tests for the free-text label helpers behind PrintCenter's Custom
// Print modal. Pins the 2026-07-10 fixes: the size chips map to
// DISTINCT Brother scales (the old map was keyed small/medium/large,
// so the UI's 'normal' and 'huge' both silently fell back to 1.0 and
// the size tabs looked dead), and the date/name stamps share one
// format across the Epson / AirPrint / direct-IPP paths.

import { describe, it, expect, vi } from 'vitest';

// labelPrinting.js drags in firebase + printer transports — none of
// which the pure helpers under test need. Mock them away.
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

import { freeTextDateStamp, brotherFreeTextScale } from './labelPrinting';

describe('freeTextDateStamp', () => {
    it('formats mm/dd/yy h:mma with a/p suffix', () => {
        expect(freeTextDateStamp(new Date(2026, 6, 10, 8, 5))).toBe('07/10/26 8:05a');
        expect(freeTextDateStamp(new Date(2026, 0, 2, 14, 30))).toBe('01/02/26 2:30p');
    });
    it('midnight renders as 12:xxa, noon as 12:xxp', () => {
        expect(freeTextDateStamp(new Date(2026, 6, 10, 0, 15))).toBe('07/10/26 12:15a');
        expect(freeTextDateStamp(new Date(2026, 6, 10, 12, 0))).toBe('07/10/26 12:00p');
    });
});

describe('brotherFreeTextScale', () => {
    it('every UI size key maps to a DISTINCT scale', () => {
        // Regression — 'normal' and 'huge' used to fall through to the
        // same 1.0 default because the map was keyed small/medium/large.
        const scales = ['small', 'normal', 'large', 'huge'].map(brotherFreeTextScale);
        expect(new Set(scales).size).toBe(4);
        expect(brotherFreeTextScale('small')).toBeLessThan(brotherFreeTextScale('normal'));
        expect(brotherFreeTextScale('normal')).toBeLessThan(brotherFreeTextScale('large'));
        expect(brotherFreeTextScale('large')).toBeLessThan(brotherFreeTextScale('huge'));
    });
    it('legacy "medium" and numeric sizes pass through; garbage → 1.0', () => {
        expect(brotherFreeTextScale('medium')).toBe(1.0);
        expect(brotherFreeTextScale(1.3)).toBe(1.3);
        expect(brotherFreeTextScale('nonsense')).toBe(1.0);
        expect(brotherFreeTextScale(undefined)).toBe(1.0);
    });
});
