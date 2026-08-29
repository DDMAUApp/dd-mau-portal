// AppDataContext — shared Firestore subscriptions for the v2 shell.
//
// Why this exists:
//   Before this, the same Firestore data was independently subscribed
//   by 4-6 components mounted simultaneously on a single page:
//     • notifications (per-user)  — Header + MobileBottomNav + Sidebar
//                                    + NotificationsDrawer + MobileHome
//                                    + Schedule = 6 listeners
//     • shifts (next 14 days)     — MobileBottomNav + HomeV2 + Sidebar
//                                    + MobileHome = 4 listeners
//     • ops/86_{loc}              — MobileBottomNav + HomeV2 + Sidebar
//                                    + MobileHome = 4 listeners
//     • time_off (FULL collection) — HomeV2 + Sidebar + MobileHome = 3
//     • ops/labor_{loc}           — HomeV2 + MobileHome + LaborDashboard
//                                    + Operations = 4 listeners (pre 2026-06-02)
//     • laborHistory_{loc} (28d)  — LaborDashboard + Schedule = 2 listeners
//                                    (pre 2026-06-02)
//
//   Every Firestore doc change replayed each listener individually,
//   producing 4-6× the network traffic and 4-6× the React re-render
//   pressure. On mobile this manifests as scroll judder and slow tab
//   switches.
//
// This provider mounts ONCE inside AppShellV2 and exposes the same data
// to every consumer via useAppData(). One listener per stream → one
// re-render per data change → ~60-70% fewer Firestore reads.
//
// 2026-06-02 consolidation:
//   • ops/labor_{loc} consolidated: LaborDashboard + Operations were
//     each opening their own onSnapshot in parallel with the context's
//     listener. As a side bonus, those direct subscriptions broke
//     silently in 'both' mode (queried the literal doc ops/labor_both,
//     which does not exist). The context resolves 'both' → webster
//     primary the same way the home tiles already did.
//   • laborHistory_{loc} (last 28d, SPLH): consolidated here 2026-06-02,
//     then REMOVED 2026-08-15 (42k resident docs taxed every Firestore emit
//     app-wide; see the P0-1 note below). Context still exposes the keys.
//
// API:
//   <AppDataProvider staffName="..." storeLocation="..."> { children }
//   const {
//       notifications, shifts14, timeOff,
//       eightySix, eightySixByLoc,
//       labor, laborByLoc,
//       laborHistory, laborHistoryByLoc,
//   } = useAppData()
//
// Each value is null/[] until the first snapshot lands; consumers
// should tolerate the loading state. Lists are stable references when
// the underlying data is unchanged, so they're safe to use as
// useMemo / useEffect deps.

import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, doc, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { canViewLabor } from '../data/staff';
// 2026-08-29 (ST3): every always-on stream below is wrapped in
// resilientSnapshot — an errored onSnapshot is DEAD (the SDK never
// re-fires it), so one transport blip used to silently kill e.g. the
// notifications badge or the 86 tiles until a full reload. The wrapper
// re-attaches with backoff; each effect's cleanup calls the returned
// stop(), which also cancels any pending retry timer.
import { resilientSnapshot } from '../data/firestoreRevive';

const AppDataContext = createContext(null);

// ── laborHistory (REMOVED 2026-08-15 — chat perf forensics P0-1) ─────
// This provider used to hold TWO always-on listeners on
// `laborHistory_{webster,maryland}` with a 28-day cutoff, plus a
// localStorage mirror of every row. The comments said "~1,500 docs";
// the scraper actually writes a row every ~2 min, 24/7, so each listener
// held ~21,300 docs (42,561 total, measured live) and the mirror was
// 7.7 MB of JSON parsed at boot and re-serialized on every new row.
//
// Why that made CHAT laggy for every manager/admin: the Firestore SDK
// re-runs limbo detection over EVERY doc in EVERY active view on EVERY
// emit (each local write, its server echo, and its ack — see
// View.applyChanges → updateLimboDocuments in @firebase/firestore).
// With 42k docs resident that was ~110 ms of main-thread work per emit
// on an M-series Mac (profiled: 92% of typing-time CPU), ×3 per typing
// heartbeat / send / read-marker — 300–500 ms stalls per keystroke burst,
// worse on phones. And `aggregateSplh` needs `totalHours`, which NO
// laborHistory row carries, so the 42k docs produced an EMPTY grid: all
// cost, zero value.
//
// The consumers (Schedule SPLH advisor, LaborDashboard SPLH grid) keep
// the same context API and simply see [] — the exact result they were
// already computing. When SPLH is rebuilt it must be a server-side
// hourly rollup (~28 docs/location) that includes labor hours; never
// re-add a raw-row listener here. The old mirror keys are purged below
// so devices reclaim the storage.
const SPLH_CACHE_PREFIX = 'ddmau:splh:'; // legacy key prefix (purge only)
const EMPTY_LABOR_HISTORY = Object.freeze({ webster: [], maryland: [] });
try {
    if (typeof localStorage !== 'undefined') {
        for (const loc of ['webster', 'maryland']) localStorage.removeItem(`${SPLH_CACHE_PREFIX}${loc}`);
    }
} catch { /* storage unavailable — nothing to purge */ }

// Generic localStorage cache for the HOME-TILE data (86 board + the
// 14-day shift window). Andrew 2026-06-14: the home screen's 86-count
// tile and "today's shift" hero rendered as empty skeletons on every
// cold launch until Firestore replied — the two most-glanced numbers on
// the page. Mirroring each snapshot to localStorage and seeding state
// from it lets those tiles paint last-known values instantly, then the
// live snapshot corrects them within ~1s. 6h TTL keeps a long-idle
// device from showing very stale numbers before the refresh lands.
const HOME_CACHE_PREFIX = 'ddmau:homecache:';
const HOME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const readHomeCache = (key, fallback) => {
    try {
        const raw = localStorage.getItem(HOME_CACHE_PREFIX + key);
        if (!raw) return fallback;
        const c = JSON.parse(raw);
        if (!c?.savedAt) return fallback;
        if (Date.now() - c.savedAt >= HOME_CACHE_TTL_MS) return fallback;
        return c.data;
    } catch { return fallback; }
};
const writeHomeCache = (key, data) => {
    try { localStorage.setItem(HOME_CACHE_PREFIX + key, JSON.stringify({ data, savedAt: Date.now() })); } catch { /* storage full — non-fatal */ }
};

export function AppDataProvider({ staffName, storeLocation, staffList = [], staffListReady = false, children }) {
    const [notifications, setNotifications] = useState([]);
    // shifts14 + eightySix seed from the home-tile cache so the "today's
    // shift" hero and the 86-count tile paint instantly on cold launch
    // instead of flashing empty skeletons; the live snapshot corrects them
    // within ~1s. (Andrew 2026-06-14 — "home takes a few seconds.")
    const [shifts14, setShifts14] = useState(() => readHomeCache('shifts14', []));
    const [timeOff, setTimeOff] = useState([]);
    const [eightySix, setEightySix] = useState(() => readHomeCache('eightySix', { webster: null, maryland: null }));
    const [labor, setLabor] = useState({ webster: null, maryland: null });
    // laborHistory: intentionally a frozen empty pair — see the P0-1 note at
    // the top of this file. Kept in the context so Schedule / LaborDashboard
    // need no changes; both already treat [] as "no SPLH data".
    const laborHistory = EMPTY_LABOR_HISTORY;

    // Labor data is gated to staff WITH labor access — the same `canViewLabor`
    // switch the labor UI already uses (set by the Admin Panel "Labor %"
    // toggle). Gating the LISTENERS (not just the display) means line cooks /
    // cashiers stop pulling ~3k laborHistory docs on every cold open. Because
    // `staffList` is live, when an admin flips someone's "Labor %" ON, this
    // flips true, the labor effects (which depend on it) re-run, and their
    // labor data subscribes with NO reload. Managers/owners default on;
    // everyone else defaults off. canViewLabor(undefined) === false, so a
    // not-yet-loaded staffName is safe (subscribes once the list lands).
    const canSeeLabor = useMemo(
        () => canViewLabor((staffList || []).find(s => s.name === staffName)),
        [staffList, staffName],
    );

    // notifications — per user. Skipped if no staffName signed in.
    //
    // 2026-05-28 Audit #2 — gated on staffListReady. Before this, the
    // query could fire with a staffName restored from sessionStorage
    // before the live /config/staff snapshot landed. If the user was
    // renamed/deactivated since their last session, the where() clause
    // matched nothing, the badge count showed 0, and the user thought
    // notifications were broken. Waiting on staffListReady eliminates
    // the wrong-identity window.
    useEffect(() => {
        if (!staffName) return;
        if (!staffListReady) return;
        // PERF, 2026-05-30: bounded at 100 + ordered server-side. Before
        // this, the listener pulled every notification ever addressed to
        // this staffer — years of history streamed on every cold mount.
        // 100 is comfortably above the unread-only count the badge needs
        // AND large enough that the drawer's "show all" mode still feels
        // populated; older entries can be loaded with a Load More cursor
        // when/if anyone asks for it.
        const q = query(
            collection(db, 'notifications'),
            where('forStaff', '==', staffName),
            orderBy('createdAt', 'desc'),
            limit(100),
        );
        const stop = resilientSnapshot('notifications', (onHealthy, onError) => onSnapshot(q, (snap) => {
            onHealthy();
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setNotifications(list);
        }, onError));
        return () => stop();
    }, [staffName, staffListReady]);

    // shifts — next 14 days, date-bounded query (Firestore-side, not
    // client-side filtering).
    //
    // FIX (2026-05-14): re-subscribe daily so the `today` cutoff actually
    // rolls over. Before, the query was bound to whatever `today` was
    // at provider mount, so a device left open overnight kept showing
    // yesterday's window — MobileHome's "today's shift" would miss the
    // morning shift until manual refresh. We track `dayKey` in state
    // and bump it (a) on visibility change (most common — phone wakes
    // up the next morning) and (b) on a 6-hour heartbeat for the rare
    // device that stays unlocked all night.
    const [dayKey, setDayKey] = useState(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    });
    useEffect(() => {
        const maybeRoll = () => {
            const d = new Date();
            const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            setDayKey(prev => prev === next ? prev : next);
        };
        const onVis = () => { if (document.visibilityState === 'visible') maybeRoll(); };
        document.addEventListener('visibilitychange', onVis);
        const interval = setInterval(maybeRoll, 6 * 60 * 60 * 1000);
        return () => {
            document.removeEventListener('visibilitychange', onVis);
            clearInterval(interval);
        };
    }, []);
    useEffect(() => {
        const today = new Date();
        const cutoff = new Date(today);
        cutoff.setDate(cutoff.getDate() + 14);
        const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const q = query(
            collection(db, 'shifts'),
            where('date', '>=', fmt(today)),
            where('date', '<', fmt(cutoff))
        );
        // Composes with the daily dayKey re-subscribe: rollover re-runs this
        // effect, and the cleanup's stop() cancels any pending retry from the
        // outgoing window's listener.
        const stop = resilientSnapshot('shifts14', (onHealthy, onError) => onSnapshot(q, (snap) => {
            onHealthy();
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setShifts14(list);
            writeHomeCache('shifts14', list);
        }, onError));
        return () => stop();
    }, [dayKey]);

    // time_off — scoped to the last 180 days + future.
    // 2026-05-24 audit fix: was loading the ENTIRE collection on every
    // v2 page mount. After 12 months × 30 staff that's the per-device
    // daily read tax. All downstream consumers (Schedule, MobileHome,
    // ScheduleAvailability) already filter by date themselves; the
    // older history is only used by an "old PTO" admin view which can
    // do its own one-shot query.
    //
    // Field is `startDate` — string in 'YYYY-MM-DD' format, so lexical
    // comparison works as date comparison.
    useEffect(() => {
        // 2026-05-24 audit fix: was using toISOString().slice(0,10)
        // which renders UTC, but PTO startDate is stored in Central
        // time (YYYY-MM-DD local). After 6pm Central (00:00 UTC) the
        // cutoff drifts ±1 day depending on DST, causing PTO right at
        // the 180-day boundary to flicker in and out of the
        // subscription. Build the cutoff string from local date
        // getters to match the stored field's timezone.
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 180);
        const yyyy = cutoff.getFullYear();
        const mm = String(cutoff.getMonth() + 1).padStart(2, '0');
        const dd = String(cutoff.getDate()).padStart(2, '0');
        const cutoffStr = `${yyyy}-${mm}-${dd}`;
        const q = query(
            collection(db, 'time_off'),
            where('startDate', '>=', cutoffStr),
        );
        const stop = resilientSnapshot('time_off', (onHealthy, onError) => onSnapshot(q, (snap) => {
            onHealthy();
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setTimeOff(list);
        }, onError));
        return () => stop();
    }, []);

    // ops/86_{loc} — one doc per location. We subscribe to BOTH locations
    // unconditionally (only two docs, both small) so a 'both'-mode admin
    // doesn't need to swap subscriptions on location toggle.
    useEffect(() => {
        // Each doc listener gets its OWN resilient wrapper so one location's
        // error/retry cycle can't tear down the other's healthy stream.
        const stopW = resilientSnapshot('86_webster', (onHealthy, onError) => onSnapshot(doc(db, 'ops', '86_webster'), (snap) => {
            onHealthy();
            setEightySix(prev => {
                const next = { ...prev, webster: snap.exists() ? snap.data() : null };
                writeHomeCache('eightySix', next);
                return next;
            });
        }, onError));
        const stopM = resilientSnapshot('86_maryland', (onHealthy, onError) => onSnapshot(doc(db, 'ops', '86_maryland'), (snap) => {
            onHealthy();
            setEightySix(prev => {
                const next = { ...prev, maryland: snap.exists() ? snap.data() : null };
                writeHomeCache('eightySix', next);
                return next;
            });
        }, onError));
        return () => { stopW(); stopM(); };
    }, []);

    // NOTE (2026-07-26 audit): the client-side "86 → chat auto-post"
    // transition detector that used to live here was DELETED. Its chat
    // write was removed from eightySixChat.js back in May (Andrew opted
    // out of auto-channels), it never passed notifyRecipients (so the
    // FCM fan-out loop was a no-op), and the server-side Cloud Function
    // trigger on ops/86_{loc} already diffs transitions and pushes.
    // All it did in practice was write one duplicate /audit row per
    // CONNECTED CLIENT, attributed to whoever happened to be looking.

    // ops/labor_{loc} — gated on canSeeLabor (see above). Re-subscribes when
    // labor access is granted, tears down + clears when revoked.
    useEffect(() => {
        if (!canSeeLabor) { setLabor({ webster: null, maryland: null }); return undefined; }
        const stopW = resilientSnapshot('labor_webster', (onHealthy, onError) => onSnapshot(doc(db, 'ops', 'labor_webster'), (snap) => {
            onHealthy();
            setLabor(prev => ({ ...prev, webster: snap.exists() ? snap.data() : null }));
        }, onError));
        const stopM = resilientSnapshot('labor_maryland', (onHealthy, onError) => onSnapshot(doc(db, 'ops', 'labor_maryland'), (snap) => {
            onHealthy();
            setLabor(prev => ({ ...prev, maryland: snap.exists() ? snap.data() : null }));
        }, onError));
        return () => { stopW(); stopM(); };
    }, [canSeeLabor]);

    // laborHistory_{loc} listeners: REMOVED 2026-08-15 (P0-1). See the note
    // at the top of this file. Do not re-add a raw-row listener here.

    // Convenience: resolve per-location data once based on storeLocation.
    // For 'both' we return the webster value as the primary plus expose
    // the full pair under `byLoc` so admin views can show both.
    const value = useMemo(() => {
        const resolveLocDoc = (pair) => {
            if (storeLocation === 'maryland') return pair.maryland;
            return pair.webster;
        };
        // Chat unread = unread notifications of type chat_message OR
        // chat_mention OR chat_reply. We compute it off the same
        // notifications stream (already filtered to forStaff === me)
        // so the chat tile + nav badge update instantly when a new
        // chat message arrives, even before the chat document's
        // lastReadByName mark is written.
        //
        // 2026-06-02 — Andrew "if i have a new message in chat i
        // want a 1 like 86 board has." Verified the badge wiring on
        // the mobile chat Tile was already in place; the gap was
        // that chat_reply (added in task #139) was missing from this
        // filter. Reply notifications now bump the badge too.
        const unreadChat = notifications.filter(n =>
            !n.read && (n.type === 'chat_message' || n.type === 'chat_mention' || n.type === 'chat_reply')
        ).length;
        return {
            notifications,
            unreadCount: notifications.filter(n => !n.read).length,
            unreadChat,
            shifts14,
            timeOff,
            eightySix: resolveLocDoc(eightySix),
            eightySixByLoc: eightySix,
            labor: resolveLocDoc(labor),
            laborByLoc: labor,
            laborHistory: resolveLocDoc(laborHistory) || [],
            laborHistoryByLoc: laborHistory,
        };
    }, [notifications, shifts14, timeOff, eightySix, labor, laborHistory, storeLocation]);

    return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

// Hook. Components that mount outside the provider get an empty/safe
// default (so a v1 component, the public Apply page, or the
// OnboardingPortal can't crash when calling useAppData()).
const EMPTY_VALUE = {
    notifications: [],
    unreadCount: 0,
    unreadChat: 0,
    shifts14: [],
    timeOff: [],
    eightySix: null,
    eightySixByLoc: { webster: null, maryland: null },
    labor: null,
    laborByLoc: { webster: null, maryland: null },
    laborHistory: [],
    laborHistoryByLoc: { webster: [], maryland: [] },
};

export function useAppData() {
    const ctx = useContext(AppDataContext);
    return ctx || EMPTY_VALUE;
}
