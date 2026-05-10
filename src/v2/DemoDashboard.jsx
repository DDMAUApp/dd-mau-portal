// V2 demo dashboard — exercises every primitive of the new design system:
//   - StatCard (4-up grid, big number + delta + sparkline)
//   - ListCard (header + filter chips + scrollable list)
//   - ActionCard (title + body + primary CTA)
//   - Badge, Button (primary/secondary/ghost/danger), EmptyState, Skeleton
//
// Drop replacements for these primitives once we like the look. Each
// existing screen can then be ported screen-by-screen by wrapping the
// real data in the same card vocabulary.

// ── Primitives ─────────────────────────────────────────────────────────
function Card({ className = '', children, hover = false }) {
    return (
        <div className={`bg-dd-surface border border-dd-line rounded-xl shadow-card ${hover ? 'hover:shadow-card-hov transition-shadow' : ''} ${className}`}>
            {children}
        </div>
    );
}

function Button({ variant = 'primary', size = 'md', children, ...props }) {
    const sizes = {
        sm: 'px-3 py-1.5 text-xs',
        md: 'px-4 py-2 text-sm',
        lg: 'px-5 py-2.5 text-sm',
    };
    const variants = {
        primary:   'bg-dd-green text-white hover:bg-dd-green-700 shadow-sm',
        secondary: 'bg-dd-surface text-dd-text border border-dd-line hover:bg-dd-bg',
        ghost:     'bg-transparent text-dd-text-2 hover:text-dd-text hover:bg-dd-bg',
        danger:    'bg-red-600 text-white hover:bg-red-700 shadow-sm',
    };
    return (
        <button {...props}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition ${sizes[size]} ${variants[variant]}`}>
            {children}
        </button>
    );
}

function Badge({ tone = 'info', children }) {
    const tones = {
        success: 'bg-dd-green-50 text-dd-green-700',
        warn:    'bg-amber-50  text-amber-800 border border-amber-200',
        info:    'bg-blue-50   text-blue-700  border border-blue-200',
        danger:  'bg-red-50    text-red-700   border border-red-200',
        neutral: 'bg-dd-bg     text-dd-text-2 border border-dd-line',
    };
    return (
        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${tones[tone]}`}>
            {children}
        </span>
    );
}

// Tiny inline SVG sparkline. Pass an array of numbers.
function Sparkline({ data, color = '#1F7A4D', width = 100, height = 28 }) {
    if (!data || data.length === 0) return null;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = (max - min) || 1;
    const points = data.map((v, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - ((v - min) / range) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return (
        <svg width={width} height={height} className="block">
            <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function StatCard({ label, value, delta, deltaLabel, sparkData, sparkColor }) {
    const deltaPositive = delta && delta > 0;
    const deltaNeutral = delta === 0;
    return (
        <Card hover className="p-5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">{label}</div>
            <div className="flex items-end justify-between gap-3">
                <div>
                    <div className="text-3xl font-black text-dd-text leading-none tabular-nums">{value}</div>
                    {delta != null && (
                        <div className={`text-xs font-semibold mt-2 inline-flex items-center gap-1 ${deltaNeutral ? 'text-dd-text-2' : deltaPositive ? 'text-dd-green-700' : 'text-red-700'}`}>
                            <span>{deltaPositive ? '▲' : delta < 0 ? '▼' : '–'}</span>
                            <span>{Math.abs(delta)}{typeof delta === 'number' && delta % 1 === 0 ? '' : ''}{deltaLabel ? ` ${deltaLabel}` : '%'}</span>
                            <span className="text-dd-text-2 font-normal">vs last week</span>
                        </div>
                    )}
                </div>
                {sparkData && (
                    <div className="opacity-90">
                        <Sparkline data={sparkData} color={sparkColor || '#1F7A4D'} />
                    </div>
                )}
            </div>
        </Card>
    );
}

function SectionHeader({ title, subtitle, action }) {
    return (
        <div className="flex items-end justify-between mb-4">
            <div>
                <h2 className="text-lg font-bold text-dd-text">{title}</h2>
                {subtitle && <p className="text-xs text-dd-text-2 mt-0.5">{subtitle}</p>}
            </div>
            {action}
        </div>
    );
}

// ── Demo content ───────────────────────────────────────────────────────
const SAMPLE_SHIFTS = [
    { who: 'Maria Lopez',  role: 'FOH', date: 'Today',     time: '11:00 AM – 3:00 PM', tone: 'info' },
    { who: 'Carlos Diaz',  role: 'BOH', date: 'Today',     time: '10:00 AM – 6:00 PM', tone: 'info' },
    { who: 'Anh Nguyen',   role: 'Lead', date: 'Today',    time: '4:00 PM – 10:00 PM', tone: 'success' },
    { who: 'Jamal Carter', role: 'FOH', date: 'Tomorrow',  time: '11:00 AM – 4:00 PM', tone: 'neutral' },
    { who: 'Priya Shah',   role: 'BOH', date: 'Tomorrow',  time: '2:00 PM – 10:00 PM', tone: 'neutral' },
];

export default function DemoDashboard({ language = 'en', staffName = 'Andrew' }) {
    const isEs = language === 'es';

    return (
        <div className="space-y-8">
            {/* Welcome */}
            <div>
                <h1 className="text-2xl font-bold text-dd-text">
                    {isEs ? `Buenos días, ${staffName}` : `Good morning, ${staffName}`}
                </h1>
                <p className="text-sm text-dd-text-2 mt-1">
                    {isEs
                        ? 'Aquí está lo que está pasando en DD Mau hoy.'
                        : "Here's what's happening at DD Mau today."}
                </p>
            </div>

            {/* Stats grid */}
            <section>
                <SectionHeader
                    title={isEs ? 'Resumen de hoy' : "Today's overview"}
                    subtitle={isEs ? 'Datos en vivo desde Toast POS' : 'Live from Toast POS'}
                    action={<Button variant="ghost" size="sm">{isEs ? 'Ver todo' : 'View all'} →</Button>}
                />
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard label={isEs ? 'Ventas netas' : 'Net Sales'}
                        value="$3,847"
                        delta={8.2}
                        sparkData={[2400, 2800, 2600, 3100, 3300, 3200, 3847]}
                        sparkColor="#1F7A4D" />
                    <StatCard label={isEs ? 'Mano de obra' : 'Labor %'}
                        value="24.3%"
                        delta={-1.4}
                        sparkData={[28, 27, 26, 25, 27, 26, 24]}
                        sparkColor="#185E3A" />
                    <StatCard label={isEs ? 'Órdenes' : 'Orders'}
                        value="187"
                        delta={12}
                        deltaLabel="orders"
                        sparkData={[140, 155, 160, 170, 175, 180, 187]}
                        sparkColor="#2563EB" />
                    <StatCard label={isEs ? 'Borradores' : 'Drafts'}
                        value="14"
                        delta={0}
                        sparkData={[2, 5, 8, 12, 14, 14, 14]}
                        sparkColor="#F59E0B" />
                </div>
            </section>

            {/* Two-up: today's shifts list + action panel */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* Shifts list (2 cols wide) */}
                <Card className="lg:col-span-2 p-5">
                    <div className="flex items-center justify-between mb-4">
                        <div>
                            <h3 className="text-base font-bold text-dd-text">{isEs ? 'Turnos próximos' : 'Upcoming shifts'}</h3>
                            <p className="text-xs text-dd-text-2 mt-0.5">{isEs ? 'Próximos 2 días' : 'Next 2 days'}</p>
                        </div>
                        <div className="flex gap-1">
                            <button className="px-2.5 py-1 rounded-md text-xs font-semibold bg-dd-green text-white">{isEs ? 'Todos' : 'All'}</button>
                            <button className="px-2.5 py-1 rounded-md text-xs font-semibold text-dd-text-2 hover:bg-dd-bg">FOH</button>
                            <button className="px-2.5 py-1 rounded-md text-xs font-semibold text-dd-text-2 hover:bg-dd-bg">BOH</button>
                        </div>
                    </div>
                    <ul className="divide-y divide-dd-line">
                        {SAMPLE_SHIFTS.map((s, i) => (
                            <li key={i} className="flex items-center justify-between py-3">
                                <div className="flex items-center gap-3">
                                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold ${
                                        s.role === 'BOH' ? 'bg-amber-100 text-amber-800' :
                                        s.role === 'Lead' ? 'bg-dd-green-50 text-dd-green-700' :
                                        'bg-blue-50 text-blue-700'
                                    }`}>
                                        {s.who.split(' ').map(w => w[0]).join('')}
                                    </div>
                                    <div>
                                        <div className="text-sm font-semibold text-dd-text">{s.who}</div>
                                        <div className="text-xs text-dd-text-2">{s.date} · {s.time}</div>
                                    </div>
                                </div>
                                <Badge tone={s.tone}>{s.role}</Badge>
                            </li>
                        ))}
                    </ul>
                    <div className="pt-3 mt-1 border-t border-dd-line flex justify-between items-center">
                        <span className="text-xs text-dd-text-2">5 of 23 shifts this week</span>
                        <Button variant="ghost" size="sm">{isEs ? 'Ver horario completo' : 'View full schedule'} →</Button>
                    </div>
                </Card>

                {/* Action panel */}
                <Card className="p-5 bg-gradient-to-br from-dd-sage-50 to-dd-surface border-dd-sage">
                    <div className="text-2xl mb-2">📢</div>
                    <h3 className="text-base font-bold text-dd-text mb-1">
                        {isEs ? 'Publicar próxima semana' : 'Publish next week'}
                    </h3>
                    <p className="text-xs text-dd-text-2 mb-4">
                        {isEs
                            ? '14 turnos en borrador esperando lanzarse al equipo. Una vez publicados, los staff reciben push notifications.'
                            : '14 draft shifts waiting to release to your team. Once published, staff get push notifications instantly.'}
                    </p>
                    <Button variant="primary" size="md" className="w-full">
                        📢 {isEs ? 'Publicar 14 turnos' : 'Publish 14 shifts'}
                    </Button>
                    <button className="w-full mt-2 text-xs font-semibold text-dd-text-2 hover:text-dd-text">
                        {isEs ? 'Revisar primero →' : 'Review first →'}
                    </button>
                </Card>
            </section>

            {/* Quick alerts row */}
            <section>
                <SectionHeader title={isEs ? 'Necesita atención' : 'Needs attention'}
                    subtitle={isEs ? '3 elementos pendientes' : '3 items pending'} />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card hover className="p-4 flex items-start gap-3">
                        <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center shrink-0">⏰</div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                                <h4 className="text-sm font-bold text-dd-text truncate">{isEs ? '2 tardanzas hoy' : '2 tardies today'}</h4>
                                <Badge tone="warn">{isEs ? 'Revisar' : 'Review'}</Badge>
                            </div>
                            <p className="text-xs text-dd-text-2">Maria L. & Carlos D. — clocked in late</p>
                        </div>
                    </Card>
                    <Card hover className="p-4 flex items-start gap-3">
                        <div className="w-9 h-9 rounded-lg bg-red-50 text-red-700 flex items-center justify-center shrink-0">🚫</div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                                <h4 className="text-sm font-bold text-dd-text truncate">{isEs ? '4 artículos en 86' : '4 items 86\'d'}</h4>
                                <Badge tone="danger">86</Badge>
                            </div>
                            <p className="text-xs text-dd-text-2">Spring rolls, lemongrass chicken, +2</p>
                        </div>
                    </Card>
                    <Card hover className="p-4 flex items-start gap-3">
                        <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-700 flex items-center justify-center shrink-0">📨</div>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                                <h4 className="text-sm font-bold text-dd-text truncate">{isEs ? '1 PTO pendiente' : '1 PTO pending'}</h4>
                                <Badge tone="info">{isEs ? 'Aprobar' : 'Approve'}</Badge>
                            </div>
                            <p className="text-xs text-dd-text-2">Anh N. — Friday 5/16</p>
                        </div>
                    </Card>
                </div>
            </section>

            {/* Spec note */}
            <div className="mt-8 text-[11px] text-dd-text-2 border-t border-dd-line pt-4">
                <strong>v2 preview</strong> · brand colors: PMS 7730 C (primary green) + PMS 621 C (sage accent) · system font stack with Inter preferred · all screens to be ported into this shell · mobile responsive
            </div>
        </div>
    );
}
