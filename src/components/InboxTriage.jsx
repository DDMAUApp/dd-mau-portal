// InboxTriage — owner-only admin tab for triaging classified inbound
// email. Backed by the /email_intel Firestore collection that the
// pollGmail Cloud Function writes every hour.
//
// Andrew 2026-05-26: "can we add a program to the app or do we write
// a new program that reads through my email and gives me catering
// inquires, customers complaints, vender questions, and bills … so
// thats why i ask if we should write a new program for that since
// it never is for the staff."
//
// In-app admin tab (rather than a separate app) so we reuse the
// existing auth + push + Firestore + deploy pipeline. Page gating
// in App.jsx restricts visibility to admin ids 40/41.
//
// Setup gate: if /system/gmail_sync_state doesn't exist, the OAuth
// hand-off hasn't run yet — show a friendly setup banner with the
// helper script command instead of an empty list.

import { useEffect, useMemo, useState } from 'react';
import { db } from '../firebase';
import {
    collection, doc, onSnapshot, query, orderBy, limit, updateDoc,
    setDoc, addDoc, serverTimestamp,
} from 'firebase/firestore';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

// Default seed list for /config/inbox_categories on first ever load.
// Andrew 2026-05-26: "make the classifications bubbles able to add
// and subtract" — categories are now Firestore-backed. The doc may
// not exist on first run, so we fall back to this list AND seed it
// on first edit. Tone is the color bucket the chip uses (see
// TONE_CLASSES below). `description` is the one-line hint that
// gets injected into the classifier prompt so the model knows what
// the category means — owners can edit it as they refine the AI.
const DEFAULT_CATEGORIES = [
    { id: 'catering',  en: 'Catering',  es: 'Catering',  emoji: '🍱', tone: 'green',  description: 'someone asking about catering, large orders, events, group meals, off-site service. INCLUDES Toast online-order receipts where the order is a catering / large-party / event submission' },
    { id: 'complaint', en: 'Complaints',es: 'Quejas',    emoji: '⚠️', tone: 'red',    description: 'a customer is unhappy: bad food, slow service, rude staff, refund request, sick after eating' },
    { id: 'vendor',    en: 'Vendors',   es: 'Proveedor', emoji: '🚚', tone: 'blue',   description: 'a vendor (Sysco, US Foods, suppliers, distributors) asking a question, sending order confirmations, or making a request' },
    { id: 'bill',      en: 'Bills',     es: 'Facturas',  emoji: '🧾', tone: 'amber',  description: 'an invoice, statement, payment due, utility bill, subscription receipt' },
    { id: 'toast',     en: 'Toast',     es: 'Toast',     emoji: '🍞', tone: 'purple', description: 'automated emails from Toast POS (toasttab.com, toastpos.com, Toast Now, etc.): daily sales summaries, transaction notices, online-order receipts, loyalty reports, payroll-from-Toast. IMPORTANT: if the Toast email is a CATERING order, classify as catering instead.' },
    { id: 'other',     en: 'Other',     es: 'Otros',     emoji: '✉️', tone: 'gray',   description: 'anything else (marketing, spam, personal, employee, banking notices, social media)' },
];

// Tone classes — the visual color buckets a category can choose from.
// Owners pick one when adding a new category. The 'other' fallback
// always uses gray.
const TONE_OPTIONS = [
    { id: 'green',  label: 'Green'  },
    { id: 'red',    label: 'Red'    },
    { id: 'blue',   label: 'Blue'   },
    { id: 'amber',  label: 'Amber'  },
    { id: 'purple', label: 'Purple' },
    { id: 'gray',   label: 'Gray'   },
];

const TONE_CLASSES = {
    green:  { chip: 'bg-dd-green-50 text-dd-green-700 border-dd-green/30', dot: 'bg-dd-green'   },
    red:    { chip: 'bg-red-50      text-red-700      border-red-200',     dot: 'bg-red-500'    },
    blue:   { chip: 'bg-blue-50     text-blue-700     border-blue-200',    dot: 'bg-blue-500'   },
    amber:  { chip: 'bg-amber-50    text-amber-700    border-amber-200',   dot: 'bg-amber-500'  },
    purple: { chip: 'bg-purple-50   text-purple-700   border-purple-200',  dot: 'bg-purple-500' },
    gray:   { chip: 'bg-gray-100    text-gray-700     border-gray-200',    dot: 'bg-gray-400'   },
};

function fmtWhen(item, locale) {
    const ms = item.internalDate || item.receivedAt?.toMillis?.() || 0;
    if (!ms) return '';
    const diffMin = Math.round((Date.now() - ms) / 60000);
    if (diffMin < 1)     return locale === 'es' ? 'ahora' : 'now';
    if (diffMin < 60)    return `${diffMin}m`;
    if (diffMin < 24*60) return `${Math.round(diffMin/60)}h`;
    const days = Math.round(diffMin / (24*60));
    if (days < 7)        return `${days}d`;
    return new Date(ms).toLocaleDateString(locale === 'es' ? 'es-US' : 'en-US',
        { month: 'short', day: 'numeric' });
}

// Default routing-rules shape. Used as the initial value when the
// /config/inbox_routing_rules doc doesn't exist yet. masterEnabled is
// the killswitch — until it's flipped to true, NO routed notifications
// are sent to staff (Andrew 2026-05-26: "for now make sure nothing is
// sent to staff yet"). Per-category enabled flags + recipients are
// independent; both must be on for routing to fire for that category.
const DEFAULT_ROUTING_RULES = {
    masterEnabled: false,
    rules: {
        catering:  { enabled: false, recipients: [] },
        complaint: { enabled: false, recipients: [] },
        vendor:    { enabled: false, recipients: [] },
        bill:      { enabled: false, recipients: [] },
        toast:     { enabled: false, recipients: [] },
        other:     { enabled: false, recipients: [] },
    },
};

export default function InboxTriage({ language = 'en', staffName = '', staffList = [] }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const locale = isEs ? 'es' : 'en-US';

    const [items, setItems] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [syncState, setSyncState] = useState(null); // null until snapshot
    const [filter, setFilter] = useState('all');
    const [showTriaged, setShowTriaged] = useState(false);
    // /config/inbox_routing_rules — owner-only-managed forwarding rules.
    const [routingRules, setRoutingRules] = useState(DEFAULT_ROUTING_RULES);
    // /config/inbox_categories — editable category list. Seeded from
    // DEFAULT_CATEGORIES; owners can add/remove via the UI.
    const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
    // Modal coordination — null = closed, otherwise = the open modal's data.
    const [routingModalCategory, setRoutingModalCategory] = useState(null); // category id
    const [sendModalItem, setSendModalItem] = useState(null);                // email_intel doc
    const [categoryEditor, setCategoryEditor] = useState(null);              // 'new' | <category id> | null
    // Classification queue (low-confidence emails the AI flagged for
    // human review). Auto-pops when items exist and the user hasn't
    // dismissed it for this session.
    const [queueDismissed, setQueueDismissed] = useState(false);

    // Live subscription to /email_intel. Cap at 200 most recent so the
    // tab loads fast even after a year of mail.
    useEffect(() => {
        const q = query(
            collection(db, 'email_intel'),
            orderBy('internalDate', 'desc'),
            limit(200),
        );
        const unsub = onSnapshot(q, (snap) => {
            const next = [];
            snap.forEach(d => next.push({ id: d.id, ...d.data() }));
            setItems(next);
            setLoaded(true);
        }, (err) => {
            console.warn('email_intel subscribe failed:', err);
            setLoaded(true);
        });
        return unsub;
    }, []);

    // Sync state — used to render the "OAuth not set up yet" banner
    // when the collection is empty AND nothing's ever run.
    useEffect(() => {
        const unsub = onSnapshot(doc(db, 'system', 'gmail_sync_state'),
            (snap) => setSyncState(snap.exists() ? snap.data() : null),
            (err) => console.warn('gmail_sync_state subscribe failed:', err),
        );
        return unsub;
    }, []);

    // Routing rules — single doc, shape per DEFAULT_ROUTING_RULES.
    useEffect(() => {
        const unsub = onSnapshot(doc(db, 'config', 'inbox_routing_rules'),
            (snap) => {
                if (!snap.exists()) {
                    setRoutingRules(DEFAULT_ROUTING_RULES);
                    return;
                }
                const data = snap.data() || {};
                setRoutingRules({
                    masterEnabled: !!data.masterEnabled,
                    rules: { ...DEFAULT_ROUTING_RULES.rules, ...(data.rules || {}) },
                });
            },
            (err) => console.warn('inbox_routing_rules subscribe failed:', err),
        );
        return unsub;
    }, []);

    // Categories — editable list. Falls back to DEFAULT_CATEGORIES if
    // the doc doesn't exist yet (first ever load). On first edit the
    // UI persists the list, after which Firestore is the source of
    // truth. Always force-includes 'other' as the last entry — it's
    // the fallback bucket and the UI doesn't allow deleting it.
    useEffect(() => {
        const unsub = onSnapshot(doc(db, 'config', 'inbox_categories'),
            (snap) => {
                if (!snap.exists() || !Array.isArray(snap.data()?.list) || snap.data().list.length === 0) {
                    setCategories(DEFAULT_CATEGORIES);
                    return;
                }
                const list = snap.data().list.filter((c) => c && c.id);
                // Guarantee 'other' is in the list. If somehow deleted,
                // re-add it from defaults.
                if (!list.find((c) => c.id === 'other')) {
                    const otherDefault = DEFAULT_CATEGORIES.find((c) => c.id === 'other');
                    if (otherDefault) list.push(otherDefault);
                }
                setCategories(list);
            },
            (err) => console.warn('inbox_categories subscribe failed:', err),
        );
        return unsub;
    }, []);

    // ── Manual category override (Andrew 2026-05-26) ──────────────
    // Andrew: "i want to option to change anything to a different
    // classification and the classification ai should learn as changes
    // are made." Updates the live email_intel doc AND logs a correction
    // to /email_intel_corrections so pollGmail can include it as a
    // few-shot example on future classifications. Same email being
    // corrected multiple times: each correction is its own row so the
    // history survives (and a later one wins by recency in the few-shot).
    const changeCategory = async (item, newCategory) => {
        if (!newCategory || newCategory === item.category) return;
        try {
            await updateDoc(doc(db, 'email_intel', item.id), {
                category: newCategory,
                manuallyCorrected: true,
                manuallyCorrectedAt: serverTimestamp(),
                manuallyCorrectedBy: staffName || 'admin',
            });
            await addDoc(collection(db, 'email_intel_corrections'), {
                gmailId: item.id,
                fromName: item.fromName || item.from || '',
                from: item.from || '',
                subject: item.subject || '',
                snippet: (item.snippet || '').slice(0, 600),
                oldCategory: item.category || 'other',
                newCategory,
                correctedBy: staffName || 'admin',
                correctedAt: serverTimestamp(),
            });
            toast(tx('Reclassified ✓', 'Reclasificado ✓'), { kind: 'success' });
        } catch (e) {
            console.warn('changeCategory failed:', e);
            toast(tx('Could not save', 'No se pudo guardar'), { kind: 'error' });
        }
    };

    const filtered = useMemo(() => {
        const base = items.filter(it => showTriaged || !it.triaged);
        if (filter === 'all') return base;
        return base.filter(it => (it.category || 'other') === filter);
    }, [items, filter, showTriaged]);

    const counts = useMemo(() => {
        const c = { all: 0 };
        for (const it of items) {
            if (it.triaged && !showTriaged) continue;
            const k = it.category || 'other';
            c.all = (c.all || 0) + 1;
            c[k] = (c[k] || 0) + 1;
        }
        return c;
    }, [items, showTriaged]);

    const markTriaged = async (id) => {
        try {
            await updateDoc(doc(db, 'email_intel', id), {
                triaged: true,
                triagedAt: new Date(),
            });
        } catch (e) { console.warn('markTriaged failed:', e); }
    };
    const unmarkTriaged = async (id) => {
        try {
            await updateDoc(doc(db, 'email_intel', id), {
                triaged: false,
                triagedAt: null,
            });
        } catch (e) { console.warn('unmarkTriaged failed:', e); }
    };

    if (!loaded) {
        return (
            <div className="max-w-3xl mx-auto p-4 text-center text-dd-text-2 text-sm">
                {tx('Loading…', 'Cargando…')}
            </div>
        );
    }

    // Setup gate — visible when no emails have ever been classified.
    // The pollGmail CF writes /system/gmail_sync_state on first run.
    const needsSetup = items.length === 0 && !syncState;

    return (
        <div className="max-w-3xl mx-auto p-3 md:p-5 space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <h1 className="text-lg font-black text-dd-text flex items-center gap-2">
                        📧 {tx('Inbox triage', 'Triaje de bandeja')}
                    </h1>
                    <p className="text-[11.5px] text-dd-text-2">
                        {tx('Owner-only · last 200 emails · classified by Claude every hour',
                            'Solo dueños · últimos 200 emails · clasificados por Claude cada hora')}
                    </p>
                </div>
                <button
                    onClick={() => setShowTriaged(v => !v)}
                    title={tx('Done = "I\'ve handled this — hide it from the default view". Marking an email Done removes it from the list.',
                              'Hecho = "Ya lo manejé — ocúltalo de la vista". Al marcar Hecho desaparece de la lista.')}
                    className={`text-[11px] font-bold px-2 py-1 rounded-full border transition ${showTriaged
                        ? 'bg-dd-green text-white border-dd-green'
                        : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                    {showTriaged
                        ? `✓ ${tx('Showing done', 'Mostrando hechos')}`
                        : tx('Hide done', 'Ocultar hechos')}
                </button>
            </div>

            {/* Routing master killswitch banner. Visible whenever the
                master is OFF — explains why send-to-staff is disabled
                and how to flip it on. Clicking the toggle flips
                /config/inbox_routing_rules.masterEnabled in Firestore. */}
            {!routingRules.masterEnabled && (
                <div className="bg-gray-50 border-2 border-gray-200 rounded-xl p-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                        <div className="text-[12px] font-black text-dd-text">
                            🛑 {tx('Staff routing OFF', 'Reenvío a staff APAGADO')}
                        </div>
                        <p className="text-[11px] text-dd-text-2 leading-snug mt-0.5">
                            {tx(
                                'Nothing is being forwarded to staff. Use the ⚙ on each category to set up rules first, then flip this ON.',
                                'Nada se está reenviando al staff. Usa el ⚙ en cada categoría para configurar las reglas, luego activa esto.',
                            )}
                        </p>
                    </div>
                    <button
                        onClick={async () => {
                            try {
                                await setDoc(doc(db, 'config', 'inbox_routing_rules'),
                                    { masterEnabled: true, updatedAt: serverTimestamp(), updatedBy: staffName || 'admin' },
                                    { merge: true });
                                toast(tx('Routing ON', 'Reenvío ACTIVO'), { kind: 'success' });
                            } catch (e) {
                                toast(tx('Could not enable', 'No se pudo activar'), { kind: 'error' });
                            }
                        }}
                        className="text-[11px] font-bold px-3 py-1.5 rounded-full bg-dd-green text-white hover:bg-dd-green-700 shrink-0">
                        {tx('Turn ON', 'Activar')}
                    </button>
                </div>
            )}
            {routingRules.masterEnabled && (
                <div className="bg-dd-green-50 border border-dd-green/30 rounded-xl p-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0 text-[11px] text-dd-green-700">
                        ✓ {tx('Staff routing is ON. Per-category rules apply.', 'Reenvío a staff ACTIVO. Reglas por categoría aplican.')}
                    </div>
                    <button
                        onClick={async () => {
                            try {
                                await setDoc(doc(db, 'config', 'inbox_routing_rules'),
                                    { masterEnabled: false, updatedAt: serverTimestamp(), updatedBy: staffName || 'admin' },
                                    { merge: true });
                                toast(tx('Routing OFF', 'Reenvío APAGADO'), { kind: 'success' });
                            } catch (e) {
                                toast(tx('Could not disable', 'No se pudo apagar'), { kind: 'error' });
                            }
                        }}
                        className="text-[10px] font-bold px-2 py-1 rounded-full bg-white text-dd-text-2 border border-dd-line hover:bg-dd-bg shrink-0">
                        {tx('Turn OFF', 'Apagar')}
                    </button>
                </div>
            )}

            {/* Setup banner — only shown until the CF runs at least once. */}
            {needsSetup && (
                <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4 space-y-2">
                    <div className="text-sm font-black text-amber-800">
                        {tx('Gmail not connected yet', 'Gmail no conectado')}
                    </div>
                    <p className="text-xs text-amber-700 leading-relaxed">
                        {tx(
                            'pollGmail hasn\'t run yet. Follow scripts/gmail-oauth-setup.mjs to grant inbox read access, then set the three GMAIL_OAUTH_* secrets and redeploy functions. New emails will start appearing here every hour after that.',
                            'pollGmail aún no se ha ejecutado. Sigue scripts/gmail-oauth-setup.mjs para autorizar la lectura del buzón, luego configura los tres secretos GMAIL_OAUTH_* y vuelve a desplegar las funciones. Los nuevos emails aparecerán aquí cada hora.',
                        )}
                    </p>
                </div>
            )}

            {/* Category filter chips */}
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
                <button
                    onClick={() => setFilter('all')}
                    className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border transition ${filter === 'all'
                        ? 'bg-dd-text text-white border-dd-text'
                        : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'}`}>
                    {tx('All', 'Todos')} <span className="opacity-70">({counts.all || 0})</span>
                </button>
                {categories.map(c => {
                    const sel = filter === c.id;
                    const tone = TONE_CLASSES[c.tone] || TONE_CLASSES.gray;
                    const rule = routingRules.rules?.[c.id] || { enabled: false, recipients: [] };
                    const routingOn = routingRules.masterEnabled && rule.enabled && rule.recipients.length > 0;
                    return (
                        <span key={c.id} className="shrink-0 inline-flex items-center gap-0.5">
                            <button
                                onClick={() => setFilter(sel ? 'all' : c.id)}
                                className={`px-2.5 py-1 rounded-l-full text-xs font-bold border transition ${sel
                                    ? tone.chip + ' ring-2 ring-offset-1 ring-dd-text/30'
                                    : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'}`}>
                                {c.emoji} {isEs ? c.es : c.en} <span className="opacity-70">({counts[c.id] || 0})</span>
                            </button>
                            {/* Gear → opens this category's routing rules.
                                Green dot indicates the category is actively
                                auto-forwarding to staff (master + rule both on). */}
                            <button
                                onClick={() => setRoutingModalCategory(c.id)}
                                title={tx(`Routing rules for ${isEs ? c.es : c.en}`, `Reglas de reenvío para ${isEs ? c.es : c.en}`)}
                                className={`px-1.5 py-1 rounded-r-full text-xs font-bold border border-l-0 transition ${sel
                                    ? tone.chip
                                    : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                                ⚙
                                {routingOn && (
                                    <span className="ml-0.5 w-1.5 h-1.5 inline-block rounded-full bg-dd-green align-middle"></span>
                                )}
                            </button>
                        </span>
                    );
                })}
                {/* Add new category — opens an editor modal. */}
                <button
                    onClick={() => setCategoryEditor('new')}
                    title={tx('Add a new category', 'Añadir nueva categoría')}
                    className="shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border border-dashed border-dd-line text-dd-text-2 hover:bg-dd-bg hover:text-dd-text">
                    ➕ {tx('Add category', 'Añadir categoría')}
                </button>
            </div>

            {/* Email rows */}
            <div className="bg-white rounded-xl border border-dd-line divide-y divide-dd-line/60">
                {filtered.length === 0 ? (
                    <div className="p-10 text-center text-sm text-dd-text-2">
                        {needsSetup
                            ? tx('Waiting for the first poll…', 'Esperando el primer poll…')
                            : tx('Nothing here. Inbox zero for this filter.',
                                  'Nada aquí. Buzón cero en este filtro.')}
                    </div>
                ) : (
                    filtered.map(item => {
                        // Fallback to 'other' when the LLM returns a
                        // category we don't recognize (or a now-deleted one).
                        const cat = categories.find(c => c.id === item.category)
                            || categories.find(c => c.id === 'other')
                            || DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1];
                        const tone = TONE_CLASSES[cat.tone] || TONE_CLASSES.gray;
                        return (
                            <div key={item.id} className={`p-3 ${item.triaged ? 'bg-dd-bg/50' : 'bg-white'}`}>
                                <div className="flex items-start gap-2.5">
                                    {/* Category dot + chip */}
                                    <div className="shrink-0 pt-1">
                                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${tone.dot}`} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2 flex-wrap">
                                            {/* Category chip + manual-override picker. Native
                                                <select> overlay so the click target is the chip
                                                itself — quick reclassify without an extra modal. */}
                                            <span className={`relative inline-flex items-center text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone.chip}`}>
                                                {cat.emoji} {isEs ? cat.es : cat.en}
                                                <span className="ml-1 opacity-60">▾</span>
                                                <select
                                                    value={item.category || 'other'}
                                                    onChange={(e) => changeCategory(item, e.target.value)}
                                                    aria-label={tx('Change category', 'Cambiar categoría')}
                                                    title={tx('Change category — AI will learn', 'Cambiar categoría — la IA aprende')}
                                                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer">
                                                    {categories.map(c => (
                                                        <option key={c.id} value={c.id}>{isEs ? c.es : c.en}</option>
                                                    ))}
                                                </select>
                                            </span>
                                            <span className="text-[10px] font-bold text-dd-text-2 whitespace-nowrap">
                                                {item.manuallyCorrected && (
                                                    <span className="mr-1.5 text-purple-700" title={tx('Manually reclassified', 'Reclasificado a mano')}>✏️</span>
                                                )}
                                                {fmtWhen(item, locale)}
                                                {item.smsSent && <span className="ml-1.5 text-dd-green-700" title={tx('SMS sent', 'SMS enviado')}>📲</span>}
                                                {item.forwardedToStaff?.length > 0 && (
                                                    <span className="ml-1.5 text-blue-700" title={`${tx('Forwarded to', 'Reenviado a')}: ${item.forwardedToStaff.join(', ')}`}>📤</span>
                                                )}
                                            </span>
                                        </div>
                                        <div className="text-sm font-bold text-dd-text mt-1 truncate">
                                            {item.subject || '(no subject)'}
                                        </div>
                                        <div className="text-[11.5px] text-dd-text-2 truncate mt-0.5">
                                            {tx('From', 'De')}: {item.fromName || item.from}
                                        </div>
                                        {item.snippet && (
                                            <div className="text-[12px] text-dd-text-2 mt-1 line-clamp-2">
                                                {item.snippet}
                                            </div>
                                        )}
                                        {item.reasoning && (
                                            <div className="text-[10px] italic text-dd-text-2/80 mt-1">
                                                🧠 {item.reasoning}
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                                            <a
                                                href={item.gmailUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-dd-green text-white hover:bg-dd-green-700">
                                                {tx('Open in Gmail →', 'Abrir en Gmail →')}
                                            </a>
                                            {/* Send to staff — Andrew 2026-05-26: "when i see a
                                                new catering i can say send to staff and the email
                                                is sent to a staff member of my choosing."
                                                Disabled while the master killswitch is OFF so
                                                nothing leaks to staff during dialing-in. */}
                                            {routingRules.masterEnabled ? (
                                                <button
                                                    onClick={() => setSendModalItem(item)}
                                                    className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100">
                                                    📤 {tx('Send to staff', 'Enviar a staff')}
                                                </button>
                                            ) : (
                                                <button
                                                    type="button"
                                                    disabled
                                                    title={tx('Email routing is OFF — turn it on in Routing settings to enable.', 'El reenvío está APAGADO — actívalo en Reglas de reenvío para habilitar.')}
                                                    className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed">
                                                    📤 {tx('Send to staff', 'Enviar a staff')}
                                                </button>
                                            )}
                                            {item.triaged ? (
                                                <button
                                                    onClick={() => unmarkTriaged(item.id)}
                                                    title={tx('Restore to the list', 'Volver a la lista')}
                                                    className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg">
                                                    {tx('Undone', 'Deshacer')}
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => markTriaged(item.id)}
                                                    title={tx('Mark as handled — hides it from the list', 'Marcar como hecho — lo oculta de la lista')}
                                                    className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg">
                                                    ✓ {tx('Done', 'Hecho')}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            <div className="text-[10px] text-dd-text-2/70 text-center pt-1 pb-3">
                {tx(
                    'Classification uses Claude Haiku 4.5 — and learns from every manual reclassification.',
                    'Clasificación con Claude Haiku 4.5 — aprende de cada reclasificación manual.',
                )}
            </div>

            {/* Modals */}
            {routingModalCategory && (
                <RoutingRulesModal
                    categoryId={routingModalCategory}
                    routingRules={routingRules}
                    categories={categories}
                    staffList={staffList}
                    actorName={staffName}
                    language={language}
                    onClose={() => setRoutingModalCategory(null)}
                    onDeleteCategory={() => {
                        setRoutingModalCategory(null);
                        setCategoryEditor(routingModalCategory);
                    }}
                />
            )}
            {sendModalItem && (
                <SendToStaffModal
                    item={sendModalItem}
                    categories={categories}
                    staffList={staffList}
                    actorName={staffName}
                    language={language}
                    onClose={() => setSendModalItem(null)}
                />
            )}
            {categoryEditor && (
                <CategoryEditorModal
                    mode={categoryEditor === 'new' ? 'new' : 'edit'}
                    categoryId={categoryEditor === 'new' ? null : categoryEditor}
                    categories={categories}
                    actorName={staffName}
                    language={language}
                    onClose={() => setCategoryEditor(null)}
                />
            )}
            {/* Classification queue — pops when the AI flagged any
                emails as low-confidence and the user hasn't dismissed
                it for this session. */}
            {!queueDismissed && items.some(it => it.needsClassification) && (
                <ClassifyQueueModal
                    items={items.filter(it => it.needsClassification)}
                    categories={categories}
                    actorName={staffName}
                    language={language}
                    onClose={() => setQueueDismissed(true)}
                />
            )}
        </div>
    );
}

// ── RoutingRulesModal — per-category auto-forward configuration ──────
// Andrew 2026-05-26: "each classification bubble opens and have rules
// that i can change anytime once i feel the ai hasnt make any
// classification mistakes."
//
// One modal per category. Toggle enable + pick recipient staff. The
// master killswitch is shown at the top of the InboxTriage page (not
// here) — this modal only writes the per-category half of the rules.
function RoutingRulesModal({ categoryId, routingRules, categories, staffList, actorName, language, onClose, onDeleteCategory }) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const cat = (categories || []).find(c => c.id === categoryId);
    // 'other' is the fallback bucket — keep it un-deletable so the
    // chip-rendering code always has something to fall through to.
    const canDelete = categoryId && categoryId !== 'other';
    const initial = routingRules.rules?.[categoryId] || { enabled: false, recipients: [] };
    const [enabled, setEnabled] = useState(!!initial.enabled);
    const [recipients, setRecipients] = useState(new Set(initial.recipients || []));
    const [saving, setSaving] = useState(false);

    const activeStaff = useMemo(() => {
        return (staffList || [])
            .filter(s => s && s.name && s.active !== false)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList]);

    const toggleStaff = (name) => {
        setRecipients(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        try {
            const next = { ...(routingRules.rules || {}) };
            next[categoryId] = { enabled, recipients: Array.from(recipients) };
            await setDoc(doc(db, 'config', 'inbox_routing_rules'),
                { rules: next, updatedAt: serverTimestamp(), updatedBy: actorName || 'admin' },
                { merge: true });
            toast(tx('Saved', 'Guardado'), { kind: 'success' });
            onClose?.();
        } catch (e) {
            console.warn('RoutingRulesModal save failed:', e);
            toast(tx('Could not save', 'No se pudo guardar'), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    if (!cat) return null;
    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center"
            onClick={onClose}>
            <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl flex flex-col max-h-[90vh]"
                onClick={(e) => e.stopPropagation()}>
                <div className="px-4 pt-4 pb-2 border-b border-dd-line">
                    <h2 className="text-base font-black text-dd-text">
                        {cat.emoji} {tx(`${cat.en} routing`, `Reenvío de ${cat.es}`)}
                    </h2>
                    <p className="text-[11px] text-dd-text-2 mt-0.5">
                        {tx(
                            'When a new email is classified as this category, auto-send a notification to the picked staff.',
                            'Cuando llegue un email de esta categoría, envía notificación al staff elegido.',
                        )}
                    </p>
                    {!routingRules.masterEnabled && (
                        <div className="mt-2 text-[10px] bg-amber-50 text-amber-800 border border-amber-200 rounded px-2 py-1">
                            ⚠ {tx('Master routing is OFF. Save these rules anyway; they activate when master is turned on.',
                                  'Reenvío maestro APAGADO. Guarda las reglas igualmente; se activan al encender el maestro.')}
                        </div>
                    )}
                </div>

                {/* Enable toggle */}
                <div className="px-4 py-3 border-b border-dd-line/60 flex items-center gap-3">
                    <div className="flex-1">
                        <div className="text-sm font-bold text-dd-text">
                            {tx('Auto-forward', 'Reenvío automático')}
                        </div>
                        <div className="text-[11px] text-dd-text-2">
                            {tx('When a new email lands in this bucket', 'Cuando un email cae en esta categoría')}
                        </div>
                    </div>
                    <button
                        onClick={() => setEnabled(v => !v)}
                        className={`w-12 h-7 rounded-full transition relative ${enabled ? 'bg-dd-green' : 'bg-gray-300'}`}>
                        <span className={`absolute top-0.5 w-6 h-6 bg-white rounded-full shadow transition ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                </div>

                {/* Recipient list */}
                <div className="px-4 py-2 border-b border-dd-line/60">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                        {tx('Recipients', 'Destinatarios')} · {recipients.size}
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto divide-y divide-dd-line/40">
                    {activeStaff.length === 0 ? (
                        <div className="p-6 text-center text-sm text-dd-text-2">
                            {tx('No active staff.', 'Sin staff activo.')}
                        </div>
                    ) : (
                        activeStaff.map(s => {
                            const on = recipients.has(s.name);
                            return (
                                <label key={s.id ?? s.name} className="flex items-center gap-3 px-4 py-2.5 hover:bg-dd-bg/50 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={() => toggleStaff(s.name)}
                                        className="w-5 h-5 accent-dd-green shrink-0"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-dd-text truncate">{s.name}</div>
                                        {s.role && (
                                            <div className="text-[10px] uppercase tracking-wider text-dd-text-2">{s.role}</div>
                                        )}
                                    </div>
                                </label>
                            );
                        })
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-dd-line flex flex-col gap-2 bg-white">
                    <div className="flex gap-2">
                        <button onClick={onClose} disabled={saving}
                            className="flex-1 py-2 rounded-lg border border-dd-line text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button onClick={handleSave} disabled={saving}
                            className="flex-1 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 disabled:opacity-60">
                            {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                        </button>
                    </div>
                    {canDelete && (
                        <button onClick={onDeleteCategory}
                            className="text-[11px] font-bold text-red-600 hover:text-red-700 hover:underline mt-1 self-center">
                            🗑 {tx('Delete this category', 'Borrar esta categoría')}
                        </button>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── SendToStaffModal — one-off per-email forward ─────────────────────
// Writes a single notification doc per picked staff with the email's
// subject + sender + 200-char snippet. Type: email_forwarded. The
// staff sees an in-app notification + push, but cannot open the
// InboxTriage tab (it's gated to ids 40/41).
function SendToStaffModal({ item, categories, staffList, actorName, language, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const [recipients, setRecipients] = useState(new Set());
    const [note, setNote] = useState('');
    const [sending, setSending] = useState(false);

    const activeStaff = useMemo(() => {
        return (staffList || [])
            .filter(s => s && s.name && s.active !== false)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList]);

    const toggleStaff = (name) => {
        setRecipients(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    const handleSend = async () => {
        if (sending || recipients.size === 0) return;
        setSending(true);
        const names = Array.from(recipients);
        const subject = item.subject || '(no subject)';
        const fromName = item.fromName || item.from || '';
        const snippet = (item.snippet || '').slice(0, 200);
        const cat = (categories || []).find(c => c.id === item.category)
            || (categories || []).find(c => c.id === 'other')
            || { emoji: '✉️', en: 'Other', es: 'Otros' };
        try {
            await Promise.all(names.map(name =>
                addDoc(collection(db, 'notifications'), {
                    forStaff: name,
                    type: 'email_forwarded',
                    title: `${cat.emoji} ${tx('Forwarded:', 'Reenviado:')} ${subject}`.slice(0, 120),
                    body: `${fromName ? tx('From ', 'De ') + fromName + ' · ' : ''}${snippet}${note ? `\n\n${tx('Note', 'Nota')}: ${note}` : ''}`.slice(0, 600),
                    deepLink: '/',
                    tag: `email_forwarded:${item.id}:${name}`,
                    priority: 'high',
                    forceDeliver: true,
                    createdAt: serverTimestamp(),
                    read: false,
                    createdBy: actorName || 'admin',
                    sourceGmailId: item.id,
                })
            ));
            // Stamp the email_intel doc so the row shows a 📤 chip
            await updateDoc(doc(db, 'email_intel', item.id), {
                forwardedToStaff: [...(item.forwardedToStaff || []), ...names],
                lastForwardedAt: serverTimestamp(),
                lastForwardedBy: actorName || 'admin',
            });
            toast(tx(`Sent to ${names.length} ${names.length === 1 ? 'person' : 'people'} ✓`,
                     `Enviado a ${names.length} ${names.length === 1 ? 'persona' : 'personas'} ✓`),
                  { kind: 'success' });
            onClose?.();
        } catch (e) {
            console.warn('SendToStaffModal failed:', e);
            toast(tx('Could not send', 'No se pudo enviar'), { kind: 'error' });
        } finally {
            setSending(false);
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center"
            onClick={onClose}>
            <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl flex flex-col max-h-[90vh]"
                onClick={(e) => e.stopPropagation()}>
                <div className="px-4 pt-4 pb-2 border-b border-dd-line">
                    <h2 className="text-base font-black text-dd-text">
                        📤 {tx('Send to staff', 'Enviar a staff')}
                    </h2>
                    <p className="text-[11px] text-dd-text-2 mt-0.5 truncate">
                        {item.subject || '(no subject)'}
                    </p>
                    <p className="text-[10px] text-dd-text-2/80 truncate">
                        {tx('From', 'De')}: {item.fromName || item.from}
                    </p>
                </div>

                {/* Optional note */}
                <div className="px-4 py-2 border-b border-dd-line/60">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                        {tx('Note (optional)', 'Nota (opcional)')}
                    </label>
                    <input
                        type="text"
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        maxLength={200}
                        placeholder={tx('e.g. "please reply by EOD"', 'ej. "responde antes de fin del día"')}
                        className="w-full mt-1 px-2 py-1.5 rounded-lg border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
                    />
                </div>

                {/* Recipients */}
                <div className="px-4 py-2 border-b border-dd-line/60">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                        {tx('Send to', 'Enviar a')} · {recipients.size}
                    </div>
                </div>
                <div className="flex-1 overflow-y-auto divide-y divide-dd-line/40">
                    {activeStaff.length === 0 ? (
                        <div className="p-6 text-center text-sm text-dd-text-2">
                            {tx('No active staff.', 'Sin staff activo.')}
                        </div>
                    ) : (
                        activeStaff.map(s => {
                            const on = recipients.has(s.name);
                            return (
                                <label key={s.id ?? s.name} className="flex items-center gap-3 px-4 py-2.5 hover:bg-dd-bg/50 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={on}
                                        onChange={() => toggleStaff(s.name)}
                                        className="w-5 h-5 accent-dd-green shrink-0"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-dd-text truncate">{s.name}</div>
                                        {s.role && (
                                            <div className="text-[10px] uppercase tracking-wider text-dd-text-2">{s.role}</div>
                                        )}
                                    </div>
                                </label>
                            );
                        })
                    )}
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex gap-2 bg-white">
                    <button onClick={onClose} disabled={sending}
                        className="flex-1 py-2 rounded-lg border border-dd-line text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={handleSend} disabled={sending || recipients.size === 0}
                        className="flex-1 py-2 rounded-lg bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50">
                        {sending ? tx('Sending…', 'Enviando…') : tx('Send', 'Enviar')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── CategoryEditorModal — add / edit / delete a category ─────────────
// Andrew 2026-05-26: "make the classifications bubbles able to add and
// subtract". Owners pick emoji + label + color tone + a short
// description (the description gets fed into the classifier prompt so
// the AI knows what each category means).
function CategoryEditorModal({ mode, categoryId, categories, actorName, language, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    const existing = mode === 'edit' ? (categories || []).find(c => c.id === categoryId) : null;
    const [emoji, setEmoji] = useState(existing?.emoji || '📨');
    const [labelEn, setLabelEn] = useState(existing?.en || '');
    const [labelEs, setLabelEs] = useState(existing?.es || '');
    const [tone, setTone] = useState(existing?.tone || 'blue');
    const [description, setDescription] = useState(existing?.description || '');
    const [saving, setSaving] = useState(false);

    const slugify = (s) => (s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 30);

    const save = async () => {
        if (saving) return;
        const en = (labelEn || '').trim();
        if (!en) {
            toast(tx('Name is required', 'El nombre es obligatorio'), { kind: 'error' });
            return;
        }
        const id = existing?.id || slugify(en);
        if (!id) {
            toast(tx('Could not derive an id', 'No se pudo derivar id'), { kind: 'error' });
            return;
        }
        if (!existing && (categories || []).find(c => c.id === id)) {
            toast(tx('A category with that id already exists.', 'Ya existe una categoría con ese id.'), { kind: 'error' });
            return;
        }
        const newCat = {
            id,
            en,
            es: (labelEs || en).trim(),
            emoji: emoji || '📨',
            tone,
            description: (description || '').trim().slice(0, 400),
        };
        const next = [...(categories || [])];
        const idx = next.findIndex(c => c.id === id);
        if (idx >= 0) next[idx] = newCat;
        else {
            // Insert before 'other' so 'other' stays last.
            const otherIdx = next.findIndex(c => c.id === 'other');
            if (otherIdx >= 0) next.splice(otherIdx, 0, newCat);
            else next.push(newCat);
        }
        setSaving(true);
        try {
            await setDoc(doc(db, 'config', 'inbox_categories'),
                { list: next, updatedAt: serverTimestamp(), updatedBy: actorName || 'admin' },
                { merge: true });
            toast(tx('Saved', 'Guardado'), { kind: 'success' });
            onClose?.();
        } catch (e) {
            console.warn('CategoryEditorModal save failed:', e);
            toast(tx('Could not save', 'No se pudo guardar'), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!existing || existing.id === 'other') return;
        if (!window.confirm(tx(
            `Delete "${existing.en}"? Existing emails in this category will fall back to Other. The AI will stop using it on new mail.`,
            `¿Borrar "${existing.es || existing.en}"? Los emails actuales caerán en Otros. La IA dejará de usarla en mail nuevo.`,
        ))) return;
        setSaving(true);
        try {
            const next = (categories || []).filter(c => c.id !== existing.id);
            await setDoc(doc(db, 'config', 'inbox_categories'),
                { list: next, updatedAt: serverTimestamp(), updatedBy: actorName || 'admin' },
                { merge: true });
            toast(tx('Deleted', 'Borrado'), { kind: 'success' });
            onClose?.();
        } catch (e) {
            console.warn('CategoryEditorModal delete failed:', e);
            toast(tx('Could not delete', 'No se pudo borrar'), { kind: 'error' });
            setSaving(false);
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center"
            onClick={onClose}>
            <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl flex flex-col max-h-[90vh]"
                onClick={(e) => e.stopPropagation()}>
                <div className="px-4 pt-4 pb-3 border-b border-dd-line">
                    <h2 className="text-base font-black text-dd-text">
                        {mode === 'edit'
                            ? tx(`Edit "${existing?.en || ''}"`, `Editar "${existing?.es || existing?.en || ''}"`)
                            : tx('New category', 'Nueva categoría')}
                    </h2>
                    <p className="text-[11px] text-dd-text-2 mt-0.5">
                        {tx(
                            'Description is fed to the AI so it knows what mail belongs here.',
                            'La descripción se le da a la IA para que sepa qué emails encajan.',
                        )}
                    </p>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase text-dd-text-2 mb-0.5">{tx('Emoji', 'Emoji')}</span>
                            <input value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 4))} maxLength={4}
                                className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-2xl text-center" />
                        </label>
                        <label className="block">
                            <span className="block text-[10px] font-bold uppercase text-dd-text-2 mb-0.5">{tx('Color', 'Color')}</span>
                            <select value={tone} onChange={(e) => setTone(e.target.value)}
                                className="w-full px-2 py-2 rounded-lg border border-dd-line text-sm bg-white">
                                {TONE_OPTIONS.map(t => (
                                    <option key={t.id} value={t.id}>{t.label}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <label className="block">
                        <span className="block text-[10px] font-bold uppercase text-dd-text-2 mb-0.5">{tx('Name (English)', 'Nombre (inglés)')}</span>
                        <input value={labelEn} onChange={(e) => setLabelEn(e.target.value)} maxLength={30}
                            placeholder={tx('e.g. Reservations', 'ej. Reservas')}
                            className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
                    </label>
                    <label className="block">
                        <span className="block text-[10px] font-bold uppercase text-dd-text-2 mb-0.5">{tx('Name (Spanish, optional)', 'Nombre (español, opcional)')}</span>
                        <input value={labelEs} onChange={(e) => setLabelEs(e.target.value)} maxLength={30}
                            placeholder={tx('Defaults to the English name', 'Por defecto, el nombre en inglés')}
                            className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
                    </label>
                    <label className="block">
                        <span className="block text-[10px] font-bold uppercase text-dd-text-2 mb-0.5">{tx('Description (AI prompt)', 'Descripción (prompt IA)')}</span>
                        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={400} rows={3}
                            placeholder={tx('e.g. "guests asking to book a table, OpenTable confirmations, large-party requests"',
                                            'ej. "clientes pidiendo reservar mesa, confirmaciones de OpenTable, grupos grandes"')}
                            className="w-full px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
                        <div className="text-[10px] text-dd-text-2 mt-0.5">
                            {tx('The clearer this is, the better the AI categorizes.',
                                'Cuanto más claro, mejor clasifica la IA.')}
                        </div>
                    </label>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex flex-col gap-2 bg-white">
                    <div className="flex gap-2">
                        <button onClick={onClose} disabled={saving}
                            className="flex-1 py-2 rounded-lg border border-dd-line text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                            {tx('Cancel', 'Cancelar')}
                        </button>
                        <button onClick={save} disabled={saving}
                            className="flex-1 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 disabled:opacity-60">
                            {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                        </button>
                    </div>
                    {existing && existing.id !== 'other' && (
                        <button onClick={remove} disabled={saving}
                            className="text-[11px] font-bold text-red-600 hover:text-red-700 hover:underline mt-1 self-center">
                            🗑 {tx('Delete category', 'Borrar categoría')}
                        </button>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── ClassifyQueueModal — walks owners through low-confidence emails ──
// Andrew 2026-05-26: "if unsure make a email classification question
// that sends to only julie and andrew in the notifications to check
// inbox when i or julie enters inbox it pops up a classification
// window."
//
// Auto-shows when the email_intel snapshot has any items with
// needsClassification === true. The user clicks a category bubble for
// each one; that:
//   1. Sets the category on the doc.
//   2. Clears needsClassification (= one less queued item).
//   3. Appends a correction row to /email_intel_corrections so the AI
//      learns this owner's preference for next time.
function ClassifyQueueModal({ items: itemsLive, categories, actorName, language, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;
    // Freeze the queue at modal-open. The parent passes a LIVE filtered
    // list `items.filter(needsClassification)`, but picking an item
    // clears its needsClassification flag — Firestore's local snapshot
    // listener fires synchronously on that write, so the parent re-
    // renders with a SHORTER items array before pick() even calls
    // advance(). Without freezing, idx then points one item past the
    // picked one in the now-shortened array → every other queued item
    // is silently skipped. Snapshotting at mount keeps idx in sync.
    const [items] = useState(() => Array.isArray(itemsLive) ? itemsLive.slice() : []);
    const [idx, setIdx] = useState(0);
    const [busy, setBusy] = useState(false);
    const total = items.length;
    const item = items[idx];

    if (!item) return null;

    const advance = () => {
        if (idx + 1 >= items.length) onClose?.();
        else setIdx(idx + 1);
    };

    const pick = async (newCategory) => {
        if (busy) return;
        setBusy(true);
        try {
            await updateDoc(doc(db, 'email_intel', item.id), {
                category: newCategory,
                needsClassification: false,
                manuallyCorrected: true,
                manuallyCorrectedAt: serverTimestamp(),
                manuallyCorrectedBy: actorName || 'admin',
            });
            await addDoc(collection(db, 'email_intel_corrections'), {
                gmailId: item.id,
                fromName: item.fromName || item.from || '',
                from: item.from || '',
                subject: item.subject || '',
                snippet: (item.snippet || '').slice(0, 600),
                oldCategory: item.category || 'other',
                newCategory,
                correctedBy: actorName || 'admin',
                correctedAt: serverTimestamp(),
                source: 'queue',
            });
            advance();
        } catch (e) {
            console.warn('ClassifyQueueModal pick failed:', e);
            toast(tx('Could not save', 'No se pudo guardar'), { kind: 'error' });
        } finally {
            setBusy(false);
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-2"
            onClick={onClose}>
            <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl flex flex-col max-h-[92vh]"
                onClick={(e) => e.stopPropagation()}>
                <div className="px-4 pt-4 pb-3 border-b border-dd-line">
                    <div className="flex items-center justify-between">
                        <h2 className="text-base font-black text-dd-text">
                            🤔 {tx('Help classify', 'Ayuda a clasificar')}
                        </h2>
                        <span className="text-[11px] font-bold text-dd-text-2 whitespace-nowrap">
                            {idx + 1} / {total}
                        </span>
                    </div>
                    <p className="text-[11px] text-dd-text-2 mt-0.5">
                        {tx(
                            "The AI wasn't sure about this email. Pick a category — it learns from your choice.",
                            'La IA no estaba segura. Elige una categoría — aprende de tu elección.',
                        )}
                    </p>
                </div>

                {/* Email preview */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                        {tx('From', 'De')}
                    </div>
                    <div className="text-sm text-dd-text">
                        {item.fromName || item.from || '(unknown)'}
                    </div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 pt-2">
                        {tx('Subject', 'Asunto')}
                    </div>
                    <div className="text-sm font-bold text-dd-text">
                        {item.subject || '(no subject)'}
                    </div>
                    {item.snippet && (
                        <>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 pt-2">
                                {tx('Snippet', 'Fragmento')}
                            </div>
                            <div className="text-[12px] text-dd-text-2 bg-dd-bg/60 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
                                {item.snippet}
                            </div>
                        </>
                    )}
                    {item.reasoning && (
                        <div className="text-[10px] italic text-dd-text-2 mt-1">
                            🧠 {tx('AI guess', 'IA dijo')}: {item.category || 'other'} — "{item.reasoning}"
                        </div>
                    )}
                </div>

                {/* Category bubbles */}
                <div className="p-3 border-t border-dd-line/60 bg-dd-bg/40">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                        {tx('Tap the right category', 'Toca la categoría correcta')}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {(categories || []).map(c => {
                            const tone = TONE_CLASSES[c.tone] || TONE_CLASSES.gray;
                            return (
                                <button
                                    key={c.id}
                                    disabled={busy}
                                    onClick={() => pick(c.id)}
                                    className={`px-3 py-2 rounded-full text-sm font-bold border transition disabled:opacity-50 ${tone.chip} hover:ring-2 hover:ring-offset-1 hover:ring-dd-text/20`}>
                                    {c.emoji} {isEs ? c.es : c.en}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex gap-2 bg-white">
                    <button onClick={advance} disabled={busy}
                        className="flex-1 py-2 rounded-lg border border-dd-line text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Skip', 'Saltar')}
                    </button>
                    <button onClick={onClose} disabled={busy}
                        className="flex-1 py-2 rounded-lg border border-dd-line text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Close', 'Cerrar')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
