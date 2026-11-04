// The Fried Rice Rice stickers (2026-11-03): labeled rows, at most 21 columns
// on the 40 mm roll, English and Spanish on one sticker.
import { describe, it, expect } from 'vitest';
import {
    RICE_ROUTE_FRIDGE, RICE_ROUTE_TODAY, RICE_STICKER_COLS, RICE_WOK_MARGIN_MIN,
    buildRiceStickerRows, riceRouteDeadlines, riceStickerBrotherLines, stickerDay, stickerName, stickerTime,
} from './riceSticker';

const noon = new Date(2026, 10, 3, 12, 0);    // Tue Nov 3 2026, 12:00p

const todayRow = (over = {}) => {
    const madeAt = over.madeAt || noon;
    const d = riceRouteDeadlines(RICE_ROUTE_TODAY, madeAt);
    return {
        route: RICE_ROUTE_TODAY, batchNo: 4, madeAt: madeAt.toISOString(), startTempF: 198, cookedBy: 'Ana Reyes',
        tossByAt: d.tossByAt.toISOString(), wokByAt: d.wokByAt.toISOString(), ...over,
    };
};
const fridgeRow = (over = {}) => {
    const madeAt = over.madeAt || new Date(2026, 10, 3, 15, 30);
    const d = riceRouteDeadlines(RICE_ROUTE_FRIDGE, madeAt);
    return {
        route: RICE_ROUTE_FRIDGE, batchNo: 6, madeAt: madeAt.toISOString(), startTempF: 198, cookedBy: 'Ana Reyes',
        seventyByAt: d.seventyByAt.toISOString(), fortyOneByAt: d.fortyOneByAt.toISOString(), useByDay: d.useByDay, ...over,
    };
};
const lines = (rows) => rows.map((r) => r.text);
const find = (rows, id) => rows.find((r) => r.id === id);

const assertFits = (rows, ctx) => {
    for (const r of rows) {
        expect(r.text.length * r.width, `${ctx} "${r.text}" at width ${r.width}`).toBeLessThanOrEqual(RICE_STICKER_COLS);
        // eslint-disable-next-line no-control-regex
        expect(/^[\x20-\x7e]*$/.test(r.text), `${ctx} "${r.text}" is plain ASCII`).toBe(true);
    }
};

describe('deadlines', () => {
    it('For Today: toss = made + 4h, wok by = toss minus the margin', () => {
        const d = riceRouteDeadlines(RICE_ROUTE_TODAY, noon);
        expect(d.tossByAt.getTime() - noon.getTime()).toBe(4 * 3600000);
        expect(RICE_WOK_MARGIN_MIN).toBe(15);
        expect(d.tossByAt.getTime() - d.wokByAt.getTime()).toBe(15 * 60000);
        expect(stickerTime(d.tossByAt)).toBe('4:00p');
        expect(stickerTime(d.wokByAt)).toBe('3:45p');
    });

    it('For the Fridge: 70F = +2h, 41F = +6h, use-by = next calendar day', () => {
        const d = riceRouteDeadlines(RICE_ROUTE_FRIDGE, noon);
        expect(stickerTime(d.seventyByAt)).toBe('2:00p');
        expect(stickerTime(d.fortyOneByAt)).toBe('6:00p');
        expect(d.useByDay).toBe('2026-11-04');
    });

    it('an 8:00 PM fridge batch runs its 41F time past midnight, with the use-by still the next day', () => {
        const d = riceRouteDeadlines(RICE_ROUTE_FRIDGE, new Date(2026, 10, 3, 20, 0));
        expect(stickerTime(d.seventyByAt)).toBe('10:00p');
        expect(stickerTime(d.fortyOneByAt)).toBe('2:00a');
        expect(d.useByDay).toBe('2026-11-04');
    });

    it('use-by crosses a month and a year end', () => {
        expect(riceRouteDeadlines(RICE_ROUTE_FRIDGE, new Date(2026, 10, 30, 9, 0)).useByDay).toBe('2026-12-01');
        expect(riceRouteDeadlines(RICE_ROUTE_FRIDGE, new Date(2026, 11, 31, 9, 0)).useByDay).toBe('2027-01-01');
    });

    it('real elapsed hours across a clock change, with a calendar use-by', () => {
        // US fall-back: Sun Nov 1 2026, 2:00a repeats. Elapsed ms stay exact
        // in any timezone, and the use-by never lands on the wrong day.
        const made = new Date(2026, 9, 31, 23, 30);
        const d = riceRouteDeadlines(RICE_ROUTE_FRIDGE, made);
        expect(d.fortyOneByAt.getTime() - made.getTime()).toBe(6 * 3600000);
        expect(d.useByDay).toBe('2026-11-01');
    });
});

describe('small formats', () => {
    it('sticker time', () => {
        expect(stickerTime(new Date(2026, 10, 3, 0, 5))).toBe('12:05a');
        expect(stickerTime(new Date(2026, 10, 3, 12, 0))).toBe('12:00p');
        expect(stickerTime(new Date(2026, 10, 3, 23, 59))).toBe('11:59p');
        expect(stickerTime('not a date')).toBe('');
    });
    it('sticker day takes a Date, an ISO time, or a calendar day that never slips', () => {
        expect(stickerDay(noon)).toBe('TUE 11/03');
        expect(stickerDay(noon.toISOString())).toBe('TUE 11/03');
        expect(stickerDay('2026-11-04')).toBe('WED 11/04');
    });
    it('names: first plus last initial, plain ASCII, cut to the room', () => {
        expect(stickerName('Ana Reyes')).toBe('ANA R');
        expect(stickerName('Concepción Hernández', 7)).toBe('CONCEPC');
        expect(stickerName('María José López')).toBe('MARIA L');
        expect(stickerName('Rubisel')).toBe('RUBISEL');
        expect(stickerName('')).toBe('');
        expect(stickerName(null)).toBe('');
    });
});

describe('For Today sticker', () => {
    it('reads as the owner approved, top to bottom', () => {
        const rows = buildRiceStickerRows(todayRow());
        expect(lines(rows).map((t) => t.trim())).toEqual([
            'FRIED RICE RICE',
            'ARROZ PARA FREIR',
            '#4 TUE 11/03    ANA R',
            'MADE/HECHO     12:00p',
            'TEMP             198F',
            'WOK BY/ANTES    3:45p',
            'TOSS BY/TIRAR ANTES',
            '4:00p',
            'NO FRIDGE/NO AL REFRI',
        ]);
    });

    it('toss time is huge and bold, NO FRIDGE is white on black', () => {
        const rows = buildRiceStickerRows(todayRow());
        expect(find(rows, 'toss_time')).toMatchObject({ width: 4, height: 4, bold: true, reverse: false });
        expect(find(rows, 'no_fridge')).toMatchObject({ reverse: true, bold: true, height: 2 });
        expect(find(rows, 'no_fridge').text).toHaveLength(21);
        expect(find(rows, 'title')).toMatchObject({ height: 2, bold: true });
    });

    it('a six-character toss time drops to 3 wide so it still fits', () => {
        const rows = buildRiceStickerRows(todayRow({ madeAt: new Date(2026, 10, 3, 8, 0) }));
        const huge = find(rows, 'toss_time');
        expect(huge.text.trim()).toBe('12:00p');
        expect(huge.width).toBe(3);
    });

    it('never shows a 70F or 41F line, or a fridge deadline', () => {
        const text = lines(buildRiceStickerRows(todayRow())).join('\n');
        expect(text).not.toMatch(/70F|41F|USE BY|THEN FRIDGE|LATE=/);
    });
});

describe('For the Fridge sticker', () => {
    it('reads as the owner approved, top to bottom', () => {
        const rows = buildRiceStickerRows(fridgeRow());
        expect(lines(rows).map((t) => t.trim())).toEqual([
            'FRIED RICE RICE',
            'ARROZ PARA FREIR',
            'FOR FRIDGE/PARA REFRI',
            '#6 TUE 11/03    ANA R',
            'MADE/HECHO      3:30p',
            'TEMP             198F',
            '70F BY/ANTES    5:30p',
            'THEN FRIDGE/AL REFRI',
            '41F BY/ANTES    9:30p',
            'LATE=TOSS/TARDE=TIRAR',
            'USE BY/USAR WED 11/04',
        ]);
    });

    it('white-on-black route bar, 70F and 41F are tall and bold', () => {
        const rows = buildRiceStickerRows(fridgeRow());
        expect(find(rows, 'for_fridge')).toMatchObject({ reverse: true, height: 2 });
        expect(find(rows, 'for_fridge').text).toHaveLength(21);
        expect(find(rows, 'seventy_by')).toMatchObject({ height: 2, bold: true, reverse: false });
        expect(find(rows, 'forty_one_by')).toMatchObject({ height: 2, bold: true, reverse: false });
    });

    it('has no ice line, no READ BY CLOSE, and no toss time', () => {
        for (const made of [new Date(2026, 10, 3, 12, 0), new Date(2026, 10, 3, 15, 30), new Date(2026, 10, 3, 20, 0)]) {
            const text = lines(buildRiceStickerRows(fridgeRow({ madeAt: made }))).join('\n');
            expect(text).not.toMatch(/\bICE\b|HIELO|READ BY|CIERRE|TOSS BY|WOK BY|NO FRIDGE/);
        }
    });

    it('an 8:00 PM batch prints 70F BY 10:00p and 41F BY 2:00a', () => {
        const rows = buildRiceStickerRows(fridgeRow({ madeAt: new Date(2026, 10, 3, 20, 0) }));
        expect(find(rows, 'seventy_by').text).toBe('70F BY/ANTES   10:00p');
        expect(find(rows, 'forty_one_by').text).toBe('41F BY/ANTES    2:00a');
    });
});

describe('every line fits the 40 mm roll', () => {
    const longName = 'Concepcion Hernandez-Gutierrez De La Cruz';

    it('at the longest values on both stickers', () => {
        const madeAt = new Date(2026, 10, 3, 10, 0);    // 10:00a, 12:00p, 2:00p...
        for (const build of [todayRow, fridgeRow]) {
            const rows = buildRiceStickerRows(build({ madeAt, batchNo: 12, cookedBy: longName, startTempF: 212 }));
            assertFits(rows, 'longest');
            expect(find(rows, 'batch').text).toBe('#12 TUE 11/03 CONCEPC');
        }
    });

    it('at every minute of the day, both routes', () => {
        for (let h = 0; h < 24; h++) {
            for (const m of [0, 5, 59]) {
                const madeAt = new Date(2026, 10, 3, h, m);
                for (const build of [todayRow, fridgeRow]) {
                    assertFits(buildRiceStickerRows(build({ madeAt, batchNo: 12, cookedBy: longName, startTempF: 212 })), `${h}:${m}`);
                }
            }
        }
    });

    it('a three-digit batch number and a name with no room left still fit', () => {
        for (const build of [todayRow, fridgeRow]) {
            assertFits(buildRiceStickerRows(build({ batchNo: 123, cookedBy: longName })), 'batch 123');
        }
    });

    it('stays plain ASCII with accented names', () => {
        const rows = buildRiceStickerRows(todayRow({ cookedBy: 'José Núñez' }));
        assertFits(rows, 'accents');
        expect(find(rows, 'batch').text).toContain('JOSE N');
    });
});

describe('reprints and old rows', () => {
    it('a reprint prints the stored times, not the clock', () => {
        const row = todayRow({ tossByAt: new Date(2026, 10, 3, 16, 0).toISOString() });
        expect(find(buildRiceStickerRows(row), 'toss_time').text.trim()).toBe('4:00p');
    });

    it('a row from before the two-sticker change prints as For Today, with no reading', () => {
        const rows = buildRiceStickerRows({
            batchNo: 3,
            cookedAt: new Date(2026, 10, 2, 10, 15).toISOString(),
            tossByAt: new Date(2026, 10, 2, 14, 15).toISOString(),
            fridgeByAt: new Date(2026, 10, 2, 12, 15).toISOString(),
            cookedBy: 'Laura Hurtado',
        });
        const text = lines(rows).map((t) => t.trim());
        expect(text).toContain('MADE/HECHO     10:15a');
        expect(text).toContain('WOK BY/ANTES    2:00p');
        expect(text).toContain('2:15p');
        expect(text).toContain('NO FRIDGE/NO AL REFRI');
        expect(rows.some((r) => r.id === 'temp')).toBe(false);
    });
});

describe('Brother rows', () => {
    it('are labeled rows with one space, never padded strings', () => {
        const out = riceStickerBrotherLines(buildRiceStickerRows(todayRow()));
        expect(out.map((l) => l.text)).toContain('MADE/HECHO 12:00p');
        expect(out.map((l) => l.text)).toContain('WOK BY/ANTES 3:45p');
        for (const l of out) expect(l.text).not.toMatch(/ {2}/);
    });
    it('carries the reversed bars and the huge toss time', () => {
        const out = riceStickerBrotherLines(buildRiceStickerRows(todayRow()));
        expect(out.find((l) => l.text === 'NO FRIDGE/NO AL REFRI')).toMatchObject({ band: true, bold: true });
        const huge = out.find((l) => l.text === '4:00p');
        expect(huge.scale).toBeGreaterThan(2);
        expect(huge.bold).toBe(true);
    });
});
