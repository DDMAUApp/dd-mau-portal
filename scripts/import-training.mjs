// Re-apply edits from TRAINING_EDIT.md back into src/data/training.js.
//
// Strategy:
//   - Parse the markdown into a structure identical to what
//     export-training.mjs produced.
//   - Load the live training.js by import() so we keep every field the
//     markdown doesn't touch (ids, quiz threshold metadata, etc.).
//   - For each module / lesson, replace ONLY: titleEn, titleEs,
//     contentEn[], contentEs[]. For quizzes: questionEn/Es,
//     options.textEn/Es, correct.
//   - Pretty-print the whole MODULES array back out to training.js
//     with the same JS literal style. Comment headers above each
//     module are preserved by reading the original file and surgically
//     swapping just the literal — see splice logic below.
//
// Usage: `node scripts/import-training.mjs`
//   (reads TRAINING_EDIT.md, writes src/data/training.js)
//
// Round-trip check: after import, run `node scripts/export-training.mjs`
// and diff. The only differences should be the edits Andrew made — if
// other fields drifted, the importer has a bug.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mdPath = resolve(here, "../TRAINING_EDIT.md");
const jsPath = resolve(here, "../src/data/training.js");

const md = readFileSync(mdPath, "utf8");
const liveModule = await import(jsPath);
const MODULES = JSON.parse(JSON.stringify(liveModule.MODULES));  // deep clone

// ── Parse the markdown ────────────────────────────────────────────────

// Walk line by line; track current module / lesson / section.
const lines = md.split(/\r?\n/);
const parsed = {};  // { [moduleCode]: { titleEn, titleEs, lessons: {[idx]: {titleEn, titleEs, en:[], es:[]}}, quiz: [{qEn, qEs, options:[{id, en, es, correct}]}] } }
let cur = { mod: null, lesson: null, lessonIdx: -1, qIdx: -1, section: null };

const reModule = /^##\s+([A-Z]\d+)\s+—\s+(.+)$/;
const reLesson = /^###\s+Lesson\s+(\d+)\s+—\s+(.+)$/;
const reQuiz = /^###\s+Quiz/;
const reItalicEs = /^\*(.+)\*$/;
const reBullet = /^-\s+(.*)$/;
const reQuizQ = /^\*\*Q(\d+)\.\*\*\s+(.+)$/;
const reQuizOpt = /^\s*-\s+\[([✓ ])\]\s+\(([a-d])\)\s+(.+?)\s+\/\s+\*(.+)\*\s*$/;

for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;

    if ((m = ln.match(reModule))) {
        const code = m[1];
        parsed[code] = parsed[code] || { titleEn: m[2].trim(), titleEs: "", lessons: {}, quiz: [] };
        cur = { mod: code, lesson: null, lessonIdx: -1, qIdx: -1, section: null };
        // Next non-empty line should be the italic ES title.
        for (let j = i + 1; j < lines.length; j++) {
            const nxt = lines[j];
            if (!nxt.trim()) continue;
            const e = nxt.match(reItalicEs);
            if (e) parsed[code].titleEs = e[1].trim();
            break;
        }
        continue;
    }

    if ((m = ln.match(reLesson))) {
        const idx = parseInt(m[1], 10) - 1;
        cur.lesson = idx;
        cur.lessonIdx = idx;
        cur.section = null;
        parsed[cur.mod].lessons[idx] = parsed[cur.mod].lessons[idx] || { titleEn: m[2].trim(), titleEs: "", en: [], es: [] };
        for (let j = i + 1; j < lines.length; j++) {
            const nxt = lines[j];
            if (!nxt.trim()) continue;
            const e = nxt.match(reItalicEs);
            if (e) parsed[cur.mod].lessons[idx].titleEs = e[1].trim();
            break;
        }
        continue;
    }

    if (ln.match(reQuiz)) {
        cur.lesson = null;
        cur.section = "quiz";
        cur.qIdx = -1;
        continue;
    }

    if (ln === "**EN**" && cur.lessonIdx >= 0) { cur.section = "en"; continue; }
    if (ln === "**ES**" && cur.lessonIdx >= 0) { cur.section = "es"; continue; }

    if (cur.section === "en" || cur.section === "es") {
        const b = ln.match(reBullet);
        if (b) {
            const dst = parsed[cur.mod].lessons[cur.lessonIdx];
            if (cur.section === "en") dst.en.push(b[1]);
            else dst.es.push(b[1]);
        }
        continue;
    }

    if (cur.section === "quiz") {
        if ((m = ln.match(reQuizQ))) {
            cur.qIdx = parseInt(m[1], 10) - 1;
            parsed[cur.mod].quiz[cur.qIdx] = parsed[cur.mod].quiz[cur.qIdx] || { questionEn: m[2].trim(), questionEs: "", options: [], correct: null };
            for (let j = i + 1; j < lines.length; j++) {
                const nxt = lines[j];
                if (!nxt.trim()) continue;
                const e = nxt.match(reItalicEs);
                if (e) parsed[cur.mod].quiz[cur.qIdx].questionEs = e[1].trim();
                break;
            }
            continue;
        }
        if ((m = ln.match(reQuizOpt)) && cur.qIdx >= 0) {
            const correct = m[1] === "✓";
            const id = m[2];
            const enText = m[3].trim();
            const esText = m[4].trim();
            parsed[cur.mod].quiz[cur.qIdx].options.push({ id, textEn: enText, textEs: esText });
            if (correct) parsed[cur.mod].quiz[cur.qIdx].correct = id;
            continue;
        }
    }
}

// ── Merge parsed edits into MODULES clone ─────────────────────────────

let changed = 0;
for (const m of MODULES) {
    const p = parsed[m.code];
    if (!p) continue;
    if (p.titleEn && p.titleEn !== m.titleEn) { m.titleEn = p.titleEn; changed++; }
    if (p.titleEs && p.titleEs !== m.titleEs) { m.titleEs = p.titleEs; changed++; }
    for (let li = 0; li < m.lessons.length; li++) {
        const pl = p.lessons[li];
        if (!pl) continue;
        const l = m.lessons[li];
        if (pl.titleEn && pl.titleEn !== l.titleEn) { l.titleEn = pl.titleEn; changed++; }
        if (pl.titleEs && pl.titleEs !== l.titleEs) { l.titleEs = pl.titleEs; changed++; }
        if (pl.en.length) { l.contentEn = pl.en; }
        if (pl.es.length) { l.contentEs = pl.es; }
    }
    if (m.quiz && Array.isArray(m.quiz.questions) && p.quiz.length) {
        for (let qi = 0; qi < m.quiz.questions.length; qi++) {
            const pq = p.quiz[qi];
            if (!pq) continue;
            const q = m.quiz.questions[qi];
            if (pq.questionEn) q.questionEn = pq.questionEn;
            if (pq.questionEs) q.questionEs = pq.questionEs;
            if (pq.options.length === q.options.length) {
                for (let oi = 0; oi < q.options.length; oi++) {
                    const po = pq.options[oi];
                    const o = q.options[oi];
                    if (po.id && po.id !== o.id) o.id = po.id;
                    if (po.textEn) o.textEn = po.textEn;
                    if (po.textEs) o.textEs = po.textEs;
                }
            }
            if (pq.correct) q.correct = pq.correct;
        }
    }
}

// ── Pretty-print MODULES back to JS ───────────────────────────────────
// We rewrite ONLY the `export const MODULES = [ ... ];` block. Anything
// outside (header comments, other exports) is preserved.

const orig = readFileSync(jsPath, "utf8");
const startTag = "export const MODULES = [";
const startIdx = orig.indexOf(startTag);
if (startIdx === -1) {
    console.error("Could not find `export const MODULES = [` in training.js");
    process.exit(1);
}
// Find the matching closing `];` by walking braces / brackets from
// startIdx onward.
let depth = 0;
let endIdx = -1;
for (let i = startIdx + startTag.length - 1; i < orig.length; i++) {
    const c = orig[i];
    if (c === "[") depth++;
    else if (c === "]") {
        depth--;
        if (depth === 0) {
            // Find the next `;` after the closing bracket.
            const semi = orig.indexOf(";", i);
            endIdx = semi >= 0 ? semi + 1 : i + 1;
            break;
        }
    }
}
if (endIdx === -1) {
    console.error("Could not find end of MODULES array");
    process.exit(1);
}

// Use JSON.stringify-style for the array, then re-wrap with `export
// const`. Indent at 4 spaces to match the existing style.
const rendered = "export const MODULES = " + stringify(MODULES, 0) + ";";
const out = orig.slice(0, startIdx) + rendered + orig.slice(endIdx);
writeFileSync(jsPath, out, "utf8");
console.log(`Updated ${jsPath}`);
console.log(`Touched ~${changed} top-level fields (modules + lesson titles). Content arrays replaced wholesale where edits were present.`);

// ── Stringifier — emits JS literal preserving order with predictable
//    indentation. Strings use double quotes; backslash-escape and
//    quote-escape inside.

function stringify(v, depth) {
    const pad = "    ".repeat(depth);
    const padInner = "    ".repeat(depth + 1);
    if (v === null) return "null";
    if (typeof v === "boolean" || typeof v === "number") return String(v);
    if (typeof v === "string") return quote(v);
    if (Array.isArray(v)) {
        if (v.length === 0) return "[]";
        const items = v.map(x => padInner + stringify(x, depth + 1));
        return "[\n" + items.join(",\n") + "\n" + pad + "]";
    }
    if (typeof v === "object") {
        const keys = Object.keys(v);
        if (keys.length === 0) return "{}";
        const entries = keys.map(k => padInner + identifierOrString(k) + ": " + stringify(v[k], depth + 1));
        return "{\n" + entries.join(",\n") + "\n" + pad + "}";
    }
    return "null";
}

function quote(s) {
    return "\"" + s
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t") + "\"";
}

function identifierOrString(k) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : quote(k);
}
