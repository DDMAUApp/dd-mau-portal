import { useAppData } from './AppDataContext';

// V2 header — Toast/Sling-style mission-control strip.
//
// 2026-05-10 designer pass: tightened proportions, refined the location
// pill (now a smaller ghost button instead of a full pill), cleaner
// avatar treatment (no subtitle on mobile — it was visual noise), and
// added subtle layered shadow on scroll-stickying for depth.
//
// Desktop (md+): full 64px strip with breadcrumb, location pill, search,
//   lang toggle, bell, avatar, lock, escape hatch.
// Mobile (<md): 56px slim strip, content row pushed below iPhone notch
//   via env(safe-area-inset-top) on padding.
//
// All tap targets ≥44×44 on mobile per Apple HIG.

const LOCATIONS = [
    { id: 'webster',  enLabel: 'Webster Groves',   esLabel: 'Webster Groves',   short: 'Webster' },
    { id: 'maryland', enLabel: 'Maryland Heights', esLabel: 'Maryland Heights', short: 'Maryland' },
    { id: 'both',     enLabel: 'Both Locations',   esLabel: 'Ambas',            short: 'Both' },
];

export default function Header({
    language, staffName, storeLocation = 'webster',
    onMenuClick, onLanguageToggle, onLogout, onLocationChange, onBellClick,
}) {
    const isEs = language === 'es';
    const initials = (staffName || 'U')
        .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    // Live unread-notification count for the bell badge.
    // FIX (review 2026-05-14, perf): read from the shared AppDataContext
    // instead of opening a per-component Firestore listener. The provider
    // owns one notifications subscription that every consumer reads from.
    const { unreadCount } = useAppData();
    const loc = LOCATIONS.find(l => l.id === storeLocation) || LOCATIONS[0];
    const fullLabel = isEs ? loc.esLabel : loc.enLabel;
    const shortLabel = loc.short;

    return (
        // Background extends INTO the iPhone safe area; content row gets
        // pushed below the notch via padding-top: env(safe-area-inset-top).
        <header
            className="sticky top-0 z-20 bg-white/90 backdrop-blur-xl border-b border-dd-line/80"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
            <div className="h-14 md:h-16 px-3 sm:px-6 flex items-center gap-2 md:gap-3">

                {/* MOBILE LEFT — refined location pill. Smaller, ghost-style,
                    so it doesn't feel like a primary button. Just enough
                    chrome to read as tappable. */}
                <button
                    onClick={() => onLocationChange?.()}
                    className="md:hidden flex items-center gap-1.5 min-h-[44px] px-2 -mx-1 rounded-lg active:bg-dd-bg transition group"
                    aria-label={isEs ? 'Cambiar ubicación' : 'Switch location'}
                    title={isEs ? 'Cambiar ubicación' : 'Switch location'}
                >
                    <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-dd-green opacity-30"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-dd-green"></span>
                    </span>
                    <span className="text-sm font-bold text-dd-text leading-none">
                        <span className="sm:hidden">{shortLabel}</span>
                        <span className="hidden sm:inline">{fullLabel}</span>
                    </span>
                    <span className="text-dd-text-2/50 text-[10px] leading-none group-active:text-dd-text-2">▾</span>
                </button>

                {/* DESKTOP LEFT — breadcrumb */}
                <div className="hidden md:flex items-center gap-2 text-sm">
                    <span className="text-dd-text-2 font-medium">{isEs ? 'Inicio' : 'Home'}</span>
                </div>

                {/* DESKTOP CENTER — location pill (centered, prominent).
                    Search bar removed: it was a non-functional placeholder
                    (no command-palette wired). Will be re-added when ⌘K
                    search ships. */}
                <div className="hidden md:flex flex-1 justify-center items-center gap-2 max-w-3xl mx-auto">
                    <button
                        onClick={() => onLocationChange?.()}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-dd-bg border border-dd-line text-sm font-semibold text-dd-text hover:bg-dd-sage-50 active:scale-95 transition">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-dd-green opacity-30"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-dd-green"></span>
                        </span>
                        <span>{fullLabel}</span>
                        <span className="text-dd-text-2 text-xs">▾</span>
                    </button>
                </div>

                {/* RIGHT — actions. Compact on mobile, all ≥44×44. Order
                    follows usage frequency: most-used (bell) closest to
                    avatar; rare ones (lang toggle) further out. */}
                <div className="ml-auto flex items-center gap-0.5 md:gap-1">
                    <button onClick={onLanguageToggle}
                        className="hidden sm:flex min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg items-center justify-center text-dd-text-2 hover:bg-dd-bg active:bg-dd-bg active:scale-95 text-xs font-bold transition"
                        title={isEs ? 'Cambiar idioma' : 'Switch language'}
                        aria-label={isEs ? 'Cambiar idioma' : 'Switch language'}>
                        {language === 'es' ? 'ES' : 'EN'}
                    </button>
                    {onLogout && (
                        <button onClick={onLogout}
                            className="min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-red-50 hover:text-red-700 active:bg-red-100 active:scale-95 transition"
                            title={isEs ? 'Bloquear / Salir' : 'Lock / Log out'}
                            aria-label={isEs ? 'Bloquear / Salir' : 'Lock / Log out'}>
                            <span className="text-[15px] md:text-base">🔒</span>
                        </button>
                    )}
                    <button onClick={onBellClick}
                        className="relative min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg active:bg-dd-bg active:scale-95 transition"
                        title={isEs ? `Notificaciones${unreadCount > 0 ? ` (${unreadCount})` : ''}` : `Notifications${unreadCount > 0 ? ` (${unreadCount})` : ''}`}
                        aria-label={isEs ? 'Notificaciones' : 'Notifications'}>
                        <span className="text-base">🔔</span>
                        {unreadCount > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-black flex items-center justify-center ring-2 ring-white">
                                {unreadCount > 9 ? '9+' : unreadCount}
                            </span>
                        )}
                    </button>
                    {/* AVATAR — clean disc, no subtitle on mobile (was noise).
                        Desktop gets the name + role label. */}
                    <div className="flex items-center gap-2 md:pl-2 md:border-l md:border-dd-line">
                        <div className="w-8 h-8 md:w-9 md:h-9 rounded-full bg-dd-green text-white flex items-center justify-center text-[13px] md:text-sm font-bold shrink-0 shadow-sm">
                            {initials}
                        </div>
                        <div className="hidden lg:block min-w-0 max-w-[140px]">
                            <div className="text-sm font-semibold text-dd-text leading-tight truncate">{staffName || 'You'}</div>
                            <div className="text-[10px] text-dd-text-2 leading-tight">{staffName ? 'Signed in' : 'Guest'}</div>
                        </div>
                    </div>
                </div>
            </div>
        </header>
    );
}
