import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
const GYM='gym-e2e-test';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;
const H=(t)=>({'Content-Type':'application/json',Authorization:`Bearer ${t}`});
const daily=async(tok)=>{const r=(await (await fetch(`${API}/revenue/daily?gymId=${GYM}&days=1`,{headers:H(tok)})).json()).daily||[];return r[0]||{byType:{}};};
const now=new Date();
(async()=>{
  const tok=await login();
  const CI='e2e-rf-ci';
  // 付費入場 + 岩鞋100 + 粉袋50（entryFee 300、amountPaid 450）
  await db.collection('checkIns').doc(CI).set({ id:CI, memberId:'member-001', memberName:'林怡君', gymId:GYM, entryType:'single_ticket', entryFee:300, shoesPrice:100, chalkPrice:50, amountPaid:450, isCancelled:false, checkedInAt:now, createdAt:now });
  const txRef=await db.collection('transactions').add({ gymId:GYM, type:'checkin', totalAmount:450, entryFee:300, shoesPrice:100, memberId:'member-001', relatedId:CI, paymentStatus:'completed', recognitionDate:now, paidAt:now, createdAt:now });

  console.log('\n─── 取消前 ───');
  const d0=await daily(tok);
  ok(d0.byType?.checkin===300 && d0.byType?.rental===150, `入場300/租借150（實得 ${d0.byType?.checkin}/${d0.byType?.rental}）`);

  console.log('\n─── 取消（產生帶明細的 refund）───');
  const cr=await fetch(`${API}/checkin/cancel`,{method:'POST',headers:H(tok),body:JSON.stringify({checkInId:CI,force:true})});
  ok(cr.status===200, `cancel 200（${cr.status}）`);
  const rf=await db.collection('transactions').where('relatedId','==',CI).where('type','==','refund').get();
  const rd=rf.docs[0]?.data();
  ok(rd?.entryFee===-300 && rd?.shoesPrice===-150 && rd?.totalAmount===-450, `refund 帶 entryFee-300/shoes-150/total-450（實得 ${rd?.entryFee}/${rd?.shoesPrice}/${rd?.totalAmount}）`);

  console.log('\n─── 取消後（entry/rental 對稱歸零）───');
  const d1=await daily(tok);
  ok((d1.byType?.checkin||0)===0 && (d1.byType?.rental||0)===0, `入場0/租借0（實得 ${d1.byType?.checkin||0}/${d1.byType?.rental||0}）`);
  ok((d1.total||0)===0, `合計0（實得 ${d1.total||0}）`);

  // 清理
  await db.collection('checkIns').doc(CI).delete();
  await txRef.delete();
  for(const d of rf.docs) await d.ref.delete();
  console.log('🧹 已清理');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
