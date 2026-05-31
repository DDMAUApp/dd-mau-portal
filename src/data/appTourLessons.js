// App Tour lesson definitions.
//
// Andrew 2026-05-30 — "i want to make a lession to go through all
// the features of the app. page by page. some people wont use
// certain pages so i want to be able to give acces to just the
// pages you are able to get into."
//
// Each lesson describes ONE tab in the app — what it is, what staff
// can do there, the common flows, and any gotchas. Lessons are
// FILTERED at render time by their `accessCheck(staff, staffList)`
// helper so a non-admin never sees the Admin lesson, a staffer
// without opsAccess never sees the Operations lesson, etc.
//
// To add a new lesson:
//   1. Append a new entry to APP_TOUR_LESSONS below.
//   2. Set accessCheck to the same predicate App.jsx uses to gate
//      the actual tab (re-use the helpers from data/staff.js).
//   3. Steps are sequential — each step is a screen the user
//      advances through with Next. Steps are short on purpose; if
//      a step needs 200 words, split it into two.
//
// Bilingual: every user-visible string is { en, es }. The renderer
// picks based on the current `language` prop.

import {
    isAdmin, canSeePage, canViewOnboarding, canViewLabor,
} from './staff';

// Helpers shared across access checks. These mirror App.jsx so the
// filter list matches what the user can actually open.
const hasOpsAccess     = (s) => !!s && (isAdmin(s.name, [s]) || s.opsAccess === true);
const hasRecipesAccess = (s) => !!s && (isAdmin(s.name, [s]) || s.recipesAccess !== false);
const isManager        = (s) => !!s && (isAdmin(s.name, [s]) || /manager/i.test(s.role || ''));

// Each lesson has:
//   id           — stable slug, used as key + progress tracker key
//   icon         — lucide icon name (resolved in AppTour.jsx)
//   color        — tailwind color family (sage|sky|emerald|amber|purple|rose|indigo)
//   title/subtitle — bilingual labels
//   accessCheck  — (staff, staffList) => boolean
//   estMinutes   — rough estimate shown on the card
//   steps[]      — sequential walkthrough
//     title/body  — bilingual
//     tipEn/tipEs — optional "good to know" callout
//     tryItTab    — optional tab id; renders a "Try it →" button that
//                   navigates the user to that tab when tapped
//     screenshot  — optional path/URL to a PNG (recommended:
//                   '/screenshots/<lesson-id>-<step-num>.png' which
//                   maps to public/screenshots/ on disk and gets
//                   served by the same GitHub Pages deploy as the
//                   app — no Storage round-trip on view)
//     screenshotAlt     — optional bilingual alt text for a11y
//     screenshotCaption — optional bilingual caption shown below
//
// Authoring style: short paragraphs (1-3 sentences), plain language,
// avoid jargon. If you say "Firestore" or "FCM" you've already lost
// the staff member.
//
// HOW TO CAPTURE SCREENSHOTS (Phase 1.B workflow):
//   1. Sign in to the live app, navigate to the page being described.
//   2. Take a full-window screenshot. Crop to the meaningful region
//      (typically: drop the OS chrome + browser tabs, keep the app
//      window). Target dimensions: ~1200px wide, PNG.
//   3. Save to public/screenshots/<lesson-id>-<step-num>.png
//      (e.g. public/screenshots/schedule-2.png for Schedule lesson
//      step 2).
//   4. Add `screenshot: '/screenshots/schedule-2.png'` to the step
//      object below. Optionally add screenshotAlt + screenshotCaption.
//   5. Commit + push. The screenshot ships with the app build.
export const APP_TOUR_LESSONS = [

    // ── HOME ──────────────────────────────────────────────────────────
    {
        id: 'home',
        icon: 'Home',
        color: 'sage',
        title:    { en: 'Home',                  es: 'Inicio' },
        subtitle: { en: 'Your daily snapshot',   es: 'Tu resumen diario' },
        accessCheck: () => true,
        estMinutes: 2,
        steps: [
            {
                title: { en: 'What Home is for', es: 'Para qué es Inicio' },
                body:  { en: 'Home is the first screen you see after signing in. It shows your shift today, who is clocked in (if you have access), today\'s tasks, any unread chat or alerts, and quick tiles to jump to the pages you use most.',
                         es: 'Inicio es la primera pantalla al iniciar sesión. Muestra tu turno de hoy, quién está marcado (si tienes acceso), tareas del día, chats o alertas sin leer, y tiles rápidos para saltar a las páginas más usadas.' },
            },
            {
                title: { en: 'Your shift card', es: 'Tu turno de hoy' },
                body:  { en: 'Shows your next published shift — start time, end time, location, and a clock-in countdown. If you have no shift today, the card tells you when your next one is.',
                         es: 'Muestra tu próximo turno publicado — hora de inicio, fin, ubicación y cuenta regresiva. Si no tienes turno hoy, te dice cuándo es el próximo.' },
            },
            {
                title: { en: 'Quick tiles', es: 'Tiles rápidos' },
                body:  { en: 'The grid of tiles below your shift opens the pages you have access to. Tiles for pages you cannot enter are hidden — so what you see is what you can use.',
                         es: 'La cuadrícula de tiles abre las páginas a las que tienes acceso. Los tiles para páginas que no puedes entrar quedan ocultos — lo que ves es lo que puedes usar.' },
                tipEn: 'On mobile the tiles are the bottom navigation; on desktop they are the left sidebar. Same set, different layout.',
                tipEs: 'En móvil los tiles son la navegación inferior; en escritorio son el sidebar izquierdo. Mismo conjunto, distinto diseño.',
            },
            {
                title: { en: 'The bell', es: 'La campana' },
                body:  { en: 'Top right shows a bell with a red dot when you have unread notifications — shift offers, swap approvals, replies in chat, etc. Tap to open the drawer.',
                         es: 'Arriba a la derecha verás una campana con punto rojo si tienes notificaciones — ofertas de turno, aprobaciones de cambio, respuestas en chat, etc. Toca para abrir.' },
            },
            {
                title: { en: 'Language toggle', es: 'Cambio de idioma' },
                body:  { en: 'Tap EN / ES in the header (or under Settings → Language) to switch the whole app between English and Spanish. Your choice is remembered on this device.',
                         es: 'Toca EN / ES en el encabezado (o en Ajustes → Idioma) para cambiar toda la app entre inglés y español. Tu elección queda guardada en este dispositivo.' },
            },
        ],
    },

    // ── SCHEDULE ──────────────────────────────────────────────────────
    {
        id: 'schedule',
        icon: 'Calendar',
        color: 'emerald',
        title:    { en: 'Schedule',                          es: 'Horario' },
        subtitle: { en: 'See, swap, and request your shifts', es: 'Ver, cambiar y pedir tus turnos' },
        accessCheck: () => true,
        estMinutes: 6,
        steps: [
            {
                title: { en: 'Week view (default)', es: 'Vista semanal (por defecto)' },
                body:  { en: 'You land on the current week, with each day as a column. Your shifts are highlighted; coworker shifts are visible so you know who you are working with.',
                         es: 'Aterrizas en la semana actual, con cada día como columna. Tus turnos están resaltados; ves los turnos de tus compañeros para saber con quién trabajas.' },
            },
            {
                title: { en: 'Move between weeks', es: 'Cambiar de semana' },
                body:  { en: 'Use the ‹ and › arrows at the top to step back / forward a week. Tap the date range to jump to today.',
                         es: 'Usa las flechas ‹ y › arriba para retroceder / avanzar una semana. Toca el rango de fechas para volver a hoy.' },
            },
            {
                title: { en: 'Day, List, Month views', es: 'Vistas Día, Lista, Mes' },
                body:  { en: 'The view-mode bar lets you switch to a single day (Day), a chronological list (List), or a one-month overview (📅 button on the left — opens a popup with holidays + birthdays).',
                         es: 'La barra de vista permite cambiar a un solo día (Día), lista cronológica (Lista) o vista de mes (botón 📅 a la izquierda — abre un popup con feriados y cumpleaños).' },
            },
            {
                title: { en: 'Request time off', es: 'Pedir tiempo libre' },
                body:  { en: 'Tap the Time Off button at the top, pick your dates, write a short reason, and submit. A manager gets notified and approves / denies. You see the status in the Time Off tab.',
                         es: 'Toca el botón Tiempo Libre arriba, elige fechas, escribe una razón breve y envía. Un gerente recibe notificación y aprueba o niega. Ves el estado en la pestaña Tiempo Libre.' },
            },
            {
                title: { en: 'Give up a shift', es: 'Liberar un turno' },
                body:  { en: 'On one of your shifts tap the shift card → "Up for grabs". Choose whether to offer the whole shift or just part of it (e.g. "I can come in at 1 instead of 10"). A note is optional but helps coworkers decide.',
                         es: 'En uno de tus turnos toca la tarjeta → "Disponible". Elige si ofreces todo el turno o solo parte (ej. "puedo venir a la 1 en vez de las 10"). Una nota es opcional pero ayuda a tus compañeros.' },
            },
            {
                title: { en: 'Pick up someone else\'s shift', es: 'Tomar el turno de otro' },
                body:  { en: 'Open the Open Shifts panel. Tap a shift to see the details + a "I want this" toggle. A manager approves and confirms the change — only THEN does the shift land on your week.',
                         es: 'Abre el panel Turnos Abiertos. Toca un turno para ver detalles + el botón "Quiero este". Un gerente aprueba y confirma el cambio — SOLO entonces el turno aparece en tu semana.' },
                tipEn: 'You will see a confirmation dialog before anything actually changes. No accidental commitments.',
                tipEs: 'Verás un diálogo de confirmación antes de que algo cambie. Sin compromisos accidentales.',
            },
            {
                title: { en: 'Set your availability', es: 'Configura tu disponibilidad' },
                body:  { en: 'In the side panel, set the days + windows you CAN work. Managers see this when they build the schedule. Keep it current so you do not get scheduled when you cannot work.',
                         es: 'En el panel lateral, marca los días + horarios que PUEDES trabajar. Los gerentes lo ven al armar el horario. Mantenlo al día para no ser asignado cuando no puedes.' },
            },
            {
                title: { en: 'Print or export your week', es: 'Imprimir o exportar tu semana' },
                body:  { en: 'The More menu (•••) at the top has Print (opens a printer-friendly page) and Export ICS (adds your shifts to Apple Calendar / Google Calendar). Drafts now show on print with a dashed amber border.',
                         es: 'El menú Más (•••) arriba tiene Imprimir (página optimizada para impresora) y Exportar ICS (agrega tus turnos a Apple Calendar / Google Calendar). Los borradores se imprimen con borde discontinuo ámbar.' },
            },
        ],
    },

    // ── CHAT ──────────────────────────────────────────────────────────
    {
        id: 'chat',
        icon: 'MessageSquare',
        color: 'sky',
        title:    { en: 'Chat',                              es: 'Chat' },
        subtitle: { en: 'Talk to coworkers in DMs + channels', es: 'Habla con compañeros en DM y canales' },
        accessCheck: () => true,
        estMinutes: 4,
        steps: [
            {
                title: { en: 'What you get', es: 'Lo que tienes' },
                body:  { en: 'A messenger built into the app. Direct messages with any coworker, plus channels (FOH, BOH, Managers, location-specific). Photos, voice notes, and replies all work.',
                         es: 'Un mensajero dentro de la app. Mensajes directos con cualquier compañero, además de canales (FOH, BOH, Gerentes, por ubicación). Fotos, notas de voz y respuestas funcionan.' },
            },
            {
                title: { en: 'Starting a thread', es: 'Iniciar una conversación' },
                body:  { en: 'Tap the + button on the chat home, search for a name, and start typing. The thread is created on first message — no separate "create" step.',
                         es: 'Toca el botón + en la página de chat, busca un nombre y empieza a escribir. La conversación se crea con el primer mensaje — no hay un paso aparte de "crear".' },
            },
            {
                title: { en: 'Attach a photo or voice note', es: 'Adjuntar foto o nota de voz' },
                body:  { en: 'In the composer, the paperclip opens a menu — Camera (take a new photo), Library (choose existing), Voice note (hold to record). Attachments stage as a preview pill before you send.',
                         es: 'En el compositor, el clip abre un menú — Cámara, Galería, Nota de voz (mantén presionado para grabar). Los adjuntos se muestran como vista previa antes de enviar.' },
            },
            {
                title: { en: 'Reply to a specific message', es: 'Responder a un mensaje específico' },
                body:  { en: 'Long-press (mobile) or right-click (desktop) any message → Reply. Your message will quote it for context. The original author gets a special "chat_reply" notification so they know.',
                         es: 'Mantén presionado (móvil) o clic derecho (escritorio) cualquier mensaje → Responder. Tu mensaje lo citará. El autor original recibe notificación especial "chat_reply".' },
            },
            {
                title: { en: 'Read receipts', es: 'Confirmación de lectura' },
                body:  { en: 'In channels, tap a message to see the "Seen by" list (who has read it). For DMs, the timestamp turns gray once read. Privacy: turn off read receipts in Settings if you prefer.',
                         es: 'En canales, toca un mensaje para ver "Visto por" (quién lo ha leído). En DMs, el timestamp se vuelve gris al leerse. Privacidad: desactiva confirmaciones en Ajustes si prefieres.' },
            },
        ],
    },

    // ── OPERATIONS ────────────────────────────────────────────────────
    {
        id: 'operations',
        icon: 'ListChecks',
        color: 'amber',
        title:    { en: 'Operations',                            es: 'Operaciones' },
        subtitle: { en: 'Daily checklists, inventory, 86 board', es: 'Listas diarias, inventario, 86' },
        accessCheck: (staff) => hasOpsAccess(staff),
        estMinutes: 8,
        steps: [
            {
                title: { en: 'What Operations covers', es: 'Qué cubre Operaciones' },
                body:  { en: 'The shift-running tools — opening / mid / closing checklists, inventory counts, the 86 board (out-of-stock list), date stickers, prep lists, and order mode.',
                         es: 'Herramientas para correr el turno — listas de apertura/medio/cierre, inventario, lista 86 (agotados), etiquetas de fecha, listas de prep, y modo de orden.' },
            },
            {
                title: { en: 'Checklists', es: 'Listas' },
                body:  { en: 'Tap a task to check it off. Each check writes your name + timestamp to the audit log so managers can see who closed what and when.',
                         es: 'Toca una tarea para marcarla. Cada marca registra tu nombre + hora en el log de auditoría para que los gerentes vean quién cerró qué y cuándo.' },
            },
            {
                title: { en: 'Inventory', es: 'Inventario' },
                body:  { en: 'Count the items, tap +/- to adjust by one, or type the number directly. Suggested counts based on past orders appear next to the input — useful for night-of ordering.',
                         es: 'Cuenta los artículos, toca +/- para ajustar de uno, o escribe el número directamente. Cantidades sugeridas basadas en pedidos pasados aparecen al lado del input.' },
                tipEn: 'Typing a number commits when you tab away or press Enter. The +/- buttons commit on tap.',
                tipEs: 'Escribir un número se guarda al salir del campo o presionar Enter. Los botones +/- se guardan al tocar.',
            },
            {
                title: { en: 'Place an order', es: 'Hacer un pedido' },
                body:  { en: 'After counting, tap "Place order" → Order Mode opens. Toggle a vendor pill, then check off items as you call them in. The right column (Plan view) shows what you are about to order from whom.',
                         es: 'Después de contar, toca "Hacer pedido" → se abre Modo Pedido. Activa el botón del proveedor, marca los items mientras los pides. La columna derecha (vista Plan) muestra lo que vas a pedir a quién.' },
            },
            {
                title: { en: '86 board', es: 'Lista 86' },
                body:  { en: 'When the kitchen runs out of something, tap +86 on the inventory item or open the 86 board directly. Adds the item to the public sold-out list — TV menus pick it up within seconds and dim that item.',
                         es: 'Cuando la cocina se queda sin algo, toca +86 en el item o abre la lista 86. Agrega el item a la lista pública — los menús TV lo detectan en segundos y atenúan ese item.' },
            },
            {
                title: { en: 'Date stickers', es: 'Etiquetas de fecha' },
                body:  { en: 'Print a label for anything prepped (sauce, batch, container) — pick the item, the printer sends a barcode-style sticker with the prep date and shelf-life.',
                         es: 'Imprime una etiqueta para cualquier cosa preparada (salsa, batch, contenedor) — elige el item, la impresora manda una etiqueta tipo código de barras con fecha y vida útil.' },
            },
        ],
    },

    // ── ADMIN PANEL ───────────────────────────────────────────────────
    {
        id: 'admin',
        icon: 'Shield',
        color: 'rose',
        title:    { en: 'Admin Panel',                       es: 'Panel de Admin' },
        subtitle: { en: 'Staff, settings, system controls',  es: 'Personal, ajustes, controles' },
        accessCheck: (staff, staffList) => isAdmin(staff?.name, staffList || [staff]),
        estMinutes: 10,
        steps: [
            {
                title: { en: 'Who sees this', es: 'Quién ve esto' },
                body:  { en: 'Admin Panel is restricted to owners (Andrew & Julie — staff IDs 40 + 41). Other staff cannot enter, regardless of role title.',
                         es: 'Panel de Admin solo para dueños (Andrew y Julie — staff IDs 40 + 41). Otro personal no puede entrar, sin importar su rol.' },
            },
            {
                title: { en: 'Staff list', es: 'Lista de personal' },
                body:  { en: 'Add / remove / edit staff. Each row has access toggles (Onboarding access, Ops access, Recipes access, etc.) + the PIN for the lock screen. Hide-from-schedule is for owners who clock in but should not appear on the public schedule grid.',
                         es: 'Agregar / quitar / editar personal. Cada fila tiene toggles de acceso (Onboarding, Ops, Recetas, etc.) + el PIN. Ocultar-del-horario es para dueños que marcan pero no aparecen en el horario público.' },
            },
            {
                title: { en: 'Required tasks editor', es: 'Editor de tareas requeridas' },
                body:  { en: 'Define the per-shift checklist (opening / mid / closing). Each task can be set per role + per location. Edits flow live to every device — no need to re-deploy.',
                         es: 'Define la lista por turno (apertura / medio / cierre). Cada tarea se asigna por rol + ubicación. Los cambios fluyen en vivo a cada dispositivo — sin re-deploy.' },
            },
            {
                title: { en: 'Inventory lists', es: 'Listas de inventario' },
                body:  { en: 'The master inventory schema (what items + what category + which vendor) lives here. Editing the list flows to the Operations inventory tab immediately.',
                         es: 'El esquema maestro de inventario (qué items + categoría + proveedor) vive aquí. Editar la lista se refleja en Operaciones de inmediato.' },
            },
            {
                title: { en: 'Menu, brand & build sheet (NEW)', es: 'Menú, marca y build sheet (NUEVO)' },
                body:  { en: 'The newest section (May 2026). Edits to the menu items, prices, categories, restaurant brand strings, and prep build sheet all flow live to staff phones + the TV menu boards.',
                         es: 'La sección más nueva (mayo 2026). Cambios al menú, precios, categorías, marca del restaurante y build sheet fluyen en vivo a teléfonos del personal y TVs del menú.' },
            },
            {
                title: { en: 'Label printers', es: 'Impresoras de etiquetas' },
                body:  { en: 'Per-location Epson TM-L100 config — set the printer IP + test print. If the printer moves, update its IP here so date stickers keep working.',
                         es: 'Config Epson TM-L100 por ubicación — pon la IP de la impresora + prueba de impresión. Si la impresora se mueve, actualiza la IP para que las etiquetas sigan imprimiendo.' },
            },
            {
                title: { en: 'System refresh', es: 'Refrescar sistema' },
                body:  { en: 'The red Danger Zone at the bottom: pushes a force-refresh to every active client. Use SPARINGLY — interrupts every staff member mid-action. Reserved for critical fixes.',
                         es: 'La Zona de Peligro roja abajo: empuja un refresco forzado a cada cliente activo. Úsalo CON CUIDADO — interrumpe a todos. Solo para arreglos críticos.' },
            },
        ],
    },
];

// Quick lookup map — used by the renderer + by the future "Try it"
// button (which needs to map id → tab in App.jsx).
export const APP_TOUR_BY_ID = Object.fromEntries(APP_TOUR_LESSONS.map(l => [l.id, l]));

/**
 * Filter lessons by the current viewer's access. Lessons whose
 * accessCheck returns false are dropped — the user never sees a
 * walkthrough for a page they cannot enter.
 */
export function getVisibleLessons(staff, staffList) {
    return APP_TOUR_LESSONS.filter(l => {
        try { return !!l.accessCheck(staff, staffList || []); }
        catch { return false; }
    });
}

/**
 * Suppress unused-import warnings for helpers we keep around for the
 * next batch of lessons (canSeePage, canViewOnboarding, canViewLabor,
 * isManager). When more lessons land they will be referenced inside
 * accessCheck functions. Listing them here keeps the imports honest.
 */
export const _RESERVED_FOR_NEXT_LESSONS = { canSeePage, canViewOnboarding, canViewLabor, isManager };
