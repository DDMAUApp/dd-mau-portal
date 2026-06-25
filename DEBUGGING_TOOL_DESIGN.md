# DD Mau — Internal Debugging & Automation Tool: Full System Design

**Audience:** future devs + the self-healing agent.
**Companion docs:** `DEBUG_AUTOMATION_PLAN.md` (the original plan + locked decisions), `SENTRY_SETUP.md`, `DEPLOY.md`.
**Stack reality (design to THIS, not a greenfield):**
- Web + menu TVs: React 18 + Vite → GitHub Pages (`app.ddmaustl.com`).
- Native: Capacitor 8 (iOS + Android) + Capgo OTA. JS/CSS ships OTA; native code needs a store build.
- Backend: Firebase Cloud Functions v2 (`us-central1`, TZ `America/Chicago`) + Firestore.
- Auth: **no Firebase Auth** — client-side 4-digit PIN vs `config/staff` (Phase-2 lock pending). The name is the cross-app join key.
- Railway: the Python labor scraper (writes aggregate labor to Firestore).
- CI: GitHub Actions (`deploy.yml`, `test.yml`, `debug-agent.yml`).

**Guiding rule (non-negotiable):** read-only / dry-run / sandboxed by default. Never delete real data, spam users, submit payments, or mutate production schedules without an explicit human action. Synthetic tests use dedicated test accounts + a `__diag` sentinel that production code ignores.

---

## 0. What already EXISTS vs the ask (don't rebuild this)

| Your requested capability | Status | Where it lives |
|---|---|---|
| Error log collection | ✅ Built | Sentry (`src/data/sentryClient.js`, `sentryReal.js`), `logger.js` → `error_logs` |
| Crash detection | ✅ Built | `PageErrorBoundary.jsx`, global handlers in `App.jsx`, Sentry |
| Failed API request tracking | 🟡 Partial | Sentry breadcrumbs; no per-endpoint failure rollup yet |
| API health checks | ✅ Built | `functions/healthChecks.js` `runHealthChecks()`; `exports.healthCheck` |
| Database connection checks | ✅ Built | Firestore probe inside `runHealthChecks` (HARD-fail) |
| Deployment verification | ✅ Built | `deploy.sh` post-deploy curl → `healthCheck?trigger=deploy` → `/deploys` |
| Availability/PTO/shift audit logging | ✅ Built | `audit.js` `auditAvailabilityChange/auditPtoChange/auditShiftChange`; wired Schedule.jsx (14) + AdminPanel.jsx (2) → `audit` |
| Audit provenance (tz/platform/surface) | ✅ Built | `clientAuditContext()` in `audit.js` |
| Critical alerting | ✅ Built | `exports.onCriticalError` → owner push + `chats/debug_agent` |
| Continuous automation (24/7) | ✅ Built (dormant) | `.github/workflows/debug-agent.yml` (every 15m) + `scripts/qa/` agent + chat bridge |
| Debug queue for the agent | ✅ Built | `exports.getDebugQueue` + `buildDebugQueue()` |
| Log retention/pruning | ✅ Built | `pruneAuditLogs`, `pruneSystemLogs` |
| Bug list + error pages (dashboard) | 🟡 Partial | `AdminHealthPage.jsx`, `ErrorReportPage.jsx` |
| **Automated login testing (synthetic)** | ❌ GAP | — |
| **iOS/Android/web login-screen checks** | ❌ GAP | — |
| **Slow-screen / performance RUM** | ❌ GAP | — |
| **Railway deploy + env-var validation** | ❌ GAP | scraper *freshness* is checked; deploy status + env is not |
| **Permission/role testing** | ❌ GAP | — |
| **Notification (push) testing** | ❌ GAP | — |
| **IP address in audit log** | ❌ GAP | client can't see its IP; needs a CF stamp |
| **Cross-platform comparison** | ❌ GAP (advanced) | — |
| **Exportable reports** | 🟡 Partial | `aiDebugReport.js` (AI export); no CSV/PDF business report |

**Bottom line:** ~70% built. The 7 GAP modules below are the real work. Design each to the requested format.

---

## 1. Architecture (one diagram, no new infra)

```
 CLIENTS                         FIRESTORE (system of record)        AUTOMATION
 ┌───────────────┐               ┌─────────────────────────┐        ┌─────────────────────┐
 │ iOS / Android │──audit/log──▶ │ audit            (rich)  │ ◀────  │ GitHub Actions       │
 │ Web / TVs     │──errors────▶ │ error_logs / security    │  reads │  debug-agent (15m)   │
 └──────┬────────┘               │ health_check[_runs]      │        │  + agent-comms chat  │
        │ Web Vitals             │ deploys                  │        └─────────┬───────────┘
        ▼                        │ synthetic_runs (NEW)     │                  │ opens PRs
 ┌───────────────┐  probes       │ login_attempts (NEW)     │                  ▼
 │ Cloud Functions│─────────────▶│ perf_samples (NEW)       │        ┌─────────────────────┐
 │ healthCheck    │  writes       │ env_audit (NEW)         │        │ Owner (push + chat) │
 │ onCriticalError│               └─────────────────────────┘        └─────────────────────┘
 │ syntheticCheck │ (NEW)  ───────────────▲  pings  ─────────  Railway API (scraper deploy) (NEW)
 └───────────────┘
```

Principles: Firestore is the single sink (the catch-all rules cover new collections — no rules deploy needed, but ADD per-collection read-locks where PII lands). Cloud Functions do anything privileged (IP capture, Railway API, push tests, env validation). GitHub Actions is the only true 24/7 runner.

---

## 2. The availability audit log — finish the spec

**Current:** `auditAvailabilityChange({staffId, staffName, before, after, surface, reason})` → `recordRichAudit` → `audit` collection with `{feature, action, staffName, before, after, reason, tz, platform, surface, viewport, ts}`. Wired at all 16 mutation sites.

**Spec gaps to close** (your exact field list):

| Field | Have? | How to add |
|---|---|---|
| Employee name | ✅ | `staffName` |
| Employee ID | 🟡 | pass `staffId` everywhere (some sites omit) — make it required-with-warn |
| Who made the change | ✅ | `actor` (from current session staffName) — already in `recordRichAudit` |
| Old / new availability | ✅ | `before`/`after` — ensure full object diff, not partial |
| Timestamp | ✅ | `serverTimestamp()` |
| Timezone | ✅ | `clientAuditContext().tz` |
| Platform (ios/android/web/admin) | ✅ | `platform` + `surface` ('admin-dashboard' vs 'self-serve') |
| Device info | 🟡 | add `userAgent` + Capacitor `Device.getInfo()` (model/os) to `clientAuditContext` |
| **IP address** | ❌ | **server-stamp**: a CF `stampAuditIp` reads `request.ip` — clients cannot self-report IP. See §4. |
| Action type (created/edited/deleted) | ✅ | `action` |
| Store/location | 🟡 | add `location` (webster/maryland) — read from the staff record or active location |
| Reason/note | ✅ | `reason` |

- **Why it matters:** "who changed my availability and when" is the #1 manager dispute; the log is the source of truth and the seed for the schedule-bug detector.
- **How:** extend `clientAuditContext()` (device + location); add a `stampAuditIp` callable OR have writes go through an `auditWrite` CF that injects `request.ip` server-side (preferred — clients never see/forge IP).
- **Files:** `src/data/audit.js`, `functions/index.js` (+`auditWrite`), `firestore.rules` (lock `audit` to append-only).
- **Risks:** PII (names + IP) in an open collection — **lock `/audit` `read:false` (or admin-claim later), `create:`shape-validated, `update/delete:false`**. Don't store device fingerprints beyond model/os.
- **Testing:** make a change on each surface (self-serve iOS, self-serve web, admin edit), assert one `audit` doc with all fields + correct platform.
- **Rollback:** the `auditWrite` CF is additive; if it errors, client falls back to direct `addDoc` (current path). Feature-flag `AUDIT_VIA_CF`.

---

## 3. GAP MODULES (each: what / why / how / files / risks / testing / rollback)

### G1 — Synthetic login & auth testing
- **What:** a headless test that drives the real login on **web** (Playwright in GitHub Actions) + an in-app **self-test mode** for **native** (`?diag=login` deep link runs the PIN→home flow against a TEST staff account) + an **API-level** auth probe (CF validates the PIN-match logic vs `config/staff` without a UI).
- **Why:** login is the front door; the last 9 keypad rounds prove UI-level auth bugs are invisible to backend checks. Catches "PIN won't submit", broken `staffListReady` gate, lockout regressions, the keypad hit-offset.
- **How:**
  - Web: `tests/e2e/login.spec.ts` (Playwright) → tap PIN digits via **coordinates** (mirrors the geometry handler), assert it reaches `home`. Run in `debug-agent.yml` + a new `synthetic.yml` (post-deploy + 6am).
  - Native: a `DiagHarness` mounted on `?diag=1` that programmatically enters a test PIN, times each step, writes a `synthetic_runs` doc `{platform, flow:'login', steps[], ok, ms}`. Triggerable by opening a diag URL on a parked test device, or on app boot when `__DIAG__` build flag is set (never in store builds).
  - API: `exports.syntheticAuthCheck` — given a TEST account's PIN, runs the same match logic the client uses; asserts exactly one match + no lockout. Read-only.
- **Files:** `tests/e2e/login.spec.ts`, `.github/workflows/synthetic.yml`, `src/diag/DiagHarness.jsx`, `functions/index.js`.
- **Risks:** never use a real employee's PIN in CI — create `config/staff` test rows (`Z_TEST_FOH`, `Z_TEST_BOH`) the app filters out of rosters by name prefix. Lockout counter is per-device localStorage → CI is isolated, safe.
- **Testing:** break the PIN gate on a branch, confirm the synthetic run goes red + posts to the chat bridge.
- **Rollback:** delete the workflow / diag flag; zero production impact (separate test accounts, read-only API).

### G2 — Performance / slow-screen detection (RUM)
- **What:** capture per-route render timing + Web Vitals (LCP/INP/CLS) and the time-to-interactive of hot screens (login, schedule grid, chat, inventory), sampled, → `perf_samples`.
- **Why:** "the iPad loads so slow", "keypad laggy" — today these are anecdotes. Need numbers per screen per platform to find regressions after a deploy.
- **How:** a tiny `perf.js` using `PerformanceObserver` + `web-vitals`; wrap route mounts with a `useScreenTiming(name)` hook that records `{screen, platform, version, ttiMs, lcpMs, inpMs}`. Sample 5–10% (and 100% for the first session after an OTA bump). Roll up nightly into `perf_rollup` (p50/p95 per screen). Sentry Performance can back this if its tracing is enabled; Firestore rollup is the cheap owned copy.
- **Files:** `src/data/perf.js`, `src/hooks/useScreenTiming.js`, wire in `App.jsx` route switch + `Schedule/ChatThread/Operations`.
- **Risks:** don't sample 100% always (write cost + battery). No PII in perf docs. Guard `PerformanceObserver` (Safari quirks) in try/catch.
- **Testing:** add an artificial 1s delay to a route, confirm p95 jumps in `perf_rollup` + a "slowest screens" alert.
- **Rollback:** flip `PERF_SAMPLING=0`; the hook becomes a no-op.

### G3 — Railway deploy health + environment-variable validation
- **What:** (a) a CF `railwayHealthCheck` that queries the Railway GraphQL API for the scraper service's latest deployment status + restart count; (b) an env-var validator that asserts required keys exist (CF runtime config + a Railway env manifest) and flags missing/empty ones — **names only, never values**.
- **Why:** the scraper has crashed/looped on Railway before; freshness alone misses "deployed but crash-looping". Env drift (a missing key) is a classic silent breakage.
- **How:**
  - Railway: store a **read-only** Railway API token in CF secrets; `railwayHealthCheck` GETs deployment status; fold the result into `runHealthChecks` (soft-fail) + `deploys`. Add to the morning + post-deploy crons.
  - Env: a `REQUIRED_ENV.json` manifest; `validateEnv()` in CF startup logs any missing key to `env_audit` (key name + present:boolean). A matching check for Railway runs in the scraper's boot.
- **Files:** `functions/healthChecks.js` (+`railwayHealthCheck`), `functions/env.js`, `REQUIRED_ENV.json`, scraper repo `boot_check.py`.
- **Risks:** **never log env values** (redact.js rules apply). Railway token must be read-only + scoped. Rate-limit the API (1/run).
- **Testing:** unset a non-critical env on a Railway preview, confirm `env_audit` flags it + a soft alert (not a hard page).
- **Rollback:** remove the token secret → the check self-skips (try/catch returns `skipped`).

### G4 — Permission / role testing
- **What:** synthetic checks that the role gates hold: a STAFF test account cannot load admin-only data/pages (payroll, admin panel, other staff's PII); an ADMIN test account can. Plus a Firestore-rules assertion suite (`@firebase/rules-unit-testing`).
- **Why:** the app uses client-side `isAdmin()` gating + open-ish Firestore rules (Phase-2 lock pending). A regression that exposes payroll/PII is the highest-severity bug class. Tests turn "we think rules are tight" into proof.
- **How:** `tests/rules/firestore.rules.test.ts` runs the rules emulator: assert test-staff token can't read `payroll_runs`, `insurance`, others' `audit`; admin can. Run in `test.yml` on every push. A UI smoke (Playwright) logs in as test-staff and asserts the Admin tab is absent.
- **Files:** `tests/rules/*.test.ts`, `firestore.rules`, `.github/workflows/test.yml`.
- **Risks:** emulator only — never run rule tests against prod. Keep test accounts non-privileged.
- **Testing:** loosen a rule on a branch → the suite fails the PR.
- **Rollback:** test-only; no runtime footprint.

### G5 — Notification (push) testing
- **What:** a CF `syntheticPushCheck` sends a **silent/test** push to a dedicated parked test device token and confirms the send API returned success (and, if the device runs DiagHarness, that it was received → `synthetic_runs`).
- **Why:** push has broken before (iOS sandbox-vs-prod APNs token pruning, deep-link). Silent failures = staff miss shift alerts.
- **How:** reuse the existing dispatch path with a `__diag` flag + a test token; assert the FCM/APNs response. Never targets real staff tokens.
- **Files:** `functions/index.js` (+`syntheticPushCheck`), reuse `apns.js`.
- **Risks:** must target ONLY the test token (hard-coded allowlist). Use `content-available` silent push so no human sees it.
- **Testing:** revoke the test token, confirm the check goes red.
- **Rollback:** scheduled function — disable the schedule.

### G6 — IP capture for the audit log
- **What:** server-side IP stamping (see §2) — a CF reads `request.ip`/`x-forwarded-for`.
- **Why:** clients can't see their own public IP; needed for the audit spec + abuse investigation.
- **How:** route sensitive audit writes through `exports.auditWrite` (callable/HTTP) that injects `ip`, `ua`, and a server `ts`. Or a lightweight `getClientIp` callable the client calls once per session and attaches.
- **Files:** `functions/index.js`, `src/data/audit.js`.
- **Risks:** IP is PII → `/audit` read-locked; document retention (pruned by `pruneAuditLogs`).
- **Testing:** make a change, assert `ip` present + plausible; from VPN, assert it changes.
- **Rollback:** field is additive; absent = current behavior.

### G7 — Cross-platform comparison (advanced)
- **What:** a nightly job that runs the SAME synthetic flows (login, view schedule, submit availability) on web + an iOS sim + an Android emulator and diffs outcomes (pass/fail, timing, screenshot deltas).
- **Why:** catches "works on web, broken on iOS" (the entire keypad saga) before staff hit it.
- **How:** GitHub Actions matrix (macOS runner for iOS sim via `xcrun simctl` + Playwright; Linux for Android emulator + web). Each leg writes `synthetic_runs`; a comparator flags divergence.
- **Files:** `.github/workflows/cross-platform.yml`, `tests/e2e/*`.
- **Risks:** flaky emulators → retries + quarantine; cost (mac runners) → nightly only, not per-push.
- **Testing:** introduce an iOS-only CSS break, confirm the comparator flags iOS≠web.
- **Rollback:** disable the workflow.

---

## 4. Database schema (audit + debug collections)

```
audit/{id}                  // rich change log (LOCK read:false)
  feature        'availability'|'pto'|'shift'|'schedule'|...
  action         'created'|'edited'|'deleted'|'approved'|'denied'|...
  staffName, staffId, location ('webster'|'maryland')
  actor          // who performed it (session staffName)
  before, after  // full objects (diff-able)
  reason
  platform 'ios'|'android'|'web' ; surface 'self-serve'|'admin-dashboard'
  tz, viewport, userAgent, deviceModel, osVersion
  ip             // server-stamped (G6)
  ts             // serverTimestamp

error_logs/{id}     {source, name, message, stack, severity, breadcrumbs[], version, platform, occurredAt, signature, pushedAt?}
security_logs/{id}  {kind, staffName?, detail, occurredAt}
health_checks/{id}  {kind, ok, ms, detail, trigger, runId, at}
health_check_runs/{id} {trigger, ok, failed[], summary, expectedVersion, sha, at}
deploys/{id}        {version, sha, trigger, siteOk, firestoreOk, at}
login_attempts/{id} (NEW)  {result 'ok'|'wrong_pin'|'locked'|'connecting', platform, version, ms, at}  // NO pin, NO name on failure
synthetic_runs/{id} (NEW)  {flow 'login'|'push'|'availability', platform, ok, steps[{name,ms,ok}], ms, version, at}
perf_samples/{id}   (NEW)  {screen, platform, version, ttiMs, lcpMs, inpMs, sampledAt}
perf_rollup/{day}   (NEW)  {screen: {p50, p95, n}}  // nightly
env_audit/{id}      (NEW)  {surface 'functions'|'railway', missing[], at}   // names only
```
Retention: `pruneSystemLogs`/`pruneAuditLogs` extend to the NEW collections (30–90 days; audit longer = 1y for disputes).

---

## 5. Backend API endpoints (Cloud Functions)

| Endpoint | Type | Purpose | Exists? |
|---|---|---|---|
| `healthCheck` | HTTP | on-demand health probe (used by deploy.sh) | ✅ |
| `healthCheckScheduled` | cron 8/13/20 CT | scheduled health | ✅ |
| `getDebugQueue` | HTTP | agent triage feed | ✅ |
| `onCriticalError` | trigger | escalate + push owner | ✅ |
| `auditWrite` | callable | server-stamp IP/UA on audit writes | ❌ G6 |
| `syntheticAuthCheck` | HTTP/cron | API-level login logic test | ❌ G1 |
| `syntheticPushCheck` | cron | test push to test token | ❌ G5 |
| `railwayHealthCheck` | cron (folded into health) | Railway deploy status | ❌ G3 |
| `validateEnv` | startup + cron | env-var presence | ❌ G3 |
| `perfRollup` | nightly cron | p50/p95 per screen | ❌ G2 |
| `exportReport` | HTTP (admin) | CSV/PDF of audit/logins/errors | ❌ §6 |

All HTTP endpoints: CORS-scoped + a shared `?key=` or admin check; read-only except `auditWrite` (append-only).

---

## 6. Frontend dashboard pages

Single **Debug Dashboard** (admin-only, behind `isAdmin`), tabs:

1. **Overview / Critical alerts** — red banner of open HARD failures + unresolved criticals (from `health_check_runs`, `error_logs` severity=critical).
2. **Bugs** — `error_logs` grouped by `signature`, frequency, last-seen, version (✅ partial in `ErrorReportPage`).
3. **Error frequency** — sparkline per signature over time.
4. **Slowest screens** — `perf_rollup` p95 table per platform (G2).
5. **Failed deployments** — `deploys` where !ok + `health_check_runs` failures.
6. **Failed logins** — `login_attempts` where result≠ok, rate over time (G1).
7. **API failures** — health-check kind failures + Sentry API breadcrumbs.
8. **Availability history** — `audit` viewer filtered to feature in (availability/pto/shift), per employee, with before→after diff (THE manager-facing view).
9. **User role activity** — `audit` grouped by actor (who did what).
10. **Exports** — buttons → `exportReport` (CSV/PDF) + the existing `aiDebugReport.js` "copy for AI".

Reuse `AdminHealthPage.jsx` as the shell; add the new tabs as lazy panels. Each reads its Firestore collection with a bounded `limit` + date filter (perf-safe, per the existing audit lessons).

---

## 7. Mobile logging strategy

- **Capture:** global error/unhandledrejection handlers (✅) + `logger.js` → `error_logs` with `platform` from `Capacitor.getPlatform()`. Add **breadcrumbs** for: app foreground/background (`appStateChange`), route changes, login steps, OTA apply.
- **Native crashes (JS):** caught by error boundaries + Sentry. **Native crashes (Swift/Kotlin):** out of JS reach — rely on App Store Connect / Play Console crash reports; surface a manual "check store crash dashboards" item in the morning routine.
- **Offline:** queue logs in localStorage when `!navigator.onLine`, flush on reconnect (avoid losing the most interesting failures).
- **Version stamping:** every log carries `__APP_VERSION__` (date·sha) so a regression maps to a deploy.
- **Battery/cost:** sample perf (§G2); errors always logged; cap log size + redact (✅ `redact.js`).
- **Privacy:** never log PINs, full PII, tokens (✅ enforced in `redact.js`; CR-CB-1 fixed PIN logging already).

---

## 8. Railway monitoring strategy

- **Freshness (✅):** health check flags stale scraper data (no fresh labor row in N hours).
- **Deploy status (G3):** Railway API → last deploy state + restart count → `deploys`/health.
- **Crash loop:** restart count delta > threshold ⇒ soft alert (not a hard page — scraper is non-critical to the app).
- **Env drift (G3):** boot-time `boot_check.py` asserts required keys; writes `env_audit`.
- **Logs:** Railway log drain → (optional) a webhook CF that scans for `Traceback`/`CRITICAL` and writes `error_logs` with `source:'railway'`.
- **Cadence:** morning + post-deploy + on a freshness-miss (event-driven re-check).

---

## 9. Alerting strategy (tiered — avoid fatigue)

| Tier | Trigger | Channel | Cadence |
|---|---|---|---|
| **P0 critical** | site down, Firestore down, auth fully broken, payroll/PII exposed | owner **push** + `chats/debug_agent` urgent | immediate, dedup 30m (✅ `onCriticalError` cooldown) |
| **P1 high** | login failure spike, deploy health red, crash spike | chat bridge (non-urgent) + dashboard banner | within the hour |
| **P2 medium** | slow-screen p95 regression, Railway crash-loop, env drift | dashboard + morning digest | daily |
| **P3 low** | single new error signature, flaky synthetic | agent PR / dashboard only | batched |

Dedup by `signature`; cooldown per signature; a **morning digest** (one push) rolls up P2/P3 so the only interrupts are P0/P1.

---

## 10. Security & privacy rules

1. **Read-lock PII collections:** `audit`, `login_attempts`, `error_logs`, `security_logs`, `payroll_runs`, `insurance` → `read:false` now (open `create` shape-validated, `update/delete:false`); tighten to admin-claim when Firebase Auth lands.
2. **Never store secrets/PINs/tokens/values** — `redact.js` scrubs; env checks log **names only**.
3. **IP/device** = PII → minimal (model/os/ip), short retention, read-locked.
4. **Synthetic tests** use dedicated `Z_TEST_*` accounts + `__diag` sentinels; production filters them out; they never mutate real schedules/data.
5. **Read-only tokens** for Railway; CORS-scoped HTTP CFs; no destructive endpoints.
6. **No spam:** push tests target ONLY an allowlisted test token; alerts deduped + tiered.
7. **GitHub Actions secrets** (Anthropic key, service account) are encrypted + masked, even on a public repo (don't make the repo private — it breaks Pages/TVs).

---

## 11. MVP vs Advanced

**MVP (highest value, ~1–2 build sessions, mostly OTA + CF):**
- Finish the audit spec: `staffId`/`location`/device + **`auditWrite` IP stamp** (§2, G6).
- **Availability-history dashboard tab** (#8) + **failed-logins** capture (`login_attempts`, G1 client side) + tab (#6).
- **Synthetic web login** Playwright test in CI (G1) + **rules-test suite** (G4).
- **Read-lock the PII collections** (§10.1).
- Wire P0/P1 into the existing `onCriticalError`/chat bridge (mostly done).

**Advanced (later):**
- Perf RUM + slowest-screens (G2), Railway deploy + env validation (G3), push testing (G5), native DiagHarness self-tests, cross-platform comparison (G7), CSV/PDF `exportReport`, Railway log-drain → `error_logs`.

---

## 12. Step-by-step build roadmap

- **Phase 0 — Lock down (½ session):** read-lock `audit`/`login_attempts`/`error_logs`/PII in `firestore.rules`; extend pruning to new collections. *(Safety first.)*
- **Phase 1 — Audit completeness (1 session):** `staffId`/`location`/device fields; `auditWrite` CF for IP; backfill the 16 wiring sites. Test on all 3 surfaces.
- **Phase 2 — Login visibility (1 session):** `login_attempts` capture in `HomePage` (result+platform+ms, no PII); dashboard tabs #6 + #8.
- **Phase 3 — Synthetic + rules tests (1 session):** Playwright web-login + `@firebase/rules-unit-testing` suite in CI; fail PRs on regressions.
- **Phase 4 — Perf RUM (1 session):** `perf.js` + `useScreenTiming` + nightly `perfRollup` + slowest-screens tab.
- **Phase 5 — Railway + env (1 session):** `railwayHealthCheck` + `validateEnv` + `env_audit`; fold into morning/post-deploy.
- **Phase 6 — Push + native diag + cross-platform (2 sessions):** `syntheticPushCheck`, `DiagHarness`, cross-platform matrix.
- **Phase 7 — Reports (½ session):** `exportReport` CSV/PDF.

Each phase: build behind a flag → `npm run build` + `vitest` + (web) Playwright → deploy → the post-deploy `healthCheck` + the 24/7 agent verify it in prod. Rollback = flip the flag / revert the OTA (Capgo keeps prior bundle).

---

## Automation trigger matrix (how each "run when" is satisfied)

| Run when | Mechanism |
|---|---|
| After every deployment | `deploy.sh` → `healthCheck?trigger=deploy` (✅); add synthetic web-login to `deploy.yml` |
| Every morning | `healthCheckScheduled` 8am CT (✅) + morning digest push; add Railway + env (G3) |
| Before app-store releases | a `pre-release.yml` manual gate: full synthetic + cross-platform + rules tests must pass |
| Before major backend changes | run `getDebugQueue` clean + rules tests in the PR (CI gate) |
| After Railway deploy failures | `railwayHealthCheck` event re-check + P1 alert (G3) |
| When login errors spike | `login_attempts` rate watcher CF → P1 (G1) |
| When schedule errors happen | `onCriticalError` for feature in (availability/shift) → owner push (✅ extend) |
