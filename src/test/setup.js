// Vitest setup — runs before every test file.
// Wires @testing-library/jest-dom matchers (toBeInTheDocument,
// toHaveTextContent, etc.) so component tests can use them.

import '@testing-library/jest-dom/vitest';

// localStorage shim — jsdom doesn't expose window.localStorage in our
// setup, and any module under test that uses it (e.g. offsiteClock's
// snooze store) would blow up with "Cannot read property setItem of
// undefined". A trivial in-memory polyfill covers the API surface we
// actually touch.
if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(String(k), String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}
