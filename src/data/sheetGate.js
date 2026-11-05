// sheetGate.js: what the inventory sheet allows, by what it has really seen.
//
// Before the first snapshot Operations holds built-in items and zero counts. A
// recount there adds to the real count when the line frees, and Save & Reset there
// replaces the whole counts map. So:
//   loading: no rows, nothing writable.
//   stash:   a reload stash painted the counts. Viewing and tapping are fine, since
//            + is an increment. The stash has no custom items, so anything that
//            works on the whole list or catalog waits for a real snapshot.
//   live:    a real snapshot has been applied.
// Behind flag placeRestore. No firebase import.

export const SHEET_OPEN = Object.freeze({ showRows: true, canTap: true, canBulk: true });
const VIEWS = {
    loading: Object.freeze({ showRows: false, canTap: false, canBulk: false }),
    stash: Object.freeze({ showRows: true, canTap: true, canBulk: false }),
    live: SHEET_OPEN,
};

export function sheetView(state, flagOn = true) {
    if (!flagOn) return SHEET_OPEN;
    return VIEWS[state] || VIEWS.loading;
}

// Only what the document really says counts as seeing the sheet. A cache with no
// copy answers "no document" on a stuck line, and that's not the same as an empty sheet.
export function snapshotCountsAsLive({ exists, fromCache }) {
    return !!exists || !fromCache;
}

export const SHEET_TEXT = {
    en: {
        loading: "Loading your sheet. Don't recount yet.",
        slow: 'Still loading. If this stays, close the app and reopen it.',
        home: 'Home',
    },
    es: {
        loading: 'Cargando tu hoja. No vuelvas a contar todavía.',
        slow: 'Sigue cargando. Si no cambia, cierra la app y ábrela de nuevo.',
        home: 'Inicio',
    },
};

export function sheetText(language) {
    return language === 'es' ? SHEET_TEXT.es : SHEET_TEXT.en;
}
