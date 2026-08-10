// training.validation.test.js — structural + content invariants for the
// training catalog (2026-08-10 lesson audit; found 11 defects incl. a
// first-aid instruction truncated mid-sentence and 4 references to a
// module that doesn't exist). This pins the whole catalog so a future
// content edit can't ship those bug classes again.
//
// NOTE: in-app admin edits live in /config/training_overrides and are
// NOT covered here — only the shipped baseline in training.js.

import { describe, it, expect } from 'vitest';
import { MODULES } from './training';

const TIERS = ['all', 'lead', 'admin'];
const TRACKS = ['new-hire', 'stations', 'menu', 'service-safety', 'manager-ops'];
const EXISTING_CODES = new Set(MODULES.map(m => m.code));

describe('training catalog — module structure', () => {
    it('module ids, codes unique; tier/track/duration valid; titles bilingual', () => {
        const ids = new Set(), codes = new Set();
        for (const m of MODULES) {
            expect(ids.has(m.id), `dup module id ${m.id}`).toBe(false); ids.add(m.id);
            expect(codes.has(m.code), `dup code ${m.code}`).toBe(false); codes.add(m.code);
            expect(TIERS).toContain(m.tier);
            expect(TRACKS).toContain(m.track);
            expect(m.durationMin).toBeGreaterThan(0);
            expect(m.titleEn?.trim()).toBeTruthy();
            expect(m.titleEs?.trim()).toBeTruthy();
        }
    });
});

describe('training catalog — lessons', () => {
    const allLessons = MODULES.flatMap(m => (m.lessons || []).map(l => ({ m, l })));

    it('every module has lessons; lesson ids globally unique; titles bilingual', () => {
        const ids = new Set();
        for (const m of MODULES) expect(m.lessons?.length, `${m.code} has no lessons`).toBeGreaterThan(0);
        for (const { l } of allLessons) {
            expect(ids.has(l.id), `dup lesson id ${l.id}`).toBe(false); ids.add(l.id);
            expect(l.titleEn?.trim()).toBeTruthy();
            expect(l.titleEs?.trim()).toBeTruthy();
        }
    });

    it('content: non-empty bilingual arrays, no blank paragraphs, no truncated-looking endings', () => {
        for (const { l } of allLessons) {
            for (const [lang, arr] of [['En', l.contentEn], ['Es', l.contentEs]]) {
                expect(Array.isArray(arr) && arr.length > 0, `${l.id} content${lang} empty`).toBe(true);
                arr.forEach((p, i) => {
                    expect(typeof p === 'string' && p.trim().length > 0,
                        `${l.id} content${lang}[${i}] is blank`).toBe(true);
                    // A paragraph ending in a comma/dash/whitespace shipped a
                    // truncated first-aid instruction once — never again.
                    expect(/[,;—–-]\s*$/.test(p) || /\s$/.test(p),
                        `${l.id} content${lang}[${i}] looks truncated: …${JSON.stringify(p.slice(-40))}`).toBe(false);
                });
            }
            expect(l.contentEn.length, `${l.id} EN/ES paragraph count mismatch`).toBe(l.contentEs.length);
        }
    });

    it('never references a module code that does not exist', () => {
        for (const m of MODULES) {
            const refs = JSON.stringify(m).match(/\bM(\d{1,2})\b/g) || [];
            for (const ref of refs) {
                expect(EXISTING_CODES.has(ref),
                    `${m.code} references nonexistent module ${ref}`).toBe(true);
            }
        }
    });
});

describe('training catalog — quizzes', () => {
    it('every quiz well-formed: threshold, unique ids, bilingual, correct answer exists', () => {
        const qIds = new Set();
        for (const m of MODULES) {
            const qz = m.quiz;
            expect(qz?.questions?.length, `${m.code} missing quiz`).toBeGreaterThan(0);
            expect(qz.passThreshold).toBeGreaterThan(0);
            expect(qz.passThreshold).toBeLessThanOrEqual(1);
            for (const q of qz.questions) {
                expect(qIds.has(q.id), `dup question id ${q.id}`).toBe(false); qIds.add(q.id);
                expect(q.questionEn?.trim()).toBeTruthy();
                expect(q.questionEs?.trim()).toBeTruthy();
                expect(q.options.length).toBeGreaterThanOrEqual(2);
                const optIds = new Set();
                for (const o of q.options) {
                    expect(optIds.has(o.id), `${q.id} dup option ${o.id}`).toBe(false); optIds.add(o.id);
                    expect(o.textEn?.trim()).toBeTruthy();
                    expect(o.textEs?.trim()).toBeTruthy();
                }
                expect(optIds.has(q.correct),
                    `${q.id} correct="${q.correct}" matches no option`).toBe(true);
            }
        }
    });
});
