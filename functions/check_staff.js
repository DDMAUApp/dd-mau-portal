const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');
const app = initializeApp({
    apiKey: "AIzaSyDTJccmQHzvbgwW_9_1aDDkAgK0B4PJfkQ",
    authDomain: "dd-mau-staff-app.firebaseapp.com",
    projectId: "dd-mau-staff-app",
});
const db = getFirestore(app);
(async () => {
    const snap = await getDoc(doc(db, 'config', 'staff'));
    const list = (snap.data() || {}).list || [];
    console.log(`Staff total: ${list.length}`);
    console.log(`With scheduleSide explicit: ${list.filter(s => s.scheduleSide).length}`);
    console.log(`Untagged (no scheduleSide): ${list.filter(s => !s.scheduleSide).length}`);
    console.log('');
    console.log('Specific people from recent shifts:');
    for (const name of ['Brandon Green', 'Amelia Amelia', 'Andrew Shih']) {
        const s = list.find(p => p.name === name);
        if (!s) { console.log(`  ${name}: NOT FOUND`); continue; }
        console.log(`  ${name}: role=${s.role} loc=${s.location} scheduleSide=${s.scheduleSide || '(none — inferred)'}`);
    }
    process.exit(0);
})();
