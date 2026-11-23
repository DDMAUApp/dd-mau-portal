// Sampler platter picks — Firestore-safe shape.
//
// In the form, a sampler's protein picks are a list per group
// (Banh Mi / Mini Bowls / Rice Rolls): [["Chicken","Pork"], ["Beef"], []].
// Firestore refuses arrays inside arrays, so every order with a sampler
// failed to save ("Nested arrays are not supported" — Yulissa 2026-11-23).
// Saved orders store each group as an object instead: [{ picks: [...] }, ...].
// decodeSampler reads BOTH shapes, so it is safe on cart items, drafts and
// saved orders alike.

export function encodeSampler(groups) {
    if (!Array.isArray(groups)) return groups ?? null;
    return groups.map((g) => ({ picks: Array.isArray(g) ? g.map(String) : (Array.isArray(g?.picks) ? g.picks.map(String) : []) }));
}

export function decodeSampler(groups) {
    if (!Array.isArray(groups)) return null;
    return groups.map((g) => (Array.isArray(g) ? g : (Array.isArray(g?.picks) ? g.picks : [])));
}

// Cart → order items: drop the cart-only id, make sampler picks saveable.
export function itemsForSave(cart) {
    return (Array.isArray(cart) ? cart : []).map(({ id, ...rest }) => (
        rest.samplerProteins ? { ...rest, samplerProteins: encodeSampler(rest.samplerProteins) } : rest
    ));
}
