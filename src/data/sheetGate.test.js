import { describe, expect, it } from 'vitest';
import { SHEET_OPEN, nextSheetState, sheetText, sheetView } from './sheetGate';
import { addFailedText } from './inventoryAddReport';

describe('sheetView', () => {
    it('flag off is always open', () => {
        for (const s of ['loading', 'stash', 'cached', 'live']) expect(sheetView(s, false)).toBe(SHEET_OPEN);
    });
    it('loading allows nothing', () => expect(sheetView('loading')).toEqual({ showRows: false, canPlus: false, canSetCount: false, canBulk: false, savedCopy: false }));
    it('a stash paint or a cached copy allows viewing and + only, with the line', () => {
        const plusOnly = { showRows: true, canPlus: true, canSetCount: false, canBulk: false, savedCopy: true };
        expect(sheetView('stash')).toEqual(plusOnly);
        expect(sheetView('cached')).toEqual(plusOnly);
    });
    it('live allows everything', () => expect(sheetView('live')).toBe(SHEET_OPEN));
    it('an unknown state fails closed', () => expect(sheetView('x').showRows).toBe(false));
});

describe('nextSheetState', () => {
    const cached = (exists, hasCounts) => ({ exists, fromCache: true, hasCounts });
    it('a cache with no copy, or a copy with no counts, is not an empty sheet', () => {
        for (const from of ['loading', 'stash', 'cached']) {
            expect(nextSheetState(from, cached(false, false))).toBe(from);
            expect(nextSheetState(from, cached(true, false))).toBe(from);
        }
    });
    it('a cached copy with counts is cached, whatever was on screen before', () => {
        expect(nextSheetState('loading', cached(true, true))).toBe('cached');
        expect(nextSheetState('stash', cached(true, true))).toBe('cached');
    });
    it('only the server makes it live, and live stays live', () => {
        for (const from of ['loading', 'stash', 'cached']) {
            expect(nextSheetState(from, { exists: true, fromCache: false, hasCounts: false })).toBe('live');
            expect(nextSheetState(from, { exists: false, fromCache: false, hasCounts: false })).toBe('live');
        }
        expect(nextSheetState('live', cached(true, true))).toBe('live');
        expect(nextSheetState('live', cached(false, false))).toBe('live');
    });
});

describe('wording matches the plan', () => {
    it('sheet', () => {
        expect(sheetText('en').loading).toBe("Loading your sheet. Don't recount yet.");
        expect(sheetText('es').loading).toBe('Cargando tu hoja. No vuelvas a contar todavía.');
        expect(sheetText('en').slow).toBe('Still loading. If this stays, close the app and reopen it.');
        expect(sheetText('es').slow).toBe('Sigue cargando. Si no cambia, cierra la app y ábrela de nuevo.');
        expect(sheetText('en').cached).toBe('Saved copy, still connecting. Only + works for now.');
        expect(sheetText('es').cached).toBe('Copia guardada, todavía conectando. Por ahora solo funciona +.');
    });
    it('add failed', () => {
        expect(addFailedText('en')).toBe("Couldn't save this item yet. Your text is still here. Try again.");
        expect(addFailedText('es')).toBe('No se pudo guardar. Tu texto sigue aquí. Inténtalo de nuevo.');
    });
});
