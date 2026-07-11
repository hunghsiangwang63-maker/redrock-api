import admin from 'firebase-admin';
import { readFileSync } from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(readFileSync(process.env.SA,'utf8'))) });
const db = admin.firestore();
const API = 'https://redrock-api-production.up.railway.app';
let pass=0, fail=0;
const ok=(c,m)=>{ (c?pass++:fail++); console.log(`  ${c?'✅':'❌'} ${m}`); };
const login = async () => (await (await fetch(`${API}/auth/staff/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@redrock.app',password:'redrock123'})})).json()).token;
const H=(t)=>({'Content-Type':'application/json',Authorization:`Bearer ${t}`});
const now=new Date(); const EV='http://e.jpg';

(async()=>{
  const tok=await login();
  const A='e2e-tr-A', B='e2e-tr-B', C='e2e-tr-childC';
  const PH='0900966777';
  await db.collection('members').doc(A).set({id:A,name:'【練習】轉出',phone:'0900966001',status:'active',createdAt:now});
  await db.collection('members').doc(B).set({id:B,name:'【練習】接收B',phone:PH,status:'active',createdAt:now});
  await db.collection('members').doc(C).set({id:C,name:'【練習】子女C',phone:PH,parentMemberId:B,isChildAccount:true,status:'active',createdAt:now}); // 與 B 共用電話
  const mkPass=async(id)=>db.collection('memberPasses').doc(id).set({id,memberId:A,memberName:'【練習】轉出',passTypeName:'半年票',status:'active',startDate:'2026-04-01',endDate:'2026-10-01',requestUsed:false,createdAt:now,updatedAt:now});
  const PA='e2e-tr-pass', PA2='e2e-tr-pass2'; await mkPass(PA); await mkPass(PA2);
  const base={passId:PA,memberId:A,type:'transfer',reasonKey:'relocation',evidenceUrl:EV};
  const req=async(b)=>{const r=await fetch(`${API}/pass-adjustments/requests`,{method:'POST',headers:H(tok),body:JSON.stringify(b)});return{s:r.status,b:await r.json()};};
  const created=[];

  console.log('\n─── 送出即驗（防誤轉）───');
  ok((await req({...base})).b.code==='MISSING_TRANSFER_TARGET', '未選對象 → MISSING_TRANSFER_TARGET');
  ok((await req({...base,transferToMemberId:'nonexistent-xyz'})).b.code==='TARGET_MEMBER_NOT_FOUND', '非會員 id → TARGET_MEMBER_NOT_FOUND');
  ok((await req({...base,transferToMemberId:A})).b.code==='CANNOT_TRANSFER_SELF', '轉給自己 → CANNOT_TRANSFER_SELF');

  console.log('\n─── 正常轉讓給 B + 核准 ───');
  const r1=await req({...base,transferToMemberId:B,transferToPhone:PH});
  created.push(r1.b.request?.id);
  ok(r1.s===201 && r1.b.request?.transferToName==='【練習】接收B' && r1.b.request?.transferToMemberId===B, `建立201、存接收人姓名/ID（實得 name=${r1.b.request?.transferToName}）`);
  const ap=await fetch(`${API}/pass-adjustments/requests/${r1.b.request.id}/approve`,{method:'POST',headers:H(tok),body:JSON.stringify({})});
  ok(ap.status===200, `核准 200`);
  const paAfter=(await db.collection('memberPasses').doc(PA).get()).data();
  ok(paAfter.memberId===B && paAfter.requestUsed===true, `票 memberId→B、requestUsed=true（實得 ${paAfter.memberId}）`);

  console.log('\n─── 轉讓給「共用電話的子女C」（選子會員）───');
  const r2=await req({passId:PA2,memberId:A,type:'transfer',reasonKey:'relocation',evidenceUrl:EV,transferToMemberId:C,transferToPhone:PH});
  created.push(r2.b.request?.id);
  ok(r2.s===201 && r2.b.request?.transferToMemberId===C, `可指定子女C（實得 id=${r2.b.request?.transferToMemberId}, name=${r2.b.request?.transferToName}）`);
  const ap2=await fetch(`${API}/pass-adjustments/requests/${r2.b.request.id}/approve`,{method:'POST',headers:H(tok),body:JSON.stringify({})});
  const pa2After=(await db.collection('memberPasses').doc(PA2).get()).data();
  ok(ap2.status===200 && pa2After.memberId===C, `核准後票轉給子女C（非家長B；實得 ${pa2After.memberId}）`);

  // 清理
  const reqs=await db.collection('passRequests').where('memberId','==',A).get(); for(const d of reqs.docs) await d.ref.delete();
  for(const id of [PA,PA2]) await db.collection('memberPasses').doc(id).delete();
  for(const id of [A,B,C]) await db.collection('members').doc(id).delete();
  console.log('🧹 已清理');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
