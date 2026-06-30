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
async function recordClockedInAttendance(location, data) {
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    if (!entries.length) return 0; // closed / nobody on — nothing to do (also skips the shifts read)
    const db = getFirestore();
    const dateKey = ctDateKey(new Date());
    // Match by NAME across BOTH stores (no location filter) — staff cover
    // cross-location, so someone scheduled at Maryland who clocks in at Webster
    // must still match their Maryland shift. Otherwise the nightly no-show
    // sweep would falsely flag them. The punch's own location is stamped below.
    // (staffName is the unique cross-app join key, so name-only matching is safe.)
    const byName = await todaysShiftsByName(db, dateKey);
    if (!byName.size) return 0;

    let wrote = 0;
    const batch = db.batch();
    for (const e of entries) {
        if (!e || !e.employeeName || !e.clockedInAt) continue;
        const clockInMs = new Date(e.clockedInAt).getTime();
        if (!clockInMs) continue;
        const k = normName(e.employeeName);
        const sh = pickBestShift(byName.get(k) || [], clockInMs);
        if (!sh) continue; // worked without a scheduled shift — not part of the punctuality log
        const startMs = shiftStartMs(sh.date, sh.startTime);
        if (startMs == null) continue;
        const { status, minutesLate } = classify(clockInMs, startMs);
        const id = `${location}_${dateKey}_${k}`;
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
async function recordCompletedSessions(location, before, after) {
    const afterEntries = Array.isArray(after?.entries) ? after.entries : [];
    const beforeEntries = Array.isArray(before?.entries) ? before.entries : [];
    if (!beforeEntries.length || !afterEntries.length) return 0;

    const beforeById = {};
    for (const e of beforeEntries) if (e && e.toastEmployeeId) beforeById[e.toastEmployeeId] = e;

    const completed = [];
    for (const e of afterEntries) {
        if (!e || !e.toastEmployeeId || !e.clockedInAt) continue;
        const prev = beforeById[e.toastEmployeeId];
        if (!prev || !prev.clockedInAt) continue;
        // A different clockedInAt means a NEW session began → the prior one ended.
        if (prev.clockedInAt !== e.clockedInAt) {
            completed.push({
                id: String(e.toastEmployeeId),
                name: prev.employeeName || e.employeeName || "",
                clockIn: prev.clockedInAt,
                // prefer the recorded clock-out; fall back to when the next session
                // started if the scraper hadn't stamped clockedOutAt yet.
                clockOut: prev.clockedOutAt || e.clockedInAt,
            });
        }
    }
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

module.exports = {
    normName, ctDateKey, shiftStartMs, pickBestShift, classify,
    recordClockedInAttendance, markNoShows, recordCompletedSessions,
};
