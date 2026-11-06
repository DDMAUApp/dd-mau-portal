// Money on a Toast invoice doc (toast_invoices), as the scraper saves it: each
// item's `price` is the whole line (quantity × unit, with modifiers), `unitPrice`
// is Toast's per-item price, and `breakdown` sums the checks (subtotal, tax, tip,
// discounts, service charges). Invoices synced before 2026-11-05 have no breakdown;
// everything here copes with that. Pure.

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function itemMoney(item) {
    const qty = Number(item?.qty) || 1;
    const line = n(item?.price);
    const unit = n(item?.unitPrice) ?? (line !== null ? Math.round((line / qty) * 100) / 100 : null);
    return { qty, unit, line };
}

// What the customer tipped: the tip on payments plus any service charge Toast marks
// as a gratuity.
export function tipOf(inv) {
    const b = inv?.breakdown || {};
    const gratuity = (Array.isArray(b.serviceCharges) ? b.serviceCharges : [])
        .filter(sc => sc?.gratuity).reduce((sum, sc) => sum + (n(sc.amount) || 0), 0);
    return Math.round(((n(b.tip) || 0) + gratuity) * 100) / 100;
}

// Rows for the price breakdown, in receipt order. Only lines Toast gave us.
export function breakdownRows(inv) {
    const b = inv?.breakdown || {};
    const rows = [];
    // Toast's subtotal (and each item's price) already has discounts taken off, so the
    // discount is shown against the price before it (checked on live invoices, Nov 5).
    if (n(b.discounts) && n(b.subtotal) !== null) {
        rows.push({ key: 'before', en: 'Before discounts', es: 'Antes de descuentos', amount: Math.round((b.subtotal + Math.abs(b.discounts)) * 100) / 100 });
        rows.push({ key: 'discounts', en: 'Discounts', es: 'Descuentos', amount: -Math.abs(b.discounts) });
    }
    if (n(b.subtotal) !== null) rows.push({ key: 'subtotal', en: 'Subtotal', es: 'Subtotal', amount: b.subtotal });
    for (const sc of Array.isArray(b.serviceCharges) ? b.serviceCharges : []) {
        if (n(sc?.amount) === null) continue;
        rows.push({ key: `sc:${sc.name}`, en: sc.gratuity ? `${sc.name} (gratuity)` : sc.name, es: sc.gratuity ? `${sc.name} (propina)` : sc.name, amount: sc.amount });
    }
    if (n(b.tax) !== null) rows.push({ key: 'tax', en: 'Tax', es: 'Impuesto', amount: b.tax });
    if (n(b.tip)) rows.push({ key: 'tip', en: 'Tip', es: 'Propina', amount: b.tip });
    if (rows.length) rows.push({ key: 'total', en: 'Total', es: 'Total', amount: n(inv?.total) ?? n(b.checksTotal) ?? 0, total: true });
    return rows;
}
