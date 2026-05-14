// Export every training module + lesson to a single Markdown doc for
// bulk editing. Workflow:
//
//   1. `node scripts/export-training.mjs` → writes TRAINING_EDIT.md at
//      the repo root.
//   2. Andrew opens the .md in any editor, marks up changes inline.
//   3. Hands the edited file back; the changes get re-applied to
//      src/data/training.js.
//
// Format is deliberately stable so a re-import diff is straightforward:
//   - One H1 per module (## M1 — Welcome to DD Mau)
//   - One H2 per lesson (### Lesson 1 — title)
//   - Bilingual: EN bullets first, then "[ES]" header, then ES bullets.
//   - Each bullet on its own line; preserves array structure for the
//     contentEn / contentEs arrays.
//
// Quizzes export too — at the bottom of each module as "Quiz Questions"
// with the correct option marked ✓. Edit those inline as well.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(resolve(here, "../src/data/training.js"));
const MODULES = mod.MODULES;

const lines = [];
lines.push("# DD Mau Training — Bulk Edit Doc");
lines.push("");
lines.push("Edit anything in this file, then hand it back. The exporter");
lines.push("re-applies your changes to `src/data/training.js`. Keep the");
lines.push("`## Module`, `### Lesson`, `**EN**`, `**ES**`, `**Quiz**`");
lines.push("headers intact so the importer can find the right slots —");
lines.push("everything inside those sections is fair game.");
lines.push("");
lines.push("Notes:");
lines.push("- Each bullet line below is one entry in the lesson's");
lines.push("  content array. Add a line = add a bullet; delete a line =");
lines.push("  delete the bullet.");
lines.push("- The EN and ES sections must stay 1:1 (same number of");
lines.push("  bullets, same order).");
lines.push("- Quiz options: the ✓ marks the correct answer. To change");
lines.push("  which option is correct, move the ✓ to a different one.");
lines.push("");

for (const m of MODULES) {
    lines.push(`## ${m.code} — ${m.titleEn}`);
    lines.push(`*${m.titleEs}*`);
    lines.push("");
    lines.push(`Track: \`${m.track}\` · Tier: \`${m.tier}\` · Duration: \`${m.durationMin} min\` · Icon: ${m.icon}`);
    lines.push("");

    for (let i = 0; i < m.lessons.length; i++) {
        const l = m.lessons[i];
        lines.push(`### Lesson ${i + 1} — ${l.titleEn}`);
        lines.push(`*${l.titleEs}*`);
        lines.push("");
        lines.push("**EN**");
        for (const para of l.contentEn) lines.push(`- ${para}`);
        lines.push("");
        lines.push("**ES**");
        for (const para of l.contentEs) lines.push(`- ${para}`);
        lines.push("");
    }

    if (m.quiz && Array.isArray(m.quiz.questions)) {
        lines.push(`### Quiz (pass threshold: ${Math.round((m.quiz.passThreshold || 0.8) * 100)}%)`);
        lines.push("");
        for (let qi = 0; qi < m.quiz.questions.length; qi++) {
            const q = m.quiz.questions[qi];
            lines.push(`**Q${qi + 1}.** ${q.questionEn}`);
            lines.push(`*${q.questionEs}*`);
            for (const opt of (q.options || [])) {
                const mark = opt.id === q.correct ? "✓" : " ";
                lines.push(`  - [${mark}] (${opt.id}) ${opt.textEn} / *${opt.textEs}*`);
            }
            lines.push("");
        }
    }

    lines.push("---");
    lines.push("");
}

const outPath = resolve(here, "../TRAINING_EDIT.md");
writeFileSync(outPath, lines.join("\n"), "utf8");
console.log(`Wrote ${outPath}`);
console.log(`Modules: ${MODULES.length}`);
console.log(`Total lessons: ${MODULES.reduce((n, m) => n + m.lessons.length, 0)}`);
