// Writes the Food Safety lessons and quizzes to a document the owner can read.
// Usage: node scripts/food-safety-lessons-review.mjs <output.md>
import { writeFileSync } from 'node:fs';
import { FOOD_SAFETY_MODULES as MODS } from '../src/data/trainingFoodSafety.js';

const lines = ['# Food Safety lessons and quizzes, for review', ''];
const paras = (x) => (Array.isArray(x) ? x : String(x || '').split('\n'));
for (const m of MODS) {
    lines.push(`## ${m.code}: ${m.titleEn}`, '');
    for (const l of m.lessons) {
        lines.push(`### ${l.titleEn}`, '');
        for (const p of paras(l.bodyEn ?? l.contentEn ?? l.textEn ?? l.en)) lines.push(p, '');
    }
    lines.push(`### Quiz, ${m.quiz.questions.length} questions, ${Math.round(m.quiz.passThreshold * 100)}% to pass`, '');
    m.quiz.questions.forEach((q, i) => {
        lines.push(`${i + 1}. ${q.textEn ?? q.questionEn ?? q.qEn ?? q.en}`, '');
        for (const o of q.options) lines.push(`   - ${o.id === q.correct ? '**(correct)** ' : ''}${o.textEn ?? o.labelEn ?? o.en}`);
        lines.push('');
    });
}
writeFileSync(process.argv[2], lines.join('\n'));
console.log(MODS.length, 'modules');
