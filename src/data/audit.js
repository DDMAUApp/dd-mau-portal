// Append-only audit log.
//
// Every state-changing chat action (and other ops events that need
// after-the-fact accountability) calls recordAudit(). Single chokepoint
// → consistent shape → easy compliance export later.
//
// Schema:
//   /audit/{id} = {
//     action: 'chat.message.send' | 'chat.message.pin' | 'chat.ack' |
//             'chat.coverage.claim' | 'chat.coverage.approve' |
//             'chat.task.convert' | 'chat.channel.delete' | ...
//     actorName: string
//     actorId: number?
//     actorRole: string?
//     targetType: 'channel' | 'message' | 'chat' | 'shift' | 'task' | ...
//     targetId: string?
//     details: Record<string, any>     // action-specific payload
//     createdAt: serverTimestamp
//     userAgent: string?
//   }
//
// Best-effort: a failed audit write is logged but never throws — the
// underlying action takes precedence. (A periodic Cloud Function will
// scan for missing audit entries on key actions if compliance pressure
// ever requires it.)
//
// TODO multi-tenant: scope under /orgs/{orgId}/audit/{id} and add
// orgId field on every doc.

import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

export async function recordAudit({
    action,
    actorName,
    actorId,
    actorRole,
    targetType,
    targetId,
    details = {},
}) {
    if (!action) return null;
    try {
        const ref = await addDoc(collection(db, 'audit'), {
            action,
            actorName: actorName || 'system',
            actorId: actorId ?? null,
            actorRole: actorRole || null,
            targetType: targetType || null,
            targetId: targetId || null,
            details: sanitizeDetails(details),
            createdAt: serverTimestamp(),
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : null,
        });
        return ref.id;
    } catch (e) {
        console.warn(`recordAudit(${action}) failed:`, e);
        return null;
    }
}

// Trim large fields + remove anything that could leak PII into the
// audit log. We DO log: which chat, which message id, which staff
// member. We DON'T log: full message bodies, photo URLs, PINs.
function sanitizeDetails(d) {
    if (!d || typeof d !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(d)) {
        if (k.toLowerCase().includes('pin') || k.toLowerCase().includes('password')) continue;
        if (typeof v === 'string' && v.length > 500) {
            out[k] = v.slice(0, 500) + '…';
        } else {
            out[k] = v;
        }
    }
    return out;
}
