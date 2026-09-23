// stickerMatch — "do we already have a sticker called that?"
//
// Andrew 2026-09-23: staff were typing "pho plates" into Custom Print (or
// "+ Add item") when a real "Pho Plates" sticker already exists — so the
// label printed without its use-by date / allergens and the list grew
// duplicates. Every place a cook types a NEW sticker name now also acts as
// a search bar over the existing stickers, and an exact match makes them
// choose: use the real sticker, or keep their custom one.
//
// Name-only matching (EN + ES) on purpose — matching categories or
// descriptions would pop "Pho Broth" for a note that just mentions pho.
// Order-free, accent/case-free, plural-tolerant ("pho plate" == "Pho
// Plates"), and the last word may be half-typed ("pho pla").

import { normalize } from './chatSearch';

// Trailing plural → singular, conservative: "plates"→"plate",
// "sauces"→"sauce", "tomatoes"→"tomato"; "glass"/"bus" untouched.
function singular(w) {
    if (w.length > 4 && w.endsWith('oes')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
    return w;
}

function tokensOf(s) {
    const n = normalize(s);
    return n ? n.split(' ').filter(Boolean) : [];
}

// Canonical key for an exact-name comparison: singular tokens, sorted.
function exactKey(tokens) {
    return tokens.map(singular).sort().join(' ');
}

// Precompute tokens once per row (the index is rebuilt only when the
// sticker lists change, never per keystroke).
export function buildStickerMatchIndex(rows) {
    const out = [];
    for (const row of rows || []) {
        if (!row) continue;
        const names = [];
        for (const nm of [row.nameEn, row.nameEs]) {
            const t = tokensOf(nm);
            if (t.length && !names.some(x => x.key === exactKey(t))) names.push({ tokens: t, key: exactKey(t) });
        }
        if (names.length) out.push({ row, names });
    }
    return out;
}

// The line a cook is naming: the first non-empty line of what they typed
// ("PHO PLATES\nfor the party" → "PHO PLATES").
export function stickerNameQuery(text) {
    const line = String(text || '').split('\n').map(l => l.trim()).find(Boolean) || '';
    return line.slice(0, 80);
}

// Every query token must land on a DIFFERENT name token — whole-word
// (plural-tolerant) or, for the last token only, as a prefix while typing.
function tokensCover(qTokens, nameTokens) {
    const used = new Set();
    for (let i = 0; i < qTokens.length; i++) {
        const q = qTokens[i];
        const isLast = i === qTokens.length - 1;
        let hit = -1;
        for (let j = 0; j < nameTokens.length; j++) {
            if (used.has(j)) continue;
            const t = nameTokens[j];
            if (t === q || singular(t) === singular(q) || (isLast && q.length >= 2 && t.startsWith(q))) { hit = j; break; }
        }
        if (hit < 0) return false;
        used.add(hit);
    }
    return true;
}

// → [{ row, exact }] best first. `exact` = same words as an existing
// sticker (ignoring case, accents, order and plurals).
export function findStickerMatches(query, index, { limit = 5 } = {}) {
    const qTokens = tokensOf(query);
    if (!qTokens.length || !index || !index.length) return [];
    // One- or two-letter queries match half the list — wait for more.
    if (qTokens.join('').length < 3) return [];
    const qKey = exactKey(qTokens);
    const scored = [];
    for (const entry of index) {
        let best = null;
        for (const nm of entry.names) {
            if (nm.key === qKey) { best = { exact: true, extra: 0 }; break; }
            if (tokensCover(qTokens, nm.tokens)) {
                const extra = nm.tokens.length - qTokens.length;
                if (!best || extra < best.extra) best = { exact: false, extra };
            }
        }
        if (best) scored.push({ row: entry.row, exact: best.exact, extra: best.extra });
    }
    scored.sort((a, b) =>
        (b.exact - a.exact)
        || (a.extra - b.extra)
        || String(a.row.nameEn || '').localeCompare(String(b.row.nameEn || '')));
    return scored.slice(0, limit).map(({ row, exact }) => ({ row, exact }));
}

export function hasExactStickerMatch(query, index) {
    return findStickerMatches(query, index, { limit: 1 })[0]?.exact === true;
}
