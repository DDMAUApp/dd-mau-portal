// Documents tab: each staff member's own onboarding papers.
//
// Privacy rule: a person reaches a hire record only through a link the owner
// confirmed, stored on the hire as documentsLink { staffId, staffName }. Names are
// never used to find a record, only to suggest pairs for the owner to confirm. When
// anything about the link is off, the answer is "no documents", never a best guess.
import { DOC_STATUS } from './onboarding';

export const normName = (v) => String(v || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

// Why a link does or doesn't hold for this person. Staff ids get reused when the
// newest person is removed, so the name confirmed with the link must still match.
export function linkHolds(hire, staff) {
    const link = hire?.documentsLink;
    if (!link || !staff || staff.id === undefined || staff.id === null) return false;
    if (String(link.staffId) !== String(staff.id)) return false;
    return !!normName(staff.name) && normName(link.staffName) === normName(staff.name);
}

// The one record this person may see, or null. Two records claiming one person is
// a mistake to fix, so it shows neither.
export function pickLinkedHire(hires, staff) {
    const held = (Array.isArray(hires) ? hires : []).filter(h => linkHolds(h, staff));
    return held.length === 1 ? held[0] : null;
}

// Refuses any file outside this person's own folder, whatever asked for it.
export function isOwnFilePath(path, hireId) {
    if (!hireId || typeof path !== 'string') return false;
    return path.startsWith(`onboarding/${hireId}/`) && !path.includes('..');
}

// The words on every older version, in the watermark and in the lists.
export function olderVersionLines(replacedAt, isEs) {
    const when = replacedAt ? new Date(replacedAt).toLocaleDateString(isEs ? 'es-US' : 'en-US', { timeZone: 'America/Chicago' }) : '';
    return isEs
        ? ['VERSIÓN ANTERIOR', when ? `Reemplazada el ${when}` : '']
        : ['OLDER VERSION', when ? `Replaced ${when}` : ''];
}
export const olderVersionLabel = (replacedAt, isEs) => olderVersionLines(replacedAt, isEs).filter(Boolean).join(' · ');

// ── Versions ────────────────────────────────────────────────────────────────
function parseFile(name) {
    const single = /^(filled|complete|signed)_(\d+)\.pdf$/i.exec(name);
    if (single) return { name, line: single[1].toLowerCase(), ts: Number(single[2]) };
    const upload = /(?:^|_)(\d{13})_\d+_/.exec(name);
    return { name, line: 'upload', ts: upload ? Number(upload[1]) : 0 };
}

// Newest first. A filled or signed form is replaced by the next one. An employer-
// completed copy is replaced once the person submits again, since it was drawn on
// the earlier one. Uploads can legitimately be several files (ID front and back), so
// only an explicit update marks them older (replacedBefore, set on the checklist
// entry when someone updates from the Documents tab).
export function classifyDocFiles(names, { replacedBefore = 0 } = {}) {
    const files = (Array.isArray(names) ? names : [])
        .filter(n => typeof n === 'string' && n).map(parseFile);
    const own = files.filter(f => f.line === 'filled' || f.line === 'signed').sort((a, b) => a.ts - b.ts);
    const nextOwnAfter = (ts) => own.find(f => f.ts > ts)?.ts || 0;
    const employer = files.filter(f => f.line === 'complete').sort((a, b) => a.ts - b.ts);

    return files.map((f) => {
        let replacedAt = 0;
        if (f.line === 'upload') {
            if (replacedBefore && f.ts && f.ts < replacedBefore) replacedAt = replacedBefore;
        } else if (f.line === 'complete') {
            const nextEmployer = employer.find(e => e.ts > f.ts)?.ts || 0;
            const nextOwn = nextOwnAfter(f.ts);
            replacedAt = [nextEmployer, nextOwn].filter(Boolean).sort((a, b) => a - b)[0] || 0;
        } else {
            replacedAt = nextOwnAfter(f.ts);
        }
        return { name: f.name, ts: f.ts, line: f.line, older: replacedAt > 0, replacedAt };
    }).sort((a, b) => (a.older === b.older ? b.ts - a.ts : a.older ? 1 : -1));
}

// Signed agreements stay as signed. Everything else can be redone, and anything not
// yet handed in can be finished here.
export function canUpdateDoc(docDef, status) {
    const handedIn = status === DOC_STATUS.SUBMITTED || status === DOC_STATUS.APPROVED;
    if (!handedIn) return true;
    return docDef.kind !== 'offer_letter' && docDef.kind !== 'acknowledgment';
}

// Does handing this in replace something already handed in?
export const hasEarlierVersion = (entry) => {
    const s = entry?.status;
    return s === DOC_STATUS.SUBMITTED || s === DOC_STATUS.APPROVED || s === DOC_STATUS.REJECTED || !!entry?.submittedAt;
};

// Uploads can be several pages, so adding a page and replacing are different things.
export const isUploadDoc = (docDef) => docDef.kind === 'id' || docDef.kind === 'file';

// What an update writes, field by field: the submit screens write their own fields
// on this entry (the file's hash, the saved answers), and those must survive. A new
// submission voids the employer section drawn on the old one, as in the portal.
export function resubmitPatch(docId, deleteMark, { extra = {}, replacedBefore = 0, replacing = false, now = new Date() } = {}) {
    const at = `checklist.${docId}`;
    const patch = {
        [`${at}.status`]: DOC_STATUS.SUBMITTED,
        [`${at}.submittedAt`]: now.toISOString(),
        [`${at}.employerCompletedAt`]: deleteMark,
        [`${at}.employerCompletedBy`]: deleteMark,
        [`${at}.employerPdfHash`]: deleteMark,
        [`${at}.employerPdfPath`]: deleteMark,
    };
    if (replacedBefore) patch[`${at}.replacedBefore`] = replacedBefore;
    if (replacing) patch[`${at}.resubmittedAt`] = now.toISOString();
    Object.entries(extra).forEach(([k, v]) => { patch[`${at}.${k}`] = v; });
    return patch;
}

// Completed and archived hires drop out of the manager's active list, so an update
// from someone already on staff needs its own way to get noticed.
export function docsWaitingReview(hire) {
    return Object.entries(hire?.checklist || {})
        .filter(([, e]) => e?.status === DOC_STATUS.SUBMITTED && e?.resubmittedAt)
        .map(([id]) => id);
}

// ── Password ────────────────────────────────────────────────────────────────
// This is the password they made when they started onboarding (hire.portalAuth).
// Without one, only a manager's say-so lets them make one, or anyone with their PIN
// could set it and walk in.
export const PASSWORD_SETUP_MS = 24 * 3600e3;

export function passwordMode(hire, nowMs = Date.now()) {
    if (hire?.portalAuth?.hash) return 'enter';
    const until = Date.parse(hire?.documentsPasswordSetUntil || '') || 0;
    return until > nowMs ? 'create' : 'ask-manager';
}

export const MAX_PASSWORD_TRIES = 5;
export const PASSWORD_WAIT_MS = 5 * 60e3;

export function nextTryState(state, wrong, nowMs = Date.now()) {
    if (!wrong) return { tries: 0, waitUntil: 0 };
    const tries = (state?.tries || 0) + 1;
    return tries >= MAX_PASSWORD_TRIES
        ? { tries: 0, waitUntil: nowMs + PASSWORD_WAIT_MS }
        : { tries, waitUntil: 0 };
}

// ── Suggestions for the owner's match list ──────────────────────────────────
// Strongest first. These are only ever suggestions; nothing links until confirmed.
export function suggestHire(staff, hires) {
    // A record confirmed for someone else is never offered.
    const rows = (Array.isArray(hires) ? hires : [])
        .filter(h => !h.documentsLink || String(h.documentsLink.staffId) === String(staff?.id));
    const byStaffLink = rows.find(h => h.id === staff?.onboardingHireId);
    if (byStaffLink) return { hire: byStaffLink, why: 'staff' };
    const name = normName(staff?.name);
    if (!name) return null;
    const live = (list) => list.find(h => h.status !== 'archived') || list[0];
    const byName = rows.filter(h => normName(h.personal?.legalName) === name || normName(h.name) === name);
    if (byName.length) return { hire: live(byName), why: 'name', several: byName.length > 1 };
    return null;
}
