// offerRules.js — the offer/claim lifecycle, as one tested module.
//
// (2026-08-10, stabilization gap work.) The shift-offer flow is stored as
// loose fields on the shift doc, not a state machine:
//
//   offerStatus      null | 'open' | 'pending_approval'-ish (claim in flight)
//   pendingClaimBy   staffName who tapped "Take" (awaiting manager)
//   coverNeeded      urgent-cover styling + fan-out flag
//   approvedBy       double-approval guard for the CURRENT claim cycle
//
// The legal transitions:
//
//   (idle) --offer/cover--> OPEN --take--> CLAIMED --approve--> reassigned (idle)
//     ^                      |               |
//     |                      |               +--deny--> OPEN
//     +------cancel----------+
//
// Guard rails these rules enforce (each maps to a shipped bug class):
//   • Re-offering while a claim is pending would silently vaporize the
//     claim a manager is reviewing → refuse.
//   • Denying resolves exactly the claim the manager SAW — if a different
//     staffer claimed since (frozen listener), refuse and re-review.
//   • Cancel is idempotent — double-taps and cross-device races no-op.
//   • Denying a swap REQUEST that a co-manager already approved must not
//     stamp 'denied' over an executed swap.
//
// These run INSIDE runTransaction callbacks against the LIVE doc — pure
// functions, no i18n, no Firestore. Callers translate `reason` to copy.

/** Offer a shift / request cover. live = current shift data or null. */
export function assessOffer(live) {
    if (!live) return { ok: false, reason: 'gone' };
    if (live.pendingClaimBy) {
        return { ok: false, reason: 'pending_claim', claimant: live.pendingClaimBy };
    }
    return { ok: true };
}

/** Cancel an offer/cover request. Idempotent by design. */
export function assessCancelOffer(live) {
    if (!live) return { ok: true, noop: true, reason: 'gone' };
    if (!live.offerStatus && !live.coverNeeded) return { ok: true, noop: true, reason: 'not_offered' };
    return { ok: true, noop: false };
}

/**
 * Deny the pending claim on a shift. expectedClaimant = who the manager's
 * screen showed (may be null/undefined on cards that don't carry it —
 * then the live claimant is denied).
 */
export function assessDenyClaim(live, expectedClaimant) {
    if (!live) return { ok: false, reason: 'gone' };
    if (!live.pendingClaimBy) return { ok: false, reason: 'resolved' };
    if (expectedClaimant && live.pendingClaimBy !== expectedClaimant) {
        return { ok: false, reason: 'claim_changed', claimant: live.pendingClaimBy };
    }
    return { ok: true, claimant: live.pendingClaimBy };
}

/** Deny a direct swap REQUEST doc (swap_requests collection). */
export function assessDenySwapRequest(live) {
    if (!live) return { ok: false, reason: 'gone' };
    if (live.status && live.status !== 'pending') {
        return { ok: false, reason: 'already', status: live.status };
    }
    return { ok: true };
}
