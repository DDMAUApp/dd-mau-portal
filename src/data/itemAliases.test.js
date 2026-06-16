import { describe, it, expect } from 'vitest';
import { normalizeAliasKey, lookupAlias } from './itemAliases';

describe('normalizeAliasKey', () => {
    it('lowercases and collapses non-alphanumerics to underscores', () => {
        expect(normalizeAliasKey('CHI MEI GWA BUN')).toBe('chi_mei_gwa_bun');
    });
    it('is stable across spacing/punctuation/case variations', () => {
        const a = normalizeAliasKey('CHI MEI  GWA-BUN');
        const b = normalizeAliasKey('chi mei gwa bun');
        expect(a).toBe(b);
    });
    it('trims leading/trailing separators', () => {
        expect(normalizeAliasKey('  #21/25 SHRIMP  ')).toBe('21_25_shrimp');
    });
    it('returns empty string for blank/nullish input', () => {
        expect(normalizeAliasKey('')).toBe('');
        expect(normalizeAliasKey(null)).toBe('');
        expect(normalizeAliasKey(undefined)).toBe('');
    });
    it('produces a Firestore-doc-id-safe key (no slashes/spaces)', () => {
        const k = normalizeAliasKey('A/B C\\D');
        expect(k).not.toMatch(/[/\\\s]/);
    });
});

describe('lookupAlias', () => {
    const map = {
        chi_mei_gwa_bun: { masterId: 'bao-1', masterName: 'Bao' },
    };
    it('finds a learned alias by normalized name', () => {
        expect(lookupAlias(map, 'CHI MEI GWA BUN')?.masterId).toBe('bao-1');
        expect(lookupAlias(map, 'chi mei  gwa-bun')?.masterId).toBe('bao-1');
    });
    it('returns null when nothing learned', () => {
        expect(lookupAlias(map, 'totally different item')).toBeNull();
    });
    it('returns null for empty name or empty map', () => {
        expect(lookupAlias(map, '')).toBeNull();
        expect(lookupAlias(null, 'chi mei gwa bun')).toBeNull();
    });
});
