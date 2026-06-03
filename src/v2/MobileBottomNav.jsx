// MobileBottomNav — fixed 5-tab bar at the bottom of the screen on phones.
//
// Why: the v2 sidebar is great on desktop but becomes a hamburger drawer on
// mobile. Restaurant staff use this app one-handed during a rush — often
// with wet/gloved hands, holding plates or trays. A two-tap drawer pattern
// is wrong here. A fixed bottom bar with the 4-5 most-used destinations is
// always one tap away and always within thumb reach.
//
// Visual design (iteration 2 — 2026-05-10):
//   • Active state is a SOLID sage-green pill behind the icon+label, not a
//     thin top bar. This matches Sling / Toast / Apple's Human Interface
//     Guidelines for tab bars and reads as "selected" at a glance from
//     across the kitchen.
//   • Backdrop blur on the nav itself (bg-white/85 backdrop-blur-md) so
//     content doesn't visually jam against a hard line — feels native iOS.
//   • Icons sized text-2xl (24px) — was text-xl (20px); now in the comfort
//     zone for tap-target perception.
//   • Composite emoji avoided. The original 🧑‍🍳 (man + cooking) is a multi-
//     codepoint sequence that renders as separate characters or oddly on
//     many Android devices. Recipes uses 📖 instead — universal.
//
// Tab strategy (5 slots):
//   1. 🏠 Home
//   2. 📅 Schedule  (badge: draft shifts)
//   3. Operations OR Recipes  (gated; falls back to 🍜 Menu)
//   4. 🚫 86 Board  (badge: 86 count)
//   5. ⋯ More       (opens the side drawer with everything else + Lock)
//
// Safe area: parent uses bottom-nav-safe so the bar sits above the iPhone
// home indicator. z-40 — modals (z-50) layer above this; sidebar (z-40)
// equal but the drawer scrim covers the nav too while it's open.

import { useMemo } from 'react';
import {
    Home,
    Calendar,
    ClipboardList,
    BookOpen,
    UtensilsCrossed,
    GraduationCap,
    Ban,
    MoreHorizontal,
} from 'lucide-react';
import { useAppData } from './AppDataContext';

export default function MobileBottomNav({
    language,
    activeTab,
    onNavigate,
    onMoreClick,
    storeLocation = 'webster',
    staffName = '',
    hasOpsAccess = true,
    hasRecipesAccess = true,
    hiddenPages = [],
}) {
    const isEs = language === 'es';

    // FIX (review 2026-05-14, perf): read from the shared AppDataContext
    // instead of three component-local Firestore subscriptions. The
    // provider mounts in AppShellV2 and owns one listener per data
    // stream; every consumer reads the same in-memory snapshot.
    const { shifts14, eightySixByLoc, unreadCount: unreadNotifs } = useAppData();
    const draftCount = useMemo(() => {
        return shifts14.filter(sh =>
            sh.published === false &&
            (storeLocation === 'both' || sh.location === storeLocation)
        ).length;
    }, [shifts14, storeLocation]);
    const eighty6Count = useMemo(() => {
        const loc = storeLocation === 'both' ? 'webster' : storeLocation;
        return eightySixByLoc[loc]?.count || 0;
    }, [eightySixByLoc, storeLocation]);

    // Slot 3 — dynamic destination based on what the staffer can access.
    // 2026-05-27 — emoji icons (📋 / 📖 / 🍜 / 📚) replaced with Lucide
    // SVG components so the bar reads consistently across iOS / Android /
    // desktop. Lucide icons inherit currentColor + stroke width and
    // tree-shake cleanly with Vite.
    const slot3 = hasOpsAccess && !hiddenPages.includes('operations')
        ? { tab: 'operations', Icon: ClipboardList,    en: 'Ops',     es: 'Ops' }
        : hasRecipesAccess && !hiddenPages.includes('recipes')
        ? { tab: 'recipes',    Icon: BookOpen,         en: 'Recipes', es: 'Recetas' }
        : !hiddenPages.includes('menu')
        ? { tab: 'menu',       Icon: UtensilsCrossed,  en: 'Menu',    es: 'Menú' }
        : { tab: 'training',   Icon: GraduationCap,    en: 'Train',   es: 'Capac.' };

    // Five-slot tab bar with Lucide icon components for each tab.
    // Capital `Icon` so JSX renders it as a component, not a string.
    const tabs = [
        { tab: 'home',     Icon: Home,             en: 'Home',     es: 'Inicio',  badge: unreadNotifs, badgeTone: 'bg-dd-green' },
        { tab: 'schedule', Icon: Calendar,         en: 'Schedule', es: 'Horario', badge: draftCount,   badgeTone: 'bg-amber-500' },
        slot3,
        { tab: 'eighty6',  Icon: Ban,              en: '86',       es: '86',      badge: eighty6Count, badgeTone: 'bg-red-500' },
        { tab: '__more',   Icon: MoreHorizontal,   en: 'More',     es: 'Más' },
    ];

    // 2026-06-01 — Andrew: "make the bottom bar look like the apple
    // glass that is a floating button but locked at the bottom."
    //
    // Redesigned as a FLOATING Liquid Glass pill instead of an
    // edge-to-edge bar. Visual references: iOS 26 Liquid Glass tab
    // bars, iMessage floating composer, Apple Maps search pill.
    //
    // What changed vs the old design:
    //   • Edge-to-edge → floats with 12px margin on left + right
    //   • bottom: 0 → bottom: calc(safe-area + 8px) so it hovers above
    //     the iPhone home indicator instead of sitting on it
    //   • rounded-3xl (24px) corners for the pill silhouette
    //   • bg-white/70 + backdrop-blur-2xl (heavier blur, more
    //     translucent — Apple Liquid Glass spec)
    //   • Outer drop shadow + 1px highlight ring (Apple's glass-on-bg
    //     treatment — top edge looks glossy, bottom edge looks lifted)
    //   • Removed the top hairline border (would look broken on a
    //     floating element with rounded corners)
    //   • Removed the absolute -top-2 active accent bar — it sat
    //     OUTSIDE the rounded pill and looked detached. The bg-dd-sage
    //     pill behind the active icon already reads "selected".
    //
    // Lock-down still in place:
    //   • position: fixed (z-40)
    //   • capacitor-native body class disables WKWebView rubber-band
    //     (see index.css — prevents the bar from being dragged by
    //     elastic overscroll)
    //   • GPU layer pin (translateZ + isolation + contain) on the
    //     .ddmau-mobile-bottom-nav class — no jitter during scroll.
    //
    // 2026-06-02 round 2 — Andrew (wrapped iOS app): "the bottom bar
    // at the bottom doesnt work anymore. non of the buttons click
    // anymore. only in the app version."
    //
    // Earlier today I tried portaling the nav out to document.body to
    // fix a Schedule scroll-drag issue. In the wrapped Capacitor iOS
    // app that broke click handling on every button — the portaled
    // node was a direct child of body (which has position:fixed +
    // overflow:hidden in capacitor-native) and WKWebView's hit-
    // testing didn't reach it. The web build was fine but the
    // wrapped app lost the entire bottom nav.
    //
    // Reverted to the original return-inline pattern. The Schedule
    // scroll-drag (#root scroll layer becoming the containing block
    // for descendant position:fixed) will need a different fix —
    // probably swap -webkit-overflow-scrolling:touch off on #root in
    // capacitor-native CSS, or wire the nav as a sibling of #root
    // from main.jsx. Either way, NOT a portal.
    return (
        <nav
            // 2026-06-01 round 3 — Andrew sent the iOS 26 Apple Game Center
            // tab bar as reference. Key spec deltas from the round-2 build:
            //   • rounded-3xl → rounded-full (true pill silhouette with
            //     semicircular ends, matches Apple's iOS 26 Liquid Glass
            //     tab bars precisely)
            //   • bg-white/40 → bg-black/40 (dark glass — Apple's pattern,
            //     reads as deliberate floating chrome rather than a frosted
            //     white slab against the also-light home page)
            //   • Icon + label colours flipped to white tones (high
            //     contrast on the dark glass) — see below
            //   • Active state: bg-dd-sage-50 → bg-white/25 (Apple's
            //     translucent white pill behind the selected tab)
            //   • shadow alpha 0.25 → 0.4 (darker glass needs a darker
            //     drop shadow to lift off the page)
            //   • ring-white/50 → ring-white/15 (lighter highlight on
            //     a dark glass surface to mimic Apple's top edge)
            // 2026-06-01 round 4 — Andrew: "can you make it a little more
            // glass like." Cranked translucency + blur + saturation:
            //   • bg-black/40 → bg-black/25 (much more see-through, content
            //     behind the bar reads more visibly)
            //   • backdrop-blur-2xl → backdrop-blur-3xl (heavier frost)
            //   • backdrop-saturate-150 → backdrop-saturate-200 (stronger
            //     colour bleed from content behind — the Apple Liquid
            //     Glass signature)
            //   • ring-white/15 → ring-white/25 (slightly brighter top
            //     edge highlight against the more transparent body)
            className="ddmau-mobile-bottom-nav md:hidden left-3 right-3 z-40 rounded-full bg-black/25 backdrop-blur-3xl backdrop-saturate-200 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.4)] ring-1 ring-white/25"
            // 2026-06-01 round 2 — Andrew: "no it still moves and its not
            // clear." Stronger lockdown via INLINE styles (highest CSS
            // specificity, cannot be overridden by any cascade) PLUS a
            // hard transform: translate3d to force own GPU compositing
            // layer that the WKWebView can't drag during rubber-band
            // overscroll. touchAction:'manipulation' tells iOS the nav
            // is interactive and not part of the scroll surface.
            // Also dropped opacity to white/40 and added backdrop-
            // saturate-150 for the truly translucent Apple Liquid Glass
            // look — at /70 it was reading as a frosted white bar, not
            // glass.
            style={{
                position: 'fixed',
                // 2026-06-02 round 7 — Andrew "the bottom bar is not
                // working again. i see all the buttons but cant click."
                // Root cause: round 6 pulled the bar 30px BELOW the
                // safe area floor, deep into iOS's home-indicator
                // gesture zone. Apple's UIKit tab bars get away with
                // overlapping this zone because they live in NATIVE
                // chrome that iOS knows is interactive. Our bar lives
                // inside a WKWebView — iOS treats the bottom strip as
                // system gesture area and intercepts touches BEFORE
                // they reach the web content. Bar renders, no buttons
                // respond.
                //
                // 2026-06-02 round 8 — Andrew (after round 7 shipped):
                // "in the app store app the bottom bar is too high
                // dont bring it all the way down but slightly."
                //
                // Round 7 sat the bar at safe-area + 8px (well clear
                // of the gesture zone). That tested fine for taps but
                // visually read too high. Round 8 dips ~10px INTO the
                // gesture zone — just the upper edge of it, where
                // touches usually still register because the iOS home-
                // indicator swipe needs a distinct UPWARD motion to
                // activate. Taps (no motion) on the upper 10-15px of
                // the gesture zone reach the WebView most of the time.
                //
                // max(..., 0px) clamps for iPhones without home
                // indicator (older devices, env() = 0) so the bar
                // sits flush with screen bottom there, never pushed
                // off-screen by the subtraction.
                //
                // If Andrew reports taps stop working again after
                // this, the only safe move is back to round 7's
                // +8px and accept the visual height.
                bottom: 'max(calc(env(safe-area-inset-bottom, 0px) - 10px), 0px)',
                transform: 'translate3d(0, 0, 0)',
                WebkitTransform: 'translate3d(0, 0, 0)',
                willChange: 'transform',
                touchAction: 'manipulation',
            }}
            aria-label={isEs ? 'Navegación principal' : 'Primary navigation'}
        >
            <div className="grid grid-cols-5 px-2 py-2">
                {tabs.map((t) => {
                    const active = activeTab === t.tab;
                    const isMore = t.tab === '__more';
                    const showBadge = !isMore && t.badge > 0;
                    const Icon = t.Icon;
                    return (
                        <button
                            key={t.tab}
                            onClick={() => isMore ? onMoreClick?.() : onNavigate?.(t.tab)}
                            className="relative flex flex-col items-center justify-center py-1 gap-1 transition active:scale-95 group"
                            aria-current={active ? 'page' : undefined}
                            aria-label={isEs ? t.es : t.en}
                        >
                            {/* Icon pill — translucent white when active
                                (Apple iOS 26 pattern), transparent otherwise.
                                Slightly larger active state. */}
                            <span className={`relative flex items-center justify-center w-12 h-7 rounded-full transition-all duration-200 ${
                                active
                                    ? 'bg-white/25'
                                    : 'scale-95 group-active:bg-white/10'
                            }`}>
                                {/* Lucide SVG icon — inherits currentColor from
                                    the wrapping text-* class. White on the dark
                                    glass bar (matches Apple's design). Stroke
                                    width 2.25 reads "iconic but not chunky".
                                    Slight scale on active so the selected tab
                                    subtly grows. */}
                                <Icon
                                    size={22}
                                    strokeWidth={2.25}
                                    className={`transition-transform duration-glass-fast ease-glass-out ${active ? 'scale-110 text-white' : 'text-white/80'}`}
                                    aria-hidden="true"
                                />
                                {showBadge && (
                                    <span className={`absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full flex items-center justify-center text-[9px] font-black text-white ${t.badgeTone} ring-2 ring-black/40 tabular-nums`}>
                                        {t.badge > 9 ? '9+' : t.badge}
                                    </span>
                                )}
                            </span>
                            <span className={`text-[10px] leading-none tracking-tight transition-colors ${
                                active ? 'font-bold text-white' : 'font-semibold text-white/70'
                            }`}>
                                {isEs ? t.es : t.en}
                            </span>
                        </button>
                    );
                })}
            </div>
        </nav>
    );
}
