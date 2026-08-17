// Tests for parseYouTubeId — the URL/ID normalizer used by the
// LessonEditor when admins paste a YouTube link.
//
// Pure function; no React, no Firebase. Pin the accepted shapes so a
// future "we accept Vimeo too" refactor doesn't silently break the
// existing YouTube paths.

import { describe, it, expect } from 'vitest';
import { parseYouTubeId } from './TrainingHub';

describe('parseYouTubeId', () => {
    const VALID = 'dQw4w9WgXcQ';

    it('accepts a bare 11-char ID', () => {
        expect(parseYouTubeId(VALID)).toBe(VALID);
        expect(parseYouTubeId('abc12-_XYZA')).toBe('abc12-_XYZA');
    });

    it('rejects strings that look like IDs but are wrong length', () => {
        expect(parseYouTubeId('short')).toBeNull();
        expect(parseYouTubeId('thisistoolong1234567')).toBeNull();
    });

    it('handles standard watch URLs', () => {
        expect(parseYouTubeId(`https://www.youtube.com/watch?v=${VALID}`)).toBe(VALID);
        expect(parseYouTubeId(`https://www.youtube.com/watch?v=${VALID}&t=42`)).toBe(VALID);
        expect(parseYouTubeId(`https://youtube.com/watch?v=${VALID}`)).toBe(VALID);
    });

    it('handles m. mobile URLs', () => {
        expect(parseYouTubeId(`https://m.youtube.com/watch?v=${VALID}`)).toBe(VALID);
    });

    it('handles youtu.be short URLs', () => {
        expect(parseYouTubeId(`https://youtu.be/${VALID}`)).toBe(VALID);
        expect(parseYouTubeId(`https://youtu.be/${VALID}?si=abc123`)).toBe(VALID);
    });

    it('handles /shorts/ + /embed/ + /live/ + /v/ paths', () => {
        expect(parseYouTubeId(`https://www.youtube.com/shorts/${VALID}`)).toBe(VALID);
        expect(parseYouTubeId(`https://www.youtube.com/embed/${VALID}?rel=0`)).toBe(VALID);
        expect(parseYouTubeId(`https://www.youtube.com/live/${VALID}`)).toBe(VALID);
        expect(parseYouTubeId(`https://www.youtube.com/v/${VALID}`)).toBe(VALID);
    });

    it('accepts youtube-nocookie variant', () => {
        expect(parseYouTubeId(`https://www.youtube-nocookie.com/embed/${VALID}`)).toBe(VALID);
    });

    it('trims surrounding whitespace', () => {
        expect(parseYouTubeId(`  ${VALID}  `)).toBe(VALID);
        expect(parseYouTubeId(`\nhttps://youtu.be/${VALID}\n`)).toBe(VALID);
    });

    it('rejects empty / non-string input', () => {
        expect(parseYouTubeId('')).toBeNull();
        expect(parseYouTubeId(null)).toBeNull();
        expect(parseYouTubeId(undefined)).toBeNull();
        expect(parseYouTubeId(42)).toBeNull();
        expect(parseYouTubeId({})).toBeNull();
    });

    it('rejects non-YouTube URLs', () => {
        expect(parseYouTubeId(`https://vimeo.com/${VALID}`)).toBeNull();
        expect(parseYouTubeId(`https://example.com/watch?v=${VALID}`)).toBeNull();
        expect(parseYouTubeId('not a url at all')).toBeNull();
    });

    it('rejects YouTube URLs missing the video ID', () => {
        expect(parseYouTubeId('https://www.youtube.com/')).toBeNull();
        expect(parseYouTubeId('https://www.youtube.com/feed/trending')).toBeNull();
        expect(parseYouTubeId('https://www.youtube.com/watch')).toBeNull();
        expect(parseYouTubeId('https://www.youtube.com/watch?v=short')).toBeNull();
    });
});

// applyLessonOverride — the merge of an admin's in-app edit over the static
// lesson. 2026-08-17: an EMPTY override value ('' / []) must fall back to the
// deployed default instead of blanking the lesson for every device.
import { applyLessonOverride } from './TrainingHub';

describe('applyLessonOverride', () => {
    const lesson = { id: 'x', titleEn: 'T', titleEs: 'Tt', contentEn: ['a', 'b'], contentEs: ['aa', 'bb'] };

    it('returns the lesson untouched when there is no override', () => {
        expect(applyLessonOverride(lesson, undefined)).toBe(lesson);
    });

    it('applies non-empty overrides field by field', () => {
        const out = applyLessonOverride(lesson, { titleEn: 'New', contentEs: ['zz'] });
        expect(out.titleEn).toBe('New');
        expect(out.titleEs).toBe('Tt');
        expect(out.contentEn).toEqual(['a', 'b']);
        expect(out.contentEs).toEqual(['zz']);
    });

    it('treats empty / whitespace / blank-only values as "no override"', () => {
        const out = applyLessonOverride(lesson, { titleEn: '', titleEs: '   ', contentEn: [], contentEs: ['', '  '] });
        expect(out.titleEn).toBe('T');
        expect(out.titleEs).toBe('Tt');
        expect(out.contentEn).toEqual(['a', 'b']);
        expect(out.contentEs).toEqual(['aa', 'bb']);
    });

    it('passes video ids through (null stays "no video")', () => {
        expect(applyLessonOverride(lesson, { videoIdEn: 'dQw4w9WgXcQ' }).videoIdEn).toBe('dQw4w9WgXcQ');
        expect(applyLessonOverride({ ...lesson, videoIdEn: 'abc' }, { videoIdEn: null }).videoIdEn).toBe('abc');
    });
});

// orderQuizOptions — per-attempt shuffle. Must be a permutation, stable for a
// seed, and actually vary the position of the correct answer across seeds.
import { orderQuizOptions } from './TrainingHub';

describe('orderQuizOptions', () => {
    const opts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

    it('returns a permutation of the same option objects', () => {
        const out = orderQuizOptions(opts, 'seed|q1');
        expect(out).toHaveLength(4);
        expect(new Set(out)).toEqual(new Set(opts));
    });

    it('is deterministic for the same seed and differs across seeds', () => {
        const a = orderQuizOptions(opts, '123|q1').map(o => o.id).join('');
        const b = orderQuizOptions(opts, '123|q1').map(o => o.id).join('');
        expect(a).toBe(b);
        const positionsOfB = new Set();
        for (let s = 0; s < 40; s++) positionsOfB.add(orderQuizOptions(opts, `${s}|q1`).findIndex(o => o.id === 'b'));
        expect(positionsOfB.size).toBeGreaterThan(1); // "b" is not always in the same slot
    });

    it('is a no-op for degenerate input', () => {
        expect(orderQuizOptions([], 'x')).toEqual([]);
        expect(orderQuizOptions(undefined, 'x')).toEqual([]);
        const one = [{ id: 'a' }];
        expect(orderQuizOptions(one, 'x')).toBe(one);
    });
});
