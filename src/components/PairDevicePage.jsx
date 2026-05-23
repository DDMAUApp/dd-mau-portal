// PairDevicePage — full-screen Pi-side pairing entry.
//
// Andrew 2026-05-23. Reached by opening app.ddmaustl.com/?pair=1
// on the kiosk browser. Replaces the previous "admin walks the
// URL to the Pi" setup ritual:
//
//   1. Admin clicks "Pair Device" in Menu Screens → modal shows
//      a 6-digit code.
//   2. Admin calls out the code to whoever's at the Pi.
//   3. Pi types the code into THIS page and submits.
//   4. We claim the code (atomic transaction in devicePairing.js),
//      record the deviceId so a refresh recovers cleanly, then
//      poll the code doc for an assignedTvId.
//   5. Once admin assigns a TV, the doc gets `assignedTvId` set;
//      we navigate to /?tv=<tvId> and the Pi starts showing the
//      menu. Pairing complete.
//
// Auto-bypass: if this Pi has previously paired (we kept the last
// assigned tvId in localStorage), we offer a one-tap "Continue as
// last menu" button so a power-cycle doesn't force the admin to
// re-pair from scratch. Manual fresh-pair stays one click away.
//
// PIN is bypassed for this route in App.jsx, same as ?tv= and
// ?apply=, because the customer-facing kiosk has no business
// showing the staff PIN screen.

import { useEffect, useRef, useState } from 'react';
import {
    getOrCreateDeviceId, normalizePairingCode, formatPairingCode,
    claimPairingCode, subscribePairingCode,
} from '../data/devicePairing';

const LAST_PAIRED_KEY = 'ddmau:lastPairedTvId';

export default function PairDevicePage() {
    const [code, setCode]   = useState('');
    const [status, setStatus] = useState('idle');
    // 'idle'        — waiting for input
    // 'claiming'    — call to claimPairingCode in flight
    // 'claimed'     — claim succeeded; waiting for admin to assign
    // 'assigned'    — admin assigned a tvId; redirecting
    // 'error'       — claim failed; reason in errorMsg
    const [errorMsg, setErrorMsg] = useState(null);
    const [claimedCode, setClaimedCode] = useState(null);

    // Stable device identity persisted to localStorage. We pass it
    // to claimPairingCode so a Pi can refresh mid-flow and still
    // be recognized as the same claimant (the transaction allows
    // self re-claim).
    const deviceIdRef = useRef(getOrCreateDeviceId());

    // Last paired tvId — if this Pi has paired before, we offer
    // to skip the code entry. Useful after a reboot.
    const lastPaired = (() => {
        try { return localStorage.getItem(LAST_PAIRED_KEY); }
        catch { return null; }
    })();

    // Poll the claimed code doc for an assignedTvId. As soon as
    // admin picks the TV, we redirect.
    useEffect(() => {
        if (!claimedCode) return;
        const unsub = subscribePairingCode(claimedCode, (data) => {
            if (data?.assignedTvId) {
                setStatus('assigned');
                try { localStorage.setItem(LAST_PAIRED_KEY, data.assignedTvId); } catch {}
                // Tiny delay so the user sees the "Paired!" state
                // before we navigate away. 800ms is enough to read
                // the new TV id without being annoyingly slow.
                setTimeout(() => {
                    try {
                        const u = new URL(window.location.href);
                        u.searchParams.delete('pair');
                        u.searchParams.set('tv', data.assignedTvId);
                        window.location.replace(u.toString());
                    } catch {
                        window.location.href = `?tv=${encodeURIComponent(data.assignedTvId)}`;
                    }
                }, 800);
            }
        });
        return unsub;
    }, [claimedCode]);

    async function handleSubmit() {
        const canonical = normalizePairingCode(code);
        if (canonical.length !== 6) {
            setErrorMsg('Code must be 6 digits.');
            return;
        }
        setStatus('claiming');
        setErrorMsg(null);
        try {
            await claimPairingCode({
                code: canonical,
                deviceId: deviceIdRef.current,
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
            });
            setClaimedCode(canonical);
            setStatus('claimed');
        } catch (e) {
            setStatus('error');
            const msg = e?.code === 'NOT_FOUND'      ? "Code not found. Check that the admin's modal is still showing."
                      : e?.code === 'EXPIRED'        ? "Code expired. Ask the admin to generate a new one."
                      : e?.code === 'ALREADY_CLAIMED'? "Code was already used by a different device."
                      :                                 'Could not claim that code. Try again.';
            setErrorMsg(msg);
        }
    }

    function handleContinueAsLast() {
        if (!lastPaired) return;
        try {
            const u = new URL(window.location.href);
            u.searchParams.delete('pair');
            u.searchParams.set('tv', lastPaired);
            window.location.replace(u.toString());
        } catch {
            window.location.href = `?tv=${encodeURIComponent(lastPaired)}`;
        }
    }

    return (
        <div className="fixed inset-0 bg-dd-charcoal text-white flex flex-col items-center justify-center px-6 py-10">
            {/* DD Mau header — large, brand-recognizable from across
                the kitchen / lobby. */}
            <div className="text-6xl font-black tracking-tight mb-1">DD MAU</div>
            <div className="text-lg font-bold opacity-70 mb-8">TV pairing</div>

            {status === 'idle' || status === 'claiming' || status === 'error' ? (
                <>
                    <p className="text-base text-white/80 max-w-sm text-center mb-6 leading-relaxed">
                        Ask an admin to open the <span className="font-bold">Pair Device</span>{' '}
                        modal in the Menu Screens dashboard, then type the 6-digit code
                        they read out to you.
                    </p>

                    <div className="bg-white text-dd-text rounded-2xl px-5 py-5 w-full max-w-sm shadow-xl">
                        <label className="block text-[11px] font-black uppercase tracking-widest text-dd-text-2 mb-2">
                            Pairing code
                        </label>
                        <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={formatPairingCode(normalizePairingCode(code))}
                            onChange={(e) => setCode(normalizePairingCode(e.target.value))}
                            placeholder="000-000"
                            autoFocus
                            className="w-full text-3xl font-black tabular-nums text-center tracking-widest py-3 rounded-xl bg-dd-bg border-2 border-dd-line focus:border-dd-green focus:outline-none"
                            maxLength={7}
                        />
                        <button
                            onClick={handleSubmit}
                            disabled={status === 'claiming' || normalizePairingCode(code).length !== 6}
                            className="w-full mt-3 py-3 rounded-xl bg-dd-green text-white text-base font-black shadow disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 transition">
                            {status === 'claiming' ? 'Connecting…' : 'Pair this TV →'}
                        </button>
                        {errorMsg && (
                            <p className="mt-3 text-sm text-red-600 font-bold">⚠ {errorMsg}</p>
                        )}
                    </div>

                    {lastPaired && (
                        <button
                            onClick={handleContinueAsLast}
                            className="mt-6 px-4 py-2 rounded-xl bg-white/10 text-white text-sm font-bold border border-white/20 hover:bg-white/20 transition">
                            ↻ Continue as last menu: <span className="font-mono">{lastPaired}</span>
                        </button>
                    )}
                </>
            ) : status === 'claimed' ? (
                <div className="bg-white text-dd-text rounded-2xl px-6 py-8 w-full max-w-sm shadow-xl text-center">
                    <div className="text-5xl mb-3">📡</div>
                    <div className="text-xl font-black mb-1">Connected</div>
                    <p className="text-sm text-dd-text-2 mb-5">
                        Waiting for the admin to pick which menu this TV should show.
                    </p>
                    <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Code accepted
                    </div>
                </div>
            ) : (
                // 'assigned' — about to redirect
                <div className="bg-white text-dd-text rounded-2xl px-6 py-8 w-full max-w-sm shadow-xl text-center">
                    <div className="text-5xl mb-3">✅</div>
                    <div className="text-xl font-black mb-1">Paired</div>
                    <p className="text-sm text-dd-text-2">
                        Loading your menu…
                    </p>
                </div>
            )}

            <p className="text-[11px] text-white/40 mt-10">
                10-minute code · single-use · re-pair anytime at <span className="font-mono">/?pair=1</span>
            </p>
        </div>
    );
}
