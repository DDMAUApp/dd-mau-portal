import { describe, it, expect } from 'vitest';
import lib from './tvAlerts.js';
const {
    planTvAlerts, stampsFor, stillValid, formatTvAlertMessages, humanDuration, tvName, toMs, listFor,
    STALE_MS, FRESH_MS, RECOVER_HOLD_MS, FLAP_HOLD_MS, REMIND_EVERY_MS, REMIND_MAX_MS, FIRST_ALERT_MAX_MS,
} = lib;

const SEC = 1000, MIN = 60_000, H = 60 * MIN, D = 24 * H;
const NOW = Date.UTC(2026, 8, 17, 18, 0, 0);          // 13:00 Central (CDT = UTC-5)
const chicagoHour = (ms) => new Date(ms - 5 * H).getUTCHours();
const configs = {
    webster: { label: 'webster 1', location: 'webster' },
    'webster-2': { label: 'webster 2', location: 'webster' },
    'webster-photos': { label: 'Webster Photos', location: 'webster' },
    'md-1': { label: 'front', location: 'maryland' },
    muted: { label: 'old screen', location: 'webster', alertsMuted: true },
};
const plan = (heartbeats, extra = {}) => planTvAlerts({ heartbeats, configs, nowMs: NOW, chicagoHour: 13, ...extra });
const ids = (list) => list.map((x) => x.id);

describe('planTvAlerts — single decisions', () => {
    it('healthy screens produce nothing', () => {
        const p = plan([{ id: 'webster', lastSeenMs: NOW - 30 * SEC }]);
        for (const k of ['offline', 'flapping', 'recovered', 'reminders', 'stopped', 'holdStart', 'holdReset']) expect(p[k]).toEqual([]);
    });
    it('first alert once: stale + no open incident (10 min exactly is not yet stale)', () => {
        expect(ids(plan([{ id: 'webster', lastSeenMs: NOW - 12 * MIN }]).offline)).toEqual(['webster']);
        expect(plan([{ id: 'webster', lastSeenMs: NOW - STALE_MS }]).offline).toEqual([]);
        expect(plan([{ id: 'webster', lastSeenMs: NOW - 12 * MIN, alertedMs: NOW - 2 * MIN }]).offline).toEqual([]);
    });
    it('a screen that died while alerts were off still alerts (hours later), but a retired one (>14 d) never does', () => {
        expect(plan([{ id: 'webster', lastSeenMs: NOW - 3 * H }]).offline[0]).toMatchObject({ id: 'webster', ageMin: 180 });
        expect(plan([{ id: 'webster', lastSeenMs: NOW - 3 * D }]).offline).toHaveLength(1);
        expect(plan([{ id: 'webster', lastSeenMs: NOW - FIRST_ALERT_MAX_MS - MIN }]).offline).toEqual([]);
    });
    it('preview/test ids without a tv_configs doc, muted screens, and never-seen docs never alert', () => {
        expect(plan([{ id: 'test-tab', lastSeenMs: NOW - 30 * MIN }]).offline).toEqual([]);
        expect(plan([{ id: 'muted', lastSeenMs: NOW - 30 * MIN }]).offline).toEqual([]);
        expect(plan([{ id: 'webster', lastSeenMs: 0 }]).offline).toEqual([]);
    });
    it('recovery needs a HOLD: first healthy run only starts it (silently); it completes after ~15 min', () => {
        const open = { id: 'webster', lastSeenMs: NOW - 20 * SEC, alertedMs: NOW - 40 * MIN, lastOutageAgeMin: 11 };
        const a = plan([open]);
        expect(ids(a.holdStart)).toEqual(['webster']); expect(a.recovered).toEqual([]);
        expect(plan([{ ...open, healthySinceMs: NOW - 10 * MIN }]).recovered).toEqual([]);
        const done = plan([{ ...open, healthySinceMs: NOW - RECOVER_HOLD_MS }]);
        // outage = from (alert − 11 min) to when it first looked healthy again
        expect(done.recovered).toEqual([{ id: 'webster', downMin: 37, wasFlapping: false }]);
    });
    it('a relapse (or skipped beats) inside the hold resets it silently — the incident stays open', () => {
        const relapsed = plan([{ id: 'webster', lastSeenMs: NOW - 6 * MIN, alertedMs: NOW - 40 * MIN, healthySinceMs: NOW - 8 * MIN }]);
        expect(ids(relapsed.holdReset)).toEqual(['webster']);
        expect(relapsed.offline).toEqual([]); expect(relapsed.recovered).toEqual([]);
    });
    it('an open incident closes even if the screen was muted/unconfigured meanwhile', () => {
        expect(plan([{ id: 'muted', lastSeenMs: NOW - 20 * SEC, alertedMs: NOW - H, healthySinceMs: NOW - 20 * MIN }]).recovered).toHaveLength(1);
        expect(plan([{ id: 'gone', lastSeenMs: NOW - 20 * SEC, alertedMs: NOW - H }]).holdStart).toHaveLength(1);
    });
    it('reminders: every 3 h from the last nudge, daytime only', () => {
        const hb = { id: 'webster', lastSeenMs: NOW - 4 * H, alertedMs: NOW - 3 * H - MIN };
        expect(plan([hb]).reminders).toEqual([{ id: 'webster', ageMin: 240, remindedMs: 0 }]);
        expect(plan([{ ...hb, remindedMs: NOW - 2 * H }]).reminders).toEqual([]);
        expect(plan([{ ...hb, remindedMs: NOW - REMIND_EVERY_MS }]).reminders).toHaveLength(1);
        expect(plan([hb], { chicagoHour: 7 }).reminders).toEqual([]);
        expect(plan([hb], { chicagoHour: 21 }).reminders).toEqual([]);
        expect(plan([hb], { chicagoHour: 20 }).reminders).toHaveLength(1);
    });
    it('after 2 days: one "I will stop" notice (daytime), then silence', () => {
        const old = { id: 'webster', lastSeenMs: NOW - 50 * H, alertedMs: NOW - REMIND_MAX_MS - MIN };
        expect(plan([old]).stopped).toHaveLength(1);
        expect(plan([old]).reminders).toEqual([]);
        expect(plan([{ ...old, stoppedMs: NOW - H }]).stopped).toEqual([]);
        expect(plan([old], { chicagoHour: 2 }).stopped).toEqual([]);
    });
    it('4th incident inside 24 h becomes the "keeps dropping" notice, and its recovery needs a full hour', () => {
        const times = [NOW - 20 * H, NOW - 9 * H, NOW - 2 * H];
        const p = plan([{ id: 'webster', lastSeenMs: NOW - 12 * MIN, alertTimes: times }]);
        expect(p.offline).toEqual([]);
        expect(p.flapping[0]).toMatchObject({ id: 'webster', countIn24h: 4 });
        expect(p.flapping[0].alertTimes).toEqual([...times, NOW]);
        // incidents older than 24 h fall out of the count
        expect(plan([{ id: 'webster', lastSeenMs: NOW - 12 * MIN, alertTimes: [NOW - 30 * H, NOW - 26 * H, NOW - 25 * H] }]).offline).toHaveLength(1);
        const open = { id: 'webster', lastSeenMs: NOW - 20 * SEC, alertedMs: NOW - 3 * H, flapMs: NOW - 3 * H };
        expect(plan([{ ...open, healthySinceMs: NOW - 30 * MIN }]).recovered).toEqual([]);
        expect(plan([{ ...open, healthySinceMs: NOW - FLAP_HOLD_MS }]).recovered[0]).toMatchObject({ wasFlapping: true });
    });
    it('locStats: a whole store is "down" only when 2+ watched screens are stale and none is alive', () => {
        const p = plan([{ id: 'webster', lastSeenMs: NOW - 12 * MIN }, { id: 'webster-2', lastSeenMs: NOW - 11 * MIN, alertedMs: NOW - MIN }, { id: 'webster-photos', lastSeenMs: NOW - 9 * MIN }]);
        expect(p.locStats.webster).toEqual({ down: 2, alive: 1 });
    });
    it('tolerates garbage', () => {
        const p = planTvAlerts({ heartbeats: [null, {}, { id: '' }, { id: 'webster', lastSeenMs: 'x', alertedMs: NaN, alertTimes: 'nope' }], configs: null, nowMs: NOW, chicagoHour: 12 });
        expect(p.offline).toEqual([]); expect(p.recovered).toEqual([]);
        expect(planTvAlerts({ heartbeats: undefined, configs, nowMs: NOW, chicagoHour: 12 }).offline).toEqual([]);
    });
});

// ── life-cycle simulator: the REAL planner + the REAL stamping rules, stepped every 5 min ──
function simulate({ beatAt, hours, startMs = NOW, id = 'webster' }) {
    const doc = {};
    const said = [];
    for (let t = startMs; t <= startMs + hours * H; t += 5 * MIN) {
        const hb = {
            id, lastSeenMs: beatAt(t), alertedMs: doc.alertedAt || 0, remindedMs: doc.remindedAt || 0,
            stoppedMs: doc.remindersStoppedAt || 0, healthySinceMs: doc.healthySinceAt || 0, flapMs: doc.flapAt || 0,
            lastOutageAgeMin: doc.lastOutageAgeMin || 0, alertTimes: doc.alertTimes || [],
        };
        const p = planTvAlerts({ heartbeats: [hb], configs, nowMs: t, chicagoHour: chicagoHour(t) });
        const spoken = formatTvAlertMessages(p, configs).map((m) => m.kind);
        for (const kind of ['offline', 'flapping', 'recovered', 'reminder', 'stopped', 'holdStart', 'holdReset']) {
            for (const item of listFor(p, kind)) {
                const st = stampsFor(kind, item);
                for (const [k, v] of Object.entries(st.set)) doc[k] = v === 'NOW' ? t + 2 * SEC : v;   // commit lands a moment after `now`
                for (const k of st.del) delete doc[k];
            }
        }
        for (const kind of spoken) said.push({ kind, atMin: Math.round((t - startMs) / MIN), hour: chicagoHour(t) });
    }
    return { said, doc, kinds: said.map((s) => s.kind) };
}
const count = (kinds, k) => kinds.filter((x) => x === k).length;

describe('incident life-cycle (simulated 5-min runs)', () => {
    it('dead for 4 days, then back: 1 offline, daytime reminders for 48 h, 1 stopped, silence, 1 recovered', () => {
        const died = NOW, back = NOW + 4 * D;
        const beatAt = (t) => (t < back ? died - 30 * SEC : t - ((t - back) % MIN));   // beats every minute once back
        const { said, kinds, doc } = simulate({ beatAt, hours: 4 * 24 + 2 });
        expect(count(kinds, 'offline')).toBe(1);
        expect(count(kinds, 'stopped')).toBe(1);
        expect(count(kinds, 'recovered')).toBe(1);
        expect(count(kinds, 'flapping')).toBe(0);
        const reminders = said.filter((s) => s.kind === 'reminder');
        expect(reminders.length).toBeGreaterThanOrEqual(8);
        expect(reminders.length).toBeLessThanOrEqual(11);
        expect(reminders.every((r) => r.hour >= 8 && r.hour < 21)).toBe(true);
        for (let i = 1; i < reminders.length; i++) expect(reminders[i].atMin - reminders[i - 1].atMin).toBeGreaterThanOrEqual(180);
        expect(kinds.indexOf('stopped')).toBeGreaterThan(kinds.lastIndexOf('reminder'));
        expect(kinds[kinds.length - 1]).toBe('recovered');
        expect(doc.alertedAt).toBeUndefined();                       // incident fully closed
        const rec = said.find((s) => s.kind === 'recovered');
        expect(rec.atMin - 4 * 24 * 60).toBeGreaterThanOrEqual(15);  // announced only after the hold
        expect(rec.atMin - 4 * 24 * 60).toBeLessThanOrEqual(25);
    });
    it('CRASH LOOP (page lives 2 min after each 16-min Pi restart) for 6 h: ONE offline, ZERO "back online"', () => {
        const beatAt = (t) => {
            const since = t - NOW; if (since < 0) return NOW - 30 * SEC;
            const cycleStart = NOW + Math.floor(since / (16 * MIN)) * 16 * MIN;
            const into = t - cycleStart;
            // the first cycle is the original death; later cycles beat at +20 s, +80 s, +140 s
            if (cycleStart === NOW) return NOW - 30 * SEC;
            const beats = [20 * SEC, 80 * SEC, 140 * SEC].filter((b) => b <= into);
            return beats.length ? cycleStart + beats[beats.length - 1] : cycleStart - 16 * MIN + 140 * SEC;
        };
        const { kinds } = simulate({ beatAt, hours: 6 });
        expect(count(kinds, 'offline')).toBe(1);
        expect(count(kinds, 'recovered')).toBe(0);
        expect(count(kinds, 'flapping')).toBe(0);
        expect(count(kinds, 'reminder')).toBeLessThanOrEqual(2);
    });
    it('an 11-minute Wi-Fi blip, then stable: exactly one offline and one recovered ~15-25 min after return', () => {
        const back = NOW + 11 * MIN + 30 * SEC;
        const beatAt = (t) => (t < back ? NOW - 30 * SEC : t - ((t - back) % MIN));
        const { said, kinds } = simulate({ beatAt, hours: 3 });
        expect(kinds).toEqual(['offline', 'recovered']);
        const gap = said[1].atMin - said[0].atMin;
        expect(gap).toBeGreaterThanOrEqual(15); expect(gap).toBeLessThanOrEqual(30);
    });
    it('a night-time death is quiet at 2 AM and loud at the 8 AM reminder', () => {
        const start = Date.UTC(2026, 8, 18, 7, 0, 0);                // 02:00 Central
        const { said } = simulate({ beatAt: () => start - 30 * SEC, hours: 8, startMs: start });
        expect(said[0]).toMatchObject({ kind: 'offline', hour: 2 });
        const firstReminder = said.find((s) => s.kind === 'reminder');
        expect(firstReminder.hour).toBe(8);
        const p = planTvAlerts({ heartbeats: [{ id: 'webster', lastSeenMs: start - 12 * MIN }], configs, nowMs: start, chicagoHour: 2 });
        expect(formatTvAlertMessages(p, configs)[0].loud).toBe(false);
        expect(formatTvAlertMessages(plan([{ id: 'webster', lastSeenMs: NOW - 12 * MIN }]), configs)[0].loud).toBe(true);
    });
    it('four separate outages in a day: three normal alerts, then one "keeps dropping"; never more than one open incident', () => {
        // down 30 min at 0 h, 5 h, 10 h, 15 h; healthy otherwise
        const downs = [0, 5, 10, 15].map((h) => [NOW + h * H, NOW + h * H + 30 * MIN]);
        const beatAt = (t) => { const d = downs.find(([a, b]) => t >= a && t < b); return d ? d[0] - 30 * SEC : t - (t % MIN); };
        const { kinds } = simulate({ beatAt, hours: 20 });
        expect(count(kinds, 'offline')).toBe(3);
        expect(count(kinds, 'flapping')).toBe(1);
        expect(count(kinds, 'recovered')).toBe(4);
        for (let i = 1; i < kinds.length; i++) if (kinds[i] === 'offline' || kinds[i] === 'flapping') expect(kinds[i - 1]).toBe('recovered');
    });
});

describe('stamps + transaction re-check', () => {
    it('stampsFor: an offline stamp opens the incident and clears leftovers; recovered clears everything but the history', () => {
        expect(stampsFor('offline', { ageMin: 12, alertTimes: [1, 2] })).toEqual({ set: { alertedAt: 'NOW', lastOutageAgeMin: 12, alertTimes: [1, 2] }, del: ['remindedAt', 'remindersStoppedAt', 'healthySinceAt', 'flapAt'] });
        expect(stampsFor('recovered', {}).del).toEqual(['alertedAt', 'lastOutageAgeMin', 'remindedAt', 'remindersStoppedAt', 'healthySinceAt', 'flapAt']);
        expect(stampsFor('recovered', {}).del).not.toContain('alertTimes');
        expect(stampsFor('flapping', { ageMin: 1, alertTimes: [] }).set.flapAt).toBe('NOW');
        expect(stampsFor('nonsense', {})).toEqual({ set: {}, del: [] });
    });
    it('stillValid: a second overlapping run sees the first run\'s stamp and posts nothing', () => {
        const stale = { lastSeenAt: NOW - 12 * MIN };
        expect(stillValid('offline', {}, stale, NOW)).toBe(true);
        expect(stillValid('offline', {}, { ...stale, alertedAt: NOW - SEC }, NOW)).toBe(false);      // already alerted
        expect(stillValid('offline', {}, { lastSeenAt: NOW - SEC }, NOW)).toBe(false);               // came back meanwhile
        expect(stillValid('reminder', { remindedMs: 0 }, { ...stale, alertedAt: 1 }, NOW)).toBe(true);
        expect(stillValid('reminder', { remindedMs: 0 }, { ...stale, alertedAt: 1, remindedAt: NOW - SEC }, NOW)).toBe(false);
        expect(stillValid('stopped', {}, { ...stale, alertedAt: 1, remindersStoppedAt: 5 }, NOW)).toBe(false);
        expect(stillValid('recovered', {}, { lastSeenAt: NOW - SEC }, NOW)).toBe(false);             // no open incident
        expect(stillValid('recovered', {}, { lastSeenAt: NOW - SEC, alertedAt: 1 }, NOW)).toBe(true);
    });
});

describe('wording', () => {
    it('humanDuration never prints Infinity/NaN', () => {
        expect(humanDuration(12)).toBe('12 min');
        expect(humanDuration(60)).toBe('1 h');
        expect(humanDuration(190)).toBe('3 h 10 min');
        expect(humanDuration(49 * 60)).toBe('2 d 1 h');
        expect(humanDuration(Infinity)).toBe('0 min');
        expect(humanDuration(undefined)).toBe('0 min');
    });
    it('tvName adds the store unless the label already says it', () => {
        expect(tvName('md-1', configs)).toBe('front (Maryland Heights)');
        expect(tvName('webster', configs)).toBe('webster 1');
        expect(tvName('webster-photos', configs)).toBe('Webster Photos');
        expect(tvName('unknown', configs)).toBe('unknown');
    });
    it('one screen down → "needs a look"; a whole store down → internet/power — even when the drops were staggered', () => {
        const one = formatTvAlertMessages(plan([{ id: 'webster', lastSeenMs: NOW - 12 * MIN }, { id: 'webster-2', lastSeenMs: NOW - SEC }]), configs);
        expect(one).toHaveLength(1);
        expect(one[0].text).toContain('📴 Menu screen offline\n• webster 1 — no check-in for 12 min');
        expect(one[0].text).toContain('needs a look');
        expect(one[0].pushTitle).toBe('📴 Menu screen offline');
        expect(one[0].pushBody).toBe('webster 1 — no check-in for 12 min.');
        // staggered: two already alerted on the last run, the third crosses 10 min now
        const third = formatTvAlertMessages(plan([
            { id: 'webster', lastSeenMs: NOW - 17 * MIN, alertedMs: NOW - 5 * MIN }, { id: 'webster-2', lastSeenMs: NOW - 17 * MIN, alertedMs: NOW - 5 * MIN },
            { id: 'webster-photos', lastSeenMs: NOW - 11 * MIN },
        ]), configs);
        expect(third[0].text).toContain("store's internet or power");
        const both = formatTvAlertMessages(plan([{ id: 'webster', lastSeenMs: NOW - 12 * MIN }, { id: 'webster-2', lastSeenMs: NOW - 11 * MIN }]), configs);
        expect(both[0].pushTitle).toBe('📴 Menu screens offline');
        expect(both[0].pushBody).toContain('webster 1, webster 2 — no check-in for 12 min.');
    });
    it('recovered / reminder / stopped / flapping lines', () => {
        const msgs = formatTvAlertMessages({
            offline: [], flapping: [{ id: 'webster', countIn24h: 4 }], recovered: [{ id: 'webster', downMin: 36 }],
            reminders: [{ id: 'webster-2', ageMin: 190 }], stopped: [{ id: 'md-1', ageMin: 3000 }], locStats: {}, daytime: true,
        }, configs);
        expect(msgs.map((m) => m.kind)).toEqual(['flapping', 'recovered', 'reminder', 'stopped']);
        expect(msgs[0].text).toContain('webster 1 — offline again (4 times in 24 h)');
        expect(msgs[1].text).toBe('🟢 Back online and steady\n• webster 1 — was down about 36 min');
        expect(msgs[1].loud).toBe(false);
        expect(msgs[2].text).toBe('⏰ Still offline\n• webster 2 — 3 h 10 min');
        expect(msgs[3].text).toContain('front (Maryland Heights) has been offline for over 2 days');
    });
    it('toMs handles Timestamp-likes', () => {
        expect(toMs({ toMillis: () => 5 })).toBe(5);
        expect(toMs({ seconds: 2 })).toBe(2000);
        expect(toMs(null)).toBe(0);
        expect(toMs(7)).toBe(7);
        expect(toMs(Infinity)).toBe(0);
    });
    it('constants stay coherent', () => {
        expect(FRESH_MS).toBeLessThan(STALE_MS);
        expect(RECOVER_HOLD_MS).toBeLessThan(FLAP_HOLD_MS);
    });
});
