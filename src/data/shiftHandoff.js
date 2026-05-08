// DD Mau Manager Shift Handoff — closing manager → next-morning opener.
//
// Operator lens: this is the highest-leverage daily ops feature for managers.
// Every shift change is a leak point — cash deltas, 86 list, broken
// equipment, prep that didn't get done, VIP guests, staff issues. Without a
// structured handoff, the opener walks in blind and discovers each item the
// hard way. With one, the opener taps Acknowledge and is briefed in 30 sec.
//
// Engineer lens: doc per (date, location) at shift_handoffs/{date}_{location}.
// Closing manager fills + submits → push fans out to all OTHER managers at
// the location. First manager in the next morning taps Acknowledge — their
// name + timestamp lock in. They can append PM-side notes.

export const HANDOFF_VERSION = 1;

// Section schema. Each section is a self-contained chunk of the handoff
// form. The component renders each as a card with the matching key as the
// data field. Order matters — top-down priority.
export const HANDOFF_SECTIONS = [
    {
        id: "cash",
        emoji: "💵",
        labelEn: "Cash drawer",
        labelEs: "Caja",
        promptEn: "Final count, deltas, voids/comps, anything off?",
        promptEs: "Cuenta final, diferencias, voids/comps, ¿algo raro?",
    },
    {
        id: "eighty_six",
        emoji: "🚫",
        labelEn: "86 list",
        labelEs: "Lista 86",
        promptEn: "What ran out today? What needs reordering or pulling?",
        promptEs: "¿Qué se acabó hoy? ¿Qué hay que reordenar o sacar?",
    },
    {
        id: "equipment",
        emoji: "🔧",
        labelEn: "Equipment status",
        labelEs: "Estado del equipo",
        promptEn: "Anything broken, flaky, or scheduled for repair?",
        promptEs: "¿Algo dañado, fallando, o pendiente de reparar?",
    },
    {
        id: "prep",
        emoji: "🥢",
        labelEn: "Prep handoff",
        labelEs: "Prep para mañana",
        promptEn: "What's prepped, what's NOT, what's first thing in the morning?",
        promptEs: "¿Qué está prep, qué FALTA, qué es prioridad por la mañana?",
    },
    {
        id: "staff",
        emoji: "👥",
        labelEn: "Staff issues",
        labelEs: "Personal",
        promptEn: "Tardies, no-calls, performance flags, who's on tomorrow.",
        promptEs: "Tardanzas, no-shows, problemas de desempeño, quién entra mañana.",
    },
    {
        id: "incoming",
        emoji: "📅",
        labelEn: "Incoming traffic",
        labelEs: "Tráfico esperado",
        promptEn: "Catering, big reservations, weather, neighborhood events.",
        promptEs: "Catering, reservaciones, clima, eventos en la zona.",
    },
    {
        id: "guest_complaints",
        emoji: "💬",
        labelEn: "Guest complaints",
        labelEs: "Quejas de clientes",
        promptEn: "What happened, how it was resolved, any guest who may return?",
        promptEs: "Qué pasó, cómo se resolvió, ¿algún cliente que vuelva?",
    },
    {
        id: "notes",
        emoji: "📝",
        labelEn: "Other notes",
        labelEs: "Otras notas",
        promptEn: "Anything else the morning shift needs to know.",
        promptEs: "Cualquier otra cosa que el turno de mañana necesite saber.",
    },
];

// Date key in business TZ — same helper Operations + Tardies use, kept here
// so this module doesn't import from those.
const BUSINESS_TZ = "America/Chicago";
const _dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const getBusinessDateKey = (d = new Date()) => _dayFmt.format(d);

// Doc id: 2026-05-08_webster
export const handoffDocId = (dateKey, location) => `${dateKey}_${location}`;

// Status helpers
export function statusOf(doc) {
    if (!doc) return "none";
    if (doc.acknowledgedAt) return "acknowledged";
    if (doc.submittedAt) return "submitted";
    return "draft";
}

export function statusBadge(status, isEs) {
    switch (status) {
        case "acknowledged": return { emoji: "✅", labelEn: "Acknowledged", labelEs: "Recibido",   color: "bg-green-100 text-green-800 border-green-300" };
        case "submitted":    return { emoji: "📤", labelEn: "Submitted",    labelEs: "Enviado",    color: "bg-blue-100 text-blue-800 border-blue-300" };
        case "draft":        return { emoji: "✏️", labelEn: "Draft",        labelEs: "Borrador",   color: "bg-amber-100 text-amber-800 border-amber-300" };
        default:             return { emoji: "—",  labelEn: "Not started",  labelEs: "Sin iniciar", color: "bg-gray-100 text-gray-600 border-gray-300" };
    }
}
