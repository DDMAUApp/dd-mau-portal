import { describe, it, expect } from 'vitest';
import { pinFromPhone } from './onboarding';
import { assignPin } from './staffDoc';

describe('pinFromPhone', () => {
    it.each([
        ['+13145551234', '1234'],
        ['(314) 555-1234', '1234'],
        ['314.555.0098', '0098'],
        ['555-1234', '1234'],
    ])('takes the last 4 digits of %s', (phone, pin) => {
        expect(pinFromPhone(phone)).toBe(pin);
    });
    it.each([[''], [null], [undefined], ['n/a'], ['1234'], ['12345']])('gives no PIN for %s', (phone) => {
        expect(pinFromPhone(phone)).toBeNull();
    });
});

// The Add to Staff path: the phone's digits, unless someone already holds them.
describe('a phone PIN going through assignPin', () => {
    const roster = [{ pin: '1234' }, { pin: '5678' }];
    it('keeps the phone digits when nobody holds them', () => {
        expect(assignPin(roster, pinFromPhone('+13145550098'))).toEqual({ pin: '0098', changed: false });
    });
    it('gives a different, unused PIN when the digits are taken', () => {
        const { pin, changed } = assignPin(roster, pinFromPhone('+13145551234'));
        expect(changed).toBe(true);
        expect(pin).toMatch(/^\d{4}$/);
        expect(['1234', '5678']).not.toContain(pin);
    });
    it('gives a random unused PIN with no phone', () => {
        const { pin, changed } = assignPin(roster, pinFromPhone(''));
        expect(changed).toBe(true);
        expect(['1234', '5678']).not.toContain(pin);
    });
});
