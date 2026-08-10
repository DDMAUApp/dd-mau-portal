// SyncPill — tiny global "⏳ Saving…" indicator (stabilization Phase E).
//
// WHY: when the Firestore transport wedges, a save button just spins with
// zero feedback until the watchdog revives it — users read that as "the
// app is broken" and start re-tapping (which is how double-writes happen).
// This pill makes the in-flight state visible: it appears only when a
// watchdogged write has been airborne longer than SHOW_DELAY_MS (a healthy
// write acks in <2s, so normal saves never flash it), and flips amber once
// the watchdog has fired ("Reconnecting…") so a wedge reads as recovery
// in progress, not a dead button.
//
// Renders nothing at all in the idle state — zero cost on every page.

import { useEffect, useRef, useState } from 'react';
import { subscribeInFlightWrites } from '../data/firestoreRevive';

// Long enough that fast writes never flash the pill, short enough that a
// user who just tapped Save sees feedback before they re-tap (~1s).
export const SHOW_DELAY_MS = 900;

export default function SyncPill() {
    const [visible, setVisible] = useState(false);
    const [stuck, setStuck] = useState(false);
    // Explicit offline contract (2026-08-10 gap work): when the browser
    // says we're offline, say so plainly — Firestore quietly queues writes
    // locally, and "queued on this device" must never read as "saved".
    const [offline, setOffline] = useState(
        typeof navigator !== 'undefined' && navigator.onLine === false
    );
    const showTimer = useRef(null);

    useEffect(() => {
        const unsub = subscribeInFlightWrites(({ inFlight, stuck: stuckCount }) => {
            setStuck(stuckCount > 0);
            if (inFlight > 0) {
                if (!showTimer.current) {
                    showTimer.current = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
                }
            } else {
                clearTimeout(showTimer.current);
                showTimer.current = null;
                setVisible(false);
            }
        });
        const onOnline = () => setOffline(false);
        const onOffline = () => setOffline(true);
        window.addEventListener('online', onOnline);
        window.addEventListener('offline', onOffline);
        return () => {
            unsub(); clearTimeout(showTimer.current);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('offline', onOffline);
        };
    }, []);

    // Offline outranks everything and shows immediately — the schedule on
    // screen may be stale and saves are only queued, not durable.
    if (!offline && !visible) return null;
    const label = offline
        ? 'Offline — changes save when back / Sin conexión'
        : stuck
            ? 'Reconnecting… / Reconectando…'
            : 'Saving… / Guardando…';
    const bg = offline ? 'rgba(75,85,99,.92)' : stuck ? 'rgba(146,64,14,.92)' : 'rgba(15,36,23,.88)';
    return (
        <div
            aria-live="polite"
            style={{
                position: 'fixed',
                top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 2147482000, // above page chrome, below the version-floor overlay
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 14px', borderRadius: 999,
                background: bg,
                color: '#fff', fontSize: 12, fontWeight: 700,
                boxShadow: '0 4px 14px rgba(0,0,0,.25)',
                pointerEvents: 'none',
                backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            }}
        >
            {offline ? (
                <span style={{ fontSize: 12 }}>📡</span>
            ) : (
                <span style={{
                    width: 12, height: 12, borderRadius: '50%',
                    border: '2px solid rgba(255,255,255,.35)', borderTopColor: '#fff',
                    animation: 'ddmau-syncpill-spin 1s linear infinite',
                }} />
            )}
            <style>{'@keyframes ddmau-syncpill-spin{to{transform:rotate(360deg)}}'}</style>
            {label}
        </div>
    );
}
