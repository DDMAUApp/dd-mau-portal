// Admin identity is anchored to staff IDs, NOT names. Renaming a staff member
// to "Andrew Shih" in the admin panel does NOT grant admin access. The IDs
// below are the canonical owners.
//   40 = Andrew Shih
//   41 = Julie Shih
export const ADMIN_IDS = [40, 41];

// Legacy name-list — kept for back-compat with any code that imports it,
// but new code should use isAdmin(name, staffList) which checks IDs.
export const ADMIN_NAMES = ["Andrew Shih", "Julie Shih"];

// Returns true iff the staff member with this name has an ADMIN_ID.
// Requires staffList so we can resolve name → id. If staffList is missing,
// we fall back to the legacy name list (transitional only — every callsite
// in the app passes staffList).
export function isAdmin(name, staffList) {
  if (!name) return false;
  if (Array.isArray(staffList)) {
    const me = staffList.find(s => s.name === name);
    return !!me && ADMIN_IDS.includes(me.id);
  }
  // Fallback for legacy callers; flag in console so we find them.
  if (typeof console !== "undefined") {
    console.warn("isAdmin called without staffList — falling back to name match. Pass staffList for ID-anchored check.");
  }
  return ADMIN_NAMES.includes(name);
}

// Schedule-edit access — designated-scheduler model.
//
// Owners (isAdmin) always edit BOTH sides. Otherwise it's per-side and
// per-staff via two explicit toggles set in AdminPanel:
//   canEditScheduleFOH: boolean
//   canEditScheduleBOH: boolean
//
// Pass a `side` ('foh' | 'boh') to check edit access for that specific side.
// Without `side`, returns true if the staff has either toggle (used by UI
// "is this person ever a scheduler?" checks).
//
// Note: role title is no longer used. The previous implementation auto-
// granted edit access to anyone with "Manager" in their role, but DD Mau
// has multiple managers and only one designated scheduler per side, so
// we moved to explicit per-staff toggles.
export function canEditSchedule(staffName, staffList, side) {
  if (isAdmin(staffName, staffList)) return true;
  if (!staffName || !Array.isArray(staffList)) return false;
  const me = staffList.find(s => s.name === staffName);
  if (!me) return false;
  if (side === 'foh') return me.canEditScheduleFOH === true;
  if (side === 'boh') return me.canEditScheduleBOH === true;
  // No side specified → either toggle counts.
  return me.canEditScheduleFOH === true || me.canEditScheduleBOH === true;
}

// Per-staff page visibility / sensitive-data access.
//
// Determines whether a given staff member can SEE manager-only data
// surfaces — labor %, financial KPIs, etc. The actual edit gates for
// admin features are still controlled by ADMIN_IDS / canEditSchedule;
// these flags are about VIEW visibility for sensitive-but-non-edit data.
//
// Default by role: managers and owners see labor by default. Regular
// staff have to be explicitly opted in via the Admin Panel toggle.
// Returns true/false; never undefined (so the consumer can safely just
// check truthiness).
export function canViewLabor(staff) {
  if (!staff) return false;
  // Explicit admin override per record (Admin Panel toggle): if set,
  // it wins over the role-based default.
  if (staff.viewLabor === true) return true;
  if (staff.viewLabor === false) return false;
  // Default: anyone whose role contains "manager" or "owner" sees labor.
  // This matches the de-facto practice before the explicit toggle existed
  // (the Labor tab was already gated on isAdmin, but Operations/HomeV2
  // were leaking labor % to anyone who could see those pages).
  const role = (staff.role || "").toLowerCase();
  if (/manager|owner/.test(role)) return true;
  return false;
}

export const LOCATION_LABELS = {
  webster: "Webster",
  maryland: "Maryland Heights",
  both: "Both Locations"
};

export const DEFAULT_STAFF = [
  { id: 1, name: "Ada Rodriguez", role: "Pho", pin: "", location: "webster" },
  { id: 2, name: "Amelia Amelia", role: "FOH", pin: "", location: "webster" },
  { id: 3, name: "Andres Martinez", role: "Grill", pin: "", location: "webster" },
  { id: 4, name: "Asmita Asmita", role: "FOH", pin: "", location: "webster" },
  { id: 5, name: "Ayana-Marie Watts", role: "FOH", pin: "", location: "webster" },
  { id: 6, name: "Blanca Salgado", role: "FOH", pin: "", location: "webster" },
  { id: 7, name: "Brandon Green", role: "Manager", pin: "", location: "webster" },
  { id: 8, name: "Carl W", role: "FOH", pin: "", location: "webster" },
  { id: 9, name: "Cash Magruder", role: "FOH", pin: "", location: "webster" },
  { id: 10, name: "Claudia Vallejos", role: "Prep", pin: "", location: "webster" },
  { id: 11, name: "Cony Mendieta", role: "Bowls", pin: "", location: "webster" },
  { id: 12, name: "Cristopher Maldonado", role: "Grill", pin: "", location: "webster" },
  { id: 13, name: "Dariela Cruz", role: "BOH", pin: "", location: "webster" },
  { id: 14, name: "Dulce Arriaga", role: "Fryer", pin: "", location: "webster" },
  { id: 15, name: "Edgar Cruz", role: "FOH", pin: "", location: "webster" },
  { id: 16, name: "Elizabeth Elizabeth", role: "FOH", pin: "", location: "webster" },
  { id: 17, name: "Emma Liliana", role: "Shift Lead", pin: "", location: "webster" },
  { id: 18, name: "Erica Dizon", role: "Shift Lead", pin: "", location: "webster" },
  { id: 19, name: "Fernanda Angarita", role: "Bao/Tacos/Banh Mi", pin: "", location: "webster" },
  { id: 20, name: "Fuijun Mok", role: "FOH", pin: "", location: "webster" },
  { id: 21, name: "Isa Davis", role: "FOH", pin: "", location: "webster" },
  { id: 22, name: "Jose Mendoza", role: "Fried Rice", pin: "", location: "webster" },
  { id: 23, name: "Josiah Oliver", role: "FOH", pin: "", location: "webster" },
  { id: 24, name: "Juan Tojin", role: "Fried Rice", pin: "", location: "webster" },
  { id: 25, name: "Julio Turcio", role: "Dish", pin: "", location: "webster" },
  { id: 26, name: "Katy Mejia", role: "Prep", pin: "", location: "webster" },
  { id: 27, name: "Ley Njeri", role: "FOH", pin: "", location: "webster" },
  { id: 28, name: "Lilian Melchor", role: "Spring Rolls/Prep", pin: "", location: "webster" },
  { id: 29, name: "Lorena Espinal", role: "Kitchen Manager", pin: "", location: "webster" },
  { id: 30, name: "Marcos Cruz", role: "Prep", pin: "", location: "webster" },
  { id: 31, name: "Mariana Fonseca", role: "Fryer", pin: "", location: "webster" },
  { id: 32, name: "Miguel Mejia", role: "Grill", pin: "", location: "webster" },
  { id: 33, name: "Milli Perez", role: "FOH", pin: "", location: "webster" },
  { id: 34, name: "Myia Dixon", role: "Shift Lead", pin: "", location: "webster" },
  { id: 35, name: "Rafa Leon", role: "FOH", pin: "", location: "webster" },
  { id: 36, name: "Rubi Diaz", role: "Dish", pin: "", location: "webster" },
  { id: 37, name: "Yeiry Cruz", role: "Shift Lead", pin: "", location: "webster" },
  { id: 38, name: "Yency Guzman", role: "Spring Rolls/Prep", pin: "", location: "webster" },
  { id: 39, name: "Yuly Guerrero", role: "Asst Kitchen Manager", pin: "", location: "webster" },
  { id: 40, name: "Andrew Shih", role: "Manager", pin: "", location: "both" },
  { id: 41, name: "Julie Shih", role: "Owner", pin: "", location: "both" },
  { id: 42, name: "Nora Argueta", role: "BOH", pin: "", location: "maryland" },
  { id: 44, name: "Christopher Campos", role: "FOH", pin: "", location: "maryland" },
  { id: 45, name: "Emma Castro", role: "FOH", pin: "", location: "maryland" },
  { id: 46, name: "Somsai Chittakhone", role: "FOH", pin: "", location: "maryland" },
  { id: 47, name: "Ana Curiel", role: "FOH", pin: "", location: "maryland" },
  { id: 48, name: "Felina Deck", role: "Marketing", pin: "", location: "maryland" },
  { id: 49, name: "Antony Dormes", role: "FOH", pin: "", location: "maryland" },
  { id: 50, name: "Andrea Frias", role: "FOH", pin: "", location: "maryland" },
  { id: 51, name: "Teresa Garcia", role: "BOH", pin: "", location: "maryland" },
  { id: 52, name: "Eduvijen Gomez", role: "Shift Lead", pin: "", location: "maryland" },
  { id: 53, name: "Kenya Gomez", role: "FOH", pin: "", location: "maryland" },
  { id: 54, name: "Avelio Gonzales", role: "BOH", pin: "", location: "maryland" },
  { id: 55, name: "Laura Hurtado", role: "Asst Manager", pin: "", location: "maryland" },
  { id: 56, name: "Yulissa Hurtado", role: "FOH", pin: "", location: "maryland" },
  { id: 57, name: "Bruce Liou", role: "FOH", pin: "", location: "maryland" },
  { id: 58, name: "Edith Medieta", role: "BOH", pin: "", location: "maryland" },
  { id: 59, name: "Ana Medieta", role: "BOH", pin: "", location: "maryland" },
  { id: 60, name: "Jasmine Mendoza", role: "FOH", pin: "", location: "maryland" },
  { id: 61, name: "Moises Monroy", role: "BOH", pin: "", location: "maryland" },
  { id: 62, name: "Elidio Najera", role: "BOH", pin: "", location: "maryland" },
  { id: 63, name: "Martin Najera", role: "BOH", pin: "", location: "maryland" },
  { id: 64, name: "Yuliana Nieto", role: "BOH", pin: "", location: "maryland" },
  { id: 65, name: "Pamela Ortega", role: "BOH", pin: "", location: "maryland" },
  { id: 66, name: "Carlos Pacheco", role: "BOH", pin: "", location: "maryland" },
  { id: 68, name: "Petrona Perez", role: "BOH", pin: "", location: "maryland" },
  { id: 69, name: "Inmer Ramirez", role: "BOH", pin: "", location: "maryland" },
  { id: 71, name: "Emerson Velasquez", role: "BOH", pin: "", location: "maryland" }
];
