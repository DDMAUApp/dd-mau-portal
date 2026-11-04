// Image-mode TV background: black when absent, art behind the picture when set,
// and nothing the Pi has to keep doing unless motion is switched on.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import TvBackgroundLayer, { MOTION_COUNTS } from './TvBackgroundLayer';
import { TV_TRANSITIONS, tvSlideStyle } from '../data/tvTransitions';

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', async (orig) => ({ ...(await orig()) }));

const { ImageModeLayout } = await import('./MenuDisplay');

const slideshow = (props = {}) => render(
    <ImageModeLayout imageUrls={['a.jpg', 'b.mp4']} imageRotateSeconds={10} sixed={new Set()} now={new Date(0)} label="T" {...props} />,
);

describe('TvBackgroundLayer', () => {
    it.each([[undefined], ['black'], ['plaid']])('kind %j renders nothing', (kind) => {
        expect(render(<TvBackgroundLayer kind={kind} />).container.firstChild).toBeNull();
    });
    it('color fills with the color and nothing else', () => {
        const el = render(<TvBackgroundLayer kind="color" color="#123456" />).container.firstChild;
        expect(el.style.backgroundColor).toBe('rgb(18, 52, 86)');
        expect(el.querySelector('svg')).toBeNull();
    });
    it.each(['fall', 'snow', 'sky'])('%s is static by default', (kind) => {
        const { container } = render(<TvBackgroundLayer kind={kind} />);
        expect(container.querySelector('[data-tv-background]')).toBeTruthy();
        expect(container.querySelector('[data-tv-bg-mover]')).toBeNull();
        expect(container.querySelector('style')).toBeNull();
    });
    it.each(['fall', 'snow'])('%s motion stays within budget: few elements, transform only, no filters', (kind) => {
        const { container } = render(<TvBackgroundLayer kind={kind} motion />);
        const n = container.querySelectorAll('[data-tv-bg-mover]').length;
        expect(n).toBe(MOTION_COUNTS[kind]);
        expect(n).toBeLessThanOrEqual(20);
        const css = container.querySelector('style').textContent;
        for (const [, body] of css.matchAll(/@keyframes [\w-]+ \{(.*)\}\s*$/gm)) {
            for (const [, prop] of body.matchAll(/([\w-]+):/g)) expect(prop).toBe('transform');
        }
        expect(container.innerHTML).not.toMatch(/filter|blur/);
    });
    it('motion on sky does nothing', () => {
        expect(render(<TvBackgroundLayer kind="sky" motion />).container.querySelector('[data-tv-bg-mover]')).toBeNull();
    });
});

describe('ImageModeLayout background', () => {
    it('absent: no layer, and video keeps its black box', () => {
        const { container } = slideshow();
        expect(container.querySelector('[data-tv-background]')).toBeNull();
        expect(container.querySelector('video').style.background).toBe('rgb(0, 0, 0)');
    });
    it('black: same as absent', () => {
        const { container } = slideshow({ imageBackground: { kind: 'black' } });
        expect(container.querySelector('[data-tv-background]')).toBeNull();
        expect(container.querySelector('video').style.background).toBe('rgb(0, 0, 0)');
    });
    it('set: layer comes first, under the slides, and video stops painting black', () => {
        const { container } = slideshow({ imageBackground: { kind: 'snow', motion: false } });
        const wrap = container.firstChild;
        const layer = wrap.querySelector('[data-tv-background]');
        expect(layer.dataset.tvBackground).toBe('snow');
        expect(wrap.firstElementChild).toBe(layer);
        expect(layer.style.zIndex).toBe('0');
        expect(container.querySelector('video').style.background).toBe('transparent');
        expect(container.querySelector('img')).toBeTruthy();
    });
});

describe('ImageModeLayout outgoing slide', () => {
    afterEach(() => vi.useRealTimers());
    const slideOf = (container, src) => container.querySelector(`img[src="${src}"]`).parentElement.parentElement;
    const afterOneChange = (props) => {
        vi.useFakeTimers();
        const view = render(<ImageModeLayout imageUrls={['a.jpg', 'b.jpg']} imageRotateSeconds={10} imageTransition="fade" imageTransitionMs={700} sixed={new Set()} now={new Date(0)} label="T" {...props} />);
        act(() => { vi.advanceTimersByTime(10000); });
        return view;
    };
    it.each([[undefined], [{ kind: 'black' }]])('black TV (%j) fades as it always did', (imageBackground) => {
        const { container } = afterOneChange({ imageBackground });
        expect(slideOf(container, 'a.jpg').style.transition).toBe('opacity 700ms ease');
    });
    it('with a background it stays opaque under the new slide, then clears', () => {
        const { container } = afterOneChange({ imageBackground: { kind: 'sky' } });
        const prev = slideOf(container, 'a.jpg');
        expect(prev.style.zIndex).toBe('1');
        expect(prev.style.transition).toBe('opacity 300ms ease 700ms');
        expect(slideOf(container, 'b.jpg').style.transition).toBe('opacity 700ms ease');
    });
});

describe('ImageModeLayout picture box', () => {
    afterEach(() => vi.restoreAllMocks());
    const load = (container, src, w, h) => {
        const img = container.querySelector(`img[src="${src}"]`);
        Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true });
        Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true });
        fireEvent.load(img);
        return img.parentElement;
    };
    const props = { imageRotateSeconds: 10, sixed: new Set(), now: new Date(0), label: 'T' };
    it('a new picture at the same position gets its own box, not the old one', () => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 3840, height: 2160 });
        const { container, rerender } = render(<ImageModeLayout imageUrls={['page.jpg', 'x.jpg']} {...props} />);
        const portrait = load(container, 'page.jpg', 1224, 1584);
        expect(parseFloat(portrait.style.width)).toBeCloseTo(2160 * 1224 / 1584, 3);
        rerender(<ImageModeLayout imageUrls={['photo.jpg', 'x.jpg']} {...props} />);
        const wide = load(container, 'photo.jpg', 1920, 1080);
        expect(wide.style.width).toBe('3840px');
        expect(wide.style.height).toBe('2160px');
    });
    it('a picture keeps its box when it moves to another position', () => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 3840, height: 2160 });
        const { container, rerender } = render(<ImageModeLayout imageUrls={['page.jpg', 'photo.jpg']} {...props} />);
        load(container, 'page.jpg', 1224, 1584);
        load(container, 'photo.jpg', 1920, 1080);
        rerender(<ImageModeLayout imageUrls={['photo.jpg', 'page.jpg']} {...props} />);
        const photoBox = container.querySelector('img[src="photo.jpg"]').parentElement;
        expect(photoBox.style.width).toBe('3840px');
    });
});

describe('transitions never paint over the background', () => {
    const modes = TV_TRANSITIONS.map(t => t.id).filter(id => id !== 'random');
    it.each(modes)('%s has no background in any role', (mode) => {
        for (const role of ['current', 'prev', 'idle']) {
            const s = tvSlideStyle(mode, role, 700);
            expect(s.background).toBeUndefined();
            expect(s.backgroundColor).toBeUndefined();
        }
    });
});
