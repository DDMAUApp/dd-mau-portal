// The rule list is what staff act on, so these checks guard its shape and wording.
import { describe, it, expect } from 'vitest';
import { FOOD_SAFETY_TOPICS } from './foodSafetyRules';

const RULES = FOOD_SAFETY_TOPICS.flatMap((topic) => topic.rules.map((rule) => ({ topic, rule })));
const STAFF_FIELDS = ['titleEn', 'titleEs', 'en', 'es', 'examEn', 'examEs', 'source'];

const filled = (value) => typeof value === 'string' && value.trim().length > 0;
const numbers = (text) => (text.match(/\d[\d,.:]*\d|\d/g) || []).sort();
const sentences = (text) => text.split(/[.!?](?:\s|$)/).filter((part) => part.trim()).length;
const tokens = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

describe('food safety rule list', () => {
    it('has unique kebab-case ids for topics and rules', () => {
        const ids = [...FOOD_SAFETY_TOPICS.map((t) => t.id), ...RULES.map(({ rule }) => rule.id)];
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    it('gives every topic an icon and both titles, and at least one rule', () => {
        for (const topic of FOOD_SAFETY_TOPICS) {
            expect(filled(topic.icon), topic.id).toBe(true);
            expect(filled(topic.titleEn), topic.id).toBe(true);
            expect(filled(topic.titleEs), topic.id).toBe(true);
            expect(topic.rules.length, topic.id).toBeGreaterThan(0);
        }
    });

    it('gives every rule both languages, both titles and a source', () => {
        for (const { rule } of RULES) {
            for (const field of ['titleEn', 'titleEs', 'en', 'es', 'source']) {
                expect(filled(rule[field]), `${rule.id}.${field}`).toBe(true);
            }
        }
    });

    it('keeps internal notes and file paths out of everything staff can see', () => {
        const banned = [
            /\[[A-Z ,]+/, // bracket tags such as [INFERENCE]
            /\b(INFERENCE|PRIMARY|SECONDARY|NOT FOUND|MEMORY|UNVERIFIED)\b/,
            /book check/i,
            /summarizing tool/i,
            /\bsection \d/i,
            /\brow \d/i,
            /\/(Users|src)\b/,
            /\bsrc\//,
            /[\w-]+\.(js|jsx|mjs|md|json|py)\b/,
        ];
        for (const { rule } of RULES) {
            for (const field of STAFF_FIELDS) {
                for (const pattern of banned) {
                    if (rule[field]) expect(rule[field], `${rule.id}.${field}`).not.toMatch(pattern);
                }
            }
        }
    });

    it('never names the exam brand, in any field', () => {
        for (const { rule } of RULES) {
            for (const field of [...STAFF_FIELDS, 'checkFirst']) {
                if (rule[field]) expect(rule[field], `${rule.id}.${field}`).not.toMatch(/servsafe/i);
            }
        }
    });

    it('has exam notes in pairs, in the agreed wording', () => {
        for (const { rule } of RULES) {
            expect(Boolean(rule.examEn), rule.id).toBe(Boolean(rule.examEs));
            if (rule.examEn) {
                expect(rule.examEn, rule.id).toMatch(/^On the exam: /);
                expect(rule.examEs, rule.id).toMatch(/^En el examen: /);
            }
        }
    });

    it('has Spanish that differs from the English', () => {
        for (const { rule } of RULES) {
            expect(rule.es, rule.id).not.toBe(rule.en);
            if (rule.examEn) expect(rule.examEs, rule.id).not.toBe(rule.examEn);
        }
        // A proper name can be the same in both languages, but a title rarely should be.
        const sameTitles = RULES.filter(({ rule }) => rule.titleEn === rule.titleEs).map(({ rule }) => rule.id);
        expect(sameTitles).toEqual(['salmonella-typhi']);
    });

    it('states the same numbers in English and Spanish', () => {
        for (const { rule } of RULES) {
            expect(numbers(rule.es), rule.id).toEqual(numbers(rule.en));
            if (rule.examEn) expect(numbers(rule.examEs), rule.id).toEqual(numbers(rule.examEn));
        }
    });

    it('keeps rules to one or two sentences in both languages', () => {
        for (const { rule } of RULES) {
            // "E. coli" and "B. cereus" read as a stop, so they don't count.
            const count = (text) => sentences(text.replace(/\b[EB]\. /g, 'X '));
            expect(count(rule.en), `${rule.id} en`).toBeLessThanOrEqual(2);
            expect(count(rule.es), `${rule.id} es`).toBeLessThanOrEqual(2);
        }
    });

    it('uses dispositivo, not aparato', () => {
        for (const { rule } of RULES) {
            for (const field of ['titleEs', 'es', 'examEs']) {
                if (rule[field]) expect(rule[field], rule.id).not.toMatch(/aparato/i);
            }
        }
    });

    it('has lowercase search words the rule text does not already contain', () => {
        for (const { rule } of RULES) {
            if (rule.words === undefined) continue;
            expect(Array.isArray(rule.words), rule.id).toBe(true);
            const text = new Set(tokens([rule.titleEn, rule.titleEs, rule.en, rule.es, rule.examEn, rule.examEs].filter(Boolean).join(' ')));
            expect(new Set(rule.words).size, rule.id).toBe(rule.words.length);
            for (const word of rule.words) {
                expect(word, rule.id).toBe(word.toLowerCase());
                expect(tokens(word).every((t) => text.has(t)), `${rule.id}: "${word}"`).toBe(false);
            }
        }
    });

    it('answers chicken with 165°F for 15 seconds, and the exam note', () => {
        const chicken = RULES.map(({ rule }) => rule).find((rule) => /chicken/i.test(rule.titleEn));
        expect(chicken.en).toMatch(/165°F/);
        expect(chicken.en).toMatch(/15 seconds/);
        expect(chicken.es).toMatch(/165°F/);
        expect(chicken.es).toMatch(/15 segundos/);
        expect(chicken.examEn).toBe('On the exam: 165°F, instant.');
    });

    it('answers hand sinks with 100°F, and the exam note', () => {
        const sink = RULES.map(({ rule }) => rule).find((rule) => /hand sink/i.test(rule.titleEn) && /100°F/.test(rule.en));
        expect(sink).toBeTruthy();
        expect(sink.es).toMatch(/100°F/);
        expect(sink.examEn).toMatch(/85°F/);
    });
});
