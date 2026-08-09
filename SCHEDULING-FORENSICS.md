# Scheduling Forensic Report

**Date:** 2026-08-09 · **Auditor:** Claude (read-only forensic pass; no fixes in this document)
**Evidence base:** full line-by-line read of `Schedule.jsx` (14,015 lines, 2026-08-07), firestore.rules
inspection, functions/index.js inspection, production `error_logs` + `schedule_audit` data, and the
recorded history of 60+ scheduling fixes shipped since 2026-05. Items verified only by static analysis
(not reproduced on a device) are marked **[static]**. Items confirmed in production are marked **[prod]**.

---

## 0. THE ANSWER FIRST: why this scheduling system keeps breaking

Six architectural facts — not individual bugs — generate the recurring failures. Every scheduling
incident since May traces to at least one of them:

| # | Root cause | Class | What it produces |
|---|-----------|-------|------------------|
| R1 | **There is no server.** Every client writes directly to Firestore, and `/shifts`, `swap_requests`, `staffing_needs`, `recurring_shifts`, `schedule_templates`, `date_blocks` are under the **permissive catch-all rule** — the database validates *nothing* (not `endTime > startTime`, not "employee exists", not permissions). Every invariant lives in client JS. | ARCHITECTURE / DATA | Any bug in any client version can write any shape. Old app builds enforce old (buggy) invariants forever. Impossible states are representable. |
| R2 | **The fleet is version-fragmented.** OTA updates apply only on full app relaunch; store iPads and phones routinely run builds days–weeks old (a June 29 build was still writing errors on Aug 7 **[prod]**). Because of R1, an old client's bugs re-corrupt data that new clients then display — "fixed" bugs appear to return. | STATE / MOBILE | "We fixed that already" recurrences; mixed-schema documents. |
| R3 | **~95% of scheduling logic lives inside one 14,015-line React component.** Date math, hours math, conflict detection, copy-week dedupe, auto-fill, publish, swap state machine — all closures inside `Schedule.jsx`. **Zero automated tests cover any of it** (verified: no Schedule test file exists; only `splh.js` and `shiftHandoff.js` are extracted modules). | ARCHITECTURE / TEST GAP | Every change is hand-verified only; regressions ship silently; the TDZ crash class (May + July) is only possible because everything shares one giant scope. |
| R4 | **Schema accretes variants instead of migrating.** Firestore is schema-less and nothing backfills: `time_off` docs use `date` OR `startDate`; legacy shifts lack `side`/`location`/`published`; `staffing_needs` tracks fills in two parallel arrays that must stay index-aligned by convention. Every consumer must handle every historical shape, forever — and each new consumer that forgets one is a "new" bug (three shipped incidents from `time_off.date` alone). | DATA | The same fallback bug re-appears in each new code path. |
| R5 | **Two date conventions coexist.** Cloud Functions and business features use America/Chicago anchoring; `Schedule.jsx` uses **device-local** date getters everywhere (`toDateStr`, `startOfWeek`, "today"). Correct while all devices sit in Central time; silently wrong for a traveling owner or mis-set device clock. Overnight shifts are *rejected* rather than modeled (no business-date concept for a shift). | TIME | Latent, environment-dependent date drift; "works for staff, wrong for Andrew in Seattle". |
| R6 | **The platform layer itself fails and gets misdiagnosed as scheduling bugs.** Background suspend kills the Firestore transport and (on iOS) the IndexedDB connection; writes hang, listeners freeze. Until v1.0.386–388 the app had **zero** recovery, so "delete times out", "add doesn't respond", "money counter times out" all presented as page bugs. | MOBILE / STATE | Weeks of symptom-level reports; patches to the wrong layer. |

**The bug → patch → bug cycle exists because patches land in the client (R3) while the data layer
accepts anything (R1) from a fleet that never fully updates (R2), against data whose shape keeps
diverging (R4).** No amount of further client patching escapes that loop; only moving invariants
down (rules/CF), extracting logic into tested modules, and putting a floor under fleet versions does.

---

## 1. Architecture map

### 1.1 Topology (the real one)

```
┌─ Web (GitHub Pages, app.ddmaustl.com) ─┐
├─ iOS app (Capacitor WKWebView) ────────┤   SAME JS bundle (Capgo OTA)
├─ Android app (Capacitor WebView) ──────┤
└────────────────┬───────────────────────┘
                 │  Firebase JS SDK — DIRECT reads/writes, no API layer
                 ▼
        Cloud Firestore (single project, no tenancy)
                 ▲
                 │  (reads + tiny writes only)
        Cloud Functions:  dispatchNotification (notifications→FCM/APNs fan-out),
                          sendShiftReminders (cron; stamps reminderSent),
                          two same-day shift READS for other features
```

There is **no backend API, no server validation, no service layer**. "API architecture" for
scheduling = the Firestore SDK. Identity = a PIN-selected `staffName` string held in client state
(no Firebase Auth); permissions are client-side checks (`canEditSchedule`, `isAdmin`).

### 1.2 Files (complete scheduling surface)

| File | Lines | Role |
|---|---|---|
| `src/components/Schedule.jsx` | 14,015 | EVERYTHING: 11 listeners, all handlers, all date/hours math, conflict engine, copy/auto-fill/recurrence generation, publish, swap flows, 20+ inline modal components, print/ICS export |
| `src/components/OfferShiftModal.jsx` / `TakeShiftModal.jsx` | small | offer/take composers (write via Schedule handlers) |
| `src/components/ScheduleAuditLog.jsx` | — | admin viewer for `schedule_audit` |
| `src/components/ShiftHandoff.jsx` + `src/data/shiftHandoff.js` | — | handoff notes (separate feature) |
| `src/data/splh.js` | — | labor/SPLH aggregation (extracted, partially tested) |
| `src/data/notify.js` | — | notification doc writers (notifyStaff/Admins/Management) |
| `src/data/audit.js` | — | `auditShiftChange` / `auditPtoChange` / `auditScheduleConfig` |
| `src/data/staff.js` | — | `canEditSchedule`, `isAdmin`, `isOnScheduleAt`, roster access |
| `src/data/firestoreRevive.js` | new | transport/IndexedDB wedge recovery (v386–388) |
| `src/v2/AppDataContext.jsx` | — | shared listeners: notifications, laborHistory, staff list |
| `functions/index.js` | — | sendShiftReminders (cron), dispatchNotification, day-shift reads |
| HomeV2/MobileHome | — | "upcoming shifts" read-only consumers of `/shifts` |

### 1.3 Firestore collections (the "schema")

| Collection | Guarded by rules? | Shape risks |
|---|---|---|
| `shifts` | **NO — catch-all** | doc-per-shift; optional fields: `side`, `location`, `published`, `offerStatus`, `pendingClaimBy`, `proposedSplit`, `approvedBy`, `coverNeeded`, `transferHistory[]`, `fromNeedId/fromRecurringId/fromTemplateId`, `reminderSent` |
| `time_off` | partial own block | **mixed schema**: `date` vs `startDate/endDate`; `partial+startTime/endTime`; `status` pending/approved/denied |
| `staffing_needs` | **NO** | `filledStaff[]` + `filledShiftIds[]` **parallel index-aligned arrays** + `interestedClaims[]` |
| `swap_requests` | **NO** | from/to shift ids + snapshots; status |
| `recurring_shifts` | **NO** | rule docs; `cadence` weekly/biweekly anchored on `validFrom` |
| `schedule_templates` | **NO** | blocks[].slots[] |
| `date_blocks` | **NO** | closed / no_timeoff / open_override |
| `config/schedule_settings` | config block | closedWeekdays per location, shiftPresets |
| `schedule_audit` | own block | append-only audit rows |
| `notifications` | own block (create-constrained) | per-recipient docs → CF fan-out |

---

## 2. Workflow traces (source of truth → sync)

The uniform pattern for **all 30 workflows** (verified across the full file read):

```
User action → client-side permission gate (canEditSide/staffIsAdmin)
→ client-side validation (varies by flow)
→ DIRECT Firestore write            ← [addDoc | updateDoc | writeBatch | runTransaction]
→ fire-and-forget audit row (schedule_audit)
→ fire-and-forget notification docs (→ CF → FCM/APNs)
→ NO manual cache update: the onSnapshot listener is the read path;
  UI re-renders when the (local-echo) snapshot arrives
→ other clients converge via their own listeners
```

Per-workflow write mechanics (all traced in the 2026-08-07 line-by-line read):

| Workflow | Write | Concurrency protection | Rollback story |
|---|---|---|---|
| Create shift | `addDoc` (draft) | double-submit guard in modal | error toast; no partial state |
| Edit times (inline/modal) | `updateDoc` | **none — last-write-wins** | toast on rejection |
| Delete shift | confirm → `deleteDoc` (+need prune) | none needed | undoToast on non-immediate path |
| Drag/move shift | **`runTransaction`** re-reads, refuses if owner/date drifted or deleted | yes | error toast, no write |
| Take / claim shift | **`runTransaction`** refuses if not still open | yes (first-writer-wins) | clear error |
| Approve swap (incl. partial split) | **`runTransaction`**: split creates leftover docs atomically; `approvedBy` double-approve guard | yes | all-or-nothing |
| Direct swap request approve | **`runTransaction`** on 3 docs; snapshot-drift check; dead-request cleanup commits | yes | all-or-nothing |
| PTO approve/deny/reverse | **`runTransaction`** status-drift guard | yes | clear "already decided by X" |
| Publish week | pre-filter vs live snapshot → chunked `writeBatch` → per-doc `allSettled` fallback; busy-ref | partial (no version check) | skipped-doc toasts |
| Copy last week | `getDocs` fresh server dedupe + local union → `writeBatch` | dedupe-by-key, not txn | duplicates prevented by key check |
| Auto-fill / recurring generate / apply template | client generation → `writeBatch` (drafts) | none (drafts only) | partial-day failure collected + toasted |
| Fill staffing need | busy-ref + already-in-slot check → `addDoc` shift + `arrayUnion` on need | partial (arrayUnion atomic, but 2-step non-atomic) | prune-on-delete compensations |
| Up-for-grabs claim queue | **`runTransaction`** on `interestedClaims` | yes | — |
| Availability / birthday | optimistic local + server-anchored `patchStaffRecordByName` (rev protocol) | yes (roster rev) | live snapshot rebases |
| Bulk delete / bulk offer | `writeBatch` | undoToast window | atomic per chunk |

**Honest assessment:** the *hot mutation paths are individually well-engineered* — transactions,
drift checks, busy-refs, dedupe, compensating deletes. The fragility is not in these handlers; it's
in everything around them (R1–R6). Two structural exceptions:

- **Fill-need is 2-step non-atomic** (shift `addDoc` then need `arrayUnion`): a crash between the
  two orphans a shift with `fromNeedId` pointing at a slot that doesn't count it. **[static]**
- **Publish has no version/ETag concept**: two managers publishing/editing concurrently is
  last-write-wins on the `published` stamp (benign-ish: publishing is idempotent), but an edit
  racing a publish can publish a half-edited shift silently. **[static]**

---

## 3. Sources of truth inventory (can two systems disagree about one shift?)

Four layers hold shift data:

| Layer | Scope | Staleness bound | Can disagree? |
|---|---|---|---|
| 1. Firestore server | truth | — | — |
| 2. SDK persistent cache (IndexedDB) | all queried docs + **pending write queue** | until reconnect | YES while offline/wedged (this is *by design* — offline queue) |
| 3. `localStorage` week cache (`ddmau:shifts:<week>`) | shifts only, per week | 24h TTL (was 5min), overwritten by every live snapshot | YES for the 1–2s paint window, and *labeled* ("Cached" pill) |
| 4. Component state (`shifts[]` etc.) | one page instance | one snapshot tick | only during optimistic gaps |

Verdicts:
- **No Redux/React Query/SQLite/Realm duplicate stores exist.** The listener-is-the-read-path
  discipline is real and consistently applied; there are no manual cache-update paths to drift.
- The dangerous layer is **#2 when wedged** (R6): pre-v386, a device could hold hours of un-flushed
  writes that *it* displayed as saved and no other device could see — the strongest
  "two screens disagree" incident class in production **[prod]**. v386–388 bounds this to ~18s.
- Layer #3 is deliberately allowed to be stale and is visually labeled; its failure mode is
  cosmetic (brief old paint), not divergent writes.
- **Derived caches that CAN silently diverge:** `staffing_needs.filledStaff/filledShiftIds`
  (vs actual shifts) and `swap_requests.*Snapshot` (vs live shift docs). Both have drift *checks*
  at decision time, but nothing reconciles the need arrays if a compensating prune ever failed. **[static]**

## 4. Shift identity

- Identity = Firestore auto-ID, assigned server-side at `addDoc`; **no temp client IDs anywhere**
  (local echo already carries the real ID). React keys use `shift.id` (never array index — verified).
- Copy week / templates / recurring generation create **new** docs (fresh IDs) with provenance
  pointers (`fromRecurringId` etc.) — copies never retain source IDs. Split-approve creates new
  leftover docs; original doc shrinks in the same transaction.
- **One soft spot:** the *human* join key across the whole app is `staffName` (string), not an ID
  (R4-adjacent; renames fan out via `renameStaff.js`). A rename racing an active week can strand
  shifts under the old name until the fan-out completes. **[static, known design]**

## 5. Date/time architecture

- **Representation:** shifts store `date` = `'YYYY-MM-DD'` string + `startTime`/`endTime` = `'HH:mm'`
  strings. No timestamps, no UTC, no TZ math in the data — this is genuinely good (a wall-clock
  domain stored as wall-clock values; DST cannot corrupt stored data).
- **Interpretation is where the split lives (R5):** Schedule.jsx interprets "today"/"this week"
  via **device-local** `new Date()` getters; Cloud Functions (reminders) and other features use
  **America/Chicago**. One documented standard does not exist. The de-facto rule is
  "dates mean restaurant local time, computed on a device assumed to be in Central".
- **Overnight shifts: rejected, not modeled.** `endTime > startTime` is enforced at every entry
  point (added 2026-06-16 precisely because `hoursBetween`'s overnight wrap conflicted with the
  split-pickup math). The 11 PM–2 AM question is answered by *prohibition*. Fine for DD Mau's
  10:00–20:00 reality; a real limitation if hours ever extend past midnight.
- **DST:** date-only strings + local `Date(y,m,d)` construction are DST-safe; the one real DST bug
  found (biweekly parity off-by-one across transitions) was fixed 2026-05-22 with `Math.round`.
  `blockedDatesInRange` iterates via DST-safe `addDays`. **No open DST defects found in the sweep.**
- **Workweek:** single constant `WEEK_START_DOW = 0` (Sun–Sat), matching FLSA/payroll per spec —
  schedule display, OT badge, and payroll all share it. No divergent week definitions found.

## 6. Availability / time-off / conflicts

- Availability: per-weekday `{available, from, to}` on the staff record; **default = available**
  (opt-out model, per owner spec); no effective-dating, no multi-range, no per-location windows —
  a *change* applies instantly to all future weeks. Existing shifts are **not** deleted by an
  availability change; every mutation path surfaces the conflict via the flashing acknowledge
  modal (add/resize/move) instead. Verified consistent.
- Time-off: full state machine (pending/approved/denied + reversals) under transactions; partial-day
  windows are warnings, whole-day approved PTO is a hard block on drop/auto-fill/publish
  (re-checked at publish commit). Mixed `date`/`startDate` schema is the recurring hazard (R4).
- **Conflict engine:** overlap detection (same person, same day, time overlap; adjacency allowed) is
  computed client-side in a `useMemo` and *displayed*; scheduling over it is allowed. ERROR-vs-
  WARNING separation exists de facto (closed date & approved PTO = hard stops; availability, partial
  PTO, OT, minor-labor = warnings/overrides) — but the taxonomy is implicit in 6 scattered
  call sites, not one module. Cross-location double-booking IS caught for auto-fill (deliberately
  reads both stores) but plain manual add only warns via weekly-hours, not a cross-store overlap
  check. **[static]**

## 7. Recurrence, copy, publish, notifications — model verdicts

- **Recurrence = generator, not series.** Rules are templates; "Generate this week" mints
  independent draft docs. There IS no occurrence/series edit problem *because* generated shifts
  are ordinary shifts (editing one never touches the rule). Trade-off: no series-wide edit
  propagation, regeneration relies on the overlap-dedupe check. This is the right model for the
  scale — document it as intentional.
- **Copy week:** fresh-server + local dedupe key `(staff|date|start|end)`, closed/PTO skips, side
  preservation, always-draft output. The one gap: two managers copying simultaneously on two
  devices can still double-create between the two `getDocs` reads (no transaction over a range —
  Firestore can't do that; a marker doc could). **[static, low likelihood]**
- **Publish** means: `published:false` docs invisible to non-editors; publish stamps
  `published:true + publishedBy/At` and notifies per-staff (batched per person, tag-deduped per
  week — a republish *replaces* the OS notification rather than stacking). Editing a published
  shift stays published and notifies the assignee directly. There is **no unpublish**, no
  "modified since publish" state. Consistent, minimal, adequate — but undocumented until now.
- **Notifications:** all writes go through `notify()`/`notifyStaff` with deterministic `tag`s
  (resource-scoped) so retries collapse; urgent-cover fan-out is detached from the UI thread;
  known past FCM-token-nuking bug ({en,es} objects to FCM) is fixed with regression comments.
  Remaining risk: 5 edits in 30s = up to 5 pushes with the same tag → device shows only the last
  (OS-level collapse) — acceptable; no server-side debounce exists.

## 8. Mobile sync & offline

- Sync = Firestore listeners; foreground latency sub-second when healthy. Background: no sync
  (WebView frozen); on resume, listeners + (since v386) transport revive re-converge.
- **Offline editing is implicitly allowed** (SDK queues writes to IndexedDB) but **not surfaced**:
  a manager editing offline sees local echo as "saved" with no pending-write indicator. This is
  the honest remaining gap in "does the user know whether it saved" — post-v388 the wedged case
  self-heals, but the genuinely-offline case still looks like success. **[static]** Candidate fix:
  surface `hasPendingWrites` from snapshot metadata as a "⏳ not yet synced" pill.

## 9. Database integrity audit (the core deficiency)

Verified against `firestore.rules` on 2026-08-09:

- `shifts`, `staffing_needs`, `swap_requests`, `recurring_shifts`, `schedule_templates`,
  `date_blocks` → **permissive catch-all**: any connected client may create/update/delete any doc
  with any fields. The following impossible records are accepted **by the database** today:
  negative-duration shift, shift with no staffName, `published:true` draft-only combinations,
  cross-location claim, deletion of the entire collection.
- All protections that DO exist are client-side gates in a component that old fleet builds run
  old versions of (R1 × R2 — the central loop).
- No composite indexes are required by current queries (all single-field ranges — verified by the
  absence of index errors in prod).
- Employee deactivation: historical shifts persist (grid filters ghost names client-side; the
  2026-05-09 ghost-row fix); nothing prevents *assigning* to a deactivated staffer except the
  picker not listing them. **[static]**

## 10. Performance

- Chunk: 95.4 kB gz lazy chunk (prewarmed since v383). Render path heavily memoized (WeeklyGrid
  memo + stable callbacks + ShiftCube comparator + pre-bucketed maps) after successive audits.
- Data: 11 listeners on mount, all bounded (week-window shifts; 6-month/6-week/200-doc caps).
- Remaining hot spots: `staffSummary` recomputes O(staff × shifts) per snapshot tick (fine at
  ~30 staff, linear risk at 100+); a shift edit re-renders the full grid once per snapshot tick
  (acceptable); no N+1 patterns (no per-row queries anywhere — verified).
- Scale ceiling: the whole design (client-side joins over full-collection listeners) is
  comfortable to ~100 staff / low-thousands of shifts per window; a 250-employee multi-tenant
  future needs the SAAS-PLAN backend, not this topology.

## 11. Test coverage (the enforcement gap)

- 699 passing tests, **~0 cover scheduling logic** — because the logic is un-importable (R3).
  Only `splh.js` math and satellite utilities are tested. There is no test for: hoursBetween,
  dayPaidHours, overlap detection, copy-week dedupe, auto-fill, biweekly parity, publish
  filtering, PTO date-fallback handling. Every one of those has had at least one shipped bug.
- No emulator-based rules tests (nothing to test — rules don't constrain these collections).
- No E2E (PIN-locked UI; no test identity system exists).

---

## 12. Findings register (classified, prioritized)

**Confirmed / production-evidenced:**
| P | Finding | Class |
|---|---|---|
| P0 | R1: zero DB-level invariants on 6 of 7 scheduling collections | ARCHITECTURE/DATA |
| P0 | R2: fleet fragmentation re-introduces fixed bugs (June-29 build active Aug-7) | MOBILE/STATE |
| P1 | R6: suspend-wedge write hangs (now self-healing v386–388; monitor) | MOBILE |
| P1 | R3: 14k-line component, zero scheduling tests | TEST GAP |
| P1 | R4: `time_off` mixed schema (3 shipped incidents; latest fixed v385) | DATA |
| P2 | R5: device-local vs Chicago date duality | TIME |
| P2 | Offline edits indistinguishable from saved (no pending-writes indicator) | UX/STATE |

**Suspected / static-analysis only (not reproduced):**
| P | Finding | Class |
|---|---|---|
| P2 | Fill-need 2-step non-atomicity → orphan shift on mid-crash | DATA |
| P2 | need.filledStaff/filledShiftIds parallel arrays can drift if a prune fails | DATA |
| P2 | Concurrent copy-week on two devices can double-create between reads | CONCURRENCY |
| P2 | Edit racing publish can publish mid-edit values silently | CONCURRENCY |
| P3 | staffName-as-join-key rename race window | DATA |
| P3 | Assigning deactivated staff not hard-blocked at write | DATA |
| P3 | Cross-store same-time manual double-book only warned via hours, not overlap | UX |

**Top 10 most dangerous weaknesses** = R1, R2, R3, R4, R5, offline-invisibility, parallel-array
needs tracking, publish/edit race, fill-need atomicity, rename race — in that order.

---

## 13. Stabilization plan (adapted to THIS architecture — no rewrite)

The prompt's phase list assumed a server/ORM stack. Mapped to reality, ordered by leverage:

**Phase A — enforcement floor (attacks R1+R2, highest leverage)**
1. Write real Firestore rules for `shifts` + the 5 unguarded scheduling collections: shape
   validation (`date` matches `\d{4}-\d{2}-\d{2}`, `endTime > startTime`, `staffName is string`,
   status enums, no field-set outside whitelist). ⚠ MUST follow the carve-out protocol
   (memory: every new strict block added to `isCarvedTop()`; live-probe after deploy — the
   2026-07-12 outage rule).
2. **Fleet version floor:** `config/minVersion` + client gate that forces the existing
   forceRefresh/OTA path when `appVersion < minVersion`. Kills the zombie-build class permanently.

**Phase B — extract & test the brain (attacks R3, enables everything after)**
3. Move pure logic out of Schedule.jsx into `src/data/scheduleCore.js` (dates/weeks), 
   `hoursMath.js`, `conflicts.js`, `copyWeek.js`, `autoFill.js`, `recurrence.js` — byte-identical
   behavior, imported back into the component.
4. **Golden-schedule dataset** (deterministic 20-staff fixture: minors, both stores, cross-side,
   partial PTO, biweekly rules, near-OT) + ~150 unit tests over the extracted modules, incl.
   DST-week and Sunday-boundary cases. Add fuzz tests for invariants (end>start, dedupe keys,
   parity).

**Phase C — schema convergence (attacks R4)**
5. One-time backfill script: `time_off.date → startDate/endDate`, shifts missing
   `side`/`location`/`published` get explicit values; then delete the fallback branches and let
   new rules reject the old shapes.
6. Replace `staffing_needs` parallel arrays with a `fills: {shiftId: staffName}` map (atomic
   per-key updates, no index alignment).

**Phase D — time standard (attacks R5)**
7. Decide and document: scheduling dates = **America/Chicago business dates**. Swap
   Schedule.jsx's `toDateStr/startOfWeek/"today"` to Chicago-anchored versions (single helper,
   already house idiom elsewhere). Small diff *after* Phase B extraction makes it testable.

**Phase E — sync honesty**
8. Pending-writes indicator (snapshot `hasPendingWrites` → "⏳ syncing" pill) so offline saves
   are never mistaken for durable. Keep monitoring revive/escalate logs from v386–388.

**Phase F — remaining concurrency**
9. Version-stamp shifts (`rev` increment, same protocol as the staff roster) and make publish
   and edit check it — closes the edit/publish race; fill-need moves the arrayUnion into the
   shift-create batch.

**Regression lock:** the deploy gate already blocks on vitest; Phases B/C add the scheduling
suite to it, so future changes hit ~150 scheduling tests + rules validation before every ship.

Sequencing note: A1+A2 are independent and shippable this week; B is the prerequisite for D and
for meaningful regression coverage; C and F ride on A's rules being live so old writers are
actually locked out.

---

*End of read-only report. No code was modified for this document.*
