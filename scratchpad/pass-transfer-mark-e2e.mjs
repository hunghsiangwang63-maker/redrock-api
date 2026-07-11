import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import dayjs from 'dayjs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;
const H=(t)=>({'Content-Type':'application/json',Authorization:`Bearer ${t}`});
const now=new Date();
(async()=>{
  const tok=await login();
  const A='e2e-tm-A', B='e2e-tm-B', P='e2e-tm-p';
  await db.collection('members').doc(A).set({id:A,name:'【練習】轉出阿明',phone:'0900988001',status:'active',createdAt:now});
  await db.collection('members').doc(B).set({id:B,name:'【練習】接收阿華',phone:'0900988002',birthday:'1990-01-01',status:'active',createdAt:now});
  await db.collection('memberPasses').doc(P).set({id:P,memberId:A,memberName:'【練習】轉出阿明',passTypeName:'半年票',status:'active',startDate:'2026-04-01',endDate:'2026-10-01',requestUsed:false,createdAt:now,updatedAt:now});
  const r=await (await fetch(`${API}/pass-adjustments/requests`,{method:'POST',headers:H(tok),body:JSON.stringify({passId:P,memberId:A,type:'transfer',reasonKey:'relocation',evidenceUrl:'http://e.jpg',transferToMemberId:B,transferToPhone:'0900988002'})})).json();
  const ap=await fetch(`${API}/pass-adjustments/requests/${r.request.id}/approve`,{method:'POST',headers:H(tok),body:JSON.stringify({})});
  ok(ap.status===200, `核准 200`);
  const pa=(await db.collection('memberPasses').doc(P).get()).data();
  const today=dayjs().format('YYYY-MM-DD');
  console.log('  轉入註記欄位:', JSON.stringify({memberId:pa.memberId,transferredFrom:pa.transferredFrom,transferredFromName:pa.transferredFromName,transferredAt:pa.transferredAt}));
  ok(pa.memberId===B, `票已轉給 B（實得 ${pa.memberId}）`);
  ok(pa.transferredFrom===A, `transferredFrom=A`);
  ok(pa.transferredFromName==='【練習】轉出阿明', `transferredFromName=原持有人姓名（實得 ${pa.transferredFromName}）`);
  ok(pa.transferredAt===today, `transferredAt=今天（實得 ${pa.transferredAt}）`);
  // 轉出紀錄資料源：A 的已核准 transfer 申請含 transferToName
  const reqDoc=(await db.collection('passRequests').doc(r.request.id).get()).data();
  ok(reqDoc.status==='approved' && reqDoc.transferToName==='【練習】接收阿華', `轉出紀錄源：申請 approved + transferToName（實得 ${reqDoc.transferToName}）`);
  // 清理
  await db.collection('passRequests').doc(r.request.id).delete();
  await db.collection('memberPasses').doc(P).delete();
  for(const id of [A,B]) await db.collection('members').doc(id).delete();
  console.log('🧹 已清理');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
