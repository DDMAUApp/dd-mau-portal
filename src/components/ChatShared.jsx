// Shared chat helpers — extracted from ChatCenter.jsx to break a
// circular import (Andrew 2026-05-22). ChatCenter lazy-imports
// ChatThread (and ChatSearchPanel, ChatSettingsModal); each of
// those statically imports ChatAvatar + chatDisplayName from
// ChatCenter. Vite emits the resulting cycle as cross-chunk
// imports that include ~18 minified helper bindings. When the
// user clicks a chat, ChatThread's chunk starts evaluating before
// ChatCenter's bindings have settled, and one of those bindings
// (minified name 'C') hits a TDZ in Safari → "Cannot access 'C'
// before initialization" → ErrorBoundary fallback.
//
// Putting these two pure helpers in their own file means every
// consumer (ChatCenter, ChatThread, ChatSearchPanel,
// ChatSettingsModal) imports from a leaf module that doesn't
// import any of them back. No cycle, no TDZ.
//
// Nothing else belongs here. If you add a new helper that's only
// used in one place, keep it in that place. This file should stay
// minimal.

// Avatar — channel emoji, group emoji, or DM initials. Stays a circle
// at every size; falls back to a sage-tinted background when no emoji.
export function ChatAvatar({ chat, viewerName, size = 40 }) {
    if (!chat) return null;
    const px = `${size}px`;
    const fontSize = `${Math.round(size * 0.46)}px`;
    if (chat.type === 'channel' || (chat.type === 'group' && chat.emoji)) {
        return (
            <span
                className="inline-flex items-center justify-center rounded-full bg-dd-sage-50 border border-dd-line shrink-0"
                style={{ width: px, height: px, fontSize }}
            >
                {chat.emoji || '👥'}
            </span>
        );
    }
    if (chat.type === 'group') {
        return (
            <span
                className="inline-flex items-center justify-center rounded-full bg-dd-charcoal text-white font-black shrink-0"
                style={{ width: px, height: px, fontSize: `${Math.round(size * 0.38)}px` }}
            >
                {((chat.name || '').slice(0, 2) || '?').toUpperCase()}
            </span>
        );
    }
    // DM — initials of the OTHER person.
    // 2026-05-31 — Andrew: "the green bubbles with the name of the
    // staff, make that the Apple glass look." Reuses .glass-avatar-green
    // (defined in src/index.css) which gives a sage-to-green gradient,
    // backdrop-blur, hairline brand ring, top highlight, and green-700
    // initials. Same chrome the Header + Sidebar avatars adopted in the
    // 2026-05-27 pass (Task #116). The class sets background AND text
    // color via CSS, so the old `bg-dd-green text-white` utilities are
    // gone and font-black stays so the initials read crisply against
    // the lighter glass surface.
    const other = (chat.members || []).find(m => m !== viewerName) || '?';
    const initials = other.split(' ').filter(Boolean).map(p => p[0]).slice(0, 2).join('').toUpperCase();
    return (
        <span
            className="glass-avatar-green inline-flex items-center justify-center rounded-full font-black shrink-0"
            style={{ width: px, height: px, fontSize: `${Math.round(size * 0.38)}px` }}
        >
            {initials || '?'}
        </span>
    );
}

// Display name for a chat from the viewer's perspective.
// DM → the OTHER person. Channel/group → their stored name.
export function chatDisplayName(chat, viewerName) {
    if (!chat) return '';
    if (chat.type === 'dm') {
        const other = (chat.members || []).find(m => m !== viewerName);
        return other || '(empty)';
    }
    return chat.name || '(unnamed)';
}
