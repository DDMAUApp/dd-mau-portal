// biometrics.js — Face ID / Touch ID / Android fingerprint as a FASTER way to
// log in, layered on top of the existing 4-digit PIN. Andrew 2026-06-29:
// "biometric as a secondary login to make login faster… it tries that first and
// if that fails it's no problem because you still have the regular PIN login."
//
// SCOPE (deliberately small): this is a CONVENIENCE shortcut, not real auth.
// It stores the staff member's PIN in the OS secure store (iOS Keychain /
// Android Keystore) behind a biometric gate, so a returning user on THEIR
// device can unlock with their face/finger instead of typing the PIN. The PIN
// keypad always remains the fallback. Real server-enforced auth comes with the
// multi-tenant build (see BIOMETRIC-PLAN.md) — this does not replace it.
//
// SAFETY: every call is guarded by `Capacitor.isPluginAvailable('NativeBiometric')`
// and the plugin is DYNAMICALLY imported only when present. On the current App
// Store / Play binary (which does NOT yet contain the native plugin) every
// function short-circuits to "unavailable" → the app behaves exactly as today
// (PIN only). The biometric paths light up only after the new native build ships.
//
// Shared store iPad: it has no enrolled fingerprint/face, so isAvailable() is
// false → the enable prompt never appears and login stays PIN-only there
// automatically. No special handling needed.

import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const SERVER = 'app.ddmau.staff';          // Keychain/Keystore "server" key
const ENABLED_KEY = 'bio:enabledFor';      // staffName this device is enrolled for
const DECLINED_KEY = 'bio:declined';       // user said "not now" — don't nag

// Once ANY biometric call reports the native plugin isn't in this binary, go
// permanently inert for the session. NOTE: Capacitor.isPluginAvailable() returns
// TRUE for a registerPlugin()-style plugin (like NativeBiometric) even when the
// NATIVE side isn't compiled into the current store binary — the JS proxy is
// registered regardless. So the availability check alone would keep letting us
// call the plugin, which throws "NativeBiometric.<m>() is not implemented" every
// time. `_dead` latches after the first such failure so we stop calling it (and
// stop spamming the error log). Cleared naturally on the next app launch that
// actually contains the plugin. Andrew 2026-06-30.
let _dead = false;
function noteFailure(e) {
    const m = (e && (e.message || String(e))) || '';
    if (/not implemented|unimplemented|not available on this|no such plugin/i.test(m)) {
        _dead = true;
    }
}

// True only on a native build that actually contains the plugin. False on web,
// on the current store binary (no native plugin), and after `_dead` latches →
// all biometric features are inert.
function pluginReady() {
    if (_dead) return false;
    try {
        return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('NativeBiometric');
    } catch {
        return false;
    }
}

// Dynamic import so the plugin's JS is never even loaded on binaries without it.
// IMPORTANT: return the MODULE, not `mod.NativeBiometric` directly. An async
// function that resolves to a Capacitor plugin proxy makes the promise machinery
// try to adopt the proxy as a thenable and call `.then()` on it — which the
// native layer reports as "NativeBiometric.then() is not implemented on android"
// and silently breaks biometric login. Destructure NativeBiometric at the call
// site (a plain method call on the proxy is fine; awaiting the proxy itself is not).
async function getPlugin() {
    return await import('@capgo/capacitor-native-biometric');
}

function typeLabel(biometryType) {
    // native-biometric BiometryType: 1=TouchID 2=FaceID 3=Fingerprint
    // 4=FaceAuth 5=Iris 6=Multiple
    switch (biometryType) {
        case 1: return 'Touch ID';
        case 2: return 'Face ID';
        case 3: return 'Fingerprint';
        case 4: return 'Face Unlock';
        case 5: return 'Iris';
        default: return 'Biometrics';
    }
}

// Is biometric hardware present + enrolled on this device? Returns
// { available, type } — `type` is a friendly label for the prompt copy.
export async function isBiometricAvailable() {
    if (!pluginReady()) return { available: false, type: 'Biometrics' };
    try {
        const { NativeBiometric } = await getPlugin();
        const res = await NativeBiometric.isAvailable({ useFallback: false });
        return { available: !!res?.isAvailable, type: typeLabel(res?.biometryType) };
    } catch (e) {
        noteFailure(e); // latch inert if the native plugin isn't in this binary
        console.warn('biometrics isAvailable failed:', e?.message || e);
        return { available: false, type: 'Biometrics' };
    }
}

// Which staff (if any) this device's biometric is enrolled for.
export async function getEnrolledStaff() {
    try {
        const { value } = await Preferences.get({ key: ENABLED_KEY });
        return value || null;
    } catch { return null; }
}

export async function wasBiometricDeclined() {
    try {
        const { value } = await Preferences.get({ key: DECLINED_KEY });
        return value === '1';
    } catch { return false; }
}
export async function markBiometricDeclined() {
    try { await Preferences.set({ key: DECLINED_KEY, value: '1' }); } catch { /* ignore */ }
}

// Enroll: confirm a live biometric, then stash the PIN in the secure store and
// record which staff this device unlocks. Returns true on success.
export async function enableBiometric({ staffName, pin }) {
    if (!pluginReady() || !staffName || !pin) return false;
    try {
        const { NativeBiometric } = await getPlugin();
        const avail = await NativeBiometric.isAvailable({ useFallback: false });
        if (!avail?.isAvailable) return false;
        // Prove a live face/finger before we store anything.
        await NativeBiometric.verifyIdentity({
            reason: 'Set up faster sign-in',
            title: 'Enable biometric sign-in',
            useFallback: false,
        });
        await NativeBiometric.setCredentials({ username: String(staffName), password: String(pin), server: SERVER });
        await Preferences.set({ key: ENABLED_KEY, value: String(staffName) });
        await Preferences.remove({ key: DECLINED_KEY });
        return true;
    } catch (e) {
        noteFailure(e); // latch inert if the native plugin isn't in this binary
        console.warn('enableBiometric failed/cancelled:', e?.message || e);
        return false;
    }
}

// Try a biometric unlock. Returns { staffName, pin } on success, or null on
// unavailable / not-enrolled / fail / cancel. Caller treats null as "fall back
// to the PIN keypad" — never an error.
export async function tryBiometricLogin() {
    if (!pluginReady()) return null;
    const enrolled = await getEnrolledStaff();
    if (!enrolled) return null;
    try {
        const { NativeBiometric } = await getPlugin();
        const avail = await NativeBiometric.isAvailable({ useFallback: false });
        if (!avail?.isAvailable) return null;
        await NativeBiometric.verifyIdentity({
            reason: 'Sign in to DD Mau',
            title: `Sign in as ${enrolled}`,
            useFallback: false,
        });
        const creds = await NativeBiometric.getCredentials({ server: SERVER });
        if (!creds?.username) return null;
        return { staffName: creds.username, pin: creds.password };
    } catch (e) {
        // Cancel / no-match / lockout all land here → silent fallback to PIN.
        noteFailure(e); // latch inert if the native plugin isn't in this binary
        console.warn('biometric login fell back to PIN:', e?.message || e);
        return null;
    }
}

// Turn it off + wipe the stored PIN (e.g. staff taps "forget Face ID", or the
// stored PIN no longer matches after an admin PIN change).
export async function disableBiometric() {
    try {
        if (pluginReady()) {
            const { NativeBiometric } = await getPlugin();
            await NativeBiometric.deleteCredentials({ server: SERVER }).catch(() => {});
        }
        await Preferences.remove({ key: ENABLED_KEY });
        await Preferences.remove({ key: DECLINED_KEY });
    } catch (e) {
        console.warn('disableBiometric failed:', e?.message || e);
    }
}

// ── Old-native-build detection (2026-07-08) ────────────────────────
// Andrew: "some staff dont have the face id prompt" — those phones
// run a native binary older than the biometric build (iOS 1.0.3+).
// OTA can only ship JS, never native plugins, so the fix is a store
// update — the lock screen shows a banner that deep-links there.
// Detection: the plugin simply isn't compiled into the binary.
// Web is never "outdated" (biometrics don't apply there).
const IOS_APP_URL = 'https://apps.apple.com/us/app/dd-mau-staff/id6776881912';
// Play store listing (closed testing, Forsis LLC org — 2026-07-23). Correct
// for the update deep-link: anyone with the app installed is already a tester.
const ANDROID_APP_URL = 'https://play.google.com/store/apps/details?id=com.ddmau.staff';

export function isNativeBuildOutdated() {
    try {
        return Capacitor.isNativePlatform() && !Capacitor.isPluginAvailable('NativeBiometric');
    } catch {
        return false;
    }
}

export function nativeUpdateUrl() {
    try {
        return Capacitor.getPlatform() === 'android' ? ANDROID_APP_URL : IOS_APP_URL;
    } catch {
        return IOS_APP_URL;
    }
}
