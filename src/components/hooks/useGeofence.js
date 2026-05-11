import { useState, useEffect, useRef, useCallback } from 'react';

// DD Mau Location Coordinates
export const DD_MAU_LOCATIONS = [
    { name: "Maryland Heights", lat: 38.7138, lng: -90.4391 },
    { name: "Webster Groves", lat: 38.5917, lng: -90.3389 }
];

const GEOFENCE_RADIUS_FEET = 500;

// Haversine distance in feet
export function getDistanceFeet(lat1, lng1, lat2, lng2) {
    const R = 20902231; // Earth radius in feet
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function isWithinGeofence(lat, lng) {
    return DD_MAU_LOCATIONS.some(loc =>
        getDistanceFeet(lat, lng, loc.lat, loc.lng) <= GEOFENCE_RADIUS_FEET
    );
}

// Geofence hook.
//
// Returns:
//   isAtDDMau  — boolean, true when last known position is within radius
//   checking   — true while we're waiting for the first fix
//   error      — 'noGeo' | 'denied' | 'unavailable' | null
//   retry()    — re-request a position. Useful when a staff member
//                accidentally denied the prompt: the button on the
//                Recipes blocked screen calls this. Note: once the
//                browser has remembered a "denied" choice, it will
//                NOT re-prompt — the user has to reset permission in
//                browser/OS settings. retry() still flips error state
//                so we can show the right hint.
export default function useGeofence() {
    const [isAtDDMau, setIsAtDDMau] = useState(false);
    const [checking, setChecking] = useState(true);
    const [error, setError] = useState(null);
    const watchIdRef = useRef(null);

    // Start (or restart) the watcher. Cleans up any prior watcher first.
    const start = useCallback(() => {
        if (!navigator.geolocation) {
            setError("noGeo");
            setChecking(false);
            return;
        }
        if (watchIdRef.current != null) {
            try { navigator.geolocation.clearWatch(watchIdRef.current); } catch {}
            watchIdRef.current = null;
        }
        setChecking(true);
        setError(null);
        // Also fire a one-shot getCurrentPosition so we get a fix faster
        // than waiting for watchPosition's first tick on cold start.
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setIsAtDDMau(isWithinGeofence(pos.coords.latitude, pos.coords.longitude));
                setChecking(false);
                setError(null);
            },
            (err) => {
                setError(err.code === 1 ? "denied" : "unavailable");
                setChecking(false);
            },
            { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
        );
        watchIdRef.current = navigator.geolocation.watchPosition(
            (pos) => {
                setIsAtDDMau(isWithinGeofence(pos.coords.latitude, pos.coords.longitude));
                setChecking(false);
                setError(null);
            },
            (err) => {
                setError(err.code === 1 ? "denied" : "unavailable");
                setChecking(false);
            },
            { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
        );
    }, []);

    useEffect(() => {
        start();
        return () => {
            if (watchIdRef.current != null) {
                try { navigator.geolocation.clearWatch(watchIdRef.current); } catch {}
                watchIdRef.current = null;
            }
        };
    }, [start]);

    // Public retry — re-attempts the geolocation flow. If the browser
    // has remembered a denied permission, getCurrentPosition will return
    // the denied error immediately; the user then needs the OS settings
    // hint shown on the blocked screen. Either way, we re-run so the UI
    // updates state.
    const retry = useCallback(() => {
        start();
    }, [start]);

    return { isAtDDMau, checking, error, retry };
}
