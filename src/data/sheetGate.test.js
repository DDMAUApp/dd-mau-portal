import { describe, expect, it } from 'vitest';
import { SHEET_OPEN, sheetText, sheetView, snapshotCountsAsLive } from './sheetGate';
import { addFailedText } from './inventoryAddReport';

describe('sheetView', () => {
    it('flag off is always open', () => {
        for (const s of ['loading', 'stash', 'live']) expect(sheetView(s, false)).toBe(SHEET_OPEN);
    });
    it('loading allows nothing', () => expect(sheetView('loading')).toEqual({ showRows: false, canTap: false, canBulk: false }));
    it('a stash paint allows viewing and tapping only', () => expect(sheetView('stash')).toEqual({ showRows: true, canTap: true, canBulk: false }));
    it('live allows everything', () => expect(sheetView('live')).toBe(SHEET_OPEN));
    it('an unknown state fails closed', () => expect(sheetView('x').showRows).toBe(false));
});

describe('snapshotCountsAsLive', () => {
    it('a cache with no copy is not an empty sheet', () => {
        expect(snapshotCountsAsLive({ exists: false, fromCache: true })).toBe(false);
        expect(snapshotCountsAsLive({ exists: false, fromCache: false })).toBe(true);
        expect(snapshotCountsAsLive({ exists: true, fromCache: true })).toBe(true);
    });
});

describe('wording matches the plan', () => {
    it('sheet', () => {
        expect(sheetText('en').loading).toBe("Loading your sheet. Don't recount yet.");
        expect(sheetText('es').loading).toBe('Cargando tu hoja. No vuelvas a contar todavía.');
        expect(sheetText('en').slow).toBe('Still loading. If this stays, close the app and reopen it.');
        expect(sheetText('es').slow).toBe('Sigue cargando. Si no cambia, cierra la app y ábrela de nuevo.');
    });
    it('add failed', () => {
        expect(addFailedText('en')).toBe("Couldn't save this item yet. Your text is still here. Try again.");
        expect(addFailedText('es')).toBe('No se pudo guardar. Tu texto sigue aquí. Inténtalo de nuevo.');
    });
});
