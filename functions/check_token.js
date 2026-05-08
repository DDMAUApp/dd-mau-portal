const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'dd-mau-staff-app' });
admin.firestore().doc('config/staff').get().then(doc => {
    const list = (doc.data() || {}).list || [];
    const me = list.find(s => s.name === 'Andrew Shih');
    if (!me) { console.log('Andrew Shih not in staff list'); process.exit(0); }
    console.log('fcmTokens:', JSON.stringify(me.fcmTokens || 'NONE', null, 2));
    process.exit(0);
});
