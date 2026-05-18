// ChatEmojiPicker — compact emoji picker for the chat composer.
//
// Why a custom picker vs. native OS emoji keyboard:
//   • OS keyboard requires the staff to know about it (long-press
//     globe icon on iOS, etc.) — discoverability is bad.
//   • A visible 😀 button next to send is unmissable.
//   • We can bias the catalog toward restaurant-relevant emojis
//     (food, kitchen, service) instead of the generic 1,800-emoji
//     iOS firehose.
//   • Recent-emoji row lets repeat use be one tap instead of
//     scrolling.
//
// Shape: bottom-sheet on mobile (slides up from the composer),
// inline popover on md+. Tapping an emoji fires onPick(emoji) — the
// parent inserts at the textarea's cursor position and (depending on
// keepOpen) closes the picker or leaves it open for multi-pick.
//
// Recent-emoji storage: localStorage key 'ddmau:chat:emoji:recent'
// — a JSON array, most-recent-first, capped at 16. We dedupe on
// insert and trim to the cap.

import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'ddmau:chat:emoji:recent';
const RECENT_CAP = 16;

// Curated restaurant-relevant emoji set. Each category is a flat
// array; we lay them out in a wrapping grid. Order = visual priority
// (most common first in each category). NOT exhaustive — the goal is
// "you can find what you need in 2 seconds", not "every emoji ever".
const CATEGORIES = [
    {
        key: 'reactions',
        en: '😊 Reactions',
        es: '😊 Reacciones',
        emojis: [
            '👍', '👎', '❤️', '🙏', '👏', '🙌', '✅', '❌',
            '😂', '😅', '😊', '😍', '😎', '🥺', '😢', '😡',
            '😮', '🤔', '💯', '🔥', '✨', '🎉', '🥳', '💪',
            '👋', '🤝', '🫶', '✊', '🤞', '✌️', '🤘', '👌',
        ],
    },
    {
        key: 'food',
        en: '🍜 Food & drink',
        es: '🍜 Comida y bebida',
        emojis: [
            '🍜', '🍲', '🍛', '🍚', '🥢', '🍴', '🥄', '🍽️',
            '🍗', '🍖', '🥩', '🍤', '🦐', '🐟', '🦀', '🥟',
            '🥬', '🍅', '🧅', '🧄', '🥕', '🌶️', '🍋', '🍎',
            '🥚', '🧀', '🥛', '🍞', '🍳', '🥗', '🍝', '🌮',
            '☕', '🍵', '🥤', '🧃', '🍺', '🍷', '🍹', '🧊',
        ],
    },
    {
        key: 'kitchen',
        en: '🔪 Kitchen & service',
        es: '🔪 Cocina y servicio',
        emojis: [
            '🔪', '🔥', '🌡️', '⏲️', '⏰', '🧂', '🥡', '📦',
            '🧊', '🧽', '🧼', '🧴', '🧤', '🥽', '🪣', '🧹',
            '👨‍🍳', '👩‍🍳', '🧑‍🍳', '💁', '🛎️', '📋', '📝', '📞',
            '🏪', '🏬', '🚪', '🚽', '🚰', '💡', '🪑', '🛒',
        ],
    },
    {
        key: 'ops',
        en: '🚨 Ops & alerts',
        es: '🚨 Operaciones',
        emojis: [
            '🚨', '🛑', '⚠️', '🔧', '🔨', '⚙️', '🔌', '💧',
            '📅', '🗓️', '⏰', '⏱️', '⏳', '🆘', '🔔', '🔕',
            '📣', '📢', '📊', '📈', '📉', '💰', '💵', '🧾',
            '🤒', '🤕', '🤧', '😷', '💊', '🩹', '🚑', '🏥',
        ],
    },
    {
        key: 'symbols',
        en: '✅ Symbols',
        es: '✅ Símbolos',
        emojis: [
            '✅', '❎', '❌', '➕', '➖', '✖️', '➗', '🟰',
            '❓', '❗', '⁉️', '‼️', '💯', '🔢', '#️⃣', '*️⃣',
            '⬆️', '⬇️', '⬅️', '➡️', '↗️', '↘️', '↖️', '↙️',
            '🔵', '🟢', '🟡', '🟠', '🔴', '🟣', '⚫', '⚪',
        ],
    },
];

export default function ChatEmojiPicker({
    language = 'en', onPick, onClose, keepOpen = true,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [recent, setRecent] = useState(() => loadRecent());
    const [tab, setTab] = useState(recent.length > 0 ? 'recent' : 'reactions');

    // Persist recent on every change. The mutation happens in handlePick
    // — this just mirrors it to disk.
    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
        } catch {}
    }, [recent]);

    function handlePick(emoji) {
        onPick?.(emoji);
        // Move emoji to the front of recent, dedupe, trim.
        setRecent(prev => {
            const filtered = prev.filter(e => e !== emoji);
            const next = [emoji, ...filtered].slice(0, RECENT_CAP);
            return next;
        });
        if (!keepOpen) onClose?.();
    }

    const activeEmojis = useMemo(() => {
        if (tab === 'recent') return recent;
        const cat = CATEGORIES.find(c => c.key === tab);
        return cat ? cat.emojis : [];
    }, [tab, recent]);

    return (
        <>
            {/* Backdrop for click-outside-to-close. Transparent — we
                don't want to obscure the chat thread while picking. */}
            <div className="fixed inset-0 z-40" onClick={onClose} />
            {/* Picker panel. Anchored above the composer on mobile,
                full-width up to 480px. On md+, a popover (fixed
                bottom-right). Both share the same internal layout. */}
            <div className="fixed inset-x-0 bottom-0 z-50 bg-white border-t border-dd-line shadow-2xl md:inset-x-auto md:right-4 md:bottom-20 md:w-[420px] md:rounded-2xl md:border md:border-dd-line"
                style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
                {/* Header: category tabs (scrollable) + close */}
                <div className="flex items-center gap-1 px-2 py-2 border-b border-dd-line overflow-x-auto scrollbar-thin">
                    {recent.length > 0 && (
                        <TabButton
                            label={tx('🕐 Recent', '🕐 Reciente')}
                            active={tab === 'recent'}
                            onClick={() => setTab('recent')}
                        />
                    )}
                    {CATEGORIES.map(c => (
                        <TabButton
                            key={c.key}
                            label={isEs ? c.es : c.en}
                            active={tab === c.key}
                            onClick={() => setTab(c.key)}
                        />
                    ))}
                    <div className="flex-1" />
                    <button
                        onClick={onClose}
                        className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center text-dd-text-2 shrink-0"
                        aria-label={tx('Close', 'Cerrar')}
                    >
                        ✕
                    </button>
                </div>
                {/* Emoji grid — large tap targets (44px min) for thumb
                    accuracy on phones. Wraps naturally; the panel
                    height caps at 280px so it never eats the whole
                    screen — overflow scrolls. */}
                <div className="px-2 py-2 max-h-[280px] overflow-y-auto"
                     style={{ overscrollBehavior: 'contain' }}>
                    {activeEmojis.length === 0 ? (
                        <div className="py-8 text-center text-xs text-dd-text-2">
                            {tab === 'recent'
                                ? tx('Pick an emoji to start the recent list.',
                                     'Elige un emoji para comenzar la lista reciente.')
                                : tx('No emojis here.', 'Sin emojis aquí.')}
                        </div>
                    ) : (
                        <div className="grid grid-cols-8 gap-1">
                            {activeEmojis.map((e, i) => (
                                <button
                                    key={`${e}_${i}`}
                                    onClick={() => handlePick(e)}
                                    className="aspect-square flex items-center justify-center text-2xl rounded-lg hover:bg-dd-bg active:scale-110 transition"
                                    aria-label={e}
                                >
                                    {e}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}

function TabButton({ label, active, onClick }) {
    return (
        <button
            onClick={onClick}
            className={`px-2.5 py-1 rounded-full text-[11px] font-bold shrink-0 transition ${active
                ? 'bg-dd-green text-white'
                : 'bg-dd-bg text-dd-text-2 hover:bg-dd-line/40'}`}
        >
            {label}
        </button>
    );
}

function loadRecent() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.slice(0, RECENT_CAP) : [];
    } catch {
        return [];
    }
}
