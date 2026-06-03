// One-shot diagnostic: print every device that has registered an FCM
// token under Andrew's staff record. Use after re-enabling native FCM
// to confirm the iPhone's token landed in /config/staff.list[40].fcmTokens.
//
// Usage:
//   node scripts/check_andrew_fcm_token.mjs
//
// Output: one line per token entry with platform, deviceId prefix,
// nativeWrap flag, lastSeen timestamp, and the first 40 chars of the
// token itself (truncated for log hygiene).
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const sa = JSON.parse(readFileSync('./firebase-service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const snap = await db.doc('config/staff').get();
const list = (snap.data() || {}).list || [];
// Match Andrew by id=40 (admin anchor) — the name field can vary
// ("Andrew" vs "Andrew Shih") so go by ID per the convention in
// src/data/staff.js (ids 40/41 = owners).
const me = list.find(s => s.id === 40);

if (!me) {
    console.log('No staff record with id=40');
    console.log('Staff IDs present:', list.map(s => `${s.id}=${s.name}`).slice(0, 10).join(', '));
    process.exit(0);
}
console.log(`Checking tokens for id=40 name="${me.name}"`);
console.log('');

const tokens = Array.isArray(me.fcmTokens) ? me.fcmTokens : [];
console.log(`Andrew (id=${me.id}) has ${tokens.length} registered token(s):`);
console.log('');

if (tokens.length === 0) {
    console.log('  (none yet — wrapped app has not registered)');
    console.log('');
    console.log('  Expected after Phase 1+2 fix + iPhone build:');
    console.log('  - platform=ios, nativeWrap=true, deviceId=<random>');
    process.exit(0);
}

for (const [i, t] of tokens.entries()) {
    if (!t || typeof t !== 'object') {
        console.log(`  ${i + 1}. <malformed entry>`);
        continue;
    }
    const platform = t.platform || '?';
    const nativeWrap = t.nativeWrap ? 'native' : 'web';
    const deviceId = (t.deviceId || '').slice(0, 8);
    const lastSeen = t.lastSeen || '?';
    const tokenPrefix = (t.token || '').slice(0, 40);
    console.log(`  ${i + 1}. [${platform}/${nativeWrap}] deviceId=${deviceId}… lastSeen=${lastSeen}`);
    console.log(`     token=${tokenPrefix}…`);
}

console.log('');
console.log('Look for ios/native after rebuilding the wrapped app.');
process.exit(0);
