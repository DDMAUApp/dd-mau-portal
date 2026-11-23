const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('../firebase-service-account.json')) });
const db = admin.firestore();
const ct = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Chicago' });
(async () => {
  const since = Date.now() - 6 * 3600e3;
  const co = await db.collection('cateringOrders').get();
  console.log('cateringOrders', co.size);
  co.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => String(o.createdAt || o.submittedAt || '').slice(0, 10) >= '2026-11-22').forEach(o => console.log(' recent', o.id, o.createdAt, o.createdBy || o.staffName, o.customer && o.customer.name));
  const el = await db.collection('error_logs').where('occurredAt', '>=', since).get();
  console.log('error_logs last 6h', el.size);
  el.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.occurredAt - b.occurredAt).forEach(e => {
    if (/yulissa/i.test(e.userName || '') || /cater/i.test(JSON.stringify([e.feature, e.errorMessage, e.pageUrl, e.recentActions]))) console.log(' ', ct(e.occurredAt), e.userName, e.appVersion, e.feature, '|', e.errorName, '|', String(e.errorMessage).slice(0, 300), '| dev', String(e.device && (e.device.deviceId || e.device.id) || JSON.stringify(e.device)).slice(0, 80));
  });
  const rw = await db.collection('rescued_writes').get();
  rw.docs.filter(d => d.id >= '20261122').forEach(d => { const x = d.data(); console.log(' rescue', d.id, x.staffName, x.queue, x.stuckCount, x.deviceId, String(x.summary).slice(0, 300)); });
  const cfg = await db.doc('config/catering').get(); console.log('config/catering', JSON.stringify(cfg.data()).slice(0, 1500));
  process.exit(0);
})();
