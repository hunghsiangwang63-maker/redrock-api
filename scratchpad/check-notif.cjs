const { initFirebase, getDb } = require('../src/config/firebase');
initFirebase(); const db = getDb();
(async () => {
  const snap = await db.collection('notifications').where('type', '==', 'installment_upcoming').get();
  snap.docs.forEach(d => console.log(JSON.stringify({ id: d.id, ...d.data() }, null, 2)));
  process.exit(0);
})();
