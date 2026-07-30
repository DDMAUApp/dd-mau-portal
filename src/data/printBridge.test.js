// Pins the 2026-07-30 "the editor must tell the truth" fix.
//
// The Label Format editor drives BOTH printers, but payloadToBridgeFormat
// used to hardcode titleBold / footerBold / the PREPPED caption's dateBold,
// so an admin who toggled them saw the Epson obey and the Brother ignore.
// These tests assert the Brother now reads the same flags the Epson does.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), getDoc: vi.fn() }));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false }, CapacitorHttp: {},
}));

const { payloadToBridgeFormat } = await import('./printBridge');

// Minimal payload exercising every styled block.
const basePayload = {
    titleLines: ['Pork Belly'],
    titleLines2: ['Panza de Cerdo'],
    prepDateLabel: 'PREPPED',
    prepDateNumber: '07/30',
    footer: 'DD MAU',
};

const lineFor = (out, text) => out.lines.find(l => l.text === text);

describe('payloadToBridgeFormat — title bold honors the format', () => {
    it('prints a NON-bold title when titleBold is off', () => {
        const out = payloadToBridgeFormat({ ...basePayload, titleBold: false });
        expect(lineFor(out, 'Pork Belly').bold).toBe(false);
    });

    it('prints a bold title when titleBold is on', () => {
        const out = payloadToBridgeFormat({ ...basePayload, titleBold: true });
        expect(lineFor(out, 'Pork Belly').bold).toBe(true);
    });
});

describe('payloadToBridgeFormat — PREPPED caption honors dateBold', () => {
    it('caption is plain when dateBold is explicitly off', () => {
        const out = payloadToBridgeFormat({ ...basePayload, dateBold: false });
        expect(lineFor(out, 'PREPPED').bold).toBe(false);
        // ...and the date NUMBER agrees (it already honored the flag).
        expect(lineFor(out, '07/30').bold).toBe(false);
    });

    it('caption is bold by default (matches the Epson default em=true)', () => {
        const out = payloadToBridgeFormat(basePayload);
        expect(lineFor(out, 'PREPPED').bold).toBe(true);
    });
});

describe('payloadToBridgeFormat — footer style reaches the renderer', () => {
    it('emits footerBold=false when the admin turned bold off', () => {
        const out = payloadToBridgeFormat({ ...basePayload, footerBold: false });
        expect(out.footerBold).toBe(false);
    });

    it('defaults footerBold to true, matching DEFAULT_LABEL_FORMAT', () => {
        expect(payloadToBridgeFormat(basePayload).footerBold).toBe(true);
    });

    it('clamps footerScale into the editor 1..3 range', () => {
        expect(payloadToBridgeFormat({ ...basePayload, footerScale: 3 }).footerScale).toBe(3);
        expect(payloadToBridgeFormat({ ...basePayload, footerScale: 99 }).footerScale).toBe(3);
        expect(payloadToBridgeFormat({ ...basePayload, footerScale: 0 }).footerScale).toBe(1);
    });
});

describe("payloadToBridgeFormat — Andrew's live saved format is unchanged", () => {
    // The real config/label_format doc as of 2026-07-30. Threading the three
    // flags must be a NO-OP for it, or this change would silently restyle
    // every sticker both stores print.
    it('reproduces the old hardcoded output exactly', () => {
        const out = payloadToBridgeFormat({
            ...basePayload,
            prepDateLabel: '',        // showPreppedLabel is OFF in the live doc
            titleBold: true,          // was hardcoded true  → still bold
            footerBold: false,        // was hardcoded plain → still plain
            dateBold: true,
            footerScale: 1,           // was hardcoded 1×    → unchanged
        });
        expect(lineFor(out, 'Pork Belly').bold).toBe(true);
        expect(out.footerBold).toBe(false);
        expect(out.footerScale).toBe(1);
        expect(lineFor(out, 'PREPPED')).toBeUndefined();
    });
});
