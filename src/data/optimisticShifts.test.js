import { describe, it, expect } from 'vitest';
import { applyOptimistic, revertOptimistic, overlayOptimistic, OPTIMISTIC_TTL_MS } from './optimisticShifts';

const base = () => [
    { id: 'a', staffName: 'Ana', date: '2026-08-17', startTime: '10:00', endTime: '15:00', side: 'foh' },
    { id: 'b', staffName: 'Bo', date: '2026-08-17', startTime: '11:00', endTime: '16:00', side: 'boh' },
];

describe('optimisticShifts overlay', () => {
    it('applies a patch immediately and records the before-values', () => {
        const m = new Map();
        const out = applyOptimistic(m, base(), 'a', { startTime: '09:00', endTime: '14:00' }, 1000);
        expect(out.find(s => s.id === 'a')).toMatchObject({ startTime: '09:00', endTime: '14:00', staffName: 'Ana' });
        expect(out.find(s => s.id === 'b')).toEqual(base()[1]); // untouched
        expect(m.get('a')).toEqual({ patch: { startTime: '09:00', endTime: '14:00' }, before: { startTime: '10:00', endTime: '15:00' }, at: 1000 });
    });

    it('is a no-op for an unknown shift id', () => {
        const m = new Map();
        const src = base();
        expect(applyOptimistic(m, src, 'zzz', { startTime: '09:00' })).toBe(src);
        expect(m.size).toBe(0);
    });

    it('revert restores the original values and clears the entry', () => {
        const m = new Map();
        const patched = applyOptimistic(m, base(), 'a', { staffName: 'Cy', date: '2026-08-18' });
        const back = revertOptimistic(m, patched, 'a');
        expect(back.find(s => s.id === 'a')).toEqual(base()[0]);
        expect(m.size).toBe(0);
        // revert with no entry is harmless
        expect(revertOptimistic(m, back, 'a')).toEqual(back);
    });

    it('stacked patches revert to the ORIGINAL starting values', () => {
        const m = new Map();
        let s = applyOptimistic(m, base(), 'a', { endTime: '15:30' }, 1000);
        s = applyOptimistic(m, s, 'a', { endTime: '16:00' }, 1500);
        expect(s.find(x => x.id === 'a').endTime).toBe('16:00');
        expect(m.get('a').before).toEqual({ endTime: '15:00' });
        expect(revertOptimistic(m, s, 'a').find(x => x.id === 'a').endTime).toBe('15:00');
    });

    it('re-overlays a snapshot that does not yet reflect the patch (another doc echoed first)', () => {
        const m = new Map();
        applyOptimistic(m, base(), 'a', { startTime: '09:00' }, 1000);
        // Snapshot arrives with a's OLD data (someone else's edit to b landed first)
        const snap = base(); snap[1].endTime = '17:00';
        const out = overlayOptimistic(m, snap, 1200);
        expect(out.find(s => s.id === 'a').startTime).toBe('09:00'); // still shows our edit
        expect(out.find(s => s.id === 'b').endTime).toBe('17:00');   // and their edit
        expect(m.has('a')).toBe(true);
    });

    it('settles (drops the entry) once the snapshot reflects the patch', () => {
        const m = new Map();
        applyOptimistic(m, base(), 'a', { startTime: '09:00', endTime: '14:00' }, 1000);
        const snap = base(); snap[0].startTime = '09:00'; snap[0].endTime = '14:00';
        const out = overlayOptimistic(m, snap, 1300);
        expect(out[0]).toBe(snap[0]); // untouched object, server truth
        expect(m.size).toBe(0);
    });

    it('treats null/undefined as equal when settling (offer-state resets)', () => {
        const m = new Map();
        const src = [{ id: 'a', staffName: 'Ana', date: 'd', pendingClaimBy: 'X' }];
        applyOptimistic(m, src, 'a', { pendingClaimBy: null }, 1000);
        const snap = [{ id: 'a', staffName: 'Ana', date: 'd' }]; // field removed entirely
        overlayOptimistic(m, snap, 1100);
        expect(m.size).toBe(0);
    });

    it('expires an entry after the TTL so a hung write cannot pin stale pixels', () => {
        const m = new Map();
        applyOptimistic(m, base(), 'a', { startTime: '09:00' }, 1000);
        const out = overlayOptimistic(m, base(), 1000 + OPTIMISTIC_TTL_MS + 1);
        expect(out[0].startTime).toBe('10:00');
        expect(m.size).toBe(0);
    });

    it('drops entries whose shift vanished from the snapshot (deleted elsewhere)', () => {
        const m = new Map();
        applyOptimistic(m, base(), 'a', { startTime: '09:00' }, 1000);
        const out = overlayOptimistic(m, [base()[1]], 1100);
        expect(out).toHaveLength(1);
        expect(m.size).toBe(0);
    });

    it('never adds or removes shifts — only patches fields (no shift loss)', () => {
        const m = new Map();
        const src = base();
        const a = applyOptimistic(m, src, 'a', { date: '2026-08-19' });
        expect(a.map(s => s.id)).toEqual(['a', 'b']);
        const o = overlayOptimistic(m, base(), Date.now());
        expect(o.map(s => s.id)).toEqual(['a', 'b']);
        const r = revertOptimistic(m, o, 'a');
        expect(r.map(s => s.id)).toEqual(['a', 'b']);
    });

    it('returns the same array reference when there is nothing to overlay', () => {
        const items = base();
        expect(overlayOptimistic(new Map(), items)).toBe(items);
    });
});
