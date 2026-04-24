import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore';

export default function ToastInvoices({ language }) {
    const [orders, setOrders] = useState([]);
    const [loading, setLoading] = useState(true);
    const [location, setLocation] = useState("webster");
    const [expandedOrder, setExpandedOrder] = useState(null);

    const isEn = language !== "es";

    useEffect(() => {
        setLoading(true);
        setExpandedOrder(null);
        // Composite index needed: location (ASC) + createdDate (DESC)
        // On first load, Firestore console will show a link to create it
        const q = query(
            collection(db, "toast_invoices"),
            where("location", "==", location),
            orderBy("createdDate", "desc"),
            limit(300)
        );
        const unsub = onSnapshot(q, (snap) => {
            setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            setLoading(false);
        }, (err) => {
            console.error("Toast invoices query error:", err);
            // If composite index missing, show helpful message
            if (err.message && err.message.includes("index")) {
                console.error("Create the composite index using the link above ^^^");
            }
            setLoading(false);
        });
        return () => unsub();
    }, [location]);

    // Group orders by business date
    const grouped = {};
    orders.forEach(o => {
        const d = o.businessDate || "Unknown";
        if (!grouped[d]) grouped[d] = [];
        grouped[d].push(o);
    });
    const dates = Object.keys(grouped).sort().reverse();

    // Calculate totals
    const grandTotal = orders.reduce((sum, o) => sum + (o.total || 0), 0);
    const orderCount = orders.length;

    return (
        <div>
            <h2 className="text-xl font-bold text-mint-700 mb-3">
                🧾 {isEn ? "Toast Orders" : "Pedidos de Toast"}
            </h2>

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
                <div className="bg-mint-50 border-2 border-mint-200 rounded-lg p-3 mb-4 flex justify-between items-center">
                    <div>
                        <p className="text-sm font-bold text-mint-800">{orderCount} {isEn ? "orders" : "pedidos"}</p>
                        <p className="text-xs text-mint-600">{dates.length} {isEn ? "days" : "días"}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-lg font-bold text-mint-800">${grandTotal.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
                        <p className="text-xs text-mint-600">{isEn ? "total sales" : "ventas totales"}</p>
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
                    <p className="text-gray-500 font-bold">{isEn ? "No orders found" : "No se encontraron pedidos"}</p>
                    <p className="text-xs text-gray-400 mt-2">{isEn ? "Orders sync from Toast every 30 minutes." : "Los pedidos se sincronizan desde Toast cada 30 minutos."}</p>
                    <p className="text-xs text-gray-400 mt-1">{isEn ? "Make sure the scraper is running on Railway." : "Asegúrate de que el scraper esté corriendo en Railway."}</p>
                </div>
            ) : (
                <div>
                    {dates.map(date => {
                        const dayOrders = grouped[date];
                        const dayTotal = dayOrders.reduce((s, o) => s + (o.total || 0), 0);

                        return (
                            <div key={date} className="mb-5">
                                {/* Date header */}
                                <div className="flex justify-between items-center mb-2 sticky top-16 bg-gray-50 py-1.5 z-10 border-b-2 border-mint-200">
                                    <h3 className="text-sm font-bold text-gray-700">
                                        📅 {new Date(date + "T12:00:00").toLocaleDateString(isEn ? "en-US" : "es-US", { weekday: "short", month: "short", day: "numeric" })}
                                    </h3>
                                    <div className="text-right">
                                        <span className="text-xs text-gray-400 mr-2">{dayOrders.length} {isEn ? "orders" : "pedidos"}</span>
                                        <span className="text-sm font-bold text-mint-700">${dayTotal.toFixed(2)}</span>
                                    </div>
                                </div>

                                {/* Order cards */}
                                {dayOrders.map((order, i) => {
                                    const expanded = expandedOrder === order.guid;
                                    let timeStr = "—";
                                    try {
                                        if (order.createdDate) {
                                            const dt = new Date(order.createdDate.replace("+0000", "Z"));
                                            timeStr = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                        }
                                    } catch(e) {}

                                    return (
                                        <div key={order.guid || i}
                                            className={`bg-white border-2 rounded-lg p-3 mb-2 cursor-pointer transition ${expanded ? "border-mint-400 shadow-md" : "border-gray-200 hover:border-mint-300"}`}
                                            onClick={() => setExpandedOrder(expanded ? null : order.guid)}>
                                            <div className="flex justify-between items-start">
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <p className="text-sm font-bold text-gray-800">{timeStr}</p>
                                                        <span className="text-xs text-gray-300">#{order.guid?.slice(-6).toUpperCase()}</span>
                                                    </div>
                                                    <p className="text-xs text-gray-500 mt-1">
                                                        {order.diningOption || "—"} • {order.itemCount || 0} {isEn ? "items" : "artículos"} • {order.checkCount || 1} {isEn ? "check(s)" : "cuenta(s)"}
                                                    </p>
                                                    {!expanded && order.itemNames && order.itemNames.length > 0 && (
                                                        <p className="text-xs text-gray-400 mt-1 truncate">
                                                            {order.itemNames.slice(0, 3).join(", ")}
                                                            {order.itemCount > 3 ? ` +${order.itemCount - 3}` : ""}
                                                        </p>
                                                    )}
                                                </div>
                                                <div className="text-right ml-2">
                                                    <p className="font-bold text-mint-700 text-base">${order.total?.toFixed(2)}</p>
                                                    <span className={`text-xs px-2 py-0.5 rounded-full font-bold inline-block mt-1 ${order.paymentStatus === "CLOSED" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                                                        {order.paymentStatus || "OPEN"}
                                                    </span>
                                                </div>
                                            </div>

                                            {/* Expanded item list */}
                                            {expanded && order.itemNames && order.itemNames.length > 0 && (
                                                <div className="mt-3 pt-3 border-t border-gray-100">
                                                    <p className="text-xs font-bold text-gray-500 mb-1.5">{isEn ? "Items:" : "Artículos:"}</p>
                                                    <div className="grid grid-cols-1 gap-1">
                                                        {order.itemNames.map((name, ni) => (
                                                            <p key={ni} className="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">• {name}</p>
                                                        ))}
                                                    </div>
                                                    {order.itemCount > order.itemNames.length && (
                                                        <p className="text-xs text-gray-400 italic mt-1">+{order.itemCount - order.itemNames.length} {isEn ? "more items" : "más artículos"}</p>
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
