// Client wrapper for the aiExtractMenu Cloud Function.
//
// Andrew 2026-05-20 — "if the menu comes in as pdf or jpeg how can
// you make edits". The Cloud Function takes a list of image URLs
// (uploaded to Firebase Storage via menuImageUpload.js), fetches
// each, sends them all to Claude with vision, and returns a
// structured menu JSON the admin can review + apply as overrides.
//
// Schema returned (matches MENU_DATA shape):
//   {
//     categories: [
//       {
//         category: "Bowls",
//         items: [
//           { nameEn, price, descEn, spicy, vegan, glutenFree, popular }
//         ]
//       }
//     ],
//     pageCount: number
//   }

import { getFunctions, httpsCallable } from 'firebase/functions';

let _callable = null;
function getCallable() {
    if (_callable) return _callable;
    const functions = getFunctions(undefined, 'us-central1');
    _callable = httpsCallable(functions, 'aiExtractMenu', { timeout: 120_000 });
    return _callable;
}

// Extract menu data from a list of image URLs already in Storage.
// Throws on Cloud Function errors so callers can toast the failure
// and keep the upload in place for retry.
export async function extractMenuFromImages({ imageUrls }) {
    const urls = (imageUrls || []).filter(u => typeof u === 'string' && /^https:\/\//.test(u));
    if (urls.length === 0) {
        throw new Error('no image URLs');
    }
    if (urls.length > 8) {
        throw new Error('too many pages (max 8)');
    }
    const callable = getCallable();
    const res = await callable({ imageUrls: urls });
    const data = res?.data || {};
    return {
        categories: Array.isArray(data.categories) ? data.categories : [],
        pageCount: Number(data.pageCount) || urls.length,
    };
}
