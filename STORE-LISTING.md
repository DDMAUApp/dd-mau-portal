# Google Play production listing — copy-paste package
_Prepared 2026-07-13 for the Forsis LLC org account (developer name: Shih Technology / display brand DD Mau). Paste each block into Play Console → Grow → Store presence → Main store listing._

## App name (30 chars max)
```
DD Mau Staff
```

## Short description (80 chars max)
```
Schedules, chat, checklists & training for DD Mau restaurant teams.
```
ES (if adding a Spanish listing translation):
```
Horarios, chat, listas y capacitación para el equipo de DD Mau.
```

## Full description (4000 chars max)
```
DD Mau Staff is the all-in-one team app for DD Mau Vietnamese Eatery employees.

EVERYTHING IN ONE PLACE
• Your schedule — see your shifts, request time off, and pick up open shifts
• Shift reminders — a push notification an hour before you start
• Team chat — message your team, share photos, and get announcements (with built-in translation)
• Training — station guides, recipes, and quizzes for every role
• Daily checklists — opening, closing, and prep tasks with photo check-offs
• Health & compliance — upload your records and sign required documents right from your phone

BUILT FOR THE TEAM
• English and Spanish throughout
• Works on any phone — updates arrive automatically
• Fast PIN sign-in

This app is for DD Mau restaurant employees. A staff PIN from your manager is required to sign in.
```
ES:
```
DD Mau Staff es la app todo-en-uno para los empleados de DD Mau Vietnamese Eatery.

TODO EN UN SOLO LUGAR
• Tu horario — consulta tus turnos, pide tiempo libre y toma turnos disponibles
• Recordatorios de turno — una notificación una hora antes de empezar
• Chat del equipo — mensajes, fotos y anuncios (con traducción integrada)
• Capacitación — guías de estación, recetas y cuestionarios para cada puesto
• Listas diarias — tareas de apertura, cierre y preparación con fotos
• Salud y cumplimiento — sube tus registros y firma documentos desde tu teléfono

HECHA PARA EL EQUIPO
• Todo en inglés y español
• Funciona en cualquier teléfono — se actualiza automáticamente
• Inicio de sesión rápido con PIN

Esta app es para empleados de DD Mau. Se requiere un PIN de tu gerente para entrar.
```

## Category & contact
- App category: **Business** (Productivity also acceptable; Business fits an ops tool)
- Contact email (public): a ddmau address — ddmau.dev@gmail.com works
- Website: https://ddmaustl.com
- Privacy policy URL (REQUIRED): **https://app.ddmaustl.com/privacy.html**

## Graphics checklist
- App icon: reuse the existing 512×512 store icon (already in Play from internal track)
- Feature graphic (1024×500, REQUIRED for production): logo on dd-green background — can be generated from resources/ artwork
- Phone screenshots (min 2, recommend 4–6, portrait): Home tiles, Schedule week view, Chat thread, Training hub, Health Department status card, Checklist page. Take on a real phone, signed in as a demo/staff account — AVOID screens showing real staff names/phones (use the App Reviewer account).

## Data safety form (Play Console → App content → Data safety)
Answer honestly per current app behavior:
- **Does the app collect or share user data?** Collects: YES. Shares with third parties: NO.
- Data types COLLECTED (all "collected", none "shared"):
  - Personal info → Name (staff roster identity); Phone number (optional, for SMS reminders)
  - Photos and videos → Photos (chat attachments, checklist photos, health-record uploads)
  - Health info → vaccination record dates & documents (Health Department module; staff-entered, employer compliance)
  - App activity → in-app actions (audit logs: schedule edits, sign-ins)
  - Device or other IDs → push notification token
- **Encrypted in transit:** Yes (all Firebase traffic is TLS).
- **Data deletion:** Yes — users can request deletion; mechanism documented at https://app.ddmaustl.com/privacy.html#account-deletion
- Purposes: App functionality, Account management. No advertising, no analytics sold, no data brokering.

## Content rating questionnaire
- Category: Utility/Productivity
- No user-generated public content (chat is private to the workplace team), no violence/sex/drugs/gambling, no location sharing. Expected rating: **Everyone**.

## Target audience
- 18 and over (it's an employment tool). Do NOT tick any under-18 age bands — avoids the Families policy entirely.

## App access (reviewers need to get in!)
Play review requires working credentials for a gated app:
- Provide the **App Reviewer** staff account PIN (the roster already has an "App Reviewer" entry — same one used for the iOS review). Instructions to reviewer: "Open the app, enter PIN <reviewer PIN> on the keypad."
- Keep that account active until review passes.

## Release notes for the first production release
```
DD Mau Staff is now on Google Play! Schedules, team chat, training,
checklists, and health compliance — everything your shift needs.
```

## Order of operations after the app transfer lands
1. Play Console (org account) → the transferred app → complete **App content** items: privacy policy URL, data safety (above), content rating, target audience, app access (reviewer PIN), ads declaration (NO ads).
2. Store presence → Main store listing: paste name/descriptions, upload feature graphic + screenshots.
3. Production → Create release → **promote the existing internal-track build** (no new AAB needed) → add release notes → roll out.
4. First production release goes to Google review (typically 1–7 days). Internal testing keeps working during review.
5. When approved: flip the app's Android install path from the internal-test opt-in link to the public store URL (one-line change in InstallAppButton.jsx / DownloadAppGate.jsx — Claude does this).
```
