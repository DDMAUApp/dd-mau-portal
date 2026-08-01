// Decide what a nightly-backup record's REAL outcome was.
//
// ⚠ WHY THIS EXISTS (2026-08-01): scheduledFirestoreBackup fires the
// Firestore export API, writes a backup_history row with status
// 'started', and walks away. A Firestore export is a long-running
// operation that can fail MINUTES later (quota, bucket permission,
// billing) — and nothing ever went back to update that row. So
// 'started' was the terminal state for every backup we've ever taken,
// and a half-finished export was indistinguishable from a good one.
//
// The 2026-05-12 → 2026-07-07 outage is the cautionary tale: 57
// consecutive days with NO backup. It produced 118 backup_history
// failures but only 4 error_logs rows, because the critical-error
// alert is cooldown-deduped and retention prunes old rows. Nobody
// noticed for two months. error_logs is a SAMPLE, not a census —
// backup_history is the source of truth, so it has to be truthful.
//
// This module is pure so the decision table can be unit-tested without
// standing up Firestore, GCS, or the scheduler.

// A 94 MB / 1026-file export finishes in minutes. 6h is far past any
// legitimate run, so anything still 'started' by then is wedged.
const STALL_MS = 6 * 60 * 60 * 1000;

// Firestore garbage-collects finished operations, and the backup
// bucket may have its own lifecycle rule. Past this age, absence of
// evidence is NOT evidence of failure — we cannot honestly judge an
// old row, so we mark it 'unknown' and stay quiet rather than firing a
// retroactive alert about a backup that probably ran fine.
const TOO_OLD_TO_JUDGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * @param {object}  input
 * @param {boolean} input.found        operation lookup succeeded
 * @param {boolean} input.done         operation reports done
 * @param {string}  [input.error]      operation's error message, if any
 * @param {number}  input.ageMs        how long ago the backup started
 * @param {boolean|null} input.hasMarker  GCS overall_export_metadata present
 *                                        (null = not checked)
 * @returns {{status: string, alert: boolean, reason: string}}
 */
function classifyBackup({ found, done, error, ageMs, hasMarker = null }) {
    const age = Number(ageMs) || 0;

    if (found) {
        if (done && error) {
            return { status: 'failed', alert: true, reason: `export failed: ${error}` };
        }
        if (done) {
            return { status: 'completed', alert: false, reason: 'operation reported done' };
        }
        // Not done yet.
        if (age > STALL_MS) {
            return {
                status: 'stalled',
                alert: true,
                reason: `still running ${Math.round(age / 3600000)}h after start`,
            };
        }
        // Genuinely still in flight — leave it alone, recheck next run.
        return { status: 'started', alert: false, reason: 'still in progress' };
    }

    // Operation lookup failed (404 / GC'd). Fall back to the artifact
    // itself: Firestore only writes overall_export_metadata when an
    // export COMPLETES, so its presence is real proof.
    if (hasMarker === true) {
        return { status: 'completed', alert: false, reason: 'verified via export marker in bucket' };
    }

    // Guard BEFORE any alerting path: never retro-alert on rows too old
    // to judge, or the first run would spam one alert per historical row.
    if (age > TOO_OLD_TO_JUDGE_MS) {
        return { status: 'unknown', alert: false, reason: 'too old to verify (operation and/or objects aged out)' };
    }

    if (hasMarker === false) {
        return {
            status: 'failed',
            alert: true,
            reason: 'no export marker in bucket and operation not found',
        };
    }

    return { status: 'unknown', alert: false, reason: 'could not verify (marker not checked)' };
}

module.exports = { classifyBackup, STALL_MS, TOO_OLD_TO_JUDGE_MS };
