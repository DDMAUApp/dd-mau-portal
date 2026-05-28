// StaffUsageAudit — owner-only read-only audit of which staff have
// actually USED the app. Lives inside the Admin Panel as a
// collapsible glass card.
//
// 2026-05-27 — Andrew: "i also want to add another audit to the
// admin page. i want to know which staff has used the app? logged
// in, installed to home screen, is getting notification, so this
// way i can make sure all staff is seeing all the messages."
//
// Signals (derived from existing /config/staff fields — NO new
// writes added):
//
//   • Notifications enabled — staff.fcmTokens.length > 0
//       fcmTokens is the array enableFcmPush() writes on every
//       sign-in. Non-empty == at least one device has gone through
//       the permission grant + token registration, so pushes can
//       reach the staffer on at least one device.
//
//   • PWA installed — staff.pwaInstalled === true
//       Stamped automatically by App.jsx when the staffer opens
//       the app in display-mode: standalone (i.e. from a home-
//       screen icon). The flag never unsets — once true, it
//       persists across sessions even if they uninstall on a
//       different device.
//
//   • Last activity — max(staff.fcmTokens.map(t => t.lastSeen))
//       Each fcmToken row is { token, lastSeen, deviceId }.
//       lastSeen ticks on every successful push setup, which
//       happens on every sign-in. Used as a proxy for "last
//       time the staffer opened the app." Staff with no
//       fcmTokens => no lastSeen signal (shown as "—").
//
// What the rollup shows:
//   1. Top stats: counts of each signal (X/Y staff)
//   2. Per-staff rows sorted by ready→not-ready, then by
//      last activity recency. Each row carries pills for the
//      two binary signals + a "last seen Xd ago" line.
//   3. Filter toggle: All | Needs attention (rows where any
//      of the three signals is missing).
//
// Read-only — no buttons that change state. Admins use the
// existing per-staff edit flow to act on missing signals
// (e.g. ask the staffer to install the PWA).

import { useMemo, useState } from 'react';
import {
    Users, Bell, BellOff, Smartphone, MonitorOff,
    Check, AlertTriangle, Clock, ChevronDown,
} from 'lucide-react';

// Relative-time formatter for the per-staff "last seen" line.
// Tight buckets: today / yesterday / Nd / Nw / Nmo / Ny. Returns
// "—" for falsy timestamps so staff with no signal don't render
// a meaningless "55 years ago" (Date(0) → 1970).
function fmtRelative(ms, isEs) {
    if (!ms) return '—';
    const diff = Date.now() - ms;
    if (diff < 0) return '—';
    const days = Math.floor(diff / 86400000);
    if (days === 0) return isEs ? 'hoy' : 'today';
    if (days === 1) return isEs ? 'ayer' : 'yesterday';
    if (days < 7) return `${days}${isEs ? 'd' : 'd ago'}`;
    if (days < 30) return `${Math.floor(days / 7)}${isEs ? 'sem' : 'w ago'}`;
    if (days < 365) return `${Math.floor(days / 30)}${isEs ? 'mes' : 'mo ago'}`;
    return `${Math.floor(days / 365)}${isEs ? 'a' : 'y ago'}`;
}

export default function StaffUsageAudit({ staffList = [], language = 'en' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [expanded, setExpanded] = useState(false);
    const [filter, setFilter] = useState('all'); // 'all' | 'missing'

    // Build the per-staff rows. Skip inactive staff (active === false)
    // — they're not expected to use the app. Sort: needs-attention
    // first (so the actionable rows are immediately visible), then
    // by last-activity recency.
    const rows = useMemo(() => {
        const active = (staffList || []).filter((s) => s && s.name && s.active !== false);
        return active.map((s) => {
            const tokens = Array.isArray(s.fcmTokens) ? s.fcmTokens : [];
            const lastSeen = tokens.reduce(
                (max, t) => Math.max(max, Number(t?.lastSeen) || 0),
                0
            );
            const notif = tokens.length > 0;
            const installed = s.pwaInstalled === true;
            const ready = notif && installed;
            return {
                id: s.id ?? s.name,
                name: s.name,
                role: s.role || '',
                location: s.location || '',
                tokenCount: tokens.length,
                lastSeen,
                notif,
                installed,
                ready,
            };
        }).sort((a, b) => {
            if (a.ready !== b.ready) return a.ready ? 1 : -1;
            return (b.lastSeen || 0) - (a.lastSeen || 0);
        });
    }, [staffList]);

    const stats = useMemo(() => {
        const total = rows.length;
        const notif = rows.filter((r) => r.notif).length;
        const installed = rows.filter((r) => r.installed).length;
        const ready = rows.filter((r) => r.ready).length;
        return { total, notif, installed, ready };
    }, [rows]);

    const filtered = useMemo(() => {
        return filter === 'missing' ? rows.filter((r) => !r.ready) : rows;
    }, [rows, filter]);

    // Empty staff list edge case — should never happen on /config/staff
    // doc reads, but guard anyway.
    if (rows.length === 0) {
        return (
            <div className="glass-card p-4 mb-4">
                <p className="text-footnote-md text-dd-text-2 text-center">
                    {tx('No active staff to audit.', 'Sin personal activo para auditar.')}
                </p>
            </div>
        );
    }

    return (
        <div className="glass-card p-4 mb-4">
            {/* Collapsible header — same chevron pattern the other
                audit panels use, dressed in the new icon-disc family. */}
            <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="w-full flex items-center justify-between gap-3 -m-1 p-1 rounded-glass-md hover:bg-white/40 transition-colors"
                aria-expanded={expanded}
            >
                <div className="flex items-center gap-3 min-w-0">
                    <span className="shrink-0 w-10 h-10 rounded-lg bg-dd-sage-50 text-dd-green-700 flex items-center justify-center">
                        <Users size={20} strokeWidth={2.25} aria-hidden="true" />
                    </span>
                    <div className="text-left min-w-0">
                        <h3 className="text-headline text-dd-text">
                            {tx('Staff app usage', 'Uso de la app del personal')}
                        </h3>
                        <p className="text-caption-md text-dd-text-2">
                            {tx(
                                `${stats.ready}/${stats.total} fully set up · ${stats.total - stats.ready} need attention`,
                                `${stats.ready}/${stats.total} listos · ${stats.total - stats.ready} faltan`
                            )}
                        </p>
                    </div>
                </div>
                <ChevronDown
                    size={18}
                    strokeWidth={2.25}
                    aria-hidden="true"
                    className={`shrink-0 text-dd-text-2 transition-transform duration-glass-fast ease-glass-out ${expanded ? 'rotate-180' : ''}`}
                />
            </button>

            {expanded && (
                <>
                    {/* Aggregate stats — at-a-glance health */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
                        <StatChip
                            label={tx('Notifications', 'Notificaciones')}
                            value={`${stats.notif}/${stats.total}`}
                            tone={stats.notif === stats.total ? 'green' : 'amber'}
                            Icon={Bell}
                        />
                        <StatChip
                            label={tx('Installed', 'Instalado')}
                            value={`${stats.installed}/${stats.total}`}
                            tone={stats.installed === stats.total ? 'green' : 'amber'}
                            Icon={Smartphone}
                        />
                        <StatChip
                            label={tx('Fully set up', 'Listo')}
                            value={`${stats.ready}/${stats.total}`}
                            tone={stats.ready === stats.total ? 'green' : 'amber'}
                            Icon={Check}
                        />
                        <StatChip
                            label={tx('Need attention', 'Falta')}
                            value={`${stats.total - stats.ready}`}
                            tone={stats.total - stats.ready === 0 ? 'green' : 'amber'}
                            Icon={AlertTriangle}
                        />
                    </div>

                    {/* All / Needs attention filter */}
                    <div className="inline-flex gap-1 bg-dd-bg/60 border border-dd-line rounded-glass-sm p-1 mt-4">
                        <button
                            type="button"
                            onClick={() => setFilter('all')}
                            className={`px-3 py-1 rounded-sm text-xs font-bold transition ${
                                filter === 'all'
                                    ? 'bg-dd-green text-white'
                                    : 'text-dd-text-2'
                            }`}
                        >
                            {tx('All', 'Todos')} ({stats.total})
                        </button>
                        <button
                            type="button"
                            onClick={() => setFilter('missing')}
                            className={`px-3 py-1 rounded-sm text-xs font-bold transition ${
                                filter === 'missing'
                                    ? 'bg-amber-500 text-white'
                                    : 'text-dd-text-2'
                            }`}
                        >
                            {tx('Needs attention', 'Falta')} ({stats.total - stats.ready})
                        </button>
                    </div>

                    {/* Per-staff rows */}
                    <div className="space-y-1.5 mt-3">
                        {filtered.length === 0 ? (
                            <p className="text-footnote-md text-dd-text-2 text-center py-6">
                                {tx(
                                    'Everyone here is fully set up.',
                                    'Todos están listos.'
                                )}
                            </p>
                        ) : (
                            filtered.map((s) => (
                                <div
                                    key={s.id}
                                    className="flex items-center gap-2 p-2.5 rounded-glass-md bg-white/60 border border-glass-border-light"
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="text-body-md text-dd-text font-semibold truncate">
                                            {s.name}
                                            {s.role && (
                                                <span className="text-caption-md text-dd-text-2 font-normal ml-1.5">
                                                    · {s.role}
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-caption-md text-dd-text-2 flex items-center gap-1.5 mt-0.5">
                                            <Clock size={11} strokeWidth={2.25} aria-hidden="true" />
                                            {tx('Last seen', 'Vista')}: {fmtRelative(s.lastSeen, isEs)}
                                            {s.tokenCount > 1 && (
                                                <span className="ml-1.5 text-[10px] font-bold text-dd-text-2/80">
                                                    · {s.tokenCount} {tx('devices', 'dispositivos')}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-1 shrink-0">
                                        <PillStatus
                                            on={s.notif}
                                            Icon={s.notif ? Bell : BellOff}
                                            label={s.notif ? tx('Notif', 'Notif') : tx('No notif', 'Sin notif')}
                                        />
                                        <PillStatus
                                            on={s.installed}
                                            Icon={s.installed ? Smartphone : MonitorOff}
                                            label={s.installed ? tx('PWA', 'PWA') : tx('No PWA', 'Sin PWA')}
                                        />
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    <p className="text-caption-md text-dd-text-2/70 mt-3 italic leading-relaxed">
                        {tx(
                            'Notif = has registered at least one device for push. PWA = has opened the app from a home-screen install. Last seen = most recent FCM token refresh (≈ last sign-in).',
                            'Notif = al menos un dispositivo registrado para push. PWA = ha abierto la app desde la pantalla de inicio. Vista = renovación de token más reciente (≈ último inicio de sesión).'
                        )}
                    </p>
                </>
            )}
        </div>
    );
}

// Aggregate-stats chip used in the top row.
function StatChip({ label, value, tone, Icon }) {
    const toneClasses = tone === 'amber'
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-dd-sage-50 text-dd-green-700 border-dd-green/20';
    return (
        <div className={`rounded-glass-md border p-2.5 ${toneClasses}`}>
            <div className="flex items-center gap-1.5">
                <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
                <span className="text-overline">{label}</span>
            </div>
            <div className="text-title-3 tabular-nums mt-1 leading-none">{value}</div>
        </div>
    );
}

// Per-row binary status pill — sage when on, amber when off.
function PillStatus({ on, Icon, label }) {
    return (
        <span
            className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${
                on
                    ? 'bg-dd-sage-50 text-dd-green-700 border-dd-green/30'
                    : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}
        >
            <Icon size={10} strokeWidth={2.5} aria-hidden="true" />
            {label}
        </span>
    );
}
