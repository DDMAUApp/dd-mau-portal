// V2 header — Toast-style mission-control strip. Sticky top, 64px tall.
//
// Three zones:
//   left:   hamburger (mobile) + breadcrumb
//   center: location pill + global search
//   right:  language toggle + notification bell + avatar

export default function Header({ language, staffName, onMenuClick, onExitV2 }) {
    const isEs = language === 'es';
    const initials = (staffName || 'U')
        .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

    return (
        <header className="sticky top-0 z-20 h-16 bg-white border-b border-dd-line">
            <div className="h-full px-4 sm:px-6 flex items-center gap-3">
                {/* Left zone */}
                <button onClick={onMenuClick}
                    className="md:hidden w-9 h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg">
                    ☰
                </button>
                <div className="hidden sm:flex items-center gap-2 text-sm">
                    <span className="text-dd-text-2">{isEs ? 'Inicio' : 'Home'}</span>
                </div>

                {/* Center zone (grows) */}
                <div className="flex-1 flex justify-center items-center gap-2 max-w-3xl mx-auto">
                    {/* Location switcher pill */}
                    <button className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-dd-bg border border-dd-line text-sm font-medium text-dd-text hover:bg-dd-sage-50 transition">
                        <span className="w-2 h-2 rounded-full bg-dd-green" />
                        <span>Webster Groves</span>
                        <span className="text-dd-text-2 text-xs">▾</span>
                    </button>
                    {/* Search */}
                    <div className="flex-1 max-w-md relative">
                        <input
                            type="text"
                            placeholder={isEs ? 'Buscar… (⌘K)' : 'Search… (⌘K)'}
                            className="w-full pl-9 pr-3 py-2 rounded-lg bg-dd-bg border border-dd-line text-sm placeholder:text-dd-text-2 focus:outline-none focus:bg-white focus:border-dd-green focus:ring-2 focus:ring-dd-green-50 transition"
                        />
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dd-text-2 text-sm">🔍</span>
                    </div>
                </div>

                {/* Right zone */}
                <button className="w-9 h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg text-xs font-bold"
                    title={isEs ? 'Idioma' : 'Language'}>
                    {language === 'es' ? 'ES' : 'EN'}
                </button>
                <button className="relative w-9 h-9 rounded-lg flex items-center justify-center text-dd-text-2 hover:bg-dd-bg"
                    title={isEs ? 'Notificaciones' : 'Notifications'}>
                    🔔
                    <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500" />
                </button>
                <div className="flex items-center gap-2 pl-2 border-l border-dd-line">
                    <div className="w-9 h-9 rounded-full bg-dd-green text-white flex items-center justify-center text-sm font-bold">
                        {initials}
                    </div>
                    <div className="hidden lg:block min-w-0 max-w-[140px]">
                        <div className="text-sm font-semibold text-dd-text leading-tight truncate">{staffName || 'You'}</div>
                        <div className="text-[10px] text-dd-text-2 leading-tight">Admin</div>
                    </div>
                </div>
                {onExitV2 && (
                    <button onClick={onExitV2}
                        className="ml-2 px-3 py-1.5 rounded-lg text-xs font-bold bg-dd-bg border border-dd-line text-dd-text-2 hover:bg-dd-sage-50">
                        ← v1
                    </button>
                )}
            </div>
        </header>
    );
}
