// Day of the week on every sticker date stamp (Andrew 2026-09-28: "todays
// stickers should have MONDAY and under that 9/28"). Pins the payload +
// every renderer (Epson XML, Epson preview model, Brother direct) and the
// Custom Print stamp.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, CapacitorHttp: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(), collection: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn(),
    addDoc: vi.fn(), onSnapshot: vi.fn(), serverTimestamp: vi.fn(),
    query: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), deleteField: vi.fn(),
}));
vi.mock('./audit', () => ({ recordAudit: vi.fn() }));
vi.mock('./labelFormat', () => ({ getLabelFormat: vi.fn(), getLabelFormatFast: vi.fn() }));
vi.mock('./brotherIpp', () => ({ printBrotherDirect: vi.fn() }));

import { buildLabelPayload, renderEposXml, buildLabelPreviewModel, freeTextWeekday, freeTextDateStamp } from './labelPrinting';
import { payloadToBridgeFormat } from './printBridge';

const MON = new Date(2026, 8, 28, 9, 15);   // Monday 9/28/2026
const base = { itemName: 'Pho broth', prepDate: MON, shelfLifeDays: 3, format: {} };

describe('prep date stamp weekday', () => {
    it('payload carries the full weekday in the label language', () => {
        expect(buildLabelPayload(base).prepWeekday).toBe('MONDAY');
        expect(buildLabelPayload({ ...base, language: 'es' }).prepWeekday).toBe('LUNES');
        expect(buildLabelPayload({ ...base, prepDate: new Date(2026, 8, 30) }).prepWeekday).toBe('WEDNESDAY');
    });

    it('Epson print: MONDAY sits right above the date', () => {
        const xml = renderEposXml(buildLabelPayload(base));
        const w = xml.indexOf('>MONDAY&#10;');
        const d = xml.indexOf('>09/28/26&#10;');
        expect(w).toBeGreaterThan(-1);
        expect(d).toBeGreaterThan(w);
        expect(xml.slice(w, d)).not.toMatch(/PREPPED|PHO/);
    });

    it('Epson preview model matches the print', () => {
        const segs = buildLabelPreviewModel(buildLabelPayload(base)).segs || buildLabelPreviewModel(buildLabelPayload(base));
        const texts = (Array.isArray(segs) ? segs : segs.segs).map(s => s.text);
        expect(texts.indexOf('MONDAY')).toBe(texts.indexOf('09/28/26') - 1);
    });

    it('Brother direct print gets the weekday line above the date', () => {
        const lines = payloadToBridgeFormat(buildLabelPayload(base)).lines.map(l => l.text);
        expect(lines.indexOf('MONDAY')).toBe(lines.indexOf('09/28/26') - 1);
    });

    it('prints one size step bigger than the date by default (round 2: "a little bigger")', () => {
        const p = buildLabelPayload(base);               // date scale 5 on the 80 mm roll
        expect(p.dateNumberScale).toBe(5);
        expect(p.weekdayHeightScale).toBe(6);
        expect(p.weekdayScale).toBe(6);                  // MONDAY fits 6-wide on 48 cols
        expect(renderEposXml(p)).toMatch(/<text width="6" height="6"\/><text>MONDAY/);
        // Brother: bigger than the date line too
        const lines = payloadToBridgeFormat(p).lines;
        const wd = lines.find(l => l.text === 'MONDAY'), dt = lines.find(l => l.text === '09/28/26');
        expect(wd.scale).toBeGreaterThan(dt.scale);
    });

    it('long names print tall-and-narrow instead of wrapping', () => {
        const p = buildLabelPayload({ ...base, prepDate: new Date(2026, 8, 30) });   // WEDNESDAY, 9 chars
        expect(p.weekdayScale * 9).toBeLessThanOrEqual(p.cols);
        expect(p.weekdayHeightScale).toBe(6);
        expect(renderEposXml(p)).toMatch(new RegExp(`<text width="${p.weekdayScale}" height="6"/><text>WEDNESDAY`));
    });

    it('Label Format weekdayScale sets the size', () => {
        expect(buildLabelPayload({ ...base, format: { weekdayScale: 8 } }).weekdayHeightScale).toBe(8);
        expect(buildLabelPayload({ ...base, format: { weekdayScale: null, dateNumberScale: 4 } }).weekdayHeightScale).toBe(5);
    });

    it('long day names fit a narrow roll (never wrap)', () => {
        const p = buildLabelPayload({ ...base, prepDate: new Date(2026, 8, 30), paperWidthMm: 40, language: 'es' });
        expect(p.prepWeekday).toBe('MIÉRCOLES');
        expect(p.prepWeekday.length * p.weekdayScale).toBeLessThanOrEqual(p.cols);
    });

    it('name-first kinds fold it into the compact date line', () => {
        const xml = renderEposXml(buildLabelPayload({ ...base, format: { layout: 'nameFirst' } }));
        expect(xml).toMatch(/MONDAY 09\/28\/26/);
    });

    it('toggle off, or a kind with no date, prints no weekday', () => {
        expect(buildLabelPayload({ ...base, format: { showPrepWeekday: false } }).prepWeekday).toBe('');
        expect(renderEposXml(buildLabelPayload({ ...base, format: { showPrepWeekday: false } }))).not.toMatch(/MONDAY/);
        expect(buildLabelPayload({ ...base, format: { showDate: false } }).prepWeekday).toBe('');
    });
});

describe('Custom Print date stamp weekday', () => {
    it('weekday line + unchanged stamp', () => {
        expect(freeTextWeekday(MON)).toBe('MONDAY');
        expect(freeTextDateStamp(MON)).toBe('09/28/26 9:15a');
    });
});
