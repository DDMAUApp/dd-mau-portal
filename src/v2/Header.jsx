// V2 header — Toast-style mission-control strip.
//
// Desktop (md+): full 64px strip with hamburger, location pill, search, lang,
//   bell, avatar, and v1 escape hatch.
// Mobile (<md): slim 56px strip with brand+location summary on the left, lang
//   toggle + bell + avatar on the right. The hamburger is gone — primary nav
//   moved to the bottom (MobileBottomNav). Search bar is hidden too — search
//   moves to the More drawer.
//
// All tap targets are ≥44px on mobile (Apple HIG / a11y minimum). The compact
// look is achieved with smaller icons, not smaller hit areas.

export default function Header({ language, staffName, storeLocation = 'webster', onMenuClick, onExitV2, onLanguageToggle, onLogout }) {
    const isEs = language === 'es';
    const initials = (staffName || 'U')
        .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const locationLabel = storeLocation === 'maryland' ? (isEs ? 'Maryland' : 'Maryland Heights')
                        : storeLocation === 'both'     ? (isEs ? 'Ambas' : 'Both')
                        :                                (isEs ? 'Webster' : 'Webster Groves');

    return (
        <header className="sticky top-0 z-20 h-14 md:h-16 bg-white border-b border-dd-line">
            <div className="h-full px-3 sm:px-6 flex items-center gap-2 md:gap-3">

                {/* MOBILE LEFT — brand + location summary, replaces hamburger
                    (primary nav lives at the bottom now). Tappable area opens
                    the location switcher (currently a no-op stub). */}
                <button className="md:hidden flex items-center gap-2 min-h-[44px] min-w-[44px] px-2 -mx-2 rounded-lg active:bg-dd-bg transition">
                    <span className="w-7 h-7 rounded-md bg-dd-green flex items-center justify-center text-white font-black text-xs">DD</span>
                    <div className="flex flex-col items-start min-w-0">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 leading-none">{isEs ? 'Local' : 'Location'}</span>
                        <span className="text-xs font-bold text-dd-text leading-tight truncate max-w-[110px]">{locationLabel}</span>
                    </div>
                </button>

                {/* DESKTOP LEFT — breadcrumb (hidden on mobile, replaced by brand strip above) */}
                <div className="hidden md:flex items-center gap-2 text-sm">
                    <span className="text-dd-text-2">{isEs ? 'Inicio' : 'Home'}</span>
                </div>

                {/* DESKTOP CENTER — location pill + search bar (hidden on mobile;
                    location moves to the brand strip and search moves to More) */}
                <div className="hidden md:flex flex-1 justify-center items-center gap-2 max-w-3xl mx-auto">
                    <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-dd-bg border border-dd-line text-sm font-medium text-dd-text hover:bg-dd-sage-50 transition">
                        <span className="w-2 h-2 rounded-full bg-dd-green" />
                        <span>{locationLabel}</span>
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

                {/* RIGHT — language + bell + avatar + lock. Mobile: ml-auto
                    pushes these to the right edge. All tap targets ≥44px. */}
                <div className="ml-auto flex items-center gap-1 md:gap-1">
                    <button onClick={onLanguageToggle}
                        className="min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg active:bg-dd-bg text-xs font-bold transition"
                        title={isEs ? 'Cambiar idioma' : 'Switch language'}
                        aria-label={isEs ? 'Cambiar idioma' : 'Switch language'}>
                        {language === 'es' ? 'ES' : 'EN'}
                    </button>
                    <button className="relative min-w-[44px] min-h-[44px] md:w-9 md:h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg active:bg-dd-bg transition"
                        title={isEs ? 'Notificaciones' : 'Notifications'}
                        aria-label={isEs ? 'Notificaciones' : 'Notifications'}>
                        <span className="text-base">🔔</span>
                        <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-red-500" />
                    </button>
                    <div className="flex items-center gap-2 md:pl-2 md:border-l md:border-dd-line">
                        <div className="w-9 h-9 md:w-9 md:h-9 rounded-full bg-dd-green text-white flex items-center justify-center text-sm font-bold shrink-0">
                            {initials}
                        </div>
                        <div className="hidden lg:block min-w-0 max-w-[140px]">
                            <div className="text-sm font-semibold text-dd-text leading-tight truncate">{staffName || 'You'}</div>
                            <div className="text-[10px] text-dd-text-2 leading-tight">{staffName ? 'Signed in' : 'Guest'}</div>
                        </div>
                    </div>
                    {/* Lock button — quick way back to the PIN screen without
                        opening the More drawer. Hidden on mobile (it's in the
                        bottom More drawer there) to keep the slim header tidy. */}
                    {onLogout && (
                        <button onClick={onLogout}
                            className="hidden md:flex min-w-[40px] min-h-[40px] ml-2 rounded-lg items-center justify-center text-dd-text-2 hover:bg-red-50 hover:text-red-700 active:bg-red-100 transition"
                            title={isEs ? 'Bloquear / Salir' : 'Lock / Log out'}
                            aria-label={isEs ? 'Bloquear / Salir' : 'Lock / Log out'}>
                            <span className="text-base">🔒</span>
                        </button>
                    )}
                    {onExitV2 && (
                        <button onClick={onExitV2}
                            className="hidden md:flex ml-2 px-3 py-1.5 rounded-lg text-xs font-bold bg-dd-bg border border-dd-line text-dd-text-2 hover:bg-dd-sage-50">
                            ← v1
                        </button>
                    )}
                </div>
            </div>
        </header>
    );
}
