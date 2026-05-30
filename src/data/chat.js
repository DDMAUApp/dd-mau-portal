// Chat helpers — pure functions, no React, no Firebase.
//
// These get tested standalone (see chat.test.js) and reused across
// ChatCenter / ChatThread / ChatSettingsModal so the permission model
// has a single source of truth.

import { isAdminId } from './staff';
//
// ── Chat schema (Firestore /chats/{chatId}) ────────────────────────────
//   type:            'dm' | 'group' | 'channel'
//   name:            string           — display name (for groups + channels)
//   emoji:           string?          — optional fun icon for groups
//   members:         string[]         — staff names
//   admins:          string[]         — names allowed to edit (besides app admins)
//   createdBy:       string           — staff name
//   createdByTier:   'admin' | 'manager' | 'staff' — at create time, determines edit floor
//   editTier:        'admin' | 'manager' | 'staff' — copied from createdByTier (kept as separate
//                                                    field so admin can downgrade later)
//   createdAt:       Timestamp
//   lastMessage:     { text, sender, ts, type } — denormalized for chat-list preview
//   lastActivityAt:  Timestamp        — sortable preview
//   channelKey:      'all'|'foh'|'boh' — only set for type='channel'; pins membership rule
//   lastReadByName:  { 'Cash': Timestamp, ... } — per-member last-read marker (used by unread)
//   typingByName:    { 'Cash': Timestamp, ... } — per-member typing heartbeat (5s TTL client side)
//
// ── Message schema (Firestore /chats/{chatId}/messages/{id}) ────────────
//   senderName:   string
//   senderId:     number?
//   type:         'text' | 'image' | 'video' | 'audio' | 'system'
//   text:         string                — message body (for text + as caption for media)
//   mediaUrl:     string?               — Firebase Storage download URL
//   mediaPath:    string?               — Storage path (for deletion/re-fetch)
//   mediaType:    string?               — MIME type
//   duration:     number?               — seconds (audio/video)
//   width:        number?               — pixels (image/video)
//   height:       number?               — pixels (image/video)
//   thumbnailUrl: string?               — video preview (TODO: generate)
//   createdAt:    Timestamp
//   reactions:    { '👍': string[], '❤️': string[] } — emoji → list of staff names
//   mentions:     string[]              — staff names parsed from @-tokens
//   replyTo:      { id, senderName, snippet, type }? — quote-reply target (UI: pill above bubble + composer preview)
//   edited:       boolean?
//   deleted:      boolean?              — soft-delete; the bubble shows "deleted" placeholder

// Stable channel ID derived from the channel key. Using a deterministic
// ID (not addDoc-generated) lets us upsert the channel document on every
// boot without creating duplicates if multiple devices race.
export function channelDocId(key) {
    return `channel_${key}`;
}

// Stable DM ID derived from the two participant names — sorted so the
// same pair always resolves to the same chat regardless of who started.
// We normalize whitespace + lowercase the key so case-mismatched name
// data doesn't fork a DM into two threads.
export function dmDocId(nameA, nameB) {
    const a = String(nameA || '').trim();
    const b = String(nameB || '').trim();
    const [lo, hi] = [a, b].sort((x, y) => x.localeCompare(y));
    // We're embedding the names so admins can read the document ID and
    // know who's talking; if names contain firestore-illegal chars the
    // doc creation will fail and we'd want to know. Names in DD Mau's
    // staff list are clean (no /, no .) so this is safe in practice.
    const safe = s => s.replace(/[/.#$\[\]]/g, '_');
    return `dm_${safe(lo)}__${safe(hi)}`;
}

// Tier of a staff record. Mirrors App.jsx's isAdmin + isManager logic.
// Pure function — pass the staff record + isAdmin flag (since admin is
// ID-based and the caller already has it computed).
export function tierOf(staffRecord, isAdminFlag) {
    if (isAdminFlag) return 'admin';
    if (staffRecord && /manager/i.test(staffRecord.role || '')) return 'manager';
    return 'staff';
}

const TIER_RANK = { staff: 0, manager: 1, admin: 2 };

// Can this user edit this chat's membership / name / settings?
//
// Rules (matches the user's exact spec):
//   • DMs:               never editable.
//   • Channels:          only admins (auto-membership, but admins can rename / re-emoji).
//   • Groups:
//       - editTier='admin'   → admin only
//       - editTier='manager' → manager OR admin
//       - editTier='staff'   → creator OR admin OR anyone in chat.admins[]
//
// The chat.admins[] array lets group owners deputize someone else to
// help manage the group without giving them app-wide admin powers.
export function canEditChat(chat, viewer, isAdminFlag) {
    if (!chat || !viewer) return false;
    // DMs are never editable, even by app admin — a private 2-person
    // conversation isn't something to be moderated. (The chat-settings
    // modal hides every control for DMs as a UI-level belt-and-suspenders.)
    if (chat.type === 'dm') return false;
    if (isAdminFlag) return true;                       // app admin always wins (for groups + channels)
    if (chat.type === 'channel') return false;          // only admin path above
    const tier = tierOf(viewer, isAdminFlag);
    const rank = TIER_RANK[tier] ?? 0;
    const requiredRank = TIER_RANK[chat.editTier || 'staff'] ?? 0;
    if (rank >= requiredRank) {
        // Manager+ groups: any peer of the right tier can manage.
        // Staff groups: only the creator + listed group-admins.
        if (chat.editTier === 'staff') {
            if (chat.createdBy === viewer.name) return true;
            if (Array.isArray(chat.admins) && chat.admins.includes(viewer.name)) return true;
            return false;
        }
        return true;
    }
    return false;
}

// Membership: who SHOULD belong to a channel right now?
// Used by ChatCenter on mount to refresh the channel's members array
// when the staff list changes (hires + terminations + side moves).
//
// 'all'  — every staff that isn't hidden from the schedule (i.e. real
//          working staff, not test accounts / former employees marked
//          hideFromSchedule). Owners are included so they get the
//          notifications.
// 'foh'  — staff with scheduleSide === 'foh' OR side === 'foh' OR role
//          tagged FOH (Server, Cashier, Host, Bartender).
// 'boh'  — staff with scheduleSide === 'boh' OR side === 'boh' OR role
//          tagged BOH (Cook, Prep, Dishwasher, Kitchen, BOH).
export function channelMembersFor(key, staffList) {
    const list = Array.isArray(staffList) ? staffList : [];
    // We DON'T filter by hideFromSchedule here — that flag suppresses
    // the staff member from the SCHEDULE GRID (owners typically toggle
    // it on themselves since they don't work shifts), but they're still
    // part of the team and need access to chat. 2026-05-16 bug fix:
    // Julie (id 41) was missing from the chat picker because she has
    // hideFromSchedule: true.
    const visible = list.filter(s => s && s.name);
    // Resolve the autoMembership rule from either the live AUTO_CHANNELS
    // (currently empty for DD Mau — Andrew opted out) OR the archived
    // definitions so legacy channelKey docs still resolve. Falls back
    // to the raw key for short-form callers that pass 'foh' / 'boh' /
    // 'managers' / 'loc:webster' / 'foh:maryland' directly.
    const def = AUTO_CHANNELS.find(c => c.key === key)
             || _ARCHIVED_AUTO_CHANNELS.find(c => c.key === key);
    const rule = def?.autoMembership || key;
    if (rule === 'all') return visible.map(s => s.name);
    if (rule === 'foh') return visible.filter(isFohRole).map(s => s.name);
    if (rule === 'boh') return visible.filter(isBohRole).map(s => s.name);
    if (rule === 'managers') return visible.filter(isManagerRole).map(s => s.name);
    if (typeof rule === 'string' && rule.startsWith('loc:')) {
        const loc = rule.slice(4);
        return visible
            .filter(s => s.location === loc || s.location === 'both')
            .map(s => s.name);
    }
    // side+location combo: 'foh:webster' / 'boh:maryland' / etc.
    // Joins staff whose side matches AND whose location matches (or 'both').
    // Owners + managers auto-join every side+location pair within their
    // location scope so admin/management can see kitchen + service
    // chatter at each store.
    const sideLoc = /^(foh|boh):(\w+)$/.exec(typeof rule === 'string' ? rule : '');
    if (sideLoc) {
        const [, sideKey, loc] = sideLoc;
        const sideMatch = sideKey === 'foh' ? isFohRole : isBohRole;
        return visible
            .filter(s => {
                const locOk = s.location === loc || s.location === 'both';
                if (!locOk) return false;
                // Owners + managers see side chatter regardless of role.
                if (isManagerRole(s)) return true;
                return sideMatch(s);
            })
            .map(s => s.name);
    }
    return [];
}

function isManagerRole(s) {
    if (isAdminId(s.id)) return true; // owners
    return s.role && /manager|owner/i.test(s.role);
}

function isFohRole(s) {
    if (s.scheduleSide === 'foh' || s.side === 'foh') return true;
    if (s.role && /foh|front|server|cashier|host|bartender/i.test(s.role)) return true;
    return false;
}

function isBohRole(s) {
    if (s.scheduleSide === 'boh' || s.side === 'boh') return true;
    if (s.role && /boh|kitchen|cook|prep|dish/i.test(s.role)) return true;
    return false;
}

// Strip @-mentions out of a body and return both the cleaned text and
// the matched staff names. Mentions match against the live staffList
// so we don't notify people who don't exist.
//
// Token format: @FirstName or @"First Last" — we accept either bare
// (until a space) or quoted (for staff with multi-word names where the
// last name matters).
//
// Bare-mention regex uses the Unicode property escape \p{L} so names
// with accented characters parse correctly. @María, @José, @Andrés
// all match. Without this, the regex stopped at the first non-ASCII
// letter and the mention was silently dropped — DD Mau has bilingual
// staff and this caused notifications to miss the @-target whenever
// the typer used the accented spelling.
//
// The 'u' flag is required for \p{...} support. All current browser
// targets (modern Chrome/Safari/Firefox, included Safari 14+ on iOS)
// handle it.
export function parseMentions(text, staffList) {
    if (!text || typeof text !== 'string') return { mentions: [] };
    const list = Array.isArray(staffList) ? staffList : [];
    const names = list.map(s => s.name).filter(Boolean);
    const found = new Set();
    // Quoted: @"First Last"
    const quoted = text.matchAll(/@"([^"]+)"/g);
    for (const m of quoted) {
        const target = names.find(n => n.toLowerCase() === m[1].toLowerCase());
        if (target) found.add(target);
    }
    // Bare: @firstname (Unicode-letter-aware so @María / @José work).
    const bare = text.matchAll(/@(\p{L}[\p{L}'\-]*)/gu);
    for (const m of bare) {
        const lower = m[1].toLowerCase();
        // Match by first name, then full name. Pick the most specific.
        const firstNameMatch = names.find(n => n.split(' ')[0].toLowerCase() === lower);
        const fullMatch = names.find(n => n.toLowerCase() === lower);
        const target = fullMatch || firstNameMatch;
        if (target) found.add(target);
    }
    return { mentions: Array.from(found) };
}

// One-line preview of a message for chat-list rendering.
// Shows the sender's first name + a short summary depending on type.
// Bilingual via the {en, es} ternary at the call site (we just return
// English here for the data layer; the UI rewraps).
export function previewOf(msg) {
    if (!msg) return '';
    if (msg.deleted) return '(deleted)';
    const who = msg.senderName ? msg.senderName.split(' ')[0] + ': ' : '';
    if (msg.type === 'image') return who + '📷 Photo';
    if (msg.type === 'video') return who + '🎬 Video';
    if (msg.type === 'audio') return who + '🎤 Voice message';
    if (msg.type === 'poll') return who + '📊 ' + (msg.poll?.question || 'Poll');
    if (msg.type === 'eighty_six_alert') {
        const d = msg.eightySixData || {};
        const prefix = d.transition === 'in' ? '✅ Back in stock' : '🚫 86';
        return who + `${prefix}: ${d.itemName || 'item'}`;
    }
    if (msg.type === 'system') return msg.text || '';
    const t = (msg.text || '').replace(/\s+/g, ' ').trim();
    return who + (t.length > 60 ? t.slice(0, 57) + '…' : t);
}

// Has a viewer read this chat up through the latest message?
// We compare the viewer's lastReadByName[viewer.name] timestamp against
// the chat's lastActivityAt timestamp. Equal-or-later = read. Sender
// of the last message implicitly read it (no false-unread on send).
export function isChatUnread(chat, viewerName) {
    if (!chat || !viewerName) return false;
    if (chat?.lastMessage?.sender === viewerName) return false;
    const last = chat.lastActivityAt?.toMillis ? chat.lastActivityAt.toMillis()
        : (chat.lastActivityAt?.seconds ? chat.lastActivityAt.seconds * 1000 : 0);
    if (!last) return false;
    const read = chat.lastReadByName?.[viewerName];
    const readMs = read?.toMillis ? read.toMillis()
        : (read?.seconds ? read.seconds * 1000 : 0);
    return readMs < last;
}

// ── Read receipts ("Seen by") ──────────────────────────────────────────
//
// Each chat carries a `seenByVisibility` field controlling who can SEE
// the read-receipts UI on messages:
//
//   'admins_strict' — ONLY admins (app admin + chat co-admins) see
//                     receipts. The sender does NOT see their own
//                     message's receipts. Owner-oversight default —
//                     staff send messages without knowing who read
//                     them; admin retains visibility for ops.
//                     (Andrew 2026-05-17 — "only admin can see it".)
//   'admins_only'   — admins + the message's author see receipts.
//                     (The author sees their own; staff sees nothing
//                     on other people's messages.)
//   'sender_only'   — only the message's author sees who read it
//                     (matches iMessage/WhatsApp expectation).
//   'everyone'      — every chat member sees who's read each message.
//   'off'           — no one sees read receipts in this chat.
//
// The underlying read data (chat.lastReadByName) is ALWAYS collected
// regardless — visibility just controls who can see the indicator.
// Setting 'off' on a private DM means neither side knows whether the
// other has read; flipping back to 'sender_only' resurfaces the
// existing history.
//
// Default (when no field is set on a chat doc) is 'admins_strict' —
// matches the DD Mau ops posture where the owner needs oversight on
// whether staff have read manager-broadcast messages. Individual
// chats can override via ChatSettingsModal.
export const SEEN_VISIBILITY_OPTIONS = [
    { id: 'admins_strict', en: 'Admins only',     es: 'Solo admins' },
    { id: 'admins_only',   en: 'Admins + sender', es: 'Admins + remitente' },
    { id: 'sender_only',   en: 'Sender only',     es: 'Solo el remitente' },
    { id: 'everyone',      en: 'Everyone',        es: 'Todos' },
    { id: 'off',           en: 'Off (hide all)',  es: 'Apagado (ocultar todos)' },
];

// Resolve the effective visibility on a chat doc, defaulting to
// 'admins_strict' when the field hasn't been set. (Was 'sender_only'
// before 2026-05-17 — flipped so owner gets read-receipt oversight on
// every chat by default; staff don't see who's read what.)
export function getSeenByVisibility(chat) {
    const v = chat?.seenByVisibility;
    if (v === 'admins_strict' || v === 'admins_only' || v === 'sender_only'
        || v === 'everyone' || v === 'off') return v;
    return 'admins_strict';
}

// Returns true if the viewer is allowed to see read receipts on the
// given message under the chat's current visibility setting.
export function canSeeReceiptsForMessage(chat, message, viewer, isAdminFlag) {
    if (!chat || !message || !viewer) return false;
    const v = getSeenByVisibility(chat);
    if (v === 'off') return false;
    if (v === 'everyone') return true;
    const isSender = message.senderName === viewer.name;
    if (v === 'sender_only') return isSender;
    if (v === 'admins_only') {
        if (isSender) return true;
        if (isAdminFlag) return true;
        // Co-admin of the specific chat also counts.
        if (Array.isArray(chat.admins) && chat.admins.includes(viewer.name)) return true;
        return false;
    }
    if (v === 'admins_strict') {
        // Strict admin-only: even the sender doesn't see their own.
        // Only app admin OR chat co-admin can see receipts.
        if (isAdminFlag) return true;
        if (Array.isArray(chat.admins) && chat.admins.includes(viewer.name)) return true;
        return false;
    }
    return false;
}

// Resolve the list of members who have READ this message — i.e. whose
// lastReadByName timestamp on the chat is >= the message's createdAt.
// Returns Array<{name, readAtMs}> sorted by readAtMs ascending
// (earliest reader first). Excludes the message's own author (sending
// implicitly counts as reading, but we don't list yourself in your own
// "seen by"). Excludes members no longer in the chat.
export function getSeenByForMessage(chat, message) {
    if (!chat || !message) return [];
    const reads = chat.lastReadByName || {};
    const msgMs = message.createdAt?.toMillis
        ? message.createdAt.toMillis()
        : (message.createdAt?.seconds ? message.createdAt.seconds * 1000 : 0);
    if (!msgMs) return [];
    const members = Array.isArray(chat.members) ? chat.members : [];
    const out = [];
    for (const name of members) {
        if (name === message.senderName) continue;
        const ts = reads[name];
        const readMs = ts?.toMillis ? ts.toMillis()
            : (ts?.seconds ? ts.seconds * 1000 : 0);
        if (!readMs) continue;
        if (readMs < msgMs) continue;
        out.push({ name, readAtMs: readMs });
    }
    out.sort((a, b) => a.readAtMs - b.readAtMs);
    return out;
}

// Friendly relative time for chat-list timestamps.
// <1m → "now", <1h → "Nm", <24h → "Nh", <7d → weekday, older → date.
export function formatChatTime(ts) {
    if (!ts) return '';
    const ms = ts.toMillis ? ts.toMillis()
        : (ts.seconds ? ts.seconds * 1000 : 0);
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'now';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
    const d = new Date(ms);
    if (diff < 7 * 86_400_000) {
        return d.toLocaleDateString(undefined, { weekday: 'short' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Channels we auto-create on first boot. Order matters — it's the
// display order in the chat list.
//
// Each channel has a `kind` that drives UI + permission posture:
//   • announcement     — broadcast; only managers post, staff read + ack
//   • system_role      — auto-membership by role (all-team / FOH / BOH / managers)
//   • system_location  — auto-membership by location (webster / maryland)
//   • group            — user-created custom group
//   • shift            — auto-created for a shift block (out of v1)
//   • dm               — 1:1 (lives in /chats too, kind='dm')
//
// The `autoMembership` key tells channelMembersFor() how to compute
// the members[] array from staffList. See that helper for the rule set.
//
// 2026-05-16 — Andrew asked us to stop auto-creating system channels.
// He prefers building his own groups via the +New chat picker so he
// has explicit control over membership + naming. The infrastructure
// (channelMembersFor + the auto-sync loop in ChatCenter) is left
// intact so a future multi-tenant org can opt back in by repopulating
// this array. For DD Mau today, the array stays empty.
//
// Existing system channels (created before this change) are purged
// by the one-shot admin migration in ChatCenter on next mount and
// stay gone via the /chats_purged tombstone collection.
export const AUTO_CHANNELS = [];

// Documentation: the channel keys that USED to auto-create. The
// purge migration walks all chats with type 'channel' (regardless
// of key), so this list is reference only.
export const LEGACY_AUTO_CHANNEL_KEYS = [
    'announcements', 'all',
    'foh', 'boh',                                        // pre-split cross-location
    'foh-webster', 'foh-maryland', 'boh-webster', 'boh-maryland',
    'managers', 'webster', 'maryland',
];

// Kept for reference + future re-enable — the original channel
// definitions the auto-sync used. Not exported because the live
// AUTO_CHANNELS is the source of truth for the sync loop.
const _ARCHIVED_AUTO_CHANNELS = [
    { key: 'announcements',  kind: 'announcement',   name: 'Announcements',     emoji: '📣', autoMembership: 'all',                en: 'Announcements',      es: 'Anuncios',           restrictPosting: true },
    { key: 'all',            kind: 'system_role',    name: 'All Team',          emoji: '🍜', autoMembership: 'all',                en: 'All Team',           es: 'Todo el Equipo',     restrictPosting: true },
    { key: 'foh-webster',    kind: 'system_role',    name: 'FOH · Webster',     emoji: '🪑', autoMembership: 'foh:webster',        en: 'FOH · Webster',      es: 'FOH · Webster' },
    { key: 'foh-maryland',   kind: 'system_role',    name: 'FOH · Maryland',    emoji: '🪑', autoMembership: 'foh:maryland',       en: 'FOH · Maryland',     es: 'FOH · Maryland' },
    { key: 'boh-webster',    kind: 'system_role',    name: 'BOH · Webster',     emoji: '👩‍🍳', autoMembership: 'boh:webster',        en: 'BOH · Webster',      es: 'BOH · Webster' },
    { key: 'boh-maryland',   kind: 'system_role',    name: 'BOH · Maryland',    emoji: '👩‍🍳', autoMembership: 'boh:maryland',       en: 'BOH · Maryland',     es: 'BOH · Maryland' },
    { key: 'managers',       kind: 'system_role',    name: 'Managers',          emoji: '🧑‍💼', autoMembership: 'managers',           en: 'Managers',           es: 'Gerentes' },
    { key: 'webster',        kind: 'system_location',name: 'Webster',           emoji: '🏠', autoMembership: 'loc:webster',        en: 'Webster',            es: 'Webster' },
    { key: 'maryland',       kind: 'system_location',name: 'Maryland Hts',      emoji: '🏠', autoMembership: 'loc:maryland',       en: 'Maryland Hts',       es: 'Maryland' },
];
// Keep _ARCHIVED_AUTO_CHANNELS reachable from tests / future restore
// without tripping the unused-export lint.
export { _ARCHIVED_AUTO_CHANNELS as ARCHIVED_AUTO_CHANNELS };

// Message-type registry. Single polymorphic table; type drives renderer
// + permission gates + notification priority.
export const MESSAGE_TYPES = {
    text:               { renderer: 'bubble',       priority: 'normal'   },
    image:              { renderer: 'bubble',       priority: 'normal'   },
    video:              { renderer: 'bubble',       priority: 'normal'   },
    audio:              { renderer: 'bubble',       priority: 'normal'   },
    announcement:       { renderer: 'announcement', priority: 'high'     },
    coverage_request:   { renderer: 'coverage',     priority: 'high'     },
    eighty_six_alert:   { renderer: 'eighty_six',   priority: 'emergency'},
    photo_issue:        { renderer: 'issue',        priority: 'high'     },
    task_handoff:       { renderer: 'task',         priority: 'normal'   },
    poll:               { renderer: 'poll',         priority: 'normal'   },
    system_event:       { renderer: 'system',       priority: 'normal'   },
};

// Poll schema — stored inline on a message of type 'poll':
//   poll: {
//     question:    string                  — required, up to 200 chars
//     options:     [{ id, label }]         — 2–6 options; id is "opt_0"..."opt_N"
//     multiSelect: boolean                 — can a voter pick multiple options
//     anonymous:   boolean                 — hide voter names (counts only)
//     closesAt:    Timestamp | null        — optional auto-close deadline
//     closedAt:    Timestamp | null        — set when creator manually closes
//     votes:       { [optionId]: string[] }— map of optionId → voter names
//   }
//
// Why inline on the message (not a separate collection): a poll IS the
// message in chat-thread terms. Keeps the snapshot + render loop simple
// and lets us reuse pin/react/seen-by infrastructure for free. Voting
// uses arrayUnion / arrayRemove via dot-path so two voters can't clobber
// each other (same atomic-write rationale as reactions).
export const POLL_LIMITS = {
    minOptions: 2,
    maxOptions: 6,
    maxQuestion: 200,
    maxOption: 80,
};

// Compute vote tallies + total + winning index for poll-card rendering.
// Returns { counts: { [id]: n }, total, leadingId }. Leading ties resolve
// to the first option (stable, matches the order shown).
export function pollTally(poll) {
    const opts = Array.isArray(poll?.options) ? poll.options : [];
    const votes = (poll && poll.votes) || {};
    const counts = {};
    let total = 0;
    for (const o of opts) {
        const arr = Array.isArray(votes[o.id]) ? votes[o.id] : [];
        counts[o.id] = arr.length;
        total += arr.length;
    }
    let leadingId = opts[0]?.id || null;
    let max = -1;
    for (const o of opts) {
        if (counts[o.id] > max) { max = counts[o.id]; leadingId = o.id; }
    }
    return { counts, total, leadingId };
}

// Is a poll currently open for voting? Closed when poll.closedAt is set
// OR when closesAt has elapsed.
export function isPollOpen(poll) {
    if (!poll) return false;
    if (poll.closedAt) return false;
    const c = poll.closesAt;
    if (c) {
        const ms = c.toMillis ? c.toMillis() : (c.seconds ? c.seconds * 1000 : 0);
        if (ms && ms < Date.now()) return false;
    }
    return true;
}

// Emoji palette for quick reactions. Keep tight so the popover stays
// thumb-sized on mobile. Order = priority (👍 first).
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '✅'];

// ── Edit-your-own-message window ────────────────────────────────────
// After 15 minutes a message is "settled" — editing past that point
// crosses the line from typo-fix to revisionism, especially in a
// work chat where decisions are referenced later. Delete still works
// for older messages because it's transparently flagged (the bubble
// shows "(message deleted)" + the audit log captures the original),
// whereas a stealth edit on a 2-day-old message could be deceptive.
//
// 15 min mirrors WhatsApp / iMessage / Slack convention.
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

// Which message TYPES are editable?
//   • text:                 always (the obvious case)
//   • image / video / audio: only if there's a CAPTION (we let the
//                            author fix typos in the caption — we
//                            don't allow swapping the media itself)
//   • announcement:          NO. Announcements are read by many
//                            people who may have acked; a silent
//                            edit could change what they "agreed"
//                            to. Author must delete + repost.
//   • poll / coverage_request / 86 / task_handoff / system:
//                            NO. These carry structured data with
//                            operational or compliance implications.
//                            Edit by deleting + re-issuing.
export function isMessageEditable(message) {
    if (!message || message.deleted) return false;
    if (message.type === 'text') return true;
    if ((message.type === 'image' || message.type === 'video' || message.type === 'audio')
        && typeof message.text === 'string' && message.text.trim().length > 0) {
        return true;
    }
    return false;
}

// Is this message inside the edit window? Reads createdAt; tolerates
// missing/half-formed timestamps by returning false (safer to refuse
// the edit than to allow one with no provenance).
export function isWithinEditWindow(message, nowMs = Date.now()) {
    const ts = message?.createdAt;
    const ms = ts?.toMillis ? ts.toMillis()
        : (ts?.seconds ? ts.seconds * 1000 : 0);
    if (!ms) return false;
    return (nowMs - ms) < EDIT_WINDOW_MS;
}

// Composable "can THIS viewer edit THIS message right now?" check.
// Used by MessageActionMenu to gate the ✏️ Edit affordance and by
// handleEditMessage as a server-write guard. Returns true only when
// every condition is met — viewer is the author, type is editable,
// and we're still inside the window.
export function canEditMessage(message, viewer, nowMs = Date.now()) {
    if (!message || !viewer) return false;
    if (message.senderName !== viewer.name) return false;
    if (!isMessageEditable(message)) return false;
    if (!isWithinEditWindow(message, nowMs)) return false;
    return true;
}

// Display name format inside chat threads: full first name + last
// initial. Used for sender labels in group / channel chats and
// inside specialty cards (coverage requests, photo issues, etc.)
// where a name accompanies an action.
//
// Examples:
//   "Andrew Shih"        -> "Andrew S."
//   "Cash Magruder"      -> "Cash M."
//   "Maria José Lopez"   -> "Maria L."  (last word is the last name)
//   "Andrew"             -> "Andrew"    (no last name, leave as-is)
//   ""                   -> ""
export function formatChatName(fullName) {
    if (!fullName) return '';
    const parts = String(fullName).trim().split(/\s+/);
    if (parts.length < 2) return parts[0] || '';
    const lastInitial = (parts[parts.length - 1][0] || '').toUpperCase();
    return lastInitial ? `${parts[0]} ${lastInitial}.` : parts[0];
}

// Photo-issue categories. Restaurant-specific — these become the dropdown
// in ChatPhotoIssueModal AND drive routing (e.g., safety auto-pings the
// manager channel even if posted to a location channel).
export const ISSUE_CATEGORIES = [
    { key: 'equipment', en: 'Equipment broken', es: 'Equipo dañado',     emoji: '🔧', escalates: true  },
    { key: 'cleaning',  en: 'Cleaning needed',  es: 'Limpieza',          emoji: '🧹', escalates: false },
    { key: 'plumbing',  en: 'Plumbing',         es: 'Plomería',          emoji: '🚰', escalates: true  },
    { key: 'supplies',  en: 'Out of supplies',  es: 'Sin suministros',   emoji: '📦', escalates: false },
    { key: 'safety',    en: 'Safety hazard',    es: 'Peligro',           emoji: '⚠️', escalates: true  },
    { key: 'other',     en: 'Other',            es: 'Otro',              emoji: '❔', escalates: false },
];

export const ISSUE_URGENCIES = [
    { key: 'low',       en: 'Low',       es: 'Bajo',       color: 'bg-dd-bg text-dd-text-2 border-dd-line' },
    { key: 'medium',    en: 'Medium',    es: 'Medio',      color: 'bg-amber-50 text-amber-800 border-amber-200' },
    { key: 'high',      en: 'High',      es: 'Alto',       color: 'bg-orange-50 text-orange-800 border-orange-200' },
    { key: 'emergency', en: 'Emergency', es: 'Emergencia', color: 'bg-red-50 text-red-700 border-red-300' },
];

// Default per-user notification policy. Stored on members but
// CURRENTLY (pre-multi-tenant) we read from /chat_prefs/{staffName}.
// TODO multi-tenant: move to orgs/{orgId}/members/{userId}.notifPolicy.
export const DEFAULT_NOTIF_POLICY = {
    pushEnabled: true,
    digestMode: 'realtime',           // 'realtime' | 'hourly' | 'daily'
    quietHours: null,                 // { start: '22:00', end: '06:00' } | null
    channelPrefs: {},                 // channelId -> 'all' | 'mentions' | 'none'
    // Auto-translate every foreign-language message into the viewer's
    // preferredLanguage. Default OFF so we don't surprise existing
    // users with a Cloud Function bill — they have to opt in via
    // ChatNotifSettings. Per-message "🌐 Translate" chip works
    // regardless of this flag.
    autoTranslate: false,
};

