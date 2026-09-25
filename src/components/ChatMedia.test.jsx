// ChatMedia — 2026-09-25 (Android couldn't see / full-screen chat videos).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));
// jsdom has no media playback.
HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
const bridge = vi.hoisted(() => ({ opened: [], backs: [] }));
vi.mock('../capacitor-bridge', () => ({
    openExternalUrl: (u) => { bridge.opened.push(u); },
    pushBackHandler: (fn) => { bridge.backs.push(fn); return () => { bridge.backs = bridge.backs.filter(f => f !== fn); }; },
}));

import {
    mediaAspect, formatDuration, videoSources, videoStillProcessing, normalizeVideoMime,
    ChatPhoto, ChatVideoTile, ChatMediaViewer,
} from './ChatMedia';

describe('helpers', () => {
    it('aspect follows the media, clamped 3:4 … 16:9, 4:3 when unknown', () => {
        expect(mediaAspect(1600, 1200)).toBeCloseTo(4 / 3);
        expect(mediaAspect(1200, 1600)).toBeCloseTo(3 / 4);      // portrait no longer forced to 4:3
        expect(mediaAspect(720, 2000)).toBeCloseTo(3 / 4);        // very tall → clamped
        expect(mediaAspect(4000, 1000)).toBeCloseTo(16 / 9);      // panorama → clamped
        expect(mediaAspect(0, 0)).toBeCloseTo(4 / 3);
        expect(mediaAspect(undefined, 100)).toBeCloseTo(4 / 3);
    });
    it('duration badge', () => {
        expect(formatDuration(69)).toBe('1:09');
        expect(formatDuration(5)).toBe('0:05');
        expect(formatDuration(null)).toBe('0:00');
    });
    it('plays the phone-friendly copy first, then the original', () => {
        expect(videoSources({ playbackUrl: 'p', mediaUrl: 'o' })).toEqual(['p', 'o']);
        expect(videoSources({ mediaUrl: 'o' })).toEqual(['o']);
        expect(videoSources({ playbackUrl: 'o', mediaUrl: 'o' })).toEqual(['o']);
    });
    it('"still processing" only for recent, unconverted, not-failed videos', () => {
        const now = 1_000_000_000;
        const at = (msAgo) => ({ toMillis: () => now - msAgo });
        expect(videoStillProcessing({ type: 'video', createdAt: at(60_000) }, now)).toBe(true);
        expect(videoStillProcessing({ type: 'video', createdAt: at(60 * 60_000) }, now)).toBe(false);
        expect(videoStillProcessing({ type: 'video', playbackUrl: 'p', createdAt: at(1) }, now)).toBe(false);
        expect(videoStillProcessing({ type: 'video', transcodeFailedAt: 1, createdAt: at(1) }, now)).toBe(false);
        expect(videoStillProcessing({ type: 'video' }, now)).toBe(true); // pending server timestamp
    });
    it('video upload type is always video/* (storage rule)', () => {
        expect(normalizeVideoMime('video/quicktime', 'a.mov')).toBe('video/quicktime');
        expect(normalizeVideoMime('', 'IMG_1.MOV')).toBe('video/quicktime');
        expect(normalizeVideoMime('application/octet-stream', 'clip.mp4')).toBe('video/mp4');
        expect(normalizeVideoMime('', 'clip.3gp')).toBe('video/3gpp');
        expect(normalizeVideoMime(undefined, 'noext')).toBe('video/mp4');
    });
});

describe('ChatVideoTile + viewer', () => {
    const msg = { type: 'video', mediaUrl: 'orig.mov', playbackUrl: 'play.mp4', thumbnailUrl: 'thumb.jpg', duration: 69, width: 1080, height: 1920 };

    it('the bubble loads NO video — just the poster, play badge and duration', () => {
        const { container } = render(<ChatVideoTile message={msg} isEs={false} />);
        expect(container.querySelector('video')).toBeNull();
        expect(container.querySelector('img').getAttribute('src')).toBe('thumb.jpg');
        expect(screen.getByText('1:09')).toBeTruthy();
    });

    it('tap opens the in-app full-screen player on the 720p copy (no native full-screen button)', () => {
        const { container } = render(<ChatVideoTile message={msg} isEs={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Play video' }));
        const v = container.querySelector('video');
        expect(v.getAttribute('src')).toBe('play.mp4');
        expect(v.getAttribute('controlslist')).toMatch(/nofullscreen/);
        expect(v.hasAttribute('playsinline')).toBe(true);
    });

    it('a playback error falls back to the original, then offers Open in browser', () => {
        bridge.opened = [];
        const { container } = render(<ChatVideoTile message={msg} isEs={false} />);
        fireEvent.click(screen.getByRole('button', { name: 'Play video' }));
        fireEvent.error(container.querySelector('video'));
        expect(container.querySelector('video').getAttribute('src')).toBe('orig.mov');
        fireEvent.error(container.querySelector('video'));
        expect(container.querySelector('video')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
        expect(bridge.opened).toEqual(['orig.mov']);
    });

    it('no poster yet → a placeholder tile, never a blank box', () => {
        const { container } = render(<ChatVideoTile message={{ type: 'video', mediaUrl: 'o.mov' }} isEs={true} />);
        expect(container.querySelector('img')).toBeNull();
        expect(screen.getByRole('button', { name: 'Reproducir video' })).toBeTruthy();
    });

    it('Android Back and ✕ close the viewer', () => {
        bridge.backs = [];
        const onClose = vi.fn();
        render(<ChatMediaViewer kind="video" sources={['a.mp4']} isEs={false} onClose={onClose} />);
        expect(bridge.backs).toHaveLength(1);
        act(() => { bridge.backs[0](); });
        expect(onClose).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});

describe('photo viewer gestures', () => {
    it('swipe down at normal size closes (fast swipe, one render behind)', () => {
        const onClose = vi.fn();
        render(<ChatMediaViewer kind="image" sources={['p.jpg']} isEs={false} onClose={onClose} />);
        const dlg = screen.getByRole('dialog', { name: 'Photo' });
        fireEvent.touchStart(dlg, { touches: [{ clientX: 200, clientY: 300 }] });
        fireEvent.touchMove(dlg, { touches: [{ clientX: 200, clientY: 480 }] });
        fireEvent.touchEnd(dlg, { touches: [] });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
    it('a short drag does not close', () => {
        const onClose = vi.fn();
        render(<ChatMediaViewer kind="image" sources={['p.jpg']} isEs={false} onClose={onClose} />);
        const dlg = screen.getByRole('dialog', { name: 'Photo' });
        fireEvent.touchStart(dlg, { touches: [{ clientX: 200, clientY: 300 }] });
        fireEvent.touchMove(dlg, { touches: [{ clientX: 200, clientY: 340 }] });
        fireEvent.touchEnd(dlg, { touches: [] });
        expect(onClose).not.toHaveBeenCalled();
    });
    it('pinch zooms in', () => {
        const { container } = render(<ChatMediaViewer kind="image" sources={['p.jpg']} isEs={false} onClose={() => {}} />);
        const dlg = screen.getByRole('dialog', { name: 'Photo' });
        fireEvent.touchStart(dlg, { touches: [{ clientX: 150, clientY: 400 }, { clientX: 250, clientY: 400 }] });
        fireEvent.touchMove(dlg, { touches: [{ clientX: 100, clientY: 400 }, { clientX: 300, clientY: 400 }] });
        expect(container.querySelector('img').style.transform).toMatch(/scale\(2\)/);
    });
});

describe('ChatPhoto', () => {
    it('keeps the photo’s own shape and opens full screen on tap', () => {
        const { container } = render(<ChatPhoto url="p.jpg" width={1200} height={1600} isEs={false} />);
        const img = container.querySelector('img');
        expect(img.style.aspectRatio).toBe(String(3 / 4));
        fireEvent.click(img);
        expect(screen.getByRole('dialog', { name: 'Photo' })).toBeTruthy();
    });
});
