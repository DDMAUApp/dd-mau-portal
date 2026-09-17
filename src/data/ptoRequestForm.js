// ptoRequestForm.js — pure rules for the time-off request forms in
// Schedule.jsx (staff PtoRequestModal + manager TimeOffModal).
//
// WHY (2026-09-17, Andrew: "rubi is trying put in her time off request but the
// submit tab is grayed out … its for sept 24th part of the day"): in
// "Part of a day" mode the form shows ONE date input (bound to startDate),
// but the Submit gate still required startDate <= endDate — and endDate, which
// has no input in that mode, stayed at its default of TODAY. Any future day
// made the hidden end date earlier than the start, so Submit was gray forever
// with no explanation. A partial-day request is single-day by definition
// (submit() sends endDate = startDate), so the end date is simply not part of
// the question there. Extracted so the rule can't silently regress.

/**
 * @returns {{ canSubmit: boolean, missing: null|'date'|'dateOrder'|'time'|'timeOrder'|'reason' }}
 * `missing` names the FIRST unmet requirement so the UI can say why Submit is gray.
 * `requireReason: false` for the manager form (reason optional there).
 */
export function ptoFormStatus(form, { requireReason = true } = {}) {
    const f = form || {};
    const no = (missing) => ({ canSubmit: false, missing });
    if (f.partial) {
        if (!f.startDate) return no('date');
        if (!f.startTime || !f.endTime) return no('time');
        if (!(f.startTime < f.endTime)) return no('timeOrder');
    } else {
        if (!f.startDate || !f.endDate) return no('date');
        if (f.startDate > f.endDate) return no('dateOrder');
    }
    if (requireReason && String(f.reason || '').trim().length === 0) return no('reason');
    return { canSubmit: true, missing: null };
}

/**
 * Apply one field change. Moving the start date past the end date drags the
 * end date along — "From Oct 3" with an untouched "To <today>" used to gray
 * Submit with no hint; a single day off is the overwhelmingly common intent.
 */
export function applyPtoFormChange(form, key, value) {
    const next = { ...(form || {}), [key]: value };
    if (key === 'startDate' && value && (!next.endDate || next.endDate < value)) next.endDate = value;
    return next;
}
