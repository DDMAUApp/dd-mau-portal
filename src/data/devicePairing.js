// devicePairing — 6-digit pairing flow that replaces the
// "paste this URL into the Pi's browser" setup ritual.
//
// Andrew 2026-05-23 (audit follow-up). The previous TV setup was:
//   1. Admin creates a TV config in the dashboard.
//   2. Admin copies the kiosk URL.
//   3. Andrew or a manager walks the URL to the Pi via Tailscale /
//      a USB keyboard / a phone screenshot. Fragile, error-prone,
//      and a real barrier when the restaurant is busy.
// New flow:
//   1. Admin clicks "Pair Device" in Menu Screens → modal shows a
//      6-digit code, generates a /pairing_codes/{code} doc with a
//      10-minute TTL.
//   2. Pi boots into app.ddmaustl.com/?pair=1, types the code, hits
//      Submit. The Pi writes its deviceId + userAgent onto the code
//      doc.
//   3. Admin sees "Device connected" in the modal, picks which
//      tvId to assign it to (or creates a new one inline), confirms.
//   4. Pi sees `assignedTvId` appear on the code doc, navigates
//      itself to `?tv=<tvId>`. Pairing complete.
//
// Why client-side codes are good enough for this use case:
//   • Pairing happens on-premises with admin physically present.
//     A casual attacker can't intercept the code without being in
//     the building.
//   • Codes expire in 10 minutes — replay window is tiny.
//   • Each code claimable only once (transactional claim below).
//   • Worst case: a determined attacker pairs THEIR Pi to ONE of
//     YOUR TVs and gets it to show YOUR menu. Mildly annoying,
//     not a data breach.
// When Firebase Auth lands (Phase 2 roadmap in firestore.rules),
// we'll tighten this so only authenticated admins can mint codes.

import { db } from '../firebase';
import {
    collection, doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot,
    serverTimestamp, runTransaction,
} from 'firebase/firestore';
import { recordAudit } from './audit';

const COLLECTION    = 'pairing_codes';
const TTL_MS        = 10 * 60 * 1000;   // 10 minutes
export const PAIRING_TTL_MS = TTL_MS;
const DEVICE_ID_KEY = 'ddmau:deviceId';

// Persist a stable deviceId in localStorage so multiple visits to
// /?pair=1 from the same Pi don't generate fresh anonymous devices.
// Format is a v4-ish random ID (no crypto dep needed; collision
// probability is negligible at 16 bytes hex).
export function getOrCreateDeviceId() {
    if (typeof localStorage === 'undefined') return null;
    try {
        let existing = localStorage.getItem(DEVICE_ID_KEY);
        if (existing) return existing;
        const bytes = new Uint8Array(16);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        const id = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(DEVICE_ID_KEY, id);
        return id;
    } catch { return null; }
}

// 6 digits split by a dash for readability ("123-456"). Avoids
// leading-zero ambiguity since we keep it as a string. Collision
// space is 1M codes; collision odds at 10-min TTL with a handful
// of concurrent codes are effectively zero, but the createPairingCode
// flow below retries on collision anyway.
export function generatePairingCode() {
    const n = Math.floor(Math.random() * 1_000_000);
    return String(n).padStart(6, '0');
}

export function formatPairingCode(code) {
    if (!code || code.length !== 6) return code || '';
    return `${code.slice(0, 3)}-${code.slice(3)}`;
}

// Normalize whatever the user typed (dashes, spaces, mixed case)
// into the canonical 6-digit string the doc id uses.
export function normalizePairingCode(input) {
    return String(input || '').replace(/[^0-9]/g, '').slice(0, 6);
}

// Create a fresh code doc. Retries up to 5x on the (~astronomically
// rare) doc-id collision against another active code. Returns the
// created doc reference + the canonical code string.
export async function createPairingCode({ byName, presetTvId = null, presetLocation = null }) {
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = generatePairingCode();
        const ref = doc(db, COLLECTION, code);
        try {
            // Use setDoc with merge:false + a server check — if the
            // doc already exists, this overwrites... not safe. Better:
            // runTransaction to ensure we don't trample an active code.
            const ok = await runTransaction(db, async (tx) => {
                const snap = await tx.get(ref);
                if (snap.exists()) {
                    const existing = snap.data();
                    const expires = existing.expiresAt?.toMillis
                        ? existing.expiresAt.toMillis()
                        : 0;
                    if (expires > Date.now()) {
                        // Still live — pick a different code.
                        return false;
                    }
                    // Expired — safe to overwrite.
                }
                tx.set(ref, {
                    code,
                    createdAt: serverTimestamp(),
                    createdBy: byName || null,
                    expiresAt: new Date(Date.now() + TTL_MS),
                    presetTvId,
                    presetLocation,
                    claimedAt: null,
                    claimedByDeviceId: null,
                    claimedByUserAgent: null,
                    assignedTvId: null,
                    assignedAt: null,
                });
                return true;
            });
            if (ok) {
                try {
                    recordAudit({
                        action: 'pairing.create',
                        actorName: byName || 'admin',
                        targetType: 'pairing_code',
                        targetId: code,
                    });
                } catch {}
                return { code, ref };
            }
        } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Could not create a unique pairing code');
}

// Pi side — claim a code. Atomic so two Pis racing on the same
// code can't both win. Returns the claimed code data; throws on
// not-found / expired / already-claimed so the Pair page can
// surface a precise error.
export async function claimPairingCode({ code, deviceId, userAgent }) {
    const ref = doc(db, COLLECTION, code);
    return await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) {
            const err = new Error('NOT_FOUND'); err.code = 'NOT_FOUND'; throw err;
        }
        const data = snap.data();
        const expires = data.expiresAt?.toMillis
            ? data.expiresAt.toMillis()
            : 0;
        if (expires && expires < Date.now()) {
            const err = new Error('EXPIRED'); err.code = 'EXPIRED'; throw err;
        }
        if (data.claimedAt) {
            // Already claimed — allow re-claim only by the same device
            // (so a Pi refreshing the page mid-flow recovers). Otherwise
            // reject.
            if (data.claimedByDeviceId !== deviceId) {
                const err = new Error('ALREADY_CLAIMED'); err.code = 'ALREADY_CLAIMED'; throw err;
            }
        }
        tx.update(ref, {
            claimedAt: serverTimestamp(),
            claimedByDeviceId: deviceId || null,
            claimedByUserAgent: (userAgent || '').slice(0, 200),
        });
        return { ...data, code };
    });
}

// Admin side — assign a tvId to a claimed code so the Pi pivots
// to /?tv=<tvId>. Records an audit row + bumps assignedAt so the
// Pi's onSnapshot can react.
export async function assignTvIdToCode({ code, tvId, byName }) {
    if (!code || !tvId) throw new Error('code + tvId required');
    const ref = doc(db, COLLECTION, code);
    await updateDoc(ref, {
        assignedTvId: tvId,
        assignedAt: serverTimestamp(),
        assignedBy: byName || null,
    });
    try {
        recordAudit({
            action: 'pairing.assign',
            actorName: byName || 'admin',
            targetType: 'pairing_code',
            targetId: code,
            extra: { tvId },
        });
    } catch {}
}

// Live subscription used by both sides. Pi polls for assignedTvId;
// admin modal polls for claimedAt + claimedByUserAgent so the UI
// flips from "waiting for device" → "device connected, pick a TV".
export function subscribePairingCode(code, cb) {
    if (!code) { cb(null); return () => {}; }
    const ref = doc(db, COLLECTION, code);
    const unsub = onSnapshot(ref, (snap) => {
        cb(snap.exists() ? { code, ...snap.data() } : null);
    }, (err) => {
        console.warn('subscribePairingCode failed:', err);
        cb(null);
    });
    return unsub;
}

// Cancel a code — used when admin closes the pairing modal before
// completion. Deletes the doc so it's not sitting in Firestore for
// the next 10 minutes (and doesn't surface in audit replay as
// "abandoned").
export async function cancelPairingCode({ code }) {
    if (!code) return;
    try { await deleteDoc(doc(db, COLLECTION, code)); } catch {}
}
