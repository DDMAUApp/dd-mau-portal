// labor.js — shared helper for "is the labor number we got from Toast trustworthy?"
//
// Four surfaces render the labor percentage (HomeV2 desktop tile,
// MobileHome KPI strip, LaborDashboard hero card, Operations header
// pill). The actual % isn't computed here — the Toast scraper on Railway
// owns the math and writes `laborCost`, `netSales`, and `laborPercent`
// onto ops/labor_{location}. This helper just answers three questions
// every surface needs to answer the same way:
//
//   1. Is the data we have currently broken? (scraper failure)
//   2. Is the data stale? (scraper hasn't run recently)
//   3. How long ago did we last hear from Toast?
//
// ── 2026-05-26 outage / why isBroken exists ─────────────────────────────
// Andrew reported "labor percentage is broken" — every screen showing
// "0.0%". Audit of /ops/labor_webster and /ops/labor_maryland:
//   { laborCost: 0, laborPercent: 0, netSales: 38.00, updatedAt: 5:07 am }
//   { laborCost: 0, laborPercent: 0, netSales: 175.50, updatedAt: 5:07 am }
// Two failures stacked:
//   (a) Toast scraper on Railway stopped writing after 5:07 am (~6 hrs of
//       silence by the time we noticed).
//   (b) Even on its LAST write the scraper got laborCost: 0 — its labor
//       endpoint was already failing while sales were still being
//       fetched correctly (likely an auth/session expiry on the Toast
//       labor API specifically).
// Frontend was happily rendering "0.0%" everywhere — a number that reads
// as "labor is perfect today" at a glance. A manager who trusts that
// number staffs up assuming costs are fine. The real fix is on Railway,
// but the frontend should never DECEIVE: if Toast says $0 in labor cost
// with real sales coming through, we render "—" and a "Scraper offline"
// hint instead.

/**
 * Distill a /ops/labor_{loc} doc into "is this number trustworthy?" status.
 *
 * @param {object|null} laborData — raw doc from ops/labor_{loc}, or null.
 *   Expected fields: { laborCost, netSales, laborPercent, updatedAt }.
 *   updatedAt is the ISO string the Python scraper writes (it uses
 *   datetime.now(timezone.utc).isoformat()).
 * @returns {{
 *   laborPercent: number|null, // null when broken (don't render % at all)
 *   laborCost: number|null,
 *   netSales: number|null,
 *   updatedAt: Date|null,
 *   minutesAgo: number|null,
 *   isStale: boolean,          // >10 min since last write
 *   isBroken: boolean,         // scraper failure — $0 cost with real sales
 *   hasData: boolean,          // false if laborData itself was null/undefined
 * }}
 */
export function getLaborStatus(laborData) {
    if (!laborData) {
        return {
            laborPercent: null,
            laborCost: null,
            netSales: null,
            updatedAt: null,
            minutesAgo: null,
            isStale: false,
            isBroken: false,
            hasData: false,
        };
    }

    const updatedAt = laborData.updatedAt ? new Date(laborData.updatedAt) : null;
    const updatedValid = updatedAt && !isNaN(updatedAt.getTime());
    const minutesAgo = updatedValid
        ? Math.round((Date.now() - updatedAt.getTime()) / 60000)
        : null;
    // 10 min is the scraper's nominal cadence. Anything older means
    // either the scheduler stopped or the scraper is silently erroring.
    const isStale = minutesAgo !== null && minutesAgo > 10;

    const laborCost = laborData.laborCost;
    const netSales = laborData.netSales;
    // "Broken" = scraper reported zero labor cost while sales were
    // actually being recorded. The Toast labor endpoint failed (auth
    // expired, page changed, network blip) but the sales endpoint kept
    // returning real numbers. The $5 net-sales floor avoids treating
    // "store just opened, no orders yet" as broken — once sales pass $5,
    // there has to be a clocked-in employee somewhere, so laborCost === 0
    // is a scraper artifact, not reality.
    const isBroken =
        (laborCost === 0 || laborCost == null) &&
        typeof netSales === 'number' &&
        netSales > 5;

    return {
        laborPercent: isBroken ? null : laborData.laborPercent,
        laborCost,
        netSales,
        updatedAt: updatedValid ? updatedAt : null,
        minutesAgo,
        isStale,
        isBroken,
        hasData: true,
    };
}

/**
 * Short i18n hint to display under a labor tile when the value is broken
 * or stale. Returns '' when neither applies (the surface should fall
 * through to its normal "Updated X min ago" / "Target 25%" text).
 */
export function getLaborStatusHint(status, language = 'en') {
    const isEs = language === 'es';
    if (!status.hasData) {
        return isEs ? 'Sin datos de Toast' : 'No Toast data';
    }
    if (status.isBroken) {
        return isEs ? 'Toast sin conexión' : 'Toast scraper offline';
    }
    if (status.isStale) {
        const m = status.minutesAgo;
        return isEs ? `Atrasado ${m} min` : `Stale · ${m} min ago`;
    }
    return '';
}
