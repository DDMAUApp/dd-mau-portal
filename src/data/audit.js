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

// ── recordRichAudit — restaurant-ops audit helper ──────────────────────
// Andrew 2026-05-26 — same /audit collection as recordAudit() above, but
// shaped for the restaurant-ops events that need BEFORE/AFTER state for
// "who changed this and what did it look like before?" answers:
//   • inventory qty/par/vendor changes
//   • 86 add/remove
//   • schedule shift create/update/delete
//   • waste/spoilage records
//   • role changes
//
// Pushes through the same audit collection so the existing AdminHealth
// timeline + Phase-2 compliance export keep working without a second
// collection migration. The 'feature' + 'action' fields let the Health
// dashboard group by area; the 'before'/'after' fields go through the
// shared redactor from src/data/redact.js so even a careless caller
// that passes a doc snapshot's full .data() can't leak secrets.
//
// Identity is pulled from window globals (set by App.jsx via setIdentity
// in src/data/logger.js), so callers don't need to remember to pass
// actorName + actorId on every call. They CAN override via the opts.
import { redactObject, redactString } from './redact';

export async function recordRichAudit({
    feature,           // 'inventory' | 'schedule' | '86' | 'role' | 'waste' | ...
    action,            // short verb: 'qty_change', 'par_change', '86_add', ...
    targetType,        // 'inventory_item' | 'shift' | 'staff' | ...
    targetId,
    targetName,
    before,            // safe scalars only — gets redacted
    after,             // ditto
    reason,            // optional free-text rationale
    actorOverride,     // { name, id, role, location } — only when not from window
} = {}) {
    if (!feature || !action) {
        if (typeof console !== 'undefined') {
            console.warn('recordRichAudit: feature + action are required');
        }
        return null;
    }
    const actor = actorOverride || (typeof window !== 'undefined' ? {
        name:     window.__ddmau_staffName ?? null,
        id:       window.__ddmau_staffId ?? null,
        role:     window.__ddmau_role ?? null,
        location: window.__ddmau_location ?? null,
    } : { name: null, id: null, role: null, location: null });

    try {
        const ref = await addDoc(collection(db, 'audit'), {
            // Existing-shape fields so AdminHealthPage's recent-activity
            // feed renders rich-audit rows without code change.
            action: `${feature}.${action}`,
            actorName: actor.name || 'system',
            actorId: actor.id ?? null,
            actorRole: actor.role || null,
            targetType: targetType || null,
            targetId: targetId ?? null,
            createdAt: serverTimestamp(),
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 200) : null,
            // New rich-audit fields. Read by the Phase-2 forensic
            // export + any future "rollback this change" affordance.
            feature,
            actorLocation: actor.location ?? null,
            targetName: targetName ? redactString(String(targetName)).slice(0, 200) : null,
            before: before != null ? redactObject(before) : null,
            after:  after  != null ? redactObject(after)  : null,
            reason: reason ? redactString(String(reason)).slice(0, 500) : null,
        });
        return ref.id;
    } catch (e) {
        // Same best-effort posture as recordAudit — a failed audit
        // write must never block the underlying ops action.
        if (typeof console !== 'undefined') {
            console.warn(`recordRichAudit(${feature}.${action}) failed:`, e);
        }
        return null;
    }
}

// Convenience wrappers for the most common callsites. Keep these
// thin — they exist to make the call site read like English:
//   await auditInventoryChange({ itemId, name, field: 'qty', before: 5, after: 0 });
export async function auditInventoryChange({ itemId, name, field, before, after, reason } = {}) {
    return recordRichAudit({
        feature: 'inventory',
        action: `${field}_change`,
        targetType: 'inventory_item',
        targetId: itemId,
        targetName: name,
        before: before != null ? { [field]: before } : null,
        after:  after  != null ? { [field]: after }  : null,
        reason,
    });
}

export async function audit86Change({ action, name, source, reason } = {}) {
    // action: 'add' | 'remove' — corresponds to OUT_OF_STOCK toggle
    return recordRichAudit({
        feature: '86',
        action: `86_${action}`,
        targetType: 'menu_item',
        targetId: null,
        targetName: name,
        before: action === 'remove' ? { status: 'OUT_OF_STOCK' } : null,
        after:  action === 'add'    ? { status: 'OUT_OF_STOCK', source } : null,
        reason,
    });
}

export async function auditScheduleChange({ shiftId, staffName, field, before, after, reason } = {}) {
    return recordRichAudit({
        feature: 'schedule',
        action: `${field}_change`,
        targetType: 'shift',
        targetId: shiftId,
        targetName: staffName ? `${staffName} shift` : null,
        before: before != null ? { [field]: before } : null,
        after:  after  != null ? { [field]: after }  : null,
        reason,
    });
}

export async function auditWaste({ itemId, name, qty, unit, reason } = {}) {
    return recordRichAudit({
        feature: 'waste',
        action: 'waste_recorded',
        targetType: 'inventory_item',
        targetId: itemId,
        targetName: name,
        before: null,
        after: { qty, unit: unit || null },
        reason,
    });
}

export async function auditRoleChange({ staffId, name, before, after, reason } = {}) {
    return recordRichAudit({
        feature: 'role',
        action: 'role_change',
        targetType: 'staff',
        targetId: staffId,
        targetName: name,
        before: before ? { role: before } : null,
        after:  after  ? { role: after }  : null,
        reason,
    });
}
