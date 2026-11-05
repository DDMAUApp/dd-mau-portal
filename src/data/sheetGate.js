// sheetGate.js: what the inventory sheet allows, by what it has really seen.
//
// Before the first snapshot Operations holds built-in items and zero counts. A
// recount there adds to the real count when the line frees, and Save & Reset there
// replaces the whole counts map. So:
//   loading: no rows, nothing writable.
//   stash:   a reload stash painted the counts.
//   cached:  a cached copy of the document painted them, and the server hasn't answered.
//   live:    a server snapshot has been applied.
// In stash and cached the numbers may be old. + is an increment, so it stays right
// whatever the real count is. - and typed entry write absolutes worked out from the
// number on screen, and bulk controls work on the whole list, so all of those wait
// for the server.
// Behind flag placeRestore. No firebase import.

export const SHEET_OPEN = Object.freeze({ showRows: true, canPlus: true, canSetCount: true, canBulk: true, savedCopy: false });
const SAVED_COPY = Object.freeze({ showRows: true, canPlus: true, canSetCount: false, canBulk: false, savedCopy: true });
const VIEWS = {
    loading: Object.freeze({ showRows: false, canPlus: false, canSetCount: false, canBulk: false, savedCopy: false }),
    stash: SAVED_COPY,
    cached: SAVED_COPY,
    live: SHEET_OPEN,
};

export function sheetView(state, flagOn = true) {
    if (!flagOn) return SHEET_OPEN;
    return VIEWS[state] || VIEWS.loading;
}

// Where a snapshot leaves the sheet. Only the server opens it fully, and once open it
// stays open until the store changes. A cache with no document, or a cached document
// with no counts, says nothing on a stuck line: that's not the same as an empty sheet,
// and zeros there would invite a recount that adds to the real count.
export function nextSheetState(current, { exists, fromCache, hasCounts }) {
    if (!fromCache) return 'live';
    if (current === 'live') return 'live';
    return exists && hasCounts ? 'cached' : current;
}

export const SHEET_TEXT = {
    en: {
        loading: "Loading your sheet. Don't recount yet.",
        slow: 'Still loading. If this stays, close the app and reopen it.',
        cached: 'Saved copy, still connecting. Only + works for now.',
        home: 'Home',
    },
    es: {
        loading: 'Cargando tu hoja. No vuelvas a contar todavía.',
        slow: 'Sigue cargando. Si no cambia, cierra la app y ábrela de nuevo.',
        cached: 'Copia guardada, todavía conectando. Por ahora solo funciona +.',
        home: 'Inicio',
    },
};

export function sheetText(language) {
    return language === 'es' ? SHEET_TEXT.es : SHEET_TEXT.en;
}
