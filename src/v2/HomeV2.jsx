// HomeV2 — real-data Home dashboard for the v2 shell.
//
// Live subscriptions to:
//   - ops/labor_{loc}        → labor %, net sales, total hours
//   - ops/86_{loc}           → 86'd item count + list
//   - shifts                 → drafts (this week, this side) + upcoming
//   - time_off               → pending PTO requests
//
// Stat cards + alerts row + upcoming shifts list + publish-week CTA.
// Fully responsive; cards stack 1-up on mobile, 2/4-up on larger.

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot, query, where } from 'firebase/firestore';
import { canViewLabor } from '../data/staff';

// ── Primitives ─────────────────────────────────────────────────────────
function Card({ className = '', children, hover = false, ...rest }) {
    return (
        <div {...rest}
            className={`bg-dd-surface border border-dd-line rounded-xl shadow-card ${hover ? 'hover:shadow-card-hov transition-shadow' : ''} ${className}`}>
            {children}
        </div>
    );
}

function Button({ variant = 'primary', size = 'md', className = '', children, ...props }) {
    const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' };
    const variants = {
        primary:   'bg-dd-green text-white hover:bg-dd-green-700 shadow-sm',
        secondary: 'bg-dd-surface text-dd-text border border-dd-line hover:bg-dd-bg',
        ghost:     'bg-transparent text-dd-text-2 hover:text-dd-text hover:bg-dd-bg',
        danger:    'bg-red-600 text-white hover:bg-red-700 shadow-sm',
    };
    return (
        <button {...props}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition ${sizes[size]} ${variants[variant]} ${className}`}>
            {children}
        </button>
    );
}

function Badge({ tone = 'info', children }) {
    const tones = {
        success: 'bg-dd-green-50 text-dd-green-700 border border-dd-green/30',
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

function Skeleton({ className = '' }) {
    return <div className={`bg-gray-100 animate-pulse rounded ${className}`} />;
}

function StatCard({ label, value, sub, tone, icon, loading }) {
    return (
        <Card hover className="p-5">
            <div className="flex items-start justify-between mb-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-dd-text-2">{label}</div>
                {icon && <div className="text-base opacity-70">{icon}</div>}
            </div>
            {loading ? (
                <Skeleton className="h-9 w-24 mt-2" />
            ) : (
                <div className={`text-3xl font-black leading-none tabular-nums ${tone || 'text-dd-text'}`}>{value}</div>
            )}
            {sub && <div className="text-xs text-dd-text-2 mt-2">{sub}</div>}
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

// ── Helpers ────────────────────────────────────────────────────────────
function fmtUSD(n) {
    if (!Number.isFinite(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
}
function fmtPct(n) {
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(1) + '%';
}
function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayKey(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtTime12h(t) {
    if (!t) return '';
    const [hh, mm] = String(t).split(':').map(Number);
    if (Number.isNaN(hh)) return t;
    const h = hh % 12 === 0 ? 12 : hh % 12;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    return `${h}:${String(mm || 0).padStart(2, '0')} ${ampm}`;
}
function dayLabel(dateStr, isEn) {
    const today = todayKey();
    const tomorrow = dayKey(1);
    if (dateStr === today) return isEn ? 'Today' : 'Hoy';
    if (dateStr === tomorrow) return isEn ? 'Tomorrow' : 'Mañana';
    const d = new Date(dateStr + 'T00:00');
    return d.toLocaleDateString(isEn ? 'en-US' : 'es', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Main component ─────────────────────────────────────────────────────
export default function HomeV2({ language = 'en', staffName = '', storeLocation = 'webster', staffList = [], onNavigate }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);

    // Resolve effective location for queries (multi-location admins might be 'both').
    const queryLoc = storeLocation === 'both' ? 'webster' : storeLocation;

    // ── Live data ──
    const [labor, setLabor] = useState({ loading: true, data: null });
    const [eighty6, setEighty6] = useState({ loading: true, count: 0, items: [] });
    const [shifts, setShifts] = useState({ loading: true, list: [] });
    const [pendingPto, setPendingPto] = useState([]);

    // Labor doc (current snapshot)
    useEffect(() => {
        setLabor({ loading: true, data: null });
        const unsub = onSnapshot(doc(db, 'ops', `labor_${queryLoc}`), (snap) => {
            setLabor({ loading: false, data: snap.exists() ? snap.data() : null });
        }, (err) => { console.warn('labor subscribe failed:', err); setLabor({ loading: false, data: null }); });
        return () => unsub();
    }, [queryLoc]);

    // 86 board
    useEffect(() => {
        setEighty6({ loading: true, count: 0, items: [] });
        const unsub = onSnapshot(doc(db, 'ops', `86_${queryLoc}`), (snap) => {
            const d = snap.exists() ? snap.data() : {};
            setEighty6({ loading: false, count: d.count || 0, items: d.items || [] });
        });
        return () => unsub();
    }, [queryLoc]);

    // Shifts: pull this week + next 7 days for stats and "upcoming" list.
    useEffect(() => {
        setShifts({ loading: true, list: [] });
        const start = todayKey();
        const end = dayKey(8);
        const q = query(collection(db, 'shifts'), where('date', '>=', start), where('date', '<', end));
        const unsub = onSnapshot(q, (snap) => {
            const list = [];
            snap.forEach(d => list.push({ id: d.id, ...d.data() }));
            setShifts({ loading: false, list });
        }, (err) => { console.warn('shifts subscribe failed:', err); setShifts({ loading: false, list: [] }); });
        return () => unsub();
    }, []);

    // Pending PTO requests (admins/managers see; otherwise irrelevant).
    useEffect(() => {
        const unsub = onSnapshot(collection(db, 'time_off'), (snap) => {
            const arr = [];
            snap.forEach(d => {
                const data = d.data();
                if (data.status === 'pending') arr.push({ id: d.id, ...data });
            });
            setPendingPto(arr);
        }, (err) => console.warn('time_off subscribe failed:', err));
        return () => unsub();
    }, []);

    // ── Derived ──
    const draftCount = useMemo(() =>
        shifts.list.filter(s => s.published === false && (storeLocation === 'both' || s.location === storeLocation)).length,
        [shifts.list, storeLocation]);

    const upcomingShifts = useMemo(() => {
        const today = todayKey();
        const cutoff = dayKey(2); // today + tomorrow
        return shifts.list
            .filter(s => s.date >= today && s.date < cutoff)
            .filter(s => s.published !== false)
            .filter(s => storeLocation === 'both' || s.location === storeLocation)
            .sort((a, b) =>
                a.date.localeCompare(b.date) ||
                (a.startTime || '').localeCompare(b.startTime || '')
            )
            .slice(0, 8);
    }, [shifts.list, storeLocation]);

    const greeting = (() => {
        const h = new Date().getHours();
        if (h < 12) return tx('Good morning', 'Buenos días');
        if (h < 18) return tx('Good afternoon', 'Buenas tardes');
        return tx('Good evening', 'Buenas noches');
    })();

    // Labor color by % vs target (same thresholds as LaborDashboard).
    const laborPct = labor.data?.laborPercent;
    const laborTone = laborPct == null ? 'text-dd-text'
        : laborPct <= 22 ? 'text-emerald-700'
        : laborPct <= 28 ? 'text-amber-700'
        : 'text-red-700';

    return (
        <div className="space-y-6">
            {/* Welcome */}
            <div>
                <h1 className="text-2xl font-bold text-dd-text">{greeting}, {staffName?.split(' ')[0] || tx('there', '')}</h1>
                <p className="text-sm text-dd-text-2 mt-1">
                    {tx(`Here's what's happening at DD Mau ${queryLoc === 'maryland' ? 'Maryland Heights' : 'Webster Groves'} today.`,
                        `Esto es lo que está pasando hoy en DD Mau ${queryLoc === 'maryland' ? 'Maryland Heights' : 'Webster Groves'}.`)}
                </p>
            </div>

            {/* Stats */}
            <section>
                <SectionHeader
                    title={tx("Today's overview", "Resumen de hoy")}
                    subtitle={tx('Live from Toast POS', 'En vivo desde Toast POS')}
                    action={<Button variant="ghost" size="sm" onClick={() => onNavigate?.('labor')}>{tx('Labor dashboard', 'Mano de obra')} →</Button>}
                />
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    {canViewLabor((staffList || []).find(s => s.name === staffName)) && (
                        <StatCard
                            label={tx('Labor %', 'Mano de obra')}
                            value={fmtPct(laborPct)}
                            tone={laborTone}
                            sub={labor.data?.updatedAt ? tx(`Updated ${minutesAgo(labor.data.updatedAt)} min ago`, `Actualizado hace ${minutesAgo(labor.data.updatedAt)} min`) : tx('Target 25%', 'Objetivo 25%')}
                            icon="📊"
                            loading={labor.loading} />
                    )}
                    <StatCard
                        label={tx('Total hours', 'Horas')}
                        value={labor.data?.totalHours != null ? labor.data.totalHours.toFixed(1) : '—'}
                        sub={tx('Clocked-in today', 'Marcadas hoy')}
                        icon="⏱"
                        loading={labor.loading} />
                    <StatCard
                        label={tx('86 items', 'Artículos en 86')}
                        value={eighty6.count}
                        tone={eighty6.count > 0 ? 'text-red-700' : 'text-dd-text'}
                        sub={eighty6.count > 0 ? tx('Tap to view', 'Toca para ver') : tx('All in stock ✓', 'Todo en stock ✓')}
                        icon="🚫"
                        loading={eighty6.loading} />
                    <StatCard
                        label={tx('Drafts', 'Borradores')}
                        value={draftCount}
                        tone={draftCount > 0 ? 'text-amber-700' : 'text-dd-text'}
                        sub={draftCount > 0 ? tx('Awaiting publish', 'Esperando publicar') : tx('Schedule released ✓', 'Horario liberado ✓')}
                        icon="📝"
                        loading={shifts.loading} />
                </div>
            </section>

            {/* Two-up row: shifts + publish CTA */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <Card className="lg:col-span-2 p-5">
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <h3 className="text-base font-bold text-dd-text">{tx('Upcoming shifts', 'Turnos próximos')}</h3>
                            <p className="text-xs text-dd-text-2">{tx('Today and tomorrow', 'Hoy y mañana')}</p>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => onNavigate?.('schedule')}>{tx('Open schedule', 'Abrir horario')} →</Button>
                    </div>
                    {shifts.loading ? (
                        <div className="space-y-2">
                            {[1,2,3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
                        </div>
                    ) : upcomingShifts.length === 0 ? (
                        <div className="text-center py-8">
                            <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-dd-bg flex items-center justify-center text-xl text-dd-text-2/60">
                                📅
                            </div>
                            <p className="text-sm font-semibold text-dd-text">{tx('No published shifts', 'Sin turnos publicados')}</p>
                            <p className="text-xs text-dd-text-2 mt-0.5">{tx('Today and tomorrow look clear.', 'Hoy y mañana están libres.')}</p>
                        </div>
                    ) : (
                        <ul className="divide-y divide-dd-line">
                            {upcomingShifts.map(s => {
                                const staff = staffList.find(x => x.name === s.staffName);
                                const isBoh = s.side === 'boh' || (staff?.scheduleSide === 'boh');
                                return (
                                    <li key={s.id} className="flex items-center justify-between py-3">
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${isBoh ? 'bg-amber-100 text-amber-800' : 'bg-blue-50 text-blue-700'}`}>
                                                {(s.staffName || '??').split(' ').map(w => w[0]).join('').slice(0, 2)}
                                            </div>
                                            <div className="min-w-0">
                                                <div className="text-sm font-semibold text-dd-text truncate">{s.staffName || tx('Unassigned', 'Sin asignar')}</div>
                                                <div className="text-xs text-dd-text-2">
                                                    {dayLabel(s.date, isEn)} · {fmtTime12h(s.startTime)} – {fmtTime12h(s.endTime)}
                                                </div>
                                            </div>
                                        </div>
                                        <Badge tone={isBoh ? 'warn' : 'info'}>{isBoh ? 'BOH' : 'FOH'}</Badge>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </Card>

                {/* Publish CTA — solid sage tint when there are drafts to
                    drive attention; when zero, downgrades to a calm "all
                    caught up" surface so it doesn't shout. The previous
                    megaphone emoji at small size rendered as a smudge —
                    using a clean checkmark / megaphone disc instead. */}
                <Card className={`p-5 ${draftCount > 0 ? 'bg-gradient-to-br from-amber-50 to-dd-surface border-amber-200' : 'bg-gradient-to-br from-dd-sage-50 to-dd-surface border-dd-sage/40'}`}>
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl mb-3 ${draftCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-dd-green-50 text-dd-green-700'}`}>
                        {draftCount > 0 ? '📢' : '✓'}
                    </div>
                    <h3 className="text-base font-bold text-dd-text mb-1">
                        {draftCount > 0
                            ? tx(`${draftCount} draft shift${draftCount === 1 ? '' : 's'}`, `${draftCount} borrador${draftCount === 1 ? '' : 'es'}`)
                            : tx('All caught up', 'Todo al día')}
                    </h3>
                    <p className="text-xs text-dd-text-2 mb-4">
                        {draftCount > 0
                            ? tx('Publish to release them to your team. Staff get push notifications instantly.',
                                 'Publica para liberarlos al equipo. El staff recibe notificaciones al instante.')
                            : tx('No drafts to publish. Add new shifts in Schedule.',
                                 'Sin borradores. Agrega turnos en Horario.')}
                    </p>
                    <Button variant={draftCount > 0 ? 'primary' : 'secondary'}
                        size="md"
                        className="w-full"
                        onClick={() => onNavigate?.('schedule')}>
                        {draftCount > 0
                            ? tx('Review & publish', 'Revisar y publicar')
                            : tx('Open schedule', 'Abrir horario')}
                    </Button>
                </Card>
            </section>

            {/* Needs attention row */}
            <section>
                <SectionHeader
                    title={tx('Needs attention', 'Necesita atención')}
                    subtitle={tx('Live alerts across the operation', 'Alertas en vivo')} />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <AlertCard
                        icon="🚫"
                        tone="danger"
                        loading={eighty6.loading}
                        title={eighty6.count > 0
                            ? tx(`${eighty6.count} item${eighty6.count === 1 ? '' : 's'} 86'd`, `${eighty6.count} en 86`)
                            : tx('No 86 items', 'Sin 86')}
                        body={eighty6.count > 0
                            ? eighty6.items.slice(0, 3).map(i => i.name || i).join(', ') + (eighty6.count > 3 ? ', +' + (eighty6.count - 3) : '')
                            : tx('All menu items available', 'Menú completo disponible')}
                        badgeText={eighty6.count > 0 ? '86' : '✓'}
                        badgeTone={eighty6.count > 0 ? 'danger' : 'success'}
                        onClick={() => onNavigate?.('eighty6')} />
                    <AlertCard
                        icon="📅"
                        tone="warn"
                        loading={shifts.loading}
                        title={draftCount > 0
                            ? tx(`${draftCount} unpublished shift${draftCount === 1 ? '' : 's'}`, `${draftCount} sin publicar`)
                            : tx('Schedule published', 'Horario publicado')}
                        body={draftCount > 0
                            ? tx('Staff hasn\'t been notified yet — review in Schedule.', 'El staff aún no fue notificado.')
                            : tx('All shifts released to staff.', 'Todos los turnos liberados.')}
                        badgeText={draftCount > 0 ? tx('Review', 'Revisar') : '✓'}
                        badgeTone={draftCount > 0 ? 'warn' : 'success'}
                        onClick={() => onNavigate?.('schedule')} />
                    <AlertCard
                        icon="📨"
                        tone="info"
                        loading={false}
                        title={pendingPto.length > 0
                            ? tx(`${pendingPto.length} PTO pending`, `${pendingPto.length} PTO pendiente`)
                            : tx('No PTO pending', 'Sin PTO pendiente')}
                        body={pendingPto.length > 0
                            ? pendingPto.slice(0, 2).map(t => `${t.staffName} · ${t.startDate || t.date}`).join('  ·  ')
                            : tx('All requests handled.', 'Todas atendidas.')}
                        badgeText={pendingPto.length > 0 ? tx('Approve', 'Aprobar') : '✓'}
                        badgeTone={pendingPto.length > 0 ? 'info' : 'success'}
                        onClick={() => onNavigate?.('schedule')} />
                </div>
            </section>
        </div>
    );
}

function AlertCard({ icon, tone, loading, title, body, badgeText, badgeTone, onClick }) {
    const iconBg = tone === 'danger' ? 'bg-red-50 text-red-700'
        : tone === 'warn' ? 'bg-amber-100 text-amber-800'
        : 'bg-blue-50 text-blue-700';
    return (
        <Card hover onClick={onClick} className="p-4 flex items-start gap-3 cursor-pointer">
            <div className={`w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center shrink-0`}>{icon}</div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                    {loading
                        ? <Skeleton className="h-4 w-32" />
                        : <h4 className="text-sm font-bold text-dd-text truncate">{title}</h4>}
                    {badgeText && <Badge tone={badgeTone}>{badgeText}</Badge>}
                </div>
                {loading
                    ? <Skeleton className="h-3 w-48 mt-1" />
                    : <p className="text-xs text-dd-text-2 line-clamp-2">{body}</p>}
            </div>
        </Card>
    );
}

function minutesAgo(isoOrTs) {
    try {
        const d = isoOrTs?.toDate ? isoOrTs.toDate() : new Date(isoOrTs);
        return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    } catch { return '?'; }
}
