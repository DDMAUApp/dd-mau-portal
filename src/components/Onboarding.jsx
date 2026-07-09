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
    serverTimestamp, query, orderBy, limit, getDoc, deleteField,
} from 'firebase/firestore';
import { LETTER_BODY_EN, LETTER_BODY_ES, letterVars } from './OnboardingOfferLetter';
import { ref as sref, listAll, getDownloadURL, getBytes, getMetadata, deleteObject } from 'firebase/storage';
import { downloadFile, printViaNative, publicAppBase } from '../capacitor-bridge';
import {
    ONBOARDING_DOCS, DOC_STATUS, DOC_STATUS_META,
    HIRE_STATUS, HIRE_STATUS_META,
    INVITE_TTL_DAYS, makeInviteToken,
    docsForHire, isHireMinor, deriveHireStatus, hireProgressCounts,
    docDeadlineState, effectiveDocDescription, effectiveDaysFromHire,
    partitionTemplateFiles,
} from '../data/onboarding';
import {
    POSITIONS, LOCATIONS, DESIRED_HOURS,
    EXPERIENCE_YEARS, DISTANCE_OPTIONS, TRANSPORT_OPTIONS,
    LIFTING_CAPACITY, STANDING_HOURS,
    CERTIFICATIONS, SKILLS, PREVIOUS_ROLES, LANGUAGES,
    APPLICATION_STATUS_META, computeMatchScore, labelFor,
} from '../data/applyForm';
import { lazy as reactLazy, Suspense as ReactSuspense } from 'react';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';
const OnboardingTemplateEditor = reactLazy(() => import('./OnboardingTemplateEditor'));
const OnboardingEmployerFill = reactLazy(() => import('./OnboardingEmployerFill'));

// Lazy-load heavy deps only when needed. JSZip + QRCode are ~150 KB combined;
// no reason to pay for them on every admin page load.
const loadJSZip = () => import('jszip').then(m => m.default || m);
const loadQRCode = () => import('qrcode').then(m => m.default || m);

// Build the invite URL. The new-hire portal reads ?onboard=TOKEN on load
// and bypasses the lock screen.
// 2026-05-30 — Andrew "show when hires opened their onboarding doc".
// OnboardingPortal writes lastOpenedAt + firstOpenedAt + openCount to
// the hire doc on mount; this helper turns those into a glance-friendly
// string for the admin tab. Returns shape { label, tone } so the caller
// can render with appropriate color (amber for never-opened, green for
// recently opened, dd-text-2 for older).
function fmtOpenedAgo(hire, isEs) {
    const last = hire?.lastOpenedAt;
    if (!last) {
        return {
            label: isEs ? 'Sin abrir aún' : 'Not opened yet',
            tone:  'bg-amber-50 text-amber-800 border-amber-200',
            opened: false,
        };
    }
    const t = new Date(last).getTime();
    if (!t || isNaN(t)) {
        return { label: isEs ? 'Abierto' : 'Opened', tone: 'bg-dd-bg text-dd-text-2 border-dd-line', opened: true };
    }
    const diffMs = Date.now() - t;
    const min = Math.round(diffMs / 60_000);
    const hr  = Math.round(diffMs / 3_600_000);
    const day = Math.round(diffMs / 86_400_000);
    let ago;
    if (min < 1)    ago = isEs ? 'ahora' : 'just now';
    else if (min < 60)  ago = isEs ? `hace ${min} min` : `${min}m ago`;
    else if (hr  < 24)  ago = isEs ? `hace ${hr} h`   : `${hr}h ago`;
    else if (day < 30)  ago = isEs ? `hace ${day} días` : `${day}d ago`;
    else ago = new Date(last).toLocaleDateString(isEs ? 'es' : 'en-US', { month: 'short', day: 'numeric' });
    // Fresh (<24h) gets a green tint so admin sees activity at a glance.
    const tone = hr < 24
        ? 'bg-dd-green-50 text-dd-green-700 border-dd-green/30'
        : 'bg-dd-bg text-dd-text-2 border-dd-line';
    return {
        label:  (isEs ? 'Abierto ' : 'Opened ') + ago,
        tone,
        opened: true,
        count:  Number(hire.openCount) || 0,
        firstAt: hire.firstOpenedAt || null,
    };
}

function buildInviteUrl(token) {
    // This link is handed OFF the device (QR the hire scans, SMS, mailto,
    // clipboard) so it must be the public site — never capacitor://localhost /
    // https://localhost from inside the native app. See publicAppBase().
    return `${publicAppBase()}/?onboard=${token}`;
}

export default function Onboarding({ language, staffName, staffList, storeLocation, onBack }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [view, setView] = useState('hires');          // 'hires' | 'complete' | 'applications' | 'templates' | 'policies' | 'doctext' | 'archive'
    const [hires, setHires] = useState([]);
    const [applications, setApplications] = useState([]);
    const [templates, setTemplates] = useState([]);
    const [editingTemplate, setEditingTemplate] = useState(null); // null | 'new' | template object
    const [selectedId, setSelectedId] = useState(null);
    const [addOpen, setAddOpen] = useState(false);
    const [inviteSheet, setInviteSheet] = useState(null); // { hire, token, url }
    const [loading, setLoading] = useState(true);

    // Subscribe to hires.
    // PERF, 2026-05-30: bounded at 500. AdminPanel already caps a similar
    // listener at 500 — matching it here. Active+archived hires together
    // shouldn't grow past this for years.
    useEffect(() => {
        const q = query(collection(db, 'onboarding_hires'), orderBy('createdAt', 'desc'), limit(500));
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
    // PERF, 2026-05-30: bounded at 500. Public Apply form can rack up
    // applications fast; the 180-day expirAndPurgeApplications CF keeps
    // the long-tail in check, this just caps the live listener.
    useEffect(() => {
        const q = query(collection(db, 'onboarding_applications'), orderBy('createdAt', 'desc'), limit(500));
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setApplications(list);
        }, () => {});
        return () => unsub();
    }, []);

    // Subscribe to templates so we can show which docs have a PDF prepared.
    // PERF, 2026-05-30: bounded at 100 — templates are admin-uploaded
    // PDFs (W-4, MO W-4, DD form). Unlikely to ever cross 20.
    useEffect(() => {
        const unsub = onSnapshot(query(collection(db, 'onboarding_templates'), limit(100)), (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setTemplates(list);
        }, () => {});
        return () => unsub();
    }, []);

    // Global doc-text overrides — admins edit these in the "Doc text"
    // tab to rewrite the description any hire sees for any
    // ONBOARDING_DOCS entry. Shape on disk:
    //   { overrides: { [docId]: { en, es } }, updatedAt, updatedBy }
    // Held as the raw `overrides` map in state so passing to children
    // is the same shape effectiveDocDescription() expects. Realtime
    // subscription (not one-shot getDoc) so the admin sees their own
    // edits appear in the hire-detail view immediately after saving.
    const [docOverrides, setDocOverrides] = useState({});
    useEffect(() => {
        const unsub = onSnapshot(
            doc(db, 'config', 'onboarding_doc_text'),
            (snap) => {
                if (snap.exists()) {
                    const data = snap.data() || {};
                    setDocOverrides(data.overrides && typeof data.overrides === 'object' ? data.overrides : {});
                } else {
                    setDocOverrides({});
                }
            },
            (err) => { console.warn('onboarding doc-text overrides subscribe error', err); },
        );
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

    // Split active / complete / archived. Three buckets:
    //   Active   = anything NOT explicitly marked complete or archived
    //              (includes derived-complete hires whose admin hasn't
    //              clicked "Move to Complete" yet — they show the COMPLETE
    //              badge in the active list as the cue to lock them in).
    //   Complete = admin clicked "Move to Complete" → hire.status='complete'.
    //              Portal renders read-only for these hires; the hire can
    //              VIEW their submitted docs but can't edit them. Admin
    //              uses "Move back to active" to unlock when a re-submit
    //              is needed (e.g. updated direct deposit).
    //   Archive  = admin moved long-finished hires here. Stored separately
    //              just to keep the active list short. No PII change.
    const activeHires = useMemo(
        () => hires.filter(h => h.status !== HIRE_STATUS.ARCHIVED && h.status !== HIRE_STATUS.COMPLETE),
        [hires],
    );
    const completeHires = useMemo(
        () => hires.filter(h => h.status === HIRE_STATUS.COMPLETE),
        [hires],
    );
    const archivedHires = useMemo(
        () => hires.filter(h => h.status === HIRE_STATUS.ARCHIVED),
        [hires],
    );
    const visibleList = view === 'archive' ? archivedHires
        : view === 'complete' ? completeHires
        : activeHires;
    const selected = useMemo(
        () => hires.find(h => h.id === selectedId) || null,
        [hires, selectedId],
    );

    // Convert an application into a hire — pre-fills the AddHire modal.
    //
    // V2 applications carry richer signal than v1 used to. Pre-fill EVERY
    // piece we can lift cleanly:
    //   - hireDate ← soonestStartDate (if it's still in the future)
    //   - subsetDocs ← isMinor heuristic (auto-include minor_permit if
    //     applicant said they're under 18)
    //   - location ← first of locations[] (skip 'either' since that
    //     isn't a real location id), fall back to v1 single location
    //   - position ← first of positionsAppliedFor[] (label), fall back
    //     to v1 single position string
    //   - languagePref ← if app was filled in Spanish (heuristic: long
    //     fields contain Spanish-specific punctuation), default the
    //     hire's portal to ES
    //
    // sourceApplicationId is stored on the hire so the convert linkage
    // is visible in the audit log + we can update the app's status to
    // 'hired' after the hire is created (still TODO — handled in the
    // AddHireModal onCreated path).
    const [convertPrefill, setConvertPrefill] = useState(null);
    const convertApplication = (app) => {
        const today = new Date(); today.setHours(0,0,0,0);
        const todayStr = today.toISOString().slice(0, 10);
        // Pick the first concrete location id. v2 stores array of ids
        // ('webster' / 'maryland' / 'either'); 'either' isn't a real
        // location so skip past it.
        const v2Locations = Array.isArray(app.locations) ? app.locations : [];
        const pickedLocation = v2Locations.find(l => l === 'webster' || l === 'maryland')
            || app.location
            || storeLocation
            || 'webster';
        // Hire date: prefer soonestStartDate (the date the applicant
        // committed to on their app) over today, but only if it's
        // still in the future.
        const soonest = app.soonestStartDate || '';
        const hireDateGuess = (soonest && soonest >= todayStr) ? soonest : '';
        // Position: prefer first v2 selection. AddHireModal stores
        // position as a free-text label so use the EN label here.
        const firstPositionId = (app.positionsAppliedFor || [])[0];
        const positionLabel = firstPositionId
            ? (POSITIONS.find(p => p.id === firstPositionId) || {}).en || app.position || ''
            : (app.position || '');
        // Minor heuristic: applicant said they're under 18 + age permit
        // is required by federal law. Pre-seed subsetDocs with the FULL
        // ONBOARDING_DOCS minus minor_permit if NOT a minor, OR include
        // it if they ARE. AddHireModal already auto-detects this from
        // hire.isMinor — but pre-filling subsetDocs lets the picker
        // reflect it from the modal-opens moment.
        const subsetDocs = app.isUnder18 === true
            ? ONBOARDING_DOCS.map(d => d.id)   // include everything including minor_permit
            : null;                              // null = use defaults (excludes minorOnly)
        setConvertPrefill({
            name: app.legalName || app.name || '',
            email: app.email || '',
            phone: app.phone || '',
            position: positionLabel,
            location: pickedLocation,
            hireDate: hireDateGuess,
            offerAmount: app.desiredHourlyWage ? `$${app.desiredHourlyWage} / hr` : '',
            isMinor: app.isUnder18 === true ? true : undefined,
            subsetDocs,
            sourceApplicationId: app.id,
            // language hint — used by InviteSheet so we generate the QR
            // URL with the right ?lang param later. For now stash on the
            // hire record so the portal can default to ES if the app
            // was filled in Spanish.
            preferredLanguage: app.preferredLanguage || null,
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

            <div className="flex gap-1 bg-dd-bg p-1 rounded-xl w-fit flex-wrap">
                {[
                    { id: 'hires', en: `Active (${activeHires.length})`, es: `Activos (${activeHires.length})` },
                    { id: 'complete', en: `Complete (${completeHires.length})`, es: `Completos (${completeHires.length})` },
                    { id: 'applications', en: `Applications (${applications.length})`, es: `Aplicaciones (${applications.length})` },
                    { id: 'templates', en: `Templates (${templates.length})`, es: `Plantillas (${templates.length})` },
                    { id: 'policies', en: 'Policies', es: 'Políticas' },
                    { id: 'doctext', en: 'Doc text', es: 'Texto de docs' },
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
                    staffName={staffName}
                    onConvert={convertApplication}
                    onStatusChange={async (appId, nextStatus) => {
                        await updateDoc(doc(db, 'onboarding_applications', appId), {
                            status: nextStatus,
                            statusUpdatedAt: new Date().toISOString(),
                            statusUpdatedBy: staffName || 'admin',
                        });
                        writeAudit('application_status_changed', { appId, to: nextStatus });
                    }}
                    onToggleStar={async (appId, currentStars) => {
                        const has = (currentStars || []).includes(staffName);
                        const next = has
                            ? (currentStars || []).filter(s => s !== staffName)
                            : [...(currentStars || []), staffName];
                        await updateDoc(doc(db, 'onboarding_applications', appId), { starredBy: next });
                    }}
                    onDismiss={async (appId) => {
                        if (!confirm(tx('Delete this application?', '¿Eliminar esta aplicación?'))) return;
                        await deleteDoc(doc(db, 'onboarding_applications', appId));
                        writeAudit('application_dismissed', { appId });
                    }}
                />
            ) : view === 'templates' ? (
                <TemplatesList
                    templates={templates}
                    isEs={isEs}
                    onNew={() => setEditingTemplate('new')}
                    onEdit={(t) => setEditingTemplate(t)} />
            ) : view === 'policies' ? (
                <PoliciesEditor isEs={isEs} staffName={staffName} onWriteAudit={writeAudit} />
            ) : view === 'doctext' ? (
                <DocTextEditor isEs={isEs} staffName={staffName} overrides={docOverrides} onWriteAudit={writeAudit} />
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
                            : view === 'complete'
                                ? tx('Nobody is in the Complete folder yet. Approve all of a hire\'s docs, then tap "Move to Complete" on their detail page.',
                                    'Nadie está en la carpeta Completos aún. Aprueba todos los documentos de un contratado y toca "Mover a Completos".')
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
                            docOverrides={docOverrides}
                            onWriteAudit={writeAudit}
                            onMoveToComplete={async () => {
                                if (!confirm(tx(
                                    'Move this hire to Complete? Their portal will become read-only — they can view what they submitted but can\'t edit. Use "Move back to active" if you need them to redo a doc.',
                                    '¿Mover a Completos? Su portal será de solo lectura. Usa "Volver a activos" si necesitas que rehagan algo.',
                                ))) return;
                                // FIX (2026-05-14): wrap admin updateDoc in try/catch.
                                // Previously failures were silent — audit log fired as
                                // if the write succeeded, state desync'd between admin
                                // and hire's view.
                                try {
                                    await updateDoc(doc(db, 'onboarding_hires', selected.id), {
                                        status: HIRE_STATUS.COMPLETE,
                                        completedAt: new Date().toISOString(),
                                        completedBy: staffName || 'admin',
                                    });
                                    writeAudit('hire_moved_to_complete', { hireId: selected.id, hireName: selected.name });
                                } catch (e) {
                                    console.error('Move to complete failed:', e);
                                    toast(tx('Could not move to complete: ', 'No se pudo mover: ') + (e.message || e));
                                }
                            }}
                            onMoveBackToActive={async () => {
                                if (!confirm(tx(
                                    'Move this hire back to Active? Their portal will unlock so they can edit / re-submit any doc.',
                                    '¿Volver a Activos? El portal se desbloqueará para que puedan editar.',
                                ))) return;
                                // Clear the status field — deriveHireStatus
                                // will recompute (likely awaiting_review or
                                // in_progress). Don't reset checklist or
                                // approvals; admin may just want them to
                                // tweak one doc.
                                try {
                                    await updateDoc(doc(db, 'onboarding_hires', selected.id), {
                                        status: HIRE_STATUS.IN_PROGRESS,
                                        unlockedAt: new Date().toISOString(),
                                        unlockedBy: staffName || 'admin',
                                    });
                                    writeAudit('hire_unlocked_from_complete', { hireId: selected.id, hireName: selected.name });
                                } catch (e) {
                                    console.error('Move back to active failed:', e);
                                    toast(tx('Could not move back to active: ', 'No se pudo reactivar: ') + (e.message || e));
                                }
                            }}
                            onArchive={async () => {
                                if (!confirm(tx(
                                    'Archive this hire? They\'re still kept for compliance retention.',
                                    '¿Archivar a esta persona? Se mantiene por cumplimiento.',
                                ))) return;
                                try {
                                    await updateDoc(doc(db, 'onboarding_hires', selected.id), {
                                        status: HIRE_STATUS.ARCHIVED,
                                        archivedAt: new Date().toISOString(),
                                    });
                                    writeAudit('hire_archived', { hireId: selected.id, hireName: selected.name });
                                    setSelectedId(null);
                                } catch (e) {
                                    console.error('Archive failed:', e);
                                    toast(tx('Could not archive: ', 'No se pudo archivar: ') + (e.message || e));
                                }
                            }}
                            onResend={async () => {
                                // 2026-05-30 audit fix — wrap in try/catch.
                                // The previous unguarded version would still
                                // open the success "invite sheet" even when
                                // the setDoc rejected (e.g. rules denial,
                                // offline), leaving the admin to believe the
                                // link was minted when the hire never
                                // received a working URL. Now we only stamp
                                // the audit + open the sheet on success;
                                // failure surfaces a toast.
                                try {
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
                                } catch (e) {
                                    console.error('Resend invite failed:', e);
                                    toast(tx(
                                        'Could not resend invite: ' + (e?.message || e),
                                        'No se pudo reenviar la invitación: ' + (e?.message || e),
                                    ), { kind: 'error' });
                                }
                            }}
                            onEdit={() => {
                                // Re-use the AddHireModal in edit mode by
                                // shoving the existing hire into the prefill
                                // slot. The modal detects edit mode via the
                                // presence of prefill.id.
                                setConvertPrefill(selected);
                                setAddOpen(true);
                            }}
                            onResetPassword={async () => {
                                // Clear the hire's portal password so they create
                                // a fresh one the next time they open their link.
                                try {
                                    await updateDoc(doc(db, 'onboarding_hires', selected.id), { portalAuth: null });
                                    writeAudit('onboarding_password_reset', { hireId: selected.id, hireName: selected.name });
                                    toast(tx(
                                        'Password reset — they\'ll set a new one next time they open their link.',
                                        'Contraseña reiniciada — creará una nueva al abrir su enlace.',
                                    ), { kind: 'success' });
                                } catch (e) {
                                    toast(tx('Could not reset password: ', 'No se pudo reiniciar: ') + (e?.message || e), { kind: 'error' });
                                }
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
                        // token === null means the modal was in edit mode
                        // (existing hire patched, no new invite). Skip the
                        // invite-link sheet — there's nothing new to send.
                        if (token) {
                            setInviteSheet({ hire, token, url: buildInviteUrl(token) });
                            writeAudit('hire_created', { hireId: hire.id, hireName: hire.name });
                        } else {
                            writeAudit('hire_edited', { hireId: hire.id, hireName: hire.name });
                        }
                        // If converted from an application, clean it up.
                        // Only on CREATE — edits won't have a sourceApplicationId.
                        if (token && convertPrefill && convertPrefill.sourceApplicationId) {
                            try { await deleteDoc(doc(db, 'onboarding_applications', convertPrefill.sourceApplicationId)); }
                            catch (e) { console.warn('Could not delete source application:', e); }
                        }
                        setConvertPrefill(null);
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

            {editingTemplate && (
                <ReactSuspense fallback={<div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center text-white">Loading editor…</div>}>
                    <OnboardingTemplateEditor
                        initialTemplate={editingTemplate === 'new' ? null : editingTemplate}
                        isEs={isEs}
                        onClose={() => setEditingTemplate(null)}
                        onSaved={() => setEditingTemplate(null)}
                    />
                </ReactSuspense>
            )}
        </div>
    );
}

// ── TemplatesList ─────────────────────────────────────────────────────────
function TemplatesList({ templates, isEs, onNew, onEdit }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-[12px] text-blue-900">
                {tx(
                    'Upload your blank W-4, Missouri W-4, I-9, and Direct Deposit PDFs once. Mark where each field goes by clicking — or hit Scan PDF for fillable forms to auto-detect. Every new hire fills the same template in-app.',
                    'Sube tus PDFs en blanco de W-4, W-4 de Missouri, I-9 y Depósito Directo una sola vez. Marca campos haciendo clic o usa Escanear PDF.',
                )}
            </div>
            <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3">
                <p className="text-[11px] font-bold text-indigo-900 mb-1">
                    📥 {tx('Get official forms (latest versions)', 'Obtén formularios oficiales')}
                </p>
                <ul className="text-[11px] text-indigo-800 space-y-0.5">
                    <li>• <a href="https://www.uscis.gov/sites/default/files/document/forms/i-9.pdf" target="_blank" rel="noopener noreferrer" className="underline font-bold hover:text-indigo-600">USCIS Form I-9</a> {tx('— work authorization', '— autorización de trabajo')}</li>
                    <li>• <a href="https://www.irs.gov/pub/irs-pdf/fw4.pdf" target="_blank" rel="noopener noreferrer" className="underline font-bold hover:text-indigo-600">IRS Form W-4</a> {tx('— federal tax withholding', '— impuestos federales')}</li>
                    <li>• <a href="https://dor.mo.gov/forms/MO%20W-4.pdf" target="_blank" rel="noopener noreferrer" className="underline font-bold hover:text-indigo-600">Missouri MO W-4</a> {tx('— state tax withholding', '— impuestos estatales')}</li>
                </ul>
                <p className="text-[10px] text-indigo-700 italic mt-1">
                    {tx('All three are AcroForm fillable — use "Scan PDF" in the editor after uploading.',
                        'Los tres tienen campos rellenables — usa "Escanear PDF" después de subir.')}
                </p>
            </div>
            <button onClick={onNew}
                className="w-full p-3 rounded-xl border-2 border-dashed border-dd-green/40 bg-white hover:border-dd-green hover:bg-dd-sage-50 active:scale-[0.99] transition text-sm font-bold text-dd-green-700">
                + {tx('New template (upload PDF)', 'Nueva plantilla (subir PDF)')}
            </button>
            {templates.length === 0 ? (
                <p className="text-center text-dd-text-2 text-xs py-3">
                    {tx('No templates yet. Upload your first PDF above.', 'Sin plantillas aún. Sube tu primer PDF arriba.')}
                </p>
            ) : (
                <div className="space-y-2">
                    {templates.map(t => (
                        <button key={t.id} onClick={() => onEdit(t)}
                            className="w-full text-left bg-white border border-dd-line rounded-xl p-3 hover:border-dd-green/60 active:scale-[0.99] transition">
                            <div className="flex items-center gap-3">
                                <span className="text-2xl">📄</span>
                                <div className="flex-1 min-w-0">
                                    <div className="font-bold text-sm text-dd-text">{t.name}</div>
                                    <div className="text-[11px] text-dd-text-2">
                                        {t.forDocId} · {(t.fields || []).length} {tx('fields', 'campos')}
                                    </div>
                                </div>
                                <span className="text-dd-text-2">→</span>
                            </div>
                        </button>
                    ))}
                </div>
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
                const opened = fmtOpenedAgo(h, isEs);
                return (
                    <button key={h.id}
                        onClick={() => onSelect(h.id)}
                        className={`w-full text-left bg-white border-2 rounded-xl p-3 transition active:scale-[0.99] ${
                            isSel ? 'border-dd-green shadow-sm'
                                : 'border-dd-line hover:border-dd-line/80'
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
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${opened.tone}`}>
                                        {opened.label}
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
function HireDetail({ hire, isEs, staffName, docOverrides, onWriteAudit, onArchive, onResend, onEdit, onResetPassword, onMoveToComplete, onMoveBackToActive }) {
    const tx = (en, es) => (isEs ? es : en);
    const docs = docsForHire(hire);
    const counts = hireProgressCounts(hire);
    const status = deriveHireStatus(hire);
    const meta = HIRE_STATUS_META[status];
    const minor = isHireMinor(hire);
    const [exporting, setExporting] = useState(false);
    // Offer letter customization — admin can preview + tweak the letter
    // body for THIS hire before sending the invite. Saves to
    // hire.offerLetterBody; the hire portal honors that override when
    // rendering OnboardingOfferLetter. See OfferLetterEditor below.
    const [showOfferEditor, setShowOfferEditor] = useState(false);
    // "View all submitted" toggle — flips every DocReviewRow's expanded
    // state via the forceExpand prop. Lets admin scroll through every
    // file in one motion instead of clicking each doc to expand.
    const [expandAllDocs, setExpandAllDocs] = useState(false);
    // Some hire flows don't include the offer letter (e.g. "Tax forms only"
    // re-send subset). Hide the edit button in those cases so it doesn't
    // dead-end.
    const offerLetterInFlow = docs.some(d => d.id === 'offer_letter');

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
                    // getBytes() (SDK XHR path) instead of getDownloadURL+fetch
                    // so the zip export works cross-origin without depending
                    // on freshly-cached bucket CORS. Same migration applied
                    // to OnboardingFillablePdf / TemplateEditor / EmployerFill.
                    const buf = await getBytes(item);
                    zip.file(`${docId}/${item.name}`, new Blob([buf]));
                } catch (e) { console.warn('skip file', item.fullPath, e); }
            }
            const blob = await zip.generateAsync({ type: 'blob' });
            const safeName = String(hire.name).replace(/[^a-z0-9_-]+/gi, '_');
            const stamp = new Date().toISOString().slice(0, 10);
            await downloadFile({ data: blob, fileName: `onboarding_${safeName}_${stamp}.zip`, mimeType: 'application/zip' });
            onWriteAudit('zip_exported', { hireId: hire.id, hireName: hire.name });
        } catch (e) {
            console.error('Export failed:', e);
            toast(tx('Export failed: ', 'Falló la exportación: ') + (e.message || e), { kind: 'error', duration: 6000 });
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
                        {/* 2026-05-30 — open-tracking pill. Tooltip carries
                            firstOpenedAt + total openCount so admin can hover
                            for the full history without cluttering the row. */}
                        {(() => {
                            const o = fmtOpenedAgo(hire, isEs);
                            const tooltip = o.opened
                                ? tx(
                                    `First opened ${o.firstAt ? new Date(o.firstAt).toLocaleString() : '?'} · ${o.count} open${o.count === 1 ? '' : 's'} total`,
                                    `Primera apertura ${o.firstAt ? new Date(o.firstAt).toLocaleString() : '?'} · ${o.count} apertura${o.count === 1 ? '' : 's'} en total`)
                                : tx(
                                    'The hire has not opened their invite link yet.',
                                    'El contratado aún no ha abierto su enlace.');
                            return (
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${o.tone}`}
                                      title={tooltip}>
                                    {o.label}{o.opened && o.count > 1 ? ` · ${o.count}×` : ''}
                                </span>
                            );
                        })()}
                    </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                    <ReminderEmailButton hire={hire} docs={docs} isEs={isEs}
                        onWriteAudit={onWriteAudit} staffName={staffName} />
                    {onEdit && (
                        <button onClick={onEdit}
                            className="text-[11px] px-2.5 py-1.5 rounded-lg bg-dd-bg text-dd-text font-bold hover:bg-dd-sage-50 border border-dd-line"
                            title={tx('Edit name, position, wage, start date — before the hire opens their invite, or after.',
                                'Editar nombre, puesto, salario, fecha — antes o después de que el contratado abra el enlace.')}>
                            ✏️ {tx('Edit info', 'Editar info')}
                        </button>
                    )}
                    {offerLetterInFlow && (
                        <button onClick={() => setShowOfferEditor(true)}
                            className={`text-[11px] px-2.5 py-1.5 rounded-lg font-bold ${
                                hire.offerLetterBody
                                    ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
                                    : 'bg-dd-bg text-dd-text hover:bg-dd-sage-50 border border-dd-line'
                            }`}
                            title={hire.offerLetterBody
                                ? tx('Letter customized for this hire', 'Carta personalizada para este contratado')
                                : tx('Default letter — click to edit', 'Carta predeterminada — clic para editar')}>
                            ✏️ {hire.offerLetterBody
                                ? tx('Edit letter ✓', 'Editar carta ✓')
                                : tx('Edit letter', 'Editar carta')}
                        </button>
                    )}
                    <button onClick={onResend}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 font-bold hover:bg-blue-200">
                        ↻ {tx('Resend invite', 'Reenviar invitación')}
                    </button>
                    {onResetPassword && (
                        <button onClick={onResetPassword}
                            title={tx('Clears their onboarding password so they set a new one', 'Borra su contraseña para que cree una nueva')}
                            className="text-[11px] px-2.5 py-1.5 rounded-lg bg-amber-100 text-amber-800 font-bold hover:bg-amber-200">
                            🔑 {tx('Reset password', 'Reiniciar contraseña')}
                        </button>
                    )}
                    <button onClick={exportZip} disabled={exporting}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg bg-dd-green text-white font-bold hover:bg-dd-green/90 disabled:opacity-60">
                        {exporting ? tx('Building zip…', 'Creando zip…') : tx('📦 Export zip', '📦 Exportar zip')}
                    </button>
                    {/* Move to Complete — locks the hire's portal. Only
                        offered when the explicit hire.status isn't already
                        complete/archived. We DON'T gate this on "all docs
                        approved" because the admin might want to lock a
                        hire who has a few in-progress / rejected docs to
                        stop them touching anything while we work out the
                        plan with them offline. The button label gives the
                        admin a hint when the underlying derived state is
                        still in-progress. */}
                    {hire.status !== HIRE_STATUS.COMPLETE && hire.status !== HIRE_STATUS.ARCHIVED && onMoveToComplete && (
                        <button onClick={onMoveToComplete}
                            className={`text-[11px] px-2.5 py-1.5 rounded-lg font-bold ${
                                status === HIRE_STATUS.COMPLETE
                                    ? 'bg-green-600 text-white hover:bg-green-700'
                                    : 'bg-green-100 text-green-800 hover:bg-green-200'
                            }`}
                            title={status === HIRE_STATUS.COMPLETE
                                ? tx('All required docs approved — ready to lock', 'Listo para bloquear')
                                : tx('Some required docs aren\'t approved yet — locking now stops the hire from finishing them', 'Aún faltan aprobar docs')}>
                            🔒 {tx('Move to Complete', 'Mover a Completos')}
                        </button>
                    )}
                    {hire.status === HIRE_STATUS.COMPLETE && onMoveBackToActive && (
                        <button onClick={onMoveBackToActive}
                            className="text-[11px] px-2.5 py-1.5 rounded-lg bg-amber-500 text-white font-bold hover:bg-amber-600">
                            🔓 {tx('Move back to active', 'Volver a activos')}
                        </button>
                    )}
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
            {/* Final certification — the hire signed a "this is all true"
                attestation after every required doc was submitted. Surface
                it so admin has positive confirmation before clicking
                Move to Complete. Absence means hire hasn't certified yet
                (or they're still in the middle of the flow). */}
            {hire.finalCertification && hire.finalCertification.signedAt && (
                <div className="px-3 py-2 border-b border-dd-line bg-green-50/40">
                    <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-base">✅</span>
                        <div className="flex-1 min-w-0">
                            <div className="font-bold text-green-800">
                                {tx('Hire certified all submissions', 'Contratado certificó todo')}
                            </div>
                            <div className="text-[10px] text-green-700">
                                {tx('Signed', 'Firmado')}: {hire.finalCertification.typedSignature}
                                {' · '}
                                {new Date(hire.finalCertification.signedAt).toLocaleString()}
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {/* I-9 reverification expiry — admin sets when filling I-9
                Section 2 for a hire with time-limited work authorization
                (F-1 OPT, EAD, TPS, etc.). The i9ReverificationReminder
                Cloud Function pings 30/14/7/0/-7 days before expiry. US
                citizens + LPRs have no expiry — leave blank. */}
            <div className="px-3 py-2 border-b border-dd-line bg-blue-50/40">
                <label className="block text-[11px] font-bold uppercase text-dd-text-2 mb-1">
                    {tx('I-9 work-auth expiry (optional)', 'I-9 vencimiento autorización (opcional)')}
                </label>
                <div className="flex items-center gap-2">
                    <input type="date" value={hire.workAuthExpiry || ''}
                        onChange={async (e) => {
                            const v = e.target.value || null;
                            try {
                                await updateDoc(doc(db, 'onboarding_hires', hire.id), {
                                    workAuthExpiry: v,
                                    i9ReverifyPingedFor: [], // reset ping log when admin changes the date
                                });
                                onWriteAudit('i9_expiry_set', { hireId: hire.id, expiry: v });
                            } catch (err) { console.warn('save workAuthExpiry failed', err); }
                        }}
                        className="border border-dd-line rounded-lg px-2 py-1 text-xs bg-white" />
                    <p className="text-[10px] text-dd-text-2 leading-tight flex-1">
                        {tx('Set this only for hires with time-limited work auth (F-1 OPT, EAD, TPS). We\'ll ping you 30/14/7/0 days before expiry.',
                            'Solo para autorizaciones con vencimiento. Te avisamos 30/14/7/0 días antes.')}
                    </p>
                </div>
            </div>
            {/* Doc checklist. The "Expand all submitted" toggle opens every
                doc row that has files in Storage so admin can scroll through
                the whole submission without clicking each one individually
                — the natural "let me review everything they sent" workflow. */}
            <div className="px-3 py-2 border-b border-dd-line flex items-center justify-between gap-2 bg-dd-bg">
                <div className="text-[11px] text-dd-text-2">
                    {(() => {
                        const reviewable = docs.filter(d =>
                            d.kind !== 'form' &&
                            (hire.checklist?.[d.id]?.status === DOC_STATUS.SUBMITTED ||
                             hire.checklist?.[d.id]?.status === DOC_STATUS.APPROVED ||
                             hire.checklist?.[d.id]?.status === DOC_STATUS.REJECTED)
                        ).length;
                        return reviewable === 0
                            ? tx('Nothing submitted yet.', 'Nada enviado aún.')
                            : tx(`${reviewable} doc${reviewable === 1 ? '' : 's'} ready to review`,
                                  `${reviewable} doc${reviewable === 1 ? '' : 's'} para revisar`);
                    })()}
                </div>
                <button onClick={() => setExpandAllDocs(v => !v)}
                    className="text-[11px] px-2.5 py-1 rounded-md bg-white border border-dd-line text-dd-text font-bold hover:bg-dd-sage-50">
                    {expandAllDocs
                        ? <>▴ {tx('Collapse all', 'Contraer todo')}</>
                        : <>📂 {tx('Expand all to review', 'Expandir todo')}</>}
                </button>
            </div>
            <div className="divide-y divide-dd-line">
                {docs.map(d => (
                    <DocReviewRow key={d.id}
                        doc={d}
                        hire={hire}
                        isEs={isEs}
                        staffName={staffName}
                        docOverrides={docOverrides}
                        onWriteAudit={onWriteAudit}
                        forceExpand={expandAllDocs}
                    />
                ))}
            </div>
            {showOfferEditor && (
                <OfferLetterEditor
                    hire={hire}
                    isEs={isEs}
                    staffName={staffName}
                    onWriteAudit={onWriteAudit}
                    onClose={() => setShowOfferEditor(false)}
                />
            )}
        </div>
    );
}

// ── OfferLetterEditor ─────────────────────────────────────────────────────
// Admin-side preview + edit for the offer letter THIS hire will see.
//
// Default state: rendered letter (default template) with this hire's
// variables already filled in. Admin can tweak the text directly —
// rename the position, sweeten the wage, add a personal note. Save
// stores the result on hire.offerLetterBody; the hire portal then uses
// that exact string instead of regenerating from the template.
//
// "Reset to default" wipes the override (uses Firestore deleteField())
// so the hire snaps back to the live template — useful when the admin
// later changes the wage and wants the letter to reflect it.
function OfferLetterEditor({ hire, isEs, staffName, onWriteAudit, onClose }) {
    const tx = (en, es) => (isEs ? es : en);
    const defaultBody = useMemo(() => {
        const vars = letterVars(hire);
        return isEs ? LETTER_BODY_ES(vars) : LETTER_BODY_EN(vars);
    }, [hire, isEs]);
    const [body, setBody] = useState(hire?.offerLetterBody || defaultBody);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');
    const hasCustom = !!hire?.offerLetterBody;
    const isDirty = body !== (hire?.offerLetterBody || defaultBody);

    const save = async () => {
        if (!body.trim()) {
            setErr(tx('Letter body cannot be empty.', 'El cuerpo no puede estar vacío.'));
            return;
        }
        setSaving(true);
        setErr('');
        try {
            await updateDoc(doc(db, 'onboarding_hires', hire.id), {
                offerLetterBody: body,
                offerLetterEditedAt: serverTimestamp(),
                offerLetterEditedBy: staffName || 'admin',
            });
            onWriteAudit?.('offer_letter_edited', { hireId: hire.id, hireName: hire.name });
            onClose();
        } catch (e) {
            console.error('Save offer letter failed:', e);
            setErr(tx('Save failed: ', 'No se pudo guardar: ') + (e.message || e));
        } finally {
            setSaving(false);
        }
    };

    const resetToDefault = async () => {
        if (!hasCustom) return;
        if (!confirm(tx(
            'Reset to the default letter? Any custom edits saved on this hire will be lost.',
            '¿Restablecer la carta predeterminada? Las ediciones guardadas se perderán.',
        ))) return;
        setSaving(true);
        try {
            await updateDoc(doc(db, 'onboarding_hires', hire.id), {
                offerLetterBody: deleteField(),
                offerLetterEditedAt: deleteField(),
                offerLetterEditedBy: deleteField(),
            });
            setBody(defaultBody);
            onWriteAudit?.('offer_letter_reset', { hireId: hire.id, hireName: hire.name });
        } catch (e) {
            console.error('Reset offer letter failed:', e);
            setErr(tx('Reset failed: ', 'No se pudo restablecer: ') + (e.message || e));
        } finally {
            setSaving(false);
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl max-h-[95vh] flex flex-col">
                <div className="border-b border-dd-line p-4 flex items-start justify-between gap-2 flex-shrink-0 safe-top [--safe-top-base:1rem]">
                    <div className="min-w-0">
                        <h3 className="text-lg font-black text-dd-text flex items-center gap-2">
                            ✉️ {tx('Edit offer letter', 'Editar carta de oferta')}
                            {hasCustom && (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                                    {tx('CUSTOMIZED', 'PERSONALIZADA')}
                                </span>
                            )}
                        </h3>
                        <p className="text-[11px] text-dd-text-2 mt-0.5 truncate">
                            {tx('For', 'Para')} <b>{hire?.name || ''}</b> — {tx(
                                'this is what the hire will see when they open their invite link.',
                                'esto es lo que el contratado verá al abrir el enlace.',
                            )}
                        </p>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-lg flex-shrink-0">×</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[11px] text-amber-900 leading-relaxed">
                        💡 {tx(
                            "Variables (name, position, wage, hire date) are already filled in from this hire's record. Edit the text directly — what you save here is exactly what the hire will see.",
                            'Las variables (nombre, puesto, salario, fecha de inicio) ya están rellenas. Edita el texto directamente — lo que guardes es lo que verá el contratado.',
                        )}
                    </div>
                    <textarea
                        value={body}
                        onChange={e => setBody(e.target.value)}
                        rows={20}
                        className="w-full border border-dd-line rounded-lg px-3 py-2 text-[12px] font-mono leading-relaxed focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50"
                        spellCheck
                    />
                    {err && <p className="text-[11px] text-red-600">{err}</p>}
                    {hasCustom && (
                        <button onClick={resetToDefault} disabled={saving}
                            className="text-[11px] text-red-600 hover:text-red-700 underline disabled:opacity-50">
                            ↺ {tx('Reset to default letter', 'Restablecer a la predeterminada')}
                        </button>
                    )}
                </div>
                <div className="border-t border-dd-line p-3 flex gap-2 flex-shrink-0">
                    <button onClick={onClose} disabled={saving}
                        className="flex-1 py-2.5 rounded-lg bg-dd-bg text-dd-text-2 font-bold hover:bg-gray-200 disabled:opacity-50">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save} disabled={saving || !isDirty}
                        className="flex-1 py-2.5 rounded-lg bg-dd-green text-white font-bold hover:bg-dd-green/90 disabled:opacity-50">
                        {saving
                            ? tx('Saving…', 'Guardando…')
                            : isDirty
                                ? tx('Save letter', 'Guardar carta')
                                : tx('No changes', 'Sin cambios')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── DocReviewRow ──────────────────────────────────────────────────────────
function DocReviewRow({ doc: docDef, hire, isEs, staffName, docOverrides, onWriteAudit, forceExpand }) {
    const tx = (en, es) => (isEs ? es : en);
    const state = (hire.checklist && hire.checklist[docDef.id]) || {};
    const status = state.status || DOC_STATUS.NEEDED;
    const meta = DOC_STATUS_META[status];
    const [files, setFiles] = useState(null);   // [{name, url, size, contentType}]
    const [loadingFiles, setLoadingFiles] = useState(false);
    const [internalExpanded, setInternalExpanded] = useState(false);
    // Per-hire override editor — pencil button on the description
    // line opens this. Admin can edit BOTH the description text and
    // the days-from-hire count for this hire only (others unaffected).
    // Used for accommodations like "you have an extra 2 weeks for the
    // I-9" without changing the global rule.
    const [editingDesc, setEditingDesc] = useState(false);
    const [descDraft, setDescDraft] = useState(state.descOverride || '');
    // Days draft kept as a string so the input can be cleared cleanly
    // (empty = inherit global/default; '0' = explicit zero); coerced
    // to number on save.
    const [daysDraft, setDaysDraft] = useState(
        typeof state.daysOverride === 'number' ? String(state.daysOverride) : ''
    );
    const [savingDesc, setSavingDesc] = useState(false);
    // Resync drafts when the underlying override changes — covers
    // (a) admin switches between hires (DocReviewRow reuses its
    // component instance because its key is doc.id, so drafts would
    // otherwise carry over from the previous hire), and (b) the
    // Firestore snapshot reflecting our own save settles. In case (b)
    // the new value equals the draft so the setState is a no-op; in
    // case (a) we correctly reset to the new hire's value.
    useEffect(() => {
        setDescDraft(state.descOverride || '');
        setDaysDraft(typeof state.daysOverride === 'number' ? String(state.daysOverride) : '');
        setEditingDesc(false);
    }, [state.descOverride, state.daysOverride, hire?.id]);
    // Deadline pill — hidden once the doc is approved (nothing to chase).
    // Submitted-but-not-approved we still show so admin remembers it's
    // a ticking clock even though the file's in. Days are the effective
    // value: per-hire override → global override → hardcoded default.
    const effectiveDays = effectiveDaysFromHire(docDef, {
        hireChecklistEntry: state,
        globalOverrides: docOverrides,
    });
    const deadline = status === DOC_STATUS.APPROVED
        ? { kind: 'none' }
        : docDeadlineState({ ...docDef, daysFromHire: effectiveDays }, hire?.hireDate);
    const effectiveDesc = effectiveDocDescription(docDef, {
        hireChecklistEntry: state,
        globalOverrides: docOverrides,
        language: isEs ? 'es' : 'en',
    });
    // Show admin what's actually overriding the default so they can
    // tell at a glance whether they're editing the per-hire copy or
    // the global one.
    const descSource = state.descOverride && state.descOverride.trim()
        ? 'per_hire'
        : (docOverrides?.[docDef.id]?.[isEs ? 'es' : 'en'] || docOverrides?.[docDef.id]?.en)
            ? 'global'
            : 'default';
    const daysSource = typeof state.daysOverride === 'number'
        ? 'per_hire'
        : (typeof docOverrides?.[docDef.id]?.days === 'number'
            ? 'global'
            : 'default');
    // forceExpand wins when truthy — used by the "Expand all to review"
    // toggle in HireDetail to open every row at once. Individual toggle
    // still works on top of an inactive forceExpand.
    const expanded = forceExpand || internalExpanded;
    const setExpanded = setInternalExpanded;
    // Check if this doc's template has any employer-fill fields. If so,
    // and the hire has submitted, surface a "Complete employer section"
    // button so admin can fill the I-9 Section 2 style fields.
    const [hasEmployerFields, setHasEmployerFields] = useState(false);
    const [employerFillOpen, setEmployerFillOpen] = useState(false);
    useEffect(() => {
        if (docDef.kind !== 'template') return;
        let alive = true;
        (async () => {
            try {
                const tSnap = await getDocs(query(
                    collection(db, 'onboarding_templates'),
                    where('forDocId', '==', docDef.id),
                ));
                let found = false;
                tSnap.forEach(d => {
                    const data = d.data();
                    if ((data.mode || 'fillable') !== 'fillable') return;
                    if ((data.fields || []).some(f => f.filledBy === 'employer')) found = true;
                });
                if (alive) setHasEmployerFields(found);
            } catch {}
        })();
        return () => { alive = false; };
    }, [docDef.id, docDef.kind]);

    const loadFiles = async () => {
        if (files !== null) return;
        setLoadingFiles(true);
        try {
            const folderRef = sref(storage, `onboarding/${hire.id}/${docDef.id}`);
            const list = await listAll(folderRef);
            let items = list.items.slice();
            // Single-PDF 'template' docs (W-4, I-9, MO W-4, direct deposit): a
            // re-fill is an UPDATE, not a new copy — show only the newest and prune
            // older duplicates so the admin doesn't see 4 of the same W-4 (Andrew
            // 2026-06-30). File/ID docs can legitimately hold multiple distinct
            // uploads (e.g. ID front + back), so those are left untouched.
            //
            // Kind-aware since the employer-section flow: the hire's filled_
            // submission and the admin's complete_ (employer-completed) PDF
            // are different documents and BOTH survive — the old keep-one-
            // overall prune deleted the hire's signed original the first time
            // Files was opened after an I-9 Section 2 completion. See
            // partitionTemplateFiles for the full rationale.
            if (docDef.kind === 'template' && items.length > 1) {
                const { keep, prune } = partitionTemplateFiles(items.map(it => it.name));
                const byName = new Map(items.map(it => [it.name, it]));
                for (const staleName of prune) {
                    const stale = byName.get(staleName);
                    if (stale) deleteObject(stale).catch(() => {});
                }
                items = keep.map(n => byName.get(n)).filter(Boolean);
            }
            const enriched = await Promise.all(items.map(async (it) => {
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

    // Lazy-load files the first time the expander opens. Applies to every
    // kind that writes to Storage (file / template / offer_letter / id),
    // not just file-kind — see the expander-gate comment above. `files`
    // is in the deps so a caller can invalidate the cache by setting it
    // back to null (employer-section completion does this — the new
    // complete_ PDF must show up without a collapse/re-expand dance).
    useEffect(() => {
        if (expanded && docDef.kind !== 'form' && files === null) loadFiles();
    }, [expanded, files]);

    const setStatus = async (next, note = '') => {
        // Write ONLY the review fields via deep dotted paths. The old code
        // wrote the whole `checklist.{id}` object from a render-time `state`
        // snapshot, so an admin Approve could clobber a hire's just-submitted
        // submittedAt/fields (and a hire re-submit could wipe the admin's
        // rejection note). Dotted paths touch only what this action changes.
        await updateDoc(doc(db, 'onboarding_hires', hire.id), {
            [`checklist.${docDef.id}.status`]: next,
            [`checklist.${docDef.id}.reviewedBy`]: staffName,
            [`checklist.${docDef.id}.reviewedAt`]: new Date().toISOString(),
            [`checklist.${docDef.id}.note`]: note || state.note || '',
        });
        onWriteAudit(`doc_${next}`, { hireId: hire.id, docId: docDef.id, hireName: hire.name });
    };

    const reject = async () => {
        const reason = prompt(tx('Why is this being rejected? (visible to hire)', '¿Por qué se rechaza? (visible para el contratado)'));
        if (!reason) return;
        await setStatus(DOC_STATUS.REJECTED, reason);
    };

    // Open the inline editor with the CURRENT effective description +
    // days pre-filled (per-hire override → global override → default),
    // so admin can edit the existing values rather than retyping them.
    // Andrew 2026-05-28: "i cant edit it. i dont want just a spot to
    // write in the edit i want to be able to edit it." + "i want to be
    // able to edit the number of days left to complete."
    const openDescEdit = () => {
        const seedDesc = state.descOverride && state.descOverride.trim()
            ? state.descOverride
            : effectiveDocDescription(docDef, {
                globalOverrides: docOverrides,
                language: isEs ? 'es' : 'en',
            });
        setDescDraft(seedDesc || '');
        const eff = effectiveDaysFromHire(docDef, {
            hireChecklistEntry: state,
            globalOverrides: docOverrides,
        });
        setDaysDraft(typeof eff === 'number' ? String(eff) : '');
        setEditingDesc(true);
    };

    // Save (or clear) the per-hire description + days overrides in one
    // write. Empty text or blank days = "delete that field" — falling
    // back to the global / default is one keystroke + save away. Both
    // fields are independent; only the one(s) you change become
    // overrides.
    const saveDescOverride = async () => {
        if (savingDesc) return;
        setSavingDesc(true);
        try {
            const trimmedDesc = (descDraft || '').trim();
            // Parse days: blank → null (inherit); else integer ≥ 0.
            // Reject negative / non-numeric so we never write garbage
            // that breaks effectiveDaysFromHire's number check.
            let daysVal = null;
            if (daysDraft !== '' && daysDraft != null) {
                const n = parseInt(daysDraft, 10);
                if (!Number.isFinite(n) || n < 0) {
                    alert(tx('Days must be a whole number 0 or greater.',
                             'Los días deben ser un número entero ≥ 0.'));
                    setSavingDesc(false);
                    return;
                }
                daysVal = n;
            }
            await updateDoc(doc(db, 'onboarding_hires', hire.id), {
                [`checklist.${docDef.id}`]: {
                    ...state,
                    descOverride: trimmedDesc || null,
                    descOverrideAt: trimmedDesc ? new Date().toISOString() : null,
                    descOverrideBy: trimmedDesc ? staffName : null,
                    daysOverride: daysVal,
                    daysOverrideAt: daysVal !== null ? new Date().toISOString() : null,
                    daysOverrideBy: daysVal !== null ? staffName : null,
                },
            });
            onWriteAudit('doc_override_set', {
                hireId: hire.id, docId: docDef.id, hireName: hire.name,
                descSet: !!trimmedDesc, daysSet: daysVal !== null,
            });
            setEditingDesc(false);
        } catch (e) {
            console.warn('saveDescOverride failed', e);
            alert(tx('Could not save. Try again.', 'No se pudo guardar.'));
        } finally {
            setSavingDesc(false);
        }
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
                        {deadline.kind !== 'none' && (
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${deadline.tone}`}>
                                ⏱ {isEs ? deadline.labelEs : deadline.label}
                            </span>
                        )}
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${meta.tone}`}>
                            {meta.emoji} {isEs ? meta.es : meta.en}
                        </span>
                    </div>
                    {editingDesc ? (
                        // Inline editor for the per-hire overrides — both
                        // the description text AND the days-from-hire count.
                        // Saving an empty value on either field clears that
                        // override (so the hire falls back to the global /
                        // default for that field).
                        <div className="mt-1 space-y-1">
                            <textarea
                                value={descDraft}
                                onChange={(e) => setDescDraft(e.target.value)}
                                rows={3}
                                placeholder={effectiveDocDescription(docDef, {
                                    globalOverrides: docOverrides,
                                    language: isEs ? 'es' : 'en',
                                })}
                                className="w-full text-[11px] border border-dd-line rounded px-2 py-1 bg-white"
                            />
                            <div className="flex items-center gap-1.5">
                                <label className="text-[10px] font-bold uppercase text-dd-text-2">
                                    ⏱ {tx('Days from hire', 'Días desde contratación')}
                                </label>
                                <input
                                    type="number" min="0" step="1"
                                    value={daysDraft}
                                    onChange={(e) => setDaysDraft(e.target.value)}
                                    placeholder={(() => {
                                        // Show the inherited value as placeholder
                                        // so admin knows what cleared = falls
                                        // back to.
                                        const inherited = effectiveDaysFromHire(docDef, {
                                            globalOverrides: docOverrides,
                                        });
                                        return inherited === null ? tx('none', 'ninguno') : String(inherited);
                                    })()}
                                    className="w-20 text-[11px] border border-dd-line rounded px-2 py-1 bg-white"
                                />
                                <span className="text-[10px] text-dd-text-2">
                                    {tx('blank = inherit', 'vacío = heredar')}
                                </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <button onClick={saveDescOverride} disabled={savingDesc}
                                    className="text-[10px] px-2 py-1 rounded bg-dd-green text-white font-bold disabled:opacity-60">
                                    {savingDesc ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                                </button>
                                <button onClick={() => {
                                        setEditingDesc(false);
                                        setDescDraft(state.descOverride || '');
                                        setDaysDraft(typeof state.daysOverride === 'number' ? String(state.daysOverride) : '');
                                    }}
                                    className="text-[10px] px-2 py-1 rounded bg-dd-bg text-dd-text-2 font-bold">
                                    {tx('Cancel', 'Cancelar')}
                                </button>
                                {(state.descOverride || typeof state.daysOverride === 'number') && (
                                    <button onClick={() => { setDescDraft(''); setDaysDraft(''); }}
                                        className="text-[10px] px-2 py-1 rounded bg-red-50 text-red-700 font-bold ml-auto">
                                        {tx('Clear all overrides', 'Quitar todo')}
                                    </button>
                                )}
                            </div>
                            <p className="text-[9px] text-dd-text-2 italic">
                                {tx('Replaces what this hire sees. Leave blank to use the default.',
                                    'Reemplaza lo que ve esta persona. Deja en blanco para usar el predeterminado.')}
                            </p>
                        </div>
                    ) : (
                        <div className="flex items-start gap-1.5 mt-0.5">
                            <p className="text-[11px] text-dd-text-2 whitespace-pre-wrap flex-1">{effectiveDesc}</p>
                            <button
                                onClick={openDescEdit}
                                title={tx('Edit the note this hire sees', 'Editar la nota que ve este contratado')}
                                className="text-[10px] px-1.5 py-0.5 rounded text-dd-text-2 hover:bg-dd-bg flex-shrink-0">
                                ✏️
                            </button>
                        </div>
                    )}
                    {!editingDesc && descSource !== 'default' && (
                        <p className="text-[9px] text-dd-text-2 italic mt-0.5">
                            {descSource === 'per_hire'
                                ? tx('✏️ Note customized for this hire', '✏️ Nota personalizada para este contratado')
                                : tx('🌐 Using global doc-text override', '🌐 Usando texto global personalizado')}
                        </p>
                    )}
                    {!editingDesc && daysSource !== 'default' && (
                        <p className="text-[9px] text-dd-text-2 italic mt-0.5">
                            {daysSource === 'per_hire'
                                ? tx(`⏱ Days customized for this hire (${state.daysOverride}d)`,
                                     `⏱ Días personalizados (${state.daysOverride}d)`)
                                : tx(`⏱ Using global days override (${docOverrides?.[docDef.id]?.days}d)`,
                                     `⏱ Días global personalizado (${docOverrides?.[docDef.id]?.days}d)`)}
                        </p>
                    )}
                    {state.note && (
                        <p className="text-[10px] text-amber-700 italic mt-1">
                            {tx('Note:', 'Nota:')} {state.note}
                        </p>
                    )}
                </div>
                <div className="flex flex-col gap-1 flex-shrink-0">
                    {/* "Files" expander — list every uploaded file under
                        onboarding/{hireId}/{docId}/. Was previously gated to
                        `kind === 'file'` only, which meant once a hire signed
                        their W-4 / I-9 / direct-deposit (template kind),
                        offer letter, or uploaded an ID, admin had NO way to
                        view the resulting PDF/photo. They could only
                        Approve / Reject blindly. Andrew couldn't review a
                        finished onboarding for that reason. Now: show the
                        expander for every kind that produces a file in
                        Storage — file, template, offer_letter, id. Form
                        kind (personal_info / emergency_contact) is the only
                        skip since those write to the hire doc, not Storage. */}
                    {docDef.kind !== 'form' && status !== DOC_STATUS.NEEDED && (
                        <button onClick={() => setExpanded(!expanded)}
                            className="text-[10px] px-2 py-1 rounded bg-dd-bg text-dd-text-2 font-bold">
                            {expanded ? '▴' : '▾'} {tx('Files', 'Archivos')}
                        </button>
                    )}
                    {/* Employer section (I-9 Section 2 pattern) — only for
                        template docs with employer-fill fields, once the hire
                        has submitted. Two states:
                        • Not completed → purple fill button. Also shown on
                          APPROVED docs missing employerCompletedAt, which
                          covers "Approve anyway" past the warning below AND
                          docs approved before this flow existed — Section 2
                          can still be completed late.
                        • Completed → green done chip; tapping it REDOES the
                          section (the fill modal always re-processes from the
                          hire's filled_ original, so a typo fix never draws
                          on top of already-drawn employer values). */}
                    {hasEmployerFields && !state.employerCompletedAt
                        && (status === DOC_STATUS.SUBMITTED || status === DOC_STATUS.APPROVED) && (
                        <button onClick={() => setEmployerFillOpen(true)}
                            className="text-[10px] px-2 py-1 rounded bg-purple-600 text-white font-bold">
                            👔 {tx('Fill employer section', 'Llenar sección del empleador')}
                        </button>
                    )}
                    {hasEmployerFields && state.employerCompletedAt
                        && (status === DOC_STATUS.SUBMITTED || status === DOC_STATUS.APPROVED) && (
                        <button onClick={() => setEmployerFillOpen(true)}
                            title={tx(
                                `Completed by ${state.employerCompletedBy || 'admin'} — tap to redo`,
                                `Completado por ${state.employerCompletedBy || 'admin'} — toca para rehacer`)}
                            className="text-[10px] px-2 py-1 rounded bg-green-50 text-green-700 border border-green-200 font-bold">
                            ✓ {tx('Employer section done', 'Sección del empleador lista')}
                            {' · '}
                            {new Date(state.employerCompletedAt).toLocaleDateString(isEs ? 'es' : 'en-US', { month: 'short', day: 'numeric' })}
                        </button>
                    )}
                    {(status === DOC_STATUS.SUBMITTED || status === DOC_STATUS.REJECTED) && (
                        <button onClick={() => {
                            // Guard: an employer-fill doc (I-9 Section 2) that's still
                            // SUBMITTED means Section 2 hasn't been completed (finishing
                            // it flips status to APPROVED). Warn before approving an
                            // I-9 with a blank, federally-incomplete Section 2.
                            if (hasEmployerFields && !state.employerCompletedAt && status === DOC_STATUS.SUBMITTED) {
                                const ok = window.confirm(tx(
                                    'The employer section (e.g. I-9 Section 2) is not completed yet — use "Complete employer" first. Approve anyway?',
                                    'La sección del empleador (p. ej. Sección 2 del I-9) aún no está completa — usa "Completar empleador" primero. ¿Aprobar de todos modos?'
                                ));
                                if (!ok) return;
                            }
                            setStatus(DOC_STATUS.APPROVED);
                        }}
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
            {employerFillOpen && (
                <ReactSuspense fallback={<div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center text-white text-sm">Loading…</div>}>
                    <OnboardingEmployerFill
                        docDef={docDef}
                        hire={hire}
                        hireId={hire.id}
                        isEs={isEs}
                        staffName={staffName}
                        onWriteAudit={onWriteAudit}
                        onClose={() => setEmployerFillOpen(false)}
                        // Invalidate the cached file list so the freshly-written
                        // complete_ PDF appears in Files immediately (the load
                        // effect refetches when files goes back to null).
                        onCompleted={() => { setEmployerFillOpen(false); setFiles(null); }}
                    />
                </ReactSuspense>
            )}
            {expanded && docDef.kind !== 'form' && (
                <div className="mt-2 pl-9 space-y-1">
                    {loadingFiles ? (
                        <p className="text-[11px] text-dd-text-2 italic">{tx('Loading…', 'Cargando…')}</p>
                    ) : (files && files.length > 0) ? files.map(f => (
                        <div key={f.fullPath} className="flex items-center gap-2 bg-dd-bg rounded p-1.5">
                            <span className="text-base">📎</span>
                            <div className="flex-1 min-w-0">
                                <div className="text-[11px] font-semibold text-dd-text truncate">{f.name}</div>
                                <div className="text-[9px] text-dd-text-2">
                                    {/* Template docs can hold TWO versions side by side —
                                        the hire's signed submission (filled_) and the
                                        employer-completed one (complete_, I-9 Section 2).
                                        Label them so admin opens the right one. */}
                                    {docDef.kind === 'template' && (
                                        <span className={`font-bold mr-1 ${/^complete_/i.test(f.name) ? 'text-purple-700' : ''}`}>
                                            {/^complete_/i.test(f.name)
                                                ? tx('👔 Employer-complete', '👔 Completado por empleador')
                                                : tx('✍️ Hire submission', '✍️ Enviado por contratado')}
                                            {' · '}
                                        </span>
                                    )}
                                    {f.contentType || ''}{f.size ? ` · ${Math.round(f.size / 1024)} KB` : ''}
                                </div>
                            </div>
                            <a href={f.url} target="_blank" rel="noopener noreferrer"
                                onClick={() => onWriteAudit('doc_viewed', { hireId: hire.id, docId: docDef.id, file: f.name })}
                                className="text-[10px] px-2 py-1 rounded bg-blue-100 text-blue-700 font-bold hover:bg-blue-200">
                                {tx('View', 'Ver')}
                            </a>
                            <a href={f.url} download={f.name} target="_blank" rel="noopener noreferrer"
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
// Quick-pick presets for the doc subset picker. Each preset is a list of
// doc IDs from ONBOARDING_DOCS. Used by the AddHireModal so an admin can
// say "just send the W-4s" or "just send direct deposit" without manually
// unchecking 9 other boxes.
const SUBSET_PRESETS = [
    { id: 'full',     en: 'Full onboarding (all docs)',         es: 'Onboarding completo',           docs: null /* = all */ },
    { id: 'dd',       en: 'Direct deposit only',                es: 'Solo depósito directo',         docs: ['direct_deposit', 'voided_check'] },
    { id: 'tax',      en: 'Tax forms only (W-4s)',              es: 'Solo formularios de impuestos', docs: ['w4_fed', 'w4_mo'] },
    { id: 'i9',       en: 'I-9 + IDs only',                     es: 'Solo I-9 + IDs',                docs: ['i9', 'id_doc_1', 'id_doc_2'] },
    { id: 'hep_a',    en: 'Hep A vaccination record only',      es: 'Solo registro de Hep A',        docs: ['hep_a_record'] },
    { id: 'custom',   en: 'Custom — pick docs below',           es: 'Personalizado — elige abajo',   docs: 'custom' },
];

function AddHireModal({ isEs, prefill, storeLocation, staffName, onClose, onCreated }) {
    const tx = (en, es) => (isEs ? es : en);
    // EDIT MODE: when a real existing hire (with id) is passed in, the
    // modal switches from "create new" to "patch existing." Same form,
    // different submit path. Created so Andrew can fix typos in name /
    // position / wage AFTER the invite was generated but before the hire
    // opens it (and even after — the hire portal pulls fresh data on
    // every load, so edits propagate immediately).
    //
    // PREFILL FROM APPLICATION: still works — applications coming from
    // the lock-screen Apply form have NO id and the modal treats them
    // as create-with-prefilled-name flow. Discriminator is prefill.id.
    const isEditing = !!prefill?.id;
    const [name, setName] = useState(prefill?.name || '');
    const [email, setEmail] = useState(prefill?.email || '');
    const [phone, setPhone] = useState(prefill?.phone || '');
    const [position, setPosition] = useState(prefill?.position || '');
    const [location, setLocation] = useState(prefill?.location || storeLocation || 'webster');
    const [hireDate, setHireDate] = useState(prefill?.hireDate || '');
    // Offer amount — free-form so the admin can type "$15.00/hr" or
    // "$45,000/year" or whatever fits. Stored verbatim on the hire record
    // and auto-filled into any template field bound to `offerAmount`
    // (typically an offer letter blank).
    const [offerAmount, setOfferAmount] = useState(prefill?.offerAmount || '');
    const [saving, setSaving] = useState(false);
    // Doc selection. Default 'full' = entire required-doc list. Picking
    // a preset auto-sets the customDocs list; 'custom' lets admin
    // hand-pick from a checkbox grid.
    //
    // EDIT MODE init: derive the starting preset + customDocs from the
    // hire's existing subsetDocs so the picker reflects what they
    // currently see.
    //   - prefill.subsetDocs missing/null  → preset 'full'
    //   - prefill.subsetDocs matches a named preset exactly → that preset
    //   - anything else → preset 'custom' with the array pre-loaded
    //
    // Note on "what happens to a submitted doc that's removed from the
    // subset": the file stays in Storage (path includes hireId+docId so
    // it's still accessible to admin via the zip export) and the
    // checklist entry stays on the hire record. The portal + admin
    // detail page just stop SHOWING it. If you re-add the doc later,
    // the prior submission re-appears intact. So this is hide/show,
    // not delete — safe to change at any point in the hire's flow.
    const subsetEq = (a, b) => {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        const sa = [...a].sort();
        const sb = [...b].sort();
        return sa.every((v, i) => v === sb[i]);
    };
    const initialPresetId = (() => {
        const prefSubset = prefill?.subsetDocs;
        if (!Array.isArray(prefSubset)) return 'full';
        // Try named presets (skip 'full'=null and 'custom'=string sentinel).
        const match = SUBSET_PRESETS.find(p =>
            Array.isArray(p.docs) && subsetEq(p.docs, prefSubset)
        );
        return match ? match.id : 'custom';
    })();
    const [presetId, setPresetId] = useState(initialPresetId);
    // Custom doc list — what's checked when admin picks the "Custom" preset.
    //
    // Seed strategy:
    //   - Edit mode w/ existing subset → use the hire's current subset (so the
    //     picker reflects what they currently see).
    //   - Otherwise → START EMPTY. The UI used to pre-check every doc, which
    //     was a trap: admin who wanted "just the W-4s" would click the W-4
    //     rows, *unchecking* them, and the hire would receive every doc
    //     EXCEPT the W-4s. Empty default means click = select, which matches
    //     what people expect. Switching from a named preset to 'custom'
    //     seeds with that preset's docs (see handlePresetChange below) so
    //     the admin can refine a preset rather than start over.
    const [customDocs, setCustomDocs] = useState(() => {
        if (isEditing && Array.isArray(prefill?.subsetDocs)) return prefill.subsetDocs;
        return [];
    });
    // When admin changes the preset dropdown, seed customDocs from the
    // preset they're leaving so "switch to custom and tweak" works. If
    // they're leaving 'full' (all docs) → seed with all so they can subtract.
    const handlePresetChange = (nextId) => {
        if (nextId === 'custom' && presetId !== 'custom') {
            if (presetId === 'full') {
                setCustomDocs(ONBOARDING_DOCS.map(d => d.id));
            } else {
                const prev = SUBSET_PRESETS.find(p => p.id === presetId);
                if (prev && Array.isArray(prev.docs)) setCustomDocs(prev.docs);
            }
        }
        setPresetId(nextId);
    };
    const activePreset = SUBSET_PRESETS.find(p => p.id === presetId) || SUBSET_PRESETS[0];
    const selectedDocs = activePreset.docs === null
        ? null   // null = all required docs (default new-hire flow)
        : activePreset.docs === 'custom'
            ? customDocs
            : activePreset.docs;
    const canSubmit = name.trim().length > 1 && !saving
        && (isEditing || presetId !== 'custom' || customDocs.length > 0);

    const submit = async (e) => {
        e?.preventDefault();
        if (!canSubmit) return;
        setSaving(true);
        try {
            if (isEditing) {
                // Patch the existing hire — fields this modal owns +
                // subsetDocs. Don't touch checklist, status, or any
                // hire-submitted payload (personal info, emergency
                // contact). The hire's portal pulls fresh data on every
                // open so subsetDocs changes take effect immediately —
                // if a doc was hidden and you add it back, prior uploads
                // re-appear (checklist entry is still on the record).
                await updateDoc(doc(db, 'onboarding_hires', prefill.id), {
                    name: name.trim(),
                    email: email.trim(),
                    phone: phone.trim(),
                    position: position.trim(),
                    location,
                    hireDate,
                    offerAmount: offerAmount.trim(),
                    subsetDocs: selectedDocs,
                    updatedAt: new Date().toISOString(),
                    updatedBy: staffName || 'admin',
                });
                // Pass null token so the parent knows this was an edit
                // (don't pop the invite-link sheet) — same callback name,
                // different behavior based on token presence.
                onCreated({
                    ...prefill,
                    name: name.trim(),
                    email: email.trim(),
                    phone: phone.trim(),
                    position: position.trim(),
                    location,
                    hireDate,
                    offerAmount: offerAmount.trim(),
                    subsetDocs: selectedDocs,
                }, null);
                return;
            }
            const hireRef = doc(collection(db, 'onboarding_hires'));
            const hire = {
                id: hireRef.id,
                name: name.trim(),
                email: email.trim(),
                phone: phone.trim(),
                position: position.trim(),
                location,
                hireDate,
                offerAmount: offerAmount.trim(),
                status: HIRE_STATUS.INVITED,
                checklist: {},
                // subsetDocs: null/missing = full required-doc flow. Array
                // of doc IDs = ONLY those docs visible to this hire (used
                // for "send just one form" follow-ups).
                subsetDocs: selectedDocs,
                // Application linkage — when conversion came from an
                // applicant we carry the source app id + minor flag +
                // language hint so the hire portal can default ES if
                // the application was filled in Spanish. Optional, only
                // present when prefill came from convertApplication().
                ...(prefill?.sourceApplicationId ? { sourceApplicationId: prefill.sourceApplicationId } : {}),
                ...(prefill?.isMinor === true ? { isMinor: true } : {}),
                ...(prefill?.preferredLanguage ? { preferredLanguage: prefill.preferredLanguage } : {}),
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
            // If this hire was converted from an application, flip the
            // application's status to 'hired' so it stops showing up in
            // the Open filter + so the lifecycle Cloud Function leaves
            // it alone (hired apps are excluded from the 180-day purge).
            if (prefill?.sourceApplicationId) {
                try {
                    await updateDoc(doc(db, 'onboarding_applications', prefill.sourceApplicationId), {
                        status: 'hired',
                        hireId: hireRef.id,
                        statusUpdatedAt: new Date().toISOString(),
                        statusUpdatedBy: staffName || 'admin',
                    });
                } catch (e) { console.warn('failed to mark application hired:', e); }
            }
            onCreated({ ...hire }, token);
        } catch (e) {
            console.error(isEditing ? 'Edit hire failed:' : 'Create hire failed:', e);
            toast((isEditing ? tx('Could not save: ', 'No se pudo guardar: ') : tx('Could not create hire: ', 'No se pudo crear: ')) + (e.message || e), { kind: 'error', duration: 6000 });
        } finally {
            setSaving(false);
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            {/* Modal layout: header + footer flex-shrink-0, middle body
                gets flex-1 + overflow-y-auto so the form scrolls when its
                content (especially the Custom doc checkbox list) exceeds
                viewport height. Save / Cancel stay pinned at the bottom
                — they were getting pushed off-screen on mobile when the
                Custom preset was selected. */}
            <form onSubmit={submit} className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl max-h-[95vh] sm:max-h-[90vh] flex flex-col">
                <div className="border-b border-dd-line p-4 flex items-center justify-between flex-shrink-0 safe-top [--safe-top-base:1rem]">
                    <h3 className="text-lg font-black text-dd-text">
                        {isEditing
                            ? <>✏️ {tx('Edit hire', 'Editar contratación')}</>
                            : <>🪪 {tx('New hire', 'Nueva contratación')}</>}
                    </h3>
                    <button type="button" onClick={onClose} className="w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-lg">×</button>
                </div>
                <div className="p-4 space-y-3 flex-1 overflow-y-auto">
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

                    {/* Offer amount — free-form text so it works for hourly,
                        salaried, tipped, etc. Auto-fills the {offerAmount}
                        autofill binding on any template (offer letter). */}
                    <Field label={tx('Offer amount (optional)', 'Monto de oferta (opcional)')}>
                        <input value={offerAmount} onChange={e => setOfferAmount(e.target.value)}
                            placeholder={tx('$15.00 / hr', '$15.00 / hr')}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm" />
                        <p className="text-[10px] text-dd-text-2 mt-0.5 italic">
                            {tx('Used in the offer letter template (if you upload one). Type whatever format fits.',
                                'Se usa en la plantilla de la carta de oferta. Escribe el formato que te convenga.')}
                        </p>
                    </Field>

                    {/* Doc subset picker — pick a preset or hand-select.
                        Default 'full' sends the entire required-doc flow.
                        Other presets target common follow-up cases:
                        "I just need a new W-4 from Maria" → tax preset.
                        Shown in EDIT mode too — admin can shrink or expand
                        the hire's checklist after the invite was sent.
                        Removing a doc with prior submissions just HIDES
                        them; the files stay in Storage and the checklist
                        entry on the hire record is preserved. Re-adding
                        the doc later brings the prior submission back. */}
                    <Field label={
                        isEditing
                            ? tx('Which docs do they fill out?', '¿Qué documentos llenan?')
                            : tx('Which docs to send?', '¿Qué documentos enviar?')
                    }>
                        <select value={presetId} onChange={e => handlePresetChange(e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm bg-white">
                            {SUBSET_PRESETS.map(p => (
                                <option key={p.id} value={p.id}>{isEs ? p.es : p.en}</option>
                            ))}
                        </select>
                        {presetId === 'custom' && (
                            <div className="mt-2 bg-dd-bg rounded-lg p-2 max-h-48 overflow-y-auto">
                                <div className="flex gap-1 mb-1 px-1">
                                    <button type="button"
                                        onClick={() => setCustomDocs(ONBOARDING_DOCS.map(d => d.id))}
                                        className="text-[10px] font-bold px-2 py-0.5 rounded bg-white border border-dd-line text-dd-text-2 hover:border-dd-green hover:text-dd-green">
                                        {tx('Pick all', 'Todos')}
                                    </button>
                                    <button type="button"
                                        onClick={() => setCustomDocs([])}
                                        className="text-[10px] font-bold px-2 py-0.5 rounded bg-white border border-dd-line text-dd-text-2 hover:border-dd-green hover:text-dd-green">
                                        {tx('Clear', 'Limpiar')}
                                    </button>
                                </div>
                                <div className="grid grid-cols-1 gap-1">
                                    {ONBOARDING_DOCS.map(d => {
                                        const checked = customDocs.includes(d.id);
                                        return (
                                            <label key={d.id} className="flex items-center gap-2 p-1 cursor-pointer hover:bg-white rounded text-[12px]">
                                                <input type="checkbox" checked={checked}
                                                    onChange={() => setCustomDocs(prev => checked
                                                        ? prev.filter(x => x !== d.id)
                                                        : [...prev, d.id])}
                                                    className="w-4 h-4 accent-dd-green" />
                                                <span className="text-base">{d.emoji}</span>
                                                <span className="flex-1 text-dd-text font-semibold truncate">{isEs ? d.es : d.en}</span>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                        {/* "Will send" preview — single source of truth so admin
                            can see exactly which docs the hire will receive
                            regardless of preset / custom. Catches the "I picked
                            tax but it sent everything else" class of bugs. */}
                        {(() => {
                            const list = activePreset.docs === null
                                ? ONBOARDING_DOCS.map(d => d.id)
                                : activePreset.docs === 'custom'
                                    ? customDocs
                                    : activePreset.docs;
                            const names = list.map(id => {
                                const d = ONBOARDING_DOCS.find(x => x.id === id);
                                return d ? (isEs ? d.es : d.en) : id;
                            });
                            return (
                                <p className="text-[11px] text-dd-text-2 mt-1 px-1 leading-snug">
                                    <span className="font-bold text-dd-text">
                                        {tx(`Will send ${list.length} doc${list.length === 1 ? '' : 's'}:`,
                                            `Enviará ${list.length} doc${list.length === 1 ? '' : 's'}:`)}
                                    </span>{' '}
                                    {list.length === 0
                                        ? <span className="text-red-600 italic">{tx('nothing selected — pick at least one', 'nada seleccionado — elige al menos uno')}</span>
                                        : names.join(', ')}
                                </p>
                            );
                        })()}
                    </Field>

                    <p className="text-[11px] text-dd-text-2 mt-2 bg-dd-bg p-2 rounded">
                        {isEditing
                            ? tx(
                                'Edits apply immediately — hire sees changes on next portal open. Removing a doc just hides it; their prior submission stays in Storage and re-appears if you add the doc back.',
                                'Los cambios se aplican al instante. Quitar un documento lo oculta; los archivos previos se conservan y reaparecen si lo vuelves a agregar.',
                            )
                            : tx(
                                'A one-time invite link + QR will be generated. The hire only sees the selected docs.',
                                'Se generará un enlace + QR. El contratado solo verá los documentos seleccionados.',
                            )}
                    </p>
                </div>
                <div className="border-t border-dd-line p-4 flex gap-2 flex-shrink-0">
                    <button type="button" onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-dd-bg text-dd-text-2 font-bold">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button type="submit" disabled={!canSubmit}
                        className="flex-1 py-2 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50">
                        {saving
                            ? (isEditing ? tx('Saving…', 'Guardando…') : tx('Creating…', 'Creando…'))
                            : (isEditing ? tx('Save changes', 'Guardar cambios') : tx('Create + invite', 'Crear + invitar'))}
                    </button>
                </div>
            </form>
        </div>
        </ModalPortal>
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
    const copiedTimerRef = useRef(null);

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

    useEffect(() => {
        return () => {
            if (copiedTimerRef.current) {
                clearTimeout(copiedTimerRef.current);
                copiedTimerRef.current = null;
            }
        };
    }, []);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = setTimeout(() => {
                copiedTimerRef.current = null;
                setCopied(false);
            }, 2000);
        } catch (e) {
            console.warn('clipboard write failed', e);
            toast(tx('Copy failed — long-press the link to copy', 'No se pudo copiar — mantén presionado el enlace'), { kind: 'error' });
        }
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
        <ModalPortal>
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl">
                <div className="border-b border-dd-line p-4 flex items-center justify-between safe-top [--safe-top-base:1rem]">
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
        </ModalPortal>
    );
}

// ── ApplicationsList ──────────────────────────────────────────────────────
// ── ApplicationsList (v2) ─────────────────────────────────────────────────
// Filter + sort header, match-score badges per app, expandable rich cards.
// Match score is computed client-side from the application doc shape; see
// computeMatchScore() in src/data/applyForm.js for the formula.
function ApplicationsList({ applications, isEs, staffName, onConvert, onStatusChange, onToggleStar, onDismiss }) {
    const tx = (en, es) => (isEs ? es : en);
    const [filterLocation, setFilterLocation] = useState('all');
    const [filterPosition, setFilterPosition] = useState('all');
    const [filterStatus, setFilterStatus] = useState('open');  // 'open' = anything not hired/not_selected/withdrew/expired
    const [filterHasExp, setFilterHasExp] = useState(false);
    const [sortBy, setSortBy] = useState('newest'); // 'newest' | 'match'

    const enriched = useMemo(() => applications.map(a => ({ ...a, _score: computeMatchScore(a) })), [applications]);

    const filtered = useMemo(() => {
        let list = [...enriched];
        // Location filter — apps may have either v2 (locations array) or v1
        // (single location string), so check both.
        if (filterLocation !== 'all') {
            list = list.filter(a => {
                const v2 = Array.isArray(a.locations) ? a.locations : null;
                if (v2) return v2.includes(filterLocation) || v2.includes('either');
                return a.location === filterLocation || a.location === 'either';
            });
        }
        if (filterPosition !== 'all') {
            list = list.filter(a => {
                const v2 = Array.isArray(a.positionsAppliedFor) ? a.positionsAppliedFor : null;
                if (v2) return v2.includes(filterPosition);
                // v1 stored position as the English label; match leniently.
                const pos = POSITIONS.find(p => p.id === filterPosition);
                return pos && (a.position === pos.en || a.position === pos.es);
            });
        }
        if (filterStatus !== 'all') {
            const closedStatuses = ['hired', 'not_selected', 'withdrew', 'expired'];
            list = list.filter(a => {
                const s = a.status || 'applied';
                if (filterStatus === 'open') return !closedStatuses.includes(s);
                return s === filterStatus;
            });
        }
        if (filterHasExp) {
            list = list.filter(a => {
                const exp = a.restaurantExperienceYears;
                if (exp === 'none' || exp === 'lt_6mo') return false;
                return !!exp;
            });
        }
        if (sortBy === 'match') {
            list.sort((a, b) => (b._score || 0) - (a._score || 0));
        } else {
            list.sort((a, b) => {
                const ta = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
                const tb = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
                return tb - ta;
            });
        }
        return list;
    }, [enriched, filterLocation, filterPosition, filterStatus, filterHasExp, sortBy]);

    return (
        <div className="space-y-3">
            <HiringQrPanel isEs={isEs} />
            <ApplicationsFilters
                isEs={isEs}
                filterLocation={filterLocation} setFilterLocation={setFilterLocation}
                filterPosition={filterPosition} setFilterPosition={setFilterPosition}
                filterStatus={filterStatus} setFilterStatus={setFilterStatus}
                filterHasExp={filterHasExp} setFilterHasExp={setFilterHasExp}
                sortBy={sortBy} setSortBy={setSortBy}
                total={applications.length} shown={filtered.length} />
            {filtered.length === 0 ? (
                <div className="bg-white border border-dd-line rounded-xl p-8 text-center">
                    <p className="text-4xl mb-2">📭</p>
                    <p className="text-sm font-semibold text-dd-text-2">
                        {applications.length === 0
                            ? tx('No pending applications.', 'Sin aplicaciones pendientes.')
                            : tx('No applications match the current filters.', 'Ninguna aplicación coincide con los filtros.')}
                    </p>
                    {applications.length === 0 && (
                        <p className="text-[11px] text-dd-text-2 mt-1">
                            {tx('Share the Hiring QR above on flyers, Indeed posts, etc.',
                                'Comparte el QR de arriba en folletos, anuncios, etc.')}
                        </p>
                    )}
                </div>
            ) : (
                <div className="space-y-2">
                    {filtered.map(a => (
                        <ApplicationCard key={a.id} app={a} isEs={isEs} staffName={staffName}
                            onConvert={onConvert} onStatusChange={onStatusChange}
                            onToggleStar={onToggleStar} onDismiss={onDismiss} />
                    ))}
                </div>
            )}
        </div>
    );
}

function ApplicationsFilters({
    isEs, filterLocation, setFilterLocation, filterPosition, setFilterPosition,
    filterStatus, setFilterStatus, filterHasExp, setFilterHasExp,
    sortBy, setSortBy, total, shown,
}) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="bg-white border border-dd-line rounded-xl p-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold text-dd-text-2">
                    {tx(`Showing ${shown} of ${total}`, `Mostrando ${shown} de ${total}`)}
                </span>
                <div className="flex gap-1">
                    <button onClick={() => setSortBy('newest')}
                        className={`text-[10px] font-bold px-2 py-1 rounded ${
                            sortBy === 'newest' ? 'bg-dd-text text-white' : 'bg-dd-bg text-dd-text-2'
                        }`}>
                        🕒 {tx('Newest', 'Más reciente')}
                    </button>
                    <button onClick={() => setSortBy('match')}
                        className={`text-[10px] font-bold px-2 py-1 rounded ${
                            sortBy === 'match' ? 'bg-dd-text text-white' : 'bg-dd-bg text-dd-text-2'
                        }`}>
                        ⭐ {tx('Best match', 'Mejor coincidencia')}
                    </button>
                </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                <select value={filterLocation} onChange={e => setFilterLocation(e.target.value)}
                    className="text-[11px] border border-dd-line rounded px-1.5 py-1 bg-white">
                    <option value="all">{tx('All locations', 'Todas')}</option>
                    {LOCATIONS.filter(l => l.id !== 'either').map(l => (
                        <option key={l.id} value={l.id}>{isEs ? l.es : l.en}</option>
                    ))}
                </select>
                <select value={filterPosition} onChange={e => setFilterPosition(e.target.value)}
                    className="text-[11px] border border-dd-line rounded px-1.5 py-1 bg-white">
                    <option value="all">{tx('All positions', 'Todos los puestos')}</option>
                    {POSITIONS.map(p => (
                        <option key={p.id} value={p.id}>{isEs ? p.es : p.en}</option>
                    ))}
                </select>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                    className="text-[11px] border border-dd-line rounded px-1.5 py-1 bg-white">
                    <option value="open">{tx('Open only', 'Solo abiertas')}</option>
                    <option value="all">{tx('All statuses', 'Todas')}</option>
                    {Object.entries(APPLICATION_STATUS_META).map(([id, meta]) => (
                        <option key={id} value={id}>{isEs ? meta.es : meta.en}</option>
                    ))}
                </select>
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-dd-text-2 cursor-pointer">
                <input type="checkbox" checked={filterHasExp} onChange={e => setFilterHasExp(e.target.checked)}
                    className="w-4 h-4 accent-dd-green" />
                {tx('Has restaurant experience (6mo+)', 'Tiene experiencia (6mo+)')}
            </label>
        </div>
    );
}

function ApplicationCard({ app, isEs, staffName, onConvert, onStatusChange, onToggleStar, onDismiss }) {
    const tx = (en, es) => (isEs ? es : en);
    const [expanded, setExpanded] = useState(false);
    const created = app.createdAt && typeof app.createdAt === 'object' && app.createdAt.toDate
        ? app.createdAt.toDate()
        : (typeof app.createdAt === 'string' ? new Date(app.createdAt) : null);
    const status = app.status || 'applied';
    const meta = APPLICATION_STATUS_META[status] || APPLICATION_STATUS_META.applied;
    const score = app._score || 0;
    const starred = (app.starredBy || []).includes(staffName);

    // v2 fields with v1 fallbacks
    const positions = Array.isArray(app.positionsAppliedFor) && app.positionsAppliedFor.length
        ? app.positionsAppliedFor.map(p => labelFor(POSITIONS, p, isEs)).join(', ')
        : (app.position || '—');
    const locations = Array.isArray(app.locations) && app.locations.length
        ? app.locations.map(l => labelFor(LOCATIONS, l, isEs)).join(', ')
        : (app.location || '—');
    const expYears = app.restaurantExperienceYears
        ? labelFor(EXPERIENCE_YEARS, app.restaurantExperienceYears, isEs)
        : null;
    const langs = Array.isArray(app.spokenLanguages) ? app.spokenLanguages : [];
    const isBilingual = langs.includes('english') && langs.includes('spanish');
    const dinners = ['mon','tue','wed','thu','fri','sat','sun']
        .reduce((sum, d) => sum + ((app.availability && app.availability[d] && app.availability[d].dinner) ? 1 : 0), 0);

    return (
        <div className={`bg-white border-2 rounded-xl overflow-hidden transition ${
            starred ? 'border-amber-300 shadow-sm' :
            score >= 70 ? 'border-green-200' :
            'border-dd-line'
        }`}>
            <button onClick={() => setExpanded(s => !s)}
                className="w-full text-left p-3 hover:bg-dd-bg/40 transition">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex-1 min-w-[200px]">
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`text-[10px] font-black px-1.5 py-0.5 rounded ${
                                score >= 70 ? 'bg-green-100 text-green-800' :
                                score >= 40 ? 'bg-amber-100 text-amber-800' :
                                'bg-gray-100 text-gray-600'
                            }`}>⭐ {score}</span>
                            <span className="font-black text-sm text-dd-text">{app.legalName || app.name}</span>
                            {app.preferredName && app.preferredName !== app.legalName && (
                                <span className="text-[11px] text-dd-text-2">({app.preferredName})</span>
                            )}
                            {isBilingual && (
                                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">
                                    EN/ES
                                </span>
                            )}
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${meta.tone}`}>
                                {meta.emoji} {isEs ? meta.es : meta.en}
                            </span>
                        </div>
                        <div className="text-[11px] text-dd-text-2 mt-1">
                            💼 {positions} · 📍 {locations}
                        </div>
                        <div className="text-[11px] text-dd-text-2">
                            {expYears && <>🍳 {expYears}</>}
                            {dinners > 0 && <> · 📅 {tx(`${dinners} dinners/wk`, `${dinners} cenas/sem`)}</>}
                            {app.transportationMethod && <> · 🚗 {labelFor(TRANSPORT_OPTIONS, app.transportationMethod, isEs)}</>}
                        </div>
                        {created && (
                            <div className="text-[10px] text-dd-text-2 mt-0.5">
                                {created.toLocaleString()}
                            </div>
                        )}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); onToggleStar(app.id, app.starredBy); }}
                        className="text-xl"
                        title={starred ? tx('Unstar', 'Quitar estrella') : tx('Star', 'Marcar')}>
                        {starred ? '⭐' : '☆'}
                    </button>
                </div>
            </button>
            {expanded && (
                <div className="border-t border-dd-line p-3 bg-dd-bg/30 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
                        <ContactBlock app={app} isEs={isEs} />
                        <DetailsBlock app={app} isEs={isEs} dinners={dinners} />
                    </div>
                    {app.anythingElse && (
                        <div className="bg-white border border-dd-line rounded-lg p-2 text-[12px]">
                            <div className="font-bold text-dd-text-2 text-[10px] uppercase">{tx('Note', 'Nota')}</div>
                            <p className="text-dd-text italic mt-0.5">"{app.anythingElse}"</p>
                        </div>
                    )}
                    {app.resumePath && (
                        <ResumeLink appId={app.id} resumePath={app.resumePath} fileName={app.resumeFileName} isEs={isEs} />
                    )}
                    {Array.isArray(app.skillsList) && app.skillsList.length > 0 && (
                        <div>
                            <div className="font-bold text-dd-text-2 text-[10px] uppercase mb-1">{tx('Skills', 'Habilidades')}</div>
                            <div className="flex flex-wrap gap-1">
                                {app.skillsList.map(s => (
                                    <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-dd-line text-dd-text">
                                        {labelFor(SKILLS, s, isEs)}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {Array.isArray(app.certifications) && app.certifications.length > 0 && (
                        <div>
                            <div className="font-bold text-dd-text-2 text-[10px] uppercase mb-1">{tx('Certifications', 'Certificaciones')}</div>
                            <div className="flex flex-wrap gap-1">
                                {app.certifications.map(c => (
                                    <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-green-50 border border-green-200 text-green-800 font-bold">
                                        ✓ {labelFor(CERTIFICATIONS, c, isEs)}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {Array.isArray(app.pastEmployers) && app.pastEmployers.length > 0 && (
                        <div>
                            <div className="font-bold text-dd-text-2 text-[10px] uppercase mb-1">{tx('Past employers', 'Empleadores anteriores')}</div>
                            <div className="space-y-1">
                                {app.pastEmployers.map((e, i) => (
                                    <div key={i} className="text-[11px] bg-white border border-dd-line rounded p-1.5">
                                        <span className="font-bold">{e.role}</span> @ <span>{e.employer}</span>
                                        <span className="text-dd-text-2"> · {e.startMonth || '?'} – {e.stillHere ? tx('present', 'presente') : (e.endMonth || '?')}</span>
                                        {e.reasonLeft && <div className="italic text-dd-text-2 text-[10px]">↳ {e.reasonLeft}</div>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {Array.isArray(app.references) && app.references.length > 0 && (
                        <div>
                            <div className="font-bold text-dd-text-2 text-[10px] uppercase mb-1">{tx('References', 'Referencias')}</div>
                            <div className="space-y-1">
                                {app.references.map((r, i) => (
                                    <div key={i} className="text-[11px] bg-white border border-dd-line rounded p-1.5">
                                        <span className="font-bold">{r.name}</span>
                                        {r.relation && <> · {r.relation.replace(/_/g, ' ')}</>}
                                        {r.phone && <> · <a href={`tel:${r.phone}`} className="text-blue-600 underline">{r.phone}</a></>}
                                        {!r.mayContact && <span className="text-[9px] text-amber-600 ml-1">⚠ {tx('Asks not to contact', 'No contactar')}</span>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    <ActionButtonsRow app={app} isEs={isEs} onConvert={onConvert}
                        onStatusChange={onStatusChange} onDismiss={onDismiss} />
                </div>
            )}
        </div>
    );
}

// Resume link — fetches the download URL lazily so the admin can open
// or download the file the applicant attached during their submission.
// Storage rule allows public read on /applications/{appId}/* so this
// works without auth.
function ResumeLink({ appId, resumePath, fileName, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const [url, setUrl] = useState(null);
    const [err, setErr] = useState('');
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const u = await getDownloadURL(sref(storage, resumePath));
                if (alive) setUrl(u);
            } catch (e) {
                if (alive) setErr(String(e.message || e));
            }
        })();
        return () => { alive = false; };
    }, [resumePath]);
    if (err) return null;
    if (!url) return <p className="text-[11px] text-dd-text-2 italic">{tx('Loading resume…', 'Cargando CV…')}</p>;
    return (
        <a href={url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 bg-blue-50 border-2 border-blue-200 rounded-lg p-2 hover:bg-blue-100 transition">
            <span className="text-xl">📄</span>
            <div className="flex-1 min-w-0">
                <div className="text-[11px] font-bold text-blue-900 truncate">
                    {tx('Resume attached', 'CV adjunto')}
                </div>
                <div className="text-[10px] text-blue-700 truncate">{fileName || resumePath.split('/').pop()}</div>
            </div>
            <span className="text-[11px] text-blue-700 font-bold flex-shrink-0">↗ {tx('Open', 'Abrir')}</span>
        </a>
    );
}

function ContactBlock({ app, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="bg-white border border-dd-line rounded-lg p-2 space-y-0.5">
            <div className="font-bold text-dd-text-2 text-[10px] uppercase mb-1">{tx('Contact', 'Contacto')}</div>
            {app.phone && (
                <div>
                    📞 <a href={`tel:${app.phone}`} className="text-blue-600 underline">{app.phone}</a>
                </div>
            )}
            {app.email && (
                <div>
                    ✉ <a href={`mailto:${app.email}`} className="text-blue-600 underline truncate inline-block max-w-[200px] align-bottom">{app.email}</a>
                </div>
            )}
            {app.city && <div>🏠 {app.city}{app.state ? `, ${app.state}` : ''}</div>}
            {app.howFarFromRestaurant && (
                <div>📏 {labelFor(DISTANCE_OPTIONS, app.howFarFromRestaurant, isEs)}</div>
            )}
            {app.workAuthorized === true && <div className="text-green-700 font-bold">✓ {tx('Authorized to work', 'Autorizado para trabajar')}</div>}
            {app.workAuthorized === false && <div className="text-red-700 font-bold">⚠ {tx('Not authorized to work', 'No autorizado')}</div>}
            {app.isUnder18 === true && <div className="text-amber-700">⚠ {tx('Under 18 — needs work permit', 'Menor de 18 — requiere permiso')}</div>}
        </div>
    );
}

function DetailsBlock({ app, isEs, dinners }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="bg-white border border-dd-line rounded-lg p-2 space-y-0.5">
            <div className="font-bold text-dd-text-2 text-[10px] uppercase mb-1">{tx('Job details', 'Detalles')}</div>
            {app.soonestStartDate && <div>📅 {tx('Start', 'Inicio')}: {app.soonestStartDate}</div>}
            {app.desiredHours && <div>⏰ {labelFor(DESIRED_HOURS, app.desiredHours, isEs)}</div>}
            {app.desiredHourlyWage && <div>💰 ${app.desiredHourlyWage}/hr {tx('hoped', 'esperado')}</div>}
            {app.canLiftHowMuch && <div>💪 {labelFor(LIFTING_CAPACITY, app.canLiftHowMuch, isEs)}</div>}
            {app.canStandHowLong && <div>🦵 {labelFor(STANDING_HOURS, app.canStandHowLong, isEs)}</div>}
            {dinners > 0 && <div>🌙 {tx(`${dinners} dinner shifts/wk`, `${dinners} turnos de cena/sem`)}</div>}
            {app.isStudent === true && <div>🎓 {tx('Currently a student', 'Estudiante actualmente')}</div>}
            {Array.isArray(app.spokenLanguages) && app.spokenLanguages.length > 0 && (
                <div>🗣 {app.spokenLanguages.map(l => labelFor(LANGUAGES, l, isEs)).join(', ')}</div>
            )}
            {app.referralSource && <div className="text-[10px] text-dd-text-2 mt-1 italic">{tx('Heard via', 'Vía')}: {app.referralSource}{app.referredByName ? ` (${app.referredByName})` : ''}</div>}
        </div>
    );
}

function ActionButtonsRow({ app, isEs, onConvert, onStatusChange, onDismiss }) {
    const tx = (en, es) => (isEs ? es : en);
    const status = app.status || 'applied';
    // 2026-05-29 — Andrew: "i need to be able to export the application
    // because at the end they sign it and agree to terms that might
    // need to export one day." Exports the full filled-out application
    // (positions, contact, availability + note, experience, references,
    // consents, signature image, DocuSign-style timestamp) to a PDF
    // file. pdf-lib is lazy-imported by the builder so it doesn't
    // bloat the Onboarding chunk.
    const [exporting, setExporting] = useState(false);
    const [exportErr, setExportErr] = useState('');
    const handleExportPdf = async () => {
        setExporting(true);
        setExportErr('');
        try {
            const mod = await import('../data/applicationPdf');
            const bytes = await mod.buildApplicationPdf(app);
            mod.downloadApplicationPdf(bytes, app);
        } catch (e) {
            console.error('Export PDF failed:', e);
            setExportErr(tx('Export failed. Try again.', 'Falló la exportación. Intenta de nuevo.'));
        } finally {
            setExporting(false);
        }
    };
    return (
        <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
                {['screening', 'phone_screen', 'interview', 'offer', 'not_selected', 'withdrew'].map(s => {
                    const meta = APPLICATION_STATUS_META[s];
                    const active = status === s;
                    return (
                        <button key={s} onClick={() => onStatusChange(app.id, s)}
                            className={`text-[10px] font-bold px-2 py-1 rounded border-2 transition ${
                                active
                                    ? `${meta.tone} border-current`
                                    : 'bg-white border-dd-line text-dd-text-2 hover:border-dd-text-2'
                            }`}>
                            {meta.emoji} {isEs ? meta.es : meta.en}
                        </button>
                    );
                })}
            </div>
            <div className="flex flex-wrap gap-1">
                {app.phone && (
                    <a href={`tel:${app.phone}`}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 font-bold hover:bg-blue-200">
                        📞 {tx('Call', 'Llamar')}
                    </a>
                )}
                {app.phone && (
                    <a href={`sms:${app.phone}`}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 font-bold hover:bg-blue-200">
                        💬 {tx('Text', 'Mensaje')}
                    </a>
                )}
                {app.email && (
                    <a href={`mailto:${app.email}`}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 font-bold hover:bg-blue-200">
                        ✉ {tx('Email', 'Correo')}
                    </a>
                )}
                <button onClick={() => onConvert(app)}
                    className="text-[11px] px-2.5 py-1.5 rounded-lg bg-dd-green text-white font-bold hover:bg-dd-green/90">
                    ✓ {tx('Convert to hire', 'Crear contratación')}
                </button>
                <button onClick={handleExportPdf}
                    disabled={exporting}
                    title={tx('Save the signed application as a PDF (with signature + timestamp)',
                        'Guardar la solicitud firmada como PDF (con firma + fecha)')}
                    className="text-[11px] px-2.5 py-1.5 rounded-lg bg-purple-100 text-purple-700 font-bold hover:bg-purple-200 disabled:opacity-50">
                    {exporting
                        ? '… ' + tx('Building PDF', 'Generando PDF')
                        : '📥 ' + tx('Export PDF', 'Exportar PDF')}
                </button>
                <button onClick={() => onDismiss(app.id)}
                    className="text-[11px] px-2.5 py-1.5 rounded-lg bg-gray-200 text-gray-700 font-bold hover:bg-gray-300">
                    🗑 {tx('Delete', 'Eliminar')}
                </button>
            </div>
            {exportErr && (
                <p className="text-[11px] text-red-700 font-bold">{exportErr}</p>
            )}
        </div>
    );
}

// ── ReminderEmailButton ───────────────────────────────────────────────────
// Builds a mailto: link pre-filled with the hire's email + a body listing
// every required doc that's still outstanding, with deadlines. Admin
// clicks → their email client opens → they hit Send. We don't actually
// send email server-side (no SMTP wired) — admin stays in the loop.
//
// If the hire has no email on record, button is disabled with a hint.
// Every send-attempt writes an audit row so we can see who got pinged.
function ReminderEmailButton({ hire, docs, isEs, onWriteAudit, staffName }) {
    const tx = (en, es) => (isEs ? es : en);
    const checklist = hire.checklist || {};
    const missing = docs.filter(d => {
        const st = (checklist[d.id] && checklist[d.id].status) || DOC_STATUS.NEEDED;
        return d.required && st !== DOC_STATUS.SUBMITTED && st !== DOC_STATUS.APPROVED;
    });
    const disabled = !hire.email || missing.length === 0;

    const send = () => {
        const lines = missing.map(d => `• ${d.en}`).join('\n');
        const firstName = (hire.name || '').split(' ')[0] || '';
        const subject = `DD Mau onboarding — ${missing.length} doc${missing.length === 1 ? '' : 's'} still needed`;
        const body = [
            `Hi ${firstName},`,
            '',
            `Quick reminder — we still need the following from you to finish onboarding:`,
            '',
            lines,
            '',
            `Open your onboarding portal using the link we originally sent (or ask us to resend). Most items upload straight from your phone.`,
            '',
            `Thanks,`,
            staffName || 'DD Mau',
        ].join('\n');
        const url = `mailto:${encodeURIComponent(hire.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        // Belt-and-suspenders: copy the full message to the clipboard
        // BEFORE triggering mailto. In Capacitor WebView the mailto:
        // handler can fail silently if no native mail client is
        // configured, leaving the user with nothing. With the message
        // on the clipboard they can paste into iMessage / WhatsApp /
        // anywhere as a fallback. Cap-readiness audit 2026-05-31.
        try {
            const fullText = `To: ${hire.email}\nSubject: ${subject}\n\n${body}`;
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(fullText).catch(() => {});
            }
        } catch {}
        window.location.href = url;
        try {
            toast(tx(
                'Opening email — message also copied to clipboard',
                'Abriendo correo — mensaje también copiado al portapapeles',
            ));
        } catch {}
        try {
            onWriteAudit('reminder_emailed', {
                hireId: hire.id,
                hireName: hire.name,
                missingCount: missing.length,
                missingDocs: missing.map(d => d.id),
            });
        } catch {}
    };

    return (
        <button onClick={send} disabled={disabled}
            title={disabled
                ? (!hire.email
                    ? tx('No email on file for this hire', 'Sin correo en el registro')
                    : tx('All required docs submitted', 'Todos los documentos enviados'))
                : tx(`Email ${missing.length} reminder${missing.length === 1 ? '' : 's'} to ${hire.email}`,
                     `Enviar ${missing.length} recordatorio${missing.length === 1 ? '' : 's'} a ${hire.email}`)}
            className="text-[11px] px-2.5 py-1.5 rounded-lg bg-amber-100 text-amber-800 font-bold hover:bg-amber-200 disabled:opacity-50 disabled:cursor-not-allowed">
            📧 {tx(`Remind${missing.length > 0 ? ` (${missing.length})` : ''}`, `Recordar${missing.length > 0 ? ` (${missing.length})` : ''}`)}
        </button>
    );
}

// ── HiringQrPanel ────────────────────────────────────────────────────────
// Generates a QR code pointing at /?apply=1 so admins can share it on
// flyers, window decals, Indeed posts, etc. The applicant scans → lands
// directly on the job-application form. The staff lock screen (PIN pad)
// is never shown, so prospective hires don't see the staff portal exists.
//
// QR generation is lazy-loaded — same qrcode package as the new-hire
// invite sheet. Admin can copy the link, download the PNG, or print.
function HiringQrPanel({ isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    // Canonical apply URL is apply.ddmaustl.com — a Squarespace 302
    // forward to app.ddmaustl.com/?apply=1. Hardcoding it (instead of
    // building from window.location) means:
    //   - QR codes encode the short, memorable URL
    //   - Copy link gives admins the public-facing URL not whatever
    //     they happen to be browsing from
    //   - Print page shows "scan apply.ddmaustl.com" instead of the
    //     long query-string version
    // Local dev / preview build fallback uses window.location so QR
    // testing still works without leaving localhost.
    // Native app counts as prod-like — its origin is capacitor://localhost /
    // https://localhost, which is useless on the QR/scan link off-device.
    const isProdLike = typeof window !== 'undefined' && (
        !!window.Capacitor?.isNativePlatform?.() || /ddmaustl\.com|github\.io/.test(window.location.hostname)
    );
    const url = isProdLike
        ? 'https://apply.ddmaustl.com'
        : `${window.location.origin}${window.location.pathname.replace(/\/$/, '')}/?apply=1`;
    const [qrDataUrl, setQrDataUrl] = useState(null);
    const [copied, setCopied] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const copiedTimerRef = useRef(null);

    useEffect(() => {
        if (!expanded || qrDataUrl) return;
        let alive = true;
        (async () => {
            try {
                const QRCode = (await import('qrcode')).default;
                const dataUrl = await QRCode.toDataURL(url, {
                    width: 512,
                    margin: 1,
                    errorCorrectionLevel: 'M',
                });
                if (alive) setQrDataUrl(dataUrl);
            } catch (e) { console.warn('QR gen failed', e); }
        })();
        return () => { alive = false; };
    }, [expanded, qrDataUrl, url]);

    useEffect(() => {
        return () => {
            if (copiedTimerRef.current) {
                clearTimeout(copiedTimerRef.current);
                copiedTimerRef.current = null;
            }
        };
    }, []);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = setTimeout(() => {
                copiedTimerRef.current = null;
                setCopied(false);
            }, 2000);
        } catch {
            // Clipboard can reject in a WebView (focus/permission) — surface it
            // so the user copies manually instead of a silent no-op.
            toast(tx('Copy failed — long-press the link to copy', 'No se pudo copiar — mantén presionado el enlace'), { kind: 'error' });
        }
    };

    const download = async () => {
        if (!qrDataUrl) return;
        // The anchor `download` attribute is a no-op in iOS WKWebView. Route the
        // PNG through the bridge's downloadFile (web = same anchor behavior;
        // native = Filesystem + Share sheet so it saves to Files/Photos).
        try {
            const blob = await (await fetch(qrDataUrl)).blob();
            await downloadFile({ data: blob, fileName: 'dd-mau-hiring-qr.png', mimeType: 'image/png' });
        } catch {
            const a = document.createElement('a');
            a.href = qrDataUrl;
            a.download = 'dd-mau-hiring-qr.png';
            a.click();
        }
    };

    const printQr = () => {
        if (!qrDataUrl) return;
        // Open a new window with a print-friendly layout: big QR + the URL +
        // hire-now headline. Stick it on a window, give it to staff for
        // referral handoffs, etc.
        const html = `
            <html>
                <head>
                    <title>DD Mau — Hiring QR</title>
                    <style>
                        body { font-family: -apple-system, system-ui, sans-serif; text-align: center; padding: 48px 24px; }
                        h1 { font-size: 32px; margin: 0 0 8px; }
                        h2 { font-size: 20px; color: #444; margin: 0 0 32px; font-weight: 600; }
                        img { width: 360px; max-width: 80vw; height: auto; border: 1px solid #ddd; padding: 16px; background: white; }
                        .url { margin-top: 24px; font-family: monospace; font-size: 14px; color: #666; }
                        .tag { margin-top: 8px; font-size: 12px; color: #999; }
                        @media print { @page { margin: 0.5in; } }
                    </style>
                </head>
                <body>
                    <h1>👋 We're hiring at DD Mau</h1>
                    <h2>Scan to apply — takes 1 minute</h2>
                    <img src="${qrDataUrl}" alt="Apply QR" />
                    <div class="url">${url}</div>
                    <div class="tag">Or visit the link above</div>
                </body>
            </html>
        `;
        // Native iOS/Android: window.open returns null inside the WebView, so
        // route through the printer bridge like the app's other print paths.
        if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Hiring QR'); return; }
        const w = window.open('', '_blank');
        if (!w) return;
        w.document.write(html);
        w.document.close();
        setTimeout(() => { try { w.print(); } catch {} }, 300);
    };

    return (
        <div className="bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-200 rounded-xl">
            <button onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center justify-between p-3 text-left">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xl">🪧</span>
                    <div className="min-w-0">
                        <p className="text-[12px] font-black text-indigo-900">
                            {tx('Hiring QR code', 'QR de contratación')}
                        </p>
                        <p className="text-[10px] text-indigo-700 leading-snug">
                            {tx('Stick on a window, share on Indeed, send in a text. Applicants never see the staff portal.',
                                'Pega en una ventana, comparte en Indeed. Los aplicantes no ven el portal de personal.')}
                        </p>
                    </div>
                </div>
                <span className="text-indigo-700 text-sm">{expanded ? '▴' : '▾'}</span>
            </button>
            {expanded && (
                <div className="p-3 pt-0 space-y-2">
                    <div className="bg-white rounded-lg p-3 flex justify-center">
                        {qrDataUrl ? (
                            <img src={qrDataUrl} alt="Hiring QR" className="w-48 h-48" />
                        ) : (
                            <div className="w-48 h-48 flex items-center justify-center text-[11px] text-dd-text-2">
                                {tx('Generating…', 'Generando…')}
                            </div>
                        )}
                    </div>
                    <div className="bg-white rounded-lg p-2 border border-indigo-100">
                        <div className="text-[10px] font-bold uppercase text-indigo-800 mb-0.5">{tx('Apply link', 'Enlace para aplicar')}</div>
                        <div className="text-[11px] font-mono break-all text-dd-text">{url}</div>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                        <button onClick={copy}
                            className="py-1.5 rounded bg-white border border-indigo-200 text-indigo-800 text-[11px] font-bold hover:bg-indigo-50">
                            {copied ? '✓ ' + tx('Copied', 'Copiado') : '📋 ' + tx('Copy', 'Copiar')}
                        </button>
                        <button onClick={download} disabled={!qrDataUrl}
                            className="py-1.5 rounded bg-white border border-indigo-200 text-indigo-800 text-[11px] font-bold hover:bg-indigo-50 disabled:opacity-50">
                            ↓ {tx('PNG', 'PNG')}
                        </button>
                        <button onClick={printQr} disabled={!qrDataUrl}
                            className="py-1.5 rounded bg-indigo-600 text-white text-[11px] font-bold hover:bg-indigo-700 disabled:opacity-50">
                            🖨 {tx('Print', 'Imprimir')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ── PoliciesEditor ────────────────────────────────────────────────────────
// Lets admin read + edit the three acknowledgment-kind policy documents
// (handbook, tip_credit, workers_comp) that hires sign during onboarding.
//
// Storage model:
//   - Default text ships in src/data/onboardingPolicies.js (DEFAULT_POLICIES).
//   - Admin overrides are persisted to /config/policies as a single doc
//     with shape { handbook: { en, es }, tip_credit: { en, es }, … }.
//   - The hire-side OnboardingAcknowledgment loads the override first,
//     falls back to DEFAULT_POLICIES when the override key is missing.
//
// Editor flow:
//   - On mount: read /config/policies, merge with DEFAULT_POLICIES so each
//     row knows whether it's CUSTOM (override present) or DEFAULT (bundled).
//   - Per row: title + EN body + ES body textareas, save / reset buttons,
//     a preview pane that renders body in a scrollable card like the
//     hire portal shows it.
//   - Save: setDoc(...,{merge:true}) so we only touch the edited key.
//   - Reset: writes { en: deleteField(), es: deleteField() } for that
//     policyKey — falls back to DEFAULT_POLICIES on next hire view.
function PoliciesEditor({ isEs, staffName, onWriteAudit }) {
    const tx = (en, es) => (isEs ? es : en);
    const [overrides, setOverrides] = useState(null); // null = loading
    const [savingKey, setSavingKey] = useState('');
    const [err, setErr] = useState('');

    // Pull the policies catalog from src/data so we know which keys exist
    // and what defaults to show. Importing lazily to keep the bundle slim.
    const [defaults, setDefaults] = useState(null);
    useEffect(() => {
        (async () => {
            try {
                const mod = await import('../data/onboardingPolicies');
                setDefaults(mod.DEFAULT_POLICIES);
            } catch (e) { console.warn('policies catalog load failed', e); }
        })();
    }, []);

    // Load existing overrides from /config/policies.
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const snap = await getDoc(doc(db, 'config', 'policies'));
                if (!alive) return;
                setOverrides(snap.exists() ? (snap.data() || {}) : {});
            } catch (e) {
                console.warn('policies load failed', e);
                if (alive) { setOverrides({}); setErr(String(e.message || e)); }
            }
        })();
        return () => { alive = false; };
    }, []);

    const policyKeys = defaults ? Object.keys(defaults) : [];

    const saveOne = async (key, en, es) => {
        setSavingKey(key);
        setErr('');
        try {
            // Use setDoc with merge:true so we don't clobber other policy
            // keys when saving just this one. Title + body live nested
            // under the policy key.
            const patch = {
                [key]: {
                    en: { title: en.title, body: en.body },
                    es: { title: es.title, body: es.body },
                    updatedAt: new Date().toISOString(),
                    updatedBy: staffName || 'admin',
                },
            };
            await setDoc(doc(db, 'config', 'policies'), patch, { merge: true });
            setOverrides(prev => ({ ...(prev || {}), ...patch }));
            try { onWriteAudit('policy_edited', { policyKey: key }); } catch {}
        } catch (e) {
            console.error('policy save failed', e);
            setErr(String(e.message || e));
        } finally { setSavingKey(''); }
    };

    const resetOne = async (key) => {
        if (!confirm(tx(
            'Reset this policy back to the default text? Your custom edits will be lost.',
            '¿Restablecer al texto predeterminado? Se perderán tus ediciones.',
        ))) return;
        setSavingKey(key);
        setErr('');
        try {
            // Wipe just this key's override. deleteField inside a nested
            // path works via dot notation in updateDoc.
            await updateDoc(doc(db, 'config', 'policies'), {
                [key]: deleteField(),
            });
            setOverrides(prev => {
                const next = { ...(prev || {}) };
                delete next[key];
                return next;
            });
            try { onWriteAudit('policy_reset_to_default', { policyKey: key }); } catch {}
        } catch (e) {
            console.error('policy reset failed', e);
            setErr(String(e.message || e));
        } finally { setSavingKey(''); }
    };

    if (overrides === null || !defaults) {
        return <p className="text-center text-dd-text-2 py-8 text-sm">{tx('Loading policies…', 'Cargando políticas…')}</p>;
    }

    return (
        <div className="space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-[12px] text-blue-900">
                <p className="font-bold">📖 {tx('Policy editor', 'Editor de políticas')}</p>
                <p className="mt-1">
                    {tx(
                        'These are the three policies every new hire signs during onboarding (handbook, tip pool, workers\' comp). Edit the text here — your changes show up on the hire portal immediately. Reset reverts to the default text shipped with the app. Have legal review any meaningful change before publishing.',
                        'Estas son las tres políticas que cada nuevo contratado firma durante el onboarding (manual, fondo de propinas, compensación laboral). Edita el texto aquí — tus cambios aparecen en el portal del contratado de inmediato. Restablecer revierte al texto predeterminado.',
                    )}
                </p>
            </div>
            {err && <div className="bg-red-50 border-2 border-red-200 rounded-lg p-2 text-[12px] text-red-800">{err}</div>}
            {policyKeys.map(k => (
                <PolicyRow key={k}
                    policyKey={k}
                    defaultEn={defaults[k].en}
                    defaultEs={defaults[k].es}
                    override={overrides[k]}
                    saving={savingKey === k}
                    onSave={(en, es) => saveOne(k, en, es)}
                    onReset={() => resetOne(k)}
                    isEs={isEs} />
            ))}
        </div>
    );
}

function PolicyRow({ policyKey, defaultEn, defaultEs, override, saving, onSave, onReset, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const isCustom = !!(override && (override.en || override.es));
    // Local edit state seeded from override → default. Recomputed when
    // override changes (e.g. after Reset).
    const [enTitle, setEnTitle] = useState(override?.en?.title || defaultEn.title);
    const [enBody, setEnBody] = useState(override?.en?.body || defaultEn.body);
    const [esTitle, setEsTitle] = useState(override?.es?.title || defaultEs.title);
    const [esBody, setEsBody] = useState(override?.es?.body || defaultEs.body);
    const [open, setOpen] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [lang, setLang] = useState('en');

    useEffect(() => {
        setEnTitle(override?.en?.title || defaultEn.title);
        setEnBody(override?.en?.body || defaultEn.body);
        setEsTitle(override?.es?.title || defaultEs.title);
        setEsBody(override?.es?.body || defaultEs.body);
    }, [override?.en?.title, override?.en?.body, override?.es?.title, override?.es?.body, defaultEn.title, defaultEn.body, defaultEs.title, defaultEs.body]);

    const dirty = enTitle !== (override?.en?.title || defaultEn.title)
        || enBody !== (override?.en?.body || defaultEn.body)
        || esTitle !== (override?.es?.title || defaultEs.title)
        || esBody !== (override?.es?.body || defaultEs.body);

    const titleLabel = {
        handbook: tx('Employee handbook', 'Manual del empleado'),
        tip_credit: tx('Wage and tip pool notice', 'Aviso de salario y fondo de propinas'),
        // workers_comp policy removed 2026-05-13. Coverage now lives
        // inside the handbook + the posted notice at each location.
    }[policyKey] || policyKey;

    return (
        <div className="bg-white border border-dd-line rounded-xl overflow-hidden">
            <div className="p-3 flex items-center gap-2 hover:bg-dd-bg/40">
                <button onClick={() => setOpen(o => !o)} className="flex-1 flex items-center gap-2 text-left min-w-0">
                    <span className="text-2xl flex-shrink-0">📄</span>
                    <div className="flex-1 min-w-0">
                        <div className="font-bold text-sm text-dd-text truncate">{titleLabel}</div>
                        <div className="text-[11px] text-dd-text-2">
                            {isCustom
                                ? <>✏️ {tx('Custom', 'Personalizado')}{override?.updatedAt ? ` · ${new Date(override.updatedAt).toLocaleDateString()}` : ''}</>
                                : <>📦 {tx('Default (shipped with app)', 'Predeterminado')}</>}
                        </div>
                    </div>
                </button>
                <button onClick={() => setShowPreview(true)}
                    className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-blue-100 text-blue-700 hover:bg-blue-200 flex-shrink-0">
                    👁 {tx('View', 'Ver')}
                </button>
                <button onClick={() => setOpen(o => !o)}
                    className="text-dd-text-2 text-sm px-2 py-1 flex-shrink-0">
                    {open ? '▴' : tx('✏ Edit', '✏ Editar')}
                </button>
            </div>
            {open && (
                <div className="border-t border-dd-line p-3 space-y-3 bg-dd-bg/20">
                    <div className="flex gap-1">
                        <button onClick={() => setLang('en')}
                            className={`text-[11px] font-bold px-2.5 py-1 rounded ${
                                lang === 'en' ? 'bg-dd-text text-white' : 'bg-white border border-dd-line text-dd-text-2'
                            }`}>
                            🇺🇸 English
                        </button>
                        <button onClick={() => setLang('es')}
                            className={`text-[11px] font-bold px-2.5 py-1 rounded ${
                                lang === 'es' ? 'bg-dd-text text-white' : 'bg-white border border-dd-line text-dd-text-2'
                            }`}>
                            🇲🇽 Español
                        </button>
                        <button onClick={() => setShowPreview(true)}
                            className="ml-auto text-[11px] font-bold px-2.5 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200">
                            👁 {tx('Preview', 'Vista previa')}
                        </button>
                    </div>
                    <div>
                        <label className="block text-[11px] font-bold uppercase text-dd-text-2 mb-1">
                            {tx('Title', 'Título')}
                        </label>
                        <input
                            value={lang === 'en' ? enTitle : esTitle}
                            onChange={e => lang === 'en' ? setEnTitle(e.target.value) : setEsTitle(e.target.value)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                        <label className="block text-[11px] font-bold uppercase text-dd-text-2 mb-1">
                            {tx('Body', 'Cuerpo')}
                            <span className="ml-2 text-[10px] font-normal text-dd-text-2 normal-case">
                                {tx('Plain text. Section headers in CAPS. Use "- " for bullets (square/circle glyphs won\'t render in the signed PDF).',
                                    'Texto plano. Encabezados en MAYÚSCULAS. Usa "- " para viñetas.')}
                            </span>
                        </label>
                        <textarea
                            value={lang === 'en' ? enBody : esBody}
                            onChange={e => lang === 'en' ? setEnBody(e.target.value) : setEsBody(e.target.value)}
                            rows={24}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-[12px] font-mono leading-relaxed resize-y"
                            spellCheck={lang === 'en'} />
                        <p className="text-[10px] text-dd-text-2 mt-0.5 text-right">
                            {(lang === 'en' ? enBody : esBody).length.toLocaleString()} {tx('characters', 'caracteres')}
                        </p>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                        <button
                            onClick={() => onSave(
                                { title: enTitle, body: enBody },
                                { title: esTitle, body: esBody },
                            )}
                            disabled={!dirty || saving}
                            className="flex-1 py-2 rounded-lg bg-dd-green text-white text-sm font-bold disabled:opacity-50">
                            {saving ? tx('Saving…', 'Guardando…') : (dirty ? tx('💾 Save changes', '💾 Guardar cambios') : tx('No changes', 'Sin cambios'))}
                        </button>
                        {isCustom && (
                            <button onClick={onReset} disabled={saving}
                                className="px-3 py-2 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 text-sm font-bold hover:bg-amber-200 disabled:opacity-50">
                                ↺ {tx('Reset to default', 'Restablecer')}
                            </button>
                        )}
                    </div>
                </div>
            )}
            {showPreview && (
                <PolicyPreview
                    enTitle={enTitle} enBody={enBody}
                    esTitle={esTitle} esBody={esBody}
                    isEs={isEs}
                    onClose={() => setShowPreview(false)} />
            )}
        </div>
    );
}

function PolicyPreview({ enTitle, enBody, esTitle, esBody, isEs, onClose }) {
    const tx = (en, es) => (isEs ? es : en);
    const [lang, setLang] = useState('en');
    const title = lang === 'en' ? enTitle : esTitle;
    const body = lang === 'en' ? enBody : esBody;
    // ESC closes. Tap on the dimmed backdrop also closes (the
    // header × was the ONLY way out before; Andrew 2026-05-28 —
    // "in the policies tab in onboarding when i view the doc i
    // cant close and go back"). The inner card stops propagation
    // so taps INSIDE don't dismiss accidentally.
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <ModalPortal>
        <div
            className="fixed inset-0 z-50 bg-black/60 flex items-end sm:items-center justify-center p-3"
            onClick={onClose}
        >
            <div
                className="bg-white w-full sm:max-w-3xl max-h-[90vh] rounded-2xl flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-3 border-b border-dd-line flex items-center gap-2">
                    {/* Back button — explicit, big, labeled. Pairs
                        with the × in the corner so the close action
                        is hard to miss. */}
                    <button onClick={onClose}
                        className="flex items-center gap-1 text-[12px] font-bold px-2.5 py-1.5 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 flex-shrink-0">
                        ← {tx('Back', 'Atrás')}
                    </button>
                    <div className="flex-1 min-w-0">
                        <p className="text-[10px] font-bold uppercase text-dd-text-2">{tx('Preview', 'Vista previa')}</p>
                        <h3 className="text-base font-black text-dd-text truncate">{title}</h3>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                        <button onClick={() => setLang('en')}
                            className={`text-[10px] font-bold px-2 py-1 rounded ${
                                lang === 'en' ? 'bg-dd-text text-white' : 'bg-dd-bg text-dd-text-2'
                            }`}>
                            EN
                        </button>
                        <button onClick={() => setLang('es')}
                            className={`text-[10px] font-bold px-2 py-1 rounded ${
                                lang === 'es' ? 'bg-dd-text text-white' : 'bg-dd-bg text-dd-text-2'
                            }`}>
                            ES
                        </button>
                    </div>
                    <button onClick={onClose}
                        aria-label={tx('Close', 'Cerrar')}
                        className="w-10 h-10 rounded-full bg-dd-bg text-dd-text text-xl font-bold flex items-center justify-center hover:bg-dd-sage-50 flex-shrink-0">
                        ×
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto bg-gray-50 p-4">
                    <pre className="whitespace-pre-wrap font-sans text-[12px] text-gray-800 leading-relaxed">{body}</pre>
                </div>
                <div className="p-3 border-t border-dd-line flex items-center gap-2">
                    <p className="text-[10px] text-dd-text-2 italic flex-1">
                        {tx('This is how the policy renders to a hire on their portal. The signed PDF uses the same text in Helvetica — verify any special characters render here before saving.',
                            'Así se ve la política para un contratado. El PDF firmado usa el mismo texto en Helvetica.')}
                    </p>
                    <button onClick={onClose}
                        className="text-[12px] font-bold px-3 py-1.5 rounded-lg bg-dd-green text-white hover:bg-dd-green-700 flex-shrink-0">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── DocTextEditor ─────────────────────────────────────────────────────────
// Global override editor for the per-doc description strings that hires
// see on their portal. The Hep A description ("Photo of your Hep A
// vaccination card or doctor's record. Food-service requirement.") is
// the canonical example — it's accurate but doesn't tell the hire they
// have 30 days from their start date to turn it in. Andrew can rewrite
// it here ONCE and every hire (current + future) sees the better
// wording the next time they open the portal.
//
// Storage:
//   /config/onboarding_doc_text = {
//     overrides: { [docId]: { en, es } },
//     updatedAt, updatedBy
//   }
//
// Resolution: effectiveDocDescription() in src/data/onboarding.js. The
// resolver picks per-hire override (highest), then global override
// (this tab), then the hardcoded default from ONBOARDING_DOCS.
//
// Per-hire overrides — added in the same change as this editor — live
// inline on each DocReviewRow in the hire-detail view. Use those for
// one-off accommodations ("you have until Friday"); use THIS tab for
// wording everyone should see.
function DocTextEditor({ isEs, staffName, overrides, onWriteAudit }) {
    const tx = (en, es) => (isEs ? es : en);
    const [drafts, setDrafts] = useState(null);     // { [docId]: { en, es } }
    const [savingId, setSavingId] = useState('');
    const [err, setErr] = useState('');

    // Seed drafts from the live overrides snapshot the parent passes
    // in. We deliberately re-sync only when `overrides` itself swaps
    // identity (i.e. snapshot fired) AND we're not currently editing
    // an unsaved field — otherwise our typing would get clobbered on
    // every keystroke that fires another snapshot. Cheap proxy: if
    // drafts is null OR every field matches the persisted value, take
    // the fresh data.
    useEffect(() => {
        if (drafts === null) {
            setDrafts({ ...(overrides || {}) });
            return;
        }
        // We don't auto-overwrite unsaved drafts.
    }, [overrides]);

    const setField = (docId, lang, value) => {
        setDrafts(prev => ({
            ...(prev || {}),
            [docId]: {
                ...((prev || {})[docId] || {}),
                [lang]: value,
            },
        }));
    };

    const isDirty = (docId) => {
        const draft = (drafts || {})[docId] || {};
        const live  = (overrides || {})[docId] || {};
        const draftDays = draft.days !== undefined ? draft.days : '';
        const liveDays = typeof live.days === 'number' ? String(live.days) : '';
        return (draft.en || '') !== (live.en || '')
            || (draft.es || '') !== (live.es || '')
            || draftDays !== liveDays;
    };

    const saveOne = async (docId) => {
        setSavingId(docId);
        setErr('');
        try {
            const draft = (drafts || {})[docId] || {};
            const en = (draft.en || '').trim();
            const es = (draft.es || '').trim();
            // Parse days: blank → no days override; integer ≥ 0 otherwise.
            // Reject anything else to keep effectiveDaysFromHire's number
            // check from misfiring.
            let daysVal = null;
            const rawDays = draft.days;
            if (rawDays !== undefined && rawDays !== '' && rawDays !== null) {
                const n = parseInt(rawDays, 10);
                if (!Number.isFinite(n) || n < 0) {
                    setErr(tx('Days must be a whole number 0 or greater.',
                             'Los días deben ser un número entero ≥ 0.'));
                    setSavingId('');
                    return;
                }
                daysVal = n;
            }
            // If every field is empty / cleared, drop the whole override
            // entry so the hire falls back to the hardcoded default.
            const empty = !en && !es && daysVal === null;
            const overridePayload = { en, es };
            if (daysVal !== null) overridePayload.days = daysVal;
            const patch = empty
                ? {
                    [`overrides.${docId}`]: deleteField(),
                    updatedAt: new Date().toISOString(),
                    updatedBy: staffName || 'admin',
                }
                : {
                    [`overrides.${docId}`]: overridePayload,
                    updatedAt: new Date().toISOString(),
                    updatedBy: staffName || 'admin',
                };
            // setDoc + merge so we create the doc on first write without
            // wiping the rest of the overrides map. updateDoc would fail
            // if the parent doc didn't exist yet.
            await setDoc(doc(db, 'config', 'onboarding_doc_text'), patch, { merge: true });
            try { onWriteAudit(empty ? 'doc_text_cleared' : 'doc_text_set', { docId }); } catch {}
        } catch (e) {
            console.error('doc text save failed', e);
            setErr(String(e.message || e));
        } finally { setSavingId(''); }
    };

    const resetOne = async (docId) => {
        if (!confirm(tx(
            'Reset this doc\'s text back to the default? Your custom wording will be lost.',
            '¿Restablecer al texto predeterminado? Se perderán tus ediciones.',
        ))) return;
        setSavingId(docId);
        setErr('');
        try {
            await setDoc(doc(db, 'config', 'onboarding_doc_text'), {
                [`overrides.${docId}`]: deleteField(),
                updatedAt: new Date().toISOString(),
                updatedBy: staffName || 'admin',
            }, { merge: true });
            // Optimistically clear the local draft for this row.
            setDrafts(prev => {
                const next = { ...(prev || {}) };
                delete next[docId];
                return next;
            });
            try { onWriteAudit('doc_text_reset', { docId }); } catch {}
        } catch (e) {
            console.error('doc text reset failed', e);
            setErr(String(e.message || e));
        } finally { setSavingId(''); }
    };

    if (drafts === null) {
        return <p className="text-center text-dd-text-2 py-8 text-sm">{tx('Loading…', 'Cargando…')}</p>;
    }

    return (
        <div className="space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-[12px] text-blue-900">
                <p className="font-bold">📝 {tx('Doc text editor', 'Editor de texto de docs')}</p>
                <p className="mt-1">
                    {tx(
                        'Edit the description and the days-from-hire deadline each onboarding doc shows on the hire portal. Use this for changes that should apply to EVERYONE (e.g. "Hep A is now 45 days, not 30"). For one-off changes to a single hire, use the ✏️ pencil in that hire\'s doc row instead.',
                        'Edita la descripción y el plazo (días) que cada documento muestra. Úsalo para cambios que aplican a TODOS. Para una sola persona, usa el ✏️ en la fila del documento.',
                    )}
                </p>
                <p className="mt-1.5 text-blue-700">
                    {tx(
                        'Clear every field + save to revert to the hardcoded default.',
                        'Vacía todos los campos y guarda para volver al predeterminado.',
                    )}
                </p>
            </div>
            {err && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-[11px] text-red-800">{err}</div>
            )}
            <div className="space-y-2">
                {ONBOARDING_DOCS.map(d => {
                    const draft = drafts[d.id] || {};
                    const dirty = isDirty(d.id);
                    const hasOverride = Boolean((overrides || {})[d.id]);
                    // Pre-fill the EN textarea with the default
                    // description when no override exists, so admin
                    // can EDIT the existing text in place rather than
                    // retyping the whole thing from scratch. Andrew
                    // 2026-05-28: "i cant edit it. i dont want just a
                    // spot to write in the edit i want to be able to
                    // edit it." Same for ES, but fall back to EN
                    // (or default) so they have a starting point to
                    // translate. saveOne already treats unchanged-from-
                    // default + Save as a no-op via the empty-string
                    // branch + isDirty gate.
                    const enVal = draft.en !== undefined
                        ? draft.en
                        : ((overrides || {})[d.id]?.en ?? d.description ?? '');
                    const esVal = draft.es !== undefined
                        ? draft.es
                        : ((overrides || {})[d.id]?.es ?? d.description ?? '');
                    // Days: same priority as effectiveDaysFromHire —
                    // override.days if set, else docDef.daysFromHire.
                    // Kept as a string so the input can be cleared.
                    const daysVal = draft.days !== undefined
                        ? draft.days
                        : (typeof (overrides || {})[d.id]?.days === 'number'
                            ? String((overrides || {})[d.id].days)
                            : (typeof d.daysFromHire === 'number' ? String(d.daysFromHire) : ''));
                    const deadlineHint = d.daysFromHire
                        ? tx(`(Federal/legal: ${d.daysFromHire} day${d.daysFromHire === 1 ? '' : 's'} from hire date)`,
                              `(Federal/legal: ${d.daysFromHire} día${d.daysFromHire === 1 ? '' : 's'} desde la fecha de contratación)`)
                        : '';
                    return (
                        <div key={d.id} className="bg-white border border-dd-line rounded-xl p-3">
                            <div className="flex items-start gap-2 mb-2">
                                <span className="text-2xl">{d.emoji}</span>
                                <div className="flex-1 min-w-0">
                                    <div className="font-bold text-sm text-dd-text">
                                        {isEs ? d.es : d.en}
                                        {hasOverride && (
                                            <span className="ml-2 text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                                                {tx('CUSTOM', 'PERSONALIZADO')}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-[10px] text-dd-text-2 mt-0.5">
                                        {tx('Default:', 'Predeterminado:')} <span className="italic">{d.description}</span>
                                    </div>
                                    {deadlineHint && (
                                        <div className="text-[10px] text-amber-700 mt-0.5">⏱ {deadlineHint}</div>
                                    )}
                                </div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                <div>
                                    <label className="block text-[10px] font-bold uppercase text-dd-text-2 mb-1">
                                        {tx('English description', 'Descripción en inglés')}
                                    </label>
                                    <textarea
                                        value={enVal}
                                        onChange={(e) => setField(d.id, 'en', e.target.value)}
                                        rows={3}
                                        placeholder={d.description}
                                        className="w-full text-[11px] border border-dd-line rounded px-2 py-1 bg-white"
                                    />
                                </div>
                                <div>
                                    <label className="block text-[10px] font-bold uppercase text-dd-text-2 mb-1">
                                        {tx('Spanish description', 'Descripción en español')}
                                    </label>
                                    <textarea
                                        value={esVal}
                                        onChange={(e) => setField(d.id, 'es', e.target.value)}
                                        rows={3}
                                        placeholder={tx('(English will be shown if blank)', '(Se mostrará en inglés si está vacío)')}
                                        className="w-full text-[11px] border border-dd-line rounded px-2 py-1 bg-white"
                                    />
                                </div>
                            </div>
                            {/* Days from hire — drives the "⏱ Due in N
                                days" pill on the hire portal. Blank
                                clears the override and the hardcoded
                                default takes over again; 0 explicitly
                                hides the pill for this doc. */}
                            <div className="mt-2 flex items-center gap-2 flex-wrap">
                                <label className="text-[10px] font-bold uppercase text-dd-text-2">
                                    ⏱ {tx('Days from hire date', 'Días desde la fecha')}
                                </label>
                                <input
                                    type="number" min="0" step="1"
                                    value={daysVal}
                                    onChange={(e) => setField(d.id, 'days', e.target.value)}
                                    placeholder={typeof d.daysFromHire === 'number' ? String(d.daysFromHire) : tx('none', 'ninguno')}
                                    className="w-24 text-[11px] border border-dd-line rounded px-2 py-1 bg-white"
                                />
                                <span className="text-[10px] text-dd-text-2">
                                    {tx(`(Default: ${typeof d.daysFromHire === 'number' ? d.daysFromHire + 'd' : 'no deadline'})`,
                                        `(Predeterminado: ${typeof d.daysFromHire === 'number' ? d.daysFromHire + 'd' : 'sin plazo'})`)}
                                </span>
                            </div>
                            <div className="flex items-center gap-1.5 mt-2">
                                <button onClick={() => saveOne(d.id)}
                                    disabled={!dirty || savingId === d.id}
                                    className="text-[11px] px-2.5 py-1 rounded bg-dd-green text-white font-bold disabled:opacity-50">
                                    {savingId === d.id ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                                </button>
                                {hasOverride && (
                                    <button onClick={() => resetOne(d.id)}
                                        disabled={savingId === d.id}
                                        className="text-[11px] px-2.5 py-1 rounded bg-red-50 text-red-700 font-bold disabled:opacity-50">
                                        {tx('Reset to default', 'Restablecer')}
                                    </button>
                                )}
                                {dirty && (
                                    <span className="ml-auto text-[10px] text-amber-600 font-bold">
                                        {tx('Unsaved changes', 'Sin guardar')}
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
