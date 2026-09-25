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

// ── chatDocEqual — Timestamp-aware deep equality for a chat document ──
// 2026-07-21 (chat audit follow-up): ChatCenter derives the open thread's
// `chat` prop with `chats.find(c => c.id === activeChatId)`. Because the
// chats onSnapshot hands back a NEW array on every fan-out — including when
// a DIFFERENT chat gets a typing heartbeat or read-marker — `activeChat`
// was a fresh object reference each time, forcing the whole open thread to
// reconcile for no reason (the "sluggish while a thread is open" symptom).
//
// This lets the caller keep the SAME reference when the active chat's own
// document is unchanged, so the thread only re-renders when ITS data moved
// (new message meta, its own typingByName / lastReadByName, members, …).
//
// Firestore Timestamps compare by their millisecond value (two snapshots of
// the same write produce distinct Timestamp instances that are value-equal),
// so a naive `===` or JSON compare would spuriously report a change. We
// duck-type the Timestamp (toMillis()/seconds) without importing Firestore,
// keeping this file pure + testable.
function tsMillis(v) {
    if (!v || typeof v !== 'object') return null;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') {
        return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
    }
    return null;
}

export function chatDocEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    const am = tsMillis(a);
    const bm = tsMillis(b);
    if (am !== null || bm !== null) return am === bm; // one is a Timestamp
    const ta = typeof a;
    if (ta !== 'object' || typeof b !== 'object') return a === b;
    const aArr = Array.isArray(a);
    if (aArr !== Array.isArray(b)) return false;
    if (aArr) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!chatDocEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!chatDocEqual(a[k], b[k])) return false;
    }
    return true;
}

// ── Pinned-message banner ordering (2026-09-23 chat audit M4) ──────────
// The pin banner + 5-pin cap used to derive from the 50-message window, so
// in a busy chat a pin older than the window vanished (banner gone, cap
// under-counted, drawer jump dead). The thread now subscribes to the
// chat's pinned messages directly (pinned == true + limit, NO orderBy — an
// equality-only query needs no composite index) and orders them here:
// drop soft-deleted ones (the drawer does the same), then oldest-first by
// message createdAt so `list[list.length - 1]` stays the NEWEST pin, same
// contract the windowed version had. Missing createdAt (pending local
// write) sorts last = newest. Ties break by id for a stable order.
export function sortPinsForBanner(pins) {
    const ms = (ts) => (ts && typeof ts.toMillis === 'function')
        ? ts.toMillis()
        : (ts && ts.seconds ? ts.seconds * 1000 : 0);
    return (Array.isArray(pins) ? pins : [])
        .filter(p => p && p.id && p.pinned === true && p.deleted !== true)
        .slice()
        .sort((a, b) => {
            const am = ms(a.createdAt) || Number.MAX_SAFE_INTEGER;
            const bm = ms(b.createdAt) || Number.MAX_SAFE_INTEGER;
            if (am !== bm) return am - bm;
            return String(a.id).localeCompare(String(b.id));
        });
}

// ── Per-conversation notification sweep throttle (2026-09-23 M2) ───────
// Delay before the next sweep of this chat's unread chat notifications:
// at least `settleMs` after the request (the server writes the notification
// a beat after the message lands, so sweeping instantly would miss it) and
// at least `minGapMs` after the previous sweep (a busy thread marks read on
// every arrival — cap the query+batch rate).
export function planNotifSweepDelay({ now, lastSweepAt = 0, settleMs = 4000, minGapMs = 15000 }) {
    const gapWait = lastSweepAt ? (lastSweepAt + minGapMs) - now : 0;
    return Math.max(settleMs, gapWait);
}
// After a sweep fires: did a request land inside its settle window (i.e.
// possibly for a notification that didn't exist yet when the sweep ran)?
// Then one more sweep is needed.
export function needsFollowUpNotifSweep({ firedAt, lastRequestAt, settleMs = 4000 }) {
    return Number.isFinite(lastRequestAt) && lastRequestAt > firedAt - settleMs;
}

// ── 2026-09-25 chat review — pure helpers behind the thread fixes ────────

// Millis from a Firestore Timestamp OR the warm-cache `{seconds}` shape
// (localStorage paint). 0 when missing / pending (serverTimestamp not yet
// resolved reads as null).
export function tsToMillis(ts) {
    const ms = tsMillis(ts);
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

// #21 — does `msg` continue `prev`'s run (same sender within 5 min)? Then the
// bubble hides the sender label + avatar. Used `createdAt.toMillis` only, so
// cold-cache (`{seconds}`) messages never grouped and every bubble repeated
// the name/avatar. A pending message (no createdAt yet) never groups.
export function isSameSenderRun(prev, msg, windowMs = 5 * 60 * 1000) {
    if (!prev || !msg || prev.senderName !== msg.senderName) return false;
    const a = tsToMillis(prev.createdAt);
    const b = tsToMillis(msg.createdAt);
    if (!a || !b) return false;
    return (b - a) < windowMs;
}

// #9 — does this viewer's read marker actually need a write? Skipping the
// no-op write avoids the pending-serverTimestamp echo that flashed an already-
// read chat as unread in the list (and ~one write per chat open). Needed when
// the marker is older than (a) the newest loaded message from SOMEONE ELSE
// (own messages never count as unread / never appear in your own Seen-by —
// the server also stamps the sender's marker on every send) or (b) the chat's
// lastActivityAt when the list preview isn't the viewer's own message (the
// exact test isChatUnread uses).
export function markReadNeeded(chat, messages, me) {
    if (!me) return false;
    const readMs = tsToMillis(chat?.lastReadByName?.[me]);
    let newestOther = 0;
    for (const m of (Array.isArray(messages) ? messages : [])) {
        if (!m || m.senderName === me) continue;
        const ms = tsToMillis(m.createdAt);
        if (ms > newestOther) newestOther = ms;
    }
    const lm = chat?.lastMessage;
    const activityMs = (lm && lm.sender === me) ? 0 : tsToMillis(chat?.lastActivityAt);
    const target = Math.max(newestOther, activityMs);
    if (!target) return !readMs && Array.isArray(messages) && messages.some(m => m && m.senderName !== me);
    return readMs < target;
}

// #14 — after a per-chat notification sweep fires, what next?
//   'followup' — a mark-read request landed inside the sweep's settle window
//                (its notification may not have existed yet) → re-arm now.
//   'late'     — one bounded late sweep ~15s later: the CF writes the
//                notification a beat after the message, and a cold start can
//                push that past the settle window, leaving the badge stuck.
//   null       — done (the late sweep never re-arms another late sweep).
export const LATE_NOTIF_SWEEP_MS = 15000;
export function nextNotifSweepStep({ firedAt, lastRequestAt, wasLate = false, settleMs = 4000 }) {
    if (needsFollowUpNotifSweep({ firedAt, lastRequestAt, settleMs })) return 'followup';
    return wasLate ? null : 'late';
}

// Improvement — ChatCenter's activeChat stabilization: ignore the viewer's
// OWN typing heartbeat (typingByName[me] every ~2s while composing) so it
// doesn't re-render the whole open thread. The thread never shows the
// viewer's own typing, so nothing visible depends on that key.
export function chatDocEqualExceptOwnTyping(a, b, me) {
    if (a === b) return true;
    if (!a || !b || !me) return chatDocEqual(a, b);
    const strip = (c) => {
        const t = c.typingByName;
        if (!t || typeof t !== 'object' || !Object.prototype.hasOwnProperty.call(t, me)) return c;
        const rest = { ...t };
        delete rest[me];
        return { ...c, typingByName: rest };
    };
    return chatDocEqual(strip(a), strip(b));
}

// #11 — "Load older" scroll-restore record ({ height, top, firstId, at }).
// Decide per layout pass. The record used to live until ANY growth, so a
// load that prepended nothing left it armed and the next arrival at the
// BOTTOM threw the view back to the old spot. Now:
//   • drop  — viewer is pinned to the bottom (the ResizeObserver owns that),
//             or the record is stale (> TTL) with no bigger window in flight
//             (hard cap 30s even if one seems in flight);
//   • wait  — nothing prepended yet (first message unchanged: a cache echo of
//             the old window, or growth at the bottom only);
//   • apply — older rows were prepended: keep the reading position.
export const SCROLL_RESTORE_TTL_MS = 3000;
export const SCROLL_RESTORE_HARD_CAP_MS = 30000;
export function planScrollRestore(pending, { now, firstId, atBottom, scrollHeight, inFlight = false }) {
    if (!pending) return { action: 'none' };
    if (atBottom) return { action: 'drop' };
    const age = Number.isFinite(pending.at) ? now - pending.at : Infinity;
    if (age > SCROLL_RESTORE_HARD_CAP_MS) return { action: 'drop' };
    if (!inFlight && age > SCROLL_RESTORE_TTL_MS) return { action: 'drop' };
    if (firstId === pending.firstId) return { action: 'wait' };
    const grewBy = (Number(scrollHeight) || 0) - (Number(pending.height) || 0);
    if (grewBy > 0) return { action: 'apply', top: (Number(pending.top) || 0) + grewBy };
    return { action: 'wait' };
}

// #2 — after a jump's scrollIntoView settles, is the viewport at the bottom?
// (Same 100px threshold as the scroll handler.) The jump forces atBottom
// false so auto-scroll doesn't fight scrollIntoView; this re-measures the
// REAL position so a jump to a message already near the bottom (no scroll
// events fire) doesn't leave auto-scroll + mark-read off for good.
export function isNearBottom({ scrollHeight, scrollTop, clientHeight }, threshold = 100) {
    return ((Number(scrollHeight) || 0) - (Number(scrollTop) || 0) - (Number(clientHeight) || 0)) < threshold;
}
