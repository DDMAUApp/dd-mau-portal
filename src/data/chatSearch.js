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
// ── Synonyms ──────────────────────────────────────────────────────
// A small bilingual dictionary of restaurant-specific terms. Typing
// "chicken" expands to ALSO search for "pollo", and vice versa. The
// list is intentionally tight — restaurant nouns + 86/coverage/break
// language. Wider thesaurus drift makes searches noisier.
//
// Expansion is one-way per term but the map is symmetric (chicken→
// pollo AND pollo→chicken). We expand the query, NOT the haystack —
// keeps index building cheap and lets us tune the synonyms list
// without re-indexing anything.

// Restaurant-specific bilingual synonym pairs. Keep this short and
// kitchen-relevant; broader synonyms add false positives. EN-side and
// ES-side both included so we don't need a "direction" flag at query
// time — both forms expand to the union of their match group.
const SYNONYM_GROUPS = [
    // Proteins
    ['chicken', 'pollo', 'wing', 'wings', 'thigh', 'breast'],
    ['beef', 'res', 'carne', 'cow', 'bone', 'hueso', 'huesos'],
    ['pork', 'cerdo', 'puerco', 'belly', 'panceta'],
    ['fish', 'pescado', 'salmon', 'tuna', 'atun', 'tilapia'],
    ['shrimp', 'camaron', 'camarón', 'camarones', 'prawn'],
    ['tofu', 'soy', 'soya', 'vegan', 'vegano', 'plant'],
    // Produce
    ['lettuce', 'lechuga'],
    ['cabbage', 'col', 'repollo'],
    ['tomato', 'tomate', 'jitomate'],
    ['onion', 'cebolla'],
    ['garlic', 'ajo'],
    ['cilantro', 'culantro', 'coriander'],
    ['lime', 'limon', 'limón'],
    ['mint', 'menta', 'hierbabuena'],
    // Dishes
    ['pho', 'phở', 'soup', 'sopa', 'broth', 'caldo'],
    ['rice', 'arroz'],
    ['noodle', 'noodles', 'fideo', 'fideos'],
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

// Build a fast lookup from any term → the set of all synonyms in its
// group. Computed once at module load.
const SYNONYM_INDEX = (() => {
    const idx = new Map();
    for (const group of SYNONYM_GROUPS) {
        const set = new Set(group.map(t => normalize(t)));
        for (const t of group) idx.set(normalize(t), set);
    }
    return idx;
})();

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

// Tokenize a query into [{ originalTerm, expansions: Set<string> }].
// Each token's expansions include the normalized form of the original
// plus every synonym from the group it belongs to (if any). Lone words
// not in the dictionary just expand to themselves — they still match.
export function expandQueryTerms(query) {
    const raw = normalize(query);
    if (!raw) return [];
    return raw.split(/\s+/).filter(Boolean).map(term => {
        const group = SYNONYM_INDEX.get(term);
        const expansions = group ? new Set(group) : new Set([term]);
        return { term, expansions };
    });
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
