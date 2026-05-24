// tvHolidays.js — date-bound overlays for TV kiosk screens.
//
// Why this exists (Andrew 2026-05-23):
//   DD Mau has recurring Vietnamese-cuisine moments (Tết = huge) plus
//   US holidays. Without this, every Lunar New Year / Mother's Day /
//   Mid-Autumn / Christmas the owner has to manually edit ~4 TV
//   configs per location and remember to revert them. With ~6
//   holidays/year × 4 screens × 2 locations that's 50+ manual edits
//   annually, plus the inevitable "I forgot to swap it back."
//
//   This module is pure functions only — no React, no Firestore.
//   The component layer (TvHolidaysEditor + MenuDisplay subscription)
//   handles I/O. Keeping the date math separate makes it cheap to
//   unit-test and lets MenuDisplay apply overlays without coupling
//   to a particular UI shape.
//
// Schema (Firestore: /tv_holidays/{id}):
//   {
//     name:       string         // "Tết 2027"
//     preset:     string | null  // 'lunar_new_year' | 'mothers_day' | ...
//     dateStart:  'YYYY-MM-DD'   // inclusive, treated as midnight America/Chicago
//     dateEnd:    'YYYY-MM-DD'   // inclusive
//     priority:   number         // higher wins on overlap; default 0
//     appliesTo:  {
//       allTvs:    boolean       // if true, ignore tvIds + locations
//       tvIds:     string[]      // explicit tvIds
//       locations: string[]      // 'webster' | 'maryland'
//     }
//     overrides:  {
//       accentColor:    string | null  // hex; null = keep dd-green
//       bannerText:     string | null  // bilingual: { en, es, vi }
//       imageUrls:      string[]       // replaces tvConfig.imageUrls when non-empty
//       showCountdown:  boolean        // "3 days to Tết!" header strip
//       confettiOnEnter: boolean       // reserved for Phase 2 animation
//     }
//     enabled:    boolean        // soft-disable without deleting
//     createdBy, createdAt, updatedAt
//   }
//
// Timezone:
//   The restaurant is in America/Chicago. Date math intentionally uses
//   the device's local clock — every Pi is set to America/Chicago
//   during setup (raspi-config Step 1). If a Pi is mis-set to UTC,
//   holidays will fire at the wrong wall-clock time. Defensive
//   approach for Phase 2: shift all date comparisons to an explicit
//   Intl.DateTimeFormat with timeZone: 'America/Chicago'.

// ── PRESETS — sensible starter content per holiday ───────────────────
//
// Each preset is a partial { overrides, dateRangeFn } you can merge
// into a new holiday doc. dateRangeFn(year) → { dateStart, dateEnd }
// for one-click "schedule this holiday for the current year."
//
// Lunar dates change every year — Tết and Mid-Autumn ship with a
// few years of lookup tables rather than computing them on the fly
// (lunar conversion is fiddly + I'd rather hardcode + audit than
// debug subtle bugs).

const TET_DATES = {
    // (start, end) — Tết Eve through the 3-day festival
    2026: { dateStart: '2026-02-17', dateEnd: '2026-02-19' },
    2027: { dateStart: '2027-02-06', dateEnd: '2027-02-08' },
    2028: { dateStart: '2028-01-26', dateEnd: '2028-01-28' },
    2029: { dateStart: '2029-02-13', dateEnd: '2029-02-15' },
    2030: { dateStart: '2030-02-03', dateEnd: '2030-02-05' },
};

const MID_AUTUMN_DATES = {
    2026: { dateStart: '2026-09-25', dateEnd: '2026-09-26' },
    2027: { dateStart: '2027-09-15', dateEnd: '2027-09-16' },
    2028: { dateStart: '2028-10-03', dateEnd: '2028-10-04' },
    2029: { dateStart: '2029-09-22', dateEnd: '2029-09-23' },
    2030: { dateStart: '2030-09-12', dateEnd: '2030-09-13' },
};

// Helpers for fixed-rule dates (e.g. "2nd Sunday of May" for Mother's Day).
function nthWeekdayOfMonth(year, monthIndex0, weekday, n) {
    const d = new Date(year, monthIndex0, 1);
    const offset = (weekday - d.getDay() + 7) % 7;
    d.setDate(1 + offset + 7 * (n - 1));
    return d;
}
function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function fixedRange(year, month1to12, day) {
    const m = String(month1to12).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return { dateStart: `${year}-${m}-${d}`, dateEnd: `${year}-${m}-${d}` };
}

export const HOLIDAY_PRESETS = {
    lunar_new_year: {
        label: 'Tết — Lunar New Year',
        labelVi: 'Tết Nguyên Đán',
        emoji: '🧧',
        accentColor: '#dc2626', // festive red
        bannerText: {
            en: 'Chúc Mừng Năm Mới — Happy Lunar New Year!',
            es: '¡Feliz Año Nuevo Lunar!',
            vi: 'Chúc Mừng Năm Mới',
        },
        dateRangeFn: (year) => TET_DATES[year] || null,
        showCountdown: true,
    },
    mid_autumn: {
        label: 'Mid-Autumn Festival',
        labelVi: 'Tết Trung Thu',
        emoji: '🥮',
        accentColor: '#ea580c', // mooncake amber
        bannerText: {
            en: 'Mid-Autumn Festival — Happy Tết Trung Thu',
            es: 'Festival de Medio Otoño',
            vi: 'Tết Trung Thu Vui Vẻ',
        },
        dateRangeFn: (year) => MID_AUTUMN_DATES[year] || null,
        showCountdown: true,
    },
    mothers_day: {
        label: 'Mother\'s Day',
        emoji: '🌷',
        accentColor: '#db2777', // pink
        bannerText: {
            en: 'Happy Mother\'s Day — brunch all day',
            es: 'Feliz Día de la Madre',
        },
        // 2nd Sunday of May
        dateRangeFn: (year) => {
            const d = nthWeekdayOfMonth(year, 4, 0, 2); // May, Sunday, 2nd
            return { dateStart: isoDate(d), dateEnd: isoDate(d) };
        },
        showCountdown: false,
    },
    valentines: {
        label: 'Valentine\'s Day',
        emoji: '❤️',
        accentColor: '#e11d48', // rose
        bannerText: {
            en: 'Happy Valentine\'s — date night specials',
            es: 'Feliz Día de San Valentín',
        },
        dateRangeFn: (year) => fixedRange(year, 2, 14),
        showCountdown: false,
    },
    independence_day: {
        label: 'Independence Day',
        emoji: '🎆',
        accentColor: '#1d4ed8',
        bannerText: {
            en: 'Happy 4th of July',
            es: 'Feliz 4 de Julio',
        },
        dateRangeFn: (year) => fixedRange(year, 7, 4),
        showCountdown: false,
    },
    thanksgiving: {
        label: 'Thanksgiving',
        emoji: '🦃',
        accentColor: '#b45309', // pumpkin amber
        bannerText: {
            en: 'Happy Thanksgiving — closed early today',
            es: 'Feliz Día de Acción de Gracias',
        },
        // 4th Thursday of November
        dateRangeFn: (year) => {
            const d = nthWeekdayOfMonth(year, 10, 4, 4); // Nov, Thursday, 4th
            return { dateStart: isoDate(d), dateEnd: isoDate(d) };
        },
        showCountdown: false,
    },
    christmas: {
        label: 'Christmas',
        emoji: '🎄',
        accentColor: '#15803d', // tree green
        bannerText: {
            en: 'Merry Christmas — see you Dec 26',
            es: 'Feliz Navidad',
        },
        // Christmas Eve + Christmas Day
        dateRangeFn: (year) => ({
            dateStart: `${year}-12-24`,
            dateEnd:   `${year}-12-25`,
        }),
        showCountdown: true,
    },
    new_years_eve: {
        label: 'New Year\'s Eve',
        emoji: '🎉',
        accentColor: '#7c3aed', // confetti purple
        bannerText: {
            en: 'NYE — open till 10pm, see you in the new year',
            es: 'Víspera de Año Nuevo',
        },
        dateRangeFn: (year) => fixedRange(year, 12, 31),
        showCountdown: true,
    },
};

// Ordered list for the editor's "+ Preset" dropdown. Keeps the most
// Vietnamese-restaurant-relevant ones at the top.
export const HOLIDAY_PRESET_ORDER = [
    'lunar_new_year', 'mid_autumn',
    'mothers_day', 'valentines',
    'independence_day', 'thanksgiving',
    'christmas', 'new_years_eve',
];

// ── DATE RESOLUTION ──────────────────────────────────────────────────

// Given an ISO date string ('YYYY-MM-DD') return a Date at local
// midnight. Lenient: returns null on malformed input.
function parseLocalIsoDate(iso) {
    if (typeof iso !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(y, mo, d);
    return isNaN(dt.getTime()) ? null : dt;
}

// Is `now` within [dateStart, dateEnd] inclusive? Times of day are
// ignored — `dateEnd` is inclusive through 23:59:59 local time.
export function isHolidayActiveOn(holiday, now = new Date()) {
    if (!holiday || holiday.enabled === false) return false;
    const start = parseLocalIsoDate(holiday.dateStart);
    const end   = parseLocalIsoDate(holiday.dateEnd);
    if (!start || !end) return false;
    // Compare to start-of-day local time so we don't lose hours on DST.
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return today >= start && today <= end;
}

// Does the holiday apply to this specific TV? `tvId` is the document
// id; `location` is 'webster' | 'maryland'.
export function holidayAppliesToTv(holiday, tvId, location) {
    const a = holiday?.appliesTo || {};
    if (a.allTvs) return true;
    if (Array.isArray(a.tvIds) && a.tvIds.includes(tvId)) return true;
    if (Array.isArray(a.locations) && location && a.locations.includes(location)) return true;
    // Defensive fallback: if appliesTo is missing entirely (older docs
    // before this field existed), assume the holiday applies everywhere.
    if (!a.allTvs && !Array.isArray(a.tvIds) && !Array.isArray(a.locations)) return true;
    return false;
}

// Of N holidays, pick the one to apply for this TV at this moment.
// Active + applicable + highest priority wins. Ties broken by most-
// recently-updated. Returns null if no holiday matches.
export function resolveActiveHoliday(holidays, { tvId, location, now = new Date() } = {}) {
    if (!Array.isArray(holidays) || holidays.length === 0) return null;
    const candidates = holidays
        .filter(h => isHolidayActiveOn(h, now))
        .filter(h => holidayAppliesToTv(h, tvId, location));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        const pa = Number(a.priority || 0);
        const pb = Number(b.priority || 0);
        if (pb !== pa) return pb - pa;
        const ua = a.updatedAt?.toMillis ? a.updatedAt.toMillis()
            : a.updatedAt?.seconds ? a.updatedAt.seconds * 1000 : 0;
        const ub = b.updatedAt?.toMillis ? b.updatedAt.toMillis()
            : b.updatedAt?.seconds ? b.updatedAt.seconds * 1000 : 0;
        return ub - ua;
    });
    return candidates[0];
}

// Days from `now` until the holiday's dateStart (rounded to whole
// days, midnight to midnight). Returns negative if already underway,
// null if dateStart can't be parsed. Powers the "3 days to Tết!"
// countdown strip.
export function daysUntilHoliday(holiday, now = new Date()) {
    const start = parseLocalIsoDate(holiday?.dateStart);
    if (!start) return null;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((start - today) / (24 * 60 * 60 * 1000));
}

// ── OVERLAY MERGE ────────────────────────────────────────────────────
//
// Given the base tvConfig and an active holiday, return an effective
// config with the holiday's overrides applied. Pure — no mutation.
// Behaviour rules (intentional defaults):
//   • accentColor: holiday wins when set (replaces dd-green in UI)
//   • bannerText:  always rendered when set (on top of normal header)
//   • imageUrls:   REPLACES tvConfig.imageUrls when the holiday has
//                  non-empty images. Falls through to tvConfig images
//                  if the admin scheduled a holiday but forgot to add
//                  images — better to show normal content than blank.
//   • showCountdown: rendered as a slim strip above the header
//
// Caller (MenuDisplay) is responsible for actually rendering — this
// just produces the merged data.
export function applyHolidayOverlay(tvConfig, holiday) {
    if (!holiday || !holiday.overrides) return { config: tvConfig, holiday: null };
    const o = holiday.overrides;
    const merged = { ...tvConfig };
    if (Array.isArray(o.imageUrls) && o.imageUrls.length > 0) {
        merged.imageUrls = o.imageUrls;
        // Holiday image rotation — keep config's rotateSeconds; don't
        // override unless we ship a holiday-specific value later.
    }
    return {
        config: merged,
        holiday: {
            ...holiday,
            // Pre-resolved fields for the renderer
            _accentColor: o.accentColor || null,
            _bannerText:  o.bannerText  || null,
            _showCountdown: !!o.showCountdown,
        },
    };
}
