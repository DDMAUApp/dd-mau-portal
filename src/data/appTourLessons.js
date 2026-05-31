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

    // ── MY TASKS ──────────────────────────────────────────────────────
    {
        id: 'mytasks',
        icon: 'ListChecks',
        color: 'emerald',
        title:    { en: 'My Tasks',                              es: 'Mis Tareas' },
        subtitle: { en: 'Personal to-do + manager kanban view',  es: 'Tareas personales + vista kanban' },
        accessCheck: () => true,
        estMinutes: 4,
        steps: [
            {
                title: { en: 'Two views, one tab', es: 'Dos vistas, una pestaña' },
                body:  { en: 'Regular staff see a personal task list — only tasks assigned to you. Managers and admins see a Kanban board with one column per staff member, plus a master "unassigned" column.',
                         es: 'Personal regular ve una lista personal — solo tus tareas asignadas. Gerentes y admins ven un tablero Kanban con columna por persona, más una columna maestra de "sin asignar".' },
            },
            {
                title: { en: 'Mark a task done', es: 'Marcar tarea hecha' },
                body:  { en: 'Tap the empty circle on the left of a task — it fills in green and the task collapses to the Done section. Tap again to un-do.',
                         es: 'Toca el círculo vacío a la izquierda — se llena de verde y la tarea pasa a Hechas. Toca otra vez para deshacer.' },
            },
            {
                title: { en: 'See whose task is whose (managers)', es: 'Ver de quién es cada tarea (gerentes)' },
                body:  { en: 'In the Kanban view, each column is one staffer. You can drag tasks between columns to reassign, or tap a task to edit it. Tasks on the master column are unassigned and visible to everyone.',
                         es: 'En la vista Kanban, cada columna es una persona. Arrastra tareas entre columnas para reasignar, o toca una para editar. Las del maestro están sin asignar y son visibles para todos.' },
            },
            {
                title: { en: 'Adding a task', es: 'Agregar una tarea' },
                body:  { en: 'Tap the "+" at the top → write the title, pick an assignee + due time (optional), tap Add. Notifications fire automatically if you assign it to someone else.',
                         es: 'Toca el "+" arriba → escribe título, elige persona + hora límite (opcional), toca Agregar. Se envía notificación automáticamente si se la asignas a otra persona.' },
            },
        ],
    },

    // ── NOTIFICATIONS (admin only) ────────────────────────────────────
    {
        id: 'notifications',
        icon: 'Megaphone',
        color: 'purple',
        title:    { en: 'Notifications (Admin)',               es: 'Notificaciones (Admin)' },
        subtitle: { en: 'Manual push messages to staff',       es: 'Mensajes push manuales al personal' },
        accessCheck: (staff, staffList) => isAdmin(staff?.name, staffList || [staff]),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'When to use it', es: 'Cuándo usarlo' },
                body:  { en: 'For broadcast announcements that need a push notification — schedule changes, urgent meal-period pushes, all-hands updates. For 1-on-1 conversations use Chat.',
                         es: 'Para anuncios masivos que necesitan push — cambios de horario, avisos urgentes, mensajes a todos. Para 1-a-1 usa Chat.' },
            },
            {
                title: { en: 'Pick the audience', es: 'Elige la audiencia' },
                body:  { en: 'Pills at the top let you target Everyone / FOH / BOH / a single location / a specific staffer. The recipient count updates as you toggle.',
                         es: 'Los botones de arriba te dejan apuntar a Todos / FOH / BOH / una ubicación / persona específica. El contador de destinatarios cambia al alternar.' },
            },
            {
                title: { en: 'Write + send', es: 'Escribir + enviar' },
                body:  { en: 'Title + body, both bilingual (the auto-translate button helps). Tap Send — push hits every recipient device within seconds, also logs to their in-app bell drawer.',
                         es: 'Título + cuerpo, bilingüe (el botón de auto-traducción ayuda). Toca Enviar — el push llega a cada dispositivo en segundos, también queda en su campana.' },
            },
        ],
    },

    // ── MENU REFERENCE ────────────────────────────────────────────────
    {
        id: 'menu',
        icon: 'BookOpen',
        color: 'amber',
        title:    { en: 'Menu Reference',                            es: 'Referencia del Menú' },
        subtitle: { en: 'Prices, allergens, build sheet for staff',  es: 'Precios, alérgenos, build sheet' },
        accessCheck: (staff) => canSeePage(staff, 'menu'),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'Customer menu vs build sheet', es: 'Menú al cliente vs build sheet' },
                body:  { en: 'Top toggle: "Menu (prices)" shows what the customer orders — names, prices, allergens, dietary badges. "Build Sheet" shows what is IN each item — base, toppings, sauces, piece counts. Use the build sheet to answer "what comes on a Pho?" questions.',
                         es: 'Botón arriba: "Menú (precios)" muestra lo que pide el cliente — nombres, precios, alérgenos, etiquetas dietéticas. "Build Sheet" muestra qué LLEVA cada artículo — base, toppings, salsas, piezas. Usa build sheet para responder "qué viene en un Pho?".' },
            },
            {
                title: { en: 'Expand a category', es: 'Expandir una categoría' },
                body:  { en: 'Tap a category card (Bowls, Bánh Mì, Pho, etc.) to expand all items in it. The per-category note at the top is critical — it has allergen rules and prep specifics that apply to every item in the category.',
                         es: 'Toca una tarjeta de categoría (Bowls, Bánh Mì, Pho, etc.) para expandir sus artículos. La nota arriba de cada categoría es crítica — tiene reglas de alérgenos y detalles que aplican a todos los artículos.' },
            },
            {
                title: { en: 'Allergens are guidance, not gospel', es: 'Los alérgenos son guía, no ley' },
                body:  { en: 'For serious allergies (anaphylaxis-class), ALWAYS confirm with the Shift Lead AND the kitchen. The Allergen Matrix in Training M17 is the deep reference.',
                         es: 'Para alergias graves (anafilaxia), SIEMPRE confirma con el Líder y la cocina. La Matriz de Alérgenos en Entrenamiento M17 es la referencia detallada.' },
                tipEn: 'Edits to prices, descriptions, photos, and categories flow live from the Admin "Menu, brand & build sheet" editor. If a price looks wrong, ask a manager to update it there.',
                tipEs: 'Los cambios de precios, descripciones, fotos y categorías fluyen en vivo del editor "Menú, marca y build sheet" en Admin. Si un precio se ve mal, pide al gerente que lo actualice ahí.',
            },
        ],
    },

    // ── DATE STICKERS ─────────────────────────────────────────────────
    {
        id: 'datestickers',
        icon: 'Wrench',
        color: 'amber',
        title:    { en: 'Date Stickers',                            es: 'Etiquetas de Fecha' },
        subtitle: { en: 'Label prepped items with date + shelf life', es: 'Etiqueta items preparados con fecha + vida útil' },
        accessCheck: () => true,
        estMinutes: 3,
        steps: [
            {
                title: { en: 'Why we date everything', es: 'Por qué fechamos todo' },
                body:  { en: 'Health code requires every prepped item (sauce, batch, container of cut veggies) to carry a date. Stickers also help the kitchen rotate stock first-in-first-out so nothing dies in the back of the walk-in.',
                         es: 'Código sanitario exige que cada item preparado (salsa, batch, contenedor de verduras) tenga fecha. Las etiquetas también ayudan a rotar stock primero-en-primero-salir.' },
            },
            {
                title: { en: 'Pick what you prepped', es: 'Elige lo preparado' },
                body:  { en: 'Categories at the top: Proteins, Sauces, Snacks, Rice & Noodles, Stocks, Made-Ahead. Tap a category to see its items, then tap the item — that triggers the Epson printer at your location.',
                         es: 'Categorías arriba: Proteínas, Salsas, Snacks, Arroz y Fideos, Caldos, Hechos-de-antes. Toca una categoría → toca el item — eso dispara la impresora Epson de tu ubicación.' },
            },
            {
                title: { en: 'Shelf life is automatic', es: 'La vida útil es automática' },
                body:  { en: 'Each item has a built-in default shelf life (e.g. cooked rice = 7 days, cut cucumber = 3 days). The sticker prints prep date + use-by date so you don\'t have to calculate.',
                         es: 'Cada item tiene vida útil predeterminada (ej. arroz cocido = 7 días, pepino cortado = 3 días). La etiqueta imprime fecha de prep + fecha de uso para que no calcules.' },
                tipEn: 'If the printer is offline, the page shows a red status banner. Tell a manager — it usually means the printer\'s IP changed or it\'s unplugged.',
                tipEs: 'Si la impresora está offline, la página muestra un banner rojo. Avisa al gerente — normalmente significa que cambió la IP o está desconectada.',
            },
        ],
    },

    // ── RECIPES ───────────────────────────────────────────────────────
    {
        id: 'recipes',
        icon: 'BookOpen',
        color: 'amber',
        title:    { en: 'Recipes',                                 es: 'Recetas' },
        subtitle: { en: 'How to make every sauce, batch, prep',    es: 'Cómo hacer cada salsa, batch, prep' },
        accessCheck: (staff) => hasRecipesAccess(staff),
        estMinutes: 4,
        steps: [
            {
                title: { en: 'Geofenced for safety', es: 'Geocercado por seguridad' },
                body:  { en: 'Recipes only open when you are physically at a DD Mau location (we use device GPS to check). This keeps proprietary recipes from being read on the bus home. If you are at the restaurant and it refuses to load, give location permission to the browser.',
                         es: 'Las recetas solo abren cuando estás físicamente en una ubicación DD Mau (usamos GPS). Esto evita que recetas propias se lean fuera. Si estás en el restaurante y no carga, da permiso de ubicación al navegador.' },
            },
            {
                title: { en: 'Search', es: 'Buscar' },
                body:  { en: 'Type at the top — instant filter on recipe title. Toggle "AI search" for natural-language matching ("things with shrimp", "vegan options"). AI is slower (~3s) but understands meaning, not just keywords.',
                         es: 'Escribe arriba — filtro instantáneo por título. Activa "Búsqueda AI" para coincidencias en lenguaje natural ("cosas con camarón", "opciones veganas"). AI es más lenta (~3s) pero entiende el significado.' },
            },
            {
                title: { en: 'Recipe detail', es: 'Detalle de receta' },
                body:  { en: 'Tap a recipe → ingredients with quantities, step-by-step method, allergen list, prep time, yield. Some have photos. Pinch-zoom on mobile to read fine print.',
                         es: 'Toca una receta → ingredientes con cantidades, método paso a paso, lista de alérgenos, tiempo de prep, rendimiento. Algunas tienen fotos. Pellizca para hacer zoom.' },
            },
            {
                title: { en: 'Admin edits', es: 'Ediciones admin' },
                body:  { en: 'Only admins can add, edit, or delete recipes. Every edit writes to /recipe_audits so the change history is recoverable. If a recipe is wrong, ask a manager — do not guess.',
                         es: 'Solo admins pueden agregar, editar o eliminar. Cada cambio queda en /recipe_audits para recuperar el historial. Si una receta está mal, pregunta al gerente — no adivines.' },
            },
        ],
    },

    // ── TRAINING (the Training tab itself) ────────────────────────────
    {
        id: 'training',
        icon: 'BookOpen',
        color: 'indigo',
        title:    { en: 'Training',                                  es: 'Capacitación' },
        subtitle: { en: 'Modules, quizzes, and this App Tour',        es: 'Módulos, exámenes y este Tour' },
        accessCheck: (staff) => canSeePage(staff, 'training'),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'Two things in this tab', es: 'Dos cosas en esta pestaña' },
                body:  { en: 'The App Tour (this one!) teaches you how to USE the app. Below it are the M-modules (M1, M2, M6-M12, M17) — those teach you how to do the JOB: cashier, stations, allergens, food safety, etc.',
                         es: 'El Tour de la App (¡este!) te enseña a USAR la app. Debajo están los módulos M (M1, M2, M6-M12, M17) — esos enseñan el TRABAJO: caja, estaciones, alérgenos, seguridad alimentaria.' },
            },
            {
                title: { en: 'Module flow', es: 'Flujo del módulo' },
                body:  { en: 'Read every lesson → take the quiz → 80% to pass (85% for safety modules). Two failed attempts in a row locks the module — a manager has to unlock it for you to try again. So slow down and re-read.',
                         es: 'Lee cada lección → toma el examen → 80% para aprobar (85% para seguridad). Dos fallos seguidos bloquean el módulo — un gerente debe desbloquearlo. Lee con calma.' },
            },
            {
                title: { en: 'Tracker (admin only)', es: 'Progreso (solo admin)' },
                body:  { en: 'Admin sees a "Tracker" button at the top — opens a per-staff progress matrix. Useful for seeing who has finished what + unlocking modules a staffer failed twice on.',
                         es: 'Admin ve un botón "Progreso" arriba — abre una matriz por persona. Útil para ver quién terminó qué + desbloquear módulos que alguien falló dos veces.' },
            },
        ],
    },

    // ── 86 BOARD ──────────────────────────────────────────────────────
    {
        id: 'eighty6',
        icon: 'ListChecks',
        color: 'rose',
        title:    { en: '86 Board',                                  es: 'Lista 86' },
        subtitle: { en: 'What is sold out right now',                es: 'Lo que está agotado ahora' },
        accessCheck: (staff) => canSeePage(staff, 'eighty6'),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'Two purposes', es: 'Dos propósitos' },
                body:  { en: 'Tells cashiers + servers which items they CANNOT sell right now. Also auto-dims the matching items on the public TV menu boards within seconds so customers see the same truth.',
                         es: 'Dice a cajeros + servers qué artículos NO pueden vender ahora. También atenúa automáticamente los items en los menús TV públicos en segundos para que los clientes vean lo mismo.' },
            },
            {
                title: { en: 'Add an item', es: 'Agregar un artículo' },
                body:  { en: 'Tap the + button → search or pick from the menu list → confirm. The item lands in the active list with your name + timestamp. Everyone with the page open sees it in real time.',
                         es: 'Toca el botón + → busca o elige del menú → confirma. El artículo entra en la lista activa con tu nombre + hora. Todos con la página abierta lo ven en tiempo real.' },
            },
            {
                title: { en: 'Restock = remove', es: 'Reabastecer = quitar' },
                body:  { en: 'When you make more / receive an order, tap the trash icon on the 86 entry to clear it. The TV menus un-dim within seconds; cashiers can sell it again.',
                         es: 'Cuando preparas más / recibes pedido, toca el ícono de basura para quitar la entrada. Los menús TV se desatenúan en segundos; los cajeros pueden vender de nuevo.' },
            },
            {
                title: { en: 'Toast auto-sync', es: 'Sincronización Toast' },
                body:  { en: 'A scraper checks Toast POS every 5 minutes and pulls items Toast marked unavailable into the 86 board automatically — so most items show up here without any manual entry. Manual adds still work for things Toast does not know about (broken equipment, sauce out, etc.).',
                         es: 'Un scraper revisa Toast POS cada 5 minutos y trae items que Toast marcó no-disponibles a la lista 86 automáticamente — la mayoría aparecen sin entrada manual. Las entradas manuales siguen funcionando para cosas que Toast no sabe (equipo roto, salsa agotada, etc.).' },
            },
        ],
    },

    // ── CATERING ──────────────────────────────────────────────────────
    {
        id: 'catering',
        icon: 'ListChecks',
        color: 'purple',
        title:    { en: 'Catering',                                  es: 'Catering' },
        subtitle: { en: 'Submit + track large group orders',         es: 'Enviar + rastrear pedidos grandes' },
        accessCheck: (staff) => canSeePage(staff, 'catering'),
        estMinutes: 4,
        steps: [
            {
                title: { en: 'When to use this', es: 'Cuándo usar esto' },
                body:  { en: 'For prepaid group / office / event orders. Walk-in tray orders go through the regular POS — catering is for orders that need kitchen lead time, special prep, and a written record.',
                         es: 'Para pedidos prepagados de grupo / oficina / evento. Las bandejas de paso van por POS normal — catering es para pedidos que requieren tiempo de prep, prep especial y registro escrito.' },
            },
            {
                title: { en: 'Build the order', es: 'Armar el pedido' },
                body:  { en: 'Customer info → pickup/delivery date + time → menu items with quantities → special notes. Each line item shows its price; the running total updates as you add.',
                         es: 'Datos del cliente → fecha + hora de recogida/entrega → menú con cantidades → notas. Cada línea muestra precio; el total se actualiza al agregar.' },
            },
            {
                title: { en: 'Submit + notify', es: 'Enviar + notificar' },
                body:  { en: 'Submit creates a catering order doc. Managers + kitchen lead get a push notification so they can prep ingredients in advance. The order shows up in the catering queue until marked complete.',
                         es: 'Enviar crea un documento de pedido. Gerentes + líder de cocina reciben notificación push para preparar ingredientes con tiempo. El pedido queda en la cola hasta marcarlo completo.' },
            },
        ],
    },

    // ── MAINTENANCE ───────────────────────────────────────────────────
    {
        id: 'maintenance',
        icon: 'Wrench',
        color: 'amber',
        title:    { en: 'Maintenance',                                  es: 'Mantenimiento' },
        subtitle: { en: 'Report something broken',                       es: 'Reportar algo roto' },
        accessCheck: (staff) => canSeePage(staff, 'maintenance'),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'What to report', es: 'Qué reportar' },
                body:  { en: 'Anything not working right — fryer thermostat, walk-in door seal, POS screen, sink leak, broken tile. Be specific. A photo helps a ton.',
                         es: 'Cualquier cosa que no funciona bien — termostato de freidora, sello de walk-in, pantalla POS, fuga de fregadero, baldosa rota. Sé específico. Una foto ayuda mucho.' },
            },
            {
                title: { en: 'Fill + submit', es: 'Llenar + enviar' },
                body:  { en: 'Pick the area (kitchen / dining / restroom / exterior), severity (urgent stops service / can wait / nice-to-have), description, photo if possible. Submit notifies the maintenance lead.',
                         es: 'Elige el área (cocina / comedor / baño / exterior), gravedad (urgente / puede esperar / mejora), descripción, foto si puedes. Enviar notifica al líder de mantenimiento.' },
            },
            {
                title: { en: 'Tracking + status', es: 'Seguimiento + estado' },
                body:  { en: 'Open tickets show their status: New → Acknowledged → Scheduled → Resolved. You see updates on your phone so you know if your report has been picked up.',
                         es: 'Los tickets abiertos muestran estado: Nuevo → Reconocido → Programado → Resuelto. Ves actualizaciones para saber si tu reporte fue atendido.' },
            },
        ],
    },

    // ── INSURANCE ─────────────────────────────────────────────────────
    {
        id: 'insurance',
        icon: 'Shield',
        color: 'indigo',
        title:    { en: 'Insurance Enrollment',                      es: 'Inscripción de Seguro' },
        subtitle: { en: 'Sign up for health benefits',               es: 'Inscríbete a beneficios médicos' },
        accessCheck: (staff) => canSeePage(staff, 'insurance'),
        estMinutes: 5,
        steps: [
            {
                title: { en: 'Who can enroll', es: 'Quién puede inscribirse' },
                body:  { en: 'Full-time staff (30+ hours/week average) become eligible after the waiting period. The page shows your eligibility status at the top — if you are not eligible yet, the date you become eligible is shown.',
                         es: 'Personal de tiempo completo (promedio 30+ horas/semana) son elegibles después del periodo de espera. La página muestra tu estado arriba — si aún no eres elegible, te dice la fecha.' },
            },
            {
                title: { en: 'Pick a plan', es: 'Elige un plan' },
                body:  { en: 'Compare available plans side-by-side: monthly premium, deductible, copays, what is covered. Tap a plan to see the full summary of benefits.',
                         es: 'Compara planes disponibles: prima mensual, deducible, copagos, cobertura. Toca un plan para ver el resumen completo de beneficios.' },
            },
            {
                title: { en: 'Add dependents', es: 'Agregar dependientes' },
                body:  { en: 'If covering family — spouse, kids — add them with name, DOB, relationship. Each dependent affects the monthly premium; the total updates as you add or remove people.',
                         es: 'Si cubres familia — cónyuge, hijos — agrégalos con nombre, fecha de nacimiento, relación. Cada dependiente afecta la prima; el total se actualiza.' },
            },
            {
                title: { en: 'Submit + payroll deduction', es: 'Enviar + descuento de nómina' },
                body:  { en: 'Submitting locks in your choice for the plan year. Your share comes out of each paycheck. You can change plans only during open enrollment or after a qualifying life event (marriage, baby, etc.).',
                         es: 'Enviar fija tu elección por el año. Tu parte se descuenta de cada cheque. Solo puedes cambiar plan en inscripción abierta o evento de vida (matrimonio, bebé, etc.).' },
                tipEn: 'PII (SSN, DOB, etc.) is stored in your filled PDF in Storage, not in plain Firestore. Treat the enrollment confirmation page like a tax form — verify everything before submitting.',
                tipEs: 'PII (SSN, fecha de nacimiento, etc.) se guarda en tu PDF en Storage, no en Firestore. Trata la confirmación como un formulario fiscal — verifica todo antes de enviar.',
            },
        ],
    },

    // ── AI ASSISTANT ──────────────────────────────────────────────────
    {
        id: 'ai',
        icon: 'Megaphone',
        color: 'purple',
        title:    { en: 'AI Assistant',                              es: 'Asistente AI' },
        subtitle: { en: 'Ask questions about menu, prep, policies',  es: 'Pregunta sobre menú, prep, políticas' },
        accessCheck: (staff) => canSeePage(staff, 'ai'),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'What it knows', es: 'Qué sabe' },
                body:  { en: 'The AI has access to the menu, build sheet, recipes, allergen matrix, and training content. Ask "what is in a Coconut Shrimp Bowl?", "is the peanut sauce dairy-free?", "how do I prep batch lemongrass?".',
                         es: 'El AI tiene acceso al menú, build sheet, recetas, matriz de alérgenos y capacitación. Pregunta "qué lleva un Coconut Shrimp Bowl?", "la salsa de cacahuate tiene lácteo?", "cómo preparo lemongrass en batch?".' },
            },
            {
                title: { en: 'Bilingual', es: 'Bilingüe' },
                body:  { en: 'Ask in English or Spanish — same answers either way. If you switch the app to Spanish, the AI defaults to Spanish responses.',
                         es: 'Pregunta en inglés o español — mismas respuestas. Si cambias la app a español, el AI responde en español por defecto.' },
            },
            {
                title: { en: 'When to NOT trust it', es: 'Cuándo NO confiar' },
                body:  { en: 'For serious allergy questions, always confirm with a manager + the kitchen. The AI is a fast reference, not a substitute for the M17 Allergen Matrix or a Shift Lead.',
                         es: 'Para preguntas de alergia graves, siempre confirma con gerente + cocina. El AI es referencia rápida, no sustituto de la Matriz M17 o un Líder.' },
            },
        ],
    },

    // ── TARDIES ───────────────────────────────────────────────────────
    {
        id: 'tardies',
        icon: 'ListChecks',
        color: 'amber',
        title:    { en: 'Tardies (Managers)',                        es: 'Tardanzas (Gerentes)' },
        subtitle: { en: 'Track late clock-ins + no-shows',           es: 'Rastrear marcadas tarde + faltas' },
        accessCheck: (staff) => isManager(staff),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'Auto-detected, manual review', es: 'Auto-detectado, revisión manual' },
                body:  { en: 'The labor scraper checks every clock-in against the scheduled start time. Anything more than 5 minutes late (configurable) lands here as a "tardy event" for you to review and assign a status.',
                         es: 'El scraper compara cada marcada contra el horario. Cualquier marcada más de 5 minutos tarde (configurable) llega aquí como "evento de tardanza" para revisar y asignar estado.' },
            },
            {
                title: { en: 'Status workflow', es: 'Flujo de estado' },
                body:  { en: 'Each tardy can be marked Excused (sick, emergency, advance notice) / Unexcused / Coaching given. The history rolls up per staffer so you can see patterns ("3 late in the last 14 days").',
                         es: 'Cada tardanza se marca Disculpada (enferma, emergencia, aviso) / No-disculpada / Coaching dado. El historial se acumula por persona ("3 tardanzas en 14 días").' },
            },
            {
                title: { en: 'No-shows', es: 'Faltas (no-show)' },
                body:  { en: 'A scheduled shift with zero clock-in by 20 minutes after start becomes a No-Show. Same workflow — review, mark with reason, document for HR.',
                         es: 'Un turno sin marcada 20 minutos después del inicio se vuelve No-Show. Mismo flujo — revisar, marcar con razón, documentar para RH.' },
            },
        ],
    },

    // ── SHIFT HANDOFF ─────────────────────────────────────────────────
    {
        id: 'handoff',
        icon: 'Megaphone',
        color: 'sky',
        title:    { en: 'Shift Handoff (Managers)',                  es: 'Entrega de Turno (Gerentes)' },
        subtitle: { en: 'Pass context to the next manager',          es: 'Pasa contexto al siguiente gerente' },
        accessCheck: (staff) => isManager(staff),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'The point', es: 'El punto' },
                body:  { en: 'When you close, the opening manager needs to know what happened: what is 86\'d, who called out, equipment issues, any guest situation worth following up on. This page is the written record.',
                         es: 'Al cerrar, el gerente de apertura necesita saber qué pasó: qué está agotado, quién faltó, problemas de equipo, situaciones con clientes. Esta página es el registro escrito.' },
            },
            {
                title: { en: 'Quick categories', es: 'Categorías rápidas' },
                body:  { en: 'Pre-filled prompts: Sales summary, Staffing notes, Equipment, Inventory low / 86, Guest issues, Tomorrow heads-up. Fill what applies; skip what does not.',
                         es: 'Prompts pre-llenados: Resumen de ventas, Notas de personal, Equipo, Inventario bajo / 86, Problemas con clientes, Aviso para mañana. Llena lo que aplique; salta lo que no.' },
            },
            {
                title: { en: 'Visible to whom', es: 'Visible para quién' },
                body:  { en: 'Saved handoffs are visible to all managers + admin. The next opening manager sees the most recent one when they sign in. History stays for ~30 days so you can look back.',
                         es: 'Las entregas guardadas son visibles a todos los gerentes + admin. El siguiente gerente de apertura ve la más reciente al iniciar sesión. Historial se queda ~30 días.' },
            },
        ],
    },

    // ── LABOR DASHBOARD ───────────────────────────────────────────────
    {
        id: 'labor',
        icon: 'ListChecks',
        color: 'emerald',
        title:    { en: 'Labor Dashboard (Admin)',                   es: 'Panel de Labor (Admin)' },
        subtitle: { en: 'Hours, SPLH, cost % by daypart',            es: 'Horas, SPLH, % costo por daypart' },
        accessCheck: (staff, staffList) => canViewLabor(staff) || isAdmin(staff?.name, staffList || [staff]),
        estMinutes: 5,
        steps: [
            {
                title: { en: 'Data source', es: 'Fuente de datos' },
                body:  { en: 'Toast POS labor data, scraped every 30 minutes by Railway and written to /ops/labor_<loc>. So numbers are at most 30 min stale, often fresher. A "last scraped" timestamp shows top right — red if it has not updated in over 2 hours (scraper down).',
                         es: 'Datos de Toast POS, scraped cada 30 minutos por Railway y escritos en /ops/labor_<loc>. Números son máximo 30 min viejos, normalmente más frescos. "Última actualización" arriba a la derecha — rojo si no actualiza en 2+ horas (scraper caído).' },
            },
            {
                title: { en: 'Today vs week', es: 'Hoy vs semana' },
                body:  { en: 'Today panel: hours so far, projected end of day, cost % so far. Week panel: hours week-to-date, on track / over / under target. Toggle the chart between SPLH (sales per labor hour) and pure cost %.',
                         es: 'Panel Hoy: horas hasta ahora, proyección de fin del día, % de costo hasta ahora. Panel Semana: horas en la semana, en camino / sobre / bajo objetivo. Alterna entre SPLH (ventas por hora trabajada) y % de costo.' },
            },
            {
                title: { en: 'Per-daypart breakdown', es: 'Desglose por daypart' },
                body:  { en: 'Bottom table splits today\'s hours into Open / Lunch / Mid / Dinner / Close. Each row shows scheduled vs actual hours + SPLH. Use this to spot if you over-scheduled a slow lunch but under-scheduled dinner.',
                         es: 'La tabla inferior divide las horas de hoy en Apertura / Almuerzo / Medio / Cena / Cierre. Cada fila muestra horas programadas vs reales + SPLH. Útil para detectar si sobreasignaste almuerzo y subasignaste cena.' },
            },
        ],
    },

    // ── MENU SCREENS (TV admin) ───────────────────────────────────────
    {
        id: 'menuscreens',
        icon: 'ImageIcon',
        color: 'sky',
        title:    { en: 'Menu Screens (Admin)',                      es: 'Pantallas de Menú (Admin)' },
        subtitle: { en: 'Manage every TV menu board',                es: 'Gestiona cada TV de menú' },
        accessCheck: (staff, staffList) => isAdmin(staff?.name, staffList || [staff]),
        estMinutes: 6,
        steps: [
            {
                title: { en: 'What is here', es: 'Qué hay aquí' },
                body:  { en: 'Health strip at the top: live / stale / offline TVs counted per location. Below, one card per TV with a 16:9 preview, status pill, and edit / pair / duplicate / delete actions.',
                         es: 'Banner de salud arriba: TVs vivos / atrasados / offline por ubicación. Abajo, una tarjeta por TV con vista 16:9, estado y acciones edit / emparejar / duplicar / borrar.' },
            },
            {
                title: { en: 'Configure a TV', es: 'Configurar una TV' },
                body:  { en: 'Tap Edit on a TV card → set layout mode (data-driven menu / rotating images / split / PDF), pick dayparts (different layouts for breakfast vs lunch vs dinner), add hit zones (rectangles that overlay 86 indicators on image-mode menus), set rotation speeds.',
                         es: 'Toca Editar → elige modo de layout (menú por datos / imágenes rotativas / split / PDF), elige dayparts (diferentes layouts por desayuno/almuerzo/cena), agrega hit zones (rectángulos para overlays 86 en menús-imagen), velocidades de rotación.' },
            },
            {
                title: { en: 'Pair a new TV', es: 'Emparejar nueva TV' },
                body:  { en: 'Tap "Pair device" → app generates a tvId + URL. On the new TV (Fire Stick, Pi, etc.) open that URL — the TV announces itself by writing to /tv_heartbeats and shows up in the dashboard within 60 seconds.',
                         es: 'Toca "Emparejar dispositivo" → genera tvId + URL. En la TV nueva (Fire Stick, Pi, etc.) abre esa URL — la TV se anuncia escribiendo en /tv_heartbeats y aparece en el panel en 60 segundos.' },
            },
            {
                title: { en: 'Holidays + templates', es: 'Feriados + plantillas' },
                body:  { en: 'Templates tab: pre-built layouts you can drop onto a TV in one tap. Holidays tab: schedule a date-ranged overlay (background image, banner text, countdown) — perfect for Valentine\'s, Tet, July 4. Set dates once, the TVs pick it up automatically.',
                         es: 'Pestaña Plantillas: layouts pre-hechos para aplicar en un toque. Pestaña Feriados: programa un overlay por rango de fechas (imagen, banner, cuenta regresiva) — perfecto para San Valentín, Tet, 4 de Julio.' },
            },
        ],
    },

    // ── ERROR REPORT (admin) ──────────────────────────────────────────
    {
        id: 'errorreport',
        icon: 'Wrench',
        color: 'rose',
        title:    { en: 'Error Report (Admin)',                      es: 'Reporte de Errores (Admin)' },
        subtitle: { en: 'JS errors + staff bug reports',             es: 'Errores JS + reportes de personal' },
        accessCheck: (staff, staffList) => isAdmin(staff?.name, staffList || [staff]),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'Two streams', es: 'Dos fuentes' },
                body:  { en: 'Top: uncaught JavaScript errors from any device running the app — stack trace, browser, time. Bottom: bug reports submitted by staff via the "Report a problem" button.',
                         es: 'Arriba: errores JavaScript no capturados de cualquier dispositivo — stack trace, navegador, hora. Abajo: reportes de bugs enviados por personal con el botón "Reportar problema".' },
            },
            {
                title: { en: 'Triage', es: 'Triage' },
                body:  { en: 'Each error has counts (how many devices, how often). Click into one to see the latest stack trace + a "send to Claude" copy button — paste the dump into a chat and ask for a fix.',
                         es: 'Cada error tiene conteos (cuántos dispositivos, qué tan seguido). Haz clic para ver el último stack trace + un botón "enviar a Claude" — pega el dump en chat y pide arreglo.' },
            },
            {
                title: { en: 'Sentry too', es: 'Sentry también' },
                body:  { en: 'Errors also flow to Sentry (errors.sentry.io) with full source maps. Open the Sentry link at the top to see the user breadcrumb trail + redacted state at the moment of crash.',
                         es: 'Los errores también van a Sentry (errors.sentry.io) con source maps. Abre el link Sentry arriba para ver el rastro del usuario + estado redactado al momento del crash.' },
            },
        ],
    },

    // ── HEALTH (admin) ────────────────────────────────────────────────
    {
        id: 'health',
        icon: 'ListChecks',
        color: 'emerald',
        title:    { en: 'System Health (Admin)',                     es: 'Salud del Sistema (Admin)' },
        subtitle: { en: 'Backups, scrapers, audits',                 es: 'Respaldos, scrapers, auditorías' },
        accessCheck: (staff, staffList) => isAdmin(staff?.name, staffList || [staff]),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'What is monitored', es: 'Qué se monitorea' },
                body:  { en: 'Sections for: daily Firestore backups, scraper health (Toast labor, Sysco/USFoods, Sling CSV), audit log volume, Cloud Function recent invocations, push notification delivery rate.',
                         es: 'Secciones: respaldos diarios de Firestore, salud de scrapers (Toast labor, Sysco/USFoods, Sling CSV), volumen de auditorías, invocaciones recientes de Cloud Functions, tasa de entrega de push.' },
            },
            {
                title: { en: 'Red means investigate', es: 'Rojo = investigar' },
                body:  { en: 'Any card with a red status pill needs attention. Most common: scraper missed its window (Railway cron paused, restart it). Click into the card for the full last-N-runs history.',
                         es: 'Cualquier tarjeta con estado rojo necesita atención. Lo más común: scraper perdió su ventana (cron de Railway pausado, reinícialo). Haz clic para ver historial completo.' },
            },
            {
                title: { en: 'Backups', es: 'Respaldos' },
                body:  { en: 'Three layers: Firestore PITR (7-day rolling), daily managed export to GCS, local JSON dump via "npm run backup". You can browse the GCS bucket from here. If a backup has not run in 36 hours, the card turns red.',
                         es: 'Tres capas: Firestore PITR (7 días rotando), exportación diaria a GCS, dump JSON local con "npm run backup". Puedes navegar el bucket GCS desde aquí. Si no corre en 36 horas, la tarjeta se vuelve roja.' },
            },
        ],
    },

    // ── LABEL PRINTING CENTER (admin) ─────────────────────────────────
    {
        id: 'labels',
        icon: 'Wrench',
        color: 'amber',
        title:    { en: 'Label Printing (Admin)',                    es: 'Impresión de Etiquetas (Admin)' },
        subtitle: { en: 'Bulk print + custom label runs',            es: 'Imprime en bulk + etiquetas custom' },
        accessCheck: (staff, staffList) => isAdmin(staff?.name, staffList || [staff]),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'Beyond date stickers', es: 'Más allá de fechas' },
                body:  { en: 'The regular Date Stickers page is for staff doing prep. This admin page handles bulk runs — print 50 of one label, design a custom layout (size, fields, barcode), test print specific sizes.',
                         es: 'La página normal de Etiquetas es para personal en prep. Esta página admin maneja runs en bulk — imprime 50 de una etiqueta, diseña layout custom (tamaño, campos, código de barras), prueba tamaños específicos.' },
            },
            {
                title: { en: 'Per-location printer', es: 'Impresora por ubicación' },
                body:  { en: 'Each location has its own Epson TM-L100 with its own IP. The location picker at the top targets the right printer. Test print before a big run so you do not waste a stack of labels.',
                         es: 'Cada ubicación tiene su propio Epson TM-L100 con su propia IP. El selector de ubicación arriba apunta a la impresora correcta. Prueba antes de un run grande para no desperdiciar etiquetas.' },
            },
        ],
    },

    // ── INBOX TRIAGE (admin) ──────────────────────────────────────────
    {
        id: 'inbox',
        icon: 'Inbox',
        color: 'sky',
        title:    { en: 'Inbox Triage (Admin)',                      es: 'Bandeja (Admin)' },
        subtitle: { en: 'Route inbound emails to a category',        es: 'Categoriza correos entrantes' },
        accessCheck: (staff, staffList) => isAdmin(staff?.name, staffList || [staff]),
        estMinutes: 3,
        steps: [
            {
                title: { en: 'What lands here', es: 'Qué llega aquí' },
                body:  { en: 'Inbound email to the restaurant\'s public addresses (info@, catering@, etc.) gets parsed, redacted of secrets, and queued here for an admin to assign a category and route to the right person.',
                         es: 'Email entrante a las direcciones públicas (info@, catering@, etc.) se parsea, se redactan secretos, y se encola aquí para que un admin asigne categoría y enrute a la persona correcta.' },
            },
            {
                title: { en: 'Route + reply', es: 'Enrutar + responder' },
                body:  { en: 'Pick a category from the pills (Catering / HR / Vendor / Complaint / Spam) — the routing rules in Admin determine who gets notified. Reply inline if quick; longer responses can be drafted in Gmail.',
                         es: 'Elige categoría (Catering / RH / Proveedor / Queja / Spam) — las reglas de enrutamiento en Admin determinan a quién se notifica. Responde inline si es rápido; respuestas largas en Gmail.' },
            },
        ],
    },

    // ── ONBOARDING ────────────────────────────────────────────────────
    {
        id: 'onboarding',
        icon: 'Inbox',
        color: 'indigo',
        title:    { en: 'Onboarding (HR)',                           es: 'Onboarding (RH)' },
        subtitle: { en: 'New hire paperwork + applications',         es: 'Papeleo de nuevos + aplicaciones' },
        accessCheck: (staff) => canViewOnboarding(staff),
        estMinutes: 6,
        steps: [
            {
                title: { en: 'Three things', es: 'Tres cosas' },
                body:  { en: 'Hires (active new hires filling paperwork), Applications (public job applicants), Templates (the fillable PDFs admins design once + reuse). Tabs at the top.',
                         es: 'Hires (nuevos llenando papeleo), Aplicaciones (postulantes del público), Plantillas (PDFs llenables que admins diseñan una vez). Pestañas arriba.' },
            },
            {
                title: { en: 'Send an invite', es: 'Enviar invitación' },
                body:  { en: '"New hire" button → name, email, role, location → app generates a single-use token URL (?onboard=TOKEN, valid 30 days). Send via SMS or email. The hire opens the link to fill paperwork on their phone.',
                         es: 'Botón "Nuevo hire" → nombre, email, rol, ubicación → app genera URL de token (?onboard=TOKEN, válido 30 días). Envía por SMS o email. El hire abre el link para llenar papeleo.' },
            },
            {
                title: { en: 'Review submitted docs', es: 'Revisar docs enviados' },
                body:  { en: 'When the hire submits each PDF (W-4, I-9, direct deposit, etc.), it shows up under their record. Review for completeness, mark approved or request changes. Every download is audited.',
                         es: 'Cuando el hire envía cada PDF (W-4, I-9, depósito directo, etc.), aparece bajo su registro. Revisa lo completo, aprueba o pide cambios. Cada descarga queda auditada.' },
            },
            {
                title: { en: 'Convert applicant → hire', es: 'Convertir aplicante → hire' },
                body:  { en: 'On the Applications tab, qualified applicants can be promoted to "hire" — copies their info to a new hire record and sends them the onboarding invite in one tap.',
                         es: 'En Aplicaciones, los aplicantes calificados pueden promoverse a "hire" — copia su info a nuevo registro y le envía la invitación de onboarding en un toque.' },
            },
            {
                title: { en: 'PII safety', es: 'Seguridad de PII' },
                body:  { en: 'SSN never lives in Firestore — only inside the filled PDF in Storage. Every view + download writes to /onboarding_audits. Only staff with canViewOnboarding can enter this tab; flip the flag in Admin → Staff list.',
                         es: 'El SSN nunca vive en Firestore — solo dentro del PDF en Storage. Cada vista + descarga queda en /onboarding_audits. Solo personal con canViewOnboarding entra aquí; activa la marca en Admin → Lista de personal.' },
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
