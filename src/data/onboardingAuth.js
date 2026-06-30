// onboardingAuth.js — password gate for the new-hire onboarding portal.
//
// The invite link alone used to be the only thing standing between a stranger
// and someone's tax forms: anyone the link was forwarded to could open the
// portal and fill out / submit documents as that hire. This adds a password the
// hire sets on their FIRST visit; every later visit requires it. A forwarded or
// leaked link now hits a password prompt instead of the form.
//
// Scope note: this gates the portal UI (the practical fix for shared links).
// The deeper at-rest data lockdown (so the raw files/records can't be pulled
// straight from the API) is the separate server-side auth work — this is the
// first real layer and a building block toward it. The password is stored only
// as a salted SHA-256 hash, never in plaintext.

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomSalt() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Build the stored credential from a plaintext password. Returns the object to
// save on the hire doc as `portalAuth` — { salt, hash, setAt }. No plaintext.
export async function hashPortalPassword(password) {
    const salt = randomSalt();
    const hash = await sha256Hex(salt + ':' + String(password));
    return { salt, hash, setAt: new Date().toISOString() };
}

// Verify a typed password against the stored { salt, hash }.
export async function verifyPortalPassword(password, auth) {
    if (!auth || !auth.salt || !auth.hash) return false;
    try {
        const hash = await sha256Hex(auth.salt + ':' + String(password));
        return hash === auth.hash;
    } catch {
        return false;
    }
}

// Session-scoped unlock flag so a same-session reload doesn't re-prompt.
export const portalUnlockKey = (hireId) => 'dd:onb:unlocked:' + hireId;
