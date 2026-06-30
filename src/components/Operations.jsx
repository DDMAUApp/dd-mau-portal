import { useState, useEffect, useRef, useMemo, useCallback, useDeferredValue, lazy, Suspense, memo } from 'react';
import { db, storage } from '../firebase';
import { doc, onSnapshot, setDoc, getDoc, getDocs, updateDoc, addDoc, query, collection, orderBy, limit, where, serverTimestamp, deleteField, arrayUnion, runTransaction, increment } from 'firebase/firestore';
import { ref, getDownloadURL, uploadBytes, deleteObject } from 'firebase/storage';
import { t, autoTranslateItem } from '../data/translations';
import { isAdmin, isAdminId, LOCATION_LABELS, canViewLabor } from '../data/staff';
import { getLaborStatus, getLaborStatusHint } from '../data/labor';
import { INVENTORY_CATEGORIES, INVENTORY_LOCATIONS, INVENTORY_VENDORS, normalizeVendor, locationLabel } from '../data/inventory';
// Trusted item-pricing engine (inventory pricing redesign). resolveTrustedPrice
// returns the priority-ranked price (manual > receipt > … > legacy scraped).
import { subscribeItemPrices, resolveTrustedPrice, PRICE_SOURCE_LABEL, cheapestVendor as pickCheapestVendor, lastOrdered as pickLastOrdered, orderQtyStats as pickOrderQty } from '../data/itemPricing';
import ItemPriceModal from './ItemPriceModal';
import PricingWorkspace from './PricingWorkspace';
import { subscribeActiveList } from '../data/inventoryLists';
import { useAiSearch } from '../data/aiSearch';
import { printViaNative, openExternalUrl } from '../capacitor-bridge';
const OrderMode = lazy(() => import('./OrderMode'));
// 2026-05-20 — date-code label printing on Epson TM-L100. Lazy so the
// ePOS-Print XML helper + preview only enter the Operations chunk
// when a staffer actually opens the quick-label modal.
const PrintLabelModal = lazy(() => import('./PrintLabelModal'));
// Print Center — free-form Word-style printing for ad-hoc kitchen
// notes / equipment status / single-batch markers. Lazy for the
// same reason.
const PrintCenter = lazy(() => import('./PrintCenter'));
import { escapeHtml as escH } from '../data/htmlEscape';
// Lazy-loaded sub-views — these are 500-1000+ line components that only
// render when their specific sub-tab is active. Eager-importing them
// added ~70KB gzip to the Operations chunk that wasn't needed for the
// initial Tasks view. With React.lazy + Vite, each becomes its own
// chunk loaded on first navigation to its tab.
const InventoryHistory   = lazy(() => import('./InventoryHistory'));
const PrepList           = lazy(() => import('./PrepList'));
// 2026-06-08 — Prep tab now renders the weekly PrepBoard (2-col planner).
// PrepList kept imported for easy one-line revert; its ops/prepList_ data is
// untouched.
const PrepBoard          = lazy(() => import('./PrepBoard'));
const SauceLog           = lazy(() => import('./SauceLog'));
// SauceLogBohBanner stays eager — it's small (128 lines) and renders
// inline as a banner above the Tasks list, not behind a sub-tab.
import SauceLogBohBanner from './SauceLogBohBanner';
// CartPlanView — focused vendor-assignment workflow inside the cart
// modal. Eager (small file, opened only when Plan is tapped but
// shouldn't show a loading flash when the manager hits the button
// mid-ordering).
import CartPlanView from './CartPlanView';
import { toast, undoToast } from '../toast';
import { useAppData } from '../v2/AppDataContext';
// CSV importer — lazy so the parser doesn't bloat the Operations chunk
// for the common case where nobody clicks Import.
const VendorCsvImportModal = lazy(() => import('./VendorCsvImportModal'));
// Assign Tasks sub-tab — manager-side task assignment with a growing,
// searchable library of past tasks. Lazy because most ops sessions are
// inventory / checklist work; only managers using the Assign view pull
// in this chunk.
const AssignTasksPanel = lazy(() => import('./AssignTasksPanel'));
// Wall Tasks admin sub-tab — edits the short list shown on the
// kitchen wall tablet (TaskDisplay rendered at ?display=walltasks).
// Lazy: only managers using the wall pull in this chunk.
const WallTasksAdmin = lazy(() => import('./WallTasksAdmin'));
// 2026-05-24 — per-task assignee picker (bottom sheet, multi-select).
// Lazy so the modal chunk doesn't enter the graph unless admin opens
// it; the modal is admin/manager-only.
const AssigneePickerModal = lazy(() => import('./AssigneePickerModal'));
import ModalPortal from './ModalPortal';

// Constants
// Time-period concept (morning/afternoon/night) was tried and abandoned — only
// "all" remains. We keep the single-period TIME_PERIODS array so the data
// shape stays compatible (customTasks[side]["all"]) and the foreach loops
// that walk it stay correct. Hoisted out of the component so React doesn't
// re-allocate them on every render.
const TIME_PERIODS = [{ id: "all", nameEn: "All Tasks", nameEs: "Todas las Tareas" }];
const PERIOD_KEY = "all"; // the only period that ever exists
const DEFAULT_CHECKLIST_TASKS = { FOH: { all: [] }, BOH: { all: [] } };
const DEFAULT_LISTS = { FOH: [{ id: "FOH_0", assignee: "" }], BOH: [{ id: "BOH_0", assignee: "" }] };
const FOH_ROLES_LIST = ["FOH", "Manager", "Owner", "Shift Lead", "Marketing"];
const CHECKLIST_VERSION = 2;
const BUSINESS_TZ = "America/Chicago";

// Task categories — restaurant-specific. Each task gets one. Drives:
//   - color border / chip on each task card
//   - filter chips at the top of the task list
//   - audit grouping in history (Phase 2)
// Order matters — it's the display order in the filter row.
const TASK_CATEGORIES = [
    { id: "cleaning",   emoji: "🧽", labelEn: "Cleaning",      labelEs: "Limpieza",          color: "bg-blue-100 text-blue-800 border-blue-300" },
    { id: "foodsafety", emoji: "🛡️", labelEn: "Food Safety",   labelEs: "Seguridad",         color: "bg-red-100 text-red-800 border-red-300" },
    { id: "cash",       emoji: "💵", labelEn: "Cash",           labelEs: "Efectivo",          color: "bg-green-100 text-green-800 border-green-300" },
    { id: "inventory",  emoji: "📦", labelEn: "Inventory",      labelEs: "Inventario",        color: "bg-purple-100 text-purple-800 border-purple-300" },
    { id: "prep",       emoji: "🔪", labelEn: "Prep",           labelEs: "Preparación",       color: "bg-amber-100 text-amber-800 border-amber-300" },
    { id: "drinks",     emoji: "🧋", labelEn: "Drinks/Bar",     labelEs: "Bebidas/Bar",       color: "bg-pink-100 text-pink-800 border-pink-300" },
    { id: "other",      emoji: "📋", labelEn: "Other",          labelEs: "Otro",              color: "bg-gray-100 text-gray-700 border-gray-300" },
];
const TASK_CATEGORY_BY_ID = Object.fromEntries(TASK_CATEGORIES.map(c => [c.id, c]));
const getCategoryFor = (task) => TASK_CATEGORY_BY_ID[task?.category] || TASK_CATEGORY_BY_ID.other;

// Day-of-week ANCHORED TO CHICAGO (BUSINESS_TZ), not the device's local zone.
// Without this, a phone in HKT after Chicago-Sunday-11pm shows Monday's tasks
// to a user whose business day is still Sunday.
const _dowFmtChicago = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TZ, weekday: "short" });
const _DOW_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const getBusinessDow = (d = new Date()) => _DOW_MAP[_dowFmtChicago.format(d)] ?? d.getDay();

// Recurrence options for tasks. Tasks with a recurrence pattern only show on
// matching days. Default "daily" (or unset = daily) means show every day.
// Matchers receive a Date and use the Chicago day-of-week.
const TASK_RECURRENCE = [
    { id: "daily",     labelEn: "Every day",       labelEs: "Cada día",         match: () => true },
    { id: "weekday",   labelEn: "Weekdays",        labelEs: "Lunes-Viernes",    match: (d) => { const w = getBusinessDow(d); return w >= 1 && w <= 5; } },
    { id: "weekend",   labelEn: "Weekends",        labelEs: "Fines de semana",  match: (d) => { const w = getBusinessDow(d); return w === 0 || w === 6; } },
    { id: "monday",    labelEn: "Mondays",         labelEs: "Lunes",            match: (d) => getBusinessDow(d) === 1 },
    { id: "tuesday",   labelEn: "Tuesdays",        labelEs: "Martes",           match: (d) => getBusinessDow(d) === 2 },
    { id: "wednesday", labelEn: "Wednesdays",      labelEs: "Miércoles",        match: (d) => getBusinessDow(d) === 3 },
    { id: "thursday",  labelEn: "Thursdays",       labelEs: "Jueves",           match: (d) => getBusinessDow(d) === 4 },
    { id: "friday",    labelEn: "Fridays",         labelEs: "Viernes",          match: (d) => getBusinessDow(d) === 5 },
    { id: "saturday",  labelEn: "Saturdays",       labelEs: "Sábados",          match: (d) => getBusinessDow(d) === 6 },
    { id: "sunday",    labelEn: "Sundays",         labelEs: "Domingos",         match: (d) => getBusinessDow(d) === 0 },
];
const TASK_RECURRENCE_BY_ID = Object.fromEntries(TASK_RECURRENCE.map(r => [r.id, r]));
const taskShowsToday = (task, date = new Date()) => {
    const r = task.recurrence || "daily";
    const rule = TASK_RECURRENCE_BY_ID[r] || TASK_RECURRENCE_BY_ID.daily;
    return rule.match(date);
};

// Current Chicago wall-clock minutes-since-midnight. Used by overdue/urgency
// checks so a "2:30 PM" deadline triggers correctly regardless of the device's
// local zone or DST state.
const _chiTimeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ, hour12: false, hour: "2-digit", minute: "2-digit",
});
const getBusinessMinutesNow = (now = new Date()) => {
    let hh = 0, mm = 0;
    for (const p of _chiTimeFmt.formatToParts(now)) {
        if (p.type === "hour") hh = Number(p.value);
        if (p.type === "minute") mm = Number(p.value);
    }
    return (hh % 24) * 60 + mm;
};
const isPastTimeOfDay = (completeBy, now = new Date()) => {
    if (!completeBy) return false;
    const [hh, mm] = completeBy.split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
    return getBusinessMinutesNow(now) > (hh * 60 + mm);
};

// Skip-with-reason options. Picker (not free text) so we can analyze later.
const SKIP_REASONS = [
    { id: "out_of_stock",     emoji: "🚫", labelEn: "Out of stock",       labelEs: "Sin existencia" },
    { id: "equipment_broken", emoji: "🔧", labelEn: "Equipment broken",   labelEs: "Equipo dañado" },
    { id: "no_time",          emoji: "⏰", labelEn: "Ran out of time",    labelEs: "Sin tiempo" },
    { id: "not_needed",       emoji: "✋", labelEn: "Not needed today",   labelEs: "No se necesita hoy" },
    { id: "other",            emoji: "❓", labelEn: "Other (note)",       labelEs: "Otro (nota)" },
];
const SKIP_REASON_BY_ID = Object.fromEntries(SKIP_REASONS.map(r => [r.id, r]));

// ── Vendor → inventory match seed data ───────────────────────────────────────
// These were originally hardcoded inside the component (SYSCO_OVERRIDES,
// SYSCO_ITEM_CATEGORIES). They now seed Firestore on first run; after that the
// authoritative source is config/vendor_matches and config/vendor_categories.
// The Match Audit UI in the Pricing tab edits those Firestore docs live.
const HARDCODED_SYSCO_MATCH_SEED = {
    "5106402": "0-26", "7952468": "0-27", "7411241": "0-28",
    "7950306": "0-25", "2398519": "0-32", "7350788": "1-19",
    "7078475": "1-12", "1008010": "1-5", "1491810": "1-4",
    "1821529": "1-21", "4390807": "9-9", "0937631": "9-2",
    "4671434": "4-12", "7257721": "3-54", "7011275": "3-54",
    "7385215": "7-4", "6977799": "7-65", "2102038": "7-54",
    "9904133": "7-74", "9903882": "7-74", "9904135": "7-74",
    "9904127": "7-74", "9904138": "7-74", "0616526": "8-3",
    "7670021": "8-4", "7260143": "8-1", "9901417": "8-2",
    "5287489": "8-12", "5256670": "8-18", "8265625": "8-5",
    "5061239": "8-13", "4278760": "8-8",
};
const HARDCODED_SYSCO_CATEGORY_SEED = {
    // Proteins & Seafood
    "6034780": "Proteins & Seafood", "7246665": "Proteins & Seafood",
    "2398519": "Proteins & Seafood", "5636997": "Proteins & Seafood",
    "7411241": "Proteins & Seafood", "5351494": "Proteins & Seafood",
    // Produce
    "5818259": "Produce", "1675859": "Produce", "1491810": "Produce",
    "1008010": "Produce", "7078475": "Produce", "5179760": "Produce",
    "5430934": "Produce", "1908318": "Produce", "5852689": "Produce",
    "7759566": "Produce", "5893973": "Produce", "4678555": "Produce",
    "7350788": "Produce", "5131753": "Produce", "1821529": "Produce",
    // Dairy & Eggs
    "4906361": "Dairy & Eggs", "6680073": "Dairy & Eggs", "3051695": "Dairy & Eggs",
    // Beverages
    "6236614": "Beverages", "4306627": "Beverages", "7101689": "Beverages",
    // Supplies & Packaging
    "7701311": "Supplies & Packaging", "7213296": "Supplies & Packaging",
    "6155841": "Supplies & Packaging", "6138219": "Supplies & Packaging",
    "3438292": "Supplies & Packaging", "4681957": "Supplies & Packaging",
    "7385215": "Supplies & Packaging", "6669499": "Supplies & Packaging",
    "6541129": "Supplies & Packaging", "9904133": "Supplies & Packaging",
    "9903882": "Supplies & Packaging", "9904135": "Supplies & Packaging",
    "9904127": "Supplies & Packaging", "9904138": "Supplies & Packaging",
    "2102038": "Supplies & Packaging", "6855423": "Supplies & Packaging",
    "6298877": "Supplies & Packaging", "5597443": "Supplies & Packaging",
    // Cleaning & Chemicals
    "9792611": "Cleaning & Chemicals", "7260143": "Cleaning & Chemicals",
    "1293212": "Cleaning & Chemicals", "0616526": "Cleaning & Chemicals",
    "4278760": "Cleaning & Chemicals", "6350461": "Cleaning & Chemicals",
    "7670021": "Cleaning & Chemicals",
    // Sauces & Condiments
    "4136768": "Sauces & Condiments", "7257721": "Sauces & Condiments",
    "7011275": "Sauces & Condiments", "4485085": "Sauces & Condiments",
    // Other Food
    "0937631": "Other Food", "4390807": "Other Food",
};

// Business-day date key (YYYY-MM-DD) anchored to America/Chicago, not the device's local zone.
// All checklists, history docs, and break plans key off the business day, so a staff phone
// in a different zone (or a UTC server) would otherwise roll over at the wrong wall-clock time
// and could overwrite the prior day's history doc.
const _todayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const getTodayKey = (d = new Date()) => _todayKeyFmt.format(d); // en-CA emits YYYY-MM-DD
const addDaysKey = (key, n) => {
    // key is YYYY-MM-DD; anchor at noon UTC to avoid DST/zone edges, then add n days.
    const [y, m, day] = key.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, day, 12, 0, 0));
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
};

// Inventory search matcher. Narrow on purpose: only the English + Spanish item name.
// Wider fields (vendor, brand, subcat, pack, IDs) cause flood matches — e.g. typing "garlic"
// would surface every item in a "Garlic & Onions" subcategory, or every item from a vendor
// whose name happens to contain the query. The vendor/pricing tabs already group by those
// dimensions, so users who want vendor- or brand-scoped browsing use those tabs.
const itemMatchesSearch = (item, searchLower) => {
    if (!searchLower) return true;
    if (item.name && String(item.name).toLowerCase().includes(searchLower)) return true;
    if (item.nameEs && String(item.nameEs).toLowerCase().includes(searchLower)) return true;
    return false;
};

// Vendor-color helper — pure, module-scope so it can be passed
// into React.memo'd children without breaking shallow-equality
// (function identity stays stable for the lifetime of the bundle).
function vendorColorFor(v) {
    return v === "Sysco" ? "blue" : v === "US Foods" ? "orange" : "gray";
}

// InventoryCountInput — quantity input that commits on blur / Enter
// instead of on every keystroke. Andrew 2026-05-30 audit fix.
//
// Why: the previous in-place input fired updateInventoryCount (which
// wraps a Firestore runTransaction + an audit-log addDoc) on every
// keystroke. Typing "100" produced THREE transactions back-to-back,
// each retrying on conflict if another phone touched the same item.
// Under heavy use this serialized into noticeable lag.
//
// Now: local typed value while the field is focused, single commit
// when the staffer tabs away / presses Enter / taps elsewhere. If
// nothing actually changed (typed same number that was already there)
// we no-op so we don't churn the audit log either. The +/- buttons
// still call updateInventoryCount directly — those are intentional
// single-tap commits.
const InventoryCountInput = memo(function InventoryCountInput({ value, onCommit, language, className }) {
    const [local, setLocal] = useState(String(value || 0));
    const [editing, setEditing] = useState(false);
    // `dirty` = the user actually TYPED in this field (vs merely focused/tapped into
    // it). 2026-06-30 data-loss fix: previously the field latched `editing` on FOCUS
    // and only re-synced from `value` on blur. So if you tapped into the field, then
    // tapped the +/- buttons (which bump `value`), the field kept showing the OLD
    // number — and on blur it wrote that stale number back as an ABSOLUTE count,
    // silently erasing every increment. Now: a bare focus is NOT dirty, so external
    // +/- value changes still flow into the display, and blur only commits if the
    // user actually typed. A focus-then-button-then-blur (no typing) is a no-op.
    const [dirty, setDirty] = useState(false);
    // Mirror the external value into the input unless the user is mid-TYPE (dirty),
    // so a sync from Firestore / a +/- tap updates the display without snapping a
    // half-typed entry back.
    useEffect(() => {
        if (!editing || !dirty) setLocal(String(value || 0));
    }, [value, editing, dirty]);
    const commit = (raw) => {
        const n = parseInt(raw || '0', 10);
        const safe = Number.isFinite(n) && n >= 0 ? n : 0;
        if (safe !== (Number.isFinite(value) ? value : 0)) {
            onCommit(safe);
        }
    };
    // 2026-06-20 (QA audit O6) — flush a half-typed count on unmount. The input
    // commits only on blur/Enter; on touch devices, navigating away (bottom-nav
    // tap, app background, idle relock) unmounts the field before a clean blur,
    // silently losing a typed bulk entry like "48". Only flush an ACTUALLY-TYPED
    // (dirty) value so an un-typed focus can't clobber a +/- on unmount.
    const flushRef = useRef({ dirty: false, local: '', commit });
    flushRef.current = { dirty, local, commit };
    useEffect(() => () => {
        const f = flushRef.current;
        if (f.dirty) f.commit(f.local);
    }, []);
    const numericLocal = parseInt(local || '0', 10) || 0;
    return (
        <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={local}
            onChange={(e) => {
                setEditing(true);
                setDirty(true);
                const raw = e.target.value.replace(/[^0-9]/g, '');
                setLocal(raw);
            }}
            onFocus={(e) => {
                setEditing(true);  // focused, but NOT dirty — a bare focus must never commit
                e.target.select();
            }}
            onBlur={(e) => {
                setEditing(false);
                if (dirty) commit(e.target.value);
                setDirty(false);
            }}
            onKeyDown={(e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.currentTarget.blur();
                }
            }}
            aria-label={language === "es" ? "Cantidad" : "Quantity"}
            className={className || `w-12 h-9 text-center font-bold text-lg rounded-lg border-2 ${numericLocal > 0 ? "text-green-700 border-green-200 bg-white" : "text-gray-300 border-gray-200 bg-white"} focus:border-mint-700 focus:outline-none tabular-nums`}
        />
    );
});

// CartRow — one `<tr>` of the cart comparison table. Memoized so
// typing a count, toggling a vendor override, or any unrelated
// Operations re-render does NOT re-render the other 199 rows.
//
// Andrew 2026-05-29 perf batch D #2. The cart's comparison table
// can hold 200+ items × 8 vendor columns = 1600+ cells. Before
// memoization, ANY parent re-render reconciled every cell.
//
// Props are all stable primitives or stable references:
//   r            — row object identity is stable because cartData
//                  is memoized at the parent (same array, same
//                  object refs across unrelated re-renders).
//   vendorList   — stable for the same reason.
//   myEffVendor  — string or empty string; only changes for THIS
//                  row when this row's override changes.
//   isOverridden — boolean; same story.
// React.memo's default shallow compare is sufficient.
const CartRow = memo(function CartRow({ r, vendorList, myEffVendor, isOverridden, itemPrices, isEn }) {
    const cheapestVendor = r.vendorPrices.find(p => p.price != null)?.vendor;
    const isVendorOnly = r.kind === "vendor-only";
    // Trusted "where's it cheapest + last ordered" from the new item_prices
    // engine (manual / receipt), independent of the scraped vendor columns.
    const tp = (itemPrices && r.id) ? itemPrices[r.id] : null;
    const tCheap = tp ? pickCheapestVendor(tp) : null;
    const tLast = tp ? pickLastOrdered(tp) : null;
    const tQty = tp ? pickOrderQty(tp) : null;
    const fmtQty = (n) => (n == null ? '' : (Number.isInteger(n) ? String(n) : n.toFixed(1)));
    return (
        <tr
            className={`border-t border-gray-300 transition ${
                isVendorOnly ? "bg-orange-50/40" : "hover:bg-gray-50"
            }`}
            style={isOverridden ? { boxShadow: 'inset 3px 0 0 0 #b45309' } : undefined}
        >
            <td className="px-3 py-2">
                <div className="font-medium text-gray-800 flex items-center gap-1 flex-wrap">
                    {isVendorOnly && (
                        <span className={`text-[9px] font-bold px-1 py-0.5 rounded border bg-${vendorColorFor(r.vendorOnlyOrigin)}-100 text-${vendorColorFor(r.vendorOnlyOrigin)}-700 border-${vendorColorFor(r.vendorOnlyOrigin)}-300`}>
                            {r.vendorOnlyOrigin}
                        </span>
                    )}
                    {r.addedFromVendor && (
                        <span className={`w-1.5 h-1.5 rounded-full bg-${vendorColorFor(r.addedFromVendor)}-500`} title={`Added from ${r.addedFromVendor}`} />
                    )}
                    <span>{r.name}</span>
                    {myEffVendor && (
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                            isOverridden
                                ? 'bg-amber-100 text-amber-700 border border-amber-300'
                                : 'bg-gray-100 text-gray-500 border border-gray-200'
                        }`}>
                            {isOverridden ? '📌 ' : ''}{myEffVendor}
                        </span>
                    )}
                </div>
                <div className="text-[10px] text-gray-400">{r.category}{r.pack ? ` · ${r.pack}` : ""}</div>
                {(tCheap || tLast || tQty) && (
                    <div className="mt-0.5 flex flex-col gap-0.5 text-[10px] leading-tight">
                        {tCheap && tCheap.vendor && (
                            <span className="text-emerald-700 font-semibold">
                                🏆 {isEn ? 'Best' : 'Mejor'}: ${tCheap.perUnit != null ? `${tCheap.perUnit.toFixed(2)}/${tCheap.unit}` : Number(tCheap.price).toFixed(2)} · {tCheap.vendor}
                            </span>
                        )}
                        {tLast && (
                            <span className="text-gray-500">
                                ↩ {isEn ? 'Last' : 'Última'}: ${Number(tLast.price).toFixed(2)} · {tLast.vendor}{tLast.at ? ` (${String(tLast.at).slice(0, 10)})` : ''}
                            </span>
                        )}
                        {tQty && (
                            <span className="text-amber-700">
                                📦 {isEn ? 'Order qty' : 'Cantidad'}: {isEn ? 'last' : 'última'} {fmtQty(tQty.lastQty)}{tQty.count > 1 ? ` · ${isEn ? 'avg' : 'prom'} ${fmtQty(tQty.avgQty)}` : ''}
                            </span>
                        )}
                    </div>
                )}
            </td>
            <td className="text-center px-2 py-2 font-bold text-mint-700">{r.qty}</td>
            {vendorList.map(v => {
                const p = r.vendorPrices.find(vp => vp.vendor === v);
                if (!p || p.price == null) return <td key={v} className="text-right px-2 py-2 text-gray-300 text-xs">—</td>;
                const isCheapest = v === cheapestVendor && r.vendorPrices.filter(vp => vp.price != null).length > 1;
                const lineTotal = r.qty * p.price;
                return (
                    <td key={v} className={`text-right px-2 py-2 ${isCheapest ? "bg-green-50" : ""}`}>
                        <div className={`text-sm ${isCheapest ? "font-bold text-green-700" : "text-gray-700"}`}>
                            {isCheapest && "🏆 "}${p.price.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-gray-500">= ${lineTotal.toFixed(2)}{p.pack ? ` · ${p.pack}` : ""}</div>
                    </td>
                );
            })}
        </tr>
    );
});

// LocationItemRow — one row of the Location view's count list. Memoized so
// changing the count on one item only repaints THAT row instead of all 300.
//
// Andrew 2026-05-29 perf batch D continuation. The Location view flattens
// every counted item across categories into one big list (potentially
// 300+ rows). Without memoization, every quantity tweak rerendered the
// entire list. The handler `onUpdate` MUST be stable (parent should pass
// the parent's updateInventoryCount directly — it's already a closure-
// bound method that's stable across renders within Operations).
//
// Props are all stable primitives or stable references:
//   id       — string, stable per item
//   name     — string
//   catName  — string (the originating category, shown as a tiny badge)
//   subcat   — string
//   pack     — string
//   count    — number; changes when this specific row's count changes
//   language — string
//   onUpdate — function ref (parent's updateInventoryCount)
const LocationItemRow = memo(function LocationItemRow({
    id, name, catName, subcat, pack, count, language, onUpdate,
}) {
    return (
        <div className={`flex items-center justify-between gap-2 px-3 py-2 ${count > 0 ? 'bg-green-50/50' : ''}`}>
            <div className="flex-1 min-w-0 pr-2">
                <p className={`text-sm font-semibold truncate ${count > 0 ? 'text-green-800' : 'text-gray-800'}`}>
                    {name}
                </p>
                <div className="text-[10px] text-gray-400 truncate">
                    {catName}
                    {subcat && ` · ${subcat}`}
                    {pack && ` · ${pack}`}
                </div>
            </div>
            {/* 2026-05-30 audit fix — bumped counter buttons from 36px (w-9 h-9)
                to 44px (w-11 h-11) to hit Apple HIG minimum tap target, and
                widened the gap so an oily-finger rush count doesn't mis-tap
                +/-. Input grew proportionally (w-14 h-11). */}
            <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={() => onUpdate(id, Math.max(0, count - 1), -1)}
                    className={`w-11 h-11 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? 'bg-red-100 text-red-700 hover:bg-red-200' : 'bg-gray-100 text-gray-400'}`}>{"\u{2212}"}</button>
                {/* 2026-06-13 perf — was a raw onChange input that wrote to
                    Firestore on EVERY keystroke (typing "100" = 3 audit docs +
                    3 inventory updates). The location view is the DEFAULT
                    counting view, so this was the heaviest write path. Now uses
                    the same commit-on-blur InventoryCountInput the category
                    view already uses: one write per finished entry. The +/-
                    buttons still write per tap (single write each, fine). */}
                <InventoryCountInput
                    value={count}
                    onCommit={(n) => onUpdate(id, n)}
                    language={language}
                    className="w-14 h-11 text-center text-base font-bold rounded-lg border-2 border-gray-200 bg-white text-gray-800 focus:border-mint-500 focus:outline-none tabular-nums" />
                <button onClick={() => onUpdate(id, count + 1, 1)}
                    className="w-11 h-11 rounded-lg bg-mint-100 text-mint-700 hover:bg-mint-200 font-bold text-lg flex items-center justify-center transition">{"+"}</button>
            </div>
        </div>
    );
});

export default function Operations({ language, staffList, staffName, storeLocation }) {

            // (Removed 2026-05-09) passwordEntered / password / handlePasswordSubmit
            // — leftover from the shared-password Operations gate. Replaced by the
            // hasOpsAccess opt-in toggle (admin or per-staff opsAccess === true).
            // Nothing references these any more; commit history preserves them.
            const [inventory, setInventory] = useState({});
            const [invCountMeta, setInvCountMeta] = useState({}); // { itemId: { by, at } }
            // "Last ordered" per item — computed from inventoryHistory_{loc}.
            // For each item, finds the most recent saved snapshot where the
            // item had a count > 0. That date + qty is the "last time you
            // ordered this item." Stable until the next snapshot is saved.
            //
            // Andrew's mental model (2026-05-16): the inventory list IS the
            // order list. Counts entered = quantities being ordered. The
            // badge surfaces what was put on last week's list so this week
            // they have a reference point.
            //
            // Map shape: { itemId: { date: 'Mon May 12', qty: 3, dateIso: '2026-05-12T...' } }
            const [lastEnteredByItem, setLastEnteredByItem] = useState({});
            // Suggested order qty per item — average of the last N
            // non-zero qty entries from inventoryHistory snapshots,
            // computed inside the same walk as lastEnteredByItem.
            // Audit follow-up 2026-05-23: managers were guessing how
            // much to order each cycle. A historical average gives
            // them a baseline. Shape: { [itemId]: { avg, n } } where
            // n is how many data points contributed (we hide the
            // hint when n < 2 to avoid suggesting "12" from a
            // single one-off order).
            const [suggestedByItem, setSuggestedByItem] = useState({});
            // Per-vendor latest import timestamp — populated from the
            // same inventoryHistory walk as lastEnteredByItem. Keyed by
            // the vendor slug the CSV / PDF importer stamps onto each
            // snapshot (importedFrom: 'sysco' | 'usfoods' | 'costco' |
            // 'other'). Drives the "Prices freshness" banner at the
            // top of the Pricing view so admin can see at a glance
            // which vendor data is current vs stale per location.
            //
            // Shape: { sysco: { dateIso, dateLabel, fileName }, ... }
            // DC-2, 2026-05-30: removed lastVendorImport state — was set
            // once (per-vendor CSV import time) but never read anywhere.
            // The "last imported" label rendering it powered was removed
            // in an earlier refactor; the setter was left behind.
            // CSV-import modal — replaces the broken Sysco/USF live scraper
            // for any week where the scraper is down. Admin exports the
            // order guide from the vendor portal (one click) and uploads
            // here. Parser writes the rows as a new inventoryHistory
            // snapshot so the "Last ordered" badge updates downstream.
            const [showCsvImport, setShowCsvImport] = useState(false);
            // Counts for vendor-only items that aren't matched to a master inventory item.
            // Keyed as `${vendor}:${vendorId}` (e.g. "sysco:5106402") so it can't collide with
            // master inventory ids. Stored under inventory_<location>.vendorCounts in Firestore.
            const [vendorCounts, setVendorCounts] = useState({});
            const [activeTab, setActiveTab] = useState("checklist");
            // DC-2, 2026-05-30: removed lastUpdated state — set 4× from
            // snapshot handlers but never rendered (the "last updated X"
            // ribbon was removed in an earlier UI cleanup). Setter calls
            // below are dropped too.
            const [editMode, setEditMode] = useState(false);
            const [editingIdx, setEditingIdx] = useState(null);
            // Per-task messaging composer state. When non-null = open for that
            // task ID. Holds text + delivery mode the admin is composing.
            const [openMsgTask, setOpenMsgTask] = useState(null);
            const [msgDraft, setMsgDraft] = useState("");
            const [msgDeliverWhen, setMsgDeliverWhen] = useState("now"); // 'now' | 'on_complete'
            const [editTask, setEditTask] = useState("");
            const [editCategory, setEditCategory] = useState("other");
            const [editRecurrence, setEditRecurrence] = useState("daily");
            const [editRequirePhoto, setEditRequirePhoto] = useState(false);
            const [editSubtasks, setEditSubtasks] = useState([]);
            const [editCompleteBy, setEditCompleteBy] = useState("");
            const [editAssignTo, setEditAssignTo] = useState("");
            // 2026-05-24 — AssigneePickerModal state. Holds the index of
            // the task whose picker is currently open (null = closed).
            // Decoupled from edit mode so admin can assign without
            // having to enter the multi-step edit form.
            const [assigningTaskIdx, setAssigningTaskIdx] = useState(null);
            const [editFollowUp, setEditFollowUp] = useState(null); // { type: "dropdown"|"text", question: "", options: [] }
            const [showAddForm, setShowAddForm] = useState(false);
            const [newTask, setNewTask] = useState("");
            const [newCategory, setNewCategory] = useState("other");
            const [newRecurrence, setNewRecurrence] = useState("daily");
            const [newRequirePhoto, setNewRequirePhoto] = useState(false);
            // Category filter for the task list view (also used by quick-add to default the new task's category)
            const [categoryFilter, setCategoryFilter] = useState("all");
            // DC-2, 2026-05-30: removed skipPickerFor state — set once
            // to null after the modal closed but never read; the modal
            // it gated was migrated to a different pattern.
            // Quick-add inline input state (single field on top of task list)
            const [quickAddText, setQuickAddText] = useState("");
            // Per-task comments — which task's thread is open + draft text
            const [openCommentTask, setOpenCommentTask] = useState(null);
            const [commentDraft, setCommentDraft] = useState("");
            const [newSubtasks, setNewSubtasks] = useState([]);
            const [newCompleteBy, setNewCompleteBy] = useState("");
            const [newAssignTo, setNewAssignTo] = useState("");
            const [newFollowUp, setNewFollowUp] = useState(null); // { type: "dropdown"|"text", question: "", options: [] }
            // Follow-up answers state (keyed by task id)
            const [followUpAnswers, setFollowUpAnswers] = useState({});
            const [showFollowUpFor, setShowFollowUpFor] = useState(null); // task id to show follow-up prompt
            const [capturingPhoto, setCapturingPhoto] = useState(null); // task id being photographed
            // Re-entry guard for the actual upload (not the file-picker open).
            // Using a ref because state updates are async — the previous
            // setCapturingPhoto-in-button-onClick approach made `capturingPhoto`
            // ALWAYS truthy by the time the input's onChange fired, so the
            // "if (capturingPhoto) return" guard inside handlePhotoCapture
            // early-returned and the upload never ran. A ref bypasses that
            // race because we set + check it synchronously.
            const photoUploadInProgressRef = useRef(false);

            // Determine current user's role early
            const currentIsAdmin = isAdmin(staffName, staffList);
            // Manager check (mirrors App.jsx's isManager): admin or
            // role text contains "manager". Used to gate the new
            // "Mgr Tasks" sub-tab so only managers see the manager-
            // filtered kanban — Andrew 2026-05-28: "the current tasks
            // in the task tab is just for managers."
            const currentStaffRecord_op = (staffList || []).find(s => s.name === staffName);
            const currentIsManagerOp = currentIsAdmin
                || /manager/i.test(String(currentStaffRecord_op?.role || ''));

            // New checklist system {"\u{2014}"} FOH/BOH with multiple lists per side.
            //
            // 2026-05-24 — Andrew: "everyone except admin should auto-route
            // to their own side." We now prefer the EXPLICIT scheduleSide
            // field set in AdminPanel ('foh' / 'boh' / 'both') over the
            // legacy role-based inference. Falls back to role inference
            // when scheduleSide is missing (legacy records pre-flag).
            // Tab strip below is hidden for single-side non-admin viewers
            // (showSideTabs gate).
            const staffRole = (staffList || []).find(s => s.name === staffName);
            const staffIsFOH = staffRole ? ["FOH", "Manager", "Owner", "Shift Lead"].includes(staffRole.role) : true;
            const explicitSide = staffRole?.scheduleSide;                         // 'foh' | 'boh' | 'both' | undefined
            const viewerIsBothSide = explicitSide === 'both';
            const viewerHasFixedSide = explicitSide === 'foh' || explicitSide === 'boh';
            const staffSide = viewerHasFixedSide
                ? explicitSide.toUpperCase()                                      // 'FOH' | 'BOH'
                : (staffIsFOH ? "FOH" : "BOH");
            const showSideTabs = currentIsAdmin || viewerIsBothSide;
            const [checklistSide, setChecklistSide] = useState(staffSide);
            // Sauce-requests banner collapsed state (BOH only). Andrew
            // 2026-05-28: "lets also make the sauces window
            // collapsible." Default open; the toggle persists per
            // device.
            const [sauceCollapsed, setSauceCollapsed] = useState(() => {
                try { return localStorage.getItem('ddmau:tasks:sauceCollapsed') === '1'; }
                catch { return false; }
            });
            useEffect(() => {
                try { localStorage.setItem('ddmau:tasks:sauceCollapsed', sauceCollapsed ? '1' : '0'); }
                catch {}
            }, [sauceCollapsed]);
            // Sauce-counts ticker — Andrew 2026-05-28: "since the sauce
            // bar is collapsible have a little ticker or counter for
            // urgent and tomorrow." Subscribes to the same doc the
            // SauceLogBohBanner uses so we can show pending counts in
            // the collapsed header. Cheap doc-level read; runs only
            // when BOH side is shown (gated below before mount).
            const [sauceCounts, setSauceCounts] = useState({ today: 0, tomorrow: 0, later: 0, total: 0 });
            useEffect(() => {
                if (checklistSide !== 'BOH') {
                    setSauceCounts({ today: 0, tomorrow: 0, later: 0, total: 0 });
                    return;
                }
                let alive = true;
                const unsub = onSnapshot(doc(db, 'ops', 'sauceLog_' + storeLocation), (snap) => {
                    if (!alive) return;
                    if (!snap.exists()) {
                        setSauceCounts({ today: 0, tomorrow: 0, later: 0, total: 0 });
                        return;
                    }
                    const d = snap.data() || {};
                    const sauceIds = new Set((d.sauces || []).map(s => s.id));
                    const reqs = Object.entries(d.requests || {})
                        .filter(([id, r]) => r && r.status === 'pending' && sauceIds.has(id));
                    let today = 0, tomorrow = 0, later = 0;
                    for (const [, r] of reqs) {
                        if (r.urgency === 'today') today++;
                        else if (r.urgency === 'tomorrow') tomorrow++;
                        else later++;
                    }
                    setSauceCounts({ today, tomorrow, later, total: reqs.length });
                }, (e) => console.warn('sauce counts subscribe:', e));
                return () => { alive = false; unsub(); };
            }, [checklistSide, storeLocation]);
            // (Removed 2026-05-09) PERIOD_KEY state — was always "all", setter
            // was never called. Direct usages below replaced with PERIOD_KEY.
            const [checks, setChecksRaw] = useState({});
            const checksRef = useRef(checks);
            const setChecks = (val) => { checksRef.current = val; setChecksRaw(val); };
            const [customTasks, setCustomTasksRaw] = useState(JSON.parse(JSON.stringify(DEFAULT_CHECKLIST_TASKS)));
            const customTasksRef = useRef(customTasks);
            const setCustomTasks = (val) => { customTasksRef.current = val; setCustomTasksRaw(val); };
            const [checklistDate, setChecklistDateRaw] = useState("");
            const checklistDateRef = useRef("");
            const setChecklistDate = (val) => { checklistDateRef.current = val; setChecklistDateRaw(val); };
            // Assignments: { "FOH_morning": "Emma Liliana", "BOH_afternoon": "Jose Mendoza", ... }
            const [checklistAssignments, setChecklistAssignmentsRaw] = useState({});
            const checklistAssignmentsRef = useRef({});
            const setChecklistAssignments = (val) => { checklistAssignmentsRef.current = val; setChecklistAssignmentsRaw(val); };
            // Multi-list: { FOH: [{id:"FOH_0", assignee:""}], BOH: [{id:"BOH_0", assignee:""}] }
            // DEFAULT_LISTS now lives at module scope (top of file) to avoid
            // re-allocating the literal on every render.
            const [checklistLists, setChecklistListsRaw] = useState(DEFAULT_LISTS);
            const checklistListsRef = useRef(checklistLists);
            const setChecklistLists = (val) => { checklistListsRef.current = val; setChecklistListsRaw(val); };
            const [activeListIdx, setActiveListIdx] = useState(0);
            // Staff filter for master task list view (admin picks a name, or "" for all)
            const [taskFilter, setTaskFilter] = useState("");
            // Helper: get prefix for check keys based on list index (list 0 has no prefix for backward compat)
            const getCheckPrefix = (side, listIdx) => listIdx === 0 ? "" : side + "_L" + listIdx + "_";
            const currentPrefix = getCheckPrefix(checklistSide, activeListIdx);
            const [invEditMode, setInvEditMode] = useState(false);
            const [invEditingIdx, setInvEditingIdx] = useState(null);
            const [invEditName, setInvEditName] = useState("");
            const [invEditNameEs, setInvEditNameEs] = useState("");
            const [invEditSupplier, setInvEditSupplier] = useState("");
            const [invEditOrderDay, setInvEditOrderDay] = useState("Fri");
            // Per-item low-stock threshold — when set, the inventory grid
            // flags this item in red when the live count drops to or below
            // it. Audit follow-up 2026-05-23: managers were running out of
            // staples mid-shift because the order list only flagged items
            // already at zero. Setting a min of 2 on a key item surfaces
            // "we're getting low" BEFORE the kitchen actually runs out.
            // Stored as a number; null/empty means "no threshold set".
            const [invEditMin, setInvEditMin] = useState("");
            // 2026-05-29 — Andrew: "when we did a category audit a while
            // back to put items in locations. i dont see the toggle to
            // move the items to the locations". Edit form already had
            // category + subcat pickers but never carried the storage-
            // location field through — the location-mapper script set
            // it server-side once, but staff had no way to fix mistakes
            // in-app. This state + the picker added in the edit JSX
            // restore in-app editability.
            const [invEditLocation, setInvEditLocation] = useState("");
            // 2026-05-17 — let edit form recategorize an item. invEditTargetCatIdx
            // is the destination category index (move cross-category) and
            // invEditSubcat is the subcategory within that destination. Both
            // pre-populated from the item's current placement when the Edit
            // form opens. Andrew: "the edit is able to re categorize items".
            const [invEditTargetCatIdx, setInvEditTargetCatIdx] = useState(null);
            const [invEditSubcat, setInvEditSubcat] = useState("");
            // 2026-05-17 — "move mode" for fast recategorization. The
            // Edit form (above) is precise but slow when you have a
            // bunch of items to relocate. Tap the 🔀 button on an item
            // → enters move mode (movingItem = { id, name, fromCatIdx,
            // fromSubcat }) → every subcategory header on the page
            // becomes a tap-target → tap one to drop the item there.
            // Tap Cancel or 🔀 again to exit. Andrew: "maybe make it
            // a drag to move between sub categorys".
            const [movingItem, setMovingItem] = useState(null);
            // 2026-05-17 — inventory density toggle. Compact mode hides
            // the metadata row (alternate-language name, vendor, pack,
            // price, Edit/Move buttons, Last-ordered badge) so the
            // master list is just NAME + QUANTITY. Faster scanning
            // during count nights. Detailed mode = the original rich
            // layout. Persisted to localStorage so the choice survives
            // reloads. Andrew: "make a toggle that makes the master
            // list just the items name and quantity or what it looks
            // like now".
            const [invCompactView, setInvCompactView] = useState(() => {
                try { return localStorage.getItem('ddmau:invCompactView') === '1'; }
                catch { return false; }
            });
            useEffect(() => {
                try { localStorage.setItem('ddmau:invCompactView', invCompactView ? '1' : '0'); }
                catch { /* storage full or disabled */ }
            }, [invCompactView]);
            const [invShowAddForm, setInvShowAddForm] = useState(null);
            const [invNewName, setInvNewName] = useState("");
            const [invNewNameEs, setInvNewNameEs] = useState("");
            const [invNewSupplier, setInvNewSupplier] = useState("");
            const [invNewOrderDay, setInvNewOrderDay] = useState("Fri");
            const [customInventory, setCustomInventory] = useState(INVENTORY_CATEGORIES.map(c => ({...c, items: [...c.items]})));
            // Active inventory-list override. When admin has activated a
            // named list via Admin → Inventory lists, its categories
            // replace whatever the legacy customInventory merge produced.
            // null = no active list (default — fall back to master + ops
            // doc merge as before).
            const [activeList, setActiveList] = useState(null);
            // Ref mirror so the inventory-snapshot handler can check the
            // current active-list state without taking it as a dep
            // (the snapshot subscription is set up once on mount).
            const activeListRef = useRef(null);
            useEffect(() => { activeListRef.current = activeList; }, [activeList]);
            const [livePrices, setLivePrices] = useState({}); // { sysco: { prices: { itemId: { price, pack, ... } }, lastScraped } }
            // (Scraper trigger/status state removed 2026-06-15 — the Sysco/USFoods
            // scrapers were deleted, so these were write-only dead state.)
            const [pricingVendor, setPricingVendor] = useState("sysco"); // "sysco" or "usfoods"
            const [showSaveConfirm, setShowSaveConfirm] = useState(false);
            const [inventorySaving, setInventorySaving] = useState(false);
            // Per-item sync state map: { [itemId]: 'saving' | 'saved' | 'error' }.
            // Drives the small dot rendered next to each inventory item's
            // count chip so users get instant feedback that their tap
            // actually wrote to Firestore. 'saving' shows on every
            // updateInventoryCount call; 'saved' is set on Firestore
            // ack and auto-clears 2s later; 'error' is sticky until the
            // next successful save for that item. Map (not array) so
            // O(1) lookup in the render loop.
            const [inventorySyncStatus, setInventorySyncStatus] = useState({});
            // Recent inventory audits — subscribed below per location, drives
            // the "Recent changes" expander at the bottom of the inventory page.
            const [inventoryAudits, setInventoryAudits] = useState([]);
            const [showInventoryAudits, setShowInventoryAudits] = useState(false);
            const [invSearch, setInvSearch] = useState("");
            // 2026-05-29 perf: defer the search value used by the
            // expensive filter pass so typing stays buttery on the
            // 300+ item master list. The input itself reads invSearch
            // (instant feedback); the row-level filter reads
            // invSearchDeferred, which React updates at a lower
            // priority — so a keystroke never blocks paint. No
            // setTimeout / debounce machinery to maintain.
            const invSearchDeferred = useDeferredValue(invSearch);
            // AI semantic search toggle for the inventory tab. ON sends
            // queries to the aiSearch Cloud Function (~$0.001 each)
            // alongside the local substring matcher; results are
            // UNIONed. OFF falls back to substring only.
            const [invAiOn, setInvAiOn] = useState(true);
            const [writeInValues, setWriteInValues] = useState({});
            // Per-row write-in destination — { [catIdx]: { catIdx, location } }.
            // Defaults: targetCatIdx = the section the user is typing in,
            // location = '' (will prompt). Andrew 2026-05-22: "keep the
            // write in item, and once that is in we keep it on the list
            // but let it pick what category and location when writing it
            // in." Inline expansion below the write-in input lets the
            // user override both before pressing Add.
            const [writeInDest, setWriteInDest] = useState({});
            // 2026-05-31 - Andrew: "lets let the locations tab be the default
            // page to load instead of the master list. we will use that more."
            // Was "category" (master list grouped by category). Now defaults
            // to "location" (items grouped by walk-in / dry storage / etc.) -
            // matches how staff actually count during a shift.
            const [invViewMode, setInvViewMode] = useState("location"); // "category" | "location" | "vendor" | "split" | "pricing"
            // 2026-06-20 (QA audit O7) — discard any in-progress edit/move when the
            // view mode or location changes. invEditingIdx is positional
            // {catIdx,itemIdx}; after a switch those indices point at a DIFFERENT
            // item (the Vendor view also re-sorts), so a leftover edit form could
            // re-arm on — and then save onto — the wrong row. Closing the form
            // (invEditingIdx=null) is the safe behavior; opening a new edit
            // re-initializes every field, so nothing stale leaks. A movingItem is
            // also stranded across views (drop targets only exist in category view),
            // so clear it too. Runs once on mount as a harmless no-op.
            useEffect(() => {
                setInvEditingIdx(null);
                setMovingItem(null);
            }, [invViewMode, storeLocation]);
            // 2026-06-13 perf — the 7 vendor_prices listeners (sysco/usfoods/
            // costco + trigger/status docs) only feed the Pricing sub-tab,
            // which most opens never touch. Gate them behind the first time
            // Pricing is opened so a normal Operations open doesn't pay 7 doc
            // reads + 7 live listeners up front. Once opened they persist.
            const [pricingEverOpened, setPricingEverOpened] = useState(false);
            // ── Trusted item prices (inventory pricing redesign) ──
            // Live map { itemId: priceDoc } from item_prices_{location}. The
            // collection starts EMPTY (0 reads) and grows only as admins set
            // prices / receipts are matched, so this is cheap. Drives the
            // trusted-price chip in renderLivePriceBadge + the admin editor.
            const [itemPrices, setItemPrices] = useState({});
            const [priceEditItem, setPriceEditItem] = useState(null); // admin price-editor target item
            useEffect(() => subscribeItemPrices(storeLocation, setItemPrices), [storeLocation]);
            useEffect(() => {
                if (invViewMode === "pricing") setPricingEverOpened(true);
            }, [invViewMode]);
            const [collapsedCats, setCollapsedCats] = useState({});
            const [invShowOnlyCounted, setInvShowOnlyCounted] = useState(false);
            // Filter to ONLY items currently flagged low-stock
            // (count > 0 && count <= min). Mirrors the "Counted Only"
            // toggle pattern so the rest of the page filtering logic
            // composes naturally. Useful when admin is scanning
            // "what do I need to put on the order list this week?"
            // without scrolling through every other item.
            const [invShowOnlyLow, setInvShowOnlyLow] = useState(false);
            const [vendorChangeLog, setVendorChangeLog] = useState([]);
            const [showVendorLog, setShowVendorLog] = useState(false);
            const [showCart, setShowCart] = useState(false);
            // Order-history modal — lifted to PAGE level (2026-06-30) so it can be
            // opened from BOTH the recent-orders bar AND from inside the cart modal
            // (layered above it), letting a manager reference a past order while
            // building a new cart without losing the cart.
            const [orderHistoryOpen, setOrderHistoryOpen] = useState(false);
            // Which order to auto-expand when the history popup opens (clicking a
            // recent-order chip opens the popup focused on that order to VIEW it).
            const [orderHistoryFocusId, setOrderHistoryFocusId] = useState(null);
            const openOrderHistory = useCallback((focusId = null) => {
                setOrderHistoryFocusId(focusId || null);
                setOrderHistoryOpen(true);
            }, []);
            // id → display name, for showing a past order's items by name in history.
            const itemNameById = useMemo(() => {
                const m = {};
                for (const cat of (customInventory || [])) {
                    for (const it of (cat.items || [])) {
                        if (it && it.id) m[it.id] = (language === 'es' && it.nameEs) ? it.nameEs : (it.name || it.id);
                    }
                }
                return m;
            }, [customInventory, language]);
            // Cart vendor-assignment state — Andrew 2026-05-22.
            // Live override of each item's vendor for the current cart
            // session. Default: each item uses its item.preferredVendor.
            // When the manager arms a vendor pill at the top of the
            // cart modal, clicking a row assigns that row to the armed
            // vendor (overriding the default). Persisted into the
            // inventory snapshot on Save so the saved order is grouped
            // by manager's choices, not auto-detected vendor.
            const [cartArmedVendor, setCartArmedVendor] = useState(null);
            const [cartVendorOverride, setCartVendorOverride] = useState({}); // { itemId: vendorName }
            // 2026-05-26 — Plan mode replaces the previous in-row
            // "Assign to" pill bar. Toggle on from the cart footer; the
            // cart body swaps to a focused vendor-pick-then-tap-items
            // assignment view. Stays inside the cart modal so closing
            // the modal also exits Plan; we don't persist this — every
            // cart open starts in normal view.
            const [cartPlanMode, setCartPlanMode] = useState(false);
            // Saved Lists section at the bottom of the inventory tab is
            // collapsed by default (Andrew 2026-05-22). It mounts the
            // heavy InventoryHistory lazy chunk, so leaving it closed
            // until the user explicitly opens it also makes the
            // inventory page noticeably snappier on first load.
            const [showSavedLists, setShowSavedLists] = useState(false);
            // 2026-05-20 — Quick date-code label printing. Opens an
            // editable PrintLabelModal so the receiver / cook can stick
            // a date label on ANY container without needing a recipe.
            // Closes on print / cancel.
            const [showQuickLabel, setShowQuickLabel] = useState(false);
            // Word-style free-form printer — multi-line text, font
            // size + bold + alignment, copies, optional date /
            // signature stamps. For ad-hoc notes ("BROKEN FRYER"),
            // single-batch markers, custom date tags, etc.
            const [showPrintCenter, setShowPrintCenter] = useState(false);
            // Order Mode — full-screen workflow for placing real vendor
            // orders (Andrew 2026-05-19). Triggered from inside the cart
            // modal via a "📞 Place order" button. Snapshots the current
            // cart rows into an /order_sessions doc and walks the manager
            // through ordering each item, vendor by vendor.
            const [orderModeRows, setOrderModeRows] = useState(null);
            // Stable close handler for the OrderMode modal. Without
            // useCallback this was a fresh arrow ref on every Operations
            // re-render (which fires on every inventory tap / labor
            // snapshot), so the OrderMode prop diff always reported
            // changed → memo benefits inside OrderMode got partially
            // defeated. Setter is already stable, so [] deps is fine.
            const closeOrderMode = useCallback(() => setOrderModeRows(null), []);
            // (echo from local writes is now suppressed via snapshot.metadata.hasPendingWrites in the inventory listener)
            // Split list state: overrides move items between people, writeIns are custom items per person
            const [splitOverrides, setSplitOverrides] = useState({}); // {itemId: personName}
            const [splitWriteIns, setSplitWriteIns] = useState({}); // {personName: [{id, name, count}]}
            const [splitWriteInValues, setSplitWriteInValues] = useState({}); // {personName: "text"}
            const [splitMovingItem, setSplitMovingItem] = useState(null); // {itemId, fromPerson}

            // Break Planner state
            // ── BOH defaults (kitchen stations) — original list ──────────
            const DEFAULT_BOH_STATIONS = [
                { id: "fry", nameEn: "Fry", nameEs: "Freidora", emoji: "\u{1F35F}" },
                { id: "pho", nameEn: "Pho", nameEs: "Pho", emoji: "\u{1F372}" },
                { id: "grill", nameEn: "Grill", nameEs: "Parrilla", emoji: "\u{1F525}" },
                { id: "bao", nameEn: "Bao", nameEs: "Bao", emoji: "\u{1F95F}" },
                { id: "springroll", nameEn: "Spring Roll", nameEs: "Rollito", emoji: "\u{1F32F}" },
                { id: "wok", nameEn: "Wok", nameEs: "Wok", emoji: "\u{1F958}" },
                { id: "bowls", nameEn: "Bowls", nameEs: "Bowls", emoji: "\u{1F957}" },
                { id: "friedrice1", nameEn: "Fried Rice 1", nameEs: "Arroz Frito 1", emoji: "\u{1F373}" },
                { id: "friedrice2", nameEn: "Fried Rice 2", nameEs: "Arroz Frito 2", emoji: "\u{1F373}" },
                { id: "dish", nameEn: "Dish", nameEs: "Platos", emoji: "\u{1F9FD}" },
                { id: "manager", nameEn: "Manager", nameEs: "Gerente", emoji: "\u{1F454}" },
                { id: "prep1", nameEn: "Prep 1", nameEs: "Prep 1", emoji: "\u{1F52A}" },
                { id: "prep2", nameEn: "Prep 2", nameEs: "Prep 2", emoji: "\u{1F52A}" },
                { id: "prep3", nameEn: "Prep 3", nameEs: "Prep 3", emoji: "\u{1F52A}" },
                { id: "prep4", nameEn: "Prep 4", nameEs: "Prep 4", emoji: "\u{1F52A}" }
            ];
            // ── FOH defaults (front-of-house positions) — Andrew 2026-05-25:
            //   "breaks need to have a FOH version". Defaults are starting
            //   points; admin can rename/add via the existing edit-stations
            //   UI (Cashier 1 / Cashier 2 / Drinks / Expo / Service / Manager
            //   matches a small-to-medium FOH lineup). The 'manager' id is
            //   special-cased downstream to filter to leadership roles.
            const DEFAULT_FOH_STATIONS = [
                { id: "cashier1", nameEn: "Cashier 1", nameEs: "Cajero 1", emoji: "\u{1F4B0}" },
                { id: "cashier2", nameEn: "Cashier 2", nameEs: "Cajero 2", emoji: "\u{1F4B0}" },
                { id: "drinks",   nameEn: "Drinks",    nameEs: "Bebidas",  emoji: "\u{1F9CB}" },
                { id: "expo",     nameEn: "Expo",      nameEs: "Expo",     emoji: "\u{1F514}" },
                { id: "service",  nameEn: "Service",   nameEs: "Servicio", emoji: "\u{1F91D}" },
                { id: "manager",  nameEn: "Manager",   nameEs: "Gerente",  emoji: "\u{1F454}" }
            ];
            const DEFAULT_BREAK_WAVES = [
                { id: "wave1", time: "13:30" },
                { id: "wave2", time: "14:30" }
            ];
            // Skill stations for the matrix (unique skills, not position slots).
            // Per-side — BOH skills are kitchen-only, FOH skills are front.
            const BOH_SKILL_STATIONS = [
                { id: "fry", nameEn: "Fry", emoji: "\u{1F35F}" },
                { id: "pho", nameEn: "Pho", emoji: "\u{1F372}" },
                { id: "grill", nameEn: "Grill", emoji: "\u{1F525}" },
                { id: "bao", nameEn: "Bao", emoji: "\u{1F95F}" },
                { id: "springroll", nameEn: "Spring Roll", emoji: "\u{1F32F}" },
                { id: "wok", nameEn: "Wok", emoji: "\u{1F958}" },
                { id: "bowls", nameEn: "Bowls", emoji: "\u{1F957}" },
                { id: "friedrice", nameEn: "Fried Rice", emoji: "\u{1F373}" },
                { id: "dish", nameEn: "Dish", emoji: "\u{1F9FD}" },
                { id: "prep", nameEn: "Prep", emoji: "\u{1F52A}" }
            ];
            const FOH_SKILL_STATIONS = [
                { id: "cashier", nameEn: "Cashier", emoji: "\u{1F4B0}" },
                { id: "drinks",  nameEn: "Drinks",  emoji: "\u{1F9CB}" },
                { id: "expo",    nameEn: "Expo",    emoji: "\u{1F514}" },
                { id: "service", nameEn: "Service", emoji: "\u{1F91D}" }
            ];
            // Map position IDs to skill IDs. cashier1/2 → cashier and
            // prep1-4 → prep collapse multi-slot positions to one skill.
            const positionToSkill = (posId) => {
                if (posId.startsWith("friedrice")) return "friedrice";
                if (posId.startsWith("prep")) return "prep";
                if (posId.startsWith("cashier")) return "cashier";
                return posId;
            };

            // ── Side toggle for the Break Planner ──────────────────────
            // Default to BOH (the only side that existed before). Persists
            // per device — most managers run breaks for one side at a time.
            const [breakSide, setBreakSide] = useState(() => {
                try { return localStorage.getItem('ddmau:breakSide') === 'FOH' ? 'FOH' : 'BOH'; }
                catch { return 'BOH'; }
            });
            useEffect(() => {
                try { localStorage.setItem('ddmau:breakSide', breakSide); }
                catch { /* private-mode safari — no-op */ }
            }, [breakSide]);

            // Per-side custom stations. Storing as a {FOH, BOH} map keeps
            // the toggle instant — no re-fetch round-trip on switch.
            const [customStationsBySide, setCustomStationsBySide] = useState(() => ({
                FOH: JSON.parse(JSON.stringify(DEFAULT_FOH_STATIONS)),
                BOH: JSON.parse(JSON.stringify(DEFAULT_BOH_STATIONS)),
            }));
            const customStations = customStationsBySide[breakSide];
            const setCustomStations = (next) => setCustomStationsBySide((prev) => {
                const value = typeof next === 'function' ? next(prev[breakSide]) : next;
                return { ...prev, [breakSide]: value };
            });
            // Currently-active skill stations + default stations follow the
            // side toggle. Used by the matrix + the "reset" affordance.
            const SKILL_STATIONS = breakSide === 'FOH' ? FOH_SKILL_STATIONS : BOH_SKILL_STATIONS;
            const DEFAULT_STATIONS = breakSide === 'FOH' ? DEFAULT_FOH_STATIONS : DEFAULT_BOH_STATIONS;

            const [editingStations, setEditingStations] = useState(false);
            const [newStationName, setNewStationName] = useState("");
            const [newStationEmoji, setNewStationEmoji] = useState("\u{1F4CD}");
            const ALL_POSITIONS = customStations;

            const [breakPlan, setBreakPlan] = useState({ stations: {}, waves: {} });
            const [breakPlanSaved, setBreakPlanSaved] = useState(false);
            const [breakWaveTimes, setBreakWaveTimes] = useState(DEFAULT_BREAK_WAVES.map(w => w.time));
            const [breakDate, setBreakDate] = useState(() => getTodayKey());

            // Build BREAK_WAVES dynamically from editable times
            const formatTime12 = (t24) => {
                if (!t24) return "";
                const [h, m] = t24.split(":").map(Number);
                const ampm = h >= 12 ? "PM" : "AM";
                const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                return h12 + ":" + String(m).padStart(2, "0") + " " + ampm;
            };
            const BREAK_WAVES = DEFAULT_BREAK_WAVES.map((w, i) => {
                const t = breakWaveTimes[i] || w.time;
                const display = formatTime12(t);
                return { id: w.id, time: t, displayTime: display, nameEn: `Wave ${i+1} \u{2014} ${display}`, nameEs: `Grupo ${i+1} \u{2014} ${display}` };
            });
            const [skillsMatrix, setSkillsMatrix] = useState({});
            const [showMatrix, setShowMatrix] = useState(false);

            // Labor percentage state (admin-only, from Toast scraper).
            //
            // 2026-06-02 consolidation: previously held its own
            // onSnapshot on ops/labor_{loc}, redundant with the listener
            // in AppDataContext (which the home tiles already used).
            // Sourcing from context dedups the listener AND fixes a
            // latent bug — the direct subscription queried
            // `ops/labor_<storeLocation>`, which in 'both' admin mode
            // pointed at the non-existent doc `ops/labor_both`. The
            // context's resolveLocDoc maps 'both' → webster.
            const { labor: laborData } = useAppData();
            // Toggle for the expanded labor breakdown panel. The corner
            // bubble shows the % at a glance; tapping it pops the time +
            // progress bar + 25% target marker out underneath. Default
            // collapsed so a fresh page load doesn't dedicate a whole
            // row to labor info every time.
            const [showLaborDetails, setShowLaborDetails] = useState(false);
            // FOH_ROLES_LIST hoisted to module scope so the useMemo dep
            // array doesn't churn on every render.
            //
            // 2026-05-25: fohStaff brought back to power the FOH side of
            // the Break Planner. breakStaff is the side-conditional list
            // the planner actually uses; everything outside the planner
            // keeps using bohStaff (kitchen-skills-matrix elsewhere etc).
            const bohStaff = useMemo(
                () => (staffList || []).filter(s => s.role && !FOH_ROLES_LIST.includes(s.role) && (s.location === storeLocation || s.location === "both")),
                [staffList, storeLocation]
            );
            const fohStaff = useMemo(
                () => (staffList || []).filter(s => s.role && FOH_ROLES_LIST.includes(s.role) && (s.location === storeLocation || s.location === "both")),
                [staffList, storeLocation]
            );
            const breakStaff = breakSide === 'FOH' ? fohStaff : bohStaff;

            // ── Memoized inventory lookup + Sysco price matching ──
            // Vendor match overrides + categories (Firestore-backed, see useEffect below).
            // Shape: vendorMatches = { sysco: {<vendorId>: <invId>}, usfoods: {...}, ... }
            //        vendorCategories = { sysco: {<vendorId>: <category>}, usfoods: {...}, ... }
            // An entry value of "" means "explicitly unmatched — do NOT auto-match"; absence
            // means "fall through to autoMatch()".
            const [vendorMatches, setVendorMatches] = useState(null);
            const [vendorCategories, setVendorCategories] = useState(null);
            const [matchEditor, setMatchEditor] = useState(null); // {vendor, vendorId, vendorName, currentInvId}
            const [matchSearchQuery, setMatchSearchQuery] = useState("");
            const [matchAuditFilter, setMatchAuditFilter] = useState("all"); // all | review | confirmed | unmatched
            // "Add as new master item" form state — shown inside the match editor modal.
            // When the vendor item has no good master match, the user can create a new master
            // item from this form (with their own naming) and the vendor item gets linked to it.
            const [addingToMaster, setAddingToMaster] = useState(false);
            const [newMasterName, setNewMasterName] = useState("");
            const [newMasterNameEs, setNewMasterNameEs] = useState("");
            const [newMasterCatIdx, setNewMasterCatIdx] = useState(0);
            const [newMasterSaving, setNewMasterSaving] = useState(false);
            // Merge-items state. When the user picks a source item via the merge ↔ button in
            // the master list edit mode, we open a target-picker modal (similar shape to the
            // match editor). Picking a target executes the merge: vendor matches pointing at
            // the source get redirected to the target, counts/meta are combined, and the source
            // item is removed from customInventory.
            const [mergeSource, setMergeSource] = useState(null); // { catIdx, itemIdx, item }
            const [mergeSearchQuery, setMergeSearchQuery] = useState("");
            const [mergeSaving, setMergeSaving] = useState(false);
            const [mergeError, setMergeError] = useState(null);
            const [matchAuditMode, setMatchAuditMode] = useState(false); // toggles the edit pencils per item

            // Convenience aliases used by the rest of the component (replaces the old hardcoded
            // useMemo objects). When Firestore hasn't loaded yet we fall back to the seed data
            // so the Pricing view still renders something on cold start.
            const SYSCO_OVERRIDES = (vendorMatches && vendorMatches.sysco) || HARDCODED_SYSCO_MATCH_SEED;
            const USFOODS_OVERRIDES = (vendorMatches && vendorMatches.usfoods) || {};
            const SYSCO_ITEM_CATEGORIES = (vendorCategories && vendorCategories.sysco) || HARDCODED_SYSCO_CATEGORY_SEED;

            const SYSCO_CATEGORY_ORDER = ["Proteins & Seafood", "Produce", "Dairy & Eggs", "Beverages", "Sauces & Condiments", "Other Food", "Supplies & Packaging", "Cleaning & Chemicals", "Uncategorized"];
            const SYSCO_CATEGORY_EMOJI = { "Proteins & Seafood": "\u{1F969}", "Produce": "\u{1F966}", "Dairy & Eggs": "\u{1F95A}", "Beverages": "\u{2615}", "Supplies & Packaging": "\u{1F4E6}", "Cleaning & Chemicals": "\u{1F9F9}", "Sauces & Condiments": "\u{1F336}\u{FE0F}", "Other Food": "\u{1F372}", "Uncategorized": "\u{2753}" };

            const invByName = useMemo(() => {
                const result = [];
                customInventory.forEach(cat => cat.items.forEach(item => {
                    const nameLower = (item.name || "").toLowerCase();
                    const keywords = nameLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 1);
                    result.push({ id: item.id, name: item.name, nameLower, keywords });
                }));
                return result;
            }, [customInventory]);

            const invLookup = useMemo(() => {
                const lookup = {};
                customInventory.forEach(cat => cat.items.forEach(item => {
                    lookup[item.id] = item;
                }));
                return lookup;
            }, [customInventory]);

            // Detects ID collisions in customInventory. When two items share an ID,
            // invLookup[id] silently returns the last one seen — the audit list then
            // shows the wrong name under a vendor item even though the saved match is correct.
            const invIdCollisions = useMemo(() => {
                const seen = {};
                const dupes = [];
                customInventory.forEach((cat, cIdx) => cat.items.forEach((item, iIdx) => {
                    if (seen[item.id]) {
                        dupes.push({ id: item.id, name: item.name, prevName: seen[item.id].name, cat: cat.name, cIdx, iIdx });
                    } else {
                        seen[item.id] = { name: item.name, cat: cat.name, cIdx, iIdx };
                    }
                }));
                if (dupes.length > 0) console.warn("[invIdCollisions]", dupes);
                return dupes;
            }, [customInventory]);

            const autoMatch = useCallback((syscoName) => {
                if (!syscoName) return null;
                const sLower = syscoName.toLowerCase();
                const sKeywords = sLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
                if (sKeywords.length === 0) return null;
                let bestId = null, bestScore = 0;
                for (const inv of invByName) {
                    if (inv.nameLower.includes(sLower) || sLower.includes(inv.nameLower)) {
                        const score = Math.min(inv.nameLower.length, sLower.length) + 100;
                        if (score > bestScore) { bestScore = score; bestId = inv.id; }
                        continue;
                    }
                    let overlap = 0;
                    for (const kw of sKeywords) {
                        if (inv.keywords.some(ik => ik === kw || (kw.length > 3 && ik.includes(kw)) || (ik.length > 3 && kw.includes(ik)))) overlap++;
                    }
                    const score = overlap / Math.max(sKeywords.length, 1) * 50;
                    if (score > bestScore && overlap >= 1) { bestScore = score; bestId = inv.id; }
                }
                return bestScore >= 15 ? bestId : null;
            }, [invByName]);

            const syscoPricingData = useMemo(() => {
                const syscoData = livePrices.sysco || {};
                const prices = syscoData.prices || {};
                const allEntries = Object.entries(prices).map(([syscoId, data]) => {
                    // Three states for the override:
                    //   - undefined / null  → no admin decision yet, fall through to autoMatch
                    //   - "" (empty)        → admin explicitly cleared / locked-unmatched
                    //   - "<invId>"         → admin-confirmed match
                    const overrideRaw = SYSCO_OVERRIDES[syscoId];
                    const hasOverride = overrideRaw !== undefined && overrideRaw !== null;
                    const lockedUnmatched = hasOverride && overrideRaw === "";
                    const overrideInvId = hasOverride && !lockedUnmatched ? overrideRaw : null;
                    const autoInvId = !hasOverride ? autoMatch(data.name) : null;
                    const invId = overrideInvId || autoInvId;
                    const category = SYSCO_ITEM_CATEGORIES[syscoId] || "Uncategorized";
                    return [syscoId, {
                        ...data,
                        name: data.name || `Sysco Item ${syscoId}`,
                        invId,
                        matchType: overrideInvId ? "confirmed" : autoInvId ? "auto" : lockedUnmatched ? "locked" : null,
                        category,
                    }];
                });
                const sorted = [...allEntries].sort((a, b) => {
                    const aCatIdx = SYSCO_CATEGORY_ORDER.indexOf(a[1].category);
                    const bCatIdx = SYSCO_CATEGORY_ORDER.indexOf(b[1].category);
                    if (aCatIdx !== bCatIdx) return aCatIdx - bCatIdx;
                    return (a[1].name || "").localeCompare(b[1].name || "");
                });
                // Group by category
                const byCategory = {};
                for (const entry of sorted) {
                    const cat = entry[1].category;
                    if (!byCategory[cat]) byCategory[cat] = [];
                    byCategory[cat].push(entry);
                }
                return {
                    syscoData,
                    sorted,
                    byCategory,
                    matchedCount: sorted.filter(([,d]) => d.invId).length,
                    withPriceCount: sorted.filter(([,d]) => d.price != null).length,
                };
            }, [livePrices.sysco, SYSCO_OVERRIDES, SYSCO_ITEM_CATEGORIES, autoMatch]);

            // US Foods pricing data (same pattern as Sysco — Firestore overrides + autoMatch fallback)
            const usfoodsPricingData = useMemo(() => {
                const ufData = livePrices.usfoods || {};
                const prices = ufData.prices || {};
                const allEntries = Object.entries(prices).map(([ufId, data]) => {
                    const overrideRaw = USFOODS_OVERRIDES[ufId];
                    const hasOverride = overrideRaw !== undefined && overrideRaw !== null;
                    const lockedUnmatched = hasOverride && overrideRaw === "";
                    const overrideInvId = hasOverride && !lockedUnmatched ? overrideRaw : null;
                    const autoInvId = !hasOverride ? autoMatch(data.name) : null;
                    const invId = overrideInvId || autoInvId;
                    return [ufId, {
                        ...data,
                        name: data.name || `US Foods Item ${ufId}`,
                        invId,
                        matchType: overrideInvId ? "confirmed" : autoInvId ? "auto" : lockedUnmatched ? "locked" : null,
                    }];
                });
                const sorted = [...allEntries].sort((a, b) => {
                    const aRank = a[1].invId ? 0 : 1;
                    const bRank = b[1].invId ? 0 : 1;
                    if (aRank !== bRank) return aRank - bRank;
                    return (a[1].name || "").localeCompare(b[1].name || "");
                });
                return {
                    ufData,
                    sorted,
                    matchedCount: sorted.filter(([,d]) => d.invId).length,
                    withPriceCount: sorted.filter(([,d]) => d.price != null).length,
                };
            }, [livePrices.usfoods, USFOODS_OVERRIDES, autoMatch]);

            // Costco — populated only by VendorCsvImportModal (no scraper).
            // Each item write from the importer already carries its
            // master-inventory invId (it does the SKU-match work). We
            // surface those directly here; fuzzy auto-match is skipped
            // because the importer's own picker is the canonical place
            // to resolve unmatched Costco SKUs.
            const costcoPricingData = useMemo(() => {
                const cData = livePrices.costco || {};
                const prices = cData.prices || {};
                const allEntries = Object.entries(prices).map(([costcoId, data]) => {
                    const overrideRaw = (vendorMatches?.costco || {})[costcoId];
                    const invId = data.invId || overrideRaw || null;
                    return [costcoId, {
                        ...data,
                        name: data.name || `Costco Item ${costcoId}`,
                        invId,
                        matchType: invId ? (data.invId ? 'auto' : 'confirmed') : null,
                    }];
                });
                const sorted = [...allEntries].sort((a, b) => {
                    const aRank = a[1].invId ? 0 : 1;
                    const bRank = b[1].invId ? 0 : 1;
                    if (aRank !== bRank) return aRank - bRank;
                    return (a[1].name || '').localeCompare(b[1].name || '');
                });
                return {
                    costcoData: cData,
                    sorted,
                    matchedCount: sorted.filter(([,d]) => d.invId).length,
                    withPriceCount: sorted.filter(([,d]) => d.price != null).length,
                };
            }, [livePrices.costco, vendorMatches]);

            // Reverse lookup: inventory item ID → ALL vendor prices for that item.
            // Returns { <invId>: [{vendor, vendorId, price, pack, brand, ...}, ...] }
            // sorted by price ascending (so [0] is the cheapest). The single-best lookup
            // and the cart's multi-vendor comparison both consume this.
            const invToVendorPrices = useMemo(() => {
                const map = {};
                const push = (vendor, key, data) => {
                    if (!data.invId || data.price == null) return;
                    if (!map[data.invId]) map[data.invId] = [];
                    map[data.invId].push({
                        vendor,
                        vendorId: key,
                        price: data.price,
                        originalPrice: data.originalPrice,
                        pack: data.pack,
                        brand: data.brand,
                        unit: data.unit,
                        name: data.name,
                        lastOrdered: data.lastOrdered,
                    });
                };
                if (syscoPricingData && syscoPricingData.sorted) {
                    for (const [key, data] of syscoPricingData.sorted) push("Sysco", key, data);
                }
                if (usfoodsPricingData && usfoodsPricingData.sorted) {
                    for (const [key, data] of usfoodsPricingData.sorted) push("US Foods", key, data);
                }
                // Sort each invId's list by price ascending — cheapest first
                for (const id in map) map[id].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
                return map;
            }, [syscoPricingData, usfoodsPricingData]);

            // Back-compat: existing call sites use invToSyscoPrice expecting the single
            // cheapest entry. Provide it as a derived view of the multi-vendor map.
            const invToSyscoPrice = useMemo(() => {
                const map = {};
                for (const id in invToVendorPrices) {
                    const list = invToVendorPrices[id];
                    if (list && list.length > 0) map[id] = list[0];
                }
                return map;
            }, [invToVendorPrices]);

            // Vendor items that are NOT matched to any master inventory item — these get
            // shown at the bottom of the Master List view in a distinct section so the user
            // can either match them in place (via the existing audit modal) or order them
            // as standalone vendor items.
            const unmatchedVendorItems = useMemo(() => {
                const out = [];
                if (syscoPricingData && syscoPricingData.sorted) {
                    for (const [key, data] of syscoPricingData.sorted) {
                        if (!data.invId && data.matchType !== "locked" && data.price != null) {
                            out.push({ vendor: "Sysco", vendorId: key, ...data });
                        }
                    }
                }
                if (usfoodsPricingData && usfoodsPricingData.sorted) {
                    for (const [key, data] of usfoodsPricingData.sorted) {
                        if (!data.invId && data.matchType !== "locked" && data.price != null) {
                            out.push({ vendor: "US Foods", vendorId: key, ...data });
                        }
                    }
                }
                // Sort: by vendor, then category (sysco only), then name
                out.sort((a, b) => {
                    if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
                    const ac = a.category || "ZZZ";
                    const bc = b.category || "ZZZ";
                    if (ac !== bc) return ac.localeCompare(bc);
                    return (a.name || "").localeCompare(b.name || "");
                });
                return out;
            }, [syscoPricingData, usfoodsPricingData]);

            // Expand all categories when searching, collapse back when cleared
            useEffect(() => {
                if (!invSearch) { setCollapsedCats({}); }
            }, [invSearch]);

            // ── AI semantic search wiring ─────────────────────────────
            // Flat items array from customInventory — fed to the
            // aiSearch Cloud Function. Memoized so the cache key
            // inside aiSearch stays stable across renders.
            const aiInvItems = useMemo(() => {
                const out = [];
                for (const cat of customInventory) {
                    for (const it of (cat.items || [])) {
                        out.push({
                            id: it.id,
                            name: it.name,
                            category: cat.name,
                            subcat: it.subcat || '',
                        });
                    }
                }
                return out;
            }, [customInventory]);
            const {
                loading: invAiLoading,
                matchingIds: invAiIds,
                error: invAiError,
            } = useAiSearch({
                query: invSearch,
                items: aiInvItems,
                enabled: invAiOn && invSearch.trim().length > 0,
            });
            const invAiIdSet = useMemo(
                () => (invAiIds ? new Set(invAiIds) : null),
                [invAiIds],
            );
            // Substring OR AI-id membership. Falls back to substring-
            // only when AI is off / loading / errored. Used at every
            // customInventory render site (category / vendor / split
            // views). Pricing views keep plain substring because
            // their data isn't in customInventory and wouldn't have
            // any AI ids in scope.
            const itemMatchesSearchAi = useCallback((item, searchLower) => {
                if (itemMatchesSearch(item, searchLower)) return true;
                if (invAiIdSet && invAiIdSet.has(item.id)) return true;
                return false;
            }, [invAiIdSet]);

            // Search/filter happens inline in each view (category, vendor, split, pricing) — same
            // pattern across all four. We previously had a memo here for the category view but it
            // diverged from how the other tabs work, made the category list "stick" on stale data
            // when search was cleared, and obscured the simple flow. Inline filtering at render
            // time is fast enough for the inventory size and matches the rest of the file.

            // Load skills matrix from Firestore
            useEffect(() => {
                const unsubMatrix = onSnapshot(doc(db, "config", "skillsMatrix"), (docSnap) => {
                    if (docSnap.exists() && docSnap.data().matrix) {
                        setSkillsMatrix(docSnap.data().matrix);
                    }
                }, (err) => console.warn('skillsMatrix snapshot error:', err));
                return () => unsubMatrix();
            }, []);

            // Load custom stations from Firestore — one doc per side.
            //
            // 2026-05-25: split per-side for the new FOH break planner.
            // BOH has a backward-compat fallback to the legacy
            // /config/stations doc (BOH-only before the FOH side existed),
            // so existing custom BOH stations survive the migration without
            // an explicit data move. FOH is a fresh namespace.
            useEffect(() => {
                const unsubBOH = onSnapshot(doc(db, "config", "stations_BOH"), (snap) => {
                    if (snap.exists() && Array.isArray(snap.data().stations) && snap.data().stations.length > 0) {
                        setCustomStationsBySide((prev) => ({ ...prev, BOH: snap.data().stations }));
                    } else {
                        // BOH-side fallback to the legacy doc.
                        getDoc(doc(db, "config", "stations")).then((legacy) => {
                            if (legacy.exists() && Array.isArray(legacy.data().stations) && legacy.data().stations.length > 0) {
                                setCustomStationsBySide((prev) => ({ ...prev, BOH: legacy.data().stations }));
                            }
                        }).catch((err) => console.warn('legacy stations read failed:', err));
                    }
                }, (err) => console.warn('stations_BOH snapshot error:', err));
                const unsubFOH = onSnapshot(doc(db, "config", "stations_FOH"), (snap) => {
                    if (snap.exists() && Array.isArray(snap.data().stations) && snap.data().stations.length > 0) {
                        setCustomStationsBySide((prev) => ({ ...prev, FOH: snap.data().stations }));
                    }
                }, (err) => console.warn('stations_FOH snapshot error:', err));
                return () => { unsubBOH(); unsubFOH(); };
            }, []);

            // ── Vendor match overrides + categories (Firestore-backed) ──
            // First-run migration: if the doc doesn't exist yet, seed it with the
            // hardcoded values that used to live inline in this component. After
            // that, the doc is the only source of truth — admins edit it via the
            // Match Audit UI in the Pricing tab.
            useEffect(() => {
                const matchesRef = doc(db, "config", "vendor_matches");
                const unsub = onSnapshot(matchesRef, (snap) => {
                    if (snap.exists()) {
                        setVendorMatches(snap.data());
                    } else {
                        const initial = { sysco: HARDCODED_SYSCO_MATCH_SEED, usfoods: {} };
                        setDoc(matchesRef, initial)
                            .catch(err => console.error("vendor_matches seed error:", err));
                        setVendorMatches(initial);
                    }
                }, (err) => console.error("vendor_matches listener:", err));
                return () => unsub();
            }, []);

            useEffect(() => {
                const catsRef = doc(db, "config", "vendor_categories");
                const unsub = onSnapshot(catsRef, (snap) => {
                    if (snap.exists()) {
                        setVendorCategories(snap.data());
                    } else {
                        const initial = { sysco: HARDCODED_SYSCO_CATEGORY_SEED, usfoods: {} };
                        setDoc(catsRef, initial)
                            .catch(err => console.error("vendor_categories seed error:", err));
                        setVendorCategories(initial);
                    }
                }, (err) => console.error("vendor_categories listener:", err));
                return () => unsub();
            }, []);

            // ── Vendor match mutators ────────────────────────────────────────
            // Uses updateDoc with dotted paths for ALL writes — this is the canonical way to
            // set a single nested field in Firestore. setDoc with merge:true was unreliable
            // for deeply-nested maps in some SDK versions (the previous bug where edits seemed
            // to revert to the auto-match value).
            // If the doc doesn't exist yet, falls back to setDoc with the full structure.
            const [matchSaveError, setMatchSaveError] = useState(null);
            // Returns true on success, false on failure. Callers use the return value
            // to decide whether to close the modal — silent failures (e.g. Firestore
            // rule denials) used to make the audit list look like the save reverted.
            const _writeMatch = async (vendor, vendorId, value) => {
                const ref = doc(db, "config", "vendor_matches");
                try {
                    await updateDoc(ref, { [`${vendor}.${vendorId}`]: value });
                    setMatchSaveError(null);
                    return true;
                } catch (err) {
                    if (err?.code === "not-found") {
                        try {
                            await setDoc(ref, { [vendor]: { [vendorId]: value } }, { merge: true });
                            setMatchSaveError(null);
                            return true;
                        } catch (e2) {
                            console.error("vendor match create error:", e2);
                            setMatchSaveError(`[${vendor} #${vendorId}] ${e2.code || ""} ${e2.message || String(e2)}`);
                            return false;
                        }
                    }
                    console.error("vendor match write error:", err);
                    setMatchSaveError(`[${vendor} #${vendorId}] ${err.code || ""} ${err.message || String(err)}`);
                    return false;
                }
            };
            const saveVendorMatch = (vendor, vendorId, invId) => _writeMatch(vendor, vendorId, invId);
            const lockVendorUnmatched = (vendor, vendorId) => _writeMatch(vendor, vendorId, "");
            const clearVendorMatch = async (vendor, vendorId) => {
                try {
                    await updateDoc(doc(db, "config", "vendor_matches"), {
                        [`${vendor}.${vendorId}`]: deleteField(),
                    });
                    setMatchSaveError(null);
                    return true;
                } catch (err) {
                    console.error("clearVendorMatch error:", err);
                    setMatchSaveError(`[${vendor} #${vendorId}] ${err.code || ""} ${err.message || String(err)}`);
                    return false;
                }
            };
            const saveVendorCategory = async (vendor, vendorId, category) => {
                try {
                    await updateDoc(doc(db, "config", "vendor_categories"), {
                        [`${vendor}.${vendorId}`]: category,
                    });
                } catch (err) {
                    if (err?.code === "not-found") {
                        await setDoc(doc(db, "config", "vendor_categories"), { [vendor]: { [vendorId]: category } }, { merge: true });
                    } else {
                        console.error("saveVendorCategory error:", err);
                    }
                }
            };

            // ── Merge two master items into one ──────────────────────────────
            // Used to clean up duplicates in the master list. Operations performed:
            //   1. Redirect every vendor_matches entry (Sysco/USFoods SKU links) that
            //      points at sourceId → targetId.
            //   2. Merge per-item vendor data into target: vendorOptions are union'd by
            //      vendor name (target wins on price conflict), and the supplier /
            //      preferredVendor / vendor / pack / addedFromVendor fields are inherited
            //      from source whenever target's is empty.
            //   3. Combine inventory counts (target += source) and clear source.
            //   4. Remove the source item from customInventory.
            // All Firestore writes are batched into a single updateDoc per doc so partial
            // failures can't leave us in a half-merged state. Updates target by ID, not
            // index, so source removal in the same category doesn't break the lookup.
            const mergeMasterItems = async (sourceCatIdx, sourceItemIdx, targetCatIdx, targetItemIdx) => {
                const sourceCat = customInventory[sourceCatIdx];
                const targetCat = customInventory[targetCatIdx];
                if (!sourceCat || !targetCat) {
                    setMergeError("Invalid source or target category");
                    return false;
                }
                const sourceItem = sourceCat.items[sourceItemIdx];
                const targetItem = targetCat.items[targetItemIdx];
                if (!sourceItem || !targetItem) {
                    setMergeError("Invalid source or target item");
                    return false;
                }
                if (sourceItem.id === targetItem.id) {
                    setMergeError(language === "es" ? "No se puede fusionar un artículo consigo mismo" : "Can't merge an item into itself");
                    return false;
                }

                setMergeSaving(true);
                setMergeError(null);
                try {
                    const sourceId = sourceItem.id;
                    const targetId = targetItem.id;

                    // 1. Redirect any vendor matches pointing at the source.
                    const vendorUpdates = {};
                    for (const vendor of Object.keys(vendorMatches || {})) {
                        for (const [vendorId, invId] of Object.entries(vendorMatches[vendor] || {})) {
                            if (invId === sourceId) {
                                vendorUpdates[`${vendor}.${vendorId}`] = targetId;
                            }
                        }
                    }
                    if (Object.keys(vendorUpdates).length > 0) {
                        await updateDoc(doc(db, "config", "vendor_matches"), vendorUpdates);
                    }

                    // 2. Build new customInventory: update target by ID, then filter source out.
                    //    Updating by ID (not index) so source removal in the same category
                    //    can't shift the target's position out from under us.
                    const updatedCustomInv = customInventory.map((cat, cIdx) => {
                        let items = cat.items;
                        if (cIdx === targetCatIdx) {
                            items = items.map(it => {
                                if (it.id !== targetId) return it;
                                const merged = { ...it };
                                // Union vendorOptions by vendor name. Target wins on
                                // price/pack conflicts; source contributes vendors
                                // target didn't have. Empty-vendor entries are dropped.
                                const targetOpts = Array.isArray(it.vendorOptions) ? it.vendorOptions : [];
                                const sourceOpts = Array.isArray(sourceItem.vendorOptions) ? sourceItem.vendorOptions : [];
                                const seen = new Map();
                                for (const opt of targetOpts) {
                                    if (!opt || !opt.vendor) continue;
                                    seen.set(opt.vendor, { ...opt });
                                }
                                for (const opt of sourceOpts) {
                                    if (!opt || !opt.vendor) continue;
                                    if (seen.has(opt.vendor)) {
                                        // Backfill missing fields on target's entry.
                                        const t = seen.get(opt.vendor);
                                        if (t.price == null && opt.price != null) t.price = opt.price;
                                        if (!t.pack && opt.pack) t.pack = opt.pack;
                                    } else {
                                        seen.set(opt.vendor, { ...opt });
                                    }
                                }
                                if (seen.size > 0) merged.vendorOptions = Array.from(seen.values());

                                // Inherit scalar vendor fields from source whenever
                                // target's is empty/missing.
                                const inherit = ["preferredVendor", "vendor", "supplier", "pack", "addedFromVendor"];
                                for (const k of inherit) {
                                    if ((merged[k] == null || merged[k] === "") && sourceItem[k]) {
                                        merged[k] = sourceItem[k];
                                    }
                                }
                                // If target has no price but source does, take source's.
                                if ((merged.price == null) && sourceItem.price != null) {
                                    merged.price = sourceItem.price;
                                }
                                return merged;
                            });
                        }
                        if (cIdx === sourceCatIdx) {
                            items = items.filter(it => it.id !== sourceId);
                        }
                        return { ...cat, items };
                    });

                    // 3. Combine counts + meta.
                    const sourceCount = inventory[sourceId] || 0;
                    const targetCount = inventory[targetId] || 0;
                    const mergedCount = sourceCount + targetCount;
                    const sourceMeta = invCountMeta[sourceId];
                    const targetMeta = invCountMeta[targetId];
                    // Prefer target's meta if it had a count (likely more recent context),
                    // fall back to source's meta otherwise.
                    const mergedMeta = targetCount > 0 ? targetMeta : sourceMeta;

                    // 4. One atomic write to the inventory doc. If sourceId came from
                    //    inventory.js (the static master list), tombstone it so the load
                    //    merge doesn't reintroduce it on next reload.
                    const ref = doc(db, "ops", "inventory_" + storeLocation);
                    const update = {
                        customInventory: updatedCustomInv,
                        [`counts.${sourceId}`]: deleteField(),
                        [`countMeta.${sourceId}`]: deleteField(),
                        date: new Date().toISOString(),
                    };
                    if (mergedCount > 0) {
                        update[`counts.${targetId}`] = mergedCount;
                        if (mergedMeta) update[`countMeta.${targetId}`] = mergedMeta;
                    }
                    const sourceIsMaster = INVENTORY_CATEGORIES.some(cat => cat.items.some(it => it.id === sourceId));
                    if (sourceIsMaster) {
                        update.deletedMasterIds = arrayUnion(sourceId);
                    }
                    await updateDoc(ref, update);

                    // 5. Mirror to local state (otherwise UI lags one tick behind Firestore).
                    setCustomInventory(updatedCustomInv);
                    setInventory(prev => {
                        const next = { ...prev };
                        delete next[sourceId];
                        if (mergedCount > 0) next[targetId] = mergedCount;
                        else delete next[targetId];
                        return next;
                    });
                    setInvCountMeta(prev => {
                        const next = { ...prev };
                        delete next[sourceId];
                        if (mergedMeta && mergedCount > 0) next[targetId] = mergedMeta;
                        else if (mergedCount === 0) delete next[targetId];
                        return next;
                    });

                    setMergeSaving(false);
                    setMergeSource(null);
                    setMergeSearchQuery("");
                    return true;
                } catch (err) {
                    console.error("Merge error:", err);
                    setMergeError(err.message || String(err));
                    setMergeSaving(false);
                    return false;
                }
            };

            // Move an item up or down within its category (direction = -1 for up, +1 for down).
            // Reorders by swapping in customInventory.items, then persists. The order is what
            // the master list (and the daily count view) renders, so this lets admin curate
            // the on-screen layout without touching inventory.js.
            const moveItem = async (catIdx, itemIdx, direction) => {
                const cat = customInventory[catIdx];
                if (!cat) return;
                const targetIdx = itemIdx + direction;
                if (targetIdx < 0 || targetIdx >= cat.items.length) return;
                // 2026-06-20 (QA audit O8) — route through the race-safe transaction
                // instead of legacy saveInventory, which setDoc-clobbered the WHOLE
                // customInventory array from local state (silently overwriting a
                // concurrent edit from another tablet). mutateInventory re-reads the
                // live list inside the txn and sets local state on success.
                await mutateInventory((live) => (live || customInventory).map((c, cIdx) => {
                    if (cIdx !== catIdx) return c;
                    const items = [...(c.items || [])];
                    if (targetIdx < 0 || targetIdx >= items.length) return c;
                    [items[itemIdx], items[targetIdx]] = [items[targetIdx], items[itemIdx]];
                    return { ...c, items };
                }));
            };

            // 2026-06-02 — labor subscription removed. `laborData` now
            // comes from useAppData() above (one listener serves Home
            // tiles + Operations + LaborDashboard). Prior local
            // onSnapshot duplicated AppDataContext's listener AND
            // returned null in 'both' admin mode because it queried
            // the literal doc `ops/labor_both`. The context's
            // resolveLocDoc maps 'both' → webster, so the corner
            // bubble now stays populated when an admin toggles to
            // 'both'. Old comment block (preserving the
            // error-callback-as-debug rationale from 2026-05-20) lives
            // on in src/v2/AppDataContext.jsx alongside the
            // consolidated listener.

            const saveStations = async (stations) => {
                try {
                    // 2026-05-25: per-side persistence. Writes always go to
                    // the side-suffixed doc; the legacy /config/stations
                    // doc is read-only (fallback for BOH on first load) and
                    // becomes orphaned once the user saves once.
                    await setDoc(doc(db, "config", "stations_" + breakSide), { stations, side: breakSide, updatedAt: new Date().toISOString() });
                } catch (err) {
                    console.error("Error saving stations:", err);
                    toast(language === 'es'
                        ? '⚠ No se pudo guardar las estaciones.'
                        : '⚠ Could not save stations.',
                        { kind: 'error' });
                }
            };

            const addStation = () => {
                const name = newStationName.trim();
                if (!name) return;
                const id = name.toLowerCase().replace(/[^a-z0-9]/g, "") + "_" + Date.now();
                const station = { id, nameEn: name, nameEs: name, emoji: newStationEmoji || "\u{1F4CD}" };
                const updated = [...customStations, station];
                setCustomStations(updated);
                saveStations(updated);
                setNewStationName("");
                setNewStationEmoji("\u{1F4CD}");
            };

            const removeStation = (stationId) => {
                if (!confirm(language === "es" ? "¿Eliminar esta estación?" : "Remove this station?")) return;
                const updated = customStations.filter(s => s.id !== stationId);
                setCustomStations(updated);
                saveStations(updated);
            };

            const renameStation = (stationId, newName) => {
                const updated = customStations.map(s => s.id === stationId ? { ...s, nameEn: newName, nameEs: newName } : s);
                setCustomStations(updated);
                saveStations(updated);
            };

            const updateStationEmoji = (stationId, newEmoji) => {
                const updated = customStations.map(s => s.id === stationId ? { ...s, emoji: newEmoji } : s);
                setCustomStations(updated);
                saveStations(updated);
            };

            const moveStation = (stationId, direction) => {
                const idx = customStations.findIndex(s => s.id === stationId);
                if (idx < 0) return;
                const newIdx = idx + direction;
                if (newIdx < 0 || newIdx >= customStations.length) return;
                const updated = [...customStations];
                [updated[idx], updated[newIdx]] = [updated[newIdx], updated[idx]];
                setCustomStations(updated);
                saveStations(updated);
            };

            const resetStationsToDefault = () => {
                if (!confirm(language === "es" ? "¿Restaurar estaciones predeterminadas?" : "Reset stations to defaults?")) return;
                const fresh = JSON.parse(JSON.stringify(DEFAULT_STATIONS));
                setCustomStations(fresh);
                saveStations(fresh);
            };

            const toggleSkill = async (staffName, skillId) => {
                const key = staffName + "_" + skillId;
                const newMatrix = { ...skillsMatrix, [key]: !skillsMatrix[key] };
                setSkillsMatrix(newMatrix);
                try {
                    await setDoc(doc(db, "config", "skillsMatrix"), { matrix: newMatrix, updatedAt: new Date().toISOString() });
                } catch (err) {
                    console.error("Error saving skills matrix:", err);
                    toast(language === 'es'
                        ? '⚠ No se pudo guardar la matriz de habilidades.'
                        : '⚠ Could not save skills matrix.',
                        { kind: 'error' });
                }
            };

            // Check if a person can work a position (based on skill matrix)
            const canWorkPosition = (personName, posId) => {
                const skillId = positionToSkill(posId);
                if (skillId === "manager") return true; // managers handled separately
                return !!skillsMatrix[personName + "_" + skillId];
            };

            // Get qualified covers for a position from available people
            const getQualifiedCovers = (posId, availablePeople, waveId) => {
                const skillId = positionToSkill(posId);
                const needCover = getPositionsNeedingCover(waveId);
                // Count how many stations each available person is already covering in this wave
                const coverLoad = {};
                needCover.forEach(nc => {
                    const c = nc.cover;
                    if (c) coverLoad[c] = (coverLoad[c] || 0) + 1;
                });
                // Filter to qualified, sort by: fewest current covers first
                return availablePeople
                    .filter(name => canWorkPosition(name, posId))
                    .sort((a, b) => (coverLoad[a] || 0) - (coverLoad[b] || 0));
            };

            // Load break plan from Firestore — keyed by selected date +
            // location + side. 2026-05-25: side suffix added for the FOH
            // break planner. Pre-existing docs were BOH-only and stored at
            // breakPlan_{loc}_{date}; on BOH we transparently fall back to
            // that legacy key if the new key is empty so existing data
            // keeps showing without a write migration.
            useEffect(() => {
                // Reset plan while loading new date/location/side
                setBreakPlan({ stations: {}, waves: {} });
                setBreakWaveTimes(DEFAULT_BREAK_WAVES.map(w => w.time));
                let cancelled = false;
                const docId = "breakPlan_" + storeLocation + "_" + breakSide + "_" + breakDate;
                const unsubBreakPlan = onSnapshot(doc(db, "ops", docId), (docSnap) => {
                    if (cancelled) return;
                    if (docSnap.exists()) {
                        setBreakPlan(docSnap.data().plan || { stations: {}, waves: {} });
                        if (docSnap.data().waveTimes) setBreakWaveTimes(docSnap.data().waveTimes);
                    } else if (breakSide === 'BOH') {
                        // BOH only: fall back to the pre-side-split key
                        // (breakPlan_{loc}_{date}) so existing data shows
                        // up. First save to the new key supersedes it.
                        const legacyId = "breakPlan_" + storeLocation + "_" + breakDate;
                        getDoc(doc(db, "ops", legacyId)).then((legacy) => {
                            if (cancelled) return;
                            if (legacy.exists() && legacy.data()?.plan) {
                                setBreakPlan(legacy.data().plan);
                                if (Array.isArray(legacy.data().waveTimes)) setBreakWaveTimes(legacy.data().waveTimes);
                            }
                        }).catch((err) => console.warn('legacy breakPlan read failed:', err));
                    }
                }, (err) => console.warn('breakPlan snapshot error:', err));
                // Migration of the OLDEST key (breakPlan_{date}, no loc),
                // BOH-only, kept for parity with the pre-2026-05-25 behavior.
                if (breakSide === 'BOH' && breakDate === getTodayKey()) {
                    const oldDocId = "breakPlan_" + breakDate;
                    getDoc(doc(db, "ops", oldDocId)).then(oldDocSnap => {
                        if (cancelled) return;
                        if (oldDocSnap.exists() && oldDocSnap.data().date === breakDate && oldDocSnap.data().plan) {
                            getDoc(doc(db, "ops", docId)).then(newDocSnap => {
                                if (cancelled) return;
                                if (!newDocSnap.exists()) {
                                    setDoc(doc(db, "ops", docId), oldDocSnap.data()).catch(err => console.error("Migration error:", err));
                                }
                            }).catch(err => console.error("Migration check error:", err));
                        }
                    }).catch(err => console.error("Migration read error:", err));
                }
                return () => { cancelled = true; unsubBreakPlan(); };
            }, [breakDate, storeLocation, breakSide]);

            const breakPlanDocRef = () => doc(db, "ops", "breakPlan_" + storeLocation + "_" + breakSide + "_" + breakDate);
            // Race-safe break-plan mutator. Pass (livePlan, liveTimes) => { plan, times }.
            // Two shift leads adjusting different stations / wave breakers concurrently
            // used to clobber each other (full-doc setDoc). Now both edits land.
            const mutateBreakPlan = async (transformer) => {
                try {
                    const next = await runTransaction(db, async (txn) => {
                        const snap = await txn.get(breakPlanDocRef());
                        const livePlan = (snap.exists() && snap.data()?.plan)
                            ? snap.data().plan
                            : breakPlan;
                        const liveTimes = (snap.exists() && Array.isArray(snap.data()?.waveTimes))
                            ? snap.data().waveTimes
                            : breakWaveTimes;
                        const out = transformer(livePlan, liveTimes) || {};
                        const newPlan = out.plan != null ? out.plan : livePlan;
                        const newTimes = out.times != null ? out.times : liveTimes;
                        txn.set(breakPlanDocRef(), {
                            plan: newPlan, date: breakDate, waveTimes: newTimes,
                            updatedAt: new Date().toISOString(), storeBranch: storeLocation,
                        });
                        return { plan: newPlan, times: newTimes };
                    });
                    setBreakPlan(next.plan);
                    setBreakWaveTimes(next.times);
                    setBreakPlanSaved(true);
                    setTimeout(() => setBreakPlanSaved(false), 2000);
                    return next;
                } catch (err) {
                    console.error("Error saving break plan:", err);
                    toast(language === "es" ? "Error al guardar plan de breaks" : "Break plan save failed", { kind: 'error' });
                    return null;
                }
            };
            // Backward-compat shim. Prefer mutateBreakPlan for race safety.
            const saveBreakPlan = async (plan, times) => {
                const saveTimes = times || breakWaveTimes;
                try {
                    await setDoc(breakPlanDocRef(), { plan, date: breakDate, waveTimes: saveTimes, updatedAt: new Date().toISOString(), storeBranch: storeLocation });
                    setBreakPlanSaved(true);
                    setTimeout(() => setBreakPlanSaved(false), 2000);
                } catch (err) { console.error("Error saving break plan (legacy):", err); }
            };

            const updateWaveTime = (idx, newTime) => {
                mutateBreakPlan((_livePlan, liveTimes) => {
                    const next = [...liveTimes];
                    next[idx] = newTime;
                    return { times: next };
                });
            };

            const updateStationAssignment = (posId, name) => {
                mutateBreakPlan((livePlan) => ({
                    plan: { ...livePlan, stations: { ...(livePlan.stations || {}), [posId]: name } },
                }));
            };

            const clearBreakPlan = () => {
                if (!confirm(language === "es" ? "¿Borrar todo el plan de breaks?" : "Clear entire break plan?")) return;
                mutateBreakPlan(() => ({ plan: { stations: {}, waves: {} } }));
            };

            // Build a map: person -> position(s) they're assigned to
            const getStaffPositionMap = () => {
                const map = {};
                Object.entries(breakPlan.stations || {}).forEach(([posId, name]) => {
                    if (!name) return;
                    if (!map[name]) map[name] = [];
                    const pos = ALL_POSITIONS.find(p => p.id === posId);
                    if (pos) map[name].push(pos);
                });
                return map;
            };

            // Get who's on break in a wave (array of names)
            const getWaveBreakers = (waveId) => {
                return breakPlan.waves?.[waveId + "_breakers"] || [];
            };

            // Toggle a person on/off break for a wave. Race-safe: applies the
            // toggle against the LIVE breakers list inside a transaction so
            // two shift leads tapping different people in the same wave both
            // land instead of clobbering each other.
            const toggleBreaker = (waveId, personName) => {
                mutateBreakPlan((livePlan) => {
                    const liveBreakers = (livePlan.waves || {})[waveId + "_breakers"] || [];
                    const next = [...liveBreakers];
                    const idx = next.indexOf(personName);
                    if (idx >= 0) next.splice(idx, 1);
                    else next.push(personName);
                    return { plan: { ...livePlan, waves: { ...(livePlan.waves || {}), [waveId + "_breakers"]: next } } };
                });
            };

            // Get/set who covers a specific position during a wave
            const getWaveCover = (waveId, posId) => breakPlan.waves?.[waveId + "_cover_" + posId] || "";
            const setWaveCover = (waveId, posId, coverName) => {
                mutateBreakPlan((livePlan) => ({
                    plan: { ...livePlan, waves: { ...(livePlan.waves || {}), [waveId + "_cover_" + posId]: coverName } },
                }));
            };

            // Get all assigned people
            const getAssignedStaff = () => {
                const assigned = new Set();
                Object.values(breakPlan.stations || {}).forEach(n => { if (n) assigned.add(n); });
                return [...assigned].sort();
            };

            // For a wave, get people NOT on break (available to cover)
            const getAvailableCovers = (waveId) => {
                const breakers = getWaveBreakers(waveId);
                return getAssignedStaff().filter(n => !breakers.includes(n));
            };

            // Get positions that need coverage in a wave (their assigned person is on break)
            const getPositionsNeedingCover = (waveId) => {
                const breakers = getWaveBreakers(waveId);
                const positions = [];
                Object.entries(breakPlan.stations || {}).forEach(([posId, name]) => {
                    if (name && breakers.includes(name)) {
                        const pos = ALL_POSITIONS.find(p => p.id === posId);
                        if (pos) positions.push({ pos, person: name, cover: getWaveCover(waveId, posId) });
                    }
                });
                return positions;
            };

            useEffect(() => {
                // Load checklist data (new system).
                // FIX (2026-05-14): subscribe with includeMetadataChanges +
                // hasPendingWrites guard, same pattern as the inventory
                // listener below. Without it, two devices editing
                // checklist state in the same tick could echo each
                // other's local writes back as if they were remote
                // updates and stomp the other side's input.
                const unsubChecklist = onSnapshot(doc(db, "ops", "checklists2_" + storeLocation), { includeMetadataChanges: true }, async (docSnap) => {
                    if (docSnap.metadata.hasPendingWrites) return;
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        const todayKey = getTodayKey();
                        // Auto-update tasks when version changes
                        if (!data.version || data.version < CHECKLIST_VERSION) {
                            const freshTasks = JSON.parse(JSON.stringify(DEFAULT_CHECKLIST_TASKS));
                            setCustomTasks(freshTasks);
                            setChecks({});
                            setChecklistDate(todayKey);
                            try {
                                await setDoc(doc(db, "ops", "checklists2_" + storeLocation), {
                                    checks: {}, customTasks: freshTasks, date: todayKey, updatedAt: new Date().toISOString(), version: CHECKLIST_VERSION
                                });
                            } catch (err) { console.error("Error updating checklist version:", err); }
                            return;
                        }
                        // Auto-reset: if stored date != today, save previous day's final state then reset
                        if (data.date && data.date !== todayKey) {
                            // Save the previous day's completed state to history before resetting
                            try {
                                const prevChecks = data.checks || {};
                                const hasAnyChecks = Object.keys(prevChecks).some(k => !k.includes("_by") && !k.includes("_at") && !k.includes("_photo") && !k.includes("_followUp") && prevChecks[k] === true);
                                if (hasAnyChecks) {
                                    await setDoc(doc(db, "checklistHistory_" + storeLocation, data.date), {
                                        checks: prevChecks, customTasks: data.customTasks || {}, assignments: data.assignments || {}, lists: data.lists || {}, date: data.updatedAt || new Date().toISOString(), version: CHECKLIST_VERSION
                                    });
                                }
                            } catch (err) { console.error("Error saving prev day history:", err); }
                            setChecks({});
                            setChecklistDate(todayKey);
                            // Also reset the Firestore doc for the new day with empty checks
                            try {
                                await updateDoc(doc(db, "ops", "checklists2_" + storeLocation), { checks: {}, date: todayKey, updatedAt: new Date().toISOString() });
                            } catch (err) { console.error("Error resetting for new day:", err); }
                        } else {
                            setChecks(data.checks || {});
                            setChecklistDate(data.date || todayKey);
                        }
                        if (data.customTasks) {
                            // Migrate morning/afternoon {"\u{2192}"} single "all" period
                            const migrated = {};
                            ["FOH", "BOH"].forEach(side => {
                                const s = data.customTasks[side] || {};
                                if (s.all) { migrated[side] = s; }
                                else {
                                    migrated[side] = { all: [...(s.morning || []), ...(s.afternoon || [])] };
                                }
                            });
                            setCustomTasks(migrated);
                        }
                        // Load checklist assignments
                        if (data.assignments) setChecklistAssignments(data.assignments);
                        // Load multi-list data
                        if (data.lists) {
                            setChecklistLists(data.lists);
                        } else {
                            // Migrate from old single-list: build lists from assignments
                            const migLists = { FOH: [{ id: "FOH_0", assignee: (data.assignments || {})["FOH_all"] || "" }], BOH: [{ id: "BOH_0", assignee: (data.assignments || {})["BOH_all"] || "" }] };
                            setChecklistLists(migLists);
                        }
                    }
                }, (err) => console.warn('checklists2 snapshot subscribe failed', err));

                // Active inventory-list subscription. Lives at /inventory_lists
                // where status='active'. If/when one is found, its categories
                // override the legacy customInventory shape — the inventory
                // tab renders from the active list. If no list is active,
                // the legacy ops/inventory_{loc}.customInventory path below
                // is the source of truth (existing behavior).
                const unsubActiveList = subscribeActiveList((next) => {
                    setActiveList(next);
                    if (next && Array.isArray(next.categories) && next.categories.length > 0) {
                        // Replace customInventory immediately — counts stay
                        // keyed by item.id, so the inventory tab re-renders
                        // with the list's items but the same counts.
                        setCustomInventory(next.categories.map(c => ({ ...c, items: [...c.items] })));
                    }
                });

                const inventoryDocRef = doc(db, "ops", "inventory_" + storeLocation);
                // Track last customInventory hash so we can short-circuit
                // the heavy id-migration merge below when only counts
                // changed (the common case on every +/- tap).
                let lastCustomInvHash = '';
                // True once we've applied at least one server-confirmed snapshot.
                // Used to let the FIRST (cache) snapshot paint counts for a warm/
                // offline cold-start, while skipping the LATER stale cache echoes
                // that arrive mid-burst and would clobber optimistic counts.
                let invServerSynced = false;
                const unsubInventorySnapshot = onSnapshot(inventoryDocRef, { includeMetadataChanges: true }, (docSnap) => {
                    // Skip our own optimistic local writes — wait for the server-confirmed snapshot.
                    // This avoids the prior race where a remote write arriving in the same tick
                    // as our local write got swallowed as if it were our own echo.
                    if (docSnap.metadata.hasPendingWrites) return;
                    // Skip stale cache-only echoes AFTER first sync (2026-06-30): during a rapid +1
                    // burst, the SDK delivers an intermediate cached snapshot where hasPendingWrites
                    // has already flipped false for the writes it knows about, but `data.counts` does
                    // NOT yet reflect the still-in-flight increment() ops on the other tapped items.
                    // With a Counted/Low filter active, setInventory(data.counts) on that stale map
                    // drops those items out of the filter — their whole location bucket empties and
                    // the rows vanish — until the authoritative server snapshot (~2-3s later) restores
                    // them. We still allow the very FIRST cache snapshot through so a warm/offline
                    // cold-start paints last-saved counts (this listener is the only counts loader).
                    if (docSnap.metadata.fromCache && invServerSynced) return;
                    if (!docSnap.metadata.fromCache) invServerSynced = true;
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        setInventory(data.counts || {});
                        setInvCountMeta(data.countMeta || {});
                        setVendorCounts(data.vendorCounts || {});
                        // If an admin-activated list is in play, IT owns the
                        // categories structure — skip the legacy merge from
                        // the ops doc. Counts/meta still come from the ops
                        // doc (per-location, orthogonal to the list).
                        const overrideList = activeListRef.current;
                        if (overrideList && Array.isArray(overrideList.categories) && overrideList.categories.length > 0) {
                            return;
                        }
                        if (data.customInventory) {
                            // Perf-fix 2026-05-22 (production audit): short-circuit
                            // the id-migration merge when customInventory bytes
                            // haven't changed. This fires for every count-only
                            // snapshot (the most common path), and the merge below
                            // builds Sets/Maps and walks 200+ items pointlessly.
                            // JSON.stringify is cheap (<2ms on this data shape) and
                            // avoids the deep-merge + downstream setCustomInventory
                            // → re-derivation of every useMemo in the tab.
                            const nextHash = JSON.stringify(data.customInventory);
                            if (nextHash === lastCustomInvHash) {
                                    return;
                            }
                            lastCustomInvHash = nextHash;
                            // Merge Firestore custom items into the master INVENTORY_CATEGORIES
                            // so new items from inventory.js always appear.
                            // Tombstones (deletedMasterIds) record master items the user
                            // intentionally removed via merge; without them, the load-merge
                            // would re-include every master item every time, undoing the
                            // delete on next reload.
                            const tombstones = new Set(data.deletedMasterIds || []);
                            const idMigration = {};
                            const merged = INVENTORY_CATEGORIES.map((masterCat, masterIdx) => {
                                const savedCat = data.customInventory.find(sc => sc.name === masterCat.name);
                                const liveMasterItems = masterCat.items.filter(it => !tombstones.has(it.id));
                                if (!savedCat) return { ...masterCat, items: [...liveMasterItems] };
                                const masterIds = new Set(liveMasterItems.map(it => it.id));
                                const masterById = new Map(liveMasterItems.map(it => [it.id, it]));
                                const expectedPrefix = `${masterIdx}-`;
                                // Walk savedCat.items in saved order so user reorders persist.
                                // Then append any master items the saved doc didn't have yet
                                // (newly-added entries in inventory.js).
                                const mergedItems = [];
                                const seenIds = new Set();
                                savedCat.items.forEach(si => {
                                    let newId = si.id;
                                    if (typeof si.id === "string" && !si.id.startsWith(expectedPrefix) && !masterIds.has(si.id)) {
                                        // Item from a renamed/moved category. Renumber under
                                        // the new prefix so it can't collide with another
                                        // category's master ids.
                                        let n = mergedItems.length;
                                        while (seenIds.has(`${masterIdx}-${n}`) || masterIds.has(`${masterIdx}-${n}`)) n++;
                                        newId = `${masterIdx}-${n}`;
                                        idMigration[si.id] = newId;
                                    }
                                    // NEVER silently drop a user's item on an id collision — that
                                    // is how an added item could "erase" a previous one. Re-id the
                                    // collider so BOTH survive (a genuine accidental dup then shows
                                    // twice — visible + deletable — instead of vanishing).
                                    if (seenIds.has(newId)) {
                                        let n = mergedItems.length;
                                        while (seenIds.has(`${masterIdx}-${n}`) || masterIds.has(`${masterIdx}-${n}`)) n++;
                                        const reId = `${masterIdx}-${n}`;
                                        idMigration[si.id] = reId;
                                        seenIds.add(reId);
                                        mergedItems.push({ ...si, id: reId });
                                        return;
                                    }
                                    seenIds.add(newId);
                                    // If a master twin exists, layer master fields under saved
                                    // (saved wins on every non-empty field).
                                    const mi = masterById.get(newId);
                                    if (mi) {
                                        const merged = { ...mi };
                                        for (const k of Object.keys(si)) {
                                            const v = si[k];
                                            if (v !== "" && v !== null && v !== undefined) merged[k] = v;
                                        }
                                        merged.id = newId;
                                        mergedItems.push(merged);
                                    } else {
                                        mergedItems.push({ ...si, id: newId });
                                    }
                                });
                                // Append any master items the saved doc didn't have yet
                                // (newly-added in inventory.js since the last save).
                                liveMasterItems.forEach(mi => {
                                    if (seenIds.has(mi.id)) return;
                                    seenIds.add(mi.id);
                                    mergedItems.push({ ...mi });
                                });
                                return { ...masterCat, items: mergedItems };
                            });
                            // For saved categories that don't match a master by name (e.g. an
                            // old name from before a rename), append them and renumber their
                            // ids under the new merged index so they can't collide with master
                            // items in another category.
                            data.customInventory.forEach(sc => {
                                if (INVENTORY_CATEGORIES.find(mc => mc.name === sc.name)) return;
                                const newIdx = merged.length;
                                const expectedPrefix = `${newIdx}-`;
                                const seenIds = new Set();
                                const renumbered = sc.items.map((si, n) => {
                                    let newId = si.id;
                                    if (typeof si.id !== "string" || !si.id.startsWith(expectedPrefix) || seenIds.has(si.id)) {
                                        let j = n;
                                        while (seenIds.has(`${newIdx}-${j}`)) j++;
                                        newId = `${newIdx}-${j}`;
                                        if (newId !== si.id) idMigration[si.id] = newId;
                                    }
                                    seenIds.add(newId);
                                    return { ...si, id: newId };
                                });
                                merged.push({ ...sc, items: renumbered });
                            });
                            setCustomInventory(merged);

                            // If the merge had to renumber any ids, persist the corrected
                            // customInventory + counts + vendor_matches so the cleanup is durable.
                            // Runs at most once per affected device on first load post-deploy.
                            if (Object.keys(idMigration).length > 0) {
                                migrateInventoryIds(merged, idMigration, data.counts || {}, data.countMeta || {}).catch(err => {
                                    console.error("[idMigration] failed:", err);
                                });
                            }
                        }
                    }
                }, (err) => console.warn('inventory snapshot subscribe failed', err));

                // Load vendor change log
                const unsubVendorLog = onSnapshot(doc(db, "ops", "vendorLog_" + storeLocation), (docSnap) => {
                    if (docSnap.exists()) {
                        setVendorChangeLog(docSnap.data().log || []);
                    }
                }, (err) => console.warn('vendorLog snapshot subscribe failed', err));

                // Load split list config (overrides + write-ins)
                const unsubSplit = onSnapshot(doc(db, "ops", "splitConfig_" + storeLocation), (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        if (data.overrides) setSplitOverrides(data.overrides);
                        if (data.writeIns) setSplitWriteIns(data.writeIns);
                    }
                }, (err) => console.warn('splitConfig snapshot subscribe failed', err));

                // Inventory audit log — last 50 changes for this location.
                // Drives the expandable "Recent changes" panel below the
                // Save & Reset button. Server-side timestamp orders writes
                // across devices; we display the most recent first.
                const auditQ = query(
                    collection(db, "inventory_audits_" + storeLocation),
                    orderBy("at", "desc"),
                    limit(50),
                );
                const unsubInvAudits = onSnapshot(auditQ, (snap) => {
                    const rows = [];
                    snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
                    setInventoryAudits(rows);
                }, (err) => console.warn('inventory audits subscribe failed', err));

                return () => { unsubChecklist(); unsubInventorySnapshot(); unsubVendorLog(); unsubSplit(); unsubInvAudits(); unsubActiveList(); };
            }, [storeLocation]);

            // ── Vendor-price subscriptions (GLOBAL, not per-location) ──
            // FIX (review 2026-05-14, perf): these 6 subscriptions used to live
            // inside the location-keyed useEffect above. The docs at
            // `vendor_prices/*` are the same regardless of which store the
            // admin is currently viewing — but the old code tore them down +
            // remounted them on every Webster ↔ Maryland toggle. Splitting
            // them into their own `[]`-deps effect means a location switch
            // only churns the 5 listeners that actually need to change.
            useEffect(() => {
                // 2026-06-13 perf — don't attach the 7 vendor_prices listeners
                // until the Pricing tab has been opened at least once. Saves 7
                // doc reads + 7 live listeners on every Operations open for the
                // common case (Pricing rarely viewed). Once opened they stay.
                if (!pricingEverOpened) return;
                // Vendor-price subscriptions — log subscription errors
                // instead of swallowing silently. A perm-denied / offline
                // blip would leave the price block empty without any
                // signal otherwise; the SDK auto-retries, but a log line
                // makes diagnosis a non-event when staff ask why "live
                // prices" is empty.
                // NOTE (2026-06-15): the Sysco/USFoods *_trigger and *_status
                // listeners + their stale-timeout machinery were removed — the
                // scrapers were deleted, so those docs never update and their
                // state was write-only. Only the three price docs remain, and
                // they feed the cart's legacy badge until item_prices fully
                // replaces them (Phase 3).
                const onVpErr = (tag) => (err) => console.warn(`vendor_prices/${tag} snapshot error:`, err);
                const unsubSyscoPrices = onSnapshot(doc(db, "vendor_prices", "sysco"), (docSnap) => {
                    if (docSnap.exists()) setLivePrices(prev => ({ ...prev, sysco: docSnap.data() }));
                }, onVpErr('sysco'));
                const unsubUsfoodsPrices = onSnapshot(doc(db, "vendor_prices", "usfoods"), (docSnap) => {
                    if (docSnap.exists()) setLivePrices(prev => ({ ...prev, usfoods: docSnap.data() }));
                }, onVpErr('usfoods'));
                // Costco — populated only by manual CSV/PDF imports
                // (no scraper). Same vendor_prices doc shape.
                const unsubCostcoPrices = onSnapshot(doc(db, "vendor_prices", "costco"), (docSnap) => {
                    if (docSnap.exists()) setLivePrices(prev => ({ ...prev, costco: docSnap.data() }));
                }, onVpErr('costco'));

                return () => {
                    unsubSyscoPrices();
                    unsubUsfoodsPrices();
                    unsubCostcoPrices();
                };
            }, [pricingEverOpened]);

            // Midnight auto-reset: check every 60s if the business-day date has changed.
            // All mutable state read here goes through refs so the interval is installed once
            // per location and isn't torn down/recreated on every checklist edit (which would
            // risk missing the rollover if recreation happened to land at exactly 11:59:xx).
            useEffect(() => {
                let lastKnownDate = getTodayKey();
                const midnightInterval = setInterval(async () => {
                    const now = getTodayKey();
                    if (now === lastKnownDate) return;
                    lastKnownDate = now;
                    const prevChecks = checksRef.current || {};
                    const hasAnyChecks = Object.keys(prevChecks).some(k => !k.includes("_by") && !k.includes("_at") && !k.includes("_photo") && !k.includes("_followUp") && prevChecks[k] === true);
                    const prevDate = checklistDateRef.current || addDaysKey(now, -1);
                    if (hasAnyChecks) {
                        try {
                            await setDoc(doc(db, "checklistHistory_" + storeLocation, prevDate + "_saved"), {
                                checks: cleanForFirestore(prevChecks), customTasks: cleanForFirestore(customTasksRef.current), assignments: cleanForFirestore(checklistAssignmentsRef.current), lists: cleanForFirestore(checklistListsRef.current), date: new Date().toISOString(), savedBy: "auto-midnight"
                            });
                        } catch (err) { console.error("Midnight save error:", err); }
                    }
                    setChecks({});
                    setChecklistDate(now);
                    try {
                        await updateDoc(doc(db, "ops", "checklists2_" + storeLocation), { checks: {}, date: now, updatedAt: new Date().toISOString() });
                    } catch (err) { console.error("Midnight reset error:", err); }
                }, 60000);
                return () => clearInterval(midnightInterval);
            }, [storeLocation]);

            // {"\u{2500}"}{"\u{2500}"} PUSH NOTIFICATION SYSTEM {"\u{2500}"}{"\u{2500}"}
            // {"\u{2500}"}{"\u{2500}"} NOTIFICATION SYSTEM {"\u{2500}"}{"\u{2500}"}
            const [activeAlerts, setActiveAlerts] = useState([]);
            // clockTick state was previously bumped every 30s solely to
            // force re-renders, but nothing in render actually reads it.
            // checkDeadlines() does its own setActiveAlerts when there's
            // new work to surface, so we don't need a heartbeat. Removed
            // 2026-05-14 — saves a forced full Operations re-render every
            // 30 seconds.
            const dismissedAlertsRef = useRef(new Set());

            const checkDeadlines = () => {
                const now = new Date();
                // Use Chicago wall-clock minutes — a phone in another zone or
                // a DST transition would otherwise mark tasks overdue too
                // early or too late.
                const currentMinutes = getBusinessMinutesNow(now);
                const tasks = customTasksRef.current;
                const ch = checksRef.current;
                const lists = checklistListsRef.current;
                const todayKey = getTodayKey();
                const alerts = [];
                ["FOH", "BOH"].forEach(side => {
                    TIME_PERIODS.forEach(p => {
                        const periodTasks = (tasks[side] && tasks[side][p.id]) || [];
                        periodTasks.forEach(item => {
                            if (!item.completeBy || !item.assignTo) return;
                            const itemAssignees = Array.isArray(item.assignTo) ? item.assignTo : [item.assignTo];
                            if (!itemAssignees.includes(staffName)) return;
                            // Check all lists for this side to find where task might be checked
                            let done = false;
                            const sideListCount = (lists[side] && lists[side].length) || 1;
                            for (let listIdx = 0; listIdx < sideListCount; listIdx++) {
                                const prefix = getCheckPrefix(side, listIdx);
                                if (item.subtasks && item.subtasks.length > 0) {
                                    if (item.subtasks.every(s => ch[prefix + s.id])) { done = true; break; }
                                } else {
                                    if (ch[prefix + item.id]) { done = true; break; }
                                }
                            }
                            if (done) return;
                            const [h, m] = item.completeBy.split(":").map(Number);
                            const deadlineMinutes = h * 60 + m;
                            const taskName = (item.task || "").includes("\n") ? item.task.split("\n")[0] : item.task;
                            const timeStr = item.completeBy.replace(/^0/, "");
                            // 30-minute warning
                            const warn30Key = item.id + "_30_" + todayKey;
                            if (currentMinutes >= deadlineMinutes - 30 && currentMinutes < deadlineMinutes && !dismissedAlertsRef.current.has(warn30Key)) {
                                const minsLeft = deadlineMinutes - currentMinutes;
                                alerts.push({ key: warn30Key, type: "warning", taskName, timeStr, message: `${minsLeft} min left` });
                                // Push to all assignees (idempotent doc IDs so multiple
                                // devices firing this don't duplicate the FCM trigger).
                                for (const a of itemAssignees) {
                                    const docId = `taskremind_${item.id}_${todayKey}_30_${a.replace(/\W/g, '_')}`;
                                    taskNotify(a, 'task_due_soon',
                                        { en: `⏰ ${taskName} due in ${minsLeft} min`, es: `⏰ ${taskName} vence en ${minsLeft} min` },
                                        { en: `Due at ${timeStr}.`, es: `Vence a las ${timeStr}.` },
                                        null, { docId, allowSelf: true });
                                }
                            }
                            // At deadline or overdue
                            const dueKey = item.id + "_due_" + todayKey;
                            if (currentMinutes >= deadlineMinutes && !dismissedAlertsRef.current.has(dueKey)) {
                                const overBy = currentMinutes - deadlineMinutes;
                                alerts.push({ key: dueKey, type: "overdue", taskName, timeStr, message: overBy === 0 ? "Due NOW" : `${overBy} min overdue` });
                                for (const a of itemAssignees) {
                                    const docId = `taskremind_${item.id}_${todayKey}_due_${a.replace(/\W/g, '_')}`;
                                    taskNotify(a, 'task_overdue',
                                        { en: `🚨 ${taskName} OVERDUE`, es: `🚨 ${taskName} VENCIDA` },
                                        { en: overBy === 0 ? `Due now (${timeStr}).` : `${overBy} min overdue (was due ${timeStr}).`,
                                          es: overBy === 0 ? `Vence ahora (${timeStr}).` : `${overBy} min vencida (debía a las ${timeStr}).` },
                                        null, { docId, allowSelf: true });
                                }
                            }
                        });
                    });
                });
                setActiveAlerts(alerts);
                // Also try browser notification for new alerts
                if ("Notification" in window && Notification.permission === "granted") {
                    alerts.forEach(a => {
                        const nKey = "notif_" + a.key;
                        if (!dismissedAlertsRef.current.has(nKey)) {
                            dismissedAlertsRef.current.add(nKey);
                            new Notification(a.type === "overdue" ? "DD Mau - Task Due!" : "DD Mau - Reminder", {
                                body: `"${a.taskName}" \u{2014} ${a.message}`,
                                tag: nKey
                            });
                        }
                    });
                }
            };

            useEffect(() => {
                if ("Notification" in window && Notification.permission === "default") {
                    Notification.requestPermission();
                }
                checkDeadlines(); // run immediately
                const interval = setInterval(() => { checkDeadlines(); }, 30000);
                return () => clearInterval(interval);
            }, [staffName]);

            const dismissAlert = (key) => {
                dismissedAlertsRef.current.add(key);
                setActiveAlerts(prev => prev.filter(a => a.key !== key));
            };

            // Strip undefined values from nested objects before Firestore save
            const cleanForFirestore = (obj) => {
                if (Array.isArray(obj)) return obj.map(cleanForFirestore);
                if (obj && typeof obj === "object") {
                    const clean = {};
                    Object.keys(obj).forEach(k => {
                        if (obj[k] !== undefined) clean[k] = cleanForFirestore(obj[k]);
                    });
                    return clean;
                }
                return obj;
            };

            // ── writeChecklistPatch — partial-write helper ────────────────
            // 2026-05-24 audit fix: legacy saveChecklistState (below) wrote
            // ALL 4 top-level fields (checks / customTasks / assignments /
            // lists) on every call. That meant an admin editing assignments
            // while a cook was checking items would clobber the cook's
            // check-marks back to whatever the admin had snapshotted when
            // they opened the form. writeChecklistPatch writes ONLY the
            // fields you explicitly name — pass undefined or omit to skip.
            // Use updateDoc so unwritten top-level fields are never touched
            // by this call, even if the doc grows new fields later.
            //
            // For high-frequency check-mark writes, keep using writeCheckPatch
            // (dotted paths into checks.*) — this helper still replaces the
            // entire `checks` map when called with a `checks:` arg, which is
            // what bulk-reset / list-deletion paths need. For removing only
            // a few check keys (e.g. a single task got deleted), prefer
            // writeCheckPatch({key: undefined}) — that uses deleteField().
            const writeChecklistPatch = async ({ checks, customTasks, assignments, lists } = {}) => {
                const todayKey = getTodayKey();
                const now = new Date().toISOString();
                const patch = { updatedAt: now, date: todayKey, version: CHECKLIST_VERSION };
                if (checks !== undefined)      patch.checks      = cleanForFirestore(checks);
                if (customTasks !== undefined) patch.customTasks = cleanForFirestore(customTasks);
                if (assignments !== undefined) patch.assignments = cleanForFirestore(assignments);
                if (lists !== undefined)       patch.lists       = cleanForFirestore(lists);
                // Nothing to write — no-op rather than wasting a round-trip.
                if (Object.keys(patch).length <= 3) return;

                const liveRef = doc(db, "ops", "checklists2_" + storeLocation);
                const histRef = doc(db, "checklistHistory_" + storeLocation, todayKey);
                try { await updateDoc(liveRef, patch); }
                catch (e) {
                    // Doc may not exist yet — seed it with merge.
                    try { await setDoc(liveRef, patch, { merge: true }); }
                    catch (e2) { console.error("Error saving checklist (live):", e2); }
                }
                try { await updateDoc(histRef, patch); }
                catch (e) {
                    try { await setDoc(histRef, patch, { merge: true }); }
                    catch (e2) { console.error("Error saving checklist (history):", e2); }
                }
            };

            // Legacy shim — only used by very old call sites that still
            // pass full state. NEW callers should use writeChecklistPatch
            // with only the fields they actually changed.
            const saveChecklistState = async (newChecks, newTasks, newAssignments, newLists) => {
                await writeChecklistPatch({
                    checks:      newChecks,
                    customTasks: newTasks,
                    assignments: newAssignments,
                    lists:       newLists,
                });
            };

            // ── Granular check-key writers ────────────────────────────────
            // The high-frequency operations (toggle complete, add comment,
            // skip, etc.) only touch one or two keys inside `checks`. The
            // legacy saveChecklistState writes the WHOLE doc, which means
            // two cooks finishing tasks at the same moment race-clobber
            // each other's check-marks. Use updateDoc with dotted paths
            // here so each writer only mutates the keys they touched.
            //
            // patch = { "FOH_taskId": true, "FOH_taskId_by": "Maria", ... }
            // value of `undefined` → deleteField() removes the key.
            const writeCheckPatch = async (patch) => {
                const todayKey = getTodayKey();
                const dotted = { updatedAt: new Date().toISOString(), date: todayKey };
                for (const k in patch) {
                    const v = patch[k];
                    dotted[`checks.${k}`] = v === undefined ? deleteField() : v;
                }
                const liveRef = doc(db, "ops", "checklists2_" + storeLocation);
                const histRef = doc(db, "checklistHistory_" + storeLocation, todayKey);
                try {
                    await updateDoc(liveRef, dotted);
                } catch (e) {
                    // Doc may not exist yet — seed it with merge.
                    const seed = {};
                    for (const k in patch) if (patch[k] !== undefined) seed[k] = patch[k];
                    await setDoc(liveRef, { checks: seed, date: todayKey, version: CHECKLIST_VERSION }, { merge: true });
                }
                try {
                    await updateDoc(histRef, dotted);
                } catch (e) {
                    // History doc for today doesn't exist yet — seed it.
                    const seed = {};
                    for (const k in patch) if (patch[k] !== undefined) seed[k] = patch[k];
                    await setDoc(histRef, { checks: seed, date: new Date().toISOString(), version: CHECKLIST_VERSION }, { merge: true });
                }
            };

            // Append to a comment array atomically. arrayUnion is what makes
            // concurrent comments safe — two cooks adding notes at the same
            // moment both land instead of one overwriting the other.
            const appendCheckArrayValue = async (pKey, value) => {
                const todayKey = getTodayKey();
                const dotted = {
                    [`checks.${pKey}`]: arrayUnion(value),
                    updatedAt: new Date().toISOString(),
                    date: todayKey,
                };
                const liveRef = doc(db, "ops", "checklists2_" + storeLocation);
                const histRef = doc(db, "checklistHistory_" + storeLocation, todayKey);
                try { await updateDoc(liveRef, dotted); }
                catch (e) {
                    await setDoc(liveRef, { checks: { [pKey]: [value] }, date: todayKey, version: CHECKLIST_VERSION }, { merge: true });
                }
                try { await updateDoc(histRef, dotted); }
                catch (e) {
                    await setDoc(histRef, { checks: { [pKey]: [value] }, date: new Date().toISOString(), version: CHECKLIST_VERSION }, { merge: true });
                }
            };

            const assignChecklist = async (side, periodId, staffMemberName, listIdx) => {
                const li = listIdx !== undefined ? listIdx : activeListIdx;
                const key = li === 0 ? side + "_" + periodId : side + "_L" + li + "_" + periodId;
                const updated = { ...checklistAssignments, [key]: staffMemberName };
                // Also update the lists data
                const updatedLists = JSON.parse(JSON.stringify(checklistListsRef.current));
                if (updatedLists[side] && updatedLists[side][li]) {
                    updatedLists[side][li].assignee = staffMemberName;
                }
                setChecklistAssignments(updated);
                setChecklistLists(updatedLists);
                // Only assignments + lists changed — don't re-write checks/customTasks.
                await writeChecklistPatch({ assignments: updated, lists: updatedLists });
            };

            // Per-task assignment: toggle a staff member on/off a task's assignTo array
            const toggleTaskAssignee = async (taskIdx, staffMemberName) => {
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                const item = updated[checklistSide][PERIOD_KEY][taskIdx];
                let current = [];
                if (item.assignTo) {
                    current = Array.isArray(item.assignTo) ? [...item.assignTo] : [item.assignTo];
                }
                const idx = current.indexOf(staffMemberName);
                if (idx >= 0) { current.splice(idx, 1); } else { current.push(staffMemberName); }
                if (current.length > 0) { item.assignTo = current; } else { delete item.assignTo; }
                setCustomTasks(updated);
                // Only customTasks changed.
                await writeChecklistPatch({ customTasks: updated });
            };

            // 2026-05-24 — Andrew: "make it easier to assign a staff to
            // the tasks." Bulk-assign helper used by the AssigneePicker
            // bottom sheet: writes the FULL new assignTo array for one
            // task in a single Firestore round-trip (vs the per-name
            // toggleTaskAssignee above which writes once per click).
            const setTaskAssignees = async (taskIdx, names) => {
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                const item = updated[checklistSide][PERIOD_KEY][taskIdx];
                if (!item) return;
                const cleaned = Array.isArray(names) ? names.filter(Boolean) : [];
                if (cleaned.length > 0) item.assignTo = cleaned;
                else delete item.assignTo;
                setCustomTasks(updated);
                await writeChecklistPatch({ customTasks: updated });
            };

            const addChecklistList = async (side) => {
                const updatedLists = JSON.parse(JSON.stringify(checklistListsRef.current));
                const newIdx = updatedLists[side].length;
                updatedLists[side].push({ id: side + "_" + newIdx, assignee: "" });
                setChecklistLists(updatedLists);
                setActiveListIdx(newIdx);
                // Only lists changed.
                await writeChecklistPatch({ lists: updatedLists });
            };

            const removeChecklistList = async (side, listIdx) => {
                if (listIdx === 0) return; // Can't remove the first list
                const updatedLists = JSON.parse(JSON.stringify(checklistListsRef.current));
                updatedLists[side].splice(listIdx, 1);
                // Clean up checks for that list — collect deletions so we
                // can use writeCheckPatch (atomic dotted-path deleteField)
                // instead of overwriting the entire `checks` map.
                const prefix = getCheckPrefix(side, listIdx);
                const newChecks = { ...checksRef.current };
                const checkDeletions = {};
                if (prefix) {
                    Object.keys(newChecks).forEach(k => {
                        if (k.startsWith(prefix)) {
                            delete newChecks[k];
                            checkDeletions[k] = undefined; // writeCheckPatch → deleteField()
                        }
                    });
                }
                // Clean up assignment
                const newAssignments = { ...checklistAssignments };
                const assignKey = side + "_L" + listIdx + "_all";
                delete newAssignments[assignKey];
                setChecklistLists(updatedLists);
                setChecks(newChecks);
                setChecklistAssignments(newAssignments);
                setActiveListIdx(Math.min(activeListIdx, updatedLists[side].length - 1));
                // 1) Atomically delete only the affected check keys
                if (Object.keys(checkDeletions).length > 0) {
                    await writeCheckPatch(checkDeletions);
                }
                // 2) Update assignments + lists (no checks/customTasks rewrite)
                await writeChecklistPatch({ assignments: newAssignments, lists: updatedLists });
            };

            // ── Per-task comments ──
            // Stored in the same `checks` doc under key `${prefix}${taskId}_comments`
            // as an array of {by, at, text}. arrayUnion makes concurrent
            // comments safe — two cooks adding notes at the same moment
            // both land instead of one clobbering the other.
            //
            // 2026-05-16 — comments now fire PUSH NOTIFICATIONS to the
            // task's stakeholders so a manager note ("don't forget the
            // walk-in") reaches the assignee even when they're not on
            // this screen. Recipients = assignee(s) + previous commenters
            // + whoever completed the task, minus the commenter. Same-
            // task notifications dedupe via a stable docId so a chatty
            // thread doesn't spam the bell — only the latest comment is
            // surfaced per recipient until they read it.
            //
            // taskObj: optional. When provided, we use task.assignTo +
            // task.task (the title) directly. Otherwise we fall back to
            // checklistAssignments[taskId] and a generic title.
            const addTaskComment = async (taskId, text, taskObj = null) => {
                if (!text || !text.trim()) return;
                const pKey = currentPrefix + taskId + "_comments";
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                const comment = { by: staffName, at: timeStr, text: text.trim(), ts: now.toISOString() };
                const cur = checksRef.current;
                const existing = Array.isArray(cur[pKey]) ? cur[pKey] : [];
                // Optimistic local update so UI shows comment instantly.
                setChecks({ ...cur, [pKey]: [...existing, comment] });
                await appendCheckArrayValue(pKey, comment);

                // ── Notification fan-out ────────────────────────
                try {
                    const recipients = new Set();
                    // Task-level assignee(s) from the task definition
                    if (taskObj?.assignTo) {
                        if (Array.isArray(taskObj.assignTo)) {
                            taskObj.assignTo.forEach(n => n && recipients.add(n));
                        } else {
                            recipients.add(taskObj.assignTo);
                        }
                    }
                    // Per-task dynamic assignment (manager dragged a task
                    // to a specific person today)
                    const dynamicAssignee = checklistAssignmentsRef.current?.[taskId];
                    if (dynamicAssignee) recipients.add(dynamicAssignee);
                    // Whoever completed the task today gets the note too
                    const completedBy = cur[currentPrefix + taskId + '_by'];
                    if (completedBy) recipients.add(completedBy);
                    // Previous commenters on this task (so a back-and-forth
                    // keeps everyone in the loop)
                    for (const c of existing) {
                        if (c?.by) recipients.add(c.by);
                    }
                    recipients.delete(staffName); // never notify self
                    if (recipients.size === 0) return;

                    const rawName = taskObj?.task || taskObj?.label || 'Task';
                    const taskName = String(rawName).split('\n')[0].slice(0, 80);
                    const body = comment.text.length > 140
                        ? comment.text.slice(0, 137) + '…'
                        : comment.text;
                    for (const recipient of recipients) {
                        // Dedup docId per (task, recipient): each new
                        // comment overwrites the prior one in the bell
                        // until the recipient reads it.
                        const safeId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '_');
                        const safeName = String(recipient).replace(/[^a-zA-Z0-9_-]/g, '_');
                        await taskNotify(
                            recipient,
                            'task_comment',
                            { en: `💬 Task note: ${taskName}`, es: `💬 Nota de tarea: ${taskName}` },
                            { en: `${staffName}: ${body}`, es: `${staffName}: ${body}` },
                            null,
                            { docId: `task_comment_${safeId}_${safeName}` }
                        );
                    }
                } catch (e) {
                    console.warn('task-comment notify failed (non-fatal):', e);
                }
            };

            const removeTaskComment = async (taskId, idx) => {
                const cur = checksRef.current;
                const pKey = currentPrefix + taskId + "_comments";
                const existing = Array.isArray(cur[pKey]) ? cur[pKey] : [];
                if (idx < 0 || idx >= existing.length) return;
                const newArr = existing.filter((_, i) => i !== idx);
                // Optimistic local update.
                const newChecks = { ...cur };
                if (newArr.length > 0) newChecks[pKey] = newArr; else delete newChecks[pKey];
                setChecks(newChecks);
                // Replace the array atomically with a dotted-path write.
                // (arrayRemove would need exact item match; safer to overwrite.)
                await writeCheckPatch({ [pKey]: newArr.length > 0 ? newArr : undefined });
            };

            // ── Push notifications for tasks ──────────────────────────────
            // Same pipeline the schedule uses: writes a doc to /notifications,
            // Cloud Function dispatchNotification fires FCM to that staff's
            // tokens. resolveText() picks the right language from the staff
            // record's preferredLanguage; falls back to English.
            const taskNotifyResolve = (val, recipient) => {
                if (val == null) return '';
                if (typeof val === 'string') return val;
                if (typeof val === 'object') {
                    const lang = recipient?.preferredLanguage || 'en';
                    return val[lang] || val.en || val.es || '';
                }
                return String(val);
            };
            const taskNotify = async (forStaff, type, title, body, link = null, opts = {}) => {
                if (!forStaff) return;
                if (forStaff === staffName && !opts.allowSelf) return;
                const recipient = (staffList || []).find(s => s.name === forStaff);
                try {
                    // Routes the bell tap back to the right tab. Task-
                    // notification types all deep-link to Operations
                    // unless an explicit opts.deepLink overrides.
                    const deepLink = opts.deepLink
                        || (type === 'task_comment' || type === 'task_message' || type === 'task_completed' || type === 'task_reminder'
                            ? 'operations' : null);
                    if (opts.docId) {
                        // Idempotent path — used for time-based reminders so multiple
                        // devices firing checkDeadlines don't write duplicates. Fixed
                        // doc ID + setDoc means second writer just overwrites the first
                        // with same content (no second Cloud Function trigger).
                        await setDoc(doc(db, 'notifications', opts.docId), {
                            forStaff, type,
                            title: taskNotifyResolve(title, recipient),
                            body: taskNotifyResolve(body, recipient),
                            link,
                            ...(deepLink ? { deepLink } : {}),
                            createdAt: serverTimestamp(), read: false, createdBy: staffName,
                        });
                    } else {
                        await addDoc(collection(db, 'notifications'), {
                            forStaff, type,
                            title: taskNotifyResolve(title, recipient),
                            body: taskNotifyResolve(body, recipient),
                            link,
                            ...(deepLink ? { deepLink } : {}),
                            createdAt: serverTimestamp(), read: false, createdBy: staffName,
                        });
                    }
                } catch (e) {
                    console.warn('task notify failed (non-fatal):', e);
                }
            };

            // Send a per-task message to all assignees of `task` immediately.
            // Used by the messaging composer's "Send now" button and by the
            // on-complete delivery path inside toggleCheckItem.
            const dispatchTaskMessage = async (task, message, kind /* 'now'|'on_complete' */) => {
                if (!task || !message?.text) return;
                const assignees = Array.isArray(task.assignTo) ? task.assignTo : (task.assignTo ? [task.assignTo] : []);
                const taskName = (task.task || '').split('\n')[0];
                const titleEn = kind === 'on_complete' ? `✅ Task done: ${taskName}` : `📨 Task message: ${taskName}`;
                const titleEs = kind === 'on_complete' ? `✅ Tarea hecha: ${taskName}` : `📨 Mensaje de tarea: ${taskName}`;
                const body = (typeof message.text === 'object')
                    ? { en: message.text.en || message.text.es || '', es: message.text.es || message.text.en || '' }
                    : message.text;
                for (const name of assignees) {
                    await taskNotify(name, kind === 'on_complete' ? 'task_completed' : 'task_message',
                        { en: titleEn, es: titleEs }, body, null, { allowSelf: true });
                }
            };

            const toggleCheckItem = async (taskId, parentTask) => {
                const cur = checksRef.current;
                const pKey = currentPrefix + taskId;
                const newVal = !cur[pKey];
                const newChecks = { ...cur, [pKey]: newVal };
                const patch = { [pKey]: newVal };
                if (newVal) {
                    const now = new Date();
                    const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                    newChecks[pKey + "_by"] = staffName;
                    newChecks[pKey + "_at"] = timeStr;
                    patch[pKey + "_by"] = staffName;
                    patch[pKey + "_at"] = timeStr;
                } else {
                    delete newChecks[pKey + "_by"];
                    delete newChecks[pKey + "_at"];
                    patch[pKey + "_by"] = undefined;  // → deleteField
                    patch[pKey + "_at"] = undefined;
                }
                // Optimistic local + granular dotted-path write so concurrent
                // toggles by other users don't clobber each other.
                setChecks(newChecks);
                await writeCheckPatch(patch);
                // If checking ON and the parent task has a follow-up, check if task is now complete
                if (newVal && parentTask && parentTask.followUp && parentTask.followUp.question) {
                    const allDone = parentTask.subtasks && parentTask.subtasks.length > 0
                        ? parentTask.subtasks.every(s => (currentPrefix + s.id) === pKey ? newVal : newChecks[currentPrefix + s.id])
                        : true;
                    if (allDone) setShowFollowUpFor(parentTask.id);
                }
                // Task-completed push: if the task carries any deferred messages
                // (deliverWhen === 'on_complete'), dispatch them now to all
                // assignees. Only fires when we just turned the task ON, and
                // only when ALL subtasks are done (or no subtasks).
                if (newVal) {
                    const taskObj = parentTask || (() => {
                        // top-level task — find it in customTasks
                        const list = (customTasksRef.current[checklistSide] && customTasksRef.current[checklistSide][PERIOD_KEY]) || [];
                        return list.find(t => t.id === taskId);
                    })();
                    if (taskObj) {
                        const allSubDone = taskObj.subtasks && taskObj.subtasks.length > 0
                            ? taskObj.subtasks.every(s => newChecks[currentPrefix + s.id])
                            : true;
                        if (allSubDone) {
                            const queued = (taskObj.messages || []).filter(m => m.deliverWhen === 'on_complete' && !m.delivered);
                            for (const m of queued) {
                                await dispatchTaskMessage(taskObj, m, 'on_complete');
                            }
                            // Mark these messages as delivered so re-checking the
                            // task tomorrow doesn't re-fire them.
                            if (queued.length > 0) {
                                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                                const list = updated[checklistSide][PERIOD_KEY] || [];
                                const tIdx = list.findIndex(t => t.id === taskObj.id);
                                if (tIdx >= 0) {
                                    list[tIdx].messages = (list[tIdx].messages || []).map(m =>
                                        m.deliverWhen === 'on_complete' && !m.delivered ? { ...m, delivered: true, deliveredAt: new Date().toISOString() } : m
                                    );
                                    setCustomTasks(updated);
                                    // checks were already written by writeCheckPatch in the parent
                                    // toggleCheckItem path — only customTasks needs persisting here
                                    // (the delivered: true flag on the messages array).
                                    await writeChecklistPatch({ customTasks: updated });
                                }
                            }
                        }
                    }
                }
            };

            // Save a follow-up answer
            const saveFollowUpAnswer = async (taskId, answer) => {
                const pKey = currentPrefix + taskId;
                const newChecks = { ...checksRef.current, [pKey + "_followUp"]: answer };
                setChecks(newChecks);
                setFollowUpAnswers(prev => ({ ...prev, [taskId]: answer }));
                setShowFollowUpFor(null);
                await writeCheckPatch({ [pKey + "_followUp"]: answer });
            };

            // ── Skip-with-reason ──
            // Marks a task (or sub-task item) as "skipped" rather than "done".
            // Stored as parallel keys on the same `checks` object so we don't
            // need a schema migration: pKey + "_skipped" → reason id, plus the
            // existing _by / _at fields, plus _skipNote for "other".
            // History view (and stats) can then distinguish skipped from forgotten.
            const skipTask = async (taskId, reasonId, note) => {
                const cur = checksRef.current;
                const pKey = currentPrefix + taskId;
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                const newChecks = {
                    ...cur,
                    [pKey]: false,
                    [pKey + "_skipped"]: reasonId,
                    [pKey + "_by"]: staffName,
                    [pKey + "_at"]: timeStr,
                };
                const patch = {
                    [pKey]: false,
                    [pKey + "_skipped"]: reasonId,
                    [pKey + "_by"]: staffName,
                    [pKey + "_at"]: timeStr,
                };
                if (note) { newChecks[pKey + "_skipNote"] = note; patch[pKey + "_skipNote"] = note; }
                else { delete newChecks[pKey + "_skipNote"]; patch[pKey + "_skipNote"] = undefined; }
                setChecks(newChecks);
                await writeCheckPatch(patch);
            };

            const unskipTask = async (taskId) => {
                const cur = checksRef.current;
                const pKey = currentPrefix + taskId;
                const newChecks = { ...cur };
                delete newChecks[pKey + "_skipped"];
                delete newChecks[pKey + "_skipNote"];
                delete newChecks[pKey + "_by"];
                delete newChecks[pKey + "_at"];
                setChecks(newChecks);
                await writeCheckPatch({
                    [pKey + "_skipped"]: undefined,
                    [pKey + "_skipNote"]: undefined,
                    [pKey + "_by"]: undefined,
                    [pKey + "_at"]: undefined,
                });
            };

            // Quick-add — one-shot task creation from a single input.
            // Syntax: "Wipe register ; spray ; wipe ; dry"  →  task "Wipe register"
            //         with subtasks ["spray", "wipe", "dry"]. The first segment
            //         is the title, all subsequent `; foo` segments become subtasks.
            // Inherits the category from `categoryFilter` if it's not "all", else "other".
            // Stable, collision-resistant ID. Date.now() alone collides if two
            // admins click "Add" in the same millisecond, AND it's not stable
            // when subtask order changes. Append a short random suffix.
            const newTaskId = (sidePrefix) => sidePrefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            const newSubtaskId = () => "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

            // Preserve existing subtask IDs when editing — only mint a new ID
            // for genuinely new subtasks. Stops "edit reorders subtasks → all
            // checks visually un-complete" from happening because the keys in
            // the `checks` map are anchored to ids, not array index.
            const reconcileSubtasks = (cleanSubs) => cleanSubs.map((s) => ({
                id: s.id || newSubtaskId(),
                task: s.task.trim(),
            }));

            const quickAddTask = async () => {
                const text = quickAddText.trim();
                if (!text) return;
                const parts = text.split(/\s*;\s*/).filter(p => p.length > 0);
                if (parts.length === 0) return;
                const item = {
                    id: newTaskId(checklistSide),
                    task: parts[0],
                };
                const cat = categoryFilter !== "all" ? categoryFilter : "other";
                if (cat !== "other") item.category = cat;
                if (parts.length > 1) {
                    item.subtasks = parts.slice(1).map((p) => ({ id: newSubtaskId(), task: p }));
                }
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                if (!updated[checklistSide]) updated[checklistSide] = {};
                if (!updated[checklistSide][PERIOD_KEY]) updated[checklistSide][PERIOD_KEY] = [];
                updated[checklistSide][PERIOD_KEY].push(item);
                setCustomTasks(updated);
                await writeChecklistPatch({ customTasks: updated });
                setQuickAddText("");
            };

            const addChecklistTask = async () => {
                if (!newTask.trim()) return;
                const item = { id: newTaskId(checklistSide), task: newTask.trim() };
                if (newCategory && newCategory !== "other") item.category = newCategory;
                if (newRecurrence && newRecurrence !== "daily") item.recurrence = newRecurrence;
                if (newRequirePhoto) item.requirePhoto = true;
                if (newCompleteBy) item.completeBy = newCompleteBy;
                const newAssignArr = Array.isArray(newAssignTo) ? newAssignTo : newAssignTo ? [newAssignTo] : [];
                if (newAssignArr.length > 0) item.assignTo = newAssignArr;
                if (newFollowUp && newFollowUp.question.trim()) {
                    item.followUp = { type: newFollowUp.type, question: newFollowUp.question.trim() };
                    if (newFollowUp.type === "dropdown" && newFollowUp.options.length > 0) {
                        item.followUp.options = newFollowUp.options.filter(o => o.trim());
                    }
                }
                const cleanSubs = newSubtasks.filter(s => s.task.trim());
                if (cleanSubs.length > 0) item.subtasks = reconcileSubtasks(cleanSubs);
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                if (!updated[checklistSide]) updated[checklistSide] = {};
                if (!updated[checklistSide][PERIOD_KEY]) updated[checklistSide][PERIOD_KEY] = [];
                updated[checklistSide][PERIOD_KEY].push(item);
                setCustomTasks(updated);
                await writeChecklistPatch({ customTasks: updated });
                setNewTask(""); setNewCategory("other"); setNewRecurrence("daily"); setNewRequirePhoto(false); setNewSubtasks([]); setNewCompleteBy(""); setNewAssignTo([]); setNewFollowUp(null); setShowAddForm(false);
            };

            const saveChecklistEdit = async (idx) => {
                if (!editTask.trim()) return;
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                const item = updated[checklistSide][PERIOD_KEY][idx];
                item.task = editTask.trim();
                if (editCategory && editCategory !== "other") { item.category = editCategory; } else { delete item.category; }
                if (editRecurrence && editRecurrence !== "daily") { item.recurrence = editRecurrence; } else { delete item.recurrence; }
                item.requirePhoto = editRequirePhoto;
                if (editCompleteBy) { item.completeBy = editCompleteBy; } else { delete item.completeBy; }
                const assignArr = Array.isArray(editAssignTo) ? editAssignTo : editAssignTo ? [editAssignTo] : [];
                if (assignArr.length > 0) { item.assignTo = assignArr; } else { delete item.assignTo; }
                if (editFollowUp && editFollowUp.question.trim()) {
                    item.followUp = { type: editFollowUp.type, question: editFollowUp.question.trim() };
                    if (editFollowUp.type === "dropdown" && editFollowUp.options.length > 0) {
                        item.followUp.options = editFollowUp.options.filter(o => o.trim());
                    }
                } else { delete item.followUp; }
                const cleanSubs = editSubtasks.filter(s => s.task.trim());
                if (cleanSubs.length > 0) { item.subtasks = reconcileSubtasks(cleanSubs); } else { delete item.subtasks; }
                setCustomTasks(updated);
                await writeChecklistPatch({ customTasks: updated });
                setEditingIdx(null); setEditTask(""); setEditCategory("other"); setEditRecurrence("daily"); setEditRequirePhoto(false); setEditSubtasks([]); setEditCompleteBy(""); setEditAssignTo([]); setEditFollowUp(null);
            };

            // Photo capture and upload
            const handlePhotoCapture = async (e, taskId) => {
                const file = e.target.files?.[0];
                // Reset the input so the same file can be reselected after a failed upload.
                if (e.target) e.target.value = "";
                if (!file) return;
                // 2026-05-30 audit fix — early-reject oversize photos. The
                // storage rule caps at 10 MB but a 50 MB iPhone photo would
                // tie up the upload spinner for minutes on cellular before
                // the rule rejected it. Matches the limit in MaintenanceRequest.
                if (file.size > 10 * 1024 * 1024) {
                    toast(language === 'es'
                        ? 'La foto es muy grande (máx 10 MB)'
                        : 'Photo is too large (max 10 MB)',
                        { kind: 'error' });
                    return;
                }
                // Re-entry guard: a rapid second tap (mobile Safari double-fire) must not start a parallel upload.
                // FIX (2026-05-14): ref instead of state — see comment on photoUploadInProgressRef.
                if (photoUploadInProgressRef.current) return;
                photoUploadInProgressRef.current = true;
                setCapturingPhoto(taskId);
                const todayKey = getTodayKey();
                const photoRef = ref(storage, "checklist-photos/" + todayKey + "/" + taskId + "_" + Date.now() + ".jpg");
                let uploaded = false;
                try {
                    await uploadBytes(photoRef, file);
                    uploaded = true;
                    const url = await getDownloadURL(photoRef);
                    const pKey = currentPrefix + taskId;
                    const photoTime = new Date().toISOString();
                    // Optimistic local + granular dotted-path write.
                    setChecks({
                        ...checksRef.current,
                        [pKey + "_photo"]: url,
                        [pKey + "_photoTime"]: photoTime,
                    });
                    await writeCheckPatch({
                        [pKey + "_photo"]: url,
                        [pKey + "_photoTime"]: photoTime,
                    });
                } catch (err) {
                    console.error("Error uploading photo:", err);
                    // 2026-05-30 audit — surface to staff. Photo uploads
                    // are the highest-stakes silent failure: the staffer
                    // already took the photo, tapped Upload, and would
                    // walk away assuming it was attached. Now they know.
                    toast(language === 'es'
                        ? '⚠ No se pudo subir la foto. Intenta de nuevo.'
                        : '⚠ Could not upload the photo. Please try again.',
                        { kind: 'error' });
                    // If we successfully uploaded the file but the Firestore
                    // write failed, the storage object is orphaned (no DB
                    // reference). Delete it so we don't accumulate dead bytes.
                    if (uploaded) {
                        try { await deleteObject(photoRef); }
                        catch (cleanupErr) { console.warn("Photo orphan cleanup failed:", cleanupErr); }
                    }
                    // 2026-05-30 audit fix — removed second toast call here
                    // (was "Error al subir foto" / "Error uploading photo"),
                    // duplicate of the bilingual toast already fired above.
                }
                setCapturingPhoto(null);
                photoUploadInProgressRef.current = false;
            };

            // Reorder a task within its period array. fromIdx / toIdx are
            // both indices into the ORIGINAL customTasks[side][period] array
            // (i.e. `_origIdx` values from the rendered list). Swaps them
            // and persists. Used by the up/down arrow buttons that show on
            // each task card in edit mode — even though tasks have times,
            // Andrew wants control over the visual order for setup/grouping.
            const moveChecklistTask = async (fromIdx, toIdx) => {
                const tasks = customTasksRef.current;
                if (!tasks?.[checklistSide]?.[PERIOD_KEY]) return;
                const updated = JSON.parse(JSON.stringify(tasks));
                const arr = updated[checklistSide][PERIOD_KEY];
                if (fromIdx < 0 || toIdx < 0 || fromIdx >= arr.length || toIdx >= arr.length) return;
                [arr[fromIdx], arr[toIdx]] = [arr[toIdx], arr[fromIdx]];
                setCustomTasks(updated);
                await writeChecklistPatch({ customTasks: updated });
            };

            // Andrew 2026-05-21: "the arrow button when pressed the
            // task moves up and not in range of the mouse arrow. make
            // it so when uparrow is clicked it the whole list moves
            // down and the item and where the mouse click is in the
            // same spot". Wraps moveChecklistTask: captures the moved
            // task's screen-Y before the swap, then after React
            // commits the new DOM, scrolls the window by the delta so
            // the task ends up at the same screen position. Net
            // result: rapid up-arrow clicks all land on the same
            // button without the user chasing it up the page.
            const moveChecklistTaskWithScroll = (fromIdx, toIdx, taskId) => {
                if (typeof document === 'undefined') {
                    moveChecklistTask(fromIdx, toIdx);
                    return;
                }
                const card = document.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`);
                const beforeTop = card ? card.getBoundingClientRect().top : null;
                moveChecklistTask(fromIdx, toIdx);
                if (beforeTop == null) return;
                // Two rAFs: first to wait for React commit, second to
                // wait for the browser to lay out post-commit. After
                // that, getBoundingClientRect reflects the new
                // position.
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const after = document.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`);
                        if (!after) return;
                        const afterTop = after.getBoundingClientRect().top;
                        const delta = afterTop - beforeTop;
                        // Skip if the move happened in a scroll
                        // container we can't predict, or if the delta
                        // is essentially zero (item didn't visibly move
                        // — happens at the list edges).
                        if (Math.abs(delta) < 1) return;
                        // Scroll the WINDOW by the delta. If the task
                        // moved up (afterTop < beforeTop), delta is
                        // negative, scrollBy with negative scrolls UP,
                        // which moves content DOWN on screen — exactly
                        // what we need to bring the task back to the
                        // cursor's original Y.
                        window.scrollBy({ top: delta, behavior: 'auto' });
                    });
                });
            };

            const deleteChecklistTask = async (idx) => {
                const tasks = customTasksRef.current;
                const removed = tasks?.[checklistSide]?.[PERIOD_KEY]?.[idx];
                const updated = JSON.parse(JSON.stringify(tasks));
                updated[checklistSide][PERIOD_KEY].splice(idx, 1);
                setCustomTasks(updated);

                // Also strip orphaned check entries (and any subtask entries +
                // photo metadata + comments). Otherwise the manager dashboard
                // keeps counting completions for deleted tasks, and storage
                // photos linger.
                if (removed) {
                    const orphanIds = new Set();
                    orphanIds.add(removed.id);
                    if (Array.isArray(removed.subtasks)) {
                        for (const s of removed.subtasks) orphanIds.add(s.id);
                    }
                    const cur = checksRef.current;
                    const newChecks = { ...cur };
                    const photoKeysToDelete = [];
                    // 2026-05-24 audit fix: track deletions for atomic
                    // dot-path removal instead of overwriting the whole
                    // checks map (which would clobber any concurrent
                    // check-mark a cook is making elsewhere).
                    const checkDeletions = {};
                    for (const key of Object.keys(cur)) {
                        // Match `${currentPrefix}${taskId}` and any `_by`/`_at`/`_photo`/etc. variants.
                        for (const tid of orphanIds) {
                            if (key === currentPrefix + tid || key.startsWith(currentPrefix + tid + "_")) {
                                if (key.endsWith("_photo")) photoKeysToDelete.push(cur[key]);
                                delete newChecks[key];
                                checkDeletions[key] = undefined;   // writeCheckPatch → deleteField()
                                break;
                            }
                        }
                    }
                    setChecks(newChecks);
                    // Clean up Firebase Storage photo objects too.
                    for (const url of photoKeysToDelete) {
                        try {
                            const photoRef = ref(storage, url);
                            await deleteObject(photoRef);
                        } catch (e) {
                            // URL might be expired or the storage rule denies; log & continue.
                            console.warn("Photo cleanup failed for", url, e);
                        }
                    }
                    if (Object.keys(checkDeletions).length > 0) {
                        await writeCheckPatch(checkDeletions);
                    }
                    await writeChecklistPatch({ customTasks: updated });
                } else {
                    await writeChecklistPatch({ customTasks: updated });
                }
            };

            const resetAllChecklists = async () => {
                if (!confirm(language === "es" ? "¿Guardar y reiniciar todas las tareas?" : "Save & reset all checklists?")) return;
                const todayKey = getTodayKey();
                const now = new Date().toISOString();
                try {
                    await setDoc(doc(db, "checklistHistory_" + storeLocation, todayKey + "_saved"), {
                        checks: cleanForFirestore(checksRef.current), customTasks: cleanForFirestore(customTasksRef.current), assignments: cleanForFirestore(checklistAssignments), lists: cleanForFirestore(checklistListsRef.current), date: now, savedBy: staffName
                    });
                } catch (err) { console.error("Error saving history:", err); }
                setChecks({});
                // 2026-05-24 audit fix: was using saveChecklistState({}, customTasksRef.current)
                // which clobbered ALL 4 top-level fields. Reset only needs to
                // wipe `checks` — leave customTasks / assignments / lists intact.
                await writeChecklistPatch({ checks: {} });
            };

            const saveInventorySnapshot = async (counts, items) => {
                const now = new Date();
                const key = now.toISOString().split("T")[0] + "_" + now.toTimeString().split(" ")[0].replace(/:/g, "");
                // Only save items that have a count > 0 (shopping cart style)
                const cleanCounts = {};
                Object.entries(counts).forEach(([k, v]) => { if (v && v > 0) cleanCounts[k] = v; });
                // Filter categories to only include items with counts
                const filteredItems = items.map(cat => ({
                    category: cat.category || cat.name || "",
                    items: cat.items.filter(i => cleanCounts[i.id]).map(i => ({ id: i.id, name: i.name, nameEs: i.nameEs || "", vendor: i.vendor || i.supplier || "", supplier: i.vendor || i.supplier || "", orderDay: i.orderDay || "", pack: i.pack || "", price: i.price || null }))
                })).filter(cat => cat.items.length > 0);
                // Filter countMeta to only include items with counts
                const cleanMeta = {};
                Object.entries(invCountMeta).forEach(([k, v]) => { if (cleanCounts[k]) cleanMeta[k] = v; });
                try {
                    await setDoc(doc(db, "inventoryHistory_" + storeLocation, key), {
                        counts: cleanCounts,
                        items: filteredItems,
                        countMeta: cleanMeta,
                        date: now.toISOString(),
                        listName: "",
                        ordered: {}
                    });
                    // Refresh the per-item "last ordered" summary so the
                    // badge under each item updates without a page reload.
                    reloadLastEnteredByItem().catch(() => {});
                } catch (err) {
                    console.error("Error saving inventory snapshot:", err);
                    // 2026-05-30 audit fix — previously a silent console
                    // failure. Inventory snapshot save is high-stakes: if
                    // it doesn't land, the staffer thinks the count was
                    // archived to history but it's lost on next session.
                    toast(language === 'es'
                        ? '⚠ No se pudo guardar el inventario. Intenta de nuevo.'
                        : '⚠ Could not save the inventory snapshot. Please try again.',
                        { kind: 'error' });
                }
            };

            // updateInventoryCount(itemId, newCount, delta?)
            //
            // newCount: the post-update absolute value (used by the
            //   text-input onChange — typing "24" jumps the count to
            //   24 outright). Ignored when `delta` is ±1.
            // delta: optional. If +1 / -1 is passed, we write via
            //   FieldValue.increment so two simultaneous +1 taps from
            //   different devices BOTH land (AUDIT OPS-004 fix), AND
            //   we compute the next local count from the latest state
            //   via a functional setInventory — see race-fix below.
            //
            // Race-fix history:
            //
            // 2026-05-17 — every call wrote `counts.${itemId} = newCount`
            // as an absolute value. If two staff +1'd the same item
            // between snapshot ticks, both read prev=5 from local state,
            // both wrote 6 → one +1 lost. Fixed with FieldValue.increment.
            //
            // 2026-05-22 — Andrew: "glitchy adding items to the cart,
            // sometimes its slower." Same-device rapid-tap race that the
            // 5-17 increment fix didn't cover. The +/- buttons compute
            // `count` from render-time closure (`const count = inventory
            // [item.id] || 0`) and pass `count + 1` in. If the user
            // tapped + twice before React committed the next render,
            // BOTH click handlers saw the same `count` and called
            // updateInventoryCount with the same `newCount`. Inside,
            // `const prevCount = inventory[itemId]` ALSO read stale
            // closure state, and `setInventory({ ...inventory, [id]:
            // count })` spread stale state with an absolute value. So
            // local stayed at 1 across two fast taps while Firestore
            // (correctly, via increment) ticked to 2. The snapshot
            // listener then jumped local from 1 → 2 a beat late =
            // visible "glitch."
            //
            // Fix: use functional setInventory + setInvCountMeta so the
            // setter callback gets the LATEST committed state, then
            // recompute next from prev when a delta is supplied. The
            // absolute-set path (text input) is unaffected. Also
            // fire-and-forget the audit doc write so rapid taps don't
            // pile up awaiting two writes per click (audit is best-
            // effort by design — the comment below already noted that).
            // Push notification fan-out when an item crosses its
            // low-stock threshold. Andrew 2026-05-23 audit follow-up.
            // Argument shape mirrors the call site: { itemId,
            // prevCount, nextCount, delta }. We resolve the item's
            // `min` field from customInventory (the same source of
            // truth the per-item indicator reads), then check the
            // SPECIFIC crossing condition:
            //
            //   prevCount > min && nextCount <= min && nextCount > 0
            //
            // The `> 0` clause excludes "ran out completely" because
            // the 86 board flow already handles that path. We focus
            // on the "we're getting low — order more" case.
            //
            // Recipients: managers of this location + admins. Same
            // fan-out pattern as the up-for-grabs broadcast — one
            // /notifications doc per recipient, dispatchNotification
            // CF handles FCM delivery.
            const notifyLowStockIfCrossed = async ({ itemId, prevCount, nextCount, delta }) => {
                if (!itemId) return;
                if (!(delta < 0)) return;            // only on decrements
                if (nextCount <= 0) return;          // out, not low — different alert class
                // Find the item to read its min + display name.
                let item = null;
                for (const cat of customInventory || []) {
                    const f = (cat.items || []).find(it => it.id === itemId);
                    if (f) { item = f; break; }
                }
                if (!item) return;
                const min = Number(item.min);
                if (!Number.isFinite(min) || min <= 0) return;
                if (!(prevCount > min && nextCount <= min)) return;
                // Eligible recipients — admins (ID 40/41) + managers
                // at this location. Skip the staffer who triggered
                // the save so they don't get pinged about their own
                // count change.
                const targets = (staffList || []).filter(s => {
                    if (!s?.name) return false;
                    if (s.name === staffName) return false;
                    if (isAdminId(s.id)) return true;
                    if (s.role && /manager/i.test(s.role)) {
                        return !s.location || s.location === storeLocation || s.location === 'both';
                    }
                    return false;
                });
                if (targets.length === 0) return;
                const itemName = item.name || item.nameEn || itemId;
                const locLabel = storeLocation === 'maryland' ? 'MD Heights' : 'Webster';
                for (const t of targets) {
                    try {
                        await addDoc(collection(db, 'notifications'), {
                            forStaff: t.name,
                            type: 'inventory_low_stock',
                            title: {
                                en: `📉 ${itemName} is low (${nextCount} left, min ${min})`,
                                es: `📉 ${itemName} bajo (quedan ${nextCount}, mín ${min})`,
                            },
                            body: {
                                en: `${locLabel} inventory — time to add to the next order.`,
                                es: `Inventario ${locLabel} — agrega al próximo pedido.`,
                            },
                            createdAt: serverTimestamp(),
                            read: false,
                            location: storeLocation,
                            itemId,
                            itemName,
                            nextCount,
                            min,
                        });
                    } catch (e) {
                        console.warn('low-stock notify failed for', t.name, e);
                    }
                }
            };

            const updateInventoryCount = async (itemId, newCount, delta = null) => {
                const count = parseInt(newCount) || 0;
                const isDelta = delta === 1 || delta === -1;
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

                // Per-item sync indicator — Andrew 2026-05-23 audit
                // follow-up. Counts were optimistic-updated locally but
                // the Firestore round-trip was invisible to the user, so
                // a save that silently failed left them looking at a
                // wrong count thinking it was saved. Now: flip the item
                // to "saving" the moment a tap fires, "saved" on
                // success, "error" on failure. The badge in the
                // inventory grid reads this map and shows a tiny dot.
                // Auto-clears the "saved" state 2s later so the grid
                // doesn't stay decorated forever.
                setInventorySyncStatus(prev => ({ ...prev, [itemId]: 'saving' }));

                // Capture prev/next inside the functional setter so rapid
                // taps don't read stale closure state. These vars are
                // populated synchronously by the setState callback —
                // they're ready to use right after setInventory returns.
                let prevCount = 0;
                let nextCount = count;
                let skipped = false;
                setInventory(prev => {
                    prevCount = prev[itemId] || 0;
                    if (isDelta) nextCount = prevCount + delta;
                    else nextCount = count;
                    // Decrement guard: if user is decrementing and the
                    // latest state says 0, no-op. (Moved inside the
                    // functional setter so the check sees fresh state,
                    // not stale closure inventory.)
                    if (delta === -1 && prevCount <= 0) {
                        skipped = true;
                        return prev;
                    }
                    return { ...prev, [itemId]: nextCount };
                });
                if (skipped) return;

                setInvCountMeta(prev => {
                    if (nextCount === 0) {
                        const next = { ...prev };
                        delete next[itemId];
                        return next;
                    }
                    return { ...prev, [itemId]: { by: staffName, at: timeStr } };
                });

                // ── Audit trail (best-effort, fire-and-forget) ──────
                // Every count change writes an immutable row to
                // inventory_audits_{location}. Use case Andrew flagged:
                // "why weren't eggs ordered but it was on the list before"
                // — with many hands on the inventory page, individual
                // tweaks (someone bumping eggs down then forgetting) can
                // be reconstructed. Audit is append-only via rules.
                //
                // 2026-05-22: stopped awaiting the addDoc here. Awaiting
                // it serialized two Firestore writes per +1 tap (audit,
                // then main update), so rapid tapping felt sluggish. The
                // audit doc isn't user-visible — fire-and-forget is fine.
                if (prevCount !== nextCount) {
                    try {
                        // Resolve a human-readable item name for the audit row
                        // so future renames don't make the log inscrutable.
                        // O(1) via the memoized invLookup instead of scanning
                        // all ~243 items on every count tap.
                        const f = invLookup[itemId];
                        const itemName = (f && (f.nameEn || f.name)) || itemId;
                        addDoc(collection(db, 'inventory_audits_' + storeLocation), {
                            itemId,
                            itemName,
                            previous: prevCount,
                            next: nextCount,
                            delta: nextCount - prevCount,
                            byStaff: staffName,
                            at: serverTimestamp(),
                            atLocal: timeStr,
                            dateKey: now.toISOString().slice(0, 10),
                        }).catch(e => console.warn('inventory audit write failed', e));
                    } catch (e) {
                        console.warn('inventory audit write failed', e);
                    }
                }

                const ref = doc(db, "ops", "inventory_" + storeLocation);
                // Targeted update via dotted paths so concurrent edits on other items aren't clobbered.
                // When a delta is provided (+1 / -1 from the bump buttons), use
                // Firestore's atomic FieldValue.increment so simultaneous taps
                // from two devices both land. Falls back to absolute set for
                // the text-input path.
                const update = {
                    // +1 uses atomic increment so two devices adding both land. But
                    // DECREMENT uses a clamped ABSOLUTE write (nextCount, already >=0
                    // because the prevCount<=0 guard blocked the step): Firestore's
                    // increment() has NO floor, so a -1 on a (locally-lagged) value
                    // could drive the server count to -1. Absolute-clamped can't.
                    [`counts.${itemId}`]: !isDelta ? count
                        : delta > 0 ? increment(delta)
                            : Math.max(0, nextCount),
                    [`countMeta.${itemId}`]: nextCount === 0 ? deleteField() : { by: staffName, at: timeStr },
                    date: new Date().toISOString(),
                };
                try {
                    await updateDoc(ref, update);
                    // Flip to "saved" and schedule a clear so the grid
                    // settles back to neutral. The 2s window is long
                    // enough that a user finishing a rapid +1+1+1 burst
                    // sees the green confirmation, short enough that
                    // the next interaction starts from a clean slate.
                    setInventorySyncStatus(prev => ({ ...prev, [itemId]: 'saved' }));
                    setTimeout(() => {
                        setInventorySyncStatus(prev => {
                            if (prev[itemId] !== 'saved') return prev;
                            const next = { ...prev };
                            delete next[itemId];
                            return next;
                        });
                    }, 2000);
                    // Low-stock threshold-cross push. Fires when an
                    // item dropped FROM above-min TO at-or-below
                    // min on this save. Threshold-crossing semantics
                    // (rather than "below min" predicate) naturally
                    // dedups: bumping count from 2→1 when min=3
                    // doesn't re-spam because we were already below.
                    // Only fires for the negative direction — going
                    // up never triggers an alert. Fire-and-forget;
                    // a failed notification doesn't block the save.
                    notifyLowStockIfCrossed({
                        itemId,
                        prevCount,
                        nextCount,
                        delta: nextCount - prevCount,
                    }).catch(() => {});
                } catch (err) {
                    // Doc may not exist yet on first write to a fresh location.
                    if (err?.code === "not-found") {
                        try {
                            // Rebuild the full counts/meta map from the latest
                            // local state (read via the functional setter
                            // pattern so we don't snapshot stale closure).
                            let fullCounts = {};
                            let fullMeta = {};
                            setInventory(prev => { fullCounts = prev; return prev; });
                            setInvCountMeta(prev => { fullMeta = prev; return prev; });
                            await setDoc(ref, { counts: fullCounts, countMeta: fullMeta, customInventory, date: new Date().toISOString() });
                            setInventorySyncStatus(prev => ({ ...prev, [itemId]: 'saved' }));
                            setTimeout(() => {
                                setInventorySyncStatus(prev => {
                                    if (prev[itemId] !== 'saved') return prev;
                                    const next = { ...prev };
                                    delete next[itemId];
                                    return next;
                                });
                            }, 2000);
                        } catch (e) {
                            console.error("Error creating inventory:", e);
                            setInventorySyncStatus(prev => ({ ...prev, [itemId]: 'error' }));
                        }
                    } else {
                        console.error("Error updating inventory:", err);
                        // Sticky error state — no auto-clear. Stays
                        // visible until the user successfully retries
                        // the change, so a silently-failed save can't
                        // hide behind subsequent successful ones.
                        setInventorySyncStatus(prev => ({ ...prev, [itemId]: 'error' }));
                    }
                }
            };

            // Stable-identity wrapper for the inventory rows. updateInventoryCount
            // is recreated every Operations render (it closes over staffName /
            // storeLocation / customInventory), which silently defeated the
            // React.memo on the ~250 LocationItemRow rows — every count tap
            // re-rendered ALL rows. A ref holds the latest fn; this wrapper's
            // identity never changes, so memo'd rows only re-render when THEIR
            // own props change. Behavior is identical (it calls the latest
            // closure). Audit 2026-06-09.
            const updateInventoryCountRef = useRef(null);
            updateInventoryCountRef.current = updateInventoryCount;
            const stableUpdateInventoryCount = useCallback((itemId, newCount, delta = null) => {
                return updateInventoryCountRef.current?.(itemId, newCount, delta);
            }, []);

            // Load + recompute the "last ordered per item" summary from
            // the inventoryHistory collection. Walks every snapshot
            // newest-first; for each itemId records the FIRST non-zero
            // count it sees (i.e. the most recent date that item was
            // entered with qty > 0). Capped at the most recent 30
            // snapshots for performance — same window InventoryHistory.jsx
            // uses for its date picker.
            //
            // Called on mount + after every saveInventorySnapshot so a
            // fresh save updates the per-item badge right away.
            const reloadLastEnteredByItem = useCallback(async () => {
                if (!storeLocation) return;
                try {
                    // Perf-fix 2026-05-22: query-side limit + orderBy so we
                    // only download the 30 most-recent snapshots, not the
                    // entire history collection. Originally used
                    // orderBy('__name__', 'desc') but Firestore auto-indexes
                    // __name__ ASCENDING only — desc requires a manual
                    // composite index. Andrew hit the missing-index error on
                    // 2026-05-23 in RecentOrdersBar (same pattern). Swapping
                    // to orderBy('date', 'desc'): single-field indexes
                    // auto-create both directions, no manual setup. The
                    // `date` field is set as an ISO string on every save
                    // (see saveInventorySnapshot) and sorts lexicographically
                    // the same as chronologically.
                    const colRef = collection(db, "inventoryHistory_" + storeLocation);
                    const snap = await getDocs(query(colRef, orderBy('date', 'desc'), limit(30)));
                    const slice = snap.docs.map(d => ({ id: d.id, ...d.data() }));
                    const summary = {};
                    const vendorImports = {};
                    // Per-item rolling history of non-zero qtys for
                    // the smart-order average. We collect up to 6
                    // most-recent data points per item (walking
                    // newest-first via the limit(30) snapshot scan),
                    // then average them in the post-loop pass below.
                    const qtyHistory = {};
                    const SUGGEST_SAMPLE_SIZE = 6;
                    for (const d of slice) {
                        const counts = d.counts || {};
                        const iso = d.date || (d.id ? d.id.slice(0, 10) : null);
                        const dt = iso ? new Date(iso) : null;
                        const dateLabel = (dt && !isNaN(dt))
                            ? dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
                            : (d.id || '');
                        for (const [itemId, qty] of Object.entries(counts)) {
                            const n = Number(qty);
                            if (n > 0) {
                                if (!summary[itemId]) {
                                    summary[itemId] = { date: dateLabel, qty: n, dateIso: iso };
                                }
                                // Append to the rolling sample, cap
                                // at SUGGEST_SAMPLE_SIZE. We're walking
                                // newest-first so the first N we see
                                // are the freshest.
                                if (!qtyHistory[itemId]) qtyHistory[itemId] = [];
                                if (qtyHistory[itemId].length < SUGGEST_SAMPLE_SIZE) {
                                    qtyHistory[itemId].push(n);
                                }
                            }
                        }
                        // Track the most recent import per vendor.
                        const fromVendor = d.importedFrom;
                        if (fromVendor && !vendorImports[fromVendor]) {
                            vendorImports[fromVendor] = {
                                dateIso: iso,
                                dateLabel,
                                fileName: typeof d.listName === 'string' ? d.listName : null,
                            };
                        }
                    }
                    // Average pass — round to nearest int (managers
                    // think in whole units, not decimals). Hide the
                    // suggestion when n < 2 to avoid a one-off order
                    // setting a fake baseline.
                    const suggestions = {};
                    for (const [itemId, qtys] of Object.entries(qtyHistory)) {
                        if (qtys.length < 2) continue;
                        const sum = qtys.reduce((s, x) => s + x, 0);
                        suggestions[itemId] = {
                            avg: Math.max(1, Math.round(sum / qtys.length)),
                            n: qtys.length,
                        };
                    }
                    setLastEnteredByItem(summary);
                    setSuggestedByItem(suggestions);
                } catch (err) {
                    console.warn('reloadLastEnteredByItem failed:', err);
                }
            }, [storeLocation]);

            // Load once when the location is known + whenever it changes.
            useEffect(() => { reloadLastEnteredByItem(); }, [reloadLastEnteredByItem]);

            // Count tracker for vendor-only items (those not matched to a master inventory item).
            // Same dotted-path pattern as updateInventoryCount so concurrent edits on
            // other items aren't clobbered.
            const updateVendorCount = async (vendor, vendorId, newCount) => {
                // 2026-06-20 (QA audit O3) — clamp to a non-negative integer.
                // `min="0"` on a type=number only governs the spinner, not typed/
                // pasted text, so "-5"/"3.7"/22-digit overflow used to persist
                // straight to Firestore (and a negative flowed into order math).
                // Mirror InventoryCountInput's digits-only, >=0 clamp.
                const count = Math.max(0, parseInt(newCount, 10) || 0);
                const key = `${vendor}:${vendorId}`;
                // 2026-06-16 (#21): functional setState (parity with
                // updateInventoryCount) so a concurrent edit on another vendor
                // key — or the onSnapshot reconcile — can't clobber this one in
                // local state from a stale closure. `next` is captured for the
                // not-found setDoc fallback below (the updater runs
                // synchronously inside this event handler).
                let next;
                setVendorCounts(prev => {
                    next = { ...prev };
                    if (count === 0) delete next[key];
                    else next[key] = count;
                    return next;
                });
                const ref = doc(db, "ops", "inventory_" + storeLocation);
                try {
                    await updateDoc(ref, {
                        [`vendorCounts.${key}`]: count === 0 ? deleteField() : count,
                        date: new Date().toISOString(),
                    });
                } catch (err) {
                    if (err?.code === "not-found") {
                        try {
                            await setDoc(ref, { vendorCounts: next, customInventory, date: new Date().toISOString() }, { merge: true });
                        } catch (e) {
                            console.error("Error creating inventory (vendorCounts):", e);
                            // 2026-05-30 audit — surface to staff so they
                            // don't think a cart add worked when it didn't.
                            toast(language === 'es'
                                ? '⚠ No se pudo guardar el conteo del proveedor.'
                                : '⚠ Could not save vendor count.',
                                { kind: 'error' });
                        }
                    } else {
                        console.error("Error updating vendor count:", err);
                        toast(language === 'es'
                            ? '⚠ No se pudo actualizar el conteo del proveedor.'
                            : '⚠ Could not update vendor count.',
                            { kind: 'error' });
                    }
                }
            };

            const saveAndResetInventory = async () => {
                setInventorySaving(true);
                try {
                    // Save snapshot to history
                    await saveInventorySnapshot(inventory, customInventory);
                    // Reset all counts to 0
                    const resetCounts = {};
                    customInventory.forEach(cat => {
                        cat.items.forEach(item => { resetCounts[item.id] = 0; });
                    });
                    setInventory(resetCounts);
                    setInvCountMeta({});
                    setVendorCounts({});
                    const ref = doc(db, "ops", "inventory_" + storeLocation);
                    // updateDoc replaces these top-level fields without touching customInventory or other fields,
                    // so a concurrent schema edit (add item, change vendor) on another tablet isn't clobbered.
                    try {
                        await updateDoc(ref, { counts: resetCounts, countMeta: {}, vendorCounts: {}, date: new Date().toISOString() });
                    } catch (err) {
                        if (err?.code === "not-found") {
                            await setDoc(ref, { counts: resetCounts, countMeta: {}, vendorCounts: {}, customInventory, date: new Date().toISOString() });
                        } else throw err;
                    }
                    // 2026-05-30 audit — confirm-on-success because the local
                    // state was already zeroed optimistically. Without the
                    // toast, a silent failure leaves the staffer staring at
                    // a fresh-looking page that wasn't actually persisted.
                    toast(language === 'es'
                        ? '✓ Inventario guardado y reiniciado'
                        : '✓ Inventory saved + reset',
                        { kind: 'success' });
                } catch (err) {
                    console.error("Error saving/resetting inventory:", err);
                    toast(language === 'es'
                        ? '⚠ Falló al guardar/reiniciar. Tu cuenta local se reinició pero NO se guardó — actualiza la página antes de seguir.'
                        : '⚠ Save+reset failed. Your local count was zeroed but did NOT save — refresh the page before continuing.',
                        { kind: 'error' });
                }
                setInventorySaving(false);
                setShowSaveConfirm(false);
            };

            // Clear ALL live counts (master inventory + vendor-only) without saving
            // a snapshot — the "Clear" twin of the Save button. Mirrors the cart's
            // Empty action but wipes vendorCounts too so it's a true clean slate.
            // Confirm-gated; persists counts:{} + vendorCounts:{} to the canonical
            // doc (updateDoc preserves customInventory + schema).
            const clearAllInventoryCounts = async () => {
                const masterN = Object.values(inventory).filter(v => v > 0).length;
                const vendorN = Object.values(vendorCounts).filter(v => v > 0).length;
                const total = masterN + vendorN;
                if (total === 0) {
                    toast(language === 'es' ? 'El conteo ya está vacío' : 'Counts are already empty');
                    return;
                }
                const ok = window.confirm(language === 'es'
                    ? `¿Limpiar todo el conteo (${total} artículos)? Esto no se puede deshacer. Guarda primero si quieres una copia.`
                    : `Clear all counts (${total} items)? This cannot be undone. Save first if you want a copy.`);
                if (!ok) return;
                setInventory({});
                setInvCountMeta({});
                setVendorCounts({});
                try {
                    await updateDoc(doc(db, "ops", "inventory_" + storeLocation), {
                        counts: {}, countMeta: {}, vendorCounts: {}, date: new Date().toISOString(),
                    });
                    toast(language === 'es' ? '✓ Conteo limpiado' : '✓ Counts cleared', { kind: 'success' });
                } catch (e) {
                    console.warn('clear counts persist failed:', e);
                    toast(language === 'es' ? 'Error al limpiar' : 'Could not clear', { kind: 'error' });
                }
            };

            // One-shot data healer: when the load merge had to rewrite ids (because a
            // category was renamed or moved between releases), persist the corrected
            // shape — customInventory with new ids, counts/countMeta keyed off the new
            // ids, and vendor_matches that pointed at the old ids redirected.
            // The fact that idMigration was non-empty in the load means duplicates were
            // forming on every render; saving is what actually breaks the cycle.
            const migrateInventoryIds = async (correctedInventory, idMigration, oldCounts, oldMeta) => {
                const newCounts = {};
                Object.entries(oldCounts).forEach(([oldId, val]) => {
                    newCounts[idMigration[oldId] || oldId] = val;
                });
                const newMeta = {};
                Object.entries(oldMeta).forEach(([oldId, val]) => {
                    newMeta[idMigration[oldId] || oldId] = val;
                });
                const ref = doc(db, "ops", "inventory_" + storeLocation);
                await updateDoc(ref, {
                    customInventory: correctedInventory,
                    counts: newCounts,
                    countMeta: newMeta,
                    date: new Date().toISOString(),
                });
                // Redirect any vendor matches whose value points at an old id.
                const vmRef = doc(db, "config", "vendor_matches");
                const vmSnap = await getDoc(vmRef);
                if (vmSnap.exists()) {
                    const vm = vmSnap.data();
                    const updates = {};
                    for (const vendor of Object.keys(vm)) {
                        for (const [vendorId, invId] of Object.entries(vm[vendor] || {})) {
                            if (idMigration[invId]) {
                                updates[`${vendor}.${vendorId}`] = idMigration[invId];
                            }
                        }
                    }
                    if (Object.keys(updates).length > 0) {
                        await updateDoc(vmRef, updates);
                    }
                }
                // MED-5, 2026-05-30: removed [idMigration] console.log left
                // in production after the one-shot heal migration shipped.
            };

            const inventoryDocRef = () => doc(db, "ops", "inventory_" + storeLocation);
            // Race-safe inventory mutator. Pass a transformer (currentList) => newList
            // and the transaction reads the LIVE customInventory, applies the change,
            // and writes back atomically. If another tablet wrote between our read and
            // our write, Firestore retries the transformer against the fresh data —
            // no more silent overwrites when two managers edit at once.
            const mutateInventory = async (transformer) => {
                try {
                    const next = await runTransaction(db, async (txn) => {
                        const snap = await txn.get(inventoryDocRef());
                        const live = (snap.exists() && Array.isArray(snap.data()?.customInventory))
                            ? snap.data().customInventory
                            : customInventory;
                        const updated = transformer(live);
                        txn.set(inventoryDocRef(), {
                            customInventory: updated,
                            date: new Date().toISOString(),
                        }, { merge: true });
                        return updated;
                    });
                    setCustomInventory(next);
                    return next;
                } catch (err) {
                    console.error("Error updating inventory:", err);
                    toast(language === "es" ? "Error al guardar inventario" : "Inventory save failed", { kind: 'error' });
                    return null;
                }
            };
            // Backward-compat shim — legacy callers that pre-computed `items`.
            // New code should use mutateInventory(transformer) for race safety.
            const saveInventory = async (_counts, items) => {
                try {
                    await setDoc(inventoryDocRef(), {
                        customInventory: items, date: new Date().toISOString()
                    }, { merge: true });
                } catch (err) { console.error("Error updating inventory (legacy):", err); }
            };

            // Insert `merged` into an items array adjacent to the LAST item
            // that shares its subcat. If no sibling exists, append. Used by
            // cross-category move (saveInvEdit + dropMovingItem) so a moved
            // item lands inside the matching subcategory bucket instead of
            // at the bottom of the destination category. See saveInvEdit
            // comment for the "chicken bone → Chicken" case that motivated
            // this. The merged item's subcat must already be set by caller.
            const insertNearSameSubcat = (items, merged) => {
                const targetSub = (merged.subcat || '').trim();
                let lastIdx = -1;
                for (let i = 0; i < items.length; i++) {
                    if ((items[i].subcat || '').trim() === targetSub) lastIdx = i;
                }
                if (lastIdx === -1) return [...items, merged]; // no sibling, append
                return [...items.slice(0, lastIdx + 1), merged, ...items.slice(lastIdx + 1)];
            };

            // Build a fresh ID that won't collide with anything currently in the category,
            // even when existing items have malformed IDs (no "-", non-numeric suffix, etc.).
            const nextItemId = (category, catIdx) => {
                const taken = new Set(category.items.map(it => it.id));
                let n = category.items.length;
                while (taken.has(catIdx + "-" + n)) n++;
                return catIdx + "-" + n;
            };

            // Quick write-in add (from the blank line at bottom of each
            // category). The destination is the writeInDest entry for the
            // typing row — by default that's the section the user is in
            // with no location set; the inline expansion below the input
            // lets them override both before pressing Add.
            //
            // Andrew 2026-05-22: location is now a required field at
            // write-in time. The new item carries `location` so the
            // location-bubble filter bar (incoming) can show it.
            //
            // Uses mutateInventory so two managers adding to the same
            // category simultaneously don't clobber each other.
            const quickAddItem = async (sourceCatIdx) => {
                const input = (writeInValues[sourceCatIdx] || "").trim();
                if (!input) return;
                const dest = writeInDest[sourceCatIdx] || {};
                const targetCatIdx = Number.isFinite(dest.catIdx) ? dest.catIdx : sourceCatIdx;
                const location = (dest.location || '').trim();
                if (!location) {
                    toast(language === 'es'
                        ? 'Elige una ubicación antes de añadir'
                        : 'Pick a location before adding',
                        { kind: 'error' });
                    return;
                }
                const translated = autoTranslateItem(input);
                const targetName = customInventory[targetCatIdx]?.name;
                setWriteInValues(prev => ({ ...prev, [sourceCatIdx]: "" }));
                setWriteInDest(prev => ({ ...prev, [sourceCatIdx]: { catIdx: sourceCatIdx, location: '' } }));
                await mutateInventory((live) => {
                    // Locate the category in the LIVE doc by NAME, not by index: the saved
                    // array can be shorter / a different order than the rendered (merged)
                    // list, so live[targetCatIdx] could hit the wrong category — or none
                    // (e.g. a store whose saved doc has fewer categories), silently dropping
                    // the add. Create the category if the saved doc doesn't have it yet.
                    let idx = live.findIndex(c => c && c.name === targetName);
                    let working = live;
                    if (idx === -1) {
                        if (!targetName) return live;
                        working = [...live, { name: targetName, items: [] }];
                        idx = working.length - 1;
                    }
                    const liveCat = working[idx];
                    const newItem = {
                        id: nextItemId(liveCat, idx),
                        name: translated.name, nameEs: translated.nameEs,
                        vendor: "", supplier: "", orderDay: "", pack: "", price: null,
                        location,
                    };
                    return working.map((cat, i) => i === idx ? { ...cat, items: [...cat.items, newItem] } : cat);
                });
            };

            const addInvItem = async (catIdx) => {
                if (!invNewName.trim()) return;
                const captured = {
                    name: invNewName.trim(), nameEs: invNewNameEs.trim(),
                    supplier: invNewSupplier.trim(), orderDay: invNewOrderDay,
                };
                const targetName = customInventory[catIdx]?.name;
                await mutateInventory((live) => {
                    // Find the category in the LIVE doc by NAME (saved order/length can
                    // differ from the rendered list) so the add never lands on the wrong
                    // category or silently no-ops. Create it if the saved doc lacks it.
                    let idx = live.findIndex(c => c && c.name === targetName);
                    let working = live;
                    if (idx === -1) {
                        if (!targetName) return live;
                        working = [...live, { name: targetName, items: [] }];
                        idx = working.length - 1;
                    }
                    const liveCat = working[idx];
                    const newItem = {
                        id: nextItemId(liveCat, idx),
                        name: captured.name, nameEs: captured.nameEs,
                        vendor: captured.supplier, supplier: captured.supplier,
                        orderDay: captured.orderDay, pack: "", price: null, subcat: "",
                    };
                    return working.map((cat, i) => i === idx ? { ...cat, items: [...cat.items, newItem] } : cat);
                });
                setInvNewName(""); setInvNewNameEs(""); setInvNewSupplier(""); setInvNewOrderDay("Fri"); setInvShowAddForm(null);
            };

            const saveInvEdit = async (catIdx, itemIdx) => {
                if (!invEditName.trim()) return;
                // Capture the item ID from local state so we can locate it in the live
                // list by ID rather than by index — index drifts if other managers
                // added/removed items in this category between snapshots.
                const targetId = customInventory[catIdx]?.items[itemIdx]?.id;
                if (!targetId) return;
                const patch = {
                    name: invEditName.trim(), nameEs: invEditNameEs.trim(),
                    vendor: invEditSupplier.trim(), supplier: invEditSupplier.trim(),
                    orderDay: invEditOrderDay,
                    subcat: (invEditSubcat || '').trim(),
                    // 2026-05-29 — storage location ('Walk-in Freezer',
                    // 'Pantry', etc). Empty string is preserved as ''
                    // (not deleted) so a previously-set location can be
                    // explicitly cleared back to "(none)".
                    location: (invEditLocation || '').trim(),
                };
                // Persist the low-stock threshold. Empty / 0 / NaN clears
                // the field so the indicator turns off. Stored as number
                // so the count comparison in render is straightforward.
                const minParsed = parseInt(String(invEditMin || '').trim(), 10);
                patch.min = Number.isFinite(minParsed) && minParsed > 0 ? minParsed : null;
                // Cross-category move: when invEditTargetCatIdx differs from
                // the source catIdx, we PULL the item out of the source array
                // and APPEND it to the destination's items array. ID stays
                // the same so inventory counts, audits, and vendor matches
                // remain linked.
                const destCatIdx = (invEditTargetCatIdx == null || invEditTargetCatIdx === '')
                    ? catIdx
                    : Number(invEditTargetCatIdx);
                if (destCatIdx === catIdx) {
                    // Same-category update — just merge the patch onto the item.
                    await mutateInventory((live) => live.map((cat, cIdx) =>
                        cIdx === catIdx
                            ? { ...cat, items: cat.items.map(item =>
                                item.id === targetId ? { ...item, ...patch } : item) }
                            : cat
                    ));
                } else {
                    // Cross-category move — remove from source, insert into
                    // dest *adjacent to* existing items with the same subcat.
                    //
                    // Why not just append: when you move "chicken bone" to
                    // Proteins ▸ Chicken, you want it next to the other
                    // Chicken items, not at the end of Proteins. Appending
                    // worked fine functionally but produced ugly storage —
                    // and (before the grouping fix above) caused a phantom
                    // second "Chicken" group to render. The grouping fix
                    // makes display correct regardless, but tidy storage
                    // helps Print, CSV exports, and any future consumer
                    // that walks the array in order.
                    await mutateInventory((live) => {
                        const sourceItem = (live[catIdx]?.items || []).find(it => it.id === targetId);
                        if (!sourceItem) return live; // nothing to move
                        const merged = { ...sourceItem, ...patch };
                        return live.map((cat, cIdx) => {
                            if (cIdx === catIdx) {
                                return { ...cat, items: cat.items.filter(it => it.id !== targetId) };
                            }
                            if (cIdx === destCatIdx) {
                                return { ...cat, items: insertNearSameSubcat(cat.items, merged) };
                            }
                            return cat;
                        });
                    });
                }
                setInvEditingIdx(null);
                setInvEditName(""); setInvEditNameEs(""); setInvEditSupplier(""); setInvEditOrderDay("Fri"); setInvEditMin("");
                setInvEditTargetCatIdx(null); setInvEditSubcat(""); setInvEditLocation("");
            };

            // Drop the currently-grabbed item into a target bucket. Same
            // cross-category-or-not logic as saveInvEdit but without the
            // form fields — just the relocation. Used by tap-to-drop on
            // subcategory headers when movingItem is set.
            const dropMovingItem = async (destCatIdx, destSubcat) => {
                if (!movingItem) return;
                const { id, fromCatIdx } = movingItem;
                if (id == null) { setMovingItem(null); return; }
                const norm = (destSubcat || '').trim();
                // No-op if dropping into the exact same bucket.
                const sourceItem = (customInventory[fromCatIdx]?.items || []).find(it => it.id === id);
                if (sourceItem && fromCatIdx === destCatIdx && (sourceItem.subcat || '') === norm) {
                    setMovingItem(null);
                    return;
                }
                await mutateInventory((live) => {
                    const src = (live[fromCatIdx]?.items || []).find(it => it.id === id);
                    if (!src) return live;
                    const merged = { ...src, subcat: norm };
                    if (fromCatIdx === destCatIdx) {
                        // Same-category: just patch subcat in place.
                        return live.map((cat, ci) =>
                            ci === fromCatIdx
                                ? { ...cat, items: cat.items.map(it => it.id === id ? merged : it) }
                                : cat
                        );
                    }
                    // Cross-category: pull from source, insert into dest
                    // adjacent to existing same-subcat items (see saveInvEdit
                    // for the rationale — keeps the storage order tidy so
                    // the moved item shows up under the existing subcategory
                    // header rather than tacked onto the end of the category).
                    return live.map((cat, ci) => {
                        if (ci === fromCatIdx) {
                            return { ...cat, items: cat.items.filter(it => it.id !== id) };
                        }
                        if (ci === destCatIdx) {
                            return { ...cat, items: insertNearSameSubcat(cat.items, merged) };
                        }
                        return cat;
                    });
                });
                setMovingItem(null);
            };

            const deleteInvItem = async (catIdx, itemIdx) => {
                // Same drift-safety: target by ID, not by index.
                const targetId = customInventory[catIdx]?.items[itemIdx]?.id;
                if (!targetId) return;
                const itemName = customInventory[catIdx]?.items[itemIdx]?.name || 'item';
                // Wrap in 5-second undo toast — restaurant managers WILL fat-finger
                // delete on a phone with wet hands. The audit specifically flagged
                // this as a no-undo destructive action that needed soft-delete.
                undoToast(
                    language === 'es' ? `🗑 Eliminado: ${itemName}` : `🗑 Deleted: ${itemName}`,
                    async () => {
                        // 1. Remove the item from the master list (drift-safe by ID).
                        await mutateInventory((live) => live.map((cat, cIdx) =>
                            cIdx === catIdx ? { ...cat, items: cat.items.filter(it => it.id !== targetId) } : cat
                        ));
                        // 2. Clean up the item's leftover count + count-meta so no
                        //    orphan data lingers (and a future id reuse can't inherit
                        //    a stale count). Best-effort — never blocks the delete.
                        try {
                            await updateDoc(inventoryDocRef(), {
                                [`counts.${targetId}`]: deleteField(),
                                [`countMeta.${targetId}`]: deleteField(),
                            });
                        } catch (e) { /* orphan count is harmless if this write fails */ }
                    },
                    { delayMs: 5000, undoLabel: language === 'es' ? 'Deshacer' : 'Undo', kind: 'warn' }
                );
            };

            // Split list helpers.
            // Writes ONLY the changed top-level field (`overrides` or `writeIns`)
            // via a dotted-free updateDoc, so a per-count write-in edit no longer
            // rewrites the whole doc AND a concurrent editor on the OTHER field
            // (e.g. someone moving an item while you bump a count) isn't clobbered.
            // First-ever write (doc missing) falls back to a merge setDoc; the
            // other field defaults to {} in the consumers until its first edit.
            const saveSplitConfig = async (patch) => {
                const ref = doc(db, "ops", "splitConfig_" + storeLocation);
                const data = { ...patch, date: new Date().toISOString() };
                try {
                    await updateDoc(ref, data);
                } catch (err) {
                    if (err?.code === "not-found") {
                        try { await setDoc(ref, data, { merge: true }); } catch (e) { console.error("Error creating split config:", e); }
                    } else { console.error("Error saving split config:", err); }
                }
            };

            const moveSplitItem = async (itemId, toPerson) => {
                const updated = { ...splitOverrides, [itemId]: toPerson };
                setSplitOverrides(updated);
                setSplitMovingItem(null);
                await saveSplitConfig({ overrides: updated });
            };

            const addSplitWriteIn = async (personName) => {
                const input = (splitWriteInValues[personName] || "").trim();
                if (!input) return;
                const existing = splitWriteIns[personName] || [];
                const newId = "sw-" + personName + "-" + Date.now();
                const updated = { ...splitWriteIns, [personName]: [...existing, { id: newId, name: input, count: 0 }] };
                setSplitWriteIns(updated);
                setSplitWriteInValues(prev => ({ ...prev, [personName]: "" }));
                await saveSplitConfig({ writeIns: updated });
            };

            const removeSplitWriteIn = async (personName, itemId) => {
                const existing = splitWriteIns[personName] || [];
                const updated = { ...splitWriteIns, [personName]: existing.filter(i => i.id !== itemId) };
                setSplitWriteIns(updated);
                await saveSplitConfig({ writeIns: updated });
            };

            const updateSplitWriteInCount = async (personName, itemId, newCount) => {
                const existing = splitWriteIns[personName] || [];
                const updated = { ...splitWriteIns, [personName]: existing.map(i => i.id === itemId ? { ...i, count: newCount } : i) };
                setSplitWriteIns(updated);
                await saveSplitConfig({ writeIns: updated });
            };

            const toggleCatCollapse = (key) => {
                setCollapsedCats(prev => ({ ...prev, [key]: !prev[key] }));
            };

            // Parse pack string to total units for price-per-unit comparison
            const parsePackToUnits = (pack) => {
                if (!pack) return null;
                const p = pack.trim().toUpperCase();
                let m;
                // Direct weight: '50lb', '30 LB'
                m = p.match(/^(\d+\.?\d*)\s*(LB|LBS?)$/); if (m) return { total: parseFloat(m[1]), unit: "lb" };
                if (p === "LB") return { total: 1, unit: "lb" };
                if (p === "EA") return { total: 1, unit: "ea" };
                // Multiplied lb packs: '4/19 LBA', '3/17#AVG', '5/10#UP', '2/5 LB'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*(LB|LBA|LBS?|#AVG|#UP|#)/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "lb" };
                // '5x5lb', '6/5lb'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*LBS?$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "lb" };
                // Gallons: '4/1 GA', '5 GA', '9/0.5GAL', '5gal'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*GA[L]?$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "gal" };
                m = p.match(/^(\d+\.?\d*)\s*GA[L]?$/); if (m) return { total: parseFloat(m[1]), unit: "gal" };
                // Liters: '5 LT'
                m = p.match(/^(\d+\.?\d*)\s*LT$/); if (m) return { total: parseFloat(m[1]), unit: "lt" };
                // Ounce packs to lb: '120/1.5 OZ', '48/3 OZ'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*OZ$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]) / 16, unit: "lb" };
                // Count packs: '12/500 CT', '200 EA', '12/100 EA'
                m = p.match(/^(\d+)[/xX](\d+)\s*(CT|EA)$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "ct" };
                m = p.match(/^(\d+)\s*(CT|EA)$/); if (m) return { total: parseFloat(m[1]), unit: "ct" };
                // Simple count: '1000', '400pc', '500pk', '2500p'
                m = p.match(/^(\d+)\s*(PC|PK|P|SET)?$/); if (m) return { total: parseFloat(m[1]), unit: "ct" };
                // Multiplied without unit: '10/25', '4x125'
                m = p.match(/^(\d+)[/xX](\d+)$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "ct" };
                // '80/550CT', '1/500CT'
                m = p.match(/^(\d+)[/xX](\d+)\s*CT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "ct" };
                // Quarts: '12/1 QT'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*QT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]) * 0.25, unit: "gal" };
                // Rolls: '6 RL'
                m = p.match(/^(\d+)\s*RL$/); if (m) return { total: parseFloat(m[1]), unit: "rl" };
                // Feet: '3/1150FT'
                m = p.match(/^(\d+)[/xX](\d+)\s*FT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "ft" };
                // '1/40 LB'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*LB$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "lb" };
                return null;
            };

            // Get live scraped price for an inventory item (uses reverse lookup from Sysco matching)
            const getLivePrice = (itemId) => {
                const data = invToSyscoPrice[itemId];
                if (!data || !data.price) return null;
                return data;
            };

            // Get vendor option label with live price if available
            const getVendorOptionLabel = (vo, itemId) => {
                const live = getLivePrice(itemId);
                if (live && live.price) return `${vo.vendor} ($${live.price.toFixed(2)} LIVE)`;
                if (vo.price != null) return `${vo.vendor} ($${vo.price.toFixed(2)})`;
                return vo.vendor;
            };

            // Strip Sysco and US Foods out of the per-item vendorOptions list — those
            // entries carried hardcoded prices from inventory.js that can drift out of
            // sync with what the scrapers pull in. The live-price chips below already
            // show the right Sysco/US Foods prices, so the dropdown only needs to
            // surface the non-scraped vendors (Restaurant Depot, STL Wholesale, Pan
            // Asia, Jays, etc.) that the user actually has to pick between.
            const nonScrapedVendorOptions = (vendorOptions) => {
                if (!Array.isArray(vendorOptions)) return [];
                return vendorOptions.filter(vo => {
                    const v = (vo?.vendor || "").toLowerCase().replace(/\s+/g, "");
                    return v !== "sysco" && v !== "usfoods";
                });
            };

            // Render live price badge for an item — now shows ALL matched vendors so the
            // person placing the order can compare prices at a glance. The cheapest vendor
            // is highlighted; ties or matched-but-pricier vendors render dimmer.
            const renderLivePriceBadge = (itemId, item) => {
                const list = invToVendorPrices[itemId];
                const hasScraped = list && list.length > 0;
                // Trusted price from the new item_prices engine (manual / receipt / …).
                const priceDoc = itemPrices[itemId];
                const trusted = priceDoc ? resolveTrustedPrice(priceDoc) : null;
                const esLang = language === 'es';
                // Unchanged behavior for non-admins with no prices at all.
                if (!trusted && !hasScraped && !currentIsAdmin) return null;
                const srcLabel = trusted ? ((PRICE_SOURCE_LABEL[trusted.source] || {})[esLang ? 'es' : 'en'] || trusted.source) : '';
                const trustedCls = trusted && (trusted.source === 'manual' || trusted.source === 'invoice')
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                    : trusted && trusted.source === 'legacy_scraped'
                    ? 'bg-amber-50 text-amber-800 border border-amber-200'
                    : 'bg-gray-100 text-gray-700 border border-gray-200';
                return (
                    <span className="inline-flex items-center gap-1 flex-wrap">
                        {/* Trusted price chip (new pricing system) */}
                        {trusted && (
                            <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${trustedCls}`}
                                title={`${srcLabel}${trusted.vendor ? ' · ' + trusted.vendor : ''}`}>
                                💲${Number(trusted.price).toFixed(2)}
                                {trusted.perUnit != null && <span className="opacity-80 ml-0.5">/{trusted.unit}</span>}
                                <span className="opacity-70 ml-1 font-normal">{srcLabel}</span>
                                {trusted.stale && <span className="ml-1 text-amber-700">⚠</span>}
                            </span>
                        )}
                        {/* Admin-only: set / edit the trusted price */}
                        {currentIsAdmin && (
                            <button type="button" onClick={() => setPriceEditItem(item)}
                                className="text-xs px-1.5 py-0.5 rounded border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50"
                                title={esLang ? 'Fijar precio confiable' : 'Set trusted price'}>
                                {trusted ? '✎' : (esLang ? '💲 Fijar' : '💲 Set price')}
                            </button>
                        )}
                        {/* Legacy scraped vendor badges — DEPRECATED (frozen scraper data).
                            Kept for continuity; Phase 3 removes them once receipts/manual
                            prices cover the items. */}
                        {hasScraped && list.map((p, i) => {
                            const isCheapest = i === 0 && list.length > 1;
                            const isOnly = list.length === 1;
                            const hasSalePrice = p.originalPrice && p.originalPrice !== p.price;
                            const cls = isCheapest ? "bg-green-200 text-green-900 border border-green-400 font-bold"
                                       : isOnly ? "bg-green-100 text-green-700 font-bold"
                                       : "bg-gray-100 text-gray-600";
                            return (
                                <span key={p.vendor + p.vendorId} className={`text-xs px-1.5 py-0.5 rounded ${cls}`}
                                    title={`${p.vendor}: ${p.name || ""} | Pack: ${p.pack || "?"} | #${p.vendorId}`}>
                                    {isCheapest && "🏆 "}{p.vendor}
                                    {hasSalePrice && <span className="line-through text-gray-400 ml-1">${p.originalPrice.toFixed(2)}</span>}
                                    <span className="ml-1">${p.price.toFixed(2)}</span>
                                    {p.pack && <span className="opacity-75 ml-1">/{p.pack}</span>}
                                </span>
                            );
                        })}
                    </span>
                );
            };

            // Find cheapest vendor by price per unit (not just raw price)
            const findCheapest = (item) => {
                if (!item.vendorOptions || item.vendorOptions.length < 2) return null;
                const withPrices = item.vendorOptions.filter(vo => vo.price && vo.price > 0);
                if (withPrices.length < 2) return null;
                // Calculate price per unit for each vendor
                const rated = withPrices.map(vo => {
                    const parsed = parsePackToUnits(vo.pack);
                    const perUnit = parsed && parsed.total > 0 ? vo.price / parsed.total : null;
                    return { ...vo, perUnit, unitType: parsed ? parsed.unit : null };
                });
                // Only compare vendors with the same unit type, or fallback to raw price
                const prefVendor = item.preferredVendor || item.vendor || "";
                const prefOption = rated.find(r => r.vendor === prefVendor);
                if (!prefOption) return null;
                // Find cheapest per-unit among same-unit vendors
                let cheapest = null;
                if (prefOption.perUnit !== null) {
                    const sameUnit = rated.filter(r => r.unitType === prefOption.unitType && r.perUnit !== null);
                    if (sameUnit.length > 1) {
                        sameUnit.sort((a, b) => a.perUnit - b.perUnit);
                        if (sameUnit[0].vendor !== prefVendor && sameUnit[0].perUnit < prefOption.perUnit * 0.95) {
                            cheapest = sameUnit[0];
                        }
                    }
                } else {
                    // No pack info — compare raw prices
                    const others = rated.filter(r => r.vendor !== prefVendor);
                    others.sort((a, b) => a.price - b.price);
                    if (others.length > 0 && others[0].price < (prefOption.price || Infinity) * 0.95) {
                        cheapest = others[0];
                    }
                }
                return cheapest;
            };

            // Vendor-grouped print — Andrew 2026-05-22. Sister of
            // printInventory below. Instead of one comparison table
            // with all vendor columns side-by-side, this prints ONE
            // section per vendor, listing only the items the manager
            // assigned to that vendor in the cart's vendor-toggle
            // bar. Items without an explicit cartVendorOverride fall
            // back to their item.preferredVendor. Items with no vendor
            // at all go into an "Unassigned" section at the end so
            // they're not silently dropped.
            const printOrderByVendor = () => {
                // Local HTML escape — same as the one in printInventory below.
                const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
                const findVendorEntry = (vendor, vendorId) => {
                    const src = vendor === "sysco"
                        ? (syscoPricingData?.sorted || [])
                        : (usfoodsPricingData?.sorted || []);
                    const found = src.find(([k]) => k === vendorId);
                    return found ? found[1] : null;
                };
                // Build rows with effective vendor (override > preferred).
                const rows = [];
                const itemLookup = new Map();
                for (const cat of INVENTORY_CATEGORIES) {
                    for (const item of (cat.items || [])) {
                        itemLookup.set(item.id, { item, categoryName: cat.name });
                    }
                }
                for (const cat of customInventory) {
                    for (const item of (cat.items || [])) {
                        itemLookup.set(item.id, { item, categoryName: cat.name });
                    }
                }
                Object.entries(inventory).forEach(([id, rawQty]) => {
                    const qty = Number(rawQty) || 0;
                    if (qty <= 0) return;
                    const lookup = itemLookup.get(id);
                    if (!lookup) return;
                    const { item, categoryName } = lookup;
                    // Effective vendor — override wins, else normalize the
                    // item's preferredVendor onto the canonical 8-vendor list.
                    const vendor = cartVendorOverride[id]
                        || normalizeVendor(item.preferredVendor || item.vendor || '');
                    rows.push({
                        id,
                        name: language === "es" && item.nameEs ? item.nameEs : item.name,
                        category: categoryName,
                        qty,
                        pack: item.pack || '',
                        vendor,
                    });
                });
                Object.entries(vendorCounts).forEach(([key, qty]) => {
                    if (qty <= 0) return;
                    const [v, vendorId] = key.split(":");
                    const data = findVendorEntry(v, vendorId);
                    if (!data) return;
                    const vendorName = v === "sysco" ? "Sysco" : "US Foods";
                    rows.push({
                        id: key,
                        name: data.name || `${vendorName} #${vendorId}`,
                        category: data.category || 'Other',
                        qty,
                        pack: data.pack || '',
                        vendor: cartVendorOverride[key] || vendorName,
                    });
                });
                if (rows.length === 0) {
                    toast(language === "es" ? "El carrito está vacío." : "Cart is empty.");
                    return;
                }
                // Group by vendor.
                const groups = new Map();
                for (const r of rows) {
                    const v = r.vendor || (language === 'es' ? 'Sin asignar' : 'Unassigned');
                    if (!groups.has(v)) groups.set(v, []);
                    groups.get(v).push(r);
                }
                // Sort vendors by canonical-list position; anything not
                // on the list ("Unassigned" string from above) goes last.
                const canonicalOrder = INVENTORY_VENDORS.reduce((m, v, i) => { m[v] = i; return m; }, {});
                const vendorOrder = [...groups.keys()].sort((a, b) => {
                    const ai = canonicalOrder[a] ?? 999;
                    const bi = canonicalOrder[b] ?? 999;
                    if (ai !== bi) return ai - bi;
                    return a.localeCompare(b);
                });
                const dateLabel = new Date().toLocaleString();
                const titleName = language === 'es' ? 'Pedido Por Proveedor' : 'Order By Vendor';
                let html = `<!DOCTYPE html><html><head><title>DD Mau — ${esc(titleName)}</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; color: #222; max-width: 800px; margin: 0 auto; }
                    h1 { font-size: 20px; margin-bottom: 4px; color: #2a5d31; }
                    .subtitle { font-size: 12px; color: #666; margin-bottom: 16px; }
                    .vendor-header { background: #2a5d31; color: white; padding: 10px 14px; font-weight: bold; font-size: 16px; margin-top: 22px; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
                    th { background: #e5ecdf; text-align: left; padding: 7px 11px; font-size: 11px; color: #2a5d31; border: 1px solid #c4cfb9; }
                    td { padding: 6px 11px; font-size: 13px; border: 1px solid #ddd; }
                    tr:nth-child(even) { background: #fafaf6; }
                    .qty { text-align: center; font-weight: bold; font-size: 15px; width: 56px; }
                    .pack { color: #666; font-size: 11px; }
                    .cat-label { color: #999; font-size: 10px; }
                    .check { width: 30px; text-align: center; color: #ccc; font-weight: bold; font-size: 16px; }
                    .no-print { position: sticky; top: 0; z-index: 1000; background: #2a5d31; padding: 10px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.3) }
                    .no-print button { padding: 12px 24px; font-size: 16px; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; margin: 0 6px; }
                    .btn-print { background: white; color: #2a5d31; } .btn-close { background: #ff4444; color: white; }
                    @media print { body { padding: 10px; } h1 { font-size: 16px; } .no-print { display: none !important; } .vendor-header { page-break-before: auto; } }
                </style></head><body>`;
                html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){}">✕ Close</button><button class="btn-print" onclick="window.print()">🖨️ Print</button></div>`;
                html += `<h1>🍜 DD Mau — ${esc(titleName)}</h1>`;
                html += `<div class="subtitle">${esc(dateLabel)} · ${rows.length} ${language === 'es' ? 'artículos en' : 'items across'} ${vendorOrder.length} ${language === 'es' ? 'proveedores' : 'vendors'}</div>`;
                for (const v of vendorOrder) {
                    const items = groups.get(v).sort((a, b) => a.name.localeCompare(b.name));
                    const totalQty = items.reduce((s, r) => s + r.qty, 0);
                    html += `<div class="vendor-header"><span>📞 ${esc(v)}</span><span style="font-size:13px;font-weight:600;opacity:0.85">${items.length} ${language === 'es' ? 'artículos' : 'items'} · ${totalQty} ${language === 'es' ? 'total' : 'total'}</span></div>`;
                    html += `<table><thead><tr><th>${language === 'es' ? 'Artículo' : 'Item'}</th><th style="width:56px">${language === 'es' ? 'Cant.' : 'Qty'}</th><th>${language === 'es' ? 'Pack' : 'Pack'}</th><th style="width:30px">✓</th></tr></thead><tbody>`;
                    for (const r of items) {
                        html += `<tr><td>${esc(r.name)} <span class="cat-label">${esc(r.category || '')}</span></td><td class="qty">${r.qty}</td><td class="pack">${esc(r.pack || '')}</td><td class="check">☐</td></tr>`;
                    }
                    html += `</tbody></table>`;
                }
                html += `</body></html>`;
                if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Order Guide'); return; }
                const win = window.open('', '_blank');
                if (!win) { toast(language === 'es' ? "Permitir ventanas emergentes." : "Allow pop-ups to print."); return; }
                win.document.write(html);
                win.document.close();
                win.focus();
                setTimeout(() => win.print(), 300);
            };

            const printInventory = () => {
                // Build the same row structure the cart modal uses, then print it as a
                // single comparison table with all vendor prices side-by-side. Matches
                // what the user sees on screen so the printed sheet is unambiguous.
                const findVendorEntry = (vendor, vendorId) => {
                    const src = vendor === "sysco"
                        ? (syscoPricingData?.sorted || [])
                        : (usfoodsPricingData?.sorted || []);
                    const found = src.find(([k]) => k === vendorId);
                    return found ? found[1] : null;
                };
                // 2026-05-20 — Mirror the cart-modal build so the print
                // sheet shows everything the cart shows. Walk every counted
                // id, not just the active list.
                const rows = [];
                const itemLookup = new Map();
                for (const cat of INVENTORY_CATEGORIES) {
                    for (const item of (cat.items || [])) {
                        itemLookup.set(item.id, { item, categoryName: cat.name });
                    }
                }
                for (const cat of customInventory) {
                    for (const item of (cat.items || [])) {
                        itemLookup.set(item.id, { item, categoryName: cat.name });
                    }
                }
                Object.entries(inventory).forEach(([id, rawQty]) => {
                    const qty = Number(rawQty) || 0;
                    if (qty <= 0) return;
                    const lookup = itemLookup.get(id);
                    if (!lookup) return;
                    const { item, categoryName } = lookup;
                    rows.push({
                        kind: "master",
                        name: item.name,
                        category: categoryName,
                        qty,
                        vendorPrices: invToVendorPrices[item.id] || [],
                        pack: item.pack,
                    });
                });
                Object.entries(vendorCounts).forEach(([key, qty]) => {
                    if (qty <= 0) return;
                    const [vendor, vendorId] = key.split(":");
                    const data = findVendorEntry(vendor, vendorId);
                    if (!data) return;
                    const vendorName = vendor === "sysco" ? "Sysco" : "US Foods";
                    rows.push({
                        kind: "vendor-only",
                        name: data.name || `${vendorName} #${vendorId}`,
                        category: data.category || "Other",
                        qty,
                        vendorPrices: [{ vendor: vendorName, vendorId, price: data.price, pack: data.pack }],
                        pack: data.pack,
                        vendorOnlyOrigin: vendorName,
                    });
                });
                rows.sort((a, b) =>
                    (a.category || "").localeCompare(b.category || "") ||
                    (a.name || "").localeCompare(b.name || ""));

                if (rows.length === 0) {
                    toast(language === "es" ? "El carrito está vacío." : "Cart is empty.");
                    return;
                }

                // Distinct vendors with at least one price across all rows
                const vendorSet = new Set();
                rows.forEach(r => r.vendorPrices.forEach(p => p.price != null && vendorSet.add(p.vendor)));
                const vendorList = Array.from(vendorSet).sort();

                // Per-vendor totals (if all bought from this vendor)
                const vendorTotals = {};
                vendorList.forEach(v => vendorTotals[v] = { lineTotal: 0, items: 0, missing: 0 });
                rows.forEach(r => {
                    vendorList.forEach(v => {
                        const p = r.vendorPrices.find(vp => vp.vendor === v);
                        if (p && p.price) {
                            vendorTotals[v].lineTotal += r.qty * p.price;
                            vendorTotals[v].items += 1;
                        } else {
                            vendorTotals[v].missing += 1;
                        }
                    });
                });

                // Best mix: pick cheapest available vendor per row
                let bestMixSum = 0;
                let uncovered = 0;
                const bestMixByVendor = {};
                vendorList.forEach(v => bestMixByVendor[v] = { lineTotal: 0, items: 0 });
                rows.forEach(r => {
                    const cheapest = r.vendorPrices.find(p => p.price != null);
                    if (cheapest) {
                        bestMixSum += r.qty * cheapest.price;
                        if (!bestMixByVendor[cheapest.vendor]) bestMixByVendor[cheapest.vendor] = { lineTotal: 0, items: 0 };
                        bestMixByVendor[cheapest.vendor].lineTotal += r.qty * cheapest.price;
                        bestMixByVendor[cheapest.vendor].items += 1;
                    } else {
                        uncovered += 1;
                    }
                });

                const totalQty = rows.reduce((s, r) => s + r.qty, 0);
                const now = new Date();
                const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
                const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

                let html = `<html><head><title>DD Mau Order - ${dateStr}</title><style>
                    body{font-family:Arial,sans-serif;max-width:1100px;margin:0 auto;padding:20px;color:#333}
                    h1{font-size:20px;color:#2F5496;margin-bottom:4px}
                    .meta{font-size:12px;color:#888;margin-bottom:16px}
                    table{width:100%;border-collapse:collapse;margin-bottom:16px}
                    th{background:#D6E4F0;padding:6px 8px;text-align:left;font-size:11px;color:#2F5496;border:1px solid #999}
                    th.num{text-align:right} th.qty{text-align:center}
                    td{padding:6px 8px;font-size:12px;border:1px solid #ddd;vertical-align:top}
                    td.qty{text-align:center;font-weight:bold;font-size:14px}
                    td.num{text-align:right}
                    td.cheap{background:#dcfce7;font-weight:bold;color:#15803d}
                    td.miss{color:#bbb;text-align:right}
                    .vendor-only{background:#fff7ed}
                    .badge{display:inline-block;font-size:9px;font-weight:bold;padding:1px 4px;border-radius:3px;margin-right:4px;border:1px solid}
                    .badge.sysco{background:#dbeafe;color:#1d4ed8;border-color:#93c5fd}
                    .badge.usfoods{background:#fed7aa;color:#9a3412;border-color:#fdba74}
                    .cat{font-size:9px;color:#888;display:block}
                    .totals-block{border:2px solid #2F5496;border-radius:6px;padding:12px;margin-top:16px;page-break-inside:avoid}
                    .totals-title{font-size:11px;font-weight:bold;text-transform:uppercase;color:#666;margin-bottom:6px;letter-spacing:0.5px}
                    .totals-row{display:flex;justify-content:space-between;padding:3px 0;font-size:13px}
                    .totals-grand{border-top:2px solid #2F5496;margin-top:8px;padding-top:8px;font-size:16px;font-weight:bold;color:#15803d}
                    .savings{color:#15803d;font-size:11px;margin-top:6px}
                    .uncov{color:#a16207;font-size:11px;margin-top:6px}
                    .no-print{position:sticky;top:0;z-index:1000;background:#2F5496;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)}
                    .no-print button{padding:12px 24px;font-size:16px;font-weight:bold;border:none;border-radius:8px;cursor:pointer;margin:0 6px}
                    .btn-print{background:white;color:#2F5496} .btn-close{background:#ff4444;color:white}
                    @media print{body{padding:10px}h1{font-size:16px}.no-print{display:none !important}}
                </style></head><body>`;
                html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://app.ddmaustl.com/'}},300)">✕ Close</button><button class="btn-print" onclick="window.print()">🖨️ Print</button></div>`;
                html += `<h1>DD Mau Order Sheet</h1>`;
                html += `<div class="meta">${esc(dateStr)} at ${esc(timeStr)} &mdash; ${esc(storeLocation)} &mdash; ${rows.length} items, ${totalQty} total</div>`;

                // Comparison table
                html += `<table><thead><tr>`;
                html += `<th>Item</th><th class="qty" style="width:50px">Qty</th>`;
                vendorList.forEach(v => {
                    html += `<th class="num" style="width:120px">${esc(v)}</th>`;
                });
                html += `<th class="qty" style="width:30px">✓</th></tr></thead><tbody>`;

                rows.forEach(r => {
                    const cheapestVendor = r.vendorPrices.find(p => p.price != null)?.vendor;
                    const isVO = r.kind === "vendor-only";
                    const trClass = isVO ? ' class="vendor-only"' : "";
                    html += `<tr${trClass}><td>`;
                    if (isVO && r.vendorOnlyOrigin) {
                        const cls = r.vendorOnlyOrigin === "Sysco" ? "sysco" : "usfoods";
                        html += `<span class="badge ${cls}">${esc(r.vendorOnlyOrigin)}</span>`;
                    }
                    html += esc(r.name);
                    html += `<span class="cat">${esc(r.category)}${r.pack ? " · " + esc(r.pack) : ""}</span>`;
                    html += `</td><td class="qty">${r.qty}</td>`;
                    vendorList.forEach(v => {
                        const p = r.vendorPrices.find(vp => vp.vendor === v);
                        if (!p || p.price == null) {
                            html += `<td class="miss">—</td>`;
                        } else {
                            const isCheapest = v === cheapestVendor && r.vendorPrices.filter(vp => vp.price != null).length > 1;
                            const cls = isCheapest ? "cheap" : "num";
                            const lineTotal = r.qty * p.price;
                            html += `<td class="${cls}">$${p.price.toFixed(2)}<br><span style="font-size:10px;color:#666">= $${lineTotal.toFixed(2)}${p.pack ? " · " + esc(p.pack) : ""}</span></td>`;
                        }
                    });
                    html += `<td></td></tr>`;
                });
                html += `</tbody></table>`;

                // Totals block
                html += `<div class="totals-block">`;
                html += `<div class="totals-title">If you order all from one vendor</div>`;
                vendorList.forEach(v => {
                    html += `<div class="totals-row"><span><strong>${esc(v)}</strong></span><span><strong>$${vendorTotals[v].lineTotal.toFixed(2)}</strong> &middot; ${vendorTotals[v].items} items${vendorTotals[v].missing > 0 ? ` &middot; ${vendorTotals[v].missing} missing` : ""}</span></div>`;
                });
                html += `<div class="totals-title" style="margin-top:14px">Best mix (cheapest per item)</div>`;
                Object.keys(bestMixByVendor).filter(v => bestMixByVendor[v].items > 0).forEach(v => {
                    html += `<div class="totals-row"><span><strong>${esc(v)}</strong></span><span><strong>$${bestMixByVendor[v].lineTotal.toFixed(2)}</strong> &middot; ${bestMixByVendor[v].items} items</span></div>`;
                });
                html += `<div class="totals-row totals-grand"><span>Total</span><span>$${bestMixSum.toFixed(2)}</span></div>`;
                if (uncovered > 0) {
                    html += `<div class="uncov">⚠ ${uncovered} item(s) have no live vendor price</div>`;
                }
                const cheapestSingle = vendorList.reduce((min, v) => {
                    if (vendorTotals[v].missing > 0) return min;
                    if (min === null) return v;
                    return vendorTotals[v].lineTotal < vendorTotals[min].lineTotal ? v : min;
                }, null);
                if (cheapestSingle && bestMixSum < vendorTotals[cheapestSingle].lineTotal) {
                    const saved = vendorTotals[cheapestSingle].lineTotal - bestMixSum;
                    html += `<div class="savings">💰 Saves $${saved.toFixed(2)} by splitting between vendors (vs all-${esc(cheapestSingle)})</div>`;
                }
                html += `</div>`;

                html += `</body></html>`;
                if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Inventory'); return; }
                const w = window.open("", "_blank");
                if (!w) {
                    toast(language === "es" ? "Por favor permita ventanas emergentes para imprimir." : "Please allow pop-ups to print.");
                    return;
                }
                w.document.write(html);
                w.document.close();
                w.print();
            };

            const changePreferredVendor = async (catIdx, itemIdx, newVendor) => {
                const item = customInventory[catIdx]?.items[itemIdx];
                if (!item) return;
                const oldVendor = item.preferredVendor || item.vendor || "";
                if (newVendor === oldVendor) return;
                const now = new Date();
                const logEntry = {
                    itemName: item.name,
                    itemId: item.id,
                    from: oldVendor,
                    to: newVendor,
                    changedBy: staffName,
                    date: now.toISOString(),
                    dateStr: now.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                };
                const targetId = item.id;
                // Race-safe inventory update — target by ID against the live list.
                await mutateInventory((live) => live.map((cat, cIdx) =>
                    cIdx === catIdx
                        ? { ...cat, items: cat.items.map(it =>
                            it.id === targetId ? { ...it, preferredVendor: newVendor } : it) }
                        : cat
                ));
                // Race-safe log append. The previous code did
                //   newLog = [entry, ...localLog].slice(0,50)
                //   setDoc({ log: newLog })
                // — which lost simultaneous writes from the other tablet (last
                // writer wins, the first entry vanishes). Now we transactionally
                // read the live log, prepend our entry, cap to 50, write back.
                try {
                    const logRef = doc(db, "ops", "vendorLog_" + storeLocation);
                    await runTransaction(db, async (txn) => {
                        const snap = await txn.get(logRef);
                        const liveLog = (snap.exists() && Array.isArray(snap.data()?.log)) ? snap.data().log : [];
                        const merged = [logEntry, ...liveLog].slice(0, 50);
                        txn.set(logRef, { log: merged }, { merge: true });
                    });
                } catch (err) {
                    console.error("Error saving vendor log:", err);
                }
            };

            // Get tasks for current side + period
            // Helper: check if a staff name is in a task's assignTo (supports string or array)
            const isAssignedTo = (task, name) => {
                if (!task.assignTo) return false;
                if (Array.isArray(task.assignTo)) return task.assignTo.includes(name);
                return task.assignTo === name;
            };
            // Helper: get assignees as array
            const getAssignees = (task) => {
                if (!task.assignTo) return [];
                if (Array.isArray(task.assignTo)) return task.assignTo;
                return [task.assignTo];
            };

            // ── PER-ASSIGNEE COMPLETION ─────────────────────────────────
            // Andrew 2026-05-28: "the tasks that has 2 staff connected to
            // it they both have to be able to click... master say 1/2
            // complete or 0/2 or 2/2 and the task one each staff member
            // turns green on there own list when complete not until
            // they do it. and not when the other staff does it."
            //
            // Key format: `${prefix}${taskId}__doneBy__${name}` stores
            // the localized time string when assignee marks the task
            // complete. Absent key = not done by that assignee. The
            // legacy `${prefix}${taskId}` boolean is kept in sync as
            // "all assignees done" so existing isTaskComplete + stats
            // continue to work without changes.
            // Sanitize the assignee name into a safe Firestore field
            // segment — Firestore field paths split on `.` and choke
            // on spaces / dots / brackets when written via the dotted-
            // path syntax in updateDoc(). Andrew 2026-05-29: "the tasks
            // they the staff finished isnt turning green on there own
            // list." Root cause: keys like `__doneBy__Yuly Guerrero`
            // had a space, the optimistic local update succeeded but
            // the Firestore write rejected the path, so the snapshot
            // round-trip reverted the row. Replacing non-alnum chars
            // with underscore guarantees the field name is a valid
            // path segment.
            const sanitizeForKey = (s) => String(s || '').replace(/[^a-zA-Z0-9_]/g, '_');
            const assigneeDoneKey = (taskId, name) =>
                `${currentPrefix}${taskId}__doneBy__${sanitizeForKey(name)}`;
            const isDoneForAssignee = (task, name) =>
                !!checks[assigneeDoneKey(task.id, name)];
            const getAssigneeProgress = (task) => {
                const list = getAssignees(task);
                if (list.length === 0) return { done: 0, total: 0 };
                const done = list.filter(n => !!checks[assigneeDoneKey(task.id, n)]).length;
                return { done, total: list.length };
            };
            // Toggle one assignee's done state. Recomputes the legacy
            // task-done boolean so old code paths keep working.
            const togglePerAssigneeCheck = async (taskId, assigneeName, parentTask) => {
                const cur = checksRef.current;
                const k = assigneeDoneKey(taskId, assigneeName);
                const wasOn = !!cur[k];
                const newChecks = { ...cur };
                const patch = {};
                if (wasOn) {
                    delete newChecks[k];
                    patch[k] = undefined;
                } else {
                    const timeStr = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                    newChecks[k] = timeStr;
                    patch[k] = timeStr;
                }
                // Reconcile the legacy task-complete boolean: true iff
                // every assignee is now done. Drives stats + master row
                // "complete" styling without changing existing readers.
                const assignees = getAssignees(parentTask);
                const legacyKey = currentPrefix + taskId;
                if (assignees.length > 0) {
                    const allDone = assignees.every(n => {
                        if (n === assigneeName) return !wasOn;
                        return !!cur[assigneeDoneKey(taskId, n)];
                    });
                    if (allDone) {
                        const ts = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                        newChecks[legacyKey] = true;
                        newChecks[legacyKey + '_by'] = staffName;
                        newChecks[legacyKey + '_at'] = ts;
                        patch[legacyKey] = true;
                        patch[legacyKey + '_by'] = staffName;
                        patch[legacyKey + '_at'] = ts;
                    } else if (cur[legacyKey]) {
                        // Was previously fully-done, but someone just
                        // unchecked their slot — back to in-progress.
                        delete newChecks[legacyKey];
                        delete newChecks[legacyKey + '_by'];
                        delete newChecks[legacyKey + '_at'];
                        patch[legacyKey] = undefined;
                        patch[legacyKey + '_by'] = undefined;
                        patch[legacyKey + '_at'] = undefined;
                    }
                }
                setChecks(newChecks);
                await writeCheckPatch(patch);
            };

            const getCurrentTasks = () => {
                const all = (customTasks[checklistSide] && customTasks[checklistSide][PERIOD_KEY]) || [];
                const hasNoAssign = (t) => !t.assignTo || (Array.isArray(t.assignTo) && t.assignTo.length === 0);
                // Tag each task with its original index so edit/delete still works after filtering
                let tagged = all.map((t, i) => ({...t, _origIdx: i}));
                // Recurrence filter — only show tasks matching today's day-of-week.
                // In edit mode, show all so admins can set recurrence on any task.
                if (!editMode) {
                    const today = new Date();
                    tagged = tagged.filter(t => taskShowsToday(t, today));
                }
                // Category filter — applied to both staff and admin views
                if (categoryFilter && categoryFilter !== "all") {
                    tagged = tagged.filter(t => (t.category || "other") === categoryFilter);
                }
                // Andrew 2026-05-29 round 2: "in safari im currently
                // signed in as yuly its too confusing just show yulys
                // own list when signed in so her list looks like the
                // master list. when me or julie sign in we see all
                // the lists." Restored the non-admin auto-filter so
                // a logged-in staff member sees only their assigned
                // tasks + unassigned, all rendered with the full
                // master-row UI (name chips, edit, photo, notes).
                // Per-staff columns + personal column removed for
                // non-admin viewers (see returns below).
                if (!currentIsAdmin) {
                    return tagged.filter(t => hasNoAssign(t) || isAssignedTo(t, staffName));
                }
                // Admin with filter active: show only tasks for that
                // person (+ unassigned).
                if (taskFilter) {
                    return tagged.filter(t => hasNoAssign(t) || isAssignedTo(t, taskFilter));
                }
                return tagged;
            };

            // Per-category counts for the filter chip badges
            const getCategoryCounts = () => {
                const all = (customTasks[checklistSide] && customTasks[checklistSide][PERIOD_KEY]) || [];
                const counts = { all: all.length };
                for (const c of TASK_CATEGORIES) counts[c.id] = 0;
                for (const t of all) counts[t.category || "other"] = (counts[t.category || "other"] || 0) + 1;
                return counts;
            };
            // Get all tasks without filtering (for stats)
            const getAllTasks = () => {
                return (customTasks[checklistSide] && customTasks[checklistSide][PERIOD_KEY]) || [];
            };

            // Count all checkable items (tasks + subtasks) for completion stats
            const countTaskItems = (task, prefix) => {
                const p = prefix || currentPrefix;
                let total = 0, done = 0;
                if (task.subtasks && task.subtasks.length > 0) {
                    total += task.subtasks.length;
                    done += task.subtasks.filter(s => checks[p + s.id]).length;
                } else {
                    total += 1;
                    done += checks[p + task.id] ? 1 : 0;
                }
                if (task.requirePhoto) {
                    total += 1;
                    done += checks[p + task.id + "_photo"] ? 1 : 0;
                }
                return { total, done };
            };

            const getCompletionStats = (side, listIdx) => {
                const li = listIdx !== undefined ? listIdx : activeListIdx;
                const prefix = getCheckPrefix(side, li);
                let total = 0, done = 0;
                TIME_PERIODS.forEach(p => {
                    const tasks = (customTasks[side] && customTasks[side][p.id]) || [];
                    tasks.forEach(t => { const c = countTaskItems(t, prefix); total += c.total; done += c.done; });
                });
                return { total, done };
            };

            const getPeriodStats = (side, periodId, listIdx) => {
                const li = listIdx !== undefined ? listIdx : activeListIdx;
                const prefix = getCheckPrefix(side, li);
                const tasks = (customTasks[side] && customTasks[side][periodId]) || [];
                let total = 0, done = 0;
                tasks.forEach(t => { const c = countTaskItems(t, prefix); total += c.total; done += c.done; });
                return { total, done };
            };

            // Check if a task is fully complete (all subtasks + photo if required)
            const isTaskComplete = (task) => {
                const p = currentPrefix;
                if (task.subtasks && task.subtasks.length > 0) {
                    if (!task.subtasks.every(s => checks[p + s.id])) return false;
                } else {
                    if (!checks[p + task.id]) return false;
                }
                if (task.requirePhoto && !checks[p + task.id + "_photo"]) return false;
                return true;
            };

            // Check if current staff member has opsAccess permission.
            // Policy: ONLY admins or staff with opsAccess === true can enter.
            // The shared-password backdoor was removed per the audit (any staff
            // who knew the password could enter regardless of toggle, which
            // defeated the whole point of the toggle).
            const currentStaffRecord = (staffList || []).find(s => s.name === staffName);
            const hasOpsAccess = currentIsAdmin || (currentStaffRecord && currentStaffRecord.opsAccess === true);

            if (!hasOpsAccess) {
                return (
                    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-mint-50 to-white p-4">
                        <div className="bg-white rounded-lg border-2 border-mint-700 p-8 w-full max-w-sm text-center">
                            <h2 className="text-2xl font-bold text-mint-700 mb-2">{"\u{1F512}"} {t("dailyOps", language)}</h2>
                            <p className="text-gray-600">
                                {language === "es"
                                    ? "No tienes acceso a Operaciones. Pídele al gerente que te active el permiso."
                                    : "You don't have access to Operations. Ask a manager to enable it for you."}
                            </p>
                        </div>
                    </div>
                );
            }

            // Pre-shift printout — opens a clean HTML page in a new window with
            // today's tasks for the current side, optionally scoped to one staff
            // member. Hand to the shift lead or the assignee at start of shift.
            const handlePrintTasks = () => {
                const escape = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
                const todayDate = new Date();
                const today = todayDate.toLocaleDateString(language === "es" ? "es-US" : "en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
                const tasks = getCurrentTasks();
                const sideLabel = checklistSide === "FOH" ? "Front of House" : "Back of House";
                const filterLabel = taskFilter ? ` · ${taskFilter}` : "";
                const groupedByCat = {};
                for (const t of tasks) {
                    const cat = (t.category || "other");
                    if (!groupedByCat[cat]) groupedByCat[cat] = [];
                    groupedByCat[cat].push(t);
                }
                const orderedCats = TASK_CATEGORIES.filter(c => groupedByCat[c.id]);
                const taskHtml = orderedCats.map(cat => {
                    const items = groupedByCat[cat.id];
                    return `<div class="cat">
                        <h3>${escape(cat.emoji)} ${escape(language === "es" ? cat.labelEs : cat.labelEn)}</h3>
                        <ul>${items.map(t => {
                            const subs = (t.subtasks || []).map(s => `<li class="sub">☐ ${escape(s.task)}</li>`).join("");
                            const photo = t.requirePhoto ? '<span class="badge">📸 photo</span>' : '';
                            const completeBy = t.completeBy ? `<span class="badge">⏰ by ${escape(t.completeBy)}</span>` : '';
                            const assignees = (t.assignTo ? (Array.isArray(t.assignTo) ? t.assignTo : [t.assignTo]) : []).map(a => `<span class="badge person">👤 ${escape(a)}</span>`).join('');
                            return `<li class="main">☐ ${escape(t.task)} ${photo} ${completeBy} ${assignees}${subs ? `<ul>${subs}</ul>` : ''}</li>`;
                        }).join("")}</ul>
                    </div>`;
                }).join("");
                const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>${escape(`Pre-shift Tasks · ${sideLabel} · ${today}`)}</title>
<style>
    @page { size: letter portrait; margin: 0.5in; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 0; color: #1f2937; }
    .header { padding-bottom: 8px; margin-bottom: 12px; border-bottom: 2px solid #255a37; }
    h1 { font-size: 20px; margin: 0; color: #255a37; }
    .sub { font-size: 12px; color: #6b7280; }
    .cat { margin-top: 14px; page-break-inside: avoid; }
    h3 { font-size: 13px; color: #1f2937; margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }
    ul { list-style: none; padding: 0; margin: 0; }
    li.main { font-size: 12px; padding: 6px 0; border-bottom: 1px dashed #e5e7eb; }
    li.sub { font-size: 11px; padding: 2px 0 2px 24px; color: #4b5563; }
    .badge { display: inline-block; font-size: 9px; padding: 1px 6px; background: #f3f4f6; border-radius: 8px; margin-left: 4px; color: #374151; }
    .badge.person { background: #dbeafe; color: #1e40af; }
    .footer { margin-top: 18px; font-size: 9px; color: #9ca3af; text-align: center; }
</style>
</head><body>
<div class="header">
    <h1>📋 ${escape(sideLabel)} — Pre-Shift Tasks${escape(filterLabel)}</h1>
    <div class="sub">${escape(today)} · ${escape(LOCATION_LABELS[storeLocation] || storeLocation)} · ${tasks.length} tasks</div>
</div>
${taskHtml || '<p style="text-align:center;color:#9ca3af;padding:40px">No tasks for today.</p>'}
<div class="footer">Printed ${new Date().toLocaleString()} · DD Mau</div>
<script>setTimeout(() => window.print(), 300);</script>
</body></html>`;
                if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Tasks'); return; }
                const w = window.open("", "_blank", "width=800,height=1000");
                if (!w) { toast(language === "es" ? "Ventana bloqueada." : "Pop-up blocked."); return; }
                w.document.open(); w.document.write(html); w.document.close();
            };

            const renderChecklist = () => {
                const tasks = getCurrentTasks();
                const allTasks = getAllTasks();
                const periodStats = getPeriodStats(checklistSide, PERIOD_KEY);
                const overallStats = getCompletionStats(checklistSide);

                // Per-assignee columns — Andrew 2026-05-28: "the
                // current list ... is the master list ... when i
                // assign a staff ... right next to it it starts a new
                // list ... [staff name] at the top and the task ..."
                // Group every task in the master by its assignees so
                // each assignee gets a column on the right. Multiple
                // assignees on one task = task appears in multiple
                // columns. Done state is shared (single check key per
                // task), so checking off in any column flips master.
                const assigneeColumns = (() => {
                    const map = new Map();
                    for (const t of allTasks) {
                        const names = getAssignees(t);
                        for (const n of names) {
                            if (!n) continue;
                            if (!map.has(n)) map.set(n, []);
                            map.get(n).push(t);
                        }
                    }
                    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
                })();

                return (
                    // Horizontal scroller — master list on the LEFT,
                    // per-assignee columns to the RIGHT for ADMINS
                    // only. Non-admin viewers see ONLY the master
                    // (filtered to their tasks by getCurrentTasks);
                    // the per-staff columns are hidden so their page
                    // is a single focused list with all the same
                    // features the admin master list has (name chips,
                    // edit, photo, notes, etc.). Andrew 2026-05-29:
                    // "just show yulys own list when signed in so her
                    // list looks like the master list. when me or
                    // julie sign in we see all the lists."
                    <div className="flex gap-3 overflow-x-auto -mx-4 px-4 pb-3 scrollbar-thin">
                    <div className="space-y-3 w-[88vw] sm:w-auto sm:flex-1 sm:min-w-[420px] sm:max-w-3xl shrink-0">
                        {/* FOH / BOH side selector — v2 segmented control (matches Schedule).
                            Emojis dropped — 🪑 + 🍳 don't render reliably across systems
                            (showed as fallback tofu on some browsers). Side codes alone
                            are universally read by restaurant staff.
                            2026-05-24 — Andrew: hidden for single-side non-admin staff.
                            They already landed on their side at mount; the toggle
                            would only let them peek at the other side, which adds
                            confusion + invites them to tick the wrong checkmarks. */}
                        {showSideTabs && (
                            <div className="flex gap-1 mb-1 bg-white border border-dd-line rounded-lg p-1 shadow-card">
                                {["FOH", "BOH"].map(side => {
                                    const isActive = checklistSide === side;
                                    const activeBg = side === "FOH" ? "bg-dd-green text-white shadow-sm" : "bg-orange-600 text-white shadow-sm";
                                    return (
                                        <button key={side} onClick={() => { setChecklistSide(side); setActiveListIdx(0); setEditMode(false); setEditingIdx(null); setShowAddForm(false); setTaskFilter(""); }}
                                            className={`flex-1 py-2 px-2 rounded-md font-bold text-sm transition active:scale-95 ${isActive ? activeBg : "text-dd-text-2 hover:bg-dd-bg"}`}>
                                            {side}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {/* BOH-only: pending sauce requests from FOH.
                            Collapsible — Andrew 2026-05-28: "lets also
                            make the sauces window collapsible." Toggle
                            stays at the top so the banner can be hidden
                            without losing the affordance to reopen it. */}
                        {checklistSide === "BOH" && (
                            <div className={`rounded-xl overflow-hidden border ${
                                sauceCounts.today > 0 ? 'bg-red-50 border-red-300'
                                : sauceCounts.tomorrow > 0 ? 'bg-yellow-50 border-yellow-300'
                                : 'bg-amber-50 border-amber-200'
                            }`}>
                                <button
                                    onClick={() => setSauceCollapsed(v => !v)}
                                    className="w-full px-3 py-2 flex items-center gap-2 text-left text-xs font-bold text-amber-900 hover:bg-amber-100/60 transition">
                                    <span className="text-base leading-none">{sauceCollapsed ? '▸' : '▾'}</span>
                                    <span className="flex-1 flex items-center gap-1.5 flex-wrap">
                                        🥢 {language === "es" ? "Pedidos de salsa" : "Sauce requests"}
                                        {/* Counter pills — only render when
                                            there is something to show. Today
                                            is red, tomorrow is yellow. Andrew
                                            2026-05-28: "have a little ticker
                                            or counter for urgent and tomorrow." */}
                                        {sauceCounts.today > 0 && (
                                            <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] font-bold ${sauceCollapsed ? 'animate-pulse' : ''}`}>
                                                🚨 {sauceCounts.today} {language === "es" ? "hoy" : "today"}
                                            </span>
                                        )}
                                        {sauceCounts.tomorrow > 0 && (
                                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-yellow-400 text-yellow-900 text-[10px] font-bold">
                                                ⏰ {sauceCounts.tomorrow} {language === "es" ? "mañana" : "tomorrow"}
                                            </span>
                                        )}
                                        {sauceCounts.later > 0 && sauceCounts.today === 0 && sauceCounts.tomorrow === 0 && (
                                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 border border-green-300 text-[10px] font-bold">
                                                {sauceCounts.later} {language === "es" ? "después" : "later"}
                                            </span>
                                        )}
                                    </span>
                                    <span className="text-[10px] text-amber-700 font-normal flex-shrink-0">
                                        {sauceCollapsed
                                            ? (language === "es" ? "Mostrar" : "Show")
                                            : (language === "es" ? "Ocultar" : "Hide")}
                                    </span>
                                </button>
                                {!sauceCollapsed && (
                                    <SauceLogBohBanner
                                        language={language}
                                        staffName={staffName}
                                        staffList={staffList}
                                        storeLocation={storeLocation}
                                        onOpenSauceLog={() => setActiveTab("saucelog")}
                                    />
                                )}
                            </div>
                        )}

                        {/* Admin: filter by staff member */}
                        {currentIsAdmin && (
                            <div className="flex items-center gap-2 mb-2 bg-gray-50 rounded-lg p-2">
                                <span className="text-xs font-bold text-gray-500">{String.fromCodePoint(0x1F441)} {language === "es" ? "Ver" : "View"}:</span>
                                <select
                                    value={taskFilter}
                                    onChange={e => setTaskFilter(e.target.value)}
                                    className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs font-bold bg-white">
                                    <option value="">{language === "es" ? "\u{2014} Todos \u{2014}" : "\u{2014} All Staff \u{2014}"}</option>
                                    {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").map(s => (
                                        <option key={s.id} value={s.name}>{s.name}</option>
                                    ))}
                                </select>
                                {taskFilter && (
                                    <button onClick={() => setTaskFilter("")} className="text-xs text-red-500 font-bold px-1">{String.fromCodePoint(0x2715)}</button>
                                )}
                            </div>
                        )}

                        {/* Non-admin hint — single focused list view.
                            Andrew 2026-05-29: "just show yulys own
                            list when signed in." */}
                        {!currentIsAdmin && (
                            <div className="text-center text-xs font-bold py-1.5 rounded-lg mb-2 bg-green-50 text-green-700 border border-green-200">
                                {language === "es" ? "Mostrando tus tareas asignadas" : "Showing your assigned tasks"}
                            </div>
                        )}

                        {/* "Today's snapshot" manager dashboard removed
                            2026-05-25 — Andrew: "we can take off the
                            today's snap shop in tasks no need." The card
                            showed FOH/BOH completion %, overdue count,
                            and a top-5 scoreboard. Per-task completion
                            still lives inline on each task row; the
                            scoreboard / overdue / per-side % were
                            redundant with what staff see on their list. */}

                        {/* Print + Edit buttons */}
                        <div className="flex justify-end items-center gap-2 mt-1 print:hidden">
                            <button onClick={handlePrintTasks}
                                title={language === "es" ? "Imprimir tareas para el turno" : "Print pre-shift task list"}
                                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-gray-100 text-gray-700 hover:bg-gray-200">
                                🖨 {language === "es" ? "Imprimir" : "Print"}
                            </button>
                            {currentIsAdmin && (
                                <button onClick={() => { setEditMode(!editMode); setEditingIdx(null); setShowAddForm(false); }}
                                    className={"px-3 py-1.5 rounded-lg text-xs font-bold transition " + (editMode ? "bg-mint-100 text-mint-700 border border-mint-200" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}>
                                    {editMode ? (language === "es" ? "Listo" : "Done") : "\u{270F}\u{FE0F} " + (language === "es" ? "Editar" : "Edit")}
                                </button>
                            )}
                        </div>

                        {/* Category filter chips — restaurant-task-app convention. Tap a chip to scope. */}
                        {(() => {
                            const counts = getCategoryCounts();
                            return (
                                <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 mb-1" style={{ scrollbarWidth: "thin" }}>
                                    <button onClick={() => setCategoryFilter("all")}
                                        className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border transition ${categoryFilter === "all" ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}`}>
                                        {language === "es" ? "Todas" : "All"} <span className="opacity-70">({counts.all})</span>
                                    </button>
                                    {TASK_CATEGORIES.map(c => (
                                        counts[c.id] > 0 || categoryFilter === c.id ? (
                                            <button key={c.id} onClick={() => setCategoryFilter(c.id)}
                                                className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold border transition ${categoryFilter === c.id ? c.color.replace("bg-", "bg-").replace("text-", "text-") + " ring-2 ring-offset-1 ring-gray-700" : c.color + " hover:opacity-80"}`}>
                                                {c.emoji} {language === "es" ? c.labelEs : c.labelEn} <span className="opacity-70">({counts[c.id]})</span>
                                            </button>
                                        ) : null
                                    ))}
                                </div>
                            );
                        })()}

                        {/* Quick-add — single input, syntax: "Title ; sub1 ; sub2 ; sub3" */}
                        {currentIsAdmin && (
                            <div className="flex gap-1 mb-2">
                                <input type="text" value={quickAddText}
                                    onChange={e => setQuickAddText(e.target.value)}
                                    onKeyDown={e => { if (e.key === "Enter") quickAddTask(); }}
                                    placeholder={language === "es" ? "+ Tarea rápida — usa ' ; ' para subtareas" : "+ Quick add — use ' ; ' for subtasks"}
                                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white" />
                                <button onClick={quickAddTask}
                                    disabled={!quickAddText.trim()}
                                    className={`px-3 py-2 rounded-lg text-sm font-bold ${quickAddText.trim() ? "bg-mint-700 text-white hover:bg-mint-800" : "bg-gray-200 text-gray-400"}`}>
                                    +
                                </button>
                            </div>
                        )}

                        {/* Task list */}
                        {tasks.length === 0 && !editMode && (
                            <div className="text-center py-6 text-gray-400 text-sm">
                                {language === "es" ? "No hay tareas para este período" : "No tasks for this period"}
                            </div>
                        )}

                        {tasks.map((item, idx) => {
                            const origIdx = item._origIdx !== undefined ? item._origIdx : idx;
                            const hasSubtasks = item.subtasks && item.subtasks.length > 0;
                            const taskComplete = isTaskComplete(item);
                            const photoUrl = checks[currentPrefix + item.id + "_photo"];
                            const photoNeeded = item.requirePhoto && !photoUrl;
                            const assignees = getAssignees(item);

                            // Compute urgency for flashing: "warning" (30 min before), "overdue" (past time)
                            // Anchored to Chicago wall-clock (BUSINESS_TZ).
                            let taskUrgency = null;
                            if (item.completeBy && !taskComplete) {
                                const curMin = getBusinessMinutesNow();
                                const [dh, dm] = item.completeBy.split(":").map(Number);
                                const deadMin = dh * 60 + dm;
                                if (curMin >= deadMin) taskUrgency = "overdue";
                                else if (curMin >= deadMin - 30) taskUrgency = "warning";
                            }

                            if (editingIdx === origIdx) {
                                return (
                                    <div key={item.id} className="p-3 rounded-lg border-2 border-blue-300 bg-blue-50">
                                        <input type="text" value={editTask} onChange={e => setEditTask(e.target.value)}
                                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-400" autoFocus />
                                        {/* Category picker */}
                                        <div className="mb-2">
                                            <label className="text-xs font-bold text-gray-600 block mb-1">{language === "es" ? "Categoría" : "Category"}</label>
                                            <div className="flex flex-wrap gap-1">
                                                {TASK_CATEGORIES.map(c => (
                                                    <button key={c.id} onClick={() => setEditCategory(c.id)}
                                                        className={`px-2 py-1 rounded-full text-[11px] font-bold border transition ${editCategory === c.id ? c.color + " ring-2 ring-offset-1 ring-gray-700" : "bg-white text-gray-500 border-gray-300 hover:bg-gray-50"}`}>
                                                        {c.emoji} {language === "es" ? c.labelEs : c.labelEn}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        {/* Recurrence picker */}
                                        <div className="mb-2">
                                            <label className="text-xs font-bold text-gray-600 block mb-1">🔁 {language === "es" ? "Recurrencia" : "Recurrence"}</label>
                                            <select value={editRecurrence} onChange={e => setEditRecurrence(e.target.value)}
                                                className="w-full border border-gray-200 rounded px-2 py-1 text-xs">
                                                {TASK_RECURRENCE.map(r => (
                                                    <option key={r.id} value={r.id}>{language === "es" ? r.labelEs : r.labelEn}</option>
                                                ))}
                                            </select>
                                        </div>
                                        {/* Complete by time */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <label className="text-xs font-bold text-gray-600">{"\u{23F0}"} {language === "es" ? "Completar antes de:" : "Complete by:"}</label>
                                            <input type="time" value={editCompleteBy} onChange={e => setEditCompleteBy(e.target.value)}
                                                className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                            {editCompleteBy && <button onClick={() => setEditCompleteBy("")} className="text-red-400 text-xs">{"\u{2715}"}</button>}
                                        </div>
                                        {/* Assign to (always visible) */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <label className="text-xs font-bold text-gray-600">{String.fromCodePoint(0x1F464)} {language === "es" ? "Asignar a:" : "Assign to:"}</label>
                                            <select value="" onChange={e => { if (e.target.value) { const cur = editAssignTo ? (Array.isArray(editAssignTo) ? editAssignTo : [editAssignTo]) : []; if (!cur.includes(e.target.value)) setEditAssignTo([...cur, e.target.value]); } }}
                                                className="border border-gray-200 rounded px-2 py-1 text-xs flex-1">
                                                <option value="">{language === "es" ? "\u{2014} Agregar persona \u{2014}" : "\u{2014} Add person \u{2014}"}</option>
                                                {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").filter(s => !(Array.isArray(editAssignTo) ? editAssignTo : editAssignTo ? [editAssignTo] : []).includes(s.name)).map(s => (
                                                    <option key={s.id} value={s.name}>{s.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                        {(Array.isArray(editAssignTo) ? editAssignTo : editAssignTo ? [editAssignTo] : []).length > 0 && (
                                            <div className="flex flex-wrap gap-1 mb-2">
                                                {(Array.isArray(editAssignTo) ? editAssignTo : [editAssignTo]).map(name => (
                                                    <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-bold">
                                                        {name.split(" ")[0]}
                                                        <button onClick={() => { const cur = Array.isArray(editAssignTo) ? editAssignTo : [editAssignTo]; setEditAssignTo(cur.filter(n => n !== name)); }}
                                                            className="text-blue-400 hover:text-red-500">{String.fromCodePoint(0x2715)}</button>
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        {/* Photo toggle */}
                                        <label className="flex items-center gap-2 mb-2 text-xs cursor-pointer">
                                            <input type="checkbox" checked={editRequirePhoto} onChange={e => setEditRequirePhoto(e.target.checked)} className="w-4 h-4" />
                                            <span className="font-bold text-gray-600">{"\u{1F4F8}"} {language === "es" ? "Requiere foto" : "Require photo"}</span>
                                        </label>
                                        {/* Subtasks editor */}
                                        <div className="mb-2">
                                            <p className="text-xs font-bold text-gray-500 mb-1">{language === "es" ? "Subtareas" : "Subtasks"}</p>
                                            {editSubtasks.map((sub, si) => (
                                                <div key={si} className="flex gap-1 mb-1">
                                                    <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={sub.task}
                                                        onChange={e => { const u = [...editSubtasks]; u[si] = {...u[si], task: e.target.value}; setEditSubtasks(u); }}
                                                        placeholder={(language === "es" ? "Subtarea " : "Subtask ") + (si+1)} />
                                                    <button onClick={() => setEditSubtasks(editSubtasks.filter((_,i) => i !== si))} className="text-red-400 text-xs px-1">{"\u{2715}"}</button>
                                                </div>
                                            ))}
                                            <button onClick={() => setEditSubtasks([...editSubtasks, {id: "", task: ""}])}
                                                className="text-xs text-mint-700 font-bold">+ {language === "es" ? "Agregar subtarea" : "Add subtask"}</button>
                                        </div>
                                        {/* Follow-up question editor */}
                                        <div className="mb-2 border-t border-gray-200 pt-2">
                                            <div className="flex items-center justify-between mb-1">
                                                <p className="text-xs font-bold text-gray-500">{"\u{2753}"} {language === "es" ? "Pregunta al completar" : "Follow-up question"}</p>
                                                {!editFollowUp ? (
                                                    <button onClick={() => setEditFollowUp({ type: "dropdown", question: "", options: [""] })}
                                                        className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar" : "Add"}</button>
                                                ) : (
                                                    <button onClick={() => setEditFollowUp(null)} className="text-red-400 text-xs">{"\u{2715}"} {language === "es" ? "Quitar" : "Remove"}</button>
                                                )}
                                            </div>
                                            {editFollowUp && (
                                                <div className="space-y-2 bg-blue-50 p-2 rounded border border-blue-200">
                                                    <input type="text" value={editFollowUp.question} onChange={e => setEditFollowUp({...editFollowUp, question: e.target.value})}
                                                        placeholder={language === "es" ? "Escribe la pregunta..." : "Type your question..."}
                                                        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:border-blue-400" />
                                                    <div className="flex gap-2">
                                                        <button onClick={() => setEditFollowUp({...editFollowUp, type: "dropdown", options: editFollowUp.options?.length ? editFollowUp.options : [""]})}
                                                            className={`flex-1 py-1 rounded text-xs font-bold ${editFollowUp.type === "dropdown" ? "bg-blue-600 text-white" : "bg-white text-gray-600 border"}`}>
                                                            {language === "es" ? "Opciones" : "Choices"}
                                                        </button>
                                                        <button onClick={() => setEditFollowUp({...editFollowUp, type: "text"})}
                                                            className={`flex-1 py-1 rounded text-xs font-bold ${editFollowUp.type === "text" ? "bg-blue-600 text-white" : "bg-white text-gray-600 border"}`}>
                                                            {language === "es" ? "Texto libre" : "Text input"}
                                                        </button>
                                                    </div>
                                                    {editFollowUp.type === "dropdown" && (
                                                        <div className="space-y-1">
                                                            {(editFollowUp.options || []).map((opt, oi) => (
                                                                <div key={oi} className="flex gap-1">
                                                                    <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={opt}
                                                                        onChange={e => { const u = [...editFollowUp.options]; u[oi] = e.target.value; setEditFollowUp({...editFollowUp, options: u}); }}
                                                                        placeholder={(language === "es" ? "Opción " : "Option ") + (oi+1)} />
                                                                    <button onClick={() => { const u = editFollowUp.options.filter((_,i) => i !== oi); setEditFollowUp({...editFollowUp, options: u}); }}
                                                                        className="text-red-400 text-xs px-1">{"\u{2715}"}</button>
                                                                </div>
                                                            ))}
                                                            <button onClick={() => setEditFollowUp({...editFollowUp, options: [...(editFollowUp.options || []), ""]})}
                                                                className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar opción" : "Add option"}</button>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => saveChecklistEdit(origIdx)}
                                                className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg">{language === "es" ? "Guardar" : "Save"}</button>
                                            <button onClick={() => { setEditingIdx(null); setEditCategory("other"); setEditSubtasks([]); setEditCompleteBy(""); setEditAssignTo([]); setEditFollowUp(null); }}
                                                className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                        </div>
                                    </div>
                                );
                            }

                            return (
                                <div key={item.id}
                                    data-task-id={item.id}
                                    className={"rounded-lg border-2 transition overflow-hidden " +
                                    (taskComplete ? "border-green-300 bg-green-50"
                                        : taskUrgency === "overdue" ? "task-flash-red"
                                        : taskUrgency === "warning" ? "task-flash-yellow"
                                        : "border-gray-200 bg-white")}>
                                    <div className="flex items-center gap-1">
                                        <div className={"flex-1 flex items-start p-3 " + (!editMode && !hasSubtasks ? "cursor-pointer" : "")}>
                                            {!editMode && !hasSubtasks && (
                                                <input type="checkbox" checked={checks[currentPrefix + item.id] || false}
                                                    onChange={() => toggleCheckItem(item.id, item)}
                                                    className="w-5 h-5 text-mint-700 rounded focus:ring-2 focus:ring-mint-700 mt-0.5" />
                                            )}
                                            <div className={"flex-1 " + (!editMode && !hasSubtasks ? "ml-3" : "")}>
                                                <div className="flex items-center gap-1.5 flex-wrap">
                                                    <p className={"font-bold text-gray-800 " + (taskComplete ? "line-through text-green-700" : "")}>
                                                        {(item.task || "").includes("\n") ? item.task.split("\n").map((line, li) => (
                                                            <span key={li}>{li === 0 ? line : <><br/><span className="font-normal text-xs text-gray-500">{line}</span></>}</span>
                                                        )) : item.task}
                                                    </p>
                                                    {(() => {
                                                        const cat = getCategoryFor(item);
                                                        if (cat.id === "other") return null;
                                                        return (
                                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${cat.color}`}>
                                                                {cat.emoji} {language === "es" ? cat.labelEs : cat.labelEn}
                                                            </span>
                                                        );
                                                    })()}
                                                    {item.recurrence && item.recurrence !== "daily" && (
                                                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-cyan-100 text-cyan-800 border border-cyan-300">
                                                            🔁 {(TASK_RECURRENCE_BY_ID[item.recurrence] || {})[language === "es" ? "labelEs" : "labelEn"] || item.recurrence}
                                                        </span>
                                                    )}
                                                    {item.requirePhoto && <span className="text-xs">{"\u{1F4F8}"}</span>}
                                                    {item.completeBy && (
                                                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                                                            taskComplete ? "bg-green-100 text-green-600"
                                                            : taskUrgency === "overdue" ? "bg-red-600 text-white"
                                                            : taskUrgency === "warning" ? "bg-yellow-400 text-yellow-900"
                                                            : "bg-orange-100 text-orange-600"
                                                        }`}>
                                                            {taskUrgency === "overdue" ? "\u{1F6A8}" : "\u{23F0}"} {item.completeBy.replace(/^0/, "")}
                                                        </span>
                                                    )}
                                                    {/* Per-assignee progress chip — Andrew 2026-05-28:
                                                        "the master say 1/2 complete or 0/2 or 2/2."
                                                        Only renders when 2+ assignees so single-assignee
                                                        tasks keep the simple checkbox UX. */}
                                                    {assignees.length > 1 && (() => {
                                                        const prog = getAssigneeProgress(item);
                                                        const full = prog.done >= prog.total;
                                                        return (
                                                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                                                                full ? 'bg-green-100 text-green-700 border border-green-300'
                                                                : prog.done > 0 ? 'bg-amber-100 text-amber-700 border border-amber-300'
                                                                : 'bg-gray-100 text-gray-700 border border-gray-300'
                                                            }`}>
                                                                {prog.done}/{prog.total} {language === 'es' ? 'hecho' : 'done'}
                                                            </span>
                                                        );
                                                    })()}
                                                </div>
                                                {/* Assignee chips — each chip gets a ✓ when its
                                                    assignee has marked the task done. Master can
                                                    see at a glance who has and who has not. */}
                                                {assignees.length > 0 && (
                                                    <div className="flex flex-wrap gap-1 mt-1">
                                                        {assignees.map(asName => {
                                                            const asDone = isDoneForAssignee(item, asName);
                                                            return (
                                                                <span key={asName} className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                                                                    asDone ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                                                                }`}>
                                                                    {asDone ? '✓' : String.fromCodePoint(0x1F464)} {asName.split(" ")[0]}
                                                                    {currentIsAdmin && editMode && (
                                                                        <button onClick={(e) => { e.stopPropagation(); toggleTaskAssignee(origIdx, asName); }}
                                                                            className={`ml-0.5 ${asDone ? 'text-green-500 hover:text-red-500' : 'text-blue-400 hover:text-red-500'}`}>{String.fromCodePoint(0x2715)}</button>
                                                                    )}
                                                                </span>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                                {/* 2026-05-24 — Assign button (admin/manager, always visible
                                                    no edit-mode required). Replaces the buried tiny <select>
                                                    with a bottom-sheet multi-select picker (AssigneePickerModal).
                                                    Andrew: "make it easier to assign a staff to the tasks." */}
                                                {(currentIsAdmin || /manager/i.test(staffRole?.role || '')) && (
                                                    <div className="mt-1.5">
                                                        <button
                                                            type="button"
                                                            onClick={(e) => { e.stopPropagation(); setAssigningTaskIdx(origIdx); }}
                                                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-dd-line hover:bg-dd-bg text-[11px] font-bold text-dd-text-2 active:scale-95 transition"
                                                            title={language === "es" ? "Asignar personal" : "Assign staff"}
                                                        >
                                                            👤 {assignees.length === 0
                                                                ? `+ ${language === "es" ? "Asignar" : "Assign"}`
                                                                : `${language === "es" ? "Editar asignados" : "Edit assignees"}`}
                                                        </button>
                                                    </div>
                                                )}
                                                {/* Completed by info {"\u{2014}"} for tasks without subtasks */}
                                                {!hasSubtasks && checks[currentPrefix + item.id] && checks[currentPrefix + item.id + "_by"] && (
                                                    <p className="text-xs text-green-600 mt-0.5">
                                                        {String.fromCodePoint(0x2713)} {checks[currentPrefix + item.id + "_by"]} {String.fromCodePoint(0x2014)} {checks[currentPrefix + item.id + "_at"]}
                                                    </p>
                                                )}
                                                {/* 📨 Push messaging — admin/manager only. Sends a message
                                                    to the task's assignees as a real push notification.
                                                    Either right now ("Send now") or queued to fire when the
                                                    task is checked complete ("Send when complete"). Each
                                                    on-complete message fires once and is marked delivered.
                                                    Recipient sees it in their preferred language. */}
                                                {currentIsAdmin && (() => {
                                                    const isOpen = openMsgTask === item.id;
                                                    const queued = (item.messages || []).filter(m => m.deliverWhen === 'on_complete' && !m.delivered);
                                                    return (
                                                        <div className="mt-1">
                                                            <button onClick={() => { setOpenMsgTask(isOpen ? null : item.id); setMsgDraft(""); setMsgDeliverWhen("now"); }}
                                                                className={`text-[11px] font-bold underline ${queued.length > 0 ? 'text-purple-700' : 'text-gray-500'}`}>
                                                                📨 {queued.length > 0
                                                                    ? `${queued.length} ${language === 'es' ? 'mensaje(s) en cola' : 'queued msg(s)'}`
                                                                    : (language === 'es' ? 'Enviar mensaje' : 'Send message')}
                                                            </button>
                                                            {isOpen && (
                                                                <div className="mt-1 bg-purple-50 border border-purple-200 rounded p-2 space-y-2">
                                                                    <div className="text-[10px] text-purple-900">
                                                                        {language === 'es'
                                                                            ? `Se enviará a: ${assignees.join(', ') || '(sin asignados)'}`
                                                                            : `Will send to: ${assignees.join(', ') || '(no assignees)'}`}
                                                                    </div>
                                                                    {queued.length > 0 && (
                                                                        <div className="text-[10px] text-purple-700 bg-white border border-purple-100 rounded p-1">
                                                                            <div className="font-bold mb-0.5">{language === 'es' ? 'En cola para entrega al completar:' : 'Queued for completion delivery:'}</div>
                                                                            {queued.map((m, mi) => (
                                                                                <div key={mi} className="flex items-start justify-between gap-2">
                                                                                    <span>"{typeof m.text === 'object' ? (m.text.en || m.text.es) : m.text}"</span>
                                                                                    <button onClick={async () => {
                                                                                        const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                                                                                        const list = updated[checklistSide][PERIOD_KEY] || [];
                                                                                        const tIdx = list.findIndex(t => t.id === item.id);
                                                                                        if (tIdx >= 0) {
                                                                                            list[tIdx].messages = (list[tIdx].messages || []).filter(x => !(x.deliverWhen === m.deliverWhen && x.text === m.text && !x.delivered));
                                                                                            setCustomTasks(updated);
                                                                                            await writeChecklistPatch({ customTasks: updated });
                                                                                        }
                                                                                    }} className="text-red-500 text-xs">×</button>
                                                                                </div>
                                                                            ))}
                                                                        </div>
                                                                    )}
                                                                    <textarea value={msgDraft} onChange={e => setMsgDraft(e.target.value)}
                                                                        placeholder={language === 'es' ? 'Mensaje al equipo asignado...' : 'Message to assigned staff...'}
                                                                        rows={2}
                                                                        className="w-full px-2 py-1 border border-purple-200 rounded text-[11px]" />
                                                                    <div className="flex gap-1 text-[10px]">
                                                                        <button onClick={() => setMsgDeliverWhen('now')}
                                                                            className={`flex-1 py-1 rounded font-bold ${msgDeliverWhen === 'now' ? 'bg-purple-600 text-white' : 'bg-white border border-purple-200 text-purple-700'}`}>
                                                                            {language === 'es' ? 'Ahora' : 'Send now'}
                                                                        </button>
                                                                        <button onClick={() => setMsgDeliverWhen('on_complete')}
                                                                            className={`flex-1 py-1 rounded font-bold ${msgDeliverWhen === 'on_complete' ? 'bg-purple-600 text-white' : 'bg-white border border-purple-200 text-purple-700'}`}>
                                                                            {language === 'es' ? 'Al completar' : 'When complete'}
                                                                        </button>
                                                                    </div>
                                                                    <button onClick={async () => {
                                                                        const text = msgDraft.trim();
                                                                        if (!text) return;
                                                                        if (msgDeliverWhen === 'now') {
                                                                            await dispatchTaskMessage(item, { text }, 'now');
                                                                            toast(language === 'es' ? '✓ Mensaje enviado' : '✓ Message sent');
                                                                        } else {
                                                                            // Queue on the task itself for later delivery.
                                                                            const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                                                                            const list = updated[checklistSide][PERIOD_KEY] || [];
                                                                            const tIdx = list.findIndex(t => t.id === item.id);
                                                                            if (tIdx >= 0) {
                                                                                list[tIdx].messages = [...(list[tIdx].messages || []), { text, deliverWhen: 'on_complete', queuedBy: staffName, queuedAt: new Date().toISOString(), delivered: false }];
                                                                                setCustomTasks(updated);
                                                                                await writeChecklistPatch({ customTasks: updated });
                                                                                toast(language === 'es' ? '✓ Mensaje en cola para entrega al completar' : '✓ Queued for completion delivery');
                                                                            }
                                                                        }
                                                                        setMsgDraft(""); setOpenMsgTask(null);
                                                                    }}
                                                                        disabled={!msgDraft.trim()}
                                                                        className={`w-full py-1 rounded text-[11px] font-bold ${msgDraft.trim() ? 'bg-purple-700 text-white' : 'bg-gray-200 text-gray-400'}`}>
                                                                        📨 {msgDeliverWhen === 'now'
                                                                            ? (language === 'es' ? 'Enviar ahora' : 'Send now')
                                                                            : (language === 'es' ? 'Poner en cola' : 'Queue for completion')}
                                                                    </button>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })()}

                                                {/* Comment thread — collapsed badge on the card,
                                                    expand to see + add. Always-visible 💬 toggle below the title. */}
                                                {(() => {
                                                    const ck = currentPrefix + item.id + "_comments";
                                                    const comments = Array.isArray(checks[ck]) ? checks[ck] : [];
                                                    const isOpen = openCommentTask === item.id;
                                                    return (
                                                        <div className="mt-1">
                                                            <button onClick={() => { setOpenCommentTask(isOpen ? null : item.id); setCommentDraft(""); }}
                                                                className={`text-[11px] font-bold underline ${comments.length > 0 ? "text-blue-700" : "text-gray-500"}`}>
                                                                💬 {comments.length > 0 ? `${comments.length} ${language === "es" ? "nota(s)" : "note(s)"}` : (language === "es" ? "Agregar nota" : "Add note")}
                                                            </button>
                                                            {isOpen && (
                                                                <div className="mt-1 bg-blue-50 border border-blue-200 rounded p-2 space-y-1">
                                                                    {comments.length === 0 && (
                                                                        <p className="text-[10px] text-gray-500 italic">{language === "es" ? "Aún no hay notas" : "No notes yet"}</p>
                                                                    )}
                                                                    {comments.map((c, ci) => (
                                                                        <div key={ci} className="flex items-start justify-between gap-2 bg-white rounded p-1.5 border border-blue-100">
                                                                            <div className="text-[11px] flex-1 min-w-0">
                                                                                <span className="font-bold text-blue-800">{c.by}</span>
                                                                                <span className="text-gray-400 ml-1">{c.at}</span>
                                                                                <div className="text-gray-700 mt-0.5">{c.text}</div>
                                                                            </div>
                                                                            <button onClick={() => removeTaskComment(item.id, ci)}
                                                                                className="text-red-400 hover:text-red-600 text-xs">×</button>
                                                                        </div>
                                                                    ))}
                                                                    <div className="flex gap-1">
                                                                        <input type="text" value={commentDraft}
                                                                            onChange={e => setCommentDraft(e.target.value)}
                                                                            onKeyDown={e => { if (e.key === "Enter" && commentDraft.trim()) { addTaskComment(item.id, commentDraft, item); setCommentDraft(""); } }}
                                                                            placeholder={language === "es" ? "Anota algo..." : "Type a note..."}
                                                                            className="flex-1 px-2 py-1 border border-blue-200 rounded text-[11px]" />
                                                                        <button onClick={() => { if (commentDraft.trim()) { addTaskComment(item.id, commentDraft, item); setCommentDraft(""); } }}
                                                                            disabled={!commentDraft.trim()}
                                                                            className={`px-2 py-1 rounded text-[11px] font-bold ${commentDraft.trim() ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-400"}`}>
                                                                            ✓
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })()}
                                            </div>
                                        </div>
                                        {editMode && (
                                            <div className="flex flex-col gap-1 pr-2">
                                                {/* Up / Down arrows reorder this task in the
                                                    period array. Swap with the VISIBLE neighbor
                                                    (using their _origIdx) so the order works as
                                                    the admin sees it on screen, even with a
                                                    category filter active. */}
                                                <button onClick={() => moveChecklistTaskWithScroll(origIdx, idx > 0 ? tasks[idx - 1]._origIdx : origIdx, item.id)}
                                                    disabled={idx === 0}
                                                    title={language === "es" ? "Mover arriba" : "Move up"}
                                                    className={`px-1.5 py-0.5 rounded-lg text-gray-600 text-xs leading-none ${idx === 0 ? 'opacity-30 cursor-not-allowed' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                                    ▲
                                                </button>
                                                <button onClick={() => moveChecklistTaskWithScroll(origIdx, idx < tasks.length - 1 ? tasks[idx + 1]._origIdx : origIdx, item.id)}
                                                    disabled={idx === tasks.length - 1}
                                                    title={language === "es" ? "Mover abajo" : "Move down"}
                                                    className={`px-1.5 py-0.5 rounded-lg text-gray-600 text-xs leading-none ${idx === tasks.length - 1 ? 'opacity-30 cursor-not-allowed' : 'bg-gray-100 hover:bg-gray-200'}`}>
                                                    ▼
                                                </button>
                                                <button onClick={() => { setEditingIdx(origIdx); setEditTask(item.task); setEditCategory(item.category || "other"); setEditRecurrence(item.recurrence || "daily"); setEditRequirePhoto(!!item.requirePhoto); setEditCompleteBy(item.completeBy || ""); setEditAssignTo(item.assignTo ? (Array.isArray(item.assignTo) ? [...item.assignTo] : [item.assignTo]) : []); setEditFollowUp(item.followUp ? {...item.followUp, options: item.followUp.options ? [...item.followUp.options] : []} : null); setEditSubtasks(item.subtasks ? item.subtasks.map(s => ({...s})) : []); setShowAddForm(false); }}
                                                    className="p-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100">{String.fromCodePoint(0x270F, 0xFE0F)}</button>
                                                <button onClick={() => deleteChecklistTask(origIdx)}
                                                    className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100">{"\u{1F5D1}"}{"\u{FE0F}"}</button>
                                            </div>
                                        )}
                                    </div>

                                    {/* Subtasks */}
                                    {hasSubtasks && !editMode && (
                                        <div className="px-3 pb-2 space-y-1 ml-4 border-t border-gray-100 pt-2">
                                            {item.subtasks.map(sub => (
                                                <div key={sub.id}>
                                                    <label className="flex items-center gap-2 cursor-pointer">
                                                        <input type="checkbox" checked={checks[currentPrefix + sub.id] || false}
                                                            onChange={() => toggleCheckItem(sub.id, item)}
                                                            className="w-4 h-4 text-mint-600 rounded" />
                                                        <span className={"text-sm " + (checks[currentPrefix + sub.id] ? "line-through text-green-600" : "text-gray-700")}>{sub.task}</span>
                                                    </label>
                                                    {checks[currentPrefix + sub.id] && checks[currentPrefix + sub.id + "_by"] && (
                                                        <p className="text-xs text-green-600 ml-6">
                                                            {"\u{2713}"} {checks[currentPrefix + sub.id + "_by"]} {"\u{2014}"} {checks[currentPrefix + sub.id + "_at"]}
                                                        </p>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* Photo capture */}
                                    {item.requirePhoto && !editMode && (
                                        <div className="px-3 pb-3 border-t border-gray-100 pt-2">
                                            {photoUrl ? (
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="text-xs text-green-600 font-bold">{"\u{2713}"} {language === "es" ? "Foto tomada" : "Photo taken"}</span>
                                                        <span className="text-xs text-gray-400">{checks[currentPrefix + item.id + "_photoTime"] ? new Date(checks[currentPrefix + item.id + "_photoTime"]).toLocaleTimeString() : ""}</span>
                                                    </div>
                                                    <img src={photoUrl} alt={language === 'es' ? 'Foto de tarea' : 'Task photo'} loading="lazy" decoding="async" className="rounded-lg border border-gray-200 max-w-full cursor-pointer" style={{ maxHeight: "150px" }}
                                                        onClick={() => {
                                                            openExternalUrl(photoUrl);
                                                        }} />
                                                </div>
                                            ) : (
                                                <div>
                                                    <input type="file" accept="image/*" capture="environment"
                                                        onChange={e => handlePhotoCapture(e, item.id)}
                                                        className="hidden" id={"photo-" + item.id} />
                                                    {/* FIX (2026-05-14): don't pre-set capturingPhoto on click — that
                                                        was racing the file picker and breaking the upload guard.
                                                        handlePhotoCapture sets it when an upload actually starts. */}
                                                    <button onClick={() => { document.getElementById("photo-" + item.id)?.click(); }}
                                                        disabled={capturingPhoto === item.id}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-xs font-bold text-blue-700 hover:bg-blue-100 transition">
                                                        {capturingPhoto === item.id
                                                            ? (language === "es" ? "\u{23F3} Subiendo..." : "\u{23F3} Uploading...")
                                                            : (language === "es" ? "\u{1F4F8} Tomar foto" : "\u{1F4F8} Take photo")}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {/* Follow-up question prompt {"\u{2014}"} shows when task is completed */}
                                    {item.followUp && item.followUp.question && (showFollowUpFor === item.id || (taskComplete && !checks[currentPrefix + item.id + "_followUp"])) && (
                                        <div className="mx-3 mb-3 p-3 bg-blue-50 border-2 border-blue-300 rounded-xl">
                                            <p className="text-sm font-bold text-blue-800 mb-2">{"\u{2753}"} {item.followUp.question}</p>
                                            {item.followUp.type === "dropdown" && item.followUp.options ? (
                                                <div className="space-y-1.5">
                                                    {item.followUp.options.map((opt, oi) => (
                                                        <button key={oi} onClick={() => saveFollowUpAnswer(item.id, opt)}
                                                            className="w-full text-left px-3 py-2 bg-white border border-blue-200 rounded-lg text-sm font-medium hover:bg-blue-100 hover:border-blue-400 transition">
                                                            {opt}
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="flex gap-2">
                                                    <input type="text" value={followUpAnswers[item.id] || ""}
                                                        onChange={e => setFollowUpAnswers(prev => ({...prev, [item.id]: e.target.value}))}
                                                        placeholder={language === "es" ? "Escribe tu respuesta..." : "Type your answer..."}
                                                        className="flex-1 px-3 py-2 border border-blue-200 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                                                        onKeyDown={e => { if (e.key === "Enter" && followUpAnswers[item.id]?.trim()) saveFollowUpAnswer(item.id, followUpAnswers[item.id].trim()); }} />
                                                    <button onClick={() => { if (followUpAnswers[item.id]?.trim()) saveFollowUpAnswer(item.id, followUpAnswers[item.id].trim()); }}
                                                        className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700">
                                                        {"\u{2713}"}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {/* Show saved answer */}
                                    {item.followUp && checks[currentPrefix + item.id + "_followUp"] && showFollowUpFor !== item.id && (
                                        <div className="mx-3 mb-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
                                            <p className="text-xs text-gray-500">{"\u{2753}"} {item.followUp.question}</p>
                                            <p className="text-sm font-bold text-gray-700">{"\u{1F4AC}"} {checks[currentPrefix + item.id + "_followUp"]}</p>
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        {editMode && !showAddForm && (
                            <button onClick={() => { setShowAddForm(true); setEditingIdx(null); }}
                                className="w-full mt-2 p-3 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 text-sm font-bold hover:border-mint-300 hover:text-mint-600 hover:bg-mint-50 transition flex items-center justify-center gap-2">
                                + {language === "es" ? "Agregar tarea" : "Add task"}
                            </button>
                        )}

                        {editMode && showAddForm && (
                            <div className="mt-2 p-3 rounded-lg border-2 border-green-300 bg-green-50">
                                <input type="text" value={newTask} onChange={e => setNewTask(e.target.value)}
                                    placeholder={language === "es" ? "Nueva tarea..." : "New task..."}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-2 focus:outline-none focus:border-green-400" autoFocus />
                                {/* Category picker */}
                                <div className="mb-2">
                                    <label className="text-xs font-bold text-gray-600 block mb-1">{language === "es" ? "Categoría" : "Category"}</label>
                                    <div className="flex flex-wrap gap-1">
                                        {TASK_CATEGORIES.map(c => (
                                            <button key={c.id} onClick={() => setNewCategory(c.id)}
                                                className={`px-2 py-1 rounded-full text-[11px] font-bold border transition ${newCategory === c.id ? c.color + " ring-2 ring-offset-1 ring-gray-700" : "bg-white text-gray-500 border-gray-300 hover:bg-gray-50"}`}>
                                                {c.emoji} {language === "es" ? c.labelEs : c.labelEn}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {/* Recurrence picker */}
                                <div className="mb-2">
                                    <label className="text-xs font-bold text-gray-600 block mb-1">🔁 {language === "es" ? "Recurrencia" : "Recurrence"}</label>
                                    <select value={newRecurrence} onChange={e => setNewRecurrence(e.target.value)}
                                        className="w-full border border-gray-200 rounded px-2 py-1 text-xs">
                                        {TASK_RECURRENCE.map(r => (
                                            <option key={r.id} value={r.id}>{language === "es" ? r.labelEs : r.labelEn}</option>
                                        ))}
                                    </select>
                                </div>
                                {/* Complete by time */}
                                <div className="flex items-center gap-2 mb-2">
                                    <label className="text-xs font-bold text-gray-600">{"\u{23F0}"} {language === "es" ? "Completar antes de:" : "Complete by:"}</label>
                                    <input type="time" value={newCompleteBy} onChange={e => setNewCompleteBy(e.target.value)}
                                        className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                    {newCompleteBy && <button onClick={() => setNewCompleteBy("")} className="text-red-400 text-xs">{"\u{2715}"}</button>}
                                </div>
                                {/* Assign to (always visible, multi-select) */}
                                <div className="flex items-center gap-2 mb-2">
                                    <label className="text-xs font-bold text-gray-600">{String.fromCodePoint(0x1F464)} {language === "es" ? "Asignar a:" : "Assign to:"}</label>
                                    <select value="" onChange={e => { if (e.target.value) { const cur = newAssignTo ? (Array.isArray(newAssignTo) ? newAssignTo : [newAssignTo]) : []; if (!cur.includes(e.target.value)) setNewAssignTo([...cur, e.target.value]); } }}
                                        className="border border-gray-200 rounded px-2 py-1 text-xs flex-1">
                                        <option value="">{language === "es" ? "\u{2014} Agregar persona \u{2014}" : "\u{2014} Add person \u{2014}"}</option>
                                        {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").filter(s => !(Array.isArray(newAssignTo) ? newAssignTo : newAssignTo ? [newAssignTo] : []).includes(s.name)).map(s => (
                                            <option key={s.id} value={s.name}>{s.name}</option>
                                        ))}
                                    </select>
                                </div>
                                {(Array.isArray(newAssignTo) ? newAssignTo : newAssignTo ? [newAssignTo] : []).length > 0 && (
                                    <div className="flex flex-wrap gap-1 mb-2">
                                        {(Array.isArray(newAssignTo) ? newAssignTo : [newAssignTo]).map(name => (
                                            <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-bold">
                                                {name.split(" ")[0]}
                                                <button onClick={() => { const cur = Array.isArray(newAssignTo) ? newAssignTo : [newAssignTo]; setNewAssignTo(cur.filter(n => n !== name)); }}
                                                    className="text-blue-400 hover:text-red-500">{String.fromCodePoint(0x2715)}</button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {/* Photo toggle */}
                                <label className="flex items-center gap-2 mb-2 text-xs cursor-pointer">
                                    <input type="checkbox" checked={newRequirePhoto} onChange={e => setNewRequirePhoto(e.target.checked)} className="w-4 h-4" />
                                    <span className="font-bold text-gray-600">{"\u{1F4F8}"} {language === "es" ? "Requiere foto" : "Require photo"}</span>
                                </label>
                                {/* Subtasks editor */}
                                <div className="mb-2">
                                    <p className="text-xs font-bold text-gray-500 mb-1">{language === "es" ? "Subtareas" : "Subtasks"}</p>
                                    {newSubtasks.map((sub, si) => (
                                        <div key={si} className="flex gap-1 mb-1">
                                            <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={sub.task}
                                                onChange={e => { const u = [...newSubtasks]; u[si] = {...u[si], task: e.target.value}; setNewSubtasks(u); }}
                                                placeholder={(language === "es" ? "Subtarea " : "Subtask ") + (si+1)} />
                                            <button onClick={() => setNewSubtasks(newSubtasks.filter((_,i) => i !== si))} className="text-red-400 text-xs px-1">{"\u{2715}"}</button>
                                        </div>
                                    ))}
                                    <button onClick={() => setNewSubtasks([...newSubtasks, {id: "", task: ""}])}
                                        className="text-xs text-mint-700 font-bold">+ {language === "es" ? "Agregar subtarea" : "Add subtask"}</button>
                                </div>
                                {/* Follow-up question editor */}
                                <div className="mb-2 border-t border-gray-200 pt-2">
                                    <div className="flex items-center justify-between mb-1">
                                        <p className="text-xs font-bold text-gray-500">{"\u{2753}"} {language === "es" ? "Pregunta al completar" : "Follow-up question"}</p>
                                        {!newFollowUp ? (
                                            <button onClick={() => setNewFollowUp({ type: "dropdown", question: "", options: [""] })}
                                                className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar" : "Add"}</button>
                                        ) : (
                                            <button onClick={() => setNewFollowUp(null)} className="text-red-400 text-xs">{"\u{2715}"} {language === "es" ? "Quitar" : "Remove"}</button>
                                        )}
                                    </div>
                                    {newFollowUp && (
                                        <div className="space-y-2 bg-blue-50 p-2 rounded border border-blue-200">
                                            <input type="text" value={newFollowUp.question} onChange={e => setNewFollowUp({...newFollowUp, question: e.target.value})}
                                                placeholder={language === "es" ? "Escribe la pregunta..." : "Type your question..."}
                                                className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:border-blue-400" />
                                            <div className="flex gap-2">
                                                <button onClick={() => setNewFollowUp({...newFollowUp, type: "dropdown", options: newFollowUp.options?.length ? newFollowUp.options : [""]})}
                                                    className={`flex-1 py-1 rounded text-xs font-bold ${newFollowUp.type === "dropdown" ? "bg-blue-600 text-white" : "bg-white text-gray-600 border"}`}>
                                                    {language === "es" ? "Opciones" : "Choices"}
                                                </button>
                                                <button onClick={() => setNewFollowUp({...newFollowUp, type: "text"})}
                                                    className={`flex-1 py-1 rounded text-xs font-bold ${newFollowUp.type === "text" ? "bg-blue-600 text-white" : "bg-white text-gray-600 border"}`}>
                                                    {language === "es" ? "Texto libre" : "Text input"}
                                                </button>
                                            </div>
                                            {newFollowUp.type === "dropdown" && (
                                                <div className="space-y-1">
                                                    {(newFollowUp.options || []).map((opt, oi) => (
                                                        <div key={oi} className="flex gap-1">
                                                            <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={opt}
                                                                onChange={e => { const u = [...newFollowUp.options]; u[oi] = e.target.value; setNewFollowUp({...newFollowUp, options: u}); }}
                                                                placeholder={(language === "es" ? "Opción " : "Option ") + (oi+1)} />
                                                            <button onClick={() => { const u = newFollowUp.options.filter((_,i) => i !== oi); setNewFollowUp({...newFollowUp, options: u}); }}
                                                                className="text-red-400 text-xs px-1">{"\u{2715}"}</button>
                                                        </div>
                                                    ))}
                                                    <button onClick={() => setNewFollowUp({...newFollowUp, options: [...(newFollowUp.options || []), ""]})}
                                                        className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar opción" : "Add option"}</button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <button onClick={addChecklistTask}
                                        className="px-3 py-1.5 bg-green-600 text-white text-xs font-bold rounded-lg">{language === "es" ? "Agregar" : "Add"}</button>
                                    <button onClick={() => { setShowAddForm(false); setNewTask(""); setNewRequirePhoto(false); setNewSubtasks([]); setNewCompleteBy(""); setNewAssignTo(""); setNewFollowUp(null); }}
                                        className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                </div>
                            </div>
                        )}

                        {/* Reset button {"\u{2014}"} admin only */}
                        {currentIsAdmin && (
                            <button onClick={resetAllChecklists}
                                className="w-full mt-4 py-3 rounded-xl font-bold text-sm bg-red-50 text-red-600 border-2 border-red-200 hover:bg-red-100 transition">
                                {language === "es" ? "\u{1F4BE} Guardar y Reiniciar Checklists" : "\u{1F4BE} Save & Reset Checklists"}
                            </button>
                        )}

                    </div>
                    {/* ─── Per-assignee columns next to master list ───
                        ADMIN ONLY. Andrew 2026-05-29: non-admin staff
                        see just the master (already filtered to their
                        own tasks); the right-side columns would be
                        redundant noise on their phone. */}
                    {currentIsAdmin && assigneeColumns.map(([name, list]) => {
                        const initials = name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
                        return (
                            <div key={name}
                                className="w-[82vw] sm:w-[260px] shrink-0 bg-white border border-dd-line rounded-xl p-3 flex flex-col">
                                <div className="flex items-center gap-2 mb-2 pb-2 border-b border-dd-line/60">
                                    <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-dd-sage-50 text-dd-green-700 font-bold text-xs shrink-0">
                                        {initials}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-bold text-dd-text truncate leading-tight">{name}</div>
                                        <div className="text-[10px] text-dd-text-2">
                                            {list.length} {language === 'es'
                                                ? (list.length === 1 ? 'tarea' : 'tareas')
                                                : (list.length === 1 ? 'task' : 'tasks')}
                                        </div>
                                    </div>
                                </div>
                                <div className="space-y-1.5 -mx-1 px-1">
                                    {list.map((t) => {
                                        // Per-assignee done state — `done`
                                        // means THIS column's staff checked
                                        // it. Other columns + master pull
                                        // their own slot. The column row
                                        // turns green only for assignees
                                        // who completed it.
                                        const done = isDoneForAssignee(t, name);
                                        const cat = getCategoryFor(t);
                                        const tAssignees = getAssignees(t);
                                        const hasSubs = t.subtasks && t.subtasks.length > 0;
                                        const subsTotal = hasSubs ? t.subtasks.length : 0;
                                        const subsDone = hasSubs ? t.subtasks.filter(s => checks[currentPrefix + s.id]).length : 0;
                                        const myDoneTime = checks[assigneeDoneKey(t.id, name)];
                                        const completedAt = myDoneTime;
                                        const photoUrl = checks[currentPrefix + t.id + "_photo"];
                                        const commentsKey = currentPrefix + t.id + "_comments";
                                        const tComments = Array.isArray(checks[commentsKey]) ? checks[commentsKey] : [];
                                        // Per-staff progress badge on the
                                        // assignee-chip strip so each col
                                        // shows how many other slots are
                                        // also done.
                                        const _prog = getAssigneeProgress(t);
                                        // Deadline urgency colors mirror master row.
                                        let tUrg = null;
                                        if (t.completeBy && !done) {
                                            const curMin = getBusinessMinutesNow();
                                            const [dh, dm] = t.completeBy.split(":").map(Number);
                                            const deadMin = dh * 60 + dm;
                                            if (curMin >= deadMin) tUrg = "overdue";
                                            else if (curMin >= deadMin - 30) tUrg = "warning";
                                        }
                                        return (
                                            <div key={t.id}
                                                className={`rounded-lg border-2 transition overflow-hidden ${
                                                    done ? 'border-green-300 bg-green-50'
                                                    : tUrg === 'overdue' ? 'task-flash-red'
                                                    : tUrg === 'warning' ? 'task-flash-yellow'
                                                    : 'border-gray-200 bg-white'
                                                }`}>
                                                <div className="flex items-start gap-2 p-2">
                                                    {!hasSubs && (
                                                        <input type="checkbox" checked={done}
                                                            onChange={() => togglePerAssigneeCheck(t.id, name, t)}
                                                            className="w-4 h-4 mt-0.5 text-mint-700 rounded focus:ring-2 focus:ring-mint-700 shrink-0" />
                                                    )}
                                                    <div className="flex-1 min-w-0">
                                                        {/* Title row with inline chips */}
                                                        <div className="flex items-center gap-1 flex-wrap">
                                                            <span className={`text-[12px] font-bold ${done ? 'line-through text-green-700' : 'text-gray-800'}`}>
                                                                {t.task}
                                                            </span>
                                                            {cat.id !== 'other' && (
                                                                <span className={`text-[9px] font-bold px-1 py-px rounded-full border ${cat.color}`}>
                                                                    {cat.emoji}
                                                                </span>
                                                            )}
                                                            {t.recurrence && t.recurrence !== 'daily' && (
                                                                <span className="text-[9px] font-bold px-1 py-px rounded-full bg-cyan-100 text-cyan-800 border border-cyan-300">
                                                                    🔁
                                                                </span>
                                                            )}
                                                            {t.requirePhoto && (
                                                                <span className={`text-[10px] ${photoUrl ? 'text-green-600' : 'text-gray-400'}`} title={photoUrl ? 'Photo on file' : 'Photo required'}>📸</span>
                                                            )}
                                                            {t.completeBy && (
                                                                <span className={`text-[9px] font-bold px-1 py-px rounded-full whitespace-nowrap ${
                                                                    done ? 'bg-green-100 text-green-600'
                                                                    : tUrg === 'overdue' ? 'bg-red-600 text-white'
                                                                    : tUrg === 'warning' ? 'bg-yellow-400 text-yellow-900'
                                                                    : 'bg-orange-100 text-orange-600'
                                                                }`}>
                                                                    ⏰{t.completeBy.replace(/^0/, '')}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {/* Subtask progress (column shows count, not the list itself) */}
                                                        {hasSubs && (
                                                            <p className="text-[10px] text-gray-500 mt-0.5">
                                                                ☑ {subsDone}/{subsTotal} {language === 'es' ? 'subtareas' : 'subtasks'}
                                                            </p>
                                                        )}
                                                        {/* Assignee chips */}
                                                        {tAssignees.length > 0 && (
                                                            <div className="flex flex-wrap gap-0.5 mt-1">
                                                                {tAssignees.map(n => (
                                                                    <span key={n} className={`inline-flex items-center px-1 py-px rounded-full text-[9px] font-bold ${n === name ? 'bg-dd-green text-white' : 'bg-blue-100 text-blue-700'}`}>
                                                                        👤 {n.split(' ')[0]}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        )}
                                                        {/* +Assign button — admin/manager only, opens the
                                                            same picker the master row uses. */}
                                                        {(currentIsAdmin || /manager/i.test(staffRole?.role || '')) && (
                                                            <button onClick={(e) => { e.stopPropagation(); const origIdx = allTasks.findIndex(x => x.id === t.id); if (origIdx >= 0) setAssigningTaskIdx(origIdx); }}
                                                                className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white border border-dd-line hover:bg-dd-bg text-[10px] font-bold text-dd-text-2">
                                                                👤 {tAssignees.length === 0
                                                                    ? `+ ${language === 'es' ? 'Asignar' : 'Assign'}`
                                                                    : (language === 'es' ? 'Editar' : 'Edit')}
                                                            </button>
                                                        )}
                                                        {/* Completed-by stamp — this column's staff,
                                                            their own timestamp. Other assignees show
                                                            in their own columns / chips. */}
                                                        {!hasSubs && done && (
                                                            <p className="text-[10px] text-green-600 mt-0.5">
                                                                ✓ {name} {completedAt && `— ${completedAt}`}
                                                            </p>
                                                        )}
                                                        {/* Overall progress mini-badge when there is
                                                            more than 1 assignee on the task — so each
                                                            assignee can glance and see "I am 1/2" */}
                                                        {tAssignees.length > 1 && (
                                                            <p className="text-[10px] text-dd-text-2 mt-0.5">
                                                                {_prog.done}/{_prog.total} {language === 'es' ? 'completos' : 'done'}
                                                            </p>
                                                        )}
                                                        {/* Photo capture — same handler as master row.
                                                            Andrew 2026-05-28: "you put the emoji of the
                                                            photo required but not the functional button
                                                            that says take photo." Each column gets its
                                                            own hidden <input> with a column-scoped id so
                                                            the picker still works when the master row
                                                            for this task is offscreen/filtered out. */}
                                                        {t.requirePhoto && (
                                                            <div className="mt-1.5">
                                                                {photoUrl ? (
                                                                    <a href={photoUrl} target="_blank" rel="noopener noreferrer"
                                                                        className="inline-block">
                                                                        <img src={photoUrl} alt={language === 'es' ? 'Foto de tarea' : 'Task photo'}
                                                                            loading="lazy" decoding="async"
                                                                            className="rounded border border-gray-200 max-h-20" />
                                                                    </a>
                                                                ) : (
                                                                    <>
                                                                        <input type="file" accept="image/*" capture="environment"
                                                                            onChange={e => handlePhotoCapture(e, t.id)}
                                                                            className="hidden" id={`photo-col-${name}-${t.id}`} />
                                                                        <button
                                                                            onClick={(e) => { e.stopPropagation(); document.getElementById(`photo-col-${name}-${t.id}`)?.click(); }}
                                                                            disabled={capturingPhoto === t.id}
                                                                            className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 rounded text-[10px] font-bold text-blue-700 hover:bg-blue-100">
                                                                            {capturingPhoto === t.id
                                                                                ? (language === 'es' ? '⏳ Subiendo' : '⏳ Uploading')
                                                                                : (language === 'es' ? '📸 Tomar foto' : '📸 Take photo')}
                                                                        </button>
                                                                    </>
                                                                )}
                                                            </div>
                                                        )}
                                                        {/* Notes count + add note (mirrors master) */}
                                                        {(() => {
                                                            const isOpen = openCommentTask === t.id;
                                                            return (
                                                                <div className="mt-1">
                                                                    <button onClick={(e) => { e.stopPropagation(); setOpenCommentTask(isOpen ? null : t.id); setCommentDraft(""); }}
                                                                        className={`text-[10px] font-bold underline ${tComments.length > 0 ? 'text-blue-700' : 'text-gray-500'}`}>
                                                                        💬 {tComments.length > 0
                                                                            ? `${tComments.length} ${language === 'es' ? 'nota(s)' : 'note(s)'}`
                                                                            : (language === 'es' ? 'Nota' : 'Note')}
                                                                    </button>
                                                                    {isOpen && (
                                                                        <div className="mt-1 bg-blue-50 border border-blue-200 rounded p-1.5 space-y-1">
                                                                            {tComments.map((c, ci) => (
                                                                                <div key={ci} className="flex items-start justify-between gap-1 bg-white rounded p-1 border border-blue-100">
                                                                                    <div className="text-[10px] flex-1 min-w-0">
                                                                                        <span className="font-bold text-blue-800">{c.by}</span>
                                                                                        <div className="text-gray-700">{c.text}</div>
                                                                                    </div>
                                                                                    <button onClick={() => removeTaskComment(t.id, ci)} className="text-red-400 text-xs">×</button>
                                                                                </div>
                                                                            ))}
                                                                            <div className="flex gap-1">
                                                                                <input type="text" value={commentDraft}
                                                                                    onChange={e => setCommentDraft(e.target.value)}
                                                                                    onKeyDown={e => { if (e.key === 'Enter' && commentDraft.trim()) { addTaskComment(t.id, commentDraft, t); setCommentDraft(""); } }}
                                                                                    placeholder={language === 'es' ? 'Anota...' : 'Note...'}
                                                                                    className="flex-1 px-1.5 py-0.5 border border-blue-200 rounded text-[10px]" />
                                                                                <button onClick={() => { if (commentDraft.trim()) { addTaskComment(t.id, commentDraft, t); setCommentDraft(""); } }}
                                                                                    disabled={!commentDraft.trim()}
                                                                                    className={`px-1.5 rounded text-[10px] font-bold ${commentDraft.trim() ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-400'}`}>
                                                                                    ✓
                                                                                </button>
                                                                            </div>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            );
                                                        })()}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                    </div>
                );
            };

            // ── Cart data memoization (Andrew 2026-05-29 perf batch D) ──
            //
            // The cart modal lives inside an IIFE deeper in the JSX
            // (`{showCart && (() => { ... })()}`). Before this memo,
            // every parent re-render — sauce updates, checklist ticks,
            // inventory snapshots, ANYTHING — re-ran 150 lines of
            // compute that walks every inventory item + every vendor
            // count + every vendor price source to derive cart rows,
            // sort them, build the vendor list, compute per-vendor
            // totals, and compute the best-mix totals. With 200+ cart
            // items × 8 vendors that's measurable work per render.
            //
            // The IIFE pattern blocks an in-place useMemo (hooks can't
            // live in IIFEs). So we hoist the pure-data derivation to
            // component scope here, gated on showCart so the work
            // skips entirely when the cart is closed. The IIFE just
            // reads the memoized fields.
            //
            // Closure-bound helpers (effectiveVendor, assignRow,
            // findVendorEntry, vendorColor) stay inside the IIFE —
            // they're cheap to construct and tie to setState callbacks
            // that change identity per render.
            const cartData = useMemo(() => {
                if (!showCart) return null;
                const findVendorEntry = (vendor, vendorId) => {
                    const src = vendor === "sysco"
                        ? (syscoPricingData?.sorted || [])
                        : (usfoodsPricingData?.sorted || []);
                    const found = src.find(([k]) => k === vendorId);
                    return found ? found[1] : null;
                };
                const rows = [];
                const itemLookup = new Map();
                for (const cat of INVENTORY_CATEGORIES) {
                    for (const item of (cat.items || [])) {
                        itemLookup.set(item.id, { item, categoryName: cat.name });
                    }
                }
                for (const cat of customInventory) {
                    for (const item of (cat.items || [])) {
                        itemLookup.set(item.id, { item, categoryName: cat.name });
                    }
                }
                Object.entries(inventory).forEach(([id, rawQty]) => {
                    const qty = Number(rawQty) || 0;
                    if (qty <= 0) return;
                    const lookup = itemLookup.get(id);
                    if (!lookup) return;
                    const { item, categoryName } = lookup;
                    rows.push({
                        kind: "master",
                        id: item.id,
                        name: language === "es" && item.nameEs ? item.nameEs : item.name,
                        altName: item.name,
                        category: categoryName,
                        qty,
                        vendorPrices: invToVendorPrices[item.id] || [],
                        preferredVendor: item.preferredVendor || item.vendor || "",
                        pack: item.pack,
                        addedFromVendor: item.addedFromVendor,
                    });
                });
                Object.entries(vendorCounts).forEach(([key, qty]) => {
                    if (qty <= 0) return;
                    const [vendor, vendorId] = key.split(":");
                    const data = findVendorEntry(vendor, vendorId);
                    if (!data) return;
                    const vendorName = vendor === "sysco" ? "Sysco" : "US Foods";
                    rows.push({
                        kind: "vendor-only",
                        id: key,
                        name: data.name || `${vendorName} #${vendorId}`,
                        category: data.category || "Other",
                        qty,
                        vendorPrices: [{
                            vendor: vendorName, vendorId,
                            price: data.price, pack: data.pack,
                            brand: data.brand, unit: data.unit,
                        }],
                        preferredVendor: vendorName,
                        pack: data.pack,
                        vendorOnlyOrigin: vendorName,
                    });
                });
                rows.sort((a, b) =>
                    (a.category || "").localeCompare(b.category || "") ||
                    (a.name || "").localeCompare(b.name || ""));
                const vendorSet = new Set();
                rows.forEach(r => r.vendorPrices.forEach(p => p.price != null && vendorSet.add(p.vendor)));
                const vendorList = Array.from(vendorSet).sort();
                const vendorTotals = {};
                vendorList.forEach(v => vendorTotals[v] = { lineTotal: 0, items: 0, missing: 0 });
                rows.forEach(r => {
                    vendorList.forEach(v => {
                        const p = r.vendorPrices.find(vp => vp.vendor === v);
                        if (p && p.price) {
                            vendorTotals[v].lineTotal += r.qty * p.price;
                            vendorTotals[v].items += 1;
                        } else {
                            vendorTotals[v].missing += 1;
                        }
                    });
                });
                let bestMixSum = 0;
                let uncovered = 0;
                const bestMixByVendor = {};
                vendorList.forEach(v => bestMixByVendor[v] = { lineTotal: 0, items: 0 });
                rows.forEach(r => {
                    const cheapest = r.vendorPrices.find(p => p.price != null);
                    if (cheapest) {
                        bestMixSum += r.qty * cheapest.price;
                        if (!bestMixByVendor[cheapest.vendor]) bestMixByVendor[cheapest.vendor] = { lineTotal: 0, items: 0 };
                        bestMixByVendor[cheapest.vendor].lineTotal += r.qty * cheapest.price;
                        bestMixByVendor[cheapest.vendor].items += 1;
                    } else {
                        uncovered += 1;
                    }
                });
                const totalItems = rows.length;
                const totalQty = rows.reduce((s, r) => s + r.qty, 0);
                return {
                    rows, vendorList, vendorTotals, bestMixSum, uncovered,
                    bestMixByVendor, totalItems, totalQty,
                };
            }, [
                showCart, inventory, vendorCounts, customInventory,
                syscoPricingData, usfoodsPricingData, invToVendorPrices,
                language,
            ]);

            return (
                <div className="p-4 pb-bottom-nav">
                    {/* Page header row — title on the left, compact labor
                        bubble on the right when viewable. Andrew 2026-05-23:
                        was a full-width labor card (2xl emoji + 3xl number +
                        progress bar + 25% target marker + last-updated time
                        stamp) taking up the entire row above the sub-tabs.
                        Trimmed to a small color-coded pill in the corner —
                        the threshold colors (green ≤22, amber ≤27, red >27)
                        carry the at-a-glance signal, the progress bar and
                        timestamp moved off-screen. A subtle "⏱" appears
                        next to the % when the data is >10 min stale so
                        managers don't trust an outdated number; tap the
                        bubble for the full breakdown (time + delta). */}
                    <div className="flex items-center justify-between gap-3 mb-4">
                        <h2 className="text-2xl font-black text-dd-text tracking-tight shrink-0">📋 {t("dailyOps", language)}</h2>
                        {canViewLabor((staffList || []).find(s => s.name === staffName)) && laborData && laborData.laborPercent !== undefined && (() => {
                            // 2026-05-26 — route through getLaborStatus() so a
                            // failed Toast scraper (laborCost: 0 with real
                            // netSales) shows a red "—" pill with the
                            // "Toast scraper offline" hint instead of a
                            // deceptive green "0.0%". Outage context in
                            // src/data/labor.js.
                            const laborStatus = getLaborStatus(laborData);
                            const pct = laborStatus.laborPercent;
                            const updatedAt = laborStatus.updatedAt;
                            const minutesAgo = laborStatus.minutesAgo;
                            const isStale = laborStatus.isStale;
                            const isBroken = laborStatus.isBroken;
                            const color = isBroken
                                ? { bg: "bg-red-50",     border: "border-red-300",     text: "text-red-700",     emoji: "\u{26A0}\u{FE0F}" }
                                : pct == null ? { bg: "bg-gray-50", border: "border-gray-300", text: "text-gray-500", emoji: "\u{1F4CA}" }
                                : pct <= 22 ? { bg: "bg-emerald-50", border: "border-emerald-300", text: "text-emerald-700", emoji: "\u{2705}" }
                                : pct <= 27 ? { bg: "bg-amber-50",   border: "border-amber-300",   text: "text-amber-700",   emoji: "\u{26A0}\u{FE0F}" }
                                :             { bg: "bg-red-50",     border: "border-red-300",     text: "text-red-700",     emoji: "\u{1F534}" };
                            const updatedLabel = updatedAt
                                ? updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                                : "--";
                            const agoLabel = minutesAgo === null ? ""
                                : minutesAgo === 0 ? (language === "es" ? "ahora" : "just now")
                                : `${minutesAgo} min`;
                            const titleHint = isBroken
                                ? getLaborStatusHint(laborStatus, language)
                                : `${t("laborPercent", language)} · ${updatedLabel}${agoLabel ? ` (${agoLabel})` : ""}`;
                            return (
                                <button
                                    type="button"
                                    onClick={() => setShowLaborDetails(s => !s)}
                                    title={titleHint}
                                    className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-sm font-black tabular-nums shadow-sm transition active:scale-95 ${color.bg} ${color.border} ${color.text}`}
                                >
                                    <span className="text-base leading-none">{color.emoji}</span>
                                    <span>{pct != null ? pct.toFixed(1) + "%" : "—"}</span>
                                    {isStale && !isBroken && <span className="text-[10px] opacity-70">⏱</span>}
                                </button>
                            );
                        })()}
                    </div>

                    {/* Expanded labor details — pops out under the header
                        when the bubble is tapped. Carries the original
                        information that used to live in the full-width card
                        (last updated time, minutes-ago, progress bar with
                        the 25% target marker) for managers who actually
                        want the breakdown, without forcing it on every
                        page load. Renders null when collapsed OR when the
                        viewer can't see labor at all. */}
                    {showLaborDetails && canViewLabor((staffList || []).find(s => s.name === staffName)) && laborData && laborData.laborPercent !== undefined && (() => {
                        const laborStatus = getLaborStatus(laborData);
                        const pct = laborStatus.laborPercent;
                        const updatedAt = laborStatus.updatedAt;
                        const minutesAgo = laborStatus.minutesAgo;
                        const isStale = laborStatus.isStale;
                        const isBroken = laborStatus.isBroken;
                        return (
                            <div className="bg-white border border-dd-line rounded-xl p-3 mb-4 shadow-sm">
                                <div className="flex items-baseline justify-between text-xs mb-2">
                                    <span className="font-semibold text-gray-500 uppercase tracking-wider">{t("laborPercent", language)}</span>
                                    <span className={(isStale || isBroken) ? "text-red-500 font-bold" : "text-gray-400"}>
                                        {(isStale || isBroken) ? "⚠️ " : ""}
                                        {updatedAt ? updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--"}
                                        {minutesAgo !== null && (
                                            <> · {minutesAgo === 0 ? (language === "es" ? "ahora" : "just now") : `${minutesAgo} min`}</>
                                        )}
                                    </span>
                                </div>
                                {/* When the scraper is broken (laborCost: 0 with real
                                    netSales), drop the progress bar — its 0%-width
                                    rendering looks like "great labor cost!" which is
                                    the opposite of what's happening. Show a copy
                                    line pointing at the actual fix instead. */}
                                {isBroken ? (
                                    <p className="text-[11px] text-red-600 font-semibold">
                                        {language === "es"
                                            ? "Toast no devolvió costo de mano de obra — revisa el scraper en Railway."
                                            : "Toast returned $0 labor cost — check the scraper on Railway."}
                                    </p>
                                ) : (
                                    <div className="relative">
                                        <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                                            <div className="h-full rounded-full transition-all duration-500"
                                                style={{
                                                    width: Math.min(pct / 37.5 * 100, 100) + "%",
                                                    backgroundColor: pct <= 22 ? "#10b981" : pct <= 27 ? "#f59e0b" : "#ef4444"
                                                }} />
                                        </div>
                                        <div className="absolute top-0 h-2 border-r-2 border-gray-600" style={{ left: (25 / 37.5 * 100) + "%" }}>
                                            <div className="absolute -top-4 -translate-x-1/2 text-[9px] font-bold text-gray-500">25%</div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    {/* Operations sub-tabs — underline style.
                        Andrew 2026-05-23: was a single filled-pill bar that
                        overflowed horizontally on phones ("one large line").
                        Replaced with the Linear / Notion / GitHub pattern —
                        text labels with a 2px dd-green underline on the
                        active tab, a single hairline below the whole row
                        as a separator. Reads as distinct sections, doesn't
                        compete with page content the way filled pills do.
                        Mechanics:
                          • parent has `border-b border-dd-line` for the
                            separator hairline.
                          • inner flex row has `-mb-px` so each button's
                            border-b-2 overlaps the parent border exactly,
                            making the active tab's green line "replace"
                            the gray separator at its column.
                          • buttons are `shrink-0` + `whitespace-nowrap` so
                            on a phone the row scrolls horizontally cleanly
                            instead of trying to squeeze 7 labels into 380px.
                            The scrollbar-thin pattern matches every other
                            horizontally-scrollable strip in the app
                            (ChatCenter sub-tabs, Schedule day strip). */}
                    {/* 2026-06-08 — Operations sub-nav. Andrew: on a phone the
                        7 tabs overflowed into a sideways scroll (had to swipe
                        right to reach Inventory/Prep). MOBILE now shows a 2-row
                        Apple-glass button grid (no horizontal scroll); DESKTOP
                        keeps the original underline tab strip, unchanged. One
                        shared tab list feeds both so they never drift. */}
                    {(() => {
                        const opsTabs = [
                            { id: 'checklist', en: 'Tasks',     es: 'Tareas',     icon: '✓' },
                            // Mgr Tasks sub-tab removed 2026-05-28 — the
                            // manager/shift-lead kanban now renders INSIDE the
                            // Tasks tab body (see renderChecklist).
                            { id: 'assign',    en: 'Assign',    es: 'Asignar',    icon: '🎯' },
                            { id: 'wall',      en: 'Wall',      es: 'Muro',       icon: '📺' },
                            { id: 'saucelog',  en: 'Sauce Log', es: 'Salsas',     icon: '🥢' },
                            { id: 'inventory', en: t('inventory', 'en'), es: t('inventory', 'es'), icon: '📦' },
                            { id: 'breaks',    en: 'Breaks',    es: 'Descansos',  icon: '☕' },
                            { id: 'prep',      en: 'Prep',      es: 'Prep',       icon: '🔪' },
                        ];
                        // Identical behavior to before — switch tab + reset the
                        // edit/add affordances so a half-open form doesn't bleed
                        // across tabs.
                        const pick = (id) => { setActiveTab(id); setEditMode(false); setEditingIdx?.(null); setShowAddForm?.(false); };
                        return (
                            <>
                                {/* MOBILE + TABLET (<lg) — Apple-glass button grid, no sideways scroll.
                                    Bumped sm:→lg: at ~640–750px the 7-tab desktop strip overflowed into a
                                    horizontal scroll (Andrew: "subs still in a scrolling line"), so the
                                    no-scroll grid now covers phones AND tablets. grid-cols-4 on phones
                                    (2 rows), md:grid-cols-7 makes it a single clean row once there's room. */}
                                <div className="lg:hidden grid grid-cols-4 md:grid-cols-7 gap-1.5 mb-4">
                                    {opsTabs.map(t2 => {
                                        const isActive = activeTab === t2.id;
                                        return (
                                            <button key={t2.id} type="button"
                                                aria-pressed={isActive}
                                                onClick={() => pick(t2.id)}
                                                className={`glass-button-apple !flex-col !gap-0.5 !px-1 !py-2 !text-[11px] rounded-2xl min-h-[3.4rem] font-bold text-center leading-tight ${
                                                    isActive ? '!text-dd-green ring-2 ring-dd-green/70' : '!text-dd-text-2'
                                                }`}>
                                                <span className="text-lg leading-none">{t2.icon}</span>
                                                <span className="break-words">{language === "es" ? t2.es : t2.en}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                                {/* DESKTOP (≥lg) — original underline tab strip; at ≥1024px all 7 tabs
                                    fit without scrolling, so the strip is safe here. */}
                                <div className="hidden lg:block border-b border-dd-line mb-4">
                                    <div className="flex overflow-x-auto scrollbar-thin -mb-px">
                                        {opsTabs.map(t2 => {
                                            const isActive = activeTab === t2.id;
                                            return (
                                                <button key={t2.id}
                                                    onClick={() => pick(t2.id)}
                                                    className={`shrink-0 px-3 sm:px-4 py-2.5 text-sm font-bold whitespace-nowrap transition border-b-2 flex items-center gap-1.5 ${
                                                        isActive
                                                            ? 'text-dd-green border-dd-green'
                                                            : 'text-dd-text-2 border-transparent hover:text-dd-text hover:border-dd-line'
                                                    }`}>
                                                    <span className="opacity-90">{t2.icon}</span>
                                                    <span>{language === "es" ? t2.es : t2.en}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        );
                    })()}

                    {/* {"\u{2500}"}{"\u{2500}"} TASK DEADLINE ALERTS {"\u{2500}"}{"\u{2500}"} */}
                    {activeAlerts.length > 0 && (
                        <div className="space-y-2 mb-3">
                            {activeAlerts.map(a => (
                                <div key={a.key} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 shadow-sm animate-pulse ${
                                    a.type === "overdue" ? "bg-red-50 border-red-300" : "bg-yellow-50 border-yellow-300"
                                }`}>
                                    <span className="text-xl">{a.type === "overdue" ? "\u{1F6A8}" : "\u{23F0}"}</span>
                                    <div className="flex-1 min-w-0">
                                        <p className={`text-sm font-bold ${a.type === "overdue" ? "text-red-700" : "text-yellow-800"}`}>
                                            {a.taskName}
                                        </p>
                                        <p className={`text-xs ${a.type === "overdue" ? "text-red-500" : "text-yellow-600"}`}>
                                            {a.type === "overdue"
                                                ? (language === "es" ? `Venció a las ${a.timeStr} \u{2014} ${a.message}` : `Due at ${a.timeStr} \u{2014} ${a.message}`)
                                                : (language === "es" ? `Vence a las ${a.timeStr} \u{2014} ${a.message}` : `Due at ${a.timeStr} \u{2014} ${a.message}`)
                                            }
                                        </p>
                                    </div>
                                    <button onClick={() => dismissAlert(a.key)}
                                        className={`text-xs font-bold px-2 py-1 rounded-lg ${a.type === "overdue" ? "bg-red-200 text-red-700" : "bg-yellow-200 text-yellow-700"}`}>
                                        {"\u{2715}"}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Tasks tab — Andrew 2026-05-28 round 3: "lets
                        take the roll check out its not working / the
                        whole list is gone." The manager-vs-staff
                        branching was hiding his existing checklist
                        (the kanbans master list is a different
                        Firestore collection, so for managers it came
                        up empty). Reverted to a single render path:
                        everyone sees the existing checklist here, the
                        manager kanban stays in the dedicated Assign
                        sub-tab. */}
                    {activeTab === "checklist" && renderChecklist()}

                    {activeTab === "assign" && (
                        <Suspense fallback={<div className="text-center py-10 text-dd-text-2 text-sm">Loading…</div>}>
                            <AssignTasksPanel
                                language={language}
                                staffName={staffName}
                                staffList={staffList}
                                isAdmin={currentIsAdmin}
                            />
                        </Suspense>
                    )}

                    {activeTab === "wall" && (
                        <Suspense fallback={<div className="text-center py-10 text-dd-text-2 text-sm">Loading…</div>}>
                            <WallTasksAdmin
                                language={language}
                                staffName={staffName}
                                staffList={staffList}
                                storeLocation={storeLocation}
                                isAdmin={currentIsAdmin}
                            />
                        </Suspense>
                    )}

                    {activeTab === "saucelog" && (
                        <Suspense fallback={<div className="h-32 bg-white rounded-xl border border-dd-line animate-pulse" />}>
                            <SauceLog
                                language={language}
                                staffName={staffName}
                                staffList={staffList}
                                storeLocation={storeLocation}
                            />
                        </Suspense>
                    )}

                    {/* ── Merge Items Modal — pick a target master item to merge the source into ── */}
                    {mergeSource && (() => {
                        const src = mergeSource.item;
                        const sourceCount = inventory[src.id] || 0;
                        // Count vendor matches that point at the source — surfaces the impact of the merge.
                        let pointingMatchCount = 0;
                        for (const v of Object.keys(vendorMatches || {})) {
                            for (const invId of Object.values(vendorMatches[v] || {})) {
                                if (invId === src.id) pointingMatchCount += 1;
                            }
                        }
                        const queryLower = (mergeSearchQuery || "").toLowerCase().trim();
                        const candidates = [];
                        customInventory.forEach((cat, cIdx) => {
                            const items = cat.items.filter(it => {
                                if (it.id === src.id) return false; // can't merge into self
                                if (!queryLower) return true;
                                const hay = (it.name || "") + " " + (it.nameEs || "") + " " + (it.id || "");
                                return hay.toLowerCase().includes(queryLower);
                            });
                            if (items.length > 0) {
                                candidates.push({ cIdx, catName: cat.name, catNameEs: cat.nameEs, items });
                            }
                        });
                        const closeMerge = () => {
                            setMergeSource(null);
                            setMergeSearchQuery("");
                            setMergeError(null);
                            setMergeSaving(false);
                        };
                        const handleMergeClick = async (targetCatIdx, targetItem) => {
                            const targetItemIdx = customInventory[targetCatIdx].items.findIndex(it => it.id === targetItem.id);
                            // Compute the full set of vendor data that will follow the source
                            // into the target — vendor_matches (Sysco/USFoods SKU links),
                            // vendorOptions entries the target doesn't already have, and any
                            // scalar vendor fields the target is missing. The plain count
                            // from pointingMatchCount alone undersells the impact.
                            const tOpts = Array.isArray(targetItem.vendorOptions) ? targetItem.vendorOptions : [];
                            const sOpts = Array.isArray(src.vendorOptions) ? src.vendorOptions : [];
                            const tVendors = new Set(tOpts.map(o => o && o.vendor).filter(Boolean));
                            const newVendorOpts = sOpts.filter(o => o && o.vendor && !tVendors.has(o.vendor)).map(o => o.vendor);
                            const inheritFields = [];
                            for (const k of ["preferredVendor", "vendor", "supplier"]) {
                                if ((!targetItem[k] || targetItem[k] === "") && src[k]) inheritFields.push(`${k}=${src[k]}`);
                            }
                            const lines = [
                                language === "es"
                                    ? `Fusionar "${src.name}" EN "${targetItem.name}"?`
                                    : `Merge "${src.name}" INTO "${targetItem.name}"?`,
                                "",
                                language === "es" ? "El destino heredará:" : "Target will inherit:",
                                pointingMatchCount > 0
                                    ? `  • ${pointingMatchCount} Sysco/US Foods ${language === "es" ? "coincidencia(s) SKU redirigida(s)" : "SKU match(es) redirected"}`
                                    : `  • ${language === "es" ? "0 coincidencias SKU directas a redirigir" : "0 direct SKU matches to redirect"}`,
                                newVendorOpts.length > 0
                                    ? `  • ${newVendorOpts.length} ${language === "es" ? "nueva(s) opción(es) de proveedor" : "new vendor option(s)"}: ${newVendorOpts.join(", ")}`
                                    : `  • ${language === "es" ? "Sin opciones de proveedor nuevas" : "No new vendor options"}`,
                                sourceCount > 0
                                    ? `  • ${language === "es" ? "Conteo combinado" : "Combined count"}: ${sourceCount} + ${(inventory[targetItem.id] || 0)}`
                                    : `  • ${language === "es" ? "Sin conteo de origen" : "No source count to combine"}`,
                                inheritFields.length > 0 ? `  • ${language === "es" ? "Campos heredados" : "Inherited fields"}: ${inheritFields.join(", ")}` : null,
                                "",
                                language === "es"
                                    ? `Luego "${src.name}" se eliminará. No se puede deshacer.`
                                    : `Then "${src.name}" will be deleted. Cannot be undone.`,
                            ].filter(Boolean);
                            const ok = window.confirm(lines.join("\n"));
                            if (!ok) return;
                            await mergeMasterItems(mergeSource.catIdx, mergeSource.itemIdx, targetCatIdx, targetItemIdx);
                        };
                        return (
                            <ModalPortal>
                            <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-2">
                                <div className="bg-white rounded-2xl w-full sm:max-w-lg max-h-[90vh] flex flex-col overflow-hidden shadow-2xl border-2 border-purple-300">
                                    <div className="px-4 py-3 bg-purple-700 text-white flex items-start justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs opacity-80 uppercase tracking-wide">{language === "es" ? "Fusionar artículo" : "Merge item"}</div>
                                            <div className="font-bold text-sm truncate">↔️ {src.name}</div>
                                            <div className="text-xs opacity-80 mt-0.5">
                                                {language === "es" ? "Fuente:" : "Source:"} #{src.id}
                                                {sourceCount > 0 && ` · ${language === "es" ? "Conteo" : "count"}: ${sourceCount}`}
                                                {pointingMatchCount > 0 && ` · ${pointingMatchCount} ${language === "es" ? "coincidencia(s)" : "match(es)"}`}
                                            </div>
                                        </div>
                                        <button onClick={closeMerge} className="text-white/80 hover:text-white text-xl leading-none px-1">✕</button>
                                    </div>
                                    <div className="p-3 border-b border-gray-200">
                                        <input type="text" autoFocus value={mergeSearchQuery} onChange={e => setMergeSearchQuery(e.target.value)}
                                            placeholder={language === "es" ? "🔍 Buscar artículo destino..." : "🔍 Search target item..."}
                                            className="w-full px-3 py-2 border-2 border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-700" />
                                        <p className="text-[11px] text-gray-500 mt-1">
                                            {language === "es"
                                                ? `Toca un artículo para fusionar "${src.name}" EN él. La fuente se eliminará.`
                                                : `Tap an item to merge "${src.name}" INTO it. The source will be deleted.`}
                                        </p>
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                        {candidates.length === 0 ? (
                                            <p className="text-center text-gray-400 text-sm py-6">{language === "es" ? "No se encontraron artículos" : "No items found"}</p>
                                        ) : candidates.map(group => (
                                            <div key={group.cIdx}>
                                                <div className="text-[10px] font-bold uppercase text-gray-500 px-2 py-1 bg-gray-50 sticky top-0">{language === "es" ? group.catNameEs : group.catName}</div>
                                                {group.items.map(it => {
                                                    const tCount = inventory[it.id] || 0;
                                                    return (
                                                        <button key={it.id}
                                                            disabled={mergeSaving}
                                                            onClick={() => handleMergeClick(group.cIdx, it)}
                                                            className={`w-full text-left px-3 py-2 rounded-lg border mt-1 transition ${mergeSaving ? "opacity-50 cursor-wait" : "bg-white border-gray-200 hover:bg-purple-50 hover:border-purple-300"}`}>
                                                            <div className="text-sm font-medium text-gray-800">{language === "es" && it.nameEs ? it.nameEs : it.name}</div>
                                                            <div className="text-[11px] text-gray-500">
                                                                #{it.id}
                                                                {tCount > 0 && ` · ${language === "es" ? "Conteo" : "count"} ${tCount} → ${tCount + sourceCount}`}
                                                            </div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        ))}
                                    </div>
                                    {mergeError && (
                                        <div className="px-3 py-2 bg-red-100 border-t border-red-300 text-red-700 text-xs">
                                            ⚠️ {mergeError}
                                        </div>
                                    )}
                                    <div className="p-3 border-t border-gray-200 bg-gray-50">
                                        <button onClick={closeMerge} disabled={mergeSaving}
                                            className="w-full py-2 rounded-lg bg-mint-700 text-white text-xs font-bold hover:bg-mint-800 disabled:opacity-50">
                                            {language === "es" ? "Cancelar" : "Cancel"}
                                        </button>
                                    </div>
                                </div>
                            </div>
                            </ModalPortal>
                        );
                    })()}

                    {/* Global save-error toast — shows even after the match modal closes,
                        so silent Firestore-rule denials surface to the user. */}
                    {matchSaveError && (
                        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] max-w-md w-[95vw] rounded-xl border-2 border-red-400 bg-red-50 shadow-xl p-3 text-xs text-red-800 flex items-start gap-2">
                            <span className="text-base">⚠️</span>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold mb-0.5">{language === "es" ? "Error al guardar coincidencia" : "Match save failed"}</div>
                                <div className="break-words">{matchSaveError}</div>
                            </div>
                            <button onClick={() => setMatchSaveError(null)} className="text-red-600 hover:text-red-800 text-lg leading-none">✕</button>
                        </div>
                    )}

                    {/* ── Match Editor Modal (admin-only, shared across all vendors) ── */}
                    {matchEditor && (() => {
                        const { vendor, vendorId, vendorName, currentInvId } = matchEditor;
                        const queryLower = (matchSearchQuery || "").toLowerCase().trim();
                        // Build a flat list of inventory items grouped by category, filtered by search.
                        const candidates = [];
                        customInventory.forEach((cat, cIdx) => {
                            const matchedItems = cat.items.filter(it => {
                                if (!queryLower) return true;
                                const hay = (it.name || "") + " " + (it.nameEs || "") + " " + (it.id || "");
                                return hay.toLowerCase().includes(queryLower);
                            });
                            if (matchedItems.length > 0) {
                                candidates.push({ catName: cat.name, catNameEs: cat.nameEs, catIdx: cIdx, items: matchedItems });
                            }
                        });
                        const closeEditor = () => {
                            setMatchEditor(null);
                            setMatchSearchQuery("");
                            setAddingToMaster(false);
                            setNewMasterName("");
                            setNewMasterNameEs("");
                            setNewMasterCatIdx(0);
                            setNewMasterSaving(false);
                        };
                        // Default the new-item name to a Title-Cased clean version of the vendor name
                        // (vendor names often arrive in ALL CAPS from the scraper). User can edit.
                        const cleanVendorName = (raw) => {
                            if (!raw) return "";
                            return raw.replace(/\s+/g, " ").trim()
                                .toLowerCase()
                                .replace(/\b\w/g, c => c.toUpperCase());
                        };
                        const handleCreateMasterItem = async () => {
                            const trimmed = (newMasterName || "").trim();
                            if (!trimmed) return;
                            setNewMasterSaving(true);
                            try {
                                // Was: build `updated` from local customInventory + legacy
                                // saveInventory() (a full-doc setDoc). That CLOBBERED the whole
                                // list from a possibly-stale local copy — so a second add could
                                // erase the item added just before it. Now goes through the
                                // transactional mutateInventory (reads the live doc, appends),
                                // locating the category by NAME so it's immune to saved-vs-merged
                                // ordering. newId is computed inside the txn against the live cat.
                                const targetName = customInventory[newMasterCatIdx]?.name;
                                let newId = null;
                                const result = await mutateInventory((live) => {
                                    let idx = live.findIndex(c => c && c.name === targetName);
                                    let working = live;
                                    if (idx === -1) { working = [...live, { name: targetName, items: [] }]; idx = working.length - 1; }
                                    const liveCat = working[idx];
                                    newId = nextItemId(liveCat, idx);
                                    const newItem = {
                                        id: newId,
                                        name: trimmed,
                                        nameEs: (newMasterNameEs || "").trim(),
                                        vendor: vendor === "sysco" ? "Sysco" : "US Foods",
                                        supplier: vendor === "sysco" ? "Sysco" : "US Foods",
                                        preferredVendor: vendor === "sysco" ? "Sysco" : "US Foods",
                                        orderDay: "",
                                        pack: "",
                                        price: null,
                                        subcat: "",
                                        addedFromVendor: vendor === "sysco" ? "Sysco" : "US Foods",
                                    };
                                    return working.map((c, i) => i === idx ? { ...c, items: [...c.items, newItem] } : c);
                                });
                                if (!result || !newId) throw new Error("inventory save failed");
                                await saveVendorMatch(vendor, vendorId, newId);
                                closeEditor();
                            } catch (e) {
                                console.error("Create master item error:", e);
                                setMatchSaveError(e.message || String(e));
                                setNewMasterSaving(false);
                            }
                        };
                        return (
                            <ModalPortal>
                            <div className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-2">
                                <div className="bg-white rounded-2xl w-full sm:max-w-lg max-h-[90vh] flex flex-col overflow-hidden shadow-2xl border-2 border-purple-300">
                                    {/* Header */}
                                    <div className="px-4 py-3 bg-purple-700 text-white flex items-start justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                            <div className="text-xs opacity-80 uppercase tracking-wide">{vendor === "sysco" ? "Sysco" : "US Foods"} #{vendorId}</div>
                                            <div className="font-bold text-sm truncate">{vendorName || `Item ${vendorId}`}</div>
                                            {currentInvId && (
                                                <div className="text-xs opacity-90 mt-0.5">{language === "es" ? "Coincidencia actual:" : "Current match:"} {invLookup[currentInvId]?.name || `(${currentInvId})`}</div>
                                            )}
                                        </div>
                                        <button onClick={closeEditor} className="text-white/80 hover:text-white text-xl leading-none px-1">✕</button>
                                    </div>
                                    {/* Search */}
                                    <div className="p-3 border-b border-gray-200">
                                        <input type="text" autoFocus value={matchSearchQuery} onChange={e => setMatchSearchQuery(e.target.value)}
                                            placeholder={language === "es" ? "🔍 Buscar artículo de inventario..." : "🔍 Search inventory item..."}
                                            className="w-full px-3 py-2 border-2 border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-700" />
                                    </div>
                                    {/* Inventory list */}
                                    <div className="flex-1 overflow-y-auto p-2 space-y-2">
                                        {candidates.length === 0 ? (
                                            <p className="text-center text-gray-400 text-sm py-6">{language === "es" ? "No se encontraron artículos" : "No items found"}</p>
                                        ) : candidates.map(group => (
                                            <div key={group.catIdx}>
                                                <div className="text-[10px] font-bold uppercase text-gray-500 px-2 py-1 bg-gray-50 sticky top-0">{language === "es" ? group.catNameEs : group.catName}</div>
                                                {group.items.map(it => (
                                                    <button key={it.id}
                                                        onClick={async () => { const ok = await saveVendorMatch(vendor, vendorId, it.id); if (ok) closeEditor(); }}
                                                        className={`w-full text-left px-3 py-2 rounded-lg border mt-1 transition ${currentInvId === it.id ? "bg-green-50 border-green-300" : "bg-white border-gray-200 hover:bg-purple-50 hover:border-purple-300"}`}>
                                                        <div className="text-sm font-medium text-gray-800">{language === "es" && it.nameEs ? it.nameEs : it.name}</div>
                                                        <div className="text-[11px] text-gray-500">#{it.id}{it.vendor || it.supplier ? ` • ${it.vendor || it.supplier}` : ""}</div>
                                                    </button>
                                                ))}
                                            </div>
                                        ))}
                                    </div>
                                    {/* ── Add as new master item ── */}
                                    {!addingToMaster ? (
                                        <div className="px-3 py-2 border-t border-gray-200 bg-gray-50">
                                            <button onClick={() => {
                                                setAddingToMaster(true);
                                                setNewMasterName(cleanVendorName(vendorName));
                                                setNewMasterNameEs("");
                                                setNewMasterCatIdx(0);
                                            }}
                                                className="w-full py-2 rounded-lg bg-blue-50 border-2 border-dashed border-blue-300 text-blue-700 text-xs font-bold hover:bg-blue-100">
                                                + {language === "es" ? "Agregar como nuevo artículo maestro" : "Add as new master item"}
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="px-3 py-3 border-t-2 border-blue-300 bg-blue-50 space-y-2">
                                            <div className="text-xs font-bold text-blue-800">
                                                {language === "es" ? "Nuevo artículo maestro" : "New master item"}
                                            </div>
                                            <input type="text" value={newMasterName}
                                                onChange={e => setNewMasterName(e.target.value)}
                                                placeholder={language === "es" ? "Nombre (en inglés)" : "Name (English)"}
                                                className="w-full px-3 py-2 border-2 border-blue-200 rounded-lg text-sm focus:outline-none focus:border-blue-500" />
                                            <input type="text" value={newMasterNameEs}
                                                onChange={e => setNewMasterNameEs(e.target.value)}
                                                placeholder={language === "es" ? "Nombre en español (opcional)" : "Spanish name (optional)"}
                                                className="w-full px-3 py-2 border-2 border-blue-200 rounded-lg text-sm focus:outline-none focus:border-blue-500" />
                                            <select value={newMasterCatIdx}
                                                onChange={e => setNewMasterCatIdx(parseInt(e.target.value))}
                                                className="w-full px-3 py-2 border-2 border-blue-200 rounded-lg text-sm focus:outline-none focus:border-blue-500 bg-white">
                                                {customInventory.map((c, i) => (
                                                    <option key={i} value={i}>{language === "es" ? c.nameEs : c.name}</option>
                                                ))}
                                            </select>
                                            <div className="text-[10px] text-blue-700 italic">
                                                {language === "es"
                                                    ? `Se vinculará automáticamente con ${vendor === "sysco" ? "Sysco" : "US Foods"} #${vendorId}.`
                                                    : `Will auto-link to ${vendor === "sysco" ? "Sysco" : "US Foods"} #${vendorId}.`}
                                            </div>
                                            <div className="flex gap-2">
                                                <button onClick={handleCreateMasterItem}
                                                    disabled={!newMasterName.trim() || newMasterSaving}
                                                    className={`flex-1 py-2 rounded-lg text-xs font-bold text-white transition ${!newMasterName.trim() || newMasterSaving ? "bg-gray-300 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700"}`}>
                                                    {newMasterSaving ? "…" : (language === "es" ? "Crear y vincular" : "Create + link")}
                                                </button>
                                                <button onClick={() => setAddingToMaster(false)}
                                                    className="flex-1 py-2 rounded-lg text-xs font-bold bg-white border border-gray-300 text-gray-700 hover:bg-gray-100">
                                                    {language === "es" ? "Cancelar" : "Cancel"}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                    {/* Save error (Firestore permission issues, network, etc. — visible feedback so we can debug) */}
                                    {matchSaveError && (
                                        <div className="px-3 py-2 bg-red-100 border-t border-red-300 text-red-700 text-xs">
                                            ⚠️ {language === "es" ? "Error al guardar:" : "Save error:"} {matchSaveError}
                                        </div>
                                    )}
                                    {/* Footer actions */}
                                    <div className="p-3 border-t border-gray-200 flex flex-wrap gap-2 bg-gray-50">
                                        <button onClick={async () => { const ok = await clearVendorMatch(vendor, vendorId); if (ok) closeEditor(); }}
                                            className="flex-1 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-xs font-bold hover:bg-gray-100">
                                            {language === "es" ? "🔄 Borrar (auto)" : "🔄 Clear (auto-match)"}
                                        </button>
                                        <button onClick={async () => { const ok = await lockVendorUnmatched(vendor, vendorId); if (ok) closeEditor(); }}
                                            className="flex-1 py-2 rounded-lg bg-gray-700 text-white text-xs font-bold hover:bg-gray-800">
                                            {language === "es" ? "🔒 Bloquear sin coincidencia" : "🔒 Lock unmatched"}
                                        </button>
                                        <button onClick={closeEditor}
                                            className="flex-1 py-2 rounded-lg bg-mint-700 text-white text-xs font-bold hover:bg-mint-800">
                                            {language === "es" ? "Cerrar" : "Close"}
                                        </button>
                                    </div>
                                </div>
                            </div>
                            </ModalPortal>
                        );
                    })()}

                    {/* Vendor CSV importer — admin uploads a Sysco /
                        US Foods order-guide CSV; parser matches rows
                        against the master inventory and writes a fresh
                        inventoryHistory snapshot for the order date so
                        every matched item's "Last ordered" badge updates
                        downstream. Also persists newly-resolved SKU
                        mappings to /config/vendor_matches so the next
                        import auto-matches them. */}
                    {showCsvImport && (
                        <Suspense fallback={null}>
                            <VendorCsvImportModal
                                language={language}
                                storeLocation={storeLocation}
                                customInventory={customInventory}
                                vendorMatches={vendorMatches}
                                staffName={staffName}
                                viewer={(staffList || []).find(s => s.name === staffName)}
                                onClose={() => setShowCsvImport(false)}
                                onImported={() => {
                                    reloadLastEnteredByItem().catch(() => {});
                                }}
                            />
                        </Suspense>
                    )}

                    {/* 2026-05-24 — Per-task assignee picker bottom sheet.
                        Mounted-on-demand: only rendered when an admin/
                        manager has tapped the 👤 button on a task card.
                        eligibleStaff is filtered to (a) the current
                        location AND (b) the current checklist side via
                        resolveStaffSide, so a FOH cook never appears in
                        a BOH closing-task picker. */}
                    {assigningTaskIdx !== null && (() => {
                        const currentTasks = (customTasksRef.current[checklistSide] && customTasksRef.current[checklistSide][PERIOD_KEY]) || [];
                        const task = currentTasks[assigningTaskIdx] || null;
                        if (!task) return null;
                        const sideLower = (checklistSide || 'FOH').toLowerCase();   // 'foh' | 'boh'
                        const eligibleStaff = (staffList || [])
                            .filter(s => s && s.name)
                            .filter(s => s.active !== false)
                            .filter(s => s.location === storeLocation || s.location === 'both' || storeLocation === 'both')
                            .filter(s => {
                                const explicit = String(s.scheduleSide || '').toLowerCase();
                                if (explicit === 'foh' || explicit === 'boh') return explicit === sideLower;
                                if (explicit === 'both') return true;
                                // Role-based fallback for legacy records
                                const isFohByRole = ["FOH", "Manager", "Owner", "Shift Lead"].includes(s.role);
                                return isFohByRole ? sideLower === 'foh' : sideLower === 'boh';
                            });
                        const currentAssignees = Array.isArray(task.assignTo)
                            ? task.assignTo
                            : (task.assignTo ? [task.assignTo] : []);
                        const taskTitle = (task.task || '').split('\n')[0];
                        return (
                            <Suspense fallback={null}>
                                <AssigneePickerModal
                                    open={true}
                                    onClose={() => setAssigningTaskIdx(null)}
                                    onSave={async (names) => {
                                        await setTaskAssignees(assigningTaskIdx, names);
                                    }}
                                    taskTitle={taskTitle}
                                    eligibleStaff={eligibleStaff}
                                    assignedNames={currentAssignees}
                                    currentStaffName={staffName}
                                    language={language}
                                />
                            </Suspense>
                        );
                    })()}

                    {activeTab === "inventory" && (
                        <div className="space-y-3">
                            {/* ── Low-stock summary ──
                                Surfaces items where count > 0 AND
                                count <= item.min, ranked by "how
                                close to zero" so the most urgent
                                items lead the list. Hidden when
                                nothing is low so a fully-stocked
                                day shows no chrome. Click "Show
                                only low stock" to filter the rest
                                of the page down to just these items
                                (the existing invShowOnlyCounted
                                pattern already supports filter
                                state — we layer this on top). */}
                            {(() => {
                                const lowItems = [];
                                for (const cat of customInventory || []) {
                                    for (const it of cat.items || []) {
                                        const min = Number(it?.min);
                                        if (!Number.isFinite(min) || min <= 0) continue;
                                        const c = Number(inventory[it.id] || 0);
                                        if (c > 0 && c <= min) {
                                            lowItems.push({ id: it.id, name: it.name || it.nameEn || it.id, count: c, min, vendor: it.vendor || it.supplier });
                                        }
                                    }
                                }
                                if (lowItems.length === 0) return null;
                                // Sort by ratio of current-to-min ascending
                                // → "out tomorrow" items lead "out next week" items.
                                lowItems.sort((a, b) => (a.count / a.min) - (b.count / b.min));
                                return (
                                    <div className="bg-amber-50 border border-amber-300 rounded-xl px-3 py-2.5 shadow-sm">
                                        <div className="flex items-center gap-2 mb-1.5">
                                            <span className="text-xl">📉</span>
                                            <span className="font-black text-amber-900 text-sm">
                                                {lowItems.length} {language === 'es' ? (lowItems.length === 1 ? 'artículo bajo en inventario' : 'artículos bajos en inventario') : (lowItems.length === 1 ? 'item low on stock' : 'items low on stock')}
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5">
                                            {lowItems.slice(0, 12).map(li => (
                                                <span key={li.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-amber-200 text-amber-900 text-[11px] font-bold">
                                                    <span className="tabular-nums">{li.count}/{li.min}</span>
                                                    <span className="opacity-80">·</span>
                                                    <span>{li.name}</span>
                                                </span>
                                            ))}
                                            {lowItems.length > 12 && (
                                                <span className="text-[11px] text-amber-800 font-bold px-1.5">
                                                    +{lowItems.length - 12} {language === 'es' ? 'más' : 'more'}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* ── TOP TOOLBAR ──
                                Layout: 2-row on mobile, 1-row on desktop.
                                Andrew (2026-05-17): "the line of buttons
                                that has master list, vender etc is too
                                long in mobile version. make it 2 lines
                                instead of one". Was a single `flex-row`
                                cramming 8 buttons (4 view tabs + 4
                                actions = Import CSV / Print / Compact /
                                Edit) onto one row, which overflowed on
                                iPhone widths. Now `flex-col` on mobile
                                gives each group its own row; `md:flex-row`
                                restores the original look on desktop. Both
                                groups also have `flex-wrap` so they still
                                degrade gracefully if a future button is
                                added or translation gets long. */}
                            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <button onClick={() => setInvViewMode("category")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "category" ? "bg-mint-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "📋 Lista Maestra" : "📋 Master List"}
                                    </button>
                                    {/* 📍 Location view — 2026-05-29 Andrew:
                                        "the locations drop down is to reorder
                                        the item on the inventory list so
                                        instead of protiens, veggies dairy.
                                        its to help us when we actully go
                                        throught he list and make our cart."
                                        Same items, regrouped by storage
                                        location instead of food category, so
                                        the counting walk through the kitchen
                                        matches the physical layout. */}
                                    <button onClick={() => setInvViewMode("location")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "location" ? "bg-mint-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "📍 Ubicación" : "📍 Location"}
                                    </button>
                                    <button onClick={() => setInvViewMode("vendor")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "vendor" ? "bg-mint-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "Proveedor" : "Vendor"}
                                    </button>
                                    <button onClick={() => setInvViewMode("split")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "split" ? "bg-purple-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "Dividir" : "Split"}
                                    </button>
                                    <button onClick={() => setInvViewMode("pricing")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "pricing" ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "Precios" : "Pricing"}
                                    </button>
                                </div>
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {currentIsAdmin && (
                                        <button onClick={() => setShowCsvImport(true)}
                                            title={language === "es" ? "Importar CSV del proveedor" : "Import vendor CSV"}
                                            className="px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 text-xs font-bold hover:bg-blue-100 transition">
                                            📥 {language === "es" ? "Importar CSV" : "Import CSV"}
                                        </button>
                                    )}
                                    {/* 🖨 Print — single button, prints the
                                        inventory comparison sheet (master +
                                        vendor-only counts grouped by vendor).
                                        2026-05-29 — Andrew: removed the 🏷
                                        Label button (date-sticker flow lives
                                        in Recipes / Operations sub-pages) and
                                        the free-form PrintCenter button (was
                                        confusing — staff thought it printed
                                        the inventory). One Print button, one
                                        job: print the inventory. */}
                                    <button onClick={printInventory}
                                        title={language === "es" ? "Imprimir inventario" : "Print inventory"}
                                        className="px-3 py-1.5 rounded-lg bg-purple-50 text-purple-700 border border-purple-200 text-xs font-bold hover:bg-purple-100 transition">
                                        🖨 {language === "es" ? "Imprimir" : "Print"}
                                    </button>
                                    {/* Density toggle — flips master list rows
                                        between the rich detailed view (current
                                        default) and a stripped-down NAME +
                                        QUANTITY layout for fast counting. */}
                                    <button onClick={() => setInvCompactView(v => !v)}
                                        title={invCompactView
                                            ? (language === "es" ? "Vista detallada" : "Detailed view")
                                            : (language === "es" ? "Vista compacta" : "Compact view")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                                            invCompactView
                                                ? 'bg-purple-600 text-white'
                                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                        }`}>
                                        {invCompactView
                                            ? (language === "es" ? "≡ Compacto" : "≡ Compact")
                                            : (language === "es" ? "≣ Detallado" : "≣ Detailed")}
                                    </button>
                                    <button onClick={() => { setInvEditMode(!invEditMode); setInvEditingIdx(null); setInvShowAddForm(null); }}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invEditMode ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {invEditMode ? (language === "es" ? "Listo" : "Done") : (language === "es" ? "Editar" : "Edit")}
                                    </button>
                                </div>
                            </div>

                            {/* Recent orders — replaced the Prices-freshness
                                banner here on 2026-05-23. Andrew: surfaces
                                the last 5 saved orders right above the cart
                                with a "Send to cart" button so admins can
                                re-use a past order as the starting point
                                for today's order (then edit/add as needed).
                                Replaces, not merges — see RecentOrdersBar
                                comment block for the why. */}
                            <RecentOrdersBar
                                storeLocation={storeLocation}
                                setInventory={setInventory}
                                currentInventory={inventory}
                                language={language}
                                onOpenHistory={openOrderHistory}
                            />
                            {/* Page-level Order-history modal (z-[80], above the cart
                                modal) so it can be opened while building a cart. */}
                            {orderHistoryOpen && (
                                <RecentOrdersHistoryModal
                                    storeLocation={storeLocation}
                                    setInventory={setInventory}
                                    currentInventory={inventory}
                                    language={language}
                                    itemNameById={itemNameById}
                                    initialExpandedId={orderHistoryFocusId}
                                    onClose={() => setOrderHistoryOpen(false)}
                                />
                            )}

                            {/* Move-mode banner — sticky strip that surfaces
                                the in-progress item + a Cancel. Subcategory
                                headers across every category turn amber
                                ("Drop here") while this is showing. */}
                            {movingItem && (
                                <div className="sticky top-0 z-10 bg-amber-100 border-2 border-amber-300 rounded-xl px-3 py-2 shadow-sm flex items-center gap-2">
                                    <span className="text-lg shrink-0">{"\u{1F500}"}</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-xs font-black text-amber-900 truncate">
                                            {language === "es" ? "Moviendo:" : "Moving:"} {movingItem.name}
                                        </div>
                                        <div className="text-[10px] text-amber-800 truncate">
                                            {language === "es"
                                                ? "Toca una sub-categoría para soltar aquí"
                                                : "Tap a subcategory to drop here"}
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => setMovingItem(null)}
                                        className="shrink-0 px-3 py-1.5 rounded-lg bg-white text-amber-900 text-xs font-bold border border-amber-300 hover:bg-amber-50 active:scale-95 transition"
                                    >
                                        {language === "es" ? "Cancelar" : "Cancel"}
                                    </button>
                                </div>
                            )}

                            {/* ── SEARCH BAR ── */}
                            {!invEditMode && (
                                <>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <div className="relative flex-1 min-w-[160px]">
                                        <input type="text" value={invSearch} onChange={e => setInvSearch(e.target.value)}
                                            placeholder={invAiOn
                                                ? (language === "es" ? "\u{1F50D} Buscar cualquier cosa (\"seco\", \"verde\", \"vegano\")" : "\u{1F50D} Search anything (\"dry\", \"green\", \"vegan\")")
                                                : (language === "es" ? "\u{1F50D} Buscar artículo..." : "\u{1F50D} Search items...")}
                                            className={`w-full px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-mint-700 bg-white ${invSearch ? "pr-12" : ""}`} />
                                        {invSearch && (
                                            <button type="button" onClick={() => { setInvSearch(""); setCollapsedCats({}); }}
                                                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-gray-200 text-gray-600 active:bg-gray-300 text-base font-bold">{"\u{2715}"}</button>
                                        )}
                                    </div>
                                    {/* AI semantic search toggle — ON sends queries
                                        to the aiSearch Cloud Function in parallel
                                        with the local substring matcher. ~$0.001
                                        per call. Toggle OFF if AI is slow or
                                        unwanted; substring keeps working. */}
                                    <button onClick={() => setInvAiOn(v => !v)}
                                        title={invAiOn
                                            ? (language === "es" ? "Búsqueda IA activada — clic para apagar" : "AI search ON — click to use plain search")
                                            : (language === "es" ? "Búsqueda básica — clic para activar IA" : "Plain search — click to enable AI")}
                                        className={`flex-shrink-0 px-3 py-2.5 rounded-xl text-sm font-bold border-2 transition ${invAiOn
                                            ? 'bg-purple-600 text-white border-purple-700'
                                            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                                        ✨ {language === "es" ? "IA" : "AI"}
                                    </button>
                                    {/* Quick Save + Clear — copies of the bottom "Save & Reset"
                                        and the cart "Empty", sized ~2× the AI button so you
                                        can save/clear the count without scrolling. Hidden in
                                        pricing view (counts don't apply there). Andrew
                                        2026-06-09. */}
                                    {invViewMode !== "pricing" && (
                                        <>
                                            <button disabled={inventorySaving}
                                                onClick={() => {
                                                    const ok = window.confirm(language === "es"
                                                        ? "¿Ya REVISASTE? Guardar y reiniciar los conteos."
                                                        : "Did you LOOK? Save & reset the counts.");
                                                    if (ok) saveAndResetInventory();
                                                }}
                                                title={language === "es" ? "Guardar y reiniciar el conteo" : "Save & reset the count"}
                                                className="flex-shrink-0 px-6 py-2.5 rounded-xl text-sm font-bold border-2 bg-mint-700 text-white border-mint-800 hover:bg-mint-800 active:scale-95 transition disabled:opacity-50">
                                                💾 {inventorySaving ? (language === "es" ? "Guardando…" : "Saving…") : (language === "es" ? "Guardar" : "Save")}
                                            </button>
                                            <button onClick={clearAllInventoryCounts}
                                                title={language === "es" ? "Limpiar todo el conteo" : "Clear all counts"}
                                                className="flex-shrink-0 px-6 py-2.5 rounded-xl text-sm font-bold border-2 bg-white text-red-700 border-red-200 hover:bg-red-50 active:scale-95 transition">
                                                🗑 {language === "es" ? "Limpiar" : "Clear"}
                                            </button>
                                        </>
                                    )}
                                </div>
                                {invSearch.trim() && invAiOn && (
                                    <div className="text-[11px] mt-1">
                                        {invAiLoading && <span className="text-purple-700 font-bold">✨ {language === "es" ? "pensando…" : "thinking…"}</span>}
                                        {!invAiLoading && invAiError && <span className="text-amber-700">⚠ {language === "es" ? "IA no disponible" : "AI unavailable"}</span>}
                                        {!invAiLoading && !invAiError && invAiIds && invAiIds.length > 0 && (
                                            <span className="text-purple-700">✨ {language === "es" ? `IA añadió ${invAiIds.length}` : `AI added ${invAiIds.length}`}</span>
                                        )}
                                    </div>
                                )}
                                </>
                            )}

                            {/* ── CART SUMMARY ── */}
                            {!invEditMode && (() => {
                                // Master items + vendor-only items (counts come from two separate maps)
                                const masterCount = Object.values(inventory).filter(v => v > 0).length;
                                const masterQty = Object.values(inventory).reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
                                const vendorOnlyCount = Object.values(vendorCounts).filter(v => v > 0).length;
                                const vendorOnlyQty = Object.values(vendorCounts).reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
                                const itemCount = masterCount + vendorOnlyCount;
                                const totalQty = masterQty + vendorOnlyQty;
                                if (itemCount === 0) return null;
                                return (
                                    <div className="bg-mint-50 border border-mint-200 rounded-xl px-3 py-2 flex items-center justify-between">
                                        <button onClick={() => setShowCart(true)} className="text-sm font-bold text-mint-700 flex items-center gap-1 hover:text-mint-900 transition">
                                            {"\u{1F6D2}"} {totalQty} {language === "es" ? "total" : "total"} ({itemCount} {language === "es" ? "artículos" : "items"})
                                            <span className="text-xs text-mint-500 ml-1">{language === "es" ? "ver ▸" : "view ▸"}</span>
                                        </button>
                                        <div className="flex items-center gap-1.5">
                                            <button onClick={() => setInvShowOnlyLow(v => !v)}
                                                className={`text-xs font-bold px-2 py-1 rounded-lg transition ${invShowOnlyLow ? "bg-amber-600 text-white" : "bg-amber-100 text-amber-800 hover:bg-amber-200"}`}>
                                                📉 {invShowOnlyLow ? (language === "es" ? "Mostrar Todo" : "Show All") : (language === "es" ? "Solo Bajos" : "Low Only")}
                                            </button>
                                            <button onClick={() => setInvShowOnlyCounted(!invShowOnlyCounted)}
                                                className={`text-xs font-bold px-2 py-1 rounded-lg transition ${invShowOnlyCounted ? "bg-mint-700 text-white" : "bg-mint-100 text-mint-700 hover:bg-mint-200"}`}>
                                                {invShowOnlyCounted ? (language === "es" ? "Ver Todo" : "Show All") : (language === "es" ? "Solo Contados" : "Counted Only")}
                                            </button>
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* ── CART MODAL ── multi-vendor comparison view ──
                                One row per counted item with all vendor prices side-by-side.
                                Cheapest vendor highlighted (🏆). Per-vendor totals + best-mix
                                summary at the bottom so the orderer can decide if splitting
                                between vendors is worth it. */}
                            {showCart && cartData && (() => {
                                // 2026-05-29 perf — heavy derivations are
                                // computed once at component scope via the
                                // cartData useMemo above the return. The IIFE
                                // is now a thin renderer that destructures
                                // the memoized fields and constructs the
                                // closure-bound helpers (cheap, identity-
                                // changes-per-render is fine for handlers).
                                const {
                                    rows, vendorList, vendorTotals,
                                    bestMixSum, uncovered, bestMixByVendor,
                                    totalItems, totalQty,
                                } = cartData;
                                // vendorColor helper used to live here; now
                                // the rows render through the memoized
                                // <CartRow> at module scope which calls
                                // vendorColorFor() directly.

                                // Quick-assign pill bar uses the canonical 8-vendor
                                // list from inventory.js. Order is fixed (Andrew's
                                // spec 2026-05-22): Wholesale, Costco, Restaurant
                                // Depot, US Foods, Sysco, Jays, Pan Asia, Other.
                                // Items with messy historical vendor strings (Wing
                                // Hing, Special Order, etc.) get normalized to
                                // "Other" for grouping but their full name still
                                // shows in the item meta line.
                                const assignVendors = INVENTORY_VENDORS;

                                // Effective vendor per row: override (manager picked
                                // explicitly) wins; otherwise normalize the item's
                                // preferredVendor onto the canonical list.
                                const effectiveVendor = (r) =>
                                    cartVendorOverride[r.id] || normalizeVendor(r.preferredVendor) || '';

                                const assignRow = (id) => {
                                    if (!cartArmedVendor) return;
                                    setCartVendorOverride(prev => ({ ...prev, [id]: cartArmedVendor }));
                                };
                                const clearAssignments = () => {
                                    if (!confirm(language === 'es'
                                        ? '¿Borrar todas las asignaciones manuales? Los artículos volverán a su proveedor preferido.'
                                        : 'Clear all manual vendor assignments? Items revert to their preferred vendor.')) return;
                                    setCartVendorOverride({});
                                };

                                // Per-vendor totals, best-mix sums, totalItems,
                                // totalQty all destructured above from cartData
                                // (computed by the memoized derivation at
                                // component scope — see the useMemo block
                                // before this component's return).

                                return (
                                    // 2026-05-27 — Andrew: "in inventory the cart
                                    // i want the view to be bigger. on desktop
                                    // when pressed the view the cart window ends
                                    // up too low have the window open at the top
                                    // right inder the cart bar."
                                    //
                                    // Two positioning modes share one render tree:
                                    //   • Mobile (<sm): bottom sheet — items-end
                                    //     + justify-center + p-2. Slides up from
                                    //     the bottom edge so the user's tap
                                    //     gesture and the sheet's entry direction
                                    //     match. Unchanged from before.
                                    //   • Desktop (sm+): TOP-RIGHT anchored panel
                                    //     — items-start + justify-end. Padding
                                    //     pt-20 leaves room for the global app
                                    //     header (h-16 desktop + safe-area inset)
                                    //     so the cart panel sits visually UNDER
                                    //     the header bar. pr-6 keeps it off the
                                    //     viewport's right edge.
                                    //
                                    // Size bump: max-w-3xl (768px) → sm:max-w-5xl
                                    // (1024px) and max-h-[92vh] (mobile) →
                                    // sm:max-h-[calc(100vh-104px)] (desktop) so
                                    // the vendor-comparison table has room to
                                    // breathe and the bottom edge stays inside
                                    // the viewport. Heavier shadow on desktop
                                    // (shadow-2xl) signals "elevated panel" since
                                    // the modal is no longer centered on the
                                    // dimmed scrim — it visually floats off the
                                    // corner like a Settings popover.
                                    <ModalPortal>
                                    <div
                                        className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-start justify-center sm:justify-end p-2 sm:p-6 sm:pt-20"
                                        onClick={() => setShowCart(false)}
                                    >
                                        <div
                                            className="bg-white w-full max-w-3xl sm:max-w-5xl max-h-[92vh] sm:max-h-[calc(100vh-104px)] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col sm:shadow-2xl"
                                            onClick={e => e.stopPropagation()}
                                        >
                                            {/* Header */}
                                            <div className="bg-mint-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                                                <h3 className="font-bold text-base sm:text-lg">{"\u{1F6D2}"} {language === "es" ? "Carrito" : "Cart"} — {totalItems} {language === "es" ? "artículos" : "items"} · {totalQty} {language === "es" ? "total" : "total"}</h3>
                                                <div className="flex items-center gap-2">
                                                    {/* Open order history WHILE the cart is open — layers above (z-[80]) so
                                                        you can reference a past order without losing your in-progress cart. */}
                                                    <button onClick={() => openOrderHistory()}
                                                        className="px-2.5 py-1 rounded-full bg-white/20 hover:bg-white/30 text-white text-xs font-bold transition flex items-center gap-1">
                                                        📋 {language === "es" ? "Historial" : "History"}
                                                    </button>
                                                    <button onClick={() => setShowCart(false)} className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-white font-bold hover:bg-white/30 transition">{"\u{2715}"}</button>
                                                </div>
                                            </div>
                                            {/* Old in-cart "Assign to" pill bar removed
                                                2026-05-26. The same mechanic now lives in a
                                                focused Plan view (toggled from the footer
                                                "Plan" button) — see CartPlanView further
                                                down. The cart body shows comparison data;
                                                Plan mode shows the assignment workflow. */}
                                            {/* Plan view — replaces the comparison table
                                                when Plan mode is on. Vendor pills at top,
                                                items list below with chips showing assigned
                                                vendor; armed vendor + tap-to-assign with
                                                silent reassign. */}
                                            {cartPlanMode ? (
                                                <CartPlanView
                                                    rows={rows}
                                                    language={language}
                                                    assignVendors={assignVendors}
                                                    cartArmedVendor={cartArmedVendor}
                                                    setCartArmedVendor={setCartArmedVendor}
                                                    cartVendorOverride={cartVendorOverride}
                                                    setCartVendorOverride={setCartVendorOverride}
                                                    effectiveVendor={effectiveVendor}
                                                    onDone={() => { setCartPlanMode(false); setCartArmedVendor(null); }}
                                                    onClearAll={clearAssignments}
                                                />
                                            ) : (
                                            /* Comparison table */
                                            <div className="flex-1 overflow-auto">
                                                {rows.length === 0 ? (
                                                    <div className="p-8 text-center text-gray-400">{language === "es" ? "El carrito está vacío" : "Cart is empty"}</div>
                                                ) : (
                                                    <table className="w-full text-sm">
                                                        <thead className="sticky top-0 bg-gray-100 z-10">
                                                            <tr>
                                                                <th className="text-left px-3 py-2 text-xs font-bold text-gray-600">{language === "es" ? "Artículo" : "Item"}</th>
                                                                <th className="text-center px-2 py-2 text-xs font-bold text-gray-600 w-14">{language === "es" ? "Cant." : "Qty"}</th>
                                                                {vendorList.map(v => (
                                                                    <th key={v} className={`text-right px-2 py-2 text-xs font-bold ${v === "Sysco" ? "text-blue-700 bg-blue-50" : v === "US Foods" ? "text-orange-700 bg-orange-50" : "text-gray-700"}`}>
                                                                        {v}
                                                                    </th>
                                                                ))}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {rows.map(r => (
                                                                <CartRow
                                                                    key={r.id}
                                                                    r={r}
                                                                    vendorList={vendorList}
                                                                    myEffVendor={effectiveVendor(r)}
                                                                    isOverridden={!!cartVendorOverride[r.id]}
                                                                    itemPrices={itemPrices}
                                                                    isEn={language !== 'es'}
                                                                />
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                )}

                                                {/* Totals block */}
                                                {rows.length > 0 && vendorList.length > 0 && (
                                                    <div className="border-t-2 border-gray-300 bg-gray-50 p-3 space-y-3">
                                                        <div>
                                                            <div className="text-xs font-bold uppercase text-gray-500 mb-1">{language === "es" ? "Si pides todo de un proveedor" : "If you order all from one vendor"}</div>
                                                            {vendorList.map(v => (
                                                                <div key={v} className="flex items-center justify-between py-1 text-sm">
                                                                    <span className={`font-bold ${v === "Sysco" ? "text-blue-700" : v === "US Foods" ? "text-orange-700" : "text-gray-700"}`}>{v}</span>
                                                                    <span>
                                                                        <span className="font-bold text-gray-800">${vendorTotals[v].lineTotal.toFixed(2)}</span>
                                                                        <span className="text-gray-500 text-xs ml-2">{vendorTotals[v].items} {language === "es" ? "artículos" : "items"}{vendorTotals[v].missing > 0 ? ` · ${vendorTotals[v].missing} ${language === "es" ? "no disponible" : "missing"}` : ""}</span>
                                                                    </span>
                                                                </div>
                                                            ))}
                                                        </div>
                                                        <div className="border-t border-gray-300 pt-3">
                                                            <div className="text-xs font-bold uppercase text-gray-500 mb-1">{language === "es" ? "Mejor combinación (más barato por artículo)" : "Best mix (cheapest per item)"}</div>
                                                            {Object.keys(bestMixByVendor).filter(v => bestMixByVendor[v].items > 0).map(v => (
                                                                <div key={v} className="flex items-center justify-between py-1 text-sm">
                                                                    <span className={`font-bold ${v === "Sysco" ? "text-blue-700" : v === "US Foods" ? "text-orange-700" : "text-gray-700"}`}>{v}</span>
                                                                    <span>
                                                                        <span className="font-bold text-gray-800">${bestMixByVendor[v].lineTotal.toFixed(2)}</span>
                                                                        <span className="text-gray-500 text-xs ml-2">{bestMixByVendor[v].items} {language === "es" ? "artículos" : "items"}</span>
                                                                    </span>
                                                                </div>
                                                            ))}
                                                            <div className="flex items-center justify-between pt-2 mt-2 border-t border-gray-300 text-base font-bold">
                                                                <span>{language === "es" ? "Total" : "Total"}</span>
                                                                <span className="text-green-700">${bestMixSum.toFixed(2)}</span>
                                                            </div>
                                                            {uncovered > 0 && <div className="text-[11px] text-amber-700 mt-1">⚠️ {uncovered} {language === "es" ? "artículo(s) sin precio de proveedor" : "item(s) have no live vendor price"}</div>}
                                                            {(() => {
                                                                // Savings calculation
                                                                const cheapest = vendorList.reduce((min, v) => {
                                                                    if (vendorTotals[v].missing > 0) return min;
                                                                    if (min === null) return v;
                                                                    return vendorTotals[v].lineTotal < vendorTotals[min].lineTotal ? v : min;
                                                                }, null);
                                                                if (cheapest && bestMixSum < vendorTotals[cheapest].lineTotal) {
                                                                    const saved = vendorTotals[cheapest].lineTotal - bestMixSum;
                                                                    return <div className="text-[11px] text-green-700 mt-1 font-medium">💰 {language === "es" ? `Ahorras $${saved.toFixed(2)} dividiendo entre proveedores` : `Saves $${saved.toFixed(2)} by splitting between vendors`}</div>;
                                                                }
                                                                return null;
                                                            })()}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                            )}
                                            {/* Footer buttons */}
                                            <div className="border-t border-gray-200 p-3 flex gap-2 flex-shrink-0 bg-gray-50 flex-wrap">
                                                {/* 📋 Plan — opens the focused Plan view that
                                                    replaces the in-cart "Assign to" pill bar.
                                                    The badge counts how many items already
                                                    have a manual override so the manager can
                                                    see planning progress at a glance. */}
                                                {!cartPlanMode && rows.length > 0 && (
                                                    <button
                                                        onClick={() => { setCartPlanMode(true); setCartArmedVendor(null); }}
                                                        className="flex-1 min-w-[120px] py-3 bg-purple-600 text-white rounded-xl font-bold text-sm hover:bg-purple-700 active:scale-95 transition flex items-center justify-center gap-1.5">
                                                        📋 {language === "es" ? "Planear" : "Plan"}
                                                        {Object.keys(cartVendorOverride).length > 0 && (
                                                            <span className="bg-white/25 px-1.5 py-0.5 rounded-full text-[10px]">
                                                                {Object.keys(cartVendorOverride).length}/{rows.length}
                                                            </span>
                                                        )}
                                                    </button>
                                                )}
                                                <button onClick={printInventory} className="flex-1 min-w-[120px] py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 active:scale-95 transition">
                                                    {"\u{1F5A8}\u{FE0F}"} {language === "es" ? "Imprimir" : "Print"}
                                                </button>
                                                {/* Print By Vendor — uses the manager's cart
                                                    assignments (cartVendorOverride > item.
                                                    preferredVendor) and emits one section per
                                                    vendor with a checkbox column. Andrew
                                                    2026-05-22 "i puts them in that order per
                                                    vender". */}
                                                <button onClick={printOrderByVendor} className="flex-1 min-w-[120px] py-3 bg-green-600 text-white rounded-xl font-bold text-sm hover:bg-green-700 active:scale-95 transition">
                                                    📋 {language === "es" ? "Por Proveedor" : "By Vendor"}
                                                </button>
                                                {/* Place order — opens OrderMode. Snapshot the
                                                    rows we just built so the order session has
                                                    the same items the admin is looking at, even
                                                    if inventory changes mid-session.
                                                    2026-05-26 bug fix: the vendor field used to
                                                    read r.preferredVendor and ignore the cart's
                                                    manual overrides, so the manager's Plan
                                                    never carried into OrderMode. Now uses
                                                    effectiveVendor(r) = override || preferred. */}
                                                <button onClick={() => {
                                                    if (rows.length === 0) {
                                                        toast(language === "es" ? "El carrito está vacío." : "Cart is empty.");
                                                        return;
                                                    }
                                                    setOrderModeRows(rows.map(r => ({
                                                        id: r.id,
                                                        name: r.altName || r.name,
                                                        nameEs: r.name !== r.altName ? r.name : null,
                                                        qty: r.qty,
                                                        category: r.category,
                                                        subcat: r.subcat || '',
                                                        pack: r.pack,
                                                        vendor: effectiveVendor(r) || r.preferredVendor,
                                                        preferredVendor: r.preferredVendor,
                                                    })));
                                                    setShowCart(false);
                                                }} className="flex-1 py-3 bg-amber-600 text-white rounded-xl font-bold text-sm hover:bg-amber-700 active:scale-95 transition">
                                                    📞 {language === "es" ? "Hacer pedido" : "Place order"}
                                                </button>
                                                {/* 2026-05-24 — Andrew: "how do you empty it? lets
                                                    also create a empty cart button." One-tap clear
                                                    with confirm (rows.length protects accidental
                                                    taps when cart is already empty). Sets the
                                                    inventory map to {} both locally (setInventory)
                                                    and on the canonical /ops/inventory_{loc}.counts
                                                    doc. updateDoc not setDoc — preserves other
                                                    fields like customInventory + lastModified.
                                                    Closes the cart modal on success (it's empty;
                                                    no reason to keep staring at it). */}
                                                {rows.length > 0 && (
                                                    <button onClick={async () => {
                                                        const ok = window.confirm(language === "es"
                                                            ? `¿Vaciar el carrito (${rows.length} items)? Esto no se puede deshacer.`
                                                            : `Empty the cart (${rows.length} items)? This cannot be undone.`);
                                                        if (!ok) return;
                                                        setInventory({});
                                                        try {
                                                            await updateDoc(doc(db, "ops", "inventory_" + storeLocation), {
                                                                counts: {},
                                                                date: new Date().toISOString(),
                                                            });
                                                            toast(language === "es" ? "✓ Carrito vaciado" : "✓ Cart emptied", { kind: 'success' });
                                                        } catch (e) {
                                                            console.warn('empty cart persist failed:', e);
                                                            toast(language === "es" ? "Error al vaciar" : "Could not empty", { kind: 'error' });
                                                        }
                                                        setShowCart(false);
                                                    }} className="flex-1 py-3 bg-red-50 border border-red-200 text-red-700 rounded-xl font-bold text-sm hover:bg-red-100 active:scale-95 transition">
                                                        🗑 {language === "es" ? "Vaciar" : "Empty"}
                                                    </button>
                                                )}
                                                <button onClick={() => setShowCart(false)} className="flex-1 py-3 bg-gray-200 text-gray-700 rounded-xl font-bold text-sm hover:bg-gray-300 active:scale-95 transition">
                                                    {"\u{2715}"} {language === "es" ? "Cerrar" : "Close"}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                    </ModalPortal>
                                );
                            })()}

                            {/* ── Order Mode modal ── */}
                            {orderModeRows && (
                                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-[55]" />}>
                                    <OrderMode
                                        language={language}
                                        storeLocation={storeLocation}
                                        staffName={staffName}
                                        customInventory={customInventory}
                                        cartItems={orderModeRows}
                                        onClose={closeOrderMode}
                                    />
                                </Suspense>
                            )}

                            {/* 🏷 Quick date-code label — opens the same
                                PrintLabelModal Recipes uses, but in
                                editable mode so the staffer types the
                                item name and toggles allergens by hand.
                                Used for inventory items, opened cases,
                                special prep — anything that doesn't
                                have a recipe entry. */}
                            {showQuickLabel && (
                                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                                    <PrintLabelModal
                                        editable={true}
                                        recipe={{ titleEn: '', titleEs: '', allergens: [], ingredientsEn: [] }}
                                        location={storeLocation}
                                        staffName={staffName}
                                        language={language}
                                        onClose={() => setShowQuickLabel(false)}
                                    />
                                </Suspense>
                            )}

                            {/* 🖨 Print Center — free-form printer. Stays
                                mounted as a modal so the staffer can come
                                back to it during their inventory session. */}
                            {showPrintCenter && (
                                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                                    <PrintCenter
                                        location={storeLocation}
                                        staffName={staffName}
                                        language={language}
                                        isAdmin={currentIsAdmin}
                                        onClose={() => setShowPrintCenter(false)}
                                    />
                                </Suspense>
                            )}

                            {/* Admin trusted-price editor (inventory pricing redesign). */}
                            {priceEditItem && (
                                <ItemPriceModal
                                    key={priceEditItem.id}
                                    item={priceEditItem}
                                    location={storeLocation}
                                    staffName={staffName}
                                    language={language}
                                    priceDoc={itemPrices[priceEditItem.id]}
                                    onClose={() => setPriceEditItem(null)}
                                />
                            )}

                            {/* ── CATEGORY VIEW ── */}
                            {invViewMode === "category" && customInventory.map((category, catIdx) => {
                                // Same filter pattern used by vendor / split / pricing views.
                                const searchLower = (invSearchDeferred || "").toLowerCase().trim();
                                let filteredItems = searchLower
                                    ? category.items.filter(item => itemMatchesSearchAi(item, searchLower))
                                    : category.items;
                                if (invShowOnlyCounted) {
                                    filteredItems = filteredItems.filter(item => (inventory[item.id] || 0) > 0);
                                }
                                if (invShowOnlyLow) {
                                    filteredItems = filteredItems.filter(item => {
                                        const min = Number(item?.min);
                                        if (!Number.isFinite(min) || min <= 0) return false;
                                        const c = Number(inventory[item.id] || 0);
                                        return c > 0 && c <= min;
                                    });
                                }
                                // Hide the whole category card when a filter is active and nothing matches.
                                if ((searchLower || invShowOnlyCounted || invShowOnlyLow) && filteredItems.length === 0) return null;

                                const catKey = "cat-" + catIdx;
                                const isCollapsed = collapsedCats[catKey] && !searchLower;
                                const countedInCat = category.items.filter(i => (inventory[i.id] || 0) > 0).length;

                                // FIX (review 2026-05-14, perf): build an
                                // id→index map ONCE per category render so
                                // the inner subGroup.items.map can do an O(1)
                                // lookup instead of category.items.indexOf
                                // (which was O(n²) overall and ran on every
                                // 30s clockTick re-render).
                                const itemIdxByIdInCat = new Map();
                                for (let i = 0; i < category.items.length; i++) {
                                    itemIdxByIdInCat.set(category.items[i].id, i);
                                }

                                // Subcategories removed (Andrew 2026-05-22 —
                                // "lets remove the sub categories i dont think
                                // we need it"). The inventory page now renders
                                // items flat within each category — no
                                // subcategory headers, no per-subcat drop
                                // zones. We keep the subgroup data shape
                                // (Array<{ name, items }>) so the existing
                                // render code below still works; we just
                                // produce a single unnamed group per category.
                                // Items group by location instead, in the new
                                // location-bubble filter bar at the top of
                                // the page (separate change).
                                const subcats = [{ name: "", items: filteredItems }];

                                return (
                                <div key={catIdx} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                                    {/* Category header — tap to collapse */}
                                    <button onClick={() => toggleCatCollapse(catKey)}
                                        className="w-full p-3 bg-gradient-to-r from-mint-700 to-mint-600 flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <span className="text-white text-sm font-bold">{language === "es" ? category.nameEs : category.name}</span>
                                            <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{filteredItems.length}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {countedInCat > 0 && <span className="bg-white text-mint-700 text-xs font-bold px-2 py-0.5 rounded-full">{countedInCat} {"\u{2713}"}</span>}
                                            <span className="text-white text-xs">{isCollapsed ? "\u{25B6}" : "\u{25BC}"}</span>
                                        </div>
                                    </button>

                                    {!isCollapsed && (
                                        <div className="divide-y divide-gray-100">
                                            {/* Category-level drop zone (post-subcat-removal
                                                2026-05-22 audit fix). Subcat headers no
                                                longer render — the per-subcat drop strips
                                                inside the subcats.map below now stay hidden
                                                because subGroup.name is always empty. Without
                                                this strip, tapping Move on an item left the
                                                user with no visible drop target anywhere on
                                                screen. Shows only while a move is in flight,
                                                shows "(source)" on the source category so
                                                tapping there cancels. */}
                                            {movingItem && (() => {
                                                const isSource = movingItem.fromCatIdx === catIdx;
                                                return (
                                                    <button
                                                        onClick={() => dropMovingItem(catIdx, "")}
                                                        className={`w-full px-3 py-2 border-b text-left transition active:scale-[0.98] ${
                                                            isSource
                                                                ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-default'
                                                                : 'bg-amber-100 hover:bg-amber-200 border-amber-300 text-amber-900'
                                                        }`}
                                                        disabled={isSource}
                                                        aria-label={language === "es" ? `Mover aquí: ${category.name}` : `Drop here: ${category.name}`}
                                                    >
                                                        <span className="text-xs font-bold uppercase tracking-wide">
                                                            {isSource
                                                                ? `${category.name} ${language === "es" ? "(actual)" : "(source)"}`
                                                                : `${"\u{1F4E5}"} ${language === "es" ? "Mover aquí" : "Drop here"}: ${category.name}`}
                                                        </span>
                                                    </button>
                                                );
                                            })()}
                                            {subcats.map((subGroup, subIdx) => (
                                                // 2026-05-29 — Andrew: "lets put lines to
                                                // separate the items so its easier to follow".
                                                // The wrapping divide-y class lays a single
                                                // 1px gray line between every direct child,
                                                // i.e. the subcategory header AND every item
                                                // row. Compact view doesn't get extra padding
                                                // so the lines also serve as the row guide
                                                // when scanning quickly.
                                                <div key={subIdx} className="divide-y divide-gray-200">
                                                    {/* Subcategory header — also acts as a
                                                        TAP-TO-DROP zone when movingItem is
                                                        set. Highlighted amber while a move is
                                                        in progress so it's obvious which strips
                                                        are tappable. The header for the SOURCE
                                                        subcategory of the in-progress item
                                                        gets a "(source)" tag and dropping
                                                        there cancels the move (no-op). */}
                                                    {subGroup.name && (
                                                        (() => {
                                                            const isMoveActive = !!movingItem;
                                                            const isSource = isMoveActive
                                                                && movingItem.fromCatIdx === catIdx
                                                                && (movingItem.fromSubcat || '') === (subGroup.name || '');
                                                            if (!isMoveActive) {
                                                                return (
                                                                    <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-100">
                                                                        <span className="text-xs font-bold text-blue-700 uppercase tracking-wide">{subGroup.name}</span>
                                                                    </div>
                                                                );
                                                            }
                                                            return (
                                                                <button
                                                                    onClick={() => dropMovingItem(catIdx, subGroup.name)}
                                                                    className={`w-full px-3 py-2 border-b text-left transition active:scale-[0.98] ${
                                                                        isSource
                                                                            ? 'bg-gray-100 border-gray-300 text-gray-500 cursor-default'
                                                                            : 'bg-amber-100 border-amber-300 text-amber-900 hover:bg-amber-200'
                                                                    }`}
                                                                    aria-label={language === "es" ? `Mover aquí: ${subGroup.name}` : `Drop here: ${subGroup.name}`}
                                                                >
                                                                    <span className="text-xs font-bold uppercase tracking-wide">
                                                                        {isSource
                                                                            ? `${subGroup.name} ${language === "es" ? "(actual)" : "(source)"}`
                                                                            : `${"\u{1F4E5}"} ${language === "es" ? "Mover aquí" : "Drop here"}: ${subGroup.name}`}
                                                                    </span>
                                                                </button>
                                                            );
                                                        })()
                                                    )}

                                                    {subGroup.items.map((item) => {
                                                        const itemIdx = itemIdxByIdInCat.get(item.id) ?? -1;
                                                        const count = inventory[item.id] || 0;
                                                        // Bug fix (Andrew 2026-05-17 — "edit button on every
                                                        // item isnt working"): previously this required
                                                        // `invEditMode && ...` which meant clicking the per-row
                                                        // Edit pencil button set invEditingIdx but the form
                                                        // never opened because the surrounding edit-mode
                                                        // toggle was off. Now isEditing is purely a function
                                                        // of which row was clicked — Edit just works without
                                                        // having to first flip the global edit-mode switch.
                                                        const isEditing = invEditingIdx && invEditingIdx.catIdx === catIdx && invEditingIdx.itemIdx === itemIdx;
                                                        // Visual marker for items added via the "Add as new master item" flow
                                                        // in the match audit modal — colored left border based on origin vendor.
                                                        const fromVendor = item.addedFromVendor;
                                                        const fromVendorBorder = fromVendor === "Sysco" ? "border-l-4 border-blue-400"
                                                                                : fromVendor === "US Foods" ? "border-l-4 border-orange-400"
                                                                                : "";
                                                        return (
                                                            <div key={item.id} className={`px-3 py-2 ${count > 0 ? "bg-green-50/50" : ""} ${isEditing ? "bg-blue-50 border-l-4 border-blue-500" : fromVendorBorder}`}>
                                                                {isEditing ? (
                                                                    <div className="space-y-2">
                                                                        <input type="text" value={invEditName} onChange={(e) => setInvEditName(e.target.value)}
                                                                            placeholder="Item name" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        <input type="text" value={invEditNameEs} onChange={(e) => setInvEditNameEs(e.target.value)}
                                                                            placeholder="Nombre en español" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        <div className="flex gap-2">
                                                                            <input type="text" value={invEditSupplier} onChange={(e) => setInvEditSupplier(e.target.value)}
                                                                                placeholder={language === "es" ? "Proveedor" : "Vendor"} className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                            <input type="text" value={invEditOrderDay} onChange={(e) => setInvEditOrderDay(e.target.value)}
                                                                                placeholder={language === "es" ? "Día" : "Order day"} className="w-24 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                            {/* Low-stock threshold input. Keep it tight
                                                                                so the row doesn't grow taller for the
                                                                                common case (no min set). inputMode
                                                                                numeric brings up the iOS keypad. */}
                                                                            <input type="text" inputMode="numeric" pattern="[0-9]*"
                                                                                value={invEditMin}
                                                                                onChange={(e) => setInvEditMin(e.target.value.replace(/[^0-9]/g, ''))}
                                                                                placeholder={language === "es" ? "Mín" : "Min"}
                                                                                title={language === "es" ? "Alerta cuando el conteo está bajo o igual a este número" : "Alert when count drops to/below this number"}
                                                                                className="w-16 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-amber-500 focus:outline-none text-center tabular-nums" />
                                                                        </div>
                                                                        {/* "Move to" picker — flat list of every
                                                                            existing TopCategory > SubCategory leaf in
                                                                            the inventory. One dropdown, no way to
                                                                            accidentally pick a subcat in the wrong
                                                                            top-level. Andrew (2026-05-17): "edit and
                                                                            move the category to chicken… create its
                                                                            own chicken category. i need it to move
                                                                            to a chicken category already made up
                                                                            top". The old two-dropdown picker let you
                                                                            change subcat without realising the
                                                                            top-level was still wrong, so an item in
                                                                            Frozen with subcat="Chicken" looked like
                                                                            a brand-new "Chicken" group sitting
                                                                            under Frozen. The flat picker shows the
                                                                            FULL destination (e.g. "Proteins ▸
                                                                            Chicken") so you can't make that mistake.

                                                                            Below the picker, a free-text input lets
                                                                            you create a brand-new subcategory inside
                                                                            the currently-selected top-level — type
                                                                            a name that doesn't exist yet and Save. */}
                                                                        {(() => {
                                                                            // Flatten: every existing leaf as
                                                                            // {catIdx, subcat, label}. Includes a
                                                                            // "(uncategorized)" pseudo-leaf for
                                                                            // each top-level so items without a
                                                                            // subcat have a target.
                                                                            const leaves = [];
                                                                            for (let ci = 0; ci < customInventory.length; ci++) {
                                                                                const cat = customInventory[ci];
                                                                                const subs = new Set();
                                                                                for (const it of (cat.items || [])) {
                                                                                    if (it.subcat) subs.add(it.subcat);
                                                                                }
                                                                                const catLabel = language === "es" && cat.nameEs ? cat.nameEs : cat.name;
                                                                                // (uncategorized) entry first.
                                                                                leaves.push({
                                                                                    key: `${ci}|`,
                                                                                    catIdx: ci,
                                                                                    subcat: '',
                                                                                    label: `${catLabel} ${"▸"} ${language === "es" ? "(sin sub-categoría)" : "(no subcategory)"}`,
                                                                                });
                                                                                for (const s of Array.from(subs).sort()) {
                                                                                    leaves.push({
                                                                                        key: `${ci}|${s}`,
                                                                                        catIdx: ci,
                                                                                        subcat: s,
                                                                                        label: `${catLabel} ${"▸"} ${s}`,
                                                                                    });
                                                                                }
                                                                            }
                                                                            // Current selection key. Default to the
                                                                            // item's existing placement.
                                                                            const curCat = invEditTargetCatIdx == null ? catIdx : Number(invEditTargetCatIdx);
                                                                            const selectedKey = `${curCat}|${invEditSubcat || ''}`;
                                                                            return (
                                                                                <select
                                                                                    value={selectedKey}
                                                                                    onChange={(e) => {
                                                                                        const [ciStr, ...rest] = e.target.value.split('|');
                                                                                        const ci = Number(ciStr);
                                                                                        const sub = rest.join('|');
                                                                                        setInvEditTargetCatIdx(ci);
                                                                                        setInvEditSubcat(sub);
                                                                                    }}
                                                                                    className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none bg-white"
                                                                                    aria-label={language === "es" ? "Mover a" : "Move to"}
                                                                                >
                                                                                    {leaves.map(l => (
                                                                                        <option key={l.key} value={`${l.catIdx}|${l.subcat}`}>
                                                                                            {l.label}
                                                                                        </option>
                                                                                    ))}
                                                                                    {/* If the current subcat doesn't exist
                                                                                        in the destination yet (in-progress
                                                                                        free-text edit), surface it as a
                                                                                        selectable option so the dropdown
                                                                                        accurately reflects current state. */}
                                                                                    {invEditSubcat && !leaves.some(l => l.catIdx === curCat && l.subcat === invEditSubcat) && (
                                                                                        <option value={`${curCat}|${invEditSubcat}`}>
                                                                                            {(() => {
                                                                                                const cat = customInventory[curCat];
                                                                                                const catLabel = cat ? (language === "es" && cat.nameEs ? cat.nameEs : cat.name) : '?';
                                                                                                return `${catLabel} ${"▸"} ${invEditSubcat} ${language === "es" ? "(nuevo)" : "(new)"}`;
                                                                                            })()}
                                                                                        </option>
                                                                                    )}
                                                                                </select>
                                                                            );
                                                                        })()}
                                                                        {/* Free-text — create a brand-new
                                                                            subcategory inside the currently-selected
                                                                            top-level category. Typing here ONLY
                                                                            changes the subcat — the top-level stays
                                                                            whatever the picker above is set to, so
                                                                            you can't accidentally drop a new "Chicken"
                                                                            subcat in the wrong category. */}
                                                                        <input type="text"
                                                                            value={invEditSubcat}
                                                                            onChange={(e) => setInvEditSubcat(e.target.value)}
                                                                            placeholder={language === "es" ? "...o escribe nueva sub-categoría dentro de la categoría elegida" : "...or type a new subcategory inside the selected category"}
                                                                            className="w-full px-2 py-1.5 border-2 border-dashed border-gray-300 rounded-lg text-xs text-gray-600 focus:border-mint-700 focus:outline-none" />
                                                                        {/* 📍 Storage location picker. Restored
                                                                            2026-05-29 — the original location-
                                                                            mapper script ran server-side once and
                                                                            then had no in-app counterpart, so
                                                                            staff couldn't fix bad assignments.
                                                                            List = canonical INVENTORY_LOCATIONS
                                                                            union'd with any non-canonical values
                                                                            already in use so previously-set
                                                                            custom locations stay reachable. */}
                                                                        {(() => {
                                                                            const seenLocs = new Set(INVENTORY_LOCATIONS);
                                                                            for (const c of customInventory) for (const it of (c.items || [])) {
                                                                                if (it.location && !seenLocs.has(it.location)) seenLocs.add(it.location);
                                                                            }
                                                                            return (
                                                                                <label className="flex items-center gap-2 text-xs">
                                                                                    <span className="text-gray-500 font-bold whitespace-nowrap">📍 {language === "es" ? "Ubicación" : "Location"}:</span>
                                                                                    <select
                                                                                        value={invEditLocation || ''}
                                                                                        onChange={(e) => setInvEditLocation(e.target.value)}
                                                                                        className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none bg-white">
                                                                                        <option value="">{language === "es" ? "(sin ubicación)" : "(none)"}</option>
                                                                                        {[...seenLocs].map(l => (
                                                                                            <option key={l} value={l}>{locationLabel(l, language === 'es')}</option>
                                                                                        ))}
                                                                                    </select>
                                                                                </label>
                                                                            );
                                                                        })()}
                                                                        <div className="flex gap-2">
                                                                            <button onClick={() => saveInvEdit(catIdx, itemIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Guardar" : "Save"}</button>
                                                                            <button onClick={() => { setInvEditingIdx(null); setInvEditTargetCatIdx(null); setInvEditSubcat(""); setInvEditLocation(""); }} className="flex-1 bg-gray-400 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-gray-500">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                                        </div>
                                                                        {/* 2026-06-07 — Andrew: delete an item from the edit
                                                                            view. Admin-only + 5s undo toast (deleteInvItem)
                                                                            so a fat-finger delete on a phone is recoverable;
                                                                            also clears the item's count/countMeta. Full-width
                                                                            red + separated from Save so it isn't mistapped. */}
                                                                        {currentIsAdmin && (
                                                                            <button
                                                                                onClick={() => { deleteInvItem(catIdx, itemIdx); setInvEditingIdx(null); setInvEditTargetCatIdx(null); setInvEditSubcat(""); setInvEditLocation(""); }}
                                                                                className="w-full mt-2 bg-red-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-red-700">
                                                                                {language === "es" ? "🗑 Eliminar artículo" : "🗑 Delete item"}
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                ) : (
                                                                    <div className="flex items-center justify-between">
                                                                        <div className="flex-1 min-w-0 pr-2">
                                                                            <p className={`text-sm font-semibold ${count > 0 ? "text-green-800" : "text-gray-800"} truncate`}>
                                                                                {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                                            </p>
                                                                            {/* Compact mode: hide the alternate-language
                                                                                name + vendor/price metadata + Edit/Move
                                                                                buttons + Last-ordered badge. Just the
                                                                                primary name above + quantity controls
                                                                                on the right stay visible. Toggle is in
                                                                                the inventory toolbar (≣ Detailed / ≡
                                                                                Compact). Andrew 2026-05-17. */}
                                                                            {!invCompactView && (
                                                                            <>
                                                                            <div className="flex items-center gap-2 mt-0.5">
                                                                                {language === "es" && item.nameEs && <span className="text-xs text-gray-400 italic truncate">{item.name}</span>}
                                                                                {language !== "es" && item.nameEs && <span className="text-xs text-gray-400 italic truncate">{item.nameEs}</span>}
                                                                            </div>
                                                                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                                                                {/* Vendor preference: read-only label by default; the dropdown only
                                                                                    appears in inventory Edit mode (the ✏️ next to the print button).
                                                                                    Keeps the daily ordering view clean and prevents accidental changes. */}
                                                                                {(() => {
                                                                                    const opts = nonScrapedVendorOptions(item.vendorOptions);
                                                                                    if (opts.length > 1 && invEditMode) {
                                                                                        return (
                                                                                            <select
                                                                                                value={item.preferredVendor || item.vendor || ""}
                                                                                                onChange={(e) => changePreferredVendor(catIdx, itemIdx, e.target.value)}
                                                                                                className="text-xs bg-amber-50 border border-amber-300 rounded px-1 py-0.5 text-amber-800 font-medium focus:outline-none focus:border-amber-500 cursor-pointer"
                                                                                                title={language === "es" ? "Proveedor preferido" : "Preferred vendor"}>
                                                                                                {opts.map(vo => (
                                                                                                    <option key={vo.vendor} value={vo.vendor}>
                                                                                                        {getVendorOptionLabel(vo, item.id)}
                                                                                                    </option>
                                                                                                ))}
                                                                                            </select>
                                                                                        );
                                                                                    }
                                                                                    if (item.preferredVendor || item.vendor) {
                                                                                        return <span className="text-xs text-gray-500">{item.preferredVendor || item.vendor}</span>;
                                                                                    }
                                                                                    return null;
                                                                                })()}
                                                                                {renderLivePriceBadge(item.id, item)}
                                                                                {item.pack && <span className="text-xs text-gray-400">| {item.pack}</span>}
                                                                                {item.price != null && <span className="text-xs text-gray-400">| ${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
                                                                                <button onClick={() => {
                                                                                    setInvEditingIdx({catIdx, itemIdx});
                                                                                    setInvEditName(item.name);
                                                                                    setInvEditNameEs(item.nameEs || "");
                                                                                    setInvEditSupplier(item.vendor || item.supplier || "");
                                                                                    setInvEditOrderDay(item.orderDay || "");
                                                                                    setInvEditMin(item.min != null ? String(item.min) : "");
                                                                                    setInvEditTargetCatIdx(catIdx);
                                                                                    setInvEditSubcat(item.subcat || "");
                                                                                    setInvEditLocation(item.location || "");
                                                                                }} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">{"\u{270F}\u{FE0F}"} Edit</button>
                                                                                {/* Quick-move: tap to grab this item,
                                                                                    then tap any subcategory header on
                                                                                    the page to drop it there. Toggles
                                                                                    when tapped again on the same
                                                                                    item. Cancels any other in-progress
                                                                                    move automatically (one item at a
                                                                                    time). */}
                                                                                <button onClick={() => {
                                                                                    if (movingItem && movingItem.id === item.id) {
                                                                                        setMovingItem(null);
                                                                                    } else {
                                                                                        setMovingItem({
                                                                                            id: item.id,
                                                                                            name: item.name,
                                                                                            fromCatIdx: catIdx,
                                                                                            fromSubcat: item.subcat || '',
                                                                                        });
                                                                                    }
                                                                                }} className={`text-xs px-1.5 py-0.5 rounded font-medium transition ${
                                                                                    movingItem && movingItem.id === item.id
                                                                                        ? 'bg-amber-500 text-white animate-pulse'
                                                                                        : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                                                                                }`}
                                                                                    title={language === "es" ? "Mover a otra sub-categoría" : "Move to another subcategory"}>
                                                                                    {movingItem && movingItem.id === item.id
                                                                                        ? (language === "es" ? "✕ Cancelar" : "✕ Cancel")
                                                                                        : `${"\u{1F500}"} ${language === "es" ? "Mover" : "Move"}`}
                                                                                </button>
                                                                                {invEditMode && (
                                                                                    <>
                                                                                        <button onClick={() => moveItem(catIdx, itemIdx, -1)}
                                                                                            disabled={itemIdx === 0}
                                                                                            className={`text-xs w-6 h-6 rounded font-bold transition flex items-center justify-center ${itemIdx === 0 ? "bg-gray-100 text-gray-300 cursor-not-allowed" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
                                                                                            title={language === "es" ? "Mover arriba" : "Move up"}>
                                                                                            ↑
                                                                                        </button>
                                                                                        <button onClick={() => moveItem(catIdx, itemIdx, 1)}
                                                                                            disabled={itemIdx === category.items.length - 1}
                                                                                            className={`text-xs w-6 h-6 rounded font-bold transition flex items-center justify-center ${itemIdx === category.items.length - 1 ? "bg-gray-100 text-gray-300 cursor-not-allowed" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
                                                                                            title={language === "es" ? "Mover abajo" : "Move down"}>
                                                                                            ↓
                                                                                        </button>
                                                                                        <button onClick={() => {
                                                                                            setMergeSource({ catIdx, itemIdx, item });
                                                                                            setMergeSearchQuery("");
                                                                                            setMergeError(null);
                                                                                        }} className="text-xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-medium hover:bg-purple-100 transition"
                                                                                            title={language === "es" ? "Fusionar con otro artículo" : "Merge into another item"}>
                                                                                            ↔️ {language === "es" ? "Fusionar" : "Merge"}
                                                                                        </button>
                                                                                    </>
                                                                                )}
                                                                            </div>
                                                                            {invCountMeta[item.id] && count > 0 && (
                                                                                <p className="text-xs text-mint-600 mt-0.5">{"\u{2713}"} {invCountMeta[item.id].by} {"\u{2014}"} {invCountMeta[item.id].at}</p>
                                                                            )}
                                                                            {/* Low-stock indicator. Renders when:
                                                                                  • item has a `min` threshold set
                                                                                  • current count > 0 (so we don't double-
                                                                                    flag with the existing "out" badge)
                                                                                  • current count <= min
                                                                                Amber border + a "📉 Low" label so the
                                                                                manager sees AT A GLANCE which lines to
                                                                                refill before they hit zero. */}
                                                                            {item.min != null && item.min > 0 && count > 0 && count <= item.min && (
                                                                                <p className="text-[11px] text-amber-700 mt-0.5 inline-flex items-center gap-1 font-bold">
                                                                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                                                                    📉 {language === "es" ? `Bajo (mín ${item.min})` : `Low (min ${item.min})`}
                                                                                </p>
                                                                            )}
                                                                            {/* Per-item sync indicator — surfaces Firestore
                                                                                round-trip state so staff aren't guessing
                                                                                whether their tap stuck. Three states:
                                                                                  • saving (amber pulse) — currently writing
                                                                                  • saved  (green, 2s auto-clear) — confirmed
                                                                                  • error  (red, sticky) — Firestore rejected
                                                                                    or network failed; will stay visible
                                                                                    until the next successful save for
                                                                                    this item, so failed writes don't hide. */}
                                                                            {inventorySyncStatus[item.id] === 'saving' && (
                                                                                <p className="text-[11px] text-amber-700 mt-0.5 inline-flex items-center gap-1">
                                                                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                                                                                    {language === "es" ? "Guardando…" : "Saving…"}
                                                                                </p>
                                                                            )}
                                                                            {inventorySyncStatus[item.id] === 'saved' && (
                                                                                <p className="text-[11px] text-emerald-700 mt-0.5 inline-flex items-center gap-1">
                                                                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                                                                    {language === "es" ? "Guardado" : "Saved"}
                                                                                </p>
                                                                            )}
                                                                            {inventorySyncStatus[item.id] === 'error' && (
                                                                                <p className="text-[11px] text-red-700 mt-0.5 inline-flex items-center gap-1 font-bold">
                                                                                    <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                                                                                    {language === "es" ? "Error al guardar — toca de nuevo" : "Save failed — tap again"}
                                                                                </p>
                                                                            )}
                                                                            {/* Last ordered badge — read-only, sourced from
                                                                                inventoryHistory snapshots. Most recent date
                                                                                this item had qty > 0 in a saved snapshot.
                                                                                Updates automatically when a new snapshot is
                                                                                saved. */}
                                                                            {lastEnteredByItem[item.id] && (
                                                                                <p className="text-[11px] text-mint-700 mt-0.5">
                                                                                    📦 {language === "es" ? "Último pedido" : "Last ordered"}: {lastEnteredByItem[item.id].date} · <span className="font-bold tabular-nums">{lastEnteredByItem[item.id].qty}</span>
                                                                                </p>
                                                                            )}
                                                                            {/* Smart-order suggestion. Mean of the last
                                                                                up-to-6 non-zero order qtys from
                                                                                inventoryHistory. Tap "Use" to fill
                                                                                the count input with the suggested
                                                                                value — only shown when the current
                                                                                count differs from the suggestion
                                                                                (no point suggesting what's already
                                                                                there). Hidden in edit mode (the
                                                                                inputs above own the row) and when
                                                                                only 1 data point exists. */}
                                                                            {!isEditing && suggestedByItem[item.id] && suggestedByItem[item.id].avg !== count && (
                                                                                <p className="text-[11px] text-blue-700 mt-0.5 inline-flex items-center gap-1.5">
                                                                                    <span>📊</span>
                                                                                    <span>
                                                                                        {language === "es" ? "Sugerido" : "Suggested"}: <span className="font-bold tabular-nums">{suggestedByItem[item.id].avg}</span>
                                                                                        <span className="opacity-60"> (avg of {suggestedByItem[item.id].n})</span>
                                                                                    </span>
                                                                                    <button
                                                                                        onClick={() => updateInventoryCount(item.id, suggestedByItem[item.id].avg)}
                                                                                        className="ml-0.5 px-1.5 py-0 rounded bg-blue-100 hover:bg-blue-200 text-blue-800 font-bold text-[10px]">
                                                                                        {language === "es" ? "Usar" : "Use"}
                                                                                    </button>
                                                                                </p>
                                                                            )}
                                                                            </>
                                                                            )}
                                                                        </div>
                                                                        <div className="flex items-center gap-1 flex-shrink-0">
                                                                            <>
                                                                                <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1), -1)}
                                                                                    className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                                {/* Quantity input — tap-to-type. Andrew 2026-05-17
                                                                                    added inline numeric entry so staff can punch
                                                                                    in "24" instead of tapping + 24 times. Audit
                                                                                    2026-05-30 swapped the inline element for
                                                                                    <InventoryCountInput/> (module scope above)
                                                                                    so writes commit on blur / Enter instead of
                                                                                    on every keystroke — typing "100" used to
                                                                                    fire three Firestore transactions back-to-
                                                                                    back. The +/- buttons still commit on tap. */}
                                                                                <InventoryCountInput
                                                                                    value={count}
                                                                                    language={language}
                                                                                    onCommit={(n) => updateInventoryCount(item.id, n)}
                                                                                />
                                                                                <button onClick={() => updateInventoryCount(item.id, count + 1, +1)}
                                                                                    className="w-9 h-9 rounded-lg bg-green-100 text-green-700 font-bold text-lg flex items-center justify-center hover:bg-green-200 active:scale-95 transition">+</button>
                                                                            </>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ))}
                                            {/* Write-in — text in expands inline category +
                                                location pickers. Both must be set before
                                                Add is allowed; category defaults to this
                                                section, location must be picked. The
                                                location list comes from INVENTORY_LOCATIONS
                                                in inventory.js (union'd with any locations
                                                already present on items so previously-set
                                                custom locations stay reachable). */}
                                            {!invEditMode && (() => {
                                                const txt = writeInValues[catIdx] || "";
                                                const expanded = txt.trim().length > 0;
                                                const dest = writeInDest[catIdx] || { catIdx, location: '' };
                                                // Build location list = canonical + any non-canonical values
                                                // already in use across items.
                                                const seenLocs = new Set(INVENTORY_LOCATIONS);
                                                for (const c of customInventory) for (const it of (c.items || [])) {
                                                    if (it.location && !seenLocs.has(it.location)) seenLocs.add(it.location);
                                                }
                                                const locOpts = [...seenLocs];
                                                return (
                                                    <div className="px-3 py-2 bg-gray-50 space-y-2">
                                                        <div className="flex items-center gap-2">
                                                            <input type="text"
                                                                value={txt}
                                                                onChange={e => setWriteInValues(prev => ({ ...prev, [catIdx]: e.target.value }))}
                                                                onKeyDown={e => { if (e.key === "Enter") quickAddItem(catIdx); }}
                                                                placeholder={language === "es" ? "\u{270D}\u{FE0F} Escribir artículo..." : "\u{270D}\u{FE0F} Write in item..."}
                                                                className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:border-mint-500" />
                                                            {expanded && (
                                                                <button onClick={() => quickAddItem(catIdx)}
                                                                    disabled={!(dest.location || '').trim()}
                                                                    title={!(dest.location || '').trim() ? (language === "es" ? "Elige una ubicación primero" : "Pick a location first") : ""}
                                                                    className="px-3 py-1.5 bg-mint-600 text-white rounded-lg text-xs font-bold hover:bg-mint-700 active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed">
                                                                    {language === "es" ? "Agregar" : "Add"}
                                                                </button>
                                                            )}
                                                        </div>
                                                        {expanded && (
                                                            <div className="flex flex-wrap items-center gap-2 text-xs">
                                                                <label className="flex items-center gap-1.5">
                                                                    <span className="text-gray-500 font-bold">📂 {language === "es" ? "Categoría" : "Category"}:</span>
                                                                    <select
                                                                        value={Number.isFinite(dest.catIdx) ? dest.catIdx : catIdx}
                                                                        onChange={e => setWriteInDest(prev => ({ ...prev, [catIdx]: { ...(prev[catIdx] || {}), catIdx: Number(e.target.value) } }))}
                                                                        className="px-2 py-1 border border-gray-200 rounded-md bg-white text-xs focus:outline-none focus:border-mint-500">
                                                                        {customInventory.map((c, i) => (
                                                                            <option key={i} value={i}>{language === "es" ? (c.nameEs || c.name) : c.name}</option>
                                                                        ))}
                                                                    </select>
                                                                </label>
                                                                <label className="flex items-center gap-1.5">
                                                                    <span className="text-gray-500 font-bold">📍 {language === "es" ? "Ubicación" : "Location"}:</span>
                                                                    <select
                                                                        value={dest.location || ''}
                                                                        onChange={e => setWriteInDest(prev => ({ ...prev, [catIdx]: { ...(prev[catIdx] || {}), location: e.target.value } }))}
                                                                        className={`px-2 py-1 border rounded-md bg-white text-xs focus:outline-none focus:border-mint-500 ${(dest.location || '').trim() ? 'border-gray-200' : 'border-amber-400 bg-amber-50'}`}>
                                                                        <option value="">{language === "es" ? "(elige una)" : "(pick one)"}</option>
                                                                        {locOpts.map(l => (
                                                                            <option key={l} value={l}>{locationLabel(l, language === 'es')}</option>
                                                                        ))}
                                                                    </select>
                                                                </label>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })()}
                                            {invEditMode && invShowAddForm === catIdx ? (
                                                <div className="p-3 bg-green-50 border-t-2 border-green-500 space-y-2">
                                                    <input type="text" value={invNewName} onChange={(e) => setInvNewName(e.target.value)}
                                                        placeholder={language === "es" ? "Nombre del artículo" : "New item name"} className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                    <input type="text" value={invNewNameEs} onChange={(e) => setInvNewNameEs(e.target.value)}
                                                        placeholder={language === "es" ? "Nombre en español" : "Name in Spanish"} className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                    <div className="flex gap-2">
                                                        <input type="text" value={invNewSupplier} onChange={(e) => setInvNewSupplier(e.target.value)}
                                                            placeholder={language === "es" ? "Proveedor" : "Vendor"} className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                        <input type="text" value={invNewOrderDay} onChange={(e) => setInvNewOrderDay(e.target.value)}
                                                            placeholder={language === "es" ? "Día" : "Order day"} className="w-24 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <button onClick={() => addInvItem(catIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Agregar" : "Add"}</button>
                                                        <button onClick={() => setInvShowAddForm(null)} className="flex-1 bg-gray-400 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-gray-500">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                    </div>
                                                </div>
                                            ) : invEditMode && (
                                                <button onClick={() => setInvShowAddForm(catIdx)} className="w-full py-2 text-green-600 font-bold text-sm bg-green-50 hover:bg-green-100 border-t border-green-200 transition">
                                                    + {language === "es" ? "Agregar Artículo" : "Add Item"}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ); })}

                            {/* ── UNMATCHED VENDOR ITEMS — Master List view only ──
                                Shows Sysco/USFoods items that don't have a master inventory match
                                yet. Each row gets a quantity counter (lets you order without first
                                matching) and an inline "Match to master" pencil that opens the
                                existing audit modal. */}
                            {invViewMode === "category" && unmatchedVendorItems.length > 0 && !invEditMode && (() => {
                                const searchLower = (invSearchDeferred || "").toLowerCase().trim();
                                let visible = unmatchedVendorItems;
                                if (searchLower) {
                                    visible = visible.filter(it =>
                                        (it.name || "").toLowerCase().includes(searchLower) ||
                                        (it.brand || "").toLowerCase().includes(searchLower) ||
                                        (it.vendorId || "").toLowerCase().includes(searchLower));
                                }
                                if (invShowOnlyCounted) {
                                    visible = visible.filter(it => (vendorCounts[`${it.vendor === "Sysco" ? "sysco" : "usfoods"}:${it.vendorId}`] || 0) > 0);
                                }
                                if (visible.length === 0) return null;
                                const collapseKey = "unmatched_vendor_items";
                                const isCollapsed = collapsedCats[collapseKey] && !searchLower;
                                const countedHere = unmatchedVendorItems.filter(it => (vendorCounts[`${it.vendor === "Sysco" ? "sysco" : "usfoods"}:${it.vendorId}`] || 0) > 0).length;
                                return (
                                    <div className="bg-white rounded-xl border-2 border-orange-200 overflow-hidden shadow-sm">
                                        <button onClick={() => toggleCatCollapse(collapseKey)}
                                            className="w-full p-3 bg-gradient-to-r from-orange-500 to-orange-400 flex justify-between items-center">
                                            <div className="flex items-center gap-2">
                                                <span className="text-white text-sm font-bold">⚠️ {language === "es" ? "Artículos de proveedor sin coincidencia" : "Vendor items not in master list"}</span>
                                                <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{visible.length}</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {countedHere > 0 && <span className="bg-white text-orange-700 text-xs font-bold px-2 py-0.5 rounded-full">{countedHere} ✓</span>}
                                                <span className="text-white text-xs">{isCollapsed ? "▶" : "▼"}</span>
                                            </div>
                                        </button>
                                        {!isCollapsed && (
                                            <div className="divide-y divide-orange-100">
                                                {visible.map((it) => {
                                                    const vKey = `${it.vendor === "Sysco" ? "sysco" : "usfoods"}:${it.vendorId}`;
                                                    const count = vendorCounts[vKey] || 0;
                                                    const vendorBadgeClass = it.vendor === "Sysco" ? "bg-blue-100 text-blue-700 border-blue-300" : "bg-orange-100 text-orange-800 border-orange-300";
                                                    return (
                                                        <div key={vKey} className={`px-3 py-2 ${count > 0 ? "bg-orange-50/60" : "bg-orange-50/20"}`}>
                                                            <div className="flex items-center justify-between gap-2">
                                                                <div className="flex-1 min-w-0">
                                                                    <div className="flex items-center gap-1.5 flex-wrap">
                                                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${vendorBadgeClass}`}>{it.vendor}</span>
                                                                        <span className="text-sm font-semibold text-gray-800 truncate">{it.name}</span>
                                                                    </div>
                                                                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                                                        {it.price != null && <span className="text-xs font-bold text-gray-700">${typeof it.price === "number" ? it.price.toFixed(2) : it.price}{it.unit ? ` ${it.unit}` : ""}</span>}
                                                                        {it.pack && <span className="text-[11px] text-gray-500">{it.pack}</span>}
                                                                        {it.brand && <span className="text-[11px] text-gray-500 italic">{it.brand}</span>}
                                                                        <span className="text-[11px] text-gray-400">#{it.vendorId}</span>
                                                                    </div>
                                                                </div>
                                                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                                                    <input type="number" inputMode="numeric" min="0" value={count || ""}
                                                                        onChange={(e) => updateVendorCount(it.vendor === "Sysco" ? "sysco" : "usfoods", it.vendorId, e.target.value)}
                                                                        placeholder="0"
                                                                        className="w-12 px-2 py-1 border border-orange-300 rounded text-center text-sm font-bold focus:outline-none focus:border-orange-500" />
                                                                    {currentIsAdmin && (
                                                                        <button onClick={() => { setMatchEditor({ vendor: it.vendor === "Sysco" ? "sysco" : "usfoods", vendorId: it.vendorId, vendorName: it.name, currentInvId: null, matchType: it.matchType }); setMatchSearchQuery(""); }}
                                                                            className="px-2 py-1 rounded-md bg-purple-600 text-white text-[10px] font-bold hover:bg-purple-700"
                                                                            title={language === "es" ? "Vincular a artículo maestro" : "Match to master item"}>
                                                                            ✏️
                                                                        </button>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}

                            {/* ── LOCATION VIEW ──────────────────────────
                                Same items, regrouped by storage location.
                                Use case (Andrew 2026-05-29): counting walks
                                through the kitchen physically — walk-in,
                                pantry, expo, etc. — and category sorting
                                (proteins/veggies/dairy) doesn't help. This
                                view stacks every counted item under the
                                location header it lives in, so the staffer
                                can stand in front of the walk-in and count
                                everything there before moving on.

                                Streamlined cell content: name + count
                                input + chevron + / -. No edit, no vendor
                                selector, no price badge — those workflows
                                stay in Master List. */}
                            {invViewMode === "location" && (() => {
                                const searchLower = (invSearchDeferred || "").toLowerCase().trim();
                                // Flatten every item across categories.
                                // Preserve a name-only badge so the user
                                // can still see what kind of item it is.
                                const allItems = [];
                                for (const cat of customInventory) {
                                    for (const it of (cat.items || [])) {
                                        allItems.push({ it, catName: cat.name });
                                    }
                                }
                                // Apply the same filters the Master List does.
                                const filtered = allItems.filter(({ it }) => {
                                    if (searchLower && !itemMatchesSearchAi(it, searchLower)) return false;
                                    if (invShowOnlyCounted && !((inventory[it.id] || 0) > 0)) return false;
                                    if (invShowOnlyLow) {
                                        const min = Number(it?.min);
                                        if (!Number.isFinite(min) || min <= 0) return false;
                                        const c = Number(inventory[it.id] || 0);
                                        if (!(c > 0 && c <= min)) return false;
                                    }
                                    return true;
                                });
                                // Group by location. Items without one go
                                // to a special bucket that sorts last so
                                // they're easy to spot and fix.
                                const UNASSIGNED = '(no location set)';
                                const byLoc = new Map();
                                for (const row of filtered) {
                                    const key = (row.it.location || '').trim() || UNASSIGNED;
                                    if (!byLoc.has(key)) byLoc.set(key, []);
                                    byLoc.get(key).push(row);
                                }
                                // Order: canonical INVENTORY_LOCATIONS first
                                // (in their declared order), then any non-
                                // canonical custom locations alphabetically,
                                // then UNASSIGNED at the bottom.
                                const canonical = INVENTORY_LOCATIONS.filter(l => byLoc.has(l));
                                const customLocs = [...byLoc.keys()]
                                    .filter(l => l !== UNASSIGNED && !INVENTORY_LOCATIONS.includes(l))
                                    .sort();
                                const orderedLocs = [...canonical, ...customLocs];
                                if (byLoc.has(UNASSIGNED)) orderedLocs.push(UNASSIGNED);
                                if (orderedLocs.length === 0) {
                                    return (
                                        <div className="p-8 text-center text-gray-400 text-sm italic bg-white border-2 border-dashed border-gray-200 rounded-xl">
                                            {language === "es"
                                                ? "Sin artículos para mostrar. Ajusta los filtros o agrega artículos en Lista Maestra."
                                                : "No items to show. Adjust filters or add items in Master List."}
                                        </div>
                                    );
                                }
                                return orderedLocs.map(loc => {
                                    const rows = byLoc.get(loc) || [];
                                    const countedInLoc = rows.reduce(
                                        (n, { it }) => n + ((inventory[it.id] || 0) > 0 ? 1 : 0), 0);
                                    const isUnassigned = loc === UNASSIGNED;
                                    return (
                                        <div key={loc} className="bg-white border-2 border-gray-200 rounded-xl overflow-hidden mb-3">
                                            <div className={`flex items-center justify-between px-3 py-2 ${
                                                isUnassigned ? 'bg-amber-50 border-b-2 border-amber-200' : 'bg-mint-50 border-b-2 border-mint-200'
                                            }`}>
                                                <div className="flex items-center gap-2">
                                                    <span className={`text-sm font-black uppercase tracking-wide ${
                                                        isUnassigned ? 'text-amber-800' : 'text-mint-800'
                                                    }`}>
                                                        {isUnassigned
                                                            ? (language === "es" ? '⚠ Sin ubicación' : '⚠ No location')
                                                            : `📍 ${locationLabel(loc, language === 'es')}`}
                                                    </span>
                                                    <span className="text-[10px] text-gray-500 font-bold">
                                                        {rows.length} {language === "es" ? "artíc." : "items"}
                                                        {countedInLoc > 0 && ` · ${countedInLoc} ${language === "es" ? "contados" : "counted"}`}
                                                    </span>
                                                </div>
                                                {isUnassigned && (
                                                    <span className="text-[10px] text-amber-700 italic">
                                                        {language === "es"
                                                            ? "Edita en Lista Maestra para asignar"
                                                            : "Edit in Master List to assign"}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="divide-y divide-gray-200">
                                                {rows.map(({ it: item, catName }) => (
                                                    <LocationItemRow
                                                        key={item.id}
                                                        id={item.id}
                                                        name={language === "es" && item.nameEs ? item.nameEs : item.name}
                                                        catName={catName}
                                                        subcat={item.subcat || ''}
                                                        pack={item.pack || ''}
                                                        count={inventory[item.id] || 0}
                                                        language={language}
                                                        onUpdate={stableUpdateInventoryCount}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    );
                                });
                            })()}

                            {/* ── VENDOR VIEW ── */}
                            {invViewMode === "vendor" && (() => {
                                // FIX (review 2026-05-14, perf): iterate with
                                // the array's own index instead of doing an
                                // O(n) cat.items.indexOf(item) lookup per
                                // item (overall O(n²) per render).
                                const vendorGroups = {};
                                const searchLower = (invSearchDeferred || "").toLowerCase().trim();
                                customInventory.forEach((cat, catIdx) => {
                                    cat.items.forEach((item, iIdx) => {
                                        const v = item.vendor || item.supplier || "Other";
                                        if (!vendorGroups[v]) vendorGroups[v] = [];
                                        const matchesCounted = !invShowOnlyCounted || (inventory[item.id] || 0) > 0;
                                        if (itemMatchesSearchAi(item, searchLower) && matchesCounted) {
                                            vendorGroups[v].push({ ...item, catIdx, itemIdx: iIdx, catName: cat.name, catNameEs: cat.nameEs });
                                        }
                                    });
                                });
                                const vendorNames = Object.keys(vendorGroups).filter(v => vendorGroups[v].length > 0).sort((a, b) => vendorGroups[b].length - vendorGroups[a].length);
                                return vendorNames.map(vendor => {
                                    const vItems = vendorGroups[vendor].sort((a, b) => a.name.localeCompare(b.name));
                                    const vKey = "ven-" + vendor;
                                    const isCollapsed = collapsedCats[vKey] && !invSearch;
                                    const countedInV = vItems.filter(i => (inventory[i.id] || 0) > 0).length;
                                    return (
                                        <div key={vendor} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                                            <button onClick={() => toggleCatCollapse(vKey)}
                                                className="w-full p-3 bg-gradient-to-r from-blue-700 to-blue-600 flex justify-between items-center">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-white text-sm font-bold">{vendor}</span>
                                                    <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{vItems.length}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {countedInV > 0 && <span className="bg-white text-blue-700 text-xs font-bold px-2 py-0.5 rounded-full">{countedInV} {"\u{2713}"}</span>}
                                                    <span className="text-white text-xs">{isCollapsed ? "\u{25B6}" : "\u{25BC}"}</span>
                                                </div>
                                            </button>
                                            {!isCollapsed && (
                                                <div className="divide-y divide-gray-100">
                                                    {vItems.map(item => {
                                                        const count = inventory[item.id] || 0;
                                                        const isEditing = invEditingIdx && invEditingIdx.catIdx === item.catIdx && invEditingIdx.itemIdx === item.itemIdx;
                                                        return (
                                                            <div key={item.id} className={`px-3 py-2 ${count > 0 ? "bg-green-50/50" : ""} ${isEditing ? "bg-blue-50 border-l-4 border-blue-500" : ""}`}>
                                                                {isEditing ? (
                                                                    <div className="space-y-2">
                                                                        <input type="text" value={invEditName} onChange={(e) => setInvEditName(e.target.value)}
                                                                            placeholder="Item name" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        <input type="text" value={invEditNameEs} onChange={(e) => setInvEditNameEs(e.target.value)}
                                                                            placeholder="Nombre en español" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        <div className="flex gap-2">
                                                                            <input type="text" value={invEditSupplier} onChange={(e) => setInvEditSupplier(e.target.value)}
                                                                                placeholder={language === "es" ? "Proveedor" : "Vendor"} className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                            <input type="text" value={invEditOrderDay} onChange={(e) => setInvEditOrderDay(e.target.value)}
                                                                                placeholder={language === "es" ? "Día" : "Order day"} className="w-24 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        </div>
                                                                        <div className="flex gap-2">
                                                                            <button onClick={() => saveInvEdit(item.catIdx, item.itemIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Guardar" : "Save"}</button>
                                                                            <button onClick={() => setInvEditingIdx(null)} className="flex-1 bg-gray-400 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-gray-500">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                <div className="flex items-center justify-between">
                                                                    <div className="flex-1 min-w-0 pr-2">
                                                                        <p className={`text-sm font-semibold ${count > 0 ? "text-green-800" : "text-gray-800"} truncate`}>
                                                                            {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                                        </p>
                                                                        <div className="flex items-center gap-2 mt-0.5">
                                                                            {language === "es" && item.nameEs && <span className="text-xs text-gray-400 italic truncate">{item.name}</span>}
                                                                            {language !== "es" && item.nameEs && <span className="text-xs text-gray-400 italic truncate">{item.nameEs}</span>}
                                                                        </div>
                                                                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                                                            <span className="text-xs text-blue-600 font-medium">{language === "es" ? item.catNameEs : item.catName}</span>
                                                                            {(() => {
                                                                                const opts = nonScrapedVendorOptions(item.vendorOptions);
                                                                                if (opts.length > 1) {
                                                                                    return (
                                                                                        <select
                                                                                            value={item.preferredVendor || item.vendor || ""}
                                                                                            onChange={(e) => changePreferredVendor(item.catIdx, item.itemIdx, e.target.value)}
                                                                                            className="text-xs bg-amber-50 border border-amber-300 rounded px-1 py-0.5 text-amber-800 font-medium focus:outline-none focus:border-amber-500 cursor-pointer"
                                                                                            title={language === "es" ? "Proveedor preferido" : "Preferred vendor"}>
                                                                                            {opts.map(vo => (
                                                                                                <option key={vo.vendor} value={vo.vendor}>
                                                                                                    {getVendorOptionLabel(vo, item.id)}
                                                                                                </option>
                                                                                            ))}
                                                                                        </select>
                                                                                    );
                                                                                }
                                                                                if (item.preferredVendor || item.vendor) {
                                                                                    return <span className="text-xs text-gray-500">{item.preferredVendor || item.vendor}</span>;
                                                                                }
                                                                                return null;
                                                                            })()}
                                                                            {renderLivePriceBadge(item.id, item)}
                                                                            {item.pack && <span className="text-xs text-gray-400">| {item.pack}</span>}
                                                                            {item.price != null && <span className="text-xs text-gray-400">| ${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
                                                                            <button onClick={() => {
                                                                                setInvEditingIdx({catIdx: item.catIdx, itemIdx: item.itemIdx});
                                                                                setInvEditName(item.name);
                                                                                setInvEditNameEs(item.nameEs || "");
                                                                                setInvEditSupplier(item.vendor || item.supplier || "");
                                                                                setInvEditOrderDay(item.orderDay || "");
                                                                                setInvEditTargetCatIdx(item.catIdx);
                                                                                setInvEditSubcat(item.subcat || "");
                                                                                setInvEditLocation(item.location || "");
                                                                            }} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">{"\u{270F}\u{FE0F}"} Edit</button>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-1 flex-shrink-0">
                                                                        <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1), -1)}
                                                                            className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                        <span className={`w-10 text-center font-bold text-lg ${count > 0 ? "text-green-700" : "text-gray-300"}`}>{count}</span>
                                                                        <button onClick={() => updateInventoryCount(item.id, count + 1, +1)}
                                                                            className="w-9 h-9 rounded-lg bg-green-100 text-green-700 font-bold text-lg flex items-center justify-center hover:bg-green-200 active:scale-95 transition">+</button>
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
                                });
                            })()}

                            {/* ── SPLIT VIEW ── */}
                            {invViewMode === "split" && (() => {
                                const SPLIT_LISTS = [
                                    { name: "Lorena", nameEs: "Lorena", emoji: "\u{2744}\u{FE0F}", color: "from-cyan-700 to-cyan-600", label: language === "es" ? "Congelador y Refrigerador" : "Freezer & Cooler", categories: ["Proteins", "Produce", "Dairy & Eggs", "Frozen"] },
                                    { name: "Yuly", nameEs: "Yuly", emoji: "\u{1F4E6}", color: "from-amber-600 to-amber-500", label: language === "es" ? "Seco, Papel y Salsas" : "Dry, Paper & Sauces", categories: ["Sauces & Seasonings", "Rice & Noodles", "Oils & Cooking", "Paper & Supplies", "Cleaning"] },
                                    { name: "Brandon", nameEs: "Brandon", emoji: "\u{1F964}", color: "from-green-700 to-green-600", label: language === "es" ? "Bebidas" : "Beverages", categories: ["Beverages"] }
                                ];
                                const searchLower = invSearchDeferred.toLowerCase().trim();

                                // Build item assignments: default by category, then apply overrides
                                const getPersonForItem = (item, defaultPerson) => {
                                    if (splitOverrides[item.id]) return splitOverrides[item.id];
                                    return defaultPerson;
                                };

                                // Collect all items per person (including moved items from other people)
                                const personItems = {};
                                SPLIT_LISTS.forEach(p => { personItems[p.name] = []; });

                                customInventory.forEach((cat, cIdx) => {
                                    // Find the default person for this category
                                    const defaultPerson = SPLIT_LISTS.find(p => p.categories.includes(cat.name));
                                    if (!defaultPerson) return;
                                    cat.items.forEach((item, iIdx) => {
                                        const assignedTo = getPersonForItem(item, defaultPerson.name);
                                        if (personItems[assignedTo]) {
                                            personItems[assignedTo].push({ ...item, catName: cat.name, catNameEs: cat.nameEs, catIdx: cIdx, itemIdx: iIdx });
                                        } else {
                                            // If override points to non-existent person, keep with default
                                            personItems[defaultPerson.name].push({ ...item, catName: cat.name, catNameEs: cat.nameEs, catIdx: cIdx, itemIdx: iIdx });
                                        }
                                    });
                                });

                                return SPLIT_LISTS.map((person, pIdx) => {
                                    const allItems = personItems[person.name] || [];
                                    // Group items by category for display
                                    const catGroups = {};
                                    allItems.forEach(item => {
                                        const key = item.catName;
                                        if (!catGroups[key]) catGroups[key] = { name: item.catName, nameEs: item.catNameEs, items: [] };
                                        catGroups[key].items.push(item);
                                    });
                                    const catList = Object.values(catGroups);

                                    let totalCounted = 0;
                                    let totalItems = allItems.length;
                                    allItems.forEach(item => { if ((inventory[item.id] || 0) > 0) totalCounted++; });

                                    // Include write-ins in total
                                    const writeIns = splitWriteIns[person.name] || [];
                                    totalItems += writeIns.length;
                                    writeIns.forEach(wi => { if (wi.count > 0) totalCounted++; });

                                    const pKey = "split-" + pIdx;
                                    const isCollapsed = collapsedCats[pKey] && !searchLower;
                                    return (
                                        <div key={pIdx} className="bg-white rounded-xl border-2 border-gray-200 overflow-hidden shadow-sm">
                                            <button onClick={() => toggleCatCollapse(pKey)}
                                                className={`w-full p-3 bg-gradient-to-r ${person.color} flex justify-between items-center`}>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-lg">{person.emoji}</span>
                                                    <div className="text-left">
                                                        <span className="text-white font-bold text-base">{person.name}</span>
                                                        <span className="text-white/70 text-xs ml-2">{person.label}</span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {totalCounted > 0 && <span className="bg-white text-gray-700 text-xs font-bold px-2 py-0.5 rounded-full">{totalCounted}/{totalItems}</span>}
                                                    <span className="text-white text-xs">{isCollapsed ? "\u{25B6}" : "\u{25BC}"}</span>
                                                </div>
                                            </button>
                                            {!isCollapsed && (<>
                                                {catList.map((category, catIdx) => {
                                                    let filteredItems = searchLower
                                                        ? category.items.filter(item => itemMatchesSearchAi(item, searchLower))
                                                        : category.items;
                                                    if (invShowOnlyCounted) filteredItems = filteredItems.filter(item => (inventory[item.id] || 0) > 0);
                                                    if (invShowOnlyLow) {
                                                        filteredItems = filteredItems.filter(item => {
                                                            const min = Number(item?.min);
                                                            if (!Number.isFinite(min) || min <= 0) return false;
                                                            const c = Number(inventory[item.id] || 0);
                                                            return c > 0 && c <= min;
                                                        });
                                                    }
                                                    if (filteredItems.length === 0) return null;
                                                    const countedInCat = category.items.filter(i => (inventory[i.id] || 0) > 0).length;
                                                    return (
                                                        <div key={catIdx}>
                                                            <div className="px-3 py-1.5 bg-gray-50 border-y border-gray-100 flex justify-between items-center">
                                                                <span className="text-xs font-bold text-gray-500 uppercase">{language === "es" ? category.nameEs : category.name}</span>
                                                                {countedInCat > 0 && <span className="text-xs text-mint-700 font-bold">{countedInCat} {"\u{2713}"}</span>}
                                                            </div>
                                                            <div className="divide-y divide-gray-200">
                                                                {filteredItems.map((item) => {
                                                                    const count = inventory[item.id] || 0;
                                                                    const isMoving = splitMovingItem && splitMovingItem.itemId === item.id;
                                                                    const wasMoved = !!splitOverrides[item.id];
                                                                    const isEditing = invEditingIdx && invEditingIdx.catIdx === item.catIdx && invEditingIdx.itemIdx === item.itemIdx;
                                                                    return (
                                                                        <div key={item.id} className={`px-3 py-2 ${count > 0 ? "bg-green-50/50" : ""} ${isEditing ? "bg-blue-50 border-l-4 border-blue-500" : ""}`}>
                                                                            {isEditing ? (
                                                                                <div className="space-y-2">
                                                                                    <input type="text" value={invEditName} onChange={(e) => setInvEditName(e.target.value)}
                                                                                        placeholder="Item name" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                                    <input type="text" value={invEditNameEs} onChange={(e) => setInvEditNameEs(e.target.value)}
                                                                                        placeholder="Nombre en español" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                                    <div className="flex gap-2">
                                                                                        <input type="text" value={invEditSupplier} onChange={(e) => setInvEditSupplier(e.target.value)}
                                                                                            placeholder={language === "es" ? "Proveedor" : "Vendor"} className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                                        <input type="text" value={invEditOrderDay} onChange={(e) => setInvEditOrderDay(e.target.value)}
                                                                                            placeholder={language === "es" ? "Día" : "Order day"} className="w-24 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                                    </div>
                                                                                    <div className="flex gap-2">
                                                                                        <button onClick={() => saveInvEdit(item.catIdx, item.itemIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Guardar" : "Save"}</button>
                                                                                        <button onClick={() => setInvEditingIdx(null)} className="flex-1 bg-gray-400 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-gray-500">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                                                    </div>
                                                                                </div>
                                                                            ) : (
                                                                            <div className="flex items-center justify-between">
                                                                                <div className="flex-1 min-w-0 pr-2">
                                                                                    <div className="flex items-center gap-1">
                                                                                        <p className={`text-sm font-semibold ${count > 0 ? "text-green-800" : "text-gray-800"} truncate`}>
                                                                                            {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                                                        </p>
                                                                                        {wasMoved && <span className="text-xs bg-purple-100 text-purple-600 px-1 rounded">{"\u{21C4}"}</span>}
                                                                                    </div>
                                                                                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                                                                        {(() => {
                                                                                            const opts = nonScrapedVendorOptions(item.vendorOptions);
                                                                                            if (opts.length > 1) {
                                                                                                return (
                                                                                                    <select
                                                                                                        value={item.preferredVendor || item.vendor || ""}
                                                                                                        onChange={(e) => changePreferredVendor(item.catIdx, item.itemIdx, e.target.value)}
                                                                                                        className="text-xs bg-amber-50 border border-amber-300 rounded px-1 py-0.5 text-amber-800 font-medium focus:outline-none focus:border-amber-500 cursor-pointer"
                                                                                                        title={language === "es" ? "Proveedor preferido" : "Preferred vendor"}>
                                                                                                        {opts.map(vo => (
                                                                                                            <option key={vo.vendor} value={vo.vendor}>
                                                                                                                {getVendorOptionLabel(vo, item.id)}
                                                                                                            </option>
                                                                                                        ))}
                                                                                                    </select>
                                                                                                );
                                                                                            }
                                                                                            if (item.preferredVendor || item.vendor) {
                                                                                                return <span className="text-xs text-blue-600 font-medium">{item.preferredVendor || item.vendor}</span>;
                                                                                            }
                                                                                            return null;
                                                                                        })()}
                                                                                        {renderLivePriceBadge(item.id, item)}
                                                                                        {item.pack && <span className="text-xs text-gray-400">| {item.pack}</span>}
                                                                                        {item.price != null && <span className="text-xs text-gray-400">| ${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
                                                                                        <button onClick={() => setSplitMovingItem(isMoving ? null : { itemId: item.id, fromPerson: person.name })}
                                                                                            className={`text-xs px-1.5 py-0.5 rounded font-medium transition ${isMoving ? "bg-purple-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>
                                                                                            {isMoving ? "\u{2715}" : "\u{21C4}"} {language === "es" ? "Mover" : "Move"}
                                                                                        </button>
                                                                                        <button onClick={() => {
                                                                                            setInvEditingIdx({catIdx: item.catIdx, itemIdx: item.itemIdx});
                                                                                            setInvEditName(item.name);
                                                                                            setInvEditNameEs(item.nameEs || "");
                                                                                            setInvEditSupplier(item.vendor || item.supplier || "");
                                                                                            setInvEditOrderDay(item.orderDay || "");
                                                                                            setInvEditTargetCatIdx(item.catIdx);
                                                                                            setInvEditSubcat(item.subcat || "");
                                                                                        }} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">{"\u{270F}\u{FE0F}"} Edit</button>
                                                                                    </div>
                                                                                    {isMoving && (
                                                                                        <div className="flex gap-1 mt-1">
                                                                                            {SPLIT_LISTS.filter(p => p.name !== person.name).map(p => (
                                                                                                <button key={p.name} onClick={() => moveSplitItem(item.id, p.name)}
                                                                                                    className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded-lg font-bold hover:bg-purple-200 active:scale-95 transition">
                                                                                                    {p.emoji} {p.name}
                                                                                                </button>
                                                                                            ))}
                                                                                            {wasMoved && (
                                                                                                <button onClick={() => { const updated = { ...splitOverrides }; delete updated[item.id]; setSplitOverrides(updated); saveSplitConfig({ overrides: updated }); setSplitMovingItem(null); }}
                                                                                                    className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-lg font-bold hover:bg-gray-200 active:scale-95 transition">
                                                                                                    {"\u{21A9}"} {language === "es" ? "Original" : "Reset"}
                                                                                                </button>
                                                                                            )}
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                                <div className="flex items-center gap-1 flex-shrink-0">
                                                                                    <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1), -1)}
                                                                                        className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                                    <span className={`w-10 text-center font-bold text-lg ${count > 0 ? "text-green-700" : "text-gray-300"}`}>{count}</span>
                                                                                    <button onClick={() => updateInventoryCount(item.id, count + 1, +1)}
                                                                                        className="w-9 h-9 rounded-lg bg-green-100 text-green-700 font-bold text-lg flex items-center justify-center hover:bg-green-200 active:scale-95 transition">+</button>
                                                                                </div>
                                                                            </div>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                                {/* Write-in items for this person */}
                                                {writeIns.length > 0 && (
                                                    <div>
                                                        <div className="px-3 py-1.5 bg-yellow-50 border-y border-yellow-200 flex justify-between items-center">
                                                            <span className="text-xs font-bold text-yellow-700 uppercase">{"\u{270D}\u{FE0F}"} {language === "es" ? "Artículos Escritos" : "Write-In Items"}</span>
                                                        </div>
                                                        <div className="divide-y divide-gray-100">
                                                            {writeIns.map(wi => (
                                                                <div key={wi.id} className={`px-3 py-2 ${wi.count > 0 ? "bg-yellow-50/50" : ""}`}>
                                                                    <div className="flex items-center justify-between">
                                                                        <div className="flex-1 min-w-0 pr-2">
                                                                            <p className={`text-sm font-semibold ${wi.count > 0 ? "text-yellow-800" : "text-gray-800"}`}>{wi.name}</p>
                                                                        </div>
                                                                        <div className="flex items-center gap-1 flex-shrink-0">
                                                                            <button onClick={() => updateSplitWriteInCount(person.name, wi.id, Math.max(0, wi.count - 1))}
                                                                                className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${wi.count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                            <span className={`w-10 text-center font-bold text-lg ${wi.count > 0 ? "text-yellow-700" : "text-gray-300"}`}>{wi.count}</span>
                                                                            <button onClick={() => updateSplitWriteInCount(person.name, wi.id, wi.count + 1)}
                                                                                className="w-9 h-9 rounded-lg bg-green-100 text-green-700 font-bold text-lg flex items-center justify-center hover:bg-green-200 active:scale-95 transition">+</button>
                                                                            <button onClick={() => removeSplitWriteIn(person.name, wi.id)}
                                                                                className="w-7 h-7 rounded-lg bg-red-50 text-red-400 font-bold text-sm flex items-center justify-center hover:bg-red-100 ml-1">{"\u{2715}"}</button>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                {/* Write-in input */}
                                                <div className="px-3 py-2 bg-gray-50 border-t border-gray-200">
                                                    <div className="flex items-center gap-2">
                                                        <input type="text"
                                                            value={splitWriteInValues[person.name] || ""}
                                                            onChange={e => setSplitWriteInValues(prev => ({ ...prev, [person.name]: e.target.value }))}
                                                            onKeyDown={e => { if (e.key === "Enter") addSplitWriteIn(person.name); }}
                                                            placeholder={language === "es" ? `\u{270D}\u{FE0F} Escribir para ${person.name}...` : `\u{270D}\u{FE0F} Write in for ${person.name}...`}
                                                            className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:border-mint-500" />
                                                        {(splitWriteInValues[person.name] || "").trim() && (
                                                            <button onClick={() => addSplitWriteIn(person.name)}
                                                                className="px-3 py-1.5 bg-mint-600 text-white rounded-lg text-xs font-bold hover:bg-mint-700 active:scale-95 transition">
                                                                {language === "es" ? "Agregar" : "Add"}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            </>)}
                                        </div>
                                    );
                                });
                            })()}

                            {/* ── PRICING VIEW ── */}
                            {invViewMode === "pricing" && (
                                <PricingWorkspace
                                    language={language}
                                    isAdmin={currentIsAdmin}
                                    storeLocation={storeLocation}
                                    staffName={staffName}
                                    masterCategories={customInventory}
                                    itemPrices={itemPrices}
                                    onOpenImport={() => setShowCsvImport(true)}
                                />
                            )}

                            {/* ── SAVE & RESET ──
                                Moved off `sticky bottom-20` per Andrew (2026-05-12):
                                the sticky button was covering inventory items as
                                you scrolled, which was annoying mid-count. Now
                                it sits in-flow below the list — scroll to the
                                bottom to save. Still distinct visually (large
                                mint button, rounded). */}
                            {!invEditMode && invViewMode !== "pricing" && (
                                <div className="mt-6 pt-3">
                                    {showSaveConfirm ? (
                                        <div className="bg-white border-2 border-mint-700 rounded-xl p-4 shadow-xl">
                                            <p className="text-center text-lg font-bold text-gray-800 mb-4">
                                                {language === "es" ? "\u{00BF}Ya REVISASTE?" : "Did you LOOK?"}
                                            </p>
                                            <div className="flex gap-3">
                                                <button onClick={saveAndResetInventory} disabled={inventorySaving}
                                                    className="flex-1 py-3 rounded-xl font-bold text-lg bg-mint-700 text-white hover:bg-mint-800 active:scale-95 transition">
                                                    {inventorySaving ? (language === "es" ? "Guardando..." : "Saving...") : (language === "es" ? "\u{2705} S\u{00ED}" : "\u{2705} Yes")}
                                                </button>
                                                <button onClick={() => setShowSaveConfirm(false)} disabled={inventorySaving}
                                                    className="flex-1 py-3 rounded-xl font-bold text-lg bg-gray-200 text-gray-700 hover:bg-gray-300 transition">
                                                    {language === "es" ? "Cancelar" : "Cancel"}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <button onClick={() => setShowSaveConfirm(true)}
                                            className="w-full py-4 rounded-xl font-bold text-lg shadow-lg bg-mint-700 text-white hover:bg-mint-800 active:scale-95 transition">
                                            {language === "es" ? "\u{1F4BE} Guardar y Reiniciar Conteos" : "\u{1F4BE} Save & Reset Counts"}
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* ── INVENTORY CHANGE AUDIT ──
                                Every +/- count change is recorded with who/when.
                                Use case Andrew flagged 2026-05-12: with many
                                hands on inventory, individual tweaks were hard
                                to reconstruct ("why weren't eggs ordered when
                                someone said it was on the list?"). This panel
                                shows the last 50 changes for this location.
                                Append-only at the rules level (see firestore.rules). */}
                            {!invEditMode && invViewMode !== "pricing" && (
                                <div className="mt-4">
                                    <button onClick={() => setShowInventoryAudits(!showInventoryAudits)}
                                        className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 hover:bg-blue-100 transition">
                                        <span className="flex items-center gap-2 text-sm font-bold text-blue-800">
                                            📜 {language === "es" ? "Cambios recientes" : "Recent changes"}
                                            <span className="text-xs font-bold text-blue-600">({inventoryAudits.length})</span>
                                        </span>
                                        <span className="text-blue-700 text-xs">{showInventoryAudits ? "▼" : "▶"}</span>
                                    </button>
                                    {showInventoryAudits && (
                                        <div className="mt-2 bg-white border border-blue-200 rounded-xl overflow-hidden max-h-96 overflow-y-auto">
                                            {inventoryAudits.length === 0 ? (
                                                <p className="text-center text-gray-400 text-xs py-6">
                                                    {language === "es" ? "Sin cambios todavía." : "No changes yet."}
                                                </p>
                                            ) : (
                                                <table className="w-full text-xs">
                                                    <thead className="bg-blue-50 sticky top-0">
                                                        <tr className="text-left text-[10px] uppercase font-bold text-blue-900">
                                                            <th className="px-2 py-1.5">{language === "es" ? "Cuándo" : "When"}</th>
                                                            <th className="px-2 py-1.5">{language === "es" ? "Artículo" : "Item"}</th>
                                                            <th className="px-2 py-1.5 text-right">{language === "es" ? "Cambio" : "Change"}</th>
                                                            <th className="px-2 py-1.5">{language === "es" ? "Por" : "By"}</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {inventoryAudits.map(a => {
                                                            const at = a.at && typeof a.at.toDate === 'function' ? a.at.toDate() : null;
                                                            const whenStr = at
                                                                ? `${at.toLocaleDateString()} ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                                                                : (a.atLocal || '—');
                                                            const deltaSign = a.delta > 0 ? '+' : '';
                                                            const deltaCls = a.delta > 0 ? 'text-green-700 font-bold'
                                                                : a.delta < 0 ? 'text-red-700 font-bold'
                                                                : 'text-gray-500';
                                                            return (
                                                                <tr key={a.id} className="border-t border-blue-50 hover:bg-blue-50/50">
                                                                    <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">{whenStr}</td>
                                                                    <td className="px-2 py-1.5 text-gray-800 font-semibold">{a.itemName || a.itemId}</td>
                                                                    <td className={"px-2 py-1.5 text-right tabular-nums " + deltaCls}>
                                                                        {a.previous} → {a.next} ({deltaSign}{a.delta})
                                                                    </td>
                                                                    <td className="px-2 py-1.5 text-gray-700">{a.byStaff || '—'}</td>
                                                                </tr>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ── VENDOR CHANGE LOG ── */}
                            {vendorChangeLog.length > 0 && (
                                <div className="mt-4">
                                    <button onClick={() => setShowVendorLog(!showVendorLog)}
                                        className="flex items-center gap-2 text-sm font-bold text-amber-700 hover:text-amber-800">
                                        <span>{"\u{1F4DD}"}</span>
                                        <span>{language === "es" ? "Cambios de Proveedor" : "Vendor Changes"} ({vendorChangeLog.length})</span>
                                        <span className="text-xs">{showVendorLog ? "\u{25BC}" : "\u{25B6}"}</span>
                                    </button>
                                    {showVendorLog && (
                                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
                                            {vendorChangeLog.slice(0, 20).map((entry, i) => (
                                                <div key={i} className="px-3 py-2 border-b border-amber-100 last:border-0">
                                                    <p className="text-xs font-semibold text-gray-800">{entry.itemName}</p>
                                                    <p className="text-xs text-gray-600">
                                                        <span className="text-red-500 line-through">{entry.from}</span>
                                                        <span className="mx-1">{"\u{2192}"}</span>
                                                        <span className="text-green-700 font-bold">{entry.to}</span>
                                                    </p>
                                                    <p className="text-xs text-gray-400">{entry.changedBy} {"\u{2014}"} {entry.dateStr}</p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ── SAVED LISTS ── collapsed by default; tap
                                the header to expand. Keeps the heavy
                                InventoryHistory chunk off the first paint
                                of the inventory page. */}
                            <div className="mt-6 pt-4 border-t-2 border-gray-200">
                                <button
                                    type="button"
                                    onClick={() => setShowSavedLists(v => !v)}
                                    aria-expanded={showSavedLists}
                                    className="w-full flex items-center justify-between gap-2 text-left -mx-1 px-1 py-1 rounded-lg hover:bg-gray-50 transition"
                                >
                                    <div className="flex-1 min-w-0">
                                        <h3 className="text-lg font-bold text-mint-700">
                                            {"\u{1F4E6}"} {language === "es" ? "Listas Guardadas" : "Saved Lists"}
                                        </h3>
                                        {!showSavedLists && (
                                            <p className="text-xs text-gray-500 mt-0.5">
                                                {language === "es"
                                                    ? "Toca para ver conteos anteriores."
                                                    : "Tap to see past counts."}
                                            </p>
                                        )}
                                    </div>
                                    <span className="text-gray-400 text-lg leading-none flex-shrink-0" aria-hidden="true">
                                        {showSavedLists ? "\u{25BE}" : "\u{25B8}"}
                                    </span>
                                </button>
                                {showSavedLists && (
                                    <>
                                        <p className="text-xs text-gray-500 mb-3 mt-1">{language === "es"
                                            ? "Revisa conteos anteriores, marca lo que ya se pidió."
                                            : "Review past counts, check off what's been ordered."}</p>
                                        <Suspense fallback={<div className="h-32 bg-white rounded-xl border border-dd-line animate-pulse" />}>
                                            <InventoryHistory language={language} customInventory={customInventory} storeLocation={storeLocation} />
                                        </Suspense>
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === "breaks" && (
                        <div className="space-y-4">
                            {/* Side toggle — FOH vs. BOH break planning.
                                Each side has its own stations, plan doc,
                                and staff candidate pool. Defaults to BOH
                                (pre-2026-05-25 behavior). */}
                            <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
                                <button
                                    onClick={() => setBreakSide('BOH')}
                                    className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${breakSide === 'BOH'
                                        ? 'bg-orange-500 text-white shadow-sm'
                                        : 'text-gray-600 hover:bg-white'}`}>
                                    🍳 {language === 'es' ? 'Cocina (BOH)' : 'Kitchen (BOH)'}
                                </button>
                                <button
                                    onClick={() => setBreakSide('FOH')}
                                    className={`flex-1 py-2 rounded-lg text-sm font-bold transition ${breakSide === 'FOH'
                                        ? 'bg-dd-green text-white shadow-sm'
                                        : 'text-gray-600 hover:bg-white'}`}>
                                    🤝 {language === 'es' ? 'Frente (FOH)' : 'Front (FOH)'}
                                </button>
                            </div>

                            {/* Date picker */}
                            <div className="flex items-center gap-2">
                                <button onClick={() => setBreakDate(addDaysKey(breakDate, -1))}
                                    className="w-9 h-9 rounded-lg bg-gray-200 text-gray-600 font-bold text-lg flex items-center justify-center hover:bg-gray-300">{"\u{2190}"}</button>
                                <div className="flex-1 text-center">
                                    <input type="date" value={breakDate} onChange={e => setBreakDate(e.target.value)}
                                        className="bg-transparent text-center font-bold text-gray-800 border-none text-sm focus:outline-none" />
                                    <div className="text-xs text-gray-500">
                                        {(() => {
                                            const today = getTodayKey();
                                            if (breakDate === today) return language === "es" ? "\u{1F4C5} Hoy" : "\u{1F4C5} Today";
                                            if (breakDate === addDaysKey(today, 1)) return language === "es" ? "\u{1F4C5} Mañana" : "\u{1F4C5} Tomorrow";
                                            const d = new Date(breakDate + "T12:00:00");
                                            return d.toLocaleDateString(language === "es" ? "es-US" : "en-US", { weekday: "long" });
                                        })()}
                                    </div>
                                </div>
                                <button onClick={() => setBreakDate(addDaysKey(breakDate, 1))}
                                    className="w-9 h-9 rounded-lg bg-gray-200 text-gray-600 font-bold text-lg flex items-center justify-center hover:bg-gray-300">{"\u{2192}"}</button>
                                {breakDate !== getTodayKey() && (
                                    <button onClick={() => setBreakDate(getTodayKey())}
                                        className="text-xs font-bold text-mint-700 bg-mint-50 border border-mint-200 px-2 py-1 rounded-lg">
                                        {language === "es" ? "Hoy" : "Today"}
                                    </button>
                                )}
                            </div>

                            <div className="flex items-center justify-between">
                                <p className="text-sm text-gray-600">
                                    {language === "es" ? "Asigna estaciones y planifica los breaks" : "Assign stations & plan breaks"}
                                </p>
                                <div className="flex gap-2">
                                    <button onClick={() => setShowMatrix(!showMatrix)} className={`text-xs underline ${showMatrix ? "text-mint-700 font-bold" : "text-blue-500"}`}>
                                        {showMatrix ? (language === "es" ? "Ocultar matriz" : "Hide matrix") : (language === "es" ? "Matriz de habilidades" : "Skills matrix")}
                                    </button>
                                    <button onClick={clearBreakPlan} className="text-xs text-red-500 underline">
                                        {language === "es" ? "Borrar todo" : "Clear all"}
                                    </button>
                                </div>
                            </div>
                            {breakPlanSaved && (
                                <div className="bg-green-100 border border-green-300 text-green-700 text-sm rounded-lg px-3 py-2 text-center font-bold">
                                    {language === "es" ? "\u{2713} Guardado" : "\u{2713} Saved"}
                                </div>
                            )}

                            {/* Copy from another day */}
                            {breakDate !== getTodayKey() && Object.keys(breakPlan.stations || {}).length === 0 && (
                                <button onClick={async () => {
                                    // Side-suffixed key (2026-05-25). For BOH, fall back to
                                    // the pre-side-split key if the new one is empty.
                                    let todayDocSnap = await getDoc(doc(db, "ops", "breakPlan_" + storeLocation + "_" + breakSide + "_" + getTodayKey()));
                                    if (!todayDocSnap.exists() && breakSide === 'BOH') {
                                        todayDocSnap = await getDoc(doc(db, "ops", "breakPlan_" + storeLocation + "_" + getTodayKey()));
                                    }
                                    if (todayDocSnap.exists() && todayDocSnap.data().plan) {
                                        const plan = todayDocSnap.data().plan;
                                        const times = todayDocSnap.data().waveTimes || DEFAULT_BREAK_WAVES.map(w => w.time);
                                        setBreakPlan(plan);
                                        setBreakWaveTimes(times);
                                        saveBreakPlan(plan, times);
                                    } else {
                                        toast(language === "es" ? "No hay plan para hoy" : "No plan for today to copy");
                                    }
                                }}
                                    className="w-full py-2.5 rounded-xl font-bold text-sm bg-blue-50 text-blue-600 border-2 border-blue-200 hover:bg-blue-100 transition">
                                    {"\u{1F4CB}"} {language === "es" ? "Copiar plan de hoy" : "Copy today's plan"}
                                </button>
                            )}

                            {/* {"\u{2500}"}{"\u{2500}"} SKILLS MATRIX {"\u{2500}"}{"\u{2500}"} */}
                            {showMatrix && (
                                <div className="bg-white border-2 border-purple-200 rounded-xl overflow-hidden">
                                    <div className="bg-purple-600 text-white px-4 py-2.5">
                                        <h3 className="font-bold text-sm">{language === "es" ? "\u{1F9E0} Matriz de Habilidades" : "\u{1F9E0} Skills Matrix"}</h3>
                                        <p className="text-xs text-purple-200">{language === "es" ? "Marca qué estaciones puede trabajar cada persona" : "Check which stations each person can work"}</p>
                                    </div>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-xs">
                                            <thead>
                                                <tr className="bg-purple-50">
                                                    <th className="text-left px-3 py-2 font-bold text-gray-700 sticky left-0 bg-purple-50 z-10 min-w-[100px]">
                                                        {language === "es" ? "Nombre" : "Name"}
                                                    </th>
                                                    {SKILL_STATIONS.map(s => (
                                                        <th key={s.id} className="px-1 py-2 text-center font-bold text-gray-600 min-w-[40px]">
                                                            <div className="text-base">{s.emoji}</div>
                                                            <div className="text-[9px] leading-tight">{s.nameEn}</div>
                                                        </th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {breakStaff.map((staff, idx) => (
                                                    <tr key={staff.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                                        <td className={`px-3 py-1.5 font-bold text-gray-800 sticky left-0 z-10 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                                                            {staff.name.split(" ")[0]}
                                                        </td>
                                                        {SKILL_STATIONS.map(s => {
                                                            const checked = !!skillsMatrix[staff.name + "_" + s.id];
                                                            return (
                                                                <td key={s.id} className="px-1 py-1.5 text-center">
                                                                    <button
                                                                        onClick={() => toggleSkill(staff.name, s.id)}
                                                                        className={`w-7 h-7 rounded-md text-sm font-bold transition ${
                                                                            checked
                                                                                ? "bg-mint-600 text-white"
                                                                                : "bg-gray-100 text-gray-300 hover:bg-gray-200"
                                                                        }`}
                                                                    >
                                                                        {checked ? "\u{2713}" : ""}
                                                                    </button>
                                                                </td>
                                                            );
                                                        })}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    {/* Quick stats */}
                                    <div className="px-4 py-2 bg-purple-50 border-t border-purple-200 flex flex-wrap gap-3">
                                        {SKILL_STATIONS.map(s => {
                                            const count = breakStaff.filter(st => skillsMatrix[st.name + "_" + s.id]).length;
                                            return (
                                                <span key={s.id} className={`text-xs font-bold ${count === 0 ? "text-red-500" : count <= 2 ? "text-orange-500" : "text-gray-500"}`}>
                                                    {s.emoji} {count}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* {"\u{2500}"}{"\u{2500}"} STATION BOARD {"\u{2500}"}{"\u{2500}"} */}
                            <div className="bg-charcoal rounded-xl p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-white font-bold text-sm uppercase tracking-wider">
                                        {language === "es" ? "\u{1F4CB} Estaciones de Hoy" : "\u{1F4CB} Today's Stations"}
                                    </h3>
                                    {currentIsAdmin && (
                                        <button onClick={() => setEditingStations(!editingStations)}
                                            className={`text-xs px-2.5 py-1 rounded-full font-bold ${editingStations ? "bg-red-500 text-white" : "bg-white bg-opacity-20 text-white"}`}>
                                            {editingStations ? (language === "es" ? "\u{2715} Cerrar" : "\u{2715} Done") : (language === "es" ? "\u{270F}\u{FE0F} Editar" : "\u{270F}\u{FE0F} Edit")}
                                        </button>
                                    )}
                                </div>

                                {/* {"\u{2500}"}{"\u{2500}"} EDIT MODE {"\u{2500}"}{"\u{2500}"} */}
                                {editingStations && currentIsAdmin && (
                                    <div className="mb-3 space-y-2">
                                        {customStations.map((pos, idx) => (
                                            <div key={pos.id} className="bg-white bg-opacity-10 rounded-lg p-2 flex items-center gap-2">
                                                <div className="flex flex-col gap-0.5">
                                                    <button onClick={() => moveStation(pos.id, -1)} disabled={idx === 0}
                                                        className={`text-xs leading-none ${idx === 0 ? "text-gray-600" : "text-gray-300 hover:text-white"}`}>{"\u{25B2}"}</button>
                                                    <button onClick={() => moveStation(pos.id, 1)} disabled={idx === customStations.length - 1}
                                                        className={`text-xs leading-none ${idx === customStations.length - 1 ? "text-gray-600" : "text-gray-300 hover:text-white"}`}>{"\u{25BC}"}</button>
                                                </div>
                                                <input type="text" value={pos.emoji} onChange={e => updateStationEmoji(pos.id, e.target.value)}
                                                    className="w-10 text-center text-lg bg-white bg-opacity-10 rounded border border-gray-600 text-white" style={{padding: "2px"}} />
                                                <input type="text" value={pos.nameEn} onChange={e => renameStation(pos.id, e.target.value)}
                                                    className="flex-1 bg-white bg-opacity-10 rounded border border-gray-600 text-white text-xs px-2 py-1.5 font-bold" />
                                                <button onClick={() => removeStation(pos.id)}
                                                    className="text-red-400 hover:text-red-300 text-sm font-bold px-1">{"\u{2715}"}</button>
                                            </div>
                                        ))}
                                        {/* Add new station */}
                                        <div className="bg-white bg-opacity-5 rounded-lg p-2 flex items-center gap-2 border border-dashed border-gray-600">
                                            <input type="text" value={newStationEmoji} onChange={e => setNewStationEmoji(e.target.value)}
                                                className="w-10 text-center text-lg bg-white bg-opacity-10 rounded border border-gray-600 text-white" style={{padding: "2px"}}
                                                placeholder="\u{1F4CD}" />
                                            <input type="text" value={newStationName} onChange={e => setNewStationName(e.target.value)}
                                                className="flex-1 bg-white bg-opacity-10 rounded border border-gray-600 text-white text-xs px-2 py-1.5"
                                                placeholder={language === "es" ? "Nueva estación..." : "New station name..."}
                                                onKeyDown={e => { if (e.key === "Enter") addStation(); }} />
                                            <button onClick={addStation}
                                                className="bg-mint text-white text-xs font-bold px-3 py-1.5 rounded hover:opacity-90">+</button>
                                        </div>
                                        {/* Reset to defaults */}
                                        <button onClick={resetStationsToDefault}
                                            className="text-xs text-gray-400 hover:text-gray-200 underline mt-1">
                                            {language === "es" ? "Restaurar predeterminados" : "Reset to defaults"}
                                        </button>
                                    </div>
                                )}

                                {/* {"\u{2500}"}{"\u{2500}"} ASSIGNMENT GRID {"\u{2500}"}{"\u{2500}"} */}
                                <div className="grid grid-cols-2 gap-2">
                                    {ALL_POSITIONS.map(pos => {
                                        const person = breakPlan.stations?.[pos.id] || "";
                                        return (
                                            <div key={pos.id} className="bg-white rounded-lg p-2.5">
                                                <div className="flex items-center gap-1.5 mb-1.5">
                                                    <span className="text-lg">{pos.emoji}</span>
                                                    <span className="font-bold text-xs text-charcoal">{language === "es" ? pos.nameEs : pos.nameEn}</span>
                                                </div>
                                                <select
                                                    className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs bg-gray-50"
                                                    value={person}
                                                    onChange={e => updateStationAssignment(pos.id, e.target.value)}
                                                >
                                                    <option value="">{"\u{2014}"}</option>
                                                    {(pos.id === "manager"
                                                        ? (staffList || []).filter(s => (
                                                            breakSide === 'FOH'
                                                                ? ["Manager", "Owner", "Shift Lead"].includes(s.role)
                                                                : ["Kitchen Manager", "Asst Kitchen Manager", "Manager", "Shift Lead"].includes(s.role)
                                                          ) && (s.location === storeLocation || s.location === "both"))
                                                        : breakStaff
                                                      ).map(s => (
                                                        <option key={s.id} value={s.name}>{s.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Who's working today summary */}
                                {(() => {
                                    const assigned = getAssignedStaff();
                                    if (assigned.length === 0) return null;
                                    return (
                                        <div className="mt-3 pt-3 border-t border-gray-600">
                                            <p className="text-xs text-gray-400 mb-1">{language === "es" ? "Trabajando hoy" : "Working today"}: <span className="text-white font-bold">{assigned.length}</span></p>
                                            <p className="text-xs text-gray-300">{assigned.map(n => n.split(" ")[0]).join(", ")}</p>
                                        </div>
                                    );
                                })()}
                            </div>

                            {/* {"\u{2500}"}{"\u{2500}"} BREAK WAVES {"\u{2500}"}{"\u{2500}"} */}
                            {BREAK_WAVES.map((wave, waveIdx) => {
                                const assignedStaff = getAssignedStaff();
                                const breakers = getWaveBreakers(wave.id);
                                const available = getAvailableCovers(wave.id);
                                const needCover = getPositionsNeedingCover(wave.id);
                                const staffMap = getStaffPositionMap();

                                // People who already went on break in earlier waves
                                const alreadyBroke = new Set();
                                BREAK_WAVES.slice(0, waveIdx).forEach(prev => {
                                    getWaveBreakers(prev.id).forEach(n => alreadyBroke.add(n));
                                });

                                // Build cover assignment counts for warnings
                                const coverCounts = {};
                                needCover.forEach(nc => {
                                    const c = nc.cover;
                                    if (c) {
                                        if (!coverCounts[c]) coverCounts[c] = [];
                                        coverCounts[c].push(language === "es" ? nc.pos.nameEs : nc.pos.nameEn);
                                    }
                                });
                                const doubles = Object.entries(coverCounts).filter(([_, s]) => s.length > 1);
                                const uncovered = needCover.filter(nc => !nc.cover);

                                return (
                                    <div key={wave.id} className="bg-white border-2 border-blue-200 rounded-xl overflow-hidden">
                                        <div className="bg-blue-600 text-white px-4 py-2.5 flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <h3 className="font-bold text-sm">{language === "es" ? `Grupo ${waveIdx+1}` : `Wave ${waveIdx+1}`} {"\u{2014}"}</h3>
                                                <input type="time" value={breakWaveTimes[waveIdx] || wave.time}
                                                    onChange={e => updateWaveTime(waveIdx, e.target.value)}
                                                    className="bg-blue-500 text-white border border-blue-400 rounded px-1.5 py-0.5 text-sm font-bold" style={{colorScheme:"dark"}} />
                                            </div>
                                            <span className="text-xs bg-blue-500 px-2 py-0.5 rounded-full">
                                                {breakers.length} {language === "es" ? "en break" : "on break"}
                                            </span>
                                        </div>

                                        <div className="p-3">
                                            {assignedStaff.length === 0 ? (
                                                <p className="text-center text-gray-400 text-sm py-4">
                                                    {language === "es" ? "Asigna estaciones primero" : "Assign stations first"}
                                                </p>
                                            ) : (
                                                <div>
                                                    {/* {"\u{2500}"} Who's going on break? \u{2500} */}
                                                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">
                                                        {language === "es" ? "¿Quién sale a break?" : "Who's going on break?"}
                                                    </p>
                                                    <div className="flex flex-wrap gap-1.5 mb-3">
                                                        {assignedStaff.map(name => {
                                                            const onBreak = breakers.includes(name);
                                                            const alreadyWent = alreadyBroke.has(name);
                                                            const positions = (staffMap[name] || []).map(p => p.emoji).join("");
                                                            if (alreadyWent && !onBreak) {
                                                                // Already took break in earlier wave {"\u{2014}"} show grayed out
                                                                return (
                                                                    <span key={name}
                                                                        className="px-2.5 py-1.5 rounded-full text-xs font-bold border-2 bg-gray-100 text-gray-300 border-gray-100 line-through"
                                                                        title={language === "es" ? "Ya tomó break" : "Already took break"}
                                                                    >
                                                                        {positions} {name.split(" ")[0]}
                                                                    </span>
                                                                );
                                                            }
                                                            return (
                                                                <button key={name}
                                                                    onClick={() => toggleBreaker(wave.id, name)}
                                                                    className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition border-2 ${
                                                                        onBreak
                                                                            ? "bg-orange-500 text-white border-orange-500"
                                                                            : "bg-white text-gray-700 border-gray-200 hover:border-orange-300"
                                                                    }`}
                                                                >
                                                                    {positions} {name.split(" ")[0]}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>

                                                    {/* {"\u{2500}"} Coverage map {"\u{2500}"} */}
                                                    {needCover.length > 0 && (
                                                        <div>
                                                            <p className="text-xs font-bold text-mint-700 uppercase tracking-wide mb-2">
                                                                {language === "es" ? "Cobertura necesaria" : "Coverage needed"}
                                                            </p>
                                                            <div className="space-y-2">
                                                                {needCover.map(nc => (
                                                                    <div key={nc.pos.id} className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg p-2">
                                                                        <span className="text-lg">{nc.pos.emoji}</span>
                                                                        <div className="flex-1 min-w-0">
                                                                            <div className="text-xs">
                                                                                <span className="font-bold text-gray-500">{language === "es" ? nc.pos.nameEs : nc.pos.nameEn}</span>
                                                                                <span className="text-orange-500 ml-1">({nc.person.split(" ")[0]} {language === "es" ? "en break" : "on break"})</span>
                                                                            </div>
                                                                            <select
                                                                                className={`w-full mt-1 border rounded px-2 py-1.5 text-xs font-bold ${nc.cover ? "border-mint-400 bg-mint-50 text-mint-800" : "border-red-300 bg-red-50 text-red-700"}`}
                                                                                value={nc.cover}
                                                                                onChange={e => setWaveCover(wave.id, nc.pos.id, e.target.value)}
                                                                            >
                                                                                <option value="">{language === "es" ? "\u{26A0}\u{FE0F} Seleccionar cobertura..." : "\u{26A0}\u{FE0F} Select cover..."}</option>
                                                                                {(() => {
                                                                                    const qualified = getQualifiedCovers(nc.pos.id, available, wave.id);
                                                                                    const unqualified = available.filter(n => !qualified.includes(n));
                                                                                    return [
                                                                                        ...qualified.map(n => (
                                                                                            <option key={n} value={n}>{"\u{2713}"} {n} {(staffMap[n] || []).map(p => p.emoji).join("")}</option>
                                                                                        )),
                                                                                        unqualified.length > 0 && qualified.length > 0 ? <option key="_sep" disabled>{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}</option> : null,
                                                                                        ...unqualified.map(n => (
                                                                                            <option key={n} value={n} style={{color:"#999"}}>{n}</option>
                                                                                        ))
                                                                                    ];
                                                                                })()}
                                                                            </select>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* {"\u{2500}"} Still working (not on break) {"\u{2500}"} */}
                                                    {breakers.length > 0 && available.length > 0 && (
                                                        <div className="mt-3 pt-2 border-t border-gray-200">
                                                            <p className="text-xs font-bold text-gray-400 mb-1">
                                                                {language === "es" ? "Trabajando" : "Still working"}: {available.map(n => {
                                                                    const positions = (staffMap[n] || []).map(p => p.emoji).join("");
                                                                    return positions + " " + n.split(" ")[0];
                                                                }).join(", ")}
                                                            </p>
                                                        </div>
                                                    )}

                                                    {/* {"\u{2500}"} Warnings {"\u{2500}"} */}
                                                    {(uncovered.length > 0 || doubles.length > 0) && (
                                                        <div className="mt-2 space-y-1">
                                                            {uncovered.length > 0 && (
                                                                <div className="text-xs text-red-600 font-bold bg-red-50 rounded px-2 py-1">
                                                                    {"\u{26A0}"}{"\u{FE0F}"} {language === "es" ? "Sin cubrir" : "Uncovered"}: {uncovered.map(nc => (language === "es" ? nc.pos.nameEs : nc.pos.nameEn)).join(", ")}
                                                                </div>
                                                            )}
                                                            {doubles.map(([name, stations]) => (
                                                                <div key={name} className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1">
                                                                    {"\u{26A0}"}{"\u{FE0F}"} <span className="font-bold">{name.split(" ")[0]}</span> {language === "es" ? "cubre" : "covers"} {stations.join(" + ")}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                            {/* {"\u{2500}"}{"\u{2500}"} PRINT BUTTON {"\u{2500}"}{"\u{2500}"} */}
                            {(() => {
                                const assigned = getAssignedStaff();
                                if (assigned.length === 0) return null;
                                return (
                                    <button onClick={() => {
                                        // FIX (review 2026-05-14, real): escape staff/position names
                                        // before interpolating into the print HTML. `today` comes from
                                        // Date.toLocaleDateString so it's safe, but person names and
                                        // wave-cover names are admin-editable strings.
                                        const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
                                        const staffMap = getStaffPositionMap();
                                        let html = `<html><head><title>Break Plan - ${escH(today)}</title><style>
                                            * { margin: 0; padding: 0; box-sizing: border-box; }
                                            body { font-family: Arial, sans-serif; padding: 20px; max-width: 700px; margin: 0 auto; }
                                            h1 { font-size: 22px; text-align: center; margin-bottom: 2px; }
                                            .date { text-align: center; color: #666; font-size: 13px; margin-bottom: 16px; }
                                            .section { border: 2px solid #333; border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
                                            .section-header { background: #333; color: white; padding: 6px 12px; font-weight: bold; font-size: 14px; }
                                            .station-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
                                            .station { padding: 6px 12px; border-bottom: 1px solid #ddd; border-right: 1px solid #ddd; font-size: 13px; }
                                            .station:nth-child(even) { border-right: none; }
                                            .station-name { font-weight: bold; color: #333; font-size: 11px; text-transform: uppercase; }
                                            .station-person { color: #000; font-size: 14px; margin-top: 1px; }
                                            .wave { margin-bottom: 12px; }
                                            .wave-header { background: #2563eb; color: white; padding: 6px 12px; font-weight: bold; font-size: 14px; }
                                            .wave-body { padding: 8px 12px; }
                                            .wave-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid #eee; font-size: 13px; }
                                            .wave-row:last-child { border-bottom: none; }
                                            .breakers { font-weight: bold; color: #ea580c; }
                                            .cover-label { color: #666; font-size: 11px; }
                                            .cover-name { font-weight: bold; color: #15803d; }
                                            .working { color: #666; font-size: 12px; margin-top: 6px; }
                                            .no-print { position:sticky;top:0;z-index:1000;background:#2563eb;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3) }
                                            .no-print button { padding: 12px 24px; font-size: 16px; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; margin: 0 6px; }
                                            .btn-print { background: white; color: #2563eb; } .btn-close { background: #ff4444; color: white; }
                                            @media print { body { padding: 10px; } .no-print { display: none !important; } }
                                        </style></head><body>`;
                                        html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://app.ddmaustl.com/'}},300)">✕ Close</button><button class="btn-print" onclick="window.print()">🖨️ Print</button></div>`;
                                        html += `<h1>\u{1F35C} DD Mau Break Plan</h1><div class="date">${escH(today)}</div>`;

                                        // Stations
                                        html += `<div class="section"><div class="section-header">\u{1F4CB} Today's Stations</div><div class="station-grid">`;
                                        ALL_POSITIONS.forEach(pos => {
                                            const person = breakPlan.stations?.[pos.id] || "\u{2014}";
                                            html += `<div class="station"><div class="station-name">${pos.emoji} ${escH(pos.nameEn)}</div><div class="station-person">${escH(person)}</div></div>`;
                                        });
                                        html += `</div></div>`;

                                        // Break waves
                                        BREAK_WAVES.forEach((wave, waveIdx) => {
                                            const breakers = getWaveBreakers(wave.id);
                                            const available = getAvailableCovers(wave.id);
                                            const needCover = getPositionsNeedingCover(wave.id);
                                            html += `<div class="section"><div class="wave-header">${escH(wave.nameEn)}</div><div class="wave-body">`;
                                            if (breakers.length > 0) {
                                                html += `<div style="margin-bottom:6px"><span class="breakers">On break: ${escH(breakers.map(n => n.split(" ")[0]).join(", "))}</span></div>`;
                                                needCover.forEach(nc => {
                                                    const coverName = nc.cover ? nc.cover.split(" ")[0] : "\u{26A0}\u{FE0F} UNCOVERED";
                                                    html += `<div class="wave-row"><span>${nc.pos.emoji} ${escH(nc.pos.nameEn)} <span class="cover-label">(${escH(nc.person.split(" ")[0])} on break)</span></span><span class="cover-name">\u{2192} ${escH(coverName)}</span></div>`;
                                                });
                                                if (available.length > 0) {
                                                    html += `<div class="working">Still working: ${escH(available.map(n => { const positions = (staffMap[n] || []).map(p => p.emoji).join(""); return positions + " " + n.split(" ")[0]; }).join(", "))}</div>`;
                                                }
                                            } else {
                                                html += `<div style="color:#999;font-size:13px">No breaks assigned</div>`;
                                            }
                                            html += `</div></div>`;
                                        });

                                        html += `</body></html>`;
                                        if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Break Plan'); return; }
                                        const printWindow = window.open("", "_blank");
                                        if (!printWindow) {
                                            toast(language === "es" ? "Por favor permita ventanas emergentes para imprimir." : "Please allow pop-ups to print.");
                                            return;
                                        }
                                        printWindow.document.write(html);
                                        printWindow.document.close();
                                        printWindow.focus();
                                        setTimeout(() => printWindow.print(), 300);
                                    }}
                                        className="w-full mt-4 py-3 rounded-xl font-bold text-sm bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition flex items-center justify-center gap-2">
                                        {"\u{1F5A8}"}{"\u{FE0F}"} {language === "es" ? "Imprimir Plan de Breaks" : "Print Break Plan"}
                                    </button>
                                );
                            })()}
                        </div>
                    )}

                    {activeTab === "prep" && (
                        <Suspense fallback={<div className="h-32 bg-white rounded-xl border border-dd-line animate-pulse" />}>
                            <PrepBoard
                                language={language}
                                staffName={staffName}
                                storeLocation={storeLocation}
                                staffList={staffList}
                            />
                        </Suspense>
                    )}
                </div>
            );
        }

// Tiny helper for the "Other" skip-reason path — captures a free-text note.
function SkipOtherInput({ onSubmit, isEs }) {
    const [v, setV] = useState("");
    return (
        <div className="mt-1 p-2 bg-amber-50 rounded-lg border border-amber-200 flex gap-1">
            <input type="text" value={v} onChange={e => setV(e.target.value)}
                placeholder={isEs ? "Anota la razón..." : "Note the reason..."}
                className="flex-1 px-2 py-1 border border-amber-300 rounded text-xs" autoFocus />
            <button onClick={() => v.trim() && onSubmit(v.trim())}
                disabled={!v.trim()}
                className={`px-3 py-1 rounded text-xs font-bold ${v.trim() ? "bg-amber-600 text-white" : "bg-gray-200 text-gray-400"}`}>
                {isEs ? "Guardar" : "Save"}
            </button>
        </div>
    );
}

        // NOTE: MenuReference, Schedule, useGeofence, RecipeForm live in their own files
        // (imported by App.jsx). Duplicate definitions removed to save ~490 lines.

// ─────────────────────────────────────────────────────────────────
// RecentOrdersBar — sits where the old PricesFreshnessBanner did,
// at the top of the inventory cart view. Andrew 2026-05-23: the
// freshness banner wasn't getting much use; the real workflow ask
// was "show me my last few orders and let me re-add one to the
// cart so I can edit + resend."
//
// Each row shows ONE past order (from inventoryHistory_<location>):
//   May 22 · 14 items · qty 47    [↩ Send to cart]
//
// Clicking "Send to cart" copies that order's counts into the
// current cart (state + Firestore). If the cart already has items,
// asks for confirmation before overwriting. Manual additions on
// top of the restored order are encouraged — admin can adjust qtys
// or add brand-new items before sending the order back out.
//
// Why we REPLACE rather than additively merge: the typical use case
// is "make a copy of last week's order and tweak it," not "stack
// last week on top of what I already have." Merging summed-qty
// items would be confusing (e.g., 10 + 10 → 20 isn't always what
// you want); REPLACING gives a clean baseline to edit from.
// ─────────────────────────────────────────────────────────────────
// Shared restore helper used by both RecentOrdersBar (recent 5) and
// RecentOrdersHistoryModal (full history view). Persists the restored
// cart to Firestore so a refresh keeps it. Returns true on success.
//
// 2026-05-24 — Andrew: "if there is items in cart it will stop you
// from sending back to cart. say empty cart first." Two flow changes
// from the previous behavior:
//   1. Always-confirm before restoring (even into an empty cart) so a
//      stray tap on a date chip can't silently dump items.
//   2. NO MORE overwrite-confirm. If the cart already has items, the
//      restore is REFUSED entirely with a "Empty cart first" alert.
//      Forces the user to make the destructive step (empty) and the
//      additive step (restore) explicit, separate operations.
async function restoreOrderEntryToCart({ entry, storeLocation, setInventory, currentInventory, isEs }) {
    const restored = {};
    for (const [id, qty] of Object.entries(entry?.counts || {})) {
        const n = Number(qty);
        if (n > 0) restored[id] = n;
    }
    const restoredCount = Object.keys(restored).length;
    if (restoredCount === 0) {
        window.alert(isEs ? 'Este pedido no tiene items.' : 'This order is empty.');
        return false;
    }
    const currentCount = Object.values(currentInventory || {})
        .filter(q => Number(q) > 0).length;
    if (currentCount > 0) {
        window.alert(isEs
            ? `El carrito ya tiene ${currentCount} items. Vacía el carrito primero, luego envía este pedido.`
            : `Cart already has ${currentCount} items. Empty the cart first, then send this order.`);
        return false;
    }
    // Cart is empty — confirm the restore explicitly so a stray tap
    // doesn't dump 14 items in without warning.
    const dateLabel = (() => {
        const iso = entry?.date || (entry?.id ? entry.id.slice(0, 10) : null);
        if (!iso) return '';
        const d = new Date(iso);
        return !isNaN(d.getTime())
            ? d.toLocaleDateString(isEs ? 'es' : 'en', { month: 'short', day: 'numeric' })
            : '';
    })();
    const confirmed = window.confirm(isEs
        ? `Enviar este pedido al carrito${dateLabel ? ` (${dateLabel})` : ''}? Son ${restoredCount} items.`
        : `Send this order to cart${dateLabel ? ` (${dateLabel})` : ''}? It has ${restoredCount} items.`);
    if (!confirmed) return false;
    setInventory(restored);
    try {
        await updateDoc(doc(db, "ops", "inventory_" + storeLocation), {
            counts: restored,
            date: new Date().toISOString(),
        });
    } catch (e) {
        console.warn('restoreOrderEntryToCart persist failed:', e);
        // Non-fatal — local state already updated.
    }
    return true;
}

function RecentOrdersBar({ storeLocation, setInventory, currentInventory, language, onOpenHistory }) {
    const isEs = language === 'es';
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [restoringId, setRestoringId] = useState(null);
    // Bumped to force a reload from the Retry button (changes the effect dep).
    const [retryNonce, setRetryNonce] = useState(0);

    // 2026-05-24 (round 2): Andrew "timed out — check your connection"
    // on Webster. The previous round used one-shot getDocs which doesn't
    // hit Firestore's offline cache — meaning every page-load was a full
    // network round-trip and a 10s budget is too tight on cellular /
    // restaurant Wi-Fi that's bouncing between APs.
    //
    // Hardening (cumulative across rounds):
    //   1. storeLocation === 'both' → render the switch-location prompt,
    //      skip the query entirely (no inventoryHistory_both collection).
    //   2. Switched getDocs → onSnapshot. onSnapshot serves CACHED docs
    //      synchronously on first render, then quietly upgrades when the
    //      live read arrives. Net: the bar paints recent orders in ~50ms
    //      on a warm device, even with no network. The previous getDocs
    //      had no cache hook at all.
    //   3. Timeout bumped 10s → 25s. The cache should serve immediately,
    //      so the timeout only matters for cold-install no-cache cases —
    //      25s gives cellular real headroom while still surfacing dead
    //      connections.
    //   4. orderBy('date', 'desc') stays — `date` is a scalar string and
    //      its desc index auto-creates per Firestore single-field rules.
    //   5. Switched unsub return so React cleans the listener on
    //      location change / unmount (otherwise we leak one listener per
    //      mount).
    //
    // 2026-06-02 audit revert (partial): switched back to getDocs.
    // inventoryHistory is append-only — past orders never mutate after
    // they're saved — so the live-update half of onSnapshot was paying
    // a long-lived listener cost (one per mount of the cart view) for
    // data that, by definition, never changes underneath us. getDocs
    // STILL hits the offline cache by default (Firestore's default
    // source is 'default' which checks cache first then network), so
    // we keep the warm-paint behavior the onSnapshot switch was put in
    // place for. We just stop holding the listener open for live data
    // we don't need. Refresh on storeLocation change / retry button
    // (retryNonce bump) covers the only real refresh paths.
    useEffect(() => {
        if (!storeLocation) return;
        if (storeLocation === 'both') {
            setLoading(false);
            setLoadError(null);
            setHistory([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        const colRef = collection(db, "inventoryHistory_" + storeLocation);
        const timeoutId = setTimeout(() => {
            if (cancelled) return;
            setLoadError(isEs
                ? 'Tiempo de espera agotado. Revisa tu conexión.'
                : 'Timed out. Check your connection.');
            setLoading(false);
        }, 25_000);
        const q = query(colRef, orderBy('date', 'desc'), limit(5));
        getDocs(q)
            .then((snap) => {
                if (cancelled) return;
                clearTimeout(timeoutId);
                setHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
                setLoadError(null);
                setLoading(false);
            })
            .catch((err) => {
                if (cancelled) return;
                clearTimeout(timeoutId);
                console.warn('RecentOrdersBar getDocs failed:', err);
                setLoadError(err?.message || (isEs ? 'Error al cargar' : 'Failed to load'));
                setLoading(false);
            });
        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
        };
    }, [storeLocation, retryNonce, isEs]);

    async function handleRestore(entry) {
        setRestoringId(entry.id);
        try {
            await restoreOrderEntryToCart({
                entry, storeLocation, setInventory, currentInventory, isEs,
            });
        } finally {
            setRestoringId(null);
        }
    }

    if (loading) {
        return (
            <div className="rounded-xl border border-gray-200 bg-white p-2">
                <div className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1.5 px-1">
                    {isEs ? '📋 Pedidos recientes' : '📋 Recent orders'}
                </div>
                <div className="text-[11px] text-gray-400 italic px-2 py-3">
                    {isEs ? 'Cargando…' : 'Loading…'}
                </div>
            </div>
        );
    }
    // Load error → show message + Retry button (was previously console-only)
    if (loadError) {
        return (
            <div className="rounded-xl border border-red-200 bg-red-50 p-2">
                <div className="text-[10px] font-black uppercase tracking-widest text-red-700 mb-1.5 px-1">
                    {isEs ? '📋 Pedidos recientes' : '📋 Recent orders'}
                </div>
                <div className="flex items-start gap-2 px-2 py-2">
                    <div className="text-[11px] text-red-700 flex-1 min-w-0">
                        ⚠️ {loadError}
                    </div>
                    <button onClick={() => setRetryNonce(n => n + 1)}
                        className="shrink-0 px-2.5 py-1 rounded-md bg-red-600 text-white text-[11px] font-bold hover:bg-red-700">
                        {isEs ? '↻ Reintentar' : '↻ Retry'}
                    </button>
                </div>
            </div>
        );
    }
    // Admin toggled to "both" — orders are per-location, so nudge them
    // to pick one. (Skipping the prompt would show "No past orders" which
    // is misleading — they DO have orders, just not in this combined view.)
    if (storeLocation === 'both') {
        return (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-2">
                <div className="text-[10px] font-black uppercase tracking-widest text-amber-800 mb-1.5 px-1">
                    {isEs ? '📋 Pedidos recientes' : '📋 Recent orders'}
                </div>
                <div className="text-[11px] text-amber-900 px-2 py-2">
                    {isEs
                        ? 'Cambia a Webster o Maryland (tap la ubicación en la barra superior) para ver pedidos anteriores.'
                        : 'Switch to Webster or Maryland (tap the location in the top bar) to see past orders.'}
                </div>
            </div>
        );
    }
    // Filter to entries that actually have items
    const rows = history
        .map(h => {
            const filledItems = Object.entries(h.counts || {})
                .filter(([_, q]) => Number(q) > 0);
            return { h, itemCount: filledItems.length };
        })
        .filter(r => r.itemCount > 0);

    if (rows.length === 0) {
        return (
            <div className="rounded-xl border border-gray-200 bg-white p-2">
                <div className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-1.5 px-1">
                    {isEs ? '📋 Pedidos recientes' : '📋 Recent orders'}
                </div>
                <div className="text-[11px] text-gray-400 italic px-2 py-3">
                    {isEs
                        ? 'Sin pedidos anteriores aún. Guarda un pedido y aparecerá aquí.'
                        : 'No past orders yet. Save one and it\'ll appear here.'}
                </div>
            </div>
        );
    }

    // 2026-05-24 — Andrew: "make it one line bar and just show the
    // different days and once you click it, it opens send to cart."
    // Was a 5-row vertical block (~250px tall); now a single
    // horizontal chip strip (~50px tall). Tap a chip → restore
    // confirm dialog (same restoreOrderEntryToCart helper, same
    // overwrite-or-cancel prompt baked in). Vertical real estate
    // freed up for the actual cart rows below.
    return (
        <>
            <div className="rounded-xl border border-gray-200 bg-white p-2">
                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-500 shrink-0 px-1">
                        {isEs ? '📋 Pedidos recientes' : '📋 Recent orders'}
                    </span>
                    {/* Horizontal scrollable strip — overflow-x-auto so a
                        7+ order history doesn't blow out the row width. */}
                    <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto scrollbar-thin">
                        {rows.map(({ h, itemCount }) => {
                            const iso = h.date || (h.id ? h.id.slice(0, 10) : null);
                            const d = iso ? new Date(iso) : null;
                            const dateLabel = (d && !isNaN(d.getTime()))
                                ? d.toLocaleDateString(isEs ? 'es' : 'en',
                                    { month: 'short', day: 'numeric' })
                                : (h.id || '—');
                            const isRestoring = restoringId === h.id;
                            return (
                                <button
                                    key={h.id}
                                    onClick={() => onOpenHistory(h.id)}
                                    disabled={isRestoring}
                                    title={isEs
                                        ? `Ver pedido del ${dateLabel} (${itemCount} items) — luego puedes enviarlo al carrito`
                                        : `View ${dateLabel} order (${itemCount} items) — then you can send it to the cart`}
                                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-orange-50 border border-orange-200 hover:bg-orange-100 active:scale-95 text-[12px] font-bold text-orange-800 disabled:opacity-50 disabled:cursor-wait transition"
                                >
                                    <span>{dateLabel}</span>
                                    <span className="text-[10px] text-orange-600 font-bold">· {itemCount}</span>
                                    {isRestoring && <span className="text-[10px]">⏳</span>}
                                </button>
                            );
                        })}
                    </div>
                    <button onClick={onOpenHistory}
                        className="shrink-0 text-[10px] font-bold text-orange-700 hover:text-orange-900 underline px-1">
                        {isEs ? 'Todos →' : 'All →'}
                    </button>
                </div>
            </div>
        </>
    );
}

// ─────────────────────────────────────────────────────────────────
// RecentOrdersHistoryModal — full history view for re-using past
// orders. Opened from RecentOrdersBar's "View all" link. Loads up
// to 100 most-recent inventoryHistory snapshots (more than that
// the average user won't scroll through; we can paginate later if
// needed). Each row has a "Send to cart" button that runs the same
// shared restore helper as the bar. Click outside or X to close.
// ─────────────────────────────────────────────────────────────────
function RecentOrdersHistoryModal({ storeLocation, setInventory, currentInventory, language, onClose, itemNameById = {}, initialExpandedId = null }) {
    const isEs = language === 'es';
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const [restoringId, setRestoringId] = useState(null);
    const [searchTerm, setSearchTerm] = useState('');
    const [retryNonce, setRetryNonce] = useState(0);
    // Which order's item list is expanded for read-only VIEWING. This is the key
    // to "look at history while building a cart": you can see exactly what was on a
    // past order without restoring it (restore is refused when the cart has items).
    // Seeded from initialExpandedId so clicking a recent-order chip opens the popup
    // already showing that order's items.
    const [expandedId, setExpandedId] = useState(initialExpandedId || null);

    // 2026-05-24 (round 2): same fix as RecentOrdersBar — switched
    // getDocs → onSnapshot for cache warmth, bumped timeout to 25s.
    // The modal opens cached docs synchronously and refreshes when
    // the live read arrives. Modal stays usable on bad cellular.
    //
    // 2026-06-02 audit revert (partial): same reasoning as the bar
    // (above) — inventoryHistory is append-only so the listener cost
    // is wasted on the live-update half. Switched back to getDocs,
    // which still serves from the offline cache by default. Modal-
    // local Retry button (retryNonce) covers the rare "I want the
    // freshest list NOW" case; reopening the modal also re-fetches.
    useEffect(() => {
        if (!storeLocation) return;
        if (storeLocation === 'both') {
            setLoading(false);
            setLoadError(null);
            setHistory([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        const colRef = collection(db, "inventoryHistory_" + storeLocation);
        const timeoutId = setTimeout(() => {
            if (cancelled) return;
            setLoadError(isEs
                ? 'Tiempo de espera agotado. Revisa tu conexión.'
                : 'Timed out. Check your connection.');
            setLoading(false);
        }, 25_000);
        const q = query(colRef, orderBy('date', 'desc'), limit(100));
        getDocs(q)
            .then((snap) => {
                if (cancelled) return;
                clearTimeout(timeoutId);
                setHistory(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
                setLoadError(null);
                setLoading(false);
            })
            .catch((err) => {
                if (cancelled) return;
                clearTimeout(timeoutId);
                console.warn('RecentOrdersHistoryModal getDocs failed:', err);
                setLoadError(err?.message || (isEs ? 'Error al cargar' : 'Failed to load'));
                setLoading(false);
            });
        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
        };
    }, [storeLocation, retryNonce, isEs]);

    async function handleRestoreInModal(entry) {
        setRestoringId(entry.id);
        try {
            const ok = await restoreOrderEntryToCart({
                entry, storeLocation, setInventory, currentInventory, isEs,
            });
            // Close modal on successful restore so admin lands back at
            // the cart view ready to edit. Cancel/empty stays open so
            // they can pick a different order without re-clicking.
            if (ok) onClose();
        } finally {
            setRestoringId(null);
        }
    }

    // Filter by date string OR id. Search is case-insensitive substring
    // match — admins typing "may 1" or "05-01" both find that day.
    // Memoized — every keystroke re-renders via setSearchTerm; without this
    // the 100-row map/filter (Object.entries + new Date + toLocaleDateString
    // per row) re-ran on every render.
    const filteredRows = useMemo(() => history
        .map(h => {
            const filledItems = Object.entries(h.counts || {})
                .filter(([_, q]) => Number(q) > 0);
            return { h, itemCount: filledItems.length };
        })
        .filter(r => r.itemCount > 0)
        .filter(r => {
            if (!searchTerm.trim()) return true;
            const needle = searchTerm.trim().toLowerCase();
            const iso = r.h.date || (r.h.id ? r.h.id.slice(0, 10) : null);
            const d = iso ? new Date(iso) : null;
            const dateLabel = (d && !isNaN(d.getTime()))
                ? d.toLocaleDateString(isEs ? 'es' : 'en',
                    { month: 'short', day: 'numeric', year: '2-digit', weekday: 'short' })
                : '';
            return iso?.toLowerCase().includes(needle)
                || r.h.id?.toLowerCase().includes(needle)
                || dateLabel.toLowerCase().includes(needle);
        }), [history, searchTerm, isEs]);

    return (
        <ModalPortal onBackPress={onClose}>
        {/* z-[80]: above the cart modal (z-50) so it can be opened from inside the
            cart and you can reference a past order while building a new one. */}
        <div className="fixed inset-0 z-[80] bg-black/50 flex items-end md:items-center justify-center"
            onClick={onClose}>
            <div className="bg-white w-full md:max-w-lg md:rounded-2xl rounded-t-2xl flex flex-col max-h-[92vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-gray-300 rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between bg-orange-50">
                    <div>
                        <h2 className="text-lg font-black text-orange-900">
                            📋 {isEs ? 'Historial de pedidos' : 'Order history'}
                        </h2>
                        <p className="text-[11px] text-orange-800">
                            {isEs
                                ? 'Toca un pedido para ver sus items · ↩ para enviarlo al carrito.'
                                : 'Tap an order to view its items · ↩ to send it to the cart.'}
                        </p>
                    </div>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full hover:bg-white/60 flex items-center justify-center text-gray-700">
                        ✕
                    </button>
                </div>
                <div className="px-4 pt-3 pb-2 border-b border-gray-200">
                    <input type="text" value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder={isEs ? 'Buscar por fecha…' : 'Search by date…'}
                        className="w-full px-3 py-1.5 rounded-lg border border-gray-300 text-sm bg-white" />
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-1.5"
                    style={{ overscrollBehavior: 'contain' }}>
                    {loading && (
                        <div className="text-[11px] text-gray-400 italic px-2 py-3">
                            {isEs ? 'Cargando…' : 'Loading…'}
                        </div>
                    )}
                    {!loading && loadError && (
                        <div className="flex items-start gap-2 px-3 py-3 rounded-lg bg-red-50 border border-red-200">
                            <div className="text-[12px] text-red-700 flex-1 min-w-0">
                                ⚠️ {loadError}
                            </div>
                            <button onClick={() => setRetryNonce(n => n + 1)}
                                className="shrink-0 px-3 py-1.5 rounded-md bg-red-600 text-white text-[12px] font-bold hover:bg-red-700">
                                {isEs ? '↻ Reintentar' : '↻ Retry'}
                            </button>
                        </div>
                    )}
                    {!loading && !loadError && storeLocation === 'both' && (
                        <div className="px-3 py-3 rounded-lg bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
                            {isEs
                                ? 'Cambia a Webster o Maryland (tap la ubicación en la barra superior) para ver pedidos anteriores.'
                                : 'Switch to Webster or Maryland (tap the location in the top bar) to see past orders.'}
                        </div>
                    )}
                    {!loading && !loadError && storeLocation !== 'both' && filteredRows.length === 0 && (
                        <div className="text-[11px] text-gray-400 italic px-2 py-3">
                            {searchTerm
                                ? (isEs ? 'No hay coincidencias.' : 'No matches.')
                                : (isEs ? 'No hay pedidos guardados.' : 'No saved orders yet.')}
                        </div>
                    )}
                    {filteredRows.map(({ h, itemCount }) => {
                        const totalQty = Object.values(h.counts || {})
                            .reduce((s, q) => s + (Number(q) || 0), 0);
                        const iso = h.date || (h.id ? h.id.slice(0, 10) : null);
                        const d = iso ? new Date(iso) : null;
                        const dateLabel = (d && !isNaN(d.getTime()))
                            ? d.toLocaleDateString(isEs ? 'es' : 'en',
                                { weekday: 'short', month: 'short', day: 'numeric', year: '2-digit' })
                            : (h.id || '—');
                        const isRestoring = restoringId === h.id;
                        const isOpen = expandedId === h.id;
                        return (
                            <div key={h.id}
                                className="rounded-lg bg-gray-50 border border-gray-200 overflow-hidden">
                                <div className="flex items-center gap-2 px-3 py-2">
                                    {/* Tap the date area to VIEW this order's items (read-only) —
                                        works even while the cart has items. */}
                                    <button onClick={() => setExpandedId(isOpen ? null : h.id)}
                                        className="min-w-0 flex-1 text-left active:scale-[0.99] transition">
                                        <div className="text-[13px] font-black text-gray-900 truncate flex items-center gap-1">
                                            <span className="text-gray-400">{isOpen ? '▾' : '▸'}</span>
                                            {dateLabel}
                                        </div>
                                        <div className="text-[11px] text-gray-600 truncate">
                                            {itemCount} {isEs ? 'items' : 'items'} · {isEs ? 'cantidad' : 'qty'} {totalQty}
                                            <span className="text-gray-400"> · {isOpen ? (isEs ? 'ocultar' : 'hide') : (isEs ? 'toca para ver' : 'tap to view')}</span>
                                        </div>
                                    </button>
                                    <button onClick={() => handleRestoreInModal(h)}
                                        disabled={isRestoring}
                                        className="px-3 py-1.5 rounded-md bg-orange-600 text-white text-[12px] font-bold hover:bg-orange-700 shrink-0 disabled:opacity-50 disabled:cursor-wait">
                                        {isRestoring
                                            ? (isEs ? '…' : '…')
                                            : (isEs ? '↩ Al carrito' : '↩ Send to cart')}
                                    </button>
                                </div>
                                {isOpen && (
                                    <div className="px-3 pb-2 pt-1 border-t border-gray-200 bg-white">
                                        <ul className="text-[12px] text-gray-700">
                                            {Object.entries(h.counts || {})
                                                .filter(([, q]) => Number(q) > 0)
                                                .sort((a, b) => (itemNameById[a[0]] || a[0]).localeCompare(itemNameById[b[0]] || b[0]))
                                                .map(([id, q]) => (
                                                    <li key={id} className="flex items-center justify-between gap-2 py-1 border-b border-gray-100 last:border-0">
                                                        <span className="truncate">{itemNameById[id] || id}</span>
                                                        <span className="font-bold tabular-nums shrink-0">×{Number(q)}</span>
                                                    </li>
                                                ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                <div className="px-4 py-2 border-t border-gray-200 text-[10px] text-gray-500 text-center">
                    {isEs
                        ? `Mostrando hasta 100 pedidos más recientes.`
                        : `Showing up to 100 most-recent orders.`}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}


