// attendance.js — clock-in punctuality recorder (Andrew 2026-06-25).
//
// WHY: the Toast scraper writes a single LIVE doc per location
// (ops/clocked_in_{location}) that it OVERWRITES every ~90s — it keeps no
// history. So on-time / late / no-show was only ever visible in the moment
// (ClockedInPanel computed it live and threw it away). This module PERSISTS
// it: every time the scraper updates the clocked-in roster we match each
// clock-in to that person's scheduled shift and write one durable
// `attendance` doc per (location, date, staff). A nightly sweep flags
// scheduled-but-never-clocked-in shifts as no_show. The admin Attendance Log
// reads these docs to show 4-week counts + a month/week drill-down.
//
// Classification mirrors ClockedInPanel.getPunctuality EXACTLY:
//   • clocked in ≤5 min after scheduled start (or early) → on_time
//   • clocked in  >5 min after scheduled start           → late
//   • scheduled, never clocked in by end of day          → no_show
//
// Idempotent: an entry's clockedInAt is the REAL Toast timestamp (stable
// across the 90s ticks), so re-writing the same attendance doc each tick is a
// no-op. Best-effort throughout — a failure here NEVER touches the live feed.

const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// Same normalizer the client uses to join Toast employeeName ↔ schedule
// staffName (ClockedInPanel.normName). MUST stay in sync.
function normName(s) {
    return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Central (America/Chicago) calendar date key 'YYYY-MM-DD' for a Date.
function ctDateKey(d) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
}

// Central calendar date+hour key for a Date — used by the attendance
// recorder's hourly-reconcile gate (2026-08-25). Includes the date so the
// midnight boundary also counts as an hour change.
function ctHourKey(d) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", hour12: false,
    }).format(d);
}

// ── Session sanity (2026-09-08) ─────────────────────────────────────────────
// Two bugs corrupted /timecards + /clock_sessions sessions:
//   1. The scraper's schemaVersion-2 roster keeps clocked-OUT people on the
//      list with clockedInAt = their FIRST punch of the day, not the session
//      that just ended. The diff logic read that as "a new session began"
//      and closed the active session at an EARLIER time → negative-span
//      sessions on every clock-out break since 2026-07-24 (48% of docs).
//   2. A 65h roster outage (2026-09-05 → 09-08) made the first fresh diff
//      pair Saturday clock-ins with Tuesday punches → 66-72h "sessions".
// Every session write now passes saneSession(); the before→after diff is
// ignored for closing purposes when the two snapshots are far apart.
const MAX_SESSION_HOURS = 16;
const STALE_BEFORE_HOURS = 3;

function isoMs(s) {
    return s ? new Date(String(s).replace(/\+0000$/, "+00:00")).getTime() : NaN;
}

function saneSession(clockIn, clockOut) {
    const a = isoMs(clockIn);
    const b = isoMs(clockOut);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const h = (b - a) / 3600000;
    return h > 0 && h <= MAX_SESSION_HOURS;
}

// The scraper's hoursToday is scoped to calendar-TODAY (entries that started
// today), while a timecard is keyed by the clock-in day. They only describe
// the same day when the clock-in happened today — across midnight (or a
// forgotten clock-out) the roster reports hoursToday 0 for yesterday's card,
// which must never overwrite that card's real hours.
function sameCtDay(iso, now = new Date()) {
    const ms = isoMs(iso);
    if (!Number.isFinite(ms)) return false;
    return ctDateKey(new Date(ms)) === ctDateKey(now);
}

// Union two break lists by their `in` stamp, preferring the entry that has an
// `out` (the later, completed observation). The scraper's clocked-out summary
// entry always carries breaksToday: [] — a naive overwrite wiped the day's
// breaks the moment someone clocked out.
function mergeBreaks(a, b) {
    const byIn = new Map();
    for (const list of [a, b]) {
        if (!Array.isArray(list)) continue;
        for (const br of list) {
            if (!br || !br.in) continue;
            const cur = byIn.get(br.in);
            // Later list (the live roster) wins unless it would replace a
            // completed break with an incomplete one.
            if (!cur || br.out || !cur.out) byIn.set(br.in, br);
        }
    }
    return [...byIn.values()].sort((x, y) => String(x.in).localeCompare(String(y.in)));
}

// The before→after roster diff only describes real transitions when the two
// snapshots are close in time. After an outage the "before" is hours old and
// every difference is an artifact, not a punch.
function beforeIsStale(before, after) {
    const a = isoMs(after && after.updatedAt);
    const b = isoMs(before && before.updatedAt);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return (a - b) > STALE_BEFORE_HOURS * 3600000;
}

// A shift's scheduled start as UTC ms, from its 'YYYY-MM-DD' date + 'HH:MM'
// local (Central) time — DST-aware via the same Intl offset trick as
// sendShiftReminders (functions/index.js).
function shiftStartMs(dateStr, hhmm) {
    if (!dateStr || !hhmm) return null;
    const [y, mo, d] = String(dateStr).split("-").map(Number);
    const [hh, mm] = String(hhmm).split(":").map(Number);
    if ([y, mo, d, hh, mm].some(n => Number.isNaN(n))) return null;
    const probe = new Date(Date.UTC(y, mo - 1, d, 12, 0));
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago", timeZoneName: "shortOffset",
    }).formatToParts(probe);
    const label = parts.find(p => p.type === "timeZoneName")?.value || "GMT-5";
    const m = /GMT([+-]?\d+)/.exec(label);
    const off = m ? -parseInt(m[1], 10) : 5; // "GMT-5" → -5 → add 5h to reach UTC
    return Date.UTC(y, mo - 1, d, hh + off, mm);
}

// Closest scheduled shift to a clock-in, within 4h (ClockedInPanel.pickBestShift).
function pickBestShift(shifts, clockInMs) {
    if (!shifts || !shifts.length || !clockInMs) return null;
    const FOUR_H = 4 * 60 * 60 * 1000;
    let best = null, bestDelta = Infinity;
    for (const sh of shifts) {
        const s = shiftStartMs(sh.date, sh.startTime);
        if (s == null) continue;
        const delta = Math.abs(clockInMs - s);
        if (delta < bestDelta && delta <= FOUR_H) { best = sh; bestDelta = delta; }
    }
    return best;
}

// on_time vs late (mirrors getPunctuality's 5-minute grace).
function classify(clockInMs, startMs) {
    const diffMin = Math.round((clockInMs - startMs) / 60000);
    return { status: diffMin <= 5 ? "on_time" : "late", minutesLate: diffMin };
}

// Load today's published shifts grouped by normalized name (optionally scoped
// to a location). Returns Map<normName, shift[]>.
async function todaysShiftsByName(db, dateKey, location) {
    const snap = await db.collection("shifts")
        .where("date", "==", dateKey)
        .where("published", "==", true)
        .get();
    const map = new Map();
    snap.forEach(doc => {
        const sh = { id: doc.id, ...doc.data() };
        if (!sh.staffName) return;
        if (location && sh.location && sh.location !== location && sh.location !== "both") return;
        const k = normName(sh.staffName);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(sh);
    });
    return map;
}

// Called on each clocked_in_{location} write. Records on_time/late for every
// clock-in that matches a scheduled shift. Returns how many docs it wrote.
//
// 2026-08-25 audit — CHANGE GATE. The scraper rewrites the roster doc every
// ~90s even when nothing changed, and this recorder used to re-query today's
// shifts + batch.set every attendance doc on every tick (~20k writes/day of
// pure no-ops). Now each entry is diffed before→after on ONLY employeeName +
// clockedInAt (everything else — hoursToday, breaks, overtimeRisk — jitters
// every tick), and the shifts read is skipped entirely on a quiet tick.
// A person DISAPPEARING from the roster (clock-out) needs no attendance
// write — punctuality was already recorded at clock-in.
//
// HOLE-CLOSER: once per America/Chicago HOUR (detected by the roster doc's
// own updatedAt crossing an hour boundary) a full unconditional pass runs
// anyway. This self-heals shifts published/edited AFTER someone clocked in,
// swallowed trigger errors, and the midnight date-key boundary.
async function recordClockedInAttendance(location, before, after) {
    const entries = Array.isArray(after?.entries) ? after.entries : [];
    if (!entries.length) return 0; // closed / nobody on — nothing to do (also skips the shifts read)
    const db = getFirestore();

    // ── Change gate — computed BEFORE the shifts query so quiet ticks
    // skip those reads too. Key by toastEmployeeId when present, else
    // normalized name (this feed can carry entries without an id).
    const keyOf = (e) => (e && e.toastEmployeeId
        ? `id:${e.toastEmployeeId}`
        : `nm:${normName(e && e.employeeName)}`);
    const beforeEntries = Array.isArray(before?.entries) ? before.entries : [];
    const beforeByKey = new Map();
    for (const e of beforeEntries) {
        if (e && (e.toastEmployeeId || e.employeeName)) beforeByKey.set(keyOf(e), e);
    }

    // Hourly reconcile: full pass when before.updatedAt and after.updatedAt
    // fall in different Central hours (updatedAt = the scraper's own ISO
    // write stamp on the roster doc). Unparseable/missing stamps → full
    // pass (fail open: correctness over the saved writes).
    const hourChanged = (() => {
        const bRaw = before && before.updatedAt ? new Date(before.updatedAt) : null;
        const aRaw = after && after.updatedAt ? new Date(after.updatedAt) : null;
        if (!aRaw || Number.isNaN(aRaw.getTime())) return true;
        if (!bRaw || Number.isNaN(bRaw.getTime())) return true;
        return ctHourKey(bRaw) !== ctHourKey(aRaw);
    })();

    let toProcess;
    if (!before || hourChanged) {
        toProcess = entries; // before doc absent, or hourly reconcile — process everyone
    } else {
        toProcess = entries.filter((e) => {
            if (!e || !e.employeeName || !e.clockedInAt) return false; // skipped below anyway
            const prev = beforeByKey.get(keyOf(e));
            if (!prev) return true;                                    // new clock-in this tick
            if (prev.clockedInAt !== e.clockedInAt) return true;       // re-clock-in (new session)
            if ((prev.employeeName || "") !== (e.employeeName || "")) return true; // name resolved
            return false;
        });
        if (!toProcess.length) return 0; // quiet tick — no shifts read, no writes
    }

    const dateKey = ctDateKey(new Date());
    // Match by NAME across BOTH stores (no location filter) — staff cover
    // cross-location, so someone scheduled at Maryland who clocks in at Webster
    // must still match their Maryland shift. Otherwise the nightly no-show
    // sweep would falsely flag them. The punch's own location is stamped below.
    // (staffName is the unique cross-app join key, so name-only matching is safe.)
    const byName = await todaysShiftsByName(db, dateKey);
    if (!byName.size) return 0;

    // Earliest arrival wins (2026-09-08): an active entry after a clock-out
    // break carries the RETURN time as clockedInAt, and the hourly reconcile
    // reprocesses everyone — either used to overwrite an on_time arrival with
    // a "late" one. Never move a stored arrival later.
    const candidates = [];
    for (const e of toProcess) {
        if (!e || !e.employeeName || !e.clockedInAt) continue;
        candidates.push({ e, id: `${location}_${dateKey}_${normName(e.employeeName)}` });
    }
    const existingById = new Map();
    if (candidates.length) {
        try {
            const snaps = await db.getAll(...candidates.map(c => db.collection("attendance").doc(c.id)));
            for (const s of snaps) if (s.exists) existingById.set(s.id, s.data());
        } catch (err) { /* fail open: behave as before */ }
    }

    let wrote = 0;
    const batch = db.batch();
    for (const { e, id } of candidates) {
        const clockInMs = new Date(e.clockedInAt).getTime();
        if (!clockInMs) continue;
        const stored = existingById.get(id);
        // Strict: an EQUAL arrival still re-runs classification (the hourly pass
        // self-heals shifts edited/published after the clock-in); only a LATER
        // punch (return from a break) is ignored.
        if (stored && stored.clockedInAt && isoMs(stored.clockedInAt) < clockInMs) continue;
        const k = normName(e.employeeName);
        const sh = pickBestShift(byName.get(k) || [], clockInMs);
        if (!sh) continue; // worked without a scheduled shift — not part of the punctuality log
        const startMs = shiftStartMs(sh.date, sh.startTime);
        if (startMs == null) continue;
        const { status, minutesLate } = classify(clockInMs, startMs);
        batch.set(db.collection("attendance").doc(id), {
            location, date: dateKey, staffName: sh.staffName, staffKey: k,
            shiftId: sh.id, scheduledStart: sh.startTime || null, scheduledEnd: sh.endTime || null,
            scheduledLocation: sh.location || null, // may differ from `location` (cross-location cover)
            clockedInAt: e.clockedInAt, status, minutesLate,
            source: "forward", updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        wrote++;
    }
    if (wrote) await batch.commit();
    return wrote;
}

// Nightly sweep: anyone scheduled (published) for today who never clocked in
// (at EITHER location) gets a no_show row. Runs after close so all clock-ins
// have already landed. Skips shifts that already have an attendance row.
async function markNoShows(dateKey) {
    const db = getFirestore();
    const day = dateKey || ctDateKey(new Date());
    const [shiftsSnap, attSnap] = await Promise.all([
        db.collection("shifts").where("date", "==", day).where("published", "==", true).get(),
        db.collection("attendance").where("date", "==", day).get(),
    ]);
    // Names that already clocked in somewhere today (skip them).
    const clockedKeys = new Set();
    attSnap.forEach(doc => {
        const a = doc.data();
        if (a && a.clockedInAt) clockedKeys.add(a.staffKey);
    });
    // Second evidence source: a clock-in >4h from the scheduled start is
    // outside pickBestShift's window, so it never writes an attendance row —
    // someone who came in and worked a very different block than scheduled
    // would still get flagged no_show. Timecards + the live rosters are
    // Toast truth for "did they work AT ALL today"; anyone found there is
    // never a no-show. Best-effort — on failure fall back to attendance-only.
    try {
        const [tcSnap, liveW, liveM] = await Promise.all([
            db.collection("timecards").where("date", "==", day).get(),
            db.collection("ops").doc("clocked_in_webster").get(),
            db.collection("ops").doc("clocked_in_maryland").get(),
        ]);
        tcSnap.forEach(doc => {
            const t = doc.data();
            if (!t || !t.staffKey) return;
            if ((Array.isArray(t.sessions) && t.sessions.length) || t.openClockIn) {
                clockedKeys.add(t.staffKey);
            }
        });
        for (const snap of [liveW, liveM]) {
            const entries = snap.exists ? snap.data()?.entries : null;
            if (!Array.isArray(entries)) continue;
            for (const e of entries) {
                if (e && e.employeeName && e.clockedInAt) clockedKeys.add(normName(e.employeeName));
            }
        }
    } catch (e) {
        console.warn("markNoShows: worked-today evidence read failed:", e?.message || e);
    }
    let wrote = 0;
    const batch = db.batch();
    const noShowSeen = new Set();
    shiftsSnap.forEach(doc => {
        const sh = { id: doc.id, ...doc.data() };
        if (!sh.staffName) return;
        const k = normName(sh.staffName);
        if (clockedKeys.has(k)) return;            // they DID clock in — not a no-show
        if (noShowSeen.has(k)) return;             // one no_show row per person/day
        noShowSeen.add(k);
        const loc = sh.location && sh.location !== "both" ? sh.location : "webster";
        const id = `${loc}_${day}_${k}`;
        batch.set(db.collection("attendance").doc(id), {
            location: loc, date: day, staffName: sh.staffName, staffKey: k,
            shiftId: sh.id, scheduledStart: sh.startTime || null, scheduledEnd: sh.endTime || null,
            clockedInAt: null, status: "no_show", minutesLate: null,
            source: "forward", updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        wrote++;
    });
    if (wrote) await batch.commit();
    return wrote;
}

// ── Multi-session logger — Andrew 2026-06-30 ─────────────────────────────────
// The scraper keeps ONE entry per person = their LATEST punch. So when someone
// clocks out and back in (e.g. left for lunch), their first in/out is OVERWRITTEN
// and "Who's clocked in" loses it. This captures it: each time the roster is
// rewritten we diff before→after by toastEmployeeId, and when a person's
// clockedInAt CHANGES (a new session started), the PREVIOUS session is complete
// and gets appended to ops/clock_sessions_{location} (one doc per location,
// reset each Central day). The panel reads it to show every session for today.
//
// Idempotent: sessions are de-duped by their (stable) clockIn timestamp, so the
// same diff seen twice writes nothing new. Best-effort — never touches the feed.
// Pure: which sessions COMPLETED between two roster snapshots. Exported for
// tests — the transition table here is the one that produced 48% corrupt
// timecards when it was wrong.
function planCompletedSessions(before, after) {
    const afterEntries = Array.isArray(after?.entries) ? after.entries : [];
    const beforeEntries = Array.isArray(before?.entries) ? before.entries : [];
    if (!beforeEntries.length || !afterEntries.length) return [];

    const beforeById = {};
    for (const e of beforeEntries) if (e && e.toastEmployeeId) beforeById[e.toastEmployeeId] = e;

    // Stale before-snapshot (outage recovery): a prev session that started
    // on an EARLIER day is an artifact; one that started today is still a
    // real session whose end we may have just observed (daytime outage).
    const stale = beforeIsStale(before, after);

    const completed = [];
    for (const e of afterEntries) {
        if (!e || !e.toastEmployeeId || !e.clockedInAt) continue;
        const prev = beforeById[e.toastEmployeeId];
        if (!prev || !prev.clockedInAt) continue;
        if (stale && !sameCtDay(prev.clockedInAt)) continue;
        // Only an ACTIVE previous session can end here. A prev that was
        // already clocked out carries clockedInAt = first punch of the day
        // (schemaVersion 2), which is NOT a session start — the old code
        // read that as a new session and produced negative spans.
        if (prev.clockedOut === true) continue;
        let clockOut = null;
        if (e.clockedOut === true) {
            // active → clocked out: the active session ended at clockedOutAt.
            clockOut = e.clockedOutAt || null;
        } else if (prev.clockedInAt !== e.clockedInAt) {
            // active → active with a new start: re-clock-in without an
            // observed clock-out — close the old one where the new began.
            clockOut = e.clockedInAt;
        }
        if (!clockOut || !saneSession(prev.clockedInAt, clockOut)) continue;
        completed.push({
            id: String(e.toastEmployeeId),
            name: prev.employeeName || e.employeeName || "",
            clockIn: prev.clockedInAt,
            clockOut,
        });
    }
    return completed;
}

async function recordCompletedSessions(location, before, after) {
    const completed = planCompletedSessions(before, after);
    if (!completed.length) return 0;

    const db = getFirestore();
    const today = ctDateKey(new Date());
    const ref = db.collection("ops").doc(`clock_sessions_${location}`);
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        let data = snap.exists ? snap.data() : null;
        // New Central day → start fresh (the panel only shows today).
        if (!data || data.date !== today) data = { date: today, location, employees: {} };
        if (!data.employees) data.employees = {};
        for (const c of completed) {
            const emp = data.employees[c.id] || { name: c.name, sessions: [] };
            emp.name = c.name || emp.name;
            if (!Array.isArray(emp.sessions)) emp.sessions = [];
            if (!emp.sessions.some(s => s.clockIn === c.clockIn)) {
                emp.sessions.push({ clockIn: c.clockIn, clockOut: c.clockOut });
                emp.sessions.sort((a, b) => String(a.clockIn).localeCompare(String(b.clockIn)));
                if (emp.sessions.length > 12) emp.sessions = emp.sessions.slice(-12); // bound doc size
            }
            data.employees[c.id] = emp;
        }
        data.updatedAt = new Date().toISOString();
        tx.set(ref, data);
    });
    return completed.length;
}

// ── Durable per-employee timecards — Andrew 2026-07-24 ──────────────────────
// "I want staff to see their time cards … clock in and out for each day,
// total hours, total overtime." The live roster + clock_sessions docs are
// TODAY-only (overwritten each tick / reset each day) — nothing durable per
// employee existed. This writes one PERMANENT doc per (location, Central day,
// toastEmployeeId) to /timecards, built from the same scraper feed:
//
//   timecards/{loc}_{YYYY-MM-DD}_{toastEmployeeId} = {
//     location, date, toastEmployeeId, employeeName,
//     staffKey,                    // normName(employeeName) — joins to app staff
//     sessions: [{clockIn, clockOut}],  // CLOSED sessions, deduped by clockIn
//     openClockIn: ISO | null,     // in-progress session (null after clock-out)
//     breaks: [{in, out, minutes, paid}],
//     hoursToday, hoursThisWeek,   // scraper's own running totals (Toast truth)
//     updatedAt
//   }
//
// Write discipline (the trigger fires every ~90s per location): a doc is only
// written when the before→after DIFF shows a real change for that person —
// new session, clock-out (disappeared from roster), break started/ended, or
// hoursToday moved ≥3 minutes. Quiet ticks write nothing.
// History accrues FORWARD from deploy — the feed keeps no past days.
function _tcChanged(prev, e) {
    if (!prev) return true;
    if (prev.clockedInAt !== e.clockedInAt) return true;
    // Name resolved (new hire showed as "Unknown" until the scraper's
    // employee map caught up, 2026-08-24) — rewrite so the timecard and
    // its staffKey join to the right person immediately.
    if ((prev.employeeName || "") !== (e.employeeName || "")) return true;
    if ((prev.onBreakSince || null) !== (e.onBreakSince || null)) return true;
    const pb = Array.isArray(prev.breaksToday) ? prev.breaksToday.length : 0;
    const eb = Array.isArray(e.breaksToday) ? e.breaksToday.length : 0;
    if (pb !== eb) return true;
    if (Math.abs((Number(prev.hoursToday) || 0) - (Number(e.hoursToday) || 0)) >= 0.05) return true;
    return false;
}

function _tcRef(db, location, dateKey, toastEmployeeId) {
    return db.collection("timecards").doc(`${location}_${dateKey}_${toastEmployeeId}`);
}

// Append a CLOSED session to the day-of-clock-in's timecard (transaction —
// dedupes on the stable clockIn timestamp, so replayed diffs are no-ops).
async function _tcCloseSession(db, location, prevEntry, clockOutIso) {
    const clockIn = prevEntry.clockedInAt;
    if (!clockIn) return;
    // An impossible span (or a null clockOut = "clear only") never becomes a
    // session, but the transaction still runs so openClockIn is released —
    // an early return here left cards showing "On the clock" forever.
    const recordSession = saneSession(clockIn, clockOutIso);
    const dateKey = ctDateKey(new Date(clockIn));
    const ref = _tcRef(db, location, dateKey, prevEntry.toastEmployeeId);
    await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        // A clear-only close on a card that was never written has nothing
        // to release — don't materialize an empty 0h card for that day.
        if (!recordSession && !snap.exists) return;
        const data = snap.exists ? snap.data() : {
            location, date: dateKey,
            toastEmployeeId: String(prevEntry.toastEmployeeId),
            employeeName: prevEntry.employeeName || "",
            staffKey: normName(prevEntry.employeeName),
            sessions: [], breaks: [], openClockIn: null,
            hoursToday: null, hoursThisWeek: null,
        };
        if (!Array.isArray(data.sessions)) data.sessions = [];
        const existing = data.sessions.find(s => s.clockIn === clockIn);
        if (!recordSession) {
            // nothing to record — fall through to the openClockIn release below
        } else if (!existing) {
            data.sessions.push({ clockIn, clockOut: clockOutIso || null });
            data.sessions.sort((a, b) => String(a.clockIn).localeCompare(String(b.clockIn)));
        } else if (clockOutIso) {
            // 2026-07-26 audit: the dedupe used to DISCARD the incoming
            // clockOut when the clockIn already existed — a false early
            // close (transient roster dropout) then swallowed the REAL
            // clock-out forever and My Hours under-reported the shift.
            // Update instead: prefer the recorded clockedOutAt; otherwise
            // keep the LATER of the two (the real out can't precede a
            // transient one).
            if (prevEntry.clockedOutAt && saneSession(clockIn, prevEntry.clockedOutAt)) {
                existing.clockOut = prevEntry.clockedOutAt;
            } else if (!existing.clockOut || String(clockOutIso) > String(existing.clockOut)) {
                existing.clockOut = clockOutIso;
            }
        }
        // This session is no longer the open one.
        if (data.openClockIn === clockIn) data.openClockIn = null;
        if (Array.isArray(prevEntry.breaksToday) && prevEntry.breaksToday.length) {
            data.breaks = mergeBreaks(data.breaks, prevEntry.breaksToday);
        }
        // The roster's hoursToday only describes THIS card when the clock-in
        // was today (see sameCtDay) — across midnight it is a 0 for the wrong day.
        if (prevEntry.hoursToday != null && sameCtDay(clockIn)) data.hoursToday = prevEntry.hoursToday;
        data.updatedAt = new Date().toISOString();
        tx.set(ref, data);
    });
}

async function recordDurableTimecards(location, before, after) {
    const afterEntries = Array.isArray(after?.entries) ? after.entries : [];
    const beforeEntries = Array.isArray(before?.entries) ? before.entries : [];
    if (!afterEntries.length && !beforeEntries.length) return 0;
    const db = getFirestore();
    const beforeById = {};
    for (const e of beforeEntries) if (e && e.toastEmployeeId) beforeById[e.toastEmployeeId] = e;
    const afterIds = new Set(afterEntries.filter(e => e && e.toastEmployeeId).map(e => String(e.toastEmployeeId)));
    let wrote = 0;

    // Stale before-snapshot (outage recovery): closes derived from it would
    // be fabrications. Live upserts below still run; closes are skipped.
    const stale = beforeIsStale(before, after);

    // 1. Upsert the live picture for everyone on today's roster.
    for (const e of afterEntries) {
        if (!e || !e.toastEmployeeId || !e.clockedInAt || !e.employeeName) continue;
        const prev = beforeById[e.toastEmployeeId];
        const prevOpen = !!(prev && prev.clockedInAt && prev.clockedOut !== true);
        // A stale before-snapshot only invalidates prev sessions from an
        // EARLIER day; a same-day one is real (daytime outage).
        const prevActive = prevOpen && (!stale || sameCtDay(prev.clockedInAt));
        // Stale + earlier-day prev: release its openClockIn without inventing
        // a session (the daily Toast reconcile rebuilds that card).
        const prevClearOnly = prevOpen && !prevActive;

        if (e.clockedOut === true) {
            // Clocked out today (schemaVersion 2 summary entry: clockedInAt =
            // FIRST punch of the day, clockedOutAt = last punch). Close the
            // session that was active, then record the day summary WITHOUT
            // treating clockedInAt as an open session.
            if (prevActive && e.clockedOutAt) {
                try { await _tcCloseSession(db, location, prev, e.clockedOutAt); wrote++; } catch (err) { /* best-effort */ }
            } else if (prevClearOnly) {
                try { await _tcCloseSession(db, location, prev, null); wrote++; } catch (err) { /* best-effort */ }
            }
            // The summary MUST land on the transition tick even when nothing
            // else "changed" (single-session days: the active elapsed and
            // Toast's final hours differ by < 0.05h, so _tcChanged is false
            // and the card would keep last-tick elapsed hours forever).
            const justWentOut = !prev || prev.clockedOut !== true;
            if (!justWentOut && !_tcChanged(prev, e)) continue;
            try {
                const dateKey = ctDateKey(new Date(e.clockedInAt));
                const summary = {
                    location, date: dateKey,
                    toastEmployeeId: String(e.toastEmployeeId),
                    employeeName: e.employeeName,
                    staffKey: normName(e.employeeName),
                    openClockIn: null,
                    clockedOutAt: e.clockedOutAt || null,
                    onBreakSince: null,
                    hoursThisWeek: e.hoursThisWeek != null ? e.hoursThisWeek : null,
                    jobName: e.jobName || null,
                    updatedAt: new Date().toISOString(),
                };
                // Omit (never null) fields the summary can't speak for: the
                // scraper's out-entry carries breaksToday [] and hoursToday
                // is only this card's when the clock-in was today.
                if (Array.isArray(e.breaksToday) && e.breaksToday.length) summary.breaks = e.breaksToday;
                if (e.hoursToday != null && sameCtDay(e.clockedInAt)) summary.hoursToday = e.hoursToday;
                await _tcRef(db, location, dateKey, e.toastEmployeeId).set(summary, { merge: true });
                wrote++;
            } catch (err) { /* best-effort */ }
            continue;
        }

        // Active entry. A re-clock-in without an observed clock-out closes
        // the previous ACTIVE session where the new one began. A prev that
        // was already clocked out has nothing left to close.
        if (prevActive && prev.clockedInAt !== e.clockedInAt) {
            try { await _tcCloseSession(db, location, prev, e.clockedInAt); wrote++; } catch (err) { /* best-effort */ }
        } else if (prevClearOnly && prev.clockedInAt !== e.clockedInAt) {
            try { await _tcCloseSession(db, location, prev, null); wrote++; } catch (err) { /* best-effort */ }
        }
        if (!_tcChanged(prev, e)) continue;
        const dateKey = ctDateKey(new Date(e.clockedInAt));
        try {
            // Reappearance after a FALSE close (2026-07-26 audit): if this
            // clockIn was already closed into sessions[] (transient roster
            // dropout / week-window edge closed it early), remove that row —
            // the session is demonstrably still open. The real close will
            // re-append it later with the true clockOut.
            const reopenRef = _tcRef(db, location, dateKey, e.toastEmployeeId);
            const cur = await reopenRef.get();
            if (cur.exists && Array.isArray(cur.data().sessions)
                && cur.data().sessions.some(s => s.clockIn === e.clockedInAt)) {
                await reopenRef.set({
                    sessions: cur.data().sessions.filter(s => s.clockIn !== e.clockedInAt),
                }, { merge: true });
            }
            const live = {
                location, date: dateKey,
                toastEmployeeId: String(e.toastEmployeeId),
                employeeName: e.employeeName,
                staffKey: normName(e.employeeName),
                openClockIn: e.clockedInAt,
                onBreakSince: e.onBreakSince || null,
                // Union with what the card already holds — a split shift's
                // second session must not discard the first session's breaks.
                breaks: mergeBreaks(cur.exists ? cur.data().breaks : [], e.breaksToday),
                hoursThisWeek: e.hoursThisWeek != null ? e.hoursThisWeek : null,
                jobName: e.jobName || null,
                updatedAt: new Date().toISOString(),
            };
            if (e.hoursToday != null && sameCtDay(e.clockedInAt)) live.hoursToday = e.hoursToday;
            await reopenRef.set(live, { merge: true });
            wrote++;
        } catch (err) { /* best-effort — never break the feed trigger */ }
    }

    // 2. Anyone ACTIVE in BEFORE but gone from AFTER just clocked out — close
    //    them (a clocked-out prev was already closed). Under a stale before,
    //    an earlier-day prev only gets its openClockIn released.
    for (const prev of beforeEntries) {
        if (!prev || !prev.toastEmployeeId || !prev.clockedInAt) continue;
        if (prev.clockedOut === true) continue;
        if (afterIds.has(String(prev.toastEmployeeId))) continue;
        const clockOut = (!stale || sameCtDay(prev.clockedInAt))
            ? (prev.clockedOutAt || new Date().toISOString())
            : null;
        try { await _tcCloseSession(db, location, prev, clockOut); wrote++; } catch (err) { /* best-effort */ }
    }
    return wrote;
}

module.exports = {
    normName, ctDateKey, shiftStartMs, pickBestShift, classify,
    recordClockedInAttendance, markNoShows, recordCompletedSessions,
    recordDurableTimecards,
    // test seams (2026-09-08)
    planCompletedSessions, saneSession, beforeIsStale, sameCtDay, mergeBreaks, MAX_SESSION_HOURS,
};
