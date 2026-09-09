import { describe, it, expect, vi } from 'vitest';
import { createTapCoalescer } from './inventoryTapCoalescer';

function harness(opts = {}) {
    let t = 0;
    const timers = new Map(); let nextId = 1;
    const flushes = [];
    const c = createTapCoalescer({
        windowMs: 350, maxWaitMs: 1200, ...opts,
        flush: (id, info) => flushes.push({ id, ...info }),
        now: () => t,
        setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: t + ms }); return id; },
        clearTimer: (id) => timers.delete(id),
    });
    const advance = (ms) => {
        const target = t + ms;
        while (true) {
            const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            t = due[1].at; timers.delete(due[0]); due[1].fn();
        }
        t = target;
    };
    return { c, flushes, advance };
}

describe('createTapCoalescer', () => {
    it('five + taps inside the window → ONE inc flush spanning the burst', () => {
        const { c, flushes, advance } = harness();
        for (let i = 0; i < 5; i++) { c.tap('eggs', { prevCount: 3 + i, nextCount: 4 + i, kind: 'inc', priorMeta: { by: 'A' } }); advance(100); }
        expect(flushes).toEqual([]);
        advance(400);
        expect(flushes).toEqual([{ id: 'eggs', prevCount: 3, nextCount: 8, tapDelta: 5, mode: 'inc', priorMeta: { by: 'A' }, ctx: undefined }]);
    });
    it('a − tap anywhere in the window makes the flush absolute (clamped by the caller)', () => {
        const { c, flushes, advance } = harness();
        c.tap('eggs', { prevCount: 3, nextCount: 4, kind: 'inc' });
        c.tap('eggs', { prevCount: 4, nextCount: 5, kind: 'inc' });
        c.tap('eggs', { prevCount: 5, nextCount: 4, kind: 'dec' });
        advance(400);
        expect(flushes[0]).toMatchObject({ prevCount: 3, nextCount: 4, mode: 'abs' });
    });
    it('the window re-arms on every tap but the hard cap forces a flush', () => {
        const { c, flushes, advance } = harness();
        for (let i = 0; i < 20; i++) { c.tap('eggs', { prevCount: i, nextCount: i + 1, kind: 'inc' }); advance(200); }
        // taps every 200 ms never let the 350 ms window expire, so only the 1200 ms cap can fire
        expect(flushes.length).toBeGreaterThanOrEqual(3);
        expect(flushes[0]).toMatchObject({ prevCount: 0, mode: 'inc' });
        // continuity: each flush starts where the previous ended
        for (let i = 1; i < flushes.length; i++) expect(flushes[i].prevCount).toBe(flushes[i - 1].nextCount);
        advance(2000);
        expect(flushes[flushes.length - 1].nextCount).toBe(20);
    });
    it('a typed (abs) value flushes immediately, preserving order after pending incs', () => {
        const { c, flushes, advance } = harness();
        c.tap('eggs', { prevCount: 3, nextCount: 4, kind: 'inc' });
        c.tap('eggs', { prevCount: 4, nextCount: 12, kind: 'abs' });
        expect(flushes).toEqual([{ id: 'eggs', prevCount: 3, nextCount: 12, tapDelta: 9, mode: 'abs', priorMeta: undefined, ctx: undefined }]);
        advance(2000);
        expect(flushes).toHaveLength(1);
    });
    it('items flush independently; flushNow drains synchronously', () => {
        const { c, flushes, advance } = harness();
        c.tap('eggs', { prevCount: 0, nextCount: 1, kind: 'inc' });
        c.tap('milk', { prevCount: 5, nextCount: 6, kind: 'inc' });
        expect(c.pendingIds()).toEqual(['eggs', 'milk']);
        c.flushNow();
        expect(flushes.map(f => f.id)).toEqual(['eggs', 'milk']);
        expect(c.pendingIds()).toEqual([]);
        advance(5000);
        expect(flushes).toHaveLength(2);
    });
    it('priorMeta is the window-start meta, not the latest tap\'s', () => {
        const { c, flushes, advance } = harness();
        c.tap('eggs', { prevCount: 0, nextCount: 1, kind: 'inc', priorMeta: { who: { a: 1 } } });
        c.tap('eggs', { prevCount: 1, nextCount: 2, kind: 'inc', priorMeta: { who: { a: 2 } } });
        advance(400);
        expect(flushes[0].priorMeta).toEqual({ who: { a: 1 } });
    });
    it('a throwing flush never breaks the next window', () => {
        const flushes = [];
        let calls = 0;
        const c = createTapCoalescer({ flush: () => { calls++; if (calls === 1) throw new Error('x'); flushes.push(1); }, now: () => 0, setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} });
        c.tap('a', { prevCount: 0, nextCount: 1, kind: 'abs' });
        c.tap('a', { prevCount: 1, nextCount: 2, kind: 'abs' });
        expect(flushes).toHaveLength(1);
    });
});

describe('window context', () => {
    it('ctx is captured at the window start and rides to the flush (store switch safety)', () => {
        const { c, flushes, advance } = harness();
        c.tap('eggs', { prevCount: 0, nextCount: 1, kind: 'inc', ctx: { loc: 'webster' } });
        c.tap('eggs', { prevCount: 1, nextCount: 2, kind: 'inc', ctx: { loc: 'maryland' } });
        advance(400);
        expect(flushes[0].ctx).toEqual({ loc: 'webster' });
    });
});

describe('tapDelta — the device\'s own contribution, independent of the on-screen base', () => {
    it('a snapshot moving the base mid-window does not inflate the increment', () => {
        const { c, flushes, advance } = harness();
        c.tap('eggs', { prevCount: 5, nextCount: 6, kind: 'inc' });   // +1
        // another device's +1 landed and repainted the row to 7 before our next tap
        c.tap('eggs', { prevCount: 7, nextCount: 8, kind: 'inc' });   // +1
        advance(400);
        expect(flushes[0]).toMatchObject({ prevCount: 5, nextCount: 8, tapDelta: 2, mode: 'inc' });
    });
    it('sums signed contributions across a +/−/+ window', () => {
        const { c, flushes, advance } = harness();
        c.tap('eggs', { prevCount: 3, nextCount: 4, kind: 'inc' });
        c.tap('eggs', { prevCount: 4, nextCount: 3, kind: 'dec' });
        c.tap('eggs', { prevCount: 3, nextCount: 4, kind: 'inc' });
        advance(400);
        expect(flushes[0]).toMatchObject({ tapDelta: 1, mode: 'abs', nextCount: 4 });
    });
});

