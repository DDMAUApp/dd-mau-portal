// AppTour — page-by-page guided walkthrough of every tab in the app.
//
// Andrew 2026-05-30 — "i want to make a lession to go through all
// the features of the app. page by page. some people wont use
// certain pages so i want to be able to give acces to just the
// pages you are able to get into."
//
// UX:
//   - Grid view: one card per lesson the viewer can actually open
//     (access-filtered via APP_TOUR_LESSONS[i].accessCheck). Each
//     card shows icon + title + subtitle + step count + progress.
//   - Detail view: a step navigator with Previous / Next, a Mark
//     Complete button at the end of each lesson, and an optional
//     "Try it →" jump that navigates to the actual tab.
//   - Progress persists per-staff in /app_tour_progress/{staffDocId}
//     so the viewer sees ✓ on lessons they finished, and the
//     current step on lessons they started.
//
// Data: src/data/appTourLessons.js. Add or edit lessons there.
// Renderer doesn't need to know about specific lesson IDs — it
// walks the array and filters by accessCheck.

import { useEffect, useMemo, useState } from 'react';
import { db } from '../firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { toast } from '../toast';
import {
    Home, Calendar, MessageSquare, ListChecks, Shield, BookOpen,
    Megaphone, Inbox, Image as ImageIcon, Wrench, Plus, ChevronRight,
    ChevronLeft, Check, CheckCircle2, ArrowLeft, ArrowRight, Lightbulb,
    ExternalLink, Layers,
} from 'lucide-react';
import {
    APP_TOUR_LESSONS, getVisibleLessons,
} from '../data/appTourLessons';

// Map lucide icon names from lesson data → actual components. Keep
// the set explicit so the Vite bundler can tree-shake; importing
// the whole lucide-react chunk per icon name would bloat the page.
const ICONS = {
    Home, Calendar, MessageSquare, ListChecks, Shield, BookOpen,
    Megaphone, Inbox, ImageIcon, Wrench, Layers,
};

// Tailwind color palette per lesson card. Sage = default, sky =
// chat-like, emerald = schedule-like, amber = ops-like, rose = admin,
// purple = creative, indigo = onboarding. Keys must match lesson.color.
const TONE = {
    sage:     { ring: 'ring-dd-sage-200',  bg: 'bg-dd-sage-50',   chip: 'bg-dd-green-50 text-dd-green-700' },
    sky:      { ring: 'ring-sky-200',      bg: 'bg-sky-50',       chip: 'bg-sky-100 text-sky-800' },
    emerald:  { ring: 'ring-emerald-200',  bg: 'bg-emerald-50',   chip: 'bg-emerald-100 text-emerald-800' },
    amber:    { ring: 'ring-amber-200',    bg: 'bg-amber-50',     chip: 'bg-amber-100 text-amber-800' },
    purple:   { ring: 'ring-purple-200',   bg: 'bg-purple-50',    chip: 'bg-purple-100 text-purple-800' },
    rose:     { ring: 'ring-rose-200',     bg: 'bg-rose-50',      chip: 'bg-rose-100 text-rose-800' },
    indigo:   { ring: 'ring-indigo-200',   bg: 'bg-indigo-50',    chip: 'bg-indigo-100 text-indigo-800' },
};
const toneOf = (lesson) => TONE[lesson.color] || TONE.sage;

const staffDocIdOf = (name) => (name || 'unknown').toLowerCase().replace(/\s+/g, '_');

export default function AppTour({
    language = 'en',
    staffName,
    staff,
    staffList,
    onClose,        // optional — render a back button if provided
    onNavigateTab,  // optional — App.jsx passes setActiveTab so "Try it →" works
}) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const [progress, setProgress] = useState(null);   // { [lessonId]: { completed, step, completedAt } }
    const [activeLessonId, setActiveLessonId] = useState(null);
    const [activeStepIdx, setActiveStepIdx] = useState(0);
    const [loading, setLoading] = useState(true);
    const [savingProgress, setSavingProgress] = useState(false);

    // Filter lessons by viewer access — passes (staff, staffList) so
    // each lesson can apply the same predicate as the actual tab in
    // App.jsx. A lesson with accessCheck returning false is hidden
    // entirely from this grid.
    const visibleLessons = useMemo(
        () => getVisibleLessons(staff, staffList),
        [staff, staffList]
    );

    // Load progress doc on mount.
    useEffect(() => {
        let mounted = true;
        if (!staffName) { setLoading(false); return; }
        getDoc(doc(db, 'app_tour_progress', staffDocIdOf(staffName)))
            .then(snap => {
                if (!mounted) return;
                setProgress(snap.exists() ? (snap.data().lessons || {}) : {});
            })
            .catch(err => {
                console.warn('[AppTour] progress load failed:', err);
                if (mounted) setProgress({});
            })
            .finally(() => mounted && setLoading(false));
        return () => { mounted = false; };
    }, [staffName]);

    const persistProgress = async (nextLessons) => {
        if (!staffName) return;
        setProgress(nextLessons);
        setSavingProgress(true);
        try {
            await setDoc(doc(db, 'app_tour_progress', staffDocIdOf(staffName)), {
                staffName,
                lessons: nextLessons,
                updatedAt: serverTimestamp(),
            }, { merge: true });
        } catch (e) {
            console.warn('[AppTour] progress save failed:', e);
        } finally {
            setSavingProgress(false);
        }
    };

    const markComplete = async (lessonId, stepIdx) => {
        const next = {
            ...(progress || {}),
            [lessonId]: {
                completed: true,
                step: stepIdx,
                completedAt: new Date().toISOString(),
            },
        };
        await persistProgress(next);
        toast(tx('Marked complete ✓', 'Marcado como completo ✓'));
    };

    const setLessonStep = async (lessonId, stepIdx) => {
        const prev = (progress || {})[lessonId] || {};
        const next = {
            ...(progress || {}),
            [lessonId]: {
                ...prev,
                step: stepIdx,
                // Don't un-complete on revisit.
                completed: prev.completed === true,
            },
        };
        // Best-effort; don't await — keeps the navigator snappy.
        persistProgress(next);
    };

    const completedCount = Object.values(progress || {}).filter(p => p.completed).length;

    if (loading) {
        return (
            <div className="p-6 text-center text-sm text-dd-text-2 italic">
                {tx('Loading lessons…', 'Cargando lecciones…')}
            </div>
        );
    }

    // ── Lesson detail view ───────────────────────────────────────
    if (activeLessonId) {
        const lesson = visibleLessons.find(l => l.id === activeLessonId);
        if (!lesson) {
            // Shouldn't happen normally, but defensive — back to grid.
            setActiveLessonId(null);
            return null;
        }
        return (
            <LessonDetail
                lesson={lesson}
                stepIdx={activeStepIdx}
                progress={(progress || {})[lesson.id] || {}}
                language={language}
                onStepChange={(idx) => {
                    setActiveStepIdx(idx);
                    setLessonStep(lesson.id, idx);
                }}
                onBack={() => { setActiveLessonId(null); setActiveStepIdx(0); }}
                onMarkComplete={() => markComplete(lesson.id, activeStepIdx)}
                onTryItTab={onNavigateTab}
                savingProgress={savingProgress}
            />
        );
    }

    // ── Lesson grid view ─────────────────────────────────────────
    return (
        <section className="bg-white rounded-xl border border-dd-line shadow-card overflow-hidden">
            <header className="px-4 py-3 bg-dd-sage-50 border-b border-dd-line">
                <div className="flex items-start gap-3">
                    {onClose && (
                        <button onClick={onClose}
                            className="w-9 h-9 rounded-full hover:bg-white/60 flex items-center justify-center text-dd-text-2 shrink-0"
                            aria-label={tx('Back', 'Atrás')}>
                            <ArrowLeft size={16} strokeWidth={2.5} />
                        </button>
                    )}
                    <div className="w-10 h-10 rounded-full bg-white text-dd-green-700 flex items-center justify-center shrink-0 shadow-sm">
                        <BookOpen size={20} strokeWidth={2.25} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-base font-black text-dd-text">
                            {tx('App Tour — page by page', 'Tour de la app — página por página')}
                        </h2>
                        <p className="text-[11px] text-dd-text-2 leading-snug mt-0.5">
                            {tx(
                                'Walk through every page you can open. You only see lessons for pages you have access to.',
                                'Recorrido por cada página que puedes abrir. Solo ves lecciones para páginas con acceso.'
                            )}
                        </p>
                    </div>
                    <div className="text-right shrink-0">
                        <div className="text-xs font-black text-dd-green-700 tabular-nums">
                            {completedCount}/{visibleLessons.length}
                        </div>
                        <div className="text-[9px] font-bold uppercase tracking-wider text-dd-text-2/70">
                            {tx('Done', 'Hecho')}
                        </div>
                    </div>
                </div>
            </header>
            <div className="p-3 md:p-4">
                {visibleLessons.length === 0 ? (
                    <div className="p-6 text-center text-sm text-dd-text-2 italic">
                        {tx('No lessons available for your access level.',
                            'No hay lecciones disponibles para tu nivel de acceso.')}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                        {visibleLessons.map(lesson => {
                            const Icon = ICONS[lesson.icon] || BookOpen;
                            const tone = toneOf(lesson);
                            const p = (progress || {})[lesson.id] || {};
                            const stepNow = Math.min(p.step ?? 0, lesson.steps.length - 1);
                            const stepDisplay = p.completed
                                ? `${lesson.steps.length}/${lesson.steps.length}`
                                : `${stepNow + (p.step != null ? 1 : 0)}/${lesson.steps.length}`;
                            return (
                                <button key={lesson.id}
                                    onClick={() => { setActiveLessonId(lesson.id); setActiveStepIdx(stepNow); }}
                                    className={`text-left rounded-xl p-3 ${tone.bg} ring-1 ${tone.ring} hover:ring-2 transition active:scale-[0.99] flex flex-col gap-2`}>
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="w-10 h-10 rounded-full bg-white text-dd-text flex items-center justify-center shrink-0 shadow-sm">
                                            <Icon size={18} strokeWidth={2.25} />
                                        </div>
                                        {p.completed && (
                                            <CheckCircle2 size={20} className="text-emerald-600 shrink-0" strokeWidth={2.5} />
                                        )}
                                    </div>
                                    <div>
                                        <div className="text-sm font-black text-dd-text leading-tight">
                                            {lesson.title[language] || lesson.title.en}
                                        </div>
                                        <div className="text-[11px] text-dd-text-2 leading-snug mt-0.5">
                                            {lesson.subtitle[language] || lesson.subtitle.en}
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between text-[10px] font-bold tabular-nums">
                                        <span className={`px-2 py-0.5 rounded-full ${tone.chip}`}>
                                            {stepDisplay} {tx('steps', 'pasos')}
                                        </span>
                                        <span className="text-dd-text-2/70">
                                            {lesson.estMinutes ? `~${lesson.estMinutes} ${tx('min', 'min')}` : ''}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            <footer className="px-4 py-3 border-t border-dd-line bg-dd-bg/40 text-[11px] text-dd-text-2">
                {tx(
                    'These lessons are written for staff using the app on the floor. Tap a card to start, swipe through the steps, and mark complete when done.',
                    'Estas lecciones son para personal usando la app en el restaurante. Toca una tarjeta, avanza por los pasos y marca completo al terminar.'
                )}
            </footer>
        </section>
    );
}

// ── Lesson detail view ──────────────────────────────────────────────

function LessonDetail({
    lesson, stepIdx, progress, language,
    onStepChange, onBack, onMarkComplete, onTryItTab, savingProgress,
}) {
    const tx = (en, es) => (language === 'es' ? es : en);
    const Icon = ICONS[lesson.icon] || BookOpen;
    const tone = toneOf(lesson);
    const step = lesson.steps[stepIdx] || lesson.steps[0];
    const isLastStep = stepIdx === lesson.steps.length - 1;

    return (
        <section className="bg-white rounded-xl border border-dd-line shadow-card overflow-hidden">
            <header className={`px-4 py-3 ${tone.bg} border-b border-dd-line`}>
                <div className="flex items-start gap-3">
                    <button onClick={onBack}
                        className="w-9 h-9 rounded-full hover:bg-white/60 flex items-center justify-center text-dd-text-2 shrink-0"
                        aria-label={tx('Back to lessons', 'Volver a lecciones')}>
                        <ArrowLeft size={16} strokeWidth={2.5} />
                    </button>
                    <div className="w-10 h-10 rounded-full bg-white text-dd-text flex items-center justify-center shrink-0 shadow-sm">
                        <Icon size={20} strokeWidth={2.25} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 className="text-base font-black text-dd-text leading-tight">
                            {lesson.title[language] || lesson.title.en}
                        </h2>
                        <p className="text-[11px] text-dd-text-2 leading-snug mt-0.5">
                            {lesson.subtitle[language] || lesson.subtitle.en}
                        </p>
                    </div>
                    {progress.completed && (
                        <CheckCircle2 size={22} className="text-emerald-600 shrink-0" strokeWidth={2.5} />
                    )}
                </div>
                {/* Step pips */}
                <div className="mt-3 flex items-center gap-1">
                    {lesson.steps.map((_, i) => (
                        <button key={i}
                            onClick={() => onStepChange(i)}
                            aria-label={`Step ${i + 1}`}
                            className={`h-1.5 flex-1 rounded-full transition ${
                                i === stepIdx
                                    ? 'bg-dd-green'
                                    : i < stepIdx
                                        ? 'bg-dd-green/40'
                                        : 'bg-dd-line'
                            }`}
                        />
                    ))}
                </div>
                <div className="mt-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                    <span>{tx('Step', 'Paso')} {stepIdx + 1}/{lesson.steps.length}</span>
                    <span>{step.title[language] || step.title.en}</span>
                </div>
            </header>

            <div className="p-4 md:p-6">
                <h3 className="text-lg md:text-xl font-black text-dd-text mb-2 leading-tight">
                    {step.title[language] || step.title.en}
                </h3>
                <p className="text-sm md:text-base text-dd-text leading-relaxed whitespace-pre-wrap">
                    {step.body[language] || step.body.en}
                </p>
                {/* Optional screenshot. Andrew 2026-05-30. Public-folder
                    path (e.g. /screenshots/schedule-week.png) renders as
                    an <img>. Hosted via the same GitHub Pages deploy as
                    the app — no extra Storage roundtrip on view. If the
                    user is offline we fall back gracefully (broken-img
                    icon hidden; alt text serves as the label). */}
                {step.screenshot && (
                    <figure className="mt-4 rounded-xl overflow-hidden border border-dd-line bg-dd-bg/40 shadow-card">
                        <img
                            src={step.screenshot}
                            alt={step.screenshotAlt
                                ? (step.screenshotAlt[language] || step.screenshotAlt.en)
                                : (step.title[language] || step.title.en)}
                            loading="lazy"
                            className="w-full h-auto block"
                            onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                        {step.screenshotCaption && (
                            <figcaption className="px-3 py-2 text-[11px] text-dd-text-2 bg-white border-t border-dd-line/60 italic">
                                {step.screenshotCaption[language] || step.screenshotCaption.en}
                            </figcaption>
                        )}
                    </figure>
                )}
                {(step.tipEn || step.tipEs) && (
                    <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 flex items-start gap-2">
                        <Lightbulb size={16} className="text-amber-700 shrink-0 mt-0.5" strokeWidth={2.5} />
                        <div className="text-[12px] text-amber-900 leading-snug">
                            <span className="font-black uppercase tracking-wider text-[10px] mr-1.5">{tx('Tip', 'Consejo')}</span>
                            {language === 'es' ? (step.tipEs || step.tipEn) : step.tipEn}
                        </div>
                    </div>
                )}
                {step.tryItTab && onNavigateTab && (
                    <button onClick={() => onNavigateTab(step.tryItTab)}
                        className="mt-4 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-dd-green-50 text-dd-green-700 text-xs font-bold border border-dd-green/30 hover:bg-dd-sage-50 active:scale-95 transition">
                        <ExternalLink size={14} strokeWidth={2.5} />
                        {tx('Try it →', 'Pruébalo →')}
                    </button>
                )}
            </div>

            <footer className="px-4 py-3 border-t border-dd-line bg-dd-bg/40 flex items-center justify-between gap-2">
                <button onClick={() => onStepChange(Math.max(0, stepIdx - 1))}
                    disabled={stepIdx === 0}
                    className="px-3 py-2 rounded-lg bg-white border border-dd-line text-sm font-bold text-dd-text hover:bg-dd-bg disabled:opacity-40 disabled:cursor-not-allowed transition flex items-center gap-1.5">
                    <ChevronLeft size={14} strokeWidth={2.5} />
                    {tx('Previous', 'Anterior')}
                </button>
                {isLastStep ? (
                    <button onClick={onMarkComplete}
                        disabled={savingProgress}
                        className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-black hover:bg-dd-green-700 active:scale-95 transition flex items-center gap-1.5 disabled:opacity-60">
                        <Check size={14} strokeWidth={2.5} />
                        {progress.completed
                            ? tx('Re-mark complete', 'Re-marcar completo')
                            : tx('Mark complete', 'Marcar completo')}
                    </button>
                ) : (
                    <button onClick={() => onStepChange(Math.min(lesson.steps.length - 1, stepIdx + 1))}
                        className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 active:scale-95 transition flex items-center gap-1.5">
                        {tx('Next', 'Siguiente')}
                        <ChevronRight size={14} strokeWidth={2.5} />
                    </button>
                )}
            </footer>
        </section>
    );
}
