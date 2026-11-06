// Matches app catering orders to the Toast invoices the scraper syncs
// (toast_invoices), and lists where they disagree. Pure, no firebase.
//
// A match needs the same day plus the same customer (phone, email or name). Staff
// can unlink a wrong match (order.toastUnlinked) or link one by hand (order.toastLink),
// and a hand link always wins.
import { parseTime } from './cateringRules';
import { tipOf } from './invoiceMoney';

const TZ = 'America/Chicago';
const digits = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const lower = (v) => String(v || '').trim().toLowerCase();
const words = (v) => lower(v).normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 1);

// Toast's promised time, as the store's local date and minutes after midnight.
export function invoiceLocal(inv) {
    const d = new Date(inv?.promisedDate || '');
    if (Number.isNaN(d.getTime())) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function sameCustomer(order, inv) {
    const c = order?.customer || {};
    let score = 0;
    if (digits(c.phone).length === 10 && digits(c.phone) === digits(inv.phone)) score += 3;
    if (lower(c.email) && lower(c.email) === lower(inv.email)) score += 3;
    const ow = new Set(words(c.name));
    const iw = [...words(inv.customerName), ...words(inv.companyName)];
    const shared = iw.filter(w => ow.has(w)).length;
    if (shared >= 2 || (shared === 1 && ow.size === 1)) score += 2;
    else if (shared === 1) score += 1;
    return score;
}

const isDelivery = (inv) => (typeof inv.isDelivery === 'boolean' ? inv.isDelivery : !!(inv.deliveryAddress || inv.address));
const storeOf = (v) => (/mary/i.test(String(v || '')) ? 'maryland' : /webster/i.test(String(v || '')) ? 'webster' : '');
export const TOTAL_TOLERANCE = 1;
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
export const NOT_FOOD = /deliver|\bfee\b|utensil|plates?\b|chopstick|napkin|\btip\b|gratuity|service charge/i;

// Where the app order and the Toast invoice disagree.
export function compareOrder(order, inv) {
    const out = [];
    const c = order?.customer || {};
    const appTotal = Number(order?.total) || 0;
    // Customers sometimes add a tip in Toast; the app order never has one, so it's left out.
    const tip = tipOf(inv);
    const toastTotal = (Number(inv?.total) || 0) - tip;
    const tipNote = tip > 0 ? [` (not counting a ${money(tip)} tip)`, ` (sin contar ${money(tip)} de propina)`] : ['', ''];
    // Within a dollar is fine (owner, 2026-11-05).
    if (Math.round(Math.abs(appTotal - toastTotal) * 100) > TOTAL_TOLERANCE * 100) out.push({ kind: 'total', en: `Total: app ${money(appTotal)}, Toast ${money(toastTotal)}${tipNote[0]}`, es: `Total: app ${money(appTotal)}, Toast ${money(toastTotal)}${tipNote[1]}` });
    const appQty = (Array.isArray(order?.items) ? order.items : []).reduce((n, i) => n + (Number(i.qty) || 0), 0);
    // Toast lists fees and utensils as items; the app keeps them apart, so only food counts.
    const toastQty = (Array.isArray(inv?.items) ? inv.items : [])
        .filter(i => !NOT_FOOD.test(String(i?.name || '')))
        .reduce((n, i) => n + (Number(i.qty) || 0), 0);
    if (appQty !== toastQty) out.push({ kind: 'items', en: `Items: app ${appQty}, Toast ${toastQty}`, es: `Artículos: app ${appQty}, Toast ${toastQty}` });
    const local = invoiceLocal(inv);
    if (local && c.date && local.date !== c.date) {
        out.push({ kind: 'date', en: `Date: app ${c.date}, Toast ${local.date}`, es: `Fecha: app ${c.date}, Toast ${local.date}` });
    } else {
        const t = parseTime(c.time);
        if (local && t !== null && Math.abs(local.minutes - t) > 15) {
            const fmt = (m) => `${(Math.floor(m / 60) % 12) || 12}:${String(m % 60).padStart(2, '0')} ${m >= 720 ? 'PM' : 'AM'}`;
            out.push({ kind: 'time', en: `Time: app ${fmt(t)}, Toast ${fmt(local.minutes)}`, es: `Hora: app ${fmt(t)}, Toast ${fmt(local.minutes)}` });
        }
    }
    const appDelivery = c.orderType === 'delivery';
    if (appDelivery !== isDelivery(inv)) {
        out.push({ kind: 'type', en: `App says ${appDelivery ? 'delivery' : 'pickup'}, Toast says ${appDelivery ? 'pickup' : 'delivery'}`, es: `La app dice ${appDelivery ? 'entrega' : 'recogida'}, Toast dice ${appDelivery ? 'recogida' : 'entrega'}` });
    }
    const appStore = storeOf(c.pickupLocation);
    const toastStore = storeOf(inv?.location);
    if (appStore && toastStore && appStore !== toastStore) out.push({ kind: 'store', en: `Store: app ${appStore}, Toast ${toastStore}`, es: `Tienda: app ${appStore}, Toast ${toastStore}` });
    return out;
}

// Each order → { invoice, manual, diffs }. One invoice is never given to two orders.
export function matchOrders(orders, invoices) {
    const list = Array.isArray(orders) ? orders : [];
    const invs = (Array.isArray(invoices) ? invoices : []).filter(i => i?.invoiceGuid);
    const byGuid = new Map(invs.map(i => [i.invoiceGuid, i]));
    const result = new Map();
    const taken = new Set();

    for (const o of list) {
        const guid = o?.toastLink?.invoiceGuid;
        if (guid && byGuid.has(guid)) {
            const inv = byGuid.get(guid);
            taken.add(guid);
            result.set(o.id, { invoice: inv, manual: true, diffs: compareOrder(o, inv) });
        }
    }

    const candidates = [];
    for (const o of list) {
        if (result.has(o.id) || !o?.customer?.date) continue;
        const skip = new Set(Array.isArray(o.toastUnlinked) ? o.toastUnlinked : []);
        const t = parseTime(o.customer.time);
        for (const inv of invs) {
            if (taken.has(inv.invoiceGuid) || skip.has(inv.invoiceGuid)) continue;
            const local = invoiceLocal(inv);
            if (!local || local.date !== o.customer.date) continue;
            const who = sameCustomer(o, inv);
            if (who < 2) continue;
            const timeGap = t !== null ? Math.abs(local.minutes - t) : 600;
            const totalGap = Math.abs((Number(o.total) || 0) - (Number(inv.total) || 0));
            candidates.push({ o, inv, rank: who * 1000 - Math.min(timeGap, 600) - Math.min(totalGap, 300) });
        }
    }
    candidates.sort((a, b) => b.rank - a.rank);
    for (const { o, inv } of candidates) {
        if (result.has(o.id) || taken.has(inv.invoiceGuid)) continue;
        taken.add(inv.invoiceGuid);
        result.set(o.id, { invoice: inv, manual: false, diffs: compareOrder(o, inv) });
    }
    for (const o of list) if (!result.has(o.id)) result.set(o.id, { invoice: null, manual: false, diffs: [] });
    return result;
}

// Invoices a person could link by hand: same week as the order, nearest first.
export function linkChoices(order, invoices, limit = 12) {
    const day = Date.parse(`${order?.customer?.date || ''}T12:00:00Z`);
    if (!Number.isFinite(day)) return [];
    return (Array.isArray(invoices) ? invoices : [])
        .map(inv => ({ inv, local: invoiceLocal(inv) }))
        .filter(x => x.local && Math.abs(Date.parse(`${x.local.date}T12:00:00Z`) - day) <= 7 * 864e5)
        .sort((a, b) => Math.abs(Date.parse(`${a.local.date}T12:00:00Z`) - day) - Math.abs(Date.parse(`${b.local.date}T12:00:00Z`) - day))
        .slice(0, limit)
        .map(x => x.inv);
}
