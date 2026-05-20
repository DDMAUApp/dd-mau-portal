// Build-sheet overrides — admin-editable layer on top of the static
// src/data/buildSheet.js source.
//
// Andrew 2026-05-20 — "add a edit button that just admin can change
// to all the items".
//
// Design:
//   • Static buildSheet.js stays the canonical default (cashier
//     training reference; not editable from the app).
//   • Admins edit via the BuildEditorModal -> writes to
//     /build_overrides/{menuItemSlug}.
//   • When DateStickerPrinter renders a menu item, it merges the
//     override on top of the static result. If an override doc
//     exists for that menuItemSlug, its components fully REPLACE
//     the static list (simpler than diff/merge; admin has full
//     control, can copy-paste static items if they want them).
//
// Schema: /build_overrides/{menuItemSlug} =
//   {
//     menuItemSlug: 'salmon-bowl',
//     menuItemName: 'Salmon Bowl',           // denormalized for audit
//     components: [{
//       id:        string,                    // stable per row
//       kind:      'base'|'topping'|'protein'|'sauce'|'broth'|'side'|'garnish'|'note',
//       nameEn:    string,
//       nameEs:    string,
//       descEn?:   string,
//       descEs?:   string,
//     }],
//     updatedAt:  serverTimestamp,
//     updatedBy:  string,
//   }
//
// Audit: every save / delete writes a row to /audit via recordAudit.
// Restore-to-default = delete the override doc.

import { db } from '../firebase';
import {
    doc, collection, getDoc, setDoc, deleteDoc, onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { recordAudit } from './audit';

// Live subscription to ALL overrides. Returns a Map<menuItemSlug,
// override>. Cheap — there are at most ~50 overrides; even with 200
// menu items each being customized, the doc count stays small.
export function subscribeAllBuildOverrides(cb) {
    return onSnapshot(collection(db, 'build_overrides'), (snap) => {
        const map = new Map();
        snap.forEach(d => {
            map.set(d.id, { id: d.id, ...d.data() });
        });
        cb(map);
    }, (err) => {
        console.warn('subscribeAllBuildOverrides failed:', err);
        cb(new Map());
    });
}

// One-shot read for the editor.
export async function getBuildOverride(menuItemSlug) {
    if (!menuItemSlug) return null;
    try {
        const snap = await getDoc(doc(db, 'build_overrides', menuItemSlug));
        if (!snap.exists()) return null;
        return { id: snap.id, ...snap.data() };
    } catch (e) {
        console.warn('getBuildOverride failed:', e);
        return null;
    }
}

// Save (or replace) an override. Caller passes the full components
// list; we don't try to merge partials.
export async function saveBuildOverride({
    menuItemSlug, menuItemName, components,
    shelfLifeDays,   // 2026-05-20 — optional smart default for prints
    notes,           // optional editable notes (replaces static cashier notes)
    byName,
}) {
    if (!menuItemSlug) throw new Error('menuItemSlug required');
    if (!Array.isArray(components)) throw new Error('components must be an array');
    const cleaned = components.map((c, idx) => sanitizeComponent(c, idx));
    const cleanShelf = Number.isFinite(Number(shelfLifeDays)) && Number(shelfLifeDays) > 0
        ? Math.min(60, Math.floor(Number(shelfLifeDays)))
        : null;
    const cleanNotes = Array.isArray(notes)
        ? notes
            .map(n => ({
                en: String(n?.en || '').slice(0, 240).trim(),
                es: String(n?.es || n?.en || '').slice(0, 240).trim(),
            }))
            .filter(n => n.en)
        : [];
    await setDoc(doc(db, 'build_overrides', menuItemSlug), {
        menuItemSlug,
        menuItemName: String(menuItemName || menuItemSlug).slice(0, 120),
        components: cleaned,
        ...(cleanShelf ? { shelfLifeDays: cleanShelf } : {}),
        notes: cleanNotes,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    }, { merge: false });
    recordAudit({
        action: 'build_override.save',
        actorName: byName || 'admin',
        targetType: 'build_override',
        targetId: menuItemSlug,
        details: {
            menuItemName,
            componentCount: cleaned.length,
            shelfLifeDays: cleanShelf,
            noteCount: cleanNotes.length,
        },
    });
}

// Delete = restore-to-default. Caller is admin (gate in UI).
export async function deleteBuildOverride({ menuItemSlug, menuItemName, byName }) {
    if (!menuItemSlug) throw new Error('menuItemSlug required');
    await deleteDoc(doc(db, 'build_overrides', menuItemSlug));
    recordAudit({
        action: 'build_override.delete',
        actorName: byName || 'admin',
        targetType: 'build_override',
        targetId: menuItemSlug,
        details: { menuItemName },
    });
}

// Apply an override to a static build result. Returns a new build
// object with the override's components in place. Notes from the
// static build are preserved unless the override explicitly carries
// them — admins usually don't want to manage the cashier-training
// note text, just the printable components.
//
// When `override` is null/undefined, returns the static build unchanged.
export function applyBuildOverride(staticBuild, override) {
    if (!staticBuild) return staticBuild;
    if (!override) return staticBuild;
    const hasComps = Array.isArray(override.components) && override.components.length > 0;
    const hasNotes = Array.isArray(override.notes) && override.notes.length > 0;
    if (!hasComps && !hasNotes && !override.shelfLifeDays) return staticBuild;

    // Components: override list replaces the static list when provided.
    let components = staticBuild.components || [];
    if (hasComps) {
        const staticNotes = (staticBuild.components || []).filter(c => c.kind === 'note');
        // Admin-edited notes replace static notes; if no notes
        // override, keep the static cashier guidance.
        const noteComps = hasNotes
            ? override.notes.map((n, i) => ({
                id: `note-override-${i}`,
                kind: 'note',
                nameEn: n.en,
                nameEs: n.es,
            }))
            : staticNotes;
        components = [...override.components, ...noteComps];
    } else if (hasNotes) {
        // Components stay static, but notes replaced.
        const printable = (staticBuild.components || []).filter(c => c.kind !== 'note');
        const noteComps = override.notes.map((n, i) => ({
            id: `note-override-${i}`,
            kind: 'note',
            nameEn: n.en,
            nameEs: n.es,
        }));
        components = [...printable, ...noteComps];
    }

    return {
        ...staticBuild,
        components,
        shelfLifeDays: override.shelfLifeDays || staticBuild.shelfLifeDays || null,
        isCustomized: true,
        customizedAt: override.updatedAt,
        customizedBy: override.updatedBy,
    };
}

// Sanitize a single component before write. Trims + caps field
// lengths + ensures required fields exist. Bad inputs get coerced
// rather than rejected — easier for admins than throwing on save.
function sanitizeComponent(c, idx) {
    const allowedKinds = ['base', 'topping', 'protein', 'sauce', 'broth', 'side', 'garnish', 'note'];
    const kind = allowedKinds.includes(c.kind) ? c.kind : 'side';
    const nameEn = String(c.nameEn || '').slice(0, 120).trim();
    const nameEs = String(c.nameEs || '').slice(0, 120).trim() || nameEn;
    const out = {
        id: String(c.id || `c-${idx}-${Date.now().toString(36)}`).slice(0, 64),
        kind,
        nameEn,
        nameEs,
    };
    if (c.descEn) out.descEn = String(c.descEn).slice(0, 200);
    if (c.descEs) out.descEs = String(c.descEs).slice(0, 200);
    return out;
}
