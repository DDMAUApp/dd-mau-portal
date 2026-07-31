// Human labels + autofill guesses for fillable-PDF form fields.
//
// Andrew 2026-07-30: "in all of the fillable fields it says top something.
// lets make the text actually be helpful — if it asks for first name then it
// says it there."
//
// WHY IT SAID "top something": government fillable PDFs (IRS W-4, MO W-4,
// USCIS I-9) are XFA-derived, and every AcroForm field is named like
//     topmostSubform[0].Page1[0].f1_01[0]
// The template editor used `ann.fieldName || ann.alternativeText`, i.e. it
// preferred that machine name and only fell back to the tooltip. That's
// backwards — `alternativeText` is the PDF's accessibility tooltip, which on
// government forms is a HUMAN sentence written by the agency ("Step 1(a)
// First name and middle initial"). So the useful text was there all along,
// just outranked.
//
// These helpers are pure so they can be unit-tested without pdfjs, and are
// applied BOTH at detect time (new templates) and at render time (so
// templates saved before this change display properly with no re-detection).

/** Machine-generated AcroForm leaf names carry no meaning for a human. */
const JUNK_LEAF = /^(?:[fc]\d*[_-]?\d+|field\d*|text\d*|checkbox\d*|untitled\d*|p\d+)$/i;

/** The XFA container prefix every IRS/USCIS form field starts with. */
const XFA_NOISE = /^(?:topmostsubform|form1|page\d+|subform\d*|sf\d*)$/i;

/**
 * Turn a PDF widget's identifiers into something a hire can read.
 * Returns '' when neither source yields anything meaningful — the caller
 * decides the fallback (e.g. "Field 3").
 *
 * @param {string} fieldName        raw AcroForm name
 * @param {string} alternativeText  the PDF tooltip / accessible name
 */
export function humanizeFieldLabel(fieldName, alternativeText) {
    // 1. Tooltip wins — on government forms this is the agency's own wording.
    const alt = collapse(alternativeText);
    if (alt && !looksMachine(alt)) return tidy(alt);

    // 2. Otherwise mine the dotted AcroForm path. The LAST meaningful segment
    //    is the field itself; everything before it is XFA scaffolding.
    const raw = collapse(fieldName);
    if (!raw) return '';
    const segments = raw
        .split('.')
        .map(s => s.replace(/\[\d+\]/g, '').trim())   // drop array indices
        .filter(Boolean)
        .filter(s => !XFA_NOISE.test(s));
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (JUNK_LEAF.test(seg)) continue;            // f1_01 etc. — meaningless
        const words = splitWords(seg);
        if (words) return tidy(words);
    }
    return '';
}

/** A tooltip that's really just the machine name repeated is not a label. */
function looksMachine(s) {
    return /topmostsubform|\[\d+\]/i.test(s) || JUNK_LEAF.test(s.replace(/\s+/g, ''));
}

function collapse(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** camelCase / snake_case / kebab-case / PascalCase → spaced words. */
function splitWords(seg) {
    const out = seg
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z\d])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
    return out.length > 1 ? out : '';
}

/** Sentence-case, trimmed, and capped so a long tooltip can't blow up the UI. */
function tidy(s) {
    const t = collapse(s).replace(/\s*[:*]\s*$/, '');
    const capped = t.length > 80 ? `${t.slice(0, 77).trimEnd()}…` : t;
    return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/**
 * Guess which piece of the hire's record should prefill this field, so the
 * common boxes (name / address / date) are already filled when they open it.
 *
 * ORDER MATTERS: combined boxes must be tested before their parts, or the
 * federal W-4's single "City or town, state, and ZIP code" box matches plain
 * `city` and silently drops the state + ZIP.
 */
export function guessAutofill(rawName, altText) {
    const joined = [rawName, altText].filter(Boolean).join(' ').toLowerCase();
    if (!joined) return '';
    // Keep spaces for phrase tests; `n` is the squashed form for tight matches.
    const phrase = joined.replace(/[_\-.[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
    const n = phrase.replace(/[\s\d]/g, '');

    // --- combined boxes first -------------------------------------------
    // "City or town, state, and ZIP code" (federal W-4), any order.
    if (/city/.test(n) && /state/.test(n) && /zip|postal/.test(n)) return 'cityStateZip';

    // --- identity --------------------------------------------------------
    // Matched on the SPACED phrase, not the squashed form: squashing
    // "Home Address (Number and Street...)" yields "homeaddressnumber",
    // which contains the substring "ssn" and used to bind a street address
    // to the Social Security field. Word boundaries prevent that class of
    // collision entirely.
    if (/\bssn\b|social security|\btin\b/.test(phrase)) return 'ssn';
    if (/firstname|givenname|firstnameandmiddle/.test(n)) return 'firstName';
    if (/lastname|familyname|surname/.test(n)) return 'lastName';
    if (/legalname|fullname|printedname|nameofemployee/.test(n)) return 'legalName';
    if (/^name$|employeename|workername|applicantname/.test(n)) return 'legalName';
    if (/dob|birthdate|dateofbirth|birthday/.test(n)) return 'dob';

    // --- contact ---------------------------------------------------------
    if (/email/.test(n)) return 'email';
    if (/phone|telephone|mobile|cell/.test(n)) return 'phone';

    // --- address parts ---------------------------------------------------
    if (/street|addressline|address1|homeaddress|mailingaddress|^address/.test(n)) return 'addressLine';
    if (/zip|postalcode/.test(n)) return 'zip';
    if (/^city|cityortown|cityname|cityof/.test(n)) return 'city';
    // Don't bind "state tax", "state wages", or "state of issue" to the
    // hire's home state.
    if (/^state|statename|stateofresidence/.test(n) && !/tax|wage|issue/.test(n)) return 'state';

    // --- employment ------------------------------------------------------
    if (/hiredate|dateofhire|startdate|firstdayofwork|dateservices/.test(n)) return 'hireDate';
    if (/position|jobtitle|^title$/.test(n)) return 'position';

    // --- dates -----------------------------------------------------------
    // Broad on purpose: a bare "Date" or "Date (MM/DD/YYYY)" next to a
    // signature is today's date in practice.
    if (/todaysdate|signdate|signaturedate|datesigned|currentdate|^date$|^date(mm|dd)/.test(n)) return 'today';

    return '';
}

// ── Spanish field labels ────────────────────────────────────────────────
// Andrew 2026-07-30: "maybe when Spanish is chosen the fillable text box says
// the Spanish translation of what needs to be filled out."
//
// Keyed on the AUTOFILL BINDING rather than on the English text, because the
// binding is a semantic id we derived ourselves — so the Spanish is exact and
// can't drift with the agency's wording. Government forms word the same box
// differently every revision ("First name and middle initial" vs "Step 1(a)
// First name…"); the binding is stable across all of them.
export const FIELD_LABEL_ES = Object.freeze({
    legalName:    'Nombre completo',
    firstName:    'Nombre (y segundo nombre)',
    lastName:     'Apellido',
    ssn:          'Número de Seguro Social',
    dob:          'Fecha de nacimiento',
    phone:        'Número de teléfono',
    email:        'Correo electrónico',
    addressLine:  'Dirección (calle y número)',
    city:         'Ciudad',
    state:        'Estado',
    zip:          'Código postal',
    cityStateZip: 'Ciudad, estado y código postal',
    today:        'Fecha de hoy',
    hireDate:     'Fecha de inicio',
    position:     'Puesto',
    location:     'Ubicación',
    offerAmount:  'Salario ofrecido',
    legalEntity:  'Nombre del empleador',
    locationAddress: 'Dirección del empleador',
});

// Fallback for boxes with no autofill binding. Substring-matched against the
// English label, longest pattern first so "signature date" can't be eaten by
// "signature". Deliberately small — only phrases that actually recur on the
// W-4 / MO W-4 / I-9.
const ES_PHRASES = [
    ['social security number', 'Número de Seguro Social'],
    ['employee signature', 'Firma del empleado'],
    ['filing status', 'Estado civil para la declaración'],
    ['middle initial', 'Inicial del segundo nombre'],
    ['additional withholding', 'Retención adicional'],
    ['reduced withholding', 'Retención reducida'],
    ['exempt status', 'Estado de exención'],
    ['head of household', 'Jefe de familia'],
    ['marital status', 'Estado civil'],
    ['apartment number', 'Número de apartamento'],
    ['date of birth', 'Fecha de nacimiento'],
    ['last name', 'Apellido'],
    ['first name', 'Nombre'],
    ['full name', 'Nombre completo'],
    ['zip code', 'Código postal'],
    ['signature', 'Firma'],
    ['initials', 'Iniciales'],
    ['address', 'Dirección'],
    ['married', 'Casado/a'],
    ['single', 'Soltero/a'],
    ['exempt', 'Exento'],
    ['date', 'Fecha'],
];

/**
 * The label to show the person filling the form.
 *
 * English is the humanized agency wording. Spanish prefers the binding-keyed
 * translation, then a known phrase, and otherwise falls back to the English
 * text — showing the agency's own words is far better than showing nothing,
 * and it also matches what's printed on the PDF page behind the box.
 *
 * @param {{label?:string, autofill?:string, type?:string}} field
 * @param {'en'|'es'} lang
 */
export function displayFieldLabel(field, lang = 'en') {
    // NEVER fall back to the raw stored label: on a template detected before
    // this fix, `field.label` IS the machine name, and a `|| field.label`
    // fallback would put "topmostSubform[0]…" straight back on screen — the
    // very bug this module exists to kill. When we can't humanize it we lean
    // on the autofill binding, then give up and return '' so the caller can
    // show a positional fallback.
    const human = humanizeFieldLabel(field?.label, '');
    const binding = field?.autofill;
    const isSig = field?.type === 'signature';

    if (lang === 'es') {
        if (FIELD_LABEL_ES[binding]) return FIELD_LABEL_ES[binding];
        if (human) {
            const hay = human.toLowerCase();
            for (const [needle, es] of ES_PHRASES) {
                if (hay.includes(needle)) return es;
            }
        }
        if (isSig) return 'Firma';
        // Untranslated agency English beats nothing — it also matches the
        // words printed on the PDF page behind the box.
        return human;
    }

    if (human) return human;
    if (FIELD_LABEL_EN[binding]) return FIELD_LABEL_EN[binding];
    if (isSig) return 'Signature';
    return '';
}

// English counterpart to FIELD_LABEL_ES — used when the PDF gave us nothing
// human but we DID recognize what the box wants.
const FIELD_LABEL_EN = Object.freeze({
    legalName:    'Full name',
    firstName:    'First name (and middle initial)',
    lastName:     'Last name',
    ssn:          'Social Security number',
    dob:          'Date of birth',
    phone:        'Phone number',
    email:        'Email',
    addressLine:  'Street address',
    city:         'City',
    state:        'State',
    zip:          'ZIP code',
    cityStateZip: 'City, state, and ZIP code',
    today:        "Today's date",
    hireDate:     'Start date',
    position:     'Position',
    location:     'Location',
    offerAmount:  'Offer amount',
    legalEntity:  'Employer name',
    locationAddress: 'Employer address',
});
