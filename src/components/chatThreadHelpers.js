// chatThreadHelpers — pure functions lifted out of ChatThread.jsx
// (3800+ lines) as a first split step. Zero closure captures, zero
// state — these are date/time formatters and message-list groupers
// that are safe to move because the caller passes everything in.
//
// Andrew 2026-05-23 audit follow-up: the giant ChatThread.jsx is on
// the "split me" list. This is the lowest-risk first slice; if it
// proves clean we can extract the modal-style components
// (ScheduledListDrawer, SeenBySheet) and the message cards
// (Announcement / Coverage / 86 / PhotoIssue / TaskHandoff / Poll)
// in follow-up passes. Doing it incrementally avoids the "split
// everything at once and pray" failure mode that plagues big-file
// refactors without test coverage.
//
// Nothing else belongs here unless it has the same shape: pure
// inputs → pure outputs, no React, no Firestore, no imports.

// Compose a one-line summary of a pending scheduled message for
// the "📅 N scheduled" banner above the composer. Picks the FIRST
// pending message (sorted by sendAt elsewhere) and prefixes its
// time with "today" / "tomorrow" / a short date.
export function previewScheduledList(items, isEs) {
    if (!Array.isArray(items) || items.length === 0) return '';
    const first = items[0];
    const text = (first?.payload?.text || '').replace(/\s+/g, ' ').trim();
    const ts = first?.sendAt;
    const ms = ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : 0);
    if (!ms) return text.slice(0, 50);
    const d = new Date(ms);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const tom = new Date(today.getTime() + 86400_000);
    const isTomorrow = d.toDateString() === tom.toDateString();
    const timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const dayStr = sameDay ? (isEs ? 'hoy' : 'today')
        : isTomorrow ? (isEs ? 'mañana' : 'tomorrow')
        : d.toLocaleDateString(isEs ? 'es' : 'en', { month: 'short', day: 'numeric' });
    return `${dayStr} ${timeStr} · ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`;
}

// Relative-time formatter for poll deadlines + similar short labels
// ("in 2h", "in 3d", "1h ago"). Returns localized strings.
export function relativeTime(ms, isEs) {
    if (!ms) return '';
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const past = diff < 0;
    let label;
    if (abs < 60_000) label = isEs ? 'ahora' : 'now';
    else if (abs < 3600_000) label = `${Math.round(abs / 60_000)}m`;
    else if (abs < 86400_000) label = `${Math.round(abs / 3600_000)}h`;
    else label = `${Math.round(abs / 86400_000)}d`;
    if (label === (isEs ? 'ahora' : 'now')) return label;
    return past ? (isEs ? `hace ${label}` : `${label} ago`) : (isEs ? `en ${label}` : `in ${label}`);
}

// Group a flat message list into day-keyed buckets ([{key, label,
// messages: [...]}, ...]). Used to render Today / Yesterday / "Mon
// May 15" separators between messages. Caller ordering is preserved
// inside each bucket (oldest-first within a day).
export function groupByDate(messages, isEs) {
    const groups = [];
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayKey = fmt(new Date());
    const yKey = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return fmt(d); })();
    for (const m of messages) {
        const ts = m.createdAt;
        const ms = ts?.toMillis ? ts.toMillis()
            : (ts?.seconds ? ts.seconds * 1000 : 0);
        const d = ms ? new Date(ms) : new Date();
        const key = fmt(d);
        const label = key === todayKey
            ? (isEs ? 'Hoy' : 'Today')
            : key === yKey
            ? (isEs ? 'Ayer' : 'Yesterday')
            : d.toLocaleDateString(isEs ? 'es' : 'en', { weekday: 'long', month: 'short', day: 'numeric' });
        let last = groups[groups.length - 1];
        if (!last || last.key !== key) {
            last = { key, label, messages: [] };
            groups.push(last);
        }
        last.messages.push(m);
    }
    return groups;
}
