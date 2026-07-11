import admin from 'firebase-admin';
import { readFileSync } from 'fs';
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
  const A='e2e-trc-A', B='e2e-trc-B', C='e2e-trc-child';
  const PH='0900977888';
  await db.collection('members').doc(A).set({id:A,name:'【練習】轉出A',phone:'0900977001',status:'active',createdAt:now});
  await db.collection('members').doc(B).set({id:B,name:'【練習】家長B',phone:PH,birthday:'1990-01-01',status:'active',createdAt:now});
  await db.collection('members').doc(C).set({id:C,name:'【練習】子女C',phone:PH,birthday:'2020-01-01',parentMemberId:B,isChildAccount:true,status:'active',createdAt:now}); // ~6歲
  const mkPass=async(id)=>db.collection('memberPasses').doc(id).set({id,memberId:A,memberName:'【練習】轉出A',passTypeName:'半年票',status:'active',startDate:'2026-04-01',endDate:'2026-10-01',requestUsed:false,createdAt:now,updatedAt:now});
  const PA='e2e-trc-p1', PB='e2e-trc-p2'; await mkPass(PA); await mkPass(PB);
  const req=async(b)=>{const r=await fetch(`${API}/pass-adjustments/requests`,{method:'POST',headers:H(tok),body:JSON.stringify(b)});return{s:r.status,b:await r.json()};};
  const created=[];

  console.log('\n─── 未滿13歲不可接收 ───');
  const rC=await req({passId:PA,memberId:A,type:'transfer',reasonKey:'relocation',evidenceUrl:'http://e.jpg',transferToMemberId:C,transferToPhone:PH});
  ok(rC.b.code==='CHILD_NOT_ALLOWED', `轉給6歲子女C → CHILD_NOT_ALLOWED（實得 ${rC.b.code}）`);

  console.log('\n─── ≥13歲(家長B) 正常 ───');
  const rB=await req({passId:PB,memberId:A,type:'transfer',reasonKey:'relocation',evidenceUrl:'http://e.jpg',transferToMemberId:B,transferToPhone:PH});
  if(rB.b.request?.id) created.push(rB.b.request.id);
  ok(rB.s===201, `轉給成人家長B → 201（實得 ${rB.s} ${rB.b.code||''}）`);

  console.log('\n─── recipients 端點 under13 旗標 ───');
  const rc=await (await fetch(`${API}/ticket-transfers/recipients?phone=${PH}`,{headers:H(tok)})).json();
  const cRec=(rc.recipients||[]).find(r=>r.id===C), bRec=(rc.recipients||[]).find(r=>r.id===B);
  ok(cRec?.under13===true, `子女C under13=true（實得 ${cRec?.under13}）`);
  ok(bRec?.under13===false, `家長B under13=false（實得 ${bRec?.under13}）`);

  // 清理
  const reqs=await db.collection('passRequests').where('memberId','==',A).get(); for(const d of reqs.docs) await d.ref.delete();
  for(const id of [PA,PB]) await db.collection('memberPasses').doc(id).delete();
  for(const id of [A,B,C]) await db.collection('members').doc(id).delete();
  console.log('🧹 已清理');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
