// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { tapLabel, toRestValue, createTestActivityLog } from './testActivity';
import { groupSessions } from '../components/TestActivityLog';

const el = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };

describe('what a tap records', () => {
    it("a button's visible label", () => {
        const b = el('<button><span>Save</span>  count</button>');
        expect(tapLabel(b.querySelector('span'))).toBe('Save count');
    });
    it('the aria-label when there is one', () => { expect(tapLabel(el('<button aria-label="Close">✕</button>'))).toBe('Close'); });
    it('never anything in a text box, and nothing for plain text', () => {
        expect(tapLabel(el('<input value="my secret">'))).toBe(null);
        expect(tapLabel(el('<textarea>notes</textarea>'))).toBe(null);
        expect(tapLabel(el('<p>just words</p>'))).toBe(null);
        expect(tapLabel(el('<label>PIN <input value="1234"></label>'))).toBe(null);
    });
    it('long labels are cut short', () => { expect(tapLabel(el(`<button>${'x'.repeat(100)}</button>`)).length).toBe(60); });
});

describe('sending', () => {
    it('encodes for the REST API', () => {
        expect(toRestValue({ a: 1, b: 'x', c: [true, null], d: 1.5 })).toEqual({ mapValue: { fields: {
            a: { integerValue: '1' }, b: { stringValue: 'x' }, c: { arrayValue: { values: [{ booleanValue: true }, { nullValue: null }] } }, d: { doubleValue: 1.5 },
        } } });
    });
    it('batches events into numbered documents for the session', () => {
        vi.useFakeTimers();
        const fetchImpl = vi.fn(async () => ({}));
        let t = 1000;
        const log = createTestActivityLog({ session: 's1', staff: { id: 83, name: 'Test' }, appVersion: '1.0.515', fetchImpl, now: () => t });
        log.record('start');
        t = 2000; log.record('page', { tab: 'operations' });
        expect(fetchImpl).not.toHaveBeenCalled();
        vi.advanceTimersByTime(20000);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchImpl.mock.calls[0];
        expect(url).toMatch(/\/documents\/test_activity\?documentId=s1_0001$/);
        const f = JSON.parse(opts.body).fields;
        expect(f.staffName.stringValue).toBe('Test');
        expect(f.events.arrayValue.values).toHaveLength(2);
        log.record('tap', { label: 'Save' });
        log.flush(true);
        expect(fetchImpl.mock.calls[1][0]).toMatch(/s1_0002$/);
        expect(fetchImpl.mock.calls[1][1].keepalive).toBe(true);
        vi.useRealTimers();
    });
    it('a failed send never throws into the app', () => {
        const log = createTestActivityLog({ session: 's', staff: {}, fetchImpl: () => { throw new Error('offline'); } });
        log.record('start');
        expect(() => log.flush()).not.toThrow();
    });
});

describe('the owner view', () => {
    it('one entry per sign-in, newest first, with pages in order', () => {
        const s = groupSessions([
            { session: 'a', startedAt: 100, events: [{ at: 100, kind: 'start' }, { at: 200, kind: 'page', tab: 'home' }] },
            { session: 'a', startedAt: 100, events: [{ at: 60100, kind: 'page', tab: 'operations' }, { at: 60200, kind: 'tap', label: 'Save' }, { at: 300, kind: 'page', tab: 'home' }] },
            { session: 'b', startedAt: 999999, events: [{ at: 999999, kind: 'start' }] },
        ]);
        expect(s.map(x => x.session)).toEqual(['b', 'a']);
        expect(s[1].pages).toEqual(['home', 'operations']);
        expect(s[1].taps).toBe(1);
        expect(s[1].minutes).toBe(1);
    });
});
