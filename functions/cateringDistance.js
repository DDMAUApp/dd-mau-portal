// Catering delivery distance + address suggestions, through Google (Routes API and
// Places API (New)). Key: the GOOGLE_MAPS_KEY secret (set 2026-11-05, restricted to
// those two APIs). The order form only calls this when config/catering.distanceLookup
// is true.
const { defineSecret } = require("firebase-functions/params");

const GOOGLE_MAPS_KEY = defineSecret("GOOGLE_MAPS_KEY");
const STL = { latitude: 38.627, longitude: -90.199 };
const METERS_PER_MILE = 1609.344;
// Same as DEFAULT_CATERING_SETTINGS.stores until the owner saves Admin → Catering.
const DEFAULT_STORES = {
    webster: "8169 Big Bend Blvd, Webster Groves, MO 63119",
    maryland: "11982 Dorsett Rd, Maryland Heights, MO 63043",
};

async function driveMiles(key, from, to) {
    const resp = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,condition",
        },
        body: JSON.stringify({
            origins: [{ waypoint: { address: from } }],
            destinations: [{ waypoint: { address: to } }],
            travelMode: "DRIVE",
        }),
    });
    if (!resp.ok) throw new Error(`routes ${resp.status}`);
    const rows = await resp.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.condition !== "ROUTE_EXISTS" || !Number.isFinite(row.distanceMeters)) return null;
    return Math.round((row.distanceMeters / METERS_PER_MILE) * 10) / 10;
}

async function suggest(key, input) {
    const resp = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
        body: JSON.stringify({
            input,
            includedRegionCodes: ["us"],
            locationBias: { circle: { center: STL, radius: 50000 } },
        }),
    });
    if (!resp.ok) throw new Error(`places ${resp.status}`);
    const data = await resp.json();
    return (data.suggestions || [])
        .map(s => s.placePrediction?.text?.text)
        .filter(Boolean)
        .slice(0, 5);
}

function makeCateringDistance({ onCall, HttpsError, db }) {
    return onCall(
        { region: "us-central1", cors: true, secrets: [GOOGLE_MAPS_KEY], timeoutSeconds: 20, maxInstances: 5 },
        async (req) => {
            const { action, address, store } = req.data || {};
            const text = String(address || "").trim().slice(0, 200);
            if (text.length < 5) throw new HttpsError("invalid-argument", "address too short");
            const key = GOOGLE_MAPS_KEY.value();
            try {
                if (action === "suggest") return { suggestions: await suggest(key, text) };
                const settings = (await db.doc("config/catering").get()).data() || {};
                const from = settings.stores?.[store]?.address || DEFAULT_STORES[store];
                if (!from) throw new HttpsError("failed-precondition", "no store address");
                return { miles: await driveMiles(key, from, text) };
            } catch (e) {
                if (e instanceof HttpsError) throw e;
                console.warn("cateringDistance failed", e.message);
                throw new HttpsError("unavailable", "lookup failed");
            }
        },
    );
}

module.exports = { makeCateringDistance, GOOGLE_MAPS_KEY };
