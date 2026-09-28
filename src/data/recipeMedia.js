// recipeMedia.js — photos / videos on recipe lines + the Prep vs Cook-to-order
// sections (Andrew 2026-09-28: "in recipes i want to be able to add pictures
// and videos in the instructions and ingredients. it will be better
// training. also maybe in a recipe i can make a prep section and a service
// cooking to order section").
//
// STORAGE IS ADDITIVE — the existing plain-string lists stay exactly as they
// were (scaling, search, print, stickers, the AI index all read them):
//   ingredientsEn/Es + instructionsEn/Es            = Prep (or the only section)
//   serviceIngredientsEn/Es + serviceInstructionsEn/Es = Cook to order (optional)
//   media = { ing|step|svcIng|svcStep: { "<line index>": [item, …] } }
// Firestore can't nest arrays, hence index-keyed maps of item arrays.
// Media is anchored to the ENGLISH line index and shows in both languages
// (the EN/ES lists are line-for-line translations of each other).
//
// item = { id, kind: 'image'|'video', url, path, w, h,
//          dur?, thumbUrl?, thumbPath?, playbackUrl?, posterUrl? }
// Videos also get a recipe_media/{id} doc; the media Cloud Function writes
// the phone-friendly 720p copy (playbackUrl) + poster onto THAT doc (it never
// touches config/recipes). The app reads it lazily and copies it into the
// recipe on the next save.

export const MEDIA_KEYS = ['ing', 'step', 'svcIng', 'svcStep'];

// Which media bucket an editor list field feeds (ES fields have none).
export const FIELD_MEDIA_KEY = {
    ingredientsEn: 'ing',
    instructionsEn: 'step',
    serviceIngredientsEn: 'svcIng',
    serviceInstructionsEn: 'svcStep',
};

export const SERVICE_FIELDS = ['serviceIngredientsEn', 'serviceIngredientsEs', 'serviceInstructionsEn', 'serviceInstructionsEs'];

const nonBlank = (arr) => Array.isArray(arr) && arr.some(s => String(s ?? '').trim());

export function hasServiceSection(recipe) {
    return !!recipe && SERVICE_FIELDS.some(f => nonBlank(recipe[f]));
}

// Items on one line (always an array).
export function mediaAt(media, key, idx) {
    const list = media?.[key]?.[String(idx)];
    return Array.isArray(list) ? list.filter(it => it && it.url) : [];
}

export function mediaCount(media) {
    let n = 0;
    for (const k of MEDIA_KEYS) for (const list of Object.values(media?.[k] || {})) n += Array.isArray(list) ? list.length : 0;
    return n;
}

// Rebuild one bucket by mapping old index → new index (null = drop).
function remapBucket(bucket, mapIdx) {
    const out = {};
    for (const [k, list] of Object.entries(bucket || {})) {
        const i = Number(k);
        if (!Number.isInteger(i) || !Array.isArray(list) || !list.length) continue;
        const j = mapIdx(i);
        if (j == null || j < 0) continue;
        out[String(j)] = [...(out[String(j)] || []), ...list];
    }
    return out;
}

function withBucket(media, key, bucket) {
    const next = { ...(media || {}) };
    if (Object.keys(bucket).length) next[key] = bucket;
    else delete next[key];
    return next;
}

// Row idx removed from the anchor list: its media goes, later rows shift up.
export function shiftMediaOnRemove(media, key, idx) {
    if (!key || !media?.[key]) return media || {};
    return withBucket(media, key, remapBucket(media[key], i => (i === idx ? null : i > idx ? i - 1 : i)));
}

// Row idx replaced by `count` rows (multi-line paste): its media stays on the
// first of them, later rows shift down by count-1.
export function shiftMediaOnSplice(media, key, idx, count) {
    if (!key || !media?.[key] || count === 1) return media || {};
    return withBucket(media, key, remapBucket(media[key], i => (i > idx ? i + count - 1 : i)));
}

export function addMediaItem(media, key, idx, item) {
    const bucket = { ...(media?.[key] || {}) };
    bucket[String(idx)] = [...(bucket[String(idx)] || []), item];
    return { ...(media || {}), [key]: bucket };
}

export function removeMediaItem(media, key, idx, id) {
    const bucket = { ...(media?.[key] || {}) };
    const list = (bucket[String(idx)] || []).filter(it => it.id !== id);
    if (list.length) bucket[String(idx)] = list; else delete bucket[String(idx)];
    return withBucket(media, key, bucket);
}

// Save-time compaction: blank lines are dropped from the list, so media
// indices must follow their line. Returns the cleaned list + bucket, and the
// 1-based numbers of blank lines that carried media (the form refuses to
// save those — a photo with no words under it would silently vanish).
export function compactListWithMedia(list, bucket) {
    const src = Array.isArray(list) ? list : [];
    const out = [];
    const newIdx = new Map();
    const blankWithMedia = [];
    src.forEach((s, i) => {
        const text = String(s ?? '').trim();
        const has = Array.isArray(bucket?.[String(i)]) && bucket[String(i)].length > 0;
        if (!text) { if (has) blankWithMedia.push(i + 1); return; }
        newIdx.set(i, out.length);
        out.push(text);
    });
    const nextBucket = remapBucket(bucket, i => (newIdx.has(i) ? newIdx.get(i) : null));
    return { list: out, bucket: nextBucket, blankWithMedia };
}

// Every media item in a recipe (flat) — used to copy server-side video
// results in on save and to find uploads to clean up on cancel.
export function allMediaItems(media) {
    const out = [];
    for (const k of MEDIA_KEYS) for (const list of Object.values(media?.[k] || {})) if (Array.isArray(list)) out.push(...list);
    return out;
}

// Copy the Cloud Function's results (from recipe_media/{id}) onto matching
// video items that don't have them yet. `byId` = { [id]: docData }.
export function applyVideoResults(media, byId) {
    if (!media || !byId) return media;
    let changed = false;
    const next = {};
    for (const [k, bucket] of Object.entries(media)) {
        const nb = {};
        for (const [i, list] of Object.entries(bucket || {})) {
            nb[i] = (list || []).map(it => {
                const r = it?.kind === 'video' && !it.playbackUrl ? byId[it.id] : null;
                if (!r || !r.playbackUrl) return it;
                changed = true;
                return {
                    ...it,
                    playbackUrl: r.playbackUrl,
                    ...(r.posterUrl ? { posterUrl: r.posterUrl } : {}),
                    ...(!it.thumbUrl && (r.thumbnailUrl || r.posterUrl) ? { thumbUrl: r.thumbnailUrl || r.posterUrl } : {}),
                    ...(r.playbackWidth ? { w: r.playbackWidth, h: r.playbackHeight } : {}),
                };
            });
        }
        next[k] = nb;
    }
    return changed ? next : media;
}

// Storage object names — flat under recipe_media/ (the transcode writes its
// _720.mp4 / _poster.jpg next to the original).
export function newMediaId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
export function mediaPathFor(id, kind, filename) {
    if (kind === 'image') return `recipe_media/${id}.jpg`;
    const name = String(filename || '');
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return `recipe_media/${id}.${/^[a-z0-9]{2,4}$/.test(ext) ? ext : 'mp4'}`;
}
