import { describe, it, expect } from 'vitest';
import { foldText, searchFoodSafety, tokenize } from './foodSafetySearch';

const rule = (id, titleEn, titleEs, en, es, words) => ({ id, titleEn, titleEs, en, es, words, source: 'x' });
const TOPICS = [
    { id: 'cook', titleEn: 'Cooking', titleEs: 'Cocción', rules: [
        rule('chicken', 'Chicken', 'Pollo', 'Cook to 165°F for 15 seconds.', 'Cocina a 165°F por 15 segundos.', ['poultry', 'wings']),
        rule('ground', 'Ground meat', 'Carne molida', 'Cook to 155°F for 17 seconds.', 'Cocina a 155°F por 17 segundos.', ['burger']),
    ] },
    { id: 'sick', titleEn: 'Working sick', titleEs: 'Trabajar enfermo', rules: [
        rule('fever', 'Fever', 'Fiebre', 'Tell your manager before your shift.', 'Avísale a tu gerente antes del turno.', []),
    ] },
];
const top = (q) => searchFoodSafety(TOPICS, q)[0]?.rule.id;

describe('searchFoodSafety', () => {
    it('answers the chicken question in either language', () => {
        expect(top('what is chicken cooked at?')).toBe('chicken');
        expect(top('what temp is chicken cooked to')).toBe('chicken');
        expect(top('¿A qué temperatura se cocina el pollo?')).toBe('chicken');
    });
    it('ignores everyday question words in Spanish', () => {
        expect(top('qué hago si tengo fiebre')).toBe('fever');
    });
    it('finds a rule by a search word and handles plurals and accents', () => {
        expect(top('burgers')).toBe('ground');
        expect(top('fevers')).toBe('fever');
        expect(foldText('Cocción')).toBe('coccion');
        expect(tokenize('165°F, por favor')).toEqual(['165', 'f', 'por', 'favor']);
    });
    it('says nothing rather than guessing', () => {
        expect(searchFoodSafety(TOPICS, 'parking lot hours')).toEqual([]);
        expect(searchFoodSafety(TOPICS, '')).toEqual([]);
        expect(searchFoodSafety(TOPICS, '   ?? ')).toEqual([]);
    });
    it('one common word out of several can\'t produce an answer', () => {
        expect(searchFoodSafety(TOPICS, 'chicken parking lot sign paint')).toEqual([]);
    });
    it('drops weak matches under a strong one', () => {
        expect(searchFoodSafety(TOPICS, 'chicken').map((r) => r.rule.id)).toEqual(['chicken']);
    });
    it('keeps to the limit, strongest first', () => {
        expect(searchFoodSafety(TOPICS, 'cooking', 1)).toHaveLength(1);
    });
});
