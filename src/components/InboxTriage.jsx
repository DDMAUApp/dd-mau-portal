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
} from 'firebase/firestore';

// Display config for each category. Color tones picked so a glance at
// the chip row tells the manager what kind of attention each email needs
// — red for complaint, green for catering (revenue), neutral for the
// less time-sensitive buckets.
const CATEGORIES = [
    { id: 'catering',  en: 'Catering',  es: 'Catering',  emoji: '🍱', tone: 'green'  },
    { id: 'complaint', en: 'Complaints',es: 'Quejas',    emoji: '⚠️', tone: 'red'    },
    { id: 'vendor',    en: 'Vendors',   es: 'Proveedor', emoji: '🚚', tone: 'blue'   },
    { id: 'bill',      en: 'Bills',     es: 'Facturas',  emoji: '🧾', tone: 'amber'  },
    { id: 'other',     en: 'Other',     es: 'Otros',     emoji: '✉️', tone: 'gray'   },
];

const TONE_CLASSES = {
    green: { chip: 'bg-dd-green-50 text-dd-green-700 border-dd-green/30', dot: 'bg-dd-green' },
    red:   { chip: 'bg-red-50      text-red-700      border-red-200',     dot: 'bg-red-500'  },
    blue:  { chip: 'bg-blue-50     text-blue-700     border-blue-200',    dot: 'bg-blue-500' },
    amber: { chip: 'bg-amber-50    text-amber-700    border-amber-200',   dot: 'bg-amber-500'},
    gray:  { chip: 'bg-gray-100    text-gray-700     border-gray-200',    dot: 'bg-gray-400' },
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

export default function InboxTriage({ language = 'en' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const locale = isEs ? 'es' : 'en-US';

    const [items, setItems] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [syncState, setSyncState] = useState(null); // null until snapshot
    const [filter, setFilter] = useState('all');
    const [showTriaged, setShowTriaged] = useState(false);

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
                    className={`text-[11px] font-bold px-2 py-1 rounded-full border transition ${showTriaged
                        ? 'bg-dd-green text-white border-dd-green'
                        : 'bg-white text-dd-text-2 border-dd-line hover:bg-dd-bg'}`}>
                    {showTriaged
                        ? `✓ ${tx('Showing triaged', 'Triados visibles')}`
                        : tx('Hide triaged', 'Ocultar triados')}
                </button>
            </div>

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
                {CATEGORIES.map(c => {
                    const sel = filter === c.id;
                    const tone = TONE_CLASSES[c.tone];
                    return (
                        <button
                            key={c.id}
                            onClick={() => setFilter(sel ? 'all' : c.id)}
                            className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border transition ${sel
                                ? tone.chip + ' ring-2 ring-offset-1 ring-dd-text/30'
                                : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'}`}>
                            {c.emoji} {isEs ? c.es : c.en} <span className="opacity-70">({counts[c.id] || 0})</span>
                        </button>
                    );
                })}
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
                        const cat = CATEGORIES.find(c => c.id === item.category) || CATEGORIES[4];
                        const tone = TONE_CLASSES[cat.tone];
                        return (
                            <div key={item.id} className={`p-3 ${item.triaged ? 'bg-dd-bg/50' : 'bg-white'}`}>
                                <div className="flex items-start gap-2.5">
                                    {/* Category dot + chip */}
                                    <div className="shrink-0 pt-1">
                                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${tone.dot}`} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2 flex-wrap">
                                            <span className={`text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded border ${tone.chip}`}>
                                                {cat.emoji} {isEs ? cat.es : cat.en}
                                            </span>
                                            <span className="text-[10px] font-bold text-dd-text-2 whitespace-nowrap">
                                                {fmtWhen(item, locale)}
                                                {item.smsSent && <span className="ml-1.5 text-dd-green-700" title={tx('SMS sent', 'SMS enviado')}>📲</span>}
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
                                        <div className="flex items-center gap-2 mt-2">
                                            <a
                                                href={item.gmailUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-dd-green text-white hover:bg-dd-green-700">
                                                {tx('Open in Gmail →', 'Abrir en Gmail →')}
                                            </a>
                                            {item.triaged ? (
                                                <button
                                                    onClick={() => unmarkTriaged(item.id)}
                                                    className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg">
                                                    {tx('Unmark', 'Desmarcar')}
                                                </button>
                                            ) : (
                                                <button
                                                    onClick={() => markTriaged(item.id)}
                                                    className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg">
                                                    ✓ {tx('Triaged', 'Triado')}
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
                    'Classification uses Claude Haiku 4.5. If something\'s mis-categorized, mark it triaged and we\'ll iterate on the prompt.',
                    'Clasificación con Claude Haiku 4.5. Si algo está mal etiquetado, márcalo triado y mejoramos el prompt.',
                )}
            </div>
        </div>
    );
}
