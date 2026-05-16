// Capability engine for chat features.
//
// Centralizes every "can this user do X?" check so feature components
// don't repeat the role + flag + per-channel-restriction logic. Pure
// functions only — pass in the viewer record + isAdmin/isManager flags
// computed in App.jsx + (for channel-scoped checks) the chat doc.
//
// ── Why this exists ─────────────────────────────────────────────────
// In a single-tenant DD Mau app the role hierarchy is small (owner +
// manager + staff). When we migrate to multi-tenant SaaS, these helpers
// will read from member.perms[flag] before falling back to role default.
// Today they read directly from role + a few opt-in flags on the staff
// record (canPostAnnouncements, canConvertToTask, etc.).
//
// ── Per-feature flags on the staff record ───────────────────────────
// Optional overrides — let admin grant a specific staff member a
// capability that's normally manager+:
//   canPostAnnouncements   — default manager+
//   canRequireAck          — default manager+
//   canPinMessages         — default shift_lead+ (Shift Lead is a flag
//                             on staff record: isShiftLead === true)
//   canConvertToTask       — default shift_lead+
//   canViewAuditLog        — default admin
//   canDeleteAnyMessage    — default manager+ (in a channel they manage)
//
// Channel-scoped restrictions:
//   announcement channels block posting for non-managers regardless
//   of the flags above (you can't post to #announcements as staff).

import { canEditChat } from './chat';

// ── Tier helpers (mirrors tierOf in chat.js but with shift-lead) ───
function isShiftLeadOrAbove(viewer, isManager, isAdmin) {
    if (isAdmin || isManager) return true;
    return !!viewer?.isShiftLead;
}

// ── Posting ───────────────────────────────────────────────────────
// Can this viewer post a regular text/media message in this chat?
// • Announcement channels: managers only (or explicit flag).
// • Anything else: any member.
export function canPostInChat(chat, viewer, isAdmin, isManager) {
    if (!chat || !viewer) return false;
    const isMember = Array.isArray(chat.members) && chat.members.includes(viewer.name);
    if (!isMember) return false;
    if (chat.kind === 'announcement' || chat.channelKey === 'announcements') {
        return canPostAnnouncements(viewer, isAdmin, isManager);
    }
    return true;
}

// Can this viewer compose an Announcement? Used by the FAB / composer
// gate. Independent of which channel they're in — the audience picker
// runs inside the composer.
export function canPostAnnouncements(viewer, isAdmin, isManager) {
    if (isAdmin || isManager) return true;
    return viewer?.canPostAnnouncements === true;
}

// Can this viewer require an acknowledgment on a message they're
// sending? Always tied to announcement-posting capability — if you
// can announce, you can require ack.
export function canRequireAck(viewer, isAdmin, isManager) {
    return canPostAnnouncements(viewer, isAdmin, isManager);
}

// Can this viewer pin a message in this channel?
// • DMs: no pinning.
// • Channels: managers always; shift leads if flag set; staff never.
// • Groups: anyone who can edit the chat can pin.
export function canPinMessages(chat, viewer, isAdmin, isManager) {
    if (!chat || !viewer) return false;
    if (chat.type === 'dm') return false;
    if (isAdmin || isManager) return true;
    if (viewer?.canPinMessages === true) return true;
    if (chat.type === 'group') return canEditChat(chat, viewer, isAdmin);
    if (chat.type === 'channel') return isShiftLeadOrAbove(viewer, isManager, isAdmin);
    return false;
}

// Can this viewer convert a message into a task?
// • Default: shift_lead+.
// • Override: canConvertToTask flag.
export function canConvertToTask(viewer, isAdmin, isManager) {
    if (isAdmin || isManager) return true;
    if (viewer?.canConvertToTask === true) return true;
    return !!viewer?.isShiftLead;
}

// Can this viewer view the audit log?
// • Default: admin only.
// • Override: canViewAuditLog flag.
export function canViewAuditLog(viewer, isAdmin) {
    if (isAdmin) return true;
    return viewer?.canViewAuditLog === true;
}

// Can this viewer delete OTHER people's messages in this chat?
// (Own messages: always allowed via canDeleteOwnMessage below.)
//
// Restaurant-ops nuance: managers should be able to clean up
// inappropriate content in their location channels, but a manager at
// Webster shouldn't moderate Maryland's private channels.
export function canDeleteAnyMessage(chat, viewer, isAdmin, isManager) {
    if (!chat || !viewer) return false;
    if (isAdmin) return true;
    if (!isManager) return viewer?.canDeleteAnyMessage === true;
    // For location channels, restrict managers to their own location.
    if (chat.channelKey === 'webster' && viewer?.location === 'maryland') return false;
    if (chat.channelKey === 'maryland' && viewer?.location === 'webster') return false;
    return true;
}

// Own messages can always be edited/deleted (within an edit window).
export function canDeleteOwnMessage(message, viewer) {
    return !!message && !!viewer && message.senderName === viewer.name;
}

// Can this viewer request shift coverage?
// Anyone with a published shift can request coverage for that shift.
// The component checks shift ownership separately; this is the
// capability check on the viewer.
export function canPostCoverageRequest(viewer) {
    return !!viewer?.name;
}

// Can this viewer claim a coverage request?
// • Must be a member of the channel (handled by canPostInChat).
// • Must NOT be the original requester.
// • Must match the shift's side (FOH / BOH) — checked in the modal
//   using the linked shift; here we just gate the affordance.
export function canClaimCoverage(request, viewer) {
    if (!request || !viewer) return false;
    if (request.requesterId === viewer.name) return false;
    // Accept either coverageStatus (message-doc field name) or status
    // (generic API name) so this helper is callable from either path.
    const status = request.coverageStatus || request.status;
    if (status !== 'open') return false;
    return true;
}

// Can this viewer approve/deny a coverage claim?
// Manager only — at the location of the shift (TODO multi-tenant:
// resolve from member.locations[]).
export function canApproveCoverage(viewer, isAdmin, isManager) {
    return isAdmin || isManager;
}

// Can this viewer change their own notification policy?
// Yes, always. Org admins can also set ORG-WIDE defaults (out of v1).
export function canEditOwnNotifPolicy() {
    return true;
}

// Display tier label — used in UI hints ("Only managers can edit").
export function tierLabel(viewer, isAdmin, isManager) {
    if (isAdmin) return 'Admin';
    if (isManager) return 'Manager';
    if (viewer?.isShiftLead) return 'Shift Lead';
    return 'Staff';
}
