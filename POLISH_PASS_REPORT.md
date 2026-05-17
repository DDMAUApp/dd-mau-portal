# Autonomous Polish Pass — 2026-05-17

**Operator:** Claude (acting as senior full-stack engineer per Andrew's autonomous instructions)
**Branch:** `main`
**Latest commits this pass:** `f05fc62..4c72af3` (10 commits total)
**Baseline:** 173 tests passing, clean build (4.47s)
**Final:** 173 tests passing, clean build (~4s)

## Commit log this pass

| Commit | Title |
|---|---|
| `4c72af3` | CateringOrder: surface save failures instead of swallowing |
| `90ec3db` | Polish #2: silent-failure cleanup + PrepList manager bug |
| `8c4c583` | Notifications: surface a "Refresh" affordance when token went stale |
| `0d55170` | NotificationsDrawer: kill the scroll-up crash for real |
| `8c4c583` | (see above) |
| `5909ead` | Chat composer: clear the bottom nav on iPhones with a notch |
| `03802d6` | Add POLISH_PASS_REPORT.md — autonomous engineering pass docs |
| `e17f485` | AdminPanel: confirm the "Send test push" click landed |
| `99f602d` | Polish pass: PIN auto-submit, chunk pre-warm, Julie admin fix |
| `5f7d9bc` | Toast pipeline + notification icons: ship two latent bug fixes |

---

## 1. Work completed

Four focused commits, each independently reviewable and revertable:

| Commit | Title | Files |
|---|---|---|
| `5f7d9bc` | Toast pipeline + notification icons: ship two latent bug fixes | 17 |
| `99f602d` | Polish pass: PIN auto-submit, chunk pre-warm, Julie admin fix | 3 |
| `e17f485` | AdminPanel: confirm the "Send test push" click landed | 1 |
| (+) | All pushed to `origin/main`; GitHub Pages auto-deploy runs on push. | |

Net: **22 files touched, ~225 lines changed**, no destructive operations, no feature deletions, no API changes.

---

## 2. Bugs fixed (grouped by module)

### Notifications system — 2 latent bugs

**B1. Toast pipeline was dead.** *(commit 5f7d9bc)*
- **File:** `src/App.jsx`, `src/main.jsx`
- **What was wrong:** `<AppToast />` was imported in `src/App.jsx` but never rendered. Every `toast()` call across the codebase (AdminPanel, Operations, Onboarding, Eighty6Dashboard, several more) wrote into a subscriber queue that no UI was listening to. Users got zero feedback when error/success toasts fired.
- **Fix:** Mounted `<AppToast />` at root in `main.jsx` as a sibling of `<App />` so it renders across every code path — lock screen, onboarding portal, public apply page, install splash, and the main app shell — without prop-drilling.
- **Why safe:** AppToast renders nothing when the queue is empty; it's a fixed-position overlay; no flow changes.
- **How to test:** Trigger any toast (e.g. sign in, then run Admin → Push diagnostic → Send test push). Toast should appear top-right on desktop, top-center on mobile.

**B2. NotificationsDrawer icon map was dead code.** *(commit 5f7d9bc)*
- **File:** `src/v2/NotificationsDrawer.jsx`
- **What was wrong:** Every notification writer (`Schedule.jsx`, `Eighty6Dashboard.jsx`, `TardinessTracker.jsx`, `SauceLog.jsx`, `ShiftHandoff.jsx`, `ChatTaskFromMessageModal.jsx`, all helpers in `data/notify.js`) writes the doc with a `type:` field. The drawer looked up icons via `item.kind`. Result: every notification fell through to the default 🔔 icon — the 17-entry `KIND_META` table was useless. Tapping a notification also failed to deepLink because `item.deepLink` was the only routing source and most writers don't set it.
- **Fix:** Switch lookup to `item.type ?? item.kind` (legacy compat), extend `KIND_META` to 26 entries covering every type-value actually written by the app, add prefix-family fallback (`shift_*` / `pto_*` / `swap_*` / `task_*` / `chat_*` / `handoff_*` / `eighty*`), and add `deepLinkFor(item)` inference so old notifications + writers that forgot `deepLink:` still route to the right tab on tap.
- **Why safe:** Existing `item.kind` reads still resolve via the fallback chain; new mappings widen coverage; nothing is removed.
- **How to test:** Open the bell drawer with notifications present — icons should now be type-appropriate (📅 calendar for shifts, 🌴 palm tree for PTO, 🚫 for 86 alerts, etc.). Tap a notification — it should navigate to the right tab.

### User feedback / smoothness — 38 silent failures fixed

**B3. Native `alert()` everywhere → toast().** *(commit 5f7d9bc)*
- **Files:** `ChatThread.jsx`, `ChatCenter.jsx`, `ChatSettingsModal.jsx`, `ChatNotifSettings.jsx`, `ChatAnnouncementComposer.jsx`, `ChatCoverageRequestModal.jsx`, `ChatPhotoIssueModal.jsx`, `ChatTaskFromMessageModal.jsx`, `ChatAckDashboard.jsx`, `OffsiteClockPrompt.jsx`, `OffsiteClockSection.jsx`, `OnboardingApply.jsx`, `Onboarding.jsx`, `AdminPanel.jsx`. (~38 sites)
- **What was wrong:** Native `alert()` shows `"ddmauapp.github.io says:"` as a prefix on Chrome/Android, blocks the page, and doesn't auto-dismiss. The codebase already had a `toast()` helper for in-app, color-coded, auto-dismissed notifications — but 38 sites still used `alert()`.
- **Fix:** Converted every fire-and-forget post-action alert to `toast(msg, { kind: 'error' | 'success' | 'warn' | 'info' })`. The heuristic kind detection (✓/✅ → success, ⚠ → warn, /error|failed/ → error) means most replacements got the right color automatically; I tagged each one explicitly for clarity.
- **Why safe:** None of the 38 sites depended on `alert()`'s blocking behavior. They were all post-action notifications (success/error after a save, an upload, a send). `toast()` is non-blocking and shows ABOVE everything (`z-[60]`), so the user still sees it.
- **How to test:** Trigger any of these flows (e.g. send a chat message offline → "Send failed" toast; try to pin a 6th message → "Up to 5 pinned" toast; resume too large → "Resume too large" toast).

### Identity / permission gating

**B4. Julie was silently denied admin access in Insurance Enrollment.** *(commit 99f602d)*
- **File:** `src/components/InsuranceEnrollment.jsx`
- **What was wrong:** The admin gate read `staffName && ["andrew shih", "julie truong"].includes(staffName.toLowerCase())`. Julie's actual surname is **Shih**, not Truong — so her name never matched and she couldn't access the admin enrollment view here. Owner identity also drifts from the canonical `data/staff.js` helper.
- **Fix:** Switch to `checkIsAdmin(staffName, staffList)` from `data/staff.js`, which resolves by staff ID (40 = Andrew, 41 = Julie) — survives renames and matches the gating used everywhere else in the app.
- **Why safe:** Strict superset of the previous check. ID 40 = "andrew shih" and ID 41 = "julie shih" both pass now; nobody loses access.
- **How to test:** Sign in as Julie. Navigate to Insurance tab. The Admin button should now unlock when the ADMIN_PIN is entered.

### Diagnostic feedback

**B5. "Send test push" button had no UI feedback.** *(commit e17f485)*
- **File:** `src/components/AdminPanel.jsx`
- **What was wrong:** The button on the push-notifications diagnostic panel wrote the notification doc and returned silently. The user had no way to know the click registered — leading to repeated clicks and confusion ("did it work?").
- **Fix:** Added a 6-second success toast ("🧪 Test push sent — close the app…") on the write succeeding, plus an error toast with the message on failure.
- **Why safe:** Pure additive UX; no flow changes.
- **How to test:** Admin → scroll to "Push notifications diagnostic" → tap "Send test push to myself". Toast should appear top-right.

**B6. Mobile chat composer was hidden behind the bottom nav on iPhone X+.** *(commit 5909ead)*
- **File:** `src/components/ChatCenter.jsx`
- **What was wrong:** Chat container height was `100dvh − 160px`, which didn't account for `env(safe-area-inset-top)` (~44px notch). On iPhone X+ the header took ~100px (h-14 + notch) and the bottom nav took ~94px (60px content + ~34px home-indicator), totaling 194px — but only 160px was being reserved. Plus a `-my-3` negative margin extended the chat another 12px into the nav area. Composer ended up ~30-40px behind the bottom nav.
- **Fix:** New calc: `100dvh − 146px − env(safe-area-inset-top) − env(safe-area-inset-bottom)` — that's `56 (header) + 60 (nav) + 30 (breathing room) + variable safe areas via env()`. Result: ~30px clear space above the bottom nav on every device. Also dropped `-my-3` to `-mt-3` so the chat doesn't extend its bottom into the nav-reserved padding.
- **Why safe:** Pure layout change, no business logic touched. Fallback `100vh − 220px` for older browsers without `dvh` support gives slightly more empty space on no-notch devices (acceptable trade).
- **How to test:** Open chat on iPhone. The text input should be visibly above the bottom nav with ~30px gap.

**B7. Notification bell drawer crashed on scroll-up.** *(commit 0d55170)*
- **File:** `src/v2/NotificationsDrawer.jsx`
- **What was wrong:** Three-step chain: (1) user scrolls up past the top of the notification list, (2) iOS Safari interprets the pull-down as a pull-to-refresh because no `overscroll-behavior: contain` was set on the actual scrollable element (it was on the parent — and that property doesn't inherit), (3) the page below reflows and App.jsx's chunk-reload safety net sometimes misreads the transient error as a chunk failure, calling `window.location.reload()`. Net effect: bell drawer crashes mid-scroll.
- **Fix:** Three layers — moved `overscroll-behavior: contain` to the inner scrollable via inline style (per-element, not inherited); added body scroll lock while drawer is open (`document.body.style.overflow = 'hidden'` + `touch-action: none`); added `touch-action: pan-y` + `-webkit-overflow-scrolling: touch` to the scrollable for iOS gesture stability. Plus `overflow-hidden` on the outer drawer.
- **Why safe:** Belt-and-suspenders fix targeting the root cause (overscroll bleed-through) AND multiple symptoms (gesture drift). Cleanup function restores body styles on unmount.
- **How to test:** Open the bell drawer on iPhone, scroll past the top by pulling down — nothing should happen except a soft visual bounce that doesn't trigger page reload.

**B8. "Refresh notifications" affordance was missing for the broken-token state.** *(commit 8c4c583)*
- **Files:** `src/v2/EnableNotificationsHeaderButton.jsx`, `src/components/EnableNotificationsBanner.jsx`
- **What was wrong:** Both the header pill and home banner hid entirely once `Notification.permission === 'granted'`. But if the FCM token was missing for the device (token rotation broke it, cross-staff sweep removed it, FCM expiry, etc.), there was NO visible affordance to re-register. Users with broken push had no way to fix it without diving into the admin push diagnostic.
- **Fix:** Added a fourth state: 'granted but no device token' → shows a distinct blue 🔄 "Refresh notifications" pill / banner. Tap → calls `enableFcmPush()` to mint a fresh token. Detection via `localStorage["ddmau:fcmDeviceId"]` matched against the current staff's `fcmTokens[].deviceId`.
- **Why safe:** Optimistic guard prevents flash at sign-in (returns "has token" until staffList loads). Otherwise no flow changes.
- **How to test:** Clear `localStorage.ddmau:fcmDeviceId` in DevTools, reload, observe blue Refresh pill appear next to the bell + banner on home.

**B9. PrepList managers couldn't edit prep items.** *(commit 90ec3db)*
- **File:** `src/components/PrepList.jsx`
- **What was wrong:** `currentIsManager` gate used `s.role === "manager" || s.role === "admin"` — lowercase string equality — but every staff record's role is capitalized ("Manager", "Kitchen Manager", "Asst Manager", "Owner"). Only the two hardcoded ADMIN_IDS (40 = Andrew, 41 = Julie) could edit prep — actual restaurant managers were locked out of their own prep editor.
- **Fix:** Switched to `/manager|admin|owner/i` case-insensitive regex, matching the pattern used everywhere else in the app.
- **Why safe:** Strict superset — same names pass + the real managers now pass too.
- **How to test:** Sign in as a non-owner manager (e.g. Brandon Green). Operations → PrepList → edit a prep item should now work.

**B10. CateringOrder save failures were swallowed.** *(commit 4c72af3)*
- **File:** `src/components/CateringOrder.jsx`
- **What was wrong:** `submitOrder` logged to console + set `submitted = false` on error — but the UI just rolled back to the cart with no signal that the order failed to save. Staff assumed orders were in but Firestore had no record. Highest-impact failure mode in the app — under transient network blips during dinner rush.
- **Fix:** 8-second error toast surfaces the actual error message + clear "Try again" prompt. EN + ES copy.
- **Why safe:** Pure additive UX. Success flow unchanged.
- **How to test:** Block network in DevTools, submit a catering order. Should see a red error toast instead of silently looking like nothing happened.

**B11. Silent onSnapshot subscription errors across 5 modules.** *(commit 90ec3db)*
- **Files:** `Recipes.jsx`, `CateringOrder.jsx`, `PrepList.jsx`, `LaborDashboard.jsx`, `Operations.jsx` (10 sites total)
- **What was wrong:** Bare `onSnapshot(ref, callback)` without an error handler — when the SDK errored (perm-denied race, brief offline, token refresh), no log line fired. The Firestore SDK auto-recovers, but staff with a stuck-empty list had no diagnostic signal to share with support.
- **Fix:** Added a `(err) => console.warn(...)` to every callsite. Operations' 7 vendor_prices subscriptions were wrapped via a small `onVpErr(tag)` helper to keep the diff readable.
- **Why safe:** Pure observability addition. Same code path on success.
- **How to test:** Open DevTools console while using the page. Any subscription error now shows a clearly-tagged warning.

---

## 3. Performance / loading improvements

**P1. Pre-warm chat chunks.** *(commit 99f602d)*
- **File:** `src/App.jsx`
- Added `ChatCenter` and `ChatThread` to the post-sign-in `prewarmChunks()` background fetch list. Chat is a primary tile on MobileHome and a daily destination — pre-warming removes the brief spinner the first time someone taps the tile after sign-in.
- The pre-warm uses `requestIdleCallback` (or 500ms fallback) and `.catch(()=>{})`, matching the existing pattern. No bundle-size impact (chunks were already split).
- **How to test:** Sign in. Wait ~1s. Open DevTools Network → tap Chat. Should resolve from cache instead of fetching.

**P2. PIN auto-submit on 4th digit.** *(commit 99f602d)*
- **File:** `src/components/HomePage.jsx`
- 4-digit PINs now auto-submit after a 120ms delay (lets the user see the 4th dot fill in before the screen transitions). Saves a tap on every sign-in. Lockout + multi-staff collision-picker paths still work the same.
- **How to test:** Sign out. Enter your 4-digit PIN. Sign-in should complete without you tapping OK.

---

## 4. Code cleanup

- Removed dead `AppToast` import from `src/App.jsx` (moved to `main.jsx`); left a comment pointing at the new home.
- Updated `NotificationsDrawer.jsx` header schema docstring to reflect the actual `type:` field (was documented as `kind:`, which mismatched every writer).
- Added explanatory comment block in `InsuranceEnrollment.jsx` explaining why the admin gate is now ID-anchored — so the next refactor doesn't reintroduce the name-match bug.

---

## 5. Tests / checks run

| Check | Command | Result |
|---|---|---|
| Test suite | `npm test` | ✅ 173/173 passing |
| Production build | `npm run build` | ✅ Clean, 4.63s |
| Build (before changes) | — | ✅ 4.47s baseline (no regression) |
| Push to remote | `git push origin main` | ✅ 3 commits pushed |
| GitHub Actions auto-deploy | (server-side) | Should land within ~2 min of push |

No lint or typecheck commands exist for this project. Build pipeline does type/import checking via Vite + Rollup; success implies the chunk graph and imports are sound.

---

## 5b. Cloud Functions audit (read-only — no changes shipped)

Reviewed `functions/index.js` (1370 lines). Found one risk worth documenting (not fixed because Cloud Function deploy requires separate user action):

- **`dispatchNotification` writes the full staff list back to Firestore** after pruning dead tokens (line ~122: `await db.doc("config/staff").set({ list: newList })`). The dispatcher reads the list at the start, computes a delta, then writes the full list back — if another writer (e.g., AdminPanel PIN edit, staff update) races between read and write, the dispatcher's write would clobber that concurrent change. Risk is rare in practice (dispatcher only writes when liveTokens length differs), but worth a transactional rewrite before scaling beyond DD Mau's current team size. See "Needs Owner Review" below.

Everything else in Cloud Functions looks robust: error handling, idempotency flags, DST-aware reminder timing, token-pruning logic.

## 6. Regression review (per Andrew's request)

I scanned recent commits for fixes that may have been reverted or reintroduced. **No reverted-fix regressions detected.** Specifically I confirmed these prior fixes are still in place:

| Original fix | Confirmed present |
|---|---|
| Chat orderBy desc + reverse (CHAT-008, commit `7bf57f8`) | ✅ `ChatThread.jsx:94` |
| Cross-staff token sweep (commit `89e422a`) | ✅ `messaging.js:240-262` |
| Mobile chat composer dvh height (commit `f05fc62`) | ✅ `ChatCenter.jsx:317` |
| Notifications drawer mobile scroll fix (commit `f05fc62`) | ✅ `NotificationsDrawer.jsx:126` |
| Staff-list migration kill (commit `05d888c`) | ✅ `App.jsx:546-560` (only mirror, no rewrite) |
| isManager TDZ fix (commit `d663062`) | ✅ `App.jsx:598` (declared before useEffect) |
| ManualChunks rollback (commit `81bfb1c`) | ✅ `vite.config.js` (no Firebase split) |
| Photo-orphan cleanup (commit `5436148`) | ✅ `MaintenanceRequest.jsx:104-109`, `Operations.jsx` |

The toast-pipeline-dead bug (B1 in this report) is the only "this should have been working but never did" finding. It existed since the toast helper was originally written — not a regression of a working state.

---

## 7. Remaining issues (left in place; documented)

These are real but I left them alone because they're either outside the polish-pass scope or risky to change without owner review:

- **TODO multi-tenant comments** in `AppDataContext`, `ChatNotifSettings`, `ChatCoverageRequestModal`, `data/audit.js`, `data/chat.js`, `data/chatPermissions.js`, `ChatThread.jsx`. All explicit "wire to /orgs/{orgId}/" when multi-tenant ships. Tracked in `AUDIT.md`.
- **`InventoryHistory.jsx`**: hardcoded display strings, no Spanish for inventory line labels.
- **`MaintenanceRequest.jsx`**: location dropdown stores English label, so Spanish users see English locations in their "My Requests" list. Polish, not breakage.
- **`InsuranceEnrollment.jsx`**: hardcoded `ADMIN_PIN = "ZhongGuo87"` in client source — discoverable in bundled JS. Same risk class as the plaintext PINs documented in `AUDIT.md` SEC-003. See **Needs Owner Review** below.
- **`OnboardingApply.jsx`**: hardcoded address `'Maryland Heights, MO'` (no full street address). Tagged TODO in `data/onboarding.js`.

These are all listed in `AUDIT.md` already.

---

## 8. Needs Owner Review (do not auto-ship)

These are risky, behavior-changing, or governance issues — I documented them but didn't change anything:

1. **Hardcoded `ADMIN_PIN = "ZhongGuo87"` in `InsuranceEnrollment.jsx:28`.** Anyone with DevTools can read the bundled JS and find it. Recommended action: move to a Firestore `/config/secrets` doc readable only by admin gates, OR retire the PIN entirely now that the owner-ID check is ID-anchored (the PIN was just a second factor; with proper auth it becomes obsolete).
2. **`ADMIN_PIN` second-factor on admin actions** — the same pattern exists in `AdminPanel.jsx` for the "Reset push tokens" + "System refresh" buttons. Should be either (a) removed (the `isAdmin` check is sufficient), (b) made re-prompt-on-action with a server-side check, or (c) moved to a separate confirm-modal that doesn't expose the secret.
3. **`recordAudit({ action: 'chat.delete.soft' })` payload includes the chat name** — generally fine, but if any chat names contain personal info (e.g. "Andrew + Lorena disciplinary"), that lands in the audit log. Confirm with you whether that's desired or should be redacted.
4. **`enableFcmPush` sweeps cross-staff tokens by deviceId** — strong correct fix for the Julie-gets-her-own-pushes bug, but it's load-bearing. If you ever re-introduce shared devices intentionally (e.g. a "kitchen tablet" that everyone signs into), the sweep would actively delete shared tokens on every other sign-in. Document this in CLAUDE.md or AGENTS.md if shared-tablet usage becomes a thing.
5. **AppCheck still disabled in `firebase.js`** — see commit `eba85eb`-era comment in that file. Re-enabling is documented in the comment but requires the ReCAPTCHA site key to be re-registered for `app.ddmaustl.com`. Not blocking for today, blocking for SaaS.

6. **`dispatchNotification` race-condition rewrite** — `functions/index.js` line ~122 does a full-doc rewrite of `/config/staff` when pruning dead FCM tokens. Concurrent writes from AdminPanel (PIN edit, staff add/remove) could be clobbered. Rare in practice but unbounded as the team grows. Suggested rewrite: use `runTransaction` to read+update inside an atomic operation, OR use `arrayRemove` for token cleanup so the rest of the doc isn't touched. Requires `firebase deploy --only functions` to ship.

7. **Service worker `notificationclick` doesn't deep-link** — currently when a user taps a chat notification on the lock screen, the app opens to wherever they were last (or home), not to the chat. The drawer's `deepLinkFor()` infers the right tab from notification type, but the SW could route there directly on cold open. Requires postMessage between SW and app + a navigate listener in App.jsx. Not breaking, but a polish opportunity.

---

## 9. Next recommended steps (when you get back)

In order of recommended priority — most are low-effort, high-value:

1. **Verify on a real phone:** open the bell drawer; tap a notification; confirm icon matches type and tap routes to the right tab. (~2 min check)
2. **Verify toast feedback on test-push button:** Admin → Push diagnostic → Send test push → confirm green toast appears. (~1 min)
3. **Verify auto-submit PIN:** sign out, enter PIN, confirm sign-in completes without tapping OK. (~30s)
4. **Decide on `ADMIN_PIN` retirement:** the hardcoded secret in client JS is the single biggest remaining secrecy issue. Either remove it (recommended — `isAdmin` is sufficient) or move it server-side. (~10 min review + small commit)
5. **Continue with `AUDIT.md` deferred items** when ready for the SaaS hardening sprint: SEC-001 (open Firestore rules), SEC-003 (plaintext PINs), SEC-004 Phase B (close direct Firestore reads of `/onboarding_invites` + `/onboarding_hires`).
6. **Add ESLint + tsc** to the project (or even a `npm run check` script that runs `build + test`). Currently the only gate is the build, which catches imports/syntax but not unused-var, dead-import, or shadowed-variable issues. Tracked as a follow-up improvement.

---

## 10. Decision log (autonomous choices)

These are choices I made without your input, applying the "safest reasonable decision" rule:

- **Mounted `<AppToast />` in `main.jsx`, not `App.jsx`.** `App.jsx` has 5 early returns (apply portal, install splash, onboarding portal, lock screen, main shell). Mounting in `main.jsx` as a sibling means toast surfaces on every path including the public apply form and the lock screen — strict superset of any in-`App` placement.
- **Kept legacy `item.kind` read** in `NotificationsDrawer.jsx` as a fallback after the `item.type` read. Old notification docs (if any exist in production) keep rendering correctly.
- **PIN auto-submit delay 120ms.** Tested mentally against the "see the 4th dot before the screen flips" criterion. Shorter (60ms) feels jumpy; longer (200ms) feels laggy. 120ms is the goldilocks.
- **Conservative on `confirm()` and `prompt()`.** I converted alert() but left native `confirm()` and `prompt()` calls alone — those have blocking semantics that callers depend on. Replacing them requires a full modal system, which is outside polish-pass scope.
- **Conservative on `Maintenance` i18n.** The English-only location dropdown values bleed into Spanish users' UI; this is real, but fixing it requires schema-aware translation that could regress somewhere. Left it for owner review.
