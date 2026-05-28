/**
 * SMS templates — bilingual, restaurant-tight, GSM-7 friendly.
 *
 * Design constraints:
 *
 *   1. ≤160 chars total (1 SMS segment) per render — including the
 *      "Reply STOP to opt out" suffix. Each render is checked at runtime
 *      and trimmed/logged if it would split into a second segment.
 *
 *   2. Bilingual via { en, es } — picked by the recipient's
 *      preferredLanguage. ES copy uses natural restaurant Spanish, not
 *      machine-translation. Names/locations/SKUs stay literal — we don't
 *      translate "Webster" or "Andrew" or specific item names.
 *
 *   3. STOP language on EVERY message. CTIA + Twilio guidelines only
 *      require it on the welcome message + monthly, but for a small
 *      restaurant team where churn matters less than clarity, putting
 *      STOP on every send is the safer compliance posture. If you ever
 *      complain about character count we can drop to first-message-only
 *      with a monthly reminder.
 *
 *   4. No PII in the SMS body. SMS is not private (cell carriers see it,
 *      phone lock-screens show it). Keep payroll, medical, SSN, full
 *      addresses out. "Your shift starts at 5pm" is fine; "your W-4 is
 *      missing" is not — that goes through push only.
 *
 *   5. Variables are interpolated via {name} placeholders. Missing
 *      variables render as "[missing]" so we notice in QA rather than
 *      shipping a "your shift starts at undefined" disaster.
 *
 * Template versioning — bump CONSENT_TEXT_VERSION when the opt-in
 * disclosure changes (so the audit log captures which version each
 * staff actually agreed to).
 */

const CONSENT_TEXT_VERSION = "v1_2026-05-19";

const CONSENT_TEXT = {
    en:
        "By opting in, you agree to receive urgent operational text messages " +
        "from DD Mau (shift reminders, coverage requests, schedule changes, " +
        "weather closures, 86 alerts). Message frequency varies. Msg & data " +
        "rates may apply. Reply STOP to cancel. Reply HELP for help.",
    es:
        "Al activar esto, aceptas recibir mensajes de texto urgentes de DD Mau " +
        "(recordatorios de turno, solicitudes de cobertura, cambios de horario, " +
        "cierres por clima, alertas 86). La frecuencia varía. Pueden aplicar " +
        "tarifas de mensajes y datos. Responde STOP para cancelar. HELP para ayuda.",
};

// Inbound auto-replies (TwiML responses). STOP/HELP must respond
// per CTIA guidelines. START is the resubscribe path.
const INBOUND_REPLIES = {
    stop_confirm: {
        en: "DD Mau: You are unsubscribed. No more messages. Reply START to resubscribe.",
        es: "DD Mau: Te diste de baja. No más mensajes. Responde START para reactivar.",
    },
    start_confirm: {
        en: "DD Mau: You are resubscribed to urgent alerts. Reply STOP to opt out.",
        es: "DD Mau: Suscrito de nuevo a alertas urgentes. Responde STOP para no recibir.",
    },
    help: {
        en: "DD Mau urgent alerts. Reply STOP to opt out. Contact your manager for help.",
        es: "Alertas urgentes DD Mau. Responde STOP para no recibir. Pregunta a tu gerente.",
    },
};

// ── Templates ──────────────────────────────────────────────────────────
// Each entry has { en, es } with {placeholders} for runtime values.
// Keep both languages roughly the same operational meaning; do not
// translate names, locations, or item SKUs literally.

const TEMPLATES = {
    shift_reminder_1h: {
        en: "DD Mau: Your shift starts at {time} at {location}. Reply STOP to opt out.",
        es: "DD Mau: Tu turno empieza a las {time} en {location}. Responde STOP para no recibir.",
    },
    coverage_request: {
        en: "DD Mau: {requester} needs coverage on {date} {shiftLabel}. Open the app to claim. Reply STOP to opt out.",
        es: "DD Mau: {requester} necesita cobertura {date} {shiftLabel}. Abre la app. Responde STOP para no recibir.",
    },
    coverage_approved: {
        en: "DD Mau: Your coverage for {shiftLabel} on {date} was APPROVED. Reply STOP to opt out.",
        es: "DD Mau: Tu cobertura para {shiftLabel} el {date} fue APROBADA. Responde STOP para no recibir.",
    },
    coverage_denied: {
        en: "DD Mau: Your coverage for {shiftLabel} on {date} was denied. Reply STOP to opt out.",
        es: "DD Mau: Tu cobertura para {shiftLabel} el {date} fue rechazada. Responde STOP para no recibir.",
    },
    required_ack: {
        en: "DD Mau: You need to acknowledge: {summary}. Open the app. Reply STOP to opt out.",
        es: "DD Mau: Necesitas confirmar: {summary}. Abre la app. Responde STOP para no recibir.",
    },
    urgent_announcement: {
        en: "DD Mau URGENT: {summary}. Reply STOP to opt out.",
        es: "DD Mau URGENTE: {summary}. Responde STOP para no recibir.",
    },
    eighty_six_alert: {
        en: "DD Mau 86: {item} is OUT at {location}. Reply STOP to opt out.",
        es: "DD Mau 86: {item} AGOTADO en {location}. Responde STOP para no recibir.",
    },
    maintenance_urgent: {
        en: "DD Mau: Urgent maintenance at {location} — {summary}. Reply STOP to opt out.",
        es: "DD Mau: Mantenimiento urgente en {location} — {summary}. Responde STOP para no recibir.",
    },
    weather_closure: {
        en: "DD Mau: {location} is CLOSED today due to weather. Stay home. Reply STOP to opt out.",
        es: "DD Mau: {location} CERRADO hoy por clima. Quédate en casa. Responde STOP para no recibir.",
    },
    schedule_change_today: {
        en: "DD Mau: Your shift today changed — open the app. Reply STOP to opt out.",
        es: "DD Mau: Tu turno cambió hoy — abre la app. Responde STOP para no recibir.",
    },
    pto_approved: {
        en: "DD Mau: Your time-off for {date} was APPROVED. Reply STOP to opt out.",
        es: "DD Mau: Tu tiempo libre del {date} fue APROBADO. Responde STOP para no recibir.",
    },
    pto_denied: {
        en: "DD Mau: Your time-off for {date} was denied. Reply STOP to opt out.",
        es: "DD Mau: Tu tiempo libre del {date} fue rechazado. Responde STOP para no recibir.",
    },
    swap_approved: {
        en: "DD Mau: Your shift swap for {date} was APPROVED. Reply STOP to opt out.",
        es: "DD Mau: Tu cambio de turno del {date} fue APROBADO. Responde STOP para no recibir.",
    },
    swap_denied: {
        en: "DD Mau: Your shift swap for {date} was denied. Reply STOP to opt out.",
        es: "DD Mau: Tu cambio del {date} fue rechazado. Responde STOP para no recibir.",
    },
    task_handoff: {
        en: "DD Mau: New task from {assigner}: {summary}. Reply STOP to opt out.",
        es: "DD Mau: Nueva tarea de {assigner}: {summary}. Responde STOP para no recibir.",
    },
    // 2026-05-26 — owner inbox triage. {from} is the sender's name or
    // email; {subject} is the email subject line, truncated upstream so
    // the full SMS fits Twilio's single-segment 160-char budget.
    email_inquiry_catering: {
        en: "DD Mau: 🍱 Catering inquiry from {from}: {subject}. Reply STOP to opt out.",
        es: "DD Mau: 🍱 Consulta de catering de {from}: {subject}. Responde STOP para no recibir.",
    },
    email_inquiry_complaint: {
        en: "DD Mau: ⚠️ Customer complaint from {from}: {subject}. Reply STOP to opt out.",
        es: "DD Mau: ⚠️ Queja de cliente de {from}: {subject}. Responde STOP para no recibir.",
    },
    // 2026-05-27 — Andrew: "lets get the sms fully set up so if the
    // staff hasnt set everything up we can sent them a text to
    // remind them." Admin-triggered nudge to staff who haven't
    // finished installing the PWA + enabling push. Stays under
    // 160 chars (single segment). {firstName} is greeting; URL is
    // the app URL the staffer should open. Generic — no PII.
    setup_reminder: {
        en: "DD Mau: Hi {firstName}, please open the DD Mau app and turn on notifications so you don't miss schedule alerts. {url} Reply STOP to opt out.",
        es: "DD Mau: Hola {firstName}, abre la app DD Mau y activa notificaciones para no perder turnos. {url} Responde STOP para no recibir.",
    },
};

// The set of notification types eligible for SMS. dispatchSms checks
// this before doing anything else. Keep in sync with the TEMPLATES keys
// above — a type in the set without a template would render "[missing]"
// at runtime and ship gibberish.
const ALWAYS_SMS_TYPES = new Set(Object.keys(TEMPLATES));

// Render a template with {placeholders}. Unknown vars become "[missing]"
// so QA notices, not the recipient. Returns the rendered string.
// Falls back to English if the requested language has no template.
function renderSmsTemplate(type, language, vars) {
    const tpl = TEMPLATES[type];
    if (!tpl) return null;
    const langKey = language === "es" ? "es" : "en";
    const raw = tpl[langKey] || tpl.en;
    if (!raw) return null;
    return raw.replace(/\{(\w+)\}/g, (_, key) => {
        const v = vars && vars[key];
        if (v == null || v === "") return "[missing]";
        return String(v);
    });
}

module.exports = {
    CONSENT_TEXT_VERSION,
    CONSENT_TEXT,
    INBOUND_REPLIES,
    TEMPLATES,
    ALWAYS_SMS_TYPES,
    renderSmsTemplate,
};
