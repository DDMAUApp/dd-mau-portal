// V2 sidebar — grouped nav inspired by Sling. Persistent on desktop,
// drawer on mobile. Two visual modes:
//   - expanded (260px): icon + label + optional badge
//   - collapsed (72px): icon only, label as tooltip
//
// Active state = a 3px dd-green left bar + lighter charcoal background.
// Hover state = subtle wash.

const NAV_GROUPS = [
    {
        labelEn: 'WORKSPACE', labelEs: 'TRABAJO',
        items: [
            { tab: 'home',       icon: '🏠', en: 'Home',       es: 'Inicio' },
            { tab: 'schedule',   icon: '📅', en: 'Schedule',   es: 'Horario' },
            { tab: 'operations', icon: '📋', en: 'Operations', es: 'Operaciones' },
        ],
    },
    {
        labelEn: 'KITCHEN', labelEs: 'COCINA',
        items: [
            { tab: 'recipes', icon: '🧑‍🍳', en: 'Recipes',    es: 'Recetas' },
            { tab: 'menu',    icon: '🍜',   en: 'Menu',       es: 'Menú' },
            { tab: 'eighty6', icon: '🚫',   en: '86 Board',   es: 'Tablero 86' },
        ],
    },
    {
        labelEn: 'PEOPLE', labelEs: 'PERSONAL',
        items: [
            { tab: 'training', icon: '📚', en: 'Training',  es: 'Capacitación' },
            { tab: 'tardies',  icon: '⏰', en: 'Tardies',   es: 'Tardanzas' },
            { tab: 'handoff',  icon: '🤝', en: 'Handoff',   es: 'Entrega' },
        ],
    },
    {
        labelEn: 'BUSINESS', labelEs: 'NEGOCIO',
        items: [
            { tab: 'labor',     icon: '📊', en: 'Labor',         es: 'Labor' },
            { tab: 'orders',    icon: '🧾', en: 'Live Orders',   es: 'Órdenes en vivo' },
            { tab: 'invoices',  icon: '💵', en: 'Invoices',      es: 'Facturas' },
            { tab: 'catering',  icon: '🥘', en: 'Catering',      es: 'Catering' },
        ],
    },
    {
        labelEn: 'SETTINGS', labelEs: 'AJUSTES',
        items: [
            { tab: 'maintenance', icon: '🔧', en: 'Maintenance', es: 'Mantenimiento' },
            { tab: 'insurance',   icon: '📑', en: 'Insurance',   es: 'Seguro' },
            { tab: 'admin',       icon: '⚙️', en: 'Admin',       es: 'Admin' },
        ],
    },
];

export default function Sidebar({ language, activeTab, onNavigate, open, collapsed, onToggleCollapse }) {
    const isEs = language === 'es';
    const widthClass = collapsed ? 'w-[72px]' : 'w-[260px]';
    const positionClass = open
        ? 'translate-x-0'
        : '-translate-x-full md:translate-x-0';

    return (
        <aside
            className={`fixed top-0 left-0 z-40 h-screen bg-dd-charcoal text-white flex flex-col transition-all duration-200 ${widthClass} ${positionClass}`}
        >
            {/* Logo header strip — entire 64px top of the sidebar is WHITE,
                like a header bar. Logo (dark line art on transparent) sits on
                it naturally, no inversion needed. Collapsed mode shows a green
                DD badge centered. Visually echoes the white cards on the home
                page so the brand mark feels consistent across surfaces. */}
            <div className="h-24 flex items-center justify-between px-3 bg-white shrink-0">
                {collapsed ? (
                    <div className="w-11 h-11 mx-auto rounded-lg bg-dd-green flex items-center justify-center text-white font-black text-lg shrink-0">
                        DD
                    </div>
                ) : (
                    <div className="flex-1 flex items-center justify-center min-w-0 px-1">
                        <img
                            src={(import.meta.env.BASE_URL || '/') + 'dd-mau-logo.png'}
                            alt="DD Mau Vietnamese Eatery"
                            className="max-h-20 w-auto object-contain"
                            onError={(e) => {
                                e.target.style.display = 'none';
                                if (e.target.parentElement) {
                                    e.target.parentElement.innerHTML =
                                        '<div class="text-dd-charcoal text-sm font-black tracking-wider">DD MAU</div>' +
                                        '<div class="text-dd-text-2 text-[8px] font-bold tracking-widest">VIETNAMESE EATERY</div>';
                                }
                            }}
                        />
                    </div>
                )}
                {!collapsed && (
                    <button onClick={onToggleCollapse}
                        className="ml-2 hidden md:flex w-7 h-7 items-center justify-center rounded text-dd-text-2 hover:text-dd-text hover:bg-dd-bg"
                        title="Collapse sidebar">
                        ◀
                    </button>
                )}
            </div>

            {/* Collapse toggle (collapsed mode) */}
            {collapsed && (
                <button onClick={onToggleCollapse}
                    className="hidden md:flex h-8 mx-2 mt-2 items-center justify-center rounded text-white/40 hover:text-white hover:bg-dd-charcoal-2"
                    title="Expand sidebar">
                    ▶
                </button>
            )}

            {/* Nav groups */}
            <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
                {NAV_GROUPS.map(group => (
                    <div key={group.labelEn}>
                        {!collapsed && (
                            <div className="text-[10px] font-bold tracking-widest text-white/40 px-3 mb-1.5">
                                {isEs ? group.labelEs : group.labelEn}
                            </div>
                        )}
                        <div className="space-y-0.5">
                            {group.items.map(item => {
                                const active = activeTab === item.tab;
                                return (
                                    <button
                                        key={item.tab}
                                        onClick={() => onNavigate?.(item.tab)}
                                        title={collapsed ? (isEs ? item.es : item.en) : undefined}
                                        className={`w-full group relative flex items-center ${collapsed ? 'justify-center px-2' : 'px-3 gap-3'} py-2 rounded-lg text-sm font-medium transition ${active
                                            ? 'bg-dd-charcoal-2 text-white'
                                            : 'text-white/70 hover:bg-dd-charcoal-2 hover:text-white'}`}
                                    >
                                        {active && (
                                            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-6 bg-dd-green rounded-r" />
                                        )}
                                        <span className="text-base shrink-0">{item.icon}</span>
                                        {!collapsed && <span className="truncate">{isEs ? item.es : item.en}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </nav>

            {/* Footer — version + log out */}
            <div className="border-t border-dd-charcoal-2 p-3 shrink-0">
                {!collapsed && (
                    <div className="text-[10px] text-white/40 mb-2 px-1">
                        Shih Technology · v2-preview
                    </div>
                )}
                <button className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-2 px-3'} py-2 rounded-lg text-sm font-medium text-white/70 hover:bg-dd-charcoal-2 hover:text-white transition`}>
                    <span>🚪</span>
                    {!collapsed && <span>{isEs ? 'Salir' : 'Log out'}</span>}
                </button>
            </div>
        </aside>
    );
}
