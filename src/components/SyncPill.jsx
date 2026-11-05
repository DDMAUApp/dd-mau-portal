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

// One language at a time, the person's own. Both only if we don't know theirs.
const COPY = {
    offline: {
        en: 'No connection. Counts wait on this device. New items and schedule changes need a connection.',
        es: 'Sin conexión. Los conteos esperan en este dispositivo. Los artículos nuevos y los cambios de horario necesitan conexión.',
    },
    saving: { en: 'Saving…', es: 'Guardando…' },
    stuck: {
        en: 'Still sending. Hold off on new changes until this goes away.',
        es: 'Aún enviando. Espera a que esto desaparezca antes de hacer más cambios.',
    },
    reloadNotice: {
        en: 'Restarting the app to fix the connection…',
        es: 'Reiniciando la app para arreglar la conexión…',
    },
    hardStuckNative: {
        en: 'Your last changes may not be saved. Write them down. Close the app (swipe it away) and reopen it. Check them before entering them again.',
        es: 'Tus últimos cambios pueden no estar guardados. Anótalos. Cierra la app (deslízala hacia arriba) y ábrela de nuevo. Revísalos antes de volver a ingresarlos.',
    },
    hardStuckWeb: {
        en: 'Your last changes may not be saved. Write them down. Refresh the page. Check them before entering them again.',
        es: 'Tus últimos cambios pueden no estar guardados. Anótalos. Recarga la página. Revísalos antes de volver a ingresarlos.',
    },
};

export function syncPillLabel({ offline, reloadNotice, hardStuck, stuck, isNative, language }) {
    const entry = offline ? COPY.offline
        : reloadNotice ? COPY.reloadNotice
            : hardStuck ? (isNative ? COPY.hardStuckNative : COPY.hardStuckWeb)
                : stuck ? COPY.stuck
                    : COPY.saving;
    if (language === 'es') return entry.es;
    if (language === 'en') return entry.en;
    return `${entry.en} / ${entry.es}`;
}

export default function SyncPill({ language }) {
    const [visible, setVisible] = useState(false);
    const [stuck, setStuck] = useState(false);
    // Reloading already failed to cure a stuck save (firestoreRevive loop cap,
    // 2026-09-23): say plainly what fixes it instead of spinning forever.
    const [hardStuck, setHardStuck] = useState(false);
    const [reloadNotice, setReloadNotice] = useState(false);
    // Explicit offline contract (2026-08-10 gap work): when the browser
    // says we're offline, say so plainly — Firestore quietly queues writes
    // locally, and "queued on this device" must never read as "saved".
    const [offline, setOffline] = useState(
        typeof navigator !== 'undefined' && navigator.onLine === false
    );
    const showTimer = useRef(null);

    useEffect(() => {
        const unsub = subscribeInFlightWrites(({ inFlight, stuck: stuckCount, hardStuck: hard, reloadNotice: notice }) => {
            setStuck(stuckCount > 0);
            setHardStuck(!!hard);
            setReloadNotice(!!notice);
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
    if (!offline && !visible && !hardStuck && !reloadNotice) return null;
    const isNative = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
    const label = syncPillLabel({ offline, reloadNotice, hardStuck, stuck, isNative, language });
    const bg = offline ? 'rgba(75,85,99,.92)' : hardStuck ? 'rgba(153,27,27,.94)' : (stuck || reloadNotice) ? 'rgba(146,64,14,.92)' : 'rgba(15,36,23,.88)';
    return (
        <div
            aria-live="polite"
            style={{
                position: 'fixed',
                top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
                // Both edges plus fit-content: a long message gets the whole
                // width, where left:50% squeezed it into half the screen.
                left: 12,
                right: 12,
                marginInline: 'auto',
                width: 'fit-content',
                zIndex: 2147482000, // above page chrome, below the version-floor overlay
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 14px', borderRadius: 16,
                textAlign: 'center',
                background: bg,
                color: '#fff', fontSize: 12, fontWeight: 700,
                boxShadow: '0 4px 14px rgba(0,0,0,.25)',
                pointerEvents: 'none',
                backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            }}
        >
            {offline ? (
                <span style={{ fontSize: 12, flexShrink: 0 }}>📡</span>
            ) : (
                <span style={{
                    width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                    border: '2px solid rgba(255,255,255,.35)', borderTopColor: '#fff',
                    animation: 'ddmau-syncpill-spin 1s linear infinite',
                }} />
            )}
            <style>{'@keyframes ddmau-syncpill-spin{to{transform:rotate(360deg)}}'}</style>
            {label}
        </div>
    );
}
