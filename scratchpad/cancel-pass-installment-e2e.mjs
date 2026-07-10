import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;
const sumRev = async (relatedId) => {
  const tx = await db.collection('transactions').where('relatedId','==',relatedId).get();
  let net=0; const rows=[];
  tx.docs.forEach(d=>{const t=d.data(); if(['pass','checkin','refund'].includes(t.type)){net+=t.totalAmount||0; rows.push(`${t.type}:${t.totalAmount}`);}});
  return { net, rows, docs: tx.docs };
};
const cancel = async (token, checkInId) => {
  const r = await fetch(`${API}/checkin/cancel`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({checkInId,force:true})});
  return { status:r.status, body: await r.json() };
};

(async()=>{
  const token = await login();
  const now = new Date();
  const cleanup = [];

  // ═══ Test A: buy_pass 分期取消 ═══
  console.log('\n─── A. buy_pass 分期入場取消 ───');
  const passA = 'e2e-pass-A-'+Date.now();
  const planA = 'e2e-plan-A-'+Date.now();
  const ciA   = 'e2e-ci-A-'+Date.now();
  await db.collection('installmentPlans').doc(planA).set({
    id:planA, memberId:'member-001', memberName:'林怡君', gymId:'gym-hsinchu',
    relatedType:'pass', relatedId:passA, itemName:'半年票', status:'active', recognitionDate:null,
    installments:[
      {seq:1, amount:2534, status:'paid', paymentMethod:'cash', paidAt:now},
      {seq:2, amount:2533, status:'pending'},
      {seq:3, amount:2533, status:'pending'},
    ], createdAt:now, updatedAt:now,
  });
  const txA = await db.collection('transactions').add({
    gymId:'gym-hsinchu', type:'pass', totalAmount:2534, paymentMethod:'cash',
    memberId:'member-001', memberName:'林怡君', relatedId:passA,
    paymentStatus:'completed', recognitionDate:now, paidAt:now, createdAt:now, notes:'分期-半年票（第1/3期）',
  });
  await db.collection('memberPasses').doc(passA).set({
    id:passA, memberId:'member-001', gymId:'gym-hsinchu', passTypeName:'半年票',
    paymentId:ciA, installmentPlanId:planA, status:'active', createdAt:now, updatedAt:now,
  });
  await db.collection('checkIns').doc(ciA).set({
    id:ciA, memberId:'member-001', memberName:'林怡君', gymId:'gym-hsinchu',
    entryType:'buy_pass', buyPassTypeId:'x', paymentPlan:'installment',
    amountPaid:0, paymentMethod:'cash', isCancelled:false, checkedInAt:now, createdAt:now,
  });
  cleanup.push(['installmentPlans',planA],['memberPasses',passA],['checkIns',ciA]);
  const revA0 = await sumRev(passA);
  console.log('  取消前 passA 營收:', revA0.rows.join(' '), '淨', revA0.net);
  const cA = await cancel(token, ciA);
  ok(cA.status===200, `cancel → 200（實得 ${cA.status} ${cA.body.message||cA.body.error||''}）`);
  ok((await db.collection('memberPasses').doc(passA).get()).data()?.status==='cancelled', '定期票 status = cancelled');
  ok((await db.collection('installmentPlans').doc(planA).get()).data()?.status==='cancelled', '分期計畫 status = cancelled');
  const revA1 = await sumRev(passA);
  const rfA = revA1.docs.filter(d=>d.data().type==='refund');
  ok(rfA.length===1 && rfA[0].data().totalAmount===-2534, `產生 refund -2534（實得 ${rfA.map(d=>d.data().totalAmount).join(',')}）`);
  ok(revA1.net===0, `passA 營收淨額 = 0（首期 2534 已沖；實得 ${revA1.net} → ${revA1.rows.join(' ')}）`);

  // ═══ Test B: 續約分期取消 ═══
  console.log('\n─── B. 續約分期取消 ───');
  const passB = 'e2e-pass-B-'+Date.now();
  const planB = 'e2e-plan-B-'+Date.now();
  const ciB   = 'e2e-ci-B-'+Date.now();
  await db.collection('installmentPlans').doc(planB).set({
    id:planB, memberId:'member-001', memberName:'林怡君', gymId:'gym-hsinchu',
    relatedType:'pass', relatedId:passB, itemName:'半年票（續約）', status:'active', recognitionDate:null,
    installments:[
      {seq:1, amount:3040, status:'paid', paymentMethod:'cash', paidAt:now},
      {seq:2, amount:3040, status:'pending'},
      {seq:3, amount:760,  status:'pending'},
    ], createdAt:now, updatedAt:now,
  });
  const txB = await db.collection('transactions').add({
    gymId:'gym-hsinchu', type:'pass', totalAmount:3040, paymentMethod:'cash',
    memberId:'member-001', memberName:'林怡君', relatedId:passB,
    paymentStatus:'completed', recognitionDate:now, paidAt:now, createdAt:now, notes:'分期-半年票（續約）（第1/3期）',
  });
  await db.collection('memberPasses').doc(passB).set({
    id:passB, memberId:'member-001', gymId:'gym-hsinchu', passTypeName:'半年票',
    status:'active', endDate:'2027-01-12', installmentPlanId:planB, createdAt:now, updatedAt:now,
  });
  await db.collection('checkIns').doc(ciB).set({
    id:ciB, memberId:'member-001', memberName:'林怡君', gymId:'gym-hsinchu',
    entryType:'pass', passId:passB, amountPaid:0, paymentMethod:'cash',
    renewPassId:passB, renewalPlanId:planB, renewalAmount:0,
    renewMeta:{ passId:passB, plan:'installment', planId:planB, renewalPrice:6840, fullPrice:7600,
      newEndDate:'2027-01-12',
      before:{ endDate:'2026-07-12', status:'active', credits:null, originalCredits:null, installmentPlanId:null } },
    isCancelled:false, checkedInAt:now, createdAt:now,
  });
  cleanup.push(['installmentPlans',planB],['memberPasses',passB],['checkIns',ciB]);
  const revB0 = await sumRev(passB);
  console.log('  取消前 passB 營收:', revB0.rows.join(' '), '淨', revB0.net);
  const cB = await cancel(token, ciB);
  ok(cB.status===200, `cancel → 200（實得 ${cB.status} ${cB.body.message||cB.body.error||''}）`);
  ok((await db.collection('installmentPlans').doc(planB).get()).data()?.status==='cancelled', '續約分期計畫 status = cancelled');
  const passBAfter = (await db.collection('memberPasses').doc(passB).get()).data();
  ok(passBAfter?.endDate==='2026-07-12', `票期還原至 2026-07-12（實得 ${passBAfter?.endDate}）`);
  const revB1 = await sumRev(passB);
  const rfB = revB1.docs.filter(d=>d.data().type==='refund');
  ok(rfB.length===1 && rfB[0].data().totalAmount===-3040, `產生 refund -3040（實得 ${rfB.map(d=>d.data().totalAmount).join(',')}）`);
  ok(revB1.net===0, `passB 營收淨額 = 0（續約首期 3040 已沖；實得 ${revB1.net} → ${revB1.rows.join(' ')}）`);

  // 清理
  for (const [c,id] of cleanup) await db.collection(c).doc(id).delete();
  await txA.delete(); await txB.delete();
  for (const d of rfA) await d.ref.delete();
  for (const d of rfB) await d.ref.delete();
  console.log('\n🧹 已清理注入資料 + 產生的 refund');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
