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
} from 'firebase/firestore';
import { recordAudit } from './audit';

const COLLECTION = 'tv_configs';

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

export async function saveTvConfig({ tvId, payload, byName }) {
    if (!tvId) throw new Error('tvId required');
    const cleanId = String(tvId)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .slice(0, 48) || 'tv';
    const data = {
        ...payload,
        tvId: cleanId,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    };
    await setDoc(doc(db, COLLECTION, cleanId), data, { merge: true });
    recordAudit({
        action: 'tv_config.save',
        actorName: byName || 'admin',
        targetType: 'tv_config',
        targetId: cleanId,
        details: {
            label: payload?.label,
            location: payload?.location,
            layout: payload?.layout,
        },
    });
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
