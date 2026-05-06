import { useState, useEffect, useMemo } from "react";
import { db } from "../firebase";
import { doc, setDoc, getDoc, collection, getDocs, updateDoc, deleteField } from "firebase/firestore";
import { t } from "../data/translations";
import { isAdmin } from "../data/staff";
import { MODULES } from "../data/training";

// Doc id helper — staff name → safe Firestore doc id
const staffDocId = (name) => (name || "unknown").toLowerCase().replace(/\s+/g, "_");

// Module track display order + label
const TRACK_ORDER = ["new-hire", "stations", "menu", "service-safety", "manager-ops"];
const TRACK_LABELS = {
    "new-hire": { en: "New Hire Track", es: "Capacitación de Nuevo Empleado" },
    "stations": { en: "Stations", es: "Estaciones" },
    "menu": { en: "Menu Mastery", es: "Dominio del Menú" },
    "service-safety": { en: "Service & Safety", es: "Servicio y Seguridad" },
    "manager-ops": { en: "Manager Ops", es: "Operaciones de Gerente" },
};
const TRACK_ICONS = {
    "new-hire": "🌱",
    "stations": "🛠️",
    "menu": "📖",
    "service-safety": "🛡️",
    "manager-ops": "👔",
};

export default function TrainingHub({ staffName, language, staffList }) {
    const isEn = language !== "es";
    const tx = (en, es) => (isEn ? en : es);

    const adminUser = isAdmin(staffName);
    const currentStaff = (staffList || []).find(s => s.name === staffName);
    const isLead = adminUser || !!(currentStaff?.shiftLead);

    // View state
    const [view, setView] = useState("list"); // list | module | lesson | quiz | quiz-result | tracker
    const [activeModuleId, setActiveModuleId] = useState(null);
    const [activeLessonId, setActiveLessonId] = useState(null);
    const [quizAnswers, setQuizAnswers] = useState({});
    const [lastResult, setLastResult] = useState(null);

    // Progress for current user
    const [progress, setProgress] = useState(null); // { modules: { mX: { lessonsCompleted, attempts, passed, locked } } }
    const [loading, setLoading] = useState(true);

    // Tracker (admin only)
    const [trackerOpen, setTrackerOpen] = useState(false);
    const [allProgress, setAllProgress] = useState({});
    const [loadingTracker, setLoadingTracker] = useState(false);

    // Filter modules by tier
    const visibleModules = useMemo(() => MODULES.filter(m => {
        if (m.tier === "all") return true;
        if (m.tier === "lead") return isLead;
        if (m.tier === "admin") return adminUser;
        return false;
    }), [isLead, adminUser]);

    const activeModule = useMemo(() => visibleModules.find(m => m.id === activeModuleId), [activeModuleId, visibleModules]);
    const activeLesson = useMemo(() => activeModule?.lessons.find(l => l.id === activeLessonId), [activeModule, activeLessonId]);

    /* ───────── Firestore I/O ───────── */
    useEffect(() => {
        let mounted = true;
        if (!staffName) { setLoading(false); return; }
        getDoc(doc(db, "training_v2", staffDocId(staffName)))
            .then(snap => {
                if (!mounted) return;
                setProgress(snap.exists() ? snap.data() : { modules: {} });
            })
            .finally(() => mounted && setLoading(false));
        return () => { mounted = false; };
    }, [staffName]);

    const persistProgress = async (next) => {
        setProgress(next);
        await setDoc(doc(db, "training_v2", staffDocId(staffName)), {
            staffName,
            modules: next.modules || {},
            updatedAt: new Date().toISOString(),
        }, { merge: true });
    };

    const moduleState = (mId) => progress?.modules?.[mId] || { lessonsCompleted: [], attempts: [], passed: false, locked: false };

    const markLessonComplete = async (mId, lId) => {
        const cur = moduleState(mId);
        if (cur.lessonsCompleted.includes(lId)) return;
        const next = {
            ...progress,
            modules: {
                ...(progress?.modules || {}),
                [mId]: { ...cur, lessonsCompleted: [...cur.lessonsCompleted, lId] },
            },
        };
        await persistProgress(next);
    };

    const submitQuiz = async () => {
        const m = activeModule;
        if (!m) return;
        let correct = 0;
        m.quiz.questions.forEach(q => { if (quizAnswers[q.id] === q.correct) correct += 1; });
        const score = correct / m.quiz.questions.length;
        const passed = score >= m.quiz.passThreshold;

        const cur = moduleState(m.id);
        const attempts = [...(cur.attempts || []), { at: new Date().toISOString(), score, passed, answers: { ...quizAnswers } }];

        // Lock after 2 consecutive failed attempts
        const lastTwoFailed = attempts.length >= 2 && !attempts[attempts.length - 1].passed && !attempts[attempts.length - 2].passed;
        const locked = passed ? false : lastTwoFailed;

        const next = {
            ...progress,
            modules: {
                ...(progress?.modules || {}),
                [m.id]: {
                    ...cur,
                    attempts,
                    passed: cur.passed || passed,
                    passedAt: passed && !cur.passed ? new Date().toISOString() : cur.passedAt,
                    locked,
                    lockedAt: locked && !cur.locked ? new Date().toISOString() : cur.lockedAt || null,
                },
            },
        };
        await persistProgress(next);
        setLastResult({ score, correct, total: m.quiz.questions.length, passed, locked });
        setView("quiz-result");
    };

    /* ───────── Tracker (admin) ───────── */
    const loadTracker = async () => {
        setLoadingTracker(true);
        try {
            const snap = await getDocs(collection(db, "training_v2"));
            const byStaff = {};
            snap.forEach(d => { byStaff[d.id] = d.data(); });
            setAllProgress(byStaff);
        } catch (e) { console.error("tracker load:", e); }
        setLoadingTracker(false);
    };

    const clearLock = async (staffDocId, moduleId) => {
        const ref = doc(db, "training_v2", staffDocId);
        await updateDoc(ref, {
            [`modules.${moduleId}.locked`]: false,
            [`modules.${moduleId}.attempts`]: [],
            [`modules.${moduleId}.lockedAt`]: deleteField(),
        });
        loadTracker();
    };

    /* ───────── Renderers ───────── */
    if (loading) {
        return <div className="p-4 text-center text-gray-500">{tx("Loading…", "Cargando…")}</div>;
    }

    // Quiz view
    if (view === "quiz" && activeModule) {
        const m = activeModule;
        const allAnswered = m.quiz.questions.every(q => quizAnswers[q.id]);
        return (
            <div className="p-4 pb-24">
                <button onClick={() => setView("module")} className="text-sm text-mint-700 mb-3">← {tx("Back to module", "Volver al módulo")}</button>
                <h2 className="text-xl font-bold text-mint-700 mb-1">{m.icon} {tx(m.titleEn, m.titleEs)} — {tx("Quiz", "Examen")}</h2>
                <p className="text-xs text-gray-500 mb-4">{tx(`Pass ${Math.round(m.quiz.passThreshold * 100)}% to clear this module. Two failed attempts in a row will lock the module — your manager has to clear the lock.`, `Aprueba con ${Math.round(m.quiz.passThreshold * 100)}% para completar este módulo. Dos intentos fallidos seguidos bloquean el módulo — tu gerente debe quitar el bloqueo.`)}</p>
                {m.quiz.questions.map((q, qi) => (
                    <div key={q.id} className="mb-5 p-4 bg-white border border-gray-200 rounded-xl">
                        <div className="text-sm font-bold text-gray-800 mb-3">{qi + 1}. {tx(q.questionEn, q.questionEs)}</div>
                        <div className="space-y-2">
                            {q.options.map(opt => {
                                const selected = quizAnswers[q.id] === opt.id;
                                return (
                                    <button key={opt.id} onClick={() => setQuizAnswers(prev => ({ ...prev, [q.id]: opt.id }))}
                                        className={`w-full text-left px-3 py-2 rounded-lg border-2 transition ${selected ? "bg-mint-50 border-mint-500" : "bg-white border-gray-200 hover:border-gray-300"}`}>
                                        <span className="font-bold text-mint-700 mr-2">{opt.id.toUpperCase()}.</span>
                                        <span className="text-sm">{tx(opt.textEn, opt.textEs)}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}
                <button onClick={submitQuiz} disabled={!allAnswered}
                    className={`w-full py-3 rounded-xl font-bold text-white text-base ${allAnswered ? "bg-mint-700 hover:bg-mint-800" : "bg-gray-300 cursor-not-allowed"}`}>
                    {tx("Submit Quiz", "Enviar Examen")}
                </button>
                {!allAnswered && <p className="text-xs text-gray-500 text-center mt-2">{tx("Answer every question to submit", "Responde todas las preguntas para enviar")}</p>}
            </div>
        );
    }

    // Quiz result
    if (view === "quiz-result" && lastResult && activeModule) {
        const r = lastResult;
        return (
            <div className="p-4 pb-24">
                <div className={`rounded-2xl p-6 text-center ${r.passed ? "bg-green-50 border-2 border-green-300" : r.locked ? "bg-red-50 border-2 border-red-300" : "bg-amber-50 border-2 border-amber-300"}`}>
                    <div className="text-5xl mb-3">{r.passed ? "🎉" : r.locked ? "🔒" : "❌"}</div>
                    <h2 className="text-2xl font-bold mb-2">
                        {r.passed ? tx("Passed!", "¡Aprobado!") : r.locked ? tx("Module Locked", "Módulo Bloqueado") : tx("Not Yet — Try Again", "Aún No — Inténtalo Otra Vez")}
                    </h2>
                    <p className="text-lg font-bold text-gray-800 mb-1">{r.correct} / {r.total} ({Math.round(r.score * 100)}%)</p>
                    <p className="text-xs text-gray-500 mb-4">
                        {tx(`Pass threshold: ${Math.round(activeModule.quiz.passThreshold * 100)}%`, `Umbral: ${Math.round(activeModule.quiz.passThreshold * 100)}%`)}
                    </p>
                    {r.locked ? (
                        <p className="text-sm text-red-700 font-medium mb-4">
                            {tx("Two failed attempts in a row. Ask your manager to clear the lock so you can re-read the lessons and try again.", "Dos intentos fallidos seguidos. Pide a tu gerente que quite el bloqueo para releer las lecciones e intentarlo de nuevo.")}
                        </p>
                    ) : !r.passed ? (
                        <p className="text-sm text-amber-700 font-medium mb-4">
                            {tx("Re-read the lessons and try once more. One more failure will lock this module.", "Relee las lecciones y vuelve a intentarlo. Un fallo más bloqueará el módulo.")}
                        </p>
                    ) : (
                        <p className="text-sm text-green-700 font-medium mb-4">{tx("Module complete. Great work.", "Módulo completo. Excelente trabajo.")}</p>
                    )}
                </div>
                <div className="mt-4 flex gap-2">
                    <button onClick={() => { setView("module"); setQuizAnswers({}); }}
                        className="flex-1 py-3 rounded-xl bg-mint-700 text-white font-bold">{tx("Back to Module", "Volver al Módulo")}</button>
                    <button onClick={() => { setView("list"); setActiveModuleId(null); setQuizAnswers({}); }}
                        className="flex-1 py-3 rounded-xl bg-gray-200 text-gray-700 font-bold">{tx("All Modules", "Todos los Módulos")}</button>
                </div>
            </div>
        );
    }

    // Lesson reader
    if (view === "lesson" && activeLesson && activeModule) {
        const m = activeModule;
        const lIdx = m.lessons.findIndex(l => l.id === activeLessonId);
        const completed = moduleState(m.id).lessonsCompleted.includes(activeLessonId);
        const content = isEn ? activeLesson.contentEn : activeLesson.contentEs;
        return (
            <div className="p-4 pb-24">
                <button onClick={() => setView("module")} className="text-sm text-mint-700 mb-3">← {tx("Back to module", "Volver al módulo")}</button>
                <p className="text-xs text-gray-500 mb-1">{m.code} · {tx("Lesson", "Lección")} {lIdx + 1} / {m.lessons.length}</p>
                <h2 className="text-xl font-bold text-mint-700 mb-4">{tx(activeLesson.titleEn, activeLesson.titleEs)}</h2>
                <div className="space-y-3 text-gray-800 text-sm leading-relaxed">
                    {content.map((para, i) => (
                        <p key={i} className={para.startsWith("•") || para.startsWith("—") || /^\d+\./.test(para) ? "ml-2" : ""}>{para}</p>
                    ))}
                </div>
                <div className="mt-6 flex gap-2">
                    {lIdx > 0 && (
                        <button onClick={() => setActiveLessonId(m.lessons[lIdx - 1].id)}
                            className="flex-1 py-3 rounded-xl bg-gray-200 text-gray-700 font-bold">← {tx("Previous", "Anterior")}</button>
                    )}
                    {!completed && (
                        <button onClick={async () => {
                            await markLessonComplete(m.id, activeLessonId);
                            if (lIdx < m.lessons.length - 1) setActiveLessonId(m.lessons[lIdx + 1].id);
                            else setView("module");
                        }} className="flex-1 py-3 rounded-xl bg-mint-700 text-white font-bold">
                            {tx("Mark as read", "Marcar como leída")}
                        </button>
                    )}
                    {completed && lIdx < m.lessons.length - 1 && (
                        <button onClick={() => setActiveLessonId(m.lessons[lIdx + 1].id)}
                            className="flex-1 py-3 rounded-xl bg-mint-700 text-white font-bold">{tx("Next →", "Siguiente →")}</button>
                    )}
                    {completed && lIdx === m.lessons.length - 1 && (
                        <button onClick={() => setView("module")}
                            className="flex-1 py-3 rounded-xl bg-mint-700 text-white font-bold">{tx("Done", "Listo")}</button>
                    )}
                </div>
            </div>
        );
    }

    // Module detail
    if (view === "module" && activeModule) {
        const m = activeModule;
        const st = moduleState(m.id);
        const allLessonsRead = m.lessons.every(l => st.lessonsCompleted.includes(l.id));
        const failsInRow = (() => {
            let c = 0;
            for (let i = (st.attempts || []).length - 1; i >= 0; i--) {
                if (st.attempts[i].passed) break;
                c += 1;
            }
            return c;
        })();
        return (
            <div className="p-4 pb-24">
                <button onClick={() => { setView("list"); setActiveModuleId(null); }} className="text-sm text-mint-700 mb-3">← {tx("All modules", "Todos los módulos")}</button>
                <div className="flex items-start gap-3 mb-4">
                    <div className="text-4xl">{m.icon}</div>
                    <div className="flex-1">
                        <p className="text-xs text-gray-500">{m.code} · {m.durationMin} {tx("min", "min")} · {TRACK_LABELS[m.track][isEn ? "en" : "es"]}</p>
                        <h2 className="text-xl font-bold text-mint-700">{tx(m.titleEn, m.titleEs)}</h2>
                    </div>
                </div>

                {st.locked && (
                    <div className="mb-4 p-3 bg-red-50 border-2 border-red-300 rounded-xl text-sm text-red-800">
                        🔒 <strong>{tx("Locked.", "Bloqueado.")}</strong> {tx("Two failed quiz attempts in a row. Ask your manager to clear the lock.", "Dos intentos fallidos seguidos. Pide a tu gerente que quite el bloqueo.")}
                    </div>
                )}

                {st.passed && (
                    <div className="mb-4 p-3 bg-green-50 border-2 border-green-300 rounded-xl text-sm text-green-800">
                        ✅ <strong>{tx("Passed.", "Aprobado.")}</strong> {tx("You can re-read lessons or retake the quiz any time.", "Puedes releer las lecciones o repetir el examen cuando quieras.")}
                    </div>
                )}

                <h3 className="text-sm font-bold text-gray-600 uppercase tracking-wide mt-3 mb-2">{tx("Lessons", "Lecciones")}</h3>
                <div className="space-y-2 mb-5">
                    {m.lessons.map((l, idx) => {
                        const done = st.lessonsCompleted.includes(l.id);
                        return (
                            <button key={l.id} onClick={() => { setActiveLessonId(l.id); setView("lesson"); }}
                                className="w-full text-left p-3 bg-white border-2 border-gray-200 rounded-xl hover:border-mint-300 transition flex items-center gap-3">
                                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${done ? "bg-green-500 text-white" : "bg-gray-200 text-gray-500"}`}>
                                    {done ? "✓" : idx + 1}
                                </div>
                                <div className="flex-1 text-sm font-medium text-gray-800">{tx(l.titleEn, l.titleEs)}</div>
                                <span className="text-mint-600 text-xs">→</span>
                            </button>
                        );
                    })}
                </div>

                <h3 className="text-sm font-bold text-gray-600 uppercase tracking-wide mb-2">{tx("Quiz", "Examen")}</h3>
                <button onClick={() => { if (!st.locked && allLessonsRead) { setQuizAnswers({}); setView("quiz"); } }}
                    disabled={st.locked || !allLessonsRead}
                    className={`w-full p-4 rounded-xl border-2 text-left transition ${
                        st.locked ? "bg-red-50 border-red-300 cursor-not-allowed" :
                        !allLessonsRead ? "bg-gray-50 border-gray-200 cursor-not-allowed" :
                        st.passed ? "bg-green-50 border-green-300 hover:border-green-500" :
                        "bg-mint-50 border-mint-300 hover:border-mint-500"}`}>
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="text-sm font-bold text-gray-800">
                                {st.locked ? "🔒 " : st.passed ? "✅ " : "📝 "}
                                {tx("Take the quiz", "Tomar el examen")}
                                <span className="text-xs font-normal text-gray-500 ml-2">{m.quiz.questions.length} {tx("questions", "preguntas")} · {Math.round(m.quiz.passThreshold * 100)}% {tx("to pass", "para aprobar")}</span>
                            </div>
                            {!allLessonsRead && !st.locked && (
                                <div className="text-xs text-gray-500 mt-1">{tx("Read all lessons first", "Lee todas las lecciones primero")}</div>
                            )}
                            {failsInRow > 0 && !st.locked && !st.passed && (
                                <div className="text-xs text-amber-700 mt-1">⚠️ {failsInRow} {tx("failed attempt(s) in a row — one more locks the module", "intento(s) fallido(s) seguido(s) — uno más bloquea el módulo")}</div>
                            )}
                        </div>
                    </div>
                </button>
            </div>
        );
    }

    // Tracker (admin)
    if (view === "tracker" && adminUser) {
        const docs = Object.entries(allProgress);
        return (
            <div className="p-4 pb-24">
                <button onClick={() => setView("list")} className="text-sm text-mint-700 mb-3">← {tx("Back", "Atrás")}</button>
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-xl font-bold text-mint-700">📊 {tx("Training Tracker", "Progreso de Capacitación")}</h2>
                    <button onClick={loadTracker} className="text-xs px-3 py-1.5 rounded-lg bg-mint-700 text-white font-bold">{tx("Refresh", "Actualizar")}</button>
                </div>
                {loadingTracker && <p className="text-sm text-gray-500">{tx("Loading…", "Cargando…")}</p>}
                {!loadingTracker && docs.length === 0 && <p className="text-sm text-gray-500">{tx("No staff progress yet.", "Aún no hay progreso de personal.")}</p>}
                <div className="space-y-3">
                    {docs.map(([docId, data]) => {
                        const name = data.staffName || docId;
                        return (
                            <div key={docId} className="bg-white border border-gray-200 rounded-xl p-3">
                                <div className="font-bold text-gray-800 mb-2">{name}</div>
                                <div className="space-y-1.5">
                                    {MODULES.map(m => {
                                        const ms = data.modules?.[m.id];
                                        if (!ms) return null;
                                        const status = ms.locked ? "locked" : ms.passed ? "passed" : ms.lessonsCompleted?.length ? "in-progress" : "started";
                                        const pct = m.lessons.length > 0 ? Math.round((ms.lessonsCompleted?.length || 0) / m.lessons.length * 100) : 0;
                                        return (
                                            <div key={m.id} className="flex items-center gap-2 text-xs">
                                                <span className="w-12 font-mono text-gray-500">{m.code}</span>
                                                <span className="flex-1 truncate">{tx(m.titleEn, m.titleEs)}</span>
                                                <span className={`px-2 py-0.5 rounded-full font-bold ${
                                                    status === "passed" ? "bg-green-100 text-green-700" :
                                                    status === "locked" ? "bg-red-100 text-red-700" :
                                                    "bg-amber-100 text-amber-700"
                                                }`}>
                                                    {status === "passed" ? "✅" : status === "locked" ? "🔒" : `${pct}%`}
                                                </span>
                                                {status === "locked" && (
                                                    <button onClick={() => clearLock(docId, m.id)}
                                                        className="px-2 py-0.5 rounded-md bg-blue-600 text-white font-bold text-[10px]">
                                                        {tx("Unlock", "Desbloquear")}
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    // Module list (default)
    const grouped = TRACK_ORDER.map(track => ({
        track,
        modules: visibleModules.filter(m => m.track === track),
    })).filter(g => g.modules.length > 0);

    return (
        <div className="p-4 pb-24">
            <div className="flex items-center justify-between mb-3">
                <h2 className="text-2xl font-bold text-mint-700">📚 {t("trainingHub", language) || tx("Training Hub", "Centro de Capacitación")}</h2>
                {adminUser && (
                    <button onClick={() => { loadTracker(); setView("tracker"); }}
                        className="px-3 py-1.5 rounded-lg bg-purple-600 text-white text-xs font-bold">
                        📊 {tx("Tracker", "Progreso")}
                    </button>
                )}
            </div>
            <p className="text-sm text-gray-600 mb-5">
                {tx("Read each lesson, then pass the quiz to clear the module. 80% to pass; safety modules require 85%. Two failed quizzes in a row will lock a module — your manager unlocks it.", "Lee cada lección, luego aprueba el examen para completar el módulo. 80% para aprobar; los módulos de seguridad requieren 85%. Dos exámenes fallidos seguidos bloquean el módulo — tu gerente lo desbloquea.")}
            </p>

            {grouped.map(g => (
                <div key={g.track} className="mb-5">
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">{TRACK_ICONS[g.track]} {TRACK_LABELS[g.track][isEn ? "en" : "es"]}</h3>
                    <div className="space-y-2">
                        {g.modules.map(m => {
                            const st = moduleState(m.id);
                            const totalL = m.lessons.length;
                            const doneL = st.lessonsCompleted.length;
                            const pct = totalL > 0 ? Math.round(doneL / totalL * 100) : 0;
                            return (
                                <button key={m.id} onClick={() => { setActiveModuleId(m.id); setView("module"); }}
                                    className={`w-full text-left p-3 bg-white border-2 rounded-xl transition flex items-center gap-3 ${
                                        st.locked ? "border-red-300" :
                                        st.passed ? "border-green-300" :
                                        "border-gray-200 hover:border-mint-300"}`}>
                                    <div className="text-3xl">{m.icon}</div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-gray-800 truncate">{m.code} · {tx(m.titleEn, m.titleEs)}</div>
                                        <div className="text-xs text-gray-500">{totalL} {tx("lessons", "lecciones")} · {m.durationMin} {tx("min", "min")}</div>
                                    </div>
                                    <div className="text-right text-xs">
                                        {st.locked ? <span className="text-red-700 font-bold">🔒</span> :
                                         st.passed ? <span className="text-green-700 font-bold">✅</span> :
                                         doneL > 0 ? <span className="text-amber-700 font-bold">{pct}%</span> :
                                         <span className="text-gray-400">→</span>}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}

            {visibleModules.length === 0 && (
                <p className="text-center text-gray-500 mt-12">{tx("No training modules yet.", "Aún no hay módulos de capacitación.")}</p>
            )}
        </div>
    );
}
