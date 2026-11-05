// inventoryAddReport.js: parks one row when adding an inventory item goes wrong.
//
// An add that fails or hangs happens while the line is suspect, so the row is
// parked and sent on a later flush. The rows share the list reload reports use, so
// a run of retries is capped and can't push those out. No firebase import.

import { parkReport, readParkedReports } from './pendingReports';
import { getNetWatchTelemetry } from './netWatch';

export const ADD_DEADLINE_MS = 25000;
export const MAX_ADD_ROWS_PARKED = 5;
export const FEATURE_ADD = 'inventory:add';

export const ADD_FAILED_TEXT = {
    en: "Couldn't save this item yet. Your text is still here. Try again.",
    es: 'No se pudo guardar. Tu texto sigue aquí. Inténtalo de nuevo.',
};

export function addFailedText(language) {
    return language === 'es' ? ADD_FAILED_TEXT.es : ADD_FAILED_TEXT.en;
}

/** outcome: offline | deadline | rejected | late-success | late-rejected. Never throws. */
export function parkInventoryAddRow({ outcome, ageMs = 0, box = null, now = Date.now() }) {
    try {
        const waiting = readParkedReports().filter((r) => r.feature === FEATURE_ADD).length;
        if (waiting >= MAX_ADD_ROWS_PARKED) return null;
        let net = {};
        try { net = getNetWatchTelemetry(now); } catch { /* labels only */ }
        return parkReport({
            feature: FEATURE_ADD,
            reason: `add-${outcome}`,
            notified: true, // a row, not a reload: it never brings up the restart message
            at: now,
            outcome,
            ageMs,
            box,
            net: { ...net, online: typeof navigator !== 'undefined' ? navigator.onLine !== false : null },
        });
    } catch { return null; }
}
