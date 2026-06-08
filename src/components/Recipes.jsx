import { useState, useEffect, useRef, useMemo, useDeferredValue, lazy, Suspense } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc, addDoc, updateDoc, collection, runTransaction, serverTimestamp } from 'firebase/firestore';
import { t } from '../data/translations';
import { isAdmin } from '../data/staff';
import { ALLERGEN_ORDER, allergenLabel, allergenEmoji, allergenTone, sortAllergens } from '../data/allergens';
import { matchesRecipeQuery } from '../data/recipeSearch';
import { useAiSearch } from '../data/aiSearch';
import { toast } from '../toast';
// 2026-05-20 — date-code label printing on Epson TM-L100. Lazy so
// the preview + ePOS-Print XML helpers only enter the bundle when a
// staffer actually opens the modal (most sessions won't print).
const PrintLabelModal = lazy(() => import('./PrintLabelModal'));

// Re-PIN window — staff must re-enter PIN if no recipe was opened in this many ms.
const REPIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min
// Auto-collapse — after this many ms of no activity, expanded recipe closes.
// AUTO_COLLAPSE_MS removed 2026-06-08 — recipe auto-close disabled (Andrew).
// "Quick blur" window — iOS taking a screenshot causes a brief blur → focus
// pattern (the system grabs focus to show the screenshot thumbnail). If a
// blur event is followed by focus inside this window, we count it as a
// likely screenshot. Notifications/calls also briefly steal focus, so this
// is a SIGNAL not a definitive detector.
const QUICK_BLUR_MAX_MS = 1500;

// Editing is gated on isAdmin (Andrew/Julie) — no shared password.
// Previously a hardcoded RECIPE_PASSWORD was checked client-side, which
// meant the password was visible to anyone who opened devtools. Removed.
// If you need to grant edit access to a non-admin, promote them to an
// ADMIN_ID in src/data/staff.js or add a per-staff "canEditRecipes" flag.

function RecipeForm({ language, recipe, onSave, onCancel }) {
    const isEdit = !!recipe;
    const [form, setForm] = useState(recipe || {
        titleEn: "", titleEs: "", emoji: "🍽️", category: "",
        prepTimeEn: "", cookTimeEn: "",
        yieldsEn: "", yieldsEs: "",
        allergens: [],
        ingredientsEn: [""], ingredientsEs: [""],
        instructionsEn: [""], instructionsEs: [""]
    });
    const toggleAllergen = (code) => {
        setForm(prev => {
            const cur = Array.isArray(prev.allergens) ? prev.allergens : [];
            return { ...prev, allergens: cur.includes(code) ? cur.filter(c => c !== code) : [...cur, code] };
        });
    };

    const updateField = (field, val) => setForm(prev => ({ ...prev, [field]: val }));
    const updateListItem = (field, idx, val) => {
        const arr = [...form[field]];
        arr[idx] = val;
        setForm(prev => ({ ...prev, [field]: arr }));
    };
    const addListItem = (field) => setForm(prev => ({ ...prev, [field]: [...prev[field], ""] }));
    const removeListItem = (field, idx) => {
        if (form[field].length <= 1) return;
        setForm(prev => ({ ...prev, [field]: prev[field].filter((_, i) => i !== idx) }));
    };

    const handleSave = () => {
        if (!form.titleEn.trim()) { toast(language === "es" ? "Se requiere título en inglés" : "English title is required"); return; }
        const cleaned = {
            ...form,
            ingredientsEn: form.ingredientsEn.filter(s => s.trim()),
            ingredientsEs: form.ingredientsEs.filter(s => s.trim()),
            instructionsEn: form.instructionsEn.filter(s => s.trim()),
            instructionsEs: form.instructionsEs.filter(s => s.trim()),
        };
        if (cleaned.ingredientsEn.length === 0) cleaned.ingredientsEn = [""];
        if (cleaned.instructionsEn.length === 0) cleaned.instructionsEn = [""];
        if (cleaned.ingredientsEs.length === 0) cleaned.ingredientsEs = [""];
        if (cleaned.instructionsEs.length === 0) cleaned.instructionsEs = [""];
        onSave(cleaned);
    };

    const renderListEditor = (field, label) => (
        <div className="mb-4">
            <label className="block text-xs font-bold text-gray-600 mb-1">{label}</label>
            {form[field].map((item, i) => (
                <div key={i} className="flex gap-1 mb-1">
                    <span className="text-xs text-gray-400 mt-2 w-5 text-right">{i + 1}.</span>
                    <input
                        className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
                        value={item}
                        onChange={e => updateListItem(field, i, e.target.value)}
                        placeholder={`${label} ${i + 1}`}
                    />
                    <button onClick={() => removeListItem(field, i)} className="text-red-400 text-sm px-1">✕</button>
                </div>
            ))}
            <button onClick={() => addListItem(field)} className="text-xs text-mint-700 font-bold mt-1">{language === "es" ? "+ Agregar" : "+ Add"}</button>
        </div>
    );

    return (
        <div className="p-4 pb-bottom-nav">
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-mint-700">
                    {isEdit ? (language === "es" ? "Editar Receta" : "Edit Recipe") : (language === "es" ? "Nueva Receta" : "New Recipe")}
                </h2>
                <button onClick={onCancel} className="text-gray-500 text-sm underline">{language === "es" ? "Cancelar" : "Cancel"}</button>
            </div>

            <div className="space-y-3">
                <div className="flex gap-2">
                    <div className="w-16">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Ícono" : "Emoji"}</label>
                        <input className="w-full border border-gray-300 rounded px-2 py-1 text-center text-xl" value={form.emoji} onChange={e => updateField("emoji", e.target.value)} />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Categoría" : "Category"}</label>
                        <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.category} onChange={e => updateField("category", e.target.value)} placeholder={language === "es" ? "ej. Sopas, Aperitivos, Salsas" : "e.g. Soups, Appetizers, Sauces"} />
                    </div>
                </div>

                <div>
                    <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Título (Inglés) *" : "Title (English) *"}</label>
                    <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.titleEn} onChange={e => updateField("titleEn", e.target.value)} placeholder={language === "es" ? "Nombre de la receta en inglés" : "Recipe name in English"} />
                </div>
                <div>
                    <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Título (Español)" : "Title (Spanish)"}</label>
                    <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.titleEs} onChange={e => updateField("titleEs", e.target.value)} placeholder={language === "es" ? "Nombre en español" : "Recipe name in Spanish"} />
                </div>

                <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{t("prepTime", language)}</label>
                        <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.prepTimeEn} onChange={e => updateField("prepTimeEn", e.target.value)} placeholder={language === "es" ? "ej. 30 min" : "e.g. 30 min"} />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{t("cookTime", language)}</label>
                        <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.cookTimeEn} onChange={e => updateField("cookTimeEn", e.target.value)} placeholder={language === "es" ? "ej. 2 horas" : "e.g. 2 hours"} />
                    </div>
                </div>

                <div className="flex gap-2">
                    <div className="flex-1">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{t("yields", language)} (EN)</label>
                        <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.yieldsEn} onChange={e => updateField("yieldsEn", e.target.value)} placeholder={language === "es" ? "ej. 5 galones" : "e.g. 5 gallons"} />
                    </div>
                    <div className="flex-1">
                        <label className="block text-xs font-bold text-gray-600 mb-1">{t("yields", language)} (ES)</label>
                        <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.yieldsEs} onChange={e => updateField("yieldsEs", e.target.value)} placeholder="e.g. 19 litros" />
                    </div>
                </div>

                <div className="border-t pt-3 mt-3">
                    <h3 className="font-bold text-sm text-amber-800 mb-2">⚠️ {language === "es" ? "Alérgenos" : "Allergens"}</h3>
                    <p className="text-[10px] text-gray-500 mb-2">
                        {language === "es"
                            ? "Toca para activar/desactivar. Esta lista aparece como banner en la receta."
                            : "Tap to toggle. This list shows as a banner on the recipe card."}
                    </p>
                    <div className="flex flex-wrap gap-1">
                        {ALLERGEN_ORDER.map(code => {
                            const active = (form.allergens || []).includes(code);
                            return (
                                <button key={code} type="button"
                                    onClick={() => toggleAllergen(code)}
                                    className={`text-[11px] font-bold px-2 py-1 rounded-full border ${active ? allergenTone(code) : 'bg-white text-gray-400 border-gray-300'}`}>
                                    {allergenEmoji(code)} {allergenLabel(code, language)}
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="border-t pt-3 mt-3">
                    <h3 className="font-bold text-sm text-amber-800 mb-2">📝 {t("ingredients", language)}</h3>
                    {renderListEditor("ingredientsEn", language === "es" ? "Inglés" : "English")}
                    {renderListEditor("ingredientsEs", language === "es" ? "Español" : "Spanish")}
                </div>

                <div className="border-t pt-3 mt-3">
                    <h3 className="font-bold text-sm text-amber-800 mb-2">👨‍🍳 {t("instructions", language)}</h3>
                    {renderListEditor("instructionsEn", language === "es" ? "Inglés" : "English")}
                    {renderListEditor("instructionsEs", language === "es" ? "Español" : "Spanish")}
                </div>

                <button
                    onClick={handleSave}
                    className="w-full bg-mint-700 text-white font-bold py-3 rounded-lg text-lg mt-4"
                >
                    {isEdit ? (language === "es" ? "Guardar Cambios" : "Save Changes") : (language === "es" ? "Agregar Receta" : "Add Recipe")}
                </button>
            </div>
        </div>
    );
}

export default function Recipes({ language, staffName, staffList, storeLocation, isAtDDMau, geoChecking, geoError, geoRetry, geoPermState }) {
    const [expandedRecipe, setExpandedRecipe] = useState(null);
    // 2026-05-20 — Andrew: Vietnamese equivalent of Jolt's date-code
    // labeling. When set to a recipe object, the PrintLabelModal opens
    // with that recipe's data pre-filled. Closes on print / cancel.
    const [printingLabelFor, setPrintingLabelFor] = useState(null);
    const [recipes, setRecipes] = useState([]);
    const [editMode, setEditMode] = useState(null); // null | "add" | recipe object
    const [recipeMultipliers, setRecipeMultipliers] = useState({}); // { recipeId: number }
    // Reverse-lookup: when set, recipes containing this allergen get a strong
    // visual warning (red border + 🚫 chip) so cashiers/cooks scanning for
    // "what's safe for a peanut allergy?" can see at a glance which recipes
    // to avoid. Empty = no filter.
    const [avoidAllergen, setAvoidAllergen] = useState('');
    // Free-text search across title (EN+ES), category, ingredients (EN+ES),
    // and allergen labels (EN+ES). Live filter — no submit needed. Matching
    // is accent-insensitive and multi-word AND-semantic, and runs through
    // the same restaurant-vocabulary synonym list that powers chat search
    // (chicken↔pollo, lime↔limón, broth↔caldo). See src/data/recipeSearch.js.
    const [searchQuery, setSearchQuery] = useState('');
    // 2026-05-30 perf — defer the search value used by the heavy filter +
    // AI dispatch. The input itself reads searchQuery (instant feedback);
    // the filter at line 798 + the AI search hook below read the deferred
    // value, so React updates them at lower priority and a keystroke
    // never blocks paint.
    const searchQueryDeferred = useDeferredValue(searchQuery);
    // AI semantic search toggle. When ON, the search query is ALSO
    // sent to the aiSearch Cloud Function (Claude-backed). The
    // substring matcher keeps running locally — AI results are
    // UNIONed into the substring set so users get instant feedback
    // and Claude fills in the semantic extras (e.g. "vegan",
    // "spicy", "things with shrimp") ~300ms later. Defaults ON.
    const [aiOn, setAiOn] = useState(true);
    // Raw text the user has typed in the per-recipe Custom multiplier input.
    // We commit (parseQuantity → setRecipeMultipliers) on blur/Enter so that
    // mid-typing characters like "1/" don't snap to a preset. Without this,
    // a number-typed `1/3` was being stripped to `3` by the browser and
    // jumping to the 3× preset chip.
    const [multiplierDrafts, setMultiplierDrafts] = useState({}); // { recipeId: string }
    // Parse "1/3", "1 1/2", "½", "1½", "0.333", "2" → number. Returns null on garbage.
    const parseQuantity = (raw) => {
        if (raw == null) return null;
        const s = String(raw).trim();
        if (!s) return null;
        const FRAC = { '½':0.5,'¼':0.25,'¾':0.75,'⅓':1/3,'⅔':2/3,'⅛':0.125,'⅜':0.375,'⅝':0.625,'⅞':0.875,'⅙':1/6,'⅚':5/6,'⅕':0.2,'⅖':0.4,'⅗':0.6,'⅘':0.8 };
        // Mixed Unicode like "1½"
        let m = s.match(/^(\d+)\s*([½¼¾⅓⅔⅛⅜⅝⅞⅙⅚⅕⅖⅗⅘])$/);
        if (m) return parseInt(m[1], 10) + FRAC[m[2]];
        // Lone Unicode fraction like "½"
        if (FRAC[s] !== undefined) return FRAC[s];
        // Mixed ASCII like "1 1/2"
        m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
        if (m) return parseInt(m[1],10) + parseInt(m[2],10)/parseInt(m[3],10);
        // Plain ASCII fraction like "1/3"
        m = s.match(/^(\d+)\/(\d+)$/);
        if (m) { const d = parseInt(m[2],10); if (d > 0) return parseInt(m[1],10)/d; return null; }
        // Plain number
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    };
    const commitMultiplierDraft = (recipeId) => {
        const raw = multiplierDrafts[recipeId];
        if (raw === undefined) return;
        const v = parseQuantity(raw);
        if (v && v > 0) {
            setRecipeMultipliers(prev => ({ ...prev, [recipeId]: v }));
        }
        setMultiplierDrafts(prev => { const n = { ...prev }; delete n[recipeId]; return n; });
    };
    // Auto-blur was removed (2026-05-09): on iOS the URL bar collapsing on
    // input focus, and the soft-keyboard appearing in the recipe editor,
    // both trip the blur/focus and devtools heuristics. Result: the page
    // would blur out mid-typing (e.g. when entering "1/3" in a quantity
    // field). Watermark + view logging + screenshot-shortcut COUNTS still
    // apply — we just don't visually blur the page anymore.
    // Re-PIN gate — counts time since last successful unlock.
    const [lastUnlockAt, setLastUnlockAt] = useState(() => Date.now());
    const [pinPromptOpen, setPinPromptOpen] = useState(false);
    const [pinInput, setPinInput] = useState('');
    const [pinError, setPinError] = useState('');
    // Pending-recipe-id we tried to expand right before the PIN prompt fired.
    // We re-open it after a successful unlock so the user doesn't lose context.
    const [pendingExpandId, setPendingExpandId] = useState(null);
    // 2026-06-08 — Auto-collapse REMOVED (Andrew: "recipe auto-closes too soon
    // … take off the auto close"). An expanded recipe now stays open until the
    // cook taps the header to close it. (Was: collapse after 90s of idle.)

    // Scale ingredient quantities. Handles:
    //   - Plain integers, decimals: "12", "12.5"
    //   - ASCII fractions: "1/2", "1 1/2"
    //   - Unicode fractions: "½", "¼", "1½", "2¾"
    //   - Em-dash sub-bullet prefix: "— ½ cup salt" → "— 1 cup salt"
    // Output prefers Unicode fractions for clean values (matches the rest of
    // the book's typography). Falls back to one decimal place when nothing
    // matches a clean fraction.
    const scaleIngredient = (text, multiplier) => {
        if (!multiplier || multiplier === 1) return text;
        // Preserve em-dash / hyphen sub-bullet prefix used in dry-seasoning blocks.
        const prefixMatch = text.match(/^(\s*[—–-]\s+)/);
        const prefix = prefixMatch ? prefixMatch[0] : '';
        const body = text.slice(prefix.length);
        // Unicode → decimal lookup. Order = lookup priority for the reverse direction.
        const FRAC_MAP = {
            '½': 0.5, '¼': 0.25, '¾': 0.75,
            '⅓': 1/3, '⅔': 2/3,
            '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
            '⅙': 1/6, '⅚': 5/6,
            '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8,
        };
        const FRACS = Object.keys(FRAC_MAP).join('');
        // Match EVERY quantity in the line (global g flag), not just the
        // leading one, so mid-sentence amounts scale too — e.g.
        // "1 gallon and 9 cups" or "Set aside: 1 cup". Most-specific
        // alternatives first so mixed numbers ("1 1/2", "2½") match as one unit.
        const re = new RegExp(
            '(\\d+\\s*[' + FRACS + ']|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|[' + FRACS + ']|\\d+\\.?\\d*)',
            'g'
        );
        const replaced = body.replace(re, (match, _p1, offset, full) => {
            // Skip numbers that AREN'T batch quantities, so they don't wrongly
            // multiply:
            //   • glued to a word — the "8" in "V8"
            //   • a hyphenated fixed size — "5-gallon" bucket, "1 (2-quart)"
            //   • a per-unit pack size — "2 cans (5 lb each)" keeps "5 lb each"
            const before = offset > 0 ? full[offset - 1] : '';
            if (/[A-Za-z]/.test(before)) return match;
            const after = full.slice(offset + match.length);
            if (/^-[A-Za-z]/.test(after)) return match;
            if (/^(\s+[A-Za-z.]+)?\s+each\b/i.test(after)) return match;
            let num;
            const noWs = match.replace(/\s+/g, '');
            // Mixed Unicode like "1½"
            const mixedUni = noWs.match(new RegExp('^(\\d+)([' + FRACS + '])$'));
            if (mixedUni) {
                num = parseInt(mixedUni[1], 10) + FRAC_MAP[mixedUni[2]];
            } else if (FRAC_MAP[match] !== undefined) {
                // Lone Unicode fraction
                num = FRAC_MAP[match];
            } else if (match.includes(' ') && match.includes('/')) {
                // Mixed ASCII like "1 1/2"
                const parts = match.trim().split(/\s+/);
                const [n, d] = parts[1].split('/').map(Number);
                num = parseFloat(parts[0]) + n / d;
            } else if (match.includes('/')) {
                // ASCII fraction like "1/2"
                const [n, d] = match.split('/').map(Number);
                num = n / d;
            } else {
                num = parseFloat(match);
            }
            const scaled = num * multiplier;
            // Clean integer?
            if (Math.abs(scaled - Math.round(scaled)) < 0.01) return String(Math.round(scaled));
            // Try to express as whole + Unicode fraction.
            const whole = Math.floor(scaled);
            const dec = scaled - whole;
            for (const [str, val] of Object.entries(FRAC_MAP)) {
                if (Math.abs(dec - val) < 0.02) return whole > 0 ? `${whole}${str}` : str;
            }
            // Fallback: one decimal place.
            return scaled.toFixed(1);
        });
        return prefix + replaced;
    };
    const adminUser = isAdmin(staffName, staffList);
    const currentStaffRecord = (staffList || []).find(s => s.name === staffName);
    // Opt-out semantics: every staff has VIEW access by default; admin can
    // flip recipesAccess to false to revoke a specific person. Must match
    // the same check in App.jsx (link visibility) so we don't dead-end
    // staff at "access denied" after they click a visible link. Edit and
    // delete remain admin-only (gated separately in requestEdit/Delete).
    const hasRecipesAccess = adminUser || !currentStaffRecord || currentStaffRecord.recipesAccess !== false;

    // Geofence gate. Admin bypasses (so Andrew/Julie can review recipes
    // anywhere). Everyone else MUST be physically inside one of the two
    // DD Mau locations. NO fail-open — denying the location prompt no
    // longer slips you through. If staff accidentally denied, the blocked
    // screen surfaces a retry button + OS-specific reset instructions.
    const geoAllowed = adminUser || isAtDDMau;
    const geoStatusKind = adminUser
        ? 'admin'
        : geoChecking ? 'checking'
        : isAtDDMau ? 'inside'
        : geoError === 'denied' ? 'denied'
        : geoError === 'noGeo' ? 'nogeo'
        : geoError ? 'error'
        : 'outside';

    // Re-PIN — if it's been > REPIN_INTERVAL_MS since last unlock, the next
    // expand attempt is intercepted and a PIN prompt shown.
    const stalePin = (Date.now() - lastUnlockAt) > REPIN_INTERVAL_MS;
    const requestExpand = (recipeId) => {
        // Already open → just close it, no PIN needed.
        if (expandedRecipe === recipeId) {
            setExpandedRecipe(null);
            return;
        }
        if (stalePin) {
            setPendingExpandId(recipeId);
            setPinInput('');
            setPinError('');
            setPinPromptOpen(true);
            return;
        }
        setExpandedRecipe(recipeId);
    };
    const submitPin = () => {
        const expected = String(currentStaffRecord?.pin || '').trim();
        if (!expected) {
            // No PIN on record (e.g. local DEFAULT_STAFF entry) — allow but log.
            setLastUnlockAt(Date.now());
            setPinPromptOpen(false);
            if (pendingExpandId != null) setExpandedRecipe(pendingExpandId);
            setPendingExpandId(null);
            return;
        }
        if (String(pinInput).trim() === expected) {
            setLastUnlockAt(Date.now());
            setPinPromptOpen(false);
            if (pendingExpandId != null) setExpandedRecipe(pendingExpandId);
            setPendingExpandId(null);
            setPinInput('');
            setPinError('');
        } else {
            setPinError(language === 'es' ? 'PIN incorrecto' : 'Wrong PIN');
        }
    };

    // View logging + screenshot proxy. Each accordion expand creates ONE
    // /recipe_views doc. The doc ref is held in viewSessionRef so that
    // window blur / screenshot-shortcut / quick-blur events (captured below)
    // can incrementally updateDoc the same record. On accordion close /
    // recipe change, we stamp closedAt + final counters. One doc per view,
    // not one per event — Firestore stays clean.
    const viewSessionRef = useRef(null);
    useEffect(() => {
        if (!expandedRecipe) return;
        const r = recipes.find(rr => rr.id === expandedRecipe);
        if (!r) return;
        let cancelled = false;
        const session = {
            docRef: null,
            blurCount: 0,
            quickBlurCount: 0,    // iOS screenshot signature
            screenshotShortcutCount: 0, // desktop Cmd+Shift+3/4/5, PrintScreen
            lastBlurAt: 0,
        };
        viewSessionRef.current = session;
        (async () => {
            try {
                const ref = await addDoc(collection(db, 'recipe_views'), {
                    staffName: staffName || 'unknown',
                    recipeId: expandedRecipe,
                    recipeTitle: r.titleEn || '',
                    isAdmin: !!adminUser,
                    storeLocation: storeLocation || '',
                    geoStatus: geoStatusKind,
                    userAgent: typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '',
                    viewedAt: serverTimestamp(),
                    blurCount: 0,
                    quickBlurCount: 0,
                    screenshotShortcutCount: 0,
                });
                if (cancelled) return;
                session.docRef = ref;
            } catch (err) { console.warn('recipe view log failed:', err); }
        })();
        return () => {
            cancelled = true;
            // Stamp final counters + close time. Fire-and-forget; OK if it fails.
            if (session.docRef) {
                updateDoc(session.docRef, {
                    closedAt: serverTimestamp(),
                    blurCount: session.blurCount,
                    quickBlurCount: session.quickBlurCount,
                    screenshotShortcutCount: session.screenshotShortcutCount,
                }).catch(err => console.warn('recipe view close-update failed:', err));
            }
            viewSessionRef.current = null;
        };
    }, [expandedRecipe, recipes, staffName, adminUser, storeLocation, geoStatusKind]);

    // Screenshot proxies — only active while a recipe is open.
    //
    // We can't directly detect screenshots on web — neither iOS nor Android
    // expose an API. So we capture three SIGNALS and write counts back to
    // the active view doc:
    //
    //   blurCount               — every focus loss while recipe is open
    //   quickBlurCount          — blur followed by focus inside 1.5s. iOS
    //                             screenshot causes the system to briefly
    //                             grab focus to show the thumbnail; this
    //                             pattern is a strong (but not perfect)
    //                             screenshot signal. Notifications / quick
    //                             app switches also trigger it, so admin
    //                             treats this as suspicion, not proof.
    //   screenshotShortcutCount — desktop only: Cmd+Shift+3/4/5 on Mac,
    //                             PrintScreen on Win/Linux. These are
    //                             definitive — the user pressed a known
    //                             screenshot key combo.
    useEffect(() => {
        if (!expandedRecipe) return;
        const session = viewSessionRef.current;
        if (!session) return;

        const handleBlur = () => {
            session.blurCount += 1;
            session.lastBlurAt = Date.now();
            if (session.docRef) {
                updateDoc(session.docRef, { blurCount: session.blurCount }).catch(() => {});
            }
        };
        const handleFocus = () => {
            const dt = Date.now() - (session.lastBlurAt || 0);
            if (session.lastBlurAt && dt > 0 && dt < QUICK_BLUR_MAX_MS) {
                session.quickBlurCount += 1;
                if (session.docRef) {
                    updateDoc(session.docRef, {
                        quickBlurCount: session.quickBlurCount,
                        lastQuickBlurAt: serverTimestamp(),
                    }).catch(() => {});
                }
            }
        };
        const handleKey = (e) => {
            // Mac: Cmd+Shift+3 (full), Cmd+Shift+4 (region), Cmd+Shift+5 (panel)
            // Win/Linux: PrintScreen (and Win+Shift+S on Windows snip)
            const isMacShortcut = e.metaKey && e.shiftKey && (e.key === '3' || e.key === '4' || e.key === '5');
            const isPrintScreen = e.key === 'PrintScreen' || e.code === 'PrintScreen';
            const isWinSnip = e.metaKey && e.shiftKey && (e.key === 'S' || e.key === 's');
            if (isMacShortcut || isPrintScreen || isWinSnip) {
                session.screenshotShortcutCount += 1;
                if (session.docRef) {
                    updateDoc(session.docRef, {
                        screenshotShortcutCount: session.screenshotShortcutCount,
                        lastScreenshotShortcutAt: serverTimestamp(),
                    }).catch(() => {});
                }
                // (Was: briefly blur the page on screenshot shortcut. Removed
                // because the same visual blur was tripping during normal
                // typing on iOS. The shortcut press itself is still LOGGED
                // to the audit panel even without the blur.)
            }
        };

        window.addEventListener('blur', handleBlur);
        window.addEventListener('focus', handleFocus);
        window.addEventListener('keydown', handleKey, true);
        return () => {
            window.removeEventListener('blur', handleBlur);
            window.removeEventListener('focus', handleFocus);
            window.removeEventListener('keydown', handleKey, true);
        };
    }, [expandedRecipe]);

    // Load recipes from Firestore
    //
    // Andrew 2026-05-30 audit fix — short-circuit setRecipes when the
    // new list is identical to the current one. Firestore re-emits the
    // doc on metadata-only changes and on echoes of our own writes;
    // without this check, each emit produced a fresh array identity →
    // `aiItems` useMemo (deps: [recipes]) rebuilt the 80-entry array →
    // search input felt sluggish on slow devices. JSON.stringify of
    // ~80 recipes is <1ms; smaller than the React reconciliation cost
    // we're avoiding.
    const recipesHashRef = useRef(null);
    useEffect(() => {
        const unsubscribe = onSnapshot(
            doc(db, "config", "recipes"),
            (docSnapshot) => {
                if (docSnapshot.exists() && docSnapshot.data().list && docSnapshot.data().list.length > 0) {
                    const next = docSnapshot.data().list;
                    let nextHash = null;
                    try { nextHash = JSON.stringify(next); } catch { nextHash = null; }
                    if (nextHash && nextHash === recipesHashRef.current) return;
                    recipesHashRef.current = nextHash;
                    setRecipes(next);
                }
            },
            // Without an error handler, an offline blip / permission-denied
            // race would silently fail and leave the recipes list empty
            // with no console signal. Log so support can diagnose.
            (err) => console.warn('recipes snapshot error:', err)
        );
        return () => unsubscribe();
    }, []);

    // ── AI search hooks ─────────────────────────────────────────────
    // 2026-05-20 BUGFIX (Andrew: "in recipes the edit button isnt
    // working" — React error #300 / "Rendered more hooks than during
    // the previous render"). These hooks were previously declared
    // AFTER the early returns at lines 679 / 698 / 710. When editMode
    // flipped truthy (clicking Edit), the editMode early return fired
    // and these three hooks stopped being called — hook count
    // changed across renders — React crashed and the ErrorBoundary
    // caught it. Same crash hit when geofence tripped or
    // recipesAccess was off. Hooks MUST be declared before any
    // conditional return so React can match them positionally
    // across renders.
    //
    // Builds a flat items array for the AI search Cloud Function.
    // The aiSearch function expects { id, name, category, subcat }.
    // We pack the recipe title into `name`, the recipe category into
    // `category`, and join allergen codes + the first few ingredient
    // words into `subcat` — that gives Claude enough signal to reason
    // about "vegan", "spicy", "things with shrimp" without blowing
    // up token cost.
    const aiItems = useMemo(() => {
        return recipes.map(r => {
            const allergens = Array.isArray(r.allergens) ? r.allergens.join(',') : '';
            const ing = Array.isArray(r.ingredientsEn)
                ? r.ingredientsEn.slice(0, 6).join(', ').slice(0, 120)
                : '';
            return {
                id: String(r.id),
                name: r.titleEn || r.titleEs || String(r.id),
                category: r.category || '',
                subcat: [allergens, ing].filter(Boolean).join(' | ').slice(0, 180),
            };
        });
    }, [recipes]);
    const { loading: aiLoading, matchingIds: aiIds, error: aiError } = useAiSearch({
        query: searchQueryDeferred,
        items: aiItems,
        enabled: aiOn && searchQueryDeferred.trim().length > 0,
    });
    const aiIdSet = useMemo(() => (aiIds ? new Set(aiIds) : null), [aiIds]);

    // Edit/delete is admin-only. The previous flow had a shared hardcoded
    // password client-side which is unsafe; admins now don't need any
    // password (their PIN already authenticated them on the home screen).
    const requestEdit = (action) => {
        if (!adminUser) {
            toast(language === "es"
                ? "Sólo los administradores pueden editar recetas. Pídele al gerente."
                : "Only admins can edit recipes. Ask a manager.");
            return;
        }
        setEditMode(action);
    };
    const requestDelete = (recipeId) => {
        if (!adminUser) {
            toast(language === "es"
                ? "Sólo los administradores pueden borrar recetas."
                : "Only admins can delete recipes.");
            return;
        }
        deleteRecipe(recipeId);
    };

    // ── Race-safe save helpers ──────────────────────────────────────────
    // BEFORE: every save did `setDoc(..., { list: builtFromLocalState })`.
    // Two admins editing simultaneously = whoever saved second silently
    // clobbered the other's change. Now: runTransaction reads the LIVE
    // doc, applies the change against that fresh list, and writes back
    // atomically. Firestore retries the function if the doc changed
    // between the read and the write, so concurrent edits both land.
    const recipesDocRef = doc(db, "config", "recipes");
    const transactRecipes = (transformer) =>
        runTransaction(db, async (tx) => {
            const snap = await tx.get(recipesDocRef);
            const liveList = (snap.exists() && Array.isArray(snap.data()?.list)) ? snap.data().list : [];
            const next = transformer(liveList);
            tx.set(recipesDocRef, { list: next, updatedAt: new Date().toISOString() });
            return next;
        });
    // ID generation: was Math.max(...) + 1, which produced collisions when
    // two admins added recipes simultaneously. Now Date.now() (millisecond
    // timestamp) — globally unique enough for human edit cadence.
    const newRecipeId = () => Date.now();

    // Append-only audit log for every recipe write. Captures the BEFORE
    // state of the affected recipe (full snapshot, not a diff) so any
    // single recipe can be rolled back to any prior state by reading from
    // /recipe_audits. Costs ~1 doc per save (cheap) and gives full per-
    // recipe history without needing to take a full Firestore backup
    // every time someone tweaks a quantity. Failures here are NON-FATAL
    // — we never want an audit-write hiccup to block the actual save.
    const writeRecipeAudit = async ({ action, recipeId, before, after }) => {
        try {
            await addDoc(collection(db, 'recipe_audits'), {
                action,                // 'add' | 'edit' | 'delete'
                recipeId,
                recipeTitle: (after && after.titleEn) || (before && before.titleEn) || '?',
                byName: staffName || 'unknown',
                at: serverTimestamp(),
                before: before || null,
                after: after || null,
            });
        } catch (auditErr) {
            console.warn('recipe_audits write failed (non-fatal):', auditErr);
        }
    };

    const saveRecipe = async (recipeData) => {
        const id = (editMode === "add") ? newRecipeId() : editMode.id;
        const action = (editMode === "add") ? 'add' : 'edit';
        setEditMode(null);
        // Closure-capture the BEFORE/AFTER state from inside the transaction
        // so we know the actual live state that was overwritten. The
        // transformer runs inside runTransaction's read window — these
        // values are the authoritative pre-/post-state.
        let beforeRecipe = null;
        let afterRecipe = null;
        try {
            await transactRecipes((live) => {
                const idx = live.findIndex(r => r.id === id);
                beforeRecipe = idx === -1 ? null : live[idx];
                afterRecipe = { ...recipeData, id };
                if (action === 'add' || idx === -1) {
                    // Pure add path (or edit-on-deleted-recipe — treat as add)
                    return [...live, afterRecipe];
                }
                const next = [...live];
                next[idx] = afterRecipe;
                return next;
            });
            toast(language === "es" ? "✓ Receta guardada." : "✓ Recipe saved.");
            await writeRecipeAudit({ action, recipeId: id, before: beforeRecipe, after: afterRecipe });
        } catch (err) {
            console.error("Error saving recipe:", err);
            toast((language === "es" ? "Error al guardar: " : "Save failed: ") + (err.message || err), { kind: 'error' });
        }
    };

    const deleteRecipe = async (recipeId) => {
        if (!confirm(language === "es" ? "¿Eliminar esta receta?" : "Delete this recipe?")) return;
        let beforeRecipe = null;
        try {
            await transactRecipes((live) => {
                const idx = live.findIndex(r => r.id === recipeId);
                beforeRecipe = idx === -1 ? null : live[idx];
                return live.filter(r => r.id !== recipeId);
            });
            toast(language === "es" ? "✓ Receta eliminada." : "✓ Recipe deleted.");
            await writeRecipeAudit({ action: 'delete', recipeId, before: beforeRecipe, after: null });
        } catch (err) {
            console.error("Error deleting recipe:", err);
            toast((language === "es" ? "Error al eliminar: " : "Delete failed: ") + (err.message || err), { kind: 'error' });
        }
    };

    // Access gate — block staff without recipesAccess
    if (!hasRecipesAccess) {
        return (
            <div className="p-4 pb-bottom-nav">
                <div className="max-w-sm mx-auto mt-16 text-center">
                    <div className="text-6xl mb-4">{"\u{1F512}"}</div>
                    <h2 className="text-xl font-bold text-gray-800 mb-2">
                        {language === "es" ? "Acceso Restringido" : "Access Restricted"}
                    </h2>
                    <p className="text-gray-500 text-sm">
                        {language === "es"
                            ? "No tienes acceso a las recetas. Contacta a un administrador para obtener permiso."
                            : "You don't have access to recipes. Contact an admin to get permission."}
                    </p>
                </div>
            </div>
        );
    }

    // Geofence gate — admin bypasses, anyone else needs to be inside.
    if (!geoAllowed) {
        return (
            <RecipesGeoBlocked
                language={language}
                geoStatusKind={geoStatusKind}
                geoChecking={geoChecking}
                geoPermState={geoPermState}
                onRetry={geoRetry}
            />
        );
    }

    if (editMode) {
        return <RecipeForm
            language={language}
            recipe={editMode === "add" ? null : editMode}
            onSave={saveRecipe}
            onCancel={() => setEditMode(null)}
        />;
    }

    // Status pill copy — visible at top of Recipes so staff sees the geofence is live.
    const pillTone = {
        admin:    'bg-purple-50 text-purple-700 border-purple-200',
        inside:   'bg-green-50 text-green-700 border-green-200',
        checking: 'bg-gray-50 text-gray-600 border-gray-200',
        denied:   'bg-amber-50 text-amber-700 border-amber-200',
        error:    'bg-amber-50 text-amber-700 border-amber-200',
        outside:  'bg-red-50 text-red-700 border-red-200',
    }[geoStatusKind];
    const pillCopy = (() => {
        if (geoStatusKind === 'admin')    return language === 'es' ? '🔑 Admin · acceso completo' : '🔑 Admin · full access';
        if (geoStatusKind === 'inside')   return language === 'es' ? '📍 En el restaurante ✓' : '📍 At the restaurant ✓';
        if (geoStatusKind === 'checking') return language === 'es' ? '📍 Verificando ubicación...' : '📍 Checking location...';
        if (geoStatusKind === 'denied')   return language === 'es' ? '📍 Permiso denegado · acceso permitido pero registrado' : '📍 Location denied · allowed but logged';
        if (geoStatusKind === 'error')    return language === 'es' ? '📍 Ubicación no disponible · acceso permitido pero registrado' : '📍 Location unavailable · allowed but logged';
        return language === 'es' ? '📍 Fuera del restaurante' : '📍 Off-premises';
    })();
    // Watermark — staff name + today's date burned in. Makes screenshot reposts self-incriminating.
    const watermarkText = (() => {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${staffName || 'unknown'} · ${y}-${m}-${day} ${hh}:${mm}`;
    })();

    // (aiItems / useAiSearch / aiIdSet were moved up to before the
    // early returns to fix a React #300 hook-count mismatch — see
    // the comment block where they now live. Caller variables below
    // — aiLoading, aiIds, aiError, aiIdSet — are still in scope.)

    // Apply the search filter. Empty/whitespace query passes everything
    // through. matchesRecipeQuery handles accent stripping, bilingual
    // synonyms, multi-word AND, and allergen-label matching.
    // When AI is on, the AI ids are UNIONed into the substring set
    // — substring matches always show; AI adds semantic extras.
    const filteredRecipes = searchQueryDeferred.trim()
        ? recipes.filter(r => {
            if (matchesRecipeQuery(r, searchQueryDeferred)) return true;
            if (aiIdSet && aiIdSet.has(String(r.id))) return true;
            return false;
        })
        : recipes;

    return (
        <div className="p-4 pb-bottom-nav recipe-protected" onContextMenu={e => e.preventDefault()}>
            {pinPromptOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
                    <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-3 modal-scroll-lock pb-bottom-nav sm:pb-5">
                        <h3 className="text-base font-bold text-mint-700">🔐 {language === 'es' ? 'Ingresa tu PIN' : 'Enter your PIN'}</h3>
                        <p className="text-xs text-gray-600">
                            {language === 'es'
                                ? 'Por seguridad, ingresa tu PIN cada 5 minutos para abrir una receta.'
                                : 'For security, re-enter your PIN every 5 minutes to open a recipe.'}
                        </p>
                        <input
                            type="password"
                            inputMode="numeric"
                            autoFocus
                            value={pinInput}
                            onChange={(e) => { setPinInput(e.target.value); setPinError(''); }}
                            onKeyDown={(e) => { if (e.key === 'Enter') submitPin(); }}
                            className="w-full border border-gray-300 rounded px-3 py-2 text-center text-xl tracking-widest"
                            placeholder="••••" />
                        {pinError && <p className="text-xs text-red-600 text-center">{pinError}</p>}
                        <div className="flex gap-2">
                            <button onClick={() => { setPinPromptOpen(false); setPendingExpandId(null); setPinInput(''); }}
                                className="flex-1 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold">
                                {language === 'es' ? 'Cancelar' : 'Cancel'}
                            </button>
                            <button onClick={submitPin}
                                className="flex-1 py-2 rounded-lg bg-mint-700 text-white text-sm font-bold">
                                {language === 'es' ? 'Desbloquear' : 'Unlock'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className={`mb-2 inline-flex items-center gap-2 text-[11px] font-bold px-2 py-1 rounded-full border ${pillTone}`}>
                {pillCopy}
            </div>
            <div className="flex items-center justify-between mb-2">
                <h2 className="text-2xl font-bold text-mint-700">🧑‍🍳 {t("recipesTitle", language)}</h2>
                {adminUser && (
                    <button
                        onClick={() => requestEdit("add")}
                        className="bg-mint-700 text-white px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1">
                        + {language === "es" ? "Agregar" : "Add"}
                    </button>
                )}
            </div>
            <p className="text-xs text-gray-500 mb-4 bg-red-50 border border-red-200 rounded-lg p-2">
                🔒 {language === "es"
                    ? "CONFIDENCIAL — Recetas propiedad de DD Mau. Cada vista queda registrada (quién, cuándo, dónde). Los intentos de captura de pantalla también se registran. Las capturas tienen marca de agua con tu nombre y la hora."
                    : "CONFIDENTIAL — DD Mau property. Every view is logged (who, when, where). Screenshot attempts are also logged. Screenshots are watermarked with your name and timestamp."}
            </p>

            {/* Search box. Live filter — no submit. Searches title (EN+ES),
                category, ingredients (EN+ES), and allergen labels in both
                languages. Multi-word queries are AND-semantic; matches are
                accent-insensitive and run through the same restaurant
                synonym list as chat search (chicken↔pollo, lime↔limón). */}
            <div className="mb-3">
                <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">🔍</span>
                        <input
                            type="search"
                            inputMode="search"
                            enterKeyHint="search"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder={aiOn
                                ? (language === "es"
                                    ? 'Buscar lo que quieras ("vegano", "picante", "con camarón")'
                                    : 'Search anything ("vegan", "spicy", "with shrimp")')
                                : (language === "es"
                                    ? "Buscar receta, ingrediente, alérgeno..."
                                    : "Search recipe, ingredient, allergen...")}
                            className="w-full pl-9 pr-9 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mint-400"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                aria-label={language === "es" ? "Limpiar búsqueda" : "Clear search"}
                                className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray-200 text-gray-600 text-xs flex items-center justify-center hover:bg-gray-300"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                    {/* AI semantic search toggle. ON (default) calls the
                        aiSearch Cloud Function alongside the local
                        substring matcher; the two result sets are
                        UNIONed. ~$0.001 per query. Toggle OFF if AI is
                        slow or unavailable — substring keeps working. */}
                    <button onClick={() => setAiOn(v => !v)}
                        title={aiOn
                            ? (language === "es" ? "Búsqueda IA activada — clic para apagar" : "AI search ON — click to use plain search")
                            : (language === "es" ? "Búsqueda básica — clic para activar IA" : "Plain search — click to enable AI")}
                        className={`flex-shrink-0 px-2.5 py-2 rounded-lg text-xs font-bold border transition ${aiOn
                            ? 'bg-purple-600 text-white border-purple-700'
                            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                        ✨ {language === "es" ? "IA" : "AI"}
                    </button>
                </div>
                {searchQuery.trim() && (
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                        <p className="text-[11px] text-gray-500">
                            {language === "es"
                                ? `${filteredRecipes.length} de ${recipes.length} receta${recipes.length === 1 ? '' : 's'}`
                                : `${filteredRecipes.length} of ${recipes.length} recipe${recipes.length === 1 ? '' : 's'}`}
                        </p>
                        {aiOn && aiLoading && (
                            <span className="text-[11px] text-purple-700 font-bold">
                                ✨ {language === "es" ? "pensando…" : "thinking…"}
                            </span>
                        )}
                        {aiOn && !aiLoading && aiError && (
                            <span className="text-[11px] text-amber-700">
                                ⚠ {language === "es" ? "IA no disponible" : "AI unavailable"}
                            </span>
                        )}
                        {aiOn && !aiLoading && !aiError && aiIds && aiIds.length > 0 && (
                            <span className="text-[11px] text-purple-700">
                                ✨ {language === "es"
                                    ? `IA añadió ${aiIds.length}`
                                    : `AI added ${aiIds.length}`}
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* Allergen reverse-lookup toolbar. Cashier flow: a guest says
                "I have a peanut allergy" → tap the 🥜 chip → every recipe
                with peanut highlights red and shows a 🚫 banner. Tap again
                to clear. Solves the "is X safe?" question in one tap.
                When a search is also active, the count below reflects the
                FILTERED set ("Of the recipes I'm currently looking at,
                how many contain peanut?"). */}
            <div className="mb-4 bg-white border border-gray-200 rounded-lg p-2">
                <div className="text-[11px] font-bold text-gray-700 mb-1">
                    🚫 {language === "es" ? "Evitar alérgeno (toca para resaltar):" : "Avoid allergen (tap to highlight):"}
                </div>
                <div className="flex flex-wrap gap-1">
                    {ALLERGEN_ORDER.map(code => {
                        const active = avoidAllergen === code;
                        return (
                            <button key={code}
                                onClick={() => setAvoidAllergen(active ? '' : code)}
                                className={`text-[10px] font-bold px-2 py-1 rounded-full border ${active ? 'bg-red-600 text-white border-red-700' : allergenTone(code)}`}>
                                {allergenEmoji(code)} {allergenLabel(code, language)}
                            </button>
                        );
                    })}
                    {avoidAllergen && (
                        <button onClick={() => setAvoidAllergen('')}
                            className="text-[10px] font-bold px-2 py-1 rounded-full bg-gray-200 text-gray-700">
                            ✕ {language === "es" ? "Limpiar" : "Clear"}
                        </button>
                    )}
                </div>
                {avoidAllergen && (() => {
                    const flagged = filteredRecipes.filter(r => Array.isArray(r.allergens) && r.allergens.includes(avoidAllergen));
                    return (
                        <p className="text-[10px] text-red-700 font-bold mt-2">
                            {language === "es"
                                ? `${flagged.length} receta${flagged.length === 1 ? '' : 's'} contiene${flagged.length === 1 ? '' : 'n'} ${allergenLabel(avoidAllergen, language)}. Resaltadas en rojo.`
                                : `${flagged.length} recipe${flagged.length === 1 ? '' : 's'} contain${flagged.length === 1 ? 's' : ''} ${allergenLabel(avoidAllergen, language)}. Highlighted in red.`}
                        </p>
                    );
                })()}
            </div>

            {filteredRecipes.length === 0 && searchQuery.trim() && (
                <div className="text-center py-10">
                    <div className="text-4xl mb-2">🔍</div>
                    <p className="text-sm font-bold text-gray-700">
                        {language === "es"
                            ? `No hay recetas que coincidan con "${searchQuery}"`
                            : `No recipes match "${searchQuery}"`}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                        {language === "es"
                            ? "Intenta con título, ingrediente o alérgeno."
                            : "Try a title, ingredient, or allergen."}
                    </p>
                </div>
            )}

            {filteredRecipes.map(recipe => {
                const isExpanded = expandedRecipe === recipe.id;
                // Reverse-lookup hit: this recipe contains the allergen the
                // user is filtering against. Card gets a red border + a 🚫
                // chip on the closed header so it pops without expansion.
                const containsAvoided = avoidAllergen && Array.isArray(recipe.allergens) && recipe.allergens.includes(avoidAllergen);
                const sortedAllergens = sortAllergens(recipe.allergens);
                return (
                    <div key={recipe.id} className={`mb-3 bg-white rounded-lg border-2 overflow-hidden ${containsAvoided ? 'border-red-500 ring-2 ring-red-200' : 'border-gray-200'}`}>
                        <div
                            className="p-4 cursor-pointer bg-gradient-to-r from-amber-50 to-white"
                            onClick={() => requestExpand(recipe.id)}
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <span className="text-3xl">{recipe.emoji}</span>
                                    <div className="min-w-0">
                                        <h3 className="font-bold text-amber-800">
                                            {language === "es" ? (recipe.titleEs || recipe.titleEn) : recipe.titleEn}
                                        </h3>
                                        <p className="text-xs text-gray-500">{recipe.category}</p>
                                        {/* Compact allergen preview row on closed card. */}
                                        {sortedAllergens.length > 0 && (
                                            <div className="flex flex-wrap gap-0.5 mt-1">
                                                {sortedAllergens.slice(0, 5).map(code => (
                                                    <span key={code} title={allergenLabel(code, language)} className="text-[9px] leading-none">{allergenEmoji(code)}</span>
                                                ))}
                                                {sortedAllergens.length > 5 && <span className="text-[9px] text-gray-500">+{sortedAllergens.length - 5}</span>}
                                            </div>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    {containsAvoided && (
                                        <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-red-600 text-white whitespace-nowrap">
                                            🚫 {allergenEmoji(avoidAllergen)}
                                        </span>
                                    )}
                                    <span className={`text-lg transition-transform ${isExpanded ? "rotate-180" : ""}`}>▼</span>
                                </div>
                            </div>
                        </div>

                        {isExpanded && (
                            <div className="border-t border-gray-200 p-4 recipe-watermark overflow-hidden" data-watermark={watermarkText}>
                                {/* 🏷 Print prep label — Andrew 2026-05-20. Tap to
                                    open the PrintLabelModal which previews the
                                    label, lets the cook set shelf-life days
                                    (default per recipe category), then prints
                                    via the Epson TM-L100 over the kitchen Wi-Fi.
                                    Stays at the top of the expanded view so it
                                    rides along the allergen banner — the two
                                    things you check before sticking a label
                                    on a container. */}
                                <button
                                    onClick={(e) => { e.stopPropagation(); setPrintingLabelFor(recipe); }}
                                    className="w-full mb-2 py-2.5 rounded-lg bg-purple-600 text-white text-sm font-bold hover:bg-purple-700 active:scale-95 transition shadow-sm flex items-center justify-center gap-2">
                                    🏷 {language === "es" ? "Imprimir etiqueta de preparación" : "Print prep label"}
                                </button>
                                {/* PROMINENT allergen banner — sits at the very top of the
                                    expanded recipe so cooks see it before scrolling to
                                    ingredients. Color-coded chips per allergen. If the
                                    recipe is currently flagged by the avoid filter, an
                                    extra red strip appears above. */}
                                {containsAvoided && (
                                    <div className="mb-2 bg-red-600 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-2">
                                        🚫 {language === "es"
                                            ? `Esta receta contiene ${allergenLabel(avoidAllergen, language).toUpperCase()}. NO servir a clientes con esta alergia.`
                                            : `This recipe contains ${allergenLabel(avoidAllergen, language).toUpperCase()}. DO NOT serve to guests with this allergy.`}
                                    </div>
                                )}
                                {sortedAllergens.length > 0 ? (
                                    <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg p-2">
                                        <div className="text-[10px] font-bold text-amber-900 uppercase mb-1 tracking-wide">
                                            ⚠️ {language === "es" ? "Alérgenos" : "Allergens"}
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                            {sortedAllergens.map(code => (
                                                <span key={code} className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${allergenTone(code)}`}>
                                                    {allergenEmoji(code)} {allergenLabel(code, language)}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="mb-3 bg-green-50 border border-green-200 rounded-lg p-2 text-[11px] font-bold text-green-800">
                                        ✅ {language === "es" ? "Sin alérgenos principales registrados." : "No major allergens recorded."}
                                    </div>
                                )}
                                {adminUser && (
                                    <div className="flex gap-2 mb-3">
                                        <button onClick={(e) => { e.stopPropagation(); requestEdit(recipe); }} className="text-xs bg-amber-100 text-amber-700 px-3 py-1 rounded-full font-bold border border-amber-300">
                                            ✏️ {language === "es" ? "Editar" : "Edit"}
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); requestDelete(recipe.id); }} className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-full font-bold border border-red-200">
                                            🗑️ {language === "es" ? "Eliminar" : "Delete"}
                                        </button>
                                    </div>
                                )}
                                <div className="flex gap-4 mb-4 text-xs">
                                    <div className="bg-blue-50 rounded-lg px-3 py-2 flex-1 text-center">
                                        <div className="font-bold text-blue-700">{t("prepTime", language)}</div>
                                        <div className="text-blue-600">{recipe.prepTimeEn}</div>
                                    </div>
                                    <div className="bg-orange-50 rounded-lg px-3 py-2 flex-1 text-center">
                                        <div className="font-bold text-orange-700">{t("cookTime", language)}</div>
                                        <div className="text-orange-600">{recipe.cookTimeEn}</div>
                                    </div>
                                    <div className="bg-green-50 rounded-lg px-3 py-2 flex-1 text-center">
                                        <div className="font-bold text-green-700">{t("yields", language)}</div>
                                        <div className="text-green-600">{(() => {
                                            const mult = recipeMultipliers[recipe.id] || 1;
                                            const yieldText = language === "es" ? (recipe.yieldsEs || recipe.yieldsEn) : recipe.yieldsEn;
                                            return mult === 1 ? yieldText : scaleIngredient(yieldText, mult);
                                        })()}</div>
                                    </div>
                                </div>

                                {/* Recipe Multiplier */}
                                <div className="mb-4 bg-purple-50 rounded-lg p-3 border border-purple-200">
                                    <div className="text-xs font-bold text-purple-700 mb-2">🔢 {language === "es" ? "Multiplicador de Receta" : "Recipe Multiplier"}</div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {[{label: "½x", val: 0.5}, {label: "1x", val: 1}, {label: "2x", val: 2}, {label: "3x", val: 3}, {label: "5x", val: 5}, {label: "10x", val: 10}].map(btn => {
                                            const current = recipeMultipliers[recipe.id] || 1;
                                            const isActive = current === btn.val;
                                            return (
                                                <button
                                                    key={btn.val}
                                                    onClick={() => setRecipeMultipliers(prev => ({...prev, [recipe.id]: btn.val}))}
                                                    className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${isActive ? "bg-purple-600 text-white border-purple-600 shadow-md" : "bg-white text-purple-700 border-purple-300 hover:bg-purple-100"}`}
                                                >
                                                    {btn.label}
                                                </button>
                                            );
                                        })}
                                        <div className="flex items-center gap-1 ml-1">
                                            <input
                                                type="text"
                                                inputMode="decimal"
                                                placeholder={language === "es" ? "ej. 1/3" : "e.g. 1/3"}
                                                value={(() => {
                                                    if (multiplierDrafts[recipe.id] !== undefined) return multiplierDrafts[recipe.id];
                                                    const cur = recipeMultipliers[recipe.id] || 1;
                                                    const presets = [0.5, 1, 2, 3, 5, 10];
                                                    return presets.includes(cur) ? "" : cur;
                                                })()}
                                                onChange={(e) => {
                                                    setMultiplierDrafts(prev => ({ ...prev, [recipe.id]: e.target.value }));
                                                }}
                                                onBlur={() => commitMultiplierDraft(recipe.id)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
                                                className="w-16 text-center border border-purple-300 rounded-lg px-2 py-1.5 text-xs font-bold text-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-400"
                                            />
                                            <span className="text-xs text-purple-500 font-bold">x</span>
                                        </div>
                                    </div>
                                    {(recipeMultipliers[recipe.id] && recipeMultipliers[recipe.id] !== 1) && (
                                        <div className="mt-2 text-xs text-purple-600 font-medium">
                                            📐 {language === "es"
                                                ? `Mostrando cantidades para ${recipeMultipliers[recipe.id]}x la receta`
                                                : `Showing quantities for ${recipeMultipliers[recipe.id]}x the recipe`}
                                        </div>
                                    )}
                                </div>

                                <div className="mb-4">
                                    <h4 className="font-bold text-sm text-gray-800 mb-2 border-b pb-1">📝 {t("ingredients", language)}</h4>
                                    <ul className="space-y-1">
                                        {(language === "es" ? (recipe.ingredientsEs || recipe.ingredientsEn) : recipe.ingredientsEn).map((item, i) => {
                                            const mult = recipeMultipliers[recipe.id] || 1;
                                            const displayItem = scaleIngredient(item, mult);
                                            return (
                                                <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                                                    <span className="text-mint-400 mt-1">•</span>
                                                    <span>{displayItem}</span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>

                                <div>
                                    <h4 className="font-bold text-sm text-gray-800 mb-2 border-b pb-1">👨‍🍳 {t("instructions", language)}</h4>
                                    <ol className="space-y-2">
                                        {(language === "es" ? (recipe.instructionsEs || recipe.instructionsEn) : recipe.instructionsEn).map((step, i) => (
                                            <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                                                <span className="bg-mint-700 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">{i + 1}</span>
                                                <span>{step}</span>
                                            </li>
                                        ))}
                                    </ol>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}

            {/* Print prep label modal — 2026-05-20. Lazy-imported, so
                first-time print sessions pay a brief network round
                trip for the chunk. Subsequent opens are instant. The
                modal owns its own shelf-life / notes state — Recipes
                only tracks which recipe is being printed. */}
            {printingLabelFor && (
                <Suspense fallback={null}>
                    <PrintLabelModal
                        recipe={printingLabelFor}
                        location={storeLocation}
                        staffName={staffName}
                        language={language}
                        onClose={() => setPrintingLabelFor(null)}
                    />
                </Suspense>
            )}
        </div>
    );
}

// ── RecipesGeoBlocked ──────────────────────────────────────────────────────
// Full-screen block when the user fails the geofence gate.
//
// Two paths depending on the live Permissions API state:
//   • permState === 'denied'  — browser has remembered a Deny choice. No
//                               API will re-trigger the prompt. We show a
//                               one-liner pointing at Settings. (Andrew's
//                               feedback: no mega instructions panel.)
//   • permState === 'prompt' | 'unknown' — never decided, or no Permissions
//                               API. Tapping Enable Location calls
//                               getCurrentPosition, which triggers the
//                               native OS prompt directly. This is what
//                               Andrew wanted: button → phone asks.
function RecipesGeoBlocked({ language, geoStatusKind, geoChecking, geoPermState, onRetry }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [retrying, setRetrying] = useState(false);

    // The Permissions API tells us if a fresh getCurrentPosition() call
    // would trigger the native dialog (`prompt` / `unknown`) or just bounce
    // because the user already said no (`denied`). When it's denied, the
    // button can't fix it — only Settings can.
    const isHardDenied = geoPermState === 'denied' || geoStatusKind === 'denied';

    const handleRetry = () => {
        setRetrying(true);
        if (typeof onRetry === 'function') onRetry();
        setTimeout(() => setRetrying(false), 2000);
    };

    const { title, body } = (() => {
        if (geoChecking) {
            return {
                title: tx('Checking your location…', 'Verificando ubicación…'),
                body: tx('One moment — confirming you\'re at DD Mau.',
                        'Un momento — verificando que estés en DD Mau.'),
            };
        }
        if (isHardDenied) {
            return {
                title: tx('Turn on location for DD Mau', 'Activa la ubicación para DD Mau'),
                // Tight, settings-aimed copy. Andrew asked for no big
                // expandable how-to — just the one obvious next step.
                body: tx(
                    'You tapped Don\'t Allow earlier — the browser won\'t let us ask again. Open Settings → Location and switch DD Mau on, then return here.',
                    'Tocaste No permitir antes — el navegador no nos deja preguntar otra vez. Abre Ajustes → Ubicación y activa DD Mau, luego regresa.',
                ),
            };
        }
        if (geoStatusKind === 'nogeo') {
            return {
                title: tx('Location not supported', 'Ubicación no compatible'),
                body: tx(
                    'This device doesn\'t support location. Open the app on your phone while at DD Mau.',
                    'Este dispositivo no soporta ubicación. Abre la app en tu teléfono dentro de DD Mau.',
                ),
            };
        }
        if (geoStatusKind === 'error') {
            return {
                title: tx('Location unavailable', 'Ubicación no disponible'),
                body: tx(
                    'Couldn\'t get a GPS fix. Move closer to a window or try again.',
                    'No se pudo obtener una ubicación. Acércate a una ventana o intenta de nuevo.',
                ),
            };
        }
        if (geoPermState === 'prompt') {
            // User hasn't decided yet — clicking the button WILL pop the
            // native prompt. Frame it as a positive action, not a retry.
            return {
                title: tx('Turn on location to view recipes', 'Activa la ubicación para ver las recetas'),
                body: tx(
                    'Tap the button below to allow location. Recipes are only available while you\'re at DD Mau.',
                    'Toca el botón para permitir la ubicación. Las recetas solo están disponibles en DD Mau.',
                ),
            };
        }
        // outside
        return {
            title: tx('You\'re not at DD Mau', 'No estás en DD Mau'),
            body: tx(
                'Recipes are only available while you\'re at DD Mau Webster Groves or Maryland Heights.',
                'Las recetas solo están disponibles cuando estás en DD Mau Webster Groves o Maryland Heights.',
            ),
        };
    })();

    return (
        <div className="p-4 pb-bottom-nav">
            <div className="max-w-md mx-auto mt-8 sm:mt-16 text-center bg-white border-2 border-mint-200 rounded-2xl p-6 shadow-sm">
                <div className="text-6xl mb-3">📍</div>
                <h2 className="text-xl font-black text-gray-800 mb-2">{title}</h2>
                <p className="text-sm text-gray-600 mb-5 leading-relaxed">{body}</p>

                {!isHardDenied && (
                    <button onClick={handleRetry} disabled={retrying || geoChecking}
                        className="w-full py-3.5 rounded-xl bg-mint-700 text-white font-black text-base hover:bg-mint-700 active:scale-95 transition disabled:opacity-60 disabled:cursor-not-allowed">
                        {retrying || geoChecking
                            ? '📍 ' + tx('Checking…', 'Verificando…')
                            : '📍 ' + tx('Enable Location', 'Activar Ubicación')}
                    </button>
                )}
            </div>
        </div>
    );
}
