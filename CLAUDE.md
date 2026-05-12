# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

```bash
npm run dev                 # Vite dev server (default port 5173)
npm run build               # production build → dist/  (deployed to GitHub Pages on push to main)
npm run preview             # serve the production build locally

npm run backup              # one-shot Firestore JSON dump → backups/firestore-{ts}.json
npm run backup-all          # git pull + Firestore JSON dump (the Backup.command wrapper runs this)
npm run cors-setup          # push cors.json to the GCS Storage bucket via firebase-admin
```

There is no test suite and no lint script. The build does type/import checking via Vite + Rollup; if `npm run build` succeeds, the chunk graph is sound.

Admin scripts (`backup`, `cors-setup`, `pull-toast-menu`) all require `firebase-service-account.json` at the repo root (gitignored). Setup steps live in BACKUP.md / the script files themselves.

GitHub Actions (`.github/workflows/`) auto-builds and deploys to GitHub Pages on every push to `main`. There is no PR / staging environment — pushing to `main` ships to production within ~2 minutes.

## High-level architecture

### Auth model — important caveat
The app uses **anonymous Firestore access** (no Firebase Auth, no per-user signing). Every device that opens the app reads/writes Firestore directly. Security is enforced via:
1. **Client-side access gates** in `App.jsx` (`isAdmin`, `hasOpsAccess`, `canViewOnboarding`, etc.)
2. **Narrow Firestore rules** on high-value paths (`/config/staff`, `/config/recipes`, `/onboarding_hires`) — see `firestore.rules` for the full posture comments
3. **Append-only audit logs** on every meaningful action (`pin_audits`, `recipe_audits`, `onboarding_audits`, `inventory_audits_{location}`, `backup_history`)
4. **PIN-gated lock screen** (`HomePage.jsx`) plus 5-minute idle relock + cold-launch wipe in `App.jsx`

Phase 2 plan (documented inline in `firestore.rules`): wire Firebase Auth + custom claims + App Check enforcement.

Admin identity is anchored to **staff IDs (40 = Andrew, 41 = Julie)**, not names. See `src/data/staff.js`. Renaming a staff record to "Andrew Shih" does NOT grant admin access.

### v2 shell is the only shell
`src/v2/AppShellV2.jsx` is the sole layout — sidebar (desktop) + bottom-nav (mobile) + header. Legacy v1 was deleted; any `?v2=0` URL param is ignored. The `useV2Flag` hook and `ddmau:v2_optout` localStorage key are gone.

### Per-tab access gating
`App.jsx` renders the active tab inside `renderV2Body()`. Each tab has a gate:
- `staffIsAdmin` — `isAdmin(staffName, staffList)` from `src/data/staff.js` (ID-based)
- `isManager` — admin OR `role` matches `/manager/i`
- `hasOnboardingAccess` — `canViewOnboarding(staff)` — owners + opted-in PII viewers
- `hasOpsAccess` — opt-in via `opsAccess: true` on the staff record
- `hasRecipesAccess` — opt-OUT via `recipesAccess: false`
- `canSeePage(staff, tab)` — for hideable pages (menu, eighty6, training, catering, ai, maintenance, insurance) — see `HIDEABLE_PAGES` in `src/data/staff.js`

Per-staff flags live on `/config/staff.list[]` and are edited via the AdminPanel bulk-tag UI.

### Lazy loading
Most components are `React.lazy()` in `App.jsx`. Eager imports are only: `HomePage`, `InstallAppButton`, `AppVersion`, `AppToast`, the v2 shell. Everything else loads on first navigation.

Bundle chunking lives in `vite.config.js`'s `manualChunks`. Three vendor chunks: `vendor-react`, `vendor-firebase` (do NOT split — must load atomically), `vendor-misc` (everything else from `node_modules` except pdf-lib / pdfjs-dist / jszip / qrcode which are excluded so Rollup co-locates them with their lazy route chunks). Read the comment block above `manualChunks` before changing — there's a documented outage tied to mis-splitting Firebase.

### Two locations, location-suffixed collections
The restaurant has two stores: `webster` and `maryland`. Many Firestore docs are suffixed by location:
- `ops/checklists2_webster`, `ops/checklists2_maryland`
- `ops/inventory_webster`, `ops/inventory_maryland`
- `ops/labor_webster`, `ops/labor_maryland`
- `ops/86_webster`, `ops/86_maryland`
- `inventoryHistory_webster`, `inventoryHistory_maryland`
- `inventory_audits_webster`, `inventory_audits_maryland`
- `checklistHistory_webster`, `checklistHistory_maryland`

Staff with `location: 'both'` see admin-selectable location toggle in the header (cycle webster → maryland → both). Staff with a single location are pinned.

### Schedule, hires, and templates collections (NOT location-suffixed)
- `shifts/{id}` — every shift (drafts + published), filtered client-side by side/location
- `date_blocks/{id}` — closures, blackouts, "single person" markers
- `time_off/{id}` — PTO requests
- `notifications/{id}` — per-user notifications (shift offers, swap approvals)
- `recurring_shifts/{id}` — "Maria works Mon/Wed 9-3 every week" rules
- `staffing_needs/{id}` — open slots ("need 3 FOH on Friday")
- `schedule_templates/{id}` — reusable day patterns; have `daysOfWeek: string[]` for day-of-week filtering
- `onboarding_hires/{id}` — new-hire records (PII)
- `onboarding_invites/{token}` — single-use, time-boxed (30 days)
- `onboarding_applications/{id}` — public "Apply" form submissions
- `onboarding_templates/{id}` — admin-uploaded fillable PDF templates with field positions

### Storage layout
- `onboarding/{hireId}/{docId}/{ts}_{name}` — PII files (W-4, I-9, ID photos, etc.)
- `onboarding_templates/{templateId}.pdf` — blank fillable PDFs
- Bucket: `dd-mau-staff-app.firebasestorage.app`

**Download files via `getBytes()` (SDK XHR path), NOT `getDownloadURL() + fetch()`.** The new `.firebasestorage.app` bucket's CORS config doesn't propagate consistently to plain fetch from cross-origin; `getBytes` goes through Firebase's auth-aware channel. The bucket's CORS is set by `cors.json` + `npm run cors-setup`. See `f18b4be` + `e6449c3` for the bug context.

### Onboarding portal (token-gated public route)
URLs that bypass the PIN lock screen:
- `/?onboard=TOKEN` → `OnboardingPortal.jsx` (new hire fills paperwork)
- `/?apply=1` → `OnboardingApply.jsx` (public job application form)

Detection happens at mount in `App.jsx`'s `readOnboardingMode()`.

### Fillable PDF templates
`OnboardingTemplateEditor.jsx` (admin) and `OnboardingFillablePdf.jsx` (hire) work together:
1. Admin uploads a blank PDF and clicks to place fields (text/date/checkbox/signature/initials) over the rendered PDF image. Positions stored as fractions (0–1) of page width/height.
2. Hire opens portal → component fetches template metadata + PDF bytes via `getBytes()`, renders pages as canvases, overlays absolute-positioned `<input>` elements at the stored fractions.
3. Submit generates a final PDF via `pdf-lib`, embeds signatures, uploads to Storage.
4. Per-field props: `filledBy` (`hire` / `static` / `employer`), `required` (default false), `autofill` (binding to hire data).

iOS Safari UA min-height on `<input>` overrides explicit `height: X%` — defeated with `minHeight: 0, minWidth: 0, lineHeight: 1` inline styles. See `OnboardingFillablePdf.jsx` FieldInput comment.

### Cloud Functions (`functions/`)
- `sendShiftReminders` — 1-hour-before-shift FCM push
- `onboardingReminderScan` — overdue-doc reminder emails (planned)
- `scheduledFirestoreBackup` — daily managed export to `gs://dd-mau-staff-app-backups/YYYY-MM-DD/` at 3am Central; writes `backup_history` log

Deploy: `firebase deploy --only functions`.

### Push notifications (FCM)
Setup runbook is in `FCM_SETUP.md`. The VAPID key lives in `src/messaging.js`; the SW lives in `public/firebase-messaging-sw.js`. App.jsx calls `enableFcmPush(staffName, staffList, setStaffList)` after sign-in and the token is stored on the staff record's `fcmTokens` array.

### External integrations
Vendor pricing / scrapers / POS are on a separate Railway service, not in this repo:
- **Toast POS** — labor scraper writes to `ops/labor_{loc}`; orders scraper writes to `ops/orders_{loc}`
- **Sysco / US Foods** — price scrapers writing to `vendor_*` collections; cookies via storage_state
- **Sling** — CSV import (was a scraper, now CSV-based)

Use only official APIs, EDI, SFTP, CSV/XLSX imports, invoice exports, or approved integrations. No scraping that violates ToS.

### Backup posture
Three layers (see BACKUP.md):
1. **Firestore PITR** — 7-day rolling, built into Firestore, no setup
2. **Daily managed export** (`scheduledFirestoreBackup` Cloud Function) → GCS bucket
3. **Local JSON dump** (`npm run backup` / `Backup.command`) — laptop insurance

## Style notes

- This codebase has VERY heavy comment blocks at the top of functions / sections explaining WHY decisions were made (outage history, edge cases, etc.). Don't strip them — they're load-bearing. When you fix a bug, ADD to the comment block explaining the new constraint.
- Tailwind v3 with custom tokens in `tailwind.config.js`: `dd-green`, `dd-sage`, `dd-bg`, `dd-line`, `dd-charcoal`, `dd-text`, `dd-text-2`. Legacy `mint-*` colors are still around — prefer `dd-*` for new code.
- Bilingual: every user-facing string uses `tx(en, es)` or `language === 'es' ?` ternaries. Don't hardcode English-only strings.
- File-level conventions: components in `src/components/*.jsx` (legacy), v2 shell in `src/v2/`, data + helpers in `src/data/`, plain JS infra in `src/firebase.js` / `src/messaging.js` / `src/pwa.js`.
