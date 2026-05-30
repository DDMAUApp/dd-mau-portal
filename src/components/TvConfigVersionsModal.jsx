// TvConfigVersionsModal — list of past published versions of a TV
// config, with a Restore button per row.
//
// Andrew 2026-05-23 audit follow-up. Every save / publish / rollback
// now archives the prior published state to
// /tv_configs/{tvId}/versions/v<N> (see src/data/tvConfigs.js).
// This modal renders that history and lets admin restore any past
// version to live with one click. Restoring archives the CURRENT
// live state first, so rolling back is itself reversible — a kind
// of poor-man's git for menu configurations.
//
// What we show per row: version number, the supersededAt timestamp
// (when it was replaced), who replaced it, why (live_save /
// publish_draft / rollback), and a one-line summary of the snapshot
// (label · mode · layout). Tap a row to expand a brief diff-ish
// readout of the most-likely-to-change fields (image count, daypart
// count, hit-zone count) so admin can sanity-check before restore.

import { useEffect, useMemo, useState } from 'react';
import { subscribeTvConfigVersions, rollbackTvConfig } from '../data/tvConfigs';
import ModalPortal from './ModalPortal';

export default function TvConfigVersionsModal({
    language = 'en', staffName, tvId, label, onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [versions, setVersions] = useState(null);
    useEffect(() => {
        if (!tvId) return;
        const unsub = subscribeTvConfigVersions(tvId, setVersions);
        return unsub;
    }, [tvId]);

    const [expandedId, setExpandedId] = useState(null);
    const [restoringId, setRestoringId] = useState(null);
    const [error, setError] = useState(null);
    const [restoredId, setRestoredId] = useState(null);

    async function handleRestore(versionId) {
        if (restoringId) return;
        const confirmed = window.confirm(tx(
            `Restore "${label}" to ${versionId}? The current live version will be archived as the next version (rollback is itself reversible).`,
            `¿Restaurar "${label}" a ${versionId}? La versión en vivo actual se archivará como la siguiente (la reversión es reversible).`,
        ));
        if (!confirmed) return;
        setRestoringId(versionId);
        setError(null);
        try {
            await rollbackTvConfig({ tvId, versionId, byName: staffName });
            setRestoredId(versionId);
            // Auto-close 1.2s after restore so admin can see the
            // confirmation flash without lingering on a stale list.
            setTimeout(() => { onClose?.(); }, 1200);
        } catch (e) {
            setError(e?.message || 'Restore failed');
        } finally {
            setRestoringId(null);
        }
    }

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={onClose}>
            <div className="bg-white rounded-2xl shadow-xl max-w-xl w-full max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-dd-line shrink-0">
                    <div className="min-w-0">
                        <h2 className="text-lg font-black text-dd-text truncate">
                            🕰 {tx('Version history', 'Historial')}
                        </h2>
                        <p className="text-[11px] text-dd-text-2 truncate">{label} · <span className="font-mono">{tvId}</span></p>
                    </div>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full hover:bg-dd-bg text-dd-text-2 text-lg font-bold shrink-0">×</button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    {versions === null ? (
                        <p className="text-sm text-dd-text-2 italic text-center py-8">
                            {tx('Loading history…', 'Cargando historial…')}
                        </p>
                    ) : versions.length === 0 ? (
                        <div className="text-center py-10">
                            <div className="text-4xl mb-2">📜</div>
                            <p className="text-sm text-dd-text-2 max-w-md mx-auto">
                                {tx(
                                    'No previous versions yet. The first save under the new publish flow becomes v1 — once you save again, the original lands here.',
                                    'Sin versiones previas. El primer guardado bajo el nuevo flujo es v1 — al guardar otra vez, la original aparecerá aquí.',
                                )}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {versions.map(v => (
                                <VersionRow
                                    key={v.id}
                                    version={v}
                                    isEs={isEs}
                                    expanded={expandedId === v.id}
                                    onToggleExpand={() => setExpandedId(prev => prev === v.id ? null : v.id)}
                                    restoring={restoringId === v.id}
                                    restored={restoredId === v.id}
                                    onRestore={() => handleRestore(v.id)} />
                            ))}
                        </div>
                    )}
                    {error && (
                        <p className="mt-3 text-sm text-red-700 font-bold text-center">⚠ {error}</p>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t border-dd-line shrink-0 text-[11px] text-dd-text-2">
                    {tx(
                        'Restoring archives the current live state first, so rolling back is reversible.',
                        'Restaurar archiva primero el estado en vivo, por lo que la reversión es reversible.',
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

function VersionRow({ version, isEs, expanded, onToggleExpand, restoring, restored, onRestore }) {
    const tx = (en, es) => (isEs ? es : en);

    // Snapshot one-liner — the fields most likely to have changed.
    const mode   = version.mode || 'menu';
    const layout = version.layout || 'dense';
    const imgCount      = Array.isArray(version.imageUrls) ? version.imageUrls.length : 0;
    const daypartCount  = Array.isArray(version.dayparts) ? version.dayparts.length : 0;
    const hitZoneCount  = Array.isArray(version.imageHitZones) ? version.imageHitZones.length : 0;
    const promoEnabled  = version.promoStrip?.enabled === true;

    const reason = version.reason || 'live_save';
    const reasonBadge = {
        live_save:     { label: tx('Live save',     'Guardado en vivo'), tone: 'bg-dd-bg text-dd-text-2 border-dd-line' },
        publish_draft: { label: tx('Published',     'Publicado'),         tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
        rollback:      { label: tx('Rollback',      'Reversión'),         tone: 'bg-amber-50 text-amber-700 border-amber-200' },
    }[reason] || { label: reason, tone: 'bg-dd-bg text-dd-text-2 border-dd-line' };

    const ts = version.supersededAt;
    const supersededLabel = useMemo(() => {
        if (!ts) return '—';
        const ms = ts.toMillis ? ts.toMillis() : ts.seconds ? ts.seconds * 1000 : 0;
        if (!ms) return '—';
        return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
    }, [ts]);

    return (
        <div className="bg-white border border-dd-line rounded-lg overflow-hidden">
            <button onClick={onToggleExpand}
                className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-dd-bg text-left">
                <span className="text-base font-black tabular-nums text-dd-text shrink-0">
                    v{version.version ?? '?'}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold text-dd-text truncate">
                        {version.label || version.tvId}
                    </div>
                    <div className="text-[11px] text-dd-text-2 truncate">
                        {mode === 'menu' ? `🍜 ${tx('menu', 'menú')} · ${layout}` : mode === 'image' ? `🖼 ${tx('image', 'imagen')} × ${imgCount}` : `⫴ ${tx('split', 'dividido')}`}
                        {daypartCount > 0 && ` · ${daypartCount} ${tx('dayparts', 'horarios')}`}
                        {hitZoneCount > 0 && ` · ${hitZoneCount} ${tx('zones', 'zonas')}`}
                        {promoEnabled && ` · 📣 ${tx('promo', 'promo')}`}
                    </div>
                </div>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border shrink-0 ${reasonBadge.tone}`}>
                    {reasonBadge.label}
                </span>
            </button>
            {expanded && (
                <div className="px-3 pb-3 border-t border-dd-line/60 bg-dd-bg">
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] mt-2">
                        <dt className="text-dd-text-2">{tx('Superseded', 'Reemplazado')}</dt>
                        <dd className="text-dd-text font-bold">{supersededLabel}</dd>
                        <dt className="text-dd-text-2">{tx('By', 'Por')}</dt>
                        <dd className="text-dd-text font-bold">{version.supersededBy || '—'}</dd>
                        <dt className="text-dd-text-2">{tx('Mode', 'Modo')}</dt>
                        <dd className="text-dd-text font-mono">{mode}</dd>
                        <dt className="text-dd-text-2">{tx('Location', 'Local')}</dt>
                        <dd className="text-dd-text">{version.location || '—'}</dd>
                        {version.rolledBackTo && (
                            <>
                                <dt className="text-dd-text-2">{tx('Rolled back to', 'Revertido a')}</dt>
                                <dd className="text-dd-text font-mono">{version.rolledBackTo}</dd>
                            </>
                        )}
                    </dl>
                    <div className="mt-3 flex items-center gap-2">
                        <button onClick={onRestore}
                            disabled={restoring || restored}
                            className={`px-3 py-1.5 rounded-lg text-[12px] font-bold transition active:scale-95 ${
                                restored
                                    ? 'bg-emerald-600 text-white'
                                    : restoring
                                    ? 'bg-dd-bg text-dd-text-2 cursor-not-allowed'
                                    : 'bg-amber-600 text-white hover:bg-amber-700'
                            }`}>
                            {restored ? `✓ ${tx('Restored', 'Restaurado')}` : restoring ? tx('Restoring…', 'Restaurando…') : `↺ ${tx('Restore this version', 'Restaurar esta versión')}`}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
