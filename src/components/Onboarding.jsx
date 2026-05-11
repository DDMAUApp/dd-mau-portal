// Onboarding admin dashboard.
//
// Tab is gated client-side by canViewOnboarding(staff) — only Julie + Andrew
// (and any future owner) see it. Three sub-views:
//
//   • Hires      — active onboarding records (invited → in-progress → done)
//   • Applications — lock-screen "Apply" submissions waiting to be converted
//   • Archive    — completed hires kept for compliance retention
//
// PII handling: this component reads/writes Firestore metadata only. The
// raw files (W4, DL, SSN, etc.) sit in Firebase Storage at
//   onboarding/{hireId}/{docId}/...
// and are fetched via short-lived getDownloadURL() calls just-in-time.

import { useState, useEffect, useMemo, useRef } from 'react';
import { db, storage } from '../firebase';
import {
    collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
    serverTimestamp, query, orderBy, getDoc,
} from 'firebase/firestore';
import { ref as sref, listAll, getDownloadURL, getMetadata, deleteObject } from 'firebase/storage';
import {
    ONBOARDING_DOCS, DOC_STATUS, DOC_STATUS_META,
    HIRE_STATUS, HIRE_STATUS_META,
    INVITE_TTL_DAYS, makeInviteToken,
    docsForHire, isHireMinor, deriveHireStatus, hireProgressCounts,
} from '../data/onboarding';

// Lazy-load heavy deps only when needed. JSZip + QRCode are ~150 KB combined;
// no reason to pay for them on every admin page load.
const loadJSZip = () => import('jszip').then(m => m.default || m);
const loadQRCode = () => import('qrcode').then(m => m.default || m);

// Build the invite URL. The new-hire portal reads ?onboard=TOKEN on load
// and bypasses the lock screen.
function buildInviteUrl(token) {
    const base = typeof window !== 'undefined'
        ? window.location.origin + window.location.pathname.replace(/\/$/, '')
        : '';
    return `${base}/?onboard=${token}`;
}

export default function Onboarding({ language, staffName, staffList, storeLocation, onBack }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [view, setView] = useState('hires');          // 'hires' | 'applications' | 'archive'
    const [hires, setHires] = useState([]);
    const [applications, setApplications] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [addOpen, setAddOpen] = useState(false);
    const [inviteSheet, setInviteSheet] = useState(null); // { hire, token, url }
    const [loading, setLoading] = useState(true);

    // Subscribe to hires.
    useEffect(() => {
        const q = query(collection(db, 'onboarding_hires'), orderBy('createdAt', 'desc'));
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setHires(list);
            setLoading(false);
        }, (err) => {
            console.warn('Onboarding hires subscribe error:', err);
            setLoading(false);
        });
        return () => unsub();
    }, []);

    // Subscribe to applications (lock-screen submissions).
    useEffect(() => {
        const q = query(collection(db, 'onboarding_applications'), orderBy('createdAt', 'desc'));
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setApplications(list);
        }, () => {});
        return () => unsub();
    }, []);

    // Audit log helper — every sensitive action gets recorded.
    const writeAudit = async (action, details = {}) => {
        try {
            await addDoc(collection(db, 'onboarding_audits'), {
                action,
                byAdmin: staffName,
                at: serverTimestamp(),
                ...details,
            });
        } catch (e) { console.warn('onboarding audit write failed:', e); }
    };

    // Split active vs archived. The list is short — DD Mau hires a few people
    // a month — so we keep client-side filtering instead of separate queries.
    const activeHires = useMemo(
        () => hires.filter(h => h.status !== HIRE_STATUS.ARCHIVED),
        [hires],
    );
    const archivedHires = useMemo(
        () => hires.filter(h => h.status === HIRE_STATUS.ARCHIVED),
        [hires],
    );

    const visibleList = view === 'archive' ? archivedHires : activeHires;
    const selected = useMemo(
        () => hires.find(h => h.id === selectedId) || null,
        [hires, selectedId],
    );

    // Convert an application into a hire — pre-fills the AddHire modal.
    const [convertPrefill, setConvertPrefill] = useState(null);
    const convertApplication = (app) => {
        setConvertPrefill({
            name: app.name || '',
            email: app.email || '',
            phone: app.phone || '',
            position: app.position || '',
            location: app.location || storeLocation || 'webster',
            sourceApplicationId: app.id,
        });
        setView('hires');
        setAddOpen(true);
    };

    return (
        <div className="space-y-3 p-3 sm:p-4">
            <header className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                    {onBack && (
                        <button onClick={onBack}
                            className="text-[11px] font-bold text-dd-text-2 hover:text-dd-text mb-1 inline-flex items-center gap-1 active:scale-95 transition">
                            ← {tx('Back to Admin', 'Volver a Admin')}
                        </button>
                    )}
                    <h2 className="text-xl sm:text-2xl font-black text-dd-text tracking-tight">
                        🪪 {tx('Onboarding', 'Onboarding')}
                    </h2>
                    <p className="text-xs text-dd-text-2 mt-0.5">
                        {tx('New-hire paperwork — admin only. PII handled server-side.',
                            'Documentos de nueva contratación — solo administradores.')}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {applications.length > 0 && (
                        <span className="text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-200 px-2 py-1 rounded-full">
                            {applications.length} {tx('new application', 'aplicación nueva')}{applications.length !== 1 ? 's' : ''}
                        </span>
                    )}
                    <button
                        onClick={() => { setConvertPrefill(null); setAddOpen(true); }}
                        className="px-3 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green/90 active:scale-95">
                        + {tx('New hire', 'Nueva contratación')}
                    </button>
                </div>
            </header>

            <div className="flex gap-1 bg-dd-bg p-1 rounded-xl w-fit">
                {[
                    { id: 'hires', en: `Active (${activeHires.length})`, es: `Activos (${activeHires.length})` },
                    { id: 'applications', en: `Applications (${applications.length})`, es: `Aplicaciones (${applications.length})` },
                    { id: 'archive', en: `Archive (${archivedHires.length})`, es: `Archivo (${archivedHires.length})` },
                ].map(t => (
                    <button key={t.id}
                        onClick={() => { setView(t.id); setSelectedId(null); }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                            view === t.id
                                ? 'bg-white text-dd-text shadow-sm'
                                : 'text-dd-text-2 hover:text-dd-text'
                        }`}>
                        {isEs ? t.es : t.en}
                    </button>
                ))}
            </div>

            {view === 'applications' ? (
                <ApplicationsList
                    applications={applications}
                    isEs={isEs}
                    onConvert={convertApplication}
                    onDismiss={async (appId) => {
                        if (!confirm(tx('Delete this application?', '¿Eliminar esta aplicación?'))) return;
                        await deleteDoc(doc(db, 'onboarding_applications', appId));
                        writeAudit('application_dismissed', { appId });
                    }}
                />
            ) : loading ? (
                <p className="text-center text-dd-text-2 py-8 text-sm">
                    {tx('Loading…', 'Cargando…')}
                </p>
            ) : visibleList.length === 0 ? (
                <div className="bg-white border border-dd-line rounded-xl p-8 text-center">
                    <p className="text-4xl mb-2">📭</p>
                    <p className="text-sm font-semibold text-dd-text-2">
                        {view === 'archive'
                            ? tx('No archived hires yet.', 'Sin contrataciones archivadas todavía.')
                            : tx('No active onboarding. Tap "New hire" to invite one.',
                                'Sin onboardings activos. Toca "Nueva contratación".')}
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,1fr)_2fr] gap-3">
                    <HireList
                        hires={visibleList}
                        selectedId={selectedId}
                        onSelect={setSelectedId}
                        isEs={isEs}
                    />
                    {selected ? (
                        <HireDetail
                            hire={selected}
                            isEs={isEs}
                            staffName={staffName}
                            onWriteAudit={writeAudit}
                            onArchive={async () => {
                                if (!confirm(tx(
                                    'Archive this hire? They\'re still kept for compliance retention.',
                                    '¿Archivar a esta persona? Se mantiene por cumplimiento.',
                                ))) return;
                                await updateDoc(doc(db, 'onboarding_hires', selected.id), {
                                    status: HIRE_STATUS.ARCHIVED,
                                    archivedAt: new Date().toISOString(),
                                });
                                writeAudit('hire_archived', { hireId: selected.id, hireName: selected.name });
                                setSelectedId(null);
                            }}
                            onResend={async () => {
                                const token = makeInviteToken();
                                const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
                                await setDoc(doc(db, 'onboarding_invites', token), {
                                    hireId: selected.id,
                                    createdAt: new Date().toISOString(),
                                    expiresAt,
                                    used: false,
                                });
                                writeAudit('invite_resent', { hireId: selected.id, token });
                                setInviteSheet({ hire: selected, token, url: buildInviteUrl(token) });
                            }}
                        />
                    ) : (
                        <div className="bg-white border border-dd-line rounded-xl p-8 text-center">
                            <p className="text-sm text-dd-text-2">
                                {tx('Select a hire to view their progress.', 'Selecciona a alguien para ver su progreso.')}
                            </p>
                        </div>
                    )}
                </div>
            )}

            {addOpen && (
                <AddHireModal
                    isEs={isEs}
                    prefill={convertPrefill}
                    storeLocation={storeLocation}
                    staffName={staffName}
                    onClose={() => { setAddOpen(false); setConvertPrefill(null); }}
                    onCreated={async (hire, token) => {
                        setAddOpen(false);
                        setInviteSheet({ hire, token, url: buildInviteUrl(token) });
                        // If converted from an application, clean it up.
                        if (convertPrefill && convertPrefill.sourceApplicationId) {
                            try { await deleteDoc(doc(db, 'onboarding_applications', convertPrefill.sourceApplicationId)); }
                            catch (e) { console.warn('Could not delete source application:', e); }
                        }
                        setConvertPrefill(null);
                        writeAudit('hire_created', { hireId: hire.id, hireName: hire.name });
                    }}
                />
            )}

            {inviteSheet && (
                <InviteSheet
                    hire={inviteSheet.hire}
                    token={inviteSheet.token}
                    url={inviteSheet.url}
                    isEs={isEs}
                    onClose={() => setInviteSheet(null)}
                />
            )}
        </div>
    );
}

// ── HireList ──────────────────────────────────────────────────────────────
function HireList({ hires, selectedId, onSelect, isEs }) {
    return (
        <div className="space-y-1.5">
            {hires.map(h => {
                const counts = hireProgressCounts(h);
                const status = deriveHireStatus(h);
                const meta = HIRE_STATUS_META[status];
                const pct = counts.total === 0 ? 0 : Math.round((counts.approved / counts.total) * 100);
                const isSel = selectedId === h.id;
                return (
                    <button key={h.id}
                        onClick={() => onSelect(h.id)}
                        className={`w-full text-left bg-white border-2 rounded-xl p-3 transition active:scale-[0.99] ${
                            isSel ? 'border-dd-green shadow-sm' : 'border-dd-line hover:border-dd-line/80'
                        }`}>
                        <div className="flex items-start gap-3">
                            <ProgressDonut counts={counts} size={48} />
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-sm text-dd-text truncate">{h.name}</div>
                                <div className="text-[11px] text-dd-text-2 truncate">
                                    {h.position || ''}{h.position && h.location ? ' · ' : ''}{h.location || ''}
                                </div>
                                <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${meta.tone}`}>
                                        {isEs ? meta.es : meta.en}
                                    </span>
                                    <span className="text-[10px] text-dd-text-2">
                                        {pct}% {isEs ? 'completo' : 'done'}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

// ── ProgressDonut ─────────────────────────────────────────────────────────
// SVG donut showing: approved (green) + submitted (purple) + started (amber)
// + needed (gray). Center shows the approved/total fraction.
function ProgressDonut({ counts, size = 64 }) {
    const { total, needed, started, submitted, approved } = counts;
    const r = (size / 2) - 4;
    const c = 2 * Math.PI * r;
    const cx = size / 2, cy = size / 2;
    const slices = [
        { v: approved, color: '#22c55e' },
        { v: submitted, color: '#a855f7' },
        { v: started, color: '#f59e0b' },
        { v: needed, color: '#e5e7eb' },
    ];
    let offset = 0;
    return (
        <svg width={size} height={size} className="flex-shrink-0 -rotate-90">
            <circle cx={cx} cy={cy} r={r} fill="white" stroke="#f3f4f6" strokeWidth="4" />
            {total > 0 && slices.map((s, i) => {
                if (s.v === 0) return null;
                const len = (s.v / total) * c;
                const stroke = (
                    <circle key={i} cx={cx} cy={cy} r={r} fill="none"
                        stroke={s.color} strokeWidth="4"
                        strokeDasharray={`${len} ${c}`} strokeDashoffset={-offset} />
                );
                offset += len;
                return stroke;
            })}
            <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
                fontSize={size * 0.28} fontWeight="700" fill="#111827"
                transform={`rotate(90 ${cx} ${cy})`}>
                {total === 0 ? '–' : `${approved}/${total}`}
            </text>
        </svg>
    );
}

// ── HireDetail ────────────────────────────────────────────────────────────
function HireDetail({ hire, isEs, staffName, onWriteAudit, onArchive, onResend }) {
    const tx = (en, es) => (isEs ? es : en);
    const docs = docsForHire(hire);
    const counts = hireProgressCounts(hire);
    const status = deriveHireStatus(hire);
    const meta = HIRE_STATUS_META[status];
    const minor = isHireMinor(hire);
    const [exporting, setExporting] = useState(false);

    const exportZip = async () => {
        setExporting(true);
        try {
            const JSZip = await loadJSZip();
            const zip = new JSZip();
            // Drop a summary text file at the top of the zip.
            const summary = [
                `DD Mau Onboarding — ${hire.name}`,
                `Generated: ${new Date().toISOString()}`,
                `By admin: ${staffName}`,
                ``,
                `Position: ${hire.position || ''}`,
                `Location: ${hire.location || ''}`,
                `Hire date: ${hire.hireDate || ''}`,
                `Status: ${status}`,
                ``,
                `── Personal info ──`,
                ...Object.entries(hire.personal || {}).map(([k, v]) => `${k}: ${v}`),
                ``,
                `── Emergency contact ──`,
                ...Object.entries(hire.emergencyContact || {}).map(([k, v]) => `${k}: ${v}`),
                ``,
                `── Doc statuses ──`,
                ...docs.map(d => {
                    const st = (hire.checklist?.[d.id]?.status) || DOC_STATUS.NEEDED;
                    return `${d.en}: ${st}`;
                }),
            ].join('\n');
            zip.file('SUMMARY.txt', summary);
            // Walk the Storage folder and pull every uploaded file.
            const folderRef = sref(storage, `onboarding/${hire.id}`);
            const folderList = await listAll(folderRef);
            // listAll only returns one level; recurse into per-doc subfolders.
            const subFolderFiles = await Promise.all(
                folderList.prefixes.map(async (pref) => {
                    const inner = await listAll(pref);
                    return inner.items.map(it => ({ docId: pref.name, item: it }));
                })
            );
            const allItems = subFolderFiles.flat();
            for (const { docId, item } of allItems) {
                try {
                    const url = await getDownloadURL(item);
                    const res = await fetch(url);
                    const blob = await res.blob();
                    zip.file(`${docId}/${item.name}`, blob);
                } catch (e) { console.warn('skip file', item.fullPath, e); }
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            const safeName = String(hire.name).replace(/[^a-z0-9_-]+/gi, '_');
            const stamp = new Date().toISOString().slice(0, 10);
            const dl = document.createElement('a');
            dl.href = URL.createObjectURL(blob);
            dl.download = `onboarding_${safeName}_${stamp}.zip`;
            document.body.appendChild(dl);
            dl.click();
            dl.remove();
            URL.revokeObjectURL(dl.href);
            onWriteAudit('zip_exported', { hireId: hire.id, hireName: hire.name });
        } catch (e) {
            console.error('Export failed:', e);
            alert(tx('Export failed: ', 'Falló la exportación: ') + (e.message || e));
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="bg-white border border-dd-line rounded-xl overflow-hidden">
            <div className="p-3 border-b border-dd-line bg-dd-bg flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <div className="text-lg font-black text-dd-text">{hire.name}</div>
                    <div className="text-[11px] text-dd-text-2">
                        {hire.position || ''}{hire.position && hire.location ? ' · ' : ''}{hire.location || ''}
                        {hire.hireDate ? ` · ${isEs ? 'inicia' : 'starts'} ${hire.hireDate}` : ''}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${meta.tone}`}>
                            {isEs ? meta.es : meta.en}
                        </span>
                        {minor && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                                🧒 {tx('Minor', 'Menor')}
                            </span>
                        )}
                        <span className="text-[10px] text-dd-text-2">
                            {counts.approved}/{counts.total} {tx('approved', 'aprobados')} · {counts.submitted} {tx('to review', 'por revisar')}
                        </span>
                    </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                    <button onClick={onResend}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 font-bold hover:bg-blue-200">
                        ↻ {tx('Resend invite', 'Reenviar invitación')}
                    </button>
                    <button onClick={exportZip} disabled={exporting}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg bg-dd-green text-white font-bold hover:bg-dd-green/90 disabled:opacity-60">
                        {exporting ? tx('Building zip…', 'Creando zip…') : tx('📦 Export zip', '📦 Exportar zip')}
                    </button>
                    {status !== HIRE_STATUS.ARCHIVED && (
                        <button onClick={onArchive}
                            className="text-[11px] px-2.5 py-1.5 rounded-lg bg-gray-200 text-gray-700 font-bold hover:bg-gray-300">
                            🗂 {tx('Archive', 'Archivar')}
                        </button>
                    )}
                </div>
            </div>
            {/* Personal + emergency snapshot */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 border-b border-dd-line">
                <div className="bg-dd-bg rounded-lg p-2">
                    <div className="text-[10px] font-bold uppercase text-dd-text-2 mb-1">
                        {tx('Personal', 'Personal')}
                    </div>
                    {hire.personal ? (
                        <dl className="text-[11px] space-y-0.5">
                            {Object.entries(hire.personal).map(([k, v]) => (
                                <div key={k} className="flex gap-2">
                                    <dt className="text-dd-text-2 capitalize">{k}:</dt>
                                    <dd className="text-dd-text font-semibold truncate">{String(v) || '—'}</dd>
                                </div>
                            ))}
                        </dl>
                    ) : (
                        <p className="text-[11px] text-dd-text-2 italic">{tx('Not submitted yet.', 'No enviado.')}</p>
                    )}
                </div>
                <div className="bg-dd-bg rounded-lg p-2">
                    <div className="text-[10px] font-bold uppercase text-dd-text-2 mb-1">
                        {tx('Emergency contact', 'Contacto de emergencia')}
                    </div>
                    {hire.emergencyContact ? (
                        <dl className="text-[11px] space-y-0.5">
                            {Object.entries(hire.emergencyContact).map(([k, v]) => (
                                <div key={k} className="flex gap-2">
                                    <dt className="text-dd-text-2 capitalize">{k}:</dt>
                                    <dd className="text-dd-text font-semibold truncate">{String(v) || '—'}</dd>
                                </div>
                            ))}
                        </dl>
                    ) : (
                        <p className="text-[11px] text-dd-text-2 italic">{tx('Not submitted yet.', 'No enviado.')}</p>
                    )}
                </div>
            </div>
            {/* Doc checklist */}
            <div className="divide-y divide-dd-line">
                {docs.map(d => (
                    <DocReviewRow key={d.id}
                        doc={d}
                        hire={hire}
                        isEs={isEs}
                        staffName={staffName}
                        onWriteAudit={onWriteAudit}
                    />
                ))}
            </div>
        </div>
    );
}

// ── DocReviewRow ──────────────────────────────────────────────────────────
function DocReviewRow({ doc: docDef, hire, isEs, staffName, onWriteAudit }) {
    const tx = (en, es) => (isEs ? es : en);
    const state = (hire.checklist && hire.checklist[docDef.id]) || {};
    const status = state.status || DOC_STATUS.NEEDED;
    const meta = DOC_STATUS_META[status];
    const [files, setFiles] = useState(null);   // [{name, url, size, contentType}]
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [expanded, setExpanded] = useState(false);

    const loadFiles = async () => {
        if (files !== null) return;
        setLoadingFiles(true);
        try {
            const folderRef = sref(storage, `onboarding/${hire.id}/${docDef.id}`);
            const list = await listAll(folderRef);
            const enriched = await Promise.all(list.items.map(async (it) => {
                const url = await getDownloadURL(it);
                let m = null;
                try { m = await getMetadata(it); } catch {}
                return {
                    name: it.name,
                    fullPath: it.fullPath,
                    url,
                    size: m?.size,
                    contentType: m?.contentType,
                };
            }));
            setFiles(enriched);
        } catch (e) { console.warn('load files failed', e); setFiles([]); }
        finally { setLoadingFiles(false); }
    };

    useEffect(() => {
        if (expanded && docDef.kind === 'file') loadFiles();
    }, [expanded]);

    const setStatus = async (next, note = '') => {
        await updateDoc(doc(db, 'onboarding_hires', hire.id), {
            [`checklist.${docDef.id}`]: {
                ...state,
                status: next,
                reviewedBy: staffName,
                reviewedAt: new Date().toISOString(),
                note: note || state.note || '',
            },
        });
        onWriteAudit(`doc_${next}`, { hireId: hire.id, docId: docDef.id, hireName: hire.name });
    };

    const reject = async () => {
        const reason = prompt(tx('Why is this being rejected? (visible to hire)', '¿Por qué se rechaza? (visible para el contratado)'));
        if (!reason) return;
        await setStatus(DOC_STATUS.REJECTED, reason);
    };

    return (
        <div className="p-3">
            <div className="flex items-start gap-3">
                <span className="text-2xl flex-shrink-0">{docDef.emoji}</span>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm text-dd-text">{isEs ? docDef.es : docDef.en}</span>
                        {docDef.required && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                                {tx('REQUIRED', 'REQUERIDO')}
                            </span>
                        )}
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${meta.tone}`}>
                            {meta.emoji} {isEs ? meta.es : meta.en}
                        </span>
                    </div>
                    <p className="text-[11px] text-dd-text-2 mt-0.5">{docDef.description}</p>
                    {state.note && (
                        <p className="text-[10px] text-amber-700 italic mt-1">
                            {tx('Note:', 'Nota:')} {state.note}
                        </p>
                    )}
                </div>
                <div className="flex flex-col gap-1 flex-shrink-0">
                    {docDef.kind === 'file' && status !== DOC_STATUS.NEEDED && (
                        <button onClick={() => setExpanded(!expanded)}
                            className="text-[10px] px-2 py-1 rounded bg-dd-bg text-dd-text-2 font-bold">
                            {expanded ? '▴' : '▾'} {tx('Files', 'Archivos')}
                        </button>
                    )}
                    {(status === DOC_STATUS.SUBMITTED || status === DOC_STATUS.REJECTED) && (
                        <button onClick={() => setStatus(DOC_STATUS.APPROVED)}
                            className="text-[10px] px-2 py-1 rounded bg-green-600 text-white font-bold">
                            ✓ {tx('Approve', 'Aprobar')}
                        </button>
                    )}
                    {(status === DOC_STATUS.SUBMITTED || status === DOC_STATUS.APPROVED) && (
                        <button onClick={reject}
                            className="text-[10px] px-2 py-1 rounded bg-red-100 text-red-700 font-bold">
                            ✕ {tx('Reject', 'Rechazar')}
                        </button>
                    )}
                </div>
            </div>
            {expanded && docDef.kind === 'file' && (
                <div className="mt-2 pl-9 space-y-1">
                    {loadingFiles ? (
                        <p className="text-[11px] text-dd-text-2 italic">{tx('Loading…', 'Cargando…')}</p>
                    ) : (files && files.length > 0) ? files.map(f => (
                        <div key={f.fullPath} className="flex items-center gap-2 bg-dd-bg rounded p-1.5">
                            <span className="text-base">📎</span>
                            <div className="flex-1 min-w-0">
                                <div className="text-[11px] font-semibold text-dd-text truncate">{f.name}</div>
                                <div className="text-[9px] text-dd-text-2">
                                    {f.contentType || ''}{f.size ? ` · ${Math.round(f.size / 1024)} KB` : ''}
                                </div>
                            </div>
                            <a href={f.url} target="_blank" rel="noopener noreferrer"
                                onClick={() => onWriteAudit('doc_viewed', { hireId: hire.id, docId: docDef.id, file: f.name })}
                                className="text-[10px] px-2 py-1 rounded bg-blue-100 text-blue-700 font-bold hover:bg-blue-200">
                                {tx('View', 'Ver')}
                            </a>
                            <a href={f.url} download={f.name}
                                onClick={() => onWriteAudit('doc_downloaded', { hireId: hire.id, docId: docDef.id, file: f.name })}
                                className="text-[10px] px-2 py-1 rounded bg-dd-green text-white font-bold">
                                ↓
                            </a>
                        </div>
                    )) : (
                        <p className="text-[11px] text-dd-text-2 italic">{tx('No files uploaded yet.', 'Sin archivos aún.')}</p>
                    )}
                </div>
            )}
        </div>
    );
}

// ── AddHireModal ──────────────────────────────────────────────────────────
function AddHireModal({ isEs, prefill, storeLocation, staffName, onClose, onCreated }) {
    const tx = (en, es) => (isEs ? es : en);
    const [name, setName] = useState(prefill?.name || '');
    const [email, setEmail] = useState(prefill?.email || '');
    const [phone, setPhone] = useState(prefill?.phone || '');
    const [position, setPosition] = useState(prefill?.position || '');
    const [location, setLocation] = useState(prefill?.location || storeLocation || 'webster');
    const [hireDate, setHireDate] = useState('');
    const [saving, setSaving] = useState(false);
    const canSubmit = name.trim().length > 1 && !saving;

    const submit = async (e) => {
        e?.preventDefault();
        if (!canSubmit) return;
        setSaving(true);
        try {
            const hireRef = doc(collection(db, 'onboarding_hires'));
            const hire = {
                id: hireRef.id,
                name: name.trim(),
                email: email.trim(),
                phone: phone.trim(),
                position: position.trim(),
                location,
                hireDate,
                status: HIRE_STATUS.INVITED,
                checklist: {},
                createdAt: new Date().toISOString(),
                createdBy: staffName || 'admin',
            };
            await setDoc(hireRef, hire);
            const token = makeInviteToken();
            const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
            await setDoc(doc(db, 'onboarding_invites', token), {
                hireId: hireRef.id,
                createdAt: new Date().toISOString(),
                expiresAt,
                used: false,
            });
            onCreated({ ...hire }, token);
        } catch (e) {
            console.error('Create hire failed:', e);
            alert(tx('Could not create hire: ', 'No se pudo crear: ') + (e.message || e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <form onSubmit={submit} className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl">
                <div className="border-b border-dd-line p-4 flex items-center justify-between">
                    <h3 className="text-lg font-black text-dd-text">
                        🪪 {tx('New hire', 'Nueva contratación')}
                    </h3>
                    <button type="button" onClick={onClose} className="w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-lg">×</button>
                </div>
                <div className="p-4 space-y-3">
                    <Field label={tx('Legal name', 'Nombre legal')} required>
                        <input value={name} onChange={e => setName(e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm" required />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                        <Field label={tx('Email', 'Correo')}>
                            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm" />
                        </Field>
                        <Field label={tx('Phone', 'Teléfono')}>
                            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm" />
                        </Field>
                    </div>
                    <Field label={tx('Position / role', 'Puesto')}>
                        <input value={position} onChange={e => setPosition(e.target.value)}
                            placeholder={tx('FOH, BOH, Manager…', 'FOH, BOH, Gerente…')}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm" />
                    </Field>
                    <div className="grid grid-cols-2 gap-2">
                        <Field label={tx('Location', 'Ubicación')}>
                            <select value={location} onChange={e => setLocation(e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm bg-white">
                                <option value="webster">Webster</option>
                                <option value="maryland">Maryland Heights</option>
                            </select>
                        </Field>
                        <Field label={tx('Start date', 'Fecha de inicio')}>
                            <input type="date" value={hireDate} onChange={e => setHireDate(e.target.value)}
                                className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm" />
                        </Field>
                    </div>
                    <p className="text-[11px] text-dd-text-2 mt-2 bg-dd-bg p-2 rounded">
                        {tx(
                            'A one-time invite link + QR will be generated. The hire fills out personal info, emergency contact, and uploads docs. You\'ll see live progress here.',
                            'Se generará un enlace + QR de invitación. El contratado llena información personal, contacto de emergencia, y sube documentos. Verás el progreso aquí.',
                        )}
                    </p>
                </div>
                <div className="border-t border-dd-line p-4 flex gap-2">
                    <button type="button" onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-dd-bg text-dd-text-2 font-bold">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button type="submit" disabled={!canSubmit}
                        className="flex-1 py-2 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">
                        {saving ? tx('Creating…', 'Creando…') : tx('Create + invite', 'Crear + invitar')}
                    </button>
                </div>
            </form>
        </div>
    );
}

function Field({ label, required, children }) {
    return (
        <label className="block">
            <span className="text-[11px] font-bold uppercase text-dd-text-2">
                {label}{required ? ' *' : ''}
            </span>
            <div className="mt-0.5">{children}</div>
        </label>
    );
}

// ── InviteSheet ───────────────────────────────────────────────────────────
function InviteSheet({ hire, token, url, isEs, onClose }) {
    const tx = (en, es) => (isEs ? es : en);
    const [qrDataUrl, setQrDataUrl] = useState(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const QRCode = await loadQRCode();
                const dataUrl = await QRCode.toDataURL(url, { width: 256, margin: 1, errorCorrectionLevel: 'M' });
                if (alive) setQrDataUrl(dataUrl);
            } catch (e) { console.warn('QR generation failed:', e); }
        })();
        return () => { alive = false; };
    }, [url]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (e) { console.warn('clipboard write failed', e); }
    };

    const smsLink = hire.phone
        ? `sms:${hire.phone}?body=${encodeURIComponent(
            tx(`Hi ${hire.name}, here's your DD Mau onboarding link: ${url}`,
               `Hola ${hire.name}, este es tu enlace de onboarding de DD Mau: ${url}`),
        )}`
        : null;
    const emailLink = hire.email
        ? `mailto:${hire.email}?subject=${encodeURIComponent(tx('Your DD Mau onboarding link', 'Tu enlace de onboarding de DD Mau'))}&body=${encodeURIComponent(
            tx(`Hi ${hire.name},\n\nWelcome to DD Mau! Open this link to finish your new-hire paperwork. It works on your phone — you can take photos of your W-4, license, etc. right from the app.\n\n${url}\n\nLink expires in ${INVITE_TTL_DAYS} days.\n\n— DD Mau`,
               `Hola ${hire.name},\n\n¡Bienvenido a DD Mau! Abre este enlace para terminar tu papeleo. Funciona en tu teléfono.\n\n${url}\n\nEl enlace expira en ${INVITE_TTL_DAYS} días.\n\n— DD Mau`),
        )}`
        : null;

    return (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl">
                <div className="border-b border-dd-line p-4 flex items-center justify-between">
                    <h3 className="text-lg font-black text-dd-text">
                        🔗 {tx('Invite ready', 'Invitación lista')}
                    </h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-lg">×</button>
                </div>
                <div className="p-4 space-y-3">
                    <p className="text-sm">
                        {tx('Send this link to ', 'Envía este enlace a ')}
                        <span className="font-bold">{hire.name}</span>. {tx(`Expires in ${INVITE_TTL_DAYS} days.`, `Expira en ${INVITE_TTL_DAYS} días.`)}
                    </p>
                    <div className="flex justify-center bg-dd-bg rounded-xl p-3">
                        {qrDataUrl ? (
                            <img src={qrDataUrl} alt="QR" className="w-48 h-48" />
                        ) : (
                            <div className="w-48 h-48 flex items-center justify-center text-dd-text-2 text-xs">
                                {tx('Generating QR…', 'Generando QR…')}
                            </div>
                        )}
                    </div>
                    <div className="bg-dd-bg rounded-lg p-2">
                        <div className="text-[10px] font-bold uppercase text-dd-text-2 mb-0.5">{tx('Link', 'Enlace')}</div>
                        <div className="text-[11px] font-mono break-all text-dd-text">{url}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <button onClick={copy}
                            className="py-2 rounded-lg bg-dd-bg text-dd-text font-bold text-sm hover:bg-dd-line">
                            {copied ? '✓ ' + tx('Copied', 'Copiado') : '📋 ' + tx('Copy link', 'Copiar')}
                        </button>
                        {smsLink ? (
                            <a href={smsLink}
                                className="text-center py-2 rounded-lg bg-blue-600 text-white font-bold text-sm hover:bg-blue-700">
                                💬 {tx('Text', 'SMS')}
                            </a>
                        ) : (
                            <button disabled className="py-2 rounded-lg bg-dd-bg text-dd-text-2 font-bold text-sm opacity-50">
                                💬 {tx('No phone', 'Sin teléfono')}
                            </button>
                        )}
                    </div>
                    {emailLink && (
                        <a href={emailLink}
                            className="block text-center py-2 rounded-lg bg-dd-green text-white font-bold text-sm hover:bg-dd-green/90">
                            📧 {tx('Email link to ', 'Enviar a ')}{hire.email}
                        </a>
                    )}
                </div>
                <div className="border-t border-dd-line p-4">
                    <button onClick={onClose}
                        className="w-full py-2 rounded-lg bg-dd-bg text-dd-text font-bold">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ── ApplicationsList ──────────────────────────────────────────────────────
function ApplicationsList({ applications, isEs, onConvert, onDismiss }) {
    const tx = (en, es) => (isEs ? es : en);
    if (applications.length === 0) {
        return (
            <div className="bg-white border border-dd-line rounded-xl p-8 text-center">
                <p className="text-4xl mb-2">📭</p>
                <p className="text-sm font-semibold text-dd-text-2">
                    {tx('No pending applications.', 'Sin aplicaciones pendientes.')}
                </p>
                <p className="text-[11px] text-dd-text-2 mt-1">
                    {tx('Lock-screen "Apply" submissions show up here.', 'Las aplicaciones desde la pantalla de bloqueo aparecen aquí.')}
                </p>
            </div>
        );
    }
    return (
        <div className="space-y-2">
            {applications.map(a => {
                const created = a.createdAt && typeof a.createdAt === 'object' && a.createdAt.toDate
                    ? a.createdAt.toDate()
                    : (typeof a.createdAt === 'string' ? new Date(a.createdAt) : null);
                return (
                    <div key={a.id} className="bg-white border border-dd-line rounded-xl p-3">
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                            <div className="flex-1 min-w-[200px]">
                                <div className="font-bold text-sm text-dd-text">{a.name}</div>
                                <div className="text-[11px] text-dd-text-2 mt-0.5 space-y-0.5">
                                    {a.position && <div>📋 {a.position}</div>}
                                    {a.location && <div>📍 {a.location}</div>}
                                    {a.email && <div>📧 {a.email}</div>}
                                    {a.phone && <div>📱 {a.phone}</div>}
                                    {a.note && <div className="italic text-dd-text-2 mt-1">"{a.note}"</div>}
                                    {created && <div className="text-[10px] text-dd-text-2 mt-1">{created.toLocaleString()}</div>}
                                </div>
                            </div>
                            <div className="flex flex-col gap-1">
                                <button onClick={() => onConvert(a)}
                                    className="text-[11px] px-2.5 py-1.5 rounded-lg bg-dd-green text-white font-bold hover:bg-dd-green/90">
                                    ✓ {tx('Convert to hire', 'Crear contratación')}
                                </button>
                                <button onClick={() => onDismiss(a.id)}
                                    className="text-[11px] px-2.5 py-1.5 rounded-lg bg-gray-200 text-gray-700 font-bold hover:bg-gray-300">
                                    🗑 {tx('Dismiss', 'Descartar')}
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
