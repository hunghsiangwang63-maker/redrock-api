const { initFirebase, getDb } = require('../src/config/firebase');
initFirebase(); const db = getDb();
(async () => {
  await db.collection('members').doc('85229a45-1895-45ef-9805-22e1dac91cbe').update({ email: 'installment-demo-test@example.com' });
  console.log('email added');
  process.exit(0);
})();
