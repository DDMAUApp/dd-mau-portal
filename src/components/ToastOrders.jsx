import { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import { collection, query, where, limit, onSnapshot, doc, setDoc, serverTimestamp } from 'firebase/firestore';

export default function ToastOrders({ language }) {
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [location, setLocation] = useState("webster");
    const [expandedOrder, setExpandedOrder] = useState(null);
    const [refreshing, setRefreshing] = useState(false);
    const [lastSync, setLastSync] = useState(null);

    const isEn = language !== "es";

    const refreshTimeoutRef = useRef(null);

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
        refreshTimeoutRef.current = setTimeout(() => setRefreshing(false), 3000);
    };

    // Auto-refresh every 60 seconds
    useEffect(() => {
        const interval = setInterval(() => {
            triggerRefresh();
        }, 60000);
        return () => {
            clearInterval(interval);
            if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
        };
    }, []);

    useEffect(() => {
        setLoading(true);
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
            setOrders(docs);
            setLoading(false);
            if (docs.length > 0 && docs[0].syncedAt) {
                setLastSync(docs[0].syncedAt);
            }
        }, (err) => {
            console.error("Toast orders query error:", err);
            setLoading(false);
        });
        return () => unsub();
    }, [location]);

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

    const handlePrint = (ord) => {
        const locName = location === "webster" ? "Big Bend Blvd" : "Dorsett Rd";
        const locAddr = location === "webster"
            ? "8148 Big Bend Blvd<br>Webster Groves, MO 63119<br>(314) 968-3275"
            : "11982 Dorsett Rd<br>Maryland Heights, MO 63034<br>(314) 942-2300";

        const timeStr = ord.createdDate
            ? new Date(ord.createdDate).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
            : "";
        const promisedStr = ord.promisedDate
            ? new Date(ord.promisedDate).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
            : "";

        const itemRows = (ord.items || []).map(item => {
            const modsHtml = item.modifiers && item.modifiers.length > 0
                ? item.modifiers.map(m => `<div style="padding-left:4px;color:#555;font-size:12px;">${m}</div>`).join("")
                : "";
            return `<tr style="border-bottom:1px solid #e5e5e5;">
                <td style="padding:8px 4px;text-align:center;vertical-align:top;width:40px;font-weight:600;">${item.qty}</td>
                <td style="padding:8px 4px;font-weight:600;vertical-align:top;">${item.name}</td>
                <td style="padding:8px 4px;vertical-align:top;font-size:13px;">${modsHtml}</td>
            </tr>`;
        }).join("");

        const html = `<!DOCTYPE html><html><head><title>Order #${ord.orderNumber || ""}</title>
        <style>
            body { font-family: Arial, Helvetica, sans-serif; max-width:700px; margin:0 auto; padding:30px 40px; color:#222; font-size:14px; }
            .no-print { position:sticky;top:0;z-index:1000;background:#255a37;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3) }
            .no-print button { padding:12px 24px; font-size:16px; font-weight:bold; border:none; border-radius:8px; cursor:pointer; margin:0 6px; }
            .btn-print { background:white; color:#255a37; } .btn-close { background:#ff4444; color:white; }
            @media print { body { padding:20px; } .no-print { display:none !important; } }
        </style></head>
        <body>
        <div class="no-print">
            <button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://ddmauapp.github.io/dd-mau-portal/'}},300)">✕ Close</button>
            <button class="btn-print" onclick="window.print()">🖨️ Print</button>
        </div>
        <table style="width:100%;margin-bottom:20px;"><tr>
            <td style="vertical-align:top;width:50%;">
                <div style="font-size:20px;font-weight:bold;color:#333;margin-bottom:2px;">DD Mau</div>
                <div style="font-size:11px;color:#888;margin-bottom:12px;">Vietnamese Eatery</div>
                <div style="font-size:16px;font-weight:bold;margin-bottom:8px;">${locName}</div>
                <div style="font-size:13px;color:#444;line-height:1.5;">${locAddr}</div>
            </td>
            <td style="vertical-align:top;text-align:right;">
                <div style="font-size:22px;font-weight:bold;margin-bottom:10px;">Order</div>
                <table style="margin-left:auto;font-size:13px;">
                    <tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Order #</td><td>${ord.orderNumber || ""}</td></tr>
                    ${ord.orderType ? `<tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Type</td><td>${ord.orderType}</td></tr>` : ""}
                    ${timeStr ? `<tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Placed</td><td>${timeStr}</td></tr>` : ""}
                    ${ord.status ? `<tr><td style="text-align:right;font-weight:bold;padding:2px 10px;">Status</td><td>${ord.status}</td></tr>` : ""}
                </table>
            </td>
        </tr></table>

        ${ord.customerName ? `<div style="margin-bottom:16px;"><div style="font-weight:bold;margin-bottom:4px;">Customer</div><div style="font-size:13px;">${ord.customerName}</div>${ord.phone ? `<div style="font-size:13px;color:#444;">${ord.phone}</div>` : ""}</div>` : ""}
        ${promisedStr ? `<div style="margin-bottom:16px;"><div style="font-weight:bold;margin-bottom:4px;">${ord.address ? "Delivery Time" : "Pickup Time"}</div><div style="font-size:13px;">${promisedStr}</div></div>` : ""}
        ${ord.address ? `<div style="margin-bottom:16px;"><div style="font-weight:bold;margin-bottom:4px;">Delivery Address</div><div style="font-size:13px;">${ord.address}</div></div>` : ""}

        <div style="font-size:18px;font-weight:bold;margin-bottom:8px;">Order</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="border-bottom:2px solid #222;">
                <th style="text-align:center;padding:6px 4px;font-size:13px;width:40px;">Qty</th>
                <th style="text-align:left;padding:6px 4px;font-size:13px;">Item</th>
                <th style="text-align:left;padding:6px 4px;font-size:13px;"></th>
            </tr></thead>
            <tbody>${itemRows}</tbody>
        </table>

        ${ord.specialInstructions ? `<div style="margin-top:16px;padding:8px;background:#f5f5f5;border-radius:4px;font-size:13px;"><strong>Notes:</strong> ${ord.specialInstructions}</div>` : ""}
        <div style="margin-top:30px;font-size:11px;color:#bbb;border-top:1px solid #ddd;padding-top:10px;">Printed from DD Mau Staff Portal</div>
        </body></html>`;

        const printWindow = window.open("", "_blank", "width=700,height=900");
        printWindow.document.write(html);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
    };

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

            {/* Summary bar */}
            {!loading && orders.length > 0 && (
                <div className="bg-mint-50 border-2 border-mint-200 rounded-lg p-3 mb-4">
                    <div className="flex justify-between items-center">
                        <div>
                            <p className="text-sm font-bold text-mint-800">{orders.length} {isEn ? "orders today" : "pedidos hoy"}</p>
                            <p className="text-xs text-mint-600">{isEn ? "Takeout, delivery & online" : "Para llevar, entrega y en línea"}</p>
                        </div>
                        {lastSync && (
                            <p className="text-xs text-mint-500">{isEn ? "Synced" : "Sincronizado"} {new Date(lastSync).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</p>
                        )}
                    </div>
                </div>
            )}

            {loading ? (
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
                        const expanded = expandedOrder === ord.orderGuid;
                        const timeStr = ord.createdDate
                            ? new Date(ord.createdDate).toLocaleTimeString(isEn ? "en-US" : "es-US", { hour: "numeric", minute: "2-digit" })
                            : "";

                        return (
                            <div key={ord.orderGuid || i}
                                className={`bg-white border-2 rounded-lg p-3 mb-2 cursor-pointer transition ${expanded ? "border-mint-400 shadow-md" : "border-gray-200 hover:border-mint-300"}`}
                                onClick={() => setExpandedOrder(expanded ? null : ord.orderGuid)}>

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
                                                    {new Date(ord.promisedDate).toLocaleString(isEn ? "en-US" : "es-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
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

                                        {/* Print button */}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handlePrint(ord); }}
                                            className="mt-3 w-full py-2 rounded-lg text-sm font-bold border-2 border-mint-300 text-mint-700 bg-white hover:bg-mint-50 transition">
                                            🖨️ {isEn ? "Print Order" : "Imprimir Pedido"}
                                        </button>
                                    </div>
                                )}
                            </div>
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
