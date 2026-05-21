// TaskDisplay — kiosk view for the wall-mounted kitchen tablet.
//
// Mounted by App.jsx when the URL is ?display=walltasks&side=FOH|BOH
// &location=webster|maryland. Bypasses the PIN screen entirely (same
// pattern as ?tv= for menu displays — public, no PII, locked to one
// dataset by URL).
//
// Behavior:
//   • Big dark UI, readable from across the kitchen
//   • Tap any card to toggle done. The state writes through to the
//     same Firestore doc the admin panel reads, so updates from a
//     manager's phone reflect within ~1 second.
//   • Completion ring at top — quick glance from across the line.
//   • Auto-recovers from sleep: when document.visibilityState flips
//     to "visible", we force-rerender so the snapshot-driven items
//     refresh from cache + live channel.

import { useEffect, useMemo, useState } from 'react';
import {
    subscribeWallTasks,
    toggleWallTaskDone,
    resetWallTasks,
} from '../data/wallTasks';

// Validate URL params -> { location, side } | null. Defensive: if the
// URL has garbage we want to render a "configuration needed" screen
// rather than write to a junk Firestore path.
export function parseTaskDisplayMode(search) {
    try {
        const params = new URLSearchParams(search || '');
        if ((params.get('display') || '').toLowerCase() !== 'walltasks') return null;
        const side = (params.get('side') || '').toUpperCase();
        const location = (params.get('location') || '').toLowerCase();
        if (side !== 'FOH' && side !== 'BOH') return null;
        if (location !== 'webster' && location !== 'maryland') return null;
        return { side, location };
    } catch {
        return null;
    }
}

function fmtClock(d) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDateLine(d) {
    return d.toLocaleDateString([], {
        weekday: 'long', month: 'long', day: 'numeric',
    });
}

export default function TaskDisplay({ location, side }) {
    const [items, setItems] = useState([]);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => subscribeWallTasks(location, side, (data) => {
        setItems(data.items);
        setLoaded(true);
    }), [location, side]);

    // Wall clock ticks every 30s so the header stays current without
    // hammering the device (24/7 wall tablet — we don't want a 1Hz
    // setInterval ticking forever).
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 30 * 1000);
        return () => clearInterval(t);
    }, []);

    // Re-snap on visibility flip (tablet woke from sleep).
    useEffect(() => {
        function onVis() {
            if (document.visibilityState === 'visible') setNow(new Date());
        }
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);

    const done = items.filter((it) => it.done).length;
    const total = items.length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);

    // Color theme by side — FOH gets the dd-green accent, BOH gets a
    // warmer orange (matches the kitchen vibe + distinct at a glance).
    const accent = side === 'FOH' ? '#1f7a4d' : '#d97706';

    async function handleToggle(it) {
        try { await toggleWallTaskDone(location, side, it.id); }
        catch (err) { console.warn('toggleWallTaskDone failed:', err); }
    }

    const [confirmReset, setConfirmReset] = useState(false);
    async function handleReset() {
        try { await resetWallTasks(location, side); }
        catch (err) { console.warn('resetWallTasks failed:', err); }
        setConfirmReset(false);
    }

    const headerLeft = useMemo(() => `${side} · ${location === 'webster' ? 'Webster' : 'Maryland'}`, [side, location]);

    return (
        <div className="fixed inset-0 bg-[#111315] text-white overflow-y-auto select-none">
            {/* Header */}
            <div className="sticky top-0 z-10 bg-[#111315]/95 backdrop-blur border-b border-white/10 px-6 py-4 flex items-center gap-6">
                <div className="flex flex-col">
                    <div className="text-3xl font-black tracking-tight" style={{ color: accent }}>
                        {headerLeft}
                    </div>
                    <div className="text-sm text-white/60 mt-0.5">
                        {fmtDateLine(now)} · {fmtClock(now)}
                    </div>
                </div>
                <div className="flex-1" />
                {/* Completion ring */}
                <div className="flex items-center gap-3">
                    <div className="relative w-16 h-16">
                        <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90">
                            <circle cx="18" cy="18" r="15" fill="none" stroke="#2a2d31" strokeWidth="4" />
                            <circle cx="18" cy="18" r="15" fill="none" stroke={accent} strokeWidth="4"
                                strokeDasharray={`${(pct / 100) * 94.25} 94.25`}
                                strokeLinecap="round" />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center text-lg font-black">
                            {pct}%
                        </div>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-3xl font-black leading-none">
                            {done}<span className="text-white/40 text-lg font-bold">/{total}</span>
                        </span>
                        <span className="text-xs text-white/60 mt-1">done</span>
                    </div>
                </div>
                <button
                    onClick={() => (confirmReset ? handleReset() : setConfirmReset(true))}
                    onBlur={() => setConfirmReset(false)}
                    className={`px-4 py-3 rounded-xl text-sm font-bold transition active:scale-95 ${
                        confirmReset
                            ? 'bg-red-600 text-white'
                            : 'bg-white/10 text-white/70 hover:bg-white/20'
                    }`}>
                    {confirmReset ? '⚠ Tap again to reset' : '🔄 Reset'}
                </button>
            </div>

            {/* Body */}
            <div className="px-6 py-6 pb-12">
                {!loaded ? (
                    <div className="text-center text-white/50 text-lg py-24">Loading…</div>
                ) : total === 0 ? (
                    <div className="text-center text-white/50 py-24">
                        <div className="text-6xl mb-3">📋</div>
                        <p className="text-2xl font-bold mb-1">No tasks on this wall yet.</p>
                        <p className="text-sm text-white/40">
                            A manager can add tasks in Operations → 📺 Wall.
                        </p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {items.map((it) => {
                            const isDone = !!it.done;
                            return (
                                <button key={it.id}
                                    onClick={() => handleToggle(it)}
                                    className={`text-left p-5 rounded-2xl border-2 transition active:scale-[0.98] min-h-[100px] flex items-center gap-4 ${
                                        isDone
                                            ? 'bg-white/5 border-white/10 text-white/40'
                                            : 'bg-white/[0.07] border-white/15 hover:border-white/30 text-white'
                                    }`}>
                                    {/* Big check target */}
                                    <span className={`flex-shrink-0 w-12 h-12 rounded-xl flex items-center justify-center text-2xl ${
                                        isDone ? '' : 'border-2 border-white/30'
                                    }`}
                                        style={isDone ? { backgroundColor: accent } : undefined}>
                                        {isDone ? '✓' : ''}
                                    </span>
                                    <span className={`text-xl md:text-2xl font-bold leading-snug ${isDone ? 'line-through' : ''}`}>
                                        {it.task}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
