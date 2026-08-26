import { useState, useEffect, useMemo, useRef } from "react";
import { db } from "../firebase";
import {
    doc, collection, deleteField, onSnapshot, arrayUnion, query, where,
    setDoc as _fsSetDoc, updateDoc as _fsUpdateDoc, getDocs as _fsGetDocs,
} from "firebase/firestore";
// 2026-08-11 full-app audit — watchdog shadows (wedged-transport revive;
// see firestoreRevive.js). Same pattern as Schedule/ChatThread.
import { watchdogWrite, watchdogRead, reviveFirestore } from "../data/firestoreRevive";
const setDoc = (...a) => watchdogWrite(_fsSetDoc(...a));
const updateDoc = (...a) => watchdogWrite(_fsUpdateDoc(...a));
const getDocs = (...a) => watchdogRead(_fsGetDocs(...a));
import { t } from "../data/translations";
import { isAdmin } from "../data/staff";
import { MODULES } from "../data/training";
import { toast } from "../toast";
import { pushBackHandler } from "../capacitor-bridge";
import { ASSIGNMENTS, myOpenAssignments, stampAssignmentOpened, fmtDue } from "../data/trainingAssignments";
import { consumePendingTrainingOpen } from "../data/trainingDeepLink";
// 2026-05-27 Batch F — Apple-HIG page header. Visual only.
import { GraduationCap, BarChart3 } from "lucide-react";
import { PageHeader } from "../v2/PageShell";
// 2026-05-31 — App Tour component + entry card + 'apptour' view
// removed per Andrew. Deleted files: src/components/AppTour.jsx,
// src/data/appTourLessons.js, public/screenshots/*.jpg. The
// /app_tour_progress Firestore docs (if any) are orphaned but
// harmless; safe to leave or sweep with a one-off script.

// Lesson-content overrides — admins can edit lesson titles + bullets in
// the app, written to /config/training_overrides. The doc shape is one
// key per lesson: `${moduleId}__${lessonId}` → { titleEn, titleEs,
// contentEn[], contentEs[] }. At render time we merge override over the
// static MODULES data, so the static file stays the source-of-truth
// default and Firestore holds the in-app edits.
//
// Why Firestore not training.js: training.js needs a redeploy to
// change; Andrew wants to fix typos / tweak wording without waiting
// for GitHub Pages. The override layer means edits are live in seconds
// on every device.
// 2026-08-17 audit: an EMPTY override value ('' title / [] body) used to win
// over the static text and render a blank lesson for every device. Empty
// now falls back to the deployed default — the editor also refuses to save
// an empty title/body, but old docs and hand edits shouldn't blank a lesson.
const nonEmptyStr = (v) => (typeof v === 'string' && v.trim().length > 0 ? v : null);
const nonEmptyArr = (v) => (Array.isArray(v) && v.some(p => typeof p === 'string' && p.trim().length > 0) ? v : null);
export function applyLessonOverride(lesson, override) {
    if (!override) return lesson;
    return {
        ...lesson,
        titleEn: nonEmptyStr(override.titleEn) ?? lesson.titleEn,
        titleEs: nonEmptyStr(override.titleEs) ?? lesson.titleEs,
        contentEn: nonEmptyArr(override.contentEn) ?? lesson.contentEn,
        contentEs: nonEmptyArr(override.contentEs) ?? lesson.contentEs,
        // Per-lesson YouTube video IDs — admins set via the Edit modal.
        // Stored on the override doc so a video can be added/swapped
        // without redeploying training.js. ES variant is optional; if
        // only videoIdEn is set, Spanish viewers see the same video
        // (YouTube auto-captioning can fill the gap). (2026-05-17.)
        videoIdEn: override.videoIdEn != null ? override.videoIdEn : lesson.videoIdEn,
        videoIdEs: override.videoIdEs != null ? override.videoIdEs : lesson.videoIdEs,
    };
}

// Parse a YouTube URL or raw video ID into the canonical 11-char video
// ID that the embed iframe needs. Accepts:
//   • Raw ID:                       "dQw4w9WgXcQ"
//   • Standard watch URL:           "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12"
//   • Short URL (youtu.be):         "https://youtu.be/dQw4w9WgXcQ?si=..."
//   • Mobile / m. domain:           "https://m.youtube.com/watch?v=dQw4w9WgXcQ"
//   • Shorts / Embed / Live URLs:   handled by the /shorts/ + /embed/ + /live/ shape
// Returns null on anything that doesn't look like a YouTube ID.
//
// Pure function — used by the Edit modal (validate on paste) and by
// the lesson renderer (when override data was stored as a URL by an
// earlier admin who skipped validation).
export function parseYouTubeId(input) {
    if (!input || typeof input !== 'string') return null;
    const s = input.trim();
    // Already a bare 11-char ID
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    // Try URL parse — fail closed on anything that's not a URL.
    let url;
    try { url = new URL(s); } catch { return null; }
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be') {
        // youtu.be/{id}
        const id = url.pathname.replace(/^\//, '').split('/')[0];
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
    // watch?v={id}
    const vParam = url.searchParams.get('v');
    if (vParam && /^[A-Za-z0-9_-]{11}$/.test(vParam)) return vParam;
    // /shorts/{id} | /embed/{id} | /live/{id}
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return null;
}

// Doc id helper — staff name → safe Firestore doc id
const staffDocId = (name) => (name || "unknown").toLowerCase().replace(/\s+/g, "_").replace(/\//g, "_"); // "/" would make an invalid doc path (crashes the tab for that person); keep in sync with renameStaff.trainingDocId + functions docIdFor

// Deterministic per-attempt shuffle of a question's answer options.
// 2026-08-17 audit: several modules (M7, M9) had the correct answer at
// option "b" on EVERY question and options were rendered in source order,
// so tapping B down the page scored 100% without reading. Ordering is a
// pure function of (seed, question id) — stable while answering, different
// on the next attempt. Answers are stored by option ID, so shuffling never
// affects grading, saved progress, or the localStorage restore.
export function orderQuizOptions(options, seedStr) {
    if (!Array.isArray(options) || options.length < 2) return options || [];
    // FNV-1a over seed + option id → sort key. Tiny, no deps, good enough
    // spread for 2–5 options.
    const h = (s) => {
        let x = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
        return x;
    };
    return options
        .map((o, i) => ({ o, i, k: h(`${seedStr}#${o.id}`) }))
        .sort((a, b) => (a.k - b.k) || (a.i - b.i))
        .map(x => x.o);
}

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

// Allergen matrix table — renders a structured, color-coded chart inside a lesson.
// Mirrors the official DD Mau Allergen Matrix doc.
const ALLERGEN_COLS = [
    { key: "milk", labelEn: "Milk", labelEs: "Leche" },
    { key: "eggs", labelEn: "Eggs", labelEs: "Huevos" },
    { key: "fish", labelEn: "Fish", labelEs: "Pescado" },
    { key: "shell", labelEn: "Shellfish", labelEs: "Mariscos" },
    { key: "treenut", labelEn: "Tree Nut", labelEs: "Fruto Seco" },
    { key: "peanut", labelEn: "Peanut", labelEs: "Cacahuate" },
    { key: "wheat", labelEn: "Wheat", labelEs: "Trigo" },
    { key: "soy", labelEn: "Soy", labelEs: "Soya" },
    { key: "sesame", labelEn: "Sesame", labelEs: "Ajonjolí" },
    // 2026-08-17 audit: L1 says "we track all 9 plus MSG" and the official
    // docx matrix has an MSG column, but the in-app chart never showed it.
    { key: "msg", labelEn: "MSG", labelEs: "MSG" },
];

function AllergenCell({ mark }) {
    if (!mark) return <td className="border border-gray-300 px-1 py-1 text-center bg-white">&nbsp;</td>;
    if (mark === "●") return <td className="border border-gray-300 px-1 py-1 text-center bg-red-600 text-white font-bold">●</td>;
    if (mark === "◐") return <td className="border border-gray-300 px-1 py-1 text-center bg-amber-300 text-amber-900 font-bold">◐</td>;
    return <td className="border border-gray-300 px-1 py-1 text-center bg-white">{mark}</td>;
}

function VeganCell({ v }) {
    if (v === "✓") return <td className="border border-gray-300 px-1 py-1 text-center bg-green-600 text-white font-bold">✓</td>;
    if (v === "✓*") return <td className="border border-gray-300 px-1 py-1 text-center bg-green-100 text-green-800 font-bold">✓*</td>;
    return <td className="border border-gray-300 px-1 py-1 text-center bg-gray-100 text-gray-500">—</td>;
}

function AllergenMatrix({ matrix, isEn }) {
    const tx = (en, es) => (isEn ? en : es);
    return (
        <div className="mt-4 space-y-5">
            <div className="text-xs bg-amber-50 border border-amber-300 rounded-lg p-2 text-amber-900">
                <span className="inline-block mr-2"><span className="inline-block bg-red-600 text-white rounded px-1 mr-1">●</span>{tx("Contains", "Contiene")}</span>
                <span className="inline-block mr-2"><span className="inline-block bg-amber-300 text-amber-900 rounded px-1 mr-1">◐</span>{tx("May contain", "Puede contener")}</span>
                <span className="inline-block mr-2"><span className="inline-block bg-green-600 text-white rounded px-1 mr-1">✓</span>{tx("Vegan", "Vegano")}</span>
                <span className="inline-block"><span className="inline-block bg-green-100 text-green-800 rounded px-1 mr-1">✓*</span>{tx("Can be made vegan", "Se puede hacer vegano")}</span>
            </div>
            {matrix.sections.map((sec, si) => (
                <div key={si}>
                    <div className="text-sm font-bold text-mint-800 mb-1">{tx(sec.titleEn, sec.titleEs)}</div>
                    <div className="overflow-x-auto -mx-4 px-4">
                        <table className="text-[11px] border-collapse min-w-max">
                            <thead>
                                <tr className="bg-mint-700 text-white">
                                    <th className="border border-gray-300 px-2 py-1 text-left sticky left-0 bg-mint-700 z-10 min-w-[140px]">{tx("Item", "Artículo")}</th>
                                    {ALLERGEN_COLS.map(c => (
                                        <th key={c.key} className="border border-gray-300 px-1 py-1 font-semibold whitespace-nowrap">{tx(c.labelEn, c.labelEs)}</th>
                                    ))}
                                    <th className="border border-gray-300 px-1 py-1 font-semibold">{tx("Vegan", "Vegano")}</th>
                                    <th className="border border-gray-300 px-2 py-1 text-left font-semibold min-w-[200px]">{tx("Notes", "Notas")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sec.rows.map((row, ri) => (
                                    <tr key={ri} className={ri % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                        <td className={"border border-gray-300 px-2 py-1 font-semibold sticky left-0 z-10 " + (ri % 2 === 0 ? "bg-white" : "bg-gray-50")}>{tx(row.itemEn, row.itemEs)}</td>
                                        {ALLERGEN_COLS.map(c => (
                                            <AllergenCell key={c.key} mark={row.v?.[c.key]} />
                                        ))}
                                        <VeganCell v={row.vegan} />
                                        <td className="border border-gray-300 px-2 py-1 text-gray-700">{tx(row.notesEn, row.notesEs)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ))}
        </div>
    );
}

// Wrapper for any view's content. Mobile: just renders children full-width.
// md+: an optional module sidebar on the left, content fills the rest.
//
// 2026-07-26 audit — HOISTED out of TrainingHub's render body. Defined
// inline, `Shell` got a brand-new function identity every render, so React
// saw a different element type each time and unmounted/remounted the whole
// subtree on every render: lesson YouTube iframes reloaded and the
// LessonEditor's inputs wiped whenever a progress/override snapshot landed.
// Same bug class as the Schedule.jsx Panel hoist. The sidebar JSX (which
// closes over TrainingHub state) is threaded in as a prop.
//
// 2026-08-17 (Andrew, iPad): "make the content window larger — on the iPad
// it's the modules and next to it the lessons … hard to read". On a tablet
// the app already spends 256 px on the AppShell nav, so a second always-on
// 256–288 px module rail left ~250 px for the lesson text at 820 px. The
// module rail is now COLLAPSIBLE: open by default only at xl+ (≥1280 px,
// real desktops), closed by default on tablets, toggled by the "Modules"
// pill in the content column. Below xl, picking a module from the rail
// closes it again so the lesson gets the full width. Mobile (<md) is
// unchanged (no rail; the list view IS the module list).
const SIDEBAR_DEFAULT_OPEN_MQ = '(min-width: 1280px)';
function Shell({ sidebar, children, sidebarOpen, onToggleSidebar, isEn }) {
    return (
        <div className="md:flex md:gap-5 md:p-4">
            {sidebarOpen && (
                <aside className="hidden md:block md:w-64 md:flex-shrink-0 md:sticky md:top-4 md:self-start md:max-h-[calc(100vh-2rem)] md:overflow-y-auto bg-white md:border md:border-gray-200 md:rounded-xl md:p-3">
                    {sidebar}
                </aside>
            )}
            <div className="flex-1 min-w-0 md:bg-white md:border md:border-gray-200 md:rounded-xl">
                <div className="hidden md:flex justify-end px-4 pt-3 -mb-2">
                    <button type="button" onClick={onToggleSidebar}
                        aria-expanded={!!sidebarOpen}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold text-gray-500 bg-gray-100 hover:bg-gray-200 hover:text-gray-700 transition">
                        {sidebarOpen
                            ? <>◀ {isEn ? 'Hide module list' : 'Ocultar módulos'}</>
                            : <>☰ {isEn ? 'Modules' : 'Módulos'}</>}
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

// Reading position survives a tab switch (App.jsx remounts the route on
// every tab change — a push-notification hop into Chat used to drop the
// trainee back on the module list). sessionStorage: per-tab/PWA session,
// cleared on cold launch, keyed by staff so a shared iPad doesn't hand one
// person another's lesson.
const POS_KEY = (name) => `ddmau:training:pos:${(name || '').toLowerCase()}`;
function readSavedPos(name) {
    try {
        const raw = sessionStorage.getItem(POS_KEY(name));
        if (!raw) return null;
        const p = JSON.parse(raw);
        if (!p || typeof p !== 'object') return null;
        // Only resumable, read-only views. Quiz/result/tracker restart clean.
        if (!['module', 'lesson'].includes(p.view)) return null;
        return p;
    } catch { return null; }
}

export default function TrainingHub({ staffName, language, staffList, isManager = false }) {
    const isEn = language !== "es";
    const tx = (en, es) => (isEn ? en : es);

    const adminUser = isAdmin(staffName, staffList);
    const currentStaff = (staffList || []).find(s => s.name === staffName);
    const isLead = adminUser || !!(currentStaff?.shiftLead);
    // Tracker + Unlock: owners AND managers (2026-08-17). The lock copy has
    // always said "ask your manager to clear the lock" — but only ADMIN_IDS
    // could see the Tracker, so a locked staffer at a store with just a
    // manager on duty was stuck. Lesson EDIT stays owner-only.
    const canTrack = adminUser || !!isManager;

    // View state
    const [savedPos] = useState(() => readSavedPos(staffName));
    const [view, setView] = useState(savedPos?.view || "list"); // list | module | lesson | quiz | quiz-result | tracker
    const [activeModuleId, setActiveModuleId] = useState(savedPos?.moduleId || null);
    const [activeLessonId, setActiveLessonId] = useState(savedPos?.lessonId || null);
    const [quizAnswers, setQuizAnswers] = useState({});
    const [lastResult, setLastResult] = useState(null);
    // Per-attempt shuffle seed for the answer options — see orderQuizOptions.
    // Re-rolled every time "Take the quiz" is tapped; stable for the life of
    // one attempt so the options don't jump around while answering.
    const [quizSeed, setQuizSeed] = useState(() => Date.now());
    useEffect(() => {
        try {
            if (view === 'module' || view === 'lesson') {
                sessionStorage.setItem(POS_KEY(staffName), JSON.stringify({ view, moduleId: activeModuleId, lessonId: activeLessonId }));
            } else {
                sessionStorage.removeItem(POS_KEY(staffName));
            }
        } catch {}
    }, [view, activeModuleId, activeLessonId, staffName]);

    // Android hardware back: step UP one level inside Training instead of
    // bouncing to Home (bridge Priority-2). Registered only when there is
    // somewhere to go up to; on the list view the bridge's own home/exit
    // behaviour applies.
    useEffect(() => {
        if (view === 'list') return undefined;
        return pushBackHandler(() => {
            if (view === 'lesson' || view === 'quiz' || view === 'quiz-result') setView('module');
            else { setView('list'); setActiveModuleId(null); }
        });
    }, [view]);

    // Module rail (md+): open by default on real desktops only — see Shell.
    const [sidebarOpen, setSidebarOpen] = useState(() => {
        try { return window.matchMedia(SIDEBAR_DEFAULT_OPEN_MQ).matches; } catch { return false; }
    });
    // Below xl the rail steals the lesson's width, so a pick from the rail
    // closes it. At xl+ it stays put (desktop split-pane).
    const closeSidebarIfNarrow = () => {
        try { if (!window.matchMedia(SIDEBAR_DEFAULT_OPEN_MQ).matches) setSidebarOpen(false); } catch {}
    };

    // 2026-08-17 — every view change (and every lesson change inside the
    // lesson view) starts at the top. Before, tapping "Next →" at the bottom
    // of a lesson landed you mid-way down the NEXT lesson (window scroll
    // position carried over because only the content swapped) — on a phone
    // that reads as "the page is broken / I lost my place".
    const scrollTopOnChange = `${view}|${activeModuleId}|${activeLessonId}`;
    useEffect(() => {
        try { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); } catch { try { window.scrollTo(0, 0); } catch {} }
    }, [scrollTopOnChange]);

    // Persist quiz answers to localStorage so a mid-quiz refresh
    // doesn't lose progress (AUDIT TRAIN-003). Keyed by
    // (moduleId, staffName) so a different person on the same
    // device starting a quiz of their own doesn't pick up the
    // previous tester's answers.
    //
    // Lifecycle:
    //   • Restored on mount when activeModuleId flips → 'quiz' view
    //   • Saved on every quizAnswers change (cheap — <200 bytes)
    //   • Cleared after submission (success OR fail — the attempt
    //     is recorded server-side either way; replaying old answers
    //     after a fresh retake would be confusing)
    const quizStorageKey = (moduleId) => (
        moduleId && staffName
            ? `ddmau:quiz:${moduleId}:${staffName}`
            : null
    );
    // Restore when entering the quiz view for a given module.
    useEffect(() => {
        if (view !== "quiz" || !activeModuleId) return;
        const k = quizStorageKey(activeModuleId);
        if (!k) return;
        try {
            const raw = localStorage.getItem(k);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (saved && typeof saved === 'object') {
                setQuizAnswers(saved);
            }
        } catch { /* corrupt entry — skip */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, activeModuleId, staffName]);
    // Save on every change while in the quiz view.
    // 2026-08-17 — write immediately (was a 250 ms debounce whose cleanup
    // only cleared the timer, so an answer tapped <250 ms before leaving
    // the view / backgrounding the app was never saved). Every quiz is
    // multiple-choice, so this is one <200-byte write per tap — no need to
    // coalesce.
    useEffect(() => {
        if (view !== "quiz" || !activeModuleId) return;
        const k = quizStorageKey(activeModuleId);
        if (!k) return;
        try {
            localStorage.setItem(k, JSON.stringify(quizAnswers));
        } catch { /* storage full — non-fatal */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [quizAnswers, view, activeModuleId, staffName]);
    // Clear after the result lands.
    function clearSavedQuiz(moduleId) {
        const k = quizStorageKey(moduleId);
        if (!k) return;
        try { localStorage.removeItem(k); } catch {}
    }

    // Progress for current user
    const [progress, setProgress] = useState(null); // { modules: { mX: { lessonsCompleted, attempts, passed, locked } } }
    const [loading, setLoading] = useState(true);

    // Tracker (admin only)
    const [trackerOpen, setTrackerOpen] = useState(false);
    const [allProgress, setAllProgress] = useState({});
    const [loadingTracker, setLoadingTracker] = useState(false);

    // Lesson-level overrides from Firestore (admin in-app edits).
    // Doc: /config/training_overrides → { [`${mId}__${lId}`]: {titleEn,...} }
    const [overrides, setOverrides] = useState({});
    const [editorOpen, setEditorOpen] = useState(false);
    useEffect(() => {
        const unsub = onSnapshot(doc(db, "config", "training_overrides"), (snap) => {
            setOverrides(snap.exists() ? (snap.data() || {}) : {});
        }, (err) => { console.warn("training_overrides snapshot failed:", err); });
        return () => unsub();
    }, []);

    // ── Training assignments (2026-08-18) ──────────────────────────────
    // Open assignments that include this staffer drive the "Required — due
    // by …" banner + the DUE chip on module cards. Live; small collection.
    const [assignments, setAssignments] = useState([]);
    useEffect(() => {
        const q = query(collection(db, ASSIGNMENTS), where("status", "==", "open"));
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setAssignments(list);
        }, (e) => console.warn("training assignments snapshot error:", e));
        return () => unsub();
    }, []);
    // [] until the progress snapshot lands so a module already passed never
    // flashes an amber "Required" banner for a second.
    const myAssignments = useMemo(
        () => (progress ? myOpenAssignments(assignments, staffName, progress.modules || {}) : []),
        [assignments, staffName, progress],
    );
    const assignmentByModule = useMemo(() => {
        const m = new Map();
        for (const a of myAssignments) if (!m.has(a.moduleId)) m.set(a.moduleId, a);
        return m;
    }, [myAssignments]);

    // Filter modules by tier + apply lesson overrides
    const visibleModules = useMemo(() => MODULES.filter(m => {
        // `draft: true` modules are visible to admins only (tagged DRAFT)
        // until the owner approves the text and the flag is removed.
        if (m.draft && !adminUser) return false;
        if (m.tier === "all") return true;
        if (m.tier === "lead") return isLead;
        if (m.tier === "admin") return adminUser;
        return false;
    }).map(m => ({
        ...m,
        lessons: m.lessons.map(l => applyLessonOverride(l, overrides[`${m.id}__${l.id}`])),
    })), [isLead, adminUser, overrides]);

    const activeModule = useMemo(() => visibleModules.find(m => m.id === activeModuleId), [activeModuleId, visibleModules]);

    // Deep link from a chat card / push ('training:m18'): parked in
    // trainingDeepLink.js; consume on mount + listen live. Only modules this
    // staffer can actually see (drafts are admin-only, tiers apply) — otherwise
    // say so instead of leaving the page in a view with no module.
    const visibleRef = useRef(visibleModules);
    visibleRef.current = visibleModules;
    useEffect(() => {
        const openModule = (mId) => {
            if (!mId) return;
            const m = visibleRef.current.find(x => x.id === mId);
            if (!m) {
                if (MODULES.some(x => x.id === mId)) toast(tx("This lesson isn't published yet — check back soon.", "Esta lección todavía no está publicada — vuelve pronto."));
                return;
            }
            setActiveModuleId(mId);
            setActiveLessonId(null);
            setView("module");
        };
        const parked = consumePendingTrainingOpen();
        if (parked) openModule(parked);
        const onOpen = (e) => { consumePendingTrainingOpen(); openModule(e?.detail?.moduleId); };
        window.addEventListener("ddmau:open-training", onOpen);
        return () => window.removeEventListener("ddmau:open-training", onOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Stamp "opened" on every open assignment for the module the first time
    // this staffer actually lands inside it (module/lesson/quiz views with a
    // resolvable module). Once per assignment per session; the write is
    // idempotent anyway.
    const stampedRef = useRef(new Set());
    useEffect(() => {
        if (!activeModule || view === "list" || view === "tracker") return;
        const key = staffDocId(staffName);
        for (const a of myAssignments) {
            if (a.moduleId !== activeModule.id || !a.id) continue;
            if (a.opened?.[key] || stampedRef.current.has(a.id)) continue;
            stampedRef.current.add(a.id);
            stampAssignmentOpened(a.id, staffName);
        }
    }, [activeModule, view, myAssignments, staffName]);
    const activeLesson = useMemo(() => activeModule?.lessons.find(l => l.id === activeLessonId), [activeModule, activeLessonId]);

    /* ───────── Firestore I/O ───────── */
    useEffect(() => {
        if (!staffName) { setLoading(false); return; }
        // 2026-06-20 (QA audit T5) — live listener (was a one-shot getDoc) so a
        // manager clearing a lock on another device reaches the staffer's open
        // Training tab without a reload. Firestore latency-compensation includes
        // our own pending writes in the snapshot, so optimistic quiz updates
        // don't flicker; all local progress changes are persisted, so replacing
        // the whole progress object on each snapshot loses nothing.
        // 2026-08-17: first-snapshot watchdog. onSnapshot is not covered by
        // watchdogRead/Write, so on a wedged transport (post-resume iOS) a
        // never-seen doc could sit un-answered until the 3-minute liveness
        // probe. If nothing arrives in 8 s, poke the transport once; the
        // page itself already renders without progress (see progressReady).
        let gotFirst = false;
        const wd = setTimeout(() => {
            if (gotFirst) return;
            reviveFirestore('training-progress-first-snapshot').catch(() => {});
        }, 8000);
        const unsub = onSnapshot(
            doc(db, "training_v2", staffDocId(staffName)),
            (snap) => { gotFirst = true; setProgress(snap.exists() ? snap.data() : { modules: {} }); setLoading(false); },
            // Error path must resolve progress too — leaving it null hid the
            // Required-training banner/DUE chips and gated the quiz behind a
            // misleading "Read all lessons first" for the whole session.
            (e) => { gotFirst = true; console.warn('training progress snapshot error:', e); setProgress((p) => p || { modules: {} }); setLoading(false); },
        );
        return () => { clearTimeout(wd); unsub(); };
    }, [staffName]);

    const persistProgress = async (next) => {
        setProgress(next);
        await setDoc(doc(db, "training_v2", staffDocId(staffName)), {
            staffName,
            modules: next.modules || {},
            updatedAt: new Date().toISOString(),
        }, { merge: true });
    };

    // Granular per-module updater that uses dotted-path updateDoc instead
    // of the whole-modules-map merge above. Avoids the race where another
    // tab (or a manager unlock) lands between our local read and our write
    // and gets clobbered by a stale snapshot. Falls back to the whole-doc
    // setDoc when the doc doesn't exist yet (first save for this staff).
    const persistModulePatch = async (mId, patch) => {
        const dotted = { updatedAt: new Date().toISOString() };
        for (const k in patch) {
            const v = patch[k];
            dotted[`modules.${mId}.${k}`] = v === undefined ? deleteField() : v;
        }
        const ref = doc(db, "training_v2", staffDocId(staffName));
        try {
            await updateDoc(ref, dotted);
        } catch (e) {
            // Doc doesn't exist — seed it.
            const seedMod = {};
            for (const k in patch) if (patch[k] !== undefined) seedMod[k] = patch[k];
            await setDoc(ref, {
                staffName,
                modules: { [mId]: seedMod },
                updatedAt: new Date().toISOString(),
            }, { merge: true });
        }
    };

    // Defensive normalize (2026-07-26 audit): a partial/legacy progress doc
    // (e.g. a module entry seeded by a manual unlock write, or an older
    // build that only stamped `passed`) can be missing the array fields —
    // `.includes` / `.length` on undefined then crashed the whole page.
    // Normalize here so ANY doc shape renders; extra fields (unlockedAt,
    // passedAt, …) pass through untouched.
    const moduleState = (mId) => {
        const raw = progress?.modules?.[mId] || {};
        return {
            ...raw,
            lessonsCompleted: Array.isArray(raw.lessonsCompleted) ? raw.lessonsCompleted : [],
            attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
            passed: !!raw.passed,
            locked: !!raw.locked,
        };
    };

    const markLessonComplete = async (mId, lId) => {
        const cur = moduleState(mId);
        if (cur.lessonsCompleted.includes(lId)) return;
        // Optimistic local update.
        const newLessons = [...cur.lessonsCompleted, lId];
        setProgress(prev => ({
            ...(prev || {}),
            modules: {
                ...(prev?.modules || {}),
                [mId]: { ...cur, lessonsCompleted: newLessons },
            },
        }));
        // Granular write — only mutates `modules.${mId}.lessonsCompleted`.
        // 2026-08-17: arrayUnion (was the whole local array). The page no
        // longer waits for the progress snapshot before rendering, so a tap
        // that lands before the doc arrives (or a second device / stale tab)
        // must never overwrite an existing list with a shorter one. Union is
        // idempotent, so double-taps and replays are harmless too.
        await persistModulePatch(mId, { lessonsCompleted: arrayUnion(lId) });
    };

    // Synchronous re-entry guard (2026-07-26 platform audit H7): a fast
    // double-tap on Submit used to record the SAME attempt twice — two
    // fails from one real fail → lastTwoFailed → module locked, manager
    // unlock required. A ref (not state) so the second tap in the same
    // tick is already blocked.
    const submittingQuizRef = useRef(false);
    const [submittingQuiz, setSubmittingQuiz] = useState(false);
    const submitQuiz = async () => {
        const m = activeModule;
        if (!m) return;
        if (submittingQuizRef.current) return;
        submittingQuizRef.current = true;
        setSubmittingQuiz(true);
        try {
            await _submitQuizInner(m);
        } finally {
            submittingQuizRef.current = false;
            setSubmittingQuiz(false);
        }
    };
    const _submitQuizInner = async (m) => {
        let correct = 0;
        m.quiz.questions.forEach(q => { if (quizAnswers[q.id] === q.correct) correct += 1; });
        const score = correct / m.quiz.questions.length;
        const passed = score >= m.quiz.passThreshold;

        const cur = moduleState(m.id);
        const attempt = { at: new Date().toISOString(), score, passed, answers: { ...quizAnswers } };
        // Local view of the appended history — used for the lock math and
        // the optimistic UI update below. The WRITE uses arrayUnion instead
        // (2026-07-26 audit): writing this whole array back was a stale
        // read-modify-write, so a second device (or a quick retry) racing
        // this submit could silently drop an attempt. Attempt objects carry
        // ISO-string timestamps (never serverTimestamp), so arrayUnion is
        // safe, and two real submits always differ in `at`/answers so the
        // union can't dedupe distinct attempts.
        const attempts = [...(cur.attempts || []), attempt];

        // Lock after 2 consecutive failed attempts. 2026-06-20 (QA audit T1):
        // only count attempts AFTER the most recent manager unlock. Before this,
        // clearLock left the full attempts history intact, so the pre-unlock
        // fail + a single post-unlock fail satisfied lastTwoFailed and re-locked
        // instantly — an unlock bought only ONE retry instead of a fresh window.
        const unlockedAt = cur.unlockedAt || null;
        const sinceUnlock = unlockedAt ? attempts.filter(a => (a.at || '') > unlockedAt) : attempts;
        const lastTwoFailed = sinceUnlock.length >= 2
            && !sinceUnlock[sinceUnlock.length - 1].passed
            && !sinceUnlock[sinceUnlock.length - 2].passed;
        // 2026-08-17: a module that is ALREADY passed can never lock — the
        // module page invites "retake the quiz any time", and two failed
        // retakes used to slap 🔒 over a ✅ and demand an owner unlock.
        const locked = (passed || cur.passed) ? false : lastTwoFailed;

        const patch = {
            attempts: arrayUnion(attempt),
            passed: cur.passed || passed,
            locked,
        };
        if (passed && !cur.passed) patch.passedAt = new Date().toISOString();
        if (locked && !cur.locked) patch.lockedAt = new Date().toISOString();

        // Optimistic local update.
        setProgress(prev => ({
            ...(prev || {}),
            modules: {
                ...(prev?.modules || {}),
                // `attempts` (the plain local array) intentionally overrides
                // patch.attempts, which is the arrayUnion sentinel — local
                // state must hold real data, not a FieldValue.
                [m.id]: { ...cur, ...patch, attempts, lockedAt: patch.lockedAt ?? cur.lockedAt ?? null, passedAt: patch.passedAt ?? cur.passedAt },
            },
        }));
        // 2026-08-17: show the result FIRST, then persist. The local state
        // above is already the truth the UI needs; awaiting the server ack
        // before flipping the view meant "I hit Submit and nothing happens"
        // on slow store Wi-Fi, and on a wedged transport the 18 s watchdog
        // reload landed the user back on the quiz with their answers still
        // in localStorage → a second submit → a second (spurious) attempt →
        // possible unearned lock. Clear the saved answers and move on now;
        // the SDK's offline queue + watchdogWrite guarantee delivery, and a
        // hard rejection surfaces as a toast rather than a frozen button.
        clearSavedQuiz(m.id);
        setLastResult({ score, correct, total: m.quiz.questions.length, passed, locked });
        setView("quiz-result");
        try {
            await persistModulePatch(m.id, patch);
        } catch (e) {
            console.error('quiz attempt save failed:', e);
            toast(tx('⚠ Your quiz result could not be saved. Check your connection and tell your manager if this keeps happening.',
                     '⚠ No se pudo guardar tu resultado. Revisa tu conexión y avisa a tu gerente si sigue pasando.'), { kind: 'warn', duration: 8000 });
        }
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
        // Keep the attempts history for audit — repeat failers are valuable
        // information for managers to identify training gaps. Just unlock
        // and clear the lockedAt timestamp; the staff can retake the quiz
        // and a fresh attempt gets appended.
        const ref = doc(db, "training_v2", staffDocId);
        try {
            await updateDoc(ref, {
                [`modules.${moduleId}.locked`]: false,
                [`modules.${moduleId}.lockedAt`]: deleteField(),
                [`modules.${moduleId}.unlockedAt`]: new Date().toISOString(),
                [`modules.${moduleId}.unlockedBy`]: staffName,
            });
            toast(tx('✓ Unlocked', '✓ Desbloqueado'));
        } catch (e) {
            console.error('clearLock failed:', e);
            toast(tx('⚠ Unlock failed — check your connection and try again.', '⚠ No se pudo desbloquear — revisa tu conexión e intenta de nuevo.'), { kind: 'warn' });
        }
        loadTracker();
    };

    /* ───────── Renderers ───────── */
    // 2026-08-17 — no full-page "Loading…" gate any more. The module list is
    // static data (MODULES + overrides) and renders instantly; the progress
    // snapshot (✅ / % / 🔒 pills) lands a beat later and fills in. While it
    // is still in flight, `progressReady` keeps the quiz gated (the lock /
    // pass math needs the real attempt history) — lesson reads are safe at
    // any time because they are arrayUnion writes. On a device with a warm
    // persistence cache the gap is a few ms; on a cold cache / slow store
    // Wi-Fi this is the difference between "blank page for a second or two"
    // and "the page is just there".
    const progressReady = !loading;

    /* ───────── Desktop split-pane shell ─────────
       On mobile the existing per-view returns render as-is (full-width).
       On md+ each view is wrapped with a sticky module-list sidebar on the
       left so the user can jump between modules without going back to a list.
       Compact module rows: emoji + code + status pill. */
    const moduleListSidebar = (() => {
        const grouped = TRACK_ORDER.map(track => ({
            track,
            modules: visibleModules.filter(m => m.track === track),
        })).filter(g => g.modules.length > 0);
        return (
            // onClickCapture: any pick inside the rail collapses it below xl so
            // the destination gets the full content width (see Shell note).
            <div className="space-y-3" onClickCapture={closeSidebarIfNarrow}>
                <button onClick={() => { setView("list"); setActiveModuleId(null); }}
                    className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-bold ${view === "list" ? "bg-mint-100 text-mint-800" : "text-gray-500 hover:bg-gray-50"}`}>
                    📚 {tx("All modules", "Todos los módulos")}
                </button>
                {canTrack && (
                    <button onClick={() => { loadTracker(); setView("tracker"); }}
                        className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-bold ${view === "tracker" ? "bg-purple-100 text-purple-800" : "text-purple-600 hover:bg-purple-50"}`}>
                        📊 {tx("Tracker", "Progreso")}
                    </button>
                )}
                {grouped.map(g => (
                    <div key={g.track}>
                        <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1 px-2">
                            {TRACK_ICONS[g.track]} {TRACK_LABELS[g.track][isEn ? "en" : "es"]}
                        </h4>
                        <div className="space-y-0.5">
                            {g.modules.map(m => {
                                const st = moduleState(m.id);
                                const isActive = activeModuleId === m.id;
                                const totalL = m.lessons.length;
                                const doneL = st.lessonsCompleted.length;
                                const pct = totalL > 0 ? Math.round(doneL / totalL * 100) : 0;
                                return (
                                    <button key={m.id} onClick={() => { setActiveModuleId(m.id); setView("module"); }}
                                        className={`w-full text-left px-2 py-1.5 rounded-lg text-xs flex items-center gap-2 transition ${
                                            isActive ? "bg-mint-50 ring-1 ring-mint-300" :
                                            st.locked ? "hover:bg-red-50" :
                                            st.passed ? "hover:bg-green-50" :
                                            "hover:bg-gray-50"
                                        }`}>
                                        <span className="text-lg flex-shrink-0">{m.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="font-semibold text-gray-700 truncate">{m.code}</div>
                                            <div className="text-[10px] text-gray-500 truncate">{tx(m.titleEn, m.titleEs)}</div>
                                        </div>
                                        <span className="text-xs flex-shrink-0">
                                            {st.locked ? "🔒" : st.passed ? "✅" : doneL > 0 ? `${pct}%` : ""}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        );
    })();

    // The Shell wrapper itself lives at module scope (see above) so its
    // element type is stable across renders; each view passes the sidebar in.

    // Quiz view
    if (view === "quiz" && activeModule) {
        const m = activeModule;
        const allAnswered = m.quiz.questions.every(q => quizAnswers[q.id]);
        return (
            <Shell sidebar={moduleListSidebar} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(o => !o)} isEn={isEn}><div className="p-4 md:p-5">
                <button onClick={() => setView("module")} className="text-sm text-mint-700 mb-3">← {tx("Back to module", "Volver al módulo")}</button>
                <h2 className="text-xl font-bold text-mint-700 mb-1">{m.icon} {tx(m.titleEn, m.titleEs)} — {tx("Quiz", "Examen")}</h2>
                <p className="text-xs text-gray-500 mb-4">{tx(`Pass ${Math.round(m.quiz.passThreshold * 100)}% to clear this module. Two failed attempts in a row will lock the module — your manager has to clear the lock.`, `Aprueba con ${Math.round(m.quiz.passThreshold * 100)}% para completar este módulo. Dos intentos fallidos seguidos bloquean el módulo — tu gerente debe quitar el bloqueo.`)}</p>
                {m.quiz.questions.map((q, qi) => (
                    <div key={q.id} className="mb-5 p-4 bg-white border border-gray-200 rounded-xl">
                        <div className="text-sm font-bold text-gray-800 mb-3">{qi + 1}. {tx(q.questionEn, q.questionEs)}</div>
                        <div className="space-y-2">
                            {orderQuizOptions(q.options, `${quizSeed}|${q.id}`).map((opt, oi) => {
                                const selected = quizAnswers[q.id] === opt.id;
                                return (
                                    <button key={opt.id} onClick={() => setQuizAnswers(prev => ({ ...prev, [q.id]: opt.id }))}
                                        className={`w-full text-left px-3 py-2 rounded-lg border-2 transition ${selected ? "bg-mint-50 border-mint-500" : "bg-white border-gray-200 hover:border-gray-300"}`}>
                                        <span className="font-bold text-mint-700 mr-2">{String.fromCharCode(65 + oi)}.</span>
                                        <span className="text-sm">{tx(opt.textEn, opt.textEs)}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}
                <button onClick={submitQuiz} disabled={!allAnswered || submittingQuiz}
                    className={`w-full py-3 rounded-xl font-bold text-white text-base ${allAnswered && !submittingQuiz ? "bg-mint-700 hover:bg-mint-800" : "bg-gray-300 cursor-not-allowed"}`}>
                    {submittingQuiz ? tx("Submitting…", "Enviando…") : tx("Submit Quiz", "Enviar Examen")}
                </button>
                {!allAnswered && <p className="text-xs text-gray-500 text-center mt-2">{tx("Answer every question to submit", "Responde todas las preguntas para enviar")}</p>}
            </div></Shell>
        );
    }

    // Quiz result
    if (view === "quiz-result" && lastResult && activeModule) {
        const r = lastResult;
        return (
            <Shell sidebar={moduleListSidebar} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(o => !o)} isEn={isEn}><div className="p-4 md:p-5">
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
            </div></Shell>
        );
    }

    // Lesson reader
    if (view === "lesson" && activeLesson && activeModule) {
        const m = activeModule;
        const lIdx = m.lessons.findIndex(l => l.id === activeLessonId);
        const completed = moduleState(m.id).lessonsCompleted.includes(activeLessonId);
        const content = isEn ? activeLesson.contentEn : activeLesson.contentEs;
        const overrideKey = `${m.id}__${activeLesson.id}`;
        const hasOverride = !!overrides[overrideKey];
        return (
            <Shell sidebar={moduleListSidebar} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(o => !o)} isEn={isEn}><div className="p-4 md:p-5">
                <button onClick={() => setView("module")} className="text-sm text-mint-700 mb-3">← {tx("Back to module", "Volver al módulo")}</button>
                <p className="text-xs text-gray-500 mb-1">{m.code} · {tx("Lesson", "Lección")} {lIdx + 1} / {m.lessons.length}</p>
                <div className="flex items-start gap-2 mb-4">
                    <h2 className="text-xl font-bold text-mint-700 flex-1">{tx(activeLesson.titleEn, activeLesson.titleEs)}</h2>
                    {adminUser && (
                        <button onClick={() => setEditorOpen(true)}
                            className="shrink-0 px-3 py-1.5 rounded-lg bg-purple-100 text-purple-800 text-xs font-bold border border-purple-300 hover:bg-purple-200"
                            title={tx("Admin: edit this lesson's content", "Admin: editar el contenido de esta lección")}>
                            ✏️ {tx("Edit", "Editar")}{hasOverride ? ` · ${tx("edited", "editada")}` : ""}
                        </button>
                    )}
                </div>
                {editorOpen && adminUser && (
                    <LessonEditor
                        lesson={activeLesson}
                        moduleId={m.id}
                        moduleCode={m.code}
                        lessonIdx={lIdx}
                        overrideKey={overrideKey}
                        hasOverride={hasOverride}
                        editorBy={staffName}
                        isEn={isEn}
                        tx={tx}
                        onClose={() => setEditorOpen(false)}
                    />
                )}

                {/* YouTube video — renders above the lesson text. Picks
                    videoIdEs for Spanish viewers if set, falls back to
                    videoIdEn so EN-only-video lessons still play for ES
                    staff (YouTube auto-captions can bridge the gap).
                    Lazy-loaded (loading="lazy" on the iframe) so a
                    module with 8 lessons doesn't kick off 8 YouTube
                    embeds when the staff scrolls. Privacy-enhanced
                    domain (youtube-nocookie.com) reduces tracking. */}
                {(() => {
                    const rawVid = (isEn ? null : activeLesson.videoIdEs) || activeLesson.videoIdEn;
                    const vid = parseYouTubeId(rawVid) || (typeof rawVid === 'string' && /^[A-Za-z0-9_-]{11}$/.test(rawVid) ? rawVid : null);
                    if (!vid) return null;
                    return (
                        <div className="mb-4 rounded-xl overflow-hidden border border-gray-200 shadow-sm bg-black">
                            <div className="relative w-full" style={{ aspectRatio: '16 / 9' }}>
                                <iframe
                                    src={`https://www.youtube-nocookie.com/embed/${vid}?rel=0&modestbranding=1`}
                                    title={tx(activeLesson.titleEn, activeLesson.titleEs)}
                                    loading="lazy"
                                    referrerPolicy="strict-origin-when-cross-origin"
                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                                    allowFullScreen
                                    className="absolute inset-0 w-full h-full"
                                />
                            </div>
                        </div>
                    );
                })()}

                <div className="space-y-3 text-gray-800 text-[15px] md:text-base leading-relaxed">
                    {content.map((para, i) => (
                        <p key={i} className={para.startsWith("•") || para.startsWith("—") || /^\d+\./.test(para) ? "ml-2" : ""}>{para}</p>
                    ))}
                </div>
                {activeLesson.matrix && <AllergenMatrix matrix={activeLesson.matrix} isEn={isEn} />}
                <div className="mt-6 flex gap-2">
                    {lIdx > 0 && (
                        <button onClick={() => setActiveLessonId(m.lessons[lIdx - 1].id)}
                            className="flex-1 py-3 rounded-xl bg-gray-200 text-gray-700 font-bold">← {tx("Previous", "Anterior")}</button>
                    )}
                    {!completed && (
                        <button onClick={() => {
                            // 2026-08-17: advance FIRST, persist in the background.
                            // Awaiting the write here made every "Mark as read"
                            // cost a server round-trip (seconds on bad Wi-Fi, a
                            // dead-looking button on a wedged transport) and, if
                            // the reader had already tapped Next, the late
                            // setActiveLessonId yanked them back a lesson.
                            const lessonId = activeLessonId;
                            if (lIdx < m.lessons.length - 1) setActiveLessonId(m.lessons[lIdx + 1].id);
                            else setView("module");
                            markLessonComplete(m.id, lessonId).catch(e => {
                                console.error('lesson-complete save failed:', e);
                                toast(tx('⚠ Could not save that lesson as read — check your connection.',
                                         '⚠ No se pudo guardar la lección como leída — revisa tu conexión.'), { kind: 'warn' });
                            });
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
            </div></Shell>
        );
    }

    // Module detail
    if (view === "module" && activeModule) {
        const m = activeModule;
        const st = moduleState(m.id);
        const allLessonsRead = m.lessons.every(l => st.lessonsCompleted.includes(l.id));
        const failsInRow = (() => {
            // 2026-06-20 (QA audit T1): stop counting at the most recent manager
            // unlock so the "X failed in a row" warning resets after an unlock
            // (was counting across unlocks → an ever-growing stale count).
            const unlockedAt = st.unlockedAt || null;
            let c = 0;
            for (let i = (st.attempts || []).length - 1; i >= 0; i--) {
                const a = st.attempts[i];
                if (a.passed) break;
                if (unlockedAt && (a.at || '') <= unlockedAt) break;
                c += 1;
            }
            return c;
        })();
        return (
            <Shell sidebar={moduleListSidebar} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(o => !o)} isEn={isEn}><div className="p-4 md:p-5">
                <button onClick={() => { setView("list"); setActiveModuleId(null); }} className="text-sm text-mint-700 mb-3">← {tx("All modules", "Todos los módulos")}</button>
                <div className="flex items-start gap-3 mb-4">
                    <div className="text-4xl">{m.icon}</div>
                    <div className="flex-1">
                        <p className="text-xs text-gray-500">{m.code} · {m.durationMin} {tx("min", "min")} · {TRACK_LABELS[m.track][isEn ? "en" : "es"]}</p>
                        <h2 className="text-xl font-bold text-mint-700">
                            {tx(m.titleEn, m.titleEs)}
                            {m.draft && <span className="ml-2 text-[10px] font-black px-1.5 py-0.5 rounded bg-gray-800 text-white align-middle">{tx("DRAFT — admins only until published", "BORRADOR — solo admins hasta publicar")}</span>}
                        </h2>
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
                <button onClick={() => { if (progressReady && !st.locked && allLessonsRead) { setQuizAnswers({}); setQuizSeed(Date.now()); setView("quiz"); } }}
                    disabled={!progressReady || st.locked || !allLessonsRead}
                    className={`w-full p-4 rounded-xl border-2 text-left transition ${
                        st.locked ? "bg-red-50 border-red-300 cursor-not-allowed" :
                        !progressReady || !allLessonsRead ? "bg-gray-50 border-gray-200 cursor-not-allowed" :
                        st.passed ? "bg-green-50 border-green-300 hover:border-green-500" :
                        "bg-mint-50 border-mint-300 hover:border-mint-500"}`}>
                    <div className="flex items-center justify-between">
                        <div>
                            <div className="text-sm font-bold text-gray-800">
                                {st.locked ? "🔒 " : st.passed ? "✅ " : "📝 "}
                                {tx("Take the quiz", "Tomar el examen")}
                                <span className="text-xs font-normal text-gray-500 ml-2">{m.quiz.questions.length} {tx("questions", "preguntas")} · {Math.round(m.quiz.passThreshold * 100)}% {tx("to pass", "para aprobar")}</span>
                            </div>
                            {!progressReady && (
                                <div className="text-xs text-gray-500 mt-1">{tx("Syncing your progress…", "Sincronizando tu progreso…")}</div>
                            )}
                            {progressReady && !allLessonsRead && !st.locked && (
                                <div className="text-xs text-gray-500 mt-1">{tx("Read all lessons first", "Lee todas las lecciones primero")}</div>
                            )}
                            {failsInRow > 0 && !st.locked && !st.passed && (
                                <div className="text-xs text-amber-700 mt-1">⚠️ {failsInRow} {tx("failed attempt(s) in a row — one more locks the module", "intento(s) fallido(s) seguido(s) — uno más bloquea el módulo")}</div>
                            )}
                        </div>
                    </div>
                </button>
            </div></Shell>
        );
    }

    // Tracker (admin)
    if (view === "tracker" && canTrack) {
        const docs = Object.entries(allProgress);
        return (
            <Shell sidebar={moduleListSidebar} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(o => !o)} isEn={isEn}><div className="p-4 md:p-5">
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
            </div></Shell>
        );
    }

    // Module list (default)
    const grouped = TRACK_ORDER.map(track => ({
        track,
        modules: visibleModules.filter(m => m.track === track),
    })).filter(g => g.modules.length > 0);

    return (
        <Shell sidebar={moduleListSidebar} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(o => !o)} isEn={isEn}><div className="p-4 md:p-5">
            <PageHeader
                icon={GraduationCap}
                title={t("trainingHub", language) || tx("Training Hub", "Centro de Capacitación")}
                subtitle={tx(
                    "Read each lesson, then pass the quiz to clear the module. 80% to pass; safety modules require 85%.",
                    "Lee cada lección, luego aprueba el examen para completar el módulo. 80% para aprobar; los módulos de seguridad requieren 85%.",
                )}
                actions={canTrack && (
                    <button onClick={() => { loadTracker(); setView("tracker"); }}
                        className="glass-button-apple inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
                        <BarChart3 size={14} strokeWidth={2.25} aria-hidden="true" />
                        {tx("Tracker", "Progreso")}
                    </button>
                )}
            />

            {/* Required-training banner (2026-08-18): one card per open
                assignment this staffer is on and hasn't passed yet. */}
            {myAssignments.filter(a => !a.done).map(a => {
                const m = visibleModules.find(x => x.id === a.moduleId);
                if (!m) return null;
                const overdue = a.dueMs > 0 && Date.now() > a.dueMs;
                return (
                    <div key={a.id} className={`mb-3 rounded-xl border-2 p-3 flex items-center gap-3 ${overdue ? "border-red-400 bg-red-50" : "border-amber-400 bg-amber-50"}`}>
                        <div className="text-2xl">{overdue ? "⏰" : "📌"}</div>
                        <div className="flex-1 min-w-0">
                            <div className={`text-[11px] font-black uppercase tracking-wide ${overdue ? "text-red-800" : "text-amber-800"}`}>
                                {overdue ? tx("Overdue — required training", "Vencida — capacitación requerida") : tx("Required training", "Capacitación requerida")}
                            </div>
                            <div className="text-sm font-bold text-gray-900 truncate">{m.code} · {tx(m.titleEn, m.titleEs)}</div>
                            <div className="text-xs text-gray-700">
                                {tx("Due by", "Fecha límite:")} {fmtDue(a.dueMs, isEn ? "en" : "es")} · {tx("read the lessons, then pass the quiz", "lee las lecciones y aprueba el examen")}
                            </div>
                        </div>
                        <button onClick={() => { setActiveModuleId(m.id); setView("module"); }}
                            className={`px-3 py-2 rounded-lg text-white text-xs font-black whitespace-nowrap ${overdue ? "bg-red-600" : "bg-amber-600"}`}>
                            {tx("Start →", "Empezar →")}
                        </button>
                    </div>
                );
            })}

            {grouped.map(g => (
                <div key={g.track} className="mb-5">
                    <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">{TRACK_ICONS[g.track]} {TRACK_LABELS[g.track][isEn ? "en" : "es"]}</h3>
                    <div className="space-y-2">
                        {g.modules.map(m => {
                            const st = moduleState(m.id);
                            const totalL = m.lessons.length;
                            const doneL = st.lessonsCompleted.length;
                            const pct = totalL > 0 ? Math.round(doneL / totalL * 100) : 0;
                            const asg = assignmentByModule.get(m.id);
                            const asgOverdue = asg && !asg.done && asg.dueMs > 0 && Date.now() > asg.dueMs;
                            return (
                                <button key={m.id} onClick={() => { setActiveModuleId(m.id); setView("module"); }}
                                    className={`w-full text-left p-3 bg-white border-2 rounded-xl transition flex items-center gap-3 ${
                                        st.locked ? "border-red-300" :
                                        st.passed ? "border-green-300" :
                                        asg && !asg.done ? (asgOverdue ? "border-red-400" : "border-amber-400") :
                                        "border-gray-200 hover:border-mint-300"}`}>
                                    <div className="text-3xl">{m.icon}</div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-gray-800 truncate">
                                            {m.code} · {tx(m.titleEn, m.titleEs)}
                                            {m.draft && <span className="ml-2 text-[10px] font-black px-1.5 py-0.5 rounded bg-gray-800 text-white align-middle">DRAFT</span>}
                                        </div>
                                        <div className="text-xs text-gray-500">
                                            {totalL} {tx("lessons", "lecciones")} · {m.durationMin} {tx("min", "min")}
                                            {asg && !asg.done && (
                                                <span className={`ml-2 font-bold ${asgOverdue ? "text-red-700" : "text-amber-700"}`}>
                                                    · {asgOverdue ? tx("OVERDUE", "VENCIDA") : tx("due", "vence")} {fmtDue(asg.dueMs, isEn ? "en" : "es")}
                                                </span>
                                            )}
                                        </div>
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
        </div></Shell>
    );
}

// ── LessonEditor ─────────────────────────────────────────────────────
// Admin-only inline editor for a single lesson. Reads from the merged
// lesson (static + any existing override) so the admin sees current
// state, edits in place, and saves back to
// /config/training_overrides.{moduleId}__{lessonId}.
//
// Storage shape — one giant doc with one key per edited lesson:
//   /config/training_overrides = {
//     "m6__m6-l2": { titleEn, titleEs, contentEn[], contentEs[],
//                    editedAt, editedBy },
//     ...
//   }
// Why one doc vs collection: 50-ish lessons max, edits are
// infrequent, easier to snapshot-listen to one doc than collect a
// collection. Stays under Firestore's 1MB doc limit comfortably (we
// estimated ~140KB even if every lesson is edited).
//
// "Revert" button drops the override key so the static training.js
// content takes over again — useful if Andrew makes a mess and wants
// to roll back without redeploying.
function LessonEditor({ lesson, moduleId, moduleCode, lessonIdx, overrideKey, hasOverride, editorBy, isEn, tx, onClose }) {
    const [titleEn, setTitleEn] = useState(lesson.titleEn || "");
    const [titleEs, setTitleEs] = useState(lesson.titleEs || "");
    const [bodyEn, setBodyEn] = useState((lesson.contentEn || []).join("\n"));
    const [bodyEs, setBodyEs] = useState((lesson.contentEs || []).join("\n"));
    // YouTube video state — admins paste either a full URL
    // (https://youtu.be/... / https://www.youtube.com/watch?v=...) OR
    // a raw 11-char video ID. parseYouTubeId() normalizes both. We
    // store the parsed ID on the override doc so the renderer can
    // skip parsing on every page view. (2026-05-17.)
    const [videoUrlEn, setVideoUrlEn] = useState(lesson.videoIdEn || "");
    const [videoUrlEs, setVideoUrlEs] = useState(lesson.videoIdEs || "");
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState(null);

    const enLines = bodyEn.split("\n").map(s => s.trimEnd()).filter(s => s.length > 0);
    const esLines = bodyEs.split("\n").map(s => s.trimEnd()).filter(s => s.length > 0);
    const balanced = enLines.length === esLines.length;

    // Parsed video IDs — null if the input field is empty OR doesn't
    // look like a YouTube URL/ID. Surface the error inline so admins
    // know to paste a different URL before saving.
    const trimEn = videoUrlEn.trim();
    const trimEs = videoUrlEs.trim();
    const parsedVidEn = trimEn ? parseYouTubeId(trimEn) : null;
    const parsedVidEs = trimEs ? parseYouTubeId(trimEs) : null;
    const videoEnInvalid = trimEn && !parsedVidEn;
    const videoEsInvalid = trimEs && !parsedVidEs;

    const save = async () => {
        // Hard block on an empty title or body in either language — an
        // empty override used to blank the lesson for everyone (2026-08-17).
        if (!titleEn.trim() || !titleEs.trim() || enLines.length === 0 || esLines.length === 0) {
            setErr(tx(
                "Title and body are required in BOTH languages. To drop your edits, use “Revert to default” instead.",
                "El título y el cuerpo son obligatorios en AMBOS idiomas. Para descartar tus cambios usa “Revertir”."
            ));
            return;
        }
        if (!balanced) {
            if (!confirm(tx(
                `EN has ${enLines.length} lines, ES has ${esLines.length}. Save anyway? The bilingual renderer expects them to match.`,
                `EN tiene ${enLines.length} líneas, ES tiene ${esLines.length}. ¿Guardar igual? El renderer bilingüe espera que coincidan.`
            ))) return;
        }
        if (videoEnInvalid || videoEsInvalid) {
            if (!confirm(tx(
                "One of the video URLs doesn't look like a YouTube link. Save anyway? Staff won't see a video until you fix it.",
                "Una de las URLs de video no parece un enlace de YouTube. ¿Guardar igual? Los empleados no verán video hasta corregirlo."
            ))) return;
        }
        setSaving(true); setErr(null);
        try {
            const ref = doc(db, "config", "training_overrides");
            const patch = {
                [overrideKey]: {
                    titleEn: titleEn.trim(),
                    titleEs: titleEs.trim(),
                    contentEn: enLines,
                    contentEs: esLines,
                    // Store the normalized 11-char ID, NOT the URL the
                    // admin pasted. Keeps the override doc small and
                    // lets the renderer iframe URL be constructed with
                    // no per-render parsing. Falls back to the raw
                    // trimmed input only if the parser couldn't pull
                    // a valid ID — preserves user input for the next
                    // edit even if it's malformed.
                    videoIdEn: parsedVidEn || (trimEn || null),
                    videoIdEs: parsedVidEs || (trimEs || null),
                    editedAt: new Date().toISOString(),
                    editedBy: editorBy || "admin",
                }
            };
            try {
                await updateDoc(ref, patch);
            } catch (e) {
                // First-time create
                await setDoc(ref, patch, { merge: true });
            }
            onClose();
        } catch (e) {
            console.error("lesson save failed:", e);
            setErr(e.message || String(e));
            setSaving(false);
        }
    };

    const revert = async () => {
        if (!confirm(tx(
            "Revert this lesson to the deployed default? Your in-app edits will be discarded.",
            "¿Revertir esta lección al contenido por defecto? Tus ediciones se perderán."
        ))) return;
        setSaving(true); setErr(null);
        try {
            const ref = doc(db, "config", "training_overrides");
            await updateDoc(ref, { [overrideKey]: deleteField() });
            onClose();
        } catch (e) {
            console.error("lesson revert failed:", e);
            setErr(e.message || String(e));
            setSaving(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-3 overflow-y-auto"
            onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="bg-white w-full max-w-3xl rounded-2xl shadow-2xl mt-4 mb-4">
                <div className="sticky top-0 bg-white border-b border-gray-200 px-4 py-3 rounded-t-2xl flex items-center justify-between">
                    <div>
                        <div className="text-xs text-gray-500">{moduleCode} · {tx("Lesson", "Lección")} {lessonIdx + 1}</div>
                        <h3 className="text-lg font-bold text-purple-800">✏️ {tx("Edit lesson", "Editar lección")}</h3>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                </div>
                <div className="p-4 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-bold text-gray-600 mb-1">{tx("Title (EN)", "Título (EN)")}</label>
                            <input type="text" value={titleEn} onChange={e => setTitleEn(e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-600 mb-1">{tx("Title (ES)", "Título (ES)")}</label>
                            <input type="text" value={titleEs} onChange={e => setTitleEs(e.target.value)}
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                    </div>
                    {/* YouTube video URLs — optional, one per language.
                        Paste a full URL or just the 11-char ID; the
                        save handler normalizes both to the ID. If you
                        only have EN, leave ES blank and Spanish
                        viewers will get the same video (YouTube auto-
                        captioning can handle the language gap). */}
                    <div className="border-t border-gray-200 pt-3">
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-bold text-gray-600">
                                🎬 {tx("YouTube video (optional)", "Video de YouTube (opcional)")}
                            </label>
                            <span className="text-[10px] text-gray-400">
                                {tx("paste URL or ID", "pega URL o ID")}
                            </span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                                <label className="block text-[11px] text-gray-500 mb-1">{tx("English video", "Video en inglés")}</label>
                                <input
                                    type="text"
                                    value={videoUrlEn}
                                    onChange={e => setVideoUrlEn(e.target.value)}
                                    placeholder="https://youtu.be/dQw4w9WgXcQ"
                                    className={`w-full border rounded-lg px-3 py-2 text-sm font-mono ${
                                        videoEnInvalid ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                />
                                {parsedVidEn && (
                                    <p className="text-[10px] text-green-700 mt-0.5">
                                        ✓ ID: <span className="font-mono">{parsedVidEn}</span>
                                    </p>
                                )}
                                {videoEnInvalid && (
                                    <p className="text-[10px] text-red-700 mt-0.5">
                                        ⚠ {tx("Not a recognizable YouTube link", "No parece un enlace de YouTube")}
                                    </p>
                                )}
                            </div>
                            <div>
                                <label className="block text-[11px] text-gray-500 mb-1">{tx("Spanish video (optional)", "Video en español (opcional)")}</label>
                                <input
                                    type="text"
                                    value={videoUrlEs}
                                    onChange={e => setVideoUrlEs(e.target.value)}
                                    placeholder={tx("leave blank to reuse EN video", "déjalo vacío para usar el video EN")}
                                    className={`w-full border rounded-lg px-3 py-2 text-sm font-mono ${
                                        videoEsInvalid ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                    }`}
                                />
                                {parsedVidEs && (
                                    <p className="text-[10px] text-green-700 mt-0.5">
                                        ✓ ID: <span className="font-mono">{parsedVidEs}</span>
                                    </p>
                                )}
                                {videoEsInvalid && (
                                    <p className="text-[10px] text-red-700 mt-0.5">
                                        ⚠ {tx("Not a recognizable YouTube link", "No parece un enlace de YouTube")}
                                    </p>
                                )}
                            </div>
                        </div>
                        <p className="text-[10px] text-gray-500 leading-relaxed mt-1.5">
                            {tx(
                                "Tip: upload as Unlisted on YouTube so only people with the link can watch. The link goes here. Public viewing isn't required.",
                                "Consejo: sube como 'No listado' en YouTube para que solo quienes tengan el enlace puedan ver. El enlace va aquí. No necesita ser público."
                            )}
                        </p>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                        {tx(
                            "One bullet per line. Blank lines are dropped. Keep EN and ES at the same number of lines so the bilingual renderer doesn't drift.",
                            "Un punto por línea. Las líneas en blanco se eliminan. Mantén EN y ES con el mismo número de líneas para que el renderer bilingüe no se desfase."
                        )}
                    </p>
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-bold text-gray-600">{tx("Body (EN)", "Cuerpo (EN)")} — {enLines.length} {tx("bullets", "puntos")}</label>
                        </div>
                        <textarea value={bodyEn} onChange={e => setBodyEn(e.target.value)}
                            rows={Math.max(8, Math.min(24, enLines.length + 2))}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono" />
                    </div>
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-bold text-gray-600">{tx("Body (ES)", "Cuerpo (ES)")} — {esLines.length} {tx("bullets", "puntos")}</label>
                        </div>
                        <textarea value={bodyEs} onChange={e => setBodyEs(e.target.value)}
                            rows={Math.max(8, Math.min(24, esLines.length + 2))}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono" />
                    </div>
                    {!balanced && (
                        <div className="p-2 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-900">
                            ⚠ {tx(`EN has ${enLines.length} lines, ES has ${esLines.length} — they should match.`,
                                  `EN tiene ${enLines.length} líneas, ES tiene ${esLines.length} — deberían coincidir.`)}
                        </div>
                    )}
                    {err && (
                        <div className="p-2 rounded-lg bg-red-50 border border-red-300 text-xs text-red-800">
                            {err}
                        </div>
                    )}
                </div>
                <div className="sticky bottom-0 bg-white border-t border-gray-200 px-4 py-3 rounded-b-2xl flex items-center gap-2">
                    {hasOverride && (
                        <button onClick={revert} disabled={saving}
                            className="px-3 py-2 rounded-lg bg-white border-2 border-red-300 text-red-700 text-sm font-bold hover:bg-red-50 disabled:opacity-50">
                            ↩ {tx("Revert to default", "Revertir")}
                        </button>
                    )}
                    <div className="flex-1" />
                    <button onClick={onClose} disabled={saving}
                        className="px-4 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold hover:bg-gray-200 disabled:opacity-50">
                        {tx("Cancel", "Cancelar")}
                    </button>
                    <button onClick={save} disabled={saving}
                        className="px-4 py-2 rounded-lg bg-mint-700 text-white text-sm font-bold hover:bg-mint-800 disabled:opacity-50">
                        {saving ? tx("Saving…", "Guardando…") : tx("Save", "Guardar")}
                    </button>
                </div>
            </div>
        </div>
    );
}
