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

// Hep A dose-2 window: CDC schedule is ≥6 months after dose 1. Flags
// records where dose 2 is DUE (>6 months since dose 1, no dose 2).
export function hepA2Due(record, todayStr) {
    const s1 = record?.hepA?.shot1Date;
    if (!s1 || record?.hepA?.shot2Date || record?.hepA?.exempt) return false;
    const today = todayStr || new Date().toISOString().slice(0, 10);
    const due = new Date(s1 + 'T00:00:00');
    due.setMonth(due.getMonth() + 6);
    return today >= due.toISOString().slice(0, 10);
}

// ── AI extraction (aiExtractHealthDoc Cloud Function) ───────────────
let _callable = null;
export async function extractHealthDoc(imageUrls) {
    if (!_callable) {
        _callable = httpsCallable(getFunctions(undefined, 'us-central1'), 'aiExtractHealthDoc', { timeout: 60_000 });
    }
    const res = await _callable({ imageUrls });
    return res?.data || { docType: 'unreadable' };
}
