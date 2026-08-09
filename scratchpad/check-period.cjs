const { initFirebase, getDb } = require('../src/config/firebase');
initFirebase(); const db = getDb();
(async () => {
  const doc = await db.collection('installmentPlans').doc('d42aa2de-4ec9-4a4d-a5a7-43f0dec1dd2c').get();
  const p2 = doc.data().installments.find(i => i.seq === 2);
  console.log(JSON.stringify(p2, null, 2));
  process.exit(0);
})();
