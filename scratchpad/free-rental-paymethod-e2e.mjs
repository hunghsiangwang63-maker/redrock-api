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
  const M='e2e-fr-m', P='e2e-fr-pass';
  await db.collection('members').doc(M).set({id:M,name:'【練習】免費租借',phone:'0900901234',birthday:'1990-01-01',status:'active',createdAt:now});
  await db.collection('waivers').doc(M).set({memberId:M,isComplete:true,signedAt:now});
  await db.collection('fallTests').doc(`ft-${M}`).set({memberId:M,result:'passed',testedAt:now,gymId:GYM});
  await db.collection('memberPasses').doc(P).set({id:P,memberId:M,memberName:'【練習】免費租借',passTypeName:'半年票',scope:'shared',status:'active',startDate:'2026-06-01',endDate:'2026-12-01',credits:null,createdAt:now,updatedAt:now});
  // 免費入場(pass) + 加租岩鞋 + 指定 paymentMethod=transfer
  const cr=await fetch(`${API}/checkin/qr/create`,{method:'POST',headers:H(tok),body:JSON.stringify({memberId:M,gymId:GYM,entryType:'pass',passId:P,rentShoes:true,shoesPrice:100,paymentMethod:'transfer'})});
  const qr=(await cr.json()).qrToken;
  ok(!!qr, `產生免費入場+租借 QR（${qr?'ok':'fail'}）`);
  const cf=await fetch(`${API}/checkin/qr/confirm`,{method:'POST',headers:H(tok),body:JSON.stringify({qrToken:qr})});
  const cj=await cf.json();
  const ciId=cj.checkIn?.id;
  const ci=ciId?(await db.collection('checkIns').doc(ciId).get()).data():null;
  ok(ci?.paymentMethod==='transfer' && ci?.amountPaid===100, `checkIn 存 paymentMethod=transfer、amountPaid=100（實得 ${ci?.paymentMethod}/${ci?.amountPaid}）`);
  // 對應交易也帶 transfer
  const tx=await db.collection('transactions').where('relatedId','==',ciId).where('type','==','checkin').get();
  ok(tx.docs[0]?.data()?.paymentMethod==='transfer', `checkin 交易 paymentMethod=transfer（實得 ${tx.docs[0]?.data()?.paymentMethod}）`);
  // 清理
  await db.collection('checkIns').doc(ciId).delete();
  for(const d of tx.docs) await d.ref.delete();
  await db.collection('pendingCheckIns').doc(qr).delete().catch(()=>{});
  await db.collection('memberPasses').doc(P).delete();
  await db.collection('members').doc(M).delete();
  await db.collection('waivers').doc(M).delete();
  await db.collection('fallTests').doc(`ft-${M}`).delete();
  console.log('🧹 已清理');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
