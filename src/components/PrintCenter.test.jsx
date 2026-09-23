// PrintCenter — 2026-09-23 review M4. The panel re-arms Print ~450ms after
// a tap (optimistic hand-off), so a second tap during a slow/sleeping
// printer queued a silent duplicate. It now asks first (same guards as
// PrintLabelModal), and the Print button's two states are both wrapped in
// one <span> (Google-Translate removeChild crash class).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));

const h = vi.hoisted(() => ({ pending: 0, warm: 'ready', printFreeText: null }));
vi.mock('../data/labelPrinting', () => {
    const printer = { id: 'webster', ip: '10.0.0.33', enabled: true, type: 'epson_linerless', name: 'Kitchen' };
    return {
        subscribePrinterConfig: (loc, cb) => { cb(printer, {}); return () => {}; },
        getCachedPrinterConfig: () => printer,
        warmPrintConfigs: vi.fn(),
        subscribePrinterWarmState: (l, s, cb) => { cb(h.warm); return () => {}; },
        getLabelSizePresets: () => [{ id: 'full', nameEn: 'Full', nameEs: 'Completo' }],
        DEFAULT_LABEL_SIZE_PRESET: 'full',
        pendingPrintCount: () => h.pending,
        printFreeText: (...a) => h.printFreeText(...a),
    };
});

import PrintCenter from './PrintCenter';

function setup() {
    const utils = render(<PrintCenter location="webster" staffName="Ann" language="en" onClose={vi.fn()} />);
    fireEvent.change(utils.container.querySelector('textarea'), { target: { value: 'BROKEN' } });
    return utils;
}
const printButton = () => screen.getByRole('button', { name: /Print label|Printing…/ });

let confirmSpy;
beforeEach(() => {
    h.pending = 0;
    h.warm = 'ready';
    h.printFreeText = vi.fn(async () => ({ ok: true }));
    confirmSpy = vi.spyOn(window, 'confirm');
});
afterEach(() => { confirmSpy.mockRestore(); });

describe('PrintCenter — double-print guards (M4)', () => {
    it('prints straight through when nothing is pending and the printer is ready', async () => {
        setup();
        await act(async () => { fireEvent.click(printButton()); });
        expect(confirmSpy).not.toHaveBeenCalled();
        expect(h.printFreeText).toHaveBeenCalledTimes(1);
    });

    it('a tap while the last job is still sending asks first — declining sends nothing', async () => {
        h.pending = 1;
        confirmSpy.mockReturnValue(false);
        setup();
        await act(async () => { fireEvent.click(printButton()); });
        expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/still being sent/));
        expect(h.printFreeText).not.toHaveBeenCalled();
    });

    it('…and confirming queues exactly one more job', async () => {
        h.pending = 1;
        confirmSpy.mockReturnValue(true);
        setup();
        await act(async () => { fireEvent.click(printButton()); });
        expect(h.printFreeText).toHaveBeenCalledTimes(1);
    });

    it('an offline printer asks before trying', async () => {
        h.warm = 'offline';
        confirmSpy.mockReturnValue(false);
        setup();
        await act(async () => { fireEvent.click(printButton()); });
        expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/not responding/));
        expect(h.printFreeText).not.toHaveBeenCalled();
    });
});

describe('PrintCenter — Translate-safe Print button (M4)', () => {
    it('both the idle and the printing label are a single <span> child', async () => {
        h.printFreeText = vi.fn(() => new Promise(() => {}));   // stays in flight
        setup();
        const idle = printButton();
        expect(idle.childNodes).toHaveLength(1);
        expect(idle.firstChild.nodeName).toBe('SPAN');
        await act(async () => { fireEvent.click(idle); });
        const busy = screen.getByRole('button', { name: /Printing…/ });
        expect(busy.childNodes).toHaveLength(1);
        expect(busy.firstChild.nodeName).toBe('SPAN');
    });
});

// Andrew 2026-09-23 — the message box doubles as a search bar over the
// existing stickers; an exact name makes the cook choose.
describe('PrintCenter — existing-sticker matches', () => {
    const rows = [
        { id: 'sec::catering::1', kind: 'component', componentKind: 'catering', nameEn: 'Pho Plates', category: 'Catering' },
        { id: 'sec::pho::2', kind: 'component', componentKind: 'side', nameEn: 'Pho Broth', category: 'Pho' },
    ];
    const typeName = (container, value) =>
        fireEvent.change(container.querySelector('textarea'), { target: { value } });

    it('typing shows matching stickers; tapping one hands it back and prints nothing', async () => {
        const onUse = vi.fn();
        const { container } = render(<PrintCenter location="webster" staffName="Ann" language="en"
            onClose={vi.fn()} stickerMatchRows={rows} onUseSticker={onUse} />);
        typeName(container, 'pho pla');
        const pick = await screen.findByRole('button', { name: /Pho Plates/ });
        fireEvent.click(pick);
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ id: 'sec::catering::1' }));
        expect(h.printFreeText).not.toHaveBeenCalled();
    });

    it('Print on an exact name asks first; "Keep my custom print" prints once', async () => {
        const onUse = vi.fn();
        const { container } = render(<PrintCenter location="webster" staffName="Ann" language="en"
            onClose={vi.fn()} stickerMatchRows={rows} onUseSticker={onUse} />);
        typeName(container, 'PHO PLATES\nparty 6pm');
        await act(async () => { fireEvent.click(printButton()); });
        expect(h.printFreeText).not.toHaveBeenCalled();
        expect(screen.getByText('We already have this sticker', { selector: 'h3' })).toBeTruthy();
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep my custom print' })); });
        expect(h.printFreeText).toHaveBeenCalledTimes(1);
        expect(onUse).not.toHaveBeenCalled();
        // Kept once → the next Print of the same text goes straight through.
        await act(async () => { fireEvent.click(printButton()); });
        expect(h.printFreeText).toHaveBeenCalledTimes(2);
    });

    it('…or "Use" opens the real sticker instead', async () => {
        const onUse = vi.fn();
        const { container } = render(<PrintCenter location="webster" staffName="Ann" language="en"
            onClose={vi.fn()} stickerMatchRows={rows} onUseSticker={onUse} />);
        typeName(container, 'pho plate');
        await act(async () => { fireEvent.click(printButton()); });
        fireEvent.click(screen.getByRole('button', { name: /Use “Pho Plates”/ }));
        expect(onUse).toHaveBeenCalledTimes(1);
        expect(h.printFreeText).not.toHaveBeenCalled();
    });

    it('no match → prints straight through; other hosts (no rows) never search', async () => {
        const { container } = render(<PrintCenter location="webster" staffName="Ann" language="en"
            onClose={vi.fn()} stickerMatchRows={rows} onUseSticker={vi.fn()} />);
        typeName(container, 'BROKEN DO NOT USE');
        await act(async () => { fireEvent.click(printButton()); });
        expect(h.printFreeText).toHaveBeenCalledTimes(1);
    });
});
