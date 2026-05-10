import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { db, storage } from '../firebase';
import { doc, onSnapshot, setDoc, getDoc, getDocs, updateDoc, query, collection, orderBy, limit, where, writeBatch, serverTimestamp, deleteDoc, deleteField, arrayUnion, runTransaction } from 'firebase/firestore';
import { ref, getDownloadURL, uploadBytes, deleteObject } from 'firebase/storage';
import { t, autoTranslateItem } from '../data/translations';
import { isAdmin, ADMIN_NAMES, DEFAULT_STAFF, LOCATION_LABELS, canViewLabor } from '../data/staff';
import { INVENTORY_CATEGORIES } from '../data/inventory';
import InventoryHistory from './InventoryHistory';
import PrepList from './PrepList';
import SauceLog from './SauceLog';
import SauceLogBohBanner from './SauceLogBohBanner';
import { toast, undoToast } from '../toast';

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

export default function Operations({ language, staffList, staffName, storeLocation }) {

            // (Removed 2026-05-09) passwordEntered / password / handlePasswordSubmit
            // — leftover from the shared-password Operations gate. Replaced by the
            // hasOpsAccess opt-in toggle (admin or per-staff opsAccess === true).
            // Nothing references these any more; commit history preserves them.
            const [inventory, setInventory] = useState({});
            const [invCountMeta, setInvCountMeta] = useState({}); // { itemId: { by, at } }
            // Counts for vendor-only items that aren't matched to a master inventory item.
            // Keyed as `${vendor}:${vendorId}` (e.g. "sysco:5106402") so it can't collide with
            // master inventory ids. Stored under inventory_<location>.vendorCounts in Firestore.
            const [vendorCounts, setVendorCounts] = useState({});
            const [activeTab, setActiveTab] = useState("checklist");
            const [lastUpdated, setLastUpdated] = useState({});
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
            const [editFollowUp, setEditFollowUp] = useState(null); // { type: "dropdown"|"text", question: "", options: [] }
            const [showAddForm, setShowAddForm] = useState(false);
            const [newTask, setNewTask] = useState("");
            const [newCategory, setNewCategory] = useState("other");
            const [newRecurrence, setNewRecurrence] = useState("daily");
            const [newRequirePhoto, setNewRequirePhoto] = useState(false);
            // Category filter for the task list view (also used by quick-add to default the new task's category)
            const [categoryFilter, setCategoryFilter] = useState("all");
            // Skip-with-reason modal state — { taskId, parentTaskId } when picking, null otherwise
            const [skipPickerFor, setSkipPickerFor] = useState(null);
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
            const photoInputRef = useRef(null);

            // Determine current user's role early
            const currentIsAdmin = isAdmin(staffName, staffList);

            // New checklist system {"\u{2014}"} FOH/BOH with multiple lists per side
            const staffRole = (staffList || []).find(s => s.name === staffName);
            const staffIsFOH = staffRole ? ["FOH", "Manager", "Owner", "Shift Lead"].includes(staffRole.role) : true;
            const staffSide = staffIsFOH ? "FOH" : "BOH";
            const [checklistSide, setChecklistSide] = useState(currentIsAdmin ? "FOH" : staffSide);
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
            const [invShowAddForm, setInvShowAddForm] = useState(null);
            const [invNewName, setInvNewName] = useState("");
            const [invNewNameEs, setInvNewNameEs] = useState("");
            const [invNewSupplier, setInvNewSupplier] = useState("");
            const [invNewOrderDay, setInvNewOrderDay] = useState("Fri");
            const [customInventory, setCustomInventory] = useState(INVENTORY_CATEGORIES.map(c => ({...c, items: [...c.items]})));
            const [livePrices, setLivePrices] = useState({}); // { sysco: { prices: { itemId: { price, pack, ... } }, lastScraped } }
            const [syscoTriggerStatus, setSyscoTriggerStatus] = useState(null); // null | "requesting" | "running" | "done" | "error"
            const [syscoScrapeStatus, setSyscoScrapeStatus] = useState(null); // { status, detail, pricesFound, updatedAt }
            const [usfoodsTriggerStatus, setUsfoodsTriggerStatus] = useState(null);
            const [usfoodsScrapeStatus, setUsfoodsScrapeStatus] = useState(null);
            const [pricingVendor, setPricingVendor] = useState("sysco"); // "sysco" or "usfoods"
            const [showSaveConfirm, setShowSaveConfirm] = useState(false);
            const [inventorySaving, setInventorySaving] = useState(false);
            const [invSearch, setInvSearch] = useState("");
            const [writeInValues, setWriteInValues] = useState({});
            const [invViewMode, setInvViewMode] = useState("category"); // "category" or "vendor"
            const [collapsedCats, setCollapsedCats] = useState({});
            const [invShowOnlyCounted, setInvShowOnlyCounted] = useState(false);
            const [vendorChangeLog, setVendorChangeLog] = useState([]);
            const [showVendorLog, setShowVendorLog] = useState(false);
            const [showCart, setShowCart] = useState(false);
            // (echo from local writes is now suppressed via snapshot.metadata.hasPendingWrites in the inventory listener)
            // Split list state: overrides move items between people, writeIns are custom items per person
            const [splitOverrides, setSplitOverrides] = useState({}); // {itemId: personName}
            const [splitWriteIns, setSplitWriteIns] = useState({}); // {personName: [{id, name, count}]}
            const [splitWriteInValues, setSplitWriteInValues] = useState({}); // {personName: "text"}
            const [splitMovingItem, setSplitMovingItem] = useState(null); // {itemId, fromPerson}

            // Break Planner state
            const DEFAULT_STATIONS = [
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
            const DEFAULT_BREAK_WAVES = [
                { id: "wave1", time: "13:30" },
                { id: "wave2", time: "14:30" }
            ];
            // Skill stations for the matrix (unique skills, not position slots)
            const SKILL_STATIONS = [
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
            // Map position IDs to skill IDs (fried rice 1&2 -> friedrice, prep1-4 -> prep)
            const positionToSkill = (posId) => {
                if (posId.startsWith("friedrice")) return "friedrice";
                if (posId.startsWith("prep")) return "prep";
                return posId;
            };

            const [customStations, setCustomStations] = useState(JSON.parse(JSON.stringify(DEFAULT_STATIONS)));
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

            // Labor percentage state (admin-only, from Toast scraper)
            const [laborData, setLaborData] = useState(null);
            // FOH_ROLES_LIST hoisted to module scope so the useMemo dep array
            // doesn't churn on every render. fohStaff was unused — removed.
            const bohStaff = useMemo(
                () => (staffList || []).filter(s => s.role && !FOH_ROLES_LIST.includes(s.role) && (s.location === storeLocation || s.location === "both")),
                [staffList, storeLocation]
            );

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
                });
                return () => unsubMatrix();
            }, []);

            // Load custom stations from Firestore
            useEffect(() => {
                const unsubStations = onSnapshot(doc(db, "config", "stations"), (docSnap) => {
                    if (docSnap.exists() && docSnap.data().stations && docSnap.data().stations.length > 0) {
                        setCustomStations(docSnap.data().stations);
                    }
                });
                return () => unsubStations();
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
                const updated = customInventory.map((c, cIdx) => {
                    if (cIdx !== catIdx) return c;
                    const items = [...c.items];
                    [items[itemIdx], items[targetIdx]] = [items[targetIdx], items[itemIdx]];
                    return { ...c, items };
                });
                setCustomInventory(updated);
                await saveInventory(inventory, updated);
            };

            // Listen to live labor data for current location
            useEffect(() => {
                const unsubLabor = onSnapshot(doc(db, "ops", "labor_" + storeLocation), (docSnap) => {
                    if (docSnap.exists()) {
                        setLaborData(docSnap.data());
                    } else {
                        setLaborData(null);
                    }
                });
                return () => unsubLabor();
            }, [storeLocation]);

            const saveStations = async (stations) => {
                try {
                    await setDoc(doc(db, "config", "stations"), { stations, updatedAt: new Date().toISOString() });
                } catch (err) { console.error("Error saving stations:", err); }
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
                } catch (err) { console.error("Error saving skills matrix:", err); }
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

            // Load break plan from Firestore {"\u{2014}"} keyed by selected date + location
            useEffect(() => {
                // Reset plan while loading new date/location
                setBreakPlan({ stations: {}, waves: {} });
                setBreakWaveTimes(DEFAULT_BREAK_WAVES.map(w => w.time));
                let cancelled = false;
                const docId = "breakPlan_" + storeLocation + "_" + breakDate;
                const unsubBreakPlan = onSnapshot(doc(db, "ops", docId), (docSnap) => {
                    if (cancelled) return;
                    if (docSnap.exists()) {
                        setBreakPlan(docSnap.data().plan || { stations: {}, waves: {} });
                        if (docSnap.data().waveTimes) setBreakWaveTimes(docSnap.data().waveTimes);
                    }
                });
                // Also migrate old single-doc format for today if needed.
                // Guard with `cancelled` so a date/location change mid-migration doesn't write
                // the old date's plan to the old docId after the user has navigated away.
                if (breakDate === getTodayKey()) {
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
            }, [breakDate, storeLocation]);

            const breakPlanDocRef = () => doc(db, "ops", "breakPlan_" + storeLocation + "_" + breakDate);
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
                // Load checklist data (new system)
                const unsubChecklist = onSnapshot(doc(db, "ops", "checklists2_" + storeLocation), async (docSnap) => {
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
                        setLastUpdated(prev => ({ ...prev, checklists: data.updatedAt ? new Date(data.updatedAt).toLocaleString() : "" }));
                    }
                });

                const inventoryDocRef = doc(db, "ops", "inventory_" + storeLocation);
                const unsubInventorySnapshot = onSnapshot(inventoryDocRef, { includeMetadataChanges: true }, (docSnap) => {
                    // Skip our own optimistic local writes — wait for the server-confirmed snapshot.
                    // This avoids the prior race where a remote write arriving in the same tick
                    // as our local write got swallowed as if it were our own echo.
                    if (docSnap.metadata.hasPendingWrites) return;
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        setInventory(data.counts || {});
                        setInvCountMeta(data.countMeta || {});
                        setVendorCounts(data.vendorCounts || {});
                        if (data.customInventory) {
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
                                    if (seenIds.has(newId)) return;
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
                        setLastUpdated(prev => ({ ...prev, inventory: data.date ? new Date(data.date).toLocaleString() : "" }));
                    }
                });

                // Load vendor change log
                const unsubVendorLog = onSnapshot(doc(db, "ops", "vendorLog_" + storeLocation), (docSnap) => {
                    if (docSnap.exists()) {
                        setVendorChangeLog(docSnap.data().log || []);
                    }
                });

                // Load split list config (overrides + write-ins)
                const unsubSplit = onSnapshot(doc(db, "ops", "splitConfig_" + storeLocation), (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        if (data.overrides) setSplitOverrides(data.overrides);
                        if (data.writeIns) setSplitWriteIns(data.writeIns);
                    }
                });

                // Live vendor prices (from scrapers)
                const unsubSyscoPrices = onSnapshot(doc(db, "vendor_prices", "sysco"), (docSnap) => {
                    if (docSnap.exists()) {
                        setLivePrices(prev => ({ ...prev, sysco: docSnap.data() }));
                    }
                });

                // Helper: determine if a trigger doc is "stale" (a previous scrape
                // crashed or got killed mid-run, leaving status="running"/"pending"
                // forever and locking the refresh button). 10-min ceiling matches
                // the longest reasonable scrape time + buffer. Without this guard,
                // a single crashed scrape jams the button until someone manually
                // edits Firestore.
                const TRIGGER_STALE_MS = 10 * 60 * 1000;
                const isTriggerStale = (data) => {
                    const ts = data.startedAt || data.requestedAt;
                    if (!ts) return false;
                    const tsMs = typeof ts === "string" ? Date.parse(ts) : 0;
                    if (!tsMs) return false;
                    return Date.now() - tsMs > TRIGGER_STALE_MS;
                };
                const isCompletionStale = (data) => {
                    const ts = data.completedAt;
                    if (!ts) return false;
                    const tsMs = typeof ts === "string" ? Date.parse(ts) : 0;
                    if (!tsMs) return false;
                    // Completion banners only show for 30s — past that, an old
                    // "done" or "error" state is just historical noise on page load.
                    return Date.now() - tsMs > 30 * 1000;
                };
                const applyTriggerSnapshot = (data, setter) => {
                    // Stale running/pending → treat as null so user can re-trigger.
                    if ((data.status === "running" || data.status === "pending") && isTriggerStale(data)) {
                        setter(null);
                        return;
                    }
                    // Old done/error from a prior session → don't flash the banner.
                    if ((data.status === "done" || data.status === "error") && isCompletionStale(data)) {
                        setter(null);
                        return;
                    }
                    if (data.status === "running") {
                        setter("running");
                    } else if (data.status === "done") {
                        setter("done");
                        setTimeout(() => setter(null), 4000);
                    } else if (data.status === "error") {
                        setter("error");
                        setTimeout(() => setter(null), 5000);
                    } else if (data.status === "pending") {
                        setter("requesting");
                    } else if (!data.trigger) {
                        setter(null);
                    }
                };

                // Listen for Sysco scrape trigger status updates
                const unsubSyscoTrigger = onSnapshot(doc(db, "vendor_prices", "sysco_trigger"), (docSnap) => {
                    if (docSnap.exists()) {
                        applyTriggerSnapshot(docSnap.data(), setSyscoTriggerStatus);
                    }
                });

                // Listen for Sysco scrape health status (login_failed, no_prices, etc.)
                const unsubSyscoStatus = onSnapshot(doc(db, "vendor_prices", "sysco_status"), (docSnap) => {
                    if (docSnap.exists()) {
                        setSyscoScrapeStatus(docSnap.data());
                    }
                });

                // US Foods live prices
                const unsubUsfoodsPrices = onSnapshot(doc(db, "vendor_prices", "usfoods"), (docSnap) => {
                    if (docSnap.exists()) {
                        setLivePrices(prev => ({ ...prev, usfoods: docSnap.data() }));
                    }
                });

                // US Foods trigger status
                const unsubUsfoodsTrigger = onSnapshot(doc(db, "vendor_prices", "usfoods_trigger"), (docSnap) => {
                    if (docSnap.exists()) {
                        applyTriggerSnapshot(docSnap.data(), setUsfoodsTriggerStatus);
                    }
                });

                // US Foods scrape health status
                const unsubUsfoodsStatus = onSnapshot(doc(db, "vendor_prices", "usfoods_status"), (docSnap) => {
                    if (docSnap.exists()) {
                        setUsfoodsScrapeStatus(docSnap.data());
                    }
                });

                return () => { unsubChecklist(); unsubInventorySnapshot(); unsubVendorLog(); unsubSplit(); unsubSyscoPrices(); unsubSyscoTrigger(); unsubSyscoStatus(); unsubUsfoodsPrices(); unsubUsfoodsTrigger(); unsubUsfoodsStatus(); };
            }, [storeLocation]);

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
            const [clockTick, setClockTick] = useState(0);
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
                            const taskName = item.task.includes("\n") ? item.task.split("\n")[0] : item.task;
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
                const interval = setInterval(() => { checkDeadlines(); setClockTick(t => t + 1); }, 30000);
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

            const saveChecklistState = async (newChecks, newTasks, newAssignments, newLists) => {
                const todayKey = getTodayKey();
                const now = new Date().toISOString();
                const safeChecks = cleanForFirestore(newChecks);
                const safeTasks = cleanForFirestore(newTasks);
                const safeAssignments = cleanForFirestore(newAssignments || checklistAssignments);
                const safeLists = cleanForFirestore(newLists || checklistListsRef.current);
                try {
                    await setDoc(doc(db, "ops", "checklists2_" + storeLocation), {
                        checks: safeChecks, customTasks: safeTasks, assignments: safeAssignments, lists: safeLists, date: todayKey, updatedAt: now, version: CHECKLIST_VERSION
                    });
                    // Also save to daily history
                    await setDoc(doc(db, "checklistHistory_" + storeLocation, todayKey), {
                        checks: safeChecks, customTasks: safeTasks, assignments: safeAssignments, lists: safeLists, date: now, version: CHECKLIST_VERSION
                    });
                } catch (err) { console.error("Error saving checklist:", err); }
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
                await saveChecklistState(checksRef.current, customTasksRef.current, updated, updatedLists);
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
                await saveChecklistState(checksRef.current, updated);
            };

            const addChecklistList = async (side) => {
                const updatedLists = JSON.parse(JSON.stringify(checklistListsRef.current));
                const newIdx = updatedLists[side].length;
                updatedLists[side].push({ id: side + "_" + newIdx, assignee: "" });
                setChecklistLists(updatedLists);
                setActiveListIdx(newIdx);
                await saveChecklistState(checksRef.current, customTasksRef.current, checklistAssignments, updatedLists);
            };

            const removeChecklistList = async (side, listIdx) => {
                if (listIdx === 0) return; // Can't remove the first list
                const updatedLists = JSON.parse(JSON.stringify(checklistListsRef.current));
                updatedLists[side].splice(listIdx, 1);
                // Clean up checks for that list
                const prefix = getCheckPrefix(side, listIdx);
                const newChecks = { ...checksRef.current };
                if (prefix) {
                    Object.keys(newChecks).forEach(k => { if (k.startsWith(prefix)) delete newChecks[k]; });
                }
                // Clean up assignment
                const newAssignments = { ...checklistAssignments };
                const assignKey = side + "_L" + listIdx + "_all";
                delete newAssignments[assignKey];
                setChecklistLists(updatedLists);
                setChecks(newChecks);
                setChecklistAssignments(newAssignments);
                setActiveListIdx(Math.min(activeListIdx, updatedLists[side].length - 1));
                await saveChecklistState(newChecks, customTasksRef.current, newAssignments, updatedLists);
            };

            // ── Per-task comments ──
            // Stored in the same `checks` doc under key `${prefix}${taskId}_comments`
            // as an array of {by, at, text}. arrayUnion makes concurrent
            // comments safe — two cooks adding notes at the same moment
            // both land instead of one clobbering the other.
            const addTaskComment = async (taskId, text) => {
                if (!text || !text.trim()) return;
                const pKey = currentPrefix + taskId + "_comments";
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                const comment = { by: staffName, at: timeStr, text: text.trim(), ts: now.toISOString() };
                // Optimistic local update so UI shows comment instantly.
                const cur = checksRef.current;
                const existing = Array.isArray(cur[pKey]) ? cur[pKey] : [];
                setChecks({ ...cur, [pKey]: [...existing, comment] });
                await appendCheckArrayValue(pKey, comment);
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
                    if (opts.docId) {
                        // Idempotent path — used for time-based reminders so multiple
                        // devices firing checkDeadlines don't write duplicates. Fixed
                        // doc ID + setDoc means second writer just overwrites the first
                        // with same content (no second Cloud Function trigger).
                        await setDoc(doc(db, 'notifications', opts.docId), {
                            forStaff, type,
                            title: taskNotifyResolve(title, recipient),
                            body: taskNotifyResolve(body, recipient),
                            link, createdAt: serverTimestamp(), read: false, createdBy: staffName,
                        });
                    } else {
                        await addDoc(collection(db, 'notifications'), {
                            forStaff, type,
                            title: taskNotifyResolve(title, recipient),
                            body: taskNotifyResolve(body, recipient),
                            link, createdAt: serverTimestamp(), read: false, createdBy: staffName,
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
                                    await saveChecklistState(newChecks, updated, checklistAssignmentsRef.current, checklistListsRef.current);
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
                setSkipPickerFor(null);
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
                await saveChecklistState(checksRef.current, updated);
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
                await saveChecklistState(checksRef.current, updated);
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
                await saveChecklistState(checksRef.current, updated);
                setEditingIdx(null); setEditTask(""); setEditCategory("other"); setEditRecurrence("daily"); setEditRequirePhoto(false); setEditSubtasks([]); setEditCompleteBy(""); setEditAssignTo([]); setEditFollowUp(null);
            };

            // Photo capture and upload
            const handlePhotoCapture = async (e, taskId) => {
                const file = e.target.files?.[0];
                // Reset the input so the same file can be reselected after a failed upload.
                if (e.target) e.target.value = "";
                if (!file) return;
                // Re-entry guard: a rapid second tap (mobile Safari double-fire) must not start a parallel upload.
                if (capturingPhoto) return;
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
                    // If we successfully uploaded the file but the Firestore
                    // write failed, the storage object is orphaned (no DB
                    // reference). Delete it so we don't accumulate dead bytes.
                    if (uploaded) {
                        try { await deleteObject(photoRef); }
                        catch (cleanupErr) { console.warn("Photo orphan cleanup failed:", cleanupErr); }
                    }
                    toast(language === "es" ? "Error al subir foto" : "Error uploading photo");
                }
                setCapturingPhoto(null);
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
                    for (const key of Object.keys(cur)) {
                        // Match `${currentPrefix}${taskId}` and any `_by`/`_at`/`_photo`/etc. variants.
                        for (const tid of orphanIds) {
                            if (key === currentPrefix + tid || key.startsWith(currentPrefix + tid + "_")) {
                                if (key.endsWith("_photo")) photoKeysToDelete.push(cur[key]);
                                delete newChecks[key];
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
                    await saveChecklistState(newChecks, updated);
                } else {
                    await saveChecklistState(checksRef.current, updated);
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
                await saveChecklistState({}, customTasksRef.current);
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
                } catch (err) { console.error("Error saving inventory snapshot:", err); }
            };

            const updateInventoryCount = async (itemId, newCount) => {
                const count = parseInt(newCount) || 0;
                const newInventory = { ...inventory, [itemId]: count };
                setInventory(newInventory);
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                const newMeta = { ...invCountMeta, [itemId]: { by: staffName, at: timeStr } };
                if (count === 0) delete newMeta[itemId];
                setInvCountMeta(newMeta);
                const ref = doc(db, "ops", "inventory_" + storeLocation);
                // Targeted update via dotted paths so concurrent edits on other items aren't clobbered.
                const update = {
                    [`counts.${itemId}`]: count,
                    [`countMeta.${itemId}`]: count === 0 ? deleteField() : { by: staffName, at: timeStr },
                    date: new Date().toISOString(),
                };
                try {
                    await updateDoc(ref, update);
                } catch (err) {
                    // Doc may not exist yet on first write to a fresh location.
                    if (err?.code === "not-found") {
                        try {
                            await setDoc(ref, { counts: newInventory, countMeta: newMeta, customInventory, date: new Date().toISOString() });
                        } catch (e) { console.error("Error creating inventory:", e); }
                    } else {
                        console.error("Error updating inventory:", err);
                    }
                }
            };

            // Count tracker for vendor-only items (those not matched to a master inventory item).
            // Same dotted-path pattern as updateInventoryCount so concurrent edits on
            // other items aren't clobbered.
            const updateVendorCount = async (vendor, vendorId, newCount) => {
                const count = parseInt(newCount) || 0;
                const key = `${vendor}:${vendorId}`;
                const next = { ...vendorCounts };
                if (count === 0) delete next[key];
                else next[key] = count;
                setVendorCounts(next);
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
                        } catch (e) { console.error("Error creating inventory (vendorCounts):", e); }
                    } else {
                        console.error("Error updating vendor count:", err);
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
                } catch (err) { console.error("Error saving/resetting inventory:", err); }
                setInventorySaving(false);
                setShowSaveConfirm(false);
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
                console.log(`[idMigration] healed ${Object.keys(idMigration).length} ids`);
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

            // Build a fresh ID that won't collide with anything currently in the category,
            // even when existing items have malformed IDs (no "-", non-numeric suffix, etc.).
            const nextItemId = (category, catIdx) => {
                const taken = new Set(category.items.map(it => it.id));
                let n = category.items.length;
                while (taken.has(catIdx + "-" + n)) n++;
                return catIdx + "-" + n;
            };

            // Quick write-in add (from the blank line at bottom of each category).
            // Uses mutateInventory so two managers adding to the same category
            // simultaneously don't clobber each other.
            const quickAddItem = async (catIdx) => {
                const input = (writeInValues[catIdx] || "").trim();
                if (!input) return;
                const translated = autoTranslateItem(input);
                setWriteInValues(prev => ({ ...prev, [catIdx]: "" }));
                await mutateInventory((live) => {
                    const liveCat = live[catIdx];
                    if (!liveCat) return live;
                    const newItem = {
                        id: nextItemId(liveCat, catIdx),
                        name: translated.name, nameEs: translated.nameEs,
                        vendor: "", supplier: "", orderDay: "", pack: "", price: null, subcat: "",
                    };
                    return live.map((cat, idx) => idx === catIdx ? { ...cat, items: [...cat.items, newItem] } : cat);
                });
            };

            const addInvItem = async (catIdx) => {
                if (!invNewName.trim()) return;
                const captured = {
                    name: invNewName.trim(), nameEs: invNewNameEs.trim(),
                    supplier: invNewSupplier.trim(), orderDay: invNewOrderDay,
                };
                await mutateInventory((live) => {
                    const liveCat = live[catIdx];
                    if (!liveCat) return live;
                    const newItem = {
                        id: nextItemId(liveCat, catIdx),
                        name: captured.name, nameEs: captured.nameEs,
                        vendor: captured.supplier, supplier: captured.supplier,
                        orderDay: captured.orderDay, pack: "", price: null, subcat: "",
                    };
                    return live.map((cat, idx) => idx === catIdx ? { ...cat, items: [...cat.items, newItem] } : cat);
                });
                setInvNewName(""); setInvNewNameEs(""); setInvNewSupplier(""); setInvNewOrderDay("Fri"); setInvShowAddForm(null);
            };

            const saveInvEdit = async (catIdx, itemIdx) => {
                if (!invEditName.trim()) return;
                // Capture the item ID from local state so we can locate it in the live
                // list by ID rather than by index — index drifts if other managers
                // added/removed items in this category between snapshots.
                const targetId = customInventory[catIdx]?.items[itemIdx]?.id;
                const patch = {
                    name: invEditName.trim(), nameEs: invEditNameEs.trim(),
                    vendor: invEditSupplier.trim(), supplier: invEditSupplier.trim(),
                    orderDay: invEditOrderDay,
                };
                await mutateInventory((live) => live.map((cat, cIdx) =>
                    cIdx === catIdx
                        ? { ...cat, items: cat.items.map(item =>
                            item.id === targetId ? { ...item, ...patch } : item) }
                        : cat
                ));
                setInvEditingIdx(null); setInvEditName(""); setInvEditNameEs(""); setInvEditSupplier(""); setInvEditOrderDay("Fri");
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
                        await mutateInventory((live) => live.map((cat, cIdx) =>
                            cIdx === catIdx ? { ...cat, items: cat.items.filter(it => it.id !== targetId) } : cat
                        ));
                    },
                    { delayMs: 5000, undoLabel: language === 'es' ? 'Deshacer' : 'Undo', kind: 'warn' }
                );
            };

            // Split list helpers
            const saveSplitConfig = async (overrides, writeIns) => {
                try {
                    await setDoc(doc(db, "ops", "splitConfig_" + storeLocation), { overrides, writeIns, date: new Date().toISOString() });
                } catch (err) { console.error("Error saving split config:", err); }
            };

            const moveSplitItem = async (itemId, toPerson) => {
                const updated = { ...splitOverrides, [itemId]: toPerson };
                setSplitOverrides(updated);
                setSplitMovingItem(null);
                await saveSplitConfig(updated, splitWriteIns);
            };

            const addSplitWriteIn = async (personName) => {
                const input = (splitWriteInValues[personName] || "").trim();
                if (!input) return;
                const existing = splitWriteIns[personName] || [];
                const newId = "sw-" + personName + "-" + Date.now();
                const updated = { ...splitWriteIns, [personName]: [...existing, { id: newId, name: input, count: 0 }] };
                setSplitWriteIns(updated);
                setSplitWriteInValues(prev => ({ ...prev, [personName]: "" }));
                await saveSplitConfig(splitOverrides, updated);
            };

            const removeSplitWriteIn = async (personName, itemId) => {
                const existing = splitWriteIns[personName] || [];
                const updated = { ...splitWriteIns, [personName]: existing.filter(i => i.id !== itemId) };
                setSplitWriteIns(updated);
                await saveSplitConfig(splitOverrides, updated);
            };

            const updateSplitWriteInCount = async (personName, itemId, newCount) => {
                const existing = splitWriteIns[personName] || [];
                const updated = { ...splitWriteIns, [personName]: existing.map(i => i.id === itemId ? { ...i, count: newCount } : i) };
                setSplitWriteIns(updated);
                await saveSplitConfig(splitOverrides, updated);
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
                if (!list || list.length === 0) return null;
                const cheapest = list[0];  // already sorted ascending
                return (
                    <span className="inline-flex items-center gap-1 flex-wrap">
                        {list.map((p, i) => {
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
                const rows = [];
                customInventory.forEach((cat) => {
                    cat.items.forEach(item => {
                        const qty = inventory[item.id] || 0;
                        if (qty <= 0) return;
                        rows.push({
                            kind: "master",
                            name: item.name,
                            category: cat.name,
                            qty,
                            vendorPrices: invToVendorPrices[item.id] || [],
                            pack: item.pack,
                        });
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
                html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://ddmauapp.github.io/dd-mau-portal/'}},300)">✕ Close</button><button class="btn-print" onclick="window.print()">🖨️ Print</button></div>`;
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
                // Non-admin staff: only see tasks assigned to them or unassigned
                if (!currentIsAdmin) {
                    return tagged.filter(t => hasNoAssign(t) || isAssignedTo(t, staffName));
                }
                // Admin with filter active: show only tasks for that person (+ unassigned)
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
                const w = window.open("", "_blank", "width=800,height=1000");
                if (!w) { toast(language === "es" ? "Ventana bloqueada." : "Pop-up blocked."); return; }
                w.document.open(); w.document.write(html); w.document.close();
            };

            const renderChecklist = () => {
                const tasks = getCurrentTasks();
                const allTasks = getAllTasks();
                const periodStats = getPeriodStats(checklistSide, PERIOD_KEY);
                const overallStats = getCompletionStats(checklistSide);

                return (
                    <div className="space-y-3">
                        {/* FOH / BOH side selector — v2 segmented control (matches Schedule).
                            Emojis dropped — 🪑 + 🍳 don't render reliably across systems
                            (showed as fallback tofu on some browsers). Side codes alone
                            are universally read by restaurant staff. */}
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

                        {/* BOH-only: pending sauce requests from FOH. Hidden when no requests. */}
                        {checklistSide === "BOH" && (
                            <SauceLogBohBanner
                                language={language}
                                staffName={staffName}
                                staffList={staffList}
                                storeLocation={storeLocation}
                                onOpenSauceLog={() => setActiveTab("saucelog")}
                            />
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

                        {/* Non-admin sees their assignment badge */}
                        {!currentIsAdmin && (
                            <div className="text-center text-xs font-bold py-1.5 rounded-lg mb-2 bg-green-50 text-green-700 border border-green-200">
                                {language === "es" ? "Mostrando tus tareas asignadas" : "Showing your assigned tasks"}
                            </div>
                        )}

                        {/* Manager dashboard — completion %, overdue, scoreboard.
                            Shown to all staff with Ops access (Andrew's call: "everyone that has access to that page"). */}
                        {(() => {
                            const fohStats = getCompletionStats("FOH");
                            const bohStats = getCompletionStats("BOH");
                            // Per-staff scoreboard: count completed items where checks[*+_by] = staffName
                            // Iterates all known checks and groups by who finished each.
                            const scoreboard = new Map();
                            const overdue = [];
                            const ALL_TASKS = (customTasks[checklistSide] && customTasks[checklistSide][PERIOD_KEY]) || [];
                            for (const t of ALL_TASKS) {
                                if (t.completeBy && !isTaskComplete(t)) {
                                    // Compare against Chicago wall-clock so devices in
                                    // other zones don't mis-flag.
                                    if (isPastTimeOfDay(t.completeBy)) overdue.push(t);
                                }
                            }
                            for (const k of Object.keys(checks)) {
                                if (!k.endsWith("_by")) continue;
                                const baseKey = k.slice(0, -3);
                                if (!checks[baseKey]) continue;
                                const name = checks[k];
                                if (!name) continue;
                                scoreboard.set(name, (scoreboard.get(name) || 0) + 1);
                            }
                            const top = [...scoreboard.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
                            const sidePct = (s) => s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
                            return (
                                <div className="rounded-xl border border-dd-line bg-white shadow-card p-3 mb-2">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-[11px] font-bold uppercase tracking-wider text-dd-text-2">{language === "es" ? "Resumen del día" : "Today's snapshot"}</span>
                                        {overdue.length > 0 && (
                                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
                                                🚨 {overdue.length} {language === "es" ? "atrasadas" : "overdue"}
                                            </span>
                                        )}
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 mb-2">
                                        <div className="bg-dd-green-50 border border-dd-green/30 rounded-lg p-2">
                                            <div className="flex justify-between items-baseline text-[11px] font-bold text-dd-green-700 mb-1.5">
                                                <span>FOH</span>
                                                <span className="tabular-nums">{fohStats.done}/{fohStats.total} · {sidePct(fohStats)}%</span>
                                            </div>
                                            <div className="w-full bg-white/60 rounded-full h-1.5 overflow-hidden">
                                                <div className="h-1.5 rounded-full bg-dd-green transition-all" style={{ width: sidePct(fohStats) + "%" }} />
                                            </div>
                                        </div>
                                        <div className="bg-orange-50 border border-orange-200 rounded-lg p-2">
                                            <div className="flex justify-between items-baseline text-[11px] font-bold text-orange-700 mb-1.5">
                                                <span>BOH</span>
                                                <span className="tabular-nums">{bohStats.done}/{bohStats.total} · {sidePct(bohStats)}%</span>
                                            </div>
                                            <div className="w-full bg-white/60 rounded-full h-1.5 overflow-hidden">
                                                <div className="h-1.5 rounded-full bg-orange-500 transition-all" style={{ width: sidePct(bohStats) + "%" }} />
                                            </div>
                                        </div>
                                    </div>
                                    {top.length > 0 && (
                                        <div className="flex flex-wrap gap-1">
                                            <span className="text-[10px] font-bold text-gray-500 mr-1">🏆</span>
                                            {top.map(([name, count]) => (
                                                <span key={name} className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${name === staffName ? "bg-mint-100 text-mint-800 border-mint-300" : "bg-white text-gray-600 border-gray-300"}`}>
                                                    {name === staffName ? "✓ " : ""}{name.split(" ")[0]} · {count}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })()}

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
                                <div key={item.id} className={"rounded-lg border-2 transition overflow-hidden " +
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
                                                        {item.task.includes("\n") ? item.task.split("\n").map((line, li) => (
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
                                                </div>
                                                {/* Assignee chips */}
                                                {assignees.length > 0 && (
                                                    <div className="flex flex-wrap gap-1 mt-1">
                                                        {assignees.map(name => (
                                                            <span key={name} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold">
                                                                {String.fromCodePoint(0x1F464)} {name.split(" ")[0]}
                                                                {currentIsAdmin && editMode && (
                                                                    <button onClick={(e) => { e.stopPropagation(); toggleTaskAssignee(origIdx, name); }}
                                                                        className="text-blue-400 hover:text-red-500 ml-0.5">{String.fromCodePoint(0x2715)}</button>
                                                                )}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                                {/* Quick assign button for admin (in edit mode) */}
                                                {currentIsAdmin && editMode && (
                                                    <div className="mt-1">
                                                        <select value="" onChange={e => { if (e.target.value) toggleTaskAssignee(origIdx, e.target.value); }}
                                                            className="border border-gray-200 rounded px-1 py-0.5 text-[10px] bg-white">
                                                            <option value="">+ {language === "es" ? "Asignar" : "Assign"}</option>
                                                            {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").filter(s => !assignees.includes(s.name)).map(s => (
                                                                <option key={s.id} value={s.name}>{s.name}</option>
                                                            ))}
                                                        </select>
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
                                                                                            await saveChecklistState(checksRef.current, updated, checklistAssignmentsRef.current, checklistListsRef.current);
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
                                                                                await saveChecklistState(checksRef.current, updated, checklistAssignmentsRef.current, checklistListsRef.current);
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
                                                                            onKeyDown={e => { if (e.key === "Enter" && commentDraft.trim()) { addTaskComment(item.id, commentDraft); setCommentDraft(""); } }}
                                                                            placeholder={language === "es" ? "Anota algo..." : "Type a note..."}
                                                                            className="flex-1 px-2 py-1 border border-blue-200 rounded text-[11px]" />
                                                                        <button onClick={() => { if (commentDraft.trim()) { addTaskComment(item.id, commentDraft); setCommentDraft(""); } }}
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
                                                    <img src={photoUrl} alt="Task photo" className="rounded-lg border border-gray-200 max-w-full cursor-pointer" style={{ maxHeight: "150px" }}
                                                        onClick={() => {
                                                            const w = window.open(photoUrl, "_blank");
                                                            if (!w) {
                                                                toast(language === "es" ? "Por favor permita ventanas emergentes para ver la foto." : "Please allow pop-ups to view the photo.");
                                                            }
                                                        }} />
                                                </div>
                                            ) : (
                                                <div>
                                                    <input type="file" accept="image/*" capture="environment"
                                                        ref={capturingPhoto === item.id ? photoInputRef : null}
                                                        onChange={e => handlePhotoCapture(e, item.id)}
                                                        className="hidden" id={"photo-" + item.id} />
                                                    <button onClick={() => { setCapturingPhoto(item.id); document.getElementById("photo-" + item.id)?.click(); }}
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
                );
            };

            return (
                <div className="p-4 pb-bottom-nav">
                    <h2 className="text-2xl font-bold text-mint-700 mb-4">{"\u{1F4CB}"} {t("dailyOps", language)}</h2>

                    {/* Labor % Card — gated by canViewLabor (admins/managers by default,
                        staff opt-in via Admin Panel toggle). Percentage only (no dollar
                        amounts even when visible). */}
                    {canViewLabor((staffList || []).find(s => s.name === staffName)) && laborData && laborData.laborPercent !== undefined && (() => {
                        const pct = laborData.laborPercent;
                        const updatedAt = laborData.updatedAt ? new Date(laborData.updatedAt) : null;
                        const minutesAgo = updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 60000) : null;
                        const isStale = minutesAgo !== null && minutesAgo > 10;
                        const color = pct <= 22 ? { bg: "bg-emerald-50", border: "border-emerald-400", text: "text-emerald-700", emoji: "\u{2705}" }
                                    : pct <= 27 ? { bg: "bg-amber-50", border: "border-amber-400", text: "text-amber-700", emoji: "\u{26A0}\u{FE0F}" }
                                    : { bg: "bg-red-50", border: "border-red-400", text: "text-red-700", emoji: "\u{1F534}" };
                        return (
                            <div className={`${color.bg} border-2 ${color.border} rounded-2xl p-4 mb-4 shadow-sm`}>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <span className="text-2xl">{color.emoji}</span>
                                        <div>
                                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("laborPercent", language)}</p>
                                            <p className={`text-3xl font-black tabular-nums ${color.text}`}>{pct.toFixed(1)}%</p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className={`text-xs ${isStale ? "text-red-500 font-bold" : "text-gray-400"}`}>
                                            {isStale ? "\u{26A0}\u{FE0F} " : ""}
                                            {updatedAt ? updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--"}
                                        </p>
                                        {minutesAgo !== null && (
                                            <p className="text-[10px] text-gray-400">{minutesAgo === 0 ? (language === "es" ? "ahora" : "just now") : `${minutesAgo} min`}</p>
                                        )}
                                    </div>
                                </div>
                                {/* Progress bar */}
                                <div className="mt-3 relative">
                                    <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full transition-all duration-500"
                                            style={{
                                                width: Math.min(pct / 37.5 * 100, 100) + "%",
                                                backgroundColor: pct <= 22 ? "#10b981" : pct <= 27 ? "#f59e0b" : "#ef4444"
                                            }} />
                                    </div>
                                    {/* Target marker at 25% */}
                                    <div className="absolute top-0 h-3 border-r-2 border-gray-600" style={{ left: (25 / 37.5 * 100) + "%" }}>
                                        <div className="absolute -top-4 -translate-x-1/2 text-[9px] font-bold text-gray-500">25%</div>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

                    <div className="flex gap-2 mb-6 flex-wrap">
                        <button onClick={() => { setActiveTab("checklist"); setEditMode(false); setEditingIdx(null); setShowAddForm(false); }}
                            className={`flex-1 min-w-[80px] py-2 rounded-lg font-bold transition ${activeTab === "checklist" ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-700"}`}>
                            {language === "es" ? "Tareas" : "Tasks"}
                        </button>
                        <button onClick={() => { setActiveTab("saucelog"); setEditMode(false); }}
                            className={`flex-1 min-w-[80px] py-2 rounded-lg font-bold transition ${activeTab === "saucelog" ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-700"}`}>
                            🥢 {language === "es" ? "Salsas" : "Sauce Log"}
                        </button>
                        <button onClick={() => { setActiveTab("inventory"); setEditMode(false); }}
                            className={`flex-1 min-w-[80px] py-2 rounded-lg font-bold transition ${activeTab === "inventory" ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-700"}`}>
                            {t("inventory", language)}
                        </button>
                        <button onClick={() => { setActiveTab("breaks"); setEditMode(false); }}
                            className={`flex-1 min-w-[80px] py-2 rounded-lg font-bold transition ${activeTab === "breaks" ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-700"}`}>
                            Breaks
                        </button>
                        <button onClick={() => { setActiveTab("prep"); setEditMode(false); }}
                            className={`flex-1 min-w-[80px] py-2 rounded-lg font-bold transition ${activeTab === "prep" ? "bg-orange-600 text-white" : "bg-gray-200 text-gray-700"}`}>
                            {language === "es" ? "Prep" : "Prep"}
                        </button>
                    </div>

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

                    {activeTab === "checklist" && renderChecklist()}

                    {activeTab === "saucelog" && (
                        <SauceLog
                            language={language}
                            staffName={staffName}
                            staffList={staffList}
                            storeLocation={storeLocation}
                        />
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
                                const cat = customInventory[newMasterCatIdx];
                                const newId = nextItemId(cat, newMasterCatIdx);
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
                                const updated = customInventory.map((c, i) =>
                                    i === newMasterCatIdx ? { ...c, items: [...c.items, newItem] } : c
                                );
                                setCustomInventory(updated);
                                await saveInventory(inventory, updated);
                                await saveVendorMatch(vendor, vendorId, newId);
                                closeEditor();
                            } catch (e) {
                                console.error("Create master item error:", e);
                                setMatchSaveError(e.message || String(e));
                                setNewMasterSaving(false);
                            }
                        };
                        return (
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
                        );
                    })()}

                    {activeTab === "inventory" && (
                        <div className="space-y-3">
                            {/* ── TOP TOOLBAR ── */}
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5">
                                    <button onClick={() => setInvViewMode("category")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "category" ? "bg-mint-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "📋 Lista Maestra" : "📋 Master List"}
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
                                <div className="flex items-center gap-1.5">
                                    <button onClick={printInventory} title="Print"
                                        className="w-9 h-9 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center hover:bg-blue-50 hover:text-blue-700 transition text-lg">
                                        {"\u{1F5A8}"}
                                    </button>
                                    <button onClick={() => { setInvEditMode(!invEditMode); setInvEditingIdx(null); setInvShowAddForm(null); }}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invEditMode ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {invEditMode ? (language === "es" ? "Listo" : "Done") : (language === "es" ? "Editar" : "Edit")}
                                    </button>
                                </div>
                            </div>

                            {/* ── LIVE PRICES INDICATOR ── */}
                            {(() => {
                                const ss = syscoScrapeStatus || {};
                                const lastScrapedMs = livePrices.sysco?.lastScraped ? new Date(livePrices.sysco.lastScraped).getTime() : 0;
                                const isStale = lastScrapedMs > 0 && (Date.now() - lastScrapedMs > 48 * 60 * 60 * 1000);
                                const hasFailed = ss.status && ss.status !== "success" && ss.status !== "running";
                                const hasData = livePrices.sysco && lastScrapedMs > 0;
                                const matchedInvCount = Object.keys(invToSyscoPrice).length;
                                const totalSyscoItems = livePrices.sysco?.totalItems || 0;

                                if (hasFailed) return (
                                    <div className="flex items-center gap-2 px-2 py-1 bg-red-50 rounded-lg border border-red-300">
                                        <span className="text-xs text-red-700 font-medium">{"\u{1F6A8}"} {ss.status === "login_failed" ? (language === "es" ? "Sysco login fallido" : "Sysco login failed") : (language === "es" ? "Error del scraper Sysco" : "Sysco scraper error")}</span>
                                        <span className="text-xs text-red-500 ml-auto">{ss.updatedAt ? new Date(ss.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</span>
                                    </div>
                                );
                                if (isStale && hasData) return (
                                    <div className="flex items-center gap-2 px-2 py-1 bg-yellow-50 rounded-lg border border-yellow-300">
                                        <span className="text-xs text-yellow-700 font-medium">{"\u{23F0}"} {language === "es" ? "Precios Sysco desactualizados" : "Sysco prices stale"}</span>
                                        <span className="text-xs text-yellow-500">{matchedInvCount} {language === "es" ? "vinculados" : "matched"} / {totalSyscoItems} total</span>
                                        <span className="text-xs text-gray-400 ml-auto">{language === "es" ? "Actualizado" : "Updated"}: {new Date(livePrices.sysco.lastScraped).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                                    </div>
                                );
                                if (hasData) return (
                                    <div className="flex items-center gap-2 px-2 py-1 bg-green-50 rounded-lg border border-green-200">
                                        <span className="text-xs text-green-700 font-medium">{"\u{1F4E1}"} {language === "es" ? "Precios Sysco en vivo" : "Sysco live prices"}</span>
                                        <span className="text-xs text-green-500">{matchedInvCount} {language === "es" ? "vinculados" : "matched"} / {totalSyscoItems} total</span>
                                        <span className="text-xs text-gray-400 ml-auto">{language === "es" ? "Actualizado" : "Updated"}: {new Date(livePrices.sysco.lastScraped).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                                    </div>
                                );
                                return null;
                            })()}

                            {/* ── SEARCH BAR ── */}
                            {!invEditMode && (
                                <div className="relative">
                                    <input type="text" value={invSearch} onChange={e => setInvSearch(e.target.value)}
                                        placeholder={language === "es" ? "\u{1F50D} Buscar artículo..." : "\u{1F50D} Search items..."}
                                        className={`w-full px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-mint-700 bg-white ${invSearch ? "pr-12" : ""}`} />
                                    {invSearch && (
                                        <button type="button" onClick={() => { setInvSearch(""); setCollapsedCats({}); }}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-full bg-gray-200 text-gray-600 active:bg-gray-300 text-base font-bold">{"\u{2715}"}</button>
                                    )}
                                </div>
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
                                        <button onClick={() => setInvShowOnlyCounted(!invShowOnlyCounted)}
                                            className={`text-xs font-bold px-2 py-1 rounded-lg transition ${invShowOnlyCounted ? "bg-mint-700 text-white" : "bg-mint-100 text-mint-700 hover:bg-mint-200"}`}>
                                            {invShowOnlyCounted ? (language === "es" ? "Ver Todo" : "Show All") : (language === "es" ? "Solo Contados" : "Counted Only")}
                                        </button>
                                    </div>
                                );
                            })()}

                            {/* ── CART MODAL ── multi-vendor comparison view ──
                                One row per counted item with all vendor prices side-by-side.
                                Cheapest vendor highlighted (🏆). Per-vendor totals + best-mix
                                summary at the bottom so the orderer can decide if splitting
                                between vendors is worth it. */}
                            {showCart && (() => {
                                // Helper: find the live vendor entry for a given vendor:vendorId combo
                                const findVendorEntry = (vendor, vendorId) => {
                                    const src = vendor === "sysco"
                                        ? (syscoPricingData?.sorted || [])
                                        : (usfoodsPricingData?.sorted || []);
                                    const found = src.find(([k]) => k === vendorId);
                                    return found ? found[1] : null;
                                };

                                // 1. Build cart rows (master items with counts + vendor-only items with counts)
                                const rows = [];
                                customInventory.forEach((cat) => {
                                    cat.items.forEach(item => {
                                        const qty = inventory[item.id] || 0;
                                        if (qty <= 0) return;
                                        rows.push({
                                            kind: "master",
                                            id: item.id,
                                            name: language === "es" && item.nameEs ? item.nameEs : item.name,
                                            altName: item.name,
                                            category: cat.name,
                                            qty,
                                            vendorPrices: invToVendorPrices[item.id] || [],
                                            preferredVendor: item.preferredVendor || item.vendor || "",
                                            pack: item.pack,
                                            addedFromVendor: item.addedFromVendor,
                                        });
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

                                // 2. Find all distinct vendors that have at least one price across the cart
                                const vendorSet = new Set();
                                rows.forEach(r => r.vendorPrices.forEach(p => p.price != null && vendorSet.add(p.vendor)));
                                const vendorList = Array.from(vendorSet).sort();
                                const vendorColor = (v) => v === "Sysco" ? "blue" : v === "US Foods" ? "orange" : "gray";

                                // 3. Per-vendor totals (if all items came from this vendor)
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

                                // 4. Best mix: pick cheapest vendor available per item
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

                                return (
                                    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center justify-center p-2" onClick={() => setShowCart(false)}>
                                        <div className="bg-white w-full max-w-3xl max-h-[92vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                                            {/* Header */}
                                            <div className="bg-mint-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                                                <h3 className="font-bold text-base sm:text-lg">{"\u{1F6D2}"} {language === "es" ? "Carrito" : "Cart"} — {totalItems} {language === "es" ? "artículos" : "items"} · {totalQty} {language === "es" ? "total" : "total"}</h3>
                                                <button onClick={() => setShowCart(false)} className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center text-white font-bold hover:bg-white/30 transition">{"\u{2715}"}</button>
                                            </div>
                                            {/* Comparison table */}
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
                                                            {rows.map(r => {
                                                                const cheapestVendor = r.vendorPrices.find(p => p.price != null)?.vendor;
                                                                const isVendorOnly = r.kind === "vendor-only";
                                                                return (
                                                                    <tr key={r.id} className={`border-t ${isVendorOnly ? "bg-orange-50/40" : "hover:bg-gray-50"}`}>
                                                                        <td className="px-3 py-2">
                                                                            <div className="font-medium text-gray-800 flex items-center gap-1">
                                                                                {isVendorOnly && <span className={`text-[9px] font-bold px-1 py-0.5 rounded border bg-${vendorColor(r.vendorOnlyOrigin)}-100 text-${vendorColor(r.vendorOnlyOrigin)}-700 border-${vendorColor(r.vendorOnlyOrigin)}-300`}>{r.vendorOnlyOrigin}</span>}
                                                                                {r.addedFromVendor && <span className={`w-1.5 h-1.5 rounded-full bg-${vendorColor(r.addedFromVendor)}-500`} title={`Added from ${r.addedFromVendor}`} />}
                                                                                <span>{r.name}</span>
                                                                            </div>
                                                                            <div className="text-[10px] text-gray-400">{r.category}{r.pack ? ` · ${r.pack}` : ""}</div>
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
                                                            })}
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
                                            {/* Footer buttons */}
                                            <div className="border-t border-gray-200 p-3 flex gap-2 flex-shrink-0 bg-gray-50">
                                                <button onClick={printInventory} className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 active:scale-95 transition">
                                                    {"\u{1F5A8}\u{FE0F}"} {language === "es" ? "Imprimir" : "Print"}
                                                </button>
                                                <button onClick={() => setShowCart(false)} className="flex-1 py-3 bg-gray-200 text-gray-700 rounded-xl font-bold text-sm hover:bg-gray-300 active:scale-95 transition">
                                                    {"\u{2715}"} {language === "es" ? "Cerrar" : "Close"}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* ── CATEGORY VIEW ── */}
                            {invViewMode === "category" && customInventory.map((category, catIdx) => {
                                // Same filter pattern used by vendor / split / pricing views.
                                const searchLower = (invSearch || "").toLowerCase().trim();
                                let filteredItems = searchLower
                                    ? category.items.filter(item => itemMatchesSearch(item, searchLower))
                                    : category.items;
                                if (invShowOnlyCounted) {
                                    filteredItems = filteredItems.filter(item => (inventory[item.id] || 0) > 0);
                                }
                                // Hide the whole category card when a filter is active and nothing matches.
                                if ((searchLower || invShowOnlyCounted) && filteredItems.length === 0) return null;

                                const catKey = "cat-" + catIdx;
                                const isCollapsed = collapsedCats[catKey] && !searchLower;
                                const countedInCat = category.items.filter(i => (inventory[i.id] || 0) > 0).length;

                                // Group by subcategory
                                const subcats = [];
                                let currentSub = null;
                                filteredItems.forEach(item => {
                                    const sub = item.subcat || "";
                                    if (sub !== currentSub) {
                                        subcats.push({ name: sub, items: [] });
                                        currentSub = sub;
                                    }
                                    subcats[subcats.length - 1].items.push(item);
                                });

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
                                            {subcats.map((subGroup, subIdx) => (
                                                <div key={subIdx}>
                                                    {/* Subcategory header */}
                                                    {subGroup.name && (
                                                        <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-100">
                                                            <span className="text-xs font-bold text-blue-700 uppercase tracking-wide">{subGroup.name}</span>
                                                        </div>
                                                    )}

                                                    {subGroup.items.map((item) => {
                                                        const itemIdx = category.items.indexOf(item);
                                                        const count = inventory[item.id] || 0;
                                                        const isEditing = invEditMode && invEditingIdx && invEditingIdx.catIdx === catIdx && invEditingIdx.itemIdx === itemIdx;
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
                                                                        </div>
                                                                        <div className="flex gap-2">
                                                                            <button onClick={() => saveInvEdit(catIdx, itemIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Guardar" : "Save"}</button>
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
                                                                                }} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">{"\u{270F}\u{FE0F}"} Edit</button>
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
                                                                        </div>
                                                                        <div className="flex items-center gap-1 flex-shrink-0">
                                                                            <>
                                                                                <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1))}
                                                                                    className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                                <span className={`w-10 text-center font-bold text-lg ${count > 0 ? "text-green-700" : "text-gray-300"}`}>{count}</span>
                                                                                <button onClick={() => updateInventoryCount(item.id, count + 1)}
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
                                            {/* Write-in */}
                                            {!invEditMode && (
                                                <div className="px-3 py-2 bg-gray-50">
                                                    <div className="flex items-center gap-2">
                                                        <input type="text"
                                                            value={writeInValues[catIdx] || ""}
                                                            onChange={e => setWriteInValues(prev => ({ ...prev, [catIdx]: e.target.value }))}
                                                            onKeyDown={e => { if (e.key === "Enter") quickAddItem(catIdx); }}
                                                            placeholder={language === "es" ? "\u{270D}\u{FE0F} Escribir artículo..." : "\u{270D}\u{FE0F} Write in item..."}
                                                            className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:border-mint-500" />
                                                        {(writeInValues[catIdx] || "").trim() && (
                                                            <button onClick={() => quickAddItem(catIdx)}
                                                                className="px-3 py-1.5 bg-mint-600 text-white rounded-lg text-xs font-bold hover:bg-mint-700 active:scale-95 transition">
                                                                {language === "es" ? "Agregar" : "Add"}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
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
                                const searchLower = (invSearch || "").toLowerCase().trim();
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

                            {/* ── VENDOR VIEW ── */}
                            {invViewMode === "vendor" && (() => {
                                const vendorGroups = {};
                                const searchLower = (invSearch || "").toLowerCase().trim();
                                customInventory.forEach((cat, catIdx) => {
                                    cat.items.forEach(item => {
                                        const v = item.vendor || item.supplier || "Other";
                                        if (!vendorGroups[v]) vendorGroups[v] = [];
                                        const matchesCounted = !invShowOnlyCounted || (inventory[item.id] || 0) > 0;
                                        if (itemMatchesSearch(item, searchLower) && matchesCounted) {
                                            vendorGroups[v].push({ ...item, catIdx, itemIdx: cat.items.indexOf(item), catName: cat.name, catNameEs: cat.nameEs });
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
                                                                            }} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">{"\u{270F}\u{FE0F}"} Edit</button>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-1 flex-shrink-0">
                                                                        <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1))}
                                                                            className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                        <span className={`w-10 text-center font-bold text-lg ${count > 0 ? "text-green-700" : "text-gray-300"}`}>{count}</span>
                                                                        <button onClick={() => updateInventoryCount(item.id, count + 1)}
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
                                const searchLower = invSearch.toLowerCase().trim();

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
                                                        ? category.items.filter(item => itemMatchesSearch(item, searchLower))
                                                        : category.items;
                                                    if (invShowOnlyCounted) filteredItems = filteredItems.filter(item => (inventory[item.id] || 0) > 0);
                                                    if (filteredItems.length === 0) return null;
                                                    const countedInCat = category.items.filter(i => (inventory[i.id] || 0) > 0).length;
                                                    return (
                                                        <div key={catIdx}>
                                                            <div className="px-3 py-1.5 bg-gray-50 border-y border-gray-100 flex justify-between items-center">
                                                                <span className="text-xs font-bold text-gray-500 uppercase">{language === "es" ? category.nameEs : category.name}</span>
                                                                {countedInCat > 0 && <span className="text-xs text-mint-700 font-bold">{countedInCat} {"\u{2713}"}</span>}
                                                            </div>
                                                            <div className="divide-y divide-gray-100">
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
                                                                                                <button onClick={() => { const updated = { ...splitOverrides }; delete updated[item.id]; setSplitOverrides(updated); saveSplitConfig(updated, splitWriteIns); setSplitMovingItem(null); }}
                                                                                                    className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-lg font-bold hover:bg-gray-200 active:scale-95 transition">
                                                                                                    {"\u{21A9}"} {language === "es" ? "Original" : "Reset"}
                                                                                                </button>
                                                                                            )}
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                                <div className="flex items-center gap-1 flex-shrink-0">
                                                                                    <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1))}
                                                                                        className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                                    <span className={`w-10 text-center font-bold text-lg ${count > 0 ? "text-green-700" : "text-gray-300"}`}>{count}</span>
                                                                                    <button onClick={() => updateInventoryCount(item.id, count + 1)}
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
                            {invViewMode === "pricing" && (() => {
                                const isSysco = pricingVendor === "sysco";
                                const pData = isSysco ? syscoPricingData : usfoodsPricingData;
                                const sorted = pData.sorted || [];
                                const matchedCount = pData.matchedCount || 0;
                                const withPriceCount = pData.withPriceCount || 0;
                                const vendorData = isSysco ? (pData.syscoData || {}) : (pData.ufData || {});
                                const vendorName = isSysco ? "Sysco" : "US Foods";
                                const vendorColor = isSysco ? "blue" : "orange";

                                // Scrape health status
                                const scrapeStatus = (isSysco ? syscoScrapeStatus : usfoodsScrapeStatus) || {};
                                const triggerStatus = isSysco ? syscoTriggerStatus : usfoodsTriggerStatus;
                                const setTriggerStatus = isSysco ? setSyscoTriggerStatus : setUsfoodsTriggerStatus;
                                const triggerDocName = isSysco ? "sysco_trigger" : "usfoods_trigger";
                                const lastScrapedMs = vendorData.lastScraped ? new Date(vendorData.lastScraped).getTime() : 0;
                                const isStale = lastScrapedMs > 0 && (Date.now() - lastScrapedMs > 48 * 60 * 60 * 1000);
                                const hasFailed = scrapeStatus.status && scrapeStatus.status !== "success" && scrapeStatus.status !== "running";

                                return (
                                    <div className="space-y-2">
                                        {/* Vendor toggle */}
                                        <div className="flex gap-2">
                                            <button onClick={() => setPricingVendor("sysco")}
                                                className={`flex-1 py-2 rounded-xl text-sm font-bold transition ${pricingVendor === "sysco" ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                                Sysco
                                            </button>
                                            <button onClick={() => setPricingVendor("usfoods")}
                                                className={`flex-1 py-2 rounded-xl text-sm font-bold transition ${pricingVendor === "usfoods" ? "bg-orange-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                                US Foods
                                            </button>
                                        </div>

                                        {/* Surfaces a known-bad data condition: two master items sharing
                                            an ID would make the audit list show the wrong "matched to..."
                                            name. Admin sees this and can merge the dupes via Master List. */}
                                        {currentIsAdmin && invIdCollisions.length > 0 && (
                                            <div className="rounded-xl border-2 border-red-300 bg-red-50 p-3 text-xs text-red-800 space-y-1">
                                                <div className="font-bold">⚠️ {invIdCollisions.length} duplicate ID{invIdCollisions.length === 1 ? "" : "s"} in master list</div>
                                                <div className="text-[10px]">Match-audit names will be wrong until these are resolved. Open Master List → Edit → use ↔️ Merge to combine duplicates:</div>
                                                <ul className="text-[10px] list-disc list-inside space-y-0.5">
                                                    {invIdCollisions.slice(0, 8).map((d, i) => (
                                                        <li key={i}><b>#{d.id}</b> ({d.cat}): "{d.prevName}" + "{d.name}"</li>
                                                    ))}
                                                    {invIdCollisions.length > 8 && <li>…and {invIdCollisions.length - 8} more</li>}
                                                </ul>
                                            </div>
                                        )}

                                        {/* ── Match Audit controls (admin only) ──
                                            Lets the user go through every vendor item, confirm or fix the
                                            inventory match, and lock items that should stay unmatched. */}
                                        {currentIsAdmin && (
                                            <div className="rounded-xl border-2 border-purple-200 bg-purple-50 p-2 space-y-2">
                                                <div className="flex items-center justify-between gap-2">
                                                    <div>
                                                        <p className="text-xs font-bold text-purple-700">{language === "es" ? "Auditoría de Coincidencias" : "Match Audit"}</p>
                                                        <p className="text-[10px] text-purple-500">{language === "es" ? "Vincula artículos del proveedor al inventario" : "Link vendor items to inventory"}</p>
                                                    </div>
                                                    <button onClick={() => setMatchAuditMode(!matchAuditMode)}
                                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${matchAuditMode ? "bg-purple-700 text-white" : "bg-white text-purple-700 border border-purple-300 hover:bg-purple-100"}`}>
                                                        {matchAuditMode ? (language === "es" ? "Salir" : "Exit") : (language === "es" ? "Editar" : "Edit")}
                                                    </button>
                                                </div>
                                                {matchAuditMode && (
                                                    <div className="flex flex-wrap gap-1">
                                                        {[
                                                            { key: "all",        label: language === "es" ? "Todos"            : "All" },
                                                            { key: "review",     label: language === "es" ? "🤖 Revisar"        : "🤖 Review" },
                                                            { key: "confirmed",  label: language === "es" ? "✅ Confirmados"    : "✅ Confirmed" },
                                                            { key: "unmatched",  label: language === "es" ? "⚠️ Sin coincidencia" : "⚠️ Unmatched" },
                                                        ].map(f => (
                                                            <button key={f.key} onClick={() => setMatchAuditFilter(f.key)}
                                                                className={`px-2 py-1 rounded-full text-[10px] font-bold border transition ${matchAuditFilter === f.key ? "bg-purple-700 text-white border-purple-700" : "bg-white text-purple-600 border-purple-200 hover:bg-purple-100"}`}>
                                                                {f.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Scrape health alert */}
                                        {(hasFailed || isStale) && (
                                            <div className={`rounded-xl p-3 border text-sm ${hasFailed ? "bg-red-50 border-red-300" : "bg-yellow-50 border-yellow-300"}`}>
                                                <div className="font-bold text-sm">
                                                    {hasFailed ? (scrapeStatus.status === "login_failed"
                                                        ? (language === "es" ? `\u{1F6A8} Fallo de inicio de sesion en ${vendorName}` : `\u{1F6A8} ${vendorName} Login Failed`)
                                                        : scrapeStatus.status === "no_prices"
                                                            ? (language === "es" ? "\u{26A0}\u{FE0F} No se encontraron precios" : "\u{26A0}\u{FE0F} No Prices Found")
                                                            : (language === "es" ? "\u{274C} Error del scraper" : "\u{274C} Scraper Error")
                                                    ) : (language === "es" ? "\u{23F0} Datos desactualizados (>48h)" : "\u{23F0} Stale Data (>48h old)")}
                                                </div>
                                                {scrapeStatus.detail && <div className="text-xs text-gray-600 mt-1">{scrapeStatus.detail}</div>}
                                                {scrapeStatus.updatedAt && <div className="text-xs text-gray-400 mt-1">{language === "es" ? "Ultimo intento" : "Last attempt"}: {new Date(scrapeStatus.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>}
                                            </div>
                                        )}

                                        {/* Header */}
                                        <div className={`bg-gradient-to-r ${isSysco ? "from-blue-700 to-blue-600" : "from-orange-600 to-orange-500"} text-white rounded-xl p-3 flex items-center justify-between`}>
                                            <div>
                                                <div className="font-bold text-sm">{language === "es" ? `Precios de ${vendorName} — Historial` : `${vendorName} Pricing — Purchase History`}</div>
                                                <div className={`${isSysco ? "text-blue-200" : "text-orange-200"} text-xs mt-0.5`}>
                                                    {sorted.length} {language === "es" ? "articulos" : "items"} &middot; {withPriceCount} {language === "es" ? "con precio" : "with prices"} &middot; {matchedCount} {language === "es" ? "vinculados" : "matched"}
                                                    {vendorData.lastScraped && (<> &middot; {language === "es" ? "Actualizado" : "Updated"}: {new Date(vendorData.lastScraped).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</>)}
                                                </div>
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    if (triggerStatus === "requesting" || triggerStatus === "running") return;
                                                    setTriggerStatus("requesting");
                                                    try {
                                                        await setDoc(doc(db, "vendor_prices", triggerDocName), {
                                                            trigger: true,
                                                            requestedAt: new Date().toISOString(),
                                                            requestedBy: staffName || "unknown",
                                                            status: "pending"
                                                        });
                                                    } catch (e) {
                                                        console.error("Trigger error:", e);
                                                        setTriggerStatus("error");
                                                        setTimeout(() => setTriggerStatus(null), 4000);
                                                    }
                                                }}
                                                disabled={triggerStatus === "requesting" || triggerStatus === "running"}
                                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                                                    triggerStatus === "running" || triggerStatus === "requesting"
                                                        ? "bg-white/10 text-white/60 cursor-wait"
                                                        : triggerStatus === "done"
                                                            ? "bg-green-500/30 text-green-100"
                                                            : triggerStatus === "error"
                                                                ? "bg-red-500/30 text-red-100"
                                                                : "bg-white/20 hover:bg-white/30 text-white cursor-pointer"
                                                }`}
                                                title={language === "es" ? "Solicitar actualizacion de precios" : "Request price refresh"}
                                            >
                                                {triggerStatus === "running" || triggerStatus === "requesting" ? (
                                                    <><span className="animate-spin inline-block">{"\u{1F504}"}</span> {language === "es" ? "Actualizando..." : "Refreshing..."}</>
                                                ) : triggerStatus === "done" ? (
                                                    <>{"\u{2705}"} {language === "es" ? "Listo" : "Done!"}</>
                                                ) : triggerStatus === "error" ? (
                                                    <>{"\u{274C}"} {language === "es" ? "Error" : "Error"}</>
                                                ) : (
                                                    <>{"\u{1F504}"} {language === "es" ? "Actualizar Precios" : "Refresh Prices"}</>
                                                )}
                                            </button>
                                        </div>

                                        {/* Scraper running indicator */}
                                        {scrapeStatus.status === "running" && (
                                            <div className="text-center py-2 text-blue-600 text-xs bg-blue-50 rounded-lg border border-blue-200 animate-pulse">
                                                {"\u{1F504}"} {language === "es" ? "Scraper ejecutandose ahora..." : "Scraper running now..."}
                                            </div>
                                        )}

                                        {sorted.length === 0 && scrapeStatus.status !== "running" && (
                                            <div className="text-center py-3 text-gray-400 text-xs bg-yellow-50 rounded-lg border border-yellow-200">
                                                {language === "es" ? "Esperando datos del scraper. Los precios se actualizan diariamente." : "Waiting for scraper data. Prices update daily."}
                                            </div>
                                        )}

                                        {/* Category-grouped items (Sysco) or flat list (US Foods) */}
                                        {isSysco && pData.byCategory ? (
                                            SYSCO_CATEGORY_ORDER.filter(cat => pData.byCategory[cat] && pData.byCategory[cat].length > 0).map(cat => {
                                                const searchLower = (invSearch || "").toLowerCase().trim();
                                                const allCatItems = pData.byCategory[cat];
                                                // Pricing view also matches brand + sysco/usfoods key — useful here because the
                                                // user is shopping by SKU/brand rather than just by item name.
                                                let catItems = searchLower
                                                    ? allCatItems.filter(([key, data]) =>
                                                        itemMatchesSearch(data, searchLower) ||
                                                        (data.brand || "").toLowerCase().includes(searchLower) ||
                                                        (key || "").toLowerCase().includes(searchLower))
                                                    : allCatItems;
                                                // Audit-mode filter: review (auto), confirmed, unmatched
                                                if (matchAuditMode && matchAuditFilter !== "all") {
                                                    catItems = catItems.filter(([, d]) => {
                                                        if (matchAuditFilter === "review") return d.matchType === "auto";
                                                        if (matchAuditFilter === "confirmed") return d.matchType === "confirmed";
                                                        if (matchAuditFilter === "unmatched") return !d.invId;
                                                        return true;
                                                    });
                                                }
                                                if (catItems.length === 0) return null;
                                                const catEmoji = SYSCO_CATEGORY_EMOJI[cat] || "";
                                                const catCollapsed = collapsedCats["sysco_" + cat] && !searchLower;
                                                const catSaleCount = catItems.filter(([,d]) => d.originalPrice && d.originalPrice !== d.price).length;
                                                return (
                                                    <div key={cat}>
                                                        <button onClick={() => setCollapsedCats(prev => ({...prev, ["sysco_" + cat]: !prev["sysco_" + cat]}))}
                                                            className="w-full flex items-center justify-between px-3 py-2 bg-gray-100 rounded-xl mt-2 hover:bg-gray-200 transition">
                                                            <div className="flex items-center gap-2">
                                                                <span>{catEmoji}</span>
                                                                <span className="font-bold text-sm text-gray-700">{cat}</span>
                                                                <span className="text-xs text-gray-400">({catItems.length})</span>
                                                                {catSaleCount > 0 && <span className="text-xs text-red-500 font-bold">{catSaleCount} on sale</span>}
                                                            </div>
                                                            <span className="text-gray-400 text-xs">{catCollapsed ? "\u{25B6}" : "\u{25BC}"}</span>
                                                        </button>
                                                        {!catCollapsed && catItems.map(([key, data]) => {
                                                            const invItem = data.invId ? invLookup[data.invId] : null;
                                                            const isMatched = !!data.invId;
                                                            const isLocked = data.matchType === "locked";
                                                            const cardBg = isLocked ? "bg-gray-50 border-gray-300" :
                                                                          data.matchType === "confirmed" ? "bg-green-50 border-green-300" :
                                                                          data.matchType === "auto" ? "bg-yellow-50 border-yellow-200" :
                                                                          isMatched ? "bg-green-50 border-green-200" :
                                                                          "bg-white border-gray-200";
                                                            return (
                                                                <div key={key} className={`rounded-xl p-3 border mt-1 ${cardBg}`}>
                                                                    <div className="flex items-start justify-between gap-2">
                                                                        <div className="flex-1 min-w-0">
                                                                            <div className="font-bold text-sm text-gray-800 truncate">{data.name || `Sysco Item ${key}`}</div>
                                                                            {invItem ? (
                                                                                <div className={`text-xs mt-0.5 ${data.matchType === "auto" ? "text-yellow-700" : "text-green-600"}`}>
                                                                                    {data.matchType === "confirmed" ? "✅" : data.matchType === "auto" ? "🤖" : "↔️"} {invItem.name}
                                                                                    {data.matchType === "auto" && <span className="ml-1 opacity-70">({language === "es" ? "automático — revisar" : "auto — review"})</span>}
                                                                                </div>
                                                                            ) : isLocked ? (
                                                                                <div className="text-xs text-gray-500 mt-0.5">🔒 {language === "es" ? "Bloqueado sin coincidencia" : "Locked unmatched"}</div>
                                                                            ) : (
                                                                                <div className="text-xs text-gray-500 mt-0.5">⚠️ {language === "es" ? "Sin coincidencia" : "No match"}</div>
                                                                            )}
                                                                            {currentIsAdmin && matchAuditMode && (
                                                                                <button
                                                                                    onClick={() => { setMatchEditor({ vendor: "sysco", vendorId: key, vendorName: data.name, currentInvId: data.invId, matchType: data.matchType }); setMatchSearchQuery(""); }}
                                                                                    className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-600 text-white text-[10px] font-bold hover:bg-purple-700">
                                                                                    ✏️ {language === "es" ? "Editar coincidencia" : "Edit match"}
                                                                                </button>
                                                                            )}
                                                                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-gray-500">
                                                                                {data.pack && <span>{language === "es" ? "Paquete" : "Pack"}: {data.pack}</span>}
                                                                                {data.brand && <span>{data.brand}</span>}
                                                                                {key && <span className="text-gray-400">#{key}</span>}
                                                                            </div>
                                                                            {data.lastOrdered && (
                                                                                <div className="text-xs text-gray-400 mt-0.5">{language === "es" ? "Ultimo pedido" : "Last ordered"}: {data.lastOrdered}</div>
                                                                            )}
                                                                        </div>
                                                                        <div className="text-right flex-shrink-0">
                                                                            {data.price != null ? (
                                                                                <>
                                                                                    {data.originalPrice && data.originalPrice !== data.price ? (
                                                                                        <>
                                                                                            <div className="text-sm text-gray-400 line-through">${typeof data.originalPrice === "number" ? data.originalPrice.toFixed(2) : data.originalPrice}</div>
                                                                                            <div className="font-bold text-lg text-red-600">${typeof data.price === "number" ? data.price.toFixed(2) : data.price}</div>
                                                                                        </>
                                                                                    ) : (
                                                                                        <div className="font-bold text-lg text-blue-700">${typeof data.price === "number" ? data.price.toFixed(2) : data.price}</div>
                                                                                    )}
                                                                                    <div className="text-xs text-gray-500">/{data.unit === "EA" ? "each" : data.unit === "CS" ? "case" : data.unit || "case"}</div>
                                                                                </>
                                                                            ) : (
                                                                                <div className="text-xs text-gray-300 italic">{language === "es" ? "pendiente" : "pending"}</div>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                );
                                            })
                                        ) : (
                                            (() => {
                                                let unmatchedHeaderShown = false;
                                                const searchLower = (invSearch || "").toLowerCase().trim();
                                                let filteredSorted = searchLower
                                                    ? sorted.filter(([key, data]) =>
                                                        itemMatchesSearch(data, searchLower) ||
                                                        (data.brand || "").toLowerCase().includes(searchLower) ||
                                                        (key || "").toLowerCase().includes(searchLower))
                                                    : sorted;
                                                if (matchAuditMode && matchAuditFilter !== "all") {
                                                    filteredSorted = filteredSorted.filter(([, d]) => {
                                                        if (matchAuditFilter === "review") return d.matchType === "auto";
                                                        if (matchAuditFilter === "confirmed") return d.matchType === "confirmed";
                                                        if (matchAuditFilter === "unmatched") return !d.invId;
                                                        return true;
                                                    });
                                                }
                                                return filteredSorted.map(([key, data]) => {
                                                    const invItem = data.invId ? invLookup[data.invId] : null;
                                                    const isMatched = !!data.invId;
                                                    const isLocked = data.matchType === "locked";
                                                    const showUnmatchedHeader = !isMatched && !unmatchedHeaderShown && matchedCount > 0;
                                                    if (showUnmatchedHeader) unmatchedHeaderShown = true;
                                                    const cardBg = isLocked ? "bg-gray-50 border-gray-300" :
                                                                  data.matchType === "confirmed" ? "bg-green-50 border-green-300" :
                                                                  data.matchType === "auto" ? "bg-yellow-50 border-yellow-200" :
                                                                  isMatched ? "bg-green-50 border-green-200" :
                                                                  "bg-white border-gray-200";
                                                    return (
                                                        <div key={key}>
                                                            {showUnmatchedHeader && (
                                                                <div className="text-xs font-bold text-gray-500 px-1 pt-2 pb-1">{"\u{1F4E6}"} {language === "es" ? "Solo en US Foods" : "US Foods Only"} ({sorted.length - matchedCount})</div>
                                                            )}
                                                            <div className={`rounded-xl p-3 border ${cardBg}`}>
                                                                <div className="flex items-start justify-between gap-2">
                                                                    <div className="flex-1 min-w-0">
                                                                        <div className="font-bold text-sm text-gray-800 truncate">{data.name || `Item ${key}`}</div>
                                                                        {invItem ? (
                                                                            <div className={`text-xs mt-0.5 ${data.matchType === "auto" ? "text-yellow-700" : "text-green-600"}`}>
                                                                                {data.matchType === "confirmed" ? "✅" : data.matchType === "auto" ? "🤖" : "↔️"} {invItem.name}
                                                                                {data.matchType === "auto" && <span className="ml-1 opacity-70">({language === "es" ? "automático — revisar" : "auto — review"})</span>}
                                                                            </div>
                                                                        ) : isLocked ? (
                                                                            <div className="text-xs text-gray-500 mt-0.5">🔒 {language === "es" ? "Bloqueado sin coincidencia" : "Locked unmatched"}</div>
                                                                        ) : (
                                                                            <div className="text-xs text-gray-500 mt-0.5">⚠️ {language === "es" ? "Sin coincidencia" : "No match"}</div>
                                                                        )}
                                                                        {currentIsAdmin && matchAuditMode && (
                                                                            <button
                                                                                onClick={() => { setMatchEditor({ vendor: "usfoods", vendorId: key, vendorName: data.name, currentInvId: data.invId, matchType: data.matchType }); setMatchSearchQuery(""); }}
                                                                                className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-600 text-white text-[10px] font-bold hover:bg-purple-700">
                                                                                ✏️ {language === "es" ? "Editar coincidencia" : "Edit match"}
                                                                            </button>
                                                                        )}
                                                                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-gray-500">
                                                                            {data.pack && <span>{language === "es" ? "Paquete" : "Pack"}: {data.pack}</span>}
                                                                            {data.brand && <span>{data.brand}</span>}
                                                                            {key && <span className="text-gray-400">#{key}</span>}
                                                                        </div>
                                                                        {data.lastOrdered && (
                                                                            <div className="text-xs text-gray-400 mt-0.5">{language === "es" ? "Ultimo pedido" : "Last ordered"}: {data.lastOrdered}</div>
                                                                        )}
                                                                    </div>
                                                                    <div className="text-right flex-shrink-0">
                                                                        {data.price != null ? (
                                                                            <>
                                                                                {data.originalPrice && data.originalPrice !== data.price ? (
                                                                                    <>
                                                                                        <div className="text-sm text-gray-400 line-through">${typeof data.originalPrice === "number" ? data.originalPrice.toFixed(2) : data.originalPrice}</div>
                                                                                        <div className="font-bold text-lg text-red-600">${typeof data.price === "number" ? data.price.toFixed(2) : data.price}</div>
                                                                                    </>
                                                                                ) : (
                                                                                    <div className="font-bold text-lg text-blue-700">${typeof data.price === "number" ? data.price.toFixed(2) : data.price}</div>
                                                                                )}
                                                                                <div className="text-xs text-gray-500">/{data.unit === "EA" ? "each" : data.unit === "CS" ? "case" : data.unit || "case"}</div>
                                                                            </>
                                                                        ) : (
                                                                            <div className="text-xs text-gray-300 italic">{language === "es" ? "pendiente" : "pending"}</div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                });
                                            })()
                                        )}
                                    </div>
                                );
                            })()}

                            {/* ── SAVE & RESET ── */}
                            {!invEditMode && invViewMode !== "pricing" && (
                                <div className="sticky bottom-20 pt-3">
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

                            {/* ── SAVED LISTS ── */}
                            <div className="mt-6 pt-4 border-t-2 border-gray-200">
                                <h3 className="text-lg font-bold text-mint-700 mb-1">{"\u{1F4E6}"} {language === "es" ? "Listas Guardadas" : "Saved Lists"}</h3>
                                <p className="text-xs text-gray-500 mb-3">{language === "es"
                                    ? "Revisa conteos anteriores, marca lo que ya se pidió."
                                    : "Review past counts, check off what's been ordered."}</p>
                                <InventoryHistory language={language} customInventory={customInventory} storeLocation={storeLocation} />
                            </div>
                        </div>
                    )}

                    {activeTab === "breaks" && (
                        <div className="space-y-4">
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
                                    const todayDocSnap = await getDoc(doc(db, "ops", "breakPlan_" + storeLocation + "_" + getTodayKey()));
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
                                                {bohStaff.map((staff, idx) => (
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
                                            const count = bohStaff.filter(st => skillsMatrix[st.name + "_" + s.id]).length;
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
                                                    {(pos.id === "manager" ? (staffList || []).filter(s => ["Kitchen Manager", "Asst Kitchen Manager", "Manager", "Shift Lead"].includes(s.role) && (s.location === storeLocation || s.location === "both")) : bohStaff).map(s => (
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
                                        const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
                                        const staffMap = getStaffPositionMap();
                                        let html = `<html><head><title>Break Plan - ${today}</title><style>
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
                                        html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://ddmauapp.github.io/dd-mau-portal/'}},300)">✕ Close</button><button class="btn-print" onclick="window.print()">🖨️ Print</button></div>`;
                                        html += `<h1>\u{1F35C} DD Mau Break Plan</h1><div class="date">${today}</div>`;

                                        // Stations
                                        html += `<div class="section"><div class="section-header">\u{1F4CB} Today's Stations</div><div class="station-grid">`;
                                        ALL_POSITIONS.forEach(pos => {
                                            const person = breakPlan.stations?.[pos.id] || "\u{2014}";
                                            html += `<div class="station"><div class="station-name">${pos.emoji} ${pos.nameEn}</div><div class="station-person">${person}</div></div>`;
                                        });
                                        html += `</div></div>`;

                                        // Break waves
                                        BREAK_WAVES.forEach((wave, waveIdx) => {
                                            const breakers = getWaveBreakers(wave.id);
                                            const available = getAvailableCovers(wave.id);
                                            const needCover = getPositionsNeedingCover(wave.id);
                                            html += `<div class="section"><div class="wave-header">${wave.nameEn}</div><div class="wave-body">`;
                                            if (breakers.length > 0) {
                                                html += `<div style="margin-bottom:6px"><span class="breakers">On break: ${breakers.map(n => n.split(" ")[0]).join(", ")}</span></div>`;
                                                needCover.forEach(nc => {
                                                    const coverName = nc.cover ? nc.cover.split(" ")[0] : "\u{26A0}\u{FE0F} UNCOVERED";
                                                    html += `<div class="wave-row"><span>${nc.pos.emoji} ${nc.pos.nameEn} <span class="cover-label">(${nc.person.split(" ")[0]} on break)</span></span><span class="cover-name">\u{2192} ${coverName}</span></div>`;
                                                });
                                                if (available.length > 0) {
                                                    html += `<div class="working">Still working: ${available.map(n => { const positions = (staffMap[n] || []).map(p => p.emoji).join(""); return positions + " " + n.split(" ")[0]; }).join(", ")}</div>`;
                                                }
                                            } else {
                                                html += `<div style="color:#999;font-size:13px">No breaks assigned</div>`;
                                            }
                                            html += `</div></div>`;
                                        });

                                        html += `</body></html>`;
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
                        <PrepList
                            language={language}
                            staffName={staffName}
                            storeLocation={storeLocation}
                            staffList={staffList}
                        />
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

