// Eighty6Dashboard — live "what we're out of" board for the kitchen.
//
// 2026-05-10 rewrite: ported from a heavy dark-mode standalone look
// (#111827 + red gradient — felt like a different app dropped into
// the v2 shell) to the v2 sage/white palette so it sits naturally
// inside AppShellV2. Visual language now matches the rest of the app:
//   • White card chrome with subtle border/shadow
//   • Color used semantically (red = critical 86, amber = low stock,
//     green = all-clear) — not as the page chrome
//   • Big readable count + timestamp at the top so cooks reading from
//     across the line can see status at a glance
//   • Each item card is a tap-friendly chip with status pill on the right
//
// Read-only at this view layer — admins toggle 86 status from the
// Operations page (Tasks / Inventory tabs).

import { useState, useEffect } from 'react';
import { onSnapshot, doc } from 'firebase/firestore';
import { db } from '../firebase';

export default function Eighty6Dashboard({ language, storeLocation }) {
    const [items, setItems] = useState([]);
    const [count, setCount] = useState(0);
    const [updatedAt, setUpdatedAt] = useState(null);
    // Attribution map written by scripts/sync-toast-86-attribution.mjs.
    // Shape: { [itemName]: { outBy: [staffName,...], outAt: Timestamp,
    //                        inBy: [...], inAt: Timestamp } }
    // Items that haven't been seen transition yet (legacy / from before
    // the sync script started running) won't have an entry — display
    // gracefully degrades to no name shown.
    const [attribution, setAttribution] = useState({});
    const [loading, setLoading] = useState(true);
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    useEffect(() => {
        const docKey = `86_${storeLocation === 'both' ? 'webster' : storeLocation}`;
        const unsubscribe = onSnapshot(doc(db, "ops", docKey), (docSnapshot) => {
            if (docSnapshot.exists()) {
                const data = docSnapshot.data();
                setItems(data.items || []);
                setCount(data.count || 0);
                setUpdatedAt(data.updatedAt || null);
                setAttribution(data.attribution || {});
            } else {
                setItems([]); setCount(0); setUpdatedAt(null); setAttribution({});
            }
            setLoading(false);
        }, () => setLoading(false));
        return () => unsubscribe();
    }, [storeLocation]);

    const formatTime = (ts) => {
        if (!ts) return "—";
        try {
            const d = ts.toDate ? ts.toDate() : new Date(ts);
            const now = new Date();
            const diffMin = Math.round((now - d) / 60000);
            if (diffMin < 1) return tx('just now', 'ahora');
            if (diffMin < 60) return tx(`${diffMin} min ago`, `hace ${diffMin} min`);
            return d.toLocaleTimeString(isEs ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' });
        } catch { return "—"; }
    };

    const locationLabel = storeLocation === 'maryland' ? tx('Maryland Heights', 'Maryland Heights')
                        : storeLocation === 'both'     ? tx('Both Locations', 'Ambas')
                        :                                tx('Webster Groves', 'Webster Groves');

    // Group items by status so 86'd shows above low-stock — cooks need
    // to see "what's totally out" first, then "what's running low".
    const out = items.filter(i => i.status === 'OUT_OF_STOCK');
    const low = items.filter(i => i.status !== 'OUT_OF_STOCK');

    return (
        <div className="space-y-4">
            {/* Header card — count is the headline. Big and tabular so it
                reads from across the kitchen. Color reflects state:
                green when fully stocked, red when anything's 86'd. */}
            <div className={`rounded-2xl shadow-card border overflow-hidden ${count > 0 ? 'bg-red-50 border-red-200' : 'bg-dd-green-50 border-dd-green/30'}`}>
                <div className="flex items-center justify-between gap-4 p-5">
                    <div className="min-w-0">
                        <div className={`text-[10px] font-bold uppercase tracking-widest ${count > 0 ? 'text-red-700' : 'text-dd-green-700'}`}>
                            🚫 {tx('86 Board', 'Tablero 86')}
                        </div>
                        <div className="text-sm font-bold text-dd-text mt-1 truncate">
                            {locationLabel} <span className="text-dd-text-2 font-semibold">— {tx('Out of stock', 'Agotados')}</span>
                        </div>
                        {updatedAt && (
                            <div className="text-[11px] text-dd-text-2 mt-1.5">
                                {tx('Updated', 'Actualizado')} {formatTime(updatedAt)}
                            </div>
                        )}
                    </div>
                    <div className="flex-shrink-0 text-center">
                        <div className={`text-5xl font-black tabular-nums leading-none ${count > 0 ? 'text-red-700' : 'text-dd-green-700'}`}>
                            {count}
                        </div>
                        <div className={`text-[10px] font-bold uppercase tracking-wider mt-1 ${count > 0 ? 'text-red-700' : 'text-dd-green-700'}`}>
                            {count === 1 ? tx('item', 'artículo') : tx('items', 'artículos')}
                        </div>
                    </div>
                </div>
            </div>

            {/* Body — empty state OR grouped lists */}
            {loading ? (
                <div className="space-y-2">
                    {[1,2,3].map(i => (
                        <div key={i} className="h-14 bg-white rounded-xl border border-dd-line animate-pulse" />
                    ))}
                </div>
            ) : items.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-2xl border border-dd-line shadow-card">
                    <div className="text-5xl mb-2">✅</div>
                    <p className="text-base font-bold text-dd-green-700">
                        {tx('All items available!', '¡Todo disponible!')}
                    </p>
                    <p className="text-xs text-dd-text-2 mt-1">
                        {tx("No 86'd items right now", 'No hay artículos 86 en este momento')}
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {out.length > 0 && (
                        <Section
                            title={tx('Out of stock', 'Agotados')}
                            count={out.length}
                            tone="danger"
                            items={out}
                            attribution={attribution}
                            formatTime={formatTime}
                            isEs={isEs}
                        />
                    )}
                    {low.length > 0 && (
                        <Section
                            title={tx('Running low', 'Casi agotados')}
                            count={low.length}
                            tone="warn"
                            items={low}
                            attribution={attribution}
                            formatTime={formatTime}
                            isEs={isEs}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

function Section({ title, count, tone, items, attribution = {}, formatTime, isEs }) {
    const accent = tone === 'danger' ? 'bg-red-500' : 'bg-amber-500';
    const pill   = tone === 'danger' ? 'bg-red-50 text-red-700 border-red-200'
                                     : 'bg-amber-50 text-amber-800 border-amber-200';
    const itemBg = tone === 'danger' ? 'bg-white border-red-200 hover:bg-red-50/50'
                                     : 'bg-white border-amber-200 hover:bg-amber-50/50';
    // Render the attribution line under an item name when present.
    // outBy may be a single name or a list (when multiple staff were
    // clocked in at the moment of the 86 transition). Show first names
    // for compactness when there are multiple; full name when only one.
    const renderAttribution = (itemName) => {
        const attr = attribution?.[itemName];
        if (!attr) return null;
        const list = Array.isArray(attr.outBy) ? attr.outBy : (attr.outBy ? [attr.outBy] : []);
        if (list.length === 0 && !attr.outAt) return null;
        const namesStr = list.length === 1
            ? list[0]
            : list.length > 1
                ? list.map(n => n.split(' ')[0]).join(' or ')
                : null;
        const timeStr = attr.outAt ? formatTime(attr.outAt) : null;
        return (
            <div className="text-[10px] text-dd-text-2 mt-0.5 italic">
                {namesStr && <>🙋 {isEs ? `Marcado por ${namesStr}` : `Marked by ${namesStr}`}</>}
                {namesStr && timeStr && <> · </>}
                {timeStr && <>{isEs ? 'a las' : 'at'} {timeStr}</>}
            </div>
        );
    };
    return (
        <div className="bg-white rounded-2xl border border-dd-line shadow-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-dd-line bg-dd-bg/40">
                <span className={`w-1 h-5 rounded-full ${accent}`} />
                <h3 className="text-sm font-bold text-dd-text flex-1">{title}</h3>
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${pill}`}>
                    {count}
                </span>
            </div>
            <ul className="divide-y divide-dd-line">
                {items.map((item, idx) => (
                    <li key={idx} className={`flex items-start justify-between gap-3 px-4 py-3 transition ${itemBg}`}>
                        <div className="min-w-0 flex-1">
                            <span className="font-bold text-dd-text truncate block">
                                {item.name}
                            </span>
                            {/* Attribution from sync-toast-86-attribution.mjs.
                                Shows who was clocked in at the moment of the
                                transition. When multiple staff overlap, lists
                                first names separated by "or" — manager can
                                pin down which one verbally. */}
                            {item.status === 'OUT_OF_STOCK' && renderAttribution(item.name)}
                        </div>
                        <span className={`flex-shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md border ${pill}`}>
                            {item.status === 'OUT_OF_STOCK'
                                ? (isEs ? '86' : "86'd")
                                : (isEs ? `Quedan ${item.quantity}` : `${item.quantity} left`)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
