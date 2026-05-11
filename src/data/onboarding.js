// Onboarding data model + constants.
//
// 2026-05-11: replaces HigherMe for new-hire paperwork. PII goldmine —
// SSN, DL photos, W4 (SSN + DOB), I-9, direct deposit account/routing.
// EVERY field below is treated as sensitive: stored in Firebase Storage
// (not Firestore), gated to a small allowlist of admins (Julie + Andrew),
// every read audited. See firestore.rules + storage.rules for the wire-
// level enforcement.
//
// Flow:
//   1. Admin creates a new hire record → generates a 1-time invite token.
//   2. Token is delivered as link / QR code / SMS handoff.
//   3. New hire opens link → token-gated portal → fills personal +
//      emergency contact + uploads docs to Storage.
//   4. Admin dashboard shows per-hire donut + can download a zip.
//
// Files in Storage:
//   onboarding/{hireId}/{docTypeId}/{filename}.{ext}
//
// Firestore docs:
//   onboarding_hires/{hireId} — full record + checklist state
//   onboarding_invites/{token} — short-lived token → hireId mapping
//   onboarding_applications/{appId} — lock-screen "apply" submissions
//   onboarding_audits/{auditId} — admin view/download audit log

// Master document checklist. `required: true` means a hire can't be marked
// "complete" until that doc is uploaded. Minor permit auto-required for
// hires whose DOB indicates under-18.
export const ONBOARDING_DOCS = [
    {
        id: 'personal_info',
        en: 'Personal info',
        es: 'Información personal',
        emoji: '👤',
        kind: 'form',   // filled in the portal, no file upload
        required: true,
        description: 'Legal name, address, DOB, phone',
    },
    {
        id: 'emergency_contact',
        en: 'Emergency contact',
        es: 'Contacto de emergencia',
        emoji: '🚑',
        kind: 'form',
        required: true,
        description: 'Name, relation, phone',
    },
    {
        id: 'w4',
        en: 'W-4 (Federal tax)',
        es: 'W-4 (Impuestos federales)',
        emoji: '🧾',
        kind: 'file',
        required: true,
        description: 'IRS Form W-4. Print, fill, sign, upload a photo or PDF.',
    },
    {
        id: 'direct_deposit',
        en: 'Direct deposit form',
        es: 'Depósito directo',
        emoji: '🏦',
        kind: 'file',
        required: true,
        description: 'Filled DD form + voided check or bank letter.',
    },
    {
        id: 'i9',
        en: 'I-9 work authorization',
        es: 'I-9 autorización de trabajo',
        emoji: '✅',
        kind: 'file',
        required: true,
        description: 'Section 1 of Form I-9, signed.',
    },
    {
        id: 'driver_license_front',
        en: "Driver's license — front",
        es: 'Licencia de conducir — frente',
        emoji: '🪪',
        kind: 'file',
        required: true,
        description: 'Clear photo of the front of your DL or state ID.',
    },
    {
        id: 'driver_license_back',
        en: "Driver's license — back",
        es: 'Licencia de conducir — reverso',
        emoji: '🪪',
        kind: 'file',
        required: true,
        description: 'Clear photo of the back.',
    },
    {
        id: 'ssn_card',
        en: 'Social Security card',
        es: 'Tarjeta de Seguro Social',
        emoji: '🔐',
        kind: 'file',
        required: true,
        description: 'Clear photo of your SS card.',
    },
    {
        id: 'minor_permit',
        en: 'Minor work permit',
        es: 'Permiso de menor',
        emoji: '🧒',
        kind: 'file',
        required: false,            // auto-required when DOB indicates under 18
        description: 'Required if you are under 18. School-issued work permit.',
        minorOnly: true,
    },
];

// Per-doc state on a hire record. Lives at
//   onboarding_hires/{hireId}.checklist[docId] = { status, ... }
// Status flow:
//   needed   — nothing yet
//   opened   — hire opened the portal but hasn't started this doc
//   started  — hire began filling/uploading (form partial, or upload in flight)
//   submitted — hire finished. Admin can review.
//   approved — admin reviewed and accepted (final).
//   rejected — admin sent back. The hire sees a reason and re-uploads.
export const DOC_STATUS = {
    NEEDED:    'needed',
    OPENED:    'opened',
    STARTED:   'started',
    SUBMITTED: 'submitted',
    APPROVED:  'approved',
    REJECTED:  'rejected',
};

// Color/emoji metadata for status pills. Keep these vocabularies in sync
// with the Tailwind classes available in the project (dd-*, green-*, etc.).
export const DOC_STATUS_META = {
    needed:    { en: 'Needed',    es: 'Falta',       emoji: '⚪', tone: 'bg-gray-100 text-gray-600 border-gray-200' },
    opened:    { en: 'Opened',    es: 'Abierto',     emoji: '👀', tone: 'bg-blue-50 text-blue-700 border-blue-200' },
    started:   { en: 'Started',   es: 'Empezado',    emoji: '✍️', tone: 'bg-amber-50 text-amber-700 border-amber-200' },
    submitted: { en: 'Submitted', es: 'Entregado',   emoji: '📤', tone: 'bg-purple-50 text-purple-700 border-purple-200' },
    approved:  { en: 'Approved',  es: 'Aprobado',    emoji: '✅', tone: 'bg-green-50 text-green-700 border-green-200' },
    rejected:  { en: 'Rejected',  es: 'Rechazado',   emoji: '❌', tone: 'bg-red-50 text-red-700 border-red-200' },
};

// Hire-level status — derived from checklist completeness but stored on the
// record for cheap dashboard sorting.
export const HIRE_STATUS = {
    INVITED:    'invited',     // record created, link not yet opened
    IN_PROGRESS: 'in_progress',// hire opened at least one doc
    AWAITING_REVIEW: 'awaiting_review', // all required docs submitted
    COMPLETE:   'complete',    // admin approved everything
    ARCHIVED:   'archived',    // admin marked done & moved to history
};

export const HIRE_STATUS_META = {
    invited:         { en: 'Invited',         es: 'Invitado',       tone: 'bg-gray-100 text-gray-700' },
    in_progress:     { en: 'In progress',     es: 'En progreso',    tone: 'bg-blue-50 text-blue-700' },
    awaiting_review: { en: 'Awaiting review', es: 'Por revisar',    tone: 'bg-amber-50 text-amber-700' },
    complete:        { en: 'Complete',        es: 'Completo',       tone: 'bg-green-50 text-green-700' },
    archived:        { en: 'Archived',        es: 'Archivado',      tone: 'bg-gray-50 text-gray-500' },
};

// Invite token lifetime — links are single-use and time-boxed.
// 30 days is enough for a slow hire to finish paperwork but not so long
// that a leaked link sits exploitable forever.
export const INVITE_TTL_DAYS = 30;

// URL-safe random token. Browser crypto.getRandomValues; falls back to
// Math.random in environments that don't have it (shouldn't happen in
// any browser the app supports, but be defensive).
export function makeInviteToken() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const out = new Array(24);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const buf = new Uint32Array(24);
        crypto.getRandomValues(buf);
        for (let i = 0; i < 24; i++) out[i] = chars[buf[i] % chars.length];
    } else {
        for (let i = 0; i < 24; i++) out[i] = chars[Math.floor(Math.random() * chars.length)];
    }
    return out.join('');
}

// Compute the doc list for a given hire — returns the master list with
// the minor permit included only when the DOB indicates under 18 (or
// when the admin explicitly flagged isMinor on the record).
export function docsForHire(hire) {
    const isMinor = isHireMinor(hire);
    return ONBOARDING_DOCS.filter(d => !d.minorOnly || isMinor).map(d => ({
        ...d,
        required: d.required || (d.minorOnly && isMinor),
    }));
}

export function isHireMinor(hire) {
    if (!hire) return false;
    if (hire.isMinor === true) return true;
    if (hire.isMinor === false) return false;
    const dob = hire.personal && hire.personal.dob;
    if (!dob) return false;
    // dob is "YYYY-MM-DD"
    const parts = String(dob).split('-').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return false;
    const [y, m, d] = parts;
    const today = new Date();
    let age = today.getFullYear() - y;
    const m0 = today.getMonth() + 1;
    const d0 = today.getDate();
    if (m0 < m || (m0 === m && d0 < d)) age--;
    return age < 18;
}

// Computes hire-level status from the checklist. Pure function — derives
// state but does NOT write to Firestore. The dashboard calls this on
// every render; a Cloud Function could later mirror this into the hire
// doc for cheap querying.
export function deriveHireStatus(hire) {
    if (!hire) return HIRE_STATUS.INVITED;
    if (hire.status === HIRE_STATUS.ARCHIVED) return HIRE_STATUS.ARCHIVED;
    if (hire.status === HIRE_STATUS.COMPLETE) return HIRE_STATUS.COMPLETE;
    const docs = docsForHire(hire);
    const checklist = hire.checklist || {};
    const required = docs.filter(d => d.required);
    const requiredStatuses = required.map(d => (checklist[d.id] && checklist[d.id].status) || DOC_STATUS.NEEDED);
    // Any not yet started → invited or in_progress
    const allNeeded = requiredStatuses.every(s => s === DOC_STATUS.NEEDED);
    if (allNeeded) return HIRE_STATUS.INVITED;
    const allSubmittedOrBetter = requiredStatuses.every(s => (
        s === DOC_STATUS.SUBMITTED || s === DOC_STATUS.APPROVED
    ));
    if (allSubmittedOrBetter) {
        const allApproved = requiredStatuses.every(s => s === DOC_STATUS.APPROVED);
        return allApproved ? HIRE_STATUS.COMPLETE : HIRE_STATUS.AWAITING_REVIEW;
    }
    return HIRE_STATUS.IN_PROGRESS;
}

// Counts {needed, started, submitted, approved} across the required docs
// for a hire. Used by the donut/progress UI.
export function hireProgressCounts(hire) {
    const docs = docsForHire(hire);
    const checklist = hire?.checklist || {};
    const counts = { total: 0, needed: 0, started: 0, submitted: 0, approved: 0 };
    docs.forEach(d => {
        if (!d.required) return;
        counts.total++;
        const st = (checklist[d.id] && checklist[d.id].status) || DOC_STATUS.NEEDED;
        if (st === DOC_STATUS.APPROVED) counts.approved++;
        else if (st === DOC_STATUS.SUBMITTED) counts.submitted++;
        else if (st === DOC_STATUS.STARTED || st === DOC_STATUS.OPENED) counts.started++;
        else counts.needed++;
    });
    return counts;
}
