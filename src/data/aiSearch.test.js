// useAiSearch stale results (2026-09-23 review): a NEW query kept showing
// the PREVIOUS query's AI matches through the debounce + round trip. Now
// they clear the moment the query text changes; a same-query items refresh
// keeps them (no flicker on snapshot echoes).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { callable } = vi.hoisted(() => ({ callable: vi.fn() }));
vi.mock('firebase/functions', () => ({
    getFunctions: vi.fn(() => ({})),
    httpsCallable: vi.fn(() => callable),
}));

import { useAiSearch } from './aiSearch';

const ITEMS = [
    { id: 'e1', name: 'Egg roll', category: 'Apps', subcat: '' },
    { id: 'b1', name: 'Beef', category: 'Proteins', subcat: '' },
];

beforeEach(() => {
    vi.useFakeTimers();
    callable.mockReset();
    callable.mockImplementation(async ({ query }) => ({
        data: { matchingIds: query.startsWith('eg') ? ['e1'] : query.startsWith('be') ? ['b1'] : [] },
    }));
});
afterEach(() => vi.useRealTimers());

describe('useAiSearch', () => {
    it('clears the previous query\'s matches as soon as the query changes', async () => {
        const { result, rerender } = renderHook((props) => useAiSearch(props), {
            initialProps: { query: 'egg', items: ITEMS, enabled: true },
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        expect(result.current.matchingIds).toEqual(['e1']);

        rerender({ query: 'beef', items: ITEMS, enabled: true });
        // Before the debounce fires: NOT the stale ['e1'].
        expect(result.current.matchingIds).toBeNull();
        expect(result.current.loading).toBe(true);

        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        expect(result.current.matchingIds).toEqual(['b1']);
    });

    it('an items-only refresh with the same query keeps the current matches', async () => {
        const { result, rerender } = renderHook((props) => useAiSearch(props), {
            initialProps: { query: 'beef', items: ITEMS, enabled: true },
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        expect(result.current.matchingIds).toEqual(['b1']);
        rerender({ query: 'beef', items: [...ITEMS], enabled: true });
        expect(result.current.matchingIds).toEqual(['b1']);
    });

    it('disabling / clearing the query still resets (unchanged)', async () => {
        const { result, rerender } = renderHook((props) => useAiSearch(props), {
            initialProps: { query: 'egg', items: ITEMS, enabled: true },
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        rerender({ query: '', items: ITEMS, enabled: true });
        expect(result.current.matchingIds).toBeNull();
        expect(result.current.loading).toBe(false);
    });
});
