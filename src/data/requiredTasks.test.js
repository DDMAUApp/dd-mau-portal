import { describe, it, expect } from 'vitest';
import { TASK_TYPES, TASK_TYPE_IDS, TASK_STATUS } from './requiredTasks';

describe('TASK_TYPES registry', () => {
    it('has at least sms_optin, availability, and install_pwa', () => {
        expect(TASK_TYPES.sms_optin).toBeDefined();
        expect(TASK_TYPES.availability).toBeDefined();
        expect(TASK_TYPES.install_pwa).toBeDefined();
    });

    it('every type has labelEn, labelEs, icon, autoComplete', () => {
        for (const id of TASK_TYPE_IDS) {
            const def = TASK_TYPES[id];
            expect(def.labelEn, `${id} labelEn`).toBeTypeOf('string');
            expect(def.labelEs, `${id} labelEs`).toBeTypeOf('string');
            expect(def.icon, `${id} icon`).toBeTypeOf('string');
            expect(def.autoComplete, `${id} autoComplete`).toBeTypeOf('function');
            expect(def.descriptionEn, `${id} descriptionEn`).toBeTypeOf('string');
            expect(def.descriptionEs, `${id} descriptionEs`).toBeTypeOf('string');
        }
    });

    it('TASK_STATUS has the canonical strings', () => {
        expect(TASK_STATUS.PENDING).toBe('pending');
        expect(TASK_STATUS.COMPLETED).toBe('completed');
        expect(TASK_STATUS.SKIPPED).toBe('skipped');
        expect(TASK_STATUS.DECLINED).toBe('declined');
        expect(TASK_STATUS.CANCELLED).toBe('cancelled');
    });
});

describe('sms_optin.autoComplete', () => {
    const def = TASK_TYPES.sms_optin;
    it('false when smsOptIn is undefined (never answered)', () => {
        expect(def.autoComplete({ name: 'x' })).toBe(false);
        expect(def.autoComplete({ name: 'x', smsOptIn: null })).toBe(false);
    });
    it('true when smsOptIn is explicitly true (opted in)', () => {
        expect(def.autoComplete({ name: 'x', smsOptIn: true })).toBe(true);
    });
    it('true when smsOptIn is explicitly false (opted out)', () => {
        // Either explicit answer counts — they MADE a choice, that's all
        // the task requires.
        expect(def.autoComplete({ name: 'x', smsOptIn: false })).toBe(true);
    });
    it('false when staff is missing entirely', () => {
        expect(def.autoComplete(null)).toBe(false);
        expect(def.autoComplete(undefined)).toBe(false);
    });
});

describe('availability.autoComplete', () => {
    const def = TASK_TYPES.availability;
    it('false when no availability field', () => {
        expect(def.autoComplete({ name: 'x' })).toBe(false);
    });
    it('false when availability is empty object', () => {
        expect(def.autoComplete({ name: 'x', availability: {} })).toBe(false);
    });
    it('false when every day has empty array slots', () => {
        expect(def.autoComplete({ name: 'x', availability: {
            mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [],
        }})).toBe(false);
    });
    it('true when at least one day has an array slot', () => {
        expect(def.autoComplete({ name: 'x', availability: {
            mon: [{ start: '09:00', end: '17:00' }],
        }})).toBe(true);
    });
    it('true when at least one day has an object with start/end', () => {
        expect(def.autoComplete({ name: 'x', availability: {
            wed: { start: '11:00', end: '20:00' },
        }})).toBe(true);
    });
    it('true when at least one day is allDay', () => {
        expect(def.autoComplete({ name: 'x', availability: {
            sun: { allDay: true },
        }})).toBe(true);
    });
    it('false when staff is missing', () => {
        expect(def.autoComplete(null)).toBe(false);
        expect(def.autoComplete(undefined)).toBe(false);
    });
    it('false when availability is wrong shape (string / number)', () => {
        expect(def.autoComplete({ name: 'x', availability: 'always' })).toBe(false);
        expect(def.autoComplete({ name: 'x', availability: 7 })).toBe(false);
    });
});

describe('defaults for known task types', () => {
    it('sms_optin defaults: blockApp=true, allowSkip=false', () => {
        expect(TASK_TYPES.sms_optin.defaultBlockApp).toBe(true);
        expect(TASK_TYPES.sms_optin.defaultAllowSkip).toBe(false);
    });
    it('availability defaults: blockApp=true, allowSkip=false', () => {
        expect(TASK_TYPES.availability.defaultBlockApp).toBe(true);
        expect(TASK_TYPES.availability.defaultAllowSkip).toBe(false);
    });
    it('install_pwa defaults: blockApp=true, allowSkip=false', () => {
        expect(TASK_TYPES.install_pwa.defaultBlockApp).toBe(true);
        expect(TASK_TYPES.install_pwa.defaultAllowSkip).toBe(false);
    });
});

describe('install_pwa.autoComplete', () => {
    const def = TASK_TYPES.install_pwa;
    it('false when pwaInstalled is undefined (never confirmed)', () => {
        expect(def.autoComplete({ name: 'x' })).toBe(false);
    });
    it('false when pwaInstalled is explicitly false', () => {
        expect(def.autoComplete({ name: 'x', pwaInstalled: false })).toBe(false);
    });
    it('true when pwaInstalled is true', () => {
        expect(def.autoComplete({ name: 'x', pwaInstalled: true })).toBe(true);
    });
    it('false when pwaInstalled is truthy but not strictly true', () => {
        // Defensive: a corrupted record with pwaInstalled: 1 or "yes"
        // shouldn't silently close the gate. Only the strict boolean
        // true (which is what the auto-detect effect writes) closes it.
        expect(def.autoComplete({ name: 'x', pwaInstalled: 1 })).toBe(false);
        expect(def.autoComplete({ name: 'x', pwaInstalled: 'yes' })).toBe(false);
    });
    it('false when staff is missing', () => {
        expect(def.autoComplete(null)).toBe(false);
        expect(def.autoComplete(undefined)).toBe(false);
    });
});
