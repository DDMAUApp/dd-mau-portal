import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { t } from '../data/translations';
import { TRAINING_MODULES } from '../data/training';

export default function TrainingHub({ staffName, language }) {
    const [progress, setProgress] = useState({});
    const [loading, setLoading] = useState(true);
    const [expandedModule, setExpandedModule] = useState(null);
    const [expandedLesson, setExpandedLesson] = useState(null);

    useEffect(() => {
        // Load training progress from Firestore
        const docRef = doc(db, "training", staffName);
        const unsubscribe = onSnapshot(docRef, (docSnapshot) => {
            if (docSnapshot.exists()) {
                setProgress(docSnapshot.data().modules || {});
            } else {
                // Initialize empty progress
                const newProgress = {};
                TRAINING_MODULES.forEach(mod => {
                    newProgress[mod.id.toString()] = new Array(mod.lessons.length).fill(false);
                });
                setProgress(newProgress);
            }
            setLoading(false);
        });

        return () => unsubscribe();
    }, [staffName]);

    const toggleLesson = async (moduleId, lessonIndex) => {
        const moduleIdStr = moduleId.toString();
        const newProgress = { ...progress };
        if (!newProgress[moduleIdStr]) {
            newProgress[moduleIdStr] = new Array(TRAINING_MODULES.find(m => m.id === moduleId).lessons.length).fill(false);
        }
        newProgress[moduleIdStr][lessonIndex] = !newProgress[moduleIdStr][lessonIndex];
        setProgress(newProgress);

        // Write to Firestore
        try {
            await setDoc(doc(db, "training", staffName), { modules: newProgress }, { merge: true });
        } catch (err) {
            console.error("Error updating training progress:", err);
        }
    };

    const toggleModule = (moduleId) => {
        setExpandedModule(expandedModule === moduleId ? null : moduleId);
        setExpandedLesson(null);
    };

    const toggleLessonExpand = (lessonKey) => {
        setExpandedLesson(expandedLesson === lessonKey ? null : lessonKey);
    };

    if (loading) {
        return <div className="p-4 text-center">{t("loading", language)}</div>;
    }

    // Calculate overall progress
    let totalLessons = 0;
    let totalCompleted = 0;
    TRAINING_MODULES.forEach(mod => {
        const modProgress = progress[mod.id.toString()] || [];
        totalLessons += mod.lessons.length;
        totalCompleted += modProgress.filter(Boolean).length;
    });

    return (
        <div className="p-4 pb-24">
            <h2 className="text-2xl font-bold text-mint-700 mb-2">📚 {t("trainingHub", language)}</h2>
            <div className="mb-4 p-3 bg-mint-50 rounded-lg border border-mint-200">
                <div className="flex justify-between items-center mb-1">
                    <span className="text-sm font-semibold text-mint-800">
                        {language === "es" ? "Progreso Total" : "Overall Progress"}
                    </span>
                    <span className="text-sm font-bold text-mint-700">{totalCompleted}/{totalLessons}</span>
                </div>
                <div className="bg-gray-200 rounded-full h-3">
                    <div
                        className="bg-mint-700 h-3 rounded-full transition-all"
                        style={{ width: `${totalLessons > 0 ? (totalCompleted / totalLessons) * 100 : 0}%` }}
                    />
                </div>
            </div>

            {TRAINING_MODULES.map(module => {
                const moduleIdStr = module.id.toString();
                const moduleProgress = progress[moduleIdStr] || new Array(module.lessons.length).fill(false);
                const completed = moduleProgress.filter(Boolean).length;
                const total = module.lessons.length;
                const isExpanded = expandedModule === module.id;
                const isComplete = completed === total;

                return (
                    <div key={module.id} className={`mb-3 bg-white rounded-lg border-2 overflow-hidden ${isComplete ? "border-green-300" : "border-gray-200"}`}>
                        <div
                            className={`p-4 cursor-pointer ${isComplete ? "bg-gradient-to-r from-green-50 to-white" : "bg-gradient-to-r from-mint-50 to-white"}`}
                            onClick={() => toggleModule(module.id)}
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        {isComplete && <span>✅</span>}
                                        <h3 className={`font-bold text-base ${isComplete ? "text-green-700" : "text-mint-700"}`}>
                                            {language === "es" ? module.titleEs : module.titleEn}
                                        </h3>
                                    </div>
                                    <p className="text-xs text-gray-600 mt-1">{module.duration} • {module.role} • {completed}/{total}</p>
                                </div>
                                <span className={`text-xl transition-transform ${isExpanded ? "rotate-180" : ""}`}>▼</span>
                            </div>
                            <div className="mt-2 bg-gray-200 rounded-full h-2">
                                <div
                                    className={`h-2 rounded-full transition-all ${isComplete ? "bg-green-500" : "bg-mint-700"}`}
                                    style={{ width: `${(completed / total) * 100}%` }}
                                />
                            </div>
                        </div>

                        {isExpanded && (
                            <div className="border-t border-gray-200">
                                {module.lessons.map((lesson, idx) => {
                                    const lessonKey = `${module.id}-${idx}`;
                                    const isLessonExpanded = expandedLesson === lessonKey;
                                    const isChecked = moduleProgress[idx] || false;

                                    return (
                                        <div key={idx} className={`border-b border-gray-100 last:border-b-0 ${isChecked ? "bg-green-50" : ""}`}>
                                            <div className="flex items-center p-3">
                                                <input
                                                    type="checkbox"
                                                    checked={isChecked}
                                                    onChange={(e) => { e.stopPropagation(); toggleLesson(module.id, idx); }}
                                                    className="w-5 h-5 text-mint-700 rounded focus:ring-2 focus:ring-mint-700 flex-shrink-0"
                                                />
                                                <div
                                                    className="ml-3 flex-1 cursor-pointer"
                                                    onClick={() => toggleLessonExpand(lessonKey)}
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <span className={`text-sm font-medium ${isChecked ? "line-through text-gray-400" : "text-gray-800"}`}>
                                                            {language === "es" ? lesson.titleEs : lesson.titleEn}
                                                        </span>
                                                        <span className={`text-xs ml-2 transition-transform ${isLessonExpanded ? "rotate-180" : ""}`}>▾</span>
                                                    </div>
                                                </div>
                                            </div>
                                            {isLessonExpanded && (
                                                <div className="px-4 pb-3 ml-8">
                                                    <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-700 leading-relaxed border-l-4 border-mint-700">
                                                        {language === "es" ? lesson.contentEs : lesson.contentEn}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
