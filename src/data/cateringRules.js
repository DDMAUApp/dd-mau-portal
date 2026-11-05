// Catering order rules the owner sets in Admin → Catering (config/catering).
// Staff get a warning for anything outside them and can still put the order in after
// confirming; each override is saved on the order. Pure, no firebase.

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_LABELS = {
    sun: ['Sunday', 'Domingo'], mon: ['Monday', 'Lunes'], tue: ['Tuesday', 'Martes'], wed: ['Wednesday', 'Miércoles'],
    thu: ['Thursday', 'Jueves'], fri: ['Friday', 'Viernes'], sat: ['Saturday', 'Sábado'],
};

const week = (earliest, latest) => Object.fromEntries(DAYS.map(d => [d, { open: true, earliest, latest }]));

// Starting point until the owner changes it: the owner's own example for delivery
// (weekdays from 11:15, Saturday from 11:45), and no minimum or distance limits yet.
export const DEFAULT_CATERING_SETTINGS = Object.freeze({
    blackouts: [],
    windows: {
        pickup: week('10:30', '20:00'),
        delivery: {
            ...week('11:15', '19:00'),
            sat: { open: true, earliest: '11:45', latest: '19:00' },
            sun: { open: true, earliest: '11:45', latest: '19:00' },
        },
    },
    deliveryWindowMinutes: 30,
    delivery: { minimumOrder: 0, baseFee: 15, includedMiles: 0, perMileOver: 0, maxMiles: 0 },
    stores: {
        webster: { label: 'Webster', address: '8169 Big Bend Blvd, Webster Groves, MO 63119' },
        maryland: { label: 'Maryland Heights', address: '11982 Dorsett Rd, Maryland Heights, MO 63043' },
    },
    notify: { staffNames: [] },
    distanceLookup: false,
});

// Saved settings over the defaults, group by group, so a partly filled doc never
// loses a field.
export function mergeSettings(saved) {
    const d = DEFAULT_CATERING_SETTINGS;
    const s = saved && typeof saved === 'object' ? saved : {};
    const mergeWeek = (base, over) => Object.fromEntries(DAYS.map(k => [k, { ...base[k], ...(over?.[k] || {}) }]));
    return {
        ...d,
        ...s,
        blackouts: Array.isArray(s.blackouts) ? s.blackouts : [],
        windows: {
            pickup: mergeWeek(d.windows.pickup, s.windows?.pickup),
            delivery: mergeWeek(d.windows.delivery, s.windows?.delivery),
        },
        delivery: { ...d.delivery, ...(s.delivery || {}) },
        stores: {
            webster: { ...d.stores.webster, ...(s.stores?.webster || {}) },
            maryland: { ...d.stores.maryland, ...(s.stores?.maryland || {}) },
        },
        notify: { staffNames: Array.isArray(s.notify?.staffNames) ? s.notify.staffNames : [] },
        deliveryWindowMinutes: Number(s.deliveryWindowMinutes) > 0 ? Number(s.deliveryWindowMinutes) : d.deliveryWindowMinutes,
        distanceLookup: s.distanceLookup === true,
    };
}

// '11:30 AM', '1:05 pm', '13:30' → minutes after midnight, or null.
export function parseTime(t) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*([AaPp][Mm])?\s*$/.exec(String(t || ''));
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (min > 59 || h > 23) return null;
    if (m[3]) {
        if (h < 1 || h > 12) return null;
        const pm = /p/i.test(m[3]);
        if (h === 12) h = pm ? 12 : 0;
        else if (pm) h += 12;
    }
    return h * 60 + min;
}

export function formatTime(mins) {
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export function dayKey(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return null;
    return DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}

export function blackoutFor(settings, dateStr, location) {
    return (settings?.blackouts || []).find(b => b?.date === dateStr
        && (!b.location || b.location === 'both' || b.location === location)) || null;
}

// Every time on the picker for a day: 15-minute steps, marked in or out of the
// window. Delivery times read as windows ("11:15 AM – 11:45 AM").
export function timeOptions(settings, dateStr, orderType) {
    const kind = orderType === 'delivery' ? 'delivery' : 'pickup';
    const day = settings?.windows?.[kind]?.[dayKey(dateStr)];
    const from = parseTime(day?.earliest);
    const to = parseTime(day?.latest);
    const span = kind === 'delivery' ? (settings?.deliveryWindowMinutes || 0) : 0;
    const out = [];
    for (let t = 8 * 60; t <= 21 * 60; t += 15) {
        const inside = !!day?.open && from !== null && to !== null && t >= from && t <= to;
        const label = span ? `${formatTime(t)} – ${formatTime(t + span)}` : formatTime(t);
        out.push({ value: formatTime(t), label, inside });
    }
    return out;
}

export function deliveryFeeFor(settings, miles) {
    const d = settings?.delivery || {};
    const base = Number(d.baseFee) || 0;
    const over = Number(miles) - (Number(d.includedMiles) || 0);
    const rate = Number(d.perMileOver) || 0;
    const extra = rate > 0 && Number.isFinite(over) && over > 0 ? Math.ceil(over) * rate : 0;
    return Math.round((base + extra) * 100) / 100;
}

// Everything about this order that's outside the rules. Each item is one warning
// staff must confirm.
export function checkOrder(settings, { date, time, orderType, location, subtotal, miles } = {}) {
    const s = settings || mergeSettings(null);
    const out = [];
    const b = date ? blackoutFor(s, date, location) : null;
    if (b) {
        out.push({
            kind: 'blackout',
            en: `${date} is blacked out${b.note ? `: ${b.note}` : ''}.`,
            es: `${date} está bloqueado${b.note ? `: ${b.note}` : ''}.`,
        });
    }
    const kind = orderType === 'delivery' ? 'delivery' : 'pickup';
    const kindEs = kind === 'delivery' ? 'entrega' : 'recogida';
    const dk = dayKey(date);
    const day = dk ? s.windows?.[kind]?.[dk] : null;
    const [dayEn, dayEs] = DAY_LABELS[dk] || ['', ''];
    if (day && !day.open) {
        out.push({ kind: 'closedDay', en: `No ${kind} orders on ${dayEn}s.`, es: `No hay pedidos de ${kindEs} los ${dayEs.toLowerCase()}.` });
    } else if (day && time) {
        const t = parseTime(time);
        const from = parseTime(day.earliest);
        const to = parseTime(day.latest);
        if (t !== null && from !== null && t < from) {
            out.push({ kind: 'tooEarly', en: `Earliest ${kind} on ${dayEn} is ${formatTime(from)}.`, es: `Lo más temprano para ${kindEs} el ${dayEs.toLowerCase()} es ${formatTime(from)}.` });
        }
        if (t !== null && to !== null && t > to) {
            out.push({ kind: 'tooLate', en: `Latest ${kind} on ${dayEn} is ${formatTime(to)}.`, es: `Lo más tarde para ${kindEs} el ${dayEs.toLowerCase()} es ${formatTime(to)}.` });
        }
    }
    if (kind === 'delivery') {
        const min = Number(s.delivery?.minimumOrder) || 0;
        const sub = Number(subtotal) || 0;
        if (min > 0 && sub < min) {
            out.push({ kind: 'belowMinimum', en: `Delivery minimum is $${min.toFixed(2)} (this order is $${sub.toFixed(2)}).`, es: `El mínimo para entrega es $${min.toFixed(2)} (este pedido es $${sub.toFixed(2)}).` });
        }
        const max = Number(s.delivery?.maxMiles) || 0;
        if (max > 0 && Number(miles) > max) {
            out.push({ kind: 'tooFar', en: `${Number(miles).toFixed(1)} miles is past the ${max}-mile delivery limit.`, es: `${Number(miles).toFixed(1)} millas pasa el límite de ${max} millas.` });
        }
    }
    return out;
}
