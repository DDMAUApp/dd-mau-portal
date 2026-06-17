// Integer-cents money math — faithful JS port of the cents helpers in the
// standalone Python payroll engine (app/engine/payroll.py `c()`,
// app/engine/extras.py `cents()`, app/engine/excel_out.py `d()`).
//
// WHY THE FUSSY ROUNDING: the Python engine computes every dollar as
// `int(round(value * 100))`. Python's built-in round() is round-half-to-EVEN
// (banker's rounding), and for negatives C's round() is half-away-from-zero
// before the even correction. JS `Math.round` is half-toward-+Infinity and does
// NOT match either. A single mismatched ½-cent tie would break "the JS engine
// produces identical numbers to the proven Python app" — the whole trust anchor
// of this feature. So `cRound` below reproduces CPython's float.__round__(None)
// algorithm exactly. The float arithmetic itself (`x * 100`) is IEEE-754 double
// in both languages, so the same input yields the same double, then the same
// rounded integer.

/**
 * Round a double to the nearest integer, ties-to-even — byte-identical to
 * CPython's `round(x)` (no ndigits). Mirrors CPython Objects/floatobject.c
 * float___round___impl: `r = round(x)` (C round, half away from zero), then if
 * `|x - r| == 0.5` it's an exact halfway case → `r = 2 * round(x / 2)`.
 */
export function cRound(x) {
    // C round(): half away from zero (JS Math.round is half toward +Inf, so we
    // round the magnitude and reapply the sign).
    const sign = x < 0 ? -1 : 1;
    let r = sign * Math.round(Math.abs(x));
    if (Math.abs(x - r) === 0.5) {
        const h = x / 2;
        const hs = h < 0 ? -1 : 1;
        r = 2 * (hs * Math.round(Math.abs(h)));
    }
    // Normalize -0 → 0 so results match Python's integer round() (no signed
    // zero) and never leak a -0 into comparisons / Excel cells.
    return r === 0 ? 0 : r;
}

/** `c(x)` — dollars (float) → integer cents. Mirrors payroll.c / extras.cents. */
export function c(x) {
    return cRound(Number(x) * 100);
}

/** `d(cents)` — integer cents → dollars rounded to 2dp. Mirrors excel_out.d. */
export function d(cents) {
    return roundN(cents / 100, 2);
}

/**
 * Round to N decimal places, ties-to-even, mirroring Python `round(x, n)`.
 * Implemented via the cents-faithful integer round on the scaled value, which
 * matches CPython for the "nice" magnitudes this engine deals in (sums of
 * 2-decimal hours, rate×hours products ≤4 decimals). The parity harness against
 * the real pay period confirms zero divergence.
 */
export function roundN(x, n) {
    const f = Math.pow(10, n);
    return cRound(Number(x) * f) / f;
}

/** Round to 2 decimals (the common case). */
export function round2(x) {
    return roundN(x, 2);
}

/**
 * Format a number like Python's `:g` (default 6 significant digits, trailing
 * zeros stripped). Used only in human-readable check/comment/detail strings,
 * never in a money cell. For the small magnitudes here (hours, rates) JS
 * `String(Number(x))` matches `%g` ("15"→"15", "33.33"→"33.33", "12.5"→"12.5").
 */
export function fmtG(x) {
    const n = Number(x);
    if (!isFinite(n)) return String(x);
    return String(n);
}

/**
 * Format dollars like Python `f"{x:,.2f}"` — grouped thousands, 2 decimals.
 * Display only (CHECKS sheet text, cell comments); the authoritative amounts
 * live in numeric cells computed in integer cents.
 */
export function money2(x) {
    return Number(x).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}
