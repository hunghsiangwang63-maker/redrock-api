import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
const GYM='gym-hsinchu';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;
const H=(t)=>({'Content-Type':'application/json',Authorization:`Bearer ${t}`});
const now=new Date();

(async()=>{
  const tok=await login();
  const M='e2e-bp-member', PT='e2e-bp-passtype';
  await db.collection('members').doc(M).set({ id:M, name:'【練習】買票', phone:'0900944001', birthday:'1990-01-01', status:'active', createdAt:now });
  await db.collection('waivers').doc(M).set({ memberId:M, isComplete:true, signedAt:now });
  await db.collection('fallTests').doc(`ft-${M}`).set({ memberId:M, result:'passed', testedAt:now, gymId:GYM });
  await db.collection('passTypes').doc(PT).set({ id:PT, name:'【練習】半年票', price:7600, scope:'shared', isActive:true, active:true, durationMonths:6,
    installment:{ enabled:true, periods:[{percent:40},{percent:30},{percent:30}] }, createdAt:now });
  const created=[];
  const mkPending = async (plan) => {
    const r=await fetch(`${API}/checkin/qr/create`,{method:'POST',headers:H(tok),body:JSON.stringify({ memberId:M, gymId:GYM, entryType:'buy_pass', buyPassTypeId:PT, paymentMethod:'cash', paymentPlan:plan })});
    const j=await r.json(); if(j.qrToken) created.push(j.qrToken); return j.qrToken;
  };
  const scan = async (qr) => (await (await fetch(`${API}/checkin/qr/scan`,{method:'POST',headers:H(tok),body:JSON.stringify({qrToken:qr})})).json());

  console.log('\n─── 一次付清 ───');
  const q1=await mkPending('full');
  const s1=await scan(q1);
  ok(s1.buyPass?.passTypeName==='【練習】半年票', `票種名稱（實得 ${s1.buyPass?.passTypeName}）`);
  ok(s1.buyPass?.fullPrice===7600, `全額 7600（實得 ${s1.buyPass?.fullPrice}）`);
  ok(s1.buyPass?.plan==='full', `plan=full（實得 ${s1.buyPass?.plan}）`);
  ok(s1.buyPass?.dueNow===7600, `本次應收 7600（實得 ${s1.buyPass?.dueNow}）`);
  ok(s1.totalAmount===7600, `totalAmount 7600（實得 ${s1.totalAmount}）`);

  console.log('\n─── 分期（首期 40%=3040）───');
  const q2=await mkPending('installment');
  const s2=await scan(q2);
  ok(s2.buyPass?.plan==='installment', `plan=installment（實得 ${s2.buyPass?.plan}）`);
  ok(s2.buyPass?.fullPrice===7600, `全額 7600（實得 ${s2.buyPass?.fullPrice}）`);
  ok(s2.buyPass?.dueNow===3040, `首期 3040（實得 ${s2.buyPass?.dueNow}）`);
  ok(s2.totalAmount===3040, `totalAmount 取首期 3040（非全額；實得 ${s2.totalAmount}）`);

  // 清理
  for(const q of created) await db.collection('pendingCheckIns').doc(q).delete().catch(()=>{});
  await db.collection('members').doc(M).delete();
  await db.collection('waivers').doc(M).delete();
  await db.collection('fallTests').doc(`ft-${M}`).delete();
  await db.collection('passTypes').doc(PT).delete();
  console.log('🧹 已清理');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
