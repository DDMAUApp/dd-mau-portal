// Client-side SMS helpers — pure utilities for phone validation,
// E.164 normalization, and opt-in event logging from the app.
//
// The actual SMS send happens server-side via dispatchSms (Cloud
// Function) — this module never calls Twilio directly. It exists so
// the AdminPanel + any future self-service Profile UI can:
//
//   • Normalize whatever the user types into a clean E.164 number
//     before saving to /config/staff.list[].phoneE164
//   • Write to /sms_opt_in_events whenever someone flips the
//     smsOptIn toggle, so compliance has a full event history
//
// All bilingual copy is kept in CONSENT_TEXT below + mirrored exactly
// in functions/smsTemplates.js. Bump CONSENT_TEXT_VERSION in BOTH
// places when the disclosure language changes.

import { db } from '../firebase';
import { addDoc, collection, doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';

// Bump in lockstep with functions/smsTemplates.js CONSENT_TEXT_VERSION
// whenever the disclosure language changes. The version is snapshotted
// into every opt-in event row so audits can prove exactly what each
// staffer agreed to at the moment they agreed.
export const CONSENT_TEXT_VERSION = 'v1_2026-05-19';

export const CONSENT_TEXT = {
    en:
        'By opting in, you agree to receive urgent operational text messages ' +
        'from DD Mau (shift reminders, coverage requests, schedule changes, ' +
        'weather closures, 86 alerts). Message frequency varies. Msg & data ' +
        'rates may apply. Reply STOP to cancel. Reply HELP for help.',
    es:
        'Al activar esto, aceptas recibir mensajes de texto urgentes de DD Mau ' +
        '(recordatorios de turno, solicitudes de cobertura, cambios de horario, ' +
        'cierres por clima, alertas 86). La frecuencia varía. Pueden aplicar ' +
        'tarifas de mensajes y datos. Responde STOP para cancelar. HELP para ayuda.',
};

// Normalize any phone-shaped string to E.164. US-default because that's
// DD Mau's staff base. Returns null on anything we can't confidently
// turn into E.164 — caller treats null as "invalid, don't save."
//
// Accepts:
//   • Already-E.164:        '+13145551234'         → '+13145551234'
//   • US 10-digit:          '3145551234'           → '+13145551234'
//   • US with formatting:   '(314) 555-1234'       → '+13145551234'
//   • US with country:      '13145551234'          → '+13145551234'
//   • US with country + +:  '+13145551234'         → '+13145551234'
//
// Rejects:
//   • Non-US country codes we don't recognize (caller can pre-prefix)
//   • Anything under 10 digits
//   • Anything over 15 (E.164 max)
//   • Empty / non-string
export function normalizeToE164(input) {
    if (input == null) return null;
    const raw = String(input).trim();
    if (!raw) return null;
    // Strip everything that isn't a digit or leading '+'.
    const cleaned = raw.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) {
        // Already prefixed. Validate length + digit-only after the +.
        const digits = cleaned.slice(1);
        if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
        return '+' + digits;
    }
    const digits = cleaned;
    // Bare 10-digit US number.
    if (digits.length === 10 && /^[2-9]/.test(digits)) {
        return '+1' + digits;
    }
    // 11-digit with country code 1.
    if (digits.length === 11 && digits.startsWith('1') && /^1[2-9]/.test(digits)) {
        return '+' + digits;
    }
    return null;
}

// Validate without normalizing — true iff the input would be a clean
// E.164 after normalizeToE164. Use this for live form validation.
export function isValidPhone(input) {
    return normalizeToE164(input) !== null;
}

// Human-readable US-style format from an E.164 number. Used in the
// AdminPanel to show "(314) 555-1234" instead of "+13145551234" so
// admins recognize the number. Returns the raw E.164 if it's not a
// US number (so we don't garbage non-US formats).
export function formatE164ForDisplay(e164) {
    if (!e164 || typeof e164 !== 'string') return '';
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
    if (!m) return e164;
    return `(${m[1]}) ${m[2]}-${m[3]}`;
}

// Write one /sms_opt_in_events row. Called whenever a staff member's
// smsOptIn flag changes — by self, by admin, or by system.
//
// This is the compliance evidence trail: every change goes here with
// a timestamp, the source, who triggered it, and a snapshot of the
// exact consent text + version that was shown. If a carrier ever asks
// for proof of consent, this collection is the answer.
//
// Best-effort with a loud failure mode — we log the error but DO NOT
// throw. Losing an opt-in event row is bad but blocking the underlying
// admin UI action would be worse. The server-side path
// (functions/sms.js writeOptInEvent) re-throws because over there a
// missing row is a compliance failure.
export async function writeClientOptInEvent({
    staffId,
    staffName,
    phoneE164,
    action,             // 'opt_in' | 'opt_out'
    source,             // 'self_app' | 'admin_panel' | 'onboarding_form'
    byName,             // who triggered it (admin name when source=admin_panel)
    byId,
    note = null,
}) {
    try {
        await addDoc(collection(db, 'sms_opt_in_events'), {
            staffId: staffId ?? null,
            staffName: staffName || null,
            phoneE164: phoneE164 || null,
            action,
            source,
            byName: byName || 'unknown',
            byId: byId ?? null,
            consentTextVersion: CONSENT_TEXT_VERSION,
            consentTextEn: CONSENT_TEXT.en,
            consentTextEs: CONSENT_TEXT.es,
            ipAddress: null,                       // server-side path will stamp this if available
            userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || null,
            twilioMessageSid: null,                // only set when source=sms_stop_reply / sms_start_reply
            note,
            at: serverTimestamp(),
        });
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('writeClientOptInEvent failed (non-fatal):', e);
    }
}

// Convenience: derive a status pill for the AdminPanel staff card.
// Returns { label, tone, en, es } where tone is a Tailwind class set.
//
// Status priority (highest first):
//   1. stopped       — user replied STOP; manual admin override required
//   2. failed        — last send failed (bad number, carrier reject, etc.)
//   3. opted-out     — smsOptIn=false, user/admin choice
//   4. invalid-num   — phoneE164 missing or malformed
//   5. active        — opted in, has a valid number, no recent failures
//   6. no-phone      — fallback for staff with no phone on file yet
export function smsStatusPill(staff) {
    if (!staff) return { key: 'unknown', label: { en: '—', es: '—' }, tone: 'bg-gray-100 text-gray-500 border-gray-200' };
    if (staff.smsStopped === true) {
        return {
            key: 'stopped',
            label: { en: '🛑 Stopped (STOP reply)', es: '🛑 Detenido (respondió STOP)' },
            tone: 'bg-red-50 text-red-700 border-red-200',
        };
    }
    if (staff.smsLastDeliveryStatus === 'failed' || staff.smsLastDeliveryStatus === 'undelivered') {
        return {
            key: 'failed',
            label: { en: '⚠ Last send failed', es: '⚠ Último envío falló' },
            tone: 'bg-orange-50 text-orange-800 border-orange-200',
        };
    }
    if (staff.smsOptIn !== true) {
        if (!staff.phoneE164) {
            return {
                key: 'no_phone',
                label: { en: '📵 No phone on file', es: '📵 Sin teléfono' },
                tone: 'bg-gray-50 text-gray-500 border-gray-200',
            };
        }
        return {
            key: 'opted_out',
            label: { en: '⏸ Not opted in', es: '⏸ No activado' },
            tone: 'bg-gray-50 text-gray-600 border-gray-200',
        };
    }
    if (!staff.phoneE164 || !isValidPhone(staff.phoneE164)) {
        return {
            key: 'invalid_number',
            label: { en: '⚠ Invalid number', es: '⚠ Número inválido' },
            tone: 'bg-orange-50 text-orange-800 border-orange-200',
        };
    }
    return {
        key: 'active',
        label: { en: '✓ Active', es: '✓ Activo' },
        tone: 'bg-green-50 text-green-700 border-green-200',
    };
}
