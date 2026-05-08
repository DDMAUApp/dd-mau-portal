// SauceLogBohBanner.jsx — pending sauce requests, embedded above the BOH
// tasks list. Same data source as SauceLog.jsx (ops/sauceLog_${location}).
// Cooks see "what FOH wants made today" without leaving the Tasks tab.
//
// Behavior:
//   • Subscribes to live sauce log doc.
//   • Shows pending requests sorted by urgency (today → next).
//   • Every BOH staff + admin can tap "Mark made".
//   • "Sauce log →" tap-target switches to the Sauce Log sub-tab for full UI.
//   • Hidden entirely when no pending requests.

import { useEffect, useState, useMemo } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, updateDoc } from 'firebase/firestore';
import { isAdmin } from '../data/staff';
import { SAUCE_URGENCY_BY_ID } from '../data/sauces';

export default function SauceLogBohBanner({ language, staffName, staffList, storeLocation, onOpenSauceLog }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [data, setData] = useState({ sauces: [], requests: {} });

    useEffect(() => {
        const unsub = onSnapshot(doc(db, 'ops', 'sauceLog_' + storeLocation), (snap) => {
            if (snap.exists()) {
                const d = snap.data();
                setData({ sauces: d.sauces || [], requests: d.requests || {} });
            } else {
                setData({ sauces: [], requests: {} });
            }
        }, (e) => console.warn('SauceLog banner subscribe error:', e));
        return unsub;
    }, [storeLocation]);

    const sauceById = useMemo(
        () => Object.fromEntries((data.sauces || []).map(s => [s.id, s])),
        [data.sauces]
    );

    const pending = useMemo(() => {
        return Object.entries(data.requests || {})
            .filter(([id, r]) => r && r.status === 'pending' && sauceById[id])
            .map(([id, r]) => ({ id, sauce: sauceById[id], req: r }))
            .sort((a, b) => {
                const ra = SAUCE_URGENCY_BY_ID[a.req.urgency]?.rank ?? 99;
                const rb = SAUCE_URGENCY_BY_ID[b.req.urgency]?.rank ?? 99;
                return ra - rb || (a.req.requestedAt || '').localeCompare(b.req.requestedAt || '');
            });
    }, [data.requests, sauceById]);

    if (pending.length === 0) return null;

    const markMade = async (sauceId) => {
        const cur = data.requests?.[sauceId];
        if (!cur) return;
        try {
            await updateDoc(doc(db, 'ops', 'sauceLog_' + storeLocation), {
                ['requests.' + sauceId]: {
                    ...cur,
                    status: 'made',
                    completedBy: staffName,
                    completedAt: new Date().toISOString(),
                },
                updatedAt: new Date().toISOString(),
            });
        } catch (e) { console.error('Banner mark made failed:', e); }
    };

    // Highest urgency on the panel — colors the border so a "today" request
    // catches the cook's eye even at a glance.
    const topUrgency = pending[0]?.req?.urgency;
    const borderClass =
        topUrgency === 'today'    ? 'border-red-400'    :
        topUrgency === 'tomorrow' ? 'border-yellow-400' :
                                    'border-green-400';

    return (
        <div className={`mb-3 rounded-xl border-2 ${borderClass} bg-white overflow-hidden shadow-sm`}>
            <div className="px-3 py-2 bg-gradient-to-r from-orange-50 to-white border-b border-gray-200 flex items-center justify-between">
                <div className="min-w-0">
                    <h4 className="text-sm font-bold text-orange-900 flex items-center gap-1">
                        🥢 {tx(`Sauces to make (${pending.length})`, `Salsas que hacer (${pending.length})`)}
                    </h4>
                    <p className="text-[10px] text-orange-700">
                        {tx('Requested by FOH. Tap "Made" when a batch is finished.',
                            'Pedidas por FOH. Toca "Hecho" cuando termines.')}
                    </p>
                </div>
                {onOpenSauceLog && (
                    <button onClick={onOpenSauceLog}
                        className="text-[11px] font-bold text-orange-700 hover:text-orange-900 underline flex-shrink-0 ml-2">
                        {tx('Open Sauce Log →', 'Ver Salsas →')}
                    </button>
                )}
            </div>
            <div className="divide-y divide-gray-100">
                {pending.map(({ id, sauce, req }) => {
                    const urg = SAUCE_URGENCY_BY_ID[req.urgency] || SAUCE_URGENCY_BY_ID.today;
                    const requestedAt = new Date(req.requestedAt);
                    const timeStr = isNaN(requestedAt) ? '' : requestedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    return (
                        <div key={id} className="px-3 py-2 flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-sm text-gray-800 flex items-center gap-1.5 flex-wrap">
                                    <span className="truncate">{isEs ? sauce.nameEs : sauce.nameEn}</span>
                                    <span className="font-bold text-blue-700">×{req.batches}</span>
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${urg.chipBg}`}>
                                        {urg.emoji} {isEs ? urg.labelEs : urg.labelEn}
                                    </span>
                                </div>
                                <div className="text-[10px] text-gray-500 mt-0.5">
                                    {tx(`from ${req.requestedBy?.split(' ')[0] || ''}`, `de ${req.requestedBy?.split(' ')[0] || ''}`)}
                                    {timeStr ? ` · ${timeStr}` : ''}
                                    {sauce.recipe ? ` · ${tx('recipe:', 'receta:')} ${sauce.recipe}` : ''}
                                </div>
                            </div>
                            <button onClick={() => markMade(id)}
                                className="text-[11px] px-2.5 py-1 rounded bg-green-600 text-white font-bold hover:bg-green-700 flex-shrink-0">
                                {tx('✓ Made', '✓ Hecho')}
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
