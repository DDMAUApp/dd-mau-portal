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

// Location → legal entity + street address. DD Mau the BRAND operates
// under two different LLCs depending on the physical store:
//   • Webster Groves  = DD Mau LLC
//   • Maryland Heights = Forsis LLC (DBA DD Mau)
// The offer letter pulls the right entity + address from this map based
// on the hire's assigned location. Edit here when addresses change.
// TODO: Maryland Heights street address — update once Andrew provides it.
export const LOCATION_INFO = {
    webster: {
        legalEntity: 'DD Mau LLC',
        address: '8169 Big Bend Blvd, Saint Louis, MO 63119',
        label: 'Webster Groves',
    },
    maryland: {
        legalEntity: 'Forsis LLC',
        address: 'Maryland Heights, MO',  // TODO: full street address
        label: 'Maryland Heights',
    },
};

// Master document checklist. `required: true` means a hire can't be marked
// "complete" until that doc is uploaded. Minor permit auto-required for
// hires whose DOB indicates under-18.
//
// `kind`:
//   - 'form'     — structured form filled in the portal (no file upload)
//   - 'file'     — hire uploads photo/PDF straight to Storage
//   - 'template' — admin-prepared fillable PDF template; hire fills inputs
//                  + signs in-browser, we generate a flattened PDF on submit
//   - 'id'       — flexible "any acceptable ID" slot. Hire labels the doc
//                  type (passport, DL, state ID, SSN card, etc.) and uploads.
//                  Two ID slots, hire picks whichever they have.
//
// `daysFromHire` (optional): informational metadata only — the federal
// or jurisdictional deadline in days from hire start date. NO code reads
// this field anymore (the daily reminder scan + the "Due in N days /
// Overdue" pills were removed 2026-05-18; admins use the manual 📧
// Remind / ↻ Resend invite buttons instead). Kept here so the rule
// (W-4 = 7 days, I-9 Section 1 = first day, I-9 docs = 3 days, etc.)
// stays visible to the next person who touches this list. Easy to wire
// automation back up later if needed.
//
// Templates live in /onboarding_templates/{templateId} with a `forDocId`
// matching one of these ids. ANY doc (any kind) can have a template
// attached in mode: 'reference' — admin uploads a blank PDF (e.g. a Hep A
// vaccine form, employee handbook page) and the hire sees a View / Download
// link to reference before they upload their own filled-out copy.
export const ONBOARDING_DOCS = [
    {
        // Offer letter — the very first thing a hire sees. Auto-generated
        // from the company template + the hire's record (name, position,
        // location → legal entity, hire date, offer amount). The hire reads
        // and signs in-app; we render a PDF on submit and upload as their
        // signed copy. No deadline (they typically sign immediately).
        id: 'offer_letter',
        en: 'Offer letter',
        es: 'Carta de oferta',
        emoji: '📄',
        kind: 'offer_letter',
        required: true,
        description: 'Read and sign your offer letter to accept the position.',
    },
    {
        id: 'personal_info',
        en: 'Personal info',
        es: 'Información personal',
        emoji: '👤',
        kind: 'form',
        required: true,
        description: 'Legal name, address, DOB, phone, SSN',
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
        id: 'w4_fed',
        en: 'W-4 (Federal)',
        es: 'W-4 (Federal)',
        emoji: '🧾',
        kind: 'template',
        required: true,
        daysFromHire: 7,
        description: 'IRS Form W-4 — fill and sign in the app.',
    },
    {
        id: 'w4_mo',
        en: 'Missouri W-4',
        es: 'W-4 de Missouri',
        emoji: '🧾',
        kind: 'template',
        required: true,
        daysFromHire: 7,
        description: 'Missouri MO W-4 — fill and sign in the app.',
    },
    {
        id: 'direct_deposit',
        en: 'Direct deposit setup',
        es: 'Depósito directo',
        emoji: '🏦',
        kind: 'direct_deposit',
        required: true,
        daysFromHire: 7,
        description: 'Bank, routing, account, deposit type — signed in the app. Pairs with the voided check.',
    },
    {
        id: 'voided_check',
        en: 'Voided check (or bank letter)',
        es: 'Cheque cancelado (o carta del banco)',
        emoji: '🧾',
        kind: 'file',
        required: true,
        daysFromHire: 7,
        description: 'A photo of a voided check, or a printed bank letter showing routing + account number. Pairs with the direct deposit form.',
    },
    {
        id: 'i9',
        en: 'I-9 work authorization',
        es: 'I-9 autorización de trabajo',
        emoji: '✅',
        kind: 'template',
        required: true,
        daysFromHire: 3,         // federal: I-9 docs within 3 business days of hire
        description: 'Section 1 of Form I-9 — fill and sign in the app. Employer (Section 2) completed after.',
    },
    {
        id: 'id_doc_1',
        en: 'ID document #1',
        es: 'Identificación #1',
        emoji: '🪪',
        kind: 'id',
        required: true,
        daysFromHire: 3,
        description: 'Any acceptable ID — driver\'s license, passport, state ID, etc. Label it when you upload.',
    },
    {
        id: 'id_doc_2',
        en: 'ID document #2',
        es: 'Identificación #2',
        emoji: '🪪',
        kind: 'id',
        required: true,
        daysFromHire: 3,
        description: 'A second ID document (e.g. Social Security card if your first was a license).',
    },
    {
        id: 'hep_a_record',
        en: 'Hepatitis A vaccination record',
        es: 'Registro de vacuna de Hepatitis A',
        emoji: '💉',
        kind: 'file',
        required: true,
        daysFromHire: 30,
        description: 'Photo of your Hep A vaccination card or doctor\'s record. Food-service requirement.',
    },
    {
        id: 'handbook_ack',
        en: 'Employee handbook acknowledgment',
        es: 'Reconocimiento del manual del empleado',
        emoji: '📘',
        kind: 'acknowledgment',
        required: true,
        daysFromHire: 7,
        description: 'Read the DD Mau handbook (harassment policy, dress code, attendance, etc.) and sign that you understand.',
        policyKey: 'handbook',     // which /config/policies/{key} doc to load
    },
    {
        id: 'tip_credit_notice',
        en: 'Wage and tip pool notice',
        es: 'Aviso de salario y fondo común de propinas',
        emoji: '💵',
        kind: 'acknowledgment',
        required: true,
        daysFromHire: 1,           // wage + tip-pool disclosure should be signed on day 1
        description: 'Written notice describing your wage rate and how the 50/50 FOH/BOH tip pool works.',
        // Keep policyKey 'tip_credit' for back-compat with existing
        // /config/policies overrides — the doc id and policy key are
        // separately versioned; the policy content has been rewritten
        // but the storage key is preserved.
        policyKey: 'tip_credit',
    },
    // workers_comp_notice — removed 2026-05-13. Coverage is now handled
    // by the WORKER'S COMPENSATION subsection inside the handbook
    // (signed via handbook_ack) plus the official posted notice
    // required at each restaurant location. If you ever want it back
    // as a standalone signed acknowledgment, the DEFAULT_POLICIES
    // entry was deleted in the same commit — recreate from git history.
    {
        id: 'minor_permit',
        en: 'Minor work permit',
        es: 'Permiso de menor',
        emoji: '🧒',
        kind: 'file',
        required: false,            // auto-required when DOB indicates under 18
        daysFromHire: 7,
        description: 'Required if you are under 18. School-issued work permit.',
        minorOnly: true,
    },
];

// Accepted ID document types — used by the id-kind doc cards as labels.
// Hire picks one from this list when uploading. Admin sees the label in
// the review UI so they know what each photo represents.
export const ID_DOC_TYPES = [
    { id: 'us_passport',     en: 'U.S. Passport',           es: 'Pasaporte EE.UU.' },
    { id: 'drivers_license', en: 'Driver\'s License',       es: 'Licencia de conducir' },
    { id: 'state_id',        en: 'State ID Card',           es: 'Identificación estatal' },
    { id: 'ssn_card',        en: 'Social Security Card',    es: 'Tarjeta de Seguro Social' },
    { id: 'birth_cert',      en: 'Birth Certificate',       es: 'Acta de nacimiento' },
    { id: 'perm_resident',   en: 'Permanent Resident Card', es: 'Tarjeta de Residente Permanente' },
    { id: 'work_permit',     en: 'Work Permit / EAD',       es: 'Permiso de trabajo / EAD' },
    { id: 'foreign_passport',en: 'Foreign Passport',        es: 'Pasaporte extranjero' },
    { id: 'school_id',       en: 'School ID (with photo)',  es: 'ID escolar (con foto)' },
    { id: 'other',           en: 'Other (specify in notes)', es: 'Otro (especificar)' },
];

// Field types supported by the template editor. Coordinates stored as
// fractions of page width/height (0–1) so they survive PDF resolution
// changes. We render markers as absolutely-positioned overlays on a PDF
// page image.
export const TEMPLATE_FIELD_TYPES = [
    { id: 'text',       en: 'Text',       es: 'Texto',       defaultW: 0.20, defaultH: 0.022 },
    { id: 'date',       en: 'Date',       es: 'Fecha',       defaultW: 0.10, defaultH: 0.022 },
    { id: 'checkbox',   en: 'Checkbox',   es: 'Casilla',     defaultW: 0.020, defaultH: 0.020 },
    { id: 'signature',  en: 'Signature',  es: 'Firma',       defaultW: 0.25, defaultH: 0.045 },
    { id: 'initials',   en: 'Initials',   es: 'Iniciales',   defaultW: 0.08, defaultH: 0.030 },
];

// Auto-fill bindings — values that can pre-populate text fields on any
// fillable template. Admin picks a binding when placing the field; fields
// without a binding are blank for the hire to fill.
//
// Two source categories:
//   • From the hire's `personal` payload (legalName, addressLine, etc.) —
//     filled when the hire submits their personal info form.
//   • From the hire RECORD itself (position, location, hireDate,
//     offerAmount) — set by admin when creating the hire. Useful for
//     offer letters and other admin-prepared docs.
export const TEMPLATE_AUTOFILLS = [
    { id: 'legalName',   en: 'Full legal name',    es: 'Nombre legal completo' },
    { id: 'firstName',   en: 'First name only',    es: 'Solo nombre' },
    { id: 'lastName',    en: 'Last name only',     es: 'Solo apellido' },
    { id: 'addressLine', en: 'Street address',     es: 'Dirección' },
    { id: 'city',        en: 'City',               es: 'Ciudad' },
    { id: 'state',       en: 'State',              es: 'Estado' },
    { id: 'zip',         en: 'ZIP',                es: 'Código postal' },
    { id: 'dob',         en: 'Date of birth',      es: 'Fecha de nacimiento' },
    { id: 'phone',       en: 'Phone',              es: 'Teléfono' },
    { id: 'email',       en: 'Email',              es: 'Correo' },
    { id: 'today',       en: 'Today\'s date',      es: 'Fecha de hoy' },
    // From the hire record (admin-set at create time):
    { id: 'position',       en: 'Position / role',          es: 'Puesto' },
    { id: 'location',       en: 'Location',                 es: 'Ubicación' },
    { id: 'hireDate',       en: 'Start date',               es: 'Fecha de inicio' },
    { id: 'offerAmount',    en: 'Offer amount (hourly/salary)', es: 'Monto de oferta' },
    // Resolved from hire.location via LOCATION_INFO:
    { id: 'legalEntity',    en: 'Legal entity (DD Mau LLC / Forsis LLC)', es: 'Entidad legal' },
    { id: 'locationAddress', en: 'Location street address', es: 'Dirección de la ubicación' },
    // SSN binding intentionally absent — we don't store SSN in Firestore.
    // For W-4/I-9 forms, leave SSN fields with no autofill so the hire
    // types it directly. The value ends up only in the resulting PDF.
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

// Compute the doc list for a given hire.
//
// Two filters apply, in order:
//   1. Minor permit is hidden unless the hire is under 18 (DOB or flag).
//   2. If hire.subsetDocs is a non-empty array, return ONLY those doc IDs.
//      This supports "send just Direct Deposit + Voided Check" workflows
//      for existing employees who want to update specific forms — they
//      shouldn't see (or be forced to refill) every onboarding doc.
//      Empty/undefined subsetDocs = the full required-doc list (normal
//      new-hire flow).
export function docsForHire(hire) {
    const isMinor = isHireMinor(hire);
    const subset = Array.isArray(hire?.subsetDocs) && hire.subsetDocs.length > 0
        ? new Set(hire.subsetDocs)
        : null;
    return ONBOARDING_DOCS
        .filter(d => !d.minorOnly || isMinor)
        .filter(d => !subset || subset.has(d.id))
        .map(d => ({
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

// (Removed 2026-05-18, partially revived 2026-05-28) The old
// `onboardingReminderScan` Cloud Function + 📧/↻ admin nudge buttons
// are still gone — admins handle outreach manually. But Andrew asked
// 2026-05-28 to bring the per-doc "Due in N days / Overdue" pill back
// onto the hire portal + admin DocReviewRow, computed from
// `hireDate + daysFromHire`. New helper below = `docDeadlineState`.
// No automated reminders attached — purely a visible cue so the hire
// (and admin) can see at a glance that Hep A is due in 30 days, W-4
// in 7, I-9 docs in 3, etc.

// Per-doc deadline computed from hire start date + the doc's
// jurisdictional `daysFromHire`. Pure function — UI calls it on each
// render. Returns one of:
//
//   { kind: 'none' }                                 — no daysFromHire
//                                                     or no hireDate;
//                                                     don't show a pill.
//   { kind: 'in_days',  days, label, labelEs, tone } — N days remain.
//   { kind: 'due_today', days: 0, ... }              — due TODAY.
//   { kind: 'overdue',  days, label, labelEs, tone } — N days past due.
//
// `tone` is a Tailwind class bundle (bg + text + border) chosen so the
// pill reads at a glance: gray = comfortable runway, amber = within a
// week / due today, red = overdue.
//
// Hide the pill entirely when the doc is already submitted / approved —
// "Due in 5 days" is noise once the file's in. The DocCard / DocReviewRow
// caller does that gate; this helper just computes the math.
export function docDeadlineState(docDef, hireDateISO) {
    if (!docDef || !docDef.daysFromHire) return { kind: 'none' };
    if (!hireDateISO || typeof hireDateISO !== 'string') return { kind: 'none' };
    // hireDate stored as YYYY-MM-DD. Anchor to midnight LOCAL so the
    // diff isn't off by one in non-UTC timezones (DD Mau is Central).
    const parts = hireDateISO.split('-').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return { kind: 'none' };
    const [y, m, d] = parts;
    const hire = new Date(y, m - 1, d);
    if (Number.isNaN(hire.getTime())) return { kind: 'none' };
    const due = new Date(hire);
    due.setDate(due.getDate() + docDef.daysFromHire);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((due.getTime() - today.getTime()) / 86400000);
    if (diffDays < 0) {
        const n = -diffDays;
        return {
            kind: 'overdue',
            days: n,
            label: `Overdue ${n}d`,
            labelEs: `Vencido ${n}d`,
            tone: 'bg-red-50 text-red-700 border-red-300',
        };
    }
    if (diffDays === 0) {
        return {
            kind: 'due_today',
            days: 0,
            label: 'Due today',
            labelEs: 'Vence hoy',
            tone: 'bg-amber-50 text-amber-800 border-amber-300',
        };
    }
    if (diffDays <= 7) {
        return {
            kind: 'in_days',
            days: diffDays,
            label: `Due in ${diffDays}d`,
            labelEs: `Vence en ${diffDays}d`,
            tone: 'bg-amber-50 text-amber-700 border-amber-200',
        };
    }
    return {
        kind: 'in_days',
        days: diffDays,
        label: `Due in ${diffDays}d`,
        labelEs: `Vence en ${diffDays}d`,
        tone: 'bg-gray-50 text-gray-600 border-gray-200',
    };
}

// Resolve the description the hire (or admin) should see for a doc.
// Priority order, highest wins:
//
//   1. Per-hire override stored on the checklist entry —
//      `hire.checklist[docId].descOverride`. Lets admin add a
//      one-off note for a single hire ("you have until Friday").
//   2. Global override stored at /config/onboarding_doc_text →
//      `{ overrides: { [docId]: { en, es } } }`. Edited via the
//      "Doc text" admin tab; visible to ALL hires (existing +
//      future). Use this when the wording change applies to
//      everyone, like adding "30 days from hire date" to the
//      default Hep A description.
//   3. The hardcoded default from ONBOARDING_DOCS above
//      (`docDef.description`). English only — Spanish falls back
//      to English if no global Spanish override is set.
//
// Inputs:
//   docDef               — entry from ONBOARDING_DOCS (or docsForHire)
//   opts.hireChecklistEntry — `hire.checklist[docDef.id]` (or undefined)
//   opts.globalOverrides — the `overrides` map from /config/onboarding_doc_text
//   opts.language        — 'en' | 'es'  (default 'en')
export function effectiveDocDescription(docDef, opts = {}) {
    const lang = opts.language === 'es' ? 'es' : 'en';
    const perHire = opts.hireChecklistEntry?.descOverride;
    if (typeof perHire === 'string' && perHire.trim()) return perHire.trim();
    const override = opts.globalOverrides?.[docDef?.id];
    if (override && typeof override === 'object') {
        if (lang === 'es' && typeof override.es === 'string' && override.es.trim()) {
            return override.es.trim();
        }
        if (typeof override.en === 'string' && override.en.trim()) {
            return override.en.trim();
        }
    }
    return docDef?.description || '';
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
