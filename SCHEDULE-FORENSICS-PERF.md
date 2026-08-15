# SCHEDULE FORENSIC REPORT — EDIT LAG / INCONSISTENCY — DD Mau Portal
**Date:** 2026-08-15 · **Trigger:** Andrew: "schedule is very inconsistent and edits lag … look at Julie's edits" · **Method:** live Firestore view census + JS self-profiler on the dev build (see CHAT-FORENSICS-PERF.md §2), 5-lens read of Schedule.jsx / scheduleCore / scheduleConflicts / AppDataContext with adversarial verification (45 agents, 31 findings confirmed), Julie's audit trail + device record pulled from Firestore.

---

## 0. TL;DR

Two independent causes, both fixed today:

1. **The app-wide Firestore emit tax (P0-1 in CHAT-FORENSICS-PERF.md).** Julie is an
   Owner → `canSeeLabor` → her phone held the two 42k-doc `laborHistory` listeners,
   so every shift write on her iPhone paid ~3 × (110–150 ms × phone factor) of SDK
   bookkeeping. Her audit trail (below) shows the burst of edits at 12:23–12:42 PM
   today was made on v1.0.421; she signed in on **v1.0.422 at 12:41 PM** (fix live).
2. **Schedule's own edit path had no latency compensation.** Every time-edit /
   drag-move / offer / claim goes through `runTransaction` (Phase F drift checks).
   Firestore transactions bypass the local store — **nothing changes on screen until
   the server commits and the listener echoes it** (2–3 round trips), and the editor
   /confirm dialog then also `await`ed one or two `notify()` server acks. On store
   Wi-Fi that is 0.5–3 s of "did it take?" per edit — the "edits lag", and the "try
   again / it reverted" impression when the transaction retried or a cache-first
   emit painted first.

**Shipped (v1.0.423):**
- **S1** optimistic overlay for the transaction paths (`src/data/optimisticShifts.js`
  + `applyOptimisticShift` / `revertOptimisticShift` in Schedule): the cube moves /
  changes times **immediately**, the transaction confirms in the background, a
  failed transaction reverts + toasts, and every incoming snapshot is re-overlaid so
  someone else's echo can't visually undo an in-flight edit. Entries settle when the
  server echo matches, are dropped when the shift leaves the window, and expire at
  20 s. **The write itself is unchanged** — same transaction, same drift check, same
  fields — so nothing about what reaches Firestore is different.
- **S2** `notify()` no longer awaits the server ack of the notification doc (it is
  latency-compensated + persisted offline by the SDK; the Cloud Function dispatches
  when it lands). Removes 1–2 server round-trips from every edit/move handler.
- **S3** Add Shift closes the modal on tap (id pre-minted, `setDoc` instead of
  `await addDoc`); the grid already showed the cube via the SDK's local echo. Same
  document written; the await now sits at the end purely to surface a rejection toast.
- **S4** shifts listener: cache-origin emits (`metadata.fromCache`) no longer flip
  the Live pill green or rewrite the 24-h instant-paint slot; only server-confirmed
  snapshots do. Uses `includeMetadataChanges` (needed to *see* the cache→server
  flip) but only touches `shifts` state when documents actually changed.
- Inline cube nudge / inline time edit leave edit mode immediately (they no longer
  await the handler).

**Measured (dev build, Mac, live prod data, own draft shift; before → after):**

| Action | Before v1.0.422 (v421 code) | v1.0.422 (emit tax gone) | v1.0.423 (this batch) |
|---|---|---|---|
| Add Shift → modal closes | after server ack (~200–600 ms) | 11 ms | **31 ms** (kept) |
| Add Shift → cube visible | after server ack | with local echo | **70 ms** |
| Save time (edit modal) → cube shows new time | after txn commit + echo (~200–600 ms; seconds on phone) | same | **26 ms** |
| Save time → editor busy | txn + notify RTTs | txn + notify RTTs | **25 ms** |
| Delete → cube gone | ~50 ms (deleteDoc has local echo) | 52 ms | 52 ms |
| Long tasks during add/edit/delete | 3–8 × 100–160 ms | 0 | 0 |
| Firestore views on Schedule (docs) | 22 (43,229) | 22 (~690) | 22 (~690) |

Server-truth check after the flow (admin read): shift created → edited to 17:00 →
deleted; week 8/9 total back to 210; no duplicates, no orphans. 883 tests green
(11 new for the overlay).

## 1. Julie's edits (audit trail, America/Chicago)

`audit` rows by "Julie Shih", 2026-08-15: 12:23:51 Marjorie 15:00→11:00 (doc 9tM5…);
12:25:19 Marjorie 10:00→11:00 (a *different* doc, ixQe…); 12:35:51 Marjorie
11:00→10:00 (9tM5…); 12:36:12 Marley end 19:00→20:00; 12:38:40 Enzo 10:00→11:00;
12:42:19 Carl 11:00→10:00. All are distinct, coherent edits (no ping-pong on one doc,
no lost writes). Device: iOS native app; `lastSignInVersion` = **1.0.422 · e66bd69 at
12:41:51 PM** — i.e. the 12:23–12:38 edits ran on the pre-fix bundle with the 42k-doc
tax; the app updated mid-session via the deploy broadcast. Zero `error_logs` /
`system_logs` rows mention her.

## 2. Confirmed findings (31 of ~54 claimed; 45-agent read + verify)

**P1**
- Transactions have no latency compensation → grid updates only after commit + echo;
  editors/confirm dialogs stay busy through the full chain incl. awaited `notify()`.
  *(fixed: S1, S2, inline editors)*
- Same, seen through the drag/drop + ConfirmModal path (`askDropShift → onConfirm →
  handleDropShift` awaited; two sequential `await notify`). *(S1 paints the move
  instantly; S2 removes the notify RTTs; the ConfirmModal still waits for the
  transaction ack before closing — deliberately kept as the one "are you sure" that
  should not vanish before the server agrees.)*

**P2**
- Add Shift modal blocked on server ack. *(fixed: S3)*
- First onSnapshot emit is served from the persistent cache but was treated as live
  (pill + 24 h slot rewrite). *(fixed: S4)*
- Notification fan-out = N individual `addDoc`s per action (publish ≈ 20–30 docs);
  each awaited in loops in some paths. *(S2 stops the awaits; batching is a
  follow-up — see §3)*
- Duplicate app-wide + page listeners for `shifts` (14-day + week) and `time_off`
  (×3 incl. a legacy `date>=` query with 0 docs). ~700 docs total post-P0-1 → 1–2 ms
  per emit; not a lag driver now. *(left; note in §3)*
- `staffing_needs` filled-slot bookkeeping is a non-transactional read-modify-write
  from local state; auto-fill / generate-recurring dedupe only against local `shifts`.
  *(pre-existing correctness debt, not lag; §3)*
- Watchdog `escalateReload` can reload the whole app 18 s after ANY hung write, incl.
  a transaction stuck on a slow-but-alive link. *(left; the SyncPill shows the state;
  revisit if reload-mid-edit reports appear)*
- Every shifts tick JSON.stringifies ~110 KB to localStorage. *(now skipped on
  metadata-only flips; real data ticks still write — 1–3 ms)*

**P3 (verified mechanics, second-order)** — full derivation chain re-runs per shifts
tick (sub-ms at DD Mau scale), WeeklyGrid re-renders all cells per drag-hover cell,
Schedule consumes the whole `useAppData()` value (re-renders on any home-data tick),
ShiftCube comparator omits a few rendered fields, `closedByDate` memo misses
`closedWeekdays`, listeners' error handlers stop without resubscribe.

**Rejected after verification (not real / not contributory):** "unbounded listeners"
(all windowed, ~690 docs), AvailableStaffModal O(staff×shifts) (bounded to modal),
time_off linear scans (104 docs), `reviveFirestore('stale-view')` on contention
(mechanically true, harm claims didn't hold), ShiftCube memo drift (no visible bug).

## 3. Follow-ups (ranked; none are lag drivers today)

1. **Batch notification fan-out** (publish / bulk paths): one `writeBatch` per action
   instead of N `addDoc`s — fewer emits, atomic. P2.
2. **`staffing_needs` filled-slot RMW → transaction** keyed on the need doc. P2.
3. **Auto-fill / recurring dedupe** against a fresh `getDocs` of the target week (copy-
   week already does this). P2.
4. Drop the legacy `time_off date>=` listener (0 docs) and let Schedule read the
   context's `time_off` instead of its own 6-month copy. P3.
5. Batch the shifts-listener localStorage write with an idle callback. P3.
6. `useAppData` selector split so Schedule doesn't re-render on chat-notification
   ticks. P3.

## 4. What did NOT change (safety)
- Every write primitive and payload is identical to v1.0.422: transactions, drift
  checks, `reminderSent` re-arm, offer-state resets, audit rows. S3 swaps `addDoc`
  for `setDoc` on a client-minted id — same doc, same rules path (permissive
  catch-all), and the id is what `auditShiftChange` records.
- The overlay only touches the local `shifts` array; it never adds or removes a
  shift (unit test "no shift loss"), reverts on failure, and self-expires.
