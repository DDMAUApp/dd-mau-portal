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
