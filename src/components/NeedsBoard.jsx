// NeedsBoard — admin/manager-only board for non-inventory supply requests.
//
// 2026-06-01 — Andrew: "i want to add a new tab in the home page. its
// for the admins and managers. Call it what we need... the page is for
// us to put things we need. thats not inventory. things like new brooms,
// more pans, more stickers. and give a urgent, soon, no rush for urgency.
// have everything have a time stamp and the staff name."
//
// Distinct from Inventory + Order Mode in that:
//   • Inventory tracks recurring food + supply COUNTS against par levels.
//   • Order Mode + vendor matches build vendor purchase orders.
//   • Needs Board captures one-off requests that don't fit either —
//     "we need more brooms", "more bowl stickers", "the prep pan with
//     the chip" — items the team is reminding ownership to handle.
//
// Schema (Firestore collection /needs_{location}):
//   {
//     id: auto,
//     text: 'Need 3 new dust pans',
//     urgency: 'urgent' | 'soon' | 'no_rush',
//     status: 'open' | 'resolved',
//     createdAt: serverTimestamp,
//     createdAtIso: ISO string (for client sort stability),
//     createdBy: 'Andrew Shih',
//     resolvedAt: null | serverTimestamp,
//     resolvedBy: null | staff name,
//     location: 'webster' | 'maryland',
//   }
//
// Access (App.jsx gate): isAdmin || isManager — same pool that already
// sees Operations + AdminPanel. Staff don't see this tab.
//
// Anyone with access can add, edit urgency, mark resolved, and delete
// (with a confirmation prompt — per Andrew's persistent rule that no
// destructive action happens without an "are you sure" prompt).

import { useEffect, useMemo, useState } from 'react';
import {
    collection,
    addDoc,
    deleteDoc,
    doc,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    updateDoc,
    where,
} from 'firebase/firestore';
import { db } from '../firebase';
import { Plus, Trash2, CheckCircle2, AlertCircle, Clock, Sparkles } from 'lucide-react';

// Display labels per urgency level.
const URGENCY_LEVELS = [
    {
        key: 'urgent',
        en: 'Urgent',
        es: 'Urgente',
        Icon: AlertCircle,
        // Soft-red glass card to grab attention without screaming.
        cardClass: 'bg-red-50/90 border-red-200',
        badgeClass: 'bg-red-500 text-white',
        sortIndex: 0,
    },
    {
        key: 'soon',
        en: 'Soon',
        es: 'Pronto',
        Icon: Clock,
        cardClass: 'bg-amber-50/90 border-amber-200',
        badgeClass: 'bg-amber-500 text-white',
        sortIndex: 1,
    },
    {
        key: 'no_rush',
        en: 'No rush',
        es: 'Sin prisa',
        Icon: Sparkles,
        cardClass: 'bg-emerald-50/90 border-emerald-200',
        badgeClass: 'bg-emerald-600 text-white',
        sortIndex: 2,
    },
];

const URGENCY_BY_KEY = Object.fromEntries(URGENCY_LEVELS.map((u) => [u.key, u]));

// Format "2h ago" / "just now" / "3d ago" — small util, no Date.now() in
// build artefacts (Date.now() inside the workflow context is fine, this
// is runtime browser code).
function relativeTime(iso, language) {
    if (!iso) return '';
    const now = Date.now();
    const then = new Date(iso).getTime();
    if (!then || Number.isNaN(then)) return '';
    const seconds = Math.max(1, Math.floor((now - then) / 1000));
    const isEs = language === 'es';
    if (seconds < 60) return isEs ? 'ahora' : 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return isEs ? `hace ${minutes}m` : `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return isEs ? `hace ${hours}h` : `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return isEs ? `hace ${days}d` : `${days}d ago`;
    const months = Math.floor(days / 30);
    return isEs ? `hace ${months} meses` : `${months}mo ago`;
}

export default function NeedsBoard({ language, staffName, storeLocation }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // Default to webster if location is 'both' — single-location editors
    // get auto-filtered.
    const effectiveLocation = storeLocation === 'both' ? 'webster' : storeLocation || 'webster';
    const collName = `needs_${effectiveLocation}`;

    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState('');
    const [showResolved, setShowResolved] = useState(false);

    // Add-form state.
    const [draftText, setDraftText] = useState('');
    const [draftUrgency, setDraftUrgency] = useState('soon');
    const [submitting, setSubmitting] = useState(false);

    // Live subscription. Scope to open items by default; resolved fetched
    // lazily when the toggle is on.
    useEffect(() => {
        if (!effectiveLocation) return;
        setLoading(true);
        const base = collection(db, collName);
        const q = showResolved
            ? query(base, orderBy('createdAtIso', 'desc'))
            : query(base, where('status', '==', 'open'), orderBy('createdAtIso', 'desc'));
        const unsub = onSnapshot(
            q,
            (snap) => {
                const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
                setItems(arr);
                setLoading(false);
                setErr('');
            },
            (e) => {
                console.warn('[NeedsBoard] snapshot error', e);
                setErr(e?.code === 'failed-precondition'
                    ? tx('Index building… try again in a minute.', 'Indice cargando…')
                    : tx('Could not load needs.', 'No se pudo cargar.'));
                setLoading(false);
            },
        );
        return () => unsub();
    }, [collName, showResolved, effectiveLocation]);

    // Group by urgency for the open list. Resolved view stays flat.
    const groups = useMemo(() => {
        if (showResolved) return [{ key: 'all', label: tx('All', 'Todos'), entries: items }];
        const buckets = URGENCY_LEVELS.map((u) => ({
            key: u.key,
            label: tx(u.en, u.es),
            tone: u,
            entries: items.filter((it) => (it.urgency || 'soon') === u.key),
        }));
        return buckets;
    }, [items, showResolved, isEs]);

    // -- Add new need ------------------------------------------------------
    async function handleAdd(e) {
        e?.preventDefault?.();
        const text = draftText.trim();
        if (!text) return;
        if (!staffName) {
            window.alert(tx('Could not identify you — sign in again.', 'No te pudimos identificar.'));
            return;
        }
        setSubmitting(true);
        try {
            await addDoc(collection(db, collName), {
                text,
                urgency: draftUrgency,
                status: 'open',
                createdAt: serverTimestamp(),
                // ISO snapshot — used for client-side ordering since
                // serverTimestamp is null on the optimistic local doc
                // and would sort to the bottom of every list.
                createdAtIso: new Date().toISOString(),
                createdBy: staffName,
                resolvedAt: null,
                resolvedBy: null,
                location: effectiveLocation,
            });
            setDraftText('');
            // Keep urgency on whatever the user just used — usually
            // multiple items get added in a row at the same level.
        } catch (e) {
            console.warn('[NeedsBoard] add failed', e);
            window.alert(tx(`Could not save: ${e?.message || 'error'}`, `No se pudo guardar.`));
        } finally {
            setSubmitting(false);
        }
    }

    // -- Mark resolved / unresolved ---------------------------------------
    async function toggleResolved(item) {
        const willResolve = item.status !== 'resolved';
        try {
            await updateDoc(doc(db, collName, item.id), willResolve
                ? { status: 'resolved', resolvedAt: serverTimestamp(), resolvedBy: staffName || '' }
                : { status: 'open', resolvedAt: null, resolvedBy: null });
        } catch (e) {
            window.alert(tx(`Update failed: ${e?.message || 'error'}`, 'Error al actualizar.'));
        }
    }

    // -- Change urgency (cycle through) -----------------------------------
    async function cycleUrgency(item) {
        const order = URGENCY_LEVELS.map((u) => u.key);
        const idx = Math.max(0, order.indexOf(item.urgency || 'soon'));
        const next = order[(idx + 1) % order.length];
        try {
            await updateDoc(doc(db, collName, item.id), { urgency: next });
        } catch (e) {
            window.alert(tx(`Update failed: ${e?.message || 'error'}`, 'Error al actualizar.'));
        }
    }

    // -- Delete (with confirmation) ---------------------------------------
    async function handleDelete(item) {
        const ok = window.confirm(tx(
            `Delete this need?\n\n"${item.text}"\n\nThis cannot be undone.`,
            `¿Eliminar?\n\n"${item.text}"\n\nNo se puede deshacer.`,
        ));
        if (!ok) return;
        try {
            await deleteDoc(doc(db, collName, item.id));
        } catch (e) {
            window.alert(tx(`Delete failed: ${e?.message || 'error'}`, 'Error al borrar.'));
        }
    }

    // ---------------------------------------------------------------------
    return (
        <div className="max-w-3xl mx-auto px-3 md:px-6 py-4 md:py-6 pb-bottom-nav">
            {/* Header */}
            <div className="mb-4 md:mb-6">
                <h1 className="text-2xl md:text-3xl font-black text-dd-text tracking-tight">
                    {tx('Needs Board', 'Lista de Pedidos')}
                </h1>
                <p className="text-xs md:text-sm text-dd-text-2 mt-1">
                    {tx(
                        'Things we need — brooms, pans, stickers, anything not in inventory.',
                        'Lo que necesitamos — escobas, ollas, calcomanías.',
                    )}
                </p>
            </div>

            {/* Add new need form */}
            <form onSubmit={handleAdd}
                className="mb-5 rounded-2xl bg-white/80 backdrop-blur-md border border-dd-line/60 shadow-sm p-3 md:p-4">
                <label className="text-[11px] font-bold uppercase tracking-wider text-dd-text-2 block mb-1.5">
                    {tx('Add a need', 'Añadir pedido')}
                </label>
                <input
                    type="text"
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    placeholder={tx('e.g. 3 new brooms for the prep area', 'ej. 3 escobas para prep')}
                    className="w-full px-3 py-2.5 rounded-xl border border-dd-line bg-white text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/40"
                    maxLength={500}
                />
                <div className="flex flex-wrap items-center gap-2 mt-2.5">
                    {URGENCY_LEVELS.map((u) => {
                        const Icon = u.Icon;
                        const sel = draftUrgency === u.key;
                        return (
                            <button
                                type="button"
                                key={u.key}
                                onClick={() => setDraftUrgency(u.key)}
                                className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-bold border transition active:scale-95 ${
                                    sel
                                        ? `${u.badgeClass} border-transparent`
                                        : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'
                                }`}
                            >
                                <Icon size={13} strokeWidth={2.4} />
                                {tx(u.en, u.es)}
                            </button>
                        );
                    })}
                    <button
                        type="submit"
                        disabled={!draftText.trim() || submitting}
                        className="ml-auto inline-flex items-center gap-1 px-3.5 py-2 rounded-xl bg-dd-green text-white text-sm font-bold transition active:scale-95 disabled:opacity-50"
                    >
                        <Plus size={16} strokeWidth={2.5} />
                        {tx('Add', 'Añadir')}
                    </button>
                </div>
            </form>

            {/* Resolved toggle */}
            <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-dd-text-2">
                    {showResolved
                        ? tx('All items', 'Todos')
                        : tx('Open items', 'Pendientes')}
                </span>
                <button
                    type="button"
                    onClick={() => setShowResolved((v) => !v)}
                    className="text-[11px] font-bold text-dd-green-700 hover:underline"
                >
                    {showResolved
                        ? tx('Hide resolved', 'Ocultar resueltos')
                        : tx('Show resolved', 'Mostrar resueltos')}
                </button>
            </div>

            {err && (
                <div className="rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs p-2 mb-3">{err}</div>
            )}

            {loading ? (
                <p className="text-center text-xs text-dd-text-2 py-8">{tx('Loading…', 'Cargando…')}</p>
            ) : items.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-dd-line/60 bg-white/40 text-center py-10 text-sm text-dd-text-2">
                    {tx('Nothing here yet. Add the first need above.', 'Aún no hay pedidos. Añade arriba.')}
                </div>
            ) : (
                groups.map((group) =>
                    group.entries.length === 0 ? null : (
                        <section key={group.key} className="mb-5">
                            <h2 className="text-[10px] font-black uppercase tracking-wider text-dd-text-2 mb-2 px-1">
                                {group.label} · {group.entries.length}
                            </h2>
                            <ul className="space-y-2">
                                {group.entries.map((it) => {
                                    const tone = URGENCY_BY_KEY[it.urgency || 'soon'] || URGENCY_BY_KEY.soon;
                                    const Icon = tone.Icon;
                                    const isResolved = it.status === 'resolved';
                                    return (
                                        <li
                                            key={it.id}
                                            className={`relative rounded-2xl border shadow-sm p-3 transition ${
                                                isResolved
                                                    ? 'bg-gray-50/70 border-gray-200 opacity-70'
                                                    : tone.cardClass
                                            }`}
                                        >
                                            <div className="flex items-start gap-3">
                                                <button
                                                    type="button"
                                                    onClick={() => toggleResolved(it)}
                                                    title={isResolved ? tx('Reopen', 'Reabrir') : tx('Mark resolved', 'Marcar resuelto')}
                                                    className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition active:scale-95 ${
                                                        isResolved
                                                            ? 'bg-emerald-500 text-white'
                                                            : 'bg-white text-dd-text-2 hover:text-emerald-600 ring-1 ring-dd-line'
                                                    }`}
                                                >
                                                    <CheckCircle2 size={16} strokeWidth={2.4} />
                                                </button>
                                                <div className="flex-1 min-w-0">
                                                    <p className={`text-sm font-semibold text-dd-text break-words ${isResolved ? 'line-through' : ''}`}>
                                                        {it.text}
                                                    </p>
                                                    <div className="flex flex-wrap items-center gap-2 mt-1.5">
                                                        <button
                                                            type="button"
                                                            onClick={() => cycleUrgency(it)}
                                                            title={tx('Tap to change urgency', 'Toca para cambiar urgencia')}
                                                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider ${tone.badgeClass}`}
                                                        >
                                                            <Icon size={11} strokeWidth={2.6} />
                                                            {tx(tone.en, tone.es)}
                                                        </button>
                                                        <span className="text-[11px] text-dd-text-2">
                                                            {it.createdBy || tx('Unknown', 'Desconocido')}
                                                            <span className="opacity-50"> · </span>
                                                            {relativeTime(it.createdAtIso, language)}
                                                        </span>
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => handleDelete(it)}
                                                    title={tx('Delete', 'Eliminar')}
                                                    className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-dd-text-2 hover:text-red-600 hover:bg-red-50 transition active:scale-95"
                                                >
                                                    <Trash2 size={14} strokeWidth={2.2} />
                                                </button>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ),
                )
            )}
        </div>
    );
}
