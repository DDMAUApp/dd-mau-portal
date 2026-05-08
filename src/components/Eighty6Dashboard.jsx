import { useState, useEffect } from 'react';
import { onSnapshot } from 'firebase/firestore';
import { doc, collection } from 'firebase/firestore';
import { db } from '../firebase';

export default function Eighty6Dashboard({ language, storeLocation }) {
    const [items, setItems] = useState([]);
    const [count, setCount] = useState(0);
    const [updatedAt, setUpdatedAt] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const docKey = `86_${storeLocation}`;
        const unsubscribe = onSnapshot(doc(db, "ops", docKey), (docSnapshot) => {
            if (docSnapshot.exists()) {
                const data = docSnapshot.data();
                setItems(data.items || []);
                setCount(data.count || 0);
                setUpdatedAt(data.updatedAt || null);
            } else {
                setItems([]);
                setCount(0);
                setUpdatedAt(null);
            }
            setLoading(false);
        });
        return () => unsubscribe();
    }, [storeLocation]);

    const formatTime = (isoStr) => {
        if (!isoStr) return "—";
        try {
            const d = new Date(isoStr);
            return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        } catch { return "—"; }
    };

    const locationLabel = storeLocation === "maryland" ? "Maryland Heights" : "Webster";

    return (
        <div className="pb-bottom-nav" style={{background: "#111827", minHeight: "100vh"}}>
            <div style={{background: "linear-gradient(135deg, #dc2626, #b91c1c)", padding: "24px 16px 20px", color: "white"}}>
                <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
                    <div>
                        <h2 style={{fontSize: "22px", fontWeight: 700, margin: 0}}>
                            {language === "es" ? "Items 86" : "86 Items"}
                        </h2>
                        <p style={{fontSize: "13px", opacity: 0.8, margin: "4px 0 0"}}>
                            {locationLabel} — {language === "es" ? "Agotados" : "Out of Stock"}
                        </p>
                    </div>
                    <div style={{background: "rgba(255,255,255,0.2)", borderRadius: "12px", padding: "8px 16px", textAlign: "center"}}>
                        <p style={{fontSize: "28px", fontWeight: 800, margin: 0}}>{count}</p>
                        <p style={{fontSize: "10px", opacity: 0.8, margin: 0}}>{language === "es" ? "items" : "items"}</p>
                    </div>
                </div>
            </div>

            <div style={{padding: "16px"}}>
                {loading ? (
                    <div style={{textAlign: "center", padding: "40px", color: "#9ca3af"}}>
                        <p style={{fontSize: "16px"}}>{language === "es" ? "Cargando..." : "Loading..."}</p>
                    </div>
                ) : items.length === 0 ? (
                    <div style={{textAlign: "center", padding: "40px"}}>
                        <div style={{fontSize: "48px", marginBottom: "12px"}}>✅</div>
                        <p style={{fontSize: "18px", fontWeight: 700, color: "#34d399", margin: 0}}>
                            {language === "es" ? "¡Todo disponible!" : "All items available!"}
                        </p>
                        <p style={{fontSize: "13px", color: "#6b7280", margin: "8px 0 0"}}>
                            {language === "es" ? "No hay items 86 en este momento" : "No 86'd items right now"}
                        </p>
                    </div>
                ) : (
                    <div style={{display: "flex", flexDirection: "column", gap: "8px"}}>
                        {items.map((item, idx) => (
                            <div key={idx} style={{
                                background: "#1f2937",
                                borderRadius: "12px",
                                padding: "14px 16px",
                                border: item.status === "OUT_OF_STOCK" ? "1px solid #ef4444" : "1px solid #f59e0b",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                            }}>
                                <div style={{flex: 1}}>
                                    <p style={{fontSize: "15px", fontWeight: 700, color: "#f9fafb", margin: 0}}>
                                        {item.name}
                                    </p>
                                </div>
                                <div style={{
                                    background: item.status === "OUT_OF_STOCK" ? "#7f1d1d" : "#78350f",
                                    color: item.status === "OUT_OF_STOCK" ? "#fca5a5" : "#fde68a",
                                    borderRadius: "8px",
                                    padding: "4px 10px",
                                    fontSize: "11px",
                                    fontWeight: 700,
                                    whiteSpace: "nowrap",
                                }}>
                                    {item.status === "OUT_OF_STOCK"
                                        ? (language === "es" ? "AGOTADO" : "86'd")
                                        : (language === "es" ? `Quedan ${item.quantity}` : `${item.quantity} left`)}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {updatedAt && (
                    <p style={{fontSize: "11px", color: "#6b7280", textAlign: "center", margin: "16px 0 0"}}>
                        {language === "es" ? "Actualizado" : "Updated"}: {formatTime(updatedAt)}
                    </p>
                )}
            </div>
        </div>
    );
}
