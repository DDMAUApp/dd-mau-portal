// inventoryDelivery.js — the inventory cart as a DATED purchase order.
//
// Each cart (ops/inventory_{loc}.counts) is built FOR a specific delivery date.
// When the first item lands in an empty cart the app asks "what day is this
// delivery for?"; the list then persists + is archived to history, and on the
// delivery date at 12am Central it auto-empties (order placed → start fresh).
//
// Pure, dependency-free helpers so the client (Operations.jsx) and the Cloud
// Function (functions/) share the SAME date math + history-doc shape + the
// SAME deterministic archive id (so a client+cron race overwrites one row
// instead of writing two). Andrew 2026-06-30.

const CENTRAL_TZ = 'America/Chicago';

// 'YYYY-MM-DD' for `now` in Central time. en-CA formats as YYYY-MM-DD.
export function centralToday(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: CENTRAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
}

// The next calendar day after Central-today, as 'YYYY-MM-DD'. Date-only UTC
// math on the string avoids any DST edge (we only care about the day label).
export function centralTomorrow(now = new Date()) {
    const [y, m, d] = centralToday(now).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
}

// True once we've reached/passed midnight of the delivery day → time to empty.
// String compare is correct for zero-padded ISO dates.
export function shouldAutoEmpty(deliveryDate, todayStr) {
    if (!deliveryDate || typeof deliveryDate !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) return false;
    const today = (typeof todayStr === 'string' && todayStr) ? todayStr : centralToday();
    return deliveryDate <= today;
}

// 'YYYY-MM-DD' → a friendly label like "Fri Jun 27" (local noon avoids any
// timezone day-shift). Returns '' for blank/malformed input.
export function formatDeliveryLabel(ds, isEs = false) {
    if (!ds || !/^\d{4}-\d{2}-\d{2}$/.test(ds)) return '';
    const [y, m, d] = ds.split('-').map(Number);
    const dt = new Date(y, m - 1, d, 12);
    try {
        return dt.toLocaleDateString(isEs ? 'es-US' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    } catch { return ds; }
}

// Deterministic history doc id for an auto-archived delivery cart. Both the
// client backup and the cron key on this, so a double-run overwrites the same
// inventoryHistory_{loc} row (no duplicate "recent order" entries).
export function deliveredDocId(deliveryDate) {
    return `${deliveryDate}_delivered`;
}

// Build the inventoryHistory_{loc} doc for an archived cart — same shape
// saveInventorySnapshot() writes, so RecentOrdersHistoryModal renders it
// identically. Counted-only items, grouped by their category.
//   counts:          { itemId: qty }
//   customInventory: [{ name|category, items: [{ id, name, ... }] }]
//   countMeta:       { itemId: { by, at } }
export function buildHistoryDoc({ counts = {}, customInventory = [], countMeta = {}, deliveryDate = '', nowIso = new Date().toISOString() } = {}) {
    const cleanCounts = {};
    for (const [k, v] of Object.entries(counts)) {
        if (v && Number(v) > 0) cleanCounts[k] = v;
    }
    const items = (customInventory || [])
        .map((cat) => ({
            category: cat.category || cat.name || '',
            items: (cat.items || [])
                .filter((i) => cleanCounts[i.id])
                .map((i) => ({
                    id: i.id,
                    name: i.name || '',
                    nameEs: i.nameEs || '',
                    vendor: i.vendor || i.supplier || '',
                    supplier: i.vendor || i.supplier || '',
                    orderDay: i.orderDay || '',
                    pack: i.pack || '',
                    price: i.price != null ? i.price : null,
                })),
        }))
        .filter((cat) => cat.items.length > 0);
    const cleanMeta = {};
    for (const [k, v] of Object.entries(countMeta || {})) {
        if (cleanCounts[k]) cleanMeta[k] = v;
    }
    return {
        counts: cleanCounts,
        items,
        countMeta: cleanMeta,
        date: nowIso,
        listName: deliveryDate ? `Delivery ${deliveryDate}` : '',
        deliveryDate: deliveryDate || '',
        ordered: {},
    };
}
