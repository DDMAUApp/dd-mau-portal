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

## 6. Pass 2: Per-module findings

---

### 6.1 Chat module

The most-recently-shipped surface, currently solid for DD Mau scale. Key gaps:

---

#### [CHAT-001] Chat media uploads land in Storage with no path-specific size or content-type rule

**Severity:** High
**Area:** `storage.rules`
**User affected:** Owner (cost), every user (if storage fills)
**Steps to reproduce:**
1. Confirm `storage.rules` — no `match /chats/{chatId}/...` block exists. Uploads at path `chats/${chat.id}/${messageId}.${ext}` fall through to the catch-all `match /{allPaths=**} { allow read, write: if true; }` at line 70.
2. From DevTools (after SEC-001 firestore access):
   ```js
   const ref = sref(storage, 'chats/anychatid/spam.bin');
   await uploadBytes(ref, new Blob([new Uint8Array(500_000_000)]));
   ```
3. 500 MB blob accepted. Client-side `MAX_VIDEO_BYTES = 50MB` check (ChatThread.jsx:44) is the only gate, and it's bypassable.

**Expected:** Storage rules cap chat uploads at 50 MB and content-type to `image/*` | `video/*` | `audio/*`.
**Actual:** Storage rule for `/chats` doesn't exist; the open catch-all governs.
**Likely root cause:** Chat shipped after onboarding; the storage rules pattern of "explicit path with size + content-type" wasn't extended to the new chat upload paths.
**Recommended fix:** Add to `storage.rules`:
```
match /chats/{chatId}/{fileName} {
    allow read: if true;     // any signed-in viewer can read attachments
    allow write: if request.resource.size < 50 * 1024 * 1024
                 && request.resource.contentType.matches('image/.*|video/.*|audio/.*');
    allow delete: if true;   // hard-delete cascade on hard-delete chat
}
```
**Files to change:** `storage.rules` (insert before catch-all at line 70)
**Test plan:**
1. Send a normal photo through the app — works
2. Try DevTools upload of a 100 MB file → permission denied
3. Try DevTools upload of `application/octet-stream` → permission denied
**Launch blocker:** Yes for SaaS, Medium for DD Mau (cost risk).

---

#### [CHAT-002] `lastReadByName` write fires on every snapshot update — write quota burn

**Severity:** Medium (cost)
**Area:** `src/components/ChatThread.jsx` line 75–79
**User affected:** Every user reading any chat
**Steps to reproduce:**
1. Open a chat with 50 messages
2. Have another user send 10 messages in quick succession
3. Open Firestore writes counter — observe ~10 writes to `chats/{id}` (one per snapshot tick) just to update `lastReadByName.{me}`

**Expected:** Mark-read writes debounced to ~1 per 3 seconds while the chat is open.
**Actual:** The effect's dep is `[chat?.id, staffName, messages.length]` so it fires on every new message arrival.
**Likely root cause:** Quick-and-dirty implementation. The denormalized "unread dot" UX is correct but the write rate is wasteful.
**Recommended fix:** Wrap in a debounce. Use `useDeferredValue` + a write throttle:
```js
useEffect(() => {
    if (!chat?.id || !staffName) return;
    const t = setTimeout(() => {
        updateDoc(doc(db, 'chats', chat.id), {
            [`lastReadByName.${staffName}`]: serverTimestamp(),
        }).catch(e => console.warn('markRead failed:', e));
    }, 1500);
    return () => clearTimeout(t);
}, [chat?.id, staffName, messages.length]);
```
**Files to change:** `src/components/ChatThread.jsx:74-79`
**Test plan:**
1. Open a chat, watch 5 messages arrive in 3 seconds
2. Confirm only 1–2 writes to `chats/{id}` instead of 5
**Launch blocker:** No (cost optimization, not behavior).

---

#### [CHAT-003] Notification fan-out is N writes per chat message — scales as O(members × messages)

**Severity:** Medium (cost) + Medium (latency)
**Area:** `src/components/ChatThread.jsx` `sendMessage()` around line 1216
**User affected:** Owner (cost), every user (perceived send latency)
**Steps to reproduce:**
1. Send 1 message to a 30-person all-team channel
2. Observe 29 writes to `/notifications` (one per recipient)
3. The `dispatchNotification` Cloud Function then runs 29 times in parallel
4. For a busy chat day (200 messages × 30 recipients), that's 6,000 doc writes + 6,000 function invocations

**Expected:** Per-message fan-out happens server-side once. Each FCM batch send goes to all member tokens in a single Admin SDK call.
**Actual:** Fan-out is purely client-side; client makes N writes per message.
**Recommended fix:** Move the fan-out into a Firestore-trigger Cloud Function on `/chats/{id}/messages/{msgId}` create. Function reads the parent chat's members, batches notifications. Client just writes the message + bumps `lastMessage` and exits. Bonus: this also makes notification fan-out work even when the sender's browser closes immediately after Send.
**Files to change:**
- `functions/index.js` (new `onChatMessageCreated` trigger)
- `src/components/ChatThread.jsx` (remove the client-side fan-out)
**Launch blocker:** No for DD Mau (small team), Medium for SaaS.

---

#### [CHAT-004] Upload progress is binary — no percentage indicator for large files

**Severity:** Medium UX
**Area:** `src/components/ChatThread.jsx` `handleMediaPick`
**User affected:** Anyone uploading a video on cellular
**Steps to reproduce:** Pick a 30 MB video on a phone with weak cell signal. UI says "Uploading video…" with no progress for 30+ seconds. User assumes the app froze, swipes away, upload aborts.
**Expected:** Progress bar 0–100% with bytes transferred.
**Actual:** `uploadBytes` doesn't emit progress; the UI sets `{ pct: 0 }` and never updates.
**Recommended fix:** Use `uploadBytesResumable`:
```js
const task = uploadBytesResumable(ref, uploadFile, { contentType: file.type });
task.on('state_changed',
    (snap) => setUploadProgress({ kind, pct: (snap.bytesTransferred / snap.totalBytes) * 100 }),
    (err) => { setUploadProgress(null); alert('Upload failed'); },
    async () => { const url = await getDownloadURL(task.snapshot.ref); /* ...send message */ }
);
```
Also add a Cancel button that calls `task.cancel()`.
**Files to change:** `src/components/ChatThread.jsx:200-240` + `360`
**Launch blocker:** No.

---

#### [CHAT-005] Soft-deleted messages preserve full body — GDPR / privacy concern

**Severity:** Medium (privacy / SaaS-blocker)
**Area:** `src/components/ChatThread.jsx` `handleDelete`
**User affected:** Anyone who deletes a message expecting it to be gone
**Steps to reproduce:** Send "I hate working here", delete it. The Firestore doc keeps `text: "I hate working here"` + `deleted: true`. Admin who reads the chat sees the placeholder UI but can read the original via DevTools.
**Expected:** Deleting actually removes the text. Audit log can keep a snippet for dispute resolution but the original doc shouldn't have the full body forever.
**Actual:** Full text stays + the audit log also stores `originalSnippet: msg.text.slice(0, 200)` — so the text exists in TWO places after "delete".
**Recommended fix:** Two-tier:
1. On delete, set `deleted: true`, `deletedAt: serverTimestamp()`, KEEP text for 7 days.
2. A scheduled Cloud Function purges `text` and `mediaUrl` from deleted messages older than 7 days.
3. Audit snippet truncates to 60 chars max.
**Files to change:**
- `src/components/ChatThread.jsx` `handleDelete`
- `functions/index.js` (new `purgeOldDeletedMessages` scheduled function)
**Launch blocker:** No for DD Mau (small team, no GDPR), Yes for SaaS.

---

#### [CHAT-006] Search panel re-creates 25 onSnapshot listeners on every date-range change

**Severity:** Medium (perf)
**Area:** `src/components/ChatSearchPanel.jsx:36-59`
**Steps to reproduce:**
1. Open chat search
2. Change date filter from "Last 7d" to "Last 30d"
3. All 25 chat subscriptions tear down + restart (25 query terminations + 25 new query starts)
**Recommended fix:** Subscribe once to all chats (no date filter at the query layer), filter client-side by `dateRange` cutoff inside the existing `messagesByChat` reducer. The cutoff is just a comparison.
**Files to change:** `src/components/ChatSearchPanel.jsx:36-59`
**Launch blocker:** No.

---

#### [CHAT-007] Search panel deep-link to message no longer broken (fixed earlier this session — confirmation)

**Status:** Fixed in commit 2bef32e. Listed here for completeness — the search → jump → highlight flow now works correctly via `jumpToMessageId` threading through ChatCenter → ChatThread.

---

#### [CHAT-008] 200-message hard limit on thread load — no scrollback

**Severity:** Low for DD Mau (kitchen chat moves fast), Medium for SaaS
**Area:** `src/components/ChatThread.jsx:60`
**Steps to reproduce:** A chat with >200 messages — scroll up — nothing happens, no "load older" button.
**Recommended fix:** Add a "Load older" button + cursor pagination. Or implement infinite-scroll with `startAfter(oldestVisibleMessage)`.
**Launch blocker:** No.

---

#### [CHAT-009] DM creation race — two users opening a DM simultaneously can clobber each other's first message

**Severity:** Low (edge case)
**Area:** `src/components/ChatCenter.jsx` `handleCreate` DM path
**Steps to reproduce:**
1. User A opens new chat → picks Julie → taps Create
2. Simultaneously, Julie opens new chat → picks User A → taps Create
3. Both call `setDoc(ref, {...createdAt: serverTimestamp()})` — the second write overwrites the first's createdAt. Members + admins are identical, so no real data loss, just an inconsistent createdAt.
**Recommended fix:** Use `setDoc(ref, { ... }, { merge: true })`. Idempotent.
**Files to change:** `src/components/ChatCenter.jsx:866`
**Launch blocker:** No.

---

### 6.2 Schedule module

`Schedule.jsx` is the most complex single file (9,481 lines). Strong defense-in-depth comments throughout. Findings:

---

#### [SCHED-001] Nine concurrent Firestore subscriptions on cold mount

**Severity:** Medium (perf)
**Area:** `src/components/Schedule.jsx:540-805`
**Steps to reproduce:**
1. Cold load `/schedule` route
2. Network tab shows 9 simultaneous `Listen` channels open (shifts, schedule_settings, swap_requests, calendar_events, date_blocks, time_off, staffing_needs, schedule_templates, recurring_shifts)
3. Plus a one-shot `laborHistory_{location}` fetch
**Expected:** Subscriptions stagger or coalesce; non-critical data lazy-fetched after first paint.
**Actual:** All 9 open at mount.
**Recommended fix (later, not urgent):**
- shifts + date_blocks are critical for first paint — keep eager
- time_off + swap_requests gated behind viewer's role (only managers actively use these)
- calendar_events + schedule_templates + recurring_shifts can lazy-load on first interaction with their respective UI surfaces
**Launch blocker:** No.

---

#### [SCHED-002] localStorage cache write fires on every snapshot tick — JSON serialize cost per write

**Severity:** Medium (mobile perf — main thread block)
**Area:** `src/components/Schedule.jsx:554`
```js
localStorage.setItem(CACHE_KEY, JSON.stringify({ items, savedAt: Date.now() }));
```
**Steps to reproduce:** Open schedule. Push 5 shifts in quick succession from another device. Each snapshot tick serializes the full shifts array to JSON and writes to localStorage. With 300 shifts (a 6-month window) × 5 ticks = 5 × ~80 KB serializations on the main thread.
**Recommended fix:** Debounce the cache write to once per 3 seconds. Use `setTimeout` with cleanup.
**Files to change:** `src/components/Schedule.jsx:548-561`
**Launch blocker:** No.

---

#### [SCHED-003] `new Date(date + 'T00:00:00')` parses in viewer's local timezone — risky for cross-timezone staff

**Severity:** Low for DD Mau (single timezone — Central), Medium for SaaS
**Area:** Multiple files
```
src/components/ChatCoverageRequestModal.jsx:223
src/components/ChatThread.jsx:1505
src/components/OnboardingApply.jsx:115
```
**Steps to reproduce:** A staff member traveling to a different timezone opens the app. The date "2026-05-17" parses as midnight local — but the schedule logic stores dates in a single restaurant-local format. Off-by-one-day rendering possible.
**Recommended fix:** Wrap date-string parsing in a single `parseLocalDate(dateStr, locationTimezone)` helper. Use the org's restaurant timezone (stored in config), not the browser's.
**Files to change:** Add `src/data/dates.js`, replace `new Date(str + 'T00:00:00')` everywhere with `parseLocalDate(str)`.
**Launch blocker:** No (DD Mau is single-timezone), Yes for multi-timezone SaaS.

---

#### [SCHED-004] Schedule has 10 `alert(...)` / `confirm(...)` calls — disruptive on mobile

**Severity:** Medium UX
**Area:** `src/components/Schedule.jsx`
**Steps to reproduce:** Tap any error path (delete a shift, conflicting shift, etc.) on mobile. iOS Safari pops a native confirm/alert that takes over the screen. Cannot be styled, awkward on small screens, breaks the kitchen-shift workflow rhythm.
**Recommended fix:** Replace `window.alert` / `window.confirm` with the existing `toast()` helper (`src/toast.js`) for non-blocking notices, and inline confirm UI (the "Are you sure?" button-promotion pattern) for destructive actions.
**Files to change:** All ~10 sites in Schedule, plus ~12 in ChatThread, 9 in ChatSettingsModal.
**Launch blocker:** No, but UX polish.

---

#### [SCHED-005] Schedule writes don't use Firestore transactions for stateful operations like shift swap approval

**Severity:** Medium (data consistency)
**Area:** Schedule swap approval, coverage approval
**Steps to reproduce:** Two managers simultaneously approve the same swap request. Both reads see status='pending', both writes set it to 'approved' + reassign the shift. The second write wins. No corruption, but the audit log records two approvals for the same request.
**Recommended fix:** The `coverage.js` helpers already use `runTransaction` — same pattern should be applied to swap_request approval. Verify each multi-step state machine uses transactions.
**Files to change:** Audit `src/components/Schedule.jsx` swap approval handlers.
**Launch blocker:** No.

---

### 6.3 Operations module

`Operations.jsx` is 6,809 lines covering Inventory + Pricing + Checklists. The largest file in the codebase. Key findings:

---

#### [OPS-001] 19 onSnapshot subscriptions in Operations — cold mount payload is heavy

**Severity:** Medium (mobile perf)
**Area:** `src/components/Operations.jsx`
**Steps to reproduce:** Open Operations on mobile. Network tab: 19 Firestore Listen channels open simultaneously (inventory_{loc}, checklists_{loc}, vendor_prices/sysco, vendor_prices/usfoods, vendor_prices/costco, vendor_matches, vendor_categories, vendorCounts, last86 lists, etc.). For a single-tab use case, fine. For switching back to Operations during a busy shift, slow.
**Recommended fix:** Same as SCHED-001 — split into eager (inventory + checklists for current loc) vs lazy (pricing data only when Pricing tab is opened).
**Launch blocker:** No.

---

#### [OPS-002] CSV importer's column detector + fuzzy matcher have no test coverage

**Severity:** Medium (correctness regression risk)
**Area:** `src/components/VendorCsvImportModal.jsx`
**Steps to reproduce:** No existing test suite for `detectColumns` or `fuzzyMatchByName`. The bug Andrew flagged earlier (column detector picking "Item Status" when looking for "SUPC") got fixed but isn't pinned by a test. A future refactor could regress.
**Recommended fix:** Add `src/components/VendorCsvImportModal.test.js` with:
- Test that detectColumns prefers exact match over substring
- Test that fuzzyMatchByName's subset-bonus correctly matches "Soybean Oil" → "Kirkland Signature Soybean Oil, 35 lbs"
- Test that Sysco H/F/P CSV format parses correctly
**Launch blocker:** No.

---

#### [OPS-003] PricesFreshnessBanner reads three vendor docs every mount — could be one

**Severity:** Low (perf, minor)
**Area:** Operations.jsx PricesFreshnessBanner
**Steps to reproduce:** Open Operations → 3 separate subscriptions to vendor_prices/sysco, /usfoods, /costco.
**Recommended fix:** Store all 3 vendors under `vendor_prices/_all` as a single doc with a `vendors: { sysco: {...}, usfoods: {...}, costco: {...} }` map. One subscription, atomic updates.
**Launch blocker:** No (current shape works).

---

#### [OPS-004] Inventory count update is a read-modify-write without a transaction

**Severity:** Medium (data integrity)
**Area:** `src/components/Operations.jsx` inventory count handlers
**Steps to reproduce:** Two staff simultaneously +1 the same inventory item. Both read count=5, both write count=6. The second +1 is lost. (I didn't verify this is actually how the code works — needs deep-read confirmation.)
**Recommended fix (if confirmed):** Use `FieldValue.increment(1)` instead of read-then-set. Atomic at Firestore.
**Launch blocker:** Needs verification — flagged for Pass 4 / triage.

---

### 6.4 Onboarding module (PII)

The single highest-PII-concentration surface. Already flagged for major rework in SEC-004. Additional findings:

---

#### [ONB-001] Apply form resume upload bypasses size/type rule because of `/applications/*` rule + open catch-all

**Severity:** High (storage abuse)
**Area:** `storage.rules` + `OnboardingApply.jsx`
**Steps to reproduce:** Visit `/?apply=1`, submit application with a 50 MB executable named `resume.pdf`. The rule at `storage.rules:61` does cap at 10 MB + content-type — good. Confirmed by reading rules. Likely fine.
**Status:** Re-checked — the rule is in place. Not a bug. Listed for completeness.

---

#### [ONB-002] Onboarding template editor field positions stored as fractions — solid

**Status:** Reviewed. The fractional positioning (0–1 of page width/height) is the right pattern. No issue.

---

#### [ONB-003] Onboarding PDFs are downloaded via `getBytes()` (the documented-safe pattern)

**Status:** Reviewed and confirmed correct per the CLAUDE.md note about the firebasestorage.app bucket. No issue.

---

#### [ONB-004] OnboardingApply submission resets the form on success but the resume file blob stays in memory

**Severity:** Low (memory leak, very minor)
**Area:** `src/components/OnboardingApply.jsx`
**Recommended fix:** On submission success, clear file input state + revoke any blob URLs.
**Launch blocker:** No.

---

### 6.5 AdminPanel module

---

#### [ADM-001] Staff save read-modify-write race window

**Severity:** Medium (data loss)
**Area:** `src/components/AdminPanel.jsx:532`
**Steps to reproduce:**
1. Andrew on his laptop: edits Cash's PIN → tap Save
2. Julie on her laptop (within the same 200 ms): edits Tom's role → tap Save
3. Both writes do `getDoc(/config/staff)` → mutate the list array → `setDoc(/config/staff)`. The slower write overwrites the faster one's edit. One of the two changes is silently lost.
**Expected:** Concurrent edits don't clobber each other.
**Actual:** The staff doc is one giant `list` array; any save touches the whole array; concurrent saves race.
**Likely root cause:** Historical schema choice — staff list lives in one doc.
**Recommended fix (long-term):** Move each staff record to `/staff/{id}` (separate doc). The single-doc shape was historical convenience but is the source of multiple bug classes (the 2026-05-09 Import Master incident is referenced in firestore.rules). Until that migration:
**Short-term:** Use a transaction in `saveStaffToFirestore`:
```js
await runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, 'config', 'staff'));
    const list = (snap.data() || {}).list || [];
    // mutate list with the single record's changes
    tx.set(doc(db, 'config', 'staff'), { list, updatedAt: Date.now() });
});
```
Plus the existing PIN integrity gate.
**Files to change:** `src/components/AdminPanel.jsx` (the staff save handler around line 530)
**Launch blocker:** No (Andrew is single-saver in practice), Yes for SaaS.

---

#### [ADM-002] Bulk-tag operations don't show progress

**Severity:** Low UX
**Area:** AdminPanel bulk-tag UI
**Steps to reproduce:** Bulk-set 30 staff `preferredLanguage = 'es'`. The button click triggers ~30 individual updates with no progress indicator. UI feels frozen.
**Recommended fix:** Show "Updating 30 staff…" toast with a spinner; mark complete when done.
**Launch blocker:** No.

---

### 6.6 Training module

`TrainingHub.jsx` 874 lines. Quick review:

---

#### [TRAIN-001] YouTube video IDs hardcoded in MODULES — not configurable per-tenant

**Severity:** SaaS-blocker
**Area:** `src/data/training/*.js` (or wherever MODULES is defined)
**Recommended fix:** Move per-module video IDs into Firestore (`/orgs/{orgId}/training_config`) so each tenant brings their own videos.
**Launch blocker:** No for DD Mau, Yes for SaaS.

---

#### [TRAIN-002] Quiz completion writes are append-only — good

**Status:** Reviewed pattern. Audit-friendly. No issue.

---

#### [TRAIN-003] Quiz answers stored client-side until submit — refresh loses progress mid-quiz

**Severity:** Medium UX
**Area:** TrainingHub quiz state
**Steps to reproduce:** Start a quiz, answer 7 of 10 questions, accidentally refresh. All 7 answers lost.
**Recommended fix:** Persist partial answers to localStorage keyed by `quiz:${moduleId}:${userName}`. On mount, restore. On submit, clear.
**Launch blocker:** No (annoying), Medium for SaaS.

---

### 6.7 Eighty6 (86) module

---

#### [86-001] 86 alerts auto-post to chat — currently posts to LEGACY channels that we purged this session

**Severity:** Medium (silent failure)
**Area:** `src/data/eightySixChat.js:49`
**Steps to reproduce:**
1. Andrew toggled `AUTO_CHANNELS = []` earlier this session — the `foh` + `managers` channels are gone for DD Mau
2. 86 an item from the dashboard
3. `postEightySixToChat` writes to `channelDocId('foh')` = `channel_foh` which doesn't exist (or worse, has a tombstone in `/chats_purged`)
4. The auto-channel sync skips creating it (tombstone honored)
5. `addDoc` to `chats/channel_foh/messages` succeeds at the Firestore layer (Firestore auto-creates parent docs) BUT the parent chat doc has no members, so the message is invisible to everyone
6. FCM push still fires to `notifyRecipients` if the caller passed them
**Expected:** 86 alerts surface somewhere visible. Either: re-enable system channels, OR route alerts to a "Maryland FOH" / "Webster FOH" custom group that Andrew creates.
**Recommended fix (one of):**
- Re-enable the auto-channels (revert AUTO_CHANNELS = [])
- Update `postEightySixToChat` to target a configurable chat ID stored in `/config/eighty_six_targets`
- Add a no-channel-exists guard that falls back to FCM-only (skip the chat write)
**Files to change:** `src/data/eightySixChat.js`
**Launch blocker:** Yes (silent failure of an alerting channel is dangerous — staff might not realize 86 alerts aren't reaching them).

---

### 6.8 Maintenance module

`MaintenanceRequest.jsx` 235 lines, small.

---

#### [MAINT-001] Photo upload has no size cap — relies on Storage rule

**Severity:** Low
**Status:** Storage rules for maintenance photos fall through to the open catch-all. Same class as CHAT-001.
**Recommended fix:** Add `match /maintenance/{ticketId}/{fileName}` with 10 MB + image-only rule.
**Launch blocker:** No.

---

### 6.9 Catering, Insurance, AI Assistant (light pass)

These weren't deep-audited. Light findings only:

- **Catering** — Cloud Function emails customers? If so, needs SPF/DKIM hardening. (deferred)
- **Insurance** — Touches PII. Same security posture as Onboarding; flagged for SaaS-time rework.
- **AI Assistant** — Sends staff messages to a third-party LLM API. **NEEDS DATA-HANDLING REVIEW.** Defer.

---

### Module summary

| Module | Critical findings | High | Medium | Low | Status |
|--------|-------------------|------|--------|-----|--------|
| Chat | 0 | 1 (CHAT-001) | 4 | 3 | Good shape, fix CHAT-001 + CHAT-002 soon |
| Schedule | 0 | 0 | 4 | 1 | Solid, perf optimizations possible |
| Operations | 0 | 0 | 3 | 1 | Needs CSV importer tests + count race fix |
| Onboarding | 0 (SEC-004 covers PII) | 0 | 0 | 2 | Hardened; SEC-004 remains the big rock |
| Admin | 0 | 0 | 1 | 1 | Concurrent save race needs transaction |
| Training | 0 | 0 | 1 | 0 | Quiz state should persist |
| Eighty6 | 1 (86-001) | 0 | 0 | 0 | Silent-alert bug needs fix |
| Maintenance | 0 | 0 | 0 | 1 | Add storage rule |
| Catering | (not audited) | | | | Deferred |
| Insurance | (not audited) | | | | Deferred |
| AI Assistant | (not audited) | | | | **Needs separate data-handling review** |

---

## 7. Pass 3: UX, performance, i18n

### 7.1 Bundle / performance

Production bundle sizes (after current build):

| Chunk | Raw | Gzip | Notes |
|-------|-----|------|-------|
| vendor-firebase | 550 K | 132 K | Atomic — do not split (outage history) |
| pdf | 357 K | 107 K | Onboarding-only, lazy-loaded — fine |
| Operations | 271 K | 61 K | **Refactor target** — single 6809-line component |
| Schedule | 256 K | 65 K | **Refactor target** — single 9481-line component |
| index (entry) | 232 K | 59 K | Includes App.jsx + all eager modules — investigate |
| vendor-misc | 201 K | 124 K | Includes pdfjs/jszip/qrcode kept atomic per the chunking rules |
| training | 155 K | 54 K | Per-module fine |
| vendor-react | 140 K | 46 K | Atomic — fine |
| AdminPanel | 123 K | 31 K | Acceptable |

**Total cold-load for a non-admin staff member:** vendor-react + vendor-firebase + index + vendor-misc + AppShell ≈ ~1.1 MB raw / ~310 K gzip. **Acceptable** for kitchen WiFi, painful for cellular.

#### [PERF-001] Entry bundle is 232 K — likely contains eager modules that should lazy-load

**Severity:** Medium
**Area:** `vite.config.js` chunking + `src/App.jsx` imports
**Steps to reproduce:** Look at `dist/assets/index-*.js` and trace what's included. CLAUDE.md says eager imports are only `HomePage`, `InstallAppButton`, `AppVersion`, `AppToast`, AppShellV2 — but the 232 K size suggests something else got pulled in.
**Recommended fix:** Run `npx vite build --mode production --debug` and audit the entry bundle. Likely candidates: `messaging.js` (FCM), `staff.js` constants getting tree-shaken poorly, or one of the v2 shell imports pulling a heavy dep.
**Files to change:** `vite.config.js`, `src/App.jsx`
**Launch blocker:** No.

---

#### [PERF-002] Operations + Schedule each ~260 K — split by tab

**Severity:** Medium
**Area:** `src/components/Operations.jsx`, `src/components/Schedule.jsx`
**Recommended fix:** Split each by the existing tab structure:
- Operations → InventoryTab.jsx, PricingTab.jsx, ChecklistsTab.jsx
- Schedule → GridView.jsx, DayView.jsx, ListView.jsx, ScheduleEditor.jsx, AvailabilityEditor.jsx
Each becomes its own lazy chunk loaded on tab switch.
**Launch blocker:** No.

---

#### [PERF-003] `firebase` SDK version is ^10 — v11 ships ~15% smaller

**Severity:** Low
**Area:** `package.json:34`
**Recommended fix:** Upgrade to `^11.x`. Breaking changes are minor for our usage. Test locally first.
**Launch blocker:** No.

---

### 7.2 Mobile UX

Audited by scanning for known iOS-Safari foot-guns + tap-target patterns. (Real-device testing recommended for final sign-off.)

#### [MOB-001] `window.alert` and `window.confirm` used in 50+ places

**Severity:** Medium UX
**Area:** Whole codebase
**Why it matters:** Native iOS alerts are unstyled, cover keyboard, can break gesture flows, and feel out of place against the app's design language. They also serialize all execution — no async work can fire during the alert.
**Recommended fix:** Adopt the `toast()` helper (`src/toast.js`) for non-blocking notifications. For destructive confirms (delete chat, force-clock-out), use the existing "Are you sure?" promotion pattern (button-glows-red, "Tap again to confirm" — already used in Operations).
**Files affected:** Every component using `window.alert`/`window.confirm` — easy mechanical refactor.
**Launch blocker:** No, but the highest-leverage UX polish.

---

#### [MOB-002] Modals don't reserve safe-area-bottom on iPhones with home-indicator

**Severity:** Low UX
**Area:** Most modals (ChatSettingsModal, NewChatModal, OffsiteClockPrompt, etc.)
**Steps to reproduce:** Open ChatSettingsModal on an iPhone 14 Pro. The "Save" button at the bottom is too close to the home-indicator bar — tap target margin is ~4 px instead of ~16 px.
**Recommended fix:** Add `pb-safe` Tailwind class or `padding-bottom: env(safe-area-inset-bottom)` to bottom-sticky modal footers. Tailwind has `pb-safe` via `[paddingBottom:env(safe-area-inset-bottom)]` — wire it through.
**Files affected:** ~10 modals. Add a `<SafeModalFooter>` wrapper component.
**Launch blocker:** No.

---

#### [MOB-003] Some inputs don't have `inputMode` set — wrong on-screen keyboard

**Severity:** Low UX
**Area:** Multiple forms
**Steps to reproduce:** Tap an input expecting a number (e.g. inventory count, PIN, phone number) — iOS shows the full QWERTY keyboard instead of numeric.
**Recommended fix:** Add `inputMode="numeric"` or `inputMode="tel"` or `inputMode="email"` to every input where the value is constrained. The PIN screen already does this (verify); inventory + onboarding likely don't.
**Launch blocker:** No.

---

#### [MOB-004] `position: fixed` modals + iOS keyboard = content can be hidden behind keyboard

**Severity:** Low-Medium UX
**Area:** Modal patterns
**Steps to reproduce:** On iPhone, open NewChatModal → tap the group-name input → keyboard slides up → the "Create" button at the bottom is now behind the keyboard with no scroll affordance.
**Recommended fix:** Use `max-h-[90vh] overflow-y-auto` (already used in some modals — needs to be universal) + listen for `window.visualViewport.resize` to scroll the focused input into view.
**Launch blocker:** No (workaround exists: user can dismiss the keyboard).

---

### 7.3 i18n (English / Spanish)

#### [I18N-001] CateringOrder.jsx + InsuranceEnrollment.jsx have hardcoded English in HTML email/print templates

**Severity:** Low (these are emailed receipts; SaaS-deferred)
**Area:** `src/components/CateringOrder.jsx`, `src/components/InsuranceEnrollment.jsx`
**Steps to reproduce:** Print a catering invoice or insurance enrollment — entirely English text inside the print template (e.g. "Event Details", "Special Notes", "Tax", "Taken by:").
**Recommended fix:** Move the HTML templates to use `tx(en, es)` strings. For multi-tenant SaaS, the template language becomes a per-tenant config.
**Files to change:** CateringOrder.jsx (lines 685+), InsuranceEnrollment.jsx (lines 296+)
**Launch blocker:** No.

---

#### [I18N-002] `<option value="maryland">Maryland Heights</option>` — hardcoded location labels

**Severity:** Medium (SaaS-blocker)
**Area:** AdminPanel.jsx, ImportStaffModal.jsx
**Recommended fix:** Locations should be loaded from `/orgs/{orgId}/locations`, with labels per locale.
**Launch blocker:** No for DD Mau, Yes for SaaS.

---

#### [I18N-003] Spanish safety/allergen content needs a native-speaker review

**Severity:** High (legal liability)
**Area:** Training MODULE M17 (allergen matrix) + any food-safety content
**Why it matters:** Allergen warnings translated by an LLM (or by a non-native engineer) can mistranslate critical terms. "Tree nuts" vs "frutos secos" vs "nueces" — wrong word means a customer dies.
**Recommended fix:** Have a native-Spanish-speaking restaurant ops person sign off on every safety/allergen/health-code translation. Track sign-offs in `/translations_review/{en_es}.status`.
**Files to change:** No code change — a process / sign-off requirement.
**Launch blocker:** Yes if Spanish-only staff are doing safety training without a sign-off.

---

#### [I18N-004] Some `tx(en, es)` calls pass JSX as the value — fragile

**Severity:** Low
**Area:** `OffsiteClockPrompt.jsx` and a few others
**Steps to reproduce:** Search for `tx(<>...JSX...</>, <>...JSX...</>)` — the helper expects strings. Works because React renders fragments inline but breaks if someone refactors `tx()` to use a string interpolator.
**Recommended fix:** Refactor those cases to render the JSX inline using `isEs ? (...) : (...)` ternaries rather than going through `tx()`.
**Launch blocker:** No.

---

## 8. Quick wins (≤15 min each — additions from Pass 2/3)

Combined list (Pass 1 + 2 + 3):

| # | Fix | Effort | Files |
|---|-----|--------|-------|
| QW-01 | ✅ Already done in vite.config.js (drops log/info/debug/trace) | — | — |
| QW-02 | ✅ Shipped (SEC-005) | — | — |
| QW-03 | ✅ Shipped (SEC-002) | — | — |
| QW-04 | ✅ Shipped (SEC-007) | — | — |
| QW-05 | Replace catch-all firestore.rules with explicit per-collection allowlist | 15 min | `firestore.rules` |
| QW-06 | Add CHAT-001 storage rule for `/chats/*` | 5 min | `storage.rules` |
| QW-07 | Add MAINT-001 storage rule for `/maintenance/*` | 5 min | `storage.rules` |
| QW-08 | Debounce CHAT-002 `lastReadByName` writes (1.5 sec) | 10 min | `ChatThread.jsx` |
| QW-09 | Add `inputMode` attributes to numeric inputs across forms | 15 min | Multiple |
| QW-10 | Add `pb-safe` to bottom-sticky modal footers | 10 min | Modals |
| QW-11 | Fix Eighty6 86-001 (silent-alert bug) — re-enable system channels OR config-based targeting | 15 min | `eightySixChat.js` |
| QW-12 | Persist quiz state to localStorage during training (TRAIN-003) | 15 min | `TrainingHub.jsx` |
| QW-13 | Add tests for CSV importer fuzzyMatch + detectColumns (OPS-002) | 30 min | new test file |
| QW-14 | Switch inventory count to `FieldValue.increment(1)` (OPS-004 — if confirmed) | 10 min | `Operations.jsx` |

---

## 9. Deep refactor recommendations (post-launch)

These are bigger pieces of work that pay off when SaaS migration begins. Ranked by leverage:

1. **Wire Firebase Auth + custom claims + org isolation.** Single biggest unlock for SaaS. ~2 weeks.
2. **Split Operations.jsx + Schedule.jsx + AdminPanel.jsx by tab/section.** ~3 days per file.
3. **Move `/config/staff` from one giant `list` array to per-staff `/staff/{id}` docs.** Eliminates ADM-001, allows partial updates, enables collection-group queries. ~2 days + a migration script.
4. **Server-side notification fan-out (CHAT-003 + sendShiftReminders + others) via Firestore-trigger Cloud Functions.** Removes client-side N-write fan-out, allows reliable delivery even when sender closes the app. ~3 days.
5. **Adopt a structured logging library (Sentry or custom).** Drop ad-hoc `console.warn`. ~2 days.
6. **Multi-timezone date handling (SCHED-003 generalized).** Single `dates.js` helper using `Intl.DateTimeFormat` + org-configured timezone. ~3 days.

---

## 10. Performance improvement plan

### Frontend
- Lazy-load Operations/Schedule sub-tabs (PERF-002) — biggest single win
- Debounce localStorage cache writes in Schedule (SCHED-002)
- Debounce `lastReadByName` writes in Chat (CHAT-002)
- Audit the 232 K index bundle for accidental eager imports (PERF-001)
- Upgrade Firebase SDK to v11 (PERF-003)

### Backend
- Migrate notification fan-out to Cloud Functions (CHAT-003)
- Add a `purgeOldDeletedMessages` scheduled function (CHAT-005)
- Add a `purgeOldRateLimits` scheduled function (to GC the new `/rate_limits` collection)

### Database
- Index review: confirm that every `where + orderBy` query has a composite index. Run Firebase Console → Firestore → Indexes → look for "missing index" warnings.
- Don't shard inventory/labor/orders/checklists by location forever — that pattern doesn't scale to >10 locations. Move to a single collection with a `locationId` field + composite index.

### Files / images / video
- Add storage rule caps for chat (CHAT-001) + maintenance (MAINT-001)
- Use `uploadBytesResumable` for visible progress (CHAT-004)
- Generate video thumbnails server-side (currently TODO in chat schema comments)

### Caching
- Stop writing the localStorage cache on every Schedule snapshot tick (SCHED-002)
- Use ETags / `If-Modified-Since` for static training videos (out-of-band — YouTube handles this)

---

## 11. Security improvement plan

### Permissions (in order)
1. **Phase 1 — narrow rules without Auth:**
   - Replace `match /{document=**} { allow read, write: if true; }` with explicit per-collection rules (QW-05)
   - Add `/chats/*` + `/maintenance/*` Storage rules (CHAT-001, MAINT-001)
2. **Phase 2 — wire Firebase Auth (email magic-link is the easiest):**
   - Sign every staff in. PIN screen becomes a "remember me on this device" speed bump.
   - Set custom claims `{ orgId, role, location, can_view_onboarding }`
   - Rewrite rules: `allow read: if request.auth.token.orgId == ...`
3. **Phase 3 — enforce App Check** (SEC-006)
4. **Phase 4 — pen test by an external party** before SaaS GA

### Sensitive data
- Move `/onboarding_invites` validation behind a callable function (SEC-004)
- Hash PINs OR retire PINs entirely once Auth lands (SEC-003)
- Audit every `console.warn`/`error` call to redact staff PII (SEC-011 follow-up)

### Audit logs
- Audit log now hardened (SEC-005 — shipped)
- Add a "queued audit" retry mechanism so failed writes don't drop on the floor (ARCH-004)

### Vendor credentials
- Scraper credentials live on Railway (not in this repo) per CLAUDE.md — confirmed not exposed in client. Good.

### File uploads
- Cap chat uploads at 50 MB (CHAT-001)
- Cap maintenance photos at 10 MB (MAINT-001)
- Content-type allowlist on every upload path

---

## 12. QA test plan (manual checklist)

This is the test plan to run before each significant deploy. Times are wall-clock for a single tester.

### Page-by-page smoke test (~15 min)
- [ ] Lock screen — enter wrong PIN 3 times → lockout message; enter right PIN → home
- [ ] Home — every tab in the sidebar/bottom-nav opens without spinner-of-death
- [ ] Chat — send text, send photo, send voice; tap Translate on a Spanish message; pin a message
- [ ] Schedule — open this week + next week; create a shift; request coverage; approve coverage
- [ ] Operations — Inventory tab loads; Pricing tab loads; freshness banner renders; CSV import succeeds
- [ ] Onboarding (admin) — open a hire; download a doc; approve a hire
- [ ] Apply form (`/?apply=1`) — submit successfully
- [ ] Onboarding portal (`/?onboard=TOKEN`) — load with valid token; "invite expired" with stale token
- [ ] Training — open a module; mark a lesson complete; take a quiz
- [ ] Eighty6 — flip an item; verify the chat alert renders
- [ ] Maintenance — submit a ticket with a photo
- [ ] Catering — open an order; print invoice
- [ ] AdminPanel — every section expands without console errors
- [ ] Logout — clears state; back to PIN screen

### Role-based permission tests (~10 min)
- [ ] Sign in as a staff member (not admin, not manager)
  - [ ] Admin tab is hidden in nav
  - [ ] Cannot delete chat messages in #managers
  - [ ] Cannot edit schedule
  - [ ] Cannot view onboarding
- [ ] Sign in as a manager (not admin)
  - [ ] Can post announcements
  - [ ] Can approve coverage requests
  - [ ] Can view labor dashboard
  - [ ] Cannot access AdminPanel
- [ ] Sign in as admin
  - [ ] Everything above PLUS AdminPanel
- [ ] Sign in as cross-location manager (location='webster')
  - [ ] Cannot moderate /maryland channel
  - [ ] Sees only Webster staff in NewChatModal

### Mobile / tablet checklist (~15 min)
- [ ] iPhone 12+ Safari: PIN entry, send chat message, take photo for issue
- [ ] iPhone safe-area: every modal footer has space above the home-indicator
- [ ] iPhone keyboard: NewChatModal "Create" button reachable when input is focused
- [ ] iPad Safari: schedule grid renders without overlap
- [ ] Pull-to-refresh: drag from top of any page → refreshes

### Regression checklist (~5 min)
- [ ] 162 tests pass: `npx vitest run`
- [ ] Production build clean: `npm run build`
- [ ] Lighthouse score ≥ 70 perf on `/` (run in incognito on mobile profile)
- [ ] No console errors during 1-minute use of any tab

---

## 13. Launch readiness checklist

### For DD Mau internal use (today)
- [x] SEC-002 shipped
- [x] SEC-005 shipped
- [x] SEC-007 shipped
- [ ] Deploy `firestore:rules` + `functions:translateMessage` (waiting on Andrew)
- [ ] Fix 86-001 (silent-alert bug — Andrew should pick: re-enable system channels OR configure new targets)
- [ ] Run manual smoke test from section 12
- [ ] Confirm with staff that voice messages work on iPhone (CHAT-004 if not)
- [ ] Confirm offsite clock-in prompts cleanly cycle (we fixed the snooze bug)

### For SaaS launch (months from now)
- [ ] SEC-001 — narrow rules (Phase 1 + Phase 2)
- [ ] SEC-003 — hash PINs or kill PINs
- [ ] SEC-004 — onboarding token server-side
- [ ] SEC-006 — App Check enforced
- [ ] SEC-008 — apply form rate-limited
- [ ] SEC-009 — CSP headers
- [ ] ARCH-001 — remove hardcoded `[40, 41]`
- [ ] ARCH-002 — locations from data, not code
- [ ] ARCH-007 — CI gate on tests
- [ ] I18N-002 — locations from data
- [ ] I18N-003 — native-speaker sign-off on safety content
- [ ] AI Assistant data-handling review
- [ ] External pen test
- [ ] Privacy policy + ToS
- [ ] DPA (Data Processing Agreement) template for customers
- [ ] Billing infrastructure (Stripe + per-org plan limits)

---

## 14. Final auditor verdict

**For internal DD Mau use:** The app is **functionally ready**. Apply the 3 launch-blocker fixes I shipped today, fix 86-001 (silent alert), do the manual smoke test, and you're good. The structural issues (no auth, open rules) are acceptable risks for a small in-restaurant deployment by a single owner-admin.

**For SaaS:** **Not ready.** The biggest items are foundational: no auth, open rules, plaintext PINs. Estimate **6–10 weeks of focused work** to be SaaS-ready, plus an external pen test and a privacy/legal review.

**Most impressive aspects:**
- The defense-in-depth comments throughout the code — explains the WHY of every gnarly decision
- Audit-log discipline (most state changes are recorded)
- 162-test suite is a great foundation
- The recent translation feature is well-architected (cache-first, deduped, language-aware)
- iOS-specific fixes are well-documented

**Most concerning aspects:**
- Open Firestore + Storage rules
- Plaintext PINs world-readable
- Client-side-only token validation for PII access
- AI Assistant (not audited) sending staff data to an LLM provider

---

*End of audit v1. Living document — append findings as new code lands.*
*Audited by: Claude (senior engineering review) — 2026-05-17*

---

*This is a living document. Each pass appends findings. Updated `2026-05-17`.*
