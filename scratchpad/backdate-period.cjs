const { initFirebase, getDb } = require('../src/config/firebase');
initFirebase(); const db = getDb();
const dayjs = require('dayjs');

(async () => {
  const planId = process.argv[2];
  const seq = parseInt(process.argv[3]);
  const newDueDate = process.argv[4]; // YYYY-MM-DD
  const ref = db.collection('installmentPlans').doc(planId);
  const doc = await ref.get();
  const plan = doc.data();
  const installments = plan.installments.map(i => i.seq === seq ? { ...i, dueDate: newDueDate } : i);
  await ref.update({ installments });
  console.log(`period ${seq} dueDate -> ${newDueDate}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
