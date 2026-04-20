import { useState, useEffect } from 'react';

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

// Geofence hook
export default function useGeofence() {
    const [isAtDDMau, setIsAtDDMau] = useState(false);
    const [checking, setChecking] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!navigator.geolocation) {
            setError("noGeo");
            setChecking(false);
            return;
        }

        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const inside = isWithinGeofence(pos.coords.latitude, pos.coords.longitude);
                setIsAtDDMau(inside);
                setChecking(false);
                setError(null);
            },
            (err) => {
                setError(err.code === 1 ? "denied" : "unavailable");
                setChecking(false);
            },
            { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
        );

        return () => navigator.geolocation.clearWatch(watchId);
    }, []);

    return { isAtDDMau, checking, error };
}
