import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import dayjs from 'dayjs';
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
  const M='e2e-up-m', P='e2e-up-pass';
  await db.collection('members').doc(M).set({id:M,name:'【練習】用票',phone:'0900999001',birthday:'1990-01-01',status:'active',createdAt:now});
  await db.collection('waivers').doc(M).set({memberId:M,isComplete:true,signedAt:now});
  await db.collection('fallTests').doc(`ft-${M}`).set({memberId:M,result:'passed',testedAt:now,gymId:GYM});
  await db.collection('memberPasses').doc(P).set({id:P,memberId:M,memberName:'【練習】用票',passTypeName:'半年票',scope:'shared',status:'active',startDate:'2026-06-01',endDate:'2026-12-01',credits:null,createdAt:now,updatedAt:now});
  // 產生「使用定期票」入場 QR
  const cr=await fetch(`${API}/checkin/qr/create`,{method:'POST',headers:H(tok),body:JSON.stringify({memberId:M,gymId:GYM,entryType:'pass',passId:P})});
  const cj=await cr.json();
  ok(!!cj.qrToken, `產生 pass 入場 QR（${cj.qrToken?'ok':JSON.stringify(cj)}）`);
  const s=await (await fetch(`${API}/checkin/qr/scan`,{method:'POST',headers:H(tok),body:JSON.stringify({qrToken:cj.qrToken})})).json();
  ok(s.entryType==='pass', `entryType=pass（實得 ${s.entryType}）`);
  ok(s.usePass?.passTypeName==='半年票', `usePass.passTypeName=半年票（實得 ${s.usePass?.passTypeName}）`);
  // 清理
  await db.collection('pendingCheckIns').doc(cj.qrToken).delete().catch(()=>{});
  await db.collection('memberPasses').doc(P).delete();
  await db.collection('members').doc(M).delete();
  await db.collection('waivers').doc(M).delete();
  await db.collection('fallTests').doc(`ft-${M}`).delete();
  console.log('🧹 已清理');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
