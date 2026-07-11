import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
const GYM = 'gym-hsinchu';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;
const H = (tok) => ({ 'Content-Type':'application/json', Authorization:`Bearer ${tok}` });
const now = new Date();

(async()=>{
  const tok = await login();
  const A = 'e2e-pvc-A';
  await db.collection('members').doc(A).set({ id:A, name:'【練習】特約設定A', phone:'0900922001', birthday:'1990-01-01', gymId:GYM, status:'active', registeredBy:'staff', emailVerified:true, createdAt:now, updatedAt:now });
  await db.collection('waivers').doc(A).set({ memberId:A, isComplete:true, signedAt:now });
  await db.collection('fallTests').doc(`ft-${A}`).set({ memberId:A, result:'passed', testedAt:now, gymId:GYM });
  const pvRef = db.collection('systemSettings').doc('partnerVendor');
  const orig = (await pvRef.get()).data() || null;
  const cleanup = [];
  const createPend = async (opts) => {
    const r = await fetch(`${API}/checkin/qr/create`,{method:'POST',headers:H(tok),body:JSON.stringify({memberId:A,gymId:GYM,entryType:'single_ticket',paymentMethod:'cash',...opts})});
    const j = await r.json(); if(j.qrToken) cleanup.push(j.qrToken);
    return j.qrToken ? (await db.collection('pendingCheckIns').doc(j.qrToken).get()).data() : { err:j };
  };
  const getPV = async () => (await (await fetch(`${API}/settings/partner-vendor`,{headers:H(tok)})).json());
  const putPV = async (body) => { const r=await fetch(`${API}/settings/partner-vendor`,{method:'PUT',headers:H(tok),body:JSON.stringify(body)}); return {status:r.status, body:await r.json()}; };
  const verify = async () => (await (await fetch(`${API}/checkin/verify`,{method:'POST',headers:H(tok),body:JSON.stringify({identifier:'0900922001',gymId:GYM})})).json());

  console.log('\n─── 設定端點 ───');
  const g0 = await getPV();
  ok(typeof g0.discount==='number' && typeof g0.enabled==='boolean', `GET 回 {enabled,discount}（${JSON.stringify(g0)}）`);

  console.log('\n─── 改金額 30 → 入場 300→270 ───');
  const p30 = await putPV({ enabled:true, discount:30 });
  ok(p30.status===200 && p30.body.discount===30 && p30.body.enabled===true, `PUT discount=30 enabled=true（${JSON.stringify(p30.body)}）`);
  const pend30 = await createPend({ partnerVendor:true });
  ok(pend30.amount===270 && pend30.partnerVendor===true, `single_ticket 特約 → 270（−30）/pv:true（實得 ${pend30.amount}/${pend30.partnerVendor}）`);
  const v30 = await verify();
  const opt30 = (v30.entryTypeOptions||[]).find(o=>o.type==='single_ticket');
  ok(v30.partnerVendorDiscount===30 && opt30?.partnerVendorEligible===true, `verify discount=30 & eligible=true（${v30.partnerVendorDiscount}/${opt30?.partnerVendorEligible}）`);

  console.log('\n─── 停用 → 不套（300）、eligible=false ───');
  const pOff = await putPV({ enabled:false, discount:30 });
  ok(pOff.status===200 && pOff.body.enabled===false, `PUT enabled=false（${JSON.stringify(pOff.body)}）`);
  const pendOff = await createPend({ partnerVendor:true });
  ok(pendOff.amount===300 && pendOff.partnerVendor===false, `停用時特約 → 300 不套/pv:false（實得 ${pendOff.amount}/${pendOff.partnerVendor}）`);
  const vOff = await verify();
  const optOff = (vOff.entryTypeOptions||[]).find(o=>o.type==='single_ticket');
  ok(optOff?.partnerVendorEligible===false, `verify 停用時 eligible=false（實得 ${optOff?.partnerVendorEligible}）`);

  console.log('\n─── 驗證 ───');
  const bad1 = await putPV({ enabled:true, discount:2000 });
  ok(bad1.status===400, `discount=2000 → 400（實得 ${bad1.status}）`);
  const bad2 = await putPV({ enabled:true, discount:-5 });
  ok(bad2.status===400, `discount=-5 → 400（實得 ${bad2.status}）`);

  // 還原
  if (orig) await pvRef.set(orig); else await pvRef.delete();
  for (const q of cleanup) await db.collection('pendingCheckIns').doc(q).delete().catch(()=>{});
  await db.collection('members').doc(A).delete();
  await db.collection('waivers').doc(A).delete();
  await db.collection('fallTests').doc(`ft-${A}`).delete();
  console.log('🧹 已清理練習資料、還原 partnerVendor 設定為', orig?JSON.stringify(orig):'(原本不存在→刪除)');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
