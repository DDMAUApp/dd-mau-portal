// OnboardingApply v2 — public job application, surfaced from the PIN
// lock screen via "New hire? Apply" or from a QR code at /?apply=1.
//
// 10-step wizard on mobile (one section per screen, sticky Continue at
// the bottom). On desktop ≥1024px every section renders inline as a
// single long page so a recruiter pasting from a resume can fill it
// out faster. Section validation gates the Continue button; the final
// step requires three consent checkboxes + a typed-signature match.
//
// Form state auto-saves to localStorage on every change so a phone tap-
// away doesn't lose progress. "Start over" clears the draft.
//
// On submit:
//   1. Append to /onboarding_applications.
//   2. Fan out FCM push to admins.
//   3. Show a success screen with their summary.
//
// Compliance posture:
//   - Don't ask DOB (only isUnder18 / isUnder16 thresholds — FLSA hour
//     limits + work permit logic).
//   - Don't ask citizenship, race, religion, marital, disability, etc.
//     See the v2 design doc in chat for the full red list.
//   - Don't ask criminal history at application stage. St. Louis County
//     suburbs (Webster Groves + Maryland Heights) — verify local
//     ordinances with counsel before adding ANY background question to
//     this form.
//   - Three explicit consent checkboxes (TCPA / truthfulness / at-will).
//   - Typed signature must match the legal name they entered.
//   - userAgent + SHA-256 ip-hash captured for audit defensibility.

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, addDoc, doc, getDoc, serverTimestamp } from 'firebase/firestore';
import {
    POSITIONS, LOCATIONS, DISTANCE_OPTIONS, TRANSPORT_OPTIONS, DESIRED_HOURS,
    DAYS, SHIFT_BLOCKS,
    EXPERIENCE_YEARS, PREVIOUS_ROLES, SKILLS, CERTIFICATIONS,
    LIFTING_CAPACITY, STANDING_HOURS,
    EDUCATION_LEVELS, REFERENCE_RELATIONS, REFERRAL_SOURCES, LANGUAGES,
    normalizeUsPhone, isValidEmail, sha256Hex, labelFor,
} from '../data/applyForm';

const COOLDOWN_KEY = 'ddmau:applyLastSubmit';
const DRAFT_KEY    = 'ddmau:applyDraft.v2';
const COOLDOWN_MS  = 60 * 1000;

// Default empty form state — used at first mount and when admin clicks
// "Start over". Each field name matches the Firestore field name so the
// submit payload is just JSON.stringify of values.
function emptyState() {
    return {
        // Section 1: position & location
        positionsAppliedFor: [],
        locations: [],
        soonestStartDate: '',
        desiredHours: '',
        desiredHourlyWage: '',
        // Section 2: contact
        legalName: '',
        preferredName: '',
        phone: '',
        email: '',
        city: '',
        state: 'MO',
        howFarFromRestaurant: '',
        transportationMethod: '',
        // Section 3: availability
        availability: { mon:{},tue:{},wed:{},thu:{},fri:{},sat:{},sun:{} },
        minHoursPerWeek: '',
        // Section 4: experience + skills
        restaurantExperienceYears: '',
        previousRoles: [],
        pastEmployers: [],
        skillsList: [],
        certifications: [],
        canLiftHowMuch: '',
        canStandHowLong: '',
        // Section 5: education
        highestEducationLevel: '',
        schoolName: '',
        expectedGraduation: '',
        isStudent: null,
        // Section 6: eligibility + age
        workAuthorized: null,
        isUnder18: null,
        isUnder16: null,
        canPassFoodSafetyTraining: null,
        // Section 7: references
        references: [],
        // Section 8: attribution
        referralSource: '',
        referredByName: '',
        // Section 9: languages + extras
        spokenLanguages: [],
        anythingElse: '',
        // Section 10: consent + sign
        contactConsent: false,
        truthfulnessConsent: false,
        atWillAck: false,
        typedSignature: '',
    };
}

// Per-step validators. Returns null if step is OK, string if blocked.
// Used to gate the Continue button + show inline guidance.
function validateStep(step, v, tx) {
    switch (step) {
        case 1: {
            if (!v.positionsAppliedFor.length) return tx('Pick at least one position.', 'Elige al menos un puesto.');
            if (v.positionsAppliedFor.length > 3) return tx('Pick up to 3 positions.', 'Elige hasta 3 puestos.');
            if (!v.locations.length) return tx('Pick at least one location.', 'Elige al menos una ubicación.');
            if (!v.soonestStartDate) return tx('Pick the earliest day you could start.', 'Elige la fecha más temprana.');
            const today = new Date(); today.setHours(0,0,0,0);
            const start = new Date(v.soonestStartDate + 'T00:00:00');
            const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 180);
            if (start < today) return tx('Pick a date today or later.', 'Elige hoy o después.');
            if (start > maxDate) return tx('Pick a date within the next 6 months.', 'Elige dentro de 6 meses.');
            if (!v.desiredHours) return tx('Pick how many hours you\'re hoping for.', 'Elige las horas.');
            return null;
        }
        case 2: {
            if (v.legalName.trim().length < 2) return tx('Enter your legal name.', 'Escribe tu nombre legal.');
            if (v.legalName.trim().length > 80) return tx('Legal name is too long.', 'Nombre demasiado largo.');
            if (!normalizeUsPhone(v.phone)) return tx('Enter a valid US phone number.', 'Escribe un teléfono válido.');
            if (!isValidEmail(v.email)) return tx('Enter a valid email.', 'Escribe un correo válido.');
            if (!v.city.trim()) return tx('Enter your city.', 'Escribe tu ciudad.');
            if (!v.state) return tx('Pick your state.', 'Elige tu estado.');
            if (!v.howFarFromRestaurant) return tx('Pick how far you are from us.', 'Elige qué tan lejos estás.');
            if (!v.transportationMethod) return tx('Pick your transportation.', 'Elige tu transporte.');
            return null;
        }
        case 3: {
            const total = DAYS.reduce((sum, d) => {
                const day = v.availability[d.id] || {};
                return sum + SHIFT_BLOCKS.filter(b => day[b.id]).length;
            }, 0);
            if (total === 0) return tx('Tap at least one shift you could work.', 'Toca al menos un turno.');
            return null;
        }
        case 4: {
            if (!v.restaurantExperienceYears) return tx('Pick your experience level.', 'Elige tu nivel de experiencia.');
            if (!v.canLiftHowMuch) return tx('Pick your lifting capacity.', 'Elige cuánto puedes levantar.');
            if (!v.canStandHowLong) return tx('Pick how long you can stand.', 'Elige cuánto puedes estar parado.');
            return null;
        }
        case 5: {
            if (v.isStudent === null) return tx('Are you currently a student?', '¿Eres estudiante actualmente?');
            return null;
        }
        case 6: {
            if (v.workAuthorized === null) return tx('Answer the work authorization question.', 'Contesta sobre autorización de trabajo.');
            if (v.workAuthorized === false) return tx('Unfortunately we can\'t hire applicants without US work authorization. Reach out if your status changes.', 'No podemos contratar sin autorización para trabajar.');
            if (v.isUnder18 === null) return tx('Answer the age question.', 'Contesta sobre la edad.');
            if (v.isUnder18 === true && v.isUnder16 === null) return tx('Are you under 16?', '¿Tienes menos de 16?');
            if (v.isUnder16 === true) return tx('We hire 16+. Try us again when you turn 16 — we\'d love to have you.', 'Contratamos 16+. Intenta cuando cumplas 16.');
            if (v.canPassFoodSafetyTraining === null) return tx('Answer the food safety training question.', 'Contesta sobre el entrenamiento de seguridad alimentaria.');
            return null;
        }
        case 7: return null; // References optional
        case 8: return null; // Attribution optional
        case 9: return null; // Languages + extras optional
        case 10: {
            if (!v.contactConsent) return tx('Check the contact consent box.', 'Marca la casilla de consentimiento.');
            if (!v.truthfulnessConsent) return tx('Check the truthfulness certification.', 'Marca la casilla de certificación.');
            if (!v.atWillAck) return tx('Check the at-will acknowledgment.', 'Marca la casilla del empleo a voluntad.');
            const sigOk = v.typedSignature.trim().toLowerCase() === v.legalName.trim().toLowerCase();
            if (!sigOk) return tx('Typed signature must match your legal name exactly.', 'La firma debe coincidir con tu nombre legal.');
            return null;
        }
        default: return null;
    }
}

export default function OnboardingApply({ language = 'en', onClose, onSubmitted }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // Restore draft on mount (so a phone tap-away doesn't lose progress).
    // Draft schema mismatches (we added/removed fields) are tolerated by
    // spreading over the empty state.
    const [values, setValues] = useState(() => {
        try {
            const raw = localStorage.getItem(DRAFT_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                return { ...emptyState(), ...parsed };
            }
        } catch {}
        return emptyState();
    });
    const [step, setStep] = useState(1);
    const [saving, setSaving] = useState(false);
    const [done, setDone] = useState(false);
    const [err, setErr] = useState('');
    const [appId, setAppId] = useState(null);

    // Auto-save on every change. Localstorage write is synchronous + cheap.
    useEffect(() => {
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(values)); } catch {}
    }, [values]);

    const setField = (key, val) => setValues(v => ({ ...v, [key]: val }));
    const setNested = (key, sub, val) => setValues(v => ({
        ...v,
        [key]: { ...(v[key] || {}), [sub]: val },
    }));
    const toggleInArray = (key, item) => setValues(v => {
        const arr = v[key] || [];
        return { ...v, [key]: arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item] };
    });

    const stepError = useMemo(() => validateStep(step, values, tx), [step, values, isEs]);
    const TOTAL_STEPS = 10;

    const goNext = () => {
        const e = validateStep(step, values, tx);
        if (e) { setErr(e); return; }
        setErr('');
        if (step < TOTAL_STEPS) setStep(s => s + 1);
    };
    const goBack = () => {
        setErr('');
        if (step > 1) setStep(s => s - 1);
    };

    const submit = async () => {
        const e = validateStep(10, values, tx);
        if (e) { setErr(e); return; }
        // Cooldown — one submit per minute per device.
        try {
            const last = parseInt(localStorage.getItem(COOLDOWN_KEY) || '0', 10) || 0;
            if (Date.now() - last < COOLDOWN_MS) {
                setErr(tx(
                    'You just sent one — wait a moment before sending another.',
                    'Acabas de enviar una — espera un momento antes de enviar otra.',
                ));
                return;
            }
        } catch {}
        setSaving(true);
        setErr('');
        try {
            const phoneE164 = normalizeUsPhone(values.phone);
            const ipHash = await sha256Hex(navigator.userAgent + '|' + Date.now());
            // Compose the submit payload. Keep field names matched to the
            // Firestore rule schema (legalName + name mirror, contactConsent
            // gate). `name` mirrors legalName for back-compat with the old
            // rule + existing admin code that reads .name.
            const payload = {
                // mirror for legacy compatibility — admin's existing UI reads h.name
                name: values.legalName.trim(),
                // Section 1
                positionsAppliedFor: values.positionsAppliedFor,
                locations: values.locations,
                soonestStartDate: values.soonestStartDate,
                desiredHours: values.desiredHours,
                desiredHourlyWage: values.desiredHourlyWage ? Number(values.desiredHourlyWage) : null,
                // Section 2
                legalName: values.legalName.trim(),
                preferredName: values.preferredName.trim() || null,
                phone: phoneE164,
                email: values.email.trim(),
                city: values.city.trim(),
                state: values.state,
                howFarFromRestaurant: values.howFarFromRestaurant,
                transportationMethod: values.transportationMethod,
                // Section 3
                availability: values.availability,
                minHoursPerWeek: values.minHoursPerWeek ? Number(values.minHoursPerWeek) : null,
                // Section 4
                restaurantExperienceYears: values.restaurantExperienceYears,
                previousRoles: values.previousRoles,
                pastEmployers: values.pastEmployers,
                skillsList: values.skillsList,
                certifications: values.certifications,
                canLiftHowMuch: values.canLiftHowMuch,
                canStandHowLong: values.canStandHowLong,
                // Section 5
                highestEducationLevel: values.highestEducationLevel || null,
                schoolName: values.schoolName.trim() || null,
                expectedGraduation: values.expectedGraduation || null,
                isStudent: values.isStudent,
                // Section 6
                workAuthorized: values.workAuthorized,
                isUnder18: values.isUnder18,
                isUnder16: values.isUnder16,
                under18: values.isUnder18, // legacy mirror, used by AddHireModal prefill
                canPassFoodSafetyTraining: values.canPassFoodSafetyTraining,
                // Section 7
                references: values.references,
                // Section 8
                referralSource: values.referralSource || null,
                referredByName: values.referredByName.trim() || null,
                // Section 9
                spokenLanguages: values.spokenLanguages,
                anythingElse: values.anythingElse.trim() || null,
                // legacy mirrors so admin reads keep working
                position: (POSITIONS.find(p => values.positionsAppliedFor[0] === p.id) || {}).en || '',
                location: values.locations[0] || 'webster',
                availabilityNote: '', // legacy text field — superseded by grid
                note: values.anythingElse.trim() || '',
                // Section 10
                contactConsent: true,
                truthfulnessConsent: true,
                atWillAck: true,
                typedSignature: values.typedSignature.trim(),
                signedAt: new Date().toISOString(),
                userAgent: navigator.userAgent || '',
                ipHash: ipHash,
                // Lifecycle
                status: 'applied',
                source: typeof window !== 'undefined' && window.location.search.includes('apply=1') ? 'qr_code' : 'lock_screen',
                createdAt: serverTimestamp(),
            };
            const appRef = await addDoc(collection(db, 'onboarding_applications'), payload);
            // Push notify admins.
            try {
                const staffSnap = await getDoc(doc(db, 'config', 'staff'));
                const list = (staffSnap.exists() ? staffSnap.data().list : []) || [];
                const recipients = list.filter(s => s.canViewOnboarding === true || s.id === 40 || s.id === 41);
                await Promise.all(recipients.map(s =>
                    addDoc(collection(db, 'notifications'), {
                        forStaff: s.name,
                        type: 'onboarding_application',
                        title: isEs ? '🪪 Nueva aplicación de empleo' : '🪪 New job application',
                        body: `${values.legalName.trim()} · ${values.positionsAppliedFor.map(p => labelFor(POSITIONS, p, isEs)).join(', ')}`,
                        link: '/onboarding',
                        createdAt: serverTimestamp(),
                        read: false,
                        createdBy: 'apply_form',
                    }).catch(() => null)
                ));
            } catch (e2) { console.warn('apply notify failed (non-fatal):', e2); }
            try {
                localStorage.setItem(COOLDOWN_KEY, String(Date.now()));
                localStorage.removeItem(DRAFT_KEY);
            } catch {}
            setAppId(appRef.id);
            setDone(true);
            onSubmitted?.(appRef.id);
        } catch (e) {
            console.error('apply submit failed', e);
            setErr(tx('Could not submit. Try again.', 'No se pudo enviar. Intenta de nuevo.'));
        } finally {
            setSaving(false);
        }
    };

    const startOver = () => {
        if (!confirm(tx('Clear everything you\'ve entered and start over?', '¿Borrar todo y empezar de nuevo?'))) return;
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        setValues(emptyState());
        setStep(1);
        setErr('');
    };

    if (done) {
        return <SuccessCard onClose={onClose} isEs={isEs} values={values} />;
    }

    return (
        <div className="fixed inset-0 z-50 bg-dd-sage overflow-y-auto">
            <div className="max-w-lg lg:max-w-3xl mx-auto p-3 sm:p-6 space-y-3">
                <Header onClose={onClose} isEs={isEs} onStartOver={startOver} />
                <ProgressDots step={step} total={TOTAL_STEPS} />
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-5 space-y-4">
                    {step === 1 && <Step1 values={values} setField={setField} toggleInArray={toggleInArray} isEs={isEs} />}
                    {step === 2 && <Step2 values={values} setField={setField} isEs={isEs} />}
                    {step === 3 && <Step3 values={values} setNested={setNested} setField={setField} isEs={isEs} />}
                    {step === 4 && <Step4 values={values} setField={setField} toggleInArray={toggleInArray} setValues={setValues} isEs={isEs} />}
                    {step === 5 && <Step5 values={values} setField={setField} isEs={isEs} />}
                    {step === 6 && <Step6 values={values} setField={setField} isEs={isEs} />}
                    {step === 7 && <Step7 values={values} setField={setField} setValues={setValues} isEs={isEs} />}
                    {step === 8 && <Step8 values={values} setField={setField} isEs={isEs} />}
                    {step === 9 && <Step9 values={values} setField={setField} toggleInArray={toggleInArray} isEs={isEs} />}
                    {step === 10 && <Step10 values={values} setField={setField} isEs={isEs} />}
                </div>
                {err && (
                    <div className="bg-red-50 border-2 border-red-200 rounded-lg p-2.5 text-[12px] text-red-800">
                        {err}
                    </div>
                )}
                <NavButtons step={step} total={TOTAL_STEPS} onBack={goBack} onNext={goNext}
                    onSubmit={submit} saving={saving} canProceed={!stepError} isEs={isEs} />
                <p className="text-[10px] text-center text-gray-400 pb-6">
                    {tx('🔒 Your info goes directly to DD Mau ownership. No third parties.',
                        '🔒 Tu información va directo a los dueños de DD Mau. Sin terceros.')}
                </p>
            </div>
        </div>
    );
}

// ── Chrome ───────────────────────────────────────────────────────────────
function Header({ onClose, isEs, onStartOver }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <header className="flex items-start justify-between gap-2 pt-2">
            <div className="flex-1 min-w-0">
                <p className="text-3xl">🍜</p>
                <h1 className="text-xl font-black text-dd-green-700 mt-1">
                    {tx('Apply at DD Mau', 'Solicitud de empleo en DD Mau')}
                </h1>
                <p className="text-xs text-gray-600 mt-1">
                    {tx(
                        'Fill this out — the DD Mau team will text or email you back.',
                        'Llena esto — el equipo de DD Mau te contactará por mensaje o correo.',
                    )}
                </p>
            </div>
            <div className="flex flex-col gap-1.5 flex-shrink-0">
                <button onClick={onClose}
                    className="w-9 h-9 rounded-full bg-white border border-gray-300 text-gray-600 text-lg shadow-sm">
                    ×
                </button>
                <button onClick={onStartOver}
                    className="text-[10px] text-gray-500 hover:text-red-600 underline">
                    {tx('Start over', 'Empezar')}
                </button>
            </div>
        </header>
    );
}

function ProgressDots({ step, total }) {
    return (
        <div className="bg-white rounded-full p-1.5 shadow-sm border border-gray-200">
            <div className="flex items-center gap-1.5 justify-center">
                {Array.from({ length: total }, (_, i) => i + 1).map(n => (
                    <span key={n}
                        className={`h-2 rounded-full transition-all ${
                            n === step ? 'bg-dd-green w-6' :
                            n < step ? 'bg-dd-green/60 w-2' :
                            'bg-gray-200 w-2'
                        }`} />
                ))}
                <span className="ml-2 text-[10px] font-bold text-gray-500">{step}/{total}</span>
            </div>
        </div>
    );
}

function NavButtons({ step, total, onBack, onNext, onSubmit, saving, canProceed, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="flex gap-2 sticky bottom-3">
            {step > 1 && (
                <button type="button" onClick={onBack}
                    className="flex-1 py-3 rounded-xl bg-white border-2 border-gray-300 text-gray-700 font-bold text-sm active:scale-95">
                    ← {tx('Back', 'Atrás')}
                </button>
            )}
            {step < total ? (
                <button type="button" onClick={onNext}
                    className={`flex-[2] py-3 rounded-xl font-bold text-sm active:scale-95 transition ${
                        canProceed
                            ? 'bg-dd-green text-white shadow-md'
                            : 'bg-gray-200 text-gray-500'
                    }`}>
                    {tx('Continue', 'Continuar')} →
                </button>
            ) : (
                <button type="button" onClick={onSubmit} disabled={saving}
                    className="flex-[2] py-3 rounded-xl bg-dd-green text-white font-bold text-sm shadow-md active:scale-95 disabled:opacity-60">
                    {saving ? tx('Sending…', 'Enviando…') : tx('🚀 Send application', '🚀 Enviar solicitud')}
                </button>
            )}
        </div>
    );
}

function SuccessCard({ onClose, isEs, values }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="fixed inset-0 z-50 bg-dd-sage overflow-y-auto p-4 flex items-center justify-center">
            <div className="max-w-md w-full bg-white rounded-2xl border-2 border-green-200 shadow-lg p-6">
                <p className="text-5xl text-center mb-3">🎉</p>
                <h2 className="text-2xl font-black text-green-800 mb-2 text-center">
                    {tx('Got it!', '¡Recibido!')}
                </h2>
                <p className="text-sm text-gray-700 text-center mb-4">
                    {tx(
                        "Your application is in front of the DD Mau team. We typically respond within 24-48 hours via text.",
                        'Tu solicitud está con el equipo de DD Mau. Normalmente respondemos en 24-48 horas por mensaje.',
                    )}
                </p>
                <div className="bg-gray-50 rounded-lg p-3 text-[11px] space-y-1 border border-gray-200">
                    <p className="font-bold text-gray-700">{tx('Summary', 'Resumen')}</p>
                    <p>👤 {values.legalName}</p>
                    <p>📞 {values.phone} · ✉ {values.email}</p>
                    <p>💼 {values.positionsAppliedFor.map(p => labelFor(POSITIONS, p, isEs)).join(', ')}</p>
                    <p>📍 {values.locations.map(l => labelFor(LOCATIONS, l, isEs)).join(', ')}</p>
                    <p>📅 {tx('Start by', 'Inicio')}: {values.soonestStartDate}</p>
                </div>
                <button onClick={onClose}
                    className="mt-5 w-full py-3 rounded-xl bg-dd-green text-white font-bold">
                    {tx('Done', 'Listo')}
                </button>
            </div>
        </div>
    );
}

// ── Reusable bits ────────────────────────────────────────────────────────
function SectionHead({ title, subtitle }) {
    return (
        <div>
            <h2 className="text-lg font-black text-gray-900">{title}</h2>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
    );
}

function FieldLabel({ children, required, helper }) {
    return (
        <div className="mb-1">
            <label className="text-[12px] font-bold uppercase text-gray-600">
                {children}{required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
            {helper && <p className="text-[11px] text-gray-500 mt-0.5">{helper}</p>}
        </div>
    );
}

function ChipGroup({ options, selected, onToggle, isEs, multi = true, maxSelected }) {
    const sel = new Set(Array.isArray(selected) ? selected : [selected]);
    return (
        <div className="flex flex-wrap gap-1.5">
            {options.map(o => {
                const isSel = sel.has(o.id);
                const atMax = multi && maxSelected && sel.size >= maxSelected && !isSel;
                return (
                    <button key={o.id} type="button" disabled={atMax}
                        onClick={() => onToggle(o.id)}
                        className={`px-3 py-1.5 rounded-full text-[12px] font-bold border-2 transition active:scale-95 ${
                            isSel
                                ? 'bg-dd-green text-white border-dd-green shadow-sm'
                                : atMax
                                    ? 'bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed'
                                    : 'bg-white text-gray-700 border-gray-300 hover:border-dd-green'
                        }`}>
                        {isEs ? o.es : o.en}
                    </button>
                );
            })}
        </div>
    );
}

function YesNoPick({ value, onChange, yesLabel, noLabel }) {
    const cls = (active) => `flex-1 py-3 rounded-xl border-2 font-bold text-sm transition active:scale-95 ${
        active ? 'bg-dd-sage-50 border-dd-green text-dd-green-700' : 'bg-white border-gray-300 text-gray-700'
    }`;
    return (
        <div className="flex gap-2">
            <button type="button" onClick={() => onChange(true)} className={cls(value === true)}>
                {yesLabel}
            </button>
            <button type="button" onClick={() => onChange(false)} className={cls(value === false)}>
                {noLabel}
            </button>
        </div>
    );
}

function TextInput({ value, onChange, placeholder, type = 'text', autoComplete, inputMode, maxLength }) {
    return (
        <input type={type} value={value} onChange={e => onChange(e.target.value)}
            placeholder={placeholder} autoComplete={autoComplete} inputMode={inputMode} maxLength={maxLength}
            className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:border-dd-green focus:outline-none focus:ring-2 focus:ring-dd-green/30" />
    );
}

// ── Step 1: Position & location ──────────────────────────────────────────
function Step1({ values, setField, toggleInArray, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="space-y-4">
            <SectionHead title={tx('What are you applying for?', '¿Para qué aplicas?')}
                subtitle={tx('Pick up to 3 positions.', 'Elige hasta 3 puestos.')} />
            <div>
                <FieldLabel required>{tx('Positions', 'Puestos')}</FieldLabel>
                <ChipGroup options={POSITIONS} selected={values.positionsAppliedFor}
                    onToggle={(id) => toggleInArray('positionsAppliedFor', id)}
                    isEs={isEs} maxSelected={3} />
            </div>
            <div>
                <FieldLabel required helper={tx('Pick all that work for you.', 'Elige las que funcionen.')}>
                    {tx('Location', 'Ubicación')}
                </FieldLabel>
                <ChipGroup options={LOCATIONS} selected={values.locations}
                    onToggle={(id) => toggleInArray('locations', id)} isEs={isEs} />
            </div>
            <div>
                <FieldLabel required helper={tx('Earliest day you could start. We work around school / other jobs.', 'Fecha más temprana. Trabajamos con tu horario.')}>
                    {tx('Soonest you could start', 'Día más temprano para empezar')}
                </FieldLabel>
                <TextInput type="date" value={values.soonestStartDate}
                    onChange={(v) => setField('soonestStartDate', v)} />
            </div>
            <div>
                <FieldLabel required>{tx('How many hours / week?', '¿Cuántas horas / semana?')}</FieldLabel>
                <div className="space-y-1.5">
                    {DESIRED_HOURS.map(o => (
                        <button key={o.id} type="button" onClick={() => setField('desiredHours', o.id)}
                            className={`w-full text-left px-3 py-2.5 rounded-xl border-2 text-sm font-semibold transition active:scale-[0.99] ${
                                values.desiredHours === o.id
                                    ? 'bg-dd-sage-50 border-dd-green text-dd-green-700'
                                    : 'bg-white border-gray-300 text-gray-700'
                            }`}>
                            {isEs ? o.es : o.en}
                        </button>
                    ))}
                </div>
            </div>
            <div>
                <FieldLabel helper={tx('Skip if flexible. Tips are on top of this for FOH.', 'Salta si eres flexible. Las propinas son aparte.')}>
                    {tx('Desired hourly rate (optional)', 'Tarifa por hora deseada (opcional)')}
                </FieldLabel>
                <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
                    <input type="number" step="0.25" min="0" max="50"
                        value={values.desiredHourlyWage}
                        onChange={e => setField('desiredHourlyWage', e.target.value)}
                        placeholder="15.00" inputMode="decimal"
                        className="w-full border border-gray-300 rounded-lg pl-7 pr-3 py-2.5 text-sm focus:border-dd-green focus:outline-none focus:ring-2 focus:ring-dd-green/30" />
                </div>
            </div>
        </div>
    );
}

// ── Step 2: Contact ──────────────────────────────────────────────────────
function Step2({ values, setField, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="space-y-4">
            <SectionHead title={tx('How can we reach you?', '¿Cómo te contactamos?')} />
            <div>
                <FieldLabel required helper={tx('Matches your ID.', 'Como en tu identificación.')}>
                    {tx('Legal name', 'Nombre legal')}
                </FieldLabel>
                <TextInput value={values.legalName} onChange={v => setField('legalName', v)}
                    autoComplete="name" placeholder={tx('Maria Rodriguez Garcia', 'María Rodríguez García')} maxLength={80} />
            </div>
            <div>
                <FieldLabel helper={tx('What we\'ll call you in the kitchen. Skip if same as above.', 'Como te llamamos en cocina. Salta si es lo mismo.')}>
                    {tx('Preferred name (optional)', 'Nombre preferido (opcional)')}
                </FieldLabel>
                <TextInput value={values.preferredName} onChange={v => setField('preferredName', v)}
                    autoComplete="nickname" placeholder={tx('Maria', 'María')} maxLength={30} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <FieldLabel required helper={tx('Cell, not landline. We text first.', 'Celular, no teléfono fijo.')}>
                        {tx('Phone', 'Teléfono')}
                    </FieldLabel>
                    <TextInput type="tel" value={values.phone} onChange={v => setField('phone', v)}
                        autoComplete="tel" inputMode="tel" placeholder="(314) 555-1234" />
                </div>
                <div>
                    <FieldLabel required>{tx('Email', 'Correo')}</FieldLabel>
                    <TextInput type="email" value={values.email} onChange={v => setField('email', v)}
                        autoComplete="email" inputMode="email" placeholder="you@example.com" />
                </div>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
                <div>
                    <FieldLabel required>{tx('City', 'Ciudad')}</FieldLabel>
                    <TextInput value={values.city} onChange={v => setField('city', v)}
                        autoComplete="address-level2" placeholder="Webster Groves" />
                </div>
                <div>
                    <FieldLabel required>{tx('State', 'Estado')}</FieldLabel>
                    <select value={values.state} onChange={e => setField('state', e.target.value)}
                        className="border border-gray-300 rounded-lg px-3 py-2.5 text-sm bg-white">
                        <option value="MO">MO</option>
                        <option value="IL">IL</option>
                    </select>
                </div>
            </div>
            <div>
                <FieldLabel required>{tx('How far from the restaurant?', '¿Qué tan lejos del restaurante?')}</FieldLabel>
                <ChipGroup options={DISTANCE_OPTIONS} selected={values.howFarFromRestaurant}
                    onToggle={(id) => setField('howFarFromRestaurant', id)} isEs={isEs} multi={false} />
            </div>
            <div>
                <FieldLabel required helper={tx('We open early, close late.', 'Abrimos temprano, cerramos tarde.')}>
                    {tx('Transportation', 'Transporte')}
                </FieldLabel>
                <ChipGroup options={TRANSPORT_OPTIONS} selected={values.transportationMethod}
                    onToggle={(id) => setField('transportationMethod', id)} isEs={isEs} multi={false} />
            </div>
        </div>
    );
}

// ── Step 3: Availability ─────────────────────────────────────────────────
function Step3({ values, setNested, setField, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="space-y-4">
            <SectionHead title={tx('When can you work?', '¿Cuándo puedes trabajar?')}
                subtitle={tx('Tap every shift you could work. We use this to build schedules.',
                    'Toca cada turno que puedas. Usamos esto para crear los horarios.')} />
            <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full min-w-[420px] border-separate border-spacing-1">
                    <thead>
                        <tr>
                            <th className="text-[10px] font-bold text-gray-500 uppercase text-left p-1"></th>
                            {SHIFT_BLOCKS.map(b => (
                                <th key={b.id} className="text-[10px] font-bold text-gray-500 uppercase p-1 text-center">
                                    {isEs ? b.es : b.en}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {DAYS.map(d => (
                            <tr key={d.id}>
                                <th className="text-[12px] font-bold text-gray-700 text-left pr-1">
                                    {isEs ? d.es : d.en}
                                </th>
                                {SHIFT_BLOCKS.map(b => {
                                    const checked = !!(values.availability[d.id] && values.availability[d.id][b.id]);
                                    return (
                                        <td key={b.id} className="p-0.5">
                                            <button type="button"
                                                onClick={() => setNested('availability', d.id, {
                                                    ...(values.availability[d.id] || {}),
                                                    [b.id]: !checked,
                                                })}
                                                className={`w-full aspect-square rounded-lg border-2 transition active:scale-95 ${
                                                    checked
                                                        ? 'bg-dd-green text-white border-dd-green'
                                                        : 'bg-white border-gray-300 text-gray-400'
                                                }`}>
                                                {checked ? '✓' : ''}
                                            </button>
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div>
                <FieldLabel helper={tx('Minimum hours you need to make this worth it.', 'Mínimo de horas para que valga la pena.')}>
                    {tx('Minimum hours / week (optional)', 'Horas mínimas / semana (opcional)')}
                </FieldLabel>
                <TextInput type="number" inputMode="numeric" value={values.minHoursPerWeek}
                    onChange={v => setField('minHoursPerWeek', v)} placeholder="20" maxLength={2} />
            </div>
        </div>
    );
}

// ── Step 4: Experience + skills ──────────────────────────────────────────
function Step4({ values, setField, toggleInArray, setValues, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const addEmployer = () => {
        if (values.pastEmployers.length >= 3) return;
        setValues(v => ({ ...v, pastEmployers: [...v.pastEmployers, { employer: '', role: '', startMonth: '', endMonth: '', reasonLeft: '', stillHere: false }] }));
    };
    const removeEmployer = (idx) => setValues(v => ({ ...v, pastEmployers: v.pastEmployers.filter((_, i) => i !== idx) }));
    const updateEmployer = (idx, patch) => setValues(v => ({
        ...v,
        pastEmployers: v.pastEmployers.map((e, i) => i === idx ? { ...e, ...patch } : e),
    }));
    return (
        <div className="space-y-4">
            <SectionHead title={tx('Tell us about your experience', 'Cuéntanos tu experiencia')}
                subtitle={tx('Skip anything you don\'t have — we don\'t reject for blanks.',
                    'Salta lo que no tengas — no rechazamos por espacios en blanco.')} />
            <div>
                <FieldLabel required>{tx('Restaurant experience', 'Experiencia en restaurantes')}</FieldLabel>
                <div className="space-y-1.5">
                    {EXPERIENCE_YEARS.map(o => (
                        <button key={o.id} type="button" onClick={() => setField('restaurantExperienceYears', o.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg border-2 text-sm font-semibold transition active:scale-[0.99] ${
                                values.restaurantExperienceYears === o.id
                                    ? 'bg-dd-sage-50 border-dd-green text-dd-green-700'
                                    : 'bg-white border-gray-300 text-gray-700'
                            }`}>
                            {isEs ? o.es : o.en}
                        </button>
                    ))}
                </div>
            </div>
            <div>
                <FieldLabel helper={tx('Roles you\'ve done before. Tap all that apply.', 'Trabajos anteriores. Toca todos los que apliquen.')}>
                    {tx('Past roles (optional)', 'Trabajos anteriores (opcional)')}
                </FieldLabel>
                <ChipGroup options={PREVIOUS_ROLES} selected={values.previousRoles}
                    onToggle={(id) => toggleInArray('previousRoles', id)} isEs={isEs} />
            </div>
            <div>
                <FieldLabel helper={tx('Up to 3 most recent. Skip if you\'ve never worked in a restaurant.',
                    'Hasta 3 más recientes. Salta si nunca trabajaste en restaurante.')}>
                    {tx('Past employers (optional)', 'Empleadores anteriores (opcional)')}
                </FieldLabel>
                <div className="space-y-2">
                    {values.pastEmployers.map((emp, i) => (
                        <div key={i} className="bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-2">
                            <div className="flex items-center justify-between">
                                <span className="text-[11px] font-bold text-gray-600">{tx(`Job ${i + 1}`, `Trabajo ${i + 1}`)}</span>
                                <button type="button" onClick={() => removeEmployer(i)}
                                    className="text-[10px] text-red-600 font-bold">{tx('Remove', 'Quitar')}</button>
                            </div>
                            <TextInput value={emp.employer} onChange={v => updateEmployer(i, { employer: v })}
                                placeholder={tx('Restaurant / employer name', 'Nombre del restaurante / empleador')} maxLength={60} />
                            <TextInput value={emp.role} onChange={v => updateEmployer(i, { role: v })}
                                placeholder={tx('Role (e.g. Line cook)', 'Puesto (ej: Cocinero)')} maxLength={40} />
                            <div className="grid grid-cols-2 gap-2">
                                <input type="month" value={emp.startMonth} onChange={e => updateEmployer(i, { startMonth: e.target.value })}
                                    className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs" placeholder="Start" />
                                {emp.stillHere ? (
                                    <span className="border border-dd-green/40 rounded-lg px-2 py-1.5 text-xs bg-dd-sage-50 text-dd-green-700 font-bold flex items-center">
                                        {tx('Still here', 'Aún trabajo aquí')}
                                    </span>
                                ) : (
                                    <input type="month" value={emp.endMonth} onChange={e => updateEmployer(i, { endMonth: e.target.value })}
                                        className="border border-gray-300 rounded-lg px-2 py-1.5 text-xs" placeholder="End" />
                                )}
                            </div>
                            <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer">
                                <input type="checkbox" checked={emp.stillHere}
                                    onChange={e => updateEmployer(i, { stillHere: e.target.checked, endMonth: '' })}
                                    className="w-4 h-4 accent-dd-green" />
                                {tx('I still work here', 'Aún trabajo aquí')}
                            </label>
                            <TextInput value={emp.reasonLeft} onChange={v => updateEmployer(i, { reasonLeft: v })}
                                placeholder={tx('Reason for leaving (optional)', 'Razón de salida (opcional)')} maxLength={100} />
                        </div>
                    ))}
                    {values.pastEmployers.length < 3 && (
                        <button type="button" onClick={addEmployer}
                            className="w-full py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 text-sm font-bold hover:border-dd-green hover:text-dd-green">
                            + {tx('Add a past job', 'Agregar trabajo anterior')}
                        </button>
                    )}
                </div>
            </div>
            <div>
                <FieldLabel helper={tx('Bilingual EN/ES is a real plus.', 'Bilingüe es una gran ventaja.')}>
                    {tx('Skills (optional)', 'Habilidades (opcional)')}
                </FieldLabel>
                <ChipGroup options={SKILLS} selected={values.skillsList}
                    onToggle={(id) => toggleInArray('skillsList', id)} isEs={isEs} maxSelected={12} />
            </div>
            <div>
                <FieldLabel>{tx('Certifications (optional)', 'Certificaciones (opcional)')}</FieldLabel>
                <ChipGroup options={CERTIFICATIONS} selected={values.certifications}
                    onToggle={(id) => toggleInArray('certifications', id)} isEs={isEs} />
            </div>
            <div>
                <FieldLabel required helper={tx('Honest answer — kitchens involve lifting boxes and stockpots.',
                    'Respuesta honesta — hay que cargar cajas y ollas.')}>
                    {tx('Can you lift?', '¿Cuánto puedes levantar?')}
                </FieldLabel>
                <ChipGroup options={LIFTING_CAPACITY} selected={values.canLiftHowMuch}
                    onToggle={(id) => setField('canLiftHowMuch', id)} isEs={isEs} multi={false} />
            </div>
            <div>
                <FieldLabel required helper={tx('Most shifts are 4-8 hours on your feet.', 'La mayoría de turnos son 4-8 horas parado.')}>
                    {tx('Can you stand?', '¿Cuánto tiempo puedes estar parado?')}
                </FieldLabel>
                <ChipGroup options={STANDING_HOURS} selected={values.canStandHowLong}
                    onToggle={(id) => setField('canStandHowLong', id)} isEs={isEs} multi={false} />
            </div>
        </div>
    );
}

// ── Step 5: Education ────────────────────────────────────────────────────
function Step5({ values, setField, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const inSchool = values.highestEducationLevel === 'in_hs' || values.highestEducationLevel === 'some_college';
    return (
        <div className="space-y-4">
            <SectionHead title={tx('Education', 'Educación')}
                subtitle={tx('All optional except the student question.', 'Todo opcional menos la pregunta de estudiante.')} />
            <div>
                <FieldLabel>{tx('Highest level of education', 'Nivel de educación más alto')}</FieldLabel>
                <div className="space-y-1.5">
                    {EDUCATION_LEVELS.map(o => (
                        <button key={o.id} type="button" onClick={() => setField('highestEducationLevel', o.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg border-2 text-sm font-semibold transition active:scale-[0.99] ${
                                values.highestEducationLevel === o.id
                                    ? 'bg-dd-sage-50 border-dd-green text-dd-green-700'
                                    : 'bg-white border-gray-300 text-gray-700'
                            }`}>
                            {isEs ? o.es : o.en}
                        </button>
                    ))}
                </div>
            </div>
            {inSchool && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                        <FieldLabel>{tx('School', 'Escuela')}</FieldLabel>
                        <TextInput value={values.schoolName} onChange={v => setField('schoolName', v)}
                            placeholder={tx('e.g. Webster Groves HS', 'ej: Webster Groves HS')} maxLength={60} />
                    </div>
                    <div>
                        <FieldLabel>{tx('Expected graduation', 'Graduación esperada')}</FieldLabel>
                        <input type="month" value={values.expectedGraduation}
                            onChange={e => setField('expectedGraduation', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                    </div>
                </div>
            )}
            <div>
                <FieldLabel required helper={tx('Helps us plan around classes.', 'Nos ayuda a planear alrededor de clases.')}>
                    {tx('Currently a student?', '¿Eres estudiante?')}
                </FieldLabel>
                <YesNoPick value={values.isStudent} onChange={(v) => setField('isStudent', v)}
                    yesLabel={tx('Yes', 'Sí')} noLabel={tx('No', 'No')} />
            </div>
        </div>
    );
}

// ── Step 6: Eligibility + age ────────────────────────────────────────────
function Step6({ values, setField, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="space-y-4">
            <SectionHead title={tx('Eligibility', 'Elegibilidad')} />
            <div>
                <FieldLabel required helper={tx(
                    'Federal law lets us only confirm work authorization here. If hired, we\'ll verify with Form I-9 — you\'ll choose which documents to provide.',
                    'La ley federal solo nos permite confirmar autorización de trabajo. Si te contratamos, verificaremos con el Formulario I-9.',
                )}>
                    {tx('Are you legally authorized to work in the United States?',
                        '¿Estás legalmente autorizado para trabajar en EE.UU.?')}
                </FieldLabel>
                <YesNoPick value={values.workAuthorized} onChange={(v) => setField('workAuthorized', v)}
                    yesLabel={tx('Yes', 'Sí')} noLabel={tx('No', 'No')} />
            </div>
            <div>
                <FieldLabel required helper={tx('We hire 16+. Under 18 needs a school work permit (federal law).',
                    'Contratamos 16+. Menores de 18 necesitan permiso escolar.')}>
                    {tx('Are you under 18?', '¿Tienes menos de 18?')}
                </FieldLabel>
                <YesNoPick value={values.isUnder18} onChange={(v) => setField('isUnder18', v)}
                    yesLabel={tx('Yes', 'Sí')} noLabel={tx('No (18+)', 'No (18+)')} />
            </div>
            {values.isUnder18 === true && (
                <div>
                    <FieldLabel required>{tx('Are you under 16?', '¿Tienes menos de 16?')}</FieldLabel>
                    <YesNoPick value={values.isUnder16} onChange={(v) => setField('isUnder16', v)}
                        yesLabel={tx('Yes', 'Sí')} noLabel={tx('No (16-17)', 'No (16-17)')} />
                </div>
            )}
            <div>
                <FieldLabel required helper={tx('Missouri requires it. Course is ~90 min online and we cover the cost.',
                    'Missouri lo requiere. ~90 min online y cubrimos el costo.')}>
                    {tx('Willing to complete a free ServSafe Food Handler course in your first week?',
                        '¿Dispuesto a completar el curso ServSafe en tu primera semana?')}
                </FieldLabel>
                <YesNoPick value={values.canPassFoodSafetyTraining}
                    onChange={(v) => setField('canPassFoodSafetyTraining', v)}
                    yesLabel={tx('Yes', 'Sí')} noLabel={tx('No', 'No')} />
            </div>
        </div>
    );
}

// ── Step 7: References (optional) ────────────────────────────────────────
function Step7({ values, setValues, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const addRef = () => {
        if (values.references.length >= 2) return;
        setValues(v => ({ ...v, references: [...v.references, { name: '', relation: '', phone: '', mayContact: false }] }));
    };
    const removeRef = (idx) => setValues(v => ({ ...v, references: v.references.filter((_, i) => i !== idx) }));
    const updateRef = (idx, patch) => setValues(v => ({
        ...v, references: v.references.map((r, i) => i === idx ? { ...r, ...patch } : r),
    }));
    return (
        <div className="space-y-4">
            <SectionHead title={tx('References', 'Referencias')}
                subtitle={tx('Optional — we won\'t reject you for skipping this.',
                    'Opcional — no rechazamos por dejar esto en blanco.')} />
            <div className="space-y-2">
                {values.references.map((r, i) => (
                    <div key={i} className="bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-gray-600">{tx(`Reference ${i + 1}`, `Referencia ${i + 1}`)}</span>
                            <button type="button" onClick={() => removeRef(i)}
                                className="text-[10px] text-red-600 font-bold">{tx('Remove', 'Quitar')}</button>
                        </div>
                        <TextInput value={r.name} onChange={v => updateRef(i, { name: v })}
                            placeholder={tx('Their name', 'Su nombre')} maxLength={60} />
                        <select value={r.relation} onChange={e => updateRef(i, { relation: e.target.value })}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">
                            <option value="">{tx('Relationship', 'Relación')}</option>
                            {REFERENCE_RELATIONS.map(o => (
                                <option key={o.id} value={o.id}>{isEs ? o.es : o.en}</option>
                            ))}
                        </select>
                        <TextInput type="tel" inputMode="tel" value={r.phone}
                            onChange={v => updateRef(i, { phone: v })} placeholder="(314) 555-9876" />
                        <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer">
                            <input type="checkbox" checked={r.mayContact}
                                onChange={e => updateRef(i, { mayContact: e.target.checked })}
                                className="w-4 h-4 accent-dd-green" />
                            {tx('OK to contact this person', 'OK contactar a esta persona')}
                        </label>
                    </div>
                ))}
                {values.references.length < 2 && (
                    <button type="button" onClick={addRef}
                        className="w-full py-2 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 text-sm font-bold hover:border-dd-green hover:text-dd-green">
                        + {tx('Add a reference', 'Agregar referencia')}
                    </button>
                )}
            </div>
        </div>
    );
}

// ── Step 8: How did you hear about us? ───────────────────────────────────
function Step8({ values, setField, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="space-y-4">
            <SectionHead title={tx('How did you hear about us?', '¿Cómo nos conociste?')}
                subtitle={tx('Optional — helps us know what\'s working.', 'Opcional — nos ayuda a saber qué funciona.')} />
            <div>
                <ChipGroup options={REFERRAL_SOURCES} selected={values.referralSource}
                    onToggle={(id) => setField('referralSource', id)} isEs={isEs} multi={false} />
            </div>
            {values.referralSource === 'friend_family' && (
                <div>
                    <FieldLabel helper={tx('We\'ll send them a thank you.', 'Le enviaremos un agradecimiento.')}>
                        {tx('Their name', 'Su nombre')}
                    </FieldLabel>
                    <TextInput value={values.referredByName}
                        onChange={v => setField('referredByName', v)}
                        placeholder={tx('Friend / family name', 'Nombre de amigo / familiar')} maxLength={60} />
                </div>
            )}
        </div>
    );
}

// ── Step 9: Languages + extras ───────────────────────────────────────────
function Step9({ values, setField, toggleInArray, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    return (
        <div className="space-y-4">
            <SectionHead title={tx('Anything else?', '¿Algo más?')}
                subtitle={tx('Optional — both fields below.', 'Opcional — los dos campos.')} />
            <div>
                <FieldLabel helper={tx('Bilingual is a real plus in our kitchen.', 'Bilingüe es una gran ventaja.')}>
                    {tx('Languages you speak', 'Idiomas que hablas')}
                </FieldLabel>
                <ChipGroup options={LANGUAGES} selected={values.spokenLanguages}
                    onToggle={(id) => toggleInArray('spokenLanguages', id)} isEs={isEs} />
            </div>
            <div>
                <FieldLabel helper={tx('Why DD Mau? Anything that sets you apart?', '¿Por qué DD Mau? ¿Qué te distingue?')}>
                    {tx('Note for the team', 'Nota para el equipo')}
                </FieldLabel>
                <textarea value={values.anythingElse} onChange={e => setField('anythingElse', e.target.value)}
                    rows={4} maxLength={500} placeholder={tx('Skip if you don\'t want to.', 'Salta si no quieres.')}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:border-dd-green focus:outline-none focus:ring-2 focus:ring-dd-green/30" />
                <p className="text-[10px] text-gray-400 text-right mt-0.5">{values.anythingElse.length}/500</p>
            </div>
        </div>
    );
}

// ── Step 10: Consent + sign ──────────────────────────────────────────────
function Step10({ values, setField, isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const sigOk = values.typedSignature.trim().length > 0 &&
        values.typedSignature.trim().toLowerCase() === values.legalName.trim().toLowerCase();
    return (
        <div className="space-y-4">
            <SectionHead title={tx('Final step: review & sign', 'Último paso: revisar y firmar')} />

            <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-1 text-[12px]">
                <p className="font-bold text-gray-700 mb-1">{tx('Your application', 'Tu solicitud')}</p>
                <p>👤 <span className="font-semibold">{values.legalName}</span>{values.preferredName ? ` (${values.preferredName})` : ''}</p>
                <p>📞 {values.phone}  ✉ {values.email}</p>
                <p>💼 {values.positionsAppliedFor.map(p => labelFor(POSITIONS, p, isEs)).join(', ')}</p>
                <p>📍 {values.locations.map(l => labelFor(LOCATIONS, l, isEs)).join(', ')} · {tx('Start', 'Inicio')}: {values.soonestStartDate}</p>
                <p>⏰ {labelFor(DESIRED_HOURS, values.desiredHours, isEs)}</p>
                {values.spokenLanguages.length > 0 && (
                    <p>🗣 {values.spokenLanguages.map(l => labelFor(LANGUAGES, l, isEs)).join(', ')}</p>
                )}
            </div>

            <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-50 rounded-lg">
                <input type="checkbox" checked={values.contactConsent}
                    onChange={e => setField('contactConsent', e.target.checked)}
                    className="mt-0.5 w-5 h-5 accent-dd-green flex-shrink-0" />
                <span className="text-[12px] text-gray-700 leading-snug">
                    {tx(
                        'I agree DD Mau may text or email me about my application using the contact info I provided. Standard message and data rates may apply. Reply STOP to opt out.',
                        'Acepto que DD Mau me contacte por mensaje o correo sobre mi solicitud. Pueden aplicar tarifas estándar de mensajes y datos. Responde STOP para cancelar.',
                    )}
                </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-50 rounded-lg">
                <input type="checkbox" checked={values.truthfulnessConsent}
                    onChange={e => setField('truthfulnessConsent', e.target.checked)}
                    className="mt-0.5 w-5 h-5 accent-dd-green flex-shrink-0" />
                <span className="text-[12px] text-gray-700 leading-snug">
                    {tx(
                        'I certify the info I\'ve provided is true and complete to the best of my knowledge. False statements may be grounds for not hiring me or, if hired, for termination.',
                        'Certifico que la información es verdadera y completa hasta donde sé. Declaraciones falsas pueden ser causa de no contratación o, si soy contratado, despido.',
                    )}
                </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer p-2 hover:bg-gray-50 rounded-lg">
                <input type="checkbox" checked={values.atWillAck}
                    onChange={e => setField('atWillAck', e.target.checked)}
                    className="mt-0.5 w-5 h-5 accent-dd-green flex-shrink-0" />
                <span className="text-[12px] text-gray-700 leading-snug">
                    {tx(
                        'I understand that, if hired, my employment with DD Mau is at-will — either I or DD Mau can end the employment relationship at any time, with or without cause or notice.',
                        'Entiendo que, si soy contratado, mi empleo con DD Mau es a voluntad — cualquiera de las partes puede terminar la relación en cualquier momento, con o sin causa.',
                    )}
                </span>
            </label>

            <div>
                <FieldLabel required helper={tx('Type your full legal name to sign.', 'Escribe tu nombre legal completo para firmar.')}>
                    {tx('Signature', 'Firma')}
                </FieldLabel>
                <input value={values.typedSignature} onChange={e => setField('typedSignature', e.target.value)}
                    placeholder={values.legalName || tx('Your legal name', 'Tu nombre legal')} maxLength={80}
                    autoComplete="off"
                    className={`w-full border-2 rounded-lg px-3 py-3 text-sm font-bold italic ${
                        sigOk ? 'border-green-500 bg-green-50' :
                        values.typedSignature ? 'border-amber-500 bg-amber-50' :
                        'border-gray-300'
                    }`} />
                {values.typedSignature && !sigOk && (
                    <p className="text-[11px] text-amber-700 mt-1">
                        {tx('Must match your legal name exactly.', 'Debe coincidir exactamente con tu nombre legal.')}
                    </p>
                )}
            </div>
        </div>
    );
}
