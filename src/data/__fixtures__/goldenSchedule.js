// goldenSchedule.js — the deterministic test restaurant (Phase 1,
// SCHEDULING-FORENSICS.md §13). Every scheduling regression test runs
// against THIS dataset so a future failure points at a behavior change,
// never at fixture drift. Do not "refresh" this data casually — tests
// encode its exact shape.
//
// Deliberately covers the hazards the forensic audit called out:
//   • both stores + a 'both'-location floater
//   • FOH / BOH / 'both'-side staff + role-inferred sides (no scheduleSide)
//   • a minor, shift leads, managers, an owner (hideFromSchedule)
//   • availability: constrained windows, off-days, default-wide, absent
//   • time_off in BOTH schemas: startDate/endDate AND legacy bare `date`,
//     plus pending / approved / denied and a partial-day window
//   • a week of shifts with: overlap conflict, adjacent (non-conflict)
//     double-day, legacy isDouble single-shift, drafts + published,
//     cross-side assignment, missing side/location legacy docs
//
// Week under test: Sunday 2026-08-09 → Saturday 2026-08-15 (real Central
// dates; no DST transition inside the week — DST cases are constructed
// explicitly in the date tests).

export const GOLDEN_WEEK_START = '2026-08-09'; // a Sunday

export const GOLDEN_STAFF = [
    // FOH core
    { id: 1,  name: 'Ana Torres',    role: 'FOH', scheduleSide: 'foh', location: 'webster',
      availability: { mon: { available: true, from: '10:00', to: '16:00' }, sun: { available: false } } },
    { id: 2,  name: 'Ben Carter',    role: 'FOH', scheduleSide: 'foh', location: 'webster', targetHours: 30,
      availability: {} }, // default-wide: available all day every day
    { id: 3,  name: 'Cara Diaz',     role: 'FOH', scheduleSide: 'foh', location: 'maryland' },
    { id: 4,  name: 'Dev Patel',     role: 'FOH', scheduleSide: 'foh', location: 'webster', isMinor: true },
    { id: 5,  name: 'Eve Moran',     role: 'Shift Lead', scheduleSide: 'foh', location: 'webster', shiftLead: true },
    // BOH core
    { id: 6,  name: 'Franco Silva',  role: 'Pho Station', location: 'webster' },          // side INFERRED boh
    { id: 7,  name: 'Gia Chen',      role: 'Grill', scheduleSide: 'boh', location: 'maryland' },
    { id: 8,  name: 'Hugo Reyes',    role: 'Dish', scheduleSide: 'boh', location: 'webster' },
    { id: 9,  name: 'Iris Novak',    role: 'Prep', scheduleSide: 'boh', location: 'webster',
      availability: { wed: { available: true, from: '09:00', to: '21:00' } } }, // explicitly default-wide
    { id: 10, name: 'Jon Kim',       role: 'Kitchen Manager', location: 'webster' },      // manager tier, inferred boh
    // Floaters / management
    { id: 11, name: 'Kai Osei',      role: 'FOH', scheduleSide: 'both', location: 'both' },
    { id: 12, name: 'Lena Ruiz',     role: 'Manager', scheduleSide: 'both', location: 'webster' },
    { id: 13, name: 'Marco Bell',    role: 'Asst Manager', scheduleSide: 'foh', location: 'maryland' },
    { id: 14, name: 'Nadia Popov',   role: 'Owner', scheduleSide: 'both', location: 'both', hideFromSchedule: true },
    // Bench
    { id: 15, name: 'Omar Haddad',   role: 'FOH', scheduleSide: 'foh', location: 'webster',
      availability: { fri: { available: true, from: '15:00', to: '20:00' } } },
    { id: 16, name: 'Pia Lund',      role: 'Bao/Tacos/Banh Mi', location: 'maryland' },   // inferred boh
    { id: 17, name: 'Quinn Reed',    role: 'FOH', location: 'webster' },                  // no scheduleSide → foh
    { id: 18, name: 'Rosa Vega',     role: 'Spring Rolls/Prep', scheduleSide: 'boh', location: 'webster', isMinor: true },
    { id: 19, name: 'Sam Idris',     role: 'Shift Lead', scheduleSide: 'boh', location: 'maryland', shiftLead: true },
    { id: 20, name: 'Tara Woods',    role: 'FOH', scheduleSide: 'foh', location: 'webster', active: false }, // deactivated
];

export const GOLDEN_SHIFTS = [
    // Monday: Ana normal shift inside her window.
    { id: 's1',  staffName: 'Ana Torres',   date: '2026-08-10', startTime: '10:00', endTime: '15:00', side: 'foh', location: 'webster', published: true },
    // Monday: Ben DOUBLE DAY via two adjacent shifts (10-3 + 3-8 → adjacency, NOT a conflict; 1h break deducted once).
    { id: 's2',  staffName: 'Ben Carter',   date: '2026-08-10', startTime: '10:00', endTime: '15:00', side: 'foh', location: 'webster', published: true },
    { id: 's3',  staffName: 'Ben Carter',   date: '2026-08-10', startTime: '15:00', endTime: '20:00', side: 'foh', location: 'webster', published: true },
    // Tuesday: Cara OVERLAP conflict (11-4 vs 3-8 published) — the engine must flag exactly this pair.
    { id: 's4',  staffName: 'Cara Diaz',    date: '2026-08-11', startTime: '11:00', endTime: '16:00', side: 'foh', location: 'maryland', published: true },
    { id: 's5',  staffName: 'Cara Diaz',    date: '2026-08-11', startTime: '15:00', endTime: '20:00', side: 'foh', location: 'maryland', published: true },
    // Tuesday: Dev (minor) shift ending past 10 PM AND >8h — both minor warnings.
    { id: 's6',  staffName: 'Dev Patel',    date: '2026-08-11', startTime: '13:00', endTime: '22:30', side: 'foh', location: 'webster', published: true },
    // Wednesday: Franco legacy single-shift double (isDouble flag, built-in break).
    { id: 's7',  staffName: 'Franco Silva', date: '2026-08-12', startTime: '10:00', endTime: '20:00', side: 'boh', location: 'webster', published: true, isDouble: true },
    // Wednesday: Kai cross-side (home 'both', assigned boh) + DRAFT.
    { id: 's8',  staffName: 'Kai Osei',     date: '2026-08-12', startTime: '16:00', endTime: '20:00', side: 'boh', location: 'webster', published: false },
    // Thursday: Quinn DRAFT overlap vs published — visible to editors only.
    { id: 's9',  staffName: 'Quinn Reed',   date: '2026-08-13', startTime: '10:00', endTime: '15:00', side: 'foh', location: 'webster', published: true },
    { id: 's10', staffName: 'Quinn Reed',   date: '2026-08-13', startTime: '14:00', endTime: '18:00', side: 'foh', location: 'webster', published: false },
    // Friday: Omar OUTSIDE his 3-8 availability window (starts 10am).
    { id: 's11', staffName: 'Omar Haddad',  date: '2026-08-14', startTime: '10:00', endTime: '15:00', side: 'foh', location: 'webster', published: true },
    // LEGACY doc: no side, no location, no published field.
    { id: 's12', staffName: 'Eve Moran',    date: '2026-08-14', startTime: '11:00', endTime: '16:00' },
    // Malformed times — engines must skip, never throw.
    { id: 's13', staffName: 'Hugo Reyes',   date: '2026-08-15', startTime: 'bogus', endTime: '16:00', side: 'boh', location: 'webster', published: true },
];

export const GOLDEN_TIME_OFF = [
    // Current schema, approved, multi-day range (Gia off Tue–Thu).
    { id: 't1', staffName: 'Gia Chen',   status: 'approved', startDate: '2026-08-11', endDate: '2026-08-13' },
    // Current schema, PENDING single day (counts as off for scheduling guards).
    { id: 't2', staffName: 'Iris Novak', status: 'pending',  startDate: '2026-08-14', endDate: '2026-08-14' },
    // Current schema, DENIED (must never count).
    { id: 't3', staffName: 'Ben Carter', status: 'denied',   startDate: '2026-08-12', endDate: '2026-08-12' },
    // LEGACY schema: bare `date`, no startDate/endDate, no status (treated non-denied).
    { id: 't4', staffName: 'Hugo Reyes', date: '2026-08-13' },
    // PARTIAL window (Ana off 3–8pm Friday) — schedulable, overlap-warned.
    { id: 't5', staffName: 'Ana Torres', status: 'approved', startDate: '2026-08-14', endDate: '2026-08-14',
      partial: true, startTime: '15:00', endTime: '20:00' },
];

// date_blocks as the component's Map<'YYYY-MM-DD', block[]> shape.
export const goldenBlocksByDate = () => new Map([
    ['2026-08-12', [{ type: 'closed', reason: 'Deep clean', location: 'both' }]],
    ['2026-08-14', [{ type: 'no_timeoff', reason: 'Festival weekend', location: 'both' }]],
]);
