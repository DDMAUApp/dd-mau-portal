// Position templates — role → sensible default access profile.
//
// When admin assigns a role from the picker and clicks "Apply template", the
// matching entry below fills every access flag at once. The admin can then
// tweak individual toggles before saving. Templates are NOT applied
// automatically on role change — that would overwrite manual customization
// silently. They're a one-click "give me reasonable defaults" affordance.
//
// FIELDS each template can set (everything is optional):
//   scheduleSide:            'foh' | 'boh'
//   opsAccess:               boolean — Operations tab
//   recipesAccess:           boolean — Recipes tab (default true; opt-OUT)
//   viewLabor:               boolean — labor % on Home + Operations
//   shiftLead:               boolean — Shift Lead flag (handoff target etc.)
//   canEditScheduleFOH:      boolean — designated FOH scheduler
//   canEditScheduleBOH:      boolean — designated BOH scheduler
//   homeView:                'auto' | 'schedule' | 'recipes' | 'operations' | 'training' | 'menu' | 'eighty6' | 'handoff' | 'tardies' | 'labor'
//   hiddenPages:             string[] — HIDEABLE_PAGES ids to FORCE-HIDE
//   canViewOnboarding:       boolean — PII access (use sparingly; owners only)
//
// Tabs that are NOT in HIDEABLE_PAGES (Home, Schedule, Recipes, Operations,
// Tardies, Handoff, Labor, Admin, Onboarding) are gated by their own flags
// and can't be controlled via hiddenPages — set the relevant boolean above
// instead.
//
// LOOKUP CHAIN: a role string runs through `roleAliases` first so misspellings
// or variants ("FOH" vs "Front of House") still match. Unknown roles return
// null and the "Apply template" button shows as disabled.

const ALL_HIDEABLE = ['menu', 'eighty6', 'training', 'catering', 'ai', 'maintenance', 'insurance'];

// Restrictive default for rank-and-file kitchen / FOH staff. Hide everything
// "office-y" (insurance, maintenance, AI assistant) so the home screen stays
// uncluttered. They can still ask a manager for access.
const HIDE_OFFICE = ['ai', 'maintenance', 'insurance'];

// Even more restrictive for line cooks who really only need recipes + schedule.
const HIDE_OFFICE_PLUS = ['ai', 'maintenance', 'insurance', 'catering', 'eighty6'];

export const POSITION_TEMPLATES = {
    Owner: {
        scheduleSide: 'foh',
        opsAccess: true,
        recipesAccess: true,
        viewLabor: true,
        shiftLead: true,
        canEditScheduleFOH: true,
        canEditScheduleBOH: true,
        homeView: 'auto',
        hiddenPages: [],
        canViewOnboarding: true,
    },
    Manager: {
        scheduleSide: 'foh',
        opsAccess: true,
        recipesAccess: true,
        viewLabor: true,
        shiftLead: true,
        canEditScheduleFOH: true,
        canEditScheduleBOH: false,
        homeView: 'schedule',
        hiddenPages: [],
    },
    'Asst Manager': {
        scheduleSide: 'foh',
        opsAccess: true,
        recipesAccess: true,
        viewLabor: true,
        shiftLead: true,
        canEditScheduleFOH: false,
        canEditScheduleBOH: false,
        homeView: 'schedule',
        hiddenPages: [],
    },
    'Kitchen Manager': {
        scheduleSide: 'boh',
        opsAccess: true,
        recipesAccess: true,
        viewLabor: true,
        shiftLead: true,
        canEditScheduleFOH: false,
        canEditScheduleBOH: true,
        homeView: 'recipes',
        hiddenPages: ['catering'],
    },
    'Asst Kitchen Manager': {
        scheduleSide: 'boh',
        opsAccess: true,
        recipesAccess: true,
        viewLabor: true,
        shiftLead: true,
        canEditScheduleFOH: false,
        canEditScheduleBOH: false,
        homeView: 'recipes',
        hiddenPages: ['catering'],
    },
    'Shift Lead': {
        scheduleSide: 'foh',
        opsAccess: true,
        recipesAccess: true,
        viewLabor: false,
        shiftLead: true,
        canEditScheduleFOH: false,
        canEditScheduleBOH: false,
        homeView: 'schedule',
        hiddenPages: HIDE_OFFICE,
    },
    Marketing: {
        scheduleSide: 'foh',
        opsAccess: false,
        recipesAccess: true,
        viewLabor: false,
        shiftLead: false,
        homeView: 'menu',
        hiddenPages: ['maintenance', 'insurance', 'eighty6'],
    },
    FOH: {
        scheduleSide: 'foh',
        opsAccess: false,
        recipesAccess: true,
        viewLabor: false,
        shiftLead: false,
        homeView: 'schedule',
        hiddenPages: HIDE_OFFICE,
    },
    Bowls: {
        scheduleSide: 'foh',
        opsAccess: false,
        recipesAccess: true,
        viewLabor: false,
        shiftLead: false,
        homeView: 'schedule',
        hiddenPages: HIDE_OFFICE,
    },
    BOH: {
        scheduleSide: 'boh',
        opsAccess: false,
        recipesAccess: true,
        viewLabor: false,
        shiftLead: false,
        homeView: 'recipes',
        hiddenPages: HIDE_OFFICE_PLUS,
    },
    // All the BOH station roles share the same template: BOH side, kitchen-
    // staff defaults. Each entry below is just an alias to BOH.
};

// Aliases — kitchen-station roles fall through to the BOH template.
// Anything not in POSITION_TEMPLATES or this alias map returns null.
const STATION_ROLES = [
    'Pho', 'Pho Station', 'Grill', 'Fryer', 'Fried Rice', 'Dish',
    'Bao/Tacos/Banh Mi', 'Spring Rolls/Prep', 'Prep',
];
for (const r of STATION_ROLES) {
    POSITION_TEMPLATES[r] = { ...POSITION_TEMPLATES.BOH, homeView: 'recipes' };
}

// Resolve a raw role string to its template. Returns null if no match —
// callers should show the "Apply template" button as disabled in that case.
// Pass-through: if the role string already matches a template key exactly,
// just return it. Otherwise try a case-insensitive match.
export function getPositionTemplate(role) {
    if (!role) return null;
    if (POSITION_TEMPLATES[role]) return POSITION_TEMPLATES[role];
    const lower = role.toLowerCase();
    const match = Object.keys(POSITION_TEMPLATES).find(k => k.toLowerCase() === lower);
    return match ? POSITION_TEMPLATES[match] : null;
}

// List of role names with a known template — used by the "Has template" pill
// in the role dropdown and by tests/sanity checks.
export function hasPositionTemplate(role) {
    return getPositionTemplate(role) !== null;
}
