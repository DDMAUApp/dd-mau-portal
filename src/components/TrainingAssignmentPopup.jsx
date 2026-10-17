// TrainingAssignmentPopup — "📚 You have new training" pop-up right after
// sign-in (Andrew 2026-10-17: "when she logs in it gives her a pop up
// notification that there is a new lesson").
//
// Shows every OPEN assignment that includes this person, that they haven't
// opened yet (assignment.opened[key]) and haven't passed (training_v2). "Open
// lesson" jumps straight into the module (same deep link as the chat card);
// "Later" hides it until the next sign-in. Mounted once in the app shell, so
// it appears on whatever tab the app opens to.
import { useEffect, useMemo, useState } from 'react';
import { db } from '../firebase';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import ModalPortal from './ModalPortal';
import { ASSIGNMENTS, trainingDocId, toMs, fmtDue } from '../data/trainingAssignments';
import { openTrainingModule } from '../data/trainingDeepLink';
import { MODULES } from '../data/training';

// Pure: which assignments should pop up for this person.
export function newTrainingFor(assignments, staffName, progressModules = {}) {
    if (!staffName) return [];
    const key = trainingDocId(staffName);
    return (assignments || [])
        .filter(a => a && a.status !== 'closed'
            && (a.recipients || []).some(r => trainingDocId(r?.name) === key)
            && !(a.opened && a.opened[key])
            && !progressModules?.[a.moduleId]?.passed)
        .sort((a, b) => (toMs(a.dueAt) || Infinity) - (toMs(b.dueAt) || Infinity));
}

export default function TrainingAssignmentPopup({ staffName, language = 'en' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [assignments, setAssignments] = useState(null);
    const [progress, setProgress] = useState(null);
    const [dismissed, setDismissed] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        if (!staffName) return undefined;
        const q = query(collection(db, ASSIGNMENTS), where('status', '==', 'open'));
        const unsubA = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setAssignments(list);
        }, (e) => console.warn('training popup assignments:', e));
        const unsubP = onSnapshot(doc(db, 'training_v2', trainingDocId(staffName)), (snap) => {
            setProgress(snap.exists() ? (snap.data()?.modules || {}) : {});
        }, (e) => { console.warn('training popup progress:', e); setProgress({}); });
        // Let the home screen paint first — the pop-up lands a moment after sign-in.
        const t = setTimeout(() => setReady(true), 1200);
        return () => { unsubA(); unsubP(); clearTimeout(t); };
    }, [staffName]);

    const items = useMemo(
        () => (assignments && progress ? newTrainingFor(assignments, staffName, progress) : []),
        [assignments, progress, staffName],
    );
    if (!ready || dismissed || items.length === 0) return null;

    const open = (moduleId) => { setDismissed(true); openTrainingModule(moduleId); };
    return (
        <ModalPortal>
            <div className="fixed inset-0 z-[70] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true"
                aria-label={tx('New training assigned', 'Nueva capacitación asignada')}>
                <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl p-5 pb-[calc(env(safe-area-inset-bottom,0px)+20px)]">
                    <div className="text-3xl mb-1">📚</div>
                    <h2 className="text-lg font-black text-dd-text">
                        {items.length === 1
                            ? tx('You have a new lesson', 'Tienes una lección nueva')
                            : tx(`You have ${items.length} new lessons`, `Tienes ${items.length} lecciones nuevas`)}
                    </h2>
                    <p className="text-sm text-dd-text-2 mb-3">{tx('Your manager assigned this training to you.', 'Tu gerente te asignó esta capacitación.')}</p>
                    <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                        {items.map(a => {
                            const m = MODULES.find(x => x.id === a.moduleId);
                            const dueMs = toMs(a.dueAt);
                            return (
                                <div key={a.id} className="rounded-xl border border-dd-line p-3">
                                    <div className="text-[11px] font-bold text-dd-text-2">{a.moduleCode || m?.code}</div>
                                    <div className="font-bold text-dd-text leading-snug">
                                        {m?.icon ? `${m.icon} ` : ''}{isEs ? (a.titleEs || a.titleEn || m?.titleEs) : (a.titleEn || m?.titleEn)}
                                    </div>
                                    {dueMs ? <div className="text-xs font-bold text-amber-700 mt-0.5">{tx('Due', 'Fecha límite')}: {fmtDue(dueMs, language)}</div> : null}
                                    {a.note ? <div className="text-xs text-dd-text-2 mt-1 italic">“{a.note}”</div> : null}
                                    <button type="button" onClick={() => open(a.moduleId)}
                                        className="mt-2 w-full py-2.5 rounded-lg bg-dd-green text-white font-bold text-sm active:scale-[0.99]">
                                        {tx('Open lesson →', 'Abrir lección →')}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    <button type="button" onClick={() => setDismissed(true)}
                        className="mt-3 w-full py-2 rounded-lg text-sm font-bold text-dd-text-2 bg-dd-bg">
                        {tx('Later', 'Después')}
                    </button>
                </div>
            </div>
        </ModalPortal>
    );
}
