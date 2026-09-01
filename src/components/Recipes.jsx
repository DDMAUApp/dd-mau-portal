import { useState, useEffect, useRef, useMemo, useDeferredValue, useCallback, lazy, Suspense } from 'react';
import { db } from '../firebase';
import {
    doc, onSnapshot, collection, serverTimestamp,
    addDoc as _fsAddDoc, updateDoc as _fsUpdateDoc,
    runTransaction as _fsRunTransaction,
} from 'firebase/firestore';
// 2026-08-11 full-app audit — watchdog shadows (wedged-transport revive;
// see firestoreRevive.js). Same pattern as Schedule/ChatThread.
import { watchdogWrite } from '../data/firestoreRevive';
const addDoc = (...a) => watchdogWrite(_fsAddDoc(...a));
const updateDoc = (...a) => watchdogWrite(_fsUpdateDoc(...a));
const runTransaction = (...a) => watchdogWrite(_fsRunTransaction(...a));
import { t } from '../data/translations';
import { isAdmin } from '../data/staff';
import { ALLERGEN_ORDER, allergenLabel, allergenEmoji, allergenTone, sortAllergens } from '../data/allergens';
import { matchesRecipeQuery } from '../data/recipeSearch';
import { useAiSearch } from '../data/aiSearch';
import { printRecipeIngredients } from '../data/labelPrinting';
import { scaleIngredient, parseQuantity } from '../data/recipeScale';
import { splitIngredientLine } from '../data/ingredientParts';
import { toast } from '../toast';
import RecipeForm from './RecipeForm';
// 2026-05-20 — date-code label printing on Epson TM-L100. Lazy so
// the preview + ePOS-Print XML helpers only enter the bundle when a
// staffer actually opens the modal (most sessions won't print).
const PrintLabelModal = lazy(() => import('./PrintLabelModal'));
// 2026-08-18 — AI recipe import (photo / PDF / file / paste). Admin-only
// and rare, so it stays out of the main chunk (pulls in jszip + pdfjs
// lazily itself).
const RecipeImportModal = lazy(() => import('./RecipeImportModal'));

// Re-PIN window — staff must re-enter PIN if no recipe was opened in this many ms.
const REPIN_INTERVAL_MS = 5 * 60 * 1000; // 5 min
// AUTO_COLLAPSE_MS removed 2026-06-08 — recipe auto-close disabled (Andrew).
// "Quick blur" window — iOS taking a screenshot causes a brief blur → focus
// pattern (the system grabs focus to show the screenshot thumbnail). If a
// blur event is followed by focus inside this window, we count it as a
// likely screenshot. Notifications/calls also briefly steal focus, so this
// is a SIGNAL not a definitive detector.
const QUICK_BLUR_MAX_MS = 1500;

// Section order for the grouped list — the printed Master Recipe Book's
// order. Anything else (a category typed free-hand in the editor) sorts
// after these, alphabetically.
const CATEGORY_ORDER = [
    'Sauces & Dressings',
    'Seasonings, Marinades & Soy',
    'Snacks & Fried Items',
    'Pho & Soups',
    'Drinks & Desserts',
];
const CATEGORY_ES = {
    'Sauces & Dressings': 'Salsas y Aderezos',
    'Seasonings, Marinades & Soy': 'Sazonadores, Marinadas y Soya',
    'Snacks & Fried Items': 'Botanas y Fritos',
    'Pho & Soups': 'Pho y Sopas',
    'Drinks & Desserts': 'Bebidas y Postres',
};
const CATEGORY_EMOJI = {
    'Sauces & Dressings': '🥢',
    'Seasonings, Marinades & Soy': '🧂',
    'Snacks & Fried Items': '🍤',
    'Pho & Soups': '🍜',
    'Drinks & Desserts': '🧋',
};
const MULTIPLIER_PRESETS = [
    { label: '½x', val: 0.5 }, { label: '1x', val: 1 }, { label: '2x', val: 2 },
    { label: '3x', val: 3 }, { label: '5x', val: 5 }, { label: '10x', val: 10 },
];
const PRESET_VALUES = MULTIPLIER_PRESETS.map(p => p.val);
// Chip-filter key for recipes with a blank category (can't use '' — that
// means "no filter").
const UNCAT_KEY = '__uncategorized__';

function categoryLabel(cat, language) {
    if (!cat) return language === 'es' ? 'Sin categoría' : 'Uncategorized';
    return language === 'es' ? (CATEGORY_ES[cat] || cat) : cat;
}
function categoryRank(cat) {
    const i = CATEGORY_ORDER.indexOf(cat);
    return i === -1 ? CATEGORY_ORDER.length : i;
}

// Editing is gated on isAdmin (Andrew/Julie) — no shared password.
// Previously a hardcoded RECIPE_PASSWORD was checked client-side, which
// meant the password was visible to anyone who opened devtools. Removed.
// If you need to grant edit access to a non-admin, promote them to an
// ADMIN_ID in src/data/staff.js or add a per-staff "canEditRecipes" flag.

export default function Recipes({ language, staffName, staffList, storeLocation, isAtDDMau, geoChecking, geoError, geoRetry, geoPermState }) {
    const isEs = language === 'es';
    const [expandedRecipe, setExpandedRecipe] = useState(null);
    // 2026-05-20 — Andrew: Vietnamese equivalent of Jolt's date-code
    // labeling. When set to a recipe object, the PrintLabelModal opens
    // with that recipe's data pre-filled. Closes on print / cancel.
    const [printingLabelFor, setPrintingLabelFor] = useState(null);
    const [recipes, setRecipes] = useState([]);
    const [editMode, setEditMode] = useState(null); // null | "add" | recipe object
    const [importOpen, setImportOpen] = useState(false);
    const [recipeMultipliers, setRecipeMultipliers] = useState({}); // { recipeId: number }
    // Reverse-lookup: when set, recipes containing this allergen get a strong
    // visual warning (red border + 🚫 chip) so cashiers/cooks scanning for
    // "what's safe for a peanut allergy?" can see at a glance which recipes
    // to avoid. Empty = no filter.
    const [avoidAllergen, setAvoidAllergen] = useState('');
    // Category chip filter — '' = all sections; UNCAT_KEY = the blank bucket.
    const [catFilter, setCatFilter] = useState('');
    // Free-text search across title (EN+ES), category, ingredients (EN+ES),
    // and allergen labels (EN+ES). Live filter — no submit needed. Matching
    // is accent-insensitive and multi-word AND-semantic, and runs through
    // the same restaurant-vocabulary synonym list that powers chat search
    // (chicken↔pollo, lime↔limón, broth↔caldo). See src/data/recipeSearch.js.
    const [searchQuery, setSearchQuery] = useState('');
    // 2026-05-30 perf — defer the search value used by the heavy filter +
    // AI dispatch. The input itself reads searchQuery (instant feedback);
    // the filter + the AI search hook read the deferred value, so React
    // updates them at lower priority and a keystroke never blocks paint.
    const searchQueryDeferred = useDeferredValue(searchQuery);
    // AI semantic search toggle. When ON, the search query is ALSO sent to
    // the aiSearch Cloud Function (Claude-backed). The substring matcher
    // keeps running locally — AI results are UNIONed into the substring set
    // so users get instant feedback and Claude fills in the semantic extras
    // (e.g. "vegan", "spicy", "things with shrimp") ~300ms later. Defaults ON.
    const [aiOn, setAiOn] = useState(true);
    // Raw text the user has typed in the per-recipe Custom multiplier input.
    // We commit (parseQuantity → setRecipeMultipliers) on blur/Enter so that
    // mid-typing characters like "1/" don't snap to a preset.
    const [multiplierDrafts, setMultiplierDrafts] = useState({}); // { recipeId: string }
    // ⚖️ Ratio scaling — "match what you have" per recipe (see ratioAnchors
    // in the card render). Session-only, like the multiplier itself.
    const [ratioDrafts, setRatioDrafts] = useState({});           // { recipeId: { idx, have } }
    const [ratioAppliedByRecipe, setRatioAppliedByRecipe] = useState({}); // { recipeId: { have, unit, rest, mult } }
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
    // both trip the blur/focus and devtools heuristics. Watermark + view
    // logging + screenshot-shortcut COUNTS still apply.
    // Re-PIN gate — counts time since last successful unlock.
    const [lastUnlockAt, setLastUnlockAt] = useState(() => Date.now());
    const [pinPromptOpen, setPinPromptOpen] = useState(false);
    const [pinInput, setPinInput] = useState('');
    const [pinError, setPinError] = useState('');
    // Pending-recipe-id we tried to expand right before the PIN prompt fired.
    // We re-open it after a successful unlock so the user doesn't lose context.
    const [pendingExpandId, setPendingExpandId] = useState(null);

    // 🖨 Print the SCALED ingredient list to the kitchen label printer —
    // Andrew 2026-06-12: "when we print a recipes i just want just the
    // ingredients and it needs to reflect the multiplier. if they do x3,
    // i only want to see 3 can oyster, 12 cup soy sauce." The lines are
    // scaled with the SAME scaleIngredient the screen uses, so the print
    // matches the on-screen quantities exactly.
    const [printingIngredientsId, setPrintingIngredientsId] = useState(null);
    const handlePrintIngredients = async (recipe) => {
        if (printingIngredientsId) return;
        const mult = recipeMultipliers[recipe.id] || 1;
        const src = isEs
            ? (recipe.ingredientsEs?.length ? recipe.ingredientsEs : recipe.ingredientsEn)
            : (recipe.ingredientsEn?.length ? recipe.ingredientsEn : recipe.ingredientsEs);
        const lines = (src || []).map(item => scaleIngredient(item, mult));
        const title = isEs ? (recipe.titleEs || recipe.titleEn) : recipe.titleEn;
        setPrintingIngredientsId(recipe.id);
        let res;
        try {
            res = await printRecipeIngredients({
                location: storeLocation === 'both' ? 'webster' : (storeLocation || 'webster'),
                title,
                lines,
                multiplier: mult,
                byName: staffName,
            });
        } catch (e) {
            res = { ok: false, error: e?.message || 'print_failed' };
        } finally {
            // 2026-08-18 audit: a throw used to leave the button stuck on
            // "Printing…" for the rest of the session.
            setPrintingIngredientsId(null);
        }
        if (res.ok) {
            toast(isEs ? '✓ Ingredientes impresos' : '✓ Ingredients printed', { kind: 'success' });
            // Andrew 2026-06-12: "make sure the recipe audit in admin
            // records if someone printed recipe and how many." Prints land
            // in the SAME /recipe_views collection the admin Recipe Audit
            // panel reads, flagged printed:true + the batch multiplier, so
            // views and prints show in one timeline. Fire-and-forget — an
            // audit hiccup must never block or un-toast a successful print.
            addDoc(collection(db, 'recipe_views'), {
                staffName: staffName || 'unknown',
                recipeId: recipe.id,
                recipeTitle: recipe.titleEn || '',
                isAdmin: isAdmin(staffName, staffList),
                storeLocation: storeLocation || '',
                geoStatus: geoStatusKind,
                userAgent: typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '',
                viewedAt: serverTimestamp(),
                printed: true,
                printMultiplier: mult,
                printLineCount: lines.length,
                blurCount: 0,
                quickBlurCount: 0,
                screenshotShortcutCount: 0,
            }).catch(err => console.warn('recipe print audit failed:', err));
        } else if (res.error === 'no_printer_configured') {
            toast(isEs ? 'No hay impresora configurada (Admin → Impresoras)' : 'No printer configured (Admin → Label printers)', { kind: 'error' });
        } else {
            toast(isEs
                ? 'No se pudo imprimir — ¿impresora apagada / Wi-Fi incorrecto? (Desde el navegador no se puede — usa la app)'
                : "Couldn't print — printer off / wrong Wi-Fi? (Web browsers can't print — use the phone/iPad app)", { kind: 'error' });
        }
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
    //
    // 2026-07-26 audit — staleness is computed AT TAP TIME, inside the
    // handler (a render-time const went stale on an idle tab).
    const requestExpand = (recipeId) => {
        // Already open → just close it, no PIN needed.
        if (expandedRecipe === recipeId) {
            setExpandedRecipe(null);
            return;
        }
        const stalePin = (Date.now() - lastUnlockAt) > REPIN_INTERVAL_MS;
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
            setPinError(isEs ? 'PIN incorrecto' : 'Wrong PIN');
        }
    };

    // Bring a freshly opened recipe into view (its header may be near the
    // bottom of the screen when tapped; the body then renders below the
    // fold). scroll-mt on the card keeps it clear of the sticky app header.
    const cardRefs = useRef(new Map());
    useEffect(() => {
        if (expandedRecipe == null) return;
        const el = cardRefs.current.get(expandedRecipe);
        if (!el) return;
        const id = requestAnimationFrame(() => {
            const rect = el.getBoundingClientRect();
            const vh = window.innerHeight || 800;
            if (rect.top < 60 || rect.top > vh * 0.45) {
                try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
            }
        });
        return () => cancelAnimationFrame(id);
    }, [expandedRecipe]);

    // View logging + screenshot proxy. Each accordion expand creates ONE
    // /recipe_views doc. The doc ref is held in viewSessionRef so that
    // window blur / screenshot-shortcut / quick-blur events (captured below)
    // can incrementally updateDoc the same record. On accordion close /
    // recipe change, we stamp closedAt + final counters. One doc per view,
    // not one per event — Firestore stays clean.
    //
    // 2026-08-18 audit: the effect used to depend on `recipes` / geo /
    // storeLocation too, so a live snapshot (an admin saving ANY recipe) or
    // a location flip closed and re-opened the view session → duplicate
    // view rows in the admin audit for the same open card. Metadata now
    // comes from a ref; the effect keys on the opened recipe only.
    const viewSessionRef = useRef(null);
    const viewMetaRef = useRef({});
    viewMetaRef.current = { recipes, staffName, adminUser, storeLocation, geoStatusKind };
    // A just-saved recipe is expanded BEFORE its snapshot lands; this boolean
    // flips once it exists so the view row is still written (and stays
    // stable across unrelated snapshots so we don't re-log).
    const expandedExists = expandedRecipe != null && recipes.some(rr => rr.id === expandedRecipe);
    useEffect(() => {
        if (!expandedRecipe || !expandedExists) return;
        const meta = viewMetaRef.current;
        const r = (meta.recipes || []).find(rr => rr.id === expandedRecipe);
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
                    staffName: meta.staffName || 'unknown',
                    recipeId: expandedRecipe,
                    recipeTitle: r.titleEn || '',
                    isAdmin: !!meta.adminUser,
                    storeLocation: meta.storeLocation || '',
                    geoStatus: meta.geoStatusKind,
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
    }, [expandedRecipe, expandedExists]);

    // Screenshot proxies — only active while a recipe is open.
    //
    // We can't directly detect screenshots on web — neither iOS nor Android
    // expose an API. So we capture three SIGNALS and write counts back to
    // the active view doc:
    //   blurCount               — every focus loss while recipe is open
    //   quickBlurCount          — blur followed by focus inside 1.5s (iOS
    //                             screenshot signature; also notifications)
    //   screenshotShortcutCount — desktop only: Cmd+Shift+3/4/5 on Mac,
    //                             PrintScreen on Win/Linux. Definitive.
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
    }, [expandedRecipe, expandedExists]);

    // Load recipes from Firestore
    //
    // Andrew 2026-05-30 audit fix — short-circuit setRecipes when the new
    // list is identical to the current one (Firestore re-emits on
    // metadata-only changes and echoes of our own writes). JSON.stringify
    // of ~40 recipes is <1ms; smaller than the reconciliation it avoids.
    const recipesHashRef = useRef(null);
    const [snapshotSeen, setSnapshotSeen] = useState(false);
    useEffect(() => {
        // 2026-07-27 — instant first paint (Andrew: "when i first go in it
        // takes alittle bit to load"). Serve the last-seen list synchronously
        // from localStorage so the page renders content immediately, then
        // let the live snapshot below overwrite it (hash-deduped, so an
        // unchanged doc costs zero re-renders).
        const CACHE_KEY = 'ddmau:recipes:v1';
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
            if (Array.isArray(cached) && cached.length > 0) {
                recipesHashRef.current = JSON.stringify(cached);
                setRecipes(cached);
            }
        } catch { /* corrupt/absent cache — normal load path below */ }
        const unsubscribe = onSnapshot(
            doc(db, "config", "recipes"),
            (docSnapshot) => {
                setSnapshotSeen(true);
                if (docSnapshot.exists() && docSnapshot.data().list && docSnapshot.data().list.length > 0) {
                    const next = docSnapshot.data().list;
                    let nextHash = null;
                    try { nextHash = JSON.stringify(next); } catch { nextHash = null; }
                    if (nextHash && nextHash === recipesHashRef.current) return;
                    recipesHashRef.current = nextHash;
                    setRecipes(next);
                    try { localStorage.setItem(CACHE_KEY, nextHash); } catch { /* quota — live path unaffected */ }
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
    // (Declared BEFORE any early return — React #300 hook-count fix,
    // 2026-05-20.) Builds a flat items array for the AI search Cloud
    // Function: title → name, category, allergen codes + first ingredient
    // words → subcat. Enough signal for "vegan", "spicy", "with shrimp"
    // without blowing up token cost.
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

    // Category list for the chip row + editor (book order, then others).
    const categories = useMemo(() => {
        const counts = new Map();
        for (const r of recipes) {
            const c = (r.category || '').trim();
            counts.set(c, (counts.get(c) || 0) + 1);
        }
        return [...counts.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => categoryRank(a.name) - categoryRank(b.name) || a.name.localeCompare(b.name));
    }, [recipes]);
    const categoryNames = useMemo(() => categories.map(c => c.name).filter(Boolean), [categories]);

    // Edit/delete is admin-only. The previous flow had a shared hardcoded
    // password client-side which is unsafe; admins now don't need any
    // password (their PIN already authenticated them on the home screen).
    const requestEdit = (action) => {
        if (!adminUser) {
            toast(isEs
                ? "Sólo los administradores pueden editar recetas. Pídele al gerente."
                : "Only admins can edit recipes. Ask a manager.");
            return;
        }
        setEditMode(action);
    };
    const requestDelete = (recipeId) => {
        if (!adminUser) {
            toast(isEs ? "Sólo los administradores pueden borrar recetas." : "Only admins can delete recipes.");
            return;
        }
        deleteRecipe(recipeId);
    };

    // ── Race-safe save helpers ──────────────────────────────────────────
    // runTransaction reads the LIVE doc, applies the change against that
    // fresh list, and writes back atomically — two admins editing at once
    // both land (the old setDoc-from-local-state clobbered the loser).
    const recipesDocRef = doc(db, "config", "recipes");
    const transactRecipes = (transformer) =>
        runTransaction(db, async (tx) => {
            const snap = await tx.get(recipesDocRef);
            const liveList = (snap.exists() && Array.isArray(snap.data()?.list)) ? snap.data().list : [];
            const next = transformer(liveList);
            // updatedAt must be MONOTONIC: firestore.rules requires the new
            // stamp to compare > the live one (string compare on canonical
            // ISO). Writing the raw device clock bricked every OTHER device
            // once one device's clock ran fast — their saves failed with
            // "insufficient permissions" until wall-clock caught up
            // (2026-08-25 audit). Bump 1ms past the live stamp when needed.
            // Computed INSIDE the callback so contention retries recompute.
            const liveUpdatedAt = snap.exists() ? snap.data()?.updatedAt : null;
            let stamp = new Date().toISOString();
            if (typeof liveUpdatedAt === 'string' && !(stamp > liveUpdatedAt)) {
                const parsed = Date.parse(liveUpdatedAt);
                stamp = Number.isFinite(parsed)
                    ? new Date(parsed + 1).toISOString()
                    : stamp;
                // Console-edited non-canonical stamps (e.g. no milliseconds)
                // can compare greater than their own +1ms canonical form.
                // Last resort: append a suffix that sorts above it.
                if (!(stamp > liveUpdatedAt)) stamp = liveUpdatedAt + '.1';
            }
            tx.set(recipesDocRef, { list: next, updatedAt: stamp });
            return next;
        });
    // ID generation: Date.now() — collision-free at human edit cadence
    // (Math.max+1 collided when two admins added at once).
    const newRecipeId = () => Date.now();

    // Append-only audit log for every recipe write. Captures the BEFORE
    // state of the affected recipe (full snapshot, not a diff) so any
    // single recipe can be rolled back to any prior state by reading from
    // /recipe_audits. Failures here are NON-FATAL.
    const writeRecipeAudit = async ({ action, recipeId, before, after, via }) => {
        try {
            await addDoc(collection(db, 'recipe_audits'), {
                action,                // 'add' | 'edit' | 'delete'
                recipeId,
                recipeTitle: (after && after.titleEn) || (before && before.titleEn) || '?',
                byName: staffName || 'unknown',
                at: serverTimestamp(),
                before: before || null,
                after: after || null,
                ...(via ? { via } : {}),
            });
        } catch (auditErr) {
            console.warn('recipe_audits write failed (non-fatal):', auditErr);
        }
    };

    // Shared by the editor (saveRecipe) and the AI import (one call per
    // recipe — firestore.rules caps list growth at +10 per write anyway).
    // `existingId` = replace that recipe; null = add.
    const upsertRecipe = useCallback(async (recipeData, existingId, via) => {
        const id = existingId != null ? existingId : newRecipeId();
        const action = existingId != null ? 'edit' : 'add';
        let beforeRecipe = null;
        let afterRecipe = null;
        // JSON round-trip drops `undefined` values — Firestore rejects them
        // and the editor form can carry `id: undefined` on a fresh draft.
        const clean = JSON.parse(JSON.stringify({ ...recipeData, id }));
        await transactRecipes((live) => {
            const idx = live.findIndex(r => r.id === id);
            beforeRecipe = idx === -1 ? null : live[idx];
            afterRecipe = clean;
            if (action === 'add' || idx === -1) {
                // Pure add path (or edit-on-deleted-recipe — treat as add)
                return [...live, afterRecipe];
            }
            const next = [...live];
            next[idx] = afterRecipe;
            return next;
        });
        await writeRecipeAudit({ action, recipeId: id, before: beforeRecipe, after: afterRecipe, via });
        return id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [staffName]);

    const saveRecipe = async (recipeData) => {
        const existingId = (editMode === "add") ? null : editMode.id;
        setEditMode(null);
        try {
            const id = await upsertRecipe(recipeData, existingId);
            toast(isEs ? "✓ Receta guardada." : "✓ Recipe saved.");
            setExpandedRecipe(id);
        } catch (err) {
            console.error("Error saving recipe:", err);
            toast((isEs ? "Error al guardar: " : "Save failed: ") + (err.message || err), { kind: 'error' });
        }
    };

    const deleteRecipe = async (recipeId) => {
        if (!confirm(isEs ? "¿Eliminar esta receta?" : "Delete this recipe?")) return;
        let beforeRecipe = null;
        try {
            await transactRecipes((live) => {
                const idx = live.findIndex(r => r.id === recipeId);
                beforeRecipe = idx === -1 ? null : live[idx];
                return live.filter(r => r.id !== recipeId);
            });
            if (expandedRecipe === recipeId) setExpandedRecipe(null);
            toast(isEs ? "✓ Receta eliminada." : "✓ Recipe deleted.");
            await writeRecipeAudit({ action: 'delete', recipeId, before: beforeRecipe, after: null });
        } catch (err) {
            console.error("Error deleting recipe:", err);
            toast((isEs ? "Error al eliminar: " : "Delete failed: ") + (err.message || err), { kind: 'error' });
        }
    };

    // Access gate — block staff without recipesAccess
    if (!hasRecipesAccess) {
        return (
            <div className="p-4 md:p-5">
                <div className="max-w-sm mx-auto mt-16 text-center">
                    <div className="text-6xl mb-4">{"\u{1F512}"}</div>
                    <h2 className="text-xl font-bold text-gray-800 mb-2">
                        {isEs ? "Acceso Restringido" : "Access Restricted"}
                    </h2>
                    <p className="text-gray-500 text-sm">
                        {isEs
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
            categories={categoryNames}
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
        if (geoStatusKind === 'admin')    return isEs ? '🔑 Admin · acceso completo' : '🔑 Admin · full access';
        if (geoStatusKind === 'inside')   return isEs ? '📍 En el restaurante ✓' : '📍 At the restaurant ✓';
        if (geoStatusKind === 'checking') return isEs ? '📍 Verificando ubicación...' : '📍 Checking location...';
        if (geoStatusKind === 'denied')   return isEs ? '📍 Permiso denegado · acceso permitido pero registrado' : '📍 Location denied · allowed but logged';
        if (geoStatusKind === 'error')    return isEs ? '📍 Ubicación no disponible · acceso permitido pero registrado' : '📍 Location unavailable · allowed but logged';
        return isEs ? '📍 Fuera del restaurante' : '📍 Off-premises';
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

    // Apply the search filter. Empty/whitespace query passes everything
    // through. When AI is on, the AI ids are UNIONed into the substring set.
    const searching = !!searchQueryDeferred.trim();
    const searchedRecipes = searching
        ? recipes.filter(r => {
            if (matchesRecipeQuery(r, searchQueryDeferred)) return true;
            if (aiIdSet && aiIdSet.has(String(r.id))) return true;
            return false;
        })
        : recipes;
    const filteredRecipes = catFilter
        ? searchedRecipes.filter(r => (r.category || '').trim() === (catFilter === UNCAT_KEY ? '' : catFilter))
        : searchedRecipes;

    // Group into sections in book order.
    const sections = (() => {
        const map = new Map();
        for (const r of filteredRecipes) {
            const c = (r.category || '').trim();
            if (!map.has(c)) map.set(c, []);
            map.get(c).push(r);
        }
        return [...map.entries()]
            .sort((a, b) => categoryRank(a[0]) - categoryRank(b[0]) || a[0].localeCompare(b[0]));
    })();

    const renderCard = (recipe) => {
        const isExpanded = expandedRecipe === recipe.id;
        // Reverse-lookup hit: this recipe contains the allergen the user is
        // filtering against. Card gets a red border + a 🚫 chip on the
        // closed header so it pops without expansion.
        const containsAvoided = avoidAllergen && Array.isArray(recipe.allergens) && recipe.allergens.includes(avoidAllergen);
        const sortedAllergens = sortAllergens(recipe.allergens);
        const mult = recipeMultipliers[recipe.id] || 1;
        const title = isEs ? (recipe.titleEs || recipe.titleEn) : recipe.titleEn;
        const yieldText = (isEs ? (recipe.yieldsEs || recipe.yieldsEn) : (recipe.yieldsEn || recipe.yieldsEs)) || '';
        const ingredients = (isEs ? (recipe.ingredientsEs?.length ? recipe.ingredientsEs : recipe.ingredientsEn) : (recipe.ingredientsEn?.length ? recipe.ingredientsEn : recipe.ingredientsEs)) || [];
        const instructions = (isEs ? (recipe.instructionsEs?.length ? recipe.instructionsEs : recipe.instructionsEn) : (recipe.instructionsEn?.length ? recipe.instructionsEn : recipe.instructionsEs)) || [];
        const usingFallbackLang = isEs
            ? !(recipe.ingredientsEs?.length) && !!(recipe.ingredientsEn?.length)
            : !(recipe.ingredientsEn?.length) && !!(recipe.ingredientsEs?.length);
        // ⚖️ Ratio anchors (Andrew 2026-09-01: "recipe asks for 10 lb of
        // cabbage but the weight is always different — if I make it with
        // 6.75 lb it will recalculate everything else"). Every ingredient
        // line whose leading amount parses can anchor the ratio; the
        // multiplier becomes have ÷ recipe-amount and rides the existing
        // scaling everywhere (lines, yield, print).
        const ratioLang = (isEs && !usingFallbackLang) ? 'es' : 'en';
        const ratioAnchors = ingredients.map((line, idx) => {
            const p = splitIngredientLine(line, ratioLang);
            const base = parseQuantity(p.qty);
            if (!base || base <= 0) return null;
            const short = p.rest.length > 28 ? p.rest.slice(0, 28) + '…' : p.rest;
            return { idx, base, unit: p.unit, rest: p.rest, label: `${p.qty}${p.unit ? ' ' + p.unit : ''} ${short}` };
        }).filter(Boolean);
        const ratioDraft = ratioDrafts[recipe.id] || { idx: '', have: '' };
        const ratioApplied = ratioAppliedByRecipe[recipe.id];
        const applyRatio = (draft) => {
            const d = draft || ratioDraft;
            const opt = ratioAnchors.find(o => o.idx === Number(d.idx));
            const have = parseQuantity(d.have);
            if (!opt || !have || have <= 0) return;
            const m = have / opt.base;
            setRecipeMultipliers(prev => ({ ...prev, [recipe.id]: m }));
            setRatioAppliedByRecipe(prev => ({ ...prev, [recipe.id]: { have: d.have, unit: opt.unit, rest: opt.rest, mult: m } }));
        };
        return (
            <div key={recipe.id}
                ref={(el) => { if (el) cardRefs.current.set(recipe.id, el); else cardRefs.current.delete(recipe.id); }}
                className={`bg-white rounded-xl border-2 overflow-hidden scroll-mt-20 ${isExpanded ? 'lg:col-span-2 shadow-md ' : 'ddmau-recipe-cv '}${containsAvoided ? 'border-red-500 ring-2 ring-red-200' : isExpanded ? 'border-mint-300' : 'border-gray-200'}`}>
                <div
                    className={`px-3 py-3 md:px-4 cursor-pointer select-none ${isExpanded ? 'bg-gradient-to-r from-mint-50 to-white' : 'bg-gradient-to-r from-amber-50/70 to-white'}`}
                    onClick={() => requestExpand(recipe.id)}
                >
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                            <span className="text-3xl leading-none flex-shrink-0">{recipe.emoji || '🍽️'}</span>
                            <div className="min-w-0">
                                <h3 className="font-bold text-amber-900 leading-tight md:text-[17px]">{title}</h3>
                                {yieldText && !isExpanded && (
                                    <p className="text-[11px] text-gray-500 truncate mt-0.5">{yieldText}</p>
                                )}
                                {sortedAllergens.length > 0 && !isExpanded && (
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {sortedAllergens.slice(0, 4).map(code => (
                                            <span key={code} title={allergenLabel(code, language)} className={`text-[10px] leading-none font-bold px-1.5 py-0.5 rounded-full border ${allergenTone(code)}`}>
                                                {allergenEmoji(code)} {allergenLabel(code, language)}
                                            </span>
                                        ))}
                                        {sortedAllergens.length > 4 && <span className="text-[10px] text-gray-500 font-bold self-center">+{sortedAllergens.length - 4}</span>}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                            {containsAvoided && (
                                <span className="text-[10px] font-bold px-2 py-1 rounded-full bg-red-600 text-white whitespace-nowrap">
                                    🚫 {allergenEmoji(avoidAllergen)}
                                </span>
                            )}
                            <span className={`text-lg text-gray-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}>▼</span>
                        </div>
                    </div>
                </div>

                {isExpanded && (
                    <div className="border-t border-gray-200 p-3 md:p-4 recipe-watermark overflow-hidden" data-watermark={watermarkText}>
                        {/* Top strip: prep-label print + allergen banner + admin actions.
                            The two things you check before sticking a label on a
                            container sit together at the very top. */}
                        <div className="flex flex-col sm:flex-row sm:items-start gap-2 mb-3">
                            <button
                                onClick={(e) => { e.stopPropagation(); setPrintingLabelFor(recipe); }}
                                className="sm:order-2 sm:w-auto w-full px-4 py-2.5 rounded-lg bg-purple-600 text-white text-sm font-bold hover:bg-purple-700 active:scale-95 transition shadow-sm flex items-center justify-center gap-2 whitespace-nowrap">
                                🏷 {isEs ? "Imprimir etiqueta de preparación" : "Print prep label"}
                            </button>
                            <div className="flex-1 min-w-0 sm:order-1">
                                {containsAvoided && (
                                    <div className="mb-2 bg-red-600 text-white text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-2">
                                        🚫 {isEs
                                            ? `Esta receta contiene ${allergenLabel(avoidAllergen, language).toUpperCase()}. NO servir a clientes con esta alergia.`
                                            : `This recipe contains ${allergenLabel(avoidAllergen, language).toUpperCase()}. DO NOT serve to guests with this allergy.`}
                                    </div>
                                )}
                                {sortedAllergens.length > 0 ? (
                                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-2">
                                        <div className="text-[10px] font-bold text-amber-900 uppercase mb-1 tracking-wide">
                                            ⚠️ {isEs ? "Alérgenos" : "Allergens"}
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
                                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 text-[11px] font-bold text-gray-600">
                                        ⚠️ {isEs ? "Sin alérgenos etiquetados — pregunta al Shift Lead antes de servir a un cliente con alergia." : "No allergens tagged — ask the Shift Lead before serving a guest with an allergy."}
                                    </div>
                                )}
                            </div>
                        </div>
                        {adminUser && (
                            <div className="flex gap-2 mb-3">
                                <button onClick={(e) => { e.stopPropagation(); requestEdit(recipe); }} className="text-xs bg-amber-100 text-amber-700 px-3 py-1 rounded-full font-bold border border-amber-300">
                                    ✏️ {isEs ? "Editar" : "Edit"}
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); requestDelete(recipe.id); }} className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-full font-bold border border-red-200">
                                    🗑️ {isEs ? "Eliminar" : "Delete"}
                                </button>
                            </div>
                        )}

                        <div className="lg:grid lg:grid-cols-5 lg:gap-6">
                            {/* Left column: meta · multiplier · ingredients */}
                            <div className="lg:col-span-2">
                                <div className="flex gap-2 mb-3 text-xs">
                                    <div className="bg-blue-50 rounded-lg px-2 py-2 flex-1 text-center min-w-0">
                                        <div className="font-bold text-blue-700">{t("prepTime", language)}</div>
                                        <div className="text-blue-600">{recipe.prepTimeEn || '—'}</div>
                                    </div>
                                    <div className="bg-orange-50 rounded-lg px-2 py-2 flex-1 text-center min-w-0">
                                        <div className="font-bold text-orange-700">{t("cookTime", language)}</div>
                                        <div className="text-orange-600">{recipe.cookTimeEn || '—'}</div>
                                    </div>
                                </div>
                                {yieldText && (
                                    <div className="bg-green-50 rounded-lg px-3 py-2 mb-3 text-xs">
                                        <span className="font-bold text-green-700">{t("yields", language)}: </span>
                                        <span className="text-green-700">{mult === 1 ? yieldText : scaleIngredient(yieldText, mult)}</span>
                                    </div>
                                )}

                                {/* Recipe Multiplier */}
                                <div className="mb-3 bg-purple-50 rounded-lg p-3 border border-purple-200">
                                    <div className="text-xs font-bold text-purple-700 mb-2">🔢 {isEs ? "Multiplicador de Receta" : "Recipe Multiplier"}</div>
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                        {MULTIPLIER_PRESETS.map(btn => {
                                            const isActive = mult === btn.val;
                                            return (
                                                <button
                                                    key={btn.val}
                                                    onClick={() => setRecipeMultipliers(prev => ({ ...prev, [recipe.id]: btn.val }))}
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
                                                placeholder={isEs ? "ej. 1/3" : "e.g. 1/3"}
                                                value={(() => {
                                                    if (multiplierDrafts[recipe.id] !== undefined) return multiplierDrafts[recipe.id];
                                                    return PRESET_VALUES.includes(mult) ? "" : mult;
                                                })()}
                                                onChange={(e) => setMultiplierDrafts(prev => ({ ...prev, [recipe.id]: e.target.value }))}
                                                onBlur={() => commitMultiplierDraft(recipe.id)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
                                                className="w-16 text-center border border-purple-300 rounded-lg px-2 py-1.5 text-xs font-bold text-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-400"
                                            />
                                            <span className="text-xs text-purple-500 font-bold">x</span>
                                        </div>
                                    </div>
                                    {/* ⚖️ Match what you have — anchor the whole recipe to the
                                        real amount of one ingredient (10 lb cabbage on paper,
                                        6.75 lb on the scale → everything ×0.675). */}
                                    {ratioAnchors.length > 0 && (
                                        <div className="mt-2 pt-2 border-t border-purple-200">
                                            <div className="text-[11px] font-bold text-purple-700 mb-1.5">
                                                ⚖️ {isEs ? 'Ajustar a lo que tienes' : 'Match what you have'}
                                            </div>
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <select
                                                    value={ratioDraft.idx}
                                                    onChange={(e) => setRatioDrafts(prev => ({ ...prev, [recipe.id]: { ...ratioDraft, idx: e.target.value } }))}
                                                    className="flex-1 min-w-[9rem] max-w-full border border-purple-300 rounded-lg px-2 py-1.5 text-xs font-bold text-purple-700 bg-white focus:outline-none focus:ring-2 focus:ring-purple-400">
                                                    <option value="">{isEs ? 'Elige ingrediente…' : 'Pick ingredient…'}</option>
                                                    {ratioAnchors.map(o => (
                                                        <option key={o.idx} value={o.idx}>{o.label}</option>
                                                    ))}
                                                </select>
                                                <span className="text-xs text-purple-500 font-bold whitespace-nowrap">{isEs ? 'tengo' : 'I have'}</span>
                                                <input
                                                    type="text"
                                                    inputMode="decimal"
                                                    placeholder="6.75"
                                                    value={ratioDraft.have}
                                                    onChange={(e) => setRatioDrafts(prev => ({ ...prev, [recipe.id]: { ...ratioDraft, have: e.target.value } }))}
                                                    onKeyDown={(e) => { if (e.key === 'Enter') applyRatio(); }}
                                                    className="w-16 text-center border border-purple-300 rounded-lg px-2 py-1.5 text-xs font-bold text-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-400"
                                                />
                                                {(() => {
                                                    const opt = ratioAnchors.find(o => o.idx === Number(ratioDraft.idx));
                                                    return opt?.unit ? <span className="text-xs text-purple-500 font-bold">{opt.unit}</span> : null;
                                                })()}
                                                <button
                                                    onClick={() => applyRatio()}
                                                    disabled={!(ratioAnchors.find(o => o.idx === Number(ratioDraft.idx)) && parseQuantity(ratioDraft.have) > 0)}
                                                    className="px-3 py-1.5 rounded-full text-xs font-bold bg-purple-600 text-white disabled:opacity-40 active:scale-95 transition">
                                                    {isEs ? 'Calcular' : 'Recalculate'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                    {mult !== 1 && ratioApplied && Math.abs(mult - ratioApplied.mult) < 1e-9 ? (
                                        <div className="mt-2 text-xs text-purple-700 font-medium">
                                            ⚖️ {isEs
                                                ? `Recalculado para ${ratioApplied.have}${ratioApplied.unit ? ' ' + ratioApplied.unit : ''} de ${ratioApplied.rest} — todo lo demás ×${Math.round(mult * 1000) / 1000}, en morado.`
                                                : `Recalculated for ${ratioApplied.have}${ratioApplied.unit ? ' ' + ratioApplied.unit : ''} of ${ratioApplied.rest} — everything else ×${Math.round(mult * 1000) / 1000}, shown in purple.`}
                                        </div>
                                    ) : mult !== 1 && (
                                        <div className="mt-2 text-xs text-purple-700 font-medium">
                                            📐 {isEs
                                                ? `Mostrando cantidades para ${mult}x la receta — las cantidades escaladas van en morado.`
                                                : `Showing quantities for ${mult}x the recipe — scaled amounts are in purple.`}
                                        </div>
                                    )}
                                </div>

                                <div className="mb-4 lg:mb-0">
                                    <div className="flex items-center justify-between border-b pb-1 mb-2">
                                        <h4 className="font-bold text-sm text-gray-800">📝 {t("ingredients", language)}
                                            {usingFallbackLang && <span className="ml-1 text-[10px] font-normal text-gray-400">({isEs ? 'solo en inglés' : 'Spanish only'})</span>}
                                        </h4>
                                        {/* Prints exactly the scaled quantities shown below */}
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handlePrintIngredients(recipe); }}
                                            disabled={printingIngredientsId === recipe.id}
                                            translate="no"
                                            className="notranslate text-xs bg-purple-600 text-white px-3 py-1 rounded-full font-bold hover:bg-purple-700 active:scale-95 transition disabled:opacity-50 flex items-center gap-1">
                                            {/* 2026-06-25 / 2026-07-27 — Google-Translate removeChild crash
                                                fix: BOTH branches wrapped in a single <span> AND the button
                                                marked translate="no"/.notranslate. Keep both. */}
                                            {printingIngredientsId === recipe.id
                                                ? <span>{isEs ? 'Imprimiendo…' : 'Printing…'}</span>
                                                : <span>🖨 {isEs ? 'Imprimir' : 'Print'}{mult !== 1 ? ` ${mult}x` : ''}</span>}
                                        </button>
                                    </div>
                                    <ul className="space-y-1.5">
                                        {ingredients.map((item, i) => {
                                            const displayItem = scaleIngredient(item, mult);
                                            const scaled = mult !== 1 && displayItem !== item;
                                            const isSub = /^\s*[—–-]\s+/.test(String(item || ''));
                                            return (
                                                <li key={i} className={`text-sm md:text-[15px] text-gray-800 flex items-start gap-2 ${isSub ? 'pl-4' : ''}`}>
                                                    <span className="text-mint-400 mt-0.5 flex-shrink-0">•</span>
                                                    <span className={scaled ? 'text-purple-800 font-semibold' : ''}>{displayItem}</span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            </div>

                            {/* Right column: instructions */}
                            <div className="lg:col-span-3">
                                <h4 className="font-bold text-sm text-gray-800 mb-2 border-b pb-1">👨‍🍳 {t("instructions", language)}</h4>
                                {instructions.length === 0 && (
                                    <p className="text-xs text-gray-400 italic">{isEs ? 'Sin instrucciones todavía.' : 'No instructions yet.'}</p>
                                )}
                                <ol className="space-y-2.5">
                                    {instructions.map((step, i) => (
                                        <li key={i} className="text-sm md:text-[15px] text-gray-800 flex items-start gap-2.5 leading-snug">
                                            <span className="bg-mint-700 text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">{i + 1}</span>
                                            {/* Instructions are never scaled — "repeat 3 times", "step 2",
                                                "cut into 4" would all go wrong. Ingredients + yields only. */}
                                            <span className="pt-0.5">{step}</span>
                                        </li>
                                    ))}
                                </ol>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="p-4 md:p-5 recipe-protected" onContextMenu={e => e.preventDefault()}>
            {pinPromptOpen && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
                    <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm p-5 space-y-3 modal-scroll-lock pb-bottom-nav sm:pb-5">
                        <h3 className="text-base font-bold text-mint-700">🔐 {isEs ? 'Ingresa tu PIN' : 'Enter your PIN'}</h3>
                        <p className="text-xs text-gray-600">
                            {isEs
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
                                {isEs ? 'Cancelar' : 'Cancel'}
                            </button>
                            <button onClick={submitPin}
                                className="flex-1 py-2 rounded-lg bg-mint-700 text-white text-sm font-bold">
                                {isEs ? 'Desbloquear' : 'Unlock'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                <div className={`inline-flex items-center gap-2 text-[11px] font-bold px-2 py-1 rounded-full border ${pillTone}`}>
                    {pillCopy}
                </div>
                {adminUser && (
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setImportOpen(true)}
                            className="bg-purple-600 text-white px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1 shadow-sm">
                            📥 {isEs ? "Importar" : "Import"}
                        </button>
                        <button
                            onClick={() => requestEdit("add")}
                            className="bg-mint-700 text-white px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1 shadow-sm">
                            + {isEs ? "Agregar" : "Add"}
                        </button>
                    </div>
                )}
            </div>
            <div className="flex items-baseline justify-between mb-2 gap-2">
                <h2 className="text-2xl font-bold text-mint-700">🧑‍🍳 {t("recipesTitle", language)}</h2>
                <span className="text-xs text-gray-500 font-bold">{recipes.length} {isEs ? 'recetas' : 'recipes'}</span>
            </div>
            <p className="text-[11px] text-gray-600 mb-3 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5 leading-snug">
                🔒 {isEs
                    ? "CONFIDENCIAL — Recetas propiedad de DD Mau. Cada vista queda registrada (quién, cuándo, dónde). Los intentos de captura de pantalla también se registran y las capturas llevan tu nombre y la hora."
                    : "CONFIDENTIAL — DD Mau property. Every view is logged (who, when, where). Screenshot attempts are logged too, and screenshots are watermarked with your name and timestamp."}
            </p>

            {/* Search box. Live filter — no submit. */}
            <div className="mb-2">
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
                                ? (isEs
                                    ? 'Buscar lo que quieras ("vegano", "picante", "con camarón")'
                                    : 'Search anything ("vegan", "spicy", "with shrimp")')
                                : (isEs
                                    ? "Buscar receta, ingrediente, alérgeno..."
                                    : "Search recipe, ingredient, allergen...")}
                            className="w-full pl-9 pr-9 py-2.5 border border-gray-300 rounded-lg text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-mint-400"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                aria-label={isEs ? "Limpiar búsqueda" : "Clear search"}
                                className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-gray-200 text-gray-600 text-xs flex items-center justify-center hover:bg-gray-300"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                    {/* AI semantic search toggle. ~$0.001 per query. */}
                    <button onClick={() => setAiOn(v => !v)}
                        title={aiOn
                            ? (isEs ? "Búsqueda IA activada — clic para apagar" : "AI search ON — click to use plain search")
                            : (isEs ? "Búsqueda básica — clic para activar IA" : "Plain search — click to enable AI")}
                        className={`flex-shrink-0 px-2.5 py-2 rounded-lg text-xs font-bold border transition ${aiOn
                            ? 'bg-purple-600 text-white border-purple-700'
                            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                        ✨ {isEs ? "IA" : "AI"}
                    </button>
                </div>
                {searchQuery.trim() && (
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                        <p className="text-[11px] text-gray-500">
                            {isEs
                                ? `${filteredRecipes.length} de ${recipes.length} receta${recipes.length === 1 ? '' : 's'}`
                                : `${filteredRecipes.length} of ${recipes.length} recipe${recipes.length === 1 ? '' : 's'}`}
                        </p>
                        {aiOn && aiLoading && (
                            <span className="text-[11px] text-purple-700 font-bold">✨ {isEs ? "pensando…" : "thinking…"}</span>
                        )}
                        {aiOn && !aiLoading && aiError && (
                            <span className="text-[11px] text-amber-700">⚠ {isEs ? "IA no disponible" : "AI unavailable"}</span>
                        )}
                        {aiOn && !aiLoading && !aiError && aiIds && aiIds.length > 0 && (
                            <span className="text-[11px] text-purple-700">✨ {isEs ? `IA añadió ${aiIds.length}` : `AI added ${aiIds.length}`}</span>
                        )}
                    </div>
                )}
            </div>

            {/* Category chips — jump straight to a section of the book. */}
            {categories.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto pb-1 mb-2 -mx-1 px-1 [scrollbar-width:none]">
                    <button onClick={() => setCatFilter('')}
                        className={`flex-shrink-0 text-[11px] font-bold px-2.5 py-1.5 rounded-full border ${!catFilter ? 'bg-mint-700 text-white border-mint-700' : 'bg-white text-gray-700 border-gray-300'}`}>
                        {isEs ? 'Todas' : 'All'} <span className="opacity-70">{recipes.length}</span>
                    </button>
                    {categories.map(c => {
                        const key = c.name || UNCAT_KEY;
                        const active = catFilter === key;
                        return (
                        <button key={key} onClick={() => setCatFilter(active ? '' : key)}
                            className={`flex-shrink-0 text-[11px] font-bold px-2.5 py-1.5 rounded-full border whitespace-nowrap ${active ? 'bg-mint-700 text-white border-mint-700' : 'bg-white text-gray-700 border-gray-300'}`}>
                            {CATEGORY_EMOJI[c.name] || '📁'} {categoryLabel(c.name, language)} <span className="opacity-70">{c.count}</span>
                        </button>
                        );
                    })}
                </div>
            )}

            {/* Allergen reverse-lookup toolbar. Cashier flow: a guest says
                "I have a peanut allergy" → tap the 🥜 chip → every recipe
                with peanut highlights red and shows a 🚫 banner. */}
            <div className="mb-3 bg-white border border-gray-200 rounded-lg p-2">
                <div className="text-[11px] font-bold text-gray-700 mb-1">
                    🚫 {isEs ? "Evitar alérgeno (toca para resaltar):" : "Avoid allergen (tap to highlight):"}
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
                            ✕ {isEs ? "Limpiar" : "Clear"}
                        </button>
                    )}
                </div>
                {avoidAllergen && (() => {
                    const flagged = filteredRecipes.filter(r => Array.isArray(r.allergens) && r.allergens.includes(avoidAllergen));
                    const untagged = filteredRecipes.filter(r => !Array.isArray(r.allergens) || r.allergens.length === 0).length;
                    return (
                        <p className="text-[10px] text-red-700 font-bold mt-2">
                            {isEs
                                ? `${flagged.length} receta${flagged.length === 1 ? '' : 's'} contiene${flagged.length === 1 ? '' : 'n'} ${allergenLabel(avoidAllergen, language)}. Resaltadas en rojo.`
                                : `${flagged.length} recipe${flagged.length === 1 ? '' : 's'} contain${flagged.length === 1 ? 's' : ''} ${allergenLabel(avoidAllergen, language)}. Highlighted in red.`}
                            {untagged > 0 && (
                                <span className="text-amber-700"> {isEs
                                    ? `${untagged} sin etiquetas de alérgenos — no asumas que son seguras.`
                                    : `${untagged} have no allergen tags — don't assume they're safe.`}</span>
                            )}
                        </p>
                    );
                })()}
            </div>

            {filteredRecipes.length === 0 && (searchQuery.trim() || catFilter) && (
                <div className="text-center py-10">
                    <div className="text-4xl mb-2">🔍</div>
                    <p className="text-sm font-bold text-gray-700">
                        {searchQuery.trim()
                            ? (isEs ? `No hay recetas que coincidan con "${searchQuery}"` : `No recipes match "${searchQuery}"`)
                            : (isEs ? 'No hay recetas en esta sección' : 'No recipes in this section')}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                        {isEs ? "Intenta con título, ingrediente o alérgeno." : "Try a title, ingredient, or allergen."}
                    </p>
                    {catFilter && (
                        <button onClick={() => setCatFilter('')} className="mt-3 text-xs font-bold text-mint-700 underline">
                            {isEs ? 'Ver todas las secciones' : 'Show all sections'}
                        </button>
                    )}
                </div>
            )}

            {recipes.length === 0 && (
                <div className="text-center py-10 text-sm text-gray-500">
                    {snapshotSeen ? (isEs ? 'Todavía no hay recetas.' : 'No recipes yet.') : (isEs ? 'Cargando recetas…' : 'Loading recipes…')}
                </div>
            )}

            {sections.map(([cat, list]) => (
                <section key={cat || '_none'} className="mb-5">
                    <div className="flex items-baseline gap-2 mb-2 px-1">
                        <h3 className="text-sm font-black uppercase tracking-wide text-mint-800">
                            {CATEGORY_EMOJI[cat] || '📁'} {categoryLabel(cat, language)}
                        </h3>
                        <span className="text-[11px] text-gray-400 font-bold">{list.length}</span>
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        {list.map(renderCard)}
                    </div>
                </section>
            ))}

            {/* Print prep label modal — 2026-05-20. Lazy-imported. */}
            {printingLabelFor && (
                <Suspense fallback={null}>
                    <PrintLabelModal
                        recipe={printingLabelFor}
                        location={storeLocation === 'both' ? 'webster' : (storeLocation || 'webster')}
                        staffName={staffName}
                        language={language}
                        onClose={() => setPrintingLabelFor(null)}
                    />
                </Suspense>
            )}

            {/* AI recipe import — 2026-08-18. Admin-only. */}
            {importOpen && (
                <Suspense fallback={null}>
                    <RecipeImportModal
                        language={language}
                        categories={categoryNames}
                        existingRecipes={recipes.map(r => ({ id: r.id, titleEn: typeof r.titleEn === 'string' ? r.titleEn : '' }))}
                        onSaveRecipes={(recipeData, existingId) => upsertRecipe(recipeData, existingId, 'ai_import')}
                        onClose={() => setImportOpen(false)}
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
//                               one-liner pointing at Settings.
//   • permState === 'prompt' | 'unknown' — never decided, or no Permissions
//                               API. Tapping Enable Location calls
//                               getCurrentPosition, which triggers the
//                               native OS prompt directly.
function RecipesGeoBlocked({ language, geoStatusKind, geoChecking, geoPermState, onRetry }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [retrying, setRetrying] = useState(false);

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
        <div className="p-4 md:p-5">
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
