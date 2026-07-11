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
const setupMember = async (id, name, phone, extra={}) => {
  await db.collection('members').doc(id).set({ id, name, phone, birthday:'1990-01-01', gymId:GYM, status:'active', registeredBy:'staff', emailVerified:true, createdAt:now, updatedAt:now, ...extra });
  await db.collection('waivers').doc(id).set({ memberId:id, isComplete:true, signedAt:now });
  await db.collection('fallTests').doc(`ft-${id}`).set({ memberId:id, result:'passed', testedAt:now, gymId:GYM });
};
const createPending = async (tok, memberId, entryType, opts={}) => {
  const r = await fetch(`${API}/checkin/qr/create`, { method:'POST', headers:H(tok), body:JSON.stringify({ memberId, gymId:GYM, entryType, paymentMethod:'cash', ...opts }) });
  const j = await r.json();
  if (!j.qrToken) return { err:j, status:r.status };
  const pend = (await db.collection('pendingCheckIns').doc(j.qrToken).get()).data();
  return { qrToken:j.qrToken, pend };
};

(async()=>{
  const tok = await login();
  const A = 'e2e-pv-A', B = 'e2e-pv-B';
  await setupMember(A, '【練習】特約A', '0900911001');
  await setupMember(B, '【練習】特約隊員B', '0900911002', { isTeamMember:true, teamMemberSince:'2026-01-01', teamMemberUntil:'2026-12-31' });
  // 讀原轉換期設定（測後還原）
  const tsRef = db.collection('systemSettings').doc('transitionSettings');
  const tsOrig = (await tsRef.get()).data() || {};
  const cleanup = [];

  console.log('\n─── 定價（讀 pending）───');
  // 1 成人特約 300→280
  const r1 = await createPending(tok, A, 'single_ticket', { partnerVendor:true });
  cleanup.push(r1.qrToken);
  ok(r1.pend?.amount===280 && r1.pend?.partnerVendor===true && r1.pend?.isTeamDiscount===false && r1.pend?.legacyDiscount===false,
    `成人特約 → 280/partnerVendor:true（原價 ${r1.pend?.originalAmount}, 實得 amount=${r1.pend?.amount} pv=${r1.pend?.partnerVendor}）`);
  // 2 學生特約 250→230
  const r2 = await createPending(tok, A, 'student_free', { partnerVendor:true });
  cleanup.push(r2.qrToken);
  ok(r2.pend?.amount===230 && r2.pend?.partnerVendor===true, `學生特約 → 230/pv:true（實得 ${r2.pend?.amount}/${r2.pend?.partnerVendor}）`);
  // 3 兒童特約 → 150 不套
  const r3 = await createPending(tok, A, 'child_free', { partnerVendor:true });
  cleanup.push(r3.qrToken);
  ok(r3.pend?.amount===150 && r3.pend?.partnerVendor===false, `兒童帶特約 → 150/pv:false（實得 ${r3.pend?.amount}/${r3.pend?.partnerVendor}）`);
  // 4 成人不勾 → 300/pv false
  const r4 = await createPending(tok, A, 'single_ticket', {});
  cleanup.push(r4.qrToken);
  ok(r4.pend?.amount===300 && r4.pend?.partnerVendor===false, `成人不勾 → 300/pv:false（實得 ${r4.pend?.amount}/${r4.pend?.partnerVendor}）`);
  // 5 隊員帶特約 → 270(9折)/pv false
  const r5 = await createPending(tok, B, 'single_ticket', { partnerVendor:true });
  cleanup.push(r5.qrToken);
  ok(r5.pend?.amount===270 && r5.pend?.partnerVendor===false && r5.pend?.isTeamDiscount===true, `隊員帶特約 → 270/pv:false/team:true（實得 ${r5.pend?.amount}/pv${r5.pend?.partnerVendor}/team${r5.pend?.isTeamDiscount}）`);
  // 6 舊折扣卡開啟 + 特約 → 240(8折)/pv false
  await tsRef.set({ ...tsOrig, checkinLegacyDiscountCard:true }, { merge:true });
  const r6 = await createPending(tok, A, 'single_ticket', { legacyDiscountCard:true, partnerVendor:true });
  cleanup.push(r6.qrToken);
  ok(r6.pend?.amount===240 && r6.pend?.partnerVendor===false && r6.pend?.legacyDiscount===true, `舊折扣卡+特約 → 240/pv:false/legacy:true（實得 ${r6.pend?.amount}/pv${r6.pend?.partnerVendor}/legacy${r6.pend?.legacyDiscount}）`);
  await tsRef.set(tsOrig); // 還原

  console.log('\n─── scan 預覽 ───');
  const s1 = await (await fetch(`${API}/checkin/qr/scan`, { method:'POST', headers:H(tok), body:JSON.stringify({ qrToken:r1.qrToken }) })).json();
  ok(s1.partnerVendor===true && s1.amount===280, `scan 有特約 → partnerVendor:true amount 280（實得 ${s1.partnerVendor}/${s1.amount}）`);
  const s4 = await (await fetch(`${API}/checkin/qr/scan`, { method:'POST', headers:H(tok), body:JSON.stringify({ qrToken:r4.qrToken }) })).json();
  ok(s4.partnerVendor===false, `scan 無特約 → partnerVendor:false（實得 ${s4.partnerVendor}）`);

  console.log('\n─── verify（eligible 旗標）───');
  const vA = await (await fetch(`${API}/checkin/verify`, { method:'POST', headers:H(tok), body:JSON.stringify({ identifier:'0900911001', gymId:GYM }) })).json();
  const optSingle = (vA.entryTypeOptions||[]).find(o=>o.type==='single_ticket');
  ok(vA.partnerVendorDiscount===20, `verify 頂層 partnerVendorDiscount:20（實得 ${vA.partnerVendorDiscount}）`);
  ok(optSingle?.partnerVendorEligible===true, `verify 成人選項 partnerVendorEligible:true（實得 ${optSingle?.partnerVendorEligible}, freeEntry=${vA.freeEntry}）`);
  const vB = await (await fetch(`${API}/checkin/verify`, { method:'POST', headers:H(tok), body:JSON.stringify({ identifier:'0900911002', gymId:GYM }) })).json();
  const optB = (vB.entryTypeOptions||[]).find(o=>o.type==='single_ticket');
  ok(optB?.partnerVendorEligible===false, `verify 隊員成人選項 partnerVendorEligible:false（實得 ${optB?.partnerVendorEligible}）`);

  console.log('\n─── confirm（amountPaid）───');
  const cf = await fetch(`${API}/checkin/qr/confirm`, { method:'POST', headers:H(tok), body:JSON.stringify({ qrToken:r1.qrToken }) });
  const cfj = await cf.json();
  const ciId = cfj.checkIn?.id || cfj.checkInId;
  const ci = ciId ? (await db.collection('checkIns').doc(ciId).get()).data() : null;
  ok(ci?.amountPaid===280 && ci?.partnerVendor===true, `confirm → amountPaid 280/partnerVendor:true（實得 ${ci?.amountPaid}/${ci?.partnerVendor}）`);

  // ── 清理 ──
  for (const q of cleanup.filter(Boolean)) await db.collection('pendingCheckIns').doc(q).delete().catch(()=>{});
  if (ciId) await db.collection('checkIns').doc(ciId).delete().catch(()=>{});
  // confirm 產生的營收交易 + 之後不 cancel（直接刪 checkIn 與交易）
  const txs = await db.collection('transactions').where('relatedId','==',ciId).get().catch(()=>({docs:[]}));
  for (const d of txs.docs) await d.ref.delete();
  await db.collection('members').doc(A).delete(); await db.collection('members').doc(B).delete();
  await db.collection('waivers').doc(A).delete(); await db.collection('waivers').doc(B).delete();
  await db.collection('fallTests').doc(`ft-${A}`).delete(); await db.collection('fallTests').doc(`ft-${B}`).delete();
  await tsRef.set(tsOrig); // 再次確保還原
  console.log('🧹 已清理練習會員/pending/checkIn/交易，轉換期設定還原');

  console.log(`\n=== ${pass}/${pass+fail} 通過 ===`);
  process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
