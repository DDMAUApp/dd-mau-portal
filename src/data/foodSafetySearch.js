// foodSafetySearch.js: answers "what is chicken cooked at?" from the checked rules.
//
// Deliberately not AI. Every answer is a rule someone read and approved, shown
// word for word with its source. It works with no connection, costs nothing, and
// can't invent a temperature. If nothing matches well, it says so, and the screen
// tells the person to ask a manager. Guessing is the one thing this must not do.

const FILLER = new Set([
    // English question words
    'a', 'an', 'the', 'what', 'whats', 'what\'s', 'is', 'are', 'do', 'does', 'did', 'how', 'when', 'where', 'why', 'who', 'which',
    'can', 'could', 'should', 'must', 'may', 'i', 'we', 'you', 'it', 'its', 'to', 'of', 'for', 'at', 'in', 'on', 'be', 'and', 'or',
    'my', 'our', 'with', 'if', 'have', 'has', 'need', 'long', 'much', 'many', 'safe', 'temp', 'temperature', 'rule', 'rules', 'cooked', 'cook',
    // Spanish question words
    'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'que', 'qué', 'cual', 'cuál', 'como', 'cómo', 'cuando', 'cuándo', 'donde', 'dónde',
    'es', 'son', 'se', 'en', 'a', 'al', 'y', 'o', 'por', 'para', 'con', 'si', 'debo', 'debe', 'puedo', 'puede', 'cuanto', 'cuánto', 'temperatura', 'regla', 'reglas', 'cocina', 'cocinar', 'cocinado',
    'hago', 'hacer', 'tengo', 'tiene', 'hay', 'esta', 'está', 'estoy', 'mi', 'me', 'lo', 'le', 'no', 'tiempo',
    'get', 'got', 'am', 'was', 'not', 'this', 'that', 'do', 'make', 'time',
]);

export function foldText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/đ/g, 'd');
}

// Both languages' plurals fold to one form, so "eggs" finds "egg" and "huevos" finds "huevo".
function stem(word) {
    if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
    if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
    return word;
}

export function tokenize(text) {
    return foldText(text).split(/[^a-z0-9]+/).filter(Boolean);
}

function queryWords(query) {
    const all = tokenize(query);
    const kept = all.filter((w) => !FILLER.has(w) && !FILLER.has(foldText(w)));
    // "how long" alone is all filler. Better to look for the words than say nothing.
    return (kept.length ? kept : all).map(stem);
}

function indexRule(rule, topic) {
    const fields = [
        { text: `${rule.titleEn} ${rule.titleEs}`, weight: 8 },
        { text: (rule.words || []).join(' '), weight: 6 },
        { text: `${topic.titleEn} ${topic.titleEs}`, weight: 2 },
        { text: `${rule.en} ${rule.es}`, weight: 3 },
        { text: `${rule.examEn || ''} ${rule.examEs || ''}`, weight: 1 },
    ];
    return fields.map((f) => ({ words: new Set(tokenize(f.text).map(stem)), weight: f.weight }));
}

let _cache = null;
function indexOf(topics) {
    if (_cache && _cache.topics === topics) return _cache.rows;
    const rows = [];
    for (const topic of topics) {
        for (const rule of topic.rules) rows.push({ rule, topic, fields: indexRule(rule, topic) });
    }
    _cache = { topics, rows };
    return rows;
}

const wordMatches = (set, word) => {
    if (set.has(word)) return true;
    if (word.length < 4) return false;
    for (const w of set) if (w.startsWith(word) || (w.length >= 4 && word.startsWith(w))) return true;
    return false;
};

/**
 * Best rules for a question, strongest first. Each result covers at least half
 * of the words that mattered, so an unrelated rule can't answer on one common
 * word. An empty list means "I don't know", and the screen has to say that.
 */
export function searchFoodSafety(topics, query, limit = 6) {
    const words = queryWords(query);
    if (!words.length) return [];
    const needed = Math.ceil(words.length / 2);
    const scored = [];
    for (const row of indexOf(topics)) {
        let score = 0;
        let hit = 0;
        for (const word of words) {
            let best = 0;
            for (const f of row.fields) if (f.weight > best && wordMatches(f.words, word)) best = f.weight;
            if (best) { hit += 1; score += best; }
        }
        if (hit >= needed) scored.push({ rule: row.rule, topic: row.topic, score: score + hit * 4 });
    }
    scored.sort((a, b) => b.score - a.score);
    // A clear answer shouldn't come with a list of weak, unrelated matches under it.
    const floor = scored.length ? scored[0].score * 0.85 : 0;
    return scored.filter((r) => r.score >= floor).slice(0, limit);
}
