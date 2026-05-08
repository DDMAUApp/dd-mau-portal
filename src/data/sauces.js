// DD Mau Sauce Log — default sauce list.
//
// FOH refills these from BOH's prep. The Sauce Log is a daily "what do we
// need made" channel between front and back of house. Default list = the
// sauces on the menu caddy + a few sandwich sauces. Admin can add/remove
// from the Sauce Log tab itself.
//
// Each sauce has:
//   id          — stable string used as the request key
//   nameEn/Es   — bilingual display name
//   recipe      — optional cross-reference into the master recipe book
//                 (the sauce log shows a "recipe" link if set)
//   defaultBatches — optional default count when FOH first requests
//   notes       — optional one-line note shown under the name

export const DEFAULT_SAUCES = [
    { id: "viet-vinaigrette",  nameEn: "Vietnamese Vinaigrette",  nameEs: "Vinagreta Vietnamita",     recipe: "Vietnamese Vinaigrette" },
    { id: "vegan-vinaigrette", nameEn: "Vegan Vinaigrette",        nameEs: "Vinagreta Vegana",         recipe: "Vegan Vietnamese Vinaigrette" },
    { id: "hoisin",            nameEn: "Hoisin (house)",           nameEs: "Hoisin (casa)",            recipe: "Hoisin Sauce" },
    { id: "peanut",            nameEn: "Peanut Sauce",             nameEs: "Salsa de Cacahuate",       recipe: "Peanut Butter Sauce" },
    { id: "spicy-peanut",      nameEn: "Spicy Peanut Sauce",       nameEs: "Salsa Picante de Cacahuate", recipe: "Spicy Peanut Butter Sauce" },
    { id: "dd-dressing",       nameEn: "DD Dressing",              nameEs: "DD Dressing",              recipe: "DD Dressing" },
    { id: "spicy-dd",          nameEn: "Spicy DD",                 nameEs: "Spicy DD",                 recipe: "Spicy DD Dressing" },
    { id: "creamy-sweet-chili", nameEn: "Creamy Sweet Chili",      nameEs: "Creamy Sweet Chili" },
    { id: "lime-ranch",        nameEn: "Lime Ranch",               nameEs: "Lime Ranch",               recipe: "Ranch" },
    { id: "sweet-chili",       nameEn: "Sweet Chili",              nameEs: "Sweet Chili",              notes: "Commercial bottle — refill caddy" },
    { id: "sweet-garlic",      nameEn: "Sweet Garlic Wings Sauce", nameEs: "Salsa Dulce de Ajo",       recipe: "Sweet Garlic Wings Sauce" },
    { id: "lo-mein-sauce",     nameEn: "Lo Mein Sauce",            nameEs: "Salsa Lo Mein",            recipe: "Lo Mein Sauce" },
    { id: "pickled-medley",    nameEn: "Pickled Medley",           nameEs: "Pickled Medley",           recipe: "Pickled Medley" },
    { id: "mayo",              nameEn: "Mayo",                     nameEs: "Mayonesa",                 recipe: "Mayo" },
];

// Urgency tiers — FOH picks one when requesting. Drives sort order in BOH
// queue and the chip color.
export const SAUCE_URGENCY = [
    { id: "today",    rank: 0, emoji: "🔴", labelEn: "Today",    labelEs: "Hoy",      chipBg: "bg-red-100 text-red-800 border-red-300" },
    { id: "tomorrow", rank: 1, emoji: "🟡", labelEn: "Tomorrow", labelEs: "Mañana",   chipBg: "bg-yellow-100 text-yellow-800 border-yellow-300" },
    { id: "next",     rank: 2, emoji: "🟢", labelEn: "Next",     labelEs: "Después",  chipBg: "bg-green-100 text-green-800 border-green-300" },
];
export const SAUCE_URGENCY_BY_ID = Object.fromEntries(SAUCE_URGENCY.map(u => [u.id, u]));
