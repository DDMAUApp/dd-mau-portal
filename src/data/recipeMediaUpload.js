// Upload one photo / video for a recipe line (RecipeForm) + clean-up of
// uploads the editor abandons. The camera-crash recipe applies
// (project memory 2026-09-01): photos are downsampled natively to 2000px
// BEFORE anything else touches them; videos upload as-is (≤250MB, same cap
// as chat) and the media Cloud Function makes the phone-friendly 720p copy.
import { db, storage } from '../firebase';
import { ref as sref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { doc, setDoc as _fsSetDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { watchdogWrite } from './firestoreRevive';
import { fileToScaledBlobWithDims } from './parseReceipt';
import { probeVideo } from './videoProbe';
import { normalizeVideoMime } from '../components/ChatMedia';
import { newMediaId, mediaPathFor } from './recipeMedia';

const setDoc = (...a) => watchdogWrite(_fsSetDoc(...a));

export const MAX_RECIPE_VIDEO_BYTES = 250 * 1024 * 1024;   // storage.rules recipe_media cap
const MAX_RAW_IMAGE_BYTES = 15 * 1024 * 1024;

const VIDEO_EXT = /\.(mov|mp4|m4v|webm|3gp|3g2|mkv)$/i;
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif)$/i;

export function mediaKindOf(file) {
    const type = String(file?.type || '');
    const name = String(file?.name || '');
    if (type.startsWith('video/') || VIDEO_EXT.test(name)) return 'video';
    if (type.startsWith('image/') || IMAGE_EXT.test(name)) return 'image';
    return null;
}

function putFile(path, blob, contentType, { onProgress, onTask } = {}) {
    const r = sref(storage, path);
    const task = uploadBytesResumable(r, blob, { contentType, cacheControl: 'public, max-age=31536000' });
    onTask?.(task);
    return new Promise((resolve, reject) => {
        task.on('state_changed', (snap) => {
            if (snap.totalBytes > 0) onProgress?.(Math.round((snap.bytesTransferred / snap.totalBytes) * 100));
        }, reject, () => resolve(getDownloadURL(r)));
    });
}

// Returns the media item to store on the recipe. Throws Error('unsupported'
// | 'too_big' | …) — the caller toasts.
export async function uploadRecipeMedia(file, { staffName, onProgress, onTask } = {}) {
    const kind = mediaKindOf(file);
    if (!kind) throw new Error('unsupported');
    const id = newMediaId();
    if (kind === 'image') {
        let blob = file, w, h;
        try {
            const r = await fileToScaledBlobWithDims(file, 2000, 0.85);
            blob = r.blob; w = r.width; h = r.height;
        } catch (e) {
            // Undecodable here (rare HEIC on old WebViews) — upload the
            // original if it's a sane size, like the other photo flows.
            if (file.size > MAX_RAW_IMAGE_BYTES) throw new Error('too_big');
        }
        const path = mediaPathFor(id, 'image');
        const url = await putFile(path, blob, blob === file ? (file.type || 'image/jpeg') : 'image/jpeg', { onProgress, onTask });
        return { id, kind, url, path, ...(w ? { w, h } : {}) };
    }
    if (file.size > MAX_RECIPE_VIDEO_BYTES) throw new Error('too_big');
    const meta = await probeVideo(file);
    const path = mediaPathFor(id, 'video', file.name);
    const url = await putFile(path, file, normalizeVideoMime(file.type, file.name), { onProgress, onTask });
    const item = {
        id, kind, url, path,
        ...(meta.width ? { w: meta.width, h: meta.height } : {}),
        ...(meta.duration ? { dur: meta.duration } : {}),
    };
    if (meta.posterBlob) {
        try {
            const thumbPath = `recipe_media/${id}_thumb.jpg`;
            item.thumbUrl = await putFile(thumbPath, meta.posterBlob, 'image/jpeg');
            item.thumbPath = thumbPath;
        } catch (e) {
            console.warn('recipe video poster upload failed (non-fatal):', e);
        }
    }
    // Ask the media Cloud Function for the phone-friendly copy. Non-fatal:
    // the original still plays on most phones (and in the browser).
    try {
        await setDoc(doc(db, 'recipe_media', id), {
            type: 'video', mediaPath: path, mediaUrl: url,
            createdAt: serverTimestamp(), byName: staffName || 'unknown',
        });
    } catch (e) {
        console.warn('recipe_media job doc failed (video still saved):', e);
    }
    return item;
}

// The Cloud Function's result for one video (or null). Cached per id for
// the session; a still-processing answer is re-asked after 30s.
const _results = new Map();   // id → { at, promise }
export function fetchVideoResult(id) {
    if (!id) return Promise.resolve(null);
    const hit = _results.get(id);
    if (hit && (Date.now() - hit.at) < 30000) return hit.promise;
    const promise = Promise.race([
        getDoc(doc(db, 'recipe_media', id)).then(s => (s.exists() ? s.data() : null)),
        new Promise(res => setTimeout(() => res(null), 6000)),
    ]).catch(() => null);
    _results.set(id, { at: Date.now(), promise });
    promise.then(r => { if (r?.playbackUrl || r?.transcodeFailedAt) _results.set(id, { at: Infinity, promise }); });
    return promise;
}

// Best-effort delete of an abandoned upload (the editor's ✕ on something it
// uploaded this session, or Cancel). Never throws.
export async function deleteRecipeMediaFiles(item) {
    if (!item?.path || !item.path.startsWith('recipe_media/')) return;
    const base = item.path.replace(/\.[^.]+$/, '');
    const paths = [item.path, item.thumbPath, ...(item.kind === 'video' ? [`${base}_720.mp4`, `${base}_poster.jpg`] : [])].filter(Boolean);
    await Promise.all(paths.map(p => deleteObject(sref(storage, p)).catch(() => {})));
}
