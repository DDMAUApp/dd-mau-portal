// One-shot probe: count Andrew's unread chat notifications so we
// can tell whether the home tile badge would show anything.
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const sa = JSON.parse(readFileSync('./firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const snap = await db.collection('notifications')
  .where('forStaff', '==', 'Andrew')
  .where('read', '==', false)
  .get();

const chatTypes = ['chat_message', 'chat_mention', 'chat_reply'];
let chatCount = 0;
const byType = {};

snap.forEach(d => {
  const t = d.data().type || 'unknown';
  byType[t] = (byType[t] || 0) + 1;
  if (chatTypes.includes(t)) chatCount++;
});

console.log(`Andrew unread notifications: ${snap.size} total`);
console.log(`Unread chat notifications (drives badge): ${chatCount}`);
console.log('By type:', byType);
process.exit(0);
