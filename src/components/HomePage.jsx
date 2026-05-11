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
        <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-mint-50 to-white p-4">
            <div className="text-center mb-8">
                <h1 className="text-5xl font-bold mb-2">🍜</h1>
                <h1 className="text-4xl font-bold text-mint-700 mb-2">DD Mau</h1>
                <p className="text-gray-600 text-lg">{t("staffPortal", language)}</p>
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
                                className="w-full p-3 rounded-lg border-2 border-mint-200 bg-white text-left hover:border-mint-500 transition">
                                <div className="font-bold text-gray-800">{s.name}</div>
                                <div className="text-xs text-gray-500">{s.role || ''}{s.location ? ` · ${s.location}` : ''}</div>
                            </button>
                        ))}
                    </div>
                    <button onClick={() => { setCollisionMatches([]); setPin(""); }}
                        className="w-full mt-3 py-2 rounded-lg bg-gray-200 text-gray-700 font-bold text-sm">
                        {isEs ? "Cancelar" : "Cancel"}
                    </button>
                </div>
            ) : (
                <>
                    <p className="text-gray-500 text-sm mb-4">{isEs ? "Ingresa tu PIN" : "Enter your PIN"}</p>
                    <div className="flex gap-2 mb-3">
                        {[0,1,2,3].map(i => (
                            <div key={i} className={"w-12 h-14 rounded-lg border-2 flex items-center justify-center text-2xl font-bold " +
                                (pin.length > i ? "border-mint-400 bg-mint-50 text-mint-700" : "border-gray-200 bg-white text-gray-300")}>
                                {pin.length > i ? "●" : ""}
                            </div>
                        ))}
                    </div>
                    {isLocked && (
                        <div className="mb-2 px-3 py-1.5 rounded-full bg-red-100 border border-red-300 text-red-800 text-xs font-bold">
                            🔒 {isEs ? `Bloqueado ${lockSecondsLeft}s` : `Locked ${lockSecondsLeft}s`}
                        </div>
                    )}
                    {error && !isLocked && <p className="text-red-500 text-xs mb-2">{error}</p>}
                    <div className="grid grid-cols-3 gap-2 w-60 mt-2">
                        {[1,2,3,4,5,6,7,8,9].map(n => (
                            <button key={n} onClick={() => { setError(""); if (!isLocked && pin.length < 4) setPin(pin + n); }}
                                disabled={isLocked}
                                className={`h-14 rounded-lg bg-white border border-gray-200 text-xl font-semibold text-gray-700 hover:bg-mint-50 hover:border-mint-200 active:bg-mint-100 transition ${isLocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
                                {n}
                            </button>
                        ))}
                        <button onClick={handleClear} disabled={isLocked}
                            className={`h-14 rounded-lg bg-gray-100 border border-gray-200 text-sm font-medium text-gray-500 hover:bg-gray-200 transition ${isLocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            {isEs ? "Borrar" : "Clear"}
                        </button>
                        <button onClick={() => { setError(""); if (!isLocked && pin.length < 4) setPin(pin + "0"); }}
                            disabled={isLocked}
                            className={`h-14 rounded-lg bg-white border border-gray-200 text-xl font-semibold text-gray-700 hover:bg-mint-50 hover:border-mint-200 active:bg-mint-100 transition ${isLocked ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            0
                        </button>
                        <button onClick={handlePinSubmit}
                            disabled={isLocked || pin.length !== 4}
                            className={"h-14 rounded-lg text-sm font-bold transition " +
                                (pin.length === 4 && !isLocked ? "bg-mint-700 text-white hover:bg-mint-700" : "bg-gray-100 text-gray-400 border border-gray-200")}>
                            OK
                        </button>
                    </div>
                </>
            )}
            <InstallAppButton language={language} />
            {/* New-hire entry point. Same vocabulary as the typical "Register"
                button on a sign-in screen, but for prospective hires:
                fills the public application form, sends a push to Julie +
                Andrew, and shows up in the admin Onboarding tab. */}
            {onApplyClick && (
                <button onClick={onApplyClick}
                    className="mt-6 text-xs text-gray-500 hover:text-mint-700 underline-offset-2 hover:underline transition">
                    👋 {isEs ? '¿Buscando trabajo? Aplica aquí' : 'New hire? Apply here'}
                </button>
            )}
        </div>
    );
}
