// TV / kiosk display configs — per-TV settings that drive the
// MenuDisplay component when a kiosk browser hits ?tv=<tvId>.
//
// Andrew 2026-05-20 — Phase 2 of menu-TV feature. Each restaurant
// can have multiple TVs (front-of-house, drive-thru-style, bar
// area, etc.) and each TV picks its own location, layout, and
// category filter. Configs live in Firestore so admins manage
// them in the app, not by editing code.
//
// ─── Schema ───────────────────────────────────────────────────
// /tv_configs/{tvId} = {
//   tvId:         'webster-foh'         // doc id; URL-friendly slug
//   label:        'Webster Front'       // display name in admin
//   location:     'webster'|'maryland'  // which 86 list to pull
//
//   // 2026-05-20 — Andrew: "if the menu comes in as pdf or jpeg how
//   // can you make edits". Two top-level modes:
//   mode:         'menu'|'image'        // 'menu' = data-driven (default);
//                                        // 'image' = render uploaded PDF/JPEG
//
//   // For mode='menu':
//   layout:       'dense'|'rotate'|'spotlight'
//   includeCategories: string[]?        // null/empty = ALL categories
//   showPhotos:   boolean?              // show item photos when present
//   rotateSeconds:number?               // for 'rotate' layout; default 8
//   spotlightCategory: string?          // for 'spotlight' layout
//
//   // For mode='image':
//   imageUrls:        string[]?         // Firebase Storage URLs, one per page
//   imageRotateSeconds: number?         // if multiple pages, rotate every N sec
//   imageHitZones:    HitZone[]?        // SOLD OUT overlay regions; see below
//
//   // 2026-05-20 — Andrew Wave 1 of "match the SaaS leaders". Auto-
//   // switch the displayed menu by time of day. Every "real" digital
//   // signage tool (Raydiant, ScreenCloud, NowSignage, Samsung VXT)
//   // has this; ours adds a kicker — each daypart can carry its own
//   // imageUrls + hitZones (so lunch and dinner can be entirely
//   // different PDFs with their own SOLD OUT mappings).
//   //
//   // dayparts: [{
//   //   label:    'Breakfast'|'Lunch'|'Dinner'|<custom>,
//   //   startHour: 0..23  // inclusive, 24h
//   //   endHour:   0..24  // exclusive (24 = until end of day)
//   //   imageUrls: string[]   // shown during this daypart
//   //   imageHitZones: HitZone[]?
//   //   imageRotateSeconds: number?
//   // }]
//   //
//   // When dayparts.length > 0, MenuDisplay picks the daypart that
//   // contains the current local hour and renders its content. If
//   // no daypart matches the current hour, falls back to the
//   // top-level imageUrls/hitZones. Backward-compatible — a TV
//   // config without `dayparts` behaves exactly as before.

// HitZone — Andrew 2026-05-20: "will i be able to keep the look of
// the menu the exact same — Image + overlay 'SOLD OUT' stickers on
// items". Admin clicks the menu image once per item to map a
// rectangle to a menu-item name. When that item appears in the
// location's 86 list, MenuDisplay overlays a red "SOLD OUT"
// sticker at the rectangle, preserving the original menu design.
//
// Same zones also carry a `priceOverride` — Andrew 2026-05-20 later:
// "i also want to be able to change pricing how can we do that".
// When the printed PDF price gets stale, admin sets a new price
// string on the zone; MenuDisplay covers the right ~30% of the
// zone with a white sticker showing the new price, preserving the
// rest of the menu design.
//
// Coordinates are fractions of the image's natural width/height
// (0..1) so the same hit zones work at any TV resolution.
// Shape:
//   {
//     page:        number   // index into imageUrls (0-based)
//     x, y:        number   // top-left in 0..1
//     width, height: number // size in 0..1
//     itemName:    string   // matches MENU_DATA item nameEn (after normalize())
//     category:    string?  // hint for the admin UI; not used by 86 matching
//     priceOverride: string?  // e.g. "$19.50" — covers the printed price when set
//     qrUrl:       string?  // 2026-05-20 — when set, MenuDisplay renders a
//                            // QR code overlay covering the zone that links
//                            // to this URL (e.g. catering page, online order,
//                            // nutrition info). The QR is generated client-
//                            // side from the qrcode npm package; no server
//                            // call needed.
//   }
//
//
//   // 2026-05-20 — Wave 3 of "match the SaaS leaders". A persistent
//   // text bar overlaid at the top or bottom of the TV. Common uses:
//   //   "🎉 Happy hour 3-5pm — half off boba teas"
//   //   "📞 Order online → ddmau.com/order"
//   //   "🎂 Closed Tuesday for staff training — reopens Wednesday"
//   //   "Welcome to DD Mau! Order at the counter."
//   // The strip auto-scrolls horizontally when the text is wider than
//   // the screen so long promos stay legible.
//   // For mode='split': two image sources side-by-side. Used to
//   // mimic the SaaS competitors' "menu + photo carousel" layout
//   // (Raydiant, Samsung VXT all push this). Left side gets the hit
//   // zones for 86/price/QR. Right side just rotates content.
//   split: {
//     leftImageUrls:        string[]       // main side (gets hit zones)
//     leftRotateSeconds:    number?
//     rightImageUrls:       string[]       // secondary side (carousel)
//     rightRotateSeconds:   number?
//     leftWidthPct:         number?         // 50..85; default 70
//     // imageHitZones live at the top level (apply to the LEFT side)
//   }?
//
//   promoStrip:   {
//     enabled:  boolean
//     position: 'top'|'bottom'
//     textEn:   string
//     textEs:   string?
//     style:    'sage'|'red'|'amber'|'sky'|'dark'   // background tint
//     speed:    number?                              // scroll px/sec; null = static
//   }?
//
//   updatedAt:    serverTimestamp
//   updatedBy:    string
// }
//
// Two TV IDs are reserved as backward-compat defaults:
//   ?tv=webster   → falls back to { location: 'webster',  layout: 'dense' }
//   ?tv=maryland  → falls back to { location: 'maryland', layout: 'dense' }
// Both still work without any config doc — useful for first-boot
// before admin sets anything up.

import { db } from '../firebase';
import {
    doc, collection, getDoc, setDoc, deleteDoc, onSnapshot, serverTimestamp,
    runTransaction, query, orderBy, limit as fsLimit, deleteField,
} from 'firebase/firestore';
import { recordAudit } from './audit';

const COLLECTION = 'tv_configs';
// Subcollection of immutable snapshots — every time a TV config's
// published state changes (saveTvConfig OR publishTvConfigDraft
// OR rollbackTvConfig), the prior published state gets archived
// here under a numeric version doc id so admins can roll back.
const VERSIONS_SUBCOLLECTION = 'versions';

// Top-level modes:
//   • 'menu'  — data-driven board (MENU_DATA + overrides + live 86)
//   • 'image' — uploaded PDF/JPEG/video, full-bleed
//   • 'split' — Wave 6 of "match the leaders": two image sources
//               side-by-side (e.g. 70% menu PDF + 30% photo carousel).
//               Each side has its own imageUrls + rotateSeconds; the
//               LEFT side carries the hit zones (so 86 + price + QR
//               overlays still work on the menu side).
export const MODES = Object.freeze({
    MENU:  'menu',
    IMAGE: 'image',
    SPLIT: 'split',
});
export const DEFAULT_MODE = MODES.MENU;

// Layouts within mode='menu'. Keep in sync with MenuDisplay.jsx
// where each is implemented.
export const LAYOUTS = Object.freeze({
    DENSE:     'dense',      // 3-col single-page view (initial layout)
    ROTATE:    'rotate',     // cycles through categories every N sec
    SPOTLIGHT: 'spotlight',  // one big category + others compact
});
export const DEFAULT_LAYOUT = LAYOUTS.DENSE;
export const DEFAULT_ROTATE_SECONDS = 8;
export const DEFAULT_IMAGE_ROTATE_SECONDS = 12;

// Common restaurant dayparts; used as default suggestions in the
// daypart editor. Admin can also pick custom hours.
export const PRESET_DAYPARTS = Object.freeze([
    { label: 'Breakfast', startHour:  7, endHour: 11 },
    { label: 'Lunch',     startHour: 11, endHour: 15 },
    { label: 'Happy Hour',startHour: 15, endHour: 17 },
    { label: 'Dinner',    startHour: 17, endHour: 22 },
    { label: 'Late Night',startHour: 22, endHour: 24 },
]);

// Pure function — given a list of dayparts and a Date, returns the
// matching daypart (or null if none cover the current hour). Used by
// MenuDisplay every minute via a tick effect to decide what to show.
// Wraps across midnight if endHour < startHour (e.g. 22→4).
export function resolveActiveDaypart(dayparts, now = new Date()) {
    if (!Array.isArray(dayparts) || dayparts.length === 0) return null;
    const h = now.getHours() + now.getMinutes() / 60;
    for (const dp of dayparts) {
        const s = Number(dp?.startHour);
        const e = Number(dp?.endHour);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        if (s < e) {
            // Normal range.
            if (h >= s && h < e) return dp;
        } else if (s > e) {
            // Wraps midnight (e.g. 22..4).
            if (h >= s || h < e) return dp;
        }
        // s === e → zero-length daypart, skip.
    }
    return null;
}

// 2026-05-23: gap-tolerant variant of resolveActiveDaypart. Used by
// MenuDisplay so a daypart gap (e.g. Breakfast 7-11, Lunch 12-15
// — what happens between 11 and 12?) falls back to the most-recent
// daypart's content instead of blanking the screen.
//
// Resolution order:
//   1. If a daypart covers `now`, return it (normal case).
//   2. Otherwise, of all dayparts that END before `now`, return the
//      one whose end-hour is closest to `now` (the one we just left).
//   3. If none have ended yet today, pick the one that ends LAST today
//      (yesterday's last daypart — better than nothing).
//   4. Returns null only if the dayparts list is empty / invalid.
//
// The fallback's `_isFallback: true` flag lets the caller decide whether
// to apply a subtle indicator ("schedule gap — showing last hour's
// content"); MVP just renders it transparently.
export function resolveActiveOrLastDaypart(dayparts, now = new Date()) {
    const active = resolveActiveDaypart(dayparts, now);
    if (active) return active;
    if (!Array.isArray(dayparts) || dayparts.length === 0) return null;
    const h = now.getHours() + now.getMinutes() / 60;
    let best = null;
    let bestGap = Infinity;
    for (const dp of dayparts) {
        const e = Number(dp?.endHour);
        if (!Number.isFinite(e)) continue;
        // Distance backwards from `now` to this daypart's end. If the
        // daypart hasn't ended yet today (e > h), we pretend it ended
        // yesterday at the same hour (gap = 24 - e + h) so today's
        // morning shows last night's last-active daypart content.
        const gap = h >= e ? h - e : (24 - e + h);
        if (gap < bestGap) {
            bestGap = gap;
            best = dp;
        }
    }
    return best ? { ...best, _isFallback: true, _gapHours: bestGap } : null;
}

// Validation helper for the editor — returns a list of {startHour,
// endHour} gap-spans the user should be warned about. Each gap is a
// stretch of clock time NOT covered by any daypart. Wraps across
// midnight if needed. Used by TvConfigsEditor to surface
// "11:00–12:00 has no daypart" warnings inline.
export function findDaypartGaps(dayparts) {
    if (!Array.isArray(dayparts) || dayparts.length === 0) return [];
    // Build a 0-24 number-line of which hours are covered. 0.5-hour
    // resolution is fine for warning purposes (we won't surface a
    // 6-minute gap; admins set times in whole/half hours).
    const STEP = 0.5;
    const covered = new Array(Math.round(24 / STEP)).fill(false);
    const idxFor = (h) => {
        const i = Math.floor(((h % 24 + 24) % 24) / STEP);
        return Math.min(Math.max(i, 0), covered.length - 1);
    };
    for (const dp of dayparts) {
        const s = Number(dp?.startHour);
        const e = Number(dp?.endHour);
        if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
        if (s === e) continue;
        if (s < e) {
            for (let h = s; h < e; h += STEP) covered[idxFor(h)] = true;
        } else {
            // Wraps midnight
            for (let h = s; h < 24; h += STEP) covered[idxFor(h)] = true;
            for (let h = 0; h < e; h += STEP) covered[idxFor(h)] = true;
        }
    }
    // Walk the line and emit gap spans. Skip the trivial all-covered
    // and all-uncovered cases.
    const gaps = [];
    let gapStart = null;
    for (let i = 0; i < covered.length; i++) {
        if (!covered[i] && gapStart === null) gapStart = i * STEP;
        else if (covered[i] && gapStart !== null) {
            gaps.push({ startHour: gapStart, endHour: i * STEP });
            gapStart = null;
        }
    }
    if (gapStart !== null) gaps.push({ startHour: gapStart, endHour: 24 });
    return gaps;
}

// URL-safe slug for a TV id. Same kebab-case convention as the
// menu item slugs.
export function makeTvId(label, location) {
    const base = String(label || location || 'tv')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'tv';
    return base;
}

// Live subscription to the heartbeat collection that MenuDisplay
// writes to every 60s. Returns { [tvId]: { lastSeenAt, userAgent } }
// keyed by tvId so the dashboard can look up "is this screen alive
// right now?" in O(1). One doc per tvId — if multiple Pis point at
// the same id, last-writer-wins, which is fine for "anything alive?".
// The checkTvHeartbeats Cloud Function reads the same collection
// to fire offline alerts, so we're not duplicating any infra.
const HEARTBEATS_COLLECTION = 'tv_heartbeats';
export function subscribeTvHeartbeats(cb) {
    const unsub = onSnapshot(collection(db, HEARTBEATS_COLLECTION), (snap) => {
        const byTvId = {};
        snap.forEach(d => { byTvId[d.id] = { tvId: d.id, ...d.data() }; });
        cb(byTvId);
    }, (err) => {
        console.warn('tv_heartbeats subscription failed:', err);
        cb({});
    });
    return unsub;
}

// Live subscription. Returns an array of TV configs ordered by
// location → label (stable for admin display).
export function subscribeTvConfigs(cb) {
    const unsub = onSnapshot(collection(db, COLLECTION), (snap) => {
        const list = [];
        snap.forEach(d => list.push({ tvId: d.id, ...d.data() }));
        list.sort((a, b) => {
            const la = a.location || '';
            const lb = b.location || '';
            if (la !== lb) return la.localeCompare(lb);
            return (a.label || a.tvId || '').localeCompare(b.label || b.tvId || '');
        });
        cb(list);
    }, (err) => {
        console.warn('tv_configs subscription failed:', err);
        cb([]);
    });
    return unsub;
}

// One-shot read. Falls back to defaults for the two reserved
// "webster" and "maryland" tvIds so first-time-no-config still
// renders something sensible.
export async function getTvConfig(tvId) {
    if (!tvId) return null;
    const snap = await getDoc(doc(db, COLLECTION, tvId));
    if (snap.exists()) {
        return { tvId, ...snap.data() };
    }
    if (tvId === 'webster' || tvId === 'maryland') {
        return {
            tvId,
            label: tvId === 'webster' ? 'Webster' : 'MD Heights',
            location: tvId,
            layout: DEFAULT_LAYOUT,
            _isDefault: true,
        };
    }
    return null;
}

// Live subscription to ONE config — used by MenuDisplay so layout/
// category changes from admin reflect on the TV without a refresh.
// Same default-fallback rules as getTvConfig.
export function subscribeTvConfig(tvId, cb) {
    if (!tvId) { cb(null); return () => {}; }
    const unsub = onSnapshot(doc(db, COLLECTION, tvId), (snap) => {
        if (snap.exists()) {
            cb({ tvId, ...snap.data() });
        } else if (tvId === 'webster' || tvId === 'maryland') {
            cb({
                tvId,
                label: tvId === 'webster' ? 'Webster' : 'MD Heights',
                location: tvId,
                layout: DEFAULT_LAYOUT,
                _isDefault: true,
            });
        } else {
            cb(null);
        }
    }, (err) => {
        console.warn('tv_config subscription failed:', err);
        cb(null);
    });
    return unsub;
}

// ── Publish / Draft / Version internals ────────────────────────────────
// What we're protecting against, and how:
//   • "I saved while editing and the TV showed half my work to a customer."
//     → draftSnapshot field. saveTvConfigDraft writes there; root stays
//       unchanged so the TV keeps rendering the previously-published
//       state. publishTvConfigDraft promotes draft → root atomically.
//   • "I broke the menu with a bad save and don't know how to undo."
//     → /tv_config_versions/{tvId}/versions/v<N> subcollection. Every
//       transition of the published state (live save, publish-from-draft,
//       rollback) writes the PRIOR root to this subcollection first.
//       rollbackTvConfig copies a chosen version back to root.
//
// Keys we maintain on the root doc to make the above work:
//   publishedVersion: integer counter, +1 on each transition.
//   publishedAt:      serverTimestamp of the last transition.
//   publishedBy:      who triggered it.
//   draftSnapshot:    null | {full payload of pending edits}.
//   draftSavedAt:     serverTimestamp of the most recent draft save.
//   draftSavedBy:     who saved the draft.
//
// Backward compat: existing docs have no publishedVersion. The
// transaction defaults to 0 in that case, so the first save under the
// new flow becomes v1. MenuDisplay reads the root doc — same as before
// — so live TVs continue working without any client-side change.

// Fields that belong to the DRAFT layer, not the published layer.
// We strip these before archiving / restoring so draft state doesn't
// leak across version boundaries.
const DRAFT_ONLY_FIELDS = ['draftSnapshot', 'draftSavedAt', 'draftSavedBy'];
function stripDraftLayer(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = { ...obj };
    for (const k of DRAFT_ONLY_FIELDS) delete out[k];
    return out;
}

// Sanitize the tvId the way the rest of this file expects (matches
// saveTvConfig's previous behavior).
function normalizeTvId(tvId) {
    return String(tvId || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .slice(0, 48) || 'tv';
}

export async function saveTvConfig({ tvId, payload, byName }) {
    if (!tvId) throw new Error('tvId required');
    const cleanId = normalizeTvId(tvId);
    const rootRef = doc(db, COLLECTION, cleanId);

    // Atomic save + archive. Done in a single transaction so we
    // can't end up with a partially-archived state (e.g. version
    // doc written but root not updated, or vice versa). If the
    // doc didn't exist before, there's nothing to archive — the
    // version counter starts at 1 with no v0 row, which is the
    // correct "this is the first publish" representation.
    let nextVersion = 1;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(rootRef);
        const prev = snap.exists() ? snap.data() : null;
        const prevVersion = Number(prev?.publishedVersion || 0);
        nextVersion = prevVersion + 1;

        // Archive the prior published state before we overwrite it.
        // Strip the draft layer + the published markers (those are
        // ABOUT the version, not part of it).
        if (prev) {
            const versionRef = doc(db, COLLECTION, cleanId, VERSIONS_SUBCOLLECTION, `v${prevVersion || 0}`);
            const archive = stripDraftLayer(prev);
            delete archive.publishedAt;
            delete archive.publishedBy;
            delete archive.publishedVersion;
            tx.set(versionRef, {
                ...archive,
                version: prevVersion,
                supersededAt: serverTimestamp(),
                supersededBy: byName || null,
                reason: 'live_save',
            });
        }

        // Write the new root. We DON'T merge here on purpose —
        // a live save replaces the published layer wholesale, so
        // removing a field (e.g. clearing an imageUrls array via
        // omission) actually clears. Draft fields are preserved
        // by reading them off prev and re-attaching, otherwise
        // saving a live edit while there's an unrelated pending
        // draft would silently wipe the draft.
        const draftFields = {};
        if (prev?.draftSnapshot)  draftFields.draftSnapshot  = prev.draftSnapshot;
        if (prev?.draftSavedAt)   draftFields.draftSavedAt   = prev.draftSavedAt;
        if (prev?.draftSavedBy)   draftFields.draftSavedBy   = prev.draftSavedBy;
        tx.set(rootRef, {
            ...stripDraftLayer(payload || {}),
            tvId: cleanId,
            updatedAt: serverTimestamp(),
            updatedBy: byName || null,
            publishedVersion: nextVersion,
            publishedAt: serverTimestamp(),
            publishedBy: byName || null,
            ...draftFields,
        });
    });

    recordAudit({
        action: 'tv_config.save',
        actorName: byName || 'admin',
        targetType: 'tv_config',
        targetId: cleanId,
        details: {
            label: payload?.label,
            location: payload?.location,
            layout: payload?.layout,
            version: nextVersion,
        },
    });
}

// ── Draft layer ─────────────────────────────────────────────────────────
// Writes go to the `draftSnapshot` field on the root doc. The published
// layer stays untouched, so live TVs continue showing the previously-
// published state. publishTvConfigDraft promotes the draft to live; the
// existing saveTvConfig flow above continues to "publish immediately"
// for users who don't opt into the draft workflow.

export async function saveTvConfigDraft({ tvId, payload, byName }) {
    if (!tvId) throw new Error('tvId required');
    const cleanId = normalizeTvId(tvId);
    const rootRef = doc(db, COLLECTION, cleanId);
    // Use merge=true so the draftSnapshot doesn't accidentally clear
    // published fields. The snapshot ITSELF is wholesale-replaced
    // (the payload that came in is the complete next-state).
    await setDoc(rootRef, {
        draftSnapshot: stripDraftLayer(payload || {}),
        draftSavedAt: serverTimestamp(),
        draftSavedBy: byName || null,
    }, { merge: true });
    recordAudit({
        action: 'tv_config.draft.save',
        actorName: byName || 'admin',
        targetType: 'tv_config',
        targetId: cleanId,
        details: { label: payload?.label, layout: payload?.layout },
    });
}

export async function publishTvConfigDraft({ tvId, byName }) {
    if (!tvId) throw new Error('tvId required');
    const cleanId = normalizeTvId(tvId);
    const rootRef = doc(db, COLLECTION, cleanId);
    let nextVersion = 1;
    let snapshotPublished = null;
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(rootRef);
        if (!snap.exists()) throw new Error('TV config not found');
        const prev = snap.data();
        const draft = prev.draftSnapshot;
        if (!draft || typeof draft !== 'object') throw new Error('No draft to publish');
        const prevVersion = Number(prev.publishedVersion || 0);
        nextVersion = prevVersion + 1;
        // Archive the OLD published state to versions, then promote
        // the draft to live + clear the draft fields. Same atomic
        // pattern as saveTvConfig.
        if (prev) {
            const versionRef = doc(db, COLLECTION, cleanId, VERSIONS_SUBCOLLECTION, `v${prevVersion}`);
            const archive = stripDraftLayer(prev);
            delete archive.publishedAt;
            delete archive.publishedBy;
            delete archive.publishedVersion;
            tx.set(versionRef, {
                ...archive,
                version: prevVersion,
                supersededAt: serverTimestamp(),
                supersededBy: byName || null,
                reason: 'publish_draft',
            });
        }
        snapshotPublished = draft;
        tx.set(rootRef, {
            ...stripDraftLayer(draft),
            tvId: cleanId,
            updatedAt: serverTimestamp(),
            updatedBy: byName || null,
            publishedVersion: nextVersion,
            publishedAt: serverTimestamp(),
            publishedBy: byName || null,
            // Explicit deletes so the next snapshot reader sees a
            // clean "no draft" state.
            draftSnapshot: deleteField(),
            draftSavedAt:  deleteField(),
            draftSavedBy:  deleteField(),
        });
    });
    recordAudit({
        action: 'tv_config.publish_draft',
        actorName: byName || 'admin',
        targetType: 'tv_config',
        targetId: cleanId,
        details: { version: nextVersion, label: snapshotPublished?.label },
    });
}

export async function discardTvConfigDraft({ tvId, byName }) {
    if (!tvId) throw new Error('tvId required');
    const cleanId = normalizeTvId(tvId);
    await setDoc(doc(db, COLLECTION, cleanId), {
        draftSnapshot: deleteField(),
        draftSavedAt:  deleteField(),
        draftSavedBy:  deleteField(),
    }, { merge: true });
    recordAudit({
        action: 'tv_config.discard_draft',
        actorName: byName || 'admin',
        targetType: 'tv_config',
        targetId: cleanId,
    });
}

// ── Rollback ───────────────────────────────────────────────────────────
// Restore a previous version doc to root. Same archive-then-overwrite
// pattern as saveTvConfig — the CURRENT live state gets archived as a
// new version row before being replaced, so rollback itself is
// reversible.

export async function rollbackTvConfig({ tvId, versionId, byName }) {
    if (!tvId || !versionId) throw new Error('tvId + versionId required');
    const cleanId = normalizeTvId(tvId);
    const rootRef = doc(db, COLLECTION, cleanId);
    const versionRef = doc(db, COLLECTION, cleanId, VERSIONS_SUBCOLLECTION, versionId);
    let nextVersion = 1;
    let restoredFrom = null;
    await runTransaction(db, async (tx) => {
        const [rootSnap, verSnap] = await Promise.all([tx.get(rootRef), tx.get(versionRef)]);
        if (!verSnap.exists()) throw new Error('Version not found');
        const verData = verSnap.data();
        restoredFrom = verData;
        if (rootSnap.exists()) {
            const prev = rootSnap.data();
            const prevVersion = Number(prev.publishedVersion || 0);
            nextVersion = prevVersion + 1;
            const archiveRef = doc(db, COLLECTION, cleanId, VERSIONS_SUBCOLLECTION, `v${prevVersion}`);
            const archive = stripDraftLayer(prev);
            delete archive.publishedAt;
            delete archive.publishedBy;
            delete archive.publishedVersion;
            tx.set(archiveRef, {
                ...archive,
                version: prevVersion,
                supersededAt: serverTimestamp(),
                supersededBy: byName || null,
                reason: 'rollback',
                rolledBackTo: versionId,
            });
        }
        // Restore — strip the version's metadata + draft fields.
        const restore = stripDraftLayer({ ...verData });
        delete restore.version;
        delete restore.supersededAt;
        delete restore.supersededBy;
        delete restore.reason;
        delete restore.rolledBackTo;
        tx.set(rootRef, {
            ...restore,
            tvId: cleanId,
            updatedAt: serverTimestamp(),
            updatedBy: byName || null,
            publishedVersion: nextVersion,
            publishedAt: serverTimestamp(),
            publishedBy: byName || null,
            draftSnapshot: deleteField(),
            draftSavedAt:  deleteField(),
            draftSavedBy:  deleteField(),
        });
    });
    recordAudit({
        action: 'tv_config.rollback',
        actorName: byName || 'admin',
        targetType: 'tv_config',
        targetId: cleanId,
        details: { from: versionId, asVersion: nextVersion, label: restoredFrom?.label },
    });
}

// ── Version history subscription ──────────────────────────────────────
// Powers the dashboard's "History" modal. Returns the N most recent
// version docs, newest-first. We don't paginate — restaurants change
// menus on the order of weeks, not seconds, so 30 entries is a deep
// rollback window. Adjust if a restaurant proves us wrong.
export function subscribeTvConfigVersions(tvId, cb, max = 30) {
    if (!tvId) { cb([]); return () => {}; }
    const cleanId = normalizeTvId(tvId);
    const q = query(
        collection(db, COLLECTION, cleanId, VERSIONS_SUBCOLLECTION),
        orderBy('version', 'desc'),
        fsLimit(max),
    );
    const unsub = onSnapshot(q, (snap) => {
        const out = [];
        snap.forEach(d => out.push({ id: d.id, ...d.data() }));
        cb(out);
    }, (err) => {
        console.warn('tv_config versions subscription failed:', err);
        cb([]);
    });
    return unsub;
}

export async function deleteTvConfig({ tvId, byName }) {
    if (!tvId) throw new Error('tvId required');
    await deleteDoc(doc(db, COLLECTION, tvId));
    recordAudit({
        action: 'tv_config.delete',
        actorName: byName || 'admin',
        targetType: 'tv_config',
        targetId: tvId,
        details: {},
    });
}
