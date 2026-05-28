#!/usr/bin/env node
// One-off diagnostic — answer "is SMS actually working?" by checking
// (1) the /config/sms global enable, (2) per-staff opt-in state,
// and (3) the most recent /sms_delivery_logs rows.
//
// Doesn't write anything. Safe to re-run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const credPath = path.join(__dirname, '..', 'firebase-service-account.json');
const { default: serviceAccount } = await import(credPath, { with: { type: 'json' } });
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// 1) /config/sms — global enable / test-mode / settings.
const cfgSnap = await db.doc('config/sms').get();
console.log('=== /config/sms global ===');
if (!cfgSnap.exists) {
    console.log('  (doc does not exist — defaults apply: enabled=true, testMode=false)');
} else {
    const c = cfgSnap.data();
    console.log(`  enabled:   ${c.enabled !== false ? 'YES (default true)' : 'NO  ⚠️  GLOBAL OFF'}`);
    console.log(`  testMode:  ${c.testMode === true ? 'YES ⚠️  owners only' : 'no'}`);
    console.log(`  raw:`, JSON.stringify(c, null, 2));
}

// 2) Staff SMS readiness.
const staffSnap = await db.doc('config/staff').get();
const list = staffSnap.data()?.list || [];
const active = list.filter(s => s && s.name && s.active !== false);
let withPhone = 0, optedIn = 0, stopped = 0, ready = 0;
const breakdown = [];
for (const s of active) {
    const hasPhone = !!s.phoneE164;
    const isOptedIn = s.smsOptIn === true;
    const isStopped = s.smsStopped === true;
    if (hasPhone) withPhone++;
    if (isOptedIn) optedIn++;
    if (isStopped) stopped++;
    if (hasPhone && isOptedIn && !isStopped) ready++;
    breakdown.push({
        name: s.name,
        phone: s.phoneE164 || '(none)',
        optIn: isOptedIn ? '✓' : '✗',
        stopped: isStopped ? 'STOPPED' : '',
        ready: hasPhone && isOptedIn && !isStopped,
    });
}
console.log(`\n=== Staff SMS readiness (${active.length} active) ===`);
console.log(`  with phone:    ${withPhone}/${active.length}`);
console.log(`  opted in:      ${optedIn}/${active.length}`);
console.log(`  STOPPED:       ${stopped}/${active.length}`);
console.log(`  ready to SMS:  ${ready}/${active.length}\n`);
breakdown
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name))
    .forEach(b => {
        const tag = b.ready ? '✓ READY' : '✗      ';
        console.log(`  ${tag}  ${b.name.padEnd(24)} ${b.phone.padEnd(16)} optIn:${b.optIn} ${b.stopped}`);
    });

// 3) Recent /sms_delivery_logs.
const logsSnap = await db.collection('sms_delivery_logs')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
console.log(`\n=== Recent SMS sends (last 20) ===`);
if (logsSnap.empty) {
    console.log('  (no SMS delivery rows yet)');
} else {
    const byStatus = {};
    let mostRecentMs = 0;
    for (const d of logsSnap.docs) {
        const r = d.data();
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        const ms = r.createdAt?.toMillis?.() || 0;
        if (ms > mostRecentMs) mostRecentMs = ms;
    }
    const daysAgo = mostRecentMs ? Math.floor((Date.now() - mostRecentMs) / 86400000) : null;
    console.log(`  total in batch:      ${logsSnap.size}`);
    console.log(`  most recent:         ${mostRecentMs ? new Date(mostRecentMs).toISOString() : '?'} (${daysAgo}d ago)`);
    console.log(`  status breakdown:    ${JSON.stringify(byStatus)}`);
    console.log(`\n  --- most recent 5 rows ---`);
    for (const d of logsSnap.docs.slice(0, 5)) {
        const r = d.data();
        const at = r.createdAt?.toDate?.()?.toISOString() ?? '?';
        const delivered = r.deliveredAt?.toDate?.()?.toISOString() ?? '(not delivered)';
        console.log(`  [${at.slice(0,16)}] ${r.forStaff} · ${r.type} · status=${r.status} · sid=${(r.twilioSid || '').slice(0,12)}... · delivered=${delivered.slice(0,16)}`);
        if (r.errorMessage) console.log(`     error: ${r.errorMessage}`);
    }
}

// 4) Twilio secrets present?
console.log(`\n=== Twilio secrets (Firebase) ===`);
console.log(`  Can't read secret values from a script, but you can check with:`);
console.log(`    firebase functions:secrets:access TWILIO_ACCOUNT_SID`);
console.log(`    firebase functions:secrets:access TWILIO_AUTH_TOKEN`);
console.log(`    firebase functions:secrets:access TWILIO_FROM_NUMBER`);

process.exit(0);
