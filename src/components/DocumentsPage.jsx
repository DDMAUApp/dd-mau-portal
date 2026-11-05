// Documents tab: a staff member's own onboarding papers. See staffDocuments.js for
// the privacy rule. Everything below the query works from the one record that query
// and pickLinkedHire return, and file paths are built only from that record's id.
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import {
    collection, query, where, onSnapshot, doc, updateDoc, addDoc, writeBatch,
    arrayUnion, deleteField, serverTimestamp,
} from 'firebase/firestore';
import { ref as sref, listAll } from 'firebase/storage';
import { db, storage } from '../firebase';
import { docsForHire, DOC_STATUS, DOC_STATUS_META } from '../data/onboarding';
import { verifyPortalPassword, hashPortalPassword } from '../data/onboardingAuth';
import {
    pickLinkedHire, classifyDocFiles, canUpdateDoc, resubmitPatch, hasEarlierVersion, isUploadDoc, passwordMode,
    nextTryState, suggestHire, olderVersionLabel, PASSWORD_SETUP_MS,
} from '../data/staffDocuments';
import { TEST_MODE } from '../data/testMode';
import { isSharedDeviceModeEnabled } from '../messaging';
import { notifyAdmins } from '../data/notify';
import { toast } from '../toast';
import DocumentFileViewer from './DocumentFileViewer';

const DocCard = lazy(() => import('./OnboardingPortal').then(m => ({ default: m.DocCard })));

const RELOCK_AFTER_HIDDEN_MS = 2 * 60e3;

const audit = (action, details) => addDoc(collection(db, 'onboarding_audits'), { action, at: serverTimestamp(), ...details })
    .catch((e) => console.warn('documents audit write failed', e?.code));

const Card = ({ children }) => <div className="bg-white rounded-2xl border border-gray-200 p-5 text-center text-sm text-gray-700">{children}</div>;

// ── Password ────────────────────────────────────────────────────────────────
function Gate({ hire, isEs, byName, onUnlock }) {
    const tx = (en, es) => (isEs ? es : en);
    const mode = passwordMode(hire);
    const [pw, setPw] = useState('');
    const [pw2, setPw2] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const triesKey = `ddmau:docsTries:${hire.id}`;
    const readTries = () => { try { return JSON.parse(localStorage.getItem(triesKey)) || {}; } catch { return {}; } };
    const writeTries = (s) => { try { localStorage.setItem(triesKey, JSON.stringify(s)); } catch { /* still works, just forgets */ } };

    const submit = async (e) => {
        e.preventDefault();
        if (busy) return;
        setErr('');
        if (mode === 'create') {
            if (pw.length < 6) { setErr(tx('Use at least 6 characters.', 'Usa al menos 6 caracteres.')); return; }
            if (pw !== pw2) { setErr(tx("Passwords don't match.", 'Las contraseñas no coinciden.')); return; }
            setBusy(true);
            try {
                const portalAuth = await hashPortalPassword(pw);
                await updateDoc(doc(db, 'onboarding_hires', hire.id), { portalAuth, documentsPasswordSetUntil: deleteField() });
                audit('documents_password_set', { hireId: hire.id, by: byName });
                onUnlock();
            } catch {
                setErr(tx('Could not save. Try again.', 'No se pudo guardar. Intenta de nuevo.'));
                setBusy(false);
            }
            return;
        }
        const tries = readTries();
        if ((tries.waitUntil || 0) > Date.now()) {
            setErr(tx('Too many tries. Wait a few minutes.', 'Demasiados intentos. Espera unos minutos.'));
            return;
        }
        setBusy(true);
        const ok = await verifyPortalPassword(pw, hire.portalAuth);
        writeTries(nextTryState(tries, !ok));
        if (ok) { onUnlock(); return; }
        setErr(tx('Wrong password.', 'Contraseña incorrecta.'));
        setPw('');
        setBusy(false);
    };

    if (mode === 'ask-manager') {
        return <Card>{tx(
            'Your documents need a password first. Ask a manager to let you set one.',
            'Tus documentos necesitan una contraseña. Pide a un gerente que te deje crear una.',
        )}</Card>;
    }
    const inputClass = 'w-full px-3 py-3 border border-gray-300 rounded-lg text-base';
    return (
        <form onSubmit={submit} className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3 max-w-md mx-auto">
            <p className="font-bold text-base">🔒 {mode === 'create' ? tx('Make a password', 'Crea una contraseña') : tx('Enter your password', 'Escribe tu contraseña')}</p>
            <p className="text-sm text-gray-600">{mode === 'create'
                ? tx('This protects your documents.', 'Esto protege tus documentos.')
                : tx('This is the password you made when you started onboarding.', 'Es la contraseña que creaste al empezar tu onboarding.')}</p>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete={mode === 'create' ? 'new-password' : 'current-password'} aria-label={tx('Password', 'Contraseña')} className={inputClass} />
            {mode === 'create' && <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" aria-label={tx('Password again', 'Repite la contraseña')} placeholder={tx('Again', 'Otra vez')} className={inputClass} />}
            {err && <p className="text-sm font-bold text-red-700" role="alert">{err}</p>}
            {mode === 'enter' && <p className="text-xs text-gray-500">{tx('Forgot it? A manager can reset it.', '¿La olvidaste? Un gerente puede reiniciarla.')}</p>}
            <button type="submit" disabled={busy || !pw} className="w-full py-3 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">{tx('Open my documents', 'Abrir mis documentos')}</button>
        </form>
    );
}

// ── One document ────────────────────────────────────────────────────────────
function OlderForm({ row, fields, isEs }) {
    const line = olderVersionLabel(Date.parse(row.replacedAt), isEs);
    return (
        <div className="rounded-lg border-2 border-red-300 bg-red-50 p-2">
            <p className="text-[11px] font-bold text-red-700 mb-1">{line}</p>
            {fields(row.values).map(([k, v]) => <p key={k} className="text-xs text-gray-600 line-through decoration-red-300">{k}: {v}</p>)}
        </div>
    );
}

const FORM_LABELS = {
    legalName: ['Legal name', 'Nombre legal'], dob: ['Date of birth', 'Fecha de nacimiento'], phone: ['Phone', 'Teléfono'],
    email: ['Email', 'Correo'], addressLine: ['Address', 'Dirección'], city: ['City', 'Ciudad'], state: ['State', 'Estado'],
    zip: ['ZIP', 'Código postal'], name: ['Contact name', 'Nombre del contacto'], relation: ['Relationship', 'Parentesco'],
};

function DocRow({ docDef, hire, isEs, byName }) {
    const tx = (en, es) => (isEs ? es : en);
    const entry = hire.checklist?.[docDef.id] || {};
    const status = entry.status || DOC_STATUS.NEEDED;
    const meta = DOC_STATUS_META[status] || DOC_STATUS_META.needed;
    const handedIn = status === DOC_STATUS.SUBMITTED || status === DOC_STATUS.APPROVED;
    const [open, setOpen] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [files, setFiles] = useState(null);
    const [viewing, setViewing] = useState(null);
    const startedAt = useRef(0);
    const isForm = docDef.kind === 'form';

    useEffect(() => {
        if (!open || isForm) return undefined;
        let alive = true;
        setFiles(null);
        listAll(sref(storage, `onboarding/${hire.id}/${docDef.id}`))
            .then((list) => {
                if (!alive) return;
                const paths = new Map(list.items.map(i => [i.name, i.fullPath]));
                setFiles(classifyDocFiles(list.items.map(i => i.name), { replacedBefore: entry.replacedBefore })
                    .map(f => ({ ...f, path: paths.get(f.name) })));
            })
            .catch((e) => { console.warn('documents list failed', e?.code); if (alive) setFiles([]); });
        return () => { alive = false; };
    }, [open, isForm, hire.id, docDef.id, entry.replacedBefore, entry.submittedAt]);

    const earlier = hasEarlierVersion(entry);
    // Replacing marks what's there as older. Adding a page (the back of an ID) doesn't.
    const startUpdate = (replace) => { startedAt.current = replace ? Date.now() : 0; setUpdating(true); };
    const done = () => {
        setUpdating(false);
        toast(tx('Sent to your manager for review.', 'Enviado a tu gerente para revisión.'), { kind: 'success' });
    };
    const announce = () => {
        audit('staff_doc_resubmitted', { hireId: hire.id, docId: docDef.id, by: byName });
        notifyAdmins({
            type: 'staff_doc_resubmitted',
            title: `📄 ${byName} updated a document`,
            body: `${docDef.en}: ready for review in Onboarding.`,
            link: '/onboarding',
            tag: `staff_doc_resubmitted:${hire.id}:${docDef.id}`,
            createdBy: 'documents_tab',
        }).catch((e) => console.warn('documents notify failed', e?.code));
    };
    const failed = (e) => {
        console.warn('documents save failed', e?.code);
        toast(tx('Could not save. Try again.', 'No se pudo guardar. Intenta de nuevo.'), { kind: 'error' });
    };

    // The cards report starting as well as submitting. Starting doesn't count here:
    // an approved document stays approved until a new one is actually handed in.
    const onSetStatus = async (docId, next, extra = {}) => {
        if (docId !== docDef.id) return;
        if (next !== DOC_STATUS.SUBMITTED) return;
        try {
            await updateDoc(doc(db, 'onboarding_hires', hire.id), {
                ...resubmitPatch(docId, deleteField(), { extra, replacedBefore: earlier ? startedAt.current : 0, replacing: earlier }),
                lastUpdate: new Date().toISOString(),
            });
            if (earlier) announce();
            done();
        } catch (e) { failed(e); }
    };
    const onSaveForm = async (docId, payload) => {
        if (docId !== docDef.id) return;
        const field = docId === 'personal_info' ? 'personal' : 'emergencyContact';
        const before = hire[field];
        const patch = {
            [field]: payload,
            ...resubmitPatch(docId, deleteField(), { replacing: earlier }),
            lastUpdate: new Date().toISOString(),
        };
        if (before && Object.keys(before).length) {
            patch[`formHistory.${docId}`] = arrayUnion({ values: before, replacedAt: new Date().toISOString() });
        }
        try {
            await updateDoc(doc(db, 'onboarding_hires', hire.id), patch);
            if (earlier) announce();
            done();
        } catch (e) { failed(e); }
    };

    const formFields = (values) => Object.entries(values || {})
        .filter(([k, v]) => FORM_LABELS[k] && v)
        .map(([k, v]) => [tx(...FORM_LABELS[k]), String(v)]);
    const current = docDef.id === 'personal_info' ? hire.personal : docDef.id === 'emergency_contact' ? hire.emergencyContact : null;
    const history = (hire.formHistory?.[docDef.id] || []).slice().reverse();

    return (
        <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <button onClick={() => setOpen(o => !o)} className="w-full p-3 flex items-center gap-3 text-left active:bg-gray-50" aria-expanded={open}>
                <span className="text-2xl" aria-hidden="true">{docDef.emoji}</span>
                <span className="flex-1 min-w-0">
                    <span className="block font-bold text-sm">{isEs ? docDef.es : docDef.en}</span>
                    <span className={`inline-block mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border ${meta.tone}`}>{meta.emoji} {isEs ? meta.es : meta.en}</span>
                </span>
                <span className="text-gray-400" aria-hidden="true">{open ? '▴' : '▾'}</span>
            </button>
            {open && (
                <div className="p-3 border-t border-gray-100 space-y-2">
                    {status === DOC_STATUS.REJECTED && entry.note && <p className="text-xs text-red-700"><b>{tx('Manager note:', 'Nota del gerente:')}</b> {entry.note}</p>}
                    {isForm && formFields(current).map(([k, v]) => <p key={k} className="text-sm"><span className="text-gray-500">{k}:</span> {v}</p>)}
                    {isForm && history.map((row) => <OlderForm key={row.replacedAt} row={row} fields={formFields} isEs={isEs} />)}
                    {!isForm && files === null && <p className="text-xs text-gray-500">{tx('Loading…', 'Cargando…')}</p>}
                    {!isForm && files?.length === 0 && <p className="text-xs text-gray-500">{tx('No files here.', 'Sin archivos.')}</p>}
                    {!isForm && files?.map((f) => (
                        <button key={f.name} onClick={() => { setViewing(f); audit('staff_doc_viewed', { hireId: hire.id, docId: docDef.id, file: f.name, by: byName }); }}
                            className={`w-full text-left p-2 rounded-lg border-2 text-sm font-bold ${f.older ? 'border-red-300 bg-red-50 text-red-800' : 'border-gray-200 bg-gray-50'}`}>
                            {f.older
                                ? olderVersionLabel(f.replacedAt, isEs)
                                : f.line === 'complete' ? tx('Completed by your manager', 'Completado por tu gerente') : tx('Current version', 'Versión actual')}
                            {f.ts > 0 && !f.older && <span className="block text-[11px] font-normal text-gray-500">{new Date(f.ts).toLocaleDateString(isEs ? 'es-US' : 'en-US', { timeZone: 'America/Chicago' })}</span>}
                        </button>
                    ))}
                    {canUpdateDoc(docDef, status) && !updating && (
                        <>
                            <button onClick={() => startUpdate(true)} className="w-full py-2.5 rounded-lg bg-dd-green text-white font-bold text-sm">
                                {earlier ? tx('Edit and resubmit', 'Editar y volver a enviar') : tx('Fill this out', 'Llenar')}
                            </button>
                            {earlier && isUploadDoc(docDef) && (
                                <button onClick={() => startUpdate(false)} className="w-full py-2.5 rounded-lg bg-gray-200 font-bold text-sm">
                                    {tx('Add another page', 'Agregar otra página')}
                                </button>
                            )}
                        </>
                    )}
                    {updating && (
                        <>
                            {earlier && (startedAt.current > 0 || !isUploadDoc(docDef)) && <p className="text-xs text-gray-600">{tx(
                                'Your current version stays saved and gets marked as older. A manager reviews the new one.',
                                'Tu versión actual queda guardada y se marca como anterior. Un gerente revisa la nueva.',
                            )}</p>}
                            <Suspense fallback={<p className="text-xs text-gray-500">{tx('Loading…', 'Cargando…')}</p>}>
                                <DocCard key={`${hire.id}:${docDef.id}`} doc={docDef} hire={{ ...hire, checklist: { ...hire.checklist, [docDef.id]: { ...entry, status: DOC_STATUS.NEEDED } } }}
                                    hireId={hire.id} isEs={isEs} isLocked={false} docOverrides={{}} hideExistingFiles onSaveForm={onSaveForm} onSetStatus={onSetStatus} />
                            </Suspense>
                            <button onClick={() => setUpdating(false)} className="w-full py-2 rounded-lg bg-gray-200 font-bold text-sm">{tx('Cancel', 'Cancelar')}</button>
                        </>
                    )}
                </div>
            )}
            {viewing && <DocumentFileViewer hireId={hire.id} path={viewing.path} title={isEs ? docDef.es : docDef.en} older={viewing.older} replacedAt={viewing.replacedAt} isEs={isEs} onClose={() => setViewing(null)} />}
        </div>
    );
}

// ── The person's own documents ──────────────────────────────────────────────
function MyDocuments({ staffRecord, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const blocked = !!TEST_MODE || isSharedDeviceModeEnabled();
    const [loaded, setLoaded] = useState(blocked);
    const [hires, setHires] = useState([]);
    const [unlockedFor, setUnlockedFor] = useState(null);
    const staffId = staffRecord?.id;

    useEffect(() => {
        setHires([]);
        setUnlockedFor(null);
        if (blocked || staffId === undefined || staffId === null) { setLoaded(true); return undefined; }
        setLoaded(false);
        return onSnapshot(
            query(collection(db, 'onboarding_hires'), where('documentsLink.staffId', '==', staffId)),
            (snap) => { setHires(snap.docs.map(d => ({ ...d.data(), id: d.id }))); setLoaded(true); },
            (e) => { console.warn('documents listen failed', e?.code); setHires([]); setLoaded(true); },
        );
    }, [blocked, staffId]);

    const hire = useMemo(() => pickLinkedHire(hires, staffRecord), [hires, staffRecord]);
    const hireId = hire?.id;
    const unlocked = !!hireId && unlockedFor === hireId;

    useEffect(() => {
        if (!unlocked) return undefined;
        let hiddenAt = 0;
        const onVis = () => {
            if (document.hidden) { hiddenAt = Date.now(); return; }
            if (hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_HIDDEN_MS) setUnlockedFor(null);
        };
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, [unlocked]);

    const docs = useMemo(() => (hire ? docsForHire(hire) : []), [hire]);

    if (TEST_MODE) return <Card>{tx('Documents are not shown in test mode.', 'Los documentos no se muestran en modo de prueba.')}</Card>;
    if (blocked) return <Card>{tx('For privacy, open Documents on your own phone, not a shared iPad.', 'Por privacidad, abre Documentos en tu propio teléfono, no en un iPad compartido.')}</Card>;
    if (!loaded) return <Card>{tx('Loading…', 'Cargando…')}</Card>;
    if (!hire) return <Card>{tx('No documents on file. Ask a manager.', 'No hay documentos. Pregunta a un gerente.')}</Card>;
    if (!unlocked) return <Gate key={hire.id} hire={hire} isEs={isEs} byName={staffRecord.name} onUnlock={() => setUnlockedFor(hire.id)} />;
    return (
        <div key={hire.id} className="space-y-2">
            {docs.map(d => <DocRow key={`${hire.id}:${d.id}`} docDef={d} hire={hire} isEs={isEs} byName={staffRecord.name} />)}
        </div>
    );
}

// ── The owner's match list ──────────────────────────────────────────────────
function MatchList({ staffList, confirmedBy, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const [hires, setHires] = useState(null);
    const [picked, setPicked] = useState({});
    const [busy, setBusy] = useState(null);
    useEffect(() => onSnapshot(collection(db, 'onboarding_hires'),
        (snap) => setHires(snap.docs.map(d => ({ ...d.data(), id: d.id }))),
        (e) => { console.warn('match list failed', e?.code); setHires([]); }), []);

    const staff = useMemo(() => (Array.isArray(staffList) ? staffList : [])
        .slice().sort((a, b) => String(a.name).localeCompare(String(b.name))), [staffList]);

    if (!hires) return <Card>{tx('Loading…', 'Cargando…')}</Card>;
    const labelOf = (h) => `${h.personal?.legalName || h.name}${h.status === 'archived' ? tx(' (archived)', ' (archivado)') : ''}${h.hireDate ? ` · ${h.hireDate}` : ''} · ${h.location || ''}`;
    const run = async (id, fn, okText) => {
        setBusy(id);
        try { await fn(); if (okText) toast(okText, { kind: 'success' }); }
        catch (e) { console.warn('match write failed', e?.code); toast(tx('Could not save. Try again.', 'No se pudo guardar.'), { kind: 'error' }); }
        finally { setBusy(null); }
    };
    const confirm = (person, hire) => run(person.id, async () => {
        const batch = writeBatch(db);
        hires.filter(h => h.id !== hire.id && String(h.documentsLink?.staffId) === String(person.id))
            .forEach(h => batch.update(doc(db, 'onboarding_hires', h.id), { documentsLink: deleteField() }));
        batch.update(doc(db, 'onboarding_hires', hire.id), {
            documentsLink: { staffId: person.id, staffName: person.name, confirmedBy, confirmedAt: new Date().toISOString() },
        });
        await batch.commit();
        audit('documents_link_confirmed', { hireId: hire.id, staffId: person.id, by: confirmedBy });
    });
    const remove = (person, hire) => run(person.id, async () => {
        await updateDoc(doc(db, 'onboarding_hires', hire.id), { documentsLink: deleteField() });
        audit('documents_link_removed', { hireId: hire.id, staffId: person.id, by: confirmedBy });
    });
    const allowPassword = (person, hire) => run(person.id, async () => {
        await updateDoc(doc(db, 'onboarding_hires', hire.id), { documentsPasswordSetUntil: new Date(Date.now() + PASSWORD_SETUP_MS).toISOString() });
        audit('documents_password_allowed', { hireId: hire.id, by: confirmedBy });
    }, tx(`${person.name} can make a password for the next 24 hours.`, `${person.name} puede crear una contraseña durante 24 horas.`));

    const linkedCount = staff.filter(p => pickLinkedHire(hires, p)).length;
    return (
        <div className="space-y-2">
            <p className="text-sm text-gray-700">{tx(`${linkedCount} of ${staff.length} confirmed. Nobody sees a document until their pair is confirmed here.`, `${linkedCount} de ${staff.length} confirmados. Nadie ve un documento hasta confirmar su pareja aquí.`)}</p>
            {staff.map((person) => {
                const claims = hires.filter(h => String(h.documentsLink?.staffId) === String(person.id));
                const linked = pickLinkedHire(hires, person);
                const stale = !linked && claims.length > 0;
                const suggestion = linked ? null : suggestHire(person, hires);
                const chosenId = picked[person.id] ?? suggestion?.hire?.id ?? '';
                const found = hires.find(h => h.id === chosenId);
                const chosen = found && (!found.documentsLink || String(found.documentsLink.staffId) === String(person.id)) ? found : null;
                return (
                    <div key={String(person.id)} className={`bg-white rounded-xl border p-3 ${linked ? 'border-green-300' : 'border-gray-200'}`}>
                        <p className="font-bold text-sm">{person.name}</p>
                        {linked ? (
                            <>
                                <p className="text-xs text-green-800 mt-0.5">✓ {labelOf(linked)}</p>
                                <div className="flex gap-2 mt-2">
                                    <button disabled={busy === person.id} onClick={() => remove(person, linked)} className="px-3 py-2 rounded-lg bg-gray-200 text-xs font-bold">{tx('Remove', 'Quitar')}</button>
                                    {passwordMode(linked) === 'ask-manager' && <button disabled={busy === person.id} onClick={() => allowPassword(person, linked)} className="px-3 py-2 rounded-lg bg-amber-500 text-white text-xs font-bold">{tx('Let them set a password', 'Permitir crear contraseña')}</button>}
                                </div>
                            </>
                        ) : (
                            <>
                                {stale && <p className="text-xs font-bold text-red-700 mt-0.5">{tx('Link no longer matches (name changed or two records). Confirm again.', 'El enlace ya no coincide. Confirma de nuevo.')}</p>}
                                {suggestion?.several && <p className="text-xs font-bold text-amber-700 mt-0.5">{tx('More than one record has this name. Check the date.', 'Hay más de un registro con este nombre. Revisa la fecha.')}</p>}
                                <div className="flex gap-2 mt-2">
                                    <select value={chosenId} aria-label={tx(`Onboarding record for ${person.name}`, `Registro de ${person.name}`)} onChange={e => setPicked(p => ({ ...p, [person.id]: e.target.value }))} className="flex-1 min-w-0 px-2 py-2 border border-gray-300 rounded-lg text-xs bg-white">
                                        <option value="">{tx('No match', 'Sin pareja')}</option>
                                        {hires.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map((h) => {
                                            const taken = h.documentsLink && String(h.documentsLink.staffId) !== String(person.id);
                                            return <option key={h.id} value={h.id} disabled={!!taken}>{labelOf(h)}{taken ? tx(' (taken)', ' (ocupado)') : ''}</option>;
                                        })}
                                    </select>
                                    <button disabled={!chosen || busy === person.id} onClick={() => confirm(person, chosen)} className="px-3 py-2 rounded-lg bg-dd-green text-white text-xs font-bold disabled:opacity-40">{tx('Confirm', 'Confirmar')}</button>
                                </div>
                            </>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export default function DocumentsPage({ language = 'en', staffRecord, staffList, isAdmin = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [view, setView] = useState('mine');
    const showMatch = isAdmin && !TEST_MODE && view === 'match';
    return (
        <div className="max-w-2xl mx-auto p-3 space-y-3">
            <h1 className="text-xl font-black">{tx('Documents', 'Documentos')}</h1>
            {isAdmin && !TEST_MODE && (
                <div className="flex gap-2">
                    {[['mine', tx('My documents', 'Mis documentos')], ['match', tx('Match staff', 'Emparejar personal')]].map(([k, label]) => (
                        <button key={k} onClick={() => setView(k)} aria-pressed={view === k} className={`px-3 py-2 rounded-lg text-sm font-bold ${view === k ? 'bg-dd-green text-white' : 'bg-gray-200'}`}>{label}</button>
                    ))}
                </div>
            )}
            {showMatch
                ? <MatchList staffList={staffList} confirmedBy={staffRecord?.name} isEs={isEs} />
                : <MyDocuments key={String(staffRecord?.id)} staffRecord={staffRecord} isEs={isEs} />}
        </div>
    );
}

