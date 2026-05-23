# Multi-tenant restructure plan

**Status:** design doc, not started
**Estimated effort:** 2–3 weeks
**Last updated:** 2026-05-23

The DD Mau app is currently single-tenant — every Firestore collection
lives at the root and assumes one restaurant. To sell this software
to other restaurants, every read and write has to be scoped to an
organization (a single restaurant business, which may operate
multiple physical locations). This doc lays out the work in the
order it has to happen.

## 1. Why we need it

- Today: one Firebase project = one restaurant. Adding a second
  restaurant means standing up a second Firebase project +
  re-deploying the app pointed at it. Doesn't scale beyond ~2-3
  customers.
- After: one Firebase project = many restaurants. Each restaurant
  signs up, picks a name, becomes an `org`. All their data lives
  under `/orgs/{orgId}/...` and is invisible to every other org.

This is THE blocker for SaaS sales. Everything else in the audit
list is polish; this is the structural change.

## 2. Decisions to make first

### 2a. Org ID scheme
- Option A: human-readable slug (`ddmau-stl`, `pho-king-chicago`). Pros: nice URLs. Cons: collision/squatting.
- Option B: Firestore-auto-ID (`x9aJ3...`). Pros: collision-free. Cons: ugly in URLs.
- **Recommend:** Option A with a uniqueness check on signup. URL slug separate from internal ID if needed.

### 2b. Where does `orgId` come from at runtime?
- Option A: subdomain (`ddmau.app.example.com` → orgId='ddmau'). Pros: zero config per session. Cons: DNS/SSL per org.
- Option B: URL path (`/org/ddmau/...`). Pros: one DNS record. Cons: URL noise.
- Option C: stored on the user (Auth custom claim → orgId). Pros: implicit from sign-in. Cons: one-org-per-user.
- **Recommend:** Option C (Auth claim). Multi-org admins can flip via a "Switch org" picker.

### 2c. Existing DD Mau data
- Migration: write a one-shot script that takes every doc at root and copies it under `/orgs/ddmau/`. Run during a maintenance window.
- Cutover: client deploys the new code that reads from `/orgs/{orgId}/...` simultaneously.
- Rollback: previous Firebase backup snapshot + previous app deploy.

## 3. Data model changes

Every collection moves under `/orgs/{orgId}/...`. Today's paths
on the LEFT, new paths on the RIGHT:

```
/config/staff                       → /orgs/{orgId}/config/staff
/config/recipes                     → /orgs/{orgId}/config/recipes
/config/printers_webster            → /orgs/{orgId}/config/printers_webster
/config/training_overrides          → /orgs/{orgId}/config/training_overrides
/config/forceRefresh                → /orgs/{orgId}/config/forceRefresh

/ops/checklists2_{loc}              → /orgs/{orgId}/ops/checklists2_{loc}
/ops/inventory_{loc}                → /orgs/{orgId}/ops/inventory_{loc}
/ops/labor_{loc}                    → /orgs/{orgId}/ops/labor_{loc}
/ops/86_{loc}                       → /orgs/{orgId}/ops/86_{loc}

/shifts/{id}                        → /orgs/{orgId}/shifts/{id}
/date_blocks/{id}                   → /orgs/{orgId}/date_blocks/{id}
/time_off/{id}                      → /orgs/{orgId}/time_off/{id}
/notifications/{id}                 → /orgs/{orgId}/notifications/{id}
/recurring_shifts/{id}              → /orgs/{orgId}/recurring_shifts/{id}
/staffing_needs/{id}                → /orgs/{orgId}/staffing_needs/{id}
/schedule_templates/{id}            → /orgs/{orgId}/schedule_templates/{id}

/chats/{chatId}                     → /orgs/{orgId}/chats/{chatId}
  /messages/{msgId}                 →   /messages/{msgId}
/swap_requests/{id}                 → /orgs/{orgId}/swap_requests/{id}
/scheduled_messages/{id}            → /orgs/{orgId}/scheduled_messages/{id}
/staff_todos/{id}                   → /orgs/{orgId}/staff_todos/{id}

/onboarding_hires/{id}              → /orgs/{orgId}/onboarding_hires/{id}
/onboarding_invites/{token}         → /orgs/{orgId}/onboarding_invites/{token}
/onboarding_applications/{id}       → /orgs/{orgId}/onboarding_applications/{id}
/onboarding_templates/{id}          → /orgs/{orgId}/onboarding_templates/{id}

/tv_configs/{tvId}                  → /orgs/{orgId}/tv_configs/{tvId}
  /versions/{vId}                   →   /versions/{vId}
/tv_heartbeats/{tvId}               → /orgs/{orgId}/tv_heartbeats/{tvId}
/pairing_codes/{code}               → /orgs/{orgId}/pairing_codes/{code}
/print_jobs/{id}                    → /orgs/{orgId}/print_jobs/{id}

/audit/{id}                         → /orgs/{orgId}/audit/{id}
/pin_audits/{id}                    → /orgs/{orgId}/pin_audits/{id}
/recipe_audits/{id}                 → /orgs/{orgId}/recipe_audits/{id}
/onboarding_audits/{id}             → /orgs/{orgId}/onboarding_audits/{id}
/inventory_audits_{loc}/{id}        → /orgs/{orgId}/inventory_audits_{loc}/{id}
/backup_history/{id}                → /orgs/{orgId}/backup_history/{id}

/rate_limits/{id}                   → /orgs/{orgId}/rate_limits/{id}
```

NEW top-level collections (org-management layer):

```
/orgs/{orgId}                       — org metadata (name, slug, plan, createdAt)
/orgs/{orgId}/members/{uid}         — { role: 'owner'|'admin'|'staff', addedAt }
/users/{uid}                        — { email, displayName, orgs: [orgId,...] }
```

## 4. Firestore Storage paths

Same wrapping pattern:

```
/onboarding/{hireId}/...            → /orgs/{orgId}/onboarding/{hireId}/...
/onboarding_templates/...           → /orgs/{orgId}/onboarding_templates/...
/tv_images/...                      → /orgs/{orgId}/tv_images/...
```

Bucket stays one (`dd-mau-staff-app.firebasestorage.app`) — the
storage.rules wrapper enforces orgId.

## 5. Rules

Every existing rule moves under `match /orgs/{orgId}/...`. The
fundamental check becomes:

```
allow read, write: if isMemberOf(orgId);

function isMemberOf(orgId) {
  return request.auth != null
      && request.auth.token.orgIds is list
      && orgId in request.auth.token.orgIds;
}
```

Public routes (the apply form, the TV display) need a separate
unauthenticated path that's scoped by URL parameter:

- `/?apply=1&org=ddmau` → check `org` matches `/orgs/{org}/config`
  `acceptsApplications: true` flag, then allow create on
  `/orgs/{org}/onboarding_applications`.
- `/?tv=<tvId>` → resolve the tvId to its orgId via a public
  lookup doc, then allow read on that org's tv_config and
  ops/86 docs.

## 6. Client code changes

Roughly two patterns to replace everywhere:

### Old
```js
collection(db, 'shifts')
doc(db, 'config', 'staff')
```

### New
```js
collection(db, 'orgs', orgId, 'shifts')
doc(db, 'orgs', orgId, 'config', 'staff')
```

The `orgId` comes from a React Context populated from the user's
Auth custom claim. Every component that touches Firestore needs
to read it from context (or have it passed in).

**Estimated touchpoints:** ~80 files. Bulk of the change.

Cleanest approach: add a `useOrgId()` hook that throws if there's
no org in context — this surfaces every site that forgot to
include it. Then a global sweep through every Firestore call.

## 7. Auth integration

Today: anonymous Firestore access. Migration path:

1. Add Firebase Auth (email-passwordless or Google).
2. Cloud Function on user creation: assign `customClaims.orgIds`
   based on the signup flow (new org → create org + add user as
   owner; invite link → add to existing org).
3. Update rules to require `request.auth != null` everywhere
   except the public routes.
4. Migrate the existing PIN flow to a "first-time-sign-in" flow
   where existing staff records get linked to Auth UIDs.

The Auth migration is its own multi-week project. Multi-tenant
forces it; we can't ship one without the other.

## 8. UI changes

- **Sign-up flow** — name, restaurant name, slug, payment (if monetizing).
- **Sign-in flow** — email-passwordless replaces the PIN lock screen for org admins. PIN stays for shift-level staff sign-in on shared kitchen devices.
- **Org picker** — top-of-app dropdown for multi-org users (consultants, regional managers). Default: the user's primary org.
- **Onboarding the first user** — auto-create the org, mark them as owner.
- **Invite flow** — owners invite admins/staff by email. Invite link puts the new user in the org with the chosen role.

## 9. Migration plan for DD Mau data

1. Maintenance window announcement to the team (e.g. "App locked Sunday 8am-9am for a major update").
2. Run a one-shot Node script using firebase-admin:
   - Read every doc at root.
   - Copy under `/orgs/ddmau/...`.
   - Preserve serverTimestamp fields by copying as-is (they stay
     valid Timestamp objects).
   - Skip already-copied paths (idempotent — safe to re-run).
3. Deploy the new client code that reads from `/orgs/ddmau/...`.
4. Smoke test all major flows.
5. Once stable for a week, delete the root-level copies.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Forgot a collection in the migration script → data lost on cutover | Dry-run logs every path that would move, hand-review before live |
| Forgot a `useOrgId()` call in client code → crash on first read | TypeScript + a custom ESLint rule that bans bare `db, 'shifts'` calls |
| Auth roll-out breaks the kitchen PIN flow | Keep PIN flow as the SECONDARY sign-in for shift devices; primary sign-in is email |
| Pi TV displays break on cutover (they use `/?tv=`) | TV pairing already supports the public-lookup pattern — extend it to resolve org from tvId |
| Existing FCM tokens stale after auth migration | One-time re-request after first sign-in under new auth |
| Cloud Functions assume root paths | Audit + update every CF (dispatchNotification, dispatchSms, scheduledFirestoreBackup, checkTvHeartbeats, sendShiftReminders) |

## 11. Sequencing

This is the order to land work. Each step is verifiable on its own.

1. **Add Firebase Auth alongside the existing PIN flow** — admins sign in with email, staff keep PIN. Custom claim `orgIds: ['ddmau']` set on every existing user. (1 week)
2. **Migrate DD Mau data to `/orgs/ddmau/...`** while old paths still work via a read-fallback shim. (3 days)
3. **Migrate every Firestore call in the client to use `useOrgId()`** + remove read-fallback shim. (1 week)
4. **Rewrite firestore.rules** with `isMemberOf(orgId)` gates everywhere. (2 days)
5. **Build the sign-up + invite flows** for new orgs. (3 days)
6. **Self-serve onboarding** — a new restaurant can sign up, build their menu, pair their TVs without Andrew's help. (1 week)

## 12. What NOT to do

- **Don't try to do this in one PR.** Each step above should ship and bake for a week before moving on.
- **Don't migrate the rules until the client is fully on `/orgs/{orgId}/...`** — otherwise active sessions break.
- **Don't add per-org branding before the migration ships** — gold-plating before the foundation is set.

## 13. What to do next (when you start this)

1. Read this doc end-to-end.
2. Sign off on §2 decisions (slug vs ID, auth-claim vs subdomain, etc.).
3. Branch from main, NEVER merge to main until step 1 of §11 is ready.
4. Start with the Firebase Auth + custom claim setup (the longest pole; the rest depends on it).

---

This stays a doc until you're ready to start. It's the longest
remaining audit item — saved for after the operational features
(security, chat, schedule, inventory, TV, printers) are all in
good shape, which is the state we're in now.
