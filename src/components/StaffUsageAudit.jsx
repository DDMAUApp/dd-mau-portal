// StaffUsageAudit — owner-only read-only audit of which staff have
// actually USED the app. Lives inside the Admin Panel as a
// collapsible glass card.
//
// 2026-05-27 — Andrew: "i also want to add another audit to the
// admin page. i want to know which staff has used the app? logged
// in, installed to home screen, is getting notification."
//
// 2026-05-27 (round 2) — Andrew: "i know some of the staff like
// brandon as logged in today but it says 5 days ago." Root cause:
// the previous version read fcmTokens[].lastSeen as the "last
// seen" signal, but that field only ticks when enableFcmPush()
// SUCCEEDS at acquiring a token — so a staffer who signed in on
// desktop, declined push, opened an iOS Safari tab instead of
// the installed PWA, etc. would show a stale (or missing)
// timestamp.
//
// Fix: App.jsx now writes a true lastSignInAt on every session
// start (debounced to ~once per 30min). This panel prefers that
// signal and falls back to fcmTokens.lastSeen for staff who
// haven't signed in since the new code shipped.
//
// Signals (all derived from existing /config/staff fields — NO
// new Firestore writes added by THIS file):
//
//   • Last sign-in           — staff.lastSignInAt (Date.now() ms)
//   • Last push refresh      — max(fcmTokens[].lastSeen)
//   • Notifications enabled  — staff.fcmTokens.length > 0
//   • PWA installed          — staff.pwaInstalled === true
//   • Devices                — count of unique deviceIds in fcmTokens
//   • Platform               — staff.lastSignInPlatform (iOS/Android/Mac/...)
//   • Standalone-mode flag   — staff.lastSignInStandalone (PWA install vs tab)
//
// What the rollup shows:
//   1. Top stats: Active today / This week / Notifications on /
//      Fully set up / Need attention.
//   2. Per-staff rows sorted by needs-attention first, then by
//      most recent activity. Each row carries:
//        - last sign-in relative time + platform pill
//        - last push refresh (only when it diverges from sign-in)
//        - device count
//        - Notif + PWA status pills
//   3. Filter: All | Needs attention | Inactive 7+ days.
//
// Read-only — no buttons that change state. Admins use the
// existing per-staff edit flow to act on missing signals.

import { useMemo, useState } from 'react';
import {
    Users, Bell, BellOff, Smartphone, MonitorOff,
    Check, AlertTriangle, Clock, ChevronDown, MonitorSmartphone, Wifi,
    MessageSquare, Send, PhoneOff,
} from 'lucide-react';
import { composeSetupReminderSmsUrl, stampSetupReminderSent } from '../data/notify';

// Coerce any timestamp shape to a millisecond number (or 0 for
// nothing). Handles Firestore Timestamp objects, JS Dates, ISO
// strings, and plain numbers — staff docs have all four flavors
// historically.
function tsToMs(t) {
    if (!t) return 0;
    if (typeof t === 'number') return t;
    if (typeof t === 'string') {
        const ms = Date.parse(t);
        return Number.isFinite(ms) ? ms : 0;
    }
    if (typeof t?.toMillis === 'function') return t.toMillis();
    if (typeof t?.toDate === 'function') return t.toDate().getTime();
    if (t instanceof Date) return t.getTime();
    return 0;
}

// Relative-time formatter — tight buckets, locale-aware-ish.
function fmtRelative(ms, isEs) {
    if (!ms) return '—';
    const diff = Date.now() - ms;
    if (diff < 0) return '—';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) {
        if (mins < 1) return isEs ? 'ahora' : 'just now';
        return `${mins}${isEs ? 'm' : 'm ago'}`;
    }
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours}${isEs ? 'h' : 'h ago'}`;
    const days = Math.floor(diff / 86400000);
    if (days === 1) return isEs ? 'ayer' : 'yesterday';
    if (days < 7) return `${days}${isEs ? 'd' : 'd ago'}`;
    if (days < 30) return `${Math.floor(days / 7)}${isEs ? 'sem' : 'w ago'}`;
    if (days < 365) return `${Math.floor(days / 30)}${isEs ? 'mes' : 'mo ago'}`;
    return `${Math.floor(days / 365)}${isEs ? 'a' : 'y ago'}`;
}

export default function StaffUsageAudit({ staffList = [], language = 'en', currentManagerName = '', currentManagerId = null }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [expanded, setExpanded] = useState(false);
    const [filter, setFilter] = useState('all'); // 'all' | 'missing' | 'inactive'
    // Per-row send state — keyed by staffName. Used only to flip the
    // chip to "Texted ✓" after the admin taps the sms: link (the actual
    // SMS send happens in their native Messages app — we can't observe
    // it, we just optimistically mark sent on click).
    const [sendingState, setSendingState] = useState({});
    const [toast, setToast] = useState(null);

    // Cooldown matches the value in src/data/notify.js. Used here only
    // to disable the button + show "Sent 3d ago" — the Cloud Function
    // does the authoritative enforcement.
    const REMINDER_COOLDOWN_DAYS = 7;

    // 2026-05-27 — Andrew: "make a text to text like we do in onboarding.
    // so i or any admin can go through and send a text through my phone
    // and its not automatic." Tapping the row's link opens the admin's
    // native Messages app pre-filled with the recipient phone + body
    // (sms:NUMBER?body=...). The admin reviews and taps Send themselves.
    // We stamp the cooldown marker on click — we can't observe whether
    // the admin actually hit Send, but we don't want to nag them about
    // the same staffer the next time they open this page.
    async function handleStampReminderSent(staffRow) {
        if (!staffRow?.name) return;
        setSendingState((m) => ({ ...m, [staffRow.name]: 'sending' }));
        const res = await stampSetupReminderSent(staffRow.name);
        if (res.ok) {
            setSendingState((m) => ({ ...m, [staffRow.name]: 'sent' }));
        } else {
            setSendingState((m) => ({ ...m, [staffRow.name]: 'error' }));
            setToast(tx('Could not record reminder', 'No se pudo registrar'));
            setTimeout(() => setToast(null), 3000);
        }
    }

    // Build the per-staff rows. Skip inactive staff (active === false)
    // — they're not expected to use the app. Sort: needs-attention
    // first (so actionable rows are visible without scrolling), then
    // by most-recent activity.
    const rows = useMemo(() => {
        const active = (staffList || []).filter((s) => s && s.name && s.active !== false);
        return active.map((s) => {
            const tokens = Array.isArray(s.fcmTokens) ? s.fcmTokens : [];
            // Unique devices (some legacy entries pre-deviceId don't
            // carry one; count those as separate-anonymous-1).
            const deviceIds = new Set();
            let anonCount = 0;
            for (const t of tokens) {
                if (t?.deviceId) deviceIds.add(t.deviceId);
                else anonCount += 1;
            }
            const deviceCount = deviceIds.size + (anonCount > 0 ? 1 : 0);
            const pushMs = tokens.reduce(
                (max, t) => Math.max(max, tsToMs(t?.lastSeen)),
                0
            );
            const signInMs = tsToMs(s.lastSignInAt);
            // Prefer lastSignInAt (the canonical session-start stamp);
            // fall back to push lastSeen for staff who haven't been
            // seen since the new write shipped.
            const lastSeenMs = signInMs || pushMs;
            const notif = tokens.length > 0;
            const installed = s.pwaInstalled === true;
            const ready = notif && installed;
            return {
                id: s.id ?? s.name,
                name: s.name,
                role: s.role || '',
                location: s.location || '',
                tokenCount: tokens.length,
                deviceCount,
                pushMs,
                signInMs,
                lastSeenMs,
                platform: s.lastSignInPlatform || '',
                standalone: s.lastSignInStandalone === true,
                notif,
                installed,
                ready,
                // SMS-eligibility fields — used by the per-row "Send
                // reminder SMS" button. Pull from the staff doc as-is
                // so the helper can re-validate authoritatively.
                phoneE164: s.phoneE164 || '',
                smsOptIn: s.smsOptIn === true,
                smsStopped: s.smsStopped === true,
                reminderSentMs: tsToMs(s.setupReminderSentAt),
                raw: s,
            };
        }).sort((a, b) => {
            if (a.ready !== b.ready) return a.ready ? 1 : -1;
            return (b.lastSeenMs || 0) - (a.lastSeenMs || 0);
        });
    }, [staffList]);

    const stats = useMemo(() => {
        const now = Date.now();
        const total = rows.length;
        const notif = rows.filter((r) => r.notif).length;
        const installed = rows.filter((r) => r.installed).length;
        const ready = rows.filter((r) => r.ready).length;
        const activeToday = rows.filter((r) => r.lastSeenMs && (now - r.lastSeenMs) < 24 * 60 * 60 * 1000).length;
        const activeWeek = rows.filter((r) => r.lastSeenMs && (now - r.lastSeenMs) < 7 * 24 * 60 * 60 * 1000).length;
        const inactive7d = rows.filter((r) => !r.lastSeenMs || (now - r.lastSeenMs) > 7 * 24 * 60 * 60 * 1000).length;
        return { total, notif, installed, ready, activeToday, activeWeek, inactive7d };
    }, [rows]);

    const filtered = useMemo(() => {
        const now = Date.now();
        if (filter === 'missing') return rows.filter((r) => !r.ready);
        if (filter === 'inactive') return rows.filter((r) => !r.lastSeenMs || (now - r.lastSeenMs) > 7 * 24 * 60 * 60 * 1000);
        return rows;
    }, [rows, filter]);

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
            {/* Collapsible header */}
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
                                `${stats.activeToday} active today · ${stats.ready}/${stats.total} fully set up · ${stats.inactive7d} inactive 7d+`,
                                `${stats.activeToday} hoy · ${stats.ready}/${stats.total} listos · ${stats.inactive7d} inactivos 7d+`
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
                    {/* Aggregate stats — 6 chips covering the at-a-glance
                        health of the team's app engagement. */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mt-4">
                        <StatChip
                            label={tx('Active today', 'Hoy')}
                            value={`${stats.activeToday}/${stats.total}`}
                            tone={stats.activeToday >= Math.ceil(stats.total * 0.6) ? 'green' : 'amber'}
                            Icon={Wifi}
                        />
                        <StatChip
                            label={tx('This week', 'Esta sem.')}
                            value={`${stats.activeWeek}/${stats.total}`}
                            tone={stats.activeWeek >= stats.total ? 'green' : 'amber'}
                            Icon={Clock}
                        />
                        <StatChip
                            label={tx('Notifications', 'Notif.')}
                            value={`${stats.notif}/${stats.total}`}
                            tone={stats.notif === stats.total ? 'green' : 'amber'}
                            Icon={Bell}
                        />
                        <StatChip
                            label={tx('PWA installed', 'PWA inst.')}
                            value={`${stats.installed}/${stats.total}`}
                            tone={stats.installed === stats.total ? 'green' : 'amber'}
                            Icon={Smartphone}
                        />
                        <StatChip
                            label={tx('Fully set up', 'Listos')}
                            value={`${stats.ready}/${stats.total}`}
                            tone={stats.ready === stats.total ? 'green' : 'amber'}
                            Icon={Check}
                        />
                        <StatChip
                            label={tx('Inactive 7d+', 'Inact. 7d+')}
                            value={`${stats.inactive7d}`}
                            tone={stats.inactive7d === 0 ? 'green' : 'amber'}
                            Icon={AlertTriangle}
                        />
                    </div>

                    {/* Filter + bulk reminder action */}
                    <div className="flex flex-wrap items-center gap-2 mt-4">
                        <div className="inline-flex gap-1 bg-dd-bg/60 border border-dd-line rounded-glass-sm p-1 flex-wrap">
                            <FilterChip on={filter === 'all'} onClick={() => setFilter('all')} tone="green">
                                {tx('All', 'Todos')} ({stats.total})
                            </FilterChip>
                            <FilterChip on={filter === 'missing'} onClick={() => setFilter('missing')} tone="amber">
                                {tx('Needs setup', 'Falta config')} ({stats.total - stats.ready})
                            </FilterChip>
                            <FilterChip on={filter === 'inactive'} onClick={() => setFilter('inactive')} tone="amber">
                                {tx('Inactive 7d+', 'Inactivos 7d+')} ({stats.inactive7d})
                            </FilterChip>
                        </div>
                        {/* Bulk send removed — the manual sms: URL flow
                            is one-at-a-time (each tap opens the admin's
                            native Messages app for review + send).
                            Going through ~10 stragglers one tap each is
                            roughly the same effort as the old bulk
                            confirm-then-fire, and avoids opening N tabs
                            on desktop or N message threads on mobile.
                            (Old Twilio bulk action still lives in git
                            history if we want it back once 10DLC clears.) */}
                    </div>

                    {/* Per-staff rows */}
                    <div className="space-y-1.5 mt-3">
                        {filtered.length === 0 ? (
                            <p className="text-footnote-md text-dd-text-2 text-center py-6">
                                {filter === 'inactive'
                                    ? tx('Everyone has been active in the last week.', 'Todos activos esta semana.')
                                    : filter === 'missing'
                                    ? tx('Everyone is fully set up.', 'Todos configurados.')
                                    : tx('No staff to show.', 'Sin personal.')}
                            </p>
                        ) : (
                            filtered.map((s) => (
                                <div
                                    key={s.id}
                                    className="flex flex-col sm:flex-row sm:items-center gap-2 p-2.5 rounded-glass-md bg-white/60 border border-glass-border-light"
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="text-body-md text-dd-text font-semibold truncate flex items-center gap-1.5">
                                            {s.name}
                                            {s.role && (
                                                <span className="text-caption-md text-dd-text-2 font-normal">
                                                    · {s.role}
                                                </span>
                                            )}
                                            {s.platform && (
                                                <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-bold text-dd-text-2 bg-dd-bg/80 border border-dd-line px-1.5 py-0.5 rounded-full">
                                                    <MonitorSmartphone size={9} strokeWidth={2.5} aria-hidden="true" />
                                                    {s.platform}
                                                    {s.standalone && <span className="ml-0.5 text-dd-green-700">·PWA</span>}
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-caption-md text-dd-text-2 flex items-center gap-1.5 mt-0.5 flex-wrap">
                                            <Clock size={11} strokeWidth={2.25} aria-hidden="true" />
                                            <span>
                                                {tx('Last sign-in', 'Última conexión')}:{' '}
                                                <span className={s.signInMs && (Date.now() - s.signInMs) < 24 * 60 * 60 * 1000 ? 'font-bold text-dd-green-700' : ''}>
                                                    {fmtRelative(s.signInMs, isEs)}
                                                </span>
                                            </span>
                                            {/* Only show push-refresh separately when it diverges
                                                significantly from sign-in (>= 1 day delta) — usually
                                                they tick together, only worth surfacing when they don't. */}
                                            {s.pushMs > 0 && Math.abs((s.signInMs || 0) - s.pushMs) > 24 * 60 * 60 * 1000 && (
                                                <span className="text-dd-text-2/70">
                                                    · {tx('push', 'push')} {fmtRelative(s.pushMs, isEs)}
                                                </span>
                                            )}
                                            {s.deviceCount > 0 && (
                                                <span className="text-dd-text-2/70">
                                                    · {s.deviceCount} {s.deviceCount === 1 ? tx('device', 'dispositivo') : tx('devices', 'dispositivos')}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex flex-row sm:flex-col items-start gap-1 shrink-0">
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
                                    {/* Manual-SMS link — same pattern Onboarding
                                        uses (sms:NUMBER?body=...). Tapping
                                        opens the admin's native Messages app
                                        pre-filled with the recipient + body;
                                        the admin reviews + taps Send from
                                        their own phone. No Twilio, no
                                        carrier registration required.
                                        We stamp setupReminderSentAt on tap
                                        so the same staffer doesn't show up
                                        in the queue again for 7 days. */}
                                    {!s.ready && (
                                        (() => {
                                            const state = sendingState[s.name];
                                            const cooldownActive = s.reminderSentMs
                                                && (Date.now() - s.reminderSentMs) < REMINDER_COOLDOWN_DAYS * 86400000;
                                            // Only blocker is missing phone — opt-in /
                                            // STOP don't apply since this isn't Twilio
                                            // (admin is texting from their personal cell).
                                            const noPhone = !s.phoneE164;
                                            const { url: smsUrl } = composeSetupReminderSmsUrl(s.raw, language);
                                            const reason = noPhone
                                                ? tx('no phone on file', 'sin teléfono')
                                                : cooldownActive
                                                ? tx(`texted ${fmtRelative(s.reminderSentMs, isEs)}`, `enviado ${fmtRelative(s.reminderSentMs, isEs)}`)
                                                : '';
                                            // Disabled view: no phone OR already-sent state.
                                            // Cooldown still allows a click (the admin
                                            // can choose to re-text manually); reason
                                            // line just informs them.
                                            if (noPhone || state === 'sent') {
                                                return (
                                                    <span
                                                        className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-glass-sm border whitespace-nowrap ${
                                                            state === 'sent'
                                                                ? 'bg-dd-green text-white border-dd-green'
                                                                : 'bg-dd-bg/50 text-dd-text-2/60 border-dd-line'
                                                        }`}
                                                        title={reason || tx('Sent', 'Enviado')}
                                                    >
                                                        {state === 'sent'
                                                            ? <Check size={11} strokeWidth={3} aria-hidden="true" />
                                                            : <PhoneOff size={11} strokeWidth={2.5} aria-hidden="true" />}
                                                        {state === 'sent' ? tx('Texted', 'Enviado') : tx('No phone', 'Sin tel.')}
                                                    </span>
                                                );
                                            }
                                            return (
                                                <a
                                                    href={smsUrl}
                                                    onClick={() => handleStampReminderSent(s)}
                                                    className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-glass-sm border whitespace-nowrap transition active:scale-95 ${
                                                        cooldownActive
                                                            ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                                                            : 'bg-amber-500 text-white border-amber-600 hover:bg-amber-600'
                                                    }`}
                                                    title={cooldownActive
                                                        ? tx(`Already texted ${fmtRelative(s.reminderSentMs, isEs)} — tap again to re-text.`, `Enviado ${fmtRelative(s.reminderSentMs, isEs)} — toca para reenviar.`)
                                                        : tx('Open native Messages app pre-filled. Reviews & sends from your phone.', 'Abre Mensajes del teléfono con el texto listo.')}
                                                >
                                                    {state === 'sending'
                                                        ? <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                                                        : <MessageSquare size={11} strokeWidth={2.5} aria-hidden="true" />}
                                                    <span>
                                                        {cooldownActive ? reason : tx('Text', 'SMS')}
                                                    </span>
                                                </a>
                                            );
                                        })()
                                    )}
                                </div>
                            ))
                        )}
                    </div>

                    <p className="text-caption-md text-dd-text-2/70 mt-3 italic leading-relaxed">
                        {tx(
                            'Last sign-in = session-start stamp (~1 per 30 min). Push = most recent FCM refresh; only shown when it diverges from sign-in (means push setup failed even though they signed in). Notif = at least one device registered for push. PWA = opened from a home-screen install. Text = opens the Messages app on YOUR phone pre-filled — review + send manually from your number. 7-day cooldown per staffer.',
                            'Última conexión = sello de inicio (~1/30min). Push = renovación reciente; solo se muestra si difiere. Notif = dispositivo registrado. PWA = abrió desde icono. SMS = abre Mensajes en tu teléfono — revisa y envía manualmente. Espera 7 días entre envíos.'
                        )}
                    </p>
                </>
            )}

            {toast && (
                <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 glass-card px-4 py-2 text-body-md font-bold shadow-glass-floating z-50 max-w-[92vw] text-center">
                    {toast}
                </div>
            )}
        </div>
    );
}

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

function FilterChip({ on, onClick, tone, children }) {
    const onClasses = tone === 'amber' ? 'bg-amber-500 text-white' : 'bg-dd-green text-white';
    return (
        <button
            type="button"
            onClick={onClick}
            className={`px-3 py-1 rounded-sm text-xs font-bold transition ${on ? onClasses : 'text-dd-text-2'}`}
        >
            {children}
        </button>
    );
}
