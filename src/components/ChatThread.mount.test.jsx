// Mount smoke test for ChatThread (2026-09-25 chat review + media batch).
// ChatThread is one ~6k-line component; a hook that reads state declared
// BELOW it crashes the thread on every open and the build does not catch it.
// This mounts the REAL component with Firebase mocked (no network, no
// writes leave the test) and drives the messages listener:
//   • first paint of text / photo / video / voice / deleted messages
//   • a video's server transcode landing as an UPDATE (poster + 720p copy)
//     must re-render its bubble (msgFieldsEqual media fields)
//   • a new incoming message, and a jump-to-message request
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const listeners = [];           // { path, wheres, cb }
vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => {
    const pathOf = (x) => (x && x.path) || 'unknown';
    class FieldPath { constructor(...segs) { this.segs = segs; } }
    return {
        FieldPath,
        doc: vi.fn((base, ...segs) => ({ path: segs.length ? [pathOf(base) === 'unknown' ? null : pathOf(base), ...segs].filter(Boolean).join('/') : `${pathOf(base)}/auto`, id: segs[segs.length - 1] || 'auto' })),
        collection: vi.fn((_db, ...segs) => ({ path: segs.join('/') })),
        query: vi.fn((c, ...cons) => ({ path: pathOf(c), wheres: cons.filter(x => x && x.__where) })),
        where: vi.fn((f, op, v) => ({ __where: [f, op, v] })),
        orderBy: vi.fn(() => ({})), limit: vi.fn(() => ({})),
        onSnapshot: vi.fn((ref, a, b) => {
            const cb = typeof a === 'function' ? a : b;
            const entry = { path: pathOf(ref), wheres: ref.wheres || [], cb };
            listeners.push(entry);
            return () => { const i = listeners.indexOf(entry); if (i >= 0) listeners.splice(i, 1); };
        }),
        setDoc: vi.fn(async () => {}), updateDoc: vi.fn(async () => {}), deleteDoc: vi.fn(async () => {}),
        addDoc: vi.fn(async () => ({ id: 'new' })),
        getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}), metadata: { fromCache: false } })),
        getDocs: vi.fn(async () => ({ docs: [], empty: true, size: 0, forEach: () => {}, metadata: { fromCache: false } })),
        getDocsFromServer: vi.fn(async () => ({ docs: [], empty: true, size: 0, forEach: () => {}, metadata: { fromCache: false } })),
        getDocFromServer: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
        getDocFromCache: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
        getCountFromServer: vi.fn(async () => ({ data: () => ({ count: 0 }) })),
        disableNetwork: vi.fn(async () => {}), enableNetwork: vi.fn(async () => {}),
        runTransaction: vi.fn(async (_db, fn) => fn({ get: async () => ({ exists: () => false, data: () => ({}) }), update: () => {}, set: () => {} })),
        writeBatch: vi.fn(() => ({ set: vi.fn(), update: vi.fn(), delete: vi.fn(), commit: vi.fn(async () => {}) })),
        deleteField: vi.fn(() => ({ __op: 'delete' })),
        arrayUnion: vi.fn((...v) => ({ __op: 'union', v })), arrayRemove: vi.fn((...v) => ({ __op: 'remove', v })),
        increment: vi.fn((n) => ({ __op: 'inc', n })),
        serverTimestamp: vi.fn(() => ({ __op: 'ts' })),
        Timestamp: { now: () => ts(Date.now()), fromDate: (d) => ts(d.getTime()), fromMillis: (m) => ts(m) },
    };
});
vi.mock('firebase/storage', () => ({ ref: vi.fn(() => ({})), uploadBytesResumable: vi.fn(), getDownloadURL: vi.fn(async () => 'u'), deleteObject: vi.fn(async () => {}) }));
vi.mock('../capacitor-bridge', () => ({ openExternalUrl: vi.fn(), pushBackHandler: vi.fn(() => () => {}), isNative: () => false }));
vi.mock('../toast', () => ({ toast: vi.fn(), undoToast: vi.fn() }));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));

function ts(ms) { return { toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), nanoseconds: 0 }; }
HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (!globalThis.IntersectionObserver) globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function () {};

import ChatThread from './ChatThread';

const T0 = Date.UTC(2026, 8, 25, 15, 0, 0);
const base = (id, min, extra) => ({ id, senderName: 'Maria Lopez', createdAt: ts(T0 + min * 60000), reactions: {}, ...extra });
let MSGS;
function snapOf(list, fromCache = false) {
    const newestFirst = [...list].sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
    const doc = (m) => ({ id: m.id, data: () => { const { id, ...rest } = m; return rest; }, get: (k) => m[k], exists: () => true, metadata: { hasPendingWrites: false } });
    return {
        metadata: { fromCache, hasPendingWrites: false },
        size: newestFirst.length, empty: !newestFirst.length,
        docs: newestFirst.map(doc),
        forEach: (fn) => newestFirst.forEach(m => fn(doc(m))),
        docChanges: () => newestFirst.map(m => ({ type: 'modified', doc: doc(m) })),
    };
}
function emitMessages(list) {
    const ls = listeners.filter(l => l.path === 'chats/c1/messages' && l.wheres.length === 0);
    act(() => { ls.forEach(l => l.cb(snapOf(list))); });
    return ls.length;
}

const chat = {
    id: 'c1', type: 'group', name: 'Webster FOH', members: ['Maria Lopez', 'Andrew Shih'], admins: ['Andrew Shih'],
    editTier: 'admins', lastActivityAt: ts(T0 + 10 * 60000), lastReadByName: {}, createdBy: 'Andrew Shih',
};
const staffList = [{ id: 40, name: 'Andrew Shih', role: 'Owner' }, { id: 7, name: 'Maria Lopez', role: 'FOH' }];

beforeEach(() => {
    listeners.length = 0;
    MSGS = [
        base('t1', 1, { type: 'text', text: 'Morning team' }),
        base('p1', 2, { type: 'image', mediaUrl: 'https://x/p.jpg', width: 1200, height: 1600 }),
        base('v1', 3, { type: 'video', mediaUrl: 'https://x/v.mov', duration: 69, width: 1080, height: 1920 }),
        base('a1', 4, { type: 'audio', mediaUrl: 'https://x/a.webm', playbackUrl: 'https://x/a_aac.m4a', duration: 5 }),
        base('d1', 5, { type: 'text', text: 'oops', deleted: true }),
        base('t2', 6, { type: 'text', text: 'Last message here', senderName: 'Andrew Shih' }),
    ];
});

function mount(props = {}) {
    return render(
        <ChatThread chat={chat} language="en" staffName="Andrew Shih" staffList={staffList}
            isAdmin isManager viewer={staffList[0]} viewerTier="admin"
            jumpToMessageId={null} onBack={() => {}} onOpenSettings={() => {}} {...props} />,
    );
}

describe('ChatThread mount (real component, Firebase mocked)', () => {
    it('mounts and paints every message kind', () => {
        const { container } = mount();
        expect(emitMessages(MSGS)).toBeGreaterThan(0);
        expect(screen.getByText('Morning team')).toBeTruthy();
        expect(screen.getByText('Last message here')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Play video' })).toBeTruthy();   // poster tile, no inline <video>
        expect(container.querySelector('video')).toBeNull();
        const photo = [...container.querySelectorAll('img')].find(i => i.getAttribute('src') === 'https://x/p.jpg');
        expect(photo).toBeTruthy();
        expect(photo.style.aspectRatio).toBe(String(3 / 4));                    // portrait kept, not 4:3
        const audio = container.querySelector('audio');
        expect(audio && audio.getAttribute('src')).toBe('https://x/a_aac.m4a');   // AAC copy preferred
        expect(container.querySelector('#msg-d1')).toBeTruthy();                   // deleted row is jumpable (#2)
    });

    it('a finished transcode (UPDATE on the message) re-renders the video bubble', () => {
        const { container } = mount();
        emitMessages(MSGS);
        expect([...container.querySelectorAll('img')].some(i => i.getAttribute('src') === 'https://x/v_poster.jpg')).toBe(false);
        const updated = MSGS.map(m => (m.id === 'v1'
            ? { ...m, playbackUrl: 'https://x/v_720.mp4', thumbnailUrl: 'https://x/v_poster.jpg', playbackWidth: 720, playbackHeight: 1280 }
            : m));
        emitMessages(updated);
        expect([...container.querySelectorAll('img')].some(i => i.getAttribute('src') === 'https://x/v_poster.jpg')).toBe(true);
    });

    it('takes a new incoming message and a jump request without crashing', () => {
        const { rerender } = mount();
        emitMessages(MSGS);
        emitMessages([...MSGS, base('t3', 7, { type: 'text', text: 'New one' })]);
        expect(screen.getByText('New one')).toBeTruthy();
        rerender(
            <ChatThread chat={chat} language="en" staffName="Andrew Shih" staffList={staffList}
                isAdmin isManager viewer={staffList[0]} viewerTier="admin"
                jumpToMessageId="t1" onBack={() => {}} onOpenSettings={() => {}} />,
        );
        emitMessages([...MSGS, base('t3', 7, { type: 'text', text: 'New one' })]);
        expect(screen.getByText('Morning team')).toBeTruthy();
    });
});
