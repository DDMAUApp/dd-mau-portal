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
//   • laborHistory_{loc} (last 28d, SPLH) consolidated: Schedule + Labor
//     Dashboard each pulled ~1,500 docs on cold mount. Schedule's
//     localStorage cache + 'both'→webster fallback are preserved here.
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

import { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react';
import { db } from '../firebase';
import { collection, doc, onSnapshot, query, where, orderBy, limit } from 'firebase/firestore';
import { postEightySixToChat } from '../data/eightySixChat';
import { canViewLabor } from '../data/staff';

const AppDataContext = createContext(null);

// laborHistory cache constants. Hoisted so the hydrate-from-cache step
// (initial useState lazy initializer) and the live-listener writeback
// stay in sync.
const SPLH_CACHE_PREFIX = 'ddmau:splh:'; // suffixed by location
const SPLH_CACHE_TTL_MS = 30 * 60 * 1000;
const splhCacheKey = (loc) => `${SPLH_CACHE_PREFIX}${loc}`;
const hydrateSplhFromCache = (loc) => {
    try {
        const raw = localStorage.getItem(splhCacheKey(loc));
        if (!raw) return [];
        const cached = JSON.parse(raw);
        if (!cached?.savedAt || !Array.isArray(cached.items)) return [];
        if (Date.now() - cached.savedAt >= SPLH_CACHE_TTL_MS) return [];
        return cached.items;
    } catch {
        return [];
    }
};

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
    // laborHistory: last 28 days of laborHistory_{loc} per location,
    // used by Schedule's SPLH advisor + LaborDashboard's historical
    // grid. Hydrated from localStorage on initial mount so cold-start
    // renders don't flash empty while Firestore is still pending.
    const [laborHistory, setLaborHistory] = useState(() => ({
        webster:  hydrateSplhFromCache('webster'),
        maryland: hydrateSplhFromCache('maryland'),
    }));

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
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setNotifications(list);
        }, (err) => console.warn('notifications snapshot failed:', err));
        return () => unsub();
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
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setShifts14(list);
            writeHomeCache('shifts14', list);
        }, (err) => console.warn('shifts snapshot failed:', err));
        return () => unsub();
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
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setTimeOff(list);
        }, (err) => console.warn('time_off snapshot failed:', err));
        return () => unsub();
    }, []);

    // ops/86_{loc} — one doc per location. We subscribe to BOTH locations
    // unconditionally (only two docs, both small) so a 'both'-mode admin
    // doesn't need to swap subscriptions on location toggle.
    useEffect(() => {
        const unsubW = onSnapshot(doc(db, 'ops', '86_webster'), (snap) => {
            setEightySix(prev => {
                const next = { ...prev, webster: snap.exists() ? snap.data() : null };
                writeHomeCache('eightySix', next);
                return next;
            });
        }, (err) => console.warn('86_webster snapshot failed:', err));
        const unsubM = onSnapshot(doc(db, 'ops', '86_maryland'), (snap) => {
            setEightySix(prev => {
                const next = { ...prev, maryland: snap.exists() ? snap.data() : null };
                writeHomeCache('eightySix', next);
                return next;
            });
        }, (err) => console.warn('86_maryland snapshot failed:', err));
        return () => { unsubW(); unsubM(); };
    }, []);

    // ── 86 → chat auto-post (transition detector) ───────────────────
    // Diff each 86 snapshot against the prior state. New "out" item →
    // post 🚫 alert. Item removed from "out" array → post ✅ back-in-stock.
    // postEightySixToChat() uses deterministic message IDs so multiple
    // connected clients racing the same transition only write one doc.
    //
    // Skipped on the FIRST snapshot for each location (no prior state to
    // diff). After that, every change runs the diff. Memo refs hold
    // prior state so unrelated re-renders don't re-fire.
    const prev86Ref = useRef({ webster: null, maryland: null });
    useEffect(() => {
        // Skip until we have a staff record (cold launches shouldn't
        // post 86 history they're seeing for the first time).
        // 2026-05-28 Audit #2 — also gate on staffListReady so we
        // don't post 86 alerts attributed to a stale-from-sessionStorage
        // identity that may no longer be valid.
        if (!staffName) return;
        if (!staffListReady) return;
        for (const loc of ['webster', 'maryland']) {
            const cur = eightySix[loc];
            const prev = prev86Ref.current[loc];
            if (cur && prev) {
                const prevOut = new Set((prev.items || [])
                    .filter(i => i?.status === 'out' || i?.outOfStock === true)
                    .map(i => i?.name || i?.itemName).filter(Boolean));
                const curOut = new Set((cur.items || [])
                    .filter(i => i?.status === 'out' || i?.outOfStock === true)
                    .map(i => i?.name || i?.itemName).filter(Boolean));
                // Newly out
                for (const name of curOut) {
                    if (!prevOut.has(name)) {
                        postEightySixToChat({
                            location: loc,
                            itemName: name,
                            transition: 'out',
                            actorName: staffName,
                        }).catch(() => {});
                    }
                }
                // Newly back in
                for (const name of prevOut) {
                    if (!curOut.has(name)) {
                        postEightySixToChat({
                            location: loc,
                            itemName: name,
                            transition: 'in',
                            actorName: staffName,
                        }).catch(() => {});
                    }
                }
            }
            prev86Ref.current[loc] = cur;
        }
    }, [eightySix, staffName, staffListReady]);

    // ops/labor_{loc} — gated on canSeeLabor (see above). Re-subscribes when
    // labor access is granted, tears down + clears when revoked.
    useEffect(() => {
        if (!canSeeLabor) { setLabor({ webster: null, maryland: null }); return undefined; }
        const unsubW = onSnapshot(doc(db, 'ops', 'labor_webster'), (snap) => {
            setLabor(prev => ({ ...prev, webster: snap.exists() ? snap.data() : null }));
        }, (err) => console.warn('labor_webster snapshot failed:', err));
        const unsubM = onSnapshot(doc(db, 'ops', 'labor_maryland'), (snap) => {
            setLabor(prev => ({ ...prev, maryland: snap.exists() ? snap.data() : null }));
        }, (err) => console.warn('labor_maryland snapshot failed:', err));
        return () => { unsubW(); unsubM(); };
    }, [canSeeLabor]);

    // laborHistory_{loc} — last 28 days of hourly snapshots used for SPLH
    // (sales per labor hour) analysis. Subscribes for whichever
    // location(s) any consumer might need based on the active
    // storeLocation. 'both' mode pulls webster (matches the prior
    // Schedule.jsx fallback — there's no global "both" view of SPLH;
    // managers eyeballing it pick a side mentally).
    //
    // 2026-06-02 consolidation: this lived in BOTH Schedule.jsx and
    // LaborDashboard.jsx as parallel listeners. Each cold mount pulled
    // ~1,500 docs per consumer. Now subscribed once here; both consumers
    // read from useAppData().laborHistory / .laborHistoryByLoc.
    //
    // Cache strategy (preserved from Schedule's original): localStorage
    // mirror with 30-min TTL hydrates the initial state synchronously,
    // and every fresh snapshot rewrites the cache. Schedule's "fast
    // path" perception of an already-warm advisor on tab return is
    // preserved.
    //
    // We re-subscribe when storeLocation changes ONLY to potentially
    // add the second location — we never tear down the active
    // subscription. (For two locations the cost is trivial; this is a
    // future-proofing comment for if a third location is added.) For
    // now we subscribe to both unconditionally — matches the eightySix /
    // labor pattern above and means an admin flipping the location
    // toggle sees no flicker.
    // 2026-06-14 perf: (1) dep array is now [canSeeLabor] (was []) so a live
    // "Labor %" grant actually starts this listener — matching the labor
    // effect above; previously it never re-ran. (2) The ~3k-doc laborHistory
    // pull is DEFERRED to idle: it's consumed only by Schedule + LaborDashboard
    // (never the home screen), so attaching it after first paint keeps home
    // from competing with it on the WebView's connection. The 30-min cache
    // already hydrated the initial state synchronously, so on Schedule/Labor
    // the advisor still shows warm data instantly while the live listener
    // attaches a beat later.
    useEffect(() => {
        if (!canSeeLabor) { setLaborHistory({ webster: [], maryland: [] }); return undefined; }
        let unsubW = null, unsubM = null, cancelled = false;
        const subscribeLoc = (loc) => {
            const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
            const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
            return onSnapshot(
                query(collection(db, `laborHistory_${loc}`), where('date', '>=', cutoffKey)),
                (snap) => {
                    const arr = [];
                    snap.forEach(d => arr.push(d.data()));
                    setLaborHistory(prev => ({ ...prev, [loc]: arr }));
                    try {
                        localStorage.setItem(splhCacheKey(loc), JSON.stringify({ items: arr, savedAt: Date.now() }));
                    } catch { /* storage full — non-fatal */ }
                },
                (err) => console.warn(`laborHistory_${loc} snapshot failed:`, err),
            );
        };
        const start = () => {
            if (cancelled) return;
            unsubW = subscribeLoc('webster');
            unsubM = subscribeLoc('maryland');
        };
        const hasIC = typeof requestIdleCallback === 'function';
        const idleId = hasIC ? requestIdleCallback(start, { timeout: 4000 }) : setTimeout(start, 1200);
        return () => {
            cancelled = true;
            if (hasIC) { try { cancelIdleCallback(idleId); } catch { /* noop */ } }
            else clearTimeout(idleId);
            if (unsubW) unsubW();
            if (unsubM) unsubM();
        };
    }, [canSeeLabor]);

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
