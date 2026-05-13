// Kitchen-bell "ding" for foreground notification pings.
//
// Why synthesized instead of a packaged WAV/MP3:
//   - No HTTP fetch / cache-warm requirement — works on the very first
//     notification of a session.
//   - No copyright concerns over a recorded sample.
//   - One file, zero asset pipeline changes.
//
// Why ONLY foreground: service workers can't play audio. When the app
// is closed and FCM hands the push to firebase-messaging-sw.js, the OS
// uses ITS default notification sound. There's no API for the SW to
// play a custom file. So this helper is the foreground-only ring;
// closed-app sound is whatever the OS is configured to play.
//
// Synthesis: two short sine partials (E6 + B6) with a sharp attack
// (5ms) and exponential decay (~700ms) — sounds like a counter / service
// bell ding. Slight detune on the upper partial gives it a metallic
// shimmer instead of feeling synthetic.

let _ctx = null;

function getCtx() {
    if (_ctx) return _ctx;
    const Ctor = typeof window !== 'undefined'
        ? (window.AudioContext || window.webkitAudioContext)
        : null;
    if (!Ctor) return null;
    try { _ctx = new Ctor(); } catch { return null; }
    return _ctx;
}

// Resume a suspended AudioContext on the next user gesture. Browsers
// require a gesture to unlock audio; by the time push notifications
// fire the user has typed a PIN, tapped buttons, etc., so the context
// is almost always live. But on a fresh tab open + first push, the
// context may still be 'suspended' — calling play() then is a noop
// (silent). The handler below resumes on any pointer/keyboard event,
// once, and never adds bandwidth-relevant overhead.
let _unlocked = false;
function ensureUnlocked() {
    if (_unlocked) return;
    if (typeof window === 'undefined') return;
    const unlock = () => {
        const ctx = getCtx();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        _unlocked = true;
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true, passive: true });
}
if (typeof window !== 'undefined') ensureUnlocked();

export function playKitchenBell() {
    try {
        const ctx = getCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        const now = ctx.currentTime;

        const master = ctx.createGain();
        master.gain.value = 0.35;
        master.connect(ctx.destination);

        const partial = (freq, peak, decayS) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(peak, now + 0.005);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + decayS);
            osc.connect(gain).connect(master);
            osc.start(now);
            osc.stop(now + decayS + 0.05);
        };

        partial(1318.5, 1.0, 0.75);
        partial(1980.0, 0.55, 0.45);
        partial(2640.0, 0.25, 0.30);
    } catch {
    }
}
