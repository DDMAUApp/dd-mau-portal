import { describe, it, expect } from 'vitest';
import { selectGhostShifts, EMPTY_CELL_SHIFTS } from './scheduleCore';

const S = [
    { id: 'w1', staffName: 'Jose', date: '2026-08-17', location: 'webster',  published: true },
    { id: 'm1', staffName: 'Jose', date: '2026-08-18', location: 'maryland', published: true },
    { id: 'm2', staffName: 'Jose', date: '2026-08-19', location: 'maryland', published: false }, // draft
    { id: 'm3', staffName: 'Ana',  date: '2026-08-18', location: 'maryland', published: true },  // no row here
    { id: 'l0', staffName: 'Jose', date: '2026-08-20' },                                        // legacy, no location
    { id: 'me', staffName: 'Viewer', date: '2026-08-18', location: 'maryland', published: true },
];
const rows = new Set(['Jose', 'Viewer']);

describe('selectGhostShifts (cross-location ghosts)', () => {
    it('returns the other-store shifts of people with a row here (editor sees drafts too)', () => {
        const g = selectGhostShifts(S, { storeLocation: 'webster', rowNames: rows, canEdit: true, viewerName: 'Viewer' });
        expect(g.map(x => x.id).sort()).toEqual(['m1', 'm2', 'me']);
    });
    it('hides drafts and the viewer\'s own shifts for non-editors', () => {
        const g = selectGhostShifts(S, { storeLocation: 'webster', rowNames: rows, canEdit: false, viewerName: 'Viewer' });
        expect(g.map(x => x.id)).toEqual(['m1']);
    });
    it('flips direction when viewing the other store', () => {
        const g = selectGhostShifts(S, { storeLocation: 'maryland', rowNames: rows, canEdit: true });
        expect(g.map(x => x.id)).toEqual(['w1']);
    });
    it('respects the person filter and ignores legacy no-location shifts', () => {
        const g = selectGhostShifts(S, { storeLocation: 'webster', rowNames: rows, canEdit: true, personFilter: 'Jose' });
        expect(g.map(x => x.id).sort()).toEqual(['m1', 'm2']);
    });
    it('shows nothing in the combined "both" view and returns the frozen empty when nothing matches', () => {
        expect(selectGhostShifts(S, { storeLocation: 'both', rowNames: rows, canEdit: true })).toBe(EMPTY_CELL_SHIFTS);
        expect(selectGhostShifts(S, { storeLocation: 'webster', rowNames: new Set(), canEdit: true })).toBe(EMPTY_CELL_SHIFTS);
    });
});
