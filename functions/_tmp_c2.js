const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('../firebase-service-account.json')) });
const db = admin.firestore();
(async () => {
  for (const id of ['20261123_yulissa-hurtado_elqnkl', '20261123_yulissa-hurtado_ind6d', '20261122_yulissa-hurtado_ind6d']) {
    const x = (await db.doc('rescued_writes/' + id).get()).data();
    console.log('==', id, x.at.toDate().toISOString(), x.appVersion, x.reason, 'queue', x.queue, 'stuck', x.stuckCount, 'drafts', JSON.stringify(x.draftKeys));
    console.log(x.summary);
    const p = JSON.parse(x.payload || '{}');
    for (const k of Object.keys(p.drafts || {})) console.log(' DRAFT', k, String(p.drafts[k]).length, 'chars');
  }
  process.exit(0);
})();
