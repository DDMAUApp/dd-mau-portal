// riceSticker.js — the Fried Rice Rice batch stickers, as labeled rows.
//
// Andrew 2026-11-03. Two stickers, picked by the print button the cook taps:
//   • For Today  (route 'time_control') — 4-hour clock. WOK BY, huge TOSS BY,
//     NO FRIDGE. Never shows a 70F or 41F line.
//   • For the Fridge (route 'cooling') — 70F BY made + 2h, 41F BY made + 6h,
//     USE BY next day. Never shows a toss time. An 8:00 PM batch goes in the
//     35F fridge and cools overnight (owner's call), so there's no ice line
//     and no READ BY CLOSE line.
//
// This does NOT go through the shared Label Format: a format edit already
// removed COOKED and the toss band from rice once without anyone noticing.
// These lines can't be edited away.
//
// Pure: no Firebase, no printer. Plain ASCII only, at most 21 columns on the
// Epson TM-L100 40 mm roll. English and Spanish share one sticker, because
// the person reading it may not be the person who printed it. A row keeps its
// label and value apart so the Brother (a canvas that centers and wraps) gets
// real labeled rows and not padded strings.

export const RICE_STICKER_COLS = 21;
export const RICE_ROUTE_TODAY = 'time_control';
export const RICE_ROUTE_FRIDGE = 'cooling';
export const RICE_TOSS_HOURS = 4;
// WOK BY = toss minus this. Our rule, not the code's: at 3:58 a bare
// TOSS BY 4:00p reads as time left, when the rice has to be served by then.
export const RICE_WOK_MARGIN_MIN = 15;
export const RICE_70F_HOURS = 2;
export const RICE_41F_HOURS = 6;

const HOUR = 3600000;
const MINUTE = 60000;
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const two = (n) => String(n).padStart(2, '0');

const dayString = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

// All of a route's deadlines for a batch made at `madeAt` (a Date). Hours are
// real elapsed hours (ms math), so they hold across a clock change. The use-by
// is a calendar day: the day after the batch was made.
export function riceRouteDeadlines(route, madeAt) {
    const t = madeAt.getTime();
    if (route === RICE_ROUTE_FRIDGE) {
        const next = new Date(madeAt.getFullYear(), madeAt.getMonth(), madeAt.getDate() + 1);
        return {
            seventyByAt: new Date(t + RICE_70F_HOURS * HOUR),
            fortyOneByAt: new Date(t + RICE_41F_HOURS * HOUR),
            useByDay: dayString(next),
        };
    }
    const tossByAt = new Date(t + RICE_TOSS_HOURS * HOUR);
    return { tossByAt, wokByAt: new Date(tossByAt.getTime() - RICE_WOK_MARGIN_MIN * MINUTE) };
}

// 4:00p / 12:00p. The same string the sticker prints.
export function stickerTime(when) {
    const d = when instanceof Date ? when : new Date(when);
    if (isNaN(d)) return '';
    const h = d.getHours();
    return `${h % 12 || 12}:${two(d.getMinutes())}${h >= 12 ? 'p' : 'a'}`;
}

// TUE 11/03. Takes a Date, an ISO time, or a 'YYYY-MM-DD' day string (parsed
// as a local calendar day, so a use-by day can't slip across midnight UTC).
export function stickerDay(when) {
    let d = when;
    if (typeof when === 'string') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(when);
        d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(when);
    }
    if (!(d instanceof Date) || isNaN(d)) return '';
    return `${WEEKDAYS[d.getDay()]} ${two(d.getMonth() + 1)}/${two(d.getDate())}`;
}

// ANA R from Ana Reyes. Plain ASCII, then cut to the room left on the line:
// at #12 only 7 characters fit, so CONCEPCION H prints as CONCEPC. The log
// keeps the full name.
export function stickerName(name, room = RICE_STICKER_COLS) {
    const parts = String(name || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\x20-\x7e]/g, '')
        .toUpperCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (parts.length === 0) return '';
    const short = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}` : parts[0];
    return short.slice(0, Math.max(0, room)).trim();
}

// Label left, value right, spaces between: the whole line, never over 21.
function pairText(label, value) {
    const room = RICE_STICKER_COLS - value.length - 1;
    const cut = label.slice(0, Math.max(0, room));
    return cut + ' '.repeat(Math.max(1, RICE_STICKER_COLS - cut.length - value.length)) + value;
}

// Centered across the columns this width scale leaves on the roll.
function centerText(text, width = 1) {
    const cols = Math.floor(RICE_STICKER_COLS / width);
    const pad = Math.max(0, cols - text.length);
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
}

const titleRow = () => ({
    id: 'title', style: 'title', label: 'FRIED RICE RICE', value: '',
    text: centerText('FRIED RICE RICE'), width: 1, height: 2, bold: true, reverse: false,
});
const nameEsRow = () => ({
    id: 'name_es', style: 'plain', label: 'ARROZ PARA FREIR', value: '',
    text: centerText('ARROZ PARA FREIR'), width: 1, height: 1, bold: false, reverse: false,
});
const barRow = (id, text) => ({
    id, style: 'bar', label: text, value: '',
    text: centerText(text), width: 1, height: 2, bold: true, reverse: true,
});
const pairRow = (id, label, value, tall = false) => ({
    id, style: tall ? 'tall' : 'row', label, value,
    text: pairText(label, value), width: 1, height: tall ? 2 : 1, bold: tall, reverse: false,
});
const plainRow = (id, text, bold = false) => ({
    id, style: 'plain', label: text, value: '',
    text: centerText(text), width: 1, height: 1, bold, reverse: false,
});

// The huge time: 4 wide when it fits the roll (4:00p), 3 wide for 12:00p.
function hugeRow(id, time) {
    const width = time.length * 4 <= RICE_STICKER_COLS ? 4 : 3;
    return {
        id, style: 'huge', label: time, value: '',
        text: centerText(time, width), width, height: 4, bold: true, reverse: false,
    };
}

function batchRow(row, madeAt) {
    const left = `#${row.batchNo} ${stickerDay(madeAt)}`;
    return pairRow('batch', left, stickerName(row.cookedBy, RICE_STICKER_COLS - left.length - 1));
}

// Old rows and a reprint read their stored times, never the clock, so a
// reprint carries the same deadlines as the first sticker. A row from before
// the two-sticker change prints as For Today, its only route, and leaves out
// the reading it never had.
export function buildRiceStickerRows(row) {
    const madeAt = new Date(row.madeAt || row.cookedAt);
    const temp = Number.isFinite(row.startTempF) ? [pairRow('temp', 'TEMP', `${row.startTempF}F`)] : [];
    if (row.route === RICE_ROUTE_FRIDGE) {
        const d = riceRouteDeadlines(RICE_ROUTE_FRIDGE, madeAt);
        return [
            titleRow(),
            nameEsRow(),
            barRow('for_fridge', 'FOR FRIDGE/PARA REFRI'),
            batchRow(row, madeAt),
            pairRow('made', 'MADE/HECHO', stickerTime(madeAt)),
            ...temp,
            pairRow('seventy_by', '70F BY/ANTES', stickerTime(row.seventyByAt || d.seventyByAt), true),
            plainRow('then_fridge', 'THEN FRIDGE/AL REFRI'),
            pairRow('forty_one_by', '41F BY/ANTES', stickerTime(row.fortyOneByAt || d.fortyOneByAt), true),
            plainRow('late', 'LATE=TOSS/TARDE=TIRAR'),
            pairRow('use_by', 'USE BY/USAR', stickerDay(row.useByDay || d.useByDay)),
        ];
    }
    const d = riceRouteDeadlines(RICE_ROUTE_TODAY, madeAt);
    const tossBy = row.tossByAt || d.tossByAt;
    const wokBy = row.wokByAt || new Date(new Date(tossBy).getTime() - RICE_WOK_MARGIN_MIN * MINUTE);
    return [
        titleRow(),
        nameEsRow(),
        batchRow(row, madeAt),
        pairRow('made', 'MADE/HECHO', stickerTime(madeAt)),
        ...temp,
        pairRow('wok_by', 'WOK BY/ANTES', stickerTime(wokBy)),
        plainRow('toss_by', 'TOSS BY/TIRAR ANTES', true),
        hugeRow('toss_time', stickerTime(tossBy)),
        barRow('no_fridge', 'NO FRIDGE/NO AL REFRI'),
    ];
}

// Same rows for the Brother's canvas, in its {text, scale, bold, band} model.
const BROTHER_SCALE = { title: 1.05, plain: 0.8, bar: 0.8, row: 0.8, tall: 1, huge: 2.2 };
export function riceStickerBrotherLines(rows) {
    return (rows || []).map((r) => ({
        text: r.value ? `${r.label} ${r.value}` : r.label,
        scale: BROTHER_SCALE[r.style] || 0.8,
        bold: !!r.bold,
        ...(r.reverse ? { band: true } : {}),
    }));
}
