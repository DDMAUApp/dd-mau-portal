# DD Mau → Multi-Tenant SaaS — Architecture & Migration Plan

> Planning document. **No code changes** are implied by this file — it is the map for
> turning the live, single-business DD Mau staff portal into a multi-tenant subscription
> SaaS **without ever interrupting the running business.** Authored 2026-06-25.

---

## 0. The one finding that drives everything

Three verified facts about the live system today:

1. **There is no authentication.** Login is a client-side 4-digit PIN checked against a
   shared staff list. `@firebase/auth` is only a transitive dependency — nobody signs in.
2. **There is no server-side authorization.** `firestore.rules` ends in a catch-all
   (`match /{document=**} { allow read: if true; … allow delete: if true }`). Most data is
   world-readable/writable. "Admins only" is enforced in React, not on the server.
3. **There is no tenancy and no billing.** No `tenantId`, no Stripe, no subscriptions. The
   only multi-entity axis is a hardcoded `location` field (`webster`/`maryland`) — one
   business, two stores.

**Why this dominates the decision:** you cannot isolate tenants you cannot authenticate.
Dropping a second business's data into this database today would let any staff phone — or
anyone with the Firebase config, which ships in the web bundle — read it. **The gating
prerequisite for every multi-tenant path is the same: build real authentication +
tenant-scoped security rules first.**

On this stack there is **no traditional API server**. "The backend enforces isolation"
means **Firebase Auth custom claims + Firestore security rules + Cloud Functions**. That
*is* the backend, and it's where today's app is weakest.

---

# PART 1 — SaaS Architecture Strategy

## 1.1 Current-state audit (SaaS-readiness)

🟢 reusable · 🟡 needs tenant-aware rework · 🔴 missing/blocker

| Area | Today | Ready? |
|---|---|:--:|
| App architecture | React 18 + Vite SPA, Firestore, Capacitor iOS/Android, Capgo OTA, Cloud Functions, Railway scraper | 🟡 |
| Backend | Firebase Functions + Firestore + Railway Python; no tenant context | 🟡 |
| Frontend | One well-factored SPA, role-gated client-side | 🟢 |
| DB schema | Flat Firestore collections, `location` field; **no `tenantId`** | 🔴 |
| Authentication | **None** — PIN vs shared staff list | 🔴 blocker |
| Permissions | `isAdmin(name, staffList)` in React; no server enforcement | 🔴 |
| Store/location | Hardcoded webster/maryland | 🟡 → becomes *locations under a tenant* |
| Scheduling / time clock / inventory / payroll / reporting | Deep, working features | 🟢 reusable; need `tenantId` |
| Billing / subscriptions / tenant isolation | **Nothing** | 🔴 blocker |
| Data security | Catch-all `if true` rules; config in bundle | 🔴 |
| Logging/monitoring | Sentry + error_logs + health checks + debug agent | 🟢 (tag `tenantId`) |
| Feature flags | Ad-hoc constants; no system | 🔴 |

**Headline:** the *product* layer (scheduling, time clock, inventory, payroll, notifications,
reporting) is strong and reusable. The *platform* layer (auth, authz, tenancy, billing,
flags) is essentially absent. SaaS is ~80% platform work — but you don't throw away the 80%
product value to get there.

## 1.2 Option comparison

| Dim | A: Separate FE, shared BE | B: Multi-tenant in-place | C: Copy the app | **D: Hybrid → B** |
|---|---|---|---|---|
| Pros | Biz UI untouched | Correct end-state, 1 codebase | Biz untouched, fast start | Biz untouched *during build*, 1 codebase, reversible |
| Cons | Doesn't fix the backend; 2 FEs | Big-bang on a live `if true` DB w/ no auth | **2 codebases forever → drift = the mess you fear** | Discipline (envs/flags); interim 2-project complexity |
| Risk | Med-High | **High** in-place | Low now / **High** later | **Low** |
| Long-term scale | Low | Highest | Poor | **Highest** |
| Maintenance | High | Lowest | **Highest (2×)** | Low long-term |
| Data isolation | None | Strong *after* rules/auth | Biz↔SaaS only | **Strongest** (proven before biz migrates) |
| Billing | None | Clean | Still to build | **Clean** |
| Fit for you | No | Right destination, wrong vehicle | The trap | ✅ |

**B is the destination; D is the safe route to B. C is the trap** (violates "don't rebuild
twice" + "don't make a mess"). **A** leaves the hard 80% unsolved.

## 1.3 Recommendation (Part 1)

**Option D — a hybrid phased migration to a single, true multi-tenant codebase, built in a
new Firebase project, with the live business frozen and untouched, then migrated in *last*
as a protected, comped "tenant zero."**

- **Build first:** authentication + tenant-scoped Firestore rules, proven by tests that
  Tenant A cannot read Tenant B. Nothing else matters until this exists.
- **Separate immediately:** a new Firebase project for SaaS; Stripe (test mode); the SaaS
  signup surface. Business stays on its current project, untouched.
- **Stay shared:** ONE codebase; the product features become tenant-parameterized.
- **Tenant-aware:** every collection (`tenantId`), every read/write (a data-access layer
  injects it), every Cloud Function (derive tenant from the token), Storage, FCM, scraper,
  logs.
- **Feature-flag:** plan-gated capabilities (payroll, receipt-AI, multi-location, advanced
  reports), resolved as *plan entitlement → per-tenant override → global default*.
- **Your business becomes:** a **protected internal "tenant zero"** (`isInternal`, comped),
  migrated in last via a rehearsed ETL, with the current instance kept as a hot rollback
  until cutover is proven.

## 1.4 Phased roadmap

| Phase | Goal | Deliverables | Biz impact |
|---|---|---|---|
| 1. Audit & stabilization | Lock baseline | Tag prod baseline; daily Firestore export; inventory env/secrets | None |
| 2. Tenant model design | Decide shapes | `tenants`, `locations`, `users`, entitlements, plans; field-based `tenantId` | None |
| 3. Auth & permissions | Real identity | Firebase Auth; custom claims `{tenant_id, role, staff_id}`; role→capability matrix | None (new project) |
| 4. DB tenant isolation | Security core | Tenant-scoped rules replacing `if true`; rules unit tests (A≠B); CI-gate deploys | None |
| 5. Subscription & billing | Money plumbing | Stripe products/webhook → tenant plan/entitlements; dunning | None |
| 6. SaaS admin dashboard | Operate platform | Super-admin: tenant list, MRR, usage, audited impersonation | None |
| 7. Customer onboarding | Self-serve signup | Marketing/signup → tenant → owner → first location | None |
| 8. Beta rollout | **Prove isolation** | 2–3 pilot tenants on real data; zero cross-tenant access | None |
| 9. Production launch | Go live + migrate tenant zero | Public launch; rehearsed ETL moves DD Mau in as `tenant: ddmau`; old project = hot rollback | **Planned, reversible cutover** |
| 10. Long-term scaling | Durability | Usage metering, index/cost tuning, data-residency, SOC2 path | None |

## 1.5 Core data models

```
tenants/{tenantId}: { name, slug, status, plan, isInternal, ownerUserId,
  stripeCustomerId, stripeSubscriptionId,
  entitlements:{scheduling,timeClock,payroll,inventory,receiptAI,maxLocations,maxStaff,advancedReports},
  flags:{<key>:bool}, settings:{timezone,locale,branding} }

tenants/{tenantId}/locations/{locationId}: { name, address, timezone, active, pos:{provider,restaurantGuid,credsRef} }

plans/{planId}: { name, stripePriceId, limits:{maxLocations,maxStaff}, features:[...] }

// feature-flag resolution: effective(flag) = entitlement(plan) && (tenant.flags[flag] ?? config/featureFlags[flag])
```
**Billing:** Stripe Customer + Subscription per tenant; webhook → set status/plan/entitlements;
`past_due` → grace → suspend; `isInternal` tenants skipped. **Super-admin:** `isSuperAdmin`
claim; cross-tenant reads audited; never the default path. **Internal business:**
`tenants/ddmau {isInternal:true, plan:'enterprise', entitlements:ALL}` + 2 locations.

## 1.6 Strategies / checklists (Part 1)

- **Migration:** build SaaS in a new project; at Phase 9 run a rehearsed ETL (export → add
  `tenantId:'ddmau'`, map `location`→`locationId` → import to `saas-prod`); validate parity +
  isolation before flipping the business's project config.
- **Backup:** daily managed Firestore export to GCS (both projects); full export immediately
  pre-cutover; Storage object versioning; retention ≥30d.
- **Rollback:** old project stays live until cutover proven; business build selects project by
  config flag → flip back in minutes; keep both N weeks; documented runbook.
- **Testing:** rules unit tests (A≠B), claim-issuance, Stripe webhook state-machine,
  onboarding e2e, ETL parity, existing vitest suite, load test cross-tenant queries.
- **Security:** zero `if true`; claim-based isolation; deny-by-default fallthrough; App Check;
  secrets in Secret Manager (not bundle); super-admin audited; rate limits; PII locked; pen-test
  the rules.
- **Deployment:** env-selected project; rules deploy blocked unless emulator tests pass; staged
  rollout; post-deploy health check; rollback flip rehearsed; business pinned to its project
  until Phase 9.

**Part-1 recommendation:** *Hybrid phased migration to one tenant-aware codebase, built in a
new Firebase project, with the business frozen during the build and migrated in last as a
protected tenant zero — because it's the only path that protects the running business
absolutely, lands on the correct long-term architecture (no rebuilding twice), and refuses to
skip the real problem: there is no auth or server-side isolation today, so that is what gets
built and proven before anything else.*

---

# PART 2 — Tenant Login & Security Architecture

## 2.1 The chosen model (Andrew's instinct, formalized)

| Intent | Formalized as | Refinement |
|---|---|---|
| "QR code to get to the right tenant" | QR = **tenant discovery + invite**, scanned once | QR is *not* the credential — it routes + carries a short-lived invite; the staffer still authenticates |
| "make a login with email/password" | **Real Firebase Auth account** per staffer (or magic link) | This is the security boundary, not the PIN |
| "keeps them logged in; if kicked out, login with email" | Persistent Firebase session (1h ID token auto-refresh) | Token in iOS Keychain / Android Keystore, never plaintext |
| "admin page matches staff login, enable/archive" | Admin **links** Auth account → staff record; self-signup **gated by admin approval** | A leaked QR can't create access |
| "shared iPads need login + 4-digit PIN" | **Shared-device mode**: iPad authenticated as a *device* bound to tenant+location; staff use PIN to pick identity | PIN is a within-tenant identity selector, never a cross-tenant gate |

This is the Toast/Square pattern: **the device or person is authenticated to a tenant first;
the PIN is only a fast in-store action layer on top.**

## 2.2 The two-mode architecture

```
                FIRST SCREEN — what is this device?
        │                                           │
 PERSONAL DEVICE (own phone)               SHARED DEVICE (store iPad)
 Email/password OR magic link              Manager registers device once
 → Firebase Auth user                       (scan QR / manager login)
 → claims {tenant_id, role, staff_id}       → device account signs in
 → stays logged in                          → claims {tenant_id, location_id, isDevice}
 App opens AS THAT PERSON (no PIN)          → Staff mode → tap name → 4-digit PIN
                                               (verified server-side) → action
```

**Five security layers (ascending trust):** 1) tenant context on every session · 2) user
identity (email/pw or magic link) on personal devices · 3) device identity (registered,
tenant+location-scoped) on shared iPads · 4) PIN = hashed, tenant+staff-scoped quick selector
on an *already-authenticated* device · 5) super-admin = separate, MFA-required, audited.

**Principle:** the PIN is demoted from "the lock on the front door" to "the name tag you tap
on a door already unlocked by a real account." That single change makes multi-tenant safe.

## 2.3 First-screen flow

App's first decision = "what is this device?" from secure local storage:
- **Registered shared device** → **Option B**: opens to the assigned location's *staff mode*;
  staff tap name + PIN; "Manager mode" requires a full login.
- **Personal device, session present** → opens *as that user* (tenant + role from claim). No PIN.
- **Fresh/unknown device** → 3 choices:
  - **Sign in** → **Option C**: email/password or magic link; **MFA required for admin/owner**.
  - **Join my workplace** → scan QR / business code → invite → create account → admin matches it.
  - **Set up a shared device** (manager-gated) → **Option A**.

**Option A — new shared-device setup:** `scan store QR (or business code) → manager logs in →
pick location → name device → register → device account signs in → staff mode (locked to
tenant+location).`

## 2.4 Login-option comparison

| # | Option | Real boundary? | Best for | Verdict |
|---|---|:--:|---|---|
| 1 | Tenant code + PIN | ❌ | nothing as the only layer | **Reject as the boundary** |
| 2 | Email/password + PIN | ✅ | personal devices, managers/owners | **Core of recommendation** |
| 3 | Magic link + PIN | ✅ | forgotten passwords; new-device sign-in | **Offer alongside #2** |
| 4 | QR store setup + PIN | ✅ | shared iPads | **Use for device setup** |
| 5 | Device registration + PIN | ✅ | shared iPads | **The mechanism** |
| 6 | Manager login → PIN mode | ✅ | handing a device to the floor | **How #4/#5 bootstrap** |
| 7 | Separate personal login vs shared device mode | ✅✅ | the whole architecture | **The winning frame** |

## 2.5 Security/auth schema (Firestore)

```
tenant_users/{uid}          // one per Firebase Auth account
  tenantId, role: owner|admin|manager|shift_lead|employee
  staffId(→staff), email, status: active|invited|archived, mfaEnrolled, lastLoginAt
  // real claims live on the Auth token: {tenant_id, role, staff_id}

staff/{staffId}             // your existing "staff page" records
  tenantId, name, role, locationIds:[], status: active|archived
  linkedUserId(→tenant_users.uid), pinHash, pinSalt, pinUpdatedAt
  pinFailCount, pinLockedUntil

devices/{deviceId}          // a registered shared iPad
  tenantId, locationId, name, deviceAccountUid, status: active|revoked,
  registeredByUid, registeredAt, lastSeenAt, appVersion

device_sessions/{sessionId}: { deviceId, tenantId, locationId, startedAt, lastActiveAt, revoked, revokedReason }

roles/{roleKey}: { capabilities:[...] }

audit_logs/{id} (append-only): { tenantId, actorUid|deviceId|staffId, action, targetType, targetId,
  result: success|fail, reason, ipHash, userAgent, at }

login_attempts/{id} (append-only): { tenantId?, email|deviceId, result, reason, ipHash, at }

integration_secrets/{tenantId}/{provider}   // SERVER-ONLY, clients can NEVER read
  { encryptedPayload, kmsKeyId, updatedByUid, updatedAt }   // or a Secret Manager reference
```

## 2.6 API (Cloud Function) plan

| Function | Auth | Does |
|---|---|---|
| `acceptInvite({inviteToken,email,password})` | token-gated | create Auth user, link to admin-approved `staff`, set claims |
| `setUserClaims({uid,role})` | admin (same tenant) | set `{tenant_id,role,staff_id}` on token |
| `registerDevice({tenantId,locationId,name})` | manager/admin | create device account + claims, return sign-in custom token |
| `verifyStaffPin({staffId,pin})` | device or user (same tenant) | bcrypt-compare `staff.pinHash` for *this tenant*, rate-limit, log, return short-lived acting-as marker |
| `setStaffPin({staffId,newPin})` | admin or self | hash + store; never plaintext |
| `enableArchiveStaff({staffId,status})` | admin | enable/archive account |
| `revokeDevice({deviceId})` | admin | kill device session |
| `getTenantSecret(...)` | **server-internal only** | CFs read integration secrets; never callable from frontend |

Everything else goes through Firestore directly, gated by rules — no per-endpoint code.

## 2.7 The flows

- **Login/session:** open → check secure storage (device registration | user session) → route
  → Firebase issues a 1h ID token with `{tenant_id,role,staff_id}` → auto-refresh → rules enforce
  tenant match. Kicked out → re-auth with email/password or magic link.
- **Device registration:** manager authenticates → pick location → `registerDevice` creates a
  device account scoped to `{tenant_id,location_id}` → iPad signs in, stores credential in
  Keychain/Keystore → staff mode. `revokeDevice` kills lost/stolen iPads.
- **Staff PIN (shared iPad):** tap name → enter PIN → `verifyStaffPin` server-side: bcrypt vs
  *this tenant's* hash, lockout after N fails, **logs every attempt** → returns a short-lived
  acting-as token for that one action. Same PIN in another tenant = different hash under a
  different `tenant_id` → no collision. PIN never authorizes cross-tenant or admin data.
- **Manager/admin:** email/password (or magic link) + **MFA** → `{tenant_id,role:admin}` →
  dashboard scoped to their tenant only. On a shared iPad, "Manager mode" requires this full
  login, then auto-relocks.
- **Super admin:** separate sign-in + mandatory MFA + `isSuperAdmin` claim (set out-of-band) →
  list/suspend tenants, **read-only audited impersonation**. Every cross-tenant read writes an
  `audit_logs` entry. A normal admin token can never reach another tenant.

## 2.8 Tenant isolation rules (the enforcement)

Replace `match /{document=**} { allow read: if true }` with claim-scoped rules on every
collection:
```
match /shifts/{id} {
  allow read, write: if request.auth != null
    && request.auth.token.tenant_id == resource.data.tenantId;
  allow create: if request.auth != null
    && request.auth.token.tenant_id == request.resource.data.tenantId;
}
match /integration_secrets/{tid}/{d=**} { allow read, write: if false; }   // CF/admin SDK only
match /audit_logs/{id} { allow read: if isAdminOfTenant(); allow create: if signedInSameTenant(); allow update, delete: if false; }
```
Device accounts get *narrower* rules (their `location_id` must match; can write clock-ins,
**cannot** read payroll/PII). **Rules unit tests prove Tenant A's token can't read Tenant B**,
and CI blocks any failing rules deploy. **Highest-value security task in the whole effort.**

## 2.9 Encryption plan

- **PINs:** `bcrypt`/`scrypt`/`argon2id` + per-PIN salt, server-side only. *(Fixes today's
  known issue of plaintext PINs in `pin_audits` — purge it + re-hash the flow.)*
- **Secrets at rest:** Firestore is encrypted at rest by default; tenant integration creds
  (Toast passwords, API keys) go in **Secret Manager** (or app-encrypted via KMS), **never
  returned to any frontend** — only CFs read them via admin SDK.
- **Device credentials:** iOS **Keychain** / Android **Keystore** (Capacitor secure storage) —
  never localStorage.
- **Transport:** HTTPS only + **App Check** on Firestore + Functions.

## 2.10 Audit logging plan

Append-only `audit_logs`, `tenant_id`-stamped: **login success/fail, PIN attempt (pass/fail +
staff), device setup/revoke, role/permission change, account enable/archive, secret update,
super-admin cross-tenant access.** Fields: actor, action, target, result, reason, ip-hash, UA,
ts. Rules: create-only. Retention ≥1–2 yrs + nightly prune. Owner/admin viewer per tenant;
super-admin viewer global. (Extends the existing `/audit` foundation to auth events.)

## 2.11 Permission model

| Role | Scope | Can |
|---|---|---|
| super_admin | platform | manage tenants, audited impersonation — *separate identity + MFA* |
| owner | one tenant | everything incl. billing, tenant settings |
| admin | one tenant | staff, schedule, payroll, inventory, devices |
| manager | tenant (± location) | schedule, inventory, reports |
| shift_lead | location | limited schedule edits, approve clock-ins |
| employee | self | own schedule, PTO, chat |
| device | tenant + location | render staff mode, accept PIN actions; **no** payroll/PII |

Enforced in **both** rules and CFs — never frontend-only. Admin roles are always
tenant-scoped; no app-wide admin except `super_admin`.

## 2.12 Security testing checklist

▢ Tenant A token can't read/write/delete Tenant B (CI-gated) ▢ device account can't read
payroll/PII ▢ PIN verify is server-side, rate-limited, lockout works ▢ same PIN in two tenants
→ no collision ▢ secrets unreachable from any client token ▢ super-admin cross-tenant access
audited ▢ revoked device session truly dies ▢ archived staff can't authenticate ▢ MFA enforced
for admin/owner ▢ App Check rejects non-app callers ▢ token-claim tampering rejected ▢ invite
token single-use + expiring ▢ pen-test the rules.

## 2.13 Migration plan — the business never breaks

Rule: **the PIN keypad keeps working at every step; the business is hardened in place and
migrated last.**

- **Phase 0 — today:** PIN keypad, no auth, open rules. *(No change.)*
- **Phase 1 — tag data:** add `tenantId` everywhere; backfill the business as `tenant:ddmau`.
  Rules still permissive. Invisible to staff.
- **Phase 2 — hash the PINs:** one-time job hashes existing PINs into `staff.pinHash`; the
  keypad now verifies via `verifyStaffPin` (server-side, hashed). Same staff experience. Purge
  plaintext `pin_audits`.
- **Phase 3 — real auth, in parallel:** Firebase Auth + claims + login flows in a sandbox/new
  project. Live app untouched.
- **Phase 4 — opt-in new modes:** email/password personal login + shared-iPad device
  registration as *additional* options. Keypad still works during the trial.
- **Phase 5 — lock the rules:** flip Firestore to tenant-scoped rules, gated by passing
  isolation tests. The rehearsed lockdown moment, after auth is proven on pilots.
- **Phase 6 — cut over:** business runs fully on the new model as `tenant:ddmau`; retire open
  rules. Keypad still there for shared iPads — now backed by a registered device + hashed PIN.

Staff never lose clock-in. The PIN survives the whole way — upgraded from "the only lock" to
"a hashed, tenant-scoped tap on an already-locked door."

---

## Final recommendation

**Use secure tenant/device registration first, then keep 4-digit PINs only for staff actions
inside that tenant/location** — because a 4-digit PIN can never be the wall between two
businesses' data (low-entropy, shared, reused). The moment there is more than one tenant, the
PIN must sit *behind* a real authenticated boundary — a person's email/password (or magic-link)
account on their own phone, or a manager-registered device account on a shared iPad — with
tenant isolation enforced in Firestore rules on **every** request, not in the UI. That keeps
staff's fast PIN clock-in exactly as it is today while making it cryptographically impossible
for one restaurant to ever see another's schedules, payroll, or sales.

---

### Sequencing note
Part 2 (auth + isolation) is Phases 3–5 of Part 1's roadmap, and it is the **first real build
work** when you start: real authentication + tenant-scoped rules proven by A≠B tests, in a new
Firebase project, with the live business untouched until a rehearsed cutover.

---

# PART 3 — Current-app technical audit (grounded in the real code, 2026-06-25)

| Layer | How it works today | Single-tenant assumption to fix |
|---|---|---|
| **Backend** | Firebase **Cloud Functions** (us-central1) + **Firestore**; **no app server**. Plus a **Railway** Python scraper that pulls Toast/Sysco/US Foods and writes Firestore via a service account. | Functions + scraper assume ONE business's creds (global secrets/env). |
| **Frontend** | React 18 + Vite SPA, **Capacitor** iOS/Android (`appId com.ddmau.staff`), Capgo OTA. ~60 feature modules in `src/data/*`. | UI gates by name/id, not by a tenant-scoped session. |
| **DB schema** | Flat Firestore collections, **no `tenantId`**. `location` field = `webster`/`maryland`. `config/staff` holds the staff list. | Every collection needs `tenantId`. |
| **User / staff** | **No user table, no Auth.** Staff live in the staff list; **`staffName` is the cross-app join key**. | Need real `tenant_users` (Auth uid) + `staff.linkedUserId`. |
| **Roles / permissions** | Client-side `isAdmin(name, staffList)` **and** owner hardcoded as **`s.id === 40 || s.id === 41` in 7+ places in `functions/index.js`** (lines ~1790, 2443, 2688, 2884, 3698, 4720, 4818). Per-feature flags (`canViewOnboarding`, etc.) on the staff record. | **The `40/41` hardcode is the #1 landmine** — becomes a `role:owner` claim, tenant-scoped. |
| **Store/location** | Hardcoded `LOCATIONS` (webster/maryland); Toast GUIDs per location come from **env vars**. | Locations become rows under a tenant; GUIDs move to the tenant's encrypted vault. |
| **Scheduling / time clock / availability** | `shifts`, `time_off`, `date_blocks`, `attendance`; `ops/clocked_in_*` written by the Toast scraper. | Add `tenantId` (+ `locationId`) to all. |
| **Notifications** | `dispatchNotification` CF → FCM (web/Android) + APNs (iOS, node-apn); `fcmTokens` on staff. | Tokens + topics scope per tenant. |
| **Integrations / API keys (today, ALL global)** | **Cloud Functions secrets** (`defineSecret`): `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER`, `ANTHROPIC_API_KEY`, `GMAIL_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`, `APNS_AUTH_KEY/KEY_ID/TEAM_ID`, `SENTRY_DSN`, `GH_DISPATCH_TOKEN`. **Railway env**: `TOAST_CLIENT_ID/SECRET/API_HOST/EMAIL/PASSWORD`, `TOAST_RESTAURANT_GUID_WEBSTER/MARYLAND`, `SYSCO_STORAGE_STATE` (+user/pass), `USFOODS_*`, `FIREBASE_SA_JSON`. | **This is the core of Part 4** — per-tenant creds can't be global env vars. They move to an encrypted, tenant-scoped vault. |
| **Env vars / Railway** | One scraper service, one tenant's env. | Scraper becomes a multi-tenant orchestrator reading each tenant's vault. |
| **Auth / login flow** | **None.** 4-digit PIN keypad checked client-side vs the staff list. | The PIN gets demoted (Part 2). |
| **4-digit PIN** | Client-checked; **`pin_audits` stores plaintext PINs** (QA-flagged). | Hash + server-verify + tenant-scope. |
| **Admin / manager / employee access** | All client-gated; owner = hardcoded ids. | Role claims, tenant-scoped, server-enforced. |
| **Hardcoded business-specific logic** | Owner ids `40/41`; `LOCATIONS` webster/maryland; `"DD Mau"` strings + `com.ddmau.staff`; apply phone `(314) 689-4025`; menu/recipe/allergen seed data; per-location Toast GUIDs. | All of this becomes **tenant config**, not constants. |

**Audit verdict:** the product layer is reusable; the blockers are (1) no auth, (2) catch-all
rules, (3) no `tenantId`, (4) **owner hardcoded as ids 40/41**, and (5) **global, single-set
integration credentials**. Items 4 and 5 are what make "just add another restaurant" impossible
today and are the heart of the integrations work below.

---

# PART 4 — Tenant Integrations page + credential auto-wiring ⭐ (the new centerpiece)

**Your ask:** a page in the admin where a new tenant enters all their keys/GUIDs/API
keys/passwords, and the app "automatically gets those into the right place" so their app just
works like yours.

**The right pattern (a gentle correction to "webhooks that auto-enter keys"):** you don't copy
keys into env vars or fire a webhook to "place" them. Instead, every key is entered **once** into
an encrypted, tenant-scoped **credential vault**, and **every part of the system reads from the
vault by `tenant_id` at runtime** — the scraper, the SMS sender, the receipt AI. That *is* the
automatic wiring: enter once → everything that needs it pulls it, with no per-tenant redeploys
and no secrets ever touching the frontend. ("Webhooks" still matter, but for **inbound** events —
Twilio SMS and Stripe billing — see the webhook router below.)

### 4.1 The four pieces

**(a) Integration Registry** — a declarative catalog (one entry per provider) so the page renders
itself and adding a provider = adding one entry:
```
integrations_registry (config, code-side):
  toast:    { fields:[clientId,clientSecret,apiHost,locations:[{name,restaurantGuid}]],
              validator: testToast(), consumedBy:[scraper, attendance], scope: per-location }
  sysco:    { fields:[storageStateJson | username+password],            validator: testSysco(),    consumedBy:[scraper] }
  usfoods:  { fields:[username, gmail, gmailAppPassword],               validator: testUsFoods(),  consumedBy:[scraper] }
  twilio:   { fields:[accountSid, authToken, fromNumber],               validator: testTwilio(),   consumedBy:[sms, applyToText], inbound:webhook }
  anthropic:{ fields:[apiKey] (OR platform-provided, billed to you),    validator: testAnthropic(),consumedBy:[receiptAI, aiSearch] }
  gmail:    { fields:[oauthClientId, oauthClientSecret, refreshToken],  validator: testGmail(),    consumedBy:[pollGmail] }
```

**(b) Encrypted per-tenant vault** — `integration_secrets/{tenantId}/{provider}` (Firestore,
**server-only**: rules `allow read,write: if false`; only Cloud Functions via the admin SDK touch
it), OR Google **Secret Manager** (one secret per `tenant/provider`). Values are **envelope-
encrypted with a KMS key** before storing. The frontend **never** receives a secret back — the
page shows only **status** (`Connected ✓ · last verified 2h ago` / `Not connected`).

**(c) Validate-on-save** — when a tenant submits Toast creds, a Cloud Function does a **real test
call** (e.g. fetch their restaurant list) before saving: `✓ Connected — found 2 locations`. This
is what makes it feel automatic: enter → verify → green check → data flows. No silent
misconfiguration.

**(d) Tenant-aware consumers** — the Railway scraper becomes a **multi-tenant orchestrator**: it
lists active tenants, reads each tenant's vault creds (via a CF or a deploy service account), and
runs that tenant's integrations on their own schedule, **isolated** (one tenant's Toast failure
never affects another). Cloud Functions that send SMS / run receipt AI read the **calling
tenant's** vault entry, not a global secret.

### 4.2 Inbound webhook router (where "webhooks" genuinely apply)

A **single** public endpoint per inbound provider that **resolves the tenant from the payload**:
- **Twilio inbound SMS** (apply-to-text): the `To` number → look up which tenant owns that number
  → route. Each tenant brings their own Twilio number (or you provision one per tenant).
- **Stripe billing**: webhook `customer`/`subscription` → `tenants.stripeCustomerId` → set that
  tenant's plan/status. (Part 1 §1.5.)

### 4.3 The Integrations admin page (UX)

A tab in the tenant admin: one **card per provider** → `Not connected` → **Connect** → a form
(fields from the registry) → **Verify & Save** → `✓ Connected · last checked` + a **Re-test** and
**Disconnect**. Owner/admin role only; every change writes an audit entry (`integration_changed`,
secret value redacted). Cookie-cutter: a new restaurant fills these in once and their scraper,
SMS, and receipt-AI light up — "works like mine."

### 4.4 Security rules for the vault (non-negotiable)
- Secrets entered over HTTPS → **callable CF only** (never written from the client directly).
- **Envelope-encrypted (KMS)** at rest; or Secret Manager (which encrypts + access-controls).
- **Never returned to any frontend** — status-only reads.
- Rules: `match /integration_secrets/{t}/{p=**} { allow read, write: if false; }`.
- Per-secret audit; rotation supported (re-enter → re-validate → new version, old revoked).
- App Check on the callable so only your real apps can submit creds.

---

# PART 5 — Detailed 10-phase execution plan

> The 5 architecture options map to Part 1's comparison: **#1 = B (in-place), #2 = C (copy),
> #3 = separate-DB-per-tenant (strongest isolation, heaviest ops — viable as the *transitional*
> business-vs-SaaS split), #4 = B's end-state (one backend, tenant isolation), #5 = D (hybrid).**
> **Recommendation stands: #5 (hybrid) reaching #4 — one tenant-aware codebase, business migrated
> last as tenant zero.** Each phase below: Goal · Files · DB · API · Frontend · Security risk ·
> Testing · Rollback.

**Phase 1 — Audit & freeze baseline.**
Goal: lock current state, enable backups. Files: none (docs). DB: turn on daily Firestore export.
API: none. FE: none. Security risk: none. Testing: confirm export lands in GCS; tag prod baseline.
Rollback: n/a (read-only).

**Phase 2 — Add `tenantId` safely (data-tagging, behavior unchanged).**
Goal: every collection carries `tenantId`; backfill business = `ddmau`. Files: `src/firebase.js`,
a new `src/data/tenantContext.js` (data-access layer that injects `tenantId`), all `src/data/*`
writers (gradually). DB: add `tenantId` field everywhere; backfill script. API: writers default
`tenantId='ddmau'`. FE: none visible. Security risk: a missed writer = an untagged doc → fix:
default-on-write + an audit sweep for null `tenantId`. Testing: assert every new doc has
`tenantId`; backfill count matches. Rollback: field is additive — ignore it; nothing breaks.

**Phase 3 — Tenant-aware auth & permissions (in a NEW Firebase project).**
Goal: real Firebase Auth + claims `{tenant_id, role, staff_id}`; **kill the `40/41` hardcode** →
`role:owner`. Files: new `src/auth/*`, `functions/auth.js` (`setUserClaims`, `acceptInvite`),
refactor the 7 `id===40||41` sites → `hasRole('owner')`. DB: `tenant_users`, `roles`. API:
claims-issuing CFs. FE: login screens (email/pw + magic link), MFA for admin/owner. Security risk:
claim spoofing → claims set **only** server-side; never trust client role. Testing: claim-issuance
tests; owner-gate tests now pass via role not id. Rollback: new project — live app untouched.

**Phase 4 — Device registration + staff invite login.**
Goal: shared-iPad device accounts + personal-phone invite/verify; PIN demoted. Files:
`src/auth/deviceMode.jsx`, `functions/devices.js` (`registerDevice`, `revokeDevice`,
`verifyStaffPin`), `src/data/devicePairing.js` (exists — evolve it). DB: `devices`,
`device_sessions`; `staff.pinHash/pinSalt`. API: device register/verify, PIN verify (server,
hashed, rate-limited, logged). FE: first-screen router (Part 2 §2.3), staff-mode keypad backed by
`verifyStaffPin`. Security risk: lost iPad → `revokeDevice` kills the session; PIN brute-force →
lockout + audit. Testing: A-tenant PIN can't act in B; revoked device truly dies; lockout works.
Rollback: opt-in — old keypad path remains until cutover.

**Phase 5 — Encrypted tenant integrations (Part 4).**
Goal: the Integrations page + vault + validators + multi-tenant scraper. Files: new
`src/components/admin/IntegrationsTab.jsx`, `src/data/integrations.js`,
`functions/integrations.js` (save/validate/rotate), `functions/webhookRouter.js`, **scraper.py
refactor** → multi-tenant loop. DB: `integration_secrets/{tenant}/{provider}` (server-only) or
Secret Manager. API: `saveIntegration`, `testIntegration`, inbound webhook router. FE: provider
cards + verify UX. Security risk: secret leakage → server-only vault, KMS, status-only reads, App
Check; **never** return values. Testing: tenant A can't read B's secrets; validators catch bad
creds; scraper isolates per-tenant failures. Rollback: your business keeps using its existing
Railway env vars until its vault entry is verified, then flip.

**Phase 6 — Subscription / billing tables.**
Goal: Stripe per tenant. Files: `functions/stripeWebhook.js`, `src/data/billing.js`,
`src/components/admin/BillingTab.jsx`. DB: `plans`, `tenants.subscription/status/entitlements`,
`billing_events`. API: checkout session, `stripeWebhook` → set plan/entitlements; dunning. FE:
plan picker + billing status. Security risk: webhook spoofing → verify Stripe signature; entitle-
ments are server-set. Testing: webhook state-machine (trial→active→past_due→suspended); `isInternal`
tenants skipped. Rollback: test mode; no real charges until flipped live.

**Phase 7 — SaaS super-admin dashboard.**
Goal: operate the platform. Files: `src/components/superadmin/*`, `functions/superAdmin.js`. DB:
`super_admins` (claim `isSuperAdmin`). API: list/suspend/comp tenants; **audited read-only
impersonation**. FE: tenant list, MRR, usage. Security risk: cross-tenant power → MFA-required,
every access audited, separate sign-in surface. Testing: a normal admin token can NEVER reach
another tenant; impersonation is logged. Rollback: feature-flagged off.

**Phase 8 — Migrate the business into a protected internal tenant.**
Goal: DD Mau becomes `tenant:ddmau` (`isInternal`, comped). Files: a one-time ETL script
(local/gitignored). DB: export → transform (`tenantId='ddmau'`, `location`→`locationId`,
hash PINs) → import to `saas-prod`. API: none new. FE: business app build re-points to the SaaS
project (config flag). Security risk: data mixup → full export first; parity + isolation
validated before flip. Testing: row counts + spot-checks match; A≠B isolation holds with real
data. Rollback: **old project stays live as a hot rollback** for N weeks; flip the config back in
minutes.

**Phase 9 — Beta tenant.**
Goal: prove isolation on a real second restaurant. Files: onboarding wizard
(`src/components/onboarding/TenantSetup.jsx`). DB: a real second `tenants/{id}` + locations +
staff + their vault. API: self-serve signup → tenant → owner → location → invite staff. FE:
business setup wizard, location setup, staff invite flow. Security risk: cross-tenant bleed →
the §2.12 checklist must pass before any real customer data. Testing: beta tenant cannot see
DD Mau; DD Mau cannot see beta; their integrations run isolated. Rollback: suspend/delete the
beta tenant cleanly; no impact on others.

**Phase 10 — Launch SaaS.**
Goal: public availability + scale. Files: marketing/signup surface, store-listing rename to the
product name (per the app-name notes; per-tenant branding stays *inside* the app). DB: usage
metering. API: rate limits, App Check enforced. FE: pricing/signup. Security risk: scale-driven
rule gaps → load test cross-tenant queries; index/cost tuning. Testing: full §2.12 security pass +
pen-test the rules; load test. Rollback: feature-flag new signups off; existing tenants unaffected.

---

## Bottom line for this part
Two findings make the integrations work the real heart of the SaaS effort: **owner is hardcoded
as ids 40/41 across the Cloud Functions**, and **every integration credential is a single global
env var/secret.** Both must become **tenant-scoped** — owner→a role claim, and every key→an
**encrypted per-tenant vault that the scraper, SMS, and AI read at runtime.** Get the vault +
validate-on-save right (Phase 5) and onboarding a new restaurant becomes: *sign up → enter your
keys on the Integrations page → green checks → your app works exactly like DD Mau's* — with
isolation enforced in Firestore rules on every request, and your live business untouched until
its rehearsed cutover in Phase 8.

---

# PART 6 — End-to-end security lifecycle (first download → daily use → offboarding)

The whole journey, with the **control**, the **risk**, and the **open decision** at each stage.

**Stage 0 — App identity.** Rename the store app **DD Mau → "Staff App"** (a generic product
name; native change → **store rebuild, can't OTA** — see the app-name notes). Per-tenant branding
(restaurant name/logo) shows **inside** the app from tenant config, never in the binary. *Control:*
no tenant data is ever baked into the app — one generic app serves all tenants.

**Stage 1 — New owner: first download → "Create a workplace."** Owner enters email + **strong
password** (real Firebase Auth account) + **legal company info** (legal entity name, business
ID/EIN, address, owner contact) + accepts ToS/Privacy → **email verification required** before the
tenant activates. The app offers the **full current feature set** to every new tenant (plan-gating
comes later). *Control:* owner becomes `role:owner` with a fresh `tenant_id`; email verified;
password policy; signups rate-limited. Legal info lives under the tenant doc, readable only by that
tenant's owner/admin. *Risk:* fake/free-trial abuse → email verify + rate limit (± card-to-start).
*Open:* how much legal info up front; trial length.

**Stage 2 — Card on file (subscription).** A "Start subscription" button → **Stripe-hosted**
Checkout/Payment Element → Stripe returns a customer + subscription; you store only
`stripeCustomerId`/`subscriptionId`. ⚠️ **Critical control: the card number never touches your
servers or the app — it goes straight to Stripe.** This keeps you in the lightest PCI scope
(SAQ-A); store **zero** card data. (Same reason the assistant never handles card entry — the
tenant types it into Stripe's own UI.) `tenants.status` (trial/active/past_due/suspended) gates
access, webhook-driven. *Open:* free trial vs card-required-to-start; tiers.

**Stage 3 — "Send the app login link" / continue in.** The owner is already authenticated from
Stage 1, so they just continue. Any emailed link must be a **single-use, expiring magic link tied
to the verified email** — never a permanent secret in a URL.

**Stage 4 — Setup via the Integrations page (Part 4 vault).** Owner/admin enters Toast/Sysco/etc.
keys → encrypted vault → the system **pulls staff names, pay, positions, menus, onboarding,
schedule** into the tenant's scoped collections. *Control:* secrets encrypted at rest, server-only,
validate-on-save, every change audited. **Imported pay + onboarding data is sensitive PII** → lands
tenant-scoped + role-locked (owner/admin only; never a device account; never another tenant).
*Risk:* a bad/over-broad import → preview before committing.

**Stage 5 — Staff onboarding (QR + invite code → first-time staff login).** Each tenant gets a
**QR code + staff invite code**. The sign-in screen has a **"New / first-time staff"** link at the
bottom → staff **scan the QR or enter the code** → routed to *their* restaurant → create/verify
account (email+password; username optional) → **admin matches + enables** the staff record.
*Control options (pick the strength):* (a) **tenant QR for discovery + admin-approval gate** —
anyone with the code can *request*, but no access until an admin enables the matching staff record;
(b) **per-staff single-use, expiring invite links** texted/emailed by the manager (strongest);
(c) **phone or email verification** before any access. *Baseline:* (a)+(c); add (b) for tight
control. *Risk:* leaked QR → contained by the admin-approval gate + verification + rotatable code.
*Open:* **email (recommended — enables self-service password reset + magic-link recovery) vs
username** (username-only means a manager resets every forgotten password).

**Stage 6 — Staying signed in, logout, biometrics (personal phones).** Staff **stay signed in**
(long-lived refresh token in **Keychain/Keystore**, never plaintext); they re-auth only on logout.
*Session-end triggers:* (1) staff logs out; (2) **admin/manager revokes access** → **server-side
`revokeRefreshTokens(uid)` + archive** → session dies on next refresh (⚠️ **frontend logout alone
is NOT enough — revocation must be server-side**); (3) **security events:** password change, tenant
suspended (past_due), device reported lost, optional idle-timeout, refresh max-age. **Biometrics
(Face/Touch ID) = an app-lock that locally re-unlocks an *already-authenticated* session, NOT a
replacement for login:** the refresh token sits behind the secure enclave; opening the app (or
after idle) requires Face/Touch ID; N failures → fall back to full email/password. So "lock the app
for staff" = fast biometric re-entry without re-typing. *Risk:* treating biometric as auth — it
only unlocks a session the **server still controls and can revoke**. *Open:* idle-lock timeout;
biometric required vs optional per tenant.

**Stage 7 — Shared restaurant iPad ("staff device" profile).** Admin **creates a "staff iPad"
device** — a distinct **device profile, not a person's staff profile**. It registers as a
tenant+location-scoped **device account**, shows a **different UI** (the staff roster + **4-digit
PIN pad**, current behavior), and has **narrower permissions** (clock-in / 86 / quick actions; **no
payroll/PII**). *Control:* device credential in the iPad's Keychain; **admin can revoke the device**
(lost/stolen); the staff **PIN is hashed + tenant-scoped + server-verified + rate-limited + every
attempt logged**, identifying *who* is acting on an already-authenticated device — never a tenant
boundary. (This is the formal version of "designate a 'staff' iPad that looks different than a
regular staff profile" — it's a **device**, not a person.)

**Stage 8 — Offboarding / end-of-life.** Archive staff → revoke tokens + disable PIN + drop from
rosters (history retained for audit, not deleted). Revoke a device → kill its session. Suspend a
tenant (non-payment) → block access, retain for a grace window, then export/delete per policy.
Delete a tenant → full export + scheduled deletion (GDPR/CCPA right-to-deletion).

## Data classification (what gets the strictest locks)

| Class | Examples | Rule |
|---|---|---|
| **Card data** | payment card | **never stored** — Stripe-hosted only |
| **Integration secrets** | Toast/Sysco/Twilio keys | encrypted vault, server-only, never to frontend |
| **Payroll / pay rates** | wages, hours, tips | owner/admin only; never device accounts; never cross-tenant |
| **Onboarding PII** | SSN, I-9, IDs | owner/admin only; encrypted; tightest retention |
| **Staff PII** | name, phone, email | tenant-scoped; managers within tenant |
| **PINs** | 4-digit | hashed + salted; server-verified only |
| **Operational** | schedules, 86, inventory | tenant + (often) location scoped |

## What keeps tenants separate (isolation recap)
`tenant_id` on every record · **claim-based Firestore rules** replacing the catch-all · **device
accounts further limited to their location + no PII** · secrets server-only · **App Check** (only
your apps call the backend) · **server-side session revocation** · **append-only audit logs**
(logins, failed logins, PIN attempts, device setup, permission/role changes, integration changes,
schedule + availability changes) · **super-admin separate + MFA + audited**. **Frontend filtering
is never the boundary — the rules are.**

## Open decisions to settle before building
1. Trial length / card-required-to-start.  2. Invite strength: tenant-QR + admin-approval (baseline)
vs per-staff single-use links.  3. Primary credential: **email (recommended)** vs username.
4. MFA: required for owner/admin? optional for managers?  5. Idle-lock timeout + biometric
required vs optional.  6. Data-retention windows on suspend/delete.

**Closing note:** the security model has three tiers — **(1) the tenant boundary** (real auth +
claims + Firestore rules, enforced server-side on every request), **(2) the person** (email/password
on personal phones, biometric only as a fast local re-unlock, sessions the server can revoke), and
**(3) the shared device** (a registered, location-scoped iPad "staff device" where the hashed PIN
just picks who's acting). Card data stays with Stripe, integration keys stay in the encrypted vault,
pay/PII stay owner/admin-only — and none of it is ever the *only* line of defense, because the
Firestore rules enforce the tenant wall underneath all of it.
