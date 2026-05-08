// Use the public Web SDK with Firebase config — works with default rules
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, query, orderBy, limit } = require('firebase/firestore');
const app = initializeApp({
    apiKey: "AIzaSyDTJccmQHzvbgwW_9_1aDDkAgK0B4PJfkQ",
    authDomain: "dd-mau-staff-app.firebaseapp.com",
    projectId: "dd-mau-staff-app",
});
const db = getFirestore(app);
(async () => {
    const q = query(collection(db, 'shifts'), orderBy('createdAt', 'desc'), limit(8));
    const snap = await getDocs(q);
    console.log(`Most recent ${snap.size} shifts:`);
    snap.forEach(d => {
        const v = d.data();
        const ts = v.createdAt?.toDate ? v.createdAt.toDate().toISOString() : '?';
        console.log(`  ${ts} | ${v.staffName} | ${v.date} ${v.startTime}-${v.endTime} | loc=${v.location} | published=${v.published} | createdBy=${v.createdBy}`);
    });
    process.exit(0);
})();
