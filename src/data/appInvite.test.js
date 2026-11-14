import { describe, it, expect } from 'vitest';
import { buildAppInviteText, appInviteSmsHref } from './appInvite';
import { IOS_APP_URL, ANDROID_APP_URL } from '../components/InstallAppButton';

describe('buildAppInviteText', () => {
    it('includes both store links, first name, and the PIN when known', () => {
        const t = buildAppInviteText({ name: 'Maria Lopez', pin: '4821' });
        expect(t).toContain('Hi Maria!');
        expect(t).toContain(IOS_APP_URL);
        expect(t).toContain(ANDROID_APP_URL);
        expect(t).toContain('Your login PIN: 4821');
        expect(t).toContain('not available');
    });
    it('says the PIN is coming when there is no staff record yet', () => {
        const t = buildAppInviteText({ name: 'Maria' });
        expect(t).not.toMatch(/PIN: \d/);
        expect(t).toContain("I'll send your login PIN soon.");
    });
    it('writes Spanish for es hires', () => {
        const t = buildAppInviteText({ name: 'José', pin: '1111', lang: 'es' });
        expect(t).toContain('¡Hola José!');
        expect(t).toContain('Tu PIN para entrar: 1111');
    });
});

describe('appInviteSmsHref', () => {
    it('builds an encoded sms link', () => {
        expect(appInviteSmsHref('314-555-1212', 'a b\nc')).toBe('sms:314-555-1212?body=a%20b%0Ac');
    });
    it('returns null with no phone', () => {
        expect(appInviteSmsHref('', 'x')).toBeNull();
    });
});
