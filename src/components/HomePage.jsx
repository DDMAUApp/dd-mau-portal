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
export default function HomePage({ onSelectStaff, language, staffList, onApplyClick }) {
    const [pin, setPin] = useState("");
    const [error, setError] = useState("");
    const [collisionMatches, setCollisionMatches] = useState([]); // multi-staff PIN collision
    const [lockedUntil, setLockedUntil] = useState(() => readLockUntil());
    const [now, setNow] = useState(() => Date.now());
    const isEs = language === "es";

    // Tick once a second while locked so the countdown updates.
    useEffect(() => {
        if (!lockedUntil || lockedUntil <= now) return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [lockedUntil, now]);

    // Auto-submit when the 4th digit lands. Saves a tap — most staff
    // were typing four digits and then having to scan down to the OK
    // button. We wait one frame after the 4th digit before resolving
    // so the user sees all 4 dots fill in before the screen changes;
    // without the delay the screen flips on the LAST keypress and the
    // user never sees the completed PIN dot row.
    useEffect(() => {
        if (pin.length !== 4) return;
        if (lockedUntil > now) return;
        const id = setTimeout(() => { handlePinSubmit(); }, 120);
        return () => clearTimeout(id);
    // handlePinSubmit is stable enough (reads from the current pin state)
    // that we only retrigger on actual pin changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pin]);

    const isLocked = lockedUntil > now;
    const lockSecondsLeft = isLocked ? Math.ceil((lockedUntil - now) / 1000) : 0;

    const handlePinSubmit = () => {
        if (isLocked) return;
        // Find ALL staff with this PIN — guard against silent collisions.
        const matches = staffList.filter(s => s.pin === pin);

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
                <img
                    src={(import.meta.env.BASE_URL || '/') + 'dd-mau-logo.png'}
                    alt="DD Mau Vietnamese Eatery"
                    className="mx-auto h-28 w-auto object-contain mb-3 select-none pointer-events-none"
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
                        {[1,2,3,4,5,6,7,8,9].map(n => (
                            <button key={n} onClick={() => { setError(""); if (!isLocked && pin.length < 4) setPin(pin + n); }}
                                disabled={isLocked}
                                className={`glass-keypad-button w-16 h-16 rounded-full text-2xl font-semibold text-dd-text ${isLocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
                                {n}
                            </button>
                        ))}
                        <button onClick={handleClear} disabled={isLocked}
                            className={`glass-keypad-button-secondary w-16 h-16 rounded-full text-xs font-bold uppercase tracking-wider text-dd-text-2 ${isLocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            {isEs ? "Borrar" : "Clear"}
                        </button>
                        <button onClick={() => { setError(""); if (!isLocked && pin.length < 4) setPin(pin + "0"); }}
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
            <div className="mt-6">
                <InstallAppButton language={language} compact />
            </div>
        </div>
    );
}
