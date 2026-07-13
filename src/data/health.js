// Health Department & Compliance — data layer (2026-07-12).
//
// One /health_records/{staffId} doc per staff (keyed by staff ID, not
// name — renames can't orphan a medical record). Shape:
//   {
//     staffId: "6",              // string of the staff record's id (immutable)
//     staffName: "Blanca Salgado", // display convenience; refreshed on writes
//     hiredDate: "YYYY-MM-DD",   // manager-editable (staff roster has no hire date)
//     hepA: {
//       shot1Date: "YYYY-MM-DD" | "",
//       shot2Date: "YYYY-MM-DD" | "",
//       exempt: false,           // manager-set (e.g. titer proof / medical exemption)
//       verifiedBy: "" | name,   // manager who confirmed the dates against the card
//       verifiedAt: ISO | "",
//     },
//     docs: { [docKey]: { signedAt: ISO, signedName, docTitle, version } },
//     files: [ { url, path, kind, label, uploadedAt: ISO, uploadedBy,
//                extracted: {...aiExtractHealthDoc result} | null } ],
//     updatedAt: ISO, updatedBy,
//   }
//
// Required documents live in /config/health_docs:
//   { docs: [ { key, title, titleEs, body, bodyEs, version, required } ] }
// Seeded with DEFAULT_HEALTH_DOCS on first manager visit if missing.
import { db } from '../firebase';
import { doc, getDoc, setDoc, runTransaction } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

export const HEALTH_DOCS_CONFIG = ['config', 'health_docs'];

// St. Louis County requires food employees to be vaccinated against
// Hepatitis A (2-dose series) and to acknowledge illness-reporting
// duties. These two defaults cover the county baseline; owners can
// edit/add in Firestore (editor UI is a Phase-2 item).
export const DEFAULT_HEALTH_DOCS = [
    {
        key: 'illness_reporting',
        version: 1,
        required: true,
        title: 'Employee Illness Reporting Agreement',
        titleEs: 'Acuerdo de Reporte de Enfermedades del Empleado',
        body: `As a food employee, I agree to report to my manager BEFORE working if I have any of the following:

• Symptoms: vomiting, diarrhea, jaundice (yellow skin/eyes), sore throat with fever, or an infected cut/burn with pus on my hands or wrists.
• Diagnosis with: Norovirus, Hepatitis A, Shigella, Salmonella (including Typhoid), or E. coli (STEC).
• Exposure: living with or caring for someone diagnosed with any illness above, or an outbreak exposure.

I understand that I must not work with food, clean equipment, utensils, or linens while I have vomiting, diarrhea, or jaundice, and that I may only return to work when allowed by my manager and, where required, the health department.

This agreement follows FDA Food Code Form 1-B and St. Louis County food safety requirements.`,
        bodyEs: `Como empleado de alimentos, acepto informar a mi gerente ANTES de trabajar si tengo cualquiera de lo siguiente:

• Síntomas: vómito, diarrea, ictericia (piel/ojos amarillos), dolor de garganta con fiebre, o una cortada/quemadura infectada con pus en las manos o muñecas.
• Diagnóstico de: Norovirus, Hepatitis A, Shigella, Salmonella (incluida la tifoidea) o E. coli (STEC).
• Exposición: vivir con o cuidar a alguien diagnosticado con alguna de las enfermedades anteriores, o exposición a un brote.

Entiendo que no debo trabajar con alimentos, equipos, utensilios o mantelería mientras tenga vómito, diarrea o ictericia, y que solo puedo regresar a trabajar cuando lo permita mi gerente y, cuando se requiera, el departamento de salud.

Este acuerdo sigue el Formulario 1-B del Código de Alimentos de la FDA y los requisitos de seguridad alimentaria del Condado de St. Louis.`,
    },
    {
        key: 'hygiene_policy',
        version: 1,
        required: true,
        title: 'Food Safety & Personal Hygiene Policy',
        titleEs: 'Política de Seguridad Alimentaria e Higiene Personal',
        body: `I agree to follow DD Mau's food safety and hygiene rules at all times:

• Wash hands with soap for 20 seconds: after restroom use, before food prep, after handling raw meat, after touching my face/phone, after cleaning, and when changing tasks.
• No bare-hand contact with ready-to-eat food — use gloves, tongs, or deli paper.
• Wear clean clothing; hair restrained; no jewelry on hands/arms except a plain band.
• No eating or drinking in food prep areas (closed-lid beverage allowed in designated spots).
• Report any equipment temperatures out of range, pest sightings, or chemical storage issues to a manager immediately.`,
        bodyEs: `Acepto seguir las reglas de seguridad alimentaria e higiene de DD Mau en todo momento:

• Lavarme las manos con jabón por 20 segundos: después de usar el baño, antes de preparar alimentos, después de manejar carne cruda, después de tocarme la cara/teléfono, después de limpiar y al cambiar de tarea.
• No tocar alimentos listos para comer con las manos descubiertas — usar guantes, pinzas o papel.
• Usar ropa limpia; cabello recogido; sin joyas en manos/brazos excepto un anillo liso.
• No comer ni beber en áreas de preparación (bebida con tapa permitida en lugares designados).
• Reportar de inmediato a un gerente temperaturas fuera de rango, avistamientos de plagas o problemas con químicos.`,
    },
];

export function healthRecordRef(staffId) {
    return doc(db, 'health_records', String(staffId));
}

// Merge a partial update into a staff's health record (creates it if
// missing). Transaction so two tablets can't clobber each other; the
// staffId field is pinned (rules enforce immutability on update).
export async function upsertHealthRecord(staffId, staffName, mutate, updatedBy) {
    const ref = healthRecordRef(staffId);
    await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const base = snap.exists() ? (snap.data() || {}) : {
            staffId: String(staffId),
            hepA: { shot1Date: '', shot2Date: '', exempt: false, verifiedBy: '', verifiedAt: '' },
            docs: {},
            files: [],
        };
        const next = mutate({ ...base }) || base;
        next.staffId = String(staffId);          // immutable
        next.staffName = staffName || next.staffName || '';
        next.updatedAt = new Date().toISOString();
        next.updatedBy = updatedBy || '';
        tx.set(ref, next);
    });
}

// Flip whether one signing doc is required (Andrew 2026-07-13: "we have
// only been signing the 1-B so make that the only doc required — make a
// toggle if i need to turn it back on one day"). required:false docs stay
// in the config (and in the mass-import assign dropdown, and any existing
// signatures remain on records) — they just stop counting toward
// compliance, stop appearing on the staff sign list, and stop triggering
// reminders (complianceStatus + the healthComplianceReminders CF already
// filter on `required !== false`).
export async function setHealthDocRequired(key, required, byName) {
    const ref = doc(db, ...HEALTH_DOCS_CONFIG);
    const snap = await getDoc(ref);
    const docs = (snap.exists() ? snap.data()?.docs : null) || DEFAULT_HEALTH_DOCS;
    const next = docs.map(d => d.key === key ? { ...d, required: required !== false } : d);
    await setDoc(ref, {
        docs: next,
        updatedAt: new Date().toISOString(),
        updatedBy: byName || '',
    }, { merge: true });
    return next;
}

// Load the required-docs config, seeding defaults on first use.
export async function loadHealthDocsConfig({ seedIfMissing = false } = {}) {
    const ref = doc(db, ...HEALTH_DOCS_CONFIG);
    const snap = await getDoc(ref);
    const docs = snap.exists() ? (snap.data()?.docs || []) : [];
    if (docs.length > 0) return docs;
    if (seedIfMissing) {
        try { await setDoc(ref, { docs: DEFAULT_HEALTH_DOCS, seededAt: new Date().toISOString() }); } catch { /* another device won the race */ }
    }
    return DEFAULT_HEALTH_DOCS;
}

// ── Compliance status (pure — unit-tested) ──────────────────────────
// Returns { hepA1, hepA2, docsSigned, docsTotal, missing: [...],
//           complete: bool } for one staff record + docs config.
export function complianceStatus(record, docsConfig) {
    const hepA = record?.hepA || {};
    const hepA1 = !!hepA.shot1Date || hepA.exempt === true;
    const hepA2 = !!hepA.shot2Date || hepA.exempt === true;
    const required = (docsConfig || []).filter(d => d && d.required !== false);
    const signedKeys = Object.keys(record?.docs || {}).filter(k => record.docs[k]?.signedAt);
    const docsSigned = required.filter(d => signedKeys.includes(d.key)).length;
    const missing = [];
    if (!hepA1) missing.push('hepA1');
    if (!hepA2) missing.push('hepA2');
    for (const d of required) {
        if (!signedKeys.includes(d.key)) missing.push(`doc:${d.key}`);
    }
    return {
        hepA1, hepA2,
        docsSigned,
        docsTotal: required.length,
        missing,
        complete: missing.length === 0,
    };
}

// Hep A dose-2 due date: CDC schedule is ≥6 months after dose 1.
// Returns 'YYYY-MM-DD' when a dose-2 deadline exists, else ''.
export function hepA2DueDateStr(record) {
    const s1 = record?.hepA?.shot1Date;
    if (!s1 || record?.hepA?.shot2Date || record?.hepA?.exempt) return '';
    const due = new Date(s1 + 'T00:00:00');
    due.setMonth(due.getMonth() + 6);
    return due.toISOString().slice(0, 10);
}

// Flags records where dose 2 is DUE (>6 months since dose 1, no dose 2).
export function hepA2Due(record, todayStr) {
    const due = hepA2DueDateStr(record);
    if (!due) return false;
    const today = todayStr || new Date().toISOString().slice(0, 10);
    return today >= due;
}

// ── Needs-attention queue (pure — unit-tested) ──────────────────────
// One flat, severity-sorted list across ALL staff of what to chase:
//   0 = Hep A shot 2 OVERDUE   1 = shot 1 missing (no record at all)
//   2 = shot 2 upcoming (dated) 3 = required doc unsigned
// rows: [{ person: {id,name}, rec, status }] (as built by the page).
export function buildAttentionQueue(rows, todayStr) {
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const items = [];
    for (const { person, rec, status } of rows || []) {
        if (!person || status?.complete) continue;
        for (const m of status.missing) {
            if (m === 'hepA1') {
                items.push({ id: person.id, name: person.name, kind: 'hepA1', severity: 1 });
            } else if (m === 'hepA2') {
                const due = hepA2DueDateStr(rec);
                if (!due) continue; // no shot 1 yet — the hepA1 item covers it
                items.push({ id: person.id, name: person.name, kind: 'hepA2', dueDate: due, overdue: today >= due, severity: today >= due ? 0 : 2 });
            } else if (m.startsWith('doc:')) {
                items.push({ id: person.id, name: person.name, kind: 'doc', docKey: m.slice(4), severity: 3 });
            }
        }
    }
    return items.sort((a, b) => a.severity - b.severity || String(a.name).localeCompare(String(b.name)));
}

// Hep A exemption/declination waiver — the e-signed alternative to the
// two-dose record (medical or religious). Signing it sets hepA.exempt
// with a full audit payload instead of a bare manager checkbox.
export const EXEMPTION_WAIVER = {
    version: 1,
    title: 'Hepatitis A Vaccination Exemption / Declination',
    titleEs: 'Exención / Rechazo de la Vacuna contra la Hepatitis A',
    body: `I am requesting an exemption from the Hepatitis A vaccination requirement for one of the following reasons: a medical condition documented by a licensed physician (including existing immunity shown by a titer/blood test), or a sincerely held religious belief.

I understand that:
• Hepatitis A is a serious, vaccine-preventable liver infection that food employees can transmit through food.
• By declining vaccination I accept heightened responsibility for illness reporting — I will report ANY gastrointestinal symptoms or jaundice to my manager BEFORE working.
• If a Hepatitis A exposure or outbreak occurs, I may be excluded from food handling per the health department until cleared.
• I may revoke this declination and complete the vaccination series at any time.
• Supporting documentation (physician note or titer result) should be uploaded to my health record where applicable.`,
    bodyEs: `Solicito una exención del requisito de vacunación contra la Hepatitis A por una de las siguientes razones: una condición médica documentada por un médico licenciado (incluida inmunidad existente demostrada por un examen de títulos/sangre), o una creencia religiosa sincera.

Entiendo que:
• La Hepatitis A es una infección hepática grave y prevenible por vacuna que los empleados de alimentos pueden transmitir a través de la comida.
• Al rechazar la vacunación acepto una mayor responsabilidad de reportar enfermedades — reportaré CUALQUIER síntoma gastrointestinal o ictericia a mi gerente ANTES de trabajar.
• Si ocurre una exposición o brote de Hepatitis A, puedo ser excluido del manejo de alimentos según el departamento de salud hasta ser autorizado.
• Puedo revocar este rechazo y completar la serie de vacunación en cualquier momento.
• La documentación de respaldo (nota médica o resultado de títulos) debe subirse a mi registro de salud cuando aplique.`,
};

// ── AI extraction (aiExtractHealthDoc Cloud Function) ───────────────
let _callable = null;
export async function extractHealthDoc(imageUrls) {
    if (!_callable) {
        // 120s to match the function's own ceiling + server-side Anthropic
        // retries — the old 60s cut off reads while the CF was still
        // (successfully) retrying a slow/overloaded Anthropic call, which
        // surfaced as "read timed out" on every row during a big import.
        _callable = httpsCallable(getFunctions(undefined, 'us-central1'), 'aiExtractHealthDoc', { timeout: 120_000 });
    }
    // A big mass import fires these back-to-back; if it trips the server
    // rate limit, wait and retry ONCE rather than surfacing "AI read
    // failed" — the window drains fast and the retry usually lands.
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await _callable({ imageUrls });
            return res?.data || { docType: 'unreadable' };
        } catch (e) {
            const rateLimited = e?.code === 'functions/resource-exhausted'
                || /resource.exhausted|rate.?limit/i.test(e?.message || '');
            if (rateLimited && attempt === 0) {
                await new Promise((r) => setTimeout(r, 6000));
                continue;
            }
            throw e;
        }
    }
    return { docType: 'unreadable' };
}
