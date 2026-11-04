// FoodSafetyPage: every food safety rule at our stores, and a box to ask about one.
//
// Answers come only from the checked rule list (data/foodSafetyRules.js), word for
// word with their source. See data/foodSafetySearch.js for why that's not AI.
// Lessons and quizzes live in Training, under the Food Safety track.
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, GraduationCap, Search, X } from 'lucide-react';
import { FOOD_SAFETY_TOPICS } from '../data/foodSafetyRules';
import { searchFoodSafety } from '../data/foodSafetySearch';
import { FOOD_SAFETY_OPEN_TO_ALL } from '../data/foodSafetyVisibility';

const EXAMPLES = [
    { en: 'What is chicken cooked to?', es: '¿A qué temperatura se cocina el pollo?' },
    { en: 'How long to cool rice?', es: '¿Cuánto tiempo para enfriar el arroz?' },
    { en: 'Can I work if I have a fever?', es: '¿Puedo trabajar si tengo fiebre?' },
];

function RuleCard({ rule, isEs, topicTitle, showCheck }) {
    const title = isEs ? rule.titleEs : rule.titleEn;
    const body = isEs ? rule.es : rule.en;
    const exam = isEs ? rule.examEs : rule.examEn;
    return (
        <div className="rounded-xl border border-gray-200 bg-white p-3" data-rule-id={rule.id}>
            {topicTitle && <div className="text-[11px] font-semibold text-gray-500 mb-0.5">{topicTitle}</div>}
            <div className="font-bold text-gray-900 text-sm">{title}</div>
            <p className="text-sm text-gray-800 mt-1 leading-snug">{body}</p>
            {exam && (
                <p className="text-xs mt-2 rounded-lg bg-amber-50 text-amber-900 px-2 py-1.5 leading-snug">
                    {exam}
                </p>
            )}
            {showCheck && rule.checkFirst && (
                <p className="text-xs mt-2 rounded-lg bg-red-50 text-red-900 px-2 py-1.5 leading-snug" data-check-first>
                    <span className="font-bold">Check before opening to staff: </span>{rule.checkFirst}
                </p>
            )}
            <div className="text-[11px] text-gray-500 mt-2">{rule.source}</div>
        </div>
    );
}

export default function FoodSafetyPage({ language, onOpenTraining }) {
    const isEs = language === 'es';
    const [query, setQuery] = useState('');
    const [openTopic, setOpenTopic] = useState(null);
    const trimmed = query.trim();
    const results = useMemo(() => (trimmed ? searchFoodSafety(FOOD_SAFETY_TOPICS, trimmed) : []), [trimmed]);
    // Review notes are for the owner, and disappear once the tab opens to everyone.
    const showCheck = !FOOD_SAFETY_OPEN_TO_ALL;
    const ruleCount = useMemo(() => FOOD_SAFETY_TOPICS.reduce((n, t) => n + t.rules.length, 0), []);

    return (
        <div className="max-w-2xl mx-auto px-3 py-4 space-y-3">
            <div>
                <h1 className="text-xl font-black text-gray-900">{isEs ? 'Seguridad Alimentaria' : 'Food Safety'}</h1>
                <p className="text-xs text-gray-600 mt-0.5">
                    {isEs
                        ? `${ruleCount} reglas para nuestras tiendas: el código del Condado de St. Louis, y la regla más estricta cuando difieren.`
                        : `${ruleCount} rules for our stores: the St. Louis County code, and the stricter rule where they differ.`}
                </p>
            </div>

            {showCheck && (
                <div className="rounded-xl bg-red-50 border border-red-200 text-red-900 text-xs p-2.5 font-semibold">
                    Owner preview. Staff can't see this tab or its lessons until you've read the rules.
                </div>
            )}

            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={isEs ? 'Haz una pregunta o busca un alimento' : 'Ask a question or search a food'}
                    aria-label={isEs ? 'Haz una pregunta' : 'Ask a question'}
                    className="w-full rounded-xl border border-gray-300 bg-white pl-9 pr-9 py-2.5 text-base"
                />
                {query && (
                    <button type="button" onClick={() => setQuery('')} aria-label={isEs ? 'Borrar' : 'Clear'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500">
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>

            {trimmed ? (
                <div className="space-y-2" aria-live="polite">
                    {results.length ? results.map(({ rule, topic }) => (
                        <RuleCard key={rule.id} rule={rule} isEs={isEs} showCheck={showCheck}
                            topicTitle={isEs ? topic.titleEs : topic.titleEn} />
                    )) : (
                        <div className="rounded-xl border border-gray-200 bg-white p-3 text-sm text-gray-800">
                            <div className="font-bold">{isEs ? 'No tengo esa respuesta' : "I don't have an answer for that"}</div>
                            <p className="mt-1">
                                {isEs
                                    ? 'No adivines con la seguridad alimentaria. Pregúntale a un gerente, o intenta con otra palabra.'
                                    : "Don't guess with food safety. Ask a manager, or try a different word."}
                            </p>
                        </div>
                    )}
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap gap-1.5">
                        {EXAMPLES.map((ex) => {
                            const text = isEs ? ex.es : ex.en;
                            return (
                                <button key={ex.en} type="button" onClick={() => setQuery(text)}
                                    className="rounded-full bg-gray-100 text-gray-800 text-xs font-semibold px-3 py-1.5">
                                    {text}
                                </button>
                            );
                        })}
                    </div>

                    {onOpenTraining && (
                        <button type="button" onClick={onOpenTraining}
                            className="w-full flex items-center gap-2 rounded-xl bg-dd-green-50 border border-dd-green-200 text-dd-green-800 text-sm font-bold p-3 text-left">
                            <GraduationCap className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                            <span className="flex-1">{isEs ? 'Lecciones y exámenes en Capacitación' : 'Lessons and quizzes in Training'}</span>
                            <ChevronRight className="w-4 h-4" aria-hidden="true" />
                        </button>
                    )}

                    <div className="space-y-2">
                        {FOOD_SAFETY_TOPICS.map((topic) => {
                            const open = openTopic === topic.id;
                            return (
                                <section key={topic.id} className="rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
                                    <button type="button" aria-expanded={open} onClick={() => setOpenTopic(open ? null : topic.id)}
                                        className="w-full flex items-center gap-2 p-3 text-left">
                                        <span aria-hidden="true">{topic.icon}</span>
                                        <span className="flex-1 font-bold text-gray-900 text-sm">{isEs ? topic.titleEs : topic.titleEn}</span>
                                        <span className="text-xs text-gray-500">{topic.rules.length}</span>
                                        <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
                                    </button>
                                    {open && (
                                        <div className="px-2 pb-2 space-y-2">
                                            {topic.rules.map((rule) => (
                                                <RuleCard key={rule.id} rule={rule} isEs={isEs} showCheck={showCheck} />
                                            ))}
                                        </div>
                                    )}
                                </section>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}
