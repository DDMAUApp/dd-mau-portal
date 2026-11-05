// Admin → Staff → Test login activity. What people signed in on a test login did:
// one row per sign-in, opening to the pages and taps in order. Written by
// src/data/testActivity.js. Only page names and button labels are ever recorded.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { db } from '../firebase';
import { TEST_ACTIVITY_COLLECTION } from '../data/testActivity';

const MAX_DOCS = 500;

// Batches → one entry per sign-in, newest first. Pure.
export function groupSessions(batches) {
    const by = new Map();
    for (const b of Array.isArray(batches) ? batches : []) {
        if (!b?.session) continue;
        const s = by.get(b.session) || { session: b.session, staffName: b.staffName, deviceId: b.deviceId, platform: b.platform, screen: b.screen, appVersion: b.appVersion, startedAt: b.startedAt || 0, events: [] };
        s.events.push(...(Array.isArray(b.events) ? b.events : []));
        by.set(b.session, s);
    }
    return [...by.values()].map((s) => {
        s.events.sort((a, b) => (a.at || 0) - (b.at || 0));
        const last = s.events.length ? s.events[s.events.length - 1].at : s.startedAt;
        const pages = s.events.filter(e => e.kind === 'page').map(e => e.tab);
        return { ...s, endedAt: last, minutes: Math.max(0, Math.round((last - s.startedAt) / 60000)), pages: [...new Set(pages)], taps: s.events.filter(e => e.kind === 'tap').length };
    }).sort((a, b) => b.startedAt - a.startedAt);
}

export default function TestActivityLog({ language = 'en' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [rows, setRows] = useState(null);
    const [open, setOpen] = useState(null);
    const [failed, setFailed] = useState(false);
    const load = useCallback(async () => {
        setFailed(false);
        try {
            const snap = await getDocs(query(collection(db, TEST_ACTIVITY_COLLECTION), orderBy('at', 'desc'), limit(MAX_DOCS)));
            setRows(snap.docs.map(d => d.data()));
        } catch (e) {
            console.warn('test activity load failed', e?.code);
            setFailed(true);
            setRows([]);
        }
    }, []);
    useEffect(() => { load(); }, [load]);
    const sessions = useMemo(() => groupSessions(rows), [rows]);
    const when = (ms) => (ms ? new Date(ms).toLocaleString(isEs ? 'es-US' : 'en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
    const time = (ms) => new Date(ms).toLocaleTimeString(isEs ? 'es-US' : 'en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', second: '2-digit' });

    return (
        <div className="glass-card p-4 space-y-3">
            <div className="flex items-center gap-2">
                <h3 className="flex-1 font-bold">🧪 {tx('Test login activity', 'Actividad del inicio de prueba')}</h3>
                <button onClick={load} className="px-3 py-1.5 rounded-lg bg-gray-200 text-xs font-bold">{tx('Refresh', 'Actualizar')}</button>
            </div>
            <p className="text-xs text-gray-600">{tx(
                'Pages opened and buttons tapped by anyone on a test login. Nothing they type is recorded. Started Nov 5, 2026; nothing earlier exists.',
                'Páginas abiertas y botones tocados en un inicio de prueba. No se guarda nada de lo que escriben. Empezó el 5 de nov. de 2026.',
            )}</p>
            {rows === null && <p className="text-sm text-gray-500">{tx('Loading…', 'Cargando…')}</p>}
            {failed && <p className="text-sm text-red-700">{tx('Could not load. Try Refresh.', 'No se pudo cargar.')}</p>}
            {rows && !failed && (
                <p className="text-sm font-bold">{tx(`${sessions.length} sign-in${sessions.length === 1 ? '' : 's'}`, `${sessions.length} inicio${sessions.length === 1 ? '' : 's'} de sesión`)}</p>
            )}
            {sessions.map((s) => (
                <div key={s.session} className="rounded-xl border border-gray-200 bg-white">
                    <button onClick={() => setOpen(o => (o === s.session ? null : s.session))} aria-expanded={open === s.session} className="w-full text-left p-3">
                        <span className="block text-sm font-bold">{s.staffName} · {when(s.startedAt)}</span>
                        <span className="block text-xs text-gray-600">
                            {tx(`${s.minutes} min · ${s.pages.length} pages · ${s.taps} taps`, `${s.minutes} min · ${s.pages.length} páginas · ${s.taps} toques`)}
                            {` · ${s.platform || ''} ${s.screen || ''} · ${tx('device', 'equipo')} ${String(s.deviceId || '').slice(-6)} · v${String(s.appVersion || '').split(' ')[0]}`}
                        </span>
                        {s.pages.length > 0 && <span className="block text-xs text-gray-800 mt-1">{s.pages.join(' → ')}</span>}
                    </button>
                    {open === s.session && (
                        <ol className="border-t border-gray-100 p-3 space-y-0.5 max-h-96 overflow-auto">
                            {s.events.map((e, i) => (
                                <li key={i} className="text-xs">
                                    <span className="text-gray-500 tabular-nums">{time(e.at)}</span>{' '}
                                    {e.kind === 'start' && <b>{tx('Signed in', 'Inició sesión')}</b>}
                                    {e.kind === 'page' && <b>📄 {e.tab}</b>}
                                    {e.kind === 'tap' && <span>👆 {e.label}{e.tab ? <span className="text-gray-400"> ({e.tab})</span> : null}</span>}
                                </li>
                            ))}
                        </ol>
                    )}
                </div>
            ))}
        </div>
    );
}
