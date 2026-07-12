// useSecretHold — the shared-iPad-mode secret button (hold 10s).
// Timer logic verified with fake timers: fires only after a FULL
// uninterrupted hold; any release/drift/cancel aborts the countdown.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import useSecretHold from '../useSecretHold';

function Probe({ onTrigger, ms }) {
    const hold = useSecretHold(onTrigger, ms);
    return <h1 {...hold} data-testid="target">hold me</h1>;
}

describe('useSecretHold', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('fires after a full uninterrupted hold', () => {
        const spy = vi.fn();
        const { getByTestId } = render(<Probe onTrigger={spy} ms={10000} />);
        fireEvent.pointerDown(getByTestId('target'));
        vi.advanceTimersByTime(9999);
        expect(spy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire if released early', () => {
        const spy = vi.fn();
        const { getByTestId } = render(<Probe onTrigger={spy} ms={10000} />);
        fireEvent.pointerDown(getByTestId('target'));
        vi.advanceTimersByTime(9000);
        fireEvent.pointerUp(getByTestId('target'));
        vi.advanceTimersByTime(60000);
        expect(spy).not.toHaveBeenCalled();
    });

    it('does NOT fire if the pointer drifts off the element', () => {
        const spy = vi.fn();
        const { getByTestId } = render(<Probe onTrigger={spy} ms={10000} />);
        fireEvent.pointerDown(getByTestId('target'));
        vi.advanceTimersByTime(5000);
        fireEvent.pointerLeave(getByTestId('target'));
        vi.advanceTimersByTime(60000);
        expect(spy).not.toHaveBeenCalled();
    });

    it('does NOT fire on a system pointercancel (scroll/callout)', () => {
        const spy = vi.fn();
        const { getByTestId } = render(<Probe onTrigger={spy} ms={10000} />);
        fireEvent.pointerDown(getByTestId('target'));
        vi.advanceTimersByTime(5000);
        fireEvent.pointerCancel(getByTestId('target'));
        vi.advanceTimersByTime(60000);
        expect(spy).not.toHaveBeenCalled();
    });

    it('a second press restarts the countdown from zero', () => {
        const spy = vi.fn();
        const { getByTestId } = render(<Probe onTrigger={spy} ms={10000} />);
        fireEvent.pointerDown(getByTestId('target'));
        vi.advanceTimersByTime(8000);
        fireEvent.pointerUp(getByTestId('target'));
        fireEvent.pointerDown(getByTestId('target'));
        vi.advanceTimersByTime(8000);
        expect(spy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2000);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
