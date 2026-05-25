// notificationTypes.js — canonical registry of every push notification
// type the app fires. Used by NotificationsAdmin.jsx to render the
// per-staff opt-out matrix, AND by the dispatchNotification +
// dispatchSms Cloud Functions (mirrored in functions/notificationTypes.js)
// to know which types respect the recipient's pushOptOut array vs which
// are ALWAYS_ON regardless of opt-out state.
//
// Andrew 2026-05-24 — "chat is everyone in the chat no matter what. and
// schedule if it has to do with the staff's schedule. the rest we can
// make toggles, for example if i want managers to get a notification
// for 86 i can do that."
//
// Two flags drive this:
//   lockedOn: true  → ALWAYS pushes (opt-out is ignored). Used for
//                     chat + personal schedule changes + your own task
//                     assignments + your own PTO/swap/coverage outcomes.
//                     These are intrinsically personal — silencing them
//                     would break the app's promise of "you'll know
//                     when your shift changes."
//   lockedOn: false → respects staff.pushOptOut. Admin toggles via the
//                     NotificationsAdmin page.

// Categories — used to group rows in the edit modal. Order matters
// (renders top-to-bottom).
export const NOTIFICATION_CATEGORIES = [
    { id: 'chat',       en: 'Chat',                es: 'Chat'                  },
    { id: 'schedule',   en: 'Your schedule',       es: 'Tu horario'            },
    { id: 'ownTasks',   en: 'Your tasks',          es: 'Tus tareas'            },
    { id: 'broadcasts', en: 'Broadcasts',          es: 'Anuncios'              },
    { id: 'ops',        en: 'Operations alerts',   es: 'Alertas operaciones'   },
    { id: 'mgmt',       en: 'Management rollups',  es: 'Resumen gerencia'      },
    { id: 'tv',         en: 'TV health',           es: 'Estado de las TVs'     },
    { id: 'onboarding', en: 'Onboarding',          es: 'Incorporación'         },
];

// Every type the app currently dispatches. Add new types here when you
// add a new notify*() call site — otherwise admin can't toggle them.
export const NOTIFICATION_TYPES = [
    // ── LOCKED ON — chat ──────────────────────────────────────────
    { id: 'chat_message', category: 'chat', en: 'New chat message',           es: 'Nuevo mensaje',          lockedOn: true },
    { id: 'chat_mention', category: 'chat', en: '@ mention',                  es: 'Mención (@)',            lockedOn: true },
    { id: 'chat_nudge',   category: 'chat', en: 'Manager nudge / reminder',   es: 'Recordatorio del jefe',  lockedOn: true },

    // ── LOCKED ON — your own schedule changes ─────────────────────
    { id: 'shift_reminder_1h',  category: 'schedule', en: '1 hour before your shift',  es: '1 hora antes de tu turno',   lockedOn: true },
    { id: 'shift_added',        category: 'schedule', en: 'You were assigned a shift', es: 'Te asignaron un turno',      lockedOn: true },
    { id: 'shift_deleted',      category: 'schedule', en: 'Your shift was removed',    es: 'Tu turno fue eliminado',     lockedOn: true },
    { id: 'shift_reassigned',   category: 'schedule', en: 'Your shift was reassigned', es: 'Tu turno fue reasignado',    lockedOn: true },
    { id: 'shift_date_changed', category: 'schedule', en: 'Your shift moved to another day', es: 'Tu turno se movió a otro día', lockedOn: true },
    { id: 'shift_time_changed', category: 'schedule', en: 'Your shift time changed',   es: 'La hora de tu turno cambió', lockedOn: true },
    { id: 'pto_approved',       category: 'schedule', en: 'Your PTO approved',         es: 'Tu PTO aprobado',            lockedOn: true },
    { id: 'pto_denied',         category: 'schedule', en: 'Your PTO denied',           es: 'Tu PTO negado',              lockedOn: true },
    { id: 'swap_approved',      category: 'schedule', en: 'Your swap approved',        es: 'Tu cambio aprobado',         lockedOn: true },
    { id: 'swap_denied',        category: 'schedule', en: 'Your swap denied',          es: 'Tu cambio negado',           lockedOn: true },
    { id: 'coverage_approved',  category: 'schedule', en: 'Your coverage approved',    es: 'Cobertura aprobada',         lockedOn: true },
    { id: 'coverage_denied',    category: 'schedule', en: 'Your coverage denied',      es: 'Cobertura negada',           lockedOn: true },
    { id: 'week_published',     category: 'schedule', en: 'Your weekly schedule is up',es: 'Tu horario semanal listo',   lockedOn: true },

    // ── LOCKED ON — your own tasks ────────────────────────────────
    { id: 'task_handoff',   category: 'ownTasks', en: 'New task handed off to you',  es: 'Nueva tarea para ti',           lockedOn: true },
    { id: 'task_reminder',  category: 'ownTasks', en: 'Reminder on a task you own',  es: 'Recordatorio de tu tarea',      lockedOn: true },
    { id: 'task_comment',   category: 'ownTasks', en: 'Comment on a task you own',   es: 'Comentario en tu tarea',        lockedOn: true },
    { id: 'task_message',   category: 'ownTasks', en: 'Message on a task you own',   es: 'Mensaje en tu tarea',           lockedOn: true },
    { id: 'task_completed', category: 'ownTasks', en: 'A task you were on is done',  es: 'Tarea que te asignaron hecha',  lockedOn: true },
    { id: 'required_ack',   category: 'ownTasks', en: 'You need to acknowledge something', es: 'Necesitas confirmar algo',lockedOn: true },
    { id: 'announcement',   category: 'ownTasks', en: 'Reminder to ack announcement',es: 'Recordatorio de anuncio',       lockedOn: true },

    // ── OPT-OUT-ABLE — broadcasts ─────────────────────────────────
    { id: 'urgent_announcement',  category: 'broadcasts', en: 'Urgent announcement',       es: 'Anuncio urgente',          lockedOn: false },
    { id: 'weather_closure',      category: 'broadcasts', en: 'Weather closure',           es: 'Cierre por clima',         lockedOn: false },
    { id: 'schedule_change_today',category: 'broadcasts', en: 'A today shift changed',     es: 'Cambio de turno hoy',      lockedOn: false },

    // ── OPT-OUT-ABLE — operations alerts ──────────────────────────
    { id: 'eighty_six_alert',    category: 'ops', en: '86 item posted',          es: 'Item marcado 86',          lockedOn: false },
    { id: 'photo_issue',         category: 'ops', en: 'Photo issue posted',      es: 'Problema con foto',        lockedOn: false },
    { id: 'maintenance_urgent',  category: 'ops', en: 'Urgent maintenance ticket', es: 'Mantenimiento urgente',  lockedOn: false },
    { id: 'shift_open',          category: 'ops', en: 'Shift offered to your side', es: 'Turno ofrecido a tu lado', lockedOn: false },
    { id: 'shift_grabbed',       category: 'ops', en: 'Someone wants a shift',    es: 'Alguien quiere un turno',  lockedOn: false },

    // ── OPT-OUT-ABLE — management rollups ─────────────────────────
    { id: 'week_published_admin',  category: 'mgmt', en: 'Schedule published (rollup)',  es: 'Horario publicado (resumen)', lockedOn: false },
    { id: 'pto_request',           category: 'mgmt', en: 'PTO request to approve',       es: 'Solicitud PTO a aprobar',     lockedOn: false },
    { id: 'pto_approved_mgmt',     category: 'mgmt', en: 'PTO approved (rollup)',        es: 'PTO aprobado (resumen)',      lockedOn: false },
    { id: 'pto_denied_mgmt',       category: 'mgmt', en: 'PTO denied (rollup)',          es: 'PTO negado (resumen)',        lockedOn: false },
    { id: 'swap_request',          category: 'mgmt', en: 'Swap request to approve',      es: 'Solicitud de cambio',         lockedOn: false },
    { id: 'coverage_request',      category: 'mgmt', en: 'Coverage request',             es: 'Solicitud de cobertura',      lockedOn: false },

    // ── OPT-OUT-ABLE — TV health ──────────────────────────────────
    { id: 'tv_offline',     category: 'tv', en: 'A menu TV went offline',  es: 'Una TV se desconectó',    lockedOn: false },
    { id: 'tv_back_online', category: 'tv', en: 'A menu TV recovered',     es: 'Una TV se reconectó',     lockedOn: false },

    // ── OPT-OUT-ABLE — onboarding ─────────────────────────────────
    { id: 'invite_sent',         category: 'onboarding', en: 'Onboarding invite sent',  es: 'Invitación enviada',  lockedOn: false },
    { id: 'hire_doc_submitted',  category: 'onboarding', en: 'New hire submitted a doc',es: 'Nuevo doc enviado',   lockedOn: false },
];

// Pre-computed lookup: set of every LOCKED-ON type id. Cloud Functions
// import this exact name to gate the pushOptOut check (a locked-on type
// is ALWAYS pushed regardless of opt-out state). Keep the name + value
// in sync with functions/index.js if you mirror this file there.
export const LOCKED_ON_TYPE_IDS = new Set(
    NOTIFICATION_TYPES.filter(t => t.lockedOn).map(t => t.id)
);

// Pre-computed list: every type the admin CAN toggle. Used by the
// "Mute all in category" affordance.
export const OPT_OUT_ABLE_TYPES = NOTIFICATION_TYPES.filter(t => !t.lockedOn);

// True if the given type id is opt-out-able. False = locked on (must
// always push). Unknown ids default to TRUE (opt-out respected) — we
// can't lock-on a type we don't know about.
export function canOptOutOf(typeId) {
    return !LOCKED_ON_TYPE_IDS.has(typeId);
}
