// Apply-form enums + helpers — shared between OnboardingApply (public)
// and the admin Applications card so option labels stay in sync.
//
// Every enum option is an object { id, en, es }; id is what's stored in
// Firestore, en/es are display labels. Adding a new option = add the
// object; removing = leave it for back-compat and stop offering it in UI.

export const POSITIONS = [
    { id: 'cashier',       en: 'Cashier / front counter',  es: 'Cajero / mostrador' },
    { id: 'line_cook',     en: 'Line cook',                es: 'Cocinero de línea' },
    { id: 'prep_cook',     en: 'Prep cook',                es: 'Cocinero de prep' },
    { id: 'dishwasher',    en: 'Dishwasher',               es: 'Lavaplatos' },
    { id: 'shift_lead',    en: 'Shift lead',               es: 'Líder de turno' },
    { id: 'manager',       en: 'Manager',                  es: 'Gerente' },
    { id: 'catering',      en: 'Catering / events',        es: 'Catering / eventos' },
    { id: 'open_to_any',   en: 'Open to anything',         es: 'Abierto a lo que sea' },
];

export const LOCATIONS = [
    { id: 'webster',   en: 'Webster Groves',       es: 'Webster Groves' },
    { id: 'maryland',  en: 'Maryland Heights',     es: 'Maryland Heights' },
    { id: 'either',    en: 'Either one is fine',   es: 'Cualquiera' },
];

export const DISTANCE_OPTIONS = [
    { id: 'walking',   en: 'Walking distance',  es: 'Caminando' },
    { id: 'lt_15min',  en: 'Less than 15 min',  es: 'Menos de 15 min' },
    { id: '15_30min',  en: '15-30 min',         es: '15-30 min' },
    { id: '30_45min',  en: '30-45 min',         es: '30-45 min' },
    { id: '45plus',    en: '45+ min',           es: '45+ min' },
];

export const TRANSPORT_OPTIONS = [
    { id: 'own_car',         en: 'Own car',                       es: 'Carro propio' },
    { id: 'reliable_ride',   en: 'Reliable ride / family',        es: 'Familia / aventón confiable' },
    { id: 'public_transit',  en: 'Public transit',                es: 'Transporte público' },
    { id: 'bike_walk',       en: 'Bike / walk',                   es: 'Bici / caminando' },
    { id: 'figuring_out',    en: 'I\'ll figure it out',           es: 'Lo resolveré' },
];

export const DESIRED_HOURS = [
    { id: '10_20',  en: '10-20 hours / week (part time)',          es: '10-20 horas / semana (medio tiempo)' },
    { id: '20_30',  en: '20-30 hours / week',                       es: '20-30 horas / semana' },
    { id: '30_40',  en: '30-40 hours / week (close to full time)',  es: '30-40 horas / semana' },
    { id: 'flex',   en: 'Whatever\'s available',                    es: 'Lo que haya' },
];

export const DAYS = [
    { id: 'mon', en: 'Mon', es: 'Lun' },
    { id: 'tue', en: 'Tue', es: 'Mar' },
    { id: 'wed', en: 'Wed', es: 'Mié' },
    { id: 'thu', en: 'Thu', es: 'Jue' },
    { id: 'fri', en: 'Fri', es: 'Vie' },
    { id: 'sat', en: 'Sat', es: 'Sáb' },
    { id: 'sun', en: 'Sun', es: 'Dom' },
];

export const SHIFT_BLOCKS = [
    { id: 'open',   en: 'Open (6a-11a)',   es: 'Apertura (6a-11a)' },
    { id: 'lunch',  en: 'Lunch (11a-3p)',  es: 'Almuerzo (11a-3p)' },
    { id: 'dinner', en: 'Dinner (3p-9p)',  es: 'Cena (3p-9p)' },
    { id: 'close',  en: 'Close (9p-mid)',  es: 'Cierre (9p-12a)' },
];

export const EXPERIENCE_YEARS = [
    { id: 'none',         en: 'None / never worked in a restaurant',  es: 'Ninguna / nunca trabajé en restaurante' },
    { id: 'lt_6mo',       en: 'Less than 6 months',                    es: 'Menos de 6 meses' },
    { id: '6mo_1yr',      en: '6 months - 1 year',                     es: '6 meses - 1 año' },
    { id: '1_2_years',    en: '1-2 years',                             es: '1-2 años' },
    { id: '2_5_years',    en: '2-5 years',                             es: '2-5 años' },
    { id: '5plus_years',  en: '5+ years',                              es: '5+ años' },
];

export const PREVIOUS_ROLES = [
    { id: 'cashier',     en: 'Cashier',              es: 'Cajero' },
    { id: 'server',      en: 'Server / runner',      es: 'Mesero / corredor' },
    { id: 'drive_thru',  en: 'Drive-thru / window',  es: 'Drive-thru / ventanilla' },
    { id: 'barista',     en: 'Barista',              es: 'Barista' },
    { id: 'line_cook',   en: 'Line cook',            es: 'Cocinero de línea' },
    { id: 'prep_cook',   en: 'Prep cook',            es: 'Cocinero de prep' },
    { id: 'pizza',       en: 'Pizza maker',          es: 'Pizzero' },
    { id: 'sushi',       en: 'Sushi / sushi station',es: 'Sushi' },
    { id: 'dish',        en: 'Dish / pit',           es: 'Lavaplatos' },
    { id: 'expo',        en: 'Expo',                 es: 'Expo' },
    { id: 'shift_lead',  en: 'Shift lead',           es: 'Líder de turno' },
    { id: 'asst_mgr',    en: 'Assistant manager',    es: 'Subgerente' },
    { id: 'gm',          en: 'General manager',      es: 'Gerente general' },
    { id: 'catering',    en: 'Catering',             es: 'Catering' },
    { id: 'bartender',   en: 'Bartender',            es: 'Bartender' },
];

export const SKILLS = [
    { id: 'knife_skills',     en: 'Knife skills',                   es: 'Manejo de cuchillo' },
    { id: 'saute',            en: 'Sauté station',                  es: 'Sauté' },
    { id: 'grill',            en: 'Grill',                          es: 'Parrilla' },
    { id: 'fryer',            en: 'Fryer',                          es: 'Freidora' },
    { id: 'pizza_oven',       en: 'Pizza oven',                     es: 'Horno de pizza' },
    { id: 'pos_toast',        en: 'POS — Toast',                    es: 'POS — Toast' },
    { id: 'pos_square',       en: 'POS — Square',                   es: 'POS — Square' },
    { id: 'pos_clover',       en: 'POS — Clover',                   es: 'POS — Clover' },
    { id: 'pos_other',        en: 'POS — other',                    es: 'POS — otro' },
    { id: 'cash_handling',    en: 'Cash handling',                  es: 'Manejo de efectivo' },
    { id: 'latte_art',        en: 'Latte art',                      es: 'Arte latte' },
    { id: 'bar_prep',         en: 'Bar prep',                       es: 'Prep de bar' },
    { id: 'food_safety',      en: 'Food safety',                    es: 'Seguridad alimentaria' },
    { id: 'inventory',        en: 'Inventory / receiving',          es: 'Inventario / recibo' },
    { id: 'scheduling',       en: 'Scheduling',                     es: 'Programación' },
    { id: 'training',         en: 'Training new staff',             es: 'Capacitar nuevo personal' },
];

export const CERTIFICATIONS = [
    { id: 'servsafe_food',  en: 'ServSafe Food Handler',           es: 'ServSafe — Manejador de alimentos' },
    { id: 'servsafe_mgr',   en: 'ServSafe Manager',                es: 'ServSafe — Gerente' },
    { id: 'hep_a',          en: 'Hep A vaccination',               es: 'Vacuna Hepatitis A' },
    { id: 'allergen',       en: 'Allergen training',               es: 'Capacitación de alérgenos' },
    { id: 'alcohol',        en: 'Alcohol service (TIPS / BASSET)', es: 'Servicio de alcohol' },
    { id: 'cpr',            en: 'CPR / First Aid',                 es: 'CPR / Primeros auxilios' },
];

export const LIFTING_CAPACITY = [
    { id: '10lbs',      en: 'About 10 lbs (light)',          es: 'Unas 10 lbs (ligero)' },
    { id: '25lbs',      en: 'About 25 lbs (standard)',       es: 'Unas 25 lbs (estándar)' },
    { id: '40lbs',      en: 'About 40 lbs (boxes of produce)',es: 'Unas 40 lbs (cajas de producto)' },
    { id: '50plus_lbs', en: '50+ lbs (rice bags, stockpots)',es: '50+ lbs (sacos de arroz, ollas)' },
];

export const STANDING_HOURS = [
    { id: '1_2_hrs',     en: '1-2 hours',                es: '1-2 horas' },
    { id: '3_4_hrs',     en: '3-4 hours',                es: '3-4 horas' },
    { id: '5_6_hrs',     en: '5-6 hours',                es: '5-6 horas' },
    { id: '6plus_hrs',   en: '6+ hours (a full shift)',  es: '6+ horas (turno completo)' },
];

export const EDUCATION_LEVELS = [
    { id: 'in_hs',        en: 'Still in high school',        es: 'Todavía en preparatoria' },
    { id: 'hs_ged',       en: 'High school diploma / GED',   es: 'Preparatoria / GED' },
    { id: 'some_college', en: 'Some college',                es: 'Algo de universidad' },
    { id: 'associate',    en: 'Associate / trade cert',      es: 'Asociado / certificado técnico' },
    { id: 'bachelors',    en: 'Bachelor\'s degree',          es: 'Licenciatura' },
    { id: 'masters_plus', en: 'Master\'s or higher',         es: 'Maestría o más' },
    { id: 'prefer_no',    en: 'Prefer not to say',           es: 'Prefiero no decir' },
];

export const REFERENCE_RELATIONS = [
    { id: 'former_manager',  en: 'Former manager / supervisor', es: 'Gerente anterior' },
    { id: 'former_coworker', en: 'Former coworker',             es: 'Compañero de trabajo anterior' },
    { id: 'teacher',         en: 'Teacher / counselor',         es: 'Maestro / consejero' },
    { id: 'other_adult',     en: 'Other adult (not family)',    es: 'Otro adulto (no familiar)' },
];

export const REFERRAL_SOURCES = [
    { id: 'walked_by',     en: 'Walked by the restaurant',     es: 'Pasé por el restaurante' },
    { id: 'friend_family', en: 'Friend / family who works here', es: 'Amigo / familiar que trabaja aquí' },
    { id: 'indeed',        en: 'Indeed',                       es: 'Indeed' },
    { id: 'facebook_ig',   en: 'Facebook / Instagram',         es: 'Facebook / Instagram' },
    { id: 'tiktok',        en: 'TikTok',                       es: 'TikTok' },
    { id: 'google',        en: 'Google search',                es: 'Búsqueda en Google' },
    { id: 'school',        en: 'School / college career page', es: 'Página de empleo escolar' },
    { id: 'in_store_qr',   en: 'In-store flyer / QR',          es: 'Volante / QR en tienda' },
    { id: 'other',         en: 'Other',                        es: 'Otro' },
];

export const LANGUAGES = [
    { id: 'english',    en: 'English',    es: 'Inglés' },
    { id: 'spanish',    en: 'Spanish',    es: 'Español' },
    { id: 'vietnamese', en: 'Vietnamese', es: 'Vietnamita' },
    { id: 'mandarin',   en: 'Mandarin',   es: 'Mandarín' },
    { id: 'french',     en: 'French',     es: 'Francés' },
    { id: 'other',      en: 'Other',      es: 'Otro' },
];

export const APPLICATION_STATUSES = {
    APPLIED:       'applied',
    SCREENING:     'screening',
    PHONE_SCREEN:  'phone_screen',
    INTERVIEW:     'interview',
    OFFER:         'offer',
    HIRED:         'hired',
    NOT_SELECTED:  'not_selected',
    WITHDREW:      'withdrew',
    EXPIRED:       'expired',
};

export const APPLICATION_STATUS_META = {
    applied:       { en: 'Applied',         es: 'Aplicó',         emoji: '🟢', tone: 'bg-green-50 text-green-700 border-green-200' },
    screening:     { en: 'Screening',       es: 'Revisando',      emoji: '👀', tone: 'bg-blue-50 text-blue-700 border-blue-200' },
    phone_screen:  { en: 'Phone screen',    es: 'Llamada',        emoji: '📞', tone: 'bg-blue-50 text-blue-700 border-blue-200' },
    interview:     { en: 'Interview',       es: 'Entrevista',     emoji: '📅', tone: 'bg-purple-50 text-purple-700 border-purple-200' },
    offer:         { en: 'Offer sent',      es: 'Oferta enviada', emoji: '💌', tone: 'bg-amber-50 text-amber-700 border-amber-200' },
    hired:         { en: 'Hired',           es: 'Contratado',     emoji: '✅', tone: 'bg-green-100 text-green-800 border-green-300' },
    not_selected:  { en: 'Not selected',    es: 'No seleccionado',emoji: '⛔', tone: 'bg-gray-100 text-gray-700 border-gray-300' },
    withdrew:      { en: 'Withdrew',        es: 'Se retiró',      emoji: '🚪', tone: 'bg-gray-100 text-gray-700 border-gray-300' },
    expired:       { en: 'Expired',         es: 'Expirado',       emoji: '🕓', tone: 'bg-gray-50 text-gray-500 border-gray-200' },
};

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

// Normalize US phone input to E.164. Accepts (314) 555-1234, 314-555-1234,
// 3145551234, +1 314 555 1234 — returns +13145551234. Returns '' if it
// doesn't look like a US phone (so caller can show a validation error).
export function normalizeUsPhone(raw) {
    if (!raw) return '';
    const digits = String(raw).replace(/[^0-9]/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    return '';
}

export function isValidEmail(raw) {
    if (!raw) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw).trim());
}

// SHA-256 hash of a string. Returns hex digest. Used for ipHash on submit
// (we never store the raw IP, only the hash) so we can detect "same
// device submitted twice" without holding PII.
export async function sha256Hex(input) {
    if (!input || typeof crypto === 'undefined' || !crypto.subtle) return '';
    try {
        const bytes = new TextEncoder().encode(String(input));
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    } catch { return ''; }
}

// Compute admin match score 0-100 from an application doc. Internal-only;
// never displayed to the applicant. Higher = better-fit candidate.
export function computeMatchScore(app) {
    if (!app) return 0;
    let score = 0;
    const exp = app.restaurantExperienceYears;
    if (exp === 'lt_6mo' || exp === '6mo_1yr') score += 10;
    else if (exp === '1_2_years') score += 20;
    else if (exp === '2_5_years' || exp === '5plus_years') score += 30;

    // Experience matches the position they want (line cook applied + has
    // line cook in previousRoles, etc).
    const wanted = new Set(app.positionsAppliedFor || []);
    const prev = new Set(app.previousRoles || []);
    if ([...wanted].some(p => prev.has(p))) score += 15;

    // Availability: count dinner shifts across the week.
    const avail = app.availability || {};
    let dinners = 0;
    for (const d of ['mon','tue','wed','thu','fri','sat','sun']) {
        if (avail[d] && avail[d].dinner) dinners++;
    }
    if (dinners >= 4) score += 15;
    else if (dinners >= 2) score += 8;

    // Transportation reliability.
    if (app.transportationMethod === 'own_car' || app.transportationMethod === 'reliable_ride') score += 10;

    // Bilingual EN/ES is a real plus for our brand.
    const langs = new Set(app.spokenLanguages || []);
    if (langs.has('english') && langs.has('spanish')) score += 10;

    // Certifications worth surfacing.
    const certs = new Set(app.certifications || []);
    if (certs.has('servsafe_food') || certs.has('servsafe_mgr') || certs.has('allergen')) score += 5;

    // Can start within 7 days.
    if (app.soonestStartDate) {
        const start = new Date(app.soonestStartDate + 'T00:00:00');
        const days = (start.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
        if (days >= 0 && days <= 7) score += 15;
    }

    return Math.min(100, score);
}

// Friendly label lookup — returns en or es text for a given enum id.
export function labelFor(list, id, isEs) {
    const found = (list || []).find(o => o.id === id);
    if (!found) return id || '';
    return isEs ? found.es : found.en;
}
