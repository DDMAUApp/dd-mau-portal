#!/usr/bin/env node
// set-foh-tasks.mjs — replaces the FOH side of the daily task list at
// both ops/checklists2_webster and ops/checklists2_maryland with a fresh
// set Andrew dictated 2026-05-21.
//
// Behavior:
//   • Replaces customTasks.FOH.all entirely
//   • Preserves customTasks.BOH untouched
//   • Preserves every other field on the doc (checks, assignments,
//     lists, date, version)
//   • Bumps updatedAt to NOW
//
// One-shot. Safe to re-run — the task list is deterministic, so a
// repeat run produces the same content with new random ids. Existing
// `checks` (today's completion state) are preserved, but they're keyed
// by task id so they won't match the new ids — staff will see a fresh
// unchecked list, which is the intent of "start fresh".
//
// Run: node scripts/set-foh-tasks.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');
const serviceAcct = JSON.parse(
    readFileSync(path.join(repoRoot, 'firebase-service-account.json'), 'utf8')
);

initializeApp({ credential: cert(serviceAcct) });
const db = getFirestore();

// Stable id generator that mirrors the Operations.jsx pattern
// (sidePrefix + "_" + base36 timestamp + random). Different from
// the live one only in that we use a counter to keep them sorted.
let counter = 0;
function newTaskId() {
    counter += 1;
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 7);
    return `FOH_${ts}${counter}_${rnd}`;
}
function newSubtaskId() {
    return `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// The 32 tasks Andrew dictated. Order matters — it's the display order
// in the FOH checklist. category values must match TASK_CATEGORIES in
// Operations.jsx (cleaning / foodsafety / cash / inventory / prep /
// drinks / other).
const FOH_TASKS_SPEC = [
    { task: 'Brief team and assign opening duties', category: 'other' },
    { task: 'Count opening drawer — verify $300 start', category: 'cash' },
    { task: 'Verify change & bill supply — request a fill if short', category: 'cash' },
    { task: 'Walk all FOH stations — stocked, clean, ready for service', category: 'other' },
    { task: 'Tidy POS area — clean and presentable from guest view', category: 'cleaning' },
    { task: 'Confirm all FOH staff clocked in on time', category: 'other' },
    { task: 'Patio ready — wipe tables, set chairs, umbrellas up', category: 'cleaning' },
    { task: 'Dumpster gate closed and locked', category: 'foodsafety' },
    { task: 'All dining-room lights on', category: 'other' },
    { task: 'Music on — upbeat pop, background-level volume', category: 'other' },
    { task: 'Post station assignments and break schedule', category: 'other' },
    { task: "Note supplies we're out of / need to pick up today", category: 'inventory' },
    { task: 'Review 86 list with BOH — restock what is possible', category: 'inventory' },
    { task: 'Pre-rush — BOH cleanliness check', category: 'cleaning' },
    { task: 'Pre-rush — food safety walk-through', category: 'foodsafety' },
    { task: 'Rush — keep team paced, monitor ticket times', category: 'other' },
    { task: 'Post-rush — restock all FOH stations', category: 'other' },
    { task: 'Check sauce levels — top off where low', category: 'prep' },
    { task: 'Confirm break coverage — no station left unmanned', category: 'other' },
    { task: 'Assign dinner shift positions ahead of arrival', category: 'other' },
    { task: 'Confirm dinner shift staff clocked in on time', category: 'other' },
    { task: 'Assign side-work tasks for pre-dinner-rush prep', category: 'other' },
    { task: 'Dining room reset between shifts — tables, chairs, condiments, floor', category: 'cleaning' },
    {
        task: 'Bathroom checks (4× daily)',
        category: 'cleaning',
        subtasks: [
            { task: 'Opening check (early morning)' },
            { task: 'Mid-morning check (before lunch rush)' },
            { task: 'Mid-evening check (before dinner rush)' },
            { task: 'Closing check (end of night)' },
        ],
    },
    { task: 'Dinner rush — monitor guest experience (table touches, refills, prompt service)', category: 'other' },
    { task: 'Assign closing duties (around 7:45pm)', category: 'other' },
    { task: 'Cue cashiers when to stop taking new orders', category: 'other' },
    { task: 'Station someone at the door to greet / handle late arrivals', category: 'other' },
    { task: 'Walk closing checks — verify each task done, fix anything wrong', category: 'other' },
    { task: 'Count closing drawer', category: 'cash' },
    { task: 'Lock all 5 doors (2 front · 2 side · 1 back)', category: 'foodsafety' },
    {
        task: 'End-of-night power checks',
        category: 'foodsafety',
        subtasks: [
            { task: 'Drink fridges still ON (food safety!)' },
            { task: 'Lights OFF' },
            { task: 'Water OFF' },
            { task: 'Water heater OFF' },
            { task: 'TVs OFF' },
        ],
    },
];

// Materialize into the on-wire shape with fresh ids. category "other"
// is the default and is omitted from the doc (matches Operations.jsx
// behavior in addChecklistTask which only writes category when != "other").
function materializeTasks() {
    return FOH_TASKS_SPEC.map((spec) => {
        const item = { id: newTaskId(), task: spec.task };
        if (spec.category && spec.category !== 'other') item.category = spec.category;
        if (spec.subtasks && spec.subtasks.length > 0) {
            item.subtasks = spec.subtasks.map((s) => ({ id: newSubtaskId(), task: s.task }));
        }
        return item;
    });
}

async function applyToLocation(loc) {
    const ref = db.collection('ops').doc(`checklists2_${loc}`);
    const snap = await ref.get();
    if (!snap.exists) {
        console.log(`[${loc}] doc doesn't exist yet — creating with minimal scaffolding + new FOH tasks`);
        await ref.set({
            customTasks: {
                FOH: { all: materializeTasks() },
                BOH: { all: [] },
            },
            checks: {},
            date: new Date().toISOString().slice(0, 10),
            updatedAt: new Date().toISOString(),
            version: 2,
        });
        return;
    }

    const data = snap.data() || {};
    const existing = data.customTasks || {};
    const existingFohCount = ((existing.FOH || {}).all || []).length;
    const existingBohCount = ((existing.BOH || {}).all || []).length;

    const newTasks = materializeTasks();
    const merged = {
        ...existing,
        FOH: { ...(existing.FOH || {}), all: newTasks },
        // BOH stays exactly as it was.
        BOH: existing.BOH || { all: [] },
    };

    await ref.update({
        customTasks: merged,
        updatedAt: new Date().toISOString(),
    });

    console.log(`[${loc}] FOH tasks: ${existingFohCount} → ${newTasks.length}`);
    console.log(`[${loc}] BOH tasks: ${existingBohCount} (unchanged)`);
}

async function main() {
    console.log('Replacing FOH task lists at ops/checklists2_{webster,maryland}\n');
    for (const loc of ['webster', 'maryland']) {
        try {
            await applyToLocation(loc);
        } catch (e) {
            console.error(`[${loc}] FAILED:`, e.message);
            throw e;
        }
    }
    console.log('\n✓ Done. Open Operations on each location to verify.');
    process.exit(0);
}

main().catch((e) => {
    console.error('Script failed:', e);
    process.exit(1);
});
