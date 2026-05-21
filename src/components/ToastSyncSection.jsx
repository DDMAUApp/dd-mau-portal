// ToastSyncSection — admin UI for the Toast → 86 sync.
//
// Andrew 2026-05-20: "is there a way to tag the menu items straight
// to toast. so if we change a menu item on toast it changes on the
// menu?" — first deliverable is the 86 sync. When admin marks an
// item out-of-stock in Toast, this picks it up within 5 min and
// strikes it on the menu TVs automatically.
//
// What this UI does:
//   • Per-location toggle to enable/disable Toast sync
//   • Restaurant External ID (GUID) input per location
//   • Live status: last-synced timestamp, OOS counts, last error
//   • Setup checklist (one-time secrets) shown when nothing is wired
//
// Backend: /config/toast_<location> docs, written by both this UI
// and the syncToastMenuStatus Cloud Function.

import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { toast } from '../toast';

const LOC_LABEL = { webster: 'Webster', maryland: 'MD Heights' };

export default function ToastSyncSection({ language = 'en', byName }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    return (
        <div className="mt-6 mb-4 bg-white border-2 border-orange-200 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="text-2xl">🍞</span>
                <h3 className="text-base font-bold text-orange-900">
                    {tx('Toast POS → 86 sync', 'Toast POS → sync de 86')}
                </h3>
                <span className="text-[10px] font-bold text-orange-700 bg-orange-50 px-2 py-0.5 rounded-full border border-orange-300">
                    {tx('Auto-strikes items from Toast', 'Auto desde Toast')}
                </span>
            </div>
            <p className="text-[11px] text-orange-700 mb-3 leading-snug">
                {tx(
                    'When staff marks an item out-of-stock in Toast, our 86 dashboard auto-strikes it within ~5 min — no double entry. Manual 86s in our app are never overwritten by Toast sync.',
                    'Cuando se marca un item out-of-stock en Toast, nuestro tablero de 86 lo sincroniza en ~5 min. Los 86 manuales nunca se sobrescriben.',
                )}
            </p>

            <div className="space-y-3">
                {['webster', 'maryland'].map(loc => (
                    <ToastLocationRow key={loc} location={loc}
                        locationLabel={LOC_LABEL[loc]}
                        byName={byName} tx={tx} />
                ))}
            </div>

            {/* Setup checklist — shown collapsed by default */}
            <details className="mt-4 border-t border-orange-200 pt-3">
                <summary className="cursor-pointer text-[11px] font-bold text-orange-800 hover:text-orange-900">
                    📖 {tx('One-time setup steps (read this before enabling)', 'Pasos iniciales')}
                </summary>
                <ol className="text-[11px] text-orange-800 leading-snug mt-2 space-y-1 list-decimal list-inside pl-1">
                    <li>{tx('In Toast: Toast Admin → Integrations → Toast Connect → request API access. They\'ll give you a client_id + client_secret per location.', 'En Toast: pide acceso a Toast Connect API; te darán client_id y client_secret.')}</li>
                    <li>{tx('In a terminal at the repo:', 'En terminal:')} <code className="bg-white px-1 py-0.5 rounded font-mono text-[10px]">firebase functions:secrets:set TOAST_WEBSTER_CLIENT_ID</code> {tx('(paste the value when prompted)', '(pega el valor)')}</li>
                    <li>{tx('Repeat for TOAST_WEBSTER_CLIENT_SECRET, TOAST_MARYLAND_CLIENT_ID, TOAST_MARYLAND_CLIENT_SECRET.', 'Repite para los otros 3 secretos.')}</li>
                    <li>{tx('Find each location\'s Restaurant External ID (GUID) in Toast (Restaurants → Integrations → External IDs). Paste it below.', 'Encuentra el Restaurant External ID en Toast y pégalo abajo.')}</li>
                    <li>{tx('Redeploy functions:', 'Re-despliega functions:')} <code className="bg-white px-1 py-0.5 rounded font-mono text-[10px]">firebase deploy --only functions:syncToastMenuStatus</code></li>
                    <li>{tx('Toggle the location ON above. First sync happens within 5 min.', 'Activa la ubicación. Primer sync en 5 min.')}</li>
                </ol>
            </details>
        </div>
    );
}

function ToastLocationRow({ location, locationLabel, byName, tx }) {
    const [cfg, setCfg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [guidDraft, setGuidDraft] = useState('');
    const [enabled, setEnabled] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        const unsub = onSnapshot(doc(db, 'config', `toast_${location}`), (snap) => {
            if (snap.exists()) {
                const d = snap.data() || {};
                setCfg(d);
                setGuidDraft(d.restaurantGuid || '');
                setEnabled(d.enabled === true);
            } else {
                setCfg({});
            }
            setLoading(false);
        }, (err) => {
            console.warn('toast config snapshot failed:', err);
            setLoading(false);
        });
        return unsub;
    }, [location]);

    const save = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await setDoc(doc(db, 'config', `toast_${location}`), {
                enabled,
                restaurantGuid: guidDraft.trim() || null,
                updatedAt: serverTimestamp(),
                updatedBy: byName || null,
            }, { merge: true });
            toast(tx('✓ Saved', '✓ Guardado'), { kind: 'success' });
        } catch (e) {
            console.warn('toast config save failed:', e);
            toast(tx('Save failed', 'Error') + ': ' + (e?.message || ''), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <div className="text-[11px] text-orange-700/70 px-2 py-1.5">{tx('Loading…', 'Cargando…')}</div>;
    }

    const lastSyncedAt = cfg?.lastSyncedAt;
    const lastSyncedDate = lastSyncedAt?.toDate ? lastSyncedAt.toDate() : null;
    const ageMin = lastSyncedDate ? Math.floor((Date.now() - lastSyncedDate.getTime()) / 60_000) : null;
    const fmtAge = (m) => m == null ? '—' : m < 1 ? tx('just now', 'ahora') : m < 60 ? `${m} min ago` : `${Math.floor(m/60)}h ago`;
    const syncOk = cfg?.lastSyncOk === true;
    const syncError = cfg?.lastSyncError;

    return (
        <div className="border border-orange-200 rounded-lg p-3 bg-orange-50/40">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <span className="text-sm font-black text-orange-900">{locationLabel}</span>
                <label className="flex items-center gap-1.5 text-[11px] text-orange-800 font-bold cursor-pointer">
                    <input type="checkbox" checked={enabled}
                        onChange={(e) => setEnabled(e.target.checked)}
                        className="w-4 h-4 accent-orange-600" />
                    {tx('Enable Toast sync', 'Activar')}
                </label>
            </div>

            <label className="block mb-2">
                <span className="block text-[10px] font-bold uppercase tracking-wide text-orange-800 mb-0.5">
                    {tx('Restaurant External ID (Toast GUID)', 'Restaurant GUID')}
                </span>
                <input type="text" value={guidDraft}
                    onChange={(e) => setGuidDraft(e.target.value)}
                    placeholder="d6a45e9c-5ff5-4f8e-..."
                    className="w-full px-2 py-1.5 rounded border border-orange-200 text-sm bg-white font-mono" />
            </label>

            {/* Status badges */}
            {enabled && guidDraft && (
                <div className="flex items-center gap-2 flex-wrap text-[10px] mb-2">
                    {lastSyncedDate ? (
                        syncOk ? (
                            <span className="font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                                ✓ {tx('Last sync', 'Último')}: {fmtAge(ageMin)}
                                {cfg?.lastSyncToastOOSCount != null && (
                                    <> · {cfg.lastSyncToastOOSCount} {tx('from Toast', 'de Toast')}</>
                                )}
                            </span>
                        ) : (
                            <span className="font-bold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
                                ✕ {tx('Last sync failed', 'Falló')}: {fmtAge(ageMin)}
                            </span>
                        )
                    ) : (
                        <span className="font-bold text-stone-600 bg-white border border-stone-200 px-2 py-0.5 rounded-full">
                            ⏳ {tx('Waiting for first sync', 'Esperando primer sync')}
                        </span>
                    )}
                </div>
            )}

            {syncError && (
                <p className="text-[10px] text-red-800 bg-red-50 border border-red-200 rounded p-2 mb-2 font-mono break-all">
                    {syncError}
                </p>
            )}

            <button onClick={save} disabled={saving}
                className="w-full py-1.5 rounded-lg bg-orange-600 text-white text-xs font-bold hover:bg-orange-700 disabled:opacity-40">
                {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
            </button>
        </div>
    );
}
