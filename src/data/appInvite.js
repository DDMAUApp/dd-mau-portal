// ── "Text app invite" for new hires (Andrew 2026-11-14) ──────────────
// "in the new hire profiles next to the add to staff [button] make one that
// sends a invite to the app. something i can text to the new hire like i do
// when we invite them to fill out onboarding docs."
//
// Same manual-SMS pattern as the onboarding invite + StaffUsageAudit: we build
// an sms:NUMBER?body=... link, the admin's own Messages app opens pre-filled,
// and THEY tap Send. No Twilio (A2P campaign rejected — see project memory).
//
// The PIN line is included only when the hire already has a staff record
// (Add to Staff done) — before that they have no PIN and the app can't log
// them in yet, so the text says so instead of sending a dead invite.
//
// Android while the app is a CLOSED Play test: Play shows "not available" to
// anyone not on the tester list. The text asks them to reply with their Google
// email so the admin can add them (or they can use the Install app form on the
// lock screen, which lands in /tester_requests + pings managers).
import { IOS_APP_URL, ANDROID_APP_URL } from '../components/InstallAppButton';

export function buildAppInviteText({ name, pin, lang } = {}) {
    const first = String(name || '').trim().split(/\s+/)[0] || '';
    const es = lang === 'es';
    const hi = es ? (first ? `¡Hola ${first}!` : '¡Hola!') : (first ? `Hi ${first}!` : 'Hi!');
    const lines = es
        ? [
            `${hi} Descarga la app de personal de DD Mau — ahí verás tu horario, el chat y tu entrenamiento.`,
            '',
            `iPhone: ${IOS_APP_URL}`,
            `Android: ${ANDROID_APP_URL}`,
            '',
            pin ? `Tu PIN para entrar: ${pin}` : 'Te mandaré tu PIN para entrar pronto.',
            '',
            'Android: si Google Play dice “no disponible”, respóndeme con el correo de Google (Gmail) de tu teléfono y te agrego.',
        ]
        : [
            `${hi} Download the DD Mau staff app — it's where you'll see your schedule, chat, and training.`,
            '',
            `iPhone: ${IOS_APP_URL}`,
            `Android: ${ANDROID_APP_URL}`,
            '',
            pin ? `Your login PIN: ${pin}` : "I'll send your login PIN soon.",
            '',
            'Android: if Google Play says "not available," text me back the Google (Gmail) email on your phone and I\'ll add you.',
        ];
    return lines.join('\n');
}

export function appInviteSmsHref(phone, text) {
    const p = String(phone || '').trim();
    if (!p) return null;
    return `sms:${p}?body=${encodeURIComponent(text)}`;
}
