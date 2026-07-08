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

import { useEffect, useMemo, useState } from 'react';
import {
    Users, Bell, BellOff, Smartphone, MonitorOff,
    Check, AlertTriangle, Clock, ChevronDown, MonitorSmartphone, Wifi, Globe,
    MessageSquare, Send, PhoneOff, Phone,
} from 'lucide-react';
import { composeSetupReminderSmsUrl, stampSetupReminderSent, sendSetupReminderSms } from '../data/notify';

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

export default function StaffUsageAudit({ staffList = [], language = 'en', currentManagerName = '', currentManagerId = null, onSetPhone = null }) {
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
    // 2026-05-29 — Andrew: "the no phone number for now make it so if we
    // click the no phone button i can add a phone number and it will
    // pull up a window like when we send out onboarding docs". Modal
    // state — null when closed, the raw staff row when open. We trust
    // onSetPhone (passed from AdminPanel) to normalize + validate +
    // write to /config/staff + log the phone_change audit event.
    const [addingPhoneFor, setAddingPhoneFor] = useState(null);

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

    // 2026-07-07 — Andrew: "when i dont see them as signed on yet i can
    // send a sms too. my twilio account should be done." The automatic
    // Twilio path (sendSetupReminderSms) was built in May but unwired
    // when carrier A2P registration was pending and Andrew wanted
    // manual sends from his own phone. Registration is approved now,
    // so the auto button is back — ALONGSIDE the manual link, because
    // the manual path still covers staff who never opted in to SMS.
    // sendSetupReminderSms enforces phone/opt-in/STOP + the 7-day
    // cooldown itself; `force` re-sends past the cooldown when the
    // admin explicitly taps an already-texted chip.
    async function handleAutoText(staffRow, force = false) {
        if (!staffRow?.name) return;
        setSendingState((m) => ({ ...m, [staffRow.name]: 'sending' }));
        const res = await sendSetupReminderSms(
            staffRow,
            { name: currentManagerName, id: currentManagerId },
            { force },
        );
        if (res.ok) {
            setSendingState((m) => ({ ...m, [staffRow.name]: 'sent' }));
            setToast(tx(`Text sent to ${staffRow.name}`, `SMS enviado a ${staffRow.name}`));
            setTimeout(() => setToast(null), 3000);
        } else {
            setSendingState((m) => {
                const n = { ...m };
                delete n[staffRow.name];
                return n;
            });
            const msg = res.reason === 'cooldown'
                ? tx('Already texted recently', 'Ya enviado recientemente')
                : res.reason === 'not_opted_in'
                ? tx('Not opted in to SMS', 'Sin consentimiento SMS')
                : res.reason === 'replied_stop'
                ? tx('They replied STOP — cannot text', 'Respondió STOP — no se puede enviar')
                : tx('Text failed', 'Error al enviar SMS');
            setToast(msg);
            setTimeout(() => setToast(null), 4000);
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
                // TRUE = last opened the DOWNLOADED native app (iOS/Android).
                // Undefined on staff who haven't signed in since this shipped →
                // they read as "web" until their next session stamps it.
                native: s.lastSignInNative === true,
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
        const onApp = rows.filter((r) => r.native).length;
        return { total, notif, installed, ready, activeToday, activeWeek, inactive7d, onApp };
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
                                `${stats.activeToday} active today · ${stats.onApp} on app / ${stats.total - stats.onApp} on web · ${stats.ready}/${stats.total} set up`,
                                `${stats.activeToday} hoy · ${stats.onApp} en app / ${stats.total - stats.onApp} en web · ${stats.ready}/${stats.total} listos`
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
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2 mt-4">
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
                            label={tx('On the app', 'En la app')}
                            value={`${stats.onApp}/${stats.total}`}
                            tone="green"
                            Icon={Smartphone}
                        />
                        <StatChip
                            label={tx('PWA installed', 'PWA inst.')}
                            value={`${stats.installed}/${stats.total}`}
                            tone={stats.installed === stats.total ? 'green' : 'amber'}
                            Icon={MonitorSmartphone}
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
                                            {(s.native || s.platform) && (
                                                <span className={`ml-1 inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${s.native ? 'bg-dd-sage-50 text-dd-green-700 border-dd-green/40' : 'bg-dd-bg/80 text-dd-text-2 border-dd-line'}`}>
                                                    {s.native
                                                        ? <Smartphone size={9} strokeWidth={2.5} aria-hidden="true" />
                                                        : <Globe size={9} strokeWidth={2.5} aria-hidden="true" />}
                                                    {s.native
                                                        ? `${s.platform || ''} ${tx('App', 'App')}`.trim()
                                                        : `${tx('Web', 'Web')}${s.standalone ? ' · PWA' : (s.platform ? ` · ${s.platform}` : '')}`}
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
                                            // "Texted ✓" — terminal state once the admin
                                            // taps the sms: link. Stays visible until
                                            // the next snapshot refresh.
                                            if (state === 'sent') {
                                                return (
                                                    <span
                                                        className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-glass-sm border whitespace-nowrap bg-dd-green text-white border-dd-green"
                                                        title={tx('Sent', 'Enviado')}
                                                    >
                                                        <Check size={11} strokeWidth={3} aria-hidden="true" />
                                                        {tx('Texted', 'Enviado')}
                                                    </span>
                                                );
                                            }
                                            // "No phone" — clickable. Opens the
                                            // AddPhoneSheet modal so an admin can
                                            // add the number on the spot without
                                            // bouncing to the staff editor below.
                                            // Disabled only if AdminPanel didn't
                                            // pass onSetPhone (defensive — should
                                            // never happen in practice).
                                            if (noPhone) {
                                                if (!onSetPhone) {
                                                    return (
                                                        <span
                                                            className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-glass-sm border whitespace-nowrap bg-dd-bg/50 text-dd-text-2/60 border-dd-line"
                                                            title={reason}
                                                        >
                                                            <PhoneOff size={11} strokeWidth={2.5} aria-hidden="true" />
                                                            {tx('No phone', 'Sin tel.')}
                                                        </span>
                                                    );
                                                }
                                                return (
                                                    <button
                                                        type="button"
                                                        onClick={() => setAddingPhoneFor(s.raw)}
                                                        className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-glass-sm border whitespace-nowrap bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100 active:scale-95 transition"
                                                        title={tx('Add a phone number for this staffer', 'Agrega un número de teléfono para este personal')}
                                                    >
                                                        <Phone size={11} strokeWidth={2.5} aria-hidden="true" />
                                                        {tx('Add phone', 'Añadir tel.')}
                                                    </button>
                                                );
                                            }
                                            // Twilio-eligible (opted in, hasn't replied
                                            // STOP) → also show the automatic send.
                                            // 2026-07-07: Twilio A2P registration is
                                            // approved, so real sends work again. The
                                            // manual link stays for staff who never
                                            // opted in — and for admins who prefer
                                            // texting from their own phone.
                                            const autoEligible = s.raw?.smsOptIn === true && s.raw?.smsStopped !== true;
                                            return (
                                                <span className="shrink-0 inline-flex items-center gap-1">
                                                    {autoEligible && (
                                                        <button
                                                            type="button"
                                                            onClick={() => handleAutoText(s.raw, cooldownActive)}
                                                            disabled={state === 'sending'}
                                                            className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-glass-sm border whitespace-nowrap bg-dd-green text-white border-dd-green hover:bg-dd-green-700 active:scale-95 transition"
                                                            title={cooldownActive
                                                                ? tx(`Already texted ${fmtRelative(s.reminderSentMs, isEs)} — tap to send again now (Twilio).`, `Enviado ${fmtRelative(s.reminderSentMs, isEs)} — toca para reenviar (Twilio).`)
                                                                : tx('Send the reminder text automatically from the DD Mau number (Twilio).', 'Enviar el SMS automáticamente desde el número DD Mau (Twilio).')}
                                                        >
                                                            {state === 'sending'
                                                                ? <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                                                                : <Send size={11} strokeWidth={2.5} aria-hidden="true" />}
                                                            <span>{tx('Auto-text', 'SMS auto')}</span>
                                                        </button>
                                                    )}
                                                    <a
                                                        href={smsUrl}
                                                        onClick={() => handleStampReminderSent(s)}
                                                        className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-glass-sm border whitespace-nowrap transition active:scale-95 ${
                                                            cooldownActive
                                                                ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                                                                : 'bg-amber-500 text-white border-amber-600 hover:bg-amber-600'
                                                        }`}
                                                        title={cooldownActive
                                                            ? tx(`Already texted ${fmtRelative(s.reminderSentMs, isEs)} — tap again to re-text.`, `Enviado ${fmtRelative(s.reminderSentMs, isEs)} — toca para reenviar.`)
                                                            : tx('Open native Messages app pre-filled. Reviews & sends from your phone.', 'Abre Mensajes del teléfono con el texto listo.')}
                                                    >
                                                        <MessageSquare size={11} strokeWidth={2.5} aria-hidden="true" />
                                                        <span>
                                                            {cooldownActive ? reason : tx('My phone', 'Mi tel.')}
                                                        </span>
                                                    </a>
                                                </span>
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

            {addingPhoneFor && (
                <AddPhoneSheet
                    staff={addingPhoneFor}
                    isEs={isEs}
                    onClose={() => setAddingPhoneFor(null)}
                    onSave={async (raw) => {
                        if (!onSetPhone) return false;
                        const result = await onSetPhone(addingPhoneFor, raw);
                        // setPhoneForStaff returns the normalized E.164
                        // on success (or '' if cleared), null on invalid.
                        // Treat null as "stay open" so the admin can
                        // correct the input; everything else closes.
                        if (result === null) return false;
                        setAddingPhoneFor(null);
                        return true;
                    }}
                />
            )}
        </div>
    );
}

// AddPhoneSheet — modeled after Onboarding.jsx's InviteSheet. Bottom
// sheet on mobile, centered card on desktop. Loose validation here
// (10+ digits) so the user gets quick feedback while typing; the real
// E.164 normalize + reject happens in onSave (setPhoneForStaff) which
// shows a toast if the input is unparseable. Trapping Escape + tapping
// the scrim both close.
function AddPhoneSheet({ staff, isEs, onClose, onSave }) {
    const tx = (en, es) => (isEs ? es : en);
    const [value, setValue] = useState('');
    const [saving, setSaving] = useState(false);

    // Escape closes — matches the modal patterns elsewhere in the app.
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    // 10+ digits gives us enough confidence to enable the Save button.
    // The real authority (normalizeToE164) lives in setPhoneForStaff.
    const digitCount = (value.match(/\d/g) || []).length;
    const looksValid = digitCount >= 10;
    const canSave = looksValid && !saving;

    const handleSave = async () => {
        if (!canSave) return;
        setSaving(true);
        try {
            await onSave(value);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div
            className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={onClose}
        >
            <div
                className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="border-b border-dd-line p-4 flex items-center justify-between safe-top [--safe-top-base:1rem]">
                    <h3 className="text-lg font-black text-dd-text">
                        📱 {tx('Add phone number', 'Añadir teléfono')}
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        className="w-8 h-8 rounded-full bg-dd-bg text-dd-text-2 text-lg"
                        aria-label={tx('Close', 'Cerrar')}
                    >
                        ×
                    </button>
                </div>
                <div className="p-4 space-y-3">
                    <p className="text-sm text-dd-text-2">
                        {tx('Saving a number for ', 'Guardando un número para ')}
                        <span className="font-bold text-dd-text">{staff?.name}</span>.
                        {' '}{tx('They will need to opt in to SMS separately (handbook acknowledgment or the SMS toggle in their staff card).', 'El personal debe activar SMS por separado (firma del manual o el botón SMS en su tarjeta).')}
                    </p>
                    <label className="block">
                        <span className="text-[11px] font-bold uppercase text-dd-text-2">
                            {tx('Mobile phone', 'Teléfono móvil')}
                        </span>
                        <input
                            type="tel"
                            inputMode="tel"
                            autoComplete="tel"
                            autoFocus
                            value={value}
                            onChange={(e) => setValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && canSave) {
                                    e.preventDefault();
                                    handleSave();
                                }
                            }}
                            placeholder="(314) 555-1234"
                            className="mt-1 w-full px-3 py-2 rounded-lg border border-dd-line font-mono text-base text-dd-text focus:outline-none focus:border-dd-green focus:ring-2 focus:ring-dd-green-50"
                        />
                        <span className="block mt-1 text-[11px] text-dd-text-2/80">
                            {tx('10 digits — US numbers will be normalized to +1xxxxxxxxxx.', '10 dígitos — los números de EE. UU. se normalizan a +1xxxxxxxxxx.')}
                        </span>
                    </label>
                </div>
                <div className="border-t border-dd-line p-4 flex gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="flex-1 py-2 rounded-lg bg-dd-bg text-dd-text-2 font-bold"
                    >
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={!canSave}
                        className="flex-1 py-2 rounded-lg bg-dd-green text-white font-bold disabled:opacity-50 inline-flex items-center justify-center gap-2"
                    >
                        {saving
                            ? <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                            : <Check size={14} strokeWidth={2.75} aria-hidden="true" />}
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </div>
            </div>
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
