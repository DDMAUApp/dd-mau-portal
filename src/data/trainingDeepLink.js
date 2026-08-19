// Module-level deep links into the Training Hub (2026-08-18, training
// assignments). A chat card / push carries deepLink 'training:m18';
// App.jsx splits it here (same shape as chatDeepLink.js), parks the
// module id, and dispatches the plain 'training' tab. TrainingHub consumes
// the park on mount, or live via the 'ddmau:open-training' event.
//
// Why a module-level store: the tap can land before TrainingHub is
// mounted (cold launch, PIN lock, another tab). 10-minute expiry so a
// stale park doesn't yank someone into a module an hour later.

const EXPIRY_MS = 10 * 60 * 1000;
let _pending = null; // { moduleId, at }

// 'training:m18' → { tab:'training', moduleId:'m18' }; anything else passes
// through with moduleId null. Pure — unit-tested.
export function parseTrainingDeepLink(raw) {
    const s = String(raw || '');
    if (s.startsWith('training:')) {
        const moduleId = s.slice(9).trim();
        return { tab: 'training', moduleId: moduleId || null };
    }
    return { tab: s, moduleId: null };
}

export function setPendingTrainingOpen(moduleId) {
    if (!moduleId) return;
    _pending = { moduleId: String(moduleId), at: Date.now() };
    try {
        window.dispatchEvent(new CustomEvent('ddmau:open-training', { detail: { moduleId: String(moduleId) } }));
    } catch { /* SSR/test env — park only */ }
}

// One-shot read; clears the park.
export function consumePendingTrainingOpen() {
    const p = _pending;
    _pending = null;
    if (!p) return null;
    if (Date.now() - p.at > EXPIRY_MS) return null;
    return p.moduleId;
}

// Convenience for buttons: park the module + navigate to the Training tab
// through the same window event every other deep link uses.
export function openTrainingModule(moduleId) {
    setPendingTrainingOpen(moduleId);
    try { window.dispatchEvent(new CustomEvent('ddmau:navigate', { detail: { tab: 'training' } })); } catch { /* noop */ }
}
