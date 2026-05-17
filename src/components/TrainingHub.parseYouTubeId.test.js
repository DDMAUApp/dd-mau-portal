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
