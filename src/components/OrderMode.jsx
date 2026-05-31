// Order Mode — full-screen workflow for placing real vendor orders.
//
// Opened from the cart modal via a "📞 Place order" button. The cart
// payload becomes the starting item list; from here the manager:
//   1. Toggles a vendor at the top — every check-off becomes
//      attributed to that vendor
//   2. Walks the item list with the vendor on the phone
//   3. ✓ marks an item ordered, 🚫 marks out-of-stock, ✎ takes a note
//      ("only 5 available"), can edit qty if vendor doesn't have full
//   4. Toggles a different vendor to attribute remaining items
//   5. Hits Submit → creates an immutable /order_logs row + closes
//      the session
//
// Multi-device safe: the session lives in Firestore, so two managers
// can co-pilot from different devices (rare but supported).

import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import {
    ITEM_STATUS, ORDER_STATUS,
    createOrderSession,
    subscribeOpenSession,
    updateSessionItem,
    splitItemForPartial,
    setCurrentVendor,
    submitSession,
    cancelSession,
    subscribeVendorConfig,
    addVendorName,
    removeVendorName,
    renameVendorName,
    deriveVendorsFromInventory,
} from '../data/orderSession';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

export default function OrderMode({
    language = 'en',
    storeLocation,
    staffName,
    customInventory,
    cartItems,                // [{ id, name, qty, category, pack, ... }]
    onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [session, setSession] = useState(null);
    const [creating, setCreating] = useState(false);
    const [showVendorEditor, setShowVendorEditor] = useState(false);
    const [configVendors, setConfigVendors] = useState([]);

    // Subscribe to the open session for this location.
    useEffect(() => {
        if (!storeLocation) return;
        return subscribeOpenSession(storeLocation, setSession);
    }, [storeLocation]);

    // Subscribe to admin-curated vendor list.
    useEffect(() => subscribeVendorConfig(setConfigVendors), []);

    // Combined vendor list — admin additions + derived from inventory.
    const vendorList = useMemo(() => {
        const derived = deriveVendorsFromInventory(customInventory);
        const all = new Set([...derived, ...configVendors]);
        return Array.from(all).sort((a, b) => a.localeCompare(b));
    }, [customInventory, configVendors]);

    // First-time entry: if no open session, offer to start one from
    // the cart payload.
    const startSession = async () => {
        if (creating) return;
        setCreating(true);
        try {
            await createOrderSession({
                storeLocation,
                cartItems: cartItems || [],
                createdBy: staffName || 'admin',
            });
        } catch (e) {
            console.error('createOrderSession failed:', e);
            toast(tx('Could not start order', 'No se pudo iniciar el pedido'), { kind: 'error' });
        } finally {
            setCreating(false);
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[55] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-3">
            <div className="bg-white w-full sm:max-w-3xl max-h-[100dvh] sm:max-h-[95vh] sm:rounded-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="bg-amber-600 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">📞</span>
                        <div>
                            <div className="font-black text-sm sm:text-base">
                                {tx('Order mode', 'Modo pedido')}
                            </div>
                            <div className="text-[11px] opacity-90">
                                {storeLocation === 'webster' ? 'Webster' : storeLocation === 'maryland' ? 'Maryland Heights' : storeLocation}
                                {session ? ` · ${Object.keys(session.items || {}).length} ${tx('items', 'artículos')}` : ''}
                            </div>
                        </div>
                    </div>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full bg-white/20 hover:bg-white/30 transition flex items-center justify-center font-bold">✕</button>
                </div>

                {!session && (
                    <StartScreen
                        tx={tx}
                        cartCount={(cartItems || []).length}
                        creating={creating}
                        onStart={startSession}
                        onClose={onClose}
                    />
                )}

                {session && (
                    <SessionView
                        session={session}
                        tx={tx}
                        isEs={isEs}
                        staffName={staffName}
                        vendorList={vendorList}
                        onOpenVendorEditor={() => setShowVendorEditor(true)}
                        onClose={onClose}
                    />
                )}

                {showVendorEditor && (
                    <VendorEditor
                        tx={tx}
                        configVendors={configVendors}
                        derivedVendors={deriveVendorsFromInventory(customInventory)}
                        staffName={staffName}
                        onClose={() => setShowVendorEditor(false)}
                    />
                )}
            </div>
        </div>
        </ModalPortal>
    );
}

// ── Start screen ─────────────────────────────────────────────────────
function StartScreen({ tx, cartCount, creating, onStart, onClose }) {
    return (
        <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
            <div className="text-5xl mb-3">📞</div>
            <h3 className="text-lg font-black text-dd-text mb-2">
                {tx('Start an order session', 'Iniciar pedido')}
            </h3>
            <p className="text-sm text-dd-text-2 mb-4 max-w-sm">
                {tx(
                    'Walks you through the cart while you are on the phone with a vendor. Check off what you ordered, mark out-of-stocks, add notes. Submit when done — every item is timestamped and saved to the order log.',
                    'Te guía por el carrito mientras hablas con el proveedor. Marca lo que pediste, lo agotado, añade notas. Al enviar, todo queda registrado con hora.',
                )}
            </p>
            <p className="text-sm font-bold text-dd-text mb-3">
                {tx(`${cartCount} items in your cart`, `${cartCount} artículos en el carrito`)}
            </p>
            <div className="flex gap-2 w-full max-w-xs">
                <button onClick={onClose}
                    className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-700 font-bold text-sm">
                    {tx('Cancel', 'Cancelar')}
                </button>
                <button onClick={onStart}
                    disabled={creating || cartCount === 0}
                    className="flex-1 py-3 rounded-xl bg-amber-600 text-white font-bold text-sm hover:bg-amber-700 disabled:opacity-50">
                    {creating ? tx('Starting…', 'Iniciando…') : tx('Start ordering', 'Empezar')}
                </button>
            </div>
        </div>
    );
}

// ── Session view — vendor toggle + item rows + submit footer ─────────
function SessionView({ session, tx, isEs, staffName, vendorList, onOpenVendorEditor, onClose }) {
    const [submitting, setSubmitting] = useState(false);
    // Status filter — clickable bubbles in the totals strip. 'all'
    // shows everything; clicking a status bubble filters to just that
    // one. Click the active bubble again to clear back to 'all'.
    // (Andrew 2026-05-19 — "I want the bubbles to be clickable so say
    // the partial button is clicked it pulls up all partial".)
    const [statusFilter, setStatusFilter] = useState('all');
    // Partial-qty dialog — opens when admin clicks the Partial button
    // on an item. Captures the actual fulfilled quantity and splits
    // the row (Andrew 2026-05-19 — "wanted 6 but they only have 3 ...
    // in partial I can click 3 and that leaves 3 to be ordered").
    const [partialDialog, setPartialDialog] = useState(null); // { itemId, originalQty }
    // 📋 Plan split-view toggle (Andrew 2026-05-25). Additive — when
    // ON, the item-rows area splits into two columns: existing list
    // on the left, vendor-grouped read-only summary on the right. OFF
    // by default; persists per device.
    const [planVisible, setPlanVisible] = useState(() => {
        try { return localStorage.getItem('ddmau:orderMode:planVisible') === '1'; }
        catch { return false; }
    });
    useEffect(() => {
        try { localStorage.setItem('ddmau:orderMode:planVisible', planVisible ? '1' : '0'); }
        catch { /* private-mode safari — no-op */ }
    }, [planVisible]);
    const sessionId = session.id;
    const currentVendor = session.currentVendor || '';
    const items = session.items || {};

    // Sort items: pending first, then ordered/partial, then OOS at
    // bottom. Within a group, alphabetical by name. Keeps the active
    // work at the top of the list as the manager goes down it.
    const sortedEntries = useMemo(() => {
        const entries = Object.entries(items);
        const rank = (s) => {
            if (s === ITEM_STATUS.PENDING) return 0;
            if (s === ITEM_STATUS.ORDERED) return 1;
            if (s === ITEM_STATUS.PARTIAL) return 2;
            if (s === ITEM_STATUS.OOS)     return 3;
            return 4;
        };
        return entries.sort((a, b) => {
            const ra = rank(a[1].status);
            const rb = rank(b[1].status);
            if (ra !== rb) return ra - rb;
            return (a[1].itemName || '').localeCompare(b[1].itemName || '');
        });
    }, [items]);

    const totals = useMemo(() => {
        let pending = 0, ordered = 0, oos = 0, partial = 0;
        for (const [, it] of Object.entries(items)) {
            if (it.status === ITEM_STATUS.ORDERED) ordered++;
            else if (it.status === ITEM_STATUS.OOS) oos++;
            else if (it.status === ITEM_STATUS.PARTIAL) partial++;
            else pending++;
        }
        return { pending, ordered, oos, partial };
    }, [items]);

    const onToggleVendor = async (v) => {
        await setCurrentVendor({ sessionId, vendor: v === currentVendor ? null : v });
    };

    // Perf-fix 2026-05-22 — Andrew: "very slow" in order mode.
    //
    // Mirror currentVendor + items into refs so the row-level dispatch
    // handler below is STABLE across renders. Without these, the
    // useCallback below would have to depend on currentVendor + items
    // — both of which change on every Firestore snapshot — and every
    // row's memoization would bust every tap. The disabled-state of
    // a row's buttons still depends on currentVendor (legitimate
    // re-render when the user toggles vendor); but typing a note or
    // tapping Ordered on row #5 no longer re-renders rows #1-4.
    const currentVendorRef = useRef(currentVendor);
    const itemsRef = useRef(items);
    useEffect(() => { currentVendorRef.current = currentVendor; }, [currentVendor]);
    useEffect(() => { itemsRef.current = items; }, [items]);

    const applyPartial = async (fulfilledQty) => {
        if (!partialDialog) return;
        const { itemId } = partialDialog;
        try {
            await splitItemForPartial({
                sessionId, itemId,
                fulfilledQty,
                vendor: currentVendorRef.current || null,
                byName: staffName,
            });
            setPartialDialog(null);
        } catch (e) {
            console.error('splitItemForPartial failed:', e);
            toast(tx('Could not save partial', 'No se pudo guardar parcial'), { kind: 'error' });
        }
    };

    // One stable dispatcher for every row action. Passing six separate
    // callback props each render created six new closures per row, which
    // defeated React.memo on OrderItemRow. Now the row only sees one
    // function ref + its own itemId + an item snapshot — memo sticks.
    const handleAction = useCallback(async (itemId, kind, value) => {
        const vendor = currentVendorRef.current || null;
        const liveItems = itemsRef.current;
        switch (kind) {
            case 'ordered':
            case 'oos': {
                // Andrew 2026-05-31 - "say sugar was costco and then you
                // check it turning it to wholesale but that was a mistake.
                // i want to be able to uncheck it and revert it back to
                // its previous vendor choice." Record the vendor we are
                // REPLACING (if any) as prevVendor so the Undo path can
                // restore it. If we are checking for the first time
                // (existing.vendor was null), prevVendor stays as
                // whatever was already there (do not clobber a stash from
                // an earlier round).
                const status = kind === 'ordered' ? ITEM_STATUS.ORDERED : ITEM_STATUS.OOS;
                const existing = liveItems[itemId] || {};
                const prevVendor = (existing.vendor && existing.vendor !== vendor)
                    ? existing.vendor
                    : (existing.prevVendor || null);
                await updateSessionItem({
                    sessionId, itemId, status,
                    vendor, prevVendor,
                    byName: staffName,
                });
                return;
            }
            case 'pending': {
                // Undo path - restore the previous vendor (sugar back to
                // Costco in Andrews example) instead of clearing. If
                // prevVendor was null (item was being checked for the
                // first time), vendor falls back to null and the UI
                // shows preferredVendor as the suggested choice again.
                // Clear prevVendor since we just consumed it.
                const existing = liveItems[itemId] || {};
                await updateSessionItem({
                    sessionId, itemId,
                    status: ITEM_STATUS.PENDING,
                    vendor: existing.prevVendor || null,
                    prevVendor: null,
                    byName: staffName,
                });
                return;
            }
            case 'partial': {
                const orig = liveItems[itemId];
                if (!orig) return;
                setPartialDialog({
                    itemId,
                    originalQty: Number(orig.qty) || 0,
                    itemName: orig.itemName,
                });
                return;
            }
            case 'editQty': {
                const n = Number(value);
                if (!Number.isFinite(n)) return;
                if (n === liveItems[itemId]?.qty) return;
                await updateSessionItem({ sessionId, itemId, qty: n });
                return;
            }
            case 'editNote':
                if (value === (liveItems[itemId]?.note || '')) return;
                await updateSessionItem({ sessionId, itemId, note: value });
                return;
            default:
                return;
        }
    }, [sessionId, staffName]);

    const submit = async () => {
        if (submitting) return;
        if (totals.pending > 0 && !window.confirm(tx(
            `You still have ${totals.pending} pending items. Submit anyway? They will be logged as not-ordered.`,
            `Aún tienes ${totals.pending} pendientes. ¿Enviar de todos modos?`,
        ))) return;
        setSubmitting(true);
        try {
            await submitSession({ sessionId, byName: staffName });
            toast(tx('✓ Order submitted', '✓ Pedido enviado'));
            onClose();
        } catch (e) {
            console.error('submitSession failed:', e);
            toast(tx('Submit failed', 'Error al enviar'), { kind: 'error' });
            setSubmitting(false);
        }
    };

    const cancel = async () => {
        if (!window.confirm(tx(
            'Cancel this order session? Nothing will be saved to the order log.',
            '¿Cancelar el pedido? Nada se guardará en el registro.',
        ))) return;
        try {
            await cancelSession({ sessionId, byName: staffName });
            toast(tx('Cancelled', 'Cancelado'));
            onClose();
        } catch (e) {
            console.error('cancelSession failed:', e);
        }
    };

    const visibleEntries = useMemo(() => (
        statusFilter === 'all'
            ? sortedEntries
            : sortedEntries.filter(([, it]) => it.status === statusFilter)
    ), [sortedEntries, statusFilter]);

    return (
        <>
            {/* Vendor toggle strip — sticky */}
            <div className="border-b border-dd-line bg-dd-bg px-3 py-2 sticky top-0 z-10">
                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                    {tx('Ordering from:', 'Pedido a:')} {currentVendor
                        ? <span className="text-amber-700">{currentVendor}</span>
                        : <span className="text-dd-text-2 italic">{tx('pick a vendor', 'elige un proveedor')}</span>}
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                    {/* 📋 Plan toggle — pinned to the FRONT of the pill row
                        so it doesn't get lost behind the horizontal scroll
                        when the vendor list is long (Andrew 2026-05-26).
                        Splits the items area into the existing list + a
                        vendor-grouped read-only summary on the right.
                        Additive; OFF by default. */}
                    <button
                        onClick={() => setPlanVisible(v => !v)}
                        title={tx('See items grouped by vendor', 'Ver artículos agrupados por proveedor')}
                        className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border transition ${planVisible
                            ? 'bg-dd-green text-white border-dd-green'
                            : 'bg-white text-dd-text-2 border-dd-line hover:border-dd-green'}`}>
                        📋 {tx('Plan', 'Plan')}
                    </button>
                    {vendorList.length === 0 ? (
                        <span className="text-xs text-dd-text-2 italic">
                            {tx('No vendors yet. Add one →', 'Sin proveedores. Añade uno →')}
                        </span>
                    ) : vendorList.map(v => {
                        const sel = v === currentVendor;
                        return (
                            <button key={v} onClick={() => onToggleVendor(v)}
                                className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border transition ${sel
                                    ? 'bg-amber-600 text-white border-amber-700'
                                    : 'bg-white text-dd-text-2 border-dd-line hover:border-amber-300'}`}>
                                {v}
                            </button>
                        );
                    })}
                    <button onClick={onOpenVendorEditor}
                        className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border border-dashed border-dd-line text-dd-text-2 hover:bg-dd-bg">
                        ✏️ {tx('Edit vendors', 'Editar')}
                    </button>
                </div>
            </div>

            {/* Totals strip — every bubble is a clickable filter. Click
                a bubble to show only that status; click again to clear
                back to 'all'. The active bubble inverts colors. */}
            <div className="border-b border-dd-line px-3 py-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <StatusBubble
                    label={tx('All', 'Todos')} emoji="▦"
                    count={totals.pending + totals.ordered + totals.partial + totals.oos}
                    active={statusFilter === 'all'}
                    activeCls="bg-dd-text text-white"
                    inactiveCls="bg-white text-dd-text-2 border border-dd-line"
                    onClick={() => setStatusFilter('all')}
                />
                <StatusBubble
                    label={tx('Pending', 'Pendientes')} emoji="⏳"
                    count={totals.pending}
                    active={statusFilter === ITEM_STATUS.PENDING}
                    activeCls="bg-gray-600 text-white"
                    inactiveCls="bg-gray-100 text-gray-700"
                    onClick={() => setStatusFilter(statusFilter === ITEM_STATUS.PENDING ? 'all' : ITEM_STATUS.PENDING)}
                />
                <StatusBubble
                    label={tx('Ordered', 'Pedidos')} emoji="✓"
                    count={totals.ordered}
                    active={statusFilter === ITEM_STATUS.ORDERED}
                    activeCls="bg-green-700 text-white"
                    inactiveCls="bg-green-100 text-green-700"
                    onClick={() => setStatusFilter(statusFilter === ITEM_STATUS.ORDERED ? 'all' : ITEM_STATUS.ORDERED)}
                />
                <StatusBubble
                    label={tx('Partial', 'Parciales')} emoji="◐"
                    count={totals.partial}
                    active={statusFilter === ITEM_STATUS.PARTIAL}
                    activeCls="bg-amber-600 text-white"
                    inactiveCls="bg-amber-100 text-amber-700"
                    onClick={() => setStatusFilter(statusFilter === ITEM_STATUS.PARTIAL ? 'all' : ITEM_STATUS.PARTIAL)}
                />
                <StatusBubble
                    label={tx('Out', 'Agotados')} emoji="🚫"
                    count={totals.oos}
                    active={statusFilter === ITEM_STATUS.OOS}
                    activeCls="bg-red-700 text-white"
                    inactiveCls="bg-red-100 text-red-700"
                    onClick={() => setStatusFilter(statusFilter === ITEM_STATUS.OOS ? 'all' : ITEM_STATUS.OOS)}
                />
            </div>

            {/* Item rows — wrapped in a flex container so the Plan
                toggle can split this area into two columns (existing
                list on the left, vendor-grouped summary on the right).
                On mobile (<md) the plan panel stacks below the list. */}
            <div className={`flex-1 overflow-hidden ${planVisible
                ? 'flex flex-col md:flex-row md:divide-x md:divide-dd-line'
                : 'block'}`}>
                <div className={`${planVisible ? 'md:w-1/2 min-w-0' : 'w-full'} flex-1 overflow-y-auto`}>
                    {visibleEntries.length === 0 ? (
                        <div className="p-6 text-center text-sm text-dd-text-2 italic">
                            {statusFilter === 'all'
                                ? tx('No items in this session.', 'Sin artículos.')
                                : tx('No items match this filter.', 'Sin artículos en este filtro.')}
                        </div>
                    ) : visibleEntries.map(([itemId, it]) => (
                        <OrderItemRow
                            key={itemId}
                            itemId={itemId}
                            item={it}
                            isEs={isEs}
                            currentVendor={currentVendor}
                            onAction={handleAction}
                        />
                    ))}
                </div>
                {planVisible && (
                    <PlanPanel
                        items={Object.entries(items || {}).map(([id, it]) => ({ ...it, _itemId: id }))}
                        isEs={isEs}
                        currentVendor={currentVendor}
                        onToggleVendor={onToggleVendor}
                        onAction={handleAction}
                    />
                )}
            </div>

            {/* Footer */}
            <div className="border-t border-dd-line bg-white px-3 py-2 flex gap-2 flex-shrink-0">
                <button onClick={cancel}
                    className="px-3 py-2.5 rounded-xl bg-white border-2 border-red-200 text-red-700 text-sm font-bold">
                    🗑 {tx('Cancel', 'Cancelar')}
                </button>
                <button onClick={onClose}
                    className="px-3 py-2.5 rounded-xl bg-gray-100 text-gray-700 text-sm font-bold">
                    {tx('Close (resume later)', 'Cerrar (continuar)')}
                </button>
                <button onClick={submit}
                    disabled={submitting}
                    className="flex-1 px-3 py-2.5 rounded-xl bg-amber-600 text-white text-sm font-black hover:bg-amber-700 disabled:opacity-50">
                    {submitting
                        ? tx('Submitting…', 'Enviando…')
                        : tx(`✓ Submit order (${totals.ordered + totals.partial})`, `✓ Enviar (${totals.ordered + totals.partial})`)}
                </button>
            </div>

            {partialDialog && (
                <PartialQtyDialog
                    tx={tx}
                    itemName={partialDialog.itemName}
                    originalQty={partialDialog.originalQty}
                    currentVendor={currentVendor}
                    onClose={() => setPartialDialog(null)}
                    onSave={applyPartial}
                />
            )}
        </>
    );
}

// ── StatusBubble — clickable filter pill ────────────────────────────
// Used in the totals strip. When active, the bubble inverts to a
// strong status color; when inactive, it's a soft tint. Click again
// to clear back to 'all'.
function StatusBubble({ label, emoji, count, active, activeCls, inactiveCls, onClick }) {
    return (
        <button
            onClick={onClick}
            className={`px-2 py-0.5 rounded font-bold border transition active:scale-95 ${
                active ? `${activeCls} border-transparent` : `${inactiveCls} border-transparent hover:opacity-90`
            }`}
        >
            {emoji} {count} {label}
        </button>
    );
}

// ── PartialQtyDialog ───────────────────────────────────────────────
// Shown when admin clicks the Partial button on a row. Captures the
// actual fulfilled quantity (i.e. how many the vendor really had).
// On save:
//   • 0 → treated as OOS for that vendor (split helper handles this)
//   • >= original → treated as fully ordered (no split)
//   • in-between → original row becomes partial with the fulfilled
//     qty, a new pending remainder row appears at the bottom of the
//     list so admin can try another vendor for the rest
function PartialQtyDialog({ tx, itemName, originalQty, currentVendor, onClose, onSave }) {
    const [qtyDraft, setQtyDraft] = useState(() => String(Math.max(0, originalQty - 1)));
    const [busy, setBusy] = useState(false);
    const parsed = Number(qtyDraft);
    const isValid = Number.isFinite(parsed) && parsed >= 0 && parsed <= originalQty;
    const remaining = isValid ? Math.max(0, originalQty - parsed) : null;

    const save = async () => {
        if (!isValid || busy) return;
        setBusy(true);
        await onSave(parsed);
        // dialog closes via parent on success; if it errored, we
        // re-enable so the user can retry without re-typing.
        setBusy(false);
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-3"
             onClick={onClose}>
            <div className="bg-white w-full sm:max-w-sm p-5 rounded-t-2xl sm:rounded-2xl space-y-3"
                 onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <h3 className="text-base font-black text-dd-text">
                        ◐ {tx('Partial fill', 'Cumplimiento parcial')}
                    </h3>
                    <button onClick={onClose} className="text-2xl text-gray-500 leading-none">×</button>
                </div>
                <p className="text-sm text-dd-text-2 leading-relaxed">
                    <span className="font-bold">{itemName}</span>
                    {currentVendor && (
                        <> · <span className="text-amber-700">{currentVendor}</span></>
                    )}
                    <br />
                    {tx(
                        `You asked for ${originalQty}. How many did they actually have?`,
                        `Pediste ${originalQty}. ¿Cuántos tenían en realidad?`,
                    )}
                </p>
                <div className="flex items-center gap-3">
                    <input
                        type="number"
                        inputMode="decimal"
                        autoFocus
                        value={qtyDraft}
                        onChange={e => setQtyDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && isValid) save(); }}
                        min="0"
                        max={originalQty}
                        className="flex-1 px-3 py-2 text-2xl font-black text-center border-2 border-amber-300 rounded-lg"
                    />
                    <div className="text-xs text-dd-text-2">
                        / {originalQty}
                    </div>
                </div>
                {/* Preview of the resulting split */}
                {isValid && (
                    <div className="bg-dd-bg border border-dd-line rounded-md p-2 text-[11px] leading-relaxed">
                        {parsed === 0 ? (
                            <>🚫 {tx(
                                `Will mark out-of-stock at ${currentVendor || 'this vendor'}.`,
                                `Marcará agotado en ${currentVendor || 'este proveedor'}.`,
                            )}</>
                        ) : parsed >= originalQty ? (
                            <>✓ {tx(
                                `Will mark fully ordered from ${currentVendor || 'this vendor'}.`,
                                `Marcará pedido completo de ${currentVendor || 'este proveedor'}.`,
                            )}</>
                        ) : (
                            <>
                                <div>◐ {tx(`Ordered`, `Pedidos`)} <b>{parsed}</b> {tx(`from ${currentVendor || 'this vendor'}`, `de ${currentVendor || 'este proveedor'}`)}.</div>
                                <div className="text-amber-700">⏳ {tx(`${remaining} remaining`, `${remaining} restantes`)} — {tx('moves to pending so you can try another vendor', 'pasa a pendiente para probar otro proveedor')}.</div>
                            </>
                        )}
                    </div>
                )}
                <div className="flex gap-2 pt-1">
                    <button onClick={onClose} disabled={busy}
                        className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button onClick={save}
                        disabled={!isValid || busy}
                        className="flex-1 py-2 rounded-lg bg-amber-600 text-white text-sm font-black disabled:opacity-40">
                        {busy ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── Item row ────────────────────────────────────────────────────────
//
// Perf-fix 2026-05-22 — Andrew: "very slow" in order mode.
//
// The row is memoized with an explicit field-by-field comparator
// because Firestore deserializes the whole `items` map fresh on every
// onSnapshot tick — meaning even rows whose data didn't change get
// a NEW item reference. Default React.memo (shallow ref compare)
// would bail every render and we'd re-render every row on every
// tap. With this comparator, only rows whose actual field values
// changed re-render.
//
// Props collapsed to a single `onAction(itemId, kind, value?)` so
// the row sees one stable function ref instead of six per-render
// closures — that was the other half of the memo problem. The row
// builds its tiny per-tap closures internally, which is fine because
// the row itself doesn't re-render unless its data changes.
function OrderItemRowInner({ itemId, item, isEs, currentVendor, onAction }) {
    const tx = (en, es) => isEs ? es : en;
    const [noteDraft, setNoteDraft] = useState(item.note || '');
    const [qtyDraft, setQtyDraft] = useState(String(item.qty ?? ''));

    // Sync drafts when the underlying item refreshes from the server.
    useEffect(() => { setNoteDraft(item.note || ''); }, [item.note]);
    useEffect(() => { setQtyDraft(String(item.qty ?? '')); }, [item.qty]);

    const statusBadge = (() => {
        if (item.status === ITEM_STATUS.ORDERED) return { label: tx('Ordered', 'Pedido'), cls: 'bg-green-100 text-green-800 border-green-300', emoji: '✓' };
        if (item.status === ITEM_STATUS.PARTIAL) return { label: tx('Partial', 'Parcial'), cls: 'bg-amber-100 text-amber-800 border-amber-300', emoji: '◐' };
        if (item.status === ITEM_STATUS.OOS)     return { label: tx('Out', 'Agotado'), cls: 'bg-red-100 text-red-800 border-red-300', emoji: '🚫' };
        return { label: tx('Pending', 'Pendiente'), cls: 'bg-gray-100 text-gray-600 border-gray-200', emoji: '⏳' };
    })();

    const isDone = item.status !== ITEM_STATUS.PENDING;

    return (
        <div className={`border-b border-dd-line px-3 py-2 ${isDone ? 'bg-dd-bg/40' : 'bg-white'}`}>
            <div className="flex items-start gap-2">
                {/* Name + meta */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`text-sm font-bold ${isDone ? 'text-dd-text-2 line-through' : 'text-dd-text'}`}>
                            {isEs ? (item.itemNameEs || item.itemName) : item.itemName}
                        </span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${statusBadge.cls}`}>
                            {statusBadge.emoji} {statusBadge.label}
                        </span>
                        {item.vendor && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                                📞 {item.vendor}
                            </span>
                        )}
                    </div>
                    <div className="text-[10px] text-dd-text-2 mt-0.5">
                        {item.category}
                        {item.pack && ` · ${item.pack}`}
                        {item.preferredVendor && ` · pref ${item.preferredVendor}`}
                    </div>
                </div>

                {/* Qty input */}
                <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                    {/* text-base (16px) prevents iOS Safari zoom-on-focus.
                        Cap-readiness 2026-05-31 — was text-sm (14px). */}
                    <input
                        type="number"
                        inputMode="decimal"
                        value={qtyDraft}
                        onChange={e => setQtyDraft(e.target.value)}
                        onBlur={() => onAction(itemId, 'editQty', Number(qtyDraft))}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        className="w-14 text-center px-1 py-0.5 border border-dd-line rounded text-base font-bold"
                    />
                    <div className="text-[9px] text-dd-text-2 uppercase">{tx('qty', 'cant.')}</div>
                </div>
            </div>

            {/* Action buttons */}
            <div className="mt-2 flex gap-1 flex-wrap">
                {item.status === ITEM_STATUS.PENDING ? (
                    <>
                        <button onClick={() => onAction(itemId, 'ordered')}
                            disabled={!currentVendor}
                            title={!currentVendor ? tx('Pick a vendor first', 'Elige un proveedor primero') : ''}
                            className="flex-1 min-w-[70px] py-1.5 rounded-md bg-green-600 text-white text-xs font-bold hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed">
                            ✓ {tx('Ordered', 'Pedido')}
                        </button>
                        <button onClick={() => onAction(itemId, 'partial')}
                            disabled={!currentVendor}
                            className="flex-1 min-w-[70px] py-1.5 rounded-md bg-amber-500 text-white text-xs font-bold hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed">
                            ◐ {tx('Partial', 'Parcial')}
                        </button>
                        <button onClick={() => onAction(itemId, 'oos')}
                            disabled={!currentVendor}
                            className="flex-1 min-w-[70px] py-1.5 rounded-md bg-red-600 text-white text-xs font-bold hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed">
                            🚫 {tx('Out', 'Agotado')}
                        </button>
                    </>
                ) : (
                    <button onClick={() => onAction(itemId, 'pending')}
                        className="px-3 py-1.5 rounded-md bg-white border border-dd-line text-dd-text-2 text-xs font-bold hover:bg-dd-bg">
                        ↺ {tx('Undo', 'Deshacer')}
                    </button>
                )}
            </div>

            {/* Note — useful for any status (e.g. "only 5 available
                so we partially ordered") */}
            <input
                type="text"
                value={noteDraft}
                onChange={e => setNoteDraft(e.target.value)}
                onBlur={() => onAction(itemId, 'editNote', noteDraft)}
                onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                placeholder={tx('Note (e.g. "only 5 available")', 'Nota (ej. "solo 5 disponibles")')}
                className="w-full mt-1.5 px-2 py-1 border border-dd-line rounded text-xs"
            />

            {item.checkedAt && (
                <div className="text-[9px] text-dd-text-2 mt-1">
                    {tx('Logged', 'Registrado')}: {item.checkedAt.toDate
                        ? item.checkedAt.toDate().toLocaleString(isEs ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' })
                        : '—'}
                    {item.checkedBy && ` · ${item.checkedBy}`}
                </div>
            )}
        </div>
    );
}

// Custom equality for OrderItemRow — compares the fields the row
// actually renders. Firestore re-serializes the items map on every
// snapshot, so item references are NEW per render even when nothing
// in this row changed — default shallow compare would bail every
// time and the memo would be useless. This comparator returns
// true (skip re-render) only when none of the visible fields moved.
const OrderItemRow = memo(OrderItemRowInner, (prev, next) => {
    if (prev.itemId !== next.itemId) return false;
    if (prev.isEs !== next.isEs) return false;
    if (prev.currentVendor !== next.currentVendor) return false;
    if (prev.onAction !== next.onAction) return false;
    const a = prev.item, b = next.item;
    if (a === b) return true;
    if (!a || !b) return a === b;
    // NOTE: checkedAt + checkedBy are intentionally NOT compared.
    // checkedAt is a Firestore Timestamp — the SDK rebuilds a fresh
    // Timestamp object on every snapshot, so `a.checkedAt === b.checkedAt`
    // is always false even when nothing changed (different JS ref, same
    // millis). Including it would defeat the memo. checkedAt + checkedBy
    // only change together with status (see updateSessionItem in
    // orderSession.js), so the status comparison below already triggers
    // a re-render when those need updating.
    return a.status === b.status
        && a.qty === b.qty
        && a.note === b.note
        && a.vendor === b.vendor
        && a.itemName === b.itemName
        && a.itemNameEs === b.itemNameEs
        && a.category === b.category
        && a.subcat === b.subcat
        && a.pack === b.pack
        && a.preferredVendor === b.preferredVendor;
});

// ── Vendor editor — admin-managed names ─────────────────────────────
function VendorEditor({ tx, configVendors, derivedVendors, staffName, onClose }) {
    const [newName, setNewName] = useState('');
    const [busy, setBusy] = useState(false);

    const handleAdd = async () => {
        const trimmed = newName.trim();
        if (!trimmed) return;
        setBusy(true);
        try {
            await addVendorName(trimmed, staffName);
            setNewName('');
            toast(tx('✓ Added', '✓ Añadido'));
        } catch (e) {
            console.error(e);
            toast(tx('Add failed', 'Error al añadir'), { kind: 'error' });
        } finally {
            setBusy(false);
        }
    };

    const handleRemove = async (name) => {
        if (!window.confirm(tx(`Remove "${name}" from the vendor list?`, `¿Quitar "${name}"?`))) return;
        try {
            await removeVendorName(name, staffName);
            toast(tx('Removed', 'Quitado'));
        } catch (e) {
            console.error(e);
            toast(tx('Remove failed', 'Error al quitar'), { kind: 'error' });
        }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[65] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-3">
            <div className="bg-white w-full sm:max-w-md max-h-[90vh] rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden">
                <div className="border-b border-dd-line p-3 flex items-center justify-between">
                    <h3 className="text-base font-black text-dd-text">
                        ✏️ {tx('Edit vendor list', 'Editar proveedores')}
                    </h3>
                    <button onClick={onClose} className="text-2xl text-gray-500 leading-none">×</button>
                </div>

                <div className="p-3 space-y-3 overflow-y-auto">
                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                            {tx('Add a vendor', 'Añadir proveedor')}
                        </div>
                        <div className="flex gap-2">
                            <input type="text" value={newName}
                                onChange={e => setNewName(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
                                placeholder={tx('e.g. Jays, Pan Asia', 'ej. Jays, Pan Asia')}
                                className="flex-1 px-2 py-1.5 rounded-lg border border-dd-line text-sm" />
                            <button onClick={handleAdd} disabled={busy || !newName.trim()}
                                className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm font-bold disabled:opacity-50">
                                + {tx('Add', 'Añadir')}
                            </button>
                        </div>
                    </div>

                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                            {tx('Admin-added (removable)', 'Añadidos (removibles)')}
                        </div>
                        {configVendors.length === 0 ? (
                            <p className="text-xs text-dd-text-2 italic">
                                {tx('None yet. Add one above.', 'Ninguno todavía.')}
                            </p>
                        ) : (
                            <div className="space-y-1">
                                {configVendors.map(v => (
                                    <VendorRow key={v}
                                        name={v}
                                        tx={tx}
                                        staffName={staffName}
                                        onRemove={() => handleRemove(v)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                            {tx('From inventory (auto, not removable)', 'Desde inventario (auto)')}
                        </div>
                        <div className="flex flex-wrap gap-1">
                            {derivedVendors.length === 0 ? (
                                <span className="text-xs text-dd-text-2 italic">{tx('None', 'Ninguno')}</span>
                            ) : derivedVendors.map(v => (
                                <span key={v}
                                    className="text-[11px] px-2 py-0.5 rounded-full bg-dd-bg border border-dd-line text-dd-text-2">
                                    {v}
                                </span>
                            ))}
                        </div>
                        <p className="text-[10px] text-dd-text-2 mt-1 italic">
                            {tx(
                                'These come from your inventory item data. Edit them via Operations or the inventory-list editor.',
                                'Provienen del inventario. Edítalos en Operaciones o el editor de listas.',
                            )}
                        </p>
                    </div>
                </div>

                <div className="border-t border-dd-line p-3">
                    <button onClick={onClose}
                        className="w-full py-2 rounded-xl bg-amber-600 text-white font-bold text-sm">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

// ── VendorRow — single admin-added vendor with inline rename + remove ──
// Click "✏️" to switch the label into an editable input; save with
// Enter or the green ✓ button; cancel with Escape. The rename only
// touches the /config/vendors entry — historical order_logs keep the
// old name as a snapshot (renaming doesn't rewrite history).
function VendorRow({ name, tx, staffName, onRemove }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(name);
    const [busy, setBusy] = useState(false);

    useEffect(() => { if (!editing) setDraft(name); }, [name, editing]);

    const startEdit = () => {
        setDraft(name);
        setEditing(true);
    };
    const saveEdit = async () => {
        const trimmed = draft.trim();
        if (!trimmed || trimmed === name) { setEditing(false); return; }
        setBusy(true);
        try {
            await renameVendorName(name, trimmed, staffName);
            setEditing(false);
        } catch (e) {
            console.error('renameVendorName failed:', e);
            toast(tx('Rename failed', 'Error al renombrar'), { kind: 'error' });
        } finally {
            setBusy(false);
        }
    };
    const cancelEdit = () => { setEditing(false); setDraft(name); };

    if (editing) {
        return (
            <div className="flex items-center gap-1 px-2 py-1.5 bg-amber-50 border border-amber-300 rounded">
                <input
                    type="text"
                    value={draft}
                    autoFocus
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') saveEdit();
                        if (e.key === 'Escape') cancelEdit();
                    }}
                    className="flex-1 px-2 py-0.5 rounded border border-dd-line text-sm"
                />
                <button onClick={saveEdit} disabled={busy || !draft.trim() || draft.trim() === name}
                    className="text-[11px] px-2 py-1 rounded bg-green-600 text-white font-bold disabled:opacity-40">
                    ✓
                </button>
                <button onClick={cancelEdit} disabled={busy}
                    className="text-[11px] px-2 py-1 rounded bg-white border border-dd-line text-dd-text-2 font-bold">
                    ✕
                </button>
            </div>
        );
    }
    return (
        <div className="flex items-center justify-between px-2 py-1.5 bg-white border border-dd-line rounded">
            <span className="text-sm">{name}</span>
            <div className="flex items-center gap-1">
                <button onClick={startEdit}
                    className="text-[10px] px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 font-bold hover:bg-amber-100">
                    ✏️ {tx('Rename', 'Renombrar')}
                </button>
                <button onClick={onRemove}
                    className="text-[10px] px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 font-bold">
                    {tx('Remove', 'Quitar')}
                </button>
            </div>
        </div>
    );
}

// ── PlanPanel ──────────────────────────────────────────────────────────
// Right-column vendor-scoped item list, shown when the 📋 Plan toggle
// is on. Groups session.items by planned vendor (item.vendor if
// marked, else preferredVendor, else '(unassigned)') and lets the
// manager click a vendor pill to scope the list to that vendor's
// items.
//
// 2026-05-25: shipped read-only.
// 2026-05-26 (Andrew): "the whole point of the order mode page is to
// be able to tick off item while ordering but the list on the right
// isnt able to do that". Made the rows INTERACTIVE — each one is now
// the same OrderItemRow used on the left with the full action button
// set (ordered / partial / OOS / edit qty / edit note). Vendor pills
// here are tied to OrderMode's currentVendor (instead of a separate
// internal selectedVendor) so tapping a pill arms that vendor for
// attribution AND scopes the panel in one tap. Both panels write to
// session.items, so a mark here ripples to the left via the live
// snapshot.
function PlanPanel({ items, isEs, currentVendor, onToggleVendor, onAction }) {
    const tx = (en, es) => isEs ? es : en;

    // Group items by planned vendor. '(unassigned)' bucket catches
    // items with no vendor and no preferredVendor — usually rare, but
    // shows up if inventory metadata is missing vendor info.
    const grouped = useMemo(() => {
        const map = new Map();
        for (const it of items || []) {
            const v = it.vendor || it.preferredVendor || '(unassigned)';
            if (!map.has(v)) map.set(v, []);
            map.get(v).push(it);
        }
        // Sort: real vendors A→Z, '(unassigned)' last.
        return new Map(
            [...map.entries()].sort(([a], [b]) => {
                if (a === '(unassigned)') return 1;
                if (b === '(unassigned)') return -1;
                return a.localeCompare(b);
            })
        );
    }, [items]);

    // 2026-05-26 — the right column's "selected vendor" is now tied
    // to OrderMode's currentVendor (Andrew: "the whole point of the
    // order mode page is to be able to tick off item while ordering
    // but the list on the right isnt able to do that"). Tapping a
    // pill here arms that vendor for attribution AND scopes the
    // panel to its items in one tap. Falls through to nothing-shown
    // until the manager picks a vendor — clearer than auto-showing
    // an arbitrary first bucket.
    const selectedVendor = currentVendor && grouped.has(currentVendor)
        ? currentVendor
        : null;
    const rows = selectedVendor ? (grouped.get(selectedVendor) || []) : [];

    return (
        <aside className="md:w-1/2 min-w-0 bg-dd-bg/50 flex flex-col flex-1 md:flex-none overflow-hidden">
            {/* Sticky header with vendor pills. */}
            <div className="px-3 py-2 border-b border-dd-line bg-white sticky top-0 z-10 shrink-0">
                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1.5">
                    📋 {tx('Plan by vendor', 'Plan por proveedor')}
                    {selectedVendor && (
                        <span className="ml-1.5 normal-case text-amber-700">
                            · {tx('marking for', 'marcando para')} {selectedVendor}
                        </span>
                    )}
                </div>
                {grouped.size === 0 ? (
                    <span className="text-xs text-dd-text-2 italic">
                        {tx('No items yet.', 'Sin artículos.')}
                    </span>
                ) : (
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                        {[...grouped.entries()].map(([vendor, list]) => {
                            const sel = vendor === selectedVendor;
                            const isUnassigned = vendor === '(unassigned)';
                            return (
                                <button
                                    key={vendor}
                                    onClick={() => {
                                        // '(unassigned)' is a label, not a real
                                        // vendor — don't try to arm it.
                                        if (isUnassigned) return;
                                        onToggleVendor && onToggleVendor(vendor);
                                    }}
                                    className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border transition ${sel
                                        ? 'bg-amber-600 text-white border-amber-700'
                                        : isUnassigned
                                            ? 'bg-white text-dd-text-2 border-dashed border-dd-line italic cursor-default'
                                            : 'bg-white text-dd-text border-dd-line hover:bg-dd-bg'}`}>
                                    {vendor} <span className="opacity-70">({list.length})</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Items for the selected vendor — INTERACTIVE. Reuses
                OrderItemRow so ordered / partial / OOS / edit qty /
                edit note behave the same as on the left. Marks here
                write to session.items and ripple to the left list
                via the live snapshot. */}
            <div className="flex-1 overflow-y-auto">
                {!selectedVendor ? (
                    <div className="p-6 text-center text-sm text-dd-text-2 italic">
                        {tx('Tap a vendor above to mark its items.',
                            'Toca un proveedor arriba para marcar sus artículos.')}
                    </div>
                ) : rows.length === 0 ? (
                    <div className="p-6 text-center text-sm text-dd-text-2 italic">
                        {tx('No items.', 'Sin artículos.')}
                    </div>
                ) : (
                    rows.map((it) => (
                        <OrderItemRow
                            key={it._itemId}
                            itemId={it._itemId}
                            item={it}
                            isEs={isEs}
                            currentVendor={currentVendor}
                            onAction={onAction}
                        />
                    ))
                )}
            </div>
        </aside>
    );
}

// PlanRow removed 2026-05-26 — was the read-only row used by an early
// version of the Plan panel. The panel now reuses OrderItemRow (the
// same component the left list uses) so check-offs work from either
// side. Kept the removal in history rather than the file.
