// Regression guard for the 2026-08-15 chat-perf forensics (P0-1).
//
// AppDataContext holds the ALWAYS-ON Firestore listeners for the whole app.
// Every document resident in any active view is re-scanned by the Firestore
// SDK on every emit (local write / server echo / ack), so an unbounded
// raw-row listener here taxes EVERY page — chat most visibly. The two
// laborHistory_{loc} listeners held ~42.5k docs and cost ~110 ms of main-
// thread work per emit (measured). This test pins the invariant statically:
//
//   1. no `laborHistory_` collection may be subscribed from AppDataContext;
//   2. every `collection(db, …)` query in AppDataContext must be bounded —
//      either a `limit(...)` or a date/startDate range keyed to a short
//      window — and the known-bounded set is enumerated so a NEW listener
//      forces a conscious update here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'AppDataContext.jsx'), 'utf8');
// Strip comments so historical notes don't trip the assertions.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('AppDataContext always-on listeners stay bounded', () => {
    it('never subscribes to raw laborHistory_{loc} rows', () => {
        expect(code).not.toMatch(/collection\(\s*db\s*,\s*[`'"]laborHistory_/);
        expect(code).not.toMatch(/hydrateSplhFromCache/);
    });

    it('every collection query in the provider is one of the known bounded ones', () => {
        const paths = [...code.matchAll(/collection\(\s*db\s*,\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]).sort();
        // Update this list ONLY after confirming the new query is bounded
        // (limit(...) or a short date window) — and think about whether it
        // really needs to be app-wide + always-on.
        expect(paths).toEqual(['notifications', 'shifts', 'time_off']);
        // notifications: limit(100); shifts: 14-day date window; time_off: 180d startDate window.
        expect(code).toMatch(/collection\(db, 'notifications'\)[\s\S]{0,400}limit\(100\)/);
        expect(code).toMatch(/collection\(db, 'shifts'\)[\s\S]{0,200}where\('date', '>=', fmt\(today\)\)/);
        expect(code).toMatch(/collection\(db, 'time_off'\)[\s\S]{0,200}where\('startDate', '>=', cutoffStr\)/);
    });

    it('exposes an empty laborHistory pair (consumers already treat [] as no data)', () => {
        expect(code).toMatch(/const laborHistory = EMPTY_LABOR_HISTORY/);
        expect(code).toMatch(/EMPTY_LABOR_HISTORY = Object\.freeze\(\{ webster: \[\], maryland: \[\] \}\)/);
    });
});
