// Off-shift detection — client-side mirror of the Cloud Function's
// gate. We compute whether a staff member is "on shift right now"
// using the same window the dispatcher uses:
//   • 30 min before their published shift start, through end-time
//   • overnight shifts (end < start) bump end into the next day
//
// Why duplicate the helper instead of asking the server: this is
// rendered on every keystroke in the composer (to show "🔕 N off-
// shift") — a round-trip per keystroke is the wrong cost shape.
// The client already subscribes to today's shifts in Schedule.jsx;
// ChatThread now subscribes to a slim per-chat shifts query too.
//
// Owners (ids 40, 41) and managers (role matches /manager|owner/i)
// are always considered "on" — they don't get gated. Matches the
// server's exemption.

// Resolve America/Chicago UTC offset for a given date. Uses Intl
// to handle DST automatically. Returns the integer hours we must
// ADD to a CT wall-clock time to get UTC (e.g. 5 in winter, 4 in
// summer — Chicago is GMT-6 / GMT-5).
function ctOffsetHoursFor(y, mo, d) {
    const probe = new Date(Date.UTC(y, mo - 1, d, 12, 0));
    const offsetParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        timeZoneName: 'shortOffset',
    }).formatToParts(probe);
    const offsetLabel = offsetParts.find(p => p.type === 'timeZoneName')?.value || 'GMT-5';
    const offsetMatch = /GMT([+-]?\d+)/.exec(offsetLabel);
    return offsetMatch ? -parseInt(offsetMatch[1], 10) : 5;
}

// Convert a {date:"YYYY-MM-DD", startTime:"HH:mm", endTime:"HH:mm"}
// shift into UTC ms boundaries [startMs, endMs]. Handles overnight.
function shiftWindowMs(sh) {
    if (!sh || !sh.date || !sh.startTime || !sh.endTime) return null;
    const [y, mo, d] = sh.date.split('-').map(Number);
    const [hh, mm] = sh.startTime.split(':').map(Number);
    const [eh, em] = sh.endTime.split(':').map(Number);
    const off = ctOffsetHoursFor(y, mo, d);
    const startMs = Date.UTC(y, mo - 1, d, hh + off, mm);
    let endMs = Date.UTC(y, mo - 1, d, eh + off, em);
    if (endMs <= startMs) endMs += 86400_000;
    return [startMs, endMs];
}

// Manager/owner check — matches the server's logic. Pass a staff
// record. Returns true if they should never be gated.
export function isAlwaysReachable(staffRecord) {
    if (!staffRecord) return false;
    if (staffRecord.id === 40 || staffRecord.id === 41) return true;
    return !!staffRecord.role && /manager|owner/i.test(staffRecord.role);
}

// Given a staff name + a list of TODAY+YESTERDAY's published shifts,
// is this person on shift right now (within 30 min of start through
// end)? Returns true/false. Yesterday is included to catch overnight
// shifts whose `date` is still yesterday in CT but end-time has
// crossed midnight UTC.
export function isOnShiftNow(staffName, shifts) {
    if (!staffName || !Array.isArray(shifts)) return false;
    const now = Date.now();
    for (const sh of shifts) {
        if (sh.staffName !== staffName) continue;
        if (sh.published !== true) continue;
        const win = shiftWindowMs(sh);
        if (!win) continue;
        const [startMs, endMs] = win;
        if (now >= startMs - 30 * 60_000 && now <= endMs) return true;
    }
    return false;
}

// Compute the off-shift set for a list of member names. Returns
// the subset who are NOT on shift right now AND are NOT always-
// reachable (managers/owners). Used by the composer indicator.
export function offShiftMembers(memberNames, shifts, staffList) {
    if (!Array.isArray(memberNames)) return [];
    const out = [];
    for (const name of memberNames) {
        const rec = (staffList || []).find(s => s && s.name === name);
        if (isAlwaysReachable(rec)) continue;
        if (!isOnShiftNow(name, shifts)) out.push(name);
    }
    return out;
}
