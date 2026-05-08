// ShiftHandoff.jsx — closing manager → next-morning opener.
//
// Three states for the day's handoff doc:
//   draft        — closing manager filling out (auto-saves)
//   submitted    — closing manager hit Submit; FCM fanned to other managers
//   acknowledged — first opening manager tapped Acknowledge; can append PM notes
//
// UI flow:
//   • Default view shows TODAY's handoff (in-progress closer side OR awaiting ack).
//   • Date picker scrolls back through history (read-only past handoffs).
//   • Closing-manager mode: form with all sections, "Save draft" + "Submit handoff".
//   • Opening-manager mode (after submit): review screen with Acknowledge button,
//     PM notes field appears after ack so they can leave their own notes.
//   • If a manager opens a date with no handoff doc yet, they see a "Start
//     handoff" button that creates the draft.

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc, updateDoc, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { isAdmin, LOCATION_LABELS } from '../data/staff';
import {
    HANDOFF_SECTIONS, HANDOFF_VERSION,
    getBusinessDateKey, handoffDocId, statusOf, statusBadge,
} from '../data/shiftHandoff';

export default function ShiftHandoff({ language, staffName, staffList, storeLocation }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const adminUser = isAdmin(staffName, staffList);
    const me = (staffList || []).find(s => s.name === staffName);
    const isManager = adminUser || (me && /manager/i.test(me.role || ''));

    // The location this handoff is scoped to. For "both"-location admins
    // we fall back to webster but offer a switcher (handled at App level
    // via storeLocation). The doc always lands at a concrete location.
    const concreteLocation = storeLocation === 'both' ? 'webster' : storeLocation;

    const today = getBusinessDateKey();
    const [viewDate, setViewDate] = useState(today);
    const [handoff, setHandoff] = useState(null);
    const [loading, setLoading] = useState(true);
    // Local form state — debounced to Firestore on save
    const [draft, setDraft] = useState({});
    const [pmNotes, setPmNotes] = useState('');
    const [savedAt, setSavedAt] = useState(null);

    const docRef = useMemo(
        () => doc(db, 'shift_handoffs', handoffDocId(viewDate, concreteLocation)),
        [viewDate, concreteLocation]
    );

    useEffect(() => {
        setLoading(true);
        const unsub = onSnapshot(docRef, (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                setHandoff(data);
                setDraft(data.sections || {});
                setPmNotes(data.pmNotes || '');
            } else {
                setHandoff(null);
                setDraft({});
                setPmNotes('');
            }
            setLoading(false);
        }, (err) => { console.error('Handoff subscribe:', err); setLoading(false); });
        return unsub;
    }, [docRef]);

    const status = statusOf(handoff);
    const badge = statusBadge(status, isEs);

    // Who can do what:
    // - Anyone with isManager can author/submit/acknowledge a handoff at this
    //   location (matches the operator reality — first manager in opens, regardless
    //   of who was scheduled).
    // - Editing past handoffs is admin-only (audit integrity).
    const isPast = viewDate < today;
    const canEdit = isManager && (!isPast || adminUser);
    const canAuthor = canEdit && (status === 'none' || status === 'draft');
    const canSubmit = canEdit && (status === 'none' || status === 'draft');
    const canAcknowledge = canEdit && status === 'submitted';
    const canEditPmNotes = canEdit && status === 'acknowledged';

    // Notification fanout — every other manager at this location, plus admins.
    const handoffNotifyTargets = useMemo(() => {
        return (staffList || [])
            .filter(s => s.name !== staffName)
            .filter(s => storeLocation === 'both' || s.location === concreteLocation || s.location === 'both')
            .filter(s => isAdmin(s.name, staffList) || /manager/i.test(s.role || ''))
            .map(s => s.name);
    }, [staffList, staffName, storeLocation, concreteLocation]);

    const notifyManagers = async (type, title, body) => {
        const link = '/handoff';
        await Promise.all(handoffNotifyTargets.map(forStaff =>
            addDoc(collection(db, 'notifications'), {
                forStaff, type, title, body, link,
                createdAt: serverTimestamp(),
                read: false,
                createdBy: staffName,
            }).catch(e => console.warn('Handoff notify failed (non-fatal):', e))
        ));
    };

    // Save the draft to Firestore. Runs on every section blur (and Save Draft tap).
    const saveDraft = async (nextSections = draft) => {
        if (!canAuthor) return;
        try {
            await setDoc(docRef, {
                date: viewDate,
                location: concreteLocation,
                sections: nextSections,
                authoredBy: staffName,
                updatedAt: new Date().toISOString(),
                version: HANDOFF_VERSION,
                ...(handoff?.startedAt ? {} : { startedAt: new Date().toISOString() }),
            }, { merge: true });
            setSavedAt(new Date());
        } catch (e) {
            console.error('Save draft failed:', e);
        }
    };

    const submitHandoff = async () => {
        if (!canSubmit) return;
        const hasContent = Object.values(draft).some(v => (v || '').trim().length > 0);
        if (!hasContent && !confirm(tx(
            'No sections filled out. Submit anyway? (Useful if everything was uneventful.)',
            'Sin secciones llenas. ¿Enviar igual? (Útil si todo fue normal.)'
        ))) return;
        try {
            await setDoc(docRef, {
                date: viewDate,
                location: concreteLocation,
                sections: draft,
                authoredBy: staffName,
                submittedBy: staffName,
                submittedAt: new Date().toISOString(),
                version: HANDOFF_VERSION,
            }, { merge: true });
            const dateLabel = viewDate;
            notifyManagers(
                'handoff_submitted',
                isEs ? `📤 Handoff enviado: ${dateLabel}` : `📤 Handoff submitted: ${dateLabel}`,
                isEs
                    ? `${staffName} envió el handoff de cierre. Tóquelo para revisar y confirmar.`
                    : `${staffName} submitted the closing handoff. Tap to review and acknowledge.`
            );
        } catch (e) {
            console.error('Submit handoff failed:', e);
            alert(tx('Could not submit: ', 'No se pudo enviar: ') + e.message);
        }
    };

    const acknowledgeHandoff = async () => {
        if (!canAcknowledge) return;
        try {
            await updateDoc(docRef, {
                acknowledgedBy: staffName,
                acknowledgedAt: new Date().toISOString(),
            });
            // Ping the closer so they know it landed.
            if (handoff?.submittedBy && handoff.submittedBy !== staffName) {
                addDoc(collection(db, 'notifications'), {
                    forStaff: handoff.submittedBy,
                    type: 'handoff_acknowledged',
                    title: isEs ? `✅ Handoff recibido` : `✅ Handoff acknowledged`,
                    body: isEs
                        ? `${staffName} confirmó el handoff de ${viewDate}.`
                        : `${staffName} acknowledged the ${viewDate} handoff.`,
                    link: '/handoff',
                    createdAt: serverTimestamp(),
                    read: false,
                    createdBy: staffName,
                }).catch(() => {});
            }
        } catch (e) {
            console.error('Acknowledge failed:', e);
            alert(tx('Could not acknowledge: ', 'No se pudo confirmar: ') + e.message);
        }
    };

    const savePmNotes = async (text) => {
        if (!canEditPmNotes) return;
        try {
            await updateDoc(docRef, { pmNotes: text, pmNotesBy: staffName, pmNotesAt: new Date().toISOString() });
        } catch (e) { console.error('PM notes save failed:', e); }
    };

    const updateSection = (id, value) => {
        setDraft(prev => ({ ...prev, [id]: value }));
    };

    // ── Render ────────────────────────────────────────────────────────
    if (!isManager) {
        return (
            <div className="p-4 pb-bottom-nav">
                <p className="text-center text-gray-400 mt-8 text-sm">
                    {tx('Manager-only view.', 'Vista solo para gerentes.')}
                </p>
            </div>
        );
    }

    return (
        <div className="p-4 pb-bottom-nav md:p-5 max-w-3xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div>
                    <h2 className="text-2xl font-bold text-mint-700">🤝 {tx('Shift Handoff', 'Entrega de Turno')}</h2>
                    <p className="text-xs text-gray-500">
                        {LOCATION_LABELS[concreteLocation] || concreteLocation}
                        {' · '}
                        {tx('Closer → next-morning opener', 'Cierre → apertura del día siguiente')}
                    </p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-bold border ${badge.color}`}>
                    {badge.emoji} {tx(badge.labelEn, badge.labelEs)}
                </span>
            </div>

            {/* Date picker — scroll back through history */}
            <div className="flex items-center gap-2 mb-3 bg-gray-50 rounded-lg p-2 border border-gray-200">
                <label className="text-xs font-bold text-gray-700">
                    📅 {tx('Date', 'Fecha')}
                </label>
                <input type="date" value={viewDate} onChange={e => setViewDate(e.target.value)}
                    max={today}
                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm" />
                {viewDate !== today && (
                    <button onClick={() => setViewDate(today)}
                        className="text-xs text-mint-700 font-bold underline">
                        {tx('Today', 'Hoy')}
                    </button>
                )}
            </div>

            {loading ? (
                <p className="text-center text-gray-400 mt-8 text-sm">{tx('Loading…', 'Cargando…')}</p>
            ) : (
                <>
                    {/* Status banner — different copy per state */}
                    {status === 'none' && (
                        <div className="mb-3 p-3 rounded-xl bg-amber-50 border-2 border-amber-200 text-sm text-amber-900">
                            {isPast
                                ? tx('No handoff was submitted for this date.',
                                     'No se envió handoff para esta fecha.')
                                : tx('No handoff yet for this date. Start one when you\'re ready to close out.',
                                     'Sin handoff todavía. Inícialo cuando estés listo para cerrar.')}
                        </div>
                    )}
                    {status === 'submitted' && (
                        <div className="mb-3 p-3 rounded-xl bg-blue-50 border-2 border-blue-300 text-sm text-blue-900">
                            <p className="font-bold mb-1">📤 {tx('Submitted', 'Enviado')}</p>
                            <p className="text-xs">
                                {tx(`Closed by ${handoff.submittedBy} · ${new Date(handoff.submittedAt).toLocaleString()}`,
                                   `Cerrado por ${handoff.submittedBy} · ${new Date(handoff.submittedAt).toLocaleString()}`)}
                            </p>
                            <p className="text-xs mt-1">
                                {tx('Awaiting acknowledgment from the next-morning manager.',
                                    'Esperando confirmación del gerente de la mañana.')}
                            </p>
                        </div>
                    )}
                    {status === 'acknowledged' && (
                        <div className="mb-3 p-3 rounded-xl bg-green-50 border-2 border-green-300 text-sm text-green-900">
                            <p className="font-bold mb-1">✅ {tx('Acknowledged', 'Recibido')}</p>
                            <p className="text-xs">
                                {tx(`Closed by ${handoff.submittedBy}, acknowledged by ${handoff.acknowledgedBy} · ${new Date(handoff.acknowledgedAt).toLocaleString()}`,
                                    `Cerrado por ${handoff.submittedBy}, recibido por ${handoff.acknowledgedBy} · ${new Date(handoff.acknowledgedAt).toLocaleString()}`)}
                            </p>
                        </div>
                    )}

                    {/* Sections */}
                    <div className="space-y-2">
                        {HANDOFF_SECTIONS.map(sec => {
                            const value = canAuthor ? (draft[sec.id] || '') : (handoff?.sections?.[sec.id] || '');
                            const hasContent = (value || '').trim().length > 0;
                            return (
                                <div key={sec.id} className={`rounded-xl border-2 overflow-hidden ${
                                    hasContent ? 'border-mint-300 bg-white' : 'border-gray-200 bg-gray-50'
                                }`}>
                                    <div className="px-3 py-2 border-b border-gray-200 bg-white">
                                        <div className="flex items-center gap-2">
                                            <span className="text-lg">{sec.emoji}</span>
                                            <h3 className="font-bold text-sm text-gray-800">{tx(sec.labelEn, sec.labelEs)}</h3>
                                            {hasContent && <span className="text-[10px] text-mint-700 font-bold">●</span>}
                                        </div>
                                        <p className="text-[10px] text-gray-500 mt-0.5">{tx(sec.promptEn, sec.promptEs)}</p>
                                    </div>
                                    <div className="p-2">
                                        {canAuthor ? (
                                            <textarea
                                                value={value}
                                                onChange={e => updateSection(sec.id, e.target.value)}
                                                onBlur={() => saveDraft({ ...draft, [sec.id]: draft[sec.id] || '' })}
                                                placeholder={tx('Type here…', 'Escribe aquí…')}
                                                rows={3}
                                                className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm" />
                                        ) : value ? (
                                            <p className="text-sm text-gray-800 whitespace-pre-wrap p-1">{value}</p>
                                        ) : (
                                            <p className="text-xs text-gray-400 italic p-1">
                                                {tx('— left blank —', '— en blanco —')}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {/* PM notes — appears after acknowledgment */}
                    {(status === 'acknowledged' || canEditPmNotes) && (
                        <div className="mt-3 rounded-xl border-2 border-emerald-300 bg-emerald-50 overflow-hidden">
                            <div className="px-3 py-2 border-b border-emerald-200 bg-white">
                                <h3 className="font-bold text-sm text-emerald-900">📝 {tx('Morning manager notes', 'Notas de mañana')}</h3>
                                <p className="text-[10px] text-emerald-700 mt-0.5">
                                    {tx('Added by the opener after acknowledging — closes the loop with the closer.',
                                        'Agregadas por el gerente de mañana — cierran el ciclo con el de cierre.')}
                                </p>
                            </div>
                            <div className="p-2">
                                {canEditPmNotes ? (
                                    <textarea value={pmNotes}
                                        onChange={e => setPmNotes(e.target.value)}
                                        onBlur={() => savePmNotes(pmNotes)}
                                        placeholder={tx('e.g. handled 86\'d items, called the appliance repair, etc.',
                                                       'p.ej. resolví los items 86, llamé al técnico, etc.')}
                                        rows={3}
                                        className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm" />
                                ) : (
                                    <p className="text-sm text-gray-800 whitespace-pre-wrap p-1">
                                        {handoff?.pmNotes || tx('— no notes —', '— sin notas —')}
                                    </p>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Action buttons — context-sensitive */}
                    <div className="mt-4 flex gap-2 flex-wrap">
                        {canAuthor && (
                            <>
                                <button onClick={() => saveDraft()}
                                    className="flex-1 min-w-[120px] py-2 rounded-lg bg-gray-200 text-gray-700 font-bold text-sm">
                                    💾 {tx('Save draft', 'Guardar borrador')}
                                </button>
                                <button onClick={submitHandoff}
                                    className="flex-1 min-w-[160px] py-2 rounded-lg bg-mint-700 text-white font-bold text-sm hover:bg-mint-800">
                                    📤 {tx('Submit handoff', 'Enviar handoff')}
                                </button>
                            </>
                        )}
                        {canAcknowledge && (
                            <button onClick={acknowledgeHandoff}
                                className="w-full py-3 rounded-lg bg-green-600 text-white font-bold hover:bg-green-700">
                                ✅ {tx('Acknowledge — I\'ve got it', 'Confirmar recibido')}
                            </button>
                        )}
                    </div>

                    {savedAt && canAuthor && (
                        <p className="text-[10px] text-gray-400 text-right mt-1">
                            {tx('Saved', 'Guardado')} {savedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                        </p>
                    )}
                </>
            )}
        </div>
    );
}
