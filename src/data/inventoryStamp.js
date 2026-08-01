// Who counted an inventory item, and when.
//
// Andrew 2026-07-31: "for all the inventory lists i want to have time stamps
// for all the items that gets added… i want my name and timestamp to show up
// under the - count window and +. also when we print i want it to show up
// there too."
//
// The data already existed: every count write stamps
// /ops/inventory_{loc}.countMeta[itemId] = { by, at }. It was only ever
// rendered in the Master List view, and nowhere on the printed order sheet.
//
// ⚠ WHY THIS ISN'T JUST `meta.at`: the stored `at` is TIME-ONLY ("3:45 PM"),
// written with toLocaleTimeString. An inventory cart is not a same-day thing —
// it builds across days until the delivery date empties it — so a count made
// on Tuesday renders as a bare "3:45 PM" on Thursday and reads as *today*.
// That's actively misleading on a sheet someone orders from. New writes also
// record `atISO`, which lets us date-qualify anything that isn't from today.
// Legacy rows have no `atISO` and degrade to the bare time, exactly as before.
//
// Everything is anchored to America/Chicago (both stores) rather than device
// local time — the same rule the checklist system uses — so an iPad left on
// the wrong timezone can't shift which day a count belongs to.

const CHI = 'America/Chicago';

const chiDay = (d) => new Intl.DateTimeFormat('en-CA', {
    timeZone: CHI, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

const chiTime = (d) => d.toLocaleTimeString('en-US', {
    timeZone: CHI, hour: 'numeric', minute: '2-digit',
});

const chiMonthDay = (d) => d.toLocaleDateString('en-US', {
    timeZone: CHI, month: 'short', day: 'numeric',
});

/**
 * "3:45 PM" for a count made today, "Jul 29, 3:45 PM" for an older one.
 * Returns '' when there's nothing trustworthy to show.
 */
export function formatCountTime(meta, now = new Date()) {
    if (!meta) return '';
    const iso = meta.atISO;
    if (iso) {
        const d = new Date(iso);
        if (!Number.isNaN(d.getTime())) {
            const time = chiTime(d);
            return chiDay(d) === chiDay(now) ? time : `${chiMonthDay(d)}, ${time}`;
        }
    }
    // Legacy row (or an unparseable ISO): the bare stored time is all we have.
    return String(meta.at || '').trim();
}

/**
 * The full "who — when" line, e.g. "Andrew — 3:45 PM".
 * Empty when the item was never counted by anyone.
 */
export function formatCountStamp(meta, now = new Date()) {
    if (!meta) return '';
    const who = String(meta.by || '').trim();
    const when = formatCountTime(meta, now);
    if (!who && !when) return '';
    if (!who) return when;
    if (!when) return who;
    return `${who} — ${when}`;
}
