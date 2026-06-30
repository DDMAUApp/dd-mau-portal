// The live roster — JS port of app/engine/roster.py, cloud-backed instead of a
// roster.json file. It carries the handful of facts Toast can't tell us and that
// rarely change: section (FOH/BOH), direct_deposit, no_tip, optional legal_name,
// last_rate (fallback only), plus a per-location salary list for owners who are
// paid a fixed amount and never appear on the Toast export.
//
// Rates and names come from each Toast payroll export (current per the owner);
// the roster never holds the pay rate except an optional rate_override.
//
// The persistence (Firestore config/payroll_roster read/write) lives in
// payrollStore.js — this module is PURE so it unit-tests against the Python
// engine without any Firebase dependency.

import { keyFromMaster } from './names.js';

export const LOCATIONS = ['WG', 'MH'];

export function blankRoster() {
    return { version: 1, WG: { people: {}, salary: [] }, MH: { people: {}, salary: [] } };
}

/** Normalize a roster object loaded from Firestore. Mirrors roster.read_roster defaults. */
export function normalizeRoster(data) {
    // Deep-clone so we never mutate the caller's object in place (the Firestore
    // snap.data() is fresh today, but a future caller could reuse one — and we
    // write p.key/defaults onto every person here).
    const out = (data && typeof data === 'object') ? JSON.parse(JSON.stringify(data)) : {};
    if (out.version === undefined) out.version = 1;
    for (const loc of LOCATIONS) {
        if (!out[loc]) out[loc] = {};
        if (!out[loc].people) out[loc].people = {};
        if (!out[loc].salary) out[loc].salary = [];
        for (const key of Object.keys(out[loc].people)) {
            const p = out[loc].people[key];
            if (p.first === undefined) p.first = '';
            if (p.last === undefined) p.last = '';
            if (p.section === undefined) p.section = null;
            if (p.direct_deposit === undefined) p.direct_deposit = false;
            if (p.no_tip === undefined) p.no_tip = false;
            if (p.legal_name === undefined) p.legal_name = '';
            if (p.last_rate === undefined) p.last_rate = null;
            if (p.first_seen === undefined) p.first_seen = '';
            if (p.last_seen === undefined) p.last_seen = '';
            p.key = key;
        }
    }
    return out;
}

/** "Last, First" legal-name split → [first, last]. Mirrors roster._split_legal. */
export function splitLegal(legalName) {
    if (!legalName) return ['', ''];
    if (legalName.includes(',')) {
        const i = legalName.indexOf(',');
        return [legalName.slice(i + 1).trim(), legalName.slice(0, i).trim()];
    }
    const idx = legalName.lastIndexOf(' ');
    if (idx >= 0) return [legalName.slice(0, idx).trim(), legalName.slice(idx + 1).trim()];
    return [legalName, ''];
}

/**
 * Make sure every name on this period's Toast export exists in the roster.
 * Existing people get last_rate/last_seen refreshed; new names are added with
 * section from staffDefaults (the portal staff list) if known, else null — so
 * they surface for one-time setup. Returns the keys newly added. Mirrors
 * roster.sync_with_toast, plus the "prefill from staff list" upgrade.
 */
export function syncWithToast(data, loc, toastEmps, period, staffDefaults) {
    const people = data[loc].people;
    const newKeys = [];
    for (const key of Object.keys(toastEmps)) {
        const t = toastEmps[key];
        if (Object.prototype.hasOwnProperty.call(people, key)) {
            const p = people[key];
            if (t.toast_rate) p.last_rate = t.toast_rate;
            p.last_seen = period;
            if (!p.first) p.first = t.first;
            if (!p.last) p.last = t.last;
        } else {
            const def = staffDefaults && staffDefaults[key];
            people[key] = {
                first: t.first, last: t.last,
                section: (def && def.section) || null,
                direct_deposit: false, no_tip: false,
                legal_name: '', last_rate: t.toast_rate == null ? null : t.toast_rate,
                first_seen: period, last_seen: period, key,
            };
            newKeys.push(key);
        }
    }
    return newKeys;
}

/** Create/update one roster person's editable fields (used by the UI). Mirrors roster.upsert_person. */
export function upsertPerson(data, loc, key, fields) {
    const people = data[loc].people;
    let p = people[key];
    if (!p) {
        p = {
            first: fields.first || '', last: fields.last || '', section: null,
            direct_deposit: false, no_tip: false, legal_name: '', last_rate: null,
            first_seen: 'manual', last_seen: 'manual', key,
        };
        people[key] = p;
    }
    if (fields.first !== undefined && fields.first !== null) p.first = fields.first;
    if (fields.last !== undefined && fields.last !== null) p.last = fields.last;
    if (fields.section !== undefined && fields.section !== null) {
        const sec = String(fields.section).trim().toUpperCase();
        p.section = (sec === 'FOH' || sec === 'BOH') ? sec : null;
    }
    if (fields.direct_deposit !== undefined && fields.direct_deposit !== null) p.direct_deposit = !!fields.direct_deposit;
    if (fields.no_tip !== undefined && fields.no_tip !== null) p.no_tip = !!fields.no_tip;
    if (fields.legal_name !== undefined && fields.legal_name !== null) p.legal_name = String(fields.legal_name).trim();
    if (fields.rate_override !== undefined) {
        const ro = fields.rate_override;
        if (ro === '' || ro === null || ro === undefined) delete p.rate_override;
        else p.rate_override = Number(ro);
    }
    return p;
}

/**
 * Adapt the roster into the shape the engine consumes (same as the old
 * master.read_master), with the pay RATE taken from Toast for anyone who worked.
 * Only people with a real FOH/BOH section become `employees`; anyone still
 * missing a section is left out so the engine routes them to the red "NEW"
 * review section. Mirrors roster.as_rate_data (incl. rate precedence
 * rate_override > Toast > last_rate).
 */
export function asRateData(data, loc, toastEmps) {
    const employees = [];
    const salary = [];
    const byKey = {};
    const errors = [];
    const people = (data[loc] && data[loc].people) || {};
    for (const key of Object.keys(people)) {
        const p = people[key];
        const section = p.section;
        if (section !== 'FOH' && section !== 'BOH') continue; // new hire awaiting setup → review
        const t = toastEmps[key];
        const override = p.rate_override;
        let rate;
        if (override !== null && override !== undefined && override !== ''
            && Number.isFinite(Number(override)) && Number(override) !== 0) {
            rate = Number(override);
        } else {
            const fallback = (t && t.toast_rate) ? t.toast_rate : p.last_rate;
            rate = Number(fallback);
        }
        // A pay rate must ALWAYS be a finite number. A non-numeric last_rate/override
        // (e.g. "oops" stored by some other path) would otherwise yield NaN cents and
        // ship a blank/NaN paycheck on an all-green run. Coerce to 0 here; runLocation
        // then hard-FAILS any worked person left at $0 so it can never pay wrong.
        if (!Number.isFinite(rate)) rate = 0;
        const [lf, ll] = splitLegal(p.legal_name);
        const emp = {
            first: p.first, last: p.last, rate: Number(rate),
            section, direct_deposit: !!p.direct_deposit,
            no_tip: !!p.no_tip, legal_name: p.legal_name || '',
            legal_first: lf, legal_last: ll, note: '', row: null, key,
        };
        employees.push(emp);
        byKey[key] = emp;
    }
    for (const s of (data[loc] && data[loc].salary) || []) {
        const key = keyFromMaster(s.first, s.last);
        const [lf, ll] = splitLegal(s.legal_name);
        const emp = {
            first: s.first, last: s.last, rate: Number(s.amount || 0),
            section: 'SALARY', direct_deposit: s.direct_deposit === undefined ? true : !!s.direct_deposit,
            no_tip: true, legal_name: s.legal_name || '',
            legal_first: lf, legal_last: ll, note: '', row: null, key,
        };
        salary.push(emp);
        byKey[key] = emp;
    }
    return { employees, salary, by_key: byKey, errors, path: 'config/payroll_roster' };
}

/**
 * Default section by match-key from the portal staff list (the "prefill" upgrade):
 * staff scheduleSide foh→FOH / boh→BOH. The staff display name is "First Last",
 * and keyFromMaster(first, last) lines up with the Toast key (also first-last
 * order), so a worked person who exists in the staff list gets a suggested
 * section instead of landing as a blank NEW row.
 */
export function staffDefaultsByKey(staffList) {
    const map = {};
    for (const s of (staffList || [])) {
        const name = String(s.name || '').trim();
        if (!name) continue;
        const parts = name.split(/\s+/);
        const first = parts[0] || '';
        const last = parts.slice(1).join(' ');
        const key = keyFromMaster(first, last);
        const side = String(s.scheduleSide || '').toLowerCase();
        const section = side === 'foh' ? 'FOH' : (side === 'boh' ? 'BOH' : null);
        if (section && key) map[key] = { section };
    }
    return map;
}

/**
 * Build the per-location people list the People & Direct Deposit step renders
 * (roster people merged with this period's Toast hours + NEW flags). Mirrors the
 * roster view that the standalone /api/import endpoint returned. UI-only.
 */
export function buildRosterView(data, exportsEmployees) {
    const view = {};
    for (const loc of LOCATIONS) {
        const people = (data[loc] && data[loc].people) || {};
        const emps = exportsEmployees[loc] || {};
        const list = Object.keys(people).map((key) => {
            const p = people[key];
            const t = emps[key];
            const onToast = !!t;
            const section = (p.section === 'FOH' || p.section === 'BOH') ? p.section : null;
            return {
                key, first: p.first, last: p.last, section,
                direct_deposit: !!p.direct_deposit, no_tip: !!p.no_tip,
                legal_name: p.legal_name || '', rate_override: p.rate_override == null ? '' : p.rate_override,
                last_rate: p.last_rate == null ? null : p.last_rate,
                on_toast: onToast,
                reg_hours: t ? t.reg_hours : null,
                ot_hours: t ? t.ot_hours : null,
                toast_rate: t ? t.toast_rate : null,
                needs_setup: onToast && !section,
            };
        });
        list.sort((a, b) => {
            const rank = (x) => (x.needs_setup ? 0 : (x.on_toast ? 1 : 2));
            if (rank(a) !== rank(b)) return rank(a) - rank(b);
            const al = (a.last || '').toLowerCase();
            const bl = (b.last || '').toLowerCase();
            if (al !== bl) return al < bl ? -1 : 1;
            const af = (a.first || '').toLowerCase();
            const bf = (b.first || '').toLowerCase();
            return af < bf ? -1 : (af > bf ? 1 : 0);
        });
        view[loc] = {
            people: list,
            salary: ((data[loc] && data[loc].salary) || []).map((s) => ({ ...s })),
        };
    }
    return view;
}
