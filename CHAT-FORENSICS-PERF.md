# CHAT FORENSIC REPORT v2 — PERFORMANCE — DD Mau Portal
**Date:** 2026-08-15 · **Auditor:** Claude · **Baseline build:** v1.0.421 (prod bundle) · **Method:** JS Self-Profiling API + Long-Task observer + Firestore SDK view introspection, driven headlessly in Chrome (mobile layout 430×900, admin identity "Andrew Shih", cache-warm)

> Companion to [CHAT-FORENSICS.md](CHAT-FORENSICS.md) (2026-08-11) which covered
> architecture, security, send semantics, and reliability (F1–F9, repair batch C1–C8
> shipped v1.0.404). **This report is the performance forensics** Andrew asked for
> after "chat is still rough / needs to be very smooth". It does NOT repeat the
> architecture sections that are unchanged — see §1 for pointers — and it records
> **measured** before/after numbers, not impressions.

---

## 0. TL;DR

**Chat itself was not the bottleneck.** The lag came from OUTSIDE chat: two
always-on Firestore listeners in `AppDataContext` (`laborHistory_webster` /
`laborHistory_maryland`, 28-day windows) held **42,561 documents** in memory for
every manager/admin. The Firestore SDK re-scans every resident document of every
active view on every emit (each local write, each server echo, each ack —
`View.applyChanges → updateLimboDocuments`). That cost **~110–150 ms of main-thread
time per emit** and there are ~3 emits per typing heartbeat, per send, per
read-marker, per incoming message. Result: **94% of CPU during typing was
Firestore bookkeeping**, 8 long tasks (~1 s) per send, ~600 ms of stalls per chat
open, 85 MB heap, 7.9 MB of localStorage re-serialized every 2 min. And the data
fed nothing — `aggregateSplh` needs `totalHours`, which **no laborHistory row
carries**, so the SPLH grid it powered was empty.

**Fixed (P0-1)** by removing those listeners (context API preserved, mirror
purged) and **(P1-1)** progressive first paint of the thread (last 20 messages
first, rest one frame later). Same benchmark, same machine, prod bundle:

| Metric (prod build, mobile layout, admin) | Before v1.0.421 | After | Δ |
|---|---|---|---|
| Idle 3 s — busy samples (Firestore) | 18 (17) | 1 (0) | −94% |
| Open chat A (Webster FOH, 50 msgs) → composer visible | 35 ms | 25 ms | — |
| … main-thread busy in the 3 s after tap (Firestore) | 107 samples ≈ 1.07 s (64) | 11 ≈ 0.11 s (6) | **−90%** |
| … long tasks (>50 ms) after tap | 5, total 636 ms, max 146 ms | **0** | −100% |
| Open chat B (DM) → composer | 19 ms | 24 ms | — |
| … busy (Firestore) / long tasks | 57 (53) / 5 = 612 ms | 7 (2) / **0** | −88% |
| Typing 11 keystrokes — busy (Firestore) | 288 ≈ 2.9 s (272 = 94%) | 73 (8) | **−75%** CPU, −97% Firestore |
| … long tasks | 25, total 3,178 ms, max 185 ms | 0 app long tasks¹ | −100% |
| Send tap → own bubble visible | 260 ms | **36 ms** | −86% |
| Send tap → server ack (Sending… cleared) | 619 ms | **181 ms** | −71% |
| … busy (Firestore) / long tasks | 88 (70) / 8 = 970 ms | 9 (2) / **0** | −90% |
| JS heap after the run | 85 MB | 17–20 MB | −77% |
| localStorage | 7.89 MB | 0.13 MB | −98% |
| Active Firestore query views on a chat thread | 18 (42,561 docs) | 16 (~410 docs) | −99% docs |

¹ the single 1,258 ms "long task" recorded in the after-run's typing window is the
benchmark's own trace post-processing (5,873 samples walked in-page); busy=73
samples proves no app task of that size existed.

Dev-mode profile of the same path (before fix): 137 of 149 busy samples during typing
were `syncEngineEmitNewSnapsAndNotifyLocalStore → applyChanges → updateLimboDocuments
→ DocumentKey compare` (`__PRIVATE_compareUtf8Strings` alone = 78% self time).

Everything else measured in chat is already sound (list paints from cache instantly,
send is optimistic, memo comparators hold, no idle CPU, no leaks observed across
repeated open/close). The remaining work is P1/P2 hygiene, not P0.

---

## 1. Architecture (pointers — unchanged since 2026-08-11)

- **Client:** React 18 + Firestore JS SDK 11.10 (persistent IndexedDB cache),
  `ChatCenter.jsx` (list) → lazy `ChatThread.jsx` (thread + Composer). Firestore
  primitives are shadowed through `firestoreRevive` (`watchdogWrite/Read`).
- **Realtime:** Firestore `onSnapshot` over WebChannel. Views on a thread:
  `chats` (members array-contains me, orderBy lastActivityAt, limit 100),
  `chats/{id}/messages` (createdAt desc, limit 50 + Load-older), `chats/{id}/acks`
  (mine, limit 200), `scheduled_messages` (mine/pending, limit 20). App-wide
  (AppDataContext + App.jsx): `config/minVersion`, `config/forceRefresh`,
  `config/staff`, `announcements` (20), `notifications` (mine, 100), `shifts`
  (14-day window), `time_off` (180-day window), `ops/86_*`, `ops/labor_*`,
  `offsite_shifts` (mine, 100).
- **Database:** `/chats/{id}` doc = membership + `lastMessage` preview +
  `lastActivityAt` + `lastReadByName{}` + `typingByName{}`; `/messages` subcollection;
  `/notifications` fan-out queue (server-side `onChatMessageCreated`, opt-in
  `serverFanout` stamp) → `dispatchNotification` → FCM / APNs.
- **State:** per-component `useState` + module caches (`_msgCache` + localStorage
  warm-paint for last 30 msgs/chat, chat-list mirror). Single source of truth =
  Firestore snapshot; caches are paint-only.
- **Send lifecycle:** Composer → `sendMessage` (addDoc, local echo via
  `hasPendingWrites` → "Sending…" until ack) → CF updates preview + fans out
  notifications → recipients' `chats` + `messages` listeners.
- **Security:** unchanged from F1 — `/chats/**` world read/write; enforcement
  waits on Firebase Auth (SAAS-PLAN Phase 3). Not re-audited here.

## 2. Measurement harness (repeatable)

- Local dev/preview servers now send `Document-Policy: js-profiling`
  (`vite.config.js` `server.headers` / `preview.headers`) so `new Profiler()` works
  in-page. GitHub Pages does not emit it → no production effect.
- Bench script (`scratchpad/chat-bench.js`, kept out of the repo): idle 3 s →
  open chat A → back → open chat B → 11 keystrokes → send; each phase samples the
  main thread at 10 ms (Chrome's floor) and records long tasks. "busy" = samples
  with a non-empty stack ≈ ms/10 of main-thread work. Waits are MutationObserver-
  based (immune to hidden-tab timer throttling).
- Firestore views enumerated via `db._firestoreClient._onlineComponents.syncEngine`
  (dev build): query path/filters/limit + `view.documentSet.size`.

## 3. Root cause of the lag (P0-1) — evidence chain

1. Typing profile (dev): 149 busy samples over an 11-char burst; **137 inside
   `syncEngineEmitNewSnapsAndNotifyLocalStore`**; leaf = `compareUtf8Strings` (116).
2. `syncEngineEmitNewSnapsAndNotifyLocalStore` iterates **all** query views and
   calls `View.applyChanges`, which calls `updateLimboDocuments()` — a full
   `documentSet.forEach(doc → syncedDocuments.has(key) && documentSet.has(key))`
   pass over EVERY doc in the view, on EVERY emit (local write, remote echo, ack).
3. View census on a chat thread: 18 views; `laborHistory_webster` = **21,282 docs**,
   `laborHistory_maryland` = **21,279 docs**; everything else totals ~410.
4. Rows are written by the labor scraper every ~2 min, 24/7 (735 rows/day/location;
   the code comment said "~1,500 docs" — reality was 21k per location and growing
   nowhere: the 28-day window is a sliding constant ~42k).
5. Cost per emit ≈ 110–150 ms (M-series Mac). Emits per action: own write = 3
   (local apply, server echo, ack); incoming message = 1–2; each typing heartbeat
   (every 2 s while typing) = 3; each read-marker = 3. Phones are 2–4× slower.
6. Zero value: `aggregateSplh(history)` skips any row without numeric
   `totalHours > 0`; the collection's field set is `{time, netSales, date,
   timestamp, laborCost, laborPercent}` → grid always empty; Schedule's
   `SplhAdvisor` no longer even reads it (weather-only since the glass restyle);
   LaborDashboard's SPLH grid rendered "Last 28 days · 21283 samples" over an empty
   table.
7. Side taxes: 7.7 MB localStorage mirror parsed at boot (40 ms desktop) and
   re-`JSON.stringify`'d on every new row (every 2 min, both locations); 42k docs
   in the persistent cache (heap 85 MB vs 17 MB after); 42k document reads on
   every cold cache for every manager/admin device (also $).

**Fix:** listeners + hydrate + mirror removed from `AppDataContext.jsx`;
`laborHistory`/`laborHistoryByLoc` remain in the context as a frozen empty pair
(consumers unchanged; both already treat `[]` as "no data"; the empty SPLH grid is
now honestly hidden). Legacy `ddmau:splh:*` keys purged at module load. Regression
test `src/v2/appDataListeners.test.js` pins: no `laborHistory_` subscription in the
provider, and the provider's collection queries are exactly the enumerated bounded
set (`notifications` limit 100, `shifts` 14-day, `time_off` 180-day).

## 4. Secondary finding (P1-1) — first commit of the thread

After P0-1 the biggest remaining stall on chat-open was the first React commit of
50 `MessageBubble`s (~200 ms on Mac in the after-run where the chunk was cold; the
mount itself ~90 samples). Since the viewport is pinned to the bottom, only the
newest ~6–8 bubbles are visible on open. **Fix:** paint the last 20 first, flip to
the full window on the second animation frame (120 ms timer fallback for hidden
tabs). ResizeObserver already re-pins scrollTop before paint when the older rows
land, so nothing jumps; jump-to-message's scroll timer bumped 60→160 ms to be safe.
Result: chat open = 11 busy samples, 0 long tasks (table above).

## 5. Verified NOT problems (measured; don't "fix")

- **Chat list load:** paints from the localStorage mirror synchronously; first live
  snapshot replaces it (< 1 s). Back-to-list = 0 ms.
- **Re-render fan-out:** `chatDocEqual` reuse + `MessageBubble` memo comparator
  (string sigs for lastReadByName/members) hold — typing heartbeats from others no
  longer re-render the thread (see 2026-07-21/27 audits). Idle CPU = 0–1 sample/3 s.
- **Duplicate listeners:** none — one `chats` view, one `messages` view per open
  thread; the Load-older resubscribe tears down before re-opening.
- **Message limit / pagination:** 50 + Load-older (server-confirmed `hasMore`),
  cap 2000; content-visibility rows. Fine at DD Mau's volume (see F8 cliffs).
- **Send path:** optimistic (36 ms to own bubble), ack 181 ms; server fan-out CF
  live; no double-send (pointerup + click guarded, mic ghost-tap guard v1.0.421).
- **Memory:** heap flat across repeated open/close after the fix (17→20 MB).
- **Chunk loading:** ChatCenter + ChatThread are prewarmed after login
  (`prewarmChunks`) and again on ChatCenter mount; only a truly cold cache pays it.

## 6. Open items, ranked (nothing here is why chat was laggy)

| # | Pri | Item | Why / plan |
|---|---|---|---|
| 1 | P1 | Firestore-emit tax is O(total resident docs) app-wide | Every page's always-on listener taxes chat. Keep AppDataContext bounded (test now enforces); when adding pages, prefer page-scoped listeners that unmount. Candidates to shrink further: `shifts` 14-day (129 docs) could be 7-day for the home tiles; `time_off` 180-day (104) could be 60-day. Low value now (~410 docs ≈ 1–2 ms/emit). |
| 2 | P1 | Typing indicator = Firestore write per typer per 2 s | Still 3 emits per heartbeat for the typer and 1 for every member's `chats` view. Cheap now, but it's the largest remaining self-inflicted write volume. Option: throttle to 4 s + skip heartbeat when the draft is < 2 chars; or move to RTDB/ephemeral. F8. |
| 3 | P1 | ChatCenter mount sweeps ≤1,500 unread notifications with a getDocs + ≤450-op batches | Each batch = up to 450 doc mutations = 3 emits with 450 changed docs. Only bites users returning after long absences; `pruneNotifications` (C5) shrinks the backlog nightly. Consider a `type in [...]` filter to skip non-chat rows entirely (needs composite index). |
| 4 | P1 | Labor SPLH feature is dead data | Rebuild as a server-side hourly rollup (`labor_hourly_{loc}/{date}`, ~28 docs/loc) that includes labor **hours** (derivable server-side from scraped timecards); never re-add raw rows client-side. Separate labor project, not chat. |
| 5 | P2 | Load-older re-streams the whole window (50→100→150) | Quadratic; fine at current depth. Cursor pagination (`startAfter` + separate older-slice listener) when a chat passes ~1k messages. F8. |
| 6 | P2 | No list virtualization | Content-visibility rows carry it to ~2k messages; virtualize past that. F8. |
| 7 | P2 | `MessageBubble` still receives the whole `chat` object | Comparator handles it, but a props diet (only what bubbles read) would shave the per-snapshot compare cost. |
| 8 | P0 (unchanged, cross-app) | Security — no server-side access control on `/chats/**` | F1; needs Auth + membership rules (SAAS-PLAN Phase 3). Not a perf item; listed so it isn't forgotten. |

## 7. Regression tests added
- `src/v2/appDataListeners.test.js` — provider must not subscribe to
  `laborHistory_*`; provider collection queries must equal the enumerated bounded
  set; `laborHistory` context value is the frozen empty pair. (872 tests green.)

## 8. Operational notes from this session
- Two accidental benchmark messages ("bench-…" ×2 to Marley Chandler's DM,
  "perf-probe-…" ×1 to Webster FOH) were sent by the first bench run before the
  target selector was fixed. All three message docs, their chat previews, and 22
  matching notification docs were removed via a one-off admin script; the pushes
  themselves had already gone out — Andrew should expect a "what was that?" from
  Marley / FOH.
- The dev/preview `Document-Policy: js-profiling` header stays in `vite.config.js`
  for future measurement; it has no production footprint.
