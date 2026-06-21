// One-shot: create a fake unread chat notification for Andrew so the
// home-tile badge has something to count. Delete it via the bell drawer
// or by re-running this script with --delete.
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const sa = JSON.parse(readFileSync('./firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const args = process.argv.slice(2);
if (args.includes('--delete')) {
    const snap = await db.collection('notifications')
        .where('forStaff', '==', 'Andrew Shih')
        .where('type', '==', 'chat_message')
        .where('title', '==', 'Test (badge probe)')
        .get();
    let n = 0;
    for (const d of snap.docs) { await d.ref.delete(); n++; }
    console.log(`Deleted ${n} test notif(s)`);
    process.exit(0);
}

const ref = await db.collection('notifications').add({
    forStaff: 'Andrew Shih',
    type: 'chat_message',
    title: 'Test (badge probe)',
    body: 'Synthetic unread chat notif for badge testing.',
    deepLink: 'chat',
    link: '/chat',
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
});
console.log('Created test notif id:', ref.id);
console.log('Refresh your home page on iPhone — red "1" should appear on the Chat tile within 2 sec.');
console.log('After verifying, run: node scripts/seed_test_chat_notif.mjs --delete');
process.exit(0);
