// TrainingAssignForm — "assign a training module with a due date" form
// (2026-08-18). Used in two places:
//   • Chat page → "+" action menu → 📚 Assign training (modal)
//   • Admin → Training (inline, above the live roster)
// Sends one DM per person (📚 card that deep-links into the module); the
// roster/tracking lives in TrainingAssignmentsPanel.

import { useEffect, useMemo, useState } from 'react';
import { MODULES } from '../data/training';
import { createAssignment, sendAssignmentDMs, fmtDue } from '../data/trainingAssignments';
import { toast } from '../toast';

export function defaultDueLocal() {
    // 7 days out, 9:00 PM local — typed as a datetime-local value.
    const d = new Date();
    d.setDate(d.getDate() + 7);
    d.setHours(21, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TrainingAssignForm({ staffList = [], language = 'en', staffName = '', staffId = null, isAdminUser = false, onSent = null, onBusyChange = null, compact = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const activeStaff = useMemo(() => (staffList || []).filter(s => s && s.name && s.active !== false), [staffList]);
    const assignable = useMemo(() => MODULES.filter(m => !m.draft || isAdminUser), [isAdminUser]);
    // Default = the newest module this user can actually pick (drafts are
    // admin-only, so a manager never lands on an unselectable value).
    const [moduleId, setModuleId] = useState(() => {
        const list = MODULES.filter(m => !m.draft || isAdminUser);
        return (list.find(m => m.id === 'm18') || list[list.length - 1])?.id || '';
    });
    useEffect(() => {
        if (moduleId && !assignable.some(m => m.id === moduleId)) setModuleId(assignable[assignable.length - 1]?.id || '');
    }, [assignable, moduleId]);
    const [dueLocal, setDueLocal] = useState(defaultDueLocal);
    const [note, setNote] = useState('');
    const [picked, setPicked] = useState(() => new Set(activeStaff.map(s => s.name)));
    const [pickInit, setPickInit] = useState(activeStaff.length > 0);
    useEffect(() => {
        // Staff list can arrive after mount — default to everyone once.
        if (!pickInit && activeStaff.length > 0) { setPicked(new Set(activeStaff.map(s => s.name))); setPickInit(true); }
    }, [activeStaff, pickInit]);
    const [sending, setSending] = useState(null);   // { done, total, name }

    const module = assignable.find(m => m.id === moduleId) || null;
    const sides = useMemo(() => {
        const foh = activeStaff.filter(s => s.scheduleSide === 'foh').map(s => s.name);
        const boh = activeStaff.filter(s => s.scheduleSide === 'boh').map(s => s.name);
        return { foh, boh };
    }, [activeStaff]);
    const togglePick = (name) => setPicked(p => { const n = new Set(p); if (n.has(name)) n.delete(name); else n.add(name); return n; });

    const send = async () => {
        if (!module) { toast(tx('Pick a module', 'Elige un módulo')); return; }
        const dueAt = new Date(dueLocal);
        if (!(dueAt instanceof Date) || Number.isNaN(dueAt.getTime())) { toast(tx('Pick a due date/time', 'Elige fecha y hora límite')); return; }
        if (dueAt.getTime() < Date.now() + 10 * 60_000) { toast(tx('Due time must be in the future', 'La fecha límite debe ser en el futuro')); return; }
        const recipients = activeStaff.filter(s => picked.has(s.name)).map(s => ({ name: s.name, id: s.id ?? null }));
        if (recipients.length === 0) { toast(tx('Pick at least one person', 'Elige al menos una persona')); return; }
        if (module.draft && !confirm(tx(
            `${module.code} is still a DRAFT — staff can't open it until it's published. Send anyway?`,
            `${module.code} sigue en BORRADOR — el personal no podrá abrirlo hasta publicarlo. ¿Enviar igual?`))) return;
        if (!confirm(tx(
            `Send "${module.code} · ${module.titleEn}" to ${recipients.length} people as a chat message, due ${fmtDue(dueAt.getTime(), 'en')}?`,
            `¿Enviar "${module.code} · ${module.titleEs}" a ${recipients.length} personas por chat, fecha límite ${fmtDue(dueAt.getTime(), 'es')}?`))) return;
        setSending({ done: 0, total: recipients.length, name: '' });
        onBusyChange?.(true);
        try {
            const id = await createAssignment({
                moduleId: module.id, moduleCode: module.code, titleEn: module.titleEn, titleEs: module.titleEs,
                dueAt, note, recipients, createdBy: staffName,
            });
            const assignment = { moduleId: module.id, moduleCode: module.code, titleEn: module.titleEn, titleEs: module.titleEs, dueAt: dueAt.getTime(), note, recipients };
            const res = await sendAssignmentDMs({
                assignmentId: id, assignment, fromName: staffName, fromId: staffId,
                onProgress: (done, total, name) => setSending({ done, total, name }),
            });
            toast(tx(`✅ Sent to ${res.ok} of ${recipients.length}${res.failed ? ` (${res.failed} failed — see roster)` : ''}${res.flushErrors ? ' · some delivery stamps did not save (roster may show — for a few)' : ''}`,
                     `✅ Enviado a ${res.ok} de ${recipients.length}${res.failed ? ` (${res.failed} fallaron — ver lista)` : ''}${res.flushErrors ? ' · algunas marcas de envío no se guardaron' : ''}`));
            setNote('');
            onSent?.(id);
        } catch (err) {
            console.error('assignment send failed:', err);
            toast(tx('Send failed: ', 'Error al enviar: ') + (err?.message || err), { kind: 'error' });
        } finally {
            setSending(null);
            onBusyChange?.(false);
        }
    };


    return (
            <div className={compact ? "p-4" : "glass-card p-4 mb-4"}>
                {!compact && <h3 className="font-bold text-[15px] text-dd-text mb-1">📚 {tx('Assign training', 'Asignar capacitación')}</h3>}
                <p className="text-[11px] text-dd-text-2 mb-3">
                    {tx('Everyone you pick gets a chat message with the lesson and a due date. You can watch who opened it, how far they got, and who passed the quiz below.',
                        'Cada persona recibe un mensaje de chat con la lección y una fecha límite. Abajo puedes ver quién lo abrió, cuánto avanzó y quién aprobó el examen.')}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block">
                        <span className="text-xs font-bold text-dd-text-2">{tx('Module', 'Módulo')}</span>
                        <select value={moduleId} onChange={e => setModuleId(e.target.value)} className="mt-1 w-full border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white">
                            {assignable.map(m => <option key={m.id} value={m.id}>{m.code} · {isEs ? m.titleEs : m.titleEn}{m.draft ? ' (DRAFT)' : ''}</option>)}
                        </select>
                        {module && <div className="text-[11px] text-dd-text-2 mt-1">{module.lessons.length} {tx('lessons', 'lecciones')} · {module.quiz?.questions?.length || 0} {tx('quiz questions', 'preguntas')} · ~{module.durationMin} {tx('min', 'min')}{module.draft ? ` · ${tx('DRAFT — publish first', 'BORRADOR — publica primero')}` : ''}</div>}
                    </label>
                    <label className="block">
                        <span className="text-xs font-bold text-dd-text-2">{tx('Due by', 'Fecha límite')}</span>
                        <input type="datetime-local" value={dueLocal} onChange={e => setDueLocal(e.target.value)} className="mt-1 w-full border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white" />
                    </label>
                </div>
                <label className="block mt-3">
                    <span className="text-xs font-bold text-dd-text-2">{tx('Note (optional, goes in the message)', 'Nota (opcional, va en el mensaje)')}</span>
                    <input value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder={tx('e.g. New procedure — please finish before your next shift.', 'ej. Procedimiento nuevo — termínalo antes de tu próximo turno.')}
                        className="mt-1 w-full border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white" />
                </label>
                <div className="mt-3">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                        <span className="text-xs font-bold text-dd-text-2">{tx('Who', 'A quién')} · {picked.size}/{activeStaff.length}</span>
                        <div className="flex gap-1 flex-wrap">
                            <button type="button" onClick={() => setPicked(new Set(activeStaff.map(s => s.name)))} className="text-[11px] font-bold px-2 py-1 rounded-full bg-gray-100">{tx('Everyone', 'Todos')}</button>
                            {sides.foh.length > 0 && <button type="button" onClick={() => setPicked(new Set(sides.foh))} className="text-[11px] font-bold px-2 py-1 rounded-full bg-gray-100">FOH</button>}
                            {sides.boh.length > 0 && <button type="button" onClick={() => setPicked(new Set(sides.boh))} className="text-[11px] font-bold px-2 py-1 rounded-full bg-gray-100">BOH</button>}
                            <button type="button" onClick={() => setPicked(new Set())} className="text-[11px] font-bold px-2 py-1 rounded-full bg-gray-100">{tx('None', 'Nadie')}</button>
                        </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1 max-h-40 overflow-y-auto">
                        {activeStaff.map(s => {
                            const on = picked.has(s.name);
                            return (
                                <button key={s.name} type="button" onClick={() => togglePick(s.name)}
                                    className={`text-[11px] font-bold px-2 py-1 rounded-full border ${on ? 'bg-mint-700 text-white border-mint-700' : 'bg-white text-gray-600 border-gray-300'}`}>
                                    {on ? '✓ ' : ''}{s.name}
                                </button>
                            );
                        })}
                    </div>
                </div>
                <button type="button" onClick={send} disabled={!!sending}
                    className="mt-4 w-full py-3 rounded-xl bg-mint-700 text-white font-black text-sm disabled:opacity-60">
                    {sending
                        ? tx(`Sending ${sending.done}/${sending.total}… ${sending.name}`, `Enviando ${sending.done}/${sending.total}… ${sending.name}`)
                        : tx(`📨 Send to ${picked.size} people`, `📨 Enviar a ${picked.size} personas`)}
                </button>
            </div>

    );
}
