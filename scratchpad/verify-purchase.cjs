const { initFirebase, getDb } = require('../src/config/firebase');
initFirebase(); const db = getDb();

(async () => {
  const memberId = '85229a45-1895-45ef-9805-22e1dac91cbe';

  const passSnap = await db.collection('memberPasses').where('memberId', '==', memberId).get();
  console.log('=== memberPass ===');
  let planId = null;
  passSnap.docs.forEach(d => {
    const p = d.data();
    console.log(JSON.stringify({ id: d.id, startDate: p.startDate, endDate: p.endDate, status: p.status, installmentPlanId: p.installmentPlanId }, null, 2));
    planId = p.installmentPlanId;
  });

  console.log('\n=== installmentPlan ===');
  const planDoc = await db.collection('installmentPlans').doc(planId).get();
  console.log(JSON.stringify({ id: planDoc.id, ...planDoc.data() }, null, 2));

  console.log('\n=== transactions ===');
  const txSnap = await db.collection('transactions').where('memberId', '==', memberId).get();
  txSnap.docs.forEach(d => console.log(JSON.stringify({ id: d.id, ...d.data() }, null, 2)));

  console.log('\nplanId:', planId);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
