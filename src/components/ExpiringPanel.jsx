// ExpiringPanel — "what dies today?" morning walk-in check + waste log.
// (2026-07-26, Andrew features #7/#8 — the Squadle/DateCodeGenie pattern.)
//
// Every successful sticker print logs a row to /sticker_prints (see
// _printPrepLabelImpl). This modal groups the recent rows by use-by:
// EXPIRED / TODAY / TOMORROW. Tapping "Discarded" stamps the row and
// writes a /waste_log entry, so the footer can show this week's waste.
//
// Deliberately available to ALL staff — the cook tossing the pan is the
// one who should tap Discarded, not a manager later.
import { useEffect, useMemo, useState } from 'react';
import { X, CalendarClock, Trash2 } from 'lucide-react';
import ModalPortal from './ModalPortal';
import { toast } from '../toast';
import { db } from '../firebase';
import {
    collection, query, where, orderBy, limit, onSnapshot,
    doc, updateDoc, addDoc, serverTimestamp,
} from 'firebase/firestore';

const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export default function ExpiringPanel({ location = 'webster', staffName, language = 'en', onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const loc = location === 'both' ? 'webster' : location;

    const [rows, setRows] = useState(null);      // sticker_prints in the window
    const [waste, setWaste] = useState([]);      // recent waste_log entries
    const [busyId, setBusyId] = useState(null);

    const todayS = dayStr(new Date());
    const tomorrowS = dayStr(new Date(Date.now() + 86400000));

    useEffect(() => {
        // Everything printed with a use-by up to tomorrow, newest first.
        // Composite index: sticker_prints (location ASC, useByDay DESC).
        const q1 = query(
            collection(db, 'sticker_prints'),
            where('location', '==', loc),
            where('useByDay', '<=', tomorrowS),
            orderBy('useByDay', 'desc'),
            limit(200),
        );
        const un1 = onSnapshot(q1, (snap) => {
            const out = [];
            snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
            setRows(out);
        }, () => setRows([]));
        // This week's waste — composite index: waste_log (location ASC, at DESC).
        const q2 = query(
            collection(db, 'waste_log'),
            where('location', '==', loc),
            orderBy('at', 'desc'),
            limit(100),
        );
        const un2 = onSnapshot(q2, (snap) => {
            const cutoff = Date.now() - 7 * 86400000;
            const out = [];
            snap.forEach((d) => {
                const w = { id: d.id, ...d.data() };
                const at = w.at?.toDate ? w.at.toDate().getTime() : 0;
                if (at >= cutoff) out.push(w);
            });
            setWaste(out);
        }, () => setWaste([]));
        return () => { un1(); un2(); };
    }, [loc, tomorrowS]);

    const groups = useMemo(() => {
        const g = { expired: [], today: [], tomorrow: [] };
        for (const r of rows || []) {
            if (r.discardedAt) continue;                 // already tossed
            if (r.useByDay < todayS) g.expired.push(r);
            else if (r.useByDay === todayS) {
                // Hour-based clocks can expire mid-day — split by real time.
                const past = r.hoursBased && r.useByAt && new Date(r.useByAt).getTime() < Date.now();
                (past ? g.expired : g.today).push(r);
            } else g.tomorrow.push(r);
        }
        return g;
    }, [rows, todayS]);

    const markDiscarded = async (r) => {
        if (busyId) return;
        setBusyId(r.id);
        try {
            await updateDoc(doc(db, 'sticker_prints', r.id), {
                discardedAt: new Date().toISOString(),
                discardedBy: staffName || 'unknown',
            });
            addDoc(collection(db, 'waste_log'), {
                printId: r.id,
                itemName: r.itemName || 'Item',
                qty: r.qty || 1,
                location: loc,
                useByDay: r.useByDay || null,
                discardedBy: staffName || 'unknown',
                at: serverTimestamp(),
            }).catch(() => {});
            toast(tx('🗑 Logged as discarded', '🗑 Registrado como desechado'), { kind: 'success', duration: 2000 });
        } catch (e) {
            console.warn('discard failed:', e);
            toast(tx('Could not save — try again.', 'No se pudo guardar.'), { kind: 'error' });
        } finally {
            setBusyId(null);
        }
    };

    const fmtWhen = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        let h = d.getHours();
        const ampm = h >= 12 ? 'p' : 'a';
        h = h % 12 || 12;
        return `${d.getMonth() + 1}/${d.getDate()} ${h}:${String(d.getMinutes()).padStart(2, '0')}${ampm}`;
    };

    const Section = ({ title, tone, items }) => items.length === 0 ? null : (
        <div className="mb-3">
            <div className={`text-[10px] font-black uppercase tracking-widest mb-1.5 px-1 ${tone}`}>
                {title} · {items.length}
            </div>
            <div className="divide-y divide-dd-line/60 rounded-lg border border-dd-line overflow-hidden">
                {items.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 px-2.5 py-2 bg-white">
                        <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-dd-text truncate">
                                {isEs ? (r.itemNameEs || r.itemName) : r.itemName}
                                {r.qty > 1 && <span className="text-dd-text-2 font-normal"> ×{r.qty}</span>}
                                {r.thawState === 'thawed' && ' ❄'}
                            </div>
                            <div className="text-[11px] text-dd-text-2 truncate">
                                {tx('Use by', 'Caduca')} {r.hoursBased ? fmtWhen(r.useByAt) : r.useByDay}
                                {' · '}{tx('printed by', 'impreso por')} {r.byName}
                            </div>
                        </div>
                        <button
                            onClick={() => markDiscarded(r)}
                            disabled={busyId === r.id}
                            className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 border border-red-200 text-red-700 text-xs font-bold active:scale-95 disabled:opacity-40">
                            <Trash2 size={13} /> {tx('Discarded', 'Desechado')}
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );

    const wasteCount = waste.reduce((n, w) => n + (Number(w.qty) || 1), 0);

    return (
        <ModalPortal onBackPress={onClose}>
            <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
                <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 p-3 border-t-4 border-amber-500 flex-shrink-0">
                        <CalendarClock size={20} className="text-amber-600" />
                        <div className="flex-1 min-w-0">
                            <h2 className="text-base font-black text-dd-text leading-tight">{tx('Expiring soon', 'Por caducar')}</h2>
                            <p className="text-[11px] text-dd-text-2">{tx('From printed date stickers · tap Discarded when you toss one', 'De etiquetas impresas · toca Desechado al tirar')}</p>
                        </div>
                        <button onClick={onClose} className="p-2 -m-1 text-dd-text-2 hover:text-dd-text"><X size={20} /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto px-3 py-2">
                        {rows === null ? (
                            <p className="text-center text-sm text-dd-text-2 py-10">{tx('Loading…', 'Cargando…')}</p>
                        ) : (groups.expired.length + groups.today.length + groups.tomorrow.length) === 0 ? (
                            <p className="text-center text-sm text-dd-text-2 py-10">
                                {tx('Nothing expiring — every printed sticker is still in date. 🎉', 'Nada por caducar — todas las etiquetas siguen vigentes. 🎉')}
                            </p>
                        ) : (
                            <>
                                <Section title={tx('Expired', 'Caducado')} tone="text-red-700" items={groups.expired} />
                                <Section title={tx('Dies today', 'Caduca hoy')} tone="text-amber-700" items={groups.today} />
                                <Section title={tx('Tomorrow', 'Mañana')} tone="text-dd-text-2" items={groups.tomorrow} />
                            </>
                        )}
                        <p className="text-[11px] text-dd-text-2 px-1 pb-2 leading-snug">
                            {tx('Only stickers printed after this feature went live appear here.',
                                'Solo aparecen etiquetas impresas después de activar esta función.')}
                        </p>
                    </div>
                    <div className="border-t border-dd-line px-4 py-2.5 flex-shrink-0 safe-bottom text-[12px] text-dd-text-2">
                        🗑 {tx(`Waste this week: ${wasteCount} item${wasteCount === 1 ? '' : 's'}`,
                               `Desechos esta semana: ${wasteCount}`)}
                        {waste.length > 0 && (
                            <span className="text-dd-text-2/70"> — {waste.slice(0, 3).map(w => w.itemName).join(', ')}{waste.length > 3 ? '…' : ''}</span>
                        )}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}
