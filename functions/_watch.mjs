import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
const sa = JSON.parse(readFileSync('/Users/andrewshih/Developer/dd-mau-portal/firebase-service-account.json','utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const t = () => new Date().toISOString().slice(11,19);
console.log(`[${t()}] watching health_import_jobs (45 min)…`);
db.collection('health_import_jobs').onSnapshot((snap) => {
  snap.docChanges().forEach((c) => {
    const d = c.doc.data() || {};
    console.log(`[${t()}] ${c.type.toUpperCase()} ${c.doc.id} status=${d.status}${d.status==='done'?(' → '+(d.result?.docType||'?')):''}${d.status==='error'?(' → '+d.error):''}`);
  });
}, (e) => console.log(`[${t()}] listen error: ${e.message}`));
setTimeout(() => { console.log(`[${t()}] stopping`); process.exit(0); }, 2700000);
