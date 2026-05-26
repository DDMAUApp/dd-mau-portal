// CartPlanView — focused vendor-assignment workflow inside the cart modal.
//
// Andrew 2026-05-26 — "once the cart is done the plan feature is used
// to help us category each item so when we look at the list we have
// everything planned where we are ordering from. i want it to be easy
// to click the vender and go through and click each item."
//
// Replaces the in-cart "🎯 Assign to" pill bar that lived above the
// comparison table — that mechanic worked but got lost in the busy
// cart. This is the same idea, surfaced as its own focused mode:
//
//   1. Vendor pills at the top, sticky. Tap one to ARM it.
//   2. Items list below. Each row shows its current vendor as a chip.
//   3. While a vendor is armed, tapping any row silently reassigns it
//      to the armed vendor (re-tap to flip; tap-from-other-vendor just
//      reassigns — no confirm).
//   4. Progress counter: "X of Y planned" — at a glance you can see
//      what's left.
//   5. "Done" returns to the cart with everything categorized; the
//      cart's "Place order" then carries effectiveVendor into OrderMode.
//
// State is owned by the parent (Operations.jsx's cart IIFE) so closing
// the cart modal preserves the plan — only the Plan-mode toggle resets.

import { useMemo } from 'react';

export default function CartPlanView({
    rows,
    language = 'en',
    assignVendors,
    cartArmedVendor,
    setCartArmedVendor,
    cartVendorOverride,
    setCartVendorOverride,
    effectiveVendor,
    onDone,
    onClearAll,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    // Vendor → count of items currently assigned to it (after override).
    // Drives the badge count on each pill so the manager can see how
    // many items will go to each vendor without scrolling.
    const counts = useMemo(() => {
        const m = {};
        for (const v of assignVendors || []) m[v] = 0;
        let unassigned = 0;
        for (const r of rows || []) {
            const v = effectiveVendor(r);
            if (v && Object.prototype.hasOwnProperty.call(m, v)) m[v] += 1;
            else if (!v) unassigned += 1;
        }
        return { byVendor: m, unassigned };
    }, [rows, assignVendors, effectiveVendor, cartVendorOverride]);

    // Total counts for the progress chip in the header. An item counts
    // as "planned" if it has ANY effective vendor (override OR a
    // preferredVendor mapped onto the canonical list). Truly unassigned
    // items (no override, no preferredVendor) are the work left to do.
    const totalRows = rows?.length || 0;
    const planned = totalRows - counts.unassigned;

    // Tap an item while a vendor is armed → silently set/replace its
    // override. Per Andrew's choice: just reassign, no confirm even if
    // it had a different vendor before.
    const tapItem = (r) => {
        if (!cartArmedVendor) return;
        setCartVendorOverride((prev) => ({ ...prev, [r.id]: cartArmedVendor }));
    };

    return (
        <>
            {/* Header explainer — instructive subtitle + progress chip. */}
            <div className="px-3 py-2 border-b border-gray-200 bg-purple-50 flex-shrink-0 flex items-center justify-between gap-2">
                <div className="min-w-0">
                    <div className="text-[11px] font-black uppercase tracking-wider text-purple-700">
                        📋 {tx('Plan ordering', 'Planear pedido')}
                    </div>
                    <div className="text-[11px] text-purple-700/80 truncate">
                        {tx('Pick a vendor, then tap items to assign.',
                            'Elige un proveedor, luego toca los artículos.')}
                    </div>
                </div>
                <span className={`text-[11px] font-black px-2 py-1 rounded-full whitespace-nowrap ${
                    planned === totalRows
                        ? 'bg-green-100 text-green-800 border border-green-200'
                        : 'bg-white text-purple-700 border border-purple-200'
                }`}>
                    {planned}/{totalRows} {tx('planned', 'planeados')}
                </span>
            </div>

            {/* Vendor pills — sticky. Same shape as the OrderMode strip
                so the visual vocabulary is consistent. */}
            <div className="px-3 py-2 border-b border-gray-200 bg-white flex-shrink-0">
                <div className="flex flex-wrap gap-1.5">
                    {(assignVendors || []).map((v) => {
                        const armed = cartArmedVendor === v;
                        const c = counts.byVendor[v] || 0;
                        return (
                            <button
                                key={v}
                                onClick={() => setCartArmedVendor(armed ? null : v)}
                                className={`text-xs font-bold px-2.5 py-1.5 rounded-full border transition ${
                                    armed
                                        ? 'bg-purple-600 text-white border-purple-700 ring-2 ring-purple-300'
                                        : 'bg-white text-gray-700 border-gray-300 hover:border-purple-400'
                                }`}>
                                {v}
                                {c > 0 && (
                                    <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${
                                        armed ? 'bg-white/25 text-white' : 'bg-gray-100 text-gray-600'
                                    }`}>{c}</span>
                                )}
                            </button>
                        );
                    })}
                </div>
                {/* Armed indicator + clear-all */}
                <div className="mt-1.5 flex items-center gap-2">
                    <div className="text-[11px] font-bold flex-1 min-w-0">
                        {cartArmedVendor ? (
                            <span className="text-purple-700 truncate">
                                ✓ {tx(`ARMED — tap an item to assign to ${cartArmedVendor}`,
                                       `ARMADO — toca un artículo para asignarlo a ${cartArmedVendor}`)}
                            </span>
                        ) : (
                            <span className="text-gray-400 italic">
                                {tx('Tap a vendor pill to start.', 'Toca un proveedor para empezar.')}
                            </span>
                        )}
                    </div>
                    {Object.keys(cartVendorOverride || {}).length > 0 && (
                        <button
                            onClick={onClearAll}
                            className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white border border-red-200 text-red-600 hover:bg-red-50">
                            ✕ {tx('Clear plan', 'Borrar plan')}
                        </button>
                    )}
                </div>
            </div>

            {/* Items list — tappable while armed. */}
            <div className="flex-1 overflow-y-auto">
                {(rows || []).length === 0 ? (
                    <div className="p-8 text-center text-gray-400 text-sm">
                        {tx('Cart is empty.', 'El carrito está vacío.')}
                    </div>
                ) : (
                    rows.map((r) => {
                        const myVendor = effectiveVendor(r);
                        const isOverridden = !!cartVendorOverride[r.id];
                        const isAssignedToArmed = cartArmedVendor && myVendor === cartArmedVendor;
                        const isClickable = !!cartArmedVendor;
                        return (
                            <button
                                key={r.id}
                                type="button"
                                onClick={() => tapItem(r)}
                                disabled={!isClickable}
                                className={`w-full text-left px-3 py-2.5 border-b border-gray-100 flex items-center gap-3 transition ${
                                    isClickable
                                        ? (isAssignedToArmed
                                            ? 'bg-purple-50 hover:bg-purple-100 cursor-pointer'
                                            : 'bg-white hover:bg-purple-50 cursor-pointer')
                                        : 'bg-white cursor-default'
                                }`}>
                                {/* Tap target / visual checkbox */}
                                <span className={`w-6 h-6 rounded-md flex items-center justify-center text-sm font-bold border-2 shrink-0 ${
                                    isAssignedToArmed
                                        ? 'bg-purple-600 border-purple-700 text-white'
                                        : myVendor
                                            ? 'bg-gray-100 border-gray-300 text-gray-400'
                                            : 'bg-white border-gray-300 text-gray-300'
                                }`}>
                                    {isAssignedToArmed ? '✓' : myVendor ? '·' : ''}
                                </span>

                                {/* Item info */}
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-bold text-gray-800 truncate flex items-center gap-1.5">
                                        {r.name}
                                        <span className="text-[10px] font-bold text-mint-700 shrink-0">
                                            × {r.qty}
                                        </span>
                                    </div>
                                    <div className="text-[10px] text-gray-400 truncate">
                                        {r.category}{r.pack ? ` · ${r.pack}` : ''}
                                    </div>
                                </div>

                                {/* Current vendor chip */}
                                {myVendor ? (
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap shrink-0 ${
                                        isOverridden
                                            ? 'bg-purple-100 text-purple-800 border border-purple-200'
                                            : 'bg-gray-100 text-gray-600 border border-gray-200'
                                    }`}>
                                        {isOverridden ? '📌 ' : ''}{myVendor}
                                    </span>
                                ) : (
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-full whitespace-nowrap shrink-0 bg-amber-50 text-amber-700 border border-amber-200">
                                        {tx('unassigned', 'sin asignar')}
                                    </span>
                                )}
                            </button>
                        );
                    })
                )}
            </div>

            {/* Done footer — returns to the cart's comparison view. */}
            <div className="border-t border-gray-200 p-3 flex gap-2 flex-shrink-0 bg-gray-50">
                <button
                    onClick={onDone}
                    className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-bold text-sm hover:bg-purple-700 active:scale-95 transition">
                    ✓ {tx('Done planning', 'Listo')}
                </button>
            </div>
        </>
    );
}
