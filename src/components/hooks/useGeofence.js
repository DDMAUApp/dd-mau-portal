import { useState, useEffect, useRef, useCallback } from 'react';

// DD Mau Location Coordinates. `slug` matches the app's storeLocation
// values ('maryland' / 'webster') so callers can map a fix straight to the
// location toggle without a lookup table.
export const DD_MAU_LOCATIONS = [
    { name: "Maryland Heights", slug: "maryland", lat: 38.7138, lng: -90.4391 },
    { name: "Webster Groves", slug: "webster", lat: 38.5917, lng: -90.3389 }
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

// nearestDDMauLocation — the slug of the store the device is physically at
// ('maryland' | 'webster'), or null if it's outside both geofences. When
// (improbably) inside both radii, the closer one wins.
export function nearestDDMauLocation(lat, lng) {
    let best = null;
    let bestDist = Infinity;
    for (const loc of DD_MAU_LOCATIONS) {
        const d = getDistanceFeet(lat, lng, loc.lat, loc.lng);
        if (d <= GEOFENCE_RADIUS_FEET && d < bestDist) { best = loc.slug; bestDist = d; }
    }
    return best;
}

// Geofence hook.
//
// Returns:
//   isAtDDMau  — boolean, true when last known position is within radius
//   checking   — true while we're waiting for the first fix
//   error      — 'noGeo' | 'denied' | 'unavailable' | null
//   permState  — 'prompt' | 'granted' | 'denied' | 'unknown'
//                Set via the Permissions API when supported. Lets the UI
//                tell the difference between "user hasn't decided yet"
//                (calling getCurrentPosition will pop the native prompt)
//                and "user explicitly denied" (no API will re-prompt;
//                only Settings will). Falls back to 'unknown' on iOS
//                Safari < 16.4 etc.
//   retry()    — re-request a position. If permState is 'prompt' or
//                'unknown', this triggers the native dialog. If permState
//                is 'denied', this returns immediately with denied error
//                and the UI shows the Settings hint.
export default function useGeofence() {
    const [isAtDDMau, setIsAtDDMau] = useState(false);
    // Which store the device is at ('maryland' | 'webster' | null). Lets the
    // app auto-start a both-locations user at the location they're physically
    // at instead of a hardcoded default.
    const [nearestLocation, setNearestLocation] = useState(null);
    const [checking, setChecking] = useState(true);
    const [error, setError] = useState(null);
    const [permState, setPermState] = useState('unknown');
    const watchIdRef = useRef(null);

    // Query the Permissions API on mount + subscribe to changes. Not every
    // browser supports it (iOS Safari only added geolocation support in
    // 16.4; older Safari throws on this query). Wrap in try/catch and
    // fall back to 'unknown'.
    useEffect(() => {
        if (!('permissions' in navigator) || typeof navigator.permissions.query !== 'function') return;
        let status;
        (async () => {
            try {
                status = await navigator.permissions.query({ name: 'geolocation' });
                setPermState(status.state);
                status.onchange = () => setPermState(status.state);
            } catch {
                setPermState('unknown');
            }
        })();
        return () => {
            if (status) status.onchange = null;
        };
    }, []);

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
        const onFix = (pos) => {
            setIsAtDDMau(isWithinGeofence(pos.coords.latitude, pos.coords.longitude));
            setNearestLocation(nearestDDMauLocation(pos.coords.latitude, pos.coords.longitude));
            setChecking(false);
            setError(null);
        };
        navigator.geolocation.getCurrentPosition(
            onFix,
            (err) => {
                setError(err.code === 1 ? "denied" : "unavailable");
                setChecking(false);
            },
            { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
        );
        watchIdRef.current = navigator.geolocation.watchPosition(
            onFix,
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

    return { isAtDDMau, nearestLocation, checking, error, retry, permState };
}
