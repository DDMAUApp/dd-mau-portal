// Pins the 2026-07-30 language-aware template selection (Andrew: "i have alot
// of spanish speaking staff that try to do the onboarding but since its in
// english its hard for them").
//
// Templates gained a `language` field so an official Spanish edition of a form
// — the IRS's Formulario W-4(SP) is the motivating case — can be served only to
// Spanish-language hires. The load-bearing property is BACKWARD COMPATIBILITY:
// every template uploaded before this field existed has no `language`, and must
// keep serving everyone exactly as it did.
//
// This mirrors the ranking in OnboardingPortal's template subscription. Kept as
// a pure function here so the rules are testable without mounting the portal.

import { describe, it, expect } from 'vitest';

/** Highest rank wins; 0 means "never serve this one". */
export function rankTemplate(t, wantLang) {
    const l = t.language || 'any';
    if (l === wantLang) return 2;
    if (l === 'any') return 1;
    return 0;
}

/** Pick the best template for a mode: language match first, then newest. */
export function pickTemplate(templates, wantLang, mode = 'fillable') {
    let best = null;
    for (const t of templates) {
        const tMode = t.mode || 'fillable';
        if (tMode !== mode) continue;
        if (rankTemplate(t, wantLang) === 0) continue;
        if (!best) { best = t; continue; }
        const rc = rankTemplate(t, wantLang), rb = rankTemplate(best, wantLang);
        if (rc !== rb) { if (rc > rb) best = t; continue; }
        if ((best.updatedAt || '') < (t.updatedAt || '')) best = t;
    }
    return best;
}

const T = (over) => ({ mode: 'fillable', updatedAt: '2026-01-01', ...over });

describe('backward compatibility — untagged templates keep working', () => {
    it('serves a language-less template to an English hire', () => {
        const t = T({ id: 'legacy' });
        expect(pickTemplate([t], 'en')?.id).toBe('legacy');
    });

    it('serves the same language-less template to a Spanish hire', () => {
        const t = T({ id: 'legacy' });
        expect(pickTemplate([t], 'es')?.id).toBe('legacy');
    });

    it('still picks the newest among several untagged templates', () => {
        const picked = pickTemplate([
            T({ id: 'old', updatedAt: '2026-01-01' }),
            T({ id: 'new', updatedAt: '2026-06-01' }),
        ], 'en');
        expect(picked.id).toBe('new');
    });
});

describe('language targeting', () => {
    const w4 = T({ id: 'w4-en', language: 'en', updatedAt: '2026-01-01' });
    const w4sp = T({ id: 'w4-sp', language: 'es', updatedAt: '2026-01-01' });

    it('gives the Spanish hire the Spanish edition', () => {
        expect(pickTemplate([w4, w4sp], 'es').id).toBe('w4-sp');
    });

    it('gives the English hire the English edition', () => {
        expect(pickTemplate([w4, w4sp], 'en').id).toBe('w4-en');
    });

    it('NEVER serves a wrong-language form, even as a last resort', () => {
        // Only a Spanish W-4 exists. An English hire must fall through to the
        // built-in handler (null) rather than be handed a Spanish tax form.
        expect(pickTemplate([w4sp], 'en')).toBeNull();
    });

    it('prefers an exact language match over a newer universal template', () => {
        const picked = pickTemplate([
            T({ id: 'universal-new', updatedAt: '2026-09-01' }),
            T({ id: 'es-old', language: 'es', updatedAt: '2026-01-01' }),
        ], 'es');
        expect(picked.id).toBe('es-old');
    });

    it('falls back to the universal template when no exact match exists', () => {
        const picked = pickTemplate([
            T({ id: 'universal', updatedAt: '2026-01-01' }),
            T({ id: 'en-only', language: 'en', updatedAt: '2026-09-01' }),
        ], 'es');
        expect(picked.id).toBe('universal');
    });
});

describe('modes stay independent', () => {
    it('a reference template never satisfies a fillable lookup', () => {
        const refOnly = T({ id: 'ref', mode: 'reference', language: 'es' });
        expect(pickTemplate([refOnly], 'es', 'fillable')).toBeNull();
        expect(pickTemplate([refOnly], 'es', 'reference').id).toBe('ref');
    });

    it('picks the right language independently per mode', () => {
        const all = [
            T({ id: 'fill-es', language: 'es' }),
            T({ id: 'fill-en', language: 'en' }),
            T({ id: 'ref-es', mode: 'reference', language: 'es' }),
            T({ id: 'ref-en', mode: 'reference', language: 'en' }),
        ];
        expect(pickTemplate(all, 'es', 'fillable').id).toBe('fill-es');
        expect(pickTemplate(all, 'es', 'reference').id).toBe('ref-es');
    });

    it('treats a missing mode as fillable (pre-mode-field templates)', () => {
        const legacy = { id: 'nomode', updatedAt: '2026-01-01' };
        expect(pickTemplate([legacy], 'en', 'fillable').id).toBe('nomode');
    });
});

describe('no templates at all', () => {
    it('returns null so the doc uses its built-in handler', () => {
        expect(pickTemplate([], 'es')).toBeNull();
    });
});
