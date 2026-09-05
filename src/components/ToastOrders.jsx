import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { db } from '../firebase';
import { collection, query, where, limit, onSnapshot, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { toast } from '../toast';
import { escapeHtml as esc } from '../data/htmlEscape';
import { subscribePrinterConfig, printFreeText } from '../data/labelPrinting';
import { printViaNative } from '../capacitor-bridge';
import { reuseSnapshotDocs } from '../data/snapshotReuse';
import { fmtIso } from '../data/dateFmt';

// ── Module-scope pure helpers (hoisted 2026-09-05 perf pass so the
//    memoized OrderRow below can use them without re-creating them
//    every parent render) ─────────────────────────────────────────

const statusColor = (status) => {
    if (!status) return "bg-gray-100 text-gray-600";
    const s = status.toUpperCase();
    if (s === "CLOSED" || s === "COMPLETED") return "bg-green-100 text-green-700";
    if (s === "OPEN" || s === "IN_PROGRESS") return "bg-blue-100 text-blue-700";
    if (s === "VOID" || s === "VOIDED") return "bg-red-100 text-red-700";
    return "bg-amber-100 text-amber-700";
};

const orderTypeLabel = (type) => {
    if (!type) return "";
    const t = type.toUpperCase().trim();
    // Toast dining option names (resolved from config)
    if (t === "TO GO" || t === "TOGO" || t === "TO-GO") return "🥡 To Go";
    if (t === "CALL IN" || t === "CALL-IN" || t === "CALLIN") return "📞 Call In";
    if (t === "DINE IN" || t === "DINE-IN" || t === "DINEIN" || t === "FOR HERE" || t === "HERE") return "🍽️ Dine In";
    if (t.includes("TAKE") || t.includes("PICKUP") || t.includes("PICK UP") || t.includes("PICK-UP")) return "🥡 Pickup";
    if (t.includes("DELIVER")) return "🚗 Delivery";
    if (t.includes("ONLINE") || t.includes("WEB")) return "📱 Online";
    if (t.includes("PHONE")) return "📞 Phone";
    if (t.includes("CURBSIDE")) return "🚗 Curbside";
    if (t.includes("CATERING")) return "🎉 Catering";
    // If it's a clean name from Toast config, just show it with a generic icon
    if (type.length < 30 && !type.includes("-") && type !== type.toUpperCase()) return `📋 ${type}`;
    return type;
};

// Format an order for an 80mm thermal receipt. Plain text — the
// printFreeText helper renders it through ePOS-Print XML (Epson)
// or AirPrint (Brother). Order # in big text up top, customer +
// promised time, then items with a leading qty and indented
// modifiers, then notes. Keep it scannable for a runner / line
// cook with one glance.
const buildOrderLabelText = (ord) => {
    const lines = [];
    const promised = fmtIso(ord.promisedDate, 'en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
    });
    // Header
    lines.push(`#${ord.orderNumber || ''}`);
    if (ord.orderType) lines.push(ord.orderType);
    lines.push(''); // blank
    // Customer block
    if (ord.customerName) lines.push(`NAME: ${ord.customerName}`);
    if (ord.phone)        lines.push(`PHONE: ${ord.phone}`);
    if (promised)         lines.push(`READY: ${promised}`);
    if (ord.address)      lines.push(`DELIVER: ${ord.address}`);
    if (ord.customerName || ord.phone || promised || ord.address) lines.push('');
    // Items
    lines.push('--- ORDER ---');
    for (const item of (ord.items || [])) {
        const qty = item.qty || 1;
        lines.push(`${qty}x ${item.name || ''}`);
        for (const m of (item.modifiers || [])) {
            lines.push(`   - ${m}`);
        }
    }
    // Notes
    if (ord.specialInstructions) {
        lines.push('');
        lines.push(`NOTES: ${ord.specialInstructions}`);
    }
    return lines.join('\n');
};

// ── Memoized order row (2026-09-05 — Andrew: "loading the orders …
//    very slow and glitchy … after use its hard to load"). The Railway
//    scraper rewrites every one of today's order docs EVERY MINUTE
//    (delete-then-re-insert), and previously every snapshot + every
//    15s ticker re-rendered every row — each with several un-cached
//    Intl date calls. Combined with reuseSnapshotDocs() keeping object
//    identity for unchanged docs, this memo makes those passes free:
//    a row only re-renders when ITS doc content, expansion, or print
//    state actually changed. ─────────────────────────────────────────
const OrderRow = memo(function OrderRow({ ord, ordKey, expanded, isEn, kitchenReady, printingThis, onToggle, onPrint, onLabelPrint }) {
    const locale = isEn ? "en-US" : "es-US";
    const timeStr = fmtIso(ord.createdDate, locale, { hour: "numeric", minute: "2-digit" });

    return (
        <div
            className={`bg-white border-2 rounded-lg p-3 mb-2 cursor-pointer transition ${expanded ? "border-mint-400 shadow-md" : "border-gray-200 hover:border-mint-300 ddmau-toastcard-cv"}`}
            onClick={() => onToggle(ordKey)}>

            {/* Top row */}
            <div className="flex justify-between items-start">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-gray-800">
                            #{ord.orderNumber || ord.orderGuid?.slice(-6).toUpperCase()}
                        </p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${statusColor(ord.status)}`}>
                            {ord.status || "—"}
                        </span>
                        {ord.orderType && (
                            <span className="text-xs text-gray-500">{orderTypeLabel(ord.orderType)}</span>
                        )}
                    </div>
                    {ord.customerName && (
                        <p className="text-sm text-gray-700 mt-1 font-medium">{ord.customerName}</p>
                    )}
                    {ord.serverName && (
                        <p className="text-xs text-gray-500 mt-0.5">{isEn ? "Server" : "Mesero"}: {ord.serverName}</p>
                    )}
                    {!expanded && (
                        <p className="text-xs text-gray-400 mt-1">
                            {timeStr && `${timeStr} • `}{ord.itemCount || 0} {isEn ? "items" : "artículos"}
                            {ord.address ? ` • 📍 ${isEn ? "Delivery" : "Entrega"}` : ""}
                        </p>
                    )}
                </div>
            </div>

            {/* Expanded details */}
            {expanded && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                    {timeStr && (
                        <div className="mb-3">
                            <p className="text-xs font-bold text-gray-500 mb-1">{isEn ? "Order Time:" : "Hora:"}</p>
                            <p className="text-xs text-gray-600">{timeStr}</p>
                        </div>
                    )}

                    {ord.customerName && (ord.phone || ord.email) && (
                        <div className="mb-3">
                            <p className="text-xs font-bold text-gray-500 mb-1">{isEn ? "Contact:" : "Contacto:"}</p>
                            {ord.phone && <p className="text-xs text-gray-600">📞 {ord.phone}</p>}
                            {ord.email && <p className="text-xs text-gray-600">✉️ {ord.email}</p>}
                        </div>
                    )}

                    {ord.address && (
                        <div className="mb-3">
                            <p className="text-xs font-bold text-gray-500 mb-1">{isEn ? "Delivery Address:" : "Dirección de Entrega:"}</p>
                            <p className="text-xs text-gray-600 bg-blue-50 rounded px-2 py-1.5">📍 {ord.address}</p>
                        </div>
                    )}

                    {ord.promisedDate && (
                        <div className="mb-3">
                            <p className="text-xs font-bold text-gray-500">{isEn ? "Promised:" : "Prometido:"}</p>
                            <p className="text-xs text-gray-600">
                                {fmtIso(ord.promisedDate, locale, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </p>
                        </div>
                    )}

                    {ord.specialInstructions && (
                        <div className="mb-3">
                            <p className="text-xs font-bold text-gray-500 mb-1">{isEn ? "Notes:" : "Notas:"}</p>
                            <p className="text-xs text-gray-600 bg-amber-50 rounded px-2 py-1.5">📝 {ord.specialInstructions}</p>
                        </div>
                    )}

                    {/* Line items */}
                    {ord.items && ord.items.length > 0 && (
                        <div>
                            <p className="text-xs font-bold text-gray-500 mb-1.5">{isEn ? "Items:" : "Artículos:"}</p>
                            <div className="grid grid-cols-1 gap-1">
                                {ord.items.map((item, ni) => (
                                    <div key={ni} className="text-xs bg-gray-50 rounded px-2 py-1.5">
                                        <span className="text-gray-700 font-medium">
                                            {item.qty > 1 ? `${item.qty}x ` : ""}{item.name}
                                        </span>
                                        {item.modifiers && item.modifiers.length > 0 && (
                                            <p className="text-gray-400 text-xs mt-0.5 pl-2">
                                                ↳ {item.modifiers.join(", ")}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Print buttons. Browser-print (full 8.5×11
                        HTML receipt → window.print() → OS dialog)
                        is always available. The thermal label
                        button appears only when the kitchen
                        printer for the current location is set
                        up + enabled in admin (Andrew 2026-05-29). */}
                    <div className={`mt-3 grid ${kitchenReady ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
                        <button
                            onClick={(e) => { e.stopPropagation(); onPrint(ord); }}
                            className="py-2 rounded-lg text-sm font-bold border-2 border-mint-300 text-mint-700 bg-white hover:bg-mint-50 transition">
                            🖨️ {isEn ? "Print Order" : "Imprimir Pedido"}
                        </button>
                        {kitchenReady && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onLabelPrint(ord); }}
                                disabled={printingThis}
                                className="py-2 rounded-lg text-sm font-bold border-2 border-purple-300 text-purple-700 bg-white hover:bg-purple-50 disabled:opacity-50 transition">
                                {printingThis
                                    ? (isEn ? '… Printing' : '… Imprimiendo')
                                    : `🏷 ${isEn ? 'Print to label printer' : 'Imprimir etiqueta'}`}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
});

export default function ToastOrders({ language, staffName = '', storeLocation }) {
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    // Default to the device's store (2026-08 audit P2: this hardcoded
    // "webster", so Maryland devices saw — and printed labels for — the
    // wrong store's orders until someone noticed the toggle). The in-page
    // toggle stays a manual override; the effect below only re-follows the
    // header location when THAT changes.
    const [location, setLocation] = useState(() =>
        (storeLocation === 'maryland' ? 'maryland' : 'webster'));
    useEffect(() => {
        if (storeLocation === 'webster' || storeLocation === 'maryland') {
            setLocation(storeLocation);
        }
    }, [storeLocation]);
    const [expandedOrder, setExpandedOrder] = useState(null);
    const [refreshing, setRefreshing] = useState(false);
    const [lastSync, setLastSync] = useState(null);
    // /ops/orders_trigger.triggeredAt — written every minute by the
    // triggerOrdersSync Cloud Function. Lets us distinguish "cron is
    // firing but scraper isn't responding" from "cron itself stopped."
    const [triggerLastAt, setTriggerLastAt] = useState(null);
    // /ops/orders_sync — the scraper's per-pass freshness doc (see the
    // listener below for the trust rules).
    const [ordersSyncDoc, setOrdersSyncDoc] = useState(null);
    // Re-render every 15s so the "N min ago" labels stay fresh
    // without having to wait for a Firestore snapshot.
    const [, forceTick] = useState(0);

    const isEn = language !== "es";

    const refreshTimeoutRef = useRef(null);
    const isMountedRef = useRef(true);

    const triggerRefresh = async () => {
        setRefreshing(true);
        try {
            await setDoc(doc(db, "ops", "orders_trigger"), {
                triggeredAt: serverTimestamp(),
                triggeredBy: "portal",
            });
        } catch (e) {
            console.error("Trigger refresh error:", e);
        }
        if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
        refreshTimeoutRef.current = setTimeout(() => {
            if (isMountedRef.current) setRefreshing(false);
        }, 3000);
    };

    // 2026-09-05 — the 60s auto-trigger interval that used to live here
    // is GONE. Since 2026-05-16 the triggerOrdersSync Cloud Function cron
    // (functions/index.js) writes ops/orders_trigger every minute whether
    // or not anyone has this tab open, and the Railway scraper fetches
    // orders every cycle regardless — so the client interval added one
    // redundant Firestore write per minute per open tab and nothing else.
    // The manual "Sync Now" button (triggerRefresh) stays.
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
        };
    }, []);

    // Subscribe to /ops/orders_trigger so the stale banner can show
    // whether the minute-cron is still firing.
    useEffect(() => {
        const unsub = onSnapshot(doc(db, "ops", "orders_trigger"), (snap) => {
            if (!snap.exists()) return;
            const data = snap.data() || {};
            const t = data.triggeredAt;
            const ms = t?.toMillis ? t.toMillis()
                : (t?.seconds ? t.seconds * 1000 : 0);
            if (ms) setTriggerLastAt(ms);
        }, (err) => console.warn("orders_trigger snapshot failed:", err));
        // /ops/orders_sync is the scraper's per-pass freshness doc
        // (2026-09-05): since the scraper diff-upserts now, per-doc
        // syncedAt only refreshes when an order actually changes. The
        // raw doc is kept in state and TRUSTED PER LOCATION down in the
        // health computation — its netSalesByLocation map only carries
        // locations whose fetch+write succeeded, and only the NEW
        // scraper writes it at all. The old scraper stamped updatedAt
        // even on total failure, so a bare updatedAt must never feed
        // the banner (that would mute the exact "scraper down" alarm
        // the banner exists for).
        const unsub2 = onSnapshot(doc(db, "ops", "orders_sync"), (snap) => {
            setOrdersSyncDoc(snap.exists() ? (snap.data() || null) : null);
        }, (err) => console.warn("orders_sync snapshot failed:", err));
        return () => { unsub(); unsub2(); };
    }, []);

    // Tick every 15s so the "N min ago" displays update without
    // needing a Firestore event.
    useEffect(() => {
        const id = setInterval(() => forceTick(t => t + 1), 15000);
        return () => clearInterval(id);
    }, []);

    // Track which location the current `orders` array belongs to.
    // When admin switches stores, the old location's orders briefly
    // stay visible until the new snapshot fires; this flag lets the
    // UI render a tiny "switching to X…" cue without blanking the
    // list. Set IMMEDIATELY on location change so the cue is up the
    // moment admin taps the toggle, cleared when the new snapshot
    // arrives.
    const [ordersLocation, setOrdersLocation] = useState(location);
    const [switching, setSwitching] = useState(false);

    // Stale-closure refs — the onSnapshot callback set up in the
    // [location] effect captures `orders` + `ordersLocation` at the
    // moment the effect ran. For the defensive-guard check below to
    // see the *latest* values across subsequent snapshots (the
    // listener can fire many times during a single sync), mirror
    // both into refs.
    const ordersRef = useRef(orders);
    const ordersLocationRef = useRef(ordersLocation);
    useEffect(() => { ordersRef.current = orders; }, [orders]);
    useEffect(() => { ordersLocationRef.current = ordersLocation; }, [ordersLocation]);
    // Grace timer for the scraper's transient empty snapshot (see the
    // defensive guard in the listener below).
    const emptyGraceRef = useRef(null);

    useEffect(() => {
        // FIX (Andrew 2026-05-20): "every time i use the orders page
        // to look at the orders per store the orders will disappear
        // and come back". Root cause was setLoading(true) here →
        // replaced the orders list with a full-page spinner on every
        // location toggle. Now we keep the previous orders visible
        // and just stamp `switching=true` so the UI shows a thin
        // "switching to Maryland Heights…" bar at the top instead of
        // blanking the list.
        setSwitching(location !== ordersLocation);
        setExpandedOrder(null);

        // Get today's date string in CST
        const now = new Date();
        const cst = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
        const today = cst.getFullYear() + "-" +
            String(cst.getMonth() + 1).padStart(2, "0") + "-" +
            String(cst.getDate()).padStart(2, "0");

        const q = query(
            collection(db, "toast_orders"),
            where("location", "==", location),
            where("businessDate", "==", today),
            limit(500)
        );
        const unsub = onSnapshot(q, (snap) => {
            const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            docs.sort((a, b) => (b.createdDate || "").localeCompare(a.createdDate || ""));

            // Freshest sync stamp comes from the RAW snapshot docs, not
            // the reused state below — reuseSnapshotDocs deliberately
            // keeps OLD doc objects (with old syncedAt) for unchanged
            // orders, and the stale-scraper banner must still see that
            // a sync pass just happened.
            let newestSync = null;
            for (const d of docs) {
                if (d.syncedAt && (!newestSync || d.syncedAt > newestSync)) newestSync = d.syncedAt;
            }

            // DEFENSIVE GUARD (Andrew 2026-05-20, reworked 2026-09-05):
            // the Toast scraper on Railway deletes then re-inserts ALL
            // of today's orders on every sync pass (every minute), which
            // produces a transient EMPTY snapshot before the refill.
            // Without a guard the UI flashes "No orders yet today"
            // every minute. The old rule only held the list when the
            // newest order was <10 min old, so during any lull longer
            // than 10 minutes the page blanked-and-refilled once a
            // minute — Andrew's "glitchy". New rule: on an empty
            // snapshot for the SAME location that previously had
            // orders, hold the list and arm an 8s grace timer; if the
            // refill lands (it arrives well under a second later) the
            // timer is cancelled, and only a silence of 8s+ — a REAL
            // empty day/void-everything state — clears the list.
            if (docs.length === 0
                && ordersLocationRef.current === location
                && ordersRef.current.length > 0) {
                if (!emptyGraceRef.current) {
                    emptyGraceRef.current = setTimeout(() => {
                        emptyGraceRef.current = null;
                        setOrders([]);
                        setOrdersLocation(location);
                        setSwitching(false);
                        setLoading(false);
                    }, 8000);
                }
                return;
            }
            if (emptyGraceRef.current) {
                clearTimeout(emptyGraceRef.current);
                emptyGraceRef.current = null;
            }

            // Identity-preserving update: unchanged docs keep their old
            // object, a fully-unchanged list keeps the old ARRAY — so
            // the per-minute scraper rewrite (only syncedAt differs)
            // causes ZERO re-render, and the memoized rows skip
            // everything but genuinely changed orders otherwise.
            setOrders(prev => reuseSnapshotDocs(prev, docs));
            setOrdersLocation(location);
            setSwitching(false);
            setLoading(false);
            // Max-wins against the ops/orders_sync stamp (both ISO-8601
            // UTC strings, so string compare is chronological).
            if (newestSync) setLastSync(prev => (!prev || newestSync > prev) ? newestSync : prev);
        }, (err) => {
            console.error("Toast orders query error:", err);
            setLoading(false);
            setSwitching(false);
        });
        return () => {
            unsub();
            if (emptyGraceRef.current) {
                clearTimeout(emptyGraceRef.current);
                emptyGraceRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location]);

    // ── Sync-health computation ──────────────────────────────────
    // Two age measures power the banner:
    //   • syncAgeMin: how long since the scraper's last successful
    //     sync pass. Sourced from ops/orders_sync.updatedAt (stamped
    //     every pass) with per-doc syncedAt as a fallback, max wins.
    //   • triggerAgeMin: how long since the Cloud Function cron
    //     wrote ops/orders_trigger. Tells us whether the cron itself
    //     is alive even when no orders are landing.
    //
    // Banner only shows during business hours (10am–10pm Central)
    // and only when there's been at least one order today —
    // otherwise the "no syncing in 4h" alert would fire every
    // morning at open and every night after close.
    const now = Date.now();
    // orders_sync.updatedAt counts ONLY when the doc proves a successful
    // pass for the VIEWED location (netSalesByLocation is written by the
    // new scraper for succeeded locations only). Old-scraper stamps lack
    // the field and are ignored — per-doc syncedAt then ages naturally
    // and the banner fires exactly as it did before this change.
    const syncDocStamp = (ordersSyncDoc
        && ordersSyncDoc.netSalesByLocation
        && ordersSyncDoc.netSalesByLocation[location] != null
        && typeof ordersSyncDoc.updatedAt === 'string')
        ? ordersSyncDoc.updatedAt : null;
    const lastSyncEff = (lastSync && syncDocStamp)
        ? (lastSync > syncDocStamp ? lastSync : syncDocStamp)
        : (lastSync || syncDocStamp);
    const lastSyncMs = lastSyncEff
        ? (typeof lastSyncEff === 'string' ? Date.parse(lastSyncEff) : 0)
        : 0;
    const syncAgeMin = lastSyncMs ? Math.floor((now - lastSyncMs) / 60000) : null;
    const triggerAgeMin = triggerLastAt ? Math.floor((now - triggerLastAt) / 60000) : null;
    const cstHour = parseInt(
        new Date(now).toLocaleString("en-US", { timeZone: "America/Chicago", hour: "2-digit", hour12: false }),
        10
    );
    const inBusinessHours = cstHour >= 10 && cstHour < 22;
    const health = (syncAgeMin == null || !inBusinessHours)
        ? 'silent'
        : syncAgeMin <= 3 ? 'live'
        : syncAgeMin <= 10 ? 'slow'
        : 'stale';
    const fmtAge = (m) => {
        if (m == null) return '—';
        if (m < 1) return isEn ? 'just now' : 'ahora';
        if (m < 60) return isEn ? `${m} min ago` : `hace ${m} min`;
        const h = Math.floor(m / 60);
        return isEn ? `${h}h ago` : `hace ${h}h`;
    };

    // ── Kitchen label printer (Epson TM-L100 / Brother QL) ─────────
    // Andrew 2026-05-29: "when we look at the orders page the orders
    // we can print. when the printer is set up i want to be able to
    // print the orders to this printer too." The existing handlePrint
    // opens a new browser window → window.print() → OS print dialog.
    // That's fine for an 8.5×11 office printer. For the thermal label
    // printer at the kitchen station, we instead build a compact
    // 80mm-wide text payload and POST it straight to the printer via
    // the existing labelPrinting.printFreeText() helper (same path the
    // date sticker printer uses).
    //
    // The label button only appears when there's a configured + enabled
    // kitchen-slot printer for the current location — otherwise it'd
    // confuse staff at locations where the hardware isn't installed.
    const [kitchenPrinter, setKitchenPrinter] = useState(null);
    const [labelPrinting, setLabelPrinting] = useState(null); // ord.orderGuid being printed
    useEffect(() => {
        const unsub = subscribePrinterConfig(location, setKitchenPrinter, 'kitchen');
        return () => { try { unsub && unsub(); } catch {} };
    }, [location]);
    const kitchenReady = !!kitchenPrinter && kitchenPrinter.enabled !== false;

    const handleLabelPrint = useCallback(async (ord) => {
        if (!kitchenReady) return;
        // Toast scraper writes the field as `orderGuid` (see scraper.py
        // ~line 2324). The earlier `ord.guid` lookup was always undefined,
        // which made the disabled-while-printing check fall back to
        // `ord.orderNumber` — fine for unique numbers, but two orders that
        // share an orderNumber across days would lock together. Align
        // with lines 548/564 which already use `orderGuid`.
        const orderKey = ord.orderGuid || ord.orderNumber || String(Math.random());
        setLabelPrinting(orderKey);
        try {
            const text = buildOrderLabelText(ord);
            const res = await printFreeText({
                location,
                slot: 'kitchen',
                text,
                size: 1,        // 1× scale — readable but compact
                bold: true,
                align: 'left',
                copies: 1,
                byName: staffName || 'orders',
            });
            if (res.ok) {
                toast(isEn ? '🏷 Sent to kitchen printer' : '🏷 Enviado a la impresora');
            } else {
                const codeMsg = {
                    no_printer_configured: isEn ? 'No printer set up' : 'Sin impresora',
                    printer_disabled:      isEn ? 'Printer disabled in admin' : 'Impresora deshabilitada',
                    timeout:               isEn ? 'Printer did not respond' : 'No respondió',
                    network_error:         isEn ? 'Network / CORS error' : 'Error de red / CORS',
                    text_too_long:         isEn ? 'Order is too long for one label' : 'Pedido demasiado largo',
                    empty_text:            isEn ? 'Empty order body' : 'Pedido vacío',
                }[res.error] || (isEn ? `Failed: ${res.error}` : `Falló: ${res.error}`);
                toast(`⚠ ${codeMsg}`);
            }
        } catch (e) {
            console.error('handleLabelPrint failed:', e);
            toast(isEn ? '⚠ Label print failed' : '⚠ Falló la impresión');
        } finally {
            setLabelPrinting(null);
        }
    }, [kitchenReady, location, staffName, isEn]);

    const handlePrint = useCallback((ord) => {
        const locName = location === "webster" ? "Big Bend Blvd" : "Dorsett Rd";
        // FIX (Andrew 2026-09-05, invoice print: "is shows br before the
        // time"): the address used to embed literal "<br>" INSIDE the
        // string that later went through esc(), which escapes < and > —
        // so the printout showed the text "<br>" instead of a line
        // break. Escape each line separately, join with a real <br>.
        const locAddrHtml = (location === "webster"
            ? ["8148 Big Bend Blvd", "Webster Groves, MO 63119", "(314) 968-3275"]
            : ["11982 Dorsett Rd", "Maryland Heights, MO 63034", "(314) 942-2300"]
        ).map(esc).join("<br>");

        const timeStr = fmtIso(ord.createdDate, "en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
        const promisedStr = fmtIso(ord.promisedDate, "en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

        // FIX (review 2026-05-14, real): every interpolated string (item
        // names, modifiers, customer name, address, notes, server name,
        // status) is escaped via esc() — Toast's API returns these as
        // free-text strings, and customer-supplied fields like address /
        // notes are clearly attacker-controllable.
        const itemRows = (ord.items || []).map(item => {
            const modsHtml = item.modifiers && item.modifiers.length > 0
                ? item.modifiers.map(m => `<div style="padding-left:4px;color:#555;font-size:12px;">${esc(m)}</div>`).join("")
                : "";
            return `<tr style="border-bottom:1px solid #e5e5e5;">
                <td style="padding:8px 4px;text-align:center;vertical-align:top;width:40px;font-weight:600;">${esc(item.qty)}</td>
                <td style="padding:8px 4px;font-weight:600;vertical-align:top;">${esc(item.name)}</td>
                <td style="padding:8px 4px;vertical-align:top;font-size:13px;">${modsHtml}</td>
            </tr>`;
        }).join("");

        const html = `<!DOCTYPE html><html><head><title>Order #${esc(ord.orderNumber || "")}</title>
        <style>
            body { font-family: Arial, Helvetica, sans-serif; max-width:700px; margin:0 auto; padding:30px 40px; color:#222; font-size:14px; }
            .no-print { position:sticky;top:0;z-index:1000;background:#255a37;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3) }
            .no-print button { padding:12px 24px; font-size:16px; font-weight:bold; border:none; border-radius:8px; cursor:pointer; margin:0 6px; }
            .btn-print { background:white; color:#255a37; } .btn-close { background:#ff4444; color:white; }
            @media print { body { padding:20px; } .no-print { display:none !important; } }
        </style></head>
        <body>
        <div class="no-print">
            <button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://app.ddmaustl.com/'}},300)">✕ Close</button>
            <button class="btn-print" onclick="window.print()">🖨️ Print</button>
        </div>
        <table style="width:100%;margin-bottom:20px;"><tr>
            <td style="vertical-align:top;width:50%;">
                <div style="font-size:20px;font-weight:bold;color:#333;margin-bottom:2px;">DD Mau</div>
                <div style="font-size:11px;color:#888;margin-bottom:12px;">Vietnamese Eatery</div>
                <div style="font-size:16px;font-weight:bold;margin-bottom:8px;">${esc(locName)}</div>
                <div style="font-size:13px;color:#444;line-height:1.5;">${locAddrHtml}</div>
            </td>
            <td style="vertical-align:top;text-align:right;">
                <div style="font-size:22px;font-weight:bold;margin-bottom:10px;">Order</div>
                <table style="margin-left:auto;font-size:13px;">
                    <tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Order #</td><td>${esc(ord.orderNumber || "")}</td></tr>
                    ${ord.orderType ? `<tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Type</td><td>${esc(ord.orderType)}</td></tr>` : ""}
                    ${timeStr ? `<tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Placed</td><td>${esc(timeStr)}</td></tr>` : ""}
                    ${ord.status ? `<tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Status</td><td>${esc(ord.status)}</td></tr>` : ""}
                    ${ord.serverName ? `<tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Server</td><td>${esc(ord.serverName)}</td></tr>` : ""}
                </table>
            </td>
        </tr></table>

        ${ord.customerName ? `<div style="margin-bottom:16px;"><div style="font-weight:bold;margin-bottom:4px;">Customer</div><div style="font-size:13px;">${esc(ord.customerName)}</div>${ord.phone ? `<div style="font-size:13px;color:#444;">${esc(ord.phone)}</div>` : ""}</div>` : ""}
        ${promisedStr ? `<div style="margin-bottom:16px;"><div style="font-weight:bold;margin-bottom:4px;">${ord.address ? "Delivery Time" : "Pickup Time"}</div><div style="font-size:13px;">${esc(promisedStr)}</div></div>` : ""}
        ${ord.address ? `<div style="margin-bottom:16px;"><div style="font-weight:bold;margin-bottom:4px;">Delivery Address</div><div style="font-size:13px;">${esc(ord.address)}</div></div>` : ""}

        <div style="font-size:18px;font-weight:bold;margin-bottom:8px;">Order</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="border-bottom:2px solid #222;">
                <th style="text-align:center;padding:6px 4px;font-size:13px;width:40px;">Qty</th>
                <th style="text-align:left;padding:6px 4px;font-size:13px;">Item</th>
                <th style="text-align:left;padding:6px 4px;font-size:13px;"></th>
            </tr></thead>
            <tbody>${itemRows}</tbody>
        </table>

        ${ord.specialInstructions ? `<div style="margin-top:16px;padding:8px;background:#f5f5f5;border-radius:4px;font-size:13px;"><strong>Notes:</strong> ${esc(ord.specialInstructions)}</div>` : ""}
        <div style="margin-top:30px;font-size:11px;color:#bbb;border-top:1px solid #ddd;padding-top:10px;">Printed from DD Mau Staff Portal</div>
        </body></html>`;

        if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Order'); return; }
        const printWindow = window.open("", "_blank", "width=700,height=900");
        if (!printWindow) {
            toast(isEn
                ? "Please allow pop-ups to print orders."
                : "Por favor permita ventanas emergentes para imprimir pedidos.");
            return;
        }
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
    }, [location, isEn]);

    // Stable expand/collapse callback so the memoized rows don't see a
    // new function identity every render.
    const handleToggleRow = useCallback((key) => {
        setExpandedOrder(prev => (prev === key ? null : key));
    }, []);

    return (
        <div>
            <div className="flex justify-between items-center mb-3">
                <h2 className="text-xl font-bold text-mint-700">
                    🛒 {isEn ? "Today's Orders" : "Pedidos de Hoy"}
                </h2>
                <button onClick={triggerRefresh} disabled={refreshing}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition ${refreshing ? "bg-gray-100 text-gray-400 border-gray-200" : "bg-white text-mint-700 border-mint-300 hover:bg-mint-50"}`}>
                    {refreshing ? (isEn ? "⏳ Syncing..." : "⏳ Sincronizando...") : (isEn ? "🔄 Sync Now" : "🔄 Sincronizar")}
                </button>
            </div>

            {/* Location toggle */}
            <div className="flex gap-2 mb-3">
                <button onClick={() => setLocation("webster")}
                    className={`flex-1 py-2.5 rounded-lg font-bold text-sm border-2 transition ${location === "webster" ? "bg-emerald-700 text-white border-emerald-700" : "bg-white text-gray-600 border-gray-200"}`}>
                    Webster
                </button>
                <button onClick={() => setLocation("maryland")}
                    className={`flex-1 py-2.5 rounded-lg font-bold text-sm border-2 transition ${location === "maryland" ? "bg-emerald-700 text-white border-emerald-700" : "bg-white text-gray-600 border-gray-200"}`}>
                    Maryland Heights
                </button>
            </div>

            {/* Stale-orders banner — only fires in business hours
                when the freshest order in /toast_orders is older
                than 3 min. Amber 3-10 min (probably catching up),
                red >10 min (scraper down). */}
            {health === 'slow' && (
                <div className="mb-3 rounded-lg border-2 border-amber-300 bg-amber-50 p-3 flex items-start gap-3">
                    <span className="text-2xl">⚠️</span>
                    <div className="flex-1 min-w-0">
                        <div className="font-black text-amber-900 text-sm">
                            {isEn ? 'Orders syncing slow' : 'Sincronización lenta'}
                        </div>
                        <div className="text-xs text-amber-800 mt-0.5">
                            {isEn
                                ? `Last sync ${fmtAge(syncAgeMin)}. Trigger cron ${fmtAge(triggerAgeMin)}. Try "Sync Now"; if nothing lands in a minute, restart the Toast scraper on Railway.`
                                : `Última sincronización ${fmtAge(syncAgeMin)}. Cron ${fmtAge(triggerAgeMin)}. Toca "Sincronizar"; si no entra nada, reinicia el scraper en Railway.`}
                        </div>
                    </div>
                </div>
            )}
            {health === 'stale' && (
                <div className="mb-3 rounded-lg border-2 border-red-400 bg-red-50 p-3 flex items-start gap-3">
                    <span className="text-2xl">🚨</span>
                    <div className="flex-1 min-w-0">
                        <div className="font-black text-red-900 text-sm">
                            {isEn ? 'Toast scraper looks down' : 'El scraper de Toast no responde'}
                        </div>
                        <div className="text-xs text-red-800 mt-0.5">
                            {isEn
                                ? `No sync in ${fmtAge(syncAgeMin)}. Cron is ${triggerAgeMin != null && triggerAgeMin < 3 ? 'still firing every minute' : `quiet for ${fmtAge(triggerAgeMin)} — also broken`}. Restart the Toast orders service on Railway (most common: OAuth token expired).`
                                : `Sin sincronización en ${fmtAge(syncAgeMin)}. El cron ${triggerAgeMin != null && triggerAgeMin < 3 ? 'sigue activo' : `también está callado (${fmtAge(triggerAgeMin)})`}. Reinicia el servicio de Toast en Railway.`}
                        </div>
                    </div>
                </div>
            )}

            {/* Summary bar */}
            {!loading && orders.length > 0 && (
                <div className="bg-mint-50 border-2 border-mint-200 rounded-lg p-3 mb-4">
                    <div className="flex justify-between items-center">
                        <div>
                            <p className="text-sm font-bold text-mint-800">{orders.length} {isEn ? "orders today" : "pedidos hoy"}</p>
                            <p className="text-xs text-mint-600">{isEn ? "Takeout, delivery & online" : "Para llevar, entrega y en línea"}</p>
                        </div>
                        {lastSyncEff && (
                            <div className="text-right">
                                <p className={`text-xs font-bold ${health === 'live' ? 'text-mint-700' : health === 'slow' ? 'text-amber-700' : health === 'stale' ? 'text-red-700' : 'text-mint-500'}`}>
                                    {health === 'live' ? '🟢' : health === 'slow' ? '🟡' : health === 'stale' ? '🔴' : '⚪'} {isEn ? "Last sync" : "Última"} {fmtIso(lastSyncEff, "en-US", { hour: "numeric", minute: "2-digit" })}
                                </p>
                                {syncAgeMin != null && (
                                    <p className="text-[10px] text-mint-500">{fmtAge(syncAgeMin)}</p>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Inline "switching location" cue — shows ABOVE the orders
                list when admin taps the other location's toggle. Keeps
                the previous orders visible underneath so the page never
                blanks. Fixes Andrew's "disappear and come back" flicker. */}
            {switching && (
                <div className="mb-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 flex items-center gap-2 text-[12px] font-bold text-sky-800">
                    <span className="inline-block w-2 h-2 rounded-full bg-sky-500 animate-pulse" />
                    {isEn
                        ? `Switching to ${location === 'webster' ? 'Webster' : 'Maryland Heights'}…`
                        : `Cambiando a ${location === 'webster' ? 'Webster' : 'Maryland Heights'}…`}
                </div>
            )}

            {/* Only the very-first load (no orders ever yet) shows the
                full-page spinner. After that, the orders array stays
                rendered while updates trickle through — no flicker. */}
            {loading && orders.length === 0 ? (
                <div className="text-center py-12">
                    <p className="text-3xl mb-2">⏳</p>
                    <p className="text-gray-400">{isEn ? "Loading orders..." : "Cargando pedidos..."}</p>
                </div>
            ) : orders.length === 0 ? (
                <div className="text-center py-12">
                    <p className="text-3xl mb-2">📭</p>
                    <p className="text-gray-500 font-bold">{isEn ? "No orders yet today" : "Sin pedidos hoy"}</p>
                    <p className="text-xs text-gray-400 mt-2">{isEn ? "Orders sync automatically every minute." : "Los pedidos se sincronizan cada minuto."}</p>
                </div>
            ) : (
                <div>
                    {orders.map((ord, i) => {
                        // FIX (review 2026-05-14): use a stable identifier for expand/
                        // collapse even when orderGuid is missing. Without the fallback,
                        // expand toggles on `null` and every row with a missing guid
                        // expands/collapses together.
                        const ordKey = ord.orderGuid || ord.id || `idx-${i}`;
                        return (
                            <OrderRow
                                key={ordKey}
                                ord={ord}
                                ordKey={ordKey}
                                expanded={expandedOrder === ordKey}
                                isEn={isEn}
                                kitchenReady={kitchenReady}
                                printingThis={labelPrinting != null && labelPrinting === (ord.orderGuid || ord.orderNumber)}
                                onToggle={handleToggleRow}
                                onPrint={handlePrint}
                                onLabelPrint={handleLabelPrint}
                            />
                        );
                    })}

                    <p className="text-xs text-gray-300 text-center mt-4 mb-2">
                        {isEn ? "Auto-syncs every minute" : "Se sincroniza cada minuto"}
                    </p>
                </div>
            )}
        </div>
    );
}
