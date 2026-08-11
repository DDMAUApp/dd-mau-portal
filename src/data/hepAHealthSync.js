// Onboarding → Health Department bridge (Andrew 2026-08-11: "when the
// hep A section is filled out, automatically add it to the health
// department page").
//
// Before this, the Hep A card a hire uploads during ONBOARDING and the
// HEALTH DEPARTMENT record (/health_records/{staffId}) were separate
// silos — approving the onboarding doc left the health roster empty
// until someone re-uploaded the same card there.
//
// Now, when an admin APPROVES the hep_a_record onboarding doc (or when
// an already-approved hire gets added to staff), we:
//   1. grab the newest card file(s) from onboarding/{hireId}/hep_a_record
//   2. run the Health Dept's own AI card reader on the photos
//      (extractHealthDoc → hepAShot1Date/hepAShot2Date)
//   3. merge into the staff member's health record via upsertHealthRecord
//      — a transaction, and dates NEVER overwrite ones already entered
//      by hand; the card file is attached (deduped by storage path).
//
// The join key is hire.staffRecordId (the numeric staff id) — the same
// id health_records docs are keyed by. Without it (hire not on staff
// yet) we return {ok:false, reason:'no_staff_record'} and the caller
// tells the admin the sync will happen at add-to-staff time.

import { storage } from '../firebase';
import { ref as sref, listAll, getDownloadURL, getMetadata } from 'firebase/storage';
import { upsertHealthRecord, extractHealthDoc } from './health';

export async function syncHepAFromOnboarding({ hire, byName }) {
    const staffId = hire?.staffRecordId;
    if (staffId == null || staffId === '') return { ok: false, reason: 'no_staff_record' };

    const folder = sref(storage, `onboarding/${hire.id}/hep_a_record`);
    const list = await listAll(folder);
    if (!list.items.length) return { ok: false, reason: 'no_files' };

    const metas = await Promise.all(list.items.map(async (it) => {
        let m = null;
        try { m = await getMetadata(it); } catch { /* keep going */ }
        return { it, path: it.fullPath, updated: m?.updated || '', contentType: m?.contentType || '' };
    }));
    metas.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    const withUrls = await Promise.all(metas.map(async (f) => ({ ...f, url: await getDownloadURL(f.it) })));

    // AI-read the shot dates from the newest photo(s). Best-effort — the
    // card still gets ATTACHED even when reading fails (PDF-only upload,
    // blurry photo, CF hiccup); the manager can type the dates in the
    // Health Dept as before.
    const images = withUrls.filter((f) => f.contentType.startsWith('image/')).slice(0, 2);
    let extract = null;
    if (images.length) {
        try { extract = await extractHealthDoc(images.map((f) => f.url)); }
        catch (e) { console.warn('hepA card AI read failed (attaching file anyway):', e?.message); }
    }

    let addedDates = 0;
    await upsertHealthRecord(staffId, hire.name, (rec) => {
        rec.hepA = { ...(rec.hepA || {}) };
        if (extract?.hepAShot1Date && !rec.hepA.shot1Date) { rec.hepA.shot1Date = extract.hepAShot1Date; addedDates++; }
        if (extract?.hepAShot2Date && !rec.hepA.shot2Date) { rec.hepA.shot2Date = extract.hepAShot2Date; addedDates++; }
        const files = Array.isArray(rec.files) ? [...rec.files] : [];
        const have = new Set(files.map((f) => f.path));
        for (const f of withUrls) {
            if (have.has(f.path)) continue;
            files.push({
                url: f.url,
                path: f.path,
                kind: 'hepA_card',
                label: 'Hep A card (from onboarding)',
                uploadedAt: new Date().toISOString(),
                uploadedBy: byName || '',
            });
        }
        rec.files = files;
        return rec;
    }, byName);
    return { ok: true, addedDates, files: withUrls.length, readOk: !!extract };
}
