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
//     • ops/labor_{loc}           — HomeV2 + MobileHome = 2
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
// API:
//   <AppDataProvider staffName="..." storeLocation="..."> { children }
//   const { notifications, shifts14, timeOff, eightySix, labor } = useAppData()
//
// Each value is null/[] until the first snapshot lands; consumers
// should tolerate the loading state. Lists are stable references when
// the underlying data is unchanged, so they're safe to use as
// useMemo / useEffect deps.

import { createContext, useContext, useState, useEffect, useMemo, useRef } from 'react';
import { db } from '../firebase';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { postEightySixToChat } from '../data/eightySixChat';

const AppDataContext = createContext(null);

export function AppDataProvider({ staffName, storeLocation, staffListReady = false, children }) {
    const [notifications, setNotifications] = useState([]);
    const [shifts14, setShifts14] = useState([]);
    const [timeOff, setTimeOff] = useState([]);
    const [eightySix, setEightySix] = useState({ webster: null, maryland: null });
    const [labor, setLabor] = useState({ webster: null, maryland: null });

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
        const q = query(collection(db, 'notifications'), where('forStaff', '==', staffName));
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            // Sort newest first (createdAt is a Firestore Timestamp)
            list.sort((a, b) => {
                const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
                const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
                return bt - at;
            });
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
            setEightySix(prev => ({ ...prev, webster: snap.exists() ? snap.data() : null }));
        }, (err) => console.warn('86_webster snapshot failed:', err));
        const unsubM = onSnapshot(doc(db, 'ops', '86_maryland'), (snap) => {
            setEightySix(prev => ({ ...prev, maryland: snap.exists() ? snap.data() : null }));
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

    // ops/labor_{loc} — same pattern.
    useEffect(() => {
        const unsubW = onSnapshot(doc(db, 'ops', 'labor_webster'), (snap) => {
            setLabor(prev => ({ ...prev, webster: snap.exists() ? snap.data() : null }));
        }, (err) => console.warn('labor_webster snapshot failed:', err));
        const unsubM = onSnapshot(doc(db, 'ops', 'labor_maryland'), (snap) => {
            setLabor(prev => ({ ...prev, maryland: snap.exists() ? snap.data() : null }));
        }, (err) => console.warn('labor_maryland snapshot failed:', err));
        return () => { unsubW(); unsubM(); };
    }, []);

    // Convenience: resolve per-location data once based on storeLocation.
    // For 'both' we return the webster value as the primary plus expose
    // the full pair under `byLoc` so admin views can show both.
    const value = useMemo(() => {
        const resolveLocDoc = (pair) => {
            if (storeLocation === 'maryland') return pair.maryland;
            return pair.webster;
        };
        // Chat unread = unread notifications of type chat_message OR
        // chat_mention. We compute it off the same notifications stream
        // (already filtered to forStaff === me) so the chat tile + nav
        // badge update instantly when a new chat message arrives, even
        // before the chat document's lastReadByName mark is written.
        const unreadChat = notifications.filter(n =>
            !n.read && (n.type === 'chat_message' || n.type === 'chat_mention')
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
        };
    }, [notifications, shifts14, timeOff, eightySix, labor, storeLocation]);

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
};

export function useAppData() {
    const ctx = useContext(AppDataContext);
    return ctx || EMPTY_VALUE;
}
