// ── Health-check engine (Debug/QA automation, 2026-06-24) ──────────────
//
// Server-side, read-only probes of the live app + backend. Always-on (no
// laptop): runs on a schedule (morning + a few times a day) and after every
// deploy (deploy.sh curls the onRequest endpoint). Records results so the
// Debug dashboard + the self-healing cloud agent have signal to act on.
//
// Writes:
//   /health_checks/{autoId}     one row per check kind, per run
//   /health_check_runs/{autoId} one rollup per run (ok + failed[] + summary)
//   /deploys/{version}          when triggered post-deploy (version param)
//   /error_logs/{autoId}        ONE critical row on a hard failure (cooldown-
//                               deduped) → wakes onCriticalError + the agent
//
// Alerting posture: NO bell/SMS. Andrew's "don't put errors in notifications"
// directive stands — escalation is the cloud agent reading the critical
// error_log and opening a fix PR (the PR is the signal). See
// DEBUG_AUTOMATION_PLAN.md.
//
// HARD-FAIL checks (escalate): site reachable, Firestore reachable.
// INFORMATIONAL (recorded, never escalate — too lag-prone): version match
// (GitHub Pages propagates 1-2 min after deploy), scraper freshness (the
// watchScraperFreshness watchdog owns that alert), recent-error count.

const { FieldValue } = require("firebase-admin/firestore");

const SITE_URL = "https://app.ddmaustl.com";
const ESCALATE_COOLDOWN_MS = 30 * 60 * 1000;   // 1 critical error_log / signature / 30 min

// Coerce a Firestore Timestamp | ISO string | epoch-ms into epoch ms.
function toMs(v) {
    if (v == null) return null;
    if (typeof v === "number") return v;
    if (typeof v.toMillis === "function") return v.toMillis();
    const t = Date.parse(String(v));
    return Number.isNaN(t) ? null : t;
}

// Run an async probe, capturing ok/ms/detail without ever throwing.
async function timed(fn) {
    const t0 = Date.now();
    try { return { ok: true, ms: Date.now() - t0, detail: await fn() }; }
    catch (e) { return { ok: false, ms: Date.now() - t0, detail: String((e && e.message) || e).slice(0, 300) }; }
}

// The check engine. `db` is the initialized Firestore instance from index.js.
//   trigger         'scheduled' | 'deploy' | 'manual'
//   expectedVersion when post-deploy: the version.json `v` we expect live
//   escalate        write a critical error_log on a hard failure (scheduled only)
async function runHealthChecks(db, { trigger = "manual", expectedVersion = null, expectedSha = null, escalate = false } = {}) {
    const nowMs = Date.now();
    const checks = {};

    // 1. Site + version.json reachable (HARD).
    checks.site = await timed(async () => {
        if (typeof fetch === "undefined") throw new Error("fetch unavailable in runtime");
        const r = await fetch(`${SITE_URL}/version.json?t=${nowMs}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`version.json HTTP ${r.status}`);
        const j = await r.json();
        return { liveVersion: j.v ?? null, builtAt: j.ts ?? null };
    });

    // 2. Version propagation (INFORMATIONAL — GitHub Pages lags a deploy 1-2
    //    min, so a brief mismatch right after a deploy is expected). version.json
    //    `v` is the "YYYY.MM.DD · <gitsha>" build stamp (NOT the npm version), so
    //    we match on the git sha appearing in it.
    if (expectedSha) {
        const live = checks.site.ok ? checks.site.detail.liveVersion : null;
        const matched = !!live && String(live).includes(String(expectedSha));
        checks.version_match = { ok: matched, ms: 0, detail: `expected sha ${expectedSha}, live "${live ?? "?"}"` };
    }

    // 3. Firestore reachable (HARD) — same liveness doc AdminHealthPage uses.
    checks.firestore = await timed(async () => {
        const s = await db.doc("config/forceRefresh").get();
        return { reachable: true, exists: s.exists };
    });

    // 4. Scraper freshness (INFORMATIONAL — watchScraperFreshness owns alerts).
    checks.scraper = await timed(async () => {
        const out = {};
        for (const loc of ["webster", "maryland"]) {
            const s = await db.doc(`ops/labor_${loc}`).get();
            const upd = toMs(s.exists ? (s.data() || {}).updatedAt : null);
            out[`${loc}_min_ago`] = upd ? Math.round((nowMs - upd) / 60000) : null;
        }
        return out;
    });

    // 5. Recent critical errors (INFORMATIONAL spike signal for the dashboard).
    //    Single-field range on occurredAt (auto-indexed) + filter severity in
    //    code — avoids needing a composite index for this informational count.
    checks.errors = await timed(async () => {
        const cut = nowMs - 24 * 3600 * 1000;
        const snap = await db.collection("error_logs")
            .where("occurredAt", ">=", cut)
            .limit(300).get();
        let critical = 0;
        snap.forEach((d) => { if ((d.data() || {}).severity === "critical") critical++; });
        return { critical_24h: critical, total_24h: snap.size };
    });

    // Overall verdict — only the HARD checks decide pass/fail.
    const hardFails = [];
    if (!checks.site.ok) hardFails.push("site");
    if (!checks.firestore.ok) hardFails.push("firestore");
    const ok = hardFails.length === 0;

    // Persist: one health_checks row per kind + a run rollup.
    try {
        const batch = db.batch();
        for (const [kind, res] of Object.entries(checks)) {
            batch.set(db.collection("health_checks").doc(), {
                kind,
                ok: res.ok !== false,
                ms: res.ms ?? null,
                detail: res.detail ?? null,
                trigger,
                version: expectedVersion ?? (checks.site.ok ? checks.site.detail.liveVersion : null),
                ranAt: FieldValue.serverTimestamp(),
                occurredAt: nowMs,
            });
        }
        batch.set(db.collection("health_check_runs").doc(), {
            trigger, ok, hardFails,
            version: expectedVersion ?? (checks.site.ok ? checks.site.detail.liveVersion : null),
            summary: checks,
            ranAt: FieldValue.serverTimestamp(),
            occurredAt: nowMs,
        });
        // Post-deploy: stamp the deploy record (idempotent per version).
        if (expectedVersion != null) {
            batch.set(db.doc(`deploys/${String(expectedVersion).replace(/[^\w.\-]/g, "_")}`), {
                version: expectedVersion,
                sha: expectedSha ?? null,
                channel: "production",
                probeOk: ok,
                probeHardFails: hardFails,
                versionPropagated: checks.version_match ? checks.version_match.ok : null,
                liveVersion: checks.site.ok ? checks.site.detail.liveVersion : null,
                ranAt: FieldValue.serverTimestamp(),
                occurredAt: nowMs,
            }, { merge: true });
        }
        await batch.commit();
    } catch (e) {
        // Best-effort persistence — the probe result is still returned.
        if (typeof console !== "undefined") console.warn("runHealthChecks persist failed:", e && e.message);
    }

    // Escalate a HARD failure to a critical error_log (cooldown-deduped) so
    // onCriticalError + the cloud agent pick it up. Scheduled runs only.
    if (escalate && !ok) {
        try {
            const sig = `healthcheck:${hardFails.sort().join(",")}`;
            const cdRef = db.doc(`system/healthcheck_cooldown_${sig.replace(/[^\w]/g, "_")}`);
            const cd = await cdRef.get();
            const last = cd.exists ? toMs((cd.data() || {}).lastEscalatedMs) : null;
            if (!last || nowMs - last > ESCALATE_COOLDOWN_MS) {
                await db.collection("error_logs").add({
                    severity: "critical",
                    source: "healthcheck",
                    feature: `healthcheck-${hardFails.join("-")}`,
                    errorName: "HealthCheckFailed",
                    errorMessage: `Health check failed: ${hardFails.join(", ")} unreachable. ${JSON.stringify(
                        Object.fromEntries(hardFails.map((k) => [k, checks[k].detail])))}`.slice(0, 1000),
                    meta: { trigger, hardFails, checks },
                    resolved: false,
                    ts: FieldValue.serverTimestamp(),
                    occurredAt: nowMs,
                    appVersion: checks.site.ok ? checks.site.detail.liveVersion : null,
                });
                await cdRef.set({ lastEscalatedMs: nowMs, lastHardFails: hardFails }, { merge: true });
            }
        } catch (e) {
            if (typeof console !== "undefined") console.warn("runHealthChecks escalate failed:", e && e.message);
        }
    }

    return { ok, trigger, hardFails, version: expectedVersion ?? (checks.site.ok ? checks.site.detail.liveVersion : null), checks };
}

module.exports = { runHealthChecks };
