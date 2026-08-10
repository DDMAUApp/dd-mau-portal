// Pins the offer/claim lifecycle matrix (2026-08-10). Each case maps to a
// shipped bug class — see offerRules.js header for the transition diagram.

import { describe, it, expect } from 'vitest';
import {
    assessOffer, assessCancelOffer, assessDenyClaim, assessDenySwapRequest,
} from './offerRules';

describe('assessOffer', () => {
    it('allows offering an idle shift', () => {
        expect(assessOffer({ staffName: 'Ana' })).toEqual({ ok: true });
    });
    it('allows re-offering an already-open offer (restart cycle)', () => {
        expect(assessOffer({ offerStatus: 'open', offeredBy: 'Ana' }).ok).toBe(true);
    });
    it('REFUSES while a claim is pending — never vaporize a mid-review claim', () => {
        const v = assessOffer({ offerStatus: 'open', pendingClaimBy: 'Ben' });
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('pending_claim');
        expect(v.claimant).toBe('Ben');
    });
    it('refuses on a deleted shift', () => {
        expect(assessOffer(null)).toEqual({ ok: false, reason: 'gone' });
    });
});

describe('assessCancelOffer (idempotent)', () => {
    it('cancels an open offer', () => {
        expect(assessCancelOffer({ offerStatus: 'open' })).toEqual({ ok: true, noop: false });
    });
    it('cancels a cover request (coverNeeded without offerStatus)', () => {
        expect(assessCancelOffer({ coverNeeded: true }).noop).toBe(false);
    });
    it('no-ops on an already-cancelled shift (double-tap / cross-device race)', () => {
        expect(assessCancelOffer({ staffName: 'Ana' }).noop).toBe(true);
    });
    it('no-ops on a deleted shift instead of erroring', () => {
        expect(assessCancelOffer(null)).toEqual({ ok: true, noop: true, reason: 'gone' });
    });
});

describe('assessDenyClaim', () => {
    const claimed = { offerStatus: 'open', pendingClaimBy: 'Ben' };
    it('denies the claim the manager saw', () => {
        expect(assessDenyClaim(claimed, 'Ben')).toEqual({ ok: true, claimant: 'Ben' });
    });
    it('denies the live claimant when the card carried no claimant', () => {
        expect(assessDenyClaim(claimed, undefined).claimant).toBe('Ben');
    });
    it('REFUSES when a different staffer claimed since (stale view)', () => {
        const v = assessDenyClaim(claimed, 'Cara');
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('claim_changed');
        expect(v.claimant).toBe('Ben');
    });
    it('reports resolved when the claim is already gone', () => {
        expect(assessDenyClaim({ offerStatus: 'open' }, 'Ben').reason).toBe('resolved');
    });
    it('reports gone on a deleted shift', () => {
        expect(assessDenyClaim(null, 'Ben').reason).toBe('gone');
    });
});

describe('assessDenySwapRequest', () => {
    it('denies a pending request', () => {
        expect(assessDenySwapRequest({ status: 'pending' }).ok).toBe(true);
    });
    it('legacy request with no status field counts as pending', () => {
        expect(assessDenySwapRequest({ fromStaff: 'Ana' }).ok).toBe(true);
    });
    it('REFUSES when a co-manager already approved — the swap executed', () => {
        const v = assessDenySwapRequest({ status: 'approved' });
        expect(v.ok).toBe(false);
        expect(v.status).toBe('approved');
    });
    it('refuses a second deny (already denied)', () => {
        expect(assessDenySwapRequest({ status: 'denied' }).ok).toBe(false);
    });
    it('reports gone on a deleted request', () => {
        expect(assessDenySwapRequest(null).reason).toBe('gone');
    });
});
