// Client wrapper for the aiGeneratePromo Cloud Function.
//
// Andrew 2026-05-20 Wave 5 of "match the SaaS leaders, beat them
// where we can". Generates 3 bilingual promo banner variants from
// a short admin hint. Used by the PromoStripEditor in TvConfigsEditor.

import { getFunctions, httpsCallable } from 'firebase/functions';

let _callable = null;
function getCallable() {
    if (_callable) return _callable;
    const functions = getFunctions(undefined, 'us-central1');
    _callable = httpsCallable(functions, 'aiGeneratePromo', { timeout: 30_000 });
    return _callable;
}

// Generate banner variants from an admin hint.
//   hint:    free text — "happy hour", "promote catering", etc.
//   variant: optional flavor — 'promo', 'closure', 'welcome',
//            'special'. Currently passes through to the prompt as
//            a tag; the function ignores it for now but reserved
//            so we can fan out distinct prompt strategies later.
//
// Returns: { variants: [{ en, es }] }
// Throws on Cloud Function errors so the caller can toast the failure.
export async function generatePromo({ hint, variant = 'promo' } = {}) {
    const trimmed = String(hint || '').trim();
    if (!trimmed) throw new Error('hint required');
    if (trimmed.length > 300) throw new Error('hint too long (max 300)');
    const callable = getCallable();
    const res = await callable({ hint: trimmed, variant });
    const data = res?.data || {};
    return {
        variants: Array.isArray(data.variants) ? data.variants : [],
    };
}
