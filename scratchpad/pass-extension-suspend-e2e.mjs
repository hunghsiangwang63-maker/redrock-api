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
const EV='https://example.com/e2e-evidence.jpg';
const ORIG_END='2026-10-01';

const mkPass = async (id, memberId) => {
  await db.collection('memberPasses').doc(id).set({ id, memberId, memberName:'【練習】展延', passTypeName:'半年票', status:'active', startDate:'2026-04-01', endDate:ORIG_END, requestUsed:false, createdAt:now, updatedAt:now });
};
const req = async (tok, body) => { const r=await fetch(`${API}/pass-adjustments/requests`,{method:'POST',headers:H(tok),body:JSON.stringify(body)}); return {status:r.status, body:await r.json()}; };

(async()=>{
  const tok=await login();
  const M='e2e-ext-member';
  await db.collection('members').doc(M).set({ id:M, name:'【練習】展延', phone:'0900933001', status:'active', createdAt:now });
  const P='e2e-ext-pass', P2='e2e-ext-pass2';
  await mkPass(P, M);
  const base={ passId:P, memberId:M, type:'extension', reasonKey:'abroad', evidenceUrl:EV };
  const today=dayjs().format('YYYY-MM-DD');
  const created=[];

  console.log('\n─── 驗證擋錯 ───');
  ok((await req(tok,{...base})).body.code==='MISSING_SUSPEND_PERIOD', '缺停用期間 → MISSING_SUSPEND_PERIOD');
  const y=dayjs().subtract(1,'day').format('YYYY-MM-DD');
  ok((await req(tok,{...base,suspendStart:y,suspendEnd:dayjs().add(10,'day').format('YYYY-MM-DD')})).body.code==='SUSPEND_START_TOO_EARLY', '開始日早於今天 → SUSPEND_START_TOO_EARLY');
  const s0=dayjs().add(5,'day').format('YYYY-MM-DD');
  ok((await req(tok,{...base,suspendStart:s0,suspendEnd:s0})).body.code==='INVALID_SUSPEND_PERIOD', '結束≤開始 → INVALID_SUSPEND_PERIOD');
  // 超 6 個月：停用 200 天 → newEnd = 10-01+200 = 2027-04-19 > 10-01+6月(2027-04-01)
  ok((await req(tok,{...base,suspendStart:s0,suspendEnd:dayjs(s0).add(200,'day').format('YYYY-MM-DD')})).body.code==='EXTENSION_EXCEEDS_LIMIT', '超過6個月 → EXTENSION_EXCEEDS_LIMIT');

  console.log('\n─── 正常申請 + 核准 ───');
  const sStart=s0, sEnd=dayjs(s0).add(45,'day').format('YYYY-MM-DD'); // 45 天
  const r5=await req(tok,{...base,suspendStart:sStart,suspendEnd:sEnd});
  ok(r5.status===201 && r5.body.request?.extensionDays===45, `建立申請 201、extensionDays=45（實得 ${r5.body.request?.extensionDays}）`);
  const reqId=r5.body.request?.id;
  const expectedEnd=dayjs(ORIG_END).add(45,'day').format('YYYY-MM-DD');
  const ap=await fetch(`${API}/pass-adjustments/requests/${reqId}/approve`,{method:'POST',headers:H(tok),body:JSON.stringify({})});
  const apj=await ap.json();
  ok(ap.status===200, `核准 200（${ap.status}）`);
  const passAfter=(await db.collection('memberPasses').doc(P).get()).data();
  ok(passAfter.endDate===expectedEnd, `票期順延 ${ORIG_END} → ${expectedEnd}（實得 ${passAfter.endDate}）`);
  ok(passAfter.requestUsed===true, '核准後 requestUsed=true');
  // 已用過 → 再申請擋
  ok((await req(tok,{...base,suspendStart:sStart,suspendEnd:sEnd})).body.code==='REQUEST_ALREADY_USED', '已用過額度 → REQUEST_ALREADY_USED');

  console.log('\n─── 拒絕不佔額度（可重申請）───');
  await mkPass(P2, M);
  const base2={...base, passId:P2};
  const rr=await req(tok,{...base2,suspendStart:sStart,suspendEnd:sEnd});
  ok(rr.status===201, `pass2 建立申請 201`);
  const rj=await fetch(`${API}/pass-adjustments/requests/${rr.body.request.id}/reject`,{method:'POST',headers:H(tok),body:JSON.stringify({rejectReason:'證明不符'})});
  ok(rj.status===200, `拒絕 200`);
  const p2After=(await db.collection('memberPasses').doc(P2).get()).data();
  ok(p2After.requestUsed!==true, `拒絕後 requestUsed 仍非 true（實得 ${p2After.requestUsed}）`);
  const rAgain=await req(tok,{...base2,suspendStart:sStart,suspendEnd:sEnd});
  ok(rAgain.status===201, `拒絕後可再次申請 201（實得 ${rAgain.status} ${rAgain.body.code||''}）`);

  // 清理
  const reqs=await db.collection('passRequests').where('memberId','==',M).get();
  for(const d of reqs.docs) await d.ref.delete();
  await db.collection('memberPasses').doc(P).delete();
  await db.collection('memberPasses').doc(P2).delete();
  await db.collection('members').doc(M).delete();
  console.log('🧹 已清理練習會員/票/申請');
  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
