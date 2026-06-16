import { describe, it, expect } from 'vitest';
import { computeChatRenamePatch } from './renameStaff';

const OLD = 'Amelia Amelia';
const NEW = 'Amelia Garcia';

describe('computeChatRenamePatch', () => {
    it('returns null when the staffer is not in the chat', () => {
        const data = { members: ['Cash Magruder', 'Isa Davis'], admins: ['Cash Magruder'] };
        expect(computeChatRenamePatch(data, OLD, NEW)).toBeNull();
    });

    it('returns null for a no-op rename (same name)', () => {
        const data = { members: [OLD] };
        expect(computeChatRenamePatch(data, OLD, OLD)).toBeNull();
    });

    it('renames the member entry, leaving others untouched and in order', () => {
        const data = { members: ['Cash Magruder', OLD, 'Isa Davis'] };
        const patch = computeChatRenamePatch(data, OLD, NEW);
        expect(patch.members).toEqual(['Cash Magruder', NEW, 'Isa Davis']);
        // No other keys when only membership changed.
        expect(Object.keys(patch)).toEqual(['members']);
    });

    it('renames admins[] and createdBy when present', () => {
        const data = {
            members: [OLD, 'Cash Magruder'],
            admins: [OLD],
            createdBy: OLD,
        };
        const patch = computeChatRenamePatch(data, OLD, NEW);
        expect(patch.members).toEqual([NEW, 'Cash Magruder']);
        expect(patch.admins).toEqual([NEW]);
        expect(patch.createdBy).toBe(NEW);
    });

    it('does not add admins/createdBy keys when this staffer was not one', () => {
        const data = { members: [OLD], admins: ['Cash Magruder'], createdBy: 'Cash Magruder' };
        const patch = computeChatRenamePatch(data, OLD, NEW);
        expect(patch.members).toEqual([NEW]);
        expect(patch).not.toHaveProperty('admins');
        expect(patch).not.toHaveProperty('createdBy');
    });

    it('moves the lastReadByName key, preserving the timestamp value', () => {
        const ts = { seconds: 123, nanoseconds: 0 };
        const data = { members: [OLD], lastReadByName: { [OLD]: ts, 'Cash Magruder': { seconds: 9 } } };
        const patch = computeChatRenamePatch(data, OLD, NEW);
        expect(patch.lastReadByName[NEW]).toBe(ts);
        expect(patch.lastReadByName).not.toHaveProperty(OLD);
        expect(patch.lastReadByName['Cash Magruder']).toEqual({ seconds: 9 });
    });

    it('drops the stale typingByName key without re-adding it', () => {
        const data = { members: [OLD], typingByName: { [OLD]: { seconds: 1 }, 'Cash Magruder': { seconds: 2 } } };
        const patch = computeChatRenamePatch(data, OLD, NEW);
        expect(patch.typingByName).not.toHaveProperty(OLD);
        expect(patch.typingByName).not.toHaveProperty(NEW);
        expect(patch.typingByName['Cash Magruder']).toEqual({ seconds: 2 });
    });

    it('updates lastMessage.sender only when it was the renamed staffer', () => {
        const data = { members: [OLD], lastMessage: { text: 'hi', sender: OLD } };
        const patch = computeChatRenamePatch(data, OLD, NEW);
        expect(patch.lastMessage).toEqual({ text: 'hi', sender: NEW });

        const data2 = { members: [OLD], lastMessage: { text: 'hi', sender: 'Cash Magruder' } };
        const patch2 = computeChatRenamePatch(data2, OLD, NEW);
        expect(patch2).not.toHaveProperty('lastMessage');
    });

    it('handles a DM doc (two-member) correctly', () => {
        const data = { type: 'dm', members: ['Cash Magruder', OLD] };
        const patch = computeChatRenamePatch(data, OLD, NEW);
        expect(patch.members).toEqual(['Cash Magruder', NEW]);
    });

    it('is null-safe on missing/garbage data', () => {
        expect(computeChatRenamePatch(null, OLD, NEW)).toBeNull();
        expect(computeChatRenamePatch({}, OLD, NEW)).toBeNull();
        expect(computeChatRenamePatch({ members: null }, OLD, NEW)).toBeNull();
    });
});
