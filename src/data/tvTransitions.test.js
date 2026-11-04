import { describe, it, expect } from 'vitest';
import { TV_TRANSITIONS, RANDOM_POOL, resolveTransition, tvSlideStyle } from './tvTransitions';

describe('tv transitions', () => {
    it('keeps the six original looks exactly', () => {
        expect(tvSlideStyle('fade', 'current', 700)).toMatchObject({ opacity: 1, transition: 'opacity 700ms ease' });
        expect(tvSlideStyle('fade', 'prev', 700).opacity).toBe(0);
        expect(tvSlideStyle('slide-left', 'idle', 500).transform).toBe('translateX(100%)');
        expect(tvSlideStyle('slide-up', 'current', 500).transform).toBe('translateY(0)');
        expect(tvSlideStyle('zoom', 'prev', 500).transform).toBe('scale(0.92)');
        expect(tvSlideStyle('cut', 'current', 500)).toMatchObject({ opacity: 1, transition: 'none' });
    });
    it('push: old slide leaves left, waiting slides park right without animating', () => {
        expect(tvSlideStyle('push-left', 'prev', 800)).toMatchObject({ opacity: 1, transform: 'translateX(-100%)' });
        expect(tvSlideStyle('push-left', 'idle', 800)).toMatchObject({ transform: 'translateX(100%)', transition: 'none' });
        expect(tvSlideStyle('push-left', 'current', 800).transform).toBe('translateX(0)');
    });
    it('wipe/circle reveal the new slide over the old one', () => {
        const cur = tvSlideStyle('wipe', 'current', 900), prev = tvSlideStyle('wipe', 'prev', 900);
        expect(cur.zIndex).toBeGreaterThan(prev.zIndex);
        expect(tvSlideStyle('circle', 'idle', 900).clipPath).toBe('circle(0% at 50% 50%)');
    });
    it.each(['wipe', 'circle'])('%s: old slide stays through the reveal, then clears instead of filling the bands', (mode) => {
        const prev = tvSlideStyle(mode, 'prev', 900);
        expect(prev.opacity).toBe(0);
        expect(prev.transition).toBe('opacity 300ms ease 900ms');
    });
    describe('holdPrev (backgrounds that are not black)', () => {
        const FADING = ['fade', 'ken-burns', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'zoom-out', 'blur'];
        it.each(FADING)('%s: old slide stays opaque until the new one is fully in', (mode) => {
            const held = tvSlideStyle(mode, 'prev', 3000, { holdPrev: true });
            expect(held.transition.split(', ')[0]).toBe('opacity 300ms ease 3000ms');
            // Any other property waits until the slide is invisible, so it doesn't move while opaque.
            for (const part of held.transition.split(', ').slice(1)) expect(part).toMatch(/ 0s linear 3300ms$/);
        });
        it.each(FADING)('%s: only the timing changes, so it still animates in next time', (mode) => {
            const { transition: heldT, ...held } = tvSlideStyle(mode, 'prev', 700, { holdPrev: true });
            const { transition: plainT, ...plain } = tvSlideStyle(mode, 'prev', 700);
            expect(held).toEqual(plain);
            expect(heldT).not.toBe(plainT);
        });
        it('leaves the current and waiting slides alone', () => {
            for (const mode of FADING) for (const role of ['current', 'idle']) {
                expect(tvSlideStyle(mode, role, 700, { holdPrev: true })).toEqual(tvSlideStyle(mode, role, 700));
            }
        });
        it.each(['cut', 'push-left', 'push-up', 'wipe', 'circle', 'flip'])('%s never fades both slides, so it is unaffected', (mode) => {
            expect(tvSlideStyle(mode, 'prev', 700, { holdPrev: true })).toEqual(tvSlideStyle(mode, 'prev', 700));
        });
        it('off by default: black TVs keep the same fade', () => {
            expect(tvSlideStyle('fade', 'prev', 700).transition).toBe('opacity 700ms ease');
            expect(tvSlideStyle('blur', 'prev', 700).transition).toBe('opacity 700ms ease, filter 700ms ease');
        });
    });
    it('every listed transition renders a visible current slide', () => {
        for (const t of TV_TRANSITIONS) {
            const mode = resolveTransition(t.id, 3);
            expect(tvSlideStyle(mode, 'current', 700).opacity).toBe(1);
            expect(tvSlideStyle(mode, 'idle', 700).opacity).toBe(0);
        }
    });
    it('random picks varied looks from the pool, stable per change', () => {
        const picks = new Set(Array.from({ length: 40 }, (_, n) => resolveTransition('random', n)));
        expect(picks.size).toBeGreaterThan(5);
        for (const p of picks) expect(RANDOM_POOL).toContain(p);
        expect(resolveTransition('random', 7)).toBe(resolveTransition('random', 7));
        expect(resolveTransition('bogus', 1)).toBe('fade');
    });
});
