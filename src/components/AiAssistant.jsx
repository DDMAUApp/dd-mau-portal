import { useState, useRef, useEffect } from 'react';

// ── CONFIG ──
const AI_ROUTER_URL = "https://dd-mau-ai-router-production.up.railway.app";

// Quick-action prompts for staff
const QUICK_ACTIONS = {
    en: [
        { icon: "📦", label: "Inventory help", prompt: "Help me with inventory — what should I check or reorder based on typical DD Mau usage patterns?" },
        { icon: "📋", label: "Checklist guide", prompt: "Walk me through the opening checklist for today. What are the most important things to check?" },
        { icon: "🍜", label: "Menu questions", prompt: "A customer is asking about our menu. What are our most popular items and what dietary options do we have?" },
        { icon: "🌶️", label: "Allergen info", prompt: "A customer is asking about allergens. What allergen information should I know about our menu items?" },
        { icon: "💬", label: "Customer help", prompt: "A customer has a complaint. Help me handle it professionally and make them happy." },
        { icon: "🔄", label: "Translate", prompt: "I need help translating something for a customer or coworker. I'll tell you what to translate." },
        { icon: "📊", label: "Operations tips", prompt: "Give me tips on running a smooth shift today — labor management, food safety, speed of service." },
        { icon: "🧑‍🍳", label: "Recipe help", prompt: "I have a question about one of our recipes or prep procedures." },
    ],
    es: [
        { icon: "📦", label: "Inventario", prompt: "Ayudame con el inventario — que debo revisar o reordenar segun los patrones tipicos de DD Mau?" },
        { icon: "📋", label: "Checklists", prompt: "Guiame por la lista de apertura de hoy. Cuales son las cosas mas importantes?" },
        { icon: "🍜", label: "Menu", prompt: "Un cliente pregunta sobre nuestro menu. Cuales son los platos mas populares y opciones dieteticas?" },
        { icon: "🌶️", label: "Alergenos", prompt: "Un cliente pregunta sobre alergenos. Que informacion de alergenos debo saber sobre nuestro menu?" },
        { icon: "💬", label: "Cliente", prompt: "Un cliente tiene una queja. Ayudame a manejarla profesionalmente." },
        { icon: "🔄", label: "Traducir", prompt: "Necesito ayuda para traducir algo para un cliente o companero." },
        { icon: "📊", label: "Operaciones", prompt: "Dame consejos para un turno eficiente — manejo de personal, seguridad alimentaria, velocidad de servicio." },
        { icon: "🧑‍🍳", label: "Recetas", prompt: "Tengo una pregunta sobre una de nuestras recetas o procedimientos de preparacion." },
    ],
};

export default function AiAssistant({ language, staffName, storeLocation }) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [routerStatus, setRouterStatus] = useState(null); // null | "ok" | "down"
    const [lastModel, setLastModel] = useState(null);
    const [error, setError] = useState(null);
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

    const isEs = language === "es";

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, loading]);

    // Check router health on mount
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${AI_ROUTER_URL}/health`, { signal: AbortSignal.timeout(8000) });
                if (res.ok) {
                    const data = await res.json();
                    setRouterStatus(data.available_models > 0 ? "ok" : "down");
                } else {
                    setRouterStatus("down");
                }
            } catch {
                setRouterStatus("down");
            }
        })();
    }, []);

    // Build conversation history for context
    const buildConversation = () => {
        return messages.map(m => ({
            role: m.role,
            content: m.content,
        }));
    };

    // Send message to AI Router
    const sendMessage = async (text) => {
        if (!text.trim() || loading) return;

        const userMsg = { role: "user", content: text.trim(), timestamp: Date.now() };
        setMessages(prev => [...prev, userMsg]);
        setInput("");
        setLoading(true);
        setError(null);

        try {
            const conversation = buildConversation();

            const systemPrompt = [
                "You are DD Mau's AI assistant, helping staff at a Vietnamese restaurant in St. Louis.",
                "The restaurant has two locations: Webster Groves and Maryland Heights.",
                `The staff member talking to you is ${staffName || "a team member"}${storeLocation ? ` at the ${storeLocation} location` : ""}.`,
                `Respond in ${isEs ? "Spanish" : "English"}.`,
                "Be concise, helpful, and friendly. Use restaurant industry knowledge.",
                "For food safety questions, always reference proper HACCP guidelines.",
                "If asked about specific DD Mau recipes or proprietary information you don't know, say so honestly.",
            ].join(" ");

            const res = await fetch(`${AI_ROUTER_URL}/route`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: text.trim(),
                    conversation: conversation,
                    system: systemPrompt,
                }),
                signal: AbortSignal.timeout(120000),
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.detail || `Router returned ${res.status}`);
            }

            const data = await res.json();

            setLastModel(data.models_used?.[0] || data.model || null);

            const assistantMsg = {
                role: "assistant",
                content: data.response,
                timestamp: Date.now(),
                model: data.models_used?.[0] || data.model,
                strategy: data.strategy,
                latency: data.latency_ms,
            };
            setMessages(prev => [...prev, assistantMsg]);

        } catch (err) {
            console.error("AI Router error:", err);
            const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
            const errMsg = isTimeout
                ? (isEs ? "La solicitud tomo demasiado tiempo. Intenta de nuevo." : "Request timed out. Try again.")
                : (isEs ? `Error: ${err.message}` : `Error: ${err.message}`);
            setError(errMsg);
            // Add error as a system message
            setMessages(prev => [...prev, {
                role: "assistant",
                content: isEs
                    ? "Lo siento, hubo un problema al procesar tu solicitud. Por favor intenta de nuevo."
                    : "Sorry, there was a problem processing your request. Please try again.",
                timestamp: Date.now(),
                isError: true,
            }]);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        sendMessage(input);
    };

    const handleQuickAction = (prompt) => {
        sendMessage(prompt);
    };

    const clearChat = () => {
        setMessages([]);
        setError(null);
        setLastModel(null);
    };

    const quickActions = QUICK_ACTIONS[isEs ? "es" : "en"];

    return (
        <div className="pb-24" style={{ minHeight: "100vh", background: "#f9fafb" }}>
            {/* Header */}
            <div style={{
                background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
                padding: "16px",
                color: "white",
            }}>
                <div className="flex items-center justify-between">
                    <div>
                        <h2 style={{ fontSize: "18px", fontWeight: 700, margin: 0 }}>
                            {isEs ? "🤖 Asistente AI" : "🤖 AI Assistant"}
                        </h2>
                        <p style={{ fontSize: "12px", opacity: 0.8, margin: "2px 0 0" }}>
                            {isEs ? "Preguntame lo que sea — inventario, menu, operaciones" : "Ask me anything — inventory, menu, operations"}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {routerStatus === "ok" && (
                            <span style={{ fontSize: "10px", background: "rgba(255,255,255,0.2)", padding: "3px 8px", borderRadius: "12px" }}>
                                {"\u{1F7E2}"} Online
                            </span>
                        )}
                        {routerStatus === "down" && (
                            <span style={{ fontSize: "10px", background: "rgba(255,0,0,0.3)", padding: "3px 8px", borderRadius: "12px" }}>
                                {"\u{1F534}"} Offline
                            </span>
                        )}
                        {messages.length > 0 && (
                            <button onClick={clearChat}
                                style={{ fontSize: "11px", background: "rgba(255,255,255,0.2)", padding: "4px 10px", borderRadius: "8px", border: "none", color: "white", cursor: "pointer", fontWeight: 600 }}>
                                {isEs ? "Limpiar" : "Clear"}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Router down warning */}
            {routerStatus === "down" && (
                <div style={{ margin: "12px 16px", padding: "12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "12px" }}>
                    <p style={{ fontSize: "13px", fontWeight: 600, color: "#dc2626", margin: 0 }}>
                        {isEs ? "\u{26A0}\u{FE0F} El servicio AI no esta disponible ahora" : "\u{26A0}\u{FE0F} AI service is currently unavailable"}
                    </p>
                    <p style={{ fontSize: "11px", color: "#9ca3af", margin: "4px 0 0" }}>
                        {isEs ? "El router AI podria estar reiniciandose. Intenta en unos minutos." : "The AI router may be restarting. Try again in a few minutes."}
                    </p>
                </div>
            )}

            {/* Chat area */}
            <div style={{ padding: "12px 16px", minHeight: "300px" }}>
                {/* Welcome state — show quick actions */}
                {messages.length === 0 && (
                    <div>
                        <p style={{ fontSize: "14px", color: "#6b7280", textAlign: "center", margin: "16px 0 12px" }}>
                            {isEs ? "Hola! Como puedo ayudarte hoy?" : "Hi! How can I help you today?"}
                        </p>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                            {quickActions.map((qa, i) => (
                                <button key={i} onClick={() => handleQuickAction(qa.prompt)}
                                    disabled={loading || routerStatus === "down"}
                                    style={{
                                        background: "white", border: "1px solid #e5e7eb", borderRadius: "12px",
                                        padding: "12px 10px", textAlign: "left", cursor: "pointer",
                                        opacity: routerStatus === "down" ? 0.5 : 1,
                                        transition: "all 0.15s",
                                    }}
                                    onMouseOver={(e) => e.currentTarget.style.borderColor = "#7c3aed"}
                                    onMouseOut={(e) => e.currentTarget.style.borderColor = "#e5e7eb"}
                                >
                                    <span style={{ fontSize: "20px" }}>{qa.icon}</span>
                                    <p style={{ fontSize: "12px", fontWeight: 600, color: "#374151", margin: "4px 0 0" }}>{qa.label}</p>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* Messages */}
                {messages.map((msg, i) => (
                    <div key={i} style={{
                        marginBottom: "12px",
                        display: "flex",
                        justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                    }}>
                        <div style={{
                            maxWidth: "85%",
                            padding: "10px 14px",
                            borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                            background: msg.role === "user" ? "#7c3aed" : msg.isError ? "#fef2f2" : "white",
                            color: msg.role === "user" ? "white" : msg.isError ? "#dc2626" : "#1f2937",
                            border: msg.role === "user" ? "none" : msg.isError ? "1px solid #fecaca" : "1px solid #e5e7eb",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                        }}>
                            <div style={{ fontSize: "14px", lineHeight: "1.5", whiteSpace: "pre-wrap" }}>
                                {msg.content}
                            </div>
                            {msg.role === "assistant" && !msg.isError && msg.model && (
                                <div style={{ fontSize: "10px", color: "#9ca3af", marginTop: "6px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                    <span>{msg.model}</span>
                                    {msg.strategy && msg.strategy !== "auto" && <span>{"\u{2022}"} {msg.strategy}</span>}
                                    {msg.latency && <span>{"\u{2022}"} {(msg.latency / 1000).toFixed(1)}s</span>}
                                </div>
                            )}
                        </div>
                    </div>
                ))}

                {/* Loading indicator */}
                {loading && (
                    <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: "12px" }}>
                        <div style={{
                            padding: "12px 18px", borderRadius: "16px 16px 16px 4px",
                            background: "white", border: "1px solid #e5e7eb",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                        }}>
                            <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                                <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#7c3aed", animation: "pulse 1.2s ease-in-out infinite" }} />
                                <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#7c3aed", animation: "pulse 1.2s ease-in-out infinite 0.2s" }} />
                                <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#7c3aed", animation: "pulse 1.2s ease-in-out infinite 0.4s" }} />
                                <span style={{ fontSize: "12px", color: "#9ca3af", marginLeft: "8px" }}>
                                    {isEs ? "Pensando..." : "Thinking..."}
                                </span>
                            </div>
                            <style>{`@keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.2); } }`}</style>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input area — fixed above bottom nav */}
            <div style={{
                position: "fixed",
                bottom: "80px",
                left: 0, right: 0,
                background: "white",
                borderTop: "1px solid #e5e7eb",
                padding: "8px 12px",
                zIndex: 40,
            }}>
                <form onSubmit={handleSubmit} style={{ maxWidth: "32rem", margin: "0 auto", display: "flex", gap: "8px" }}>
                    <input
                        ref={inputRef}
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={isEs ? "Escribe tu pregunta..." : "Type your question..."}
                        disabled={loading || routerStatus === "down"}
                        style={{
                            flex: 1,
                            padding: "10px 14px",
                            borderRadius: "12px",
                            border: "1px solid #d1d5db",
                            fontSize: "14px",
                            outline: "none",
                            background: routerStatus === "down" ? "#f3f4f6" : "white",
                        }}
                        onFocus={(e) => e.target.style.borderColor = "#7c3aed"}
                        onBlur={(e) => e.target.style.borderColor = "#d1d5db"}
                    />
                    <button
                        type="submit"
                        disabled={!input.trim() || loading || routerStatus === "down"}
                        style={{
                            padding: "10px 16px",
                            borderRadius: "12px",
                            border: "none",
                            background: !input.trim() || loading ? "#d1d5db" : "#7c3aed",
                            color: "white",
                            fontWeight: 700,
                            fontSize: "14px",
                            cursor: !input.trim() || loading ? "default" : "pointer",
                            transition: "background 0.15s",
                        }}
                    >
                        {loading ? "..." : (isEs ? "Enviar" : "Send")}
                    </button>
                </form>
                {error && (
                    <p style={{ fontSize: "11px", color: "#dc2626", textAlign: "center", margin: "4px 0 0" }}>{error}</p>
                )}
            </div>
        </div>
    );
}
