import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({ subs: [], opened: [] }));
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    collection: (_db, p) => ({ path: p }), doc: (_db, ...s) => ({ path: s.join('/') }),
    query: (c) => c, where: () => ({}),
    onSnapshot: (ref, cb) => { h.subs.push({ ref, cb }); return () => {}; },
}));
vi.mock('./ModalPortal', () => ({ default: ({ children }) => children }));
vi.mock('../data/trainingDeepLink', () => ({ openTrainingModule: (id) => h.opened.push(id) }));
vi.mock('../data/trainingAssignments', () => ({
    ASSIGNMENTS: 'training_assignments',
    trainingDocId: (n) => String(n || '').toLowerCase().replace(/\s+/g, '_'),
    toMs: (t) => (t?.ms ?? null),
    fmtDue: () => 'Fri, Oct 24',
}));
vi.mock('../data/training', () => ({ MODULES: [{ id: 'mgr2', code: 'MGR2', icon: '👀', titleEn: 'Eyes on the Floor', titleEs: 'Ojos en el Piso' }] }));

import TrainingAssignmentPopup, { newTrainingFor } from './TrainingAssignmentPopup';

const A = (extra) => ({ id: 'a1', moduleId: 'mgr2', moduleCode: 'MGR2', titleEn: 'Section 2: Eyes on the Floor', status: 'open', recipients: [{ name: 'Yulissa Hurtado' }], opened: {}, dueAt: { ms: 1 }, ...extra });

describe('newTrainingFor', () => {
    it('shows open, unopened, unpassed assignments for this person only', () => {
        expect(newTrainingFor([A()], 'Yulissa Hurtado')).toHaveLength(1);
        expect(newTrainingFor([A()], 'Laura Hurtado')).toHaveLength(0);
        expect(newTrainingFor([A({ opened: { yulissa_hurtado: 'x' } })], 'Yulissa Hurtado')).toHaveLength(0);
        expect(newTrainingFor([A()], 'Yulissa Hurtado', { mgr2: { passed: true } })).toHaveLength(0);
        expect(newTrainingFor([A({ status: 'closed' })], 'Yulissa Hurtado')).toHaveLength(0);
    });
});

describe('TrainingAssignmentPopup', () => {
    beforeEach(() => { h.subs.length = 0; h.opened.length = 0; vi.useFakeTimers(); });
    const feed = (assignments, progress = {}) => act(() => {
        h.subs.find(s => s.ref.path === 'training_assignments').cb({ forEach: (fn) => assignments.forEach(a => fn({ id: a.id, data: () => a })) });
        h.subs.find(s => s.ref.path.startsWith('training_v2')).cb({ exists: () => true, data: () => ({ modules: progress }) });
        vi.advanceTimersByTime(1300);
    });
    it('pops up after sign-in and opens the lesson', () => {
        render(<TrainingAssignmentPopup staffName="Yulissa Hurtado" language="en" />);
        feed([A()]);
        expect(screen.getByText('You have a new lesson')).toBeTruthy();
        fireEvent.click(screen.getByText('Open lesson →'));
        expect(h.opened).toEqual(['mgr2']);
        expect(screen.queryByText('You have a new lesson')).toBeNull();
    });
    it('Later hides it; nothing shows when there is nothing new', () => {
        const r = render(<TrainingAssignmentPopup staffName="Yulissa Hurtado" language="es" />);
        feed([A()]);
        fireEvent.click(screen.getByText('Después'));
        expect(screen.queryByText('Tienes una lección nueva')).toBeNull();
        r.unmount(); h.subs.length = 0;
        render(<TrainingAssignmentPopup staffName="Yulissa Hurtado" language="en" />);
        feed([A()], { mgr2: { passed: true } });
        expect(screen.queryByText('You have a new lesson')).toBeNull();
    });
});
