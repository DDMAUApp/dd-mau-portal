import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useEffect } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearPushOutcomes, markSignInStamped, notePushOutcome, planTokenBinding, readPushOutcomes,
    rosterGateOpen, signInStampedRecently, SIGN_IN_STAMP_MS,
} from './noChangeSaves';
import { FLAGS_KEY } from './reliabilityFlags';

let testMode = false;
vi.mock('./testMode', () => ({ get TEST_MODE() { return testMode; } }));

const setFlag = (on) => localStorage.setItem(FLAGS_KEY, JSON.stringify({ flags: { skipNoChangeTx: on } }));
const NOW = 1_800_000_000_000;
const DEV = 'device-aaaa';
const entry = (token, deviceId = DEV, extra = {}) => ({ token, lastSeen: 1, deviceId, ...extra });
const person = (name, fcmTokens) => ({ name, pin: '1234', id: name, ...(fcmTokens ? { fcmTokens } : {}) });
const plan = (list, name = 'Ana', token = 'T1', deviceId = DEV, platform, tokenKind) =>
    planTokenBinding(list, name, token, deviceId, platform, tokenKind, NOW);

beforeEach(() => { testMode = false; localStorage.clear(); });

describe('planTokenBinding', () => {
    it('same token first and nothing to sweep: already bound', () => {
        expect(plan([person('Ana', [entry('T1')]), person('Bo')]).alreadyBound).toBe(true);
    });

    it('other devices behind mine stay bound', () => {
        const r = plan([person('Ana', [entry('T1'), entry('OTHER', 'device-bbbb')])]);
        expect(r.alreadyBound).toBe(true);
        expect(r.nextTokens.map((t) => t.token)).toEqual(['T1', 'OTHER']);
    });

    it('rotated token on this device: not bound, and the new one replaces the old', () => {
        const r = plan([person('Ana', [entry('OLD')])]);
        expect(r.alreadyBound).toBe(false);
        expect(r.nextList[0].fcmTokens).toEqual([{ token: 'T1', lastSeen: NOW, deviceId: DEV }]);
    });

    it('never on the record, or an empty record: not bound', () => {
        expect(plan([person('Ana')]).alreadyBound).toBe(false);
        expect(plan([person('Ana', [])]).alreadyBound).toBe(false);
        expect(plan([person('Ana', [entry('OTHER', 'device-bbbb')])]).alreadyBound).toBe(false);
    });

    it('mine in second place: not bound, moves to the front', () => {
        const r = plan([person('Ana', [entry('OTHER', 'device-bbbb'), entry('T1')])]);
        expect(r.alreadyBound).toBe(false);
        expect(r.nextTokens.map((t) => t.token)).toEqual(['T1', 'OTHER']);
    });

    it('a duplicate or junk entry on my record: not bound, so it gets cleaned', () => {
        expect(plan([person('Ana', [entry('T1'), entry('X', 'd2'), entry('X', 'd3')])]).alreadyBound).toBe(false);
        expect(plan([person('Ana', [entry('T1'), { lastSeen: 1 }])]).alreadyBound).toBe(false);
        expect(plan([person('Ana', [entry('T1'), null])]).alreadyBound).toBe(false);
    });

    it('over the cap: not bound, trimmed to five with mine first', () => {
        const six = [entry('T1'), ...[2, 3, 4, 5, 6].map((n) => entry(`t${n}`, `d${n}`))];
        const r = plan([person('Ana', six)]);
        expect(r.alreadyBound).toBe(false);
        expect(r.nextTokens).toHaveLength(5);
        expect(r.nextTokens[0].token).toBe('T1');
        expect(plan([person('Ana', six.slice(0, 5))]).alreadyBound).toBe(true);
    });

    it('another person holds this device: not bound, and it comes off them', () => {
        const r = plan([person('Ana'), person('Bo', [entry('T9')]), person('Cy', [entry('KEEP', 'device-cccc')])]);
        expect(r.alreadyBound).toBe(false);
        expect(r.sweepCount).toBe(1);
        expect(r.nextList[0].fcmTokens.map((t) => t.token)).toEqual(['T1']);
        expect(r.nextList[1].fcmTokens).toEqual([]);
        expect(r.nextList[2].fcmTokens.map((t) => t.token)).toEqual(['KEEP']);
    });

    // The rule that matters: my record looking right isn't enough.
    it('myOwnSame with a sweep still to do is not bound: same device', () => {
        const r = plan([person('Ana', [entry('T1')]), person('Bo', [entry('OLD')])]);
        expect(r.alreadyBound).toBe(false);
        expect(r.sweepCount).toBe(1);
    });

    it('myOwnSame with a sweep still to do is not bound: same token, other device ID', () => {
        const r = plan([person('Ana', [entry('T1')]), person('Bo', [entry('T1', 'device-old')])]);
        expect(r.alreadyBound).toBe(false);
        expect(r.nextList[1].fcmTokens).toEqual([]);
    });

    it('someone else\'s entry with no token is swept, as the transaction always did', () => {
        const r = plan([person('Ana', [entry('T1')]), person('Bo', [{ lastSeen: 2 }])]);
        expect(r.alreadyBound).toBe(false);
        expect(r.sweepCount).toBe(1);
    });

    it('a legacy entry on another person with no device ID and a different token is left alone', () => {
        const legacy = { token: 'LEGACY', lastSeen: 1 };
        const r = plan([person('Ana', [entry('T1')]), person('Bo', [legacy])]);
        expect(r.alreadyBound).toBe(true);
        expect(r.nextList[1].fcmTokens).toEqual([legacy]);
    });

    it('the same token under an old device ID on my own record counts as bound, as today', () => {
        expect(plan([person('Ana', [entry('T1', 'device-old')])]).alreadyBound).toBe(true);
    });

    it('person not on the roster, or no roster: not found and not bound', () => {
        expect(plan([person('Bo')])).toMatchObject({ found: false, alreadyBound: false, nextList: null });
        expect(plan([])).toMatchObject({ found: false, alreadyBound: false });
        expect(plan(undefined)).toMatchObject({ found: false, alreadyBound: false });
    });

    it('web entry has no platform keys at all: Firestore refuses undefined', () => {
        const e = plan([person('Ana')]).nextTokens[0];
        expect(Object.keys(e).sort()).toEqual(['deviceId', 'lastSeen', 'token']);
    });

    it('native entries carry platform and token kind', () => {
        expect(plan([person('Ana')], 'Ana', 'T1', DEV, 'ios', 'apns_raw').nextTokens[0])
            .toEqual({ token: 'T1', lastSeen: NOW, deviceId: DEV, platform: 'ios', tokenKind: 'apns_raw' });
        expect(plan([person('Ana')], 'Ana', 'T1', DEV, 'android', 'fcm').nextTokens[0])
            .toEqual({ token: 'T1', lastSeen: NOW, deviceId: DEV, platform: 'android', tokenKind: 'fcm' });
    });

    it('native and web agree on bound: entries are matched by token', () => {
        const list = [person('Ana', [entry('T1', DEV, { platform: 'ios', tokenKind: 'apns_raw' })])];
        expect(plan(list, 'Ana', 'T1', DEV, 'ios', 'apns_raw').alreadyBound).toBe(true);
        expect(plan(list, 'Ana', 'T1', DEV).alreadyBound).toBe(true);
    });

    it('is pure: input untouched, same answer twice, and other records keep their identity', () => {
        const list = [person('Ana', [entry('OLD')]), person('Bo', [entry('X', 'device-bbbb')]), person('Cy')];
        const before = JSON.stringify(list);
        const a = plan(list);
        expect(a).toEqual(plan(list));
        expect(JSON.stringify(list)).toBe(before);
        expect(a.nextList[1]).toBe(list[1]);
        expect(a.nextList[2]).toBe(list[2]);
    });

    it('throws on a malformed record, as the transaction did, so a check can treat it as doubt', () => {
        expect(() => plan([null, person('Ana')])).toThrow();
        expect(() => plan([person('Ana', [null, entry('X', 'device-bbbb')])])).toThrow();
    });
});

describe('rosterGateOpen and the effects behind it', () => {
    function Probe({ ready, onRun }) {
        const gate = rosterGateOpen(ready);
        useEffect(() => { if (gate) onRun(); }, [gate, onRun]);
        return null;
    }
    const runsThrough = () => {
        const onRun = vi.fn();
        const view = render(<Probe ready={false} onRun={onRun} />);
        const before = onRun.mock.calls.length;
        view.rerender(<Probe ready={true} onRun={onRun} />);
        return { before, after: onRun.mock.calls.length };
    };

    it('flag off or never delivered: fires at once and never re-fires when the roster lands', () => {
        expect(runsThrough()).toEqual({ before: 1, after: 1 });
        setFlag(false);
        expect(runsThrough()).toEqual({ before: 1, after: 1 });
    });

    it('flag on: does not fire before the roster is ready, then fires once', () => {
        setFlag(true);
        expect(runsThrough()).toEqual({ before: 0, after: 1 });
    });

    it('test mode reads as off even when set', () => {
        setFlag(true);
        testMode = true;
        expect(rosterGateOpen(false)).toBe(true);
    });

    it('a broken flag store reads as off', () => {
        localStorage.setItem(FLAGS_KEY, '{oops');
        expect(rosterGateOpen(false)).toBe(true);
    });

    it('App gates all three boot saves on it, and deps include it', () => {
        const app = readFileSync(resolve(process.cwd(), 'src/App.jsx'), 'utf8');
        expect(app.match(/if \(!rosterGate\) return;/g)).toHaveLength(3);
        expect(app).toContain('[staffName, staffList, rosterGate]');
        expect(app).toContain('[staffName, currentStaffRecord?.pwaInstalled, rosterGate]');
        expect(app).toContain('[staffName, currentStaffRecord?.id, rosterGate]');
        expect(app).toContain('enableFcmPush(staffName, staffList, setStaffList, { bootCheck: true })');
    });
});

describe('sign-in stamp device record', () => {
    it('fresh inside 30 minutes, not at or past it', () => {
        markSignInStamped('Ana', NOW);
        expect(signInStampedRecently('Ana', NOW + 1)).toBe(true);
        expect(signInStampedRecently('Ana', NOW + SIGN_IN_STAMP_MS - 1)).toBe(true);
        expect(signInStampedRecently('Ana', NOW + SIGN_IN_STAMP_MS)).toBe(false);
    });

    it('is per person: a shared iPad doesn\'t mix people up', () => {
        markSignInStamped('Ana', NOW);
        expect(signInStampedRecently('Bo', NOW)).toBe(false);
        expect(localStorage.getItem('ddmau:stamped:signIn:Ana')).toBe(String(NOW));
    });

    it('missing, junk or from the future is doubt', () => {
        expect(signInStampedRecently('Ana', NOW)).toBe(false);
        localStorage.setItem('ddmau:stamped:signIn:Ana', 'junk');
        expect(signInStampedRecently('Ana', NOW)).toBe(false);
        markSignInStamped('Ana', NOW + 60_000);
        expect(signInStampedRecently('Ana', NOW)).toBe(false);
    });

    it('a storage failure is doubt, not a crash', () => {
        const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('no'); });
        const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('no'); });
        expect(signInStampedRecently('Ana', NOW)).toBe(false);
        expect(() => markSignInStamped('Ana', NOW)).not.toThrow();
        get.mockRestore();
        set.mockRestore();
    });
});

describe('push outcome counts', () => {
    it('adds up, and clearing takes off only what was sent', () => {
        notePushOutcome('already-bound');
        notePushOutcome('already-bound');
        notePushOutcome('tx:wrote');
        const sent = readPushOutcomes();
        notePushOutcome('already-bound');
        clearPushOutcomes(sent);
        expect(readPushOutcomes()).toEqual({ 'already-bound': 1 });
        clearPushOutcomes(readPushOutcomes());
        expect(localStorage.getItem('ddmau:pushOutcomes')).toBeNull();
    });

    it('survives a broken store', () => {
        localStorage.setItem('ddmau:pushOutcomes', '[1,2');
        expect(readPushOutcomes()).toEqual({});
        notePushOutcome('tx:wrote');
        expect(readPushOutcomes()).toEqual({ 'tx:wrote': 1 });
    });
});
