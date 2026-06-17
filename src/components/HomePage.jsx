import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { t } from '../data/translations';
import InstallAppButton from './InstallAppButton';

// Rate-limit PIN attempts. Backs off exponentially:
//   after 5 fails → 30s lockout
//   after 10 fails → 5min lockout
//   after 15 fails → 30min lockout
// Stored in localStorage so a refresh doesn't reset the counter.
const ATTEMPTS_KEY = "ddmau:pinAttempts";
const LOCK_UNTIL_KEY = "ddmau:pinLockUntil";

const LOCK_TIERS = [
    { fails: 15, durationMs: 30 * 60 * 1000 },
    { fails: 10, durationMs: 5 * 60 * 1000 },
    { fails: 5,  durationMs: 30 * 1000 },
];

function readAttempts() {
    try { return parseInt(localStorage.getItem(ATTEMPTS_KEY) || "0", 10) || 0; } catch { return 0; }
}
function writeAttempts(n) {
    try {
        if (n <= 0) localStorage.removeItem(ATTEMPTS_KEY);
        else localStorage.setItem(ATTEMPTS_KEY, String(n));
    } catch {}
}
function readLockUntil() {
    try { return parseInt(localStorage.getItem(LOCK_UNTIL_KEY) || "0", 10) || 0; } catch { return 0; }
}
function writeLockUntil(ts) {
    try {
        if (ts <= 0) localStorage.removeItem(LOCK_UNTIL_KEY);
        else localStorage.setItem(LOCK_UNTIL_KEY, String(ts));
    } catch {}
}

// NOTE — the "👋 New hire? Apply here" CTA was removed from this screen on
// 2026-05-11. Reasoning: showing the apply entry point on the staff lock
// screen meant prospective applicants briefly saw the staff portal exists
// before clicking through. Per Andrew's security concern, the two paths
// are now completely separated:
//
//   • Staff URL  → app.ddmaustl.com (PIN screen only — what you see here)
//   • Apply URL  → apply.ddmaustl.com (Squarespace 302 forward to
//     app.ddmaustl.com/?apply=1 — job application form, no staff-portal
//     branding shown)
//
// Admins generate a dedicated "Hiring QR" in the Onboarding tab to share
// the apply URL on flyers, Indeed listings, window decals, etc. The
// onApplyClick prop is intentionally unused — left in the signature so
// older App.jsx paths still mount cleanly during the deploy transition.
export default function HomePage({ onSelectStaff, language, staffList, staffListReady = true, onApplyClick }) {
    const [pin, setPin] = useState("");
    const [error, setError] = useState("");
    const [collisionMatches, setCollisionMatches] = useState([]); // multi-staff PIN collision
    const [lockedUntil, setLockedUntil] = useState(() => readLockUntil());
    const [now, setNow] = useState(() => Date.now());
    // Invite-recovery modal — for new hires who lost the /?onboard=TOKEN
    // link they were originally sent. They type the email they applied
    // with; we write a doc the resendOnboardingInvite Cloud Function
    // (NOT YET BUILT — see blockingForOwner from the audit that shipped
    // this) picks up and uses to email a fresh link. No staff-portal
    // PII is exposed here: the public catch-all already permits
    // /onboarding_invite_recovery_requests writes, and we DO NOT
    // confirm whether the email matched a hire (so a casual attacker
    // can't probe whether an address is on file).
    const [showRecover, setShowRecover] = useState(false);
    const isEs = language === "es";

    // Tick once a second while locked so the countdown updates.
    // MED-1, 2026-05-30: `now` was previously in the dep array, which
    // tore down + recreated the interval EVERY tick. Removing it lets
    // a single interval run for the full lock window. The early-return
    // still self-stops once the lock clears (when the next state change
    // re-evaluates the effect).
    useEffect(() => {
        if (!lockedUntil) return;
        if (lockedUntil <= Date.now()) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [lockedUntil]);

    // Auto-submit when the 4th digit lands. Saves a tap — most staff
    // were typing four digits and then having to scan down to the OK
    // button. We wait one frame after the 4th digit before resolving
    // so the user sees all 4 dots fill in before the screen changes;
    // without the delay the screen flips on the LAST keypress and the
    // user never sees the completed PIN dot row.
    useEffect(() => {
        if (pin.length !== 4) return;
        if (lockedUntil > now) return;
        // Don't auto-submit against the placeholder DEFAULT_STAFF while
        // /config/staff is still loading — every placeholder pin is "" so
        // a real PIN would "fail" and burn a lockout attempt on a slow
        // cold start. handlePinSubmit guards this too; bailing here keeps
        // the 4th-digit auto-fire from looping while we connect.
        if (!staffListReady) return;
        const id = setTimeout(() => { handlePinSubmit(); }, 120);
        return () => clearTimeout(id);
    // handlePinSubmit is stable enough (reads from the current pin state)
    // that we only retrigger on actual pin changes. staffListReady is in
    // the deps so a PIN typed before staff loaded auto-fires once ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pin, staffListReady]);

    const isLocked = lockedUntil > now;
    const lockSecondsLeft = isLocked ? Math.ceil((lockedUntil - now) / 1000) : 0;

    const handlePinSubmit = () => {
        if (isLocked) return;
        // 2026-06-05 — Android login fix (part 2 of 2). The staff list
        // loads from /config/staff via onSnapshot; until it lands,
        // staffList is the DEFAULT_STAFF placeholder where EVERY pin is
        // "". Submitting a real PIN against that set returns zero matches
        // → "Incorrect PIN" AND increments the lockout counter, so a staff
        // member who taps their correct code during the cold-start /
        // slow-network window can get locked out for nothing. (The
        // firebase.js long-polling change shortens that window on the
        // Android WebView; this makes the lock screen honest during it.)
        // Bail with a neutral "Connecting…" note and DO NOT burn an
        // attempt. staffListReady defaults true, so if a caller ever omits
        // the prop we fail open to the old behavior — never wrongly locked.
        if (!staffListReady) {
            setError(isEs ? "Conectando… intenta de nuevo en un momento." : "Connecting… try again in a moment.");
            setPin("");
            return;
        }
        // Find ALL staff with this PIN — guard against silent collisions.
        // 2026-06-16 (#26): normalize the stored PIN (String + trim) so a PIN
        // that drifted to a number or gained whitespace via a migration / manual
        // Firestore edit still matches — otherwise that staffer is silently
        // locked out with no explanation.
        const matches = staffList.filter(s => String(s.pin ?? '').trim() === pin);

        if (matches.length === 0) {
            // Wrong PIN. Increment attempt counter and maybe lock.
            const newAttempts = readAttempts() + 1;
            writeAttempts(newAttempts);
            const tier = LOCK_TIERS.find(t => newAttempts >= t.fails);
            if (tier) {
                const until = Date.now() + tier.durationMs;
                writeLockUntil(until);
                setLockedUntil(until);
                setError(isEs
                    ? `Demasiados intentos. Bloqueado por ${Math.round(tier.durationMs / 60000) || Math.round(tier.durationMs / 1000) + 's'}.`
                    : `Too many attempts. Locked for ${Math.round(tier.durationMs / 60000) || Math.round(tier.durationMs / 1000) + 's'}.`);
            } else {
                const remaining = (LOCK_TIERS[LOCK_TIERS.length - 1].fails) - newAttempts;
                setError(isEs
                    ? `PIN incorrecto. ${remaining} ${remaining === 1 ? 'intento' : 'intentos'} antes del bloqueo.`
                    : `Incorrect PIN. ${remaining} ${remaining === 1 ? 'try' : 'tries'} before lockout.`);
            }
            setPin("");
            return;
        }

        if (matches.length > 1) {
            // PIN collision — make the user pick which person they are.
            // Don't burn an attempt for this; it's a UI step, not a fail.
            setCollisionMatches(matches);
            setError("");
            return;
        }

        // Success: clear attempt counter + lockout, log the user in.
        writeAttempts(0);
        writeLockUntil(0);
        setError("");
        onSelectStaff(matches[0].name);
    };

    const handleCollisionPick = (staff) => {
        writeAttempts(0);
        writeLockUntil(0);
        setError("");
        setCollisionMatches([]);
        // Audit: which person claimed a shared PIN at what time. Helps a
        // manager investigate "who made that schedule edit?" when two staff
        // share a PIN (which they shouldn't, but it happens). Append-only
        // collection — clients can write but can't update or delete.
        try {
            addDoc(collection(db, 'pin_audits'), {
                kind: 'collision_pick',
                pickedStaff: staff.name,
                pickedStaffId: staff.id || null,
                candidateNames: collisionMatches.map(s => s.name),
                at: serverTimestamp(),
            }).catch(() => {});
        } catch {}
        onSelectStaff(staff.name);
    };

    const handleClear = () => {
        setPin("");
        setError("");
    };

    return (
        // 2026-05-27 — lock screen Liquid-Glass refresh.
        // Andrew: "lets make the lock screen with the logo instead of
        // the dd mau. and make the key pad with circle glass buttons."
        // Background switched from mint-50→white to the same soft sage
        // gradient AppShellV2 uses, so the lock screen feels like the
        // entry-point to the same product — not a separate splash.
        // 2026-05-27 Batch G — inline gradient swapped for the shared
        // .ddmau-app-backdrop class so the lock screen matches the rest
        // of the app's backdrop (refined 3-stop gradient + soft radial
        // top-light from Batch A). One source of truth for the canvas.
        <div className="ddmau-app-backdrop flex flex-col items-center justify-center min-h-screen p-4">
            <div className="text-center mb-8">
                {/* DD Mau logo — the actual brand mark (scooter + lotus
                    over the DD MAU wordmark + VIETNAMESE EATERY tagline).
                    Replaces the previous 🍜 emoji + "DD Mau" text. If
                    the asset 404s the alt text reads as a quiet text
                    fallback. */}
                {/* 2026-05-30 perf — explicit width + height + aspectRatio
                    so the browser reserves the logo slot BEFORE the PNG
                    downloads. Without these, the layout below (PIN keypad)
                    jumps on first paint when the image bytes land. The
                    intrinsic 1:1 ratio matches the source asset; h-28
                    (112px) class still rules the final rendered size. */}
                {/* 2026-06-03 — Andrew: "logo needs to be bigger". Bumped
                    from h-28 (112px) → h-44 (176px) for stronger brand
                    presence on the lock screen. Width/height attrs also
                    bumped so layout reservation matches the rendered size
                    (the perf intent of the explicit dims still holds). */}
                <img
                    src={(import.meta.env.BASE_URL || '/') + 'dd-mau-logo.png'}
                    alt="DD Mau Vietnamese Eatery"
                    width="176"
                    height="176"
                    style={{ aspectRatio: '1 / 1' }}
                    className="mx-auto h-44 w-44 object-contain mb-4 select-none pointer-events-none"
                    draggable={false}
                />
                <p className="text-headline text-dd-text-2">{t("staffPortal", language)}</p>
            </div>

            {collisionMatches.length > 1 ? (
                // Collision picker — two or more staff share this PIN. Force the
                // user to pick which person they are. This protects against the
                // silent identity-mixup that the original code had.
                <div className="w-full max-w-sm">
                    <p className="text-center text-amber-700 font-bold text-sm mb-2">
                        ⚠ {isEs ? `Este PIN lo usan ${collisionMatches.length} personas. ¿Cuál eres tú?` : `This PIN is used by ${collisionMatches.length} people. Which one are you?`}
                    </p>
                    <p className="text-center text-xs text-gray-500 mb-3">
                        {isEs ? "Pídele al gerente que cambie tu PIN para que no se repita." : "Ask a manager to change your PIN so it's not shared."}
                    </p>
                    <div className="space-y-2">
                        {collisionMatches.map(s => (
                            <button key={s.id || s.name} onClick={() => handleCollisionPick(s)}
                                className="glass-keypad-button w-full p-3 rounded-glass-md text-left">
                                <div className="font-bold text-dd-text">{s.name}</div>
                                <div className="text-xs text-dd-text-2">{s.role || ''}{s.location ? ` · ${s.location}` : ''}</div>
                            </button>
                        ))}
                    </div>
                    <button onClick={() => { setCollisionMatches([]); setPin(""); }}
                        className="glass-keypad-button-secondary w-full mt-3 py-2 rounded-glass-md text-dd-text-2 font-bold text-sm">
                        {isEs ? "Cancelar" : "Cancel"}
                    </button>
                </div>
            ) : (
                <>
                    <p className="text-callout-md text-dd-text-2 mb-4">{isEs ? "Ingresa tu PIN" : "Enter your PIN"}</p>
                    {/* PIN dot display — filled green when entered, empty
                        glass circle when waiting. Matches the keypad's
                        circular glass aesthetic. */}
                    <div className="flex gap-3 mb-4">
                        {[0,1,2,3].map(i => (
                            <div key={i}
                                className={`w-3.5 h-3.5 rounded-full transition-all duration-200 ease-out ${
                                    pin.length > i
                                        ? 'bg-dd-green shadow-[0_0_0_2px_rgba(31,122,77,0.18)] scale-110'
                                        : 'bg-white/40 ring-1 ring-inset ring-black/10'
                                }`}
                            />
                        ))}
                    </div>
                    {isLocked && (
                        <div className="mb-3 px-3 py-1.5 rounded-full bg-red-100 border border-red-300 text-red-800 text-xs font-bold">
                            {isEs ? `Bloqueado ${lockSecondsLeft}s` : `Locked ${lockSecondsLeft}s`}
                        </div>
                    )}
                    {/* Connecting indicator — staff list still loading from
                        Firestore. Shown instead of letting a tapped PIN
                        fail/lock during the cold-start window (see the
                        guard in handlePinSubmit). Auto-clears the instant
                        staff load. */}
                    {!staffListReady && !isLocked && (
                        <div className="mb-3 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-xs font-bold inline-flex items-center gap-1.5">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            {isEs ? "Conectando…" : "Connecting…"}
                        </div>
                    )}
                    {error && !isLocked && <p className="text-red-500 text-xs mb-2">{error}</p>}
                    {/* Apple-Liquid-Glass keypad. Each disc uses
                        .glass-keypad-button (frosted white) /
                        -secondary (Clear, quieter) / -primary (OK,
                        brand green) so the lock screen reads as the
                        same glass family as the rest of the app's
                        chrome. 64×64 hits both Apple HIG (44pt) and
                        Material (48dp) touch targets with room.
                        Andrew 2026-05-28 — "make the buttons more
                        glass like like the apple glass." */}
                    <div className="grid grid-cols-3 gap-4 mt-2">
                        {/* 2026-06-14 — Andrew: "when we type our pin it lags
                            the first button so we miss type." Two fixes:
                            (1) enter the digit on onPointerDown (fires the
                            instant the finger lands, before the click that
                            fires on RELEASE) so a busy main thread during cold
                            start can't swallow/delay the first tap; (2) use the
                            functional state updater (p => ...) so two fast taps
                            can't both read a stale `pin` and drop a digit.
                            onClick is removed on the digits to avoid a
                            double-entry from the synthesized click. */}
                        {[1,2,3,4,5,6,7,8,9].map(n => (
                            <button key={n} onPointerDown={() => { if (isLocked) return; setError(""); setPin(p => p.length < 4 ? p + n : p); }}
                                disabled={isLocked}
                                className={`glass-keypad-button w-16 h-16 rounded-full text-2xl font-semibold text-dd-text ${isLocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
                                {n}
                            </button>
                        ))}
                        <button onClick={handleClear} disabled={isLocked}
                            className={`glass-keypad-button-secondary w-16 h-16 rounded-full text-xs font-bold uppercase tracking-wider text-dd-text-2 ${isLocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            {isEs ? "Borrar" : "Clear"}
                        </button>
                        <button onPointerDown={() => { if (isLocked) return; setError(""); setPin(p => p.length < 4 ? p + "0" : p); }}
                            disabled={isLocked}
                            className={`glass-keypad-button w-16 h-16 rounded-full text-2xl font-semibold text-dd-text ${isLocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            0
                        </button>
                        {/* OK — brand-green Apple-glass disc once a
                            4-digit PIN is in. Pre-fill state stays the
                            neutral secondary glass so the layout
                            doesn't jump. */}
                        <button onClick={handlePinSubmit}
                            disabled={isLocked || pin.length !== 4}
                            className={`w-16 h-16 rounded-full text-sm font-bold ${
                                pin.length === 4 && !isLocked
                                    ? 'glass-keypad-button-primary'
                                    : 'glass-keypad-button-secondary text-dd-text-2/50 cursor-not-allowed'
                            }`}>
                            OK
                        </button>
                    </div>
                </>
            )}
            {/* Invite-recovery — quiet, low-emphasis text link under the
                keypad. New hires who closed their onboarding email or lost
                the SMS would otherwise have no self-serve path; today they
                have to text the manager and wait for a manual resend.
                Hidden when the collision picker is up — same reason the
                bottom chrome already hides extra controls there. */}
            {collisionMatches.length <= 1 && (
                <button
                    type="button"
                    onClick={() => setShowRecover(true)}
                    className="mt-4 text-[11px] text-dd-text-2 underline underline-offset-2 hover:text-dd-text active:scale-95">
                    {isEs
                        ? "¿Perdiste tu enlace de onboarding? Tócame para reenviar"
                        : "Lost your onboarding link? Tap to resend"}
                </button>
            )}
            <div className="mt-6">
                <InstallAppButton language={language} compact />
            </div>
            {showRecover && (
                <RecoverInviteModal language={language} onClose={() => setShowRecover(false)} />
            )}
        </div>
    );
}

// ── RecoverInviteModal ──────────────────────────────────────────────────────
// Hire-side invite-recovery flow. Hire types the email address they used
// on their application; we drop a doc into
// /onboarding_invite_recovery_requests/{auto}. The resendOnboardingInvite
// Cloud Function (NOT YET DEPLOYED — see blockingForOwner from this
// audit) listens onCreate, looks up the matching hire by email, mints a
// fresh /onboarding_invites/{token} (or reuses an unexpired one), and
// emails the new link to the address on file. The function must NOT
// echo back whether the email matched — we always show the same
// "request received" UI so the lock screen can't be used as an email-
// enumeration oracle.
//
// Client-side cooldown (60s, same pattern as OnboardingApply) keeps a
// casual attacker from spamming the queue. The localStorage key is
// distinct from the apply form's so the two flows don't trample each
// other.
function RecoverInviteModal({ language, onClose }) {
    const isEs = language === "es";
    const tx = (en, es) => (isEs ? es : en);
    const COOLDOWN_KEY = "ddmau:recoverInviteLastSubmit";
    const COOLDOWN_MS = 60 * 1000;
    const [email, setEmail] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [done, setDone] = useState(false);
    const [err, setErr] = useState("");

    // Same email regex as src/data/applyForm.js#isValidEmail. Duplicated
    // locally to keep the lock screen bundle from pulling in the apply-
    // form module (which drags in storage SDKs).
    const isValidEmail = (raw) => {
        if (!raw) return false;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw).trim());
    };

    const submit = async () => {
        if (submitting) return;
        const normalized = email.trim().toLowerCase();
        if (!isValidEmail(normalized)) {
            setErr(tx("Enter a valid email.", "Escribe un correo válido."));
            return;
        }
        // Cooldown — one recovery request per minute per device. Same
        // pattern as OnboardingApply.jsx so a panicked hire mashing the
        // button doesn't fan out into N duplicate Cloud Function runs.
        try {
            const last = parseInt(localStorage.getItem(COOLDOWN_KEY) || "0", 10) || 0;
            if (Date.now() - last < COOLDOWN_MS) {
                setErr(tx(
                    "You just sent one — wait a moment before sending another.",
                    "Acabas de enviar una — espera un momento antes de enviar otra.",
                ));
                return;
            }
        } catch {}
        setSubmitting(true);
        setErr("");
        try {
            await addDoc(collection(db, "onboarding_invite_recovery_requests"), {
                email: normalized,
                status: "pending",
                requestedAt: serverTimestamp(),
                // Lightweight audit trail — same shape as the apply form's
                // ipHash / userAgent so admin can correlate a request with
                // an existing application in the rare case of abuse.
                userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
                source: "lock_screen",
                language: isEs ? "es" : "en",
            });
            try { localStorage.setItem(COOLDOWN_KEY, String(Date.now())); } catch {}
            setDone(true);
        } catch (e) {
            console.error("recovery request failed", e);
            setErr(tx("Could not send. Try again.", "No se pudo enviar. Intenta de nuevo."));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm bg-white rounded-2xl border border-gray-200 shadow-xl p-5 space-y-3">
                {done ? (
                    <>
                        <p className="text-4xl text-center">📬</p>
                        <h2 className="text-lg font-black text-dd-green-700 text-center">
                            {tx("Request received", "Solicitud recibida")}
                        </h2>
                        <p className="text-xs text-gray-600 text-center leading-snug">
                            {tx(
                                "If that email matches one of our new hires, we'll send a fresh onboarding link there shortly. Check your inbox (and spam folder) in the next few minutes.",
                                "Si ese correo coincide con un nuevo empleado, enviaremos un enlace nuevo a esa dirección pronto. Revisa tu bandeja de entrada (y spam) en los próximos minutos.",
                            )}
                        </p>
                        <button
                            type="button"
                            onClick={onClose}
                            className="w-full py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm active:scale-95">
                            {tx("Close", "Cerrar")}
                        </button>
                    </>
                ) : (
                    <>
                        <h2 className="text-lg font-black text-gray-900 text-center">
                            {tx("Resend onboarding link", "Reenviar enlace de onboarding")}
                        </h2>
                        <p className="text-xs text-gray-600 text-center leading-snug">
                            {tx(
                                "Type the email you used on your job application. We'll email a fresh onboarding link to that address.",
                                "Escribe el correo que usaste en tu solicitud. Enviaremos un enlace nuevo a esa dirección.",
                            )}
                        </p>
                        {/* text-base (16px) prevents iOS Safari zoom-on-focus —
                            same convention as OnboardingApply.jsx#TextInput. */}
                        <input
                            type="email"
                            inputMode="email"
                            autoComplete="email"
                            value={email}
                            onChange={(e) => { setEmail(e.target.value); if (err) setErr(""); }}
                            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                            placeholder={tx("you@example.com", "tu@ejemplo.com")}
                            disabled={submitting}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base focus:border-dd-green focus:outline-none focus:ring-2 focus:ring-dd-green/30 disabled:opacity-60" />
                        {err && (
                            <p className="text-[11px] text-red-600 text-center">{err}</p>
                        )}
                        <div className="flex gap-2 pt-1">
                            <button
                                type="button"
                                onClick={onClose}
                                disabled={submitting}
                                className="flex-1 py-2.5 rounded-xl bg-white border-2 border-gray-300 text-gray-700 font-bold text-sm active:scale-95 disabled:opacity-60">
                                {tx("Cancel", "Cancelar")}
                            </button>
                            <button
                                type="button"
                                onClick={submit}
                                disabled={submitting}
                                className="flex-[2] py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm shadow-md active:scale-95 disabled:opacity-60">
                                {submitting
                                    ? tx("Sending…", "Enviando…")
                                    : tx("Send link", "Enviar enlace")}
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-400 text-center leading-snug">
                            {tx(
                                "For privacy we don't confirm whether an email is on file. If yours is, the link will arrive.",
                                "Por privacidad no confirmamos si un correo está registrado. Si lo está, el enlace llegará.",
                            )}
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
