// Kept apart from staffDocuments.js because the home screen and menu need it on every
// load, and the rest of the Documents code shouldn't load until someone opens the tab.
// Owner-only until the owner has confirmed the match list and tried it.
export const DOCUMENTS_OPEN_TO_ALL = false;

export function canSeeDocuments(isAdminUser) {
    return DOCUMENTS_OPEN_TO_ALL || isAdminUser === true;
}
