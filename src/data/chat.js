// Chat helpers — pure functions, no React, no Firebase.
//
// These get tested standalone (TODO: chat.test.js) and reused across
// ChatCenter / ChatThread / ChatSettingsModal so the permission model
// has a single source of truth.
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
//   replyTo:      { messageId, sender, snippet }? — quote-reply target (schema only, UI TODO v2)
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
    const visible = list.filter(s =>
        s &&
        s.name &&
        s.hideFromSchedule !== true
    );
    // Resolve the AUTO_CHANNELS entry for its autoMembership rule so a
    // single switch covers every system channel kind (role / location /
    // managers / all + the announcement broadcast which always = all).
    const def = AUTO_CHANNELS.find(c => c.key === key);
    const rule = def?.autoMembership || key; // back-compat: callers passing 'foh' directly still work
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
    return [];
}

function isManagerRole(s) {
    if (s.id === 40 || s.id === 41) return true; // owners
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
    // Bare: @firstname (up to whitespace or punctuation)
    const bare = text.matchAll(/@([A-Za-z][A-Za-z'\-]*)/g);
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
export const AUTO_CHANNELS = [
    { key: 'announcements', kind: 'announcement',   name: 'Announcements', emoji: '📣', autoMembership: 'all',         en: 'Announcements',   es: 'Anuncios',          restrictPosting: true },
    { key: 'all',           kind: 'system_role',    name: 'All Team',      emoji: '🍜', autoMembership: 'all',         en: 'All Team',        es: 'Todo el Equipo' },
    { key: 'foh',           kind: 'system_role',    name: 'Front of House',emoji: '🪑', autoMembership: 'foh',         en: 'Front of House',  es: 'Servicio' },
    { key: 'boh',           kind: 'system_role',    name: 'Back of House', emoji: '👩‍🍳', autoMembership: 'boh',         en: 'Back of House',   es: 'Cocina' },
    { key: 'managers',      kind: 'system_role',    name: 'Managers',      emoji: '🧑‍💼', autoMembership: 'managers',    en: 'Managers',        es: 'Gerentes' },
    { key: 'webster',       kind: 'system_location',name: 'Webster',       emoji: '🏠', autoMembership: 'loc:webster', en: 'Webster',         es: 'Webster' },
    { key: 'maryland',      kind: 'system_location',name: 'Maryland Hts',  emoji: '🏠', autoMembership: 'loc:maryland',en: 'Maryland Hts',    es: 'Maryland' },
];

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
    system_event:       { renderer: 'system',       priority: 'normal'   },
};

// Emoji palette for quick reactions. Keep tight so the popover stays
// thumb-sized on mobile. Order = priority (👍 first).
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '✅'];

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
};

