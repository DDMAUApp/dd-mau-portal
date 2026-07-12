// Deleted staff — collapsible AdminPanel section listing everyone
// removed from the roster (live from /staff_archive), with an
// expandable detail view of their full record and a two-tap Restore.
// Andrew 2026-07-10: "keep a list of deleted staff members so we can
// look back at info if needed."
//
// The subscription only exists while the section is expanded — same
// reasoning as the other collapsed-by-default admin sections (don't
// pay for rows nobody is looking at).

import { useState, useEffect } from 'react';
import { subscribeStaffArchive } from '../data/staffArchive';

// Record fields hidden from the detail view: pin (never render PINs),
// name (already the row title), id (stale roster id, meaningless).
const HIDDEN_FIELDS = new Set(['pin', 'name', 'id']);

function fmtWhen(ts) {
    try {
        const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
        if (!d || isNaN(d.getTime())) return '—';
        return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch { return '—'; }
}

function fmtValue(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return v ? '✓' : '✗';
    if (typeof v === 'object') {
        try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
}

export default function DeletedStaffSection({ language, onRestore }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [expanded, setExpanded] = useState(false);
    const [rows, setRows] = useState(null); // null = loading
    const [detailId, setDetailId] = useState(null);
    const [confirmId, setConfirmId] = useState(null);
    const [busyId, setBusyId] = useState(null);

    useEffect(() => {
        if (!expanded) return;
        const unsub = subscribeStaffArchive(setRows);
        return () => unsub();
    }, [expanded]);

    const handleRestore = async (entry) => {
        if (busyId) return;
        setBusyId(entry.id);
        try { await onRestore(entry); }
        finally {
            setBusyId(null);
            setConfirmId(null);
        }
    };

    return (
        <div className="mb-6">
            <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}
                className="glass-section-head tint-slate">
                <div className="flex items-center gap-3 min-w-0">
                    <span className="glass-icon-tile" aria-hidden="true">🗂️</span>
                    <div className="text-left min-w-0">
                        <h3 className="font-bold text-[15px] text-dd-text">{tx('Deleted staff', 'Personal eliminado')}</h3>
                        <p className="text-[11px] text-dd-text-2 truncate">
                            {tx('Records kept from removed staff — view or restore',
                                'Registros del personal eliminado — ver o restaurar')}
                        </p>
                    </div>
                </div>
                <span className="section-chevron text-xl" aria-hidden="true">›</span>
            </button>

            {expanded && (
                <div className="mt-2 space-y-2">
                    {rows === null ? (
                        <p className="text-sm text-gray-400 p-3">{tx('Loading…', 'Cargando…')}</p>
                    ) : rows.length === 0 ? (
                        <p className="text-sm text-gray-400 p-3">
                            {tx('No deleted staff on record yet. From now on, every removal is saved here automatically.',
                                'Aún no hay personal eliminado registrado. Desde ahora, cada eliminación se guarda aquí automáticamente.')}
                        </p>
                    ) : rows.map(row => {
                        const rec = row.record || {};
                        const showDetail = detailId === row.id;
                        return (
                            <div key={row.id} className="bg-white border border-gray-200 rounded-lg p-3">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="font-bold text-gray-800 flex items-center gap-2 flex-wrap">
                                            <span>{row.name || rec.name || '?'}</span>
                                            {row.restored && (
                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                                                    {tx('Restored', 'Restaurado')} {fmtWhen(row.restoredAt)}
                                                </span>
                                            )}
                                            {row.backfilled && (
                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700"
                                                    title={tx('Deleted before the archive existed — only the name could be recovered',
                                                        'Eliminado antes de que existiera el archivo — solo se recuperó el nombre')}>
                                                    {tx('Name only', 'Solo nombre')}
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-xs text-gray-500 mt-0.5">
                                            {[rec.role, rec.location, rec.phone || rec.phoneE164].filter(Boolean).join(' · ') || tx('No details captured', 'Sin detalles')}
                                        </div>
                                        <div className="text-[11px] text-gray-400 mt-0.5">
                                            {tx('Removed', 'Eliminado')} {fmtWhen(row.archivedAt)}
                                            {row.archivedBy && row.archivedBy !== 'backfill' ? ` ${tx('by', 'por')} ${row.archivedBy}` : ''}
                                        </div>
                                    </div>
                                    <div className="flex flex-col gap-1 items-end shrink-0">
                                        {!row.backfilled && (
                                            <button onClick={() => setDetailId(showDetail ? null : row.id)}
                                                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition">
                                                {showDetail ? tx('Hide info', 'Ocultar info') : tx('View info', 'Ver info')}
                                            </button>
                                        )}
                                        {!row.restored && !row.backfilled && (
                                            confirmId === row.id ? (
                                                <button onClick={() => handleRestore(row)}
                                                    disabled={busyId === row.id}
                                                    className="text-xs font-bold px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 transition disabled:opacity-60">
                                                    {busyId === row.id ? tx('Restoring…', 'Restaurando…') : tx('Confirm restore', 'Confirmar')}
                                                </button>
                                            ) : (
                                                <button onClick={() => setConfirmId(row.id)}
                                                    className="text-xs font-bold px-3 py-1.5 rounded-lg bg-green-50 text-green-700 border border-green-200 hover:bg-green-100 transition">
                                                    ↩︎ {tx('Restore', 'Restaurar')}
                                                </button>
                                            )
                                        )}
                                    </div>
                                </div>

                                {showDetail && (
                                    <div className="mt-2 pt-2 border-t border-gray-100 grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1">
                                        {Object.entries(rec)
                                            .filter(([k]) => !HIDDEN_FIELDS.has(k))
                                            .sort(([a], [b]) => a.localeCompare(b))
                                            .map(([k, v]) => (
                                                <div key={k} className="text-[11px] min-w-0">
                                                    <span className="text-gray-400">{k}: </span>
                                                    <span className="text-gray-700 font-semibold break-words">{fmtValue(v)}</span>
                                                </div>
                                            ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
