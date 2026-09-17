import { describe, it, expect } from 'vitest';
import { ptoFormStatus, applyPtoFormChange } from './ptoRequestForm';

const base = { startDate: '2026-09-17', endDate: '2026-09-17', reason: 'doctor', partial: false, startTime: '15:00', endTime: '20:00' };

describe('ptoFormStatus', () => {
    it("Rubi's case: part of a FUTURE day submits even though the hidden end date is still today", () => {
        expect(ptoFormStatus({ ...base, partial: true, startDate: '2026-09-24' })).toEqual({ canSubmit: true, missing: null });
    });
    it('partial day: needs a day, both times, and end after start', () => {
        expect(ptoFormStatus({ ...base, partial: true, startDate: '' }).missing).toBe('date');
        expect(ptoFormStatus({ ...base, partial: true, endTime: '' }).missing).toBe('time');
        expect(ptoFormStatus({ ...base, partial: true, startTime: '20:00', endTime: '15:00' }).missing).toBe('timeOrder');
        expect(ptoFormStatus({ ...base, partial: true, startTime: '15:00', endTime: '15:00' }).missing).toBe('timeOrder');
    });
    it('whole day: needs both dates in order', () => {
        expect(ptoFormStatus(base).canSubmit).toBe(true);
        expect(ptoFormStatus({ ...base, endDate: '' }).missing).toBe('date');
        expect(ptoFormStatus({ ...base, startDate: '2026-09-24' }).missing).toBe('dateOrder');
        expect(ptoFormStatus({ ...base, startDate: '2026-09-24', endDate: '2026-09-26' }).canSubmit).toBe(true);
    });
    it('reason is required for staff, optional for the manager form, and checked LAST', () => {
        expect(ptoFormStatus({ ...base, reason: '   ' }).missing).toBe('reason');
        expect(ptoFormStatus({ ...base, reason: '' }, { requireReason: false }).canSubmit).toBe(true);
        expect(ptoFormStatus({ ...base, reason: '', startDate: '2026-09-24' }).missing).toBe('dateOrder');
    });
    it('tolerates garbage', () => {
        expect(ptoFormStatus(null).canSubmit).toBe(false);
        expect(ptoFormStatus(undefined).missing).toBe('date');
    });
});

describe('applyPtoFormChange', () => {
    it('moving the start date past the end date drags the end date along', () => {
        expect(applyPtoFormChange(base, 'startDate', '2026-09-24')).toMatchObject({ startDate: '2026-09-24', endDate: '2026-09-24' });
    });
    it('never shortens a longer range, and leaves other fields alone', () => {
        const ranged = { ...base, endDate: '2026-09-30' };
        expect(applyPtoFormChange(ranged, 'startDate', '2026-09-24').endDate).toBe('2026-09-30');
        expect(applyPtoFormChange(ranged, 'reason', 'trip')).toEqual({ ...ranged, reason: 'trip' });
        expect(applyPtoFormChange(ranged, 'endDate', '2026-09-18').endDate).toBe('2026-09-18');
    });
    it('clearing the start date does not touch the end date; an empty end date is filled', () => {
        expect(applyPtoFormChange(base, 'startDate', '').endDate).toBe('2026-09-17');
        expect(applyPtoFormChange({ ...base, endDate: '' }, 'startDate', '2026-09-24').endDate).toBe('2026-09-24');
    });
    it('does not mutate its input', () => {
        const f = { ...base }; applyPtoFormChange(f, 'startDate', '2026-10-01');
        expect(f).toEqual(base);
    });
});
