// Pins the backup-verification decision table (2026-08-01).
//
// The property that matters most is the LAST describe block: the first
// run of verifyFirestoreBackup sees ~26 historical 'started' rows, and
// must not fire 26 retroactive critical alerts at the owner.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyBackup, STALL_MS, TOO_OLD_TO_JUDGE_MS } = require('./backupVerify.js');

const HOUR = 3600000;
const DAY = 24 * HOUR;

describe('operation lookup succeeded', () => {
    it('marks a finished export completed', () => {
        const r = classifyBackup({ found: true, done: true, ageMs: HOUR });
        expect(r).toMatchObject({ status: 'completed', alert: false });
    });

    it('marks a finished-with-error export failed AND alerts', () => {
        const r = classifyBackup({ found: true, done: true, error: 'quota exceeded', ageMs: HOUR });
        expect(r.status).toBe('failed');
        expect(r.alert).toBe(true);
        expect(r.reason).toContain('quota exceeded');
    });

    it('leaves a genuinely in-flight export alone without alerting', () => {
        const r = classifyBackup({ found: true, done: false, ageMs: 10 * 60000 });
        expect(r).toMatchObject({ status: 'started', alert: false });
    });

    it('flags an export still running past the stall threshold', () => {
        const r = classifyBackup({ found: true, done: false, ageMs: STALL_MS + 1 });
        expect(r.status).toBe('stalled');
        expect(r.alert).toBe(true);
    });

    it('does not flag one that is exactly at the threshold', () => {
        const r = classifyBackup({ found: true, done: false, ageMs: STALL_MS });
        expect(r.alert).toBe(false);
    });
});

describe('operation lookup failed — fall back to the bucket', () => {
    it('trusts the export marker as proof of completion', () => {
        const r = classifyBackup({ found: false, ageMs: 2 * DAY, hasMarker: true });
        expect(r).toMatchObject({ status: 'completed', alert: false });
        expect(r.reason).toContain('marker');
    });

    it('treats a recent backup with no marker as a real failure', () => {
        const r = classifyBackup({ found: false, ageMs: 2 * DAY, hasMarker: false });
        expect(r.status).toBe('failed');
        expect(r.alert).toBe(true);
    });

    it('stays silent when the marker was never checked', () => {
        const r = classifyBackup({ found: false, ageMs: 2 * DAY, hasMarker: null });
        expect(r).toMatchObject({ status: 'unknown', alert: false });
    });
});

describe('never retro-alerts on rows too old to judge', () => {
    it('goes quiet on an old missing-marker row instead of crying failure', () => {
        // Operations are GC'd and buckets have lifecycle rules — absence
        // of evidence is not evidence of failure this far back.
        const r = classifyBackup({ found: false, ageMs: TOO_OLD_TO_JUDGE_MS + DAY, hasMarker: false });
        expect(r.status).toBe('unknown');
        expect(r.alert).toBe(false);
    });

    it('still credits an old row that DOES have its marker', () => {
        const r = classifyBackup({ found: false, ageMs: 60 * DAY, hasMarker: true });
        expect(r.status).toBe('completed');
    });

    it('the first run over historical rows fires ZERO alerts', () => {
        // Simulates the 26 'started' rows sitting in backup_history today:
        // recent ones verify via marker, old ones age out. Neither alerts.
        const historical = Array.from({ length: 26 }, (_, i) => ({
            found: false,
            ageMs: (i + 1) * DAY,
            hasMarker: i < 14,          // recent have markers, older aged out
        }));
        const alerts = historical.map(classifyBackup).filter((r) => r.alert);
        expect(alerts).toHaveLength(0);
    });
});

describe('degenerate input', () => {
    it('treats a missing age as 0 rather than NaN-comparing', () => {
        const r = classifyBackup({ found: true, done: false, ageMs: undefined });
        expect(r.status).toBe('started');
        expect(r.alert).toBe(false);
    });
});
