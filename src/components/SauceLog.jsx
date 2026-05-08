// SauceLog.jsx — daily FOH↔BOH sauce-batch communication.
//
// FOH side:
//   • Sees the full sauce list. Tap a sauce → set batches + urgency → submit.
//   • Sees their own pending requests at the top.
//
// BOH side:
//   • Sees pending requests sorted by urgency (today / tomorrow / next).
//   • Mark Made → request moves to "made today" log (shown in collapsed panel).
//
// Admin side:
//   • Edit the sauce list (add / remove / rename).
//
// Storage: ops/sauceLog_${storeLocation} doc holds the live sauce list +
// requests map. Daily history snapshot in sauceLogHistory_${location}/{date}.
//
// Schema:
//   {
//     sauces: [{id, nameEn, nameEs, recipe?, notes?}],   // master list
//     requests: {
//       [sauceId]: {
//         batches, urgency, requestedBy, requestedAt,
//         status: 'pending' | 'made',
//         completedBy?, completedAt?,
//       }
//     },
//     date: 'YYYY-MM-DD',
//     updatedAt: ISO,
//     version: 1,
//   }

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc, updateDoc, deleteField, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { isAdmin } from '../data/staff';
import { DEFAULT_SAUCES, SAUCE_URGENCY, SAUCE_URGENCY_BY_ID } from '../data/sauces';

const SAUCELOG_VERSION = 1;
const BUSINESS_TZ = "America/Chicago";

// Day key in the business time zone — keeps the daily reset anchored to
// Chicago instead of the device's local zone (same pattern used in Operations).
const _dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const getTodayKey = (d = new Date()) => _dayFmt.format(d);

// Resolve which side a staff member is on. Mirrors the helpers in Schedule.jsx
// without importing the whole file. Falls back to FOH for safety.
const BOH_HINT = new Set([
    'BOH', 'Pho', 'Pho Station', 'Grill', 'Fryer', 'Fried Rice', 'Dish',
    'Bao/Tacos/Banh Mi', 'Spring Rolls/Prep', 'Prep',
    'Kitchen Manager', 'Asst Kitchen Manager',
]);
const resolveSide = (staff) => {
    if (!staff) return 'foh';
    if (staff.scheduleSide === 'foh' || staff.scheduleSide === 'boh') return staff.scheduleSide;
    if (BOH_HINT.has(staff.role)) return 'boh';
    return 'foh';
};

export default function SauceLog({ language, staffName, staffList, storeLocation }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const me = useMemo(() => (staffList || []).find(s => s.name === staffName), [staffList, staffName]);
    const mySide = resolveSide(me);
    const adminUser = isAdmin(staffName, staffList);
    // Anyone can request. Marking-made is for BOH staff and admins.
    const canMarkMade = adminUser || mySide === 'boh';

    const [doc_data, setDocData] = useState({ sauces: DEFAULT_SAUCES, requests: {} });
    const [loading, setLoading] = useState(true);
    const [requestModal, setRequestModal] = useState(null); // { sauce } when picking
    const [editList, setEditList] = useState(false);        // admin edit panel toggle

    const docRef = useMemo(() => doc(db, "ops", "sauceLog_" + storeLocation), [storeLocation]);

    // Subscribe to the live doc.
    useEffect(() => {
        const unsub = onSnapshot(docRef, (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                // Daily rollover — if the doc is from yesterday, archive it.
                // Skipped here to keep V1 simple; handled on next FOH request.
                setDocData({
                    sauces: Array.isArray(data.sauces) && data.sauces.length > 0 ? data.sauces : DEFAULT_SAUCES,
                    requests: data.requests || {},
                    date: data.date,
                });
            } else {
                // Seed the doc on first run.
                setDocData({ sauces: DEFAULT_SAUCES, requests: {} });
                setDoc(docRef, {
                    sauces: DEFAULT_SAUCES,
                    requests: {},
                    date: getTodayKey(),
                    updatedAt: new Date().toISOString(),
                    version: SAUCELOG_VERSION,
                }).catch(e => console.error('SauceLog seed failed:', e));
            }
            setLoading(false);
        }, (err) => {
            console.error('SauceLog subscribe error:', err);
            setLoading(false);
        });
        return unsub;
    }, [docRef]);

    // Daily rollover — if the doc's date is older than today, archive completed
    // requests and clear pending ones older than 24h. Triggered by any request.
    const ensureDailyDoc = async () => {
        const todayKey = getTodayKey();
        if (doc_data.date && doc_data.date !== todayKey) {
            // Archive yesterday's snapshot.
            try {
                await setDoc(doc(db, "sauceLogHistory_" + storeLocation, doc_data.date), {
                    requests: doc_data.requests || {},
                    sauces: doc_data.sauces || [],
                    date: doc_data.date,
                    archivedAt: new Date().toISOString(),
                    version: SAUCELOG_VERSION,
                });
            } catch (e) { console.warn('SauceLog archive failed:', e); }
            // Clear today's requests (keep sauce list).
            try {
                await updateDoc(docRef, { requests: {}, date: todayKey, updatedAt: new Date().toISOString() });
            } catch (e) { console.warn('SauceLog rollover failed:', e); }
        }
    };

    // Resolve who to ping when an urgent (today) request comes in.
    // Targets: BOH managers (Kitchen Manager / Asst KM) + admins. Same
    // location, or both-location admins. Never ping the requester.
    const urgentNotifyTargets = useMemo(() => {
        const list = staffList || [];
        const targets = list.filter(s => {
            if (s.name === staffName) return false; // not yourself
            const locOk = storeLocation === 'both' || s.location === storeLocation || s.location === 'both';
            if (!locOk) return false;
            if (isAdmin(s.name, list)) return true;
            const role = s.role || '';
            return role === 'Kitchen Manager' || role === 'Asst Kitchen Manager';
        });
        return targets.map(s => s.name);
    }, [staffList, staffName, storeLocation]);

    // Write notification doc for each target. The Cloud Function
    // (dispatchNotification) listens on notifications/{id} create and
    // delivers via FCM to each target's saved tokens — so an urgent
    // sauce request rings the BOH manager's phone even if the app is
    // closed. Also surfaces in the in-app bell drawer.
    const notifyManagersUrgent = async (sauce, batches) => {
        const sauceName = isEs ? sauce.nameEs : sauce.nameEn;
        const title = isEs ? `🚨 Salsa urgente: ${sauceName}` : `🚨 Urgent sauce: ${sauceName}`;
        const body = isEs
            ? `${staffName} pide ${batches} ${batches === 1 ? 'lote' : 'lotes'} para HOY.`
            : `${staffName} needs ${batches} ${batches === 1 ? 'batch' : 'batches'} TODAY.`;
        const link = '/operations/sauce';
        await Promise.all(urgentNotifyTargets.map(forStaff =>
            addDoc(collection(db, 'notifications'), {
                forStaff,
                type: 'sauce_urgent',
                title,
                body,
                link,
                createdAt: serverTimestamp(),
                read: false,
                createdBy: staffName,
            }).catch(e => console.warn('Sauce notify failed (non-fatal):', e))
        ));
    };

    // Submit a new request OR update an existing one for this sauce.
    const submitRequest = async (sauce, batches, urgency) => {
        await ensureDailyDoc();
        const now = new Date();
        const request = {
            batches,
            urgency,
            requestedBy: staffName,
            requestedAt: now.toISOString(),
            status: 'pending',
        };
        // Detect "newly urgent" — either this is a brand-new request with
        // urgency=today, OR an existing non-today request was bumped to today.
        // (Don't re-ping if a today request was edited but stayed today.)
        const prev = doc_data.requests?.[sauce.id];
        const wasUrgent = prev && prev.status === 'pending' && prev.urgency === 'today';
        const isNewlyUrgent = urgency === 'today' && !wasUrgent;
        try {
            await updateDoc(docRef, {
                [`requests.${sauce.id}`]: request,
                updatedAt: now.toISOString(),
                date: getTodayKey(),
            });
        } catch (e) {
            // Doc might not exist — seed.
            await setDoc(docRef, {
                sauces: doc_data.sauces || DEFAULT_SAUCES,
                requests: { [sauce.id]: request },
                date: getTodayKey(),
                updatedAt: now.toISOString(),
                version: SAUCELOG_VERSION,
            }, { merge: true });
        }
        if (isNewlyUrgent && urgentNotifyTargets.length > 0) {
            // Fire-and-forget — don't block the modal close on notification.
            notifyManagersUrgent(sauce, batches);
        }
        setRequestModal(null);
    };

    const cancelRequest = async (sauceId) => {
        if (!confirm(tx('Cancel this sauce request?', '¿Cancelar esta solicitud?'))) return;
        try {
            await updateDoc(docRef, {
                [`requests.${sauceId}`]: deleteField(),
                updatedAt: new Date().toISOString(),
            });
        } catch (e) { console.error('Cancel request failed:', e); }
    };

    const markMade = async (sauceId) => {
        const cur = doc_data.requests?.[sauceId];
        if (!cur) return;
        const now = new Date();
        try {
            await updateDoc(docRef, {
                [`requests.${sauceId}`]: {
                    ...cur,
                    status: 'made',
                    completedBy: staffName,
                    completedAt: now.toISOString(),
                },
                updatedAt: now.toISOString(),
            });
        } catch (e) { console.error('Mark made failed:', e); }
    };

    const unmarkMade = async (sauceId) => {
        // Walk a "made" entry back to "pending" if BOH tapped by accident.
        const cur = doc_data.requests?.[sauceId];
        if (!cur) return;
        try {
            await updateDoc(docRef, {
                [`requests.${sauceId}`]: {
                    batches: cur.batches,
                    urgency: cur.urgency,
                    requestedBy: cur.requestedBy,
                    requestedAt: cur.requestedAt,
                    status: 'pending',
                },
                updatedAt: new Date().toISOString(),
            });
        } catch (e) { console.error('Unmark made failed:', e); }
    };

    // Admin: save edits to the master sauce list.
    const saveSauceList = async (newSauces) => {
        try {
            await updateDoc(docRef, { sauces: newSauces, updatedAt: new Date().toISOString() });
        } catch (e) { console.error('Save sauce list failed:', e); }
    };

    // ── Derived: pending vs made, sorted ────────────────────────────────
    const requests = doc_data.requests || {};
    const sauces = doc_data.sauces || DEFAULT_SAUCES;
    const sauceById = useMemo(() => Object.fromEntries(sauces.map(s => [s.id, s])), [sauces]);
    const pending = useMemo(() => {
        return Object.entries(requests)
            .filter(([id, r]) => r && r.status === 'pending' && sauceById[id])
            .map(([id, r]) => ({ id, sauce: sauceById[id], req: r }))
            .sort((a, b) => {
                const ra = SAUCE_URGENCY_BY_ID[a.req.urgency]?.rank ?? 99;
                const rb = SAUCE_URGENCY_BY_ID[b.req.urgency]?.rank ?? 99;
                return ra - rb || (a.req.requestedAt || '').localeCompare(b.req.requestedAt || '');
            });
    }, [requests, sauceById]);
    const made = useMemo(() => {
        return Object.entries(requests)
            .filter(([id, r]) => r && r.status === 'made' && sauceById[id])
            .map(([id, r]) => ({ id, sauce: sauceById[id], req: r }))
            .sort((a, b) => (b.req.completedAt || '').localeCompare(a.req.completedAt || ''));
    }, [requests, sauceById]);

    if (loading) {
        return <p className="text-center text-gray-400 mt-8 text-sm">{tx('Loading…', 'Cargando…')}</p>;
    }

    return (
        <div className="space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-lg font-bold text-mint-700 flex items-center gap-2">
                        🥢 {tx('Sauce Log', 'Registro de Salsas')}
                    </h3>
                    <p className="text-xs text-gray-500">
                        {tx(`${pending.length} pending · ${made.length} made today`,
                           `${pending.length} pendientes · ${made.length} hechas hoy`)}
                        {' · '}
                        <span className="font-semibold">{mySide.toUpperCase()}</span>
                    </p>
                </div>
                {adminUser && (
                    <button onClick={() => setEditList(!editList)}
                        className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 text-xs font-bold hover:bg-gray-200">
                        {editList ? tx('Done', 'Listo') : tx('⚙ Edit list', '⚙ Editar')}
                    </button>
                )}
            </div>

            {/* Admin: edit sauce list */}
            {editList && adminUser && (
                <SauceListEditor sauces={sauces} onSave={saveSauceList} isEs={isEs} />
            )}

            {/* PENDING panel — visible to everyone, sorted by urgency */}
            <div className="bg-white rounded-xl border-2 border-blue-200 overflow-hidden">
                <div className="px-3 py-2 bg-blue-50 border-b border-blue-200">
                    <h4 className="text-sm font-bold text-blue-900">
                        ⏳ {tx(`Pending requests (${pending.length})`, `Solicitudes pendientes (${pending.length})`)}
                    </h4>
                    <p className="text-[10px] text-blue-700">
                        {canMarkMade
                            ? tx('Sorted by urgency. Tap "Mark made" when a batch is finished.',
                                 'Por urgencia. Toca "Hecho" cuando termines un lote.')
                            : tx('FOH-submitted requests. BOH will see and make these.',
                                 'Solicitudes de FOH. BOH las verá y preparará.')}
                    </p>
                </div>
                {pending.length === 0 ? (
                    <p className="text-center text-gray-400 py-4 text-sm">
                        {tx('No pending requests right now.', 'Sin solicitudes pendientes.')}
                    </p>
                ) : (
                    <div className="divide-y divide-blue-100">
                        {pending.map(({ id, sauce, req }) => (
                            <PendingRow key={id} sauce={sauce} req={req}
                                isEs={isEs}
                                isMine={req.requestedBy === staffName}
                                canMarkMade={canMarkMade}
                                onMarkMade={() => markMade(id)}
                                onCancel={() => cancelRequest(id)}
                                onEdit={() => setRequestModal({ sauce, current: req })} />
                        ))}
                    </div>
                )}
            </div>

            {/* MADE TODAY (collapsed-ish) */}
            {made.length > 0 && (
                <details className="bg-white rounded-xl border border-gray-200">
                    <summary className="px-3 py-2 cursor-pointer text-sm font-bold text-gray-700 hover:bg-gray-50">
                        ✅ {tx(`Made today (${made.length})`, `Hechas hoy (${made.length})`)}
                    </summary>
                    <div className="divide-y divide-gray-100">
                        {made.map(({ id, sauce, req }) => (
                            <MadeRow key={id} sauce={sauce} req={req} isEs={isEs}
                                canUnmark={canMarkMade}
                                onUnmark={() => unmarkMade(id)} />
                        ))}
                    </div>
                </details>
            )}

            {/* SAUCE LIST — primary FOH action */}
            <div className="bg-white rounded-xl border-2 border-mint-200 overflow-hidden">
                <div className="px-3 py-2 bg-mint-50 border-b border-mint-200">
                    <h4 className="text-sm font-bold text-mint-900">
                        🍶 {tx('Request a sauce', 'Solicitar salsa')}
                    </h4>
                    <p className="text-[10px] text-mint-700">
                        {tx('Tap a sauce to request a batch. Already-pending sauces show a counter.',
                            'Toca una salsa para pedirla. Las pendientes muestran su contador.')}
                    </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 p-1">
                    {sauces.map(s => {
                        const existing = requests[s.id];
                        const urgent = existing?.status === 'pending' ? SAUCE_URGENCY_BY_ID[existing.urgency] : null;
                        const isMade = existing?.status === 'made';
                        return (
                            <button key={s.id}
                                onClick={() => setRequestModal({ sauce: s, current: existing && existing.status === 'pending' ? existing : null })}
                                className={`text-left px-3 py-2 rounded-lg border-2 transition ${
                                    urgent ? `${urgent.chipBg} font-semibold` :
                                    isMade ? 'bg-green-50 border-green-200 text-green-800 line-through opacity-75' :
                                    'bg-white border-gray-200 hover:border-mint-400'
                                }`}>
                                <div className="font-bold text-sm flex items-center gap-2">
                                    <span>{isEs ? s.nameEs : s.nameEn}</span>
                                    {urgent && <span className="text-[10px]">{urgent.emoji} ×{existing.batches}</span>}
                                    {isMade && <span className="text-[10px]">✅</span>}
                                </div>
                                {s.notes && <div className="text-[10px] text-gray-500 italic">{s.notes}</div>}
                                {urgent && existing.requestedBy && (
                                    <div className="text-[10px] text-gray-600 mt-0.5">
                                        {tx(`by ${existing.requestedBy.split(' ')[0]}`, `por ${existing.requestedBy.split(' ')[0]}`)}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Request modal */}
            {requestModal && (
                <RequestModal
                    sauce={requestModal.sauce}
                    current={requestModal.current}
                    onClose={() => setRequestModal(null)}
                    onSubmit={(batches, urgency) => submitRequest(requestModal.sauce, batches, urgency)}
                    isEs={isEs}
                />
            )}
        </div>
    );
}

// ── PendingRow ────────────────────────────────────────────────────────────
function PendingRow({ sauce, req, isEs, isMine, canMarkMade, onMarkMade, onCancel, onEdit }) {
    const urg = SAUCE_URGENCY_BY_ID[req.urgency] || SAUCE_URGENCY_BY_ID.today;
    const requestedAt = new Date(req.requestedAt);
    const timeStr = isNaN(requestedAt) ? '' : requestedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return (
        <div className="px-3 py-2.5 flex items-center gap-2">
            <div className="flex-1 min-w-0">
                <div className="font-bold text-sm text-gray-800 flex items-center gap-1.5 flex-wrap">
                    <span>{isEs ? sauce.nameEs : sauce.nameEn}</span>
                    <span className="font-semibold text-blue-700">×{req.batches}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${urg.chipBg}`}>
                        {urg.emoji} {isEs ? urg.labelEs : urg.labelEn}
                    </span>
                </div>
                <div className="text-[10px] text-gray-500 mt-0.5">
                    {(isEs ? 'pedido por ' : 'requested by ')}{req.requestedBy}{timeStr ? ` · ${timeStr}` : ''}
                </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
                {isMine && (
                    <button onClick={onEdit}
                        className="text-[10px] px-2 py-1 rounded bg-blue-100 text-blue-700 font-bold">
                        {isEs ? '✏ Editar' : '✏ Edit'}
                    </button>
                )}
                {isMine && (
                    <button onClick={onCancel}
                        className="text-[10px] px-2 py-1 rounded bg-red-100 text-red-700 font-bold">
                        ×
                    </button>
                )}
                {canMarkMade && (
                    <button onClick={onMarkMade}
                        className="text-[11px] px-2.5 py-1 rounded bg-green-600 text-white font-bold hover:bg-green-700">
                        {isEs ? '✓ Hecho' : '✓ Made'}
                    </button>
                )}
            </div>
        </div>
    );
}

// ── MadeRow ───────────────────────────────────────────────────────────────
function MadeRow({ sauce, req, isEs, canUnmark, onUnmark }) {
    const completedAt = new Date(req.completedAt);
    const timeStr = isNaN(completedAt) ? '' : completedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return (
        <div className="px-3 py-2 flex items-center gap-2">
            <span className="text-green-600">✅</span>
            <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-700">
                    {isEs ? sauce.nameEs : sauce.nameEn} <span className="text-gray-500 font-normal">×{req.batches}</span>
                </div>
                <div className="text-[10px] text-gray-500">
                    {req.completedBy ? `by ${req.completedBy}` : ''}{timeStr ? ` · ${timeStr}` : ''}
                </div>
            </div>
            {canUnmark && (
                <button onClick={onUnmark}
                    className="text-[10px] px-2 py-1 rounded bg-gray-200 text-gray-700 font-bold">
                    ↺ {isEs ? 'Deshacer' : 'Undo'}
                </button>
            )}
        </div>
    );
}

// ── RequestModal ──────────────────────────────────────────────────────────
function RequestModal({ sauce, current, onClose, onSubmit, isEs }) {
    const [batches, setBatches] = useState(current?.batches || 1);
    const [urgency, setUrgency] = useState(current?.urgency || 'today');
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-bold text-mint-700">
                            🥢 {tx('Request', 'Solicitar')} {isEs ? sauce.nameEs : sauce.nameEn}
                        </h3>
                        {sauce.recipe && <p className="text-[10px] text-gray-500">{tx('Recipe:', 'Receta:')} {sauce.recipe}</p>}
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-lg">×</button>
                </div>
                <div className="p-4 space-y-3">
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">
                            {tx('How many batches?', '¿Cuántos lotes?')}
                        </label>
                        <div className="flex items-center gap-2">
                            <button onClick={() => setBatches(Math.max(1, batches - 1))}
                                className="w-10 h-10 rounded-lg bg-gray-200 text-gray-700 font-bold text-lg">−</button>
                            <div className="flex-1 text-center text-2xl font-bold text-mint-700">
                                {batches}
                            </div>
                            <button onClick={() => setBatches(Math.min(20, batches + 1))}
                                className="w-10 h-10 rounded-lg bg-gray-200 text-gray-700 font-bold text-lg">+</button>
                        </div>
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">
                            {tx('Urgency', 'Urgencia')}
                        </label>
                        <div className="grid grid-cols-3 gap-2">
                            {SAUCE_URGENCY.map(u => (
                                <button key={u.id} onClick={() => setUrgency(u.id)}
                                    className={`py-2.5 rounded-lg text-sm font-bold border-2 transition ${
                                        urgency === u.id ? u.chipBg + ' ring-2 ring-offset-1 ring-mint-500' : 'bg-white border-gray-300 text-gray-600'
                                    }`}>
                                    <div className="text-lg">{u.emoji}</div>
                                    <div className="text-[11px]">{isEs ? u.labelEs : u.labelEn}</div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="border-t border-gray-200 p-4 flex gap-2">
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={() => onSubmit(batches, urgency)}
                        className="flex-1 py-2 rounded-lg bg-mint-700 text-white font-bold">
                        {current ? tx('Update', 'Actualizar') : tx('Submit', 'Enviar')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── SauceListEditor (admin) ───────────────────────────────────────────────
function SauceListEditor({ sauces, onSave, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const [draft, setDraft] = useState(sauces);
    const [newName, setNewName] = useState('');

    const updateField = (idx, field, value) => {
        setDraft(prev => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s));
    };
    const removeAt = (idx) => {
        if (!confirm(tx('Remove this sauce from the list?', '¿Quitar esta salsa de la lista?'))) return;
        setDraft(prev => prev.filter((_, i) => i !== idx));
    };
    const addSauce = () => {
        if (!newName.trim()) return;
        const id = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 5);
        setDraft(prev => [...prev, { id, nameEn: newName.trim(), nameEs: newName.trim() }]);
        setNewName('');
    };
    const handleSave = () => {
        onSave(draft);
    };

    return (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-3 space-y-2">
            <h4 className="text-sm font-bold text-amber-900">⚙ {tx('Edit sauce list', 'Editar lista de salsas')}</h4>
            <p className="text-[10px] text-amber-800">
                {tx('Sauces removed here are gone for FOH. Pending requests for removed sauces stay until completed.',
                   'Las salsas quitadas ya no aparecen para FOH. Las solicitudes pendientes se mantienen hasta completar.')}
            </p>
            <div className="space-y-1">
                {draft.map((s, idx) => (
                    <div key={s.id} className="flex items-center gap-1 bg-white rounded p-1.5">
                        <input value={s.nameEn} onChange={e => updateField(idx, 'nameEn', e.target.value)}
                            placeholder="EN"
                            className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs" />
                        <input value={s.nameEs} onChange={e => updateField(idx, 'nameEs', e.target.value)}
                            placeholder="ES"
                            className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs" />
                        <button onClick={() => removeAt(idx)}
                            className="px-2 py-1 rounded bg-red-100 text-red-700 text-xs font-bold">×</button>
                    </div>
                ))}
            </div>
            <div className="flex items-center gap-1">
                <input value={newName} onChange={e => setNewName(e.target.value)}
                    placeholder={tx('Add sauce…', 'Agregar salsa…')}
                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs" />
                <button onClick={addSauce}
                    className="px-2 py-1 rounded bg-amber-600 text-white text-xs font-bold">+</button>
            </div>
            <button onClick={handleSave}
                className="w-full mt-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-bold hover:bg-amber-700">
                {tx('Save list', 'Guardar lista')}
            </button>
        </div>
    );
}
