// firebase/storage, as the app sees it (aliased in vite.config.js). Outside
// test mode every export is the real SDK. In TEST MODE uploads never leave
// the device: the bytes stay in memory as an object URL (so the photo /
// video / PDF still shows everywhere it was just attached) and deletes are
// no-ops. Reads of files that already exist go to the real bucket.
import * as st from '@firebase/storage';
import { TEST_MODE } from '../data/testMode';

export * from '@firebase/storage';

const T = !!TEST_MODE;
const _files = new Map();   // fullPath -> { blob, url, contentType }

function toBlob(data, contentType) {
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
    return new Blob([data], contentType ? { type: contentType } : undefined);
}

function keep(ref, data, metadata) {
    const contentType = metadata?.contentType || (data && data.type) || '';
    const blob = toBlob(data, contentType);
    const prev = _files.get(ref.fullPath);
    if (prev) { try { URL.revokeObjectURL(prev.url); } catch { /* ignore */ } }
    const url = URL.createObjectURL(blob);
    _files.set(ref.fullPath, { blob, url, contentType: contentType || blob.type });
    return {
        ref,
        metadata: {
            fullPath: ref.fullPath, name: ref.name, bucket: ref.bucket,
            size: blob.size, contentType: contentType || blob.type,
            timeCreated: new Date().toISOString(), updated: new Date().toISOString(),
            customMetadata: metadata?.customMetadata || {},
        },
    };
}

function stringToBlob(value, format, contentType) {
    if (format === 'data_url') {
        const [head, body = ''] = String(value).split(',');
        const type = (head.match(/data:([^;]+)/) || [])[1] || contentType;
        const isB64 = /;base64/.test(head);
        const bin = isB64 ? atob(body) : decodeURIComponent(body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], type ? { type } : undefined);
    }
    if (format === 'base64' || format === 'base64url') {
        const b64 = format === 'base64url' ? String(value).replace(/-/g, '+').replace(/_/g, '/') : String(value);
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], contentType ? { type: contentType } : undefined);
    }
    return new Blob([String(value)], { type: contentType || 'text/plain' });
}

// Minimal UploadTask: progress observers get one 100% snapshot, then done.
function fakeTask(ref, data, metadata) {
    const res = keep(ref, data, metadata);
    const snapshot = {
        bytesTransferred: res.metadata.size,
        totalBytes: res.metadata.size,
        state: 'success',
        ref,
        metadata: res.metadata,
        task: null,
    };
    const done = Promise.resolve(snapshot);
    const task = {
        snapshot,
        on(_event, next, error, complete) {
            const obs = next && typeof next === 'object' ? next : { next, error, complete };
            setTimeout(() => {
                try { obs.next?.(snapshot); } catch { /* observer threw */ }
                try { obs.complete?.(); } catch { /* observer threw */ }
            }, 0);
            return () => {};
        },
        then: (onOk, onErr) => done.then(onOk, onErr),
        catch: (onErr) => done.catch(onErr),
        cancel: () => false,
        pause: () => false,
        resume: () => false,
    };
    snapshot.task = task;
    return task;
}

const tUploadBytes = async (ref, data, metadata) => keep(ref, data, metadata);
const tUploadString = async (ref, value, format = 'raw', metadata) => keep(ref, stringToBlob(value, format, metadata?.contentType), metadata);
const tUploadBytesResumable = (ref, data, metadata) => fakeTask(ref, data, metadata);
const tDeleteObject = async (ref) => {
    const hit = _files.get(ref.fullPath);
    if (hit) { try { URL.revokeObjectURL(hit.url); } catch { /* ignore */ } _files.delete(ref.fullPath); }
};
// Hire paperwork (W-4 / I-9 / direct deposit), applications and health
// documents never open in test mode — the tester has owner-level UI access.
const PRIVATE_PREFIX_RE = /^(onboarding|applications|health)\//;
function privateRefused(ref) {
    const e = new Error('Test mode — private documents are not available.');
    e.code = 'storage/unauthorized';
    e.path = ref?.fullPath;
    return Promise.reject(e);
}
const isPrivate = (ref) => PRIVATE_PREFIX_RE.test(String(ref?.fullPath || ''));

const tGetDownloadURL = (ref) => {
    const hit = _files.get(ref.fullPath);
    if (hit) return Promise.resolve(hit.url);
    return isPrivate(ref) ? privateRefused(ref) : st.getDownloadURL(ref);
};
const tGetBytes = (ref, maxDownloadSizeBytes) => {
    const hit = _files.get(ref.fullPath);
    if (hit) return hit.blob.arrayBuffer();
    return isPrivate(ref) ? privateRefused(ref) : st.getBytes(ref, maxDownloadSizeBytes);
};
const tGetBlob = (ref, maxDownloadSizeBytes) => {
    const hit = _files.get(ref.fullPath);
    if (hit) return Promise.resolve(hit.blob);
    return isPrivate(ref) ? privateRefused(ref) : st.getBlob(ref, maxDownloadSizeBytes);
};
const tGetMetadata = (ref) => {
    const hit = _files.get(ref.fullPath);
    if (hit) return Promise.resolve({ fullPath: ref.fullPath, name: ref.name, size: hit.blob.size, contentType: hit.contentType });
    return isPrivate(ref) ? privateRefused(ref) : st.getMetadata(ref);
};
const tListAll = (ref) => (isPrivate(ref) || /^(onboarding|applications|health)$/.test(String(ref?.fullPath || ''))
    ? Promise.resolve({ items: [], prefixes: [] })
    : st.listAll(ref));
const tUpdateMetadata = async (ref, metadata) => ({ fullPath: ref.fullPath, name: ref.name, ...metadata });

export const uploadBytes = T ? tUploadBytes : st.uploadBytes;
export const uploadString = T ? tUploadString : st.uploadString;
export const uploadBytesResumable = T ? tUploadBytesResumable : st.uploadBytesResumable;
export const deleteObject = T ? tDeleteObject : st.deleteObject;
export const getDownloadURL = T ? tGetDownloadURL : st.getDownloadURL;
export const getBytes = T ? tGetBytes : st.getBytes;
export const getBlob = T ? tGetBlob : st.getBlob;
export const getMetadata = T ? tGetMetadata : st.getMetadata;
export const updateMetadata = T ? tUpdateMetadata : st.updateMetadata;
export const listAll = T ? tListAll : st.listAll;
