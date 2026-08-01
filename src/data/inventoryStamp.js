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
 * "Jul 31, 3:45 PM" — the date is ALWAYS shown (Andrew 2026-07-31: "lets add
 * the date too"). It briefly only appeared on non-today counts; carrying it
 * every time means a printed sheet is unambiguous on its own, with no "was
 * this today?" inference left to the reader.
 *
 * Returns '' when there's nothing trustworthy to show.
 */
export function formatCountTime(meta, now = new Date()) {
    if (!meta) return '';
    const iso = meta.atISO;
    if (iso) {
        const d = new Date(iso);
        if (!Number.isNaN(d.getTime())) {
            return `${chiMonthDay(d)}, ${chiTime(d)}`;
        }
    }
    // Legacy row (or an unparseable ISO): only a bare time was ever stored, so
    // there is no date to show. Better an honest time-only stamp than a date
    // invented from when the row happened to be read.
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

// ── Multiple counters on one item ──────────────────────────────────────
// Andrew 2026-07-31: "if multiple people add items make sure to also add that
// person too. maybe put the count next to the name too."
//
// `by`/`at` are LAST-WRITER-WINS, so on an item two people both touched they
// erase each other — the second person's tap made the first one vanish. The
// write path now also accumulates a per-person tally at
//   countMeta[itemId].who[key] = { n: displayName, q: netQty, t: iso }
// where `q` is that person's NET contribution (atomic increment, so two
// devices counting at once both land).
//
// Negative tallies are kept and shown: "Blanca −2" is exactly the evidence
// that answers Andrew's original question for the audit trail — "why weren't
// eggs ordered but it was on the list before". Only an exact zero is dropped,
// since a person who added and then removed the same amount says nothing.

/** Firestore map keys can't carry dots (they'd nest); names can. */
export function staffKey(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'unknown';
}

/**
 * [{ name, qty, when }] oldest-first — reads like a log of who touched it.
 * Falls back to the single legacy by/at stamp (with qty null) when an item
 * predates per-person tracking.
 */
export function listContributors(meta, now = new Date()) {
    if (!meta) return [];
    const who = meta.who;
    if (who && typeof who === 'object') {
        const rows = Object.values(who)
            .filter(v => v && typeof v === 'object')
            .map(v => ({
                name: String(v.n || '').trim(),
                qty: Number(v.q),
                iso: v.t,
            }))
            .filter(r => r.name && Number.isFinite(r.qty) && r.qty !== 0)
            .sort((a, b) => String(a.iso || '').localeCompare(String(b.iso || '')))
            .map(r => ({
                name: r.name,
                qty: r.qty,
                when: formatCountTime({ atISO: r.iso }, now),
            }));
        if (rows.length) return rows;
    }
    // Legacy item: one name, no per-person quantity.
    const name = String(meta.by || '').trim();
    const when = formatCountTime(meta, now);
    if (!name && !when) return [];
    return [{ name, qty: null, when }];
}

/** Signed tally shown beside a name: "2", "−2". */
function fmtQty(q) {
    if (q == null) return '';
    return q < 0 ? `\u{2212}${Math.abs(q)}` : String(q);
}

/**
 * One line per person, newline-separated:
 *   "Andrew 2 — Jul 31, 3:45 PM\nBlanca 1 — Jul 31, 4:10 PM"
 *
 * Returned as a STRING (not an array) on purpose: the row components that
 * render it are memo'd, and a fresh array identity every render would defeat
 * the memo across a long list. Strings compare by value.
 */
export function formatCountStampLines(meta, now = new Date()) {
    return listContributors(meta, now)
        .map(({ name, qty, when }) => {
            const head = qty == null ? name : `${name} ${fmtQty(qty)}`;
            return when ? `${head} — ${when}` : head;
        })
        .join('\n');
}
