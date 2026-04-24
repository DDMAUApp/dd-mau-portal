import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, limit, onSnapshot, doc, setDoc, serverTimestamp } from 'firebase/firestore';

export default function ToastInvoices({ language }) {
    const [invoices, setInvoices] = useState([]);
    const [loading, setLoading] = useState(true);
    const [location, setLocation] = useState("webster");
    const [expandedInvoice, setExpandedInvoice] = useState(null);
    const [refreshing, setRefreshing] = useState(false);

    const isEn = language !== "es";

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
        setTimeout(() => setRefreshing(false), 3000);
    };

    useEffect(() => {
        setLoading(true);
        setExpandedInvoice(null);
        const q = query(
            collection(db, "toast_invoices"),
            where("location", "==", location),
            limit(200)
        );
        const unsub = onSnapshot(q, (snap) => {
            const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            docs.sort((a, b) => (b.createdDate || "").localeCompare(a.createdDate || ""));
            setInvoices(docs);
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

    // Group invoices by promised date (delivery/pickup date)
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

    const statusColor = (status) => {
        if (!status) return "bg-gray-100 text-gray-600";
        const s = status.toUpperCase();
        if (s === "PAID" || s === "CLOSED") return "bg-green-100 text-green-700";
        if (s === "SENT" || s === "OPEN") return "bg-blue-100 text-blue-700";
        if (s === "OVERDUE" || s === "PAST_DUE") return "bg-red-100 text-red-700";
        if (s === "DRAFT") return "bg-gray-100 text-gray-500";
        return "bg-amber-100 text-amber-700";
    };

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
                                {dayInvoices.map((inv, i) => {
                                    const expanded = expandedInvoice === inv.invoiceGuid;

                                    return (
                                        <div key={inv.invoiceGuid || i}
                                            className={`bg-white border-2 rounded-lg p-3 mb-2 cursor-pointer transition ${expanded ? "border-mint-400 shadow-md" : "border-gray-200 hover:border-mint-300"}`}
                                            onClick={() => setExpandedInvoice(expanded ? null : inv.invoiceGuid)}>

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
                                                            {inv.address ? ` • 📍 ${isEn ? "Delivery" : "Entrega"}` : ""}
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
                                                    {inv.address && (
                                                        <div className="mb-3">
                                                            <p className="text-xs font-bold text-gray-500 mb-1">{isEn ? "Delivery Address:" : "Dirección de Entrega:"}</p>
                                                            <p className="text-xs text-gray-600 bg-blue-50 rounded px-2 py-1.5">📍 {inv.address}</p>
                                                        </div>
                                                    )}

                                                    {/* Dates */}
                                                    <div className="mb-3 flex gap-4">
                                                        {inv.promisedDate && (
                                                            <div>
                                                                <p className="text-xs font-bold text-gray-500">{isEn ? "Due:" : "Fecha:"}</p>
                                                                <p className="text-xs text-gray-600">
                                                                    {new Date(inv.promisedDate).toLocaleDateString(isEn ? "en-US" : "es-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                                                </p>
                                                            </div>
                                                        )}
                                                        {inv.paymentDueDate && (
                                                            <div>
                                                                <p className="text-xs font-bold text-gray-500">{isEn ? "Payment Due:" : "Pago:"}</p>
                                                                <p className="text-xs text-gray-600">
                                                                    {new Date(inv.paymentDueDate).toLocaleDateString(isEn ? "en-US" : "es-US", { month: "short", day: "numeric" })}
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
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
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
