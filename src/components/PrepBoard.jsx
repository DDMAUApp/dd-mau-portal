// PrepBoard.jsx — weekly prep PLANNING board (Operations → Prep tab).
//
// Andrew 2026-06-08: "2 columns. Left = prep tasks (give them hours, write in
// prep, most pre-filled). Right = cubes Monday–Saturday. Tap a task to
// highlight, tap a day cube to send it there; tap an assigned one to move it to
// another day or back to the list. Make the week printable. Add notes to a day
// or an item." + "[20 BOH items] this is all back of house. The front of house
// I'll get the list together, make the front all writable. Make all the items
// editable."
//
// TWO independent boards per location — Back of House (seeded with the kitchen
// list below) and Front of House (starts empty / fully writable). A toggle
// switches sides. Every item is editable (name EN/ES, hours, note) + deletable
// via the ✎ button; "+ write in prep" adds custom items.
//
// Model — Firestore ops/prepBoard_{location}_{side}  (side = 'boh' | 'foh'):
//   { pool: Item[], days: { mon:{items:Item[],note}, … sat }, side, seeded, updatedAt, updatedBy }
//   Item = { id, en, es, hours: number|null, note: string, srcId? }
// The POOL is the permanent master list — items NEVER leave it. Assigning a
// master to a day adds a COPY there (fresh id + srcId → master) so the SAME prep
// can be scheduled on MULTIPLE days (Andrew 2026-06-08: "items can be prepped
// multiple days, keep the item on the list when copied"). Each day-copy carries
// its own hours/note. Standing WEEKLY template (day-of-week, not dated).
// Real-time synced via transactions.
//
// The legacy PrepList component + its ops/prepList_{loc} data are left intact
// (these are brand-new docs), so the change is fully revertible.
import { useState, useEffect, useRef, useMemo } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore';
import { escapeHtml as esc } from '../data/htmlEscape';
import { isAdmin } from '../data/staff';
import { toast } from '../toast';
import { printViaNative } from '../capacitor-bridge';
import { DEFAULT_SAUCES } from '../data/sauces';

const DAYS = [
    { key: 'mon', en: 'Monday',    es: 'Lunes' },
    { key: 'tue', en: 'Tuesday',   es: 'Martes' },
    { key: 'wed', en: 'Wednesday', es: 'Miércoles' },
    { key: 'thu', en: 'Thursday',  es: 'Jueves' },
    { key: 'fri', en: 'Friday',    es: 'Viernes' },
    { key: 'sat', en: 'Saturday',  es: 'Sábado' },
];
const DAY_KEYS = DAYS.map(d => d.key);

// Back-of-house kitchen prep list (Andrew 2026-06-08). [English, Spanish].
const BOH_ITEMS = [
    ['Pork Egg Rolls', 'Rollitos de Cerdo'],
    ['Vegetable Egg Rolls', 'Rollitos de Vegetales'],
    ['Crab Rangoons', 'Rangoon de Cangrejo'],
    ['Coconut Shrimp', 'Camarón con Coco'],
    ['Fried Shrimp Rolls', 'Rollos de Camarón Frito'],
    ['Fried Rice (Pork)', 'Arroz Frito con Cerdo'],
    ['Beef Pho', 'Pho de Res'],
    ['Chicken Pho', 'Pho de Pollo'],
    ['Vegan Pho', 'Pho Vegano'],
    ['Spicy Lemongrass Soup', 'Sopa Picante de Limoncillo'],
    ['Chicken Breast', 'Pechuga de Pollo'],
    ['Vegan Beef', 'Res Vegana'],
    ['Vegan Shrimp', 'Camarón Vegano'],
    ['Vegan Chicken', 'Pollo Vegano'],
    ['Tofu & Mushroom', 'Tofu y Champiñones'],
    ['Chicken Wings', 'Alitas de Pollo'],
    ['Fried Fish', 'Pescado Frito'],
    ['Cajun Salmon', 'Salmón Cajún'],
    ['Thai Chili Pepper Seasoning', 'Sazón de Chile Tailandés'],
    ['Seafood', 'Mariscos'],
];

const clone = (o) => JSON.parse(JSON.stringify(o));

function emptyDays() {
    const d = {};
    for (const k of DAY_KEYS) d[k] = { items: [], note: '' };
    return d;
}
// Seed a side's pool. BOH = the kitchen list above; FOH starts empty (Andrew
// fills it in). Stable ids so a re-seed never duplicates.
// Bump SEED_VERSION whenever BOH_ITEMS / the sauce list changes (already-seeded
// boards merge in the new items — see the seed-merge in the effect).
//   v2: added Sauce Log sauces.  v3: copy-model migration — guarantee every seed
//   master is in the POOL (restores any that the old move-model had pulled into a
//   day) and tag stray day items with a srcId so they read as copies.
const SEED_VERSION = 3;
function buildSeed(side) {
    if (side === 'boh') {
        const pool = [
            ...BOH_ITEMS.map(([en, es], i) => ({ id: `boh-${i}`, en, es, hours: null, note: '', addedAt: null, addedBy: 'system' })),
            // All sauces from the Sauce Log (src/data/sauces.js). Andrew 2026-06-08.
            ...DEFAULT_SAUCES.map(s => ({ id: `sauce-${s.id}`, en: s.nameEn, es: s.nameEs || s.nameEn, hours: null, note: '', addedAt: null, addedBy: 'system' })),
        ];
        return { pool, days: emptyDays() };
    }
    return { pool: [], days: emptyDays() };
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
// Each day holds COPIES of pool masters — a fresh unique id + a srcId back to the
// master, so one master can sit on many days and each copy is removable on its own.
const copyId = (srcId) => `${srcId}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const isMaster = (b, id) => b.pool.some(i => i.id === id);

// ── Activity log (every move, timestamped + who) ────────────────────
// A rolling, newest-first list lives on the board doc itself (`log`),
// so it syncs with the board and costs no extra reads/writes — each move
// already does a transactional board write. Capped so the hot doc stays
// small; each 💾 Save snapshots the log too, so older history is retained
// inside saved copies. Event = { at, by, action, en?, es?, day?, from?, n? }.
const LOG_CAP = 80;
function pushLog(b, ev) {
    if (!ev) return b;
    b.log = [ev, ...(Array.isArray(b.log) ? b.log : [])].slice(0, LOG_CAP);
    return b;
}
const dayLabel = (key, es) => { const d = DAYS.find(x => x.key === key); return d ? (es ? d.es : d.en) : (key || ''); };
// Build a human, bilingual one-liner for an activity event.
function describeEvent(e, es) {
    if (!e) return '';
    const nm = es ? (e.es || e.en || '') : (e.en || e.es || '');
    const d = e.day ? dayLabel(e.day, es) : '';
    switch (e.action) {
        case 'addDay':     return `${nm} → ${d}`;
        case 'offDay':     return `${nm} ✕ ${d}`;
        case 'move':       return `${nm}: ${e.from ? dayLabel(e.from, es) : '?'} → ${d}`;
        case 'addItem':    return `${es ? 'Agregó' : 'Added'} ${nm}`;
        case 'removeItem': return `${es ? 'Eliminó' : 'Removed'} ${nm}`;
        case 'editItem':   return `${es ? 'Editó' : 'Edited'} ${nm}`;
        case 'dayNote':    return `${es ? 'Nota' : 'Note'} · ${d}`;
        case 'clearDay':   return `${es ? 'Limpió' : 'Cleared'} ${d}${e.n ? ` (${e.n})` : ''}`;
        case 'clearWeek':  return es ? 'Limpió la semana' : 'Cleared the week';
        case 'load':       return es ? 'Cargó una copia guardada' : 'Loaded a saved copy';
        case 'reset':      return es ? 'Restableció el tablero' : 'Reset the board';
        default:           return e.action || '';
    }
}
const actionIcon = (action) => ({
    addDay: '➕', offDay: '➖', move: '🔀', addItem: '🆕', removeItem: '🗑',
    editItem: '✎', dayNote: '📝', clearDay: '🧹', clearWeek: '🧹', load: '📜', reset: '↻',
}[action] || '•');

export default function PrepBoard({ language, staffName, storeLocation, staffList }) {
    const es = language === 'es';
    const tx = (en, esT) => (es ? esT : en);
    const adminUser = isAdmin(staffName, staffList);

    // FOH vs BOH — two independent boards. Defaults to the staff member's own
    // scheduleSide, then remembers the last choice per device.
    const SIDE_KEY = 'ddmau:prepBoard:side';
    const myScheduleSide = (staffList || []).find(s => s.name === staffName)?.scheduleSide;
    const [side, setSide] = useState(() => {
        try { const v = localStorage.getItem(SIDE_KEY); if (v === 'foh' || v === 'boh') return v; } catch (e) { /* ignore */ }
        return myScheduleSide === 'foh' ? 'foh' : 'boh';
    });
    useEffect(() => { try { localStorage.setItem(SIDE_KEY, side); } catch (e) { /* ignore */ } }, [side]);

    const [board, setBoard] = useState(() => buildSeed(side));
    const [selectedId, setSelectedId] = useState(null);
    const [filter, setFilter] = useState('');
    const [addName, setAddName] = useState('');
    const [editTarget, setEditTarget] = useState(null); // {type:'item',id} | {type:'day',key}
    const seededRef = useRef(new Set());
    const migratedRef = useRef(new Set());

    const ref = useMemo(
        () => (storeLocation ? doc(db, 'ops', `prepBoard_${storeLocation}_${side}`) : null),
        [storeLocation, side]
    );

    // ── Live sync + one-time seed (per side) ────────────────────────
    useEffect(() => {
        if (!ref) return;
        // Show this side's seed immediately while the doc loads — avoids a flash
        // of the other side's items when toggling FOH/BOH.
        setBoard(buildSeed(side));
        setSelectedId(null);
        const r = ref;
        const unsub = onSnapshot(r, async (snap) => {
            if (snap.exists() && Array.isArray(snap.data()?.pool)) {
                const data = snap.data();
                setBoard({ pool: data.pool, days: normalizeDays(data.days), log: Array.isArray(data.log) ? data.log : [] });
                // One-time seed-merge: when the seed gains items (e.g. the sauces
                // added in v2), push any that are MISSING into an already-seeded
                // board without disturbing the user's existing layout.
                if (side === 'boh' && (data.seedVersion || 1) < SEED_VERSION && !migratedRef.current.has(r.path)) {
                    migratedRef.current.add(r.path);
                    try {
                        await runTransaction(db, async (t) => {
                            const s = await t.get(r);
                            if (!s.exists() || !Array.isArray(s.data()?.pool)) return;
                            const cur = s.data();
                            if ((cur.seedVersion || 1) >= SEED_VERSION) return; // already merged
                            const days = normalizeDays(cur.days);
                            const seedPool = buildSeed('boh').pool;
                            const seedIds = new Set(seedPool.map(i => i.id));
                            // v3 copy-model migration: a stray day item that IS a seed master
                            // (placed by the old move-model, no srcId) becomes a COPY — tag it
                            // with srcId + a fresh id so the master id is free for the pool.
                            for (const k of DAY_KEYS) {
                                days[k].items = days[k].items.map(it =>
                                    (!it.srcId && seedIds.has(it.id)) ? { ...it, srcId: it.id, id: copyId(it.id) } : it
                                );
                            }
                            // Guarantee every seed master is in the POOL (restores any the old
                            // model had pulled into a day, plus any brand-new seed items).
                            const poolIds = new Set(cur.pool.map(i => i.id));
                            const additions = seedPool.filter(it => !poolIds.has(it.id));
                            t.set(r, { pool: [...cur.pool, ...additions], days, seeded: true, side: 'boh', seedVersion: SEED_VERSION, updatedAt: serverTimestamp(), updatedBy: 'system' });
                        });
                    } catch (e) { console.warn('[prepBoard] seed-merge failed:', e?.message); }
                }
            } else if (!seededRef.current.has(r.path)) {
                seededRef.current.add(r.path);
                try {
                    await runTransaction(db, async (t) => {
                        const s = await t.get(r);
                        if (s.exists() && Array.isArray(s.data()?.pool)) return; // someone else seeded
                        t.set(r, { ...buildSeed(side), seeded: true, side, seedVersion: SEED_VERSION, updatedAt: serverTimestamp(), updatedBy: staffName || 'system' });
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
                    ? { pool: s.data().pool, days: normalizeDays(s.data().days), log: Array.isArray(s.data().log) ? s.data().log : [] }
                    : { ...buildSeed(side), log: [] };
                const next = mutator(clone(base));
                if (!next) return;
                t.set(ref, { pool: next.pool, days: next.days, log: Array.isArray(next.log) ? next.log.slice(0, LOG_CAP) : [], seeded: true, side, updatedAt: serverTimestamp(), updatedBy: staffName || '' });
            });
        } catch (e) {
            console.warn('[prepBoard] write failed:', e?.message);
            toast(tx('Could not save — try again', 'No se pudo guardar — intenta de nuevo'), { kind: 'error' });
        }
    };

    // ── Mutators ────────────────────────────────────────────────────
    // Clearing a day drops its copies (the master stays on the list), but RESCUES
    // any item with no surviving master back to the pool (legacy/orphan items from
    // the old move-model) so nothing is ever lost.
    const dropOrRescue = (b, it) => {
        const masterAlive = (it.srcId && b.pool.some(p => p.id === it.srcId)) || b.pool.some(p => p.id === it.id);
        if (!masterAlive) { const m = { ...it }; delete m.srcId; b.pool.push(m); }
    };
    // Build a stamped activity event. Computed ONCE per action (outside
    // writeBoard) so the optimistic + transaction passes log the SAME event —
    // the Firestore doc ends up with exactly one copy. `at`/`by` always set;
    // pass { en, es, day, from, n } as relevant.
    const ev = (action, extra = {}) => ({ at: Date.now(), by: staffName || '', action, ...extra });

    // MOVE a day-copy to another day (logs the from→to).
    const moveToDay = (id, dayKey) => {
        const it = findItem(board, id);
        const from = DAY_KEYS.find(k => board.days[k].items.some(i => i.id === id)) || null;
        const event = it ? ev('move', { en: it.en, es: it.es, day: dayKey, from }) : null;
        writeBoard(b => { const item = pluck(b, id); if (item) { b.days[dayKey].items.push(item); pushLog(b, event); } return b; });
    };
    // COPY a pool master into a day (master stays on the list → multi-day prep).
    // Re-tapping the same day toggles the copy OFF. The id + event are generated
    // ONCE here so the optimistic + transaction passes write the same values.
    const toggleCopyInDay = (masterId, dayKey) => {
        const newId = copyId(masterId);
        const stamp = Date.now();
        const master = board.pool.find(i => i.id === masterId);
        const already = board.days[dayKey].items.some(i => i.srcId === masterId || i.id === masterId);
        const event = { at: stamp, by: staffName || '', action: already ? 'offDay' : 'addDay', en: master?.en || '', es: master?.es || '', day: dayKey };
        writeBoard(b => {
            const day = b.days[dayKey];
            const at = day.items.findIndex(i => i.srcId === masterId || i.id === masterId);
            if (at >= 0) { day.items.splice(at, 1); pushLog(b, event); return b; }            // toggle off
            const m = b.pool.find(i => i.id === masterId);
            if (!m) return b;
            day.items.push({ ...clone(m), id: newId, srcId: masterId, addedAt: stamp, addedBy: staffName || '' });
            pushLog(b, event);
            return b;
        });
    };
    const clearDay = (dayKey) => {
        const event = ev('clearDay', { day: dayKey, n: board.days[dayKey]?.items.length || 0 });
        writeBoard(b => { for (const it of b.days[dayKey].items) dropOrRescue(b, it); b.days[dayKey].items = []; pushLog(b, event); return b; });
    };
    // Deleting a POOL master also purges every day-copy of it; deleting a day-copy
    // just removes that one.
    const removeItem = (id) => {
        const it = findItem(board, id);
        const event = it ? ev('removeItem', { en: it.en, es: it.es }) : null;
        writeBoard(b => {
            const wasMaster = isMaster(b, id);
            pluck(b, id);
            if (wasMaster) for (const k of DAY_KEYS) b.days[k].items = b.days[k].items.filter(i => i.srcId !== id);
            pushLog(b, event);
            return b;
        });
    };
    // Editing a POOL master propagates the bilingual name to its day-copies
    // (hours / notes stay per-day).
    const updateItem = (id, patch) => {
        const cur = findItem(board, id);
        const event = cur ? ev('editItem', { en: patch.en || cur.en, es: patch.es || cur.es }) : null;
        writeBoard(b => {
            const it = findItem(b, id); if (!it) return b;
            Object.assign(it, patch);
            if (isMaster(b, id)) for (const k of DAY_KEYS) b.days[k].items.forEach(c => { if (c.srcId === id) { c.en = it.en; c.es = it.es; } });
            pushLog(b, event);
            return b;
        });
    };
    const setDayNote = (dayKey, note) => {
        const event = ev('dayNote', { day: dayKey });
        writeBoard(b => { b.days[dayKey].note = note; pushLog(b, event); return b; });
    };
    const addPrep = (name) => {
        const nm = (name || '').trim();
        if (!nm) return;
        const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const event = ev('addItem', { en: nm, es: nm });
        writeBoard(b => { b.pool.push({ id, en: nm, es: nm, hours: null, note: '', addedAt: Date.now(), addedBy: staffName || '' }); pushLog(b, event); return b; });
        setAddName('');
    };
    const resetBoard = () => {
        const msg = side === 'boh'
            ? tx('Reset Back-of-House to the default kitchen list? This clears every day.', '¿Restablecer Cocina a la lista predeterminada? Esto borra cada día.')
            : tx('Clear the whole Front-of-House board? This removes every item and day.', '¿Borrar todo el tablero de Frente? Esto elimina cada artículo y día.');
        if (!confirm(msg)) return;
        setSelectedId(null);
        const event = ev('reset');
        writeBoard(() => { const seed = buildSeed(side); seed.log = [event]; return seed; });
    };

    // ── Selection ───────────────────────────────────────────────────
    const selectedItem = findItem(board, selectedId);
    const selectedDayKey = DAY_KEYS.find(k => board.days[k].items.some(i => i.id === selectedId)) || null;
    const selectedIsMaster = !!selectedItem && isMaster(board, selectedId);
    const toggleSelect = (id) => setSelectedId(prev => (prev === id ? null : id));
    // Tap a day with something selected: a POOL master COPIES into that day and
    // STAYS selected (so you can tap more days for a multi-day prep); a DAY-copy
    // MOVES to the tapped day.
    const assignToDay = (dayKey) => {
        if (!selectedId) return;
        if (selectedIsMaster) { toggleCopyInDay(selectedId, dayKey); }
        else { moveToDay(selectedId, dayKey); setSelectedId(null); }
    };
    // Take a selected day-copy off its day (the master stays on the list).
    const returnToList = () => { if (selectedId && selectedDayKey) { removeItem(selectedId); setSelectedId(null); } };

    const filteredPool = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q) return board.pool;
        return board.pool.filter(it => (it.en || '').toLowerCase().includes(q) || (it.es || '').toLowerCase().includes(q));
    }, [board.pool, filter]);

    const weekHours = useMemo(() => DAY_KEYS.reduce((a, k) => a + sumHours(board.days[k].items), 0), [board]);

    // ── Save → history · Clear week · History viewer ────────────────
    // Saved copies live in a SEPARATE doc (ops/prepBoard_{loc}_{side}_hist)
    // so they don't bloat the hot board doc; read on demand, written on Save.
    const [historyOpen, setHistoryOpen] = useState(false);
    const [history, setHistory] = useState([]);
    const histRef = useMemo(
        () => (storeLocation ? doc(db, 'ops', `prepBoard_${storeLocation}_${side}_hist`) : null),
        [storeLocation, side]
    );
    useEffect(() => {
        if (!histRef) return;
        const unsub = onSnapshot(histRef, (snap) => {
            const saves = (snap.exists() && Array.isArray(snap.data()?.saves)) ? snap.data().saves : [];
            setHistory(saves);
        }, () => {});
        return () => unsub();
    }, [histRef]);

    const [viewSnap, setViewSnap] = useState(null);   // saved copy open in the read-only viewer
    const saveSnapshot = async () => {
        if (!histRef) return;
        // Snapshot the move log too, so each saved copy retains the activity
        // trail up to that moment (older than the rolling LOG_CAP on the board).
        const snapshot = { savedAt: Date.now(), savedBy: staffName || '', pool: clone(board.pool), days: clone(board.days), weekHours, log: clone(board.log || []) };
        try {
            await runTransaction(db, async (t) => {
                const s = await t.get(histRef);
                const prev = (s.exists() && Array.isArray(s.data()?.saves)) ? s.data().saves : [];
                t.set(histRef, { saves: [snapshot, ...prev].slice(0, 20), location: storeLocation || '', side });
            });
            toast(tx('Saved a copy to history ✓', 'Copia guardada en historial ✓'));
        } catch (e) {
            console.warn('[prepBoard] save failed:', e?.message);
            toast(tx('Save failed — try again', 'Error al guardar'), { kind: 'error' });
        }
    };
    const clearWeek = () => {
        if (!confirm(tx('Clear all days? Your prep list stays — only the day assignments are removed. Save first if you want a copy.', '¿Limpiar todos los días? Tu lista de prep permanece — solo se quitan las asignaciones. Guarda primero si quieres una copia.'))) return;
        setSelectedId(null);
        const event = ev('clearWeek');
        writeBoard(b => { for (const k of DAY_KEYS) { for (const it of b.days[k].items) dropOrRescue(b, it); b.days[k] = { items: [], note: '' }; } pushLog(b, event); return b; });
    };
    const restoreSnapshot = (snap) => {
        if (!confirm(tx('Load this saved copy? It replaces the current board (the saved copy is kept).', '¿Cargar esta copia? Reemplaza el tablero actual (la copia se conserva).'))) return;
        setSelectedId(null);
        const event = ev('load');
        // Mutate (don't replace) so the live activity log carries forward + records the load.
        writeBoard(b => { b.pool = clone(snap.pool || []); b.days = normalizeDays(snap.days); pushLog(b, event); return b; });
        setHistoryOpen(false);
        setViewSnap(null);
    };

    // ── Print ───────────────────────────────────────────────────────
    // Build the printable HTML for a set of days. opts.savedAt → it's a saved
    // copy (header says "Saved …"); opts.log → append a "Move history" section
    // (used when printing a saved copy so the trail prints too).
    const buildPrepHtml = (days, opts = {}) => {
        const stamp = new Date(opts.savedAt || Date.now());
        const dateStr = stamp.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = stamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const sideLabel = side === 'boh' ? tx('Back of House', 'Cocina') : tx('Front of House', 'Frente');
        const total = DAY_KEYS.reduce((a, k) => a + sumHours(days[k].items), 0);
        const titleWord = opts.savedAt ? tx('Saved Prep', 'Prep Guardado') : tx('Weekly Prep', 'Prep Semanal');
        let html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DD Mau Prep</title><style>
            *{box-sizing:border-box} body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;color:#111}
            h1{font-size:20px;margin:0 0 2px} .date{font-size:11px;color:#666;margin-bottom:12px}
            .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
            .day{border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;break-inside:avoid}
            .day h2{background:#255a37;color:#fff;font-size:13px;margin:0;padding:6px 10px;display:flex;justify-content:space-between;align-items:center}
            .day .note{font-size:10px;color:#555;font-style:italic;padding:4px 10px;border-bottom:1px solid #eee}
            table{width:100%;border-collapse:collapse} td{font-size:12px;padding:4px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top}
            td.h{text-align:right;color:#888;width:42px;white-space:nowrap} td.n{color:#777;font-size:10px;font-style:italic}
            .empty{font-size:11px;color:#aaa;padding:8px 10px}
            h2.logh{font-size:14px;margin:18px 0 6px;border-top:2px solid #255a37;padding-top:10px}
            table.logt td{font-size:11px} td.lt{color:#666;white-space:nowrap;width:120px} td.lb{color:#255a37;font-weight:bold;text-align:right;white-space:nowrap}
            .no-print{position:sticky;top:0;background:#255a37;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)}
            .no-print button{padding:10px 20px;font-size:15px;font-weight:bold;border:none;border-radius:8px;margin:0 6px;cursor:pointer}
            .btn-print{background:#fff;color:#255a37} .btn-close{background:#ef4444;color:#fff}
            @media print{.no-print{display:none!important} .day h2{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
        </style></head><body>`;
        html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://app.ddmaustl.com/'}},300)">✕ ${esc(tx('Close', 'Cerrar'))}</button><button class="btn-print" onclick="window.print()">🖨️ ${esc(tx('Print', 'Imprimir'))}</button></div>`;
        html += `<h1>${esc(titleWord)} · ${esc(sideLabel)} — ${esc(storeLocation || '')}</h1>`;
        html += `<div class="date">${opts.savedAt ? esc(tx('Saved', 'Guardado')) + ': ' : ''}${esc(dateStr)} · ${esc(timeStr)} · ${esc(tx('Total', 'Total'))}: ${fmtHrs(total)}h</div>`;
        html += `<div class="grid">`;
        for (const day of DAYS) {
            const d = days[day.key];
            const dayTotal = sumHours(d.items);
            html += `<div class="day"><h2><span>${esc(tx(day.en, day.es))}</span><span>${d.items.length} · ${fmtHrs(dayTotal)}h</span></h2>`;
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
        html += `</div>`;   // close grid
        if (Array.isArray(opts.log) && opts.log.length > 0) {
            html += `<h2 class="logh">${esc(tx('Move history', 'Historial de movimientos'))}</h2><table class="logt">`;
            for (const e of opts.log) {
                const when = (() => { try { return new Date(e.at).toLocaleString(es ? 'es' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } })();
                html += `<tr><td class="lt">${esc(when)}</td><td>${esc(actionIcon(e.action))} ${esc(describeEvent(e, es))}</td><td class="lb">${esc(e.by || '')}</td></tr>`;
            }
            html += `</table>`;
        }
        html += `</body></html>`;
        return html;
    };
    const printPrepHtml = (html, name) => {
        if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, name); return; }
        const w = window.open('', '_blank');
        if (!w) { toast(tx('Please allow pop-ups to print.', 'Permita ventanas emergentes para imprimir.')); return; }
        w.document.write(html); w.document.close(); w.print();
    };
    const printWeek = () => printPrepHtml(buildPrepHtml(board.days), 'DD Mau Prep Week');
    const printSnapshot = (snap) => printPrepHtml(buildPrepHtml(normalizeDays(snap.days), { savedAt: snap.savedAt, log: snap.log || [] }), 'DD Mau Prep (saved)');

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
        // Master selected AND already scheduled on this day → tapping toggles it off.
        const hasSelected = selectedIsMaster && d.items.some(i => i.srcId === selectedId || i.id === selectedId);
        return (
            <div key={day.key} className="rounded-xl border border-dd-line bg-dd-surface overflow-hidden">
                <button type="button" onClick={() => assignToDay(day.key)} disabled={!selectedId}
                    className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left transition ${hasSelected ? 'bg-dd-green/20 ring-1 ring-inset ring-dd-green/60' : isTarget ? 'bg-dd-green/10 ring-1 ring-inset ring-dd-green/40' : 'bg-dd-bg/40'}`}>
                    <span className="font-black text-[13px] text-dd-text">{tx(day.en, day.es)}</span>
                    <span className="text-[10px] font-bold text-dd-text-2 flex items-center gap-1.5">
                        <span>{d.items.length}</span>
                        {total > 0 && <span className="text-dd-green">{fmtHrs(total)}h</span>}
                        {hasSelected ? <span className="text-dd-green">✓ {tx('on · tap off', 'sí · quitar')}</span>
                            : isTarget ? <span className="text-dd-green">+ {tx('add', 'agregar')}</span> : null}
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
            {/* Header — FOH/BOH side toggle + actions */}
            <div className="flex items-center justify-between gap-2 mb-1">
                <div className="inline-flex rounded-lg border border-dd-line overflow-hidden text-[11px] font-black shrink-0">
                    <button type="button" onClick={() => setSide('boh')}
                        className={`px-3 py-1 ${side === 'boh' ? 'bg-dd-green text-white' : 'bg-white text-dd-text-2'}`}>BOH</button>
                    <button type="button" onClick={() => setSide('foh')}
                        className={`px-3 py-1 border-l border-dd-line ${side === 'foh' ? 'bg-dd-green text-white' : 'bg-white text-dd-text-2'}`}>FOH</button>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {weekHours > 0 && <span className="text-[10px] font-bold text-dd-green">{fmtHrs(weekHours)}h/{tx('wk', 'sem')}</span>}
                    <button type="button" onClick={printWeek} className="glass-button-apple !px-2.5 !py-1.5 !text-xs">🖨 {tx('Print', 'Imprimir')}</button>
                    {adminUser && <button type="button" onClick={resetBoard} title={tx('Reset / clear this side', 'Restablecer este lado')} className="text-sm font-bold text-dd-text-2 hover:text-red-600 px-1">↻</button>}
                </div>
            </div>
            {/* Save / Clear / History toolbar */}
            <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                <button type="button" onClick={saveSnapshot}
                    className="text-[12px] font-bold px-3 py-1.5 rounded-lg bg-dd-green text-white">💾 {tx('Save', 'Guardar')}</button>
                <button type="button" onClick={clearWeek}
                    className="text-[12px] font-bold px-3 py-1.5 rounded-lg bg-white border border-dd-line text-dd-text">🧹 {tx('Clear', 'Limpiar')}</button>
                <button type="button" onClick={() => setHistoryOpen(true)}
                    className="text-[12px] font-bold px-3 py-1.5 rounded-lg bg-white border border-dd-line text-dd-text">📜 {tx('History', 'Historial')}{history.length > 0 ? ` (${history.length})` : ''}</button>
            </div>
            <div className="text-[11px] text-dd-text-2 font-semibold mb-2">
                {side === 'foh' && board.pool.length === 0 && DAY_KEYS.every(k => board.days[k].items.length === 0)
                    ? tx('Front of House is empty — tap "+ write in prep" to add items.', 'Frente está vacío — toca "+ escribir prep" para agregar.')
                    : tx('Tap a prep, then tap each day to schedule it — it stays on the list.', 'Toca un prep, luego cada día — permanece en la lista.')}
            </div>

            {/* Selection action bar */}
            {selectedItem && (
                <div className="sticky top-0 z-10 mb-2 rounded-xl border border-dd-green bg-dd-green/10 px-2.5 py-2 flex items-center gap-2 flex-wrap backdrop-blur">
                    <span className="text-[12px] font-bold text-dd-text flex-1 min-w-0 break-words">
                        {selectedIsMaster
                            ? <>{tx('Adding', 'Agregando')}: {es ? (selectedItem.es || selectedItem.en) : selectedItem.en} <span className="font-normal text-dd-text-2">— {tx('tap each day', 'toca cada día')}</span></>
                            : <>{tx('Moving', 'Moviendo')}: {es ? (selectedItem.es || selectedItem.en) : selectedItem.en}</>}
                    </span>
                    {selectedDayKey && (
                        <button type="button" onClick={returnToList} className="text-[11px] font-bold px-2 py-1 rounded-lg bg-white border border-dd-line text-red-600">✕ {tx('Off day', 'Quitar')}</button>
                    )}
                    <button type="button" onClick={() => setEditTarget({ type: 'item', id: selectedId })} className="text-[11px] font-bold px-2 py-1 rounded-lg bg-white border border-dd-line">✎</button>
                    <button type="button" onClick={() => setSelectedId(null)} className="text-[11px] font-bold px-2 py-1 rounded-lg bg-white border border-dd-line">{tx('Done', 'Listo')}</button>
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
                            className="w-full text-[11px] font-bold text-red-600 bg-red-50 ring-1 ring-inset ring-red-200 py-1.5">
                            ✕ {tx('Tap to take this off the day', 'Quitar del día')}
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
                            ? <div className="text-[11px] text-dd-text-2 text-center py-3">{filter ? tx('No match.', 'Sin coincidencias.') : tx('Nothing here yet.', 'Nada aquí todavía.')}</div>
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

            {historyOpen && (
                <PrepHistoryModal
                    saves={history}
                    liveLog={board.log || []}
                    language={language}
                    onRestore={restoreSnapshot}
                    onView={(snap) => setViewSnap(snap)}
                    onClose={() => setHistoryOpen(false)}
                />
            )}

            {viewSnap && (
                <PrepSnapshotViewer
                    snap={viewSnap}
                    language={language}
                    onLoad={restoreSnapshot}
                    onPrint={printSnapshot}
                    onClose={() => setViewSnap(null)}
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
                        {item.addedBy && item.addedBy !== 'system' && (
                            <div className="text-[10px] text-dd-text-2 pt-0.5">
                                {tx('Added by', 'Agregado por')} <b>{item.addedBy}</b>{item.addedAt ? ` · ${new Date(item.addedAt).toLocaleDateString()}` : ''}
                            </div>
                        )}
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

// ── History modal — two tabs: saved copies (View / Load) + the live
//    activity feed (every move, stamped time + who). ──────────────────
function PrepHistoryModal({ saves, liveLog, language, onRestore, onView, onClose }) {
    const es = language === 'es';
    const tx = (en, esT) => (es ? esT : en);
    const [tab, setTab] = useState('saves');
    const fmt = (ms) => { try { return new Date(ms).toLocaleString(es ? 'es' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
    const scheduled = (snap) => DAY_KEYS.reduce((a, k) => a + ((snap?.days?.[k]?.items?.length) || 0), 0);
    const log = Array.isArray(liveLog) ? liveLog : [];
    const TabBtn = ({ id, children }) => (
        <button onClick={() => setTab(id)}
            className={`flex-1 text-[12px] font-bold px-3 py-1.5 rounded-lg transition ${tab === id ? 'bg-dd-green text-white' : 'bg-dd-bg text-dd-text-2'}`}>
            {children}
        </button>
    );
    return (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4" onClick={onClose}>
            <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl p-4 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}
                style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom,0px))' }}>
                <div className="flex items-center justify-between mb-3">
                    <h3 className="font-black text-base">📜 {tx('History', 'Historial')}</h3>
                    <button onClick={onClose} className="text-sm font-bold px-2 py-1 rounded-lg bg-dd-bg text-dd-text-2">✕</button>
                </div>
                <div className="flex gap-1.5 mb-3">
                    <TabBtn id="saves">{tx('Saved copies', 'Copias')}{saves?.length ? ` (${saves.length})` : ''}</TabBtn>
                    <TabBtn id="activity">{tx('Activity', 'Actividad')}{log.length ? ` (${log.length})` : ''}</TabBtn>
                </div>

                {tab === 'saves' ? (
                    (!saves || saves.length === 0) ? (
                        <div className="text-sm text-dd-text-2 text-center py-6">{tx('No saved copies yet. Tap 💾 Save to keep one.', 'Sin copias. Toca 💾 Guardar para crear una.')}</div>
                    ) : (
                        <div className="space-y-2">
                            {saves.map((snap, i) => (
                                <div key={i} className="flex items-center gap-2 rounded-xl border border-dd-line px-3 py-2">
                                    <button onClick={() => onView(snap)} className="flex-1 min-w-0 text-left">
                                        <div className="text-sm font-bold text-dd-text">{fmt(snap.savedAt)}</div>
                                        <div className="text-[11px] text-dd-text-2 truncate">
                                            {snap.savedBy || tx('Unknown', 'Desconocido')} · {scheduled(snap)} {tx('scheduled', 'programados')}{typeof snap.weekHours === 'number' && snap.weekHours > 0 ? ` · ${Number.isInteger(snap.weekHours) ? snap.weekHours : snap.weekHours.toFixed(1)}h` : ''}
                                        </div>
                                    </button>
                                    <button onClick={() => onView(snap)} className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-white border border-dd-line text-dd-text shrink-0">👁 {tx('View', 'Ver')}</button>
                                    <button onClick={() => onRestore(snap)} className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-dd-green text-white shrink-0">{tx('Load', 'Cargar')}</button>
                                </div>
                            ))}
                        </div>
                    )
                ) : (
                    log.length === 0 ? (
                        <div className="text-sm text-dd-text-2 text-center py-6">{tx('No moves recorded yet. Every change shows here with who & when.', 'Sin movimientos. Cada cambio aparece aquí con quién y cuándo.')}</div>
                    ) : (
                        <div className="space-y-1">
                            {log.map((e, i) => (
                                <div key={i} className="flex items-start gap-2 rounded-lg border border-dd-line/70 px-2.5 py-1.5">
                                    <span className="text-[13px] leading-none mt-0.5 shrink-0">{actionIcon(e.action)}</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] font-semibold text-dd-text leading-tight break-words">{describeEvent(e, es)}</div>
                                        <div className="text-[10px] text-dd-text-2">{fmt(e.at)} · {e.by || tx('Unknown', 'Desconocido')}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )
                )}
            </div>
        </div>
    );
}

// ── Snapshot viewer — open a saved copy read-only: look through every
//    day, then Print or Load. The "new window" Andrew asked for. ───────
function PrepSnapshotViewer({ snap, language, onLoad, onPrint, onClose }) {
    const es = language === 'es';
    const tx = (en, esT) => (es ? esT : en);
    const fmt = (ms) => { try { return new Date(ms).toLocaleString(es ? 'es' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } };
    const days = normalizeDays(snap.days);
    const pool = Array.isArray(snap.pool) ? snap.pool : [];
    const log = Array.isArray(snap.log) ? snap.log : [];
    const total = DAY_KEYS.reduce((a, k) => a + sumHours(days[k].items), 0);
    return (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4" onClick={onClose}>
            <div className="w-full sm:max-w-2xl bg-white rounded-t-2xl sm:rounded-2xl flex flex-col max-h-[92vh] overflow-hidden" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="px-4 py-3 bg-dd-green text-white flex items-center justify-between shrink-0">
                    <div className="min-w-0">
                        <div className="font-black text-base truncate">📋 {tx('Saved prep', 'Prep guardado')}</div>
                        <div className="text-[11px] opacity-90 truncate">
                            {fmt(snap.savedAt)} · {snap.savedBy || tx('Unknown', 'Desconocido')} · {total > 0 ? `${fmtHrs(total)}h` : '—'}
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 font-black shrink-0">✕</button>
                </div>

                {/* Scrollable body — all days + the pool + the move history */}
                <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-dd-bg/30">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {DAYS.map(day => {
                            const d = days[day.key];
                            const t = sumHours(d.items);
                            return (
                                <div key={day.key} className="rounded-xl border border-dd-line bg-white overflow-hidden">
                                    <div className="px-2.5 py-1.5 bg-dd-green/10 border-b border-dd-line flex items-center justify-between">
                                        <span className="font-black text-[12px] text-dd-text">{tx(day.en, day.es)}</span>
                                        <span className="text-[10px] font-bold text-dd-text-2">{d.items.length}{t > 0 ? ` · ${fmtHrs(t)}h` : ''}</span>
                                    </div>
                                    {d.note && <div className="px-2.5 py-1 text-[11px] italic text-dd-text-2 border-b border-dd-line/60">📝 {d.note}</div>}
                                    <div className="p-1.5">
                                        {d.items.length === 0
                                            ? <div className="text-[11px] text-dd-text-2 text-center py-1.5">—</div>
                                            : d.items.map((it, i) => (
                                                <div key={i} className="flex items-center gap-1.5 text-[12px] py-0.5">
                                                    <span className="flex-1 min-w-0 break-words">{es ? (it.es || it.en) : it.en}</span>
                                                    {itemHours(it) > 0 && <span className="text-[10px] font-bold text-dd-green shrink-0">{fmtHrs(itemHours(it))}h</span>}
                                                    {it.note && <span className="text-[10px]" title={it.note}>📝</span>}
                                                </div>
                                            ))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <div className="rounded-xl border border-dd-line bg-white p-2.5">
                        <div className="text-[11px] font-black uppercase tracking-wide text-dd-text-2 mb-1">{tx('Prep list', 'Lista de prep')} ({pool.length})</div>
                        <div className="flex flex-wrap gap-1">
                            {pool.length === 0
                                ? <span className="text-[11px] text-dd-text-2">—</span>
                                : pool.map((it, i) => (
                                    <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-dd-bg border border-dd-line">{es ? (it.es || it.en) : it.en}</span>
                                ))}
                        </div>
                    </div>

                    {log.length > 0 && (
                        <div className="rounded-xl border border-dd-line bg-white p-2.5">
                            <div className="text-[11px] font-black uppercase tracking-wide text-dd-text-2 mb-1">{tx('Move history', 'Historial de movimientos')} ({log.length})</div>
                            <div className="space-y-0.5 max-h-48 overflow-y-auto">
                                {log.map((e, i) => (
                                    <div key={i} className="flex items-start gap-1.5 text-[11px] py-0.5 border-b border-dd-line/40 last:border-0">
                                        <span className="leading-none mt-0.5 shrink-0">{actionIcon(e.action)}</span>
                                        <span className="flex-1 min-w-0 break-words">{describeEvent(e, es)}</span>
                                        <span className="text-dd-text-2 whitespace-nowrap shrink-0">{fmt(e.at)} · {e.by || ''}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer actions */}
                <div className="border-t border-dd-line p-3 flex items-center gap-2 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-lg bg-dd-bg text-dd-text-2 font-bold text-sm">{tx('Close', 'Cerrar')}</button>
                    <div className="flex-1" />
                    <button onClick={() => onPrint(snap)} className="px-4 py-2 rounded-lg bg-white border border-dd-line text-dd-text font-bold text-sm">🖨 {tx('Print', 'Imprimir')}</button>
                    <button onClick={() => onLoad(snap)} className="px-4 py-2 rounded-lg bg-dd-green text-white font-bold text-sm">{tx('Load', 'Cargar')}</button>
                </div>
            </div>
        </div>
    );
}
