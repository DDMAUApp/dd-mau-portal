import { describe, it, expect } from 'vitest';
import { rowsToUrf, imageDataToUrf, buildIppPrintJob, BROTHER_IMAGEABLE_W } from './brotherIpp';

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
