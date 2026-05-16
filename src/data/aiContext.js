// DD Mau AI Knowledge Bundle
//
// Compresses the training modules, allergen matrix, recipe book index, and
// operational frameworks into a single string injected into the AI router's
// system prompt. The goal is to make the AI assistant *DD-Mau-aware* without
// blowing the context budget — full recipe bodies and full lesson text are
// intentionally NOT included; the AI gets titles + key facts and can ask the
// staff to open the relevant tab for full detail.
//
// Token budget target: ~2-3k tokens. Keep additions terse.

import { MODULES } from "./training";
import { MASTER_RECIPES } from "./masterRecipes";

// ── Allergen matrix → compact text ────────────────────────────────────────
// Pulls M17 L3 + M17 L4 matrix data and flattens it into a readable list.
// Format: "Item — allergens; vegan; notes". Skips Spanish to keep tokens low.

const ALLERGEN_KEY_LABELS = {
    milk: "Dairy",
    eggs: "Egg",
    fish: "Fish",
    shell: "Shellfish",
    peanut: "Peanut",
    treenut: "Treenut",
    wheat: "Wheat",
    soy: "Soy",
    sesame: "Sesame",
};

function symbolToWord(sym) {
    if (sym === "●") return "contains";
    if (sym === "◐") return "may contain";
    return sym || "";
}

function buildAllergenSection() {
    const m17 = MODULES.find(m => m.id === "m17");
    if (!m17) return "";
    const lines = ["## ALLERGEN MATRIX (DD Mau official chart)"];
    lines.push("Legend: '●'=contains, '◐'=may contain, blank=does not typically contain. Vegan: ✓=vegan, ✓*=can be made vegan, —=not vegan.");
    lines.push("");

    for (const lesson of m17.lessons) {
        if (!lesson.matrix) continue;
        for (const sec of lesson.matrix.sections) {
            lines.push(`### ${sec.titleEn}`);
            for (const row of sec.rows) {
                const all = Object.entries(row.v || {})
                    .map(([k, v]) => `${ALLERGEN_KEY_LABELS[k] || k}=${symbolToWord(v)}`)
                    .join(", ");
                const veganTag = row.vegan ? `[vegan ${row.vegan}]` : "";
                const note = row.notesEn ? ` — ${row.notesEn}` : "";
                lines.push(`- ${row.itemEn} ${veganTag}${all ? ` (${all})` : ""}${note}`);
            }
            lines.push("");
        }
    }
    return lines.join("\n");
}

// ── DRINK ALLERGEN NUANCE (high-stakes; AI must answer correctly) ────────
//
// 2026-05-16 — Andrew: "i dont want the answer to always be yes that milk
// tea has milk because we use a non dairy creamer."
//
// The allergen matrix marks milk teas with milk='●' (contains) which is
// the right tag for ALLERGY purposes — but a literal-minded AI will
// answer a guest's "does milk tea have milk?" with "yes" and miss the
// operational nuance staff need to convey. This block explicitly
// instructs the AI to never collapse milk-tea milk content into a
// binary answer.
const DRINK_ALLERGEN_NUANCE = `## DRINK ALLERGEN NUANCE — read carefully
- **Boba milk teas** are made with a powder base that includes a creamer LABELED "non-dairy." The recipe contains NO actual cow's milk. BUT the creamer contains **sodium caseinate + lactose** — both are milk derivatives.
- So "does milk tea contain milk?" has TWO correct answers depending on the question behind the question:
  1. **Recipe-wise / dietary preference / lactose-intolerant guest**: No actual milk is added. We don't pour dairy milk into the drink. Most lactose-intolerant guests tolerate it fine (digestion only, no allergy risk).
  2. **Milk-allergy guest (immune reaction)**: TREAT IT AS IF IT CONTAINS MILK. The caseinate + lactose in the creamer are real milk proteins and CAN trigger a milk-allergy reaction. The ONLY safe boba-menu path for a milk allergy is a **fruit tea** (never touches the milk-powder base).
- **Never give a simple "yes milk tea has milk" or "no it's dairy-free."** Both are wrong without context. Always ask or infer: is this person allergic (medical), intolerant (digestion), or just avoiding dairy as a preference? Tailor the answer.
- "Sub oat milk in my milk tea" is NOT a workaround — the milk-derivative-containing creamer is in the BASE POWDER. You can't remove it. For a milk-allergy guest, the only redirect is a fruit tea.
- For lactose-intolerant guests: milk teas usually fine. The allergen-trigger amount of lactose in the creamer is small.
- Almond milk is a tree-nut allergen. Soy milk is a soy allergen. Oat milk is the safest sub for guests AVOIDING dairy who don't have milk-allergy concerns AND who don't have a tree-nut allergy.
- Tapioca pearls (boba) are typically allergen-free.
- Cashier MUST give the boba disclosure on every milk-tea order — this is in M6 (Cashier) and M17 L4 (Drink Allergens). If staff asks "what do I say?", point them there.`;

// ── Service frameworks (M1 L4 + RESTORE) ──────────────────────────────────

const SERVICE_FRAMEWORKS = `## SERVICE FRAMEWORKS
- **10-Second Rule**: every guest acknowledged within 10 seconds of walking in. Eye contact + smile + "Welcome to DD Mau."
- **Bright 4**: Eyes Up (scan for guests), Light Up (smile), Speak Up (greet out loud), Show Up (do work without being asked).
- **RESTORE** (service recovery): Recognize, Empathize, Solve it now, Tell the Lead, Offer something extra, Re-greet, Examine. Used when something goes wrong. Front-line staff hand complaints to the Shift Lead — the Lead runs RESTORE, not you.`;

// ── Restaurant overview ───────────────────────────────────────────────────

const RESTAURANT_OVERVIEW = `## RESTAURANT OVERVIEW
- **DD Mau** = Vietnamese fast-casual, founded by Julie Truong in 2018.
- **Two locations**: Maryland Heights (MH) and Webster Groves (WG). Same standards at both stores.
- **Service model**: Counter-order, run-the-food-to-the-table. Not drive-through, not table-service. "Vietnamese street food, elevated."
- **Name**: "DD Mau" means "hurry up" in Vietnamese.
- **Three differentiators**: (1) Hospitality first. (2) Fresh meets fast — pho simmered overnight, vinaigrette made weekly, egg rolls hand-rolled. (3) Real Vietnamese flavors plated for fast-casual.`;

// ── Training module index ─────────────────────────────────────────────────

function buildTrainingIndex() {
    const lines = ["## TRAINING MODULES (refer staff to the Training tab for full content)"];
    for (const m of MODULES) {
        const lessonTitles = m.lessons.map(l => l.titleEn).join("; ");
        lines.push(`- **${m.code} ${m.titleEn}** [${m.track}/${m.tier}, ${m.durationMin}min] — ${lessonTitles}`);
    }
    return lines.join("\n");
}

// ── Recipe index ──────────────────────────────────────────────────────────
// Recipe BODIES are not included (too long). The AI gets titles + categories
// and can tell staff "yes that's in the master recipe book — open the Recipes
// tab and search for X". Recipes also live in Firestore for live edits.

function buildRecipeIndex() {
    const byCat = {};
    for (const r of MASTER_RECIPES) {
        if (!byCat[r.category]) byCat[r.category] = [];
        byCat[r.category].push(r.titleEn);
    }
    const lines = ["## MASTER RECIPE BOOK (titles only — full recipes in the Recipes tab)"];
    for (const [cat, titles] of Object.entries(byCat)) {
        lines.push(`- **${cat}**: ${titles.join(", ")}`);
    }
    return lines.join("\n");
}

// ── Operational rules / quick facts ───────────────────────────────────────

const OPERATIONAL_RULES = `## OPERATIONAL RULES & QUICK FACTS
- **Uniform**: DD Mau shirt + black pants (no holes, no designs, no yoga pants — shorts are fine), closed-toe non-slip shoes, hair pulled back, hat or visor.
- **Hand-washing**: After clocking in, after handling raw meat, after eating/drinking/phone, after bathroom, after sneezing. Soap + warm water 20 sec.
- **Drinks**: Personal drinks stay out of guest sight, never on the line.
- **Breaks**: Every double shift = 1-hour unpaid break. Always check with the Shift Lead.
- **Burns**: Cool with cold water (no ice). Tell Lead if it blisters.
- **Allergen process**: Guest mentions allergy → STOP, get Shift Lead, Lead confirms with kitchen. Never guess.
- **Complaints**: Front-line staff find the Shift Lead — Lead runs RESTORE.
- **Receipts**: Hand back the change always. Receipt only printed if guest chose "print receipt" on Toast.
- **Line backup**: If kitchen is behind, manager may pause ordering. You tell the line: "We have to pause orders for 5 minutes to let the kitchen catch up."
- **Cash drawer**: Pre-counted by manager — staff don't count their own start-of-shift drawer.
- **86 list**: Note out-of-stock items, confirm with Shift Lead they're still 86'd.
- **Pho sizes**: Regular only. NO large pho.
- **Tardiness**: Be ready to clock in on time. Repeated tardiness is tracked.`;

// ── Public bundler ────────────────────────────────────────────────────────

export function buildKnowledgeContext({ language = "en", staffName = "team member", location = "" } = {}) {
    const isEs = language === "es";
    const langLine = isEs
        ? "RESPOND IN SPANISH. The staff member is Spanish-speaking — keep answers in Spanish but proper nouns and dish names can stay in English/Vietnamese."
        : "Respond in English unless the staff member writes in another language.";

    const greeting = `You are DD Mau's AI assistant — a Vietnamese fast-casual restaurant in St. Louis. The staff member talking to you is **${staffName || "a team member"}**${location ? ` working at the **${location}** location` : ""}.`;

    const tone = `## TONE
- Be concise, warm, and direct — like a Shift Lead who has seen it all.
- For allergens, food safety, or anything that could hurt a guest: be precise, refer to the matrix, and ALWAYS remind staff to confirm with the Shift Lead and kitchen.
- **Milk-tea milk question is a TRAP.** Never answer "does milk tea have milk?" with a binary yes/no. ALWAYS distinguish the recipe (no cow's milk added) from the allergy reality (creamer contains caseinate + lactose, treat as milk for allergy purposes). See the DRINK ALLERGEN NUANCE block above for the exact phrasing.
- For menu questions: cite the exact item from the chart. Don't invent.
- For training questions: tell them which module to open (e.g., "That's covered in M3 Food Safety, Lesson 2 — open the Training tab").
- For recipes: titles are listed below, but the full recipe lives in the Recipes tab. Don't invent ingredient quantities.
- If you don't know, say "I don't have that detail — ask your Shift Lead or check [tab name]."
- Never fabricate menu items, prices, or recipe steps.`;

    return [
        greeting,
        langLine,
        "",
        RESTAURANT_OVERVIEW,
        "",
        SERVICE_FRAMEWORKS,
        "",
        OPERATIONAL_RULES,
        "",
        buildAllergenSection(),
        "",
        // Drink-allergen nuance is high-stakes (anaphylaxis risk) so it
        // sits OUTSIDE the bulk allergen matrix to make sure the AI
        // weights it heavily. Placed AFTER the matrix so it overrides
        // any literal "milk=contains" reading.
        DRINK_ALLERGEN_NUANCE,
        "",
        buildTrainingIndex(),
        "",
        buildRecipeIndex(),
        "",
        tone,
    ].join("\n");
}

// Quick stats for the "AI knows about" panel in the UI.
export function getKnowledgeStats() {
    return {
        modules: MODULES.length,
        lessons: MODULES.reduce((sum, m) => sum + m.lessons.length, 0),
        recipes: MASTER_RECIPES.length,
        allergenItems: (() => {
            const m17 = MODULES.find(m => m.id === "m17");
            if (!m17) return 0;
            let n = 0;
            for (const lesson of m17.lessons) {
                if (!lesson.matrix) continue;
                for (const sec of lesson.matrix.sections) n += sec.rows.length;
            }
            return n;
        })(),
    };
}
