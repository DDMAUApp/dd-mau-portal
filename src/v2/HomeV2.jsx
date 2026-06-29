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

import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { db } from '../firebase';
import { doc, collection, onSnapshot } from 'firebase/firestore';
import { canViewLabor, canViewClockedIn, isAdmin as isAdminFn } from '../data/staff';
import { getLaborStatus, getLaborStatusHint } from '../data/labor';
import { useAppData } from './AppDataContext';
import EnableNotificationsBanner from '../components/EnableNotificationsBanner';
import StaffTodoCard from '../components/StaffTodoCard';
import ClockedInPanel from '../components/ClockedInPanel';
// 2026-05-27 — Andrew: "the home screen button emojis need a
// professional look too." Swapping every emoji icon on the desktop
// home dashboard for Lucide SVG glyphs (same set Sidebar.jsx +
// MobileBottomNav.jsx already use, so no new chunk weight — they
// all land in vendor-react alongside lucide-react itself).
import {
    Printer,
    BarChart3,
    Clock,
    Ban,
    FilePen,
    Calendar,
    Mail,
    Megaphone,
    CheckCircle2,
    AlertTriangle,
    ArrowRight,
} from 'lucide-react';
// 2026-05-20 — Print Center on the home screen. Lazy so the chunk
// only loads when admin/staff actually taps Print.
const PrintCenter = lazy(() => import('../components/PrintCenter'));

// ── Primitives ─────────────────────────────────────────────────────────
// 2026-05-27 — Phase 3: ported the local Card / Button primitives to
// the Liquid-Glass design system. One change here cascades through
// every StatCard, every dashboard tile, every section wrapper on the
// desktop home — the rest of the JSX is untouched.
function Card({ className = '', children, hover = false, ...rest }) {
    return (
        <div {...rest}
            className={`glass-card ${hover ? 'hover:shadow-glass-lg transition-shadow duration-glass-normal ease-glass-out' : ''} ${className}`}>
            {children}
        </div>
    );
}

function Button({ variant = 'primary', size = 'md', className = '', children, ...props }) {
    // Size still drives the padding (the glass-* classes pick the
    // touch-target floor on mobile via pointer:coarse media query).
    const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' };
    // 2026-05-27 — Andrew: "change all buttons to a light gray glass."
    // Both `primary` and `secondary` now point to .glass-button-apple
    // (the new Apple-Liquid-Glass-style neutral chip). Buttons that
    // previously read as "primary" (green fill) become the same calm
    // gray glass as everything else on the home page — uniform feel,
    // and the destination is conveyed by the label, not the chrome.
    // `ghost` and `danger` keep their semantic chrome since they
    // carry destructive / link-style meaning beyond "tap me."
    const variants = {
        primary:   'glass-button-apple',
        secondary: 'glass-button-apple',
        ghost:     'inline-flex items-center gap-1 bg-transparent text-dd-text-2 hover:text-dd-text hover:bg-dd-bg rounded-glass-md transition-colors',
        danger:    'bg-red-600 text-white hover:bg-red-700 shadow-glass-sm border border-red-600 rounded-glass-md',
    };
    return (
        <button {...props}
            className={`${sizes[size]} ${variants[variant]} ${className}`}>
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
    return <div className={`glass-skeleton ${className}`} />;
}

// 2026-05-27 — `icon` was a string emoji; now it's a Lucide component
// (rendered as `<Icon size={18} ... />`). All callers updated.
function StatCard({ label, value, sub, tone, icon: Icon, loading }) {
    return (
        <Card hover className="p-5">
            <div className="flex items-start justify-between mb-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-dd-text-2">{label}</div>
                {Icon && (
                    <Icon
                        size={18}
                        strokeWidth={2.25}
                        className="text-dd-text-2/70"
                        aria-hidden="true"
                    />
                )}
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
export default function HomeV2({ language = 'en', staffName = '', storeLocation = 'webster', staffList = [], setStaffList, onNavigate }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);

    // Resolve effective location for queries (multi-location admins might be 'both').
    const queryLoc = storeLocation === 'both' ? 'webster' : storeLocation;

    // 2026-05-20 — Print Center modal state. The Print pill in the
    // top-right of HomeV2 opens this; mounts as a full-screen overlay.
    const [showPrintCenter, setShowPrintCenter] = useState(false);
    // Resolve admin status for the Print Center location selector.
    const viewerIsAdmin = isAdminFn(staffName, staffList);
    // 2026-05-30 — Andrew "Who's clocked in" widget. Resolve the viewer's
    // staff record once so the canViewClockedIn() gate below doesn't have
    // to re-scan staffList on every render. Mirrors the StaffTodoCard
    // pattern at line ~300.
    const viewer = useMemo(
        () => (staffList || []).find(s => s.name === staffName) || null,
        [staffList, staffName]
    );

    // FIX (review 2026-05-14, perf): read from the shared AppDataContext
    // instead of four component-local Firestore subscriptions. The
    // loading flags are kept in the same shape consumers rely on, just
    // derived from "is the snapshot empty?" — the AppDataProvider seeds
    // all values to [] / null so first paint behaves the same.
    const { shifts14, timeOff, eightySixByLoc, laborByLoc } = useAppData();
    const labor = useMemo(() => {
        const data = laborByLoc[queryLoc] || null;
        return { loading: data === null, data };
    }, [laborByLoc, queryLoc]);
    const eighty6 = useMemo(() => {
        const d = eightySixByLoc[queryLoc];
        if (d === null) return { loading: true, count: 0, items: [] };
        return { loading: false, count: d?.count || 0, items: d?.items || [] };
    }, [eightySixByLoc, queryLoc]);
    const shifts = useMemo(() => ({ loading: false, list: shifts14 }), [shifts14]);
    const pendingPto = useMemo(() => timeOff.filter(t => t.status === 'pending'), [timeOff]);

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
    // 2026-05-26 — route through getLaborStatus() so a "scraper broke"
    // doc (laborCost: 0 with real netSales) renders "—" instead of a
    // deceptively-green "0.0%". See src/data/labor.js for the outage
    // context.
    const laborStatus = getLaborStatus(labor.data);
    const laborPct = laborStatus.laborPercent;
    const laborTone = laborPct == null ? 'text-dd-text'
        : laborPct <= 22 ? 'text-emerald-700'
        : laborPct <= 28 ? 'text-amber-700'
        : 'text-red-700';
    const laborHint = getLaborStatusHint(laborStatus, language);

    const locName = queryLoc === 'maryland' ? 'Maryland Heights' : 'Webster Groves';
    const todayLong = new Date().toLocaleDateString(isEn ? 'en-US' : 'es-ES', {
        weekday: 'long', month: 'short', day: 'numeric',
    });

    return (
        <div className="space-y-6">
            {/* Welcome + top-right Print pill. Andrew 2026-05-20 — the
                home screen now carries a dedicated Print Center
                affordance because the Operations-only entry point
                was too buried. The pill sits as a quiet companion
                action to the right of the greeting. */}
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-2xl font-black text-dd-text tracking-tight">
                        {greeting}, {staffName?.split(' ')[0] || tx('there', 'hola')}
                    </h1>
                    <p className="text-sm text-dd-text-2 mt-1 capitalize">
                        {todayLong} <span className="text-dd-text-2/50 mx-1">·</span>
                        <span className="text-dd-text font-semibold normal-case">DD Mau {locName}</span>
                    </p>
                </div>
                {/* 2026-05-27 — Andrew: "change all buttons to a
                    light gray glass." The old loud purple pill is
                    swapped for the new .glass-button-apple chrome
                    (neutral translucent gray with a Lucide Printer
                    glyph in front of the label). Sits as a quiet
                    companion to the greeting now instead of shouting
                    over it. */}
                <button onClick={() => setShowPrintCenter(true)}
                    className="glass-button-apple flex-shrink-0 px-4 py-2 rounded-full">
                    <Printer size={16} strokeWidth={2.25} aria-hidden="true" />
                    <span>{tx('Print', 'Imprimir')}</span>
                </button>
            </div>

            {/* Enable-notifications banner — first-sign-in nudge.
                Same component as MobileHome's banner; renders null when
                Notification.permission is already granted. See
                EnableNotificationsBanner.jsx for the iOS-gesture
                requirement that makes this affordance necessary. */}
            <EnableNotificationsBanner
                staffName={staffName}
                staffList={staffList}
                setStaffList={setStaffList}
                language={language}
            />

            {/* Staff TO-DO card — admin-defined todos + auto-detected
                "fill out your birthday" / "set your availability" hints.
                Renders null when there's nothing to do. Sits above the
                stats so action items get top billing on desktop too. */}
            <StaffTodoCard
                language={language}
                staffName={staffName}
                viewer={(staffList || []).find(s => s.name === staffName) || null}
                onNavigate={onNavigate}
            />

            {/* Stats */}
            <section>
                <SectionHeader
                    title={tx("Today's overview", "Resumen de hoy")}
                    subtitle={tx('Live from Toast POS', 'En vivo desde Toast POS')}
                    action={
                        <Button variant="ghost" size="sm" onClick={() => onNavigate?.('labor')}>
                            <span>{tx('Labor dashboard', 'Mano de obra')}</span>
                            <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
                        </Button>
                    }
                />
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    {canViewLabor((staffList || []).find(s => s.name === staffName)) && (
                        <StatCard
                            label={tx('Labor %', 'Mano de obra')}
                            value={fmtPct(laborPct)}
                            tone={laborHint ? 'text-red-700' : laborTone}
                            sub={laborHint
                                ? laborHint
                                : labor.data?.updatedAt
                                    ? tx(`Updated ${minutesAgo(labor.data.updatedAt)} min ago`, `Actualizado hace ${minutesAgo(labor.data.updatedAt)} min`)
                                    : tx('Target 25%', 'Objetivo 25%')}
                            icon={laborStatus.isBroken ? AlertTriangle : BarChart3}
                            loading={labor.loading} />
                    )}
                    <StatCard
                        label={tx('Total hours', 'Horas')}
                        value={labor.data?.totalHours != null ? labor.data.totalHours.toFixed(1) : '—'}
                        sub={tx('Clocked-in today', 'Marcadas hoy')}
                        icon={Clock}
                        loading={labor.loading} />
                    <StatCard
                        label={tx('86 items', 'Artículos en 86')}
                        value={eighty6.count}
                        tone={eighty6.count > 0 ? 'text-red-700' : 'text-dd-text'}
                        sub={eighty6.count > 0 ? tx('Tap to view', 'Toca para ver') : tx('All in stock ✓', 'Todo en stock ✓')}
                        icon={Ban}
                        loading={eighty6.loading} />
                    <StatCard
                        label={tx('Drafts', 'Borradores')}
                        value={draftCount}
                        tone={draftCount > 0 ? 'text-amber-700' : 'text-dd-text'}
                        sub={draftCount > 0 ? tx('Awaiting publish', 'Esperando publicar') : tx('Schedule released ✓', 'Horario liberado ✓')}
                        icon={FilePen}
                        loading={shifts.loading} />
                </div>
            </section>

            {/* Two-up row: shifts/clocked-in + publish CTA */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* 2026-05-30 — Andrew: replaced "Upcoming shifts" with
                    the live Toast "Who's clocked in" roster for admins.
                    Non-admins continue to see upcoming shifts because
                    they don't have access to the labor data. Future:
                    canViewClockedIn() can be opted-in per-staff via the
                    Admin Panel (see helper in src/data/staff.js). */}
                {canViewClockedIn(viewer) ? (
                    <div className="lg:col-span-2">
                        <ClockedInPanel
                            location={storeLocation}
                            language={language}
                            staffList={staffList}
                            todaysShifts={shifts.list.filter(s =>
                                s.date === todayKey() &&
                                (storeLocation === 'both' || s.location === storeLocation)
                            )}
                        />
                    </div>
                ) : (
                <Card className="lg:col-span-2 p-5">
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <h3 className="text-base font-bold text-dd-text">{tx('Upcoming shifts', 'Turnos próximos')}</h3>
                            <p className="text-xs text-dd-text-2">{tx('Today and tomorrow', 'Hoy y mañana')}</p>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => onNavigate?.('schedule')}>
                            <span>{tx('Open schedule', 'Abrir horario')}</span>
                            <ArrowRight size={14} strokeWidth={2.25} aria-hidden="true" />
                        </Button>
                    </div>
                    {shifts.loading ? (
                        <div className="space-y-2">
                            {[1,2,3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
                        </div>
                    ) : upcomingShifts.length === 0 ? (
                        <div className="text-center py-8">
                            <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-dd-bg flex items-center justify-center text-dd-text-2/60">
                                <Calendar size={22} strokeWidth={2.25} aria-hidden="true" />
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
                )}

                {/* Publish CTA — solid sage tint when there are drafts to
                    drive attention; when zero, downgrades to a calm "all
                    caught up" surface so it doesn't shout. The previous
                    megaphone emoji at small size rendered as a smudge —
                    using a clean checkmark / megaphone disc instead. */}
                <Card className={`p-5 ${draftCount > 0 ? 'bg-gradient-to-br from-amber-50 to-dd-surface border-amber-200' : 'bg-gradient-to-br from-dd-sage-50 to-dd-surface border-dd-sage/40'}`}>
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${draftCount > 0 ? 'bg-amber-100 text-amber-700' : 'bg-dd-green-50 text-dd-green-700'}`}>
                        {draftCount > 0
                            ? <Megaphone size={20} strokeWidth={2.25} aria-hidden="true" />
                            : <CheckCircle2 size={20} strokeWidth={2.25} aria-hidden="true" />}
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
                        icon={Ban}
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
                        icon={Calendar}
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
                        icon={Mail}
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

            {/* 🖨 Print Center modal — top-right pill opens this. Lazy
                chunk so desktop home pays no cost until a user prints. */}
            {showPrintCenter && (
                <Suspense fallback={<div className="fixed inset-0 bg-black/40 z-50" />}>
                    <PrintCenter
                        location={storeLocation}
                        staffName={staffName}
                        language={language}
                        isAdmin={viewerIsAdmin}
                        onClose={() => setShowPrintCenter(false)}
                    />
                </Suspense>
            )}
        </div>
    );
}

// 2026-05-27 — `icon` upgraded from emoji string to Lucide component.
// Rendered as `<Icon size={18} ... />` inside the colored disc.
function AlertCard({ icon: Icon, tone, loading, title, body, badgeText, badgeTone, onClick }) {
    const iconBg = tone === 'danger' ? 'bg-red-50 text-red-700'
        : tone === 'warn' ? 'bg-amber-100 text-amber-800'
        : 'bg-blue-50 text-blue-700';
    return (
        <Card hover onClick={onClick} className="p-4 flex items-start gap-3 cursor-pointer">
            <div className={`w-9 h-9 rounded-lg ${iconBg} flex items-center justify-center shrink-0`}>
                {Icon && <Icon size={18} strokeWidth={2.25} aria-hidden="true" />}
            </div>
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
