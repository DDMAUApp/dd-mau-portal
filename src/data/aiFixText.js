// Client wrapper for the aiFixText Cloud Function.
//
// Andrew 2026-05-20 — "make the staff chat page text bar have ai to
// help with spelling and grammer too." Sends a chat draft to Claude
// (server side, via Cloud Function) and gets back a spelling /
// grammar-corrected version that preserves the writer's voice.
//
// Used today by ChatThread's composer (✨ button next to Send).
// Reusable anywhere we have a short user-typed message we want to
// polish before persisting — search comments could grow this list.

import { getFunctions, httpsCallable } from 'firebase/functions';

let _callable = null;
function getCallable() {
    if (_callable) return _callable;
    const functions = getFunctions(undefined, 'us-central1');
    _callable = httpsCallable(functions, 'aiFixText');
    return _callable;
}

// fixText({ text, language }) → { fixed, changed, originalLength,
// fixedLength }. Throws on network / API errors so the caller can
// surface a toast and keep the original draft.
//
// `language`: optional. 'en' or 'es' anchors the model so it doesn't
//   translate by accident. Pass the user's preferred language. If
//   omitted, the model detects and keeps the source language.
export async function fixText({ text, language }) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { fixed: '', changed: false };
    if (trimmed.length > 1000) {
        // Mirror the server cap. Caller should slice and re-call or
        // skip the fix entirely on huge pastes.
        throw new Error('text too long (max 1000 chars)');
    }
    const callable = getCallable();
    const res = await callable({
        text: trimmed,
        language: language || '',
    });
    const data = res?.data || {};
    return {
        fixed: typeof data.fixed === 'string' ? data.fixed : trimmed,
        changed: data.changed === true,
        originalLength: data.originalLength ?? trimmed.length,
        fixedLength: data.fixedLength ?? trimmed.length,
    };
}
