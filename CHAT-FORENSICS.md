# CHAT FORENSIC REPORT — DD Mau Portal
**Date:** 2026-08-11 · **Audit type:** READ-ONLY (no code changed) · **Auditor:** Claude

> **STATUS UPDATE (same day, v1.0.404):** the repair batch SHIPPED. C1 (watchdog
> parity), C2 (per-message send states + non-blocking composer), C3 (server-side
> fan-out via `onChatMessageCreated`, opt-in `serverFanout` stamp), C4
> (conversation-level push deep links via `data.chatId` + `chatDeepLink.js`),
> C5 (`pruneNotifications` nightly, 3:40 AM CT — ~9.4k-doc backlog clears in ~3
> nights), C6 (`findLiveDmId` resolver + prod data fix: "Fui jun Mok" was an
> invisible member of Webster FOH + one DM), and C8 (file attachments —
> pdf/doc/xls/ppt/csv/txt, 25MB, storage.rules extended). C7 was double-checked
> and deliberately NOT shipped: the /chats rules block is OR'd with the open
> catch-all (not carved), so constraints there are dead code without the
> carve-out surgery that caused the 2026-07-12 outage; real enforcement is the
> Auth project. Verified live: CF fan-out proven end-to-end (preview + tagged
> notification with chatId in the debug_agent chat), 831 tests green, prune
> query dry-run confirmed index-free. Sections below are the original
> pre-batch audit — read F1–F9 with this update in mind.
**Scope:** ChatCenter, ChatThread, chat.js, chatDm.js, chatPermissions.js, chatSearch.js,
notify.js, firestore.rules, storage.rules, functions/index.js (dispatchNotification),
firebase-messaging-sw.js, capacitor push routing, renameStaff.js — plus live prod probes.

---

## 1. Architecture (what actually powers chat)

There is **no WebSocket server, no Socket.io, no REST API layer**. Chat is
**Firestore-native, fully client-driven**:

```
sender device                         Firestore                      recipient devices
─────────────                         ─────────                      ─────────────────
Composer → sendMessage()
  1) addDoc /chats/{id}/messages ──►  message doc      ──onSnapshot──► ChatThread renders
  2) fire-and-forget:                 chat doc          ──onSnapshot──► ChatCenter list row
     updateDoc chat preview/          (lastMessage,                     updates + unread dot
     lastActivityAt/typing clear      lastActivityAt)
  3) fire-and-forget: N × addDoc  ──► /notifications ──onDocCreated──► dispatchNotification CF
     (one per recipient)                                               → FCM/APNs push + badge
```

- **Realtime** = Firestore onSnapshot over its internal gRPC/WebChannel stream, with
  `persistentLocalCache` (IndexedDB). Reconnect/catch-up/dedup/resume-token handling
  is entirely the SDK's; there is no app-level "fetch missed events" — the snapshot
  re-delivers the full query window on reconnect, which IS the catch-up mechanism.
- **Ordering** = `orderBy(createdAt)` on server timestamps. Server-authoritative;
  device clocks are never trusted. Pending local writes bucket to "Today" defensively.
- **Push** = client writes `/notifications` docs → `dispatchNotification` Cloud
  Function → FCM (data-only payload, per-platform apns/android blocks, OS-level `tag`
  collapse, iOS badge = server `count()` of unread).
- **Platforms**: identical JS on native iOS/Android (Capacitor WKWebView/Chromium),
  desktop web, mobile web (mobile web browsers are gated to the download page on
  purpose — v1.0.245). No PWA-specific chat path beyond the FCM service worker.

## 2. Source of truth (per concern)

| Concern | Canonical store | Copies | Can they disagree? |
|---|---|---|---|
| Messages | `/chats/{id}/messages/{autoId}` | module-level `_msgCache` (last 50/chat, 25 chats), Firestore IndexedDB cache | Cache is paint-only; snapshot revalidates. Safe. |
| Chat list / membership | `/chats/{id}.members[]` (staff **names** — the app-wide join key) | none | Rename fan-out rewrites members (see F7 for the DM-id gap). |
| Read state | `chat.lastReadByName{name→ts}` (one marker per member per chat) | — | Single marker = "read up to lastActivityAt". No per-message counts. |
| Unread **dot** (per chat) | derived: `lastReadByName[me] < lastActivityAt` | — | correct by construction |
| Unread **badge** (Chat tab / app icon) | `/notifications` unread of chat types | separate from lastReadByName | **Yes — two systems** (F6). |
| Typing | `chat.typingByName{name→ts}` (persistent doc!) | client TTL filter (5s) + expiry timer | self-healing since 7/26 |
| Reactions/polls | inline on message, `arrayUnion/arrayRemove` dot-paths | — | atomic, no clobber |
| Acks | `/chats/{id}/acks/{msgId}_{name}` | `myAcks` Set (bounded 200, indexed) | OK since N7 fix |
| Attachments | Storage `chats/{chatId}/{storageId}.{ext}` + URL on message | — | stable path per staged file (M11) |

## 3. Message identity & dedup

- ID = Firestore `addDoc` auto-id. **One mutation, exactly-once by the SDK's
  mutation queue** (a queued write survives app kill and is not re-minted on retry).
- Double-tap: `sendingRef` (synchronous ref, not state) — correct.
- Failed-send queue captures the body **before** clearing the composer; the N8 fix
  clears the draft when queued so Retry + composer-send can't post twice.
- **No client idempotency key** — acceptable *because* the architecture has exactly
  one write per message and no HTTP+socket dual path. The classic dual-delivery
  dupe vector doesn't exist here.
- Verdict: **duplicate-message risk is LOW.** The historical dupe reports (fixed
  2026-05-22/07-22) match the audit trail; no open dupe vector found.

## 4. Send flow — measured semantics

Tap Send → `handleSendText` → `sendMessage`:
1. `addDoc` message — **the only awaited step**. Local latency compensation renders
   the bubble instantly from cache (own snapshot fires in ~0–5ms).
2. Chat preview/lastActivityAt/typing-clear — detached, best-effort.
3. Per-recipient `/notifications` addDoc fan-out — detached, best-effort.

Online: perceived send ≈ instant; server ack typically 100–400ms; recipient render =
their snapshot fan-out (sub-second on the same Wi-Fi); push = CF cold/warm start
(~0.5–3s) + FCM/APNs.

**Prod scale (probed 2026-08-11):** 47 chat docs (35 live: 24 DMs, 11 groups),
**758 total messages**, largest chat 252 (Webster FOH, 21 members).
`/notifications`: **15,838 docs, 7,154 unread**. Every perf ceiling below is
evaluated against this reality — the system is ~2 orders of magnitude below its
first real perf cliff.

## 5. CONFIRMED FINDINGS (open — ranked)

### F1 · P0 · Security — chat has no server-side access control at all
`firestore.rules:700`: `/chats/**` is `allow read: if true`, create/update
`if request.resource.data is map`, `allow delete: if true`. Same for messages.
`storage.rules:124`: `chats/{chatId}/{file}` world read/write (≤250MB)/delete.
`/notifications` world-readable (leaks every message preview independently).
Anyone with the public apiKey (shipped in the JS bundle) can read every DM, write
messages as anyone, delete any chat, and dump/delete chat media.
**Root cause is architectural:** the app has no Firebase Auth — identity is a
client-side PIN; rules cannot reference a user. This is the documented SAAS-PLAN
Phase-3 blocker, not a chat-specific oversight — but chat (private DMs between
staff) is the highest-sensitivity surface inheriting it.
*Interim hardening that does NOT require auth:* kill `allow delete` on /chats +
messages (soft-delete only — client already soft-deletes; the two hard-delete flows
can tombstone instead), add shape/size constraints on message create, cap Storage
delete. Full fix = Auth + membership rules (Phase 3).

### F2 · P1 · Reliability — chat is NOT covered by the Firestore-revive watchdog
Zero `watchdogWrite`/`watchdogRead` in ChatThread, ChatCenter, chatDm, notify.
Consequences on a wedged transport (the app's known #1 disease class, fixed
elsewhere in v386–396):
- `addDoc` never settles → `sendingRef`/`sending` stay true → **composer disabled
  indefinitely**, no error, no retry queue (Firestore doesn't *reject* on network),
  no SyncPill (chat writes bypass the in-flight counter).
- Same for mark-read, reactions, edits, deletes, typing.
Mitigation today is only the global 3-min liveness probe + visibility/online revive
(v396) and the 15s *subscription* timeouts. Writes have no watchdog. This is the
exact class Julie hit on staff-delete before v396 — chat is the biggest remaining
uncovered surface.

### F3 · P1 · Reliability — notification fan-out lives and dies on the sender's device
Push fan-out = N client-side `addDoc`s fired **after** the message write, detached.
Send-and-pocket (send, lock phone — the normal restaurant gesture) can kill the
WebView before the fan-out flushes → message delivered, **zero recipients pushed,
zero bell entries, silently**. No server-side `onDocumentCreated(chats/*/messages/*)`
trigger exists to do this robustly. Same fragility applies to the chat-preview
update (list rows can go stale vs. thread content — "lastMessage shows the older
text"). This is the most likely root cause of any "I didn't get notified" report
that isn't a token/OS issue.

### F4 · P1 · UX-correctness — no per-message send states; offline send locks the composer
There is no Sending/Sent/Failed indicator on bubbles (`hasPendingWrites` is never
read). Offline or on very slow Wi-Fi: the message *appears* (cache echo) but
`await addDoc` doesn't resolve → composer stays disabled with a generic "sending"
until connectivity returns. User can't send a second message and can't tell whether
the first one went. On weak restaurant Wi-Fi this reads as "chat is frozen".
(The failed-send queue only catches *rejections* — permission errors — not
network stalls, which are the common case.)

### F5 · P2 · Push routing — deep links are tab-level, never conversation-level
Every chat push carries `deepLink: 'chat'`. Tapping "Julie: are we out of mint?"
opens the chat **list**, not the DM. The unread-first sort mitigates, but the
notification `tag` already encodes `chat:{chatId}:{to}` — the id is available end
to end (SW `notificationclick` + native tap handler both forward only the tab).

### F6 · P2 · Unread — two parallel unread systems
Per-chat dot = `lastReadByName` (correct). Tab badge + iOS app badge =
`/notifications` unread of chat types, swept to read only when ChatCenter mounts
(capped 1500/visit). Reading a chat on device A clears the dot everywhere but the
badge math is separate; a user who reads via the thread but never revisits the tab
root keeps a stale badge. Also **notifications are never pruned**: 15.8k docs,
7,154 unread — inactive staff accumulate unread forever, the iOS badge `count()`
runs against a growing index on every dispatch, and badge numbers become
meaningless (four-digit badges for dormant accounts).

### F7 · P2 · Identity — dmDocId comment-vs-code drift + rename forks DMs
`chat.js:56` comment claims "normalize whitespace + lowercase the key"; the code
only `trim()`s — **no lowercasing, no inner-whitespace collapse**. Live specimen in
prod: `dm_Enzo  Gilbonio__Marley Chandler` (double space). Case- or
whitespace-variant name data forks a pair into two threads.
Worse: `renameStaff.js` rewrites `members[]`/`lastReadByName` in existing chats but
**cannot rewrite the name-embedded DM doc id** — after a rename,
`dmDocId(newName, other)` computes a *different* id, so "New chat → same person"
creates a second, parallel DM thread while the old one still lists.

### F8 · P3 · Perf headroom (fine today, cliffs documented)
- No virtualization; window capped at 50 (+50 per Load-older, max 2000). At 758
  total prod messages this is a non-issue; first real cliff ≈ several-thousand-
  message chats (Load-older also re-streams the whole window per tap — quadratic).
- Typing = a Firestore **write per typer per 2s** fanned out to every member's
  chats-listener. Ephemeral data in a persistent doc — wasteful by design, but at
  35 chats/30 staff it's noise. (Row-memo + chatDocEqual already stop the rerender
  cascade.)
- ChatSearchPanel = client-side: up to 200 msgs × N chats per open (documented
  trade; fine at current scale, server-side search needed ~10k+).
- Read-marker writes debounced 1.5s; media: images resized to 1600px client-side,
  `preload="none"` videos, lazy images. Sound.

### F9 · P3 · Misc (verified, low)
- `sendDirectMessage` (chatDm.js) duplicates the send pipeline minus mentions —
  a second code path to keep in sync (already drifted once: no `forceDeliver`).
- Composer draft is per-mount state: switching chats or leaving the tab loses a
  typed draft (no per-conversation draft persistence).
- Group `admins[]`/`createdBy` survive member-removal: a removed member who is
  also in `admins[]` retains edit rights if re-added paths race (minor; and
  server can't enforce membership anyway until F1).
- `notifications` badge sweep + `chats` listener both cap at 100/1500 — documented,
  fine at scale.

## 6. What already WORKS (verified; don't re-fix)
The 2026-05→07 audit trail already closed: double-send (sendingRef), stale-first-
paint (msgCache), wrong-200-window, load-older scroll restore (N5), fromCache
hasMore trap (H4), mark-read at-bottom gating + cap-bug (P2), scroll-freeze
(rAF + memo + signature props), typing-indicator stuck-forever, announcement
composer lockout (C1), DM soft-delete resurrect (H4-7/26), ack index (N7),
mention/reply tags not buried (bug #5), upload progress + cancel + stable retry
path (M10/M11), Safari TDZ lazy-import pattern, keyboard/viewport handling
(dvh + visualViewport re-anchor), Android back-stack, per-chat error boundary,
push prod/sandbox APNs fallback, SW/native tap → chat tab, bilingual everything.
Ordering, dedup, and crash-recovery are genuinely solid.

## 7. Why chat "breaks" (root-cause summary)
1. **Same disease as scheduling had:** wedged Firestore transport after
   background/suspend, and chat is now the largest surface *without* the watchdog
   coverage the rest of the app got (F2). Symptoms: frozen sends, stuck spinners,
   Retry screens.
2. **Client-side fan-out fragility** (F3): delivery of *notifications* depends on
   the sender's WebView surviving ~1–3s after send. Messages never vanish;
   *pushes* do.
3. **No send-state feedback** (F4): the system is actually behaving (queued write,
   will deliver) but looks broken, so users retype/refresh.
4. Everything else historically reported traces to already-fixed bugs above.

## 8. Recommended repair plan (phased, each independently shippable)
- **Phase C1 — Watchdog parity (highest value/effort ratio):** shadow-the-primitives
  in ChatThread/ChatCenter/chatDm/notify (`watchdogWrite` on addDoc/updateDoc/
  deleteDoc, `watchdogRead` on getDoc(s)); SyncPill then covers chat for free.
- **Phase C2 — Honest send states:** per-message Sending (hasPendingWrites) /
  Failed chips; stop gating the composer on server ack (allow queueing next
  messages while one is in flight offline); keep the failed-send queue for
  rejections.
- **Phase C3 — Server-side fan-out:** `onDocumentCreated('chats/{c}/messages/{m}')`
  Cloud Function does preview update + notification fan-out; client fan-out becomes
  a fallback (or is removed). Kills F3 and halves client write volume per send.
- **Phase C4 — Conversation deep links:** `deepLink: 'chat:{chatId}'` end-to-end
  (dispatcher already forwards; SW + native handler + App.jsx parse; ChatCenter
  auto-opens id). Small.
- **Phase C5 — Notification hygiene:** nightly prune CF (read >30d, unread >90d),
  badge = capped realistic count.
- **Phase C6 — DM identity:** implement the normalization dmDocId already claims
  (casefold + whitespace-collapse) with a one-shot migration for existing ids;
  make renameStaff DM-aware (tombstone old id → pointer to new).
- **Phase C7 — Security (the big one, cross-app):** Firebase Auth + membership
  rules per SAAS-PLAN Phase 3. Until then, the F1 interim hardening (no
  hard-delete, shape constraints) is worth shipping.
- **Not recommended now:** virtualization, server-side search, RTDB typing —
  all below the scale threshold; revisit at ~10× message volume.

## 9. Missing tests / telemetry
- No unit tests for isChatUnread edge cases (sender-of-last-message, missing ts),
  dmDocId normalization, or the send-state machine (none exists yet).
- No metric for "notification fan-out completed" (F3 is currently invisible);
  a single `fanOutDone: true` stamp on the message (set by the last detached step,
  or free with Phase C3 server-side) would make drops measurable.
- Breadcrumbs (chat.open/send/back) + Sentry already good.
