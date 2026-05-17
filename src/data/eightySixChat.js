// 86 alert fan-out — FCM push + audit only.
//
// HISTORICAL (2026-05-11 → 2026-05-16): this module used to also auto-
// post a chat card into the side-specific channel (#foh) and the
// management channel (#managers) so staff saw the 86 in chat alongside
// the dashboard.
//
// 2026-05-17 — Andrew opted out of system auto-channels (AUTO_CHANNELS
// is now empty in src/data/chat.js, and existing #foh / #managers /
// etc. were purged via tombstone). The chat-post branch was writing
// to channels that no longer have members → invisible alerts +
// silent-failure UX (AUDIT.md finding 86-001).
//
// The chat write is now removed entirely. 86 alerts surface through:
//   • The Eighty6Dashboard (clients subscribe to ops/86_{loc})
//   • The FCM push fan-out below — on-duty FOH staff get a phone
//     notification
//   • The audit log entry (single doc per transition)
//
// If chat-based 86 surfacing is wanted later, the cleanest re-add is
// to thread a `chatId` config through (e.g. /config/eighty_six_targets
// = { webster: 'group_abc', maryland: 'group_xyz' }) and write to that
// specific chat doc. The deterministic-message-id idempotency
// machinery below is preserved for that future use.
//
// The function name `postEightySixToChat` is kept (rather than
// renaming to `emitEightySixAlert`) so existing callers compile
// without churn; AUDIT.md flagged the rename as worth doing during
// the broader SaaS-prep refactor, not now.

import { db } from '../firebase';
import { serverTimestamp } from 'firebase/firestore';
import { notifyStaff } from './notify';
import { recordAudit } from './audit';

// Slugify kept for the audit log's stable id — lets future
// reconstruction find the "same" alert across retries.
function slug(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

// Hour bucket (UTC) so retries within the hour share one audit row.
function hourBucket() {
    const d = new Date();
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}_${String(d.getUTCHours()).padStart(2, '0')}`;
}

// `transition`: 'out' (item just 86'd) or 'in' (item back in stock).
//
// Side effects:
//   1. Records ONE audit row at /audit per (item, location, transition,
//      hour-bucket) — captures who flipped it, when, for what item.
//   2. Fans out FCM push to every name in notifyRecipients (caller
//      pre-filters to on-duty + non-manager — Eighty6Dashboard already
//      has that logic).
export async function postEightySixToChat({
    location,           // 'webster' | 'maryland'
    itemName,
    transition,         // 'out' | 'in'
    actorName,          // who flipped the switch
    actorId,
    attributedTo,       // 'who actually 86'd' from Toast cross-reference (optional)
    notifyRecipients = [],  // staff names to FCM-push
}) {
    const emoji = transition === 'out' ? '🚫' : '✅';
    const stableId = `auto86_${slug(itemName)}_${location}_${transition}_${hourBucket()}`;

    // One audit row per transition (was previously one per channel; now
    // one total since we no longer fan out to two channels).
    recordAudit({
        action: 'eighty_six.alert',
        actorName: actorName || 'system',
        actorId,
        targetType: 'eighty_six',
        targetId: `${location}__${slug(itemName)}__${transition}`,
        details: {
            stableId,
            location,
            itemName,
            transition,
            attributedTo: attributedTo || null,
        },
    });

    // FCM fan-out to staff currently on-duty at this location (managers
    // exempt — they get the dashboard alerts anyway). Tap on the push
    // deep-links to 'eighty6' so they land directly on the dashboard
    // (was 'chat' previously — pointless without the chat card to
    // navigate to). Per-recipient tag dedups same-item retries at the
    // OS notification level.
    for (const to of notifyRecipients) {
        notifyStaff({
            forStaff: to,
            type: 'eighty_six',
            title: emoji + ' ' + (transition === 'out' ? '86 alert' : 'Back in stock'),
            body: `${itemName} · ${location === 'maryland' ? 'Maryland' : 'Webster'}`,
            deepLink: 'eighty6',
            link: '/eighty6',
            tag: `eighty_six:${location}:${itemName}:${transition}:${to}`,
            createdBy: actorName || 'system',
            // 86 alerts are operational-critical — bypass quiet hours.
            priority: 'high',
        }).catch(() => {});
    }
}
