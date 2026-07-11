import { describe, it, expect } from 'vitest';
import { partitionTemplateFiles } from './onboarding';

// partitionTemplateFiles decides which files survive in a template doc's
// Storage folder: newest hire submission (filled_) AND newest employer-
// completed version (complete_) both stay; only older duplicates within
// each kind get pruned. The regression this guards: the old keep-one-
// overall prune deleted the hire's signed I-9 original the first time
// the admin opened Files after completing Section 2.
describe('partitionTemplateFiles', () => {
    it('keeps a lone hire submission', () => {
        const { keep, prune } = partitionTemplateFiles(['filled_100.pdf']);
        expect(keep).toEqual(['filled_100.pdf']);
        expect(prune).toEqual([]);
    });

    it('keeps only the newest of several hire submissions', () => {
        const { keep, prune } = partitionTemplateFiles([
            'filled_100.pdf', 'filled_300.pdf', 'filled_200.pdf',
        ]);
        expect(keep).toEqual(['filled_300.pdf']);
        expect(prune.sort()).toEqual(['filled_100.pdf', 'filled_200.pdf']);
    });

    it('never prunes the hire submission when an employer-complete exists (the I-9 regression)', () => {
        // complete_ always carries the later timestamp — it's produced after
        // the hire submitted. Both must survive.
        const { keep, prune } = partitionTemplateFiles([
            'filled_100.pdf', 'complete_200.pdf',
        ]);
        expect(keep).toContain('filled_100.pdf');
        expect(keep).toContain('complete_200.pdf');
        expect(prune).toEqual([]);
    });

    it('prunes older duplicates within each kind, newest of both survive', () => {
        const { keep, prune } = partitionTemplateFiles([
            'filled_100.pdf', 'filled_150.pdf',
            'complete_200.pdf', 'complete_250.pdf',
        ]);
        expect(keep.sort()).toEqual(['complete_250.pdf', 'filled_150.pdf']);
        expect(prune.sort()).toEqual(['complete_200.pdf', 'filled_100.pdf']);
    });

    it('lists the employer-complete version first in keep (display order)', () => {
        const { keep } = partitionTemplateFiles(['filled_100.pdf', 'complete_200.pdf']);
        expect(keep[0]).toBe('complete_200.pdf');
    });

    it('treats names without a timestamp as oldest within their kind', () => {
        const { keep, prune } = partitionTemplateFiles(['legacy.pdf', 'filled_100.pdf']);
        expect(keep).toEqual(['filled_100.pdf']);
        expect(prune).toEqual(['legacy.pdf']);
    });

    it('handles empty and junk input without throwing', () => {
        expect(partitionTemplateFiles([])).toEqual({ keep: [], prune: [] });
        expect(partitionTemplateFiles(null)).toEqual({ keep: [], prune: [] });
        expect(partitionTemplateFiles(['', null, undefined])).toEqual({ keep: [], prune: [] });
    });
});

// pickSigStampBox pairs an admin-placed 🕒 Sig stamp box with a signature
// field so the "Electronically signed by…" caption prints at a chosen
// position instead of the legacy auto-offset (Andrew 2026-07-10: "the
// signature time stamp is off again — make it a template edit").
import { pickSigStampBox } from './onboarding';

describe('pickSigStampBox', () => {
    const sig = { id: 's1', type: 'signature', page: 1 };

    it('returns null when no stamp box is placed (legacy auto position)', () => {
        expect(pickSigStampBox([sig, { id: 't1', type: 'text', page: 1 }], sig)).toBeNull();
        expect(pickSigStampBox([], sig)).toBeNull();
        expect(pickSigStampBox(undefined, sig)).toBeNull();
    });

    it('an unpaired stamp on the same page auto-pairs', () => {
        const stamp = { id: 'st1', type: 'sig_stamp', page: 1 };
        expect(pickSigStampBox([sig, stamp], sig)).toBe(stamp);
        // …but not one on a different page.
        expect(pickSigStampBox([sig, { ...stamp, page: 0 }], sig)).toBeNull();
    });

    it('explicit stampFor wins over same-page proximity', () => {
        const samePage = { id: 'st1', type: 'sig_stamp', page: 1 };
        const pinned = { id: 'st2', type: 'sig_stamp', page: 3, stampFor: 's1' };
        expect(pickSigStampBox([sig, samePage, pinned], sig)).toBe(pinned);
    });

    it('employer stamps only pair with employer signatures (and vice versa)', () => {
        const empSig = { id: 'e1', type: 'signature', page: 2, filledBy: 'employer' };
        const empStamp = { id: 'st1', type: 'sig_stamp', page: 2, filledBy: 'employer' };
        const hireStamp = { id: 'st2', type: 'sig_stamp', page: 2 };
        expect(pickSigStampBox([empSig, empStamp, hireStamp], empSig)).toBe(empStamp);
        expect(pickSigStampBox([sig, empStamp], sig)).toBeNull();
        const hireSigP2 = { id: 's2', type: 'signature', page: 2 };
        expect(pickSigStampBox([hireSigP2, empStamp, hireStamp], hireSigP2)).toBe(hireStamp);
    });
});
