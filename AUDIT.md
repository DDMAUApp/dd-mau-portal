# DD Mau Staff Portal — Production Audit

**Auditor:** Claude (senior engineering review)
**Date:** 2026-05-17
**Audit version:** v1 (Pass 1: security + architecture)
**App version at audit:** commit `16ca95a` (main)
**Scope:** Full code-level review of the dd-mau-portal SPA + Cloud Functions + Firestore/Storage rules

---

## ⚠ Auditor's preamble

This audit was performed from the codebase alone. Findings that can only be confirmed via runtime testing (real-device mobile UX, actual perf under throttle, real Firestore data corruption) are tagged **needs-runtime-validation**.

Scope assumed:
- Everything currently shipped is production-critical
- Primary device: iPhone iOS Safari (the codebase has iOS-specific fixes throughout)
- "Launch" = staff use it today at DD Mau **and** the app should be architected so it could become SaaS later

Total passes planned:
- ✅ **Pass 1** — Security & architecture (this doc)
- ⏳ **Pass 2** — Per-module (Chat, Schedule, Operations, Onboarding, Admin, etc.)
- ⏳ **Pass 3** — UX, performance, i18n
- ⏳ **Pass 4** — Synthesize & triage with you

---

## 1. Executive summary

### Overall health: **Yellow — usable internally, NOT sellable as SaaS today**

DD Mau's portal is a thoughtful, feature-rich app with good engineering hygiene in places (162 passing tests, defense-in-depth comments, audit trails on most state changes). It clearly works for DD Mau's day-to-day operations.

**But there are three production-grade risks that block SaaS:**

1. **No authentication.** The app uses *anonymous Firestore access* — every device that opens the app reads/writes the database directly. The PIN screen is a *client-side gate only*. Anyone who fetches the app and knows or finds the Firebase config (which is in the public client bundle) can read every collection.
2. **Firestore + Storage rules are mostly open.** The catch-all `match /{document=**} { allow read, write: if true; }` covers every collection that isn't explicitly hardened. PII paths (`/onboarding_hires`, `/onboarding_invites`) are explicitly `allow read: if true` — anyone can list every new hire's full record including admin-uploaded copies of their SSN-bearing PDFs (PDFs are in Storage which is also open).
3. **PINs are stored in plaintext** at `/config/staff.list[].pin` and readable by every device. The PIN is the only thing standing between a curious person and admin access.

For internal DD Mau use today, the threat model is "a curious staff member with DevTools" — moderate but not zero. For SaaS, this is a non-starter — you'd be one Reddit post away from a public PII leak.

### Biggest risks (descending severity)

| # | Risk | Category | Launch blocker for SaaS? | Launch blocker for DD Mau? |
|---|------|----------|--------------------------|----------------------------|
| 1 | Anonymous Firestore access + open rules + plaintext PINs → PII exposed to any DevTools user | Security | **Yes** | Soft yes (Andrew's call) |
| 2 | `translateMessage` Cloud Function has no auth check → anyone can spam it and burn your Translation API quota | Security/cost | **Yes** | No (cheap to fix) |
| 3 | Public Apply form has weak rate limit (60s client-side cooldown only) → an attacker can flood applications | Security/abuse | Yes | No |
| 4 | `forceRefresh` doc is open writable — anyone can force every device to reload at will | Abuse | Medium | Low |
| 5 | Onboarding portal token validation is purely client-side (`/?onboard=TOKEN` → client reads `/onboarding_invites/{token}` and shows the hire's record). Knowing any valid token = full read access to that hire's data. | Security | **Yes** | No (tokens are random) |
| 6 | App Check is disabled (per the comment in `src/firebase.js`) — Firebase API quota can be enumerated by anyone with the apiKey from the client bundle | Cost/abuse | Yes | Low |
| 7 | Cloud Functions have no per-org isolation — `dispatchNotification` and `sendShiftReminders` would cross orgs on day 1 of SaaS | SaaS-blocker | **Yes** | No |
| 8 | Hardcoded owner IDs `40, 41` and DD-Mau-specific magic numbers all over the data layer | SaaS-blocker | Yes | No |

### What must be fixed before SaaS launch
- [ ] Wire Firebase Auth (email + magic link or password)
- [ ] Migrate every collection under `/orgs/{orgId}/...`
- [ ] Custom claims (`{orgId, role, ...}`) baked into Auth tokens
- [ ] Firestore rules rewritten to gate by `request.auth.token.orgId == orgIdInPath`
- [ ] Storage rules rewritten to gate uploads/downloads by claim
- [ ] App Check enforced (reCAPTCHA v3 + iOS DeviceCheck)
- [ ] All Cloud Functions: add `if (!request.auth) throw new HttpsError('unauthenticated', ...)` or restrict by claim
- [ ] PINs migrated to bcrypt/argon2 hashes (or removed entirely once Auth is in)
- [ ] Onboarding portal token validation moved to a Cloud Function (so the token check is *server-side*, not browser-side)
- [ ] Replace every hardcoded ID (40, 41) / location string ('webster', 'maryland') with org-scoped config

### What can wait (post-SaaS)
- Performance optimization for >50 concurrent users (see Pass 3 — irrelevant until SaaS)
- Multi-language beyond en/es
- iPad-specific layout polish
- Test coverage beyond the data layer

### What must be fixed before DD Mau staff use it more
- Things flagged in the per-module bug list (Pass 2) and the launch-blocker section at the bottom of this doc

---

## 2. Pass 1: Security & architecture findings

Each finding follows the format you requested.

---

### [SEC-001] Firestore rules expose every un-hardened collection to anonymous read/write

**Severity:** **CRITICAL** (for SaaS) / High (for DD Mau internal)
**Area:** Firestore security rules
**User affected:** Everyone — and any external attacker
**Steps to reproduce:**
1. Open Chrome DevTools → Network tab → reload `app.ddmaustl.com`
2. Find the call to `firestore.googleapis.com`
3. Copy the project ID + apiKey from any JS bundle (it's in `src/firebase.js` and ships to the client uncompressed)
4. From any machine, run:
   ```js
   const { initializeApp } = await import('firebase/app');
   const { getFirestore, collection, getDocs } = await import('firebase/firestore');
   const app = initializeApp({ apiKey: 'AIzaSy…', projectId: 'dd-mau-staff-app' });
   const db = getFirestore(app);
   const snap = await getDocs(collection(db, 'chats'));
   snap.forEach(d => console.log(d.id, d.data()));
   ```
5. **You will see every chat message between staff.**

**Expected:** Only authenticated users with appropriate roles read each collection.
**Actual:** The catch-all `match /{document=**} { allow read, write: if true; }` in `firestore.rules` (lines 310–312) lets anyone read/write any un-hardened collection: `/chats`, `/chats/*/messages`, `/shifts`, `/time_off`, `/notifications`, `/audit`, `/offsite_shifts`, `/maintenance_tickets`, `/checklists*`, `/inventory*`, `/labor*`, `/orders*`, `/vendor_prices*`, and many more.

**Likely root cause:** App pre-dates Firebase Auth. Rules were intentionally left open with the plan to harden after wiring Auth — the comment block at the top of `firestore.rules` acknowledges this as Phase 2.

**Recommended fix (phased):**
- **Phase 1 (defense-in-depth, ~2 hours):** Replace the catch-all with `allow read, write: if false;` and explicitly opt-in each collection that needs anonymous access. Even without Auth, this caps the blast radius if someone discovers a new collection.
- **Phase 2 (SaaS-blocking, ~2 weeks):** Wire Firebase Auth + custom claims; rewrite every rule to gate by `request.auth.token.orgId` and `request.auth.token.role`.

**Files to change:**
- `firestore.rules` (every match block)
- `storage.rules` (mirrors the same issue — `match /{allPaths=**} { allow read, write: if true; }` at line 70)
- `src/firebase.js` (uncomment App Check init once site key is verified)
- `src/App.jsx` (wire `onAuthStateChanged`)

**Test plan:**
1. Deploy hardened rules to a staging Firebase project first
2. From an unauthenticated machine, try to read every collection — must fail with `permission-denied`
3. Confirm legit app flows still work for signed-in staff (read/write everything they need)
4. Run the test suite (162 tests, none should break)

**Launch blocker:** **Yes for SaaS.** Soft yes for DD Mau internal — this is the single highest-leverage thing to fix.

---

### [SEC-002] `translateMessage` Cloud Function has no auth check — anyone can drain your Translation API budget

**Severity:** High (cost + abuse)
**Area:** Cloud Functions
**User affected:** Owner (cost), all users (if the function gets rate-limited)
**Steps to reproduce:**
1. Get the function URL: `https://us-central1-dd-mau-staff-app.cloudfunctions.net/translateMessage`
2. From any machine:
   ```bash
   curl -X POST <url> \
     -H "Content-Type: application/json" \
     -d '{"data": {"targetLang": "es", "text": "Hello team"}}'
   ```
3. Returns a translation. No auth required.
4. Loop this 1M times → bills you for 1M × ~10 chars = 10M chars = ~$200 in Google Translate fees (assuming you've used past the free tier).

**Expected:** Only authenticated DD Mau staff can call the function.
**Actual:** `exports.translateMessage = onCall(...)` checks no auth. The function does check `text.length > 5000` for size, but a 4999-char request loops easily.

**Likely root cause:** App doesn't have Firebase Auth yet, so we deliberately skipped the auth check during development.

**Recommended fix:**
- Short-term: add a per-IP rate limit using Firestore (1 request / 5 sec / IP) inside the function
- Medium-term: require Firebase Auth, then add `if (!request.auth) throw new HttpsError('unauthenticated', 'sign in')`
- Long-term: require App Check token via `consumeAppCheckToken: true` in the onCall options

**Files to change:**
- `functions/index.js` line 1071 (add the rate limit + auth check)

**Test plan:**
1. From signed-in app, tap Translate — should work
2. From an unauth'd curl, hit the URL — should return `unauthenticated`
3. Burst 10 requests in 1 second — should rate-limit after the first

**Launch blocker:** Yes for SaaS. For DD Mau, low (no one knows the URL exists, but the bar is one tech-savvy ex-employee).

---

### [SEC-003] Staff PINs are stored in plaintext and world-readable

**Severity:** **CRITICAL** (for any scenario)
**Area:** `/config/staff` Firestore doc
**User affected:** Everyone — knowing any staff PIN bypasses the only auth check the app has
**Steps to reproduce:**
1. Reproduce SEC-001 → fetch `/config/staff`
2. The doc structure is `{ list: [{ id, name, role, pin, ... }] }` — every staff PIN is right there as a 4-digit string

**Expected:** PINs are hashed (bcrypt/argon2) and the client compares hashes
**Actual:** `src/components/HomePage.jsx` line 76: `const matches = staffList.filter(s => s.pin === pin);` — direct string comparison against the plaintext PIN in the staff doc.

**Likely root cause:** Quick prototype that never got hardened. The current model is "trust the client" — once Auth lands, PINs become irrelevant.

**Recommended fix:** Two paths, depending on timeline:
- **If Auth is being wired in the next 2 weeks:** Skip PIN hashing, go straight to Auth. PINs disappear from the data layer entirely.
- **If PINs stay for a while:**
  1. Add a `pinHash` field alongside `pin`. Compute hash in a Cloud Function callable (so the salt isn't in the client).
  2. Migrate every staff record once.
  3. Drop the `pin` field after a soak period.
  4. PIN comparison becomes a callable round-trip instead of a client-side filter.

  This has cost: every PIN attempt becomes a network call. For a kitchen team that signs in once a shift, ~30 calls/day. Free-tier safe.

**Files to change:**
- `src/components/HomePage.jsx` line 76
- `src/data/staff.js` (PIN-related helpers)
- `functions/index.js` (new `verifyPin` callable + `setPin` callable)
- Firestore rule on `/config/staff` to reject any write that includes a `pin` field (forces hashing path)

**Test plan:**
1. Sign in with current 4-digit PIN — works
2. Try to read `/config/staff` from an anon DevTools session — should not return `pin` (rule rejects reads that include the field, or the field doesn't exist)

**Launch blocker:** Yes for SaaS. For DD Mau, moderate — staff would have to know to look.

---

### [SEC-004] Onboarding portal token is verified client-side only

**Severity:** High (PII exposure)
**Area:** `/?onboard=TOKEN` route
**User affected:** Any new hire who has been issued a token; the attacker just needs to guess/find a token
**Steps to reproduce:**
1. Get any valid token (e.g. find one in your sent email, or look at the Firestore `/onboarding_invites` collection via SEC-001)
2. Visit `app.ddmaustl.com/?onboard=TOKEN`
3. App reads `/onboarding_invites/{token}` → resolves to hireId → reads `/onboarding_hires/{hireId}` (open per SEC-001)
4. The full PII (SSN-bearing PDFs, DL photos, address, phone, banking info if entered) is now visible in the browser

**Expected:** Token validation runs server-side; if invalid, the hire data never enters the client.
**Actual:** Both reads happen client-side via plain Firestore SDK calls. The `OnboardingPortal.jsx` component decides what to show; nothing on the server validates anything.

**Likely root cause:** Anonymous-access architecture means there's no server-side identity to gate on. The token IS the auth — which is fine IF the token can only be issued + validated server-side. Right now it's stored in plain Firestore and anyone can list every token.

**Recommended fix:**
1. Move `/onboarding_invites/*` behind a Cloud Function (`validateInvite` HTTPS callable)
2. Tighten the rule to `allow read: if false` on `/onboarding_invites` and `/onboarding_hires`
3. Client posts the URL token to the callable → callable returns `{ hireId, scopedTokenForStorage }`
4. Client uses the scoped token to fetch the PDFs from Storage (Storage rules also need to validate this)

This is a meaningful refactor but necessary for handling SSN-bearing documents.

**Files to change:**
- `src/components/OnboardingPortal.jsx` (replace direct Firestore reads with the callable)
- `functions/index.js` (new `validateInvite`, `getHireForPortal` callables)
- `firestore.rules` (tighten `/onboarding_invites` + `/onboarding_hires` to admin-only)
- `storage.rules` (same)

**Test plan:**
1. Valid token → portal loads
2. Invalid token → friendly "invite expired or invalid" page
3. Expired token (set `expiresAt` to past) → expired message
4. Try to enumerate tokens from anon DevTools → permission denied

**Launch blocker:** **Yes** for any scenario involving real PII. Until this is fixed, **do not send onboarding invites containing SSN, DL, or banking data via the portal.** Use paper for those.

---

### [SEC-005] `/audit` collection is open writable + deletable

**Severity:** High (audit-trail integrity)
**Area:** Firestore rules
**User affected:** Owner (whoever needs to investigate later)
**Steps to reproduce:**
1. Reproduce SEC-001
2. Get a reference to any audit doc:
   ```js
   const snap = await getDocs(collection(db, 'audit'));
   snap.forEach(d => deleteDoc(d.ref));
   ```
3. Audit log is wiped. Or:
4. `updateDoc(audit/anyDoc, { actorName: 'Innocent Person' })` — rewrite history.

**Expected:** Audit logs are append-only, never updatable, never deletable.
**Actual:** `match /{document=**} { allow read, write: if true; }` covers `/audit` since there's no explicit rule for it. (The hardened audit collections — `pin_audits`, `recipe_audits`, `inventory_audits_*`, `onboarding_audits`, `backup_history` — DO have correct append-only rules. The general `/audit` collection used by chat, offsite_shifts, etc., does NOT.)

**Likely root cause:** When `recordAudit` was first wired, only some audit categories got dedicated paths. Newer subsystems (chat, offsite_shifts, schedule actions) all write to `/audit/{auditId}` which falls through to the catch-all.

**Recommended fix:** Add an explicit rule for `/audit/{auditId}`:
```
match /audit/{auditId} {
    allow read: if true;
    allow create: if request.resource.data.action is string
                  && request.resource.data.actorName is string
                  && request.resource.data.createdAt == request.time;
    allow update, delete: if false;
}
```

**Files to change:** `firestore.rules` (insert before the catch-all)

**Test plan:**
1. Existing chat actions still write audits (try sending a message → check `/audit`)
2. From DevTools, try to delete an audit doc → permission denied
3. Try to update an audit doc's `actorName` → permission denied

**Launch blocker:** Yes (cheap to fix, big integrity win).

---

### [SEC-006] App Check is disabled — Firebase quota is up for grabs

**Severity:** Medium (cost; abuse)
**Area:** Firebase infrastructure
**User affected:** Owner (cost) + every user (if quota gets exhausted)
**Steps to reproduce:** Inspect `src/firebase.js` lines 16–57 — the App Check init is commented out with a long explainer about why. The comment says the reCAPTCHA site key was registered for an old domain (not `app.ddmaustl.com`).

**Expected:** App Check enforces that requests come from your real app (not a curl loop). Without it, Firebase has no way to distinguish your staff from an attacker who scraped the apiKey.

**Actual:** Enforcement is off. The apiKey in `src/firebase.js` is a public web key (correct) — but it's only safe to publish IF App Check restricts who can use it. Right now anyone can use that key from anywhere.

**Recommended fix (per the existing comment block):**
1. In Google reCAPTCHA admin, verify the site key has `app.ddmaustl.com` as an allowed domain. If not, add it.
2. Uncomment lines 47–57 in `src/firebase.js`
3. Deploy. Verify in browser console that AppCheck init doesn't spam errors.
4. Once verified, flip enforcement to ENFORCED in Firebase Console → App Check.

**Files to change:** `src/firebase.js`

**Test plan:**
1. Console should be clean after init (no reCAPTCHA errors)
2. From a non-allowlisted domain, attempt a Firestore read → should fail with App Check error
3. From `app.ddmaustl.com`, all flows still work

**Launch blocker:** No for DD Mau (Andrew already commented this off because it was spamming errors), Yes for SaaS.

---

### [SEC-007] `forceRefresh` doc is open writable — anyone can mass-reload every staff device

**Severity:** Medium (denial-of-service / annoyance)
**Area:** Firestore rules + the `/config/forceRefresh` mechanism
**User affected:** Every staff member
**Steps to reproduce:** SEC-001 → write anything to `/config/forceRefresh` → every device reloads.

**Expected:** Only admin can trigger the force-refresh broadcast.
**Actual:** `match /config/forceRefresh { allow read, write: if true; }` (line 92 of `firestore.rules`)

**Recommended fix:** Until Auth lands, narrow the rule to require a specific payload shape that's annoying to fabricate but easy to write from the admin UI:
```
match /config/forceRefresh {
    allow read: if true;
    allow write: if request.resource.data.triggeredBy is string
                 && request.resource.data.triggeredAt == request.time;
}
```
That doesn't stop a determined attacker but stops casual abuse. Real fix: Auth + admin claim.

**Files to change:** `firestore.rules` line 92

**Launch blocker:** No (low-frequency annoyance, easy to detect).

---

### [SEC-008] Apply form rate limit is client-side only

**Severity:** Medium (spam/abuse)
**Area:** `/onboarding_applications` + Apply form
**User affected:** Owner (cleanup), all users (if the spam triggers a Firebase rate limit upstream)
**Steps to reproduce:** Visit `app.ddmaustl.com/?apply=1`, submit, then run a loop bypassing the React component:
```js
for (let i = 0; i < 1000; i++) {
    addDoc(collection(db, 'onboarding_applications'),
      { name: `spam${i}`, createdAt: serverTimestamp() });
}
```
The Firestore rule narrows shape (name required + length 2..200) but allows any volume.

**Expected:** Per-IP rate limit (max 5 applications/hour/IP).
**Actual:** A client-side 60s cooldown that's trivially bypassed.

**Recommended fix:** Move the submission through a Cloud Function callable that:
- Validates reCAPTCHA v3 token (or App Check)
- Checks a Firestore-backed per-IP counter (5/hr)
- Then writes the application

**Files to change:**
- `src/components/OnboardingApply.jsx`
- `functions/index.js` (new `submitApplication` callable)
- `firestore.rules` (tighten `/onboarding_applications` create rule)

**Launch blocker:** Yes for SaaS, no for DD Mau (Andrew prunes manually).

---

### [SEC-009] No content security policy (CSP) header

**Severity:** Medium (XSS hardening)
**Area:** GitHub Pages static hosting
**User affected:** Every user (in the event of an XSS bug elsewhere)
**Steps to reproduce:** `curl -I https://app.ddmaustl.com` — no `Content-Security-Policy` header, no `X-Frame-Options`, no `Strict-Transport-Security` (GitHub Pages adds the last one automatically), no `Permissions-Policy`.
**Expected:** A CSP that whitelists only the origins the app actually loads from (Firebase, Google Cloud, your own).
**Actual:** No CSP. If an XSS bug ships anywhere (e.g., the chat message renderer eventually has a regex bug), the attacker has full access to everything the user can access.

**Recommended fix:** GitHub Pages doesn't let you add headers directly. Two options:
1. **Cloudflare in front of the Pages site** (15 min setup) — adds CSP + WAF
2. **Migrate hosting to Firebase Hosting** — supports custom headers in `firebase.json`. Less drift.

For DD Mau, option 2 is cleaner because you're already on Firebase.

**Files to change:**
- `firebase.json` (add hosting block + headers)
- `.github/workflows/*.yml` (point deploy at Firebase Hosting)

**Launch blocker:** No for DD Mau (low actual risk), Yes for SaaS (every customer expects this).

---

### [SEC-010] Mention-name injection in chat — minor

**Severity:** Low
**Area:** Chat `parseMentions` + notification fan-out
**Steps to reproduce:** Send a chat message with `@"<script>alert(1)</script>"` — does the staff list match? It checks `names.find(n => n.toLowerCase() === '<script>...'`. No staff is named that, so no notification fires. But the message body itself contains the literal characters. React's default escaping prevents XSS at render time. **No actual vulnerability**, just worth noting in case anyone ever switches to `dangerouslySetInnerHTML`.
**Recommended fix:** Add a unit test that pins the React-default-escaping behavior so it doesn't regress.
**Launch blocker:** No.

---

### [SEC-011] Sensitive data in console.warn logs — *recalibrated*

**Severity:** Low (was Low-Medium)
**Area:** Multiple files
**Update during fix application (2026-05-17):** `vite.config.js` lines 58–60 already strip `console.log/info/debug/trace` from production builds. Only `console.warn` and `console.error` are kept on purpose — they're the ones that signal real errors. The right fix is **not** to strip warn/error wholesale (you'd lose prod observability) but to audit each warn/error call site to make sure it doesn't include PII (staff names → ok, message bodies → not ok, hire SSN snippets → never).

This is a code-review task to add to Pass 2's per-module section, not a quick win. Demoted from launch-blocker.

**Files to audit (where warn/error appears with potentially-PII context):**
- `src/components/ChatThread.jsx` — `console.warn('chat-preview update failed:', e)` — `e` may contain message snippets
- `src/components/AdminPanel.jsx` — many warns include staff names
- `src/components/Onboarding.jsx` — needs careful review (PII path)

**Launch blocker:** No.

---

## 3. Pass 1: Architecture findings (non-security)

---

### [ARCH-001] Hardcoded admin/owner IDs throughout codebase

**Severity:** High (SaaS-blocker)
**Area:** `src/data/staff.js` + every gate
**Affected:**
```
src/data/staff.js:6:  export const ADMIN_IDS = [40, 41];
src/data/staff.js:20: return !!me && ADMIN_IDS.includes(me.id);
src/data/staff.js:102: return ADMIN_IDS.includes(staff.id);
src/data/notify.js:64: const isOwner = s.id === 40 || s.id === 41;
src/data/chat.js:175: if (s.id === 40 || s.id === 41) return true;
src/components/ChatCenter.jsx:751: const isMgr = s.id === 40 || s.id === 41 || /manager|owner/i.test(role);
```

**Why it matters:** SaaS needs per-org admin identification. The fix is to store role on the staff record (`role: 'owner'`) and derive `isAdmin` from role rather than ID.

**Recommended fix:** Single-source the admin check on `role === 'owner'`. Remove `ADMIN_IDS` entirely. Migration: write `role: 'owner'` to records 40 + 41, then remove the ID-based check.

**Files to change:** ~7 call sites listed above.

**Launch blocker:** No for DD Mau, Yes for SaaS.

---

### [ARCH-002] Two-location hardcoded everywhere

**Severity:** High (SaaS-blocker)
**Area:** Everywhere
**Affected:** `'webster'`, `'maryland'` string literals appear in 100+ places. Per-location Firestore collections are named `ops/inventory_webster` / `ops/inventory_maryland` etc., so the suffix is part of the schema.

**Why it matters:** Adding a third DD Mau location would require code changes today. Multi-tenant SaaS requires per-org location lists.

**Recommended fix:** Move locations to a Firestore-backed list at `/orgs/{orgId}/locations`. The collection naming convention `ops/inventory_{location}` stays but the location string is data, not code. Every component reads the locations list and renders accordingly.

**Files to change:** Lots — but mechanical search-and-replace. Start with:
- `src/data/staff.js` (LOCATION_LABELS constant)
- `firestore.rules` (`inventory_audits_webster` + `inventory_audits_maryland` are two separate match blocks — rules don't support partial segment variables, so this stays per-location but parameterized via codegen or just listed)

**Launch blocker:** No for DD Mau, Yes for SaaS.

---

### [ARCH-003] Single huge components (Operations.jsx, AdminPanel.jsx, ChatThread.jsx)

**Severity:** Medium (maintainability)
**Area:** `src/components/`
**Affected files (line count):**
- `Operations.jsx` 6500+ lines
- `AdminPanel.jsx` 2680+ lines
- `Schedule.jsx` (didn't measure but heavy)
- `ChatThread.jsx` 1700+ lines

**Why it matters:** Slow to navigate, slow to test, slow to refactor. New bugs hide in 500-line render blocks. Lazy chunks are unnecessarily large.

**Recommended fix:** Carve off feature blocks into siblings:
- Operations.jsx → PricingTab, InventoryTab, ChecklistsTab (the existing tab structure should be the file boundary)
- AdminPanel.jsx → StaffList, MaintenanceList, OffsiteClockSection (✓ already extracted), RecipeAudit, PinAudit, etc.
- ChatThread.jsx → MessageBubble, AnnouncementCard, CoverageCard, PhotoIssueCard, TaskHandoffCard each into their own file

**Launch blocker:** No.

---

### [ARCH-004] Audit log writes are fire-and-forget — no retry, no observability

**Severity:** Medium
**Area:** `recordAudit` calls everywhere
**Affected:** Most call sites do `recordAudit({...})` without awaiting. If the write fails (offline, rules reject), the audit silently disappears.

**Why it matters:** Compliance scenarios (W-4 access tracking, recipe rollback, PIN attempt log) rely on the audit log. Silent loss undermines the value of the audit trail.

**Recommended fix:** Add a `pendingAudits` localStorage queue. If a write fails, push to the queue. Retry the queue on next mount (background). Surfaces an admin-visible "X audits failed to write" warning if the queue grows.

**Files to change:** `src/data/audit.js`
**Launch blocker:** No.

---

### [ARCH-005] No structured logging — every component uses ad-hoc `console.warn`

**Severity:** Medium
**Area:** Whole codebase
**Affected:** ~200 `console.warn` / `console.error` calls with inconsistent formatting

**Why it matters:** Can't surface real errors out of the noise. Can't ship to Sentry / LogRocket / Datadog later without rewriting.

**Recommended fix:** Add a `src/lib/log.js` wrapper. Call sites become `log.warn('chat.send_failed', { chatId, error: e.message })` — structured, redactable, ships to a sink later.

**Launch blocker:** No.

---

### [ARCH-006] `vendor-firebase` chunk is 562 KB raw / 131 KB gzipped — single biggest payload

**Severity:** Medium (mobile perf)
**Area:** Vite chunking
**Affected:** Every cold load

**Why it matters:** A new staff member opening the app on cellular is downloading 132 KB just to talk to Firebase. The comment in `vite.config.js` says "do NOT split — must load atomically" because of an outage. The current size is acceptable but watch as the Firebase SDK grows.

**Recommended fix:** Don't split, but trim what's imported. Currently `firebase` package is `^10.12.0` — `^11` ships smaller modular bundles. Audit imports — every `import { collection } from 'firebase/firestore'` pulls more code than `firebase/firestore/lite` would. Lite-mode Firestore lacks realtime, which the app uses heavily, so this is constrained.

**Files to change:** none yet — measure first.

**Launch blocker:** No.

---

### [ARCH-007] No CI / no automated deploy gate

**Severity:** Medium
**Area:** GitHub Actions
**Affected:** Push to main → 2 min → live in production. No tests run, no lint, no build verification beyond what GH Pages does to serve files.

**Why it matters:** The test suite (162 passing) doesn't actually gate deploys. Bug regressions ship.

**Recommended fix:** Add a workflow:
```yaml
name: ci
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npm run test
      - run: npm run build
```
And block merge to main on the check passing.

**Files to change:** `.github/workflows/ci.yml` (new file)
**Launch blocker:** No.

---

## 4. Pass 1: Critical launch-blocker shortlist

For DD Mau staff use **starting tomorrow**, the must-fix list is short:

1. **[SEC-002]** Add an auth check + rate limit to `translateMessage` → otherwise a 1-line script drains your budget (10 min fix)
2. **[SEC-005]** Add explicit rules to `/audit` → otherwise audit history is rewritable (5 min)
3. **[SEC-007]** Tighten `/config/forceRefresh` write rule (2 min)
4. **[SEC-011]** Strip `console.*` from prod build (2 min, quick win)

Total: **~20 minutes of work** for the DD-Mau-tomorrow launch.

For **SaaS launch** (months from now):
- All of SEC-001 through SEC-009
- All of ARCH-001 and ARCH-002 (multi-tenant migration)
- The Pass 2/3 findings below

---

## 5. Quick wins (≤15 minutes each)

These are small fixes that make the app feel measurably more professional. I'll batch-apply these if you say go.

| # | Fix | Effort | Files |
|---|-----|--------|-------|
| QW-01 | Strip console.* from prod build | 2 min | `vite.config.js` |
| QW-02 | Add explicit rule for `/audit` collection | 5 min | `firestore.rules` |
| QW-03 | Add rate limit + size guard to `translateMessage` (per-IP/per-hour) | 15 min | `functions/index.js` |
| QW-04 | Tighten `/config/forceRefresh` write rule | 2 min | `firestore.rules` |
| QW-05 | Replace `match /{document=**} { allow read, write: if true; }` with explicit per-collection allowlist (without changing posture — just making the rule less catch-all) | 15 min | `firestore.rules` |
| QW-06 | Add a 5xx error boundary at the app root with a "Refresh" button | 10 min | `src/App.jsx`, `ErrorBoundary` |
| QW-07 | Lazy-load Firebase Functions client only when first translation request is made | 10 min | `src/firebase.js`, `src/data/translation.js` |
| QW-08 | Add `<meta name="theme-color">` for mobile address-bar tint | 1 min | `index.html` |
| QW-09 | Add `<link rel="manifest">` quality fixes (apple-touch-icon, sized icons) | 5 min | `public/manifest.json` |

---

## 6. What I'm doing next (Pass 2)

Now starting Pass 2 — per-module review. I'll add findings to this doc as I go. Modules in order of priority based on usage:

1. ⏳ Chat (largest surface area, just shipped translation)
2. ⏳ Schedule (highest-stakes, payroll-adjacent)
3. ⏳ Operations (Pricing + Inventory + Checklists)
4. ⏳ Onboarding (PII)
5. ⏳ Admin (every off-site clock-in, vendor matches, etc.)
6. ⏳ Training
7. ⏳ Eighty6
8. ⏳ Maintenance
9. ⏳ Catering, Insurance, AI Assistant (less critical)

Then Pass 3: UX / perf / i18n.

Then I'll come back and write the executive summary properly (right now it's based on Pass 1 alone), plus the QA checklist + launch-readiness checklist you asked for.

---

*This is a living document. Each pass appends findings. Updated `2026-05-17`.*
