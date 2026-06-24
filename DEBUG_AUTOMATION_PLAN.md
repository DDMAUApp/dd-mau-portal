# DD Mau — Debugging & Automation System (Design + Build Plan)

**Author:** Staff Eng / QA Automation / DevOps / Mobile-Debug / Observability pass, 2026-06-24
**Goal (Andrew's words):** "Something automated that does regular checks, checks right after a deploy. If an error pops up it auto-routes to a fix without me asking. Keeping the app smooth is key."

**Hard rule (non-negotiable):** Nothing destructive. No deleting real data, no spamming users, no real payments, no modifying production schedules without permission. Read-only probes, a flagged test account, and dry-run by default.

---

## 0. What already exists (don't rebuild)

The app is **not** starting from zero. Verified in-repo this session:

| Capability | Where | State |
|---|---|---|
| Frontend error logging → `error_logs` (90d) | `src/data/logger.js` `logError()` | ✅ mature; dual-writes Sentry |
| Security events → `security_logs` (365d) | `logger.js` `logSecurityEvent()` | ✅ (login retries, perm-denied) |
| In-memory breadcrumbs (25-ring) attached to errors | `logger.js` `breadcrumb()` | ✅ |
| PII/secret scrubbing (keys, email, phone, SSN, paths) | `src/data/redact.js` | ✅ defense-in-depth |
| Claude-ready debug export (JSON dossier) | `src/data/aiDebugReport.js` | ✅ `buildAIDebugReportFromError()` |
| Rich audit w/ before/after/reason → `/audit` | `src/data/audit.js` `recordRichAudit()` | ✅ but **unused for schedule** |
| `auditScheduleChange()` wrapper | `audit.js:187` | ⚠️ **defined, ZERO callers** |
| Sentry (lazy, scrubbed, setUser) | `src/data/sentryClient.js` | ✅ |
| Error boundaries (auto chunk-reload) | `PageErrorBoundary.jsx`, `main.jsx` | ✅ |
| Owner-only error dashboard | `src/components/ErrorReportPage.jsx` | ✅ errors + bugs + ai_logs |
| System health dashboard | `src/components/AdminHealthPage.jsx` | ✅ Firestore/TV/backups/printers |
| Critical-error trigger (dedup + cooldown) | `functions/index.js` `onCriticalError` | ⚠️ records only; **alert disabled** |
| Railway scraper staleness watchdog | `functions/index.js` `watchScraperFreshness` | ✅ writes critical `error_logs` |
| Log retention pruning | `pruneSystemLogs`, `pruneAuditLogs` | ✅ |
| Per-staff platform telemetry | `App.jsx` `lastSignInPlatform/Native/Standalone` | ✅ |
| Push alerting (FCM + APNs) | `dispatchNotification` | ✅ works both platforms |
| SMS alerting | `dispatchSms` | ⚠️ A2P 10DLC blocked (30034) |
| Catch-all Firestore rule | `firestore.rules` | ✅ new collections need no rules deploy |

**Implication:** the build is an *automation + instrumentation* layer on top of solid logging — not a green-field observability project. We wire what's dormant, add synthetic checks, add the deploy/health record, and add the cloud agent that closes the loop.

---

## 1. The gaps we're closing

1. **No synthetic testing** — zero e2e/smoke. Nothing proves login/schedule/availability flows actually work after a change.
2. **No post-deploy verification** — `deploy.sh` ships and walks away; no record of the deploy, no check that the live site came up.
3. **Nothing closes the loop** — `onCriticalError` dedups but doesn't alert or route to a fix.
4. **Schedule/availability changes are unaudited** — 20+ write paths, `auditScheduleChange()` never called. This is goal #7 and the biggest single data-integrity gap.
5. **No unified debug surface** — errors live in ErrorReportPage, systems in AdminHealthPage, scraper health in the labor tiles; no one screen ties deploys ↔ errors ↔ checks ↔ audit.
6. **No slow-screen tracking surfaced** — Sentry samples 5% of traces but nothing is summarized for "which screen got slow."

---

## 2. Architecture (one diagram)

```
                         ┌─────────────────────────────────────────────┐
   CLIENTS               │  Firestore (single prod project, catch-all)  │
  iOS / Android / Web ──▶│  error_logs · security_logs · audit          │
        │                │  + NEW: deploys · health_checks · synthetic_runs
        │ logError()     └───────────────▲──────────────┬───────────────┘
        │ recordRichAudit()              │              │
        ▼                                │ writes       │ reads
  ┌───────────────┐   post-deploy   ┌────┴──────┐   ┌───▼────────────────┐
  │ deploy.sh     │────────────────▶│ Cloud Fns │   │ Debug/QA Dashboard │
  │ writes deploy │   trigger       │ onCritical│   │ (admin-only page)  │
  │ record        │                 │ Error →   │   │ errors·deploys·    │
  └───────┬───────┘                 │ alert+    │   │ checks·audit·perf  │
          │                         │ route     │   └────────────────────┘
          ▼                         └────┬──────┘
  ┌────────────────────┐                 │ "fixable error" / failed check
  │ Synthetic checker  │                 ▼
  │ (Node + Playwright)│        ┌──────────────────────────┐
  │ read-only + test   │        │ SCHEDULED CLOUD AGENT     │
  │ account, dry-run   │───────▶│ (routine): post-deploy,   │
  │ writes health_check│        │ every morning, on-spike → │
  └────────────────────┘        │ triage → draft fix → PR   │
                                └──────────────────────────┘
```

Everything lands in the **existing prod Firestore** (catch-all rule = no rules deploy needed for new collections). No new infrastructure to stand up.

---

## 3. The auto-fix loop (the heart of the ask)

"If an error pops up it auto-routes to a fix without me asking" = a **scheduled cloud agent (routine)** — a headless Claude Code run on a cron, which runs even when your laptop is closed. It:

1. **Reads** new `error_logs` (severity critical/error, unresolved) + failed `health_checks` + failed `synthetic_runs`.
2. **Triages** with the existing `aiDebugReport.js` dossier (breadcrumbs, stack, before/after) — already PII-scrubbed.
3. **Reproduces** where possible against the test account / read-only probes.
4. **Acts** per the autonomy level you pick (see Decisions):
   - **Auto-PR:** writes the fix on a branch, runs `npm run build` + 363 vitest, opens a PR. You just merge. Never auto-merges to prod.
   - **Propose-first:** diagnoses + drafts the patch, pushes you a notification with the dossier + proposed diff; applies only on your 👍.
5. **Marks** the `error_logs` row `resolved:true` with a link to the PR, so it doesn't re-trigger.

**Triggers for the agent:**
| Trigger | Mechanism |
|---|---|
| After every deploy | `deploy.sh` writes `deploys/{v}`; agent runs on next tick and verifies + reacts |
| Every morning (pre-open) | cron `0 9 * * *` CT |
| Before an app-store release | manual `npm run qa:release` |
| On login-error spike | `security_logs` rate breach → critical `error_logs` → agent |
| On schedule-error spike | same path, `feature:'schedule'` |
| After a Railway deploy/scrape failure | `watchScraperFreshness` already writes critical `error_logs` → agent |

**Guardrails:** the agent only ever opens PRs (human merge gate to prod), runs the full build+test before pushing, works in a git worktree, touches nothing in Firestore except marking errors resolved, and is rate-limited (one fix attempt per error signature per day — reuse the `onCriticalError` cooldown hash).

---

## 4. Schedule & Availability Audit Log (goal #7 — build first)

**What to build:** capture every availability + PTO + shift change with full provenance.

**Why it matters:** today a manager can silently rewrite an employee's availability or delete a shift and there is no record of who/when/what-changed. This is the highest data-integrity risk and the easiest high-value win (the wrapper already exists).

**Field mapping (your spec → implementation):**
| Your field | Source | Notes |
|---|---|---|
| Employee name | `targetName` | the staff being changed |
| Employee ID | `targetId` | staff id |
| Who made the change | `actorName/actorId/actorRole` | from `window.__ddmau_*` (already wired) |
| Old availability | `before` | redacted object |
| New availability | `after` | redacted object |
| Timestamp | `createdAt` | `serverTimestamp()` |
| Timezone | **NEW** `tz` | `Intl.DateTimeFormat().resolvedOptions().timeZone` |
| Platform (iOS/Android/web/admin) | **NEW** `platform` + `surface` | `Capacitor.getPlatform()`; surface = `'self-serve'` vs `'admin-dashboard'` |
| Device info | `userAgent` (exists) + **NEW** `viewport` | already captured in audit |
| IP if available | **NEW (advanced)** `ip` | client can't see its IP — needs a callable CF (`request.rawRequest.ip`); MVP omits, advanced adds for sensitive changes |
| Action type | `action` | `created` / `edited` / `deleted` |
| Store/location | `actorLocation` + target location | |
| Reason/note | `reason` | already supported |

**How to implement:**
- Extend `recordRichAudit()` in `src/data/audit.js` to auto-capture `tz`, `platform`, `viewport` (cheap, client-side, no new args).
- Add `auditAvailabilityChange({ staffId, staffName, before, after, surface, reason })` next to the existing wrappers.
- Wire the **existing** `auditScheduleChange()` + new availability wrapper into every write site:
  - `Schedule.jsx`: `handleSaveMyAvailability` (4381), `handleSubmitPtoRequest` (4081), `handleApprovePto` (4134), `handleDenyPto` (4289), `handleChangePtoStatus` (4194), `handleAddTimeOff` (3926), `handleRemoveTimeOff` (3952), `handleUpdateShiftTimes` (2104), `handleDropShift` (2199), `handleDeleteShift` (2038/2063), `commitOfferShift` (2495), `handleRequestCover` (2581), `commitTakeShift` (2831), `handleApproveSwap` (2902), shift-create modal.
  - `AdminPanel.jsx`: `updateDay` availability modal (3332).
- Store in **`/audit`** with `feature` ∈ `{availability, pto, shift}` (reuses existing retention + the AdminHealthPage "recent audit" feed). The dashboard filters by feature.

**Files:** `src/data/audit.js` (wrappers + auto-context), `src/components/Schedule.jsx` (15 sites), `src/components/AdminPanel.jsx` (1 site). Optional advanced: a `logAuditWithIp` onCall in `functions/`.

**Risks to avoid:** audit must be **best-effort and never throw** (it already is — fire-and-forget, console.warn on fail). Never block or slow a schedule write on the audit. Capture `before` by reading the live doc *inside* the existing transaction where one exists (don't add a second read on the hot path — reuse the txn's snapshot). Redact (already automatic).

**Testing:** unit test the wrappers (synthetic before/after → assert doc shape incl. tz/platform/action); manual: change an availability as admin and as self, confirm two `/audit` rows with correct actor/surface/before/after; confirm a PTO approve and a shift delete each log once. Add to vitest.

**Rollback:** instrumentation is additive and isolated; revert the audit.js + Schedule.jsx commit. No schema migration, no data risk.

---

## 5. Synthetic checks (goal #1, #2, #5, #6 — non-destructive)

**What to build:** a Node checker (`scripts/qa/`) with two tiers.

**Tier 1 — read-only probes (safe anywhere, no account):**
- `GET /version.json` matches the just-deployed version (catches a broken/stale deploy).
- `GET` the live site root returns 200 + the app shell renders (Playwright headless: lock screen visible, no console errors).
- Firestore reachable: read `config/forceRefresh` (already the AdminHealthPage liveness probe).
- Read-only Cloud Function probe: call `aiFixText`/`translateMessage` with a trivial input (no side effects) → asserts the API + Anthropic key are alive.
- Scraper freshness: read `ops/labor_webster|maryland` `updatedAt` (reuse the `watchScraperFreshness` threshold).
- Each writes a row to **`health_checks`** `{ kind, ok, ms, detail, version, ranAt, env }`.

**Tier 2 — flow tests with a flagged test account (dry-run, opt-in):**
- A dedicated staff record `{ id: 999, name: 'QA Bot', pin: '<random>', role: 'Automation', location: 'webster', isTestAccount: true }`.
- Playwright: enter PIN → assert unlock → land on Home → navigate Schedule/Operations/Chat → assert each renders < budget + no console errors → measure nav timing (slow-screen detection).
- Schedule write test writes **only to a sandboxed shift owned by QA Bot on a far-future date**, then deletes it — or better, runs against a `dryRun` flag the handlers respect. Never touches a real employee's schedule.
- Everywhere reports render/login/nav timings → `synthetic_runs` for the slow-screen board.

**Why it matters:** this is the "test the app without breaking production data" requirement. Read-only first; the test account is isolated by `isTestAccount` so every report/analytic filters it out (one-line filter, same pattern as existing derived-field filters).

**Files:** `scripts/qa/probe.mjs` (Tier 1), `scripts/qa/flows.spec.ts` + `playwright.config.ts` (Tier 2), `package.json` scripts `qa:probe` / `qa:flows` / `qa:release`. Test account seeded once via admin SDK script.

**Risks:** Playwright is a dev/CI dep only (not bundled). Test account PIN must be random + the account flagged + excluded from labor/payroll/notifications. Synthetic writes must be far-future + self-owned + auto-cleaned, or gated behind `dryRun`. Never run Tier-2 writes against real staff names.

**Testing the tester:** dry-run locally against staging (`deploy-staging.sh` `dev` channel) before trusting it. Assert it filters QA Bot from the clocked-in/labor views.

**Rollback:** delete the `scripts/qa/` dir + the test account doc; nothing in prod depends on it.

---

## 6. Post-deploy verification (goal #2)

**What:** `deploy.sh` gains a final step: write `deploys/{version}` `{ version, sha, builtAt, by, channel }`, then run `npm run qa:probe` against the live URL and write the result. The scheduled agent reads the latest `deploys` doc on its next tick and reacts to a failed probe.

**Why:** right now a bad deploy is invisible until a staffer hits it. This catches "site 500s / version didn't update / API down" within a minute.

**Files:** `scripts/deploy.sh` (+ ~10 lines), `scripts/qa/probe.mjs`.

**Risks:** the probe must **not** fail the deploy (deploy already pushed web + OTA by then) — it's a verify-and-alert, not a gate. Network flakiness → retry 2× before marking failed.

**Rollback:** remove the appended step.

---

## 7. Alerting (goal: route without nagging)

**Channels (ranked by what actually works today):**
1. **In-app notification doc** → owner bell (always works, persists).
2. **Push (FCM/APNs)** to owners 40/41 via `dispatchNotification` `type:'critical_error_alert'` (LOCKED_ON, bypasses off-shift gate) — works both platforms.
3. **PR opened by the cloud agent** = the real "fix" signal.
4. SMS — **blocked** by A2P 10DLC (30034) until you register; leave wired-but-off.

**Activate `onCriticalError`:** flip the disabled alert (line ~4866) to send a single push to owners per error signature (the cooldown/dedup is already built), `type:'critical_error_alert'`, deep-linking to the Debug dashboard. Keep the agent as the fixer; the push is just the heads-up.

**Anti-spam:** reuse the existing signature-hash cooldown (one alert per signature per window). Severity floor = critical for push; errors/warns stay dashboard-only.

**Risks:** don't alert on chunk-load/"Script error." noise (already filtered in `logger.js`). Don't push on synthetic/test-account errors (filter `isTestAccount`).

---

## 8. Debug/QA Dashboard (frontend)

**What:** one owner-only page (`DebugDashboard.jsx`) that unifies the picture. Reuses the lazy-page + sidebar pattern (`App.jsx` `activeTab==='debug'`, `requires:'admin'`).

**Sections (each a card, all read-only queries, bounded + ordered):**
1. **Critical alerts** — unresolved critical `error_logs` (24h), with a "Copy AI dossier" + "View PR" button.
2. **Bug list / error frequency** — grouped by signature (reuse ErrorReportPage's grouping), count + sparkline + features/roles affected.
3. **Slowest screens** — top nav timings from `synthetic_runs` (+ Sentry traces link).
4. **Deploys** — last 20 from `deploys`, each with its probe result (green/red) + version + sha.
5. **Failed checks** — `health_checks` where `ok:false`, last 24h.
6. **Failed logins** — `security_logs` `kind:'login_retry'` rate by hour (spike detection).
7. **API failures** — `ai_logs` `ok:false` + Cloud-Function error rate.
8. **Availability/schedule change history** — `/audit` filtered to `feature ∈ {availability,pto,shift}`, with before→after diff, actor, platform, reason. Filter by employee.
9. **Role activity** — `/audit` grouped by actor (who's changing what).
10. **Export** — "Download report" (JSON/CSV) for any section; reuses `aiDebugReport.js` for the error dossiers.

**Files:** `src/components/DebugDashboard.jsx` (lazy), `App.jsx` (tab wire), `Sidebar.jsx` (nav entry, `requires:'admin'`). Extends ErrorReportPage rather than replacing it (keep that as the deep error view; Debug is the cross-cutting overview).

**Risks:** all queries bounded (`limit`) + ordered (existing index discipline); owner-gated (ids 40/41); no PII beyond what audit already scrubs.

---

## 9. Mobile logging strategy

- **Already:** `logError`/`logSecurityEvent`/breadcrumbs run identically on native (Capacitor) and web; `Capacitor.getPlatform()` tags platform; Sentry captures native JS errors.
- **Add:** capture `platform` + `appVersion` (the baked `__APP_VERSION__`/OTA bundle id) on every `error_logs` row (mostly there — ensure native bundle version is stamped so we can tell *which OTA* a crash came from).
- **Add:** a lightweight `breadcrumb('nav', screen)` on each tab switch + a `performance.now()` render-timing breadcrumb so slow-screen data exists on real devices, not just synthetic.
- **Native-only crashes** (Swift/Kotlin, not JS) are rare here (thin Capacitor shell) — Sentry's native SDK is out of scope; the JS layer covers ~all app logic.

---

## 10. Railway monitoring strategy

- **Already:** `watchScraperFreshness` (every 15m, 10am–11pm CT) flags stale labor/86 docs as critical `error_logs`; the Python scraper has Sentry.
- **Add:** the scraper writes an explicit `scraper_heartbeat` doc `{ ranAt, ok, lastError }` each cycle so the dashboard shows "last successful scrape" directly (today it's inferred from `ops/labor_*.updatedAt`).
- **Add:** the cloud agent treats a `ScraperStale` critical error as an *ops* alert (restart guidance) rather than a code-fix — Railway restart is the known remedy (documented in memory). Don't auto-PR scraper-stale; route it to a notification with the restart runbook.
- **Hardening (deferred, separate repo):** cron lock, `railway.json`, pinned `firebase-admin`, fetch timeouts on the invoices loop (the known wedge).

---

## 11. Security & privacy rules

- **Read-only / dry-run by default.** Synthetic writes only as the flagged test account on self-owned far-future data, or behind `dryRun`.
- **No new PII.** Audit `before/after` runs through `redactObject`; the existing DROP_KEYS already nukes pin/ssn/wages/payroll. PINs continue to log to the separate `pin_audits` collection, never `/audit`.
- **IP capture (advanced) is the only sensitive add** — only via a callable CF, only on sensitive changes, masked to /16 in any UI (redact.js already does this).
- **Owner-gated** dashboards (ids 40/41). The cloud agent runs under your own GitHub creds and only opens PRs (no direct prod write, no force-push, no merge).
- **Firestore:** new collections (`deploys`, `health_checks`, `synthetic_runs`, `scraper_heartbeat`) are covered by the catch-all rule; when Phase-2 Auth lands, add explicit append-only rules (read: owners, create: server, update/delete: false).

---

## 12. MVP vs Advanced

**MVP (this is what I build first — safe, high-value, mostly wiring what exists):**
1. **Schedule/availability audit log** — wire `auditScheduleChange()` + new `auditAvailabilityChange()` into all 16 sites; extend `recordRichAudit` with tz/platform/surface. (§4)
2. **Deploy record + post-deploy probe** — `deploys` doc + `scripts/qa/probe.mjs` (read-only Tier-1). (§6)
3. **Debug/QA dashboard** — the unified owner page with the audit-history + deploys + errors + checks sections. (§8)
4. **Activate `onCriticalError`** push to owners (dedup already built). (§7)
5. **Scheduled cloud agent v1** — morning + post-deploy run that reads errors/checks and **proposes** fixes (propose-first), opening a PR on confirm.

**Advanced (phase 2+):**
6. Playwright Tier-2 flow tests + slow-screen board + the QA Bot account. (§5)
7. Auto-PR autonomy (agent writes + builds + opens PR unattended). (§3)
8. Login-spike + schedule-spike detectors (`security_logs` rate → critical). (§7)
9. IP-stamped audit via callable CF for sensitive changes. (§4)
10. Scraper heartbeat doc + ops-runbook routing. (§10)
11. Cross-platform comparison report (same flow on iOS vs Android vs web, timing/diff). (§5)

---

## 13. Build roadmap (step-by-step)

**Phase 1 — Instrumentation (no behavior change, ship via OTA):**
- 1.1 Extend `audit.js` (`recordRichAudit` auto-context + `auditAvailabilityChange`). Unit tests.
- 1.2 Wire audit into Schedule.jsx (15 sites) + AdminPanel.jsx (1 site). Build + 363 tests.
- 1.3 Add `nav`/render-timing breadcrumbs. Ship OTA.

**Phase 2 — Visibility (owner-only, ship via OTA):**
- 2.1 `DebugDashboard.jsx` + tab wire + sidebar. Audit-history + errors + role-activity sections first (data already exists).
- 2.2 Activate `onCriticalError` push (firebase deploy --only functions).

**Phase 3 — Deploy verification (local tooling, no app change):**
- 3.1 `scripts/qa/probe.mjs` (Tier-1 read-only) + `deploys` doc. 
- 3.2 Hook into `deploy.sh` (verify, don't gate). Add `deploys`+`health_checks` sections to the dashboard.

**Phase 4 — The loop (scheduled cloud agent):**
- 4.1 Stand up the routine (morning + post-deploy) in **propose-first** mode.
- 4.2 Watch it for a week; graduate the safe error classes to **auto-PR**.

**Phase 5 — Advanced (opt-in):**
- 5.1 Playwright Tier-2 + QA Bot + slow-screen board.
- 5.2 Spike detectors, IP audit, scraper heartbeat, cross-platform report.

**Each phase:** `npm run build` clean + `npx vitest run` (currently 363) + commit + (OTA where app code changed) + confirm `git rev-parse HEAD == origin/main`.

---

## 14. Database schema (new collections)

```
deploys/{version}            // one per npm run deploy
  version, sha, builtAt, by, channel ('production'|'dev'), probeOk, probeRanAt, probeDetail

health_checks/{autoId}       // one per probe run, per kind
  kind ('version'|'site'|'firestore'|'cf_ai'|'scraper'), ok, ms, detail, version, env, ranAt

synthetic_runs/{autoId}      // Tier-2 flow runs (advanced)
  flow ('login'|'schedule_nav'|'chat'), platform, ok, timings{screen:ms}, consoleErrors[], ranAt

scraper_heartbeat/{location} // advanced
  ranAt, ok, lastError, rowsScraped

// EXISTING, extended:
audit/{autoId}               // + tz, platform, surface, viewport on every row;
                             // feature ∈ {availability, pto, shift, ...}, action ∈ {created,edited,deleted}
error_logs/{autoId}          // + resolvedBy ('agent'|name), fixPrUrl when the agent resolves one
```

All covered by the catch-all rule; explicit append-only rules added when Phase-2 Auth lands.

---

## 15. Backend endpoints / functions (new or changed)

- `onCriticalError` (existing) — **change:** enable owner push on critical (dedup already there).
- `logAuditWithIp` (new, **advanced**, onCall) — stamps `request.rawRequest.ip` + server time for sensitive schedule changes; optional, only for the IP requirement.
- `detectLoginSpike` / `detectScheduleSpike` (new, **advanced**, onSchedule every 10m) — count recent `security_logs`/`error_logs` by signature; write a critical row on breach to wake the agent.
- No changes to any mutating function; everything else is read-side.

---

## 16. Decisions needed from Andrew (blocking the loop, not the instrumentation)

1. **Autonomy of the auto-fix** — Auto-PR (agent fixes + opens PR unattended, you merge) vs Propose-first (agent diagnoses + asks before writing). *Recommend: start Propose-first, graduate safe classes to Auto-PR.*
2. **The always-on engine** — a scheduled **cloud agent** (runs when your laptop is closed; costs tokens per run) vs **local-only** (checks run when I deploy or when you ask). *Recommend: cloud agent, 1×/morning + post-deploy, cheap triage that only escalates to a full fix run on a real failure.*

Instrumentation (Phases 1–3) is safe and valuable regardless of both answers — that's where the build starts.
