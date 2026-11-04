// RiceTempWheel (2026-11-03): only a person's touch counts as a reading.
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import RiceTempWheel from './RiceTempWheel';

const setup = (props = {}) => {
    const onChange = vi.fn();
    const utils = render(<RiceTempWheel start={200} min={100} max={212} dangerBelow={135} onChange={onChange} label="Rice temp" {...props} />);
    return { onChange, wheel: screen.getByRole('spinbutton', { name: 'Rice temp' }), ...utils };
};
const ITEM_H = 52;

describe('RiceTempWheel', () => {
    it('opens at the start number, reports nothing, and offers 212 down to 100 in 1 degree steps', () => {
        const { onChange, wheel } = setup();
        expect(wheel).toHaveAttribute('aria-valuenow', '200');
        expect(wheel).toHaveAttribute('aria-valuemin', '100');
        expect(wheel).toHaveAttribute('aria-valuemax', '212');
        expect(wheel.scrollTop).toBe(12 * ITEM_H);
        expect(screen.getByRole('button', { name: '212' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '199' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '100' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '213' })).toBe(null);
        expect(screen.queryByRole('button', { name: '99' })).toBe(null);
        expect(screen.getAllByRole('button')).toHaveLength(113);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('is a plain scroll-snap list that keeps its scrolling to itself', () => {
        const { wheel } = setup();
        expect(wheel.style.scrollSnapType).toBe('y mandatory');
        expect(wheel.style.overscrollBehavior).toBe('contain');
        expect(screen.getByRole('button', { name: '200' }).style.scrollSnapAlign).toBe('center');
    });

    it('has targets at least 44px tall', () => {
        setup();
        expect(parseInt(screen.getByRole('button', { name: '180' }).style.height, 10)).toBeGreaterThanOrEqual(44);
    });

    it('tapping the centered number reports it as tapped', () => {
        const { onChange } = setup();
        fireEvent.click(screen.getByRole('button', { name: '200' }));
        expect(onChange).toHaveBeenCalledWith(200, 'tapped');
    });

    it('tapping another number moves there and reports it as rolled', () => {
        const { onChange, wheel } = setup();
        fireEvent.click(screen.getByRole('button', { name: '198' }));
        expect(onChange).toHaveBeenCalledWith(198, 'rolled');
        expect(wheel).toHaveAttribute('aria-valuenow', '198');
    });

    it('a touch followed by scrolling reports each number as rolled', () => {
        const { onChange, wheel } = setup();
        fireEvent.touchStart(wheel);
        wheel.scrollTop = 15 * ITEM_H;   // 212 - 15 = 197
        fireEvent.scroll(wheel);
        expect(onChange).toHaveBeenLastCalledWith(197, 'rolled');
        expect(wheel).toHaveAttribute('aria-valuenow', '197');
    });

    it('a mouse wheel counts as a roll too', () => {
        const { onChange, wheel } = setup();
        fireEvent.wheel(wheel);
        wheel.scrollTop = 13 * ITEM_H;
        fireEvent.scroll(wheel);
        expect(onChange).toHaveBeenLastCalledWith(199, 'rolled');
    });

    it('scrolling nobody caused reports nothing', () => {
        const { onChange, wheel } = setup();
        wheel.scrollTop = 15 * ITEM_H;
        fireEvent.scroll(wheel);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('a touch with no movement reports nothing', () => {
        const { onChange, wheel } = setup();
        fireEvent.touchStart(wheel);
        fireEvent.scroll(wheel);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('rolling away and back still counts as rolled', () => {
        const { onChange, wheel } = setup();
        fireEvent.touchStart(wheel);
        wheel.scrollTop = 13 * ITEM_H;
        fireEvent.scroll(wheel);
        wheel.scrollTop = 12 * ITEM_H;
        fireEvent.scroll(wheel);
        expect(onChange).toHaveBeenLastCalledWith(200, 'rolled');
    });

    it('once rolled, a tap on the center stays rolled', () => {
        const { onChange, wheel } = setup();
        fireEvent.keyDown(wheel, { key: 'ArrowDown' });
        fireEvent.click(screen.getByRole('button', { name: '199' }));
        expect(onChange).toHaveBeenLastCalledWith(199, 'rolled');
    });

    it('works from the keyboard', () => {
        const { onChange, wheel } = setup();
        expect(wheel.tabIndex).toBe(0);
        fireEvent.keyDown(wheel, { key: 'ArrowUp' });
        expect(onChange).toHaveBeenLastCalledWith(201, 'rolled');
        fireEvent.keyDown(wheel, { key: 'ArrowDown' });
        fireEvent.keyDown(wheel, { key: 'ArrowDown' });
        expect(onChange).toHaveBeenLastCalledWith(199, 'rolled');
        expect(wheel.scrollTop).toBe(13 * ITEM_H);
        fireEvent.keyDown(wheel, { key: 'PageDown' });
        expect(onChange).toHaveBeenLastCalledWith(189, 'rolled');
        fireEvent.keyDown(wheel, { key: 'PageUp' });
        expect(onChange).toHaveBeenLastCalledWith(199, 'rolled');
        fireEvent.keyDown(wheel, { key: 'Home' });
        expect(onChange).toHaveBeenLastCalledWith(212, 'rolled');
        fireEvent.keyDown(wheel, { key: 'ArrowUp' });
        expect(onChange).toHaveBeenLastCalledWith(212, 'rolled');
        fireEvent.keyDown(wheel, { key: 'End' });
        expect(onChange).toHaveBeenLastCalledWith(100, 'rolled');
        fireEvent.keyDown(wheel, { key: 'ArrowDown' });
        expect(onChange).toHaveBeenLastCalledWith(100, 'rolled');
    });

    it('Enter confirms the centered number', () => {
        const { onChange, wheel } = setup();
        fireEvent.keyDown(wheel, { key: 'Enter' });
        expect(onChange).toHaveBeenCalledWith(200, 'tapped');
    });

    it('item buttons stay out of the tab order: the wheel is one stop', () => {
        setup();
        expect(screen.getByRole('button', { name: '180' }).tabIndex).toBe(-1);
    });

    it('turns numbers below the limit red', () => {
        setup();
        expect(screen.getByRole('button', { name: '134' }).className).toContain('text-red-600');
        expect(screen.getByRole('button', { name: '135' }).className).not.toContain('text-red-600');
    });

    it('a new resetKey reopens at the start number with a clean slate', () => {
        const onChange = vi.fn();
        let setKey;
        function Host() {
            const [k, set] = useState(0);
            setKey = set;
            return <RiceTempWheel start={200} min={100} max={212} dangerBelow={135} resetKey={k} onChange={onChange} label="Rice temp" />;
        }
        render(<Host />);
        const wheel = screen.getByRole('spinbutton');
        fireEvent.keyDown(wheel, { key: 'End' });
        expect(wheel).toHaveAttribute('aria-valuenow', '100');
        onChange.mockClear();
        fireEvent.click(screen.getByRole('button', { name: '100' }));
        expect(onChange).toHaveBeenLastCalledWith(100, 'rolled');
        onChange.mockClear();
        act(() => setKey(1));
        expect(wheel).toHaveAttribute('aria-valuenow', '200');
        expect(wheel.scrollTop).toBe(12 * ITEM_H);
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: '200' }));
        expect(onChange).toHaveBeenLastCalledWith(200, 'tapped');
    });

    it('comes back to a reading it already had, without reporting it again', () => {
        const { onChange, wheel } = setup({ initial: 187 });
        expect(wheel).toHaveAttribute('aria-valuenow', '187');
        expect(wheel.scrollTop).toBe(25 * ITEM_H);
        expect(onChange).not.toHaveBeenCalled();
    });
});
