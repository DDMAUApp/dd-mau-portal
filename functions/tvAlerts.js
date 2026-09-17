// tvAlerts.js — pure planning, stamping rules and wording for the menu-TV
// offline alerts (checkTvHeartbeats in index.js). No Firestore in here, so the
// whole incident life-cycle is unit-tested (functions/tvAlerts.test.js).
//
// 2026-09-17 — Andrew: Webster 1 + 2 sat on Chromium's "Aw, Snap" page for 3
// days and nobody knew ("if it ever doesn't load again or it's not live or
// offline it sends me a message in the chat page and i can take a look").
// Each Pi now self-heals a dead page in ~5-7 min (~/bin/ddmau-tv-watchdog.sh),
// so by the time a screen is STALE_MS silent here, self-heal has already
// failed — power, Wi-Fi, or the Pi itself — and a person needs to look.
//
// The heartbeat is trusted only because the PAGE refuses to heartbeat from
// previews and personal devices (src/data/tvHeartbeatGate.js).
//
// Incident life-cycle for one screen (all state lives on its heartbeat doc):
//   offline  → once, when it has been silent > STALE_MS
//   reminder → every REMIND_EVERY_MS in the daytime while still silent, for REMIND_MAX_MS
//   stopped  → once, after REMIND_MAX_MS ("I'll stop reminding")
//   recovered→ once, only after the heartbeat has looked healthy on every
//              5-min run for RECOVER_HOLD_MS. A relapse inside the hold stays
//              in the SAME incident — a crash-looping screen can't ping-pong.
//   flapping → replaces "offline" on the 4th incident in 24 h; its recovery
//              needs a full hour of health.

const STALE_MS = 10 * 60_000;              // 10 min without a heartbeat = offline
const FRESH_MS = 3 * 60_000;               // beats every 60 s; ≤3 min old = currently alive
const RECOVER_HOLD_MS = 14 * 60_000;       // healthy on 4 consecutive 5-min runs (~15 min) before "back online"
const FLAP_HOLD_MS = 59 * 60_000;          // …an hour once it has been flapping
const FLAP_WINDOW_MS = 24 * 60 * 60_000;
const FLAP_MAX_ALERTS = 3;                 // 3 normal incidents per 24 h, then the "keeps dropping" notice
const FIRST_ALERT_MAX_MS = 14 * 24 * 60 * 60_000; // older than this and never alerted = a retired screen
const REMIND_EVERY_MS = 3 * 60 * 60_000;   // nudge again every 3 h while still offline…
const REMIND_MAX_MS = 48 * 60 * 60_000;    // …for 2 days, then stop (a retired screen must not nag forever)
const REMIND_FROM_HOUR = 8;                // daytime = 8:00–20:59 Central. Reminders only then; a FIRST
const REMIND_UNTIL_HOUR = 21;              // alert at night is delivered quietly (nobody needs a 2 AM wake-up
                                           // for a closed restaurant — the 8 AM reminder is the loud one)

function toMs(ts) {
    if (!ts) return 0;
    if (typeof ts === "number") return Number.isFinite(ts) ? ts : 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.seconds === "number") return ts.seconds * 1000;
    return 0;
}
const finiteMin = (ms) => (Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : 0);

/**
 * heartbeats: [{ id, lastSeenMs, alertedMs, remindedMs, stoppedMs, healthySinceMs,
 *                flapMs, lastOutageAgeMin, alertTimes:number[] }]
 * configs:    { [tvId]: { label, location, alertsMuted } } — a heartbeat id with
 *             NO config doc is a preview/test id and never alerts.
 * An id appears in at most one list. holdStart/holdReset are SILENT (stamps only).
 */
function planTvAlerts({ heartbeats, configs, nowMs, chicagoHour }) {
    const plan = { offline: [], flapping: [], recovered: [], reminders: [], stopped: [], holdStart: [], holdReset: [], locStats: {} };
    const daytime = chicagoHour >= REMIND_FROM_HOUR && chicagoHour < REMIND_UNTIL_HOUR;
    plan.daytime = daytime;
    for (const hb of heartbeats || []) {
        if (!hb || !hb.id) continue;
        const cfg = configs && configs[hb.id];
        const lastSeenMs = Number(hb.lastSeenMs) || 0;
        const ageMs = lastSeenMs ? nowMs - lastSeenMs : Infinity;
        const stale = ageMs > STALE_MS;
        const fresh = ageMs <= FRESH_MS;
        const alertedMs = Number(hb.alertedMs) || 0;
        const healthySinceMs = Number(hb.healthySinceMs) || 0;
        const watched = !!cfg && cfg.alertsMuted !== true;

        if (watched && cfg.location) {
            const ls = plan.locStats[cfg.location] || (plan.locStats[cfg.location] = { down: 0, alive: 0 });
            if (stale && lastSeenMs && ageMs <= FIRST_ALERT_MAX_MS) ls.down += 1;
            else if (!stale) ls.alive += 1;
        }

        if (!alertedMs) {
            if (!watched || !stale || !lastSeenMs || ageMs > FIRST_ALERT_MAX_MS) continue;
            const recent = (Array.isArray(hb.alertTimes) ? hb.alertTimes : [])
                .map(Number).filter((t) => Number.isFinite(t) && nowMs - t < FLAP_WINDOW_MS && t <= nowMs);
            const item = { id: hb.id, ageMin: finiteMin(ageMs), alertTimes: [...recent, nowMs].slice(-10), countIn24h: recent.length + 1 };
            (recent.length >= FLAP_MAX_ALERTS ? plan.flapping : plan.offline).push(item);
            continue;
        }

        // ── an incident is open ──
        if (fresh) {
            // Closing is allowed even for a since-muted/unconfigured screen so an
            // open incident always gets its last line and its stamps cleared.
            if (!healthySinceMs) { plan.holdStart.push({ id: hb.id }); continue; }
            const hold = Number(hb.flapMs) > 0 ? FLAP_HOLD_MS : RECOVER_HOLD_MS;
            if (nowMs - healthySinceMs >= hold) {
                const outageStartMs = alertedMs - (Number(hb.lastOutageAgeMin) || 0) * 60_000;
                plan.recovered.push({ id: hb.id, downMin: Math.max(1, finiteMin(healthySinceMs - outageStartMs)), wasFlapping: Number(hb.flapMs) > 0 });
            }
            continue;
        }
        if (healthySinceMs) { plan.holdReset.push({ id: hb.id }); continue; }   // relapsed (or skipped beats) inside the hold
        if (!stale || !watched) continue;
        if (Number(hb.stoppedMs) > 0) continue;             // already said "I'll stop reminding"
        if (!daytime) continue;
        if (nowMs - alertedMs > REMIND_MAX_MS) { plan.stopped.push({ id: hb.id, ageMin: finiteMin(ageMs) }); continue; }
        const sinceNudge = nowMs - (Number(hb.remindedMs) || alertedMs);
        if (sinceNudge >= REMIND_EVERY_MS) plan.reminders.push({ id: hb.id, ageMin: finiteMin(ageMs), remindedMs: Number(hb.remindedMs) || 0 });
    }
    return plan;
}

/**
 * What each action writes to the heartbeat doc. "NOW" = server timestamp.
 * Shared by index.js (→ FieldValue ops) and the test simulator, so the tests
 * exercise the production stamping rules.
 */
function stampsFor(kind, item) {
    const INCIDENT = ["remindedAt", "remindersStoppedAt", "healthySinceAt", "flapAt"];
    switch (kind) {
    case "offline": return { set: { alertedAt: "NOW", lastOutageAgeMin: item.ageMin, alertTimes: item.alertTimes }, del: INCIDENT };
    case "flapping": return { set: { alertedAt: "NOW", flapAt: "NOW", lastOutageAgeMin: item.ageMin, alertTimes: item.alertTimes }, del: ["remindedAt", "remindersStoppedAt", "healthySinceAt"] };
    case "recovered": return { set: {}, del: ["alertedAt", "lastOutageAgeMin", ...INCIDENT] };
    case "reminder": return { set: { remindedAt: "NOW" }, del: [] };
    case "stopped": return { set: { remindersStoppedAt: "NOW" }, del: [] };
    case "holdStart": return { set: { healthySinceAt: "NOW" }, del: [] };
    case "holdReset": return { set: {}, del: ["healthySinceAt"] };
    default: return { set: {}, del: [] };
    }
}

/** Does the doc still look the way the plan assumed? (re-checked inside the transaction) */
function stillValid(kind, item, hb, nowMs) {
    const alerted = toMs(hb && hb.alertedAt) > 0;
    const age = nowMs - toMs(hb && hb.lastSeenAt);
    if (kind === "offline" || kind === "flapping") return !alerted && age > STALE_MS;
    if (kind === "recovered") return alerted && age <= STALE_MS;
    if (kind === "reminder") return alerted && toMs(hb.remindedAt) === (item.remindedMs || 0);
    if (kind === "stopped") return alerted && !toMs(hb.remindersStoppedAt);
    return true;
}

function humanDuration(min) {
    const m = finiteMin((Number(min) || 0) * 60_000);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return r ? `${h} h ${r} min` : `${h} h`;
    const d = Math.floor(h / 24), hr = h % 24;
    return hr ? `${d} d ${hr} h` : `${d} d`;
}

function tvName(id, configs) {
    const c = (configs && configs[id]) || {};
    const label = String(c.label || id).trim();
    const loc = c.location === "webster" ? "Webster" : c.location === "maryland" ? "Maryland Heights" : "";
    return loc && !label.toLowerCase().includes(loc.toLowerCase().split(" ")[0]) ? `${label} (${loc})` : label;
}

/**
 * One chat message per kind per run: { kind, text, pushTitle, pushBody, loud }.
 * `text` is the chat bubble; the push gets its own short body (the bubble's
 * first lines would repeat the title and drop the second screen).
 */
function formatTvAlertMessages(plan, configs) {
    const out = [];
    const cfg = configs || {};
    const names = (list) => list.map((x) => tvName(x.id, cfg));
    const plural = (n, one, many) => (n > 1 ? many : one);
    const wholeStores = (list) => {
        const locs = [...new Set(list.map((x) => (cfg[x.id] || {}).location).filter(Boolean))];
        return locs.filter((l) => (plan.locStats[l] || {}).down >= 2 && !((plan.locStats[l] || {}).alive > 0));
    };
    if (plan.offline.length) {
        const n = plan.offline.length;
        const lines = plan.offline.map((x) => `• ${tvName(x.id, cfg)} — no check-in for ${humanDuration(x.ageMin)}`);
        const store = wholeStores(plan.offline).length > 0;
        const hint = store
            ? "Every screen at that store is down, so it is probably the store's internet or power, not the screens."
            : "Each screen restarts itself when its page dies, so this one needs a look: check that the TV box has power and Wi-Fi.";
        out.push({
            kind: "offline", loud: plan.daytime === true,
            text: `📴 Menu ${plural(n, "screen", "screens")} offline\n${lines.join("\n")}\n${hint}`,
            pushTitle: `📴 Menu ${plural(n, "screen", "screens")} offline`,
            pushBody: `${names(plan.offline).join(", ")} — no check-in for ${humanDuration(Math.max(...plan.offline.map((x) => x.ageMin)))}.${store ? " Probably the store's internet or power." : ""}`,
        });
    }
    if (plan.flapping.length) {
        const n = plan.flapping.length;
        const lines = plan.flapping.map((x) => `• ${tvName(x.id, cfg)} — offline again (${x.countIn24h} times in 24 h)`);
        out.push({
            kind: "flapping", loud: plan.daytime === true,
            text: `⚠️ Menu ${plural(n, "screen keeps", "screens keep")} dropping\n${lines.join("\n")}\nI'll stay quiet about ${plural(n, "it", "them")} until ${plural(n, "it has", "they have")} been steady for an hour. Worth a look at the TV box: power, Wi-Fi signal, or a reboot.`,
            pushTitle: `⚠️ Menu ${plural(n, "screen keeps", "screens keep")} dropping`,
            pushBody: `${names(plan.flapping).join(", ")} — offline again. Quiet until steady for an hour.`,
        });
    }
    if (plan.recovered.length) {
        const lines = plan.recovered.map((x) => `• ${tvName(x.id, cfg)} — was down about ${humanDuration(x.downMin)}`);
        out.push({
            kind: "recovered", loud: false,
            text: `🟢 Back online and steady\n${lines.join("\n")}`,
            pushTitle: "🟢 Menu screen back online",
            pushBody: plan.recovered.map((x) => `${tvName(x.id, cfg)} (down about ${humanDuration(x.downMin)})`).join(", "),
        });
    }
    if (plan.reminders.length) {
        const lines = plan.reminders.map((x) => `• ${tvName(x.id, cfg)} — ${humanDuration(x.ageMin)}`);
        out.push({
            kind: "reminder", loud: true,
            text: `⏰ Still offline\n${lines.join("\n")}`,
            pushTitle: `⏰ Menu ${plural(plan.reminders.length, "screen", "screens")} still offline`,
            pushBody: plan.reminders.map((x) => `${tvName(x.id, cfg)} (${humanDuration(x.ageMin)})`).join(", "),
        });
    }
    if (plan.stopped.length) {
        const n = plan.stopped.length;
        out.push({
            kind: "stopped", loud: false,
            text: `🔕 ${names(plan.stopped).join(", ")} ${plural(n, "has", "have")} been offline for over 2 days, so I'll stop reminding. I'll still post here when ${plural(n, "it comes", "they come")} back.`,
            pushTitle: "🔕 Menu screen reminders stopped",
            pushBody: `${names(plan.stopped).join(", ")} — offline over 2 days.`,
        });
    }
    return out;
}

const listFor = (plan, kind) => (kind === "reminder" ? plan.reminders : plan[kind]) || [];

module.exports = {
    STALE_MS, FRESH_MS, RECOVER_HOLD_MS, FLAP_HOLD_MS, FLAP_MAX_ALERTS, FIRST_ALERT_MAX_MS,
    REMIND_EVERY_MS, REMIND_MAX_MS, REMIND_FROM_HOUR, REMIND_UNTIL_HOUR,
    toMs, planTvAlerts, stampsFor, stillValid, formatTvAlertMessages, humanDuration, tvName, listFor,
};
