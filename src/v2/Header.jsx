// V2 header — Toast-style mission-control strip.
//
// Desktop (md+): full 64px strip with breadcrumb, location pill, search,
//   lang toggle, bell, avatar, lock, and v1 escape hatch.
//
// Mobile (<md): slim 56px strip. The bottom nav handles primary navigation,
//   so the header is purely contextual:
//     LEFT  : current location (compact, tappable to switch)
//     RIGHT : language toggle + bell + avatar + 🔒 lock
//   No hamburger (nav lives at the bottom). No brand mark (logo lives in
//   the More drawer). No search (search lives in the More drawer).
//
// All tap targets ≥44×44 on mobile per Apple HIG / a11y minimums.

const LOCATIONS = [
    { id: 'webster',  enLabel: 'Webster Groves', esLabel: 'Webster Groves', short: 'Webster' },
    { id: 'maryland', enLabel: 'Maryland Heights', esLabel: 'Maryland Heights', short: 'Maryland' },
    { id: 'both',     enLabel: 'Both Locations', esLabel: 'Ambas', short: 'Both' },
];

export default function Header({
    language, staffName, storeLocation = 'webster',
    onMenuClick, onLanguageToggle, onLogout, onLocationChange,
}) {
    const isEs = language === 'es';
    const initials = (staffName || 'U')
        .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const loc = LOCATIONS.find(l => l.id === storeLocation) || LOCATIONS[0];
    const fullLabel = isEs ? loc.esLabel : loc.enLabel;
    const shortLabel = loc.short;

    return (
        <header className="sticky top-0 z-20 h-14 md:h-16 bg-white/95 backdrop-blur-md border-b border-dd-line">
            <div className="h-full px-2 sm:px-6 flex items-center gap-1 md:gap-3">

                {/* MOBILE LEFT — location pill. Tappable to cycle through
                    available locations. Shows the dot+short name; expands
                    to full name on slightly wider phones (sm+). */}
                <button
                    onClick={() => onLocationChange?.()}
                    className="md:hidden flex items-center gap-1.5 min-h-[44px] px-2.5 rounded-lg active:bg-dd-bg transition"
                    aria-label={isEs ? 'Cambiar ubicación' : 'Switch location'}
                    title={isEs ? 'Cambiar ubicación' : 'Switch location'}
                >
                    <span className="w-2 h-2 rounded-full bg-dd-green shrink-0" />
                    <span className="text-sm font-bold text-dd-text leading-none truncate max-w-[140px]">
                        <span className="sm:hidden">{shortLabel}</span>
                        <span className="hidden sm:inline">{fullLabel}</span>
                    </span>
                    <span className="text-dd-text-2 text-xs leading-none">▾</span>
                </button>

                {/* DESKTOP LEFT — breadcrumb */}
                <div className="hidden md:flex items-center gap-2 text-sm">
                    <span className="text-dd-text-2">{isEs ? 'Inicio' : 'Home'}</span>
                </div>

                {/* DESKTOP CENTER — location pill + search bar (hidden on mobile) */}
                <div className="hidden md:flex flex-1 justify-center items-center gap-2 max-w-3xl mx-auto">
                    <button
                        onClick={() => onLocationChange?.()}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-dd-bg border border-dd-line text-sm font-medium text-dd-text hover:bg-dd-sage-50 transition">
                        <span className="w-2 h-2 rounded-full bg-dd-green" />
                        <span>{fullLabel}</span>
                        <span className="text-dd-text-2 text-xs">▾</span>
                    </button>
                    <div className="flex-1 max-w-md relative">
                        <input
                            type="text"
                            placeholder={isEs ? 'Buscar… (⌘K)' : 'Search… (⌘K)'}
                            className="w-full pl-9 pr-3 py-2 rounded-lg bg-dd-bg border border-dd-line text-sm placeholder:text-dd-text-2 focus:outline-none focus:bg-white focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition"
                        />
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dd-text-2 text-sm">🔍</span>
                    </div>
                </div>

                {/* RIGHT — wide on desktop, compact on mobile. All ≥44px. */}
                <div className="ml-auto flex items-center gap-0.5 md:gap-1">
                    {/* Lock — visible on mobile too, mirrored from desktop. The
                        most important "where do I get back to PIN" affordance.
                        Red on hover so it always reads as a "leave / sign out"
                        action, not a settings toggle. */}
                    {onLogout && (
                        <button onClick={onLogout}
                            className="min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-red-50 hover:text-red-700 active:bg-red-100 active:scale-95 transition"
                            title={isEs ? 'Bloquear / Salir' : 'Lock / Log out'}
                            aria-label={isEs ? 'Bloquear / Salir' : 'Lock / Log out'}>
                            <span className="text-[16px] md:text-base">🔒</span>
                        </button>
                    )}
                    <button onClick={onLanguageToggle}
                        className="min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg active:bg-dd-bg active:scale-95 text-xs font-bold transition"
                        title={isEs ? 'Cambiar idioma' : 'Switch language'}
                        aria-label={isEs ? 'Cambiar idioma' : 'Switch language'}>
                        {language === 'es' ? 'ES' : 'EN'}
                    </button>
                    <button className="relative min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg active:bg-dd-bg active:scale-95 transition"
                        title={isEs ? 'Notificaciones' : 'Notifications'}
                        aria-label={isEs ? 'Notificaciones' : 'Notifications'}>
                        <span className="text-base">🔔</span>
                        <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-red-500" />
                    </button>
                    <div className="flex items-center gap-2 md:pl-2 md:border-l md:border-dd-line">
                        <div className="w-9 h-9 rounded-full bg-dd-green text-white flex items-center justify-center text-sm font-bold shrink-0">
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
