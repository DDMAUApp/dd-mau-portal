import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const sa = JSON.parse(readFileSync('firebase-service-account.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

// Pull recent audit entries, filter client-side for print.label so we
// don't need a composite index.
const snap = await db.collection('audit')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

const prints = [];
snap.forEach(doc => {
    if (doc.data().action === 'print.label' || doc.data().action === 'print.freetext') {
        prints.push({ id: doc.id, ...doc.data() });
    }
});

if (prints.length === 0) {
    console.log('No print.label / print.freetext entries found in the last 50 audit docs.');
    process.exit(0);
}

console.log(`Found ${prints.length} recent print attempts:\n`);
for (const p of prints.slice(0, 5)) {
    const t = p.createdAt?.toDate ? p.createdAt.toDate().toISOString() : '(no timestamp)';
    const transport = p.details?.transport ?? '(NO TRANSPORT FIELD — old code)';
    console.log(`────────────────────────────────────────────`);
    console.log(`time      : ${t}`);
    console.log(`action    : ${p.action}`);
    console.log(`actor     : ${p.actorName}`);
    console.log(`target    : ${p.targetId}`);
    console.log(`transport : ${transport}`);
    console.log(`printerOk : ${p.details?.printerOk ?? '?'}`);
    console.log(`source    : ${p.details?.source ?? '?'}`);
}
process.exit(0);
