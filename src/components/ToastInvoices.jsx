import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { db } from '../firebase';
import { collection, query, where, orderBy, limit, onSnapshot, doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { toast } from '../toast';
import { escapeHtml as esc } from '../data/htmlEscape';
import { printViaNative } from '../capacitor-bridge';
import { reuseSnapshotDocs } from '../data/snapshotReuse';
import { fmtIso } from '../data/dateFmt';

// Delivery detection (Andrew 2026-09-05: Gabriel Vuagniaux's DELIVERY
// invoice printed as "Pickup Time" with no address). The scraper only
// captured the customer's BILLING address (customer.address — usually
// empty for delivery orders); the actual delivery address lives on the
// invoice's embedded order. The scraper now writes `deliveryAddress` +
// `isDelivery`; older docs re-sync within 30 min. `address` stays as
// the billing-address fallback so nothing regresses while docs refresh.
// When the scraper has stamped an explicit isDelivery boolean, trust it
// outright — a pickup invoice whose customer merely has a billing
// address on file must NOT be labeled a delivery. Docs from before the
// stamp (no boolean) fall back to the old address-presence heuristic.
const invIsDelivery = (inv) => typeof inv.isDelivery === 'boolean'
    ? inv.isDelivery
    : !!(inv.deliveryAddress || inv.address);
const invAddress = (inv) => {
    if (inv.deliveryAddress) return inv.deliveryAddress;
    if (typeof inv.isDelivery === 'boolean') return inv.isDelivery ? (inv.address || "") : "";
    return inv.address || "";
};

const statusColor = (status) => {
    if (!status) return "bg-gray-100 text-gray-600";
    const s = status.toUpperCase();
    if (s === "PAID" || s === "CLOSED") return "bg-green-100 text-green-700";
    if (s === "SENT" || s === "OPEN") return "bg-blue-100 text-blue-700";
    if (s === "OVERDUE" || s === "PAST_DUE") return "bg-red-100 text-red-700";
    if (s === "DRAFT") return "bg-gray-100 text-gray-500";
    return "bg-amber-100 text-amber-700";
};

// Memoized invoice card (2026-09-05 perf pass — see OrderRow in
// ToastOrders.jsx for the full story). Every 30-min scraper pass
// rewrites every invoice doc (fresh syncedAt) and every tap used to
// re-render all ~200 cards with several un-cached Intl date calls
// each; with reuseSnapshotDocs + this memo, a card only re-renders
// when its own content or expansion changed.
const InvoiceCard = memo(function InvoiceCard({ inv, expanded, isEn, onToggle, onPrint }) {
    const locale = isEn ? "en-US" : "es-US";
    const delivery = invIsDelivery(inv);
    const address = invAddress(inv);

    return (
        <div
            className={`bg-white border-2 rounded-lg p-3 mb-2 cursor-pointer transition ${expanded ? "border-mint-400 shadow-md" : "border-gray-200 hover:border-mint-300 ddmau-toastcard-cv"}`}
            onClick={() => onToggle(inv.invoiceGuid)}>

            {/* Top row: invoice number + total */}
            <div className="flex justify-between items-start">
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-gray-800">
                            #{inv.invoiceNumber || inv.invoiceGuid?.slice(-6).toUpperCase()}
                        </p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${statusColor(inv.status)}`}>
                            {inv.status || "—"}
                        </span>
                    </div>
                    {/* Customer / Company */}
                    <p className="text-sm text-gray-700 mt-1 font-medium">
                        {inv.companyName || inv.customerName || (isEn ? "No customer" : "Sin cliente")}
                    </p>
                    {inv.companyName && inv.customerName && (
                        <p className="text-xs text-gray-400">{inv.customerName}</p>
                    )}
                    {/* Item count preview */}
                    {!expanded && (
                        <p className="text-xs text-gray-400 mt-1">
                            {inv.itemCount || 0} {isEn ? "items" : "artículos"}
                            {delivery ? ` • 📍 ${isEn ? "Delivery" : "Entrega"}` : ""}
                        </p>
                    )}
                </div>
            </div>

            {/* Expanded details */}
            {expanded && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                    {/* Contact info */}
                    {(inv.phone || inv.email) && (
                        <div className="mb-3">
                            <p className="text-xs font-bold text-gray-500 mb-1">{isEn ? "Contact:" : "Contacto:"}</p>
                            {inv.phone && <p className="text-xs text-gray-600">📞 {inv.phone}</p>}
                            {inv.email && <p className="text-xs text-gray-600">✉️ {inv.email}</p>}
                        </div>
                    )}

                    {/* Delivery address */}
                    {address && (
                        <div className="mb-3">
                            <p className="text-xs font-bold text-gray-500 mb-1">{isEn ? "Delivery Address:" : "Dirección de Entrega:"}</p>
                            <p className="text-xs text-gray-600 bg-blue-50 rounded px-2 py-1.5">📍 {address}</p>
                        </div>
                    )}

                    {/* Dates */}
                    <div className="mb-3 flex gap-4">
                        {inv.promisedDate && (
                            <div>
                                <p className="text-xs font-bold text-gray-500">{isEn ? "Due:" : "Fecha:"}</p>
                                <p className="text-xs text-gray-600">
                                    {fmtIso(inv.promisedDate, locale, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                </p>
                            </div>
                        )}
                        {inv.paymentDueDate && (
                            <div>
                                <p className="text-xs font-bold text-gray-500">{isEn ? "Payment Due:" : "Pago:"}</p>
                                <p className="text-xs text-gray-600">
                                    {fmtIso(inv.paymentDueDate, locale, { month: "short", day: "numeric" })}
                                </p>
                            </div>
                        )}
                    </div>

                    {/* Line items */}
                    {inv.items && inv.items.length > 0 && (
                        <div>
                            <p className="text-xs font-bold text-gray-500 mb-1.5">{isEn ? "Items:" : "Artículos:"}</p>
                            <div className="grid grid-cols-1 gap-1">
                                {inv.items.map((item, ni) => (
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

                    {/* Print button */}
                    <button
                        onClick={(e) => { e.stopPropagation(); onPrint(inv); }}
                        className="mt-3 w-full py-2 rounded-lg text-sm font-bold border-2 border-mint-300 text-mint-700 bg-white hover:bg-mint-50 transition">
                        🖨️ {isEn ? "Print Order" : "Imprimir Pedido"}
                    </button>
                </div>
            )}
        </div>
    );
});

export default function ToastInvoices({ language }) {
    const [invoices, setInvoices] = useState([]);
    const [loading, setLoading] = useState(true);
    const [location, setLocation] = useState("webster");
    const [expandedInvoice, setExpandedInvoice] = useState(null);
    const [refreshing, setRefreshing] = useState(false);

    const isEn = language !== "es";
    const refreshTimeoutRef = useRef(null);
    const isMountedRef = useRef(true);

    const handlePrint = useCallback((inv) => {
        const locName = location === "webster" ? "Big Bend Blvd" : "Dorsett Rd";
        // FIX (Andrew 2026-09-05: "is shows br before the time"): the
        // address + pickup strings used to embed a literal "<br>" INSIDE
        // text that later went through esc() — esc escapes < and >, so
        // the printout showed the characters "<br>" instead of a line
        // break. Escape each line separately, join with a real <br>.
        const locAddrHtml = (location === "webster"
            ? ["8148 Big Bend Blvd", "Webster Groves, MO 63119", "(314) 968-3275"]
            : ["11982 Dorsett Rd", "Maryland Heights, MO 63034", "(314) 942-2300"]
        ).map(esc).join("<br>");

        const delivery = invIsDelivery(inv);
        const address = invAddress(inv);

        const invoiceDate = fmtIso(inv.createdDate, "en-US", { month: "numeric", day: "numeric", year: "2-digit" });
        const orderDate = fmtIso(inv.promisedDate, "en-US", { month: "numeric", day: "numeric", year: "2-digit" }) || invoiceDate;
        const pickupDateStr = fmtIso(inv.promisedDate, "en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
        const pickupTimeStr = fmtIso(inv.promisedDate, "en-US", { hour: "numeric", minute: "2-digit" });
        const pickupHtml = pickupDateStr
            ? esc(pickupDateStr) + "<br>" + esc(pickupTimeStr)
            : "";

        // FIX (review 2026-05-14, real): every interpolated string is
        // escaped — same threat model as ToastOrders.jsx, see esc helper
        // import + comment block on htmlEscape.js.
        const itemRows = (inv.items || []).map(item => {
            const modsHtml = item.modifiers && item.modifiers.length > 0
                ? item.modifiers.map(m => `<div style="padding-left:4px;color:#555;font-size:12px;">${esc(m)}</div>`).join("")
                : "";
            return `<tr style="border-bottom:1px solid #e5e5e5;">
                <td style="padding:8px 4px;text-align:center;vertical-align:top;width:40px;font-weight:600;">${esc(item.qty)}</td>
                <td style="padding:8px 4px;font-weight:600;vertical-align:top;">${esc(item.name)}</td>
                <td style="padding:8px 4px;vertical-align:top;font-size:13px;">${modsHtml}</td>
            </tr>`;
        }).join("");

        const html = `<!DOCTYPE html><html><head><title>Invoice #${esc(inv.invoiceNumber || "")}</title>
        <style>
            body { font-family: Arial, Helvetica, sans-serif; max-width:700px; margin:0 auto; padding:30px 40px; color:#222; font-size:14px; }
            .no-print { position:sticky; top:0; z-index:1000; background:#059669; padding:10px; text-align:center; box-shadow:0 2px 8px rgba(0,0,0,.3); }
            .no-print button { padding:12px 24px; font-size:16px; font-weight:bold; border:none; border-radius:8px; cursor:pointer; margin:0 6px; }
            .btn-print { background:white; color:#059669; }
            .btn-close { background:#ff4444; color:white; }
            @media print { body { padding:20px; } .no-print { display:none !important; } }
        </style></head>
        <body>
        <div class="no-print">
            <button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://app.ddmaustl.com/'}},300)">✕ Close</button>
            <button class="btn-print" onclick="window.print()">🖨️ Print</button>
        </div>
        <!-- Header -->
        <table style="width:100%;margin-bottom:20px;"><tr>
            <td style="vertical-align:top;width:50%;">
                <div style="font-size:20px;font-weight:bold;color:#333;margin-bottom:2px;">DD Mau</div>
                <div style="font-size:11px;color:#888;margin-bottom:12px;">Vietnamese Eatery</div>
                <div style="font-size:16px;font-weight:bold;margin-bottom:8px;">${esc(locName)}</div>
                <div style="font-size:13px;color:#444;line-height:1.5;">${locAddrHtml}</div>
            </td>
            <td style="vertical-align:top;text-align:right;">
                <div style="font-size:22px;font-weight:bold;margin-bottom:10px;">Invoice</div>
                <table style="margin-left:auto;font-size:13px;">
                    <tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Invoice Number</td><td>#${esc(inv.invoiceNumber || "")}</td></tr>
                    <tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Invoice Date</td><td>${esc(invoiceDate)}</td></tr>
                    <tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Order Date</td><td>${esc(orderDate)}</td></tr>
                    ${inv.status ? `<tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Status</td><td>${esc(inv.status)}</td></tr>` : ""}
                </table>
            </td>
        </tr></table>

        <!-- Bill To / Pickup -->
        <table style="width:100%;margin-bottom:20px;"><tr>
            <td style="vertical-align:top;width:50%;">
                <div style="font-weight:bold;margin-bottom:4px;">Bill To</div>
                ${inv.customerName ? `<div style="font-weight:bold;">${esc(inv.customerName)}</div>` : ""}
                ${inv.email ? `<div style="font-size:13px;color:#444;">${esc(inv.email)}</div>` : ""}
                ${inv.phone ? `<div style="font-size:13px;color:#444;">${esc(inv.phone)}</div>` : ""}
                ${inv.companyName ? `<div style="font-size:13px;color:#444;">${esc(inv.companyName)}</div>` : ""}
            </td>
            <td style="vertical-align:top;">
                ${pickupHtml ? `<div style="font-weight:bold;margin-bottom:4px;">${delivery ? "Delivery Time" : "Pickup Time"}</div>
                <div style="font-size:13px;color:#444;line-height:1.5;">${pickupHtml}</div>` : ""}
            </td>
        </tr></table>

        <!-- Delivery address -->
        ${address ? `<div style="margin-bottom:20px;">
            <div style="font-weight:bold;margin-bottom:4px;">Delivery Address</div>
            <div style="font-size:13px;color:#444;">${esc(address)}</div>
        </div>` : ""}

        <!-- Order table -->
        <div style="font-size:18px;font-weight:bold;margin-bottom:8px;">Order</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead>
                <tr style="border-bottom:2px solid #222;">
                    <th style="text-align:center;padding:6px 4px;font-size:13px;width:40px;">Qty</th>
                    <th style="text-align:left;padding:6px 4px;font-size:13px;">Item</th>
                    <th style="text-align:left;padding:6px 4px;font-size:13px;"></th>
                </tr>
            </thead>
            <tbody>
                ${itemRows}
            </tbody>
        </table>

        <div style="margin-top:30px;font-size:11px;color:#bbb;border-top:1px solid #ddd;padding-top:10px;">Printed from DD Mau Staff Portal</div>
        </body></html>`;

        if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Invoice'); return; }
        const printWindow = window.open("", "_blank", "width=700,height=900");
        if (!printWindow) {
            toast(isEn
                ? "Please allow pop-ups to print invoices."
                : "Por favor permita ventanas emergentes para imprimir facturas.");
            return;
        }
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
    }, [location, isEn]);

    const triggerRefresh = async () => {
        setRefreshing(true);
        try {
            await setDoc(doc(db, "ops", "invoice_trigger"), {
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

    // Cleanup timeout and track mount state
    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
            if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
        };
    }, []);

    useEffect(() => {
        setLoading(true);
        setExpandedInvoice(null);
        // 2026-05-24 audit fix: was using limit(200) alone — Firestore
        // returns WHATEVER 200 the query plan picks (often the OLDEST
        // 200 once the collection grows past 200). Once Maryland has
        // accumulated 200+ historical invoices, the most recent ones
        // are silently dropped from the dashboard. Added explicit
        // orderBy(createdDate desc) so the cap consistently keeps the
        // newest. Composite index defined in firestore.indexes.json
        // (location + createdDate desc).
        const q = query(
            collection(db, "toast_invoices"),
            where("location", "==", location),
            orderBy("createdDate", "desc"),
            limit(200)
        );
        const unsub = onSnapshot(q, (snap) => {
            const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            // Identity-preserving update (2026-09-05 perf pass): the
            // scraper rewrites EVERY invoice doc each 30-min pass (only
            // syncedAt changes), which used to hand React 200 new
            // objects → full re-render of every card. Unchanged docs
            // keep their object, an unchanged list keeps the array.
            setInvoices(prev => reuseSnapshotDocs(prev, docs));
            setLoading(false);
        }, (err) => {
            console.error("Toast invoices query error:", err);
            if (err.message && err.message.includes("index")) {
                console.error("Create the composite index using the link above ^^^");
            }
            setLoading(false);
        });
        return () => unsub();
    }, [location]);

    // Group invoices by promised date (delivery/pickup date).
    // useMemo'd — with the identity-preserving listener above, this
    // only recomputes when the list genuinely changed, not on every
    // expand/collapse render.
    const { grouped, dates } = useMemo(() => {
        const grouped = {};
        invoices.forEach(inv => {
            let d = "No Date";
            if (inv.promisedDate) {
                d = inv.promisedDate.split("T")[0];
            } else if (inv.createdDate) {
                d = inv.createdDate.split("T")[0];
            }
            if (!grouped[d]) grouped[d] = [];
            grouped[d].push(inv);
        });
        const dates = Object.keys(grouped).sort().reverse();
        return { grouped, dates };
    }, [invoices]);

    const handleToggleCard = useCallback((guid) => {
        setExpandedInvoice(prev => (prev === guid ? null : guid));
    }, []);

    return (
        <div>
            <div className="flex justify-between items-center mb-3">
                <h2 className="text-xl font-bold text-mint-700">
                    🧾 {isEn ? "Catering Invoices" : "Facturas de Catering"}
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

            {/* Summary bar */}
            {!loading && invoices.length > 0 && (
                <div className="bg-mint-50 border-2 border-mint-200 rounded-lg p-3 mb-4">
                    <div>
                        <p className="text-sm font-bold text-mint-800">{invoices.length} {isEn ? "invoices" : "facturas"}</p>
                        <p className="text-xs text-mint-600">{dates.length} {isEn ? "dates" : "fechas"}</p>
                    </div>
                </div>
            )}

            {loading ? (
                <div className="text-center py-12">
                    <p className="text-3xl mb-2">⏳</p>
                    <p className="text-gray-400">{isEn ? "Loading invoices..." : "Cargando facturas..."}</p>
                </div>
            ) : invoices.length === 0 ? (
                <div className="text-center py-12">
                    <p className="text-3xl mb-2">📭</p>
                    <p className="text-gray-500 font-bold">{isEn ? "No invoices found" : "No se encontraron facturas"}</p>
                    <p className="text-xs text-gray-400 mt-2">{isEn ? "Invoices sync from Toast every 30 minutes." : "Las facturas se sincronizan desde Toast cada 30 minutos."}</p>
                </div>
            ) : (
                <div>
                    {dates.map(date => {
                        const dayInvoices = grouped[date];
                        return (
                            <div key={date} className="mb-5">
                                {/* Date header */}
                                <div className="flex justify-between items-center mb-2 sticky top-16 bg-gray-50 py-1.5 z-10 border-b-2 border-mint-200">
                                    <h3 className="text-sm font-bold text-gray-700">
                                        📅 {date !== "No Date" ? new Date(date + "T12:00:00").toLocaleDateString(isEn ? "en-US" : "es-US", { weekday: "short", month: "short", day: "numeric" }) : (isEn ? "No Date" : "Sin Fecha")}
                                    </h3>
                                    <span className="text-xs text-gray-400">{dayInvoices.length} {isEn ? "invoices" : "facturas"}</span>
                                </div>

                                {/* Invoice cards */}
                                {dayInvoices.map((inv, i) => (
                                    <InvoiceCard
                                        key={inv.invoiceGuid || i}
                                        inv={inv}
                                        expanded={expandedInvoice === inv.invoiceGuid}
                                        isEn={isEn}
                                        onToggle={handleToggleCard}
                                        onPrint={handlePrint}
                                    />
                                ))}
                            </div>
                        );
                    })}

                    <p className="text-xs text-gray-300 text-center mt-4 mb-2">
                        {isEn ? "Synced from Toast every 30 min" : "Sincronizado desde Toast cada 30 min"}
                    </p>
                </div>
            )}
        </div>
    );
}
