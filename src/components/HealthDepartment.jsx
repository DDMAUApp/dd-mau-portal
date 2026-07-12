// Health Department & Compliance (Andrew 2026-07-12).
//
// An active compliance operating system, not an info page:
//   • STAFF view — my Hep A shots + required docs; smart upload (photo
//     of the vaccine card → aiExtractHealthDoc reads the shot dates →
//     confirm → record self-fills); read-and-sign required documents.
//   • MANAGER view (canManageHealth) — roster auto-populated from the
//     admin staff list: hired date, shot 1, shot 2, docs signed, and a
//     status badge; click a row → that staff's record window (files,
//     signatures, manual date entry/verify, remind button).
//   • INSPECTION view — clean printable summary for a health inspector.
//
// Data: /health_records/{staffId} (see src/data/health.js) + Storage
// under health/{staffId}/. Records are never deleted (rules-enforced).
import { useState, useEffect, useMemo, useRef } from 'react';
import { db, storage } from '../firebase';
import { collection, onSnapshot } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { canManageHealth } from '../data/staff';
import {
    complianceStatus, hepA2Due, hepA2DueDateStr, buildAttentionQueue,
    EXEMPTION_WAIVER, upsertHealthRecord, loadHealthDocsConfig,
    extractHealthDoc,
} from '../data/health';
import { notifyStaff } from '../data/notify';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';
import { PageHeader } from '../v2/PageShell';
import {
    HeartPulse, Syringe, FileSignature, Upload, CheckCircle2, AlertTriangle,
    Clock, Users, Printer, ChevronRight, Bell, ShieldCheck,
} from 'lucide-react';

const fmtDate = (s, isEs) => {
    if (!s) return '—';
    try {
        return new Date(s + (s.length === 10 ? 'T00:00:00' : '')).toLocaleDateString(isEs ? 'es' : 'en', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch { return s; }
};

// ── Status pill ──────────────────────────────────────────────────────
function StatusPill({ status, isEs }) {
    if (status.complete) {
        return <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-dd-sage-50 text-dd-green-700 border border-dd-green/40">
            <CheckCircle2 size={11} /> {isEs ? 'Completo' : 'Complete'}</span>;
    }
    return <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
        <AlertTriangle size={11} /> {status.missing.length} {isEs ? 'pendiente(s)' : 'missing'}</span>;
}

// ── Smart upload flow (staff or manager-on-behalf) ──────────────────
function UploadCard({ staffId, staffName, byName, language, onSaved }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [busy, setBusy] = useState('');           // '' | 'uploading' | 'reading'
    const [extract, setExtract] = useState(null);   // AI result awaiting confirm
    const [pending, setPending] = useState(null);   // {url, path, name}
    const fileRef = useRef(null);

    const onFile = async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setBusy('uploading');
        try {
            const path = `health/${staffId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
            const sref = storageRef(storage, path);
            await uploadBytes(sref, file, { contentType: file.type || 'image/jpeg' });
            const url = await getDownloadURL(sref);
            setPending({ url, path, name: file.name });
            if ((file.type || '').startsWith('image/')) {
                setBusy('reading');
                try {
                    const res = await extractHealthDoc([url]);
                    setExtract(res);
                } catch (err) {
                    console.warn('health extract failed:', err?.message);
                    setExtract({ docType: 'other', notes: 'auto-read unavailable — enter dates manually below' });
                }
            } else {
                setExtract({ docType: 'other', notes: 'PDF stored — enter dates manually below' });
            }
        } catch (err) {
            console.error('health upload failed:', err);
            toast(tx('Upload failed — try again', 'Error al subir — intenta de nuevo'));
        } finally {
            setBusy('');
        }
    };

    const confirmSave = async (useDates) => {
        try {
            await upsertHealthRecord(staffId, staffName, (rec) => {
                rec.files = [...(rec.files || []), {
                    url: pending.url, path: pending.path, label: pending.name,
                    kind: extract?.docType || 'other',
                    uploadedAt: new Date().toISOString(), uploadedBy: byName,
                    extracted: extract || null,
                }];
                if (useDates) {
                    rec.hepA = { ...(rec.hepA || {}) };
                    if (extract?.hepAShot1Date && !rec.hepA.shot1Date) rec.hepA.shot1Date = extract.hepAShot1Date;
                    if (extract?.hepAShot2Date && !rec.hepA.shot2Date) rec.hepA.shot2Date = extract.hepAShot2Date;
                }
                return rec;
            }, byName);
            toast(useDates && (extract?.hepAShot1Date || extract?.hepAShot2Date)
                ? tx('✅ Card saved — shot dates filled in automatically', '✅ Tarjeta guardada — fechas de vacuna llenadas automáticamente')
                : tx('✅ Document saved', '✅ Documento guardado'));
            setExtract(null); setPending(null);
            onSaved?.();
        } catch (err) {
            console.error('health record save failed:', err);
            toast(tx('Save failed — try again', 'Error al guardar'));
        }
    };

    return (
        <div className="glass-card p-4">
            <div className="flex items-center gap-2 mb-2">
                <Upload size={16} className="text-dd-green-700" />
                <h3 className="font-bold text-dd-text text-sm">{tx('Upload vaccine card / document', 'Subir tarjeta de vacunas / documento')}</h3>
            </div>
            <p className="text-xs text-dd-text-2 mb-3">
                {tx('Take a photo of your Hepatitis A vaccination card — the dates fill in automatically.',
                    'Toma una foto de tu tarjeta de vacunación de Hepatitis A — las fechas se llenan automáticamente.')}
            </p>
            <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" onChange={onFile} />
            <button onClick={() => fileRef.current?.click()} disabled={!!busy}
                className="glass-button-primary w-full py-3 rounded-xl font-bold text-sm disabled:opacity-60">
                {busy === 'uploading' ? tx('Uploading…', 'Subiendo…')
                    : busy === 'reading' ? tx('🤖 Reading the card…', '🤖 Leyendo la tarjeta…')
                    : tx('📷 Take / choose photo', '📷 Tomar / elegir foto')}
            </button>

            {extract && pending && (
                <div className="mt-3 p-3 rounded-xl bg-dd-bg border border-dd-line">
                    <p className="text-xs font-bold text-dd-text mb-1.5">
                        {extract.docType === 'hepA_card' ? tx('✅ Hep A card detected', '✅ Tarjeta de Hep A detectada')
                            : extract.docType === 'unreadable' ? tx('⚠️ Could not read the photo', '⚠️ No se pudo leer la foto')
                            : tx('Document uploaded', 'Documento subido')}
                        {extract.confidence && extract.docType === 'hepA_card' && (
                            <span className="ml-1 font-normal text-dd-text-2">({tx('confidence', 'confianza')}: {extract.confidence})</span>
                        )}
                    </p>
                    {(extract.hepAShot1Date || extract.hepAShot2Date) && (
                        <div className="text-sm text-dd-text space-y-0.5 mb-2">
                            {extract.hepAShot1Date && <div>💉 {tx('Shot 1', 'Dosis 1')}: <b>{fmtDate(extract.hepAShot1Date, isEs)}</b></div>}
                            {extract.hepAShot2Date && <div>💉 {tx('Shot 2', 'Dosis 2')}: <b>{fmtDate(extract.hepAShot2Date, isEs)}</b></div>}
                        </div>
                    )}
                    {extract.notes && <p className="text-[11px] text-dd-text-2 mb-2">{extract.notes}</p>}
                    <div className="flex gap-2">
                        <button onClick={() => confirmSave(true)} className="glass-button-primary flex-1 py-2 rounded-lg text-sm font-bold">
                            {(extract.hepAShot1Date || extract.hepAShot2Date)
                                ? tx('Looks right — save', 'Correcto — guardar')
                                : tx('Save document', 'Guardar documento')}
                        </button>
                        <button onClick={() => { setExtract(null); setPending(null); }}
                            className="glass-button-apple px-3 py-2 rounded-lg text-sm">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Read-and-sign modal for a required doc ──────────────────────────
function SignDocModal({ docDef, staffId, staffName, language, onClose, onSigned }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [typedName, setTypedName] = useState('');
    const [scrolledToEnd, setScrolledToEnd] = useState(false);
    const bodyRef = useRef(null);
    const onScroll = () => {
        const el = bodyRef.current;
        if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setScrolledToEnd(true);
    };
    // Short docs may not scroll at all — count as read.
    useEffect(() => {
        const el = bodyRef.current;
        if (el && el.scrollHeight <= el.clientHeight + 8) setScrolledToEnd(true);
    }, []);
    const canSign = scrolledToEnd && typedName.trim().toLowerCase() === staffName.trim().toLowerCase();
    const sign = async () => {
        try {
            await upsertHealthRecord(staffId, staffName, (rec) => {
                rec.docs = { ...(rec.docs || {}), [docDef.key]: {
                    signedAt: new Date().toISOString(),
                    signedName: typedName.trim(),
                    docTitle: docDef.title,
                    version: docDef.version || 1,
                } };
                return rec;
            }, staffName);
            toast(tx('✍️ Signed', '✍️ Firmado'));
            onSigned?.(); onClose();
        } catch { toast(tx('Sign failed — try again', 'Error al firmar')); }
    };
    return (
        <ModalPortal>
            <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3" onClick={onClose} role="dialog" aria-modal="true">
                <div className="glass-sheet bg-white w-full max-w-md rounded-2xl p-4 shadow-2xl flex flex-col" style={{ maxHeight: '85dvh' }} onClick={(e) => e.stopPropagation()}>
                    <h3 className="font-bold text-dd-text mb-2">{isEs ? (docDef.titleEs || docDef.title) : docDef.title}</h3>
                    <div ref={bodyRef} onScroll={onScroll}
                        className="flex-1 overflow-y-auto text-sm text-dd-text whitespace-pre-wrap border border-dd-line rounded-xl p-3 bg-dd-bg mb-3">
                        {isEs ? (docDef.bodyEs || docDef.body) : docDef.body}
                    </div>
                    {!scrolledToEnd && <p className="text-[11px] text-amber-700 mb-2">{tx('Scroll to the end to sign', 'Desplázate hasta el final para firmar')}</p>}
                    <input value={typedName} onChange={(e) => setTypedName(e.target.value)}
                        placeholder={tx(`Type your full name: ${staffName}`, `Escribe tu nombre completo: ${staffName}`)}
                        className="glass-input w-full mb-2 text-base" />
                    <div className="flex gap-2">
                        <button onClick={sign} disabled={!canSign}
                            className="glass-button-primary flex-1 py-2.5 rounded-xl font-bold text-sm disabled:opacity-50">
                            {tx('I have read and agree — Sign', 'He leído y acepto — Firmar')}
                        </button>
                        <button onClick={onClose} className="glass-button-apple px-4 py-2.5 rounded-xl text-sm">{tx('Close', 'Cerrar')}</button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}

// ── Hep A exemption / declination waiver modal ──────────────────────
// E-signed alternative to the two-dose record (Immuware-style
// declination): pick medical or religious, read the waiver, type your
// name. Writes hepA.exempt with a full audit payload.
function ExemptionModal({ staffId, staffName, language, onClose, onSigned }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [exType, setExType] = useState('');
    const [typedName, setTypedName] = useState('');
    const [scrolledToEnd, setScrolledToEnd] = useState(false);
    const bodyRef = useRef(null);
    const onScroll = () => {
        const el = bodyRef.current;
        if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setScrolledToEnd(true);
    };
    useEffect(() => {
        const el = bodyRef.current;
        if (el && el.scrollHeight <= el.clientHeight + 8) setScrolledToEnd(true);
    }, []);
    const canSign = exType && scrolledToEnd && typedName.trim().toLowerCase() === staffName.trim().toLowerCase();
    const sign = async () => {
        try {
            await upsertHealthRecord(staffId, staffName, (rec) => {
                rec.hepA = { ...(rec.hepA || {}), exempt: true, exemption: {
                    type: exType,
                    signedAt: new Date().toISOString(),
                    signedName: typedName.trim(),
                    waiverVersion: EXEMPTION_WAIVER.version,
                } };
                return rec;
            }, staffName);
            toast(tx('✍️ Exemption signed', '✍️ Exención firmada'));
            onSigned?.(); onClose();
        } catch { toast(tx('Sign failed — try again', 'Error al firmar')); }
    };
    return (
        <ModalPortal>
            <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3" onClick={onClose} role="dialog" aria-modal="true">
                <div className="glass-sheet bg-white w-full max-w-md rounded-2xl p-4 shadow-2xl flex flex-col" style={{ maxHeight: '85dvh' }} onClick={(e) => e.stopPropagation()}>
                    <h3 className="font-bold text-dd-text mb-2">{isEs ? EXEMPTION_WAIVER.titleEs : EXEMPTION_WAIVER.title}</h3>
                    <div className="flex gap-2 mb-2">
                        {[['medical', tx('Medical / titer', 'Médica / títulos')], ['religious', tx('Religious', 'Religiosa')]].map(([k, label]) => (
                            <button key={k} onClick={() => setExType(k)}
                                className={`flex-1 px-3 py-2 rounded-lg text-sm font-bold border transition ${exType === k ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    <div ref={bodyRef} onScroll={onScroll}
                        className="flex-1 overflow-y-auto text-sm text-dd-text whitespace-pre-wrap border border-dd-line rounded-xl p-3 bg-dd-bg mb-3">
                        {isEs ? EXEMPTION_WAIVER.bodyEs : EXEMPTION_WAIVER.body}
                    </div>
                    {!scrolledToEnd && <p className="text-[11px] text-amber-700 mb-2">{tx('Scroll to the end to sign', 'Desplázate hasta el final para firmar')}</p>}
                    <input value={typedName} onChange={(e) => setTypedName(e.target.value)}
                        placeholder={tx(`Type your full name: ${staffName}`, `Escribe tu nombre completo: ${staffName}`)}
                        className="glass-input w-full mb-2 text-base" />
                    <div className="flex gap-2">
                        <button onClick={sign} disabled={!canSign}
                            className="glass-button-primary flex-1 py-2.5 rounded-xl font-bold text-sm disabled:opacity-50">
                            {tx('Sign exemption', 'Firmar exención')}
                        </button>
                        <button onClick={onClose} className="glass-button-apple px-4 py-2.5 rounded-xl text-sm">{tx('Close', 'Cerrar')}</button>
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}

// ── Staff self-view ──────────────────────────────────────────────────
function MyHealth({ me, myRecord, docsConfig, language, refresh }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [signingDoc, setSigningDoc] = useState(null);
    const [showExemption, setShowExemption] = useState(false);
    const status = complianceStatus(myRecord, docsConfig);
    const shot2Due = hepA2Due(myRecord);
    const rec = myRecord || {};
    return (
        <div className="space-y-4 max-w-lg">
            {/* Status summary */}
            <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                    <h3 className="font-bold text-dd-text text-sm flex items-center gap-1.5"><ShieldCheck size={16} className="text-dd-green-700" /> {tx('My compliance status', 'Mi estado de cumplimiento')}</h3>
                    <StatusPill status={status} isEs={isEs} />
                </div>
                <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-dd-text"><Syringe size={14} /> {tx('Hep A — Shot 1', 'Hep A — Dosis 1')}</span>
                        {status.hepA1 ? <b className="text-dd-green-700">{fmtDate(rec.hepA?.shot1Date, isEs)}</b>
                            : <span className="text-amber-700 font-bold">{tx('Needed — upload your card', 'Falta — sube tu tarjeta')}</span>}
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-dd-text"><Syringe size={14} /> {tx('Hep A — Shot 2', 'Hep A — Dosis 2')}</span>
                        {status.hepA2 ? <b className="text-dd-green-700">{fmtDate(rec.hepA?.shot2Date, isEs)}</b>
                            : shot2Due ? <span className="text-red-600 font-bold">{tx('DUE now (6+ months since shot 1)', 'PENDIENTE (6+ meses desde la dosis 1)')}</span>
                            : rec.hepA?.shot1Date ? <span className="text-dd-text-2">{tx('Due 6 months after shot 1', '6 meses después de la dosis 1')}</span>
                            : <span className="text-amber-700 font-bold">{tx('Needed', 'Falta')}</span>}
                    </div>
                    {rec.hepA?.exempt ? (
                        <p className="text-[11px] text-dd-text-2 pt-1">
                            ✍️ {tx('Exemption on file', 'Exención registrada')}
                            {rec.hepA?.exemption?.type ? ` (${rec.hepA.exemption.type === 'medical' ? tx('medical', 'médica') : tx('religious', 'religiosa')})` : ''}
                            {rec.hepA?.exemption?.signedAt ? ` · ${fmtDate(rec.hepA.exemption.signedAt.slice(0, 10), isEs)}` : ''}
                        </p>
                    ) : (!status.hepA1 || !status.hepA2) && (
                        <button onClick={() => setShowExemption(true)}
                            className="text-[11px] text-dd-text-2 underline underline-offset-2 pt-1">
                            {tx("Can't be vaccinated? Sign an exemption", '¿No puedes vacunarte? Firma una exención')}
                        </button>
                    )}
                </div>
            </div>

            {/* Upload */}
            <UploadCard staffId={me.id} staffName={me.name} byName={me.name} language={language} onSaved={refresh} />

            {/* Required docs */}
            <div className="glass-card p-4">
                <h3 className="font-bold text-dd-text text-sm flex items-center gap-1.5 mb-2"><FileSignature size={16} className="text-dd-green-700" /> {tx('Required documents', 'Documentos requeridos')}</h3>
                <div className="space-y-2">
                    {(docsConfig || []).map((d) => {
                        const signed = rec.docs?.[d.key]?.signedAt;
                        return (
                            <div key={d.key} className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-dd-bg border border-dd-line">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-dd-text truncate">{isEs ? (d.titleEs || d.title) : d.title}</p>
                                    {signed && <p className="text-[11px] text-dd-green-700">✍️ {tx('Signed', 'Firmado')} {fmtDate(signed.slice(0, 10), isEs)}</p>}
                                </div>
                                {signed
                                    ? <CheckCircle2 size={18} className="text-dd-green-700 flex-shrink-0" />
                                    : <button onClick={() => setSigningDoc(d)} className="glass-button-primary px-3 py-1.5 rounded-lg text-xs font-bold flex-shrink-0">
                                        {tx('Read & sign', 'Leer y firmar')}</button>}
                            </div>
                        );
                    })}
                </div>
            </div>
            {signingDoc && (
                <SignDocModal docDef={signingDoc} staffId={me.id} staffName={me.name} language={language}
                    onClose={() => setSigningDoc(null)} onSigned={refresh} />
            )}
            {showExemption && (
                <ExemptionModal staffId={me.id} staffName={me.name} language={language}
                    onClose={() => setShowExemption(false)} onSigned={refresh} />
            )}
        </div>
    );
}

// ── Manager: one staff's record window ──────────────────────────────
function StaffRecordModal({ person, record, docsConfig, language, byName, onClose, refresh }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const rec = record || {};
    const [hired, setHired] = useState(rec.hiredDate || '');
    const [s1, setS1] = useState(rec.hepA?.shot1Date || '');
    const [s2, setS2] = useState(rec.hepA?.shot2Date || '');
    const [exempt, setExempt] = useState(rec.hepA?.exempt === true);
    const saveDates = async () => {
        try {
            await upsertHealthRecord(person.id, person.name, (r) => {
                r.hiredDate = hired || '';
                r.hepA = { ...(r.hepA || {}), shot1Date: s1 || '', shot2Date: s2 || '', exempt,
                    verifiedBy: byName, verifiedAt: new Date().toISOString() };
                return r;
            }, byName);
            toast(tx('✅ Saved & verified', '✅ Guardado y verificado'));
            refresh(); onClose();
        } catch { toast(tx('Save failed', 'Error al guardar')); }
    };
    const remind = async () => {
        const status = complianceStatus(rec, docsConfig);
        try {
            await notifyStaff({
                forStaff: person.name,
                title: '🏥 Health Department reminder',
                body: `You still need: ${status.missing.map(m => m === 'hepA1' ? 'Hep A shot 1 record' : m === 'hepA2' ? 'Hep A shot 2 record' : 'required document signature').join(', ')}. Open the Health Department tab.`,
                type: 'health_reminder',
                deepLink: 'healthdept',
            });
            toast(tx('🔔 Reminder sent', '🔔 Recordatorio enviado'));
        } catch { toast(tx('Reminder failed', 'Error al enviar')); }
    };
    return (
        <ModalPortal>
            <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3" onClick={onClose} role="dialog" aria-modal="true">
                <div className="glass-sheet bg-white w-full max-w-md rounded-2xl p-4 shadow-2xl overflow-y-auto" style={{ maxHeight: '88dvh' }} onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="font-bold text-dd-text">{person.name}</h3>
                        <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 text-lg">×</button>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mb-3">
                        <label className="text-xs text-dd-text-2">{tx('Date hired', 'Fecha de contratación')}
                            <input type="date" value={hired} onChange={(e) => setHired(e.target.value)} className="glass-input w-full mt-0.5 text-base" /></label>
                        <label className="text-xs text-dd-text-2">{tx('Hep A shot 1', 'Hep A dosis 1')}
                            <input type="date" value={s1} onChange={(e) => setS1(e.target.value)} className="glass-input w-full mt-0.5 text-base" /></label>
                        <label className="text-xs text-dd-text-2">{tx('Hep A shot 2', 'Hep A dosis 2')}
                            <input type="date" value={s2} onChange={(e) => setS2(e.target.value)} className="glass-input w-full mt-0.5 text-base" /></label>
                        <label className="text-xs text-dd-text-2 flex items-end gap-1.5 pb-1.5">
                            <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} className="w-4 h-4" />
                            {tx('Exempt (titer / medical)', 'Exento (títulos / médico)')}</label>
                    </div>
                    {rec.hepA?.exemption?.signedAt && (
                        <p className="text-[11px] text-dd-text-2 mb-1">✍️ {tx('Exemption signed', 'Exención firmada')} ({rec.hepA.exemption.type}) · {rec.hepA.exemption.signedName} · {fmtDate(rec.hepA.exemption.signedAt.slice(0, 10), isEs)}</p>
                    )}
                    {rec.hepA?.verifiedBy && (
                        <p className="text-[11px] text-dd-text-2 mb-2">✓ {tx('Last verified by', 'Verificado por')} {rec.hepA.verifiedBy} · {fmtDate((rec.hepA.verifiedAt || '').slice(0, 10), isEs)}</p>
                    )}
                    <button onClick={saveDates} className="glass-button-primary w-full py-2.5 rounded-xl font-bold text-sm mb-3">
                        {tx('Save & mark verified', 'Guardar y marcar verificado')}</button>

                    {/* Signed docs */}
                    <h4 className="text-xs font-bold text-dd-text-2 uppercase mb-1.5">{tx('Signed documents', 'Documentos firmados')}</h4>
                    <div className="space-y-1.5 mb-3">
                        {(docsConfig || []).map((d) => {
                            const sig = rec.docs?.[d.key];
                            return (
                                <div key={d.key} className="flex items-center justify-between text-sm p-2 rounded-lg bg-dd-bg border border-dd-line">
                                    <span className="text-dd-text truncate">{d.title}</span>
                                    {sig?.signedAt
                                        ? <span className="text-dd-green-700 text-xs font-bold flex-shrink-0">✍️ {fmtDate(sig.signedAt.slice(0, 10), isEs)}</span>
                                        : <span className="text-amber-700 text-xs font-bold flex-shrink-0">{tx('Not signed', 'Sin firmar')}</span>}
                                </div>
                            );
                        })}
                    </div>

                    {/* Files */}
                    <h4 className="text-xs font-bold text-dd-text-2 uppercase mb-1.5">{tx('Uploaded records', 'Registros subidos')} ({(rec.files || []).length})</h4>
                    <div className="space-y-1.5 mb-3">
                        {(rec.files || []).map((f, i) => (
                            <a key={i} href={f.url} target="_blank" rel="noopener noreferrer"
                                className="flex items-center justify-between text-sm p-2 rounded-lg bg-dd-bg border border-dd-line hover:bg-dd-sage-50">
                                <span className="text-dd-text truncate">📄 {f.label || f.kind}</span>
                                <span className="text-[11px] text-dd-text-2 flex-shrink-0">{fmtDate((f.uploadedAt || '').slice(0, 10), isEs)}</span>
                            </a>
                        ))}
                        {(rec.files || []).length === 0 && <p className="text-xs text-dd-text-2">{tx('Nothing uploaded yet', 'Nada subido todavía')}</p>}
                    </div>

                    {/* Upload on behalf + remind */}
                    <UploadCard staffId={person.id} staffName={person.name} byName={byName} language={language} onSaved={refresh} />
                    <button onClick={remind} className="glass-button-apple w-full py-2.5 rounded-xl text-sm font-semibold mt-3 flex items-center justify-center gap-1.5">
                        <Bell size={14} /> {tx('Send reminder to', 'Enviar recordatorio a')} {person.name.split(' ')[0]}
                    </button>
                </div>
            </div>
        </ModalPortal>
    );
}

// ── Main page ────────────────────────────────────────────────────────
export default function HealthDepartment({ language = 'en', staffName = '', staffList = [] }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const me = useMemo(() => (staffList || []).find(s => s?.name === staffName) || null, [staffList, staffName]);
    const canManage = canManageHealth(me);

    const [records, setRecords] = useState({});        // staffId → record
    const [docsConfig, setDocsConfig] = useState(null);
    const [view, setView] = useState('mine');          // 'mine' | 'roster' | 'inspection'
    const [openPerson, setOpenPerson] = useState(null);
    const [refreshTick, setRefreshTick] = useState(0);
    const refresh = () => setRefreshTick(t => t + 1);

    // Live records subscription (whole collection — 64 staff, tiny docs).
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'health_records'), (snap) => {
            const map = {};
            snap.forEach((d) => { map[d.id] = d.data(); });
            setRecords(map);
        }, (err) => console.warn('health_records listener:', err?.code));
        return () => unsub();
    }, []);

    // Docs config (managers seed defaults on first visit).
    useEffect(() => {
        loadHealthDocsConfig({ seedIfMissing: canManage }).then(setDocsConfig).catch(() => setDocsConfig([]));
        // refreshTick: re-pull after signing (config itself rarely changes)
    }, [canManage, refreshTick]);

    // Default managers to the roster view.
    useEffect(() => { if (canManage) setView(v => (v === 'mine' ? 'roster' : v)); }, [canManage]);

    const activeStaff = useMemo(
        () => (staffList || []).filter(s => s && s.name && s.active !== false)
            .slice().sort((a, b) => (a.name || '').localeCompare(b.name || '')),
        [staffList]
    );
    const rows = useMemo(() => activeStaff.map((s) => {
        const rec = records[String(s.id)] || null;
        return { person: s, rec, status: complianceStatus(rec, docsConfig || []), shot2Due: hepA2Due(rec) };
    }), [activeStaff, records, docsConfig]);
    const compliantCount = rows.filter(r => r.status.complete).length;
    const attention = useMemo(() => buildAttentionQueue(rows), [rows]);
    // Per-location compliance (staff with location 'both' count toward each).
    const locStats = useMemo(() => {
        const out = {};
        for (const { person, status } of rows) {
            const locs = person.location === 'both' ? ['webster', 'maryland'] : [person.location || 'webster'];
            for (const l of locs) {
                out[l] = out[l] || { total: 0, ok: 0 };
                out[l].total += 1;
                if (status.complete) out[l].ok += 1;
            }
        }
        return out;
    }, [rows]);

    const myRecord = me ? (records[String(me.id)] || null) : null;

    if (!me) return null;

    return (
        <div className="p-3 sm:p-4">
            <PageHeader icon={HeartPulse} title={tx('Health Department', 'Departamento de Salud')}
                subtitle={canManage
                    ? tx(`${compliantCount}/${rows.length} staff fully compliant`, `${compliantCount}/${rows.length} empleados en cumplimiento`)
                    : tx('Your health records & required documents', 'Tus registros de salud y documentos requeridos')} />

            {canManage && (
                <div className="flex gap-2 mb-4 print:hidden">
                    {[['roster', Users, tx('Staff', 'Personal')], ['mine', HeartPulse, tx('My records', 'Mis registros')], ['inspection', Printer, tx('Inspection view', 'Vista de inspección')]].map(([k, Icon, label]) => (
                        <button key={k} onClick={() => setView(k)}
                            className={`glass-button-tint px-4 rounded-full text-sm font-semibold flex items-center gap-1.5 ${view === k ? 'bg-dd-green text-white' : ''}`}>
                            <Icon size={14} /> {label}
                        </button>
                    ))}
                </div>
            )}

            {(!canManage || view === 'mine') && docsConfig && (
                <MyHealth me={me} myRecord={myRecord} docsConfig={docsConfig} language={language} refresh={refresh} />
            )}

            {canManage && view === 'roster' && (
                <>
                <div className="flex flex-wrap gap-2 mb-3">
                    {Object.entries(locStats).map(([loc, st]) => (
                        <span key={loc} className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full border ${st.ok === st.total ? 'bg-dd-sage-50 text-dd-green-700 border-dd-green/40' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                            {loc === 'webster' ? 'Webster' : loc === 'maryland' ? 'Maryland Heights' : loc}
                            <span className="font-mono">{st.ok}/{st.total}</span>
                            <span className="font-normal">({Math.round((st.ok / Math.max(1, st.total)) * 100)}%)</span>
                        </span>
                    ))}
                </div>
                {attention.length > 0 && (
                    <div className="glass-card p-3 mb-3">
                        <h3 className="text-xs font-bold text-dd-text-2 uppercase mb-2 flex items-center gap-1.5">
                            <Bell size={13} /> {tx('Needs attention', 'Requiere atención')} ({attention.length})
                        </h3>
                        <div className="space-y-1 max-h-56 overflow-y-auto">
                            {attention.map((it, i) => {
                                const person = activeStaff.find(s => s.id === it.id);
                                const label = it.kind === 'hepA1' ? tx('Hep A shot 1 record missing', 'Falta registro de Hep A dosis 1')
                                    : it.kind === 'hepA2' ? (it.overdue
                                        ? tx(`Hep A shot 2 OVERDUE (was due ${fmtDate(it.dueDate, isEs)})`, `Hep A dosis 2 VENCIDA (venció ${fmtDate(it.dueDate, isEs)})`)
                                        : tx(`Hep A shot 2 due ${fmtDate(it.dueDate, isEs)}`, `Hep A dosis 2 vence ${fmtDate(it.dueDate, isEs)}`))
                                    : tx('Required document unsigned', 'Documento requerido sin firmar');
                                return (
                                    <button key={i} onClick={() => person && setOpenPerson(person)}
                                        className="w-full flex items-center justify-between gap-2 text-left text-sm p-2 rounded-lg bg-dd-bg border border-dd-line hover:bg-dd-sage-50">
                                        <span className="font-semibold text-dd-text truncate">{it.name}</span>
                                        <span className={`text-xs flex-shrink-0 ${it.severity === 0 ? 'text-red-600 font-bold' : it.severity === 2 ? 'text-dd-text-2' : 'text-amber-700 font-semibold'}`}>{label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
                <div className="glass-card p-2 sm:p-3 overflow-x-auto">
                    <table className="w-full text-sm min-w-[560px]">
                        <thead>
                            <tr className="text-left text-[11px] uppercase text-dd-text-2 border-b border-dd-line">
                                <th className="py-2 px-2">{tx('Staff', 'Personal')}</th>
                                <th className="py-2 px-2">{tx('Hired', 'Contratado')}</th>
                                <th className="py-2 px-2">{tx('Shot 1', 'Dosis 1')}</th>
                                <th className="py-2 px-2">{tx('Shot 2', 'Dosis 2')}</th>
                                <th className="py-2 px-2">{tx('Docs', 'Docs')}</th>
                                <th className="py-2 px-2">{tx('Status', 'Estado')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(({ person, rec, status, shot2Due }) => (
                                <tr key={person.id} onClick={() => setOpenPerson(person)}
                                    className="border-b border-dd-line/60 cursor-pointer hover:bg-dd-sage-50/60 active:bg-dd-sage-50">
                                    <td className="py-2.5 px-2 font-semibold text-dd-text">{person.name}
                                        <span className="block text-[10px] font-normal text-dd-text-2">{person.role}</span></td>
                                    <td className="py-2.5 px-2 text-dd-text-2">{fmtDate(rec?.hiredDate, isEs)}</td>
                                    <td className="py-2.5 px-2">{status.hepA1 ? <span className="text-dd-green-700 font-semibold">{rec?.hepA?.exempt ? tx('Exempt', 'Exento') : fmtDate(rec?.hepA?.shot1Date, isEs)}</span> : <span className="text-amber-700 font-bold">{tx('Missing', 'Falta')}</span>}</td>
                                    <td className="py-2.5 px-2">{status.hepA2 ? <span className="text-dd-green-700 font-semibold">{rec?.hepA?.exempt ? tx('Exempt', 'Exento') : fmtDate(rec?.hepA?.shot2Date, isEs)}</span> : shot2Due ? <span className="text-red-600 font-bold">{tx('DUE', 'VENCE')}</span> : <span className="text-amber-700 font-bold">{tx('Missing', 'Falta')}</span>}</td>
                                    <td className="py-2.5 px-2">{status.docsSigned}/{status.docsTotal}</td>
                                    <td className="py-2.5 px-2"><StatusPill status={status} isEs={isEs} /> <ChevronRight size={13} className="inline text-dd-text-2" /></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                </>
            )}

            {canManage && view === 'inspection' && (
                <div className="glass-card p-4 bg-white">
                    <div className="flex items-center justify-between mb-3 print:hidden">
                        <p className="text-sm text-dd-text-2">{tx('Clean summary to hand an inspector.', 'Resumen limpio para mostrar a un inspector.')}</p>
                        <button onClick={() => window.print()} className="glass-button-apple px-4 py-2 rounded-full text-sm flex items-center gap-1.5">
                            <Printer size={14} /> {tx('Print', 'Imprimir')}</button>
                    </div>
                    <h2 className="text-lg font-black text-dd-text">DD Mau — Employee Health Compliance Summary</h2>
                    <p className="text-xs text-dd-text-2 mb-3">{tx('Generated', 'Generado')} {new Date().toLocaleDateString()} · {compliantCount}/{rows.length} {tx('fully compliant', 'en cumplimiento total')}</p>
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-[11px] uppercase text-dd-text-2 border-b-2 border-dd-text">
                            <th className="py-1.5 pr-2">Employee</th><th className="py-1.5 pr-2">Hired</th>
                            <th className="py-1.5 pr-2">Hep A #1</th><th className="py-1.5 pr-2">Hep A #2</th>
                            <th className="py-1.5 pr-2">Illness policy signed</th></tr></thead>
                        <tbody>
                            {rows.map(({ person, rec, status }) => (
                                <tr key={person.id} className="border-b border-dd-line/60">
                                    <td className="py-1.5 pr-2 font-semibold">{person.name}</td>
                                    <td className="py-1.5 pr-2">{fmtDate(rec?.hiredDate, false)}</td>
                                    <td className="py-1.5 pr-2">{rec?.hepA?.exempt ? 'Exempt' : fmtDate(rec?.hepA?.shot1Date, false)}</td>
                                    <td className="py-1.5 pr-2">{rec?.hepA?.exempt ? 'Exempt' : fmtDate(rec?.hepA?.shot2Date, false)}</td>
                                    <td className="py-1.5 pr-2">{Object.values(rec?.docs || {}).some(d => d?.signedAt) ? fmtDate((Object.values(rec.docs).find(d => d?.signedAt)?.signedAt || '').slice(0, 10), false) : '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {openPerson && docsConfig && (
                <StaffRecordModal person={openPerson} record={records[String(openPerson.id)] || null}
                    docsConfig={docsConfig} language={language} byName={staffName}
                    onClose={() => setOpenPerson(null)} refresh={refresh} />
            )}
        </div>
    );
}
