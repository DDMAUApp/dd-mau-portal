// PrepBoard.jsx — weekly prep PLANNING board (Operations → Prep tab).
//
// Andrew 2026-06-08: "2 columns. Left = prep tasks (give them hours, write in
// prep, most pre-filled). Right = cubes Monday–Saturday. Tap a task to
// highlight, tap a day cube to send it there; tap an assigned one to move it to
// another day or back to the list. Make the week printable. Add notes to a day
// or an item. Add anything that makes it more functional."
//
// Model — Firestore ops/prepBoard_{location}:
//   { pool: Item[], days: { mon:{items:Item[],note}, … sat }, seeded, updatedAt, updatedBy }
//   Item = { id, en, es, hours: number|null, note: string }
// Each item lives in exactly ONE bucket (pool OR a single day) — moving is a
// transfer, matching the tap-to-move flow. Seeded ONCE from PREP_STATIONS (the
// existing master prep list) so most items are pre-filled. Standing WEEKLY
// template (day-of-week, not dated).
//
// The legacy PrepList component + its ops/prepList_{loc} data are intentionally
// left intact (this is a brand-new doc), so the change is fully revertible.
import { useState, useEffect, useRef, useMemo } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore';
import { PREP_STATIONS } from '../data/prepList';
import { escapeHtml as esc } from '../data/htmlEscape';
import { isAdmin } from '../data/staff';
import { toast } from '../toast';
import { printViaNative } from '../capacitor-bridge';

const DAYS = [
    { key: 'mon', en: 'Monday',    es: 'Lunes' },
    { key: 'tue', en: 'Tuesday',   es: 'Martes' },
    { key: 'wed', en: 'Wednesday', es: 'Miércoles' },
    { key: 'thu', en: 'Thursday',  es: 'Jueves' },
    { key: 'fri', en: 'Friday',    es: 'Viernes' },
    { key: 'sat', en: 'Saturday',  es: 'Sábado' },
];
const DAY_KEYS = DAYS.map(d => d.key);

const clone = (o) => JSON.parse(JSON.stringify(o));

function emptyDays() {
    const d = {};
    for (const k of DAY_KEYS) d[k] = { items: [], note: '' };
    return d;
}
// Seed the pool from the master prep list (src/data/prepList.js). Runs once,
// the first time the board doc is created for a location.
function buildSeed() {
    const pool = [];
    for (const st of (PREP_STATIONS || [])) {
        for (const it of (st.items || [])) {
            pool.push({ id: it.id, en: it.name, es: it.nameEs || it.name, hours: null, note: '' });
        }
    }
    return { pool, days: emptyDays() };
}
// Defend against an older / partial day shape from Firestore.
function normalizeDays(days) {
    const out = emptyDays();
    if (days && typeof days === 'object') {
        for (const k of DAY_KEYS) {
            const d = days[k];
            if (d && Array.isArray(d.items)) out[k] = { items: d.items, note: typeof d.note === 'string' ? d.note : '' };
        }
    }
    return out;
}
// Remove an item from wherever it lives (pool or a day) and return it. Mutates b.
function pluck(b, id) {
    const pi = b.pool.findIndex(i => i.id === id);
    if (pi >= 0) return b.pool.splice(pi, 1)[0];
    for (const k of DAY_KEYS) {
        const di = b.days[k].items.findIndex(i => i.id === id);
        if (di >= 0) return b.days[k].items.splice(di, 1)[0];
    }
    return null;
}
function findItem(b, id) {
    if (!id) return null;
    const p = b.pool.find(i => i.id === id);
    if (p) return p;
    for (const k of DAY_KEYS) { const d = b.days[k].items.find(i => i.id === id); if (d) return d; }
    return null;
}
const itemHours = (it) => (typeof it.hours === 'number' && isFinite(it.hours) ? it.hours : 0);
const sumHours = (items) => items.reduce((a, it) => a + itemHours(it), 0);
const fmtHrs = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export default function PrepBoard({ language, staffName, storeLocation, staffList }) {
    const es = language === 'es';
    const tx = (en, esT) => (es ? esT : en);
    const adminUser = isAdmin(staffName, staffList);

    const [board, setBoard] = useState(() => buildSeed());
    const [selectedId, setSelectedId] = useState(null);
    const [filter, setFilter] = useState('');
    const [addName, setAddName] = useState('');
    const [editTarget, setEditTarget] = useState(null); // {type:'item',id} | {type:'day',key}
    const seededRef = useRef(false);

    const ref = useMemo(
        () => (storeLocation ? doc(db, 'ops', 'prepBoard_' + storeLocation) : null),
        [storeLocation]
    );

    // ── Live sync + one-time seed ───────────────────────────────────
    useEffect(() => {
        if (!ref) return;
        const unsub = onSnapshot(ref, async (snap) => {
            if (snap.exists() && Array.isArray(snap.data()?.pool)) {
                const data = snap.data();
                setBoard({ pool: data.pool, days: normalizeDays(data.days) });
            } else if (!seededRef.current) {
                seededRef.current = true;
                try {
                    await runTransaction(db, async (t) => {
                        const s = await t.get(ref);
                        if (s.exists() && Array.isArray(s.data()?.pool)) return; // someone else seeded
                        t.set(ref, { ...buildSeed(), seeded: true, updatedAt: serverTimestamp(), updatedBy: staffName || 'system' });
                    });
                } catch (e) { console.warn('[prepBoard] seed failed:', e?.message); }
            }
        }, (err) => console.warn('[prepBoard] snapshot error:', err?.message));
        return () => unsub();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ref]);

    // ── Transactional write (read-live → apply → write), with an
    //    optimistic local update so the UI moves instantly. ──────────
    const writeBoard = async (mutator) => {
        setBoard(prev => { const next = mutator(clone(prev)); return next || prev; });
        if (!ref) return;
        try {
            await runTransaction(db, async (t) => {
                const s = await t.get(ref);
                const base = (s.exists() && Array.isArray(s.data()?.pool))
                    ? { pool: s.data().pool, days: normalizeDays(s.data().days) }
                    : buildSeed();
                const next = mutator(clone(base));
                if (!next) return;
                t.set(ref, { pool: next.pool, days: next.days, seeded: true, updatedAt: serverTimestamp(), updatedBy: staffName || '' });
            });
        } catch (e) {
            console.warn('[prepBoard] write failed:', e?.message);
            toast(tx('Could not save — try again', 'No se pudo guardar — intenta de nuevo'), { kind: 'error' });
        }
    };

    // ── Mutators ────────────────────────────────────────────────────
    const moveToDay = (id, dayKey) => writeBoard(b => { const it = pluck(b, id); if (it) b.days[dayKey].items.push(it); return b; });
    const moveToPool = (id) => writeBoard(b => { const it = pluck(b, id); if (it) b.pool.push(it); return b; });
    const clearDay = (dayKey) => writeBoard(b => { for (const it of b.days[dayKey].items) b.pool.push(it); b.days[dayKey].items = []; return b; });
    const removeItem = (id) => writeBoard(b => { pluck(b, id); return b; });
    const updateItem = (id, patch) => writeBoard(b => { const it = findItem(b, id); if (it) Object.assign(it, patch); return b; });
    const setDayNote = (dayKey, note) => writeBoard(b => { b.days[dayKey].note = note; return b; });
    const addPrep = (name) => {
        const nm = (name || '').trim();
        if (!nm) return;
        const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        writeBoard(b => { b.pool.push({ id, en: nm, es: nm, hours: null, note: '' }); return b; });
        setAddName('');
    };
    const resetBoard = () => {
        if (!confirm(tx('Reset the whole board to the master prep list? This clears every day.', '¿Restablecer todo el tablero a la lista maestra? Esto borra cada día.'))) return;
        setSelectedId(null);
        writeBoard(() => buildSeed());
    };

    // ── Selection ───────────────────────────────────────────────────
    const selectedItem = findItem(board, selectedId);
    const selectedDayKey = DAY_KEYS.find(k => board.days[k].items.some(i => i.id === selectedId)) || null;
    const toggleSelect = (id) => setSelectedId(prev => (prev === id ? null : id));
    const assignToDay = (dayKey) => { if (selectedId) { moveToDay(selectedId, dayKey); setSelectedId(null); } };
    const returnToList = () => { if (selectedId) { moveToPool(selectedId); setSelectedId(null); } };

    const filteredPool = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return board.pool;
        return board.pool.filter(it => (it.en || '').toLowerCase().includes(q) || (it.es || '').toLowerCase().includes(q));
    }, [board.pool, filter]);

    const weekHours = useMemo(() => DAY_KEYS.reduce((a, k) => a + sumHours(board.days[k].items), 0), [board]);

    // ── Print week ──────────────────────────────────────────────────
    const printWeek = () => {
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DD Mau Prep Week</title><style>
            *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;color:#111}
            h1{font-size:20px;margin:0 0 2px} .date{font-size:11px;color:#666;margin-bottom:12px}
            .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
            .day{border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;break-inside:avoid}
            .day h2{background:#255a37;color:#fff;font-size:13px;margin:0;padding:6px 10px;display:flex;justify-content:space-between;align-items:center}
            .day .note{font-size:10px;color:#555;font-style:italic;padding:4px 10px;border-bottom:1px solid #eee}
            table{width:100%;border-collapse:collapse} td{font-size:12px;padding:4px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top}
            td.h{text-align:right;color:#888;width:42px;white-space:nowrap} td.n{color:#777;font-size:10px;font-style:italic}
            .empty{font-size:11px;color:#aaa;padding:8px 10px}
            .no-print{position:sticky;top:0;background:#255a37;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)}
            .no-print button{padding:10px 20px;font-size:15px;font-weight:bold;border:none;border-radius:8px;margin:0 6px;cursor:pointer}
            .btn-print{background:#fff;color:#255a37} .btn-close{background:#ef4444;color:#fff}
            @media print{.no-print{display:none!important} .day h2{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
        </style></head><body>`;
        html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://app.ddmaustl.com/'}},300)">✕ ${esc(tx('Close', 'Cerrar'))}</button><button class="btn-print" onclick="window.print()">🖨️ ${esc(tx('Print', 'Imprimir'))}</button></div>`;
        html += `<h1>${esc(tx('Weekly Prep', 'Prep Semanal'))} — ${esc(storeLocation || '')}</h1>`;
        html += `<div class="date">${esc(dateStr)} · ${esc(timeStr)} · ${esc(tx('Total', 'Total'))}: ${fmtHrs(weekHours)}h</div>`;
        html += `<div class="grid">`;
        for (const day of DAYS) {
            const d = board.days[day.key];
            const total = sumHours(d.items);
            html += `<div class="day"><h2><span>${esc(tx(day.en, day.es))}</span><span>${d.items.length} · ${fmtHrs(total)}h</span></h2>`;
            if (d.note) html += `<div class="note">${esc(d.note)}</div>`;
            if (d.items.length === 0) {
                html += `<div class="empty">—</div>`;
            } else {
                html += `<table>`;
                for (const it of d.items) {
                    const nm = es ? (it.es || it.en) : it.en;
                    html += `<tr><td>${esc(nm)}${it.note ? `<div class="n">${esc(it.note)}</div>` : ''}</td><td class="h">${itemHours(it) ? fmtHrs(itemHours(it)) + 'h' : ''}</td></tr>`;
                }
                html += `</table>`;
            }
            html += `</div>`;
        }
        html += `</div></body></html>`;
        if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Prep Week'); return; }
        const w = window.open('', '_blank');
        if (!w) { toast(tx('Please allow pop-ups to print.', 'Permita ventanas emergentes para imprimir.')); return; }
        w.document.write(html); w.document.close(); w.print();
    };

    // ── Chip (used in both columns) ─────────────────────────────────
    const renderChip = (it) => {
        const selected = selectedId === it.id;
        const nm = es ? (it.es || it.en) : it.en;
        return (
            <div key={it.id} className={`flex items-stretch gap-0.5 mb-1 rounded-lg border transition ${selected ? 'border-dd-green ring-1 ring-dd-green' : 'border-dd-line'}`}>
                <button type="button" onClick={(e) => { e.stopPropagation(); toggleSelect(it.id); }}
                    className={`flex-1 min-w-0 text-left rounded-l-lg px-2 py-1.5 flex items-center gap-1.5 ${selected ? 'bg-dd-green text-white' : 'bg-white text-dd-text'}`}>
                    <span className="flex-1 min-w-0 text-[12px] font-semibold leading-tight break-words">{nm}</span>
                    {itemHours(it) > 0 && <span className={`text-[10px] font-bold px-1 rounded ${selected ? 'bg-white/25' : 'bg-dd-bg text-dd-text-2'}`}>{fmtHrs(itemHours(it))}h</span>}
                    {it.note && <span className="text-[10px]" title={it.note}>📝</span>}
                </button>
                <button type="button" aria-label="Edit" onClick={(e) => { e.stopPropagation(); setEditTarget({ type: 'item', id: it.id }); }}
                    className={`px-1.5 rounded-r-lg text-[11px] ${selected ? 'bg-dd-green/80 text-white' : 'bg-dd-bg text-dd-text-2 hover:bg-dd-line'}`}>✎</button>
            </div>
        );
    };

    // ── Day cube ────────────────────────────────────────────────────
    const renderDay = (day) => {
        const d = board.days[day.key];
        const total = sumHours(d.items);
        const isTarget = !!selectedId;
        return (
            <div key={day.key} className="rounded-xl border border-dd-line bg-dd-surface overflow-hidden">
                <button type="button" onClick={() => assignToDay(day.key)} disabled={!selectedId}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left transition ${isTarget ? 'bg-dd-green/10 ring-1 ring-inset ring-dd-green/40' : 'bg-dd-bg/40'}`}>
                    <span className="font-black text-[13px] text-dd-text">{tx(day.en, day.es)}</span>
                    <span className="text-[10px] font-bold text-dd-text-2 flex items-center gap-1.5">
                        <span>{d.items.length}</span>
                        {total > 0 && <span className="text-dd-green">{fmtHrs(total)}h</span>}
                        {isTarget && <span className="text-dd-green">→ {tx('here', 'aquí')}</span>}
                    </span>
                </button>
                {d.note && <div className="px-2.5 py-1 text-[11px] italic text-dd-text-2 border-b border-dd-line/60">📝 {d.note}</div>}
                <div className="p-1.5 min-h-[2.5rem]">
                    {d.items.length === 0
                        ? <div className="text-[11px] text-dd-text-2 text-center py-2">{selectedId ? tx('tap header to add', 'toca el título') : '—'}</div>
                        : d.items.map(renderChip)}
                </div>
                <div className="flex items-center justify-between gap-1 px-2 py-1 border-t border-dd-line/60 bg-dd-bg/30">
                    <button type="button" onClick={() => setEditTarget({ type: 'day', key: day.key })}
                        className="text-[10px] font-bold text-dd-text-2 hover:text-dd-text">📝 {tx('Note', 'Nota')}</button>
                    {d.items.length > 0 && (
                        <button type="button" onClick={() => clearDay(day.key)}
                            className="text-[10px] font-bold text-dd-text-2 hover:text-red-600">↩ {tx('Clear', 'Limpiar')}</button>
                    )}
                </div>
            </div>
        );
    };

    // ── Render ──────────────────────────────────────────────────────
    return (
        <div className="pb-2">
            {/* Header */}
            <div className="flex items-center justify-between gap-2 mb-2">
                <div className="text-[11px] text-dd-text-2 font-semibold min-w-0">
                    {tx('Tap a prep, then a day to place it.', 'Toca un prep, luego un día.')}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {weekHours > 0 && <span className="text-[10px] font-bold text-dd-green">{fmtHrs(weekHours)}h/{tx('wk', 'sem')}</span>}
                    <button type="button" onClick={printWeek} className="glass-button-apple !px-2.5 !py-1.5 !text-xs">🖨 {tx('Print', 'Imprimir')}</button>
                    {adminUser && <button type="button" onClick={resetBoard} title={tx('Reset to master list', 'Restablecer')} className="text-sm font-bold text-dd-text-2 hover:text-red-600 px-1">↻</button>}
                </div>
            </div>

            {/* Selection action bar */}
            {selectedItem && (
                <div className="sticky top-0 z-10 mb-2 rounded-xl border border-dd-green bg-dd-green/10 px-2.5 py-2 flex items-center gap-2 flex-wrap backdrop-blur">
                    <span className="text-[12px] font-bold text-dd-text flex-1 min-w-0 break-words">
                        {tx('Moving', 'Moviendo')}: {es ? (selectedItem.es || selectedItem.en) : selectedItem.en}
                    </span>
                    {selectedDayKey && (
                        <button type="button" onClick={returnToList} className="text-[11px] font-bold px-2 py-1 rounded-lg bg-white border border-dd-line">↩ {tx('List', 'Lista')}</button>
                    )}
                    <button type="button" onClick={() => setEditTarget({ type: 'item', id: selectedId })} className="text-[11px] font-bold px-2 py-1 rounded-lg bg-white border border-dd-line">✎</button>
                    <button type="button" onClick={() => setSelectedId(null)} className="text-[11px] font-bold px-2 py-1 rounded-lg bg-white border border-dd-line">✕</button>
                </div>
            )}

            {/* 2-column board */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3 items-start">
                {/* LEFT — pool */}
                <div className="rounded-xl border border-dd-line bg-dd-surface overflow-hidden">
                    <div className="px-2.5 py-2 bg-dd-bg/40 border-b border-dd-line flex items-center justify-between">
                        <span className="font-black text-[13px] text-dd-text">{tx('Prep tasks', 'Tareas')}</span>
                        <span className="text-[10px] font-bold text-dd-text-2">{board.pool.length}</span>
                    </div>
                    {selectedDayKey && (
                        <button type="button" onClick={returnToList}
                            className="w-full text-[11px] font-bold text-dd-green bg-dd-green/10 ring-1 ring-inset ring-dd-green/40 py-1.5">
                            ↩ {tx('Tap to return here', 'Regresar aquí')}
                        </button>
                    )}
                    <div className="p-1.5 space-y-1 border-b border-dd-line/60">
                        <div className="flex gap-1">
                            <input value={addName} onChange={e => setAddName(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') addPrep(addName); }}
                                placeholder={tx('+ write in prep', '+ escribir prep')}
                                className="flex-1 min-w-0 text-[12px] px-2 py-1 rounded-lg border border-dd-line bg-white" />
                            <button type="button" onClick={() => addPrep(addName)} disabled={!addName.trim()}
                                className="text-[14px] font-bold px-2.5 rounded-lg bg-dd-green text-white disabled:opacity-40">+</button>
                        </div>
                        {board.pool.length > 8 && (
                            <input value={filter} onChange={e => setFilter(e.target.value)}
                                placeholder={tx('Filter…', 'Filtrar…')}
                                className="w-full text-[12px] px-2 py-1 rounded-lg border border-dd-line bg-white" />
                        )}
                    </div>
                    <div className="p-1.5 max-h-[62vh] overflow-y-auto">
                        {filteredPool.length === 0
                            ? <div className="text-[11px] text-dd-text-2 text-center py-3">{filter ? tx('No match.', 'Sin coincidencias.') : tx('All assigned.', 'Todo asignado.')}</div>
                            : filteredPool.map(renderChip)}
                    </div>
                </div>

                {/* RIGHT — day cubes (Mon–Sat) */}
                <div className="space-y-2">
                    {DAYS.map(renderDay)}
                </div>
            </div>

            {editTarget && (
                <PrepEditModal
                    target={editTarget}
                    board={board}
                    language={language}
                    onSaveItem={(id, patch) => updateItem(id, patch)}
                    onDeleteItem={(id) => { removeItem(id); if (selectedId === id) setSelectedId(null); }}
                    onSaveDayNote={(key, note) => setDayNote(key, note)}
                    onClose={() => setEditTarget(null)}
                />
            )}
        </div>
    );
}

// ── Edit modal — item (name/hours/note/delete) or day note ──────────
function PrepEditModal({ target, board, language, onSaveItem, onDeleteItem, onSaveDayNote, onClose }) {
    const es = language === 'es';
    const tx = (en, esT) => (es ? esT : en);
    const isItem = target.type === 'item';
    const item = isItem ? findItem(board, target.id) : null;
    const day = !isItem ? DAYS.find(d => d.key === target.key) : null;
    const dayData = !isItem ? board.days[target.key] : null;

    const [name, setName] = useState(item ? (item.en || '') : '');
    const [nameEs, setNameEs] = useState(item ? (item.es || '') : '');
    const [hours, setHours] = useState(item && item.hours != null ? String(item.hours) : '');
    const [note, setNote] = useState(isItem ? (item?.note || '') : (dayData?.note || ''));

    // If the item vanished (deleted elsewhere) while open, close cleanly.
    useEffect(() => { if (isItem && !item) onClose(); }, [isItem, item, onClose]);
    if (isItem && !item) return null;

    const save = () => {
        if (isItem) {
            const en = name.trim() || item.en;
            onSaveItem(target.id, {
                en,
                es: nameEs.trim() || en,
                hours: hours.trim() === '' ? null : (isFinite(Number(hours)) ? Math.max(0, Number(hours)) : null),
                note,
            });
        } else {
            onSaveDayNote(target.key, note);
        }
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
            <div className="w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl p-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}
                style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom,0px))' }}>
                <h3 className="font-black text-base mb-3">
                    {isItem ? tx('Edit prep', 'Editar prep') : `${tx('Note', 'Nota')} · ${tx(day.en, day.es)}`}
                </h3>
                {isItem ? (
                    <div className="space-y-2">
                        <div>
                            <label className="block text-xs font-bold text-dd-text-2 mb-0.5">{tx('Name (English)', 'Nombre (Inglés)')}</label>
                            <input value={name} onChange={e => setName(e.target.value)} className="w-full text-base px-3 py-2 rounded-lg border border-dd-line" />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-dd-text-2 mb-0.5">{tx('Name (Spanish)', 'Nombre (Español)')}</label>
                            <input value={nameEs} onChange={e => setNameEs(e.target.value)} className="w-full text-base px-3 py-2 rounded-lg border border-dd-line" />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-dd-text-2 mb-0.5">{tx('Hours', 'Horas')}</label>
                            <input value={hours} onChange={e => setHours(e.target.value)} type="number" inputMode="decimal" min="0" step="0.25"
                                placeholder="0" className="w-full text-base px-3 py-2 rounded-lg border border-dd-line" />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-dd-text-2 mb-0.5">{tx('Note', 'Nota')}</label>
                            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="w-full text-base px-3 py-2 rounded-lg border border-dd-line" />
                        </div>
                    </div>
                ) : (
                    <textarea value={note} onChange={e => setNote(e.target.value)} rows={4} autoFocus
                        placeholder={tx('Note for this day…', 'Nota para este día…')}
                        className="w-full text-base px-3 py-2 rounded-lg border border-dd-line" />
                )}
                <div className="flex items-center justify-between gap-2 mt-4">
                    {isItem
                        ? <button onClick={() => { onDeleteItem(target.id); onClose(); }} className="text-sm font-bold text-red-600 px-1">🗑 {tx('Delete', 'Eliminar')}</button>
                        : <span />}
                    <div className="flex gap-2">
                        <button onClick={onClose} className="text-sm font-bold px-3 py-2 rounded-lg bg-dd-bg text-dd-text-2">{tx('Cancel', 'Cancelar')}</button>
                        <button onClick={save} className="text-sm font-bold px-4 py-2 rounded-lg bg-dd-green text-white">{tx('Save', 'Guardar')}</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
