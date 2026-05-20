import { describe, it, expect } from 'vitest';
import {
    normalizeToE164,
    isValidPhone,
    formatE164ForDisplay,
    smsStatusPill,
    CONSENT_TEXT_VERSION,
    CONSENT_TEXT,
} from './sms';

describe('normalizeToE164', () => {
    it('accepts bare 10-digit US number', () => {
        expect(normalizeToE164('3145551234')).toBe('+13145551234');
    });

    it('accepts formatted US number with parens + dashes', () => {
        expect(normalizeToE164('(314) 555-1234')).toBe('+13145551234');
        expect(normalizeToE164('314-555-1234')).toBe('+13145551234');
        expect(normalizeToE164('314.555.1234')).toBe('+13145551234');
    });

    it('accepts US number with country code prefix', () => {
        expect(normalizeToE164('13145551234')).toBe('+13145551234');
        expect(normalizeToE164('+13145551234')).toBe('+13145551234');
        expect(normalizeToE164('+1 (314) 555-1234')).toBe('+13145551234');
    });

    it('rejects empty / null / non-string', () => {
        expect(normalizeToE164('')).toBe(null);
        expect(normalizeToE164(null)).toBe(null);
        expect(normalizeToE164(undefined)).toBe(null);
        expect(normalizeToE164('   ')).toBe(null);
    });

    it('rejects too-short input', () => {
        expect(normalizeToE164('5551234')).toBe(null);
        expect(normalizeToE164('314555')).toBe(null);
    });

    it('rejects too-long input (over E.164 15 digits)', () => {
        expect(normalizeToE164('12345678901234567890')).toBe(null);
    });

    it('rejects US numbers starting with 0 or 1 (NANP area-code rule)', () => {
        // Area codes can't start with 0 or 1 in NANP
        expect(normalizeToE164('0145551234')).toBe(null);
        expect(normalizeToE164('1145551234')).toBe(null);
    });

    it('accepts non-US E.164 if already prefixed and valid length', () => {
        // UK mobile: +44 7911 123456
        expect(normalizeToE164('+447911123456')).toBe('+447911123456');
        // Mexico: +52 55 1234 5678
        expect(normalizeToE164('+525512345678')).toBe('+525512345678');
    });

    it('does NOT guess country code for bare non-US numbers', () => {
        // 12-digit bare number — we don't know what country. Reject.
        expect(normalizeToE164('447911123456')).toBe(null);
    });

    it('strips weird whitespace and punctuation', () => {
        expect(normalizeToE164('  +1 314 555 1234  ')).toBe('+13145551234');
        expect(normalizeToE164('+1.314.555.1234')).toBe('+13145551234');
    });
});

describe('isValidPhone', () => {
    it('mirrors normalizeToE164 truthiness', () => {
        expect(isValidPhone('3145551234')).toBe(true);
        expect(isValidPhone('+13145551234')).toBe(true);
        expect(isValidPhone('(314) 555-1234')).toBe(true);
        expect(isValidPhone('garbage')).toBe(false);
        expect(isValidPhone('')).toBe(false);
        expect(isValidPhone(null)).toBe(false);
    });
});

describe('formatE164ForDisplay', () => {
    it('formats US E.164 as (XXX) XXX-XXXX', () => {
        expect(formatE164ForDisplay('+13145551234')).toBe('(314) 555-1234');
    });

    it('returns raw E.164 for non-US numbers', () => {
        expect(formatE164ForDisplay('+447911123456')).toBe('+447911123456');
    });

    it('returns empty string for null/undefined/empty', () => {
        expect(formatE164ForDisplay(null)).toBe('');
        expect(formatE164ForDisplay(undefined)).toBe('');
        expect(formatE164ForDisplay('')).toBe('');
    });
});

describe('smsStatusPill', () => {
    it('returns "stopped" when STOP reply was received', () => {
        const pill = smsStatusPill({
            phoneE164: '+13145551234', smsOptIn: true, smsStopped: true,
        });
        expect(pill.key).toBe('stopped');
        expect(pill.tone).toMatch(/red/);
    });

    it('"stopped" takes priority over everything else', () => {
        const pill = smsStatusPill({
            phoneE164: '+13145551234', smsOptIn: false, smsStopped: true,
            smsLastDeliveryStatus: 'failed',
        });
        expect(pill.key).toBe('stopped');
    });

    it('returns "failed" when last delivery failed', () => {
        const pill = smsStatusPill({
            phoneE164: '+13145551234', smsOptIn: true,
            smsLastDeliveryStatus: 'failed',
        });
        expect(pill.key).toBe('failed');
    });

    it('returns "no_phone" when opted out and no phone on file', () => {
        const pill = smsStatusPill({ smsOptIn: false });
        expect(pill.key).toBe('no_phone');
    });

    it('returns "opted_out" when opted out but phone on file', () => {
        const pill = smsStatusPill({
            phoneE164: '+13145551234', smsOptIn: false,
        });
        expect(pill.key).toBe('opted_out');
    });

    it('returns "invalid_number" when opted in but phone is bad', () => {
        const pill = smsStatusPill({
            phoneE164: 'not-a-number', smsOptIn: true,
        });
        expect(pill.key).toBe('invalid_number');
    });

    it('returns "active" when opted in with valid phone and no failures', () => {
        const pill = smsStatusPill({
            phoneE164: '+13145551234', smsOptIn: true,
            smsLastDeliveryStatus: 'delivered',
        });
        expect(pill.key).toBe('active');
    });

    it('null staff returns "unknown"', () => {
        expect(smsStatusPill(null).key).toBe('unknown');
        expect(smsStatusPill(undefined).key).toBe('unknown');
    });
});

describe('consent text snapshots', () => {
    it('has a versioned consent text', () => {
        expect(CONSENT_TEXT_VERSION).toMatch(/^v\d+_\d{4}-\d{2}-\d{2}$/);
    });

    it('CONSENT_TEXT mentions STOP/HELP in both languages (CTIA requirement)', () => {
        expect(CONSENT_TEXT.en).toMatch(/STOP/);
        expect(CONSENT_TEXT.en).toMatch(/HELP/);
        expect(CONSENT_TEXT.es).toMatch(/STOP/);
        expect(CONSENT_TEXT.es).toMatch(/HELP/);
    });

    it('CONSENT_TEXT mentions message/data rates (CTIA requirement)', () => {
        expect(CONSENT_TEXT.en).toMatch(/data rates/i);
        expect(CONSENT_TEXT.es).toMatch(/tarifas/i);
    });

    it('CONSENT_TEXT names DD Mau and describes the type of messages', () => {
        expect(CONSENT_TEXT.en).toMatch(/DD Mau/);
        expect(CONSENT_TEXT.es).toMatch(/DD Mau/);
        // Lists representative message kinds so users know what they're agreeing to
        expect(CONSENT_TEXT.en).toMatch(/shift|coverage|schedule|weather|86/);
        expect(CONSENT_TEXT.es).toMatch(/turno|cobertura|horario|clima|86/);
    });
});
