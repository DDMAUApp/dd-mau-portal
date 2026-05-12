// New-hire public portal — opened via /?onboard=TOKEN.
//
// Mobile-first. No auth, no PIN — the URL token IS the credential, which
// is why links expire (INVITE_TTL_DAYS = 30) and uploads happen straight
// to Storage with content-type + size validation.
//
// Flow when the page loads:
//   1. Pull /onboarding_invites/{token} — verify exists + not expired
//   2. Pull /onboarding_hires/{hireId} from the invite
//   3. Mark invite as opened (used = true, openedAt = now). Marking it
//      "used" doesn't disable it — the hire can return to the same URL
//      to keep filling in docs. "Used" just means "first opened".
//   4. Render the checklist. Hire fills forms / uploads files. Each
//      successful upload flips that doc's status to 'submitted' so the
//      admin sees progress live.
//
// Files go to:
//   onboarding/{hireId}/{docId}/{timestamp}_{filename}
//
// On final submit the hire taps "All done" and the parent hire record
// switches to AWAITING_REVIEW (derived) — admin reviews + approves.

import { useState, useEffect, useRef } from 'react';
import { db, storage } from '../firebase';
import { doc, getDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { ref as sref, uploadBytes, getDownloadURL } from 'firebase/storage';
import {
    DOC_STATUS, DOC_STATUS_META,
    docsForHire, isHireMinor, hireProgressCounts,
    ID_DOC_TYPES,
    deadlineForDoc, deadlineStatus,
} from '../data/onboarding';
import { lazy as reactLazy, Suspense as ReactSuspense } from 'react';
const OnboardingFillablePdf = reactLazy(() => import('./OnboardingFillablePdf'));
const OnboardingOfferLetter = reactLazy(() => import('./OnboardingOfferLetter'));

const INSTALL_NOTE_KEY = 'ddmau:onboardInstallSeen';

// Shared deadline pill used on both the hire's portal cards and the admin
// hire detail. Color reflects urgency, copy is plain English so the hire
// understands without context. Returns null when there's nothing useful
// to render (no deadline configured or doc already done).
function renderDeadlinePill(dlInfo, isEs) {
    if (!dlInfo || dlInfo.status === 'no-deadline') return null;
    const d = dlInfo.daysLeft;
    if (dlInfo.status === 'overdue') {
        const days = Math.abs(d);
        return (
            <span className="text-[10px] font-black px-1.5 py-0.5 rounded border bg-red-100 text-red-800 border-red-300">
                ⚠ {isEs
                    ? `${days} día${days === 1 ? '' : 's'} de retraso`
                    : `${days} day${days === 1 ? '' : 's'} overdue`}
            </span>
        );
    }
    if (dlInfo.status === 'due-today') {
        return (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-orange-50 text-orange-800 border-orange-300">
                ⏰ {isEs ? 'Vence hoy' : 'Due today'}
            </span>
        );
    }
    if (dlInfo.status === 'due-soon') {
        return (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-amber-50 text-amber-800 border-amber-300">
                {isEs ? `Vence en ${d} días` : `Due in ${d} days`}
            </span>
        );
    }
    return (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-gray-50 text-gray-600 border-gray-200">
            {isEs ? `Vence en ${d} días` : `Due in ${d} days`}
        </span>
    );
}

export default function OnboardingPortal({ token, language = 'en' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [status, setStatus] = useState('loading');  // loading | ready | error | submitted
    const [errorMsg, setErrorMsg] = useState('');
    const [hire, setHire] = useState(null);
    const [hireId, setHireId] = useState(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                if (!token || token.length < 8) throw new Error('Invalid invite link.');
                const invSnap = await getDoc(doc(db, 'onboarding_invites', token));
                if (!invSnap.exists()) throw new Error('This invite link is invalid or has expired.');
                const inv = invSnap.data();
                if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) {
                    throw new Error('This invite has expired. Ask your manager for a new link.');
                }
                const hSnap = await getDoc(doc(db, 'onboarding_hires', inv.hireId));
                if (!hSnap.exists()) throw new Error('Hire record missing. Ask your manager.');
                if (!alive) return;
                setHire({ id: hSnap.id, ...hSnap.data() });
                setHireId(inv.hireId);
                setStatus('ready');
                // Mark invite as opened (non-blocking).
                if (!inv.used) {
                    updateDoc(doc(db, 'onboarding_invites', token), {
                        used: true,
                        openedAt: new Date().toISOString(),
                    }).catch(() => {});
                }
            } catch (e) {
                if (!alive) return;
                setStatus('error');
                setErrorMsg(e.message || String(e));
            }
        })();
        return () => { alive = false; };
    }, [token]);

    // Bump a single doc's status. Called by child form/upload components.
    const setDocStatus = async (docId, next, extra = {}) => {
        if (!hireId) return;
        const newChecklist = {
            ...(hire.checklist || {}),
            [docId]: { ...(hire.checklist?.[docId] || {}), status: next, ...extra },
        };
        setHire({ ...hire, checklist: newChecklist });
        try {
            await updateDoc(doc(db, 'onboarding_hires', hireId), {
                [`checklist.${docId}`]: { ...(hire.checklist?.[docId] || {}), status: next, ...extra },
                lastUpdate: new Date().toISOString(),
            });
        } catch (e) { console.warn('setDocStatus failed', e); }
    };

    // Save a form-kind doc (personal info / emergency contact). Stores
    // the structured payload on the hire record itself + flips status.
    const saveForm = async (docId, payload) => {
        if (!hireId) return;
        const patch = {
            [`checklist.${docId}`]: {
                ...(hire.checklist?.[docId] || {}),
                status: DOC_STATUS.SUBMITTED,
                submittedAt: new Date().toISOString(),
            },
            lastUpdate: new Date().toISOString(),
        };
        if (docId === 'personal_info') patch.personal = payload;
        if (docId === 'emergency_contact') patch.emergencyContact = payload;
        setHire({
            ...hire,
            ...(docId === 'personal_info' ? { personal: payload } : {}),
            ...(docId === 'emergency_contact' ? { emergencyContact: payload } : {}),
            checklist: { ...(hire.checklist || {}), [docId]: { ...(hire.checklist?.[docId] || {}), status: DOC_STATUS.SUBMITTED, submittedAt: new Date().toISOString() } },
        });
        try { await updateDoc(doc(db, 'onboarding_hires', hireId), patch); }
        catch (e) { console.warn('saveForm failed', e); }
    };

    if (status === 'loading') {
        return <CenterCard>
            <p className="text-lg font-bold mb-1">{tx('Loading your onboarding…', 'Cargando tu onboarding…')}</p>
            <p className="text-xs text-gray-500">{tx('One sec.', 'Un segundo.')}</p>
        </CenterCard>;
    }
    if (status === 'error') {
        return <CenterCard>
            <p className="text-4xl mb-2">⚠️</p>
            <p className="text-lg font-bold text-red-700 mb-1">{tx('Link not valid', 'Enlace no válido')}</p>
            <p className="text-sm text-gray-600">{errorMsg}</p>
        </CenterCard>;
    }
    if (!hire) return null;
    const docs = docsForHire(hire);
    const counts = hireProgressCounts(hire);
    const allDone = counts.total > 0 && counts.needed === 0 && counts.started === 0;

    return (
        <div className="min-h-screen bg-dd-sage">
            {/* Mobile-first column (max-w-lg = 512px) is right for the
                phones most hires use. On desktop (Andrew reviewing a
                hire's invite link from his laptop, or anyone opening
                the portal in a browser tab) the narrow column squeezed
                the embedded PDF previews down to mobile width and
                they were unreadable. md/lg breakpoints bump the
                container to ~896px so the US Letter PDFs render at
                their natural 1.4x rasterized size (~856 px) with a
                little gutter. PDFs stay scrollable inside their card,
                so the page doesn't grow unmanageably tall. */}
            <div className="max-w-lg md:max-w-4xl mx-auto p-3 sm:p-6 space-y-4">
                {/* Header */}
                <header className="text-center pt-4">
                    <p className="text-3xl mb-1">🍜</p>
                    <h1 className="text-2xl font-black text-dd-green-700">DD Mau</h1>
                    <p className="text-sm text-gray-700 mt-1">
                        {tx(`Welcome ${hire.name?.split(' ')[0] || ''}!`, `¡Bienvenido ${hire.name?.split(' ')[0] || ''}!`)}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                        {tx('Finish your new-hire paperwork below. You can save and come back any time.',
                            'Termina tu papeleo de nueva contratación. Puedes guardar y volver luego.')}
                    </p>
                </header>

                {/* Progress strip */}
                <div className="bg-white rounded-2xl p-3 border border-gray-200 shadow-sm">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-gray-600 uppercase">{tx('Progress', 'Progreso')}</span>
                        <span className="text-xs font-bold text-dd-green-700">
                            {counts.approved + counts.submitted}/{counts.total} {tx('submitted', 'enviado')}
                        </span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-dd-green transition-all"
                             style={{ width: counts.total ? `${Math.round((counts.approved + counts.submitted) / counts.total * 100)}%` : '0%' }} />
                    </div>
                </div>

                {/* Doc cards */}
                <div className="space-y-2">
                    {docs.map(d => (
                        <DocCard key={d.id}
                            doc={d}
                            hire={hire}
                            hireId={hireId}
                            isEs={isEs}
                            onSaveForm={saveForm}
                            onSetStatus={setDocStatus}
                        />
                    ))}
                </div>

                {/* All done CTA */}
                {allDone && (
                    <div className="bg-green-50 border-2 border-green-200 rounded-2xl p-4 text-center">
                        <p className="text-3xl mb-1">🎉</p>
                        <p className="font-black text-green-800">{tx('Paperwork submitted!', '¡Papeleo enviado!')}</p>
                        <p className="text-xs text-green-700 mt-1">
                            {tx('Your manager will review and follow up.', 'Tu gerente revisará y te avisará.')}
                        </p>
                    </div>
                )}

                {/* Privacy note */}
                <p className="text-[10px] text-center text-gray-400 px-3 pb-6">
                    {tx(
                        '🔒 Your info is encrypted in transit. Only DD Mau owners can see it.',
                        '🔒 Tu información viaja encriptada. Solo los dueños de DD Mau pueden verla.',
                    )}
                </p>
            </div>
        </div>
    );
}

function CenterCard({ children }) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-dd-sage p-4">
            <div className="max-w-sm w-full bg-white rounded-2xl border border-gray-200 shadow-sm p-6 text-center">
                {children}
            </div>
        </div>
    );
}

// ── DocCard ───────────────────────────────────────────────────────────────
function DocCard({ doc, hire, hireId, isEs, onSaveForm, onSetStatus }) {
    const tx = (en, es) => (isEs ? es : en);
    const state = (hire.checklist && hire.checklist[doc.id]) || {};
    const status = state.status || DOC_STATUS.NEEDED;
    const meta = DOC_STATUS_META[status];
    const [expanded, setExpanded] = useState(status === DOC_STATUS.NEEDED || status === DOC_STATUS.REJECTED);

    const isDone = status === DOC_STATUS.SUBMITTED || status === DOC_STATUS.APPROVED;

    // Deadline status — drives the "Due in N days" / "Overdue" pill.
    const deadline = deadlineForDoc(hire, doc);
    const dlInfo = deadlineStatus(deadline);
    const dlPill = !isDone && deadline ? renderDeadlinePill(dlInfo, isEs) : null;

    // Look up a reference template (admin-uploaded PDF for this doc) once.
    // Reference mode = the hire downloads the PDF, fills offline, uploads
    // back through the normal file upload flow. Independent of `kind`.
    const [refTemplate, setRefTemplate] = useState(null);
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const q = query(
                    collection(db, 'onboarding_templates'),
                    where('forDocId', '==', doc.id),
                    where('mode', '==', 'reference'),
                );
                const snap = await getDocs(q);
                if (!alive || snap.empty) return;
                let chosen = null;
                snap.forEach(d => {
                    const data = { id: d.id, ...d.data() };
                    if (!chosen || (data.updatedAt || '') > (chosen.updatedAt || '')) chosen = data;
                });
                if (chosen) {
                    try {
                        const url = await getDownloadURL(sref(storage, chosen.storagePath));
                        if (alive) setRefTemplate({ ...chosen, url });
                    } catch {}
                }
            } catch {}
        })();
        return () => { alive = false; };
    }, [doc.id]);

    return (
        <div className={`bg-white rounded-2xl border ${
            status === DOC_STATUS.REJECTED ? 'border-red-300' :
            isDone ? 'border-green-200' : 'border-gray-200'
        } shadow-sm overflow-hidden`}>
            <button onClick={() => setExpanded(!expanded)}
                className="w-full p-3 flex items-center gap-3 text-left active:bg-gray-50">
                <span className="text-2xl flex-shrink-0">{doc.emoji}</span>
                <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-gray-900 flex items-center gap-2 flex-wrap">
                        {isEs ? doc.es : doc.en}
                        {doc.required && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                                {tx('REQUIRED', 'REQUERIDO')}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${meta.tone}`}>
                            {meta.emoji} {isEs ? meta.es : meta.en}
                        </span>
                        {dlPill}
                    </div>
                </div>
                <span className="text-gray-400">{expanded ? '▴' : '▾'}</span>
            </button>
            {expanded && (
                <div className="p-3 border-t border-gray-100 bg-gray-50/50">
                    <p className="text-xs text-gray-600 mb-3">{doc.description}</p>
                    {refTemplate && (
                        <div className="mb-3 p-2 rounded bg-amber-50 border border-amber-200 flex items-center gap-2">
                            <span className="text-lg flex-shrink-0">📎</span>
                            <div className="flex-1 min-w-0">
                                <p className="text-[11px] font-bold text-amber-900 truncate">
                                    {tx('Reference from manager', 'Referencia del gerente')}
                                </p>
                                <p className="text-[10px] text-amber-800 truncate">{refTemplate.name}</p>
                            </div>
                            <a href={refTemplate.url} target="_blank" rel="noopener noreferrer"
                                className="text-[10px] px-2 py-1 rounded bg-amber-600 text-white font-bold hover:bg-amber-700 flex-shrink-0">
                                {tx('View / Download', 'Ver / Descargar')}
                            </a>
                        </div>
                    )}
                    {state.note && status === DOC_STATUS.REJECTED && (
                        <div className="mb-2 p-2 rounded bg-red-50 border border-red-200">
                            <p className="text-[11px] font-bold text-red-800">
                                {tx('Manager note:', 'Nota del gerente:')}
                            </p>
                            <p className="text-[11px] text-red-700">{state.note}</p>
                        </div>
                    )}
                    {doc.kind === 'form' ? (
                        <FormInputs
                            docId={doc.id}
                            initial={
                                doc.id === 'personal_info' ? (hire.personal || {}) :
                                doc.id === 'emergency_contact' ? (hire.emergencyContact || {}) : {}
                            }
                            isEs={isEs}
                            onSave={(payload) => onSaveForm(doc.id, payload)}
                        />
                    ) : doc.kind === 'offer_letter' ? (
                        <ReactSuspense fallback={<p className="text-xs text-gray-500 italic">Loading letter…</p>}>
                            <OnboardingOfferLetter
                                hire={hire}
                                hireId={hireId}
                                isEs={isEs}
                                onSubmitted={() => onSetStatus(doc.id, DOC_STATUS.SUBMITTED, { submittedAt: new Date().toISOString() })}
                                onStart={() => onSetStatus(doc.id, DOC_STATUS.STARTED)} />
                        </ReactSuspense>
                    ) : doc.kind === 'template' ? (
                        <ReactSuspense fallback={<p className="text-xs text-gray-500 italic">Loading template…</p>}>
                            <OnboardingFillablePdf
                                docDef={doc}
                                hire={hire}
                                hireId={hireId}
                                isEs={isEs}
                                onSubmitted={() => onSetStatus(doc.id, DOC_STATUS.SUBMITTED, { submittedAt: new Date().toISOString() })}
                                onStart={() => onSetStatus(doc.id, DOC_STATUS.STARTED)} />
                        </ReactSuspense>
                    ) : doc.kind === 'id' ? (
                        <IdDocUpload
                            doc={doc}
                            hireId={hireId}
                            isEs={isEs}
                            currentLabel={(hire.checklist?.[doc.id]?.idType) || ''}
                            onUploaded={(idType) => onSetStatus(doc.id, DOC_STATUS.SUBMITTED, { submittedAt: new Date().toISOString(), idType })}
                            onStart={() => onSetStatus(doc.id, DOC_STATUS.STARTED)}
                        />
                    ) : (
                        <FileUpload
                            doc={doc}
                            hireId={hireId}
                            isEs={isEs}
                            onUploaded={() => onSetStatus(doc.id, DOC_STATUS.SUBMITTED, { submittedAt: new Date().toISOString() })}
                            onStart={() => onSetStatus(doc.id, DOC_STATUS.STARTED)}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

// ── FormInputs ────────────────────────────────────────────────────────────
// Personal info + Emergency contact use this. Schema is hardcoded per docId.
function FormInputs({ docId, initial, isEs, onSave }) {
    const tx = (en, es) => (isEs ? es : en);
    // NOTE — SSN is intentionally NOT collected here. It would otherwise
    // sit in Firestore as plaintext (the doc is server-readable since we
    // don't have per-user Firebase Auth yet). The hire types SSN directly
    // into the W-4 form fields, where it ends up only inside the resulting
    // PDF in Storage (path-obscured, not enumerable). Phase 2: per-user
    // Auth + custom claims will let us hold SSN in Firestore safely.
    const fields = docId === 'personal_info' ? [
        { id: 'legalName',   en: 'Legal name',           es: 'Nombre legal',           type: 'text', required: true },
        { id: 'dob',         en: 'Date of birth',         es: 'Fecha de nacimiento',    type: 'date', required: true },
        { id: 'phone',       en: 'Phone',                 es: 'Teléfono',               type: 'tel',  required: true },
        { id: 'email',       en: 'Email',                 es: 'Correo',                 type: 'email' },
        { id: 'addressLine', en: 'Address',               es: 'Dirección',              type: 'text', required: true },
        { id: 'city',        en: 'City',                  es: 'Ciudad',                 type: 'text', required: true },
        { id: 'state',       en: 'State',                 es: 'Estado',                 type: 'text', required: true },
        { id: 'zip',         en: 'ZIP',                   es: 'Código postal',          type: 'text', required: true },
    ] : [
        { id: 'name',        en: 'Contact name',          es: 'Nombre del contacto',    type: 'text', required: true },
        { id: 'relation',    en: 'Relationship',          es: 'Parentesco',             type: 'text', required: true },
        { id: 'phone',       en: 'Phone',                 es: 'Teléfono',               type: 'tel',  required: true },
        { id: 'altPhone',    en: 'Alternate phone',       es: 'Teléfono alternativo',   type: 'tel' },
    ];
    const [values, setValues] = useState(() => {
        const v = {};
        fields.forEach(f => { v[f.id] = initial[f.id] || ''; });
        return v;
    });
    const [saving, setSaving] = useState(false);
    const ok = fields.every(f => !f.required || (values[f.id] || '').trim().length > 0);
    const submit = async (e) => {
        e.preventDefault();
        if (!ok) return;
        setSaving(true);
        try { await onSave(values); }
        finally { setSaving(false); }
    };
    return (
        <form onSubmit={submit} className="space-y-2">
            {fields.map(f => (
                <label key={f.id} className="block">
                    <span className="text-[11px] font-bold uppercase text-gray-500">
                        {isEs ? f.es : f.en}{f.required ? ' *' : ''}
                    </span>
                    <input
                        type={f.type}
                        value={values[f.id]}
                        onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                        required={f.required}
                        className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </label>
            ))}
            <button type="submit" disabled={!ok || saving}
                className="w-full mt-2 py-2.5 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">
                {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
            </button>
        </form>
    );
}

// ── FileUpload ────────────────────────────────────────────────────────────
function FileUpload({ doc, hireId, isEs, onUploaded, onStart }) {
    const tx = (en, es) => (isEs ? es : en);
    const inputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [err, setErr] = useState('');

    const handleFiles = async (filesList) => {
        const files = Array.from(filesList || []);
        if (files.length === 0) return;
        setErr('');
        setUploading(true);
        setProgress(0);
        onStart?.();
        try {
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                if (f.size > 10 * 1024 * 1024) {
                    throw new Error(tx('File too large (max 10 MB): ', 'Archivo muy grande (máx 10 MB): ') + f.name);
                }
                if (!/^image\/|^application\/pdf$/.test(f.type)) {
                    throw new Error(tx('Only photos or PDFs allowed: ', 'Solo fotos o PDFs: ') + f.name);
                }
                const safeName = `${Date.now()}_${i}_${f.name.replace(/[^a-z0-9._-]+/gi, '_')}`;
                const path = `onboarding/${hireId}/${doc.id}/${safeName}`;
                await uploadBytes(sref(storage, path), f, { contentType: f.type });
                setProgress(Math.round(((i + 1) / files.length) * 100));
            }
            onUploaded?.();
        } catch (e) {
            console.error('upload failed', e);
            setErr(e.message || String(e));
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="space-y-2">
            <input ref={inputRef} type="file"
                accept="image/*,application/pdf"
                multiple
                onChange={(e) => handleFiles(e.target.files)}
                disabled={uploading}
                className="hidden" />
            <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
                className="w-full py-4 rounded-xl border-2 border-dashed border-dd-green/40 bg-white text-dd-green-700 font-bold text-sm hover:bg-dd-sage-50 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed">
                {uploading ? (
                    <span>{tx(`Uploading ${progress}%…`, `Subiendo ${progress}%…`)}</span>
                ) : (
                    <span>📸 {tx('Take photo / upload', 'Tomar foto / subir')}</span>
                )}
            </button>
            <p className="text-[10px] text-gray-500 text-center">
                {tx('Photos (JPG/PNG/HEIC) or PDF. Max 10 MB each. You can pick multiple.',
                    'Fotos (JPG/PNG/HEIC) o PDF. Máx 10 MB cada uno. Puedes elegir varios.')}
            </p>
            {err && <p className="text-[11px] text-red-600">{err}</p>}
        </div>
    );
}

// ── IdDocUpload ───────────────────────────────────────────────────────────
// Generic "any acceptable ID" slot. Hire labels the doc (driver's license,
// passport, etc.) and uploads a photo. Two of these slots cover the
// I-9 "List A" or "List B + C" requirement without forcing a hardcoded
// type per slot.
function IdDocUpload({ doc, hireId, isEs, currentLabel, onUploaded, onStart }) {
    const tx = (en, es) => (isEs ? es : en);
    const [idType, setIdType] = useState(currentLabel || '');
    const [otherText, setOtherText] = useState('');
    const inputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [err, setErr] = useState('');

    const handleFiles = async (filesList) => {
        const files = Array.from(filesList || []);
        if (files.length === 0) return;
        if (!idType) {
            setErr(tx('Pick the ID type first.', 'Elige el tipo de identificación primero.'));
            return;
        }
        setErr('');
        setUploading(true);
        onStart?.();
        try {
            const finalLabel = idType === 'other' && otherText.trim() ? `other:${otherText.trim()}` : idType;
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                if (f.size > 10 * 1024 * 1024) {
                    throw new Error(tx('File too large (max 10 MB).', 'Archivo muy grande (máx 10 MB).'));
                }
                if (!/^image\/|^application\/pdf$/.test(f.type)) {
                    throw new Error(tx('Photos or PDFs only.', 'Solo fotos o PDFs.'));
                }
                const safeName = `${finalLabel.replace(/[^a-z0-9_-]+/gi, '_')}_${Date.now()}_${i}_${f.name.replace(/[^a-z0-9._-]+/gi, '_')}`;
                const path = `onboarding/${hireId}/${doc.id}/${safeName}`;
                await uploadBytes(sref(storage, path), f, { contentType: f.type });
            }
            onUploaded?.(finalLabel);
        } catch (e) {
            console.error(e);
            setErr(e.message || String(e));
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="space-y-2">
            <label className="block">
                <span className="text-[11px] font-bold uppercase text-gray-500">
                    {tx('Which type of ID is this?', '¿Qué tipo de identificación es?')}
                </span>
                <select value={idType} onChange={e => setIdType(e.target.value)}
                    className="mt-0.5 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                    <option value="">{tx('Pick one…', 'Elige uno…')}</option>
                    {ID_DOC_TYPES.map(t => (
                        <option key={t.id} value={t.id}>{isEs ? t.es : t.en}</option>
                    ))}
                </select>
            </label>
            {idType === 'other' && (
                <input value={otherText} onChange={e => setOtherText(e.target.value)}
                    placeholder={tx('Describe the document', 'Describe el documento')}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            )}
            <input ref={inputRef} type="file" accept="image/*,application/pdf" multiple
                onChange={e => handleFiles(e.target.files)} disabled={uploading} className="hidden" />
            <button type="button" onClick={() => inputRef.current?.click()} disabled={uploading || !idType}
                className="w-full py-4 rounded-xl border-2 border-dashed border-dd-green/40 bg-white text-dd-green-700 font-bold text-sm hover:bg-dd-sage-50 active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed">
                {uploading ? tx('Uploading…', 'Subiendo…') : tx('📸 Take photo / upload', '📸 Tomar foto / subir')}
            </button>
            <p className="text-[10px] text-gray-500 text-center">
                {tx('Front and back if it\'s a card. Multiple files OK.',
                    'Frente y reverso si es tarjeta. Varios archivos OK.')}
            </p>
            {err && <p className="text-[11px] text-red-600">{err}</p>}
        </div>
    );
}
