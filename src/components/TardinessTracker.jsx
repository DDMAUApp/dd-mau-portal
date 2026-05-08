// TardinessTracker.jsx — manager-entry tardiness with rolling 60-day
// progressive discipline.
//
// Operator lens (industry-standard fast-casual HR):
//   • Manager taps "+ Log tardy" → picks staff, date, minutes late, reason
//   • Each tardy in the rolling 60-day window pushes the staff up a tier:
//       Clear ✅  →  Verbal 📝  →  Written ✍️  →  Final 🚨  →  Term 🛑
//   • Excused tardies (sick with note, doc appointment, family emergency)
//     stay in the record but don't count toward the tier
//   • Push notification to the staff on entry — transparency + due process
//   • Roster view sorts worst-tier first so managers see who needs attention
//
// Engineer lens:
//   • Single tardies/{id} collection — simple, queryable, scales fine for
//     restaurant volumes (a handful of writes per week).
//   • Tier computed at read time from the rolling window — old entries
//     stay forever for audit, but stop counting after 60 days automatically.
//   • Location-scoped by storeBranch field; multi-location admins can see
//     both via the location switcher elsewhere.

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, addDoc, onSnapshot, doc, updateDoc, deleteDoc, serverTimestamp, query, where, orderBy } from 'firebase/firestore';
import { isAdmin, LOCATION_LABELS } from '../data/staff';
import {
    TARDY_TIERS, TARDY_REASONS, TARDY_REASON_BY_ID, TARDY_MINUTES_PRESETS,
    ROLLING_WINDOW_DAYS,
    tierFor, countingTardies, nextFalloffDate,
    getBusinessDateKey, subtractDays,
} from '../data/tardies';

export default function TardinessTracker({ language, staffName, staffList, storeLocation }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const adminUser = isAdmin(staffName, staffList);
    // Any manager can log tardies. "Manager" in role title catches Manager,
    // Asst Manager, Kitchen Manager, Asst Kitchen Manager.
    const me = (staffList || []).find(s => s.name === staffName);
    const canEdit = adminUser || (me && /manager/i.test(me.role || ''));

    const [tardies, setTardies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showLogModal, setShowLogModal] = useState(false);
    const [drillStaff, setDrillStaff] = useState(null); // staff member being viewed in detail
    const [tierFilter, setTierFilter] = useState('all'); // all | clear | verbal | written | final | term

    // Subscribe to all tardies for this location. Filtering happens client
    // side so we can switch between roster + drill-down without re-querying.
    useEffect(() => {
        let q;
        if (storeLocation === 'both') {
            q = query(collection(db, 'tardies'), orderBy('date', 'desc'));
        } else {
            q = query(collection(db, 'tardies'),
                where('storeBranch', '==', storeLocation),
                orderBy('date', 'desc'));
        }
        const unsub = onSnapshot(q, (snap) => {
            const items = [];
            snap.forEach(d => items.push({ id: d.id, ...d.data() }));
            setTardies(items);
            setLoading(false);
        }, (err) => {
            console.error('Tardies snapshot error:', err);
            setLoading(false);
        });
        return unsub;
    }, [storeLocation]);

    // ── Derived: per-staff stats ─────────────────────────────────────
    const staffStats = useMemo(() => {
        const stats = new Map();
        // Seed with everyone at this location (so you see "Clear" tier for
        // staff who have zero tardies).
        const locationStaff = (staffList || []).filter(s =>
            storeLocation === 'both' || s.location === storeLocation || s.location === 'both'
        );
        for (const s of locationStaff) {
            stats.set(s.name, {
                staff: s,
                counting: countingTardies(tardies, s.name),
                allHistory: tardies.filter(t => t.staffName === s.name),
            });
        }
        return stats;
    }, [tardies, staffList, storeLocation]);

    // Notify the staff member by writing to /notifications. Cloud Function
    // dispatchNotification fans out via FCM to their saved tokens.
    const notifyStaff = async (forStaff, tardy, tier) => {
        const tierLabel = isEs ? tier.labelEs : tier.labelEn;
        const dateLabel = tardy.date;
        const title = isEs
            ? `Tardanza registrada: ${dateLabel}`
            : `Tardy logged: ${dateLabel}`;
        const reason = TARDY_REASON_BY_ID[tardy.reason];
        const reasonLabel = reason ? (isEs ? reason.labelEs : reason.labelEn) : tardy.reason;
        const body = isEs
            ? `${tardy.minutesLate} min tarde · ${reasonLabel} · Nivel actual: ${tier.emoji} ${tierLabel}.`
            : `${tardy.minutesLate} min late · ${reasonLabel} · Current tier: ${tier.emoji} ${tierLabel}.`;
        try {
            await addDoc(collection(db, 'notifications'), {
                forStaff,
                type: 'tardy_logged',
                title,
                body,
                link: '/tardies',
                createdAt: serverTimestamp(),
                read: false,
                createdBy: staffName,
            });
        } catch (e) { console.warn('Tardy notify failed (non-fatal):', e); }
    };

    const logTardy = async (entry) => {
        if (!canEdit) return;
        const staff = (staffList || []).find(s => s.name === entry.staffName);
        const payload = {
            staffName: entry.staffName,
            staffId: staff?.id ?? null,
            date: entry.date,
            minutesLate: Number(entry.minutesLate) || 0,
            reason: entry.reason,
            reasonText: entry.reasonText || '',
            storeBranch: staff?.location && staff.location !== 'both'
                ? staff.location
                : (storeLocation === 'both' ? 'webster' : storeLocation),
            enteredBy: staffName,
            enteredById: me?.id ?? null,
            enteredAt: serverTimestamp(),
            excused: !!entry.excused,
        };
        try {
            await addDoc(collection(db, 'tardies'), payload);
            // After write, compute new tier and notify staff. Snapshot will
            // arrive momentarily but we want the notification to ride the
            // current count + this entry, so simulate locally.
            const before = countingTardies(tardies, entry.staffName);
            const projected = entry.excused ? before.length : before.length + 1;
            const tier = tierFor(projected);
            notifyStaff(entry.staffName, payload, tier);
            setShowLogModal(false);
        } catch (e) {
            console.error('Log tardy failed:', e);
            alert(tx('Could not save: ', 'No se pudo guardar: ') + e.message);
        }
    };

    const toggleExcused = async (tardyId, excused) => {
        if (!canEdit) return;
        try {
            await updateDoc(doc(db, 'tardies', tardyId), { excused: !excused });
        } catch (e) { console.error('Toggle excused failed:', e); }
    };

    const removeTardy = async (tardyId) => {
        if (!canEdit) return;
        if (!confirm(tx('Delete this tardy entry? This is permanent.',
                       '¿Borrar esta tardanza? Es permanente.'))) return;
        try {
            await deleteDoc(doc(db, 'tardies', tardyId));
        } catch (e) { console.error('Delete tardy failed:', e); }
    };

    // ── Derived: roster sorted by tier desc, filtered ────────────────
    const roster = useMemo(() => {
        const list = Array.from(staffStats.values()).map(s => ({
            ...s,
            tier: tierFor(s.counting.length),
        }));
        const filtered = tierFilter === 'all' ? list : list.filter(s => s.tier.id === tierFilter);
        // Sort: tier-rank desc (worst first), then name asc.
        const tierRank = (id) => TARDY_TIERS.findIndex(t => t.id === id);
        filtered.sort((a, b) => {
            const ra = tierRank(a.tier.id);
            const rb = tierRank(b.tier.id);
            if (ra !== rb) return rb - ra;
            return (a.staff.name || '').localeCompare(b.staff.name || '');
        });
        return filtered;
    }, [staffStats, tierFilter]);

    // Tier counts for filter chips
    const tierCounts = useMemo(() => {
        const counts = {};
        for (const t of TARDY_TIERS) counts[t.id] = 0;
        for (const s of staffStats.values()) {
            counts[tierFor(s.counting.length).id] += 1;
        }
        return counts;
    }, [staffStats]);

    // ── Render ───────────────────────────────────────────────────────
    if (!canEdit) {
        return (
            <div className="p-4 pb-bottom-nav">
                <p className="text-center text-gray-400 mt-8 text-sm">
                    {tx('Manager-only view.', 'Vista solo para gerentes.')}
                </p>
            </div>
        );
    }

    if (drillStaff) {
        const stats = staffStats.get(drillStaff.name);
        return (
            <StaffDrillDown
                staff={drillStaff}
                stats={stats}
                onBack={() => setDrillStaff(null)}
                onToggleExcused={toggleExcused}
                onRemove={removeTardy}
                isEs={isEs}
            />
        );
    }

    return (
        <div className="p-4 pb-bottom-nav md:p-5 max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-3">
                <div>
                    <h2 className="text-2xl font-bold text-mint-700">⏰ {tx('Tardiness', 'Tardanzas')}</h2>
                    <p className="text-xs text-gray-500">
                        {tx(`Rolling ${ROLLING_WINDOW_DAYS}-day window · ${LOCATION_LABELS[storeLocation] || storeLocation}`,
                            `Ventana de ${ROLLING_WINDOW_DAYS} días · ${LOCATION_LABELS[storeLocation] || storeLocation}`)}
                    </p>
                </div>
                <button onClick={() => setShowLogModal(true)}
                    className="px-3 py-2 rounded-lg bg-red-600 text-white text-sm font-bold hover:bg-red-700">
                    + {tx('Log tardy', 'Registrar')}
                </button>
            </div>

            {/* Tier filter chips */}
            <div className="flex flex-wrap gap-1 mb-3">
                <FilterChip id="all" active={tierFilter === 'all'} onClick={() => setTierFilter('all')}
                    color="bg-gray-100 text-gray-800 border-gray-300"
                    label={`${tx('All', 'Todos')} (${staffStats.size})`} />
                {TARDY_TIERS.map(t => (
                    <FilterChip key={t.id} id={t.id} active={tierFilter === t.id}
                        onClick={() => setTierFilter(t.id)}
                        color={t.color}
                        label={`${t.emoji} ${tx(t.labelEn, t.labelEs)} (${tierCounts[t.id]})`} />
                ))}
            </div>

            {loading ? (
                <p className="text-center text-gray-400 mt-8 text-sm">{tx('Loading…', 'Cargando…')}</p>
            ) : roster.length === 0 ? (
                <p className="text-center text-gray-400 mt-8 text-sm">
                    {tierFilter === 'all'
                        ? tx('No staff at this location.', 'Sin personal en esta ubicación.')
                        : tx('No staff in this tier.', 'Sin personal en este nivel.')}
                </p>
            ) : (
                <div className="space-y-1.5">
                    {roster.map(({ staff, counting, allHistory, tier }) => (
                        <RosterRow key={staff.id || staff.name}
                            staff={staff}
                            counting={counting}
                            allHistory={allHistory}
                            tier={tier}
                            isEs={isEs}
                            onClick={() => setDrillStaff(staff)} />
                    ))}
                </div>
            )}

            {showLogModal && (
                <LogTardyModal
                    staffList={(staffList || []).filter(s =>
                        storeLocation === 'both' || s.location === storeLocation || s.location === 'both'
                    )}
                    onClose={() => setShowLogModal(false)}
                    onSave={logTardy}
                    isEs={isEs}
                />
            )}
        </div>
    );
}

// ── FilterChip ────────────────────────────────────────────────────────
function FilterChip({ active, onClick, color, label }) {
    return (
        <button onClick={onClick}
            className={`px-2.5 py-1 rounded-full text-[11px] font-bold border ${
                active ? color + ' ring-2 ring-offset-1 ring-gray-500' : 'bg-white border-gray-300 text-gray-600'
            }`}>
            {label}
        </button>
    );
}

// ── RosterRow ─────────────────────────────────────────────────────────
function RosterRow({ staff, counting, allHistory, tier, isEs, onClick }) {
    const tx = (en, es) => (isEs ? es : en);
    const next = nextFalloffDate(counting);
    return (
        <button onClick={onClick}
            className="w-full text-left bg-white border border-gray-200 rounded-lg p-2.5 flex items-center gap-3 hover:border-mint-400 hover:bg-mint-50/50 transition">
            <div className={`px-2 py-1 rounded-lg border-2 text-[10px] font-bold whitespace-nowrap ${tier.color}`}>
                {tier.emoji} {tier.short}
            </div>
            <div className="flex-1 min-w-0">
                <div className="font-bold text-sm text-gray-800 truncate">{staff.name}</div>
                <div className="text-[10px] text-gray-500 truncate">
                    {staff.role}
                    {counting.length > 0 && (
                        <> · {tx(`${counting.length} counted`, `${counting.length} cuentan`)}</>
                    )}
                    {allHistory.length > counting.length && (
                        <> · {tx(`${allHistory.length} total`, `${allHistory.length} totales`)}</>
                    )}
                    {next && (
                        <> · {tx('next clears', 'siguiente expira')} {next}</>
                    )}
                </div>
            </div>
            <div className="text-gray-300">›</div>
        </button>
    );
}

// ── StaffDrillDown ────────────────────────────────────────────────────
function StaffDrillDown({ staff, stats, onBack, onToggleExcused, onRemove, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    if (!stats) return null;
    const tier = tierFor(stats.counting.length);
    const next = nextFalloffDate(stats.counting);
    // Show all history — counting first, then expired (older than 60 days),
    // grayed-out so it's clear those don't affect the tier anymore.
    const today = getBusinessDateKey();
    const cutoff = subtractDays(today, ROLLING_WINDOW_DAYS - 1);
    const sorted = [...stats.allHistory].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return (
        <div className="p-4 pb-bottom-nav md:p-5 max-w-2xl mx-auto">
            <button onClick={onBack}
                className="text-mint-700 text-sm font-bold mb-2 hover:underline">
                ← {tx('Back to roster', 'Volver al roster')}
            </button>
            <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                    <h2 className="text-xl font-bold text-gray-800">{staff.name}</h2>
                    <p className="text-xs text-gray-500">{staff.role}</p>
                </div>
                <div className={`px-3 py-1.5 rounded-lg border-2 text-sm font-bold ${tier.color}`}>
                    {tier.emoji} {tx(tier.labelEn, tier.labelEs)}
                </div>
            </div>

            <div className="bg-gray-50 rounded-lg p-3 mb-3 text-sm">
                <p className="text-gray-700">
                    <strong>{stats.counting.length}</strong> {tx('counted in last 60 days', 'cuentan en los últimos 60 días')}
                    {stats.allHistory.length > stats.counting.length && (
                        <> · <strong>{stats.allHistory.length}</strong> {tx('total ever', 'totales')}</>
                    )}
                </p>
                {next && (
                    <p className="text-xs text-gray-500 mt-1">
                        {tx('Oldest counted will fall off:', 'La más antigua expira:')} <strong>{next}</strong>
                    </p>
                )}
            </div>

            {sorted.length === 0 ? (
                <p className="text-center text-gray-400 py-6 text-sm">
                    {tx('No tardies recorded.', 'Sin tardanzas registradas.')}
                </p>
            ) : (
                <div className="space-y-1.5">
                    {sorted.map(t => {
                        const expired = t.date < cutoff;
                        const reason = TARDY_REASON_BY_ID[t.reason];
                        return (
                            <div key={t.id}
                                className={`bg-white border rounded-lg p-2.5 ${
                                    t.excused ? 'border-blue-200 bg-blue-50/50' :
                                    expired   ? 'border-gray-200 opacity-60' :
                                                'border-red-200'
                                }`}>
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-gray-800">
                                            {t.date}
                                            <span className="text-gray-500 font-normal"> · {t.minutesLate} min</span>
                                            {t.excused && <span className="ml-2 text-blue-700 text-[10px]">🛡 {tx('Excused', 'Justificada')}</span>}
                                            {expired && <span className="ml-2 text-gray-500 text-[10px]">{tx('expired', 'expirada')}</span>}
                                        </div>
                                        <div className="text-[11px] text-gray-600">
                                            {reason ? `${reason.emoji} ${tx(reason.labelEn, reason.labelEs)}` : t.reason}
                                            {t.reasonText && ` · ${t.reasonText}`}
                                        </div>
                                        {t.enteredBy && (
                                            <div className="text-[10px] text-gray-400 mt-0.5">
                                                {tx(`Logged by ${t.enteredBy}`, `Registrada por ${t.enteredBy}`)}
                                            </div>
                                        )}
                                    </div>
                                    <button onClick={() => onToggleExcused(t.id, t.excused)}
                                        className={`text-[10px] px-2 py-1 rounded font-bold ${
                                            t.excused ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700'
                                        }`}>
                                        {t.excused ? tx('Un-excuse', 'Quitar') : tx('🛡 Excuse', '🛡 Justificar')}
                                    </button>
                                    <button onClick={() => onRemove(t.id)}
                                        className="text-[10px] px-2 py-1 rounded bg-red-100 text-red-700 font-bold">
                                        ×
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ── LogTardyModal ─────────────────────────────────────────────────────
function LogTardyModal({ staffList, onClose, onSave, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const today = getBusinessDateKey();
    const [form, setForm] = useState({
        staffName: '',
        date: today,
        minutesLate: 10,
        reason: 'overslept',
        reasonText: '',
        excused: false,
    });
    const update = (k, v) => setForm(f => ({ ...f, [k]: v }));

    const sortedStaff = useMemo(
        () => [...staffList].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
        [staffList]
    );

    const canSubmit = form.staffName && form.date && form.minutesLate > 0 && form.reason;
    const reasonObj = TARDY_REASON_BY_ID[form.reason];
    const showReasonText = form.reason === 'other';

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[92vh] overflow-y-auto">
                <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex items-center justify-between">
                    <h3 className="text-lg font-bold text-red-700">⏰ {tx('Log Tardy', 'Registrar Tardanza')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-lg">×</button>
                </div>
                <div className="p-4 space-y-3">
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Staff', 'Personal')}</label>
                        <select value={form.staffName} onChange={e => update('staffName', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                            <option value="">{tx('— Select —', '— Selecciona —')}</option>
                            {sortedStaff.map(s => (
                                <option key={s.id || s.name} value={s.name}>{s.name} · {s.role}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Date', 'Fecha')}</label>
                        <input type="date" value={form.date} onChange={e => update('date', e.target.value)}
                            max={today}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">
                            {tx('How many minutes late?', '¿Cuántos minutos tarde?')}
                        </label>
                        <div className="flex flex-wrap gap-1.5 mb-2">
                            {TARDY_MINUTES_PRESETS.map(m => (
                                <button key={m} type="button" onClick={() => update('minutesLate', m)}
                                    className={`px-2.5 py-1 rounded-md text-xs font-bold border ${
                                        form.minutesLate === m
                                            ? 'bg-red-600 text-white border-red-600'
                                            : 'bg-white text-gray-700 border-gray-300'
                                    }`}>
                                    {m}
                                </button>
                            ))}
                        </div>
                        <input type="number" min="1" max="600" value={form.minutesLate}
                            onChange={e => update('minutesLate', Math.max(1, parseInt(e.target.value) || 1))}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-700 block mb-1">{tx('Reason', 'Razón')}</label>
                        <div className="grid grid-cols-2 gap-1.5">
                            {TARDY_REASONS.map(r => (
                                <button key={r.id} type="button" onClick={() => update('reason', r.id)}
                                    className={`px-2 py-1.5 rounded-md text-[11px] font-bold border text-left ${
                                        form.reason === r.id
                                            ? 'bg-red-600 text-white border-red-600'
                                            : 'bg-white text-gray-700 border-gray-300'
                                    }`}>
                                    {r.emoji} {tx(r.labelEn, r.labelEs)}
                                </button>
                            ))}
                        </div>
                        {showReasonText && (
                            <input type="text" value={form.reasonText} onChange={e => update('reasonText', e.target.value)}
                                placeholder={tx('Add detail…', 'Agrega detalle…')}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mt-2" />
                        )}
                    </div>
                    {/* Excusable reasons hint that this might warrant a 🛡 toggle */}
                    {(reasonObj?.excusable || form.excused) && (
                        <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg p-2">
                            <div>
                                <div className="text-xs font-bold text-blue-900">
                                    🛡 {tx('Excused (does not count toward tier)', 'Justificada (no cuenta para nivel)')}
                                </div>
                                <div className="text-[10px] text-blue-700">
                                    {tx('Sick with note, doctor visit, family emergency, etc.',
                                        'Enfermedad con nota, visita al doctor, emergencia familiar, etc.')}
                                </div>
                            </div>
                            <button onClick={() => update('excused', !form.excused)}
                                className={`w-12 h-6 rounded-full relative transition ${form.excused ? 'bg-blue-600' : 'bg-gray-300'}`}>
                                <div className={`w-5 h-5 bg-white rounded-full shadow absolute top-0.5 transition ${form.excused ? 'translate-x-6' : 'translate-x-0.5'}`} />
                            </button>
                        </div>
                    )}
                </div>
                <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4 flex gap-2">
                    <button onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold">{tx('Cancel', 'Cancelar')}</button>
                    <button onClick={() => canSubmit && onSave(form)} disabled={!canSubmit}
                        className={`flex-1 py-2 rounded-lg font-bold text-white ${canSubmit ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-300'}`}>
                        {tx('Log tardy', 'Registrar')}
                    </button>
                </div>
            </div>
        </div>
    );
}
