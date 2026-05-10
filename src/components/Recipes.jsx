import { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc, addDoc, updateDoc, collection, runTransaction, serverTimestamp } from 'firebase/firestore';
import { t } from '../data/translations';
import { isAdmin } from '../data/staff';
import { ALLERGEN_ORDER, allergenLabel, allergenEmoji, allergenTone, sortAllergens } from '../data/allergens';
import { toast } from '../toast';

// Re-PIN window — staff must re-enter PIN if no recipe was opened in this many ms.
const REPIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min
// Auto-collapse — after this many ms of no activity, expanded recipe closes.
const AUTO_COLLAPSE_MS = 90 * 1000; // 90s
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

export default function Recipes({ language, staffName, staffList, storeLocation, isAtDDMau, geoChecking, geoError }) {
    const [expandedRecipe, setExpandedRecipe] = useState(null);
    const [recipes, setRecipes] = useState([]);
    const [editMode, setEditMode] = useState(null); // null | "add" | recipe object
    const [recipeMultipliers, setRecipeMultipliers] = useState({}); // { recipeId: number }
    // Reverse-lookup: when set, recipes containing this allergen get a strong
    // visual warning (red border + 🚫 chip) so cashiers/cooks scanning for
    // "what's safe for a peanut allergy?" can see at a glance which recipes
    // to avoid. Empty = no filter.
    const [avoidAllergen, setAvoidAllergen] = useState('');
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
    const autoCollapseTimerRef = useRef(null);

    // Auto-collapse — close the open recipe after 90s of no scroll/touch/click.
    // Reduces the "phone left face-up on the prep counter" attack window.
    useEffect(() => {
        if (!expandedRecipe) {
            if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
            return;
        }
        const reset = () => {
            if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
            autoCollapseTimerRef.current = setTimeout(() => {
                setExpandedRecipe(null);
            }, AUTO_COLLAPSE_MS);
        };
        reset();
        const events = ['scroll', 'touchstart', 'touchmove', 'mousemove', 'click', 'keydown'];
        events.forEach(ev => window.addEventListener(ev, reset, { passive: true }));
        return () => {
            if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
            events.forEach(ev => window.removeEventListener(ev, reset));
        };
    }, [expandedRecipe]);

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
        // Match the leading quantity (most specific first).
        const re = new RegExp(
            '^(\\d+\\s*[' + FRACS + ']|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|[' + FRACS + ']|\\d+\\.?\\d*)'
        );
        const replaced = body.replace(re, (match) => {
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
    // anywhere). Off-premises = hard block. Permission-denied / unavailable
    // falls back to ALLOW so that staff who decline the location prompt
    // aren't permanently locked out — but still gets logged so we can spot
    // the pattern in the audit trail.
    const geoAllowed = adminUser || isAtDDMau || (geoError && geoError !== null);
    const geoStatusKind = adminUser
        ? 'admin'
        : geoChecking ? 'checking'
        : isAtDDMau ? 'inside'
        : geoError === 'denied' ? 'denied'
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
    useEffect(() => {
        const unsubscribe = onSnapshot(doc(db, "config", "recipes"), (docSnapshot) => {
            if (docSnapshot.exists() && docSnapshot.data().list && docSnapshot.data().list.length > 0) {
                setRecipes(docSnapshot.data().list);
            }
        });
        return () => unsubscribe();
    }, []);

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

    // Geofence gate — admin bypasses, geo-error allows, off-premises blocks.
    if (!geoAllowed) {
        return (
            <div className="p-4 pb-bottom-nav">
                <div className="max-w-sm mx-auto mt-16 text-center">
                    <div className="text-6xl mb-4">📍</div>
                    <h2 className="text-xl font-bold text-gray-800 mb-2">
                        {language === "es" ? "Solo en el restaurante" : "On-premises only"}
                    </h2>
                    <p className="text-gray-500 text-sm">
                        {geoChecking
                            ? (language === "es" ? "Verificando ubicación..." : "Checking your location...")
                            : (language === "es"
                                ? "Las recetas están disponibles solo cuando estás en DD Mau Webster Groves o Maryland Heights."
                                : "Recipes are available only while you're at DD Mau Webster Groves or Maryland Heights.")}
                    </p>
                </div>
            </div>
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

    return (
        <div className="p-4 pb-bottom-nav recipe-protected" onContextMenu={e => e.preventDefault()}>
            {pinPromptOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-3">
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

            {/* Allergen reverse-lookup toolbar. Cashier flow: a guest says
                "I have a peanut allergy" → tap the 🥜 chip → every recipe
                with peanut highlights red and shows a 🚫 banner. Tap again
                to clear. Solves the "is X safe?" question in one tap. */}
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
                    const flagged = recipes.filter(r => Array.isArray(r.allergens) && r.allergens.includes(avoidAllergen));
                    return (
                        <p className="text-[10px] text-red-700 font-bold mt-2">
                            {language === "es"
                                ? `${flagged.length} receta${flagged.length === 1 ? '' : 's'} contiene${flagged.length === 1 ? '' : 'n'} ${allergenLabel(avoidAllergen, language)}. Resaltadas en rojo.`
                                : `${flagged.length} recipe${flagged.length === 1 ? '' : 's'} contain${flagged.length === 1 ? 's' : ''} ${allergenLabel(avoidAllergen, language)}. Highlighted in red.`}
                        </p>
                    );
                })()}
            </div>

            {recipes.map(recipe => {
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
        </div>
    );
}
