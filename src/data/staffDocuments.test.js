import { describe, it, expect } from 'vitest';
import {
    linkHolds, pickLinkedHire, isOwnFilePath, classifyDocFiles, canUpdateDoc, resubmitPatch, hasEarlierVersion, docsWaitingReview,
    passwordMode, nextTryState, suggestHire, MAX_PASSWORD_TRIES,
} from './staffDocuments';

const ana = { id: 7, name: 'Ana Ruiz' };
const hire = (id, staffId, staffName, more = {}) => ({ id, documentsLink: { staffId, staffName }, ...more });

describe('whose record is this', () => {
    it('shows only the confirmed record', () => {
        expect(pickLinkedHire([hire('a', 7, 'Ana Ruiz'), hire('b', 8, 'Ben Lee')], ana).id).toBe('a');
    });
    it('a same-named record with no confirmed link is never picked', () => {
        expect(pickLinkedHire([{ id: 'x', name: 'Ana Ruiz', personal: { legalName: 'Ana Ruiz' } }], ana)).toBe(null);
    });
    it("someone else's link is never picked, even with this person's name on it", () => {
        expect(pickLinkedHire([hire('b', 8, 'Ana Ruiz')], ana)).toBe(null);
    });
    it('a reused staff id does not inherit the last person\'s papers', () => {
        expect(linkHolds(hire('a', 7, 'Old Person'), ana)).toBe(false);
    });
    it('two records claiming one person shows neither', () => {
        expect(pickLinkedHire([hire('a', 7, 'Ana Ruiz'), hire('c', 7, 'Ana Ruiz')], ana)).toBe(null);
    });
    it('no staff record, no id, or no name: nothing', () => {
        expect(pickLinkedHire([hire('a', 7, 'Ana Ruiz')], null)).toBe(null);
        expect(pickLinkedHire([hire('a', undefined, 'Ana Ruiz')], { name: 'Ana Ruiz' })).toBe(null);
        expect(pickLinkedHire([hire('a', 7, '')], { id: 7, name: '' })).toBe(null);
    });
    it('a numeric id and a stored string id still match', () => {
        expect(linkHolds(hire('a', '7', 'ana  ruiz'), ana)).toBe(true);
    });
    it('refuses paths outside the folder', () => {
        expect(isOwnFilePath('onboarding/a/w4/filled_1.pdf', 'a')).toBe(true);
        expect(isOwnFilePath('onboarding/ab/w4/filled_1.pdf', 'a')).toBe(false);
        expect(isOwnFilePath('onboarding/a/../b/filled_1.pdf', 'a')).toBe(false);
        expect(isOwnFilePath('onboarding/a/x', '')).toBe(false);
    });
});

describe('older versions', () => {
    const state = (rows) => Object.fromEntries(rows.map(r => [r.name, r.older]));
    it('only the newest form is current, and each older one knows when it was replaced', () => {
        const r = classifyDocFiles(['filled_100.pdf', 'filled_300.pdf', 'filled_200.pdf']);
        expect(state(r)).toEqual({ 'filled_100.pdf': true, 'filled_200.pdf': true, 'filled_300.pdf': false });
        expect(r.find(f => f.name === 'filled_100.pdf').replacedAt).toBe(200);
        expect(r[0].name).toBe('filled_300.pdf');
    });
    it('an employer copy after the submission is current, alongside the submission', () => {
        expect(state(classifyDocFiles(['filled_100.pdf', 'complete_150.pdf']))).toEqual({ 'filled_100.pdf': false, 'complete_150.pdf': false });
    });
    it('a new submission makes the old employer copy older', () => {
        const r = classifyDocFiles(['filled_100.pdf', 'complete_150.pdf', 'filled_200.pdf']);
        expect(state(r)).toEqual({ 'filled_100.pdf': true, 'complete_150.pdf': true, 'filled_200.pdf': false });
        expect(r.find(f => f.name === 'complete_150.pdf').replacedAt).toBe(200);
    });
    it('a redone employer copy replaces the earlier one only', () => {
        expect(state(classifyDocFiles(['filled_100.pdf', 'complete_150.pdf', 'complete_160.pdf']))).toEqual({ 'filled_100.pdf': false, 'complete_150.pdf': true, 'complete_160.pdf': false });
    });
    it('signed forms version the same way', () => {
        expect(state(classifyDocFiles(['signed_100.pdf', 'signed_200.pdf']))).toEqual({ 'signed_100.pdf': true, 'signed_200.pdf': false });
    });
    const front = 'DL_1700000000000_0_front.jpg', back = '1700000000500_0_back.jpg', fresh = '1800000000000_0_new.jpg';
    it('several uploads stay current without an explicit update', () => {
        expect(state(classifyDocFiles([front, back]))).toEqual({ [front]: false, [back]: false });
    });
    it('uploads from before an update turn older, later ones do not', () => {
        expect(state(classifyDocFiles([front, back, fresh], { replacedBefore: 1750000000000 }))).toEqual({ [front]: true, [back]: true, [fresh]: false });
    });
    it('a file with no readable date is never called older', () => {
        expect(classifyDocFiles(['scan.pdf'], { replacedBefore: 1750000000000 })[0].older).toBe(false);
    });
    it('bad input is empty', () => { expect(classifyDocFiles(null)).toEqual([]); });
});

describe('updating', () => {
    it('signed agreements stay as signed once handed in', () => {
        expect(canUpdateDoc({ kind: 'offer_letter' }, 'approved')).toBe(false);
        expect(canUpdateDoc({ kind: 'acknowledgment' }, 'submitted')).toBe(false);
        expect(canUpdateDoc({ kind: 'offer_letter' }, 'needed')).toBe(true);
        expect(canUpdateDoc({ kind: 'template' }, 'approved')).toBe(true);
    });
    it('an update goes back for review, voids the employer section, and leaves other fields alone', () => {
        const p = resubmitPatch('i9', 'DEL', { replacedBefore: 5, replacing: true, extra: { idType: 'DL' }, now: new Date(0) });
        const iso = new Date(0).toISOString();
        expect(p).toEqual({
            'checklist.i9.status': 'submitted', 'checklist.i9.submittedAt': iso, 'checklist.i9.replacedBefore': 5,
            'checklist.i9.resubmittedAt': iso, 'checklist.i9.idType': 'DL',
            'checklist.i9.employerCompletedAt': 'DEL', 'checklist.i9.employerCompletedBy': 'DEL',
            'checklist.i9.employerPdfHash': 'DEL', 'checklist.i9.employerPdfPath': 'DEL',
        });
        expect(p['checklist.i9.pdfHash']).toBeUndefined();
    });
    it('adding a page marks nothing older', () => {
        expect(resubmitPatch('id_doc_1', 'DEL')['checklist.id_doc_1.replacedBefore']).toBeUndefined();
    });
    it('a rejected or earlier-submitted document counts as having a version', () => {
        expect(hasEarlierVersion({ status: 'rejected' })).toBe(true);
        expect(hasEarlierVersion({ status: 'started', submittedAt: 'x' })).toBe(true);
        expect(hasEarlierVersion({ status: 'needed' })).toBe(false);
    });
    it('managers are told only about updates still waiting', () => {
        expect(docsWaitingReview({ checklist: { a: { status: 'submitted', resubmittedAt: 'x' }, b: { status: 'approved', resubmittedAt: 'x' }, c: { status: 'submitted' } } })).toEqual(['a']);
    });
});

describe('password', () => {
    it('uses the password from the start of onboarding', () => {
        expect(passwordMode({ portalAuth: { hash: 'h', salt: 's' } })).toBe('enter');
    });
    it('having a password beats any setup allowance', () => {
        expect(passwordMode({ portalAuth: { hash: 'h' }, documentsPasswordSetUntil: '2999-01-01T00:00:00Z' })).toBe('enter');
    });
    it('no password: a manager has to allow making one, and only for a while', () => {
        expect(passwordMode({})).toBe('ask-manager');
        expect(passwordMode({ portalAuth: null })).toBe('ask-manager');
        expect(passwordMode({ documentsPasswordSetUntil: new Date(2000).toISOString() }, 1000)).toBe('create');
        expect(passwordMode({ documentsPasswordSetUntil: new Date(2000).toISOString() }, 3000)).toBe('ask-manager');
    });
    it('too many wrong tries makes them wait; a right one clears it', () => {
        let s = { tries: 0, waitUntil: 0 };
        for (let i = 0; i < MAX_PASSWORD_TRIES - 1; i++) { s = nextTryState(s, true, 10); expect(s.waitUntil).toBe(0); }
        s = nextTryState(s, true, 10);
        expect(s.waitUntil).toBeGreaterThan(10);
        expect(nextTryState({ tries: 3, waitUntil: 0 }, false)).toEqual({ tries: 0, waitUntil: 0 });
    });
});

describe('suggestions', () => {
    const hires = [{ id: 'h1', name: 'Tilten' }, { id: 'h2', name: 'Ana Ruiz', status: 'archived' }, { id: 'h3', name: 'ana ruiz' }];
    it('a link already on the staff record comes first, even with a misspelled hire', () => {
        expect(suggestHire({ name: 'Tilden Suchland', onboardingHireId: 'h1' }, hires)).toEqual({ hire: hires[0], why: 'staff' });
    });
    it('an exact name prefers a live record and flags that there were several', () => {
        expect(suggestHire(ana, hires)).toEqual({ hire: hires[2], why: 'name', several: true });
    });
    it("a record confirmed for someone else is never suggested", () => {
        const taken = { id: 'h9', name: 'Ana Ruiz', documentsLink: { staffId: 99, staffName: 'Ana Ruiz' } };
        expect(suggestHire({ id: 7, name: 'Ana Ruiz' }, [taken])).toBe(null);
        expect(suggestHire({ id: 7, name: 'Ana Ruiz', onboardingHireId: 'h9' }, [taken])).toBe(null);
    });
    it('a first name alone suggests nothing', () => {
        expect(suggestHire({ name: 'Ruby Vogel' }, [{ id: 'r', name: 'Ruby' }])).toBe(null);
    });
});
