# DD Mau → Restaurant Ops SaaS — Architectural Blueprint

**Author**: Claude (senior product architect / full-stack lead / restaurant-ops consultant) for Andrew Shih, 2026-05-16

---

## 0. Honest Assessment of Where You Are Today

Before the blueprint — the senior-eng read of the current codebase, no sugar:

| Area | Status | Salability impact |
|---|---|---|
| **Tenant model** | Single tenant. DD Mau hardcoded everywhere. | 🔴 Must rebuild before selling. |
| **Auth** | Anonymous Firestore. No per-user identity. PIN screen + admin IDs 40/41. | 🔴 Blocker. No tenant can trust this with their staff PII. |
| **Permissions** | Mostly client-side gates. Firestore rules are mostly permissive (`allow read, write: if true`). | 🔴 Blocker. Server-side enforcement absent. |
| **Multi-location** | Built-in (webster / maryland). Works. | 🟢 Already SaaS-ready. |
| **i18n** | Bilingual en/es throughout. | 🟢 Already SaaS-ready. |
| **Modules** | Operations, Schedule, Onboarding, Recipes, Training all real. | 🟢 Strong product surface. |
| **Mobile-first** | PWA + bottom nav + FCM push working. | 🟢 Big asset. |
| **Code health** | Schedule.jsx 6300 lines, Operations.jsx 4000+, AdminPanel.jsx ~2000. | 🟡 Will slow you down at 10+ tenants. Splits needed but not yet blocking. |
| **Test coverage** | Zero automated tests. | 🔴 Can't safely refactor for multi-tenancy without this. |
| **Backups** | 3-layer (PITR + scheduled export + local). | 🟢 Solid. |
| **Audit logs** | Per-action append-only (pin_audits, recipe_audits, inventory_audits, onboarding_audits, backup_history). | 🟢 Real differentiator. |
| **Integrations** | Toast OAuth + scrapers (Sysco/USFoods) + Sling CSV. | 🟢 Strong; will need to genericize per-tenant. |

**Bottom line**: you have a strong PRODUCT surface area (the features work) and you have FOUNDATIONS that aren't SaaS-grade yet (auth, permissions, multi-tenancy). The path forward: keep shipping product features that pay off internally, but every new feature gets designed for multi-tenancy from day one. The "convert" project happens in phases on the foundation.

---

## 1. Full Product Blueprint

### The "what is this?" pitch

**RestaurantOS** (placeholder name): a mobile-first operating system for full-service and fast-casual restaurants. It replaces 4-6 separate tools (Sling for scheduling, 7shifts, Toast Manager Log, Google Drive for SOPs, Notion for training, an HR portal). One app, role-aware, multi-location, multi-tenant.

### The 6 product surfaces

1. **Floor App** (line staff): mobile-first. View schedule, request swaps, get push reminders, run opening/closing checklists, view recipes, log incidents, request PTO, complete training modules.
2. **Manager Console** (shift leads + managers): everything in Floor + schedule editor, fill staffing needs, approve PTO, review incidents, daily prep sheets, 86 board, manager log, KPI tile.
3. **Owner Dashboard** (multi-location owners): cross-location P&L, labor %, sales, food cost variance, food safety log audit, manager log audit, period-close packet generator.
4. **HR / Onboarding** (HR or office manager): applications inbox, hire pipeline, fillable PDFs, document expiry tracking, monthly hire packet export.
5. **Configuration & Customization** (admin): roles, permissions, schedule templates, checklist templates, recipe library, allergen matrix, feature-module toggles.
6. **Public Apply page** (job candidates): tenant-branded application form, single-use invite tokens for new hires to complete paperwork.

### Module catalog (each ships as a toggleable feature flag)

```
core           — staff list, auth, permissions, lock screen, notifications
schedule       — shifts, templates, swaps, PTO, availability, time-off
operations     — opening/closing checklists, prep sheets, manager log
inventory      — counts, par levels, 86 board, vendor matching
recipes        — recipe + prep guide library, allergen matrix
training       — modules, quizzes, completion tracking, certifications
onboarding     — job applications, hire pipeline, fillable PDFs, doc expiry
incidents      — incident reports, food safety logs, maintenance requests
labor          — POS integration (Toast/Square/Clover), labor % KPI, SPLH advisor
accounting     — monthly close packet, sales/labor exports, vendor invoice digest
hiring         — candidate tracker, stage chips, team ratings
catering       — catering order pipeline (DD Mau-specific now, generalizable)
```

**Tiering** (Module bundles to sell):

- **Starter** (`$X/mo per location`): core + schedule + operations + recipes
- **Pro** (`$Y/mo`): + inventory + training + onboarding + labor integration  
- **Enterprise** (`$Z/mo`): + incidents + accounting + hiring + custom SSO + API access

Pricing detail in §14.

---

## 2. MVP Roadmap

The "convert DD Mau into a sellable product" plan, in order. Each phase is shippable on its own — you can stop at any point.

### Phase A: Multi-tenant foundations (8-12 weeks)
**Goal**: make DD Mau a tenant of a multi-tenant system. After this phase you can onboard a second restaurant in <1 day.

1. **Add Organizations & Tenants schema** (§3).
2. **Migrate Anonymous Firestore → Firebase Auth + custom claims** (§4, §9).
3. **Rewrite Firestore rules** for tenant isolation (§9).
4. **Refactor every Firestore read/write** to scope by `orgId`.
5. **Tenant config doc**: per-org settings (name, location list, role labels, FOH/BOH terminology, currency, timezone, language defaults).
6. **Replace hardcoded admin IDs 40/41** with role checks.
7. **Migration script**: existing DD Mau data → tenant doc.
8. **Basic test suite** (Vitest + Firestore emulator). Cover the rules + the schema migration.

### Phase B: Productization (4-6 weeks)
Goal: anyone can try and adopt without my involvement.

1. **Self-serve tenant onboarding wizard**: signup → restaurant name → location → invite first manager → done.
2. **Tenant settings UI**: location toggle, role config, language default, module enable/disable.
3. **Billing**: Stripe subscriptions + per-location pricing.
4. **Generic POS adapter**: today Toast-only; abstract to support Square + Clover in Phase D.
5. **Tenant-branded apply page**: subdomain or custom path.
6. **Owner dashboard** with cross-location KPIs (currently HomeV2 is single-location).

### Phase C: Polish + sell (ongoing)
1. **Marketing site** (separate Vercel/Astro project): pricing, demo video, signup CTA.
2. **Demo tenant**: pre-populated "Bistro Demo" for trial signups to explore.
3. **Documentation site**: docs.restaurant-os.app — staff manual + manager guide + API ref.
4. **Public API + webhooks**: paid tier — let customers integrate their own BI / payroll / etc.
5. **Mobile native shell** (optional): Capacitor wrap if PWA install friction becomes the bottleneck.

### Phase D: Scale (when you have 10+ paying tenants)
1. **Multi-region** (Firestore is single-region by default; if you sell internationally, split per region or migrate to Spanner).
2. **Generic POS adapter** (Square / Clover / Lightspeed) — Toast is fine if you're staying US fast-casual.
3. **Per-tenant data export** for GDPR / CCPA compliance.
4. **Tenant SSO** (Google Workspace, Okta) — Enterprise tier feature.

---

## 3. Multi-Tenant Database Schema

Current Firestore is flat: `/config/staff`, `/shifts/{id}`, `/ops/inventory_webster`, etc. All implicitly DD Mau. For multi-tenancy, every doc needs an `orgId` and the path needs to be tenant-scoped OR every query needs to filter by orgId.

**Recommended pattern** — top-level `orgs/{orgId}/...` subcollections:

```
orgs/{orgId}                            // tenant root
  name: "DD Mau"
  createdAt, status, plan, billingCustomerId
  modules: { schedule: true, training: true, onboarding: true, ... }
  settings: {
    timezone: "America/Chicago",
    primaryLanguage: "en",
    currency: "USD",
    fiscalWeekStartDay: 1,    // Mon
    sideLabels: { foh: "FOH", boh: "BOH" },  // restaurant can rename
    schedulePublishLeadDays: 7,
  }
  locations: [
    { id: "loc_webster", name: "Webster Groves", address, phone, posId, posType: "toast" },
    { id: "loc_maryland", ... }
  ]

orgs/{orgId}/users/{userId}             // staff record
  authUid: "abc123"  // Firebase Auth UID
  email, displayName, phone
  role: "owner" | "manager" | "shift_lead" | "staff"
  permissions: { canViewOnboarding, canViewLabor, ... }
  locations: ["loc_webster"]  // which locations they work at
  scheduleHome: "loc_webster"
  scheduleSide: "foh" | "boh"
  status: "active" | "invited" | "suspended" | "terminated"

orgs/{orgId}/shifts/{shiftId}
orgs/{orgId}/schedule_templates/{id}
orgs/{orgId}/time_off/{id}
orgs/{orgId}/date_blocks/{id}
orgs/{orgId}/staffing_needs/{id}
orgs/{orgId}/notifications/{id}
orgs/{orgId}/recurring_shifts/{id}

orgs/{orgId}/locations/{locId}/inventory/items[]
orgs/{orgId}/locations/{locId}/checklists2/...
orgs/{orgId}/locations/{locId}/labor/{date}
orgs/{orgId}/locations/{locId}/eighty_six[]
orgs/{orgId}/locations/{locId}/manager_log/{entryId}

orgs/{orgId}/recipes/{recipeId}
orgs/{orgId}/training_modules/{moduleId}
orgs/{orgId}/training_progress/{userId}_{moduleId}
orgs/{orgId}/onboarding_hires/{hireId}
orgs/{orgId}/onboarding_applications/{appId}
orgs/{orgId}/onboarding_templates/{tplId}
orgs/{orgId}/incidents/{id}
orgs/{orgId}/maintenance_requests/{id}
orgs/{orgId}/food_safety_logs/{id}

orgs/{orgId}/audits/{auditId}           // ALL audit logs unified

orgs/{orgId}/integrations/{provider}    // toast, sysco, square, etc.
  credentialsRef: <Secret Manager path>
  config, lastSyncAt, status
```

**Why this shape**:
- Single rule per top-level collection: `match /orgs/{orgId}/{document=**} { allow read, write: if userIsMemberOf(orgId) && ... }` — simpler than per-collection rules.
- Easy per-tenant data export (one collectionGroup query under one path).
- Indexes are scoped per-tenant — no global cross-tenant index leaks.

**Migration from current schema**:
1. Wrap every read/write in a helper: `orgRef(orgId).collection("shifts")` instead of `collection(db, "shifts")`.
2. Backfill script: copy current `shifts/{id}` → `orgs/dd_mau/shifts/{id}`, etc.
3. Atomic switchover at deploy: feature-flagged.

**Don't** do top-level `tenantId` field on flat collections. Firestore rules can enforce it but queries get clunky and you can't use collection-group queries across tenants safely.

---

## 4. User Roles & Permissions

Move from "ID 40 = owner" to a real role system.

### Canonical roles (4 + custom)

| Role | What they see / can do |
|---|---|
| `owner` | Everything. Org-level: billing, modules, all locations, audit logs. |
| `manager` | One or many locations. Schedule write, hire actions, ops, incidents. No billing. |
| `shift_lead` | Same location only. Schedule view + limited edits (within their side). Approve simple swaps. |
| `staff` | Their schedule, swap requests, training, recipes, PTO requests. Read-only ops checklists they're assigned to. |
| `custom` | Owner-defined: HR officer, accountant, kitchen manager, etc. Permission chips. |

### Granular permission chips

Layered on top of roles for the "everyone here is a manager but only some can see payroll" case:

```
- can_view_payroll
- can_view_labor_kpi
- can_view_onboarding (PII)
- can_edit_recipes
- can_edit_schedule_foh
- can_edit_schedule_boh
- can_approve_swaps
- can_close_period
- can_export_reports
- can_admin_billing
```

Stored in `orgs/{orgId}/users/{userId}.permissions: { canViewPayroll: true, ... }`.

### Permission resolution (server-side)

```typescript
// Firebase Auth custom claims, set on tenant invite + role change:
{
  orgId: "dd_mau",
  role: "manager",
  locations: ["loc_webster"],
  permissions: ["can_view_payroll", "can_edit_recipes"],
}
```

Rules use `request.auth.token.role` and `.permissions` — no Firestore reads required inside rules (fast path).

### What goes away

- The hardcoded `ADMIN_IDS = [40, 41]` in `src/data/staff.js` — replaced by `role === 'owner'`.
- The `isAdmin(staffName, staffList)` lookup — replaced by Auth claims.
- The `canViewOnboarding` per-staff flag — becomes a permission chip.

---

## 5. Module Structure

Each module is a directory under `src/modules/{moduleId}/` with the same shape:

```
src/modules/schedule/
  index.js              // module manifest: id, name, requires, defaults
  routes.js             // nav entries + tab routes
  components/...        // module-scoped components
  hooks/...             // module hooks
  api/...               // module API client
  permissions.js        // what permissions this module checks
  flag.js               // is this module enabled for this org?
```

**Module manifest** (one source of truth for the marketing tier):

```js
// src/modules/onboarding/index.js
export default {
  id: 'onboarding',
  name: { en: 'Onboarding', es: 'Incorporación' },
  tier: 'pro',                    // starter / pro / enterprise
  icon: '🪪',
  requires: ['core', 'storage'],  // depends on other modules
  defaultEnabled: false,
  permissions: ['can_view_onboarding'],
};
```

Tenant has `orgs/{orgId}.modules: { onboarding: true, training: false }`. App boot reads this and registers routes / nav for enabled modules only. Sidebar/MobileBottomNav iterate the registered modules.

**Pay-off**: when you sell to a coffee shop that doesn't need training modules, you flip the flag off. When you launch a new module, only the orgs on that tier see it.

**Migration to this from current code**: 
- Operations.jsx → split into `src/modules/operations/` (already overdue).
- Schedule.jsx → split into `src/modules/schedule/`.
- AdminPanel.jsx → already mostly admin-scoped; just relocate.
- The lazy-loading boundary already exists in App.jsx — modules just formalize it.

---

## 6. API Design

Today you're 95% Firestore-direct. That's actually fine for the MVP — Firestore is your API. But for the SaaS pitch + integrations + future native app, you need a small public API layer.

### Public API (HTTP + REST) — when to build

Phase A: skip. Direct Firestore + Cloud Functions for write actions is enough.

Phase B–C: introduce a thin REST layer for these use cases:
1. Tenant onboarding wizard (multi-step writes that should be transactional)
2. Stripe webhooks (Stripe → Cloud Function → tenant status update)
3. POS adapter (Toast/Square webhooks need a server endpoint to receive)
4. Public Apply form submissions (no client SDK)

Phase D: full REST + GraphQL for paid-tier API access — let tenants integrate their BI/payroll.

### Suggested namespaces

```
POST   /v1/auth/signup              // create org + first owner
POST   /v1/auth/login               // password / SSO
GET    /v1/orgs/:orgId              // org config (membership-gated)
PATCH  /v1/orgs/:orgId/modules      // toggle modules (owner only)
GET    /v1/orgs/:orgId/users        // user list
POST   /v1/orgs/:orgId/users/invite // send email invite

POST   /v1/webhooks/stripe          // billing events
POST   /v1/webhooks/toast/:orgId    // POS push
POST   /v1/webhooks/twilio          // SMS opt-in
```

Implementation: Cloud Functions v2 (already in use for `sendShiftReminders` etc.). Same runtime. Region-pinned.

### Internal SDK pattern

For client code, wrap Firestore in a `useOrgData()` hook that hides orgId:

```js
const { collection, doc } = useOrg();
collection('shifts').where('date', '>=', today).onSnapshot(...)
// auto-injects orgId
```

This is your single migration point — change one helper, every read/write scopes correctly.

---

## 7. Frontend Navigation

Today the v2 shell already supports modular routing. Just generalize it:

### Top-level shell (no changes to v2)

- **Header**: tenant logo + location toggle + notification bell + profile menu
- **Sidebar (desktop) / BottomNav (mobile)**: registered module entries (read from module manifests)
- **Body**: lazy-loaded module root

### Module entry pattern

Every module exports a root component + the nav metadata. Sidebar reads from a module registry array; doesn't hardcode tab names.

### Owner dashboard (new — Phase B)

Separate route `/owner` accessible only when `role === 'owner'`:
- Cross-location KPIs (sales, labor %, food cost, schedule completion)
- Audit log viewer (filterable: who changed what when)
- Module toggles
- Billing
- Tenant settings
- User + permission management
- Period-close report packet (download PDF zip)

---

## 8. Admin Dashboard

Already partially exists (AdminPanel.jsx). Needs split:

- **Org Admin** (owner-only): billing, modules, tenant settings, audit logs
- **People Admin** (manager+): user list, roles, permissions, invites, terminations
- **Module Admin** (manager+): per-module config (schedule templates, recipe library, checklist templates)
- **Integrations** (owner+): Toast, Stripe, vendor accounts, webhooks

Right now everything is one giant scrollable AdminPanel. Owner doing billing shouldn't have to scroll past 200 staff records.

---

## 9. Security Model

This is the biggest single thing standing between you and being sellable.

### Today's posture
- Anonymous Firestore auth
- Default `allow read, write: if true` on most paths
- Client-side gates only
- PIN-protected lock screen + ID-based admin check
- All staff PII (PINs, names, role, location) readable by any signed-in device

### Target posture (Phase A)

1. **Firebase Auth** — every user has an email + password OR Google SSO. PIN becomes a SECONDARY device-lock (still useful for shared tablets).
2. **Custom claims** set via Cloud Function on role assignment:
   ```
   { orgId, role, locations: [], permissions: [] }
   ```
3. **Firestore rules** that read claims (no DB lookup needed):
   ```
   match /orgs/{orgId}/{document=**} {
     allow read: if request.auth != null && request.auth.token.orgId == orgId;
     allow write: if request.auth.token.orgId == orgId
                  && hasRole(['owner', 'manager']);
   }
   ```
4. **Per-collection write rules**: shifts can only be edited by `can_edit_schedule_*`. PTO can only be approved by manager+. Audit logs are write-once.
5. **App Check** ENFORCED (currently UNENFORCED) on all paths.
6. **Sensitive PII** (SSN, W4, bank info) goes into a separate `private/` subcollection with stricter rules — even managers don't read unless they have `can_view_onboarding`.
7. **Storage rules** mirror Firestore rules: per-org bucket prefix.

### Secrets management

- Toast OAuth credentials, Stripe API keys, vendor cookies → **Google Secret Manager**, not in `.env`.
- Cloud Functions load secrets at boot via `defineSecret()`.
- Local development: `.env` is gitignored AND uses limited-scope dev credentials.

### Common attacks to defend against

| Attack | Defense |
|---|---|
| Tenant A reads tenant B data | Rules: `orgId == request.auth.token.orgId` |
| Staff escalates to manager | Custom claims signed by Firebase; only Cloud Functions can mint |
| Pin brute force | Already have audits; add 3-failed-attempts lockout |
| Stolen JWT | Token TTL + revocation list on role change |
| Webhook spoofing | Stripe + Toast signed payloads; verify in Cloud Function |

---

## 10. Data Import / Export Plan

### Import (tenant onboarding)
- **Staff list**: paste / CSV upload / Toast pull (already shipped 📥 Import Staff).
- **Schedule history**: CSV import for last N weeks (skip in MVP — tenants build forward).
- **Recipes**: paste markdown OR import from Notion / Google Doc.
- **Inventory items**: CSV upload (template provided).
- **Vendor list**: CSV upload.

### Export (accountant / HR / off-boarding)
- **Period-close packet** (PDF zip): sales summary, labor summary, schedule, payroll prep, food cost. Owner downloads monthly.
- **All-data export** (GDPR / off-boarding): JSON zip of every collection scoped to org. Owner-initiated, Cloud Function generates async, emailed link to download.
- **Audit log export**: filterable CSV.
- **Per-employee record export**: HR offboarding — one person's full file.

Format prefs: PDF for human reading, CSV for spreadsheets, JSON for system migration. All three.

---

## 11. QA & Testing Plan

Current state: zero automated tests. You can't refactor safely.

### Phase A — must-have before multi-tenant migration

1. **Firestore emulator + Vitest**. Spin up the emulator in CI, run rule tests.
2. **Rule test suite**: assert tenant A can't read tenant B for every collection. ~50 tests.
3. **Schema migration test**: run migration on a snapshot of current data, assert nothing's lost.

### Phase B — shipping-blockers

4. **Component smoke tests**: render each module's root, assert no crash. Vitest + React Testing Library. ~20 tests.
5. **Happy-path integration test** per module: e.g. "manager publishes a shift, staff sees it." Run against emulator.

### Phase C — pre-sale

6. **End-to-end test**: Playwright. New tenant signs up → creates first user → publishes schedule → done. One golden-path test that runs on every deploy.
7. **Visual regression** on the 5 most-trafficked screens.
8. **Load test**: 50 concurrent users on one tenant. Firestore can handle, but rules can be slow if poorly written.

### Manual QA checklist (before every release)

- Mobile Safari (iOS PWA): can install, can sign in, can view schedule, can take a shift offer.
- Mobile Chrome (Android): same.
- Desktop Chrome: admin flows work.
- Dual-language: switch to Spanish, verify nothing's English.
- Offline: lock screen + cached schedule view still works.

---

## 12. Launch Checklist (first paying tenant)

When you have your first non-DD-Mau customer signing a contract:

- [ ] Multi-tenancy migration complete + DD Mau migrated
- [ ] Phase B Stripe billing live with at least one Test-mode subscription
- [ ] Tenant onboarding wizard works end-to-end
- [ ] Auth + custom claims + tight Firestore rules deployed
- [ ] App Check ENFORCED
- [ ] Privacy policy + Terms of Service published
- [ ] DPA (Data Processing Agreement) drafted (you'll need this for any commercial customer)
- [ ] Backup verified working
- [ ] Incident response runbook drafted (what do you do if Firestore is down?)
- [ ] Support email + Slack response time SLA written (even informally)
- [ ] Marketing site: pricing, demo video, signup
- [ ] At least one written customer agreement template
- [ ] Liability insurance (E&O / cyber) — talk to your insurance broker
- [ ] Status page (statuspage.io) — even if it just shows green, lends credibility
- [ ] Documentation site with at least Quick Start + Admin guide

---

## 13. Future SaaS Roadmap (12+ months out)

- **Mobile native apps** (Capacitor) — if PWA install friction caps adoption.
- **Public REST API + webhooks** — paid tier feature.
- **Marketplace / integrations directory** — Toast, Square, Lightspeed, Clover, ADP, Gusto, QuickBooks.
- **AI features**: schedule autosuggest, demand forecasting, food cost variance flagging, manager log auto-summary.
- **Multi-region** — Firestore is single-region. If you sell internationally, plan migration path early.
- **White-label**: enterprise tier lets a multi-brand owner skin per concept.
- **Investor-grade analytics**: cohort retention, MRR/ARR, churn dashboard.

---

## 14. Pricing & Packaging

Industry reference (2026):
- Sling: $4-5 per user/mo
- 7shifts: $30-90 per location/mo
- Toast Manager Log: free with POS
- Crunchtime (enterprise inventory): $500-2000/mo per location

### Suggested pricing (US fast-casual focus, your target market)

**Starter — $79/location/month**
- Core, Schedule, Operations, Recipes, Mobile app
- Up to 25 staff
- Email support
- Designed for one-location independent operators

**Pro — $149/location/month**
- All Starter +
- Inventory + Vendor pricing
- Training modules + quizzes
- Onboarding (job applications, hire packets, fillable PDFs)
- POS integration (Toast / Square)
- Labor KPI + SPLH advisor
- Unlimited staff
- Chat support
- Designed for multi-location independents

**Enterprise — $299+/location/month**
- All Pro +
- Incidents + food safety logs
- Accounting period-close packets
- Hiring pipeline
- Custom roles + SSO
- API access
- Custom integrations
- Dedicated success manager
- Designed for small chains (5-30 locations)

**Add-ons**
- Additional locations: 20% off the per-location price for >5 locations
- Onboarding service: $499 one-time (we set up your data + train your team)
- Annual: 15% off if paid upfront

**Why this works for you specifically**:
- DD Mau lives in Pro tier — you eat your own dogfood
- Friction-free Starter gets you fast adoption
- Enterprise tier covers the work you're already doing (incidents, accounting packets — already half-built in DD Mau)
- $149/location matches Sling + 7shifts COMBINED — your value prop is "stop using 4 tools"

---

## What I Would NOT Build Yet

A senior-eng list of "no, not now":

- **AI features**. They're hype-driven. Wait until you have data from 20+ tenants worth of real usage; then the auto-suggest models actually have signal.
- **Mobile native apps** (Capacitor). PWA is sufficient for restaurant ops. If you have user research saying "I won't install a PWA," revisit.
- **Multi-region**. You don't have international customers. One US region is fine until you do.
- **GraphQL**. REST is sufficient. GraphQL adds complexity that pays off at 100+ endpoints, not 20.
- **Microservices**. Firebase + a few Cloud Functions is a monolith and that's GOOD at your scale. Don't split until you have a team big enough to own the pieces.
- **Custom SSO** for non-Enterprise tiers. Tiered features.
- **Per-tenant theming** beyond logo + accent color. White-label is Enterprise only.
- **Real-time chat/messaging module**. There are good 3rd parties (Stream, Sendbird) — integrate, don't build.

---

## Concrete First 90 Days (your action plan)

**Weeks 1-2** — Get test infrastructure in.
- Add Vitest + Firestore emulator.
- Write tests for current rules (they're permissive — you'll have very few assertions, that's fine, the goal is wiring up CI).
- Set up GitHub Actions to run tests on every push.

**Weeks 3-4** — Multi-tenant schema scaffolding.
- Define the `orgs/{orgId}/...` shape.
- Build `useOrg()` hook + `orgRef()` helper.
- Wrap one collection (start with `shifts`) end-to-end.
- Keep the old paths working in parallel.

**Weeks 5-8** — Migrate every module to org-scoped.
- One module at a time: shifts → schedule_templates → time_off → date_blocks → ...
- Each migration: dual-write to old and new paths; cutover at end.

**Weeks 9-10** — Real auth.
- Replace anonymous Firestore with Firebase Auth + email/password.
- Custom claims on signup + role change.
- PIN screen becomes secondary device lock.

**Weeks 11-12** — Real Firestore rules.
- Strict tenant isolation.
- Per-collection role checks.
- App Check ENFORCED.

After 90 days: you can onboard the second restaurant in a day. The product is sellable.

---

## Summary — what to do tomorrow morning

1. **Stop adding features** for two weeks. Andrew, this is the hardest part. Every feature you add to the single-tenant DD Mau codebase is debt you'll pay back during migration. Hold the line.
2. **Set up CI + tests** (Week 1).
3. **Migrate shifts to `orgs/{orgId}/shifts`** as the proof-of-concept (Week 2-3).
4. **Hire a part-time engineer** if budget allows — multi-tenant migration is a 90-day focused effort and pairs well with someone else owning the test surface while you keep shipping product fixes.

---

*This document is the source of truth. Update it as decisions get made. Living doc.*
