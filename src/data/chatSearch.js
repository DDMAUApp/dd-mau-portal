// Chat search — bilingual + cross-field indexing helpers.
//
// Pure helpers, no React, no Firestore. Consumed by ChatSearchPanel
// to widen what "matches" a query without changing the message
// schema or requiring an Algolia/embeddings backend.
//
// ── What gets indexed ─────────────────────────────────────────────
// Previously the search panel matched only `m.text + m.senderName`.
// Now we build a single normalized "haystack" string per message that
// also includes:
//   • poll.question + every poll.options[].label
//   • replyTo.snippet + replyTo.senderName
//   • the message's own type label ("photo", "voice", "poll") so
//     typing "photo" surfaces every image message in the chat
//   • coverage.shiftDate + coverage.shiftLabel if present
// All concatenated, lowercased, and accent-stripped so "José" and
// "Jose" both hit.
//
// ── Synonyms — two modes ─────────────────────────────────────────
// The same restaurant vocabulary serves two different search jobs:
//
//   BROAD (chat search, "show me anything about chicken")
//     Groups cuts + species + cooking-broader terms together so
//     typing "wings" pulls every chat message that mentioned thigh,
//     breast, or just "chicken". Operational verbs (boss/cover/sick)
//     and message-type words (photo/poll) also live here.
//
//   TIGHT (recipe search, "find the WINGS recipe")
//     Strips cut/species expansion so "wings" doesn't drag in every
//     chicken recipe. Keeps pure translation/dialect pairs only —
//     chicken↔pollo, lime↔limón, mint↔menta. Searches stay precise.
//
// Andrew's bug report (2026-05-18): "searched wings, didn't isolate
// wings". The fix is having recipe search opt into the tight index.
//
// We expand the query, NOT the haystack — keeps index building cheap
// and lets us tune the synonym lists without re-indexing anything.

// Pure translations / dialect — identical in both modes. Tomato is
// tomato is tomate is jitomate. No risk of false positives.
const SHARED_TRANSLATION_GROUPS = [
    // Produce
    ['lettuce', 'lechuga'],
    ['cabbage', 'col', 'repollo'],
    ['tomato', 'tomate', 'jitomate'],
    ['onion', 'cebolla'],
    ['garlic', 'ajo'],
    ['cilantro', 'culantro', 'coriander'],
    ['lime', 'limon', 'limón'],
    ['mint', 'menta', 'hierbabuena'],
    // Staples
    ['rice', 'arroz'],
    ['noodle', 'noodles', 'fideo', 'fideos'],
    // Seafood — shrimp/prawn are true synonyms
    ['shrimp', 'camaron', 'camarón', 'camarones', 'prawn'],
];

// Tight-only — proteins and dish names where ONLY the base term ↔
// Spanish translation is interchangeable. No cuts (wing/thigh/breast),
// no species (salmon/tuna/tilapia), no bridging (pho≠soup).
const TIGHT_ONLY_GROUPS = [
    ['chicken', 'pollo'],
    ['beef', 'res', 'carne'],
    ['pork', 'cerdo', 'puerco'],
    ['fish', 'pescado'],
    ['soy', 'soya'],
    // tofu intentionally alone — typing tofu shouldn't pull soy sauce
    ['pho', 'phở'],
    ['soup', 'sopa'],
    ['broth', 'caldo'],
];

// Broad-only — same protein/dish base terms but expanded to cuts,
// species, vegan flags, and soup-family bridging. Plus operations
// vocab and message-type words used only in chat.
const BROAD_ONLY_GROUPS = [
    // Proteins broadened with cuts/species
    ['chicken', 'pollo', 'wing', 'wings', 'thigh', 'breast'],
    ['beef', 'res', 'carne', 'cow', 'bone', 'hueso', 'huesos'],
    ['pork', 'cerdo', 'puerco', 'belly', 'panceta'],
    ['fish', 'pescado', 'salmon', 'tuna', 'atun', 'tilapia'],
    ['tofu', 'soy', 'soya', 'vegan', 'vegano', 'plant'],
    ['pho', 'phở', 'soup', 'sopa', 'broth', 'caldo'],
    // Operations / staff verbs
    ['boss', 'manager', 'gerente', 'jefe', 'owner', 'dueño', 'duena'],
    ['cover', 'cubrir', 'coverage', 'cobertura', 'sub', 'replacement'],
    ['shift', 'turno', 'schedule', 'horario'],
    ['break', 'descanso', 'lunch', 'almuerzo'],
    ['sick', 'enfermo', 'enferma', 'illness'],
    ['late', 'tarde', 'tardy', 'tardanza'],
    ['off', 'pto', 'time-off', 'vacation', 'vacaciones', 'libre'],
    ['order', 'pedido', 'orden'],
    ['86', 'eighty-six', 'eighty six', 'out', 'agotado', 'sin'],
    ['broken', 'roto', 'rota', 'dañado', 'danado', 'busted', 'fix'],
    ['cleaning', 'limpieza', 'clean', 'limpiar'],
    ['plumbing', 'plomeria', 'plomería', 'drain', 'leak', 'fuga'],
    ['safety', 'peligro', 'hazard', 'unsafe'],
    // Message-type words — typing the noun finds messages of that type
    ['photo', 'foto', 'image', 'imagen', 'pic'],
    ['voice', 'voz', 'audio', 'recording', 'grabacion', 'grabación'],
    ['video'],
    ['poll', 'encuesta', 'survey', 'vote', 'voto'],
    ['announcement', 'anuncio', 'announce'],
    ['issue', 'problema', 'problem'],
];

const TIGHT_SYNONYM_GROUPS = [...SHARED_TRANSLATION_GROUPS, ...TIGHT_ONLY_GROUPS];
const BROAD_SYNONYM_GROUPS = [...SHARED_TRANSLATION_GROUPS, ...BROAD_ONLY_GROUPS];

// Build a fast lookup from any term → the set of all synonyms in its
// group. Computed once at module load, once per mode.
function buildSynonymIndex(groups) {
    const idx = new Map();
    for (const group of groups) {
        const set = new Set(group.map(t => normalize(t)));
        for (const t of group) idx.set(normalize(t), set);
    }
    return idx;
}
const TIGHT_INDEX = buildSynonymIndex(TIGHT_SYNONYM_GROUPS);
const BROAD_INDEX = buildSynonymIndex(BROAD_SYNONYM_GROUPS);

// Strip accents, lowercase, collapse whitespace. Cheap and dependency-
// free. Uses NFD + diacritic strip — fully supported in modern Safari/
// Chrome (handles é→e, ñ→n, etc.). Punctuation is replaced with spaces
// so "drain-pipe" matches a query for "drain pipe" and vice versa.
export function normalize(s) {
    if (!s) return '';
    return String(s)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
}

// Internal — tokenize a query against a specific synonym index.
function expandWithIndex(query, index) {
    const raw = normalize(query);
    if (!raw) return [];
    return raw.split(/\s+/).filter(Boolean).map(term => {
        const group = index.get(term);
        const expansions = group ? new Set(group) : new Set([term]);
        return { term, expansions };
    });
}

// Broad expansion — chat search default. "wings" pulls all chicken,
// "salmon" pulls all fish, etc. Operations + message-type vocab
// included.
export function expandQueryTerms(query) {
    return expandWithIndex(query, BROAD_INDEX);
}

// Tight expansion — recipe search. Translation/dialect pairs only.
// "wings" stays literal; "chicken" still finds "pollo".
export function expandQueryTermsTight(query) {
    return expandWithIndex(query, TIGHT_INDEX);
}

// Build a single normalized haystack string for a message. Pulls every
// human-readable field we care about into one searchable blob.
//
// We do NOT persist this anywhere — it's recomputed each search. For a
// few hundred messages × a few-letter query this is sub-millisecond.
// If chats grow to 10k+ messages we'll want to memoize per-message or
// move to Algolia, but that's a Phase 2 problem.
export function buildHaystack(message) {
    if (!message) return '';
    const parts = [];
    if (message.text) parts.push(message.text);
    if (message.senderName) parts.push(message.senderName);

    // Reply target — searching "boss" finds messages REPLYING to a
    // message that mentioned "boss".
    if (message.replyTo) {
        if (message.replyTo.snippet) parts.push(message.replyTo.snippet);
        if (message.replyTo.senderName) parts.push(message.replyTo.senderName);
    }

    // Poll — question + every option label.
    if (message.poll) {
        if (message.poll.question) parts.push(message.poll.question);
        if (Array.isArray(message.poll.options)) {
            for (const o of message.poll.options) {
                if (o && o.label) parts.push(o.label);
            }
        }
    }

    // Type label — typing "photo" should find image messages even if
    // the caption is empty. Adds the type itself + a readable noun.
    if (message.type === 'image') parts.push('photo image foto');
    if (message.type === 'video') parts.push('video');
    if (message.type === 'audio') parts.push('voice audio voz');
    if (message.type === 'poll') parts.push('poll encuesta');
    if (message.type === 'announcement') parts.push('announcement anuncio');
    if (message.type === 'coverage_request') parts.push('coverage cobertura shift turno');
    if (message.type === 'photo_issue') parts.push('issue problema');

    // Coverage cards carry shift info as fields on the message doc.
    if (message.coverage) {
        if (message.coverage.shiftDate) parts.push(message.coverage.shiftDate);
        if (message.coverage.shiftLabel) parts.push(message.coverage.shiftLabel);
    }

    // Photo-issue extras: category + caption.
    if (message.issueCategory) parts.push(String(message.issueCategory));

    return normalize(parts.join(' '));
}

// Does a haystack match every expanded token? AND-semantics: all of
// the query's terms must appear (each in its expanded form). This
// matches the "all of these words" expectation users have from Gmail/
// Slack-style search rather than "any of these".
export function haystackMatches(haystack, expandedTokens) {
    if (!haystack || !Array.isArray(expandedTokens) || expandedTokens.length === 0) return true;
    for (const tok of expandedTokens) {
        const matchedAny = Array.from(tok.expansions).some(syn => haystack.includes(syn));
        if (!matchedAny) return false;
    }
    return true;
}
