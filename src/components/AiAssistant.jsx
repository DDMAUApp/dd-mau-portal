import { useState, useRef, useEffect, useMemo } from 'react';
import { buildKnowledgeContext, getKnowledgeStats } from '../data/aiContext';

// ── CONFIG ──
const AI_ROUTER_URL = "https://dd-mau-ai-router-production.up.railway.app";

// Quick-action prompts for staff — DD Mau aware (the AI gets full context now,
// so prompts can reference real menu items, modules, recipes, frameworks).
const QUICK_ACTIONS = {
    en: [
        { icon: "🌶️", label: "Allergen lookup", prompt: "A guest is asking about allergens. Walk me through what to check on our allergen matrix and what to ask them." },
        { icon: "🍜", label: "Menu help", prompt: "What are our most popular items, dietary options, and how do I describe pho, banh mi, and lo mein to a curious guest?" },
        { icon: "📚", label: "Training topic", prompt: "I want to brush up on a topic. Which training modules should I revisit and what are the key takeaways?" },
        { icon: "🧑‍🍳", label: "Recipe lookup", prompt: "Help me find a recipe in our master recipe book. Tell me which category it's in and what to look for." },
        { icon: "💬", label: "Customer complaint", prompt: "A customer has a complaint. Walk me through RESTORE step by step and what I should hand off to the Shift Lead." },
        { icon: "🚦", label: "Shift speed tips", prompt: "Give me tips for running a smooth shift today — Bright 4, 10-Second Rule, station discipline." },
        { icon: "🥡", label: "Pho ordering", prompt: "Walk me through the pho ordering process — what sizes, what proteins, what comes on the plate, and what to ask the guest." },
        { icon: "🔄", label: "Translate", prompt: "I need help translating something between English and Spanish for a coworker or guest. I'll tell you what to translate." },
    ],
    es: [
        { icon: "🌶️", label: "Alérgenos", prompt: "Un cliente pregunta sobre alérgenos. Guíame por la matriz de alérgenos y qué preguntarle." },
        { icon: "🍜", label: "Menú", prompt: "¿Cuáles son nuestros platos más populares, opciones dietéticas, y cómo describo pho, banh mi y lo mein a un cliente curioso?" },
        { icon: "📚", label: "Entrenamiento", prompt: "Quiero repasar un tema. ¿Qué módulos de entrenamiento debo revisar y cuáles son los puntos clave?" },
        { icon: "🧑‍🍳", label: "Recetas", prompt: "Ayúdame a encontrar una receta en nuestro libro maestro. Dime en qué categoría está y qué buscar." },
        { icon: "💬", label: "Queja de cliente", prompt: "Un cliente tiene una queja. Guíame por RESTORE paso a paso y qué entregarle al líder." },
        { icon: "🚦", label: "Turno rápido", prompt: "Dame consejos para un turno fluido hoy — Bright 4, Regla de 10 Segundos, disciplina de estación." },
        { icon: "🥡", label: "Ordenar pho", prompt: "Guíame por el proceso de ordenar pho — qué tamaños, qué proteínas, qué lleva el plato, y qué preguntarle al cliente." },
        { icon: "🔄", label: "Traducir", prompt: "Necesito ayuda para traducir algo entre inglés y español para un compañero o cliente. Yo te diré qué traducir." },
    ],
};

// Chat history is keyed BY STAFF NAME so two people sharing a tablet don't
// see each other's chats. Old global key is migrated/cleared the first time
// we run.
const HISTORY_KEY_BASE = "ddmau:aiChatHistory";
const MAX_HISTORY_MESSAGES = 50; // hard cap so localStorage doesn't bloat
const historyKeyFor = (staffName) =>
    staffName ? `${HISTORY_KEY_BASE}:${staffName}` : HISTORY_KEY_BASE;

function loadHistory(staffName) {
    try {
        const raw = localStorage.getItem(historyKeyFor(staffName));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.slice(-MAX_HISTORY_MESSAGES) : [];
    } catch {
        return [];
    }
}

function saveHistory(staffName, messages) {
    try {
        const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
        localStorage.setItem(historyKeyFor(staffName), JSON.stringify(trimmed));
    } catch {}
}

// One-time migration: if the legacy un-keyed history exists, drop it so we
// don't leak chat between users. (Don't try to "give" it to the current
// staff — we don't know who originally typed those messages.)
try {
    if (typeof localStorage !== "undefined" && localStorage.getItem(HISTORY_KEY_BASE)) {
        localStorage.removeItem(HISTORY_KEY_BASE);
    }
} catch {}

export default function AiAssistant({ language, staffName, storeLocation }) {
    const [messages, setMessages] = useState(() => loadHistory(staffName));
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [routerStatus, setRouterStatus] = useState(null); // null | "ok" | "down"
    const [lastModel, setLastModel] = useState(null);
    const [error, setError] = useState(null);
    const [showKnowledge, setShowKnowledge] = useState(false);
    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

    const isEs = language === "es";

    const knowledgeStats = useMemo(() => getKnowledgeStats(), []);

    // Persist chat history to localStorage so a refresh doesn't lose context.
    useEffect(() => { saveHistory(staffName, messages); }, [staffName, messages]);
    // If the user changes (logout + log in as someone else on same device),
    // load the new user's chat. Otherwise the previous user's messages stay
    // on screen until the page reloads.
    const lastStaffRef = useRef(staffName);
    useEffect(() => {
        if (lastStaffRef.current !== staffName) {
            lastStaffRef.current = staffName;
            setMessages(loadHistory(staffName));
        }
    }, [staffName]);

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

    // Send message to AI Router
    const sendMessage = async (text) => {
        if (!text.trim() || loading) return;

        // Capture conversation history BEFORE adding new user message
        // (the router appends the current message itself)
        const conversation = messages
            .filter(m => !m.isError)
            .map(m => ({ role: m.role, content: m.content }));

        const userMsg = { role: "user", content: text.trim(), timestamp: Date.now() };
        setMessages(prev => [...prev, userMsg]);
        setInput("");
        setLoading(true);
        setError(null);

        try {
            // Build full DD-Mau-aware system prompt with training, recipes,
            // allergen matrix, and operational rules embedded.
            const systemPrompt = buildKnowledgeContext({
                language,
                staffName,
                location: storeLocation,
            });

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
        if (!window.confirm(isEs ? "¿Borrar toda la conversación?" : "Clear the entire conversation?")) return;
        setMessages([]);
        setError(null);
        setLastModel(null);
        try { localStorage.removeItem(historyKeyFor(staffName)); } catch {}
    };

    const quickActions = QUICK_ACTIONS[isEs ? "es" : "en"];

    // ── Layout shell ────────────────────────────────────────────────────
    return (
        <div className="md:flex md:gap-4 md:p-4 md:max-w-7xl md:mx-auto pb-bottom-nav md:pb-4" style={{ minHeight: "100vh", background: "#f9fafb" }}>
            {/* MAIN CHAT COLUMN */}
            <div className="flex-1 min-w-0 md:rounded-xl md:overflow-hidden md:shadow-sm md:bg-white md:flex md:flex-col">
                {/* Header */}
                <div style={{
                    background: "linear-gradient(135deg, #7c3aed, #6d28d9)",
                    padding: "16px",
                    color: "white",
                }}>
                    <div className="flex items-center justify-between flex-wrap gap-2">
                        <div>
                            <h2 style={{ fontSize: "18px", fontWeight: 700, margin: 0 }}>
                                {isEs ? "🤖 Asistente AI" : "🤖 AI Assistant"}
                            </h2>
                            <p style={{ fontSize: "12px", opacity: 0.85, margin: "2px 0 0" }}>
                                {isEs
                                    ? "Sabe sobre alérgenos, recetas, módulos, marcos de servicio."
                                    : "Knows DD Mau allergens, recipes, training, service frameworks."}
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
                            <button
                                onClick={() => setShowKnowledge(s => !s)}
                                className="md:hidden"
                                style={{ fontSize: "11px", background: "rgba(255,255,255,0.2)", padding: "4px 10px", borderRadius: "8px", border: "none", color: "white", cursor: "pointer", fontWeight: 600 }}
                            >
                                {showKnowledge ? (isEs ? "Cerrar" : "Close") : (isEs ? "ℹ︎ Sabe" : "ℹ︎ Knows")}
                            </button>
                            {messages.length > 0 && (
                                <button onClick={clearChat}
                                    style={{ fontSize: "11px", background: "rgba(255,255,255,0.2)", padding: "4px 10px", borderRadius: "8px", border: "none", color: "white", cursor: "pointer", fontWeight: 600 }}>
                                    {isEs ? "Limpiar" : "Clear"}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* Mobile-only collapsible knowledge panel */}
                {showKnowledge && (
                    <div className="md:hidden" style={{ padding: "12px 16px", background: "#f3f4f6", borderBottom: "1px solid #e5e7eb" }}>
                        <KnowledgePanel stats={knowledgeStats} isEs={isEs} compact />
                    </div>
                )}

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
                <div style={{ padding: "12px 16px", minHeight: "300px", flex: 1 }}>
                    {/* Welcome state — show quick actions */}
                    {messages.length === 0 && (
                        <div>
                            <p style={{ fontSize: "14px", color: "#6b7280", textAlign: "center", margin: "16px 0 12px" }}>
                                {isEs
                                    ? `Hola ${staffName ? staffName.split(' ')[0] : ""}. Pregúntame sobre alérgenos, recetas, módulos, o cualquier cosa del turno.`
                                    : `Hi ${staffName ? staffName.split(' ')[0] : ""}. Ask me about allergens, recipes, training, or anything from your shift.`}
                            </p>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }} className="md:grid-cols-4">
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

                {/* Input area — fixed above bottom nav on mobile, inline on desktop */}
                <div className="md:relative md:border-t md:border-gray-200" style={{
                    background: "white",
                    padding: "8px 12px",
                }}>
                    <div className="md:hidden" style={{
                        position: "fixed",
                        bottom: "80px",
                        left: 0, right: 0,
                        background: "white",
                        borderTop: "1px solid #e5e7eb",
                        padding: "8px 12px",
                        zIndex: 40,
                    }}>
                        <ChatInput
                            input={input} setInput={setInput}
                            onSubmit={handleSubmit}
                            inputRef={inputRef}
                            loading={loading}
                            routerStatus={routerStatus}
                            isEs={isEs}
                            error={error}
                        />
                    </div>
                    <div className="hidden md:block">
                        <ChatInput
                            input={input} setInput={setInput}
                            onSubmit={handleSubmit}
                            inputRef={inputRef}
                            loading={loading}
                            routerStatus={routerStatus}
                            isEs={isEs}
                            error={error}
                        />
                    </div>
                </div>
            </div>

            {/* DESKTOP RIGHT SIDEBAR — knowledge panel */}
            <aside className="hidden md:block md:w-72 md:flex-shrink-0">
                <div className="md:sticky md:top-4 md:rounded-xl md:bg-white md:shadow-sm md:p-4 md:border md:border-gray-200">
                    <KnowledgePanel stats={knowledgeStats} isEs={isEs} />
                </div>
            </aside>
        </div>
    );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ChatInput({ input, setInput, onSubmit, inputRef, loading, routerStatus, isEs, error }) {
    return (
        <>
            <form onSubmit={onSubmit} style={{ maxWidth: "32rem", margin: "0 auto", display: "flex", gap: "8px" }}>
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
        </>
    );
}

function KnowledgePanel({ stats, isEs, compact }) {
    const items = [
        { icon: "🌶️", label: isEs ? "Alérgenos" : "Allergens", value: `${stats.allergenItems} ${isEs ? "platos" : "items"}` },
        { icon: "📚", label: isEs ? "Módulos" : "Modules", value: `${stats.modules} (${stats.lessons} ${isEs ? "lecciones" : "lessons"})` },
        { icon: "🧑‍🍳", label: isEs ? "Recetas" : "Recipes", value: `${stats.recipes} ${isEs ? "totales" : "total"}` },
        { icon: "🛟", label: isEs ? "Marcos" : "Frameworks", value: "10-Sec, Bright 4, RESTORE" },
        { icon: "📋", label: isEs ? "Reglas" : "Rules", value: isEs ? "Uniforme, descansos, alergias" : "Uniform, breaks, allergies" },
    ];
    return (
        <div>
            <h3 style={{ fontSize: compact ? "13px" : "14px", fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>
                {isEs ? "🧠 Lo que sabe el AI" : "🧠 What the AI knows"}
            </h3>
            <p style={{ fontSize: "11px", color: "#6b7280", margin: "0 0 12px", lineHeight: 1.5 }}>
                {isEs
                    ? "Está conectado al manual de DD Mau, alérgenos y recetas — no inventa platos."
                    : "Wired into the DD Mau manual, allergen matrix, and recipes — won't invent dishes."}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {items.map((it, i) => (
                    <div key={i} style={{
                        display: "flex", alignItems: "center", gap: "10px",
                        padding: "8px 10px", background: "#f9fafb", borderRadius: "8px",
                    }}>
                        <span style={{ fontSize: "18px" }}>{it.icon}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: "12px", fontWeight: 600, color: "#374151" }}>{it.label}</div>
                            <div style={{ fontSize: "11px", color: "#6b7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.value}</div>
                        </div>
                    </div>
                ))}
            </div>
            <p style={{ fontSize: "10px", color: "#9ca3af", margin: "12px 0 0", lineHeight: 1.5 }}>
                {isEs
                    ? "⚠ Para alergias graves, siempre confirma con el líder y la cocina."
                    : "⚠ For serious allergies, always confirm with the Shift Lead and kitchen."}
            </p>
        </div>
    );
}
