// PrintLabelModal — 2026-09-23 sticker review fixes, exercised through the
// real modal (real buildLabelPayload / shelf-life / prep-date helpers; only
// Firebase, the printer transport and the format subscription are stubbed):
//   C4  a back-dated prep keeps a real time of day (+ time input), never 12:00p
//   M1  bottle description survives the editable rebuild → preview shows it
//   M5  Label Format default shelf life is the last-resort default
//   M6  Thawed → Fresh restores an item's hour clock
//   M7  name fields say which language they edit
//   (a) day stepper goes past 14 (rows allow 60)
// Also a smoke test: the modal's hooks were re-ordered (TDZ-sensitive).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../firebase', () => ({ db: {}, storage: {} }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn(), collection: vi.fn(), getDoc: vi.fn(), setDoc: vi.fn(),
    addDoc: vi.fn(async () => ({})), onSnapshot: vi.fn(() => () => {}), serverTimestamp: vi.fn(),
    query: vi.fn(), orderBy: vi.fn(), limit: vi.fn(), deleteField: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false }, CapacitorHttp: {} }));
vi.mock('../toast', () => ({ toast: vi.fn() }));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));
vi.mock('../data/audit', () => ({ recordAudit: vi.fn() }));

const h = vi.hoisted(() => ({ fmtPatch: {}, printPrepLabel: null }));
vi.mock('../data/labelFormat', async (importOriginal) => {
    const real = await importOriginal();
    const fmt = () => ({ ...real.DEFAULT_LABEL_FORMAT, ...h.fmtPatch });
    return {
        ...real,
        subscribeLabelFormat: (cb) => { cb(fmt(), null, { following: false }); return () => {}; },
        getCachedLabelFormat: () => undefined,
        getLabelFormatFast: async () => fmt(),
    };
});
vi.mock('../data/labelPrinting', async (importOriginal) => {
    const real = await importOriginal();
    const printer = { id: 'webster', ip: '10.0.0.33', enabled: true, type: 'epson_linerless', name: 'Kitchen' };
    return {
        ...real,
        subscribePrinterConfig: (loc, cb) => { cb(printer, {}); return () => {}; },
        getCachedPrinterConfig: () => printer,
        warmPrintConfigs: vi.fn(),
        subscribePrinterWarmState: (l, s, cb) => { cb('ready'); return () => {}; },
        prefetchPdfLib: vi.fn(),
        pendingPrintCount: () => 0,
        printPrepLabel: (...a) => h.printPrepLabel(...a),
    };
});

import PrintLabelModal from './PrintLabelModal';

function renderModal(recipe, extra = {}) {
    return render(
        <PrintLabelModal editable recipe={recipe} location="webster" staffName="Ann"
            language="en" source="datestickers" onClose={vi.fn()} {...extra} />,
    );
}
const bodyText = () => document.body.textContent;

beforeEach(() => {
    h.fmtPatch = {};
    h.printPrepLabel = vi.fn(async () => ({ ok: true }));
});
afterEach(() => { vi.useRealTimers(); });

describe('PrintLabelModal — smoke', () => {
    it('renders an editable sticker with its category default', () => {
        renderModal({ titleEn: 'Pho Broth', titleEs: 'Caldo de Pho', allergens: [], category: 'Stocks & Broths', kind: 'broth' });
        expect(screen.getByText('Item name (English)')).toBeInTheDocument();
        expect(screen.getByText('default 5d')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Print label/ })).toBeEnabled();
    });
});

describe('M5 — Label Format default shelf life', () => {
    it('applies to catch-all items with no shelf life of their own', () => {
        h.fmtPatch = { defaultShelfLifeDays: 2 };
        renderModal({ titleEn: 'Mystery', allergens: [], category: 'Other', kind: 'side' });
        expect(screen.getByText('default 2d')).toBeInTheDocument();
    });
    it('never overrides a specific category or the item\'s own life', () => {
        h.fmtPatch = { defaultShelfLifeDays: 9 };
        const { unmount } = renderModal({ titleEn: 'Chicken', allergens: [], category: 'Proteins', kind: 'protein' });
        expect(screen.getByText('default 3d')).toBeInTheDocument();
        unmount();
        renderModal({ titleEn: 'Pickles', allergens: [], category: 'Other', shelfLifeDays: 12 });
        expect(screen.getByText('default 12d')).toBeInTheDocument();
    });
    it('prints the resolved default', async () => {
        h.fmtPatch = { defaultShelfLifeDays: 2 };
        renderModal({ titleEn: 'Mystery', allergens: [], category: 'Other' });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Print label/ })); });
        expect(h.printPrepLabel).toHaveBeenCalledTimes(1);
        expect(h.printPrepLabel.mock.calls[0][0].shelfLifeDays).toBe(2);
    });
});

describe('(a) day stepper cap', () => {
    it('a 21-day item steps UP to 22 (used to snap down to 14)', () => {
        renderModal({ titleEn: 'Pickled carrots', allergens: [], category: 'Prep', shelfLifeDays: 21 });
        fireEvent.click(screen.getAllByText('+')[0]);
        expect(screen.getByText('22')).toBeInTheDocument();
    });
});

describe('M6 — Thawed → Fresh restores the hour clock', () => {
    it('an hour-clock item with a thawed life goes back to hours', () => {
        renderModal({ titleEn: 'Shrimp', allergens: [], category: 'Proteins', shelfLifeHours: 4, thawedDays: 2 });
        expect(screen.getByText('default 4h')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Thawed \(2d\)/ }));
        expect(screen.queryByText('default 4h')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Fresh \/ Frozen/ }));
        expect(screen.getByText('default 4h')).toBeInTheDocument();
    });
});

describe('M1 — bottle description survives the editable rebuild', () => {
    it('previews the description on a bottles sticker', () => {
        renderModal({ titleEn: 'Sriracha Mayo', allergens: [], category: 'Other', kind: 'bottles', descEn: 'Creamy garlic chili kick' });
        expect(screen.getByText(/Creamy garlic chili kick/)).toBeInTheDocument();
    });
    it('passes descEn to the print', async () => {
        renderModal({ titleEn: 'Sriracha Mayo', allergens: [], category: 'Other', kind: 'bottles', descEn: 'Creamy garlic chili kick' });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Print label/ })); });
        expect(h.printPrepLabel.mock.calls[0][0].recipe.descEn).toBe('Creamy garlic chili kick');
    });
});

describe('M7 — name fields name their language', () => {
    it('Spanish UI: English field + Spanish field, the Spanish one bound to titleEs', () => {
        renderModal({ titleEn: 'Pho Broth', titleEs: 'Caldo de Pho', allergens: [], category: 'Other' }, { language: 'es' });
        expect(screen.getByLabelText('Nombre en inglés')).toHaveValue('Pho Broth');
        expect(screen.getByLabelText('Nombre en español (opcional)')).toHaveValue('Caldo de Pho');
        expect(screen.queryByText('English name (optional)')).toBeNull();
    });
});

describe('C4 — back-dated prep keeps a real time of day', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 8, 23, 7, 5));   // Wed 7:05a
    });

    it('picking yesterday keeps 7:05a (was a fabricated 12:00p)', () => {
        const { container } = renderModal({ titleEn: 'Pho Broth', allergens: [], category: 'Stocks & Broths' });
        fireEvent.click(screen.getByRole('button', { name: /Change date/ }));
        fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2026-09-22' } });
        expect(bodyText()).toContain('09/22/26');
        expect(bodyText()).toContain('7:05a');
        expect(bodyText()).not.toContain('12:00p');
    });

    it('hour clock: the time input sets the real prep time, the use-by counts from it, and it prints that instant', async () => {
        const { container } = renderModal({ titleEn: 'Bean sprouts', allergens: [], category: 'Vegetables', shelfLifeHours: 4 });
        fireEvent.click(screen.getByRole('button', { name: /Change date/ }));
        expect(screen.getByText(/Hour clock counts from this date \+ time/)).toBeInTheDocument();
        fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2026-09-22' } });
        fireEvent.change(container.querySelector('input[type="time"]'), { target: { value: '05:30' } });
        expect(bodyText()).toContain('5:30a');
        expect(bodyText()).toContain('Use by: 09/22/26 9:30a');
        expect(bodyText()).not.toContain('12:00p');
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Print label/ })); });
        const args = h.printPrepLabel.mock.calls[0][0];
        expect(args.shelfLifeHours).toBe(4);
        const p = args.prepDate;
        expect([p.getFullYear(), p.getMonth(), p.getDate(), p.getHours(), p.getMinutes()]).toEqual([2026, 8, 22, 5, 30]);
    });

    it('a time later than now today is capped at now', () => {
        const { container } = renderModal({ titleEn: 'Rice', allergens: [], category: 'Prep', shelfLifeHours: 4 });
        fireEvent.click(screen.getByRole('button', { name: /Change date/ }));
        fireEvent.change(container.querySelector('input[type="time"]'), { target: { value: '23:00' } });
        expect(container.querySelector('input[type="time"]')).toHaveValue('07:05');
        expect(bodyText()).toContain('11:05a');   // 7:05a + 4h, not 3:00a tomorrow
    });
});
